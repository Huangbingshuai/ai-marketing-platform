<script setup lang="ts">
import type { EffectVideoTransform } from '@ai-marketing/contracts';
defineProps<{
  transform: EffectVideoTransform;
  width: number;
  height: number;
  disabled: boolean;
  count: number;
}>();
const emit = defineEmits<{
  change: [patch: Partial<EffectVideoTransform>];
  align: [mode: string];
  reset: [];
  begin: [];
  end: [];
}>();
const change = (key: keyof EffectVideoTransform, event: Event, factor = 1) => {
  const value = Number((event.target as HTMLInputElement).value) / factor;
  if (Number.isFinite(value)) emit('change', { [key]: value });
};
const alignments = [
  ['LEFT', '左对齐', 'M4 3v18M8 7h12M8 17h7'],
  ['CENTER_X', '水平居中', 'M12 3v18M4 7h16M7 17h10'],
  ['RIGHT', '右对齐', 'M20 3v18M4 7h12M9 17h7'],
  ['TOP', '顶对齐', 'M3 4h18M7 8v12M17 8v7'],
  ['CENTER_Y', '垂直居中', 'M3 12h18M7 4v16M17 7v10'],
  ['BOTTOM', '底对齐', 'M3 20h18M7 4v12M17 9v7'],
  ['DISTRIBUTE_X', '水平等距分布', 'M4 3v18M20 3v18M9 7v10M15 7v10'],
  ['DISTRIBUTE_Y', '垂直等距分布', 'M3 4h18M3 20h18M7 9h10M7 15h10'],
];
</script>
<template>
  <div class="video-transform-toolbar" role="group" aria-label="视频素材变换">
    <label class="scale-control"
      >缩放
      <input
        type="range"
        min="10"
        max="500"
        step="1"
        :value="transform.scaleX * 100"
        :disabled="disabled"
        aria-label="素材缩放"
        @pointerdown="emit('begin')"
        @input="change('scaleX', $event, 100)"
        @change="emit('end')"
        @pointercancel="emit('end')"
        @pointerup="emit('end')"
      />
      <input
        type="number"
        min="10"
        max="500"
        step="1"
        :value="Math.round(transform.scaleX * 100)"
        :disabled="disabled"
        aria-label="素材缩放百分比"
        @change="change('scaleX', $event, 100)"
      /><span>%</span>
    </label>
    <button
      type="button"
      role="switch"
      :aria-checked="transform.uniform"
      :disabled="disabled"
      class="uniform-toggle"
      :class="{ active: transform.uniform }"
      @click="emit('change', { uniform: !transform.uniform })"
    >
      <i />等比缩放
    </button>
    <label v-if="!transform.uniform"
      >纵向
      <input
        type="number"
        min="10"
        max="500"
        :value="Math.round(transform.scaleY * 100)"
        :disabled="disabled"
        aria-label="纵向缩放百分比"
        @change="change('scaleY', $event, 100)"
      />%
    </label>
    <label
      >位置 <span>X</span
      ><input
        type="number"
        :min="-width * 2"
        :max="width * 2"
        step="1"
        :value="Math.round(transform.x * width)"
        :disabled="disabled"
        aria-label="素材 X 位置"
        @change="change('x', $event, width)"
    /></label>
    <label
      ><span>Y</span
      ><input
        type="number"
        :min="-height * 2"
        :max="height * 2"
        step="1"
        :value="Math.round(transform.y * height)"
        :disabled="disabled"
        aria-label="素材 Y 位置"
        @change="change('y', $event, height)"
    /></label>
    <label
      >旋转<input
        type="number"
        min="-180"
        max="180"
        step="1"
        :value="transform.rotation"
        :disabled="disabled"
        aria-label="素材旋转角度"
        @change="change('rotation', $event)"
      />°</label
    >
    <span class="alignment-buttons">
      <button
        v-for="[mode, label, path] in alignments"
        :key="mode"
        type="button"
        :aria-label="label"
        :title="label"
        :disabled="disabled || (mode?.startsWith('DISTRIBUTE') && count < 3)"
        @click="emit('align', mode!)"
      >
        <svg
          viewBox="0 0 24 24"
          width="18"
          height="18"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
        >
          <path :d="path" />
        </svg>
      </button>
    </span>
    <button class="reset-transform" type="button" :disabled="disabled" @click="emit('reset')">
      重置
    </button>
  </div>
</template>
<style scoped>
.video-transform-toolbar {
  display: flex;
  align-items: center;
  gap: 14px;
  min-height: 50px;
  padding: 9px 14px;
  background: #fff;
  border: 1px solid #dce5f0;
  border-radius: 9px;
  color: #516079;
  overflow-x: auto;
  flex-shrink: 0;
  white-space: nowrap;
  font-size: 12px;
}
label {
  display: flex;
  align-items: center;
  gap: 6px;
}
input[type='number'] {
  width: 65px;
  height: 30px;
  border: 1px solid #dce5f0;
  border-radius: 6px;
  padding: 0 5px;
  color: #26344d;
  background: #f8faff;
}
input[type='range'] {
  width: 95px;
  accent-color: #2563eb;
}
button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  cursor: pointer;
  color: #516079;
  border: 0;
  background: transparent;
  border-radius: 5px;
  min-height: 30px;
}
button:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}
button:hover:not(:disabled) {
  background: #edf4ff;
  color: #2563eb;
}
.uniform-toggle i {
  width: 25px;
  height: 14px;
  border-radius: 10px;
  background: #c8d1df;
  position: relative;
}
.uniform-toggle i:after {
  content: '';
  position: absolute;
  width: 10px;
  height: 10px;
  left: 2px;
  top: 2px;
  border-radius: 50%;
  background: white;
}
.uniform-toggle.active i {
  background: #2563eb;
}
.uniform-toggle.active i:after {
  left: 13px;
}
.alignment-buttons {
  display: flex;
  gap: 1px;
  border-left: 1px solid #e5eaf1;
  padding-left: 10px;
}
.alignment-buttons button {
  width: 29px;
}
.reset-transform {
  padding: 0 9px;
  border: 1px solid #dce5f0;
}
</style>
