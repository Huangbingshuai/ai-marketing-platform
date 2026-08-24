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
        status: { in: ['ACTIVE', 'PAUSED'] },
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

  it('marks direct and indirect dependents stale without changing their revisions', async () => {
    const updateArtifacts = vi.fn().mockResolvedValue({ count: 1 });
    const findDependencies = vi
      .fn()
      .mockResolvedValueOnce([{ dependentArtifactId: 'artifact-a' }])
      .mockResolvedValueOnce([{ dependentArtifactId: 'artifact-b' }])
      .mockResolvedValueOnce([]);
    const transaction = {
      workflowRun: {
        findFirst: vi.fn().mockResolvedValue({ id: 'run-a' }),
        update: vi.fn().mockResolvedValue({ id: 'run-a' }),
      },
      workflowNodeState: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'state-a',
          revision: 2,
          contentHash: 'old-hash',
          state: { prompt: 'old' },
        }),
        update: vi.fn().mockResolvedValue({ id: 'state-a', revision: 3 }),
      },
      workingArtifact: { updateMany: updateArtifacts },
      workingArtifactDependency: { findMany: findDependencies },
    };
    const repository = new WorkflowWorkingRepository({
      $transaction: (callback: (client: typeof transaction) => unknown) => callback(transaction),
    } as unknown as PrismaService);

    await repository.saveNodeState(
      'project-a',
      'run-a',
      'AI_INFO_EXTRACTION',
      'new-hash',
      { prompt: 'new' },
      2,
      1,
    );

    expect(updateArtifacts).toHaveBeenNthCalledWith(1, {
      where: { projectId: 'project-a', workflowRunId: 'run-a', id: { in: ['artifact-a'] } },
      data: { freshness: 'STALE' },
    });
    expect(updateArtifacts).toHaveBeenNthCalledWith(2, {
      where: { projectId: 'project-a', workflowRunId: 'run-a', id: { in: ['artifact-b'] } },
      data: { freshness: 'STALE' },
    });
  });

  it('updates a matching working artifact in place and returns the replaced object key', async () => {
    const previous = {
      id: 'artifact-a',
      storageKey: '01-working/old.png',
      revision: 2,
      contentHash: 'old-hash',
      files: [],
      dependencies: [],
    };
    const updated = { ...previous, storageKey: '01-working/new.png', revision: 3 };
    const transaction = {
      workflowRun: { findFirst: vi.fn().mockResolvedValue({ id: 'run-a' }) },
      workingArtifact: {
        findUnique: vi.fn().mockResolvedValue(previous),
        findUniqueOrThrow: vi.fn().mockResolvedValue(updated),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        create: vi.fn(),
      },
      workingArtifactFile: { deleteMany: vi.fn() },
      workingArtifactDependency: { deleteMany: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
      fileObject: { updateMany: vi.fn() },
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
    expect(transaction.workingArtifact.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'artifact-a', revision: 2 } }),
    );
  });

  it('normalizes a migrated artifact hash without changing its revision or updatedAt', async () => {
    const previous = {
      id: 'artifact-a',
      projectId: 'project-a',
      workflowRunId: 'run-a',
      nodeId: 'SOURCE_IMPORT',
      artifactKey: 'source-package:product-a',
      kind: 'STRUCTURED' as const,
      name: '产品 A 原始资料包',
      directory: 'SOURCE_MATERIALS' as const,
      type: 'SOURCE_MATERIAL' as const,
      tags: ['产品 A', '食品'],
      payload: { productId: 'product-a', productName: '产品 A', completeness: 'INCOMPLETE' },
      metadata: { productId: 'product-a', productName: '产品 A', legacyArtifactIds: ['old-a'] },
      originalFileName: null,
      mimeType: null,
      sizeBytes: null,
      storageKey: null,
      sourceRunId: null,
      sourceArtifactId: 'product-a',
      revision: 1,
      contentHash: 'legacy-migration-hash',
      freshness: 'CURRENT' as const,
      createdAt: new Date('2026-08-24T00:00:00Z'),
      updatedAt: new Date('2026-08-24T00:00:00Z'),
      files: [],
      dependencies: [],
    };
    const executeRaw = vi.fn().mockResolvedValue(1);
    const transaction = {
      workflowRun: { findFirst: vi.fn().mockResolvedValue({ id: 'run-a' }) },
      workingArtifact: {
        findUnique: vi.fn().mockResolvedValue(previous),
        updateMany: vi.fn(),
      },
      $executeRaw: executeRaw,
    };
    const repository = new WorkflowWorkingRepository({
      $transaction: (callback: (client: typeof transaction) => unknown) => callback(transaction),
    } as unknown as PrismaService);

    const result = await repository.upsertArtifact(
      'project-a',
      'run-a',
      'SOURCE_IMPORT',
      'source-package:product-a',
      {
        kind: 'STRUCTURED',
        name: '产品 A 原始资料包',
        directory: 'SOURCE_MATERIALS',
        type: 'SOURCE_MATERIAL',
        tags: ['食品', '产品 A'],
        payload: { productId: 'product-a', productName: '产品 A', completeness: 'INCOMPLETE' },
        metadata: { productId: 'product-a', productName: '产品 A' },
        sourceArtifactId: 'product-a',
      },
    );

    expect(result).toMatchObject({ unchanged: true, record: { id: 'artifact-a', revision: 1 } });
    expect(executeRaw).toHaveBeenCalledTimes(1);
    expect(transaction.workingArtifact.updateMany).not.toHaveBeenCalled();
  });
});
