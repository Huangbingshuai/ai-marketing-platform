<script setup lang="ts">
import { useId } from 'vue';
withDefaults(
  defineProps<{
    label: string;
    modelValue: string;
    multiline?: boolean;
    readonly?: boolean;
    placeholder?: string;
  }>(),
  { multiline: false, readonly: false, placeholder: '' },
);
defineEmits<{ 'update:modelValue': [value: string] }>();
const fieldId = useId();
</script>

<template>
  <div class="information-field">
    <div class="information-field__label">
      <label :for="fieldId">{{ label }}</label
      ><slot name="source" />
    </div>
    <textarea
      v-if="multiline"
      :id="fieldId"
      :value="modelValue"
      :readonly="readonly"
      :placeholder="placeholder"
      @input="$emit('update:modelValue', ($event.target as HTMLTextAreaElement).value)"
    />
    <input
      v-else
      :id="fieldId"
      :value="modelValue"
      :readonly="readonly"
      :placeholder="placeholder"
      @input="$emit('update:modelValue', ($event.target as HTMLInputElement).value)"
    />
    <slot />
  </div>
</template>

<style scoped>
.information-field {
  display: grid;
  gap: 8px;
  min-width: 0;
  color: #596278;
  font-size: 14px;
  font-weight: 650;
}
.information-field__label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  line-height: 22px;
}
input,
textarea {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  color: #42526a;
  background: #fff;
  border: 1px solid #dce3ec;
  border-radius: 10px;
  outline: 0;
  font: inherit;
  font-size: 14px;
  font-weight: 400;
}
input {
  height: 42px;
  padding: 0 11px;
}
textarea {
  height: 56px;
  min-height: 56px;
  padding: 5px 11px;
  line-height: 23px;
  resize: none;
}
input[readonly],
textarea[readonly] {
  color: #606266;
  background: #fff;
}
input:focus,
textarea:focus {
  border-color: #7da7ef;
  box-shadow: 0 0 0 3px #2563eb14;
}
input::placeholder,
textarea::placeholder {
  color: #a0aec0;
}
</style>
