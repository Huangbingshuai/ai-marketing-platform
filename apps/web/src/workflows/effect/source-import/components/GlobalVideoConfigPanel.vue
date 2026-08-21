<script setup lang="ts">
import {
  EFFECT_IMPORT_ASPECT_RATIOS,
  EFFECT_IMPORT_BGM_STRATEGIES,
  EFFECT_IMPORT_DELIVERY_CHANNELS,
  EFFECT_IMPORT_DURATION_OPTIONS,
  EFFECT_IMPORT_FRAME_RATE_OPTIONS,
  EFFECT_IMPORT_LIMITS,
  EFFECT_IMPORT_RESOLUTIONS,
  EFFECT_IMPORT_STYLE_TONES,
  EFFECT_IMPORT_SUBTITLE_STRATEGIES,
  EFFECT_IMPORT_VOICEOVER_STRATEGIES,
  type EffectVideoConfig,
} from '@ai-marketing/contracts';
import { Ban, X } from '@lucide/vue';
import { ref } from 'vue';

import EffectUpwardCreatableSelect from './EffectUpwardCreatableSelect.vue';

const props = defineProps<{ config: EffectVideoConfig; disabled?: boolean }>();
const emit = defineEmits<{ 'update:config': [config: EffectVideoConfig] }>();
const disabledInput = ref('');

const strings = (values: readonly string[], suffix = '') =>
  values.map((value) => ({ label: `${value}${suffix}`, value }));
const numbers = (values: readonly number[], suffix = '') =>
  values.map((value) => ({ label: `${value}${suffix}`, value }));

const fields = [
  {
    key: 'aspectRatio' as const,
    label: '画幅',
    options: strings(EFFECT_IMPORT_ASPECT_RATIOS),
  },
  {
    key: 'durationSeconds' as const,
    label: '时长',
    options: numbers(EFFECT_IMPORT_DURATION_OPTIONS, ' 秒'),
  },
  {
    key: 'resolution' as const,
    label: '分辨率',
    options: strings(EFFECT_IMPORT_RESOLUTIONS),
  },
  {
    key: 'frameRate' as const,
    label: '帧率',
    options: numbers(EFFECT_IMPORT_FRAME_RATE_OPTIONS, ' FPS'),
  },
  {
    key: 'subtitleStrategy' as const,
    label: '字幕策略',
    options: strings(EFFECT_IMPORT_SUBTITLE_STRATEGIES),
  },
  {
    key: 'voiceoverStrategy' as const,
    label: '口播策略',
    options: strings(EFFECT_IMPORT_VOICEOVER_STRATEGIES),
  },
  {
    key: 'bgmStrategy' as const,
    label: 'BGM 策略',
    options: strings(EFFECT_IMPORT_BGM_STRATEGIES),
  },
  {
    key: 'styleTone' as const,
    label: '风格基调',
    options: strings(EFFECT_IMPORT_STYLE_TONES),
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
  } else if (key === 'frameRate') {
    normalized = Math.min(
      EFFECT_IMPORT_LIMITS.maxFrameRate,
      Math.max(EFFECT_IMPORT_LIMITS.minFrameRate, Number(value) || 1),
    );
  }
  emit('update:config', { ...props.config, [key]: normalized });
};

const addDisabledElement = (): void => {
  const value = disabledInput.value.trim();
  if (!value || props.config.disabledElements.includes(value)) return;
  if (props.config.disabledElements.length >= EFFECT_IMPORT_LIMITS.maxDisabledElements) return;
  emit('update:config', {
    ...props.config,
    disabledElements: [...props.config.disabledElements, value],
  });
  disabledInput.value = '';
};

const removeDisabledElement = (value: string): void => {
  emit('update:config', {
    ...props.config,
    disabledElements: props.config.disabledElements.filter((item) => item !== value),
  });
};
</script>

<template>
  <aside class="global-config-card" aria-label="全局视频配置">
    <header class="global-config-card__head">
      <div>
        <h3>全局视频配置</h3>
        <p>统一设置画幅、时长、字幕与声音策略，单个商品可覆盖</p>
      </div>
      <em>默认应用全部商品</em>
    </header>
    <div class="global-config-grid">
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
    </div>
    <section class="disabled-elements">
      <header>
        <span><Ban :size="14" aria-hidden="true" />禁用元素</span>
        <small
          >{{ config.disabledElements.length }}/{{
            EFFECT_IMPORT_LIMITS.maxDisabledElements
          }}</small
        >
      </header>
      <div v-if="config.disabledElements.length" class="disabled-elements__tags">
        <span v-for="value in config.disabledElements" :key="value">
          {{ value }}
          <button
            type="button"
            :aria-label="`移除 ${value}`"
            :disabled="disabled"
            @click="removeDisabledElement(value)"
          >
            <X :size="11" />
          </button>
        </span>
      </div>
      <label class="disabled-elements__input">
        <input
          v-model="disabledInput"
          type="text"
          placeholder="输入禁用元素后按 Enter"
          :disabled="disabled"
          @keydown.enter.prevent="addDisabledElement"
        />
        <button
          type="button"
          :disabled="disabled || !disabledInput.trim()"
          @click="addDisabledElement"
        >
          添加
        </button>
      </label>
    </section>
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
.disabled-elements {
  margin-top: 15px;
  padding-top: 14px;
  border-top: 1px dashed #dce5f2;
}
.disabled-elements > header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: #59667a;
  font-size: 11px;
  font-weight: 800;
}
.disabled-elements > header span {
  display: flex;
  align-items: center;
  gap: 6px;
}
.disabled-elements > header small {
  color: #9aa5b5;
  font-size: 10px;
}
.disabled-elements__tags {
  display: flex;
  margin-top: 9px;
  flex-wrap: wrap;
  gap: 6px;
}
.disabled-elements__tags > span {
  display: inline-flex;
  min-height: 26px;
  padding: 4px 6px 4px 9px;
  align-items: center;
  gap: 4px;
  color: #4c5e7c;
  background: #f1f5fb;
  border: 1px solid #dce5f2;
  border-radius: 999px;
  font-size: 10px;
}
.disabled-elements__tags button {
  display: grid;
  padding: 2px;
  place-items: center;
  color: #7b8799;
  background: transparent;
  border: 0;
}
.disabled-elements__input {
  display: flex;
  margin-top: 9px;
}
.disabled-elements__input input {
  min-width: 0;
  height: 36px;
  padding: 0 10px;
  flex: 1;
  border: 1px solid #d7dfeb;
  border-right: 0;
  border-radius: 8px 0 0 8px;
  outline: 0;
  font-size: 11px;
}
.disabled-elements__input input:focus {
  border-color: #7da7ef;
}
.disabled-elements__input button {
  padding: 0 12px;
  color: #fff;
  background: #2563eb;
  border: 1px solid #2563eb;
  border-radius: 0 8px 8px 0;
  font-size: 11px;
  font-weight: 800;
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
