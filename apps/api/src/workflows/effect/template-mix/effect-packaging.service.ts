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
  CreatePackagingCaptionVoiceRequest,
  CreatePackagingRequest,
  EffectTemplateMixVariant,
  PackagingCheckpoint,
  PackagingItem,
  PackagingRun,
  PackagingSnapshot,
  PackagingStage,
  EffectTemplateMixWorkspaceData,
  UpdatePackagingAudioRequest,
  WorkingArtifact,
} from '@ai-marketing/contracts';
import { packagingVisualTimeline } from '@ai-marketing/contracts';
import { packagingExecution } from './effect-packaging.metrics';
import { EffectPackagingRepository } from './effect-packaging.repository';
import { EffectTemplateMixService } from './effect-template-mix.service';
import { EffectFinalOutputService } from '../final-output/effect-final-output.service';
import { EffectVoiceCatalogService } from './effect-voice.catalog';
import { WorkflowWorkingService } from '../../../platform/workflow/workflow-working.service';
import { STORAGE_PORT, type StoragePort } from '../../../platform/file/storage.port';
import { workflowStateHash } from '../../../platform/workflow/workflow-state-hash';
import { templateConfigurationHash } from './template-mix-lifecycle';
import {
  canonicalizeCheckpoint,
  packagingSnapshot,
  validatePackagingCheckpoint,
  matchesVisualHash,
  slotVisionKey,
} from './effect-packaging.domain';

type PackagingRunRow = NonNullable<Awaited<ReturnType<EffectPackagingRepository['get']>>>;

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

export async function wavDuration(path: string, size: number): Promise<number> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(size, 65_536));
    await handle.read(buffer, 0, buffer.length, 0);
    if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE')
      throw new BadRequestException('包装音频必须为 PCM WAV');
    let bytesPerSecond = 0;
    for (let pos = 12; pos + 8 <= buffer.length;) {
      const name = buffer.toString('ascii', pos, pos + 4),
        length = buffer.readUInt32LE(pos + 4);
      if (name === 'fmt ' && length >= 16 && pos + 24 <= buffer.length) {
        if (
          buffer.readUInt16LE(pos + 8) !== 1 ||
          buffer.readUInt16LE(pos + 10) !== 1 ||
          buffer.readUInt32LE(pos + 12) !== 24_000 ||
          buffer.readUInt16LE(pos + 20) !== 2 ||
          buffer.readUInt16LE(pos + 22) !== 16
        )
          throw new BadRequestException('包装音频编码无效');
        bytesPerSecond = buffer.readUInt32LE(pos + 16);
      }
      if (
        name === 'data' &&
        bytesPerSecond === 48_000 &&
        length > 0 &&
        length % 2 === 0 &&
        pos + 8 + length <= size
      )
        return length / bytesPerSecond;
      pos += 8 + length + (length % 2);
    }
    throw new BadRequestException('包装音频头或真实时长无效');
  } finally {
    await handle.close();
  }
}

export function parseVoiceSegmentFrames(
  value: string | undefined,
  duration: number,
): number[] | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      !Array.isArray(parsed) ||
      !parsed.length ||
      parsed.length > 500 ||
      parsed.some((frames: unknown) => !Number.isSafeInteger(frames) || Number(frames) <= 0) ||
      Math.abs(
        parsed.reduce<number>((sum, frames: number) => sum + frames, 0) / 24_000 - duration,
      ) > 0.001
    )
      throw new Error('invalid segments');
    return parsed as number[];
  } catch {
    throw new BadRequestException('口播片段边界与音频不一致');
  }
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
    @Inject(EffectVoiceCatalogService)
    readonly voiceCatalog: EffectVoiceCatalogService = new EffectVoiceCatalogService(),
  ) {}

  /**
   * The worker's finish callback. A finished package puts its films straight into the output node's
   * queue, so they are ready for export without a validation step. Only a batch that packaged every
   * film publishes the mix branch: the films a partial run failed on have to be recovered in the
   * packaging panel first, and retrying reuses this very run, so the branch appears once it is whole
   * instead of showing a version the user never got. The sync is best-effort: a draft that moved on
   * while the worker ran must not fail the worker.
   */
  async finish(projectId: string, runId: string, token: string) {
    const result = await this.repo.finish(projectId, runId, token);
    if (result.status === 'COMPLETED' || result.status === 'PARTIAL')
      try {
        await this.finalOutput.upsertFromPackaging(
          projectId,
          result.workflowRunId,
          result.templateId,
          { publish: result.status === 'COMPLETED' },
        );
      } catch (error) {
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

  async create(projectId: string, templateId: string, body: CreatePackagingRequest) {
    const requestHash = workflowStateHash({ ...body, templateId });
    const replay = await this.repo.db.effectPackagingRun.findUnique({
      where: { projectId_idempotencyKey: { projectId, idempotencyKey: body.idempotencyKey } },
    });
    if (replay) {
      if (replay.requestHash !== requestHash)
        throw new ConflictException('幂等键对应的包装请求已改变');
      return this.get(projectId, replay.id);
    }
    // Packaging is a full update of the mix node. Route it into an unpublished child so the
    // published packaging result stays intact; the request hash above still keys on the Run the
    // caller named, so a retry of the same request replays instead of forking again. Every
    // successful packaging is a version of its own, so this forks even for the first one.
    const edit = await this.working.beginEffectNodeEdit(
      projectId,
      body.workflowRunId,
      'TEMPLATE_MIX',
      'BATCH',
      { always: true },
    );
    const workflowRunId = edit.run.id;
    const workspace = await this.mix.workspace(projectId, workflowRunId);
    if (workspace.draftRevision !== body.expectedRevision)
      throw new ConflictException('草稿已改变，请刷新后重试');
    const entry = workspace.draft.templates.find((t) => t.id === templateId);
    if (!entry) throw new NotFoundException('模板不存在');
    if (entry.needsAiFill)
      throw new ConflictException(
        '模板已改动，或仍有成片未按当前模板重新智能填充；请完成需要更新的成片后再包装',
      );
    const variants = entry.workspace.variants.filter(
      (v) =>
        (!body.variantId || v.id === body.variantId) &&
        v.slots.length &&
        v.slots.every((s) => v.bindings[s.id]),
    );
    if (!variants.length) throw new BadRequestException('没有可包装的完整成片');
    if (body.component && !['ALL', 'CAPTIONS'].includes(body.component) && !body.variantId)
      throw new BadRequestException('局部重做必须选择一条成片');
    if (
      body.slotId &&
      (!body.variantId ||
        body.component !== 'VOICE' ||
        !variants[0]?.slots.some((s) => s.id === body.slotId))
    )
      throw new BadRequestException('单槽位重做必须选择当前成片中的口播槽位');
    const artifacts = (
      await this.working.listArtifacts(projectId, { workflowRunId })
    ).items;
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
          select: { id: true, storageKey: true, sizeBytes: true, mimeType: true, originalFileName: true },
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
    const snapshots = variants.map((v) =>
      packagingSnapshot(v, workspace.materials, artifacts, musicSources),
    );
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
    const history = await this.repo.list(projectId, workflowRunId, templateId);
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
        if (body.component === 'CAPTIONS') delete cp.captions;
        checkpoints[index] = cp;
      }
    const id = await this.repo.create({
      projectId,
      workflowRunId,
      templateId,
      idempotencyKey: body.idempotencyKey,
      requestHash,
      snapshots,
      checkpoints,
      expectedDraftRevision: body.expectedRevision,
      expectedTemplateHash: templateConfigurationHash(entry.workspace.template),
    });
    return this.get(projectId, id);
  }
  async get(projectId: string, id: string): Promise<PackagingRun> {
    const run = await this.repo.get(projectId, id);
    if (!run) throw new NotFoundException('包装任务不存在');
    const workspace = await this.mix.workspace(projectId, run.workflowRunId);
    return this.present(run, workspace);
  }
  private presentItems(
    run: PackagingRunRow,
    workspace: EffectTemplateMixWorkspaceData,
  ): PackagingItem[] {
    return run.items.map((i) => {
      const snapshot = i.snapshot as unknown as PackagingSnapshot;
      const checkpoint = { ...(i.checkpoint as PackagingCheckpoint) };
      delete checkpoint.musicTaskId;
      delete checkpoint.musicSubmissionPending;
      const referencedFactIds = new Set(
        (checkpoint.script ?? []).flatMap(({ factIds }) => factIds),
      );
      return {
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
            [clip.materialCode, clip.materialName].filter(Boolean).join(' · ') ||
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
  private present(
    run: PackagingRunRow,
    workspace: EffectTemplateMixWorkspaceData,
  ): PackagingRun {
    const items = this.presentItems(run, workspace);
    return {
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
    const { raw, item, snapshot, workspace } = await this.editableItem(
      projectId,
      runId,
      itemId,
    );
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
          throw new BadRequestException('口播裁剪超出真实音频长度');
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
          throw new BadRequestException('字幕口播裁剪超出真实音频长度');
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
        const scale = voice.duration / previous.duration;
        return {
          ...c,
          start: voice.start + (c.start - previous.start) * scale,
          end: voice.start + (c.end - previous.start) * scale,
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
    const [workspace, runs] = await Promise.all([
      this.mix.workspace(projectId, workflowRunId),
      this.repo.list(projectId, workflowRunId, templateId),
    ]);
    return runs.map((run) => this.present(run, workspace));
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
  async workerItem(projectId: string, runId: string, token: string, itemId: string) {
    await this.repo.authorized(projectId, runId, token);
    const item = await this.repo.getItem(projectId, runId, itemId);
    if (!item) throw new NotFoundException('包装成片不存在');
    const run = item.run;
    const snapshot = item.snapshot as unknown as PackagingSnapshot;
    const [variant, artifacts] = await Promise.all([
      this.mix.currentVariant(projectId, run.workflowRunId, run.templateId, item.variantId),
      this.repo.sourceArtifacts(projectId, run.workflowRunId,
        [...new Set(snapshot.dependencies.map((dependency) => dependency.artifactId))]),
    ]);
    if (!variant ||
      snapshot.dependencies.some((dependency) => !artifacts.some((artifact) =>
        artifact.id === dependency.artifactId &&
        artifact.revision === dependency.revision &&
        artifact.freshness === 'CURRENT' &&
        artifact.availability === 'AVAILABLE')))
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
    // Failure writes must be accepted even when the source changed during execution.
    if (errorMessage) {
      await this.repo.authorized(projectId, runId, token);
      if (!(await this.repo.getItem(projectId, runId, itemId)))
        throw new NotFoundException('包装成片不存在');
      return this.repo.checkpoint(projectId, runId, token, itemId, stage, {}, errorMessage);
    }
    const { snapshot, item, run } = await this.workerItem(projectId, runId, token, itemId);
    const old = item.checkpoint as PackagingCheckpoint;
    const next = { ...old, ...patch, voices: { ...old.voices, ...patch.voices } };
    validatePackagingCheckpoint(
      snapshot,
      next,
      stage === 'READY',
      !!snapshot.redoSlotId || !!snapshot.redoCaptionsOnly,
    );
    const ids = [...new Set([...Object.values(next.voices ?? {}), ...(next.music ? [next.music] : [])].map(
      (a) => a.fileObjectId,
    ))];
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
    return this.repo.checkpoint(projectId, runId, token, itemId, stage, patch);
  }
  async content(projectId: string, runId: string, token: string, itemId: string, fileId: string) {
    const { snapshot, item, run } = await this.workerItem(projectId, runId, token, itemId);
    const sourceVideo = snapshot.clips.some((c) => c.fileObjectId === fileId);
    const timelineAudio = (snapshot.detachedAudios ?? []).some((audio) => audio.fileObjectId === fileId);
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
            OR: [
              { role: { startsWith: 'voice-' } },
              { role: { startsWith: 'caption-voice-' } },
            ],
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
  ) {
    const { run, snapshot } = await this.workerItem(projectId, runId, token, itemId);
    if (!file || file.size > 100 * 1024 * 1024 || !/^(music|voice-[a-zA-Z0-9_-]{1,50})$/.test(role))
      throw new BadRequestException('包装音频无效');
    const duration = await wavDuration(file.path, file.size);
    if (segmentFramesJson !== undefined && role === 'music')
      throw new BadRequestException('音乐不支持口播片段边界');
    const segmentFrames = parseVoiceSegmentFrames(segmentFramesJson, duration);
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
    if (!variant || !visual || !packaging ||
      visual.availability !== 'AVAILABLE' || packaging.availability !== 'AVAILABLE')
      throw new ConflictException('画面工程或包装工程不可用；成片输出不可消费');
    if ((packaging.payload as PackagingCheckpoint).narrationLayoutVersion !== 'SLOT_V1')
      throw new ConflictException('旧版整片口播仅可播放，请按槽位重新包装后进入成片输出');
    return { visual, packaging };
  }
}
