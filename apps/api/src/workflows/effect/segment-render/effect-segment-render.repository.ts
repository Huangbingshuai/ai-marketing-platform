import { randomUUID } from 'node:crypto';

import {
  EFFECT_SEGMENT_RENDER_JOB_TYPE,
  EFFECT_SEGMENT_RENDER_LIMITS,
  EFFECT_SEGMENT_RENDER_QUEUE,
} from '@ai-marketing/contracts';
import { Inject, Injectable, Optional } from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import {
  type WorkingArtifactUpsertInput,
  WorkflowWorkingRepository,
} from '../../../platform/workflow/workflow-working.repository';
import { workflowStateHash } from '../../../platform/workflow/workflow-state-hash';
import type {
  EffectSegmentRenderStoredFile,
  EffectSegmentRenderTaskCreateInput,
} from './effect-segment-render.types';

const json = (value: unknown): Prisma.InputJsonValue => value as Prisma.InputJsonValue;
const leaseDate = (now: Date): Date => new Date(now.getTime() + 90_000);
const isUniqueConflict = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';

export const effectSegmentRenderBatchInclude = {
  product: true,
  tasks: { orderBy: [{ renderCode: 'asc' as const }, { id: 'asc' as const }] },
} satisfies Prisma.EffectSegmentRenderBatchInclude;

export type EffectSegmentRenderBatchRecord = Prisma.EffectSegmentRenderBatchGetPayload<{
  include: typeof effectSegmentRenderBatchInclude;
}>;

export type CreateEffectSegmentRenderBatchInput = {
  batchId: string;
  promptArtifact: { id: string; revision: number; contentHash: string };
  sourceFingerprint: string;
  idempotencyKey: string;
  requestHash: string;
  tasks: EffectSegmentRenderTaskCreateInput[];
};

@Injectable()
export class EffectSegmentRenderRepository {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Optional()
    @Inject(WorkflowWorkingRepository)
    private readonly workingRepository?: WorkflowWorkingRepository,
  ) {}

  workflowRun(projectId: string, workflowRunId: string) {
    return this.prisma.workflowRun.findFirst({
      where: { projectId, id: workflowRunId, workflow: 'EFFECT', workflowSpace: 'EFFECT' },
    });
  }

  product(projectId: string, workflowRunId: string, productId: string) {
    return this.prisma.effectImportProduct.findFirst({
      where: { projectId, workflowRunId, id: productId, status: 'ACTIVE' },
    });
  }

  promptArtifact(projectId: string, workflowRunId: string, productId: string) {
    return this.prisma.workingArtifact.findFirst({
      where: {
        projectId,
        workflowRunId,
        nodeId: 'PROMPT_GENERATION',
        artifactKey: 'prompt-batch:' + productId,
      },
    });
  }

  renderArtifact(projectId: string, workflowRunId: string, productId: string) {
    return this.prisma.workingArtifact.findFirst({
      where: {
        projectId,
        workflowRunId,
        nodeId: 'SEGMENT_RENDER',
        artifactKey: 'render-batch:' + productId,
      },
    });
  }

  latestBatch(projectId: string, workflowRunId: string, productId: string) {
    return this.prisma.effectSegmentRenderBatch.findFirst({
      where: { projectId, workflowRunId, productId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: effectSegmentRenderBatchInclude,
    });
  }

  batch(projectId: string, batchId: string) {
    return this.prisma.effectSegmentRenderBatch.findFirst({
      where: { projectId, id: batchId },
      include: effectSegmentRenderBatchInclude,
    });
  }

  task(projectId: string, taskId: string) {
    return this.prisma.effectSegmentRenderTask.findFirst({ where: { projectId, id: taskId } });
  }

  async createBatch(
    projectId: string,
    workflowRunId: string,
    productId: string,
    input: CreateEffectSegmentRenderBatchInput,
  ) {
    try {
      return await this.prisma.$transaction(async (transaction) => {
        await transaction.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "effect_import_products"
          WHERE "projectId" = ${projectId}::uuid
            AND "workflowRunId" = ${workflowRunId}::uuid
            AND "id" = ${productId}::uuid
          FOR UPDATE
        `;
        const existing = await transaction.effectSegmentRenderBatch.findUnique({
          where: {
            projectId_idempotencyKey: { projectId, idempotencyKey: input.idempotencyKey },
          },
          include: effectSegmentRenderBatchInclude,
        });
        if (existing)
          return existing.requestHash === input.requestHash
            ? { kind: 'REPLAYED' as const, batch: existing }
            : { kind: 'KEY_CONFLICT' as const };
        const product = await transaction.effectImportProduct.findFirst({
          where: { projectId, workflowRunId, id: productId, status: 'ACTIVE' },
        });
        const workflow = await transaction.workflowRun.findFirst({
          where: {
            projectId,
            id: workflowRunId,
            workflow: 'EFFECT',
            workflowSpace: 'EFFECT',
            status: { in: ['ACTIVE', 'PAUSED'] },
          },
        });
        if (!product || !workflow) return { kind: 'NOT_FOUND' as const };
        const promptArtifact = await transaction.workingArtifact.findFirst({
          where: {
            projectId,
            workflowRunId,
            id: input.promptArtifact.id,
            nodeId: 'PROMPT_GENERATION',
            artifactKey: 'prompt-batch:' + productId,
            revision: input.promptArtifact.revision,
            contentHash: input.promptArtifact.contentHash,
            freshness: 'CURRENT',
            availability: 'AVAILABLE',
          },
        });
        if (!promptArtifact) return { kind: 'PROMPT_CONFLICT' as const };
        const active = await transaction.effectSegmentRenderBatch.findFirst({
          where: { projectId, workflowRunId, productId, activeKey: 'ACTIVE' },
        });
        if (active) return { kind: 'ACTIVE_CONFLICT' as const };
        await transaction.effectSegmentRenderBatch.create({
          data: {
            id: input.batchId,
            projectId,
            workflowRunId,
            productId,
            sourcePromptArtifactId: input.promptArtifact.id,
            sourcePromptRevision: input.promptArtifact.revision,
            sourcePromptHash: input.promptArtifact.contentHash,
            sourceFingerprint: input.sourceFingerprint,
            idempotencyKey: input.idempotencyKey,
            requestHash: input.requestHash,
          },
        });
        await transaction.effectSegmentRenderTask.createMany({
          data: input.tasks.map((task) => ({
            id: task.id,
            projectId,
            workflowRunId,
            productId,
            batchId: input.batchId,
            promptId: task.promptId,
            promptCode: task.promptCode,
            renderCode: task.renderCode,
            sourceFingerprint: task.sourceFingerprint,
            requestSnapshot: json(task.requestSnapshot),
            maxAutoRetries: EFFECT_SEGMENT_RENDER_LIMITS.maxAutoRetries,
          })),
        });
        await transaction.jobOutbox.createMany({
          data: input.tasks.map((task) => ({
            id: randomUUID(),
            projectId,
            jobType: EFFECT_SEGMENT_RENDER_JOB_TYPE,
            aggregateId: task.id,
            routingKey: EFFECT_SEGMENT_RENDER_QUEUE,
            payload: json({
              schemaVersion: 1,
              projectId,
              runId: task.id,
              requestId: randomUUID(),
            }),
          })),
        });
        const batch = await transaction.effectSegmentRenderBatch.findUniqueOrThrow({
          where: { projectId_id: { projectId, id: input.batchId } },
          include: effectSegmentRenderBatchInclude,
        });
        return { kind: 'CREATED' as const, batch };
      });
    } catch (error) {
      if (isUniqueConflict(error)) return { kind: 'ACTIVE_CONFLICT' as const };
      throw error;
    }
  }

  async regenerateTasks(
    projectId: string,
    batchId: string,
    taskIds: string[],
    expectedBatchRevision: number,
    idempotencyKey: string,
  ) {
    const requestHash = workflowStateHash({ batchId, taskIds: [...taskIds].sort() });
    try {
      return await this.prisma.$transaction(async (transaction) => {
        await transaction.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "effect_segment_render_batches"
          WHERE "projectId" = ${projectId}::uuid
            AND "id" = ${batchId}::uuid
          FOR UPDATE
        `;
        const receipt = await transaction.effectSegmentRenderOperationReceipt.findUnique({
          where: { projectId_idempotencyKey: { projectId, idempotencyKey } },
        });
        if (receipt)
          return receipt.requestHash === requestHash && receipt.batchId === batchId
            ? { kind: 'REPLAYED' as const }
            : { kind: 'KEY_CONFLICT' as const };
        const batch = await transaction.effectSegmentRenderBatch.findFirst({
          where: { projectId, id: batchId },
        });
        if (!batch) return { kind: 'NOT_FOUND' as const };
        if (batch.revision !== expectedBatchRevision) return { kind: 'REVISION_CONFLICT' as const };
        const latest = await transaction.effectSegmentRenderBatch.findFirst({
          where: { projectId, workflowRunId: batch.workflowRunId, productId: batch.productId },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        });
        if (latest?.id !== batch.id) return { kind: 'NOT_LATEST' as const };
        const prompt = await transaction.workingArtifact.findFirst({
          where: {
            projectId,
            workflowRunId: batch.workflowRunId,
            id: batch.sourcePromptArtifactId,
            nodeId: 'PROMPT_GENERATION',
            artifactKey: 'prompt-batch:' + batch.productId,
            revision: batch.sourcePromptRevision,
            contentHash: batch.sourcePromptHash,
            freshness: 'CURRENT',
            availability: 'AVAILABLE',
          },
        });
        if (!prompt) return { kind: 'PROMPT_CONFLICT' as const };
        const uniqueIds = [...new Set(taskIds)];
        const tasks = await transaction.effectSegmentRenderTask.findMany({
          where: { projectId, batchId, id: { in: uniqueIds } },
        });
        if (tasks.length !== uniqueIds.length) return { kind: 'TASK_NOT_FOUND' as const };
        if (tasks.some(({ status }) => status === 'QUEUED' || status === 'RUNNING'))
          return { kind: 'TASK_ACTIVE' as const };
        const otherActive = await transaction.effectSegmentRenderBatch.findFirst({
          where: {
            projectId,
            workflowRunId: batch.workflowRunId,
            productId: batch.productId,
            activeKey: 'ACTIVE',
            id: { not: batch.id },
          },
        });
        if (otherActive) return { kind: 'ACTIVE_CONFLICT' as const };
        await transaction.effectSegmentRenderOperationReceipt.create({
          data: { projectId, batchId, idempotencyKey, requestHash },
        });
        for (const task of tasks) {
          await transaction.effectSegmentRenderTask.update({
            where: { projectId_id: { projectId, id: task.id } },
            data: {
              status: 'QUEUED',
              progress: 0,
              renderVersion: { increment: 1 },
              retryCount: 0,
              attemptCount: 0,
              attemptToken: null,
              leaseExpiresAt: null,
              heartbeatAt: null,
              providerTaskId: null,
              errorCode: null,
              errorMessage: null,
              queuedAt: new Date(),
              startedAt: null,
              completedAt: null,
            },
          });
          await transaction.jobOutbox.upsert({
            where: {
              projectId_jobType_aggregateId: {
                projectId,
                jobType: EFFECT_SEGMENT_RENDER_JOB_TYPE,
                aggregateId: task.id,
              },
            },
            create: {
              projectId,
              jobType: EFFECT_SEGMENT_RENDER_JOB_TYPE,
              aggregateId: task.id,
              routingKey: EFFECT_SEGMENT_RENDER_QUEUE,
              payload: json({
                schemaVersion: 1,
                projectId,
                runId: task.id,
                requestId: randomUUID(),
              }),
            },
            update: {
              status: 'PENDING',
              dispatchToken: null,
              nextAttemptAt: new Date(),
              publishedAt: null,
              lastError: null,
              payload: json({
                schemaVersion: 1,
                projectId,
                runId: task.id,
                requestId: randomUUID(),
              }),
            },
          });
        }
        await transaction.effectSegmentRenderBatch.update({
          where: { projectId_id: { projectId, id: batchId } },
          data: { status: 'RUNNING', activeKey: 'ACTIVE', revision: { increment: 1 } },
        });
        return { kind: 'UPDATED' as const };
      });
    } catch (error) {
      if (isUniqueConflict(error)) return { kind: 'ACTIVE_CONFLICT' as const };
      throw error;
    }
  }

  async claim(projectId: string, taskId: string, now = new Date()) {
    const task = await this.prisma.effectSegmentRenderTask.findFirst({
      where: { projectId, id: taskId },
    });
    if (!task) return { kind: 'NOT_FOUND' as const };
    if (task.status === 'COMPLETED' || task.status === 'FAILED')
      return { kind: 'TERMINAL' as const, task };
    if (task.status === 'RUNNING' && task.leaseExpiresAt && task.leaseExpiresAt > now)
      return { kind: 'LEASE_CONFLICT' as const };
    if (task.attemptCount >= EFFECT_SEGMENT_RENDER_LIMITS.maxAttempts) {
      const exhausted = await this.prisma.effectSegmentRenderTask.updateMany({
        where: {
          projectId,
          id: taskId,
          renderVersion: task.renderVersion,
          attemptCount: { gte: EFFECT_SEGMENT_RENDER_LIMITS.maxAttempts },
          status: { in: ['QUEUED', 'RUNNING'] },
        },
        data: {
          status: 'FAILED',
          errorCode: 'ATTEMPTS_EXHAUSTED',
          errorMessage: '视频渲染重试次数已达上限',
          attemptToken: null,
          leaseExpiresAt: null,
          completedAt: now,
        },
      });
      if (exhausted.count !== 1) return { kind: 'LEASE_CONFLICT' as const };
      await this.prisma.effectSegmentRenderBatch.updateMany({
        where: { projectId, id: task.batchId },
        data: { revision: { increment: 1 } },
      });
      await this.settleBatch(projectId, task.batchId, now);
      return { kind: 'TERMINAL' as const, task: { ...task, status: 'FAILED' as const } };
    }
    const attemptToken = randomUUID();
    const updated = await this.prisma.effectSegmentRenderTask.updateMany({
      where: {
        projectId,
        id: taskId,
        renderVersion: task.renderVersion,
        OR: [{ status: 'QUEUED' }, { status: 'RUNNING', leaseExpiresAt: { lte: now } }],
      },
      data: {
        status: 'RUNNING',
        progress: Math.max(task.progress, 1),
        attemptCount: { increment: 1 },
        attemptToken,
        leaseExpiresAt: leaseDate(now),
        heartbeatAt: now,
        startedAt: task.startedAt ?? now,
        errorCode: null,
        errorMessage: null,
      },
    });
    if (updated.count !== 1) return { kind: 'LEASE_CONFLICT' as const };
    await this.prisma.effectSegmentRenderBatch.updateMany({
      where: { projectId, id: task.batchId },
      data: { status: 'RUNNING' },
    });
    const claimed = await this.task(projectId, taskId);
    if (!claimed) return { kind: 'NOT_FOUND' as const };
    return { kind: 'CLAIMED' as const, task: claimed };
  }

  heartbeat(
    projectId: string,
    taskId: string,
    attemptToken: string,
    taskVersion: number,
    progress: number,
    providerTaskId: string | undefined,
    now = new Date(),
  ) {
    return this.prisma.effectSegmentRenderTask.updateMany({
      where: {
        projectId,
        id: taskId,
        renderVersion: taskVersion,
        status: 'RUNNING',
        attemptToken,
        leaseExpiresAt: { gt: now },
      },
      data: {
        progress: Math.min(95, Math.max(1, Math.round(progress))),
        ...(providerTaskId ? { providerTaskId } : {}),
        heartbeatAt: now,
        leaseExpiresAt: leaseDate(now),
      },
    });
  }

  async complete(
    projectId: string,
    taskId: string,
    attemptToken: string,
    taskVersion: number,
    providerTaskId: string,
    file: EffectSegmentRenderStoredFile,
    now = new Date(),
  ) {
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "effect_segment_render_tasks"
        WHERE "projectId" = ${projectId}::uuid
          AND "id" = ${taskId}::uuid
        FOR UPDATE
      `;
      const task = await transaction.effectSegmentRenderTask.findFirst({
        where: { projectId, id: taskId },
      });
      if (!task) return { kind: 'NOT_FOUND' as const };
      if (task.status === 'COMPLETED' && task.renderVersion === taskVersion)
        return { kind: 'REPLAYED' as const, task };
      if (
        task.status !== 'RUNNING' ||
        task.renderVersion !== taskVersion ||
        task.attemptToken !== attemptToken ||
        !task.leaseExpiresAt ||
        task.leaseExpiresAt <= now
      )
        return { kind: 'LEASE_CONFLICT' as const };
      if (!this.workingRepository) throw new Error('WORKFLOW_WORKING_REPOSITORY_NOT_AVAILABLE');
      const fileObject = await this.workingRepository.upsertFileObjectInTransaction(
        transaction,
        projectId,
        task.workflowRunId,
        { ...file, nodeId: 'SEGMENT_RENDER' },
      );
      if (task.outputFileObjectId && task.outputFileObjectId !== fileObject.id)
        await transaction.fileObject.updateMany({
          where: { projectId, id: task.outputFileObjectId },
          data: { status: 'ORPHANED', orphanedAt: now },
        });
      const completed = await transaction.effectSegmentRenderTask.update({
        where: { projectId_id: { projectId, id: taskId } },
        data: {
          status: 'COMPLETED',
          progress: 100,
          providerTaskId,
          outputFileObjectId: fileObject.id,
          outputStorageKey: file.storageKey,
          outputFileName: file.originalFileName,
          outputMimeType: file.mimeType,
          outputSizeBytes: file.sizeBytes,
          outputContentHash: file.sha256,
          attemptToken: null,
          leaseExpiresAt: null,
          heartbeatAt: now,
          errorCode: null,
          errorMessage: null,
          completedAt: now,
        },
      });
      await transaction.effectSegmentRenderBatch.update({
        where: { projectId_id: { projectId, id: task.batchId } },
        data: { revision: { increment: 1 } },
      });
      await this.settleBatchInTransaction(transaction, projectId, task.batchId, now);
      return { kind: 'COMPLETED' as const, task: completed };
    });
  }

  async fail(
    projectId: string,
    taskId: string,
    attemptToken: string,
    taskVersion: number,
    input: { errorCode: string; errorMessage: string; retryable: boolean },
    now = new Date(),
  ) {
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "effect_segment_render_tasks"
        WHERE "projectId" = ${projectId}::uuid
          AND "id" = ${taskId}::uuid
        FOR UPDATE
      `;
      const task = await transaction.effectSegmentRenderTask.findFirst({
        where: { projectId, id: taskId },
      });
      if (!task) return 'NOT_FOUND' as const;
      if (
        task.status !== 'RUNNING' ||
        task.renderVersion !== taskVersion ||
        task.attemptToken !== attemptToken ||
        !task.leaseExpiresAt ||
        task.leaseExpiresAt <= now
      )
        return 'LEASE_CONFLICT' as const;
      const retry =
        input.retryable &&
        task.retryCount < task.maxAutoRetries &&
        task.attemptCount < EFFECT_SEGMENT_RENDER_LIMITS.maxAttempts;
      await transaction.effectSegmentRenderTask.update({
        where: { projectId_id: { projectId, id: taskId } },
        data: {
          status: retry ? 'QUEUED' : 'FAILED',
          progress: retry ? Math.max(1, Math.min(task.progress, 90)) : task.progress,
          ...(retry ? { retryCount: { increment: 1 } } : {}),
          attemptToken: null,
          leaseExpiresAt: null,
          heartbeatAt: now,
          errorCode: input.errorCode,
          errorMessage: input.errorMessage,
          completedAt: retry ? null : now,
        },
      });
      await transaction.effectSegmentRenderBatch.update({
        where: { projectId_id: { projectId, id: task.batchId } },
        data: { revision: { increment: 1 } },
      });
      if (retry)
        await transaction.jobOutbox.updateMany({
          where: { projectId, jobType: EFFECT_SEGMENT_RENDER_JOB_TYPE, aggregateId: taskId },
          data: {
            status: 'PENDING',
            dispatchToken: null,
            nextAttemptAt: now,
            publishedAt: null,
            lastError: null,
          },
        });
      else await this.settleBatchInTransaction(transaction, projectId, task.batchId, now);
      return retry ? ('REQUEUED' as const) : ('FAILED' as const);
    });
  }

  async recoverExpiredLeases(now = new Date()): Promise<{ requeued: number; failed: number }> {
    const candidates = await this.prisma.effectSegmentRenderTask.findMany({
      where: { status: 'RUNNING', leaseExpiresAt: { lte: now } },
      select: {
        id: true,
        projectId: true,
        batchId: true,
        retryCount: true,
        maxAutoRetries: true,
        attemptCount: true,
      },
      orderBy: { leaseExpiresAt: 'asc' },
      take: 50,
    });
    let requeued = 0;
    let failed = 0;
    for (const task of candidates) {
      const retry =
        task.retryCount < task.maxAutoRetries &&
        task.attemptCount < EFFECT_SEGMENT_RENDER_LIMITS.maxAttempts;
      const updated = await this.prisma.effectSegmentRenderTask.updateMany({
        where: {
          projectId: task.projectId,
          id: task.id,
          status: 'RUNNING',
          leaseExpiresAt: { lte: now },
        },
        data: {
          status: retry ? 'QUEUED' : 'FAILED',
          ...(retry ? { retryCount: { increment: 1 } } : {}),
          attemptToken: null,
          leaseExpiresAt: null,
          errorCode: 'WORKER_LEASE_EXPIRED',
          errorMessage: retry
            ? '视频渲染 Worker 连接中断，任务已重新排队'
            : '视频渲染 Worker 多次失联，任务已终止',
          completedAt: retry ? null : now,
        },
      });
      if (updated.count !== 1) continue;
      await this.prisma.effectSegmentRenderBatch.updateMany({
        where: { projectId: task.projectId, id: task.batchId },
        data: { revision: { increment: 1 } },
      });
      if (retry) {
        requeued += 1;
        await this.prisma.jobOutbox.updateMany({
          where: {
            projectId: task.projectId,
            jobType: EFFECT_SEGMENT_RENDER_JOB_TYPE,
            aggregateId: task.id,
          },
          data: {
            status: 'PENDING',
            dispatchToken: null,
            nextAttemptAt: now,
            publishedAt: null,
            lastError: null,
          },
        });
      } else {
        failed += 1;
        await this.settleBatch(task.projectId, task.batchId, now);
      }
    }
    return { requeued, failed };
  }

  async recoverStaleQueuedDispatches(now = new Date()): Promise<number> {
    const staleBefore = new Date(now.getTime() - 60_000);
    const tasks = await this.prisma.effectSegmentRenderTask.findMany({
      where: { status: 'QUEUED', updatedAt: { lte: staleBefore } },
      select: { id: true, projectId: true },
      take: 50,
      orderBy: { updatedAt: 'asc' },
    });
    let recovered = 0;
    for (const task of tasks) {
      const result = await this.prisma.jobOutbox.updateMany({
        where: {
          projectId: task.projectId,
          jobType: EFFECT_SEGMENT_RENDER_JOB_TYPE,
          aggregateId: task.id,
          status: 'PUBLISHED',
        },
        data: {
          status: 'PENDING',
          dispatchToken: null,
          nextAttemptAt: now,
          publishedAt: null,
          lastError: null,
        },
      });
      recovered += result.count;
    }
    return recovered;
  }

  private async settleBatch(projectId: string, batchId: string, now: Date): Promise<void> {
    await this.prisma.$transaction((transaction) =>
      this.settleBatchInTransaction(transaction, projectId, batchId, now),
    );
  }

  private async settleBatchInTransaction(
    transaction: Prisma.TransactionClient,
    projectId: string,
    batchId: string,
    now: Date,
  ): Promise<void> {
    const grouped = await transaction.effectSegmentRenderTask.groupBy({
      by: ['status'],
      where: { projectId, batchId },
      _count: { _all: true },
    });
    const count = (status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED'): number =>
      grouped.find((item) => item.status === status)?._count._all ?? 0;
    if (count('QUEUED') + count('RUNNING') > 0) return;
    const completed = count('COMPLETED');
    const failed = count('FAILED');
    await transaction.effectSegmentRenderBatch.updateMany({
      where: { projectId, id: batchId },
      data: {
        status: failed === 0 ? 'COMPLETED' : completed === 0 ? 'FAILED' : 'PARTIAL',
        activeKey: null,
        updatedAt: now,
      },
    });
  }

  async commitValidatedBatch(
    projectId: string,
    batchId: string,
    expectedRevision: number,
    artifacts: Array<{ artifactKey: string; input: WorkingArtifactUpsertInput }>,
  ) {
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "effect_segment_render_batches"
        WHERE "projectId" = ${projectId}::uuid
          AND "id" = ${batchId}::uuid
        FOR UPDATE
      `;
      const batch = await transaction.effectSegmentRenderBatch.findFirst({
        where: { projectId, id: batchId },
        include: { tasks: true },
      });
      if (!batch) return { kind: 'NOT_FOUND' as const };
      if (batch.revision !== expectedRevision) return { kind: 'REVISION_CONFLICT' as const };
      if (batch.tasks.some(({ status }) => status === 'QUEUED' || status === 'RUNNING'))
        return { kind: 'NOT_READY' as const };
      const prompt = await transaction.workingArtifact.findFirst({
        where: {
          projectId,
          workflowRunId: batch.workflowRunId,
          id: batch.sourcePromptArtifactId,
          nodeId: 'PROMPT_GENERATION',
          artifactKey: 'prompt-batch:' + batch.productId,
          revision: batch.sourcePromptRevision,
          contentHash: batch.sourcePromptHash,
          freshness: 'CURRENT',
          availability: 'AVAILABLE',
        },
      });
      if (!prompt) return { kind: 'PROMPT_CONFLICT' as const };
      if (!this.workingRepository) throw new Error('WORKFLOW_WORKING_REPOSITORY_NOT_AVAILABLE');
      const committed = await this.workingRepository.commitValidatedArtifactsInTransaction(
        transaction,
        projectId,
        batch.workflowRunId,
        'SEGMENT_RENDER',
        artifacts,
      );
      await transaction.effectSegmentRenderBatch.update({
        where: { projectId_id: { projectId, id: batchId } },
        data: { committedAt: new Date() },
      });
      return {
        kind: 'COMMITTED' as const,
        artifacts: committed.map((item) => ({
          artifactId: item.record.id,
          artifactKey: item.artifactKey,
          revision: item.record.revision,
          unchanged: item.unchanged,
        })),
      };
    });
  }
}
