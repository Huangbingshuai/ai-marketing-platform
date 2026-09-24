import type { EffectTemplateMixDraft } from '@ai-marketing/contracts';
import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../../database/prisma.service';
import { workflowStateHash } from '../../../platform/workflow/workflow-state-hash';
import { EffectTemplateMixAiRepository } from './effect-template-mix-ai.repository';

const entry = (id: string, editVersion: number) => ({
  id,
  workspace: {
    editVersion,
    template: { name: id, editVersion, slots: [] },
    variants: [],
  },
});

const draft = (targetVersion: number, otherVersion: number): EffectTemplateMixDraft => ({
  schemaVersion: 1,
  activeTemplateId: 'target',
  templates: [entry('target', targetVersion), entry('other', otherVersion)],
});

const harness = (current: EffectTemplateMixDraft, revision: number) => {
  const transaction = {
    effectTemplateMixAiRun: {
      findFirst: vi.fn().mockResolvedValue({ workflowRunId: 'workflow-run' }),
      update: vi.fn().mockResolvedValue({}),
    },
    $queryRaw: vi.fn().mockResolvedValue([{ id: 'node-state' }]),
    workflowNodeState: {
      findUnique: vi.fn().mockResolvedValue({
        id: 'node-state',
        revision,
        state: current,
        contentHash: workflowStateHash(current),
      }),
      update: vi.fn().mockResolvedValue({}),
    },
    workflowRun: { update: vi.fn().mockResolvedValue({}) },
  };
  const prisma = {
    $transaction: (callback: (tx: typeof transaction) => Promise<unknown>) => callback(transaction),
  };
  return {
    repository: new EffectTemplateMixAiRepository(prisma as unknown as PrismaService),
    transaction,
  };
};

describe('EffectTemplateMixAiRepository.completeWithDraft', () => {
  it('merges one completed template without discarding unrelated draft edits', async () => {
    const original = draft(4, 2);
    const current = draft(4, 3);
    const completed = draft(5, 2);
    const { repository, transaction } = harness(current, 12);

    const result = await repository.completeWithDraft(
      'project',
      'run',
      'attempt',
      'variant',
      [],
      completed,
      workflowStateHash(completed),
      10,
      'target',
      workflowStateHash(original.templates[0]!.workspace),
    );

    expect(result).toBe('COMPLETED');
    const saved = transaction.workflowNodeState.update.mock.calls[0]![0].data
      .state as EffectTemplateMixDraft;
    expect(saved.templates[0]!.workspace.editVersion).toBe(5);
    expect(saved.templates[1]!.workspace.editVersion).toBe(3);
    expect(transaction.workflowNodeState.update.mock.calls[0]![0].data.contentHash).toBe(
      workflowStateHash(saved),
    );
  });

  it('rejects a changed target template even when the global revision is unchanged', async () => {
    const original = draft(4, 2);
    const { repository, transaction } = harness(draft(5, 2), 10);

    const result = await repository.completeWithDraft(
      'project',
      'run',
      'attempt',
      'variant',
      [],
      draft(6, 2),
      workflowStateHash(draft(6, 2)),
      10,
      'target',
      workflowStateHash(original.templates[0]!.workspace),
    );

    expect(result).toBe('DRAFT_CONFLICT');
    expect(transaction.workflowNodeState.update).not.toHaveBeenCalled();
    expect(transaction.effectTemplateMixAiRun.update).not.toHaveBeenCalled();
  });

  it('keeps global revision protection for legacy snapshots without a workspace hash', async () => {
    const original = draft(4, 2);
    const { repository, transaction } = harness(original, 11);

    const result = await repository.completeWithDraft(
      'project',
      'run',
      'attempt',
      'variant',
      [],
      draft(5, 2),
      workflowStateHash(draft(5, 2)),
      10,
    );

    expect(result).toBe('DRAFT_CONFLICT');
    expect(transaction.workflowNodeState.update).not.toHaveBeenCalled();
  });
});

describe('EffectTemplateMixAiRepository.saveSamplingCheckpoint', () => {
  it('merges per-video timestamps while preserving prior legacy checkpoints', async () => {
    const now = new Date('2026-09-23T04:00:00.000Z');
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      effectTemplateMixAiRun: {
        findFirst: vi.fn().mockResolvedValue({
          selectionResult: [{ materialId: 'legacy-video' }, { materialId: 'new-video' }],
          samplingResult: ['legacy-video'],
        }),
        update: vi.fn().mockResolvedValue({}),
      },
    };
    const prisma = {
      $transaction: (callback: (tx: typeof transaction) => Promise<unknown>) => callback(transaction),
    };
    const repository = new EffectTemplateMixAiRepository(prisma as unknown as PrismaService);

    await expect(
      repository.saveSamplingCheckpoint(
        'project',
        'run',
        'attempt',
        [{ materialId: 'new-video', frameTimestampsSeconds: [0.5, 2.25] }],
        now,
      ),
    ).resolves.toEqual({
      kind: 'SAVED',
      materialIds: ['legacy-video', 'new-video'],
      samples: [{ materialId: 'new-video', frameTimestampsSeconds: [0.5, 2.25] }],
    });
    expect(transaction.effectTemplateMixAiRun.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          samplingResult: ['legacy-video', { materialId: 'new-video', frameTimestampsSeconds: [0.5, 2.25] }],
          heartbeatAt: now,
          leaseExpiresAt: expect.any(Date),
        },
      }),
    );
  });
});

describe('EffectTemplateMixAiRepository.packagedTemplateIds', () => {
  it('keeps the template locked after any packaging run has started', async () => {
    const prisma = {
      effectPackagingRun: {
        findMany: vi.fn().mockResolvedValue([
          { templateId: 'running-template' },
          { templateId: 'completed-template' },
          { templateId: 'failed-template' },
        ]),
      },
    };
    const repository = new EffectTemplateMixAiRepository(prisma as unknown as PrismaService);

    await expect(repository.packagedTemplateIds('project', 'run')).resolves.toEqual([
      'running-template',
      'completed-template',
      'failed-template',
    ]);
    expect(prisma.effectPackagingRun.findMany).toHaveBeenCalledWith({
      where: { projectId: 'project', workflowRunId: 'run' },
      distinct: ['templateId'],
      select: { templateId: true },
    });
  });
});
