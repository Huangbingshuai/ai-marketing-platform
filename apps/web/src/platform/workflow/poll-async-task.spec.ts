import { afterEach, describe, expect, it, vi } from 'vitest';
import { pollAsyncTask, waitForTaskPoll } from './poll-async-task';

afterEach(() => vi.useRealTimers());
describe('shared extraction task polling', () => {
  it('does not publish a response arriving after its scope is cancelled', async () => {
    const controller = new AbortController();
    let resolve!: (value: string) => void;
    const onUpdate = vi.fn();
    const query = pollAsyncTask(
      () =>
        new Promise<string>((done) => {
          resolve = done;
        }),
      () => true,
      { signal: controller.signal, onUpdate },
    );
    const rejected = expect(query).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    resolve('COMPLETED');
    await rejected;
    expect(onUpdate).not.toHaveBeenCalled();
  });
  it('stops at the server terminal state and emits only server results', async () => {
    const load = vi.fn().mockResolvedValueOnce('RUNNING').mockResolvedValueOnce('PARTIAL');
    const onUpdate = vi.fn();
    expect(
      await pollAsyncTask(load, (state) => state === 'PARTIAL', {
        intervalMs: 0,
        onUpdate,
      }),
    ).toBe('PARTIAL');
    expect(onUpdate.mock.calls).toEqual([['RUNNING'], ['PARTIAL']]);
    expect(load).toHaveBeenCalledTimes(2);
  });
  it('propagates a network interruption without inventing a failed task', async () => {
    const onUpdate = vi.fn();
    const error = new TypeError('Network unavailable');
    await expect(
      pollAsyncTask(
        () => Promise.reject(error),
        () => false,
        { onUpdate },
      ),
    ).rejects.toBe(error);
    expect(onUpdate).not.toHaveBeenCalled();
  });
  it('aborts the scheduled wait immediately', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const wait = waitForTaskPoll(10000, controller.signal);
    const rejected = expect(wait).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });
});
