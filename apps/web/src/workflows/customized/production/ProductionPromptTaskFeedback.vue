<script setup lang="ts">
import { computed } from 'vue';
import type { ProductionTask } from '@ai-marketing/contracts';
import { safeApiErrorMessage } from '../../../api/http-client';
import WorkflowExtractionFeedback from '../../../platform/workflow/components/WorkflowExtractionFeedback.vue';
const props = defineProps<{ task?: ProductionTask | undefined }>();
defineEmits<{ workflow: [taskId: string] }>();
const feedback = computed(() => {
  const task = props.task;
  if (task?.operation !== 'PROMPT') return null;
  if (task.status === 'CANCELLED')
    return {
      title: '提示词生成已取消',
      message: '本次生成已取消，已有提示词和本地修改保留。核对后可点击「重新生成」。',
      action: '查看取消记录',
      tone: 'information' as const,
    };
  if (!['FAILED', 'PARTIAL'].includes(task.status)) return null;
  const reason = safeApiErrorMessage(
    new Error(task.errorMessage ?? ''),
    '本次提示词未完成，已保存的内容仍然保留。',
  );
  return {
    title: task.status === 'FAILED' ? '提示词生成失败' : '提示词生成未完成',
    message: `${reason}${/[。！？]$/u.test(reason) ? '' : '。'}可查看具体问题，核对后点击「重新生成」。`,
    action: task.status === 'FAILED' ? '查看失败详情' : '查看未完成详情',
    tone: task.status === 'FAILED' ? ('danger' as const) : ('warning' as const),
  };
});
</script>
<template>
  <WorkflowExtractionFeedback
    v-if="feedback && task"
    :title="feedback.title"
    :message="feedback.message"
    :action="feedback.action"
    :tone="feedback.tone"
    @action="$emit('workflow', task.id)"
  />
</template>
