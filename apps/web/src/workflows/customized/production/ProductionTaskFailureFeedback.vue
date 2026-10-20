<script setup lang="ts">
import { computed } from 'vue';
import type { ProductionTask } from '@ai-marketing/contracts';
import { safeApiErrorMessage } from '../../../api/http-client';
import WorkflowExtractionFeedback from '../../../platform/workflow/components/WorkflowExtractionFeedback.vue';
const props = defineProps<{
  task?: ProductionTask | undefined;
  disabled?: boolean;
  retrying?: boolean;
  retryError?: string | undefined;
}>();
defineEmits<{ workflow: [taskId: string]; retry: [taskId: string] }>();
const feedback = computed(() => {
  const task = props.task;
  if (!task || !['PROMPT', 'RENDER'].includes(task.operation)) return null;
  const label = task.operation === 'RENDER' ? '视频' : '提示词';
  if (task.status === 'CANCELLED')
    return {
      title: `${label}生成已取消`,
      message: `本次生成已取消，已有${label}和本地修改保留。核对后可重新生成。`,
      action: '查看取消记录',
      tone: 'information' as const,
    };
  if (!['FAILED', 'PARTIAL'].includes(task.status)) return null;
  const reason = safeApiErrorMessage(
    new Error(task.errorMessage ?? ''),
    `本次${label}未完成，已保存的内容仍然保留。`,
  );
  return {
    title: `${label}生成${task.status === 'FAILED' ? '失败' : '未完成'}`,
    message: `${reason}${/[。！？]$/u.test(reason) ? '' : '。'}请先查看具体问题并核对任务来源。`,
    action: task.status === 'FAILED' ? '查看失败详情' : '查看未完成详情',
    tone: task.status === 'FAILED' ? ('danger' as const) : ('warning' as const),
  };
});
</script>
<template>
  <div v-if="feedback && task" class="task-failure-feedback">
    <WorkflowExtractionFeedback
      :title="feedback.title"
      :message="feedback.message"
      :action="feedback.action"
      :tone="feedback.tone"
      @action="$emit('workflow', task.id)"
    />
    <div v-if="task.status === 'FAILED'" class="failure-recovery">
      <button type="button" :disabled="disabled || retrying" @click="$emit('retry', task.id)">
        {{ retrying ? '正在继续任务…' : '继续本次任务' }}
      </button>
      <small>沿原任务快照继续，未完成步骤可能产生模型费用。</small>
    </div>
    <p v-if="retryError" class="retry-error" role="alert">{{ retryError }}</p>
  </div>
</template>
<style scoped>
.failure-recovery {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 9px;
  margin: -6px 0 14px;
}
.failure-recovery button {
  padding: 7px 10px;
  border: 1px solid #cfdaec;
  border-radius: 8px;
  background: #fff;
  color: #42658e;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.failure-recovery button:disabled {
  opacity: 0.55;
  cursor: default;
}
.failure-recovery small {
  color: #7b8da5;
  font-size: 11px;
  line-height: 1.6;
}
.retry-error {
  margin: 0 0 14px;
  color: #b44b32;
  font-size: 12px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
</style>
