import { describe, expect, it } from 'vitest';
import type { EffectTemplateMixVariant } from './effect-template-mix';
import { packagingSlotBoundaryError } from './effect-template-mix-packaging';

const variant = (durations: number[]) => ({
  slots: durations.map((duration, index) => ({ id: String(index), duration })),
  bindings: {},
}) as unknown as EffectTemplateMixVariant;

describe('slot packaging boundaries', () => {
  it.each([3, 15])('accepts inclusive %s-second bound', (duration) => {
    expect(packagingSlotBoundaryError(variant([duration]))).toBeNull();
  });
  it.each([0, 2.999, 15.001, NaN])('rejects invalid duration %s', (duration) => {
    expect(packagingSlotBoundaryError(variant([duration]))).toContain('3–15');
  });
  it('allows gaps but never overlap, including on different lanes', () => {
    const v = variant([3, 15]);
    v.timelineStarts = { '1': 4 };
    expect(packagingSlotBoundaryError(v)).toBeNull();
    v.timelineStarts['1'] = 2;
    v.videoLanes = { '1': 1 };
    expect(packagingSlotBoundaryError(v)).toContain('边界冲突');
  });
});
