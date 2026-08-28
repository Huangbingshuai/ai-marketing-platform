import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_EFFECT_PROMPT_SETTINGS,
  EFFECT_PROMPT_SCHEMA_VERSION,
} from '@ai-marketing/contracts';

import type { PrismaService } from '../../../database/prisma.service';
import { workflowStateHash } from '../../../platform/workflow/workflow-state-hash';
import {
  EffectPromptRepository,
  isAllowedReplacementSellingPoint,
  promptItemsRetainedForRun,
  type StartPromptRunInput,
} from './effect-prompt.repository';
import { compileEffectPromptSharedPrompt, recomputePromptQuality } from './effect-prompt.quality';

const projectId = '00000000-0000-4000-8000-000000000001';
const workflowRunId = '00000000-0000-4000-8000-000000000002';
const productId = '00000000-0000-4000-8000-000000000003';
const runId = '00000000-0000-4000-8000-000000000004';
const input: StartPromptRunInput = {
  operation: 'BATCH_GENERATE',
  targetItemId: null,
  expectedSettingsRevision: 1,
  expectedResultRevision: null,
  idempotencyKey: 'generate-1',
};

const runRecord = (overrides: Record<string, unknown> = {}) => ({
  id: runId,
  projectId,
  workflowRunId,
  productId,
  operation: 'BATCH_GENERATE',
  targetItemId: null,
  idempotencyKey: input.idempotencyKey,
  requestHash: workflowStateHash({ projectId, workflowRunId, productId, input }),
  sourceFingerprint: 'f'.repeat(64),
  settingsHash: 's'.repeat(64),
  inputSnapshot: {},
  status: 'QUEUED',
  progress: 0,
  currentNode: null,
  warnings: [],
  errorCode: null,
  errorMessage: null,
  attemptCount: 0,
  attemptToken: null,
  leaseExpiresAt: null,
  startedAt: null,
  heartbeatAt: null,
  completedAt: null,
  createdAt: new Date('2026-08-25T00:00:00.000Z'),
  updatedAt: new Date('2026-08-25T00:00:00.000Z'),
  result: null,
  stages: [],
  ...overrides,
});

describe('EffectPromptRepository', () => {
  it('persists blueprint and prompt shards under phase-scoped unique keys', async () => {
    const upsert = vi.fn().mockResolvedValue({});
    const transaction = {
      effectPromptRun: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      effectPromptShardOutput: { upsert },
    };
    const repository = new EffectPromptRepository({
      $transaction: (callback: (client: typeof transaction) => unknown) => callback(transaction),
    } as unknown as PrismaService);
    const input = {
      status: 'SUCCEEDED' as const,
      combinationPlan: [],
      items: [],
      blueprintPlan: [{ slotId: 'blueprint-task-a' }],
      blueprints: [{ slotId: 'blueprint-a' }],
      creativePlan: [{ slotId: 'creative-task-a' }],
      creativeItems: [{ slotId: 'creative-a' }],
      classificationPlan: ['creative-a'],
      evaluations: [{ slotId: 'evaluation-a' }],
      warnings: [],
    };

    await repository.saveShard(projectId, runId, 'attempt-a', 0, 0, 'BLUEPRINT', input);
    await repository.saveShard(projectId, runId, 'attempt-a', 0, 0, 'PROMPT', input);
    await repository.saveShard(projectId, runId, 'attempt-a', 1, 0, 'CREATIVE', input);
    await repository.saveShard(projectId, runId, 'attempt-a', 1, 0, 'CLASSIFICATION', input);

    expect(upsert.mock.calls.map(([argument]) => argument.where)).toEqual([
      {
        projectId_runId_phase_round_shardIndex: {
          projectId,
          runId,
          phase: 'BLUEPRINT',
          round: 0,
          shardIndex: 0,
        },
      },
      {
        projectId_runId_phase_round_shardIndex: {
          projectId,
          runId,
          phase: 'PROMPT',
          round: 0,
          shardIndex: 0,
        },
      },
      {
        projectId_runId_phase_round_shardIndex: {
          projectId,
          runId,
          phase: 'BLUEPRINT',
          round: 1,
          shardIndex: 0,
        },
      },
      {
        projectId_runId_phase_round_shardIndex: {
          projectId,
          runId,
          phase: 'PROMPT',
          round: 1,
          shardIndex: 0,
        },
      },
    ]);
    expect(upsert.mock.calls[0]?.[0].create).toMatchObject({
      phase: 'BLUEPRINT',
      combinationPlan: input.blueprintPlan,
      items: input.blueprints,
    });
    expect(upsert.mock.calls[1]?.[0].create).toMatchObject({
      phase: 'PROMPT',
      combinationPlan: input.combinationPlan,
      items: input.items,
    });
    expect(upsert.mock.calls[2]?.[0].create).toMatchObject({
      phase: 'BLUEPRINT',
      combinationPlan: input.creativePlan,
      items: input.creativeItems,
    });
    expect(upsert.mock.calls[3]?.[0].create).toMatchObject({
      phase: 'PROMPT',
      combinationPlan: input.classificationPlan,
      items: input.evaluations,
    });
  });
  it('only allows confirmed selling points that match the locked fragment responsibility', () => {
    const insight = {
      coreSellingPoints: ['单手开合', '轻量便携'],
      secondarySellingPoints: ['易清洗'],
    };
    const target = {
      fragmentType: 'PRODUCT_DISPLAY' as const,
      dimensions: {
        narrative: '产品直观展示',
        scene: '通勤桌面',
        persona: '仅手部出镜',
        productRelation: '单手开合',
        camera: '近景缓慢推进',
        emotion: '明快自然',
      },
    };

    expect(isAllowedReplacementSellingPoint(insight, target, '轻量便携')).toBe(true);
    expect(isAllowedReplacementSellingPoint(insight, target, '易清洗')).toBe(true);
    expect(isAllowedReplacementSellingPoint(insight, target, '未确认功效')).toBe(false);
    expect(
      isAllowedReplacementSellingPoint(insight, { ...target, fragmentType: 'HOOK' }, '单手开合'),
    ).toBe(true);
    expect(
      isAllowedReplacementSellingPoint(insight, { ...target, fragmentType: 'HOOK' }, '轻量便携'),
    ).toBe(true);
  });

  it('retains every non-target item only for item regeneration', () => {
    const now = '2026-08-25T00:00:00.000Z';
    const items = ['one', 'target', 'three'].map((id, index) => ({
      id,
      code: id,
      origin: index === 2 ? ('MANUAL' as const) : ('AI' as const),
      fragmentType: 'HOOK' as const,
      primaryPurpose: 'HOOK' as const,
      compatiblePurposes: ['HOOK' as const],
      classificationStatus: 'VERIFIED' as const,
      productRelevance: 80,
      materialTags: ['钩子', id],
      targetDurationSeconds: 5,
      dimensions: {
        narrative: `叙事-${id}`,
        scene: `场景-${id}`,
        persona: `人物-${id}`,
        productRelation: `产品关联-${id}`,
        camera: `镜头-${id}`,
        emotion: `情绪-${id}`,
      },
      content: `内容-${id}`,
      insightBindings: [],
      manualEdited: index === 2,
      createdAt: now,
      updatedAt: now,
    }));
    const result = recomputePromptQuality(items, DEFAULT_EFFECT_PROMPT_SETTINGS);

    expect(
      promptItemsRetainedForRun(result, 'target', 'ITEM_REGENERATE').map(({ id }) => id),
    ).toEqual(['one', 'three']);
    expect(promptItemsRetainedForRun(result, null, 'BATCH_GENERATE').map(({ id }) => id)).toEqual([
      'three',
    ]);
  });
  it('scopes run lookup by project and run id', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const repository = new EffectPromptRepository({
      effectPromptRun: { findFirst },
    } as unknown as PrismaService);

    await repository.run('project-a', 'run-a');

    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { projectId: 'project-a', id: 'run-a' } }),
    );
  });

  it('replays the same request before acquiring a product lock', async () => {
    const queryRaw = vi.fn();
    const transaction = {
      effectPromptRun: { findUnique: vi.fn().mockResolvedValue(runRecord()) },
      $queryRaw: queryRaw,
    };
    const repository = new EffectPromptRepository({
      $transaction: (callback: (client: typeof transaction) => unknown) => callback(transaction),
    } as unknown as PrismaService);

    await expect(repository.startRun(projectId, workflowRunId, productId, input)).resolves.toEqual({
      kind: 'REPLAYED',
      run: runRecord(),
    });
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it('creates the run and minimal outbox message in one transaction', async () => {
    const created = runRecord();
    const outboxCreate = vi.fn().mockResolvedValue({});
    const transaction = {
      effectPromptRun: {
        findUnique: vi.fn().mockResolvedValue(null),
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue(created),
      },
      effectImportProduct: { findFirst: vi.fn().mockResolvedValue({ id: productId }) },
      workflowRun: { findFirst: vi.fn().mockResolvedValue({ id: workflowRunId }) },
      workflowNodeState: {
        findUnique: vi.fn().mockResolvedValue({
          revision: 1,
          state: DEFAULT_EFFECT_PROMPT_SETTINGS,
        }),
      },
      workingArtifact: {
        findFirst: vi.fn().mockResolvedValue({
          id: '00000000-0000-4000-8000-000000000005',
          revision: 1,
          contentHash: 'a'.repeat(64),
          payload: { productName: '产品' },
        }),
      },
      effectPromptResult: { findFirst: vi.fn().mockResolvedValue(null) },
      jobOutbox: { create: outboxCreate },
      $queryRaw: vi.fn().mockResolvedValue([{ id: productId }]),
    };
    const repository = new EffectPromptRepository({
      $transaction: (callback: (client: typeof transaction) => unknown) => callback(transaction),
    } as unknown as PrismaService);

    await expect(repository.startRun(projectId, workflowRunId, productId, input)).resolves.toEqual({
      kind: 'CREATED',
      run: created,
    });
    expect(outboxCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        projectId,
        aggregateId: runId,
        routingKey: 'effect.prompt-generation.requested',
        payload: {
          schemaVersion: EFFECT_PROMPT_SCHEMA_VERSION,
          projectId,
          runId,
          requestId: runId,
        },
      }),
    });
  });

  it('migrates V1 full-video settings to V4 six-fragment defaults before snapshotting', async () => {
    const created = runRecord();
    const nodeUpdate = vi.fn().mockResolvedValue({});
    const runCreate = vi.fn().mockResolvedValue(created);
    const transaction = {
      effectPromptRun: {
        findUnique: vi.fn().mockResolvedValue(null),
        findFirst: vi.fn().mockResolvedValue(null),
        create: runCreate,
      },
      effectImportProduct: { findFirst: vi.fn().mockResolvedValue({ id: productId }) },
      workflowRun: { findFirst: vi.fn().mockResolvedValue({ id: workflowRunId }) },
      workflowNodeState: {
        findUnique: vi.fn().mockResolvedValue({
          schemaVersion: 1,
          revision: 1,
          state: { count: 50, durationSeconds: 15, semanticLimit: 15, visualLimit: 20 },
        }),
        update: nodeUpdate,
      },
      workingArtifact: {
        findFirst: vi.fn().mockResolvedValue({
          id: '00000000-0000-4000-8000-000000000005',
          revision: 1,
          contentHash: 'a'.repeat(64),
          payload: { productName: '产品' },
        }),
      },
      effectPromptResult: { findFirst: vi.fn().mockResolvedValue(null) },
      jobOutbox: { create: vi.fn().mockResolvedValue({}) },
      $queryRaw: vi.fn().mockResolvedValue([{ id: productId }]),
    };
    const repository = new EffectPromptRepository({
      $transaction: (callback: (client: typeof transaction) => unknown) => callback(transaction),
    } as unknown as PrismaService);

    await expect(repository.startRun(projectId, workflowRunId, productId, input)).resolves.toEqual({
      kind: 'CREATED',
      run: created,
    });

    const expectedSettings = DEFAULT_EFFECT_PROMPT_SETTINGS;
    const expectedHash = workflowStateHash(expectedSettings);
    expect(nodeUpdate).toHaveBeenCalledWith({
      where: {
        projectId_workflowRunId_nodeId: {
          projectId,
          workflowRunId,
          nodeId: `PROMPT_GENERATION:${productId}`,
        },
      },
      data: expect.objectContaining({
        schemaVersion: EFFECT_PROMPT_SCHEMA_VERSION,
        revision: { increment: 1 },
        state: expectedSettings,
        contentHash: expectedHash,
        executionInputHash: expectedHash,
        executionInputSchemaVersion: EFFECT_PROMPT_SCHEMA_VERSION,
      }),
    });
    expect(runCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        settingsHash: expectedHash,
        inputSnapshot: expect.objectContaining({
          graphVersion: 'V11_COHERENT_CREATIVE_GENERATION',
          settings: expectedSettings,
        }),
      }),
      include: { result: true, stages: true },
    });
  });

  it('requires result revision CAS when batch generation replaces an existing result', async () => {
    const transaction = {
      effectPromptRun: { findUnique: vi.fn().mockResolvedValue(null) },
      effectImportProduct: { findFirst: vi.fn().mockResolvedValue({ id: productId }) },
      workflowRun: { findFirst: vi.fn().mockResolvedValue({ id: workflowRunId }) },
      workflowNodeState: {
        findUnique: vi.fn().mockResolvedValue({
          revision: 1,
          state: DEFAULT_EFFECT_PROMPT_SETTINGS,
        }),
      },
      workingArtifact: {
        findFirst: vi.fn().mockResolvedValue({
          id: '00000000-0000-4000-8000-000000000005',
          revision: 1,
          contentHash: 'a'.repeat(64),
          payload: { productName: '产品' },
        }),
      },
      effectPromptResult: {
        findFirst: vi.fn().mockResolvedValue({
          schemaVersion: EFFECT_PROMPT_SCHEMA_VERSION,
          revision: 4,
          draftResult: recomputePromptQuality([], DEFAULT_EFFECT_PROMPT_SETTINGS),
        }),
      },
      $queryRaw: vi.fn().mockResolvedValue([{ id: productId }]),
    };
    const repository = new EffectPromptRepository({
      $transaction: (callback: (client: typeof transaction) => unknown) => callback(transaction),
    } as unknown as PrismaService);

    await expect(repository.startRun(projectId, workflowRunId, productId, input)).resolves.toEqual({
      kind: 'RESULT_CONFLICT',
    });
  });

  it('carries the editable shared prompt into a replacement run snapshot', async () => {
    const created = runRecord();
    const runCreate = vi.fn().mockResolvedValue(created);
    const base = recomputePromptQuality([], DEFAULT_EFFECT_PROMPT_SETTINGS);
    const sharedPrompt = compileEffectPromptSharedPrompt([], '保持产品外观前后一致。');
    const current = recomputePromptQuality(
      [],
      DEFAULT_EFFECT_PROMPT_SETTINGS,
      base.metrics,
      base.renderProfile,
      sharedPrompt,
    );
    const transaction = {
      effectPromptRun: {
        findUnique: vi.fn().mockResolvedValue(null),
        findFirst: vi.fn().mockResolvedValue(null),
        create: runCreate,
      },
      effectImportProduct: { findFirst: vi.fn().mockResolvedValue({ id: productId }) },
      workflowRun: { findFirst: vi.fn().mockResolvedValue({ id: workflowRunId }) },
      workflowNodeState: {
        findUnique: vi.fn().mockResolvedValue({
          schemaVersion: EFFECT_PROMPT_SCHEMA_VERSION,
          revision: 1,
          state: DEFAULT_EFFECT_PROMPT_SETTINGS,
        }),
      },
      workingArtifact: {
        findFirst: vi.fn().mockResolvedValue({
          id: '00000000-0000-4000-8000-000000000005',
          revision: 1,
          contentHash: 'a'.repeat(64),
          payload: { productName: '产品' },
        }),
      },
      effectPromptResult: {
        findFirst: vi.fn().mockResolvedValue({
          schemaVersion: EFFECT_PROMPT_SCHEMA_VERSION,
          revision: 4,
          draftResult: current,
        }),
      },
      jobOutbox: { create: vi.fn().mockResolvedValue({}) },
      $queryRaw: vi.fn().mockResolvedValue([{ id: productId }]),
    };
    const repository = new EffectPromptRepository({
      $transaction: (callback: (client: typeof transaction) => unknown) => callback(transaction),
    } as unknown as PrismaService);

    await expect(
      repository.startRun(projectId, workflowRunId, productId, {
        ...input,
        expectedResultRevision: 4,
      }),
    ).resolves.toEqual({ kind: 'CREATED', run: created });
    expect(runCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        inputSnapshot: expect.objectContaining({ sharedPrompt }),
      }),
      include: { result: true, stages: true },
    });
  });

  it('starts a fresh V5 batch from a legacy result when its revision still matches', async () => {
    const created = runRecord();
    const runCreate = vi.fn().mockResolvedValue(created);
    const transaction = {
      effectPromptRun: {
        findUnique: vi.fn().mockResolvedValue(null),
        findFirst: vi.fn().mockResolvedValue(null),
        create: runCreate,
      },
      effectImportProduct: { findFirst: vi.fn().mockResolvedValue({ id: productId }) },
      workflowRun: { findFirst: vi.fn().mockResolvedValue({ id: workflowRunId }) },
      workflowNodeState: {
        findUnique: vi.fn().mockResolvedValue({
          schemaVersion: EFFECT_PROMPT_SCHEMA_VERSION,
          revision: 1,
          state: DEFAULT_EFFECT_PROMPT_SETTINGS,
        }),
      },
      workingArtifact: {
        findFirst: vi.fn().mockResolvedValue({
          id: '00000000-0000-4000-8000-000000000005',
          revision: 1,
          contentHash: 'a'.repeat(64),
          payload: { productName: '产品' },
        }),
      },
      effectPromptResult: {
        findFirst: vi.fn().mockResolvedValue({
          schemaVersion: 2,
          revision: 9,
          draftResult: { schemaVersion: 2 },
        }),
      },
      jobOutbox: { create: vi.fn().mockResolvedValue({}) },
      $queryRaw: vi.fn().mockResolvedValue([{ id: productId }]),
    };
    const repository = new EffectPromptRepository({
      $transaction: (callback: (client: typeof transaction) => unknown) => callback(transaction),
    } as unknown as PrismaService);

    await expect(
      repository.startRun(projectId, workflowRunId, productId, {
        ...input,
        expectedResultRevision: 9,
      }),
    ).resolves.toEqual({ kind: 'CREATED', run: created });
    expect(runCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        inputSnapshot: expect.objectContaining({
          schemaVersion: EFFECT_PROMPT_SCHEMA_VERSION,
          retainedManualItems: [],
          selectionPolicyVersion: 'MMR_CONTENT_V2',
          similarityAnchors: [],
          baseResultRevision: null,
        }),
      }),
      include: { result: true, stages: true },
    });
  });

  it('requires a live project-scoped attempt token for heartbeats', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const repository = new EffectPromptRepository({
      effectPromptRun: { updateMany },
    } as unknown as PrismaService);

    await repository.heartbeat('project-a', 'run-a', 'attempt-a');

    expect(updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        projectId: 'project-a',
        id: 'run-a',
        status: 'RUNNING',
        attemptToken: 'attempt-a',
      }),
      data: expect.objectContaining({
        heartbeatAt: expect.any(Date),
        leaseExpiresAt: expect.any(Date),
      }),
    });
  });

  it('requeues a retryable timeout through the outbox and keeps a safe retry warning', async () => {
    const now = new Date('2026-08-26T10:00:00.000Z');
    const update = vi.fn().mockResolvedValue({});
    const updateOutbox = vi.fn().mockResolvedValue({ count: 1 });
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: runId }]),
      effectPromptRun: {
        findFirst: vi.fn().mockResolvedValue({
          ...runRecord(),
          status: 'RUNNING',
          attemptCount: 1,
          attemptToken: 'attempt-a',
          leaseExpiresAt: new Date('2026-08-26T10:01:00.000Z'),
        }),
        update,
      },
      jobOutbox: { updateMany: updateOutbox },
    };
    const repository = new EffectPromptRepository({
      $transaction: (callback: (client: typeof transaction) => unknown) => callback(transaction),
    } as unknown as PrismaService);

    await expect(
      repository.fail(
        projectId,
        runId,
        'attempt-a',
        {
          errorCode: 'AI_TIMEOUT',
          errorMessage: 'Prompt AI 生成超时',
          retryable: true,
          warnings: [],
        },
        now,
      ),
    ).resolves.toBe('REQUEUED');
    expect(update).toHaveBeenCalledWith({
      where: { projectId_id: { projectId, id: runId } },
      data: expect.objectContaining({
        status: 'QUEUED',
        warnings: ['上一次 Prompt AI 请求超时，任务已自动重新排队'],
        attemptToken: null,
        leaseExpiresAt: null,
      }),
    });
    expect(updateOutbox).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ projectId, aggregateId: runId }),
        data: expect.objectContaining({ status: 'PENDING', nextAttemptAt: now }),
      }),
    );
  });

  it('fails output truncation immediately and closes the current stage', async () => {
    const now = new Date('2026-08-27T02:00:00.000Z');
    const update = vi.fn().mockResolvedValue({});
    const updateStage = vi.fn().mockResolvedValue({ count: 1 });
    const updateOutbox = vi.fn();
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: runId }]),
      effectPromptRun: {
        findFirst: vi.fn().mockResolvedValue({
          ...runRecord(),
          status: 'RUNNING',
          currentNode: 'STRATEGY_PLANNING',
          attemptCount: 1,
          attemptToken: 'attempt-a',
          leaseExpiresAt: new Date('2026-08-27T02:01:00.000Z'),
        }),
        update,
      },
      effectPromptStageOutput: { updateMany: updateStage },
      effectPromptShardOutput: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      jobOutbox: { updateMany: updateOutbox },
    };
    const repository = new EffectPromptRepository({
      $transaction: (callback: (client: typeof transaction) => unknown) => callback(transaction),
    } as unknown as PrismaService);

    await expect(
      repository.fail(
        projectId,
        runId,
        'attempt-a',
        {
          errorCode: 'AI_OUTPUT_TRUNCATED',
          errorMessage: '营销关系规划结果超过安全长度，任务已停止',
          retryable: false,
          warnings: [],
        },
        now,
      ),
    ).resolves.toBe('FAILED');
    expect(update).toHaveBeenCalledWith({
      where: { projectId_id: { projectId, id: runId } },
      data: expect.objectContaining({
        status: 'FAILED',
        currentNode: 'STRATEGY_PLANNING',
        errorCode: 'AI_OUTPUT_TRUNCATED',
        completedAt: now,
      }),
    });
    expect(updateStage).toHaveBeenCalledWith({
      where: { projectId, runId, nodeId: 'STRATEGY_PLANNING' },
      data: {
        status: 'FAILED',
        summary: '营销关系规划结果超过安全长度，任务已停止',
        errorMessage: '营销关系规划结果超过安全长度，任务已停止',
        completedAt: now,
      },
    });
    expect(updateOutbox).not.toHaveBeenCalled();
  });

  it('allows one invalid-response retry even after an unrelated earlier attempt', async () => {
    const now = new Date('2026-08-27T02:00:00.000Z');
    const updateOutbox = vi.fn().mockResolvedValue({ count: 1 });
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: runId }]),
      effectPromptRun: {
        findFirst: vi
          .fn()
          .mockResolvedValueOnce({
            ...runRecord(),
            status: 'RUNNING',
            currentNode: 'STRATEGY_PLANNING',
            attemptCount: 2,
            attemptToken: 'attempt-a',
            leaseExpiresAt: new Date('2026-08-27T02:01:00.000Z'),
          })
          .mockResolvedValueOnce({
            ...runRecord(),
            status: 'RUNNING',
            currentNode: 'STRATEGY_PLANNING',
            attemptCount: 3,
            attemptToken: 'attempt-b',
            leaseExpiresAt: new Date('2026-08-27T02:01:00.000Z'),
          }),
        update: vi.fn().mockResolvedValue({}),
      },
      effectPromptStageOutput: {
        findUnique: vi
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce({ metadata: { count: 1 } }),
        upsert: vi.fn().mockResolvedValue({}),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      effectPromptShardOutput: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      jobOutbox: { updateMany: updateOutbox },
    };
    const repository = new EffectPromptRepository({
      $transaction: (callback: (client: typeof transaction) => unknown) => callback(transaction),
    } as unknown as PrismaService);
    const failure = {
      errorCode: 'AI_RESPONSE_INVALID',
      errorMessage: 'Prompt AI 返回格式异常',
      retryable: true,
      warnings: [],
    };

    await expect(repository.fail(projectId, runId, 'attempt-a', failure, now)).resolves.toBe(
      'REQUEUED',
    );
    await expect(repository.fail(projectId, runId, 'attempt-b', failure, now)).resolves.toBe(
      'FAILED',
    );
    expect(updateOutbox).toHaveBeenCalledTimes(1);
    expect(transaction.effectPromptStageOutput.upsert).toHaveBeenCalledTimes(1);
    expect(transaction.effectPromptStageOutput.updateMany).toHaveBeenCalledTimes(2);
  });

  it('recovers an expired Prompt worker lease through the same run and outbox', async () => {
    const now = new Date('2026-08-26T10:00:00.000Z');
    const expired = {
      ...runRecord(),
      status: 'RUNNING',
      attemptCount: 1,
      attemptToken: 'expired-attempt',
      leaseExpiresAt: new Date('2026-08-26T09:59:00.000Z'),
    };
    const update = vi.fn().mockResolvedValue({});
    const updateOutbox = vi.fn().mockResolvedValue({ count: 1 });
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: runId }]),
      effectPromptRun: { findFirst: vi.fn().mockResolvedValue(expired), update },
      jobOutbox: { updateMany: updateOutbox },
    };
    const repository = new EffectPromptRepository({
      effectPromptRun: {
        findMany: vi.fn().mockResolvedValue([{ id: runId, projectId }]),
      },
      $transaction: (callback: (client: typeof transaction) => unknown) => callback(transaction),
    } as unknown as PrismaService);

    await expect(repository.recoverExpiredLeases(now)).resolves.toEqual({
      requeued: 1,
      failed: 0,
    });
    expect(update).toHaveBeenCalledWith({
      where: { projectId_id: { projectId, id: runId } },
      data: expect.objectContaining({
        status: 'QUEUED',
        attemptToken: null,
        leaseExpiresAt: null,
        errorCode: 'WORKER_LEASE_EXPIRED',
      }),
    });
    expect(updateOutbox).toHaveBeenCalledOnce();
  });

  it('republishes a queued Prompt run when its published message was never claimed', async () => {
    const now = new Date('2026-08-26T10:00:00.000Z');
    const staleRun = {
      ...runRecord(),
      status: 'QUEUED',
      updatedAt: new Date('2026-08-26T09:58:00.000Z'),
    };
    const update = vi.fn().mockResolvedValue({});
    const updateOutbox = vi.fn().mockResolvedValue({ count: 1 });
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: runId }]),
      effectPromptRun: { findFirst: vi.fn().mockResolvedValue(staleRun), update },
      jobOutbox: { updateMany: updateOutbox },
    };
    const repository = new EffectPromptRepository({
      effectPromptRun: {
        findMany: vi.fn().mockResolvedValue([{ id: runId, projectId }]),
      },
      $transaction: (callback: (client: typeof transaction) => unknown) => callback(transaction),
    } as unknown as PrismaService);

    await expect(repository.recoverStaleQueuedDispatches(now)).resolves.toBe(1);
    expect(updateOutbox).toHaveBeenCalledWith({
      where: {
        projectId,
        jobType: 'EFFECT_PROMPT_GENERATION',
        aggregateId: runId,
        status: 'PUBLISHED',
      },
      data: expect.objectContaining({ status: 'PENDING', publishedAt: null }),
    });
    expect(update).toHaveBeenCalledWith({
      where: { projectId_id: { projectId, id: runId } },
      data: expect.objectContaining({
        errorCode: 'WORKER_CLAIM_TIMEOUT',
        errorMessage: 'Prompt 任务消息已自动重新投递',
      }),
    });
  });

  it('fails an expired Prompt worker lease after the third attempt', async () => {
    const now = new Date('2026-08-26T10:00:00.000Z');
    const update = vi.fn().mockResolvedValue({});
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: runId }]),
      effectPromptRun: {
        findFirst: vi.fn().mockResolvedValue({
          ...runRecord(),
          status: 'RUNNING',
          attemptCount: 3,
          attemptToken: 'expired-attempt',
          leaseExpiresAt: new Date('2026-08-26T09:59:00.000Z'),
        }),
        update,
      },
      jobOutbox: { updateMany: vi.fn() },
    };
    const repository = new EffectPromptRepository({
      effectPromptRun: {
        findMany: vi.fn().mockResolvedValue([{ id: runId, projectId }]),
      },
      $transaction: (callback: (client: typeof transaction) => unknown) => callback(transaction),
    } as unknown as PrismaService);

    await expect(repository.recoverExpiredLeases(now)).resolves.toEqual({
      requeued: 0,
      failed: 1,
    });
    expect(update).toHaveBeenCalledWith({
      where: { projectId_id: { projectId, id: runId } },
      data: expect.objectContaining({
        status: 'FAILED',
        errorMessage: 'Worker 多次失联，Prompt 任务已终止',
        completedAt: now,
      }),
    });
    expect(transaction.jobOutbox.updateMany).not.toHaveBeenCalled();
  });

  it('closes RESULT_SAVE and skips an untriggered REPLENISH in the completion transaction', async () => {
    const now = new Date('2026-08-25T00:00:00.000Z');
    const candidate = recomputePromptQuality([], DEFAULT_EFFECT_PROMPT_SETTINGS);
    const stageCreate = vi.fn().mockResolvedValue({});
    const stageUpsert = vi.fn().mockResolvedValue({});
    const createdResult = { id: '00000000-0000-4000-8000-000000000099' };
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: runId }]),
      effectPromptRun: {
        findFirst: vi.fn().mockResolvedValue({
          ...runRecord(),
          status: 'RUNNING',
          attemptToken: 'attempt-a',
          leaseExpiresAt: new Date('2026-08-25T00:02:00.000Z'),
          inputSnapshot: {
            schemaVersion: 4,
            projectId,
            workflowRunId,
            productId,
            operation: 'BATCH_GENERATE',
            targetItemId: null,
            settings: candidate.settings,
            insightArtifact: { id: 'insight', revision: 1, contentHash: 'hash', result: {} },
            retainedManualItems: [],
            baseResultRevision: null,
          },
          result: null,
        }),
        update: vi.fn().mockResolvedValue({}),
      },
      effectPromptResult: { create: vi.fn().mockResolvedValue(createdResult) },
      effectPromptStageOutput: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: stageCreate,
        upsert: stageUpsert,
      },
    };
    const repository = new EffectPromptRepository({
      $transaction: (callback: (client: typeof transaction) => unknown) => callback(transaction),
    } as unknown as PrismaService);

    await expect(
      repository.complete(projectId, runId, 'attempt-a', candidate, now),
    ).resolves.toEqual({ kind: 'COMPLETED', result: createdResult });
    expect(stageCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        projectId,
        runId,
        nodeId: 'REPLENISH',
        status: 'SKIPPED',
        completedAt: now,
      }),
    });
    expect(stageUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          projectId_runId_nodeId: { projectId, runId, nodeId: 'RESULT_SAVE' },
        },
        create: expect.objectContaining({ status: 'SUCCEEDED', completedAt: now }),
        update: expect.objectContaining({ status: 'SUCCEEDED', completedAt: now }),
      }),
    );
  });

  it('rejects stale revisions before mutating result contents', async () => {
    const update = vi.fn();
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: 'result-a' }]),
      effectPromptResult: {
        findFirst: vi.fn().mockResolvedValue({ id: 'result-a', revision: 3 }),
        update,
      },
    };
    const repository = new EffectPromptRepository({
      $transaction: (callback: (client: typeof transaction) => unknown) => callback(transaction),
    } as unknown as PrismaService);

    await expect(
      repository.mutateResult('project-a', 'result-a', 2, {
        kind: 'DELETE',
        itemId: 'item-a',
      }),
    ).resolves.toEqual({ kind: 'REVISION_CONFLICT' });
    expect(update).not.toHaveBeenCalled();
  });

  it('rechecks current insight and execution input inside the commit transaction', async () => {
    const commit = vi.fn();
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: 'result-a' }]),
      effectPromptResult: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'result-a',
          projectId,
          workflowRunId,
          productId,
          runId,
          revision: 2,
          settingsHash: 'settings-hash',
          run: {
            inputSnapshot: {
              insightArtifact: {
                id: '00000000-0000-4000-8000-000000000005',
                revision: 3,
                contentHash: 'a'.repeat(64),
              },
            },
          },
        }),
      },
      effectPromptRun: {
        findFirst: vi.fn().mockResolvedValue({ id: runId, status: 'COMPLETED' }),
      },
      workingArtifact: { findFirst: vi.fn().mockResolvedValue(null) },
      workflowNodeState: {
        findUnique: vi.fn().mockResolvedValue({ executionInputHash: 'settings-hash' }),
      },
    };
    const repository = new EffectPromptRepository(
      {
        $transaction: (callback: (client: typeof transaction) => unknown) => callback(transaction),
      } as unknown as PrismaService,
      { commitValidatedArtifactsInTransaction: commit } as never,
    );

    await expect(
      repository.commitValidatedResult(projectId, 'result-a', 2, {} as never),
    ).resolves.toEqual({ kind: 'DEPENDENCY_CONFLICT' });
    expect(transaction.workingArtifact.findFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({
        projectId,
        id: '00000000-0000-4000-8000-000000000005',
        artifactKey: `marketing-insight:${productId}`,
        revision: 3,
        contentHash: 'a'.repeat(64),
        freshness: 'CURRENT',
        availability: 'AVAILABLE',
      }),
    });
    expect(transaction.effectPromptRun.findFirst).toHaveBeenCalledWith({
      where: {
        projectId,
        workflowRunId,
        productId,
        status: 'COMPLETED',
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    expect(commit).not.toHaveBeenCalled();
  });

  it('counts active runs within the current project and workflow only', async () => {
    const count = vi.fn().mockResolvedValue(1);
    const repository = new EffectPromptRepository({
      effectPromptRun: { count },
    } as unknown as PrismaService);

    await expect(repository.activeRunCount('project-a', 'workflow-a')).resolves.toBe(1);
    expect(count).toHaveBeenCalledWith({
      where: {
        projectId: 'project-a',
        workflowRunId: 'workflow-a',
        status: { in: ['QUEUED', 'RUNNING'] },
      },
    });
  });
});
