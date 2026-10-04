import { describe, expect, it } from 'vitest';
import {
  effectTemplateMixSlotDurationLimit,
  effectTemplateMixSlotDurationValid,
} from './effect-template-mix';

describe('template slot duration from frozen render requests', () => {
  it.each([4, 8, 10, 15])(
    'uses the current pool request duration %s as the inclusive maximum',
    (duration) => {
      const maximum = effectTemplateMixSlotDurationLimit([{ duration, available: true }]);
      expect(maximum).toBe(duration);
      expect(effectTemplateMixSlotDurationValid(4, maximum)).toBe(true);
      expect(effectTemplateMixSlotDurationValid(duration, maximum)).toBe(true);
      expect(effectTemplateMixSlotDurationValid(duration + 0.1, maximum)).toBe(false);
      expect(effectTemplateMixSlotDurationValid(3.9, maximum)).toBe(false);
    },
  );
  it('ignores stale and malformed clips and does not invent a maximum for an empty pool', () => {
    expect(
      effectTemplateMixSlotDurationLimit([
        { duration: 8, available: true },
        { duration: 15, available: false },
        { duration: NaN, available: true },
        { duration: Infinity, available: true },
      ]),
    ).toBe(8);
    expect(effectTemplateMixSlotDurationLimit([])).toBeNull();
    expect(effectTemplateMixSlotDurationValid(4, null)).toBe(false);
  });
  it('supports fractional and mixed request durations without a floating-point false alarm', () => {
    const maximum = effectTemplateMixSlotDurationLimit([
      { duration: 6, available: true },
      { duration: 8.2, available: true },
    ]);
    expect(maximum).toBe(8.2);
    expect(effectTemplateMixSlotDurationValid(8.20000000001, maximum)).toBe(true);
    expect(effectTemplateMixSlotDurationValid(NaN, maximum)).toBe(false);
  });
});
