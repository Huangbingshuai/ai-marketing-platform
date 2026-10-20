<script setup lang="ts">
import type { SubtitleStyle } from './avatar-mock';
defineProps<{ styleValue: SubtitleStyle; count: number }>();
const emit = defineEmits<{ patch: [patch: Partial<SubtitleStyle>]; preset: [] }>();
const value = (event: Event) => (event.target as HTMLInputElement).value;
</script>
<template>
  <section class="fas-subtitle-style-section">
    <div class="fas-style-section-title">
      <b>基础样式</b><span>即时应用于当前选中的 {{ count }} 条字幕</span>
    </div>
    <label class="fas-field"
      >字体<select
        :value="styleValue.fontFamily"
        @change="emit('patch', { fontFamily: value($event) })"
      >
        <option>思源黑体</option>
        <option>阿里巴巴普惠体</option>
        <option>站酷高端黑</option>
        <option>系统黑体</option>
      </select></label
    >
    <label class="fas-field fas-range"
      >字号<output>{{ styleValue.fontSize }}px</output
      ><input
        :value="styleValue.fontSize"
        type="range"
        min="20"
        max="64"
        step="2"
        @input="emit('patch', { fontSize: Number(value($event)) })"
    /></label>
    <div class="fas-inline-actions">
      <button
        :class="{ active: styleValue.fontWeight >= 700 }"
        @click="emit('patch', { fontWeight: styleValue.fontWeight >= 700 ? 400 : 700 })"
      >
        B</button
      ><button
        :class="{ active: styleValue.underline }"
        @click="emit('patch', { underline: !styleValue.underline })"
      >
        <u>U</u></button
      ><button
        :class="{ active: styleValue.italic }"
        @click="emit('patch', { italic: !styleValue.italic })"
      >
        <i>I</i>
      </button>
    </div>
    <div class="fas-two-fields">
      <label class="fas-field"
        >文字颜色<input
          type="color"
          :value="styleValue.color"
          @input="emit('patch', { color: value($event) })" /></label
      ><label class="fas-field"
        >描边颜色<input
          type="color"
          :value="styleValue.outlineColor"
          @input="emit('patch', { outlineColor: value($event) })"
      /></label>
    </div>
    <label class="fas-field"
      >重点字颜色<input
        type="color"
        :value="styleValue.highlightColor"
        @input="emit('patch', { highlightColor: value($event) })"
    /></label>
    <div class="fas-two-fields">
      <label class="fas-field"
        >字间距<input
          type="number"
          :value="styleValue.letterSpacing"
          min="-4"
          max="20"
          @change="emit('patch', { letterSpacing: Number(value($event)) })" /></label
      ><label class="fas-field"
        >行间距<input
          type="number"
          :value="styleValue.lineHeight"
          min="0.8"
          max="2.4"
          step="0.05"
          @change="emit('patch', { lineHeight: Number(value($event)) })"
      /></label>
    </div>
    <label class="fas-field"
      >对齐<select
        :value="styleValue.textAlign"
        @change="emit('patch', { textAlign: value($event) as SubtitleStyle['textAlign'] })"
      >
        <option value="left">左</option>
        <option value="center">中</option>
        <option value="right">右</option>
      </select></label
    >
    <label class="fas-field"
      >位置预设<select
        :value="styleValue.position"
        @change="
          emit('patch', {
            position: value($event),
            positionY: value($event) === '顶部居中' ? 16 : value($event) === '中部居中' ? 50 : 84,
            positionX: 50,
          })
        "
      >
        <option>底部居中</option>
        <option>中部居中</option>
        <option>顶部居中</option>
        <option>自定义</option>
      </select></label
    >
    <div class="fas-copy-note">
      画面中直接拖动字幕调整位置 · X {{ styleValue.positionX.toFixed(1) }}% · Y
      {{ styleValue.positionY.toFixed(1) }}%
    </div>
    <label class="fas-field"
      >重点字<input
        :value="styleValue.highlightWords"
        placeholder="用逗号分隔"
        @input="emit('patch', { highlightWords: value($event) })"
    /></label>
    <label class="fas-field"
      ><span
        ><input
          type="checkbox"
          :checked="styleValue.backgroundEnabled"
          @change="
            emit('patch', { backgroundEnabled: ($event.target as HTMLInputElement).checked })
          "
        />字幕底色</span
      ><input
        v-if="styleValue.backgroundEnabled"
        type="color"
        :value="styleValue.backgroundColor"
        @input="emit('patch', { backgroundColor: value($event) })"
    /></label>
    <div class="fas-shortcut-tip">
      <kbd>Ctrl / ⌘ + B</kbd><span>在播放头位置分割当前单选字幕</span>
    </div>
    <div class="fas-inline-actions"><button @click="emit('preset')">保存为样式预设</button></div>
  </section>
</template>
