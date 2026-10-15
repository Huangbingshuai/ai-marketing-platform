import { describe, expect, it, vi } from 'vitest';
import { PreparedVideoHandoff } from './effect-template-mix-native-handoff';

const deferred = () => {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

describe('prepared native video handoff', () => {
  it('plays a ready clip directly once, without restarting audio or transport', async () => {
    const work = deferred();
    const video = { paused: true, play: vi.fn(() => work.promise), pause: vi.fn() };
    const failed = vi.fn();
    const handoff = new PreparedVideoHandoff();
    handoff.start(video, () => true, failed);
    handoff.start(video, () => true, failed);
    expect(video.play).toHaveBeenCalledTimes(1);
    work.resolve();
    await work.promise;
    expect(failed).not.toHaveBeenCalled();
    expect(video.pause).not.toHaveBeenCalled();
  });
  it('does not replay an already running clip', () => {
    const video = { paused: false, play: vi.fn(), pause: vi.fn() };
    new PreparedVideoHandoff().start(video, () => true, vi.fn());
    expect(video.play).not.toHaveBeenCalled();
  });
  it('detects genuinely pending startup rather than treating every pause as buffering', () => {
    let time = 0;
    const video = { paused: true, play: () => new Promise<void>(() => {}), pause: vi.fn() };
    const handoff = new PreparedVideoHandoff(() => time);
    expect(handoff.stalled(video)).toBe(false);
    handoff.start(video, () => true, vi.fn());
    time = 349;
    expect(handoff.stalled(video)).toBe(false);
    time = 350;
    expect(handoff.stalled(video)).toBe(true);
    handoff.cancel();
    expect(handoff.stalled(video)).toBe(false);
  });
  it('pauses a late play completion after cancellation or switching away', async () => {
    const work = deferred();
    let current = true;
    const video = { paused: true, play: () => work.promise, pause: vi.fn() };
    const handoff = new PreparedVideoHandoff();
    handoff.start(video, () => current, vi.fn());
    current = false;
    handoff.cancel();
    work.resolve();
    await work.promise;
    expect(video.pause).toHaveBeenCalledOnce();
  });
  it('does not let an old completion pause a newer attempt using the same element', async () => {
    const old = deferred();
    const next = deferred();
    const video = {
      paused: true,
      play: vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise),
      pause: vi.fn(),
    };
    const handoff = new PreparedVideoHandoff();
    let oldCurrent = true;
    handoff.start(video, () => oldCurrent, vi.fn());
    oldCurrent = false;
    handoff.cancel();
    handoff.start(video, () => true, vi.fn());
    old.resolve();
    await old.promise;
    expect(video.pause).not.toHaveBeenCalled();
    next.resolve();
    await next.promise;
    expect(video.pause).not.toHaveBeenCalled();
  });
  it('reports play rejection only within the active scope', async () => {
    const work = deferred();
    const failed = vi.fn();
    const video = { paused: true, play: () => work.promise, pause: vi.fn() };
    new PreparedVideoHandoff().start(video, () => true, failed);
    work.reject(new Error('decode failed'));
    await work.promise.catch(() => {});
    expect(failed).toHaveBeenCalledOnce();
  });
});
