import { describe, expect, it } from 'vitest';
import fixture from '../fixtures/customized-asset-image-ownership.json';
import type { ProductionAsset } from './customized-production';
import {
  resolveCustomizedAssetImageSource as resolve,
  customizedAssetImageSelectionIssue as issue,
} from './customized-asset-image-source';

const assets = () => structuredClone(fixture.assets) as ProductionAsset[];
describe('Run-scoped explicit image ownership', () => {
  it('keeps ten independent objects eligible and rejects the full mixed selection', () => {
    const a = assets();
    expect(issue(a, fixture.eligibleIds)).toBeNull();
    expect(
      issue(
        a,
        a.map((v) => v.id),
      ),
    ).toContain('无需独立制图');
    for (const [id, parent] of Object.entries(fixture.detailParents)) {
      const result = resolve(a, id);
      expect(result.ok && result.source.id).toBe(parent);
      expect(issue(a, [id])).toContain('无需独立制图');
    }
  });
  it('does not infer ownership for a historical item and does not prefer an old detail image', () => {
    const a = assets();
    delete a[0]!.preparation;
    a[10]!.image = { assetId: 'old-detail-image', version: 1 };
    expect(issue(a, ['room-a'])).toBeNull();
    const result = resolve(a, 'detail-a');
    expect(result.ok && result.source.id).toBe('room-a');
    expect(issue(a, ['detail-a'])).toContain('无需独立制图');
  });
  it.each([
    'missing',
    'other-run',
    'wrong-kind',
    'cycle',
    'self',
    'duplicate',
    'invalid-independent',
  ])('rejects %s without searching outside the supplied catalog', (mode) => {
    const a = assets();
    if (mode === 'missing' || mode === 'other-run') a.splice(0, 1);
    if (mode === 'wrong-kind') a[0]!.kind = 'PROP';
    if (mode === 'cycle') {
      a[0]!.preparation = { ...a[0]!.preparation!, treatment: 'SCENE_DETAIL', parentId: 'room-b' };
      a[1]!.preparation = { ...a[1]!.preparation!, treatment: 'SCENE_DETAIL', parentId: 'room-a' };
    }
    if (mode === 'self')
      a[0]!.preparation = { ...a[0]!.preparation!, treatment: 'SCENE_DETAIL', parentId: 'room-a' };
    if (mode === 'duplicate') a.push(structuredClone(a[0]!));
    if (mode === 'invalid-independent') a[0]!.preparation!.parentId = 'room-b';
    expect(resolve(a, 'detail-a').ok).toBe(false);
    expect(issue(a, ['detail-a'])).toBeTruthy();
  });
});
