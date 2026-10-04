import { describe, expect, it, vi } from 'vitest';
import { WorkflowWorkingService, workflowStateHash } from './workflow-working.service';

describe('effect mix version scopes', () => {
  const at = (minute: number) => new Date(Date.UTC(2026, 9, 4, 0, minute));
  const artifact = (key: string, minute: number, payload: unknown = null) => ({
    nodeId: key.startsWith('final-delivery:') ? 'FINAL_OUTPUT' : 'TEMPLATE_MIX',
    artifactKey: key, name: key, revision: 1, freshness: 'CURRENT',
    createdAt: at(minute), payload,
  });
  const run = (id: string, parent: string | null, minute: number,
    stage: 'TEMPLATE' | 'FILL' | 'PACKAGING' | 'DELIVERY', templateId = 'a') => ({
    id, parentWorkflowRunId: parent, activeKey: id === 'root' ? 'ACTIVE' : null,
    forkNodeId: parent ? stage === 'DELIVERY' ? 'FINAL_OUTPUT' : 'TEMPLATE_MIX' : null,
    forkTemplateId: parent ? templateId : null, branchLabel: null,
    currentNodeId: stage === 'DELIVERY' ? 'FINAL_OUTPUT' : 'TEMPLATE_MIX',
    createdAt: at(minute), updatedAt: at(minute), branchPublishedAt: at(minute),
    effectTemplateMixAiRuns: stage === 'FILL'
      ? [{ templateId, outputVariantId: 'v', idempotencyKey: `fill-${id}` }] : [],
    effectPackagingRuns: stage === 'PACKAGING'
      ? [{ templateId, status: 'COMPLETED', idempotencyKey: `package-${id}`, completedAt: at(minute) }]
      : [],
    workingArtifacts: [
      ...(stage === 'TEMPLATE' ? [artifact(`mix-template:${templateId}`, minute, { template: { name: id } })] : []),
      ...(['FILL', 'PACKAGING'].includes(stage) ? [artifact(`timeline-project:${templateId}:v`, minute)] : []),
      ...(stage === 'PACKAGING' ? [artifact(`timeline-package:${templateId}:v`, minute)] : []),
      ...(stage === 'DELIVERY' ? [artifact(`final-delivery:${templateId}`, minute)] : []),
    ],
  });
  const treeOf = async (rows: ReturnType<typeof run>[]) => {
    const service = new WorkflowWorkingService(
      { listEffectRunBranches: vi.fn().mockResolvedValue(rows) } as never,
      { get: vi.fn().mockResolvedValue({ id: 'project-a' }) } as never, {} as never,
    );
    return (await service.getEffectBranchTree('project-a')).branches;
  };

  it('numbers sibling packages together but restarts for a sibling fill', async () => {
    const branches = await treeOf([
      run('root', null, 0, 'TEMPLATE'), run('fill-1', 'root', 1, 'FILL'),
      run('package-1', 'fill-1', 2, 'PACKAGING'),
      run('package-2', 'fill-1', 3, 'PACKAGING'),
      run('fill-2', 'root', 4, 'FILL'), run('package-3', 'fill-2', 5, 'PACKAGING'),
    ]);
    expect(branches.map((b) => b.templates[0]?.fillRevision)).toEqual([null, 1, 1, 1, 2, 2]);
    expect(branches.map((b) => b.templates[0]?.packagingRevision)).toEqual([null, null, 1, 2, null, 1]);
    expect(branches[3]?.templates[0]?.packagingRevisions).toEqual([1]);
  });

  it('scopes picture-only exports to fill heads and packaged exports to package heads', async () => {
    const branches = await treeOf([
      run('root', null, 0, 'TEMPLATE'), run('fill-1', 'root', 1, 'FILL'),
      run('output-1', 'fill-1', 2, 'DELIVERY'), run('output-2', 'fill-1', 3, 'DELIVERY'),
      run('fill-2', 'root', 4, 'FILL'), run('output-3', 'fill-2', 5, 'DELIVERY'),
      run('package-1', 'fill-1', 6, 'PACKAGING'),
      run('output-4', 'package-1', 7, 'DELIVERY'), run('output-5', 'package-1', 8, 'DELIVERY'),
      run('package-2', 'fill-1', 9, 'PACKAGING'), run('output-6', 'package-2', 10, 'DELIVERY'),
    ]);
    const outputs = branches.filter((b) => b.forkNodeId === 'FINAL_OUTPUT');
    expect(outputs.map((b) => b.templates[0]?.deliveryRevision)).toEqual([1, 2, 1, 1, 2, 1]);
  });

  it('starts an in-place first package at 01 even after packages under an older fill', async () => {
    const output = run('output', 'fill-2', 5, 'DELIVERY');
    const packaged = run('unused', null, 9, 'PACKAGING');
    output.effectPackagingRuns = packaged.effectPackagingRuns;
    output.workingArtifacts.push(...packaged.workingArtifacts);
    const branches = await treeOf([
      run('root', null, 0, 'TEMPLATE'), run('fill-1', 'root', 1, 'FILL'),
      run('package-1', 'fill-1', 2, 'PACKAGING'), run('package-2', 'package-1', 3, 'PACKAGING'),
      run('fill-2', 'package-2', 4, 'FILL'), output,
    ]);
    expect(branches[5]).toMatchObject({ workflowRunId: 'output', packagingInOutputBranch: true });
    expect(branches[5]?.templates[0]).toMatchObject({
      fillRevision: 2, packagingRevision: 1, packagingRevisions: [1], deliveryRevision: 1,
    });
  });

  it('does not renumber an earlier picture-only delivery when packaging is added in place', async () => {
    const output = run('output-1', 'fill', 2, 'DELIVERY');
    const packaged = run('unused', null, 9, 'PACKAGING');
    output.effectPackagingRuns = packaged.effectPackagingRuns;
    output.workingArtifacts.push(...packaged.workingArtifacts);
    const branches = await treeOf([
      run('root', null, 0, 'TEMPLATE'), run('fill', 'root', 1, 'FILL'), output,
      run('output-2', 'fill', 3, 'DELIVERY'), run('output-3', 'output-1', 10, 'DELIVERY'),
    ]);
    expect(branches.filter((b) => b.forkNodeId === 'FINAL_OUTPUT')
      .map((b) => b.templates[0]?.deliveryRevision)).toEqual([1, 2, 1]);
  });

  it('restarts fills when the template configuration head changes and isolates template ids', async () => {
    const branches = await treeOf([
      run('root', null, 0, 'TEMPLATE'), run('fill-1', 'root', 1, 'FILL'),
      run('fill-2', 'root', 2, 'FILL'), run('template-2', 'fill-2', 3, 'TEMPLATE'),
      run('fill-3', 'template-2', 4, 'FILL'), run('template-b', 'root', 5, 'TEMPLATE', 'b'),
      run('fill-b', 'template-b', 6, 'FILL', 'b'), run('package-b', 'fill-b', 7, 'PACKAGING', 'b'),
    ]);
    expect(branches[4]?.templates.find((t) => t.templateId === 'a')?.fillRevision).toBe(1);
    expect(branches[7]?.templates.find((t) => t.templateId === 'b')).toMatchObject({
      fillRevision: 1, packagingRevision: 1,
    });
  });
});

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
  it('does not resurrect removed templates from historical branch artifacts', async () => {
    const createdAt = new Date('2026-10-04T01:00:00.000Z');
    const templateArtifact = (templateId: string, name: string) => ({
      nodeId: 'TEMPLATE_MIX',
      artifactKey: `mix-template:${templateId}`,
      revision: 1,
      createdAt,
      freshness: 'CURRENT',
      name,
      payload: { template: { name } },
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
      branchLabel: null,
      forkTemplateId: null,
      nodeStates: [],
      effectTemplateMixAiRuns: [],
      effectPackagingRuns: [],
    };
    const repository = {
      listEffectRunBranches: vi.fn().mockResolvedValue([
        {
          ...base,
          id: 'root',
          activeKey: 'ACTIVE',
          parentWorkflowRunId: null,
          forkNodeId: null,
          nodeStates: [{ state: {
            schemaVersion: 1,
            templates: [{ id: 'template-current', workspace: { template: { name: '测试1' } } }],
          } }],
          workingArtifacts: [
            templateArtifact('template-current', '测试1'),
            templateArtifact('template-removed', '测试8'),
          ],
        },
        {
          ...base,
          id: 'historical-child',
          activeKey: null,
          parentWorkflowRunId: 'root',
          forkNodeId: 'TEMPLATE_MIX',
          forkTemplateId: 'template-removed',
          branchPublishedAt: createdAt,
          workingArtifacts: [templateArtifact('template-removed', '测试8')],
        },
      ]),
    };
    const service = new WorkflowWorkingService(
      repository as never,
      { get: vi.fn().mockResolvedValue({ id: 'project-a' }) } as never,
      {} as never,
    );

    const tree = await service.getEffectBranchTree('project-a');

    expect(tree.branches.map(({ templates }) => templates.map(({ templateId }) => templateId)))
      .toEqual([['template-current'], ['template-current']]);
  });

  it('includes unconfirmed mix templates from the active run draft without creating a version', async () => {
    const createdAt = new Date('2026-09-28T01:00:00.000Z');
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
          nodeStates: [
            {
              state: {
                schemaVersion: 1,
                activeTemplateId: 'template-new',
                templates: [
                  {
                    id: 'template-new',
                    createdAt: '2026-09-27T08:00:00.000Z',
                    workspace: { template: { name: '新品跑量模板' } },
                  },
                  { id: 'template-old', workspace: { template: { name: '测试1' } } },
                ],
              },
            },
          ],
          workingArtifacts: [
            {
              nodeId: 'SEGMENT_RENDER',
              artifactKey: 'render-batch:product-a',
              revision: 1,
              createdAt,
              freshness: 'CURRENT',
              name: '已确认素材池',
            },
            {
              nodeId: 'TEMPLATE_MIX',
              artifactKey: 'mix-template:template-old',
              revision: 3,
              createdAt,
              freshness: 'CURRENT',
              name: '测试1',
            },
          ],
        },
      ]),
    };
    const service = new WorkflowWorkingService(
      repository as never,
      { get: vi.fn().mockResolvedValue({ id: 'project-a' }) } as never,
      {} as never,
    );

    const tree = await service.getEffectBranchTree('project-a');

    expect(tree.branches).toHaveLength(1);
    expect(tree.branches[0]?.templates).toEqual([
      expect.objectContaining({
        templateId: 'template-old',
        name: '测试1',
        templateRevision: 3,
        templateCreatedAt: createdAt.toISOString(),
      }),
      expect.objectContaining({
        templateId: 'template-new',
        name: '新品跑量模板',
        templateRevision: null,
        templateCreatedAt: '2026-09-27T08:00:00.000Z',
        fillRevision: null,
        packagingRevision: null,
        timelineVariantCount: 0,
      }),
    ]);
    expect(
      tree.branches[0]?.nodes.find((node) => node.nodeId === 'TEMPLATE_MIX')?.artifactCount,
    ).toBe(1);
  });

  it('includes a newly created template when a confirmed render clip exists without a batch artifact', async () => {
    const createdAt = new Date('2026-09-30T02:00:00.000Z');
    const repository = {
      listEffectRunBranches: vi.fn().mockResolvedValue([{
        id: 'root', activeKey: 'ACTIVE', parentWorkflowRunId: null, forkNodeId: null,
        forkTemplateId: null, branchLabel: null, currentNodeId: 'TEMPLATE_MIX',
        createdAt, updatedAt: createdAt,
        nodeStates: [{ state: { schemaVersion: 1, templates: [{
          id: 'template-new', createdAt: createdAt.toISOString(),
          workspace: { template: { name: '新模板' }, variants: [] },
        }] } }],
        workingArtifacts: [{
          nodeId: 'SEGMENT_RENDER', artifactKey: 'render-clip:clip-a',
          revision: 1, createdAt, freshness: 'CURRENT', name: '视频片段',
        }],
      }]),
    };
    const service = new WorkflowWorkingService(
      repository as never,
      { get: vi.fn().mockResolvedValue({ id: 'project-a' }) } as never,
      {} as never,
    );

    const tree = await service.getEffectBranchTree('project-a');

    expect(tree.branches[0]?.templates).toEqual([
      expect.objectContaining({
        templateId: 'template-new', name: '新模板', templateRevision: null,
        templateCreatedAt: createdAt.toISOString(),
      }),
    ]);
    expect(tree.branches[0]?.nodes.find((node) => node.nodeId === 'SEGMENT_RENDER')
      ?.artifactCount).toBe(1);
  });

  it('reveals a draft fill only after its completed AI output still exists in the draft', async () => {
    const createdAt = new Date('2026-09-28T01:00:00.000Z');
    const makeRun = (variantIds: string[], idempotencyKey = 'fill-new') => ({
      id: 'root',
      activeKey: 'ACTIVE',
      parentWorkflowRunId: null,
      forkNodeId: null,
      forkTemplateId: null,
      branchLabel: null,
      currentNodeId: 'TEMPLATE_MIX',
      createdAt,
      updatedAt: createdAt,
      nodeStates: [
        {
          state: {
            schemaVersion: 1,
            activeTemplateId: 'template-new',
            templates: [
              {
                id: 'template-new',
                workspace: {
                  template: { name: '新品跑量模板' },
                  variants: variantIds.map((id) => ({ id })),
                },
              },
            ],
          },
        },
      ],
      effectTemplateMixAiRuns: [
        { templateId: 'template-new', outputVariantId: 'variant-ai', idempotencyKey },
      ],
      workingArtifacts: [{
        nodeId: 'SEGMENT_RENDER', artifactKey: 'render-batch:product-a', revision: 1,
        createdAt, freshness: 'CURRENT', name: '已确认素材池',
      }],
    });
    const repository = {
      listEffectRunBranches: vi.fn().mockResolvedValue([makeRun(['variant-ai'])]),
    };
    const service = new WorkflowWorkingService(
      repository as never,
      { get: vi.fn().mockResolvedValue({ id: 'project-a' }) } as never,
      {} as never,
    );

    const filled = await service.getEffectBranchTree('project-a');
    expect(filled.branches[0]?.templates[0]).toMatchObject({
      templateRevision: null,
      templateCreatedAt: null,
      fillRevision: null,
      draftFillReady: true,
    });

    repository.listEffectRunBranches.mockResolvedValue([makeRun([])]);
    const cleared = await service.getEffectBranchTree('project-a');
    expect(cleared.branches[0]?.templates[0]?.draftFillReady).toBe(false);

    repository.listEffectRunBranches.mockResolvedValue([
      makeRun(['variant-ai'], 'inherit:child:mix:parent-fill'),
    ]);
    const inherited = await service.getEffectBranchTree('project-a');
    expect(inherited.branches[0]?.templates[0]?.draftFillReady).toBe(false);
  });

  it('keeps an early mix draft out of the version tree until render output is confirmed', async () => {
    const createdAt = new Date('2026-09-29T01:22:00.000Z');
    const repository = {
      listEffectRunBranches: vi.fn().mockResolvedValue([{
        id: 'root', activeKey: 'ACTIVE', parentWorkflowRunId: null, forkNodeId: null,
        forkTemplateId: null, branchLabel: null, currentNodeId: 'SEGMENT_RENDER',
        createdAt, updatedAt: createdAt,
        nodeStates: [{ state: { schemaVersion: 1, templates: [{
          id: 'template-new', createdAt: createdAt.toISOString(),
          workspace: { template: { name: '测试1' }, variants: [] },
        }] } }],
        workingArtifacts: [{
          nodeId: 'PROMPT_GENERATION', artifactKey: 'prompt-batch:product-a',
          revision: 2, createdAt, freshness: 'CURRENT', name: '版本02',
        }],
      }]),
    };
    const service = new WorkflowWorkingService(
      repository as never,
      { get: vi.fn().mockResolvedValue({ id: 'project-a' }) } as never,
      {} as never,
    );

    const tree = await service.getEffectBranchTree('project-a');
    expect(tree.branches[0]?.templates).toEqual([]);
  });

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
          effectTemplateMixAiRuns: [
            { templateId: 'template-a', outputVariantId: 'variant-a', idempotencyKey: 'fill-a' },
          ],
          effectPackagingRuns: [{ templateId: 'template-a', status: 'COMPLETED', idempotencyKey: 'own-package', completedAt: null }],
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
      branchPublishedAt: createdAt,
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
          effectTemplateMixAiRuns: [
            { templateId: 'template-b', outputVariantId: 'variant-1', idempotencyKey: 'fill-b' },
          ],
          effectPackagingRuns: [{ templateId: 'template-b', status: 'COMPLETED', idempotencyKey: 'own-package', completedAt: null }],
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

  it('classifies a mix fork by what the branch changed, not by the copies it re-committed', async () => {
    const createdAt = new Date('2026-09-28T01:00:00.000Z');
    const template = { name: '测试1', slots: [] };
    const artifact = (artifactKey: string, payload?: unknown) => ({
      nodeId: 'TEMPLATE_MIX',
      artifactKey,
      freshness: 'CURRENT',
      revision: 1,
      createdAt,
      name: artifactKey,
      payload: payload ?? null,
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
      activeKey: null,
      branchLabel: null,
      forkTemplateId: null,
      branchPublishedAt: createdAt,
    };
    const repository = {
      listEffectRunBranches: vi.fn().mockResolvedValue([
        {
          ...base,
          id: 'root',
          parentWorkflowRunId: null,
          forkNodeId: null,
          workingArtifacts: [artifact('mix-template:template-a', { template, workspaceVersion: 13 })],
        },
        {
          ...base,
          id: 'packaged',
          parentWorkflowRunId: 'root',
          forkNodeId: 'TEMPLATE_MIX',
          workingArtifacts: [
            artifact('mix-template:template-a', { template, workspaceVersion: 13 }),
            artifact('timeline-project:template-a:variant-1'),
            artifact('timeline-package:template-a:variant-1'),
          ],
        },
        {
          ...base,
          id: 'filled',
          parentWorkflowRunId: 'root',
          forkNodeId: 'TEMPLATE_MIX',
          workingArtifacts: [
            // A re-fill saves the draft first, so the workspace version it re-commits is one ahead
            // of its parent's even though the template itself is untouched.
            artifact('mix-template:template-a', { template, workspaceVersion: 14 }),
            artifact('timeline-project:template-a:variant-1'),
          ],
        },
        {
          ...base,
          id: 'retemplated',
          parentWorkflowRunId: 'root',
          forkNodeId: 'TEMPLATE_MIX',
          activeKey: 'ACTIVE',
          workingArtifacts: [
            artifact('mix-template:template-a', {
              template: { name: '测试1', slots: ['a'] },
              workspaceVersion: 14,
            }),
            artifact('timeline-project:template-a:variant-1'),
          ],
        },
      ]),
    };
    const service = new WorkflowWorkingService(
      repository as never,
      { get: vi.fn().mockResolvedValue({ id: 'project-a' }) } as never,
      {} as never,
    );

    const tree = await service.getEffectBranchTree('project-a');

    expect(tree.branches.map((branch) => branch.forkMixStage)).toEqual([
      null,
      'PACKAGING',
      'FILL',
      'TEMPLATE',
    ]);
  });

  it('numbers a re-filled mix layer along the branch chain instead of restarting at 01', async () => {
    const at = (minute: number) => new Date(`2026-09-29T01:${String(minute).padStart(2, '0')}:00.000Z`);
    const artifact = (artifactKey: string, createdAt: Date, revision = 1) => ({
      nodeId: 'TEMPLATE_MIX',
      artifactKey,
      freshness: 'CURRENT',
      revision,
      createdAt,
      name: artifactKey,
      payload: null,
    });
    const base = {
      projectId: 'project-a',
      workflow: 'EFFECT',
      workflowSpace: 'EFFECT',
      status: 'ACTIVE',
      currentNodeId: 'TEMPLATE_MIX',
      createdAt: at(0),
      updatedAt: at(0),
      lastActiveAt: at(0),
      activeKey: null,
      branchLabel: null,
      forkNodeId: 'TEMPLATE_MIX',
      forkTemplateId: null,
      branchPublishedAt: at(0),
    };
    // A fork never clones the mix layer, so every branch stores its own fill at revision 1. The tree
    // used to label both fills 版本01; it now numbers them by the fills along the chain. The middle
    // branch only re-packaged the timelines it inherited, so it is not a fill generation and must not
    // push the second real fill to 版本03.
    const fill = (minute: number) => artifact('timeline-project:template-a:variant-1', at(minute));
    const repository = {
      listEffectRunBranches: vi.fn().mockResolvedValue([
        {
          ...base,
          id: 'first',
          parentWorkflowRunId: null,
          forkNodeId: null,
          effectTemplateMixAiRuns: [
            { templateId: 'template-a', outputVariantId: 'variant-1', idempotencyKey: 'fill-a' },
          ],
          workingArtifacts: [artifact('mix-template:template-a', at(0)), fill(10)],
        },
        {
          ...base,
          id: 'packaged',
          parentWorkflowRunId: 'first',
          // The packaging fork carries the fills it inherited, marked so the tree does not read
          // them as a fill generation of this branch.
          effectTemplateMixAiRuns: [
            {
              templateId: 'template-a', outputVariantId: 'variant-1',
              idempotencyKey: 'inherit:packaged:mix:first-fill',
            },
          ],
          workingArtifacts: [
            artifact('mix-template:template-a', at(0)),
            fill(10),
            artifact('timeline-package:template-a:variant-1', at(20)),
          ],
        },
        {
          ...base,
          id: 'refilled',
          parentWorkflowRunId: 'packaged',
          activeKey: 'ACTIVE',
          effectTemplateMixAiRuns: [
            { templateId: 'template-a', outputVariantId: 'variant-1', idempotencyKey: 'fill-a' },
          ],
          workingArtifacts: [artifact('mix-template:template-a', at(0)), fill(30)],
        },
      ]),
    };
    const service = new WorkflowWorkingService(
      repository as never,
      { get: vi.fn().mockResolvedValue({ id: 'project-a' }) } as never,
      {} as never,
    );

    const tree = await service.getEffectBranchTree('project-a');

    expect(tree.branches.map((branch) => branch.forkMixStage)).toEqual([null, 'PACKAGING', 'FILL']);
    expect(tree.branches.map((branch) => branch.templates[0]?.fillRevision)).toEqual([1, 1, 2]);
  });

  it('restarts packaging versions under a new fill head without inheriting an old package', async () => {
    const at = (minute: number) => new Date(`2026-09-29T01:${String(minute).padStart(2, '0')}:00.000Z`);
    const artifact = (artifactKey: string, createdAt: Date, revision = 1) => ({
      nodeId: 'TEMPLATE_MIX',
      artifactKey,
      freshness: 'CURRENT',
      revision,
      createdAt,
      name: artifactKey,
      payload: null,
    });
    const base = {
      projectId: 'project-a',
      workflow: 'EFFECT',
      workflowSpace: 'EFFECT',
      status: 'ACTIVE',
      currentNodeId: 'TEMPLATE_MIX',
      createdAt: at(0),
      updatedAt: at(0),
      lastActiveAt: at(0),
      activeKey: null,
      branchLabel: null,
      forkNodeId: 'TEMPLATE_MIX',
      forkTemplateId: null,
      branchPublishedAt: at(0),
    };
    // Each fill head owns a separate set of packaging versions. A fresh fill has no package;
    // its first package must not count packages belonging to the previous fill.
    const fill = (minute: number) => artifact('timeline-project:template-a:variant-1', at(minute));
    const pack = (minute: number) => artifact('timeline-package:template-a:variant-1', at(minute));
    const repository = {
      listEffectRunBranches: vi.fn().mockResolvedValue([
        {
          ...base,
          id: 'first',
          parentWorkflowRunId: null,
          forkNodeId: null,
          effectTemplateMixAiRuns: [
            { templateId: 'template-a', outputVariantId: 'variant-1', idempotencyKey: 'fill-a' },
          ],
          workingArtifacts: [artifact('mix-template:template-a', at(0)), fill(10)],
        },
        {
          ...base,
          id: 'packaged',
          parentWorkflowRunId: 'first',
          effectPackagingRuns: [{ templateId: 'template-a', status: 'COMPLETED', idempotencyKey: 'own-package', completedAt: null }],
          workingArtifacts: [fill(10), pack(20)],
        },
        {
          ...base,
          id: 'refilled',
          parentWorkflowRunId: 'packaged',
          activeKey: 'ACTIVE',
          effectTemplateMixAiRuns: [
            { templateId: 'template-a', outputVariantId: 'variant-1', idempotencyKey: 'fill-a' },
          ],
          workingArtifacts: [fill(30)],
        },
        {
          ...base,
          id: 'repackaged',
          parentWorkflowRunId: 'refilled',
          effectPackagingRuns: [{ templateId: 'template-a', status: 'COMPLETED', idempotencyKey: 'own-package', completedAt: null }],
          workingArtifacts: [fill(30), pack(40)],
        },
      ]),
    };
    const service = new WorkflowWorkingService(
      repository as never,
      { get: vi.fn().mockResolvedValue({ id: 'project-a' }) } as never,
      {} as never,
    );

    const tree = await service.getEffectBranchTree('project-a');

    expect(tree.branches.map((branch) => branch.templates[0]?.packagingRevision)).toEqual([
      null, 1, null, 1,
    ]);
  });

  it('keeps an unpublished packaging child out of the tree without losing the branch under it', async () => {
    const at = (minute: number) => new Date(`2026-09-29T01:${String(minute).padStart(2, '0')}:00.000Z`);
    const artifact = (artifactKey: string, createdAt: Date, revision = 1) => ({
      nodeId: 'TEMPLATE_MIX',
      artifactKey,
      freshness: 'CURRENT',
      revision,
      createdAt,
      name: artifactKey,
      payload: null,
    });
    const base = {
      projectId: 'project-a',
      workflow: 'EFFECT',
      workflowSpace: 'EFFECT',
      status: 'ACTIVE',
      currentNodeId: 'TEMPLATE_MIX',
      createdAt: at(0),
      updatedAt: at(0),
      lastActiveAt: at(0),
      activeKey: null,
      branchLabel: null,
      forkNodeId: 'TEMPLATE_MIX',
      forkTemplateId: null,
    };
    // A packaging that only got some films out leaves its child unpublished and active, waiting for
    // the failed ones to be recovered. It must not show up as a version, and the branch the user
    // opens from there later has to hang off the packaging they can see rather than start a trunk.
    const fill = (minute: number) => artifact('timeline-project:template-a:variant-1', at(minute));
    const pack = (minute: number) => artifact('timeline-package:template-a:variant-1', at(minute));
    const repository = {
      listEffectRunBranches: vi.fn().mockResolvedValue([
        {
          ...base,
          id: 'first',
          parentWorkflowRunId: null,
          forkNodeId: null,
          branchPublishedAt: at(0),
          effectTemplateMixAiRuns: [
            { templateId: 'template-a', outputVariantId: 'variant-1', idempotencyKey: 'fill-a' },
          ],
          workingArtifacts: [artifact('mix-template:template-a', at(0)), fill(10)],
        },
        {
          ...base,
          id: 'packaged',
          parentWorkflowRunId: 'first',
          branchPublishedAt: at(0),
          effectTemplateMixAiRuns: [
            {
              templateId: 'template-a', outputVariantId: 'variant-1',
              idempotencyKey: 'inherit:packaged:mix:first-fill',
            },
          ],
          effectPackagingRuns: [{ templateId: 'template-a', status: 'COMPLETED', idempotencyKey: 'own-package', completedAt: null }],
          workingArtifacts: [fill(10), pack(20)],
        },
        {
          ...base,
          id: 'partial',
          parentWorkflowRunId: 'packaged',
          activeKey: 'ACTIVE',
          // Published by the rule that shipped before a partial batch stopped counting, so the
          // hidden check has to hold on its own rather than lean on the publish gate.
          branchPublishedAt: at(0),
          effectTemplateMixAiRuns: [
            {
              templateId: 'template-a', outputVariantId: 'variant-1',
              idempotencyKey: 'inherit:partial:mix:first-fill',
            },
          ],
          effectPackagingRuns: [{ templateId: 'template-a', status: 'PARTIAL' }],
          workingArtifacts: [fill(10), pack(30)],
        },
        {
          ...base,
          id: 'refilled',
          parentWorkflowRunId: 'partial',
          branchPublishedAt: at(0),
          effectTemplateMixAiRuns: [
            { templateId: 'template-a', outputVariantId: 'variant-1', idempotencyKey: 'fill-a' },
          ],
          workingArtifacts: [fill(40)],
        },
      ]),
    };
    const service = new WorkflowWorkingService(
      repository as never,
      { get: vi.fn().mockResolvedValue({ id: 'project-a' }) } as never,
      {} as never,
    );

    const tree = await service.getEffectBranchTree('project-a');

    expect(tree.branches.map((branch) => branch.workflowRunId)).toEqual([
      'first',
      'packaged',
      'refilled',
    ]);
    // The partial child is not a version. The new fill remains the second fill, but has no package.
    expect(tree.branches[2]?.parentWorkflowRunId).toBe('packaged');
    expect(tree.branches[2]?.templates[0]?.fillRevision).toBe(2);
    expect(tree.branches[2]?.templates[0]?.packagingRevision).toBeNull();
  });

  it('keeps a packaging fork that already has a whole batch in the tree', async () => {
    const createdAt = new Date('2026-09-29T01:00:00.000Z');
    const base = {
      projectId: 'project-a',
      workflow: 'EFFECT',
      workflowSpace: 'EFFECT',
      status: 'ACTIVE',
      currentNodeId: 'TEMPLATE_MIX',
      createdAt,
      updatedAt: createdAt,
      lastActiveAt: createdAt,
      activeKey: null,
      branchLabel: null,
      forkNodeId: 'TEMPLATE_MIX',
      forkTemplateId: null,
      branchPublishedAt: createdAt,
    };
    const artifact = (artifactKey: string) => ({
      nodeId: 'TEMPLATE_MIX',
      artifactKey,
      freshness: 'CURRENT',
      revision: 1,
      createdAt,
      name: artifactKey,
      payload: null,
    });
    const repository = {
      listEffectRunBranches: vi.fn().mockResolvedValue([
        { ...base, id: 'first', parentWorkflowRunId: null, forkNodeId: null, workingArtifacts: [] },
        {
          ...base,
          id: 'packaged',
          parentWorkflowRunId: 'first',
          activeKey: 'ACTIVE',
          // One template packaged whole, a second batch failed. The version the user did get must
          // not disappear from the tree while the failed one waits to be recovered.
          effectPackagingRuns: [
            { templateId: 'template-a', status: 'COMPLETED', idempotencyKey: 'own-package', completedAt: null },
            { templateId: 'template-b', status: 'PARTIAL' },
          ],
          workingArtifacts: [artifact('timeline-package:template-a:variant-1')],
        },
      ]),
    };
    const service = new WorkflowWorkingService(
      repository as never,
      { get: vi.fn().mockResolvedValue({ id: 'project-a' }) } as never,
      {} as never,
    );

    const tree = await service.getEffectBranchTree('project-a');

    expect(tree.branches.map((branch) => branch.workflowRunId)).toEqual(['first', 'packaged']);
    expect(tree.activeWorkflowRunId).toBe('packaged');
  });

  it('points the active branch at the last version the tree can draw', async () => {    const createdAt = new Date('2026-09-29T01:00:00.000Z');
    const base = {
      projectId: 'project-a',
      workflow: 'EFFECT',
      workflowSpace: 'EFFECT',
      status: 'ACTIVE',
      currentNodeId: 'TEMPLATE_MIX',
      createdAt,
      updatedAt: createdAt,
      lastActiveAt: createdAt,
      forkNodeId: 'TEMPLATE_MIX',
      forkTemplateId: null,
      branchLabel: null,
      workingArtifacts: [],
    };
    const repository = {
      listEffectRunBranches: vi.fn().mockResolvedValue([
        { ...base, id: 'root', parentWorkflowRunId: null, activeKey: null, forkNodeId: null },
        {
          ...base,
          id: 'published',
          parentWorkflowRunId: 'root',
          activeKey: null,
          branchPublishedAt: createdAt,
        },
        { ...base, id: 'partial', parentWorkflowRunId: 'published', activeKey: 'ACTIVE' },
      ]),
    };
    const service = new WorkflowWorkingService(
      repository as never,
      { get: vi.fn().mockResolvedValue({ id: 'project-a' }) } as never,
      {} as never,
    );

    const tree = await service.getEffectBranchTree('project-a');

    expect(tree.activeWorkflowRunId).toBe('published');
    expect(tree.branches.find((branch) => branch.isActive)?.workflowRunId).toBe('published');
  });

  it('keeps an inherited mix layer on its ancestor version instead of inventing a new one', async () => {
    const at = (minute: number) => new Date(`2026-09-29T01:${String(minute).padStart(2, '0')}:00.000Z`);
    const artifact = (artifactKey: string, createdAt: Date, revision = 1) => ({
      nodeId: 'TEMPLATE_MIX',
      artifactKey,
      freshness: 'CURRENT',
      revision,
      createdAt,
      name: artifactKey,
      payload: null,
    });
    const base = {
      projectId: 'project-a',
      workflow: 'EFFECT',
      workflowSpace: 'EFFECT',
      status: 'ACTIVE',
      currentNodeId: 'FINAL_OUTPUT',
      createdAt: at(0),
      updatedAt: at(0),
      lastActiveAt: at(0),
      activeKey: null,
      branchLabel: null,
      forkTemplateId: null,
      branchPublishedAt: at(0),
    };
    // An output fork clones the mix layer, so the copy keeps its ancestor's createdAt and the branch
    // must keep the ancestor's version rather than count the copy as another generation.
    const fill = (minute: number) => artifact('timeline-project:template-a:variant-1', at(minute));
    const repository = {
      listEffectRunBranches: vi.fn().mockResolvedValue([
        {
          ...base,
          id: 'filled',
          parentWorkflowRunId: null,
          forkNodeId: null,
          effectTemplateMixAiRuns: [
            { templateId: 'template-a', outputVariantId: 'variant-1', idempotencyKey: 'fill-a' },
          ],
          workingArtifacts: [artifact('mix-template:template-a', at(0)), fill(10)],
        },
        {
          ...base,
          id: 're-exported',
          parentWorkflowRunId: 'filled',
          forkNodeId: 'FINAL_OUTPUT',
          activeKey: 'ACTIVE',
          // The fork copies the fills that produced the pool it shows, and the copy is marked as
          // inherited: counting it would read the export as a fill generation of its own.
          effectTemplateMixAiRuns: [
            {
              templateId: 'template-a', outputVariantId: 'variant-1',
              idempotencyKey: 'inherit:re-exported:mix:filled-fill',
            },
          ],
          workingArtifacts: [
            artifact('mix-template:template-a', at(0)),
            fill(10),
            artifact('final-delivery:template-a', at(20)),
          ],
        },
      ]),
    };
    const service = new WorkflowWorkingService(
      repository as never,
      { get: vi.fn().mockResolvedValue({ id: 'project-a' }) } as never,
      {} as never,
    );

    const tree = await service.getEffectBranchTree('project-a');

    expect(tree.branches.map((branch) => branch.templates[0]?.fillRevision)).toEqual([1, 1]);
    expect(tree.branches.map((branch) => branch.templates[0]?.deliveryRevision)).toEqual([null, 1]);
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
      branchPublishedAt: createdAt,
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

describe('WorkflowWorkingService effect manual branch copy', () => {
  const projects = { get: vi.fn().mockResolvedValue({ id: 'project-a' }) };

  it('namespaces the caller key so a repeated request cannot create a second branch', async () => {
    const repository = { createEffectManualBranch: vi.fn().mockResolvedValue(null) };
    const service = new WorkflowWorkingService(repository as never, projects as never, {} as never);

    await expect(service.createEffectManualBranch('project-a', 'run-a', ' key-1 ')).rejects.toThrow(
      '当前分支无法复制，请先保存或取消编辑',
    );
    expect(repository.createEffectManualBranch).toHaveBeenCalledWith(
      'project-a',
      'run-a',
      'manual:run-a:key-1',
    );
  });

  it('rejects an over-long idempotency key before touching the database', async () => {
    const repository = { createEffectManualBranch: vi.fn() };
    const service = new WorkflowWorkingService(repository as never, projects as never, {} as never);

    await expect(
      service.createEffectManualBranch('project-a', 'run-a', 'x'.repeat(200)),
    ).rejects.toThrow('幂等键过长');
    expect(repository.createEffectManualBranch).not.toHaveBeenCalled();
  });
});
