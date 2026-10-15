import type { EffectTemplateMixWaveform } from './effect-template-mix-waveform-cache';

/** Equal timeline-time buckets, not a stretched slice of the remaining source. */
export function waveformWindowPeaks(
  decoded: EffectTemplateMixWaveform | null,
  trimStart: number,
  duration: number,
  barCount: number,
): number[] {
  if (
    !decoded ||
    decoded.status !== 'READY' ||
    !decoded.samples.length ||
    !Number.isFinite(decoded.duration) ||
    decoded.duration <= 0 ||
    !Number.isFinite(duration) ||
    duration <= 0 ||
    !Number.isFinite(trimStart) ||
    !Number.isFinite(barCount)
  )
    return [];
  const count = Math.max(1, Math.min(1600, Math.floor(barCount)));
  const start = Math.max(0, trimStart);
  const samplesPerSecond = decoded.samples.length / decoded.duration;
  return Array.from({ length: count }, (_, index) => {
    const from = start + (index * duration) / count;
    const to = Math.min(decoded.duration, start + ((index + 1) * duration) / count);
    if (from >= to) return 0;
    const first = Math.floor(from * samplesPerSecond);
    const end = Math.min(decoded.samples.length, Math.ceil(to * samplesPerSecond));
    let peak = 0;
    for (let cursor = first; cursor < end; cursor++)
      peak = Math.max(peak, decoded.samples[cursor] ?? 0);
    return peak;
  });
}
