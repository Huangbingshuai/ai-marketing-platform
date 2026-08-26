import type { WorkflowNodeState } from '@ai-marketing/contracts';

export const workflowNodeBaseId = (nodeId: string | null | undefined): string | null => {
  const value = nodeId?.trim();
  if (!value) return null;
  return value.split(':', 1)[0] ?? value;
};

export const latestWorkflowNodeStateMap = (
  states: readonly WorkflowNodeState[],
): Map<string, WorkflowNodeState> => {
  const latest = new Map<string, WorkflowNodeState>();
  for (const state of states) {
    const baseId = workflowNodeBaseId(state.nodeId);
    if (!baseId) continue;
    const current = latest.get(baseId);
    if (!current || Date.parse(state.savedAt) >= Date.parse(current.savedAt)) latest.set(baseId, state);
  }
  return latest;
};
