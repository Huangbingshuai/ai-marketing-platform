import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPackagingPoller, packagingPollErrorMessage } from './effect-packaging-poller';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function setup(read: (signal: AbortSignal) => Promise<string>) {
  const onData = vi.fn(), onError = vi.fn(), onLoading = vi.fn();
  const poller = createPackagingPoller({ read, onData, onError, onLoading, interval: () => 4000 });
  return { ...poller, onData, onError, onLoading };
}
afterEach(() => { vi.useRealTimers(); });
describe('packaging progress polling', () => {
  it('does not allow an old response to overwrite a newer read', async () => {
    vi.useFakeTimers();
    const old = deferred<string>(), fresh = deferred<string>();
    const read = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    const poller = setup(read);
    const first = poller.refresh(), second = poller.refresh();
    fresh.resolve('100 completed');
    await second;
    old.resolve('55 completed');
    await first;
    expect(poller.onData.mock.calls).toEqual([['100 completed']]);
    expect(poller.onError).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
    poller.stop();
  });
  it('times out a hung read and resumes polling rather than freezing forever', async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockReturnValueOnce(new Promise(() => {})).mockResolvedValue('reconnected');
    const poller = setup(read);
    const first = poller.refresh();
    await vi.advanceTimersByTimeAsync(15_000);
    await first;
    expect(read.mock.calls[0]![0]!.aborted).toBe(true);
    expect(poller.onError.mock.calls[0]![0]!.message).toContain('超时');
    expect(poller.onData).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(4000);
    expect(poller.onData).toHaveBeenCalledWith('reconnected');
    poller.stop();
  });
  it('retries a network error and does not fabricate success', async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue('real data');
    const poller = setup(read);
    await poller.refresh();
    expect(poller.onError).toHaveBeenCalledOnce();
    expect(poller.onData).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(4000);
    expect(poller.onData).toHaveBeenCalledWith('real data');
    poller.stop();
  });
  it('backs off repeated failures and resets the delay after a successful read', async () => {
    vi.useFakeTimers();
    const read = vi.fn()
      .mockRejectedValueOnce(new TypeError('NetworkError when attempting to fetch resource.'))
      .mockRejectedValueOnce(new TypeError('NetworkError when attempting to fetch resource.'))
      .mockResolvedValueOnce('reconnected')
      .mockResolvedValueOnce('steady');
    const poller = setup(read);
    await poller.refresh();

    await vi.advanceTimersByTimeAsync(3999);
    expect(read).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(7999);
    expect(read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(3);
    expect(poller.onData).toHaveBeenCalledWith('reconnected');
    await vi.advanceTimersByTimeAsync(3999);
    expect(read).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(4);
    expect(poller.onData).toHaveBeenCalledWith('steady');
    poller.stop();
  });
  it('replaces browser network exceptions with a stable user-facing message', () => {
    expect(
      packagingPollErrorMessage(new TypeError('NetworkError when attempting to fetch resource.')),
    ).toBe('网络连接暂时中断，正在稍后重试读取包装状态；时间轴草稿不受影响。');
    expect(packagingPollErrorMessage(new Error('读取包装任务失败（HTTP 503）'))).toBe(
      '读取包装任务失败（HTTP 503）',
    );
  });
  it('clears all timers and ignores responses after unmount or scope changes', async () => {
    vi.useFakeTimers();
    const pending = deferred<string>();
    const poller = setup(() => pending.promise);
    const request = poller.refresh();
    poller.stop();
    pending.resolve('previous project');
    await request;
    expect(poller.onData).not.toHaveBeenCalled();
    expect(poller.onError).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
