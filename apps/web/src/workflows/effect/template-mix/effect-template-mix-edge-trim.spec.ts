import { describe, expect, it } from 'vitest';
import { resizeVideoRangeAtEdge, startsAfterIndependentTrim } from './effect-template-mix-edge-trim';

describe('independent video edge trimming', () => {
  const original = { start: 12, offset: 2, duration: 8 };
  it('shrinks a middle clip from either edge, anchoring the opposite edge', () => {
    expect(resizeVideoRangeAtEdge(original, 12, 'LEFT', 2, 30))
      .toEqual({ start: 14, offset: 4, duration: 6 });
    expect(resizeVideoRangeAtEdge(original, 12, 'RIGHT', -2, 30))
      .toEqual({ start: 12, offset: 2, duration: 6 });
  });
  it('restores trimmed source at either edge without consulting other tracks', () => {
    expect(resizeVideoRangeAtEdge(original, 12, 'LEFT', -5, 30))
      .toEqual({ start: 10, offset: 0, duration: 10 });
    expect(resizeVideoRangeAtEdge(original, 12, 'RIGHT', 5, 30))
      .toEqual({ start: 12, offset: 2, duration: 10 });
  });
  it('never extends before time zero or past the source end', () => {
    expect(resizeVideoRangeAtEdge({ ...original, start: 1 }, 12, 'LEFT', -10, 30))
      .toEqual({ start: 0, offset: 1, duration: 9 });
    expect(resizeVideoRangeAtEdge({ start: 8, offset: 0, duration: 10 }, 10, 'RIGHT', 3, 30))
      .toEqual({ start: 8, offset: 0, duration: 10 });
  });
  it('allows a four-second clip to shrink and a long source to extend beyond fifteen seconds', () => {
    expect(resizeVideoRangeAtEdge({ start: 4, offset: 0, duration: 4 }, 10, 'RIGHT', -2, 30)?.duration).toBe(2);
    expect(resizeVideoRangeAtEdge(original, 30, 'RIGHT', 20, 30)?.duration).toBe(28);
  });
  it.each(['LEFT', 'RIGHT'] as const)('keeps at least one frame on %s and quantizes pointer movement', (side) => {
    const trimmed = resizeVideoRangeAtEdge(original, 12, side, side === 'LEFT' ? 99 : -99, 30)!;
    expect(trimmed.duration).toBeCloseTo(1 / 30);
    expect(resizeVideoRangeAtEdge(original, 12, side, 0.011, 30)).toEqual(original);
  });
  it('freezes every other clip position, including overlapping clips on another lane', () => {
    const ranges = [{ id: 'before', start: 0 }, { id: 'selected', start: 12 },
      { id: 'overlap', start: 15 }, { id: 'after', start: 20 }];
    expect(startsAfterIndependentTrim(ranges, 'selected', 14))
      .toEqual({ before: 0, selected: 14, overlap: 15, after: 20 });
    expect(ranges[1]?.start).toBe(12);
  });
  it.each([NaN, Infinity, 0, -1])('rejects invalid source duration %s', (duration) => {
    expect(resizeVideoRangeAtEdge(original, duration, 'RIGHT', 1, 30)).toBeNull();
  });
});
