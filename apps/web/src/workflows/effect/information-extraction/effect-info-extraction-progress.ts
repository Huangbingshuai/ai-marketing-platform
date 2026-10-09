import type {
  EffectExtractionNodeExecution,
  EffectExtractionNodeId,
  EffectExtractionProductState,
} from '@ai-marketing/contracts';

const stageMessages: Record<EffectExtractionNodeId, string> = {
  LOAD_AND_SNAPSHOT: '正在准备本次产品资料',
  DOCUMENT: '正在解析产品文档',
  IMAGE: '正在识别商品图片',
  COMMERCE: '正在读取电商商品信息',
  FUSION: '正在合并多来源产品信息',
  SEMANTIC_REFINEMENT: '正在核对图片补充与已有卖点',
  NORMALIZATION: '正在整理并保存产品信息卡',
};

const parallelActions = {
  DOCUMENT: '解析文档',
  IMAGE: '识别图片',
  COMMERCE: '读取电商信息',
} as const;

/** Present persisted execution state without exposing internal IDs or estimating progress. */
export function extractionProgressMessage(
  state: Pick<EffectExtractionProductState, 'status' | 'currentNode'> | null,
  nodes: readonly EffectExtractionNodeExecution[],
): string {
  if (!state) return '';
  if (state.status === 'QUEUED') return '正在等待 AI 提炼服务接单';
  if (state.status === 'COMPLETED') return '产品信息提炼已完成';
  if (state.status === 'FAILED') return '本次产品信息提炼失败';
  if (state.status === 'STALE') return '产品资料已变化，等待重新提炼';
  if (state.status === 'NOT_GENERATED') return '尚未开始产品信息提炼';

  // Parallel branches share currentNode; the last heartbeat is not necessarily the only active one.
  // Prefer later running stages if branch records and the progress heartbeat update separately.
  const sequentialStage = (['NORMALIZATION', 'SEMANTIC_REFINEMENT', 'FUSION'] as const).find(
    (id) =>
      state.currentNode === id ||
      nodes.some((node) => node.nodeId === id && node.status === 'RUNNING'),
  );
  if (sequentialStage) return stageMessages[sequentialStage];

  const runningActions = Object.entries(parallelActions)
    .filter(([id]) => nodes.some((node) => node.nodeId === id && node.status === 'RUNNING'))
    .map(([, action]) => action);
  if (runningActions.length) return `正在${runningActions.join('、')}`;

  if (state.currentNode === 'COMPLETED') return '正在同步提炼结果';
  const stage = Object.keys(stageMessages).find((id) => id === state.currentNode);
  return stage ? stageMessages[stage as EffectExtractionNodeId] : '正在分析产品资料';
}
