import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../../database/prisma.service';
import { workflowStateHash } from '../../../platform/workflow/workflow-state-hash';
import {
  EffectPromptRepository,
  promptItemsRetainedForRun,
  type StartPromptRunInput,
} from './effect-prompt.repository';
import { recomputePromptQuality } from './effect-prompt.quality';

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
  it('retains every non-target item only for item regeneration', () => {
    const now = '2026-08-25T00:00:00.000Z';
    const items = ['one', 'target', 'three'].map((id, index) => ({
      id,
      code: id,
      origin: index === 2 ? ('MANUAL' as const) : ('AI' as const),
      fragmentType: '短视频',
      dimensions: {
        narrative: `叙事-${id}`,
        scene: `场景-${id}`,
        persona: `人物-${id}`,
        sellingPoint: `卖点-${id}`,
        camera: `镜头-${id}`,
        emotion: `情绪-${id}`,
      },
      content: `内容-${id}`,
      manualEdited: index === 2,
      createdAt: now,
      updatedAt: now,
    }));
    const result = recomputePromptQuality(items, {
      count: 10,
      durationSeconds: 15,
      semanticLimit: 15,
      visualLimit: 20,
    });

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
          state: { count: 50, durationSeconds: 15, semanticLimit: 15, visualLimit: 20 },
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
          schemaVersion: 1,
          projectId,
          runId,
          requestId: runId,
        },
      }),
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
          state: { count: 50, durationSeconds: 15, semanticLimit: 15, visualLimit: 20 },
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
        findFirst: vi.fn().mockResolvedValue({ revision: 4, draftResult: {} }),
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

  it('closes RESULT_SAVE and skips an untriggered REPLENISH in the completion transaction', async () => {
    const now = new Date('2026-08-25T00:00:00.000Z');
    const candidate = recomputePromptQuality([], {
      count: 10,
      durationSeconds: 15,
      semanticLimit: 15,
      visualLimit: 20,
    });
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
            schemaVersion: 1,
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
