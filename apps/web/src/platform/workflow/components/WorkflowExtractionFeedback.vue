<script setup lang="ts">
import { AlertCircle } from '@lucide/vue';
defineProps<{
  title: string;
  message: string;
  action?: string;
  disabled?: boolean;
  tone?: 'warning' | 'danger' | 'information';
}>();
defineEmits<{ action: [] }>();
</script>
<template>
  <div class="state-alert" :class="tone ?? 'danger'" role="status">
    <AlertCircle :size="17" />
    <div>
      <strong>{{ title }}</strong>
      <p>{{ message }}</p>
    </div>
    <button v-if="action" type="button" :disabled="disabled" @click="$emit('action')">
      {{ action }}
    </button>
  </div>
</template>
<style scoped>
.state-alert {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 18px;
  margin-bottom: 16px;
  border: 1px solid #ffd7ce;
  border-radius: 12px;
  background: #fff5f2;
  color: #b44b32;
}
.state-alert div {
  flex: 1;
}
.state-alert p {
  margin: 5px 0 0;
  font-size: 12px;
}
.warning {
  background: #fff8e8;
  border-color: #ffe2a5;
  color: #9a6609;
}
.information {
  background: #f5f8ff;
  border-color: #dce6ff;
  color: #446088;
}
button {
  background: #fff;
  border: 1px solid #cbd8ea;
  border-radius: 8px;
  padding: 8px 12px;
  color: #3f5f8c;
  cursor: pointer;
}
</style>
