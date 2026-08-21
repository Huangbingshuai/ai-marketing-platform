<script setup lang="ts">
import {
  EFFECT_IMPORT_ASPECT_RATIOS,
  EFFECT_IMPORT_BGM_STRATEGIES,
  EFFECT_IMPORT_DELIVERY_CHANNELS,
  EFFECT_IMPORT_DURATION_OPTIONS,
  EFFECT_IMPORT_FRAME_RATE_OPTIONS,
  EFFECT_IMPORT_RESOLUTIONS,
  EFFECT_IMPORT_STYLE_TONES,
  EFFECT_IMPORT_SUBTITLE_STRATEGIES,
  EFFECT_IMPORT_VOICEOVER_STRATEGIES,
  type EffectImportProduct,
  type EffectVideoConfig,
  type EffectVideoConfigOverride,
} from '@ai-marketing/contracts';
import { RotateCcw, SlidersHorizontal, X } from '@lucide/vue';
import { computed, ref, watch } from 'vue';

import EffectUpwardCreatableSelect from './EffectUpwardCreatableSelect.vue';

const props = defineProps<{
  globalConfig: EffectVideoConfig;
  open: boolean;
  product: EffectImportProduct | null;
  saving?: boolean;
}>();
const emit = defineEmits<{
  close: [];
  save: [value: EffectVideoConfigOverride];
}>();

const strings = (values: readonly string[]) => values.map((value) => ({ label: value, value }));
const numbers = (values: readonly number[], suffix: string) =>
  values.map((value) => ({ label: `${value}${suffix}`, value }));

const fields = [
  { key: 'aspectRatio' as const, label: '画幅', options: strings(EFFECT_IMPORT_ASPECT_RATIOS) },
  {
    key: 'durationSeconds' as const,
    label: '时长',
    options: numbers(EFFECT_IMPORT_DURATION_OPTIONS, ' 秒'),
  },
  { key: 'resolution' as const, label: '分辨率', options: strings(EFFECT_IMPORT_RESOLUTIONS) },
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
  { key: 'styleTone' as const, label: '风格基调', options: strings(EFFECT_IMPORT_STYLE_TONES) },
  {
    key: 'deliveryChannel' as const,
    label: '投放渠道',
    options: strings(EFFECT_IMPORT_DELIVERY_CHANNELS),
  },
];

const localOverride = ref<EffectVideoConfigOverride>({});
const disabledElementsText = ref('');
const enabledKeys = ref(new Set<keyof EffectVideoConfig>());

const overrideCount = computed(() => enabledKeys.value.size);

const resetLocal = (): void => {
  localOverride.value = props.product
    ? {
        ...props.product.configOverride,
        ...(props.product.configOverride.disabledElements
          ? { disabledElements: [...props.product.configOverride.disabledElements] }
          : {}),
      }
    : {};
  enabledKeys.value = new Set(Object.keys(localOverride.value) as (keyof EffectVideoConfig)[]);
  disabledElementsText.value = localOverride.value.disabledElements?.join('、') ?? '';
};

const toggleField = (key: keyof EffectVideoConfig, enabled: boolean): void => {
  const nextEnabled = new Set(enabledKeys.value);
  const next = { ...localOverride.value };
  if (enabled) {
    nextEnabled.add(key);
    if (key === 'disabledElements')
      next.disabledElements = [...props.globalConfig.disabledElements];
    else Object.assign(next, { [key]: props.globalConfig[key] });
  } else {
    nextEnabled.delete(key);
    delete next[key];
  }
  enabledKeys.value = nextEnabled;
  localOverride.value = next;
};

const setField = (key: keyof EffectVideoConfig, value: number | string): void => {
  localOverride.value = { ...localOverride.value, [key]: value };
};

const restoreAll = (): void => {
  localOverride.value = {};
  enabledKeys.value = new Set();
  disabledElementsText.value = '';
};

const save = (): void => {
  const result = { ...localOverride.value };
  if (enabledKeys.value.has('disabledElements')) {
    result.disabledElements = disabledElementsText.value
      .split(/[、,，\n]/)
      .map((value) => value.trim())
      .filter(Boolean);
  }
  emit('save', result);
};

watch(
  () => [props.open, props.product?.id],
  () => {
    if (props.open) resetLocal();
  },
);
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="override-mask" @click.self="emit('close')">
      <section
        class="override-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="override-title"
      >
        <header>
          <span><SlidersHorizontal :size="18" /></span>
          <div>
            <h2 id="override-title">单品配置覆盖</h2>
            <p>{{ product?.name || '当前产品' }} · 未勾选项继承全局配置</p>
          </div>
          <button type="button" aria-label="关闭" @click="emit('close')"><X :size="18" /></button>
        </header>
        <main>
          <div class="override-summary">
            <span>已覆盖 {{ overrideCount }} 项</span>
            <button type="button" @click="restoreAll"><RotateCcw :size="13" />全部恢复全局</button>
          </div>
          <div class="override-grid">
            <label v-for="field in fields" :key="field.key" class="override-field">
              <span class="override-field__label">
                <input
                  type="checkbox"
                  :checked="enabledKeys.has(field.key)"
                  @change="toggleField(field.key, ($event.target as HTMLInputElement).checked)"
                />
                {{ field.label }}
                <small v-if="!enabledKeys.has(field.key)"
                  >继承：{{ globalConfig[field.key] }}</small
                >
              </span>
              <EffectUpwardCreatableSelect
                :field-label="`覆盖${field.label}`"
                :disabled="!enabledKeys.has(field.key)"
                :model-value="localOverride[field.key] ?? globalConfig[field.key]"
                :options="field.options"
                @update:model-value="setField(field.key, $event)"
              />
            </label>
          </div>
          <label class="override-disabled">
            <span>
              <input
                type="checkbox"
                :checked="enabledKeys.has('disabledElements')"
                @change="
                  toggleField('disabledElements', ($event.target as HTMLInputElement).checked)
                "
              />禁用元素
              <small v-if="!enabledKeys.has('disabledElements')">继承全局</small>
            </span>
            <textarea
              v-model="disabledElementsText"
              rows="2"
              :disabled="!enabledKeys.has('disabledElements')"
              placeholder="使用逗号、顿号或换行分隔"
            />
          </label>
        </main>
        <footer>
          <span>覆盖配置只影响当前产品</span>
          <button type="button" @click="emit('close')">取消</button>
          <button class="primary" type="button" :disabled="saving" @click="save">
            {{ saving ? '保存中…' : '保存覆盖配置' }}
          </button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.override-mask {
  position: fixed;
  inset: 0;
  z-index: 1200;
  display: grid;
  padding: 22px;
  place-items: center;
  background: #17233a70;
  backdrop-filter: blur(3px);
}
.override-dialog {
  width: min(780px, 96vw);
  max-height: min(760px, 92vh);
  overflow: hidden;
  background: #fff;
  border: 1px solid #dbe4f2;
  border-radius: 20px;
  box-shadow: 0 24px 70px #0f1d3840;
}
.override-dialog > header {
  display: flex;
  min-height: 76px;
  padding: 16px 20px;
  align-items: center;
  gap: 11px;
  border-bottom: 1px solid #e2e9f3;
}
.override-dialog > header > span {
  display: grid;
  width: 38px;
  height: 38px;
  place-items: center;
  color: #2563eb;
  background: #eaf2ff;
  border-radius: 11px;
}
.override-dialog h2,
.override-dialog p {
  margin: 0;
}
.override-dialog h2 {
  color: #263247;
  font-size: 16px;
}
.override-dialog p {
  margin-top: 3px;
  color: #8490a4;
  font-size: 11px;
}
.override-dialog > header > button {
  display: grid;
  width: 34px;
  height: 34px;
  margin-left: auto;
  place-items: center;
  color: #6f7c90;
  background: #f6f8fb;
  border: 0;
  border-radius: 9px;
}
.override-dialog > main {
  max-height: calc(92vh - 142px);
  padding: 18px 20px;
  overflow: auto;
}
.override-summary {
  display: flex;
  margin-bottom: 14px;
  padding: 9px 11px;
  align-items: center;
  justify-content: space-between;
  color: #52657f;
  background: #f4f8ff;
  border: 1px solid #dbe7fb;
  border-radius: 9px;
  font-size: 11px;
}
.override-summary button {
  display: flex;
  align-items: center;
  gap: 5px;
  color: #2563eb;
  background: transparent;
  border: 0;
  font-size: 11px;
  font-weight: 800;
}
.override-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 13px 14px;
}
.override-field__label,
.override-disabled > span {
  display: flex;
  min-height: 20px;
  margin-bottom: 6px;
  align-items: center;
  gap: 6px;
  color: #526079;
  font-size: 11px;
  font-weight: 800;
}
.override-field__label small,
.override-disabled small {
  margin-left: auto;
  color: #9aa5b5;
  font-size: 9px;
  font-weight: 500;
}
.override-disabled {
  display: block;
  margin-top: 14px;
}
.override-disabled textarea {
  width: 100%;
  padding: 9px 10px;
  resize: vertical;
  color: #34445c;
  border: 1px solid #d7dfeb;
  border-radius: 8px;
  outline: 0;
  font-size: 11px;
}
.override-disabled textarea:focus {
  border-color: #7da7ef;
}
.override-dialog > footer {
  display: flex;
  min-height: 66px;
  padding: 13px 20px;
  align-items: center;
  gap: 9px;
  background: #f9fbfe;
  border-top: 1px solid #e2e9f3;
}
.override-dialog > footer span {
  margin-right: auto;
  color: #8490a4;
  font-size: 10px;
}
.override-dialog > footer button {
  height: 34px;
  padding: 0 13px;
  color: #41516a;
  background: #fff;
  border: 1px solid #d7dfeb;
  border-radius: 8px;
  font-size: 11px;
  font-weight: 800;
}
.override-dialog > footer button.primary {
  color: #fff;
  background: #2563eb;
  border-color: #2563eb;
}
@media (max-width: 620px) {
  .override-grid {
    grid-template-columns: 1fr;
  }
  .override-dialog > footer span {
    display: none;
  }
}
</style>
