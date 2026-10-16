import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  parseVoiceSegmentFrames,
  parseVoiceSpeechRanges,
  wavDuration,
} from './effect-packaging-audio';
export { parseVoiceSegmentFrames, wavDuration } from './effect-packaging-audio';
import type {
  CreatePackagingCaptionVoiceRequest,
  CreatePackagingRequest,
  EffectTemplateMixMaterial,
  PackagingCheckpoint,
  PackagingItem,
  PackagingRun,
  PackagingSnapshot,
  PackagingStage,
  EffectTemplateMixDraft,
  FinalOutputSourceTrim,
  UpdatePackagingAudioRequest,
} from '@ai-marketing/contracts';
import {
  packagingPictureOnlyVariant,
  packagingVisualTimeline,
  effectTemplateMixSourceChanges,
  effectTemplateBranchTips,
} from '@ai-marketing/contracts';
import { packagingExecution } from './effect-packaging.metrics';
import { EffectPackagingRepository } from './effect-packaging.repository';
import { EffectTemplateMixService } from './effect-template-mix.service';
import { EffectFinalOutputService } from '../final-output/effect-final-output.service';
import { EffectVoiceCatalogService } from './effect-voice.catalog';
import { WorkflowWorkingService } from '../../../platform/workflow/workflow-working.service';
import { ProjectService } from '../../../platform/project/project.service';
import { STORAGE_PORT, type StoragePort } from '../../../platform/file/storage.port';
import { workflowStateHash } from '../../../platform/workflow/workflow-state-hash';
import { templateConfigurationHash } from './template-mix-lifecycle';
import {
  canonicalizeCheckpoint,
  packagingSnapshot,
  validatePackagingCheckpoint,
  matchesVisualHash,
  slotVisionKey,
  visualHash,
} from './effect-packaging.domain';

type PackagingRunRow = NonNullable<Awaited<ReturnType<EffectPackagingRepository['get']>>>;
type PackagingPresentation = {
  materials: readonly Pick<EffectTemplateMixMaterial, 'id' | 'code' | 'name'>[];
};

/**
 * The editor's fades for one audio clip, rebuilt field by field so a client cannot smuggle anything
 * else in. A field the editor never sent stays absent rather than becoming 0: absent means "pipeline
 * default", and inventing a 0 here would silently drop the music bed's easing.
 */
function fadeFields(
  duration: number,
  audio: { fadeIn?: number; fadeOut?: number },
  edit: { fadeIn?: number; fadeOut?: number },
): { fadeIn?: number; fadeOut?: number } {
  const fadeIn = edit.fadeIn ?? audio.fadeIn ?? 0;
  const fadeOut = edit.fadeOut ?? audio.fadeOut ?? 0;
  if (
    !Number.isFinite(fadeIn) ||
    !Number.isFinite(fadeOut) ||
    fadeIn < 0 ||
    fadeOut < 0 ||
    fadeIn + fadeOut > duration + 0.05
  )
    throw new BadRequestException('淡入淡出时长超出音频长度');
  return {
    ...(edit.fadeIn !== undefined ? { fadeIn } : {}),
    ...(edit.fadeOut !== undefined ? { fadeOut } : {}),
  };
}

@Injectable()
export class EffectPackagingService {
  private readonly logger = new Logger(EffectPackagingService.name);
  constructor(
    @Inject(EffectPackagingRepository) readonly repo: EffectPackagingRepository,
    @Inject(EffectTemplateMixService) readonly mix: EffectTemplateMixService,
    @Inject(WorkflowWorkingService) readonly working: WorkflowWorkingService,
    @Inject(STORAGE_PORT) readonly storage: StoragePort,
    @Inject(EffectFinalOutputService)
    readonly finalOutput: EffectFinalOutputService,
    @Inject(ProjectService) private readonly projects: ProjectService,
    @Inject(EffectVoiceCatalogService)
    readonly voiceCatalog: EffectVoiceCatalogService = new EffectVoiceCatalogService(),
  ) {}

  /**
   * New protocol commits each film at READY. Finishing only publishes a changed batch and
   * records continuation, before terminalizing the lease, so persistence can resume without
   * generating again. Legacy workers retain their original completion protocol below.
   */
  async finish(projectId: string, runId: string, token: string) {
    const current = await this.repo.get(projectId, runId);
    const operation = (current?.items[0]?.snapshot as unknown as PackagingSnapshot | undefined)
      ?.operation;
    if (operation) {
      await this.repo.authorized(projectId, runId, token);
      if (current!.items.some((item) => ['QUEUED', 'RUNNING'].includes(item.status)))
        throw new ConflictException('包装任务仍有未完成成片');
      // Publication is retried by lease recovery if it fails; never terminalize first.
      if (
        operation === 'BATCH_PACKAGE' &&
        current!.items.some((item) => item.status === 'COMPLETED')
      )
        await this.finalOutput.publishMixBranch(projectId, current!.workflowRunId);
      const appendId = (current!.items[0]?.snapshot as unknown as PackagingSnapshot)
        .incrementalFillRunId;
      // A terminal failed film has retained its baseline. It is not unfinished
      // continuation and must never require a second local-update click.
      if (appendId) await this.mix.recordAppendContinuation(projectId, appendId, false);
      await this.repo.finish(projectId, runId, token);
      return { accepted: true };
    }
    const result = await this.repo.finish(projectId, runId, token);
    const fillRunId = result.items
      .map((item) => (item.snapshot as unknown as PackagingSnapshot).incrementalFillRunId)
      .find(Boolean);
    if (result.status === 'COMPLETED' || result.status === 'PARTIAL')
      try {
        await this.finalOutput.upsertFromPackaging(
          projectId,
          result.workflowRunId,
          result.templateId,
          {
            publish:
              result.status === 'COMPLETED' &&
              !result.items.some(
                (item) => (item.snapshot as unknown as PackagingSnapshot).incrementalFillRunId,
              ),
            ...(result.items.some(
              (item) => (item.snapshot as unknown as PackagingSnapshot).incrementalFillRunId,
            )
              ? { onlyVariantIds: result.items.map((item) => item.variantId) }
              : {}),
          },
        );
        if (fillRunId) await this.mix.recordAppendContinuation(projectId, fillRunId, false);
      } catch (error) {
        if (fillRunId) await this.mix.recordAppendContinuation(projectId, fillRunId, true);
        this.logger.warn(
          JSON.stringify({
            event: 'effect_packaging_sync_failed',
            projectId,
            runId,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    return { accepted: true };
  }

  async createIncremental(projectId: string, fillRunId: string) {
    const fill = await this.mix.aiRun(projectId, fillRunId);
    if (
      fill.status !== 'COMPLETED' ||
      fill.operation !== 'APPEND' ||
      !fill.packageNewVariants ||
      !fill.outputVariantIds?.length
    )
      throw new ConflictException('追加成片尚未完成或不需要自动包装');
    const key = `append-package:${fillRunId}`;
    const replay = await this.repo.db.effectPackagingRun.findUnique({
      where: { projectId_idempotencyKey: { projectId, idempotencyKey: key } },
    });
    if (replay) return this.get(projectId, replay.id);
    const workspace = await this.mix.workspace(projectId, fill.workflowRunId);
    return this.create(
      projectId,
      fill.templateId,
      {
        workflowRunId: fill.workflowRunId,
        expectedRevision: workspace.draftRevision ?? 0,
        idempotencyKey: key,
        component: 'ALL',
      },
      { fillRunId, variantIds: fill.outputVariantIds },
    );
  }

  async create(
    projectId: string,
    templateId: string,
    body: CreatePackagingRequest,
    append?: { fillRunId: string; variantIds: string[] },
  ) {
    if (
      body.operation &&
      ((body.component && body.component !== 'ALL') ||
        body.slotId ||
        (body.operation === 'SINGLE_PACKAGE' ? !body.variantId : Boolean(body.variantId)))
    )
      throw new BadRequestException('包装操作与成片范围不一致');
    const operation = append ? ('APPEND_PACKAGE' as const) : body.operation;
    const requestHash = workflowStateHash({ ...body, templateId, ...(append ? { append } : {}) });
    const replay = await this.repo.db.effectPackagingRun.findUnique({
      where: { projectId_idempotencyKey: { projectId, idempotencyKey: body.idempotencyKey } },
    });
    if (replay) {
      if (replay.requestHash !== requestHash)
        throw new ConflictException('幂等键对应的包装请求已改变');
      return this.get(projectId, replay.id);
    }
    const sourceWorkspace = await this.mix.workspace(projectId, body.workflowRunId);
    // The request revision belongs to the source Run, not a future execution child.
    // Reject before opening an otherwise empty child for a stale browser snapshot.
    if (sourceWorkspace.draftRevision !== body.expectedRevision)
      throw new ConflictException('草稿已改变，请刷新后重试');
    const sourceEntry = sourceWorkspace.draft.templates.find((entry) => entry.id === templateId);
    if (!operation && sourceEntry?.packagingSourceLocked)
      throw new ConflictException('智能成片包装正在进行，暂时不能再次包装');
    // Packaging never acts as a local source update, including full repackaging.
    if (
      !append &&
      (sourceWorkspace.pendingAddedMaterialIds?.[templateId]?.length ||
        sourceEntry?.workspace.variants.some(
          (variant) =>
            effectTemplateMixSourceChanges(variant, sourceWorkspace.materials).length > 0,
        ))
    )
      throw new ConflictException('当前模板有素材待更新，请先完成局部更新，再进行智能成片包装。');
    if (
      !operation &&
      (await this.repo.activeUnpublishedChild?.(projectId, body.workflowRunId, templateId))
    )
      throw new ConflictException('此模板已有新分支正在智能成片包装，请等待任务完成');
    // A picture-only delivery already owns a published output branch. Its first package fills
    // the missing mix layer of that same branch; the delivered files remain untouched until the
    // user explicitly asks for a local update. Repackaging an existing package still forks, so
    // the earlier audio arrangement remains editable in its original branch.
    const [activeSource, delivered, packaged] = await Promise.all([
      this.repo.db.workflowRun.findFirst({
        where: {
          projectId,
          id: body.workflowRunId,
          workflow: 'EFFECT',
          workflowSpace: 'EFFECT',
          activeKey: 'ACTIVE',
        },
        select: { id: true },
      }),
      this.repo.db.workingArtifact.findFirst({
        where: {
          projectId,
          workflowRunId: body.workflowRunId,
          nodeId: 'FINAL_OUTPUT',
          artifactKey: `final-delivery:${templateId}`,
        },
        select: { id: true },
      }),
      this.repo.db.workingArtifact.findFirst({
        where: {
          projectId,
          workflowRunId: body.workflowRunId,
          nodeId: 'TEMPLATE_MIX',
          artifactKey: { startsWith: `timeline-package:${templateId}:` },
        },
        select: { id: true },
      }),
    ]);
    const packageInDeliveredRun = Boolean(
      activeSource && delivered && !packaged && !sourceEntry?.packagingLocked,
    );
    // An attempted/cancelled task is not a confirmed package. Only a committed package
    // makes this a repackage; the first batch fills the existing picture-only Run in place.
    const firstBatchInPlace = operation === 'BATCH_PACKAGE' && !packaged;
    let templateScopeActiveRunId: string | undefined;
    if (operation === 'BATCH_PACKAGE' && !activeSource) {
      // Ordinary template navigation does not activate the global Run. Authorize only its
      // resolved current template path, then freeze the global pointer during the clone.
      const [tree, active] = await Promise.all([
        this.working.getEffectBranchTree(projectId),
        this.repo.db.workflowRun.findFirst({
          where: {
            projectId,
            workflow: 'EFFECT',
            workflowSpace: 'EFFECT',
            activeKey: 'ACTIVE',
            status: { in: ['ACTIVE', 'PAUSED'] },
          },
          select: { id: true, editSessionNodeId: true },
        }),
      ]);
      if (
        !active ||
        active.editSessionNodeId ||
        tree.activeWorkflowRunId !== active.id ||
        effectTemplateBranchTips(tree.branches, tree.activeWorkflowRunId, { current: true }).get(
          templateId,
        )?.workflowRunId !== body.workflowRunId
      )
        throw new ConflictException('模板当前分支已变化，请重新读取后再包装');
      templateScopeActiveRunId = active.id;
    }
    const workflowRunId =
      append ||
      body.operation === 'SINGLE_PACKAGE' ||
      firstBatchInPlace ||
      (!operation && packageInDeliveredRun)
        ? body.workflowRunId
        : (
            await this.working.beginEffectNodeEdit(
              projectId,
              body.workflowRunId,
              'TEMPLATE_MIX',
              'BATCH',
              {
                always: true,
                keepParentActive: true,
                ...(operation === 'BATCH_PACKAGE' ? { preservePackagingBaseline: true } : {}),
                ...(templateScopeActiveRunId ? { templateId, templateScopeActiveRunId } : {}),
                expectedNodeStateRevision: body.expectedRevision,
                creationKey: `mix-package:${workflowStateHash(body.idempotencyKey)}`,
              },
            )
          ).run.id;
    const workspace = await this.mix.workspace(projectId, workflowRunId);
    const frozenAppendSource = append
      ? await this.mix.frozenAppendSources(projectId, append.fillRunId)
      : undefined;
    // The clone protocol preserves the source revision. Do not accept an orphan/reused
    // child edited since it was cloned merely because we just read its latest revision.
    if (workspace.draftRevision !== body.expectedRevision)
      throw new ConflictException('草稿已改变，请刷新后重试');
    const entry = workspace.draft.templates.find((t) => t.id === templateId);
    if (!entry) throw new NotFoundException('模板不存在');
    if (
      frozenAppendSource &&
      workflowStateHash(entry.workspace.template) !== frozenAppendSource.templateHash
    )
      throw new ConflictException('模板已变化，不能继续原局部更新包装');
    // Recheck after forking: a source edit racing the initial read must not silently enter packaging.
    if (
      !append &&
      (workspace.pendingAddedMaterialIds?.[templateId]?.length ||
        entry.workspace.variants.some(
          (variant) => effectTemplateMixSourceChanges(variant, workspace.materials).length > 0,
        ))
    )
      throw new ConflictException('当前模板有素材待更新，请先完成局部更新，再进行智能成片包装。');
    if (!append && entry.needsAiFill)
      throw new ConflictException(
        '模板已改动，或仍有成片未按当前模板重新智能填充；请完成需要更新的成片后再包装',
      );
    const baselineVariants = entry.workspace.variants
      .filter(
        (v) =>
          (append
            ? append.variantIds.includes(v.id)
            : !body.variantId || v.id === body.variantId) && v.slots.some((s) => v.bindings[s.id]),
      )
      .map((variant) => structuredClone(variant));
    const history = await this.repo.list(projectId, workflowRunId, templateId);
    const variants = operation
      ? baselineVariants.map((variant) =>
          packagingPictureOnlyVariant(
            variant,
            history
              .flatMap((run) => run.items)
              .find((item) => item.variantId === variant.id && item.status === 'COMPLETED')
              ?.checkpoint as PackagingCheckpoint | undefined,
          ),
        )
      : baselineVariants;
    if (!variants.length) throw new BadRequestException('没有可包装的视频成片');
    if (append && variants.length !== append.variantIds.length)
      throw new ConflictException('新增成片工程已变化，不能包装旧目标');
    if (body.component && !['ALL', 'CAPTIONS'].includes(body.component) && !body.variantId)
      throw new BadRequestException('局部重做必须选择一条成片');
    if (
      body.slotId &&
      (!body.variantId ||
        body.component !== 'VOICE' ||
        !variants[0]?.slots.some((s) => s.id === body.slotId && variants[0]?.bindings[s.id]))
    )
      throw new BadRequestException('单槽位重做必须选择当前成片中的口播槽位');
    const artifacts = (await this.working.listArtifacts(projectId, { workflowRunId })).items;
    const musicAssetIds = [
      ...new Set(
        variants.flatMap((variant) =>
          (variant.detachedAudios ?? [])
            .map((audio) => audio.sourceAssetId)
            .filter((id): id is string => Boolean(id)),
        ),
      ),
    ];
    const musicAssets = musicAssetIds.length
      ? await this.repo.db.asset.findMany({
          where: {
            projectId,
            id: { in: musicAssetIds },
            directory: 'AUDIO_ASSETS',
            type: 'VOICE_AUDIO',
            status: 'AVAILABLE',
            archivedAt: null,
            tags: { has: '模板混剪音乐库' },
          },
          select: {
            id: true,
            storageKey: true,
            sizeBytes: true,
            mimeType: true,
            originalFileName: true,
          },
        })
      : [];
    const musicFileObjects = musicAssets.length
      ? await this.repo.db.fileObject.findMany({
          where: {
            projectId,
            storageKey: { in: musicAssets.map((asset) => asset.storageKey) },
            status: 'AVAILABLE',
          },
          select: { id: true, storageKey: true, sizeBytes: true, mimeType: true },
        })
      : [];
    const musicFileByStorageKey = new Map(musicFileObjects.map((file) => [file.storageKey, file]));
    const musicSources = new Map<string, { fileObjectId: string; sourceDuration: number }>();
    for (const audio of variants.flatMap((variant) => variant.detachedAudios ?? [])) {
      if (!audio.sourceAssetId) continue;
      const asset = musicAssets.find(({ id }) => id === audio.sourceAssetId);
      const file = asset ? musicFileByStorageKey.get(asset.storageKey) : undefined;
      const audioMime = (asset?.mimeType ?? file?.mimeType ?? '').toLowerCase();
      const audioExtension = /\.(mp3|wav|m4a|aac|flac|ogg|opus|wma)$/i.test(
        asset?.originalFileName ?? '',
      );
      if (
        !asset ||
        !file ||
        file.sizeBytes !== asset.sizeBytes ||
        (!audioMime.startsWith('audio/') && !audioExtension) ||
        !Number.isFinite(audio.sourceDuration) ||
        audio.fileObjectId !== file.id
      )
        throw new BadRequestException('音乐素材已失效或不属于当前项目，请重新导入');
      musicSources.set(asset.id, { fileObjectId: file.id, sourceDuration: audio.sourceDuration! });
    }
    const snapshots = variants.map((v) => {
      const snapshot = packagingSnapshot(
        v,
        workspace.materials,
        artifacts,
        musicSources,
        frozenAppendSource,
      );
      if (operation) {
        snapshot.operation = operation;
        snapshot.baselineVariant = baselineVariants.find((variant) => variant.id === v.id)!;
      }
      if (append) snapshot.incrementalFillRunId = append.fillRunId;
      return snapshot;
    });
    if (!body.component || body.component === 'ALL' || body.component === 'VOICE') {
      const voiceProfile = this.voiceCatalog.selection(entry.workspace.template.voiceProfileId);
      const revoked = await this.repo.db.effectVoicePreview.findFirst({
        where: {
          errorCode: 'UNAUTHORIZED',
          AND: [
            { snapshot: { path: ['profile', 'id'], equals: voiceProfile.id } },
            { snapshot: { path: ['profile', 'version'], equals: voiceProfile.version } },
          ],
        },
        select: { id: true },
      });
      if (revoked) throw new BadRequestException('所选音色未获授权，请重新选择已验证音色');
      for (const snapshot of snapshots) snapshot.voiceProfile = voiceProfile;
    }
    const checkpoints: PackagingCheckpoint[] = snapshots.map(() => ({
      narrationLayoutVersion: 'SLOT_V1',
    }));
    const visionCache = new Map(
      history
        .flatMap((r) => r.items)
        .flatMap((i) =>
          Object.values((i.checkpoint as PackagingCheckpoint).slotVision ?? {}).map(
            (v) => [v.key, v] as const,
          ),
        ),
    );
    snapshots.forEach((snapshot, index) => {
      const rows = snapshot.clips.flatMap((clip) => {
        const cached = visionCache.get(slotVisionKey(clip));
        return cached ? [[clip.slotId, cached] as const] : [];
      });
      if (rows.length) checkpoints[index]!.slotVision = Object.fromEntries(rows);
    });
    if (body.component && body.component !== 'ALL')
      for (const [index, variant] of variants.entries()) {
        const previous = history
          .flatMap((r) => r.items)
          .find(
            (i) =>
              i.variantId === variant.id &&
              matchesVisualHash(
                snapshots[index]!.variant,
                i.sourceTimelineHash,
                (i.snapshot as unknown as PackagingSnapshot).variant,
              ) &&
              (i.snapshot as unknown as PackagingSnapshot).dependencies.every((d) =>
                artifacts.some(
                  (a) =>
                    a.id === d.artifactId && a.revision === d.revision && a.freshness === 'CURRENT',
                ),
              ),
          );
        if (!previous) throw new ConflictException('没有可复用的当前包装，请先生成完整包装');
        if ((previous.checkpoint as PackagingCheckpoint).narrationLayoutVersion !== 'SLOT_V1')
          throw new ConflictException('旧版整片口播请重做整条包装，不能局部套用槽位规则');
        // Keep legacy file lineage for semantically identical frozen visuals.
        snapshots[index]!.sourceTimelineHash = previous.sourceTimelineHash;
        snapshots[index]!.variant = (previous.snapshot as unknown as PackagingSnapshot).variant;
        if (body.component !== 'VOICE') {
          const frozenVoice = (previous.snapshot as unknown as PackagingSnapshot).voiceProfile;
          if (frozenVoice) snapshots[index]!.voiceProfile = frozenVoice;
        }
        // A previous run may carry editor-edited geometry; restore pipeline-canonical
        // audio before the worker write path re-validates it strictly.
        const cp =
          body.slotId || body.component === 'CAPTIONS'
            ? (structuredClone(previous.checkpoint) as PackagingCheckpoint)
            : canonicalizeCheckpoint(
                snapshots[index]!,
                structuredClone(previous.checkpoint) as PackagingCheckpoint,
              );
        if (body.component === 'CAPTIONS') snapshots[index]!.redoCaptionsOnly = true;
        delete cp.automaticRetries; // A user-requested component redo is a new task, not a resume.
        if (body.component === 'VOICE') {
          if (body.slotId) {
            if (cp.narrationMetrics) delete cp.narrationMetrics[body.slotId];
            if (cp.voiceFitAttempts) delete cp.voiceFitAttempts[body.slotId];
            if (cp.voiceSlotRetries) delete cp.voiceSlotRetries[body.slotId];
            snapshots[index]!.redoSlotId = body.slotId;
            const removed = new Set(
              cp.script?.filter((s) => s.slotId === body.slotId).map((s) => s.id),
            );
            cp.script = (cp.script ?? []).filter((s) => s.slotId !== body.slotId);
            cp.voices = Object.fromEntries(
              Object.entries(cp.voices ?? {}).filter(([id]) => !removed.has(id)),
            );
            cp.captions = (cp.captions ?? []).filter((c) => !removed.has(c.voiceLineId ?? c.id));
          } else {
            delete cp.narrationMetrics;
            delete cp.voiceFitAttempts;
            delete cp.voiceSlotRetries;
            delete cp.script;
            delete cp.voices;
            delete cp.captions;
          }
        }
        if (body.component === 'MUSIC') {
          delete cp.music;
          delete cp.musicTaskId;
          delete cp.musicSubmissionPending;
        }
        if (body.component === 'CAPTIONS') {
          if (Object.values(cp.voices ?? {}).some((audio) => !audio.speechRanges?.length))
            throw new BadRequestException(
              '口播缺少本次合成的字词时间戳，不能严格对齐字幕；请重新生成该槽位口播',
            );
          delete cp.captions;
        }
        checkpoints[index] = cp;
      }
    if (body.component !== 'MUSIC')
      for (const snapshot of snapshots) snapshot.captionTimingPolicy = 'SYNTHESIS_WORDS_V1';
    const id = await this.repo.create({
      projectId,
      workflowRunId,
      templateId,
      ...(operation ? { sourceWorkflowRunId: body.workflowRunId } : {}),
      idempotencyKey: body.idempotencyKey,
      requestHash,
      snapshots,
      checkpoints,
      expectedDraftRevision: body.expectedRevision,
      expectedSourceDraftRevision: body.expectedRevision,
      expectedTemplateHash: templateConfigurationHash(entry.workspace.template),
    });
    return this.get(projectId, id);
  }
  async get(projectId: string, id: string): Promise<PackagingRun> {
    const run = await this.repo.get(projectId, id);
    if (!run) throw new NotFoundException('包装任务不存在');
    await this.assertReadScope(projectId, run.workflowRunId);
    return this.present(run, await this.presentationSources(projectId, [run]));
  }
  private frozenMaterialName(
    snapshot: PackagingSnapshot,
    clip: PackagingSnapshot['clips'][number],
  ) {
    const name = [clip.materialCode, clip.materialName].filter(Boolean).join(' · ');
    if (name) return name;
    const adopted = snapshot.variant.bindingSources?.[clip.slotId];
    return adopted && (adopted.id === clip.materialId || adopted.artifactId === clip.materialId)
      ? [adopted.code, adopted.name].filter(Boolean).join(' · ')
      : '';
  }
  private async presentationSources(
    projectId: string,
    runs: PackagingRunRow[],
  ): Promise<PackagingPresentation> {
    const missing = new Set<string>();
    for (const run of runs)
      for (const item of run.items) {
        const snapshot = item.snapshot as unknown as PackagingSnapshot;
        for (const clip of snapshot.clips ?? [])
          if (!this.frozenMaterialName(snapshot, clip)) missing.add(clip.materialId);
      }
    // Progress comes from durable task rows. Do not hydrate editable timelines,
    // source freshness or the whole project merely to display a task's clip names.
    return {
      materials: missing.size ? await this.repo.materialLabels(projectId, [...missing]) : [],
    };
  }
  private presentItems(run: PackagingRunRow, workspace: PackagingPresentation): PackagingItem[] {
    return run.items.map((i) => {
      const snapshot = i.snapshot as unknown as PackagingSnapshot;
      const checkpoint = { ...(i.checkpoint as PackagingCheckpoint) };
      delete checkpoint.musicTaskId;
      delete checkpoint.musicSubmissionPending;
      const referencedFactIds = new Set(
        (checkpoint.script ?? []).flatMap(({ factIds }) => factIds),
      );
      return {
        ...(snapshot.operation
          ? { operation: snapshot.operation, workflowRunId: run.workflowRunId }
          : {}),
        id: i.id,
        runId: run.id,
        variantId: i.variantId,
        name: i.name,
        shardIndex: i.shardIndex,
        sourceTimelineHash: i.sourceTimelineHash,
        sourceVisualTimeline: packagingVisualTimeline(snapshot.variant),
        sourceClips: (snapshot.clips ?? []).map((clip) => {
          const slot = snapshot.variant.slots.find(({ id }) => id === clip.slotId);
          const material = (workspace.materials ?? []).find(({ id }) => id === clip.materialId);
          const materialName =
            this.frozenMaterialName(snapshot, clip) ||
            (material
              ? [material.code, material.name].filter(Boolean).join(' · ')
              : '来源视频素材');
          return {
            slotLabel: slot?.label ?? '镜头',
            materialName,
            sourceOffset: clip.offset,
            timelineStart: clip.start,
            duration: clip.duration,
            transition: clip.transition,
            transitionDuration: clip.transitionDuration,
            originalAudioDetached: clip.originalAudioDetached ?? false,
          };
        }),
        sourceFacts: (snapshot.facts ?? [])
          .filter(({ id }) => referencedFactIds.has(id))
          .map(({ id, text }) => ({ id, text })),
        stage: i.stage as PackagingStage,
        status: i.status as PackagingRun['status'],
        checkpoint,
        errorMessage: i.errorMessage,
        startedAt: i.startedAt?.toISOString() ?? null,
        completedAt: i.completedAt?.toISOString() ?? null,
        updatedAt: i.updatedAt.toISOString(),
      };
    });
  }
  private present(run: PackagingRunRow, workspace: PackagingPresentation): PackagingRun {
    const items = this.presentItems(run, workspace);
    return {
      ...(items[0]?.operation ? { operation: items[0].operation } : {}),
      id: run.id,
      templateId: run.templateId,
      workflowRunId: run.workflowRunId,
      status: run.status as PackagingRun['status'],
      createdAt: run.createdAt.toISOString(),
      startedAt: run.startedAt?.toISOString() ?? null,
      completedAt: run.completedAt?.toISOString() ?? null,
      items,
      execution: packagingExecution(
        items,
        run.startedAt,
        run.completedAt,
        run.status,
        Number(process.env.TEMPLATE_MIX_PACKAGING_ITEM_CONCURRENCY) || 6,
        Date.now(),
        run.items.length > 0 &&
          run.items.every(
            (item) => (item.snapshot as unknown as PackagingSnapshot).redoCaptionsOnly,
          ),
      ),
      counts: {
        total: items.length,
        completed: items.filter((i) => i.status === 'COMPLETED').length,
        failed: items.filter((i) => i.status === 'FAILED').length,
        shards: new Set(items.map((i) => i.shardIndex)).size,
      },
    };
  }
  /** A completed checkpoint remains editable after its source moves on; staleness is provenance, not a lock. */
  private async editableItem(projectId: string, runId: string, itemId: string) {
    const raw = await this.repo.get(projectId, runId);
    const item = raw?.items.find((i) => i.id === itemId);
    if (!raw || !item) throw new NotFoundException('包装成片不存在');
    if (item.status !== 'COMPLETED') throw new ConflictException('包装尚未完成，无法编辑音频');
    const workspace = await this.mix.workspace(projectId, raw.workflowRunId);
    const snapshot = item.snapshot as unknown as PackagingSnapshot;
    const entry = workspace.draft.templates.find((t) => t.id === raw.templateId);
    const variant = entry?.workspace.variants.find((v) => v.id === item.variantId);
    if (!entry || !variant) throw new ConflictException('对应的混剪工程不存在，无法编辑音频');
    return { raw, item, snapshot, workspace, entry, variant };
  }
  /** Editor audio edits: only geometry/volume are trusted, never the client's file identity. */
  async updateAudio(
    projectId: string,
    runId: string,
    itemId: string,
    body: UpdatePackagingAudioRequest,
  ): Promise<PackagingItem> {
    const { raw, item, snapshot, workspace } = await this.editableItem(projectId, runId, itemId);
    const old = item.checkpoint as PackagingCheckpoint;
    let voices = old.voices;
    // A narration is an optional overlay on its script line, so deleting one drops the key and
    // nothing else: the line and its subtitle stay, and the film simply has no speech there. A
    // re-packaging synthesizes every line again. An unknown id is ignored rather than refused,
    // because the editor may be deleting a clip a concurrent redo already dropped.
    if (body.removedVoices?.length) {
      voices = { ...(old.voices ?? {}) };
      // An edit and a delete are the same field, so the edit wins if a client sends both for one id,
      // matching the music bed's rule.
      for (const id of body.removedVoices) if (!body.voices?.[id]) delete voices[id];
    }
    if (body.voices) {
      // Copied from the map the delete above produced, so one request may both drop a clip and move
      // another.
      voices = { ...(voices ?? {}) };
      for (const [id, edit] of Object.entries(body.voices)) {
        const current = Object.hasOwn(voices, id) ? voices[id] : undefined;
        if (!current) throw new BadRequestException('口播音频不存在');
        const offset = edit.offset ?? 0;
        const length = edit.duration ?? current.duration;
        // The stored copy is canonical, so its head offset plus length is the real source tail.
        const available = (current.offset ?? 0) + current.duration;
        if (offset < 0 || length <= 0 || offset + length > available + 0.05)
          throw new BadRequestException('口播裁剪超出音频长度');
        voices[id] = {
          ...current,
          start: edit.start,
          volume: edit.volume,
          offset,
          duration: length,
          ...fadeFields(length, current, edit),
        };
      }
    }
    // A generated caption narration is trimmed and moved exactly like a narration line, but nothing
    // follows it: the caption owns the narration here, not the other way round.
    let captionVoices = old.captionVoices;
    if (body.removedCaptionVoices?.length) {
      // A caption narration is keyed by caption and depends on nothing else, so a delete is just the
      // entry going away. An unknown id is ignored rather than refused: the editor may be deleting a
      // clip a concurrent redo already dropped.
      captionVoices = { ...(old.captionVoices ?? {}) };
      for (const id of body.removedCaptionVoices) delete captionVoices[id];
    }
    if (body.captionVoices) {
      captionVoices = { ...(captionVoices ?? {}) };
      for (const [id, edit] of Object.entries(body.captionVoices)) {
        const current = Object.hasOwn(captionVoices, id) ? captionVoices[id] : undefined;
        if (!current) throw new BadRequestException('字幕口播不存在');
        const offset = edit.offset ?? 0;
        const length = edit.duration ?? current.duration;
        const available = (current.offset ?? 0) + current.duration;
        if (offset < 0 || length <= 0 || offset + length > available + 0.05)
          throw new BadRequestException('字幕口播裁剪超出音频长度');
        captionVoices[id] = {
          ...current,
          start: edit.start,
          volume: edit.volume,
          offset,
          duration: length,
          ...fadeFields(length, current, edit),
        };
      }
    }
    let music = old.music;
    // An edit and a delete are the same field, so the edit wins if a client somehow sends both.
    if (body.removeMusic && !body.music) music = undefined;
    if (body.music) {
      if (!old.music) throw new BadRequestException('纯音乐音频不存在');
      const offset = body.music.offset ?? 0;
      const length = body.music.duration ?? old.music.duration;
      if (offset < 0 || length <= 0) throw new BadRequestException('纯音乐裁剪长度无效');
      music = {
        ...old.music,
        start: body.music.start,
        volume: body.music.volume,
        offset,
        duration: length,
        ...fadeFields(length, old.music, body.music),
      };
    }
    const oldCaptionsById = new Map((old.captions ?? []).map((caption) => [caption.id, caption]));
    const captions = body.captions
      ? [...body.captions]
          .sort((left, right) => left.start - right.start)
          .map(({ id, text, start, end, manual, trackId }) => {
            const previous = oldCaptionsById.get(id);
            // A track of its own is editor geometry, exactly like `start`/`end`: it is what makes a
            // subtitle a row of its own, and a narration card may have one just as a manual card may.
            // An id adopts that row, an explicit `null` clears it back to the implicit one, and
            // leaving the field out keeps the row as it is — so a card can neither lose its row by
            // accident nor stay pinned to one it has been moved off.
            const resolvedTrackId = trackId === null ? undefined : (trackId ?? previous?.trackId);
            return {
              id,
              ...(previous?.manual || (!previous && manual === true) ? { manual: true } : {}),
              ...(resolvedTrackId ? { trackId: resolvedTrackId } : {}),
              ...(previous?.voiceLineId
                ? {
                    voiceLineId: previous.voiceLineId,
                    segmentIndex: previous.segmentIndex,
                    segmentCount: previous.segmentCount,
                  }
                : {}),
              text,
              start,
              end,
            };
          })
      : old.captions;
    let captionBoxes = old.captionBoxes;
    if (body.boxes) {
      captionBoxes = { ...(old.captionBoxes ?? {}) };
      for (const [id, box] of Object.entries(body.boxes)) {
        if (!captions?.some((c) => c.id === id)) throw new BadRequestException('字幕不存在');
        // Rebuilt field by field so a client cannot smuggle extra keys into the checkpoint.
        captionBoxes[id] = { x: box.x, y: box.y, width: box.width, scale: box.scale };
      }
    }
    const next: PackagingCheckpoint = { ...old };
    if (body.captionFontSize !== undefined) next.captionFontSize = body.captionFontSize;
    if (voices) next.voices = voices;
    // `next` starts as a copy of the old checkpoint, so a deleted bed has to be taken off it rather
    // than merely left unwritten. A request that simply says nothing about the music keeps it.
    if (music) next.music = music;
    else if (body.removeMusic) delete next.music;
    if (captions) next.captions = captions;
    if (captionVoices) next.captionVoices = captionVoices;
    if (old.narrationLayoutVersion === 'SLOT_V1' && body.voices && !body.captions && next.captions)
      next.captions = next.captions.map((c) => {
        const lineId = c.voiceLineId ?? c.id;
        const voice = voices?.[lineId];
        if (!body.voices?.[lineId] || !voice) return c;
        if (!old.captionLayoutVersion)
          return { ...c, start: voice.start, end: voice.start + voice.duration };
        const previous = old.voices?.[lineId];
        if (!previous) return c;
        // Trimming is not time-stretching. Source speech timestamps move by the placement/cut
        // delta; scaling them by the trimmed length makes later words appear early again.
        const shift = voice.start - previous.start - (voice.offset ?? 0) + (previous.offset ?? 0);
        return {
          ...c,
          start: Math.max(0, c.start + shift),
          end: Math.max(0.001, c.end + shift),
        };
      });
    if (captionBoxes) next.captionBoxes = captionBoxes;
    validatePackagingCheckpoint(snapshot, next, true, true);
    const saved = await this.repo.updateCheckpoint(projectId, itemId, next, body.expectedUpdatedAt);
    return this.presentItems({ ...raw, items: [saved] }, workspace)[0]!;
  }
  /**
   * Ask the worker to speak one caption's text again with the template's current voice.
   *
   * The template's choice wins over the item's frozen profile: the editor may switch voices after
   * packaging, and a newly generated line is exactly what that switch is for. Existing narration is
   * left untouched, so the frozen profile is only the fallback for a template with no voice picked.
   *
   * `body.text` is an assertion, never the text to speak: synthesis reads the caption the server has
   * stored, so a client cannot spend the project's paid voice budget on arbitrary words, and an
   * editor that is still inside its save debounce is told to save instead of quietly being voiced
   * from the previous revision.
   */
  async requestCaptionVoice(
    projectId: string,
    runId: string,
    itemId: string,
    body: CreatePackagingCaptionVoiceRequest,
  ) {
    const { item, snapshot, entry } = await this.editableItem(projectId, runId, itemId);
    const caption = (item.checkpoint as PackagingCheckpoint).captions?.find(
      (c) => c.id === body.captionId,
    );
    if (!caption) throw new NotFoundException('字幕不存在');
    if (caption.text !== body.text) throw new ConflictException('字幕文本尚未保存，请稍后重试');
    if (!caption.text.trim()) throw new BadRequestException('字幕文本为空，无法生成口播');
    const templateVoiceId = entry.workspace.template.voiceProfileId;
    const profile = templateVoiceId
      ? this.voiceCatalog.selection(templateVoiceId)
      : (snapshot.voiceProfile ?? this.voiceCatalog.selection());
    const requestId = randomUUID();
    await this.repo.enqueueCaptionVoice({
      schemaVersion: 2,
      taskType: 'CAPTION_VOICE',
      projectId,
      runId,
      itemId,
      captionId: caption.id,
      text: caption.text,
      profile,
      requestId,
    });
    return { requestId };
  }
  /**
   * The worker's write-back for {@link requestCaptionVoice}. There is no packaging lease to hold
   * here — the editor asked for this, not a run — so the worker token is the guard and the write is
   * idempotent by caption: the same bytes arriving twice (a redelivered message) leave the clip
   * alone, while different bytes are a legitimate regeneration and replace it.
   */
  async uploadCaptionVoice(
    projectId: string,
    runId: string,
    itemId: string,
    captionId: string,
    file: { path: string; size: number } | undefined,
  ) {
    if (!file || file.size > 100 * 1024 * 1024) throw new BadRequestException('字幕口播音频无效');
    const raw = await this.repo.get(projectId, runId);
    const item = raw?.items.find((i) => i.id === itemId);
    if (!raw || !item) throw new NotFoundException('包装成片不存在');
    if (item.status !== 'COMPLETED') throw new ConflictException('包装尚未完成，无法写入口播');
    const snapshot = item.snapshot as unknown as PackagingSnapshot;
    if (!(item.checkpoint as PackagingCheckpoint).captions?.some((c) => c.id === captionId))
      throw new NotFoundException('字幕不存在');
    const duration = await wavDuration(file.path, file.size);
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file.path)) hash.update(chunk);
    const sha256 = hash.digest('hex');
    const role = `caption-voice-${captionId}`;
    const existing = await this.repo.db.effectPackagingFile.findUnique({
      where: { projectId_itemId_role: { projectId, itemId, role } },
      include: { fileObject: true },
    });
    if (existing?.fileObject.sha256 === sha256) return { fileObjectId: existing.fileObjectId };
    const project = await this.repo.db.project.findUniqueOrThrow({ where: { id: projectId } });
    const stored = await this.storage.put({
      projectId,
      stream: createReadStream(file.path),
      sizeBytes: file.size,
      contentType: 'audio/wav',
      keyContext: {
        projectName: project.name,
        workflow: 'effect',
        lifecycle: 'staging',
        category: 'timeline-package',
        originalFileName: `${itemId}-${role}.wav`,
      },
    });
    try {
      return await this.repo.db.$transaction(async (tx) => {
        const created = await tx.fileObject.create({
          data: {
            projectId,
            workflowRunId: raw.workflowRunId,
            nodeId: 'TEMPLATE_MIX',
            originalFileName: `${item.variantId}-${role}.wav`,
            mimeType: 'audio/wav',
            sizeBytes: file.size,
            storageKey: stored.key,
            sha256,
          },
        });
        await tx.effectPackagingFile.upsert({
          where: { projectId_itemId_role: { projectId, itemId, role } },
          create: { projectId, itemId, role, fileObjectId: created.id },
          update: { fileObjectId: created.id },
        });
        const current = await tx.effectPackagingItem.findUniqueOrThrow({ where: { id: itemId } });
        const checkpoint = current.checkpoint as PackagingCheckpoint;
        const caption = checkpoint.captions?.find((c) => c.id === captionId);
        if (!caption) throw new NotFoundException('字幕不存在');
        const next: PackagingCheckpoint = {
          ...checkpoint,
          captionVoices: {
            ...checkpoint.captionVoices,
            // Aligned on the caption by construction — this is the one place that knows both.
            [captionId]: {
              ...(snapshot.voiceProfile ? { voiceProfile: snapshot.voiceProfile } : {}),
              fileObjectId: created.id,
              duration,
              start: caption.start,
              volume: 1,
            },
          },
        };
        validatePackagingCheckpoint(snapshot, next, true, true);
        await tx.effectPackagingItem.update({
          where: { id: itemId },
          data: { checkpoint: JSON.parse(JSON.stringify(next)) },
        });
        return { fileObjectId: created.id };
      });
    } catch (error) {
      await this.storage.delete(stored.key).catch(() => undefined);
      throw error;
    }
  }
  async list(projectId: string, workflowRunId: string, templateId: string) {
    await this.assertReadScope(projectId, workflowRunId);
    const runs = await this.repo.list(projectId, workflowRunId, templateId);
    if (!runs.length) return [];
    const workspace = await this.presentationSources(projectId, runs);
    return runs.map((run) => this.present(run, workspace));
  }
  async latestBackground(projectId: string, workflowRunId: string, templateId: string) {
    await this.assertReadScope(projectId, workflowRunId);
    const run = await this.repo.latestChild(projectId, workflowRunId, templateId);
    if (!run) return null;
    return this.present(run, await this.presentationSources(projectId, [run]));
  }
  private async assertReadScope(projectId: string, workflowRunId: string) {
    await this.projects.get(projectId);
    if (!(await this.repo.readRunScope(projectId, workflowRunId)))
      throw new NotFoundException('工作流运行不存在');
  }
  async retry(projectId: string, id: string) {
    const run = await this.get(projectId, id);
    if (
      run.items.some(
        (i) => i.status !== 'COMPLETED' && i.checkpoint?.narrationLayoutVersion !== 'SLOT_V1',
      )
    )
      throw new ConflictException('旧版任务不能恢复，请按槽位重新包装');
    return this.repo.retry(projectId, id);
  }
  async sourceTrims(
    projectId: string,
    runId: string,
    token: string,
    itemId: string,
    trims: FinalOutputSourceTrim[],
  ) {
    const { run } = await this.workerItem(projectId, runId, token, itemId);
    return this.repo.db.$transaction(async (tx) => {
      const renewed = await tx.effectPackagingRun.updateMany({
        where: {
          id: runId,
          projectId,
          status: 'RUNNING',
          attemptToken: token,
          leaseExpiresAt: { gt: new Date() },
        },
        data: { leaseExpiresAt: new Date(Date.now() + 120_000) },
      });
      if (!renewed.count) throw new ConflictException('包装任务租约已失效');
      await tx.$queryRaw`SELECT id FROM workflow_node_states WHERE "projectId"=${projectId}::uuid AND "workflowRunId"=${run.workflowRunId}::uuid AND "nodeId"='TEMPLATE_MIX' FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM effect_packaging_items WHERE id=${itemId}::uuid AND "projectId"=${projectId}::uuid FOR UPDATE`;
      const item = await tx.effectPackagingItem.findFirstOrThrow({
        where: { projectId, id: itemId, runId },
      });
      const snapshot = item.snapshot as unknown as PackagingSnapshot;
      if (!snapshot.sourceTrimMaterials?.length)
        throw new ConflictException('本任务没有待重新选区的素材');
      for (const dependency of [...snapshot.dependencies].sort((a, b) =>
        a.artifactId.localeCompare(b.artifactId),
      )) {
        await tx.$queryRaw`SELECT id FROM working_artifacts WHERE id=${dependency.artifactId}::uuid AND "projectId"=${projectId}::uuid FOR SHARE`;
        const current = await tx.workingArtifact.findFirst({
          where: {
            projectId,
            id: dependency.artifactId,
            revision: dependency.revision,
            contentHash: dependency.contentHash,
            freshness: 'CURRENT',
            availability: 'AVAILABLE',
          },
        });
        if (!current) throw new ConflictException('素材或包装输入再次发生变化，请重新包装');
      }
      if (snapshot.sourceTrimsReady) return { snapshot };
      const state = await tx.workflowNodeState.findUniqueOrThrow({
        where: {
          projectId_workflowRunId_nodeId: {
            projectId,
            workflowRunId: run.workflowRunId,
            nodeId: 'TEMPLATE_MIX',
          },
        },
      });
      const draft = state.state as unknown as EffectTemplateMixDraft;
      const baseline = draft.templates
        .find((entry) => entry.id === run.templateId)
        ?.workspace.variants.find((variant) => variant.id === item.variantId);
      if (
        !baseline ||
        workflowStateHash(baseline) !==
          workflowStateHash(snapshot.baselineVariant ?? snapshot.variant)
      )
        throw new ConflictException('包装执行期间该成片工程已被修改');
      const variant = snapshot.operation ? structuredClone(snapshot.variant) : baseline;
      if (
        trims.length !== snapshot.sourceTrimMaterials.length ||
        new Set(trims.map((row) => row.slotId)).size !== trims.length
      )
        throw new BadRequestException('截取结果缺失或重复');
      for (const trim of trims) {
        const source = snapshot.sourceTrimMaterials.find((row) => row.slotId === trim.slotId);
        const clip = snapshot.clips.find((row) => row.slotId === trim.slotId);
        if (
          !source ||
          !clip ||
          !Number.isFinite(trim.offset) ||
          trim.offset < 0 ||
          trim.offset + clip.duration > source.material.duration + 0.001
        )
          throw new BadRequestException('模型截取区间超出素材长度');
        const current = await tx.workingArtifact.findFirst({
          where: {
            projectId,
            id: source.material.artifactId,
            revision: source.material.artifactRevision,
            freshness: 'CURRENT',
            availability: 'AVAILABLE',
          },
        });
        if (
          !current ||
          (current.payload as { fileObjectId?: string }).fileObjectId !==
            source.material.fileObjectId
        )
          throw new ConflictException('素材再次发生变化，请重新包装');
        variant.offsets[trim.slotId] = trim.offset;
        snapshot.variant.offsets[trim.slotId] = trim.offset;
        clip.offset = trim.offset;
        for (const audio of variant.detachedAudios ?? [])
          if (audio.sourceSlotId === trim.slotId) audio.offset = trim.offset;
      }
      snapshot.variant = variant;
      snapshot.detachedAudios = variant.detachedAudios ?? [];
      snapshot.sourceTimelineHash = visualHash(variant);
      snapshot.sourceTrimsReady = true;
      if (!snapshot.operation)
        await tx.workflowNodeState.update({
          where: { id: state.id },
          data: {
            state: JSON.parse(JSON.stringify(draft)),
            contentHash: workflowStateHash(draft),
            revision: { increment: 1 },
          },
        });
      await tx.effectPackagingItem.update({
        where: { id: itemId },
        data: {
          snapshot: JSON.parse(JSON.stringify(snapshot)),
          sourceTimelineHash: snapshot.sourceTimelineHash,
        },
      });
      return { snapshot };
    });
  }

  async workerItem(projectId: string, runId: string, token: string, itemId: string) {
    await this.repo.authorized(projectId, runId, token);
    const item = await this.repo.getItem(projectId, runId, itemId);
    if (!item) throw new NotFoundException('包装成片不存在');
    const run = item.run;
    const snapshot = item.snapshot as unknown as PackagingSnapshot;
    const [variant, artifacts] = await Promise.all([
      this.mix.currentVariant(projectId, run.workflowRunId, run.templateId, item.variantId),
      this.repo.sourceArtifacts(projectId, run.workflowRunId, [
        ...new Set(snapshot.dependencies.map((dependency) => dependency.artifactId)),
      ]),
    ]);
    if (snapshot.sourceOperation?.protocol === 'FROZEN_RENDER_V1') {
      const workspace = await this.mix.workspace(projectId, run.workflowRunId);
      const template = workspace.draft.templates.find((entry) => entry.id === run.templateId)
        ?.workspace.template;
      const files = await this.repo.db.fileObject.findMany({
        where: {
          projectId,
          id: { in: snapshot.clips.map((clip) => clip.fileObjectId) },
          status: 'AVAILABLE',
        },
      });
      if (
        !variant ||
        !template ||
        workflowStateHash(template) !== snapshot.sourceOperation.templateHash ||
        workflowStateHash(variant) !==
          workflowStateHash(snapshot.baselineVariant ?? snapshot.variant) ||
        snapshot.clips.some(
          (clip) =>
            !files.some(
              (file) => file.id === clip.fileObjectId && file.sha256 === clip.contentHash,
            ),
        )
      )
        throw new ConflictException('包装执行期间该成片工程被编辑或冻结文件不可用');
      return { run, item, snapshot };
    }
    if (
      !variant ||
      (snapshot.operation &&
        workflowStateHash(variant) !== workflowStateHash(snapshot.baselineVariant)) ||
      (snapshot.sourceTrimMaterials?.length &&
        workflowStateHash(variant) !== workflowStateHash(snapshot.variant)) ||
      snapshot.dependencies.some(
        (dependency) =>
          !artifacts.some(
            (artifact) =>
              artifact.id === dependency.artifactId &&
              artifact.revision === dependency.revision &&
              artifact.freshness === 'CURRENT' &&
              artifact.availability === 'AVAILABLE',
          ),
      )
    )
      throw new ConflictException('包装执行期间输入工程发生变化，请重新发起包装');
    return { run, item, snapshot };
  }
  async checkpoint(
    projectId: string,
    runId: string,
    token: string,
    itemId: string,
    stage: PackagingStage,
    patch: PackagingCheckpoint,
    errorMessage?: string,
  ) {
    const existing = await this.repo.getItem(projectId, runId, itemId);
    if (existing?.status === 'COMPLETED') {
      await this.repo.authorized(projectId, runId, token);
      return { accepted: true };
    }
    // Failure writes must be accepted even when the source changed during execution.
    if (errorMessage) {
      await this.repo.authorized(projectId, runId, token);
      if (!(await this.repo.getItem(projectId, runId, itemId)))
        throw new NotFoundException('包装成片不存在');
      return this.repo.checkpoint(projectId, runId, token, itemId, stage, {}, errorMessage);
    }
    const { snapshot, item, run } = await this.workerItem(projectId, runId, token, itemId);
    const old = item.checkpoint as PackagingCheckpoint;
    if (snapshot.captionTimingPolicy === 'SYNTHESIS_WORDS_V1')
      for (const [lineId, audio] of Object.entries(patch.voices ?? {})) {
        const saved = old.voices?.[lineId];
        if (
          audio.speechRanges &&
          (!saved?.speechRanges ||
            saved.fileObjectId !== audio.fileObjectId ||
            workflowStateHash(saved.speechRanges) !== workflowStateHash(audio.speechRanges))
        )
          throw new BadRequestException('口播字词时间戳与已上传音频不一致');
      }
    const next = { ...old, ...patch, voices: { ...old.voices, ...patch.voices } };
    validatePackagingCheckpoint(
      snapshot,
      next,
      stage === 'READY',
      !!snapshot.redoSlotId || !!snapshot.redoCaptionsOnly,
    );
    const ids = [
      ...new Set(
        [...Object.values(next.voices ?? {}), ...(next.music ? [next.music] : [])].map(
          (a) => a.fileObjectId,
        ),
      ),
    ];
    // Partial redos may reuse files from an earlier run of this exact variant and visual source.
    if (ids.length) {
      const owned = await this.repo.db.effectPackagingFile.findMany({
        where: {
          projectId,
          fileObjectId: { in: ids },
          item: {
            variantId: item.variantId,
            sourceTimelineHash: item.sourceTimelineHash,
            run: { workflowRunId: run.workflowRunId, templateId: run.templateId },
          },
        },
        select: { fileObjectId: true },
      });
      if (new Set(owned.map((file) => file.fileObjectId)).size !== ids.length)
        throw new BadRequestException('音频资产不属于当前成片');
    }
    const saved = await this.repo.checkpoint(projectId, runId, token, itemId, stage, patch);
    if (stage === 'READY' && snapshot.operation) {
      // Other films may commit between reading the workspace and acquiring its row lock.
      // Rebuild only the persistence plan; the validated checkpoint already contains every result.
      for (let attempt = 0; ; attempt++) {
        try {
          await this.finalOutput.upsertFromPackaging(projectId, run.workflowRunId, run.templateId, {
            publish: false,
            onlyVariantIds: [item.variantId],
            packagingRunId: runId,
            attemptToken: token,
          });
          break;
        } catch (error) {
          if (
            !(error instanceof ConflictException) ||
            !['草稿已变化，请刷新后重试', '混剪草稿已在其他页面更新，请刷新后重试'].includes(
              error.message,
            )
          )
            throw error;
          if (attempt >= 7)
            throw new ServiceUnavailableException('其他成片正在提交，稍后继续保存本条包装');
        }
      }
    }
    return saved;
  }
  async content(projectId: string, runId: string, token: string, itemId: string, fileId: string) {
    const { snapshot, item, run } = await this.workerItem(projectId, runId, token, itemId);
    const sourceVideo = snapshot.clips.some((c) => c.fileObjectId === fileId);
    const timelineAudio = (snapshot.detachedAudios ?? []).some(
      (audio) => audio.fileObjectId === fileId,
    );
    const checkpoint = item.checkpoint as PackagingCheckpoint;
    const savedVoice = [
      ...Object.values(checkpoint.voices ?? {}),
      // A generated caption narration is a voice file like any other, so the renderer has to be
      // able to fetch it or the mix would fail on a file it was told to include.
      ...Object.values(checkpoint.captionVoices ?? {}),
    ].some((voice) => voice.fileObjectId === fileId);
    const ownedVoice =
      savedVoice &&
      Boolean(
        await this.repo.db.effectPackagingFile.count({
          where: {
            projectId,
            fileObjectId: fileId,
            OR: [{ role: { startsWith: 'voice-' } }, { role: { startsWith: 'caption-voice-' } }],
            item: {
              variantId: item.variantId,
              sourceTimelineHash: item.sourceTimelineHash,
              run: { workflowRunId: run.workflowRunId, templateId: run.templateId },
            },
          },
        }),
      );
    if (!sourceVideo && !timelineAudio && !ownedVoice)
      throw new NotFoundException('素材不属于当前成片');
    return this.working.fileObjectContent(projectId, fileId);
  }
  async upload(
    projectId: string,
    runId: string,
    token: string,
    itemId: string,
    role: string,
    file: { path: string; size: number } | undefined,
    segmentFramesJson?: string,
    speechRangesJson?: string,
  ) {
    const { run, snapshot } = await this.workerItem(projectId, runId, token, itemId);
    if (!file || file.size > 100 * 1024 * 1024 || !/^(music|voice-[a-zA-Z0-9_-]{1,50})$/.test(role))
      throw new BadRequestException('包装音频无效');
    const duration = await wavDuration(file.path, file.size, role === 'music' ? 'MUSIC' : 'VOICE');
    if ((segmentFramesJson !== undefined || speechRangesJson !== undefined) && role === 'music')
      throw new BadRequestException('音乐不支持口播片段边界');
    const segmentFrames = parseVoiceSegmentFrames(segmentFramesJson, duration);
    const speechRanges = parseVoiceSpeechRanges(speechRangesJson, duration);
    if (role !== 'music' && snapshot.captionTimingPolicy === 'SYNTHESIS_WORDS_V1' && !speechRanges)
      throw new BadRequestException('本次配音缺少字词时间戳，不能保存为严格对齐的包装结果');
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file.path)) hash.update(chunk);
    const sha256 = hash.digest('hex');
    const existing = await this.repo.db.effectPackagingFile.findUnique({
      where: { projectId_itemId_role: { projectId, itemId, role } },
      include: { fileObject: true },
    });
    if (existing) {
      if (existing.fileObject.sha256 !== sha256)
        throw new ConflictException('同一句音频已保存，禁止替换为重试生成的不同内容');
      return { fileObjectId: existing.fileObjectId };
    }
    const project = await this.repo.db.project.findUniqueOrThrow({ where: { id: projectId } });
    const stored = await this.storage.put({
      projectId,
      stream: createReadStream(file.path),
      sizeBytes: file.size,
      contentType: 'audio/wav',
      keyContext: {
        projectName: project.name,
        workflow: 'effect',
        lifecycle: 'staging',
        category: 'timeline-package',
        originalFileName: `${itemId}-${role}.wav`,
      },
    });
    try {
      return await this.repo.db.$transaction(async (tx) => {
        const held = await tx.effectPackagingRun.updateMany({
          where: {
            id: runId,
            projectId,
            status: 'RUNNING',
            attemptToken: token,
            leaseExpiresAt: { gt: new Date() },
          },
          data: { leaseExpiresAt: new Date(Date.now() + 120_000) },
        });
        if (!held.count) throw new ConflictException('包装租约已失效');
        const created = await tx.fileObject.create({
          data: {
            projectId,
            workflowRunId: run.workflowRunId,
            nodeId: 'TEMPLATE_MIX',
            originalFileName: `${snapshot.variant.id}-${role}.wav`,
            mimeType: 'audio/wav',
            sizeBytes: file.size,
            storageKey: stored.key,
            sha256,
          },
        });
        await tx.effectPackagingFile.create({
          data: { projectId, itemId, role, fileObjectId: created.id },
        });
        const current = await tx.effectPackagingItem.findUniqueOrThrow({ where: { id: itemId } });
        const cp = current.checkpoint as PackagingCheckpoint;
        const lineId = role.slice('voice-'.length);
        const line = cp.script?.find((line) => line.id === lineId);
        const audio = {
          ...(role !== 'music' && snapshot.voiceProfile
            ? { voiceProfile: snapshot.voiceProfile }
            : {}),
          fileObjectId: created.id,
          duration,
          ...(segmentFrames ? { segmentFrames } : {}),
          ...(speechRanges ? { speechRanges } : {}),
          start: role === 'music' ? 0 : (line?.start ?? -1),
          volume: 1,
        };
        const checkpoint: PackagingCheckpoint =
          role === 'music'
            ? { ...cp, music: audio }
            : { ...cp, voices: { ...cp.voices, [lineId]: audio } };
        validatePackagingCheckpoint(
          snapshot,
          checkpoint,
          false,
          !!snapshot.redoSlotId || !!snapshot.redoCaptionsOnly,
        );
        await tx.effectPackagingItem.update({
          where: { id: itemId },
          data: { checkpoint: JSON.parse(JSON.stringify(checkpoint)) },
        });
        return { fileObjectId: created.id };
      });
    } catch (error) {
      await this.storage.delete(stored.key).catch(() => undefined);
      throw error;
    }
  }
  /** The output node consumes both confirmed copies. This does not encode a final video. */
  async outputInputs(
    projectId: string,
    workflowRunId: string,
    templateId: string,
    variantId: string,
  ) {
    const workspace = await this.mix.workspace(projectId, workflowRunId);
    const variant = workspace.draft.templates
      .find((t) => t.id === templateId)
      ?.workspace.variants.find((v) => v.id === variantId);
    const artifacts = (await this.working.listArtifacts(projectId, { workflowRunId })).items;
    const visual = artifacts.find(
      (a) => a.artifactKey === `timeline-project:${templateId}:${variantId}`,
    );
    const packaging = artifacts.find(
      (a) => a.artifactKey === `timeline-package:${templateId}:${variantId}`,
    );
    if (
      !variant ||
      !visual ||
      !packaging ||
      visual.availability !== 'AVAILABLE' ||
      packaging.availability !== 'AVAILABLE'
    )
      throw new ConflictException('画面工程或包装工程不可用；成片输出不可消费');
    if ((packaging.payload as PackagingCheckpoint).narrationLayoutVersion !== 'SLOT_V1')
      throw new ConflictException('旧版整片口播仅可播放，请按槽位重新包装后进入成片输出');
    return { visual, packaging };
  }
}
