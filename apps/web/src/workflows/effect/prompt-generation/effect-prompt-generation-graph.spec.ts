import {
  EFFECT_PROMPT_GRAPH_NODES,
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

  it('renders the four V10 six-way stages as independent parallel rows', () => {
    const rows = buildEffectPromptGraphRows(
      effectPromptGraphNodeIds('V10_RELATION_COORDINATE_BLUEPRINT'),
      effectPromptGraphEdges('V10_RELATION_COORDINATE_BLUEPRINT'),
    );
    const groupByNode = new Map(EFFECT_PROMPT_GRAPH_NODES.map((node) => [node.id, node.group]));
    const sixWayGroups = rows
      .filter((row) => row.length === 6)
      .map((row) => [...new Set(row.map((nodeId) => groupByNode.get(nodeId)))])
      .map(([group]) => group);

    expect(sixWayGroups).toEqual(['STRATEGY', 'COORDINATE', 'BLUEPRINT', 'GENERATION']);
  });

  it('renders V11 batch generation as seven ordered stages', () => {
    const version = 'V11_COHERENT_CREATIVE_GENERATION' as const;
    expect(effectPromptRunGraphNodeIds(version, 'BATCH_GENERATE')).toEqual([
      'LOAD_AND_SNAPSHOT',
      'INSIGHT_MAPPING',
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
    ).toHaveLength(7);
  });

  it('uses the dedicated five-stage path for asynchronous item evaluation', () => {
    const version = 'V11_COHERENT_CREATIVE_GENERATION' as const;
    const nodeIds = effectPromptRunGraphNodeIds(version, 'ITEM_EVALUATE');
    expect(nodeIds).toEqual([
      'LOAD_AND_SNAPSHOT',
      'INSIGHT_MAPPING',
      'SHARED_PROMPT_COMPILATION',
      'ITEM_EVALUATE',
      'RESULT_SAVE',
    ]);
    expect(
      buildEffectPromptGraphRows(nodeIds, effectPromptRunGraphEdges(version, 'ITEM_EVALUATE')).flat(),
    ).toEqual(nodeIds);
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
