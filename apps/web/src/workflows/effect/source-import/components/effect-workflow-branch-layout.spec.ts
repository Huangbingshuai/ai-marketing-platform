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
  it.each([false, true])('numbers actual upstream siblings and puts a copied-time fork on the right (reversed: %s)', (reverse) => {
    const root = branch('z-original', null, null, true);
    const child = branch('a-new-prompt', root.workflowRunId, 'PROMPT_GENERATION');
    child.createdAt = '2026-10-16T05:14:45.000Z';
    child.nodes.find(n => n.nodeId === 'PROMPT_GENERATION')!.revision = 4;
    const branches = reverse ? [child, root] : [root, child];
    const layout = buildEffectBranchLayout(branches);
    const original = layout.nodes.find(n => n.key === 'z-original:PROMPT_GENERATION:-')!;
    const fork = layout.nodes.find(n => n.key === 'a-new-prompt:PROMPT_GENERATION:-')!;
    expect(original.displayLabel).toBe('版本01');
    expect(fork).toMatchObject({ displayLabel: '版本02', revision: 4 });
    expect(fork.x).toBeGreaterThan(original.x);
    child.nodes.find(n => n.nodeId === 'PROMPT_GENERATION')!.revision = 7;
    expect(buildEffectBranchLayout(branches).nodes.find(n => n.key === fork.key))
      .toMatchObject({ displayLabel: '版本02', revision: 7, x: fork.x });
    expect(layout.nodes.find(n => n.key === 'a-new-prompt:SEGMENT_RENDER:-')?.displayLabel)
      .toBe('版本01');
  });

  it('keeps the ancestor to the left when cloned timestamps and Run timestamps are identical', () => {
    const root = branch('z-original', null, null);
    const child = branch('a-new', root.workflowRunId, 'PROMPT_GENERATION');
    const layout = buildEffectBranchLayout([child, root]);
    expect(layout.nodes.find(n => n.key === 'a-new:PROMPT_GENERATION:-')!.x)
      .toBeGreaterThan(layout.nodes.find(n => n.key === 'z-original:PROMPT_GENERATION:-')!.x);
  });

  it.each(['FILL', 'TEMPLATE'] as const)('draws an owned fill before first in-place packaging in a %s Run', (forkMixStage) => {
    const root = branch('root', null, null);
    Object.assign(root.templates[0]!, { timelineVariantCount: 0, fillRevision: null,
      packagingVariantCount: 0, packagingRevision: null, deliveryCount: 0 });
    const filled = branch('fill-and-package', root.workflowRunId, 'TEMPLATE_MIX', true);
    filled.forkTemplateId = 'template-a';
    filled.forkMixStage = forkMixStage;
    Object.assign(filled.templates[0]!, { timelineVariantCount: 32, fillRevision: 1,
      packagingVariantCount: 30, packagingRevision: 1, deliveryCount: 0 });
    const layout = buildEffectBranchLayout([root, filled], 'template-a', filled.workflowRunId);
    const fillKey = `${filled.workflowRunId}:MIX_FILL:template-a`;
    const packageKey = `${filled.workflowRunId}:MIX_PACKAGING:template-a`;
    expect(layout.nodes.find(n => n.key === fillKey)).toMatchObject({ artifactCount: 32,
      revision: 1, onActivePath: true });
    expect(layout.nodes.find(n => n.key === packageKey)).toMatchObject({ artifactCount: 30,
      revision: 1, onActivePath: true });
    expect(layout.edges.map(e => e.key)).toContain(`root:MIX_TEMPLATE:template-a->${fillKey}`);
    expect(layout.edges.map(e => e.key)).toContain(`${fillKey}->${packageKey}`);
    expect(layout.edges.map(e => e.key)).not.toContain(`root:MIX_TEMPLATE:template-a->${packageKey}`);
    expect(layout.nodes.find(n => n.key === fillKey)?.x).toBe(layout.nodes.find(n => n.key === packageKey)?.x);
  });

  it('keeps the project root, stage lanes, and separators visible when there are no versions', () => {
    expect(treeSource).not.toContain('当前项目还没有已确认的');
    expect(treeSource).toContain('class="branch-stage-band"');
    expect(treeSource).toContain('class="branch-axis-rail"');
    expect(treeSource).toContain('class="branch-project-root"');
    expect(treeSource).toContain('v-if="layout.nodes.length" class="branch-toolbar__legend"');
  });

  it('recenters the project and single upstream trunk when deeper forks widen the tree', () => {
    const main = branch('main', null, null);
    const before = buildEffectBranchLayout([main]);
    main.templates.push({
      ...main.templates[0]!,
      templateId: 'template-b',
      name: '测试 B',
      templateCreatedAt: '2026-10-01T00:00:00.000Z',
    });
    const promptFork = branch('prompt-2', 'main', 'PROMPT_GENERATION', true);
    promptFork.nodes.find((node) => node.nodeId === 'PROMPT_GENERATION')!.artifactCreatedAt =
      '2026-10-02T00:00:00.000Z';
    const after = buildEffectBranchLayout([main, promptFork]);

    expect(after.width).toBeGreaterThan(before.width);
    expect(after.root.x).toBe(after.width / 2);
    for (const node of after.nodes.filter((node) => node.stageIndex < 2)) {
      expect(node.x).toBe(after.root.x);
    }
    const firstImport = after.nodes.find((node) => node.stageKey === 'SOURCE_IMPORT')!;
    expect(firstImport.x).toBe(after.root.x);
    expect(
      after.edges.find((edge) => edge.key === `project-root->${firstImport.key}`)?.path,
    ).not.toContain('Q');
    for (const stage of BRANCH_TREE_STAGES) {
      const row = after.nodes
        .filter((node) => node.stageKey === stage.key)
        .sort((left, right) => left.x - right.x);
      for (let index = 1; index < row.length; index++) {
        expect(row[index]!.x - row[index - 1]!.x).toBeGreaterThanOrEqual(BRANCH_TREE_LEAF_GAP);
      }
    }
  });

  it('centers balanced sibling subtrees on both sides without changing their identity or chronology', () => {
    const main = branch('main', null, null, true);
    main.templates.push({
      ...main.templates[0]!,
      templateId: 'template-b',
      name: '测试 B',
      templateCreatedAt: '2026-10-01T00:00:00.000Z',
    });
    const layout = buildEffectBranchLayout([main]);
    const templates = layout.nodes
      .filter((node) => node.stageKey === 'MIX_TEMPLATE')
      .sort((a, b) => a.x - b.x);
    expect(templates.map((node) => node.templateId)).toEqual(['template-a', 'template-b']);
    expect(templates[0]!.x).toBeLessThan(layout.root.x);
    expect(templates[1]!.x).toBeGreaterThan(layout.root.x);
    expect(layout.root.x - templates[0]!.x).toBe(templates[1]!.x - layout.root.x);
    for (const template of templates) {
      expect(
        layout.nodes
          .filter((node) => node.templateId === template.templateId)
          .every((node) => node.x === template.x),
      ).toBe(true);
    }
  });

  it('balances unequal subtree widths while reserving separate lanes for every same-layer node', () => {
    const main = branch('main', null, null, true);
    main.templates.push({
      ...main.templates[0]!,
      templateId: 'template-b',
      name: '测试 B',
      templateCreatedAt: '2026-10-01T00:00:00.000Z',
    });
    const forks = ['fill-2', 'fill-3'].map((id, index) => {
      const child = branch(id, 'main', 'TEMPLATE_MIX');
      child.forkTemplateId = 'template-a';
      child.forkMixStage = 'FILL';
      child.templates[0]!.fillCreatedAt = `2026-10-0${index + 2}T00:00:00.000Z`;
      return child;
    });
    const input = [main, ...forks];
    const before = JSON.stringify(input);
    const layout = buildEffectBranchLayout(input);
    const positions = new Map(layout.nodes.map((node) => [node.key, node.x]));
    expect(JSON.stringify(input)).toBe(before);
    expect(
      new Map(
        buildEffectBranchLayout([...input].reverse()).nodes.map((node) => [node.key, node.x]),
      ),
    ).toEqual(positions);
    expect(
      new Map(buildEffectBranchLayout(input, 'template-b').nodes.map((node) => [node.key, node.x])),
    ).toEqual(positions);
    const left = Math.min(...layout.nodes.map((node) => node.x));
    const right = Math.max(...layout.nodes.map((node) => node.x));
    expect(layout.root.x - left).toBe(right - layout.root.x);
    for (const stage of BRANCH_TREE_STAGES) {
      const row = layout.nodes
        .filter((node) => node.stageKey === stage.key)
        .sort((a, b) => a.x - b.x);
      for (let index = 1; index < row.length; index++) {
        expect(row[index]!.x - row[index - 1]!.x).toBeGreaterThanOrEqual(BRANCH_TREE_LEAF_GAP);
      }
    }
    const templateA = layout.nodes.find(
      (node) => node.stageKey === 'MIX_TEMPLATE' && node.templateId === 'template-a',
    )!;
    const fillXs = layout.nodes
      .filter((node) => node.stageKey === 'MIX_FILL' && node.templateId === 'template-a')
      .map((node) => node.x);
    expect(templateA.x).toBe((Math.min(...fillXs) + Math.max(...fillXs)) / 2);
  });

  it('keeps multiple imported source trees under a centered project instead of favoring the first source', () => {
    const original = branch('original', null, null);
    const copy = branch('copy', 'original', 'SOURCE_IMPORT', true);
    copy.creationKind = 'MANUAL_COPY';
    copy.createdAt = '2026-10-02T00:00:00.000Z';
    const layout = buildEffectBranchLayout([original, copy]);
    const imports = layout.nodes
      .filter((node) => node.stageKey === 'SOURCE_IMPORT')
      .sort((a, b) => a.x - b.x);
    expect(imports).toHaveLength(2);
    expect(layout.root.x).toBe(layout.width / 2);
    expect(layout.root.x).toBe((imports[0]!.x + imports[1]!.x) / 2);
  });

  it('keeps an empty project centered in its minimum canvas', () => {
    const layout = buildEffectBranchLayout([]);
    expect(layout.root.x).toBe(layout.width / 2);
    expect(layout.nodes).toEqual([]);
    expect(layout.edges).toEqual([]);
  });

  it.each(['FILL', 'PACKAGING', 'OUTPUT'] as const)(
    'keeps the whole tree centered as successive %s versions are added',
    (stage) => {
      const main = branch('main', null, null, true);
      const input = [main];
      for (let count = 0; count <= 4; count++) {
        if (count > 0) {
          const child = branch(
            `new-${count}`,
            'main',
            stage === 'OUTPUT' ? 'FINAL_OUTPUT' : 'TEMPLATE_MIX',
          );
          child.forkTemplateId = 'template-a';
          if (stage !== 'OUTPUT') child.forkMixStage = stage;
          child.createdAt = `2026-10-0${count}T00:00:00.000Z`;
          child.templates[0]!.fillCreatedAt = child.createdAt;
          child.templates[0]!.packagingCreatedAt = child.createdAt;
          input.push(child);
        }
        const layout = buildEffectBranchLayout(input);
        const left = Math.min(...layout.nodes.map((node) => node.x));
        const right = Math.max(...layout.nodes.map((node) => node.x));
        expect(layout.root.x).toBe(layout.width / 2);
        expect(layout.root.x - left).toBe(right - layout.root.x);
        expect(layout.nodes.find((node) => node.stageKey === 'SOURCE_IMPORT')!.x).toBe(
          layout.root.x,
        );
        for (const layer of BRANCH_TREE_STAGES) {
          const row = layout.nodes
            .filter((node) => node.stageKey === layer.key)
            .sort((a, b) => a.x - b.x);
          for (let index = 1; index < row.length; index++) {
            expect(row[index]!.x - row[index - 1]!.x).toBeGreaterThanOrEqual(BRANCH_TREE_LEAF_GAP);
          }
        }
        const targetStage =
          stage === 'FILL' ? 'MIX_FILL' : stage === 'PACKAGING' ? 'MIX_PACKAGING' : 'FINAL_OUTPUT';
        expect(layout.nodes.filter((node) => node.stageKey === targetStage)).toHaveLength(
          count + 1,
        );
      }
    },
  );

  it('highlights current confirmations rather than the obsolete active child on the template overview', () => {
    const root = branch('root', null, null);
    const current = branch('current', 'root', 'TEMPLATE_MIX');
    current.forkTemplateId = 'template-a';
    current.forkMixStage = 'FILL';
    current.templates[0]!.currentConfirmedAt = '2026-10-07';
    const old = branch('old', 'current', 'TEMPLATE_MIX', true);
    old.forkTemplateId = 'template-a';
    old.forkMixStage = 'PACKAGING';
    old.templates[0]!.currentConfirmedAt = '2026-10-06';
    const overview = buildEffectBranchLayout([root, current, old]);
    expect(
      overview.nodes.find((node) => node.key === 'current:MIX_FILL:template-a')?.onActivePath,
    ).toBe(true);
    expect(
      overview.nodes.find((node) => node.key === 'old:MIX_PACKAGING:template-a')?.onActivePath,
    ).not.toBe(true);
  });
  it('preserves chronological template order across centered layouts and input ordering', () => {
    const main = branch('main', null, null, true);
    const template = (id: string, date: string) => ({
      ...main.templates[0]!,
      templateId: id,
      name: id,
      templateCreatedAt: date,
    });
    const second = branch('second', 'main', 'TEMPLATE_MIX');
    second.forkMixStage = 'TEMPLATE';
    second.forkTemplateId = 'template-b';
    second.templates.push(template('template-b', '2026-09-27T00:00:00.000Z'));
    const third = branch('third', 'main', 'TEMPLATE_MIX');
    third.forkMixStage = 'TEMPLATE';
    third.forkTemplateId = 'template-c';
    third.templates.push(template('template-c', '2026-09-28T00:00:00.000Z'));
    const newest = {
      ...template('template-d', '2026-10-07T00:14:00.000Z'),
      templateRevision: null,
      fillRevision: null,
      packagingRevision: null,
      timelineVariantCount: 0,
      packagingVariantCount: 0,
      deliveryCount: 0,
    };
    main.templates.push(newest);

    const positions = (branches: EffectWorkflowBranch[]) => {
      const layout = buildEffectBranchLayout(branches);
      const templates = layout.nodes
        .filter((node) => node.stageKey === 'MIX_TEMPLATE')
        .sort((left, right) => left.x - right.x);
      expect(templates.map((node) => node.templateId)).toEqual([
        'template-a',
        'template-b',
        'template-c',
        'template-d',
      ]);
      expect(
        layout.edges.some(
          (edge) => edge.key === 'main:SEGMENT_RENDER:-->main:MIX_TEMPLATE:template-d',
        ),
      ).toBe(true);
      expect(layout.nodes.filter((node) => node.templateId === 'template-d')).toHaveLength(1);
      return new Map(templates.map((node) => [node.templateId, node.x]));
    };
    const expected = positions([main, second, third]);
    expect(positions([third, main, second])).toEqual(expected);
    // Editing names or selecting another template must not change creation ordering.
    newest.name = 'AAA renamed';
    expect(positions([main, third, second])).toEqual(expected);
  });

  it('uses Run creation time for historical nodes without their own timestamp', () => {
    const main = branch('main', null, null);
    main.templates[0]!.templateCreatedAt = null;
    const created = branch('created', 'main', 'TEMPLATE_MIX', true);
    created.createdAt = '2026-10-07T00:14:00.000Z';
    created.forkMixStage = 'TEMPLATE';
    created.forkTemplateId = 'template-new';
    created.templates.push({ ...main.templates[0]!, templateId: 'template-new' });
    const layout = buildEffectBranchLayout([created, main]);
    const templates = layout.nodes.filter((node) => node.stageKey === 'MIX_TEMPLATE');
    expect(templates.find((node) => node.templateId === 'template-new')!.x).toBeGreaterThan(
      templates.find((node) => node.templateId === 'template-a')!.x,
    );
  });

  it('marks only the affected template layer, including inactive sibling branches', () => {
    const main = branch('main', null, null, true);
    main.templates[0]!.templateStatus = 'CONFIRMED';
    main.templates[0]!.fillStatus = 'STALE';
    main.templates[0]!.packagingStatus = 'STALE';
    main.templates[0]!.deliveryStatus = 'STALE';
    main.templates.push({
      ...main.templates[0]!,
      templateId: 'unaffected',
      fillStatus: 'CONFIRMED',
      packagingStatus: 'CONFIRMED',
      deliveryStatus: 'CONFIRMED',
    });
    const sibling = branch('sibling', 'main', 'TEMPLATE_MIX');
    sibling.forkMixStage = 'FILL';
    sibling.forkTemplateId = 'template-a';
    sibling.templates[0]!.fillStatus = 'STALE';
    sibling.templates[0]!.packagingVariantCount = 0;
    const layout = buildEffectBranchLayout([main, sibling]);
    expect(layout.nodes.filter((node) => node.status === 'STALE').map((node) => node.key)).toEqual([
      'main:MIX_FILL:template-a',
      'main:MIX_PACKAGING:template-a',
      'main:FINAL_OUTPUT:template-a',
      'sibling:MIX_FILL:template-a',
    ]);
    expect(layout.nodes.filter((node) => node.showStaleWarning).map((node) => node.key)).toEqual([
      'main:MIX_PACKAGING:template-a',
      'main:FINAL_OUTPUT:template-a',
      'sibling:MIX_FILL:template-a',
    ]);
    expect(treeSource).toContain("'branch-node--stale': node.showStaleWarning");
    expect(treeSource).toContain('border-color: #e0c200');
    expect(
      layout.nodes.find((node) => node.key === 'sibling:MIX_FILL:template-a')?.onActivePath,
    ).toBe(true);
  });
  it('shows saved-output warnings on the current red path without warning unrelated layers', () => {
    const main = branch('main', null, null, true);
    main.templates[0]!.deliveryStatus = 'STALE';
    const layout = buildEffectBranchLayout([main], 'template-a');
    const output = layout.nodes.find((node) => node.stageKey === 'FINAL_OUTPUT')!;
    expect(output).toMatchObject({ status: 'STALE', showStaleWarning: true, onActivePath: true });
    expect(layout.nodes.filter((node) => node.showStaleWarning)).toEqual([output]);
    main.templates[0]!.deliveryStatus = 'CONFIRMED';
    expect(
      buildEffectBranchLayout([main], 'template-a').nodes.find(
        (node) => node.stageKey === 'FINAL_OUTPUT',
      ),
    ).toMatchObject({ status: 'CONFIRMED', showStaleWarning: false });
  });

  it('shows source warnings on packaging descendants instead of their shared fill head', () => {
    const main = branch('main', null, null, true);
    main.templates[0]!.packagingVariantCount = 0;
    main.templates[0]!.fillStatus = 'STALE';
    const packed = branch('packed', 'main', 'TEMPLATE_MIX');
    packed.forkMixStage = 'PACKAGING';
    packed.forkTemplateId = 'template-a';
    packed.templates[0]!.packagingStatus = 'STALE';
    const independentFill = branch('independent-fill', 'main', 'TEMPLATE_MIX');
    independentFill.forkMixStage = 'FILL';
    independentFill.forkTemplateId = 'template-a';
    independentFill.templates[0]!.packagingVariantCount = 0;
    independentFill.templates[0]!.fillStatus = 'STALE';
    const layout = buildEffectBranchLayout([main, packed, independentFill]);
    expect(layout.nodes.find((node) => node.key === 'main:MIX_FILL:template-a')).toMatchObject({
      status: 'STALE',
      showStaleWarning: false,
    });
    expect(
      layout.nodes.find((node) => node.key === 'packed:MIX_PACKAGING:template-a'),
    ).toMatchObject({ status: 'STALE', showStaleWarning: true });
    expect(
      layout.nodes.find((node) => node.key === 'independent-fill:MIX_FILL:template-a'),
    ).toMatchObject({ status: 'STALE', showStaleWarning: true });
    expect(main.templates[0]!.fillStatus).toBe('STALE');
  });
  it('highlights version 03 in configuration while refinement keeps the selected old branch', () => {
    const main = branch('main', null, null);
    main.templates[0]!.packagingVariantCount = 0;
    const old = branch('package-02', 'main', 'TEMPLATE_MIX', true);
    old.currentNodeId = 'TEMPLATE_MIX';
    old.forkMixStage = 'PACKAGING';
    old.forkTemplateId = 'template-a';
    old.templates[0]!.packagingRevision = 2;
    old.templates[0]!.packagingStatus = 'STALE';
    const latest = branch('package-03', 'old', 'TEMPLATE_MIX');
    latest.parentWorkflowRunId = old.workflowRunId;
    latest.forkMixStage = 'PACKAGING';
    latest.forkTemplateId = 'template-a';
    latest.createdAt = '2026-09-29T00:00:00.000Z';
    latest.templates[0]!.packagingRevision = 3;
    const config = buildEffectBranchLayout([main, old, latest]);
    expect(
      config.nodes.find((node) => node.key === 'package-03:MIX_PACKAGING:template-a'),
    ).toMatchObject({ revision: 3, onActivePath: true, showStaleWarning: false });
    expect(
      config.nodes.find((node) => node.key === 'package-02:MIX_PACKAGING:template-a'),
    ).toMatchObject({ onActivePath: false, showStaleWarning: true });
    const editor = buildEffectBranchLayout([main, old, latest], 'template-a');
    expect(
      editor.nodes.find((node) => node.key === 'package-02:MIX_PACKAGING:template-a'),
    ).toMatchObject({ onActivePath: true, isCurrentStage: true, showStaleWarning: true });
    expect(
      editor.nodes.find((node) => node.key === 'package-03:MIX_PACKAGING:template-a')?.onActivePath,
    ).toBe(false);
  });
  it('uses a strong red/yellow blend only for selected stale nodes and pure yellow for others', () => {
    const stale = treeSource.split('.branch-node.branch-node--stale {')[1]?.split('}')[0];
    expect(stale).toContain('color: #8a7600');
    expect(stale).toContain('border-color: #e0c200');
    expect(stale).not.toContain('#b45309');
    expect(stale).not.toContain('#f59e0b');
    expect(stale).toContain('rgba(200, 175, 0, 0.08)');
    expect(treeSource.split('.branch-node__stale {')[1]?.split('}')[0]).toContain('color: #8a7600');
    expect(stale).not.toContain('gradient');
    expect(stale).not.toContain('#b72437');
    expect(stale).not.toContain('211, 47, 63');
    expect(stale).toContain('border-width: 1px');
    expect(stale).not.toContain('0 0 0');
    const selectedStale = treeSource
      .split('.branch-node.branch-node--stale.branch-node--active {')[1]
      ?.split('}')[0];
    expect(selectedStale).toContain('border-width: 2px');
    expect(selectedStale).toContain('color: #b91c1c');
    expect(selectedStale).toContain('linear-gradient(#fff, #fff) padding-box');
    expect(selectedStale).toContain(
      'linear-gradient(112deg, #dc2626 0%, #dc2626 40%, #e0c200 100%) border-box',
    );
    expect(selectedStale).toContain('border-color: transparent');
    expect(selectedStale).not.toContain('0 0 0');
    expect(treeSource).not.toContain('.branch-node--active.branch-node--stale {');
    expect(treeSource).not.toContain('.branch-node--current.branch-node--stale {');
    expect(treeSource.indexOf('.branch-node.branch-node--stale {')).toBeGreaterThan(
      treeSource.indexOf('.branch-node--current {'),
    );
    expect(treeSource).toMatch(/props\.activeTemplateId,\s*props\.viewedWorkflowRunId/);
  });
  it('uses only card borders for path and stale state without large colored group backgrounds', () => {
    expect(treeSource).not.toContain('branch-template-group');
    expect(treeSource).not.toContain('buildBranchTemplateGroups');
    expect(treeSource.split('.branch-node--active {')[1]?.split('}')[0]).toContain(
      'background: #fff;',
    );
    expect(treeSource.split('.branch-node.branch-node--stale {')[1]?.split('}')[0]).toContain(
      'background: #fff;',
    );
    expect(treeSource).toContain('分支向两侧展开');
    expect(treeSource).not.toContain('新分支向右延伸');
    expect(treeSource).toContain('@click="selectNode(node)"');
  });
  it('colors the viewed editor branch and its edges instead of an unrelated global active sibling', () => {
    const root = branch('root', null, null);
    const old = branch('package-02', 'root', 'TEMPLATE_MIX');
    const latest = branch('package-03', 'root', 'TEMPLATE_MIX', true);
    for (const run of [old, latest]) {
      run.forkTemplateId = 'template-a';
      run.forkMixStage = 'PACKAGING';
      run.templates[0]!.packagingStatus = 'STALE';
      run.currentNodeId = 'TEMPLATE_MIX';
    }
    old.templates[0]!.currentSelectedAt = '2026-10-07T09:36:25Z';
    const layout = buildEffectBranchLayout([root, old, latest], 'template-a', 'package-02');
    expect(
      layout.nodes.find((node) => node.key === 'package-02:MIX_PACKAGING:template-a'),
    ).toMatchObject({ onActivePath: true, isCurrentStage: true, showStaleWarning: true });
    expect(
      layout.nodes.find((node) => node.key === 'package-03:MIX_PACKAGING:template-a'),
    ).toMatchObject({ onActivePath: false, isCurrentStage: false, showStaleWarning: true });
    expect(
      layout.edges.find((edge) => edge.key.endsWith('->package-02:MIX_PACKAGING:template-a'))
        ?.onActivePath,
    ).toBe(true);
    expect(
      layout.edges.find((edge) => edge.key.endsWith('->package-03:MIX_PACKAGING:template-a'))
        ?.onActivePath,
    ).toBe(false);
    expect(latest.isActive).toBe(true);
  });
  it('warns on each packaged project own stale fill while hiding template and shared fill warnings', () => {
    const origin = branch('origin', null, null);
    Object.assign(origin.templates[0]!, {
      templateStatus: 'STALE',
      timelineVariantCount: 0,
      packagingVariantCount: 0,
      deliveryCount: 0,
    });
    const filled = branch('filled', 'origin', 'TEMPLATE_MIX');
    filled.forkTemplateId = 'template-a';
    filled.forkMixStage = 'TEMPLATE';
    Object.assign(filled.templates[0]!, {
      templateStatus: 'STALE',
      fillStatus: 'STALE',
      packagingVariantCount: 0,
      currentConfirmedAt: '2026-10-06T00:00:00Z',
    });
    const packaged = branch('packaged', 'filled', 'TEMPLATE_MIX', true);
    packaged.forkTemplateId = 'template-a';
    packaged.forkMixStage = 'PACKAGING';
    Object.assign(packaged.templates[0]!, {
      templateStatus: 'STALE',
      fillStatus: 'STALE',
      packagingStatus: 'CONFIRMED',
      currentConfirmedAt: '2026-10-07T00:00:00Z',
    });
    for (const branches of [
      [origin, filled, packaged],
      [packaged, origin, filled],
    ]) {
      const layout = buildEffectBranchLayout(branches, 'template-a');
      expect(
        layout.nodes.find((node) => node.key === 'origin:MIX_TEMPLATE:template-a'),
      ).toMatchObject({ status: 'STALE', showStaleWarning: false, revision: 2 });
      expect(layout.nodes.find((node) => node.key === 'filled:MIX_FILL:template-a')).toMatchObject({
        status: 'STALE',
        showStaleWarning: false,
      });
      expect(
        layout.nodes.find((node) => node.key === 'packaged:MIX_PACKAGING:template-a'),
      ).toMatchObject({ status: 'STALE', showStaleWarning: true });
      expect(packaged.templates[0]!.packagingStatus).toBe('CONFIRMED');
      // Refreshing this project's visual timeline clears its warning despite its old fill head.
      packaged.templates[0]!.fillStatus = 'CONFIRMED';
      expect(
        buildEffectBranchLayout(branches).nodes.find(
          (node) => node.key === 'packaged:MIX_PACKAGING:template-a',
        ),
      ).toMatchObject({ status: 'CONFIRMED', showStaleWarning: false });
      packaged.templates[0]!.fillStatus = 'STALE';
    }
  });
  it('does not let a refreshed packaging sibling clear another stale packaged project', () => {
    const filled = branch('filled', null, null);
    filled.templates[0]!.packagingVariantCount = 0;
    filled.templates[0]!.fillStatus = 'STALE';
    const old = branch('old', 'filled', 'TEMPLATE_MIX');
    old.forkTemplateId = 'template-a';
    old.forkMixStage = 'PACKAGING';
    Object.assign(old.templates[0]!, { fillStatus: 'STALE', packagingStatus: 'CONFIRMED' });
    const current = branch('current', 'filled', 'TEMPLATE_MIX', true);
    current.forkTemplateId = 'template-a';
    current.forkMixStage = 'PACKAGING';
    Object.assign(current.templates[0]!, { fillStatus: 'CONFIRMED', packagingStatus: 'CONFIRMED' });
    for (const rows of [
      [filled, old, current],
      [current, old, filled],
    ]) {
      const layout = buildEffectBranchLayout(rows);
      expect(
        layout.nodes.find((node) => node.key === 'old:MIX_PACKAGING:template-a'),
      ).toMatchObject({ status: 'STALE', showStaleWarning: true });
      expect(
        layout.nodes.find((node) => node.key === 'current:MIX_PACKAGING:template-a'),
      ).toMatchObject({ status: 'CONFIRMED', showStaleWarning: false });
      expect(layout.nodes.find((node) => node.key === 'filled:MIX_FILL:template-a')).toMatchObject({
        status: 'STALE',
        showStaleWarning: false,
      });
    }
  });
  it('highlights all template paths in configuration and only the opened template in its editor', () => {
    const main = branch('main', null, null, true);
    main.currentNodeId = 'TEMPLATE_MIX';
    main.templates.push({
      ...main.templates[0]!,
      templateId: 'template-b',
      name: '测试 B',
    });

    const configLayout = buildEffectBranchLayout([main]);
    expect(
      configLayout.nodes
        .filter((node) => node.stageKey === 'MIX_TEMPLATE' && node.onActivePath)
        .map((node) => node.templateId),
    ).toEqual(['template-a', 'template-b']);

    const editorLayout = buildEffectBranchLayout([main], 'template-b');
    expect(
      editorLayout.nodes.filter((node) => node.stageIndex < 4).every((node) => node.onActivePath),
    ).toBe(true);
    expect(
      editorLayout.nodes
        .filter((node) => node.stageIndex >= 4 && node.onActivePath)
        .every((node) => node.templateId === 'template-b'),
    ).toBe(true);
    expect(
      editorLayout.nodes
        .filter((node) => node.templateId === 'template-a')
        .every((node) => !node.onActivePath && !node.isCurrentStage),
    ).toBe(true);
    expect(
      editorLayout.edges
        .filter((edge) => edge.key.includes('template-a'))
        .every((edge) => !edge.onActivePath),
    ).toBe(true);
    expect(
      editorLayout.edges
        .filter((edge) => edge.key.includes('template-b'))
        .some((edge) => edge.onActivePath),
    ).toBe(true);
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
    expect(
      configLayout.nodes
        .filter(
          (node) =>
            node.templateId === 'template-a' &&
            node.workflowRunId === 'main' &&
            node.stageKey === 'MIX_TEMPLATE',
        )
        .every((node) => node.onActivePath),
    ).toBe(true);
    expect(
      configLayout.nodes.find((node) => node.key === 'fill-a:MIX_FILL:template-a')?.onActivePath,
    ).toBe(true);
    expect(
      configLayout.nodes.find((node) => node.key === 'package-a:MIX_PACKAGING:template-a')
        ?.onActivePath,
    ).toBe(true);
    expect(
      configLayout.nodes.find((node) => node.key === 'fill-a:MIX_PACKAGING:template-a')
        ?.onActivePath,
    ).toBe(false);
    expect(
      configLayout.nodes
        .filter((node) => node.templateId === 'template-b' && node.workflowRunId === 'main')
        .every((node) => node.onActivePath),
    ).toBe(true);
    expect(
      configLayout.nodes
        .filter((node) => node.workflowRunId === 'other-upstream')
        .every((node) => !node.onActivePath),
    ).toBe(true);
    expect(
      configLayout.edges.find(
        (edge) => edge.key === 'main:MIX_TEMPLATE:template-a->fill-a:MIX_FILL:template-a',
      )?.onActivePath,
    ).toBe(true);
    expect(
      configLayout.edges.find(
        (edge) => edge.key === 'fill-a:MIX_FILL:template-a->package-a:MIX_PACKAGING:template-a',
      )?.onActivePath,
    ).toBe(true);

    const editorLayout = buildEffectBranchLayout([main, fillA, packageA, unrelated], 'template-b');
    expect(
      editorLayout.nodes
        .filter((node) => node.templateId === 'template-b' && node.workflowRunId === 'main')
        .every((node) => node.onActivePath),
    ).toBe(true);
    expect(
      editorLayout.nodes
        .filter((node) => node.templateId === 'template-a')
        .every((node) => !node.onActivePath),
    ).toBe(true);
    expect(
      editorLayout.edges
        .filter((edge) => edge.key.includes('template-a'))
        .every((edge) => !edge.onActivePath),
    ).toBe(true);
  });

  it('omits the manual new-branch button while retaining existing version navigation', () => {
    expect(treeSource).not.toContain('从当前分支新建分支');
    expect(treeSource).not.toContain('@click="emit(\'fork\')"');
    expect(treeSource).not.toContain('branch-copy-button');
    expect(treeSource).toContain('@click="selectNode(node)"');
  });

  it('keeps cached branches visible while refreshing and blocks stale branch actions', () => {
    expect(treeSource).toContain('v-if="loading && !tree && !alternateLayout"');
    expect(treeSource).toContain('v-else-if="error && !tree && !alternateLayout"');
    expect(treeSource).toContain('正在同步最新分支…');
    expect(treeSource).toContain('更新失败，当前显示上次结果');
    expect(treeSource).toMatch(
      /switching\s*\|\|\s*loading\s*\|\|\s*Boolean\(error\)\s*\|\|\s*\(assetBrowse\s*&&\s*!selectableNodeKeys\?\.includes\(node\.key\)\)/,
    );
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
    expect(treeSource).toContain('<span>{{ EFFECT_NODE_LABELS.TEMPLATE_MIX }}</span>');
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

  it('centers extraction above its original and forked prompt subtrees', () => {
    const layout = buildEffectBranchLayout([
      branch('main', null, null),
      branch('prompt-2', 'main', 'PROMPT_GENERATION', true),
    ]);
    const extraction = layout.nodes.find((node) => node.key === 'main:INFORMATION_EXTRACTION:-')!;
    const original = layout.nodes.find((node) => node.key === 'main:PROMPT_GENERATION:-')!;
    const fork = layout.nodes.find((node) => node.key === 'prompt-2:PROMPT_GENERATION:-')!;
    expect(original.x).not.toBe(fork.x);
    expect(extraction.x).toBe((original.x + fork.x) / 2);
    expect(fork.x).toBeGreaterThan(original.x);
    expect(
      layout.edges.find((edge) => edge.key === `${extraction.key}->${fork.key}`)?.onActivePath,
    ).toBe(true);
    expect(original.onActivePath).toBe(false);
    expect(fork.onActivePath).toBe(true);
    expect(
      layout.nodes.find((node) => node.key === 'prompt-2:FINAL_OUTPUT:template-a')?.onActivePath,
    ).toBe(true);
  });

  it('aligns a single import vertically and centers multiple imports around the project', () => {
    const single = buildEffectBranchLayout([branch('main', null, null, true)]);
    const layout = buildEffectBranchLayout([
      branch('main', null, null),
      branch('import-2', 'main', 'SOURCE_IMPORT', true),
    ]);
    const imports = layout.nodes
      .filter((node) => node.stageKey === 'SOURCE_IMPORT')
      .sort((a, b) => a.x - b.x);
    expect(imports).toHaveLength(2);
    expect(imports[0]!.x).not.toBe(imports[1]!.x);
    expect(layout.root.x).toBe((imports[0]!.x + imports[1]!.x) / 2);
    expect(layout.root.x).toBe(layout.width / 2);
    expect(single.nodes[0]!.x - single.width / 2).toBe(0);
    expect(imports[0]!.x).toBe(single.nodes[0]!.x);
    expect(imports[1]!.x).toBe(imports[0]!.x + BRANCH_TREE_LEAF_GAP);
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
    const copied = { ...branch('copy', 'main', null, true), creationKind: 'MANUAL_COPY' as const };
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
    expect(templates[0]!.x).toBe(oneTemplateLayout.root.x);
    expect(templates[1]!.x).toBe(templates[0]!.x + BRANCH_TREE_LEAF_GAP);
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
    expect(templates.map((node) => node.x)).toEqual([
      render.x - BRANCH_TREE_LEAF_GAP,
      render.x,
      render.x + BRANCH_TREE_LEAF_GAP,
    ]);
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
    expect(
      layout.nodes.find((node) => node.key === 'main:MIX_PACKAGING:template-a')?.onActivePath,
    ).toBe(false);
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
      expect(layout.nodes.some((node) => node.key === 'mix-child:MIX_TEMPLATE:template-a')).toBe(
        false,
      );
      expect(
        layout.edges.some(
          (edge) =>
            edge.key === 'main:SEGMENT_RENDER:-->mix-child:MIX_TEMPLATE:template-new' &&
            edge.onActivePath,
        ),
      ).toBe(true);
      expect(
        layout.nodes.some(
          (node) => node.templateId === 'template-new' && node.stageKey !== 'MIX_TEMPLATE',
        ),
      ).toBe(false);
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
    const templateNodes = layout.nodes.filter(
      (node) => node.templateId === 'template-new' && node.stageKey === 'MIX_TEMPLATE',
    );

    expect(templateNodes).toHaveLength(1);
    expect(templateNodes[0]).toMatchObject({
      workflowRunId: 'packaging',
      templateName: '测试2',
      onActivePath: true,
    });
    expect(
      layout.nodes.find((node) => node.key === 'filled:MIX_TEMPLATE:template-new'),
    ).toBeUndefined();
    expect(layout.nodes.find((node) => node.key === 'filled:MIX_FILL:template-new')).toMatchObject({
      revision: 1,
      onActivePath: true,
    });
    expect(
      layout.edges.find(
        (edge) => edge.key === 'packaging:MIX_TEMPLATE:template-new->filled:MIX_FILL:template-new',
      )?.onActivePath,
    ).toBe(true);
    expect(
      layout.nodes.filter(
        (node) => node.templateId === 'template-a' && node.stageKey === 'MIX_TEMPLATE',
      ),
    ).toHaveLength(1);
    expect(layout.nodes.find((node) => node.key === 'filled:MIX_FILL:template-a')).toBeUndefined();
  });

  it('shares one template identity across sibling mix drafts under the same rendering path', () => {
    const main = branch('main', null, null);
    const origin = branch('origin', 'main', 'TEMPLATE_MIX');
    origin.forkMixStage = 'PACKAGING';
    origin.forkTemplateId = 'template-a';
    origin.createdAt = '2026-09-30T03:27:00.000Z';
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
    origin.templates.push(draft);
    const filled = branch('filled', 'origin', 'TEMPLATE_MIX');
    filled.forkTemplateId = draft.templateId;
    filled.forkMixStage = 'TEMPLATE';
    filled.createdAt = '2026-09-30T03:40:00.000Z';
    filled.templates.push({
      ...draft,
      templateRevision: 1,
      fillRevision: 1,
      timelineVariantCount: 4,
    });
    const sibling = branch('sibling', 'main', 'TEMPLATE_MIX', true);
    sibling.forkTemplateId = 'template-other';
    sibling.forkMixStage = 'TEMPLATE';
    sibling.createdAt = '2026-09-30T09:45:00.000Z';
    sibling.templates.push(draft, { ...draft, templateId: 'template-other', name: '测试4' });

    // Response ordering must not decide which copy becomes the visible template.
    const layout = buildEffectBranchLayout([main, sibling, filled, origin]);
    const templates = layout.nodes.filter(
      (node) => node.stageKey === 'MIX_TEMPLATE' && node.templateId === draft.templateId,
    );
    expect(templates).toHaveLength(1);
    expect(templates[0]).toMatchObject({
      workflowRunId: 'origin',
      onActivePath: true,
      createdAt: draft.templateCreatedAt,
    });
    expect(layout.nodes.find((node) => node.key === 'filled:MIX_FILL:template-new')).toMatchObject({
      onActivePath: true,
    });
    expect(
      layout.edges.find(
        (edge) => edge.key === 'origin:MIX_TEMPLATE:template-new->filled:MIX_FILL:template-new',
      ),
    ).toMatchObject({ onActivePath: true });
    expect(layout.nodes.filter((node) => node.stageKey === 'MIX_TEMPLATE')).toHaveLength(3);

    const editor = buildEffectBranchLayout([main, sibling, filled, origin], 'template-new');
    expect(
      editor.nodes
        .filter((node) => node.stageKey === 'MIX_TEMPLATE' && node.onActivePath)
        .map((node) => node.key),
    ).toEqual(['origin:MIX_TEMPLATE:template-new']);
  });

  it('keeps templates separate after an upstream rendering fork even if IDs were copied', () => {
    const main = branch('main', null, null);
    const rendered = branch('rendered', 'main', 'SEGMENT_RENDER', true);
    const layout = buildEffectBranchLayout([main, rendered]);
    expect(layout.nodes.filter((node) => node.stageKey === 'MIX_TEMPLATE')).toHaveLength(2);
    expect(
      layout.edges.some(
        (edge) => edge.key === 'rendered:SEGMENT_RENDER:-->rendered:MIX_TEMPLATE:template-a',
      ),
    ).toBe(true);
  });

  it('keeps another template path visible while the active old sibling does not contain it', () => {
    const main = branch('main', null, null);
    const origin = branch('origin', 'main', 'TEMPLATE_MIX');
    origin.forkMixStage = 'PACKAGING';
    origin.forkTemplateId = 'template-a';
    const template = {
      templateId: 'template-new',
      name: '测试2',
      templateRevision: null,
      fillRevision: null,
      packagingRevision: null,
      timelineVariantCount: 0,
      packagingVariantCount: 0,
    };
    origin.templates.push(template);
    const filled = branch('filled', 'origin', 'TEMPLATE_MIX');
    filled.forkMixStage = 'TEMPLATE';
    filled.forkTemplateId = template.templateId;
    filled.templates.push({
      ...template,
      templateRevision: 1,
      fillRevision: 1,
      timelineVariantCount: 3,
    });
    const packaged = branch('packaged', 'filled', 'TEMPLATE_MIX');
    packaged.forkMixStage = 'PACKAGING';
    packaged.forkTemplateId = template.templateId;
    packaged.templates.push({
      ...filled.templates.at(-1)!,
      packagingRevision: 1,
      packagingVariantCount: 3,
    });
    const active = branch('old-sibling', 'main', 'TEMPLATE_MIX', true);
    active.forkMixStage = 'PACKAGING';
    active.forkTemplateId = 'template-a';
    const layout = buildEffectBranchLayout([main, origin, filled, packaged, active], 'template-a');
    expect(
      layout.nodes
        .filter((node) => node.templateId === template.templateId)
        .map((node) => node.key),
    ).toEqual([
      'origin:MIX_TEMPLATE:template-new',
      'filled:MIX_FILL:template-new',
      'packaged:MIX_PACKAGING:template-new',
    ]);
    expect(
      layout.edges.some(
        (edge) => edge.key === 'origin:MIX_TEMPLATE:template-new->filled:MIX_FILL:template-new',
      ),
    ).toBe(true);
    expect(
      layout.edges.some(
        (edge) => edge.key === 'filled:MIX_FILL:template-new->packaged:MIX_PACKAGING:template-new',
      ),
    ).toBe(true);
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
