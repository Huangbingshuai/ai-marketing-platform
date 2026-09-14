import { describe, expect, it, vi } from 'vitest';

import { EffectSegmentRenderRepository } from './effect-segment-render.repository';

const runningTask = {
  id: '11111111-1111-4111-8111-111111111111',
  projectId: '22222222-2222-4222-8222-222222222222',
  workflowRunId: '33333333-3333-4333-8333-333333333333',
  productId: '44444444-4444-4444-8444-444444444444',
  batchId: '55555555-5555-4555-8555-555555555555',
  status: 'RUNNING',
  renderVersion: 1,
  attemptToken: '66666666-6666-4666-8666-666666666666',
  leaseExpiresAt: new Date('2026-09-03T00:02:00.000Z'),
  retryCount: 0,
  maxAutoRetries: 2,
  attemptCount: 1,
  progress: 40,
};

describe('EffectSegmentRenderRepository', () => {
  it('orphans selected files and keeps their Prompt slots available for regeneration', async () => {
    const batch = {
      id: runningTask.batchId,
      projectId: runningTask.projectId,
      workflowRunId: runningTask.workflowRunId,
      productId: runningTask.productId,
      sourcePromptArtifactId: '77777777-7777-4777-8777-777777777777',
      sourcePromptRevision: 3,
      sourcePromptHash: 'a'.repeat(64),
      revision: 4,
      status: 'COMPLETED',
    };
    const completedTask = {
      ...runningTask,
      status: 'COMPLETED',
      outputFileObjectId: '88888888-8888-4888-8888-888888888888',
      outputPoster: null,
      repairStatus: null,
      requestSnapshot: {
        sourcePackage: {
          artifactId: '99999999-9999-4999-8999-999999999999',
          revision: 2,
          contentHash: 'b'.repeat(64),
        },
      },
    };
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: batch.id }]),
      effectSegmentRenderOperationReceipt: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({}),
      },
      effectSegmentRenderBatch: {
        findFirst: vi.fn().mockResolvedValueOnce(batch).mockResolvedValueOnce(batch),
        update: vi.fn().mockResolvedValue({}),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      effectSegmentRenderTask: {
        findMany: vi.fn().mockResolvedValue([completedTask]),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        groupBy: vi.fn().mockResolvedValue([{ status: 'FAILED', _count: { _all: 1 } }]),
      },
      workingArtifact: { findFirst: vi.fn().mockResolvedValue({ id: 'current' }) },
      fileObject: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    const prisma = {
      $transaction: vi.fn().mockImplementation(async (operation) => operation(transaction)),
    };
    const repository = new EffectSegmentRenderRepository(prisma as never);

    const result = await repository.deleteMaterials(
      runningTask.projectId,
      batch.id,
      [completedTask.id],
      4,
      'delete-material-a',
    );

    expect(result).toEqual({ kind: 'UPDATED' });
    expect(transaction.fileObject.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { projectId: runningTask.projectId, id: { in: [completedTask.outputFileObjectId] } },
        data: expect.objectContaining({ status: 'ORPHANED' }),
      }),
    );
    expect(transaction.effectSegmentRenderTask.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ projectId: runningTask.projectId, batchId: batch.id }),
        data: expect.objectContaining({
          status: 'FAILED',
          outputFileObjectId: null,
          errorCode: 'MATERIAL_DELETED',
        }),
      }),
    );
  });

  it('locks the leased task and requeues a retryable provider failure through the same Outbox row', async () => {
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: runningTask.id }]),
      effectSegmentRenderTask: {
        findFirst: vi.fn().mockResolvedValue(runningTask),
        update: vi.fn().mockResolvedValue({ ...runningTask, status: 'QUEUED' }),
      },
      effectSegmentRenderBatch: { update: vi.fn().mockResolvedValue({}) },
      jobOutbox: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    const prisma = {
      $transaction: vi.fn().mockImplementation(async (operation) => operation(transaction)),
    };
    const repository = new EffectSegmentRenderRepository(prisma as never);

    const outcome = await repository.fail(
      runningTask.projectId,
      runningTask.id,
      runningTask.attemptToken,
      1,
      { errorCode: 'SEEDANCE_TIMEOUT', errorMessage: '超时', retryable: true },
      new Date('2026-09-03T00:01:00.000Z'),
    );

    expect(outcome).toBe('REQUEUED');
    expect(transaction.$queryRaw).toHaveBeenCalledOnce();
    expect(transaction.effectSegmentRenderTask.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { projectId_id: { projectId: runningTask.projectId, id: runningTask.id } },
        data: expect.objectContaining({ status: 'QUEUED', attemptToken: null }),
      }),
    );
    expect(transaction.jobOutbox.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          projectId: runningTask.projectId,
          aggregateId: runningTask.id,
        }),
        data: expect.objectContaining({ status: 'PENDING', dispatchToken: null }),
      }),
    );
  });
});
