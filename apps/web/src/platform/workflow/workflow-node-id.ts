import type { WorkflowNodeState } from '@ai-marketing/contracts';

const VISIBLE_NODE_ALIASES: Readonly<Record<string, string>> = {
  SEGMENT_RENDER_SETTINGS: 'SEGMENT_RENDER',
};

export const workflowNodeBaseId = (nodeId: string | null | undefined): string | null => {
  const value = nodeId?.trim();
  if (!value) return null;
  const baseId = value.split(':', 1)[0] ?? value;
  return VISIBLE_NODE_ALIASES[baseId] ?? baseId;
};

export const latestWorkflowNodeStateMap = (
  states: readonly WorkflowNodeState[],
): Map<string, WorkflowNodeState> => {
  const latest = new Map<string, WorkflowNodeState>();
  for (const state of states) {
    const baseId = workflowNodeBaseId(state.nodeId);
    if (!baseId) continue;
    const current = latest.get(baseId);
    if (!current || Date.parse(state.savedAt) >= Date.parse(current.savedAt))
      latest.set(baseId, state);
  }
  return latest;
};
