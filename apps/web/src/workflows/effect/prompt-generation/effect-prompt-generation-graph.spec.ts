import {
  CURRENT_EFFECT_PROMPT_GRAPH_VERSION,
  EFFECT_PROMPT_GRAPH_VERSIONS,
  effectPromptGraphEdges,
  effectPromptGraphNodeIds,
  effectPromptRunGraphEdges,
  effectPromptRunGraphNodeIds,
} from '@ai-marketing/contracts';
import { describe, expect, it } from 'vitest';

import { buildEffectPromptGraphRows } from './effect-prompt-generation-graph';

describe('effect prompt generation graph layout', () => {
  it.each(EFFECT_PROMPT_GRAPH_VERSIONS)(
    'lays out every %s node once from contract edges',
    (version) => {
      const nodeIds = effectPromptGraphNodeIds(version);
      const rows = buildEffectPromptGraphRows(nodeIds, effectPromptGraphEdges(version));
      const flattened = rows.flat();

      expect(flattened).toEqual(nodeIds);
      expect(new Set(flattened).size).toBe(nodeIds.length);
    },
  );

  it('renders the current batch generation as ordered stages', () => {
    const version = CURRENT_EFFECT_PROMPT_GRAPH_VERSION;
    expect(effectPromptRunGraphNodeIds(version, 'BATCH_GENERATE')).toEqual([
      'LOAD_AND_SNAPSHOT',
      'INSIGHT_MAPPING',
      'FACT_VISUAL_STRATEGY_COMPILATION',
      'SHARED_PROMPT_COMPILATION',
      'COHERENT_CREATIVE_GENERATION',
      'CREATIVE_EVALUATION_CLASSIFICATION',
      'EXACT_SELECTION_AND_SUPPLEMENT',
      'RESULT_SAVE',
    ]);
    expect(
      buildEffectPromptGraphRows(
        effectPromptRunGraphNodeIds(version, 'BATCH_GENERATE'),
        effectPromptRunGraphEdges(version, 'BATCH_GENERATE'),
      ),
    ).toHaveLength(8);
  });

  it('uses the dedicated five-stage path for asynchronous item evaluation', () => {
    const version = CURRENT_EFFECT_PROMPT_GRAPH_VERSION;
    const nodeIds = effectPromptRunGraphNodeIds(version, 'ITEM_EVALUATE');
    expect(nodeIds).toEqual([
      'LOAD_AND_SNAPSHOT',
      'INSIGHT_MAPPING',
      'FACT_VISUAL_STRATEGY_COMPILATION',
      'SHARED_PROMPT_COMPILATION',
      'ITEM_EVALUATE',
      'RESULT_SAVE',
    ]);
    expect(
      buildEffectPromptGraphRows(
        nodeIds,
        effectPromptRunGraphEdges(version, 'ITEM_EVALUATE'),
      ).flat(),
    ).toEqual(nodeIds);
  });

  it('places fact visual strategy compilation between insight mapping and generation', () => {
    const version = CURRENT_EFFECT_PROMPT_GRAPH_VERSION;
    const batchNodes = effectPromptRunGraphNodeIds(version, 'BATCH_GENERATE');
    expect(batchNodes).toEqual([
      'LOAD_AND_SNAPSHOT',
      'INSIGHT_MAPPING',
      'FACT_VISUAL_STRATEGY_COMPILATION',
      'SHARED_PROMPT_COMPILATION',
      'COHERENT_CREATIVE_GENERATION',
      'CREATIVE_EVALUATION_CLASSIFICATION',
      'EXACT_SELECTION_AND_SUPPLEMENT',
      'RESULT_SAVE',
    ]);
    expect(effectPromptRunGraphNodeIds(version, 'ITEM_EVALUATE')).toContain(
      'FACT_VISUAL_STRATEGY_COMPILATION',
    );
  });

  it('ignores only backward replenishment edges when calculating display rows', () => {
    for (const version of EFFECT_PROMPT_GRAPH_VERSIONS) {
      const rows = buildEffectPromptGraphRows(
        effectPromptGraphNodeIds(version),
        effectPromptGraphEdges(version),
      );
      const rowByNode = new Map(
        rows.flatMap((row, rowIndex) => row.map((nodeId) => [nodeId, rowIndex] as const)),
      );
      for (const edge of effectPromptGraphEdges(version)) {
        const sourceRow = rowByNode.get(edge.from)!;
        const targetRow = rowByNode.get(edge.to)!;
        if (edge.from === 'REPLENISH') expect(sourceRow).toBeGreaterThan(targetRow);
        else expect(sourceRow).toBeLessThan(targetRow);
      }
    }
  });
});
