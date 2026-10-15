import { describe, expect, it, vi } from 'vitest';

import { EffectSegmentRenderRepository } from './effect-segment-render.repository';
import * as promptQuality from '../prompt-generation/effect-prompt.quality';
import * as promptUpdate from './effect-segment-render-prompt-update';

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
  describe('confirmed read scope while another node has an isolated edit', () => {
    function contextHarness(nodeId: string, published = false) {
      const run = { id: 'draft', projectId: 'p', parentWorkflowRunId: 'parent',
        forkNodeId: nodeId, editSessionNodeId: nodeId, branchPublishedAt: published ? new Date() : null,
        editIdMap: { productIdMap: { 'parent-product': 'draft-product', 'ancestor-alias': 'draft-product' } } };
      const db = {
        workflowRun: { findFirst: vi.fn(async ({ where }) => where.projectId === 'p'
          ? where.id === 'draft' ? run : { id: 'parent' } : null) },
        effectImportProduct: { findMany: vi.fn().mockResolvedValue([{ id: 'parent-product' }]) },
      };
      const repository = new EffectSegmentRenderRepository(db as never);
      return { db, repository, run };
    }
    it.each(['SOURCE_IMPORT', 'INFORMATION_EXTRACTION', 'PROMPT_GENERATION'])(
      'keeps the confirmed parent pool visible during %s editing without publishing its draft', async (nodeId) => {
        const { repository, db } = contextHarness(nodeId);
        expect(await repository.workspaceReadContext('p', 'draft', 'draft-product')).toEqual({
          workflowRunId: 'parent', productId: 'parent-product',
        });
        expect(db.effectImportProduct.findMany).toHaveBeenCalledWith({ where: {
          projectId: 'p', workflowRunId: 'parent', id: { in: ['parent-product', 'ancestor-alias'] }, status: 'ACTIVE',
        }, select: { id: true } });
      },
    );
    it.each(['SEGMENT_RENDER', 'TEMPLATE_MIX', 'FINAL_OUTPUT'])(
      'does not redirect a %s draft away from its own tasks', async (nodeId) => {
        const { repository, db } = contextHarness(nodeId);
        expect(await repository.workspaceReadContext('p', 'draft', 'draft-product')).toEqual({
          workflowRunId: 'draft', productId: 'draft-product',
        });
        expect(db.effectImportProduct.findMany).not.toHaveBeenCalled();
      },
    );
    it('keeps saved upstream changes on their published branch', async () => {
      const { repository, db } = contextHarness('PROMPT_GENERATION', true);
      expect(await repository.workspaceReadContext('p', 'draft', 'draft-product')).toEqual({
        workflowRunId: 'draft', productId: 'draft-product',
      });
      expect(db.effectImportProduct.findMany).not.toHaveBeenCalled();
    });
    it.each([{ parents: [] }, { parents: [{ id: 'one' }, { id: 'two' }] }])('refuses an absent or ambiguous parent identity (%j)', async ({ parents }) => {
      const { repository, db } = contextHarness('PROMPT_GENERATION');
      db.effectImportProduct.findMany.mockResolvedValue(parents);
      await expect(repository.workspaceReadContext('p', 'draft', 'draft-product')).rejects.toThrow('原产品来源');
    });
    it('never resolves a parent outside the requested project', async () => {
      const { repository, db } = contextHarness('PROMPT_GENERATION');
      db.workflowRun.findFirst.mockResolvedValueOnce({ id: 'draft', parentWorkflowRunId: 'other-project-parent',
        forkNodeId: 'PROMPT_GENERATION', editIdMap: { productIdMap: { old: 'draft-product' } } } as never)
        .mockResolvedValueOnce(null);
      await expect(repository.workspaceReadContext('p', 'draft', 'draft-product')).rejects.toThrow('原产品来源');
      expect(db.effectImportProduct.findMany).not.toHaveBeenCalled();
    });
  });
  it('treats a duplicate validated commit as read-only after its manual edit already merged', async () => {
    const batch = { id: runningTask.batchId, workflowRunId: 'closed-edit', revision: 4,
      createdAt: new Date('2026-10-10T01:00:00Z'), committedAt: new Date('2026-10-10T01:01:00Z'), tasks: [] };
    const tx = { $queryRaw: vi.fn(), effectSegmentRenderBatch: { findFirst: vi.fn().mockResolvedValue(batch), update: vi.fn() },
      workingArtifact: { findMany: vi.fn().mockResolvedValue([{ id: 'pool', artifactKey: 'render-batch:product', revision: 2 }]) } };
    const commit = vi.fn();
    const repository = new EffectSegmentRenderRepository({ $transaction: (callback: (value: typeof tx) => unknown) => callback(tx) } as never,
      { commitValidatedArtifactsInTransaction: commit } as never);
    const source = { artifactId: 'source', revision: 1, contentHash: 'hash' };
    const result = await repository.commitValidatedBatch(runningTask.projectId, batch.id, 4, source, source,
      [{ artifactKey: 'render-batch:product', input: {} as never }]);
    expect(result).toMatchObject({ kind: 'COMMITTED', artifacts: [{ artifactId: 'pool', revision: 2, unchanged: true }] });
    expect(tx.effectSegmentRenderBatch.update).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });
  it('merges a restored old video as completed after a failed refresh has fully cancelled out', async () => {
    const sourcePrompt = { artifactId: 'prompt', revision: 1, contentHash: 'a'.repeat(64) };
    const snapshot = {
      sourcePrompt,
      adoptedInput: { sourcePrompt, promptId: 'prompt-item' },
      refreshContext: { schemaVersion: 1, confirmationSignature: 'signed', sourcePrompt },
    };
    const batch = {
      ...runningTask,
      id: runningTask.batchId,
      revision: 4,
      status: 'PARTIAL',
      sourcePromptArtifactId: sourcePrompt.artifactId,
      sourcePromptRevision: 1,
      sourcePromptHash: sourcePrompt.contentHash,
      tasks: [{ ...runningTask, status: 'FAILED', errorCode: 'PROVIDER_FAILURE',
        outputFileObjectId: 'old-file', requestSnapshot: snapshot, generationRequestSnapshot: snapshot }],
    };
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      effectSegmentRenderBatch: { findFirst: vi.fn().mockResolvedValue(batch), update: vi.fn() },
      effectSegmentRenderTask: { update: vi.fn() },
      workingArtifact: { findFirst: vi.fn().mockResolvedValue({ payload: {} }) },
      workflowRun: { findFirst: vi.fn().mockResolvedValue({ parentWorkflowRunId: 'parent',
        branchPublishedAt: null, editSessionNodeId: 'SEGMENT_RENDER', editSessionPurpose: 'MANUAL', editIdMap: {} }) },
    };
    const repository = new EffectSegmentRenderRepository({
      $transaction: (callback: (tx: typeof transaction) => Promise<unknown>) => callback(transaction),
    } as never, { commitValidatedArtifactsInTransaction: vi.fn().mockResolvedValue([]) } as never);
    const merge = vi.fn().mockResolvedValue({ activeWorkflowRunId: 'parent', createdBranch: false });
    const internal = repository as unknown as { applyManualRenderEditInTransaction: typeof merge };
    const mergeSpy = vi.spyOn(internal, 'applyManualRenderEditInTransaction').mockImplementation(merge);
    // Difference and payload parsing are covered separately; this test isolates commit/merge state.
    const parseSpy = vi.spyOn(promptQuality, 'parseEffectPromptBatchResult').mockReturnValueOnce({} as never);
    const differenceSpy = vi.spyOn(promptUpdate, 'renderPromptUpdateKind').mockReturnValueOnce(undefined);
    try {
      expect(await repository.commitValidatedBatch(runningTask.projectId, runningTask.batchId, 4,
        sourcePrompt, { artifactId: 'source', revision: 1, contentHash: 'b'.repeat(64) }, []))
        .toMatchObject({ kind: 'COMMITTED' });
      expect(merge.mock.calls[0]![2]).toMatchObject({ status: 'COMPLETED', activeKey: null });
      expect(transaction.effectSegmentRenderTask.update).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ status: 'COMPLETED' }),
      }));
    } finally {
      parseSpy.mockRestore();
      differenceSpy.mockRestore();
      mergeSpy.mockRestore();
    }
  });

  it.each(['ACCEPT', 'DISCARD'] as const)(
    'only adopts fractional candidate duration on %s',
    async (decision) => {
      const generationRequestSnapshot = {
        request: { duration: 15.041667 },
        importedMaterial: { schemaVersion: 1, width: 496, height: 864 },
      };
      const task = {
        ...runningTask,
        operationKind: 'REPAIR',
        status: 'COMPLETED',
        renderVersion: 2,
        activeOutputVersion: 1,
        repairSourceVersion: 1,
        repairStatus: 'READY',
        requestSnapshot: { ...generationRequestSnapshot, outputDurationSeconds: 14.9 },
        generationRequestSnapshot,
        repairCandidateFileObjectId: 'candidate',
        repairCandidateStorageKey: 'candidate-key',
        repairCandidateFileName: 'candidate.mp4',
        repairCandidateMimeType: 'video/mp4',
        repairCandidateSizeBytes: 1024,
        repairCandidateContentHash: 'c'.repeat(64),
        repairCandidateVersion: 2,
      };
      const batch = {
        id: runningTask.batchId,
        workflowRunId: runningTask.workflowRunId,
        productId: runningTask.productId,
        revision: 4,
      };
      const transaction = {
        $queryRaw: vi.fn().mockResolvedValue([]),
        effectSegmentRenderOperationReceipt: {
          findUnique: vi.fn().mockResolvedValue(null),
          create: vi.fn(),
        },
        effectSegmentRenderBatch: {
          findFirst: vi.fn().mockResolvedValue(batch),
          update: vi.fn(),
          updateMany: vi.fn(),
        },
        effectSegmentRenderTask: {
          findFirst: vi.fn().mockResolvedValue(task),
          update: vi.fn(),
          groupBy: vi.fn().mockResolvedValue([]),
        },
      };
      const repository = new EffectSegmentRenderRepository({
        $transaction: (callback: (value: typeof transaction) => Promise<unknown>) =>
          callback(transaction),
      } as never);
      expect(
        await repository.decideRepair(
          runningTask.projectId,
          runningTask.batchId,
          runningTask.id,
          4,
          2,
          decision,
          'decide-import',
        ),
      ).toEqual({ kind: 'UPDATED' });
      const update = transaction.effectSegmentRenderTask.update.mock.calls[0]![0].data;
      expect(update.generationRequestSnapshot.request.duration).toBe(15.041667);
      expect(update.generationRequestSnapshot.outputDurationSeconds).toBe(
        decision === 'ACCEPT' ? 14.9 : undefined,
      );
      expect(update.requestSnapshot).toEqual(update.generationRequestSnapshot);
      if (decision === 'DISCARD') expect(update.outputFileObjectId).toBeUndefined();
    },
  );

  it('persists fractional repair output metadata on the candidate without changing the active snapshot', async () => {
    const task = {
      ...runningTask,
      operationKind: 'REPAIR',
      requestSnapshot: { request: { duration: 15.041667 } },
      generationRequestSnapshot: { request: { duration: 15.041667 } },
    };
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      effectSegmentRenderTask: {
        findFirst: vi.fn().mockResolvedValue(task),
        update: vi.fn().mockImplementation(({ data }) => ({ ...task, ...data })),
        groupBy: vi.fn().mockResolvedValue([]),
      },
      effectSegmentRenderBatch: { update: vi.fn(), updateMany: vi.fn() },
    };
    const repository = new EffectSegmentRenderRepository(
      {
        $transaction: (callback: (value: typeof transaction) => Promise<unknown>) =>
          callback(transaction),
      } as never,
      { upsertFileObjectInTransaction: vi.fn().mockResolvedValue({ id: 'candidate' }) } as never,
    );
    await repository.complete(
      runningTask.projectId,
      runningTask.id,
      runningTask.attemptToken,
      1,
      'provider',
      {
        id: 'candidate',
        originalFileName: 'repair.mp4',
        mimeType: 'video/mp4',
        sizeBytes: 1024,
        storageKey: 'candidate-key',
        sha256: 'a'.repeat(64),
      },
      undefined,
      new Date('2026-09-03T00:01:00.000Z'),
      14.9,
    );
    const data = transaction.effectSegmentRenderTask.update.mock.calls[0]![0].data;
    expect(data.requestSnapshot.outputDurationSeconds).toBe(14.9);
    expect(data.generationRequestSnapshot).toBeUndefined();
    expect(data.outputFileObjectId).toBeUndefined();
  });
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

    expect(findFirst).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: {
          projectId: 'project',
          workflowRunId: 'child',
          productId: 'product',
          archivedAt: null,
        },
      }),
    );
    expect(findFirst).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: { projectId: 'project', id: 'batch', archivedAt: null },
      }),
    );
    expect(taskFindFirst).toHaveBeenCalledWith({
      where: { projectId: 'project', id: 'task', batch: { archivedAt: null } },
    });
  });

  it('reads ancestor media but never sibling or cross-project media', async () => {
    const fileObject = {
      findFirst: vi.fn().mockResolvedValue({ id: 'file', workflowRunId: 'root' }),
    };
    const workflowRun = {
      findFirst: vi
        .fn()
        .mockImplementation(async ({ where }: { where: { id: string } }) =>
          where.id === 'child' ? { parentWorkflowRunId: 'root' } : { parentWorkflowRunId: null },
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
        update: vi.fn().mockResolvedValue({}),
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
      $transaction: vi
        .fn()
        .mockRejectedValue(new Error('EFFECT_RENDER_BRANCH_PUBLICATION_CONFLICT')),
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
