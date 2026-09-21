import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../../database/prisma.service';
import { EffectPackagingRepository } from './effect-packaging.repository';

function harness() {
  const db = {
    $queryRaw: vi.fn(),
    effectPackagingRun: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      count: vi.fn().mockResolvedValue(0),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({ id: 'run' }),
      update: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    effectPackagingItem: { findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    jobOutbox: { create: vi.fn() },
  };
  const repo = new EffectPackagingRepository({
    ...db,
    $transaction: (fn: (tx: typeof db) => unknown) => fn(db),
  } as unknown as PrismaService);
  return { db, repo };
}
describe('packaging lease and durable task repository', () => {
  it('idempotent replay does not enqueue again, changed request is rejected', async () => {
    const { db, repo } = harness();
    db.effectPackagingRun.findUnique.mockResolvedValue({ id: 'run', requestHash: 'same' });
    const input = {
      projectId: 'p',
      workflowRunId: 'w',
      templateId: 't',
      idempotencyKey: 'k',
      requestHash: 'same',
      snapshots: [],
      checkpoints: [],
    };
    expect(await repo.create(input)).toBe('run');
    expect(db.jobOutbox.create).not.toHaveBeenCalled();
    await expect(repo.create({ ...input, requestHash: 'different' })).rejects.toThrow('幂等');
  });
  it('uses the existing queue with an explicit schema-2 discriminator', async () => {
    const { db, repo } = harness();
    await repo.create({
      projectId: 'p',
      workflowRunId: 'w',
      templateId: 't',
      idempotencyKey: 'k',
      requestHash: 'hash',
      snapshots: [],
      checkpoints: [],
    });
    expect(db.jobOutbox.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          routingKey: 'effect.template-mix.requested',
          payload: expect.objectContaining({
            schemaVersion: 2,
            taskType: 'PACKAGING',
            projectId: 'p',
            runId: 'run',
          }),
        }),
      }),
    );
  });
  it('rejects old token and expired lease writes before touching items', async () => {
    const { db, repo } = harness();
    db.effectPackagingRun.updateMany.mockResolvedValue({ count: 0 });
    await expect(repo.checkpoint('p', 'r', 'old', 'i', 'READY', {})).rejects.toThrow('租约');
    expect(db.effectPackagingItem.update).not.toHaveBeenCalled();
  });
  it('does not grant a second live lease', async () => {
    const { db, repo } = harness();
    db.effectPackagingRun.findFirst.mockResolvedValue({
      status: 'RUNNING',
      leaseExpiresAt: new Date(Date.now() + 90_000),
    });
    expect(await repo.claim('p', 'r')).toEqual({ terminal: true });
    expect(db.effectPackagingRun.update).not.toHaveBeenCalled();
  });
  it('restart recovery requeues expired runs without discarding successful checkpoints', async () => {
    const { db, repo } = harness();
    db.effectPackagingRun.findMany.mockResolvedValue([{ id: 'r', projectId: 'p' }]);
    await repo.recoverExpired();
    expect(db.jobOutbox.create).toHaveBeenCalledOnce();
    expect(db.effectPackagingItem.updateMany).not.toHaveBeenCalled();
  });
  it('cancel invalidates the attempt and only cancels unfinished items', async () => {
    const { db, repo } = harness();
    await repo.cancel('p', 'r');
    expect(db.effectPackagingRun.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ projectId: 'p', id: 'r' }),
        data: expect.objectContaining({ attemptToken: null, status: 'CANCELLED' }),
      }),
    );
    expect(db.effectPackagingItem.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { projectId: 'p', runId: 'r', status: { in: ['QUEUED', 'RUNNING'] } },
      }),
    );
  });
});
