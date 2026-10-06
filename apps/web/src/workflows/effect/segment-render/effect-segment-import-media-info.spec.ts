import { describe, expect, it } from 'vitest';
import {
  importVideoResolution,
  importVideoAspectRatio,
  importVideoFrameRate,
  importVideoDuration,
  importVideoPreviewStyle,
} from './effect-segment-import-media-info';

describe('imported video actual display metadata', () => {
  it.each([
    [15.041667, '15'],
    [6.04, '6'],
    [15, '15'],
    [4, '4'],
    [30, '30'],
    [8.148, '8.1'],
    [13.161, '13.2'],
    [6.25, '6.3'],
    [6.5, '6.5'],
    [null, '—'],
    [undefined, '—'],
    [NaN, '—'],
    [Infinity, '—'],
    [0, '—'],
    [-1, '—'],
  ])('formats readable duration %s without changing the media duration', (duration, expected) => {
    expect(importVideoDuration(duration as number | null | undefined)).toBe(expected);
  });
  it.each([
    [720, 1280],
    [1280, 720],
    [720, 720],
    [640, 480],
  ])('fits preview to actual %sx%s aspect without a wide black container', (width, height) => {
    const style = importVideoPreviewStyle({ width, height });
    expect(Number(style.aspectRatio)).toBe(width / height);
    expect(style.width).toBe(`min(100%, ${240 * (width / height)}px, ${30 * (width / height)}dvh)`);
  });
  it('uses a safe preview placeholder until dimensions are available', () => {
    expect(Number(importVideoPreviewStyle({}).aspectRatio)).toBe(16 / 9);
  });
  it.each([
    [720, 1280, '720p', '9:16'],
    [1920, 1080, '1080p', '16:9'],
    [640, 360, '360p', '16:9'],
    [1440, 1080, '1080p', '4:3'],
    [1080, 1440, '1080p', '3:4'],
    [1080, 1080, '1080p', '1:1'],
    [2560, 1080, '1080p', '64:27'],
    [2100, 900, '900p', '21:9'],
    [720, 1281, '720p', '9:16'],
    [1000, 600, '600p', '5:3'],
  ])('formats %sx%s without borrowing mutable render settings', (width, height, p, ratio) => {
    expect(importVideoResolution({ width, height })).toBe(p);
    expect(importVideoAspectRatio({ width, height })).toBe(ratio);
  });
  it.each([
    {},
    { width: 720 },
    { width: 0, height: 1280 },
    { width: NaN, height: 1080 },
    { width: 720.5, height: 1280 },
  ])('never invents missing or invalid dimensions %j', (size) => {
    expect(importVideoResolution(size)).toBe('—');
    expect(importVideoAspectRatio(size)).toBe('—');
  });
  it.each([
    [30, '30 fps'],
    [30000 / 1001, '29.97 fps'],
    [24000 / 1001, '23.98 fps'],
    [null, '—'],
    [undefined, '—'],
    [0, '—'],
    [Infinity, '—'],
  ])('formats actual average frame rate %s', (rate, label) => {
    expect(importVideoFrameRate(rate as number | null | undefined)).toBe(label);
  });
});
