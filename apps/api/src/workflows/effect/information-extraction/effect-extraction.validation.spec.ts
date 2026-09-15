import { describe, expect, it } from 'vitest';
import {
  applyEffectExtractionManualOverrides,
  canonicalHash,
  extractionSourceFingerprint,
  isEffectExtractionResult,
  isSupportedExtractionMaterial,
  manualOverridesForResult,
  manualOverridesForRerun,
  normalizeEditableEffectExtractionResult,
  normalizeEffectExtractionResult,
  safeTokenEquals,
} from './effect-extraction.validation';

const validResult = {
  productCategory: '食品',
  productName: '测试产品',
  coreSpecification: '100g',
  priceRange: '10-20元',
  visualFeatures: '红色包装',
  sellingPoints: ['卖点一', '卖点二'],
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

  it('fingerprints only authoritative artifact input', () => {
    const dependencySnapshot = {
      sourcePackageRevision: 3,
      effectiveVideoConfigRevision: 2,
      executionInputHash: 'sha256:business-input',
    };
    expect(
      extractionSourceFingerprint({ sourceRevision: 8, dependencySnapshot, randomKey: 'a' }),
    ).toBe(extractionSourceFingerprint({ sourceRevision: 99, dependencySnapshot, randomKey: 'b' }));
  });

  it('accepts only the current six-field information card', () => {
    expect(isEffectExtractionResult(validResult)).toBe(true);
    expect(isEffectExtractionResult({ ...validResult, unexpected: true })).toBe(false);
    expect(isEffectExtractionResult({ ...validResult, sellingPoints: '卖点' })).toBe(false);
    expect(isEffectExtractionResult({ ...validResult, sellingPoints: [] })).toBe(false);
    expect(isEffectExtractionResult({ ...validResult, sellingPoints: [''] })).toBe(false);
    expect(
      isEffectExtractionResult({ ...validResult, sellingPoints: ['相同卖点', '相同卖点'] }),
    ).toBe(false);
    expect(isEffectExtractionResult({ ...validResult, productName: '字'.repeat(501) })).toBe(false);
    expect(isEffectExtractionResult({ ...validResult, sellingPoints: ['字'.repeat(1001)] })).toBe(
      false,
    );
    expect(
      isEffectExtractionResult({
        ...validResult,
        sellingPoints: Array.from({ length: 41 }, (_, index) => `卖点${index + 1}`),
      }),
    ).toBe(true);
  });

  it('folds historical business fields into one stable selling-point list', () => {
    const normalized = normalizeEffectExtractionResult({
      ...validResult,
      sellingPoints: undefined,
      coreSellingPoints: ['口味清爽', '口味清爽'],
      secondarySellingPoints: ['便于携带'],
      trustBackings: ['通过公开检测'],
      targetAudiences: ['通勤用户'],
      corePainPoints: ['外出补水不便'],
      decisionDrivers: ['包装便携'],
      usageScenarios: ['通勤途中'],
      purchaseScenarios: ['日常补货'],
      emotionalScenarios: ['轻松出行'],
      marketingGoal: '提升销量',
      durationSeconds: 15,
      aspectRatio: '9:16',
    });

    expect(normalized).toEqual({
      productCategory: '食品',
      productName: '测试产品',
      coreSpecification: '100g',
      priceRange: '10-20元',
      visualFeatures: '红色包装',
      sellingPoints: [
        '口味清爽',
        '便于携带',
        '通过公开检测',
        '通勤用户',
        '外出补水不便',
        '包装便携',
        '通勤途中',
        '日常补货',
        '轻松出行',
      ],
    });
    expect(normalized.sellingPoints).not.toContain('提升销量');
  });

  it('uses the current sellingPoints field as the authority when it exists', () => {
    expect(
      normalizeEffectExtractionResult({
        ...validResult,
        sellingPoints: ['当前卖点'],
        coreSellingPoints: ['历史卖点'],
      }).sellingPoints,
    ).toEqual(['当前卖点']);
  });

  it('removes only exact duplicate selling points and preserves meaningful casing', () => {
    expect(
      normalizeEffectExtractionResult({
        ...validResult,
        sellingPoints: ['ABC', 'abc', 'ABC'],
      }).sellingPoints,
    ).toEqual(['ABC', 'abc']);
  });

  it('normalizes historical manual overrides without changing the generated card', () => {
    expect(
      applyEffectExtractionManualOverrides(validResult, {
        coreSellingPoints: ['人工卖点'],
        usageScenarios: ['人工场景'],
      }).sellingPoints,
    ).toEqual(['人工卖点', '人工场景']);
    expect(normalizeEditableEffectExtractionResult(validResult)).toEqual(validResult);
  });

  it('keeps field-level manual values including an explicit list replacement', () => {
    const draft = { ...validResult, sellingPoints: ['人工卖点'] };
    const overrides = manualOverridesForResult(validResult, draft);
    expect(overrides).toEqual({ sellingPoints: ['人工卖点'] });
    expect(applyEffectExtractionManualOverrides(validResult, overrides)).toEqual(draft);
  });

  it('keeps selling-point overrides only when rerunning the same source package', () => {
    const overrides = {
      productName: '人工产品名',
      sellingPoints: ['旧资料人工卖点'],
      coreSellingPoints: ['历史旧字段卖点'],
    };

    expect(manualOverridesForRerun(overrides, false)).toEqual(overrides);
    expect(
      manualOverridesForRerun(overrides, false, {
        ...validResult,
        sellingPoints: ['旧资料人工卖点'],
      }),
    ).toEqual({
      productName: '人工产品名',
      coreSellingPoints: ['历史旧字段卖点'],
    });
    expect(manualOverridesForRerun(overrides, true)).toEqual({
      productName: '人工产品名',
    });
  });

  it('compares worker tokens without accepting missing or different values', () => {
    expect(safeTokenEquals('worker-secret', 'worker-secret')).toBe(true);
    expect(safeTokenEquals('worker-wrong', 'worker-secret')).toBe(false);
    expect(safeTokenEquals(undefined, 'worker-secret')).toBe(false);
  });

  it('limits the extraction snapshot to images and supported product documents', () => {
    expect(isSupportedExtractionMaterial('image/png', 'front.png')).toBe(true);
    expect(isSupportedExtractionMaterial('application/pdf', 'manual')).toBe(true);
    expect(isSupportedExtractionMaterial('application/octet-stream', 'manual.docx')).toBe(true);
    expect(isSupportedExtractionMaterial('text/plain', 'product-article.txt')).toBe(true);
    expect(isSupportedExtractionMaterial('application/octet-stream', 'product-article.md')).toBe(
      true,
    );
    expect(isSupportedExtractionMaterial('video/mp4', 'reference.mp4')).toBe(false);
  });
});
