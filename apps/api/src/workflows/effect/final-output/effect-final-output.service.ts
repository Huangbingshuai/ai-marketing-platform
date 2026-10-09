import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import type {
  EffectTemplateMixMaterial,
  EffectTemplateMixVariant,
  EffectTemplateMixWorkspaceData,
  FinalOutputExportProgress,
  FinalOutputRun,
  FinalOutputStatus,
  FinalOutputSnapshot,
  LocalUpdateFinalOutputRequest,
  SourceUpdateFinalOutputRequest,
  SourceUpdateFinalOutputData,
  EffectTemplateMixFrozenSourceContext,
  PackagingCheckpoint,
  PackagingSnapshot,
  StartFinalOutputRequest,
  SyncFinalOutputData,
  SyncFinalOutputRequest,
  WorkingArtifact,
} from '@ai-marketing/contracts';
import {
  EFFECT_TEMPLATE_MIX_MAX_CONTENT_SECONDS,
  effectResolvedCanvasRatio,
  effectVideoTransformSnapshot,
  effectTemplateMixContentDuration,
  effectTemplateMixPlacedContentDuration,
  effectTemplateMixSourceChanges,
  effectTemplateMixSourceUpdateSignature,
  effectTemplateBranchTips,
  FINAL_OUTPUT_RESOLUTIONS,
  packagingOverlayTimeline,
  packagingVisualVariant,
  packagingTimelineDuration,
  packagingTimelineClips,
} from '@ai-marketing/contracts';
import { PrismaService } from '../../../database/prisma.service';
import { EffectReadCacheService } from '../../../platform/cache/effect-read-cache.service';
import { WorkflowWorkingService } from '../../../platform/workflow/workflow-working.service';
import type { Prisma } from '../../../generated/prisma/client';
import {
  WorkflowWorkingRepository,
  workingArtifactInclude,
} from '../../../platform/workflow/workflow-working.repository';
import { STORAGE_PORT, type StoragePort } from '../../../platform/file/storage.port';
import { workflowStateHash } from '../../../platform/workflow/workflow-state-hash';
import { remapIds } from '../../../platform/workflow/effect-branch-clone';
import {
  EFFECT_TEMPLATE_MIX_JOB_TYPE,
  EFFECT_TEMPLATE_MIX_QUEUE,
} from '../../../platform/job/job.constants';
import { EffectTemplateMixService } from '../template-mix/effect-template-mix.service';
import {
  artifactVisitor,
  matchesVisualHash,
  packagingClips,
  packagingFacts,
  requireSlotPackaging,
  visualHash,
} from '../template-mix/effect-packaging.domain';
import { wavDuration, parseVoiceSegmentFrames, parseVoiceSpeechRanges } from '../template-mix/effect-packaging-audio';
import { withoutChangedSlots, withoutRemovedSlots, clearRemovedSourceSlots,
  assertRefreshPreservesContent, validateRefreshCheckpoint } from './effect-final-output-refresh';

const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const lease = () => new Date(Date.now() + 120_000);
const include = { items: { orderBy: { id: 'asc' as const } } };
/** Empty template signs must not invalidate an in-flight manual render. */
const outputDraftContentHash = (variant: EffectTemplateMixVariant) => {
  const clips = packagingTimelineClips(variant).filter(({ slot }) => Boolean(variant.bindings[slot.id]));
  const ids = new Set(clips.map(({ slot }) => slot.id));
  const keep = <T>(values: Record<string, T> | undefined) =>
    Object.fromEntries(Object.entries(values ?? {}).filter(([id]) => ids.has(id)));
  const transforms = Object.fromEntries(Object.entries(variant.videoTransforms ?? {}).filter(([id, t]) =>
    ids.has(id) && effectVideoTransformSnapshot(t)).map(([id, t]) => [id, effectVideoTransformSnapshot(t)]));
  return workflowStateHash({
    clips: clips.map(({ slot, start, lane }) => ({ slot, start, lane })),
    bindings: keep(variant.bindings), bindingRevisions: keep(variant.bindingRevisions),
    offsets: keep(variant.offsets),
    canvasRatio: variant.canvasRatio,
    ...(Object.keys(transforms).length ? { videoTransforms: transforms } : {}),
    detachedAudios: variant.detachedAudios ?? [], voice: variant.voice, bgm: variant.bgm,
    captions: variant.captions, subtitleStyle: variant.subtitleStyle,
    originalVolume: variant.originalVolume ?? 1, preservedTimelineEnd: variant.preservedTimelineEnd,
    intentionallyEmptySlotIds: variant.intentionallyEmptySlotIds,
  });
};
type OutputPathCatalog = {
  branches: Array<{ id: string; parentWorkflowRunId: string | null;
    forkNodeId: string | null; forkTemplateId: string | null }>;
  rows: Prisma.EffectFinalOutputRunGetPayload<{ include: typeof include }>[];
};
const NEEDS_REPACKAGING = '成片工程已变化，请返回混剪重新进行智能成片包装';
const audioIds = (cp: PackagingCheckpoint) =>
  [...Object.values(cp.voices ?? {}), ...Object.values(cp.captionVoices ?? {}),
    ...(cp.music ? [cp.music] : [])].map((a) => a.fileObjectId);
/** Only fields read by the final renderer determine whether an edited package needs export. */
const renderPackagingHash = (cp: PackagingCheckpoint) => workflowStateHash({
  voices: cp.voices ?? {},
  captionVoices: cp.captionVoices ?? {},
  music: cp.music ?? null,
  captions: cp.captions ?? [],
  captionFontSize: cp.captionFontSize ?? 16,
  captionBoxes: cp.captionBoxes ?? {},
});
/**
 * The picture layers the user stacked on top after the package was confirmed.
 *
 * They are deliberately not part of what a package freezes — adding or moving one must not restate a
 * package the user has already paid for — so the export reads them from the live draft instead and
 * folds them into the timeline it hands to the renderer, which only ever sees clips.
 */
const liveOverlays = (
  variant: PackagingSnapshot['variant'],
  materials: EffectTemplateMixMaterial[],
  artifacts: WorkingArtifact[],
): PackagingSnapshot['clips'] => {
  const slots = variant.slots.filter((slot) => slot.overlay === true);
  return slots.length
    ? packagingClips({ ...variant, slots }, materials, artifactVisitor(artifacts))
    : [];
};
/** The artifact columns needed to read frozen sources; the full row is only needed for overlays. */
type ArtifactRow = {
  id: string;
  revision: number;
  contentHash?: string | null;
  freshness: string;
  availability: string;
  artifactKey?: string;
  nodeId?: string;
  payload?: unknown;
};
/** The delivery artifact is copied with a manual branch, so it identifies output-version ancestry. */
const hasOutputVersion = (artifacts: ArtifactRow[]): boolean =>
  artifacts.some((artifact) => artifact.nodeId === 'FINAL_OUTPUT' &&
    artifact.artifactKey?.startsWith('final-delivery:'));
type OutputItemRow = { id: string; variantId: string; name: string; snapshot: unknown;
  fileObjectId?: string | null; status?: string };
/**
 * A fingerprint of the picture an export would render. Placement is part of it because dragging a
 * clip is an edit the user expects to see, even though it leaves the packaging source hash alone.
 */
const pictureHash = (clips: PackagingSnapshot['clips']) =>
  workflowStateHash(
    [...clips]
      .map((clip) => ({
        slotId: clip.slotId,
        materialId: clip.materialId,
        fileObjectId: clip.fileObjectId,
        contentHash: clip.contentHash,
        start: clip.start,
        duration: clip.duration,
        offset: clip.offset,
        lane: clip.lane,
        overlay: clip.overlay === true,
        transition: clip.transition,
        transitionDuration: clip.transitionDuration,
        transform: effectVideoTransformSnapshot(clip.transform),
      }))
      .sort((a, b) => a.start - b.start || a.lane - b.lane || a.slotId.localeCompare(b.slotId)),
  );

@Injectable()
export class EffectFinalOutputService {
  private readonly logger = new Logger(EffectFinalOutputService.name);
  private readonly deliveryRecoveryAfter = new Map<string, number>();
  constructor(
    @Inject(PrismaService) readonly db: PrismaService,
    @Inject(EffectTemplateMixService) readonly mix: EffectTemplateMixService,
    @Inject(WorkflowWorkingRepository) readonly working: WorkflowWorkingRepository,
    @Inject(STORAGE_PORT) readonly storage: StoragePort,
    @Inject(WorkflowWorkingService) readonly branches: WorkflowWorkingService,
    @Optional() @Inject(EffectReadCacheService) private readonly readCache?: EffectReadCacheService,
  ) {}

  private async packagingByVariant(
    projectId: string,
    workflowRunId: string,
    templateIds: string[],
    client: Prisma.TransactionClient = this.db,
  ): Promise<Map<string, PackagingCheckpoint>> {
    if (!templateIds.length) return new Map();
    const rows = await client.effectPackagingItem.findMany({
      where: { projectId, run: {
        workflowRunId, templateId: { in: templateIds },
      } },
      orderBy: [{ run: { createdAt: 'desc' } }, { id: 'desc' }],
      distinct: ['variantId'],
      select: { variantId: true, status: true, checkpoint: true },
    });
    return new Map(rows.filter((row) => row.status === 'COMPLETED')
      .map((row) => [row.variantId, row.checkpoint as PackagingCheckpoint]));
  }

  private enqueue(tx: Prisma.TransactionClient, projectId: string, runId: string) {
    const payload = {
      schemaVersion: 2,
      taskType: 'FINAL_OUTPUT',
      projectId,
      runId,
      requestId: randomUUID(),
    };
    return tx.jobOutbox.upsert({
      where: {
        projectId_jobType_aggregateId: {
          projectId,
          jobType: EFFECT_TEMPLATE_MIX_JOB_TYPE,
          aggregateId: runId,
        },
      },
      create: {
        projectId,
        aggregateId: runId,
        jobType: EFFECT_TEMPLATE_MIX_JOB_TYPE,
        routingKey: EFFECT_TEMPLATE_MIX_QUEUE,
        payload,
      },
      update: {
        payload,
        status: 'PENDING',
        attempts: 0,
        dispatchToken: null,
        nextAttemptAt: new Date(),
        publishedAt: null,
        lastError: null,
      },
    });
  }

  /**
   * The films a template would export right now, assembled from the package the user confirmed plus
   * the picture the draft holds. Shared by the packaging callback and the local update so both hand
   * the renderer the same shape.
   */
  private async outputPlan(
    projectId: string,
    workflowRunId: string,
    templateId: string,
    expectedRevision: number,
    sourceOperation?: EffectTemplateMixFrozenSourceContext,
    variantIds?: string[],
  ) {
    const { inputs, variants } = await this.mix.prepareValidation(
      projectId,
      workflowRunId,
      expectedRevision,
      templateId,
      // A partial pass is what lets a finished package through: the variant that was just packaged is
      // the version, and a sibling the user has not finished editing must not veto it.
      { partial: true, manualOutput: true, ...(sourceOperation ? { frozenSources: sourceOperation.materials } : {}),
        ...(variantIds ? { variantIds } : {}) },
    );
    const workspace = await this.mix.workspace(projectId, workflowRunId);
    return { inputs, variants, workspace };
  }

  /** A confirmed smart fill is already an editable picture timeline, even before packaging. */
  async upsertFromSmartFill(
    projectId: string,
    workflowRunId: string,
    templateId: string,
    onlyVariantIds?: string[],
    appendPackagingRequired = false,
  ): Promise<void> {
    const before = await this.db.workflowNodeState.findUnique({
      where: { projectId_workflowRunId_nodeId: {
        projectId, workflowRunId, nodeId: 'TEMPLATE_MIX',
      } },
      select: { revision: true },
    });
    if (!before) throw new NotFoundException('混剪草稿不存在');
    const frozen = onlyVariantIds?.length
      ? await this.mix.frozenSourcesForVariants?.(projectId, workflowRunId, templateId, onlyVariantIds) : undefined;
    const { variants: allVariants, workspace } = await this.outputPlan(
      projectId, workflowRunId, templateId, before.revision, frozen, onlyVariantIds,
    );
    const variants = onlyVariantIds ? allVariants.filter((variant) => onlyVariantIds.includes(variant.id)) : allVariants;
    if (!variants.length) return;
    await this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${projectId + ':' + workflowRunId + ':' + templateId}))`;
      await tx.$queryRaw`SELECT id FROM workflow_node_states WHERE "projectId"=${projectId}::uuid AND "workflowRunId"=${workflowRunId}::uuid AND "nodeId"='TEMPLATE_MIX' FOR UPDATE`;
      const state = await tx.workflowNodeState.findUnique({
        where: { projectId_workflowRunId_nodeId: {
          projectId, workflowRunId, nodeId: 'TEMPLATE_MIX',
        } }, select: { revision: true },
      });
      if (state?.revision !== before.revision)
        throw new ConflictException('草稿已变化，请刷新后重试');
      await tx.$queryRaw`SELECT id FROM working_artifacts WHERE "projectId"=${projectId}::uuid AND "workflowRunId"=${workflowRunId}::uuid ORDER BY id FOR UPDATE`;
      // Shared render sources and their dependency heads follow the same branch projection as
      // the mix workspace. Raw branch copies can be stale even when the consumed source is current.
      const artifacts = (await new WorkflowWorkingRepository(tx as unknown as PrismaService)
        .listArtifacts(projectId, { workflowRunId })) as unknown as WorkingArtifact[];
      if (!onlyVariantIds && hasOutputVersion(artifacts)) return;
      // A late or retried fill callback must never turn an already packaged queue back into a
      // picture-only queue. The packaging callback owns all updates once packaging has started.
      const packagingRuns = await tx.effectPackagingRun.count({
        where: { projectId, workflowRunId, templateId },
      });
      if (!onlyVariantIds && packagingRuns) return;
      if (onlyVariantIds && await tx.effectFinalOutputRun.count({ where: { projectId, workflowRunId,
        templateId, status: { in: ['QUEUED', 'RUNNING'] } } }))
        throw new ConflictException('该模板正在导出，请等待完成后继续同步新增成片');
      const pending = await tx.effectFinalOutputRun.findFirst({
        where: { projectId, workflowRunId, templateId, status: onlyVariantIds ? { in: ['PENDING_RENDER', 'COMPLETED'] } : 'PENDING_RENDER' },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], include,
      });
      const existingIds = onlyVariantIds ? new Set((await tx.effectFinalOutputItem.findMany({
        where: { projectId, run: { workflowRunId, templateId }, variantId: { in: onlyVariantIds } },
        select: { variantId: true },
      })).map((item) => item.variantId)) : new Set<string>();
      const rows = variants.filter((variant) => !existingIds.has(variant.id)).map((variant) => {
        const visual = artifacts.find((artifact) =>
          artifact.nodeId === 'TEMPLATE_MIX' &&
          artifact.artifactKey === `timeline-project:${templateId}:${variant.id}` &&
          (artifact.freshness === 'CURRENT' || (frozen &&
            workflowStateHash((artifact.payload as unknown as { variant?: EffectTemplateMixVariant }).variant) === workflowStateHash(variant))) &&
          artifact.availability === 'AVAILABLE');
        if (!visual) throw new ConflictException(`${variant.name} 的时间轴尚未确认`);
        const clips = this.liveClips(variant, workspace.materials, artifacts);
        const duration = effectTemplateMixContentDuration(variant);
        if ((!clips.length && !variant.intentionallyEmptySlotIds?.length) || duration <= 0 ||
          duration > EFFECT_TEMPLATE_MIX_MAX_CONTENT_SECONDS)
          throw new BadRequestException(`${variant.name} 的画面时长无效`);
        const dependency = {
          artifactId: visual.id, artifactKey: visual.artifactKey, nodeId: visual.nodeId,
          revision: visual.revision, contentHash: visual.contentHash ?? '',
        };
        const timeline: PackagingSnapshot = {
          narrationLayoutVersion: 'SLOT_V1',
          sourceTimelineHash: visualHash(variant),
          duration,
          variant, clips,
          ...(variant.detachedAudios?.length ? { detachedAudios: variant.detachedAudios } : {}),
          facts: [], dependencies: [dependency],
        };
        const snapshot: FinalOutputSnapshot = {
          ...(onlyVariantIds ? { appendOnly: true, appendPackagingRequired } : {}),
          timeline,
          packaging: { voices: {}, captions: [] },
          unpackaged: true,
          dependencies: [dependency],
          aspectRatio: effectResolvedCanvasRatio(variant, workspace.materials, workspace.renderAspectRatio),
          originalVolume: variant.originalVolume ?? 1,
          resolution: '720p', frameRate: 30,
        };
        return { variantId: variant.id, name: variant.name,
          status: 'PENDING_RENDER' as const, snapshot };
      });
      if (!rows.length) return;
      const requiredIds = [...new Set(rows.flatMap((row) => [
        ...row.snapshot.timeline.clips.map((clip) => clip.fileObjectId),
        ...(row.snapshot.timeline.detachedAudios ?? []).map((audio) => audio.fileObjectId),
      ]))];
      const files = await tx.fileObject.findMany({
        where: { projectId, id: { in: requiredIds }, status: 'AVAILABLE' },
        select: { id: true },
      });
      if (files.length !== requiredIds.length)
        throw new ConflictException('视频或音频源文件已失效');
      const inputHash = workflowStateHash(rows.map((row) => ({
        variantId: row.variantId, picture: pictureHash(row.snapshot.timeline.clips),
        dependency: row.snapshot.dependencies[0],
      })));
      if (pending) {
        const wanted = new Map(rows.map((row) => [row.variantId, row]));
        for (const item of pending.items) {
          if (onlyVariantIds) continue;
          const row = wanted.get(item.variantId);
          if (!row) {
            await tx.effectFinalOutputItem.delete({ where: { id: item.id } });
            continue;
          }
          wanted.delete(item.variantId);
          await tx.effectFinalOutputItem.update({ where: { id: item.id }, data: {
            name: row.name, snapshot: json(row.snapshot), status: 'PENDING_RENDER',
            progress: 0, errorMessage: null,
          } });
        }
        for (const row of wanted.values())
          await tx.effectFinalOutputItem.create({ data: {
            projectId, runId: pending.id, ...row, snapshot: json(row.snapshot),
          } });
        if (onlyVariantIds && pending.status === 'COMPLETED')
          await tx.effectFinalOutputRun.update({ where: { id: pending.id },
            data: { status: 'PENDING_RENDER', completedAt: null } });
      } else {
        const duplicate = await tx.effectFinalOutputRun.findUnique({
          where: { projectId_workflowRunId_templateId_inputHash: {
            projectId, workflowRunId, templateId, inputHash,
          } }, select: { id: true },
        });
        if (duplicate) return;
        await tx.effectFinalOutputRun.create({ data: {
          projectId, workflowRunId, templateId,
          idempotencyKey: `fill:${workflowRunId}:${templateId}:${inputHash}`,
          requestHash: inputHash, inputHash, status: 'PENDING_RENDER',
          items: { create: rows.map((row) => ({
            ...row, snapshot: json(row.snapshot),
          })) },
        } });
      }
    }, { timeout: 120_000 });
  }

  /**
   * The packaging callback: a finished package puts its films straight into the output node's queue,
   * and the mix artifacts committed here are what turn an unpublished mix child into a branch. The
   * caller swallows failures — a draft that moved on must not fail the worker's finish.
   *
   * `publish` is false for a partially packaged batch. Its films still reach the queue (the ones
   * that did package play without narration), but the child stays out of the version tree until the
   * failed films are recovered and the batch finishes whole.
   */
  async upsertFromPackaging(
    projectId: string,
    workflowRunId: string,
    templateId: string,
    options: { publish?: boolean; onlyVariantIds?: string[] } = {},
  ): Promise<void> {
    const before = await this.db.workflowNodeState.findUnique({
      where: {
        projectId_workflowRunId_nodeId: { projectId, workflowRunId, nodeId: 'TEMPLATE_MIX' },
      },
      select: { revision: true },
    });
    if (!before) throw new NotFoundException('混剪草稿不存在');
    const frozen = options.onlyVariantIds?.length
      ? await this.mix.frozenSourcesForVariants?.(projectId, workflowRunId, templateId, options.onlyVariantIds) : undefined;
    const plan = await this.outputPlan(
      projectId,
      workflowRunId,
      templateId,
      before.revision,
      frozen,
      options.onlyVariantIds,
    );
    const { workspace } = plan;
    const variants = options.onlyVariantIds ? plan.variants.filter((variant) => options.onlyVariantIds!.includes(variant.id)) : plan.variants;
    const inputs = options.onlyVariantIds ? plan.inputs.filter((input) => input.artifactKey === `mix-template:${templateId}` ||
      options.onlyVariantIds!.some((id) => input.artifactKey === `timeline-project:${templateId}:${id}`)) : plan.inputs;
    if (!variants.length) return;
    await this.db.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${projectId + ':' + workflowRunId + ':' + templateId}))`;
        await tx.$queryRaw`SELECT id FROM workflow_node_states WHERE "projectId"=${projectId}::uuid AND "workflowRunId"=${workflowRunId}::uuid AND "nodeId"='TEMPLATE_MIX' FOR UPDATE`;
        const locked = await tx.workflowNodeState.findUnique({
          where: {
            projectId_workflowRunId_nodeId: { projectId, workflowRunId, nodeId: 'TEMPLATE_MIX' },
          },
        });
        if (locked?.revision !== before.revision)
          throw new ConflictException('草稿已变化，请刷新后重试');
        // Lock confirmed sources through the commit; concurrent upstream edits cannot slip between validation and submission.
        await tx.$queryRaw`SELECT id FROM working_artifacts WHERE "projectId"=${projectId}::uuid AND "workflowRunId"=${workflowRunId}::uuid ORDER BY id FOR UPDATE`;
        const active = await tx.effectPackagingRun.count({
          where: {
            projectId,
            workflowRunId: workflowRunId,
            templateId,
            status: { in: ['QUEUED', 'RUNNING'] },
          },
        });
        if (active) throw new ConflictException('包装仍在执行，请等待全部成片成功');
        const history = await tx.effectPackagingItem.findMany({
          where: {
            projectId,
            run: { workflowRunId: workflowRunId, templateId },
            variantId: { in: variants.map((v) => v.id) },
          },
          orderBy: [{ run: { createdAt: 'desc' } }, { id: 'desc' }],
          distinct: ['variantId'],
        });
        // Overlays come from the live draft rather than the frozen snapshot, so their own artifacts
        // have to be walked here as well; the rest of the run reads provenance off the snapshot.
        const overlayArtifacts = variants.some((v) => v.slots.some((s) => s.overlay === true))
          ? ((await tx.workingArtifact.findMany({
              where: { projectId, workflowRunId: workflowRunId },
              include: workingArtifactInclude,
            })) as unknown as WorkingArtifact[])
          : [];
        const rows = variants.map((variant) => {
          const item = history.find((i) => i.variantId === variant.id);
          if (!item) throw new ConflictException(`${variant.name} 还没有包装结果；请先生成包装`);
          // A run that ended without every film succeeding must not hold the whole template hostage:
          // the user asked for these films, so a film whose packaging failed is submitted as a
          // picture-only one — no narration, captions or bed — and the failure is surfaced next to
          // it. Recovering that item and confirming once more adds its audio back as a new output.
          if (!['COMPLETED', 'FAILED', 'CANCELLED'].includes(item.status))
            throw new ConflictException(`${variant.name} 仍在包装中；请等待包装结束后提交`);
          const snapshot = item.snapshot as unknown as PackagingSnapshot;
          const packaged = item.status === 'COMPLETED';
          const checkpoint: PackagingCheckpoint = packaged
            ? (item.checkpoint as PackagingCheckpoint)
            : { voices: {}, captions: [] };
          if (packaged)
            // Accept editor-edited audio geometry; worker writes stay strictly validated.
            requireSlotPackaging(snapshot, checkpoint);
          return {
            item,
            snapshot,
            checkpoint,
            variant,
            unpackaged: !packaged,
            overlays: liveOverlays(variant, workspace.materials, overlayArtifacts),
          };
        });
        const inputHash = workflowStateHash(
          rows.map((r) => ({
            variant: visualHash(r.variant),
            checkpoint: r.checkpoint,
            dependencies: r.snapshot.dependencies,
            // Overlays stay out of the visual hash — that is what keeps a confirmed package usable.
            // Being invisible there makes them invisible above too, and an export that ignored them
            // would hand back the run it built before the overlay existed.
            overlays: packagingOverlayTimeline(r.variant),
          })),
        );
        const pending = await tx.effectFinalOutputRun.findFirst({
          where: { projectId, workflowRunId, templateId, status: options.onlyVariantIds ? { in: ['PENDING_RENDER', 'COMPLETED'] } : 'PENDING_RENDER' },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          include,
        });
        const requiredIds = [
          ...new Set(
            rows.flatMap((r) => [
              ...audioIds(r.checkpoint),
              ...r.snapshot.clips.map((c) => c.fileObjectId),
              ...r.overlays.map((c) => c.fileObjectId),
              ...(r.snapshot.detachedAudios ?? []).map((a) => a.fileObjectId),
            ]),
          ),
        ];
        const files = await tx.fileObject.findMany({
          where: {
            projectId,
            id: { in: requiredIds },
            status: 'AVAILABLE',
          },
        });
        if (files.length !== requiredIds.length)
          throw new ConflictException('包装或视频文件已失效');
        const committed = await this.working.commitValidatedArtifactsInTransaction(
          tx,
          projectId,
          workflowRunId,
          'TEMPLATE_MIX',
          inputs,
          ...(frozen ? [frozen.materials] : []),
        );
        const artifacts = await tx.workingArtifact.findMany({
          where: { projectId, workflowRunId }, include: workingArtifactInclude,
        });
        const outputRows = [];
        for (const row of rows) {
          const visual = committed.find(
            (c) => c.artifactKey === `timeline-project:${templateId}:${row.item.variantId}`,
          )!.record;
          const dependencies = [{
            artifactId: visual.id,
            artifactKey: visual.artifactKey,
            nodeId: visual.nodeId,
            revision: visual.revision,
            contentHash: visual.contentHash,
          }];
          const cp = { ...row.checkpoint };
          delete cp.musicTaskId;
          delete cp.musicSubmissionPending;
          // The film is as long as its content, so the render length follows the checkpoint's own
          // extent — audio or a caption carried past the last video clip is a black tail, not a
          // truncation. The frozen snapshot's own `duration` is video-only and is left alone. The live
          // draft is what is measured, so an overlay reaching past the last clip extends the film.
          const duration = effectTemplateMixContentDuration(row.variant, cp);
          if (duration > EFFECT_TEMPLATE_MIX_MAX_CONTENT_SECONDS)
            throw new BadRequestException('成片时长超过容量上限');
          const packageResult = await this.working.commitValidatedArtifactsInTransaction(
            tx,
            projectId,
            workflowRunId,
            'TEMPLATE_MIX',
            [
              {
                artifactKey: `timeline-package:${templateId}:${row.item.variantId}`,
                input: {
                  kind: 'STRUCTURED',
                  name: `${row.item.name} · 智能包装`,
                  directory: 'EDITING_PROJECTS',
                  type: 'TIMELINE_PROJECT',
                  payload: {
                    schemaVersion: 1,
                    templateId,
                    variantId: row.item.variantId,
                    sourceTimelineHash: visualHash(row.variant),
                    visualArtifactId: visual.id,
                    visualRevision: visual.revision,
                    duration,
                    ...cp,
                    mix: { originalVolume: 0.15, bgmVolume: cp.music?.volume ?? 0, ducking: true },
                    subtitleStyle: 'standard',
                  },
                  files: files
                    .filter((f) => audioIds(cp).includes(f.id))
                    .map((f, sortOrder) => ({
                      fileObjectId: f.id,
                      // The editor may have deleted the bed, so a voice-only mix is a normal state.
                      role: f.id === cp.music?.fileObjectId ? 'BGM' : 'VOICE',
                      sortOrder,
                      originalFileName: f.originalFileName,
                      mimeType: f.mimeType,
                      sha256: f.sha256,
                    })),
                  dependencies: dependencies.map((d) => ({
                    sourceType: 'WORKING_ARTIFACT',
                    sourceNodeId: d.nodeId,
                    sourceArtifactId: d.artifactId,
                    sourceKey: d.artifactKey,
                    sourceRevision: d.revision,
                    sourceHash: d.contentHash,
                  })),
                },
              },
            ],
          );
          const packaging = packageResult[0]!.record;
          const firstClip = row.snapshot.clips[0];
          // The renderer only ever sees clips, so the live overlays are folded in here. The frozen
          // overlays are dropped first: one the user has since deleted must not render, and one still
          // on the timeline is supplied by `row.overlays` — keeping both would draw it twice.
          const timelineClips = [
            ...row.snapshot.clips.filter((clip) => clip.overlay !== true),
            ...row.overlays,
          ].map((clip) => {
            // Rows are numbered against the live draft, and adding an overlay shifts the ones under
            // it. Keeping the frozen row numbers would place the overlay beside a clip it should
            // cover, so every row is re-read from the draft the user is looking at.
            const updated = { ...clip, lane: row.variant.videoLanes?.[clip.slotId] ?? clip.lane };
            delete updated.transform;
            const transform = row.variant.videoTransforms?.[clip.slotId];
            if (transform) updated.transform = transform;
            return updated;
          });
          const snapshot: FinalOutputSnapshot = {
            ...(options.onlyVariantIds ? { appendOnly: true } : {}),
            timeline: {
              ...row.snapshot,
              variant: row.variant,
              clips: timelineClips,
              duration,
              sourceTimelineHash: visualHash(row.variant),
            },
            packaging: cp,
            unpackaged: row.unpackaged,
            dependencies: [
              ...dependencies,
              {
                artifactId: packaging.id,
                revision: packaging.revision,
                contentHash: packaging.contentHash,
              },
            ],
            aspectRatio: effectResolvedCanvasRatio(row.variant, workspace.materials, workspace.renderAspectRatio),
            originalVolume: 0.15,
            resolution: '720p',
            frameRate: 30,
          };
          outputRows.push({
            variantId: row.item.variantId,
            name: row.item.name,
            status: 'PENDING_RENDER',
            snapshot: json(snapshot),
          });
        }
        // A delivered picture-only version keeps its existing files and batch. The newly
        // committed package makes those items stale through draftDiffersFromSnapshot; only an
        // explicit local update may queue replacement renders in this published branch.
        const delivered = await tx.workingArtifact.findFirst({ where: {
          projectId, workflowRunId, nodeId: 'FINAL_OUTPUT',
          artifactKey: `final-delivery:${templateId}`,
        }, select: { id: true } });
        if (delivered && !options.onlyVariantIds) return;
        if (pending) {
          // The films have not been exported yet, so the queue simply follows the new package:
          // refreshing in place keeps one batch per template instead of growing one per packaging run.
          const wanted = new Map(outputRows.map((row) => [row.variantId, row]));
          for (const item of pending.items) {
            if (options.onlyVariantIds && !options.onlyVariantIds.includes(item.variantId)) continue;
            if (options.onlyVariantIds && item.status === 'COMPLETED') {
              wanted.delete(item.variantId);
              continue;
            }
            const row = wanted.get(item.variantId);
            if (!row) {
              await tx.effectFinalOutputItem.delete({ where: { id: item.id } });
              continue;
            }
            wanted.delete(item.variantId);
            await tx.effectFinalOutputItem.update({
              where: { id: item.id },
              data: {
                name: row.name,
                snapshot: json(row.snapshot),
                status: 'PENDING_RENDER',
                progress: 0,
                errorMessage: null,
              },
            });
          }
          for (const row of wanted.values())
            await tx.effectFinalOutputItem.create({
              data: { projectId, runId: pending.id, ...row },
            });
          if (options.onlyVariantIds && wanted.size && pending.status === 'COMPLETED')
            await tx.effectFinalOutputRun.update({ where: { id: pending.id }, data: { status: 'PENDING_RENDER', completedAt: null } });
        } else {
          const duplicate = await tx.effectFinalOutputRun.findUnique({
            where: {
              projectId_workflowRunId_templateId_inputHash: {
                projectId,
                workflowRunId,
                templateId,
                inputHash,
              },
            },
          });
          // Identical inputs were already exported from this Run; there is no new version to queue.
          if (duplicate) return;
          await tx.effectFinalOutputRun.create({
            data: {
              projectId,
              workflowRunId,
              templateId,
              idempotencyKey: `auto:${workflowRunId}:${templateId}:${inputHash}`,
              requestHash: inputHash,
              inputHash,
              status: 'PENDING_RENDER',
              items: { create: outputRows },
            },
          });
        }
        await tx.workflowRun.updateMany({
          where: { id: workflowRunId, projectId },
          data: { currentNodeId: 'FINAL_OUTPUT' },
        });
      },
      { timeout: 120_000 },
    );
    if (options.publish ?? true) await this.publishMixBranch(projectId, workflowRunId);
  }

  /** A successful mix or output batch publishes only the child created for that node. */
  private async publishEditBranch(
    projectId: string,
    workflowRunId: string,
    nodeId: 'TEMPLATE_MIX' | 'FINAL_OUTPUT',
  ): Promise<void> {
    const run = await this.db.workflowRun.findFirst({
      where: { projectId, id: workflowRunId },
      select: {
        parentWorkflowRunId: true,
        branchPublishedAt: true,
        editSessionNodeId: true,
        forkNodeId: true,
      },
    });
    if (!run?.parentWorkflowRunId || run.branchPublishedAt) return;
    if (run.editSessionNodeId !== nodeId && run.forkNodeId !== nodeId) return;
    await this.working.publishEffectNodeEdit(projectId, workflowRunId, nodeId);
  }

  async publishMixBranch(projectId: string, workflowRunId: string): Promise<void> {
    await this.publishEditBranch(projectId, workflowRunId, 'TEMPLATE_MIX');
  }

  /** Rewrites one film from the current saved picture and audio without regenerating narration. */
  private async rewriteFilm(
    tx: Prisma.TransactionClient,
    templateId: string,
    item: OutputItemRow,
    variant: EffectTemplateMixVariant,
    workspace: Pick<EffectTemplateMixWorkspaceData, 'draft' | 'materials' | 'renderAspectRatio'>,
    artifacts: WorkingArtifact[],
    status: 'QUEUED' | 'PENDING_RENDER',
    latestPackaging?: PackagingCheckpoint,
    settings?: StartFinalOutputRequest,
    sourceRefresh?: FinalOutputSnapshot['sourceRefresh'],
  ): Promise<void> {
    const snapshot = item.snapshot as unknown as FinalOutputSnapshot;
    let clips: PackagingSnapshot['clips'];
    try {
      clips = this.liveClips(variant, workspace.materials, artifacts);
    } catch {
      throw new ConflictException(`${item.name} 的当前画面素材不可用`);
    }
    const cp = latestPackaging ? { ...latestPackaging } : { ...snapshot.packaging };
    let refreshedProvenance: Pick<PackagingSnapshot, 'facts' | 'dependencies'> | undefined;
    if (sourceRefresh) {
      const visitor = artifactVisitor(artifacts);
      for (const clip of clips.filter((clip) => sourceRefresh.slots.some((slot) => slot.slotId === clip.slotId)))
        visitor.visit(clip.materialId);
      const facts = packagingFacts(visitor.used.values());
      if (sourceRefresh.slots.length && !facts.length && !(snapshot.unpackaged && !latestPackaging))
        throw new ConflictException('新素材缺少已确认商品事实，无法重新生成口播');
      refreshedProvenance = { facts, dependencies: [...visitor.used.values()].map((source) => ({
        artifactId: source.id, artifactKey: source.artifactKey, nodeId: source.nodeId,
        revision: source.revision, contentHash: source.contentHash ?? '',
      })) };
      if (sourceRefresh.protocol === 'FROZEN_RENDER_V1') {
        const adopted = Object.values(variant.bindingSources ?? {});
        const previous = snapshot.timeline.dependencies ?? [];
        refreshedProvenance.dependencies = [
          ...refreshedProvenance.dependencies.filter((source) => source.nodeId !== 'SEGMENT_RENDER'),
          ...[...new Map(adopted.map((source) => [source.artifactId, source])).values()].map((source) => ({
            artifactId: source.artifactId, artifactKey: source.artifactKey, nodeId: 'SEGMENT_RENDER',
            revision: source.artifactRevision,
            contentHash: source.artifactContentHash ?? previous.find((dependency) =>
              dependency.artifactId === source.artifactId && dependency.revision === source.artifactRevision)?.contentHash ?? '',
          })),
          ...refreshedProvenance.dependencies.filter((source) => source.nodeId === 'SEGMENT_RENDER' &&
            !adopted.some((material) => material.artifactId === source.artifactId)),
        ];
      }
    }
    delete cp.musicTaskId;
    delete cp.musicSubmissionPending;
    const duration = snapshot.sourceDraft && !item.fileObjectId
      ? effectTemplateMixPlacedContentDuration(variant, cp) : effectTemplateMixContentDuration(variant, cp);
    if (duration > EFFECT_TEMPLATE_MIX_MAX_CONTENT_SECONDS)
      throw new ConflictException('成片时长超过容量上限');
    const dependencies = (snapshot.dependencies ?? []).map((dependency, index) => {
      const current = artifacts.find((artifact) => artifact.id === dependency.artifactId) ??
        artifacts.find((artifact) => dependency.artifactKey &&
          artifact.artifactKey === dependency.artifactKey) ??
        artifacts.find((artifact) => artifact.artifactKey.endsWith(`:${item.variantId}`) &&
          artifact.artifactKey.startsWith(index === 0 ? 'timeline-project:' : 'timeline-package:'));
      return current ? {
        ...dependency,
        artifactId: current.id,
        artifactKey: current.artifactKey,
        nodeId: current.nodeId,
        revision: current.revision,
        contentHash: current.contentHash,
      } : dependency;
    });
    const packageArtifact = latestPackaging ? artifacts.find((artifact) =>
      artifact.artifactKey === `timeline-package:${templateId}:${item.variantId}` &&
      (sourceRefresh || artifact.freshness === 'CURRENT') && artifact.availability === 'AVAILABLE') : undefined;
    if (latestPackaging && !packageArtifact)
      throw new ConflictException(`${item.name} 的包装工作副本不可用`);
    if (packageArtifact && !dependencies.some((dependency) =>
      dependency.artifactId === packageArtifact.id))
      dependencies.push({
        artifactId: packageArtifact.id,
        artifactKey: packageArtifact.artifactKey,
        nodeId: packageArtifact.nodeId,
        revision: packageArtifact.revision,
        contentHash: packageArtifact.contentHash,
      });
    await tx.effectFinalOutputItem.update({
      where: { id: item.id },
      data: {
        status,
        progress: 0,
        errorMessage: null,
        snapshot: json({
          ...snapshot,
          ...(settings ? { sourceDraft: undefined } : snapshot.sourceDraft ? { sourceDraft: { ...snapshot.sourceDraft,
            contentHash: outputDraftContentHash(variant) } } : {}),
          projectRefreshOnly: undefined,
          sourceRefresh,
          ...(settings ?? {}),
          timeline: {
            ...snapshot.timeline,
            ...refreshedProvenance,
            ...(sourceRefresh ? { narrationLayoutVersion: 'SLOT_V1' as const } : {}),
            clips,
            detachedAudios: variant.detachedAudios ?? [],
            duration,
            sourceTimelineHash: visualHash(variant),
            variant,
          },
          packaging: cp,
          unpackaged: latestPackaging ? false : snapshot.unpackaged,
          dependencies,
          originalVolume: variant.originalVolume ?? snapshot.originalVolume,
          aspectRatio: effectResolvedCanvasRatio(variant, workspace.materials, workspace.renderAspectRatio, snapshot.aspectRatio),
        }),
      },
    });
  }

  /** Saved mix drafts refresh unexported films; exported files are never silently replaced. */
  async syncFromDraft(projectId: string, workflowRunId: string,
    request: Pick<SyncFinalOutputRequest, 'templateId' | 'expectedDraftRevision'> = {},
  ): Promise<SyncFinalOutputData> {
    const result: SyncFinalOutputData = { refreshed: [] };
    if (request.expectedDraftRevision !== undefined) {
      const scopedRun = await this.db.workflowRun.findFirst({ where: {
        projectId, id: workflowRunId, workflow: 'EFFECT', workflowSpace: 'EFFECT',
      }, select: { id: true } });
      const state = await this.db.workflowNodeState.findUnique({ where: {
        projectId_workflowRunId_nodeId: { projectId, workflowRunId, nodeId: 'TEMPLATE_MIX' },
      }, select: { revision: true } });
      if (!scopedRun || state?.revision !== request.expectedDraftRevision)
        return { ...result, superseded: true };
    }
    let runs = await this.db.effectFinalOutputRun.findMany({
      where: { projectId, workflowRunId,
        ...(request.templateId ? { templateId: request.templateId } : {}) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include,
    });
    // An existing non-pending batch cannot follow drafts silently. Its read path computes stale
    // films; avoid rebuilding the full workbench merely to return an empty sync result.
    if (request.templateId && runs.length && runs.every((run) => run.status !== 'PENDING_RENDER'))
      return result;
    // The worker may have confirmed its mix timeline while the post-commit output sync hit a
    // transient error. Entering the output page repairs only confirmed timelines with no batch;
    // an existing exported run is never replaced here.
    if (request.expectedDraftRevision !== undefined) {
      const mixArtifacts = await this.working.listArtifacts(projectId, {
        workflowRunId, nodeId: 'TEMPLATE_MIX',
      });
      const confirmedTemplateIds = [...new Set(mixArtifacts
        .filter((artifact) => artifact.artifactKey.startsWith('timeline-project:') &&
          artifact.freshness === 'CURRENT' && artifact.availability === 'AVAILABLE')
        .map((artifact) => artifact.artifactKey.split(':')[1]!)
        .filter((templateId) => !request.templateId || templateId === request.templateId))];
      for (const templateId of confirmedTemplateIds) {
        if (runs.some((run) => run.templateId === templateId)) continue;
        try {
          await this.upsertFromSmartFill(projectId, workflowRunId, templateId);
        } catch (error) {
          this.logger.warn(JSON.stringify({
            event: 'effect_smart_fill_output_reconcile_failed', projectId, workflowRunId,
            templateId, error: error instanceof Error ? error.message : String(error),
          }));
        }
      }
      if (confirmedTemplateIds.some((templateId) => !runs.some((run) => run.templateId === templateId)))
        runs = await this.db.effectFinalOutputRun.findMany({
          where: { projectId, workflowRunId,
            ...(request.templateId ? { templateId: request.templateId } : {}) },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], include,
        });
    }
    if (!runs.length) return result;
    const workspace = await this.mix.workspace(projectId, workflowRunId);
    if (request.expectedDraftRevision !== undefined &&
      workspace.draftRevision !== request.expectedDraftRevision)
      return { ...result, superseded: true };
    const artifacts = (await this.working.listArtifacts(projectId, {
      workflowRunId,
    })) as unknown as WorkingArtifact[];
    // A confirmed output version belongs to the user; only an unexported queue follows edits.
    if (hasOutputVersion(artifacts)) return result;
    const packaging = await this.packagingByVariant(projectId, workflowRunId,
      [...new Set(runs.map((run) => run.templateId))]);
    for (const run of runs) {
      if (run.status !== 'PENDING_RENDER') continue;
      const moved = run.items.filter((item) =>
        this.draftDiffersFromSnapshot(run.templateId, item, artifacts, workspace,
          packaging.get(item.variantId)),
      );
      if (!moved.length) continue;
      const variants = workspace.draft?.templates.find(
        (entry) => entry.id === run.templateId,
      )?.workspace.variants;
      let refreshed = 0;
      for (const item of moved) {
        const variant = variants?.find((candidate) => candidate.id === item.variantId);
        // A variant the draft no longer holds cannot be rendered, so its queued film goes with it.
        // A template that left the draft entirely is left alone: the queue is all that is left of it.
        if (!variant) {
          if (variants) {
            const removed = await this.db.$transaction(async (tx) => {
              if (request.expectedDraftRevision !== undefined) {
                await tx.$queryRaw`SELECT id FROM workflow_node_states WHERE "projectId"=${projectId}::uuid AND "workflowRunId"=${workflowRunId}::uuid AND "nodeId"='TEMPLATE_MIX' FOR SHARE`;
                const current = await tx.workflowNodeState.findUnique({ where: {
                  projectId_workflowRunId_nodeId: { projectId, workflowRunId, nodeId: 'TEMPLATE_MIX' },
                }, select: { revision: true } });
                const scopedRun = await tx.workflowRun.findFirst({ where: { projectId,
                  id: workflowRunId, workflow: 'EFFECT', workflowSpace: 'EFFECT' }, select: { id: true } });
                if (current?.revision !== request.expectedDraftRevision || !scopedRun) return false;
              }
              const delivery = await tx.workingArtifact.findFirst({ where: { projectId,
                workflowRunId, nodeId: 'FINAL_OUTPUT', artifactKey: { startsWith: 'final-delivery:' },
              }, select: { id: true } });
              if (delivery) return false;
              await tx.effectFinalOutputItem.deleteMany({ where: { projectId, id: item.id,
                status: 'PENDING_RENDER' } });
              return true;
            }, { timeout: 30_000 });
            if (!removed) return { ...result, superseded: true };
          }
          continue;
        }
        // Source replacement needs explicit trim/packaging refresh. Ordinary draft sync must
        // preserve its baseline, not validate old binding revisions or silently adopt new media.
        if (effectTemplateMixSourceChanges(variant, workspace.materials).length) continue;
        const outcome = await this.db.$transaction(async (tx) => {
          if (request.expectedDraftRevision !== undefined) {
            await tx.$queryRaw`SELECT id FROM workflow_node_states WHERE "projectId"=${projectId}::uuid AND "workflowRunId"=${workflowRunId}::uuid AND "nodeId"='TEMPLATE_MIX' FOR SHARE`;
            const current = await tx.workflowNodeState.findUnique({ where: {
              projectId_workflowRunId_nodeId: { projectId, workflowRunId, nodeId: 'TEMPLATE_MIX' },
            }, select: { revision: true } });
            const scopedRun = await tx.workflowRun.findFirst({ where: { projectId, id: workflowRunId,
              workflow: 'EFFECT', workflowSpace: 'EFFECT' }, select: { id: true } });
            const currentItem = await tx.effectFinalOutputItem.findFirst({ where: { projectId,
              id: item.id, status: 'PENDING_RENDER' }, select: { id: true } });
            if (current?.revision !== request.expectedDraftRevision || !scopedRun || !currentItem)
              return 'SUPERSEDED' as const;
          }
          const delivery = await tx.workingArtifact.findFirst({ where: { projectId,
            workflowRunId, nodeId: 'FINAL_OUTPUT', artifactKey: { startsWith: 'final-delivery:' },
          }, select: { id: true } });
          if (delivery) return 'SUPERSEDED' as const;
          await this.rewriteFilm(tx, run.templateId, item, variant, workspace, artifacts, 'PENDING_RENDER',
            packaging.get(item.variantId));
          return 'REFRESHED' as const;
        }, { timeout: 30_000 });
        if (outcome === 'SUPERSEDED') return { ...result, superseded: true };
        refreshed += 1;
      }
      if (refreshed) result.refreshed.push({ templateId: run.templateId, itemCount: refreshed });
    }
    return result;
  }

  /**
   * Re-renders films in place after the mix draft moved on, without opening a branch: the user is
   * correcting the films of the version already delivered, not making a new version.
   */
  async localUpdate(
    projectId: string,
    id: string,
    body: LocalUpdateFinalOutputRequest,
    recoveringSourceRefresh = false,
  ): Promise<FinalOutputRun> {
    await this.db.$transaction((tx) => this.queueLocalUpdate(tx, projectId, id, body,
      recoveringSourceRefresh), { timeout: 120_000 });
    return this.get(projectId, id);
  }

  private async queueLocalUpdate(tx: Prisma.TransactionClient, projectId: string, id: string,
    body: LocalUpdateFinalOutputRequest, recoveringSourceRefresh = false,
    mixProjectOnly = false,
    frozenInputs?: { workspace: EffectTemplateMixWorkspaceData; artifacts: WorkingArtifact[] }): Promise<void> {
    await tx.$queryRaw`SELECT id FROM effect_final_output_runs WHERE id=${id}::uuid AND "projectId"=${projectId}::uuid FOR UPDATE`;
    const run = await tx.effectFinalOutputRun.findFirst({ where: { projectId, id }, include });
    if (!run) throw new NotFoundException('成片输出任务不存在');
    if (run.status === 'QUEUED' || run.status === 'RUNNING')
      throw new ConflictException('该模板正在渲染，请等待本批完成后重试');
    const projectRefreshOnly = mixProjectOnly || run.status === 'PENDING_RENDER' ||
      (['PARTIAL', 'FAILED', 'CANCELLED'].includes(run.status) &&
        run.items.some((item) => (item.snapshot as unknown as FinalOutputSnapshot).projectRefreshOnly));
    if (!projectRefreshOnly && run.status !== 'COMPLETED' && !(body.syncProjects &&
      ['PARTIAL', 'FAILED', 'CANCELLED'].includes(run.status)) && !(recoveringSourceRefresh &&
      ['PARTIAL', 'FAILED', 'CANCELLED'].includes(run.status)))
      throw new ConflictException('请先等待成片批次完成或恢复失败项');
    const tree = await this.branches.getEffectBranchTree(projectId);
    const tip = effectTemplateBranchTips(tree.branches, tree.activeWorkflowRunId, { current: true }).get(run.templateId);
    // Templates have independent current paths. The project-wide active pointer may refer to a
    // sibling template or to a hidden edit child; only the selected template's published tip is
    // relevant to an in-place local update.
    if (tip?.workflowRunId !== run.workflowRunId)
      throw new ConflictException('只能更新该模板的当前成片分支，请刷新后重试');
    await tx.$queryRaw`SELECT id FROM workflow_node_states WHERE "projectId"=${projectId}::uuid AND "workflowRunId"=${run.workflowRunId}::uuid AND "nodeId"='TEMPLATE_MIX' FOR UPDATE`;
    const workspace = frozenInputs?.workspace ?? await this.mix.workspace(projectId, run.workflowRunId);
    if (body.expectedDraftRevision !== undefined && workspace.draftRevision !== body.expectedDraftRevision)
      throw new ConflictException('成片工程已变化，请刷新后重新确认局部更新');
    const inheritedSources = frozenInputs?.artifacts ?? await this.working.listArtifacts(projectId, { workflowRunId: run.workflowRunId });
    let artifacts = [...new Map([...(await tx.workingArtifact.findMany({
      where: { projectId, workflowRunId: run.workflowRunId },
      include: workingArtifactInclude,
    })) as unknown as WorkingArtifact[], ...inheritedSources as unknown as WorkingArtifact[]]
      .map((artifact) => [artifact.id, artifact])).values()];
    if (!projectRefreshOnly && !hasOutputVersion(artifacts))
      throw new ConflictException('当前分支尚无已确认成片版本');
    const packaging = await this.packagingByVariant(projectId, run.workflowRunId,
      [run.templateId], tx);
    if (!Array.isArray(body.itemIds) || (!body.itemIds.length && !body.syncProjects))
      throw new BadRequestException('请先选择需要重新渲染的成片');
    if (body.itemIds.length !== new Set(body.itemIds).size)
      throw new BadRequestException('成片条目不能重复');
    const chosen = run.items.filter((item) => body.itemIds.includes(item.id));
    if (chosen.length !== new Set(body.itemIds).size)
      throw new NotFoundException('成片条目不存在');
    if (projectRefreshOnly && !mixProjectOnly && !recoveringSourceRefresh &&
      chosen.some((item) => item.fileObjectId || item.assetId))
      throw new ConflictException('当前批次含已导出成片，请在成片输出中局部更新');
    const variants = workspace.draft?.templates.find(
      (entry) => entry.id === run.templateId,
    )?.workspace.variants;
    if (!variants) throw new ConflictException('当前模板不存在，请刷新后重试');
    const membership = this.projectMembership(run, artifacts, workspace, packaging);
    const isRemoval = (item: OutputItemRow) => !variants.some((variant) => variant.id === item.variantId);
    const isFailedAddition = (item: OutputItemRow) => !item.fileObjectId &&
      ['FAILED', 'CANCELLED'].includes(item.status ?? '') && Boolean((item.snapshot as unknown as FinalOutputSnapshot).sourceDraft);
    if (!projectRefreshOnly && chosen.some((item) => !isRemoval(item) && !isFailedAddition(item) &&
      (!item.fileObjectId || !item.assetId)))
      throw new ConflictException('选中的成片文件不可用');
    if (!projectRefreshOnly && chosen.some((item) => !isRemoval(item) && !isFailedAddition(item) && !this.draftDiffersFromSnapshot(
      run.templateId, item, artifacts, workspace, packaging.get(item.variantId),
    ))) throw new ConflictException('选中的成片无需局部更新，请刷新后重试');
    if (projectRefreshOnly && (body.syncProjects || chosen.some((item) => {
      const variant = variants.find((variant) => variant.id === item.variantId);
      return !variant || !effectTemplateMixSourceChanges(variant, workspace.materials).length;
    }))) throw new ConflictException('选中的成片工程没有需要更新的素材');
    const added = body.syncProjects ? variants.filter((variant) =>
      membership?.added.some((entry) => entry.variantId === variant.id)) : [];
    const removed = run.items.filter((item) => !variants.some((variant) =>
      variant.id === item.variantId) && (body.syncProjects || body.itemIds.includes(item.id)));
    if (!chosen.length && !added.length && !removed.length)
      throw new ConflictException('成片工程无需局部更新，请刷新后重试');
    if (added.length) {
      const blocked = membership?.added.find((entry) => entry.blockedReason);
      if (blocked) throw new ConflictException(`${blocked.name}：${blocked.blockedReason}`);
      const prepared = await this.mix.prepareValidation(projectId, run.workflowRunId,
        workspace.draftRevision!, run.templateId, { manualOutput: true, variantIds: added.map((variant) => variant.id) });
      if (added.some((variant) => !prepared.variants.some((valid) => valid.id === variant.id &&
          workflowStateHash(valid) === workflowStateHash(variant))))
        throw new ConflictException('新增成片工程仍有素材缺口或来源无效，请先修复再局部更新');
      await this.working.commitValidatedArtifactsInTransaction(tx, projectId, run.workflowRunId,
        'TEMPLATE_MIX', prepared.inputs.filter((input) => added.some((variant) =>
          input.artifactKey === `timeline-project:${run.templateId}:${variant.id}`)));
      artifacts = (await tx.workingArtifact.findMany({ where: { projectId,
        workflowRunId: run.workflowRunId }, include: workingArtifactInclude })) as unknown as WorkingArtifact[];
      artifacts = [...new Map([...inheritedSources as unknown as WorkingArtifact[], ...artifacts]
        .map((artifact) => [artifact.id, artifact])).values()];
    }
    const settings = this.toDto(run, undefined, artifacts);
    const renderConfig = added.length ? await tx.workflowNodeState.findUnique({ where: {
      projectId_workflowRunId_nodeId: { projectId, workflowRunId: run.workflowRunId, nodeId: 'SEGMENT_RENDER' },
    } }) : null;
    const configuredRatio = (renderConfig?.state as { ratio?: string } | undefined)?.ratio;
    for (const variant of added) {
      const visual = artifacts.find((artifact) => artifact.nodeId === 'TEMPLATE_MIX' &&
        artifact.artifactKey === `timeline-project:${run.templateId}:${variant.id}` &&
        artifact.freshness === 'CURRENT' && artifact.availability === 'AVAILABLE');
      if (!visual) throw new ConflictException(`${variant.name} 的时间轴尚未确认`);
      const clips = this.liveClips(variant, workspace.materials, artifacts);
      const cp = packaging.get(variant.id);
      const duration = effectTemplateMixPlacedContentDuration(variant, cp);
      if (!(duration > 0) || duration > EFFECT_TEMPLATE_MIX_MAX_CONTENT_SECONDS)
        throw new ConflictException(`${variant.name} 的实际内容时长无效`);
      const dependency = { artifactId: visual.id, artifactKey: visual.artifactKey,
        nodeId: visual.nodeId, revision: visual.revision, contentHash: visual.contentHash ?? '' };
      const snapshot: FinalOutputSnapshot = {
        sourceDraft: { workflowRunId: run.workflowRunId, templateId: run.templateId,
          variantId: variant.id, contentHash: outputDraftContentHash(variant) },
        timeline: { narrationLayoutVersion: 'SLOT_V1', variant, clips,
          sourceTimelineHash: visualHash(variant), duration,
          detachedAudios: variant.detachedAudios ?? [], facts: [], dependencies: [dependency] },
        packaging: { voices: variant.voice ? { manual: variant.voice } : {},
          ...(variant.bgm ? { music: variant.bgm } : {}), captions: variant.captions ?? [] },
        unpackaged: !variant.voice && !variant.bgm && !(variant.captions?.length), dependencies: [dependency],
        aspectRatio: effectResolvedCanvasRatio(variant, workspace.materials, workspace.renderAspectRatio ?? configuredRatio,
          (run.items[0]?.snapshot as unknown as FinalOutputSnapshot | undefined)?.aspectRatio),
        originalVolume: variant.originalVolume ?? 1,
        resolution: settings.resolution, frameRate: settings.frameRate,
      };
      const item = await tx.effectFinalOutputItem.create({ data: { projectId, runId: id,
        variantId: variant.id, name: variant.name, status: 'QUEUED', snapshot: json(snapshot) } });
      await this.rewriteFilm(tx, run.templateId, item, variant, workspace, artifacts,
        'QUEUED', packaging.get(variant.id));
      const queued = await tx.effectFinalOutputItem.findUniqueOrThrow({ where: { id: item.id } });
      await this.current(tx, projectId, queued.snapshot as unknown as FinalOutputSnapshot);
    }
    let queuedUpdates = 0;
    for (const item of chosen) {
      const variant = variants?.find((candidate) => candidate.id === item.variantId);
      if (!variant) continue;
      // The film keeps its old file until the new one lands, so it stays downloadable meanwhile.
      const changes = effectTemplateMixSourceChanges(variant, workspace.materials);
      const blocked = changes.find((change) => change.blockedReason);
      if (blocked) throw new ConflictException(`${item.name}：${blocked.blockedReason}`);
      const removedSlotIds = changes.filter((change) => change.kind === 'REMOVED').map((change) => change.slotId);
      const replacements = changes.filter((change) => change.kind !== 'REMOVED');
      const cp = packaging.get(item.variantId) ?? (item.snapshot as unknown as FinalOutputSnapshot).packaging;
      if (removedSlotIds.length && (variant.detachedAudios ?? []).some((audio) => {
        if (audio.sourceSlotId || audio.audioKind !== 'VOICE') return false;
        const owners = (cp.script ?? []).filter((line) => cp.voices?.[line.id]?.fileObjectId === audio.fileObjectId);
        return owners.length > 1 && owners.some((line) => removedSlotIds.includes(line.slotId ?? ''));
      })) throw new ConflictException('历史裁剪口播的槽位来源不唯一，无法安全清理；请先手动处理，原工程保留');
      const updated = removedSlotIds.length ? clearRemovedSourceSlots(variant, cp, removedSlotIds) : structuredClone(variant);
      // Recover only exact current legacy bindings. Changed bindings are replaced below;
      // never assign today's file to an older adopted revision.
      for (const [slotId, materialId] of Object.entries(updated.bindings)) {
        const source = workspace.materials.find((material) => material.id === materialId &&
          material.artifactRevision === updated.bindingRevisions[slotId]);
        if (!updated.bindingSources?.[slotId] && source)
          (updated.bindingSources ??= {})[slotId] = { ...structuredClone(source),
            contentUrl: `/api/projects/${projectId}/file-objects/${source.fileObjectId}/content` };
      }
      let refresh: FinalOutputSnapshot['sourceRefresh'];
      if (changes.length) {
        if (!(item.snapshot as unknown as FinalOutputSnapshot).unpackaged &&
          (cp.narrationLayoutVersion !== 'SLOT_V1' || cp.script?.some((line) => !line.slotId)))
          throw new ConflictException('旧口播没有槽位来源，无法安全局部替换；请重新包装，原成片仍可使用');
        for (const change of replacements) {
          updated.bindings[change.slotId] = change.material!.id;
          updated.bindingRevisions[change.slotId] = change.material!.artifactRevision;
          (updated.bindingSources ??= {})[change.slotId] = { ...structuredClone(change.material!),
            contentUrl: `/api/projects/${projectId}/file-objects/${change.material!.fileObjectId}/content` };
          updated.offsets[change.slotId] = 0; // The model chooses the real start before encoding.
          if (updated.intentionallyEmptySlotIds)
            updated.intentionallyEmptySlotIds = updated.intentionallyEmptySlotIds.filter((id) => id !== change.slotId);
          for (const audio of updated.detachedAudios ?? []) if (audio.sourceSlotId === change.slotId) {
            audio.fileObjectId = change.material!.fileObjectId;
            audio.sourceDuration = change.material!.duration;
            audio.offset = 0;
          }
        }
        const packageItem = await tx.effectPackagingItem.findFirst({ where: {
          projectId, variantId: item.variantId, status: 'COMPLETED',
          run: { workflowRunId: run.workflowRunId, templateId: run.templateId },
        }, orderBy: [{ run: { createdAt: 'desc' } }, { id: 'desc' }] });
        refresh = { workflowRunId: run.workflowRunId, templateId: run.templateId,
          protocol: 'FROZEN_RENDER_V1',
          templateHash: workflowStateHash(workspace.draft.templates.find((entry) => entry.id === run.templateId)!.workspace.template),
          baselineVariant: variant, baselinePackaging: cp,
          sourceBatches: artifacts.filter((artifact) => artifact.nodeId === 'SEGMENT_RENDER' &&
            artifact.artifactKey.startsWith('render-batch:') && artifact.freshness === 'CURRENT' &&
            (artifact.metadata as { branchSourceOwner?: boolean } | null)?.branchSourceOwner !== false &&
            artifact.availability === 'AVAILABLE').map((artifact) => ({ artifactId: artifact.id,
              artifactKey: artifact.artifactKey, revision: artifact.revision, contentHash: artifact.contentHash ?? '' })),
          ...(packageItem ? { packagingItemId: packageItem.id } : {}),
          slots: replacements.map((change) => ({ slotId: change.slotId, material: change.material! })),
          ...(removedSlotIds.length ? { removedSlotIds } : {}),
          ...(projectRefreshOnly && item.fileObjectId ? {
            previousOutputSnapshot: structuredClone(
              (item.snapshot as unknown as FinalOutputSnapshot).sourceRefresh?.previousOutputSnapshot ?? item.snapshot,
            ) as unknown as FinalOutputSnapshot,
          } : {}),
          ...(!replacements.length ? { trimsReady: true, ready: true } : {}) };
      }
      await this.rewriteFilm(tx, run.templateId, item, updated, workspace, artifacts, 'QUEUED',
        packaging.get(item.variantId), undefined, refresh);
      const queued = await tx.effectFinalOutputItem.findUniqueOrThrow({ where: { id: item.id } });
      const nextSnapshot = queued.snapshot as unknown as FinalOutputSnapshot;
      if (removedSlotIds.length) {
        nextSnapshot.packaging = withoutRemovedSlots(cp, removedSlotIds);
        nextSnapshot.timeline.duration = effectTemplateMixContentDuration(updated, nextSnapshot.packaging);
      }
      if (projectRefreshOnly) {
        nextSnapshot.projectRefreshOnly = true;
      }
      await tx.effectFinalOutputItem.update({ where: { id: item.id }, data: { snapshot: json(nextSnapshot) } });
      await this.current(tx, projectId, nextSnapshot);
      if (projectRefreshOnly && refresh?.ready) {
        const previousOutput = refresh.previousOutputSnapshot;
        await this.commitSourceRefresh(tx, projectId, nextSnapshot);
        if (previousOutput) delete previousOutput.projectRefreshOnly;
        else delete nextSnapshot.projectRefreshOnly;
        await tx.effectFinalOutputItem.update({ where: { id: item.id }, data: {
          snapshot: json(previousOutput ?? nextSnapshot), status: item.fileObjectId ? 'COMPLETED' : 'PENDING_RENDER',
          progress: 100, errorMessage: null,
        } });
      } else {
        queuedUpdates += 1;
      }
    }
    if (removed.length) await tx.effectFinalOutputItem.deleteMany({ where: {
      projectId, runId: id, id: { in: removed.map((item) => item.id) },
    } });
    const needsRender = added.length > 0 || queuedUpdates > 0;
    const pendingRender = projectRefreshOnly && run.items.some((item) =>
      !removed.some((deleted) => deleted.id === item.id) && !item.fileObjectId);
    const remainingFailed = run.items.filter((item) => !removed.some((deleted) => deleted.id === item.id) &&
      !chosen.some((chosen) => chosen.id === item.id) && ['FAILED', 'CANCELLED'].includes(item.status));
    const settledStatus = remainingFailed.length ? run.items.some((item) => item.status === 'COMPLETED' &&
      !removed.some((deleted) => deleted.id === item.id)) ? 'PARTIAL' : 'FAILED' : 'COMPLETED';
    await tx.effectFinalOutputRun.update({
      where: { id },
      data: { status: needsRender ? 'QUEUED' : pendingRender
        ? 'PENDING_RENDER' : settledStatus, attemptToken: null,
        leaseExpiresAt: null, completedAt: needsRender || pendingRender ? null : new Date() },
    });
    if (needsRender) await this.enqueue(tx, projectId, id);
    if (!projectRefreshOnly && removed.length) await this.finalizeDelivery(projectId, id, tx, true);
    else if (!needsRender && !projectRefreshOnly && settledStatus === 'COMPLETED') await this.finalizeDelivery(projectId, id, tx);
  }

  /** Queue source refresh atomically; stale confirmed timelines do not need a second smart fill. */
  async updateSourceProjects(projectId: string, body: SourceUpdateFinalOutputRequest): Promise<SourceUpdateFinalOutputData> {
    const { workflowRunId, templateId, expectedDraftRevision } = body;
    let variantIds = body.variantIds;
    if (new Set(variantIds).size !== variantIds.length)
      throw new BadRequestException('请先选择需要更新的成片工程');
    const id = await this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${projectId + ':' + workflowRunId + ':' + templateId}))`;
      await tx.$queryRaw`SELECT id FROM workflow_runs WHERE "projectId"=${projectId}::uuid AND id=${workflowRunId}::uuid FOR UPDATE`;
      if (body.operationId) {
        const previous = await tx.effectFinalOutputItem.findFirst({ where: { projectId,
          run: { workflowRunId, templateId }, snapshot: { path: ['sourceOperation', 'id'], equals: body.operationId } },
          select: { runId: true, snapshot: true } });
        if (previous) {
          const frozen = (previous.snapshot as unknown as FinalOutputSnapshot).sourceOperation!;
          if (frozen.confirmationHash !== workflowStateHash(body))
            throw new ConflictException('局部更新请求标识已被不同确认使用');
          return previous.runId;
        }
      }
      await tx.$queryRaw`SELECT id FROM workflow_node_states WHERE "projectId"=${projectId}::uuid AND "workflowRunId"=${workflowRunId}::uuid AND "nodeId"='TEMPLATE_MIX' FOR UPDATE`;
      const state = await tx.workflowNodeState.findUnique({ where: {
        projectId_workflowRunId_nodeId: { projectId, workflowRunId, nodeId: 'TEMPLATE_MIX' },
      }, select: { revision: true } });
      if (state?.revision !== expectedDraftRevision)
        throw new ConflictException('成片工程已变化，请刷新后重试');
      const workspace = await this.mix.workspace(projectId, workflowRunId);
      const entry = workspace.draft.templates.find((entry) => entry.id === templateId);
      if (!entry) throw new ConflictException('当前混剪模板不存在');
      const affected = entry.workspace.variants.filter((variant) =>
        effectTemplateMixSourceChanges(variant, workspace.materials).length);
      const addedIds = body.appendNewMaterials ? workspace.pendingAddedMaterialIds?.[templateId] ?? [] : [];
      if (!affected.length && !addedIds.length) return null;
      const tree = await this.branches.getEffectBranchTree(projectId);
      if (effectTemplateBranchTips(tree.branches, tree.activeWorkflowRunId, { current: true }).get(templateId)?.workflowRunId !== workflowRunId)
        throw new ConflictException('只能更新该模板的当前成片分支，请刷新后重试');
      const signature = effectTemplateMixSourceUpdateSignature(entry.workspace.variants, workspace.materials, addedIds);
      if (body.expectedSourceSignature !== undefined && signature !== body.expectedSourceSignature)
        throw new ConflictException('待更新范围已变化，请重新确认局部更新');
      variantIds = affected.map((variant) => variant.id);
      const active = await tx.effectTemplateMixAiRun.findFirst({ where: { projectId, workflowRunId,
        templateId, status: { in: ['QUEUED', 'RUNNING'] } } });
      if (active) throw new ConflictException('此模板正在局部更新，请等待完成');
      const frozenArtifacts = await this.working.listArtifacts(projectId, { workflowRunId });
      const packageNewVariants = addedIds.length > 0 && await this.mix.hasSuccessfulPackaging(projectId, workflowRunId, templateId);
      if (addedIds.length && body.expectedPackageNewVariants !== undefined &&
        body.expectedPackageNewVariants !== packageNewVariants)
        throw new ConflictException('新增成片的自动包装及费用类型已变化，请重新确认局部更新');
      const sourceOperation: EffectTemplateMixFrozenSourceContext = {
        id: body.operationId ?? randomUUID(), confirmationHash: workflowStateHash(body),
        protocol: 'FROZEN_RENDER_V1', templateHash: workflowStateHash(entry.workspace.template),
        materials: structuredClone(workspace.materials.filter((source) => source.available &&
          source.activeSource !== false && !source.sourceRemoved)),
        promptArtifacts: frozenArtifacts.filter((source) => source.nodeId === 'PROMPT_GENERATION' &&
          source.artifactKey.startsWith('prompt-batch:') && source.freshness === 'CURRENT').map((source) => ({
            id: source.id, artifactKey: source.artifactKey, revision: source.revision, contentHash: source.contentHash ?? '',
          })),
        addedMaterialIds: [...addedIds],
        facts: packagingFacts(frozenArtifacts as unknown as WorkingArtifact[]),
        packageNewVariants,
      };
      let run = await tx.effectFinalOutputRun.findFirst({ where: { projectId, workflowRunId, templateId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], include });
      const previousOperation = (run?.items[0]?.snapshot as unknown as FinalOutputSnapshot | undefined)?.sourceOperation;
      if (previousOperation?.addedMaterialIds.length && ['COMPLETED', 'PENDING_RENDER'].includes(run!.status) &&
        previousOperation.id !== body.operationId) {
        const appended = await tx.effectTemplateMixAiRun.findFirst({ where: { projectId, workflowRunId, templateId,
          inputSnapshot: { path: ['sourceOperation', 'id'], equals: previousOperation.id } }, select: { status: true } });
        if (!appended || appended.status !== 'COMPLETED')
          throw new ConflictException('上一轮局部更新的新增成片尚未完成，请先继续或重试原任务');
      }
      if (await tx.effectPackagingRun.count({ where: { projectId, workflowRunId, templateId,
        status: { in: ['QUEUED', 'RUNNING'] } } }))
        throw new ConflictException('此模板正在包装新增成片，请等待本次局部更新完成');
      if (!run) {
        const workspace = await this.mix.workspace(projectId, workflowRunId);
        const entry = workspace.draft?.templates.find((entry) => entry.id === templateId);
        if (!entry || entry.needsAiFill)
          throw new ConflictException('模板槽位配置已变化，请重新智能填充');
        const localArtifacts = (await tx.workingArtifact.findMany({ where: { projectId, workflowRunId },
          include: workingArtifactInclude })) as unknown as WorkingArtifact[];
        if (hasOutputVersion(localArtifacts))
          throw new ConflictException('当前分支的成片批次缺失，原交付文件已保留，请先恢复成片批次');
        const inherited = await this.working.listArtifacts(projectId, { workflowRunId });
        const artifacts = [...new Map([...localArtifacts, ...inherited as unknown as WorkingArtifact[]]
          .map((artifact) => [artifact.id, artifact])).values()];
        const confirmed = entry.workspace.variants.filter((variant) => artifacts.some((artifact) =>
          artifact.artifactKey === `timeline-project:${templateId}:${variant.id}` &&
          localArtifacts.some((local) => local.id === artifact.id) &&
          artifact.nodeId === 'TEMPLATE_MIX' && artifact.availability === 'AVAILABLE'));
        if (variantIds.some((id) => !confirmed.some((variant) => variant.id === id)))
          throw new ConflictException('选中的成片工程尚未确认，请先完成智能填充');
        if (confirmed.some((variant) => !variantIds.includes(variant.id) &&
          effectTemplateMixSourceChanges(variant, workspace.materials).length))
          throw new ConflictException('待更新成片已变化，请刷新后重试');
        const packaging = await this.packagingByVariant(projectId, workflowRunId, [templateId], tx);
        const rows = confirmed.map((variant) => {
          const visual = artifacts.find((artifact) => artifact.artifactKey === `timeline-project:${templateId}:${variant.id}`)!;
          const dependency = { artifactId: visual.id, artifactKey: visual.artifactKey,
            nodeId: visual.nodeId, revision: visual.revision, contentHash: visual.contentHash ?? '' };
          const cp = packaging.get(variant.id);
          const snapshot: FinalOutputSnapshot = {
            timeline: { narrationLayoutVersion: 'SLOT_V1', variant, clips: [], facts: [],
              sourceTimelineHash: visualHash(variant), duration: effectTemplateMixContentDuration(variant, cp),
              dependencies: [dependency] },
            packaging: cp ?? { voices: {}, captions: [] }, unpackaged: !cp,
            dependencies: [dependency], aspectRatio: effectResolvedCanvasRatio(variant, workspace.materials, workspace.renderAspectRatio),
            originalVolume: variant.originalVolume ?? 1, resolution: '720p', frameRate: 30,
          };
          return { variantId: variant.id, name: variant.name, status: 'PENDING_RENDER' as const, snapshot: json(snapshot) };
        });
        const inputHash = workflowStateHash({ sourceRefresh: true, expectedDraftRevision,
          projects: rows.map((row) => row.variantId) });
        run = await tx.effectFinalOutputRun.create({ data: { projectId, workflowRunId, templateId,
          inputHash, requestHash: inputHash, idempotencyKey: `source-refresh:${workflowRunId}:${templateId}:${inputHash}`,
          status: 'PENDING_RENDER', items: { create: rows } }, include });
        // These baseline rows are transaction-local only. All unchanged projects get valid snapshots;
        // selected projects are rewritten and checked by the existing source-refresh pipeline below.
        for (const item of run.items.filter((item) => !variantIds.includes(item.variantId))) {
          await this.rewriteFilm(tx, templateId, item, confirmed.find((variant) => variant.id === item.variantId)!,
            workspace, artifacts, 'PENDING_RENDER', packaging.get(item.variantId));
          const valid = await tx.effectFinalOutputItem.findUniqueOrThrow({ where: { id: item.id } });
          await this.current(tx, projectId, valid.snapshot as unknown as FinalOutputSnapshot);
        }
      }
      const items = run.items.filter((item) => variantIds.includes(item.variantId));
      if (items.length !== variantIds.length) throw new ConflictException('成片工程与当前批次不一致，请刷新后重试');
      if (items.length)
        await this.queueLocalUpdate(tx, projectId, run.id, { itemIds: items.map((item) => item.id) }, false, true,
          { workspace, artifacts: frozenArtifacts as unknown as WorkingArtifact[] });
      const latest = await this.mix.workspace(projectId, workflowRunId);
      const latestEntry = latest.draft.templates.find((row) => row.id === templateId);
      if (!latestEntry || effectTemplateMixSourceUpdateSignature(entry.workspace.variants, latest.materials,
        body.appendNewMaterials ? latest.pendingAddedMaterialIds?.[templateId] ?? [] : []) !== signature)
        throw new ConflictException('确认期间素材已变化，请重新确认局部更新');
      // Freeze APPEND before returning from the same confirmation. It survives refresh success,
      // failure/retry and page restoration without consulting a newer render pool.
      for (const row of await tx.effectFinalOutputItem.findMany({ where: { projectId, runId: run.id } })) {
        const snapshot = row.snapshot as unknown as FinalOutputSnapshot;
        snapshot.sourceOperation = sourceOperation;
        if (snapshot.sourceRefresh?.previousOutputSnapshot)
          snapshot.sourceRefresh.previousOutputSnapshot.sourceOperation = sourceOperation;
        await tx.effectFinalOutputItem.update({ where: { id: row.id }, data: { snapshot: json(snapshot) } });
      }
      return run.id;
    }, { timeout: 120_000 });
    return id ? this.get(projectId, id) : { noChanges: true };
  }

  async start(projectId: string, id: string, settings: StartFinalOutputRequest,
    idempotencyKey?: string) {
    if (
      !FINAL_OUTPUT_RESOLUTIONS.includes(settings.resolution) ||
      !([24, 25, 30, 50, 60] as const).includes(settings.frameRate)
    )
      throw new BadRequestException('分辨率或帧率设置无效');
    if (idempotencyKey && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(idempotencyKey))
      throw new BadRequestException('导出请求标识无效');
    const source = await this.db.effectFinalOutputRun.findFirst({
      where: { projectId, id },
      include,
    });
    if (!source) throw new NotFoundException('成片输出任务不存在');
    const tree = await this.branches.getEffectBranchTree(projectId);
    const tip = effectTemplateBranchTips(tree.branches, tree.activeWorkflowRunId, { current: true }).get(source.templateId);
    if (!tip) throw new ConflictException('该模板的当前分支不存在，请刷新后重试');
    const currentBatches = await this.listPath(projectId, tip.workflowRunId);
    if (!currentBatches.some((batch) => batch.id === source.id))
      throw new ConflictException('该模板的成片工程已变化，请刷新后再导出');
    const active = await this.db.workflowRun.findFirst({ where: {
      projectId, workflow: 'EFFECT', workflowSpace: 'EFFECT', activeKey: 'ACTIVE',
      status: { in: ['ACTIVE', 'PAUSED'] },
    }, select: { id: true, editSessionNodeId: true } });
    if (!active || active.editSessionNodeId)
      throw new ConflictException('请先保存或取消当前编辑，再导出成片');
    if (active.id !== tree.activeWorkflowRunId)
      throw new ConflictException('工作流分支正在更新，请等待当前任务完成后再导出');
    if (source.status === 'QUEUED' || source.status === 'RUNNING')
      throw new ConflictException('该模板已开始渲染，不能修改本批输出规格');
    const unexported = source.items.filter((item) => item.status !== 'COMPLETED');
    if (source.status === 'PENDING_RENDER' && unexported.length && unexported.every((item) =>
      (item.snapshot as unknown as FinalOutputSnapshot).appendOnly)) {
      await this.startAppendedFilms(projectId, source.id, settings);
      return this.get(projectId, source.id);
    }
    // Every full export owns a new, template-scoped Run. A re-export must leave the previous
    // delivery and its files in its published branch while the new batch is still rendering.
    const edit = await this.working.beginEffectNodeEdit(
      projectId, tip.workflowRunId, 'FINAL_OUTPUT', 'BATCH',
      { always: true, keepParentActive: true,
        templateId: source.templateId, templateScopeActiveRunId: active.id,
        ...(idempotencyKey ? { creationKey: `final-output:${id}:${idempotencyKey}` } : {}) },
    );
    if (!edit) throw new ConflictException('当前分支无法创建成片输出版本');
    const batch = await this.db.effectFinalOutputRun.findFirst({
      where: { projectId, workflowRunId: edit.runId, templateId: source.templateId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true },
    });
    if (!batch) throw new ConflictException('新版本的成片输出批次不存在');
    const targetId = batch.id;
    if (!edit.created) {
      const existing = await this.db.effectFinalOutputRun.findFirst({
        where: { projectId, id: targetId }, include,
      });
      if (existing && ['QUEUED', 'RUNNING', 'COMPLETED'].includes(existing.status)) {
        const snapshot = existing.items[0]?.snapshot as unknown as FinalOutputSnapshot | undefined;
        if (snapshot?.resolution !== settings.resolution || snapshot?.frameRate !== settings.frameRate)
          throw new ConflictException('该模板已有不同分辨率或帧率的导出任务，请刷新后查看');
        return this.get(projectId, targetId);
      }
    }
    // The clone owns the draft frozen at branch creation, not the old delivery's geometry.
    try {
      const workspace = await this.mix.outputSourceWorkspace(projectId, edit.runId);
      await this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM effect_final_output_runs WHERE id=${targetId}::uuid AND "projectId"=${projectId}::uuid FOR UPDATE`;
      const run = await tx.effectFinalOutputRun.findFirst({ where: { projectId, id: targetId }, include });
      if (!run) throw new NotFoundException('成片输出任务不存在');
      // The cloned batch is pending; duplicate calls cannot enqueue it twice.
      if (['QUEUED', 'RUNNING', 'COMPLETED'].includes(run.status)) {
        const snapshot = run.items[0]?.snapshot as unknown as FinalOutputSnapshot | undefined;
        if (snapshot?.resolution !== settings.resolution || snapshot?.frameRate !== settings.frameRate)
          throw new ConflictException('该模板已有不同分辨率或帧率的导出任务，请刷新后查看');
        return;
      }
      const variants = workspace.draft?.templates.find((entry) => entry.id === source.templateId)
        ?.workspace.variants ?? [];
      const outputVariants = variants.filter((variant) => run.items.some((item) => item.variantId === variant.id) ||
        effectTemplateMixPlacedContentDuration(variant) > 0);
      if (!outputVariants.length || outputVariants.length !== run.items.length ||
        run.items.some((item) => !variants.some((variant) => variant.id === item.variantId)))
        throw new ConflictException('当前成片工程数量已变化，请先同步成片工程后再导出');
      const artifacts = await tx.workingArtifact.findMany({ where: {
        projectId, workflowRunId: edit.runId,
      }, include: workingArtifactInclude }) as unknown as WorkingArtifact[];
      const packaging = await this.packagingByVariant(projectId, edit.runId, [source.templateId], tx);
      for (const item of run.items) {
        const variant = variants.find((entry) => entry.id === item.variantId)!;
        await this.rewriteFilm(tx, source.templateId, item, variant, workspace, artifacts,
          'QUEUED', packaging.get(item.variantId), settings);
        const queued = await tx.effectFinalOutputItem.findUniqueOrThrow({ where: { id: item.id } });
        await this.current(tx, projectId, queued.snapshot as unknown as FinalOutputSnapshot);
      }
      await tx.effectFinalOutputRun.update({
        where: { id: targetId },
        data: { status: 'QUEUED', attemptToken: null, leaseExpiresAt: null, completedAt: null },
      });
      await this.enqueue(tx, projectId, targetId);
      // 100 items x upstream validation is the same order of work as complete().
      }, { timeout: 120_000 });
    } catch (reason) {
      // A preparation error must not leave a pending child that future clicks cannot start.
      // A duplicate request must never cancel the already queued independent job.
      await this.db.effectFinalOutputRun.updateMany({ where: {
        projectId, id: targetId, status: 'PENDING_RENDER',
      }, data: { status: 'FAILED', completedAt: new Date() } });
      throw reason;
    }
    return this.get(projectId, targetId);
  }

  private async startAppendedFilms(projectId: string, id: string, settings: StartFinalOutputRequest): Promise<void> {
    await this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM effect_final_output_runs WHERE id=${id}::uuid AND "projectId"=${projectId}::uuid FOR UPDATE`;
      const run = await tx.effectFinalOutputRun.findFirst({ where: { projectId, id }, include });
      if (!run || run.status !== 'PENDING_RENDER') throw new ConflictException('新增成片已开始导出或批次已变化');
      const items = run.items.filter((item) => item.status !== 'COMPLETED');
      if (!items.length || items.some((item) => !(item.snapshot as unknown as FinalOutputSnapshot).appendOnly))
        throw new ConflictException('当前批次不属于新增成片导出');
      if (await tx.effectPackagingRun.count({ where: { projectId, workflowRunId: run.workflowRunId,
        templateId: run.templateId, status: { in: ['QUEUED', 'RUNNING'] } } }))
        throw new ConflictException('新增成片正在包装，请等待包装结束后导出');
      await tx.$queryRaw`SELECT id FROM workflow_node_states WHERE "projectId"=${projectId}::uuid AND "workflowRunId"=${run.workflowRunId}::uuid AND "nodeId"='TEMPLATE_MIX' FOR SHARE`;
      const workspace = await this.mix.outputSourceWorkspace(projectId, run.workflowRunId);
      const variants = workspace.draft?.templates.find((entry) => entry.id === run.templateId)?.workspace.variants ?? [];
      const artifacts = await tx.workingArtifact.findMany({ where: { projectId, workflowRunId: run.workflowRunId },
        include: workingArtifactInclude }) as unknown as WorkingArtifact[];
      const packaging = await this.packagingByVariant(projectId, run.workflowRunId, [run.templateId], tx);
      for (const item of items) {
        if ((item.snapshot as unknown as FinalOutputSnapshot).appendPackagingRequired && !packaging.has(item.variantId))
          throw new ConflictException(`${item.name} 的新增包装尚未完成，请先在混剪节点继续更新或重试包装`);
        const variant = variants.find((variant) => variant.id === item.variantId);
        if (!variant) throw new ConflictException(`${item.name} 的混剪工程已删除`);
        await this.rewriteFilm(tx, run.templateId, item, variant, workspace, artifacts,
          'QUEUED', packaging.get(item.variantId), settings);
        const queued = await tx.effectFinalOutputItem.findUniqueOrThrow({ where: { id: item.id } });
        await this.current(tx, projectId, queued.snapshot as unknown as FinalOutputSnapshot);
      }
      await tx.effectFinalOutputRun.update({ where: { id }, data: {
        status: 'QUEUED', attemptToken: null, leaseExpiresAt: null, completedAt: null,
      } });
      await this.enqueue(tx, projectId, id);
    }, { timeout: 120_000 });
  }

  /** Commit the delivery index only after every film succeeds; the caller then publishes its Run. */
  private async finalizeDelivery(projectId: string, id: string, client?: Prisma.TransactionClient, syncRemoval = false): Promise<string> {
    const commit = async (tx: Prisma.TransactionClient) => {
      await tx.$queryRaw`SELECT id FROM effect_final_output_runs WHERE id=${id}::uuid AND "projectId"=${projectId}::uuid FOR UPDATE`;
      const run = await tx.effectFinalOutputRun.findFirst({ where: { projectId, id }, include });
      if (!run) throw new NotFoundException('成片输出任务不存在');
      if (!syncRemoval && (run.status !== 'COMPLETED' ||
        run.items.some((item) => item.status !== 'COMPLETED' || !item.fileObjectId || !item.assetId))
      )
        throw new ConflictException('请等待当前模板的全部成片成功导出后再完成校验');

      // The draft and committed sources cannot change between validation and the manifest commit.
      await tx.$queryRaw`SELECT id FROM workflow_node_states WHERE "projectId"=${projectId}::uuid AND "workflowRunId"=${run.workflowRunId}::uuid AND "nodeId"='TEMPLATE_MIX' FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM working_artifacts WHERE "projectId"=${projectId}::uuid AND "workflowRunId"=${run.workflowRunId}::uuid ORDER BY id FOR UPDATE`;
      const workspace = await this.mix.workspace(projectId, run.workflowRunId);
      const artifacts = await tx.workingArtifact.findMany({
        where: { projectId, workflowRunId: run.workflowRunId },
        include: workingArtifactInclude,
      });
      const templateName = workspace.draft?.templates.find((entry) => entry.id === run.templateId)
        ?.workspace.template.name;
      const result = this.toDto(run, templateName, artifacts);
      const ordered = run.items.filter((item) => !syncRemoval || (item.fileObjectId && item.assetId)).sort((a, b) =>
        a.name.localeCompare(b.name, 'zh-CN', { numeric: true }) || a.id.localeCompare(b.id),
      );
      const fileIds = [...new Set(ordered.map((item) => item.fileObjectId!))];
      const assetIds = [...new Set(ordered.map((item) => item.assetId!))];
      const [files, assets] = await Promise.all([
        tx.fileObject.findMany({ where: {
          projectId, id: { in: fileIds }, status: 'AVAILABLE',
        } }),
        tx.asset.findMany({ where: {
          projectId, id: { in: assetIds }, type: 'FINAL_VIDEO', status: 'AVAILABLE',
        } }),
      ]);
      const fileById = new Map(files.map((file) => [file.id, file]));
      const assetById = new Map(assets.map((asset) => [asset.id, asset]));
      const entries = ordered.map((item) => {
        const key = `final-video:${run.templateId}:${item.variantId}`;
        const artifact = artifacts.find((candidate) =>
          candidate.nodeId === 'FINAL_OUTPUT' && candidate.artifactKey === key);
        const file = fileById.get(item.fileObjectId!);
        const asset = assetById.get(item.assetId!);
        if (!artifact || artifact.availability !== 'AVAILABLE' ||
          !artifact.files.some((linked) => linked.fileObjectId === item.fileObjectId) ||
          !file || !asset || asset.sourceArtifactId !== artifact.id ||
          asset.storageKey !== file.storageKey)
          throw new ConflictException(`${item.name} 的成片文件或交付资产不可用，请重新渲染`);
        return { item, artifact, file, asset };
      });
      await this.working.commitValidatedArtifactsInTransaction(
        tx,
        projectId,
        run.workflowRunId,
        'FINAL_OUTPUT',
        [{
          artifactKey: `final-delivery:${run.templateId}`,
          input: {
            kind: 'STRUCTURED',
            name: `${templateName ?? '混剪模板'} · 成片交付清单`,
            directory: 'REPORTS_DELIVERABLES',
            type: 'DELIVERY_MANIFEST',
            payload: {
              schemaVersion: 1,
              templateId: run.templateId,
              runId: run.id,
              resolution: result.resolution,
              frameRate: result.frameRate,
              items: entries.map(({ item, artifact }) => ({
                id: item.id,
                variantId: item.variantId,
                name: item.name,
                fileObjectId: item.fileObjectId,
                assetId: item.assetId,
                artifactId: artifact.id,
                artifactRevision: artifact.revision,
              })),
            },
            files: entries.map(({ file }, sortOrder) => ({
              fileObjectId: file.id,
              role: 'VIDEO',
              sortOrder,
              originalFileName: file.originalFileName,
              mimeType: file.mimeType,
              sha256: file.sha256,
            })),
            // A delivery manifest freezes exported files, not the mutable mix source timeline.
            dependencies: [],
          },
        }],
      );
      return run.workflowRunId;
    };
    return client ? commit(client) : this.db.$transaction(commit, { timeout: 120_000 });
  }

  /**
   * Older output forks copied artifact ids but left their parent's content hashes in the frozen
   * films. Repair only that exact clone: every old hash must match the corresponding parent film,
   * every new artifact must still be current in this child, and the live picture must be identical.
   * A real edit or missing source must continue to fail delivery validation.
   */
  private async repairClonedOutputSnapshots(projectId: string, id: string): Promise<boolean> {
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM effect_final_output_runs WHERE id=${id}::uuid AND "projectId"=${projectId}::uuid FOR UPDATE`;
      const run = await tx.effectFinalOutputRun.findFirst({ where: { projectId, id }, include });
      if (!run || run.status !== 'COMPLETED' || !run.items.length) return false;
      const branch = await tx.workflowRun.findFirst({ where: {
        projectId, id: run.workflowRunId, forkNodeId: 'FINAL_OUTPUT',
        branchPublishedAt: null, parentWorkflowRunId: { not: null },
      }, select: { parentWorkflowRunId: true } });
      if (!branch?.parentWorkflowRunId) return false;
      const parent = await tx.effectFinalOutputRun.findFirst({ where: {
        projectId, workflowRunId: branch.parentWorkflowRunId, templateId: run.templateId,
      }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], include });
      if (!parent || parent.items.length !== run.items.length) return false;
      const parentByVariant = new Map(parent.items.map((item) => [item.variantId, item]));
      const artifacts = await tx.workingArtifact.findMany({ where: {
        projectId, workflowRunId: run.workflowRunId,
      }, include: workingArtifactInclude });
      const artifactById = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
      const workspace = await this.mix.workspace(projectId, run.workflowRunId);
      const liveTemplate = workspace.draft?.templates.find((entry) => entry.id === run.templateId);
      if (!liveTemplate) return false;
      const repaired: Array<{ id: string; snapshot: FinalOutputSnapshot }> = [];
      for (const item of run.items) {
        const original = parentByVariant.get(item.variantId);
        if (!original) return false;
        const snapshot = item.snapshot as unknown as FinalOutputSnapshot;
        const parentSnapshot = original.snapshot as unknown as FinalOutputSnapshot;
        if (snapshot.timeline.sourceTimelineHash !== parentSnapshot.timeline.sourceTimelineHash ||
          snapshot.dependencies.length !== parentSnapshot.dependencies.length) return false;
        const hashMap: Record<string, string> = {};
        for (const [index, dependency] of snapshot.dependencies.entries()) {
          const parentDependency = parentSnapshot.dependencies[index];
          const artifact = artifactById.get(dependency.artifactId);
          if (!parentDependency || dependency.contentHash !== parentDependency.contentHash ||
            dependency.revision !== parentDependency.revision || !artifact ||
            artifact.revision !== dependency.revision || artifact.freshness !== 'CURRENT' ||
            artifact.availability !== 'AVAILABLE') return false;
          const prior = hashMap[dependency.contentHash];
          if (prior && prior !== artifact.contentHash) return false;
          hashMap[dependency.contentHash] = artifact.contentHash;
        }
        const updated = remapIds(snapshot, hashMap);
        updated.timeline.sourceTimelineHash = visualHash(updated.timeline.variant);
        const liveVariant = liveTemplate.workspace.variants.find((variant) =>
          variant.id === item.variantId);
        if (!liveVariant || !matchesVisualHash(liveVariant,
          updated.timeline.sourceTimelineHash, updated.timeline.variant)) return false;
        try {
          if (pictureHash(this.liveClips(liveVariant, workspace.materials,
            artifacts as unknown as WorkingArtifact[])) !== pictureHash(updated.timeline.clips) ||
            (liveVariant.canvasRatio ?? null) !== (updated.timeline.variant.canvasRatio ?? null) ||
            effectTemplateMixContentDuration(liveVariant, updated.packaging) !==
              updated.timeline.duration) return false;
        } catch {
          return false;
        }
        repaired.push({ id: item.id, snapshot: updated });
      }
      for (const item of repaired)
        await tx.effectFinalOutputItem.update({ where: { id: item.id }, data: {
          snapshot: json(item.snapshot),
        } });
      return true;
    }, { timeout: 120_000 });
  }

  private async deliverCompletedBatch(projectId: string, id: string): Promise<void> {
    let workflowRunId: string;
    try {
      workflowRunId = await this.finalizeDelivery(projectId, id);
    } catch (error) {
      if (!await this.repairClonedOutputSnapshots(projectId, id)) throw error;
      workflowRunId = await this.finalizeDelivery(projectId, id);
    }
    await this.publishEditBranch(projectId, workflowRunId, 'FINAL_OUTPUT');
  }

  /**
   * Compare an unexported queue item with the draft so it can follow edits before rendering.
   */
  private sourceSnapshotDiffers(
    templateId: string,
    item: { variantId: string; snapshot: unknown },
    artifacts: ArtifactRow[],
    workspace?: Pick<EffectTemplateMixWorkspaceData, 'draft' | 'materials'>,
  ): boolean {
    const snapshot = item.snapshot as unknown as FinalOutputSnapshot;
    const currentVariant = workspace?.draft?.templates
      .find((entry) => entry.id === templateId)
      ?.workspace.variants.find((variant) => variant.id === item.variantId);
    return Boolean(currentVariant && workspace && effectTemplateMixSourceChanges(currentVariant, workspace.materials).length) ||
      (snapshot.dependencies ?? []).some((dependency) =>
      !artifacts.some((artifact) =>
        artifact.id === dependency.artifactId &&
        artifact.revision === dependency.revision &&
        artifact.contentHash === dependency.contentHash &&
        artifact.freshness === 'CURRENT' &&
        artifact.availability === 'AVAILABLE',
      ),
    ) || !currentVariant || !matchesVisualHash(
      currentVariant,
      snapshot.timeline.sourceTimelineHash,
      snapshot.timeline.variant,
    );
  }

  /** The clips the draft would render right now, walked through their sources the same way packaging does. */
  private liveClips(
    variant: EffectTemplateMixVariant,
    materials: EffectTemplateMixMaterial[],
    artifacts: WorkingArtifact[],
  ): PackagingSnapshot['clips'] {
    return packagingClips(variant, materials, artifactVisitor(artifacts), true, true).map((clip) => ({
      ...clip,
      // Rows are numbered against the draft the user is looking at; the packaging snapshot's own row
      // numbers are frozen and would place a clip beside one it should sit under.
      lane: variant.videoLanes?.[clip.slotId] ?? clip.lane,
    }));
  }

  /**
   * Whether re-exporting this film would produce a different picture than the one on file. The
   * packaging's own hash ignores placement, so the clips are compared as well — moving a clip is an
   * edit even though it never invalidates the narration.
   */
  private draftDiffersFromSnapshot(
    templateId: string,
    item: OutputItemRow,
    artifacts: WorkingArtifact[],
    workspace?: Pick<EffectTemplateMixWorkspaceData, 'draft' | 'materials'>,
    latestPackaging?: PackagingCheckpoint,
  ): boolean {
    if (this.sourceSnapshotDiffers(templateId, item, artifacts, workspace)) return true;
    const snapshot = item.snapshot as unknown as FinalOutputSnapshot;
    if (latestPackaging && renderPackagingHash(latestPackaging) !==
      renderPackagingHash(snapshot.packaging)) return true;
    const variant = workspace?.draft?.templates
      .find((entry) => entry.id === templateId)
      ?.workspace.variants.find((candidate) => candidate.id === item.variantId);
    if (!variant) return true;
    try {
      return (
        pictureHash(this.liveClips(variant, workspace!.materials, artifacts)) !==
          pictureHash(snapshot.timeline.clips) ||
        (variant.canvasRatio ?? null) !== (snapshot.timeline.variant.canvasRatio ?? null) ||
        workflowStateHash(variant.detachedAudios ?? []) !==
          workflowStateHash(snapshot.timeline.detachedAudios ?? []) ||
        (variant.originalVolume ?? snapshot.originalVolume) !== snapshot.originalVolume ||
        effectTemplateMixContentDuration(variant, snapshot.packaging) !== snapshot.timeline.duration
      );
    } catch {
      return true;
    }
  }

  /** Read and execute the same membership projection; unbound placeholders are not films. */
  private projectMembership(
    run: Prisma.EffectFinalOutputRunGetPayload<{ include: typeof include }>,
    artifacts: ArtifactRow[],
    workspace?: Pick<EffectTemplateMixWorkspaceData, 'draft' | 'materials'> &
      Partial<Pick<EffectTemplateMixWorkspaceData, 'draftRevision'>>,
    packaging: ReadonlyMap<string, PackagingCheckpoint> = new Map(),
  ): FinalOutputRun['projectChanges'] {
    const variants = workspace?.draft?.templates.find((entry) => entry.id === run.templateId)?.workspace.variants;
    if (!variants || !hasOutputVersion(artifacts)) return undefined;
    return {
      ...(typeof workspace?.draftRevision === 'number' ? { draftRevision: workspace.draftRevision } : {}),
      added: variants.filter((variant) => !run.items.some((item) => item.variantId === variant.id) &&
        effectTemplateMixPlacedContentDuration(variant, packaging.get(variant.id)) > 0).map((variant) => {
          const duration = effectTemplateMixPlacedContentDuration(variant, packaging.get(variant.id));
          let cover: FinalOutputRun['items'][number]['cover'] = null;
          let blockedReason: string | undefined;
          try {
            const changes = effectTemplateMixSourceChanges(variant, workspace!.materials);
            if (changes.length) throw new ConflictException(changes[0]?.blockedReason ?? '素材来源已变化，请先在混剪节点局部更新');
            const clips = this.liveClips(variant, workspace!.materials, artifacts as WorkingArtifact[]);
            const first = [...clips].sort((a, b) => a.start - b.start)[0];
            if (first) cover = { fileObjectId: first.fileObjectId, time: first.offset + .12,
              contentHash: first.contentHash };
            if (!Number.isFinite(duration) || duration > EFFECT_TEMPLATE_MIX_MAX_CONTENT_SECONDS)
              throw new ConflictException('成片时长超过容量上限');
          } catch (error) {
            blockedReason = error instanceof BadRequestException || error instanceof ConflictException
              ? error.message : '工程素材来源无法确认，请在混剪节点检查';
          }
          return { variantId: variant.id, name: variant.name, duration, cover,
            ...(blockedReason ? { blockedReason } : {}) };
        }),
      removedItemIds: run.items.filter((item) => !variants.some((variant) => variant.id === item.variantId))
        .map((item) => item.id),
    };
  }

  private toDto(
    run: Prisma.EffectFinalOutputRunGetPayload<{ include: typeof include }>,
    templateName?: string,
    artifacts: ArtifactRow[] = [],
    workspace?: Pick<EffectTemplateMixWorkspaceData, 'draft' | 'materials'> &
      Partial<Pick<EffectTemplateMixWorkspaceData, 'draftRevision'>>,
    packaging: ReadonlyMap<string, PackagingCheckpoint> = new Map(),
  ): FinalOutputRun {
    const projectChanges = this.projectMembership(run, artifacts, workspace, packaging);
    const staleItemIds = new Set(
      hasOutputVersion(artifacts) && !['QUEUED', 'RUNNING'].includes(run.status)
        ? run.items.filter((item) => (Boolean(item.fileObjectId && item.assetId) &&
          this.draftDiffersFromSnapshot(run.templateId, item, artifacts as WorkingArtifact[],
            workspace, packaging.get(item.variantId))) ||
          projectChanges?.removedItemIds.includes(item.id) ||
          (['FAILED', 'CANCELLED'].includes(item.status) && Boolean((item.snapshot as unknown as FinalOutputSnapshot).sourceDraft)))
          .map((item) => item.id)
        : [],
    );
    const delivery = artifacts.find((artifact) =>
      artifact.nodeId === 'FINAL_OUTPUT' &&
      artifact.artifactKey === `final-delivery:${run.templateId}` &&
      artifact.availability === 'AVAILABLE',
    );
    const payload = delivery?.payload as
      | { runId?: string; resolution?: FinalOutputRun['resolution']; frameRate?: FinalOutputRun['frameRate'];
          items?: Array<{ id: string; fileObjectId: string; assetId: string }> }
      | undefined;
    const delivered = new Map(
      Array.isArray(payload?.items) ? payload.items.map((item) => [item.id, item] as const) : [],
    );
    const validated = run.status === 'COMPLETED' &&
      payload?.runId === run.id && delivered.size === run.items.length &&
      run.items.every((item) =>
        item.status === 'COMPLETED' &&
        delivered.get(item.id)?.fileObjectId === item.fileObjectId &&
        delivered.get(item.id)?.assetId === item.assetId,
      );
    return {
      id: run.id,
      ...(() => {
        const operation = (run.items[0]?.snapshot as unknown as FinalOutputSnapshot | undefined)?.sourceOperation;
        return operation ? { sourceOperationId: operation.id,
          sourceOperationHasAdditions: operation.addedMaterialIds.length > 0 } : {};
      })(),
      templateId: run.templateId,
      templateName: templateName || `模板 ${run.templateId.slice(0, 8)}`,
      validated,
      ...(projectChanges ? { projectChanges } : {}),
      resolution: (run.items[0]?.snapshot as unknown as FinalOutputSnapshot | undefined)?.resolution ??
        (payload?.resolution && FINAL_OUTPUT_RESOLUTIONS.includes(payload.resolution) ? payload.resolution : '720p'),
      frameRate: (run.items[0]?.snapshot as unknown as FinalOutputSnapshot | undefined)?.frameRate ??
        (payload?.frameRate && ([24, 25, 30, 50, 60] as const).includes(payload.frameRate) ? payload.frameRate : 30),
      workflowRunId: run.workflowRunId,
      status: run.status as FinalOutputRun['status'],
      createdAt: run.createdAt.toISOString(),
      items: [...run.items]
        .sort(
          (a, b) =>
            a.name.localeCompare(b.name, 'zh-CN', { numeric: true }) || a.id.localeCompare(b.id),
        )
        .map((i) => {
          const snapshot = i.snapshot as unknown as FinalOutputSnapshot;
          const firstBoundSlot = snapshot.timeline.variant.slots.find(
            ({ id }) => Boolean(snapshot.timeline.variant.bindings[id]),
          );
          const coverClip = (firstBoundSlot
            ? snapshot.timeline.clips.find((clip) => clip.slotId === firstBoundSlot.id)
            : undefined) ?? [...snapshot.timeline.clips].sort((a, b) => a.start - b.start)[0];
          return {
            id: i.id,
            variantId: i.variantId,
            name: i.name,
            cover: coverClip ? {
              fileObjectId: coverClip.fileObjectId,
              time: 0.12,
              contentHash: coverClip.contentHash,
            } : null,
            status: i.status as FinalOutputRun['status'],
            duration: snapshot.timeline.duration,
            progress: i.progress,
            errorMessage: i.errorMessage,
            fileObjectId: i.fileObjectId,
            assetId: i.assetId,
            unpackaged: Boolean((i.snapshot as unknown as FinalOutputSnapshot).unpackaged),
            currentPackagingReady: packaging.get(i.variantId)?.narrationLayoutVersion === 'SLOT_V1',
            stale: staleItemIds.has(i.id),
          };
        }),
      counts: {
        total: run.items.length,
        queued: run.items.filter((i) => ['PENDING_RENDER', 'QUEUED'].includes(i.status)).length,
        running: run.items.filter((i) => i.status === 'RUNNING').length,
        completed: run.items.filter((i) => i.status === 'COMPLETED').length,
        failed: run.items.filter((i) => ['FAILED', 'CANCELLED'].includes(i.status)).length,
        stale: new Set([...staleItemIds, ...(projectChanges?.removedItemIds ?? [])]).size +
          (projectChanges?.added.length ?? 0),
      },
    };
  }

  async get(projectId: string, id: string): Promise<FinalOutputRun> {
    const run = await this.db.effectFinalOutputRun.findFirst({ where: { projectId, id }, include });
    if (!run) throw new NotFoundException('成片输出任务不存在');
    const workspace = await this.mix.workspace(projectId, run.workflowRunId);
    const artifacts = await this.working.listArtifacts(projectId, { workflowRunId: run.workflowRunId });
    const packaging = await this.packagingByVariant(projectId, run.workflowRunId, [run.templateId]);
    const templateName = workspace.draft?.templates.find((entry) => entry.id === run.templateId)
      ?.workspace.template.name;
    const result = this.toDto(run, templateName, artifacts, workspace, packaging);
    if (result.sourceOperationId) {
      const appended = await this.db.effectTemplateMixAiRun.findFirst({ where: { projectId,
        workflowRunId: run.workflowRunId, templateId: run.templateId,
        inputSnapshot: { path: ['sourceOperation', 'id'], equals: result.sourceOperationId } }, select: { id: true } });
      result.sourceOperationAppendStarted = Boolean(appended);
    }
    return result;
  }
  async list(projectId: string, workflowRunId: string) {
    const load = () => this.loadList(projectId, workflowRunId);
    return this.readCache ? this.readCache.read({ projectId, workflowRunId }, 'output', load) : load();
  }

  private async loadList(projectId: string, workflowRunId: string) {
    const tree = await this.branches.getEffectBranchTree(projectId);
    // A rendering child remains invisible in the tree until success, but its progress must stay
    // visible in the output page. Only its own template overrides the published parent tips.
    const hidden = tree.branches.some((branch) => branch.workflowRunId === workflowRunId) ? null :
      await this.db.workflowRun.findFirst({ where: {
        projectId, id: workflowRunId, workflow: 'EFFECT', workflowSpace: 'EFFECT',
      }, select: { id: true, parentWorkflowRunId: true, forkNodeId: true, forkTemplateId: true } });
    const contextId = hidden?.parentWorkflowRunId ?? workflowRunId;
    const tips = effectTemplateBranchTips(tree.branches, contextId, { current: true });
    if (hidden?.forkNodeId === 'FINAL_OUTPUT' && hidden.forkTemplateId) {
      const parent = tree.branches.find((branch) => branch.workflowRunId === contextId);
      if (parent) tips.set(hidden.forkTemplateId, { ...parent, workflowRunId });
    }
    const pathTemplates = new Map<string, Set<string>>();
    for (const [templateId, tip] of tips) {
      const ids = pathTemplates.get(tip.workflowRunId) ?? new Set<string>();
      ids.add(templateId);
      pathTemplates.set(tip.workflowRunId, ids);
    }
    // Each template tip may live on a different path. Share this request's raw lineage/catalog
    // reads, not a cross-request cache; every path still applies its own fork and nearest-batch rules.
    const catalog = pathTemplates.size > 1
      ? await this.readOutputPathCatalog(projectId, [...pathTemplates.keys()]) : undefined;
    const paths = new Map(await Promise.all([...pathTemplates]
      .map(async ([id, ids]) => [id, catalog
        ? await this.listPath(projectId, id, ids, catalog)
        : await this.listPath(projectId, id, ids)] as const)));
    const current = [...tips].flatMap(([templateId, tip]) =>
      (paths.get(tip.workflowRunId) ?? []).filter((batch) => batch.templateId === templateId));
    // Progress of an independent export survives refresh without replacing the source delivery.
    // Pair both parent and template: a sibling's task must never leak into another template path.
    const children = await this.db.workflowRun.findMany({ where: {
      projectId, workflow: 'EFFECT', workflowSpace: 'EFFECT', forkNodeId: 'FINAL_OUTPUT',
      editSessionNodeId: null,
      OR: [...tips].map(([templateId, tip]) => ({ parentWorkflowRunId: tip.workflowRunId,
        forkTemplateId: templateId })),
    }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { id: true, parentWorkflowRunId: true, forkTemplateId: true, branchPublishedAt: true } });
    const seen = new Set<string>();
    const exports: FinalOutputRun[] = [];
    for (const child of children) {
      if (!child.forkTemplateId || !child.parentWorkflowRunId ||
        tips.get(child.forkTemplateId)?.workflowRunId !== child.parentWorkflowRunId ||
        seen.has(child.forkTemplateId)) continue;
      seen.add(child.forkTemplateId);
      const batches = await this.listPath(projectId, child.id, new Set([child.forkTemplateId]));
      const batch = batches.find((entry) => entry.workflowRunId === child.id);
      if (batch) exports.push({ ...batch, backgroundExportSourceRunId: child.parentWorkflowRunId,
        backgroundExportPublished: Boolean(child.branchPublishedAt) });
    }
    return [...current, ...exports];
  }

  async exportProgress(projectId: string, sourceWorkflowRunId: string,
    templateId: string): Promise<FinalOutputExportProgress | null> {
    const child = await this.db.workflowRun.findFirst({ where: {
      projectId, workflow: 'EFFECT', workflowSpace: 'EFFECT',
      parentWorkflowRunId: sourceWorkflowRunId, forkNodeId: 'FINAL_OUTPUT',
      forkTemplateId: templateId, editSessionNodeId: null,
    }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: {
      id: true, branchPublishedAt: true,
      effectFinalOutputRuns: { where: { projectId, templateId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 1, select: {
          id: true, workflowRunId: true, templateId: true, status: true, createdAt: true,
          items: { select: { id: true, variantId: true, status: true, progress: true,
            fileObjectId: true, assetId: true, errorMessage: true } },
        } },
    } });
    const batch = child?.effectFinalOutputRuns[0];
    if (!batch) return null;
    const items = batch.items.map((item) => ({ ...item,
      status: item.status as FinalOutputStatus }));
    const count = (status: FinalOutputStatus) => items.filter((item) => item.status === status).length;
    return {
      id: batch.id, workflowRunId: batch.workflowRunId,
      backgroundExportSourceRunId: sourceWorkflowRunId,
      backgroundExportPublished: Boolean(child.branchPublishedAt),
      templateId: batch.templateId, createdAt: batch.createdAt.toISOString(),
      status: batch.status as FinalOutputStatus,
      counts: { total: items.length, queued: count('QUEUED') + count('PENDING_RENDER'),
        running: count('RUNNING'), completed: count('COMPLETED'),
        failed: count('FAILED') + count('CANCELLED') },
      items,
    };
  }

  private async readOutputPathCatalog(projectId: string, pathIds: readonly string[]): Promise<OutputPathCatalog> {
    const branches = await this.db.workflowRun.findMany({ where: {
      projectId, workflow: 'EFFECT', workflowSpace: 'EFFECT',
    }, select: { id: true, parentWorkflowRunId: true, forkNodeId: true, forkTemplateId: true } });
    const byId = new Map(branches.map((branch) => [branch.id, branch]));
    const ids = new Set<string>();
    for (const pathId of pathIds) {
      let cursor: string | null = pathId;
      while (cursor && !ids.has(cursor)) {
        const branch = byId.get(cursor);
        if (!branch) break;
        ids.add(cursor);
        cursor = branch.parentWorkflowRunId;
      }
    }
    const rows = ids.size ? await this.db.effectFinalOutputRun.findMany({
      where: { projectId, workflowRunId: { in: [...ids] } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], include,
    }) : [];
    return { branches, rows };
  }

  /** Read one exact path, preserving fork boundaries and historical deliveries. */
  async listPath(projectId: string, workflowRunId: string, templateIds?: ReadonlySet<string>, catalog?: OutputPathCatalog) {
    const lineage: Array<{ id: string; forkNodeId: string | null; forkTemplateId: string | null }> = [];
    const branches = catalog?.branches ?? await this.db.workflowRun.findMany({ where: {
      projectId, workflow: 'EFFECT', workflowSpace: 'EFFECT',
    }, select: { id: true, parentWorkflowRunId: true, forkNodeId: true,
      forkTemplateId: true } });
    const byId = new Map(branches.map((branch) => [branch.id, branch]));
    const visited = new Set<string>();
    let cursor: string | null = workflowRunId;
    while (cursor && !visited.has(cursor)) {
      visited.add(cursor);
      const branch = byId.get(cursor);
      if (!branch) break;
      lineage.push(branch);
      cursor = branch.parentWorkflowRunId;
    }
    if (!lineage.length) return [];
    const lineageIds = new Set(lineage.map((branch) => branch.id));
    const rows = catalog ? catalog.rows.filter((row) => lineageIds.has(row.workflowRunId)) : await this.db.effectFinalOutputRun.findMany({
      where: { projectId, workflowRunId: { in: lineage.map((branch) => branch.id) } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], include,
    });
    const byRun = new Map<string, typeof rows>();
    for (const row of rows) {
      const grouped = byRun.get(row.workflowRunId) ?? [];
      grouped.push(row);
      byRun.set(row.workflowRunId, grouped);
    }
    // A template's most recent batch on this path wins. Forking that template hides its older
    // batches; forking a different template must not make its existing films disappear.
    const blocked = new Set<string>();
    const selected = [] as typeof rows;
    for (const branch of lineage) {
      for (const row of byRun.get(branch.id) ?? []) {
        if (blocked.has(row.templateId)) continue;
        selected.push(row);
        blocked.add(row.templateId);
      }
      if (branch.forkNodeId === 'TEMPLATE_MIX' || branch.forkNodeId === 'FINAL_OUTPUT') {
        // Older mix forks predate forkTemplateId. Their own output batch still identifies the
        // template they changed; never treat a null scope as a reason to lose other templates.
        const outputTemplateIds = [...new Set((byRun.get(branch.id) ?? [])
          .map((row) => row.templateId))];
        let forkTemplateId = branch.forkTemplateId ??
          (outputTemplateIds.length === 1 ? outputTemplateIds[0] : null);
        if (!forkTemplateId && branch.forkNodeId === 'TEMPLATE_MIX') {
          const local = await this.db.workingArtifact.findMany({ where: {
            projectId, workflowRunId: branch.id, nodeId: 'TEMPLATE_MIX',
          }, select: { artifactKey: true } });
          const ids = [...new Set(local.map((artifact) =>
            /^(?:mix-template|timeline-project|timeline-package):([^:]+)/.exec(
              artifact.artifactKey)?.[1]).filter((id): id is string => Boolean(id)))];
          forkTemplateId = ids.length === 1 ? ids[0]! : null;
        }
        if (forkTemplateId) blocked.add(forkTemplateId);
        else break;
      } else if (branch.forkNodeId && branch.forkNodeId !== 'MANUAL_COPY') {
        break;
      }
    }
    // Resolve lineage with the complete catalog first (legacy forks infer their template from it),
    // but compute freshness only for templates whose current tip is this path. Other paths will
    // read their own templates; projecting all inherited films here duplicates expensive reads.
    const visible = templateIds ? selected.filter((row) => templateIds.has(row.templateId)) : selected;
    if (!visible.length) return [];
    // Pending films are not delivered versions, so their DTO needs only a template name and
    // the stored picture snapshot, not every ancestor's full mix workspace.
    const pendingWorkspace = visible.some((row) => row.status === 'PENDING_RENDER')
      ? await this.mix.outputSourceWorkspace(projectId, workflowRunId, false) : null;
    const pendingNames = new Map(pendingWorkspace?.draft?.templates.map((entry) =>
      [entry.id, entry.workspace.template.name]) ?? []);
    const completed = visible.filter((row) => row.status !== 'PENDING_RENDER' ||
      (row.items.some((item) => (item.snapshot as unknown as FinalOutputSnapshot).appendOnly) &&
       row.items.some((item) => item.status === 'COMPLETED')));
    const sourceIds = [...new Set(completed.map((row) => row.workflowRunId))];
    const contexts = new Map(await Promise.all(sourceIds.map(async (sourceId) => {
      const sourceRows = completed.filter((row) => row.workflowRunId === sourceId);
      const [workspace, packaging] = await Promise.all([
        this.mix.outputSourceWorkspace(projectId, sourceId),
        this.packagingByVariant(projectId, sourceId,
          sourceRows.map((row) => row.templateId)),
      ]);
      const artifacts = workspace.artifacts;
      const names = new Map(workspace.draft?.templates.map((entry) =>
        [entry.id, entry.workspace.template.name]) ?? []);
      return [sourceId, { workspace, artifacts, packaging, names }] as const;
    })));
    return visible.map((row) => {
      if (row.status === 'PENDING_RENDER' && !completed.includes(row))
        return this.toDto(row, pendingNames.get(row.templateId));
      const source = contexts.get(row.workflowRunId)!;
      return this.toDto(row, source.names.get(row.templateId), source.artifacts,
        source.workspace, source.packaging);
    });
  }
  async claim(projectId: string, id: string) {
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM effect_final_output_runs WHERE id=${id}::uuid AND "projectId"=${projectId}::uuid FOR UPDATE`;
      const run = await tx.effectFinalOutputRun.findFirst({ where: { projectId, id }, include });
      if (
        !run ||
        !['QUEUED', 'RUNNING'].includes(run.status) ||
        (run.status === 'RUNNING' && run.leaseExpiresAt && run.leaseExpiresAt > new Date())
      )
        return { terminal: true };
      this.logger.log(
        JSON.stringify({
          event: 'final_output_claim',
          projectId,
          runId: id,
          queueWaitMs: run.status === 'QUEUED' ? Date.now() - run.updatedAt.getTime() : null,
          recoveryWaitMs:
            run.status === 'RUNNING' && run.leaseExpiresAt
              ? Math.max(0, Date.now() - run.leaseExpiresAt.getTime())
              : null,
        }),
      );
      const attemptToken = randomUUID();
      await tx.effectFinalOutputRun.update({
        where: { id },
        data: { status: 'RUNNING', attemptToken, leaseExpiresAt: lease() },
      });
      await tx.effectFinalOutputItem.updateMany({
        where: { projectId, runId: id, status: { in: ['QUEUED', 'RUNNING'] } },
        data: { status: 'QUEUED', progress: 0, errorMessage: null },
      });
      return {
        terminal: false,
        attemptToken,
        items: run.items.map((item) =>
          ['QUEUED', 'RUNNING'].includes(item.status) ? { ...item, status: 'QUEUED' } : item,
        ),
      };
    });
  }
  async heartbeat(
    projectId: string,
    id: string,
    token: string,
    tx: Prisma.TransactionClient = this.db,
  ) {
    if (!token) throw new ConflictException('输出租约已失效');
    const result = await tx.effectFinalOutputRun.updateMany({
      where: {
        id,
        projectId,
        status: 'RUNNING',
        attemptToken: token,
        leaseExpiresAt: { gt: new Date() },
      },
      data: { leaseExpiresAt: lease() },
    });
    if (!result.count) throw new ConflictException('输出租约已失效');
    return { accepted: true };
  }
  private async current(
    tx: Prisma.TransactionClient,
    projectId: string,
    snapshot: FinalOutputSnapshot,
  ) {
    const duration = snapshot.timeline.duration;
    if (!Number.isFinite(duration) || duration <= 0 || duration > EFFECT_TEMPLATE_MIX_MAX_CONTENT_SECONDS)
      throw new ConflictException('成片实际时长无效');
    const tracks = [...snapshot.timeline.clips, ...(snapshot.timeline.detachedAudios ?? []),
      ...Object.values(snapshot.packaging?.voices ?? {}), ...Object.values(snapshot.packaging?.captionVoices ?? {}),
      ...(snapshot.packaging?.music ? [snapshot.packaging.music] : [])];
    if (tracks.some((track) => !Number.isFinite(track.start) || track.start < 0 ||
      !Number.isFinite(track.duration) || track.duration <= 0 || track.start + track.duration > duration + .001 ||
      (track.offset !== undefined && (!Number.isFinite(track.offset) || track.offset < 0)) ||
      ('sourceDuration' in track && (typeof track.sourceDuration !== 'number' ||
        !Number.isFinite(track.sourceDuration) || (track.offset ?? 0) + track.duration > track.sourceDuration + .001))) ||
      snapshot.packaging?.captions?.some((caption) => !Number.isFinite(caption.start) ||
        !Number.isFinite(caption.end) || caption.start < 0 || caption.end <= caption.start || caption.end > duration + .001))
      throw new ConflictException('成片素材或字幕的时间范围无效');
    if (snapshot.sourceRefresh) await this.assertRefreshCurrent(tx, projectId, snapshot);
    // A film confirmed without a package carries an intentionally empty one: no narration layout,
    // no captions, no bed. The slot rules describe a narrated package and would reject it, so keep
    // a small structural check here; all frozen source files are checked for availability below.
    if (snapshot.unpackaged) {
      if (
        !snapshot.packaging ||
        typeof snapshot.packaging.voices !== 'object' ||
        snapshot.packaging.voices === null ||
        !Array.isArray(snapshot.packaging.captions)
      )
        throw new ConflictException('无包装成片的结构无效');
    } else if (
      !snapshot.packaging ||
      typeof snapshot.packaging.voices !== 'object' ||
      snapshot.packaging.voices === null ||
      !Array.isArray(snapshot.packaging.captions)
    ) throw new ConflictException('成片包装结构无效');
    // Rendering checks that frozen media files still exist, but it does not compare the user's
    // current edit with the earlier packaging snapshot or second-guess their creative choice.
    const ids = [
      ...new Set([
        ...snapshot.timeline.clips.map((c) => c.fileObjectId),
        ...(snapshot.timeline.detachedAudios ?? []).map((a) => a.fileObjectId),
        ...audioIds(snapshot.packaging),
      ]),
    ];
    // Scoped to the project, never to the output run: exporting opens a branch, and a branch's
    // frozen sources still belong to the ancestor run that imported or packaged them.
    if (
      (await tx.fileObject.count({
        where: { projectId, id: { in: ids }, status: 'AVAILABLE' },
      })) !== ids.length
    )
      throw new ConflictException('输出源文件不可用');
  }
  private async assertRefreshCurrent(tx: Prisma.TransactionClient, projectId: string, snapshot: FinalOutputSnapshot) {
    const refresh = snapshot.sourceRefresh!;
    const state = await tx.workflowNodeState.findUnique({ where: { projectId_workflowRunId_nodeId: {
      projectId, workflowRunId: refresh.workflowRunId, nodeId: 'TEMPLATE_MIX',
    } } });
    const draft = state?.state as unknown as EffectTemplateMixWorkspaceData['draft'];
    const entry = draft?.templates.find((entry) => entry.id === refresh.templateId);
    const variant = entry?.workspace.variants
      .find((entry) => entry.id === refresh.baselineVariant.id);
    const engineeringHash = (value: EffectTemplateMixVariant) => {
      const { bindingSources: _derived, ...engineering } = value;
      return workflowStateHash(engineering);
    };
    if (!variant || engineeringHash(variant) !== engineeringHash(refresh.baselineVariant) ||
        (refresh.templateHash && workflowStateHash(entry!.workspace.template) !== refresh.templateHash))
      throw new ConflictException('该成片工程已被编辑，请重新发起局部更新');
    const sources = await tx.workingArtifact.findMany({ where: { projectId, nodeId: 'SEGMENT_RENDER',
      id: { in: [...new Set(Object.values(snapshot.timeline.variant.bindings))] } } });
    if (refresh.protocol === 'FROZEN_RENDER_V1') {
      // Render revisions may advance during paid work. The immutable project files, not
      // mutable artifact rows, authorize this operation's frozen input. Other fences remain.
      const files = await tx.fileObject.findMany({ where: { projectId,
        id: { in: [...new Set(snapshot.timeline.clips.map((clip) => clip.fileObjectId))] }, status: 'AVAILABLE' } });
      for (const clip of snapshot.timeline.clips) {
        const file = files.find((file) => file.id === clip.fileObjectId);
        if (!file || file.sha256 !== clip.contentHash)
          throw new ConflictException('局部更新冻结的素材文件不可用或指纹不一致');
      }
    }
    if (refresh.protocol !== 'FROZEN_RENDER_V1') {
    for (const clip of snapshot.timeline.clips) {
      const source = sources.find((source) => source.id === snapshot.timeline.variant.bindings[clip.slotId]);
      const payload = source?.payload as { fileObjectId?: string; contentHash?: string } | undefined;
      if (!source || source.revision !== snapshot.timeline.variant.bindingRevisions[clip.slotId] ||
          source.freshness !== 'CURRENT' || source.availability !== 'AVAILABLE' ||
          payload?.fileObjectId !== clip.fileObjectId || payload?.contentHash !== clip.contentHash)
        throw new ConflictException('素材再次发生变化，请重新发起局部更新');
    }
    // A fork's frozen copy can still be CURRENT even after its shared render source changed.
    // Check the authoritative same-lineage head before any paid refresh work, not only when
    // committing the final artifact. Matching IDs/revisions on that old copy are insufficient.
    const heads = await new WorkflowWorkingRepository(tx as unknown as PrismaService)
      .listArtifacts(projectId, { workflowRunId: refresh.workflowRunId, nodeId: 'SEGMENT_RENDER' });
    for (const source of sources) {
      const media = source.payload as { promptId?: string; fileObjectId?: string } | null;
      if (!media?.promptId || !media.fileObjectId) continue;
      const files = new Set(heads.flatMap((head) => {
        const current = head.payload as { promptId?: string; fileObjectId?: string } | null;
        return head.freshness === 'CURRENT' && head.availability === 'AVAILABLE' &&
          (head.metadata as { branchSourceOwner?: boolean } | null)?.branchSourceOwner === true &&
          current && current.promptId === media.promptId && current.fileObjectId ? [current.fileObjectId] : [];
      }));
      if (files.size && !files.has(media.fileObjectId))
        throw new ConflictException('素材已有更新版本，不能回退到旧素材；请重新发起局部更新');
    }
    for (const batch of refresh.sourceBatches ?? []) {
      const current = await tx.workingArtifact.findFirst({ where: { projectId, id: batch.artifactId,
        revision: batch.revision, contentHash: batch.contentHash, freshness: 'CURRENT', availability: 'AVAILABLE' } });
      if (!current) throw new ConflictException('素材批次再次发生变化，请重新发起局部更新');
    }
    }
    for (const dependency of snapshot.timeline.dependencies.filter((source) => source.nodeId !== 'SEGMENT_RENDER')) {
      const current = await tx.workingArtifact.findFirst({ where: { projectId, id: dependency.artifactId,
        ...(refresh.protocol === 'FROZEN_RENDER_V1' && dependency.nodeId !== 'TEMPLATE_MIX' ? {} : {
          revision: dependency.revision, contentHash: dependency.contentHash,
          freshness: 'CURRENT', availability: 'AVAILABLE',
        }) } });
      if (!current) throw new ConflictException('素材所依赖的商品事实或 Prompt 已变化，请重新发起局部更新');
    }
    const latest = await tx.effectPackagingItem.findFirst({ where: { projectId,
        variantId: refresh.baselineVariant.id,
        run: { workflowRunId: refresh.workflowRunId, templateId: refresh.templateId },
      }, orderBy: [{ run: { createdAt: 'desc' } }, { id: 'desc' }] });
    if (refresh.packagingItemId ? (latest?.id !== refresh.packagingItemId || latest.status !== 'COMPLETED' ||
          workflowStateHash(latest.checkpoint) !== workflowStateHash(refresh.baselinePackaging)) : Boolean(latest))
        throw new ConflictException('该成片包装已被修改，请重新发起局部更新');
  }

  async refreshTrims(projectId: string, runId: string, token: string, itemId: string,
    trims: { slotId: string; offset: number }[]) {
    await this.workerItem(projectId, runId, token, itemId);
    return this.db.$transaction(async (tx) => {
      await this.heartbeat(projectId, runId, token, tx);
      await tx.$queryRaw`SELECT id FROM effect_final_output_items WHERE id=${itemId}::uuid AND "projectId"=${projectId}::uuid FOR UPDATE`;
      const item = await tx.effectFinalOutputItem.findFirstOrThrow({ where: { id: itemId, projectId, runId } });
      const snapshot = item.snapshot as unknown as FinalOutputSnapshot;
      const refresh = snapshot.sourceRefresh;
      if (!refresh) throw new ConflictException('当前任务不是素材局部更新');
      await this.assertRefreshCurrent(tx, projectId, snapshot);
      if (refresh.trimsReady) return { snapshot };
      if (!Array.isArray(trims) || trims.length !== refresh.slots.length ||
          new Set(trims.map((trim) => trim.slotId)).size !== trims.length)
        throw new BadRequestException('截取结果缺失或重复');
      for (const trim of trims) {
        const changed = refresh.slots.find((row) => row.slotId === trim.slotId);
        const clip = snapshot.timeline.clips.find((clip) => clip.slotId === trim.slotId);
        if (!changed || !clip || !Number.isFinite(trim.offset) || trim.offset < 0 ||
            trim.offset + clip.duration > changed.material.duration + .001)
          throw new BadRequestException('模型截取区间超出素材长度');
        snapshot.timeline.variant.offsets[trim.slotId] = trim.offset;
        clip.offset = trim.offset;
        for (const audio of snapshot.timeline.variant.detachedAudios ?? [])
          if (audio.sourceSlotId === trim.slotId) audio.offset = trim.offset;
      }
      snapshot.timeline.detachedAudios = snapshot.timeline.variant.detachedAudios ?? [];
      snapshot.timeline.sourceTimelineHash = visualHash(snapshot.timeline.variant);
      snapshot.timeline.redoSlotIds = refresh.slots.map((row) => row.slotId);
      snapshot.timeline.preserveMusic = true;
      snapshot.packaging = withoutChangedSlots(snapshot.packaging, snapshot.timeline.redoSlotIds);
      refresh.trimsReady = true;
      refresh.ready = Boolean(snapshot.unpackaged || refresh.slots.every((row) =>
        snapshot.timeline.clips.find((clip) => clip.slotId === row.slotId)?.overlay));
      await tx.effectFinalOutputItem.update({ where: { id: itemId }, data: { snapshot: json(snapshot), progress: 10 } });
      return { snapshot };
    });
  }

  async refreshCheckpoint(projectId: string, runId: string, token: string, itemId: string,
    stage: string, patch: PackagingCheckpoint) {
    await this.workerItem(projectId, runId, token, itemId);
    return this.db.$transaction(async (tx) => {
      await this.heartbeat(projectId, runId, token, tx);
      await tx.$queryRaw`SELECT id FROM effect_final_output_items WHERE id=${itemId}::uuid AND "projectId"=${projectId}::uuid FOR UPDATE`;
      const item = await tx.effectFinalOutputItem.findFirstOrThrow({ where: { id: itemId, projectId, runId } });
      const snapshot = item.snapshot as unknown as FinalOutputSnapshot;
      if (!snapshot.sourceRefresh?.trimsReady) throw new ConflictException('尚未完成素材选区');
      await this.assertRefreshCurrent(tx, projectId, snapshot);
      const cp = { ...snapshot.packaging, ...patch,
        voices: { ...snapshot.packaging.voices, ...patch.voices } };
      validateRefreshCheckpoint(snapshot, cp, stage === 'READY');
      if (stage === 'READY') {
        for (const { slotId } of snapshot.sourceRefresh.slots) {
          if (snapshot.timeline.clips.find((clip) => clip.slotId === slotId)?.overlay) continue;
          const line = cp.script?.find((line) => line.slotId === slotId);
          const voice = line && cp.voices?.[line.id];
          if (!line || !voice || voice.start !== line.start || voice.start + voice.duration > line.end + .001)
            throw new ConflictException('更新槽位的口播未完成或超出槽位');
          const oldLine = snapshot.sourceRefresh.baselinePackaging.script?.find((row) => row.slotId === slotId);
          const lanes = snapshot.timeline.variant.audioLanes;
          if (oldLine && lanes && lanes[`voice:${oldLine.id}`] !== undefined && oldLine.id !== line.id) {
            lanes[`voice:${line.id}`] = lanes[`voice:${oldLine.id}`]!;
            delete lanes[`voice:${oldLine.id}`];
          }
        }
        snapshot.sourceRefresh.ready = true;
      }
      snapshot.sourceRefresh.stage = stage;
      snapshot.packaging = cp;
      snapshot.timeline.duration = effectTemplateMixContentDuration(snapshot.timeline.variant, cp);
      await tx.effectFinalOutputItem.update({ where: { id: itemId }, data: { snapshot: json(snapshot), progress: stage === 'READY' ? 25 : 15 } });
      return { accepted: true, snapshot };
    });
  }

  async refreshAudio(projectId: string, runId: string, token: string, itemId: string, role: string,
    file?: { path: string; size: number }, segmentFramesJson?: string, speechRangesJson?: string) {
    const { item, snapshot } = await this.workerItem(projectId, runId, token, itemId);
    const line = snapshot.packaging.script?.find((line) => `voice-${line.id}` === role);
    if (!snapshot.sourceRefresh?.trimsReady || !line ||
        !snapshot.sourceRefresh.slots.some((row) => row.slotId === line.slotId) ||
        !file || file.size > 100 * 1024 * 1024) throw new BadRequestException('局部更新音频来源无效');
    const duration = await wavDuration(file.path, file.size);
    const segmentFrames = parseVoiceSegmentFrames(segmentFramesJson, duration);
    const speechRanges = parseVoiceSpeechRanges(speechRangesJson, duration);
    if (!speechRanges) throw new BadRequestException('本次配音缺少字词时间戳，不能严格对齐字幕');
    if (line.start + duration > line.end + .001) throw new BadRequestException('口播音频超出槽位');
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file.path)) hash.update(chunk);
    const sha256 = hash.digest('hex');
    const saved = snapshot.sourceRefresh.uploadedAudios?.[role];
    if (saved) {
      if (saved.sha256 !== sha256) throw new ConflictException('同一句口播已保存，不能替换重试结果');
      return { fileObjectId: saved.fileObjectId };
    }
    const project = await this.db.project.findUniqueOrThrow({ where: { id: projectId } });
    const stored = await this.storage.put({ projectId, stream: createReadStream(file.path), sizeBytes: file.size,
      contentType: 'audio/wav', keyContext: { projectName: project.name, workflow: 'effect', lifecycle: 'staging',
        category: 'timeline-package', originalFileName: `${itemId}-${role}.wav` } });
    try {
      const result = await this.db.$transaction(async (tx) => {
        await this.heartbeat(projectId, runId, token, tx);
        await tx.$queryRaw`SELECT id FROM effect_final_output_items WHERE id=${itemId}::uuid AND "projectId"=${projectId}::uuid FOR UPDATE`;
        const current = await tx.effectFinalOutputItem.findFirstOrThrow({ where: { id: itemId, projectId, runId } });
        const next = current.snapshot as unknown as FinalOutputSnapshot;
        await this.assertRefreshCurrent(tx, projectId, next);
        const existing = next.sourceRefresh!.uploadedAudios?.[role];
        if (existing) {
          if (existing.sha256 !== sha256) throw new ConflictException('同一句口播已保存');
          return { fileObjectId: existing.fileObjectId, duplicate: true };
        }
        const created = await tx.fileObject.create({ data: { projectId, workflowRunId: item.run.workflowRunId,
          nodeId: 'TEMPLATE_MIX', originalFileName: `${itemId}-${role}.wav`, mimeType: 'audio/wav',
          sizeBytes: file.size, storageKey: stored.key, sha256 } });
        next.sourceRefresh!.uploadedAudios = { ...next.sourceRefresh!.uploadedAudios,
          [role]: { fileObjectId: created.id, sha256, duration, ...(segmentFrames ? { segmentFrames } : {}), speechRanges } };
        next.packaging.voices = { ...next.packaging.voices, [line.id]: {
          fileObjectId: created.id, duration, start: line.start, volume: 1,
          ...(segmentFrames ? { segmentFrames } : {}),
          speechRanges,
          ...(next.timeline.voiceProfile ? { voiceProfile: next.timeline.voiceProfile } : {}),
        } };
        await tx.effectFinalOutputItem.update({ where: { id: itemId }, data: { snapshot: json(next) } });
        return { fileObjectId: created.id, duplicate: false };
      });
      if (result.duplicate) await this.storage.delete(stored.key).catch(() => undefined);
      return { fileObjectId: result.fileObjectId };
    } catch (error) {
      await this.storage.delete(stored.key).catch(() => undefined);
      throw error;
    }
  }

  private async workerItem(projectId: string, runId: string, token: string, itemId: string) {
    await this.heartbeat(projectId, runId, token);
    const item = await this.db.effectFinalOutputItem.findFirst({
      where: { id: itemId, projectId, runId },
      include: { run: true },
    });
    if (!item) throw new NotFoundException('输出条目不存在');
    const snapshot = item.snapshot as unknown as FinalOutputSnapshot;
    if (item.status !== 'COMPLETED') await this.assertOutputDraft(this.db, projectId, snapshot);
    await this.current(this.db, projectId, snapshot);
    return { item, snapshot };
  }
  private async assertOutputDraft(tx: Prisma.TransactionClient, projectId: string, snapshot: FinalOutputSnapshot) {
    const source = snapshot.sourceDraft;
    if (!source) return; // Historical/full-export snapshots retain their frozen semantics.
    const state = await tx.workflowNodeState.findUnique({ where: { projectId_workflowRunId_nodeId: {
      projectId, workflowRunId: source.workflowRunId, nodeId: 'TEMPLATE_MIX',
    } } });
    const draft = state?.state as unknown as EffectTemplateMixWorkspaceData['draft'];
    const variant = draft?.templates?.find((entry) => entry.id === source.templateId)
      ?.workspace.variants.find((variant) => variant.id === source.variantId);
    if (!variant || outputDraftContentHash(variant) !== source.contentHash)
      throw new ConflictException('成片工程已编辑或删除，请重新局部更新；原有输出保留');
  }
  async content(projectId: string, runId: string, token: string, itemId: string, fileId: string) {
    const { item, snapshot } = await this.workerItem(projectId, runId, token, itemId);
    if (
      ![
        ...snapshot.timeline.clips.map((c) => c.fileObjectId),
        ...(snapshot.timeline.detachedAudios ?? []).map((a) => a.fileObjectId),
        ...audioIds(snapshot.packaging),
      ].includes(fileId)
    )
      throw new NotFoundException('文件不属于此输出条目');
    const file = await this.db.fileObject.findFirstOrThrow({
      where: { projectId, id: fileId, status: 'AVAILABLE' },
    });
    return {
      ...(await this.storage.open(file.storageKey)),
      mimeType: file.mimeType,
      sha256: file.sha256,
    };
  }
  async progress(
    projectId: string,
    runId: string,
    token: string,
    itemId: string,
    progress: number,
    errorMessage?: string,
  ) {
    if (!errorMessage) await this.workerItem(projectId, runId, token, itemId);
    return this.db.$transaction(async (tx) => {
      await this.heartbeat(projectId, runId, token, tx);
      await tx.effectFinalOutputItem.updateMany({
        where: { id: itemId, projectId, runId, status: { not: 'COMPLETED' } },
        data: {
          status: errorMessage ? 'FAILED' : 'RUNNING',
          progress: Math.max(0, Math.min(99, progress)),
          errorMessage: errorMessage ?? null,
        },
      });
      return { accepted: true };
    });
  }
  private async commitSourceRefresh(tx: Prisma.TransactionClient, projectId: string, snapshot: FinalOutputSnapshot) {
    const refresh = snapshot.sourceRefresh!;
    if (!refresh.ready) throw new ConflictException('局部更新的素材或包装尚未准备完成');
    await tx.$queryRaw`SELECT id FROM workflow_node_states WHERE "projectId"=${projectId}::uuid AND "workflowRunId"=${refresh.workflowRunId}::uuid AND "nodeId"='TEMPLATE_MIX' FOR UPDATE`;
    await this.assertRefreshCurrent(tx, projectId, snapshot);
    assertRefreshPreservesContent(snapshot, snapshot.packaging);
    const { workflowRunId, templateId } = refresh;
    const variant = snapshot.timeline.variant;
    const state = await tx.workflowNodeState.findUniqueOrThrow({ where: {
      projectId_workflowRunId_nodeId: { projectId, workflowRunId, nodeId: 'TEMPLATE_MIX' },
    } });
    const draft = state.state as unknown as EffectTemplateMixWorkspaceData['draft'];
    const entry = draft.templates.find((row) => row.id === templateId)!;
    entry.workspace.variants = entry.workspace.variants.map((row) => row.id === variant.id ? variant : row);
    entry.workspace.editVersion += 1;
    await tx.workflowNodeState.update({ where: { id: state.id }, data: {
      state: json(draft), contentHash: workflowStateHash(draft), revision: { increment: 1 },
    } });
    const sources = await tx.workingArtifact.findMany({ where: { projectId,
      id: { in: [...new Set(Object.values(variant.bindings))] } } });
    const consumed = refresh.protocol === 'FROZEN_RENDER_V1'
      ? snapshot.timeline.dependencies.filter((source) => source.nodeId === 'SEGMENT_RENDER')
      : sources.map((source) => ({ artifactId: source.id, artifactKey: source.artifactKey,
          nodeId: source.nodeId, revision: source.revision, contentHash: source.contentHash }));
    const sourceDeps = consumed.map((source) => ({ sourceType: 'WORKING_ARTIFACT' as const,
      sourceNodeId: 'SEGMENT_RENDER', sourceArtifactId: source.artifactId, sourceKey: source.artifactKey,
      sourceRevision: source.revision, sourceHash: source.contentHash }));
    // Persist the new clip revisions before saving the packaging snapshot. Keep its frozen
    // non-clip provenance so a later packaging task can still validate the facts it consumed.
    snapshot.timeline.dependencies = [
      ...snapshot.timeline.dependencies.filter((dependency) => dependency.nodeId !== 'SEGMENT_RENDER'),
      ...consumed,
    ];
    const [visual] = await this.working.commitValidatedArtifactsInTransaction(tx, projectId, workflowRunId,
      'TEMPLATE_MIX', [{ artifactKey: `timeline-project:${templateId}:${variant.id}`, input: {
        kind: 'STRUCTURED', name: variant.name, directory: 'EDITING_PROJECTS', type: 'TIMELINE_PROJECT',
        tags: ['效果类', '时间轴工程'], payload: { schemaVersion: 1, templateId,
          templateVersion: entry.workspace.template.editVersion, variant: packagingVisualVariant(variant) },
        metadata: { templateId, variantId: variant.id, durationSeconds: packagingTimelineDuration(variant) },
        dependencies: sourceDeps,
      } }], refresh.protocol === 'FROZEN_RENDER_V1' ? Object.values(variant.bindingSources ?? {}) : undefined);
    const deps = [{ artifactId: visual!.record.id, artifactKey: visual!.record.artifactKey,
      nodeId: visual!.record.nodeId, revision: visual!.record.revision, contentHash: visual!.record.contentHash }];
    delete snapshot.timeline.redoSlotIds;
    delete snapshot.timeline.preserveMusic;
    if (!snapshot.unpackaged) {
      const files = await tx.fileObject.findMany({ where: { projectId, id: { in: audioIds(snapshot.packaging) },
        status: 'AVAILABLE' } });
      const [packaged] = await this.working.commitValidatedArtifactsInTransaction(tx, projectId, workflowRunId,
        'TEMPLATE_MIX', [{ artifactKey: `timeline-package:${templateId}:${variant.id}`, input: {
          kind: 'STRUCTURED', name: `${variant.name} · 智能包装`, directory: 'EDITING_PROJECTS', type: 'TIMELINE_PROJECT',
          payload: { schemaVersion: 1, templateId, variantId: variant.id,
            sourceTimelineHash: snapshot.timeline.sourceTimelineHash,
            visualArtifactId: visual!.record.id, visualRevision: visual!.record.revision,
            duration: snapshot.timeline.duration, ...snapshot.packaging,
            mix: { originalVolume: 0.15, bgmVolume: snapshot.packaging.music?.volume ?? 0, ducking: true },
            subtitleStyle: 'standard' },
          metadata: { templateId, variantId: variant.id, sourceTimelineHash: snapshot.timeline.sourceTimelineHash },
          files: files.map((file, sortOrder) => ({ fileObjectId: file.id,
            role: file.id === snapshot.packaging.music?.fileObjectId ? 'BGM' : 'VOICE', sortOrder,
            originalFileName: file.originalFileName, mimeType: file.mimeType, sha256: file.sha256 })),
          dependencies: [{ sourceType: 'WORKING_ARTIFACT', sourceNodeId: 'TEMPLATE_MIX',
            sourceArtifactId: visual!.record.id, sourceKey: visual!.record.artifactKey,
            sourceRevision: visual!.record.revision, sourceHash: visual!.record.contentHash }],
        } }]);
      deps.push({ artifactId: packaged!.record.id, artifactKey: packaged!.record.artifactKey,
        nodeId: packaged!.record.nodeId, revision: packaged!.record.revision, contentHash: packaged!.record.contentHash });
      if (refresh.packagingItemId) {
        // Remove only this project's obsolete audio associations, never the shared files.
        const removedLines = (refresh.baselinePackaging.script ?? []).filter((line) =>
          refresh.removedSlotIds?.includes(line.slotId ?? '')).map((line) => line.id);
        const removedCaptions = (refresh.baselinePackaging.captions ?? []).filter((caption) =>
          refresh.removedSlotIds?.includes(caption.sourceSlotId ?? '') ||
          removedLines.includes(caption.voiceLineId ?? caption.id)).map((caption) => caption.id);
        const removedRoles = [...removedLines.map((id) => `voice-${id}`),
          ...removedCaptions.map((id) => `caption-voice-${id}`)];
        if (removedRoles.length) await tx.effectPackagingFile.deleteMany({ where: {
          projectId, itemId: refresh.packagingItemId, role: { in: removedRoles },
        } });
        await tx.effectPackagingItem.update({ where: { id: refresh.packagingItemId }, data: {
          snapshot: json(snapshot.timeline), checkpoint: json(snapshot.packaging),
          sourceTimelineHash: snapshot.timeline.sourceTimelineHash,
        } });
        for (const [role, audio] of Object.entries(refresh.uploadedAudios ?? {}))
          await tx.effectPackagingFile.upsert({ where: { projectId_itemId_role: {
            projectId, itemId: refresh.packagingItemId, role,
          } }, create: { projectId, itemId: refresh.packagingItemId, role, fileObjectId: audio.fileObjectId },
          update: { fileObjectId: audio.fileObjectId } });
      }
    }
    snapshot.dependencies = deps;
    const allIds = [...new Set(entry.workspace.variants.flatMap((row) => Object.values(row.bindings)))];
    const allSources = await tx.workingArtifact.findMany({ where: { projectId, id: { in: allIds } } });
    const batches = await tx.workingArtifact.findMany({ where: { projectId,
      ...(refresh.sourceBatches?.length ? { id: { in: refresh.sourceBatches.map((batch) => batch.artifactId) } }
        : { workflowRunId }),
      nodeId: 'SEGMENT_RENDER', artifactKey: { startsWith: 'render-batch:' },
      freshness: 'CURRENT', availability: 'AVAILABLE' } });
    const activeKeys = new Set(batches.flatMap((batch) => {
      const clips = (batch.payload as { clips?: { taskId: string }[] } | null)?.clips;
      return Array.isArray(clips) ? clips.map((clip) => `render-clip:${clip.taskId}`) : [];
    }));
    // Restore the template aggregate only after every affected project is current. Updating one
    // film must not clear another film's pending-source status.
    if (entry.workspace.variants.every((row) => row.slots.every((slot) => {
      if (!row.bindings[slot.id] && row.intentionallyEmptySlotIds?.includes(slot.id)) return true;
      const source = allSources.find((source) => source.id === row.bindings[slot.id]);
      return source && source.revision === row.bindingRevisions[slot.id] &&
        source.freshness === 'CURRENT' && source.availability === 'AVAILABLE' &&
        (!batches.length || activeKeys.has(source.artifactKey));
    }))) await this.working.commitValidatedArtifactsInTransaction(tx, projectId, workflowRunId,
      'TEMPLATE_MIX', [{ artifactKey: `mix-template:${templateId}`, input: {
        kind: 'STRUCTURED', name: entry.workspace.template.name, directory: 'EDITING_PROJECTS', type: 'MIX_TEMPLATE',
        tags: ['效果类', '混剪模板'], payload: { schemaVersion: 1, templateId,
          workspaceVersion: entry.workspace.editVersion, template: entry.workspace.template },
        metadata: { templateId, variantCount: entry.workspace.variants.length },
        dependencies: allSources.map((source) => ({ sourceType: 'WORKING_ARTIFACT' as const,
          sourceNodeId: source.nodeId, sourceArtifactId: source.id, sourceKey: source.artifactKey,
          sourceRevision: source.revision, sourceHash: source.contentHash })),
      } }]);
    delete snapshot.sourceRefresh;
  }

  /** Commit repaired unexported projects; never create final-video artifacts from this path. */
  async completeProjectRefresh(projectId: string, runId: string, token: string, itemId: string) {
    return this.db.$transaction(async (tx) => {
      await this.heartbeat(projectId, runId, token, tx);
      await tx.$queryRaw`SELECT id FROM effect_final_output_items WHERE id=${itemId}::uuid AND "projectId"=${projectId}::uuid AND "runId"=${runId}::uuid FOR UPDATE`;
      const item = await tx.effectFinalOutputItem.findFirstOrThrow({ where: { projectId, runId, id: itemId } });
      const snapshot = item.snapshot as unknown as FinalOutputSnapshot;
      if (!snapshot.sourceRefresh && (item.status === 'PENDING_RENDER' || item.status === 'COMPLETED'))
        return { accepted: true };
      if (!snapshot.projectRefreshOnly)
        throw new ConflictException('当前任务不是混剪工程的素材更新');
      if (!snapshot.sourceRefresh?.ready) throw new ConflictException('素材更新尚未完成');
      await tx.$queryRaw`SELECT id FROM workflow_node_states WHERE "projectId"=${projectId}::uuid AND "workflowRunId"=${snapshot.sourceRefresh.workflowRunId}::uuid AND "nodeId"='TEMPLATE_MIX' FOR UPDATE`;
      const lockedSourceIds = [...new Set([...Object.values(snapshot.timeline.variant.bindings),
        ...snapshot.timeline.dependencies.map((source) => source.artifactId),
        ...(snapshot.sourceRefresh.sourceBatches ?? []).map((source) => source.artifactId)])].sort();
      for (const sourceId of lockedSourceIds)
        await tx.$queryRaw`SELECT id FROM working_artifacts WHERE "projectId"=${projectId}::uuid AND id=${sourceId}::uuid FOR SHARE`;
      if (snapshot.sourceRefresh.packagingItemId)
        await tx.$queryRaw`SELECT id FROM effect_packaging_items WHERE "projectId"=${projectId}::uuid AND id=${snapshot.sourceRefresh.packagingItemId}::uuid FOR UPDATE`;
      await this.current(tx, projectId, snapshot);
      const previousOutput = snapshot.sourceRefresh.previousOutputSnapshot;
      await this.commitSourceRefresh(tx, projectId, snapshot);
      if (previousOutput) delete previousOutput.projectRefreshOnly;
      await tx.effectFinalOutputItem.update({ where: { id: itemId }, data: {
        status: item.fileObjectId ? 'COMPLETED' : 'PENDING_RENDER', progress: 100, errorMessage: null,
        snapshot: json(previousOutput ?? snapshot),
      } });
      return { accepted: true };
    }, { timeout: 30_000 });
  }

  async upload(
    projectId: string,
    runId: string,
    token: string,
    itemId: string,
    file?: { path: string; size: number },
  ) {
    const { item, snapshot } = await this.workerItem(projectId, runId, token, itemId);
    if (snapshot.projectRefreshOnly) throw new ConflictException('工程素材更新不能上传成片文件');
    if (item.status === 'COMPLETED') return { fileObjectId: item.fileObjectId };
    if (!file || file.size < 32 || file.size > 2_000_000_000)
      throw new BadRequestException('输出视频文件无效');
    const handle = await open(file.path, 'r');
    try {
      const header = Buffer.alloc(12);
      await handle.read(header, 0, 12, 0);
      if (header.toString('ascii', 4, 8) !== 'ftyp')
        throw new BadRequestException('输出必须为 MP4');
    } finally {
      await handle.close();
    }
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file.path)) hash.update(chunk);
    const sha256 = hash.digest('hex');
    const project = await this.db.project.findUniqueOrThrow({ where: { id: projectId } });
    const originalFileName = `${item.name.replace(/[\\/:*?"<>|]/g, '-')}.mp4`;
    const stored = await this.storage.put({
      projectId,
      stream: createReadStream(file.path),
      sizeBytes: file.size,
      contentType: 'video/mp4',
      keyContext: {
        projectName: project.name,
        workflow: 'effect',
        lifecycle: 'assets',
        category: 'final-output',
        originalFileName,
      },
    });
    let previousStorageKey: string | null = null;
    let unchanged = false;
    try {
      const uploaded = await this.db.$transaction(
        async (tx) => {
          await this.heartbeat(projectId, runId, token, tx);
          await tx.$queryRaw`SELECT id FROM workflow_node_states WHERE "projectId"=${projectId}::uuid AND "workflowRunId"=${item.run.workflowRunId}::uuid AND "nodeId"='TEMPLATE_MIX' FOR UPDATE`;
          if (snapshot.sourceRefresh) {
            const lockedSourceIds = [...new Set([...Object.values(snapshot.timeline.variant.bindings),
              ...snapshot.timeline.dependencies.map((source) => source.artifactId),
              ...(snapshot.sourceRefresh.sourceBatches ?? []).map((source) => source.artifactId)])].sort();
            for (const sourceId of lockedSourceIds)
              await tx.$queryRaw`SELECT id FROM working_artifacts WHERE "projectId"=${projectId}::uuid AND id=${sourceId}::uuid FOR SHARE`;
            if (snapshot.sourceRefresh.packagingItemId)
              await tx.$queryRaw`SELECT id FROM effect_packaging_items WHERE "projectId"=${projectId}::uuid AND id=${snapshot.sourceRefresh.packagingItemId}::uuid FOR UPDATE`;
          }
          await tx.$queryRaw`SELECT id FROM working_artifacts WHERE "projectId"=${projectId}::uuid AND "workflowRunId"=${item.run.workflowRunId}::uuid ORDER BY id FOR SHARE`;
          await this.current(tx, projectId, snapshot);
          if (snapshot.sourceRefresh) await this.commitSourceRefresh(tx, projectId, snapshot);
          await this.assertOutputDraft(tx, projectId, snapshot);
          const latest = await tx.effectFinalOutputItem.findUniqueOrThrow({
            where: { id: itemId },
          });
          if (latest.status === 'COMPLETED')
            throw new ConflictException('输出已保存，请读取已完成结果');
          const fileObject = await tx.fileObject.create({
            data: {
              projectId,
              workflowRunId: item.run.workflowRunId,
              nodeId: 'FINAL_OUTPUT',
              originalFileName,
              mimeType: 'video/mp4',
              sizeBytes: file.size,
              storageKey: stored.key,
              sha256,
            },
          });
          // 先释放旧产物，好让 artifact commit 的孤儿守卫（finalOutputItems: { none: {} }）能认出旧 blob。
          if (latest.fileObjectId)
            await tx.effectFinalOutputItem.update({
              where: { id: itemId },
              data: { fileObjectId: null },
            });
          const [result] = await this.working.commitValidatedArtifactsInTransaction(
            tx,
            projectId,
            item.run.workflowRunId,
            'FINAL_OUTPUT',
            [
              {
                artifactKey: `final-video:${item.run.templateId}:${item.variantId}`,
                input: {
                  kind: 'FILE',
                  name: item.name,
                  directory: 'FINAL_VIDEOS',
                  type: 'FINAL_VIDEO',
                  originalFileName,
                  mimeType: 'video/mp4',
                  sizeBytes: file.size,
                  storageKey: stored.key,
                  fileChecksum: sha256,
                  metadata: { duration: snapshot.timeline.duration, variantId: item.variantId },
                  files: [
                    {
                      fileObjectId: fileObject.id,
                      role: 'VIDEO',
                      sortOrder: 0,
                      originalFileName,
                      mimeType: 'video/mp4',
                      sha256,
                    },
                  ],
                  dependencies: (
                    await tx.workingArtifact.findMany({
                      where: {
                        projectId,
                        id: { in: snapshot.dependencies.map((d) => d.artifactId) },
                      },
                    })
                  ).map((a) => ({
                    sourceType: 'WORKING_ARTIFACT',
                    sourceNodeId: a.nodeId,
                    sourceArtifactId: a.id,
                    sourceKey: a.artifactKey,
                    sourceRevision: a.revision,
                    sourceHash: a.contentHash,
                  })),
                },
              },
            ],
          );
          // 重渲染出来的字节与上一版逐字节相同（同规格重渲染是确定性的）：artifact 会短路成
          // unchanged，此时它仍指着旧 blob，绝不能让下面的 enqueueCleanup 删掉活文件。
          // 条目恢复原状，顺手清掉这次多建的 fileObject。
          if (result!.unchanged) {
            unchanged = true;
            await tx.fileObject.delete({ where: { id: fileObject.id } });
            await tx.effectFinalOutputItem.update({
              where: { id: itemId },
              data: {
                status: 'COMPLETED',
                progress: 100,
                errorMessage: null,
                fileObjectId: latest.fileObjectId,
                assetId: latest.assetId,
                snapshot: json(snapshot),
              },
            });
            return { fileObjectId: latest.fileObjectId };
          }
          // 重渲染就地覆盖：asset 行不动（idempotencyKey 保留 → 不会二次插入撞唯一约束），
          // 只把内容与单条 v1 兼容行换新，照 AssetRepository.recreateCurrent 的先例。
          const asset = latest.assetId
            ? await (async () => {
                await tx.assetVersion.deleteMany({ where: { projectId, assetId: latest.assetId! } });
                const replaced = await tx.asset.update({
                  where: { id: latest.assetId! },
                  data: {
                    name: item.name,
                    originalFileName,
                    sizeBytes: file.size,
                    storageKey: stored.key,
                    sourceArtifactId: result!.record.id,
                    currentVersion: 1,
                    status: 'AVAILABLE',
                  },
                });
                await tx.assetVersion.create({
                  data: {
                    projectId,
                    assetId: replaced.id,
                    version: 1,
                    changeNote: '智能成片重新输出',
                    status: 'AVAILABLE',
                    qualityStatus: 'AVAILABLE',
                    originalFileName,
                    mimeType: 'video/mp4',
                    sizeBytes: file.size,
                    storageKey: stored.key,
                  },
                });
                return replaced;
              })()
            : await tx.asset.create({
                data: {
                  projectId,
                  name: item.name,
                  directory: 'FINAL_VIDEOS',
                  type: 'FINAL_VIDEO',
                  originalFileName,
                  mimeType: 'video/mp4',
                  sizeBytes: file.size,
                  storageKey: stored.key,
                  sourceNode: 'FINAL_OUTPUT',
                  sourceRunId: item.run.workflowRunId,
                  sourceArtifactId: result!.record.id,
                  idempotencyKey: `final-output:${itemId}`,
                  versions: {
                    create: {
                      projectId,
                      version: 1,
                      changeNote: '智能成片输出',
                      status: 'AVAILABLE',
                      qualityStatus: 'AVAILABLE',
                      originalFileName,
                      mimeType: 'video/mp4',
                      sizeBytes: file.size,
                      storageKey: stored.key,
                    },
                  },
                },
              });
          previousStorageKey = result!.previousStorageKey;
          await tx.effectFinalOutputItem.update({
            where: { id: itemId },
            data: {
              status: 'COMPLETED',
              progress: 100,
              errorMessage: null,
              fileObjectId: fileObject.id,
              assetId: asset.id,
              snapshot: json(snapshot),
            },
          });
          return { fileObjectId: fileObject.id };
        },
        { timeout: 30_000 },
      );
      // 未变更时 artifact 没换 blob，这次上传的副本是多余的，直接删掉。
      if (unchanged) {
        await this.storage.delete(stored.key).catch(() => undefined);
        return uploaded;
      }
      // 事务提交后再排清理：旧 blob 此刻才真正成为孤儿，回滚时这一步不该发生。
      if (previousStorageKey)
        await this.working.enqueueCleanup(projectId, previousStorageKey, 'FINAL_OUTPUT_REPLACED');
      return uploaded;
    } catch (error) {
      await this.storage.delete(stored.key).catch(() => undefined);
      throw error;
    }
  }
  async finish(projectId: string, id: string, token: string) {
    const status = await this.db.$transaction(async (tx) => {
      await this.heartbeat(projectId, id, token, tx);
      const items = await tx.effectFinalOutputItem.findMany({ where: { projectId, runId: id } });
      if (items.some((i) => ['QUEUED', 'RUNNING'].includes(i.status)))
        throw new ConflictException('仍有输出未完成');
      const completed = items.filter((i) => i.status === 'COMPLETED').length;
      const projectRefreshes = items.filter((item) => (item.snapshot as unknown as FinalOutputSnapshot).projectRefreshOnly);
      const status = projectRefreshes.length && projectRefreshes.every((item) =>
        item.status === 'PENDING_RENDER' && !(item.snapshot as unknown as FinalOutputSnapshot).sourceRefresh)
        ? 'PENDING_RENDER' : completed === items.length ? 'COMPLETED' : completed ? 'PARTIAL' : 'FAILED';
      if (status === 'PENDING_RENDER') for (const item of projectRefreshes) {
        const snapshot = item.snapshot as unknown as FinalOutputSnapshot;
        delete snapshot.projectRefreshOnly;
        await tx.effectFinalOutputItem.update({ where: { id: item.id }, data: { snapshot: json(snapshot) } });
      }
      await tx.effectFinalOutputRun.update({
        where: { id },
        data: { status, attemptToken: null, leaseExpiresAt: null, completedAt: new Date() },
      });
      return status;
    });
    // A batch that finished is the version the user asked for, so it becomes a branch of its own.
    // The manifest and the publish each open their own transaction: this write has to be committed
    // before they read it, and neither may inherit its lock budget.
    if (status === 'COMPLETED')
      try {
        await this.deliverCompletedBatch(projectId, id);
      } catch (error) {
        this.logger.warn(
          JSON.stringify({
            event: 'final_output_delivery_failed',
            projectId,
            runId: id,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    return { accepted: true };
  }
  async cancel(projectId: string, id: string) {
    return this.db.$transaction(async (tx) => {
      const result = await tx.effectFinalOutputRun.updateMany({
        where: { projectId, id, status: { in: ['QUEUED', 'RUNNING'] } },
        data: {
          status: 'CANCELLED',
          attemptToken: null,
          leaseExpiresAt: null,
          completedAt: new Date(),
        },
      });
      if (result.count)
        await tx.effectFinalOutputItem.updateMany({
          where: { projectId, runId: id, status: { in: ['QUEUED', 'RUNNING'] } },
          data: { status: 'CANCELLED' },
        });
      return { accepted: true };
    });
  }
  async retry(projectId: string, id: string) {
    const previous = await this.db.effectFinalOutputRun.findFirst({ where: { projectId, id }, include });
    if (previous && ['PARTIAL', 'FAILED', 'CANCELLED'].includes(previous.status) &&
        previous.items.some((item) => (item.snapshot as unknown as FinalOutputSnapshot).projectRefreshOnly)) {
      const failedIds = previous.items.filter((item) => ['FAILED', 'CANCELLED'].includes(item.status) &&
        (item.snapshot as unknown as FinalOutputSnapshot).projectRefreshOnly).map((item) => item.id);
      if (!failedIds.length) throw new ConflictException('当前工程没有需要恢复的素材更新');
      await this.localUpdate(projectId, id, { itemIds: failedIds }, true);
      return { accepted: true };
    }
    const failedRefreshes = previous?.items.filter((item) => item.status !== 'COMPLETED') ?? [];
    if (previous && ['PARTIAL', 'FAILED', 'CANCELLED'].includes(previous.status) && failedRefreshes.length &&
      failedRefreshes.every((item) => item.fileObjectId && item.assetId &&
        (item.snapshot as unknown as FinalOutputSnapshot).sourceRefresh)) {
      try {
        for (const item of failedRefreshes)
          await this.current(this.db, projectId, item.snapshot as unknown as FinalOutputSnapshot);
      } catch (error) {
        if (!(error instanceof ConflictException)) throw error;
        // A changed source cannot recover from its obsolete checkpoint forever. The explicit
        // retry re-freezes the latest inputs in place, retaining every previous exported file.
        await this.localUpdate(projectId, id, { itemIds: failedRefreshes.map((item) => item.id) }, true);
        return { accepted: true };
      }
    }
    return this.db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM effect_final_output_runs WHERE id=${id}::uuid AND "projectId"=${projectId}::uuid FOR UPDATE`;
        const run = await tx.effectFinalOutputRun.findFirst({ where: { projectId, id }, include });
        if (!run || !['PARTIAL', 'FAILED', 'CANCELLED'].includes(run.status))
          throw new ConflictException('当前输出不可恢复');
        for (const item of run.items)
          if (item.status !== 'COMPLETED')
            await this.current(tx, projectId, item.snapshot as unknown as FinalOutputSnapshot);
        await tx.effectFinalOutputItem.updateMany({
          where: { projectId, runId: id, status: { not: 'COMPLETED' } },
          data: { status: 'QUEUED', progress: 0, errorMessage: null },
        });
        await tx.effectFinalOutputRun.update({
          where: { id },
          data: { status: 'QUEUED', attemptToken: null, leaseExpiresAt: null, completedAt: null },
        });
        await this.enqueue(tx, projectId, id);
        return { accepted: true };
      },
      { timeout: 30_000 },
    );
  }
  /** Re-renders one already-exported item against its own stored snapshot; the batch spec is untouched. */
  async renderItem(projectId: string, id: string, itemId: string) {
    await this.db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM effect_final_output_runs WHERE id=${id}::uuid AND "projectId"=${projectId}::uuid FOR UPDATE`;
        const run = await tx.effectFinalOutputRun.findFirst({ where: { projectId, id }, include });
        if (!run) throw new NotFoundException('成片输出任务不存在');
        if (run.status === 'QUEUED' || run.status === 'RUNNING')
          throw new ConflictException('该模板正在渲染，请等待本批完成后重试');
        if (run.status === 'PENDING_RENDER')
          throw new ConflictException('该模板尚未导出，请先导出成片');
        const item = run.items.find((entry) => entry.id === itemId);
        if (!item) throw new NotFoundException('成片条目不存在');
        await this.current(tx, projectId, item.snapshot as unknown as FinalOutputSnapshot);
        // Only this item goes back to QUEUED; claim() hands the worker exactly the non-COMPLETED
        // items, so the rest of the batch is left alone.
        await tx.effectFinalOutputItem.update({
          where: { id: itemId },
          data: { status: 'QUEUED', progress: 0, errorMessage: null },
        });
        await tx.effectFinalOutputRun.update({
          where: { id },
          data: { status: 'QUEUED', attemptToken: null, leaseExpiresAt: null, completedAt: null },
        });
        await this.enqueue(tx, projectId, id);
      },
      { timeout: 30_000 },
    );
    return this.get(projectId, id);
  }
  async recoverExpired() {
    const rows = await this.db.effectFinalOutputRun.findMany({
      where: { status: 'RUNNING', leaseExpiresAt: { lt: new Date() } },
      take: 50,
    });
    for (const row of rows)
      await this.db.$transaction(async (tx) => {
        const changed = await tx.effectFinalOutputRun.updateMany({
          where: { id: row.id, status: 'RUNNING', leaseExpiresAt: { lt: new Date() } },
          data: { status: 'QUEUED', attemptToken: null, leaseExpiresAt: null },
        });
        if (changed.count) await this.enqueue(tx, row.projectId, row.id);
      });
    // The worker may have completed while the API was restarting, or manifest/publication may
    // have failed after the batch status committed. Retry those two idempotent steps separately.
    const pendingDeliveries = await this.db.effectFinalOutputRun.findMany({
      where: { status: 'COMPLETED', workflowRun: {
        forkNodeId: 'FINAL_OUTPUT', branchPublishedAt: null,
        parentWorkflowRunId: { not: null },
      } },
      orderBy: [{ completedAt: 'desc' }, { id: 'desc' }], take: 100,
      select: { id: true, projectId: true },
    });
    let attempted = 0;
    for (const run of pendingDeliveries) {
      if (attempted >= 5) break;
      if ((this.deliveryRecoveryAfter.get(run.id) ?? 0) > Date.now()) continue;
      attempted += 1;
      this.deliveryRecoveryAfter.set(run.id, Date.now() + 300_000);
      try {
        await this.deliverCompletedBatch(run.projectId, run.id);
        this.deliveryRecoveryAfter.delete(run.id);
      } catch (error) {
        this.logger.warn(JSON.stringify({ event: 'final_output_delivery_recovery_failed',
          projectId: run.projectId, runId: run.id,
          error: error instanceof Error ? error.message : String(error),
        }));
      }
    }
  }
}
