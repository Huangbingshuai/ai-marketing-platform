<script setup lang="ts">
import { LoaderCircle, RefreshCw, Sparkles, Workflow } from '@lucide/vue';
defineProps<{ disabled?: boolean; running?: boolean; reextract?: boolean; label: string }>();
defineEmits<{ extract: []; details: [] }>();
</script>
<template>
  <button class="secondary-button" type="button" :disabled="disabled" @click="$emit('extract')">
    <LoaderCircle v-if="running" class="spin" :size="14" />
    <RefreshCw v-else-if="reextract" :size="14" />
    <Sparkles v-else :size="14" />{{ label }}
  </button>
  <button
    class="secondary-button workflow-graph-trigger"
    type="button"
    aria-haspopup="dialog"
    @click="$emit('details')"
  >
    <Workflow :size="14" />查看工作流
  </button>
</template>
<style scoped>
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
  opacity: 0.55;
  cursor: default;
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
