<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import {
  isCustomizedStoryboardDraft,
  CUSTOMIZED_BRIEF_ARTIFACT_KEY,
  type WorkingArtifact,
} from '@ai-marketing/contracts';
import { ApiClientError, isAbortError } from '../../../api/http-client';
import {
  getWorkflowNodeState,
  listWorkingArtifacts,
  putWorkflowNodeState,
} from '../../../platform/workflow/api/workflow-working.api';
import WorkflowPageLoading from '../../../platform/workflow/components/WorkflowPageLoading.vue';
import WorkflowExtractionFeedback from '../../../platform/workflow/components/WorkflowExtractionFeedback.vue';
import { requestActionConfirmation } from '../../../shared/composables/action-confirmation';
import CustomizedStoryboardNodePage from './CustomizedStoryboardNodePage.vue';
import {
  emptyStoryboardDraft,
  snapshotStoryboard,
  storyboardContentFingerprint,
} from './storyboard-state';
import { storyboardPreview } from './storyboard-preview';
import { createStoryboardDraftSaver } from './storyboard-draft-saver';
const props = defineProps<{
  projectId: string;
  workflowRunId: string;
  briefConfirmed: boolean;
  scopeReadonly: boolean;
}>();
const emit = defineEmits<{ back: [] }>();
const draft = ref(emptyStoryboardDraft()),
  previewDraft = ref(emptyStoryboardDraft());
const preview = ref(false),
  editing = ref(false),
  loading = ref(true),
  saving = ref(false),
  loadError = ref(''),
  saveError = ref(''),
  savedMessage = ref('尚无脚本草稿');
const brief = ref<WorkingArtifact | null>(null),
  page = ref<InstanceType<typeof CustomizedStoryboardNodePage> | null>(null);
let controller = new AbortController(),
  disposed = false,
  saver: ReturnType<typeof createStoryboardDraftSaver> | null = null;
const baseline = ref(emptyStoryboardDraft());
const displayDraft = computed({
  get: () => (preview.value ? previewDraft.value : draft.value),
  set: (value) => {
    if (preview.value) previewDraft.value = value;
    else draft.value = value;
  },
});
const sourceReady = computed(
  () =>
    props.briefConfirmed &&
    !!brief.value &&
    brief.value.freshness === 'CURRENT' &&
    brief.value.availability === 'AVAILABLE',
);
const readonly = computed(() => props.scopeReadonly || !sourceReady.value);
const dirty = computed(
  () => storyboardContentFingerprint(draft.value) !== storyboardContentFingerprint(baseline.value),
);
const stale = computed(
  () =>
    !!draft.value.source &&
    (draft.value.source.artifactId !== brief.value?.id ||
      draft.value.source.revision !== brief.value?.revision ||
      !sourceReady.value),
);
const productName = computed(() => {
  const payload = brief.value?.payload;
  if (!payload || typeof payload !== 'object') return '';
  const fields = 'fields' in payload ? payload.fields : payload;
  return fields &&
    typeof fields === 'object' &&
    'productName' in fields &&
    typeof fields.productName === 'string'
    ? fields.productName
    : '';
});
const current = (scope: AbortController) =>
  !disposed && controller === scope && !scope.signal.aborted;
const safeError = (e: unknown) =>
  e instanceof ApiClientError && e.status < 500 ? e.message : '暂时无法读取项目脚本，请重试';
async function load() {
  controller.abort();
  controller = new AbortController();
  const scope = controller;
  preview.value = false;
  editing.value = false;
  loading.value = true;
  loadError.value = '';
  saveError.value = '';
  saver = null;
  const projectId = props.projectId,
    runId = props.workflowRunId;
  try {
    const [state, artifacts] = await Promise.all([
      getWorkflowNodeState(projectId, runId, 'STORYBOARD', scope.signal).catch((e) => {
        if (e instanceof ApiClientError && e.status === 404) return null;
        throw e;
      }),
      listWorkingArtifacts(
        projectId,
        {
          workflowRunId: runId,
          workflow: 'CUSTOMIZED',
          space: 'CUSTOMIZED_PROJECT',
          nodeId: 'INFORMATION_EXTRACTION',
        },
        scope.signal,
      ),
    ]);
    if (!current(scope)) return;
    if (
      state &&
      (state.data.projectId !== projectId ||
        state.data.workflowRunId !== runId ||
        state.data.nodeId !== 'STORYBOARD')
    )
      throw new Error('脚本草稿作用域不匹配');
    const value = state?.data.state;
    if (value !== undefined && value !== null && !isCustomizedStoryboardDraft(value))
      throw new Error('脚本草稿格式不兼容，原内容未被覆盖');
    brief.value =
      artifacts.data.items.find(
        (a) =>
          a.artifactKey === CUSTOMIZED_BRIEF_ARTIFACT_KEY &&
          a.projectId === projectId &&
          a.workflowRunId === runId,
      ) ?? null;
    draft.value = value ? snapshotStoryboard(value) : emptyStoryboardDraft();
    baseline.value = snapshotStoryboard(draft.value);
    savedMessage.value = state ? '项目草稿已载入' : '尚无脚本草稿';
    saver = createStoryboardDraftSaver(
      {
        snapshot: () => draft.value,
        put: async (revision, value) => {
          if (!current(scope)) throw new DOMException('Aborted', 'AbortError');
          const response = await putWorkflowNodeState(
            projectId,
            runId,
            'STORYBOARD',
            { expectedRevision: revision, schemaVersion: 1, state: value },
            { signal: scope.signal },
          );
          if (!current(scope)) throw new DOMException('Aborted', 'AbortError');
          return response.data.nodeState.revision;
        },
      },
      state?.data.revision ?? null,
      draft.value,
    );
  } catch (e) {
    if (current(scope) && !isAbortError(e))
      loadError.value =
        e instanceof Error && !(e instanceof ApiClientError) ? e.message : safeError(e);
  } finally {
    if (current(scope)) loading.value = false;
  }
}
async function save() {
  if (preview.value || readonly.value || !saver) return false;
  if (!isCustomizedStoryboardDraft(draft.value)) {
    saveError.value = '请检查时长与脚本内容，目标时长需为 1–3600 秒。';
    return false;
  }
  const scope = controller;
  saving.value = true;
  saveError.value = '';
  try {
    await saver.flush();
    if (!current(scope)) return false;
    baseline.value = snapshotStoryboard(draft.value);
    savedMessage.value = '草稿已保存到当前项目';
    editing.value = false;
    return true;
  } catch (e) {
    if (current(scope) && !isAbortError(e))
      saveError.value =
        e instanceof ApiClientError && e.status === 409
          ? '草稿已在其他页面更新，当前修改仍保留。可先导出备份，再主动重新加载。'
          : '草稿保存失败，当前修改仍保留，请重试。';
    return false;
  } finally {
    if (current(scope)) saving.value = false;
  }
}
function begin() {
  if (readonly.value) return;
  editing.value = true;
  if (!draft.value.source && brief.value)
    draft.value.source = { artifactId: brief.value.id, revision: brief.value.revision };
}
async function cancel() {
  const scope = controller;
  if (preview.value) {
    preview.value = false;
    return;
  }
  if (
    dirty.value &&
    !(await requestActionConfirmation({
      title: '取消脚本编辑？',
      description: '尚未保存的修改会被放弃，已保存的草稿保留。',
      confirmLabel: '取消编辑',
    }))
  )
    return;
  if (!current(scope)) return;
  draft.value = snapshotStoryboard(baseline.value);
  editing.value = false;
  saveError.value = '';
}
async function reload() {
  const scope = controller;
  if (
    dirty.value &&
    !(await requestActionConfirmation({
      title: '重新加载脚本草稿？',
      description: '这会替换当前尚未保存的修改，请先导出需要保留的脚本。',
      confirmLabel: '重新加载',
    }))
  )
    return;
  if (!current(scope)) return;
  await load();
}
async function showPreview() {
  const scope = controller;
  if (!(await page.value?.guardEditor())) return;
  if (!current(scope)) return;
  previewDraft.value = storyboardPreview();
  preview.value = true;
}
async function flushPendingEdits() {
  const scope = controller;
  if (!(await page.value?.guardEditor())) return false;
  if (!current(scope)) return false;
  if (preview.value || !saver?.dirty()) return true;
  return save();
}
async function back() {
  if (await flushPendingEdits()) emit('back');
}
watch(
  () => [props.projectId, props.workflowRunId],
  () => {
    saving.value = false;
    brief.value = null;
    draft.value = emptyStoryboardDraft();
    void load();
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  disposed = true;
  controller.abort();
});
defineExpose({ flushPendingEdits });
</script>
<template>
  <WorkflowPageLoading
    v-if="loading"
    title="正在加载分镜脚本…"
    description="正在读取当前项目的脚本草稿与已确认信息卡"
    icon="extraction"
  /><WorkflowExtractionFeedback
    v-else-if="loadError"
    title="分镜草稿加载失败"
    :message="loadError"
    action="重新加载"
    @action="load"
  /><CustomizedStoryboardNodePage
    v-else
    ref="page"
    v-model:draft="displayDraft"
    :preview="preview"
    :editing="editing"
    :source-ready="sourceReady"
    :readonly="readonly || saving"
    :saving="saving"
    :dirty="dirty"
    :product-name="preview ? '梅里青梅酱 · 虚构示例' : productName"
    :save-message="dirty ? '有尚未保存的修改' : savedMessage"
    :error="saveError"
    :stale="stale"
    @begin="begin"
    @cancel="cancel"
    @save="save"
    @back="back"
    @preview="showPreview"
    @exit-preview="preview = false"
    @reload="reload"
  />
</template>
