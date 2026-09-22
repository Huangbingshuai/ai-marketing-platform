import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import type { CompleteEffectPackagingRequest, FinalOutputRun, FinalOutputSnapshot, PackagingCheckpoint, PackagingSnapshot } from '@ai-marketing/contracts';
import { PrismaService } from '../../../database/prisma.service';
import type { Prisma } from '../../../generated/prisma/client';
import { WorkflowWorkingRepository } from '../../../platform/workflow/workflow-working.repository';
import { STORAGE_PORT, type StoragePort } from '../../../platform/file/storage.port';
import { workflowStateHash } from '../../../platform/workflow/workflow-state-hash';
import { EFFECT_TEMPLATE_MIX_JOB_TYPE, EFFECT_TEMPLATE_MIX_QUEUE } from '../../../platform/job/job.constants';
import { EffectTemplateMixService } from '../template-mix/effect-template-mix.service';
import { validatePackagingCheckpoint, visualHash } from '../template-mix/effect-packaging.domain';

const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const lease = () => new Date(Date.now() + 120_000);
const include = { items: { orderBy: { id: 'asc' as const } } };
const audioIds = (cp: PackagingCheckpoint) => [...Object.values(cp.voices ?? {}), ...(cp.music ? [cp.music] : [])].map((a) => a.fileObjectId);

@Injectable()
export class EffectFinalOutputService {
  constructor(@Inject(PrismaService) readonly db: PrismaService,
    @Inject(EffectTemplateMixService) readonly mix: EffectTemplateMixService,
    @Inject(WorkflowWorkingRepository) readonly working: WorkflowWorkingRepository,
    @Inject(STORAGE_PORT) readonly storage: StoragePort) {}

  private enqueue(tx: Prisma.TransactionClient, projectId: string, runId: string) {
    const payload = { schemaVersion: 2, taskType: 'FINAL_OUTPUT', projectId, runId, requestId: randomUUID() };
    return tx.jobOutbox.upsert({ where: { projectId_jobType_aggregateId: { projectId, jobType: EFFECT_TEMPLATE_MIX_JOB_TYPE, aggregateId: runId } },
      create: { projectId, aggregateId: runId, jobType: EFFECT_TEMPLATE_MIX_JOB_TYPE, routingKey: EFFECT_TEMPLATE_MIX_QUEUE, payload },
      update: { payload, status: 'PENDING', attempts: 0, dispatchToken: null, nextAttemptAt: new Date(), publishedAt: null, lastError: null } });
  }

  async complete(projectId: string, templateId: string, body: CompleteEffectPackagingRequest): Promise<FinalOutputRun> {
    const requestHash = workflowStateHash({ templateId, ...body });
    const existing = await this.db.effectFinalOutputRun.findUnique({ where: { projectId_idempotencyKey: { projectId, idempotencyKey: body.idempotencyKey } } });
    if (existing) {
      if (existing.requestHash !== requestHash) throw new ConflictException('幂等键对应的完成请求已改变');
      return this.get(projectId, existing.id);
    }
    const { inputs, variants } = await this.mix.prepareValidation(projectId, body.workflowRunId, body.expectedRevision, templateId);
    const workspace = await this.mix.workspace(projectId, body.workflowRunId);
    const runId = await this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${projectId + ':' + body.workflowRunId + ':' + templateId}))`;
      const replay = await tx.effectFinalOutputRun.findUnique({ where: { projectId_idempotencyKey: { projectId, idempotencyKey: body.idempotencyKey } } });
      if (replay) {
        if (replay.requestHash !== requestHash) throw new ConflictException('幂等请求内容已改变');
        return replay.id;
      }
      await tx.$queryRaw`SELECT id FROM workflow_node_states WHERE "projectId"=${projectId}::uuid AND "workflowRunId"=${body.workflowRunId}::uuid AND "nodeId"='TEMPLATE_MIX' FOR UPDATE`;
      const state = await tx.workflowNodeState.findUnique({ where: { projectId_workflowRunId_nodeId: { projectId, workflowRunId: body.workflowRunId, nodeId: 'TEMPLATE_MIX' } } });
      if (state?.revision !== body.expectedRevision) throw new ConflictException('草稿已变化，请刷新后重新完成校验');
      // Lock confirmed sources through the commit; concurrent upstream edits cannot slip between validation and submission.
      await tx.$queryRaw`SELECT id FROM working_artifacts WHERE "projectId"=${projectId}::uuid AND "workflowRunId"=${body.workflowRunId}::uuid ORDER BY id FOR UPDATE`;
      const active = await tx.effectPackagingRun.count({ where: { projectId, workflowRunId: body.workflowRunId, templateId, status: { in: ['QUEUED', 'RUNNING'] } } });
      if (active) throw new ConflictException('包装仍在执行，请等待全部成片成功');
      const history = await tx.effectPackagingItem.findMany({ where: { projectId, run: { workflowRunId: body.workflowRunId, templateId }, variantId: { in: variants.map((v) => v.id) } },
        orderBy: [{ run: { createdAt: 'desc' } }, { id: 'desc' }], distinct: ['variantId'] });
      const sources = await tx.workingArtifact.findMany({ where: { projectId, workflowRunId: body.workflowRunId } });
      const rows = variants.map((variant) => {
        const item = history.find((i) => i.variantId === variant.id);
        if (!item || item.status !== 'COMPLETED' || item.sourceTimelineHash !== visualHash(variant))
          throw new ConflictException(`${variant.name} 包装缺失、失败或过期；必须全部成功后提交`);
        const snapshot = item.snapshot as unknown as PackagingSnapshot;
        const checkpoint = item.checkpoint as PackagingCheckpoint;
        validatePackagingCheckpoint(snapshot, checkpoint, true);
        if (snapshot.dependencies.some((d) => !sources.some((a) => a.id === d.artifactId && a.revision === d.revision && a.contentHash === d.contentHash && a.freshness === 'CURRENT' && a.availability === 'AVAILABLE')))
          throw new ConflictException('包装上游来源已过期，请恢复包装');
        return { item, snapshot, checkpoint };
      });
      const inputHash = workflowStateHash(rows.map((r) => ({ variant: r.snapshot.sourceTimelineHash, checkpoint: r.checkpoint, dependencies: r.snapshot.dependencies })));
      const duplicate = await tx.effectFinalOutputRun.findUnique({ where: { projectId_workflowRunId_templateId_inputHash: { projectId, workflowRunId: body.workflowRunId, templateId, inputHash } } });
      if (duplicate) return duplicate.id;
      const requiredIds = [...new Set(rows.flatMap((r) => [...audioIds(r.checkpoint), ...r.snapshot.clips.map((c) => c.fileObjectId)]))];
      const files = await tx.fileObject.findMany({ where: { projectId, workflowRunId: body.workflowRunId, id: { in: requiredIds }, status: 'AVAILABLE' } });
      if (files.length !== requiredIds.length) throw new ConflictException('包装或视频文件已失效');
      const committed = await this.working.commitValidatedArtifactsInTransaction(tx, projectId, body.workflowRunId, 'TEMPLATE_MIX', inputs);
      const outputRows = [];
      for (const row of rows) {
        const visual = committed.find((c) => c.artifactKey === `timeline-project:${templateId}:${row.item.variantId}`)!.record;
        const dependencies = [...row.snapshot.dependencies, { artifactId: visual.id, artifactKey: visual.artifactKey, nodeId: visual.nodeId, revision: visual.revision, contentHash: visual.contentHash }];
        const cp = { ...row.checkpoint };
        delete cp.musicTaskId; delete cp.musicSubmissionPending;
        const packageResult = await this.working.commitValidatedArtifactsInTransaction(tx, projectId, body.workflowRunId, 'TEMPLATE_MIX', [{
          artifactKey: `timeline-package:${templateId}:${row.item.variantId}`,
          input: { kind: 'STRUCTURED', name: `${row.item.name} · 智能包装`, directory: 'EDITING_PROJECTS', type: 'TIMELINE_PROJECT',
            payload: { schemaVersion: 1, templateId, variantId: row.item.variantId, sourceTimelineHash: row.item.sourceTimelineHash,
              visualArtifactId: visual.id, visualRevision: visual.revision, duration: row.snapshot.duration, ...cp,
              mix: { originalVolume: .15, bgmVolume: .12, ducking: true }, subtitleStyle: 'standard' },
            files: files.filter((f) => audioIds(cp).includes(f.id)).map((f, sortOrder) => ({ fileObjectId: f.id, role: f.id === cp.music!.fileObjectId ? 'BGM' : 'VOICE', sortOrder, originalFileName: f.originalFileName, mimeType: f.mimeType, sha256: f.sha256 })),
            dependencies: dependencies.map((d) => ({ sourceType: 'WORKING_ARTIFACT', sourceNodeId: d.nodeId, sourceArtifactId: d.artifactId, sourceKey: d.artifactKey, sourceRevision: d.revision, sourceHash: d.contentHash })) },
        }]);
        const packaging = packageResult[0]!.record;
        const firstClip = row.snapshot.clips[0]!;
        const snapshot: FinalOutputSnapshot = { timeline: row.snapshot, packaging: cp,
          dependencies: [...dependencies, { artifactId: packaging.id, revision: packaging.revision, contentHash: packaging.contentHash }],
          aspectRatio: workspace.materials.find((m) => m.fileObjectId === firstClip.fileObjectId)?.ratio ?? '9:16', originalVolume: .15 };
        outputRows.push({ variantId: row.item.variantId, name: row.item.name, snapshot: json(snapshot) });
      }
      const run = await tx.effectFinalOutputRun.create({ data: { projectId, workflowRunId: body.workflowRunId, templateId, idempotencyKey: body.idempotencyKey, requestHash, inputHash, items: { create: outputRows } } });
      await this.enqueue(tx, projectId, run.id);
      await tx.workflowRun.updateMany({ where: { id: body.workflowRunId, projectId }, data: { currentNodeId: 'FINAL_OUTPUT' } });
      return run.id;
    }, { timeout: 120_000 });
    return this.get(projectId, runId);
  }

  async get(projectId: string, id: string): Promise<FinalOutputRun> {
    const run = await this.db.effectFinalOutputRun.findFirst({ where: { projectId, id }, include });
    if (!run) throw new NotFoundException('成片输出任务不存在');
    return { id, templateId: run.templateId, workflowRunId: run.workflowRunId, status: run.status as FinalOutputRun['status'], createdAt: run.createdAt.toISOString(),
      items: run.items.map((i) => ({ id: i.id, variantId: i.variantId, name: i.name, status: i.status as FinalOutputRun['status'],
        duration: (i.snapshot as unknown as FinalOutputSnapshot).timeline.duration, progress: i.progress, errorMessage: i.errorMessage, fileObjectId: i.fileObjectId, assetId: i.assetId })),
      counts: { total: run.items.length, queued: run.items.filter((i) => i.status === 'QUEUED').length, running: run.items.filter((i) => i.status === 'RUNNING').length,
        completed: run.items.filter((i) => i.status === 'COMPLETED').length, failed: run.items.filter((i) => ['FAILED', 'CANCELLED'].includes(i.status)).length } };
  }
  async list(projectId: string, workflowRunId: string) {
    const runs = await this.db.effectFinalOutputRun.findMany({ where: { projectId, workflowRunId }, orderBy: { createdAt: 'desc' }, take: 20 });
    return Promise.all(runs.map((r) => this.get(projectId, r.id)));
  }
  async claim(projectId: string, id: string) {
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM effect_final_output_runs WHERE id=${id}::uuid AND "projectId"=${projectId}::uuid FOR UPDATE`;
      const run = await tx.effectFinalOutputRun.findFirst({ where: { projectId, id }, include });
      if (!run || !['QUEUED', 'RUNNING'].includes(run.status) || (run.status === 'RUNNING' && run.leaseExpiresAt && run.leaseExpiresAt > new Date())) return { terminal: true };
      const attemptToken = randomUUID();
      await tx.effectFinalOutputRun.update({ where: { id }, data: { status: 'RUNNING', attemptToken, leaseExpiresAt: lease() } });
      await tx.effectFinalOutputItem.updateMany({ where: { projectId, runId: id, status: { not: 'COMPLETED' } }, data: { status: 'QUEUED', progress: 0, errorMessage: null } });
      return { terminal: false, attemptToken, items: run.items.map((item) => item.status === 'COMPLETED' ? item : { ...item, status: 'QUEUED' }) };
    });
  }
  async heartbeat(projectId: string, id: string, token: string, tx: Prisma.TransactionClient = this.db) {
    if (!token) throw new ConflictException('输出租约已失效');
    const result = await tx.effectFinalOutputRun.updateMany({ where: { id, projectId, status: 'RUNNING', attemptToken: token, leaseExpiresAt: { gt: new Date() } }, data: { leaseExpiresAt: lease() } });
    if (!result.count) throw new ConflictException('输出租约已失效');
    return { accepted: true };
  }
  private async current(tx: Prisma.TransactionClient, projectId: string, workflowRunId: string, templateId: string, snapshot: FinalOutputSnapshot) {
    const deps = snapshot.dependencies;
    const rows = await tx.workingArtifact.findMany({ where: { projectId, workflowRunId, id: { in: deps.map((d) => d.artifactId) } } });
    if (deps.some((d) => !rows.some((a) => a.id === d.artifactId && a.revision === d.revision && a.contentHash === d.contentHash && a.freshness === 'CURRENT' && a.availability === 'AVAILABLE')))
      throw new ConflictException('画面或包装已过期，请回模板混剪恢复');
    const state = await tx.workflowNodeState.findUnique({ where: { projectId_workflowRunId_nodeId: { projectId, workflowRunId, nodeId: 'TEMPLATE_MIX' } } });
    const draft = state?.state as unknown as { templates?: { id: string; workspace: { variants: PackagingSnapshot['variant'][] } }[] };
    const variant = draft?.templates?.find((t) => t.id === templateId)?.workspace.variants.find((v) => v.id === snapshot.timeline.variant.id);
    if (!variant || visualHash(variant) !== snapshot.timeline.sourceTimelineHash) throw new ConflictException('画面草稿已改变，请回模板混剪恢复');
    const ids = [...new Set([...snapshot.timeline.clips.map((c) => c.fileObjectId), ...audioIds(snapshot.packaging)])];
    if (await tx.fileObject.count({ where: { projectId, workflowRunId, id: { in: ids }, status: 'AVAILABLE' } }) !== ids.length)
      throw new ConflictException('输出源文件不可用');
  }
  private async workerItem(projectId: string, runId: string, token: string, itemId: string) {
    await this.heartbeat(projectId, runId, token);
    const item = await this.db.effectFinalOutputItem.findFirst({ where: { id: itemId, projectId, runId }, include: { run: true } });
    if (!item) throw new NotFoundException('输出条目不存在');
    const snapshot = item.snapshot as unknown as FinalOutputSnapshot;
    await this.current(this.db, projectId, item.run.workflowRunId, item.run.templateId, snapshot);
    return { item, snapshot };
  }
  async content(projectId: string, runId: string, token: string, itemId: string, fileId: string) {
    const { item, snapshot } = await this.workerItem(projectId, runId, token, itemId);
    if (![...snapshot.timeline.clips.map((c) => c.fileObjectId), ...audioIds(snapshot.packaging)].includes(fileId)) throw new NotFoundException('文件不属于此输出条目');
    const file = await this.db.fileObject.findFirstOrThrow({ where: { projectId, workflowRunId: item.run.workflowRunId, id: fileId, status: 'AVAILABLE' } });
    return { ...await this.storage.open(file.storageKey), mimeType: file.mimeType };
  }
  async progress(projectId: string, runId: string, token: string, itemId: string, progress: number, errorMessage?: string) {
    if (!errorMessage) await this.workerItem(projectId, runId, token, itemId);
    return this.db.$transaction(async (tx) => {
      await this.heartbeat(projectId, runId, token, tx);
      await tx.effectFinalOutputItem.updateMany({ where: { id: itemId, projectId, runId, status: { not: 'COMPLETED' } }, data: { status: errorMessage ? 'FAILED' : 'RUNNING', progress: Math.max(0, Math.min(99, progress)), errorMessage: errorMessage ?? null } });
      return { accepted: true };
    });
  }
  async upload(projectId: string, runId: string, token: string, itemId: string, file?: { path: string; size: number }) {
    const { item, snapshot } = await this.workerItem(projectId, runId, token, itemId);
    if (item.status === 'COMPLETED') return { fileObjectId: item.fileObjectId };
    if (!file || file.size < 32 || file.size > 2_000_000_000) throw new BadRequestException('输出视频文件无效');
    const handle = await open(file.path, 'r');
    try { const header = Buffer.alloc(12); await handle.read(header, 0, 12, 0); if (header.toString('ascii', 4, 8) !== 'ftyp') throw new BadRequestException('输出必须为 MP4'); } finally { await handle.close(); }
    const hash = createHash('sha256'); for await (const chunk of createReadStream(file.path)) hash.update(chunk);
    const sha256 = hash.digest('hex');
    const project = await this.db.project.findUniqueOrThrow({ where: { id: projectId } });
    const originalFileName = `${item.name.replace(/[\\/:*?"<>|]/g, '-')}.mp4`;
    const stored = await this.storage.put({ projectId, stream: createReadStream(file.path), sizeBytes: file.size, contentType: 'video/mp4',
      keyContext: { projectName: project.name, workflow: 'effect', lifecycle: 'assets', category: 'final-output', originalFileName } });
    try {
      return await this.db.$transaction(async (tx) => {
        await this.heartbeat(projectId, runId, token, tx);
        await tx.$queryRaw`SELECT id FROM workflow_node_states WHERE "projectId"=${projectId}::uuid AND "workflowRunId"=${item.run.workflowRunId}::uuid AND "nodeId"='TEMPLATE_MIX' FOR SHARE`;
        await tx.$queryRaw`SELECT id FROM working_artifacts WHERE "projectId"=${projectId}::uuid AND "workflowRunId"=${item.run.workflowRunId}::uuid ORDER BY id FOR SHARE`;
        await this.current(tx, projectId, item.run.workflowRunId, item.run.templateId, snapshot);
        const latest = await tx.effectFinalOutputItem.findUniqueOrThrow({ where: { id: itemId } });
        if (latest.status === 'COMPLETED') throw new ConflictException('输出已保存，请读取已完成结果');
        const fileObject = await tx.fileObject.create({ data: { projectId, workflowRunId: item.run.workflowRunId, nodeId: 'FINAL_OUTPUT', originalFileName, mimeType: 'video/mp4', sizeBytes: file.size, storageKey: stored.key, sha256 } });
        const [result] = await this.working.commitValidatedArtifactsInTransaction(tx, projectId, item.run.workflowRunId, 'FINAL_OUTPUT', [{ artifactKey: `final-video:${item.run.templateId}:${item.variantId}`, input: {
          kind: 'FILE', name: item.name, directory: 'FINAL_VIDEOS', type: 'FINAL_VIDEO', originalFileName, mimeType: 'video/mp4', sizeBytes: file.size, storageKey: stored.key, fileChecksum: sha256,
          metadata: { duration: snapshot.timeline.duration, variantId: item.variantId },
          files: [{ fileObjectId: fileObject.id, role: 'VIDEO', sortOrder: 0, originalFileName, mimeType: 'video/mp4', sha256 }],
          dependencies: (await tx.workingArtifact.findMany({ where: { projectId, id: { in: snapshot.dependencies.map((d) => d.artifactId) } } })).map((a) => ({ sourceType: 'WORKING_ARTIFACT', sourceNodeId: a.nodeId, sourceArtifactId: a.id, sourceKey: a.artifactKey, sourceRevision: a.revision, sourceHash: a.contentHash })),
        } }]);
        const asset = await tx.asset.create({ data: { projectId, name: item.name, directory: 'FINAL_VIDEOS', type: 'FINAL_VIDEO', originalFileName, mimeType: 'video/mp4', sizeBytes: file.size, storageKey: stored.key,
          sourceNode: 'FINAL_OUTPUT', sourceRunId: item.run.workflowRunId, sourceArtifactId: result!.record.id, idempotencyKey: `final-output:${itemId}`,
          versions: { create: { projectId, version: 1, changeNote: '智能成片输出', status: 'AVAILABLE', qualityStatus: 'AVAILABLE', originalFileName, mimeType: 'video/mp4', sizeBytes: file.size, storageKey: stored.key } } } });
        await tx.effectFinalOutputItem.update({ where: { id: itemId }, data: { status: 'COMPLETED', progress: 100, errorMessage: null, fileObjectId: fileObject.id, assetId: asset.id } });
        return { fileObjectId: fileObject.id };
      }, { timeout: 30_000 });
    } catch (error) { await this.storage.delete(stored.key).catch(() => undefined); throw error; }
  }
  async finish(projectId: string, id: string, token: string) {
    return this.db.$transaction(async (tx) => {
      await this.heartbeat(projectId, id, token, tx);
      const items = await tx.effectFinalOutputItem.findMany({ where: { projectId, runId: id } });
      if (items.some((i) => ['QUEUED', 'RUNNING'].includes(i.status))) throw new ConflictException('仍有输出未完成');
      const completed = items.filter((i) => i.status === 'COMPLETED').length;
      await tx.effectFinalOutputRun.update({ where: { id }, data: { status: completed === items.length ? 'COMPLETED' : completed ? 'PARTIAL' : 'FAILED', attemptToken: null, leaseExpiresAt: null, completedAt: new Date() } });
      return { accepted: true };
    });
  }
  async cancel(projectId: string, id: string) {
    return this.db.$transaction(async (tx) => {
      const result = await tx.effectFinalOutputRun.updateMany({ where: { projectId, id, status: { in: ['QUEUED', 'RUNNING'] } }, data: { status: 'CANCELLED', attemptToken: null, leaseExpiresAt: null, completedAt: new Date() } });
      if (result.count) await tx.effectFinalOutputItem.updateMany({ where: { projectId, runId: id, status: { in: ['QUEUED', 'RUNNING'] } }, data: { status: 'CANCELLED' } });
      return { accepted: true };
    });
  }
  async retry(projectId: string, id: string) {
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM effect_final_output_runs WHERE id=${id}::uuid AND "projectId"=${projectId}::uuid FOR UPDATE`;
      const run = await tx.effectFinalOutputRun.findFirst({ where: { projectId, id }, include });
      if (!run || !['PARTIAL', 'FAILED', 'CANCELLED'].includes(run.status)) throw new ConflictException('当前输出不可恢复');
      for (const item of run.items) if (item.status !== 'COMPLETED') await this.current(tx, projectId, run.workflowRunId, run.templateId, item.snapshot as unknown as FinalOutputSnapshot);
      await tx.effectFinalOutputItem.updateMany({ where: { projectId, runId: id, status: { not: 'COMPLETED' } }, data: { status: 'QUEUED', progress: 0, errorMessage: null } });
      await tx.effectFinalOutputRun.update({ where: { id }, data: { status: 'QUEUED', attemptToken: null, leaseExpiresAt: null, completedAt: null } });
      await this.enqueue(tx, projectId, id); return { accepted: true };
    }, { timeout: 30_000 });
  }
  async recoverExpired() {
    const rows = await this.db.effectFinalOutputRun.findMany({ where: { status: 'RUNNING', leaseExpiresAt: { lt: new Date() } }, take: 50 });
    for (const row of rows) await this.db.$transaction(async (tx) => {
      const changed = await tx.effectFinalOutputRun.updateMany({ where: { id: row.id, status: 'RUNNING', leaseExpiresAt: { lt: new Date() } }, data: { status: 'QUEUED', attemptToken: null, leaseExpiresAt: null } });
      if (changed.count) await this.enqueue(tx, row.projectId, row.id);
    });
  }
}
