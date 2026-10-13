<script setup lang="ts">
import { ref } from 'vue';
import { Video, Play, History, Image, ArrowUpRight } from '@lucide/vue';
import type { ProductionAsset, ProductionShot } from '@ai-marketing/contracts';
import ProductionAssetVisual from './ProductionAssetVisual.vue';
import ProductionRenderDialog from './ProductionRenderDialog.vue';
defineProps<{
  projectId: string;
  shot: ProductionShot;
  assets: ProductionAsset[];
  prompt: string;
  stale: boolean;
  locked: boolean;
  index: number;
}>();
defineEmits<{ prepare: [asset: ProductionAsset] }>();
const renderOpen = ref(false),
  ratio = ref('16:9'),
  resolution = ref('1080P');
</script>
<template>
  <aside class="render-panel" aria-label="逐镜渲染">
    <section class="player-card">
      <header>
        <div>
          <Video :size="16" />
          <h3>镜头 {{ String(index).padStart(2, '0') }}</h3>
        </div>
        <span>尚未渲染</span>
      </header>
      <div class="player-stage" :class="{ portrait: ratio === '9:16' }">
        <div class="frame-mark top"></div>
        <Play :size="29" :stroke-width="1.2" /><strong>当前镜头预览</strong>
        <p>生成视频后在此预览</p>
        <div class="frame-mark bottom"></div>
        <span class="timecode">00:00 / {{ shot.durationSeconds }} 秒</span>
      </div>
      <div class="player-caption">
        <strong>{{ shot.title }}</strong
        ><span>{{ ratio }} · {{ resolution }}</span>
      </div>
    </section>
    <section class="render-section">
      <header>
        <h3><Image :size="15" />本镜图片</h3>
        <span>{{ assets.filter((a) => a.image).length }} / {{ assets.length }}</span>
      </header>
      <div class="reference-strip">
        <button
          v-for="a in assets"
          :key="a.id"
          :aria-label="`准备${a.name}图片`"
          @click="$emit('prepare', a)"
        >
          <ProductionAssetVisual :asset="a" :project-id="projectId" compact /><span>{{
            a.name
          }}</span>
        </button>
        <p v-if="!assets.length" class="muted">尚未绑定素材</p>
      </div>
      <p v-if="assets.some((a) => !a.image)" class="muted">
        部分图片待准备，可先完成分镜与提示词。
      </p>
    </section>
    <section class="render-section">
      <header>
        <h3>输出设置</h3>
        <span>渲染前设置</span>
      </header>
      <div class="render-fields">
        <label
          >画幅<select v-model="ratio" aria-label="视频画幅">
            <option>16:9</option>
            <option>9:16</option>
            <option>1:1</option>
          </select></label
        ><label
          >分辨率<select v-model="resolution" aria-label="视频分辨率">
            <option>1080P</option>
            <option>720P</option>
          </select></label
        >
      </div>
      <div class="render-duration">
        <span>镜头时长</span><strong>{{ shot.durationSeconds }} 秒</strong>
      </div>
      <button class="render-button" :disabled="locked" @click="renderOpen = true">
        <Video :size="16" />渲染当前镜头<ArrowUpRight :size="14" />
      </button>
      <p class="muted">
        {{
          stale
            ? '提示词待更新，请先核对镜头修改。'
            : !prompt
              ? '先创作并保存本镜提示词。'
              : '渲染服务待接通，点击查看制作内容。'
        }}
      </p>
    </section>
    <section class="render-section history">
      <header>
        <h3><History :size="15" />生成历史</h3>
        <span>0</span>
      </header>
      <p class="muted">尚无视频记录。逐镜生成后可在这里预览与选择结果。</p>
    </section>
    <ProductionRenderDialog
      :open="renderOpen"
      type="VIDEO"
      :assets="assets"
      :shot="shot"
      :prompt="prompt"
      :ratio="ratio"
      :resolution="resolution"
      @close="renderOpen = false"
    />
  </aside>
</template>
<style scoped>
.render-panel {
  border: 1px solid #e3e9f2;
  background: #fff;
  border-radius: 14px;
  overflow: hidden;
  min-width: 0;
  color: #405674;
}
header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
header > div,
h3 {
  display: flex;
  align-items: center;
  gap: 7px;
}
h3 {
  font-size: 12px;
  margin: 0;
  font-weight: 600;
}
header span {
  font-size: 10px;
  color: #93a0b4;
}
.player-card > header {
  padding: 16px;
}
.player-stage {
  position: relative;
  background: #edf1f6;
  aspect-ratio: 16/10;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: #a6b2c3;
  min-height: 170px;
  gap: 10px;
}
.player-stage.portrait {
  aspect-ratio: 9/12;
}
.player-stage strong {
  font-size: 12px;
  font-weight: 500;
  color: #8495ae;
}
.player-stage p {
  font-size: 10px;
  margin: 0;
  color: #a2aebe;
}
.timecode {
  position: absolute;
  bottom: 13px;
  left: 16px;
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  color: #94a3b7;
}
.frame-mark {
  position: absolute;
  width: 16px;
  height: 16px;
  border: 1px solid #c9d3e1;
}
.frame-mark.top {
  top: 20px;
  left: 20px;
  border-right: 0;
  border-bottom: 0;
}
.frame-mark.bottom {
  bottom: 20px;
  right: 20px;
  border-left: 0;
  border-top: 0;
}
.player-caption {
  display: grid;
  gap: 7px;
  padding: 15px 16px;
}
.player-caption strong {
  font-size: 12px;
  font-weight: 550;
  line-height: 1.6;
}
.player-caption span {
  font-size: 10px;
  color: #a0acbe;
}
.render-section {
  padding: 18px 16px;
  border-top: 1px solid #e9edf4;
}
.reference-strip {
  display: flex;
  gap: 9px;
  overflow: auto;
  margin-top: 14px;
  padding-bottom: 4px;
}
.reference-strip button {
  background: transparent;
  padding: 0;
  border: 0;
  cursor: pointer;
  width: 54px;
  flex-shrink: 0;
  text-align: left;
}
.reference-strip button span {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 9px;
  color: #8a9aaf;
  margin-top: 6px;
}
.muted {
  color: #9aa7b9;
  font-size: 10px;
  line-height: 1.8;
  margin: 12px 0 0;
}
.render-fields {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  margin-top: 16px;
}
.render-fields label {
  display: grid;
  gap: 7px;
  font-size: 10px;
  color: #8b9ab1;
}
.render-fields select {
  width: 100%;
  min-width: 0;
  padding: 8px;
  border: 1px solid #e0e7f1;
  background: #fbfcfe;
  border-radius: 7px;
  color: #617894;
  font: inherit;
}
.render-duration {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 16px 0;
  font-size: 11px;
  color: #8999ad;
}
.render-duration strong {
  font-size: 12px;
  color: #647d9d;
  font-weight: 550;
}
.render-button {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  width: 100%;
  min-height: 41px;
  border: 0;
  background: #315ff0;
  color: #fff;
  border-radius: 9px;
  font-size: 12px;
  cursor: pointer;
}
.render-button:disabled {
  opacity: 0.45;
  cursor: default;
}
.history p {
  margin-bottom: 3px;
}
button:focus-visible {
  outline: 2px solid #315ff0;
  outline-offset: 3px;
}
</style>
