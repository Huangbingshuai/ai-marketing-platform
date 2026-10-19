import { describe, expect, it } from 'vitest';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import BranchTree from '../effect/source-import/components/EffectWorkflowBranchTree.vue';
import {
  CUSTOMIZED_WORKFLOW_NODES,
  type CustomizedWorkflowBranch,
  type CustomizedWorkflowBranchTreeData,
} from '@ai-marketing/contracts';
import { buildCustomizedBranchLayout, customizedBranchStages } from './customized-branch-layout';

const branch = (
  id: string,
  parent: string | null,
  forkNodeId: CustomizedWorkflowBranch['forkNodeId'],
  confirmed: number[],
  active = false,
): CustomizedWorkflowBranch => ({
  workflowRunId: id,
  parentWorkflowRunId: parent,
  forkNodeId,
  label: id,
  currentNodeId: 'SOURCE_IMPORT',
  createdAt: id,
  isActive: active,
  nodes: CUSTOMIZED_WORKFLOW_NODES.map((nodeId, index) => ({
    nodeId,
    status: confirmed.includes(index) ? 'CONFIRMED' : 'PENDING',
    artifactCount: confirmed.includes(index) ? 1 : 0,
    revision: confirmed.includes(index) ? 1 : null,
    artifactCreatedAt: null,
  })),
});
const tree = (branches: CustomizedWorkflowBranch[]): CustomizedWorkflowBranchTreeData => ({
  projectId: 'p',
  activeWorkflowRunId: branches.find((item) => item.isActive)?.workflowRunId ?? null,
  branches,
});
describe('customized adapter for the shared effect branch tree', () => {
  it('shows independent script names and sibling lanes without borrowing template identity', () => {
    const layout = buildCustomizedBranchLayout(
      tree([
        branch('root', null, null, [0, 1]),
        { ...branch('script-a', 'root', 'STORYBOARD', [0, 1, 2], true), label: '晨光' },
        { ...branch('script-b', 'root', 'STORYBOARD', [0, 1, 2]), label: '归家' },
      ]),
    );
    const scripts = layout.nodes.filter((n) => n.nodeId === 'STORYBOARD');
    expect(scripts.map((s) => s.displayLabel)).toEqual(['晨光', '归家']);
    expect(scripts.every((s) => s.templateId === null && s.templateName === null)).toBe(true);
    expect(scripts[0]!.x).not.toBe(scripts[1]!.x);
    expect(scripts[0]!.y).toBe(scripts[1]!.y);
  });
  it('keeps five stage bands but draws no fake versions for an empty draft', () => {
    expect(customizedBranchStages.map((stage) => stage.nodeId)).toEqual(CUSTOMIZED_WORKFLOW_NODES);
    expect(buildCustomizedBranchLayout(tree([branch('a', null, null, [])])).nodes).toEqual([]);
  });
  it('shows one aggregate asset band, sibling extraction versions and stable local numbering', () => {
    const data = tree([
      branch('root', null, null, [0, 1]),
      branch('script', 'root', 'STORYBOARD', [0, 1, 2]),
      branch('assets-a', 'script', 'SHOT_PROMPT', [0, 1, 2, 3], true),
      branch('assets-b', 'script', 'SHOT_PROMPT', [0, 1, 2, 3]),
    ]);
    data.branches[2]!.nodes[3]!.revision = 10;
    data.branches[2]!.nodes[3]!.artifactCount = 8;
    data.branches[3]!.nodes[3]!.revision = 20;
    const layout = buildCustomizedBranchLayout(data);
    expect(customizedBranchStages).toHaveLength(5);
    expect(
      layout.nodes.filter((n) => n.nodeId === 'SHOT_PROMPT').map((n) => [n.stageKey, n.revision]),
    ).toEqual([
      ['SHOT_PROMPT', 1],
      ['SHOT_PROMPT', 2],
    ]);
    expect(layout.edges.map((e) => e.key)).toContain('script:STORYBOARD:-->assets-a:SHOT_PROMPT:-');
    expect(layout.edges.map((e) => e.key)).toContain('script:STORYBOARD:-->assets-b:SHOT_PROMPT:-');
    expect(layout.nodes.filter((n) => n.nodeId === 'SHOT_PROMPT')[0]!.artifactCount).toBe(8);
  });
  it('includes all sibling scripts under the active brief, with only the viewed script marked current', () => {
    const data = tree([
      branch('root', null, null, [0, 1]),
      branch('script-a', 'root', 'STORYBOARD', [0, 1, 2, 3], true),
      branch('script-b', 'root', 'STORYBOARD', [0, 1, 2, 3]),
      branch('new-brief', 'root', 'INFORMATION_EXTRACTION', [0, 1]),
      branch('other-script', 'new-brief', 'STORYBOARD', [0, 1, 2]),
    ]);
    const layout = buildCustomizedBranchLayout(data, {
      nodeId: 'STORYBOARD',
      scriptRunId: 'script-b',
    });
    expect(
      layout.nodes
        .filter((n) => n.nodeId === 'STORYBOARD' && n.onActivePath)
        .map((n) => n.workflowRunId),
    ).toEqual(['script-a', 'script-b']);
    expect(layout.nodes.filter((n) => n.isCurrentStage).map((n) => n.workflowRunId)).toEqual([
      'script-b',
    ]);
    expect(
      layout.nodes
        .filter((n) => n.nodeId === 'SHOT_PROMPT' && n.onActivePath)
        .map((n) => n.workflowRunId),
    ).toEqual(['script-a']);
    expect(data.activeWorkflowRunId).toBe('script-a');
    expect(data.branches.find((b) => b.isActive)?.workflowRunId).toBe('script-a');
  });
  it('includes the script collection when the active Run is still the brief head', () => {
    const layout = buildCustomizedBranchLayout(
      tree([
        branch('root', null, null, [0, 1], true),
        branch('script-a', 'root', 'STORYBOARD', [0, 1, 2]),
        branch('script-b', 'root', 'STORYBOARD', [0, 1, 2]),
      ]),
    );
    expect(layout.nodes.filter((n) => n.nodeId === 'STORYBOARD').every((n) => n.onActivePath)).toBe(
      true,
    );
    expect(layout.nodes.filter((n) => n.nodeId === 'STORYBOARD' && n.isCurrentStage)).toEqual([]);
  });
  it('does not label an arbitrary sibling current when the viewed downstream node has no artifact', async () => {
    const layout = buildCustomizedBranchLayout(
      tree([
        branch('root', null, null, [0, 1]),
        branch('script-a', 'root', 'STORYBOARD', [0, 1, 2], true),
        branch('script-b', 'root', 'STORYBOARD', [0, 1, 2]),
      ]),
      { nodeId: 'SHOT_PROMPT', scriptRunId: null },
    );
    const context: { teleports?: Record<string, string> } = {};
    await renderToString(
      createSSRApp(BranchTree, {
        projectName: '测试项目',
        tree: null,
        alternateLayout: layout,
        alternateStages: customizedBranchStages,
        loading: false,
        error: '',
        switching: false,
        forkDisabled: true,
        activeTemplateId: null,
        navigationDescription: '点击脚本只切换查看',
      }),
      context,
    );
    const html = Object.values(context.teleports ?? {}).join('');
    expect(html).not.toContain('当前查看');
    expect(html).toContain('点击脚本只切换查看');
  });
  it('inherits upstream heads and draws changed versions in separate lanes', () => {
    const layout = buildCustomizedBranchLayout(
      tree([
        branch('a', null, null, [0, 1]),
        branch('b', 'a', 'INFORMATION_EXTRACTION', [0, 1], true),
      ]),
    );
    expect(layout.nodes.map((node) => node.key)).toEqual([
      'a:SOURCE_IMPORT:-',
      'a:INFORMATION_EXTRACTION:-',
      'b:INFORMATION_EXTRACTION:-',
    ]);
    const source = layout.nodes[0]!;
    expect(source.onActivePath).toBe(true);
    expect(layout.nodes[1]!.onActivePath).toBe(false);
    expect(layout.nodes[2]!.onActivePath).toBe(true);
    expect(layout.nodes[1]!.x).not.toBe(layout.nodes[2]!.x);
    expect(layout.edges).toHaveLength(3);
  });
  it('does not mark an unused downstream stage complete or stale when changing sources', () => {
    const layout = buildCustomizedBranchLayout(
      tree([branch('a', null, null, [0, 1]), branch('b', 'a', 'SOURCE_IMPORT', [0], true)]),
    );
    expect(layout.nodes.filter((node) => node.onActivePath).map((node) => node.nodeId)).toEqual([
      'SOURCE_IMPORT',
    ]);
    expect(layout.nodes.every((node) => !node.showStaleWarning)).toBe(true);
  });
});
