<script setup lang="ts">
import { ref } from 'vue';
import { Video } from '@lucide/vue';
import type { ProductionAsset, ProductionShot } from '@ai-marketing/contracts';
import ProductionAssetVisual from './ProductionAssetVisual.vue';
import ProductionRenderDialog from './ProductionRenderDialog.vue';
const props = defineProps<{
  projectId: string;
  shot: ProductionShot;
  assets: ProductionAsset[];
  prompt: string;
  locked: boolean;
  editing: boolean;
  index: number;
}>();
const emit = defineEmits<{ preview: [asset: ProductionAsset]; duration: [seconds: number] }>();
const renderOpen = ref(false);
function updateDuration(event: Event) {
  if (props.locked || !props.editing) return;
  const value = Number((event.target as HTMLInputElement).value);
  if (Number.isFinite(value) && value > 0 && value <= 3600) emit('duration', value);
}
defineExpose({
  open: () => {
    renderOpen.value = true;
  },
});
</script>
<template>
  <aside class="render-panel" aria-label="逐镜渲染">
    <section class="player-card">
      <header>
        <h3>分镜 {{ String(index).padStart(2, '0') }}</h3>
        <span class="status"><i />待生成</span><small>{{ shot.durationSeconds }}s</small>
      </header>
      <div class="player-stage">
        <Video :size="24" :stroke-width="1.4" /><strong>暂无视频</strong><span>生成后在此预览</span>
        <button type="button" :disabled="locked" @click="renderOpen = true">生成视频</button>
      </div>
    </section>
    <div class="inspector-body">
      <section class="bound-section">
        <header>
          <h3>绑定参考图</h3>
          <span class="count">{{ assets.length }}</span>
        </header>
        <div v-if="assets.length" class="reference-strip">
          <button
            v-for="asset in assets"
            :key="asset.id"
            type="button"
            :disabled="!asset.image"
            :title="asset.name"
            :aria-label="`预览绑定图片${asset.name}`"
            @click="$emit('preview', asset)"
          >
            <ProductionAssetVisual :asset="asset" :project-id="projectId" compact /><small>{{
              asset.name
            }}</small>
          </button>
        </div>
        <p v-else>未绑定参考图</p>
      </section>
    </div>
    <footer>
      <div class="duration">
        <label for="shot-render-duration">分镜时长</label
        ><span
          ><input
            id="shot-render-duration"
            aria-label="分镜时长"
            type="number"
            min="0.1"
            max="3600"
            step="0.1"
            :value="shot.durationSeconds"
            :readonly="!editing"
            :disabled="locked"
            @change="updateDuration"
          />s</span
        >
      </div>
      <button
        class="generate-button"
        type="button"
        :disabled="locked"
        :aria-label="`生成当前分镜视频`"
        @click="renderOpen = true"
      >
        生成视频
      </button>
    </footer>
    <ProductionRenderDialog
      :open="renderOpen"
      type="VIDEO"
      :assets="assets"
      :shot="shot"
      :prompt="prompt"
      @close="renderOpen = false"
    />
  </aside>
</template>
<style scoped>
.render-panel {
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  border-left: 1px solid #e4e9f2;
  background: #f8fafd;
  color: #405674;
}
header {
  display: flex;
  align-items: center;
  gap: 8px;
}
h3 {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
}
.player-card > header {
  padding: 13px 12px;
  border-bottom: 1px solid #e5eaf1;
}
.status {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
  font-size: 10px;
  color: #95a1b2;
}
.status i {
  width: 5px;
  height: 5px;
  background: currentColor;
  border-radius: 50%;
}
header > small {
  color: #9aa5b6;
  font-size: 10px;
}
.player-stage {
  aspect-ratio: 16/9;
  min-height: 160px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 16px;
  background: #eef2f7;
  color: #a0acbd;
  border-bottom: 1px solid #e4e9f1;
}
.player-stage strong {
  font-size: 12px;
  color: #8191a8;
  font-weight: 550;
  margin-top: 3px;
}
.player-stage > span {
  font-size: 10px;
}
button {
  font: inherit;
  cursor: pointer;
}
.player-stage button {
  margin-top: 6px;
  padding: 6px 12px;
  border: 0;
  border-radius: 7px;
  background: #315ff0;
  color: #fff;
  font-size: 11px;
}
.inspector-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 16px 14px;
}
.count {
  padding: 2px 6px;
  background: #edf1f7;
  border-radius: 6px;
  color: #91a0b5;
  font-size: 10px;
}
.reference-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}
.reference-strip button {
  padding: 0;
  width: 58px;
  border: 0;
  background: transparent;
  text-align: left;
  color: #8798b0;
}
.reference-strip :deep(.asset-visual) {
  width: 58px;
  height: 44px;
  border: 1px solid #e2e7ef;
  border-radius: 7px;
  box-sizing: border-box;
}
.reference-strip small {
  display: block;
  margin-top: 4px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 9px;
}
.bound-section p {
  color: #9ba7b8;
  font-size: 11px;
  margin-top: 12px;
}
footer {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 14px 12px;
  border-top: 1px solid #e2e8f2;
  background: #f5f8fd;
}
.duration {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
  border: 1px solid #dce5f5;
  border-radius: 8px;
  background: #edf3ff;
  font-size: 11px;
  color: #6a80a3;
}
.duration > span {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 10px;
}
.duration input {
  width: 53px;
  padding: 3px 5px;
  border: 1px solid #dae3f2;
  border-radius: 5px;
  background: #fff;
  color: #49658b;
  font: inherit;
  text-align: right;
}
.generate-button {
  width: 100%;
  padding: 9px 12px;
  border: 0;
  border-radius: 8px;
  background: #315ff0;
  color: white;
  font-size: 12px;
  font-weight: 550;
}
button:disabled {
  cursor: default;
  opacity: 0.5;
}
button:focus-visible,
input:focus-visible {
  outline: 2px solid #4a74e5;
  outline-offset: 2px;
}
</style>
