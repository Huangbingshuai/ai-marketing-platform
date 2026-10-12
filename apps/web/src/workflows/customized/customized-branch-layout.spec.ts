import { describe, expect, it } from 'vitest';
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
  it('keeps six stage bands but draws no fake versions for an empty draft', () => {
    expect(customizedBranchStages.map((stage) => stage.nodeId)).toEqual(CUSTOMIZED_WORKFLOW_NODES);
    expect(buildCustomizedBranchLayout(tree([branch('a', null, null, [])])).nodes).toEqual([]);
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
