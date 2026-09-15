<script setup lang="ts">
import { computed } from 'vue';

import EffectTemplateMixThumbnail from './EffectTemplateMixThumbnail.vue';

const props = withDefaults(
  defineProps<{
    source: string;
    sourceDuration: number;
    duration: number;
    trimStart?: number;
    version?: string;
  }>(),
  { trimStart: 0, version: '' },
);

const frameCount = computed(() => Math.max(3, Math.min(8, Math.round(props.duration * 2))));
const frameTime = (index: number): number => {
  const safeStart = Math.max(0, Math.min(props.trimStart, Math.max(0, props.sourceDuration - 0.04)));
  const safeDuration = Math.max(0, Math.min(props.duration, props.sourceDuration - safeStart - 0.04));
  const progress = frameCount.value <= 1 ? 0 : index / (frameCount.value - 1);
  return Math.max(0, Math.min(props.sourceDuration - 0.04, safeStart + safeDuration * progress));
};
</script>

<template>
  <div class="mix-filmstrip" :style="{ '--filmstrip-count': frameCount }">
    <EffectTemplateMixThumbnail
      v-for="index in frameCount"
      :key="`${source}:${version}:${index}`"
      :source="source"
      :time="frameTime(index - 1)"
      :version="version"
      aria-hidden="true"
    />
  </div>
</template>

<style scoped>
.mix-filmstrip {
  position: absolute;
  inset: 0;
  display: grid;
  grid-template-columns: repeat(var(--filmstrip-count), minmax(0, 1fr));
  overflow: hidden;
  pointer-events: none;
  contain: strict;
}
.mix-filmstrip :deep(img),
.mix-filmstrip :deep(.thumbnail-loading) {
  width: 100%;
  min-width: 0;
  height: 100%;
  min-height: 0;
  display: block;
  overflow: hidden;
  object-fit: cover;
  clip-path: inset(0);
  opacity: 0.84;
}
</style>
