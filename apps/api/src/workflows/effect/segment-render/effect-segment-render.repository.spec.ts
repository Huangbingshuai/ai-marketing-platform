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
