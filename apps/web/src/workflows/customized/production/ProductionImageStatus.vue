<script setup lang="ts">
import { computed } from 'vue';
import { Loader2, Check, CircleAlert } from '@lucide/vue';
import { imageActivityRunning, type ImageActivity } from './production-image-activity';
const props = defineProps<{
  activity?: ImageActivity | undefined;
  submitting?: boolean | undefined;
  interrupted?: boolean | undefined;
}>();
const running = computed(() => props.submitting || imageActivityRunning(props.activity));
const label = computed(() =>
  props.submitting
    ? '正在提交'
    : props.interrupted && running.value
      ? '正在恢复连接'
      : props.activity?.state === 'QUEUED'
        ? '等待出图'
        : props.activity?.state === 'RUNNING'
          ? '正在生成图片'
          : props.activity?.state === 'SUCCEEDED'
            ? '图片已生成'
            : props.activity?.state === 'CANCELLED'
              ? '生成已停止'
              : '生成未完成',
);
</script>
<template>
  <span
    v-if="activity || submitting"
    class="image-status"
    :class="{ 'is-running': running, 'is-failed': activity?.state === 'FAILED' }"
    role="status"
    aria-live="polite"
  >
    <Loader2 v-if="running" :size="16" class="spin" aria-hidden="true" />
    <Check v-else-if="activity?.state === 'SUCCEEDED'" :size="16" aria-hidden="true" />
    <CircleAlert v-else :size="16" aria-hidden="true" />{{ label }}
  </span>
</template>
<style scoped>
.image-status {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  color: #537164;
  font-size: 12px;
  line-height: 1.5;
  white-space: nowrap;
  flex-shrink: 0;
}
.image-status.is-running {
  color: #3566ad;
}
.image-status.is-failed {
  color: #98633d;
}
.spin {
  animation: image-spin 1s linear infinite;
  flex-shrink: 0;
}
@keyframes image-spin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .spin {
    animation-duration: 2s;
  }
}
</style>
