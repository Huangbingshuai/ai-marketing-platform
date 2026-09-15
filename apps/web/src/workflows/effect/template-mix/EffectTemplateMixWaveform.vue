<script setup lang="ts">
import { computed, watch } from 'vue';

import {
  requestEffectTemplateMixWaveform,
  useEffectTemplateMixWaveform,
} from './effect-template-mix-waveform-cache';

const props = defineProps<{
  barCount: number;
  duration: number;
  source: string;
  trimStart: number;
}>();

const source = computed(() => props.source);
const waveform = useEffectTemplateMixWaveform(source);
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
    return peak;
  });
});
const status = computed(() => waveform.value?.status ?? 'LOADING');

watch(source, (nextSource) => requestEffectTemplateMixWaveform(nextSource), { immediate: true });
</script>

<template>
  <div
    class="clip-waveform"
    :class="[`is-${status.toLowerCase()}`, { 'has-samples': visibleBars.length }]"
    :data-waveform-status="status"
    :data-waveform-samples="visibleBars.length"
    :title="status === 'FAILED' ? '素材音轨不可用，未生成伪波形' : '素材真实音频波形'"
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
  height: 18px;
  position: absolute;
  right: 0;
  bottom: 0;
  left: 0;
  padding: 2px 3px;
  display: flex;
  align-items: center;
  gap: 1px;
  overflow: hidden;
  border-top: 1px solid #8db9c0;
  border-radius: 0 0 2px 2px;
  background: #e5f1f2;
}
.clip-waveform::after {
  height: 1px;
  position: absolute;
  right: 0;
  left: 0;
  top: 50%;
  background: #69aeb7;
  content: '';
}
.clip-waveform.has-samples {
  border-color: #38a9b1;
  background: #137c86;
}
.clip-waveform.has-samples::after {
  background: #72d6d7;
}
.clip-waveform i {
  min-width: 1px;
  max-width: 2px;
  max-height: 100%;
  position: relative;
  z-index: 1;
  flex: 1 1 1px;
  border-radius: 1px;
  background: #6de2df;
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
