import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchHealth } from './health.api';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('fetchHealth', () => {
  it('returns the API response envelope', async () => {
    const payload = {
      success: true,
      data: { service: 'api', status: 'ok', timestamp: '2026-08-20T00:00:00.000Z' },
      requestId: 'request-id',
    } as const;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(payload))));

    await expect(fetchHealth()).resolves.toEqual(payload);
  });

  it('throws when the API is unavailable', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async () => new Response(null, { status: 503 }));
    vi.stubGlobal('fetch', fetch);
    const failed = expect(fetchHealth()).rejects.toThrow('HTTP 503');
    await vi.runAllTimersAsync();
    await failed;
    expect(fetch).toHaveBeenCalledTimes(5);
  });
});
