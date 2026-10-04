import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../database/prisma.service';
import { workflowStateHash } from './workflow-state-hash';
import {
  inheritedEffectArtifactVisible,
  WorkflowWorkingRepository,
} from './workflow-working.repository';

const defaultExecutionInputHash =
  '0e9561cfb83d50990a103b3896fe249a11fe27fa28985448187f93ec12116d72';

describe('WorkflowWorkingRepository', () => {
  it('inherits only artifacts before the fork and isolates a template-scoped fork', () => {
    const artifact = (nodeId: string, artifactKey: string) => ({ nodeId, artifactKey });
    expect(
      inheritedEffectArtifactVisible(artifact('SOURCE_IMPORT', 'source-package:product-a'), [
        { forkNodeId: 'PROMPT_GENERATION', forkTemplateId: null },
      ]),
    ).toBe(true);
    expect(
      inheritedEffectArtifactVisible(artifact('PROMPT_GENERATION', 'prompt-batch:product-a'), [
        { forkNodeId: 'PROMPT_GENERATION', forkTemplateId: null },
      ]),
    ).toBe(false);
    expect(
      inheritedEffectArtifactVisible(artifact('TEMPLATE_MIX', 'timeline-project:template-b:01'), [
        { forkNodeId: 'TEMPLATE_MIX', forkTemplateId: 'template-a' },
      ]),
    ).toBe(true);
    expect(
      inheritedEffectArtifactVisible(artifact('TEMPLATE_MIX', 'timeline-package:template-a:01'), [
        { forkNodeId: 'TEMPLATE_MIX', forkTemplateId: 'template-a' },
      ]),
    ).toBe(false);
  });

  it('reads confirmed ancestor artifacts without exposing forked or shadowed results', async () => {
    const stamp = new Date('2026-09-28T00:00:00.000Z');
    const item = (workflowRunId: string, nodeId: string, artifactKey: string) => ({
      id: `${workflowRunId}:${artifactKey}`,
      workflowRunId,
      nodeId,
      artifactKey,
      updatedAt: stamp,
    });
    const child = {
      id: 'child',
      projectId: 'project-a',
      workflow: 'EFFECT',
      workflowSpace: 'EFFECT',
      parentWorkflowRunId: 'parent',
      forkNodeId: 'PROMPT_GENERATION',
      forkTemplateId: null,
    };
    const parent = { ...child, id: 'parent', parentWorkflowRunId: null };
    const branchRead = vi.fn().mockResolvedValue([child, parent]);
    const ancestorArtifacts = [
      item('parent', 'SOURCE_IMPORT', 'source-package:a'),
      item('parent', 'INFORMATION_EXTRACTION', 'insight:a'),
      item('parent', 'PROMPT_GENERATION', 'prompt-batch:a'),
    ];
    const findMany = vi
      .fn()
      .mockImplementation(({ where }) =>
        Promise.resolve(
          where.id ? ancestorArtifacts.filter(({ id }) => where.id.in.includes(id)) :
          where.workflowRunId === 'child'
            ? [item('child', 'SOURCE_IMPORT', 'source-package:a')]
            : ancestorArtifacts,
        ),
      );
    const repository = new WorkflowWorkingRepository({
      workflowRun: { findMany: branchRead },
      workingArtifact: { findMany },
    } as unknown as PrismaService);

    const result = await repository.listArtifacts('project-a', { workflowRunId: 'child' });

    expect(result.map(({ id }) => id)).toEqual(['child:source-package:a', 'parent:insight:a']);
    expect(branchRead).toHaveBeenCalledOnce();
    expect(branchRead).toHaveBeenCalledWith(expect.objectContaining({ where: { projectId: 'project-a' } }));
    expect(findMany).toHaveBeenCalledTimes(3);
    expect(findMany.mock.calls[1]![0]).toMatchObject({ select: { id: true, artifactKey: true } });
    expect(findMany.mock.calls[2]![0]).toMatchObject({ where: {
      projectId: 'project-a', id: { in: ['parent:insight:a'] },
    } });
  });
  it('batches deep inheritance and preserves nearest keys and every crossed template fork', async () => {
    const branches = Array.from({ length: 30 }, (_, index) => ({
      id: `branch-${index}`, workflow: 'EFFECT', workflowSpace: 'EFFECT',
      parentWorkflowRunId: index < 29 ? `branch-${index + 1}` : 'branch-0',
      forkNodeId: 'TEMPLATE_MIX',
      forkTemplateId: index === 0 ? 'a' : index === 1 ? 'b' : 'unrelated-template',
    }));
    const stamp = new Date('2026-10-04');
    const item = (branch: number, key: string) => ({
      id: `${branch}:${key}`, workflowRunId: `branch-${branch}`,
      nodeId: 'TEMPLATE_MIX', artifactKey: key, updatedAt: stamp,
    });
    const inherited = [
      item(1, 'timeline-project:a:v'), item(2, 'timeline-project:b:v'),
      item(2, 'timeline-project:c:v'), item(29, 'timeline-project:c:v'),
      item(29, 'timeline-project:d:v'),
    ];
    const findMany = vi.fn().mockImplementation(({ where }) => Promise.resolve(
      where.id ? inherited.filter((row) => where.id.in.includes(row.id)) :
        typeof where.workflowRunId === 'string' ? [] : inherited,
    ));
    const branchRead = vi.fn().mockResolvedValue(branches);
    const repository = new WorkflowWorkingRepository({
      workflowRun: { findMany: branchRead }, workingArtifact: { findMany },
    } as unknown as PrismaService);
    const result = await repository.listArtifacts('p', { workflowRunId: 'branch-0', nodeId: 'TEMPLATE_MIX' });
    expect(result.map((row) => row.id)).toEqual(['2:timeline-project:c:v', '29:timeline-project:d:v']);
    expect(branchRead).toHaveBeenCalledOnce();
    expect(findMany).toHaveBeenCalledTimes(3); // Does not grow with depth, even with a cycle.
    expect(findMany.mock.calls[1]![0].where).toMatchObject({ projectId: 'p', nodeId: 'TEMPLATE_MIX' });
    expect(findMany.mock.calls[2]![0].where.id.in).not.toContain('29:timeline-project:c:v');
  });

  it.each(['missing', 'CUSTOMIZED'])('never follows a parent outside the effect project lineage: %s', async (parent) => {
    const findMany = vi.fn().mockResolvedValue([]);
    const repository = new WorkflowWorkingRepository({
      workflowRun: { findMany: vi.fn().mockResolvedValue([
        { id: 'child', workflow: 'EFFECT', workflowSpace: 'EFFECT',
          parentWorkflowRunId: 'parent', forkNodeId: 'MANUAL_COPY', forkTemplateId: null },
        ...(parent === 'missing' ? [] : [{ id: 'parent', workflow: parent, workflowSpace: parent,
          parentWorkflowRunId: null }]),
      ]) }, workingArtifact: { findMany },
    } as unknown as PrismaService);
    expect(await repository.listArtifacts('p', { workflowRunId: 'child' })).toEqual([]);
    expect(findMany).toHaveBeenCalledOnce();
  });

  it.each(['save', 'replace', 'hash-normalization'])(
    'does not invalidate confirmed Prompt or clips for settings %s',
    async (operation) => {
      const state = { targetCount: 100 };
      const transaction = {
        workflowRun: {
          findFirst: vi.fn().mockResolvedValue({ id: 'run-a' }),
          update: vi.fn(),
        },
        workflowNodeState: {
          findUnique: vi.fn().mockResolvedValue({
            id: 'state-a',
            revision: 2,
            contentHash: operation === 'hash-normalization' ? 'new-hash' : 'old-hash',
            executionInputHash: 'old-execution',
            executionInputSchemaVersion: 1,
            state: { targetCount: 50 },
          }),
          update: vi.fn().mockResolvedValue({ id: 'state-a', revision: 3 }),
        },
        workingArtifact: { updateMany: vi.fn() },
        workingArtifactDependency: { findMany: vi.fn() },
      };
      const repository = new WorkflowWorkingRepository({
        $transaction: (callback: (client: typeof transaction) => unknown) => callback(transaction),
      } as unknown as PrismaService);
      if (operation === 'replace')
        await repository.replaceNodeState(
          'project-a',
          'run-a',
          'PROMPT_GENERATION:product-a',
          'new-hash',
          state,
          1,
          'new-execution',
          1,
        );
      else
        await repository.saveNodeState(
          'project-a',
          'run-a',
          'PROMPT_GENERATION:product-a',
          'new-hash',
          state,
          2,
          1,
          'new-execution',
          1,
        );
      expect(transaction.workflowNodeState.update).toHaveBeenCalled();
      expect(transaction.workingArtifactDependency.findMany).not.toHaveBeenCalled();
      expect(transaction.workingArtifact.updateMany).not.toHaveBeenCalled();
    },
  );

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
        activeKey: 'ACTIVE',
        status: { in: ['ACTIVE', 'PAUSED'] },
      },
      include: { nodeStates: { orderBy: [{ savedAt: 'asc' }, { id: 'asc' }] } },
      orderBy: { createdAt: 'desc' },
    });
  });

  it('loads mix drafts alongside confirmed artifacts for the project branch tree', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const repository = new WorkflowWorkingRepository({
      workflowRun: { findMany },
    } as unknown as PrismaService);

    await repository.listEffectRunBranches('project-a');

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        // Unpublished Runs come along too: the tree hides them, but they carry the ancestry a later
        // branch is drawn under and the packaging Runs its version counts through.
        where: { projectId: 'project-a', workflow: 'EFFECT', workflowSpace: 'EFFECT' },
        include: expect.objectContaining({
          nodeStates: {
            where: { nodeId: 'TEMPLATE_MIX' },
            select: { state: true },
          },
          effectTemplateMixAiRuns: {
            where: { status: 'COMPLETED', outputVariantId: { not: null } },
            // The key says whether the row is a fill this Run ran or a copy a fork carried in.
            select: { templateId: true, outputVariantId: true, idempotencyKey: true },
          },
          effectPackagingRuns: {
            select: { templateId: true, status: true, idempotencyKey: true, completedAt: true },
          },
        }),
      }),
    );
  });

  it('does not activate an unpublished temporary effect branch', async () => {
    const update = vi.fn();
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      workflowRun: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'root', activeKey: 'ACTIVE', parentWorkflowRunId: null },
          { id: 'pending', activeKey: null, parentWorkflowRunId: 'root', branchPublishedAt: null },
        ]),
        update,
      },
      effectImportWorkspace: { findFirst: vi.fn() },
    };
    const repository = new WorkflowWorkingRepository({
      $transaction: (callback: (client: typeof transaction) => unknown) => callback(transaction),
    } as unknown as PrismaService);

    await expect(repository.activateEffectRunBranch('project-a', 'pending')).resolves.toBeNull();
    expect(update).not.toHaveBeenCalled();
    expect(transaction.effectImportWorkspace.findFirst).not.toHaveBeenCalled();
  });

  it('activates a node without creating or revising node state', async () => {
    const run = { id: 'run-a', projectId: 'project-a', currentNodeId: 'INFORMATION_EXTRACTION' };
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const findFirst = vi.fn().mockResolvedValue(run);
    const repository = new WorkflowWorkingRepository({
      workflowRun: { updateMany, findFirst },
    } as unknown as PrismaService);

    await expect(
      repository.activateNode('project-a', 'run-a', 'INFORMATION_EXTRACTION'),
    ).resolves.toBe(run);
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: 'run-a',
        projectId: 'project-a',
        status: { in: ['ACTIVE', 'PAUSED'] },
      },
      data: { currentNodeId: 'INFORMATION_EXTRACTION', lastActiveAt: expect.any(Date) },
    });
    expect(findFirst).toHaveBeenCalledWith({ where: { id: 'run-a', projectId: 'project-a' } });
  });

  it('returns unchanged without incrementing revision when the canonical content hash matches', async () => {
    const current = {
      id: 'state-a',
      projectId: 'project-a',
      workflowRunId: 'run-a',
      nodeId: 'SOURCE_IMPORT',
      revision: 4,
      contentHash: 'same-hash',
      executionInputHash: defaultExecutionInputHash,
      executionInputSchemaVersion: 1,
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
      executionInputHash: defaultExecutionInputHash,
      executionInputSchemaVersion: 1,
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
          executionInputHash: 'old-execution-hash',
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
      'new-execution-hash',
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

  it('does not stale artifacts when only page recovery state changes', async () => {
    const findDependencies = vi.fn();
    const transaction = {
      workflowRun: {
        findFirst: vi.fn().mockResolvedValue({ id: 'run-a' }),
        update: vi.fn().mockResolvedValue({ id: 'run-a' }),
      },
      workflowNodeState: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'state-a',
          revision: 2,
          contentHash: 'old-page-state',
          executionInputHash: 'same-execution-hash',
          state: { page: 1, expanded: [] },
        }),
        update: vi.fn().mockResolvedValue({ id: 'state-a', revision: 3 }),
      },
      workingArtifact: { updateMany: vi.fn() },
      workingArtifactDependency: { findMany: findDependencies },
    };
    const repository = new WorkflowWorkingRepository({
      $transaction: (callback: (client: typeof transaction) => unknown) => callback(transaction),
    } as unknown as PrismaService);

    await repository.saveNodeState(
      'project-a',
      'run-a',
      'AI_INFO_EXTRACTION',
      'new-page-state',
      { page: 2, expanded: ['product-a'] },
      2,
      1,
      'same-execution-hash',
      1,
    );

    expect(findDependencies).not.toHaveBeenCalled();
    expect(transaction.workingArtifact.updateMany).not.toHaveBeenCalled();
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
      workflowRun: { findFirst: vi.fn().mockResolvedValue({ id: 'run-a', workflow: 'EFFECT', workflowSpace: 'EFFECT' }) },
      workingArtifact: {
        findUnique: vi.fn().mockResolvedValue(previous),
        findUniqueOrThrow: vi.fn().mockResolvedValue(updated),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        create: vi.fn(),
      },
      workingArtifactFile: { deleteMany: vi.fn() },
      workingArtifactDependency: { deleteMany: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
      workingArtifactRevisionSnapshot: { upsert: vi.fn().mockResolvedValue({ id: 'snapshot-a' }) },
      workingArtifactRevisionFile: { createMany: vi.fn() },
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
    expect(transaction.workingArtifactRevisionSnapshot.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ revision: 2, contentHash: 'old-hash' }),
      }),
    );
    expect(transaction.workingArtifactRevisionSnapshot.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ revision: 3 }) }),
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

  it('accepts only an ancestor Run file reference, never a sibling Run file', async () => {
    const child = {
      id: 'child', projectId: 'project-a', workflow: 'EFFECT', workflowSpace: 'EFFECT',
      parentWorkflowRunId: 'parent', forkNodeId: 'PROMPT_GENERATION', forkTemplateId: null,
    };
    const parent = { ...child, id: 'parent', parentWorkflowRunId: null };
    const fileCount = vi.fn().mockImplementation(({ where }) =>
      where.id.in.includes('ancestor-file') && where.workflowRunId.in.includes('parent') ? 1 : 0,
    );
    const transaction = {
      workflowRun: {
        findFirst: vi.fn().mockImplementation(({ where }) =>
          where.id === 'child' ? child : where.id === 'parent' ? parent : null,
        ),
      },
      fileObject: { count: fileCount },
    };
    const repository = new WorkflowWorkingRepository({} as PrismaService);
    const validate = repository as unknown as {
      validateArtifactInputsInTransaction: (
        transaction: unknown, projectId: string, workflowRunId: string,
        input: { files: Array<{ fileObjectId: string }> },
      ) => Promise<void>;
    };

    await expect(validate.validateArtifactInputsInTransaction(
      transaction, 'project-a', 'child', { files: [{ fileObjectId: 'ancestor-file' }] },
    )).resolves.toBeUndefined();
    expect(fileCount).toHaveBeenCalledWith({
      where: { projectId: 'project-a', workflowRunId: { in: ['child', 'parent'] }, id: { in: ['ancestor-file'] } },
    });
    await expect(validate.validateArtifactInputsInTransaction(
      transaction, 'project-a', 'child', { files: [{ fileObjectId: 'sibling-file' }] },
    )).rejects.toThrow('WORKING_FILE_OBJECT_NOT_FOUND');
  });

  it('rejects an ancestor artifact at or below the fork stage', async () => {
    const child = {
      id: 'child', projectId: 'project-a', workflow: 'EFFECT', workflowSpace: 'EFFECT',
      parentWorkflowRunId: 'parent', forkNodeId: 'PROMPT_GENERATION', forkTemplateId: null,
    };
    const transaction = {
      workflowRun: {
        findFirst: vi.fn().mockImplementation(({ where }) =>
          where.id === 'child' ? child : where.id === 'parent'
            ? { ...child, id: 'parent', parentWorkflowRunId: null } : null,
        ),
      },
      workingArtifact: {
        findMany: vi.fn().mockResolvedValue([{ id: 'parent-prompt', projectId: 'project-a',
          workflowRunId: 'parent', nodeId: 'PROMPT_GENERATION', artifactKey: 'prompt-batch:product',
          revision: 1 }]),
      },
    };
    const repository = new WorkflowWorkingRepository({} as PrismaService);
    const validate = repository as unknown as {
      validateArtifactInputsInTransaction: (
        transaction: unknown, projectId: string, workflowRunId: string,
        input: { dependencies: Array<{ sourceType: string; sourceArtifactId: string; sourceKey: string; sourceRevision: number }> },
      ) => Promise<void>;
    };

    await expect(validate.validateArtifactInputsInTransaction(transaction, 'project-a', 'child', {
      dependencies: [{ sourceType: 'WORKING_ARTIFACT', sourceArtifactId: 'parent-prompt',
        sourceKey: 'prompt-batch:product', sourceRevision: 1 }],
    })).rejects.toThrow('WORKING_ARTIFACT_DEPENDENCY_CONFLICT');
  });

  it('resolves a stale ancestor artifact id through the matching key in the current run', async () => {
    const child = {
      id: 'child', projectId: 'project-a', workflow: 'EFFECT', workflowSpace: 'EFFECT',
      parentWorkflowRunId: 'parent', forkNodeId: 'PROMPT_GENERATION', forkTemplateId: null,
    };
    const transaction = {
      workflowRun: {
        findFirst: vi.fn().mockImplementation(({ where }) =>
          where.id === 'child' ? child : where.id === 'parent'
            ? { ...child, id: 'parent', parentWorkflowRunId: null } : null,
        ),
      },
      workingArtifact: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'parent-source', projectId: 'project-a', workflowRunId: 'parent',
            nodeId: 'SOURCE_IMPORT', artifactKey: 'source-package:parent-product', revision: 2 },
          { id: 'child-source', projectId: 'project-a', workflowRunId: 'child',
            nodeId: 'SOURCE_IMPORT', artifactKey: 'source-package:child-product', revision: 2 },
        ]),
      },
    };
    const repository = new WorkflowWorkingRepository({} as PrismaService);
    const validate = repository as unknown as {
      validateArtifactInputsInTransaction: (
        transaction: unknown, projectId: string, workflowRunId: string,
        input: { dependencies: Array<{ sourceType: string; sourceArtifactId: string; sourceKey: string; sourceRevision: number }> },
      ) => Promise<void>;
    };

    await expect(validate.validateArtifactInputsInTransaction(transaction, 'project-a', 'child', {
      dependencies: [{ sourceType: 'WORKING_ARTIFACT', sourceArtifactId: 'parent-source',
        sourceKey: 'source-package:child-product', sourceRevision: 2 }],
    })).resolves.toBeUndefined();
    expect(transaction.workingArtifact.findMany).toHaveBeenCalledWith({
      where: { projectId: 'project-a', workflowRunId: { in: ['child', 'parent'] },
        OR: [
          { id: 'parent-source' },
          { artifactKey: { in: ['source-package:child-product', 'source-package:child-product'] } },
        ] },
    });
  });

  it('rejects a stale ancestor artifact id when the keyed artifact revision moved on', async () => {
    const child = {
      id: 'child', projectId: 'project-a', workflow: 'EFFECT', workflowSpace: 'EFFECT',
      parentWorkflowRunId: 'parent', forkNodeId: 'PROMPT_GENERATION', forkTemplateId: null,
    };
    const transaction = {
      workflowRun: {
        findFirst: vi.fn().mockImplementation(({ where }) =>
          where.id === 'child' ? child : where.id === 'parent'
            ? { ...child, id: 'parent', parentWorkflowRunId: null } : null,
        ),
      },
      workingArtifact: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'parent-source', projectId: 'project-a', workflowRunId: 'parent',
            nodeId: 'SOURCE_IMPORT', artifactKey: 'source-package:parent-product', revision: 2 },
          { id: 'child-source', projectId: 'project-a', workflowRunId: 'child',
            nodeId: 'SOURCE_IMPORT', artifactKey: 'source-package:child-product', revision: 3 },
        ]),
      },
    };
    const repository = new WorkflowWorkingRepository({} as PrismaService);
    const validate = repository as unknown as {
      validateArtifactInputsInTransaction: (
        transaction: unknown, projectId: string, workflowRunId: string,
        input: { dependencies: Array<{ sourceType: string; sourceArtifactId: string; sourceKey: string; sourceRevision: number }> },
      ) => Promise<void>;
    };

    await expect(validate.validateArtifactInputsInTransaction(transaction, 'project-a', 'child', {
      dependencies: [{ sourceType: 'WORKING_ARTIFACT', sourceArtifactId: 'parent-source',
        sourceKey: 'source-package:child-product', sourceRevision: 2 }],
    })).rejects.toThrow('WORKING_ARTIFACT_DEPENDENCY_CONFLICT');
  });

  it('reuses an ancestor media object without rewriting it and rejects sibling media', async () => {
    const existing = { id: 'file-a', workflowRunId: 'parent', storageKey: 'source/key' };
    const transaction = {
      fileObject: {
        findUnique: vi.fn().mockResolvedValue(existing),
        upsert: vi.fn(),
      },
      workflowRun: {
        findFirst: vi.fn().mockImplementation(({ where }) =>
          where.id === 'child'
            ? { id: 'child', parentWorkflowRunId: 'parent' }
            : { id: 'parent', parentWorkflowRunId: null },
        ),
      },
    };
    const repository = new WorkflowWorkingRepository({} as PrismaService);
    const input = { nodeId: 'SOURCE_IMPORT', originalFileName: 'a.png', mimeType: 'image/png',
      sizeBytes: 4, storageKey: 'source/key', sha256: 'a'.repeat(64) };
    await expect(repository.upsertFileObjectInTransaction(
      transaction as never, 'project-a', 'child', input,
    )).resolves.toEqual(existing);
    expect(transaction.fileObject.upsert).not.toHaveBeenCalled();

    transaction.fileObject.findUnique.mockResolvedValue({ ...existing, workflowRunId: 'sibling' });
    await expect(repository.upsertFileObjectInTransaction(
      transaction as never, 'project-a', 'child', input,
    )).rejects.toThrow('WORKING_FILE_OBJECT_NOT_FOUND');
  });
});
