import { computed } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as ThumbnailCache from './effect-template-mix-thumbnail-cache';
import type * as WaveformCache from './effect-template-mix-waveform-cache';

const flush = async () => { for (let i = 0; i < 80; i += 1) await Promise.resolve(); };

describe('montage thumbnail source sessions', () => {
  let cache: typeof ThumbnailCache;
  let videos: FakeVideo[];
  let automatic: boolean;
  let blobs: ((blob: Blob | null) => void)[];
  let deferBlobs: boolean;
  let imageCount: number;
  class FakeVideo extends EventTarget {
    src = '';
    duration = 12;
    readyState = 2;
    videoWidth = 720;
    videoHeight = 1280;
    seeking = false;
    position = 0;
    get currentTime() { return this.position; }
    set currentTime(value: number) {
      this.position = value;
      queueMicrotask(() => this.dispatchEvent(new Event('seeked')));
    }
    load() { if (this.src && automatic) queueMicrotask(() => this.dispatchEvent(new Event('loadedmetadata'))); }
    removeAttribute() { this.src = ''; }
  }
  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    videos = []; blobs = []; automatic = true; deferBlobs = false; imageCount = 0;
    vi.stubGlobal('window', { setTimeout, clearTimeout, location: { origin: 'http://localhost' } });
    vi.stubGlobal('caches', undefined);
    vi.stubGlobal('HTMLMediaElement', { HAVE_CURRENT_DATA: 2 });
    vi.stubGlobal('document', { createElement: (tag: string) => {
      if (tag === 'video') { const video = new FakeVideo(); videos.push(video); return video; }
      return { getContext: () => ({ drawImage: vi.fn() }), toBlob: (callback: (blob: Blob | null) => void) => {
        if (deferBlobs) blobs.push(callback);
        else queueMicrotask(() => callback(new Blob(['frame'])));
      } };
    } });
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:frame-${++imageCount}`);
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    cache = await import('./effect-template-mix-thumbnail-cache');
  });
  afterEach(() => {
    cache.pauseEffectTemplateMixThumbnailCapture(true);
    vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  });
  it('extracts eight different frames with one video load and reuses cached frames', async () => {
    for (let time = 0; time < 8; time += 1) cache.retainEffectTemplateMixThumbnail('/video-a', time, 'revision-1');
    await flush();
    expect(videos).toHaveLength(1);
    expect(imageCount).toBe(8);
    for (let time = 0; time < 8; time += 1) {
      expect(cache.useEffectTemplateMixThumbnail(computed(() => '/video-a'), computed(() => time), computed(() => 'revision-1')).value).toMatch(/^blob:frame-/);
      cache.retainEffectTemplateMixThumbnail('/video-a', time, 'revision-1');
    }
    await flush();
    expect(videos).toHaveLength(1);
  });
  it('does not reuse decoded frames across versions or sources', async () => {
    for (const [source, version] of [['/a', '1'], ['/a', '2'], ['/b', '1']]) {
      cache.retainEffectTemplateMixThumbnail(source!, 1, version!);
      cache.retainEffectTemplateMixThumbnail(source!, 2, version!);
    }
    await flush();
    expect(videos).toHaveLength(3);
    expect(imageCount).toBe(6);
  });
  it('bounds source loading to three sessions even with many requested frames', async () => {
    automatic = false;
    for (let source = 0; source < 5; source += 1) {
      for (let frame = 0; frame < 8; frame += 1)
        cache.retainEffectTemplateMixThumbnail(`/source-${source}`, frame, '1');
    }
    await flush();
    expect(videos).toHaveLength(3);
    automatic = true;
    for (const video of [...videos]) video.dispatchEvent(new Event('loadedmetadata'));
    await flush();
    expect(videos).toHaveLength(5);
    expect(imageCount).toBe(40);
  });
  it('does not start released queued frames', async () => {
    cache.pauseEffectTemplateMixThumbnailCapture(true);
    cache.retainEffectTemplateMixThumbnail('/a', 1, '1');
    await flush();
    cache.releaseEffectTemplateMixThumbnail('/a', 1, '1');
    cache.pauseEffectTemplateMixThumbnailCapture(false);
    await flush();
    expect(videos).toHaveLength(0);
  });
  it('prioritizes playback and ignores late cancelled canvas results', async () => {
    deferBlobs = true;
    cache.retainEffectTemplateMixThumbnail('/a', 1, '1');
    await flush();
    expect(blobs).toHaveLength(1);
    cache.pauseEffectTemplateMixThumbnailCapture(true);
    blobs[0]!(new Blob(['cancelled']));
    expect(imageCount).toBe(0);
    deferBlobs = false;
    cache.pauseEffectTemplateMixThumbnailCapture(false);
    await flush();
    expect(imageCount).toBe(1);
    expect(videos).toHaveLength(2);
  });
  it('backs off all queued frames of a failed source and retries after the deadline', async () => {
    automatic = false;
    for (let time = 0; time < 8; time += 1) cache.retainEffectTemplateMixThumbnail('/bad', time, '1');
    await flush();
    videos[0]!.dispatchEvent(new Event('error'));
    await flush();
    expect(videos).toHaveLength(1);
    automatic = true;
    await vi.advanceTimersByTimeAsync(5_000);
    await flush();
    expect(videos).toHaveLength(2);
    expect(imageCount).toBe(8);
  });
  it('restores persisted frames without creating a decoder', async () => {
    vi.stubGlobal('caches', { open: async () => ({ match: async () => new Response(new Blob(['stored'])) }) });
    cache.retainEffectTemplateMixThumbnail('/a', 1, '1');
    await flush();
    expect(videos).toHaveLength(0);
    expect(imageCount).toBe(1);
  });
});

describe('montage waveform persistence', () => {
  let cache: typeof WaveformCache;
  let stored: Map<string, string>;
  let fetchSource: ReturnType<typeof vi.fn>;
  let decode: ReturnType<typeof vi.fn>;
  beforeEach(async () => {
    vi.resetModules(); stored = new Map();
    vi.stubGlobal('window', { location: { origin: 'http://localhost' } });
    vi.stubGlobal('caches', { open: async () => ({
      match: async (key: string) => stored.has(key) ? new Response(stored.get(key)) : undefined,
      put: async (key: string, response: Response) => { stored.set(key, await response.text()); },
      keys: async () => [],
    }) });
    fetchSource = vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) }));
    vi.stubGlobal('fetch', fetchSource);
    decode = vi.fn(async () => ({ duration: 1, length: 64, numberOfChannels: 1, getChannelData: () => new Float32Array(64).fill(0.5) }));
    vi.stubGlobal('OfflineAudioContext', class { decodeAudioData = decode; });
    cache = await import('./effect-template-mix-waveform-cache');
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  const key = (source: string) => `http://localhost/__effect-template-mix-waveform-cache?source=${encodeURIComponent(source)}`;
  it('persists real decoded samples and deduplicates concurrent requests', async () => {
    cache.requestEffectTemplateMixWaveform('/a'); cache.requestEffectTemplateMixWaveform('/a');
    await flush();
    expect(fetchSource).toHaveBeenCalledTimes(1);
    expect(decode).toHaveBeenCalledTimes(1);
    expect(cache.useEffectTemplateMixWaveform(computed(() => '/a')).value?.status).toBe('READY');
    expect(JSON.parse(stored.get(key('/a'))!).samples).toHaveLength(64);
  });
  it('restores waveform samples without downloading or decoding media', async () => {
    stored.set(key('/a'), JSON.stringify({ duration: 2, samples: [0.2, 0.7], status: 'READY' }));
    cache.requestEffectTemplateMixWaveform('/a'); await flush();
    expect(fetchSource).not.toHaveBeenCalled(); expect(decode).not.toHaveBeenCalled();
    expect(cache.useEffectTemplateMixWaveform(computed(() => '/a')).value?.samples).toEqual([0.2, 0.7]);
  });
  it('falls back to actual decode for invalid or unavailable storage', async () => {
    stored.set(key('/a'), JSON.stringify({ duration: 2, samples: [-1], status: 'READY' }));
    cache.requestEffectTemplateMixWaveform('/a'); await flush();
    expect(fetchSource).toHaveBeenCalledTimes(1);
    vi.stubGlobal('caches', { open: async () => { throw new Error('storage full'); } });
    vi.resetModules(); cache = await import('./effect-template-mix-waveform-cache');
    cache.requestEffectTemplateMixWaveform('/b'); await flush();
    expect(fetchSource).toHaveBeenCalledTimes(2);
  });
  it('does not fabricate samples or persist unavailable media', async () => {
    fetchSource.mockRejectedValue(new Error('unavailable'));
    cache.requestEffectTemplateMixWaveform('/bad'); await flush();
    expect(cache.useEffectTemplateMixWaveform(computed(() => '/bad')).value).toEqual({ duration: 0, samples: [], status: 'FAILED' });
    expect(stored.size).toBe(0);
  });
  it('defers requests while playback owns the foreground', async () => {
    cache.pauseEffectTemplateMixWaveformDecoding(true);
    cache.requestEffectTemplateMixWaveform('/a'); await flush();
    expect(fetchSource).not.toHaveBeenCalled();
    cache.pauseEffectTemplateMixWaveformDecoding(false); await flush();
    expect(fetchSource).toHaveBeenCalledTimes(1);
  });
  it('times out stalled media reads so other sources can use the decode slots', async () => {
    vi.useFakeTimers();
    fetchSource.mockImplementation(async (source: string, options: { signal: AbortSignal }) => {
      if (source === '/good') return { ok: true, arrayBuffer: async () => new ArrayBuffer(4) };
      return await new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('timeout'))));
    });
    cache.requestEffectTemplateMixWaveform('/slow-1');
    cache.requestEffectTemplateMixWaveform('/slow-2');
    cache.requestEffectTemplateMixWaveform('/good');
    await flush();
    expect(fetchSource).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(30_000);
    await flush();
    expect(cache.useEffectTemplateMixWaveform(computed(() => '/slow-1')).value?.status).toBe('FAILED');
    expect(cache.useEffectTemplateMixWaveform(computed(() => '/good')).value?.status).toBe('READY');
  });
});
