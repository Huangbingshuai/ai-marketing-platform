<script setup lang="ts">
import type { EffectImportMaterial } from '@ai-marketing/contracts';
import { useEffectImportImagePreview } from '../effect-import-image-preview';

const props = defineProps<{ material: EffectImportMaterial }>();
const { source, supported, state, requestKey, loaded, failed, retry } = useEffectImportImagePreview(
  () => props.material,
);
const eventKey = (event: Event): string =>
  (event.target as HTMLImageElement).dataset.requestKey ?? '';
</script>

<template>
  <span class="image-preview" :aria-busy="supported && state !== 'ready' && state !== 'failed'">
    <img
      v-if="source && (state === 'loading' || state === 'ready')"
      :key="requestKey"
      :data-request-key="requestKey"
      :src="source"
      :alt="`${material.originalFileName || material.expectedFileName || '商品图片'} 缩略图`"
      :class="{ loaded: state === 'ready' }"
      loading="eager"
      decoding="async"
      @load="loaded(eventKey($event))"
      @error="failed(eventKey($event))"
    />
    <button
      v-if="supported && state === 'failed'"
      type="button"
      class="preview-retry"
      :aria-label="`重试预览 ${material.originalFileName || material.expectedFileName || '商品图片'}`"
      title="图片预览暂时加载失败，点击重试；不会重传或修改资料"
      @click="retry"
    >
      重试预览
    </button>
    <small v-else-if="supported && state !== 'ready'" role="status">
      {{ state === 'retrying' ? '正在重试' : '加载中' }}
    </small>
    <small v-else-if="!supported">
      {{
        material.status === 'UPLOADING'
          ? '上传中'
          : /\.psd$/i.test(material.originalFileName || material.expectedFileName || '')
            ? 'PSD 文件'
            : '暂无预览'
      }}
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
img {
  position: absolute;
  inset: 0;
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
  opacity: 0;
}
img.loaded {
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
