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

describe('role choices during smart-fill', () => {
  it.each([false, true])(
    'preserves newer role edits and consumes only unchanged pending resets (newer=%s)',
    async (newer) => {
      const current = draft(4, 1);
      current.templates[0]!.materialRoleOverrides = { reset: null, manual: 'END' };
      current.templates[0]!.materialRoleEditVersion = newer ? 3 : 2;
      const updated = draft(5, 1);
      updated.templates[0]!.materialRoleOverrides = { manual: 'PRODUCT', reset: null };
      const { repository, transaction } = harness(current, 12);
      transaction.effectTemplateMixAiRun.findFirst.mockResolvedValue({
        workflowRunId: 'workflow-run',
        inputSnapshot: {
          materialRoleEditVersion: 2,
          materials: [{ id: 'reset' }, { id: 'manual' }],
        },
      });
      await expect(
        repository.completeWithDraft(
          'project',
          'run',
          'attempt',
          'variant',
          [],
          updated,
          workflowStateHash(updated),
          10,
          'target',
          workflowStateHash(current.templates[0]!.workspace),
        ),
      ).resolves.toBe('COMPLETED');
      const saved = transaction.workflowNodeState.update.mock.calls[0]![0].data
        .state as EffectTemplateMixDraft;
      expect(saved.templates[0]!.materialRoleOverrides).toEqual(
        newer ? { reset: null, manual: 'END' } : { manual: 'END' },
      );
      expect(saved.templates[0]!.materialRoleEditVersion).toBe(newer ? 3 : 2);
      expect(saved.templates[0]!.workspace.editVersion).toBe(5);
    },
  );
});

describe('EffectTemplateMixAiRepository.hasSuccessfulRenderBatch', () => {
  it('rejects an unfinished batch without inspecting a Prompt', async () => {
    const findBatch = vi.fn().mockResolvedValue({ status: 'RUNNING' });
    const findPrompt = vi.fn();
    const repository = new EffectTemplateMixAiRepository({
      effectSegmentRenderBatch: { findFirst: findBatch },
      workingArtifact: { findFirst: findPrompt },
    } as unknown as PrismaService);

    await expect(repository.hasSuccessfulRenderBatch('project', 'run')).resolves.toBe(false);
    expect(findBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { projectId: 'project', workflowRunId: 'run', archivedAt: null },
      }),
    );
    expect(findPrompt).not.toHaveBeenCalled();
  });

  it('requires the successful batch to use the current confirmed Prompt', async () => {
    const findPrompt = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'prompt' });
    const repository = new EffectTemplateMixAiRepository({
      effectSegmentRenderBatch: {
        findFirst: vi.fn().mockResolvedValue({
          status: 'COMPLETED',
          sourcePromptArtifactId: 'prompt',
          sourcePromptRevision: 2,
          sourcePromptHash: 'hash',
        }),
      },
      workingArtifact: { findFirst: findPrompt },
    } as unknown as PrismaService);

    await expect(repository.hasSuccessfulRenderBatch('project', 'run')).resolves.toBe(false);
    await expect(repository.hasSuccessfulRenderBatch('project', 'run')).resolves.toBe(true);
    expect(findPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          projectId: 'project',
          workflowRunId: 'run',
          id: 'prompt',
          revision: 2,
          contentHash: 'hash',
          freshness: 'CURRENT',
          availability: 'AVAILABLE',
        }),
      }),
    );
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

    await expect(repository.templateHasDownstream('project', 'run', 'template')).resolves.toBe(
      false,
    );
    expect(findFill).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          projectId: 'project',
          workflowRunId: 'run',
          templateId: 'template',
        }),
      }),
    );
    expect(findArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ projectId: 'project', workflowRunId: 'run' }),
      }),
    );
    expect(findBranch).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          projectId: 'project',
          forkTemplateId: 'template',
          branchPublishedAt: { not: null },
        }),
      }),
    );
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
      await expect(repository.templateHasDownstream('project', 'run', 'template')).resolves.toBe(
        true,
      );
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
      $transaction: (callback: (tx: typeof transaction) => Promise<unknown>) =>
        callback(transaction),
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
          samplingResult: [
            'legacy-video',
            { materialId: 'new-video', frameTimestampsSeconds: [0.5, 2.25] },
          ],
          heartbeatAt: now,
          leaseExpiresAt: expect.any(Date),
        },
      }),
    );
  });
});

describe('EffectTemplateMixAiRepository.inheritedMixAiRuns', () => {
  const chain = (
    parents: Record<string, string | null>,
    fills: Record<string, Array<{ id: string; templateId: string }>>,
  ) => {
    const findRun = vi.fn(async ({ where }: { where: { id: string } }) =>
      where.id in parents ? { parentWorkflowRunId: parents[where.id]! } : null,
    );
    const findFills = vi.fn(
      async ({ where }: { where: { workflowRunId: string } }) => fills[where.workflowRunId] ?? [],
    );
    return {
      prisma: {
        workflowRun: { findFirst: findRun },
        effectTemplateMixAiRun: { findMany: findFills },
      },
      findFills,
    };
  };

  it('carries the nearest ancestor’s fill and walks past an ancestor that never filled', async () => {
    const { prisma, findFills } = chain(
      { child: 'packager', packager: 'filler', filler: null },
      { filler: [{ id: 'fill-1', templateId: 'template' }] },
    );
    const repository = new EffectTemplateMixAiRepository(prisma as unknown as PrismaService);

    await expect(repository.inheritedMixAiRuns('project', 'child')).resolves.toEqual([
      { id: 'fill-1', templateId: 'template' },
    ]);
    expect(findFills.mock.calls.map(([call]) => call.where.workflowRunId)).toEqual([
      'packager',
      'filler',
    ]);
    expect(findFills).toHaveBeenCalledWith({
      where: {
        projectId: 'project',
        workflowRunId: 'packager',
        status: 'COMPLETED',
        outputVariantId: { not: null },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 20,
    });
  });

  it('keeps the nearest fill for a template a further ancestor also filled', async () => {
    const { prisma } = chain(
      { child: 'packager', packager: 'filler', filler: null },
      {
        packager: [{ id: 'fill-near', templateId: 'template' }],
        filler: [{ id: 'fill-far', templateId: 'template' }],
      },
    );
    const repository = new EffectTemplateMixAiRepository(prisma as unknown as PrismaService);

    await expect(repository.inheritedMixAiRuns('project', 'child')).resolves.toEqual([
      { id: 'fill-near', templateId: 'template' },
    ]);
  });

  it('collects fills for different templates across the chain', async () => {
    const { prisma } = chain(
      { child: 'packager', packager: 'filler', filler: null },
      {
        packager: [{ id: 'fill-a', templateId: 'template-a' }],
        filler: [{ id: 'fill-b', templateId: 'template-b' }],
      },
    );
    const repository = new EffectTemplateMixAiRepository(prisma as unknown as PrismaService);

    await expect(repository.inheritedMixAiRuns('project', 'child')).resolves.toEqual([
      { id: 'fill-a', templateId: 'template-a' },
      { id: 'fill-b', templateId: 'template-b' },
    ]);
  });

  it('returns nothing for a root Run', async () => {
    const { prisma, findFills } = chain({ root: null }, {});
    const repository = new EffectTemplateMixAiRepository(prisma as unknown as PrismaService);

    await expect(repository.inheritedMixAiRuns('project', 'root')).resolves.toEqual([]);
    expect(findFills).not.toHaveBeenCalled();
  });
});

describe('EffectTemplateMixAiRepository.packagedTemplateIds', () => {
  it('locks packaging history and current package artifacts for the current Run', async () => {
    const prisma = {
      effectPackagingRun: {
        findMany: vi.fn().mockResolvedValue([{ templateId: 'running-template' }]),
      },
      workingArtifact: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ artifactKey: 'timeline-package:completed-template:variant-1' }]),
      },
    };
    const repository = new EffectTemplateMixAiRepository(prisma as unknown as PrismaService);

    await expect(repository.packagedTemplateIds('project', 'run')).resolves.toEqual([
      'running-template',
      'completed-template',
    ]);
    expect(prisma.effectPackagingRun.findMany).toHaveBeenCalledWith({
      where: { projectId: 'project', workflowRunId: 'run' },
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
