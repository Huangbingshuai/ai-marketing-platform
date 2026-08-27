import type { EffectPromptNodeId } from '@ai-marketing/contracts';

export const buildEffectPromptGraphRows = (
  nodeIds: readonly EffectPromptNodeId[],
  edges: ReadonlyArray<{ from: EffectPromptNodeId; to: EffectPromptNodeId }>,
): EffectPromptNodeId[][] => {
  const order = new Map(nodeIds.map((nodeId, index) => [nodeId, index]));
  const forwardEdges = edges.filter((edge) => {
    const sourceIndex = order.get(edge.from);
    const targetIndex = order.get(edge.to);
    return sourceIndex !== undefined && targetIndex !== undefined && sourceIndex < targetIndex;
  });
  const remaining = new Set(nodeIds);
  const rows: EffectPromptNodeId[][] = [];

  while (remaining.size) {
    const row = nodeIds.filter(
      (nodeId) =>
        remaining.has(nodeId) &&
        forwardEdges.every((edge) => edge.to !== nodeId || !remaining.has(edge.from)),
    );
    if (!row.length) return [...rows, [...remaining]];
    rows.push(row);
    row.forEach((nodeId) => remaining.delete(nodeId));
  }
  return rows;
};
