import type {
  EffectPromptNodeId,
  EffectPromptRun,
  GetEffectPromptNodeDetailData,
} from '@ai-marketing/contracts';

type PromptGraphNodeDetail = GetEffectPromptNodeDetailData['detail'];

/** Ignore heartbeat-only timestamps so the detail panel is not rebuilt on every poll. */
export const promptGraphDetailContentKey = (detail: PromptGraphNodeDetail): string =>
  JSON.stringify([
    detail.nodeId,
    detail.status,
    detail.summary,
    detail.sections,
    detail.fields,
    detail.blocks,
    detail.warnings,
    detail.errorMessage,
  ]);

/** Refresh the selected stage once when it finishes, not only while it is active. */
export const promptGraphDetailRefreshKey = (
  run: Pick<
    EffectPromptRun,
    'id' | 'status' | 'attemptCount' | 'currentNode' | 'updatedAt' | 'nodes'
  > | null,
  nodeId: EffectPromptNodeId | null,
): string | null => {
  if (!run || !nodeId) return null;
  return JSON.stringify([
    run.id,
    run.status,
    run.attemptCount,
    run.nodes.find((node) => node.nodeId === nodeId) ?? null,
    run.currentNode === nodeId ? run.updatedAt : null,
  ]);
};

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
