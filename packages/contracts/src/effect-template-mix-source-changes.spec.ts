import { describe, expect, it } from 'vitest';
import {
  effectTemplateMixSourceChanges,
  type EffectTemplateMixMaterial,
  type EffectTemplateMixVariant,
} from './effect-template-mix';

const clip = (patch: Partial<EffectTemplateMixMaterial> = {}): EffectTemplateMixMaterial => ({
  id: 'old',
  artifactId: 'old',
  artifactKey: 'render-clip:old',
  artifactRevision: 1,
  fileObjectId: 'file-old',
  contentHash: 'hash-old',
  sourcePromptId: 'prompt',
  code: 'R-001',
  name: '商品',
  duration: 10,
  purpose: 'PRODUCT_DISPLAY',
  compatiblePurposes: [],
  contentUrl: '/file',
  ratio: '9:16',
  resolution: '720p',
  available: true,
  activeSource: true,
  ...patch,
});
const variant = {
  id: 'v',
  slots: [
    { id: 'a', duration: 4 },
    { id: 'b', duration: 4 },
  ],
  bindings: { a: 'old', b: 'unrelated' },
  bindingRevisions: { a: 1, b: 1 },
} as unknown as EffectTemplateMixVariant;
const unrelated = clip({
  id: 'unrelated',
  artifactId: 'unrelated',
  artifactKey: 'render-clip:unrelated',
  fileObjectId: 'file-unrelated',
  sourcePromptId: 'other',
});
const changes = (...materials: EffectTemplateMixMaterial[]) =>
  effectTemplateMixSourceChanges(variant, [...materials, unrelated]);

describe('confirmed render source replacement', () => {
  it('leaves unchanged bindings alone and ignores unused changed materials', () => {
    expect(changes(clip(), clip({ id: 'unused', artifactRevision: 7 }))).toEqual([]);
  });
  it('identifies only the slot consuming the same artifact with a new revision', () => {
    const latest = clip({ artifactRevision: 2, fileObjectId: 'new', contentHash: 'new' });
    expect(changes(latest)).toEqual([{ slotId: 'a', material: latest }]);
  });
  it('accepts a uniquely proven replacement with a new ID, never by name', () => {
    const latest = clip({
      id: 'new',
      artifactId: 'new',
      artifactKey: 'render-clip:new',
      fileObjectId: 'new',
    });
    expect(changes(clip({ activeSource: false }), latest)).toEqual([
      { slotId: 'a', material: latest },
    ]);
    expect(
      changes(clip({ activeSource: false }), { ...latest, sourcePromptId: 'different' })[0]
        ?.blockedReason,
    ).toContain('没有可用');
  });
  it('deduplicates cloned references to the same file but blocks competing versions', () => {
    const latest = clip({ id: 'new', artifactKey: 'render-clip:new', fileObjectId: 'new' });
    expect(
      changes(clip({ activeSource: false }), latest, { ...latest, id: 'clone' })[0]?.material
        ?.fileObjectId,
    ).toBe('new');
    expect(
      changes(clip({ activeSource: false }), latest, {
        ...latest,
        id: 'other-version',
        fileObjectId: 'different',
      })[0]?.blockedReason,
    ).toContain('多个新版本');
  });
  it('retains results when old provenance is missing, deleted, or the new media is too short', () => {
    expect(changes()[0]?.blockedReason).toContain('来源无法确认');
    expect(changes(clip({ available: false }))[0]?.blockedReason).toContain('没有可用');
    expect(changes(clip({ artifactRevision: 2, duration: 3.9 }))[0]?.blockedReason).toContain(
      '时长不足',
    );
  });
  it('does not guess that a legacy binding with no revision is current', () => {
    expect(
      effectTemplateMixSourceChanges({ ...variant, bindingRevisions: {} }, [clip(), unrelated]),
    ).toHaveLength(2);
  });
});
