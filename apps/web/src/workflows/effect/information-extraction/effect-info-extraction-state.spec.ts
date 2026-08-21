import { describe, expect, it } from 'vitest';

import {
  cloneExtractionResult,
  isExtractionReadyForNext,
  type EffectExtractionProductState,
  type EffectExtractionResult,
} from './effect-info-extraction-state';

const result: EffectExtractionResult = {
  productCategory: '测试品类',
  productName: '测试产品',
  coreSpecification: '标准规格',
  priceRange: '主流价格带',
  visualFeatures: '包装主体清晰、颜色醒目',
  targetAudience: '目标人群',
  marketingGoal: '营销目标',
  coreSellingPoints: ['卖点一'],
  usageScenarios: '使用场景',
  deliveryChannels: '投放渠道',
  brandTone: '品牌调性',
  disabledElements: ['禁用元素'],
};

const state = (status: EffectExtractionProductState['status']): EffectExtractionProductState => ({
  productId: 'product-1',
  status,
  saveState: 'CLEAN',
  result,
  errorMessage: null,
  sourceFingerprint: 'source',
  attempt: 1,
  savedAt: null,
  updatedAt: '2026-08-20T00:00:00.000Z',
});
describe('effect info extraction state', () => {
  it('only unlocks the next node for a completed product', () => {
    expect(isExtractionReadyForNext(state('COMPLETED'))).toBe(true);
    expect(isExtractionReadyForNext(state('STALE'))).toBe(false);
    expect(isExtractionReadyForNext(state('FAILED'))).toBe(false);
    expect(isExtractionReadyForNext(null)).toBe(false);
  });

  it('clones editable array fields', () => {
    const cloned = cloneExtractionResult(result);
    cloned.coreSellingPoints.push('卖点二');
    cloned.disabledElements.push('新增禁用词');
    expect(result.coreSellingPoints).toEqual(['卖点一']);
    expect(result.disabledElements).toEqual(['禁用元素']);
  });
});
