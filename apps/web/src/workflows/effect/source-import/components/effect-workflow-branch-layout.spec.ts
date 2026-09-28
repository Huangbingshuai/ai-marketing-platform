import {
  EFFECT_WORKFLOW_BRANCH_NODES,
  type EffectWorkflowBranch,
  type EffectWorkflowBranchNodeId,
} from '@ai-marketing/contracts';
import { describe, expect, it } from 'vitest';
import { BRANCH_TREE_STAGES, buildEffectBranchLayout } from './effect-workflow-branch-layout';

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
  it('draws one top-down path across the six workflow nodes and three mix layers', () => {
    const layout = buildEffectBranchLayout([branch('main', null, null, true)]);
    expect(layout.nodes.map((node) => node.stageKey)).toEqual(
      BRANCH_TREE_STAGES.map((stage) => stage.key),
    );
    expect(layout.nodes.map((node) => node.x)).toEqual(Array(8).fill(layout.nodes[0]?.x));
    expect(layout.nodes.map((node) => node.revision)).toEqual([1, 2, 3, 4, 2, 3, 4, 5]);
    expect(layout.nodes.find((node) => node.stageKey === 'SOURCE_IMPORT')?.createdAt).toBe(
      '2026-09-20T00:00:00.000Z',
    );
    expect(layout.nodes.find((node) => node.stageKey === 'MIX_TEMPLATE')?.createdAt).toBeNull();
    expect(layout.nodes.find((node) => node.stageKey === 'MIX_FILL')?.createdAt).toBe(
      '2026-09-27T00:00:00.000Z',
    );
    expect(layout.edges).toHaveLength(7);
    expect(layout.nodes.every((node) => node.onActivePath)).toBe(true);
    expect(layout.nodes.filter((node) => node.isCurrentStage).map((node) => node.stageKey)).toEqual(
      ['PROMPT_GENERATION'],
    );
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

  it('shows every template as a child of rendering without a template filter', () => {
    const main = branch('main', null, null, true);
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
    expect(render.x).toBe((templates[0]!.x + templates[1]!.x) / 2);
    expect(layout.edges.filter((edge) => edge.key.startsWith(`${render.key}->`))).toHaveLength(2);
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

  it('keeps ungenerated mix layers as pending rectangles without inventing revisions', () => {
    const main = branch('main', null, null, true);
    main.templates = [];
    const layout = buildEffectBranchLayout([main]);
    expect(
      layout.nodes
        .filter((node) => node.nodeId === 'TEMPLATE_MIX')
        .map((node) => ({
          status: node.status,
          revision: node.revision,
        })),
    ).toEqual(Array(3).fill({ status: 'PENDING', revision: null }));
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
