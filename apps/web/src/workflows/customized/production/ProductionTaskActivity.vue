<script setup lang="ts">
import { computed } from 'vue';
import { Loader2 } from '@lucide/vue';
import type { ProductionTask } from '@ai-marketing/contracts';

const props = defineProps<{ task?: ProductionTask | undefined; label: string }>();
const active = computed(() => props.task && ['QUEUED', 'RUNNING'].includes(props.task.status));
const progress = computed(() => Math.max(0, Math.min(100, props.task?.progress ?? 0)));
const stage = computed(() =>
  props.task?.status === 'QUEUED'
    ? '等待执行'
    : props.task?.steps.find((step) => step.status === 'RUNNING')?.content || '正在处理',
);
</script>

<template>
  <div v-if="active" class="task-activity" :aria-label="label">
    <div class="activity-copy" role="status">
      <Loader2 :size="13" class="spin" aria-hidden="true" />
      <span>{{ stage }}</span>
      <small>{{ progress }}%</small>
    </div>
    <div
      class="activity-track"
      role="progressbar"
      :aria-label="label"
      :aria-valuenow="progress"
      :aria-valuemin="0"
      :aria-valuemax="100"
    >
      <i :style="{ width: `${progress}%` }" />
    </div>
  </div>
</template>

<style scoped>
.task-activity {
  min-width: 0;
  padding: 12px 0;
  color: #5d779e;
}
.activity-copy {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 11px;
  line-height: 1.7;
}
.activity-copy svg {
  flex-shrink: 0;
}
.activity-copy span {
  flex: 1;
  overflow-wrap: anywhere;
}
.activity-copy small {
  flex-shrink: 0;
  color: #7b90ac;
  font-size: 10px;
  font-variant-numeric: tabular-nums;
}
.activity-track {
  height: 3px;
  margin-top: 8px;
  overflow: hidden;
  border-radius: 999px;
  background: #e7edf7;
}
.activity-track i {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: #3c6fe8;
}
.spin {
  animation: activity-spin 1s linear infinite;
}
@keyframes activity-spin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .spin {
    animation: none;
  }
}
</style>
