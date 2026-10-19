<script setup lang="ts">
import { computed } from 'vue';
import { Clapperboard, Ratio, Monitor } from '@lucide/vue';
import {
  EFFECT_PROMPT_RENDER_CAPABILITIES,
  SEEDANCE_MODEL_OPTIONS,
  type CustomizedVideoRenderSettings,
} from '@ai-marketing/contracts';
import WorkflowCreatableSelect from './WorkflowCreatableSelect.vue';
const props = defineProps<{ modelValue: CustomizedVideoRenderSettings; disabled?: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: CustomizedVideoRenderSettings] }>();
const capability = computed(
  () => EFFECT_PROMPT_RENDER_CAPABILITIES[props.modelValue.capabilityKey],
);
const modelOptions = SEEDANCE_MODEL_OPTIONS.map((m) => ({ value: m.value, label: m.label }));
const ratios = computed(() =>
  capability.value.ratios.map((value) => ({
    value,
    label: value === 'adaptive' ? '自适应' : value,
  })),
);
const resolutions = computed(() =>
  capability.value.resolutions.map((value) => ({
    value,
    label: value === '4k' ? '4K' : value.toUpperCase(),
  })),
);
function update(key: keyof CustomizedVideoRenderSettings, value: string | number) {
  const next = { ...props.modelValue, [key]: value } as CustomizedVideoRenderSettings;
  if (key === 'capabilityKey') {
    const allowed = EFFECT_PROMPT_RENDER_CAPABILITIES[next.capabilityKey];
    if (!allowed.ratios.includes(next.ratio)) next.ratio = 'adaptive';
    if (!allowed.resolutions.includes(next.resolution)) next.resolution = '720p';
  }
  emit('update:modelValue', next);
}
</script>
<template>
  <div class="video-render-fields">
    <label class="model"
      ><span><Clapperboard :size="13" />视频模型</span
      ><WorkflowCreatableSelect
        field-label="视频模型"
        :model-value="modelValue.capabilityKey"
        :options="modelOptions"
        :creatable="false"
        :disabled="disabled"
        @update:model-value="update('capabilityKey', $event)"
    /></label>
    <label
      ><span><Ratio :size="13" />画幅</span
      ><WorkflowCreatableSelect
        field-label="画幅"
        :model-value="modelValue.ratio"
        :options="ratios"
        :creatable="false"
        :disabled="disabled"
        @update:model-value="update('ratio', $event)"
    /></label>
    <label
      ><span><Monitor :size="13" />分辨率</span
      ><WorkflowCreatableSelect
        field-label="分辨率"
        :model-value="modelValue.resolution"
        :options="resolutions"
        :creatable="false"
        :disabled="disabled"
        @update:model-value="update('resolution', $event)"
    /></label>
  </div>
</template>
<style scoped>
.video-render-fields {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 14px 10px;
}
.model {
  grid-column: 1 / -1;
}
label {
  display: grid;
  gap: 8px;
  min-width: 0;
}
label > span {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: #657e9f;
}
label > span svg {
  color: #8c9eb6;
}
.video-render-fields :deep(button) {
  min-height: 40px;
  font-size: 12px;
}
</style>
