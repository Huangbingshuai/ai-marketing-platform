import { describe, expect, it } from 'vitest';

import {
  cloneExtractionResult,
  isExtractionReadyForNext,
  isExtractionRunning,
  toExtractionProductState,
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
  projectId: 'project-1',
  draftId: 'draft-1',
  productId: 'product-1',
  status,
  runId: null,
  resultId: 'result-1',
  resultRevision: 2,
  result,
  progress: status === 'COMPLETED' ? 100 : 0,
  currentNode: null,
  warnings: [],
  errorMessage: null,
  sourceFingerprint: 'source',
  commitStatus: status === 'COMPLETED' ? 'COMMITTED' : 'UNVALIDATED',
  workingArtifactRevision: status === 'COMPLETED' ? 1 : null,
  updatedAt: '2026-08-20T00:00:00.000Z',
  saveState: 'SAVED',
  saveErrorMessage: null,
});

describe('effect info extraction state', () => {
  it('only unlocks the next node for a completed product', () => {
    expect(isExtractionReadyForNext(state('COMPLETED'))).toBe(true);
    expect(isExtractionReadyForNext(state('STALE'))).toBe(false);
    expect(isExtractionReadyForNext(state('FAILED'))).toBe(false);
    expect(isExtractionReadyForNext(null)).toBe(false);
  });

  it('treats queued and processing products as active runs', () => {
    expect(isExtractionRunning(state('QUEUED'))).toBe(true);
    expect(isExtractionRunning(state('PROCESSING'))).toBe(true);
    expect(isExtractionRunning(state('COMPLETED'))).toBe(false);
  });

  it('clones editable array fields and server warnings', () => {
    const cloned = cloneExtractionResult(result);
    cloned.coreSellingPoints.push('卖点二');
    cloned.disabledElements.push('新增禁用词');
    expect(result.coreSellingPoints).toEqual(['卖点一']);
    expect(result.disabledElements).toEqual(['禁用元素']);

    const view = toExtractionProductState({
      ...state('COMPLETED'),
      warnings: [
        { code: 'COMMERCE_SKIPPED', message: '暂未抓取', branch: 'COMMERCE', sourceId: null },
      ],
    });
    view.warnings[0]!.message = '已修改';
    expect(view.saveState).toBe('SAVED');
    expect(view.saveErrorMessage).toBeNull();
  });
});
