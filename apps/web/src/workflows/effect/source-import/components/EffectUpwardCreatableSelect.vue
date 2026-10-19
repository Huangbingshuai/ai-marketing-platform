<script setup lang="ts">
import WorkflowCreatableSelect from '../../../../platform/workflow/components/WorkflowCreatableSelect.vue';
defineOptions({ inheritAttrs: false });
const props = withDefaults(
  defineProps<{
    fieldLabel: string;
    modelValue: string | number;
    options: readonly { label: string; value: string | number }[];
    disabled?: boolean;
    placeholder?: string;
    creatable?: boolean;
  }>(),
  { disabled: false, creatable: true, placeholder: '请选择或输入自定义值' },
);
</script>
<template>
  <WorkflowCreatableSelect v-bind="{ ...$attrs, ...props }" />
</template>
