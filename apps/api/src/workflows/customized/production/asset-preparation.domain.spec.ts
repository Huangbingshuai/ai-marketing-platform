import { it, expect } from 'vitest';
import {
  recordAssetEdits,
  mergePreparedAssets,
  validatePreparedAssets,
} from './asset-preparation.domain';
import type { ProductionAsset, ProductionInput } from '@ai-marketing/contracts';
const old: ProductionAsset = {
  id: 'cup',
  kind: 'PRODUCT',
  name: '杯子',
  description: '人工外观',
  knownFacts: '陶瓷',
  designNotes: '',
  sourceText: '信息卡',
  image: { assetId: 'file', version: 2 },
  manualFields: ['description'],
};
const next: ProductionAsset = {
  ...old,
  description: '模型外观',
  preparation: {
    aliases: [],
    usage: '产品出场',
    treatment: 'INDEPENDENT',
    parentId: null,
    sources: [{ source: 'BRIEF', path: '/material', quote: '陶瓷', field: 'knownFacts' }],
    details: [{ key: 'material', value: '陶瓷' }],
    questions: [],
    images: [],
  },
};
it('preserves exact file references, human fields and unmatched objects without mutating input', () => {
  const extra = { ...old, id: 'extra' };
  const merged = mergePreparedAssets([old, extra], [{ ...next, image: null }]);
  expect(merged[0]!.description).toBe('人工外观');
  expect(merged[0]!.image).toEqual(old.image);
  expect(merged[1]).toEqual(extra);
  expect(next.description).toBe('模型外观');
});
it('tracks only actual edits and does not create metadata on unchanged historical saves', () => {
  const { manualFields, ...legacy } = old;
  expect(recordAssetEdits([legacy], [legacy])).toEqual([legacy]);
  const result = recordAssetEdits([old], [{ ...old, designNotes: '用户指定', manualFields: [] }]);
  expect(result[0]!.manualFields).toEqual(['description', 'designNotes']);
});
it('checks evidence, object scope and protected values at completion', () => {
  const input = {
    brief: { material: '陶瓷' },
    script: {},
    document: { assets: [old], shots: [] },
    targetAssetId: 'cup',
    identitySeed: 'seed',
  } as unknown as ProductionInput;
  const asset = { ...next, description: old.description };
  expect(validatePreparedAssets({ assets: [asset], shots: [] }, input)).toBeNull();
  expect(validatePreparedAssets({ assets: [next], shots: [] }, input)).toContain('人工修改');
  expect(
    validatePreparedAssets({ assets: [{ ...asset, id: 'foreign' }], shots: [] }, input),
  ).toContain('单项');
  const invalid = structuredClone(asset);
  invalid.preparation!.sources[0]!.quote = '没有提供的认证';
  expect(validatePreparedAssets({ assets: [invalid], shots: [] }, input)).toContain('原文');
});
