import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import type {
  EffectTemplateMixMaterial,
  EffectTemplateMixVariant,
  EffectTemplateMixWorkspaceData,
  FinalOutputRun,
  FinalOutputSnapshot,
  LocalUpdateFinalOutputRequest,
  PackagingCheckpoint,
  PackagingSnapshot,
  StartFinalOutputRequest,
  SyncFinalOutputData,
  SyncFinalOutputRequest,
  WorkingArtifact,
} from '@ai-marketing/contracts';
import {
  EFFECT_TEMPLATE_MIX_MAX_CONTENT_SECONDS,
  effectTemplateMixContentDuration,
  FINAL_OUTPUT_RESOLUTIONS,
  packagingOverlayTimeline,
} from '@ai-marketing/contracts';
import { PrismaService } from '../../../database/prisma.service';
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
  requireSlotPackaging,
  visualHash,
} from '../template-mix/effect-packaging.domain';

const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const lease = () => new Date(Date.now() + 120_000);
const include = { items: { orderBy: { id: 'asc' as const } } };
const NEEDS_REPACKAGING = '成片工程已变化，请返回混剪重新进行智能成片包装';
const audioIds = (cp: PackagingCheckpoint) =>
  [...Object.values(cp.voices ?? {}), ...(cp.music ? [cp.music] : [])].map((a) => a.fileObjectId);
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
type OutputItemRow = { id: string; variantId: string; name: string; snapshot: unknown };
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
  ) {}

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
  ) {
    const { inputs, variants } = await this.mix.prepareValidation(
      projectId,
      workflowRunId,
      expectedRevision,
      templateId,
      // A partial pass is what lets a finished package through: the variant that was just packaged is
      // the version, and a sibling the user has not finished editing must not veto it.
      { partial: true },
    );
    const workspace = await this.mix.workspace(projectId, workflowRunId);
    return { inputs, variants, workspace };
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
    options: { publish?: boolean } = {},
  ): Promise<void> {
    const before = await this.db.workflowNodeState.findUnique({
      where: {
        projectId_workflowRunId_nodeId: { projectId, workflowRunId, nodeId: 'TEMPLATE_MIX' },
      },
      select: { revision: true },
    });
    if (!before) throw new NotFoundException('混剪草稿不存在');
    const { inputs, variants, workspace } = await this.outputPlan(
      projectId,
      workflowRunId,
      templateId,
      before.revision,
    );
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
          where: { projectId, workflowRunId, templateId, status: 'PENDING_RENDER' },
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
          const firstClip = row.snapshot.clips[0]!;
          // The renderer only ever sees clips, so the live overlays are folded in here. The frozen
          // overlays are dropped first: one the user has since deleted must not render, and one still
          // on the timeline is supplied by `row.overlays` — keeping both would draw it twice.
          const timelineClips = [
            ...row.snapshot.clips.filter((clip) => clip.overlay !== true),
            ...row.overlays,
          ].map((clip) => ({
            ...clip,
            // Rows are numbered against the live draft, and adding an overlay shifts the ones under
            // it. Keeping the frozen row numbers would place the overlay beside a clip it should
            // cover, so every row is re-read from the draft the user is looking at.
            lane: row.variant.videoLanes?.[clip.slotId] ?? clip.lane,
          }));
          const snapshot: FinalOutputSnapshot = {
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
            aspectRatio:
              workspace.materials.find((m) => m.fileObjectId === firstClip.fileObjectId)?.ratio ??
              '9:16',
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
        if (pending) {
          // The films have not been exported yet, so the queue simply follows the new package:
          // refreshing in place keeps one batch per template instead of growing one per packaging run.
          const wanted = new Map(outputRows.map((row) => [row.variantId, row]));
          for (const item of pending.items) {
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

  /**
   * Rewrites one film's frozen picture from the draft the user is looking at. The package's audio,
   * captions and provenance are left exactly as confirmed: a local update re-renders the film the
   * user just edited, it does not re-narrate it.
   */
  private async rewriteFilm(
    tx: Prisma.TransactionClient,
    item: OutputItemRow,
    variant: EffectTemplateMixVariant,
    workspace: EffectTemplateMixWorkspaceData,
    artifacts: WorkingArtifact[],
    status: 'QUEUED' | 'PENDING_RENDER',
  ): Promise<void> {
    const snapshot = item.snapshot as unknown as FinalOutputSnapshot;
    let clips: PackagingSnapshot['clips'];
    try {
      clips = this.liveClips(variant, workspace.materials, artifacts);
    } catch {
      throw new ConflictException(`${item.name} 的当前画面素材不可用`);
    }
    const cp = { ...snapshot.packaging };
    delete cp.musicTaskId;
    delete cp.musicSubmissionPending;
    const duration = effectTemplateMixContentDuration(variant, cp);
    if (duration > EFFECT_TEMPLATE_MIX_MAX_CONTENT_SECONDS)
      throw new ConflictException('成片时长超过容量上限');
    await tx.effectFinalOutputItem.update({
      where: { id: item.id },
      data: {
        status,
        progress: 0,
        errorMessage: null,
        snapshot: json({
          ...snapshot,
          timeline: {
            ...snapshot.timeline,
            clips,
            duration,
            sourceTimelineHash: visualHash(variant),
            variant,
          },
          packaging: cp,
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
      const active = await this.db.workflowRun.findFirst({ where: {
        projectId, id: workflowRunId, workflow: 'EFFECT', workflowSpace: 'EFFECT',
        activeKey: 'ACTIVE',
      }, select: { id: true } });
      const state = await this.db.workflowNodeState.findUnique({ where: {
        projectId_workflowRunId_nodeId: { projectId, workflowRunId, nodeId: 'TEMPLATE_MIX' },
      }, select: { revision: true } });
      if (!active || state?.revision !== request.expectedDraftRevision)
        return { ...result, superseded: true };
    }
    const runs = await this.db.effectFinalOutputRun.findMany({
      where: { projectId, workflowRunId,
        ...(request.templateId ? { templateId: request.templateId } : {}) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include,
    });
    if (!runs.length) return result;
    const workspace = await this.mix.workspace(projectId, workflowRunId);
    if (request.expectedDraftRevision !== undefined &&
      workspace.draftRevision !== request.expectedDraftRevision)
      return { ...result, superseded: true };
    const artifacts = (await this.working.listArtifacts(projectId, {
      workflowRunId,
    })) as unknown as WorkingArtifact[];
    // A confirmed output version belongs to the user. Do not inspect it for changes or create
    // stale/update notices; only an unexported queue follows draft edits automatically.
    if (hasOutputVersion(artifacts)) return result;
    for (const run of runs) {
      if (run.status !== 'PENDING_RENDER') continue;
      const moved = run.items.filter((item) =>
        this.draftDiffersFromSnapshot(run.templateId, item, artifacts, workspace),
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
                const active = await tx.workflowRun.findFirst({ where: { projectId,
                  id: workflowRunId, activeKey: 'ACTIVE' }, select: { id: true } });
                if (current?.revision !== request.expectedDraftRevision || !active) return false;
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
        const outcome = await this.db.$transaction(async (tx) => {
          if (request.expectedDraftRevision !== undefined) {
            await tx.$queryRaw`SELECT id FROM workflow_node_states WHERE "projectId"=${projectId}::uuid AND "workflowRunId"=${workflowRunId}::uuid AND "nodeId"='TEMPLATE_MIX' FOR SHARE`;
            const current = await tx.workflowNodeState.findUnique({ where: {
              projectId_workflowRunId_nodeId: { projectId, workflowRunId, nodeId: 'TEMPLATE_MIX' },
            }, select: { revision: true } });
            const active = await tx.workflowRun.findFirst({ where: { projectId, id: workflowRunId,
              activeKey: 'ACTIVE' }, select: { id: true } });
            const currentItem = await tx.effectFinalOutputItem.findFirst({ where: { projectId,
              id: item.id, status: 'PENDING_RENDER' }, select: { id: true } });
            if (current?.revision !== request.expectedDraftRevision || !active || !currentItem)
              return 'SUPERSEDED' as const;
          }
          const delivery = await tx.workingArtifact.findFirst({ where: { projectId,
            workflowRunId, nodeId: 'FINAL_OUTPUT', artifactKey: { startsWith: 'final-delivery:' },
          }, select: { id: true } });
          if (delivery) return 'SUPERSEDED' as const;
          await this.rewriteFilm(tx, item, variant, workspace, artifacts, 'PENDING_RENDER');
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
  ): Promise<FinalOutputRun> {
    await this.db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM effect_final_output_runs WHERE id=${id}::uuid AND "projectId"=${projectId}::uuid FOR UPDATE`;
        const run = await tx.effectFinalOutputRun.findFirst({ where: { projectId, id }, include });
        if (!run) throw new NotFoundException('成片输出任务不存在');
        if (run.status === 'QUEUED' || run.status === 'RUNNING')
          throw new ConflictException('该模板正在渲染，请等待本批完成后重试');
        if (run.status === 'PENDING_RENDER')
          throw new ConflictException('该模板尚未导出，请先导出成片');
        if (run.status !== 'COMPLETED')
          throw new ConflictException('请先等待成片批次完成或恢复失败项');
        const activeRun = await tx.workflowRun.findFirst({ where: { projectId,
          id: run.workflowRunId, workflow: 'EFFECT', workflowSpace: 'EFFECT', activeKey: 'ACTIVE',
        }, select: { id: true } });
        if (!activeRun) throw new ConflictException('只能更新当前活动成片分支');
        await tx.$queryRaw`SELECT id FROM workflow_node_states WHERE "projectId"=${projectId}::uuid AND "workflowRunId"=${run.workflowRunId}::uuid AND "nodeId"='TEMPLATE_MIX' FOR SHARE`;
        const workspace = await this.mix.workspace(projectId, run.workflowRunId);
        const artifacts = (await tx.workingArtifact.findMany({
          where: { projectId, workflowRunId: run.workflowRunId },
          include: workingArtifactInclude,
        })) as unknown as WorkingArtifact[];
        if (!hasOutputVersion(artifacts))
          throw new ConflictException('当前分支尚无已确认成片版本');
        if (!body.itemIds.length)
          throw new BadRequestException('请先选择需要重新渲染的成片');
        const chosen = run.items.filter((item) => body.itemIds.includes(item.id));
        if (chosen.length !== new Set(body.itemIds).size)
          throw new NotFoundException('成片条目不存在');
        if (chosen.some((item) => !item.fileObjectId || !item.assetId))
          throw new ConflictException('选中的成片文件不可用');
        const variants = workspace.draft?.templates.find(
          (entry) => entry.id === run.templateId,
        )?.workspace.variants;
        for (const item of chosen) {
          const variant = variants?.find((candidate) => candidate.id === item.variantId);
          if (!variant)
            throw new ConflictException(
              `${item.name} 已不在当前成片工程中，请返回模板混剪重新执行智能成片包装`,
            );
          // The film keeps its old file until the new one lands, so it stays downloadable meanwhile.
          await this.rewriteFilm(tx, item, variant, workspace, artifacts, 'QUEUED');
        }
        await tx.effectFinalOutputRun.update({
          where: { id },
          data: { status: 'QUEUED', attemptToken: null, leaseExpiresAt: null, completedAt: null },
        });
        await this.enqueue(tx, projectId, id);
      },
      { timeout: 120_000 },
    );
    return this.get(projectId, id);
  }

  async start(projectId: string, id: string, settings: StartFinalOutputRequest) {
    if (
      !FINAL_OUTPUT_RESOLUTIONS.includes(settings.resolution) ||
      !([24, 25, 30, 50, 60] as const).includes(settings.frameRate)
    )
      throw new BadRequestException('分辨率或帧率设置无效');
    const source = await this.db.effectFinalOutputRun.findFirst({
      where: { projectId, id },
      include,
    });
    if (!source) throw new NotFoundException('成片输出任务不存在');
    const active = await this.db.workflowRun.findFirst({ where: {
      projectId, id: source.workflowRunId, workflow: 'EFFECT', workflowSpace: 'EFFECT',
      activeKey: 'ACTIVE', status: { in: ['ACTIVE', 'PAUSED'] },
    }, select: { id: true } });
    if (!active) throw new ConflictException('当前成片不在活动分支，请切换到对应分支再导出');
    if (source.status === 'QUEUED' || source.status === 'RUNNING')
      throw new ConflictException('该模板已开始渲染，不能修改本批输出规格');
    if (source.status !== 'PENDING_RENDER')
      await this.db.$transaction(async (tx) => {
        for (const item of source.items)
          await this.current(tx, projectId, item.snapshot as unknown as FinalOutputSnapshot);
      }, { timeout: 120_000 });
    // Every full export owns a new, template-scoped Run. A re-export must leave the previous
    // delivery and its files in its published branch while the new batch is still rendering.
    const edit = await this.working.beginEffectNodeEdit(
      projectId, source.workflowRunId, 'FINAL_OUTPUT', 'BATCH',
      { always: true, templateId: source.templateId },
    );
    if (!edit) throw new ConflictException('当前分支无法创建成片输出版本');
    const batch = await this.db.effectFinalOutputRun.findFirst({
      where: { projectId, workflowRunId: edit.runId, templateId: source.templateId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true },
    });
    if (!batch) throw new ConflictException('新版本的成片输出批次不存在');
    const targetId = batch.id;
    await this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM effect_final_output_runs WHERE id=${targetId}::uuid AND "projectId"=${projectId}::uuid FOR UPDATE`;
      const run = await tx.effectFinalOutputRun.findFirst({ where: { projectId, id: targetId }, include });
      if (!run) throw new NotFoundException('成片输出任务不存在');
      // The cloned batch is pending; duplicate calls cannot enqueue it twice.
      if (run.status === 'QUEUED' || run.status === 'RUNNING')
        throw new ConflictException('该模板已开始渲染，不能修改本批输出规格');
      for (const item of run.items) {
        const snapshot = item.snapshot as unknown as FinalOutputSnapshot;
        await tx.effectFinalOutputItem.update({
          where: { id: item.id },
          data: {
            status: 'QUEUED',
            progress: 0,
            errorMessage: null,
            snapshot: json({ ...snapshot, resolution: settings.resolution, frameRate: settings.frameRate }),
          },
        });
      }
      await tx.effectFinalOutputRun.update({
        where: { id: targetId },
        data: { status: 'QUEUED', attemptToken: null, leaseExpiresAt: null, completedAt: null },
      });
      await this.enqueue(tx, projectId, targetId);
      // 100 items x upstream validation is the same order of work as complete().
    }, { timeout: 120_000 });
    return this.get(projectId, targetId);
  }

  /** Commit the delivery index only after every film succeeds; the caller then publishes its Run. */
  private async finalizeDelivery(projectId: string, id: string): Promise<string> {
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM effect_final_output_runs WHERE id=${id}::uuid AND "projectId"=${projectId}::uuid FOR UPDATE`;
      const run = await tx.effectFinalOutputRun.findFirst({ where: { projectId, id }, include });
      if (!run) throw new NotFoundException('成片输出任务不存在');
      if (run.status !== 'COMPLETED' || !run.items.length ||
        run.items.some((item) => item.status !== 'COMPLETED' || !item.fileObjectId || !item.assetId))
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
      const ordered = [...run.items].sort((a, b) =>
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
    }, { timeout: 120_000 });
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
    workspace?: EffectTemplateMixWorkspaceData,
  ): boolean {
    const snapshot = item.snapshot as unknown as FinalOutputSnapshot;
    const currentVariant = workspace?.draft?.templates
      .find((entry) => entry.id === templateId)
      ?.workspace.variants.find((variant) => variant.id === item.variantId);
    return (snapshot.dependencies ?? []).some((dependency) =>
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
    return packagingClips(variant, materials, artifactVisitor(artifacts)).map((clip) => ({
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
    workspace?: EffectTemplateMixWorkspaceData,
  ): boolean {
    if (this.sourceSnapshotDiffers(templateId, item, artifacts, workspace)) return true;
    const snapshot = item.snapshot as unknown as FinalOutputSnapshot;
    const variant = workspace?.draft?.templates
      .find((entry) => entry.id === templateId)
      ?.workspace.variants.find((candidate) => candidate.id === item.variantId);
    if (!variant) return true;
    try {
      return (
        pictureHash(this.liveClips(variant, workspace!.materials, artifacts)) !==
          pictureHash(snapshot.timeline.clips) ||
        effectTemplateMixContentDuration(variant, snapshot.packaging) !== snapshot.timeline.duration
      );
    } catch {
      return true;
    }
  }

  private toDto(
    run: Prisma.EffectFinalOutputRunGetPayload<{ include: typeof include }>,
    templateName?: string,
    artifacts: ArtifactRow[] = [],
    workspace?: EffectTemplateMixWorkspaceData,
  ): FinalOutputRun {
    const staleItemIds = new Set(
      hasOutputVersion(artifacts) && run.status === 'COMPLETED'
        ? run.items.filter((item) => Boolean(item.fileObjectId && item.assetId) &&
          this.draftDiffersFromSnapshot(run.templateId, item, artifacts as WorkingArtifact[], workspace))
          .map((item) => item.id)
        : [],
    );
    const delivery = artifacts.find((artifact) =>
      artifact.nodeId === 'FINAL_OUTPUT' &&
      artifact.artifactKey === `final-delivery:${run.templateId}` &&
      artifact.availability === 'AVAILABLE',
    );
    const payload = delivery?.payload as
      | { runId?: string; items?: Array<{ id: string; fileObjectId: string; assetId: string }> }
      | undefined;
    const delivered = new Map(
      Array.isArray(payload?.items) ? payload.items.map((item) => [item.id, item] as const) : [],
    );
    const validated = run.status === 'COMPLETED' && run.items.length > 0 &&
      payload?.runId === run.id && delivered.size === run.items.length &&
      run.items.every((item) =>
        item.status === 'COMPLETED' &&
        delivered.get(item.id)?.fileObjectId === item.fileObjectId &&
        delivered.get(item.id)?.assetId === item.assetId,
      );
    return {
      id: run.id,
      templateId: run.templateId,
      templateName: templateName || `模板 ${run.templateId.slice(0, 8)}`,
      validated,
      resolution: (run.items[0]?.snapshot as unknown as FinalOutputSnapshot | undefined)?.resolution ?? '720p',
      frameRate: (run.items[0]?.snapshot as unknown as FinalOutputSnapshot | undefined)?.frameRate ?? 30,
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
            stale: staleItemIds.has(i.id),
          };
        }),
      counts: {
        total: run.items.length,
        queued: run.items.filter((i) => ['PENDING_RENDER', 'QUEUED'].includes(i.status)).length,
        running: run.items.filter((i) => i.status === 'RUNNING').length,
        completed: run.items.filter((i) => i.status === 'COMPLETED').length,
        failed: run.items.filter((i) => ['FAILED', 'CANCELLED'].includes(i.status)).length,
        stale: staleItemIds.size,
      },
    };
  }

  async get(projectId: string, id: string): Promise<FinalOutputRun> {
    const run = await this.db.effectFinalOutputRun.findFirst({ where: { projectId, id }, include });
    if (!run) throw new NotFoundException('成片输出任务不存在');
    const workspace = await this.mix.workspace(projectId, run.workflowRunId);
    const artifacts = await this.working.listArtifacts(projectId, { workflowRunId: run.workflowRunId });
    const templateName = workspace.draft?.templates.find((entry) => entry.id === run.templateId)
      ?.workspace.template.name;
    return this.toDto(run, templateName, artifacts, workspace);
  }
  async list(projectId: string, workflowRunId: string) {
    const runs = await this.db.effectFinalOutputRun.findMany({
      where: { projectId, workflowRunId },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include,
    });
    if (!runs.length) return [];
    const workspace = await this.mix.workspace(projectId, workflowRunId);
    const artifacts = await this.working.listArtifacts(projectId, { workflowRunId });
    const templateNames = new Map(
      workspace.draft?.templates.map((entry) => [entry.id, entry.workspace.template.name]) ?? [],
    );
    return runs.map((run) => this.toDto(run, templateNames.get(run.templateId), artifacts, workspace));
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
        where: { projectId, runId: id, status: { not: 'COMPLETED' } },
        data: { status: 'QUEUED', progress: 0, errorMessage: null },
      });
      return {
        terminal: false,
        attemptToken,
        items: run.items.map((item) =>
          item.status === 'COMPLETED' ? item : { ...item, status: 'QUEUED' },
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
  private async workerItem(projectId: string, runId: string, token: string, itemId: string) {
    await this.heartbeat(projectId, runId, token);
    const item = await this.db.effectFinalOutputItem.findFirst({
      where: { id: itemId, projectId, runId },
      include: { run: true },
    });
    if (!item) throw new NotFoundException('输出条目不存在');
    const snapshot = item.snapshot as unknown as FinalOutputSnapshot;
    await this.current(this.db, projectId, snapshot);
    return { item, snapshot };
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
  async upload(
    projectId: string,
    runId: string,
    token: string,
    itemId: string,
    file?: { path: string; size: number },
  ) {
    const { item, snapshot } = await this.workerItem(projectId, runId, token, itemId);
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
          await tx.$queryRaw`SELECT id FROM workflow_node_states WHERE "projectId"=${projectId}::uuid AND "workflowRunId"=${item.run.workflowRunId}::uuid AND "nodeId"='TEMPLATE_MIX' FOR SHARE`;
          await tx.$queryRaw`SELECT id FROM working_artifacts WHERE "projectId"=${projectId}::uuid AND "workflowRunId"=${item.run.workflowRunId}::uuid ORDER BY id FOR SHARE`;
          await this.current(tx, projectId, snapshot);
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
      const status = completed === items.length ? 'COMPLETED' : completed ? 'PARTIAL' : 'FAILED';
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
