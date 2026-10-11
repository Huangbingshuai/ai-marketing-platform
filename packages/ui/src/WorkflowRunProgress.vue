<script setup lang="ts">
import { computed } from 'vue';

const props = withDefaults(
  defineProps<{
    actionLabel?: string;
    attemptLabel?: string;
    progress: number;
    summary: string;
    terminal?: boolean;
    tone?: 'default' | 'update';
    warning?: string;
  }>(),
  {
    actionLabel: '查看节点进度',
    attemptLabel: '',
    tone: 'default',
    terminal: false,
    warning: '',
  },
);

const emit = defineEmits<{
  showDetails: [event: MouseEvent];
}>();

const normalizedProgress = computed(() => Math.min(100, Math.max(0, props.progress)));
</script>

<template>
  <section
    class="workflow-run-progress"
    :class="{ 'without-action': !actionLabel, 'is-update': tone === 'update', 'is-terminal': terminal }"
    aria-live="polite"
  >
    <div
      v-if="!terminal"
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
      <span class="workflow-run-progress__summary">
        <span>{{ summary }}</span>
        <strong v-if="!terminal">{{ normalizedProgress }}%</strong>
      </span>
      <small v-if="attemptLabel">{{ attemptLabel }}</small>
      <em v-if="warning">{{ warning }}</em>
    </p>
    <button v-if="actionLabel" type="button" @click="emit('showDetails', $event)">
      {{ actionLabel }}
    </button>
  </section>
</template>

<style scoped>
.workflow-run-progress {
  --progress-accent: #2563eb;
  --progress-fill: #2563eb;
  --progress-track: #dbe7fa;
  --progress-surface: #f4f8ff;
  --progress-border: #d8e5ff;
  --progress-hover: #1d4ed8;
  --progress-focus: #93b4ff;
  display: grid;
  margin: -7px 0 18px;
  padding: 11px 14px;
  grid-template-columns: minmax(120px, 1fr) auto auto;
  align-items: center;
  gap: 12px;
  color: #53647b;
  background: var(--progress-surface);
  border: 1px solid var(--progress-border);
  border-radius: 12px;
  font-size: 11px;
}
.workflow-run-progress.is-update {
  --progress-accent: #a65f00;
  --progress-fill: #f59e0b;
  --progress-track: #fde7b0;
  --progress-surface: #fff9ed;
  --progress-border: #f6d18a;
  --progress-hover: #854d0e;
  --progress-focus: #fbbf24;
  color: var(--progress-accent);
}
.workflow-run-progress__track {
  height: 6px;
  overflow: hidden;
  background: var(--progress-track);
  border-radius: 99px;
}
.workflow-run-progress.without-action {
  grid-template-columns: minmax(120px, 1fr) auto;
}
.workflow-run-progress.is-terminal {
  grid-template-columns: minmax(0, 1fr) auto;
}
.workflow-run-progress.is-terminal.without-action {
  grid-template-columns: minmax(0, 1fr);
}
.workflow-run-progress__track span {
  display: block;
  height: 100%;
  background: var(--progress-fill);
  border-radius: inherit;
  transition: width 0.25s;
}
.workflow-run-progress p {
  display: grid;
  margin: 0;
  gap: 2px;
}
.workflow-run-progress__summary {
  display: flex;
  align-items: center;
  gap: 8px;
}
.workflow-run-progress__summary strong {
  color: var(--progress-accent);
  font-size: 12px;
  font-weight: 800;
  white-space: nowrap;
}
.workflow-run-progress p small {
  color: var(--progress-accent);
  font-weight: 800;
}
.workflow-run-progress p em {
  color: #956109;
  font-size: 10px;
  font-style: normal;
}
.workflow-run-progress button {
  padding: 3px 0;
  color: var(--progress-accent);
  background: transparent;
  border: 0;
  font: inherit;
  font-weight: 800;
  white-space: nowrap;
}
.workflow-run-progress button:hover {
  color: var(--progress-hover);
}
.workflow-run-progress button:focus-visible {
  outline: 2px solid var(--progress-focus);
  outline-offset: 3px;
  border-radius: 4px;
}
@media (max-width: 760px) {
  .workflow-run-progress,
  .workflow-run-progress.is-terminal,
  .workflow-run-progress.is-terminal.without-action,
  .workflow-run-progress.without-action {
    grid-template-columns: 1fr;
  }
  .workflow-run-progress button {
    width: max-content;
  }
}
</style>
