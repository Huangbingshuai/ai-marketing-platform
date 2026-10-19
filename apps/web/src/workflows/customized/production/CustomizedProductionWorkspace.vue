<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import {
  Clapperboard,
  Plus,
  Trash2,
  ArrowUp,
  ArrowDown,
  RefreshCw,
  Sparkles,
  SlidersHorizontal,
} from '@lucide/vue';
import { WorkflowNodeFooter, WorkflowRunProgress } from '@ai-marketing/ui';
import {
  productionStages,
  isVideoDocument,
  productionShots,
  customizedAssetImageSelectionIssue,
  isCustomizedImageSettings,
  type ProductionWorkspace,
  type ProductionDocument,
  type ProductionAsset,
  type ProductionOperation,
  type ProductionTask,
  type VideoCandidate,
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
import { isAbortError, safeApiErrorMessage } from '../../../api/http-client';
import { productionApi } from './production.api';
import ProductionAssetStudio from './ProductionAssetStudio.vue';
import ProductionReferenceLibrary from './ProductionReferenceLibrary.vue';
import ProductionShotRenderPanel from './ProductionShotRenderPanel.vue';
import ProductionShotDirectory from './ProductionShotDirectory.vue';
import ProductionVideoWorkbench from './ProductionVideoWorkbench.vue';
import ProductionCandidateReview from './ProductionCandidateReview.vue';
import ProductionRenderDialog from './ProductionRenderDialog.vue';
import ProductionAssetVisual from './ProductionAssetVisual.vue';
import ProductionTaskActivity from './ProductionTaskActivity.vue';
import ProductionPromptTaskFeedback from './ProductionPromptTaskFeedback.vue';
import {
  productionNodeTasks,
  productionPageProgressTask,
  productionWorkflowTask,
} from './production-workflow-selection';
import {
  imageSource,
  independentlyPrepared,
  referenceImageSources,
} from './production-asset-images';
const ProductionPromptEditor = defineAsyncComponent(() => import('./ProductionPromptEditor.vue'));
const props = defineProps<{
  projectId: string;
  workflowRunId: string;
  mode: 'ASSETS' | 'SHOTS';
  focusAssetId?: string | null;
}>();
const emit = defineEmits<{
  back: [];
  next: [];
  saved: [];
  published: [runId: string];
  prepareAsset: [assetId: string];
  assetFocusHandled: [];
}>();
const assetStudio = ref<InstanceType<typeof ProductionAssetStudio> | null>(null);
const workspace = ref<ProductionWorkspace | null>(null),
  document = ref<ProductionDocument>({ assets: [], shots: [] });
const videoWorkbench = ref<{
  flushPendingEdits: () => Promise<boolean>;
  hasDirty: boolean;
  addShot: () => void;
} | null>(null);
const videoDocument = computed(() => (isVideoDocument(document.value) ? document.value : null));
const legacyShots = computed(() => productionShots(document.value));
const rawShots = computed(() =>
  isVideoDocument(document.value) ? document.value.videoPlan.shots : document.value.shots,
);
const candidateReview = ref<{ taskId: string; value: VideoCandidate } | null>(null);
const candidateBusy = ref(false);
const detailPage = ref(1);
const detailSections = computed(
  () =>
    graphDetail.value?.detail?.sections.slice((detailPage.value - 1) * 12, detailPage.value * 12) ??
    [],
);

const sectionValue = (d: ProductionDocument) => (isVideoDocument(d) ? d.videoPlan : d.shots);
const promptText = ref(''),
  promptBase = ref('');
const editing = ref(false);
const shotRenderPanel = ref<{ open: () => void } | null>(null);
const loading = ref(true),
  busy = ref(false),
  error = ref(''),
  saveFailed = ref(false),
  pollingInterrupted = ref(false),
  notice = ref(''),
  kind = ref<ProductionAsset['kind']>('PRODUCT'),
  selectedShotId = ref(''),
  graphOpen = ref(false),
  graphNode = ref('SNAPSHOT'),
  graphTaskId = ref('');
const graphScope = ref<ProductionOperation | null>(null),
  graphClipId = ref(''),
  graphLoading = ref(false),
  graphError = ref('');
let graphController = new AbortController();
const graphOperation = computed(() => graphScope.value ?? props.mode);
function openWorkflow(task?: ProductionTask, focusFailure = false) {
  graphController.abort();
  graphLoading.value = false;
  graphError.value = '';
  graphScope.value = task?.operation ?? props.mode;
  graphClipId.value = task?.target?.id ?? '';
  graphTaskId.value = task?.id ?? '';
  graphNode.value = focusFailure
    ? (task?.steps.find((s) => s.status === 'FAILED')?.id ?? 'SNAPSHOT')
    : 'SNAPSHOT';
  graphOpen.value = true;
}
async function openPromptWorkflow(clipId: string, taskId?: string) {
  graphController.abort();
  graphController = new AbortController();
  const scope = graphController;
  graphScope.value = 'PROMPT';
  graphClipId.value = clipId;
  graphTaskId.value = taskId ?? '';
  graphNode.value = 'SNAPSHOT';
  graphOpen.value = true;
  graphLoading.value = true;
  graphError.value = '';
  try {
    const task = taskId
      ? await productionApi.task(props.projectId, taskId, scope.signal)
      : await productionApi.promptTask(props.projectId, props.workflowRunId, clipId, scope.signal);
    if (scope !== graphController || scope.signal.aborted || !workspace.value) return;
    if (task) {
      if (
        task.operation !== 'PROMPT' ||
        task.target?.id !== clipId ||
        (taskId && task.id !== taskId)
      )
        throw new Error('该执行记录不属于当前分镜，请重新加载后查看');
      // Reading an exact failed record must not promote it ahead of a newer attempt.
      workspace.value.tasks = taskId
        ? workspace.value.tasks.some((t) => t.id === task.id)
          ? workspace.value.tasks.map((t) => (t.id === task.id ? task : t))
          : [...workspace.value.tasks, task]
        : [task, ...workspace.value.tasks.filter((t) => t.id !== task.id)];
      graphTaskId.value = task.id;
      if (taskId) graphNode.value = task.steps.find((s) => s.status === 'FAILED')?.id ?? 'SNAPSHOT';
    }
  } catch (e) {
    if (scope === graphController && !isAbortError(e))
      graphError.value = safeApiErrorMessage(e, '工作流查询失败，请重试');
  } finally {
    if (scope === graphController) graphLoading.value = false;
  }
}
watch(
  [() => props.focusAssetId, () => props.mode, loading, assetStudio],
  () => {
    if (!props.focusAssetId || props.mode !== 'ASSETS' || loading.value || !assetStudio.value)
      return;
    if (!assetStudio.value.openAsset(props.focusAssetId))
      error.value = '该资产已不在当前目录，请重新选择';
    emit('assetFocusHandled');
  },
  { flush: 'post' },
);
watch(graphOpen, (open) => {
  if (!open) graphController.abort();
});
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
  if (assets.length === 1 && !independentlyPrepared(document.value.assets, assets[0]!)) {
    const owner = imageSource(document.value.assets, assets[0]!);
    if (owner) assetStudio.value?.openAsset(owner.id);
    else error.value = '资产制作归属待核对，请先编辑定义';
    return;
  }
  const independent = assets.filter((a) => independentlyPrepared(document.value.assets, a));
  if (!independent.length) return;
  imageError.value = '';
  imageAssets.value = independent;
  imageDialogOpen.value = true;
}
function prepareImage(asset: ProductionAsset) {
  assetPreview.value = null;
  const owner = imageSource(document.value.assets, asset);
  if (!owner) {
    error.value = '资产制作归属待核对，请先编辑定义';
    return;
  }
  if (props.mode === 'SHOTS') {
    // Use normal node navigation so unsaved shot/prompt edits are protected.
    emit('prepareAsset', owner.id);
    return;
  }
  if (owner.id !== asset.id) assetStudio.value?.openAsset(owner.id);
  else prepareImages([owner]);
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
    const issue = customizedAssetImageSelectionIssue(document.value.assets, settings.assetIds);
    if (issue) {
      imageError.value = issue;
      return;
    }
    if (!isCustomizedImageSettings(settings)) {
      imageError.value = '图片设置与所选资产不一致，请重新核对';
      return;
    }
    if ((dirty.value || !workspace.value.assetsConfirmed || editing.value) && !(await save(true))) {
      imageError.value = error.value || '请先保存资产定义';
      return;
    }
    if (project !== props.projectId || run !== props.workflowRunId || disposed) return;
    const refreshedIssue = customizedAssetImageSelectionIssue(
      document.value.assets,
      settings.assetIds,
    );
    if (refreshedIssue) {
      imageError.value = refreshedIssue;
      return;
    }
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
  promptRefreshSequence = 0,
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
const pageProgress = computed(() => productionPageProgressTask(tasks.value, props.mode));
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
  () => legacyShots.value.find((s) => s.id === selectedShotId.value) ?? legacyShots.value[0],
);
const prompt = computed(() =>
  workspace.value?.prompts.find((p) => 'shotId' in p.value && p.value.shotId === shot.value?.id),
);
const legacyPromptTask = computed(() =>
  tasks.value.find((t) => t.operation === 'PROMPT' && t.shotId === shot.value?.id),
);
const legacyPromptIncomplete = computed(
  () =>
    !!legacyPromptTask.value &&
    ['FAILED', 'PARTIAL', 'CANCELLED'].includes(legacyPromptTask.value.status),
);
const graphTasks = computed(() =>
  tasks.value.filter(
    (t) =>
      t.operation === graphOperation.value &&
      (!graphClipId.value || t.target?.id === graphClipId.value),
  ),
);
const graphTask = computed(() =>
  productionWorkflowTask(
    graphTasks.value,
    graphOperation.value,
    graphTaskId.value,
    graphClipId.value || undefined,
  ),
);
const graphStages = computed(() =>
  productionStages(
    graphOperation.value,
    graphTask.value?.assetWorkflowVersion ?? (graphTask.value ? undefined : 2),
    graphTask.value?.shotWorkflowVersion ?? (graphOperation.value === 'PROMPT' ? 2 : undefined),
    graphTask.value?.promptWorkflowVersion ??
      (graphOperation.value === 'PROMPT' && !graphTask.value ? 2 : undefined),
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
watch(
  () => [graphNode.value, graphTask.value?.id],
  () => (detailPage.value = 1),
);
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
  clearTimeout(legacyPromptAutosave);
  controller.abort();
  controller = new AbortController();
  const scope = controller;
  clearTimeout(poll);
  if (!quiet) loading.value = true;
  error.value = '';
  saveFailed.value = false;
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
      JSON.stringify(
        props.mode === 'ASSETS' ? result.document.assets : sectionValue(result.document),
      ) !==
      JSON.stringify(
        props.mode === 'ASSETS'
          ? result.confirmedDocument.assets
          : sectionValue(result.confirmedDocument),
      );
    if (!legacyShots.value.some((s) => s.id === selectedShotId.value))
      selectedShotId.value = legacyShots.value[0]?.id ?? '';
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
      if (
        result.operation === 'IMAGE' &&
        !dirty.value &&
        !promptDirty.value &&
        !videoWorkbench.value?.hasDirty &&
        !editing.value
      ) {
        const refreshed = await productionApi.workspace(
          props.projectId,
          props.workflowRunId,
          scope.signal,
        );
        if (scope !== controller) return;
        // A silent image refresh must not replace edits begun during the request.
        if (dirty.value || promptDirty.value || videoWorkbench.value?.hasDirty || editing.value) {
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
      // An untouched persisted draft may restore edit mode. That flag alone
      // must not keep the previous generation on screen after this task ends.
      if (!dirty.value && !promptDirty.value && !videoWorkbench.value?.hasDirty) {
        await load(true);
        // The final node has no manual confirmation step. Only a newly completed
        // user-triggered generation is finalized here; merely opening is read-only.
        if (
          props.mode === 'SHOTS' &&
          result.operation === 'SHOTS' &&
          result.status === 'COMPLETED' &&
          editing.value
        )
          await save();
      } else notice.value = '任务已结束，保存当前修改后可重新加载结果';
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
  rawShots.value.forEach((s) => {
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
  if (props.mode === 'ASSETS')
    document.value.assets = clone(workspace.value.confirmedDocument.assets);
  else
    document.value = { ...clone(workspace.value.confirmedDocument), assets: document.value.assets };
  if (props.mode === 'ASSETS') {
    // Restore affected references without discarding unrelated shot edits.
    const ids = new Set(document.value.assets.map((a) => a.id));
    rawShots.value.forEach((s) => {
      const original = productionShots(workspace.value!.confirmedDocument).find(
        (v) => v.id === s.id,
      );
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
  saveFailed.value = false;
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
    if (scope === controller && props.mode === 'SHOTS') saveFailed.value = true;
    if (scope === controller && !isAbortError(e))
      error.value = e instanceof Error ? e.message : '保存失败，本地修改已保留';
    return false;
  } finally {
    if (scope === controller) busy.value = false;
  }
}
async function generate(
  operation: ProductionOperation,
  shotId?: string,
  targetAssetId?: string,
  clipId?: string,
) {
  if (!workspace.value || busy.value || running.value || imageSubmitting.value) return;
  if (videoWorkbench.value && !(await videoWorkbench.value.flushPendingEdits())) return;
  if (promptDirty.value && !(await savePrompt())) return;
  // A restored draft is already the local baseline but is not yet confirmed.
  if ((dirty.value || (operation === 'PROMPT' && editing.value)) && !(await save())) return;
  if (
    (operation === 'ASSETS' && document.value.assets.length) ||
    (operation === 'SHOTS' && legacyShots.value.length)
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
      undefined,
      {
        ...(clipId ? { target: { kind: 'CLIP' as const, id: clipId } } : {}),
      },
    );
    if (scope !== controller) return;
    workspace.value.tasks = [t, ...workspace.value.tasks];
    graphScope.value = t.operation;
    graphClipId.value = t.target?.id ?? '';
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
  rawShots.value.forEach((s) => (s.bindings = s.bindings.filter((b) => b.assetId !== id)));
}
function addShot() {
  if (videoDocument.value) {
    videoWorkbench.value?.addShot();
    return;
  }
  const id = crypto.randomUUID();
  legacyShots.value.push({
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
  if (isVideoDocument(document.value)) return;
  document.value.shots = document.value.shots.filter((s) => s.id !== shot.value?.id);
  selectedShotId.value = legacyShots.value[0]?.id ?? '';
}
function moveShot(offset: number) {
  if (!shot.value) return;
  const i = legacyShots.value.indexOf(shot.value),
    j = i + offset;
  if (j < 0 || j >= legacyShots.value.length) return;
  const [s] = legacyShots.value.splice(i, 1);
  legacyShots.value.splice(j, 0, s!);
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
async function savePrompt() {
  if (!shot.value || busy.value || running.value) return false;
  if (!promptDirty.value) return true;
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
    promptBase.value = content;
    await refreshPrompts();
    return true;
  } catch (e) {
    if (scope === controller) saveFailed.value = true;
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
async function viewCandidate() {
  const task = graphTask.value,
    scope = controller;
  if (!task || candidateBusy.value) return;
  candidateBusy.value = true;
  try {
    const value = await productionApi.candidate(props.projectId, task.id, scope.signal);
    if (scope === controller && graphTask.value?.id === task.id) {
      graphOpen.value = false;
      candidateReview.value = { taskId: task.id, value };
    }
  } catch (e) {
    if (scope === controller && !isAbortError(e))
      error.value = e instanceof Error ? e.message : '候选读取失败';
  } finally {
    if (scope === controller) candidateBusy.value = false;
  }
}
async function adoptCandidate() {
  const candidate = candidateReview.value,
    scope = controller;
  if (!candidate || !workspace.value || candidateBusy.value) return;
  candidateReview.value = null;
  graphOpen.value = false;
  await nextTick();
  if (
    !(await requestActionConfirmation({
      title: '转入人工核对草稿？',
      description:
        '未通过的AI候选不会自动确认。请根据具体问题修改，再保存修改；任务仍保留未完成状态。',
      confirmLabel: '转入草稿',
    }))
  ) {
    if (scope === controller) candidateReview.value = candidate;
    return;
  }
  if (scope !== controller || graphTask.value?.id !== candidate.taskId) return;
  candidateBusy.value = true;
  try {
    await productionApi.reviewDraft(
      props.projectId,
      candidate.taskId,
      workspace.value.draftRevision,
      candidate.value.candidateHash,
      scope.signal,
    );
    if (scope !== controller) return;
    candidateReview.value = null;
    graphOpen.value = false;
    await load(true);
    editing.value = true;
    notice.value = '已转入人工核对草稿，AI任务仍未通过';
  } catch (e) {
    if (scope === controller && !isAbortError(e))
      error.value = e instanceof Error ? e.message : '转入草稿失败';
  } finally {
    candidateBusy.value = false;
  }
}
watch(
  () => graphTask.value?.id,
  () => {
    candidateReview.value = null;
  },
);
async function flushPendingEdits() {
  if (videoWorkbench.value && !(await videoWorkbench.value.flushPendingEdits())) return false;
  if (promptDirty.value && !(await savePrompt())) return false;
  return !dirty.value || (await save(props.mode === 'SHOTS'));
}
async function refreshPrompts() {
  const scope = controller;
  const sequence = ++promptRefreshSequence;
  try {
    const result = await productionApi.workspace(
      props.projectId,
      props.workflowRunId,
      scope.signal,
    );
    if (scope !== controller || sequence !== promptRefreshSequence || !workspace.value) return;
    // Prompt commits do not own the editable plan. Never replace new typing.
    workspace.value.prompts = result.prompts;
    workspace.value.tasks = result.tasks;
    workspace.value.videos = result.videos ?? [];
    workspace.value.videoSettings = result.videoSettings ?? [];
    emit('saved');
  } catch (e) {
    if (scope === controller && sequence === promptRefreshSequence && !isAbortError(e))
      error.value = '内容已保存，最新状态查询暂时中断';
  }
}
async function retrySave() {
  if (!videoWorkbench.value && promptDirty.value && !(await savePrompt())) return;
  if (videoWorkbench.value && !(await videoWorkbench.value.flushPendingEdits())) return;
  if (dirty.value || editing.value) await save();
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
    graphController.abort();
    graphOpen.value = false;
    graphScope.value = null;
    graphClipId.value = '';
    graphTaskId.value = '';
    graphError.value = '';
    assetPreview.value = null;
  },
);
function beforeUnload(e: BeforeUnloadEvent) {
  if (dirty.value || promptDirty.value || videoWorkbench.value?.hasDirty) {
    e.preventDefault();
    e.returnValue = '';
  }
}
window.addEventListener('beforeunload', beforeUnload);
watch(
  document,
  () => {
    clearTimeout(autosave);
    if (
      loading.value ||
      (props.mode !== 'SHOTS' && !editing.value) ||
      running.value ||
      !dirty.value ||
      error.value
    )
      return;
    autosave = setTimeout(() => {
      if (!disposed && !busy.value) void save(props.mode === 'SHOTS');
    }, 900);
  },
  { deep: true },
);
let legacyPromptAutosave: ReturnType<typeof setTimeout> | undefined;
watch([promptText, busy], () => {
  clearTimeout(legacyPromptAutosave);
  if (
    !videoDocument.value &&
    props.mode === 'SHOTS' &&
    !busy.value &&
    !running.value &&
    promptDirty.value &&
    !error.value
  )
    legacyPromptAutosave = setTimeout(() => void savePrompt(), 900);
});
watch(
  () => [props.projectId, props.workflowRunId, props.mode],
  () => {
    graphController.abort();
    graphOpen.value = false;
    graphScope.value = null;
    graphClipId.value = '';
    graphTaskId.value = '';
    graphError.value = '';
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
  graphController.abort();
  disposed = true;
  controller.abort();
  clearTimeout(poll);
  clearTimeout(autosave);
  clearTimeout(legacyPromptAutosave);
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
              : '分镜创作、素材绑定、提示词与逐镜视频'
          }}
        </p>
      </div>
      <div class="actions extraction-heading__actions">
        <WorkflowNodeEditActions
          v-if="mode === 'ASSETS'"
          :editing="editing"
          :temporary="true"
          :disabled="busy || !!running || !workspace"
          :saving="busy"
          save-label="保存修改"
          @begin="editing = true"
          @cancel="cancelEdit"
          @save="save()"
        />
        <button v-if="mode === 'SHOTS'" :disabled="busy || !!running" @click="addShot">
          <Plus :size="15" />添加分镜
        </button>
        <WorkflowExtractionActions
          :disabled="
            busy ||
            !!running ||
            !workspace?.sourceReady ||
            (mode === 'SHOTS' && !workspace?.assetsConfirmed)
          "
          :running="running?.operation === mode"
          :reextract="mode === 'ASSETS' ? !!document.assets.length : !!legacyShots.length"
          :label="mode === 'ASSETS' ? 'AI 整理资产' : 'AI 生成分镜'"
          @extract="generate(mode)"
          @details="openWorkflow()"
        />
      </div>
    </header>
    <WorkflowExtractionFeedback
      v-if="error"
      title="操作未完成"
      :message="error"
      :action="saveFailed ? '重试' : '重新加载'"
      @action="saveFailed ? retrySave() : load()"
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
      v-if="pageProgress"
      :progress="pageProgress.progress"
      :summary="
        pageProgress.operation === 'ASSETS'
          ? '正在整理资产定义'
          : pageProgress.operation === 'IMAGE'
            ? '正在生成资产图片'
            : '正在创作连续分镜'
      "
      :terminal="false"
      :action-label="pageProgress.operation === 'IMAGE' ? '' : '查看工作流'"
      @show-details="openWorkflow(pageProgress)"
    />
    <template v-if="workspace">
      <ProductionAssetStudio
        v-if="mode === 'ASSETS'"
        ref="assetStudio"
        :project-id="projectId"
        :assets="document.assets"
        :shots="legacyShots"
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
      <ProductionVideoWorkbench
        v-else-if="videoDocument"
        ref="videoWorkbench"
        :project-id="projectId"
        :workflow-run-id="workflowRunId"
        :document="videoDocument"
        :workspace="workspace"
        :editing="true"
        :locked="busy || !!running"
        :dirty="dirty"
        :save-plan="() => save()"
        @generate="generate('PROMPT', undefined, undefined, $event)"
        @workflow="openPromptWorkflow"
        @render-workflow="openWorkflow"
        @settings-saved="
          workspace.videoSettings = [
            $event,
            ...(workspace.videoSettings ?? []).filter((s) => s.clipId !== $event.clipId),
          ]
        "
        @render-started="
          workspace.tasks = [$event, ...workspace.tasks.filter((t) => t.id !== $event.id)];
          error = '';
          schedule();
        "
        @refresh="refreshPrompts"
        @edit="editing = true"
        @preview="assetPreview = $event"
        @prepare="prepareImage"
        @error="error = $event"
        @save-error="
          saveFailed = !!$event;
          error = $event;
        "
        @update-plan="videoDocument && (videoDocument.videoPlan = $event)"
      />
      <div v-else class="video-workspace">
        <ProductionShotDirectory
          :shots="legacyShots"
          :assets="document.assets"
          :selected-id="shot?.id ?? ''"
          :locked="busy || !!running"
          v-bind="legacyShots.length ? { unit: '片段' as const } : {}"
          @select="selectShot"
          @produce="openShotProduction"
        />
        <main v-if="shot" class="shot-editor">
          <div class="shot-composition">
            <section class="shot-description">
              <header class="inspector-heading">
                <h3>旧版片段描述</h3>
                <button
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
                :readonly="busy || !!running"
              />
              <WorkflowInformationField
                v-model="shot.atmosphere"
                label="氛围"
                multiline
                :readonly="busy || !!running"
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
                  class="compact-button"
                  :disabled="busy || !!running || !workspace.shotsConfirmed"
                  @click="generate('PROMPT', shot.id)"
                >
                  <RefreshCw v-if="prompt || legacyPromptIncomplete" :size="12" /><Sparkles
                    v-else
                    :size="12"
                  />{{ prompt || legacyPromptIncomplete ? '重新生成' : 'AI 生成' }}
                </button>
              </div>
            </header>
            <ProductionTaskActivity :task="legacyPromptTask" label="当前片段提示词生成进度" />
            <ProductionPromptTaskFeedback
              :task="legacyPromptTask"
              @workflow="openWorkflow(legacyPromptTask, true)"
            />
            <ProductionPromptEditor
              v-model="promptText"
              label="视频提示词"
              :project-id="projectId"
              :scope-id="shot.id"
              :assets="boundAssets.map((b) => b.asset)"
              :readonly="busy || !!running"
              placeholder="输入视频提示词"
              @blur="savePrompt"
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
          :index="legacyShots.findIndex((s) => s.id === shot?.id) + 1"
          :assets="
            referenceImageSources(
              document.assets,
              boundAssets.map((b) => b.asset),
            )
          "
          :prompt="prompt?.value.content ?? ''"
          :locked="busy || !!running"
          :editing="true"
          unit="片段"
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
      :catalog="document.assets"
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
          :readonly="busy || !!running"
        />
        <div class="asset-facts">
          <WorkflowInformationField
            v-model="shot.shotType"
            label="景别"
            :readonly="busy || !!running"
          />
          <WorkflowInformationField
            v-model="shot.cameraMovement"
            label="运镜"
            :readonly="busy || !!running"
          />
        </div>
        <WorkflowInformationField
          v-model="shot.dialogue"
          label="台词与旁白"
          multiline
          :readonly="busy || !!running"
        />
        <WorkflowInformationField
          v-model="shot.audio"
          label="声音"
          multiline
          :readonly="busy || !!running"
        />
        <details v-if="shot.bindings.length">
          <summary>本镜素材呈现</summary>
          <WorkflowInformationField
            v-for="binding in shot.bindings"
            :key="binding.assetId"
            v-model="binding.description"
            :label="document.assets.find((a) => a.id === binding.assetId)?.name || '素材'"
            multiline
            :readonly="busy || !!running"
          />
        </details>
        <div class="actions">
          <button :disabled="busy || !!running" aria-label="上移镜头" @click="moveShot(-1)">
            <ArrowUp :size="14" />上移
          </button>
          <button :disabled="busy || !!running" aria-label="下移镜头" @click="moveShot(1)">
            <ArrowDown :size="14" />下移
          </button>
          <button :disabled="busy || !!running" aria-label="删除镜头" @click="removeShot">
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
      :title="
        graphOperation === 'PROMPT'
          ? '当前分镜提示词工作流'
          : graphOperation === 'RENDER'
            ? '当前分镜视频渲染工作流'
            : mode === 'ASSETS'
              ? '当前资产整理工作流'
              : '当前分镜生成工作流'
      "
      eyebrow="执行详情"
      :description="
        graphOperation === 'RENDER'
          ? '查看实际渲染依据、生成进度与视频文件校验结果'
          : '查看本次任务的实际内容与审校结果'
      "
      :rows="graphRows"
      :nodes="graphNodes"
      :selected="graphNode"
      @select="graphNode = $event"
      @close="graphOpen = false"
    >
      <div
        v-if="graphTask?.status === 'FAILED' || graphTask?.status === 'CANCELLED'"
        class="actions execution-actions"
      >
        <button
          v-if="
            graphTask.hasCandidate &&
            graphTask.operation === 'SHOTS' &&
            graphTask.shotWorkflowVersion === 2
          "
          :disabled="candidateBusy"
          @click="viewCandidate"
        >
          查看未完成候选
        </button>
      </div>
      <WorkflowPageLoading
        v-if="graphLoading"
        title="正在读取提示词工作流…"
        description="读取当前分镜的真实执行记录"
        icon="extraction"
      />
      <WorkflowExtractionFeedback
        v-else-if="graphError"
        title="工作流查询未完成"
        :message="graphError"
        action="重新查询"
        @action="openPromptWorkflow(graphClipId, graphTaskId || undefined)"
      />
      <article v-else-if="graphDetail" class="execution-content">
        <template v-if="graphDetail.detail">
          <h3>{{ graphDetail.detail.title }}</h3>
          <p v-if="graphDetail.detail.summary" class="execution-summary">
            {{ graphDetail.detail.summary }}
          </p>
          <section
            v-for="(section, index) in detailSections"
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
          <div v-if="graphDetail.detail.sections.length > 12" class="detail-pagination">
            <button :disabled="detailPage <= 1" @click="detailPage--">上一页</button
            ><span>{{ detailPage }} / {{ Math.ceil(graphDetail.detail.sections.length / 12) }}</span
            ><button
              :disabled="detailPage * 12 >= graphDetail.detail.sections.length"
              @click="detailPage++"
            >
              下一页
            </button>
          </div>
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
      <p v-else>
        {{
          graphOperation === 'PROMPT'
            ? '当前分镜尚未生成提示词，生成后可查看各阶段的实际内容。'
            : '开始生成后，可查看每一步的实际内容与核对结果。'
        }}
      </p></WorkflowExecutionGraphDialog
    >
    <ProductionCandidateReview
      :candidate="candidateReview?.value ?? null"
      :busy="candidateBusy"
      @close="candidateReview = null"
      @adopt="adoptCandidate"
    />
  </section>
</template>
<style scoped>
.execution-actions {
  margin-bottom: 18px;
}
.detail-pagination {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-top: 18px;
  font-size: 12px;
  color: #748aa4;
}
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
.production-page button,
.execution-actions button {
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
.production-page button:disabled,
.execution-actions button:disabled {
  opacity: 0.5;
  cursor: default;
}
.production-page button:focus-visible,
.execution-actions button:focus-visible {
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
