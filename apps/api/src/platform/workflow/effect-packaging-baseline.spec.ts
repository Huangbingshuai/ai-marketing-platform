import { describe, expect, it, vi } from 'vitest';
import type { Prisma } from '../../generated/prisma/client';
import { clonePackagingRunsInTransaction } from './effect-branch-clone';

describe('packaging branch rollback baseline', () => {
  it('inherits completed films from a partial batch, never its unfinished checkpoints', async () => {
    const source = { id: 'old', templateId: 't', status: 'PARTIAL', requestHash: 'hash',
      createdAt: new Date('2026-10-01'), startedAt: null, completedAt: new Date('2026-10-02'),
      items: [
        { id: 'good', variantId: 'a', name: 'A', status: 'COMPLETED', shardIndex: 0,
          snapshot: { variant: { id: 'a' } }, checkpoint: { voices: { saved: { fileObjectId: 'voice' } } },
          files: [{ role: 'voice-saved', fileObjectId: 'voice' }], stage: 'READY' },
        { id: 'bad', variantId: 'b', status: 'FAILED', checkpoint: { musicTaskId: 'unfinished' }, files: [] },
      ] };
    const baseline = structuredClone(source);
    const tx = { effectPackagingRun: { findMany: vi.fn().mockResolvedValue([source]), createMany: vi.fn() },
      effectPackagingItem: { createMany: vi.fn() }, effectPackagingFile: { createMany: vi.fn() } };
    await clonePackagingRunsInTransaction(tx as unknown as Prisma.TransactionClient, 'p', 'parent', 'child', {}, { keyPrefix: 'edit' });
    expect(tx.effectPackagingRun.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { projectId: 'p', workflowRunId: 'parent', items: { some: { status: 'COMPLETED' } } } }));
    expect(tx.effectPackagingItem.createMany.mock.calls[0]![0].data).toHaveLength(1);
    expect(tx.effectPackagingItem.createMany.mock.calls[0]![0].data[0]).toMatchObject({ variantId: 'a',
      checkpoint: baseline.items[0]!.checkpoint, status: 'COMPLETED' });
    expect(source).toEqual(baseline);
  });
});
