import { computed, reactive, type ComputedRef } from 'vue';

export type EffectTemplateMixWaveform = {
  duration: number;
  samples: number[];
  status: 'FAILED' | 'LOADING' | 'READY';
};

type WaveformJob = { source: string };

const MAX_CONCURRENT_DECODES = 2;
const SAMPLES_PER_SECOND = 64;
const MAX_SAMPLES = 1_600;
const waveformCache = reactive(new Map<string, EffectTemplateMixWaveform>());
const queue: WaveformJob[] = [];
const pendingResults = new Map<string, EffectTemplateMixWaveform>();
const queuedSources = new Set<string>();
const runningSources = new Set<string>();
let decodingPaused = false;
let diskCache: Promise<Cache | null> | undefined;
let persistedWrites = 0;
const MAX_PERSISTENT_WAVEFORMS = 256;
const openDiskCache = (): Promise<Cache | null> => {
  diskCache ??= typeof caches === 'undefined' ? Promise.resolve(null)
    : caches.open('effect-template-mix-waveforms-v1').catch(() => null);
  return diskCache;
};
const cacheRequest = (source: string): string =>
  `${window.location.origin}/__effect-template-mix-waveform-cache?source=${encodeURIComponent(source)}`;
const restoreWaveform = async (source: string): Promise<EffectTemplateMixWaveform | null> => {
  try {
    const cache = await openDiskCache();
    const response = await cache?.match(cacheRequest(source));
    if (!response) return null;
    const value: unknown = await response.json();
    if (!value || typeof value !== 'object') return null;
    const waveform = value as EffectTemplateMixWaveform;
    if (waveform.status !== 'READY' || !Number.isFinite(waveform.duration) || waveform.duration <= 0 ||
      !Array.isArray(waveform.samples) || waveform.samples.length > MAX_SAMPLES ||
      !waveform.samples.every((sample) => typeof sample === 'number' && Number.isFinite(sample) && sample >= 0 && sample <= 1)) return null;
    return waveform;
  } catch { return null; }
};
const saveWaveform = async (source: string, waveform: EffectTemplateMixWaveform): Promise<void> => {
  try {
    const cache = await openDiskCache();
    if (!cache) return;
    await cache.put(cacheRequest(source), new Response(JSON.stringify(waveform),
      { headers: { 'Content-Type': 'application/json' } }));
    persistedWrites += 1;
    if (persistedWrites % 32 === 0) {
      const stored = await cache.keys();
      for (const request of stored.slice(0, Math.max(0, stored.length - MAX_PERSISTENT_WAVEFORMS)))
        await cache.delete(request);
    }
  } catch { /* Optional browser storage must not interrupt real waveform decoding. */ }
};

const setWaveform = (source: string, waveform: EffectTemplateMixWaveform): void => {
  if (decodingPaused) pendingResults.set(source, waveform);
  else waveformCache.set(source, waveform);
};

const finishJob = (source: string): void => {
  runningSources.delete(source);
  drainQueue();
};

const decodeWaveform = async (source: string): Promise<void> => {
  runningSources.add(source);
  setWaveform(source, { duration: 0, samples: [], status: 'LOADING' });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const restored = await restoreWaveform(source);
    if (restored) { setWaveform(source, restored); return; }
    const response = await fetch(source, { credentials: 'include', signal: controller.signal });
    if (!response.ok) throw new Error(`视频读取失败：${response.status}`);
    const encoded = await response.arrayBuffer();
    const audioContext = new OfflineAudioContext(1, 1, 44_100);
    const audio = await audioContext.decodeAudioData(encoded);
    const sampleCount = Math.max(
      1,
      Math.min(MAX_SAMPLES, Math.ceil(audio.duration * SAMPLES_PER_SECOND)),
    );
    const samples = Array.from({ length: sampleCount }, (_, index) => {
      const start = Math.floor((index / sampleCount) * audio.length);
      const end = Math.max(start + 1, Math.floor(((index + 1) / sampleCount) * audio.length));
      let peak = 0;
      for (let channelIndex = 0; channelIndex < audio.numberOfChannels; channelIndex += 1) {
        const channel = audio.getChannelData(channelIndex);
        const stride = Math.max(1, Math.floor((end - start) / 32));
        for (let cursor = start; cursor < end; cursor += stride)
          peak = Math.max(peak, Math.abs(channel[cursor] ?? 0));
      }
      return peak;
    });
    const sorted = samples.filter((sample) => sample > 0).sort((left, right) => left - right);
    const referencePeak = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
    const normalized =
      referencePeak > 0
        ? samples.map((sample) => Math.max(0, Math.min(1, sample / referencePeak)))
        : [];
    const waveform: EffectTemplateMixWaveform = {
      duration: audio.duration,
      samples: normalized,
      status: 'READY',
    };
    setWaveform(source, waveform);
    void saveWaveform(source, waveform);
  } catch {
    setWaveform(source, { duration: 0, samples: [], status: 'FAILED' });
  } finally {
    clearTimeout(timeout);
    finishJob(source);
  }
};

function drainQueue(): void {
  if (decodingPaused) return;
  while (runningSources.size < MAX_CONCURRENT_DECODES && queue.length) {
    const job = queue.shift();
    if (!job) return;
    queuedSources.delete(job.source);
    if (waveformCache.get(job.source)?.status === 'READY') continue;
    void decodeWaveform(job.source);
  }
}

/** Defer background waveform work and cache notifications while foreground video is playing. */
export const pauseEffectTemplateMixWaveformDecoding = (paused: boolean): void => {
  if (decodingPaused === paused) return;
  decodingPaused = paused;
  if (!paused) {
    for (const [source, waveform] of pendingResults) waveformCache.set(source, waveform);
    pendingResults.clear();
    drainQueue();
  }
};

export const requestEffectTemplateMixWaveform = (source: string): void => {
  if (
    !source ||
    queuedSources.has(source) ||
    runningSources.has(source) ||
    waveformCache.has(source)
  )
    return;
  queuedSources.add(source);
  queue.push({ source });
  drainQueue();
};

export const useEffectTemplateMixWaveform = (
  source: ComputedRef<string>,
): ComputedRef<EffectTemplateMixWaveform | null> =>
  computed(() => waveformCache.get(source.value) ?? null);
