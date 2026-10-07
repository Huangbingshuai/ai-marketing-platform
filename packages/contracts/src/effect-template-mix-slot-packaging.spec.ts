import { describe, expect, it } from 'vitest';
import type { EffectTemplateMixVariant } from './effect-template-mix';
import { packagingSlotBoundaryError } from './effect-template-mix-packaging';

const variant = (durations: number[]) => ({
  slots: durations.map((duration, index) => ({ id: String(index), duration })),
  bindings: Object.fromEntries(durations.map((_, index) => [String(index), `material-${index}`])),
}) as unknown as EffectTemplateMixVariant;

describe('slot packaging boundaries', () => {
  it('does not treat a preserved deletion hole as a narrated clip to validate', () => {
    const v = variant([4, 15]);
    delete v.bindings['1'];
    v.intentionallyEmptySlotIds = ['1'];
    v.timelineStarts = { '1': 2 };
    expect(packagingSlotBoundaryError(v)).toBeNull();
  });
  it.each([4, 15])('accepts inclusive %s-second bound', (duration) => {
    expect(packagingSlotBoundaryError(variant([duration]))).toBeNull();
  });
  it.each([0, 3.999, 15.001, NaN])('rejects invalid duration %s', (duration) => {
    expect(packagingSlotBoundaryError(variant([duration]))).toContain('4–15');
  });
  it('allows gaps but never overlap, including on different lanes', () => {
    const v = variant([4, 15]);
    v.timelineStarts = { '1': 5 };
    expect(packagingSlotBoundaryError(v)).toBeNull();
    v.timelineStarts['1'] = 3;
    v.videoLanes = { '1': 1 };
    expect(packagingSlotBoundaryError(v)).toContain('边界冲突');
  });
  it('lets an overlay cover a narrated slot, because it owns no narration line', () => {
    const v = variant([4, 15]);
    v.slots[1]!.overlay = true;
    v.timelineStarts = { '1': 2 };
    expect(packagingSlotBoundaryError(v)).toBeNull();
  });
});
