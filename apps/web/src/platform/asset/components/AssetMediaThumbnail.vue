<script setup lang="ts">
import { FileText, Film, Image, Music, PanelsTopLeft, Play } from '@lucide/vue';
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { BrowserAsset } from '../project-asset-browser';

const props = defineProps<{ item: BrowserAsset; intrinsicImage?: boolean }>();
const container = ref<HTMLElement | null>(null);
const visible = ref(false);
const failed = ref(false);
let observer: IntersectionObserver | undefined;
onMounted(() => {
  observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        visible.value = true;
        observer?.disconnect();
      }
    },
    { rootMargin: '100px' },
  );
  if (container.value) observer.observe(container.value);
});
watch(
  () => props.item.id,
  () => {
    failed.value = false;
  },
);
onBeforeUnmount(() => observer?.disconnect());
</script>

<template>
  <span ref="container" class="media-thumbnail" :class="{ 'intrinsic-image': intrinsicImage }">
    <img
      v-if="!failed && ['IMAGE', 'VIDEO'].includes(item.previewKind) && item.previewUrl"
      :src="item.previewUrl"
      alt=""
      loading="lazy"
      @error="failed = true"
    />
    <video
      v-else-if="
        !failed && visible && item.previewKind === 'VIDEO' && item.contentUrl && !item.unavailable
      "
      :src="item.contentUrl"
      preload="metadata"
      muted
      playsinline
      @error="failed = true"
    />
    <span v-else class="file-symbol"
      ><Film v-if="item.category === 'VIDEO'" :size="30" /><Image
        v-else-if="item.category === 'IMAGE'"
        :size="30" /><Music v-else-if="item.category === 'AUDIO'" :size="30" /><PanelsTopLeft
        v-else-if="item.category === 'PROJECT'"
        :size="30" /><FileText v-else :size="30"
    /></span>
    <span v-if="item.category === 'VIDEO'" class="video-mark"
      ><Play :size="12" fill="currentColor" />{{
        item.durationSeconds ? `${Math.round(item.durationSeconds)} 秒` : '视频'
      }}</span
    >
  </span>
</template>

<style scoped>
.media-thumbnail {
  position: relative;
  display: block;
  height: 100%;
  width: 100%;
  overflow: hidden;
  background: #eaf1ff;
  color: #6b86b0;
}
img,
video {
  width: 100%;
  height: 100%;
  object-fit: contain;
  display: block;
}
.file-symbol {
  display: grid;
  width: 100%;
  height: 100%;
  place-items: center;
}
.intrinsic-image {
  height: auto;
  background: transparent;
}
.intrinsic-image img {
  height: auto;
}
.intrinsic-image .file-symbol {
  min-height: 120px;
  background: #eaf1ff;
}
.video-mark {
  position: absolute;
  bottom: 8px;
  right: 8px;
  display: flex;
  gap: 4px;
  align-items: center;
  padding: 3px 6px;
  background: #2228;
  color: #fff;
  border-radius: 3px;
  font-size: 11px;
}
</style>
