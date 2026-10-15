import type { EffectWorkflowBranchNodeId } from '@ai-marketing/contracts';

/** Display names only; persisted node IDs and workflow semantics stay unchanged. */
export const EFFECT_NODE_LABELS = {
  SOURCE_IMPORT: '资料导入',
  INFORMATION_EXTRACTION: '信息提炼',
  PROMPT_GENERATION: '素材 Prompt',
  SEGMENT_RENDER: '片段渲染',
  TEMPLATE_MIX: '模板混剪',
  FINAL_OUTPUT: '成片输出',
} as const satisfies Record<EffectWorkflowBranchNodeId, string>;
