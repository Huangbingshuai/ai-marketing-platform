import { describe, expect, it, vi } from 'vitest';

import { isRetryableProjectLoadError, loadProjectListWithRetry } from './project-load-retry';

describe('project list startup retry', () => {
  it('retries transient startup failures and resolves without a manual refresh', async () => {
    const request = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce({ status: 502 })
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValue('ready');
    const wait = vi.fn().mockResolvedValue(undefined);

    await expect(
      loadProjectListWithRetry(request, new AbortController().signal, {
        delays: [100, 200],
        wait,
      }),
    ).resolves.toBe('ready');
    expect(request).toHaveBeenCalledTimes(3);
    expect(wait.mock.calls.map(([delay]) => delay)).toEqual([100, 200]);
  });

  it('fails immediately for deterministic client errors', async () => {
    const error = { status: 400 };
    const request = vi.fn().mockRejectedValue(error);
    const wait = vi.fn().mockResolvedValue(undefined);

    await expect(
      loadProjectListWithRetry(request, new AbortController().signal, { delays: [100], wait }),
    ).rejects.toBe(error);
    expect(request).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it('stops after the configured transient retry budget', async () => {
    const error = { status: 503 };
    const request = vi.fn().mockRejectedValue(error);
    const wait = vi.fn().mockResolvedValue(undefined);

    await expect(
      loadProjectListWithRetry(request, new AbortController().signal, {
        delays: [100, 200],
        wait,
      }),
    ).rejects.toBe(error);
    expect(request).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);
  });

  it('only treats network and temporary HTTP failures as retryable', () => {
    expect(isRetryableProjectLoadError(new TypeError('fetch failed'))).toBe(true);
    expect(isRetryableProjectLoadError({ status: 408 })).toBe(true);
    expect(isRetryableProjectLoadError({ status: 429 })).toBe(true);
    expect(isRetryableProjectLoadError({ status: 500 })).toBe(true);
    expect(isRetryableProjectLoadError({ status: 404 })).toBe(false);
  });
});
