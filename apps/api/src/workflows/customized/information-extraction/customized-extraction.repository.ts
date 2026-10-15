import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  CUSTOMIZED_BRIEF_ARTIFACT_KEY,
  CUSTOMIZED_SOURCE_ARTIFACT_KEY,
  CUSTOMIZED_EXTRACTION_NODES,
  normalizeCustomizedImportDraft,
  type CustomizedBriefCandidate,
  type CustomizedExtractionTask,
  type SaveCustomizedExtractionRequest,
  type StartCustomizedExtractionRequest,
} from '@ai-marketing/contracts';
import {
  Prisma,
  type CustomizedExtractionTask as TaskRecord,
} from '../../../generated/prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { ApiHttpException } from '../../../common/api-http-exception';
import {
  customizedScope,
  lockCustomizedProject,
  customizedConflict,
  beginCustomizedEdit,
  cancelCustomizedEdit,
} from '../../../platform/workflow/customized-branches';
import { workflowStateHash } from '../../../platform/workflow/workflow-state-hash';
import { readCustomizedExtractionResult } from '../../../platform/workflow/customized-inherited-extraction';
import { WorkflowWorkingRepository } from '../../../platform/workflow/workflow-working.repository';

const json = (value: unknown) => value as Prisma.InputJsonValue;
const missing = () => new ApiHttpException('提炼记录不存在', 404, 'ASSET_NOT_FOUND');
export type ExtractionInput = {
  source: { artifactId: string; revision: number; fingerprint: string };
  documents: Array<{
    assetId: string;
    assetVersion: number;
    name: string;
    storageKey: string;
    sizeBytes: number;
  }>;
  brandReferences: ReturnType<typeof normalizeCustomizedImportDraft>['materials'];
  sourceWarnings?: string[];
  documentsAvailable?: boolean;
};
export const presentTask = (
  task: TaskRecord & {
    steps?: Array<{
      nodeId: string;
      sourceId: string;
      status: string;
      errorMessage: string | null;
    }>;
  },
): CustomizedExtractionTask => ({
  id: task.id,
  projectId: task.projectId,
  workflowRunId: task.workflowRunId,
  status: task.status as CustomizedExtractionTask['status'],
  progress: task.progress,
  currentNode: task.currentNode,
  errorMessage: task.errorMessage,
  nodes: CUSTOMIZED_EXTRACTION_NODES.map((node) => {
    const step = task.steps?.find((s) => s.nodeId === node.id && !s.sourceId);
    return {
      nodeId: node.id,
      status: (step?.status ?? 'PENDING') as CustomizedExtractionTask['nodes'][number]['status'],
      errorMessage: step?.errorMessage ?? null,
      warnings: [],
    };
  }),
  createdAt: task.createdAt.toISOString(),
  updatedAt: task.updatedAt.toISOString(),
});

@Injectable()
export class CustomizedExtractionRepository {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(WorkflowWorkingRepository) private readonly working: WorkflowWorkingRepository,
  ) {}

  private async scope(
    tx: Prisma.TransactionClient,
    projectId: string,
    workflowRunId: string,
    writable = false,
  ) {
    const run = await tx.workflowRun.findFirst({
      where: {
        ...customizedScope(projectId),
        id: workflowRunId,
        status: { in: ['ACTIVE', 'PAUSED'] },
      },
    });
    if (!run) throw missing();
    if (
      writable &&
      (run.activeKey !== 'ACTIVE' ||
        (run.editSessionNodeId && run.editSessionNodeId !== 'INFORMATION_EXTRACTION'))
    )
      return customizedConflict('请先保存或取消其他节点编辑，或重新加载当前版本');
    if (await tx.project.count({ where: { id: projectId, deletionState: { not: null } } }))
      return customizedConflict('项目正在删除');
    return run;
  }

  async input(
    tx: Prisma.TransactionClient,
    projectId: string,
    workflowRunId: string,
    requireDocuments = true,
  ): Promise<ExtractionInput | null> {
    const source = await tx.workingArtifact.findFirst({
      where: {
        projectId,
        workflowRunId,
        artifactKey: CUSTOMIZED_SOURCE_ARTIFACT_KEY,
        availability: 'AVAILABLE',
      },
    });
    if (!source) return null;
    const payload = normalizeCustomizedImportDraft(source.payload);
    const references = payload.materials;
    const versions = references.length
      ? await tx.assetVersion.findMany({
          where: {
            projectId,
            OR: references.map((r) => ({ assetId: r.assetId, version: r.assetVersion })),
            asset: {
              storageWorkflow: 'CUSTOMIZED',
              workflowSpace: 'CUSTOMIZED_PROJECT',
              directory: 'SOURCE_MATERIALS',
              archivedAt: null,
            },
          },
        })
      : [];
    const sourceWarnings: string[] = [];
    const brandReferences: ExtractionInput['brandReferences'] = [];
    const documents: ExtractionInput['documents'] = [];
    let documentsAvailable = true;
    for (const ref of references) {
      const v = versions.find((v) => v.assetId === ref.assetId && v.version === ref.assetVersion);
      const image = ref.category === 'VISUAL_REFERENCE' || v?.mimeType?.startsWith('image/');
      if (image) {
        brandReferences.push(ref);
        if (!v?.storageKey || v.status === 'UNAVAILABLE')
          sourceWarnings.push('部分品牌素材引用不可用，请在资料导入中替换；不影响文档提炼。');
        continue;
      }
      if (!v?.storageKey || v.status === 'UNAVAILABLE') {
        if (requireDocuments) return customizedConflict('简报文档版本不可用，请返回资料导入处理');
        documentsAvailable = false;
        sourceWarnings.push('部分简报文档版本不可用，已有结果仍可查看，请返回资料导入处理。');
        continue;
      }
      if (!/\.(docx|pdf|xlsx|txt|md)$/i.test(v.originalFileName ?? '')) {
        if (requireDocuments)
          return customizedConflict(
            '历史文档格式暂不支持提炼，请转换为 DOCX、PDF、XLSX、TXT 或 Markdown 后重新导入',
          );
        sourceWarnings.push('历史 DOC、XLS 文档请转换为 DOCX、XLSX 后重新导入。');
        documentsAvailable = false;
      }
      documents.push({
        assetId: ref.assetId,
        assetVersion: ref.assetVersion,
        name: v.originalFileName ?? '简报文档',
        storageKey: v.storageKey,
        sizeBytes: v.sizeBytes,
      });
    }
    const identity = {
      artifactId: source.sourceArtifactId ?? source.id,
      revision: source.revision,
      payload,
    };
    return {
      source: {
        artifactId: identity.artifactId,
        revision: source.revision,
        fingerprint: workflowStateHash(identity),
      },
      documents,
      brandReferences,
      sourceWarnings: [...new Set(sourceWarnings)],
      documentsAvailable,
    };
  }

  workspace(projectId: string, workflowRunId: string) {
    return this.db.$transaction(async (tx) => {
      const run = await this.scope(tx, projectId, workflowRunId);
      const input = await this.input(tx, projectId, workflowRunId, false);
      const resolved = await readCustomizedExtractionResult(
        tx,
        projectId,
        workflowRunId,
        input?.source.fingerprint,
      );
      const result = resolved?.record;
      const localTask = await tx.customizedExtractionTask.findFirst({
        where: { projectId, workflowRunId },
        orderBy: { createdAt: 'desc' },
        include: { steps: true },
      });
      const task =
        localTask ??
        (result && resolved?.evidenceMatches
          ? await tx.customizedExtractionTask.findFirst({
              where: { projectId, id: result.taskId },
              include: { steps: true },
            })
          : null);
      const artifact = await tx.workingArtifact.findFirst({
        where: { projectId, workflowRunId, artifactKey: CUSTOMIZED_BRIEF_ARTIFACT_KEY },
      });
      const draftResult = result?.draftResult as unknown as CustomizedBriefCandidate | undefined;
      const manualFields = new Set(Object.keys((result?.manualOverrides ?? {}) as object));
      return {
        projectId,
        workflowRunId,
        source: input?.source ?? null,
        brandReferences: input?.brandReferences ?? [],
        sourceWarnings: input?.sourceWarnings ?? [],
        result: result
          ? {
              ...draftResult!,
              // Keep original evidence in generatedResult; a manual replacement must not
              // be presented as a verbatim fact from its old document.
              fieldSources: Object.fromEntries(
                Object.entries(draftResult!.fieldSources).filter(([key]) => !manualFields.has(key)),
              ),
              id: result.id,
              revision: result.revision,
              sourceFingerprint: result.sourceFingerprint,
            }
          : null,
        task: task ? presentTask(task) : null,
        committed: Boolean(artifact),
        stale: Boolean(
          (artifact && !input) ||
          input?.documentsAvailable === false ||
          // A newly generated draft may be fresh while the previously confirmed
          // artifact is still stale. Confirmation is what replaces that artifact.
          (result && !resolved?.inherited
            ? result.sourceFingerprint !== input?.source.fingerprint
            : artifact?.freshness === 'STALE'),
        ),
        editing: !artifact || run.editSessionNodeId === 'INFORMATION_EXTRACTION',
        temporary:
          run.editSessionNodeId === 'INFORMATION_EXTRACTION' && Boolean(run.parentWorkflowRunId),
      };
    });
  }

  start(projectId: string, request: StartCustomizedExtractionRequest) {
    return this.db.$transaction(async (tx) => {
      await lockCustomizedProject(tx, projectId);
      await this.scope(tx, projectId, request.workflowRunId, true);
      const old = await tx.customizedExtractionTask.findUnique({
        where: { projectId_idempotencyKey: { projectId, idempotencyKey: request.idempotencyKey } },
        include: { steps: true },
      });
      if (old) {
        const snapshot = old.inputSnapshot as unknown as ExtractionInput;
        if (
          old.workflowRunId !== request.workflowRunId ||
          snapshot.source.artifactId !== request.sourceArtifactId ||
          snapshot.source.revision !== request.sourceRevision
        )
          return customizedConflict('幂等请求作用域不匹配');
        return presentTask(old);
      }
      const artifact = await tx.workingArtifact.findFirst({
        where: {
          projectId,
          workflowRunId: request.workflowRunId,
          artifactKey: CUSTOMIZED_BRIEF_ARTIFACT_KEY,
        },
      });
      const run = await this.scope(tx, projectId, request.workflowRunId, true);
      if (artifact && run.editSessionNodeId !== 'INFORMATION_EXTRACTION')
        return customizedConflict('请先进入信息提炼编辑');
      const input = await this.input(tx, projectId, request.workflowRunId);
      if (!input?.documents.length) return customizedConflict('请先保存至少一份简报文档');
      if (
        input.source.artifactId !== request.sourceArtifactId ||
        input.source.revision !== request.sourceRevision
      )
        return customizedConflict('资料版本已变化，请重新加载');
      const active = await tx.customizedExtractionTask.findFirst({
        where: {
          projectId,
          workflowRunId: request.workflowRunId,
          status: { in: ['QUEUED', 'RUNNING'] },
        },
        include: { steps: true },
      });
      if (active) return presentTask(active);
      const task = await tx.customizedExtractionTask.create({
        data: {
          projectId,
          workflowRunId: request.workflowRunId,
          idempotencyKey: request.idempotencyKey,
          inputHash: input.source.fingerprint,
          inputSnapshot: json(input),
        },
      });
      await tx.customizedExtractionFileHold.createMany({
        data: [...new Set(input.documents.map((d) => d.storageKey))].map((storageKey) => ({
          projectId,
          taskId: task.id,
          storageKey,
        })),
      });
      await this.enqueue(tx, task);
      return presentTask(task);
    });
  }

  private enqueue(tx: Prisma.TransactionClient, task: TaskRecord) {
    return tx.jobOutbox.upsert({
      where: {
        projectId_jobType_aggregateId: {
          projectId: task.projectId,
          jobType: 'CUSTOMIZED_EXTRACTION',
          aggregateId: task.id,
        },
      },
      create: {
        projectId: task.projectId,
        jobType: 'CUSTOMIZED_EXTRACTION',
        aggregateId: task.id,
        routingKey: 'customized.extraction.requested',
        payload: {
          schemaVersion: 1,
          projectId: task.projectId,
          runId: task.id,
          requestId: randomUUID(),
        },
      },
      update: { status: 'PENDING', nextAttemptAt: new Date(), attempts: 0, publishedAt: null },
    });
  }

  async task(projectId: string, taskId: string) {
    const task = await this.db.customizedExtractionTask.findFirst({
      where: { projectId, id: taskId },
      include: { steps: true },
    });
    if (!task) throw missing();
    await this.db.$transaction((tx) => this.scope(tx, projectId, task.workflowRunId));
    return task;
  }

  claim(projectId: string, taskId: string) {
    return this.db.$transaction(async (tx) => {
      await lockCustomizedProject(tx, projectId);
      const task = await tx.customizedExtractionTask.findFirst({
        where: { projectId, id: taskId },
      });
      if (!task) throw missing();
      await this.scope(tx, projectId, task.workflowRunId, true);
      if (['COMPLETED', 'FAILED', 'PARTIAL', 'CANCELLED'].includes(task.status))
        return { terminal: true };
      if (task.status === 'RUNNING' && task.leaseExpiresAt && task.leaseExpiresAt > new Date())
        return { busy: true };
      const input = await this.input(tx, projectId, task.workflowRunId);
      if (input?.source.fingerprint !== task.inputHash) return customizedConflict('执行来源已变化');
      const attemptToken = randomUUID();
      await tx.customizedExtractionTask.update({
        where: { id: taskId },
        data: {
          status: 'RUNNING',
          attemptToken,
          attemptCount: { increment: 1 },
          leaseExpiresAt: new Date(Date.now() + 90000),
        },
      });
      const checkpoints = await tx.customizedExtractionStep.findMany({
        where: { projectId, taskId, status: 'SUCCEEDED' },
      });
      return { terminal: false, attemptToken, input: task.inputSnapshot, checkpoints };
    });
  }

  private async lease(
    tx: Prisma.TransactionClient,
    projectId: string,
    taskId: string,
    token: string,
  ) {
    await lockCustomizedProject(tx, projectId);
    const task = await tx.customizedExtractionTask.findFirst({
      where: {
        projectId,
        id: taskId,
        status: 'RUNNING',
        attemptToken: token,
        leaseExpiresAt: { gt: new Date() },
      },
    });
    if (!task) return customizedConflict('任务租约已失效');
    await this.scope(tx, projectId, task.workflowRunId, true);
    const input = await this.input(tx, projectId, task.workflowRunId);
    if (input?.source.fingerprint !== task.inputHash) return customizedConflict('执行来源已变化');
    return task;
  }

  progress(projectId: string, taskId: string, token: string, progress: number, nodeId: string) {
    return this.db.$transaction(async (tx) => {
      const task = await this.lease(tx, projectId, taskId, token);
      await tx.customizedExtractionTask.update({
        where: { id: taskId },
        data: {
          progress: Math.max(task.progress, Math.min(99, progress)),
          currentNode: nodeId,
          leaseExpiresAt: new Date(Date.now() + 90000),
        },
      });
      return { accepted: true };
    });
  }

  step(
    projectId: string,
    taskId: string,
    token: string,
    nodeId: string,
    sourceId: string,
    status: string,
    output: unknown,
    errorMessage: string | null,
  ) {
    return this.db.$transaction(async (tx) => {
      const task = await this.lease(tx, projectId, taskId, token);
      const input = task.inputSnapshot as unknown as ExtractionInput;
      if (sourceId && !input.documents.some((d) => d.assetId === sourceId))
        return customizedConflict('文件不属于任务快照');
      return tx.customizedExtractionStep.upsert({
        where: { projectId_taskId_nodeId_sourceId: { projectId, taskId, nodeId, sourceId } },
        create: { projectId, taskId, nodeId, sourceId, status, output: json(output), errorMessage },
        update: { status, output: json(output), errorMessage },
      });
    });
  }

  access(projectId: string, taskId: string, token: string) {
    return this.db.$transaction((tx) => this.lease(tx, projectId, taskId, token));
  }
  completionAccess(projectId: string, taskId: string, token: string) {
    return this.db.$transaction(async (tx) => {
      await lockCustomizedProject(tx, projectId);
      const task = await tx.customizedExtractionTask.findFirst({
        where: { projectId, id: taskId, status: 'COMPLETED', attemptToken: token },
      });
      if (task) {
        await this.scope(tx, projectId, task.workflowRunId, true);
        return task;
      }
      return this.lease(tx, projectId, taskId, token);
    });
  }
  async artifact(
    projectId: string,
    taskId: string,
    token: string,
    sourceId: string,
    storageKey: string,
    sizeBytes: number,
  ) {
    return this.db.$transaction(async (tx) => {
      const task = await this.lease(tx, projectId, taskId, token);
      if (
        !(task.inputSnapshot as unknown as ExtractionInput).documents.some(
          (d) => d.assetId === sourceId,
        )
      )
        return customizedConflict('文件不属于任务快照');
      return tx.customizedExtractionArtifact.upsert({
        where: { projectId_taskId_sourceId: { projectId, taskId, sourceId } },
        create: { projectId, taskId, sourceId, storageKey, sizeBytes },
        update: {},
      });
    });
  }
  findArtifact(projectId: string, taskId: string, sourceId: string) {
    return this.db.customizedExtractionArtifact.findUnique({
      where: { projectId_taskId_sourceId: { projectId, taskId, sourceId } },
    });
  }

  complete(projectId: string, taskId: string, token: string, candidate: CustomizedBriefCandidate) {
    return this.db.$transaction(async (tx) => {
      await lockCustomizedProject(tx, projectId);
      const completed = await tx.customizedExtractionTask.findFirst({
        where: { projectId, id: taskId, status: 'COMPLETED', attemptToken: token },
      });
      if (completed) {
        await this.scope(tx, projectId, completed.workflowRunId, true);
        const existing = await tx.customizedExtractionResult.findFirst({
          where: { projectId, workflowRunId: completed.workflowRunId, taskId },
        });
        if (
          !existing ||
          workflowStateHash(existing.generatedResult) !== workflowStateHash(candidate)
        )
          return customizedConflict('任务结果已完成，回调内容不匹配');
        return { resultId: existing.id };
      }
      const task = await this.lease(tx, projectId, taskId, token);
      const input = task.inputSnapshot as unknown as ExtractionInput;
      const steps = await tx.customizedExtractionStep.findMany({
        where: { projectId, taskId, status: 'SUCCEEDED' },
      });
      if (
        CUSTOMIZED_EXTRACTION_NODES.some(
          (n) => !steps.some((s) => s.nodeId === n.id && !s.sourceId),
        ) ||
        input.documents.some(
          (d) => !steps.some((s) => s.nodeId === 'DOCUMENT_EXTRACT' && s.sourceId === d.assetId),
        )
      )
        return customizedConflict('提炼步骤尚未完整成功');
      const previous = await tx.customizedExtractionResult.findUnique({
        where: { projectId_workflowRunId: { projectId, workflowRunId: task.workflowRunId } },
      });
      const overrides =
        previous?.sourceFingerprint === task.inputHash
          ? (previous.manualOverrides as Record<string, unknown>)
          : {};
      const draft = { ...candidate, fields: { ...candidate.fields, ...overrides } };
      const data = {
        taskId,
        sourceFingerprint: task.inputHash,
        generatedResult: json(candidate),
        draftResult: json(draft),
        manualOverrides: json(overrides),
      };
      const result = await tx.customizedExtractionResult.upsert({
        where: { projectId_workflowRunId: { projectId, workflowRunId: task.workflowRunId } },
        create: { projectId, workflowRunId: task.workflowRunId, ...data },
        update: { ...data, revision: { increment: 1 } },
      });
      await tx.customizedExtractionTask.update({
        where: { id: taskId },
        data: { status: 'COMPLETED', progress: 100, leaseExpiresAt: null, errorMessage: null },
      });
      return { resultId: result.id };
    });
  }

  fail(projectId: string, taskId: string, token: string, partial: boolean, errorMessage: string) {
    return this.db.$transaction(async (tx) => {
      await lockCustomizedProject(tx, projectId);
      const existing = await tx.customizedExtractionTask.findFirst({
        where: {
          projectId,
          id: taskId,
          attemptToken: token,
          status: partial ? 'PARTIAL' : 'FAILED',
        },
      });
      if (existing) {
        await this.scope(tx, projectId, existing.workflowRunId, true);
        if (existing.errorMessage !== errorMessage) return customizedConflict('失败回调内容不匹配');
        return { accepted: true };
      }
      await this.lease(tx, projectId, taskId, token);
      await tx.customizedExtractionTask.update({
        where: { id: taskId },
        data: {
          status: partial ? 'PARTIAL' : 'FAILED',
          errorMessage,
          leaseExpiresAt: null,
        },
      });
      return { accepted: true };
    });
  }

  retry(projectId: string, taskId: string) {
    return this.db.$transaction(async (tx) => {
      await lockCustomizedProject(tx, projectId);
      const task = await tx.customizedExtractionTask.findFirst({
        where: { projectId, id: taskId },
      });
      if (!task) throw missing();
      await this.scope(tx, projectId, task.workflowRunId, true);
      const input = await this.input(tx, projectId, task.workflowRunId);
      if (input?.source.fingerprint !== task.inputHash)
        return customizedConflict('来源已变化，请重新提炼');
      const latest = await tx.customizedExtractionTask.findFirst({
        where: { projectId, workflowRunId: task.workflowRunId },
        orderBy: { createdAt: 'desc' },
      });
      if (latest?.id !== taskId) return customizedConflict('已有更新的提炼任务，请重新加载');
      if (!['FAILED', 'PARTIAL'].includes(task.status))
        return customizedConflict('当前任务不支持重试');
      if (
        await tx.customizedExtractionTask.count({
          where: {
            projectId,
            workflowRunId: task.workflowRunId,
            status: { in: ['QUEUED', 'RUNNING'] },
          },
        })
      )
        return customizedConflict('已有任务执行中');
      const next = await tx.customizedExtractionTask.update({
        where: { id: taskId },
        data: { status: 'QUEUED', errorMessage: null, attemptToken: null, leaseExpiresAt: null },
      });
      await this.enqueue(tx, next);
      return presentTask(next);
    });
  }

  update(projectId: string, resultId: string, request: SaveCustomizedExtractionRequest) {
    return this.db.$transaction(async (tx) => {
      await lockCustomizedProject(tx, projectId);
      const old = await tx.customizedExtractionResult.findFirst({
        where: { projectId, id: resultId },
      });
      if (!old) throw missing();
      const run = await this.scope(tx, projectId, old.workflowRunId, true);
      if (
        run.editSessionNodeId !== 'INFORMATION_EXTRACTION' &&
        (await tx.workingArtifact.count({
          where: { projectId, workflowRunId: run.id, artifactKey: CUSTOMIZED_BRIEF_ARTIFACT_KEY },
        }))
      )
        return customizedConflict('请先进入编辑');
      if (
        await tx.customizedExtractionTask.count({
          where: { projectId, workflowRunId: run.id, status: { in: ['QUEUED', 'RUNNING'] } },
        })
      )
        return customizedConflict('提炼运行中，暂不能保存修改');
      if (old.revision !== request.expectedRevision)
        return customizedConflict('内容已被其他窗口更新，本地修改已保留');
      const generated = old.generatedResult as unknown as CustomizedBriefCandidate;
      const current = old.draftResult as unknown as CustomizedBriefCandidate;
      const allowed = new Set(current.issues.map((i) => i.id));
      if (request.resolvedIssueIds.some((id) => !allowed.has(id)))
        return customizedConflict('待确认事项已变化');
      const overrides: Record<string, unknown> = {};
      for (const key of Object.keys(request.fields))
        if (
          JSON.stringify(request.fields[key as keyof typeof request.fields]) !==
          JSON.stringify(generated.fields[key as keyof typeof request.fields])
        )
          overrides[key] = request.fields[key as keyof typeof request.fields];
      const draft = {
        ...current,
        fields: request.fields,
        issues: current.issues.filter((i) => !request.resolvedIssueIds.includes(i.id)),
      };
      if (workflowStateHash(draft) === workflowStateHash(current)) return old;
      return tx.customizedExtractionResult.update({
        where: { id: resultId },
        data: {
          draftResult: json(draft),
          manualOverrides: json(overrides),
          revision: { increment: 1 },
        },
      });
    });
  }

  confirm(projectId: string, resultId: string, expectedRevision: number) {
    return this.db.$transaction(
      async (tx) => {
        await lockCustomizedProject(tx, projectId);
        const result = await tx.customizedExtractionResult.findFirst({
          where: { projectId, id: resultId },
        });
        if (!result) throw missing();
        const run = await this.scope(tx, projectId, result.workflowRunId, true);
        const latest = await tx.customizedExtractionTask.findFirst({
          where: { projectId, workflowRunId: run.id },
          orderBy: { createdAt: 'desc' },
        });
        const source = await this.input(tx, projectId, run.id);
        if (
          result.revision !== expectedRevision ||
          result.sourceFingerprint !== source?.source.fingerprint ||
          (latest && (latest.id !== result.taskId || latest.status !== 'COMPLETED'))
        )
          return customizedConflict('结果或来源已变化，请重新提炼或加载最新内容');
        const draft = result.draftResult as unknown as CustomizedBriefCandidate;
        if (
          !draft.fields.productName.trim() ||
          !draft.fields.sellingPoints.some((s) => s.trim()) ||
          draft.issues.some((i) => i.blocking)
        )
          throw new ApiHttpException(
            '请补齐产品名称、核心卖点并处理待确认事项',
            400,
            'VALIDATION_ERROR',
          );
        const ownSource = await tx.workingArtifact.findFirstOrThrow({
          where: { projectId, workflowRunId: run.id, artifactKey: CUSTOMIZED_SOURCE_ARTIFACT_KEY },
        });
        const [committed] = await this.working.commitValidatedArtifactsInTransaction(
          tx,
          projectId,
          run.id,
          'INFORMATION_EXTRACTION',
          [
            {
              artifactKey: CUSTOMIZED_BRIEF_ARTIFACT_KEY,
              input: {
                kind: 'STRUCTURED',
                name: '视频创作信息卡',
                directory: 'INSIGHTS',
                type: 'INSIGHT_RESULT',
                payload: draft.fields,
                dependencies: [
                  {
                    sourceType: 'WORKING_ARTIFACT',
                    sourceArtifactId: ownSource.id,
                    sourceNodeId: 'SOURCE_IMPORT',
                    sourceKey: CUSTOMIZED_SOURCE_ARTIFACT_KEY,
                    sourceRevision: ownSource.revision,
                    sourceHash: ownSource.contentHash,
                  },
                ],
              },
            },
          ],
        );
        if (run.editSessionNodeId === 'INFORMATION_EXTRACTION' && run.parentWorkflowRunId) {
          if (committed!.unchanged) {
            const parent = await cancelCustomizedEdit(
              tx,
              projectId,
              run.id,
              'INFORMATION_EXTRACTION',
            );
            return { workflowRunId: parent.id, unchanged: true };
          }
          await tx.workflowRun.update({
            where: { id: run.id },
            data: {
              branchPublishedAt: new Date(),
              editSessionNodeId: null,
              editSessionPurpose: null,
              editBaselineHash: null,
            },
          });
        }
        return { workflowRunId: run.id, unchanged: committed!.unchanged };
      },
      { timeout: 30000 },
    );
  }

  beginEdit(projectId: string, runId: string) {
    return this.db.$transaction((tx) =>
      beginCustomizedEdit(tx, projectId, runId, 'INFORMATION_EXTRACTION'),
    );
  }
  cancelEdit(projectId: string, runId: string) {
    return this.db.$transaction((tx) =>
      cancelCustomizedEdit(tx, projectId, runId, 'INFORMATION_EXTRACTION'),
    );
  }

  async recoverExpired() {
    const tasks = await this.db.customizedExtractionTask.findMany({
      where: { status: 'RUNNING', leaseExpiresAt: { lt: new Date() } },
      take: 20,
    });
    for (const task of tasks)
      await this.db.$transaction(async (tx) => {
        await lockCustomizedProject(tx, task.projectId);
        const updated = await tx.customizedExtractionTask.updateMany({
          where: {
            id: task.id,
            status: 'RUNNING',
            attemptToken: task.attemptToken,
            leaseExpiresAt: { lt: new Date() },
          },
          data: {
            status: task.attemptCount >= 3 ? 'FAILED' : 'QUEUED',
            attemptToken: null,
            leaseExpiresAt: null,
            errorMessage: '执行中断，可重试恢复',
          },
        });
        if (updated.count && task.attemptCount < 3) await this.enqueue(tx, task);
      });
  }
}
