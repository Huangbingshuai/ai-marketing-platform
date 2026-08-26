<script setup lang="ts">
import type {
  EffectImportProduct,
  EffectPromptBatchSettings,
  EffectPromptDimensions,
  EffectPromptFragmentType,
  EffectPromptItem,
  EffectPromptInsightField,
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
  EFFECT_PROMPT_FRAGMENT_TYPE_LABELS,
  EFFECT_PROMPT_FRAGMENT_TYPES,
  EFFECT_PROMPT_GRAPH_EDGES,
  EFFECT_PROMPT_GRAPH_NODES,
  EFFECT_PROMPT_LIMITS,
  EFFECT_PROMPT_RENDER_CAPABILITIES,
  effectPromptTargetCount,
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
type ItemOperation = { itemId: string; kind: 'delete' };

const status = ref<EffectPromptPageStatus>('loading');
const loadError = ref('');
const productStates = ref<Record<string, EffectPromptProductState>>({});
const settingsDrafts = ref<Record<string, EffectPromptBatchSettings>>({});
const settingsSaveStatuses = ref<Record<string, SaveStatus>>({});
const currentProductId = ref('');
const resultData = ref<GetEffectPromptResultData | null>(null);
const resultLoading = ref(false);
const keyword = ref('');
const fragmentTypeFilter = ref<EffectPromptFragmentType | ''>('');
const page = ref(1);
const notice = ref<Notice | null>(null);
const itemOperation = ref<ItemOperation | null>(null);
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
  fragmentType: 'HOOK',
  materialTags: [],
  dimensions: emptyDimensions(),
});
const editorMaterialTagsText = ref('');
const editorTrigger = ref<HTMLElement | null>(null);
const editorCloseButton = ref<HTMLButtonElement | null>(null);
const promptSearchInput = ref<HTMLInputElement | null>(null);

const regenerationDialogOpen = ref(false);
const regenerationCandidate = ref<EffectPromptItem | null>(null);
const regenerationDimensions = ref<EffectPromptDimensions>(emptyDimensions());
const regenerationInstruction = ref('');
const regenerationSaving = ref(false);
const regenerationTrigger = ref<HTMLElement | null>(null);
const regenerationCloseButton = ref<HTMLButtonElement | null>(null);

const deleteDialogOpen = ref(false);
const deleteCandidate = ref<EffectPromptItem | null>(null);
const deleteTrigger = ref<HTMLElement | null>(null);
const deleteConfirmButton = ref<HTMLButtonElement | null>(null);

let disposed = false;
let workspaceGeneration = 0;
let resultGeneration = 0;
let workspaceController: AbortController | null = null;
let resultController: AbortController | null = null;
let operationController: AbortController | null = null;
let itemMutationController: AbortController | null = null;
let exportController: AbortController | null = null;
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
const currentTargetCount = computed(() => effectPromptTargetCount(currentSettings.value));
const currentFinishedVideoDurationSeconds = computed(() => {
  return EFFECT_PROMPT_FRAGMENT_TYPES.reduce(
    (total, fragmentType) =>
      total + currentSettings.value.fragmentConfigs[fragmentType].durationSeconds,
    0,
  );
});
const currentFinishedVideoDurationLabel = computed(() => {
  const totalSeconds = currentFinishedVideoDurationSeconds.value;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds} 秒`;
  return seconds === 0 ? `${minutes} 分钟` : `${minutes} 分 ${seconds} 秒`;
});
const editorTargetDurationSeconds = computed(
  () => currentSettings.value.fragmentConfigs[editorDraft.value.fragmentType].durationSeconds,
);
const currentRun = computed(() => runsByProduct.value[currentProductId.value] ?? null);
const currentResult = computed(() => resultData.value?.result ?? null);
const currentItems = computed(() => resultData.value?.items ?? []);
const currentMetrics = computed(
  () => currentResult.value?.metrics ?? currentState.value?.metrics ?? null,
);
const currentRenderProfile = computed(() => currentResult.value?.renderProfile ?? null);
const currentRenderCapability = computed(() => {
  const key = currentRenderProfile.value?.capabilityKey;
  return key ? EFFECT_PROMPT_RENDER_CAPABILITIES[key] : null;
});
const currentDisabledElements = computed(
  () => currentRenderProfile.value?.sharedConstraints.disabledElements ?? [],
);
const renderCapabilityLabel = computed(() => {
  const labels = {
    SEEDANCE_2_0: 'Seedance 2.0',
    SEEDANCE_2_0_FAST: 'Seedance 2.0 Fast',
    SEEDANCE_1_5_PRO: 'Seedance 1.5 Pro',
    SEEDANCE_1_0: 'Seedance 1.0',
  } as const;
  const key = currentRenderProfile.value?.capabilityKey;
  return key ? labels[key] : '当前模型';
});
const insightFieldLabels: Record<EffectPromptInsightField, string> = {
  PRODUCT_NAME: '产品名称',
  PRODUCT_CATEGORY: '产品品类',
  CORE_SPECIFICATION: '核心规格',
  PRICE_RANGE: '确认价格',
  VISUAL_FEATURES: '视觉特征',
  CORE_SELLING_POINT: '核心卖点',
  SECONDARY_SELLING_POINT: '次要卖点',
  TRUST_BACKING: '信任背书',
  TARGET_AUDIENCE: '目标受众',
  CORE_PAIN_POINT: '核心痛点',
  DECISION_DRIVER: '决策动机',
  MARKETING_GOAL: '营销目标',
  USAGE_SCENARIO: '使用场景',
  PURCHASE_SCENARIO: '购买场景',
  EMOTIONAL_SCENARIO: '情绪场景',
  SOURCE_DURATION: '上游时长',
  ASPECT_RATIO: '画幅',
  DELIVERY_CHANNELS: '投放渠道',
  DISABLED_ELEMENT: '禁用元素',
  VISUAL_STYLE_BASELINE: '视觉基线',
};
const insightSummary = (
  values: Array<{ field: EffectPromptInsightField; value: string }>,
  limit = 3,
): string => {
  if (!values.length) return '无';
  const visible = values
    .slice(0, limit)
    .map(({ field, value }) => `${insightFieldLabels[field]}：${value}`);
  return `${visible.join('；')}${values.length > limit ? `；另 ${values.length - limit} 项` : ''}`;
};
const itemInsightSources = (item: EffectPromptItem) =>
  [
    ...new Map(
      item.insightBindings.map((binding) => [
        binding.field,
        { field: binding.field, label: insightFieldLabels[binding.field], value: binding.value },
      ]),
    ).values(),
  ].slice(0, 8);
const currentFragmentDistribution = computed(() => {
  const distribution = currentMetrics.value?.fragmentTypeDistribution ?? [];
  if (!fragmentTypeFilter.value) return distribution;
  return distribution.filter((entry) => entry.fragmentType === fragmentTypeFilter.value);
});
const currentQuotaStats = computed(() => {
  const fragmentType = fragmentTypeFilter.value;
  if (!fragmentType) {
    const targetCount = currentTargetCount.value;
    const actualCount = currentMetrics.value?.acceptedCount ?? 0;
    return {
      label: '全部可用素材片段 Prompt',
      targetCount,
      actualCount,
      missingCount: Math.max(0, targetCount - actualCount),
      excessCount: Math.max(0, actualCount - targetCount),
    };
  }
  const entry = currentMetrics.value?.fragmentTypeDistribution.find(
    (candidate) => candidate.fragmentType === fragmentType,
  );
  const targetCount =
    entry?.targetCount ?? currentSettings.value.fragmentConfigs[fragmentType].count;
  const actualCount = entry?.actualCount ?? 0;
  return {
    label: `${fragmentTypeLabel(fragmentType)}可用 Prompt`,
    targetCount,
    actualCount,
    missingCount: Math.max(0, targetCount - actualCount),
    excessCount: Math.max(0, actualCount - targetCount),
  };
});
const quotaDifferenceLabel = (actualCount: number, targetCount: number): string => {
  if (actualCount < targetCount) return '缺少 ' + (targetCount - actualCount);
  if (actualCount > targetCount) return '超出 ' + (actualCount - targetCount);
  return '数量一致';
};
const executionInvalidSummary = computed(() => {
  const labels: Record<string, string> = {
    MULTI_STAGE_STORY: '完整成片结构',
    ABSTRACT_META_LANGUAGE: '空泛元话语',
    MISSING_VISIBLE_ACTION: '缺少可见动作',
    PRODUCT_IDENTITY_DRIFT: '产品外观漂移',
    UNSUPPORTED_CLAIM: '未确认事实',
    BURNED_IN_OVERLAY: '烧入文字或转场',
    META_LANGUAGE: '策划元话语',
    FULL_TIMELINE: '多镜头时间轴',
    FULL_TIMELINE_NOT_FRAGMENT: '完整成片结构',
    STACKED_PERSONA: '人物画像堆叠',
    ABSTRACT_PERSONA: '抽象受众画像',
    NO_VISIBLE_ACTION: '缺少可见动作',
    UNFILMABLE_EVIDENCE: '卖点证据不可拍摄',
    ROLE_CONFLICT: '片段职责冲突',
    FIELD_DUPLICATION: '内容机械重复',
    SOURCE_FACT_VIOLATION: '出现未确认事实',
    BROKEN_TEXT: '存在占位或破损文本',
    PLACEHOLDER_TEXT: '存在空泛占位文本',
    DURATION_MISMATCH: '片段时长不一致',
  };
  return (currentMetrics.value?.executionInvalidReasons ?? [])
    .map(({ code, count }) => `${labels[code] ?? '其他不可执行内容'} ${count}`)
    .join('、');
});
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
const deleteSaving = computed(
  () =>
    itemOperation.value?.kind === 'delete' &&
    itemOperation.value.itemId === deleteCandidate.value?.id,
);
const regeneratingItemId = computed(() =>
  currentRunning.value && currentRun.value?.operation === 'ITEM_REGENERATE'
    ? currentRun.value.targetItemId
    : null,
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
  ['INSIGHT_MAPPING'],
  ['STRATEGY_PLANNING'],
  ['DIMENSION_COMBINATION'],
  ['FRAGMENT_TYPE_ROUTER'],
  [
    'GENERATE_HOOK',
    'GENERATE_PAIN',
    'GENERATE_PRODUCT_DISPLAY',
    'GENERATE_SELLING_POINT_EXPLANATION',
    'GENERATE_CTA',
    'GENERATE_OUTRO',
  ],
  ['NORMALIZATION'],
  ['SEMANTIC_DEDUP', 'VISUAL_DEDUP'],
  ['INSIGHT_COVERAGE'],
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
const regenerationChangedKeys = computed(() => {
  const item = regenerationCandidate.value;
  if (!item) return [] as Array<keyof EffectPromptDimensions>;
  return EFFECT_PROMPT_DIMENSIONS.map(({ key }) => key).filter(
    (key) => regenerationDimensions.value[key].trim() !== item.dimensions[key].trim(),
  );
});
const regenerationHasChanges = computed(
  () => regenerationChangedKeys.value.length > 0 || regenerationInstruction.value.trim().length > 0,
);
const regenerationSuggestions = computed<Record<keyof EffectPromptDimensions, string[]>>(() => {
  const result = {} as Record<keyof EffectPromptDimensions, string[]>;
  for (const { key } of EFFECT_PROMPT_DIMENSIONS) {
    const values = [
      ...dimensionSuggestions[key],
      ...currentItems.value.map((item) => item.dimensions[key]),
      ...(regenerationCandidate.value ? [regenerationCandidate.value.dimensions[key]] : []),
    ];
    result[key] = [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  }
  if (regenerationCandidate.value) {
    const type = regenerationCandidate.value.fragmentType;
    const coreSellingPoints = [
      ...(currentMetrics.value?.sellingPointCoverage.required ?? []),
      ...currentItems.value.flatMap((item) =>
        item.insightBindings
          .filter((binding) => binding.field === 'CORE_SELLING_POINT')
          .map((binding) => binding.value),
      ),
    ];
    const secondarySellingPoints = currentItems.value.flatMap((item) =>
      item.insightBindings
        .filter((binding) => binding.field === 'SECONDARY_SELLING_POINT')
        .map((binding) => binding.value),
    );
    const confirmed = [
      regenerationCandidate.value.dimensions.sellingPoint,
      ...(type === 'PRODUCT_DISPLAY' || type === 'SELLING_POINT_EXPLANATION' || type === 'CTA'
        ? coreSellingPoints
        : []),
      ...(type === 'SELLING_POINT_EXPLANATION' ? secondarySellingPoints : []),
    ];
    result.sellingPoint = [...new Set(confirmed.map((value) => value.trim()).filter(Boolean))];
  }
  return result;
});
function emptyDimensions(): EffectPromptDimensions {
  return { narrative: '', scene: '', persona: '', sellingPoint: '', camera: '', emotion: '' };
}

function uniqueTextList(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[\n,，；;]/u)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

const fragmentTypeLabel = (fragmentType: EffectPromptFragmentType): string =>
  EFFECT_PROMPT_FRAGMENT_TYPE_LABELS[fragmentType];

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
      fragmentTypeFilter.value || undefined,
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
    itemMutationController?.abort();
    exportController?.abort();
    itemOperation.value = null;
    exporting.value = false;
    editorOpen.value = false;
    editorSaving.value = false;
    editorTrigger.value = null;
    regenerationDialogOpen.value = false;
    regenerationCandidate.value = null;
    regenerationSaving.value = false;
    regenerationTrigger.value = null;
    deleteDialogOpen.value = false;
    deleteCandidate.value = null;
    deleteTrigger.value = null;
    graphDetailController?.abort();
    graphDetailController = null;
    graphDetailLoading.value = false;
    graphDetailError.value = '';
    void reloadWorkspace();
  },
  { immediate: true },
);
watch(currentProductId, (next, previous) => {
  if (previous && previous !== next) void flushSettings(previous);
  page.value = 1;
  keyword.value = '';
  fragmentTypeFilter.value = '';
  itemMutationController?.abort();
  exportController?.abort();
  itemOperation.value = null;
  exporting.value = false;
  editorOpen.value = false;
  editorSaving.value = false;
  editorTrigger.value = null;
  regenerationDialogOpen.value = false;
  regenerationCandidate.value = null;
  regenerationSaving.value = false;
  regenerationTrigger.value = null;
  deleteDialogOpen.value = false;
  deleteCandidate.value = null;
  regenerationDialogOpen.value = false;
  regenerationCandidate.value = null;
  deleteTrigger.value = null;
  graphDetailController?.abort();
  graphDetailController = null;
  graphDetailLoading.value = false;
  selectedGraphNodeId.value = null;
  graphDetail.value = null;
  graphDetailError.value = '';
  void loadCurrentResult();
});
watch(page, () => void loadCurrentResult());
watch(fragmentTypeFilter, () => {
  if (page.value === 1) void loadCurrentResult();
  else page.value = 1;
});
watch(keyword, () => {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    if (page.value === 1) void loadCurrentResult();
    else page.value = 1;
  }, 350);
});

type NumericPromptSetting = 'semanticLimit' | 'visualLimit';
type FragmentConfigKey = 'count' | 'durationSeconds';

const settingRange = (key: NumericPromptSetting): { maximum: number; minimum: number } =>
  ({
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

const adjustSetting = (key: NumericPromptSetting, delta: number): void => {
  const draft = settingsDrafts.value[currentProductId.value];
  if (!draft) return;
  const range = settingRange(key);
  draft[key] = Math.min(range.maximum, Math.max(range.minimum, draft[key] + delta));
  queueSettingsSave();
};

const fragmentConfigRange = (
  fragmentType: EffectPromptFragmentType,
  key: FragmentConfigKey,
): { maximum: number; minimum: number } => {
  if (key === 'durationSeconds')
    return {
      minimum: EFFECT_PROMPT_LIMITS.minDurationSeconds,
      maximum: EFFECT_PROMPT_LIMITS.maxDurationSeconds,
    };
  const otherCount = EFFECT_PROMPT_FRAGMENT_TYPES.reduce(
    (sum, currentType) =>
      sum +
      (currentType === fragmentType ? 0 : currentSettings.value.fragmentConfigs[currentType].count),
    0,
  );
  return {
    minimum: Math.max(
      EFFECT_PROMPT_LIMITS.minFragmentCount,
      EFFECT_PROMPT_LIMITS.minCount - otherCount,
    ),
    maximum: Math.max(
      EFFECT_PROMPT_LIMITS.minFragmentCount,
      EFFECT_PROMPT_LIMITS.maxCount - otherCount,
    ),
  };
};

const updateFragmentConfig = (
  fragmentType: EffectPromptFragmentType,
  key: FragmentConfigKey,
  rawValue: number,
): void => {
  const draft = settingsDrafts.value[currentProductId.value];
  if (!draft) return;
  const range = fragmentConfigRange(fragmentType, key);
  draft.fragmentConfigs[fragmentType][key] = Math.min(
    range.maximum,
    Math.max(range.minimum, Math.round(Number(rawValue) || range.minimum)),
  );
  queueSettingsSave();
};

const updateFragmentConfigFromEvent = (
  fragmentType: EffectPromptFragmentType,
  key: FragmentConfigKey,
  event: Event,
): void => {
  const input = event.target;
  if (input instanceof HTMLInputElement)
    updateFragmentConfig(fragmentType, key, input.valueAsNumber);
};

const adjustFragmentConfig = (
  fragmentType: EffectPromptFragmentType,
  key: FragmentConfigKey,
  delta: number,
): void => {
  updateFragmentConfig(
    fragmentType,
    key,
    currentSettings.value.fragmentConfigs[fragmentType][key] + delta,
  );
};

const toggleFragmentTypeFilter = (fragmentType: EffectPromptFragmentType): void => {
  fragmentTypeFilter.value = fragmentTypeFilter.value === fragmentType ? '' : fragmentType;
  page.value = 1;
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
    startPolling(productId, run);
  } catch (error) {
    if (!isAbortError(error)) await handleMutationError(error, 'Prompt 批次启动失败');
  }
};

const openRegenerationDialog = async (item: EffectPromptItem, event?: Event): Promise<void> => {
  if (currentRunning.value || itemOperation.value) return;
  regenerationTrigger.value =
    event?.currentTarget instanceof HTMLElement ? event.currentTarget : null;
  regenerationCandidate.value = item;
  regenerationDimensions.value = { ...item.dimensions };
  regenerationInstruction.value = '';
  regenerationDialogOpen.value = true;
  await nextTick();
  regenerationCloseButton.value?.focus();
};

const closeRegenerationDialog = (): void => {
  if (regenerationSaving.value) return;
  regenerationDialogOpen.value = false;
  regenerationCandidate.value = null;
  regenerationDimensions.value = emptyDimensions();
  regenerationInstruction.value = '';
  const trigger = regenerationTrigger.value;
  regenerationTrigger.value = null;
  nextTick(() => trigger?.focus());
};

const restoreRegenerationDimensions = (): void => {
  if (!regenerationCandidate.value) return;
  regenerationDimensions.value = { ...regenerationCandidate.value.dimensions };
};

const useRegenerationSuggestion = (key: keyof EffectPromptDimensions, value: string): void => {
  regenerationDimensions.value = { ...regenerationDimensions.value, [key]: value };
};

const regenerateItem = async (): Promise<void> => {
  const state = currentState.value;
  const item = regenerationCandidate.value;
  if (
    !state ||
    !item ||
    currentRunning.value ||
    itemOperation.value ||
    state.settingsRevision === null ||
    regenerationSaving.value
  )
    return;
  const replacementDimensions = Object.fromEntries(
    EFFECT_PROMPT_DIMENSIONS.map(({ key }) => [key, regenerationDimensions.value[key].trim()]),
  ) as EffectPromptDimensions;
  if (EFFECT_PROMPT_DIMENSIONS.some(({ key }) => !replacementDimensions[key])) {
    showNotice('请完整填写六大维度后再重新生成', 'warning');
    return;
  }
  operationController?.abort();
  const controller = new AbortController();
  operationController = controller;
  regenerationSaving.value = true;
  try {
    const run = await beginEffectPromptRun(
      props.projectId,
      state.productId,
      {
        workflowRunId: props.workflowRunId,
        operation: 'ITEM_REGENERATE',
        targetItemId: item.id,
        replacementDimensions,
        ...(regenerationInstruction.value.trim()
          ? { regenerationInstruction: regenerationInstruction.value.trim() }
          : {}),
        expectedSettingsRevision: state.settingsRevision,
        ...(state.resultRevision === null ? {} : { expectedResultRevision: state.resultRevision }),
      },
      controller.signal,
    );
    updateRun(state.productId, run);
    regenerationSaving.value = false;
    closeRegenerationDialog();
    startPolling(state.productId, run);
  } catch (error) {
    if (!isAbortError(error)) await handleMutationError(error, '单条 Prompt 重新生成失败');
  } finally {
    regenerationSaving.value = false;
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
    fragmentType: item?.fragmentType ?? 'HOOK',
    materialTags: item ? [...item.materialTags] : [],
    dimensions: item ? { ...item.dimensions } : emptyDimensions(),
  };
  editorMaterialTagsText.value = item?.materialTags.join('，') ?? '';
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
  if (!draft.content.trim()) {
    showNotice('请填写片段类型和 Prompt 内容', 'warning');
    return;
  }
  const missing = EFFECT_PROMPT_DIMENSIONS.find(({ key }) => !draft.dimensions[key].trim());
  if (missing) {
    showNotice(`请填写${missing.label}`, 'warning');
    return;
  }
  editorSaving.value = true;
  itemMutationController?.abort();
  const controller = new AbortController();
  itemMutationController = controller;
  const productId = state.productId;
  const resultId = state.resultId;
  try {
    await saveEffectPromptItem(
      props.projectId,
      resultId,
      result.revision,
      {
        content: draft.content.trim(),
        fragmentType: draft.fragmentType,
        materialTags: uniqueTextList(editorMaterialTagsText.value),
        dimensions: Object.fromEntries(
          EFFECT_PROMPT_DIMENSIONS.map(({ key }) => [key, draft.dimensions[key].trim()]),
        ) as EffectPromptDimensions,
      },
      editorMode.value === 'edit' ? editorItemId.value : undefined,
      controller.signal,
    );
    if (controller.signal.aborted || currentProductId.value !== productId) return;
    editorOpen.value = false;
    showNotice(editorMode.value === 'edit' ? 'Prompt 修改已自动保存' : '人工 Prompt 已添加');
    await reloadWorkspace(false);
  } catch (error) {
    if (!isAbortError(error)) await handleMutationError(error, 'Prompt 保存失败');
  } finally {
    if (itemMutationController === controller) itemMutationController = null;
    if (!controller.signal.aborted || currentProductId.value === productId)
      editorSaving.value = false;
  }
};

const restoreDeleteFocus = (): void => {
  const trigger = deleteTrigger.value;
  deleteTrigger.value = null;
  void nextTick(() => {
    if (trigger?.isConnected) trigger.focus();
    else promptSearchInput.value?.focus();
  });
};

const requestDeleteItem = async (item: EffectPromptItem, event?: Event): Promise<void> => {
  if (currentRunning.value || itemOperation.value) return;
  deleteCandidate.value = item;
  deleteTrigger.value = event?.currentTarget instanceof HTMLElement ? event.currentTarget : null;
  deleteDialogOpen.value = true;
  await nextTick();
  deleteConfirmButton.value?.focus();
};

const closeDeleteDialog = (): void => {
  if (deleteSaving.value) return;
  deleteDialogOpen.value = false;
  deleteCandidate.value = null;
  restoreDeleteFocus();
};

const confirmDeleteItem = async (): Promise<void> => {
  const item = deleteCandidate.value;
  const state = currentState.value;
  const result = resultData.value;
  if (!item || !state?.resultId || !result || currentRunning.value || itemOperation.value) return;
  itemOperation.value = { itemId: item.id, kind: 'delete' };
  itemMutationController?.abort();
  const controller = new AbortController();
  itemMutationController = controller;
  const productId = state.productId;
  try {
    await removeEffectPromptItem(
      props.projectId,
      state.resultId,
      item,
      result.revision,
      controller.signal,
    );
    if (controller.signal.aborted || currentProductId.value !== productId) return;
    showNotice(`${item.code} 已从节点草稿删除`, 'warning');
    deleteDialogOpen.value = false;
    deleteCandidate.value = null;
    restoreDeleteFocus();
    await reloadWorkspace(false);
  } catch (error) {
    if (!isAbortError(error)) await handleMutationError(error, 'Prompt 删除失败');
  } finally {
    if (itemMutationController === controller) itemMutationController = null;
    if (itemOperation.value?.itemId === item.id && itemOperation.value.kind === 'delete')
      itemOperation.value = null;
  }
};

const writeClipboardText = async (value: string): Promise<void> => {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return;
    }
  } catch {
    // Continue to the local selection fallback when clipboard permission is unavailable.
  }
  const activeElement =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.readOnly = true;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  textarea.remove();
  activeElement?.focus();
  if (!copied) throw new Error('CLIPBOARD_UNAVAILABLE');
};

const copyItem = async (item: EffectPromptItem): Promise<void> => {
  try {
    await writeClipboardText(item.content);
    showNotice(`${item.code} 已复制`);
  } catch {
    showNotice('浏览器未允许复制，请在修改窗口手动复制', 'warning');
  }
};

const exportBatch = async (): Promise<void> => {
  const state = currentState.value;
  if (
    !state?.resultId ||
    !resultData.value ||
    !currentProduct.value ||
    currentRunning.value ||
    exporting.value
  )
    return;
  exportController?.abort();
  const controller = new AbortController();
  exportController = controller;
  const productId = state.productId;
  exporting.value = true;
  try {
    const exported = await downloadEffectPromptBatch(
      props.projectId,
      state.resultId,
      currentProduct.value.name,
      controller.signal,
    );
    if (controller.signal.aborted || currentProductId.value !== productId) return;
    const url = URL.createObjectURL(exported.blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = exported.fileName;
    anchor.click();
    requestAnimationFrame(() => URL.revokeObjectURL(url));
    showNotice(`已从服务端导出 ${resultData.value?.total ?? 0} 条 Prompt`);
  } catch (error) {
    if (!isAbortError(error)) showNotice(safeMessage(error, 'Prompt 导出失败'), 'error');
  } finally {
    if (exportController === controller) exportController = null;
    if (!controller.signal.aborted || currentProductId.value === productId) exporting.value = false;
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
    INSIGHT_MAPPING: '把已确认的营销洞察映射为片段可用信息',
    STRATEGY_PLANNING: '连接受众、痛点、场景、卖点与营销目标，形成营销关系束',
    DIMENSION_COMBINATION: '先分配营销关系束，再在关系内部编排六维差异',
    FRAGMENT_TYPE_ROUTER: '按选定数量和时长将组合路由到六类生成分支',
    GENERATE_HOOK: '生成首帧即有注意力触发动作的钩子片段',
    GENERATE_PAIN: '生成可见问题状态和人物反应的痛点片段',
    GENERATE_PRODUCT_DISPLAY: '生成产品外观稳定、展示动作单一的片段',
    GENERATE_SELLING_POINT_EXPLANATION: '生成围绕一个确认卖点的可见讲解或演示片段',
    GENERATE_CTA: '生成产品清晰、预留安全区的结尾转化片段',
    GENERATE_OUTRO: '生成可稳定停留的片尾品牌收束片段',
    NORMALIZATION: '校验主标签、时长与画面动作的可执行性',
    SEMANTIC_DEDUP: '检测内容意图和文字近似重复',
    VISUAL_DEDUP: '计算场景、人物、镜头和情绪的结构化重合',
    INSIGHT_COVERAGE: '核对必须应用的提炼信息与安全约束',
    QUALITY_GATE: '核对配额、提炼信息覆盖、可执行性和双重阈值',
    REPLENISH: '按缺少的片段类型和提炼事实定向补齐',
    RESULT_SAVE: '保存最佳批次草稿和质量结论',
  })[nodeId];
const graphDetailValue = (value: unknown): string => {
  if (Array.isArray(value)) {
    const visible = value.filter(
      (item): item is string | number | boolean =>
        typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean',
    );
    return visible.length ? visible.map(String).join('\n') : '—';
  }
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (typeof value === 'string') return value.trim() || '—';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '—';
};

const graphDetailValueIsMultiline = (value: unknown): boolean => {
  const visible = graphDetailValue(value);
  return Array.isArray(value) || visible.includes('\n') || visible.length > 72;
};

const GRAPH_EVIDENCE_MODE_LABELS: Record<string, string> = {
  VISIBLE_ATTRIBUTE: '可见属性',
  USAGE_ACTION: '使用动作',
  VISIBLE_RESULT: '可见结果',
  PROCESS_ONLY: '过程素材',
  TEXT_ONLY: '确认字幕',
};

const graphEvidenceModeLabel = (value: string): string =>
  GRAPH_EVIDENCE_MODE_LABELS[value] ?? value;

const graphPairScore = (value: number): string => `${(value * 100).toFixed(0)}%`;

const formatGraphDetailTime = (value: string | null | undefined): string => {
  if (!value) return '尚无执行记录';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '更新时间不可用';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
};

const localGraphDetail = (nodeId: EffectPromptNodeId): NodeDetail => {
  const execution = graphExecution(nodeId);
  return {
    nodeId,
    status: execution.status,
    summary:
      execution.summary ||
      (execution.status === 'PENDING'
        ? '该节点尚未执行，暂无持久化运行数据。'
        : graphDescription(nodeId)),
    fields: [],
    blocks: [],
    warnings: [...execution.warnings],
    errorMessage: execution.errorMessage,
    updatedAt: null,
  };
};

const graphDetailEmptyMessage = (detail: NodeDetail): string => {
  if (detail.status === 'PENDING') return '该节点尚未执行，暂无实际产出。';
  if (detail.status === 'RUNNING') return '节点正在执行，实际结果会随已完成分片更新。';
  if (detail.status === 'SKIPPED') return '该节点本次已跳过，没有实际产出。';
  if (detail.status === 'FAILED') return '节点未产出可展示结果，请查看下方错误信息。';
  return '该节点已完成，本次没有额外的业务结果。';
};

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
      graphError.value = safeMessage(error, '工作流状态加载失败');
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
  graphDetailController = null;
  graphDetailLoading.value = false;
  selectedGraphNodeId.value = null;
  graphDetail.value = null;
  graphDetailError.value = '';
  const trigger = graphTrigger.value;
  graphTrigger.value = null;
  nextTick(() => trigger?.focus());
};

const refreshGraphDetail = async (): Promise<void> => {
  const nodeId = selectedGraphNodeId.value;
  const productId = currentProductId.value;
  const projectId = props.projectId;
  if (!nodeId || !productId) return;

  graphDetail.value = localGraphDetail(nodeId);
  graphDetailError.value = '';
  const runId = currentRun.value?.id ?? currentState.value?.runId;
  graphDetailController?.abort();
  graphDetailController = null;
  graphDetailLoading.value = false;
  if (!runId) return;

  const controller = new AbortController();
  graphDetailController = controller;
  graphDetailLoading.value = true;
  try {
    const detail = await loadEffectPromptNodeDetail(
      props.projectId,
      runId,
      nodeId,
      controller.signal,
    );
    if (
      disposed ||
      controller.signal.aborted ||
      !graphDialogOpen.value ||
      props.projectId !== projectId ||
      currentProductId.value !== productId ||
      selectedGraphNodeId.value !== nodeId
    )
      return;
    graphDetail.value = detail;
  } catch (error) {
    if (
      !isAbortError(error) &&
      !disposed &&
      props.projectId === projectId &&
      currentProductId.value === productId &&
      selectedGraphNodeId.value === nodeId
    )
      graphDetailError.value = safeMessage(error, '节点详情加载失败');
  } finally {
    if (graphDetailController === controller) graphDetailController = null;
    if (!controller.signal.aborted && selectedGraphNodeId.value === nodeId)
      graphDetailLoading.value = false;
  }
};

const selectGraphNode = (nodeId: EffectPromptNodeId): void => {
  selectedGraphNodeId.value = nodeId;
  void refreshGraphDetail();
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
  itemMutationController?.abort();
  exportController?.abort();
  graphDetailController?.abort();
  pollControllers.forEach(({ controller }) => controller.abort());
  deleteDialogOpen.value = false;
  deleteCandidate.value = null;
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
            <p>基于提炼结果，批量生成差异化视频素材 Prompt</p>
          </div>
        </div>
        <div class="effect-prompt-heading__actions">
          <label class="product-switcher">
            <span>当前商品</span>
            <select v-model="currentProductId">
              <option v-for="product in activeProducts" :key="product.id" :value="product.id">
                {{ product.name || '未命名产品' }}
              </option>
            </select>
          </label>
          <button
            ref="graphTrigger"
            class="secondary-button workflow-graph-trigger"
            type="button"
            aria-haspopup="dialog"
            @click="openGraph($event)"
          >
            <Workflow :size="14" />查看工作流
          </button>
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
              ? currentState.errorMessage ||
                '上游信息卡或批次设置已更新，请重新生成当前产品的 Prompt。'
              : currentState.errorMessage || '本次 Prompt 生成失败，请查看工作流节点后重试。'
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
        <div class="fragment-batch-summary" aria-label="六类片段汇总">
          <div>
            <span>素材片段总数</span>
            <strong>{{ currentTargetCount }} 条</strong>
            <small>六类 Prompt 总量</small>
          </div>
          <div>
            <span>单条成片预计时长</span>
            <strong>{{ currentFinishedVideoDurationLabel }}</strong>
            <small>六类各取 1 个片段的时长相加</small>
          </div>
        </div>

        <div class="fragment-config-grid" aria-label="六类片段独立配置">
          <article
            v-for="fragmentType in EFFECT_PROMPT_FRAGMENT_TYPES"
            :key="fragmentType"
            class="fragment-config-card"
            :class="{ active: fragmentTypeFilter === fragmentType }"
          >
            <button
              type="button"
              class="fragment-config-card__filter"
              :aria-pressed="fragmentTypeFilter === fragmentType"
              @click="toggleFragmentTypeFilter(fragmentType)"
            >
              <span>
                <strong>{{ fragmentTypeLabel(fragmentType) }}</strong>
                <small>{{
                  fragmentTypeFilter === fragmentType
                    ? '正在筛选，再次点击显示全部'
                    : '点击筛选下方 Prompt'
                }}</small>
              </span>
              <em>{{ currentSettings.fragmentConfigs[fragmentType].count }} 条</em>
            </button>
            <div class="fragment-config-card__controls">
              <label class="fragment-inline-setting">
                <span>生成数量</span>
                <span class="number-control">
                  <button
                    type="button"
                    :aria-label="`降低${fragmentTypeLabel(fragmentType)}生成数量`"
                    :disabled="
                      currentRunning ||
                      currentSettings.fragmentConfigs[fragmentType].count <=
                        fragmentConfigRange(fragmentType, 'count').minimum
                    "
                    @click="adjustFragmentConfig(fragmentType, 'count', -1)"
                  >
                    −
                  </button>
                  <input
                    :value="currentSettings.fragmentConfigs[fragmentType].count"
                    type="number"
                    :aria-label="`${fragmentTypeLabel(fragmentType)}生成数量`"
                    :min="fragmentConfigRange(fragmentType, 'count').minimum"
                    :max="fragmentConfigRange(fragmentType, 'count').maximum"
                    :disabled="currentRunning"
                    @input="updateFragmentConfigFromEvent(fragmentType, 'count', $event)"
                    @blur="flushSettings()"
                  />
                  <button
                    type="button"
                    :aria-label="`提高${fragmentTypeLabel(fragmentType)}生成数量`"
                    :disabled="
                      currentRunning ||
                      currentSettings.fragmentConfigs[fragmentType].count >=
                        fragmentConfigRange(fragmentType, 'count').maximum
                    "
                    @click="adjustFragmentConfig(fragmentType, 'count', 1)"
                  >
                    ＋
                  </button>
                </span>
              </label>
              <label class="fragment-inline-setting">
                <span>片段时长</span>
                <span class="number-control">
                  <button
                    type="button"
                    :aria-label="`缩短${fragmentTypeLabel(fragmentType)}时长`"
                    :disabled="
                      currentRunning ||
                      currentSettings.fragmentConfigs[fragmentType].durationSeconds <=
                        fragmentConfigRange(fragmentType, 'durationSeconds').minimum
                    "
                    @click="adjustFragmentConfig(fragmentType, 'durationSeconds', -1)"
                  >
                    −
                  </button>
                  <input
                    :value="currentSettings.fragmentConfigs[fragmentType].durationSeconds"
                    type="number"
                    :aria-label="`${fragmentTypeLabel(fragmentType)}片段时长（秒）`"
                    :min="fragmentConfigRange(fragmentType, 'durationSeconds').minimum"
                    :max="fragmentConfigRange(fragmentType, 'durationSeconds').maximum"
                    :disabled="currentRunning"
                    @input="updateFragmentConfigFromEvent(fragmentType, 'durationSeconds', $event)"
                    @blur="flushSettings()"
                  />
                  <button
                    type="button"
                    :aria-label="`延长${fragmentTypeLabel(fragmentType)}时长`"
                    :disabled="
                      currentRunning ||
                      currentSettings.fragmentConfigs[fragmentType].durationSeconds >=
                        fragmentConfigRange(fragmentType, 'durationSeconds').maximum
                    "
                    @click="adjustFragmentConfig(fragmentType, 'durationSeconds', 1)"
                  >
                    ＋
                  </button>
                </span>
              </label>
            </div>
          </article>
        </div>

        <label
          v-for="setting in [
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
          <span>{{ currentQuotaStats.label }}</span
          ><strong>{{ currentQuotaStats.actualCount }}</strong
          ><small
            >目标 {{ currentQuotaStats.targetCount }} 条 ·
            {{
              currentQuotaStats.missingCount
                ? '缺少 ' + currentQuotaStats.missingCount + ' 条'
                : currentQuotaStats.excessCount
                  ? '超出 ' + currentQuotaStats.excessCount + ' 条'
                  : '数量一致'
            }}，一条对应一个片段</small
          >
        </article>
        <article class="amber">
          <span>执行无效候选</span
          ><strong>{{ currentMetrics?.removedExecutionInvalid ?? 0 }}</strong
          ><small>{{ executionInvalidSummary || '暂无执行无效候选' }}</small>
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

      <section v-if="currentRenderProfile" class="unified-render-profile" aria-label="统一渲染设置">
        <div class="render-profile-heading">
          <div>
            <strong>统一渲染设置</strong>
            <span>渲染时作为独立参数传递，不写入 Prompt 正文</span>
          </div>
          <small v-if="currentMetrics?.fallbackCount">
            本批次规则兜底 {{ currentMetrics.fallbackCount }} 条
          </small>
        </div>
        <div class="render-profile-values">
          <span
            ><small>画幅</small><b>{{ currentRenderProfile.ratio }}</b></span
          >
          <span
            ><small>分辨率</small><b>{{ currentRenderProfile.resolution }}</b></span
          >
          <span>
            <small>模型时长范围</small>
            <b>
              {{ renderCapabilityLabel }} ·
              {{ currentRenderCapability?.minDurationSeconds ?? 4 }}～{{
                currentRenderCapability?.maxDurationSeconds ?? 15
              }}
              秒
            </b>
          </span>
        </div>
        <div class="shared-disabled-elements">
          <strong>统一禁用元素</strong>
          <div v-if="currentDisabledElements.length">
            <span v-for="element in currentDisabledElements" :key="element">{{ element }}</span>
          </div>
          <em v-else>未设置</em>
        </div>
      </section>

      <section v-if="currentMetrics" class="quality-breakdown" aria-label="配额与提炼信息覆盖">
        <div>
          <strong>{{ fragmentTypeFilter ? '当前类型配额' : '六类标签配额' }}</strong>
          <span
            v-for="entry in currentFragmentDistribution"
            :key="entry.fragmentType"
            :class="{ missing: entry.actualCount !== entry.targetCount }"
          >
            {{ fragmentTypeLabel(entry.fragmentType) }} {{ entry.actualCount }}/{{
              entry.targetCount
            }}
            · {{ quotaDifferenceLabel(entry.actualCount, entry.targetCount) }}
          </span>
        </div>
        <div>
          <strong>卖点覆盖</strong>
          <span
            >{{
              currentMetrics.sellingPointCoverage.required.length -
              currentMetrics.sellingPointCoverage.missing.length
            }}/{{ currentMetrics.sellingPointCoverage.required.length }} 已覆盖</span
          >
          <em v-if="currentMetrics.sellingPointCoverage.missing.length">
            待补：{{ currentMetrics.sellingPointCoverage.missing.join('、') }}
          </em>
          <em v-else>已覆盖全部确认卖点</em>
        </div>
        <div class="insight-utilization">
          <strong>提炼信息利用</strong>
          <span :class="{ missing: currentMetrics.insightCoverage.missing.length > 0 }">
            {{ currentMetrics.insightCoverage.covered.length }}/{{
              currentMetrics.insightCoverage.required.length
            }}
            项核心信息已覆盖
          </span>
          <em v-if="currentMetrics.insightCoverage.missing.length" class="missing">
            待补：{{ insightSummary(currentMetrics.insightCoverage.missing) }}
          </em>
          <em v-else>核心信息已全部用于合适的片段</em>
          <span v-if="currentMetrics.insightCoverage.deferred.length" class="adaptive">
            自适应暂未编排：{{ insightSummary(currentMetrics.insightCoverage.deferred) }}
          </span>
          <span class="constraint">
            已应用 {{ currentMetrics.insightCoverage.appliedConstraints.length }} 项制作约束
          </span>
        </div>
      </section>

      <section class="effect-prompt-list" aria-label="Prompt 生成结果">
        <div class="effect-prompt-toolbar">
          <label class="prompt-search"
            ><Search :size="15" /><input
              ref="promptSearchInput"
              v-model="keyword"
              type="search"
              placeholder="搜索 ID / 片段画面 / 标签 / 六维"
          /></label>
          <span class="prompt-result-count">{{ resultData?.total ?? 0 }} 条</span>
          <button
            class="primary-button"
            type="button"
            :disabled="!resultData || currentRunning"
            @click="openEditor(undefined, $event)"
          >
            <Plus :size="15" />人工添加提示词
          </button>
          <button
            class="primary-button"
            type="button"
            :disabled="!resultData || currentRunning || exporting"
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
                ><em class="primary-fragment-tag">{{ fragmentTypeLabel(item.fragmentType) }}</em
                ><em class="duration-tag">{{ item.targetDurationSeconds }} 秒</em></span
              >
            </header>
            <div class="material-tags" aria-label="素材次级标签">
              <small>次级标签</small>
              <span v-for="tag in item.materialTags" :key="tag">{{ tag }}</span>
              <em v-if="!item.materialTags.length">暂无</em>
            </div>
            <div
              v-if="item.insightBindings.length"
              class="insight-source-tags"
              aria-label="该条 Prompt 使用的提炼信息"
            >
              <small>提炼来源</small>
              <span
                v-for="source in itemInsightSources(item)"
                :key="source.field"
                :title="source.value"
                >{{ source.label }}</span
              >
            </div>
            <textarea :value="item.content" readonly aria-label="Prompt 内容" />
            <details class="prompt-dimension-details">
              <summary>查看六维差异化设定</summary>
              <div class="prompt-dimensions">
                <span v-for="dimension in EFFECT_PROMPT_DIMENSIONS" :key="dimension.key"
                  ><b>{{ dimension.label }}：</b>{{ item.dimensions[dimension.key] }}</span
                >
              </div>
            </details>
          </div>
          <div class="prompt-actions">
            <button type="button" :disabled="currentRunning" @click="openEditor(item, $event)">
              <Pencil :size="13" />修改
            </button>
            <button type="button" @click="copyItem(item)"><Copy :size="13" />复制</button>
            <button
              class="danger"
              type="button"
              :disabled="currentRunning || itemOperation !== null"
              @click="requestDeleteItem(item, $event)"
            >
              <LoaderCircle
                v-if="itemOperation?.itemId === item.id && itemOperation.kind === 'delete'"
                class="spin"
                :size="13"
              /><Trash2 v-else :size="13" />删除
            </button>
            <button
              type="button"
              :disabled="currentRunning || itemOperation !== null"
              @click="openRegenerationDialog(item, $event)"
            >
              <LoaderCircle
                v-if="regeneratingItemId === item.id"
                class="spin"
                :size="13"
              /><RefreshCw v-else :size="13" />重新生成此条
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
            <label>
              <span>固定主标签</span>
              <select v-model="editorDraft.fragmentType">
                <option
                  v-for="fragmentType in EFFECT_PROMPT_FRAGMENT_TYPES"
                  :key="fragmentType"
                  :value="fragmentType"
                >
                  {{ fragmentTypeLabel(fragmentType) }}
                </option>
              </select>
            </label>
            <label>
              <span>目标片段时长</span>
              <input :value="editorTargetDurationSeconds" type="number" readonly />
              <small>由当前主标签的批次时长自动决定，不可单条修改。</small>
            </label>
            <label class="editor-wide-field">
              <span>次级素材标签</span>
              <input
                v-model="editorMaterialTagsText"
                type="text"
                placeholder="例如：首帧，特写，实拍演示（逗号分隔）"
              />
            </label>
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
            ><span>片段生成 Prompt</span
            ><small>只描述一个可独立渲染的画面片段，不要写完整成片脚本或多镜头时间轴。</small>
            <textarea
              v-model="editorDraft.content"
              placeholder="请写清首帧画面、单一连续动作、产品位置、运镜、光线与结束帧"
            />
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

      <div
        v-if="regenerationDialogOpen && regenerationCandidate"
        class="prompt-dialog-backdrop"
        @mousedown.self="closeRegenerationDialog"
      >
        <section
          class="prompt-regeneration-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="prompt-regeneration-title"
          @keydown.esc="closeRegenerationDialog"
        >
          <header>
            <div>
              <span>单条定向重新生成</span>
              <h2 id="prompt-regeneration-title">重新生成 {{ regenerationCandidate.code }}</h2>
              <p>
                <strong>{{ fragmentTypeLabel(regenerationCandidate.fragmentType) }}</strong>
                <i>{{ regenerationCandidate.targetDurationSeconds }} 秒</i>
                <i>{{ regenerationCandidate.materialTags.join(' · ') }}</i>
              </p>
            </div>
            <button
              ref="regenerationCloseButton"
              type="button"
              aria-label="关闭单条重新生成窗口"
              @click="closeRegenerationDialog"
            >
              <X :size="18" />
            </button>
          </header>

          <details class="regeneration-prompt-preview">
            <summary>查看当前 Prompt</summary>
            <p>{{ regenerationCandidate.content }}</p>
          </details>

          <div class="regeneration-toolbar">
            <div>
              <span>六维定向设置</span>
              <strong>已调整 {{ regenerationChangedKeys.length }}/6</strong>
            </div>
            <button
              type="button"
              :disabled="regenerationChangedKeys.length === 0 || regenerationSaving"
              @click="restoreRegenerationDimensions"
            >
              <RefreshCw :size="13" />恢复原始六维
            </button>
          </div>

          <div class="regeneration-dimension-grid">
            <article
              v-for="dimension in EFFECT_PROMPT_DIMENSIONS"
              :key="dimension.key"
              class="regeneration-dimension-card"
              :class="{ changed: regenerationChangedKeys.includes(dimension.key) }"
            >
              <header>
                <span>{{ dimension.label }}</span>
                <em v-if="regenerationChangedKeys.includes(dimension.key)">已调整</em>
              </header>
              <p class="regeneration-original-value">
                <small>原值</small>{{ regenerationCandidate.dimensions[dimension.key] }}
              </p>
              <label>
                <span>当前值</span>
                <select
                  v-if="dimension.key === 'sellingPoint'"
                  v-model="regenerationDimensions.sellingPoint"
                >
                  <option
                    v-for="value in regenerationSuggestions.sellingPoint"
                    :key="value"
                    :value="value"
                  >
                    {{ value }}
                  </option>
                </select>
                <input
                  v-else
                  v-model="regenerationDimensions[dimension.key]"
                  :list="`regeneration-dimension-${dimension.key}`"
                  :maxlength="dimension.key === 'persona' || dimension.key === 'camera' ? 160 : 120"
                  :placeholder="`搜索建议或自定义${dimension.label}`"
                />
                <datalist
                  v-if="dimension.key !== 'sellingPoint'"
                  :id="`regeneration-dimension-${dimension.key}`"
                >
                  <option
                    v-for="value in regenerationSuggestions[dimension.key]"
                    :key="value"
                    :value="value"
                  />
                </datalist>
              </label>
              <div
                v-if="dimension.key !== 'sellingPoint'"
                class="regeneration-suggestion-list"
                aria-label="安全候选"
              >
                <button
                  v-for="value in regenerationSuggestions[dimension.key].slice(0, 3)"
                  :key="value"
                  type="button"
                  :class="{ active: regenerationDimensions[dimension.key] === value }"
                  @click="useRegenerationSuggestion(dimension.key, value)"
                >
                  {{ value }}
                </button>
              </div>
              <p v-if="regenerationChangedKeys.includes(dimension.key)" class="regeneration-change">
                {{ regenerationCandidate.dimensions[dimension.key] }}
                <ChevronRight :size="12" />
                <strong>{{ regenerationDimensions[dimension.key] }}</strong>
              </p>
              <small v-if="dimension.key === 'sellingPoint'" class="selling-point-note">
                仅可选择当前信息卡已确认且适用于本片段的卖点。
              </small>
            </article>
          </div>

          <label class="regeneration-instruction">
            <span>修改意见 <em>可选</em></span>
            <textarea
              v-model="regenerationInstruction"
              maxlength="500"
              placeholder="例如：产品更早出现、动作节奏更舒缓、减少蒸汽遮挡"
            />
            <small>{{ regenerationInstruction.length }}/500</small>
          </label>

          <footer>
            <p>只替换当前条目；类型、时长、标签、编号和列表位置保持不变。</p>
            <div>
              <button type="button" :disabled="regenerationSaving" @click="closeRegenerationDialog">
                取消
              </button>
              <button
                class="primary-button"
                type="button"
                :disabled="regenerationSaving"
                @click="regenerateItem"
              >
                <LoaderCircle v-if="regenerationSaving" class="spin" :size="14" />
                {{ regenerationHasChanges ? '按当前设置重新生成' : '直接换一版' }}
              </button>
            </div>
          </footer>
        </section>
      </div>

      <div
        v-if="deleteDialogOpen && deleteCandidate"
        class="prompt-dialog-backdrop"
        @mousedown.self="closeDeleteDialog"
      >
        <section
          class="prompt-delete-dialog"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="prompt-delete-title"
          aria-describedby="prompt-delete-description"
          @keydown.esc="closeDeleteDialog"
        >
          <span class="delete-dialog-icon"><Trash2 :size="20" /></span>
          <div>
            <span>删除节点草稿</span>
            <h2 id="prompt-delete-title">确认删除 {{ deleteCandidate.code }}？</h2>
            <p id="prompt-delete-description">
              这会从当前产品的 Prompt
              节点草稿中删除该条内容，并重新计算数量与去重指标；不会删除已归档资产。
            </p>
          </div>
          <footer>
            <button type="button" :disabled="deleteSaving" @click="closeDeleteDialog">取消</button>
            <button
              ref="deleteConfirmButton"
              class="danger-button"
              type="button"
              :disabled="deleteSaving || currentRunning"
              @click="confirmDeleteItem"
            >
              <LoaderCircle v-if="deleteSaving" class="spin" :size="14" />
              <Trash2 v-else :size="14" />确认删除
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
              <span>PROMPT WORKFLOW</span>
              <h2 id="prompt-graph-title">差异化 Prompt 生成工作流</h2>
              <p>展示本次真实输入、阶段产物和质量结论。</p>
            </div>
            <button
              ref="graphCloseButton"
              type="button"
              aria-label="关闭工作流"
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
                <div
                  class="graph-row"
                  :class="{ parallel: row.length > 1, generation: row.length === 6 }"
                >
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
            <aside class="workflow-node-detail" aria-live="polite">
              <div v-if="!selectedGraphNodeId" class="node-detail-empty">
                <Workflow :size="30" /><strong>选择节点查看安全详情</strong>
                <p>不会显示模型、Prompt 模板、原始响应或内部存储标识。</p>
              </div>
              <template v-else>
                <header class="node-detail-header">
                  <div>
                    <span>NODE DETAIL</span
                    ><strong>{{ graphDefinition(selectedGraphNodeId).label }}</strong>
                  </div>
                  <button
                    type="button"
                    aria-label="刷新当前节点详情"
                    :disabled="graphDetailLoading"
                    @click="refreshGraphDetail"
                  >
                    <RefreshCw :class="{ spin: graphDetailLoading }" :size="14" />
                  </button>
                </header>
                <div v-if="graphDetailLoading" class="node-detail-message loading" role="status">
                  <LoaderCircle class="spin" :size="13" />正在同步节点安全摘要…
                </div>
                <div v-if="graphDetailError" class="node-detail-message error" role="alert">
                  <AlertCircle :size="13" />{{ graphDetailError }}
                </div>

                <template v-if="graphDetail">
                  <div class="node-detail-status">
                    <em :class="`is-${graphStatusMeta(graphDetail.status).tone}`">
                      {{ graphStatusMeta(graphDetail.status).label }}
                    </em>
                    <span>
                      <small>更新时间</small>
                      <time :datetime="graphDetail.updatedAt ?? undefined">{{
                        formatGraphDetailTime(graphDetail.updatedAt)
                      }}</time>
                    </span>
                  </div>
                  <p class="node-summary">{{ graphDetail.summary }}</p>

                  <dl v-if="graphDetail.fields.length" class="node-fields">
                    <div
                      v-for="(field, index) in graphDetail.fields"
                      :key="`${field.label}-${index}`"
                    >
                      <dt>
                        <span>{{ field.label }}</span>
                        <small v-if="field.description">{{ field.description }}</small>
                      </dt>
                      <dd :class="{ 'is-multiline': graphDetailValueIsMultiline(field.value) }">
                        {{ graphDetailValue(field.value) }}
                      </dd>
                    </div>
                  </dl>

                  <section
                    v-for="(block, blockIndex) in graphDetail.blocks"
                    :key="`${block.kind}-${blockIndex}`"
                    class="node-result-block"
                  >
                    <h3>{{ block.title }}</h3>

                    <div v-if="block.kind === 'TAG_LIST'" class="node-tag-groups">
                      <div v-for="group in block.groups" :key="group.label">
                        <strong>{{ group.label }}</strong>
                        <p>
                          <span v-for="value in group.values" :key="value">{{ value }}</span>
                          <em v-if="group.remainingCount">＋{{ group.remainingCount }} 项</em>
                        </p>
                      </div>
                    </div>

                    <div v-else-if="block.kind === 'ROUTE_LIST'" class="node-route-list">
                      <article v-for="route in block.items" :key="route.fragmentType">
                        <header>
                          <strong>{{
                            EFFECT_PROMPT_FRAGMENT_TYPE_LABELS[route.fragmentType]
                          }}</strong>
                          <em :class="`is-${graphStatusMeta(route.status).tone}`">{{
                            graphStatusMeta(route.status).label
                          }}</em>
                        </header>
                        <p>
                          <span>目标 {{ route.targetCount }}</span
                          ><span>候选 {{ route.candidateCount }}</span
                          ><span>分片 {{ route.completedShards }}/{{ route.totalShards }}</span>
                        </p>
                        <small v-if="route.failedShards">{{ route.failedShards }} 个分片失败</small>
                      </article>
                    </div>

                    <div
                      v-else-if="block.kind === 'COMBINATION_LIST'"
                      class="node-combination-list"
                    >
                      <article v-for="item in block.items" :key="item.title">
                        <header>
                          <strong>{{ item.title }}</strong
                          ><span>{{ item.targetDurationSeconds }} 秒</span>
                        </header>
                        <dl>
                          <div v-for="dimension in EFFECT_PROMPT_DIMENSIONS" :key="dimension.key">
                            <dt>{{ dimension.label }}</dt>
                            <dd>{{ item.dimensions[dimension.key] }}</dd>
                          </div>
                          <div>
                            <dt>连续动作</dt>
                            <dd>{{ item.visibleAction || '未记录' }}</dd>
                          </div>
                          <div>
                            <dt>证据方式</dt>
                            <dd>{{ graphEvidenceModeLabel(item.evidenceMode) || '未记录' }}</dd>
                          </div>
                        </dl>
                      </article>
                    </div>

                    <div v-else-if="block.kind === 'PROMPT_LIST'" class="node-prompt-list">
                      <details v-for="item in block.items" :key="`${item.code}-${item.content}`">
                        <summary>
                          <span
                            ><strong>{{ item.code }}</strong
                            >{{ EFFECT_PROMPT_FRAGMENT_TYPE_LABELS[item.fragmentType] }}</span
                          ><em>{{ item.targetDurationSeconds }} 秒 · 展开全文</em>
                        </summary>
                        <div class="node-sample-tags">
                          <span v-for="tag in item.materialTags" :key="tag">{{ tag }}</span>
                        </div>
                        <p class="node-prompt-content">{{ item.content }}</p>
                        <dl class="node-prompt-dimensions">
                          <div v-for="dimension in EFFECT_PROMPT_DIMENSIONS" :key="dimension.key">
                            <dt>{{ dimension.label }}</dt>
                            <dd>{{ item.dimensions[dimension.key] }}</dd>
                          </div>
                        </dl>
                      </details>
                    </div>

                    <div v-else-if="block.kind === 'PAIR_LIST'" class="node-pair-list">
                      <details
                        v-for="(item, pairIndex) in block.items"
                        :key="`${item.left.code}-${item.right.code}-${pairIndex}`"
                      >
                        <summary>
                          <span
                            ><strong>{{ item.left.code }} ↔ {{ item.right.code }}</strong
                            >{{ item.reasons.join('、') }}</span
                          ><em>{{ graphPairScore(item.score) }} · 展开对比</em>
                        </summary>
                        <div class="node-pair-contents">
                          <article>
                            <strong
                              >{{ item.left.code }} ·
                              {{
                                EFFECT_PROMPT_FRAGMENT_TYPE_LABELS[item.left.fragmentType]
                              }}</strong
                            >
                            <p>{{ item.left.content }}</p>
                          </article>
                          <article>
                            <strong
                              >{{ item.right.code }} ·
                              {{
                                EFFECT_PROMPT_FRAGMENT_TYPE_LABELS[item.right.fragmentType]
                              }}</strong
                            >
                            <p>{{ item.right.content }}</p>
                          </article>
                        </div>
                      </details>
                    </div>

                    <div v-else-if="block.kind === 'ISSUE_LIST'" class="node-issue-list">
                      <article v-for="item in block.items" :key="item.code">
                        <header>
                          <strong>{{ item.label }}</strong
                          ><em>{{ item.count }} 条</em>
                        </header>
                        <details v-if="item.examples.length">
                          <summary>查看实际问题示例</summary>
                          <p v-for="example in item.examples" :key="example">{{ example }}</p>
                        </details>
                      </article>
                    </div>
                  </section>

                  <div
                    v-if="!graphDetail.fields.length && !graphDetail.blocks.length"
                    class="node-detail-no-fields"
                  >
                    <Workflow :size="16" />
                    <span>{{ graphDetailEmptyMessage(graphDetail) }}</span>
                  </div>

                  <div v-for="warning in graphDetail.warnings" :key="warning" class="node-warning">
                    <AlertCircle :size="12" />{{ warning }}
                  </div>
                  <div v-if="graphDetail.errorMessage" class="node-warning error">
                    <AlertCircle :size="12" />{{ graphDetail.errorMessage }}
                  </div>
                </template>
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
  margin-left: auto;
  align-items: center;
  justify-content: flex-end;
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
  width: 230px;
  height: 40px;
  padding: 0 34px 0 13px;
  color: #42526a;
  background: #fff;
  border: 1px solid #dbe4f6;
  border-radius: 10px;
}
.effect-prompt-heading__actions .secondary-button {
  min-width: 139px;
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
  grid-template-columns: 1fr;
  align-items: center;
  gap: 12px;
  background: #fff;
  border: 1px solid #f0e3dc;
  border-radius: 18px;
}
.settings-heading {
  display: flex;
  padding: 0 16px;
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
.fragment-batch-summary {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
.fragment-batch-summary > div {
  display: grid;
  min-height: 76px;
  padding: 12px 16px;
  grid-template-columns: 1fr auto;
  align-items: center;
  gap: 3px 12px;
  background: linear-gradient(135deg, #f7faff, #fbfcff);
  border: 1px solid #dfe8f7;
  border-radius: 13px;
}
.fragment-batch-summary span {
  color: #62718a;
  font-size: 12px;
  font-weight: 700;
}
.fragment-batch-summary strong {
  grid-row: 1/3;
  grid-column: 2;
  color: #1f4fae;
  font-size: 21px;
}
.fragment-batch-summary small {
  color: #98a3b5;
  font-size: 10px;
}
.fragment-config-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}
.fragment-config-card {
  min-width: 0;
  overflow: hidden;
  background: #fbfcfe;
  border: 1px solid #e2e8f2;
  border-radius: 14px;
  transition:
    border-color 0.18s,
    box-shadow 0.18s;
}
.fragment-config-card.active {
  border-color: #7ba7ff;
  box-shadow: 0 0 0 3px rgb(37 99 235 / 9%);
}
.fragment-config-card__filter {
  display: flex;
  width: 100%;
  padding: 11px 13px;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  color: #35445c;
  background: #f6f9fe;
  border: 0;
  border-bottom: 1px solid #e8edf5;
  text-align: left;
}
.fragment-config-card__filter:hover {
  background: #eef5ff;
}
.fragment-config-card.active .fragment-config-card__filter {
  color: #1e55b7;
  background: #edf4ff;
}
.fragment-config-card__filter span {
  display: grid;
  gap: 2px;
}
.fragment-config-card__filter strong {
  font-size: 12px;
}
.fragment-config-card__filter small {
  color: #8b98ad;
  font-size: 9px;
  font-weight: 500;
}
.fragment-config-card__filter em {
  flex: 0 0 auto;
  padding: 4px 8px;
  color: #5171a8;
  background: #fff;
  border: 1px solid #dce6f5;
  border-radius: 999px;
  font-size: 10px;
  font-style: normal;
  font-weight: 800;
}
.fragment-config-card__controls {
  display: grid;
  padding: 11px 12px 12px;
  gap: 8px;
}
.fragment-inline-setting {
  display: grid;
  grid-template-columns: minmax(64px, 1fr) 132px;
  align-items: center;
  gap: 8px;
  color: #6b778c;
  font-size: 10px;
  font-weight: 700;
}
.fragment-inline-setting .number-control {
  grid-row: auto;
  grid-column: auto;
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
.unified-render-profile {
  display: grid;
  margin-top: 10px;
  padding: 14px 16px;
  gap: 12px;
  background: #f8fbff;
  border: 1px solid #dae6f7;
  border-radius: 13px;
}
.render-profile-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.render-profile-heading > div {
  display: grid;
  gap: 3px;
}
.render-profile-heading strong,
.shared-disabled-elements strong {
  color: #2f405c;
  font-size: 11px;
}
.render-profile-heading span {
  color: #7c899d;
  font-size: 9px;
}
.render-profile-heading > small {
  padding: 4px 8px;
  color: #805b17;
  background: #fff4d8;
  border-radius: 999px;
  font-size: 9px;
  white-space: nowrap;
}
.render-profile-values {
  display: grid;
  grid-template-columns: minmax(100px, 0.7fr) minmax(120px, 0.8fr) minmax(220px, 1.6fr);
  gap: 8px;
}
.render-profile-values > span {
  display: grid;
  padding: 9px 11px;
  gap: 3px;
  background: #fff;
  border: 1px solid #e4ebf5;
  border-radius: 9px;
}
.render-profile-values small {
  color: #8793a6;
  font-size: 9px;
}
.render-profile-values b {
  color: #3e506d;
  font-size: 10px;
}
.shared-disabled-elements {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.shared-disabled-elements > div {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.shared-disabled-elements span,
.shared-disabled-elements em {
  padding: 4px 8px;
  color: #5d6d84;
  background: #edf3fb;
  border-radius: 999px;
  font-size: 9px;
  font-style: normal;
}
.quality-breakdown {
  display: grid;
  margin-top: 10px;
  padding: 12px 14px;
  grid-template-columns: minmax(0, 2fr) minmax(240px, 1fr);
  gap: 14px;
  background: #fff;
  border: 1px solid #e3e9f2;
  border-radius: 13px;
}
.quality-breakdown > div {
  display: flex;
  min-width: 0;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  color: #647187;
  font-size: 9px;
}
.quality-breakdown strong {
  margin-right: 3px;
  color: #33415a;
  font-size: 10px;
}
.quality-breakdown span,
.quality-breakdown em {
  padding: 4px 7px;
  background: #f2f6fc;
  border-radius: 999px;
  font-style: normal;
}
.quality-breakdown span.missing,
.quality-breakdown em.missing,
.quality-breakdown em:first-of-type:not(:last-child) {
  color: #a46b0a;
  background: #fff5dc;
}
.quality-breakdown .insight-utilization {
  grid-column: 1 / -1;
  padding-top: 9px;
  border-top: 1px dashed #e4e9f2;
}
.quality-breakdown .insight-utilization .adaptive {
  color: #6f5aa7;
  background: #f5f1ff;
}
.quality-breakdown .insight-utilization .constraint {
  color: #28725f;
  background: #edf9f5;
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
.prompt-main > header em.duration-tag {
  color: #4f6f9f;
  background: #eef5ff;
  border-color: #cfdef4;
}
.material-tags {
  display: flex;
  margin: 7px 0 8px;
  align-items: center;
  flex-wrap: wrap;
  gap: 5px;
}
.material-tags small {
  color: #8995a8;
  font-size: 9px;
}
.material-tags span {
  padding: 3px 6px;
  color: #4c6f9f;
  background: #edf4ff;
  border-radius: 5px;
  font-size: 9px;
}
.material-tags em {
  color: #a0a8b5;
  font-size: 9px;
  font-style: normal;
}
.insight-source-tags {
  display: flex;
  margin: -2px 0 8px;
  align-items: center;
  flex-wrap: wrap;
  gap: 5px;
}
.insight-source-tags small {
  color: #8995a8;
  font-size: 9px;
}
.insight-source-tags span {
  padding: 3px 6px;
  color: #28725f;
  background: #edf9f5;
  border: 1px solid #d3eee5;
  border-radius: 5px;
  font-size: 9px;
}
.prompt-dimension-details {
  margin-top: 7px;
  color: #78869a;
  font-size: 9px;
}
.prompt-dimension-details summary {
  width: max-content;
  cursor: pointer;
  color: #5577a8;
}
.prompt-dimension-details .prompt-dimensions {
  margin: 7px 0 0;
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
  min-height: 132px;
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
.prompt-regeneration-dialog,
.prompt-delete-dialog,
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
.prompt-regeneration-dialog {
  width: min(1040px, 100%);
  max-height: calc(100vh - 40px);
  padding: 24px;
  overflow: auto;
  background: #fff;
  border: 1px solid #dbe4f6;
  border-radius: 22px;
  box-shadow: 0 24px 70px #0f172a38;
}
.prompt-regeneration-dialog > header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 18px;
}
.prompt-regeneration-dialog > header span {
  color: #2563eb;
  font-size: 10px;
  font-weight: 900;
  letter-spacing: 0.1em;
}
.prompt-regeneration-dialog > header h2 {
  margin: 4px 0 7px;
  color: #17233a;
  font-size: 22px;
}
.prompt-regeneration-dialog > header p {
  display: flex;
  margin: 0;
  flex-wrap: wrap;
  align-items: center;
  gap: 7px;
  color: #738198;
  font-size: 11px;
}
.prompt-regeneration-dialog > header p strong,
.prompt-regeneration-dialog > header p i {
  padding: 4px 8px;
  background: #f2f6ff;
  border: 1px solid #dce7fb;
  border-radius: 999px;
  font-style: normal;
}
.prompt-regeneration-dialog > header p strong {
  color: #1d4ed8;
}
.prompt-regeneration-dialog > header > button {
  display: grid;
  width: 36px;
  height: 36px;
  flex: 0 0 auto;
  place-items: center;
  color: #64748b;
  background: #f7f9fc;
  border: 1px solid #dfe6f0;
  border-radius: 10px;
}
.regeneration-prompt-preview {
  margin: 18px 0 14px;
  padding: 12px 14px;
  color: #526078;
  background: #f8faff;
  border: 1px solid #e1e9f7;
  border-radius: 13px;
}
.regeneration-prompt-preview summary {
  cursor: pointer;
  color: #334155;
  font-size: 12px;
  font-weight: 800;
}
.regeneration-prompt-preview p {
  margin: 10px 0 0;
  padding-top: 10px;
  border-top: 1px dashed #dbe4f2;
  font-size: 12px;
  line-height: 1.75;
  white-space: pre-wrap;
}
.regeneration-toolbar {
  display: flex;
  margin-bottom: 10px;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.regeneration-toolbar > div {
  display: flex;
  align-items: center;
  gap: 9px;
}
.regeneration-toolbar span {
  color: #26354d;
  font-size: 14px;
  font-weight: 900;
}
.regeneration-toolbar strong {
  padding: 4px 8px;
  color: #2563eb;
  background: #eff6ff;
  border-radius: 999px;
  font-size: 10px;
}
.regeneration-toolbar button,
.prompt-regeneration-dialog > footer button {
  display: inline-flex;
  height: 38px;
  padding: 0 14px;
  align-items: center;
  justify-content: center;
  gap: 6px;
  color: #536178;
  background: #fff;
  border: 1px solid #dbe4f6;
  border-radius: 9px;
  font-size: 11px;
  font-weight: 800;
}
.regeneration-toolbar button:disabled,
.prompt-regeneration-dialog > footer button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}
.regeneration-dimension-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 11px;
}
.regeneration-dimension-card {
  min-width: 0;
  padding: 13px;
  background: #fbfcff;
  border: 1px solid #e0e7f2;
  border-radius: 14px;
  transition:
    border-color 160ms ease,
    box-shadow 160ms ease;
}
.regeneration-dimension-card.changed {
  background: #f8fbff;
  border-color: #6b9cff;
  box-shadow: 0 0 0 3px #2563eb12;
}
.regeneration-dimension-card > header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.regeneration-dimension-card > header span {
  color: #26354d;
  font-size: 12px;
  font-weight: 900;
}
.regeneration-dimension-card > header em {
  padding: 3px 6px;
  color: #1d4ed8;
  background: #eaf2ff;
  border-radius: 999px;
  font-size: 9px;
  font-style: normal;
  font-weight: 800;
}
.regeneration-original-value {
  min-height: 39px;
  margin: 9px 0;
  color: #7b879a;
  font-size: 10px;
  line-height: 1.45;
}
.regeneration-original-value small {
  display: block;
  margin-bottom: 2px;
  color: #a0a9b7;
  font-size: 8px;
  font-weight: 800;
}
.regeneration-dimension-card label > span,
.regeneration-instruction > span {
  display: block;
  margin-bottom: 5px;
  color: #536178;
  font-size: 10px;
  font-weight: 800;
}
.regeneration-dimension-card input,
.regeneration-dimension-card select,
.regeneration-instruction textarea {
  width: 100%;
  color: #344157;
  background: #fff;
  border: 1px solid #d8e2f0;
  border-radius: 9px;
  outline: none;
  font-family: inherit;
  font-size: 11px;
}
.regeneration-dimension-card input,
.regeneration-dimension-card select {
  height: 38px;
  padding: 0 10px;
}
.regeneration-dimension-card input:focus,
.regeneration-dimension-card select:focus,
.regeneration-instruction textarea:focus {
  border-color: #6b9cff;
  box-shadow: 0 0 0 3px #2563eb12;
}
.regeneration-suggestion-list {
  display: flex;
  margin-top: 8px;
  overflow: hidden;
  gap: 5px;
}
.regeneration-suggestion-list button {
  min-width: 0;
  padding: 4px 7px;
  overflow: hidden;
  color: #68768b;
  background: #fff;
  border: 1px solid #e0e7f2;
  border-radius: 999px;
  font-size: 8px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.regeneration-suggestion-list button.active {
  color: #1d4ed8;
  background: #eff6ff;
  border-color: #93b4ff;
}
.regeneration-change {
  display: flex;
  margin: 8px 0 0;
  align-items: center;
  gap: 4px;
  color: #94a0b1;
  font-size: 9px;
}
.regeneration-change strong {
  min-width: 0;
  overflow: hidden;
  color: #1d4ed8;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.selling-point-note {
  display: block;
  margin-top: 8px;
  color: #7b879a;
  font-size: 9px;
  line-height: 1.45;
}
.regeneration-instruction {
  position: relative;
  display: block;
  margin-top: 14px;
}
.regeneration-instruction > span em {
  color: #8b97aa;
  font-style: normal;
  font-weight: 500;
}
.regeneration-instruction textarea {
  min-height: 92px;
  padding: 10px 12px 26px;
  resize: vertical;
  line-height: 1.65;
}
.regeneration-instruction > small {
  position: absolute;
  right: 11px;
  bottom: 8px;
  color: #8b97aa;
  font-size: 9px;
}
.prompt-regeneration-dialog > footer {
  display: flex;
  margin-top: 16px;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
}
.prompt-regeneration-dialog > footer p {
  margin: 0;
  color: #77859a;
  font-size: 10px;
}
.prompt-regeneration-dialog > footer > div {
  display: flex;
  flex: 0 0 auto;
  gap: 8px;
}
.prompt-regeneration-dialog > footer .primary-button {
  min-width: 168px;
  color: #fff;
  background: var(--effect-blue);
  border-color: var(--effect-blue);
}
.prompt-delete-dialog {
  display: grid;
  width: min(520px, 100%);
  padding: 22px;
  grid-template-columns: 44px minmax(0, 1fr);
  gap: 14px;
}
.delete-dialog-icon {
  display: grid;
  width: 42px;
  height: 42px;
  place-items: center;
  color: #dc2626;
  background: #fff1f2;
  border: 1px solid #fecdd3;
  border-radius: 12px;
}
.prompt-delete-dialog > div > span {
  color: #dc2626;
  font-size: 10px;
  font-weight: 900;
  letter-spacing: 0.08em;
}
.prompt-delete-dialog h2 {
  margin: 4px 0 7px;
  color: #1d2940;
  font-size: 19px;
}
.prompt-delete-dialog p {
  margin: 0;
  color: #66758c;
  font-size: 12px;
  line-height: 1.7;
}
.prompt-delete-dialog > footer {
  display: flex;
  grid-column: 1 / -1;
  justify-content: flex-end;
  gap: 8px;
}
.prompt-delete-dialog > footer button {
  display: inline-flex;
  height: 38px;
  padding: 0 16px;
  align-items: center;
  justify-content: center;
  gap: 6px;
  color: #536178;
  background: #fff;
  border: 1px solid #dbe4f6;
  border-radius: 9px;
  font-size: 12px;
  font-weight: 800;
}
.prompt-delete-dialog > footer .danger-button {
  color: #fff;
  background: #dc2626;
  border-color: #dc2626;
}
.prompt-delete-dialog > footer button:disabled {
  cursor: not-allowed;
  opacity: 0.58;
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
.editor-wide-field {
  grid-column: 1 / -1;
}
.prompt-editor-dialog label > span {
  display: block;
  margin-bottom: 6px;
  color: #4d5b72;
  font-size: 11px;
  font-weight: 800;
}
.prompt-editor-dialog label > small {
  display: block;
  margin-top: 5px;
  color: #8995a8;
  font-size: 9px;
  line-height: 1.45;
}
.prompt-editor-dialog input[readonly] {
  color: #6b778b;
  background: #f4f6f9;
  cursor: not-allowed;
}
.prompt-editor-dialog input,
.prompt-editor-dialog select,
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
.prompt-editor-dialog select {
  width: 100%;
  height: 39px;
  padding: 0 11px;
  background: #fff;
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
.editor-content > small {
  display: block;
  margin: -2px 0 7px;
  color: #8995a8;
  font-size: 9px;
  line-height: 1.55;
}
.prompt-editor-dialog input:focus,
.prompt-editor-dialog select:focus,
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
  width: min(1280px, 100%);
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
  grid-template-columns: minmax(0, 1fr) 420px;
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
.graph-row.generation {
  grid-template-columns: repeat(3, minmax(0, 1fr));
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
.node-detail-header {
  display: flex;
  padding-bottom: 12px;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  border-bottom: 1px solid #e7edf8;
}
.node-detail-header span,
.node-detail-header strong {
  display: block;
}
.node-detail-header span {
  color: #2563eb;
  font-size: 9px;
  font-weight: 850;
  letter-spacing: 0.08em;
}
.node-detail-header strong {
  margin-top: 4px;
  color: #253047;
  font-size: 14px;
}
.node-detail-header button {
  display: grid;
  width: 30px;
  height: 30px;
  padding: 0;
  flex: 0 0 auto;
  place-items: center;
  color: #2563eb;
  background: #edf4ff;
  border: 0;
  border-radius: 8px;
}
.node-detail-header button:disabled {
  opacity: 0.55;
}
.node-detail-message {
  display: flex;
  margin-top: 10px;
  padding: 8px 9px;
  align-items: center;
  gap: 6px;
  font-size: 9px;
  border-radius: 8px;
}
.node-detail-message.loading {
  color: #2563eb;
  background: #edf4ff;
}
.node-detail-message.error {
  color: #bd3346;
  background: #fff1f2;
}
.node-detail-status {
  display: flex;
  margin-top: 13px;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.node-detail-status em {
  padding: 4px 7px;
  color: #718096;
  background: #f1f4f8;
  border-radius: 999px;
  font-size: 8px;
  font-style: normal;
  font-weight: 800;
}
.node-detail-status em.is-running {
  color: #2563eb;
  background: #eaf2ff;
}
.node-detail-status em.is-success {
  color: #0f8a68;
  background: #eaf8f3;
}
.node-detail-status em.is-warning,
.node-detail-status em.is-skipped {
  color: #a46b0a;
  background: #fff5dc;
}
.node-detail-status em.is-danger {
  color: #c93448;
  background: #fff0f2;
}
.node-detail-status > span {
  display: grid;
  justify-items: end;
  gap: 2px;
  color: #8994a8;
  font-size: 8px;
}
.node-detail-status small,
.node-detail-status time {
  font: inherit;
}
.node-detail-status time {
  color: #5f6d82;
  font-weight: 700;
}
.node-summary {
  margin: 10px 0 0;
  color: #4d5b72;
  font-size: 10px;
  line-height: 1.65;
}
.node-fields {
  display: grid;
  margin: 12px 0 0;
  gap: 7px;
}
.node-fields > div {
  padding: 8px 9px;
  background: #f7f9fd;
  border: 1px solid #e8edf6;
  border-radius: 8px;
}
.node-fields dt {
  display: grid;
  gap: 3px;
  color: #7b879a;
  font-size: 8px;
}
.node-fields dt span {
  color: #65738a;
  font-weight: 800;
}
.node-fields dt small {
  color: #929db0;
  font-size: 8px;
  line-height: 1.45;
}
.node-fields dd {
  margin: 5px 0 0;
  overflow-wrap: anywhere;
  white-space: normal;
  color: #33415a;
  font-size: 10px;
  font-weight: 700;
  line-height: 1.55;
}
.node-fields dd.is-multiline {
  max-height: 190px;
  padding: 8px;
  overflow: auto;
  white-space: pre-wrap;
  background: #fff;
  border: 1px solid #e3e9f3;
  border-radius: 7px;
  font-weight: 600;
}
.node-result-block {
  display: grid;
  margin-top: 13px;
  gap: 8px;
}
.node-result-block > h3 {
  margin: 0;
  color: #4d5b72;
  font-size: 9px;
  font-weight: 900;
  letter-spacing: 0.04em;
}
.node-tag-groups,
.node-route-list,
.node-combination-list,
.node-prompt-list,
.node-pair-list,
.node-issue-list {
  display: grid;
  gap: 7px;
}
.node-tag-groups > div,
.node-route-list > article,
.node-combination-list > article,
.node-prompt-list > details,
.node-pair-list > details,
.node-issue-list > article {
  min-width: 0;
  padding: 9px;
  background: #f7f9fd;
  border: 1px solid #e4eaf4;
  border-radius: 9px;
}
.node-tag-groups > div > strong {
  display: block;
  margin-bottom: 6px;
  color: #65738a;
  font-size: 8px;
}
.node-tag-groups p,
.node-sample-tags {
  display: flex;
  margin: 0;
  flex-wrap: wrap;
  gap: 5px;
}
.node-tag-groups p span,
.node-tag-groups p em,
.node-sample-tags span {
  padding: 3px 6px;
  color: #315c9f;
  background: #eaf2ff;
  border-radius: 999px;
  font-size: 8px;
  font-style: normal;
  line-height: 1.35;
}
.node-tag-groups p em {
  color: #6f7d92;
  background: #edf0f5;
}
.node-route-list article > header,
.node-combination-list article > header,
.node-issue-list article > header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.node-route-list article > header strong,
.node-combination-list article > header strong,
.node-issue-list article > header strong {
  min-width: 0;
  color: #33415a;
  font-size: 9px;
  overflow-wrap: anywhere;
}
.node-route-list article > header em,
.node-combination-list article > header span,
.node-issue-list article > header em {
  flex: 0 0 auto;
  padding: 3px 6px;
  color: #64748b;
  background: #edf0f5;
  border-radius: 999px;
  font-size: 8px;
  font-style: normal;
}
.node-route-list article > header em.is-running {
  color: #2563eb;
  background: #eaf2ff;
}
.node-route-list article > header em.is-success {
  color: #0f8a68;
  background: #eaf8f3;
}
.node-route-list article > header em.is-warning,
.node-route-list article > header em.is-skipped {
  color: #a46b0a;
  background: #fff5dc;
}
.node-route-list article > header em.is-danger {
  color: #c93448;
  background: #fff0f2;
}
.node-route-list article > p {
  display: flex;
  margin: 7px 0 0;
  flex-wrap: wrap;
  gap: 8px;
  color: #65738a;
  font-size: 8px;
}
.node-route-list article > small {
  display: block;
  margin-top: 6px;
  color: #c93448;
  font-size: 8px;
}
.node-combination-list article > dl,
.node-prompt-dimensions {
  display: grid;
  margin: 8px 0 0;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px 8px;
}
.node-combination-list dl > div,
.node-prompt-dimensions > div {
  min-width: 0;
}
.node-combination-list dt,
.node-prompt-dimensions dt {
  color: #8994a8;
  font-size: 8px;
}
.node-combination-list dd,
.node-prompt-dimensions dd {
  margin: 2px 0 0;
  color: #3d4b62;
  font-size: 8px;
  font-weight: 700;
  line-height: 1.45;
  overflow-wrap: anywhere;
}
.node-prompt-list details > summary,
.node-pair-list details > summary,
.node-issue-list details > summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  color: #33415a;
  cursor: pointer;
  list-style: none;
  outline: none;
}
.node-prompt-list details > summary::-webkit-details-marker,
.node-pair-list details > summary::-webkit-details-marker,
.node-issue-list details > summary::-webkit-details-marker {
  display: none;
}
.node-prompt-list details > summary:focus-visible,
.node-pair-list details > summary:focus-visible,
.node-issue-list details > summary:focus-visible {
  border-radius: 5px;
  box-shadow: 0 0 0 3px #2563eb24;
}
.node-prompt-list summary > span,
.node-pair-list summary > span {
  display: grid;
  min-width: 0;
  gap: 3px;
  color: #6f7d92;
  font-size: 8px;
  line-height: 1.4;
}
.node-prompt-list summary strong,
.node-pair-list summary strong {
  color: #33415a;
  font-size: 9px;
}
.node-prompt-list summary > em,
.node-pair-list summary > em {
  flex: 0 0 auto;
  color: #2563eb;
  font-size: 8px;
  font-style: normal;
  font-weight: 800;
}
.node-sample-tags {
  margin-top: 9px;
}
.node-prompt-content,
.node-pair-contents article > p {
  margin: 8px 0 0;
  padding: 9px;
  color: #344258;
  background: #fff;
  border: 1px solid #e4eaf4;
  border-radius: 7px;
  font-size: 9px;
  line-height: 1.72;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.node-pair-contents {
  display: grid;
  margin-top: 9px;
  gap: 7px;
}
.node-pair-contents article > strong {
  color: #516077;
  font-size: 8px;
}
.node-issue-list article > details {
  margin-top: 7px;
}
.node-issue-list details > summary {
  justify-content: flex-start;
  color: #2563eb;
  font-size: 8px;
  font-weight: 800;
}
.node-issue-list details > p {
  margin: 7px 0 0;
  padding: 7px;
  color: #6f4d16;
  background: #fff9eb;
  border-radius: 6px;
  font-size: 8px;
  line-height: 1.55;
}
.node-detail-no-fields {
  display: flex;
  margin-top: 12px;
  padding: 11px;
  align-items: flex-start;
  gap: 8px;
  color: #6f7d92;
  background: #f7f9fd;
  border: 1px dashed #dbe4f1;
  border-radius: 9px;
  font-size: 9px;
  line-height: 1.6;
}
.node-detail-no-fields svg {
  flex: 0 0 auto;
  margin-top: 1px;
  color: #7da4e8;
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
  .fragment-config-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .quality-breakdown {
    grid-template-columns: 1fr;
  }
  .render-profile-values {
    grid-template-columns: repeat(3, minmax(0, 1fr));
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
  .regeneration-dimension-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
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
  .render-profile-heading {
    flex-direction: column;
  }
  .render-profile-values {
    grid-template-columns: 1fr;
  }
  .fragment-batch-summary,
  .fragment-config-grid {
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
  .regeneration-dimension-grid,
  .graph-row.parallel {
    grid-template-columns: 1fr;
  }
  .prompt-regeneration-dialog {
    padding: 18px;
  }
  .prompt-regeneration-dialog > footer {
    align-items: stretch;
    flex-direction: column;
  }
  .prompt-regeneration-dialog > footer > div,
  .prompt-regeneration-dialog > footer button {
    width: 100%;
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
