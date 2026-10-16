import {
  CUSTOMIZED_WORKFLOW_NODES,
  type CustomizedWorkflowBranchTreeData,
  type CustomizedWorkflowNodeId,
} from '@ai-marketing/contracts';
import { customizedWorkflowNodes } from './customized-workflow';
import {
  BRANCH_TREE_TOP,
  BRANCH_TREE_ROW_GAP,
  placeWorkflowBranchNodes,
  type BranchTreeNode,
} from '../effect/source-import/components/effect-workflow-branch-layout';

export const customizedBranchStages = customizedWorkflowNodes.map((node) => ({
  key: node.id,
  nodeId: node.id,
  name: node.title,
}));
export type CustomizedBranchDisplayNode = Omit<BranchTreeNode, 'nodeId' | 'stageKey'> & {
  nodeId: CustomizedWorkflowNodeId;
  stageKey: CustomizedWorkflowNodeId;
};
export function buildCustomizedBranchLayout(
  tree: CustomizedWorkflowBranchTreeData | null,
  viewing?: { nodeId: CustomizedWorkflowNodeId; scriptRunId: string | null },
) {
  const branches = tree?.branches ?? [];
  const byId = new Map(branches.map((branch) => [branch.workflowRunId, branch]));
  const active = branches.find((branch) => branch.isActive);
  const ownerAt = (runId: string, stageIndex: number) => {
    let branch = byId.get(runId);
    const seen = new Set<string>();
    while (branch?.parentWorkflowRunId && !seen.has(branch.workflowRunId)) {
      seen.add(branch.workflowRunId);
      const fork = CUSTOMIZED_WORKFLOW_NODES.findIndex((node) => node === branch!.forkNodeId);
      if (fork < 0 || stageIndex >= fork) break;
      const parent = byId.get(branch.parentWorkflowRunId);
      if (!parent) break;
      branch = parent;
    }
    return branch;
  };
  const nodes: CustomizedBranchDisplayNode[] = [];
  for (const branch of branches)
    for (const [stageIndex, stage] of customizedBranchStages.entries()) {
      if (ownerAt(branch.workflowRunId, stageIndex)?.workflowRunId !== branch.workflowRunId)
        continue;
      const state = branch.nodes.find((node) => node.nodeId === stage.nodeId);
      if (!state?.artifactCount) continue;
      const onActivePath = Boolean(
        active &&
        (stage.nodeId === 'STORYBOARD'
          ? ownerAt(active.workflowRunId, 1)?.workflowRunId ===
            ownerAt(branch.workflowRunId, 1)?.workflowRunId
          : ownerAt(active.workflowRunId, stageIndex)?.workflowRunId === branch.workflowRunId),
      );
      nodes.push({
        key: `${branch.workflowRunId}:${stage.key}:-`,
        workflowRunId: branch.workflowRunId,
        stageKey: stage.key,
        nodeId: stage.nodeId,
        stageIndex,
        templateId: null,
        templateName: null,
        displayLabel:
          stage.nodeId === 'STORYBOARD' && branch.forkNodeId === 'STORYBOARD'
            ? branch.label
            : undefined,
        createdAt: state.artifactCreatedAt,
        x: 0,
        y: BRANCH_TREE_TOP + stageIndex * BRANCH_TREE_ROW_GAP,
        status: state.status,
        showStaleWarning: state.status === 'STALE',
        artifactCount: state.artifactCount,
        revision: state.revision,
        revisions: undefined,
        onActivePath,
        isCurrentStage:
          (viewing?.nodeId ?? active?.currentNodeId) === stage.nodeId &&
          (stage.nodeId === 'STORYBOARD'
            ? ownerAt(viewing ? (viewing.scriptRunId ?? '') : (active?.workflowRunId ?? ''), 2)
                ?.workflowRunId === branch.workflowRunId
            : onActivePath),
      });
    }
  const keys = new Set(nodes.map((node) => node.key));
  const parents = new Map<string, string>();
  for (const node of nodes)
    for (let index = node.stageIndex - 1; index >= 0; index--) {
      const owner = ownerAt(node.workflowRunId, index);
      const key = `${owner?.workflowRunId}:${customizedBranchStages[index]!.key}:-`;
      if (keys.has(key)) {
        parents.set(node.key, key);
        break;
      }
    }
  // One aggregate asset branch per successful full extraction. Picture iterations
  // and object edits advance business revisions without taking another number.
  const groups = new Map<string, CustomizedBranchDisplayNode[]>();
  for (const node of nodes.filter((n) => n.nodeId === 'SHOT_PROMPT')) {
    const key = parents.get(node.key) ?? node.workflowRunId;
    groups.set(key, [...(groups.get(key) ?? []), node]);
  }
  for (const group of groups.values())
    group
      .sort(
        (a, b) =>
          (a.createdAt ?? '').localeCompare(b.createdAt ?? '') || a.key.localeCompare(b.key),
      )
      .forEach((node, index) => {
        node.revision = index + 1;
      });
  return placeWorkflowBranchNodes(
    nodes,
    parents,
    customizedBranchStages.length,
    (a, b) =>
      (a.createdAt ?? byId.get(a.workflowRunId)?.createdAt ?? '').localeCompare(
        b.createdAt ?? byId.get(b.workflowRunId)?.createdAt ?? '',
      ) || a.key.localeCompare(b.key),
  );
}
