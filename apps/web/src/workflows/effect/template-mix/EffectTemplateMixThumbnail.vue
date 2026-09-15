<script setup lang="ts">
import { Film } from '@lucide/vue';
import { computed, watch } from 'vue';

import {
  releaseEffectTemplateMixThumbnail,
  retainEffectTemplateMixThumbnail,
  useEffectTemplateMixThumbnail,
} from './effect-template-mix-thumbnail-cache';

const props = withDefaults(
  defineProps<{
    alt?: string;
    source: string;
    time?: number;
    version?: string;
  }>(),
  { alt: '', time: 0.12, version: '' },
);

const source = computed(() => props.source);
const time = computed(() => props.time);
const version = computed(() => props.version);
const thumbnailUrl = useEffectTemplateMixThumbnail(source, time, version);

watch(
  [source, time, version],
  ([nextSource, nextTime, nextVersion], _previous, onCleanup) => {
    retainEffectTemplateMixThumbnail(nextSource, nextTime, nextVersion);
    onCleanup(() => releaseEffectTemplateMixThumbnail(nextSource, nextTime, nextVersion));
  },
  { immediate: true },
);
</script>

<template>
  <img v-if="thumbnailUrl" :src="thumbnailUrl" :alt="alt" draggable="false" />
  <span v-else class="thumbnail-loading" aria-hidden="true"><Film :size="16" /></span>
</template>

<style scoped>
img,
.thumbnail-loading {
  width: 100%;
  height: 100%;
  display: block;
  object-fit: cover;
}
.thumbnail-loading {
  display: grid;
  place-items: center;
  color: #9babc0;
  background: linear-gradient(135deg, #edf2f8, #dfe8f3);
}
</style>
