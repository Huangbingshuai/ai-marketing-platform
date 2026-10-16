<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import {
  validateStoryboardSettings,
  type StoryboardWorkspace,
  type CustomizedStoryboardScript,
  type DeleteStoryboardScriptResult,
} from '@ai-marketing/contracts';
import { ApiClientError, isAbortError, isNetworkError } from '../../../api/http-client';
import { pollAsyncTask } from '../../../platform/workflow/poll-async-task';
import WorkflowPageLoading from '../../../platform/workflow/components/WorkflowPageLoading.vue';
import WorkflowExtractionFeedback from '../../../platform/workflow/components/WorkflowExtractionFeedback.vue';
import { requestActionConfirmation } from '../../../shared/composables/action-confirmation';
import CustomizedStoryboardNodePage from './CustomizedStoryboardNodePage.vue';
import {
  emptyStoryboardDraft,
  snapshotStoryboard,
  importStoryboardScript,
} from './storyboard-state';
import { storyboardApi } from './storyboard.api';
const props = defineProps<{
  projectId: string;
  workflowRunId: string;
  briefConfirmed: boolean;
  scopeReadonly: boolean;
  viewedRunId?: string | null;
}>();
const emit = defineEmits<{
  back: [];
  viewing: [runId: string | null];
  next: [runId: string];
  published: [];
  deleted: [result: DeleteStoryboardScriptResult];
}>();
const workspace = ref<StoryboardWorkspace | null>(null),
  draft = ref(emptyStoryboardDraft());
const loading = ref(true),
  deletingId = ref<string | null>(null),
  saving = ref(false),
  loadError = ref(''),
  error = ref(''),
  pollInterrupted = ref(false),
  savedMessage = ref('');
const page = ref<InstanceType<typeof CustomizedStoryboardNodePage> | null>(null);
const graphTask = computed(() => workspace.value?.task ?? null);
const currentRecord = computed(() =>
  workspace.value?.scripts.find((s) => s.id === draft.value.activeScriptId),
);
const editing = computed(() => currentRecord.value?.editing ?? false);
const sourceReady = computed(() => !!workspace.value?.sourceReady);
const readonly = computed(
  () =>
    props.scopeReadonly ||
    !sourceReady.value ||
    saving.value ||
    (!!deletingId.value && deletingId.value === currentRecord.value?.id),
);
const active = computed(() => draft.value.scripts.find((s) => s.id === draft.value.activeScriptId));
const dirty = computed(
  () =>
    !!active.value && JSON.stringify(active.value) !== JSON.stringify(currentRecord.value?.script),
);
const running = computed(
  () => !!graphTask.value && ['QUEUED', 'RUNNING'].includes(graphTask.value.status),
);
const progress = computed(() =>
  graphTask.value && running.value
    ? {
        value: graphTask.value.progress,
        summary:
          pollInterrupted.value ? '正在同步创作状态' : graphTask.value.status === 'QUEUED' ? '等待创作' : '正在创作脚本',
        terminal: false,
      }
    : undefined,
);
let controller = new AbortController(),
  pollController: AbortController | undefined,
  disposed = false,
  timer: ReturnType<typeof setTimeout> | undefined;
let writing: Promise<boolean> = Promise.resolve(true),
  settingsBaseline = '',
  conflict = false;
const removedScripts = new Set<string>();
const current = (scope: AbortController) =>
  !disposed && scope === controller && !scope.signal.aborted;
function failure(e: unknown) {
  if (isAbortError(e)) return;
  conflict = e instanceof ApiClientError && e.status === 409;
  error.value = conflict
    ? '内容已在其他窗口更新，本地修改仍保留。可导出备份，或主动重新加载最新内容。'
    : e instanceof ApiClientError && e.status < 500
      ? e.message
      : '请求暂未完成，本地修改仍保留，请重试。';
}
function apply(value: StoryboardWorkspace, initial = false) {
  value.scripts = value.scripts.filter((s) => !removedScripts.has(s.id));
  if (value.selectedScriptId && removedScripts.has(value.selectedScriptId))
    value.selectedScriptId = null;
  const local = active.value,
    wasEditing = editing.value,
    oldSettings = snapshotStoryboard(draft.value.settings),
    oldSelection = draft.value.activeScriptId;
  const oldCount = workspace.value?.scripts.filter((s) => s.confirmedRevision).length ?? 0;
  if (!initial && workspace.value) {
    value.scripts = value.scripts.map((s) => {
      const existing = workspace.value!.scripts.find((old) => old.id === s.id);
      return existing && existing.revision > s.revision ? existing : s;
    });
    if (workspace.value.settingsRevision > value.settingsRevision) {
      value.settingsRevision = workspace.value.settingsRevision;
      value.selectedScriptId = workspace.value.selectedScriptId;
    }
  }
  workspace.value = value;
  if (initial) {
    draft.value = value.legacyDraft
      ? snapshotStoryboard(value.legacyDraft)
      : emptyStoryboardDraft();
    draft.value.settings = snapshotStoryboard(value.settings);
    settingsBaseline = JSON.stringify(value.settings);
  }
  draft.value.source = value.source;
  if (!value.legacyDraft)
    draft.value.scripts = value.scripts.map((s) =>
      !initial && wasEditing && local?.id === s.id
        ? snapshotStoryboard(local)
        : snapshotStoryboard(s.script),
    );
  if (!initial) draft.value.settings = oldSettings;
  draft.value.activeScriptId =
    !initial && draft.value.scripts.some((s) => s.id === oldSelection)
      ? oldSelection
      : (value.selectedScriptId ?? draft.value.scripts[0]?.id ?? null);
  if (value.scripts.filter((s) => s.confirmedRevision).length > oldCount) {
    savedMessage.value = currentRecord.value?.confirmedRevision ? `当前脚本版本 ${currentRecord.value.confirmedRevision}` : '';
    emit('published');
  }
  if (initial && props.viewedRunId) {
    const requested = value.scripts.find((s) => s.workflowRunId === props.viewedRunId);
    if (requested) draft.value.activeScriptId = requested.id;
  }
}
async function load() {
  controller.abort();
  pollController?.abort();
  controller = new AbortController();
  const scope = controller;
  loading.value = true;
  loadError.value = '';
  error.value = '';
  pollInterrupted.value = false;
  conflict = false;
  deletingId.value = null;
  try {
    const value = await storyboardApi.workspace(props.projectId, props.workflowRunId, scope.signal);
    if (!current(scope)) return;
    apply(value, true);
    if (value.selectedScriptId !== draft.value.activeScriptId) await flush();
    savedMessage.value = currentRecord.value?.confirmedRevision
      ? `当前脚本版本 ${currentRecord.value.confirmedRevision}`
      : '尚未保存正式脚本';
    if (running.value) startPolling();
  } catch (e) {
    if (current(scope) && !isAbortError(e)) loadError.value = '分镜工作区读取失败，请重试';
  } finally {
    if (current(scope)) loading.value = false;
  }
}
function flush(): Promise<boolean> {
  clearTimeout(timer);
  const scope = controller;
  writing = writing
    .catch(() => false)
    .then(async () => {
      if (!current(scope) || !workspace.value || conflict) return false;
      try {
        if (
          JSON.stringify(draft.value.settings) !== settingsBaseline ||
          workspace.value.selectedScriptId !== draft.value.activeScriptId
        ) {
          const settings = snapshotStoryboard(draft.value.settings),
            selected = currentRecord.value ? draft.value.activeScriptId : null;
          const saved = await storyboardApi.settings(
            props.projectId,
            workspace.value.sourceRunId,
            workspace.value.settingsRevision,
            settings,
            selected,
            scope.signal,
          );
          if (!current(scope)) return false;
          workspace.value.settingsRevision = saved.revision;
          workspace.value.selectedScriptId = selected;
          settingsBaseline = JSON.stringify(settings);
        }
        const record = currentRecord.value;
        if (record?.editing && record.id !== deletingId.value && active.value && dirty.value) {
          const value = snapshotStoryboard(active.value),
            saved = await storyboardApi.edit(
              props.projectId,
              record.id,
              'draft',
              record.revision,
              value,
              scope.signal,
            );
          if (!current(scope)) return false;
          record.revision = saved.revision!;
          record.script = value;
          savedMessage.value = '编辑草稿已自动保存';
        }
        return true;
      } catch (e) {
        if (current(scope)) failure(e);
        return false;
      }
    });
  return writing;
}
async function refresh() {
  const scope = controller;
  const value = await storyboardApi.workspace(props.projectId, props.workflowRunId, scope.signal);
  if (current(scope)) apply(value);
}
function startPolling() {
  pollController?.abort();
  pollController = new AbortController();
  const polling = pollController,
    scope = controller;
  void pollAsyncTask(
    () => storyboardApi.workspace(props.projectId, props.workflowRunId, polling.signal),
    (v) => !v.task || !['QUEUED', 'RUNNING'].includes(v.task.status),
    {
      intervalMs: 1600,
      signal: polling.signal,
      retryDelayMs: (e, failures) => {
        if (!current(scope) || polling !== pollController || isAbortError(e)) return null;
        if (!isNetworkError(e) && !(e instanceof ApiClientError && (e.status >= 500 || e.status === 429))) return null;
        pollInterrupted.value = true;
        return Math.min(30000, 2000 * 2 ** Math.min(4, failures - 1));
      },
      onUpdate: (v) => {
        if (current(scope) && polling === pollController) {
          pollInterrupted.value = false;
          apply(v);
        }
      },
    },
  ).catch((e) => {
    if (current(scope) && polling === pollController && !isAbortError(e)) failure(e);
  });
}
async function generate() {
  if (running.value || editing.value || readonly.value) return;
  const problem = validateStoryboardSettings(draft.value.settings);
  if (problem) {
    error.value = problem;
    return;
  }
  if (
    draft.value.scripts.length &&
    !(await requestActionConfirmation({
      title: '新增脚本方案？',
      description: '本次将基于当前信息卡创作新方案，已有脚本及人工修改会保留。',
      confirmLabel: '开始创作',
    }))
  )
    return;
  if (!(await flush()) || !workspace.value) return;
  saving.value = true;
  const scope = controller;
  error.value = '';
  try {
    const task = await storyboardApi.start(
      props.projectId,
      workspace.value.sourceRunId,
      workspace.value.settingsRevision,
      crypto.randomUUID(),
      scope.signal,
    );
    if (current(scope)) {
      workspace.value.task = task;
      startPolling();
    }
  } catch (e) {
    if (current(scope)) failure(e);
  } finally {
    if (current(scope)) saving.value = false;
  }
}
async function retry() {
  if (!graphTask.value) return;
  const scope = controller;
  try {
    await storyboardApi.retry(props.projectId, graphTask.value.id, false, scope.signal);
    if (!current(scope)) return;
    await refresh();
    startPolling();
  } catch (e) {
    if (current(scope)) failure(e);
  }
}
async function begin() {
  if (!currentRecord.value && workspace.value?.legacyDraft && !readonly.value) {
    const copies = draft.value.scripts.map((s) => ({
        oldId: s.id,
        script: importStoryboardScript(s),
      })),
      selected = draft.value.activeScriptId;
    const scope = controller;
    try {
      for (const c of copies) {
        await storyboardApi.manual(
          props.projectId,
          props.workflowRunId,
          c.script,
          'IMPORT',
          scope.signal,
        );
        if (!current(scope)) return;
      }
      await refresh();
      draft.value.activeScriptId =
        copies.find((c) => c.oldId === selected)?.script.id ?? copies[0]?.script.id ?? null;
      await flush();
    } catch (e) {
      if (current(scope)) failure(e);
    }
    return;
  }
  if (!currentRecord.value || readonly.value || !(await flush())) return;
  const scope = controller,
    record = currentRecord.value;
  try {
    const value = await storyboardApi.edit(
      props.projectId,
      record.id,
      'begin',
      record.revision,
      undefined,
      scope.signal,
    );
    if (current(scope)) {
      record.editing = true;
      record.revision = value.revision!;
    }
  } catch (e) {
    if (current(scope)) failure(e);
  }
}
async function save() {
  if (readonly.value || !(await flush())) return false;
  if (!currentRecord.value || !active.value) return false;
  const scope = controller,
    record = currentRecord.value;
  saving.value = true;
  try {
    const result = await storyboardApi.edit(
      props.projectId,
      record.id,
      'save',
      record.revision,
      snapshotStoryboard(active.value),
      scope.signal,
    );
    if (!current(scope)) return false;
    record.editing = false;
    await refresh();
    savedMessage.value = result.unchanged ? '内容未变化，版本保持不变' : '当前脚本已保存';
    emit('published');
    return true;
  } catch (e) {
    if (current(scope)) failure(e);
    return false;
  } finally {
    if (current(scope)) saving.value = false;
  }
}
async function cancel() {
  if (
    !(await requestActionConfirmation({
      title: '取消脚本编辑？',
      description: '编辑草稿会恢复为已确认脚本，其他脚本不受影响。',
      confirmLabel: '取消编辑',
    }))
  )
    return;
  await writing;
  if (!currentRecord.value) return;
  const scope = controller,
    record = currentRecord.value;
  clearTimeout(timer);
  try {
    await storyboardApi.edit(
      props.projectId,
      record.id,
      'cancel',
      record.revision,
      undefined,
      scope.signal,
    );
    if (!current(scope)) return;
    record.editing = false;
    await refresh();
    error.value = '';
  } catch (e) {
    if (current(scope)) failure(e);
  }
}
async function create(script: CustomizedStoryboardScript, origin: 'MANUAL' | 'IMPORT') {
  if (!(await flush())) return;
  const scope = controller;
  saving.value = true;
  try {
    await storyboardApi.manual(props.projectId, props.workflowRunId, script, origin, scope.signal);
    if (!current(scope)) return;
    await refresh();
    draft.value.activeScriptId = script.id;
    await flush();
  } catch (e) {
    if (current(scope)) failure(e);
  } finally {
    if (current(scope)) saving.value = false;
  }
}
async function remove() {
  const record = currentRecord.value;
  if (!record || props.scopeReadonly || saving.value || deletingId.value) return;
  const scope = controller;
  if (
    !(await requestActionConfirmation({
      title: '永久删除此脚本？',
      description: `“${record.script.name}”及其全部子分支将永久删除，包括关联的资产、视频、草稿和历史版本。此操作无法撤销，其他脚本不受影响。`,
      confirmLabel: '永久删除',
      tone: 'danger',
    })) ||
    !current(scope) ||
    currentRecord.value?.id !== record.id
  )
    return;
  clearTimeout(timer);
  deletingId.value = record.id;
  pollController?.abort();
  // Serialize deletion behind dispatched writes; later selection/autosave waits for the refresh.
  // Unsaved changes in the deleted script need not create one final redundant draft revision.
  writing = writing
    .catch(() => false)
    .then(async () => {
      try {
        if (!current(scope) || conflict) return false;
        const latest = workspace.value?.scripts.find((s) => s.id === record.id);
        if (!latest) return false;
        const result = await storyboardApi.remove(
          props.projectId,
          record.id,
          props.workflowRunId,
          latest.revision,
          scope.signal,
        );
        if (!current(scope)) return false;
        // Stop late polling responses from reintroducing the removed selection.
        result.removedScriptIds.forEach((id) => removedScripts.add(id));
        workspace.value!.scripts = workspace.value!.scripts.filter(
          (s) => !result.removedScriptIds.includes(s.id),
        );
        draft.value.scripts = draft.value.scripts.filter(
          (s) => !result.removedScriptIds.includes(s.id),
        );
        if (draft.value.activeScriptId && removedScripts.has(draft.value.activeScriptId))
          draft.value.activeScriptId = draft.value.scripts[0]?.id ?? null;
        if (draft.value.mainCandidateId && removedScripts.has(draft.value.mainCandidateId))
          draft.value.mainCandidateId = null;
        let refreshed = true;
        if (!result.removedRunIds.includes(props.workflowRunId)) {
          try {
            await refresh();
          } catch (e) {
            if (isAbortError(e)) return true;
            refreshed = false;
            if (current(scope)) {
              conflict = true;
              error.value = '脚本及其子分支已删除，目录刷新暂未完成，请重新加载。';
            }
          }
        }
        if (!current(scope)) return true;
        if (refreshed) error.value = '';
        savedMessage.value = '脚本及其子分支已永久删除，关联文件正在后台清理';
        emit('deleted', result);
        return true;
      } catch (e) {
        if (current(scope)) failure(e);
        return false;
      } finally {
        if (current(scope)) {
          deletingId.value = null;
          if (running.value && !scope.signal.aborted) startPolling();
        }
      }
    });
  await writing;
}
async function select(id: string) {
  if (!draft.value.scripts.some((s) => s.id === id) || !(await flushPendingEdits())) return false;
  if (!draft.value.scripts.some((s) => s.id === id)) return false;
  draft.value.activeScriptId = id;
  return flush();
}
async function selectByRun(runId: string) {
  const record = workspace.value?.scripts.find((s) => s.workflowRunId === runId);
  return record ? select(record.id) : false;
}
async function flushPendingEdits() {
  if (!(await page.value?.guardEditor())) return false;
  return flush();
}
async function reload() {
  if (
    (dirty.value || conflict) &&
    !(await requestActionConfirmation({
      title: '加载最新脚本？',
      description: '这会替换本地修改，可先导出需要保留的内容。',
      confirmLabel: '加载最新内容',
    }))
  )
    return;
  await load();
}
async function back() {
  if (await flushPendingEdits()) emit('back');
}
async function nextRunId() {
  const record = currentRecord.value;
  if (
    record?.workflowRunId &&
    record.confirmedRevision &&
    !record.stale &&
    !record.editing &&
    (await flushPendingEdits())
  )
    return record.workflowRunId;
  return null;
}
async function next() {
  const runId = await nextRunId();
  if (runId) emit('next', runId);
}
watch(
  () => currentRecord.value?.workflowRunId ?? null,
  (runId) => emit('viewing', runId),
);
watch(
  () => [draft.value.settings, active.value],
  () => {
    if (loading.value || conflict) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      void flush();
    }, 700);
  },
  { deep: true },
);
watch(
  () => [props.projectId, props.workflowRunId],
  () => void load(),
  { immediate: true },
);
onBeforeUnmount(() => {
  disposed = true;
  controller.abort();
  pollController?.abort();
  clearTimeout(timer);
});
defineExpose({ flushPendingEdits, selectByRun, nextRunId });
</script>
<template>
  <WorkflowPageLoading
    v-if="loading"
    title="正在加载完整脚本…"
    description="正在读取脚本目录与已确认信息卡"
    icon="extraction"
  />
  <WorkflowExtractionFeedback
    v-else-if="loadError"
    title="脚本工作区加载失败"
    :message="loadError"
    action="重新加载"
    @action="load"
  />
  <CustomizedStoryboardNodePage
    v-else
    ref="page"
    v-model:draft="draft"
    :editing="editing"
    :source-ready="sourceReady"
    :readonly="readonly"
    :saving="saving"
    :product-name="workspace?.brief?.productName ?? ''"
    :save-message="savedMessage"
    :error="error"
    :stale="currentRecord?.stale ?? false"
    :progress="progress"
    :project-id="projectId"
    :task="graphTask"
    :brief="workspace?.brief ?? null"
    :source-revision="workspace?.source?.revision ?? null"
    :can-delete="!!currentRecord && !scopeReadonly"
    :deleting="!!deletingId"
    :next-ready="!!currentRecord?.confirmedRevision && !currentRecord?.stale"
    @begin="begin"
    @cancel="cancel"
    @save="save"
    @back="back"
    @next="next"
    @reload="reload"
    @generate="generate"
    @retry="retry()"
    @select="select"
    @create="create"
    @remove="remove"
  />
</template>
