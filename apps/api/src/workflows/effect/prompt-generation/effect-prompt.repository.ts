import { randomUUID } from 'node:crypto';

import type {
  EffectPromptBatchResult,
  EffectPromptItem,
  EffectPromptManualOverrides,
  EffectPromptOperation,
} from '@ai-marketing/contracts';
import {
  EFFECT_PROMPT_SCHEMA_VERSION,
  effectPromptTargetCount,
  migrateEffectPromptSettings,
} from '@ai-marketing/contracts';
import { Inject, Injectable, Optional } from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import { EFFECT_PROMPT_JOB_TYPE, EFFECT_PROMPT_QUEUE } from '../../../platform/job/job.constants';
import {
  WorkflowWorkingRepository,
  type WorkingArtifactUpsertInput,
} from '../../../platform/workflow/workflow-working.repository';
import { workflowStateHash } from '../../../platform/workflow/workflow-state-hash';
import {
  mergeEffectPromptCompletionItems,
  parseEffectPromptBatchResult,
  recomputePromptQuality,
} from './effect-prompt.quality';
import {
  emptyManualOverrides,
  type EffectPromptInputSnapshot,
  type EffectPromptShardInput,
  type EffectPromptStageInput,
} from './effect-prompt.types';

const json = (value: unknown): Prisma.InputJsonValue => value as Prisma.InputJsonValue;
const leaseDate = (now: Date): Date => new Date(now.getTime() + 90_000);
const parseStrings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

const promptRunInclude = {
  stages: { orderBy: [{ createdAt: 'asc' as const }, { nodeId: 'asc' as const }] },
  result: true,
} satisfies Prisma.EffectPromptRunInclude;
export type EffectPromptRunRecord = Prisma.EffectPromptRunGetPayload<{
  include: typeof promptRunInclude;
}>;

const promptNodeDetailRunInclude = {
  ...promptRunInclude,
  shards: { orderBy: [{ round: 'asc' as const }, { shardIndex: 'asc' as const }] },
} satisfies Prisma.EffectPromptRunInclude;
export type EffectPromptNodeDetailRunRecord = Prisma.EffectPromptRunGetPayload<{
  include: typeof promptNodeDetailRunInclude;
}>;

const parseOverrides = (value: unknown): EffectPromptManualOverrides => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return emptyManualOverrides();
  const source = value as Partial<EffectPromptManualOverrides>;
  return {
    edited:
      source.edited && typeof source.edited === 'object' && !Array.isArray(source.edited)
        ? source.edited
        : {},
    added: Array.isArray(source.added) ? source.added : [],
    deleted: Array.isArray(source.deleted)
      ? source.deleted.filter((item): item is string => typeof item === 'string')
      : [],
  };
};

export const promptItemsRetainedForRun = (
  result: EffectPromptBatchResult | null,
  targetItemId: string | null,
  operation: EffectPromptOperation,
): EffectPromptItem[] =>
  (result?.items ?? []).filter(
    (item) =>
      item.id !== targetItemId &&
      (operation === 'ITEM_REGENERATE' || item.origin === 'MANUAL' || item.manualEdited),
  );

export type StartPromptRunInput = {
  operation: EffectPromptOperation;
  targetItemId: string | null;
  expectedSettingsRevision: number;
  expectedResultRevision: number | null;
  idempotencyKey: string;
};

@Injectable()
export class EffectPromptRepository {
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

  products(projectId: string, workflowRunId: string) {
    return this.prisma.effectImportProduct.findMany({
      where: { projectId, workflowRunId, status: 'ACTIVE' },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      include: {
        promptRuns: {
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 1,
          include: { result: true, stages: { orderBy: { createdAt: 'asc' } } },
        },
      },
    });
  }

  settingsNode(projectId: string, workflowRunId: string, productId: string) {
    return this.prisma.workflowNodeState.findUnique({
      where: {
        projectId_workflowRunId_nodeId: {
          projectId,
          workflowRunId,
          nodeId: `PROMPT_GENERATION:${productId}`,
        },
      },
    });
  }

  insightArtifact(projectId: string, workflowRunId: string, productId: string) {
    return this.prisma.workingArtifact.findFirst({
      where: {
        projectId,
        workflowRunId,
        nodeId: 'INFORMATION_EXTRACTION',
        artifactKey: `marketing-insight:${productId}`,
      },
    });
  }

  promptArtifact(projectId: string, workflowRunId: string, productId: string) {
    return this.prisma.workingArtifact.findFirst({
      where: {
        projectId,
        workflowRunId,
        nodeId: 'PROMPT_GENERATION',
        artifactKey: `prompt-batch:${productId}`,
      },
    });
  }

  run(projectId: string, runId: string) {
    return this.prisma.effectPromptRun.findFirst({
      where: { projectId, id: runId },
      include: promptRunInclude,
    });
  }

  runForNodeDetail(projectId: string, runId: string) {
    return this.prisma.effectPromptRun.findFirst({
      where: { projectId, id: runId },
      include: promptNodeDetailRunInclude,
    });
  }

  result(projectId: string, resultId: string) {
    return this.prisma.effectPromptResult.findFirst({ where: { projectId, id: resultId } });
  }

  latestResult(projectId: string, workflowRunId: string, productId: string) {
    return this.prisma.effectPromptResult.findFirst({
      where: { projectId, workflowRunId, productId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: { run: true },
    });
  }

  activeRunCount(projectId: string, workflowRunId: string) {
    return this.prisma.effectPromptRun.count({
      where: { projectId, workflowRunId, status: { in: ['QUEUED', 'RUNNING'] } },
    });
  }

  async startRun(
    projectId: string,
    workflowRunId: string,
    productId: string,
    input: StartPromptRunInput,
  ) {
    return this.prisma.$transaction(async (transaction) => {
      const requestHash = workflowStateHash({ projectId, workflowRunId, productId, input });
      const existing = await transaction.effectPromptRun.findUnique({
        where: { projectId_idempotencyKey: { projectId, idempotencyKey: input.idempotencyKey } },
        include: { result: true, stages: true },
      });
      if (existing)
        return existing.requestHash === requestHash
          ? { kind: 'REPLAYED' as const, run: existing }
          : { kind: 'KEY_CONFLICT' as const };

      await transaction.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "effect_import_products"
        WHERE "projectId" = ${projectId}::uuid
          AND "workflowRunId" = ${workflowRunId}::uuid
          AND "id" = ${productId}::uuid
          AND "status" = 'ACTIVE'
        FOR UPDATE
      `;
      const product = await transaction.effectImportProduct.findFirst({
        where: { projectId, workflowRunId, id: productId, status: 'ACTIVE' },
      });
      if (!product) return { kind: 'NOT_FOUND' as const };
      const workflowRun = await transaction.workflowRun.findFirst({
        where: {
          projectId,
          id: workflowRunId,
          workflow: 'EFFECT',
          workflowSpace: 'EFFECT',
          status: { in: ['ACTIVE', 'PAUSED'] },
        },
      });
      if (!workflowRun) return { kind: 'NOT_FOUND' as const };

      const nodeId = `PROMPT_GENERATION:${productId}`;
      const settingsNode = await transaction.workflowNodeState.findUnique({
        where: {
          projectId_workflowRunId_nodeId: { projectId, workflowRunId, nodeId },
        },
      });
      if (!settingsNode || settingsNode.revision !== input.expectedSettingsRevision)
        return { kind: 'SETTINGS_CONFLICT' as const };
      const legacySettings = settingsNode.schemaVersion < EFFECT_PROMPT_SCHEMA_VERSION;
      const settings = migrateEffectPromptSettings(settingsNode.state, settingsNode.schemaVersion);
      const settingsHash = workflowStateHash(settings);
      if (legacySettings) {
        await transaction.workflowNodeState.update({
          where: {
            projectId_workflowRunId_nodeId: { projectId, workflowRunId, nodeId },
          },
          data: {
            schemaVersion: EFFECT_PROMPT_SCHEMA_VERSION,
            revision: { increment: 1 },
            contentHash: settingsHash,
            executionInputHash: settingsHash,
            executionInputSchemaVersion: EFFECT_PROMPT_SCHEMA_VERSION,
            state: json(settings),
            savedAt: new Date(),
          },
        });
      }
      const insight = await transaction.workingArtifact.findFirst({
        where: {
          projectId,
          workflowRunId,
          nodeId: 'INFORMATION_EXTRACTION',
          artifactKey: `marketing-insight:${productId}`,
          freshness: 'CURRENT',
          availability: 'AVAILABLE',
        },
      });
      if (!insight?.payload) return { kind: 'INSIGHT_NOT_READY' as const };
      const latest = await transaction.effectPromptResult.findFirst({
        where: { projectId, workflowRunId, productId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      const parsedLatest = latest ? parseEffectPromptBatchResult(latest.draftResult) : null;
      const latestCurrent =
        latest?.schemaVersion === EFFECT_PROMPT_SCHEMA_VERSION && parsedLatest ? latest : null;
      const currentResult = latestCurrent ? parsedLatest : null;
      if (
        input.expectedResultRevision !== null &&
        latestCurrent?.revision !== input.expectedResultRevision
      )
        return { kind: 'RESULT_CONFLICT' as const };
      if (
        input.operation === 'BATCH_GENERATE' &&
        latestCurrent &&
        input.expectedResultRevision === null
      )
        return { kind: 'RESULT_CONFLICT' as const };
      if (input.operation === 'ITEM_REGENERATE') {
        if (!latestCurrent || input.expectedResultRevision === null || !input.targetItemId)
          return { kind: 'RESULT_CONFLICT' as const };
        if (!currentResult?.items.some((item) => item.id === input.targetItemId))
          return { kind: 'ITEM_NOT_FOUND' as const };
      }
      const targetItem = currentResult?.items.find(({ id }) => id === input.targetItemId);
      const targetItemIndex = currentResult?.items.findIndex(({ id }) => id === input.targetItemId);
      const manualItems = promptItemsRetainedForRun(
        currentResult,
        input.targetItemId,
        input.operation,
      );
      if (manualItems.length > effectPromptTargetCount(settings))
        return { kind: 'MANUAL_COUNT_EXCEEDED' as const };
      const snapshot: EffectPromptInputSnapshot = {
        schemaVersion: EFFECT_PROMPT_SCHEMA_VERSION,
        projectId,
        workflowRunId,
        productId,
        operation: input.operation,
        targetItemId: input.targetItemId,
        settings,
        insightArtifact: {
          id: insight.id,
          revision: insight.revision,
          contentHash: insight.contentHash,
          result: insight.payload,
        },
        retainedManualItems: manualItems,
        ...(input.operation === 'ITEM_REGENERATE' && targetItem
          ? { targetItem, targetItemIndex }
          : {}),
        baseResultRevision: latestCurrent?.revision ?? null,
      };
      const active = await transaction.effectPromptRun.findFirst({
        where: {
          projectId,
          workflowRunId,
          productId,
          status: { in: ['QUEUED', 'RUNNING'] },
        },
      });
      if (active) return { kind: 'ACTIVE_CONFLICT' as const };
      const sourceFingerprint = workflowStateHash({
        insight: snapshot.insightArtifact,
        settingsHash,
        retainedManualItems: manualItems,
      });
      const run = await transaction.effectPromptRun.create({
        data: {
          projectId,
          workflowRunId,
          productId,
          operation: input.operation,
          targetItemId: input.targetItemId,
          idempotencyKey: input.idempotencyKey,
          requestHash,
          sourceFingerprint,
          settingsHash,
          inputSnapshot: json(snapshot),
          warnings: json([]),
        },
        include: { result: true, stages: true },
      });
      await transaction.jobOutbox.create({
        data: {
          projectId,
          jobType: EFFECT_PROMPT_JOB_TYPE,
          aggregateId: run.id,
          routingKey: EFFECT_PROMPT_QUEUE,
          payload: json({
            schemaVersion: EFFECT_PROMPT_SCHEMA_VERSION,
            projectId,
            runId: run.id,
            requestId: run.id,
          }),
        },
      });
      return { kind: 'CREATED' as const, run };
    });
  }

  async claim(projectId: string, runId: string, now = new Date()) {
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "effect_prompt_runs"
        WHERE "projectId" = ${projectId}::uuid AND "id" = ${runId}::uuid
        FOR UPDATE
      `;
      const run = await transaction.effectPromptRun.findFirst({ where: { projectId, id: runId } });
      if (!run) return { kind: 'NOT_FOUND' as const };
      if (run.status === 'COMPLETED' || run.status === 'FAILED')
        return { kind: 'TERMINAL' as const };
      if (run.status === 'RUNNING' && run.leaseExpiresAt && run.leaseExpiresAt > now)
        return { kind: 'BUSY' as const };
      if (run.attemptCount >= 3) {
        await transaction.effectPromptRun.update({
          where: { projectId_id: { projectId, id: runId } },
          data: {
            status: 'FAILED',
            errorCode: 'ATTEMPTS_EXHAUSTED',
            errorMessage: 'Prompt 生成任务已达到最大重试次数',
            completedAt: now,
            attemptToken: null,
            leaseExpiresAt: null,
          },
        });
        return { kind: 'ATTEMPTS_EXHAUSTED' as const };
      }
      const attemptToken = randomUUID();
      const claimed = await transaction.effectPromptRun.update({
        where: { projectId_id: { projectId, id: runId } },
        data: {
          status: 'RUNNING',
          progress: Math.max(1, run.progress),
          currentNode: 'LOAD_AND_SNAPSHOT',
          attemptCount: { increment: 1 },
          attemptToken,
          leaseExpiresAt: leaseDate(now),
          heartbeatAt: now,
          startedAt: run.startedAt ?? now,
          errorCode: null,
          errorMessage: null,
        },
      });
      return {
        kind: 'CLAIMED' as const,
        run: claimed,
        attemptToken,
        input: claimed.inputSnapshot as EffectPromptInputSnapshot,
      };
    });
  }

  heartbeat(projectId: string, runId: string, attemptToken: string, now = new Date()) {
    return this.prisma.effectPromptRun.updateMany({
      where: {
        projectId,
        id: runId,
        status: 'RUNNING',
        attemptToken,
        leaseExpiresAt: { gt: now },
      },
      data: { heartbeatAt: now, leaseExpiresAt: leaseDate(now) },
    });
  }

  async saveStage(
    projectId: string,
    runId: string,
    attemptToken: string,
    nodeId: string,
    input: EffectPromptStageInput,
    progress: number,
    now = new Date(),
  ): Promise<boolean> {
    return this.prisma.$transaction(async (transaction) => {
      const renewed = await transaction.effectPromptRun.updateMany({
        where: {
          projectId,
          id: runId,
          status: 'RUNNING',
          attemptToken,
          leaseExpiresAt: { gt: now },
        },
        data: {
          currentNode: nodeId,
          progress,
          heartbeatAt: now,
          leaseExpiresAt: leaseDate(now),
        },
      });
      if (renewed.count !== 1) return false;
      await transaction.effectPromptStageOutput.upsert({
        where: { projectId_runId_nodeId: { projectId, runId, nodeId } },
        create: {
          projectId,
          runId,
          nodeId,
          status: input.status,
          summary: input.summary,
          warnings: json(input.warnings),
          metadata: json(input.metadata ?? {}),
          startedAt: now,
          completedAt: ['PENDING', 'RUNNING'].includes(input.status) ? null : now,
        },
        update: {
          status: input.status,
          summary: input.summary,
          warnings: json(input.warnings),
          metadata: json(input.metadata ?? {}),
          completedAt: ['PENDING', 'RUNNING'].includes(input.status) ? null : now,
        },
      });
      return true;
    });
  }

  async saveShard(
    projectId: string,
    runId: string,
    attemptToken: string,
    round: number,
    shardIndex: number,
    input: EffectPromptShardInput,
    now = new Date(),
  ): Promise<boolean> {
    return this.prisma.$transaction(async (transaction) => {
      const renewed = await transaction.effectPromptRun.updateMany({
        where: {
          projectId,
          id: runId,
          status: 'RUNNING',
          attemptToken,
          leaseExpiresAt: { gt: now },
        },
        data: { heartbeatAt: now, leaseExpiresAt: leaseDate(now) },
      });
      if (renewed.count !== 1) return false;
      await transaction.effectPromptShardOutput.upsert({
        where: {
          projectId_runId_round_shardIndex: { projectId, runId, round, shardIndex },
        },
        create: {
          projectId,
          runId,
          round,
          shardIndex,
          status: input.status,
          combinationPlan: json(input.combinationPlan ?? []),
          items: json(input.items ?? []),
          warnings: json(input.warnings),
          errorCode: input.errorCode ?? null,
          errorMessage: input.errorMessage ?? null,
          startedAt: now,
          completedAt: ['PENDING', 'RUNNING'].includes(input.status) ? null : now,
        },
        update: {
          status: input.status,
          combinationPlan: json(input.combinationPlan ?? []),
          items: json(input.items ?? []),
          warnings: json(input.warnings),
          errorCode: input.errorCode ?? null,
          errorMessage: input.errorMessage ?? null,
          completedAt: ['PENDING', 'RUNNING'].includes(input.status) ? null : now,
        },
      });
      return true;
    });
  }

  async shards(projectId: string, runId: string, attemptToken: string, now = new Date()) {
    const authorized = await this.prisma.effectPromptRun.count({
      where: {
        projectId,
        id: runId,
        status: 'RUNNING',
        attemptToken,
        leaseExpiresAt: { gt: now },
      },
    });
    if (authorized !== 1) return null;
    return this.prisma.effectPromptShardOutput.findMany({
      where: { projectId, runId },
      orderBy: [{ round: 'asc' }, { shardIndex: 'asc' }],
    });
  }

  async complete(
    projectId: string,
    runId: string,
    attemptToken: string,
    candidate: EffectPromptBatchResult,
    now = new Date(),
  ) {
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "effect_prompt_runs"
        WHERE "projectId" = ${projectId}::uuid AND "id" = ${runId}::uuid
        FOR UPDATE
      `;
      const run = await transaction.effectPromptRun.findFirst({
        where: { projectId, id: runId },
        include: { result: true },
      });
      if (!run) return { kind: 'NOT_FOUND' as const };
      if (run.status === 'COMPLETED' && run.result)
        return { kind: 'COMPLETED' as const, result: run.result };
      if (
        run.status !== 'RUNNING' ||
        run.attemptToken !== attemptToken ||
        !run.leaseExpiresAt ||
        run.leaseExpiresAt <= now
      )
        return { kind: 'LEASE_CONFLICT' as const };
      const snapshot = run.inputSnapshot as EffectPromptInputSnapshot;
      const generated = recomputePromptQuality(
        candidate.items,
        snapshot.settings,
        candidate.metrics,
      );
      const draft = recomputePromptQuality(
        mergeEffectPromptCompletionItems(generated.items, snapshot),
        snapshot.settings,
        generated.metrics,
      );
      let overrides = emptyManualOverrides();
      if (snapshot.operation === 'ITEM_REGENERATE' && snapshot.baseResultRevision !== null) {
        const previous = await transaction.effectPromptResult.findFirst({
          where: {
            projectId,
            workflowRunId: run.workflowRunId,
            productId: run.productId,
            revision: snapshot.baseResultRevision,
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        });
        overrides = parseOverrides(previous?.manualOverrides);
        if (snapshot.targetItemId) {
          delete overrides.edited[snapshot.targetItemId];
          overrides.added = overrides.added.filter(({ id }) => id !== snapshot.targetItemId);
          overrides.deleted = overrides.deleted.filter((id) => id !== snapshot.targetItemId);
        }
      } else {
        for (const item of snapshot.retainedManualItems) {
          if (item.origin === 'MANUAL') overrides.added.push(item);
          else
            overrides.edited[item.id] = {
              content: item.content,
              fragmentType: item.fragmentType,
              materialTags: item.materialTags,
              targetDurationSeconds: item.targetDurationSeconds,
              dimensions: item.dimensions,
            };
        }
      }
      const result = await transaction.effectPromptResult.create({
        data: {
          projectId,
          workflowRunId: run.workflowRunId,
          productId: run.productId,
          runId,
          schemaVersion: EFFECT_PROMPT_SCHEMA_VERSION,
          generatedResult: json(generated),
          draftResult: json(draft),
          manualOverrides: json(overrides),
          qualityStatus: draft.qualityStatus,
          sourceFingerprint: run.sourceFingerprint,
          settingsHash: run.settingsHash,
        },
      });
      const replenish = await transaction.effectPromptStageOutput.findUnique({
        where: {
          projectId_runId_nodeId: { projectId, runId, nodeId: 'REPLENISH' },
        },
      });
      if (!replenish)
        await transaction.effectPromptStageOutput.create({
          data: {
            projectId,
            runId,
            nodeId: 'REPLENISH',
            status: 'SKIPPED',
            summary: '本次生成无需自动补齐',
            warnings: json([]),
            metadata: json({ replenishmentRound: draft.metrics.replenishmentRounds }),
            startedAt: now,
            completedAt: now,
          },
        });
      await transaction.effectPromptStageOutput.upsert({
        where: {
          projectId_runId_nodeId: { projectId, runId, nodeId: 'RESULT_SAVE' },
        },
        create: {
          projectId,
          runId,
          nodeId: 'RESULT_SAVE',
          status: 'SUCCEEDED',
          summary: 'Prompt 批次结果已保存',
          warnings: json([]),
          metadata: json({
            batchSize: draft.metrics.acceptedCount,
            qualityStatus: draft.qualityStatus,
          }),
          startedAt: now,
          completedAt: now,
        },
        update: {
          status: 'SUCCEEDED',
          summary: 'Prompt 批次结果已保存',
          metadata: json({
            batchSize: draft.metrics.acceptedCount,
            qualityStatus: draft.qualityStatus,
          }),
          errorMessage: null,
          completedAt: now,
        },
      });
      await transaction.effectPromptRun.update({
        where: { projectId_id: { projectId, id: runId } },
        data: {
          status: 'COMPLETED',
          progress: 100,
          currentNode: 'COMPLETED',
          attemptToken: null,
          leaseExpiresAt: null,
          heartbeatAt: now,
          completedAt: now,
          errorCode: null,
          errorMessage: null,
        },
      });
      return { kind: 'COMPLETED' as const, result };
    });
  }

  async fail(
    projectId: string,
    runId: string,
    attemptToken: string,
    input: { errorCode: string; errorMessage: string; retryable: boolean; warnings: string[] },
    now = new Date(),
  ) {
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "effect_prompt_runs"
        WHERE "projectId" = ${projectId}::uuid AND "id" = ${runId}::uuid
        FOR UPDATE
      `;
      const run = await transaction.effectPromptRun.findFirst({ where: { projectId, id: runId } });
      if (!run) return 'NOT_FOUND' as const;
      if (
        run.status !== 'RUNNING' ||
        run.attemptToken !== attemptToken ||
        !run.leaseExpiresAt ||
        run.leaseExpiresAt <= now
      )
        return 'LEASE_CONFLICT' as const;
      const retry = input.retryable && run.attemptCount < 3;
      await transaction.effectPromptRun.update({
        where: { projectId_id: { projectId, id: runId } },
        data: {
          status: retry ? 'QUEUED' : 'FAILED',
          warnings: json(input.warnings),
          errorCode: input.errorCode,
          errorMessage: input.errorMessage,
          attemptToken: null,
          leaseExpiresAt: null,
          heartbeatAt: now,
          completedAt: retry ? null : now,
        },
      });
      if (retry)
        await transaction.jobOutbox.updateMany({
          where: { projectId, jobType: EFFECT_PROMPT_JOB_TYPE, aggregateId: runId },
          data: {
            status: 'PENDING',
            dispatchToken: null,
            nextAttemptAt: now,
            publishedAt: null,
            lastError: null,
          },
        });
      return retry ? ('REQUEUED' as const) : ('FAILED' as const);
    });
  }

  async mutateResult(
    projectId: string,
    resultId: string,
    expectedRevision: number,
    mutation:
      | { kind: 'ADD'; item: EffectPromptItem }
      | {
          kind: 'UPDATE';
          itemId: string;
          item: Pick<
            EffectPromptItem,
            'content' | 'fragmentType' | 'materialTags' | 'targetDurationSeconds' | 'dimensions'
          >;
        }
      | { kind: 'DELETE'; itemId: string },
  ) {
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "effect_prompt_results"
        WHERE "projectId" = ${projectId}::uuid AND "id" = ${resultId}::uuid
        FOR UPDATE
      `;
      const existing = await transaction.effectPromptResult.findFirst({
        where: { projectId, id: resultId },
      });
      if (!existing) return { kind: 'NOT_FOUND' as const };
      if (existing.revision !== expectedRevision) return { kind: 'REVISION_CONFLICT' as const };
      const current = parseEffectPromptBatchResult(existing.draftResult);
      if (!current) return { kind: 'INVALID_RESULT' as const };
      const overrides = parseOverrides(existing.manualOverrides);
      const items = [...current.items];
      if (mutation.kind === 'ADD') {
        if (items.some(({ id }) => id === mutation.item.id))
          return { kind: 'ITEM_CONFLICT' as const };
        items.push(mutation.item);
        overrides.added.push(mutation.item);
      } else {
        const index = items.findIndex(({ id }) => id === mutation.itemId);
        if (index < 0) return { kind: 'ITEM_NOT_FOUND' as const };
        const previous = items[index]!;
        if (mutation.kind === 'DELETE') {
          items.splice(index, 1);
          overrides.added = overrides.added.filter(({ id }) => id !== mutation.itemId);
          delete overrides.edited[mutation.itemId];
          if (previous.origin === 'AI' && !overrides.deleted.includes(mutation.itemId))
            overrides.deleted.push(mutation.itemId);
        } else {
          const updated: EffectPromptItem = {
            ...previous,
            ...mutation.item,
            manualEdited: true,
            updatedAt: new Date().toISOString(),
          };
          items[index] = updated;
          if (previous.origin === 'MANUAL')
            overrides.added = overrides.added.map((item) =>
              item.id === mutation.itemId ? updated : item,
            );
          else overrides.edited[mutation.itemId] = mutation.item;
        }
      }
      const next = recomputePromptQuality(items, current.settings, current.metrics);
      if (workflowStateHash(next) === workflowStateHash(current))
        return { kind: 'UNCHANGED' as const, result: existing, draft: current };
      const updated = await transaction.effectPromptResult.update({
        where: { projectId_id: { projectId, id: resultId } },
        data: {
          draftResult: json(next),
          manualOverrides: json(overrides),
          qualityStatus: next.qualityStatus,
          revision: { increment: 1 },
          savedAt: new Date(),
        },
      });
      return { kind: 'UPDATED' as const, result: updated, draft: next };
    });
  }

  async commitValidatedResult(
    projectId: string,
    resultId: string,
    expectedRevision: number,
    artifactInput: WorkingArtifactUpsertInput,
  ) {
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "effect_prompt_results"
        WHERE "projectId" = ${projectId}::uuid AND "id" = ${resultId}::uuid
        FOR UPDATE
      `;
      const result = await transaction.effectPromptResult.findFirst({
        where: { projectId, id: resultId },
        include: { run: true },
      });
      if (!result) return { kind: 'NOT_FOUND' as const };
      if (result.revision !== expectedRevision) return { kind: 'REVISION_CONFLICT' as const };
      const latest = await transaction.effectPromptRun.findFirst({
        where: {
          projectId,
          workflowRunId: result.workflowRunId,
          productId: result.productId,
          status: 'COMPLETED',
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      if (!latest || latest.id !== result.runId || latest.status !== 'COMPLETED')
        return { kind: 'NOT_READY' as const };
      const snapshot = result.run.inputSnapshot as EffectPromptInputSnapshot;
      const insight = await transaction.workingArtifact.findFirst({
        where: {
          projectId,
          workflowRunId: result.workflowRunId,
          id: snapshot.insightArtifact.id,
          nodeId: 'INFORMATION_EXTRACTION',
          artifactKey: `marketing-insight:${result.productId}`,
          revision: snapshot.insightArtifact.revision,
          contentHash: snapshot.insightArtifact.contentHash,
          freshness: 'CURRENT',
          availability: 'AVAILABLE',
        },
      });
      const settingsNode = await transaction.workflowNodeState.findUnique({
        where: {
          projectId_workflowRunId_nodeId: {
            projectId,
            workflowRunId: result.workflowRunId,
            nodeId: `PROMPT_GENERATION:${result.productId}`,
          },
        },
      });
      if (!insight || settingsNode?.executionInputHash !== result.settingsHash)
        return { kind: 'DEPENDENCY_CONFLICT' as const };
      if (!this.workingRepository) throw new Error('WORKFLOW_WORKING_REPOSITORY_NOT_AVAILABLE');
      const [committed] = await this.workingRepository.commitValidatedArtifactsInTransaction(
        transaction,
        projectId,
        result.workflowRunId,
        'PROMPT_GENERATION',
        [{ artifactKey: `prompt-batch:${result.productId}`, input: artifactInput }],
      );
      if (!committed) throw new Error('WORKING_ARTIFACT_COMMIT_FAILED');
      await transaction.effectPromptResult.update({
        where: { projectId_id: { projectId, id: resultId } },
        data: { savedAt: new Date() },
      });
      return {
        kind: 'COMMITTED' as const,
        artifact: {
          artifactId: committed.record.id,
          artifactKey: `prompt-batch:${result.productId}`,
          revision: committed.record.revision,
          unchanged: committed.unchanged,
        },
      };
    });
  }

  publicWarnings(value: unknown): string[] {
    return [
      ...new Set(
        parseStrings(value)
          .map((item) => item.trim())
          .filter(Boolean),
      ),
    ];
  }
}
