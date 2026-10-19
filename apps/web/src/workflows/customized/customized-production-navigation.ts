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
