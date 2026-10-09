<script setup lang="ts">
import type { EffectImportMaterial, EffectImportMode } from '@ai-marketing/contracts';
import { computed } from 'vue';
import ImportContentViewer from '../../../../platform/file/components/ImportContentViewer.vue';
import { effectImportMaterialContentPath } from '../api/effect-import.api';
const props = defineProps<{
  material: EffectImportMaterial;
  mode: EffectImportMode;
  previewImage?: HTMLImageElement | null;
}>();
const emit = defineEmits<{ close: [] }>();
const file = computed(() => ({
  name: props.material.originalFileName || props.material.expectedFileName || '资料文件',
  mimeType: props.material.mimeType,
  updatedAt: props.material.updatedAt,
  previewContentUrl: props.material.contentUrl,
  sizeBytes: props.material.sizeBytes,
  isImage: props.material.type === 'PRODUCT_IMAGE',
  contentPath: props.material.contentUrl
    ? effectImportMaterialContentPath(
        props.material.projectId,
        props.mode,
        props.material.productId,
        props.material.id,
      )
    : null,
}));
</script>
<template>
  <ImportContentViewer :file="file" :preview-image="previewImage" @close="emit('close')" />
</template>
