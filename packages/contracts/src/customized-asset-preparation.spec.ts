import { expect, it } from 'vitest';
import {
  isAssetPreparation,
  assetEvidenceValue,
  productionStages,
  isProductionDocument,
} from './customized-production';
it('keeps historical assets and task topology readable', () => {
  expect(
    isProductionDocument({
      assets: [
        {
          id: 'a',
          kind: 'PRODUCT',
          name: '杯',
          description: '',
          knownFacts: '',
          designNotes: '',
          sourceText: '',
        },
      ],
      shots: [],
    }),
  ).toBe(true);
  expect(productionStages('ASSETS').map((s) => s.id)).toContain('GENERATE');
  expect(productionStages('ASSETS', 2).map((s) => s.id)).toContain('INVENTORY');
});
it('rejects malformed metadata and resolves only literal own evidence paths', () => {
  for (const v of [null, {}, { sources: [null] }]) expect(isAssetPreparation(v)).toBe(false);
  expect(assetEvidenceValue({ product: { specs: ['陶瓷'] } }, '/product/specs/0')).toBe('陶瓷');
  expect(assetEvidenceValue({}, '/__proto__/constructor')).toBeUndefined();
  expect(assetEvidenceValue({ 'a/b': '原文' }, '/a~1b')).toBe('原文');
});
