import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  EFFECT_EXTRACTION_BRANCHES,
  EFFECT_EXTRACTION_GRAPH_EDGES,
  EFFECT_EXTRACTION_GRAPH_NODES,
  EFFECT_EXTRACTION_MAX_EDITABLE_LIST_ITEMS,
  EFFECT_EXTRACTION_PRODUCT_STATUSES,
  EFFECT_EXTRACTION_SCHEMA_VERSION,
  type EffectExtractionResult,
} from './effect-extraction';

const result: EffectExtractionResult = {
  productCategory: '食品',
  productName: '示例产品',
  coreSpecification: '500g',
  priceRange: '50–80 元',
  visualFeatures: '红色包装',
  coreSellingPoints: ['真实原料'],
  secondarySellingPoints: ['便于储存'],
  trustBackings: [],
  targetAudience: '家庭用户',
  corePainPoints: ['备餐时间有限'],
  decisionDrivers: ['规格适合家庭分享'],
  marketingGoal: '提升转化',
  usageScenarios: ['家庭聚餐'],
  purchaseScenarios: ['家庭囤货'],
  emotionalScenarios: ['家庭分享'],
  durationSeconds: 20,
  aspectRatio: '9:16',
  resolution: '1080P',
  deliveryChannels: '抖音',
  disabledElements: ['绝对化用语'],
  visualStyleBaseline: '自然可信',
};

describe('effect extraction contract', () => {
  it('keeps the public result aligned with the canonical JSON schema', () => {
    const schema = JSON.parse(
      readFileSync(resolve(process.cwd(), 'schemas/effect-extraction-result.schema.json'), 'utf8'),
    ) as {
      required: string[];
      additionalProperties: boolean;
      $defs: Record<string, { maxItems?: number }>;
    };

    expect(Object.keys(result).sort()).toEqual([...schema.required].sort());
    expect(schema.additionalProperties).toBe(false);
    expect(schema.$defs.editableRequiredItems?.maxItems).toBe(
      EFFECT_EXTRACTION_MAX_EDITABLE_LIST_ITEMS,
    );
    expect(schema.$defs.editableItems?.maxItems).toBe(EFFECT_EXTRACTION_MAX_EDITABLE_LIST_ITEMS);
  });

  it('exposes stable v2 statuses and branch names', () => {
    expect(EFFECT_EXTRACTION_SCHEMA_VERSION).toBe(2);
    expect(EFFECT_EXTRACTION_PRODUCT_STATUSES).toContain('STALE');
    expect(EFFECT_EXTRACTION_PRODUCT_STATUSES).toContain('QUEUED');
    expect(EFFECT_EXTRACTION_BRANCHES).toEqual([
      'DOCUMENT',
      'IMAGE',
      'COMMERCE',
      'FORM',
      'FUSION',
      'SEMANTIC_REFINEMENT',
      'NORMALIZATION',
    ]);
  });

  it('exposes one stable execution definition for the eight-node graph', () => {
    const nodeIds = EFFECT_EXTRACTION_GRAPH_NODES.map((node) => node.id);
    expect(nodeIds).toHaveLength(8);
    expect(new Set(nodeIds).size).toBe(nodeIds.length);
    expect(nodeIds).toEqual([
      'LOAD_AND_SNAPSHOT',
      'DOCUMENT',
      'IMAGE',
      'COMMERCE',
      'FORM',
      'FUSION',
      'SEMANTIC_REFINEMENT',
      'NORMALIZATION',
    ]);
    expect(EFFECT_EXTRACTION_GRAPH_EDGES).toHaveLength(10);
    expect(
      EFFECT_EXTRACTION_GRAPH_EDGES.every(
        ({ from, to }) => nodeIds.includes(from) && nodeIds.includes(to),
      ),
    ).toBe(true);
  });
});
