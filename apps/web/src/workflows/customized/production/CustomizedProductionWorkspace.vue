<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import {
  Clapperboard,
  Plus,
  Trash2,
  ArrowUp,
  ArrowDown,
  RefreshCw,
  Sparkles,
  Save,
  SlidersHorizontal,
} from '@lucide/vue';
import { WorkflowNodeFooter, WorkflowRunProgress } from '@ai-marketing/ui';
import {
  productionStages,
  type ProductionWorkspace,
  type ProductionDocument,
  type ProductionAsset,
  type ProductionOperation,
  type CustomizedImageSettings,
} from '@ai-marketing/contracts';
import WorkflowPageLoading from '../../../platform/workflow/components/WorkflowPageLoading.vue';
import WorkflowNodeEditActions from '../../../platform/workflow/components/WorkflowNodeEditActions.vue';
import WorkflowInformationField from '../../../platform/workflow/components/WorkflowInformationField.vue';
import WorkflowInformationDialog from '../../../platform/workflow/components/WorkflowInformationDialog.vue';
import WorkflowExtractionActions from '../../../platform/workflow/components/WorkflowExtractionActions.vue';
import WorkflowExtractionFeedback from '../../../platform/workflow/components/WorkflowExtractionFeedback.vue';
import WorkflowExecutionGraphDialog from '../../../platform/workflow/components/WorkflowExecutionGraphDialog.vue';
import { requestActionConfirmation } from '../../../shared/composables/action-confirmation';
import { isAbortError } from '../../../api/http-client';
import { productionApi } from './production.api';
import ProductionAssetStudio from './ProductionAssetStudio.vue';
import ProductionReferenceLibrary from './ProductionReferenceLibrary.vue';
import ProductionShotRenderPanel from './ProductionShotRenderPanel.vue';
import ProductionShotDirectory from './ProductionShotDirectory.vue';
import ProductionRenderDialog from './ProductionRenderDialog.vue';
import ProductionAssetVisual from './ProductionAssetVisual.vue';
import { productionNodeTasks, productionWorkflowTask } from './production-workflow-selection';
const props = defineProps<{ projectId: string; workflowRunId: string; mode: 'ASSETS' | 'SHOTS' }>();
const emit = defineEmits<{ back: []; next: []; saved: []; published: [runId: string] }>();
const workspace = ref<ProductionWorkspace | null>(null),
  document = ref<ProductionDocument>({ assets: [], shots: [] });
const promptText = ref(''),
  promptBase = ref('');
const editing = ref(false);
const shotRenderPanel = ref<{ open: () => void } | null>(null);
const loading = ref(true),
  busy = ref(false),
  error = ref(''),
  pollingInterrupted = ref(false),
  notice = ref(''),
  kind = ref<ProductionAsset['kind']>('PRODUCT'),
  selectedShotId = ref(''),
  graphOpen = ref(false),
  graphNode = ref('SNAPSHOT'),
  graphTaskId = ref('');
const mergeSource = ref(''),
  mergeTarget = ref('');
const assetPreview = ref<ProductionAsset | null>(null);
const shotParamsOpen = ref(false);
const imageAssets = ref<ProductionAsset[]>([]);
const previousImageSettings = computed(
  () =>
    workspace.value?.tasks.find(
      (t) =>
        t.operation === 'IMAGE' &&
        imageAssets.value.length === 1 &&
        t.imageSettings?.assetIds.includes(imageAssets.value[0]!.id),
    )?.imageSettings,
);
const imageDialogOpen = ref(false);
const imageSubmitting = ref(false),
  imageError = ref('');
let imageSubmission = 0;
function prepareImages(assets: ProductionAsset[]) {
  if (
    busy.value ||
    running.value ||
    backgroundImage.value ||
    imageSubmitting.value ||
    !assets.length
  )
    return;
  imageError.value = '';
  imageAssets.value = assets;
  imageDialogOpen.value = true;
}
function prepareImage(asset: ProductionAsset) {
  assetPreview.value = null;
  prepareImages([asset]);
}
async function generateImages(settings: CustomizedImageSettings) {
  if (
    !workspace.value ||
    busy.value ||
    running.value ||
    backgroundImage.value ||
    imageSubmitting.value
  )
    return;
  const project = props.projectId,
    run = props.workflowRunId;
  const submission = ++imageSubmission;
  imageSubmitting.value = true;
  imageError.value = '';
  try {
    if ((dirty.value || !workspace.value.assetsConfirmed || editing.value) && !(await save(true))) {
      imageError.value = error.value || '请先保存资产定义';
      return;
    }
    if (project !== props.projectId || run !== props.workflowRunId || disposed) return;
    // save() refreshes the scope; bind this request to the refreshed current Run.
    const active = controller;
    const task = await productionApi.start(
      props.projectId,
      props.workflowRunId,
      workspace.value!.draftRevision,
      'IMAGE',
      undefined,
      active.signal,
      undefined,
      settings,
    );
    if (active !== controller || !workspace.value) return;
    workspace.value.tasks = [task, ...workspace.value.tasks];
    imageDialogOpen.value = false;
    schedule();
  } catch (e) {
    if (submission === imageSubmission && !isAbortError(e))
      imageError.value = e instanceof Error ? e.message : '图片任务创建失败';
  } finally {
    if (submission === imageSubmission) imageSubmitting.value = false;
  }
}
function updateAsset(asset: ProductionAsset) {
  if (busy.value || running.value || imageSubmitting.value) return;
  const current = document.value.assets.find((a) => a.id === asset.id);
  if (current) Object.assign(current, asset);
}
function createAsset(assetKind: ProductionAsset['kind']) {
  if (busy.value || running.value || imageSubmitting.value) return;
  kind.value = assetKind;
  editing.value = true;
  addAsset();
}
const labels: Record<ProductionAsset['kind'], string> = {
  PRODUCT: '产品',
  CHARACTER: '人物',
  SCENE: '场景',
  PROP: '道具',
};
let controller = new AbortController(),
  poll: ReturnType<typeof setTimeout> | undefined,
  autosave: ReturnType<typeof setTimeout> | undefined,
  baseline = '',
  disposed = false;
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const dirty = computed(() => JSON.stringify(document.value) !== baseline);
const assetsPending = computed(
  () =>
    workspace.value &&
    JSON.stringify(document.value.assets) !==
      JSON.stringify(workspace.value.confirmedDocument.assets),
);
const promptDirty = computed(() => promptText.value !== promptBase.value);
const tasks = computed(() => productionNodeTasks(workspace.value?.tasks ?? [], props.mode));
const running = computed(() => tasks.value.find((t) => ['RUNNING', 'QUEUED'].includes(t.status)));
// Images can also be requested from the video library. Refresh those results
// silently without borrowing asset progress or locking the video workbench.
const backgroundImage = computed(() =>
  props.mode === 'SHOTS'
    ? workspace.value?.tasks.find(
        (t) => t.operation === 'IMAGE' && ['RUNNING', 'QUEUED'].includes(t.status),
      )
    : undefined,
);
const pollingTask = computed(() => running.value ?? backgroundImage.value);
const shot = computed(
  () => document.value.shots.find((s) => s.id === selectedShotId.value) ?? document.value.shots[0],
);
const prompt = computed(() =>
  workspace.value?.prompts.find((p) => 'shotId' in p.value && p.value.shotId === shot.value?.id),
);
const graphTasks = computed(() =>
  tasks.value.filter((t) =>
    props.mode === 'ASSETS' ? t.operation === 'ASSETS' : ['SHOTS', 'PROMPT'].includes(t.operation),
  ),
);
const graphTask = computed(() =>
  props.mode === 'ASSETS'
    ? productionWorkflowTask(tasks.value, 'ASSETS', graphTaskId.value)
    : (graphTasks.value.find((t) => t.id === graphTaskId.value) ?? graphTasks.value[0]),
);
const graphStages = computed(() =>
  productionStages(
    graphTask.value?.operation ?? props.mode,
    graphTask.value?.assetWorkflowVersion ?? (graphTask.value ? undefined : 2),
  ).filter((s) => !graphTask.value || graphTask.value.steps.some((step) => step.id === s.id)),
);
const graphRows = computed(() =>
  graphTask.value?.assetWorkflowVersion === 2 || (!graphTask.value && props.mode === 'ASSETS')
    ? [
        ['SNAPSHOT'],
        ['INVENTORY'],
        ['IDENTITY'],
        ['PRODUCT', 'CHARACTER', 'SCENE', 'PROP'],
        ['IMAGE_PLAN'],
        ['REVIEW'],
        ['REPAIR'],
        ['SAVE'],
      ]
    : graphStages.value.map((s) => [s.id]),
);
const graphNodes = computed(() =>
  graphStages.value.map((n) => {
    const step = graphTask.value?.steps.find((s) => s.id === n.id),
      status = step?.status ?? 'PENDING';
    return {
      ...n,
      tone:
        status === 'SUCCEEDED'
          ? 'success'
          : status === 'RUNNING'
            ? 'running'
            : status === 'FAILED'
              ? 'danger'
              : 'pending',
      statusLabel:
        status === 'SUCCEEDED'
          ? '已完成'
          : status === 'RUNNING'
            ? '执行中'
            : status === 'FAILED'
              ? '未完成'
              : '等待执行',
    };
  }),
);
const graphDetail = computed(() => graphTask.value?.steps.find((s) => s.id === graphNode.value));
watch(graphStages, (stages) => {
  if (!stages.some((s) => s.id === graphNode.value)) graphNode.value = stages[0]?.id ?? 'SNAPSHOT';
});
const boundAssets = computed(
  () =>
    shot.value?.bindings
      .map((b) => ({ binding: b, asset: document.value.assets.find((a) => a.id === b.assetId)! }))
      .filter((b) => b.asset) ?? [],
);
async function load(quiet = false) {
  clearTimeout(autosave);
  controller.abort();
  controller = new AbortController();
  const scope = controller;
  clearTimeout(poll);
  if (!quiet) loading.value = true;
  error.value = '';
  pollingInterrupted.value = false;
  try {
    const result = await productionApi.workspace(
      props.projectId,
      props.workflowRunId,
      scope.signal,
    );
    if (scope !== controller) return;
    workspace.value = result;
    document.value = clone(result.document);
    baseline = JSON.stringify(document.value);
    // Missing confirmed output alone does not imply an edit session.
    // Restore editing only when the persisted draft differs from that output.
    editing.value =
      JSON.stringify(props.mode === 'ASSETS' ? result.document.assets : result.document.shots) !==
      JSON.stringify(
        props.mode === 'ASSETS' ? result.confirmedDocument.assets : result.confirmedDocument.shots,
      );
    if (!document.value.shots.some((s) => s.id === selectedShotId.value))
      selectedShotId.value = document.value.shots[0]?.id ?? '';
    schedule();
  } catch (e) {
    if (scope === controller && !isAbortError(e))
      error.value = e instanceof Error ? e.message : '工作区加载失败';
  } finally {
    if (scope === controller) {
      loading.value = false;
      busy.value = false;
    }
  }
}
function schedule() {
  clearTimeout(poll);
  if (!disposed && pollingTask.value) poll = setTimeout(() => void refreshTask(), 1800);
}
async function refreshTask() {
  const scope = controller,
    current = pollingTask.value;
  if (!current) return;
  try {
    const result = await productionApi.task(props.projectId, current.id, scope.signal);
    if (scope !== controller || !workspace.value) return;
    pollingInterrupted.value = false;
    workspace.value.tasks = workspace.value.tasks.map((t) => (t.id === result.id ? result : t));
    if (['RUNNING', 'QUEUED'].includes(result.status)) {
      if (result.operation === 'IMAGE' && !dirty.value && !promptDirty.value && !editing.value) {
        const refreshed = await productionApi.workspace(
          props.projectId,
          props.workflowRunId,
          scope.signal,
        );
        if (scope !== controller) return;
        // A silent image refresh must not replace edits begun during the request.
        if (dirty.value || promptDirty.value || editing.value) {
          if (workspace.value) workspace.value.tasks = refreshed.tasks;
          schedule();
          return;
        }
        workspace.value = refreshed;
        document.value = clone(refreshed.document);
        baseline = JSON.stringify(document.value);
      }
      schedule();
    } else {
      // A prompt commits independently of the shot draft. Refresh the shared
      // canvas as soon as the task settles, including when local edits remain.
      emit('saved');
      if (
        result.status === 'COMPLETED' &&
        result.publishedWorkflowRunId &&
        result.publishedWorkflowRunId !== props.workflowRunId
      ) {
        emit('published', result.publishedWorkflowRunId);
        return;
      }
      if (!dirty.value && !promptDirty.value && !editing.value) await load();
      else notice.value = '任务已结束，保存当前修改后可重新加载结果';
    }
  } catch (e) {
    if (scope === controller && !isAbortError(e)) {
      pollingInterrupted.value = running.value?.id === current.id;
      poll = setTimeout(() => void refreshTask(), 5000);
    }
  }
}
async function mergeAssets() {
  const source = document.value.assets.find((a) => a.id === mergeSource.value),
    target = document.value.assets.find((a) => a.id === mergeTarget.value);
  if (!source || !target || source.id === target.id) return;
  if (
    !(await requestActionConfirmation({
      title: `将“${source.name}”合并到“${target.name}”？`,
      description: '保留目标定义，替换当前草稿里的相关镜头绑定。保存前可取消编辑。',
      confirmLabel: '合并定义',
    }))
  )
    return;
  document.value.shots.forEach((s) => {
    const seen = new Set<string>();
    s.bindings = s.bindings
      .map((b) => ({ ...b, assetId: b.assetId === source.id ? target.id : b.assetId }))
      .filter((b) => {
        if (seen.has(b.assetId)) return false;
        seen.add(b.assetId);
        return true;
      });
  });
  document.value.assets = document.value.assets.filter((a) => a.id !== source.id);
  mergeSource.value = '';
  mergeTarget.value = '';
}
async function cancelEdit() {
  if (!workspace.value) return;
  if (
    !(await requestActionConfirmation({
      title: '取消本次编辑？',
      description: '恢复已确认内容，当前未确认修改会被丢弃。',
      confirmLabel: '取消编辑',
    }))
  )
    return;
  const section = props.mode === 'ASSETS' ? 'assets' : 'shots';
  document.value[section] = clone(workspace.value.confirmedDocument[section]) as never;
  if (props.mode === 'ASSETS') {
    // Restore affected references without discarding unrelated shot edits.
    const ids = new Set(document.value.assets.map((a) => a.id));
    document.value.shots.forEach((s) => {
      const original = workspace.value!.confirmedDocument.shots.find((v) => v.id === s.id);
      if (original) s.bindings = clone(original.bindings.filter((b) => ids.has(b.assetId)));
    });
  }
  if (await save(false)) {
    await load();
    editing.value = false;
    notice.value = '已取消编辑';
  }
}
async function save(confirm = true) {
  if (!workspace.value || busy.value || running.value) return false;
  busy.value = true;
  error.value = '';
  const scope = controller;
  try {
    const value = clone(document.value);
    const result = await productionApi.save(
      props.projectId,
      props.workflowRunId,
      workspace.value.draftRevision,
      value,
      props.mode,
      confirm,
      scope.signal,
    );
    if (scope !== controller) return false;
    workspace.value.draftRevision = result.revision;
    baseline = JSON.stringify(value);
    notice.value = confirm ? '修改已保存' : '草稿已保存';
    if (confirm) {
      await load(true);
      emit('saved');
    }
    return true;
  } catch (e) {
    if (scope === controller && !isAbortError(e))
      error.value = e instanceof Error ? e.message : '保存失败，本地修改已保留';
    return false;
  } finally {
    if (scope === controller) busy.value = false;
  }
}
async function generate(operation: ProductionOperation, shotId?: string, targetAssetId?: string) {
  if (!workspace.value || busy.value || running.value || imageSubmitting.value) return;
  if (promptDirty.value && !(await savePrompt())) return;
  if (dirty.value && !(await save())) return;
  if (
    (operation === 'ASSETS' && document.value.assets.length) ||
    (operation === 'SHOTS' && document.value.shots.length)
  ) {
    if (
      !(await requestActionConfirmation({
        title:
          operation === 'ASSETS'
            ? targetAssetId
              ? '重新整理选定资产？'
              : '重新整理资产目录？'
            : '重新生成分镜？',
        description:
          operation === 'ASSETS'
            ? targetAssetId
              ? '通过审校后更新当前资产，其他资产保持不变。'
              : '通过审校后自动保存为新的资产分支，当前版本保留。'
            : '新结果完成后保存为可编辑草稿，现有已确认内容保留到你再次保存。',
        confirmLabel: '开始生成',
      }))
    )
      return;
  }
  busy.value = true;
  error.value = '';
  const scope = controller;
  try {
    const t = await productionApi.start(
      props.projectId,
      props.workflowRunId,
      workspace.value.draftRevision,
      operation,
      shotId,
      scope.signal,
      targetAssetId,
    );
    if (scope !== controller) return;
    workspace.value.tasks = [t, ...workspace.value.tasks];
    graphTaskId.value = t.id;
    schedule();
  } catch (e) {
    if (scope === controller && !isAbortError(e))
      error.value = e instanceof Error ? e.message : '任务创建失败';
  } finally {
    if (scope === controller) busy.value = false;
  }
}
function addAsset() {
  document.value.assets.push({
    id: crypto.randomUUID(),
    kind: kind.value,
    name: `新${labels[kind.value]}`,
    description: '',
    knownFacts: '',
    designNotes: '',
    sourceText: '',
    imageRequirements: '',
  });
}
async function removeAsset(id: string) {
  if (
    !(await requestActionConfirmation({
      title: '移除这个资产定义？',
      description: '本脚本中的相关镜头绑定也会移除，其他资产保持不变。',
      confirmLabel: '移除',
      tone: 'danger',
    }))
  )
    return;
  document.value.assets = document.value.assets.filter((a) => a.id !== id);
  document.value.shots.forEach((s) => (s.bindings = s.bindings.filter((b) => b.assetId !== id)));
}
function addShot() {
  const id = crypto.randomUUID();
  document.value.shots.push({
    id,
    title: '新镜头',
    shotType: '近景',
    cameraMovement: '固定镜头',
    durationSeconds: 5,
    visual: '',
    dialogue: '',
    audio: '',
    atmosphere: '',
    bindings: [],
  });
  selectedShotId.value = id;
}
async function removeShot() {
  if (!shot.value) return;
  if (
    !(await requestActionConfirmation({
      title: '删除当前镜头？',
      description: '其他镜头及已保存的结果将保留。',
      confirmLabel: '删除镜头',
      tone: 'danger',
    }))
  )
    return;
  document.value.shots = document.value.shots.filter((s) => s.id !== shot.value?.id);
  selectedShotId.value = document.value.shots[0]?.id ?? '';
}
function moveShot(offset: number) {
  if (!shot.value) return;
  const i = document.value.shots.indexOf(shot.value),
    j = i + offset;
  if (j < 0 || j >= document.value.shots.length) return;
  const [s] = document.value.shots.splice(i, 1);
  document.value.shots.splice(j, 0, s!);
}
function toggleBinding(a: ProductionAsset) {
  if (!shot.value) return;
  const i = shot.value.bindings.findIndex((b) => b.assetId === a.id);
  if (i < 0) shot.value.bindings.push({ assetId: a.id, description: '' });
  else shot.value.bindings.splice(i, 1);
}
function editShotBinding(asset: ProductionAsset) {
  if (busy.value || running.value) return;
  editing.value = true;
  toggleBinding(asset);
}
function updateShotDuration(seconds: number) {
  if (shot.value && editing.value && !busy.value && !running.value)
    shot.value.durationSeconds = seconds;
}
async function savePrompt() {
  if (!shot.value || busy.value || running.value) return false;
  const content = promptText.value;
  const selectedId = shot.value.id;
  if (dirty.value && !(await save())) return false;
  busy.value = true;
  error.value = '';
  const scope = controller;
  try {
    await productionApi.prompt(
      props.projectId,
      props.workflowRunId,
      prompt.value?.revision ?? 0,
      {
        shotId: selectedId,
        content,
        assetIds: shot.value.bindings.map((b) => b.assetId),
      },
      scope.signal,
    );
    if (scope !== controller) return false;
    promptBase.value = promptText.value;
    await load();
    emit('saved');
    return true;
  } catch (e) {
    if (scope === controller && shot.value?.id === selectedId) promptText.value = content;
    if (!isAbortError(e))
      error.value = e instanceof Error ? e.message : '提示词保存失败，本地文字已保留';
    return false;
  } finally {
    if (scope === controller) busy.value = false;
  }
}
async function selectShot(id: string) {
  if (promptDirty.value && !(await savePrompt())) return false;
  selectedShotId.value = id;
  return true;
}
async function openShotProduction(id: string) {
  if (busy.value || running.value || !(await selectShot(id))) return;
  await nextTick();
  shotRenderPanel.value?.open();
}
async function flushPendingEdits() {
  if (promptDirty.value && !(await savePrompt())) return false;
  return !dirty.value || (await save(false));
}
watch(
  () => [shot.value?.id, prompt.value?.revision],
  () => {
    promptText.value = prompt.value?.value.content ?? '';
    promptBase.value = promptText.value;
  },
);
watch(
  () => shot.value?.id,
  () => {
    shotParamsOpen.value = false;
    assetPreview.value = null;
  },
);
function beforeUnload(e: BeforeUnloadEvent) {
  if (dirty.value || promptDirty.value) {
    e.preventDefault();
    e.returnValue = '';
  }
}
window.addEventListener('beforeunload', beforeUnload);
watch(
  document,
  () => {
    clearTimeout(autosave);
    if (loading.value || !editing.value || running.value || !dirty.value || error.value) return;
    autosave = setTimeout(() => {
      if (!disposed && !busy.value) void save(false);
    }, 900);
  },
  { deep: true },
);
watch(
  () => [props.projectId, props.workflowRunId, props.mode],
  () => {
    imageSubmission++;
    imageSubmitting.value = false;
    imageDialogOpen.value = false;
    imageError.value = '';
    assetPreview.value = null;
    shotParamsOpen.value = false;
    void load();
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  disposed = true;
  controller.abort();
  clearTimeout(poll);
  clearTimeout(autosave);
  window.removeEventListener('beforeunload', beforeUnload);
});
defineExpose({ flushPendingEdits });
</script>
<template>
  <WorkflowPageLoading
    v-if="loading"
    :title="mode === 'ASSETS' ? '正在加载资产准备…' : '正在加载视频制作…'"
    description="读取当前脚本与制作内容"
    icon="extraction"
  />
  <section v-else class="production-page">
    <header class="production-heading">
      <div>
        <span class="eyebrow">{{ mode === 'ASSETS' ? '04 / 资产准备' : '05 / 视频制作' }}</span>
        <h2>{{ mode === 'ASSETS' ? '资产准备' : '视频制作' }}</h2>
        <p>
          {{ workspace?.script.name || '请先选定完整脚本' }} ·
          {{
            mode === 'ASSETS'
              ? '统一产品、人物与空间定义，图片可以稍后准备'
              : '分镜、资产绑定与镜头提示词'
          }}
        </p>
      </div>
      <div class="actions extraction-heading__actions">
        <WorkflowNodeEditActions
          :editing="editing"
          :temporary="true"
          :disabled="busy || !!running || !workspace"
          :saving="busy"
          save-label="保存修改"
          @begin="editing = true"
          @cancel="cancelEdit"
          @save="save()"
        />
        <button v-if="mode === 'SHOTS' && editing" :disabled="busy || !!running" @click="addShot">
          <Plus :size="15" />添加镜头
        </button>
        <WorkflowExtractionActions
          :disabled="
            busy ||
            !!running ||
            !workspace?.sourceReady ||
            (mode === 'SHOTS' && !workspace?.assetsConfirmed)
          "
          :running="running?.operation === mode"
          :reextract="mode === 'ASSETS' ? !!document.assets.length : !!document.shots.length"
          :label="mode === 'ASSETS' ? 'AI 整理资产' : 'AI 生成分镜'"
          @extract="generate(mode)"
          @details="
            graphTaskId = '';
            graphNode = 'SNAPSHOT';
            graphOpen = true;
          "
        />
      </div>
    </header>
    <WorkflowExtractionFeedback
      v-if="error"
      title="操作未完成"
      :message="error"
      action="重新加载"
      @action="load"
    />
    <WorkflowExtractionFeedback
      v-if="pollingInterrupted && !error"
      tone="information"
      title="正在恢复进度查询"
      message="查询暂时中断，后台任务仍会继续；连接恢复后自动更新。"
      action="重新加载"
      @action="load"
    />
    <WorkflowExtractionFeedback
      v-if="workspace && !workspace.sourceReady"
      tone="warning"
      title="创作依据已变化"
      message="请返回脚本创作确认当前故事，再继续制作。"
    />
    <!-- 总时长沿用脚本创作及已有制作策略，不在视频制作重复设置。 -->
    <WorkflowRunProgress
      v-if="running"
      :progress="running.progress"
      :summary="
        running.operation === 'ASSETS'
          ? '正在整理资产定义'
          : running.operation === 'IMAGE'
            ? '正在生成资产图片'
            : running.operation === 'SHOTS'
              ? '正在创作连续分镜'
              : '正在生成当前镜头提示词'
      "
      :terminal="false"
      :action-label="running.operation === 'IMAGE' ? '' : '查看工作流'"
      @show-details="
        graphTaskId = running.id;
        graphOpen = true;
      "
    />
    <template v-if="workspace">
      <ProductionAssetStudio
        v-if="mode === 'ASSETS'"
        :project-id="projectId"
        :assets="document.assets"
        :shots="document.shots"
        :editing="editing"
        :locked="busy || !!running || imageSubmitting"
        @edit="editing = true"
        @update="updateAsset"
        @add="createAsset"
        @remove="removeAsset"
        @merge="mergeSource = $event"
        @regenerate="generate('ASSETS', undefined, $event)"
        @images="prepareImages"
      />
      <div v-else class="video-workspace">
        <ProductionShotDirectory
          :shots="document.shots"
          :assets="document.assets"
          :selected-id="shot?.id ?? ''"
          :locked="busy || !!running"
          @select="selectShot"
          @produce="openShotProduction"
        />
        <main v-if="shot" class="shot-editor">
          <div class="shot-composition">
            <section class="shot-description">
              <header class="inspector-heading">
                <h3>旧版片段描述</h3>
                <button
                  v-if="editing"
                  class="compact-icon"
                  :disabled="busy || !!running"
                  aria-label="编辑镜头参数"
                  title="编辑镜头参数"
                  @click="shotParamsOpen = true"
                >
                  <SlidersHorizontal :size="14" />
                </button>
              </header>
              <WorkflowInformationField
                v-model="shot.visual"
                label="画面描述"
                multiline
                :readonly="busy || !!running || !editing"
              />
              <WorkflowInformationField
                v-model="shot.atmosphere"
                label="氛围"
                multiline
                :readonly="busy || !!running || !editing"
              />
            </section>
            <ProductionReferenceLibrary
              :project-id="projectId"
              :assets="document.assets"
              :shot="shot"
              :locked="busy || !!running"
              @toggle="editShotBinding"
              @prepare="prepareImage"
              @preview="assetPreview = $event"
            />
          </div>
          <section class="prompt-section">
            <header class="inspector-heading">
              <h3>视频提示词</h3>
              <span v-if="prompt?.stale || dirty" class="prompt-stale">待更新</span>
              <div class="prompt-actions">
                <button
                  v-if="promptDirty"
                  class="compact-icon"
                  :disabled="busy || !!running || !promptText.trim()"
                  aria-label="保存提示词"
                  title="保存提示词"
                  @click="savePrompt"
                >
                  <Save :size="14" />
                </button>
                <button
                  class="compact-button"
                  :disabled="busy || !!running || !workspace.shotsConfirmed"
                  @click="generate('PROMPT', shot.id)"
                >
                  <RefreshCw v-if="prompt" :size="12" /><Sparkles v-else :size="12" />{{
                    prompt ? '重新生成' : 'AI 生成'
                  }}
                </button>
              </div>
            </header>
            <textarea
              v-model="promptText"
              aria-label="视频提示词"
              :readonly="busy || !!running"
              placeholder="输入视频提示词"
            />
          </section>
        </main>
        <main v-else class="empty">
          <Clapperboard :size="36" />
          <h3>从完整故事展开镜头</h3>
          <p>确认资产目录后，AI 会按故事时序拆镜，并为每镜绑定需要的对象。</p>
        </main>
        <ProductionShotRenderPanel
          v-if="shot"
          ref="shotRenderPanel"
          :project-id="projectId"
          :shot="shot"
          :index="document.shots.findIndex((s) => s.id === shot?.id) + 1"
          :assets="boundAssets.map((b) => b.asset)"
          :prompt="prompt?.value.content ?? ''"
          :locked="busy || !!running"
          :editing="editing"
          @duration="updateShotDuration"
          @preview="assetPreview = $event"
        />
      </div>
    </template>
    <p v-if="notice" class="notice" role="status">{{ notice }}</p>
    <WorkflowNodeFooter
      :back-label="mode === 'ASSETS' ? '上一步：脚本创作' : '上一步：资产准备'"
      next-label="下一步：视频制作"
      :show-next="mode === 'ASSETS'"
      :show-validate="false"
      :next-disabled="
        mode === 'ASSETS'
          ? !workspace?.assetsConfirmed || dirty || !!assetsPending || !!running
          : true
      "
      @back="emit('back')"
      @next="emit('next')"
    />
    <ProductionRenderDialog
      :open="imageDialogOpen"
      :project-id="projectId"
      :workflow-run-id="workflowRunId"
      :brand-references="workspace?.brandImageReferences"
      :settings="previousImageSettings"
      type="IMAGE"
      :assets="imageAssets"
      :busy="imageSubmitting"
      :error="imageError"
      @generate="generateImages"
      @close="imageDialogOpen = false"
    />
    <WorkflowInformationDialog
      :open="!!assetPreview"
      :title="assetPreview?.name || '参考图片'"
      @close="assetPreview = null"
    >
      <ProductionAssetVisual
        v-if="assetPreview"
        class="asset-preview-full"
        :asset="assetPreview"
        :project-id="projectId"
      />
    </WorkflowInformationDialog>
    <WorkflowInformationDialog
      :open="shotParamsOpen && !!shot"
      title="镜头参数"
      @close="shotParamsOpen = false"
    >
      <div v-if="shot" class="shot-parameter-fields">
        <WorkflowInformationField
          v-model="shot.title"
          label="镜头名称"
          :readonly="busy || !!running || !editing"
        />
        <div class="asset-facts">
          <WorkflowInformationField
            v-model="shot.shotType"
            label="景别"
            :readonly="busy || !!running || !editing"
          />
          <WorkflowInformationField
            v-model="shot.cameraMovement"
            label="运镜"
            :readonly="busy || !!running || !editing"
          />
        </div>
        <WorkflowInformationField
          v-model="shot.dialogue"
          label="台词与旁白"
          multiline
          :readonly="busy || !!running || !editing"
        />
        <WorkflowInformationField
          v-model="shot.audio"
          label="声音"
          multiline
          :readonly="busy || !!running || !editing"
        />
        <details v-if="shot.bindings.length">
          <summary>本镜素材呈现</summary>
          <WorkflowInformationField
            v-for="binding in shot.bindings"
            :key="binding.assetId"
            v-model="binding.description"
            :label="document.assets.find((a) => a.id === binding.assetId)?.name || '素材'"
            multiline
            :readonly="busy || !!running || !editing"
          />
        </details>
        <div class="actions">
          <button
            :disabled="busy || !!running || !editing"
            aria-label="上移镜头"
            @click="moveShot(-1)"
          >
            <ArrowUp :size="14" />上移
          </button>
          <button
            :disabled="busy || !!running || !editing"
            aria-label="下移镜头"
            @click="moveShot(1)"
          >
            <ArrowDown :size="14" />下移
          </button>
          <button
            :disabled="busy || !!running || !editing"
            aria-label="删除镜头"
            @click="removeShot"
          >
            <Trash2 :size="14" />删除
          </button>
        </div>
      </div>
    </WorkflowInformationDialog>
    <WorkflowInformationDialog
      :open="!!mergeSource"
      title="合并重复定义"
      description="选择保留的对象；相关镜头绑定随草稿更新。请先将需要保留的描述补充到目标对象。"
      @close="mergeSource = ''"
    >
      <div class="binding-picker">
        <label
          >保留对象<select v-model="mergeTarget">
            <option value="">请选择</option>
            <option
              v-for="a in document.assets.filter((a) => a.id !== mergeSource)"
              :key="a.id"
              :value="a.id"
            >
              {{ labels[a.kind] }} · {{ a.name }}
            </option>
          </select></label
        ><button :disabled="!mergeTarget" @click="mergeAssets">合并定义</button>
      </div>
    </WorkflowInformationDialog>
    <WorkflowExecutionGraphDialog
      :open="graphOpen"
      :title="mode === 'ASSETS' ? '当前资产整理工作流' : '当前制作工作流'"
      eyebrow="执行详情"
      description="查看本次任务的实际内容与审校结果"
      :rows="graphRows"
      :nodes="graphNodes"
      :selected="graphNode"
      @select="graphNode = $event"
      @close="graphOpen = false"
    >
      <article v-if="graphDetail" class="execution-content">
        <template v-if="graphDetail.detail">
          <h3>{{ graphDetail.detail.title }}</h3>
          <p v-if="graphDetail.detail.summary" class="execution-summary">
            {{ graphDetail.detail.summary }}
          </p>
          <section
            v-for="(section, index) in graphDetail.detail.sections"
            :key="index"
            class="execution-business-section"
          >
            <h4>{{ section.title }}</h4>
            <dl>
              <template v-for="(field, fieldIndex) in section.fields" :key="fieldIndex">
                <dt>{{ field.label }}</dt>
                <dd>{{ field.value }}</dd>
              </template>
            </dl>
          </section>
          <p
            v-if="!graphDetail.detail.sections.length && graphDetail.detail.emptyMessage"
            class="execution-empty"
          >
            {{ graphDetail.detail.emptyMessage }}
          </p>
        </template>
        <template v-else>
          <h3>{{ graphDetail.title }}</h3>
          <p>{{ graphDetail.content || '此步骤尚未产生内容' }}</p>
        </template>
      </article>
      <p v-else>开始整理后，可查看每一步生成的内容与核对结果。</p></WorkflowExecutionGraphDialog
    >
  </section>
</template>
<style scoped>
.execution-summary {
  color: #73829a;
  font-size: 13px;
}
.execution-business-section {
  margin-top: 22px;
  padding-top: 18px;
  border-top: 1px solid #e5ebf3;
}
.execution-business-section h4 {
  margin: 0 0 14px;
  color: #253751;
  font-size: 15px;
}
.execution-business-section dl {
  margin: 0;
}
.execution-business-section dt {
  margin-top: 14px;
  color: #75859c;
  font-size: 12px;
}
.execution-business-section dd {
  margin: 5px 0 0;
  color: #42526a;
  font-size: 13px;
  line-height: 1.8;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.execution-empty {
  color: #8190a7;
  font-size: 13px;
}
.production-page {
  padding: 26px 28px;
  color: #23344d;
  border: 1px solid #dbe4f6;
  border-radius: 24px;
  background: #fff;
}
.production-heading,
.actions,
.editor-heading {
  display: flex;
  align-items: center;
  gap: 12px;
  justify-content: space-between;
}
.production-heading {
  margin-bottom: 24px;
  flex-wrap: wrap;
}
.production-heading h2 {
  font-size: 22px;
  margin: 8px 0;
}
.production-heading p,
.eyebrow {
  font-size: 12px;
  color: #8190a7;
}
.actions {
  justify-content: flex-end;
  flex-wrap: wrap;
}
.production-page button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  min-height: 38px;
  padding: 0 14px;
  border: 1px solid #d6e1f4;
  border-radius: 10px;
  background: #fff;
  color: #3f5f8c;
  cursor: pointer;
  font: inherit;
  font-size: 12px;
}
.production-page button:disabled {
  opacity: 0.5;
  cursor: default;
}
.production-page button:focus-visible {
  outline: 2px solid #2563eb;
  outline-offset: 2px;
}
.video-workspace {
  display: grid;
  grid-template-columns: 264px minmax(0, 1fr) 310px;
  height: clamp(660px, calc(100dvh - 340px), 840px);
  margin-top: 24px;
  border: 1px solid #e1e7f1;
  border-radius: 12px;
  overflow: hidden;
  background: #fff;
}
.video-workspace :deep(.shot-task-directory) {
  border: 0;
  border-radius: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
}
.video-workspace :deep(.shot-task-list) {
  flex: 1;
  min-height: 0;
  max-height: none;
}
.shot-editor {
  display: flex;
  flex-direction: column;
  gap: 20px;
  padding: 14px 16px 16px;
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
  border-left: 1px solid #e4e9f2;
  scrollbar-width: thin;
}
.shot-composition {
  display: grid;
  grid-template-columns: minmax(0, 1.05fr) minmax(0, 1fr);
  gap: 16px;
  align-items: start;
}
.shot-description {
  display: grid;
  gap: 10px;
  min-width: 0;
}
.inspector-heading {
  display: flex;
  align-items: center;
  gap: 8px;
  justify-content: space-between;
  min-height: 22px;
}
.inspector-heading h3 {
  margin: 0;
  font-size: 12px;
  font-weight: 650;
  color: #304663;
}
.shot-description :deep(.information-field) {
  font-size: 11px;
  font-weight: 400;
  gap: 6px;
}
.shot-description :deep(.information-field textarea) {
  height: 166px;
  min-height: 166px;
  padding: 9px 10px;
  font-size: 12px;
  line-height: 1.8;
  border-radius: 8px;
  background: #fbfcfe;
  resize: vertical;
}
.shot-description :deep(.information-field:last-child textarea) {
  height: 78px;
  min-height: 78px;
}
.prompt-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 310px;
  flex: 1;
}
.prompt-section h3 {
  display: flex;
  align-items: center;
  gap: 7px;
  color: #315fd8;
  font-size: 13px;
}
.prompt-section h3::before {
  content: '';
  width: 3px;
  height: 13px;
  border-radius: 2px;
  background: #315fd8;
}
.prompt-actions {
  display: flex;
  gap: 6px;
  margin-left: auto;
}
.prompt-section textarea {
  width: 100%;
  flex: 1;
  min-height: 275px;
  box-sizing: border-box;
  resize: vertical;
  padding: 12px;
  border: 1px solid #dbe3ef;
  border-radius: 8px;
  background: #fbfcfe;
  color: #49617f;
  font: inherit;
  font-size: 12px;
  line-height: 1.85;
  outline: 0;
}
.prompt-section textarea:focus {
  border-color: #94b0f0;
}
.production-page .compact-button {
  min-height: 27px;
  padding: 0 9px;
  border-radius: 7px;
  font-size: 11px;
  gap: 5px;
}
.production-page .compact-icon {
  min-height: 25px;
  padding: 0 6px;
  border-radius: 6px;
  margin-left: auto;
}
.prompt-stale {
  font-size: 10px;
  color: #b08b41;
  margin-left: 3px;
}
.asset-preview-full {
  width: 100%;
  max-height: 70vh;
}
.shot-parameter-fields {
  display: grid;
  gap: 16px;
}
.shot-parameter-fields details {
  font-size: 12px;
  color: #788ca9;
}
.shot-parameter-fields details :deep(.information-field) {
  margin-top: 12px;
}
.asset-facts {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
  margin-top: 16px;
}
.icon-button {
  padding: 0 8px !important;
  min-height: 30px !important;
}
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 350px;
  color: #91a0b5;
  text-align: center;
  padding: 30px;
}
.empty h3 {
  color: #526881;
  font-size: 16px;
}
.empty p {
  font-size: 12px;
  line-height: 1.8;
}
.warning {
  font-size: 12px;
  color: #ae8544;
  line-height: 1.7;
}
.notice {
  font-size: 12px;
  color: #77a18e;
}
.binding-picker {
  display: grid;
  gap: 12px;
}
.binding-picker label {
  display: flex;
  gap: 12px;
  padding: 16px;
  border: 1px solid #e1e8f4;
  border-radius: 12px;
}
.binding-picker small {
  display: block;
  margin-top: 7px;
  color: #7d8da6;
  line-height: 1.7;
}
.execution-content {
  padding: 12px;
}
.execution-content p {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  line-height: 1.8;
  font-size: 13px;
  color: #6b7f9d;
}
@media (min-width: 1700px) {
  .video-workspace {
    grid-template-columns: 264px minmax(0, 1fr) 340px;
  }
}
@media (max-width: 1350px) {
  .video-workspace {
    grid-template-columns: 240px minmax(0, 1fr) 280px;
  }
  .shot-composition {
    grid-template-columns: 1fr;
  }
}
@media (max-width: 1050px) {
  .video-workspace {
    grid-template-columns: 220px minmax(0, 1fr);
    height: auto;
    overflow: visible;
  }
  .shot-editor {
    max-height: 790px;
  }
  .video-workspace :deep(.shot-task-directory) {
    max-height: 790px;
  }
  .video-workspace :deep(.render-panel) {
    grid-column: 2;
    min-height: 430px;
    border-top: 1px solid #e4e9f2;
  }
}
@media (max-width: 760px) {
  .production-page {
    padding: 18px 14px;
  }
  .video-workspace {
    grid-template-columns: 1fr;
    height: auto;
    overflow: hidden;
  }
  .video-workspace :deep(.shot-task-directory) {
    max-height: 380px;
  }
  .shot-editor {
    max-height: none;
    border-left: 0;
    border-top: 1px solid #e4e9f2;
  }
  .shot-composition {
    grid-template-columns: 1fr;
  }

  .video-workspace :deep(.render-panel) {
    grid-column: auto;
    min-height: 440px;
    border-left: 0;
  }
  .shot-spec,
  .asset-facts {
    grid-template-columns: 1fr;
  }
  .production-heading {
    gap: 18px;
  }
  .production-heading p {
    line-height: 1.8;
  }
  .shot-editor :deep(.reference-grid) {
    grid-template-columns: 1fr;
  }
  .shot-editor :deep(.workflow-information-card) {
    padding: 16px;
  }
}
</style>

<style scoped src="../../../platform/workflow/components/workflow-extraction-heading.css"></style>
