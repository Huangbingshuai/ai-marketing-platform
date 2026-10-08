<script setup lang="ts">
import type { ImportImageFile } from '../import-image-preview';
import { useImportImagePreview } from '../import-image-preview';
import { nextTick, ref, shallowRef, watch } from 'vue';
import { drawImportImage, importImageCache } from '../import-image-cache';

const props = defineProps<{ file: ImportImageFile }>();
const { source, supported, state, requestKey, loaded, failed, retry } = useImportImagePreview(
  () => props.file,
);
const eventKey = (event: Event): string =>
  (event.target as HTMLImageElement).dataset.requestKey ?? '';
const cachedImage = shallowRef<HTMLImageElement | null>(null);
const canvas = ref<HTMLCanvasElement | null>(null);
watch(
  requestKey,
  async (key) => {
    cachedImage.value = supported.value
      ? importImageCache.get(props.file.contentUrl, props.file.updatedAt)
      : null;
    if (!cachedImage.value) return;
    await nextTick();
    if (key !== requestKey.value || !cachedImage.value) return;
    if (canvas.value && drawImportImage(canvas.value, cachedImage.value, 120)) loaded(key);
    else cachedImage.value = null;
  },
  { immediate: true, flush: 'sync' },
);
function imageLoaded(event: Event): void {
  const key = eventKey(event);
  if (key !== requestKey.value) return;
  importImageCache.put(
    props.file.contentUrl,
    props.file.updatedAt,
    event.target as HTMLImageElement,
  );
  loaded(key);
}
</script>

<template>
  <span class="image-preview" :aria-busy="supported && state !== 'ready' && state !== 'failed'">
    <canvas v-if="cachedImage" ref="canvas" role="img" :aria-label="`${file.name} 缩略图`" />
    <img
      v-else-if="source && (state === 'loading' || state === 'ready')"
      :key="requestKey"
      :data-request-key="requestKey"
      :data-project-id="file.projectId"
      :data-product-id="file.groupId"
      :data-material-id="file.id"
      :data-material-updated-at="file.updatedAt"
      :src="source"
      :alt="`${file.name} 缩略图`"
      :class="{ loaded: state === 'ready' }"
      loading="eager"
      decoding="async"
      @load="imageLoaded($event)"
      @error="failed(eventKey($event))"
    />
    <button
      v-if="supported && state === 'failed'"
      type="button"
      class="preview-retry"
      :aria-label="`重试预览 ${file.name}`"
      title="图片预览暂时加载失败，点击重试；不会重传或修改资料"
      @click="retry"
    >
      重试预览
    </button>
    <small v-else-if="supported && state !== 'ready'" role="status">
      {{ state === 'retrying' ? '正在重试' : '加载中' }}
    </small>
    <small v-else-if="!supported">
      {{ !file.ready ? '上传中' : /\.psd$/i.test(file.name) ? 'PSD 文件' : '暂无预览' }}
    </small>
  </span>
</template>

<style scoped>
.image-preview {
  position: relative;
  display: grid;
  place-items: center;
  width: 100%;
  height: 100%;
}
img,
canvas {
  position: absolute;
  inset: 0;
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
  opacity: 0;
}
img.loaded,
canvas {
  opacity: 1;
}
small,
.preview-retry {
  padding: 4px;
  font-size: 8px;
  line-height: 1.25;
  text-align: center;
}
.preview-retry {
  width: 100%;
  height: 100%;
  border: 0;
  background: transparent;
  color: #66789c;
  cursor: pointer;
}
.preview-retry:focus-visible {
  outline: 2px solid #2563eb;
  outline-offset: -2px;
}
</style>
