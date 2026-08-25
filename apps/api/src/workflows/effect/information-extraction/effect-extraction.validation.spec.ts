import { describe, expect, it } from 'vitest';

import {
  canonicalHash,
  extractionSourceFingerprint,
  isEffectExtractionResult,
  isSupportedExtractionMaterial,
  safeTokenEquals,
} from './effect-extraction.validation';

const validResult = {
  productCategory: '食品',
  productName: '测试产品',
  coreSpecification: '100g',
  priceRange: '10-20元',
  visualFeatures: '红色包装',
  targetAudience: '家庭用户',
  marketingGoal: '转化',
  coreSellingPoints: ['卖点一'],
  usageScenarios: '家庭',
  deliveryChannels: '抖音',
  brandTone: '可信',
  disabledElements: ['绝对化用语'],
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

  it('accepts up to twenty core selling points', () => {
    expect(
      isEffectExtractionResult({
        ...validResult,
        coreSellingPoints: Array.from({ length: 20 }, (_, index) => `卖点${index + 1}`),
      }),
    ).toBe(true);
    expect(
      isEffectExtractionResult({
        ...validResult,
        coreSellingPoints: Array.from({ length: 21 }, (_, index) => `卖点${index + 1}`),
      }),
    ).toBe(false);
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
