<script setup lang="ts">
import {
  EFFECT_IMPORT_ASPECT_RATIOS,
  EFFECT_IMPORT_DELIVERY_CHANNELS,
  EFFECT_IMPORT_LIMITS,
  type EffectVideoConfig,
} from '@ai-marketing/contracts';
import { ref, watch } from 'vue';

import { EFFECT_IMPORT_PROTOTYPE_STYLE_TONES } from '../effect-import-options';
import EffectUpwardCreatableSelect from './EffectUpwardCreatableSelect.vue';

const props = defineProps<{ config: EffectVideoConfig; disabled?: boolean }>();
const emit = defineEmits<{ 'update:config': [config: EffectVideoConfig] }>();
const disabledElementsText = ref('');

const strings = (values: readonly string[]) => values.map((value) => ({ label: value, value }));

const fields = [
  {
    key: 'aspectRatio' as const,
    label: '画幅比例',
    options: strings(EFFECT_IMPORT_ASPECT_RATIOS),
  },
  {
    key: 'styleTone' as const,
    label: '风格基调',
    options: strings(EFFECT_IMPORT_PROTOTYPE_STYLE_TONES),
  },
  {
    key: 'deliveryChannel' as const,
    label: '投放渠道',
    options: strings(EFFECT_IMPORT_DELIVERY_CHANNELS),
  },
];

const updateField = (key: keyof EffectVideoConfig, value: number | string): void => {
  let normalized = value;
  if (key === 'durationSeconds') {
    normalized = Math.min(
      EFFECT_IMPORT_LIMITS.maxDurationSeconds,
      Math.max(EFFECT_IMPORT_LIMITS.minDurationSeconds, Number(value) || 1),
    );
  }
  emit('update:config', { ...props.config, [key]: normalized });
};

const updateDisabledElements = (): void => {
  const values = [
    ...new Set(
      disabledElementsText.value
        .split(/[、,，\n]/)
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ].slice(0, EFFECT_IMPORT_LIMITS.maxDisabledElements);
  emit('update:config', {
    ...props.config,
    disabledElements: values,
  });
};

watch(
  () => props.config.disabledElements,
  (values) => {
    disabledElementsText.value = values.join('、');
  },
  { immediate: true },
);
</script>

<template>
  <aside class="global-config-card" aria-label="全局视频配置">
    <header class="global-config-card__head">
      <div>
        <h3>全局视频配置</h3>
        <p>该配置将贯穿后续生成、渲染与混剪</p>
      </div>
      <em>默认 9:16 竖版</em>
    </header>
    <div class="global-config-grid">
      <label>
        <span>视频时长</span>
        <div class="duration-input">
          <input
            :value="config.durationSeconds"
            type="number"
            :min="EFFECT_IMPORT_LIMITS.minDurationSeconds"
            :max="EFFECT_IMPORT_LIMITS.maxDurationSeconds"
            :disabled="disabled"
            @change="updateField('durationSeconds', ($event.target as HTMLInputElement).value)"
          />
          <small>秒</small>
        </div>
      </label>
      <label v-for="field in fields" :key="field.key">
        <span>{{ field.label }}</span>
        <EffectUpwardCreatableSelect
          :field-label="field.label"
          :model-value="config[field.key]"
          :options="field.options"
          :disabled="disabled"
          @update:model-value="updateField(field.key, $event)"
        />
      </label>
      <label class="disabled-elements">
        <span>禁用元素</span>
        <input
          v-model="disabledElementsText"
          type="text"
          placeholder="未成年人、绝对化用语、医疗功效"
          :disabled="disabled"
          @blur="updateDisabledElements"
          @keydown.enter.prevent="updateDisabledElements"
        />
      </label>
    </div>
  </aside>
</template>

<style scoped>
.global-config-card {
  padding: 20px;
  align-self: start;
  background: #fff;
  border: 1px solid #f0e3dc;
  border-radius: 20px;
  box-shadow: 0 8px 25px #7a4e3b0c;
}
.global-config-card__head {
  display: flex;
  align-items: flex-start;
}
.global-config-card__head h3,
.global-config-card__head p {
  margin: 0;
}
.global-config-card__head h3 {
  color: #263247;
  font-size: 15px;
}
.global-config-card__head p {
  margin-top: 3px;
  color: #8994a7;
  font-size: 11px;
}
.global-config-card__head em {
  margin-left: auto;
  padding: 4px 8px;
  color: #a75f12;
  background: #fff3dd;
  border-radius: 999px;
  font-size: 10px;
  font-style: normal;
  font-weight: 800;
}
.global-config-grid {
  display: grid;
  margin-top: 18px;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px 12px;
}
.global-config-grid > label > span {
  display: block;
  margin-bottom: 6px;
  color: #59667a;
  font-size: 11px;
  font-weight: 800;
}
.duration-input {
  display: flex;
  height: 42px;
  align-items: center;
  gap: 8px;
}
.duration-input input {
  width: 150px;
  height: 42px;
  padding: 0 12px;
  box-sizing: border-box;
  color: #263247;
  background: #fff;
  border: 1px solid #d7dfeb;
  border-radius: 10px;
  outline: 0;
  font-size: 13px;
}
.duration-input small {
  color: #7f8ca0;
  font-size: 11px;
}
.duration-input input:focus,
.disabled-elements input:focus {
  border-color: #7da7ef;
  box-shadow: 0 0 0 3px #2563eb0d;
}
.disabled-elements {
  grid-column: 1;
}
.disabled-elements input {
  width: 100%;
  height: 42px;
  padding: 0 10px;
  box-sizing: border-box;
  color: #263247;
  background: #fff;
  border: 1px solid #d7dfeb;
  border-radius: 10px;
  outline: 0;
  font-size: 12px;
}
button:disabled,
input:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}
@media (max-width: 540px) {
  .global-config-grid {
    grid-template-columns: 1fr;
  }
}
</style>
