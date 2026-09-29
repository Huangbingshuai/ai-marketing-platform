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
  it('does not expose archived render batches or their tasks in the current branch', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const taskFindFirst = vi.fn().mockResolvedValue(null);
    const repository = new EffectSegmentRenderRepository({
      effectSegmentRenderBatch: { findFirst },
      effectSegmentRenderTask: { findFirst: taskFindFirst },
    } as never);

    await repository.latestBatch('project', 'child', 'product');
    await repository.batch('project', 'batch');
    await repository.task('project', 'task');

    expect(findFirst).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: { projectId: 'project', workflowRunId: 'child', productId: 'product', archivedAt: null },
    }));
    expect(findFirst).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: { projectId: 'project', id: 'batch', archivedAt: null },
    }));
    expect(taskFindFirst).toHaveBeenCalledWith({
      where: { projectId: 'project', id: 'task', batch: { archivedAt: null } },
    });
  });

  it('reads ancestor media but never sibling or cross-project media', async () => {
    const fileObject = {
      findFirst: vi.fn().mockResolvedValue({ id: 'file', workflowRunId: 'root' }),
    };
    const workflowRun = {
      findFirst: vi.fn().mockImplementation(async ({ where }: { where: { id: string } }) =>
        where.id === 'child' ? { parentWorkflowRunId: 'root' }
          : { parentWorkflowRunId: null },
      ),
    };
    const repository = new EffectSegmentRenderRepository({ fileObject, workflowRun } as never);
    expect(await repository.fileObject('project-a', 'child', 'file')).toMatchObject({ id: 'file' });
    expect(await repository.fileObject('project-a', 'sibling', 'file')).toBeNull();
    expect(fileObject.findFirst).toHaveBeenCalledWith({
      where: { projectId: 'project-a', id: 'file', status: 'AVAILABLE' },
    });
    fileObject.findFirst.mockResolvedValueOnce(null);
    expect(await repository.fileObject('project-b', 'child', 'file')).toBeNull();
  });

  it('retains branch media and keeps deleted Prompt slots available for regeneration', async () => {
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
    expect(transaction.fileObject.updateMany).not.toHaveBeenCalled();
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

  it('gives the validate commit a budget above the Prisma default and retries a transient clash', async () => {
    const transient = Object.assign(new Error('Transaction already closed'), { code: 'P2028' });
    const prisma = {
      $transaction: vi
        .fn()
        .mockRejectedValueOnce(transient)
        .mockResolvedValueOnce({ kind: 'COMMITTED', artifacts: [] }),
    };
    const repository = new EffectSegmentRenderRepository(prisma as never);

    const result = await repository.commitValidatedBatch(
      runningTask.projectId,
      runningTask.batchId,
      4,
      { artifactId: 'a', revision: 3, contentHash: 'a'.repeat(64) },
      { artifactId: 'b', revision: 2, contentHash: 'b'.repeat(64) },
      [],
    );

    expect(result).toEqual({ kind: 'COMMITTED', artifacts: [] });
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    const options = prisma.$transaction.mock.calls[0]![1] as { maxWait: number; timeout: number };
    expect(options.timeout).toBeGreaterThan(5_000);
    expect(options.maxWait).toBeGreaterThan(2_000);
  });

  it('reports an unrecoverable clash as a conflict instead of letting it escape as an internal error', async () => {
    const transient = Object.assign(new Error('deadlock detected'), { code: 'P2034' });
    const prisma = { $transaction: vi.fn().mockRejectedValue(transient) };
    const repository = new EffectSegmentRenderRepository(prisma as never);

    const result = await repository.commitValidatedBatch(
      runningTask.projectId,
      runningTask.batchId,
      4,
      { artifactId: 'a', revision: 3, contentHash: 'a'.repeat(64) },
      { artifactId: 'b', revision: 2, contentHash: 'b'.repeat(64) },
      [],
    );

    expect(result).toEqual({ kind: 'CONFLICT' });
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
  });

  it('does not retry or swallow a failure that is not a transient clash', async () => {
    const broken = new Error('WORKFLOW_WORKING_REPOSITORY_NOT_AVAILABLE');
    const prisma = { $transaction: vi.fn().mockRejectedValue(broken) };
    const repository = new EffectSegmentRenderRepository(prisma as never);

    await expect(
      repository.commitValidatedBatch(
        runningTask.projectId,
        runningTask.batchId,
        4,
        { artifactId: 'a', revision: 3, contentHash: 'a'.repeat(64) },
        { artifactId: 'b', revision: 2, contentHash: 'b'.repeat(64) },
        [],
      ),
    ).rejects.toThrow('WORKFLOW_WORKING_REPOSITORY_NOT_AVAILABLE');
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('reports a branch-publication conflict without treating an artifact commit as successful', async () => {
    const prisma = {
      $transaction: vi.fn().mockRejectedValue(
        new Error('EFFECT_RENDER_BRANCH_PUBLICATION_CONFLICT'),
      ),
    };
    const repository = new EffectSegmentRenderRepository(prisma as never);

    const result = await repository.commitValidatedBatch(
      runningTask.projectId,
      runningTask.batchId,
      4,
      { artifactId: 'a', revision: 3, contentHash: 'a'.repeat(64) },
      { artifactId: 'b', revision: 2, contentHash: 'b'.repeat(64) },
      [],
    );

    expect(result).toEqual({ kind: 'BRANCH_CONFLICT' });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });
});
