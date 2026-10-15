import {
  EFFECT_PROMPT_GRAPH_NODE_IDS,
  EFFECT_PROMPT_ITEM_EVALUATE_GRAPH_NODE_IDS,
  effectPromptRunGraphNodeIds,
  type EffectPromptNodeId,
  type EffectPromptOperation,
  type EffectPromptShardPhase,
} from '@ai-marketing/contracts';

export const promptPrecedingNodeIds = (nodeId: EffectPromptNodeId): EffectPromptNodeId[] => {
  const preceding = new Set<EffectPromptNodeId>();
  for (const graph of [EFFECT_PROMPT_GRAPH_NODE_IDS, EFFECT_PROMPT_ITEM_EVALUATE_GRAPH_NODE_IDS]) {
    const index = graph.findIndex((id) => id === nodeId);
    if (index >= 0) graph.slice(0, index).forEach((id) => preceding.add(id));
  }
  return [...preceding];
};

export const promptStageProgress = (
  nodeId: EffectPromptNodeId,
  status: string,
  operation: EffectPromptOperation,
): number => {
  const nodeIds = effectPromptRunGraphNodeIds(operation);
  const index = nodeIds.indexOf(nodeId);
  if (index < 0) return 1;
  const start = Math.round((index / nodeIds.length) * 95);
  const end = Math.round(((index + 1) / nodeIds.length) * 95);
  return status === 'SUCCEEDED' || status === 'SKIPPED'
    ? Math.min(99, end)
    : Math.max(1, start + 1);
};

export const promptShardProgress = (
  phase: EffectPromptShardPhase,
  round: number,
  completedItems: number,
  expectedItems: number,
): { progress: number; currentNode: EffectPromptNodeId } | null => {
  if (completedItems <= 0 || expectedItems <= 0) return null;
  const currentNode: EffectPromptNodeId =
    round > 0
      ? 'EXACT_SELECTION_AND_SUPPLEMENT'
      : phase === 'CREATIVE'
        ? 'COHERENT_CREATIVE_GENERATION'
        : 'CREATIVE_EVALUATION_CLASSIFICATION';
  const start = promptStageProgress(currentNode, 'RUNNING', 'BATCH_GENERATE');
  const end = promptStageProgress(currentNode, 'SUCCEEDED', 'BATCH_GENERATE') - 1;
  const midpoint = start + Math.floor((end - start) / 2);
  const lower = round > 0 && phase === 'CLASSIFICATION' ? midpoint : start;
  const upper = round > 0 ? (phase === 'CREATIVE' ? midpoint : end) : end;
  const fraction = Math.min(1, completedItems / expectedItems);
  return {
    progress: Math.min(upper, lower + Math.max(1, Math.round((upper - lower) * fraction))),
    currentNode,
  };
};
