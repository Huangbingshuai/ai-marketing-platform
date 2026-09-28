import { describe, expect, it } from 'vitest';
import { packagingVisualTimeline } from '@ai-marketing/contracts';
import type { EffectTemplateMixVariant } from '@ai-marketing/contracts';
import { packagingSourceMatches } from './effect-packaging-source';

const variant = (overrides: Record<string, unknown> = {}) =>
  ({
    id: 'variant-1',
    slots: [{ id: 'slot-1', label: '产品展示', duration: 5, transition: '硬切' }],
    bindings: { 'slot-1': 'material-1' },
    bindingRevisions: { 'slot-1': 2 },
    offsets: { 'slot-1': 1 },
    ...overrides,
  }) as unknown as EffectTemplateMixVariant;

describe('packaging source identity', () => {
  it('keeps packaging current when the user freely edits the picture arrangement', () => {
    const source = packagingVisualTimeline(variant());

    expect(
      packagingSourceMatches(
        source,
        variant({
          timelineStarts: { 'slot-1': 8 },
          videoLanes: { 'slot-1': 2 },
          slots: [{ id: 'slot-1', label: '产品展示', duration: 5, transition: '叠化' }],
        }),
      ),
    ).toBe(true);
  });

  it('keeps existing package audio editable when a separate music track is added', () => {
    const initial = variant();
    const source = packagingVisualTimeline(initial);

    expect(
      packagingSourceMatches(source, variant({
        detachedAudios: [{
          id: 'library-music',
          sourceAssetId: 'music-asset',
          fileObjectId: 'music-file',
          name: '轻快配乐.mp3',
          sourceDuration: 30,
          start: 0,
          offset: 0,
          duration: 10,
          volume: 0.5,
        }],
      })),
    ).toBe(true);
  });

  it.each([
    ['素材绑定', { bindings: { 'slot-1': 'material-2' } }],
    ['素材版本', { bindingRevisions: { 'slot-1': 3 } }],
    ['素材截取起点', { offsets: { 'slot-1': 1.5 } }],
    ['槽位时长', { slots: [{ id: 'slot-1', label: '产品展示', duration: 6, transition: '硬切' }] }],
  ])('invalidates packaging when %s changes', (_label, change) => {
    expect(packagingSourceMatches(packagingVisualTimeline(variant()), variant(change))).toBe(false);
  });
});
