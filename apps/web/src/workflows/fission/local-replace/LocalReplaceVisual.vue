<script setup lang="ts">
import type { MockAsset } from './local-replace.mock';
defineProps<{ asset?: MockAsset; caption?: string; previewUrl?: string }>();
</script>
<template>
  <div
    v-if="asset"
    :class="[
      'lr-asset-visual',
      `kind-${asset.type}`,
      `variant-${asset.variant}`,
      { 'has-local-preview': previewUrl, 'is-local': asset.local },
    ]"
  >
    <img v-if="previewUrl" :src="previewUrl" :alt="asset.name" />
    <small v-else-if="asset.local" class="lr-local-preview-missing">重新导入以恢复本地预览</small>
    <span class="asset-scene" /><span class="asset-person"><i /></span>
    <span class="asset-product"><i /><b /></span><span class="asset-copy">{{ asset.label }}</span
    ><em>{{ asset.fit }}%</em>
  </div>
  <div v-else class="lr-visual visual-family-table" style="--shot-a: #754124; --shot-b: #b5804e">
    <span class="visual-window" /><span class="visual-counter" /><span
      class="visual-person home-blogger"
    />
    <span class="visual-product sausage-dish" /><span v-if="caption" class="visual-caption">{{
      caption
    }}</span>
  </div>
</template>
