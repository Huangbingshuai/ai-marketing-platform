import { describe, expect, it, vi } from 'vitest';
import { EffectTemplateMixAiRepository } from './effect-template-mix-ai.repository';
import { workflowStateHash } from '../../../platform/workflow/workflow-state-hash';

function harness(status = 'FAILED') {
  const workspace = { editVersion: 1, template: { slots: [] }, variants: [{ id: 'original' }] };
  const entry = { id: 'template', workspace, materialRoleEditVersion: 3 };
  const run = {
    id: 'task',
    projectId: 'project',
    workflowRunId: 'owner',
    templateId: 'template',
    status,
    attemptCount: 1,
    maxAttempts: 2,
    inputSnapshot: {
      incremental: { materialIds: ['addition'] },
      sourceOperation: { protocol: 'FROZEN_RENDER_V1' },
      workspaceHash: workflowStateHash(workspace),
      materialRoleEditVersion: 3,
    },
    trimResult: [{ id: 'successful-checkpoint' }],
  };
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    effectTemplateMixAiRun: {
      findFirst: vi.fn().mockResolvedValueOnce(run).mockResolvedValue(null),
      update: vi.fn().mockImplementation(({ data }) => ({ ...run, ...data })),
    },
    workflowNodeState: {
      findUnique: vi.fn().mockResolvedValue({ state: { templates: [entry] } }),
      update: vi.fn(),
    },
    effectPackagingRun: { count: vi.fn().mockResolvedValue(0) },
    jobOutbox: {
      findFirst: vi.fn().mockResolvedValue({ id: 'delivery' }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const prisma = { $transaction: (callback: (value: typeof tx) => unknown) => callback(tx) };
  return { repository: new EffectTemplateMixAiRepository(prisma as never), tx, run, entry };
}

describe('frozen APPEND explicit recovery', () => {
  it('reuses the same task and delivery, preserving checkpoints, original films and attempt history', async () => {
    const { repository, tx, run } = harness();
    const result = await repository.retryAppend('project', 'task');
    expect(result.kind).toBe('RETRIED');
    expect(tx.effectTemplateMixAiRun.update).toHaveBeenCalledWith({
      where: { projectId_id: { projectId: 'project', id: 'task' } },
      data: expect.objectContaining({ status: 'QUEUED', maxAttempts: 3, attemptToken: null }),
    });
    const data = tx.effectTemplateMixAiRun.update.mock.calls[0]![0].data;
    for (const field of [
      'attemptCount',
      'trimResult',
      'classificationResult',
      'samplingResult',
      'selectionResult',
      'inputSnapshot',
    ])
      expect(data).not.toHaveProperty(field);
    expect(result.run?.trimResult).toEqual(run.trimResult);
    expect(tx.workflowNodeState.update).not.toHaveBeenCalled();
    expect(tx.jobOutbox.updateMany).toHaveBeenCalledWith({
      where: { projectId: 'project', id: 'delivery' },
      data: expect.objectContaining({ status: 'PENDING' }),
    });
  });

  it.each(['QUEUED', 'RUNNING', 'COMPLETED'])(
    'replays %s without a second delivery',
    async (status) => {
      const { repository, tx } = harness(status);
      expect((await repository.retryAppend('project', 'task')).kind).toBe('REPLAYED');
      expect(tx.effectTemplateMixAiRun.update).not.toHaveBeenCalled();
      expect(tx.jobOutbox.updateMany).not.toHaveBeenCalled();
    },
  );

  it.each(['workspace', 'roles', 'deleted'])(
    'rejects changed %s without overwriting user edits',
    async (change) => {
      const { repository, tx, entry } = harness();
      if (change === 'workspace') entry.workspace.editVersion++;
      if (change === 'roles') entry.materialRoleEditVersion++;
      if (change === 'deleted') tx.workflowNodeState.findUnique.mockResolvedValue(null);
      expect((await repository.retryAppend('project', 'task')).kind).toBe('DRAFT_CONFLICT');
      expect(tx.effectTemplateMixAiRun.update).not.toHaveBeenCalled();
    },
  );

  it.each(['CANCELLED', 'legacy', 'active', 'packaging', 'delivery', 'missing'])(
    'rejects %s recovery',
    async (condition) => {
      const { repository, tx, run } = harness(condition === 'CANCELLED' ? 'CANCELLED' : 'FAILED');
      if (condition === 'legacy') run.inputSnapshot.sourceOperation.protocol = 'OLD';
      if (condition === 'active') tx.effectTemplateMixAiRun.findFirst.mockResolvedValueOnce(run);
      if (condition === 'packaging') tx.effectPackagingRun.count.mockResolvedValue(1);
      if (condition === 'delivery') tx.jobOutbox.findFirst.mockResolvedValue(null);
      if (condition === 'missing')
        tx.effectTemplateMixAiRun.findFirst.mockReset().mockResolvedValue(null);
      const expected = {
        CANCELLED: 'CANCELLED',
        legacy: 'UNSUPPORTED',
        active: 'ACTIVE_CONFLICT',
        packaging: 'PACKAGING_LOCKED',
        delivery: 'MISSING_DELIVERY',
        missing: 'NOT_FOUND',
      };
      expect((await repository.retryAppend('project', 'task')).kind).toBe(
        expected[condition as keyof typeof expected],
      );
      expect(tx.effectTemplateMixAiRun.update).not.toHaveBeenCalled();
      expect(tx.jobOutbox.updateMany).not.toHaveBeenCalled();
    },
  );
});
