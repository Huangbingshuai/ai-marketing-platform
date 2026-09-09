import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  clearEffectWorkspacePrefetches,
  loadEffectWorkspaceSnapshot,
  prefetchEffectWorkspace,
} from './effect-workspace-prefetch';

afterEach(() => clearEffectWorkspacePrefetches());

describe('effect workspace prefetch', () => {
  it('deduplicates an in-flight prefetch and consumes it once', async () => {
    let resolveValue: ((value: string) => void) | undefined;
    const loader = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveValue = resolve;
        }),
    );

    const first = prefetchEffectWorkspace('prompt:project-1:run-1', loader);
    const second = prefetchEffectWorkspace('prompt:project-1:run-1', loader);
    const consumed = loadEffectWorkspaceSnapshot('prompt:project-1:run-1', () =>
      Promise.resolve('fresh'),
    );
    resolveValue?.('prefetched');

    await expect(first).resolves.toBe('prefetched');
    await expect(second).resolves.toBe('prefetched');
    await expect(consumed).resolves.toEqual({ data: 'prefetched', prefetched: true });
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('keeps project and workflow-run cache keys isolated', async () => {
    await prefetchEffectWorkspace('render:project-1:run-1:product-1', () =>
      Promise.resolve('run-1'),
    );

    await expect(
      loadEffectWorkspaceSnapshot('render:project-1:run-2:product-1', () =>
        Promise.resolve('run-2'),
      ),
    ).resolves.toEqual({ data: 'run-2', prefetched: false });
  });

  it('lets a consumer abort without cancelling the shared prefetch', async () => {
    let resolveValue: ((value: string) => void) | undefined;
    void prefetchEffectWorkspace(
      'info:project-1:draft-1',
      () =>
        new Promise<string>((resolve) => {
          resolveValue = resolve;
        }),
    );
    const controller = new AbortController();
    const consumed = loadEffectWorkspaceSnapshot(
      'info:project-1:draft-1',
      () => Promise.resolve('fresh'),
      controller.signal,
    );
    controller.abort();
    resolveValue?.('prefetched');

    await expect(consumed).rejects.toMatchObject({ name: 'AbortError' });
  });
});
