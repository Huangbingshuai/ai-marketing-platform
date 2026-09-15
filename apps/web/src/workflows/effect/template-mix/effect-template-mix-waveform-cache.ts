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
const queuedSources = new Set<string>();
const runningSources = new Set<string>();

const finishJob = (source: string): void => {
  runningSources.delete(source);
  drainQueue();
};

const decodeWaveform = async (source: string): Promise<void> => {
  runningSources.add(source);
  waveformCache.set(source, { duration: 0, samples: [], status: 'LOADING' });
  try {
    const response = await fetch(source, { credentials: 'include' });
    if (!response.ok) throw new Error(`视频读取失败：${response.status}`);
    const encoded = await response.arrayBuffer();
    const audioContext = new OfflineAudioContext(1, 1, 44_100);
    const audio = await audioContext.decodeAudioData(encoded.slice(0));
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
    waveformCache.set(source, {
      duration: audio.duration,
      samples: normalized,
      status: 'READY',
    });
  } catch {
    waveformCache.set(source, { duration: 0, samples: [], status: 'FAILED' });
  } finally {
    finishJob(source);
  }
};

function drainQueue(): void {
  while (runningSources.size < MAX_CONCURRENT_DECODES && queue.length) {
    const job = queue.shift();
    if (!job) return;
    queuedSources.delete(job.source);
    if (waveformCache.get(job.source)?.status === 'READY') continue;
    void decodeWaveform(job.source);
  }
}

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
