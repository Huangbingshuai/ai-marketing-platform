import type { EffectImportMaterial } from '@ai-marketing/contracts';
import { effectScope, ref } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useEffectImportImagePreview } from './effect-import-image-preview';

const image = (): EffectImportMaterial => ({
  id: 'image-1',
  projectId: 'project-1',
  productId: 'product-1',
  type: 'PRODUCT_IMAGE',
  status: 'READY',
  expectedFileName: null,
  originalFileName: '主图.jpg',
  mimeType: 'image/jpeg',
  sizeBytes: 123,
  contentUrl: '/api/project-1/image-1/content',
  failureDisposition: null,
  errorCode: null,
  errorMessage: null,
  retryCount: 0,
  createdAt: '2026-10-08T00:00:00Z',
  updatedAt: '2026-10-08T00:00:00Z',
});
const setup = () => {
  const scope = effectScope();
  const material = ref(image());
  const preview = scope.run(() => useEffectImportImagePreview(() => material.value))!;
  return { scope, material, preview };
};

afterEach(() => vi.useRealTimers());

describe('import image preview recovery', () => {
  it('uses the same first request URL when remounted with unchanged file version', () => {
    const first = setup();
    const url = first.preview.source.value;
    first.scope.stop();
    const second = setup();
    expect(second.preview.source.value).toBe(url);
    second.scope.stop();
  });
  it('recovers from transient errors using bounded backoff without modifying the material', () => {
    vi.useFakeTimers();
    const { scope, material, preview } = setup();
    const snapshot = JSON.stringify(material.value);
    const firstSource = preview.source.value;
    preview.failed(preview.requestKey.value);
    preview.failed(preview.requestKey.value);
    expect(vi.getTimerCount()).toBe(1);
    expect(preview.state.value).toBe('retrying');
    vi.advanceTimersByTime(500);
    expect(preview.state.value).toBe('loading');
    expect(preview.source.value).not.toBe(firstSource);
    preview.loaded(preview.requestKey.value);
    expect(preview.state.value).toBe('ready');
    expect(JSON.stringify(material.value)).toBe(snapshot);
    scope.stop();
  });

  it('stops automatic retries and allows a fresh manual retry', () => {
    vi.useFakeTimers();
    const { scope, preview } = setup();
    for (const delay of [500, 1500, 3000]) {
      preview.failed(preview.requestKey.value);
      vi.advanceTimersByTime(delay);
    }
    preview.failed(preview.requestKey.value);
    expect(preview.state.value).toBe('failed');
    expect(vi.getTimerCount()).toBe(0);
    const exhaustedKey = preview.requestKey.value;
    preview.retry();
    expect(preview.state.value).toBe('loading');
    expect(preview.requestKey.value).not.toBe(exhaustedKey);
    preview.loaded(exhaustedKey);
    expect(preview.state.value).toBe('loading');
    preview.loaded(preview.requestKey.value);
    expect(preview.state.value).toBe('ready');
    scope.stop();
  });

  it('invalidates errors and old callbacks when the same material is replaced', () => {
    vi.useFakeTimers();
    const { scope, material, preview } = setup();
    const oldKey = preview.requestKey.value;
    const oldUrl = preview.source.value;
    preview.failed(oldKey);
    material.value = { ...material.value, updatedAt: '2026-10-08T01:00:00Z' };
    expect(vi.getTimerCount()).toBe(0);
    expect(preview.source.value).not.toBe(oldUrl);
    preview.failed(oldKey);
    preview.loaded(oldKey);
    expect(preview.state.value).toBe('loading');
    preview.loaded(preview.requestKey.value);
    expect(preview.state.value).toBe('ready');
    scope.stop();
  });

  it('resets on project/product/URL changes but not identical polling snapshots', () => {
    const { scope, material, preview } = setup();
    preview.loaded(preview.requestKey.value);
    const key = preview.requestKey.value;
    material.value = { ...material.value };
    expect(preview.requestKey.value).toBe(key);
    expect(preview.state.value).toBe('ready');
    material.value = {
      ...material.value,
      projectId: 'project-2',
      productId: 'product-2',
      contentUrl: '/api/project-2/image-1/content?mode=SINGLE#image',
    };
    expect(preview.state.value).toBe('loading');
    expect(preview.source.value).toContain('?mode=SINGLE&preview=');
    expect(preview.source.value).toMatch(/#image$/);
    scope.stop();
  });

  it('does not request missing, uploading, document or unsupported PSD previews', () => {
    const { scope, material, preview } = setup();
    for (const change of [
      { contentUrl: null },
      { status: 'UPLOADING' as const },
      { type: 'PRODUCT_DOCUMENT' as const },
      { originalFileName: '主图.psd' },
    ]) {
      material.value = { ...image(), ...change };
      expect(preview.source.value).toBeNull();
    }
    scope.stop();
  });

  it('cancels pending work on unmount', () => {
    vi.useFakeTimers();
    const { scope, preview } = setup();
    preview.failed(preview.requestKey.value);
    scope.stop();
    expect(vi.getTimerCount()).toBe(0);
    vi.runAllTimers();
    expect(preview.state.value).toBe('retrying');
  });
});
