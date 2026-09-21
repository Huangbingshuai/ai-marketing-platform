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
  PackagingRun,
  PackagingSnapshot,
  PackagingStage,
  EffectTemplateMixWorkspaceData,
  WorkingArtifact,
} from '@ai-marketing/contracts';
import { packagingVisualTimeline } from '@ai-marketing/contracts';
import { EffectPackagingRepository } from './effect-packaging.repository';
import { EffectTemplateMixService } from './effect-template-mix.service';
import { WorkflowWorkingService } from '../../../platform/workflow/workflow-working.service';
import { STORAGE_PORT, type StoragePort } from '../../../platform/file/storage.port';
import { workflowStateHash } from '../../../platform/workflow/workflow-state-hash';
import {
  packagingSnapshot,
  validatePackagingCheckpoint,
  visualHash,
} from './effect-packaging.domain';

async function wavDuration(path: string, size: number): Promise<number> {
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
          buffer.readUInt16LE(pos + 22) !== 16
        )
          throw new BadRequestException('包装音频编码无效');
        bytesPerSecond = buffer.readUInt32LE(pos + 16);
      }
      if (name === 'data' && bytesPerSecond === 48_000 && length > 0 && pos + 8 + length <= size)
        return length / bytesPerSecond;
      pos += 8 + length + (length % 2);
    }
    throw new BadRequestException('包装音频头或真实时长无效');
  } finally {
    await handle.close();
  }
}

@Injectable()
export class EffectPackagingService {
  constructor(
    @Inject(EffectPackagingRepository) readonly repo: EffectPackagingRepository,
    @Inject(EffectTemplateMixService) readonly mix: EffectTemplateMixService,
    @Inject(WorkflowWorkingService) readonly working: WorkflowWorkingService,
    @Inject(STORAGE_PORT) readonly storage: StoragePort,
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
    const variants = entry.workspace.variants.filter(
      (v) =>
        (!body.variantId || v.id === body.variantId) &&
        v.slots.length &&
        v.slots.every((s) => v.bindings[s.id]),
    );
    if (!variants.length) throw new BadRequestException('没有可包装的完整成片');
    if (body.component && body.component !== 'ALL' && !body.variantId)
      throw new BadRequestException('局部重做必须选择一条成片');
    const artifacts = (
      await this.working.listArtifacts(projectId, { workflowRunId: body.workflowRunId })
    ).items;
    const snapshots = variants.map((v) => packagingSnapshot(v, workspace.materials, artifacts));
    const checkpoints: PackagingCheckpoint[] = snapshots.map(() => ({}));
    if (body.component && body.component !== 'ALL') {
      const history = await this.repo.list(projectId, body.workflowRunId, templateId);
      const previous = history
        .flatMap((r) => r.items)
        .find(
          (i) =>
            i.variantId === body.variantId &&
            i.sourceTimelineHash === snapshots[0]!.sourceTimelineHash &&
            (i.snapshot as unknown as PackagingSnapshot).dependencies.every((d) =>
              artifacts.some(
                (a) =>
                  a.id === d.artifactId && a.revision === d.revision && a.freshness === 'CURRENT',
              ),
            ),
        );
      if (!previous) throw new ConflictException('没有可复用的当前包装，请先生成完整包装');
      const cp = structuredClone(previous.checkpoint) as PackagingCheckpoint;
      if (body.component === 'VOICE') {
        delete cp.script;
        delete cp.voices;
        delete cp.captions;
      }
      if (body.component === 'MUSIC') {
        delete cp.music;
        delete cp.musicTaskId;
        delete cp.musicSubmissionPending;
      }
      if (body.component === 'CAPTIONS') delete cp.captions;
      checkpoints[0] = cp;
    }
    const id = await this.repo.create({
      projectId,
      workflowRunId: body.workflowRunId,
      templateId,
      idempotencyKey: body.idempotencyKey,
      requestHash,
      snapshots,
      checkpoints,
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
  private present(
    run: NonNullable<Awaited<ReturnType<EffectPackagingRepository['get']>>>,
    workspace: EffectTemplateMixWorkspaceData,
    artifacts: WorkingArtifact[],
  ): PackagingRun {
    const variants =
      workspace.draft.templates.find((t) => t.id === run.templateId)?.workspace.variants ?? [];
    const items = run.items.map((i) => {
      const snapshot = i.snapshot as unknown as PackagingSnapshot;
      const variant = variants.find((v) => v.id === i.variantId);
      const checkpoint = { ...(i.checkpoint as PackagingCheckpoint) };
      delete checkpoint.musicTaskId;
      delete checkpoint.musicSubmissionPending;
      return {
        id: i.id,
        variantId: i.variantId,
        name: i.name,
        shardIndex: i.shardIndex,
        sourceTimelineHash: i.sourceTimelineHash,
        sourceVisualTimeline: packagingVisualTimeline(snapshot.variant),
        stage: i.stage as PackagingStage,
        status: i.status as PackagingRun['status'],
        checkpoint,
        stale:
          !variant ||
          visualHash(variant) !== i.sourceTimelineHash ||
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
      };
    });
    return {
      id: run.id,
      templateId: run.templateId,
      workflowRunId: run.workflowRunId,
      status: run.status as PackagingRun['status'],
      createdAt: run.createdAt.toISOString(),
      startedAt: run.startedAt?.toISOString() ?? null,
      completedAt: run.completedAt?.toISOString() ?? null,
      items,
      counts: {
        total: items.length,
        completed: items.filter((i) => i.status === 'COMPLETED').length,
        failed: items.filter((i) => i.status === 'FAILED').length,
        stale: items.filter((i) => i.stale).length,
        shards: new Set(items.map((i) => i.shardIndex)).size,
      },
    };
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
    if (run.items.some((i) => i.stale))
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
    validatePackagingCheckpoint(snapshot, next, stage === 'READY');
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
    const { snapshot } = await this.workerItem(projectId, runId, token, itemId);
    if (!snapshot.clips.some((c) => c.fileObjectId === fileId))
      throw new NotFoundException('素材不属于冻结时间轴');
    return this.working.fileObjectContent(projectId, fileId);
  }
  async upload(
    projectId: string,
    runId: string,
    token: string,
    itemId: string,
    role: string,
    file: { path: string; size: number } | undefined,
  ) {
    const { run, snapshot } = await this.workerItem(projectId, runId, token, itemId);
    if (!file || file.size > 100 * 1024 * 1024 || !/^(music|voice-[a-zA-Z0-9_-]{1,50})$/.test(role))
      throw new BadRequestException('包装音频无效');
    const duration = await wavDuration(file.path, file.size);
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
          fileObjectId: created.id,
          duration,
          start: role === 'music' ? 0 : (line?.start ?? -1),
          volume: role === 'music' ? 0.12 : 1,
        };
        const checkpoint: PackagingCheckpoint =
          role === 'music'
            ? { ...cp, music: audio }
            : { ...cp, voices: { ...cp.voices, [lineId]: audio } };
        validatePackagingCheckpoint(snapshot, checkpoint);
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
  async confirm(projectId: string, runId: string, itemId: string) {
    const run = await this.get(projectId, runId),
      item = run.items.find((i) => i.id === itemId);
    if (!item || item.stale || item.status !== 'COMPLETED')
      throw new ConflictException('仅可确认已完成且未过期的包装');
    const raw = (await this.repo.get(projectId, runId))!.items.find((i) => i.id === itemId)!;
    const snapshot = raw.snapshot as unknown as PackagingSnapshot;
    validatePackagingCheckpoint(snapshot, item.checkpoint, true);
    const artifacts = (
      await this.working.listArtifacts(projectId, { workflowRunId: run.workflowRunId })
    ).items;
    const visual = artifacts.find(
      (a) => a.artifactKey === `timeline-project:${run.templateId}:${item.variantId}`,
    );
    const payload = visual?.payload as { variant?: EffectTemplateMixVariant } | undefined;
    if (
      !visual ||
      visual.freshness !== 'CURRENT' ||
      !payload?.variant ||
      visualHash(payload.variant) !== item.sourceTimelineHash
    )
      throw new ConflictException('请先完成当前画面时间轴的校验，再确认包装');
    const ids = [...Object.values(item.checkpoint.voices ?? {}), item.checkpoint.music!].map(
      (a) => a.fileObjectId,
    );
    const files = await this.repo.db.fileObject.findMany({
      where: { projectId, workflowRunId: run.workflowRunId, id: { in: ids }, status: 'AVAILABLE' },
    });
    if (files.length !== new Set(ids).size) throw new ConflictException('包装音频已失效');
    return this.working.commitValidatedArtifacts(projectId, run.workflowRunId, 'TEMPLATE_MIX', [
      {
        artifactKey: `timeline-package:${run.templateId}:${item.variantId}`,
        input: {
          kind: 'STRUCTURED',
          name: `${item.name} · 智能包装`,
          directory: 'EDITING_PROJECTS',
          type: 'TIMELINE_PROJECT',
          payload: {
            schemaVersion: 1,
            templateId: run.templateId,
            variantId: item.variantId,
            sourceTimelineHash: item.sourceTimelineHash,
            visualArtifactId: visual.id,
            visualRevision: visual.revision,
            duration: snapshot.duration,
            ...item.checkpoint,
            mix: { originalVolume: 0.15, bgmVolume: 0.12, ducking: true },
            subtitleStyle: 'standard',
          },
          files: files.map((f, sortOrder) => ({
            fileObjectId: f.id,
            role: f.id === item.checkpoint.music!.fileObjectId ? 'BGM' : 'VOICE',
            sortOrder,
            originalFileName: f.originalFileName,
            mimeType: f.mimeType,
            sha256: f.sha256,
          })),
          dependencies: [
            ...snapshot.dependencies,
            {
              artifactId: visual.id,
              artifactKey: visual.artifactKey,
              revision: visual.revision,
              contentHash: visual.contentHash ?? '',
              nodeId: visual.nodeId,
            },
          ].map((d) => ({
            sourceType: 'WORKING_ARTIFACT',
            sourceNodeId: d.nodeId,
            sourceArtifactId: d.artifactId,
            sourceKey: d.artifactKey,
            sourceRevision: d.revision,
            sourceHash: d.contentHash,
          })),
        },
      },
    ]);
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
      payload?.sourceTimelineHash !== visualHash(variant) ||
      payload.visualArtifactId !== visual.id ||
      payload.visualRevision !== visual.revision
    )
      throw new ConflictException('画面或包装未确认、已过期；成片输出不可消费');
    return { visual, packaging };
  }
}
