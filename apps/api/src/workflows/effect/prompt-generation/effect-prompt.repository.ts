import { randomUUID } from 'node:crypto';

import type {
  EffectPromptBatchResult,
  EffectPromptDimensions,
  EffectPromptItem,
  EffectPromptManualOverrides,
  EffectPromptOperation,
  EffectPromptRegenerationMode,
  EffectPromptRegenerationReason,
  EffectPromptDimensionKey,
  EffectPromptShardPhase,
  EffectPromptSharedPrompt,
} from '@ai-marketing/contracts';
import {
  EFFECT_PROMPT_MAX_RUN_ATTEMPTS,
  effectPromptTargetCount,
  readEffectPromptSettings,
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
  parseEffectPromptSemanticAudit,
  pendingEffectPromptSemanticEvaluation,
  recomputePromptQuality,
  semanticEvaluationAfterDeletion,
} from './effect-prompt.quality';
import {
  emptyManualOverrides,
  type EffectPromptInputSnapshot,
  type EffectPromptShardInput,
  type EffectPromptStageInput,
} from './effect-prompt.types';

const AI_RESPONSE_INVALID_RETRY_LEDGER_NODE = 'INTERNAL_AI_RESPONSE_INVALID_RETRY';

const json = (value: unknown): Prisma.InputJsonValue => value as Prisma.InputJsonValue;
const jsonRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const stageMetadataWithPreservedCheckpoint = (
  previous: unknown,
  incoming: unknown,
): Record<string, unknown> => {
  const next = { ...(jsonRecord(incoming) ?? {}) };
  const checkpoint = jsonRecord(previous)?.checkpoint;
  if (!Object.prototype.hasOwnProperty.call(next, 'checkpoint') && checkpoint !== undefined)
    next.checkpoint = checkpoint;
  return next;
};
const leaseDate = (now: Date): Date => new Date(now.getTime() + 90_000);
const parseStrings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

type PersistedEffectPromptShardPhase = 'BLUEPRINT' | 'PROMPT';
const persistedShardPhase = (phase: EffectPromptShardPhase): PersistedEffectPromptShardPhase =>
  phase === 'CREATIVE' ? 'BLUEPRINT' : 'PROMPT';

export const isAllowedReplacementSellingPoint = (
  insight: unknown,
  target: Pick<EffectPromptItem, 'fragmentType' | 'dimensions'>,
  replacementSellingPoint: string,
): boolean => {
  const insightRecord =
    insight && typeof insight === 'object' && !Array.isArray(insight)
      ? (insight as Record<string, unknown>)
      : {};
  const readValues = (...keys: string[]): string[] =>
    keys.flatMap((key) => {
      const value = insightRecord[key];
      if (typeof value === 'string') return value.trim() ? [value.trim()] : [];
      return Array.isArray(value)
        ? value
            .filter((item): item is string => typeof item === 'string')
            .map((item) => item.trim())
            .filter(Boolean)
        : [];
    });
  const allowed = new Set<string>([
    target.dimensions.productRelation,
    ...readValues(
      'productName',
      'product_name',
      'productCategory',
      'product_category',
      'coreSellingPoints',
      'core_selling_points',
      'secondarySellingPoints',
      'secondary_selling_points',
      'corePainPoints',
      'core_pain_points',
      'usageScenarios',
      'usage_scenarios',
      'purchaseScenarios',
      'purchase_scenarios',
    ),
  ]);
  const normalized = replacementSellingPoint.normalize('NFC').trim();
  return [...allowed].some((value) => value.normalize('NFC').trim() === normalized);
};

const promptRunInclude = {
  stages: { orderBy: [{ createdAt: 'asc' as const }, { nodeId: 'asc' as const }] },
  result: true,
} satisfies Prisma.EffectPromptRunInclude;
export type EffectPromptRunRecord = Prisma.EffectPromptRunGetPayload<{
  include: typeof promptRunInclude;
}>;

const promptNodeDetailRunInclude = {
  ...promptRunInclude,
  shards: {
    orderBy: [{ phase: 'asc' as const }, { round: 'asc' as const }, { shardIndex: 'asc' as const }],
  },
} satisfies Prisma.EffectPromptRunInclude;
export type EffectPromptNodeDetailRunRecord = Prisma.EffectPromptRunGetPayload<{
  include: typeof promptNodeDetailRunInclude;
}>;
export type EffectPromptPreviewRunRecord = Prisma.EffectPromptRunGetPayload<{
  include: { shards: true };
}>;

const parseOverrides = (value: unknown): EffectPromptManualOverrides => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return emptyManualOverrides();
  const source = value as Partial<EffectPromptManualOverrides>;
  const withoutLegacyTags = <T>(entry: T): T => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
    return Object.fromEntries(Object.entries(entry).filter(([key]) => key !== 'materialTags')) as T;
  };
  const editedSource =
    source.edited && typeof source.edited === 'object' && !Array.isArray(source.edited)
      ? source.edited
      : {};
  return {
    edited: Object.fromEntries(
      Object.entries(editedSource).map(([id, item]) => [id, withoutLegacyTags(item)]),
    ),
    added: Array.isArray(source.added) ? source.added.map(withoutLegacyTags) : [],
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
      (operation === 'ITEM_REGENERATE' ||
        operation === 'ITEM_EVALUATE' ||
        item.origin === 'MANUAL' ||
        item.manualEdited),
  );

export type StartPromptRunInput = {
  operation: EffectPromptOperation;
  targetItemId: string | null;
  regenerationInstruction?: string | null;
  replacementDimensions?: EffectPromptDimensions | null;
  regenerationMode?: EffectPromptRegenerationMode | null;
  regenerationReasons?: EffectPromptRegenerationReason[];
  preservedDimensions?: EffectPromptDimensionKey[];
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

  latestFailedRunForPreview(projectId: string, workflowRunId: string, productId: string) {
    return this.prisma.effectPromptRun.findFirst({
      where: { projectId, workflowRunId, productId, status: 'FAILED' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: {
        shards: {
          where: { status: 'SUCCEEDED', phase: 'PROMPT' },
          orderBy: [{ round: 'asc' }, { shardIndex: 'asc' }],
        },
      },
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
      const settings = readEffectPromptSettings(settingsNode.state);
      if (!settings) return { kind: 'SETTINGS_CONFLICT' as const };
      const settingsHash = workflowStateHash(settings);
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
      const latestCurrent = latest && parsedLatest ? latest : null;
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
      if (input.operation === 'ITEM_REGENERATE' || input.operation === 'ITEM_EVALUATE') {
        if (!latestCurrent || input.expectedResultRevision === null || !input.targetItemId)
          return { kind: 'RESULT_CONFLICT' as const };
        if (!currentResult?.items.some((item) => item.id === input.targetItemId))
          return { kind: 'ITEM_NOT_FOUND' as const };
      }
      const targetItem = currentResult?.items.find(({ id }) => id === input.targetItemId);
      const targetItemIndex = currentResult?.items.findIndex(({ id }) => id === input.targetItemId);
      if (
        input.operation === 'ITEM_REGENERATE' &&
        targetItem &&
        input.replacementDimensions &&
        !isAllowedReplacementSellingPoint(
          insight.payload,
          targetItem,
          input.replacementDimensions.productRelation,
        )
      )
        return { kind: 'INVALID_SELLING_POINT' as const };
      const manualItems = promptItemsRetainedForRun(
        currentResult,
        input.targetItemId,
        input.operation,
      );
      if (manualItems.length > effectPromptTargetCount(settings))
        return { kind: 'MANUAL_COUNT_EXCEEDED' as const };
      const snapshot: EffectPromptInputSnapshot = {
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
        selectionPolicy: 'MMR_CONTENT',
        similarityAnchors: manualItems,
        sharedPrompt: currentResult?.sharedPrompt ?? null,
        ...((input.operation === 'ITEM_REGENERATE' || input.operation === 'ITEM_EVALUATE') &&
        targetItem
          ? {
              targetItem,
              targetItemIndex,
              replacementDimensions: input.replacementDimensions ?? undefined,
              regenerationInstruction: input.regenerationInstruction ?? null,
              regenerationMode: input.regenerationMode ?? 'AUTO_DIVERSE',
              regenerationReasons: [...new Set(input.regenerationReasons ?? [])],
              preservedDimensions: [
                ...new Set<EffectPromptDimensionKey>(
                  input.preservedDimensions ??
                    (input.regenerationMode && input.regenerationMode !== 'AUTO_DIVERSE'
                      ? ['productRelation']
                      : []),
                ),
              ],
            }
          : {}),
        baseResultId: latestCurrent?.id ?? null,
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
      if (active) {
        return { kind: 'ACTIVE_CONFLICT' as const };
      }
      const sourceFingerprint = workflowStateHash({
        insight: snapshot.insightArtifact,
        settingsHash,
        retainedManualItems: manualItems,
        selectionPolicy: snapshot.selectionPolicy,
        similarityAnchors: snapshot.similarityAnchors,
        sharedPrompt: snapshot.sharedPrompt,
        regeneration:
          snapshot.operation === 'ITEM_REGENERATE' || snapshot.operation === 'ITEM_EVALUATE'
            ? {
                targetItem: snapshot.targetItem,
                targetItemIndex: snapshot.targetItemIndex,
                replacementDimensions: snapshot.replacementDimensions,
                regenerationInstruction: snapshot.regenerationInstruction,
              }
            : null,
      });
      const run = await transaction.effectPromptRun.create({
        data: {
          projectId,
          workflowRunId,
          productId,
          operation: input.operation === 'ITEM_EVALUATE' ? 'ITEM_REGENERATE' : input.operation,
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
      if (run.attemptCount >= EFFECT_PROMPT_MAX_RUN_ATTEMPTS) {
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
      const checkpointStages = await transaction.effectPromptStageOutput.findMany({
        where: {
          projectId,
          runId,
          status: 'SUCCEEDED',
          nodeId: {
            in: ['FACT_VISUAL_STRATEGY_COMPILATION', 'COHERENT_CREATIVE_GENERATION'],
          },
        },
        select: { nodeId: true, metadata: true },
      });
      return {
        kind: 'CLAIMED' as const,
        run: claimed,
        attemptToken,
        input: claimed.inputSnapshot as EffectPromptInputSnapshot,
        checkpointStages,
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
      const activeLease = {
        projectId,
        id: runId,
        status: 'RUNNING' as const,
        attemptToken,
        leaseExpiresAt: { gt: now },
      };
      let renewed = await transaction.effectPromptRun.updateMany({
        where: { ...activeLease, progress: { lte: progress } },
        data: {
          currentNode: nodeId,
          progress,
          heartbeatAt: now,
          leaseExpiresAt: leaseDate(now),
        },
      });
      if (renewed.count !== 1) {
        renewed = await transaction.effectPromptRun.updateMany({
          where: activeLease,
          data: {
            currentNode: nodeId,
            heartbeatAt: now,
            leaseExpiresAt: leaseDate(now),
          },
        });
      }
      if (renewed.count !== 1) return false;
      const previousStage = await transaction.effectPromptStageOutput.findUnique({
        where: { projectId_runId_nodeId: { projectId, runId, nodeId } },
        select: { metadata: true },
      });
      const metadata = stageMetadataWithPreservedCheckpoint(
        previousStage?.metadata,
        input.metadata,
      );
      await transaction.effectPromptStageOutput.upsert({
        where: { projectId_runId_nodeId: { projectId, runId, nodeId } },
        create: {
          projectId,
          runId,
          nodeId,
          status: input.status,
          summary: input.summary,
          warnings: json(input.warnings),
          metadata: json(metadata),
          startedAt: now,
          completedAt: ['PENDING', 'RUNNING'].includes(input.status) ? null : now,
        },
        update: {
          status: input.status,
          summary: input.summary,
          warnings: json(input.warnings),
          metadata: json(metadata),
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
    phase: EffectPromptShardPhase,
    input: EffectPromptShardInput,
    now = new Date(),
  ): Promise<boolean> {
    return this.prisma.$transaction(async (transaction) => {
      const storagePhase = persistedShardPhase(phase);
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
      const plan = phase === 'CREATIVE' ? input.creativePlan : input.classificationPlan;
      const items = phase === 'CREATIVE' ? input.creativeItems : input.evaluations;
      await transaction.effectPromptShardOutput.upsert({
        where: {
          projectId_runId_phase_round_shardIndex: {
            projectId,
            runId,
            phase: storagePhase,
            round,
            shardIndex,
          },
        },
        create: {
          projectId,
          runId,
          phase: storagePhase,
          round,
          shardIndex,
          status: input.status,
          combinationPlan: json(plan ?? []),
          items: json(items ?? []),
          warnings: json(input.warnings),
          errorCode: input.errorCode ?? null,
          errorMessage: input.errorMessage ?? null,
          startedAt: now,
          completedAt: ['PENDING', 'RUNNING'].includes(input.status) ? null : now,
        },
        update: {
          status: input.status,
          combinationPlan: json(plan ?? []),
          items: json(items ?? []),
          warnings: json(input.warnings),
          errorCode: input.errorCode ?? null,
          errorMessage: input.errorMessage ?? null,
          completedAt: ['PENDING', 'RUNNING'].includes(input.status) ? null : now,
        },
      });
      return true;
    });
  }

  async shards(
    projectId: string,
    runId: string,
    attemptToken: string,
    phase?: EffectPromptShardPhase,
    now = new Date(),
  ) {
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
      where: { projectId, runId, ...(phase ? { phase: persistedShardPhase(phase) } : {}) },
      orderBy: [{ phase: 'asc' }, { round: 'asc' }, { shardIndex: 'asc' }],
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
        include: { result: true, stages: true },
      });
      if (!run) return { kind: 'NOT_FOUND' as const };
      if (run.status === 'COMPLETED' && run.result)
        return { kind: 'COMPLETED' as const, result: run.result };
      const snapshot = run.inputSnapshot as EffectPromptInputSnapshot;
      if (run.status === 'COMPLETED' && snapshot.operation === 'ITEM_REGENERATE')
        return { kind: 'PREVIEW_COMPLETED' as const, result: null };
      if (
        run.status !== 'RUNNING' ||
        run.attemptToken !== attemptToken ||
        !run.leaseExpiresAt ||
        run.leaseExpiresAt <= now
      )
        return { kind: 'LEASE_CONFLICT' as const };
      const generated = recomputePromptQuality(
        candidate.items,
        snapshot.settings,
        candidate.metrics,
        candidate.renderProfile,
        candidate.sharedPrompt,
      );
      if (snapshot.operation === 'ITEM_REGENERATE') {
        if (
          generated.items.length !== 3 ||
          generated.items.some((item) => item.classificationStatus !== 'VERIFIED')
        )
          return { kind: 'INVALID_REGENERATION_PREVIEW' as const };
        const currentStage = run.stages.find(({ nodeId }) => nodeId === 'RESULT_SAVE');
        const currentMetadata = jsonRecord(currentStage?.metadata) ?? {};
        await transaction.effectPromptStageOutput.upsert({
          where: {
            projectId_runId_nodeId: { projectId, runId, nodeId: 'RESULT_SAVE' },
          },
          create: {
            projectId,
            runId,
            nodeId: 'RESULT_SAVE',
            status: 'SUCCEEDED',
            summary: '已生成 3 个单条 Prompt 备选',
            warnings: json([]),
            metadata: json({
              ...currentMetadata,
              regenerationPreviewResult: generated,
              appliedCandidateId: null,
              regenerationUndone: false,
            }),
            startedAt: now,
            completedAt: now,
          },
          update: {
            status: 'SUCCEEDED',
            summary: '已生成 3 个单条 Prompt 备选',
            metadata: json({
              ...currentMetadata,
              regenerationPreviewResult: generated,
              appliedCandidateId: null,
              regenerationUndone: false,
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
        return { kind: 'PREVIEW_COMPLETED' as const, result: null };
      }
      const draft = recomputePromptQuality(
        mergeEffectPromptCompletionItems(generated.items, snapshot),
        snapshot.settings,
        generated.metrics,
        generated.renderProfile,
        generated.sharedPrompt,
      );
      const resultSaveStage = await transaction.effectPromptStageOutput.findUnique({
        where: {
          projectId_runId_nodeId: { projectId, runId, nodeId: 'RESULT_SAVE' },
        },
      });
      const resultSaveMetadata = jsonRecord(resultSaveStage?.metadata);
      const rawSemanticAudit = resultSaveMetadata?.semanticAudit;
      const semanticAudit =
        rawSemanticAudit === undefined || rawSemanticAudit === null
          ? null
          : parseEffectPromptSemanticAudit(rawSemanticAudit, draft.items);
      if (rawSemanticAudit !== undefined && rawSemanticAudit !== null && !semanticAudit)
        return { kind: 'INVALID_SEMANTIC_AUDIT' as const };
      let overrides = emptyManualOverrides();
      if (snapshot.operation === 'ITEM_EVALUATE' && snapshot.baseResultRevision !== null) {
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
          if (snapshot.operation === 'ITEM_EVALUATE') {
            const evaluated = draft.items.find(({ id }) => id === snapshot.targetItemId);
            if (evaluated?.origin === 'MANUAL') overrides.added.push(evaluated);
            else if (evaluated?.manualEdited)
              overrides.edited[evaluated.id] = {
                content: evaluated.content,
                fragmentType: evaluated.fragmentType,
                primaryPurpose: evaluated.primaryPurpose,
                compatiblePurposes: [...evaluated.compatiblePurposes],
                classificationStatus: evaluated.classificationStatus,
                reviewIssues: [...(evaluated.reviewIssues ?? [])],
                productRelevance: evaluated.productRelevance,
                targetDurationSeconds: evaluated.targetDurationSeconds,
                creativeCore: evaluated.creativeCore,
                dimensions: evaluated.dimensions,
              };
          }
        }
      } else {
        for (const item of snapshot.retainedManualItems) {
          if (item.origin === 'MANUAL') overrides.added.push(item);
          else
            overrides.edited[item.id] = {
              content: item.content,
              fragmentType: item.fragmentType,
              primaryPurpose: item.primaryPurpose,
              compatiblePurposes: item.compatiblePurposes,
              classificationStatus: item.classificationStatus,
              reviewIssues: [...(item.reviewIssues ?? [])],
              productRelevance: item.productRelevance,
              targetDurationSeconds: item.targetDurationSeconds,
              creativeCore: item.creativeCore,
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
          generatedResult: json(generated),
          draftResult: json(draft),
          manualOverrides: json(overrides),
          qualityStatus: draft.qualityStatus,
          sourceFingerprint: run.sourceFingerprint,
          settingsHash: run.settingsHash,
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
            ...(semanticAudit ? { semanticAudit } : {}),
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
            ...(semanticAudit ? { semanticAudit } : {}),
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

  async applyRegenerationCandidate(
    projectId: string,
    resultId: string,
    runId: string,
    candidateId: string,
    expectedRevision: number,
    idempotencyKey: string,
  ) {
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "effect_prompt_results"
        WHERE "projectId" = ${projectId}::uuid AND "id" = ${resultId}::uuid
        FOR UPDATE
      `;
      const [existing, run] = await Promise.all([
        transaction.effectPromptResult.findFirst({ where: { projectId, id: resultId } }),
        transaction.effectPromptRun.findFirst({
          where: { projectId, id: runId },
          include: { stages: true },
        }),
      ]);
      if (!existing || !run) return { kind: 'NOT_FOUND' as const };
      const latest = await transaction.effectPromptResult.findFirst({
        where: {
          projectId,
          workflowRunId: existing.workflowRunId,
          productId: existing.productId,
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      const snapshot = run.inputSnapshot as EffectPromptInputSnapshot;
      if (
        run.status !== 'COMPLETED' ||
        snapshot.operation !== 'ITEM_REGENERATE' ||
        snapshot.baseResultId !== resultId ||
        latest?.id !== resultId ||
        !snapshot.targetItem ||
        snapshot.targetItemIndex === undefined
      )
        return { kind: 'PREVIEW_CONFLICT' as const };
      const stage = run.stages.find(({ nodeId }) => nodeId === 'RESULT_SAVE');
      const metadata = jsonRecord(stage?.metadata) ?? {};
      const applyHash = workflowStateHash({ idempotencyKey, candidateId });
      if (
        metadata.appliedCandidateId === candidateId &&
        metadata.applyHash === applyHash &&
        metadata.regenerationUndone !== true
      ) {
        const current = parseEffectPromptBatchResult(existing.draftResult);
        return current
          ? { kind: 'UNCHANGED' as const, result: existing, draft: current }
          : { kind: 'INVALID_RESULT' as const };
      }
      if (metadata.appliedCandidateId || metadata.regenerationUndone === true)
        return { kind: 'PREVIEW_CONFLICT' as const };
      if (
        existing.revision !== expectedRevision ||
        snapshot.baseResultRevision !== expectedRevision
      )
        return { kind: 'REVISION_CONFLICT' as const };
      const current = parseEffectPromptBatchResult(existing.draftResult);
      const preview = parseEffectPromptBatchResult(metadata.regenerationPreviewResult);
      if (!current || !preview) return { kind: 'INVALID_RESULT' as const };
      const candidate = preview.items.find(({ id }) => id === candidateId);
      const index = current.items.findIndex(({ id }) => id === snapshot.targetItem!.id);
      if (!candidate || index < 0 || candidate.classificationStatus !== 'VERIFIED')
        return { kind: 'CANDIDATE_NOT_FOUND' as const };
      const replacement: EffectPromptItem = {
        ...candidate,
        id: snapshot.targetItem.id,
        code: snapshot.targetItem.code,
        origin: 'AI',
        targetDurationSeconds: snapshot.targetItem.targetDurationSeconds,
        manualEdited: false,
        createdAt: snapshot.targetItem.createdAt,
        updatedAt: new Date().toISOString(),
      };
      const items = [...current.items];
      items[index] = replacement;
      const next = recomputePromptQuality(
        items,
        current.settings,
        current.metrics,
        current.renderProfile,
        current.sharedPrompt,
        pendingEffectPromptSemanticEvaluation(),
      );
      const overrides = parseOverrides(existing.manualOverrides);
      delete overrides.edited[snapshot.targetItem.id];
      overrides.added = overrides.added.filter(({ id }) => id !== snapshot.targetItem!.id);
      overrides.deleted = overrides.deleted.filter((id) => id !== snapshot.targetItem!.id);
      const updated = await transaction.effectPromptResult.update({
        where: { projectId_id: { projectId, id: resultId } },
        data: {
          runId,
          draftResult: json(next),
          manualOverrides: json(overrides),
          qualityStatus: next.qualityStatus,
          sourceFingerprint: run.sourceFingerprint,
          settingsHash: run.settingsHash,
          revision: { increment: 1 },
          savedAt: new Date(),
        },
      });
      await transaction.effectPromptStageOutput.update({
        where: { projectId_runId_nodeId: { projectId, runId, nodeId: 'RESULT_SAVE' } },
        data: {
          metadata: json({
            ...metadata,
            appliedCandidateId: candidateId,
            applyHash,
            appliedResultRevision: updated.revision,
            regenerationUndone: false,
          }),
        },
      });
      return { kind: 'UPDATED' as const, result: updated, draft: next };
    });
  }

  async undoRegenerationCandidate(
    projectId: string,
    resultId: string,
    runId: string,
    expectedRevision: number,
    idempotencyKey: string,
  ) {
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "effect_prompt_results"
        WHERE "projectId" = ${projectId}::uuid AND "id" = ${resultId}::uuid
        FOR UPDATE
      `;
      const [existing, run] = await Promise.all([
        transaction.effectPromptResult.findFirst({ where: { projectId, id: resultId } }),
        transaction.effectPromptRun.findFirst({
          where: { projectId, id: runId },
          include: { stages: true },
        }),
      ]);
      if (!existing || !run) return { kind: 'NOT_FOUND' as const };
      const snapshot = run.inputSnapshot as EffectPromptInputSnapshot;
      const stage = run.stages.find(({ nodeId }) => nodeId === 'RESULT_SAVE');
      const metadata = jsonRecord(stage?.metadata) ?? {};
      const undoHash = workflowStateHash({ idempotencyKey, runId });
      if (metadata.undoHash === undoHash && metadata.regenerationUndone === true) {
        const current = parseEffectPromptBatchResult(existing.draftResult);
        return current
          ? { kind: 'UNCHANGED' as const, result: existing, draft: current }
          : { kind: 'INVALID_RESULT' as const };
      }
      if (
        snapshot.operation !== 'ITEM_REGENERATE' ||
        snapshot.baseResultId !== resultId ||
        !snapshot.targetItem ||
        metadata.regenerationUndone === true ||
        typeof metadata.appliedCandidateId !== 'string' ||
        metadata.appliedResultRevision !== expectedRevision
      )
        return { kind: 'PREVIEW_CONFLICT' as const };
      if (existing.revision !== expectedRevision) return { kind: 'REVISION_CONFLICT' as const };
      const current = parseEffectPromptBatchResult(existing.draftResult);
      if (!current) return { kind: 'INVALID_RESULT' as const };
      const index = current.items.findIndex(({ id }) => id === snapshot.targetItem!.id);
      if (index < 0) return { kind: 'ITEM_NOT_FOUND' as const };
      const items = [...current.items];
      items[index] = snapshot.targetItem;
      const next = recomputePromptQuality(
        items,
        current.settings,
        current.metrics,
        current.renderProfile,
        current.sharedPrompt,
        pendingEffectPromptSemanticEvaluation(),
      );
      const overrides = parseOverrides(existing.manualOverrides);
      delete overrides.edited[snapshot.targetItem.id];
      overrides.added = overrides.added.filter(({ id }) => id !== snapshot.targetItem!.id);
      overrides.deleted = overrides.deleted.filter((id) => id !== snapshot.targetItem!.id);
      if (snapshot.targetItem.origin === 'MANUAL') overrides.added.push(snapshot.targetItem);
      else if (snapshot.targetItem.manualEdited)
        overrides.edited[snapshot.targetItem.id] = {
          content: snapshot.targetItem.content,
          fragmentType: snapshot.targetItem.fragmentType,
          primaryPurpose: snapshot.targetItem.primaryPurpose,
          compatiblePurposes: [...snapshot.targetItem.compatiblePurposes],
          classificationStatus: snapshot.targetItem.classificationStatus,
          reviewIssues: [...(snapshot.targetItem.reviewIssues ?? [])],
          productRelevance: snapshot.targetItem.productRelevance,
          targetDurationSeconds: snapshot.targetItem.targetDurationSeconds,
          creativeCore: snapshot.targetItem.creativeCore,
          dimensions: snapshot.targetItem.dimensions,
        };
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
      await transaction.effectPromptStageOutput.update({
        where: { projectId_runId_nodeId: { projectId, runId, nodeId: 'RESULT_SAVE' } },
        data: {
          metadata: json({
            ...metadata,
            undoHash,
            undoResultRevision: updated.revision,
            regenerationUndone: true,
          }),
        },
      });
      return { kind: 'UPDATED' as const, result: updated, draft: next };
    });
  }

  async fail(
    projectId: string,
    runId: string,
    attemptToken: string,
    input: {
      errorCode: string;
      errorMessage: string;
      retryable: boolean;
      warnings: string[];
      currentNode?: string | null;
    },
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
      const invalidRetryLedger =
        input.errorCode === 'AI_RESPONSE_INVALID'
          ? await transaction.effectPromptStageOutput.findUnique({
              where: {
                projectId_runId_nodeId: {
                  projectId,
                  runId,
                  nodeId: AI_RESPONSE_INVALID_RETRY_LEDGER_NODE,
                },
              },
              select: { metadata: true },
            })
          : null;
      const ledgerMetadata =
        invalidRetryLedger?.metadata &&
        typeof invalidRetryLedger.metadata === 'object' &&
        !Array.isArray(invalidRetryLedger.metadata)
          ? (invalidRetryLedger.metadata as Record<string, unknown>)
          : {};
      const invalidRetryCount =
        typeof ledgerMetadata.count === 'number' && Number.isSafeInteger(ledgerMetadata.count)
          ? ledgerMetadata.count
          : 0;
      const retry =
        input.retryable &&
        run.attemptCount < EFFECT_PROMPT_MAX_RUN_ATTEMPTS &&
        (input.errorCode !== 'AI_RESPONSE_INVALID' || invalidRetryCount < 1);
      const failedNode = input.currentNode ?? run.currentNode;
      const retryWarning =
        input.errorCode === 'AI_TIMEOUT'
          ? '上一次 Prompt AI 请求超时，任务已自动重新排队'
          : '上一次 Prompt 生成尝试失败，任务已自动重新排队';
      const warnings = [
        ...new Set([
          ...parseStrings(run.warnings),
          ...input.warnings,
          ...(retry ? [retryWarning] : []),
        ]),
      ];
      await transaction.effectPromptRun.update({
        where: { projectId_id: { projectId, id: runId } },
        data: {
          status: retry ? 'QUEUED' : 'FAILED',
          ...(!retry && failedNode ? { currentNode: failedNode } : {}),
          warnings: json(warnings),
          errorCode: input.errorCode,
          errorMessage: input.errorMessage,
          attemptToken: null,
          leaseExpiresAt: null,
          heartbeatAt: now,
          completedAt: retry ? null : now,
        },
      });
      if (retry && input.errorCode === 'AI_RESPONSE_INVALID')
        await transaction.effectPromptStageOutput.upsert({
          where: {
            projectId_runId_nodeId: {
              projectId,
              runId,
              nodeId: AI_RESPONSE_INVALID_RETRY_LEDGER_NODE,
            },
          },
          create: {
            projectId,
            runId,
            nodeId: AI_RESPONSE_INVALID_RETRY_LEDGER_NODE,
            status: 'SKIPPED',
            summary: '',
            warnings: json([]),
            metadata: json({ count: invalidRetryCount + 1 }),
            startedAt: now,
            completedAt: now,
          },
          update: {
            metadata: json({ count: invalidRetryCount + 1 }),
            completedAt: now,
          },
        });
      if (!retry) {
        await transaction.effectPromptStageOutput.updateMany({
          where: {
            projectId,
            runId,
            status: 'RUNNING',
            ...(failedNode ? { nodeId: { not: failedNode } } : {}),
          },
          data: {
            status: 'SKIPPED',
            summary: '任务已停止，该分支未完成',
            errorMessage: null,
            completedAt: now,
          },
        });
        await transaction.effectPromptShardOutput.updateMany({
          where: { projectId, runId, status: 'RUNNING' },
          data: {
            status: 'FAILED',
            errorCode: 'BATCH_ABORTED',
            errorMessage: '任务已停止，该分片未完成',
            completedAt: now,
          },
        });
      }
      if (!retry && failedNode)
        await transaction.effectPromptStageOutput.updateMany({
          where: { projectId, runId, nodeId: failedNode },
          data: {
            status: 'FAILED',
            summary: input.errorMessage,
            errorMessage: input.errorMessage,
            completedAt: now,
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

  async recoverExpiredLeases(now = new Date()): Promise<{ requeued: number; failed: number }> {
    const candidates = await this.prisma.effectPromptRun.findMany({
      where: { status: 'RUNNING', leaseExpiresAt: { lte: now } },
      select: { id: true, projectId: true },
      orderBy: { leaseExpiresAt: 'asc' },
      take: 50,
    });
    let requeued = 0;
    let failed = 0;
    for (const candidate of candidates) {
      const outcome = await this.prisma.$transaction(async (transaction) => {
        await transaction.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "effect_prompt_runs"
          WHERE "projectId" = ${candidate.projectId}::uuid
            AND "id" = ${candidate.id}::uuid
          FOR UPDATE
        `;
        const run = await transaction.effectPromptRun.findFirst({
          where: {
            projectId: candidate.projectId,
            id: candidate.id,
            status: 'RUNNING',
            leaseExpiresAt: { lte: now },
          },
        });
        if (!run) return 'UNCHANGED' as const;
        const warnings = [
          ...new Set([...parseStrings(run.warnings), 'Worker 连接中断，Prompt 任务已自动重新排队']),
        ];
        if (run.attemptCount >= EFFECT_PROMPT_MAX_RUN_ATTEMPTS) {
          await transaction.effectPromptRun.update({
            where: { projectId_id: { projectId: run.projectId, id: run.id } },
            data: {
              status: 'FAILED',
              warnings: json(parseStrings(run.warnings)),
              errorCode: 'WORKER_LEASE_EXPIRED',
              errorMessage: 'Worker 多次失联，Prompt 任务已终止',
              attemptToken: null,
              leaseExpiresAt: null,
              completedAt: now,
            },
          });
          return 'FAILED' as const;
        }
        await transaction.effectPromptRun.update({
          where: { projectId_id: { projectId: run.projectId, id: run.id } },
          data: {
            status: 'QUEUED',
            warnings: json(warnings),
            errorCode: 'WORKER_LEASE_EXPIRED',
            errorMessage: 'Worker 租约过期，Prompt 任务已重新排队',
            attemptToken: null,
            leaseExpiresAt: null,
            heartbeatAt: now,
          },
        });
        await transaction.jobOutbox.updateMany({
          where: {
            projectId: run.projectId,
            jobType: EFFECT_PROMPT_JOB_TYPE,
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
        return 'REQUEUED' as const;
      });
      if (outcome === 'REQUEUED') requeued += 1;
      if (outcome === 'FAILED') failed += 1;
    }
    return { requeued, failed };
  }

  async recoverStaleQueuedDispatches(now = new Date()): Promise<number> {
    const staleBefore = new Date(now.getTime() - 60_000);
    const candidates = await this.prisma.effectPromptRun.findMany({
      where: { status: 'QUEUED', updatedAt: { lte: staleBefore } },
      select: { id: true, projectId: true },
      orderBy: { updatedAt: 'asc' },
      take: 50,
    });
    let requeued = 0;
    for (const candidate of candidates) {
      const recovered = await this.prisma.$transaction(async (transaction) => {
        await transaction.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "effect_prompt_runs"
          WHERE "projectId" = ${candidate.projectId}::uuid
            AND "id" = ${candidate.id}::uuid
          FOR UPDATE
        `;
        const run = await transaction.effectPromptRun.findFirst({
          where: {
            projectId: candidate.projectId,
            id: candidate.id,
            status: 'QUEUED',
            updatedAt: { lte: staleBefore },
          },
        });
        if (!run) return false;
        const outbox = await transaction.jobOutbox.updateMany({
          where: {
            projectId: run.projectId,
            jobType: EFFECT_PROMPT_JOB_TYPE,
            aggregateId: run.id,
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
        if (outbox.count !== 1) return false;
        await transaction.effectPromptRun.update({
          where: { projectId_id: { projectId: run.projectId, id: run.id } },
          data: {
            warnings: json([
              ...new Set([
                ...parseStrings(run.warnings),
                'Prompt 任务消息未被 Worker 领取，系统已自动重新投递',
              ]),
            ]),
            errorCode: 'WORKER_CLAIM_TIMEOUT',
            errorMessage: 'Prompt 任务消息已自动重新投递',
          },
        });
        return true;
      });
      if (recovered) requeued += 1;
    }
    return requeued;
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
            | 'content'
            | 'fragmentType'
            | 'primaryPurpose'
            | 'compatiblePurposes'
            | 'classificationStatus'
            | 'productRelevance'
            | 'targetDurationSeconds'
            | 'creativeCore'
            | 'dimensions'
            | 'reviewIssues'
          >;
        }
      | { kind: 'DELETE'; itemId: string }
      | { kind: 'SHARED_PROMPT'; sharedPrompt: EffectPromptSharedPrompt },
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
      let semanticEvaluation = pendingEffectPromptSemanticEvaluation();
      let semanticContentUnchanged = mutation.kind === 'SHARED_PROMPT';
      if (mutation.kind === 'ADD') {
        if (items.some(({ id }) => id === mutation.item.id))
          return { kind: 'ITEM_CONFLICT' as const };
        items.push(mutation.item);
        overrides.added.push(mutation.item);
      } else if (mutation.kind !== 'SHARED_PROMPT') {
        const index = items.findIndex(({ id }) => id === mutation.itemId);
        if (index < 0) return { kind: 'ITEM_NOT_FOUND' as const };
        const previous = items[index]!;
        if (mutation.kind === 'DELETE') {
          items.splice(index, 1);
          overrides.added = overrides.added.filter(({ id }) => id !== mutation.itemId);
          delete overrides.edited[mutation.itemId];
          if (previous.origin === 'AI' && !overrides.deleted.includes(mutation.itemId))
            overrides.deleted.push(mutation.itemId);
          const resultSaveStage = await transaction.effectPromptStageOutput.findUnique({
            where: {
              projectId_runId_nodeId: {
                projectId,
                runId: existing.runId,
                nodeId: 'RESULT_SAVE',
              },
            },
          });
          const metadata = jsonRecord(resultSaveStage?.metadata);
          const audit = parseEffectPromptSemanticAudit(metadata?.semanticAudit, items, true);
          semanticEvaluation = audit
            ? semanticEvaluationAfterDeletion(items, audit)
            : pendingEffectPromptSemanticEvaluation();
        } else {
          const updated: EffectPromptItem = {
            ...previous,
            ...mutation.item,
            manualEdited: true,
            updatedAt: new Date().toISOString(),
          };
          semanticContentUnchanged = updated.content === previous.content;
          items[index] = updated;
          if (previous.origin === 'MANUAL')
            overrides.added = overrides.added.map((item) =>
              item.id === mutation.itemId ? updated : item,
            );
          else overrides.edited[mutation.itemId] = mutation.item;
        }
      }
      const next = recomputePromptQuality(
        items,
        current.settings,
        current.metrics,
        current.renderProfile,
        mutation.kind === 'SHARED_PROMPT' ? mutation.sharedPrompt : current.sharedPrompt,
        semanticContentUnchanged
          ? current.metrics.semanticEvaluation
          : mutation.kind === 'DELETE'
            ? semanticEvaluation
            : pendingEffectPromptSemanticEvaluation(),
      );
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
          result: { isNot: null },
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
