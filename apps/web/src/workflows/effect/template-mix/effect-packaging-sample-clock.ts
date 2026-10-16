import { packagingAudioFade } from '@ai-marketing/contracts';
import type { PackagingAudio } from '@ai-marketing/contracts';
import { readPreviewAudioFile } from './effect-preview-audio-file';

export type ScheduledPackagingClip = {
  id: string;
  kind: 'VOICE' | 'MUSIC';
  audio: PackagingAudio;
  muted: boolean;
};

/** Audio device presentation time, not the ahead-of-output rendering cursor. */
export function audioOutputSeconds(context: AudioContext, now = performance.now()): number {
  const stamp = context.getOutputTimestamp?.();
  if (
    stamp &&
    typeof stamp.contextTime === 'number' &&
    typeof stamp.performanceTime === 'number' &&
    stamp.contextTime > 0 &&
    stamp.performanceTime > 0
  ) {
    return Math.min(
      context.currentTime,
      stamp.contextTime + Math.max(0, now - stamp.performanceTime) / 1000,
    );
  }
  return Math.max(0, context.currentTime - context.baseLatency - (context.outputLatency || 0));
}

/** One decoded, sample-scheduled transport. No per-clause play promises, timers or decoder handoffs. */
export class PackagingSampleClock {
  private context: AudioContext | undefined;
  private buffers = new Map<string, Promise<AudioBuffer>>();
  private nodes: { source: AudioBufferSourceNode; gain: GainNode }[] = [];
  private version = 0;
  private anchor = 0;
  private timelineStart = 0;
  private active = false;
  private pending = false;
  private heldTime = 0;

  constructor(
    private readonly url: (id: string) => string,
    private readonly makeContext: () => AudioContext = () =>
      new AudioContext({ latencyHint: 'interactive' }),
    private readonly readFile: (url: string) => Promise<ArrayBuffer> = readPreviewAudioFile,
  ) {}

  private audioContext(): AudioContext {
    return (this.context ??= this.makeContext());
  }

  async prepare(clips: ScheduledPackagingClip[]): Promise<void> {
    if (!clips.length) return;
    const context = this.audioContext();
    const ids = new Set(clips.map((clip) => clip.audio.fileObjectId));
    for (const id of this.buffers.keys()) if (!ids.has(id)) this.buffers.delete(id);
    await Promise.all(
      [...ids].map((id) => {
        let pending = this.buffers.get(id);
        if (!pending) {
          pending = this.readFile(this.url(id)).then((bytes) => context.decodeAudioData(bytes));
          this.buffers.set(id, pending);
          void pending.catch(() => {
            if (this.buffers.get(id) === pending) this.buffers.delete(id);
          });
        }
        return pending;
      }),
    );
  }

  async start(
    clips: ScheduledPackagingClip[],
    seconds: number,
    frameReady?: Promise<boolean>,
  ): Promise<boolean> {
    this.stop();
    if (!clips.length) return false;
    const version = this.version;
    const context = this.audioContext();
    this.timelineStart = this.heldTime = seconds;
    this.pending = true;
    try {
      // Called synchronously from the play gesture, before any network/decode await.
      const [, , ready] = await Promise.all([context.resume(), this.prepare(clips), frameReady]);
      if (version !== this.version) return false;
      if (ready === false) {
        this.stop();
        return false;
      }
      if (context.state !== 'running') throw new Error('浏览器未允许音频播放，请再次点击播放');
      this.anchor = context.currentTime + 0.05;
      for (const clip of clips) {
        const audio = clip.audio;
        if (audio.start + audio.duration <= seconds) continue;
        const buffer = await this.buffers.get(audio.fileObjectId)!;
        if (version !== this.version) return false;
        const elapsed = Math.max(0, seconds - audio.start);
        const offset = (audio.offset ?? 0) + elapsed;
        const length = Math.min(audio.duration - elapsed, buffer.duration - offset);
        if (length <= 0 || !Number.isFinite(length)) throw new Error('口播截取范围超过实际音频');
        const source = context.createBufferSource();
        const gain = context.createGain();
        source.buffer = buffer;
        source.connect(gain).connect(context.destination);
        const when = this.anchor + Math.max(0, audio.start - seconds);
        const fadeIn = packagingAudioFade(audio, clip.kind, 'fadeIn');
        const fadeOut = packagingAudioFade(audio, clip.kind, 'fadeOut');
        const volume = clip.muted ? 0 : audio.volume;
        const fadeAt = (t: number) =>
          volume *
          Math.min(
            1,
            fadeIn > 0 ? t / fadeIn : 1,
            fadeOut > 0 ? (audio.duration - t) / fadeOut : 1,
          );
        gain.gain.setValueAtTime(Math.max(0, fadeAt(elapsed)), when);
        if (fadeIn > elapsed && fadeIn < elapsed + length)
          gain.gain.linearRampToValueAtTime(volume, when + fadeIn - elapsed);
        if (
          fadeOut > 0 &&
          audio.duration - fadeOut > elapsed &&
          audio.duration - fadeOut < elapsed + length
        ) {
          gain.gain.setValueAtTime(volume, when + audio.duration - fadeOut - elapsed);
        }
        gain.gain.linearRampToValueAtTime(Math.max(0, fadeAt(elapsed + length)), when + length);
        // Each clip owns its gain; narration must never automate another track's volume.
        this.nodes.push({ source, gain });
        source.start(when, offset, length);
      }
      this.pending = false;
      this.active = true;
      return true;
    } catch (error) {
      if (version !== this.version) return false;
      this.stop();
      throw error;
    }
  }

  /** Null only when this transport does not own playback; pending decode pins the timeline. */
  time(): number | null {
    if (this.pending) return this.heldTime;
    if (!this.active || !this.context) return null;
    if (this.context.state === 'running') {
      this.heldTime = Math.max(
        this.heldTime,
        this.timelineStart + audioOutputSeconds(this.context) - this.anchor,
      );
    }
    return this.heldTime;
  }

  /** Decoder buffering pauses the transport, not each independently scheduled clip. */
  async hold(): Promise<void> {
    if (!this.active || !this.context || this.pending) return;
    this.time();
    this.pending = true;
    await this.context.suspend();
  }

  async continue(frameReady: Promise<boolean>): Promise<boolean> {
    const version = this.version;
    if (!this.active || !this.context) return false;
    if (!(await frameReady) || version !== this.version) return false;
    await this.context.resume();
    if (version !== this.version) return false;
    this.pending = false;
    return true;
  }

  stop(): void {
    this.time();
    this.version++;
    this.active = this.pending = false;
    for (const { source, gain } of this.nodes) {
      try {
        source.stop();
      } catch {
        /* Already ended. */
      }
      source.disconnect();
      gain.disconnect();
    }
    this.nodes = [];
  }

  dispose(): void {
    this.stop();
    this.buffers.clear();
    if (this.context) void this.context.close();
    this.context = undefined;
  }
}
