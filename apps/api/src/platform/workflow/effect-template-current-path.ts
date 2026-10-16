import {
  EFFECT_TEMPLATE_CURRENT_PATH_NODE_ID,
  type EffectTemplateCurrentPathState,
} from '@ai-marketing/contracts';

/** Copied navigation state is not a choice of the receiving branch. */
export function selectedEffectTemplatePaths(
  workflowRunId: string,
  states: readonly {
    nodeId?: string;
    state: unknown;
  }[],
): Record<string, string> {
  const value = states.find((row) => row.nodeId === EFFECT_TEMPLATE_CURRENT_PATH_NODE_ID)?.state;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const state = value as Partial<EffectTemplateCurrentPathState>;
  if (
    state.schemaVersion !== 1 ||
    state.workflowRunId !== workflowRunId ||
    !state.selectedTemplates ||
    typeof state.selectedTemplates !== 'object' ||
    Array.isArray(state.selectedTemplates)
  )
    return {};
  return Object.fromEntries(
    Object.entries(state.selectedTemplates).filter(
      ([id, at]) => id.length > 0 && typeof at === 'string' && Number.isFinite(Date.parse(at)),
    ),
  );
}
