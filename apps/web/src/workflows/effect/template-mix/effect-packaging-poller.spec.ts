import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPackagingPoller } from './effect-packaging-poller';
import { computed, ref } from 'vue';
import { transpileModule } from 'typescript';
import component from './EffectTemplateMixPackaging.vue?raw';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function setup(read: (signal: AbortSignal) => Promise<string>) {
  const onData = vi.fn(),
    onError = vi.fn(),
    onLoading = vi.fn();
  const poller = createPackagingPoller({ read, onData, onError, onLoading, interval: () => 4000 });
  return { ...poller, onData, onError, onLoading };
}
afterEach(() => {
  vi.useRealTimers();
});
describe('packaging progress polling', () => {
  it('keeps progress-read failures silent while retaining results and automatically reconnecting', async () => {
    vi.useFakeTimers();
    const readUnavailable = ref(false),
      requestError = ref(''),
      previewError = ref('');
    const source = component.split('onError() {')[1]!.split('onLoading(value)')[0]!;
    const errorHandler = new Function(
      'readUnavailable',
      transpileModule(`return () => {${source.slice(0, source.lastIndexOf('},'))}}`, {}).outputText,
    );
    const onError = errorHandler(readUnavailable);
    const displayedError = new Function(
      'computed',
      'requestError',
      'previewError',
      'readUnavailable',
      `return ${component.split('const error = ')[1]!.split(';')[0]!};`,
    );
    const error = displayedError(computed, requestError, previewError, readUnavailable);
    const results = ref('last valid progress');
    const onData = vi.fn((data: string) => {
      results.value = data;
      readUnavailable.value = false;
    });
    const read = vi
      .fn()
      .mockReturnValueOnce(new Promise(() => {}))
      .mockResolvedValue('fresh progress');
    const poller = createPackagingPoller({
      read,
      onData,
      onError,
      onLoading: vi.fn(),
      interval: () => 4000,
    });
    const request = poller.refresh();
    await vi.advanceTimersByTimeAsync(15_000);
    await request;
    expect(readUnavailable.value).toBe(true);
    expect(error.value).toBe('');
    expect(results.value).toBe('last valid progress');
    expect(onData).not.toHaveBeenCalled(); // No empty result replaces the last valid projection.
    requestError.value = '创建任务失败';
    expect(error.value).toBe('创建任务失败');
    requestError.value = '';
    previewError.value = '音频无法播放';
    expect(error.value).toBe('音频无法播放');
    await vi.advanceTimersByTimeAsync(4000);
    expect(onData).toHaveBeenCalledExactlyOnceWith('fresh progress');
    expect(readUnavailable.value).toBe(false);
    expect(results.value).toBe('fresh progress');
    expect(component).not.toContain('重新读取');
    expect(component).not.toContain('暂时无法读取结果');
    poller.stop();
  });
  it('does not allow an old response to overwrite a newer read', async () => {
    vi.useFakeTimers();
    const old = deferred<string>(),
      fresh = deferred<string>();
    const read = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    const poller = setup(read);
    const first = poller.refresh(),
      second = poller.refresh();
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
    const read = vi
      .fn()
      .mockReturnValueOnce(new Promise(() => {}))
      .mockResolvedValue('reconnected');
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
    const read = vi
      .fn()
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
