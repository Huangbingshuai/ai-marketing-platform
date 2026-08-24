import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../database/prisma.service';
import { workflowStateHash } from './workflow-state-hash';
import { WorkflowWorkingRepository } from './workflow-working.repository';

describe('WorkflowWorkingRepository', () => {
  it('loads an active workflow overview with project isolation and its node states', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const repository = new WorkflowWorkingRepository({
      workflowRun: { findFirst },
    } as unknown as PrismaService);

    await repository.findActiveRunWithNodeStates('project-a', 'EFFECT', 'EFFECT');

    expect(findFirst).toHaveBeenCalledWith({
      where: {
        projectId: 'project-a',
        workflow: 'EFFECT',
        workflowSpace: 'EFFECT',
        status: 'ACTIVE',
      },
      include: { nodeStates: { orderBy: [{ savedAt: 'asc' }, { id: 'asc' }] } },
      orderBy: { createdAt: 'desc' },
    });
  });

  it('returns unchanged without incrementing revision when the canonical content hash matches', async () => {
    const current = {
      id: 'state-a',
      projectId: 'project-a',
      workflowRunId: 'run-a',
      nodeId: 'SOURCE_IMPORT',
      revision: 4,
      contentHash: 'same-hash',
    };
    const transaction = {
      workflowRun: { findFirst: vi.fn().mockResolvedValue({ id: 'run-a' }) },
      workflowNodeState: {
        findUnique: vi.fn().mockResolvedValue(current),
        update: vi.fn(),
      },
    };
    const repository = new WorkflowWorkingRepository({
      $transaction: (callback: (client: typeof transaction) => unknown) => callback(transaction),
    } as unknown as PrismaService);

    await expect(
      repository.saveNodeState(
        'project-a',
        'run-a',
        'SOURCE_IMPORT',
        'same-hash',
        { name: '产品' },
        1,
        1,
      ),
    ).resolves.toMatchObject({ record: current, unchanged: true, conflict: false });
    expect(transaction.workflowNodeState.update).not.toHaveBeenCalled();
  });

  it('rejects changed content when expectedRevision is stale', async () => {
    const current = {
      id: 'state-a',
      revision: 5,
      contentHash: 'old-hash',
      state: { name: '旧产品' },
    };
    const transaction = {
      workflowRun: { findFirst: vi.fn().mockResolvedValue({ id: 'run-a' }) },
      workflowNodeState: {
        findUnique: vi.fn().mockResolvedValue(current),
        update: vi.fn(),
      },
    };
    const repository = new WorkflowWorkingRepository({
      $transaction: (callback: (client: typeof transaction) => unknown) => callback(transaction),
    } as unknown as PrismaService);

    await expect(
      repository.saveNodeState(
        'project-a',
        'run-a',
        'SOURCE_IMPORT',
        'new-hash',
        { name: '新产品' },
        4,
        1,
      ),
    ).resolves.toMatchObject({ unchanged: false, conflict: true });
    expect(transaction.workflowNodeState.update).not.toHaveBeenCalled();
  });

  it('treats migrated state as unchanged even when its legacy hash differs', async () => {
    const state = { product: { name: '产品', tags: ['食品'] } };
    const current = {
      id: 'state-a',
      revision: 1,
      contentHash: 'legacy-migration-hash',
      state,
    };
    const transaction = {
      workflowRun: { findFirst: vi.fn().mockResolvedValue({ id: 'run-a' }) },
      workflowNodeState: {
        findUnique: vi.fn().mockResolvedValue(current),
        update: vi.fn(),
      },
    };
    const repository = new WorkflowWorkingRepository({
      $transaction: (callback: (client: typeof transaction) => unknown) => callback(transaction),
    } as unknown as PrismaService);

    const result = await repository.saveNodeState(
      'project-a',
      'run-a',
      'SOURCE_IMPORT',
      workflowStateHash(state),
      state,
      0,
      1,
    );

    expect(result).toMatchObject({ record: current, unchanged: true, conflict: false });
    expect(transaction.workflowNodeState.update).not.toHaveBeenCalled();
  });

  it('updates a matching working artifact in place and returns the replaced object key', async () => {
    const previous = { id: 'artifact-a', storageKey: '01-working/old.png' };
    const updated = { ...previous, storageKey: '01-working/new.png' };
    const transaction = {
      workflowRun: { findFirst: vi.fn().mockResolvedValue({ id: 'run-a' }) },
      workingArtifact: {
        findUnique: vi.fn().mockResolvedValue(previous),
        update: vi.fn().mockResolvedValue(updated),
        create: vi.fn(),
      },
    };
    const repository = new WorkflowWorkingRepository({
      $transaction: (callback: (client: typeof transaction) => unknown) => callback(transaction),
    } as unknown as PrismaService);

    const result = await repository.upsertArtifact(
      'project-a',
      'run-a',
      'SOURCE_IMPORT',
      'material:one',
      {
        kind: 'FILE',
        name: '主图',
        directory: 'SOURCE_MATERIALS',
        type: 'SOURCE_MATERIAL',
        storageKey: '01-working/new.png',
      },
    );

    expect(result.record.id).toBe('artifact-a');
    expect(result.previousStorageKey).toBe('01-working/old.png');
    expect(transaction.workingArtifact.create).not.toHaveBeenCalled();
    expect(transaction.workingArtifact.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'artifact-a' } }),
    );
  });
});
