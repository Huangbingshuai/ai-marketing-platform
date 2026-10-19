<script setup lang="ts">
import { computed } from 'vue';
import type { ProductionAsset, ProductionShot } from '@ai-marketing/contracts';
import ProductionAssetVisual from './ProductionAssetVisual.vue';
import { imageSource, imageOwnershipLabel } from './production-asset-images';
const props = defineProps<{
  projectId: string;
  assets: ProductionAsset[];
  shot: ProductionShot;
  locked: boolean;
}>();
const emit = defineEmits<{
  toggle: [asset: ProductionAsset];
  prepare: [asset: ProductionAsset];
  preview: [asset: ProductionAsset];
}>();
const categories = [
  { id: 'CHARACTER', name: '角色', short: '角色' },
  { id: 'PRODUCT', name: '产品', short: '产品' },
  { id: 'SCENE', name: '场景', short: '场景' },
  { id: 'PROP', name: '道具', short: '道具' },
];
const bound = (id: string) => props.shot.bindings.some((b) => b.assetId === id);
const source = (asset: ProductionAsset) => imageSource(props.assets, asset);
function preview(asset: ProductionAsset) {
  const owner = source(asset);
  if (owner?.image) emit('preview', owner);
}
function prepare(asset: ProductionAsset) {
  const owner = source(asset);
  if (owner && !props.locked) emit('prepare', owner);
}
const count = computed(() => props.assets.filter((a) => bound(a.id)).length);
const groups = computed(() =>
  categories
    .map((c) => ({ ...c, assets: props.assets.filter((a) => a.kind === c.id) }))
    .filter((g) => g.assets.length),
);
function toggle(asset: ProductionAsset) {
  if (!props.locked) emit('toggle', asset);
}
</script>
<template>
  <section class="reference-library" aria-label="镜头素材库">
    <header>
      <h3>参考素材</h3>
      <span>{{ count }}/{{ assets.length }} 已绑定</span>
    </header>
    <div class="library-groups">
      <section v-for="group in groups" :key="group.id" class="reference-group">
        <h4>{{ group.name }}</h4>
        <div class="reference-grid">
          <article
            v-for="asset in group.assets"
            :key="asset.id"
            :class="['reference-item', { bound: bound(asset.id) }]"
            role="checkbox"
            tabindex="0"
            :aria-checked="bound(asset.id)"
            :aria-disabled="locked"
            :aria-label="`绑定${asset.name}`"
            :title="`${asset.name} · ${bound(asset.id) ? '点击移除绑定' : '点击绑定'}`"
            @click="toggle(asset)"
            @keydown.enter.self.prevent="toggle(asset)"
            @keydown.space.self.prevent="toggle(asset)"
          >
            <button
              class="reference-thumb"
              type="button"
              :disabled="!source(asset)?.image"
              :aria-label="`预览${source(asset)?.name || asset.name}图片`"
              @click.stop="preview(asset)"
            >
              <ProductionAssetVisual
                v-if="source(asset)?.image"
                :asset="source(asset)!"
                :project-id="projectId"
                compact
              />
              <span v-else>{{ group.short.slice(0, 1) }}</span>
            </button>
            <div class="reference-copy">
              <strong>{{ asset.name }}</strong>
              <small
                >{{ group.short }} ·
                {{
                  !source(asset)
                    ? '归属待核对'
                    : bound(asset.id)
                      ? source(asset)?.image
                        ? '可使用'
                        : '未生成'
                      : '未绑定'
                }}</small
              >
              <small
                v-if="source(asset) && source(asset)?.id !== asset.id"
                :title="imageOwnershipLabel(assets, asset)"
                >{{ imageOwnershipLabel(assets, asset) }}</small
              >
              <button
                v-if="bound(asset.id) && source(asset) && !source(asset)?.image"
                class="goto-generate"
                type="button"
                :disabled="locked"
                :aria-label="`前往资产准备生成${source(asset)?.name}图片`"
                title="前往资产准备生成图片"
                @click.stop="prepare(asset)"
              >
                去生成 →
              </button>
            </div>
          </article>
        </div>
      </section>
      <p v-if="!assets.length" class="empty">暂无参考素材</p>
    </div>
  </section>
</template>
<style scoped>
.reference-library {
  min-width: 0;
  color: #405674;
}
header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 12px;
}
h3 {
  margin: 0;
  font-size: 12px;
  font-weight: 650;
}
header > span {
  border-radius: 20px;
  padding: 3px 7px;
  background: #eef2f8;
  color: #8394aa;
  font-size: 10px;
  white-space: nowrap;
}
.library-groups {
  max-height: 300px;
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: #ccd5e1 transparent;
}
.reference-group + .reference-group {
  margin-top: 14px;
}
h4 {
  margin: 0 0 7px;
  font-size: 11px;
  font-weight: 500;
  color: #8c9aaf;
}
.reference-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 7px;
}
.reference-item {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
  padding: 7px;
  border: 1px solid #e2e8f1;
  border-radius: 8px;
  background: #fafbfd;
  cursor: pointer;
}
.reference-item.bound {
  border-color: #aec4ed;
  background: #eff4ff;
}
.reference-item[aria-disabled='true'] {
  cursor: default;
  opacity: 0.7;
}
button {
  font: inherit;
  cursor: pointer;
}
.reference-thumb {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 35px;
  height: 35px;
  flex-shrink: 0;
  overflow: hidden;
  padding: 0;
  border: 1px solid #e0e6ef;
  border-radius: 7px;
  background: #f0f3f8;
  color: #91a0b5;
  font-size: 13px;
}
.reference-thumb:disabled {
  cursor: inherit;
}
.reference-thumb :deep(.asset-visual) {
  width: 100%;
  height: 100%;
  border-radius: 0;
}
.reference-copy {
  min-width: 0;
  display: grid;
  gap: 3px;
}
.reference-copy strong {
  font-size: 11px;
  line-height: 1.4;
  font-weight: 550;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.reference-copy small {
  font-size: 10px;
  color: #8f9db0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.goto-generate {
  justify-self: start;
  padding: 0;
  border: 0;
  background: transparent;
  color: #456fd1;
  font-size: 10px;
  line-height: 1.3;
}
.empty {
  margin: 20px 0;
  color: #95a2b6;
  font-size: 11px;
}
button:focus-visible,
.reference-item:focus-visible {
  outline: 2px solid #4c76e6;
  outline-offset: 2px;
}
@media (max-width: 1350px) {
  .reference-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
