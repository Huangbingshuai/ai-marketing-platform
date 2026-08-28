import { describe, expect, it } from 'vitest';
import { EFFECT_EXTRACTION_MAX_EDITABLE_LIST_ITEMS } from '@ai-marketing/contracts';

import {
  canonicalHash,
  extractionSourceFingerprint,
  applyEffectExtractionManualOverrides,
  isEffectExtractionResult,
  isLegacyEffectExtractionResultWithoutResolution,
  isSupportedExtractionMaterial,
  manualOverridesForResult,
  safeTokenEquals,
  toEditableEffectExtractionResultV2,
  toEffectExtractionResultV2,
} from './effect-extraction.validation';

const validResult = {
  productCategory: '食品',
  productName: '测试产品',
  coreSpecification: '100g',
  priceRange: '10-20元',
  visualFeatures: '红色包装',
  coreSellingPoints: ['卖点一'],
  secondarySellingPoints: ['卖点二'],
  trustBackings: [],
  targetAudience: '家庭用户',
  targetAudiences: ['家庭用户'],
  corePainPoints: ['备餐麻烦'],
  decisionDrivers: ['包装便利'],
  marketingGoal: '转化',
  usageScenarios: ['家庭'],
  purchaseScenarios: ['囤货'],
  emotionalScenarios: ['家庭分享'],
  durationSeconds: 20,
  aspectRatio: '9:16',
  resolution: '1080P',
  deliveryChannels: '抖音',
  disabledElements: ['绝对化用语'],
  visualStyleBaseline: '可信',
};

describe('effect extraction validation', () => {
  it('builds a stable hash regardless of object key insertion order', () => {
    expect(canonicalHash({ b: 2, a: { d: 4, c: 3 } })).toBe(
      canonicalHash({ a: { c: 3, d: 4 }, b: 2 }),
    );
  });

  it('does not stale one product merely because an unrelated draft revision increments', () => {
    expect(extractionSourceFingerprint({ sourceRevision: 2, product: { id: 'p1' } })).toBe(
      extractionSourceFingerprint({ sourceRevision: 3, product: { id: 'p1' } }),
    );
  });

  it('fingerprints only the authoritative artifact revisions and execution input hash', () => {
    const dependencySnapshot = {
      sourcePackageRevision: 3,
      effectiveVideoConfigRevision: 2,
      executionInputHash: 'sha256:business-input',
    };
    expect(
      extractionSourceFingerprint({
        sourceRevision: 8,
        dependencySnapshot,
        randomStorageKey: '01-working/random-a',
      }),
    ).toBe(
      extractionSourceFingerprint({
        sourceRevision: 99,
        dependencySnapshot,
        randomStorageKey: '01-working/random-b',
      }),
    );
    expect(extractionSourceFingerprint({ sourceRevision: 8, dependencySnapshot })).not.toBe(
      extractionSourceFingerprint({
        sourceRevision: 8,
        dependencySnapshot: { ...dependencySnapshot, sourcePackageRevision: 4 },
      }),
    );
  });

  it('accepts exactly the standard extraction shape', () => {
    expect(isEffectExtractionResult(validResult)).toBe(true);
    expect(isEffectExtractionResult({ ...validResult, unexpected: true })).toBe(false);
    expect(isEffectExtractionResult({ ...validResult, coreSellingPoints: '卖点' })).toBe(false);
  });

  it('accepts only the legacy schema-v2 shape that is missing resolution', () => {
    const legacyResult = Object.fromEntries(
      Object.entries(validResult).filter(
        ([key]) => key !== 'resolution' && key !== 'targetAudiences',
      ),
    );
    expect(isLegacyEffectExtractionResultWithoutResolution(legacyResult)).toBe(true);
    expect(isLegacyEffectExtractionResultWithoutResolution(validResult)).toBe(false);
    expect(
      isLegacyEffectExtractionResultWithoutResolution({
        ...legacyResult,
        coreSellingPoints: [],
      }),
    ).toBe(false);
    expect(
      isLegacyEffectExtractionResultWithoutResolution({
        ...legacyResult,
        unexpected: true,
      }),
    ).toBe(false);
  });

  it('keeps AI generation limits separate from the editable draft boundary', () => {
    expect(
      isEffectExtractionResult({
        ...validResult,
        coreSellingPoints: Array.from(
          { length: EFFECT_EXTRACTION_MAX_EDITABLE_LIST_ITEMS },
          (_, index) => `卖点${index + 1}`,
        ),
      }),
    ).toBe(true);
    expect(
      isEffectExtractionResult({
        ...validResult,
        coreSellingPoints: Array.from(
          { length: EFFECT_EXTRACTION_MAX_EDITABLE_LIST_ITEMS + 1 },
          (_, index) => `卖点${index + 1}`,
        ),
      }),
    ).toBe(false);
  });

  it('preserves manually appended items when validating an editable v2 result', () => {
    const edited = {
      ...validResult,
      coreSellingPoints: ['一', '二', '三', '人工补充卖点'],
      usageScenarios: ['场景一', '场景二', '场景三', '场景四', '场景五', '人工补充场景'],
    };
    const normalized = toEditableEffectExtractionResultV2(edited, {
      durationSeconds: 20,
      aspectRatio: '9:16',
      resolution: '1080P',
      deliveryChannels: '抖音',
      disabledElements: ['绝对化用语'],
      visualStyleBaseline: '国潮新中式',
    });

    expect(normalized).toMatchObject({
      coreSellingPoints: edited.coreSellingPoints,
      usageScenarios: edited.usageScenarios,
    });
  });

  it('rejects an over-limit current draft instead of silently applying AI generation limits', () => {
    const overLimit = {
      ...validResult,
      usageScenarios: Array.from(
        { length: EFFECT_EXTRACTION_MAX_EDITABLE_LIST_ITEMS + 1 },
        (_, index) => `场景${index + 1}`,
      ),
    };
    const candidate = toEditableEffectExtractionResultV2(overLimit, {
      durationSeconds: 20,
      aspectRatio: '9:16',
      resolution: '1080P',
      deliveryChannels: '抖音',
      disabledElements: ['绝对化用语'],
      visualStyleBaseline: '国潮新中式',
    });

    expect(isEffectExtractionResult(candidate)).toBe(false);
    expect(candidate).toMatchObject({ usageScenarios: overLimit.usageScenarios });
  });

  it('adapts v1 results without dropping overflow selling points', () => {
    const adapted = toEffectExtractionResultV2(
      {
        ...validResult,
        coreSellingPoints: ['一', '二', '三', '四', '五'],
        secondarySellingPoints: undefined,
        usageScenarios: '家庭聚餐、节庆礼赠',
        brandTone: '温暖烟火气',
        visualStyleBaseline: undefined,
      },
      {
        durationSeconds: 20,
        aspectRatio: '9:16',
        resolution: '1080P',
        deliveryChannels: '抖音',
        disabledElements: ['绝对化用语'],
        visualStyleBaseline: '国潮新中式',
      },
    );
    expect(adapted.coreSellingPoints).toEqual(['一', '二', '三']);
    expect(adapted.secondarySellingPoints).toEqual(['四', '五']);
    expect(adapted.usageScenarios).toEqual(['家庭聚餐、节庆礼赠']);
    expect(adapted.visualStyleBaseline).toBe('温暖烟火气');
  });

  it('splits a legacy target audience summary into canonical audience facts', () => {
    const adapted = toEffectExtractionResultV2(
      {
        ...validResult,
        targetAudience: '25-45岁家庭厨房决策者，美食爱好者，年货送礼人群，向往粤式风味的全国消费者',
        targetAudiences: undefined,
      },
      {
        durationSeconds: 20,
        aspectRatio: '9:16',
        resolution: '1080P',
        deliveryChannels: '抖音',
        disabledElements: [],
        visualStyleBaseline: '烟火食欲感',
      },
    );

    expect(adapted.targetAudiences).toEqual([
      '25-45岁家庭厨房决策者',
      '美食爱好者',
      '年货送礼人群',
      '向往粤式风味的全国消费者',
    ]);
    expect(adapted.targetAudience).toBe(
      '25-45岁家庭厨房决策者；美食爱好者；年货送礼人群；向往粤式风味的全国消费者',
    );
    expect(adapted.targetAudiences).not.toContain('上班族');
  });

  it('keeps field-level manual values, including explicit empty arrays', () => {
    const draft = {
      ...validResult,
      targetAudience: '人工受众一；人工受众二',
      targetAudiences: ['人工受众一', '人工受众二'],
      trustBackings: [],
    };
    const generated = {
      ...validResult,
      targetAudience: '模型受众',
      targetAudiences: ['模型受众'],
      trustBackings: ['模型背书'],
    };
    const overrides = manualOverridesForResult(generated, draft);
    expect(overrides).toEqual({ targetAudiences: ['人工受众一', '人工受众二'], trustBackings: [] });
    expect(applyEffectExtractionManualOverrides(generated, overrides)).toEqual(draft);
  });

  it('migrates a historical targetAudience manual override without losing it', () => {
    const generated = {
      ...validResult,
      targetAudience: '模型受众',
      targetAudiences: ['模型受众'],
    };

    expect(
      applyEffectExtractionManualOverrides(generated, {
        targetAudience: '家庭厨房决策者、美食爱好者',
      }),
    ).toMatchObject({
      targetAudience: '家庭厨房决策者；美食爱好者',
      targetAudiences: ['家庭厨房决策者', '美食爱好者'],
    });
  });

  it('compares worker tokens without accepting missing or different values', () => {
    expect(safeTokenEquals('worker-secret', 'worker-secret')).toBe(true);
    expect(safeTokenEquals('worker-wrong', 'worker-secret')).toBe(false);
    expect(safeTokenEquals(undefined, 'worker-secret')).toBe(false);
  });

  it('limits the extraction snapshot to images, PDF and DOCX inputs', () => {
    expect(isSupportedExtractionMaterial('image/png', 'front.png')).toBe(true);
    expect(isSupportedExtractionMaterial('application/pdf', 'manual')).toBe(true);
    expect(isSupportedExtractionMaterial('application/octet-stream', 'manual.docx')).toBe(true);
    expect(isSupportedExtractionMaterial('video/mp4', 'reference.mp4')).toBe(false);
  });
});
