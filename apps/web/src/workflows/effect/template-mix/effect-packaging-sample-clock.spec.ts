import { describe, expect, it, vi } from 'vitest';
import { audioOutputSeconds, PackagingSampleClock } from './effect-packaging-sample-clock';
import type { ScheduledPackagingClip } from './effect-packaging-sample-clock';

const clip = (id: string, start: number, kind: 'VOICE' | 'MUSIC' = 'VOICE'): ScheduledPackagingClip => ({
  id, kind, muted: false, audio: { fileObjectId: id, start, duration: 3, volume: 1 },
});
function contextFixture() {
  const nodes: { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; buffer: AudioBuffer | null }[] = [];
  const gains: ReturnType<typeof vi.fn>[] = [];
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
      const set = vi.fn(); gains.push(set);
      return { gain: { setValueAtTime: set, linearRampToValueAtTime: vi.fn() },
        connect: vi.fn((to) => to), disconnect: vi.fn() };
    },
  };
  return { context, nodes, gains };
}
describe('sample-scheduled packaged audio', () => {
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
    expect(gains[2]!.mock.calls[0]).toEqual([2, 125.05]);
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
});
