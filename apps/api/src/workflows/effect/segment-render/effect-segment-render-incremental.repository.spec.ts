import { describe, expect, it, vi } from 'vitest';
import type { EffectSegmentRenderRequestSnapshot } from '@ai-marketing/contracts';
import { EffectSegmentRenderRepository } from './effect-segment-render.repository';

function harness() {
  const batch = { id: 'batch', workflowRunId: 'current', productId: 'product', revision: 4 };
  const old = {
    id: 'old-task',
    promptId: 'old-prompt',
    status: 'COMPLETED',
    outputFileObjectId: 'old-file',
    repairStatus: null,
  };
  const tx = {
    $queryRaw: vi.fn(),
    workflowRun: {
      findFirst: vi.fn().mockResolvedValue({ id: 'current', editIdMap: {} }),
      update: vi.fn(),
    },
    workingArtifact: { findFirst: vi.fn().mockResolvedValue({ id: 'source' }) },
    effectSegmentRenderBatch: {
      findFirst: vi
        .fn()
        .mockImplementation(({ where }) => Promise.resolve(where.id?.not ? null : batch)),
      update: vi.fn(),
    },
    effectSegmentRenderTask: {
      findMany: vi.fn().mockImplementation(({ where }) => Promise.resolve(where.id ? [] : [old])),
      createMany: vi.fn(),
      update: vi.fn(),
    },
    effectSegmentRenderOperationReceipt: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
    },
    jobOutbox: { createMany: vi.fn(), upsert: vi.fn() },
  };
  const repo = new EffectSegmentRenderRepository({
    $transaction: (fn: (client: typeof tx) => unknown) => fn(tx),
  } as never);
  const snapshot = {
    promptId: 'new-prompt',
    sourcePackage: { artifactId: 'source', revision: 1, contentHash: 'h' },
  } as EffectSegmentRenderRequestSnapshot;
  const input = {
    sourcePrompt: { artifactId: 'prompt-batch', revision: 2, contentHash: 'h2' },
    taskSnapshots: {},
    refreshRequestHash: 'stable-refresh-intent',
    addedTasks: [
      {
        id: 'new-task',
        promptId: 'new-prompt',
        promptCode: 'P2',
        renderCode: 'R-002',
        sourceFingerprint: 'fingerprint',
        requestSnapshot: snapshot,
      },
    ],
  };
  const run = () => repo.regenerateTasks('p', 'batch', [], 4, 'key', input);
  return { tx, old, input, run };
}

describe('render additions reuse the existing task/outbox transaction', () => {
  it('creates only new tasks and preserves old files and task identities', async () => {
    const { tx, old, run } = harness();
    const before = structuredClone(old);
    expect(await run()).toEqual({ kind: 'UPDATED' });
    expect(tx.workflowRun.update).toHaveBeenCalledWith({
      where: { id: 'current' },
      data: {
        editIdMap: {
          renderProgress: {
            batchId: 'batch',
            taskIds: ['new-task'],
            synchronizedTaskIds: [],
            removedTaskIds: [],
          },
        },
      },
    });
    expect(old).toEqual(before);
    expect(tx.effectSegmentRenderTask.update).not.toHaveBeenCalled();
    expect(tx.effectSegmentRenderTask.createMany.mock.calls[0]![0].data).toMatchObject([
      { id: 'new-task', workflowRunId: 'current', batchId: 'batch' },
    ]);
    expect(tx.jobOutbox.createMany.mock.calls[0]![0].data).toMatchObject([
      { aggregateId: 'new-task', projectId: 'p' },
    ]);
  });
  it('replays the same operation before inspecting changed current input', async () => {
    const { tx, run } = harness();
    tx.effectSegmentRenderOperationReceipt.findUnique.mockResolvedValue({
      requestHash: 'stable-refresh-intent',
      batchId: 'batch',
    });
    expect(await run()).toEqual({ kind: 'REPLAYED' });
    expect(tx.effectSegmentRenderTask.createMany).not.toHaveBeenCalled();
    expect(tx.effectSegmentRenderBatch.findFirst).not.toHaveBeenCalled();
  });
  it('rejects duplicate Prompt IDs and changed confirmed sources without issuing jobs', async () => {
    const { tx, input, run } = harness();
    input.addedTasks[0]!.promptId = 'old-prompt';
    input.addedTasks[0]!.requestSnapshot.promptId = 'old-prompt';
    expect(await run()).toEqual({ kind: 'PROMPT_CONFLICT' });
    input.addedTasks[0]!.promptId = 'new-prompt';
    input.addedTasks[0]!.requestSnapshot.promptId = 'new-prompt';
    tx.workingArtifact.findFirst.mockResolvedValue(null);
    expect(await run()).toEqual({ kind: 'PROMPT_CONFLICT' });
    expect(tx.jobOutbox.createMany).not.toHaveBeenCalled();
    expect(tx.effectSegmentRenderOperationReceipt.create).not.toHaveBeenCalled();
  });
});
