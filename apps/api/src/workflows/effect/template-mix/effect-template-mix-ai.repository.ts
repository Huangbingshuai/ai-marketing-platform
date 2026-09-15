import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import {
  EFFECT_TEMPLATE_MIX_JOB_TYPE,
  EFFECT_TEMPLATE_MIX_QUEUE,
} from '../../../platform/job/job.constants';
import type { EffectTemplateMixAiSnapshot } from './effect-template-mix-ai.types';

const json = (value: unknown): Prisma.InputJsonValue => value as Prisma.InputJsonValue;
const leaseUntil = (now: Date): Date => new Date(now.getTime() + 2 * 60 * 1000);

@Injectable()
export class EffectTemplateMixAiRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  listRecent(projectId: string, workflowRunId: string) {
    return this.prisma.effectTemplateMixAiRun.findMany({
      where: { projectId, workflowRunId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 20,
    });
  }

  find(projectId: string, runId: string) {
    return this.prisma.effectTemplateMixAiRun.findFirst({ where: { projectId, id: runId } });
  }

  sourceArtifacts(projectId: string, workflowRunId: string) {
    return this.prisma.workingArtifact.findMany({
      where: {
        projectId,
        workflowRunId,
        nodeId: { in: ['PROMPT_GENERATION', 'SEGMENT_RENDER'] },
        freshness: 'CURRENT',
        availability: 'AVAILABLE',
      },
      include: {
        files: {
          include: { fileObject: true },
          orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
        },
      },
    });
  }

  async selectedFile(projectId: string, runId: string, materialId: string, attemptToken: string) {
    const run = await this.prisma.effectTemplateMixAiRun.findFirst({
      where: {
        projectId,
        id: runId,
        status: 'RUNNING',
        attemptToken,
        leaseExpiresAt: { gt: new Date() },
      },
    });
    const selections = Array.isArray(run?.selectionResult) ? run.selectionResult : [];
    if (
      !run ||
      !selections.some((item) => (item as { materialId?: unknown }).materialId === materialId)
    )
      return null;
    const artifact = await this.prisma.workingArtifact.findFirst({
      where: {
        projectId,
        workflowRunId: run.workflowRunId,
        id: materialId,
        nodeId: 'SEGMENT_RENDER',
        freshness: 'CURRENT',
        availability: 'AVAILABLE',
      },
      include: { files: { include: { fileObject: true }, orderBy: { sortOrder: 'asc' } } },
    });
    if (
      !artifact?.storageKey ||
      !artifact.originalFileName ||
      !artifact.mimeType ||
      !artifact.sizeBytes
    )
      return null;
    return {
      run,
      artifact,
      file: {
        storageKey: artifact.storageKey,
        originalFileName: artifact.originalFileName,
        mimeType: artifact.mimeType,
        sizeBytes: artifact.sizeBytes,
      },
    };
  }

  async create(input: {
    projectId: string;
    workflowRunId: string;
    templateId: string;
    targetVariantId: string | null;
    expectedDraftRevision: number;
    templateEditVersion: number;
    idempotencyKey: string;
    requestHash: string;
    inputHash: string;
    snapshot: EffectTemplateMixAiSnapshot;
    initialClassifications?: unknown[];
    initialSelections?: unknown[];
    initialTrims?: unknown[];
  }) {
    return this.prisma.$transaction(async (transaction) => {
      const existing = await transaction.effectTemplateMixAiRun.findUnique({
        where: {
          projectId_idempotencyKey: {
            projectId: input.projectId,
            idempotencyKey: input.idempotencyKey,
          },
        },
      });
      if (existing)
        return existing.requestHash === input.requestHash
          ? { kind: 'REPLAYED' as const, run: existing }
          : { kind: 'KEY_CONFLICT' as const };
      const nodeState = await transaction.workflowNodeState.findUnique({
        where: {
          projectId_workflowRunId_nodeId: {
            projectId: input.projectId,
            workflowRunId: input.workflowRunId,
            nodeId: 'TEMPLATE_MIX',
          },
        },
      });
      if (!nodeState || nodeState.revision !== input.expectedDraftRevision)
        return { kind: 'STALE_INPUT' as const };
      const frozenSources = [
        ...input.snapshot.promptArtifacts.map((item) => ({
          id: item.id,
          revision: item.revision,
          contentHash: item.contentHash,
        })),
        ...input.snapshot.materials.map((item) => ({
          id: item.artifactId,
          revision: item.artifactRevision,
          contentHash: item.contentHash,
        })),
      ];
      const currentSources = await transaction.workingArtifact.findMany({
        where: {
          projectId: input.projectId,
          workflowRunId: input.workflowRunId,
          id: { in: frozenSources.map(({ id }) => id) },
          freshness: 'CURRENT',
          availability: 'AVAILABLE',
        },
        select: { id: true, revision: true, contentHash: true },
      });
      const currentById = new Map(currentSources.map((item) => [item.id, item]));
      if (
        frozenSources.some((source) => {
          const current = currentById.get(source.id);
          return (
            current?.revision !== source.revision || current.contentHash !== source.contentHash
          );
        })
      )
        return { kind: 'STALE_INPUT' as const };
      const active = await transaction.effectTemplateMixAiRun.findFirst({
        where: {
          projectId: input.projectId,
          workflowRunId: input.workflowRunId,
          templateId: input.templateId,
          status: { in: ['QUEUED', 'RUNNING'] },
        },
      });
      if (active) return { kind: 'ACTIVE_CONFLICT' as const, run: active };
      const run = await transaction.effectTemplateMixAiRun.create({
        data: {
          projectId: input.projectId,
          workflowRunId: input.workflowRunId,
          templateId: input.templateId,
          targetVariantId: input.targetVariantId,
          expectedDraftRevision: input.expectedDraftRevision,
          templateEditVersion: input.templateEditVersion,
          idempotencyKey: input.idempotencyKey,
          requestHash: input.requestHash,
          inputHash: input.inputHash,
          inputSnapshot: json(input.snapshot),
          ...(input.initialClassifications
            ? { classificationResult: json(input.initialClassifications) }
            : {}),
          ...(input.initialSelections ? { selectionResult: json(input.initialSelections) } : {}),
          ...(input.initialTrims ? { trimResult: json(input.initialTrims) } : {}),
        },
      });
      await transaction.jobOutbox.create({
        data: {
          projectId: input.projectId,
          jobType: EFFECT_TEMPLATE_MIX_JOB_TYPE,
          aggregateId: run.id,
          routingKey: EFFECT_TEMPLATE_MIX_QUEUE,
          payload: json({
            schemaVersion: 1,
            projectId: input.projectId,
            runId: run.id,
            requestId: randomUUID(),
          }),
        },
      });
      return { kind: 'CREATED' as const, run };
    });
  }

  async claim(projectId: string, runId: string, now = new Date()) {
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "effect_template_mix_ai_runs"
        WHERE "projectId" = ${projectId}::uuid AND "id" = ${runId}::uuid FOR UPDATE
      `;
      const run = await transaction.effectTemplateMixAiRun.findFirst({
        where: { projectId, id: runId },
      });
      if (!run) return { kind: 'NOT_FOUND' as const };
      if (run.status === 'COMPLETED' || run.status === 'FAILED' || run.status === 'CANCELLED')
        return { kind: 'TERMINAL' as const, run };
      if (run.status === 'RUNNING' && run.leaseExpiresAt && run.leaseExpiresAt > now)
        return { kind: 'BUSY' as const };
      if (run.attemptCount >= run.maxAttempts) return { kind: 'ATTEMPTS_EXHAUSTED' as const };
      const attemptToken = randomUUID();
      const claimed = await transaction.effectTemplateMixAiRun.update({
        where: { projectId_id: { projectId, id: runId } },
        data: {
          status: 'RUNNING',
          attemptCount: { increment: 1 },
          attemptToken,
          leaseExpiresAt: leaseUntil(now),
          heartbeatAt: now,
          startedAt: run.startedAt ?? now,
          errorCode: null,
          errorMessage: null,
        },
      });
      return { kind: 'CLAIMED' as const, run: claimed, attemptToken };
    });
  }

  progress(
    projectId: string,
    runId: string,
    attemptToken: string,
    stage: 'CLASSIFYING' | 'MATCHING' | 'SAMPLING' | 'TRIMMING',
    progress: number,
    now = new Date(),
  ) {
    return this.prisma.effectTemplateMixAiRun.updateMany({
      where: {
        projectId,
        id: runId,
        status: 'RUNNING',
        attemptToken,
        leaseExpiresAt: { gt: now },
      },
      data: {
        stage,
        progress: Math.min(95, Math.max(1, Math.round(progress))),
        heartbeatAt: now,
        leaseExpiresAt: leaseUntil(now),
      },
    });
  }

  saveSelection(
    projectId: string,
    runId: string,
    attemptToken: string,
    classifications: unknown,
    selections: unknown,
    now = new Date(),
  ) {
    return this.prisma.effectTemplateMixAiRun.updateMany({
      where: { projectId, id: runId, status: 'RUNNING', attemptToken, leaseExpiresAt: { gt: now } },
      data: {
        classificationResult: json(classifications),
        selectionResult: json(selections),
        stage: 'SAMPLING',
        progress: 45,
        heartbeatAt: now,
        leaseExpiresAt: leaseUntil(now),
      },
    });
  }

  async saveClassificationCheckpoint(
    projectId: string,
    runId: string,
    attemptToken: string,
    classifications: unknown[],
    now = new Date(),
  ) {
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "effect_template_mix_ai_runs"
        WHERE "projectId" = ${projectId}::uuid AND "id" = ${runId}::uuid FOR UPDATE
      `;
      const run = await transaction.effectTemplateMixAiRun.findFirst({
        where: {
          projectId,
          id: runId,
          status: 'RUNNING',
          attemptToken,
          leaseExpiresAt: { gt: now },
        },
      });
      if (!run) return { kind: 'LEASE_CONFLICT' as const };
      const existing = Array.isArray(run.classificationResult)
        ? (run.classificationResult as unknown[])
        : [];
      const byMaterialId = new Map<string, unknown>();
      for (const item of [...existing, ...classifications]) {
        const materialId = (item as { materialId?: unknown })?.materialId;
        if (typeof materialId === 'string') byMaterialId.set(materialId, item);
      }
      const merged = [...byMaterialId.values()];
      const snapshot = run.inputSnapshot as unknown as EffectTemplateMixAiSnapshot;
      const progress = Math.min(
        30,
        10 + Math.round((merged.length / Math.max(1, snapshot.materials.length)) * 20),
      );
      await transaction.effectTemplateMixAiRun.update({
        where: { projectId_id: { projectId, id: runId } },
        data: {
          classificationResult: json(merged),
          stage: 'CLASSIFYING',
          progress,
          heartbeatAt: now,
          leaseExpiresAt: leaseUntil(now),
        },
      });
      return { kind: 'SAVED' as const, classifications: merged, progress };
    });
  }

  async saveTrimCheckpoint(
    projectId: string,
    runId: string,
    attemptToken: string,
    trims: unknown[],
    now = new Date(),
  ) {
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "effect_template_mix_ai_runs"
        WHERE "projectId" = ${projectId}::uuid AND "id" = ${runId}::uuid FOR UPDATE
      `;
      const run = await transaction.effectTemplateMixAiRun.findFirst({
        where: {
          projectId,
          id: runId,
          status: 'RUNNING',
          attemptToken,
          leaseExpiresAt: { gt: now },
        },
      });
      if (!run) return { kind: 'LEASE_CONFLICT' as const };
      const existing = Array.isArray(run.trimResult) ? (run.trimResult as unknown[]) : [];
      const byKey = new Map<string, unknown>();
      for (const item of [...existing, ...trims]) {
        const value = item as { variantIndex?: unknown; slotId?: unknown };
        if (typeof value.slotId !== 'string') continue;
        const index = typeof value.variantIndex === 'number' ? value.variantIndex : 0;
        byKey.set(`${index}:${value.slotId}`, item);
      }
      const merged = [...byKey.values()];
      const selections = Array.isArray(run.selectionResult) ? run.selectionResult.length : 0;
      const progress = Math.min(
        90,
        55 + Math.round((merged.length / Math.max(1, selections)) * 35),
      );
      await transaction.effectTemplateMixAiRun.update({
        where: { projectId_id: { projectId, id: runId } },
        data: {
          trimResult: json(merged),
          stage: 'TRIMMING',
          progress,
          heartbeatAt: now,
          leaseExpiresAt: leaseUntil(now),
        },
      });
      return { kind: 'SAVED' as const, trims: merged, progress };
    });
  }

  async completeWithDraft(
    projectId: string,
    runId: string,
    attemptToken: string,
    outputVariantId: string,
    trims: unknown,
    draft: unknown,
    draftContentHash: string,
    expectedDraftRevision: number,
    now = new Date(),
  ) {
    return this.prisma.$transaction(async (transaction) => {
      const run = await transaction.effectTemplateMixAiRun.findFirst({
        where: {
          projectId,
          id: runId,
          status: 'RUNNING',
          attemptToken,
          leaseExpiresAt: { gt: now },
        },
      });
      if (!run) return 'LEASE_CONFLICT' as const;
      const nodeState = await transaction.workflowNodeState.findUnique({
        where: {
          projectId_workflowRunId_nodeId: {
            projectId,
            workflowRunId: run.workflowRunId,
            nodeId: 'TEMPLATE_MIX',
          },
        },
      });
      if (!nodeState || nodeState.revision !== expectedDraftRevision)
        return 'DRAFT_CONFLICT' as const;
      if (nodeState.contentHash !== draftContentHash) {
        await transaction.workflowNodeState.update({
          where: { id: nodeState.id },
          data: {
            state: json(draft),
            contentHash: draftContentHash,
            schemaVersion: 1,
            revision: { increment: 1 },
            savedAt: now,
          },
        });
        await transaction.workflowRun.update({
          where: { projectId_id: { projectId, id: run.workflowRunId } },
          data: { currentNodeId: 'TEMPLATE_MIX', lastActiveAt: now },
        });
      }
      await transaction.effectTemplateMixAiRun.update({
        where: { projectId_id: { projectId, id: runId } },
        data: {
          trimResult: json(trims),
          outputVariantId,
          status: 'COMPLETED',
          stage: 'COMPLETED',
          progress: 100,
          attemptToken: null,
          leaseExpiresAt: null,
          heartbeatAt: now,
          completedAt: now,
        },
      });
      return 'COMPLETED' as const;
    });
  }

  async fail(
    projectId: string,
    runId: string,
    attemptToken: string,
    errorCode: string,
    errorMessage: string,
    retryable: boolean,
    now = new Date(),
  ) {
    return this.prisma.$transaction(async (transaction) => {
      const run = await transaction.effectTemplateMixAiRun.findFirst({
        where: { projectId, id: runId },
      });
      if (
        !run ||
        run.status !== 'RUNNING' ||
        run.attemptToken !== attemptToken ||
        !run.leaseExpiresAt ||
        run.leaseExpiresAt <= now
      )
        return 'LEASE_CONFLICT' as const;
      const requeue = retryable && run.attemptCount < run.maxAttempts;
      await transaction.effectTemplateMixAiRun.update({
        where: { projectId_id: { projectId, id: runId } },
        data: {
          status: requeue ? 'QUEUED' : 'FAILED',
          attemptToken: null,
          leaseExpiresAt: null,
          heartbeatAt: now,
          errorCode,
          errorMessage: errorMessage.slice(0, 1000),
          completedAt: requeue ? null : now,
        },
      });
      if (requeue)
        await transaction.jobOutbox.updateMany({
          where: { projectId, jobType: EFFECT_TEMPLATE_MIX_JOB_TYPE, aggregateId: runId },
          data: {
            status: 'PENDING',
            dispatchToken: null,
            nextAttemptAt: now,
            publishedAt: null,
            lastError: null,
          },
        });
      return requeue ? ('REQUEUED' as const) : ('FAILED' as const);
    });
  }

  async recoverExpired(now = new Date()): Promise<void> {
    const runs = await this.prisma.effectTemplateMixAiRun.findMany({
      where: { status: 'RUNNING', leaseExpiresAt: { lte: now } },
      orderBy: { leaseExpiresAt: 'asc' },
      take: 50,
    });
    for (const run of runs) {
      const retry = run.attemptCount < run.maxAttempts;
      const updated = await this.prisma.effectTemplateMixAiRun.updateMany({
        where: {
          projectId: run.projectId,
          id: run.id,
          status: 'RUNNING',
          leaseExpiresAt: { lte: now },
        },
        data: {
          status: retry ? 'QUEUED' : 'FAILED',
          attemptToken: null,
          leaseExpiresAt: null,
          errorCode: 'WORKER_LEASE_EXPIRED',
          errorMessage: retry
            ? '智能填充 Worker 连接中断，任务已重新排队'
            : '智能填充 Worker 多次失联，任务已终止',
          completedAt: retry ? null : now,
        },
      });
      if (updated.count !== 1 || !retry) continue;
      await this.prisma.jobOutbox.updateMany({
        where: {
          projectId: run.projectId,
          jobType: EFFECT_TEMPLATE_MIX_JOB_TYPE,
          aggregateId: run.id,
        },
        data: {
          status: 'PENDING',
          dispatchToken: null,
          nextAttemptAt: now,
          publishedAt: null,
          lastError: null,
        },
      });
    }
  }
}
