import { describe, expect, it } from 'vitest';

import {
  DEFAULT_EFFECT_PROMPT_SETTINGS,
  EFFECT_PROMPT_DIMENSIONS,
  EFFECT_PROMPT_GRAPH_EDGES,
  EFFECT_PROMPT_GRAPH_NODES,
  effectPromptSettingsNodeId,
  normalizeEffectPromptSettings,
} from './effect-prompt-generation';

describe('effect prompt generation contract', () => {
  it('freezes the six dimensions and public graph', () => {
    expect(EFFECT_PROMPT_DIMENSIONS).toHaveLength(6);
    expect(EFFECT_PROMPT_GRAPH_NODES.map((node) => node.id)).toContain('QUALITY_GATE');
    expect(EFFECT_PROMPT_GRAPH_EDGES).toContainEqual({
      from: 'REPLENISH',
      to: 'CANDIDATE_GENERATION',
    });
  });

  it('normalizes prototype settings', () => {
    expect(DEFAULT_EFFECT_PROMPT_SETTINGS.count).toBe(50);
    expect(
      normalizeEffectPromptSettings({
        count: 2,
        durationSeconds: 200,
        semanticLimit: 99,
        visualLimit: 1,
      }),
    ).toEqual({ count: 10, durationSeconds: 120, semanticLimit: 15, visualLimit: 10 });
  });

  it('uses a product-scoped internal node-state id', () => {
    expect(effectPromptSettingsNodeId('product-one')).toBe('PROMPT_GENERATION:product-one');
  });
});
