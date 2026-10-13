<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
import { Box, UserRound, MapPin, Shapes, Loader2 } from '@lucide/vue';
import type { ProductionAsset } from '@ai-marketing/contracts';
import { getAssetVersion } from '../../../platform/asset/api/asset.api';
const props = defineProps<{ asset: ProductionAsset; projectId: string; compact?: boolean }>();
const url = ref(''),
  failed = ref(false),
  loading = ref(false);
const icons = { PRODUCT: Box, CHARACTER: UserRound, SCENE: MapPin, PROP: Shapes };
let controller: AbortController | undefined;
watch(
  () => [props.projectId, props.asset.image?.assetId, props.asset.image?.version],
  async () => {
    controller?.abort();
    const scope = new AbortController();
    controller = scope;
    url.value = '';
    failed.value = false;
    loading.value = false;
    if (!props.asset.image) return;
    loading.value = true;
    try {
      const result = await getAssetVersion(
        props.projectId,
        props.asset.image.assetId,
        props.asset.image.version,
        scope.signal,
      );
      if (controller === scope) url.value = result.data.contentUrl ?? '';
    } catch {
      if (controller === scope) failed.value = true;
    } finally {
      if (controller === scope) loading.value = false;
    }
  },
  { immediate: true },
);
onBeforeUnmount(() => controller?.abort());
</script>
<template>
  <div class="asset-visual" :class="[asset.kind.toLowerCase(), { compact }]">
    <img v-if="url && !failed" :src="url" :alt="asset.name" loading="lazy" @error="failed = true" />
    <template v-else
      ><component
        :is="loading ? Loader2 : icons[asset.kind]"
        :size="compact ? 23 : 38"
        :stroke-width="1.3"
      /><span v-if="!compact">{{
        loading ? '读取图片中' : failed || asset.image ? '图片暂不可预览' : '尚未生成图片'
      }}</span></template
    >
  </div>
</template>
<style scoped>
.asset-visual {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  aspect-ratio: 16/10;
  background: #f1f3f6;
  color: #9ba7b7;
  overflow: hidden;
  position: relative;
  min-width: 0;
}
.asset-visual.character {
  background: #f2f0ed;
  color: #a69c90;
}
.asset-visual.scene {
  background: #edf2ef;
  color: #94a59a;
}
.asset-visual.prop {
  background: #f0f1f5;
  color: #a1a5b4;
}
.asset-visual span {
  font-size: 11px;
  letter-spacing: 0.03em;
}
.asset-visual img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  position: absolute;
  inset: 0;
}
.compact {
  width: 48px;
  height: 48px;
  aspect-ratio: 1;
  border-radius: 9px;
  flex-shrink: 0;
}
</style>
