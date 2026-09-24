import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import type {
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
  constructor(
    @Inject(EffectPackagingRepository) readonly repo: EffectPackagingRepository,
    @Inject(EffectTemplateMixService) readonly mix: EffectTemplateMixService,
    @Inject(WorkflowWorkingService) readonly working: WorkflowWorkingService,
    @Inject(STORAGE_PORT) readonly storage: StoragePort,
    @Inject(EffectVoiceCatalogService)
    readonly voiceCatalog: EffectVoiceCatalogService = new EffectVoiceCatalogService(),
  ) {}

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
    const workspace = await this.mix.workspace(projectId, body.workflowRunId);
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
      await this.working.listArtifacts(projectId, { workflowRunId: body.workflowRunId })
    ).items;
    const snapshots = variants.map((v) => packagingSnapshot(v, workspace.materials, artifacts));
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
    const history = await this.repo.list(projectId, body.workflowRunId, templateId);
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
      workflowRunId: body.workflowRunId,
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
    const artifacts = (
      await this.working.listArtifacts(projectId, { workflowRunId: run.workflowRunId })
    ).items;
    return this.present(run, workspace, artifacts);
  }
  private presentItems(
    run: PackagingRunRow,
    workspace: EffectTemplateMixWorkspaceData,
    artifacts: WorkingArtifact[],
  ): PackagingItem[] {
    const variants =
      workspace.draft.templates.find((t) => t.id === run.templateId)?.workspace.variants ?? [];
    return run.items.map((i) => {
      const snapshot = i.snapshot as unknown as PackagingSnapshot;
      const variant = variants.find((v) => v.id === i.variantId);
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
        stale:
          !variant ||
          !matchesVisualHash(variant, i.sourceTimelineHash, snapshot.variant) ||
          snapshot.dependencies.some(
            (d) =>
              !artifacts.some(
                (a) =>
                  a.id === d.artifactId &&
                  a.revision === d.revision &&
                  a.freshness === 'CURRENT' &&
                  a.availability === 'AVAILABLE',
              ),
          ),
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
    artifacts: WorkingArtifact[],
  ): PackagingRun {
    const items = this.presentItems(run, workspace, artifacts);
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
        Number(process.env.TEMPLATE_MIX_AI_MAX_CONCURRENCY) || 4,
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
        stale: items.filter((i) => i.stale).length,
        shards: new Set(items.map((i) => i.shardIndex)).size,
      },
    };
  }
  /** Editor audio edits: only geometry/volume are trusted, never the client's file identity. */
  async updateAudio(
    projectId: string,
    runId: string,
    itemId: string,
    body: UpdatePackagingAudioRequest,
  ): Promise<PackagingItem> {
    const raw = await this.repo.get(projectId, runId);
    const item = raw?.items.find((i) => i.id === itemId);
    if (!raw || !item) throw new NotFoundException('包装成片不存在');
    if (item.status !== 'COMPLETED') throw new ConflictException('包装尚未完成，无法编辑音频');
    const workspace = await this.mix.workspace(projectId, raw.workflowRunId);
    const artifacts = (
      await this.working.listArtifacts(projectId, { workflowRunId: raw.workflowRunId })
    ).items;
    const snapshot = item.snapshot as unknown as PackagingSnapshot;
    const variant = workspace.draft.templates
      .find((t) => t.id === raw.templateId)
      ?.workspace.variants.find((v) => v.id === item.variantId);
    if (
      !variant ||
      !matchesVisualHash(variant, item.sourceTimelineHash, snapshot.variant) ||
      snapshot.dependencies.some(
        (d) =>
          !artifacts.some(
            (a) =>
              a.id === d.artifactId &&
              a.revision === d.revision &&
              a.freshness === 'CURRENT' &&
              a.availability === 'AVAILABLE',
          ),
      )
    )
      throw new ConflictException('源时间轴已改变，请重新生成包装后再编辑音频');
    const old = item.checkpoint as PackagingCheckpoint;
    let voices = old.voices;
    if (body.voices) {
      voices = { ...(old.voices ?? {}) };
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
    let music = old.music;
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
    const captions = body.captions
      ? [...body.captions]
          .sort((left, right) => left.start - right.start)
          .map(({ id, voiceLineId, segmentIndex, segmentCount, text, start, end }) => ({
            id,
            ...(voiceLineId ? { voiceLineId, segmentIndex, segmentCount } : {}),
            text,
            start,
            end,
          }))
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
    if (music) next.music = music;
    if (captions) next.captions = captions;
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
    return this.presentItems({ ...raw, items: [saved] }, workspace, artifacts)[0]!;
  }
  async list(projectId: string, workflowRunId: string, templateId: string) {
    const [workspace, artifacts, runs] = await Promise.all([
      this.mix.workspace(projectId, workflowRunId),
      this.working.listArtifacts(projectId, { workflowRunId }),
      this.repo.list(projectId, workflowRunId, templateId),
    ]);
    return runs.map((run) => this.present(run, workspace, artifacts.items));
  }
  async retry(projectId: string, id: string) {
    const run = await this.get(projectId, id);
    if (
      run.items.some(
        (i) => i.status !== 'COMPLETED' && i.checkpoint?.narrationLayoutVersion !== 'SLOT_V1',
      )
    )
      throw new ConflictException('旧版任务不能恢复，请按槽位重新包装');
    if (run.items.some((i) => i.status !== 'COMPLETED' && i.stale))
      throw new ConflictException('源时间轴已改变，请创建新的包装任务');
    return this.repo.retry(projectId, id);
  }
  async workerItem(projectId: string, runId: string, token: string, itemId: string) {
    await this.repo.authorized(projectId, runId, token);
    const run = await this.repo.get(projectId, runId);
    const item = run?.items.find((i) => i.id === itemId);
    if (!run || !item) throw new NotFoundException('包装成片不存在');
    const state = await this.get(projectId, runId);
    if (state.items.find((i) => i.id === itemId)?.stale)
      throw new ConflictException('源时间轴已改变，本条包装已过期');
    return { run, item, snapshot: item.snapshot as unknown as PackagingSnapshot };
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
    await this.repo.authorized(projectId, runId, token);
    const raw = await this.repo.get(projectId, runId);
    const item = raw?.items.find((i) => i.id === itemId);
    if (!item) throw new NotFoundException('包装成片不存在');
    if (errorMessage)
      return this.repo.checkpoint(projectId, runId, token, itemId, stage, {}, errorMessage);
    const { snapshot } = await this.workerItem(projectId, runId, token, itemId);
    const old = item.checkpoint as PackagingCheckpoint;
    const next = { ...old, ...patch, voices: { ...old.voices, ...patch.voices } };
    validatePackagingCheckpoint(
      snapshot,
      next,
      stage === 'READY',
      !!snapshot.redoSlotId || !!snapshot.redoCaptionsOnly,
    );
    const ids = [...Object.values(next.voices ?? {}), ...(next.music ? [next.music] : [])].map(
      (a) => a.fileObjectId,
    );
    // Partial redos may reuse files from an earlier run of this exact variant and visual source.
    for (const fileObjectId of ids)
      if (
        !(await this.repo.db.effectPackagingFile.count({
          where: {
            projectId,
            fileObjectId,
            item: {
              variantId: item.variantId,
              sourceTimelineHash: item.sourceTimelineHash,
              run: { workflowRunId: raw!.workflowRunId, templateId: raw!.templateId },
            },
          },
        }))
      )
        throw new BadRequestException('音频资产不属于当前成片');
    return this.repo.checkpoint(projectId, runId, token, itemId, stage, patch);
  }
  async content(projectId: string, runId: string, token: string, itemId: string, fileId: string) {
    const { snapshot, item, run } = await this.workerItem(projectId, runId, token, itemId);
    const sourceVideo = snapshot.clips.some((c) => c.fileObjectId === fileId);
    const savedVoice = Object.values((item.checkpoint as PackagingCheckpoint).voices ?? {}).some(
      (voice) => voice.fileObjectId === fileId,
    );
    const ownedVoice =
      savedVoice &&
      Boolean(
        await this.repo.db.effectPackagingFile.count({
          where: {
            projectId,
            fileObjectId: fileId,
            role: { startsWith: 'voice-' },
            item: {
              variantId: item.variantId,
              sourceTimelineHash: item.sourceTimelineHash,
              run: { workflowRunId: run.workflowRunId, templateId: run.templateId },
            },
          },
        }),
      );
    if (!sourceVideo && !ownedVoice) throw new NotFoundException('素材不属于当前成片');
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
          volume: role === 'music' ? 0.12 : 1,
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
    const payload = packaging?.payload as
      | { sourceTimelineHash?: string; visualArtifactId?: string; visualRevision?: number }
      | undefined;
    if (
      !variant ||
      !visual ||
      !packaging ||
      visual.freshness !== 'CURRENT' ||
      packaging.freshness !== 'CURRENT' ||
      visual.availability !== 'AVAILABLE' ||
      packaging.availability !== 'AVAILABLE' ||
      !matchesVisualHash(
        variant,
        payload?.sourceTimelineHash,
        (visual.payload as { variant?: EffectTemplateMixVariant } | undefined)?.variant,
      ) ||
      payload?.visualArtifactId !== visual.id ||
      payload?.visualRevision !== visual.revision
    )
      throw new ConflictException('画面或包装未确认、已过期；成片输出不可消费');
    if ((packaging.payload as PackagingCheckpoint).narrationLayoutVersion !== 'SLOT_V1')
      throw new ConflictException('旧版整片口播仅可播放，请按槽位重新包装后进入成片输出');
    return { visual, packaging };
  }
}
