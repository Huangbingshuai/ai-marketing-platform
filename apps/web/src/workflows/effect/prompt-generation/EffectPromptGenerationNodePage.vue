<script setup lang="ts">
import type {
  EffectImportProduct,
  EffectPromptBatchSettings,
  EffectPromptDimensions,
  EffectPromptItem,
  EffectPromptNodeExecution,
  EffectPromptNodeId,
  EffectPromptProductState,
  EffectPromptRun,
  EffectPromptStageStatus,
  EffectVideoConfig,
  GetEffectPromptNodeDetailData,
  GetEffectPromptResultData,
} from '@ai-marketing/contracts';
import {
  DEFAULT_EFFECT_PROMPT_SETTINGS,
  EFFECT_PROMPT_DIMENSIONS,
  EFFECT_PROMPT_GRAPH_EDGES,
  EFFECT_PROMPT_GRAPH_NODES,
  EFFECT_PROMPT_LIMITS,
} from '@ai-marketing/contracts';
import { WorkflowNodeDraftBar, WorkflowNodeFooter } from '@ai-marketing/ui';
import {
  AlertCircle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
  Workflow,
  X,
} from '@lucide/vue';
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';

import { ApiClientError, isAbortError } from '../../../api/http-client';
import {
  clonePromptSettings,
  isPromptProductCommitted,
  isPromptResultQualityReady,
  isPromptRunActive,
  normalizePromptSettings,
  promptPageCount,
  type EffectPromptPageStatus,
} from './effect-prompt-generation-state';
import {
  beginEffectPromptRun,
  commitEffectPromptResult,
  downloadEffectPromptBatch,
  loadEffectPromptNodeDetail,
  loadEffectPromptResult,
  loadEffectPromptRun,
  loadEffectPromptWorkspace,
  pollEffectPromptRun,
  removeEffectPromptItem,
  saveEffectPromptItem,
  savePromptSettings,
  type EffectPromptContext,
  type PromptItemDraft,
} from './services/effect-prompt-generation.service';

const props = defineProps<{
  projectId: string;
  workflowRunId: string;
  products: EffectImportProduct[];
  globalConfig: EffectVideoConfig;
}>();

const emit = defineEmits<{ back: []; next: [] }>();

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';
type Notice = { kind: 'error' | 'success' | 'warning'; text: string };
type NodeDetail = GetEffectPromptNodeDetailData['detail'];

const status = ref<EffectPromptPageStatus>('loading');
const loadError = ref('');
const productStates = ref<Record<string, EffectPromptProductState>>({});
const settingsDrafts = ref<Record<string, EffectPromptBatchSettings>>({});
const settingsSaveStatuses = ref<Record<string, SaveStatus>>({});
const currentProductId = ref('');
const resultData = ref<GetEffectPromptResultData | null>(null);
const resultLoading = ref(false);
const keyword = ref('');
const page = ref(1);
const notice = ref<Notice | null>(null);
const operationItemId = ref('');
const validating = ref(false);
const exporting = ref(false);

const graphDialogOpen = ref(false);
const graphLoading = ref(false);
const graphError = ref('');
const runsByProduct = ref<Record<string, EffectPromptRun>>({});
const selectedGraphNodeId = ref<EffectPromptNodeId | null>(null);
const graphDetail = ref<NodeDetail | null>(null);
const graphDetailLoading = ref(false);
const graphDetailError = ref('');
const graphTrigger = ref<HTMLButtonElement | null>(null);
const graphCloseButton = ref<HTMLButtonElement | null>(null);

const editorOpen = ref(false);
const editorSaving = ref(false);
const editorMode = ref<'add' | 'edit'>('edit');
const editorItemId = ref('');
const editorDraft = ref<PromptItemDraft>({
  content: '',
  fragmentType: '',
  dimensions: emptyDimensions(),
});
const editorTrigger = ref<HTMLElement | null>(null);
const editorCloseButton = ref<HTMLButtonElement | null>(null);

let disposed = false;
let workspaceGeneration = 0;
let resultGeneration = 0;
let workspaceController: AbortController | null = null;
let resultController: AbortController | null = null;
let operationController: AbortController | null = null;
let graphDetailController: AbortController | null = null;
let settingsTimer: ReturnType<typeof setTimeout> | undefined;
let searchTimer: ReturnType<typeof setTimeout> | undefined;
let noticeTimer: ReturnType<typeof setTimeout> | undefined;
const pollControllers = new Map<string, { controller: AbortController; runId: string }>();
const settingsControllers = new Map<string, AbortController>();

const activeProducts = computed(() =>
  props.products.filter((product) => product.status === 'ACTIVE'),
);
const currentProduct = computed(
  () => activeProducts.value.find((product) => product.id === currentProductId.value) ?? null,
);
const currentState = computed(() => productStates.value[currentProductId.value] ?? null);
const currentSettings = computed(
  () => settingsDrafts.value[currentProductId.value] ?? DEFAULT_EFFECT_PROMPT_SETTINGS,
);
const currentRun = computed(() => runsByProduct.value[currentProductId.value] ?? null);
const currentResult = computed(() => resultData.value?.result ?? null);
const currentItems = computed(() => resultData.value?.items ?? []);
const currentMetrics = computed(
  () => currentResult.value?.metrics ?? currentState.value?.metrics ?? null,
);
const currentRunning = computed(() => isPromptRunActive(currentState.value));
const currentQualityReady = computed(() => isPromptResultQualityReady(currentResult.value));
const totalPages = computed(() => promptPageCount(resultData.value?.total ?? 0));
const allProductsCommitted = computed(
  () =>
    activeProducts.value.length > 0 &&
    activeProducts.value.every((product) => {
      const state = productStates.value[product.id];
      return Boolean(state && isPromptProductCommitted(state));
    }),
);
const currentSaveStatus = computed(
  () => settingsSaveStatuses.value[currentProductId.value] ?? 'idle',
);
const currentGraphNodes = computed<EffectPromptNodeExecution[]>(() =>
  EFFECT_PROMPT_GRAPH_NODES.map(
    ({ id }) =>
      currentRun.value?.nodes.find((node) => node.nodeId === id) ?? {
        nodeId: id,
        status: 'PENDING',
        summary: '',
        warnings: [],
        errorMessage: null,
      },
  ),
);
const graphRows: EffectPromptNodeId[][] = [
  ['LOAD_AND_SNAPSHOT'],
  ['STRATEGY_PLANNING'],
  ['DIMENSION_COMBINATION'],
  ['CANDIDATE_GENERATION'],
  ['NORMALIZATION'],
  ['SEMANTIC_DEDUP', 'VISUAL_DEDUP'],
  ['QUALITY_GATE'],
  ['REPLENISH', 'RESULT_SAVE'],
];

const dimensionSuggestions: Record<keyof EffectPromptDimensions, string[]> = {
  narrative: ['痛点前置型', '效果展示型', '场景代入型', '科普讲解型', '对比测评型', '开箱体验型'],
  scene: ['家庭', '户外', '职场', '线下门店', '实验室', '生活化场景'],
  persona: ['都市白领', '新手妈妈', '专业测评人', '年轻情侣', '门店主理人'],
  sellingPoint: [],
  camera: ['固定机位＋三段跳切', '广角环绕＋慢推近景', '手持跟拍＋特写', '俯拍全景＋微距切面'],
  emotion: ['温馨治愈', '专业严谨', '活力明快', '焦虑唤醒', '干货科普'],
};
const fragmentSuggestions = ['钩子片段', '产品展示片段', '场景种草片段', '口碑测评片段'];

function emptyDimensions(): EffectPromptDimensions {
  return { narrative: '', scene: '', persona: '', sellingPoint: '', camera: '', emotion: '' };
}

const context = (): EffectPromptContext => ({
  projectId: props.projectId,
  workflowRunId: props.workflowRunId,
});

const safeMessage = (error: unknown, fallback: string): string => {
  const value = error instanceof Error ? error.message : fallback;
  return value
    .replace(/(?:https?|tos|s3):\/\/\S+/giu, '[链接已隐藏]')
    .replace(/[a-z]:\\(?:[^\\\s]+\\)+[^\s]+/giu, '[路径已隐藏]')
    .slice(0, 400);
};

const showNotice = (text: string, kind: Notice['kind'] = 'success'): void => {
  notice.value = { text, kind };
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => (notice.value = null), 3200);
};

const applyWorkspace = (products: EffectPromptProductState[]): void => {
  productStates.value = Object.fromEntries(products.map((state) => [state.productId, state]));
  const drafts = { ...settingsDrafts.value };
  for (const state of products) {
    if (settingsSaveStatuses.value[state.productId] !== 'saving') {
      drafts[state.productId] = clonePromptSettings(state.settings);
    }
  }
  settingsDrafts.value = drafts;
};

const loadCurrentResult = async (): Promise<void> => {
  const productId = currentProductId.value;
  const state = productStates.value[productId];
  const generation = ++resultGeneration;
  resultController?.abort();
  resultData.value = null;
  if (!productId || !state?.resultId) return;
  const controller = new AbortController();
  resultController = controller;
  resultLoading.value = true;
  try {
    const loaded = await loadEffectPromptResult(
      props.projectId,
      props.workflowRunId,
      productId,
      page.value,
      keyword.value,
      controller.signal,
    );
    if (
      generation !== resultGeneration ||
      controller.signal.aborted ||
      productId !== currentProductId.value
    )
      return;
    resultData.value = loaded;
    if (page.value > promptPageCount(loaded.total)) page.value = promptPageCount(loaded.total);
  } catch (error) {
    if (!isAbortError(error) && generation === resultGeneration)
      showNotice(safeMessage(error, 'Prompt 结果加载失败'), 'error');
  } finally {
    if (generation === resultGeneration) resultLoading.value = false;
  }
};

const updateRun = (productId: string, run: EffectPromptRun): void => {
  runsByProduct.value = { ...runsByProduct.value, [productId]: run };
  const state = productStates.value[productId];
  if (!state) return;
  productStates.value = {
    ...productStates.value,
    [productId]: {
      ...state,
      runId: run.id,
      status:
        run.status === 'FAILED'
          ? 'FAILED'
          : run.status === 'COMPLETED'
            ? 'COMPLETED'
            : run.status === 'QUEUED'
              ? 'QUEUED'
              : 'PROCESSING',
      progress: run.progress,
      currentNode: run.currentNode,
      errorMessage: run.errorMessage,
      updatedAt: run.updatedAt,
    },
  };
};

const startPolling = (productId: string, run: EffectPromptRun): void => {
  const existing = pollControllers.get(productId);
  if (existing?.runId === run.id) return;
  existing?.controller.abort();
  const controller = new AbortController();
  pollControllers.set(productId, { controller, runId: run.id });
  updateRun(productId, run);
  void pollEffectPromptRun(props.projectId, run.id, {
    signal: controller.signal,
    onUpdate: (nextRun) => updateRun(productId, nextRun),
  })
    .then(async (finalRun) => {
      if (controller.signal.aborted || disposed) return;
      updateRun(productId, finalRun);
      await reloadWorkspace(false);
      showNotice(
        finalRun.status === 'COMPLETED'
          ? 'Prompt 批次处理完成'
          : finalRun.errorMessage || 'Prompt 生成失败',
        finalRun.status === 'COMPLETED' ? 'success' : 'error',
      );
    })
    .catch((error) => {
      if (!isAbortError(error) && !controller.signal.aborted)
        showNotice(safeMessage(error, 'Prompt 进度查询失败'), 'error');
    })
    .finally(() => {
      if (pollControllers.get(productId)?.controller === controller)
        pollControllers.delete(productId);
    });
};

const resumeRuns = async (): Promise<void> => {
  await Promise.all(
    Object.values(productStates.value)
      .filter((state) => isPromptRunActive(state) && state.runId)
      .map(async (state) => {
        try {
          const run = await loadEffectPromptRun(props.projectId, state.runId!);
          startPolling(state.productId, run);
        } catch (error) {
          if (!isAbortError(error))
            showNotice(safeMessage(error, '恢复 Prompt 任务失败'), 'warning');
        }
      }),
  );
};

async function reloadWorkspace(showLoading = true): Promise<void> {
  const generation = ++workspaceGeneration;
  workspaceController?.abort();
  const controller = new AbortController();
  workspaceController = controller;
  if (showLoading) status.value = 'loading';
  loadError.value = '';
  try {
    if (!activeProducts.value.length) {
      productStates.value = {};
      currentProductId.value = '';
      resultData.value = null;
      status.value = 'ready';
      return;
    }
    const workspace = await loadEffectPromptWorkspace(context(), controller.signal);
    if (generation !== workspaceGeneration || controller.signal.aborted) return;
    applyWorkspace(workspace.products);
    if (!activeProducts.value.some(({ id }) => id === currentProductId.value))
      currentProductId.value = activeProducts.value[0]!.id;
    status.value = 'ready';
    await loadCurrentResult();
    void resumeRuns();
  } catch (error) {
    if (isAbortError(error) || generation !== workspaceGeneration) return;
    status.value = 'error';
    loadError.value = safeMessage(error, 'Prompt 工作区加载失败');
  }
}

const productSignature = computed(() =>
  JSON.stringify({
    projectId: props.projectId,
    workflowRunId: props.workflowRunId,
    products: activeProducts.value.map(({ id, status, updatedAt }) => ({ id, status, updatedAt })),
  }),
);
watch(
  productSignature,
  () => {
    pollControllers.forEach(({ controller }) => controller.abort());
    pollControllers.clear();
    settingsControllers.forEach((controller) => controller.abort());
    settingsControllers.clear();
    operationController?.abort();
    void reloadWorkspace();
  },
  { immediate: true },
);
watch(currentProductId, (next, previous) => {
  if (previous && previous !== next) void flushSettings(previous);
  page.value = 1;
  keyword.value = '';
  selectedGraphNodeId.value = null;
  graphDetail.value = null;
  void loadCurrentResult();
});
watch(page, () => void loadCurrentResult());
watch(keyword, () => {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    if (page.value === 1) void loadCurrentResult();
    else page.value = 1;
  }, 350);
});

const settingRange = (key: keyof EffectPromptBatchSettings): { maximum: number; minimum: number } =>
  ({
    count: { minimum: EFFECT_PROMPT_LIMITS.minCount, maximum: EFFECT_PROMPT_LIMITS.maxCount },
    durationSeconds: {
      minimum: EFFECT_PROMPT_LIMITS.minDurationSeconds,
      maximum: EFFECT_PROMPT_LIMITS.maxDurationSeconds,
    },
    semanticLimit: {
      minimum: EFFECT_PROMPT_LIMITS.minSemanticDuplicateRate,
      maximum: EFFECT_PROMPT_LIMITS.maxSemanticDuplicateRate,
    },
    visualLimit: {
      minimum: EFFECT_PROMPT_LIMITS.minVisualOverlapRate,
      maximum: EFFECT_PROMPT_LIMITS.maxVisualOverlapRate,
    },
  })[key];

const queueSettingsSave = (): void => {
  if (!currentProductId.value) return;
  settingsSaveStatuses.value = { ...settingsSaveStatuses.value, [currentProductId.value]: 'idle' };
  if (settingsTimer) clearTimeout(settingsTimer);
  settingsTimer = setTimeout(() => void flushSettings(currentProductId.value), 700);
};

const adjustSetting = (key: keyof EffectPromptBatchSettings, delta: number): void => {
  const draft = settingsDrafts.value[currentProductId.value];
  if (!draft) return;
  const range = settingRange(key);
  draft[key] = Math.min(range.maximum, Math.max(range.minimum, draft[key] + delta));
  queueSettingsSave();
};

async function flushSettings(productId = currentProductId.value): Promise<boolean> {
  if (settingsTimer) clearTimeout(settingsTimer);
  const state = productStates.value[productId];
  const draft = settingsDrafts.value[productId];
  if (!state || !draft) return true;
  const normalized = normalizePromptSettings(draft);
  settingsDrafts.value = { ...settingsDrafts.value, [productId]: normalized };
  if (
    state.settingsRevision !== null &&
    JSON.stringify(normalized) === JSON.stringify(state.settings)
  )
    return true;
  settingsControllers.get(productId)?.abort();
  const controller = new AbortController();
  settingsControllers.set(productId, controller);
  settingsSaveStatuses.value = { ...settingsSaveStatuses.value, [productId]: 'saving' };
  try {
    const saved = await savePromptSettings(
      context(),
      productId,
      normalized,
      state.settingsRevision,
      controller.signal,
    );
    if (controller.signal.aborted) return false;
    productStates.value = {
      ...productStates.value,
      [productId]: {
        ...state,
        settings: saved.settings,
        settingsRevision: saved.settingsRevision,
        commitStatus: state.commitStatus === 'COMMITTED' ? 'DRAFT_CHANGED' : state.commitStatus,
        updatedAt: saved.savedAt,
      },
    };
    settingsSaveStatuses.value = { ...settingsSaveStatuses.value, [productId]: 'saved' };
    return true;
  } catch (error) {
    if (isAbortError(error)) return false;
    settingsSaveStatuses.value = { ...settingsSaveStatuses.value, [productId]: 'error' };
    if (error instanceof ApiClientError && error.status === 409) {
      showNotice('批次设置已在其他窗口更新，已重新载入最新版本', 'warning');
      await reloadWorkspace(false);
    } else showNotice(safeMessage(error, '批次设置保存失败'), 'error');
    return false;
  } finally {
    if (settingsControllers.get(productId) === controller) settingsControllers.delete(productId);
  }
}

const generateCurrentBatch = async (): Promise<void> => {
  const productId = currentProductId.value;
  if (!productId || currentRunning.value) return;
  if (!(await flushSettings(productId))) return;
  const state = productStates.value[productId];
  if (state?.settingsRevision === null || state?.settingsRevision === undefined) {
    showNotice('批次设置尚未保存，请稍后重试', 'warning');
    return;
  }
  operationController?.abort();
  const controller = new AbortController();
  operationController = controller;
  try {
    const run = await beginEffectPromptRun(
      props.projectId,
      productId,
      {
        workflowRunId: props.workflowRunId,
        operation: 'BATCH_GENERATE',
        expectedSettingsRevision: state.settingsRevision,
        ...(state.resultRevision === null ? {} : { expectedResultRevision: state.resultRevision }),
      },
      controller.signal,
    );
    updateRun(productId, run);
    graphDialogOpen.value = true;
    startPolling(productId, run);
    await nextTick();
    graphCloseButton.value?.focus();
  } catch (error) {
    if (!isAbortError(error)) await handleMutationError(error, 'Prompt 批次启动失败');
  }
};

const regenerateItem = async (item: EffectPromptItem): Promise<void> => {
  const state = currentState.value;
  if (!state || currentRunning.value || state.settingsRevision === null) return;
  operationController?.abort();
  const controller = new AbortController();
  operationController = controller;
  operationItemId.value = item.id;
  try {
    const run = await beginEffectPromptRun(
      props.projectId,
      state.productId,
      {
        workflowRunId: props.workflowRunId,
        operation: 'ITEM_REGENERATE',
        targetItemId: item.id,
        expectedSettingsRevision: state.settingsRevision,
        ...(state.resultRevision === null ? {} : { expectedResultRevision: state.resultRevision }),
      },
      controller.signal,
    );
    updateRun(state.productId, run);
    graphDialogOpen.value = true;
    startPolling(state.productId, run);
  } catch (error) {
    if (!isAbortError(error)) await handleMutationError(error, '单条 Prompt 重新生成失败');
  } finally {
    operationItemId.value = '';
  }
};

async function handleMutationError(error: unknown, fallback: string): Promise<void> {
  if (error instanceof ApiClientError && error.status === 409) {
    showNotice('结果已在其他窗口更新，已重新载入最新版本', 'warning');
    await reloadWorkspace(false);
    return;
  }
  showNotice(safeMessage(error, fallback), 'error');
}

const openEditor = async (item?: EffectPromptItem, event?: Event): Promise<void> => {
  if (!currentState.value?.resultId || resultData.value === null) {
    showNotice('请先生成 Prompt 批次，再进行人工编辑', 'warning');
    return;
  }
  editorTrigger.value = event?.currentTarget instanceof HTMLElement ? event.currentTarget : null;
  editorMode.value = item ? 'edit' : 'add';
  editorItemId.value = item?.id ?? '';
  editorDraft.value = {
    content: item?.content ?? '',
    fragmentType: item?.fragmentType ?? '',
    dimensions: item ? { ...item.dimensions } : emptyDimensions(),
  };
  editorOpen.value = true;
  await nextTick();
  editorCloseButton.value?.focus();
};

const closeEditor = (): void => {
  if (editorSaving.value) return;
  editorOpen.value = false;
  const trigger = editorTrigger.value;
  editorTrigger.value = null;
  nextTick(() => trigger?.focus());
};

const commitEditor = async (): Promise<void> => {
  const state = currentState.value;
  const result = resultData.value;
  const draft = editorDraft.value;
  if (!state?.resultId || !result) return;
  if (!draft.content.trim() || !draft.fragmentType.trim()) {
    showNotice('请填写片段类型和 Prompt 内容', 'warning');
    return;
  }
  const missing = EFFECT_PROMPT_DIMENSIONS.find(({ key }) => !draft.dimensions[key].trim());
  if (missing) {
    showNotice(`请填写${missing.label}`, 'warning');
    return;
  }
  editorSaving.value = true;
  try {
    await saveEffectPromptItem(
      props.projectId,
      state.resultId,
      result.revision,
      {
        content: draft.content.trim(),
        fragmentType: draft.fragmentType.trim(),
        dimensions: Object.fromEntries(
          EFFECT_PROMPT_DIMENSIONS.map(({ key }) => [key, draft.dimensions[key].trim()]),
        ) as EffectPromptDimensions,
      },
      editorMode.value === 'edit' ? editorItemId.value : undefined,
    );
    editorOpen.value = false;
    showNotice(editorMode.value === 'edit' ? 'Prompt 修改已自动保存' : '人工 Prompt 已添加');
    await reloadWorkspace(false);
  } catch (error) {
    await handleMutationError(error, 'Prompt 保存失败');
  } finally {
    editorSaving.value = false;
  }
};

const removeItem = async (item: EffectPromptItem): Promise<void> => {
  const state = currentState.value;
  const result = resultData.value;
  if (!state?.resultId || !result || currentRunning.value) return;
  operationItemId.value = item.id;
  try {
    await removeEffectPromptItem(props.projectId, state.resultId, item, result.revision);
    showNotice(`${item.code} 已从节点草稿删除`, 'warning');
    await reloadWorkspace(false);
  } catch (error) {
    await handleMutationError(error, 'Prompt 删除失败');
  } finally {
    operationItemId.value = '';
  }
};

const copyItem = async (item: EffectPromptItem): Promise<void> => {
  try {
    await navigator.clipboard.writeText(item.content);
    showNotice(`${item.code} 已复制`);
  } catch {
    showNotice('浏览器未允许写入剪贴板，请在修改窗口手动复制', 'warning');
  }
};

const exportBatch = async (): Promise<void> => {
  const state = currentState.value;
  if (!state?.resultId || !currentProduct.value) return;
  exporting.value = true;
  try {
    const exported = await downloadEffectPromptBatch(
      props.projectId,
      state.resultId,
      currentProduct.value.name,
    );
    const url = URL.createObjectURL(exported.blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = exported.fileName;
    anchor.click();
    requestAnimationFrame(() => URL.revokeObjectURL(url));
    showNotice(`已从服务端导出 ${resultData.value?.total ?? 0} 条 Prompt`);
  } catch (error) {
    showNotice(safeMessage(error, 'Prompt 导出失败'), 'error');
  } finally {
    exporting.value = false;
  }
};

const validatePromptBatch = async (): Promise<void> => {
  const state = currentState.value;
  const result = resultData.value;
  if (!state?.resultId || !result || !currentQualityReady.value) {
    showNotice('当前批次仍未满足数量、六维差异或双重去重门槛', 'warning');
    return;
  }
  validating.value = true;
  try {
    const validation = await commitEffectPromptResult(
      props.projectId,
      state.resultId,
      result.revision,
    );
    if (!validation.valid) {
      showNotice(
        validation.issues.map((issue) => issue.message).join('；') || 'Prompt 校验未通过',
        'warning',
      );
      return;
    }
    showNotice(
      validation.allProductsValidated
        ? '全部产品 Prompt 工作副本已更新'
        : '当前产品 Prompt 工作副本已更新',
    );
    await reloadWorkspace(false);
  } catch (error) {
    await handleMutationError(error, 'Prompt 校验失败');
  } finally {
    validating.value = false;
  }
};

const graphExecution = (nodeId: EffectPromptNodeId): EffectPromptNodeExecution =>
  currentGraphNodes.value.find((node) => node.nodeId === nodeId)!;
const graphDefinition = (nodeId: EffectPromptNodeId) =>
  EFFECT_PROMPT_GRAPH_NODES.find((node) => node.id === nodeId)!;
const graphStatusMeta = (statusValue: EffectPromptStageStatus): { label: string; tone: string } =>
  ({
    PENDING: { label: '等待中', tone: 'pending' },
    RUNNING: { label: '执行中', tone: 'running' },
    SUCCEEDED: { label: '已完成', tone: 'success' },
    PARTIAL: { label: '部分完成', tone: 'warning' },
    SKIPPED: { label: '已跳过', tone: 'skipped' },
    FAILED: { label: '失败', tone: 'danger' },
  })[statusValue];
const graphDescription = (nodeId: EffectPromptNodeId): string =>
  ({
    LOAD_AND_SNAPSHOT: '冻结洞察工作副本、批次设置和人工保留内容',
    STRATEGY_PLANNING: '规划六维候选池并限制事实来源',
    DIMENSION_COMBINATION: '最大化六维组合之间的正交距离',
    CANDIDATE_GENERATION: '按分片生成分配好的候选 Prompt',
    NORMALIZATION: '校验并整理候选结构',
    SEMANTIC_DEDUP: '检测内容意图和文字近似重复',
    VISUAL_DEDUP: '计算场景、人物、镜头和情绪的结构化重合',
    QUALITY_GATE: '核对数量、差异距离和双重阈值',
    REPLENISH: '剔除相似候选后按缺口补齐',
    RESULT_SAVE: '保存最佳批次草稿和质量结论',
  })[nodeId];
const graphDependencies = (nodeId: EffectPromptNodeId): string =>
  EFFECT_PROMPT_GRAPH_EDGES.filter((edge) => edge.to === nodeId)
    .map((edge) => graphDefinition(edge.from).label)
    .join('、') || '无';

const openGraph = async (event?: Event): Promise<void> => {
  graphTrigger.value =
    event?.currentTarget instanceof HTMLButtonElement ? event.currentTarget : null;
  graphDialogOpen.value = true;
  graphError.value = '';
  const runId = currentState.value?.runId;
  if (runId && currentRun.value?.id !== runId) {
    graphLoading.value = true;
    try {
      const run = await loadEffectPromptRun(props.projectId, runId);
      updateRun(currentProductId.value, run);
    } catch (error) {
      graphError.value = safeMessage(error, '子工作流状态加载失败');
    } finally {
      graphLoading.value = false;
    }
  }
  await nextTick();
  graphCloseButton.value?.focus();
};

const closeGraph = (): void => {
  graphDialogOpen.value = false;
  graphDetailController?.abort();
  const trigger = graphTrigger.value;
  graphTrigger.value = null;
  nextTick(() => trigger?.focus());
};

const selectGraphNode = async (nodeId: EffectPromptNodeId): Promise<void> => {
  selectedGraphNodeId.value = nodeId;
  graphDetail.value = null;
  graphDetailError.value = '';
  const runId = currentRun.value?.id ?? currentState.value?.runId;
  if (!runId) return;
  graphDetailController?.abort();
  const controller = new AbortController();
  graphDetailController = controller;
  graphDetailLoading.value = true;
  try {
    graphDetail.value = await loadEffectPromptNodeDetail(
      props.projectId,
      runId,
      nodeId,
      controller.signal,
    );
  } catch (error) {
    if (!isAbortError(error)) graphDetailError.value = safeMessage(error, '节点详情加载失败');
  } finally {
    if (!controller.signal.aborted) graphDetailLoading.value = false;
  }
};

const formatPercent = (value: number | undefined): string => `${(value ?? 0).toFixed(1)}%`;
const flushPendingEdits = async (): Promise<boolean> => flushSettings();
defineExpose({ flushPendingEdits });

onBeforeUnmount(() => {
  disposed = true;
  workspaceGeneration += 1;
  resultGeneration += 1;
  workspaceController?.abort();
  resultController?.abort();
  settingsControllers.forEach((controller) => controller.abort());
  operationController?.abort();
  graphDetailController?.abort();
  pollControllers.forEach(({ controller }) => controller.abort());
  if (settingsTimer) clearTimeout(settingsTimer);
  if (searchTimer) clearTimeout(searchTimer);
  if (noticeTimer) clearTimeout(noticeTimer);
});
</script>

<template>
  <section class="effect-prompt-node" aria-labelledby="effect-prompt-title">
    <Transition name="prompt-notice">
      <div v-if="notice" class="prompt-notice" :class="notice.kind" role="status">
        {{ notice.text }}
      </div>
    </Transition>

    <section v-if="status === 'loading'" class="prompt-page-state" role="status">
      <LoaderCircle class="spin" :size="32" />
      <h2>正在恢复差异化 Prompt 工作区</h2>
      <p>载入服务端批次设置、生成任务、质量指标与节点草稿…</p>
    </section>
    <section v-else-if="status === 'error'" class="prompt-page-state error" role="alert">
      <AlertCircle :size="32" />
      <h2>Prompt 工作区加载失败</h2>
      <p>{{ loadError }}</p>
      <button type="button" @click="reloadWorkspace()"><RefreshCw :size="14" />重新加载</button>
    </section>
    <section v-else-if="!currentProduct || !currentState" class="prompt-page-state">
      <Sparkles :size="32" />
      <h2>暂无可生成 Prompt 的产品</h2>
      <p>请返回资料包导入节点补充产品，并完成 AI 信息提炼。</p>
      <button type="button" @click="emit('back')"><ChevronLeft :size="14" />返回上一步</button>
    </section>

    <template v-else>
      <header class="effect-prompt-heading">
        <div class="effect-prompt-heading__title">
          <span>03</span>
          <div>
            <h2 id="effect-prompt-title">差异化 Prompt 批量生成</h2>
            <p>
              默认 {{ currentSettings.count }} 条 ×
              {{ currentSettings.durationSeconds }} 秒，系统自动执行六维差异化组合与双重去重
            </p>
          </div>
        </div>
        <div class="effect-prompt-heading__actions">
          <button
            ref="graphTrigger"
            class="secondary-button"
            type="button"
            @click="openGraph($event)"
          >
            <Workflow :size="14" />查看生成子工作流
          </button>
          <label class="product-switcher">
            <span>当前商品</span>
            <select v-model="currentProductId">
              <option v-for="product in activeProducts" :key="product.id" :value="product.id">
                {{ product.name || '未命名产品' }}
              </option>
            </select>
          </label>
          <button
            class="primary-button heading-generate-button"
            type="button"
            :disabled="currentRunning || currentSaveStatus === 'saving'"
            @click="generateCurrentBatch"
          >
            <LoaderCircle v-if="currentRunning" class="spin" :size="14" />
            <RefreshCw v-else-if="currentState.resultId" :size="14" />
            <Sparkles v-else :size="14" />
            {{
              currentRunning
                ? `处理中 ${currentState.progress}%`
                : currentState.resultId
                  ? '重新批量生成'
                  : '开始批量生成'
            }}
          </button>
        </div>
      </header>

      <section v-if="currentRunning" class="run-progress" role="status">
        <div><span :style="{ width: `${currentState.progress}%` }" /></div>
        <p>
          {{
            currentState.status === 'QUEUED'
              ? '正在等待 Prompt 生成服务接单'
              : currentState.currentNode || '正在生成候选 Prompt'
          }}
        </p>
        <button type="button" @click="openGraph($event)">查看节点进度</button>
      </section>
      <section
        v-else-if="currentState.status === 'FAILED' || currentState.status === 'STALE'"
        class="prompt-state-alert"
        :class="{ error: currentState.status === 'FAILED' }"
        role="alert"
      >
        <AlertCircle :size="15" />
        <span>
          {{
            currentState.status === 'STALE'
              ? '上游信息卡或批次设置已更新，请重新生成当前产品的 Prompt。'
              : currentState.errorMessage || '本次 Prompt 生成失败，请查看子工作流节点后重试。'
          }}
        </span>
        <button type="button" @click="openGraph($event)">查看节点</button>
      </section>

      <section class="effect-prompt-settings" aria-label="批次设置">
        <div class="settings-heading">
          <h3>批次设置（仅以下参数可调）</h3>
          <span :class="currentSaveStatus">{{
            currentSaveStatus === 'saving'
              ? '正在保存'
              : currentSaveStatus === 'error'
                ? '保存失败'
                : currentState.settingsRevision === null
                  ? '待首次保存'
                  : '已自动保存'
          }}</span>
        </div>
        <label
          v-for="setting in [
            { key: 'count', label: '生成数量', hint: '默认 50 条' },
            { key: 'durationSeconds', label: '统一时长', hint: '秒' },
            { key: 'semanticLimit', label: '语义重复度上限', hint: '批内违规 Prompt 对占比' },
            { key: 'visualLimit', label: '画面重合度上限', hint: '生成前结构化代理指标' },
          ] as const"
          :key="setting.key"
          class="setting-card"
        >
          <span>{{ setting.label }}</span>
          <span class="number-control">
            <button
              type="button"
              :aria-label="`降低${setting.label}`"
              :disabled="
                currentRunning || currentSettings[setting.key] <= settingRange(setting.key).minimum
              "
              @click="adjustSetting(setting.key, -1)"
            >
              −
            </button>
            <input
              v-model.number="settingsDrafts[currentProductId]![setting.key]"
              type="number"
              :min="settingRange(setting.key).minimum"
              :max="settingRange(setting.key).maximum"
              :disabled="currentRunning"
              @input="queueSettingsSave"
              @blur="flushSettings()"
            />
            <button
              type="button"
              :aria-label="`提高${setting.label}`"
              :disabled="
                currentRunning || currentSettings[setting.key] >= settingRange(setting.key).maximum
              "
              @click="adjustSetting(setting.key, 1)"
            >
              ＋
            </button>
          </span>
          <small>{{ setting.hint }}</small>
        </label>
      </section>

      <section class="effect-prompt-stats" aria-label="质量统计">
        <article class="coral">
          <span>已接收 Prompt</span><strong>{{ currentMetrics?.acceptedCount ?? 0 }}</strong
          ><small>目标 {{ currentSettings.count }} 条</small>
        </article>
        <article class="amber">
          <span>自动剔除方案</span
          ><strong>{{
            (currentMetrics?.removedSemanticDuplicates ?? 0) +
            (currentMetrics?.removedVisualDuplicates ?? 0) +
            (currentMetrics?.removedDimensionConflicts ?? 0)
          }}</strong
          ><small
            >补齐 {{ currentMetrics?.replenishmentRounds ?? 0 }} /
            {{ EFFECT_PROMPT_LIMITS.maxReplenishmentRounds }} 轮</small
          >
        </article>
        <article class="cyan">
          <span>当前语义重复度</span
          ><strong>{{ formatPercent(currentMetrics?.semanticDuplicateRate) }}</strong
          ><small>目标 ≤ {{ currentSettings.semanticLimit }}%</small>
        </article>
        <article class="violet">
          <span>当前画面重合度</span
          ><strong>{{ formatPercent(currentMetrics?.visualOverlapRate) }}</strong
          ><small>结构化代理指标 · 目标 ≤ {{ currentSettings.visualLimit }}%</small>
        </article>
      </section>

      <section class="effect-prompt-list" aria-label="Prompt 生成结果">
        <div class="effect-prompt-toolbar">
          <label class="prompt-search"
            ><Search :size="15" /><input
              v-model="keyword"
              type="search"
              placeholder="搜索提示词（ID / 内容 / 六维标签）"
          /></label>
          <span class="prompt-result-count">{{ resultData?.total ?? 0 }} 条</span>
          <button
            class="primary-button"
            type="button"
            :disabled="!currentState.resultId || currentRunning"
            @click="openEditor(undefined, $event)"
          >
            <Plus :size="15" />人工添加提示词
          </button>
          <button
            class="primary-button"
            type="button"
            :disabled="!currentState.resultId || exporting"
            @click="exportBatch"
          >
            <LoaderCircle v-if="exporting" class="spin" :size="15" /><Download
              v-else
              :size="15"
            />批量导出
          </button>
        </div>

        <div v-if="resultLoading" class="prompt-empty-state" role="status">
          <LoaderCircle class="spin" :size="25" /><strong>正在加载 Prompt</strong>
        </div>
        <div v-else-if="!currentItems.length" class="prompt-empty-state">
          <Search :size="25" /><strong>{{
            currentState.resultId ? '没有匹配的 Prompt' : '尚未生成 Prompt'
          }}</strong
          ><span>{{
            currentState.resultId
              ? '请调整搜索词，或人工补充新的 Prompt。'
              : '完成信息提炼后，点击开始批量生成。'
          }}</span>
        </div>

        <article v-for="(item, index) in currentItems" v-else :key="item.id" class="prompt-card">
          <span class="prompt-number">{{
            String((page - 1) * EFFECT_PROMPT_LIMITS.pageSize + index + 1).padStart(2, '0')
          }}</span>
          <div class="prompt-main">
            <header>
              <strong>{{ item.code }}</strong
              ><span
                ><i v-if="item.manualEdited || item.origin === 'MANUAL'">人工</i
                ><em>片段类型 · {{ item.fragmentType }}</em></span
              >
            </header>
            <div class="prompt-dimensions">
              <small>差异化标签</small
              ><span v-for="dimension in EFFECT_PROMPT_DIMENSIONS" :key="dimension.key"
                ><b>{{ dimension.label }}：</b>{{ item.dimensions[dimension.key] }}</span
              >
            </div>
            <textarea :value="item.content" readonly aria-label="Prompt 内容" />
          </div>
          <div class="prompt-actions">
            <button type="button" :disabled="currentRunning" @click="openEditor(item, $event)">
              <Pencil :size="13" />修改
            </button>
            <button type="button" @click="copyItem(item)"><Copy :size="13" />复制</button>
            <button
              class="danger"
              type="button"
              :disabled="currentRunning || operationItemId === item.id"
              @click="removeItem(item)"
            >
              <LoaderCircle v-if="operationItemId === item.id" class="spin" :size="13" /><Trash2
                v-else
                :size="13"
              />删除
            </button>
            <button type="button" :disabled="currentRunning" @click="regenerateItem(item)">
              <LoaderCircle v-if="operationItemId === item.id" class="spin" :size="13" /><RefreshCw
                v-else
                :size="13"
              />重新生成
            </button>
          </div>
        </article>

        <div class="prompt-pagination">
          <span>{{ EFFECT_PROMPT_LIMITS.pageSize }} 条/页</span
          ><button type="button" :disabled="page <= 1 || resultLoading" @click="page -= 1">
            <ChevronLeft :size="14" />上一页</button
          ><strong>第 {{ page }} / {{ totalPages }} 页</strong
          ><button type="button" :disabled="page >= totalPages || resultLoading" @click="page += 1">
            下一页<ChevronRight :size="14" />
          </button>
        </div>
      </section>

      <WorkflowNodeDraftBar
        :detail="`${currentProduct.name} · ${resultData?.total ?? 0} 条 Prompt · ${currentState.commitStatus === 'COMMITTED' ? '已提交工作副本，尚未归档' : '已自动保存到节点草稿，尚未提交工作副本'}`"
        :state="
          currentRunning || currentSaveStatus === 'saving'
            ? 'saving'
            : currentState.commitStatus === 'COMMITTED'
              ? 'saved'
              : 'dirty'
        "
        :state-label="
          currentRunning
            ? '正在生成…'
            : currentSaveStatus === 'saving'
              ? '正在保存'
              : currentState.commitStatus === 'COMMITTED'
                ? '工作副本已更新'
                : currentState.commitStatus === 'STALE'
                  ? '上游更新，结果已过期'
                  : currentState.qualityStatus === 'NEEDS_REVIEW'
                    ? '结果需调整'
                    : '草稿已自动保存'
        "
        title="差异化 Prompt 批次草稿"
      />

      <WorkflowNodeFooter
        back-label="上一步"
        :complete="allProductsCommitted"
        :status-title="
          allProductsCommitted ? '全部产品 Prompt 工作副本已更新' : '请逐个完成产品 Prompt 校验'
        "
        :status-detail="`步骤 3 / 6 · ${currentProduct.name} · ${currentState.commitStatus === 'COMMITTED' ? '当前工作副本' : '尚未提交工作副本'}`"
        :validate-disabled="currentRunning || validating || !currentQualityReady"
        :next-disabled="!allProductsCommitted || currentRunning"
        next-label="下一步：片段渲染"
        @back="emit('back')"
        @validate="validatePromptBatch"
        @next="emit('next')"
      />
    </template>

    <Teleport to="body">
      <div v-if="editorOpen" class="prompt-dialog-backdrop" @mousedown.self="closeEditor">
        <section
          class="prompt-editor-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="prompt-editor-title"
          @keydown.esc="closeEditor"
        >
          <header>
            <div>
              <span>{{ editorMode === 'add' ? '人工补充' : '节点草稿编辑' }}</span>
              <h2 id="prompt-editor-title">
                {{ editorMode === 'add' ? '添加提示词' : '修改提示词' }}
              </h2>
            </div>
            <button
              ref="editorCloseButton"
              type="button"
              aria-label="关闭 Prompt 编辑窗口"
              @click="closeEditor"
            >
              <X :size="17" />
            </button>
          </header>
          <div class="editor-grid">
            <label
              ><span>片段类型</span
              ><input
                v-model="editorDraft.fragmentType"
                list="prompt-fragments"
                placeholder="请选择或输入片段类型" /><datalist id="prompt-fragments">
                <option
                  v-for="value in fragmentSuggestions"
                  :key="value"
                  :value="value"
                /></datalist
            ></label>
            <label v-for="dimension in EFFECT_PROMPT_DIMENSIONS" :key="dimension.key"
              ><span>{{ dimension.label }}</span
              ><input
                v-model="editorDraft.dimensions[dimension.key]"
                :list="`prompt-dimension-${dimension.key}`"
                :placeholder="`请选择或输入${dimension.label}`" /><datalist
                :id="`prompt-dimension-${dimension.key}`"
              >
                <option
                  v-for="value in dimensionSuggestions[dimension.key]"
                  :key="value"
                  :value="value"
                /></datalist
            ></label>
          </div>
          <label class="editor-content"
            ><span>Prompt 内容</span
            ><textarea v-model="editorDraft.content" placeholder="请输入结构化视频 Prompt" />
          </label>
          <footer>
            <button type="button" :disabled="editorSaving" @click="closeEditor">取消</button
            ><button
              class="primary-button"
              type="button"
              :disabled="editorSaving"
              @click="commitEditor"
            >
              <LoaderCircle v-if="editorSaving" class="spin" :size="14" />{{
                editorMode === 'add' ? '添加到节点草稿' : '保存修改'
              }}
            </button>
          </footer>
        </section>
      </div>

      <div v-if="graphDialogOpen" class="prompt-dialog-backdrop" @mousedown.self="closeGraph">
        <section
          class="workflow-graph-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="prompt-graph-title"
          tabindex="-1"
          @keydown.esc="closeGraph"
        >
          <header>
            <div>
              <span>PROMPT SUB-WORKFLOW</span>
              <h2 id="prompt-graph-title">差异化 Prompt 生成子工作流</h2>
              <p>节点详情仅展示批次数量、分片进度、剔除数量、补齐轮次与安全告警。</p>
            </div>
            <button
              ref="graphCloseButton"
              type="button"
              aria-label="关闭子工作流"
              @click="closeGraph"
            >
              <X :size="17" />
            </button>
          </header>
          <div v-if="graphLoading" class="graph-message">
            <LoaderCircle class="spin" :size="14" />正在恢复真实节点进度…
          </div>
          <div v-if="graphError" class="graph-message error">
            <AlertCircle :size="14" />{{ graphError }}
          </div>
          <div class="workflow-graph-content">
            <div class="workflow-graph-canvas">
              <template v-for="(row, rowIndex) in graphRows" :key="rowIndex">
                <div v-if="rowIndex" class="graph-connector"><i /></div>
                <div class="graph-row" :class="{ parallel: row.length > 1 }">
                  <button
                    v-for="nodeId in row"
                    :key="nodeId"
                    class="graph-node"
                    :class="`is-${graphStatusMeta(graphExecution(nodeId).status).tone}`"
                    type="button"
                    :aria-pressed="selectedGraphNodeId === nodeId"
                    @click="selectGraphNode(nodeId)"
                  >
                    <span class="node-dot" /><span
                      ><strong>{{ graphDefinition(nodeId).label }}</strong
                      ><small>{{ graphDescription(nodeId) }}</small></span
                    ><em>{{ graphStatusMeta(graphExecution(nodeId).status).label }}</em>
                  </button>
                </div>
              </template>
            </div>
            <aside class="workflow-node-detail">
              <div v-if="!selectedGraphNodeId" class="node-detail-empty">
                <Workflow :size="30" /><strong>选择节点查看安全详情</strong>
                <p>不会显示模型、Prompt 模板、原始响应或内部存储标识。</p>
              </div>
              <template v-else>
                <header>
                  <div>
                    <span>NODE DETAIL</span
                    ><strong>{{ graphDefinition(selectedGraphNodeId).label }}</strong>
                  </div>
                  <em>{{ graphStatusMeta(graphExecution(selectedGraphNodeId).status).label }}</em>
                </header>
                <p class="node-summary">
                  {{
                    graphDetail?.summary ||
                    graphExecution(selectedGraphNodeId).summary ||
                    graphDescription(selectedGraphNodeId)
                  }}
                </p>
                <div v-if="graphDetailLoading" class="graph-message">
                  <LoaderCircle class="spin" :size="13" />正在加载节点详情…
                </div>
                <div v-if="graphDetailError" class="graph-message error">
                  <AlertCircle :size="13" />{{ graphDetailError }}
                </div>
                <dl class="node-fields">
                  <div>
                    <dt>上游节点</dt>
                    <dd>{{ graphDependencies(selectedGraphNodeId) }}</dd>
                  </div>
                  <div v-for="field in graphDetail?.fields ?? []" :key="field.label">
                    <dt>{{ field.label }}</dt>
                    <dd>{{ field.value }}</dd>
                  </div>
                </dl>
                <div
                  v-for="warning in graphDetail?.warnings ??
                  graphExecution(selectedGraphNodeId).warnings"
                  :key="warning"
                  class="node-warning"
                >
                  <AlertCircle :size="12" />{{ warning }}
                </div>
                <div
                  v-if="
                    graphDetail?.errorMessage || graphExecution(selectedGraphNodeId).errorMessage
                  "
                  class="node-warning error"
                >
                  <AlertCircle :size="12" />{{
                    graphDetail?.errorMessage || graphExecution(selectedGraphNodeId).errorMessage
                  }}
                </div>
              </template>
            </aside>
          </div>
          <footer>
            <span><i class="running" />执行中</span><span><i class="success" />已完成</span
            ><span><i class="warning" />需关注</span><span><i class="danger" />失败</span
            ><span class="edge-count">{{ EFFECT_PROMPT_GRAPH_EDGES.length }} 条执行边</span
            ><button type="button" @click="closeGraph">
              <CheckCircle2 :size="14" />返回工作区
            </button>
          </footer>
        </section>
      </div>
    </Teleport>
  </section>
</template>

<style scoped>
.effect-prompt-node {
  --effect-blue: #2563eb;
  position: relative;
  margin-top: 18px;
  padding: 28px;
  color: #253047;
  background: #fff;
  border: 1px solid #dbe4f6;
  border-radius: 26px;
  box-shadow: 0 12px 34px #7a4e3b12;
}
.prompt-notice {
  position: fixed;
  top: 145px;
  right: 24px;
  z-index: 1300;
  max-width: 420px;
  padding: 11px 15px;
  color: #245643;
  background: #effaf5;
  border: 1px solid #b7e3d3;
  border-radius: 10px;
  box-shadow: 0 12px 30px #1a2a4430;
  font-size: 11px;
  font-weight: 800;
}
.prompt-notice.warning {
  color: #926123;
  background: #fff9eb;
  border-color: #f3d69a;
}
.prompt-notice.error {
  color: #a84148;
  background: #fff3f2;
  border-color: #f3c6c4;
}
.prompt-notice-enter-active,
.prompt-notice-leave-active {
  transition: 0.2s ease;
}
.prompt-notice-enter-from,
.prompt-notice-leave-to {
  opacity: 0;
  transform: translateY(-7px);
}
.prompt-page-state {
  display: flex;
  min-height: 420px;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  color: #7f8da2;
  text-align: center;
}
.prompt-page-state > svg {
  color: var(--effect-blue);
}
.prompt-page-state.error > svg {
  color: #d65355;
}
.prompt-page-state h2 {
  margin: 13px 0 5px;
  color: #34445c;
  font-size: 18px;
}
.prompt-page-state p {
  margin: 0;
  font-size: 11px;
}
.prompt-page-state button,
.secondary-button,
.primary-button {
  display: inline-flex;
  height: 40px;
  padding: 0 18px;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border-radius: 10px;
  font-size: 13px;
  font-weight: 700;
}
.prompt-page-state button,
.secondary-button {
  color: #42526a;
  background: #fff;
  border: 1px solid #dbe4f6;
}
.primary-button {
  color: #fff;
  background: var(--effect-blue);
  border: 1px solid var(--effect-blue);
  box-shadow: 0 8px 18px #2563eb2e;
}
button:disabled {
  cursor: not-allowed;
  opacity: 0.52;
}
.effect-prompt-heading {
  display: flex;
  min-height: 50px;
  margin-bottom: 22px;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
}
.effect-prompt-heading__title {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 16px;
}
.effect-prompt-heading__title > span {
  display: grid;
  width: 42px;
  height: 42px;
  flex: 0 0 42px;
  place-items: center;
  color: #7658d5;
  background: #f3f0ff;
  border-radius: 13px;
  font-size: 12px;
  font-weight: 900;
}
.effect-prompt-heading h2,
.effect-prompt-heading p {
  margin: 0;
}
.effect-prompt-heading h2 {
  color: #172033;
  font-size: 21px;
}
.effect-prompt-heading p {
  margin-top: 5px;
  color: #7d899d;
  font-size: 13px;
}
.effect-prompt-heading__actions {
  display: flex;
  align-items: center;
  gap: 10px;
}
.product-switcher {
  display: flex;
  align-items: center;
  gap: 9px;
  color: #596278;
  font-size: 13px;
  font-weight: 700;
  white-space: nowrap;
}
.product-switcher select {
  width: 170px;
  height: 40px;
  padding: 0 34px 0 13px;
  color: #42526a;
  background: #fff;
  border: 1px solid #dbe4f6;
  border-radius: 10px;
}
.heading-generate-button {
  min-width: 160px;
}
.run-progress {
  display: grid;
  margin: -7px 0 18px;
  padding: 11px 14px;
  grid-template-columns: minmax(120px, 1fr) auto auto;
  align-items: center;
  gap: 12px;
  color: #53647b;
  background: #f4f8ff;
  border: 1px solid #d8e5ff;
  border-radius: 12px;
  font-size: 11px;
}
.run-progress > div {
  height: 6px;
  overflow: hidden;
  background: #dbe7fa;
  border-radius: 99px;
}
.run-progress > div span {
  display: block;
  height: 100%;
  background: #2563eb;
  border-radius: inherit;
  transition: width 0.25s;
}
.run-progress p {
  margin: 0;
}
.run-progress button {
  color: #2563eb;
  background: transparent;
  border: 0;
  font-weight: 800;
}
.prompt-state-alert {
  display: flex;
  margin: -7px 0 18px;
  padding: 10px 12px;
  align-items: center;
  gap: 8px;
  color: #94630b;
  background: #fff8e8;
  border: 1px solid #f0d69a;
  border-radius: 11px;
  font-size: 11px;
}
.prompt-state-alert.error {
  color: #b83246;
  background: #fff1f2;
  border-color: #efc4cb;
}
.prompt-state-alert span {
  flex: 1;
}
.prompt-state-alert button {
  color: inherit;
  background: transparent;
  border: 0;
  font-weight: 800;
}
.effect-prompt-settings {
  display: grid;
  min-height: 149px;
  padding: 18px 20px;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  align-items: center;
  gap: 12px;
  background: #fff;
  border: 1px solid #f0e3dc;
  border-radius: 18px;
}
.settings-heading {
  display: flex;
  grid-column: 1/-1;
  align-items: center;
  justify-content: space-between;
}
.settings-heading h3 {
  margin: 0;
  font-size: 15px;
}
.settings-heading span {
  color: #2d8b6f;
  font-size: 10px;
  font-weight: 800;
}
.settings-heading span.saving {
  color: #2563eb;
}
.settings-heading span.error {
  color: #d65355;
}
.setting-card {
  display: grid;
  min-width: 0;
  min-height: 62px;
  padding: 10px 12px;
  grid-template-columns: minmax(86px, 1fr) 140px;
  align-items: center;
  gap: 4px 10px;
  color: #58657a;
  background: #f8fbff;
  border: 1px solid #e5eaf2;
  border-radius: 12px;
  font-size: 12px;
}
.setting-card > span:first-child {
  font-weight: 700;
}
.setting-card > small {
  grid-column: 1;
  color: #98a3b5;
  font-size: 9px;
}
.number-control {
  display: grid;
  height: 32px;
  grid-row: 1/3;
  grid-column: 2;
  grid-template-columns: 32px minmax(50px, 1fr) 32px;
  overflow: hidden;
  background: #fff;
  border: 1px solid #dfe6f0;
  border-radius: 8px;
}
.number-control button,
.number-control input {
  min-width: 0;
  color: #647187;
  background: #fff;
  border: 0;
  text-align: center;
}
.number-control button {
  background: #f6f8fb;
  font-size: 15px;
}
.number-control input {
  width: 100%;
  border-right: 1px solid #e3e8f0;
  border-left: 1px solid #e3e8f0;
  outline: none;
  appearance: textfield;
  font-size: 12px;
}
.number-control input::-webkit-inner-spin-button {
  appearance: none;
}
.effect-prompt-stats {
  display: grid;
  margin-top: 18px;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
}
.effect-prompt-stats article {
  display: flex;
  min-height: 109px;
  padding: 16px 18px;
  flex-direction: column;
  border: 1px solid transparent;
  border-radius: 16px;
}
.effect-prompt-stats span {
  color: #838b9b;
  font-size: 11px;
}
.effect-prompt-stats strong {
  margin-top: 8px;
  font-size: 28px;
  line-height: 1;
}
.effect-prompt-stats small {
  margin-top: 7px;
  color: #8a94a6;
  font-size: 10px;
}
.effect-prompt-stats .coral {
  color: #e34850;
  background: #eef3ff;
  border-color: #dae4fb;
}
.effect-prompt-stats .amber {
  color: #b77a0e;
  background: #fff8e9;
  border-color: #f4e3b9;
}
.effect-prompt-stats .cyan {
  color: #18839c;
  background: #eefbfe;
  border-color: #d2edf3;
}
.effect-prompt-stats .violet {
  color: #6f50c4;
  background: #f5f1ff;
  border-color: #e4dbfa;
}
.effect-prompt-list {
  display: flex;
  margin-top: 18px;
  flex-direction: column;
  gap: 10px;
}
.effect-prompt-toolbar {
  display: flex;
  min-height: 42px;
  align-items: center;
  gap: 12px;
  scroll-margin-top: 84px;
}
.prompt-search {
  display: flex;
  width: min(415px, 40%);
  height: 40px;
  padding: 0 12px;
  align-items: center;
  gap: 8px;
  color: #7390b3;
  background: #fff;
  border: 1px solid #dbe4f6;
  border-radius: 10px;
}
.prompt-search input {
  min-width: 0;
  flex: 1;
  color: #42526a;
  background: transparent;
  border: 0;
  outline: none;
  font-size: 13px;
}
.prompt-result-count {
  margin-right: auto;
  color: #8b95a5;
  font-size: 12px;
}
.prompt-card {
  display: grid;
  min-width: 0;
  padding: 15px;
  grid-template-columns: 43px minmax(0, 1fr) 134px;
  gap: 12px;
  background: #fff;
  border: 1px solid #f0e2db;
  border-radius: 16px;
}
.prompt-number {
  display: grid;
  width: 38px;
  height: 38px;
  place-items: center;
  color: #e24b50;
  background: #eef3ff;
  border-radius: 12px;
  font-size: 12px;
  font-weight: 900;
}
.prompt-main {
  min-width: 0;
}
.prompt-main > header {
  display: flex;
  min-height: 22px;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.prompt-main > header strong {
  color: #5b6980;
  font-size: 12px;
}
.prompt-main > header > span {
  display: flex;
  align-items: center;
  gap: 6px;
}
.prompt-main > header i,
.prompt-main > header em {
  min-height: 22px;
  padding: 2px 8px;
  border-radius: 5px;
  font-size: 10px;
  font-style: normal;
  font-weight: 700;
}
.prompt-main > header i {
  color: #7658d5;
  background: #f3f0ff;
}
.prompt-main > header em {
  color: #ef5366;
  background: #fffafa;
  border: 1px solid #ffb9bd;
}
.prompt-dimensions {
  display: flex;
  margin: 6px 0 9px;
  align-items: center;
  flex-wrap: wrap;
  gap: 5px;
}
.prompt-dimensions > small {
  margin-right: 2px;
  color: #7b8798;
  font-size: 10px;
  font-weight: 700;
}
.prompt-dimensions > span {
  display: inline-flex;
  min-height: 24px;
  padding: 0 8px;
  align-items: center;
  color: #253047;
  background: #f4f8ff;
  border: 1px solid #cfe0ff;
  border-radius: 999px;
  font-size: 10px;
  white-space: nowrap;
}
.prompt-dimensions b {
  color: #2f6fed;
}
.prompt-main > textarea {
  width: 100%;
  min-height: 220px;
  padding: 10px 14px;
  resize: none;
  overflow: hidden;
  color: #5b6270;
  background: #fff;
  border: 1px solid #dfe4eb;
  border-radius: 10px;
  font-family: inherit;
  font-size: 13px;
  line-height: 1.78;
}
.prompt-actions {
  display: grid;
  grid-template-columns: 56px 73px;
  align-content: center;
  gap: 6px;
}
.prompt-actions button {
  display: inline-flex;
  min-width: 0;
  height: 31px;
  padding: 0 8px;
  align-items: center;
  justify-content: center;
  gap: 4px;
  color: #46556c;
  background: #fff;
  border: 1px solid #dfe5ed;
  border-radius: 8px;
  font-size: 10px;
  font-weight: 700;
}
.prompt-actions button.danger {
  color: #df4d58;
  border-color: #f1cbd0;
}
.prompt-empty-state {
  display: flex;
  min-height: 210px;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: 7px;
  color: #8a97aa;
  background: #fbfdff;
  border: 1px dashed #cedaeb;
  border-radius: 16px;
}
.prompt-empty-state strong {
  color: #52617a;
  font-size: 14px;
}
.prompt-empty-state span {
  font-size: 11px;
}
.prompt-pagination {
  display: flex;
  min-height: 61px;
  margin-top: 2px;
  padding: 10px 14px;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  color: #7d899d;
  border-top: 1px solid #f0f2f5;
  font-size: 12px;
}
.prompt-pagination > span,
.prompt-pagination button {
  display: inline-flex;
  height: 40px;
  padding: 0 12px;
  align-items: center;
  justify-content: center;
  gap: 4px;
  color: #5b6679;
  background: #fff;
  border: 1px solid #dfe5ed;
  border-radius: 10px;
}
.prompt-pagination > span {
  min-width: 108px;
}
.prompt-dialog-backdrop {
  position: fixed;
  z-index: 1200;
  inset: 0;
  display: grid;
  padding: 20px;
  place-items: center;
  background: #0f172a66;
  backdrop-filter: blur(3px);
}
.prompt-editor-dialog,
.workflow-graph-dialog {
  width: min(920px, 100%);
  max-height: calc(100vh - 40px);
  overflow: auto;
  background: #fff;
  border: 1px solid #dbe4f6;
  border-radius: 20px;
  box-shadow: 0 24px 70px #0f172a38;
}
.prompt-editor-dialog {
  padding: 22px;
}
.prompt-editor-dialog > header,
.workflow-graph-dialog > header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
}
.prompt-editor-dialog > header {
  margin-bottom: 18px;
}
.prompt-editor-dialog header span,
.workflow-graph-dialog > header span {
  color: #6f50c4;
  font-size: 10px;
  font-weight: 900;
  letter-spacing: 0.08em;
}
.prompt-editor-dialog h2,
.workflow-graph-dialog h2 {
  margin: 4px 0 0;
  color: #1d2940;
  font-size: 20px;
}
.prompt-editor-dialog > header button,
.workflow-graph-dialog > header button {
  display: grid;
  width: 34px;
  height: 34px;
  place-items: center;
  color: #64748b;
  background: #f7f9fc;
  border: 1px solid #dfe6f0;
  border-radius: 9px;
}
.editor-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 11px;
}
.prompt-editor-dialog label > span {
  display: block;
  margin-bottom: 6px;
  color: #4d5b72;
  font-size: 11px;
  font-weight: 800;
}
.prompt-editor-dialog input,
.prompt-editor-dialog textarea {
  width: 100%;
  padding: 0 11px;
  color: #4e5b70;
  border: 1px solid #dbe4f6;
  border-radius: 10px;
  outline: none;
  font-family: inherit;
  font-size: 12px;
}
.prompt-editor-dialog input {
  height: 39px;
}
.prompt-editor-dialog textarea {
  min-height: 210px;
  padding: 11px;
  resize: vertical;
  line-height: 1.7;
}
.editor-content {
  display: block;
  margin-top: 13px;
}
.prompt-editor-dialog input:focus,
.prompt-editor-dialog textarea:focus {
  border-color: #7da4ff;
  box-shadow: 0 0 0 3px #2563eb14;
}
.prompt-editor-dialog > footer {
  display: flex;
  margin-top: 16px;
  justify-content: flex-end;
  gap: 8px;
}
.prompt-editor-dialog > footer button {
  height: 38px;
  padding: 0 16px;
  color: #536178;
  background: #fff;
  border: 1px solid #dbe4f6;
  border-radius: 9px;
  font-size: 12px;
  font-weight: 800;
}
.prompt-editor-dialog > footer .primary-button {
  color: #fff;
  background: var(--effect-blue);
  border-color: var(--effect-blue);
}
.workflow-graph-dialog {
  width: min(1120px, 100%);
  background: #f8faff;
}
.workflow-graph-dialog > header {
  position: sticky;
  z-index: 2;
  top: 0;
  padding: 20px 22px;
  background: #ffffffed;
  border-bottom: 1px solid #dbe4f6;
}
.workflow-graph-dialog > header p {
  margin: 5px 0 0;
  color: #718096;
  font-size: 11px;
}
.graph-message {
  display: flex;
  margin: 12px 16px 0;
  padding: 8px 10px;
  align-items: center;
  gap: 6px;
  color: #2563eb;
  background: #edf4ff;
  border-radius: 8px;
  font-size: 10px;
}
.graph-message.error {
  color: #b83246;
  background: #fff1f2;
}
.workflow-graph-content {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 320px;
  align-items: start;
}
.workflow-graph-canvas {
  padding: 20px;
}
.graph-row {
  display: grid;
  grid-template-columns: 1fr;
  gap: 10px;
}
.graph-row.parallel {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}
.graph-node {
  display: grid;
  min-width: 0;
  padding: 12px;
  grid-template-columns: 12px minmax(0, 1fr) auto;
  align-items: start;
  gap: 9px;
  color: #33415a;
  text-align: left;
  background: #fff;
  border: 1px solid #dbe4f6;
  border-radius: 13px;
}
.graph-node:hover,
.graph-node[aria-pressed='true'] {
  border-color: #81a9f5;
  box-shadow: 0 0 0 3px #dbeafe;
}
.graph-node > span:nth-child(2) {
  display: grid;
  gap: 4px;
}
.graph-node strong {
  font-size: 12px;
}
.graph-node small {
  color: #7d899f;
  font-size: 9px;
  line-height: 1.5;
}
.graph-node em {
  padding: 4px 7px;
  color: #718096;
  background: #f1f4f8;
  border-radius: 99px;
  font-size: 8px;
  font-style: normal;
  font-weight: 800;
}
.node-dot {
  width: 9px;
  height: 9px;
  margin-top: 4px;
  background: #a7b0bf;
  border: 2px solid #eef1f5;
  border-radius: 99px;
  box-sizing: content-box;
}
.graph-node.is-running {
  background: #f7faff;
  border-color: #91b7ff;
}
.graph-node.is-running .node-dot {
  background: #2563eb;
  border-color: #dbeafe;
  animation: pulse-node 1.2s infinite;
}
.graph-node.is-success .node-dot {
  background: #0f9f78;
  border-color: #ddf6ee;
}
.graph-node.is-warning .node-dot,
.graph-node.is-skipped .node-dot {
  background: #d99a22;
  border-color: #fff4d8;
}
.graph-node.is-danger .node-dot {
  background: #dc3f52;
  border-color: #ffe4e8;
}
.graph-connector {
  display: grid;
  height: 19px;
  place-items: center;
}
.graph-connector i {
  width: 1px;
  height: 100%;
  background: #b9c8df;
}
.workflow-node-detail {
  position: sticky;
  top: 95px;
  min-height: 470px;
  max-height: 640px;
  margin: 20px 20px 20px 0;
  padding: 16px;
  overflow: auto;
  background: #fff;
  border: 1px solid #dbe4f6;
  border-radius: 16px;
}
.node-detail-empty {
  display: grid;
  min-height: 430px;
  place-content: center;
  justify-items: center;
  color: #7d899f;
  text-align: center;
}
.node-detail-empty strong {
  margin-top: 10px;
  color: #33415a;
  font-size: 13px;
}
.node-detail-empty p {
  max-width: 230px;
  font-size: 10px;
  line-height: 1.65;
}
.workflow-node-detail > header {
  display: flex;
  padding-bottom: 12px;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid #e7edf8;
}
.workflow-node-detail > header span,
.workflow-node-detail > header strong {
  display: block;
}
.workflow-node-detail > header span {
  color: #2563eb;
  font-size: 9px;
  font-weight: 850;
}
.workflow-node-detail > header strong {
  margin-top: 4px;
  font-size: 14px;
}
.workflow-node-detail > header em {
  padding: 4px 7px;
  background: #edf4ff;
  border-radius: 99px;
  font-size: 8px;
  font-style: normal;
}
.node-summary {
  color: #5f6d82;
  font-size: 10px;
  line-height: 1.65;
}
.node-fields {
  display: grid;
  gap: 7px;
}
.node-fields > div {
  padding: 8px 9px;
  background: #f7f9fd;
  border-radius: 8px;
}
.node-fields dt {
  color: #7b879a;
  font-size: 8px;
}
.node-fields dd {
  margin: 5px 0 0;
  overflow-wrap: anywhere;
  color: #33415a;
  font-size: 10px;
  font-weight: 700;
}
.node-warning {
  display: flex;
  margin-top: 8px;
  padding: 7px;
  gap: 6px;
  color: #956109;
  background: #fff8e8;
  border-radius: 7px;
  font-size: 9px;
}
.node-warning.error {
  color: #bd3346;
  background: #fff1f2;
}
.workflow-graph-dialog > footer {
  display: flex;
  padding: 13px 20px 18px;
  align-items: center;
  gap: 12px;
  color: #718096;
  font-size: 9px;
}
.workflow-graph-dialog > footer span {
  display: flex;
  align-items: center;
  gap: 5px;
}
.workflow-graph-dialog > footer i {
  width: 7px;
  height: 7px;
  background: #a7b0bf;
  border-radius: 99px;
}
.workflow-graph-dialog > footer i.running {
  background: #2563eb;
}
.workflow-graph-dialog > footer i.success {
  background: #0f9f78;
}
.workflow-graph-dialog > footer i.warning {
  background: #d99a22;
}
.workflow-graph-dialog > footer i.danger {
  background: #dc3f52;
}
.workflow-graph-dialog > footer .edge-count {
  margin-left: auto;
}
.workflow-graph-dialog > footer button {
  display: inline-flex;
  height: 34px;
  padding: 0 13px;
  align-items: center;
  gap: 5px;
  color: #fff;
  background: #2563eb;
  border: 0;
  border-radius: 9px;
  font-size: 10px;
  font-weight: 800;
}
.spin {
  animation: prompt-spin 0.75s linear infinite;
}
@keyframes prompt-spin {
  to {
    transform: rotate(360deg);
  }
}
@keyframes pulse-node {
  50% {
    opacity: 0.45;
    transform: scale(0.78);
  }
}
@media (max-width: 1100px) {
  .effect-prompt-heading,
  .effect-prompt-toolbar {
    align-items: stretch;
    flex-wrap: wrap;
  }
  .effect-prompt-heading__actions {
    width: 100%;
    flex-wrap: wrap;
  }
  .effect-prompt-settings {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .prompt-search {
    width: 100%;
  }
  .prompt-result-count {
    margin-right: auto;
  }
  .prompt-card {
    grid-template-columns: 43px minmax(0, 1fr);
  }
  .prompt-actions {
    grid-column: 2;
    justify-content: end;
  }
  .workflow-graph-content {
    grid-template-columns: 1fr;
  }
  .workflow-node-detail {
    position: static;
    min-height: 260px;
    margin: 0 20px 20px;
  }
  .node-detail-empty {
    min-height: 220px;
  }
}
@media (max-width: 760px) {
  .effect-prompt-node {
    padding: 18px;
    border-radius: 20px;
  }
  .effect-prompt-heading__actions,
  .product-switcher,
  .product-switcher select,
  .secondary-button,
  .heading-generate-button {
    width: 100%;
  }
  .product-switcher select {
    flex: 1;
  }
  .effect-prompt-settings,
  .effect-prompt-stats {
    grid-template-columns: 1fr;
  }
  .settings-heading {
    grid-column: 1;
  }
  .setting-card {
    grid-template-columns: 1fr 140px;
  }
  .run-progress {
    grid-template-columns: 1fr;
  }
  .prompt-card {
    grid-template-columns: 38px minmax(0, 1fr);
    padding: 12px;
  }
  .prompt-actions {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .editor-grid,
  .graph-row.parallel {
    grid-template-columns: 1fr;
  }
  .prompt-dialog-backdrop {
    padding: 10px;
  }
  .workflow-graph-dialog > footer {
    flex-wrap: wrap;
  }
  .workflow-graph-dialog > footer .edge-count {
    margin-left: 0;
  }
}
</style>
