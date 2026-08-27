import { describe, expect, it } from 'vitest';

import {
  canonicalHash,
  extractionSourceFingerprint,
  applyEffectExtractionManualOverrides,
  isEffectExtractionResult,
  isLegacyEffectExtractionResultWithoutResolution,
  isSupportedExtractionMaterial,
  manualOverridesForResult,
  safeTokenEquals,
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
    const { resolution: _resolution, ...legacyResult } = validResult;
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

  it('accepts at most three core selling points', () => {
    expect(
      isEffectExtractionResult({
        ...validResult,
        coreSellingPoints: Array.from({ length: 3 }, (_, index) => `卖点${index + 1}`),
      }),
    ).toBe(true);
    expect(
      isEffectExtractionResult({
        ...validResult,
        coreSellingPoints: Array.from({ length: 4 }, (_, index) => `卖点${index + 1}`),
      }),
    ).toBe(false);
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

  it('keeps field-level manual values, including explicit empty arrays', () => {
    const draft = { ...validResult, targetAudience: '人工受众', trustBackings: [] };
    const generated = { ...validResult, targetAudience: '模型受众', trustBackings: ['模型背书'] };
    const overrides = manualOverridesForResult(generated, draft);
    expect(overrides).toEqual({ targetAudience: '人工受众', trustBackings: [] });
    expect(applyEffectExtractionManualOverrides(generated, overrides)).toEqual(draft);
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
