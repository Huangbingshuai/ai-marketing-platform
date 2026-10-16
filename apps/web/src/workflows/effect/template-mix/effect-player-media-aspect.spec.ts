import { describe, expect, it } from 'vitest';
import {
  effectVideoCanvasFit,
  effectVideoGeometry,
  EFFECT_VIDEO_TRANSFORM_DEFAULT,
} from '@ai-marketing/contracts';
import { playerMediaAspect, playerMediaIdentity } from './effect-player-media-aspect';

describe('physical player media aspect', () => {
  it.each([
    [496, 864],
    [864, 496],
    [640, 480],
    [480, 480],
  ])('preserves a %s × %s file on every canvas without stretching', (width, height) => {
    const aspect = playerMediaAspect(width, height)!;
    for (const canvas of [9 / 16, 16 / 9, 4 / 3, 1, 2.35]) {
      const geometry = effectVideoGeometry(aspect, canvas, EFFECT_VIDEO_TRANSFORM_DEFAULT);
      const fit = effectVideoCanvasFit(aspect, canvas);
      expect(
        ((geometry.width * fit.mediaWidth) / (geometry.height * fit.mediaHeight)) * canvas,
      ).toBeCloseTo(aspect, 12);
      expect(Math.max(geometry.width, geometry.height)).toBe(1);
    }
  });
  it('fills a codec-rounded 9:16 source without stretching its picture', () => {
    const aspect = playerMediaAspect(496, 864)!;
    const geometry = effectVideoGeometry(aspect, 9 / 16, EFFECT_VIDEO_TRANSFORM_DEFAULT);
    const fit = effectVideoCanvasFit(aspect, 9 / 16);
    expect(geometry.width).toBe(1);
    expect(geometry.height).toBe(1);
    expect(fit.mediaWidth).toBeGreaterThan(1);
    expect(fit.mediaHeight).toBe(1);
    expect(((fit.mediaWidth / fit.mediaHeight) * 9) / 16).toBeCloseTo(aspect, 12);
  });
  it('uses a portrait file even if the generation request was landscape', () => {
    const geometry = effectVideoGeometry(
      playerMediaAspect(496, 864)!,
      4 / 3,
      EFFECT_VIDEO_TRANSFORM_DEFAULT,
    );
    expect(geometry.height).toBe(1);
    expect(geometry.width).toBeCloseTo(496 / 864 / (4 / 3));
  });
  it('fits matching physical dimensions flush', () => {
    const aspect = playerMediaAspect(640, 480)!;
    expect(effectVideoGeometry(aspect, 4 / 3, EFFECT_VIDEO_TRANSFORM_DEFAULT).width).toBe(1);
    expect(effectVideoGeometry(aspect, 4 / 3, EFFECT_VIDEO_TRANSFORM_DEFAULT).height).toBe(1);
  });
  it.each([
    [0, 480],
    [640, 0],
    [-1, 480],
    [NaN, 480],
    [640, Infinity],
  ])('does not cache unavailable dimensions %s × %s', (width, height) => {
    expect(playerMediaAspect(width, height)).toBeUndefined();
  });
  it('isolates source replacements and branch/project switches', () => {
    const key = playerMediaIdentity('project:run', '/video', 'old');
    expect(playerMediaIdentity('project:run', '/video', 'new')).not.toBe(key);
    expect(playerMediaIdentity('project:other-run', '/video', 'old')).not.toBe(key);
    expect(playerMediaIdentity('project:run', '/other-video', 'old')).not.toBe(key);
  });
});
