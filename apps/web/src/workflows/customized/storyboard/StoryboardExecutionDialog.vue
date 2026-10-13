<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import {
  Activity,
  ArrowDownToLine,
  ArrowUpFromLine,
  LoaderCircle,
  RefreshCw,
  Workflow,
} from '@lucide/vue';
import {
  CUSTOMIZED_STORYBOARD_STAGES,
  type StoryboardTask,
  type StoryboardDetail,
} from '@ai-marketing/contracts';
import WorkflowExecutionGraphDialog from '../../../platform/workflow/components/WorkflowExecutionGraphDialog.vue';
import { isAbortError } from '../../../api/http-client';
import { BaseButton } from '@ai-marketing/ui';
import { storyboardApi } from './storyboard.api';
const props = defineProps<{
  open: boolean;
  projectId: string;
  task: StoryboardTask | null;
  scriptId: string | null;
  scripts: { id: string; name: string }[];
}>();
const emit = defineEmits<{ close: []; openScript: [id: string] }>();
const selected = ref<string | null>(null),
  selectedScript = ref(''),
  detail = ref<StoryboardDetail | null>(null),
  loading = ref(false),
  error = ref(''),
  page = ref(0);
let controller: AbortController | undefined;
const storyOnly = computed(() => !props.task || props.task.outputMode === 'STORY_ONLY');
const stages = computed(() =>
  CUSTOMIZED_STORYBOARD_STAGES.filter(
    (n) => !storyOnly.value || !['ASSETS', 'SHOTS'].includes(n.id),
  ).map((n) =>
    storyOnly.value && n.id === 'REVIEW'
      ? { ...n, description: '核对事实、故事容量与叙事一致性' }
      : n,
  ),
);
const rows = computed(() => stages.value.map((n) => [n.id]));
const scriptIds = computed(() => [
  ...new Set(props.task?.steps.map((s) => s.scriptId).filter(Boolean) ?? []),
]);
const nodes = computed(() =>
  stages.value.map((n) => {
    const steps =
      props.task?.steps.filter(
        (s) =>
          s.nodeId === n.id &&
          (!selectedScript.value || !s.scriptId || s.scriptId === selectedScript.value),
      ) ?? [];
    const status = steps.some((s) => s.status === 'RUNNING')
      ? 'RUNNING'
      : steps.some((s) => s.status === 'FAILED')
        ? 'FAILED'
        : steps.length && steps.every((s) => ['SUCCEEDED', 'SKIPPED'].includes(s.status))
          ? 'SUCCEEDED'
          : 'PENDING';
    return {
      ...n,
      tone:
        status === 'RUNNING'
          ? 'running'
          : status === 'FAILED'
            ? 'danger'
            : status === 'SUCCEEDED'
              ? 'success'
              : 'pending',
      statusLabel:
        status === 'RUNNING'
          ? '执行中'
          : status === 'FAILED'
            ? '未完成'
            : status === 'SUCCEEDED'
              ? '已完成'
              : '等待执行',
    };
  }),
);
async function load(append = false) {
  controller?.abort();
  controller = new AbortController();
  const scope = controller;
  if (!append) {
    detail.value = null;
    page.value = 0;
  }
  error.value = '';
  loading.value = false;
  if (!props.open || !props.task || !selected.value) return;
  loading.value = true;
  try {
    const value = await storyboardApi.detail(
      props.projectId,
      props.task.id,
      selected.value,
      selectedScript.value,
      page.value,
      scope.signal,
    );
    if (scope !== controller || scope.signal.aborted) return;
    if (append && detail.value) {
      value.sections = value.sections.map((s, i) =>
        s.kind === 'OUTPUT'
          ? { ...s, items: [...(detail.value!.sections[i]?.items ?? []), ...s.items] }
          : s,
      );
    }
    detail.value = value;
  } catch (e) {
    if (!isAbortError(e) && scope === controller)
      error.value = '节点详情查询中断，请重试；后台任务状态不受影响。';
  } finally {
    if (scope === controller) loading.value = false;
  }
}
watch([() => props.open, () => props.projectId, () => props.task?.id, () => props.scriptId], () => {
  selectedScript.value =
    props.scriptId && scriptIds.value.includes(props.scriptId) ? props.scriptId : '';
  selected.value = null;
  controller?.abort();
  detail.value = null;
});
watch([selected, selectedScript], () => void load());
watch(
  () => props.task?.updatedAt,
  () => {
    if (props.open && selected.value && page.value === 0 && !loading.value) void load();
  },
);
onBeforeUnmount(() => controller?.abort());
</script>
<template>
  <WorkflowExecutionGraphDialog
    :open="open"
    :title="storyOnly ? '脚本创作工作流' : '分镜创作工作流'"
    :eyebrow="storyOnly ? 'SCRIPT WORKFLOW' : 'STORYBOARD WORKFLOW'"
    :description="
      storyOnly
        ? '从差异化构思到完整故事，每份方案独立审校与保存。'
        : '从完整故事到逐镜脚本，每份方案独立审校与保存。'
    "
    :rows="rows"
    :nodes="nodes"
    :selected="selected"
    :edge-count="Math.max(0, stages.length - 1)"
    :empty-message="!task ? '尚未开始 AI 创作，执行后可在此查看每个阶段的实际内容。' : undefined"
    @close="emit('close')"
    @select="selected = $event"
  >
    <template #toolbar
      ><div v-if="task" class="storyboard-graph-filter">
        <label
          >查看方案
          <select v-model="selectedScript">
            <option value="">全部方案</option>
            <option v-for="(id, index) in scriptIds" :key="id" :value="id">
              {{ scripts.find((s) => s.id === id)?.name || `创作方案 ${index + 1}` }}
            </option>
          </select></label
        >
      </div></template
    >
    <div v-if="!selected" class="node-detail-empty">
      <Workflow :size="30" /><strong>选择节点查看结果</strong>
      <p>
        {{ storyOnly ? '阅读故事、创作安排与具体审校意见。' : '阅读故事、镜头与具体审校意见。' }}
      </p>
    </div>
    <template v-else
      ><header class="node-detail-header">
        <div>
          <span>NODE DETAIL</span><strong>{{ nodes.find((n) => n.id === selected)?.label }}</strong>
        </div>
        <button type="button" aria-label="刷新当前节点详情" :disabled="loading" @click="load()">
          <RefreshCw :size="14" :class="{ spin: loading }" />
        </button>
      </header>
      <p v-if="loading && !detail" class="node-detail-message">
        <LoaderCircle :size="14" class="spin" />正在读取已保存内容…
      </p>
      <p v-if="error" class="node-detail-message error" role="alert">{{ error }}</p>
      <template v-if="detail"
        ><p class="node-summary">{{ detail.summary }}</p>
        <details
          v-for="section in detail.sections"
          :key="section.kind"
          class="node-detail-section"
          :class="`is-${section.kind.toLowerCase()}`"
          :open="section.kind !== 'EXECUTION'"
        >
          <summary class="node-detail-section__heading">
            <span class="node-detail-section__icon"
              ><ArrowDownToLine v-if="section.kind === 'INPUT'" :size="13" /><ArrowUpFromLine
                v-else-if="section.kind === 'OUTPUT'"
                :size="13" /><Activity v-else :size="13" /></span
            ><strong>{{ section.title }}</strong>
          </summary>
          <div class="node-detail-section__content">
            <section v-for="(item, i) in section.items" :key="i" class="node-result-block">
              <h3>{{ item.title }}</h3>
              <p class="storyboard-result-text">{{ item.content }}</p>
            </section>
            <p v-if="!section.items.length" class="node-detail-no-fields">尚无已保存结果</p>
          </div>
        </details>
        <BaseButton
          v-if="
            selected === 'SAVE' &&
            selectedScript &&
            task?.steps.some(
              (s) =>
                s.nodeId === 'SAVE' && s.scriptId === selectedScript && s.status === 'SUCCEEDED',
            )
          "
          type="button"
          @click="emit('openScript', selectedScript)"
        >
          打开该脚本
        </BaseButton>
        <BaseButton
          v-if="detail.hasMore"
          type="button"
          :disabled="loading"
          @click="
            page++;
            load(true);
          "
        >
          继续阅读
        </BaseButton></template
      >
      <p v-else-if="!task" class="node-detail-no-fields">尚未执行，暂无业务产物。</p>
    </template>
  </WorkflowExecutionGraphDialog>
</template>
<style scoped>
.storyboard-graph-filter {
  padding: 0 20px 12px;
  color: #61738c;
  font-size: 12px;
}
.storyboard-graph-filter select {
  padding: 8px 12px;
  margin-left: 12px;
  border: 1px solid #dbe4f6;
  border-radius: 8px;
  background: white;
}
.storyboard-result-text {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  line-height: 1.8;
  font-size: 12px;
  color: #475569;
}
</style>
