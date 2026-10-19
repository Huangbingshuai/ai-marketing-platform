import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ApiClientError,
  isNetworkError,
  requestJson,
  requestRaw,
  safeApiErrorMessage,
} from './http-client';
import { readRequestGeneration } from './read-request-generation';
import { advanceAuthGeneration } from './auth-events';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('HTTP client', () => {
  it('presents validator failures in Chinese without changing the API error metadata', () => {
    const error = new ApiClientError('property workflowRunId should not exist', 400, {
      code: 'BAD_REQUEST',
      requestId: 'request-validation',
    });
    expect(safeApiErrorMessage(error, '读取失败')).toBe(
      '系统暂时无法处理当前请求，请重新加载后重试。',
    );
    expect(error).toMatchObject({
      status: 400,
      code: 'BAD_REQUEST',
      requestId: 'request-validation',
      message: 'property workflowRunId should not exist',
    });
    expect(
      safeApiErrorMessage(new ApiClientError('workflowRunId must be a UUID', 400), '读取失败'),
    ).toBe('系统暂时无法处理当前请求，请重新加载后重试。');
  });
  it('keeps actionable Chinese conflicts and uses the supplied fallback for internal failures', () => {
    expect(
      safeApiErrorMessage(new ApiClientError('内容已更新，本地修改已保留', 409), '读取失败'),
    ).toBe('内容已更新，本地修改已保留');
    expect(safeApiErrorMessage(new ApiClientError('数据库内部错误', 500), '读取失败')).toBe(
      '读取失败',
    );
    expect(safeApiErrorMessage(new TypeError('Failed to fetch'), '读取失败')).toBe('读取失败');
    expect(safeApiErrorMessage(null, '读取失败')).toBe('读取失败');
  });
  it('ignores a late unauthorized response after a new login has completed', async () => {
    const dispatchEvent = vi.fn();
    vi.stubGlobal('window', { dispatchEvent });
    let finish!: (response: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          }),
      ),
    );
    const pending = requestJson('/projects');
    advanceAuthGeneration();
    finish(new Response(JSON.stringify({ code: 'AUTH_REQUIRED' }), { status: 401 }));
    await expect(pending).rejects.toMatchObject({ status: 401 });
    expect(dispatchEvent).not.toHaveBeenCalled();
  });
  it.each(['json', 'raw'] as const)(
    'includes session cookies and notifies the UI about expired auth on %s requests',
    async (kind) => {
      const dispatchEvent = vi.fn();
      vi.stubGlobal('window', { dispatchEvent });
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ code: 'AUTH_REQUIRED', message: '登录已过期' }), {
          status: 401,
        }),
      );
      vi.stubGlobal('fetch', fetchMock);
      await expect(
        kind === 'json' ? requestJson('/projects') : requestRaw('/file'),
      ).rejects.toMatchObject({ status: 401, code: 'AUTH_REQUIRED' });
      expect(fetchMock.mock.calls[0]![1]).toMatchObject({ credentials: 'include' });
      expect(dispatchEvent).toHaveBeenCalledOnce();
      expect(dispatchEvent.mock.calls[0]![0].type).toBe('richi:auth-required');
    },
  );
  it('does not expire an existing session because of a wrong login password', async () => {
    const dispatchEvent = vi.fn();
    vi.stubGlobal('window', { dispatchEvent });
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ code: 'AUTH_INVALID_CREDENTIALS' }), { status: 401 }),
        ),
    );
    await expect(requestJson('/auth/login', { method: 'POST' })).rejects.toMatchObject({
      status: 401,
    });
    expect(dispatchEvent).not.toHaveBeenCalled();
  });
  it.each(['json', 'raw'] as const)(
    'invalidates prefetches around an actual %s write',
    async (kind) => {
      let finish!: (response: Response) => void;
      vi.stubGlobal(
        'fetch',
        vi.fn(
          () =>
            new Promise<Response>((resolve) => {
              finish = resolve;
            }),
        ),
      );
      const before = readRequestGeneration();
      const write =
        kind === 'json'
          ? requestJson('/projects/p1/draft', { method: 'PATCH', body: {} })
          : requestRaw('/projects/p1/file', { method: 'POST', body: new FormData() });
      expect(readRequestGeneration()).toBe(-1);
      finish(new Response('{}'));
      await write;
      expect(readRequestGeneration()).toBeGreaterThan(before);
    },
  );
  it('recovers a GET after a short 502/503/504 window', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('proxy error', { status: 502 }))
      .mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
      .mockResolvedValueOnce(new Response('gateway timeout', { status: 504 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { revision: 9 } })));
    vi.stubGlobal('fetch', fetchMock);
    const result = requestJson('/projects/p1/workflows/effect/prompt-generation');
    await vi.runAllTimersAsync();
    expect(await result).toEqual({ data: { revision: 9 } });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('recovers a disconnected GET without changing the request scope or headers', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: {} })));
    vi.stubGlobal('fetch', fetchMock);
    const signal = new AbortController().signal;
    const result = requestJson('/projects/p1/workflows/effect/prompt-generation?workflowRunId=r1', {
      signal,
      headers: { 'X-Scope': 'r1' },
    });
    await vi.runAllTimersAsync();
    await result;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]).toEqual(fetchMock.mock.calls[0]);
  });

  it('stops retries as soon as navigation aborts the previous request', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue(new Response('proxy error', { status: 502 }));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    const result = requestJson('/projects/p1/workflows/effect/prompt-generation', {
      signal: controller.signal,
    });
    const rejection = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await rejection;
    await vi.runAllTimersAsync();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds persistent service errors and preserves the final error metadata', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            message: '服务暂不可用',
            code: 'UNAVAILABLE',
            requestId: 'last-request',
          }),
          { status: 503 },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const result = requestJson('/projects/p1/workflows/effect/prompt-generation');
    const rejection = expect(result).rejects.toMatchObject({
      status: 503,
      code: 'UNAVAILABLE',
      requestId: 'last-request',
      message: '服务暂不可用',
    });
    await vi.runAllTimersAsync();
    await rejection;
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'] as const)(
    'never replays a %s write after 502',
    async (method) => {
      const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 502 }));
      vi.stubGlobal('fetch', fetchMock);
      await expect(requestJson('/projects/p1/actions', { method })).rejects.toMatchObject({
        status: 502,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it.each([401, 403, 404, 409, 422, 500])('does not retry HTTP %s', async (status) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      requestJson('/projects/p1/workflows/effect/prompt-generation'),
    ).rejects.toMatchObject({ status });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
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

  it('distinguishes browser connection failures from API and abort errors', () => {
    expect(isNetworkError(new TypeError('Failed to fetch'))).toBe(true);
    expect(isNetworkError(new DOMException('connection lost', 'NetworkError'))).toBe(true);
    expect(isNetworkError(new ApiClientError('服务异常', 503))).toBe(false);
    expect(isNetworkError(new DOMException('aborted', 'AbortError'))).toBe(false);
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
