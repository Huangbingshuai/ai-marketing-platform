import {
  EFFECT_WORKFLOW_BRANCH_NODES,
  type EffectWorkflowBranch,
  type EffectWorkflowBranchNodeId,
} from '@ai-marketing/contracts';
import { describe, expect, it } from 'vitest';
import treeSource from './EffectWorkflowBranchTree.vue?raw';
import {
  BRANCH_TREE_LEAF_GAP,
  BRANCH_TREE_NODE_HEIGHT,
  BRANCH_TREE_STAGES,
  buildEffectBranchLayout,
} from './effect-workflow-branch-layout';

const branch = (
  id: string,
  parentWorkflowRunId: string | null,
  forkNodeId: EffectWorkflowBranchNodeId | null,
  isActive = false,
): EffectWorkflowBranch => ({
  workflowRunId: id,
  parentWorkflowRunId,
  forkNodeId,
  forkTemplateId: null,
  label: id,
  currentNodeId: 'PROMPT_GENERATION',
  createdAt: '2026-09-28T00:00:00.000Z',
  isActive,
  templates: [
    {
      templateId: 'template-a',
      name: '测试 A',
      templateCreatedAt: '2026-09-26T00:00:00.000Z',
      templateRevision: 2,
      fillRevision: 3,
      fillCreatedAt: '2026-09-27T00:00:00.000Z',
      packagingRevision: 4,
      packagingCreatedAt: '2026-09-28T00:00:00.000Z',
      timelineVariantCount: 1,
      packagingVariantCount: 1,
      deliveryRevision: 5,
      deliveryCount: 1,
    },
  ],
  nodes: EFFECT_WORKFLOW_BRANCH_NODES.map((nodeId, index) => ({
    nodeId,
    status: 'CONFIRMED',
    artifactCount: 1,
    revision: index + 1,
    artifactCreatedAt: `2026-09-${String(index + 20).padStart(2, '0')}T00:00:00.000Z`,
  })),
});

describe('effect workflow branch tree layout', () => {
  it('highlights all template paths in configuration and only the opened template in its editor', () => {
    const main = branch('main', null, null, true);
    main.currentNodeId = 'TEMPLATE_MIX';
    main.templates.push({
      ...main.templates[0]!,
      templateId: 'template-b',
      name: '测试 B',
    });

    const configLayout = buildEffectBranchLayout([main]);
    expect(configLayout.nodes.filter((node) => node.stageKey === 'MIX_TEMPLATE' &&
      node.onActivePath).map((node) => node.templateId)).toEqual(['template-a', 'template-b']);

    const editorLayout = buildEffectBranchLayout([main], 'template-b');
    expect(editorLayout.nodes.filter((node) => node.stageIndex < 4)
      .every((node) => node.onActivePath)).toBe(true);
    expect(editorLayout.nodes.filter((node) => node.stageIndex >= 4 && node.onActivePath)
      .every((node) => node.templateId === 'template-b')).toBe(true);
    expect(editorLayout.nodes.filter((node) => node.templateId === 'template-a')
      .every((node) => !node.onActivePath && !node.isCurrentStage)).toBe(true);
    expect(editorLayout.edges.filter((edge) => edge.key.includes('template-a'))
      .every((edge) => !edge.onActivePath)).toBe(true);
    expect(editorLayout.edges.filter((edge) => edge.key.includes('template-b'))
      .some((edge) => edge.onActivePath)).toBe(true);
  });

  it('highlights each template latest path without selecting older sibling versions', () => {
    const main = branch('main', null, null, true);
    main.currentNodeId = 'TEMPLATE_MIX';
    main.templates.push({ ...main.templates[0]!, templateId: 'template-b', name: '测试 B' });
    const fillA = branch('fill-a', 'main', 'TEMPLATE_MIX');
    fillA.forkMixStage = 'FILL';
    fillA.forkTemplateId = 'template-a';
    const packageA = branch('package-a', 'fill-a', 'TEMPLATE_MIX');
    packageA.forkMixStage = 'PACKAGING';
    packageA.forkTemplateId = 'template-a';
    const unrelated = branch('other-upstream', null, null);

    const configLayout = buildEffectBranchLayout([main, fillA, packageA, unrelated]);
    expect(configLayout.nodes.filter((node) => node.templateId === 'template-a' &&
      node.workflowRunId === 'main' && node.stageKey === 'MIX_TEMPLATE')
      .every((node) => node.onActivePath)).toBe(true);
    expect(configLayout.nodes.find((node) =>
      node.key === 'fill-a:MIX_FILL:template-a')?.onActivePath).toBe(true);
    expect(configLayout.nodes.find((node) =>
      node.key === 'package-a:MIX_PACKAGING:template-a')?.onActivePath).toBe(true);
    expect(configLayout.nodes.find((node) =>
      node.key === 'fill-a:MIX_PACKAGING:template-a')?.onActivePath).toBe(false);
    expect(configLayout.nodes.filter((node) => node.templateId === 'template-b' &&
      node.workflowRunId === 'main').every((node) => node.onActivePath)).toBe(true);
    expect(configLayout.nodes.filter((node) => node.workflowRunId === 'other-upstream')
      .every((node) => !node.onActivePath)).toBe(true);
    expect(configLayout.edges.find((edge) => edge.key ===
      'main:MIX_TEMPLATE:template-a->fill-a:MIX_FILL:template-a')?.onActivePath).toBe(true);
    expect(configLayout.edges.find((edge) => edge.key ===
      'fill-a:MIX_FILL:template-a->package-a:MIX_PACKAGING:template-a')?.onActivePath)
      .toBe(true);

    const editorLayout = buildEffectBranchLayout([main, fillA, packageA, unrelated], 'template-b');
    expect(editorLayout.nodes.filter((node) => node.templateId === 'template-b' &&
      node.workflowRunId === 'main').every((node) => node.onActivePath)).toBe(true);
    expect(editorLayout.nodes.filter((node) => node.templateId === 'template-a')
      .every((node) => !node.onActivePath)).toBe(true);
    expect(editorLayout.edges.filter((edge) => edge.key.includes('template-a'))
      .every((edge) => !edge.onActivePath)).toBe(true);
  });

  it('offers a manual branch copy that is blocked while an edit is open', () => {
    expect(treeSource).toContain('从当前分支新建分支');
    expect(treeSource).toContain('@click="emit(\'fork\')"');
    expect(treeSource).toContain(':disabled="switching || loading || Boolean(error) || forkDisabled || !tree?.activeWorkflowRunId"');
    expect(treeSource).toContain("forkDisabled ? '请先保存或取消当前编辑'");
  });

  it('keeps cached branches visible while refreshing and blocks stale branch actions', () => {
    expect(treeSource).toContain('v-if="loading && !tree"');
    expect(treeSource).toContain('v-else-if="error && !tree"');
    expect(treeSource).toContain('正在同步最新分支…');
    expect(treeSource).toContain('更新失败，当前显示上次结果');
    expect(treeSource).toContain(':disabled="switching || loading || Boolean(error)"');
  });

  it('labels the project root in the left stage rail at the root node height', () => {
    expect(treeSource).toContain('class="branch-axis branch-axis--root"');
    expect(treeSource).toContain('top: `${BRANCH_TREE_ROOT_TOP}px`');
    expect(treeSource).toContain('<span class="branch-axis__number">00</span>');
    expect(treeSource).toContain('<span>项目</span>');
  });

  it('shows the three mix layers inside one workflow-node group without adding a seventh workflow node', () => {
    expect(BRANCH_TREE_STAGES.slice(4, 7).map((stage) => stage.name)).toEqual([
      '混剪模板',
      '智能填充',
      '智能成片包装',
    ]);
    expect(BRANCH_TREE_STAGES.slice(4, 7).every((stage) => stage.nodeId === 'TEMPLATE_MIX')).toBe(
      true,
    );
    expect(treeSource).toContain('class="branch-axis-mix-group"');
    expect(treeSource).toContain('class="branch-axis-mix-group__parent"');
    expect(treeSource).toContain('<span>混剪</span>');
    expect(treeSource).toContain('class="branch-axis-mix-group__row"');
  });

  it('draws one top-down path across the six workflow nodes and three mix layers', () => {
    const layout = buildEffectBranchLayout([branch('main', null, null, true)]);
    expect(layout.nodes.map((node) => node.stageKey)).toEqual(
      BRANCH_TREE_STAGES.map((stage) => stage.key),
    );
    expect(layout.nodes.map((node) => node.x)).toEqual(Array(8).fill(layout.nodes[0]?.x));
    expect(layout.root.x).toBe(layout.width / 2);
    expect(layout.nodes.map((node) => node.revision)).toEqual([1, 2, 3, 4, 2, 3, 4, 5]);
    expect(layout.nodes.find((node) => node.stageKey === 'SOURCE_IMPORT')?.createdAt).toBe(
      '2026-09-20T00:00:00.000Z',
    );
    expect(layout.nodes.find((node) => node.stageKey === 'MIX_FILL')?.createdAt).toBe(
      '2026-09-27T00:00:00.000Z',
    );
    expect(layout.nodes.find((node) => node.stageKey === 'MIX_TEMPLATE')?.createdAt).toBe(
      '2026-09-26T00:00:00.000Z',
    );
    expect(layout.edges).toHaveLength(8);
    expect(layout.root.y).toBeLessThan(layout.nodes[0]!.y);
    expect(
      layout.edges.find((edge) => edge.key === 'project-root->main:SOURCE_IMPORT:-')?.onActivePath,
    ).toBe(true);
    expect(layout.nodes.every((node) => node.onActivePath)).toBe(true);
    expect(layout.nodes.filter((node) => node.isCurrentStage).map((node) => node.stageKey)).toEqual(
      ['PROMPT_GENERATION'],
    );
  });

  it('ends every branch connector with a downward arrow centered above its child', () => {
    const layout = buildEffectBranchLayout([
      branch('main', null, null),
      branch('prompt-2', 'main', 'PROMPT_GENERATION', true),
    ]);
    for (const edge of layout.edges) {
      const childKey = edge.key.split('->')[1];
      const child = layout.nodes.find((node) => node.key === childKey);
      expect(child).toBeDefined();
      const tipY = child!.y - BRANCH_TREE_NODE_HEIGHT / 2 - 3;
      expect(edge.path.endsWith(`L ${child!.x} ${tipY - 7}`)).toBe(true);
      expect(edge.arrowPath).toContain(`L ${child!.x} ${tipY} Z`);
    }
    expect(treeSource).toContain(':d="edge.arrowPath"');
    expect(treeSource).not.toContain('marker-end');
  });

  it('fans two prompt versions out from their shared extraction parent', () => {
    const layout = buildEffectBranchLayout([
      branch('main', null, null),
      branch('prompt-2', 'main', 'PROMPT_GENERATION', true),
    ]);
    const extraction = layout.nodes.find((node) => node.key === 'main:INFORMATION_EXTRACTION:-')!;
    const original = layout.nodes.find((node) => node.key === 'main:PROMPT_GENERATION:-')!;
    const fork = layout.nodes.find((node) => node.key === 'prompt-2:PROMPT_GENERATION:-')!;
    expect(original.x).not.toBe(fork.x);
    expect(extraction.x).toBe((original.x + fork.x) / 2);
    expect(
      layout.edges.find((edge) => edge.key === `${extraction.key}->${fork.key}`)?.onActivePath,
    ).toBe(true);
    expect(original.onActivePath).toBe(false);
    expect(fork.onActivePath).toBe(true);
    expect(
      layout.nodes.find((node) => node.key === 'prompt-2:FINAL_OUTPUT:template-a')?.onActivePath,
    ).toBe(true);
  });

  it('fans multiple import versions out from the project root', () => {
    const single = buildEffectBranchLayout([branch('main', null, null, true)]);
    const layout = buildEffectBranchLayout([
      branch('main', null, null),
      branch('import-2', 'main', 'SOURCE_IMPORT', true),
    ]);
    const imports = layout.nodes.filter((node) => node.stageKey === 'SOURCE_IMPORT');
    expect(imports).toHaveLength(2);
    expect(imports[0]!.x).not.toBe(imports[1]!.x);
    expect(layout.root.x).toBe((imports[0]!.x + imports[1]!.x) / 2);
    expect(single.nodes[0]!.x - single.width / 2).toBe(0);
    expect(imports[0]!.x - layout.width / 2).toBe(-BRANCH_TREE_LEAF_GAP / 2);
    expect(imports[1]!.x - layout.width / 2).toBe(BRANCH_TREE_LEAF_GAP / 2);
    expect(layout.edges.filter((edge) => edge.key.startsWith('project-root->'))).toHaveLength(2);
    expect(
      layout.edges.find((edge) => edge.key === 'project-root->import-2:SOURCE_IMPORT:-')
        ?.onActivePath,
    ).toBe(true);
    expect(
      layout.edges.find((edge) => edge.key === 'project-root->main:SOURCE_IMPORT:-')?.onActivePath,
    ).toBe(false);
  });

  it('shows a manual copy as two complete parallel paths with the new one active', () => {
    const copied = { ...branch('copy', 'main', null, true),
      creationKind: 'MANUAL_COPY' as const };
    const layout = buildEffectBranchLayout([branch('main', null, null), copied]);
    for (const stage of BRANCH_TREE_STAGES) {
      const nodes = layout.nodes.filter((node) => node.stageKey === stage.key);
      expect(nodes).toHaveLength(2);
      expect(nodes[0]!.x).not.toBe(nodes[1]!.x);
      expect(nodes.find((node) => node.workflowRunId === 'copy')?.onActivePath).toBe(true);
    }
    expect(layout.edges.filter((edge) => edge.key.startsWith('project-root->'))).toHaveLength(2);
  });

  it('shows every template as a child of rendering without a template filter', () => {
    const main = branch('main', null, null, true);
    const oneTemplateLayout = buildEffectBranchLayout([main]);
    main.templates.push({
      ...main.templates[0]!,
      templateId: 'template-b',
      name: '测试 B',
      templateRevision: 7,
    });
    const layout = buildEffectBranchLayout([main]);
    const render = layout.nodes.find((node) => node.stageKey === 'SEGMENT_RENDER')!;
    const templates = layout.nodes.filter((node) => node.stageKey === 'MIX_TEMPLATE');
    expect(templates.map((node) => node.templateName)).toEqual(['测试 A', '测试 B']);
    expect(templates.map((node) => node.revision)).toEqual([2, 7]);
    expect(
      oneTemplateLayout.nodes.find((node) => node.stageKey === 'MIX_TEMPLATE')!.x -
        oneTemplateLayout.width / 2,
    ).toBe(0);
    expect(templates[0]!.x - layout.width / 2).toBe(-BRANCH_TREE_LEAF_GAP / 2);
    expect(templates[1]!.x - layout.width / 2).toBe(BRANCH_TREE_LEAF_GAP / 2);
    expect(render.x).toBe((templates[0]!.x + templates[1]!.x) / 2);
    expect(layout.edges.filter((edge) => edge.key.startsWith(`${render.key}->`))).toHaveLength(2);
  });

  it('shows a saved but unconfirmed template without inventing its downstream nodes', () => {
    const main = branch('main', null, null, true);
    main.templates.push({
      templateId: 'template-draft',
      name: '新品跑量模板',
      templateRevision: null,
      fillRevision: null,
      packagingRevision: null,
      timelineVariantCount: 0,
      packagingVariantCount: 0,
    });

    const layout = buildEffectBranchLayout([main]);
    const draftNodes = layout.nodes.filter((node) => node.templateId === 'template-draft');

    expect(layout.nodes.filter((node) => node.stageKey === 'MIX_TEMPLATE')).toHaveLength(2);
    expect(draftNodes.map((node) => node.stageKey)).toEqual(['MIX_TEMPLATE']);
    expect(draftNodes.every((node) => node.status === 'PENDING' && node.revision === null)).toBe(
      true,
    );
    expect(draftNodes.every((node) => node.onActivePath)).toBe(true);
    expect(
      layout.edges.find((edge) => edge.key.endsWith('->main:MIX_TEMPLATE:template-draft'))
        ?.onActivePath,
    ).toBe(true);
    expect(layout.edges.every((edge) => !('pending' in edge))).toBe(true);
    expect(treeSource).not.toContain('branch-node--pending');
    expect(treeSource).not.toContain('branch-line--pending');
  });

  it('adds a fill node after smart fill succeeds without inventing a confirmed revision', () => {
    const main = branch('main', null, null, true);
    main.templates = [
      {
        templateId: 'template-draft',
        name: '新品跑量模板',
        templateRevision: null,
        fillRevision: null,
        packagingRevision: null,
        timelineVariantCount: 0,
        packagingVariantCount: 0,
        draftFillReady: true,
      },
    ];

    const layout = buildEffectBranchLayout([main]);
    const draftNodes = layout.nodes.filter((node) => node.templateId === 'template-draft');

    expect(draftNodes.map((node) => node.stageKey)).toEqual(['MIX_TEMPLATE', 'MIX_FILL']);
    expect(draftNodes[1]).toMatchObject({
      status: 'PENDING',
      revision: null,
      artifactCount: 1,
    });
    expect(layout.edges.some((edge) => edge.key.endsWith('->main:MIX_FILL:template-draft'))).toBe(
      true,
    );
  });

  it('positions every child when three templates fan out from one render', () => {
    const main = branch('main', null, null, true);
    for (const [templateId, name] of [
      ['template-b', '测试 B'],
      ['template-c', '测试 C'],
    ] as const) {
      main.templates.push({ ...main.templates[0]!, templateId, name });
    }
    const layout = buildEffectBranchLayout([main]);
    const render = layout.nodes.find((node) => node.stageKey === 'SEGMENT_RENDER')!;
    const templates = layout.nodes.filter((node) => node.stageKey === 'MIX_TEMPLATE');
    expect(templates.map((node) => node.x)).toEqual([render.x - 188, render.x, render.x + 188]);
    expect(layout.edges.filter((edge) => edge.key.startsWith(`${render.key}->`))).toHaveLength(3);
  });

  it('branches a packaging-only revision from the matching fill and preserves other templates on the active path', () => {
    const root = branch('main', null, null);
    root.templates.push({ ...root.templates[0]!, templateId: 'template-b', name: '测试 B' });
    const child = branch('packaging-2', 'main', 'TEMPLATE_MIX', true);
    child.forkMixStage = 'PACKAGING';
    child.forkTemplateId = 'template-a';
    const layout = buildEffectBranchLayout([root, child]);
    expect(
      layout.nodes.find((node) => node.key === 'packaging-2:MIX_TEMPLATE:template-a'),
    ).toBeUndefined();
    expect(
      layout.nodes.find((node) => node.key === 'packaging-2:MIX_FILL:template-a'),
    ).toBeUndefined();
    expect(layout.nodes.find((node) => node.key === 'main:MIX_FILL:template-a')?.onActivePath).toBe(
      true,
    );
    expect(layout.nodes.find((node) => node.key === 'main:MIX_PACKAGING:template-a')?.onActivePath)
      .toBe(false);
    expect(
      layout.nodes.find((node) => node.key === 'main:MIX_PACKAGING:template-b')?.onActivePath,
    ).toBe(true);
    expect(
      layout.nodes.find((node) => node.key === 'packaging-2:MIX_PACKAGING:template-a')
        ?.onActivePath,
    ).toBe(true);
    expect(
      layout.edges.find(
        (edge) => edge.key === 'main:MIX_FILL:template-a->packaging-2:MIX_PACKAGING:template-a',
      )?.onActivePath,
    ).toBe(true);
  });

  it('draws one template node when a packaging fork re-committed the template it inherited', () => {
    const main = branch('main', null, null);
    const child = branch('packaging', 'main', 'TEMPLATE_MIX', true);
    child.forkMixStage = 'PACKAGING';
    child.currentNodeId = 'TEMPLATE_MIX';

    const layout = buildEffectBranchLayout([main, child]);

    expect(layout.nodes.filter((node) => node.stageKey === 'MIX_TEMPLATE')).toHaveLength(1);
    expect(layout.nodes.filter((node) => node.stageKey === 'MIX_FILL')).toHaveLength(1);
    expect(layout.nodes.filter((node) => node.stageKey === 'MIX_PACKAGING')).toHaveLength(2);
    expect(layout.nodes.find((node) => node.key === 'main:MIX_TEMPLATE:template-a')).toBeDefined();
    expect(
      layout.nodes.find((node) => node.key === 'packaging:MIX_PACKAGING:template-a'),
    ).toBeDefined();
  });

  it('draws one template node when a fill fork re-committed the template it inherited', () => {
    const main = branch('main', null, null);
    const child = branch('fill', 'main', 'TEMPLATE_MIX', true);
    child.forkMixStage = 'FILL';
    child.templates[0]!.fillRevision = 4;

    const layout = buildEffectBranchLayout([main, child]);

    expect(layout.nodes.filter((node) => node.stageKey === 'MIX_TEMPLATE')).toHaveLength(1);
    expect(layout.nodes.filter((node) => node.stageKey === 'MIX_FILL')).toHaveLength(2);
    expect(layout.nodes.find((node) => node.key === 'main:MIX_TEMPLATE:template-a')).toBeDefined();
    expect(
      layout.nodes.find((node) => node.key === 'fill:MIX_TEMPLATE:template-a'),
    ).toBeUndefined();
    expect(layout.nodes.find((node) => node.key === 'fill:MIX_FILL:template-a')).toMatchObject({
      revision: 4,
    });
  });

  it.each(['FILL', 'PACKAGING'] as const)(
    'adds a newly created template below an existing %s fork without duplicating the old template',
    (forkMixStage) => {
      const main = branch('main', null, null);
      const child = branch('mix-child', 'main', 'TEMPLATE_MIX', true);
      child.forkMixStage = forkMixStage;
      child.forkTemplateId = 'template-a';
      child.currentNodeId = 'TEMPLATE_MIX';
      child.templates.push({
        templateId: 'template-new',
        name: '新模板',
        templateCreatedAt: '2026-09-30T02:00:00.000Z',
        templateRevision: null,
        fillRevision: null,
        packagingRevision: null,
        timelineVariantCount: 0,
        packagingVariantCount: 0,
      });

      const layout = buildEffectBranchLayout([main, child]);
      const created = layout.nodes.find(
        (node) => node.key === 'mix-child:MIX_TEMPLATE:template-new',
      );
      expect(created).toMatchObject({
        templateName: '新模板',
        status: 'PENDING',
        createdAt: '2026-09-30T02:00:00.000Z',
        onActivePath: true,
      });
      expect(layout.nodes.filter((node) => node.stageKey === 'MIX_TEMPLATE')).toHaveLength(2);
      expect(layout.nodes.some((node) => node.key === 'mix-child:MIX_TEMPLATE:template-a')).toBe(false);
      expect(layout.edges.some(
        (edge) => edge.key === 'main:SEGMENT_RENDER:-->mix-child:MIX_TEMPLATE:template-new'
          && edge.onActivePath,
      )).toBe(true);
      expect(layout.nodes.some((node) => node.templateId === 'template-new' &&
        node.stageKey !== 'MIX_TEMPLATE')).toBe(false);
    },
  );

  it('keeps a template at its draft origin when a child confirms it through smart fill', () => {
    const main = branch('main', null, null);
    const parent = branch('packaging', 'main', 'TEMPLATE_MIX');
    parent.forkMixStage = 'PACKAGING';
    parent.forkTemplateId = 'template-a';
    const draft = {
      templateId: 'template-new',
      name: '测试2',
      templateCreatedAt: '2026-09-30T03:30:07.000Z',
      templateRevision: null,
      fillRevision: null,
      packagingRevision: null,
      timelineVariantCount: 0,
      packagingVariantCount: 0,
    };
    parent.templates.push(draft);
    const filled = branch('filled', 'packaging', 'TEMPLATE_MIX', true);
    filled.forkMixStage = 'TEMPLATE';
    filled.currentNodeId = 'TEMPLATE_MIX';
    // The sibling template keeps its ancestor's version number, but this child has no fill
    // artifact for it. A carried revision alone must not manufacture another fill node.
    filled.templates[0]!.fillRevision = 6;
    filled.templates[0]!.fillCreatedAt = null;
    filled.templates[0]!.timelineVariantCount = 0;
    filled.templates[0]!.draftFillReady = false;
    filled.templates.push({
      ...draft,
      templateRevision: 1,
      fillRevision: 1,
      timelineVariantCount: 4,
    });

    const layout = buildEffectBranchLayout([main, parent, filled]);
    const templateNodes = layout.nodes.filter((node) => node.templateId === 'template-new' &&
      node.stageKey === 'MIX_TEMPLATE');

    expect(templateNodes).toHaveLength(1);
    expect(templateNodes[0]).toMatchObject({
      workflowRunId: 'packaging',
      templateName: '测试2',
      onActivePath: true,
    });
    expect(layout.nodes.find((node) => node.key === 'filled:MIX_TEMPLATE:template-new'))
      .toBeUndefined();
    expect(layout.nodes.find((node) => node.key === 'filled:MIX_FILL:template-new'))
      .toMatchObject({ revision: 1, onActivePath: true });
    expect(layout.edges.find((edge) => edge.key ===
      'packaging:MIX_TEMPLATE:template-new->filled:MIX_FILL:template-new')?.onActivePath)
      .toBe(true);
    expect(layout.nodes.filter((node) => node.templateId === 'template-a' &&
      node.stageKey === 'MIX_TEMPLATE')).toHaveLength(1);
    expect(layout.nodes.find((node) => node.key === 'filled:MIX_FILL:template-a'))
      .toBeUndefined();
  });

  it('shares one template identity across sibling mix drafts under the same rendering path', () => {
    const main = branch('main', null, null);
    const origin = branch('origin', 'main', 'TEMPLATE_MIX');
    origin.forkMixStage = 'PACKAGING';
    origin.forkTemplateId = 'template-a';
    origin.createdAt = '2026-09-30T03:27:00.000Z';
    const draft = {
      templateId: 'template-new', name: '测试2',
      templateCreatedAt: '2026-09-30T03:30:07.000Z',
      templateRevision: null, fillRevision: null, packagingRevision: null,
      timelineVariantCount: 0, packagingVariantCount: 0,
    };
    origin.templates.push(draft);
    const filled = branch('filled', 'origin', 'TEMPLATE_MIX');
    filled.forkTemplateId = draft.templateId;
    filled.forkMixStage = 'TEMPLATE';
    filled.createdAt = '2026-09-30T03:40:00.000Z';
    filled.templates.push({ ...draft, templateRevision: 1, fillRevision: 1,
      timelineVariantCount: 4 });
    const sibling = branch('sibling', 'main', 'TEMPLATE_MIX', true);
    sibling.forkTemplateId = 'template-other';
    sibling.forkMixStage = 'TEMPLATE';
    sibling.createdAt = '2026-09-30T09:45:00.000Z';
    sibling.templates.push(draft, { ...draft, templateId: 'template-other', name: '测试4' });

    // Response ordering must not decide which copy becomes the visible template.
    const layout = buildEffectBranchLayout([main, sibling, filled, origin]);
    const templates = layout.nodes.filter((node) => node.stageKey === 'MIX_TEMPLATE' &&
      node.templateId === draft.templateId);
    expect(templates).toHaveLength(1);
    expect(templates[0]).toMatchObject({ workflowRunId: 'origin', onActivePath: true,
      createdAt: draft.templateCreatedAt });
    expect(layout.nodes.find((node) => node.key === 'filled:MIX_FILL:template-new'))
      .toMatchObject({ onActivePath: true });
    expect(layout.edges.find((edge) => edge.key ===
      'origin:MIX_TEMPLATE:template-new->filled:MIX_FILL:template-new'))
      .toMatchObject({ onActivePath: true });
    expect(layout.nodes.filter((node) => node.stageKey === 'MIX_TEMPLATE')).toHaveLength(3);

    const editor = buildEffectBranchLayout([main, sibling, filled, origin], 'template-new');
    expect(editor.nodes.filter((node) => node.stageKey === 'MIX_TEMPLATE' && node.onActivePath)
      .map((node) => node.key)).toEqual(['origin:MIX_TEMPLATE:template-new']);
  });

  it('keeps templates separate after an upstream rendering fork even if IDs were copied', () => {
    const main = branch('main', null, null);
    const rendered = branch('rendered', 'main', 'SEGMENT_RENDER', true);
    const layout = buildEffectBranchLayout([main, rendered]);
    expect(layout.nodes.filter((node) => node.stageKey === 'MIX_TEMPLATE')).toHaveLength(2);
    expect(layout.edges.some((edge) => edge.key ===
      'rendered:SEGMENT_RENDER:-->rendered:MIX_TEMPLATE:template-a')).toBe(true);
  });

  it('omits mix layers when no template or result exists', () => {
    const main = branch('main', null, null, true);
    main.templates = [];
    const layout = buildEffectBranchLayout([main]);
    expect(layout.nodes.filter((node) => node.nodeId === 'TEMPLATE_MIX')).toEqual([]);
  });

  it('omits an unproduced workflow node and connects the next real version to its ancestor', () => {
    const main = branch('main', null, null, true);
    main.nodes[1]!.artifactCount = 0;
    main.nodes[1]!.status = 'PENDING';

    const layout = buildEffectBranchLayout([main]);

    expect(layout.nodes.some((node) => node.stageKey === 'INFORMATION_EXTRACTION')).toBe(false);
    expect(
      layout.edges.some((edge) => edge.key === 'main:SOURCE_IMPORT:-->main:PROMPT_GENERATION:-'),
    ).toBe(true);
  });

  it('passes through every actual revision when several products or variants differ', () => {
    const main = branch('main', null, null, true);
    main.nodes[0]!.revision = null;
    main.nodes[0]!.revisions = [1, 3];
    main.templates[0]!.fillRevision = null;
    main.templates[0]!.fillRevisions = [2, 4];
    const layout = buildEffectBranchLayout([main]);
    expect(layout.nodes.find((node) => node.stageKey === 'SOURCE_IMPORT')?.revisions).toEqual([
      1, 3,
    ]);
    expect(layout.nodes.find((node) => node.stageKey === 'MIX_FILL')?.revisions).toEqual([2, 4]);
  });
});
