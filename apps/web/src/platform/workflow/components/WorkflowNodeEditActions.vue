<script setup lang="ts">
import { CheckCircle2, LoaderCircle, Pencil, X } from '@lucide/vue';
withDefaults(
  defineProps<{
    editing: boolean;
    temporary: boolean;
    disabled?: boolean;
    saveDisabled?: boolean;
    saving?: boolean;
  }>(),
  { disabled: false, saveDisabled: false, saving: false },
);
defineEmits<{ begin: []; cancel: []; save: [] }>();
</script>

<template>
  <div class="workflow-node-edit-actions">
    <button v-if="!editing" type="button" :disabled="disabled" @click="$emit('begin')">
      <Pencil :size="14" />进入编辑
    </button>
    <button
      v-else-if="temporary"
      type="button"
      :disabled="disabled || saving"
      @click="$emit('cancel')"
    >
      <X :size="14" />取消编辑
    </button>
    <button
      v-if="editing"
      class="node-heading__save-action"
      type="button"
      :aria-busy="saving"
      :disabled="disabled || saveDisabled || saving"
      @click="$emit('save')"
    >
      <LoaderCircle v-if="saving" class="spin" :size="14" /><CheckCircle2 v-else :size="14" />
      {{ saving ? '正在校验…' : '保存版本' }}
    </button>
  </div>
</template>

<style scoped>
.workflow-node-edit-actions {
  display: inline-flex;
  align-items: center;
  gap: 10px;
}
button {
  display: inline-flex;
  height: 36px;
  padding: 0 13px;
  align-items: center;
  gap: 6px;
  color: #3f5f8c;
  background: #fff;
  border: 1px solid #cbd8ea;
  border-radius: 8px;
  font-size: 10px;
  font-weight: 800;
  cursor: pointer;
  white-space: nowrap;
}
button:disabled {
  cursor: default;
  opacity: 0.55;
}
.spin {
  animation: spin 1s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
