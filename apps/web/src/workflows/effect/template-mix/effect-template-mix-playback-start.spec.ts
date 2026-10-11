import { describe, expect, it, vi } from 'vitest';
import { NativePlaybackProgress, previewStartupReady, waitForNativePlayback, waitForPlaybackFrame } from './effect-template-mix-playback-start';

describe('decoded frame startup barrier', () => {
  it('requires successful audio startup only when the timeline actually has audio', () => {
    expect(previewStartupReady(true, false, true)).toBe(false);
    expect(previewStartupReady(true, undefined, true)).toBe(false);
    expect(previewStartupReady(true, true, true)).toBe(true);
    expect(previewStartupReady(true, false, false)).toBe(true);
    expect(previewStartupReady(false, true, true)).toBe(false);
  });
  it('bounds a native play promise that never settles', async () => {
    vi.useFakeTimers();
    try {
      const result = waitForNativePlayback(new Promise(() => undefined), () => true, 100);
      const assertion = expect(result).rejects.toThrow('播放启动超时');
      await vi.advanceTimersByTimeAsync(100);
      await assertion;
    } finally { vi.useRealTimers(); }
  });
  it('cancels a pending native start without waiting for the decoder', async () => {
    vi.useFakeTimers();
    try {
      let current = true;
      let release!: () => void;
      const result = waitForNativePlayback(new Promise<void>(resolve => { release = resolve; }), () => current);
      current = false;
      await vi.advanceTimersByTimeAsync(50);
      expect(await result).toBe(false);
      release();
      await Promise.resolve();
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it('detects a silent native stall once, but not normal playback or an intentional pause', () => {
    const progress = new NativePlaybackProgress();
    const video = {};
    expect(progress.stalled(video, 2, 0, true)).toBe(false);
    expect(progress.stalled(video, 2.1, 100, true)).toBe(false);
    expect(progress.stalled(video, 2.1, 449, true)).toBe(false);
    expect(progress.stalled(video, 2.1, 450, true)).toBe(true);
    expect(progress.stalled(video, 2.1, 800, true)).toBe(false);
    expect(progress.stalled(video, 2.1, 1000, false)).toBe(false);
    expect(progress.stalled(video, 2.1, 2000, false)).toBe(false);
    expect(progress.stalled({}, 0, 3000, true)).toBe(false);
  });
  it('resets stall tracking across seeks and resumed playback', () => {
    const progress = new NativePlaybackProgress();
    const video = {};
    progress.stalled(video, 5, 0, true);
    expect(progress.stalled(video, 2, 1000, true)).toBe(false);
    progress.reset();
    expect(progress.stalled(video, 2, 2000, true)).toBe(false);
  });
  it('does not release the transport before decoding is settled', async () => {
    const frames: FrameRequestCallback[] = [];
    let ready = false;
    const released = vi.fn();
    const pending = waitForPlaybackFrame(
      () => ready,
      () => true,
      (callback) => {
        frames.push(callback);
        return frames.length;
      },
      () => 0,
    ).then(released);
    await Promise.resolve();
    expect(released).not.toHaveBeenCalled();
    frames.shift()!(0);
    ready = true;
    frames.shift()!(0);
    await pending;
    expect(released).toHaveBeenCalledWith(true);
  });
  it('does not resume after pause, source change or a newer start', async () => {
    const frames: FrameRequestCallback[] = [];
    let current = true;
    const pending = waitForPlaybackFrame(
      () => false,
      () => current,
      (callback) => {
        frames.push(callback);
        return 1;
      },
      () => 0,
    );
    current = false;
    frames.shift()!(0);
    expect(await pending).toBe(false);
    expect(frames).toHaveLength(0);
  });
  it('reports a decoder timeout instead of leaving a playing clock on a frozen frame', async () => {
    const frames: FrameRequestCallback[] = [];
    let time = 0;
    const pending = waitForPlaybackFrame(
      () => false,
      () => true,
      (callback) => {
        frames.push(callback);
        return 1;
      },
      () => time,
    );
    time = 15_000;
    frames.shift()!(time);
    await expect(pending).rejects.toThrow('视频预览解码超时');
  });
});
