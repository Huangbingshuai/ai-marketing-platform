import {
  EFFECT_PROMPT_GRAPH_EDGES,
  EFFECT_PROMPT_GRAPH_NODE_IDS,
  effectPromptRunGraphEdges,
  effectPromptRunGraphNodeIds,
  type EffectPromptRun,
} from '@ai-marketing/contracts';
import { describe, expect, it } from 'vitest';
import { nextTick, ref, watch } from 'vue';

import {
  buildEffectPromptGraphRows,
  promptGraphDetailRefreshKey,
} from './effect-prompt-generation-graph';

describe('selected prompt node detail refresh', () => {
  const active = (): Pick<
    EffectPromptRun,
    'id' | 'status' | 'attemptCount' | 'currentNode' | 'updatedAt' | 'nodes'
  > => ({
    id: 'test-run',
    status: 'RUNNING',
    attemptCount: 1,
    currentNode: 'COHERENT_CREATIVE_GENERATION',
    updatedAt: '2026-09-08T04:00:00Z',
    nodes: [
      {
        nodeId: 'COHERENT_CREATIVE_GENERATION',
        status: 'RUNNING',
        summary: '正在生成',
        warnings: [],
        errorMessage: null,
      },
    ],
  });

  it('refreshes the selected node when execution moves on and reaches terminal state', async () => {
    const run = ref(active());
    const keys: Array<string | null> = [];
    const stop = watch(
      () => promptGraphDetailRefreshKey(run.value, 'COHERENT_CREATIVE_GENERATION'),
      (key) => keys.push(key),
    );
    run.value = {
      ...run.value,
      currentNode: 'CREATIVE_EVALUATION_CLASSIFICATION',
      nodes: [{ ...run.value.nodes[0]!, status: 'SUCCEEDED', summary: '已完成' }],
    };
    await nextTick();
    expect(keys).toHaveLength(1);
    run.value = { ...run.value, updatedAt: '2026-09-08T04:00:10Z' };
    await nextTick();
    expect(keys).toHaveLength(1); // other stages' heartbeats do not refresh this completed stage
    run.value = { ...run.value, status: 'COMPLETED', currentNode: 'COMPLETED' };
    await nextTick();
    expect(keys).toHaveLength(2);
    stop();
  });

  it('refreshes running progress, failed/requeued attempts and new runs', () => {
    const run = active();
    const key = promptGraphDetailRefreshKey(run, 'COHERENT_CREATIVE_GENERATION');
    for (const next of [
      { ...run, updatedAt: '2026-09-08T04:00:10Z' },
      { ...run, status: 'FAILED' as const },
      { ...run, status: 'QUEUED' as const, attemptCount: 2 },
      { ...run, id: 'next-run' },
    ])
      expect(promptGraphDetailRefreshKey(next, 'COHERENT_CREATIVE_GENERATION')).not.toBe(key);
    expect(promptGraphDetailRefreshKey(null, 'COHERENT_CREATIVE_GENERATION')).toBeNull();
    expect(promptGraphDetailRefreshKey(run, null)).toBeNull();
  });
});

describe('effect prompt generation graph layout', () => {
  it('按照唯一当前拓扑依次展示全部批次节点', () => {
    const rows = buildEffectPromptGraphRows(
      EFFECT_PROMPT_GRAPH_NODE_IDS,
      EFFECT_PROMPT_GRAPH_EDGES,
    );
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
    expect(
      buildEffectPromptGraphRows(nodeIds, effectPromptRunGraphEdges('ITEM_EVALUATE')).flat(),
    ).toEqual(nodeIds);
  });
});
