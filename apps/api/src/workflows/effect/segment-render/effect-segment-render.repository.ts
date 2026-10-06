import { randomUUID } from 'node:crypto';

import {
  EFFECT_SEGMENT_RENDER_JOB_TYPE,
  EFFECT_SEGMENT_RENDER_LIMITS,
  EFFECT_SEGMENT_RENDER_QUEUE,
} from '@ai-marketing/contracts';
import type {
  EffectSegmentRenderInputImage,
  EffectSegmentRenderRepairDecision,
  EffectSegmentRenderRepairInput,
  EffectSegmentRenderRequestSnapshot,
} from '@ai-marketing/contracts';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import {
  type WorkingArtifactUpsertInput,
  WorkflowWorkingRepository,
} from '../../../platform/workflow/workflow-working.repository';
import { workflowStateHash } from '../../../platform/workflow/workflow-state-hash';
import { exitEffectEditInTransaction } from '../../../platform/workflow/effect-edit-session';
import type {
  EffectSegmentRenderImportedFile,
  EffectSegmentRenderStoredFile,
  EffectSegmentRenderTaskCreateInput,
} from './effect-segment-render.types';

const json = (value: unknown): Prisma.InputJsonValue => value as Prisma.InputJsonValue;
const posterFileObjectId = (value: Prisma.JsonValue | null): string | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const fileObjectId = (value as Prisma.JsonObject).fileObjectId;
  return typeof fileObjectId === 'string' ? fileObjectId : null;
};
const posterMetadata = (
  file: EffectSegmentRenderStoredFile,
  version: number,
): Prisma.InputJsonValue =>
  json({
    fileObjectId: file.id,
    originalFileName: file.originalFileName,
    mimeType: file.mimeType,
    sizeBytes: file.sizeBytes,
    contentHash: file.sha256,
    version,
  });
const leaseDate = (now: Date): Date => new Date(now.getTime() + 90_000);
const isUniqueConflict = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
// The validate commit writes every clip artifact plus the batch artifact — a hundred rows across four
// tables — and takes a row lock on the batch first, so any concurrent writer can park it in lock waiting.
// Prisma's 5s default budget aborts the transaction then, and that abort used to surface as a bare 500
// "服务器内部错误", which told the user nothing about retrying. Give the commit a budget that fits its
// size, retry a transient clash once, and let the caller report whatever is left as a conflict.
const COMMIT_TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 120_000 };
const COMMIT_TRANSACTION_ATTEMPTS = 2;
const COMMIT_TRANSACTION_RETRY_DELAY_MS = 200;
const BRANCH_PUBLICATION_CONFLICT = 'EFFECT_RENDER_BRANCH_PUBLICATION_CONFLICT';
const isTransientTransactionError = (error: unknown): boolean => {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const { code } = error as { code?: unknown };
    if (code === 'P2028' || code === 'P2034') return true;
  }
  const message = error instanceof Error ? error.message : '';
  return /deadlock|could not serialize|Transaction already closed|Transaction API error/i.test(
    message,
  );
};

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
  sourcePackage: { id: string; revision: number; contentHash: string };
  inputImages: EffectSegmentRenderInputImage[];
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

  private async inputConflict(
    transaction: Prisma.TransactionClient,
    projectId: string,
    batch: {
      workflowRunId: string;
      productId: string;
      sourcePromptArtifactId: string;
      sourcePromptRevision: number;
      sourcePromptHash: string;
    },
    requestSnapshot: Prisma.JsonValue | undefined,
  ): Promise<'PROMPT' | 'SOURCE' | null> {
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
    if (!prompt) return 'PROMPT';
    const snapshot = requestSnapshot as
      | { sourcePackage?: { artifactId?: string; revision?: number; contentHash?: string } }
      | undefined;
    const source = snapshot?.sourcePackage;
    if (
      !source?.artifactId ||
      !source.revision ||
      !source.contentHash ||
      !(await transaction.workingArtifact.findFirst({
        where: {
          projectId,
          workflowRunId: batch.workflowRunId,
          id: source.artifactId,
          nodeId: 'SOURCE_IMPORT',
          artifactKey: 'source-package:' + batch.productId,
          revision: source.revision,
          contentHash: source.contentHash,
          freshness: 'CURRENT',
          availability: 'AVAILABLE',
        },
      }))
    )
      return 'SOURCE';
    return null;
  }

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

  marketingInsightArtifact(projectId: string, workflowRunId: string, productId: string) {
    return this.prisma.workingArtifact.findFirst({
      where: {
        projectId,
        workflowRunId,
        nodeId: 'INFORMATION_EXTRACTION',
        artifactKey: 'marketing-insight:' + productId,
        availability: 'AVAILABLE',
      },
    });
  }

  sourcePackageArtifact(projectId: string, workflowRunId: string, productId: string) {
    return this.prisma.workingArtifact.findFirst({
      where: {
        projectId,
        workflowRunId,
        nodeId: 'SOURCE_IMPORT',
        artifactKey: 'source-package:' + productId,
      },
      include: {
        files: {
          orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
          include: { fileObject: true },
        },
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
      where: { projectId, workflowRunId, productId, archivedAt: null },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: effectSegmentRenderBatchInclude,
    });
  }

  batch(projectId: string, batchId: string) {
    return this.prisma.effectSegmentRenderBatch.findFirst({
      where: { projectId, id: batchId, archivedAt: null },
      include: effectSegmentRenderBatchInclude,
    });
  }

  task(projectId: string, taskId: string) {
    return this.prisma.effectSegmentRenderTask.findFirst({
      where: { projectId, id: taskId, batch: { archivedAt: null } },
    });
  }

  taskById(taskId: string) {
    return this.prisma.effectSegmentRenderTask.findUnique({ where: { id: taskId } });
  }

  async fileObject(projectId: string, workflowRunId: string, fileObjectId: string) {
    const file = await this.prisma.fileObject.findFirst({
      where: { projectId, id: fileObjectId, status: 'AVAILABLE' },
    });
    if (!file) return null;
    let runId: string | null = workflowRunId;
    const visited = new Set<string>();
    while (runId && !visited.has(runId)) {
      visited.add(runId);
      if (file.workflowRunId === runId) return file;
      const run: { parentWorkflowRunId: string | null } | null =
        await this.prisma.workflowRun.findFirst({
          where: { projectId, id: runId, workflow: 'EFFECT', workflowSpace: 'EFFECT' },
          select: { parentWorkflowRunId: true },
        });
      runId = run?.parentWorkflowRunId ?? null;
    }
    return null;
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
        if (existing?.archivedAt) return { kind: 'KEY_CONFLICT' as const };
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
        const sourcePackage = await transaction.workingArtifact.findFirst({
          where: {
            projectId,
            workflowRunId,
            id: input.sourcePackage.id,
            nodeId: 'SOURCE_IMPORT',
            artifactKey: 'source-package:' + productId,
            revision: input.sourcePackage.revision,
            contentHash: input.sourcePackage.contentHash,
            freshness: 'CURRENT',
            availability: 'AVAILABLE',
          },
          include: {
            files: {
              where: { role: 'PRODUCT_IMAGE', fileObject: { status: 'AVAILABLE' } },
              orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
              include: { fileObject: true },
            },
          },
        });
        if (!sourcePackage) return { kind: 'SOURCE_CONFLICT' as const };
        const currentImages = sourcePackage.files.map(({ fileObject, sortOrder }) => ({
          fileObjectId: fileObject.id,
          originalFileName: fileObject.originalFileName,
          mimeType: fileObject.mimeType.toLocaleLowerCase('en-US'),
          sizeBytes: fileObject.sizeBytes,
          contentHash: fileObject.sha256,
          sortOrder,
        }));
        if (
          currentImages.length !== input.inputImages.length ||
          currentImages.some(
            (image, index) => JSON.stringify(image) !== JSON.stringify(input.inputImages[index]),
          )
        )
          return { kind: 'SOURCE_CONFLICT' as const };
        const active = await transaction.effectSegmentRenderBatch.findFirst({
          where: { projectId, workflowRunId, productId, activeKey: 'ACTIVE', archivedAt: null },
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
            generationRequestSnapshot: json(task.requestSnapshot),
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

  async operationReceipt(projectId: string, idempotencyKey: string) {
    return this.prisma.effectSegmentRenderOperationReceipt.findUnique({
      where: { projectId_idempotencyKey: { projectId, idempotencyKey } },
    });
  }

  async regenerateTasks(
    projectId: string,
    batchId: string,
    taskIds: string[],
    expectedBatchRevision: number,
    idempotencyKey: string,
    input: {
      sourcePrompt: { artifactId: string; revision: number; contentHash: string };
      taskSnapshots: Record<string, EffectSegmentRenderRequestSnapshot>;
      addedTasks?: EffectSegmentRenderTaskCreateInput[];
      refreshRequestHash?: string;
    },
  ) {
    const requestHash =
      input.refreshRequestHash ??
      workflowStateHash({
        batchId,
        taskIds: [...taskIds].sort(),
        sourcePrompt: input.sourcePrompt,
        taskSnapshots: Object.fromEntries(
          Object.entries(input.taskSnapshots).sort(([left], [right]) => left.localeCompare(right)),
        ),
        ...(input.addedTasks?.length ? { addedTasks: input.addedTasks } : {}),
      });
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
            id: input.sourcePrompt.artifactId,
            nodeId: 'PROMPT_GENERATION',
            artifactKey: 'prompt-batch:' + batch.productId,
            revision: input.sourcePrompt.revision,
            contentHash: input.sourcePrompt.contentHash,
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
        if (
          Object.keys(input.taskSnapshots).length !== uniqueIds.length ||
          tasks.some((task) => {
            const snapshot = input.taskSnapshots[task.id];
            return !snapshot || snapshot.promptId !== task.promptId;
          })
        )
          return { kind: 'PROMPT_CONFLICT' as const };
        const addedTasks = input.addedTasks ?? [];
        const existingTasks = await transaction.effectSegmentRenderTask.findMany({
          where: { projectId, batchId },
        });
        if (existingTasks.some(({ status }) => status === 'QUEUED' || status === 'RUNNING'))
          return { kind: 'TASK_ACTIVE' as const };
        if (
          existingTasks.length + addedTasks.length >
          EFFECT_SEGMENT_RENDER_LIMITS.maxTasksPerBatch
        )
          return { kind: 'PROMPT_CONFLICT' as const };
        const promptIds = new Set(existingTasks.map(({ promptId }) => promptId));
        for (const task of addedTasks) {
          if (promptIds.has(task.promptId) || task.requestSnapshot.promptId !== task.promptId)
            return { kind: 'PROMPT_CONFLICT' as const };
          promptIds.add(task.promptId);
        }
        const sourceSnapshot = tasks[0]
          ? input.taskSnapshots[tasks[0].id]
          : addedTasks[0]?.requestSnapshot;
        const sourcePackage = sourceSnapshot?.sourcePackage;
        if (
          !sourcePackage?.artifactId ||
          !sourcePackage.revision ||
          !sourcePackage.contentHash ||
          !(await transaction.workingArtifact.findFirst({
            where: {
              projectId,
              workflowRunId: batch.workflowRunId,
              id: sourcePackage.artifactId,
              nodeId: 'SOURCE_IMPORT',
              artifactKey: 'source-package:' + batch.productId,
              revision: sourcePackage.revision,
              contentHash: sourcePackage.contentHash,
              freshness: 'CURRENT',
              availability: 'AVAILABLE',
            },
          }))
        )
          return { kind: 'SOURCE_CONFLICT' as const };
        if (tasks.some(({ status }) => status === 'QUEUED' || status === 'RUNNING'))
          return { kind: 'TASK_ACTIVE' as const };
        if (tasks.some(({ repairStatus }) => repairStatus !== null))
          return { kind: 'TASK_REPAIR_PENDING' as const };
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
        if (addedTasks.length) {
          await transaction.effectSegmentRenderTask.createMany({
            data: addedTasks.map((task) => ({
              ...task,
              projectId,
              workflowRunId: batch.workflowRunId,
              productId: batch.productId,
              batchId,
              requestSnapshot: json(task.requestSnapshot),
              generationRequestSnapshot: json(task.requestSnapshot),
              maxAutoRetries: EFFECT_SEGMENT_RENDER_LIMITS.maxAutoRetries,
            })),
          });
          await transaction.jobOutbox.createMany({
            data: addedTasks.map((task) => ({
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
        }
        for (const task of tasks) {
          const snapshot = input.taskSnapshots[task.id]!;
          await transaction.effectSegmentRenderTask.update({
            where: { projectId_id: { projectId, id: task.id } },
            data: {
              status: 'QUEUED',
              operationKind: 'GENERATE',
              requestSnapshot: json(snapshot),
              generationRequestSnapshot: json(snapshot),
              sourceFingerprint: workflowStateHash(snapshot),
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
          data: {
            status: 'RUNNING',
            activeKey: 'ACTIVE',
            sourcePromptArtifactId: input.sourcePrompt.artifactId,
            sourcePromptRevision: input.sourcePrompt.revision,
            sourcePromptHash: input.sourcePrompt.contentHash,
            revision: { increment: 1 },
          },
        });
        return { kind: 'UPDATED' as const };
      });
    } catch (error) {
      if (isUniqueConflict(error)) return { kind: 'ACTIVE_CONFLICT' as const };
      throw error;
    }
  }

  async importMaterials(
    projectId: string,
    batchId: string,
    imports: EffectSegmentRenderImportedFile[],
    expectedBatchRevision: number,
    idempotencyKey: string,
  ) {
    const requestHash = workflowStateHash({
      batchId,
      imports: imports
        .map(({ taskId, file }) => ({ taskId, sha256: file.sha256, sizeBytes: file.sizeBytes }))
        .sort((left, right) => left.taskId.localeCompare(right.taskId)),
    });
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "effect_segment_render_batches"
        WHERE "projectId" = ${projectId}::uuid AND "id" = ${batchId}::uuid
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
      if (batch.status === 'QUEUED' || batch.status === 'RUNNING')
        return { kind: 'BATCH_ACTIVE' as const };
      const latest = await transaction.effectSegmentRenderBatch.findFirst({
        where: { projectId, workflowRunId: batch.workflowRunId, productId: batch.productId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      if (latest?.id !== batch.id) return { kind: 'NOT_LATEST' as const };
      const uniqueTaskIds = [...new Set(imports.map(({ taskId }) => taskId))];
      if (uniqueTaskIds.length !== imports.length) return { kind: 'TASK_CONFLICT' as const };
      const tasks = await transaction.effectSegmentRenderTask.findMany({
        where: { projectId, batchId, id: { in: uniqueTaskIds } },
      });
      if (tasks.length !== uniqueTaskIds.length) return { kind: 'TASK_NOT_FOUND' as const };
      const inputConflict = await this.inputConflict(
        transaction,
        projectId,
        batch,
        tasks[0]?.requestSnapshot,
      );
      if (inputConflict === 'PROMPT') return { kind: 'PROMPT_CONFLICT' as const };
      if (inputConflict === 'SOURCE') return { kind: 'SOURCE_CONFLICT' as const };
      if (tasks.some(({ repairStatus }) => repairStatus !== null))
        return { kind: 'TASK_REPAIR_PENDING' as const };
      if (!this.workingRepository) throw new Error('WORKFLOW_WORKING_REPOSITORY_NOT_AVAILABLE');
      await transaction.effectSegmentRenderOperationReceipt.create({
        data: { projectId, batchId, idempotencyKey, requestHash },
      });
      const taskById = new Map(tasks.map((task) => [task.id, task]));
      for (const imported of imports) {
        const task = taskById.get(imported.taskId)!;
        const fileObject = await this.workingRepository.upsertFileObjectInTransaction(
          transaction,
          projectId,
          batch.workflowRunId,
          { ...imported.file, nodeId: 'SEGMENT_RENDER' },
        );
        // A published parent branch may still reference the replaced file object.
        // Keep old media available for version history; branch garbage collection
        // owns eventual reclamation after all references have disappeared.
        const version = task.renderVersion + 1;
        await transaction.effectSegmentRenderTask.update({
          where: { projectId_id: { projectId, id: task.id } },
          data: {
            status: 'COMPLETED',
            operationKind: 'GENERATE',
            progress: 100,
            renderVersion: version,
            activeOutputVersion: version,
            retryCount: 0,
            attemptCount: 0,
            attemptToken: null,
            leaseExpiresAt: null,
            heartbeatAt: null,
            providerTaskId: null,
            outputFileObjectId: fileObject.id,
            outputStorageKey: imported.file.storageKey,
            outputFileName: imported.file.originalFileName,
            outputMimeType: imported.file.mimeType,
            outputSizeBytes: imported.file.sizeBytes,
            outputContentHash: imported.file.sha256,
            outputPoster: Prisma.DbNull,
            repairStatus: null,
            repairSourceVersion: null,
            repairStartMs: null,
            repairEndMs: null,
            repairInstruction: null,
            repairRegion: Prisma.DbNull,
            repairCandidateFileObjectId: null,
            repairCandidateStorageKey: null,
            repairCandidateFileName: null,
            repairCandidateMimeType: null,
            repairCandidateSizeBytes: null,
            repairCandidateContentHash: null,
            repairCandidatePoster: Prisma.DbNull,
            repairCandidateVersion: null,
            repairCandidateCreatedAt: null,
            errorCode: null,
            errorMessage: null,
            startedAt: null,
            completedAt: new Date(),
          },
        });
      }
      await transaction.effectSegmentRenderBatch.update({
        where: { projectId_id: { projectId, id: batchId } },
        data: { revision: { increment: 1 }, committedAt: null },
      });
      await this.settleBatchInTransaction(transaction, projectId, batchId, new Date());
      return { kind: 'UPDATED' as const };
    });
  }

  async appendImportedMaterials(
    projectId: string,
    batchId: string,
    items: Array<{ draftId: string; promptText: string }>,
    expectedBatchRevision: number,
    idempotencyKey: string,
  ) {
    const requestHash = workflowStateHash({ batchId, items });
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw`SELECT "id" FROM "projects" WHERE "id" = ${projectId}::uuid FOR UPDATE`;
      await transaction.$queryRaw`SELECT "id" FROM "effect_segment_render_batches"
        WHERE "projectId" = ${projectId}::uuid AND "id" = ${batchId}::uuid FOR UPDATE`;
      const receipt = await transaction.effectSegmentRenderOperationReceipt.findUnique({
        where: {
          projectId_idempotencyKey: { projectId, idempotencyKey },
        },
      });
      if (receipt)
        return receipt.batchId === batchId && receipt.requestHash === requestHash
          ? ('REPLAYED' as const)
          : ('KEY_CONFLICT' as const);
      const batch = await transaction.effectSegmentRenderBatch.findFirst({
        where: { projectId, id: batchId },
        include: { tasks: true },
      });
      if (!batch) return 'NOT_FOUND' as const;
      if (batch.revision !== expectedBatchRevision) return 'REVISION_CONFLICT' as const;
      const latest = await transaction.effectSegmentRenderBatch.findFirst({
        where: {
          projectId,
          workflowRunId: batch.workflowRunId,
          productId: batch.productId,
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      if (latest?.id !== batchId || ['RUNNING', 'QUEUED'].includes(batch.status))
        return 'BATCH_ACTIVE' as const;
      const conflict = await this.inputConflict(
        transaction,
        projectId,
        batch,
        batch.tasks[0]?.requestSnapshot,
      );
      if (conflict) return 'SOURCE_CONFLICT' as const;
      // Keep the editor authority inside the same transaction as confirmation.
      const run = await transaction.workflowRun.findFirst({
        where: { projectId, id: batch.workflowRunId },
      });
      if (
        !run ||
        run.status !== 'ACTIVE' ||
        (run.parentWorkflowRunId &&
          !run.branchPublishedAt &&
          run.editSessionNodeId !== 'SEGMENT_RENDER')
      )
        return 'EDIT_CONFLICT' as const;
      if (
        (!run.parentWorkflowRunId || run.branchPublishedAt) &&
        (await transaction.workingArtifact.findFirst({
          where: {
            projectId,
            workflowRunId: run.id,
            nodeId: 'SEGMENT_RENDER',
            artifactKey: { startsWith: 'render-batch:' },
            availability: 'AVAILABLE',
          },
        }))
      )
        return 'EDIT_CONFLICT' as const;
      const drafts = [];
      for (const item of items) {
        await transaction.$queryRaw`SELECT "id" FROM "effect_segment_import_drafts"
          WHERE "projectId" = ${projectId}::uuid AND "id" = ${item.draftId}::uuid FOR UPDATE`;
        const draft = await transaction.effectSegmentImportDraft.findFirst({
          where: {
            projectId,
            batchId,
            workflowRunId: batch.workflowRunId,
            id: item.draftId,
            status: 'READY',
            expiresAt: { gt: new Date() },
          },
        });
        if (!draft || ['RUNNING', 'QUEUED'].includes(draft.descriptionStatus))
          return 'DRAFT_CONFLICT' as const;
        drafts.push({ draft, promptText: item.promptText });
      }
      if (!this.workingRepository || !batch.tasks[0])
        throw new Error('IMPORT_SOURCE_CONTEXT_MISSING');
      const base = batch.tasks[0]
        .generationRequestSnapshot as unknown as EffectSegmentRenderRequestSnapshot;
      const promptDurationMaxSeconds = Math.max(
        4,
        ...batch.tasks.map((task) => {
          const snapshot =
            task.generationRequestSnapshot as unknown as EffectSegmentRenderRequestSnapshot;
          return snapshot.importedMaterial
            ? (snapshot.importedMaterial.promptDurationMaxSeconds ?? 4)
            : snapshot.request.duration;
        }),
      );
      let codeIndex = Math.max(
        0,
        ...batch.tasks.map((task) => Number(task.renderCode.replace(/^R-/u, '')) || 0),
      );
      for (const { draft, promptText } of drafts) {
        const id = randomUUID();
        const snapshot: EffectSegmentRenderRequestSnapshot = {
          ...base,
          operation: 'GENERATE',
          promptId: draft.id,
          promptCode: `I-${++codeIndex}`,
          promptText,
          primaryPurpose: 'PRODUCT_DISPLAY',
          compatiblePurposes: [],
          promptContentHash: workflowStateHash(promptText),
          inputImages: [],
          inputVideo: null,
          repair: null,
          importedMaterial: {
            schemaVersion: 1,
            width: draft.width,
            height: draft.height,
            promptDurationMaxSeconds,
          },
          request: {
            ...base.request,
            content: [{ type: 'text', text: promptText }],
            duration: draft.durationSeconds,
          },
        };
        const file = await this.workingRepository.upsertFileObjectInTransaction(
          transaction,
          projectId,
          batch.workflowRunId,
          {
            id: randomUUID(),
            originalFileName: draft.fileName,
            mimeType: draft.mimeType,
            sizeBytes: draft.sizeBytes,
            storageKey: draft.storageKey,
            sha256: draft.sha256,
            nodeId: 'SEGMENT_RENDER',
          },
        );
        await transaction.effectSegmentRenderTask.create({
          data: {
            id,
            projectId,
            workflowRunId: batch.workflowRunId,
            productId: batch.productId,
            batchId,
            promptId: draft.id,
            promptCode: snapshot.promptCode,
            renderCode: `R-${String(codeIndex).padStart(3, '0')}`,
            sourceFingerprint: workflowStateHash({ promptText, sha256: draft.sha256 }),
            requestSnapshot: json(snapshot),
            generationRequestSnapshot: json(snapshot),
            status: 'COMPLETED',
            progress: 100,
            activeOutputVersion: 1,
            maxAutoRetries: 0,
            outputFileObjectId: file.id,
            outputStorageKey: draft.storageKey,
            outputFileName: draft.fileName,
            outputMimeType: draft.mimeType,
            outputSizeBytes: draft.sizeBytes,
            outputContentHash: draft.sha256,
            completedAt: new Date(),
          },
        });
        await transaction.effectSegmentImportDraft.update({
          where: { id: draft.id },
          data: {
            status: 'IMPORTED',
            promptText,
            importedTaskId: id,
          },
        });
      }
      await transaction.effectSegmentRenderOperationReceipt.create({
        data: { projectId, batchId, idempotencyKey, requestHash },
      });
      await transaction.effectSegmentRenderBatch.update({
        where: { id: batchId },
        data: {
          revision: { increment: 1 },
          committedAt: null,
        },
      });
      await this.settleBatchInTransaction(transaction, projectId, batchId, new Date());
      return 'UPDATED' as const;
    });
  }

  async deleteMaterials(
    projectId: string,
    batchId: string,
    taskIds: string[],
    expectedBatchRevision: number,
    idempotencyKey: string,
  ) {
    const uniqueTaskIds = [...new Set(taskIds)].sort();
    const requestHash = workflowStateHash({ batchId, taskIds: uniqueTaskIds });
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "effect_segment_render_batches"
        WHERE "projectId" = ${projectId}::uuid AND "id" = ${batchId}::uuid
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
      if (batch.status === 'QUEUED' || batch.status === 'RUNNING')
        return { kind: 'BATCH_ACTIVE' as const };
      const latest = await transaction.effectSegmentRenderBatch.findFirst({
        where: { projectId, workflowRunId: batch.workflowRunId, productId: batch.productId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      if (latest?.id !== batch.id) return { kind: 'NOT_LATEST' as const };
      const tasks = await transaction.effectSegmentRenderTask.findMany({
        where: { projectId, batchId, id: { in: uniqueTaskIds } },
      });
      if (tasks.length !== uniqueTaskIds.length) return { kind: 'TASK_NOT_FOUND' as const };
      const inputConflict = await this.inputConflict(
        transaction,
        projectId,
        batch,
        tasks[0]?.requestSnapshot,
      );
      if (inputConflict === 'PROMPT') return { kind: 'PROMPT_CONFLICT' as const };
      if (inputConflict === 'SOURCE') return { kind: 'SOURCE_CONFLICT' as const };
      if (
        tasks.some(
          ({ status, outputFileObjectId }) => status !== 'COMPLETED' || !outputFileObjectId,
        )
      )
        return { kind: 'TASK_CONFLICT' as const };
      if (tasks.some(({ repairStatus }) => repairStatus !== null))
        return { kind: 'TASK_REPAIR_PENDING' as const };
      await transaction.effectSegmentRenderOperationReceipt.create({
        data: { projectId, batchId, idempotencyKey, requestHash },
      });
      // Deleting a clip from this draft must not revoke media referenced by a
      // published parent or sibling branch.
      const independentIds = tasks
        .filter(
          (task) =>
            (
              (task.generationRequestSnapshot ??
                task.requestSnapshot) as unknown as EffectSegmentRenderRequestSnapshot
            )?.importedMaterial,
        )
        .map((task) => task.id);
      // Independent imports have no Prompt task to regenerate. Remove only their draft rows,
      // while preserving FileObjects and confirmed parent/sibling media references.
      if (independentIds.length)
        await transaction.effectSegmentRenderTask.deleteMany({
          where: { projectId, batchId, id: { in: independentIds } },
        });
      await transaction.effectSegmentRenderTask.updateMany({
        where: {
          projectId,
          batchId,
          id: { in: uniqueTaskIds.filter((id) => !independentIds.includes(id)) },
        },
        data: {
          status: 'FAILED',
          progress: 0,
          providerTaskId: null,
          outputFileObjectId: null,
          outputStorageKey: null,
          outputFileName: null,
          outputMimeType: null,
          outputSizeBytes: null,
          outputContentHash: null,
          outputPoster: Prisma.DbNull,
          activeOutputVersion: null,
          errorCode: 'MATERIAL_DELETED',
          errorMessage: '素材已删除，可重新生成或导入替代素材',
          completedAt: new Date(),
        },
      });
      await transaction.effectSegmentRenderBatch.update({
        where: { projectId_id: { projectId, id: batchId } },
        data: { revision: { increment: 1 }, committedAt: null },
      });
      await this.settleBatchInTransaction(transaction, projectId, batchId, new Date());
      return { kind: 'UPDATED' as const };
    });
  }

  async startRepair(
    projectId: string,
    batchId: string,
    taskId: string,
    expectedBatchRevision: number,
    expectedSourceVersion: number,
    idempotencyKey: string,
    requestHash: string,
    sourceFingerprint: string,
    requestSnapshot: EffectSegmentRenderRequestSnapshot,
    repair: EffectSegmentRenderRepairInput,
  ) {
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
        const task = await transaction.effectSegmentRenderTask.findFirst({
          where: { projectId, batchId, id: taskId },
        });
        if (!task) return { kind: 'TASK_NOT_FOUND' as const };
        if (task.status !== 'COMPLETED') return { kind: 'TASK_NOT_READY' as const };
        if (task.repairStatus !== null || task.operationKind === 'REPAIR')
          return { kind: 'TASK_REPAIR_PENDING' as const };
        if (
          task.activeOutputVersion !== expectedSourceVersion ||
          !task.outputFileObjectId ||
          !task.outputStorageKey ||
          !task.outputFileName ||
          !task.outputMimeType ||
          task.outputSizeBytes === null ||
          !task.outputContentHash
        )
          return { kind: 'SOURCE_VERSION_CONFLICT' as const };
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
        const generationSnapshot = task.generationRequestSnapshot as unknown as {
          sourcePackage?: { artifactId?: string; revision?: number; contentHash?: string };
        };
        const sourcePackage = generationSnapshot.sourcePackage;
        if (
          !sourcePackage?.artifactId ||
          !sourcePackage.revision ||
          !sourcePackage.contentHash ||
          !(await transaction.workingArtifact.findFirst({
            where: {
              projectId,
              workflowRunId: batch.workflowRunId,
              id: sourcePackage.artifactId,
              nodeId: 'SOURCE_IMPORT',
              artifactKey: 'source-package:' + batch.productId,
              revision: sourcePackage.revision,
              contentHash: sourcePackage.contentHash,
              freshness: 'CURRENT',
              availability: 'AVAILABLE',
            },
          }))
        )
          return { kind: 'SOURCE_CONFLICT' as const };
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
        await transaction.effectSegmentRenderTask.update({
          where: { projectId_id: { projectId, id: taskId } },
          data: {
            operationKind: 'REPAIR',
            status: 'QUEUED',
            progress: 0,
            renderVersion: { increment: 1 },
            requestSnapshot: json(requestSnapshot),
            sourceFingerprint,
            retryCount: 0,
            attemptCount: 0,
            attemptToken: null,
            leaseExpiresAt: null,
            heartbeatAt: null,
            providerTaskId: null,
            errorCode: null,
            errorMessage: null,
            repairStatus: 'QUEUED',
            repairSourceVersion: repair.sourceVersion,
            repairStartMs: repair.startMs,
            repairEndMs: repair.endMs,
            repairRegion: repair.region ? json(repair.region) : Prisma.DbNull,
            repairInstruction: repair.instruction,
            repairRequestHash: requestHash,
            repairCandidateFileObjectId: null,
            repairCandidateStorageKey: null,
            repairCandidateFileName: null,
            repairCandidateMimeType: null,
            repairCandidateSizeBytes: null,
            repairCandidateContentHash: null,
            repairCandidatePoster: Prisma.DbNull,
            repairCandidateVersion: null,
            repairCandidateCreatedAt: null,
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
              aggregateId: taskId,
            },
          },
          create: {
            projectId,
            jobType: EFFECT_SEGMENT_RENDER_JOB_TYPE,
            aggregateId: taskId,
            routingKey: EFFECT_SEGMENT_RENDER_QUEUE,
            payload: json({
              schemaVersion: 1,
              projectId,
              runId: taskId,
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
              runId: taskId,
              requestId: randomUUID(),
            }),
          },
        });
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

  async decideRepair(
    projectId: string,
    batchId: string,
    taskId: string,
    expectedBatchRevision: number,
    repairVersion: number,
    decision: EffectSegmentRenderRepairDecision,
    idempotencyKey: string,
  ) {
    const requestHash = workflowStateHash({ batchId, taskId, repairVersion, decision });
    return this.prisma.$transaction(async (transaction) => {
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
      const task = await transaction.effectSegmentRenderTask.findFirst({
        where: { projectId, batchId, id: taskId },
      });
      if (!task) return { kind: 'TASK_NOT_FOUND' as const };
      if (
        task.operationKind !== 'REPAIR' ||
        task.status !== 'COMPLETED' ||
        task.renderVersion !== repairVersion ||
        task.repairSourceVersion !== task.activeOutputVersion ||
        (task.repairStatus !== 'READY' && task.repairStatus !== 'FAILED')
      )
        return { kind: 'REPAIR_CONFLICT' as const };
      if (
        decision === 'ACCEPT' &&
        (task.repairStatus !== 'READY' ||
          !task.repairCandidateFileObjectId ||
          !task.repairCandidateStorageKey ||
          !task.repairCandidateFileName ||
          !task.repairCandidateMimeType ||
          task.repairCandidateSizeBytes === null ||
          !task.repairCandidateContentHash ||
          task.repairCandidateVersion !== repairVersion)
      )
        return { kind: 'REPAIR_NOT_READY' as const };
      await transaction.effectSegmentRenderOperationReceipt.create({
        data: { projectId, batchId, idempotencyKey, requestHash },
      });
      const repairSnapshot = task.requestSnapshot as unknown as {
        inputVideo?: { providerTaskId?: unknown };
      };
      const sourceProviderTaskId =
        typeof repairSnapshot.inputVideo?.providerTaskId === 'string' &&
        repairSnapshot.inputVideo.providerTaskId.trim()
          ? repairSnapshot.inputVideo.providerTaskId.trim()
          : null;
      // The previous active clip remains playable from older branches.
      await transaction.effectSegmentRenderTask.update({
        where: { projectId_id: { projectId, id: taskId } },
        data: {
          operationKind: 'GENERATE',
          status: 'COMPLETED',
          progress: 100,
          requestSnapshot: json(task.generationRequestSnapshot),
          sourceFingerprint: workflowStateHash(task.generationRequestSnapshot),
          ...(decision === 'ACCEPT'
            ? {
                outputFileObjectId: task.repairCandidateFileObjectId!,
                outputStorageKey: task.repairCandidateStorageKey!,
                outputFileName: task.repairCandidateFileName!,
                outputMimeType: task.repairCandidateMimeType!,
                outputSizeBytes: task.repairCandidateSizeBytes!,
                outputContentHash: task.repairCandidateContentHash!,
                outputPoster: task.repairCandidatePoster ?? Prisma.DbNull,
                activeOutputVersion: repairVersion,
              }
            : {}),
          retryCount: 0,
          attemptCount: 0,
          attemptToken: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
          providerTaskId: decision === 'ACCEPT' ? task.providerTaskId : sourceProviderTaskId,
          errorCode: null,
          errorMessage: null,
          repairStatus: null,
          repairSourceVersion: null,
          repairStartMs: null,
          repairEndMs: null,
          repairRegion: Prisma.DbNull,
          repairInstruction: null,
          repairRequestHash: null,
          repairCandidateFileObjectId: null,
          repairCandidateStorageKey: null,
          repairCandidateFileName: null,
          repairCandidateMimeType: null,
          repairCandidateSizeBytes: null,
          repairCandidateContentHash: null,
          repairCandidatePoster: Prisma.DbNull,
          repairCandidateVersion: null,
          repairCandidateCreatedAt: null,
          completedAt: new Date(),
        },
      });
      await transaction.effectSegmentRenderBatch.update({
        where: { projectId_id: { projectId, id: batchId } },
        data: { revision: { increment: 1 } },
      });
      await this.settleBatchInTransaction(transaction, projectId, batchId, new Date());
      return { kind: 'UPDATED' as const };
    });
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
          status: task.operationKind === 'REPAIR' ? 'COMPLETED' : 'FAILED',
          ...(task.operationKind === 'REPAIR' ? { repairStatus: 'FAILED' as const } : {}),
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
      return {
        kind: 'TERMINAL' as const,
        task: {
          ...task,
          status: task.operationKind === 'REPAIR' ? ('COMPLETED' as const) : ('FAILED' as const),
        },
      };
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
        ...(task.operationKind === 'REPAIR' ? { repairStatus: 'RUNNING' as const } : {}),
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
    poster?: EffectSegmentRenderStoredFile,
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
      const posterFileObject = poster
        ? await this.workingRepository.upsertFileObjectInTransaction(
            transaction,
            projectId,
            task.workflowRunId,
            { ...poster, nodeId: 'SEGMENT_RENDER' },
          )
        : null;
      if (task.operationKind === 'REPAIR') {
        const completed = await transaction.effectSegmentRenderTask.update({
          where: { projectId_id: { projectId, id: taskId } },
          data: {
            status: 'COMPLETED',
            progress: 100,
            providerTaskId,
            repairStatus: 'READY',
            repairCandidateFileObjectId: fileObject.id,
            repairCandidateStorageKey: file.storageKey,
            repairCandidateFileName: file.originalFileName,
            repairCandidateMimeType: file.mimeType,
            repairCandidateSizeBytes: file.sizeBytes,
            repairCandidateContentHash: file.sha256,
            repairCandidatePoster:
              poster && posterFileObject
                ? posterMetadata({ ...poster, id: posterFileObject.id }, taskVersion)
                : Prisma.DbNull,
            repairCandidateVersion: taskVersion,
            repairCandidateCreatedAt: now,
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
        return { kind: 'REPAIR_COMPLETED' as const, task: completed };
      }
      // A regenerated output can replace the draft's active version without
      // invalidating the old file object used by an earlier branch.
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
          outputPoster:
            poster && posterFileObject
              ? posterMetadata({ ...poster, id: posterFileObject.id }, taskVersion)
              : Prisma.DbNull,
          activeOutputVersion: taskVersion,
          operationKind: 'GENERATE',
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
    input: {
      errorCode: string;
      errorMessage: string;
      retryable: boolean;
      providerTaskId?: string;
      resetProviderTask?: boolean;
    },
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
      const terminalStatus =
        !retry && task.operationKind === 'REPAIR' ? ('COMPLETED' as const) : ('FAILED' as const);
      await transaction.effectSegmentRenderTask.update({
        where: { projectId_id: { projectId, id: taskId } },
        data: {
          status: retry ? 'QUEUED' : terminalStatus,
          ...(task.operationKind === 'REPAIR'
            ? { repairStatus: retry ? ('QUEUED' as const) : ('FAILED' as const) }
            : {}),
          progress: retry ? Math.max(1, Math.min(task.progress, 90)) : task.progress,
          ...(retry ? { retryCount: { increment: 1 } } : {}),
          ...(retry && input.resetProviderTask
            ? { providerTaskId: null }
            : input.providerTaskId
              ? { providerTaskId: input.providerTaskId }
              : {}),
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
        operationKind: true,
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
          status:
            retry || task.operationKind !== 'REPAIR' ? (retry ? 'QUEUED' : 'FAILED') : 'COMPLETED',
          ...(task.operationKind === 'REPAIR'
            ? { repairStatus: retry ? ('QUEUED' as const) : ('FAILED' as const) }
            : {}),
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
    sourcePrompt: { artifactId: string; revision: number; contentHash: string },
    sourcePackage: { artifactId: string; revision: number; contentHash: string },
    artifacts: Array<{ artifactKey: string; input: WorkingArtifactUpsertInput }>,
  ) {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.prisma.$transaction(
          (transaction) =>
            this.commitValidatedBatchTransaction(
              transaction,
              projectId,
              batchId,
              expectedRevision,
              sourcePrompt,
              sourcePackage,
              artifacts,
            ),
          COMMIT_TRANSACTION_OPTIONS,
        );
      } catch (error) {
        if (error instanceof Error && error.message === BRANCH_PUBLICATION_CONFLICT)
          return { kind: 'BRANCH_CONFLICT' as const };
        if (!isTransientTransactionError(error)) throw error;
        if (attempt >= COMMIT_TRANSACTION_ATTEMPTS) return { kind: 'CONFLICT' as const };
        await new Promise((resolve) => {
          setTimeout(resolve, COMMIT_TRANSACTION_RETRY_DELAY_MS * attempt);
        });
      }
    }
  }

  private async commitValidatedBatchTransaction(
    transaction: Prisma.TransactionClient,
    projectId: string,
    batchId: string,
    expectedRevision: number,
    sourcePrompt: { artifactId: string; revision: number; contentHash: string },
    sourcePackage: { artifactId: string; revision: number; contentHash: string },
    artifacts: Array<{ artifactKey: string; input: WorkingArtifactUpsertInput }>,
  ) {
    // Branch creation/activation takes the project lock. Acquire it before the
    // batch lock so this transaction shares the edit-session lock order.
    await transaction.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "projects" WHERE "id" = ${projectId}::uuid FOR UPDATE
    `;
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
        id: sourcePrompt.artifactId,
        nodeId: 'PROMPT_GENERATION',
        artifactKey: 'prompt-batch:' + batch.productId,
        revision: sourcePrompt.revision,
        contentHash: sourcePrompt.contentHash,
        freshness: 'CURRENT',
        availability: 'AVAILABLE',
      },
    });
    if (!prompt) return { kind: 'PROMPT_CONFLICT' as const };
    const source = await transaction.workingArtifact.findFirst({
      where: {
        projectId,
        workflowRunId: batch.workflowRunId,
        id: sourcePackage.artifactId,
        nodeId: 'SOURCE_IMPORT',
        artifactKey: 'source-package:' + batch.productId,
        revision: sourcePackage.revision,
        contentHash: sourcePackage.contentHash,
        freshness: 'CURRENT',
        availability: 'AVAILABLE',
      },
    });
    if (!source) return { kind: 'SOURCE_CONFLICT' as const };
    if (!this.workingRepository) throw new Error('WORKFLOW_WORKING_REPOSITORY_NOT_AVAILABLE');
    await transaction.effectSegmentRenderBatch.update({
      where: { projectId_id: { projectId, id: batchId } },
      data: {
        sourcePromptArtifactId: sourcePrompt.artifactId,
        sourcePromptRevision: sourcePrompt.revision,
        sourcePromptHash: sourcePrompt.contentHash,
      },
    });
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
    const run = await transaction.workflowRun.findFirst({
      where: { projectId, id: batch.workflowRunId },
      select: {
        parentWorkflowRunId: true,
        branchPublishedAt: true,
        editSessionNodeId: true,
        editSessionPurpose: true,
        editIdMap: true,
      },
    });
    if (!run) throw new Error(BRANCH_PUBLICATION_CONFLICT);
    let publication: { activeWorkflowRunId: string; createdBranch: boolean } | null = null;
    let responseArtifacts = committed.map((item) => ({
      artifactId: item.record.id,
      artifactKey: item.artifactKey,
      revision: item.record.revision,
      unchanged: item.unchanged,
    }));
    if (run.parentWorkflowRunId && !run.branchPublishedAt) {
      if (run.editSessionNodeId !== 'SEGMENT_RENDER') throw new Error(BRANCH_PUBLICATION_CONFLICT);
      const result =
        run.editSessionPurpose === 'MANUAL'
          ? await this.applyManualRenderEditInTransaction(
              transaction,
              projectId,
              batch,
              run.parentWorkflowRunId,
              run.editIdMap,
              artifacts,
            )
          : await this.workingRepository.publishEffectNodeEditInTransaction(
              transaction,
              projectId,
              batch.workflowRunId,
              'SEGMENT_RENDER',
            );
      if (!result) throw new Error(BRANCH_PUBLICATION_CONFLICT);
      publication = {
        activeWorkflowRunId: result.activeWorkflowRunId,
        createdBranch: result.createdBranch,
      };
      if ('artifacts' in result && Array.isArray(result.artifacts))
        responseArtifacts = result.artifacts as typeof responseArtifacts;
    }
    return {
      kind: 'COMMITTED' as const,
      publication,
      artifacts: responseArtifacts,
    };
  }

  private async applyManualRenderEditInTransaction(
    transaction: Prisma.TransactionClient,
    projectId: string,
    childBatch: Prisma.EffectSegmentRenderBatchGetPayload<{ include: { tasks: true } }>,
    parentRunId: string,
    editIdMap: Prisma.JsonValue | null,
    artifacts: Array<{ artifactKey: string; input: WorkingArtifactUpsertInput }>,
  ): Promise<{
    runId: string;
    activeWorkflowRunId: string;
    createdBranch: boolean;
    artifacts: Array<{
      artifactId: string;
      artifactKey: string;
      revision: number;
      unchanged: boolean;
    }>;
  } | null> {
    if (!this.workingRepository) throw new Error('WORKFLOW_WORKING_REPOSITORY_NOT_AVAILABLE');
    const map = (editIdMap ?? {}) as {
      productIdMap?: Record<string, string>;
      taskIdMap?: Record<string, string>;
    };
    const parentProductId = Object.entries(map.productIdMap ?? {}).find(
      ([, id]) => id === childBatch.productId,
    )?.[0];
    if (!parentProductId) throw new Error('RENDER_EDIT_PRODUCT_MAPPING_MISSING');
    // Mirror the edit session's source-batch pick (newest committed, non-archived batch of the
    // product). `activeKey` only marks an in-flight batch, so a completed parent never carries it.
    const parentBatch = await transaction.effectSegmentRenderBatch.findFirst({
      where: {
        projectId,
        workflowRunId: parentRunId,
        productId: parentProductId,
        archivedAt: null,
        committedAt: { not: null },
      },
      include: { tasks: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    if (!parentBatch) throw new Error('RENDER_EDIT_PARENT_BATCH_MISSING');
    const parentPrompt = await transaction.workingArtifact.findUnique({
      where: {
        projectId_workflowRunId_nodeId_artifactKey: {
          projectId,
          workflowRunId: parentRunId,
          nodeId: 'PROMPT_GENERATION',
          artifactKey: `prompt-batch:${parentProductId}`,
        },
      },
    });
    const childPrompt = await transaction.workingArtifact.findUnique({
      where: {
        projectId_workflowRunId_nodeId_artifactKey: {
          projectId,
          workflowRunId: childBatch.workflowRunId,
          nodeId: 'PROMPT_GENERATION',
          artifactKey: `prompt-batch:${childBatch.productId}`,
        },
      },
    });
    const parentSource = await transaction.workingArtifact.findUnique({
      where: {
        projectId_workflowRunId_nodeId_artifactKey: {
          projectId,
          workflowRunId: parentRunId,
          nodeId: 'SOURCE_IMPORT',
          artifactKey: `source-package:${parentProductId}`,
        },
      },
    });
    const childSource = await transaction.workingArtifact.findUnique({
      where: {
        projectId_workflowRunId_nodeId_artifactKey: {
          projectId,
          workflowRunId: childBatch.workflowRunId,
          nodeId: 'SOURCE_IMPORT',
          artifactKey: `source-package:${childBatch.productId}`,
        },
      },
    });
    if (
      !parentPrompt ||
      !childPrompt ||
      !parentSource ||
      !childSource ||
      parentPrompt.revision !== childPrompt.revision ||
      parentSource.revision !== childSource.revision
    )
      throw new Error('RENDER_EDIT_PARENT_CHANGED');
    const ids: Record<string, string> = {
      [childBatch.workflowRunId]: parentRunId,
      [childBatch.productId]: parentProductId,
      [childBatch.id]: parentBatch.id,
      [childPrompt.id]: parentPrompt.id,
      [childPrompt.contentHash]: parentPrompt.contentHash,
      [childSource.id]: parentSource.id,
      [childSource.contentHash]: parentSource.contentHash,
    };
    for (const [parentTaskId, childTaskId] of Object.entries(map.taskIdMap ?? {}))
      ids[childTaskId] = parentTaskId;
    const remap = <T>(value: T): T => {
      if (value === undefined || value === null) return value;
      let serialized = JSON.stringify(value);
      for (const [before, after] of Object.entries(ids))
        serialized = serialized.replaceAll(before, after);
      return JSON.parse(serialized) as T;
    };
    const originalTaskById = new Map(parentBatch.tasks.map((task) => [task.id, task]));
    const originalTaskByPrompt = new Map(parentBatch.tasks.map((task) => [task.promptId, task]));
    for (const task of childBatch.tasks) {
      const parentTask =
        originalTaskById.get(ids[task.id] ?? '') ?? originalTaskByPrompt.get(task.promptId);
      if (parentTask) ids[task.id] = parentTask.id;
    }
    const newFileIds = childBatch.tasks
      .flatMap((task) => [
        task.outputFileObjectId,
        task.repairCandidateFileObjectId,
        posterFileObjectId(task.outputPoster),
        posterFileObjectId(task.repairCandidatePoster),
      ])
      .filter((id): id is string => Boolean(id));
    if (newFileIds.length)
      await transaction.fileObject.updateMany({
        where: {
          projectId,
          workflowRunId: childBatch.workflowRunId,
          id: { in: [...new Set(newFileIds)] },
        },
        data: { workflowRunId: parentRunId },
      });
    for (const task of childBatch.tasks) {
      const parentTask =
        originalTaskById.get(ids[task.id] ?? '') ?? originalTaskByPrompt.get(task.promptId);
      const fields = {
        promptId: task.promptId,
        promptCode: task.promptCode,
        renderCode: task.renderCode,
        sourceFingerprint: task.sourceFingerprint,
        requestSnapshot: json(remap(task.requestSnapshot)),
        generationRequestSnapshot: json(remap(task.generationRequestSnapshot)),
        operationKind: task.operationKind,
        status: task.status,
        progress: task.progress,
        renderVersion: task.renderVersion,
        activeOutputVersion: task.activeOutputVersion,
        retryCount: task.retryCount,
        maxAutoRetries: task.maxAutoRetries,
        attemptCount: task.attemptCount,
        attemptToken: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        providerTaskId: task.providerTaskId,
        outputFileObjectId: task.outputFileObjectId,
        outputStorageKey: task.outputStorageKey,
        outputFileName: task.outputFileName,
        outputMimeType: task.outputMimeType,
        outputSizeBytes: task.outputSizeBytes,
        outputContentHash: task.outputContentHash,
        outputPoster: task.outputPoster === null ? Prisma.DbNull : json(remap(task.outputPoster)),
        repairStatus: task.repairStatus,
        repairSourceVersion: task.repairSourceVersion,
        repairStartMs: task.repairStartMs,
        repairEndMs: task.repairEndMs,
        repairRegion: task.repairRegion === null ? Prisma.DbNull : json(remap(task.repairRegion)),
        repairInstruction: task.repairInstruction,
        repairRequestHash: task.repairRequestHash,
        repairCandidateFileObjectId: task.repairCandidateFileObjectId,
        repairCandidateStorageKey: task.repairCandidateStorageKey,
        repairCandidateFileName: task.repairCandidateFileName,
        repairCandidateMimeType: task.repairCandidateMimeType,
        repairCandidateSizeBytes: task.repairCandidateSizeBytes,
        repairCandidateContentHash: task.repairCandidateContentHash,
        repairCandidatePoster:
          task.repairCandidatePoster === null
            ? Prisma.DbNull
            : json(remap(task.repairCandidatePoster)),
        repairCandidateVersion: task.repairCandidateVersion,
        repairCandidateCreatedAt: task.repairCandidateCreatedAt,
        errorCode: task.errorCode,
        errorMessage: task.errorMessage,
        queuedAt: task.queuedAt,
        startedAt: task.startedAt,
        completedAt: task.completedAt,
      };
      if (parentTask)
        await transaction.effectSegmentRenderTask.update({
          where: { id: parentTask.id },
          data: fields,
        });
      else {
        const created = await transaction.effectSegmentRenderTask.create({
          data: {
            projectId,
            workflowRunId: parentRunId,
            productId: parentProductId,
            batchId: parentBatch.id,
            ...fields,
          },
        });
        ids[task.id] = created.id;
      }
    }
    await transaction.effectSegmentRenderBatch.update({
      where: { id: parentBatch.id },
      data: {
        sourcePromptArtifactId: parentPrompt.id,
        sourcePromptRevision: parentPrompt.revision,
        sourcePromptHash: parentPrompt.contentHash,
        sourceFingerprint: childBatch.sourceFingerprint,
        status: childBatch.status,
        committedAt: new Date(),
      },
    });
    const remappedInputs = artifacts.map(({ artifactKey, input }) => ({
      artifactKey: remap(artifactKey),
      invalidateDependents: false,
      input: {
        ...input,
        payload: remap(input.payload),
        metadata: remap(input.metadata),
        sourceRunId: remap(input.sourceRunId) ?? null,
        sourceArtifactId: remap(input.sourceArtifactId) ?? null,
        ...(input.dependencies
          ? {
              dependencies: input.dependencies.map((dependency) => ({
                ...dependency,
                sourceNodeId: remap(dependency.sourceNodeId) ?? null,
                sourceArtifactId: remap(dependency.sourceArtifactId) ?? null,
                sourceKey: remap(dependency.sourceKey),
                sourceHash: remap(dependency.sourceHash) ?? null,
              })),
            }
          : {}),
      },
    }));
    const committed = await this.workingRepository.commitValidatedArtifactsInTransaction(
      transaction,
      projectId,
      parentRunId,
      'SEGMENT_RENDER',
      remappedInputs,
    );
    if (committed.some((item) => !item.unchanged))
      await transaction.effectSegmentRenderBatch.update({
        where: { id: parentBatch.id },
        data: { revision: { increment: 1 } },
      });
    const affectedIds = committed
      .filter((item) => !item.unchanged && item.artifactKey.startsWith('render-clip:'))
      .map((item) => item.record.id);
    if (affectedIds.length) {
      const dependents = await transaction.workingArtifactDependency.findMany({
        where: {
          projectId,
          sourceType: 'WORKING_ARTIFACT',
          sourceArtifactId: { in: affectedIds },
        },
        select: { dependentArtifactId: true },
      });
      if (dependents.length)
        await this.workingRepository.markArtifactIdsAndDependentsStaleInTransaction(
          transaction,
          projectId,
          parentRunId,
          dependents.map((item) => item.dependentArtifactId),
        );
    }
    const exited = await exitEffectEditInTransaction(
      transaction,
      projectId,
      childBatch.workflowRunId,
      'SEGMENT_RENDER',
      false,
    );
    if (!exited || exited.runId !== parentRunId) throw new Error('RENDER_EDIT_EXIT_FAILED');
    return {
      ...exited,
      artifacts: committed.map((item) => ({
        artifactId: item.record.id,
        artifactKey: item.artifactKey,
        revision: item.record.revision,
        unchanged: item.unchanged,
      })),
    };
  }
}
