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

describe('EffectTemplateMixAiRepository.hasSuccessfulRenderBatch', () => {
  it('rejects an unfinished batch without inspecting a Prompt', async () => {
    const findBatch = vi.fn().mockResolvedValue({ status: 'RUNNING' });
    const findPrompt = vi.fn();
    const repository = new EffectTemplateMixAiRepository({
      effectSegmentRenderBatch: { findFirst: findBatch },
      workingArtifact: { findFirst: findPrompt },
    } as unknown as PrismaService);

    await expect(repository.hasSuccessfulRenderBatch('project', 'run')).resolves.toBe(false);
    expect(findBatch).toHaveBeenCalledWith(expect.objectContaining({
      where: { projectId: 'project', workflowRunId: 'run', archivedAt: null },
    }));
    expect(findPrompt).not.toHaveBeenCalled();
  });

  it('requires the successful batch to use the current confirmed Prompt', async () => {
    const findPrompt = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'prompt' });
    const repository = new EffectTemplateMixAiRepository({
      effectSegmentRenderBatch: { findFirst: vi.fn().mockResolvedValue({
        status: 'COMPLETED', sourcePromptArtifactId: 'prompt',
        sourcePromptRevision: 2, sourcePromptHash: 'hash',
      }) },
      workingArtifact: { findFirst: findPrompt },
    } as unknown as PrismaService);

    await expect(repository.hasSuccessfulRenderBatch('project', 'run')).resolves.toBe(false);
    await expect(repository.hasSuccessfulRenderBatch('project', 'run')).resolves.toBe(true);
    expect(findPrompt).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({
      projectId: 'project', workflowRunId: 'run', id: 'prompt', revision: 2,
      contentHash: 'hash', freshness: 'CURRENT', availability: 'AVAILABLE',
    }) }));
  });
});

describe('EffectTemplateMixAiRepository.templateHasDownstream', () => {
  it('allows a template with no fill, packaging, output, artifact, or published branch', async () => {
    const findFill = vi.fn().mockResolvedValue(null);
    const findPackaging = vi.fn().mockResolvedValue(null);
    const findOutput = vi.fn().mockResolvedValue(null);
    const findArtifact = vi.fn().mockResolvedValue(null);
    const findBranch = vi.fn().mockResolvedValue(null);
    const repository = new EffectTemplateMixAiRepository({
      effectTemplateMixAiRun: { findFirst: findFill },
      effectPackagingRun: { findFirst: findPackaging },
      effectFinalOutputRun: { findFirst: findOutput },
      workingArtifact: { findFirst: findArtifact },
      workflowRun: { findFirst: findBranch },
    } as unknown as PrismaService);

    await expect(repository.templateHasDownstream('project', 'run', 'template')).resolves.toBe(false);
    expect(findFill).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ projectId: 'project', workflowRunId: 'run', templateId: 'template' }),
    }));
    expect(findArtifact).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ projectId: 'project', workflowRunId: 'run' }),
    }));
    expect(findBranch).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ projectId: 'project', forkTemplateId: 'template', branchPublishedAt: { not: null } }),
    }));
  });

  it('blocks deletion as soon as smart fill or any downstream record exists', async () => {
    const findFill = vi.fn().mockResolvedValue(null);
    const findPackaging = vi.fn().mockResolvedValue(null);
    const findOutput = vi.fn().mockResolvedValue(null);
    const findArtifact = vi.fn().mockResolvedValue(null);
    const findBranch = vi.fn().mockResolvedValue(null);
    const repository = new EffectTemplateMixAiRepository({
      effectTemplateMixAiRun: { findFirst: findFill },
      effectPackagingRun: { findFirst: findPackaging },
      effectFinalOutputRun: { findFirst: findOutput },
      workingArtifact: { findFirst: findArtifact },
      workflowRun: { findFirst: findBranch },
    } as unknown as PrismaService);

    for (const findRecord of [findFill, findPackaging, findOutput, findArtifact, findBranch]) {
      findRecord.mockResolvedValueOnce({ id: 'existing' });
      await expect(repository.templateHasDownstream('project', 'run', 'template')).resolves.toBe(true);
    }
  });
});

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
  it('locks active packaging and current package artifacts, but not expired packaging history', async () => {
    const prisma = {
      effectPackagingRun: {
        findMany: vi.fn().mockResolvedValue([{ templateId: 'running-template' }]),
      },
      workingArtifact: {
        findMany: vi.fn().mockResolvedValue([
          { artifactKey: 'timeline-package:completed-template:variant-1' },
        ]),
      },
    };
    const repository = new EffectTemplateMixAiRepository(prisma as unknown as PrismaService);

    await expect(repository.packagedTemplateIds('project', 'run')).resolves.toEqual([
      'running-template',
      'completed-template',
    ]);
    expect(prisma.effectPackagingRun.findMany).toHaveBeenCalledWith({
      where: { projectId: 'project', workflowRunId: 'run', status: { in: ['QUEUED', 'RUNNING'] } },
      distinct: ['templateId'],
      select: { templateId: true },
    });
    expect(prisma.workingArtifact.findMany).toHaveBeenCalledWith({
      where: {
        projectId: 'project',
        workflowRunId: 'run',
        nodeId: 'TEMPLATE_MIX',
        artifactKey: { startsWith: 'timeline-package:' },
        freshness: 'CURRENT',
        availability: 'AVAILABLE',
      },
      select: { artifactKey: true },
    });
  });
});
