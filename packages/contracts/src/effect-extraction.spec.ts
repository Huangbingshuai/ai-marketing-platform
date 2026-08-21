import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  EFFECT_EXTRACTION_BRANCHES,
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
  targetAudience: '家庭用户',
  marketingGoal: '提升转化',
  coreSellingPoints: ['真实原料'],
  usageScenarios: '家庭聚餐',
  deliveryChannels: '抖音',
  brandTone: '自然可信',
  disabledElements: ['绝对化用语'],
};

describe('effect extraction contract', () => {
  it('keeps the public result aligned with the canonical JSON schema', () => {
    const schema = JSON.parse(
      readFileSync(resolve(process.cwd(), 'schemas/effect-extraction-result.schema.json'), 'utf8'),
    ) as { required: string[]; additionalProperties: boolean };

    expect(Object.keys(result).sort()).toEqual([...schema.required].sort());
    expect(schema.additionalProperties).toBe(false);
  });

  it('exposes stable v1 statuses and branch names', () => {
    expect(EFFECT_EXTRACTION_SCHEMA_VERSION).toBe(1);
    expect(EFFECT_EXTRACTION_PRODUCT_STATUSES).toContain('STALE');
    expect(EFFECT_EXTRACTION_PRODUCT_STATUSES).toContain('QUEUED');
    expect(EFFECT_EXTRACTION_BRANCHES).toEqual([
      'DOCUMENT',
      'IMAGE',
      'COMMERCE',
      'FORM',
      'FUSION',
      'NORMALIZATION',
    ]);
  });
});
