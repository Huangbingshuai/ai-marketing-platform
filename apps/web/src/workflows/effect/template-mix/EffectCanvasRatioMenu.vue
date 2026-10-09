<script setup lang="ts">
import { ref } from 'vue';
import { EFFECT_CANVAS_RATIOS, effectCanvasAspect } from '@ai-marketing/contracts';
defineProps<{ value?: string | undefined; disabled: boolean; label: string }>();
const emit = defineEmits<{ change: [value: string | undefined] }>();
const open = ref(false),
  custom = ref(false),
  width = ref(16),
  height = ref(9);
const choose = (value: string | undefined) => {
  emit('change', value);
  open.value = false;
  custom.value = false;
};
</script>
<template>
  <div
    class="canvas-ratio-control"
    @keydown.esc.stop="open = false"
    @focusout="
      !($event.currentTarget as HTMLElement).contains($event.relatedTarget as Node) &&
      (open = false)
    "
  >
    <button
      type="button"
      class="ratio-trigger"
      :disabled="disabled"
      :aria-expanded="open"
      aria-haspopup="menu"
      :title="disabled ? '当前状态不可修改画幅' : '选择成片画幅'"
      @click="open = !open"
    >
      {{ label }}
    </button>
    <div v-if="open" class="ratio-menu" role="menu" aria-label="成片画幅">
      <button type="button" role="menuitemradio" :aria-checked="!value" @click="choose(undefined)">
        <b>{{ !value ? '✓' : '' }}</b
        >默认画幅
      </button>
      <button type="button" role="menuitem" @click="custom = !custom"><b />自定义</button>
      <form
        v-if="custom"
        @submit.prevent="effectCanvasAspect(`${width}:${height}`) && choose(`${width}:${height}`)"
      >
        <input v-model="width" type="number" min="1" max="8192" aria-label="自定义画幅宽" /><span
          >:</span
        >
        <input v-model="height" type="number" min="1" max="8192" aria-label="自定义画幅高" />
        <button type="submit" :disabled="!effectCanvasAspect(`${width}:${height}`)">应用</button>
      </form>
      <div class="ratio-separator" />
      <button
        v-for="ratio in EFFECT_CANVAS_RATIOS"
        :key="ratio.value"
        type="button"
        role="menuitemradio"
        :aria-checked="value === ratio.value"
        @click="choose(ratio.value)"
      >
        <b>{{ value === ratio.value ? '✓' : '' }}</b
        ><span>{{ ratio.label }}</span>
        <i :style="{ aspectRatio: String(effectCanvasAspect(ratio.value)), height: '13px' }" />
      </button>
    </div>
  </div>
</template>
<style scoped>
.canvas-ratio-control {
  position: relative;
}
.ratio-trigger {
  display: flex;
  gap: 5px;
  align-items: center;
  height: 28px;
  border: 1px solid #dce5f0;
  border-radius: 5px;
  background: white;
  color: #40506a;
  font-size: 12px;
  cursor: pointer;
}
.ratio-trigger:disabled {
  cursor: default;
}
.ratio-menu {
  position: absolute;
  bottom: 36px;
  right: 0;
  z-index: 20;
  width: 220px;
  padding: 6px;
  border: 1px solid #dce5f0;
  border-radius: 10px;
  background: #fff;
  box-shadow: 0 10px 30px #20365026;
  max-height: min(500px, 65vh);
  overflow-y: auto;
}
.ratio-menu > button {
  display: flex;
  align-items: center;
  width: 100%;
  height: 32px;
  padding: 0 10px;
  border: 0;
  background: transparent;
  color: #40506a;
  cursor: pointer;
  text-align: left;
  gap: 6px;
  font-size: 12px;
}
.ratio-menu > button:hover,
.ratio-menu > button[aria-checked='true'] {
  color: #2563eb;
  background: #edf4ff;
  border-radius: 5px;
}
.ratio-menu b {
  width: 18px;
}
.ratio-menu i {
  border: 1px solid currentColor;
  margin-left: auto;
  max-width: 32px;
}
.ratio-separator {
  height: 1px;
  background: #e5eaf1;
  margin: 5px 10px;
}
form {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 7px;
}
form input {
  width: 55px;
  border: 1px solid #dce5f0;
  height: 28px;
  border-radius: 4px;
}
form button {
  border: 1px solid #dce5f0;
  border-radius: 4px;
  color: #2563eb;
  background: white;
  padding: 4px;
}
</style>
