import type { EffectSegmentRenderRequestSnapshot } from '@ai-marketing/contracts';
import { describe, expect, it, vi } from 'vitest';

import { workflowStateHash } from '../../../platform/workflow/workflow-state-hash';
import { EffectSegmentRenderRepository } from './effect-segment-render.repository';

const snapshot = (): EffectSegmentRenderRequestSnapshot => ({
  promptId: 'prompt-item',
  promptCode: 'P001',
  promptText: '展示真实产品',
  primaryPurpose: 'PRODUCT_DISPLAY',
  compatiblePurposes: ['PRODUCT_DISPLAY'],
  promptContentHash: 'd'.repeat(64),
  sharedPromptHash: 'e'.repeat(64),
  renderSettingsHash: 'f'.repeat(64),
  request: {
    model: 'doubao-seedance-2-0-mini-260615',
    content: [{ type: 'text', text: '展示真实产品。' }],
    duration: 15,
    ratio: 'adaptive',
    resolution: '480p',
  },
  sourcePrompt: { artifactId: 'prompt', revision: 1, contentHash: 'a'.repeat(64) },
  sourcePackage: { artifactId: 'source', revision: 1, contentHash: 'b'.repeat(64) },
  inputImages: [
    {
      fileObjectId: 'image',
      contentHash: 'c'.repeat(64),
      originalFileName: 'product.png',
      mimeType: 'image/png',
      sizeBytes: 100,
      sortOrder: 0,
    },
  ],
});

const fixture = (taskPatch: Record<string, unknown> = {}) => {
  const input = snapshot();
  const task = {
    id: 'task',
    projectId: 'project',
    batchId: 'batch',
    promptId: input.promptId,
    status: 'FAILED',
    operationKind: 'GENERATE',
    repairStatus: null,
    errorCode: 'INTERNAL_API_ERROR',
    progress: 92,
    providerTaskId: 'provider-existing',
    outputFileObjectId: null,
    renderVersion: 1,
    requestSnapshot: input,
    generationRequestSnapshot: input,
    sourceFingerprint: workflowStateHash(input),
    ...taskPatch,
  };
  const batch = {
    id: 'batch',
    projectId: 'project',
    workflowRunId: 'run',
    productId: 'product',
    revision: 4,
  };
  const transaction = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    workflowRun: { findFirst: vi.fn().mockResolvedValue({ id: 'run', editIdMap: {} }), update: vi.fn() },
    effectSegmentRenderOperationReceipt: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
    },
    effectSegmentRenderBatch: {
      findFirst: vi.fn().mockImplementation(({ where }) => (where.activeKey ? null : batch)),
      update: vi.fn(),
    },
    workingArtifact: { findFirst: vi.fn().mockResolvedValue({ id: 'confirmed-source' }) },
    effectSegmentRenderTask: { findMany: vi.fn().mockResolvedValue([task]), update: vi.fn() },
    jobOutbox: { upsert: vi.fn() },
  };
  const repository = new EffectSegmentRenderRepository({
    $transaction: (callback: (tx: typeof transaction) => Promise<unknown>) => callback(transaction),
  } as never);
  const retry = (next = snapshot(), revision = 4) =>
    repository.regenerateTasks('project', 'batch', ['task'], revision, 'resume-key', {
      sourcePrompt: next.sourcePrompt!,
      sourcePackage: next.sourcePackage,
      taskSnapshots: { task: next },
    });
  return { retry, transaction, batch };
};

describe('segment render provider result recovery', () => {
  it('resumes the existing provider result through the same task and Outbox with a new attempt version', async () => {
    const { retry, transaction } = fixture();
    expect(await retry()).toEqual({ kind: 'UPDATED' });
    expect(transaction.effectSegmentRenderTask.update).toHaveBeenCalledWith({
      where: { projectId_id: { projectId: 'project', id: 'task' } },
      data: expect.objectContaining({
        status: 'QUEUED',
        providerTaskId: 'provider-existing',
        renderVersion: { increment: 1 },
        attemptToken: null,
        leaseExpiresAt: null,
      }),
    });
    expect(transaction.effectSegmentRenderTask.findMany).toHaveBeenCalledWith({
      where: { projectId: 'project', batchId: 'batch', id: { in: ['task'] } },
    });
    expect(transaction.jobOutbox.upsert).toHaveBeenCalledOnce();
    expect(transaction.workflowRun.update).toHaveBeenCalledWith({ where: { id: 'run' },
      data: { editIdMap: { renderProgress: { batchId: 'batch', taskIds: ['task'],
        synchronizedTaskIds: [], removedTaskIds: [] } } } });
    expect(transaction.jobOutbox.upsert.mock.calls[0]![0].update.payload).toMatchObject({
      projectId: 'project',
      runId: 'task',
      schemaVersion: 1,
    });

    const receipt = transaction.effectSegmentRenderOperationReceipt.create.mock.calls[0]![0].data;
    transaction.effectSegmentRenderOperationReceipt.findUnique.mockResolvedValue(receipt);
    expect(await retry()).toEqual({ kind: 'REPLAYED' });
    expect(transaction.effectSegmentRenderTask.update).toHaveBeenCalledOnce();
    expect(transaction.jobOutbox.upsert).toHaveBeenCalledOnce();
  });

  it.each([
    { errorCode: 'SEEDANCE_FAILED' },
    { errorCode: 'MATERIAL_DELETED' },
    { progress: 91 },
    { providerTaskId: null },
    { providerTaskId: '' },
    { outputFileObjectId: 'adopted-video' },
    { status: 'COMPLETED', outputFileObjectId: 'completed-video' },
    { operationKind: 'REPAIR' },
  ])('does not reuse a provider task for an ineligible rerender: %j', async (patch) => {
    const { retry, transaction } = fixture(patch);
    expect(await retry()).toEqual({ kind: 'UPDATED' });
    expect(
      transaction.effectSegmentRenderTask.update.mock.calls[0]![0].data.providerTaskId,
    ).toBeNull();
  });

  it('also resumes through local update when only its confirmation marker changes', async () => {
    const previous = snapshot();
    previous.refreshContext = {
      schemaVersion: 1,
      confirmationSignature: 'old-confirmation',
      sourcePrompt: previous.sourcePrompt!,
    };
    const next = snapshot();
    next.refreshContext = { ...previous.refreshContext, confirmationSignature: 'new-confirmation' };
    const { retry, transaction } = fixture({
      requestSnapshot: previous,
      generationRequestSnapshot: previous,
    });
    expect(await retry(next)).toEqual({ kind: 'UPDATED' });
    expect(transaction.effectSegmentRenderTask.update.mock.calls[0]![0].data.providerTaskId).toBe(
      'provider-existing',
    );
  });

  it.each([
    'prompt',
    'model',
    'duration',
    'ratio',
    'resolution',
    'images',
    'prompt-source',
    'product-source',
  ])('does not reuse a provider result when %s changes', async (change) => {
    const next = snapshot();
    if (change === 'prompt') next.request.content[0].text = '新的观看事件';
    if (change === 'model') next.request.model = 'different-model';
    if (change === 'duration') next.request.duration = 6;
    if (change === 'ratio') next.request.ratio = '9:16';
    if (change === 'resolution') next.request.resolution = '720p';
    if (change === 'images') next.inputImages[0]!.contentHash = 'd'.repeat(64);
    if (change === 'prompt-source') next.sourcePrompt!.revision = 2;
    if (change === 'product-source') next.sourcePackage.revision = 2;
    const { retry, transaction } = fixture();
    expect(await retry(next)).toEqual({ kind: 'UPDATED' });
    expect(
      transaction.effectSegmentRenderTask.update.mock.calls[0]![0].data.providerTaskId,
    ).toBeNull();
  });

  it('rejects a stale revision or active task before changing any task or enqueueing recovery', async () => {
    const stale = fixture();
    expect(await stale.retry(snapshot(), 3)).toEqual({ kind: 'REVISION_CONFLICT' });
    expect(stale.transaction.effectSegmentRenderTask.update).not.toHaveBeenCalled();
    expect(stale.transaction.jobOutbox.upsert).not.toHaveBeenCalled();
    const active = fixture({ status: 'RUNNING' });
    expect(await active.retry()).toEqual({ kind: 'TASK_ACTIVE' });
    expect(active.transaction.effectSegmentRenderTask.update).not.toHaveBeenCalled();
    expect(active.transaction.jobOutbox.upsert).not.toHaveBeenCalled();
  });
});
