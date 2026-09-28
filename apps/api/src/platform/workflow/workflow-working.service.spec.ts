import { describe, expect, it, vi } from 'vitest';
import { WorkflowWorkingService, workflowStateHash } from './workflow-working.service';

describe('workflowStateHash', () => {
  it('normalizes object key order while preserving array order', () => {
    expect(workflowStateHash({ b: 2, a: { y: 2, x: 1 } })).toBe(
      workflowStateHash({ a: { x: 1, y: 2 }, b: 2 }),
    );
    expect(workflowStateHash({ values: [1, 2] })).not.toBe(workflowStateHash({ values: [2, 1] }));
  });
});

describe('WorkflowWorkingService node activation', () => {
  it('returns the activated run without writing node state', async () => {
    const timestamp = new Date('2026-08-26T03:00:00.000Z');
    const repository = {
      activateNode: vi.fn().mockResolvedValue({
        id: 'run-a',
        projectId: 'project-a',
        workflow: 'EFFECT',
        workflowSpace: 'EFFECT',
        status: 'ACTIVE',
        currentNodeId: 'INFORMATION_EXTRACTION',
        lastActiveAt: timestamp,
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
    };
    const projects = { get: vi.fn().mockResolvedValue({ id: 'project-a' }) };
    const service = new WorkflowWorkingService(repository as never, projects as never, {} as never);

    await expect(
      service.activateNode('project-a', 'run-a', 'INFORMATION_EXTRACTION'),
    ).resolves.toEqual({
      run: expect.objectContaining({
        id: 'run-a',
        currentNodeId: 'INFORMATION_EXTRACTION',
        lastActiveAt: timestamp.toISOString(),
      }),
    });
    expect(repository.activateNode).toHaveBeenCalledWith(
      'project-a',
      'run-a',
      'INFORMATION_EXTRACTION',
    );
  });
});

describe('WorkflowWorkingService effect branch tree', () => {
  it('uses the actual revision of each mix layer and never invents one for mixed product revisions', async () => {
    const createdAt = new Date('2026-09-28T01:00:00.000Z');
    const artifacts = [
      ['SOURCE_IMPORT', 'source-package:a', 1],
      ['SOURCE_IMPORT', 'source-package:b', 3],
      ['TEMPLATE_MIX', 'mix-template:template-a', 5],
      ['TEMPLATE_MIX', 'timeline-project:template-a:variant-a', 2],
      ['TEMPLATE_MIX', 'timeline-package:template-a:variant-a', 4],
    ] as const;
    const repository = {
      listEffectRunBranches: vi.fn().mockResolvedValue([
        {
          id: 'root',
          activeKey: 'ACTIVE',
          parentWorkflowRunId: null,
          forkNodeId: null,
          forkTemplateId: null,
          branchLabel: null,
          currentNodeId: 'TEMPLATE_MIX',
          createdAt,
          updatedAt: createdAt,
          workingArtifacts: artifacts.map(([nodeId, artifactKey, revision]) => ({
            nodeId,
            artifactKey,
            revision,
            createdAt,
            freshness: 'CURRENT',
            name: artifactKey,
          })),
        },
      ]),
    };
    const service = new WorkflowWorkingService(
      repository as never,
      { get: vi.fn().mockResolvedValue({ id: 'project-a' }) } as never,
      {} as never,
    );
    const tree = await service.getEffectBranchTree('project-a');
    expect(tree.branches[0]?.nodes[0]?.revision).toBeNull();
    expect(tree.branches[0]?.nodes[0]?.revisions).toEqual([1, 3]);
    expect(tree.branches[0]?.nodes[0]?.artifactCreatedAt).toBe(createdAt.toISOString());
    expect(tree.branches[0]?.templates[0]).toMatchObject({
      templateRevision: 5,
      templateRevisions: [5],
      fillRevision: 2,
      fillRevisions: [2],
      packagingRevision: 4,
      packagingRevisions: [4],
      fillCreatedAt: createdAt.toISOString(),
      packagingCreatedAt: createdAt.toISOString(),
    });
  });

  it('shows inherited templates except the template replaced by a scoped fork', async () => {
    const createdAt = new Date('2026-09-28T01:00:00.000Z');
    const artifact = (artifactKey: string) => ({
      nodeId: 'TEMPLATE_MIX',
      artifactKey,
      freshness: 'CURRENT',
      revision: 2,
      createdAt,
      name: artifactKey,
    });
    const base = {
      projectId: 'project-a',
      workflow: 'EFFECT',
      workflowSpace: 'EFFECT',
      status: 'ACTIVE',
      currentNodeId: 'TEMPLATE_MIX',
      createdAt,
      updatedAt: createdAt,
      lastActiveAt: createdAt,
    };
    const repository = {
      listEffectRunBranches: vi.fn().mockResolvedValue([
        {
          ...base,
          id: 'root',
          activeKey: null,
          parentWorkflowRunId: null,
          forkNodeId: null,
          forkTemplateId: null,
          branchLabel: null,
          workingArtifacts: [
            artifact('mix-template:template-a'),
            artifact('mix-template:template-b'),
            artifact('timeline-project:template-b:variant-1'),
            artifact('timeline-package:template-b:variant-1'),
            { ...artifact('final-delivery:template-b'), nodeId: 'FINAL_OUTPUT' },
          ],
        },
        {
          ...base,
          id: 'child',
          activeKey: 'ACTIVE',
          parentWorkflowRunId: 'root',
          forkNodeId: 'TEMPLATE_MIX',
          forkTemplateId: 'template-a',
          branchLabel: null,
          workingArtifacts: [artifact('mix-template:template-a')],
        },
      ]),
    };
    const service = new WorkflowWorkingService(
      repository as never,
      { get: vi.fn().mockResolvedValue({ id: 'project-a' }) } as never,
      {} as never,
    );

    const tree = await service.getEffectBranchTree('project-a');

    expect(tree.branches[1]?.templates.map((template) => template.templateId)).toEqual([
      'template-a',
      'template-b',
    ]);
    expect(tree.branches[1]?.nodes[4]?.artifactCount).toBe(4);
    expect(tree.branches[1]?.forkMixStage).toBe('TEMPLATE');
    expect(tree.branches[1]?.templates[0]).toMatchObject({
      templateRevision: 2,
      fillRevision: null,
      packagingRevision: null,
    });
    expect(tree.branches[1]?.templates[1]).toMatchObject({
      templateRevision: 2,
      fillRevision: 2,
      packagingRevision: 2,
      deliveryRevision: 2,
      deliveryCount: 1,
      deliveryCreatedAt: createdAt.toISOString(),
    });
  });

  it('keeps unrelated historical runs out of the active tree', async () => {
    const createdAt = new Date('2026-09-28T01:00:00.000Z');
    const run = (id: string, parentWorkflowRunId: string | null, activeKey: string | null) => ({
      id,
      projectId: 'project-a',
      workflow: 'EFFECT',
      workflowSpace: 'EFFECT',
      status: 'ACTIVE',
      activeKey,
      parentWorkflowRunId,
      forkNodeId: null,
      forkTemplateId: null,
      branchLabel: null,
      currentNodeId: 'SOURCE_IMPORT',
      createdAt,
      updatedAt: createdAt,
      lastActiveAt: createdAt,
      workingArtifacts:
        id === 'root'
          ? [
              {
                nodeId: 'SOURCE_IMPORT',
                artifactKey: 'source-package:a',
                freshness: 'CURRENT',
                createdAt,
              },
            ]
          : [],
    });
    const repository = {
      listEffectRunBranches: vi
        .fn()
        .mockResolvedValue([
          run('history', null, null),
          run('root', null, 'ACTIVE'),
          { ...run('child', 'root', null), forkNodeId: 'PROMPT_GENERATION' },
        ]),
    };
    const service = new WorkflowWorkingService(
      repository as never,
      { get: vi.fn().mockResolvedValue({ id: 'project-a' }) } as never,
      {} as never,
    );

    const tree = await service.getEffectBranchTree('project-a');
    expect(tree.activeWorkflowRunId).toBe('root');
    expect(tree.branches.map((branch) => branch.workflowRunId)).toEqual(['root', 'child']);
    expect(tree.branches[0]?.nodes[0]).toEqual({
      nodeId: 'SOURCE_IMPORT',
      status: 'CONFIRMED',
      artifactCount: 1,
      revision: null,
      revisions: [],
      artifactCreatedAt: createdAt.toISOString(),
    });
    expect(tree.branches[1]?.nodes[0]?.status).toBe('CONFIRMED');
  });
});
