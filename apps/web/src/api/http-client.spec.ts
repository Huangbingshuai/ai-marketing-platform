import { afterEach, describe, expect, it, vi } from 'vitest';

import { requestJson } from './http-client';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('HTTP client', () => {
  it('preserves API status, code and request id', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            success: false,
            data: null,
            message: '资产不存在',
            code: 'ASSET_NOT_FOUND',
            requestId: 'request-42',
          }),
          { status: 404 },
        ),
      ),
    );

    const promise = requestJson('/projects/p1/assets/a1', { operation: '加载资产' });
    await expect(promise).rejects.toMatchObject({
      status: 404,
      code: 'ASSET_NOT_FOUND',
      requestId: 'request-42',
      message: '资产不存在',
    });
  });

  it('forwards AbortSignal and does not set multipart Content-Type', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ success: true, data: {} })));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    const form = new FormData();
    form.set('name', '测试资产');

    await requestJson('/projects/p1/assets', {
      method: 'POST',
      body: form,
      signal: controller.signal,
    });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.signal).toBe(controller.signal);
    expect(init.body).toBe(form);
    expect(new Headers(init.headers).has('Content-Type')).toBe(false);
  });

  it('keeps native abort errors intact', async () => {
    const abortError = new DOMException('aborted', 'AbortError');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abortError));
    await expect(requestJson('/projects')).rejects.toBe(abortError);
  });

  it('supports PUT, DELETE and custom headers with JSON bodies', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(
        async () => new Response(JSON.stringify({ success: true, data: { revision: 3 } })),
      );
    vi.stubGlobal('fetch', fetchMock);

    await requestJson('/projects/p1/workflows/effect/source-import/drafts/SINGLE', {
      method: 'PUT',
      body: { expectedRevision: 2 },
      headers: { 'If-Match': '2' },
    });
    await requestJson('/projects/p1/workflows/effect/source-import/drafts/SINGLE/products/a1', {
      method: 'DELETE',
      body: { expectedRevision: 3 },
      headers: { 'If-Match': '3' },
    });

    const put = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const remove = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(put.method).toBe('PUT');
    expect(new Headers(put.headers).get('If-Match')).toBe('2');
    expect(new Headers(put.headers).get('Content-Type')).toBe('application/json');
    expect(remove.method).toBe('DELETE');
    expect(remove.body).toBe(JSON.stringify({ expectedRevision: 3 }));
  });
});
