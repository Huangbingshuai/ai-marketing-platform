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
  coreSellingPoints: ['卖点一'],
  secondarySellingPoints: ['卖点二'],
  trustBackings: [],
  targetAudience: '目标人群',
  targetAudiences: ['目标人群'],
  corePainPoints: ['痛点一'],
  decisionDrivers: ['动因一'],
  marketingGoal: '营销目标',
  usageScenarios: ['使用场景'],
  purchaseScenarios: ['购买场景'],
  emotionalScenarios: ['情绪场景'],
  durationSeconds: 20,
  aspectRatio: '9:16',
  resolution: '1080p',
  deliveryChannels: '投放渠道',
  disabledElements: ['禁用元素'],
  visualStyleBaseline: '品牌调性',
};

const state = (status: EffectExtractionProductState['status']): EffectExtractionProductState => ({
  projectId: 'project-1',
  draftId: 'draft-1',
  productId: 'product-1',
  status,
  runId: null,
  resultId: 'result-1',
  resultSchemaVersion: 2,
  resultRevision: 2,
  result,
  manualOverrideFields: [],
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
    cloned.targetAudiences.push('新增人群');
    cloned.disabledElements.push('新增禁用词');
    expect(result.coreSellingPoints).toEqual(['卖点一']);
    expect(result.targetAudiences).toEqual(['目标人群']);
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

  it('adapts a historical node draft with only a scalar target audience', () => {
    const legacyResult: Omit<EffectExtractionResult, 'targetAudiences'> & {
      targetAudiences?: string[];
    } = {
      ...result,
      targetAudience:
        '25-45岁家庭厨房决策者，美食爱好者，年货送礼人群，向往粤式风味的消费者',
    };
    delete legacyResult.targetAudiences;

    const cloned = cloneExtractionResult(legacyResult as EffectExtractionResult);

    expect(cloned.targetAudiences).toEqual([
      '25-45岁家庭厨房决策者',
      '美食爱好者',
      '年货送礼人群',
      '向往粤式风味的消费者',
    ]);
    expect(cloned.targetAudience).toBe(
      '25-45岁家庭厨房决策者；美食爱好者；年货送礼人群；向往粤式风味的消费者',
    );
    expect(cloned.targetAudiences.join(' ')).not.toContain('上班族');
  });
});
