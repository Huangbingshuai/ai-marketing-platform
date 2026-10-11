import { describe, expect, it, vi } from 'vitest';
import { audioOutputSeconds, PackagingSampleClock } from './effect-packaging-sample-clock';
import type { ScheduledPackagingClip } from './effect-packaging-sample-clock';

const clip = (id: string, start: number, kind: 'VOICE' | 'MUSIC' = 'VOICE'): ScheduledPackagingClip => ({
  id, kind, muted: false, audio: { fileObjectId: id, start, duration: 3, volume: 1 },
});
function contextFixture() {
  const nodes: { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; buffer: AudioBuffer | null }[] = [];
  const gains: ReturnType<typeof vi.fn>[] = [];
  const ramps: ReturnType<typeof vi.fn>[] = [];
  const context = {
    state: 'running', currentTime: 100, baseLatency: .02, outputLatency: .03,
    getOutputTimestamp: vi.fn(() => ({ contextTime: 99.9, performanceTime: 1000 })),
    resume: vi.fn(async () => undefined), close: vi.fn(async () => undefined),
    decodeAudioData: vi.fn(async () => ({ duration: 40 } as AudioBuffer)), destination: {},
    createBufferSource: () => {
      const node = { start: vi.fn(), stop: vi.fn(), disconnect: vi.fn(), connect: vi.fn((to) => to), buffer: null };
      nodes.push(node); return node;
    },
    createGain: () => {
      const set = vi.fn(), ramp = vi.fn(); gains.push(set); ramps.push(ramp);
      return { gain: { setValueAtTime: set, linearRampToValueAtTime: ramp },
        connect: vi.fn((to) => to), disconnect: vi.fn() };
    },
  };
  return { context, nodes, gains, ramps };
}
describe('sample-scheduled packaged audio', () => {
  it.each([0, 1.5, 3])('keeps music gain independent of overlapping narration and seeking (%s)', async (seconds) => {
    const schedule = async (withVoices: boolean) => {
      const { context, gains, ramps } = contextFixture();
      const clock = new PackagingSampleClock(id => id, () => context as unknown as AudioContext,
        async () => new ArrayBuffer(2));
      const music = clip('music', 0, 'MUSIC');
      Object.assign(music.audio, { duration: 8, volume: .6, fadeIn: 0, fadeOut: 0 });
      const voices = [clip('voice', 1), clip('caption-voice', 2), clip('moved-voice', 5)];
      await clock.start([music, ...(withVoices ? voices : [])], seconds);
      expect(gains).toHaveLength(withVoices ? 4 : 1);
      return { gain: gains[0]!.mock.calls, ramps: ramps[0]!.mock.calls };
    };
    const alone = await schedule(false);
    expect(await schedule(true)).toEqual(alone);
    expect(alone.gain).toEqual([[.6, 100.05]]);
    expect(alone.ramps).toEqual([[.6, 108.05 - seconds]]);
  });
  it('preserves per-clip fades and mute without changing other audio gains', async () => {
    const { context, gains, ramps } = contextFixture();
    const clock = new PackagingSampleClock(id => id, () => context as unknown as AudioContext,
      async () => new ArrayBuffer(2));
    const music = clip('music', 0, 'MUSIC'), muted = clip('muted-music', 0, 'MUSIC');
    Object.assign(music.audio, { duration: 8, volume: .6, fadeIn: 1, fadeOut: 2 });
    muted.muted = true;
    await clock.start([music, clip('voice', 1), muted], 0);
    expect(gains[0]!.mock.calls).toEqual([[0, 100.05], [.6, 106.05]]);
    expect(ramps[0]!.mock.calls).toEqual([[.6, 101.05], [0, 108.05]]);
    expect(gains[1]!.mock.calls[0]).toEqual([1, 101.05]);
    expect(gains[2]!.mock.calls.every(([value]) => value === 0)).toBe(true);
    expect(ramps[2]!.mock.calls.every(([value]) => value === 0)).toBe(true);
  });
  it('unlocks audio immediately but waits for the video frame before scheduling sound', async () => {
    const { context, nodes } = contextFixture();
    const clock = new PackagingSampleClock(id => id, () => context as unknown as AudioContext,
      async () => new ArrayBuffer(2));
    let release!: (ready: boolean) => void;
    const frame = new Promise<boolean>(resolve => { release = resolve; });
    const pending = clock.start([clip('voice', 0)], 0, frame);
    expect(context.resume).toHaveBeenCalledOnce();
    await Promise.resolve();
    expect(clock.time()).toBe(0);
    expect(nodes).toHaveLength(0);
    release(true);
    expect(await pending).toBe(true);
    expect(nodes).toHaveLength(1);
  });
  it('does not schedule sound after cancelled frame preparation', async () => {
    const { context, nodes } = contextFixture();
    const clock = new PackagingSampleClock(id => id, () => context as unknown as AudioContext,
      async () => new ArrayBuffer(2));
    expect(await clock.start([clip('voice', 0)], 0, Promise.resolve(false))).toBe(false);
    expect(nodes).toHaveLength(0);
    expect(clock.time()).toBeNull();
  });
  it('uses presentation timestamps instead of the rendering cursor ahead of the loudspeaker', () => {
    const { context } = contextFixture();
    expect(audioOutputSeconds(context as unknown as AudioContext, 1030)).toBeCloseTo(99.93);
    context.getOutputTimestamp.mockReturnValue({ contextTime: 0, performanceTime: 0 });
    expect(audioOutputSeconds(context as unknown as AudioContext, 1030)).toBeCloseTo(99.95);
  });
  it('schedules later clauses before their boundary and keeps trim offsets exact', async () => {
    const { context, nodes, gains } = contextFixture();
    const clock = new PackagingSampleClock((id) => id, () => context as unknown as AudioContext, async () => new ArrayBuffer(2));
    const first = clip('first', 0), later = clip('later', 26), music = clip('music', 0, 'MUSIC');
    music.audio.duration = 38; later.audio.offset = .7; later.audio.volume = 2;
    await clock.start([first, later, music], 1);
    expect(nodes.map((node) => node.start.mock.calls[0])).toEqual([
      [100.05, 1, 2], [125.05, .7, 3], [100.05, 1, 37],
    ]);
    expect(gains[1]!.mock.calls[0]).toEqual([2, 125.05]);
    clock.stop(); expect(nodes.every((node) => node.stop.mock.calls.length === 1)).toBe(true);
    expect(clock.time()).toBeNull();
  });
  it('pins time while decoding and invalidates a cancelled play', async () => {
    const { context, nodes } = contextFixture();
    let release!: (buffer: ArrayBuffer) => void;
    const clock = new PackagingSampleClock((id) => id, () => context as unknown as AudioContext,
      () => new Promise((resolve) => { release = resolve; }));
    const pending = clock.start([clip('voice', 0)], 18);
    expect(clock.time()).toBe(18);
    clock.stop(); release(new ArrayBuffer(2));
    expect(await pending).toBe(false); expect(nodes).toHaveLength(0);
  });
  it('does not move the timeline through an audio-context suspension', async () => {
    const { context } = contextFixture();
    const clock = new PackagingSampleClock((id) => id, () => context as unknown as AudioContext, async () => new ArrayBuffer(2));
    await clock.start([clip('voice', 16)], 16);
    context.getOutputTimestamp.mockReturnValue({ contextTime: 101, performanceTime: performance.now() });
    context.currentTime = 101;
    const at = clock.time(); expect(at).toBeCloseTo(16.95);
    context.state = 'suspended'; context.currentTime = 120;
    expect(clock.time()).toBe(at);
  });
  it('reports unreadable audio without starting an incomplete schedule', async () => {
    const { context, nodes } = contextFixture();
    const clock = new PackagingSampleClock((id) => id, () => context as unknown as AudioContext, async () => { throw Error('unreadable'); });
    await expect(clock.start([clip('voice', 0)], 0)).rejects.toThrow('unreadable');
    expect(nodes).toHaveLength(0); expect(clock.time()).toBeNull();
  });
  it('evicts a failed preload so replay can recover instead of reusing the rejected promise', async () => {
    const { context, nodes } = contextFixture();
    const read = vi.fn().mockRejectedValueOnce(new TypeError('network failed'))
      .mockResolvedValueOnce(new ArrayBuffer(2));
    const clock = new PackagingSampleClock(id => id, () => context as unknown as AudioContext, read);
    await expect(clock.prepare([clip('voice', 0)])).rejects.toThrow('network failed');
    expect(await clock.start([clip('voice', 0)], 0, Promise.resolve(true))).toBe(true);
    expect(read).toHaveBeenCalledTimes(2);
    expect(nodes).toHaveLength(1);
  });
});
