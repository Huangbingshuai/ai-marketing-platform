<script setup lang="ts">
import type { EffectImportMaterial } from '@ai-marketing/contracts';
import { computed } from 'vue';
import ImportImagePreview from '../../../../platform/file/components/ImportImagePreview.vue';
const props = defineProps<{ material: EffectImportMaterial }>();
const file = computed(() => ({
  id: props.material.id,
  projectId: props.material.projectId,
  groupId: props.material.productId,
  name: props.material.originalFileName || props.material.expectedFileName || '图片',
  contentUrl: props.material.contentUrl ?? '',
  updatedAt: props.material.updatedAt,
  mimeType: props.material.mimeType,
  ready: props.material.type === 'PRODUCT_IMAGE' && props.material.status === 'READY',
}));
</script>
<template><ImportImagePreview :file="file" /></template>
