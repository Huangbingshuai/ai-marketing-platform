import type { EffectSegmentRenderRequestSnapshot } from '@ai-marketing/contracts';
import { describe, expect, it, vi } from 'vitest';
import { EffectSegmentRenderRepository } from './effect-segment-render.repository';
import { renderPromptBaseline } from './effect-segment-render-prompt-update';

const fixture = () => {
  const sourcePrompt = { artifactId: 'prompt-artifact', revision: 2, contentHash: 'p' };
  const sourcePackage = { artifactId: 'source-artifact', revision: 1, contentHash: 's' };
  const snapshot = {
    promptId: 'prompt-a',
    promptContentHash: 'old',
    sharedPromptHash: 'shared',
    primaryPurpose: 'PRODUCT_DISPLAY',
    compatiblePurposes: ['PRODUCT_DISPLAY'],
    request: { duration: 5 },
    sourcePrompt,
    sourcePackage,
  } as EffectSegmentRenderRequestSnapshot;
  const tasks = ['render', 'metadata', 'remove', 'unchanged'].map((id) => ({
    id,
    promptId: id === 'render' ? 'prompt-a' : id,
    status: 'COMPLETED',
    repairStatus: null,
    errorCode: null,
    renderVersion: 1,
    outputFileObjectId: id + '-file',
    outputStorageKey: id + '-key',
    requestSnapshot: snapshot,
    generationRequestSnapshot: snapshot,
  }));
  const batch = {
    id: 'batch-a',
    projectId: 'project-a',
    workflowRunId: 'run-a',
    productId: 'product-a',
    revision: 1,
  };
  const transaction = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    workflowRun: { findFirst: vi.fn().mockResolvedValue({ id: 'run-a', editIdMap: {} }), update: vi.fn() },
    workingArtifact: { findFirst: vi.fn().mockResolvedValue({}) },
    effectSegmentRenderOperationReceipt: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
    },
    effectSegmentRenderBatch: {
      findFirst: vi.fn().mockImplementation(({ where }) => (where.id?.not ? null : batch)),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    effectSegmentRenderTask: {
      findMany: vi
        .fn()
        .mockImplementation(({ where }) =>
          where.id?.in ? tasks.filter((task) => where.id.in.includes(task.id)) : tasks,
        ),
      update: vi.fn(),
      updateMany: vi.fn(),
      createMany: vi.fn(),
      groupBy: vi.fn().mockResolvedValue([]),
    },
    jobOutbox: { upsert: vi.fn(), createMany: vi.fn() },
  };
  const repository = new EffectSegmentRenderRepository({
    $transaction: (callback: (tx: typeof transaction) => Promise<unknown>) => callback(transaction),
  } as never);
  return { repository, transaction, snapshot, sourcePrompt, sourcePackage };
};

describe('render refresh transaction', () => {
  it.each(['metadata', 'remove'] as const)(
    'executes pure %s without Outbox and without modifying unaffected files',
    async (kind) => {
      const { repository, transaction: tx, snapshot, sourcePrompt, sourcePackage } = fixture();
      const output = await repository.regenerateTasks('project-a', 'batch-a', [], 1, 'free', {
        sourcePrompt,
        sourcePackage,
        taskSnapshots: {},
        metadataSnapshots:
          kind === 'metadata' ? { metadata: { ...snapshot, promptId: 'metadata' } } : {},
        removedTaskIds: kind === 'remove' ? ['remove'] : [],
      });
      expect(output).toEqual({ kind: 'UPDATED' });
      expect(tx.workflowRun.update).toHaveBeenCalledWith({ where: { id: 'run-a' },
        data: { editIdMap: { renderProgress: { batchId: 'batch-a', taskIds: [],
          synchronizedTaskIds: kind === 'metadata' ? ['metadata'] : [], removedTaskIds: kind === 'remove' ? ['remove'] : [] } } } });
      expect(tx.jobOutbox.upsert).not.toHaveBeenCalled();
      expect(tx.jobOutbox.createMany).not.toHaveBeenCalled();
      expect(tx.effectSegmentRenderBatch.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'COMPLETED', activeKey: null }),
        }),
      );
      if (kind === 'metadata') {
        const data = tx.effectSegmentRenderTask.update.mock.calls[0]![0].data;
        expect(data.outputFileObjectId).toBeUndefined();
        expect(data.renderVersion).toBeUndefined();
      } else
        expect(tx.effectSegmentRenderTask.updateMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { projectId: 'project-a', batchId: 'batch-a', id: { in: ['remove'] } },
            data: expect.objectContaining({ errorCode: 'MATERIAL_DELETED' }),
          }),
        );
    },
  );
  it('queues only rendering changes and additions, preserves the adopted baseline and active video', async () => {
    const { repository, transaction: tx, snapshot, sourcePrompt, sourcePackage } = fixture();
    const output = await repository.regenerateTasks(
      'project-a',
      'batch-a',
      ['render'],
      1,
      'mixed',
      {
        sourcePrompt,
        sourcePackage,
        taskSnapshots: { render: { ...snapshot, promptContentHash: 'new' } },
        metadataSnapshots: {
          metadata: { ...snapshot, promptId: 'metadata', creativeCore: '新创意' },
        },
        removedTaskIds: ['remove'],
        addedTasks: [
          {
            id: 'added',
            promptId: 'new-prompt',
            promptCode: 'P005',
            renderCode: 'R-005',
            sourceFingerprint: 'new-fingerprint',
            requestSnapshot: { ...snapshot, promptId: 'new-prompt' },
          },
        ],
      },
    );
    expect(output).toEqual({ kind: 'UPDATED' });
    expect(tx.workflowRun.update).toHaveBeenCalledWith({ where: { id: 'run-a' },
      data: { editIdMap: { renderProgress: { batchId: 'batch-a', taskIds: ['render', 'added'],
        synchronizedTaskIds: ['metadata'], removedTaskIds: ['remove'] } } } });
    expect(tx.jobOutbox.upsert).toHaveBeenCalledOnce();
    expect(
      tx.jobOutbox.createMany.mock.calls[0]![0].data.map(
        (row: { aggregateId: string }) => row.aggregateId,
      ),
    ).toEqual(['added']);
    const render = tx.effectSegmentRenderTask.update.mock.calls.find(
      ([arg]) => arg.where.projectId_id.id === 'render',
    )![0];
    expect(render.data.outputFileObjectId).toBeUndefined();
    expect(render.data.generationRequestSnapshot.adoptedPrompt).toEqual(
      renderPromptBaseline(snapshot),
    );
    expect(render.data.generationRequestSnapshot.promptContentHash).toBe('new');
    expect(
      tx.effectSegmentRenderTask.update.mock.calls.some(
        ([arg]) => arg.where.projectId_id.id === 'unchanged',
      ),
    ).toBe(false);
  });
  it('rejects frozen Prompt revision conflicts before writing any task or receipt', async () => {
    const { repository, transaction: tx, sourcePrompt, sourcePackage } = fixture();
    tx.workingArtifact.findFirst.mockResolvedValue(null);
    expect(
      await repository.regenerateTasks('project-a', 'batch-a', [], 1, 'conflict', {
        sourcePrompt,
        sourcePackage,
        taskSnapshots: {},
        removedTaskIds: ['remove'],
      }),
    ).toEqual({ kind: 'PROMPT_CONFLICT' });
    expect(tx.effectSegmentRenderOperationReceipt.create).not.toHaveBeenCalled();
    expect(tx.effectSegmentRenderTask.updateMany).not.toHaveBeenCalled();
  });
  it('replays the same request and refuses an idempotency key reused for a different deletion', async () => {
    const { repository, transaction: tx, sourcePrompt, sourcePackage } = fixture();
    const input = { sourcePrompt, sourcePackage, taskSnapshots: {}, removedTaskIds: ['remove'] };
    await repository.regenerateTasks('project-a', 'batch-a', [], 1, 'replay', input);
    tx.effectSegmentRenderOperationReceipt.findUnique.mockResolvedValue({
      batchId: 'batch-a',
      requestHash: tx.effectSegmentRenderOperationReceipt.create.mock.calls[0]![0].data.requestHash,
    });
    expect(
      await repository.regenerateTasks('project-a', 'batch-a', [], 1, 'replay', input),
    ).toEqual({ kind: 'REPLAYED' });
    expect(
      await repository.regenerateTasks('project-a', 'batch-a', [], 1, 'replay', {
        ...input,
        removedTaskIds: ['unchanged'],
      }),
    ).toEqual({ kind: 'KEY_CONFLICT' });
    expect(tx.effectSegmentRenderOperationReceipt.create).toHaveBeenCalledOnce();
  });
});
