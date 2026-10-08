import { afterEach, describe, expect, it, vi } from 'vitest';
import { drawImportImage, ImportImageCache } from './import-image-cache';

const image = (width = 100, height = 100, complete = true) =>
  ({ complete, naturalWidth: width, naturalHeight: height }) as HTMLImageElement;
afterEach(() => vi.useRealTimers());

describe('volatile import image reuse', () => {
  it('reuses loaded images across mounts with exact project path and file version', () => {
    const cache = new ImportImageCache();
    const loaded = image();
    cache.put('/api/projects/a/images/1', 'v1', loaded);
    expect(cache.get('/api/projects/a/images/1', 'v1')).toBe(loaded);
    expect(cache.get('/api/projects/b/images/1', 'v1')).toBeNull();
    expect(cache.get('/api/projects/a/images/1', 'v2')).toBeNull();
    expect(cache.get('/api/projects/a/images/2', 'v1')).toBeNull();
    cache.clear();
    expect(cache.get('/api/projects/a/images/1', 'v1')).toBeNull();
  });

  it('does not cache missing versions, pending, failed or oversized images', () => {
    const cache = new ImportImageCache(24, 100_000);
    for (const candidate of [image(0, 0), image(100, 100, false), image(500, 500)]) {
      cache.put('/image', 'v1', candidate);
      expect(cache.get('/image', 'v1')).toBeNull();
    }
    cache.put('/image', undefined, image());
    expect(cache.get('/image')).toBeNull();
  });

  it('expires even when repeatedly read or put by viewers', () => {
    vi.useFakeTimers();
    const cache = new ImportImageCache(24, 100_000, 1000);
    const loaded = image();
    cache.put('/image', 'v1', loaded);
    vi.advanceTimersByTime(900);
    expect(cache.get('/image', 'v1')).toBe(loaded);
    cache.put('/image', 'v1', loaded);
    vi.advanceTimersByTime(101);
    expect(cache.get('/image', 'v1')).toBeNull();
  });

  it('bounds decoded bytes and evicts least recently used images', () => {
    const cache = new ImportImageCache(2, 80_000);
    const a = image(),
      b = image(),
      c = image();
    cache.put('/a', 'v1', a);
    cache.put('/b', 'v1', b);
    cache.get('/a', 'v1');
    cache.put('/c', 'v1', c);
    expect(cache.get('/b', 'v1')).toBeNull();
    expect(cache.get('/a', 'v1')).toBe(a);
    expect(cache.get('/c', 'v1')).toBe(c);
    // Pixel budget applies even if the entry limit allows more.
    const budget = new ImportImageCache(24, 40_000);
    budget.put('/a', 'v1', a);
    budget.put('/b', 'v1', b);
    expect(budget.get('/a', 'v1')).toBeNull();
  });

  it('draws a complete image without refetch or decode, preserving its aspect ratio', () => {
    const drawImage = vi.fn();
    const canvas = { getContext: vi.fn().mockReturnValue({ drawImage }), width: 0, height: 0 };
    const loaded = image(4800, 2400);
    expect(drawImportImage(canvas as unknown as HTMLCanvasElement, loaded)).toBe(true);
    expect([canvas.width, canvas.height]).toEqual([2400, 1200]);
    expect(drawImage).toHaveBeenCalledWith(loaded, 0, 0, 2400, 1200);
    expect(drawImportImage(canvas as unknown as HTMLCanvasElement, image(0, 0))).toBe(false);
    canvas.getContext.mockReturnValue(null);
    expect(drawImportImage(canvas as unknown as HTMLCanvasElement, loaded)).toBe(false);
  });
});
