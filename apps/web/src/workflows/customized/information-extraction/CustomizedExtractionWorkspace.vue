<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
import type {
  CustomizedExtractionWorkspace,
  CustomizedExtractionTask,
  ExtractionNodeDetail,
} from '@ai-marketing/contracts';
import { CUSTOMIZED_EXTRACTION_NODES } from '@ai-marketing/contracts';
import { ApiClientError, isAbortError } from '../../../api/http-client';
import { pollAsyncTask } from '../../../platform/workflow/poll-async-task';
import { requestActionConfirmation } from '../../../shared/composables/action-confirmation';
import { extractionApi } from './customized-extraction.api';
import CustomizedInfoExtractionNodePage from './CustomizedInfoExtractionNodePage.vue';
import WorkflowExtractionFeedback from '../../../platform/workflow/components/WorkflowExtractionFeedback.vue';
import {
  emptyCustomizedExtractionView,
  snapshotCustomizedFields,
  type CustomizedExtractionSource,
  type CustomizedExtractionView,
} from './customized-extraction-view';
const props = defineProps<{
  projectId: string;
  workflowRunId: string;
  sourceConfirmed: boolean;
  sources: CustomizedExtractionSource[];
}>();
const emit = defineEmits<{
  back: [];
  next: [];
  workflowRunChange: [];
  viewSource: [assetId: string, event: MouseEvent, returnFocus: HTMLElement | null];
}>();
const workspace = ref<CustomizedExtractionWorkspace | null>(null);
const view = ref(emptyCustomizedExtractionView());
const loading = ref(true),
  loadError = ref(''),
  feedback = ref('');
const selectedNode = ref<string | null>(null),
  detail = ref<ExtractionNodeDetail | null>(null),
  detailLoading = ref(false),
  detailError = ref('');
let controller = new AbortController(),
  detailController: AbortController | null = null;
let disposed = false,
  dirty = false,
  conflict = false,
  saveTimer: ReturnType<typeof setTimeout> | undefined;
let saving: Promise<boolean> | null = null,
  editGeneration = 0;
let monitorController: AbortController | null = null;
const currentScope = (current: AbortController) =>
  current === controller && !current.signal.aborted && !disposed;
const recoveryAction = ref('恢复查询');
async function recover() {
  feedback.value = '';
  await load();
}
const errorText = (e: unknown) => (e instanceof Error ? e.message : '操作未完成，请重试');
function apply(data: CustomizedExtractionWorkspace) {
  workspace.value = data;
  const task = data.task;
  view.value = {
    ...emptyCustomizedExtractionView(),
    status:
      task?.status === 'QUEUED' || task?.status === 'RUNNING'
        ? task.status
        : task?.status === 'FAILED' || task?.status === 'PARTIAL'
          ? task.status
          : data.stale
            ? 'STALE'
            : data.result
              ? 'COMPLETED'
              : 'EMPTY',
    fields: structuredClone(data.result?.fields ?? emptyCustomizedExtractionView().fields),
    issues: structuredClone(data.result?.issues ?? []),
    fieldSources: Object.fromEntries(
      Object.entries(data.result?.fieldSources ?? {}).map(([key, sources]) => [
        key,
        sources?.map((s) => s.assetId) ?? [],
      ]),
    ),
    editing: data.editing,
    temporary: data.temporary,
    committed: data.committed,
    saving: false,
    progress: task?.progress ?? 0,
    progressMessage:
      CUSTOMIZED_EXTRACTION_NODES.find((n) => n.id === task?.currentNode)?.label ??
      '等待提炼服务接单',
    error: task?.errorMessage ?? '',
  };
  dirty = false;
  conflict = false;
}
async function load(showLoading = true) {
  const current = controller;
  if (showLoading) loading.value = true;
  loadError.value = '';
  try {
    const response = await extractionApi.workspace(
      props.projectId,
      props.workflowRunId,
      current.signal,
    );
    if (!currentScope(current)) return;
    apply(response.data);
    if (['QUEUED', 'RUNNING'].includes(response.data.task?.status ?? ''))
      void monitor(response.data.task!.id, current);
  } catch (e) {
    if (!isAbortError(e) && currentScope(current)) loadError.value = errorText(e);
  } finally {
    if (current === controller && !disposed) loading.value = false;
  }
}
async function monitor(taskId: string, current: AbortController) {
  monitorController?.abort();
  const polling = new AbortController();
  monitorController = polling;
  const abort = () => polling.abort();
  current.signal.addEventListener('abort', abort, { once: true });
  try {
    await pollAsyncTask(
      async (signal) => (await extractionApi.task(props.projectId, taskId, signal)).data.task,
      (task) => !['QUEUED', 'RUNNING'].includes(task.status),
      {
        signal: polling.signal,
        onUpdate: (task) => {
          if (!currentScope(current) || polling.signal.aborted) return;
          if (workspace.value) workspace.value.task = task;
          view.value = {
            ...view.value,
            status: task.status === 'CANCELLED' ? 'EMPTY' : task.status,
            progress: task.progress,
            progressMessage:
              CUSTOMIZED_EXTRACTION_NODES.find((n) => n.id === task.currentNode)?.label ??
              '等待提炼服务接单',
            error: task.errorMessage ?? '',
          };
        },
      },
    );
    if (currentScope(current) && !polling.signal.aborted) await load(false);
  } catch (e) {
    if (!isAbortError(e) && currentScope(current) && !polling.signal.aborted) {
      recoveryAction.value = '恢复查询';
      feedback.value = '进度查询暂时中断，任务仍在后台执行。可恢复查询。';
    }
  } finally {
    current.signal.removeEventListener('abort', abort);
    if (monitorController === polling) monitorController = null;
  }
}
function update(value: CustomizedExtractionView) {
  view.value = value;
  dirty = true;
  editGeneration++;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void flush(), 1000);
}
async function flush(): Promise<boolean> {
  clearTimeout(saveTimer);
  if (saving) {
    const ok = await saving;
    return ok && dirty ? flush() : ok;
  }
  if (!dirty) return true;
  if (conflict || !workspace.value?.result) return false;
  const result = workspace.value.result,
    generation = editGeneration,
    current = controller;
  const fields = snapshotCustomizedFields(view.value.fields),
    ids = new Set(view.value.issues.map((i) => i.id));
  const resolvedIssueIds = result.issues.filter((i) => !ids.has(i.id)).map((i) => i.id);
  saving = (async () => {
    try {
      const response = await extractionApi.update(
        props.projectId,
        result.id,
        { expectedRevision: result.revision, fields, resolvedIssueIds },
        current.signal,
      );
      if (!currentScope(current)) return false;
      result.revision = response.data.revision;
      result.fields = fields;
      result.issues = result.issues.filter((i) => !resolvedIssueIds.includes(i.id));
      if (generation === editGeneration) dirty = false;
      return true;
    } catch (e) {
      if (!isAbortError(e) && currentScope(current)) {
        conflict = e instanceof ApiClientError && e.status === 409;
        recoveryAction.value = conflict ? '加载最新结果' : '重新加载';
        feedback.value = errorText(e);
      }
      return false;
    } finally {
      if (currentScope(current)) saving = null;
    }
  })();
  return saving;
}
async function beginEdit() {
  const current = controller;
  if (!(await flush()) || !currentScope(current)) return;
  view.value.saving = true;
  try {
    await extractionApi.edit(props.projectId, props.workflowRunId, false, current.signal);
    if (currentScope(current)) emit('workflowRunChange');
  } catch (e) {
    if (!isAbortError(e) && currentScope(current)) feedback.value = errorText(e);
  } finally {
    if (currentScope(current)) view.value.saving = false;
  }
}
async function cancelEdit() {
  const current = controller;
  if (
    !(await requestActionConfirmation({
      title: '取消当前编辑？',
      description: '当前编辑和提炼结果将放弃，返回原版本。',
      confirmLabel: '取消编辑',
      tone: 'warning',
    })) ||
    !currentScope(current)
  )
    return;
  clearTimeout(saveTimer);
  if (saving) await saving;
  if (!currentScope(current)) return;
  view.value.saving = true;
  try {
    await extractionApi.edit(props.projectId, props.workflowRunId, true, current.signal);
    if (currentScope(current)) {
      dirty = false;
      emit('workflowRunChange');
    }
  } catch (e) {
    if (!isAbortError(e) && currentScope(current)) feedback.value = errorText(e);
  } finally {
    if (currentScope(current)) view.value.saving = false;
  }
}
async function extract(retry = false, skipConfirm = false) {
  const current = controller;
  if (!workspace.value?.source || !(await flush())) return;
  if (
    !retry &&
    !skipConfirm &&
    workspace.value.result &&
    !(await requestActionConfirmation({
      title: '重新提炼视频创作信息？',
      description: '重新读取已确认简报。同来源保留人工修改，资料版本变化后重新提取。',
      confirmLabel: '确认重新提炼',
      tone: 'warning',
    }))
  )
    return;
  if (!currentScope(current)) return;
  feedback.value = '';
  view.value.saving = true;
  try {
    if (workspace.value.committed && !workspace.value.temporary) {
      const response = await extractionApi.edit(
        props.projectId,
        props.workflowRunId,
        false,
        current.signal,
      );
      if (!currentScope(current)) return;
      sessionStorage.setItem(
        `customized-extraction-intent:${props.projectId}`,
        response.data.workflowRunId,
      );
      emit('workflowRunChange');
      return;
    }
    const source = workspace.value.source;
    const response =
      retry && workspace.value.task
        ? await extractionApi.retry(props.projectId, workspace.value.task.id, controller.signal)
        : await extractionApi.start(
            props.projectId,
            {
              workflowRunId: props.workflowRunId,
              sourceArtifactId: source.artifactId,
              sourceRevision: source.revision,
              idempotencyKey: crypto.randomUUID(),
            },
            controller.signal,
          );
    if (!currentScope(current)) return;
    closeGraph();
    selectedNode.value = null;
    detail.value = null;
    workspace.value.task = response.data.task;
    view.value.status = 'QUEUED';
    void monitor(response.data.task.id, controller);
  } catch (e) {
    if (!isAbortError(e) && currentScope(current)) feedback.value = errorText(e);
  } finally {
    if (currentScope(current)) view.value.saving = false;
  }
}
async function save() {
  const current = controller;
  view.value.saving = true;
  try {
    if (!(await flush()) || !workspace.value?.result || !currentScope(current)) return;
    const response = await extractionApi.confirm(
      props.projectId,
      workspace.value.result.id,
      workspace.value.result.revision,
      current.signal,
    );
    if (!currentScope(current)) return;
    // First confirmation and a changed edit keep the same Run. Refresh this adapter as well
    // as the parent canvas; a props-only watcher cannot observe that publication.
    if (response.data.workflowRunId === props.workflowRunId) await load(false);
    if (currentScope(current)) emit('workflowRunChange');
  } catch (e) {
    if (!isAbortError(e) && currentScope(current)) feedback.value = errorText(e);
  } finally {
    if (currentScope(current)) view.value.saving = false;
  }
}
function closeGraph() {
  detailController?.abort();
  detailLoading.value = false;
}
async function selectNode(nodeId: string) {
  detailController?.abort();
  const current = new AbortController();
  detailController = current;
  selectedNode.value = nodeId;
  detail.value = null;
  detailError.value = '';
  if (!workspace.value?.task) return;
  detailLoading.value = true;
  try {
    const response = await extractionApi.detail(
      props.projectId,
      workspace.value.task.id,
      nodeId,
      current.signal,
    );
    if (detailController === current && !current.signal.aborted && !disposed)
      detail.value = response.data;
  } catch (e) {
    if (!isAbortError(e) && detailController === current && !current.signal.aborted && !disposed)
      detailError.value = errorText(e);
  } finally {
    if (detailController === current) detailLoading.value = false;
  }
}
watch(
  () => [props.projectId, props.workflowRunId],
  async () => {
    controller.abort();
    monitorController?.abort();
    detailController?.abort();
    controller = new AbortController();
    clearTimeout(saveTimer);
    workspace.value = null;
    view.value = emptyCustomizedExtractionView();
    dirty = false;
    conflict = false;
    saving = null;
    feedback.value = '';
    selectedNode.value = null;
    detail.value = null;
    const current = controller;
    await load();
    if (!currentScope(current)) return;
    const key = `customized-extraction-intent:${props.projectId}`;
    if (sessionStorage.getItem(key) === props.workflowRunId) {
      sessionStorage.removeItem(key);
      await extract(false, true);
    }
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  disposed = true;
  controller.abort();
  detailController?.abort();
  clearTimeout(saveTimer);
});
defineExpose({ flushPendingEdits: flush });
</script>
<template>
  <WorkflowExtractionFeedback
    v-for="warning in workspace?.sourceWarnings ?? []"
    :key="warning"
    title="资料提示"
    :message="warning"
  />
  <WorkflowExtractionFeedback
    v-if="feedback"
    title="操作提示"
    :message="feedback"
    :action="recoveryAction"
    @action="recover"
  />
  <CustomizedInfoExtractionNodePage
    :project-id="projectId"
    :workflow-run-id="workflowRunId"
    :source-confirmed="sourceConfirmed"
    :sources="sources"
    :available="true"
    :loading="loading"
    :load-error="loadError"
    :view="view"
    :task="workspace?.task ?? null"
    :selected-graph-node="selectedNode"
    :graph-detail="detail"
    :graph-loading="detailLoading"
    :graph-error="detailError"
    @update:view="update"
    @extract="extract()"
    @retry-task="extract(true)"
    @retry="load()"
    @begin-edit="beginEdit"
    @cancel-edit="cancelEdit"
    @save="save"
    @select-graph-node="selectNode"
    @close-graph="closeGraph"
    @back="
      async () => {
        const current = controller;
        if ((await flush()) && currentScope(current)) emit('back');
      }
    "
    @next="emit('next')"
    @view-source="(id, event, focus) => emit('viewSource', id, event, focus)"
  />
</template>
