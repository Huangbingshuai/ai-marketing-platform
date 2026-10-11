<script setup lang="ts">
import { computed, watch } from 'vue';

import { useEffectTemplateMixMediaVisibility } from './effect-template-mix-media-visibility';

import {
  requestEffectTemplateMixWaveform,
  useEffectTemplateMixWaveform,
} from './effect-template-mix-waveform-cache';

const props = withDefaults(
  defineProps<{
    barCount: number;
    duration: number;
    source: string;
    trimStart: number;
    /** Bar colour family; `VIDEO` keeps the original teal strip. */
    tone?: 'VIDEO' | 'VOICE' | 'MUSIC' | 'DETACHED';
    /** `fill` paints over the whole audio clip instead of a bottom strip. */
    layout?: 'strip' | 'fill';
    /** Effective fade at the clip head, in seconds; the bars ramp up across it. */
    fadeIn?: number;
    /** Effective fade at the clip tail, in seconds; the bars ramp down across it. */
    fadeOut?: number;
    /** Linear track gain. The waveform grows from the baseline as the user raises volume. */
    gain?: number;
  }>(),
  { tone: 'VIDEO', layout: 'strip', fadeIn: 0, fadeOut: 0, gain: 1 },
);

const source = computed(() => props.source);
const waveform = useEffectTemplateMixWaveform(source);
const { host, visible } = useEffectTemplateMixMediaVisibility();
/**
 * The gain the renderer will apply at a given point in the clip, as a linear ramp across each
 * fade. Fades are timeline seconds measured from the clip's head, so the same number drives both
 * this envelope and the worker's `afade`, and what you see here is what gets encoded.
 */
const envelope = (offset: number): number => {
  const rise = props.fadeIn > 0 ? offset / props.fadeIn : 1;
  const fall = props.fadeOut > 0 ? (props.duration - offset) / props.fadeOut : 1;
  return Math.max(0, Math.min(1, rise, fall));
};
const visibleBars = computed(() => {
  const decoded = waveform.value;
  if (!decoded || decoded.status !== 'READY' || !decoded.samples.length || decoded.duration <= 0)
    return [];
  const startRatio = Math.max(0, Math.min(1, props.trimStart / decoded.duration));
  const endRatio = Math.max(
    startRatio,
    Math.min(1, (props.trimStart + props.duration) / decoded.duration),
  );
  const rangeStart = Math.floor(startRatio * decoded.samples.length);
  const rangeEnd = Math.max(rangeStart + 1, Math.ceil(endRatio * decoded.samples.length));
  const count = Math.max(1, props.barCount);
  return Array.from({ length: count }, (_, index) => {
    const bucketStart = Math.floor(rangeStart + ((rangeEnd - rangeStart) * index) / count);
    const bucketEnd = Math.max(
      bucketStart + 1,
      Math.ceil(rangeStart + ((rangeEnd - rangeStart) * (index + 1)) / count),
    );
    let peak = 0;
    for (let cursor = bucketStart; cursor < bucketEnd; cursor += 1)
      peak = Math.max(peak, decoded.samples[cursor] ?? 0);
    // Read at the bar's midpoint, which is where a ramp drawn across the bar looks centred.
    return peak * envelope(((index + 0.5) / count) * props.duration) * Math.max(0, props.gain);
  });
});
const status = computed(() => waveform.value?.status ?? 'LOADING');

watch([source, visible], ([nextSource, isVisible]) => {
  if (isVisible) requestEffectTemplateMixWaveform(nextSource);
}, { immediate: true });
</script>

<template>
  <div
    ref="host"
    class="clip-waveform"
    :class="[
      `is-${status.toLowerCase()}`,
      `is-tone-${props.tone.toLowerCase()}`,
      `is-layout-${props.layout}`,
      { 'has-samples': visibleBars.length },
    ]"
    :data-waveform-status="status"
    :data-waveform-samples="visibleBars.length"
    :title="status === 'FAILED' ? '素材音轨不可用，未生成伪波形' : '素材音频波形'"
    aria-hidden="true"
  >
    <i
      v-for="(level, index) in visibleBars"
      :key="index"
      :style="{ height: `${Math.max(2, level * 100)}%` }"
    />
  </div>
</template>

<style scoped>
.clip-waveform {
  --wave-border: #8db9c0;
  --wave-border-solid: #38a9b1;
  --wave-bg: #e5f1f2;
  --wave-bg-solid: #137c86;
  --wave-line: #69aeb7;
  --wave-line-solid: #72d6d7;
  --wave-bar: #6de2df;
  height: 18px;
  position: absolute;
  right: 0;
  bottom: 0;
  left: 0;
  padding: 2px 3px;
  display: flex;
  align-items: flex-end;
  gap: 1px;
  overflow: hidden;
  border-top: 1px solid var(--wave-border);
  border-radius: 0 0 2px 2px;
  background: var(--wave-bg);
  /* Decorative overlay: clip-level drag, trim and volume gestures must win. */
  pointer-events: none;
}
.clip-waveform.is-tone-voice {
  --wave-border: #7d9ad4;
  --wave-border-solid: #3f6ac0;
  --wave-bg: #e7ecf8;
  --wave-bg-solid: #2f4b8f;
  --wave-line: #7d9ad4;
  --wave-line-solid: #8fb4ff;
  --wave-bar: #a9c6ff;
}
.clip-waveform.is-tone-music {
  --wave-border: #b98fd0;
  --wave-border-solid: #7d4f9c;
  --wave-bg: #f1e9f6;
  --wave-bg-solid: #5b3a75;
  --wave-line: #b98fd0;
  --wave-line-solid: #d4a8ee;
  --wave-bar: #e0b6f5;
}
.clip-waveform.is-tone-detached {
  --wave-border: #c99650;
  --wave-border-solid: #a76c20;
  --wave-bg: #f8efdE;
  --wave-bg-solid: #79501f;
  --wave-line: #c99650;
  --wave-line-solid: #f0bd69;
  --wave-bar: #ffd78f;
}
.clip-waveform::after {
  height: 1px;
  position: absolute;
  right: 0;
  left: 0;
  bottom: 2px;
  background: var(--wave-line);
  content: '';
}
.clip-waveform.has-samples {
  border-color: var(--wave-border-solid);
  background: var(--wave-bg-solid);
}
.clip-waveform.has-samples::after {
  background: var(--wave-line-solid);
}
.clip-waveform i {
  min-width: 1px;
  max-width: 2px;
  max-height: 100%;
  position: relative;
  z-index: 1;
  flex: 1 1 1px;
  border-radius: 1px;
  background: var(--wave-bar);
}
/* `fill` paints the whole audio clip, so the clip's own background stays visible. */
.clip-waveform.is-layout-fill {
  height: 100%;
  inset: 0;
  padding: 3px 4px;
  border-top: 0;
  border-radius: inherit;
  background: transparent;
}
.clip-waveform.is-layout-fill.has-samples,
.clip-waveform.is-layout-fill.is-failed:not(.has-samples) {
  border-color: transparent;
  background: transparent;
}
.clip-waveform.is-layout-fill::after {
  background: var(--wave-line-solid);
  opacity: 0.45;
}
.clip-waveform.is-layout-fill i {
  max-height: calc(100% - 5px);
}
.clip-waveform.is-layout-fill i {
  max-width: 3px;
}
.clip-waveform.is-layout-fill.is-loading:not(.has-samples) {
  background-image: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.35), transparent);
}
.clip-waveform.is-loading:not(.has-samples) {
  background-image: linear-gradient(90deg, transparent, #c9dde0, transparent);
  background-size: 50% 100%;
  animation: waveform-loading 1.2s linear infinite;
}
.clip-waveform.is-failed:not(.has-samples) {
  border-top-style: dashed;
  background: #edf2f6;
}
@keyframes waveform-loading {
  to {
    background-position: 200% 0;
  }
}
</style>
