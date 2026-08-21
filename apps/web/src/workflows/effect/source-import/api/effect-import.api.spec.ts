import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  deleteEffectImportProduct,
  listEffectImportProducts,
  previewEffectManifest,
  publishEffectImportDraft,
  updateEffectImportDraft,
} from './effect-import.api';

afterEach(() => vi.unstubAllGlobals());

const ok = (): Response =>
  new Response(JSON.stringify({ success: true, data: {} }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

describe('effect import API', () => {
  it('uses one /api prefix and encodes project search parameters', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => ok());
    vi.stubGlobal('fetch', fetchMock);

    await listEffectImportProducts('项目/1', 'BATCH', {
      keyword: 'SKU A',
      category: '食品/礼盒',
      page: 1,
      pageSize: 100,
    });

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/projects/%E9%A1%B9%E7%9B%AE%2F1/workflows/effect/source-import');
    expect(url).not.toContain('/api/api/');
    expect(url).toContain('keyword=SKU+A');
    expect(url).toContain('category=%E9%A3%9F%E5%93%81%2F%E7%A4%BC%E7%9B%92');
  });

  it('forwards revision through body and If-Match on PUT and DELETE', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => ok());
    vi.stubGlobal('fetch', fetchMock);

    await updateEffectImportDraft('p1', 'SINGLE', {
      globalConfig: {
        aspectRatio: '9:16',
        durationSeconds: 15,
        resolution: '1080P',
        frameRate: 30,
        subtitleStrategy: '跟随口播',
        voiceoverStrategy: 'AI 女声',
        bgmStrategy: '自动匹配',
        styleTone: '清爽明亮',
        deliveryChannel: '抖音',
        disabledElements: [],
      },
      expectedRevision: 7,
    });
    await deleteEffectImportProduct('p1', 'SINGLE', 'product-1', 8);

    const put = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const remove = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(put.method).toBe('PUT');
    expect(new Headers(put.headers).get('If-Match')).toBe('7');
    expect(remove.method).toBe('DELETE');
    expect(new Headers(remove.headers).get('If-Match')).toBe('8');
  });

  it('sends manifest and companion files as multipart without forcing content type', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => ok());
    vi.stubGlobal('fetch', fetchMock);
    const manifest = new File(['SKU'], 'products.csv', { type: 'text/csv' });
    const image = new File(['image'], 'hero.jpg', { type: 'image/jpeg' });

    await previewEffectManifest('p1', manifest, [image], 3, 'idem-1');

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const form = init.body as FormData;
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).has('Content-Type')).toBe(false);
    expect(form.get('manifest')).toBe(manifest);
    expect(form.getAll('files')).toEqual([image]);
    expect(form.get('expectedRevision')).toBe('3');
    expect(form.get('idempotencyKey')).toBe('idem-1');
  });

  it('sends the stable publish idempotency key with the revision', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => ok());
    vi.stubGlobal('fetch', fetchMock);

    await publishEffectImportDraft('p1', 'BATCH', {
      expectedRevision: 12,
      idempotencyKey: 'publish-retry-key',
    });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('If-Match')).toBe('12');
    expect(JSON.parse(String(init.body))).toEqual({
      expectedRevision: 12,
      idempotencyKey: 'publish-retry-key',
    });
  });
});
