import type { EffectTemplateMixDraft } from '@ai-marketing/contracts';
import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../../database/prisma.service';
import { workflowStateHash } from '../../../platform/workflow/workflow-state-hash';
import type { WorkflowWorkingRepository } from '../../../platform/workflow/workflow-working.repository';
import { EffectTemplateMixAiRepository } from './effect-template-mix-ai.repository';
import { pendingAddedMaterials } from './effect-template-mix-incremental';

describe('durable incremental consumption history', () => {
  it('does not make old additions pending again after more than twenty later trim tasks', async () => {
    const baseline = { id: 'baseline', templateId: 't', workflowRunId: 'r', status: 'COMPLETED',
      createdAt: new Date(1), inputSnapshot: { materials: [{ id: 'old', promptId: 'old' }] } };
    const append = { ...baseline, id: 'append', createdAt: new Date(2),
      inputSnapshot: { materials: [{ id: 'old', promptId: 'old' }, { id: 'added', promptId: 'added' }],
        incremental: { materialIds: ['added'] } }, selectionResult: [{ materialId: 'added' }] };
    const trims = Array.from({ length: 25 }, (_, i) => ({ ...baseline, id: `trim-${i}`,
      createdAt: new Date(100 - i), inputSnapshot: { trimOnly: true,
        materials: [{ id: 'old', promptId: 'old' }] }, selectionResult: [{ materialId: 'old' }] }));
    const findMany = vi.fn().mockImplementation(async ({ where, take }) => {
      const all = [...trims, append, baseline];
      return where.status === 'COMPLETED' ? all : all.slice(0, take);
    });
    const repo = new EffectTemplateMixAiRepository({ effectTemplateMixAiRun: { findMany } } as unknown as PrismaService);
    const history = await repo.listHistory('p', 'r');
    expect(history).toHaveLength(27);
    expect(await repo.listRecent('p', 'r')).toHaveLength(20);
    expect(pendingAddedMaterials('t', [
      { id: 'old', sourcePromptId: 'old', available: true },
      { id: 'replacement-of-added', sourcePromptId: 'added', available: true },
      { id: 'second-addition', sourcePromptId: 'second-addition', available: true },
    ], history)).toEqual(['second-addition']);
    expect(findMany).toHaveBeenCalledWith({ where: { projectId: 'p', workflowRunId: 'r', status: 'COMPLETED' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
  });
});

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

describe('authoritative fill source lineage', () => {
  it('uses latest confirmed sources, excluding obsolete clones and unrelated stage records', async () => {
    const sources = [
      { id: 'latest', nodeId: 'SEGMENT_RENDER', freshness: 'CURRENT', availability: 'AVAILABLE',
        metadata: { branchSourceOwner: true } },
      { id: 'copy', nodeId: 'SEGMENT_RENDER', freshness: 'CURRENT', availability: 'AVAILABLE',
        metadata: { branchSourceOwner: false } },
      { id: 'stale', nodeId: 'SEGMENT_RENDER', freshness: 'STALE', availability: 'AVAILABLE' },
      { id: 'missing', nodeId: 'SEGMENT_RENDER', freshness: 'CURRENT', availability: 'UNAVAILABLE' },
      { id: 'template', nodeId: 'TEMPLATE_MIX', freshness: 'CURRENT', availability: 'AVAILABLE' },
      { id: 'prompt', nodeId: 'PROMPT_GENERATION', freshness: 'CURRENT', availability: 'AVAILABLE' },
    ];
    const listArtifacts = vi.fn().mockResolvedValue(sources);
    const repo = new EffectTemplateMixAiRepository({} as PrismaService,
      { listArtifacts } as unknown as WorkflowWorkingRepository);
    expect((await repo.sourceArtifacts('project', 'child')).map((item) => item.id)).toEqual(['latest', 'prompt']);
    expect(listArtifacts).toHaveBeenCalledExactlyOnceWith('project', { workflowRunId: 'child' });
  });

  it.each(['current', 'changed', 'outside-lineage', 'not-frozen', 'not-selected'])(
    'authorizes only selected, frozen and current ancestor media (%s)', async (state) => {
      const artifact = { id: 'clip', nodeId: 'SEGMENT_RENDER', revision: state === 'changed' ? 3 : 2,
        contentHash: 'new-hash', storageKey: 'new.mp4', originalFileName: 'new.mp4', mimeType: 'video/mp4',
        sizeBytes: 64, freshness: 'CURRENT', availability: 'AVAILABLE', workflowRunId: 'ancestor' };
      const listArtifacts = vi.fn().mockResolvedValue(state === 'outside-lineage' ? [] : [artifact]);
      const repo = new EffectTemplateMixAiRepository({ effectTemplateMixAiRun: {
        findFirst: vi.fn().mockResolvedValue({ workflowRunId: 'child',
          selectionResult: state === 'not-selected' ? [] : [{ materialId: 'clip' }],
          inputSnapshot: { materials: state === 'not-frozen' ? [] : [{ artifactId: 'clip', artifactRevision: 2, contentHash: 'new-hash' }] },
        }),
      } } as unknown as PrismaService, { listArtifacts } as unknown as WorkflowWorkingRepository);
      const result = await repo.selectedFile('project', 'fill', 'clip', 'attempt');
      if (state === 'current') expect(result?.artifact).toBe(artifact);
      else expect(result).toBeNull();
    },
  );
});

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
    createdAt: Record<string, Date> = {},
  ) => {
    const findRun = vi.fn(async ({ where }: { where: { id: string } }) =>
      where.id in parents ? { parentWorkflowRunId: parents[where.id]!,
        createdAt: createdAt[where.id] ?? new Date('2026-10-06T00:00:00Z') } : null,
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
        completedAt: { lte: new Date('2026-10-06T00:00:00Z') },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  });

  it('keeps all inherited consumption records, with nearest classification taking precedence', async () => {
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
      { id: 'fill-far', templateId: 'template' },
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

  it('freezes each ancestor at the fork boundary, never inheriting its later APPEND', async () => {
    const parentFork = new Date('2026-10-06T00:00:00Z');
    const childFork = new Date('2026-10-06T01:00:00Z');
    const { prisma, findFills } = chain(
      { child: 'parent', parent: 'root', root: null }, {},
      { child: childFork, parent: parentFork },
    );
    const old = { id: 'original', templateId: 't', completedAt: new Date('2026-10-05T00:00:00Z') };
    const later = { id: 'parent-append', templateId: 't', completedAt: new Date('2026-10-07T00:00:00Z') };
    findFills.mockImplementation(async ({ where }) =>
      [later, old].filter(run => run.completedAt <=
        (where as typeof where & { completedAt: { lte: Date } }).completedAt.lte));
    const repository = new EffectTemplateMixAiRepository(prisma as unknown as PrismaService);
    await expect(repository.inheritedMixAiRuns('project', 'child')).resolves.toEqual([old]);
    expect(findFills.mock.calls.map(([call]) =>
      (call.where as typeof call.where & { completedAt: { lte: Date } }).completedAt.lte))
      .toEqual([childFork, parentFork]);
  });
});

describe('EffectTemplateMixAiRepository.packagedTemplateIds', () => {
  it('uses successful same-project ancestry, not current audio presence or sibling history', async () => {
    const prisma = {
      workflowRun: { findFirst: vi.fn().mockResolvedValueOnce({ parentWorkflowRunId: 'parent' })
        .mockResolvedValueOnce({ parentWorkflowRunId: null }) },
      effectPackagingRun: { findMany: vi.fn().mockResolvedValue([{ templateId: 'ever-successful' }]) },
      workingArtifact: { findMany: vi.fn().mockResolvedValue([
        { artifactKey: 'timeline-package:failed:v', payload: { voices: {} } },
        { artifactKey: 'timeline-package:legacy-success:v', payload: { voices: { line: {} } } },
      ]) },
    };
    const repo = new EffectTemplateMixAiRepository(prisma as unknown as PrismaService);
    expect(await repo.successfulPackagingTemplateIds('p', 'current')).toEqual(['ever-successful', 'legacy-success']);
    expect(prisma.effectPackagingRun.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { projectId: 'p', workflowRunId: { in: ['current', 'parent'] }, status: 'COMPLETED' },
    }));
    expect(prisma.workflowRun.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { projectId: 'p', id: 'parent', workflow: 'EFFECT', workflowSpace: 'EFFECT' },
    }));
  });
  it('does not lock editing during an append task', async () => {
    const repo = new EffectTemplateMixAiRepository({ effectTemplateMixAiRun: {
      findMany: vi.fn().mockResolvedValue([{ templateId: 'append', inputSnapshot: { incremental: {} } },
        { templateId: 'full', inputSnapshot: {} }]),
    } } as unknown as PrismaService);
    expect(await repo.lockedTemplateIds('p', 'run')).toEqual(['full']);
  });
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
