import {
  CUSTOMIZED_WORKFLOW_NODES,
  type CustomizedWorkflowBranchTreeData,
} from '@ai-marketing/contracts';

/** Ordinary downstream navigation preserves an existing path owned by this exact script.
 * Explicit version selection must bypass this helper and activate its exact target. */
export function customizedProductionNavigationRun(
  tree: CustomizedWorkflowBranchTreeData | null,
  currentRunId: string,
  scriptRunId: string,
): string {
  const byId = new Map(tree?.branches.map((branch) => [branch.workflowRunId, branch]));
  const seen = new Set<string>();
  let current = byId.get(currentRunId);
  while (current && !seen.has(current.workflowRunId)) {
    if (current.workflowRunId === scriptRunId) return currentRunId;
    seen.add(current.workflowRunId);
    const fork = CUSTOMIZED_WORKFLOW_NODES.findIndex((id) => id === current!.forkNodeId);
    if (fork <= CUSTOMIZED_WORKFLOW_NODES.indexOf('STORYBOARD') || !current.parentWorkflowRunId)
      break;
    current = byId.get(current.parentWorkflowRunId);
  }
  return scriptRunId;
}

export function customizedScriptRun(
  tree: CustomizedWorkflowBranchTreeData | null,
  runId: string,
): string | null {
  const byId = new Map(tree?.branches.map((branch) => [branch.workflowRunId, branch]));
  const seen = new Set<string>();
  let current = byId.get(runId);
  while (current && !seen.has(current.workflowRunId)) {
    if (current.forkNodeId === 'STORYBOARD') return current.workflowRunId;
    seen.add(current.workflowRunId);
    if (!current.parentWorkflowRunId) break;
    current = byId.get(current.parentWorkflowRunId);
  }
  return null;
}

/** A script selection resumes its existing production path, never a sibling script. */
export function customizedScriptSelectionRun(
  tree: CustomizedWorkflowBranchTreeData | null,
  currentRunId: string,
  scriptRunId: string,
  rememberedRunId?: string,
): string {
  if (customizedScriptRun(tree, currentRunId) === scriptRunId) return currentRunId;
  if (rememberedRunId && customizedScriptRun(tree, rememberedRunId) === scriptRunId)
    return rememberedRunId;
  return (
    tree?.branches
      .filter(
        (branch) =>
          branch.workflowRunId !== scriptRunId &&
          customizedScriptRun(tree, branch.workflowRunId) === scriptRunId,
      )
      .sort(
        (a, b) =>
          b.createdAt.localeCompare(a.createdAt) ||
          CUSTOMIZED_WORKFLOW_NODES.indexOf(b.forkNodeId!) -
            CUSTOMIZED_WORKFLOW_NODES.indexOf(a.forkNodeId!) ||
          a.workflowRunId.localeCompare(b.workflowRunId),
      )[0]?.workflowRunId ?? scriptRunId
  );
}
