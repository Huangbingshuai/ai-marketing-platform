import { describe, expect, it } from 'vitest';
import { EFFECT_VIDEO_TRANSFORM_DEFAULT as base } from '@ai-marketing/contracts';
import {
  scaleVideoTransform,
  videoTransformGuides,
  videoWheelDelta,
  videoPositionOverview,
} from './effect-video-transform-gesture';

const bounds = { width: 800, height: 600 };
describe('video scale alignment and trackpad geometry', () => {
  it('shows centres and all canvas borders at exact fit', () => {
    expect(videoTransformGuides(base, 4 / 3, 4 / 3, bounds)).toEqual({
      x: [0.5, 0, 1],
      y: [0.5, 1, 0],
    });
  });
  it('shows centre lines during proportional scaling, not only movement', () => {
    expect(
      videoTransformGuides({ ...base, scaleX: 0.7, scaleY: 0.7 }, 4 / 3, 4 / 3, bounds),
    ).toEqual({ x: [0.5], y: [0.5] });
  });
  it('detects an off-centre edge with the shared six-screen-pixel tolerance', () => {
    const guides = videoTransformGuides(
      { ...base, x: 0.25, y: 0.2, scaleX: 0.5, scaleY: 0.5 },
      4 / 3,
      4 / 3,
      bounds,
    );
    expect(guides.x).toEqual([1]);
    expect(guides.y).toEqual([]);
  });
  it('snaps a proportional corner scale to a canvas border without changing its centre', () => {
    const result = scaleVideoTransform({ ...base, x: 0.1 }, 1.19, 4 / 3, 4 / 3, bounds);
    expect(result.scaleX).toBeCloseTo(1.2);
    expect(result.scaleY).toBeCloseTo(1.2);
    expect(result.x).toBe(0.1);
    expect(videoTransformGuides(result, 4 / 3, 4 / 3, bounds).x).toContain(0);
  });
  it.each([9 / 16, 4 / 3, 16 / 9, 1, 2.35])(
    'preserves proportional scaling on %s canvases',
    (aspect) => {
      const result = scaleVideoTransform(base, 0.99, aspect, aspect, bounds);
      expect(result.scaleX).toBe(1);
      expect(result.scaleY).toBe(1);
      expect(scaleVideoTransform(base, 0.95, aspect, aspect, bounds).scaleX).toBe(0.95);
    },
  );
  it('lets accumulated trackpad input leave a snap zone instead of sticking at 100%', () => {
    expect(scaleVideoTransform(base, Math.exp(-1 * 0.003), 1, 1, bounds).scaleX).toBe(1);
    expect(scaleVideoTransform(base, Math.exp(-20 * 0.003), 1, 1, bounds).scaleX).toBeLessThan(
      0.95,
    );
  });
  it('keeps existing anisotropy and rotation, clamps both axes to valid scale limits', () => {
    const transform = { ...base, scaleX: 0.5, scaleY: 2, uniform: false, rotation: 32 };
    const large = scaleVideoTransform(transform, 100, 1, 1, bounds);
    const small = scaleVideoTransform(transform, 0.001, 1, 1, bounds);
    expect(large.scaleX).toBe(1.25);
    expect(large.scaleY).toBe(5);
    expect(small.scaleX).toBe(0.1);
    expect(small.scaleY).toBe(0.4);
    expect(large.rotation).toBe(32);
    expect(large.uniform).toBe(false);
  });
  it.each([0, -1, NaN, Infinity])('ignores invalid scaling factors %s', (factor) => {
    expect(scaleVideoTransform(base, factor, 1, 1, bounds)).toEqual(base);
  });
  it('normalises pixel, line and page wheel units and limits large deltas', () => {
    expect(videoWheelDelta(1, 0, 600)).toBe(1);
    expect(videoWheelDelta(1, 1, 600)).toBe(16);
    expect(videoWheelDelta(-1, 2, 600)).toBe(-240);
    expect(videoWheelDelta(Infinity, 0, 600)).toBe(0);
  });
  it.each([9 / 16, 4 / 3, 16 / 9, 1])(
    'keeps the overview canvas and rotated material visible for %s',
    (aspect) => {
      const result = videoPositionOverview(
        { ...base, x: 1.2, y: -0.7, scaleX: 3, scaleY: 0.4, rotation: 60 },
        4 / 3,
        aspect,
      );
      expect(result.canvas.width / result.canvas.height).toBeCloseTo(aspect);
      expect(result.canvas.x).toBeGreaterThanOrEqual(0);
      expect(result.canvas.y).toBeGreaterThanOrEqual(0);
      expect(result.canvas.x + result.canvas.width).toBeLessThanOrEqual(80);
      expect(result.canvas.y + result.canvas.height).toBeLessThanOrEqual(56);
      expect(result.material.width).toBeGreaterThan(0);
      expect(result.material.height).toBeGreaterThan(0);
    },
  );
});
