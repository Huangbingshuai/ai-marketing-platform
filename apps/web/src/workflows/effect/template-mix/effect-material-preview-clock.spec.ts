import { describe, expect, it, vi } from 'vitest';
import { MaterialPreviewClock } from './effect-material-preview-clock';

const harness = () => {
  const frames = new Map<number, FrameRequestCallback>();
  let id = 0;
  const clock = new MaterialPreviewClock(
    (callback) => {
      frames.set(++id, callback);
      return id;
    },
    (key) => {
      frames.delete(key);
    },
  );
  const step = () => {
    const callbacks = [...frames.values()];
    frames.clear();
    callbacks.forEach((callback) => callback(0));
  };
  return { clock, frames, step };
};

describe('native material preview presentation clock', () => {
  it('publishes every display frame without waiting for timeupdate', () => {
    const { clock, step } = harness();
    const media = { currentTime: 0, paused: false, ended: false };
    const publish = vi.fn();
    clock.start(media, publish);
    for (let frame = 1; frame <= 60; frame++) {
      media.currentTime = frame / 60;
      step();
    }
    expect(publish).toHaveBeenCalledTimes(61);
    expect(publish).toHaveBeenLastCalledWith(1);
  });

  it('does not drift during buffering and follows forward/backward seeks and playback rates', () => {
    const { clock, step } = harness();
    const media = { currentTime: 3, paused: false, ended: false };
    const publish = vi.fn();
    clock.start(media, publish);
    for (let frame = 0; frame < 60; frame++) step();
    expect(publish.mock.calls.every(([time]) => time === 3)).toBe(true);
    for (const time of [8, 2, 2.1, 2.3]) {
      media.currentTime = time;
      step();
      expect(publish).toHaveBeenLastCalledWith(time);
    }
  });

  it.each(['paused', 'ended'] as const)(
    'publishes the final native time and stops on %s',
    (flag) => {
      const { clock, frames, step } = harness();
      const media = { currentTime: 0, paused: false, ended: false };
      const publish = vi.fn();
      clock.start(media, publish);
      media.currentTime = 7.25;
      media[flag] = true;
      step();
      expect(publish).toHaveBeenLastCalledWith(7.25);
      expect(frames.size).toBe(0);
    },
  );

  it('cancels on close/unmount and ignores an old callback after source switch or resume', () => {
    const { clock, frames, step } = harness();
    const publish = vi.fn();
    clock.start({ currentTime: 5, paused: false, ended: false }, publish);
    const stale = [...frames.values()][0]!;
    clock.stop();
    expect(frames.size).toBe(0);
    stale(0);
    expect(publish).toHaveBeenCalledTimes(1);
    clock.start({ currentTime: 0, paused: false, ended: false }, publish);
    stale(0);
    step();
    expect(publish).toHaveBeenLastCalledWith(0);
    expect(frames.size).toBe(1);
    clock.stop();
  });
});
