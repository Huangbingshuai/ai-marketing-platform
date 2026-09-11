import { describe, expect, it } from 'vitest';

import {
  cloneExtractionProductState,
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
  sellingPoints: ['卖点一', '适合家庭使用'],
};

const state = (status: EffectExtractionProductState['status']): EffectExtractionProductState => ({
  projectId: 'project-1',
  draftId: 'draft-1',
  productId: 'product-1',
  status,
  runId: null,
  resultId: 'result-1',
  resultSchemaVersion: 3,
  resultRevision: 2,
  result,
  provenance: { fieldOrigins: {}, fieldSourceNames: {}, itemOrigins: {} },
  imageRecognitionSummary: null,
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

  it('clones the unified selling-point list and provenance independently', () => {
    const cloned = cloneExtractionResult(result);
    cloned.sellingPoints.push('卖点三');
    expect(result.sellingPoints).toEqual(['卖点一', '适合家庭使用']);

    const view = toExtractionProductState({
      ...state('COMPLETED'),
      provenance: {
        fieldOrigins: {},
        fieldSourceNames: {},
        itemOrigins: {
          sellingPoints: [
            {
              value: '卖点一',
              origin: 'USER_FACT',
              sourceNames: ['用户资料'],
              semanticNotices: [
                {
                  issue: 'POSSIBLE_OVERLAP',
                  message: '建议检查',
                  suggestedField: null,
                  relatedValues: ['卖点二'],
                },
              ],
            },
          ],
        },
      },
      warnings: [
        { code: 'COMMERCE_SKIPPED', message: '暂未抓取', branch: 'COMMERCE', sourceId: null },
      ],
    });
    view.warnings[0]!.message = '已修改';
    view.provenance.itemOrigins.sellingPoints![0]!.semanticNotices![0]!.relatedValues.push(
      '卖点三',
    );
    expect(view.saveState).toBe('SAVED');
    expect(view.saveErrorMessage).toBeNull();
    expect(state('COMPLETED').provenance.itemOrigins.sellingPoints).toBeUndefined();
  });

  it('preserves every selling point when restoring a historical draft', () => {
    const restored = cloneExtractionResult({
      ...result,
      sellingPoints: Array.from({ length: 43 }, (_, index) => `卖点 ${index + 1}`),
    });

    expect(restored.sellingPoints).toHaveLength(43);
    expect(restored.sellingPoints.at(-1)).toBe('卖点 43');
  });

  it('clones the image recognition display summary independently', () => {
    const original = {
      ...state('COMPLETED'),
      imageRecognitionSummary: {
        processedImageCount: 3,
        candidateSuggestionCount: 12,
        retainedSuggestionCount: 0,
      },
    };
    const cloned = cloneExtractionProductState(original);
    cloned.imageRecognitionSummary!.candidateSuggestionCount = 9;
    expect(original.imageRecognitionSummary.candidateSuggestionCount).toBe(12);
  });
});
