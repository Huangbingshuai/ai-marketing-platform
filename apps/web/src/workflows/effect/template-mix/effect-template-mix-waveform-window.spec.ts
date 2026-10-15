import { describe, expect, it } from 'vitest';
import waveformSource from './EffectTemplateMixWaveform.vue?raw';
import timelineSource from './EffectTemplateMixTimeline.vue?raw';
import { waveformWindowPeaks } from './effect-template-mix-waveform-window';

const decoded = { duration: 4, samples: [0.2, 0.4, 0.6, 0.8], status: 'READY' as const };

describe('waveform timeline alignment', () => {
  it('maps the full source to equal time buckets', () => {
    expect(waveformWindowPeaks(decoded, 0, 4, 4)).toEqual(decoded.samples);
  });
  it('uses the actual trim offset, including split music', () => {
    expect(waveformWindowPeaks(decoded, 2, 2, 2)).toEqual([0.6, 0.8]);
    expect(waveformWindowPeaks(decoded, 1.5, 1, 2)).toEqual([0.4, 0.6]);
  });
  it('does not stretch source audio into silent time after its end', () => {
    expect(waveformWindowPeaks(decoded, 2, 4, 4)).toEqual([0.6, 0.8, 0, 0]);
    expect(waveformWindowPeaks(decoded, 4, 2, 2)).toEqual([0, 0]);
  });
  it('retains a real peak in a bucket straddling the source end', () => {
    expect(waveformWindowPeaks(decoded, 3.5, 2, 2)).toEqual([0.8, 0]);
  });
  it('preserves actual silence without making synthetic peaks', () => {
    expect(waveformWindowPeaks({ ...decoded, samples: [0, 0, 0, 0] }, 0, 4, 4)).toEqual([
      0, 0, 0, 0,
    ]);
  });
  it('does not fabricate missing or unfinished waveforms', () => {
    for (const value of [
      null,
      { ...decoded, status: 'FAILED' as const },
      { ...decoded, status: 'LOADING' as const },
      { ...decoded, samples: [] },
    ]) {
      expect(waveformWindowPeaks(value, 0, 4, 4)).toEqual([]);
    }
  });
  it('bounds malformed geometry and bar counts', () => {
    expect(waveformWindowPeaks(decoded, 0, 0, 4)).toEqual([]);
    expect(waveformWindowPeaks(decoded, NaN, 4, 4)).toEqual([]);
    expect(waveformWindowPeaks(decoded, 0, 4, Infinity)).toEqual([]);
    expect(waveformWindowPeaks(decoded, 0, 4, 9999)).toHaveLength(1600);
    expect(waveformWindowPeaks(decoded, 0, 4, 0)).toEqual([0.8]);
  });
  it('allows bars to fill the full clip without a fixed width cap or overflow minimum', () => {
    expect(waveformSource).toContain('flex: 1 1 0;');
    expect(waveformSource).not.toMatch(/(?:min|max)-width:\s*[1-9]\d*px/);
  });
  it('retains video source peaks when packaging has silenced original sound', () => {
    expect(timelineSource).not.toContain(':gain="variant.originalVolume ?? 1"');
    expect(timelineSource).toContain("'is-muted': trackMuted('VIDEO'),");
    expect(timelineSource).not.toContain("trackMuted('VIDEO') || (variant.originalVolume ?? 1) <= 0");
    expect(timelineSource).toContain(':gain="audioGain(audio)"');
  });
});
