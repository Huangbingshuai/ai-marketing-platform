import { describe, expect, it } from 'vitest';
import { playerPixelFloor } from './effect-player-pixel-grid';

describe('native player pixel grid', () => {
  it.each([1, 1.25, 1.5, 2, 3])(
    'fits decoded video edges to physical pixels at %s DPR',
    (ratio) => {
      for (const size of [181.125, 613.333333333, 459.9999999999, 137.015625]) {
        const fitted = playerPixelFloor(size, ratio);
        expect(fitted * ratio).toBeCloseTo(Math.round(fitted * ratio), 10);
        expect(fitted).toBeLessThanOrEqual(size + 1e-7);
        expect(size - fitted).toBeLessThan(1 / ratio + 1e-7);
        expect(playerPixelFloor(fitted, ratio)).toBe(fitted);
      }
    },
  );
});
