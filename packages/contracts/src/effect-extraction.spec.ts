import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  EFFECT_EXTRACTION_BRANCHES,
  EFFECT_EXTRACTION_GRAPH_EDGES,
  EFFECT_EXTRACTION_GRAPH_NODES,
  EFFECT_EXTRACTION_MAX_SELLING_POINTS,
  EFFECT_EXTRACTION_PRODUCT_STATUSES,
  EFFECT_EXTRACTION_SCHEMA_VERSION,
  type EffectExtractionImageRecognitionSummary,
  type EffectExtractionResult,
} from './effect-extraction';

const result: EffectExtractionResult = {
  productCategory: '食品',
  productName: '示例产品',
  coreSpecification: '500g',
  priceRange: '50–80 元',
  visualFeatures: '红色包装',
  sellingPoints: ['真实原料', '便于储存', '适合家庭聚餐'],
};

describe('effect extraction contract', () => {
  it('keeps the image recognition summary display-only and count based', () => {
    const summary: EffectExtractionImageRecognitionSummary = {
      processedImageCount: 3,
      candidateSuggestionCount: 12,
      retainedSuggestionCount: 0,
    };

    expect(summary).toEqual({
      processedImageCount: 3,
      candidateSuggestionCount: 12,
      retainedSuggestionCount: 0,
    });
  });

  it('keeps the public result aligned with the canonical JSON schema', () => {
    const schema = JSON.parse(
      readFileSync(resolve(process.cwd(), 'schemas/effect-extraction-result.schema.json'), 'utf8'),
    ) as {
      required: string[];
      additionalProperties: boolean;
      $defs: Record<string, { minItems?: number; maxItems?: number }>;
    };

    expect(Object.keys(result).sort()).toEqual([...schema.required].sort());
    expect(schema.additionalProperties).toBe(false);
    expect(schema.$defs.sellingPoints?.minItems).toBeUndefined();
    expect(schema.$defs.sellingPoints?.maxItems).toBe(EFFECT_EXTRACTION_MAX_SELLING_POINTS);
  });

  it('keeps stable transport metadata and branch names without business version branching', () => {
    expect(EFFECT_EXTRACTION_SCHEMA_VERSION).toBe(3);
    expect(EFFECT_EXTRACTION_PRODUCT_STATUSES).toContain('STALE');
    expect(EFFECT_EXTRACTION_PRODUCT_STATUSES).toContain('QUEUED');
    expect(EFFECT_EXTRACTION_BRANCHES).toEqual([
      'DOCUMENT',
      'IMAGE',
      'COMMERCE',
      'FUSION',
      'SEMANTIC_REFINEMENT',
      'NORMALIZATION',
    ]);
  });

  it('exposes one stable execution definition for the seven-node graph', () => {
    const nodeIds = EFFECT_EXTRACTION_GRAPH_NODES.map((node) => node.id);
    expect(nodeIds).toHaveLength(7);
    expect(new Set(nodeIds).size).toBe(nodeIds.length);
    expect(nodeIds).toEqual([
      'LOAD_AND_SNAPSHOT',
      'DOCUMENT',
      'IMAGE',
      'COMMERCE',
      'FUSION',
      'SEMANTIC_REFINEMENT',
      'NORMALIZATION',
    ]);
    expect(EFFECT_EXTRACTION_GRAPH_EDGES).toHaveLength(8);
    expect(
      EFFECT_EXTRACTION_GRAPH_EDGES.every(
        ({ from, to }) => nodeIds.includes(from) && nodeIds.includes(to),
      ),
    ).toBe(true);
  });
});
