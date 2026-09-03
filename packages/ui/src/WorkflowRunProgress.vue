<script setup lang="ts">
import { computed } from 'vue';

const props = withDefaults(
  defineProps<{
    actionLabel?: string;
    attemptLabel?: string;
    progress: number;
    summary: string;
    warning?: string;
  }>(),
  {
    actionLabel: '查看节点进度',
    attemptLabel: '',
    warning: '',
  },
);

const emit = defineEmits<{
  showDetails: [event: MouseEvent];
}>();

const normalizedProgress = computed(() => Math.min(100, Math.max(0, props.progress)));
</script>

<template>
  <section class="workflow-run-progress" aria-live="polite">
    <div
      class="workflow-run-progress__track"
      role="progressbar"
      aria-label="任务执行进度"
      aria-valuemin="0"
      aria-valuemax="100"
      :aria-valuenow="normalizedProgress"
    >
      <span :style="{ width: `${normalizedProgress}%` }" />
    </div>
    <p>
      <span>{{ summary }}</span>
      <small v-if="attemptLabel">{{ attemptLabel }}</small>
      <em v-if="warning">{{ warning }}</em>
    </p>
    <button type="button" @click="emit('showDetails', $event)">{{ actionLabel }}</button>
  </section>
</template>

<style scoped>
.workflow-run-progress {
  display: grid;
  margin: -7px 0 18px;
  padding: 11px 14px;
  grid-template-columns: minmax(120px, 1fr) auto auto;
  align-items: center;
  gap: 12px;
  color: #53647b;
  background: #f4f8ff;
  border: 1px solid #d8e5ff;
  border-radius: 12px;
  font-size: 11px;
}
.workflow-run-progress__track {
  height: 6px;
  overflow: hidden;
  background: #dbe7fa;
  border-radius: 99px;
}
.workflow-run-progress__track span {
  display: block;
  height: 100%;
  background: #2563eb;
  border-radius: inherit;
  transition: width 0.25s;
}
.workflow-run-progress p {
  display: grid;
  margin: 0;
  gap: 2px;
}
.workflow-run-progress p small {
  color: #2563eb;
  font-weight: 800;
}
.workflow-run-progress p em {
  color: #956109;
  font-size: 10px;
  font-style: normal;
}
.workflow-run-progress button {
  padding: 3px 0;
  color: #2563eb;
  background: transparent;
  border: 0;
  font: inherit;
  font-weight: 800;
  white-space: nowrap;
}
.workflow-run-progress button:hover {
  color: #1d4ed8;
}
.workflow-run-progress button:focus-visible {
  outline: 2px solid #93b4ff;
  outline-offset: 3px;
  border-radius: 4px;
}
@media (max-width: 760px) {
  .workflow-run-progress {
    grid-template-columns: 1fr;
  }
  .workflow-run-progress button {
    width: max-content;
  }
}
</style>
