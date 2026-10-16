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
  it('retries opt-in interruptions without inventing task updates and resets the backoff after success', async () => {
    vi.useFakeTimers();
    const load = vi.fn().mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce('RUNNING').mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce('COMPLETED');
    const delays = vi.fn((_error: unknown, _failures: number) => 2000), onUpdate = vi.fn();
    const result = pollAsyncTask(load, v => v === 'COMPLETED', {
      intervalMs: 1600, retryDelayMs: delays, onUpdate,
    });
    await vi.advanceTimersByTimeAsync(2000);
    expect(onUpdate.mock.calls).toEqual([['RUNNING']]);
    await vi.advanceTimersByTimeAsync(3600);
    expect(await result).toBe('COMPLETED');
    expect(delays.mock.calls.map(call => call[1])).toEqual([1, 1]);
    expect(onUpdate.mock.calls).toEqual([['RUNNING'], ['COMPLETED']]);
  });
  it('cancels a retry wait without issuing another read', async () => {
    vi.useFakeTimers();
    const controller = new AbortController(), load = vi.fn().mockRejectedValue(new TypeError('offline'));
    const query = pollAsyncTask(load, () => false, {signal:controller.signal,retryDelayMs:()=>30000});
    const rejected = expect(query).rejects.toMatchObject({name:'AbortError'});
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await rejected;
    await vi.advanceTimersByTimeAsync(30000);
    expect(load).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
