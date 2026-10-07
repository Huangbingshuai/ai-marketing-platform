import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../../database/prisma.service';
import { EffectTemplateMixAiRepository } from './effect-template-mix-ai.repository';

const harness = (status = 'RUNNING', incremental = true) => {
  const run = {
    id: 'task',
    projectId: 'project',
    workflowRunId: 'workflow',
    templateId: 'template',
    status,
    inputSnapshot: incremental ? { incremental: { materialIds: ['new'] } } : {},
  };
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    effectTemplateMixAiRun: {
      findFirst: vi.fn().mockResolvedValue(run),
      update: vi.fn().mockResolvedValue({ ...run, status: 'CANCELLED' }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    jobOutbox: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    workflowNodeState: { findUnique: vi.fn().mockResolvedValue(null), update: vi.fn() },
  };
  const prisma = {
    $transaction: (fn: (tx: unknown) => unknown) => fn(tx),
    effectTemplateMixAiRun: {
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
  };
  return {
    repo: new EffectTemplateMixAiRepository(prisma as unknown as PrismaService),
    tx,
    prisma,
    run,
  };
};

describe('cancel only current incremental task without touching existing films', () => {
  it.each(['QUEUED', 'RUNNING'])('cancels %s and invalidates late callbacks', async (status) => {
    const { repo, tx, prisma } = harness(status);
    expect((await repo.cancelAppend('project', 'task')).kind).toBe('CANCELLED');
    expect(tx.effectTemplateMixAiRun.findFirst).toHaveBeenCalledWith({
      where: { projectId: 'project', id: 'task' },
    });
    expect(tx.effectTemplateMixAiRun.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'CANCELLED',
          attemptToken: null,
          leaseExpiresAt: null,
        }),
      }),
    );
    expect(tx.workflowNodeState.update).not.toHaveBeenCalled();
    expect(await repo.progress('project', 'task', 'old-token', 'TRIMMING', 80)).toEqual({
      count: 0,
    });
    const write = prisma.effectTemplateMixAiRun.updateMany.mock.calls[0]![0];
    expect(write.where).toMatchObject({ status: 'RUNNING', attemptToken: 'old-token' });
    // A cancelled row cannot satisfy the progress/complete RUNNING guard.
  });
  it.each(['COMPLETED', 'FAILED', 'CANCELLED'])(
    'preserves the terminal result (%s)',
    async (status) => {
      const { repo, tx } = harness(status);
      expect((await repo.cancelAppend('project', 'task')).kind).toBe('TERMINAL');
      expect(tx.effectTemplateMixAiRun.update).not.toHaveBeenCalled();
    },
  );
  it('does not cancel a full fill', async () => {
    const { repo, tx } = harness('RUNNING', false);
    expect((await repo.cancelAppend('project', 'task')).kind).toBe('NOT_APPEND');
    expect(tx.effectTemplateMixAiRun.update).not.toHaveBeenCalled();
  });
  it('does not reveal or mutate another project task', async () => {
    const { repo, tx } = harness();
    tx.effectTemplateMixAiRun.findFirst.mockResolvedValue(null as never);
    expect((await repo.cancelAppend('other-project', 'task')).kind).toBe('NOT_FOUND');
    expect(tx.effectTemplateMixAiRun.update).not.toHaveBeenCalled();
  });
  it('serializes completion and failure against cancellation before checking their lease', async () => {
    const { repo, tx } = harness('CANCELLED');
    tx.effectTemplateMixAiRun.findFirst.mockResolvedValue(null as never);
    expect(
      await repo.completeWithDraft('project', 'task', 'old-token', 'new-film', [], {}, '', 1),
    ).toBe('LEASE_CONFLICT');
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.effectTemplateMixAiRun.findFirst.mock.invocationCallOrder[0]!,
    );
    expect(tx.workflowNodeState.update).not.toHaveBeenCalled();
    expect(tx.effectTemplateMixAiRun.update).not.toHaveBeenCalled();
    expect(await repo.fail('project', 'task', 'old-token', 'OLD_CALLBACK', '', true)).toBe(
      'LEASE_CONFLICT',
    );
    expect(tx.effectTemplateMixAiRun.update).not.toHaveBeenCalled();
  });
});

describe('bounded recovery for never-claimed queue deliveries', () => {
  it.each([0, 1, 2])(
    're-delivers at most twice and then fails explicitly (recovery %s)',
    async (count) => {
      const { repo, prisma, tx, run } = harness('QUEUED');
      prisma.effectTemplateMixAiRun.findMany.mockResolvedValue([
        { ...run, unclaimedRecoveryCount: count },
      ] as never);
      await repo.recoverUnclaimed(new Date('2026-10-07T00:00:00Z'));
      const write = tx.effectTemplateMixAiRun.updateMany.mock.calls[0]![0];
      expect(write.where).toMatchObject({
        projectId: 'project',
        id: 'task',
        status: 'QUEUED',
        unclaimedRecoveryCount: count,
      });
      expect(write.data.status).toBe(count < 2 ? 'QUEUED' : 'FAILED');
      expect(tx.jobOutbox.updateMany).toHaveBeenCalledTimes(count < 2 ? 1 : 0);
      expect(tx.workflowNodeState.update).not.toHaveBeenCalled();
    },
  );
  it('does not redeliver a concurrently cancelled or claimed task', async () => {
    const { repo, prisma, tx, run } = harness('QUEUED');
    prisma.effectTemplateMixAiRun.findMany.mockResolvedValue([
      { ...run, unclaimedRecoveryCount: 0 },
    ] as never);
    tx.effectTemplateMixAiRun.updateMany.mockResolvedValue({ count: 0 });
    await repo.recoverUnclaimed();
    expect(tx.jobOutbox.updateMany).not.toHaveBeenCalled();
  });
});
