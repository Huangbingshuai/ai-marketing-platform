import {
  EFFECT_PROMPT_GRAPH_EDGES,
  EFFECT_PROMPT_GRAPH_NODE_IDS,
  effectPromptRunGraphEdges,
  effectPromptRunGraphNodeIds,
} from '@ai-marketing/contracts';
import { describe, expect, it } from 'vitest';

import { buildEffectPromptGraphRows } from './effect-prompt-generation-graph';

describe('effect prompt generation graph layout', () => {
  it('按照唯一当前拓扑依次展示全部批次节点', () => {
    const rows = buildEffectPromptGraphRows(EFFECT_PROMPT_GRAPH_NODE_IDS, EFFECT_PROMPT_GRAPH_EDGES);
    expect(rows.flat()).toEqual(EFFECT_PROMPT_GRAPH_NODE_IDS);
    expect(new Set(rows.flat()).size).toBe(EFFECT_PROMPT_GRAPH_NODE_IDS.length);
  });

  it('为单条异步评估使用固定精简路径', () => {
    const nodeIds = effectPromptRunGraphNodeIds('ITEM_EVALUATE');
    expect(nodeIds).toEqual([
      'LOAD_AND_SNAPSHOT',
      'INSIGHT_MAPPING',
      'FACT_VISUAL_STRATEGY_COMPILATION',
      'SHARED_PROMPT_COMPILATION',
      'ITEM_EVALUATE',
      'RESULT_SAVE',
    ]);
    expect(buildEffectPromptGraphRows(nodeIds, effectPromptRunGraphEdges('ITEM_EVALUATE')).flat()).toEqual(
      nodeIds,
    );
  });
});
