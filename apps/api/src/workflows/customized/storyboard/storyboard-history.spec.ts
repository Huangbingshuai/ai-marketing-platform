import { expect, it } from 'vitest';
import { storyboardHistoryConcept } from './storyboard.repository';

const script = { id: 'script', name: '旧方案', synopsis: '完整保留的历史概述', structure: '', productFocus: '', shots: [], assets: [] };
it('scopes every route avoidance to its type and unknown legacy formats', () => {
  const commerce = { ...script, creation: { videoType: 'ECOMMERCE', referenceDurationSeconds: 30, structureSections: [] } };
  const brand = { ...script, creation: { ...commerce.creation, videoType: 'BRAND_AD' } };
  expect(storyboardHistoryConcept('s1', commerce, 'ECOMMERCE')).toEqual([{ scriptId: 's1', name: script.name, synopsis: script.synopsis }]);
  expect(storyboardHistoryConcept('s2', brand, 'ECOMMERCE')).toEqual([]);
  expect(storyboardHistoryConcept('s3', script, 'ECOMMERCE')).toHaveLength(1);
  expect(storyboardHistoryConcept('s2', brand, 'BRAND_AD')).toHaveLength(1);
  expect(storyboardHistoryConcept('s1', commerce, 'BRAND_AD')).toEqual([]);
  expect(storyboardHistoryConcept('s2', brand, 'LOCAL_STORE')).toEqual([]);
  expect(storyboardHistoryConcept('s1', commerce, 'DRAMA')).toEqual([]);
  expect(storyboardHistoryConcept('s3', script, 'DRAMA')).toHaveLength(1);
  const drama = { ...script, creation: { ...commerce.creation, videoType: 'DRAMA' } };
  expect(storyboardHistoryConcept('s4', drama, 'DRAMA')).toHaveLength(1);
  expect(storyboardHistoryConcept('invalid', {}, 'ECOMMERCE')).toEqual([]);
});
