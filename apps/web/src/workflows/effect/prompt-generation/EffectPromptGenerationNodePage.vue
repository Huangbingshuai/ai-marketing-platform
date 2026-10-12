<script setup lang="ts">
import WorkflowExecutionGraphDialog from "../../../platform/workflow/components/WorkflowExecutionGraphDialog.vue";
import type {
  EffectImportProduct,
  EffectPromptBatchSettings,
  EffectPromptDimensionKey,
  EffectPromptDimensions,
  EffectPromptFragmentType,
  EffectPromptItem,
  EffectPromptInsightField,
  EffectPromptNodeExecution,
  EffectPromptNodeId,
  EffectPromptProductState,
  EffectPromptPurposeMatchMode,
  EffectPromptRun,
  EffectPromptStageStatus,
  GetEffectPromptNodeDetailData,
} from '@ai-marketing/contracts';
import {
  DEFAULT_EFFECT_PROMPT_SETTINGS,
  EFFECT_DELIVERY_CHANNELS,
  EFFECT_PROMPT_DIMENSIONS,
  EFFECT_PROMPT_FRAGMENT_TYPE_LABELS,
  EFFECT_PROMPT_FRAGMENT_TYPES,
  EFFECT_PROMPT_GRAPH_NODES,
  EFFECT_PROMPT_LIMITS,
  EFFECT_PROMPT_SEMANTIC_DUPLICATE_RATE_LIMIT,
  EFFECT_PROMPT_GRAPH_EDGES,
  EFFECT_PROMPT_GRAPH_NODE_IDS,
  EFFECT_STYLE_TONES,
  effectPromptRunGraphEdges,
  effectPromptRunGraphNodeIds,
} from '@ai-marketing/contracts';
import { WorkflowNodeFooter, WorkflowRunProgress } from '@ai-marketing/ui';
import {
  Activity,
  AlertCircle,
  ArrowDownToLine,
  ArrowUpFromLine,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
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
import { computed, nextTick, onActivated, onBeforeUnmount, onDeactivated, ref, watch } from 'vue';

import { ApiClientError, isAbortError } from '../../../api/http-client';
import { useProjectContext } from '../../../platform/project/project-context';
import {
  beginEffectWorkflowNodeEdit,
  cancelEffectWorkflowNodeEdit,
  getActiveWorkflowRunOverview,
} from '../../../platform/workflow/api/workflow-working.api';
import { requestActionConfirmation } from '../../../shared/composables/action-confirmation';
import { confirmDiscardEffectEdit } from '../shared/effect-edit-session';
import EffectUpwardCreatableSelect from '../source-import/components/EffectUpwardCreatableSelect.vue';
import {
  buildEffectPromptGraphRows,
  promptGraphDetailContentKey,
  promptGraphDetailRefreshKey,
} from './effect-prompt-generation-graph';
import {
  clampPromptPage,
  clonePromptSettings,
  EFFECT_PROMPT_PAGE_SIZE_OPTIONS,
  isPromptProductCommitted,
  isPromptRunActive,
  normalizePromptSettings,
  promptPageCount,
  type EffectPromptPageStatus,
} from './effect-prompt-generation-state';
import {
  autoFillEffectPromptCreativeStructure,
  beginEffectPromptRun,
  commitEffectPromptResult,
  downloadEffectPromptBatch,
  loadEffectPromptNodeDetail,
  loadEffectPromptResult,
  loadEffectPromptRun,
  loadEffectPromptWorkspaceSnapshot,
  pollEffectPromptRun,
  removeEffectPromptItem,
  saveEffectPromptItem,
  savePromptSettings,
  type EffectPromptContext,
  type EffectPromptViewResultData,
  type PromptItemDraft,
} from './services/effect-prompt-generation.service';

const props = defineProps<{
  projectId: string;
  workflowRunId: string;
  products: EffectImportProduct[];
}>();

const projectContext = useProjectContext();

const emit = defineEmits<{ back: []; next: []; branchActivated: [] }>();

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';
type Notice = { kind: 'error' | 'success' | 'warning'; text: string };
type NodeDetail = GetEffectPromptNodeDetailData['detail'];
type ItemOperation = { itemId: string; kind: 'delete' };

const status = ref<EffectPromptPageStatus>('loading');
const loadError = ref('');
const productStates = ref<Record<string, EffectPromptProductState>>({});
const settingsDrafts = ref<Record<string, EffectPromptBatchSettings>>({});
const disabledElementsTextDrafts = ref<Record<string, string>>({});
const settingsSaveStatuses = ref<Record<string, SaveStatus>>({});
const currentProductId = ref('');
const resultData = ref<EffectPromptViewResultData | null>(null);
const resultLoading = ref(false);
const keyword = ref('');
const purposeFilter = ref<EffectPromptFragmentType | ''>('');
const includeCompatiblePurposes = ref(false);
const page = ref(1);
const pageSize = ref(EFFECT_PROMPT_LIMITS.pageSize);
const notice = ref<Notice | null>(null);
const itemOperation = ref<ItemOperation | null>(null);
const validating = ref(false);
const editPending = ref(false);
const editing = ref(false);
const exporting = ref(false);
const batchStartPending = ref(false);

const graphDialogOpen = ref(false);
const graphLoading = ref(false);
const graphError = ref('');
const runsByProduct = ref<Record<string, EffectPromptRun>>({});
const selectedGraphNodeId = ref<EffectPromptNodeId | null>(null);
const graphDetail = ref<NodeDetail | null>(null);
const graphDetailLoading = ref(false);
const graphDetailError = ref('');
const graphTrigger = ref<HTMLButtonElement | null>(null);


const editorOpen = ref(false);
const editorSaving = ref(false);
const editorAutoFilling = ref(false);
const editorMode = ref<'add' | 'edit'>('edit');
const editorItemId = ref('');
const editorDraft = ref<PromptItemDraft>({
  content: '',
  primaryPurpose: 'PRODUCT_DISPLAY',
  creativeCore: '',
  dimensions: {
    narrative: '',
    scene: '',
    persona: '',
    productRelation: '',
    camera: '',
    emotion: '',
  },
  targetDurationSeconds: DEFAULT_EFFECT_PROMPT_SETTINGS.defaultDurationSeconds,
});
const editorTrigger = ref<HTMLElement | null>(null);
const editorCloseButton = ref<HTMLButtonElement | null>(null);
const promptSearchInput = ref<HTMLInputElement | null>(null);

let disposed = false;
let nodeActive = true;
let activatedOnce = false;
let workspaceHydrating = false;
let workspaceGeneration = 0;
let resultGeneration = 0;
let workspaceController: AbortController | null = null;
let resultController: AbortController | null = null;
let operationController: AbortController | null = null;
let itemMutationController: AbortController | null = null;
let exportController: AbortController | null = null;
let graphDetailController: AbortController | null = null;
let graphStateController: AbortController | null = null;
let settingsTimer: ReturnType<typeof setTimeout> | undefined;
let searchTimer: ReturnType<typeof setTimeout> | undefined;
let noticeTimer: ReturnType<typeof setTimeout> | undefined;
let graphDetailRefreshTimer: ReturnType<typeof setTimeout> | undefined;
let workspaceRevalidationTimer: ReturnType<typeof setTimeout> | undefined;
const pollControllers = new Map<string, { controller: AbortController; runId: string }>();
const settingsControllers = new Map<string, AbortController>();
const settingsSavePromises = new Map<string, Promise<boolean>>();

const activeProducts = computed(() =>
  props.products.filter((product) => product.status === 'ACTIVE'),
);
const currentProduct = computed(
  () => activeProducts.value.find((product) => product.id === currentProductId.value) ?? null,
);
const currentState = computed(() => productStates.value[currentProductId.value] ?? null);
const hasConfirmedPrompt = computed(() =>
  Object.values(productStates.value).some((state) => state.commitStatus === 'COMMITTED'),
);
const canEditPrompt = computed(() => editing.value || !hasConfirmedPrompt.value);
const currentSettings = computed(
  () => settingsDrafts.value[currentProductId.value] ?? DEFAULT_EFFECT_PROMPT_SETTINGS,
);
const styleOptions = [
  { label: 'AI 根据场景选择', value: 'AI_AUTO' },
  ...EFFECT_STYLE_TONES.map((value) => ({ label: value, value })),
];
const deliveryChannelOptions = EFFECT_DELIVERY_CHANNELS.map((value) => ({ label: value, value }));
const currentStyleSelection = computed(() =>
  currentSettings.value.styleMode === 'FIXED' && currentSettings.value.styleTone
    ? currentSettings.value.styleTone
    : 'AI_AUTO',
);
const currentDisabledElementsText = computed(
  () => disabledElementsTextDrafts.value[currentProductId.value] ?? '',
);
const currentTargetCount = computed(() => currentSettings.value.targetCount);
const editorDurationRange = {
  minDurationSeconds: EFFECT_PROMPT_LIMITS.minDurationSeconds,
  maxDurationSeconds: EFFECT_PROMPT_LIMITS.maxManualDurationSeconds,
};
const currentRun = computed(() => runsByProduct.value[currentProductId.value] ?? null);
const displayedGraphRun = computed(() => currentRun.value);
const graphDialogDescription = '展示本次真实输入、连贯创意生成、用途评估和数量结果。';
const currentGraphNodeIds = computed<readonly EffectPromptNodeId[]>(() => {
  if (displayedGraphRun.value)
    return effectPromptRunGraphNodeIds(displayedGraphRun.value.operation);
  return EFFECT_PROMPT_GRAPH_NODE_IDS;
});
const currentGraphEdges = computed(() => {
  if (displayedGraphRun.value) return effectPromptRunGraphEdges(displayedGraphRun.value.operation);
  return EFFECT_PROMPT_GRAPH_EDGES;
});
const currentAttemptLabel = computed(() => {
  const run = displayedGraphRun.value;
  if (!run) return '';
  const attempt =
    run.status === 'QUEUED'
      ? Math.min(run.maxAttempts, run.attemptCount + 1)
      : Math.max(1, run.attemptCount);
  return `第 ${attempt}/${run.maxAttempts} 次尝试`;
});
const currentRetryWarning = computed(
  () => displayedGraphRun.value?.warnings.find((warning) => warning.includes('自动重新排队')) ?? '',
);
const currentStageLabel = computed(() => {
  const run = currentRun.value;
  const nodeId = run?.currentNode;
  if (!nodeId || nodeId === 'COMPLETED') return '正在生成候选 Prompt';
  const executionSummary = run.nodes.find((node) => node.nodeId === nodeId)?.summary.trim();
  if (executionSummary) return executionSummary;
  return (
    EFFECT_PROMPT_GRAPH_NODES.find((node) => node.id === nodeId)?.label ?? '正在生成候选 Prompt'
  );
});
const selectedGraphNodeIsActive = computed(
  () =>
    displayedGraphRun.value?.status === 'RUNNING' &&
    displayedGraphRun.value.currentNode === selectedGraphNodeId.value,
);
const currentGraphDetailUpdatedAt = computed(() => graphDetail.value?.updatedAt);
const currentResult = computed(() => resultData.value?.result ?? null);
const currentItems = computed(() => resultData.value?.items ?? []);
const partialPreview = computed(() => resultData.value?.isPartialPreview ?? false);
const currentMetrics = computed(
  () => currentResult.value?.metrics ?? currentState.value?.metrics ?? null,
);
const insightFieldLabels: Record<EffectPromptInsightField, string> = {
  PRODUCT_NAME: '产品名称',
  PRODUCT_CATEGORY: '产品品类',
  CORE_SPECIFICATION: '核心规格',
  PRICE_RANGE: '确认价格',
  VISUAL_FEATURES: '视觉特征',
  SELLING_POINT: '卖点',
  CORE_SELLING_POINT: '卖点（历史）',
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
  RESOLUTION: '分辨率',
  DELIVERY_CHANNELS: '投放渠道',
  DISABLED_ELEMENT: '禁用元素',
  VISUAL_STYLE_BASELINE: '视觉基线',
};
const itemInsightFacts = (item: EffectPromptItem) => [
  ...new Map(
    item.insightBindings.map((binding) => [
      binding.factId,
      {
        factId: binding.factId,
        field: binding.field,
        label: insightFieldLabels[binding.field],
        value: binding.value,
        role: binding.role,
      },
    ]),
  ).values(),
];
const itemInsightFactGroups = (item: EffectPromptItem) => {
  const facts = itemInsightFacts(item);
  return [
    {
      key: 'DIRECT',
      label: '画面直接依据',
      description: '正文直接呈现或明确表达的信息',
      facts: facts.filter((fact) => fact.role !== 'CONTEXT'),
    },
    {
      key: 'CONTEXT',
      label: '创意背景依据',
      description: '用于决定场景、人物、动作或商业语境的信息',
      facts: facts.filter((fact) => fact.role === 'CONTEXT'),
    },
  ].filter((group) => group.facts.length);
};
const currentCountStats = computed(() => {
  const targetCount = currentTargetCount.value;
  const actualCount = currentMetrics.value?.acceptedCount ?? resultData.value?.total ?? 0;
  return {
    targetCount,
    actualCount,
    missingCount: Math.max(0, targetCount - actualCount),
    excessCount: Math.max(0, actualCount - targetCount),
  };
});
const hasPromptFilters = computed(() => Boolean(keyword.value.trim() || purposeFilter.value));
const purposeMatchMode = computed<EffectPromptPurposeMatchMode>(() =>
  includeCompatiblePurposes.value ? 'PRIMARY_OR_COMPATIBLE' : 'PRIMARY',
);
const purposeCount = (purpose: EffectPromptFragmentType): number => {
  const distribution = currentMetrics.value?.purposeDistribution.find(
    (item) => item.purpose === purpose,
  );
  return includeCompatiblePurposes.value
    ? (distribution?.compatibleCount ?? 0)
    : (distribution?.primaryCount ?? 0);
};
const promptResultCountLabel = computed(() =>
  hasPromptFilters.value
    ? `找到 ${resultData.value?.total ?? 0} 条 · 批次共 ${currentCountStats.value.actualCount} 条`
    : `当前 ${currentCountStats.value.actualCount}/${currentCountStats.value.targetCount} 条 · ${
        currentCountStats.value.missingCount
          ? `缺少 ${currentCountStats.value.missingCount} 条`
          : currentCountStats.value.excessCount
            ? `超出 ${currentCountStats.value.excessCount} 条`
            : '数量一致'
      }`,
);
const currentRunning = computed(() => isPromptRunActive(currentState.value));
const currentSemanticEvaluation = computed(() => currentMetrics.value?.semanticEvaluation ?? null);
const currentSemanticDisplay = computed(() => {
  const evaluation = currentSemanticEvaluation.value;
  if (!evaluation || evaluation.status !== 'VERIFIED' || evaluation.duplicateRate === null)
    return {
      state: currentRunning.value ? 'running' : 'pending',
      text: currentRunning.value ? '正在计算语义重复度' : '语义重复度待评估',
    } as const;
  const passed = evaluation.duplicateRate < EFFECT_PROMPT_SEMANTIC_DUPLICATE_RATE_LIMIT;
  return {
    state: passed ? 'passed' : 'warning',
    text: passed
      ? `语义重复度 ${evaluation.duplicateRate.toFixed(1)}% · 参考 <${EFFECT_PROMPT_SEMANTIC_DUPLICATE_RATE_LIMIT}%`
      : `语义重复度 ${evaluation.duplicateRate.toFixed(1)}% · 偏高，但不影响提交`,
  } as const;
});
const totalPages = computed(() => promptPageCount(resultData.value?.total ?? 0, pageSize.value));
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
const currentSettingsPendingSave = computed(() => {
  const state = productStates.value[currentProductId.value];
  const draft = settingsDrafts.value[currentProductId.value];
  return Boolean(state && draft && JSON.stringify(state.settings) !== JSON.stringify(draft));
});
const currentGraphNodes = computed<EffectPromptNodeExecution[]>(() =>
  currentGraphNodeIds.value.map(
    (id) =>
      displayedGraphRun.value?.nodes.find((node) => node.nodeId === id) ?? {
        nodeId: id,
        status: 'PENDING',
        summary: '',
        warnings: [],
        errorMessage: null,
      },
  ),
);
const graphRows = computed<EffectPromptNodeId[][]>(() =>
  buildEffectPromptGraphRows(currentGraphNodeIds.value, currentGraphEdges.value),
);

const fragmentTypeLabel = (fragmentType: EffectPromptFragmentType): string =>
  EFFECT_PROMPT_FRAGMENT_TYPE_LABELS[fragmentType];

const emptyDimensions = (): EffectPromptDimensions => ({
  narrative: '',
  scene: '',
  persona: '',
  productRelation: '',
  camera: '',
  emotion: '',
});

const editorDimensionMaxLengths: Record<EffectPromptDimensionKey, number> = {
  narrative: 120,
  scene: 120,
  persona: 160,
  productRelation: 240,
  camera: 160,
  emotion: 120,
};

const reviewIssueLabel = (issue: string): string =>
  ({
    PRODUCT_UNRELATED: '正文与当前产品缺少明确关联',
    FABRICATED_FACT: '正文包含信息卡未确认的产品事实',
    ABSTRACT_FACT_VISUAL_PROOF: '画面错误地把抽象卖点当成可直接证明的事实',
    EMPTY_OR_BROKEN_CONTENT: '正文结构不完整，暂时无法用于生成视频',
    SPEECH_DEPENDENT_MATERIAL: '素材依赖人物口播、旁白或可辨识台词，不能作为无口播片段使用',
  })[issue] ?? '这条 Prompt 需要修改后重新生成创意信息';

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
  const disabledDrafts = { ...disabledElementsTextDrafts.value };
  for (const state of products) {
    if (settingsSaveStatuses.value[state.productId] !== 'saving') {
      // A confirmed historical batch may predate the 20-item minimum. Reading or
      // switching to that branch must not silently rewrite its saved settings.
      const hydratedSettings = clonePromptSettings(state.settings);
      drafts[state.productId] = hydratedSettings;
      disabledDrafts[state.productId] = (hydratedSettings.disabledElements ?? []).join('、');
    }
  }
  settingsDrafts.value = drafts;
  disabledElementsTextDrafts.value = disabledDrafts;
};

const loadCurrentResult = async (): Promise<void> => {
  const productId = currentProductId.value;
  const state = productStates.value[productId];
  const generation = ++resultGeneration;
  resultController?.abort();
  if (resultData.value?.productId && resultData.value.productId !== productId)
    resultData.value = null;
  if (!productId || (!state?.resultId && state?.status !== 'FAILED')) {
    resultData.value = null;
    return;
  }
  const controller = new AbortController();
  resultController = controller;
  resultLoading.value = true;
  try {
    const loaded = await loadEffectPromptResult(
      props.projectId,
      props.workflowRunId,
      productId,
      page.value,
      pageSize.value,
      keyword.value,
      purposeFilter.value || undefined,
      purposeMatchMode.value,
      controller.signal,
    );
    if (
      generation !== resultGeneration ||
      controller.signal.aborted ||
      productId !== currentProductId.value
    )
      return;
    const validPage = clampPromptPage(page.value, loaded.total, pageSize.value);
    if (page.value !== validPage) {
      resultData.value = loaded;
      page.value = validPage;
      return;
    }
    resultData.value = loaded;
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
      if (finalRun.status === 'COMPLETED' && finalRun.workflowRunId !== props.workflowRunId) {
        emit('branchActivated');
        return;
      }
      await reloadWorkspace(false);
      // The Worker callback can expose COMPLETED immediately before its
      // automatic artifact commit finishes. Reconcile the authoritative
      // workspace for a short, bounded window so the page does not present an
      // already committed batch as a draft until the next manual refresh.
      if (finalRun.status === 'COMPLETED' && finalRun.operation === 'BATCH_GENERATE') {
        for (let attempt = 0; attempt < 8; attempt += 1) {
          if (controller.signal.aborted || disposed) return;
          if (productStates.value[productId]?.commitStatus === 'COMMITTED') break;
          await new Promise<void>((resolve) => setTimeout(resolve, 500));
          if (controller.signal.aborted || disposed) return;
          await reloadWorkspace(false);
        }
      }
      // A workspace request that started before the terminal poll can return an
      // older active snapshot afterwards. Re-apply the authoritative terminal
      // run only when this product still points at the same task, so a newer run
      // created in another tab is never overwritten.
      if (productStates.value[productId]?.runId === finalRun.id) updateRun(productId, finalRun);
      const successMessage =
        run.operation === 'ITEM_EVALUATE'
          ? '创意方向与六维信息已补齐'
          : run.operation === 'ITEM_REGENERATE'
            ? '历史单条任务已完成'
            : 'Prompt 批次处理完成';
      showNotice(
        finalRun.status === 'COMPLETED' &&
          finalRun.operation === 'BATCH_GENERATE' &&
          productStates.value[productId]?.commitStatus !== 'COMMITTED'
          ? '批次已生成，但自动提交尚未完成；请检查草稿状态'
          : finalRun.status === 'COMPLETED'
            ? successMessage
            : finalRun.errorMessage ||
              (run.operation === 'ITEM_EVALUATE' ? 'AI 自动补齐失败' : 'Prompt 生成失败'),
        finalRun.status === 'COMPLETED' &&
          (finalRun.operation !== 'BATCH_GENERATE' ||
            productStates.value[productId]?.commitStatus === 'COMMITTED')
          ? 'success'
          : 'error',
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
      .filter(
        (state) =>
          state.runId && (isPromptRunActive(state) || state.productId === currentProductId.value),
      )
      .map(async (state) => {
        try {
          const run = await loadEffectPromptRun(props.projectId, state.runId!);
          if (run.status === 'QUEUED' || run.status === 'RUNNING')
            startPolling(state.productId, run);
          else updateRun(state.productId, run);
        } catch (error) {
          if (!isAbortError(error))
            showNotice(safeMessage(error, '恢复 Prompt 任务失败'), 'warning');
        }
      }),
  );
};

async function reloadWorkspace(showLoading = true): Promise<void> {
  if (!nodeActive) return;
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
    const snapshot = await loadEffectPromptWorkspaceSnapshot(context(), controller.signal);
    const workspace = snapshot.data;
    if (generation !== workspaceGeneration || controller.signal.aborted) return;
    workspaceHydrating = true;
    try {
      applyWorkspace(workspace.products);
      const overview = await getActiveWorkflowRunOverview(
        props.projectId,
        'EFFECT',
        'EFFECT',
        controller.signal,
      );
      if (generation !== workspaceGeneration || controller.signal.aborted) return;
      const activeRun = overview.data.run;
      editing.value = Boolean(
        activeRun?.id === props.workflowRunId &&
        activeRun.isTemporaryBranch &&
        activeRun.editNodeId === 'PROMPT_GENERATION',
      );
      if (!activeProducts.value.some(({ id }) => id === currentProductId.value))
        currentProductId.value = activeProducts.value[0]!.id;
      status.value = 'ready';
      await loadCurrentResult();
      void resumeRuns();
      if (snapshot.prefetched) {
        workspaceRevalidationTimer = setTimeout(() => {
          workspaceRevalidationTimer = undefined;
          if (nodeActive && generation === workspaceGeneration) void reloadWorkspace(false);
        }, 600);
      }
    } finally {
      workspaceHydrating = false;
    }
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
    if (!nodeActive) return;
    pollControllers.forEach(({ controller }) => controller.abort());
    pollControllers.clear();
    settingsControllers.forEach((controller) => controller.abort());
    settingsControllers.clear();
    operationController?.abort();
    itemMutationController?.abort();
    exportController?.abort();
  graphStateController?.abort();
    itemOperation.value = null;
    exporting.value = false;
    editorOpen.value = false;
    editorSaving.value = false;
    editorTrigger.value = null;
    graphDetailController?.abort();
    graphDetailController = null;
    graphDetailLoading.value = false;
    selectedGraphNodeId.value = null;
    graphDetail.value = null;
    graphDetailError.value = '';
    void reloadWorkspace();
  },
  { immediate: true },
);
watch(currentProductId, (next, previous) => {
  if (!nodeActive || workspaceHydrating) return;
  if (previous && previous !== next) void flushSettings(previous);
  page.value = 1;
  keyword.value = '';
  purposeFilter.value = '';
  includeCompatiblePurposes.value = false;
  itemMutationController?.abort();
  exportController?.abort();
  graphStateController?.abort();
  itemOperation.value = null;
  exporting.value = false;
  editorOpen.value = false;
  editorSaving.value = false;
  editorTrigger.value = null;
  graphDetailController?.abort();
  graphDetailController = null;
  graphDetailLoading.value = false;
  selectedGraphNodeId.value = null;
  graphDetail.value = null;
  graphDetailError.value = '';
  void loadCurrentResult();
  void resumeRuns();
});
watch(page, () => void loadCurrentResult());
const changePageSize = (): void => {
  if (page.value === 1) void loadCurrentResult();
  else page.value = 1;
};
watch([purposeFilter, includeCompatiblePurposes], () => {
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
watch([() => displayedGraphRun.value?.id, () => displayedGraphRun.value?.operation], () => {
  const nodeId = selectedGraphNodeId.value;
  if (!nodeId || currentGraphNodeIds.value.includes(nodeId)) return;
  graphDetailController?.abort();
  graphDetailController = null;
  graphDetailLoading.value = false;
  selectedGraphNodeId.value = null;
  graphDetail.value = null;
  graphDetailError.value = '';
});

type NumericPromptSetting = 'targetCount' | 'defaultDurationSeconds';

const settingRange = (key: NumericPromptSetting): { maximum: number; minimum: number } =>
  ({
    targetCount: {
      minimum: EFFECT_PROMPT_LIMITS.minNewBatchCount,
      maximum: EFFECT_PROMPT_LIMITS.maxCount,
    },
    defaultDurationSeconds: {
      minimum: EFFECT_PROMPT_LIMITS.minDurationSeconds,
      maximum: EFFECT_PROMPT_LIMITS.maxDurationSeconds,
    },
  })[key];

const queueSettingsSave = (): void => {
  if (!currentProductId.value || !canEditPrompt.value) return;
  settingsSaveStatuses.value = { ...settingsSaveStatuses.value, [currentProductId.value]: 'idle' };
  if (settingsTimer) clearTimeout(settingsTimer);
  settingsTimer = setTimeout(() => void flushSettings(currentProductId.value), 700);
};

const adjustSetting = (key: NumericPromptSetting, delta: number): void => {
  if (!canEditPrompt.value) return;
  const draft = settingsDrafts.value[currentProductId.value];
  if (!draft) return;
  const range = settingRange(key);
  draft[key] = Math.min(range.maximum, Math.max(range.minimum, draft[key] + delta));
  queueSettingsSave();
};

const updateStyleSchedule = (value: string | number): void => {
  if (!canEditPrompt.value) return;
  const draft = settingsDrafts.value[currentProductId.value];
  if (!draft) return;
  const selected = String(value);
  draft.styleMode = selected === 'AI_AUTO' ? 'AI_AUTO' : 'FIXED';
  draft.styleTone = selected === 'AI_AUTO' ? null : selected;
  queueSettingsSave();
};

const updateDeliveryChannel = (value: string | number): void => {
  if (!canEditPrompt.value) return;
  const draft = settingsDrafts.value[currentProductId.value];
  if (!draft) return;
  draft.deliveryChannel = String(value);
  queueSettingsSave();
};

const updateDisabledElementsText = (value: string): void => {
  if (!canEditPrompt.value) return;
  disabledElementsTextDrafts.value = {
    ...disabledElementsTextDrafts.value,
    [currentProductId.value]: value,
  };
  queueSettingsSave();
};

const parsedDisabledElements = (value: string): string[] => [
  ...new Map(
    value
      .split(/[、,，\n]/u)
      .map((item) => item.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .slice(0, 50)
      .map((item) => [item.normalize('NFKC').toLocaleLowerCase(), item] as const),
  ).values(),
];

const togglePurposeFilter = (purpose: EffectPromptFragmentType): void => {
  if (purposeFilter.value === purpose) {
    purposeFilter.value = '';
    includeCompatiblePurposes.value = false;
  } else {
    purposeFilter.value = purpose;
  }
  page.value = 1;
};
const clearPurposeFilter = (): void => {
  purposeFilter.value = '';
  includeCompatiblePurposes.value = false;
  page.value = 1;
};
const clearPromptSearch = (): void => {
  keyword.value = '';
  void nextTick(() => promptSearchInput.value?.focus());
};

async function flushSettings(productId = currentProductId.value): Promise<boolean> {
  if (settingsTimer) clearTimeout(settingsTimer);
  const pendingSave = settingsSavePromises.get(productId);
  if (pendingSave) {
    if (!(await pendingSave)) return false;
    return flushSettings(productId);
  }
  const state = productStates.value[productId];
  const draft = settingsDrafts.value[productId];
  if (!state || !draft) return true;
  draft.disabledElements = parsedDisabledElements(
    disabledElementsTextDrafts.value[productId] ?? '',
  );
  if (state.settingsRevision !== null && JSON.stringify(draft) === JSON.stringify(state.settings))
    return true;
  const normalized = normalizePromptSettings(draft);
  const disabledElementsChanged =
    JSON.stringify(state.settings.disabledElements ?? []) !==
    JSON.stringify(normalized.disabledElements ?? []);
  settingsDrafts.value = { ...settingsDrafts.value, [productId]: normalized };
  disabledElementsTextDrafts.value = {
    ...disabledElementsTextDrafts.value,
    [productId]: (normalized.disabledElements ?? []).join('、'),
  };
  if (
    state.settingsRevision !== null &&
    JSON.stringify(normalized) === JSON.stringify(state.settings)
  )
    return true;
  const controller = new AbortController();
  settingsControllers.set(productId, controller);
  settingsSaveStatuses.value = { ...settingsSaveStatuses.value, [productId]: 'saving' };
  const savePromise = (async (): Promise<boolean> => {
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
      if (disabledElementsChanged && productId === currentProductId.value && state.resultId)
        await loadCurrentResult();
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
  })();
  settingsSavePromises.set(productId, savePromise);
  try {
    return await savePromise;
  } finally {
    if (settingsSavePromises.get(productId) === savePromise) settingsSavePromises.delete(productId);
  }
}

const generateCurrentBatch = async (): Promise<void> => {
  const productId = currentProductId.value;
  if (!productId || currentRunning.value || batchStartPending.value) return;
  if (
    currentState.value?.resultId &&
    !(await requestActionConfirmation({
      eyebrow: '重新批量生成',
      title: '重新生成当前商品的全部 Prompt？',
      description:
        '系统会启动新的批量生成任务；完整成功并通过服务端校验后会自动保存为新版本，原版本保留。',
      confirmLabel: '确认重新生成',
      tone: 'warning',
    }))
  )
    return;
  batchStartPending.value = true;
  try {
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
          ...(state.resultRevision === null
            ? {}
            : { expectedResultRevision: state.resultRevision }),
        },
        controller.signal,
      );
      if (run.workflowRunId !== props.workflowRunId) {
        emit('branchActivated');
        return;
      }
      updateRun(productId, run);
      startPolling(productId, run);
    } catch (error) {
      if (!isAbortError(error)) await handleMutationError(error, 'Prompt 批次启动失败');
    } finally {
      if (operationController === controller) operationController = null;
    }
  } finally {
    batchStartPending.value = false;
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
  if (!canEditPrompt.value) return;
  if (partialPreview.value || !currentState.value?.resultId || resultData.value === null) {
    showNotice('请先生成 Prompt 批次，再进行人工编辑', 'warning');
    return;
  }
  editorTrigger.value = event?.currentTarget instanceof HTMLElement ? event.currentTarget : null;
  editorMode.value = item ? 'edit' : 'add';
  editorItemId.value = item?.id ?? '';
  editorDraft.value = {
    content: item?.content ?? '',
    primaryPurpose: item?.primaryPurpose ?? 'PRODUCT_DISPLAY',
    creativeCore: item?.creativeCore ?? '',
    dimensions: item ? { ...item.dimensions } : emptyDimensions(),
    targetDurationSeconds: item?.targetDurationSeconds
      ? item.targetDurationSeconds
      : Math.min(
          editorDurationRange.maxDurationSeconds,
          Math.max(
            editorDurationRange.minDurationSeconds,
            currentSettings.value.defaultDurationSeconds,
          ),
        ),
  };
  editorOpen.value = true;
  await nextTick();
  editorCloseButton.value?.focus();
};

const closeEditor = (): void => {
  if (editorSaving.value || editorAutoFilling.value) return;
  editorOpen.value = false;
  const trigger = editorTrigger.value;
  editorTrigger.value = null;
  nextTick(() => trigger?.focus());
};

const commitEditor = async (): Promise<void> => {
  const state = currentState.value;
  const result = resultData.value;
  const draft = editorDraft.value;
  if (!state?.resultId || !result || result.revision === null || partialPreview.value) return;
  if (!draft.content.trim()) {
    showNotice('请填写 Prompt 内容', 'warning');
    return;
  }
  const creativeStructureValues = [
    draft.creativeCore,
    ...EFFECT_PROMPT_DIMENSIONS.map(({ key }) => draft.dimensions[key]),
  ];
  const hasAnyCreativeStructure = creativeStructureValues.some((value) => value.trim());
  const hasCompleteCreativeStructure = creativeStructureValues.every((value) => value.trim());
  if (!hasAnyCreativeStructure || !hasCompleteCreativeStructure) {
    showNotice('请完整填写创意主线和六维信息，或点击 AI 自动生成', 'warning');
    return;
  }
  if (
    !Number.isInteger(draft.targetDurationSeconds) ||
    draft.targetDurationSeconds < editorDurationRange.minDurationSeconds ||
    draft.targetDurationSeconds > editorDurationRange.maxDurationSeconds
  ) {
    showNotice(
      `片段时长需在 ${editorDurationRange.minDurationSeconds}～${editorDurationRange.maxDurationSeconds} 秒之间`,
      'warning',
    );
    return;
  }
  editorSaving.value = true;
  itemMutationController?.abort();
  const controller = new AbortController();
  itemMutationController = controller;
  const productId = state.productId;
  const resultId = state.resultId;
  const resultRevision = result.revision;
  try {
    const saved = await saveEffectPromptItem(
      props.projectId,
      resultId,
      resultRevision,
      {
        content: draft.content.trim(),
        primaryPurpose: draft.primaryPurpose,
        creativeCore: draft.creativeCore,
        dimensions: { ...draft.dimensions },
        targetDurationSeconds: draft.targetDurationSeconds,
      },
      editorMode.value === 'edit' ? editorItemId.value : undefined,
      controller.signal,
    );
    if (controller.signal.aborted || currentProductId.value !== productId) return;
    editorOpen.value = false;
    keyword.value = '';
    purposeFilter.value = '';
    includeCompatiblePurposes.value = false;
    const affectedIndex = saved.affectedItemIndex ?? -1;
    page.value =
      affectedIndex >= 0
        ? Math.floor(affectedIndex / pageSize.value) + 1
        : promptPageCount(saved.result.items.length, pageSize.value);
    await reloadWorkspace(false);
    showNotice(editorMode.value === 'edit' ? 'Prompt 编辑已保存' : 'Prompt 已添加', 'success');
  } catch (error) {
    if (!isAbortError(error)) await handleMutationError(error, 'Prompt 保存失败');
  } finally {
    if (itemMutationController === controller) itemMutationController = null;
    if (!controller.signal.aborted || currentProductId.value === productId)
      editorSaving.value = false;
  }
};

const autoFillEditorCreativeStructure = async (): Promise<void> => {
  const state = currentState.value;
  const result = resultData.value;
  const draft = editorDraft.value;
  if (
    !state?.resultId ||
    !result ||
    result.revision === null ||
    state.settingsRevision === null ||
    currentRunning.value ||
    partialPreview.value ||
    editorAutoFilling.value
  )
    return;
  if (!draft.content.trim()) {
    showNotice('请先填写片段生成 Prompt，再使用 AI 自动生成', 'warning');
    return;
  }
  if (
    !Number.isInteger(draft.targetDurationSeconds) ||
    draft.targetDurationSeconds < editorDurationRange.minDurationSeconds ||
    draft.targetDurationSeconds > editorDurationRange.maxDurationSeconds
  ) {
    showNotice(
      `片段时长需在 ${editorDurationRange.minDurationSeconds}～${editorDurationRange.maxDurationSeconds} 秒之间`,
      'warning',
    );
    return;
  }
  operationController?.abort();
  const controller = new AbortController();
  operationController = controller;
  editorAutoFilling.value = true;
  const productId = state.productId;
  try {
    const saved = await autoFillEffectPromptCreativeStructure(
      props.projectId,
      state.resultId,
      result.revision,
      state.settingsRevision,
      { ...draft, dimensions: { ...draft.dimensions } },
      editorMode.value === 'edit' ? editorItemId.value : undefined,
      controller.signal,
    );
    if (controller.signal.aborted || currentProductId.value !== productId) return;
    const itemId = saved.affectedItemId ?? editorItemId.value;
    if (itemId) {
      editorMode.value = 'edit';
      editorItemId.value = itemId;
      keyword.value = '';
      purposeFilter.value = '';
      includeCompatiblePurposes.value = false;
      if (saved.affectedItemIndex !== undefined)
        page.value = Math.floor(saved.affectedItemIndex / pageSize.value) + 1;
    }
    if (!itemId || !saved.evaluationRun) {
      await reloadWorkspace(false);
      throw new Error(saved.evaluationStartError || 'AI 自动补齐任务未能启动');
    }
    updateRun(productId, saved.evaluationRun);
    const finalRun = await pollEffectPromptRun(props.projectId, saved.evaluationRun.id, {
      signal: controller.signal,
      onUpdate: (run) => updateRun(productId, run),
    });
    if (controller.signal.aborted || currentProductId.value !== productId) return;
    updateRun(productId, finalRun);
    await reloadWorkspace(false);
    if (finalRun.status !== 'COMPLETED')
      throw new Error(finalRun.errorMessage || 'AI 自动补齐失败');
    const filled = resultData.value?.items.find((item) => item.id === itemId);
    if (!filled) throw new Error('AI 已完成补齐，但最新 Prompt 未能载入，请刷新后重试');
    editorDraft.value = {
      content: filled.content,
      primaryPurpose: filled.primaryPurpose,
      creativeCore: filled.creativeCore,
      dimensions: { ...filled.dimensions },
      targetDurationSeconds: filled.targetDurationSeconds,
    };
    showNotice('创意方向与六维信息已自动生成', 'success');
  } catch (error) {
    if (!isAbortError(error)) {
      await handleMutationError(error, 'AI 自动补齐失败');
    }
  } finally {
    if (operationController === controller) operationController = null;
    editorAutoFilling.value = false;
  }
};

const requestDeleteItem = async (item: EffectPromptItem): Promise<void> => {
  if (!canEditPrompt.value) return;
  if (currentRunning.value || itemOperation.value) return;
  if (
    !(await requestActionConfirmation({
      eyebrow: '删除 Prompt',
      title: `删除 ${item.code}？`,
      description:
        '这会从当前产品的 Prompt 节点草稿中删除该条内容，并重新计算数量与去重指标；不会删除已归档资产。',
      confirmLabel: '确认删除',
      tone: 'danger',
    }))
  )
    return;
  const state = currentState.value;
  const result = resultData.value;
  if (
    !item ||
    !state?.resultId ||
    !result ||
    result.revision === null ||
    partialPreview.value ||
    currentRunning.value ||
    itemOperation.value
  )
    return;
  itemOperation.value = { itemId: item.id, kind: 'delete' };
  itemMutationController?.abort();
  const controller = new AbortController();
  itemMutationController = controller;
  const productId = state.productId;
  const resultRevision = result.revision;
  try {
    await removeEffectPromptItem(
      props.projectId,
      state.resultId,
      item,
      resultRevision,
      controller.signal,
    );
    if (controller.signal.aborted || currentProductId.value !== productId) return;
    showNotice(`${item.code} 已从节点草稿删除`, 'warning');
    await reloadWorkspace(false);
  } catch (error) {
    if (!isAbortError(error)) await handleMutationError(error, 'Prompt 删除失败');
  } finally {
    if (itemMutationController === controller) itemMutationController = null;
    if (itemOperation.value?.itemId === item.id && itemOperation.value.kind === 'delete')
      itemOperation.value = null;
  }
};

const exportBatch = async (): Promise<void> => {
  const projectId = props.projectId;
  const state = currentState.value;
  if (
    !state?.resultId ||
    !resultData.value ||
    partialPreview.value ||
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
    const projectName = (
      projectContext.currentProject.value?.id === projectId
        ? projectContext.currentProject.value.name
        : projectContext.projects.value.find((project) => project.id === projectId)?.name
    )?.trim();
    if (!projectName) {
      showNotice('项目名称尚未加载，请稍后重试', 'warning');
      return;
    }
    const exported = await downloadEffectPromptBatch(
      projectId,
      state.resultId,
      projectName,
      controller.signal,
    );
    if (controller.signal.aborted || props.projectId !== projectId || currentProductId.value !== productId) return;
    const url = URL.createObjectURL(exported.blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = exported.fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    globalThis.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    showNotice('提示词已发起下载，解压后可查看表格和阅读版');
  } catch (error) {
    if (!isAbortError(error)) showNotice(safeMessage(error, 'Prompt 导出失败'), 'error');
  } finally {
    if (exportController === controller) exportController = null;
    if (!controller.signal.aborted || currentProductId.value === productId) exporting.value = false;
  }
};

const validatePromptBatch = async (): Promise<void> => {
  if (!canEditPrompt.value) {
    showNotice('请先进入编辑状态', 'warning');
    return;
  }
  const state = currentState.value;
  const result = resultData.value;
  if (!state?.resultId || !result || result.revision === null || partialPreview.value) {
    showNotice('当前批次仍存在数量偏差、完全重复、待评估条目或事实与结构硬问题', 'warning');
    return;
  }
  validating.value = true;
  const resultRevision = result.revision;
  try {
    const validation = await commitEffectPromptResult(
      props.projectId,
      state.resultId,
      resultRevision,
    );
    if (!validation.valid) {
      showNotice(
        validation.issues.map((issue) => issue.message).join('；') || 'Prompt 校验未通过',
        'warning',
      );
      return;
    }
    const completedMessage = 'Prompt 修改已保存';
    showNotice(
      validation.warnings?.length
        ? `${completedMessage}；另有 ${validation.warnings.length} 项质量建议，可继续优化`
        : completedMessage,
    );
    editing.value = false;
    if (validation.workflowRunId && validation.workflowRunId !== props.workflowRunId) {
      emit('branchActivated');
      return;
    }
    await reloadWorkspace(false);
  } catch (error) {
    await handleMutationError(error, 'Prompt 修改保存失败');
  } finally {
    validating.value = false;
  }
};

const beginPromptEdit = async (): Promise<void> => {
  if (editPending.value || currentRunning.value) return;
  editPending.value = true;
  try {
    const session = await beginEffectWorkflowNodeEdit(
      props.projectId,
      props.workflowRunId,
      'PROMPT_GENERATION',
    );
    editing.value = true;
    if (session.data.run.id !== props.workflowRunId) emit('branchActivated');
  } catch (error) {
    showNotice(safeMessage(error, '进入 Prompt 编辑失败'), 'error');
  } finally {
    editPending.value = false;
  }
};

const cancelPromptEdit = async (): Promise<void> => {
  if (editPending.value || currentRunning.value) return;
  if (!(await confirmDiscardEffectEdit())) return;
  if (editPending.value || currentRunning.value || !editing.value) return;
  editPending.value = true;
  try {
    const result = await cancelEffectWorkflowNodeEdit(
      props.projectId,
      props.workflowRunId,
      'PROMPT_GENERATION',
    );
    editing.value = false;
    if (result.data.activeWorkflowRunId !== props.workflowRunId) emit('branchActivated');
    else await reloadWorkspace(false);
  } catch (error) {
    showNotice(safeMessage(error, '取消 Prompt 编辑失败'), 'error');
  } finally {
    editPending.value = false;
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
const graphRowTitle = (row: EffectPromptNodeId[]): string => {
  void row;
  return '';
};
const graphDescription = (nodeId: EffectPromptNodeId): string =>
  ({
    LOAD_AND_SNAPSHOT: '冻结洞察工作副本、批次设置和人工保留内容',
    INSIGHT_MAPPING: '把已确认的营销洞察映射为片段可用信息',
    FACT_VISUAL_STRATEGY_COMPILATION:
      '判断哪些事实可以成为画面任务，哪些只作为商业背景或禁止视觉证明',
    SHARED_PROMPT_COMPILATION: '编译本批次生成与渲染共同使用的提示词',
    COHERENT_CREATIVE_GENERATION:
      '按卖点生成结构化素材创意，再由下一阶段 AI 审片并只修订确诊的执行问题',
    CREATIVE_EVALUATION_CLASSIFICATION: '评估产品关联和创意质量，并标注推荐用途与兼容用途',
    EXACT_SELECTION_AND_SUPPLEMENT: '按质量与差异择优，缺少时只补充仍需的数量',
    ITEM_EVALUATE: '根据用户 Prompt 自动生成创意主线与六维信息',
    STRATEGY_PLANNING: '连接受众、痛点、场景、卖点与营销目标，形成营销关系束',
    GLOBAL_FACT_ALLOCATION: '先为六类片段分配必须事实与可选事实，避免跨职责误用',
    STRATEGY_FRAGMENT_ROUTER: '并行路由六类营销规划，并复用仍然有效的成功检查点',
    PLAN_HOOK_STRATEGY: '为钩子片段规划相互关联的场景、人物、动作、镜头和情绪',
    PLAN_PAIN_STRATEGY: '为痛点片段规划可见问题状态和人物反应',
    PLAN_PRODUCT_DISPLAY_STRATEGY: '为产品展示规划产品主体、环境和单一展示动作',
    PLAN_SELLING_POINT_EXPLANATION_STRATEGY: '围绕已确认卖点规划安全、可拍摄的讲解方式',
    PLAN_CTA_STRATEGY: '根据营销目标和购买动机规划结尾转化画面',
    PLAN_OUTRO_STRATEGY: '规划稳定、简洁且不引入新承诺的品牌收束画面',
    STRATEGY_MERGE_VALIDATION: '合并六类创意母版，校验事实来源、职责和全局覆盖',
    RELATIONSHIP_FRAGMENT_ROUTER: '并行路由六类营销关系规划，保持各类片段职责独立',
    PLAN_HOOK_RELATIONSHIPS: '组合适用于钩子片段的已确认受众、痛点与场景事实',
    PLAN_PAIN_RELATIONSHIPS: '组合适用于痛点片段的已确认问题、人物与场景事实',
    PLAN_PRODUCT_DISPLAY_RELATIONSHIPS: '组合适用于产品展示的产品事实与使用环境',
    PLAN_SELLING_POINT_EXPLANATION_RELATIONSHIPS: '组合卖点事实及可用于安全表达的辅助事实',
    PLAN_CTA_RELATIONSHIPS: '组合营销目标、购买动机与产品收束事实',
    PLAN_OUTRO_RELATIONSHIPS: '组合产品、品牌与稳定片尾所需的已确认事实',
    RELATIONSHIP_MERGE_VALIDATION: '合并六类事实关系，核对主要事实、辅助事实与覆盖配额',
    DIMENSION_COORDINATE_ROUTER: '并行规划六类片段各自的产品专属六维坐标',
    PLAN_HOOK_COORDINATES: '生成适用于本产品钩子片段的六维候选坐标',
    PLAN_PAIN_COORDINATES: '生成适用于本产品痛点片段的六维候选坐标',
    PLAN_PRODUCT_DISPLAY_COORDINATES: '生成适用于本产品展示片段的六维候选坐标',
    PLAN_SELLING_POINT_EXPLANATION_COORDINATES: '生成适用于本产品卖点讲解的六维候选坐标',
    PLAN_CTA_COORDINATES: '生成适用于本产品结尾转化的六维候选坐标',
    PLAN_OUTRO_COORDINATES: '生成适用于本产品片尾品牌的六维候选坐标',
    COORDINATE_MERGE_VALIDATION: '汇总六份坐标计划，核对来源、适用关系与差异容量',
    BLUEPRINT_QUOTA_ALLOCATION: '按目标数量和事实覆盖要求为每个营销组合分配蓝图配额',
    BLUEPRINT_FRAGMENT_ROUTER: '按片段类型和分片并行生成组合级拍摄蓝图',
    GENERATE_HOOK_BLUEPRINTS: '从钩子坐标中选择协调组合并生成具体首帧、动作与结束状态',
    GENERATE_PAIN_BLUEPRINTS: '从痛点坐标中选择协调组合并生成未解决的问题画面',
    GENERATE_PRODUCT_DISPLAY_BLUEPRINTS: '从展示坐标中选择协调组合并生成单一展示动作',
    GENERATE_SELLING_POINT_EXPLANATION_BLUEPRINTS: '从卖点坐标中选择协调组合并生成可拍摄的证据画面',
    GENERATE_CTA_BLUEPRINTS: '从转化坐标中选择协调组合并生成带安全留白的收束画面',
    GENERATE_OUTRO_BLUEPRINTS: '从片尾坐标中选择协调组合并生成稳定品牌定格',
    BLUEPRINT_ORTHOGONAL_GATE: '比较全批次蓝图并优先保留差异更大的方案，差异不足时记录告警',
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
const graphNodeDescription = (nodeId: EffectPromptNodeId): string => {
  const execution = graphExecution(nodeId);
  return execution.status === 'RUNNING' && execution.summary.trim()
    ? execution.summary.trim()
    : graphDescription(nodeId);
};
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

const graphDimensionLabel = (key: EffectPromptDimensionKey): string =>
  EFFECT_PROMPT_DIMENSIONS.find((dimension) => dimension.key === key)?.label ?? key;

const graphPromptDimensionValue = (
  item: { dimensions: EffectPromptDimensions },
  key: EffectPromptDimensionKey,
): string => item.dimensions[key];

const graphPairScore = (value: number): string => `${(value * 100).toFixed(0)}%`;

const graphSectionStateLabel = (state: NodeDetail['sections'][number]['state']): string =>
  ({
    EXPECTED: '预计',
    ACTUAL: '实际',
    PARTIAL: '已完成部分',
    EMPTY: '暂无数据',
  })[state];

const graphCreativeOutcomeLabel = (outcome: string): string =>
  ({
    PENDING: '待评估',
    ACCEPTED: '通过评估',
    REJECTED: '未通过',
    SELECTED: '已择优',
    SAVED: '已保存',
  })[outcome] ?? outcome;

const graphQualityScoreRows = (scores: {
  productRelevance: number;
  creativeCoherence: number;
  visualExecutability: number;
  commercialUsefulness: number;
  visualClarity: number;
}) => [
  { label: '产品相关', value: scores.productRelevance },
  { label: '创意连贯', value: scores.creativeCoherence },
  { label: '画面可执行', value: scores.visualExecutability },
  { label: '商业价值', value: scores.commercialUsefulness },
  { label: '视觉清晰', value: scores.visualClarity },
];

const graphDetailSections = (detail: NodeDetail): NodeDetail['sections'] => {
  const sections = (detail as NodeDetail & { sections?: NodeDetail['sections'] }).sections;
  if (Array.isArray(sections) && sections.length) return sections;
  const state =
    detail.status === 'PENDING'
      ? 'EXPECTED'
      : detail.status === 'RUNNING' || detail.status === 'PARTIAL' || detail.status === 'FAILED'
        ? detail.fields.length || detail.blocks.length
          ? 'PARTIAL'
          : 'EMPTY'
        : detail.fields.length || detail.blocks.length
          ? 'ACTUAL'
          : 'EMPTY';
  return [
    {
      kind: 'INPUT',
      state: 'EMPTY',
      title: '本次输入',
      summary: '当前服务返回的是兼容格式，输入明细将在服务更新后显示。',
      fields: [],
      blocks: [],
    },
    {
      kind: 'OUTPUT',
      state,
      title: state === 'EXPECTED' ? '预计输出' : state === 'PARTIAL' ? '已完成部分' : '本次输出',
      summary: detail.summary || graphDetailEmptyMessage(detail),
      fields: detail.fields,
      blocks: detail.blocks,
    },
    {
      kind: 'EXECUTION',
      state: detail.status === 'PENDING' ? 'EXPECTED' : 'ACTUAL',
      title: '执行情况',
      summary: '状态和更新时间仍以服务端持久化记录为准。',
      fields: [],
      blocks: [],
    },
  ];
};

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
  const expectedOutput =
    (
      {
        LOAD_AND_SNAPSHOT: '将锁定本次商品、营销洞察、数量、时长与共用约束。',
        INSIGHT_MAPPING: '将营销洞察分为必须应用、自适应应用、排除信息和全局约束。',
        FACT_VISUAL_STRATEGY_COMPILATION:
          '将已确认事实编译为可见任务、商业背景与禁止视觉证明的安全角色。',
        SHARED_PROMPT_COMPILATION: '将形成生成与渲染共同使用的一段批次级提示词。',
        COHERENT_CREATIVE_GENERATION:
          '将按卖点安排素材任务，同步生成创意主线、六维与正文，再由 AI 完成整段画面执行修正。',
        CREATIVE_EVALUATION_CLASSIFICATION: '将输出质量判断、推荐用途和问题原因。',
        EXACT_SELECTION_AND_SUPPLEMENT: '将按质量与差异选满目标数量，必要时补充一次。',
        RESULT_SAVE: '保存最佳结果；数量与结构校验通过后自动提交为工作副本。',
        ITEM_EVALUATE: '将根据用户输入的 Prompt 自动补齐创意主线和六维信息。',
      } as Partial<Record<EffectPromptNodeId, string>>
    )[nodeId] ?? '执行后将在这里展示真实业务结果。';
  return {
    nodeId,
    status: execution.status,
    summary:
      execution.summary ||
      (execution.status === 'PENDING'
        ? '该节点尚未执行，暂无持久化运行数据。'
        : graphDescription(nodeId)),
    sections: [
      {
        kind: 'INPUT',
        state: 'EXPECTED',
        title: '预计输入',
        summary: '将接收上一阶段已经确认的业务结果。',
        fields: [],
        blocks: [],
      },
      {
        kind: 'OUTPUT',
        state: 'EXPECTED',
        title: '预计输出',
        summary: expectedOutput,
        fields: [],
        blocks: [],
      },
      {
        kind: 'EXECUTION',
        state: 'EXPECTED',
        title: '执行情况',
        summary: '任务开始后将显示尝试次数、分片进度和安全状态。',
        fields: [],
        blocks: [],
      },
    ],
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

const sharedGraphNodes = computed(() => graphRows.value.flat().map(id => ({
  id, label: graphDefinition(id).label, description: graphNodeDescription(id),
  tone: graphStatusMeta(graphExecution(id).status).tone, statusLabel: graphStatusMeta(graphExecution(id).status).label,
})));
const selectSharedGraphNode = (id: string) => selectGraphNode(id as EffectPromptNodeId);

const openGraph = async (event?: Event): Promise<void> => {
  graphTrigger.value =
    event?.currentTarget instanceof HTMLButtonElement ? event.currentTarget : null;
  graphDialogOpen.value = true;
  graphError.value = '';
  graphStateController?.abort();
  const scope = new AbortController();
  graphStateController = scope;
  const projectId = props.projectId, productId = currentProductId.value, workflowRunId = props.workflowRunId;
  const valid = () => !scope.signal.aborted && graphStateController === scope && graphDialogOpen.value && props.projectId === projectId && props.workflowRunId === workflowRunId && currentProductId.value === productId;
  const runId = currentState.value?.runId;
  if (runId && currentRun.value?.id !== runId) {
    graphLoading.value = true;
    try {
      const run = await loadEffectPromptRun(projectId, runId, scope.signal);
      if (valid()) updateRun(productId, run);
    } catch (error) {
      if (valid()) graphError.value = safeMessage(error, '工作流状态加载失败');
    } finally {
      if (graphStateController === scope) graphLoading.value = false;
    }
  }
  await nextTick();

};

const closeGraph = (): void => {
  graphDialogOpen.value = false;
  graphStateController?.abort();
  if (graphDetailRefreshTimer) clearTimeout(graphDetailRefreshTimer);
  graphDetailRefreshTimer = undefined;
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

  if (graphDetail.value?.nodeId !== nodeId) graphDetail.value = localGraphDetail(nodeId);
  graphDetailError.value = '';
  const runId = displayedGraphRun.value?.id;
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
      displayedGraphRun.value?.id !== runId ||
      selectedGraphNodeId.value !== nodeId
    )
      return;
    if (
      !graphDetail.value ||
      promptGraphDetailContentKey(graphDetail.value) !== promptGraphDetailContentKey(detail)
    )
      graphDetail.value = detail;
  } catch (error) {
    if (
      !isAbortError(error) &&
      !disposed &&
      props.projectId === projectId &&
      currentProductId.value === productId &&
      displayedGraphRun.value?.id === runId &&
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

watch(
  [
    () => graphDialogOpen.value,
    () => selectedGraphNodeId.value,
    () => promptGraphDetailRefreshKey(displayedGraphRun.value, selectedGraphNodeId.value),
  ],
  ([open, nodeId, refreshKey], [, previousNodeId, previousRefreshKey]) => {
    if (graphDetailRefreshTimer) clearTimeout(graphDetailRefreshTimer);
    graphDetailRefreshTimer = undefined;
    if (!open || !nodeId || !displayedGraphRun.value) return;
    if (nodeId !== previousNodeId || refreshKey === previousRefreshKey) return;
    graphDetailRefreshTimer = setTimeout(() => {
      graphDetailRefreshTimer = undefined;
      void refreshGraphDetail();
    }, 500);
  },
);

const flushPendingEdits = async (): Promise<boolean> => flushSettings();
defineExpose({ flushPendingEdits });

const stopNodeRequests = (): void => {
  clearTimeout(workspaceRevalidationTimer);
  workspaceRevalidationTimer = undefined;
  workspaceGeneration += 1;
  resultGeneration += 1;
  workspaceController?.abort();
  resultController?.abort();
  settingsControllers.forEach((controller) => controller.abort());
  operationController?.abort();
  itemMutationController?.abort();
  exportController?.abort();
  graphStateController?.abort();
  graphDetailController?.abort();
  pollControllers.forEach(({ controller }) => controller.abort());
  pollControllers.clear();
};

onActivated(() => {
  nodeActive = true;
  if (!activatedOnce) {
    activatedOnce = true;
    return;
  }
  void reloadWorkspace(false);
});

onDeactivated(() => {
  nodeActive = false;
  stopNodeRequests();
});

onBeforeUnmount(() => {
  disposed = true;
  nodeActive = false;
  stopNodeRequests();
  if (settingsTimer) clearTimeout(settingsTimer);
  if (searchTimer) clearTimeout(searchTimer);
  if (noticeTimer) clearTimeout(noticeTimer);
  if (graphDetailRefreshTimer) clearTimeout(graphDetailRefreshTimer);
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
          <button
            v-if="hasConfirmedPrompt && !editing"
            class="secondary-button"
            type="button"
            :disabled="editPending || currentRunning"
            @click="beginPromptEdit"
          >
            <Pencil :size="14" />进入编辑
          </button>
          <button
            v-else-if="editing"
            class="secondary-button"
            type="button"
            :disabled="editPending || currentRunning || validating"
            @click="cancelPromptEdit"
          >
            <X :size="14" />取消编辑
          </button>
          <button
            v-if="canEditPrompt"
            class="secondary-button"
            type="button"
            :aria-busy="validating"
            :disabled="
              partialPreview ||
              currentRunning ||
              validating ||
              editPending ||
              !currentState.resultId ||
              !resultData ||
              resultData.revision === null
            "
            @click="validatePromptBatch"
          >
            <LoaderCircle v-if="validating" class="spin" :size="14" />
            <CheckCircle2 v-else :size="14" />{{ validating ? '正在校验…' : '保存修改' }}
          </button>
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
            :disabled="currentRunning || batchStartPending"
            :aria-busy="currentRunning || batchStartPending"
            @click="generateCurrentBatch"
          >
            <LoaderCircle v-if="currentRunning || batchStartPending" class="spin" :size="14" />
            <RefreshCw v-else-if="currentState.resultId" :size="14" />
            <Sparkles v-else :size="14" />
            {{
              batchStartPending
                ? '正在提交…'
                : currentRunning
                  ? `处理中 ${currentState.progress}%`
                  : currentState.resultId
                    ? '重新批量生成'
                    : '开始批量生成'
            }}
          </button>
        </div>
      </header>

      <WorkflowRunProgress
        v-if="currentRunning"
        :progress="currentState.progress"
        :summary="
          currentState.status === 'QUEUED' ? '正在等待 Prompt 生成服务接单' : currentStageLabel
        "
        :attempt-label="currentAttemptLabel"
        :warning="currentRetryWarning"
        @show-details="openGraph"
      />
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
          <h3>批次设置</h3>
          <span :class="currentSaveStatus">{{
            currentSaveStatus === 'saving'
              ? '正在保存'
              : currentSaveStatus === 'error'
                ? '保存失败'
                : currentState.settingsRevision === null
                  ? '待首次保存'
                  : currentSettingsPendingSave
                    ? '待保存'
                    : '已自动保存'
          }}</span>
        </div>
        <div class="simple-setting-grid">
          <label
            v-for="setting in [
              {
                key: 'targetCount',
                label: '生成片段数',
                suffix: '条',
              },
              {
                key: 'defaultDurationSeconds',
                label: '单条片段时长',
                suffix: '秒',
              },
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
                  currentRunning ||
                  !canEditPrompt ||
                  currentSettings[setting.key] <= settingRange(setting.key).minimum
                "
                @click="adjustSetting(setting.key, -1)"
              >
                −
              </button>
              <input
                v-model.number="settingsDrafts[currentProductId]![setting.key]"
                type="number"
                :aria-label="setting.label"
                :min="settingRange(setting.key).minimum"
                :max="settingRange(setting.key).maximum"
                :disabled="currentRunning || !canEditPrompt"
                @input="queueSettingsSave"
                @blur="flushSettings()"
              />
              <span class="number-suffix">{{ setting.suffix }}</span>
              <button
                type="button"
                :aria-label="`提高${setting.label}`"
                :disabled="
                  currentRunning ||
                  !canEditPrompt ||
                  currentSettings[setting.key] >= settingRange(setting.key).maximum
                "
                @click="adjustSetting(setting.key, 1)"
              >
                ＋
              </button>
            </span>
          </label>
          <label class="setting-card setting-card--select">
            <span>投放渠道</span>
            <EffectUpwardCreatableSelect
              field-label="投放渠道"
              :model-value="currentSettings.deliveryChannel ?? '抖音'"
              :options="deliveryChannelOptions"
              :disabled="currentRunning || !canEditPrompt"
              @update:model-value="updateDeliveryChannel"
            />
          </label>
          <label class="setting-card setting-card--select">
            <span>视觉风格基调</span>
            <EffectUpwardCreatableSelect
              field-label="视觉风格基调"
              :model-value="currentStyleSelection"
              :options="styleOptions"
              :creatable="false"
              :disabled="currentRunning || !canEditPrompt"
              @update:model-value="updateStyleSchedule"
            />
          </label>
          <label class="setting-card setting-card--disabled">
            <span>禁用元素</span>
            <textarea
              :value="currentDisabledElementsText"
              rows="3"
              maxlength="6000"
              placeholder="例如：未成年人、绝对化用语、未经确认的品牌文字"
              :disabled="currentRunning || !canEditPrompt"
              @input="updateDisabledElementsText(($event.target as HTMLTextAreaElement).value)"
              @blur="flushSettings()"
            />
          </label>
        </div>
      </section>

      <section v-if="partialPreview" class="partial-preview-banner" role="status">
        <AlertCircle :size="18" />
        <div>
          <strong>本次任务未完成，已保留 {{ resultData?.total ?? 0 }} 条临时预览</strong>
          <span
            >以下 Prompt
            已生成并通过基础结构检查，不会覆盖上一份有效结果。当前仅支持查看；重新批量生成完整成功后才会自动提交版本。</span
          >
        </div>
      </section>

      <section class="effect-prompt-list" aria-label="Prompt 生成结果">
        <div class="effect-prompt-toolbar">
          <div class="prompt-search" role="search">
            <Search :size="15" /><input
              ref="promptSearchInput"
              v-model="keyword"
              type="search"
              aria-label="搜索 Prompt"
              placeholder="搜索编号或多个关键词，例如：P012、厨房 果肉 特写"
            />
            <button
              v-if="keyword"
              class="prompt-search__clear"
              type="button"
              aria-label="清除搜索"
              @click="clearPromptSearch"
            >
              <X :size="14" />
            </button>
          </div>
          <span class="prompt-result-count">{{ promptResultCountLabel }}</span>
          <span
            class="prompt-semantic-rate"
            :class="`prompt-semantic-rate--${currentSemanticDisplay.state}`"
            role="status"
          >
            {{ currentSemanticDisplay.text }}
          </span>
          <button
            v-if="!partialPreview"
            class="primary-button"
            type="button"
            :disabled="!resultData || currentRunning || !canEditPrompt"
            @click="openEditor(undefined, $event)"
          >
            <Plus :size="15" />新增 Prompt
          </button>
          <button
            v-if="!partialPreview"
            class="primary-button"
            type="button"
            :disabled="!resultData || currentRunning || exporting"
            title="导出提示词表格和阅读版"
            @click="exportBatch"
          >
            <LoaderCircle v-if="exporting" class="spin" :size="15" /><Download
              v-else
              :size="15"
            />批量导出
          </button>
        </div>
        <nav class="purpose-filter-bar" aria-label="按推荐用途筛选 Prompt">
          <button
            type="button"
            :class="{ active: purposeFilter === '' }"
            :aria-pressed="purposeFilter === ''"
            @click="clearPurposeFilter"
          >
            全部用途 <small>{{ currentCountStats.actualCount }}</small>
          </button>
          <button
            v-for="purpose in EFFECT_PROMPT_FRAGMENT_TYPES"
            :key="purpose"
            type="button"
            :class="{ active: purposeFilter === purpose }"
            :aria-pressed="purposeFilter === purpose"
            @click="togglePurposeFilter(purpose)"
          >
            {{ fragmentTypeLabel(purpose) }} <small>{{ purposeCount(purpose) }}</small>
          </button>
          <label
            class="compatible-purpose-toggle"
            title="开启后，选择任一用途时，也会显示将该用途标记为兼容用途的 Prompt"
          >
            <input v-model="includeCompatiblePurposes" type="checkbox" />
            <span>包含兼容用途</span>
          </label>
        </nav>

        <div v-if="resultLoading" class="prompt-empty-state" role="status">
          <LoaderCircle class="spin" :size="25" /><strong>正在加载 Prompt</strong>
        </div>
        <div v-else-if="!currentItems.length" class="prompt-empty-state">
          <Search :size="25" /><strong>{{
            resultData
              ? '没有匹配的 Prompt'
              : currentState.status === 'FAILED'
                ? '本次任务没有可预览的 Prompt'
                : '尚未生成 Prompt'
          }}</strong
          ><span>{{
            resultData
              ? '请调整搜索词，或人工补充新的 Prompt。'
              : currentState.status === 'FAILED'
                ? '请重新批量生成；失败任务不会覆盖已有有效结果。'
                : '完成信息提炼后，点击开始批量生成。'
          }}</span>
        </div>

        <article v-for="(item, index) in currentItems" v-else :key="item.id" class="prompt-card">
          <span class="prompt-number">{{
            String((page - 1) * pageSize + index + 1).padStart(2, '0')
          }}</span>
          <div class="prompt-main">
            <header>
              <strong>{{ item.code }}</strong
              ><span
                ><i v-if="item.manualEdited || item.origin === 'MANUAL'">人工</i
                ><em v-if="item.classificationStatus === 'PENDING'" class="classification-pending"
                  >待补齐</em
                ><em
                  v-else-if="item.classificationStatus === 'NEEDS_REVISION'"
                  class="classification-needs-revision"
                  >需修改</em
                ><em v-else class="primary-fragment-tag"
                  >推荐：{{ fragmentTypeLabel(item.primaryPurpose) }}</em
                ><em class="duration-tag">{{ item.targetDurationSeconds }} 秒</em></span
              >
            </header>
            <div
              v-if="
                item.classificationStatus === 'VERIFIED' &&
                item.compatiblePurposes.some((purpose) => purpose !== item.primaryPurpose)
              "
              class="compatible-purpose-tags"
              aria-label="该条 Prompt 的兼容用途"
            >
              <small>还适合</small>
              <span
                v-for="purpose in item.compatiblePurposes.filter(
                  (purpose) => purpose !== item.primaryPurpose,
                )"
                :key="purpose"
                >{{ fragmentTypeLabel(purpose) }}</span
              >
            </div>
            <textarea :value="item.content" readonly aria-label="Prompt 内容" />
            <div
              v-if="item.classificationStatus === 'NEEDS_REVISION'"
              class="prompt-review-issues"
              role="alert"
            >
              <strong>请编辑 Prompt 或重新生成</strong>
              <span v-for="issue in item.reviewIssues ?? []" :key="issue">{{
                reviewIssueLabel(issue)
              }}</span>
            </div>
            <details class="prompt-dimension-details">
              <summary>查看提炼信息依据</summary>
              <div v-if="item.insightBindings.length" class="prompt-fact-groups">
                <section
                  v-for="group in itemInsightFactGroups(item)"
                  :key="group.key"
                  class="prompt-fact-group"
                >
                  <header>
                    <strong>{{ group.label }}</strong>
                    <small>{{ group.description }}</small>
                  </header>
                  <dl class="prompt-fact-list">
                    <div v-for="fact in group.facts" :key="fact.factId">
                      <dt>{{ fact.label }}</dt>
                      <dd>{{ fact.value }}</dd>
                    </div>
                  </dl>
                </section>
              </div>
              <p v-else class="prompt-detail-empty">暂无可追溯的提炼信息依据</p>
            </details>
            <details
              v-if="item.classificationStatus !== 'PENDING'"
              class="prompt-dimension-details"
            >
              <summary>查看创意主线</summary>
              <p class="prompt-creative-core">{{ item.creativeCore }}</p>
            </details>
            <details
              v-if="item.classificationStatus !== 'PENDING'"
              class="prompt-dimension-details"
            >
              <summary>查看六维创意信息</summary>
              <div class="prompt-dimensions">
                <span v-for="dimension in EFFECT_PROMPT_DIMENSIONS" :key="dimension.key"
                  ><b>{{ dimension.label }}：</b>{{ item.dimensions[dimension.key] }}</span
                >
              </div>
            </details>
          </div>
          <div class="prompt-actions">
            <button
              v-if="!partialPreview"
              type="button"
              :disabled="currentRunning || !canEditPrompt"
              @click="openEditor(item, $event)"
            >
              <Pencil :size="13" />编辑
            </button>
            <button
              v-if="!partialPreview"
              class="danger"
              type="button"
              :disabled="currentRunning || itemOperation !== null || !canEditPrompt"
              @click="requestDeleteItem(item)"
            >
              <LoaderCircle
                v-if="itemOperation?.itemId === item.id && itemOperation.kind === 'delete'"
                class="spin"
                :size="13"
              /><Trash2 v-else :size="13" />删除
            </button>
          </div>
        </article>

        <div class="prompt-pagination">
          <label class="prompt-page-size">
            <select
              v-model.number="pageSize"
              aria-label="每页展示数量"
              :disabled="resultLoading"
              @change="changePageSize"
            >
              <option v-for="size in EFFECT_PROMPT_PAGE_SIZE_OPTIONS" :key="size" :value="size">
                {{ size }} 条/页
              </option>
            </select> </label
          ><button type="button" :disabled="page <= 1 || resultLoading" @click="page -= 1">
            <ChevronLeft :size="14" />上一页</button
          ><strong>第 {{ page }} / {{ totalPages }} 页</strong
          ><button type="button" :disabled="page >= totalPages || resultLoading" @click="page += 1">
            下一页<ChevronRight :size="14" />
          </button>
        </div>
      </section>


      <WorkflowNodeFooter
        back-label="上一步：AI 信息提炼"
        :show-validate="false"
        :next-disabled="!allProductsCommitted || currentRunning"
        next-label="下一步：片段渲染"
        @back="emit('back')"
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
                {{ editorMode === 'add' ? '添加提示词' : '编辑提示词' }}
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
              <span>片段类型</span>
              <select v-model="editorDraft.primaryPurpose" :disabled="editorAutoFilling">
                <option v-for="type in EFFECT_PROMPT_FRAGMENT_TYPES" :key="type" :value="type">
                  {{ fragmentTypeLabel(type) }}
                </option>
              </select>
              <small>作为该条素材的主用途，AI 自动生成不会覆盖你的选择。</small>
            </label>
            <label>
              <span>片段时长</span>
              <input
                v-if="editorMode === 'add'"
                v-model.number="editorDraft.targetDurationSeconds"
                type="number"
                :min="editorDurationRange.minDurationSeconds"
                :max="editorDurationRange.maxDurationSeconds"
                :disabled="editorAutoFilling"
              />
              <div v-else class="editor-duration-readonly">
                {{ editorDraft.targetDurationSeconds }} 秒
              </div>
              <small>{{
                editorMode === 'edit'
                  ? '已有 Prompt 的时长不可修改。'
                  : '支持 4～30 秒；时长作为渲染参数，不写入 Prompt 正文。'
              }}</small>
            </label>
          </div>
          <label class="editor-content"
            ><span>片段生成 Prompt</span
            ><small>先描述一个可独立渲染的画面片段；填写后可让 AI 补齐下方创意信息。</small>
            <textarea
              v-model="editorDraft.content"
              :disabled="editorAutoFilling"
              placeholder="请写清首帧画面、单一连续动作、产品位置、运镜、光线与结束帧"
            />
          </label>
          <section class="editor-creative-structure">
            <header>
              <div>
                <h3>创意方向与六维信息</h3>
                <p>用于创意评估、展示与追溯，请与 Prompt 正文保持一致。</p>
              </div>
              <button
                class="editor-ai-fill-button"
                type="button"
                :disabled="editorAutoFilling || editorSaving || !editorDraft.content.trim()"
                @click="autoFillEditorCreativeStructure"
              >
                <LoaderCircle v-if="editorAutoFilling" class="spin" :size="14" />
                <Sparkles v-else :size="14" />
                {{ editorAutoFilling ? 'AI 生成中' : 'AI 自动生成' }}
              </button>
            </header>
            <label class="editor-creative-core">
              <span>创意主线</span>
              <textarea
                v-model="editorDraft.creativeCore"
                :disabled="editorAutoFilling"
                maxlength="160"
                rows="2"
                placeholder="概括这一画面片段要表达的核心创意"
              />
            </label>
            <div class="editor-dimension-grid">
              <label v-for="dimension in EFFECT_PROMPT_DIMENSIONS" :key="dimension.key">
                <span>{{ dimension.label }}</span>
                <textarea
                  v-model="editorDraft.dimensions[dimension.key]"
                  :disabled="editorAutoFilling"
                  :maxlength="editorDimensionMaxLengths[dimension.key]"
                  rows="2"
                  :placeholder="`填写${dimension.label}`"
                />
              </label>
            </div>
            <p class="editor-structure-hint">
              可自行填写，或在上方 Prompt 完成后让 AI 自动生成；生成结果仍可继续编辑。
            </p>
          </section>
          <footer>
            <p>完整手填内容可直接保存；只有点击“AI 自动生成”才会调用 AI。</p>
            <button
              type="button"
              :disabled="editorSaving || editorAutoFilling"
              @click="closeEditor"
            >
              取消</button
            ><button
              class="primary-button"
              type="button"
              :disabled="editorSaving || editorAutoFilling"
              @click="commitEditor"
            >
              <LoaderCircle v-if="editorSaving" class="spin" :size="14" />{{
                editorMode === 'add' ? '添加提示词' : '保存编辑'
              }}
            </button>
          </footer>
        </section>
      </div>

      <WorkflowExecutionGraphDialog
        :open="graphDialogOpen" title="Prompt 生成工作流" eyebrow="PROMPT WORKFLOW"
        :description="graphDialogDescription" :rows="graphRows"
        :nodes="sharedGraphNodes" :row-titles="graphRows.map(graphRowTitle)"
        :selected="selectedGraphNodeId" :edge-count="currentGraphEdges.length"
        :loading="graphLoading" :error="graphError"
        :empty-message="!displayedGraphRun ? '当前产品尚未执行 Prompt 工作流。启动新一轮批量生成后，节点会显示本次执行结果。' : undefined"
        @close="closeGraph" @select="selectSharedGraphNode"
      >
              <div v-if="!selectedGraphNodeId" class="node-detail-empty">
                <Workflow :size="30" /><strong>选择节点查看真实结果</strong>
                <p v-if="!displayedGraphRun">
                  当前产品尚无执行产物；运行新批次后，这里将展示对应节点的真实结果。
                </p>
                <p v-else>展示当前运行的真实业务产物，同时隐藏模型指令、原始响应和内部标识。</p>
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
                <div
                  v-if="graphDetailLoading && !graphDetail"
                  class="node-detail-message loading"
                  role="status"
                >
                  <LoaderCircle class="spin" :size="13" />正在同步节点真实结果…
                </div>
                <div v-if="graphDetailError" class="node-detail-message error" role="alert">
                  <AlertCircle :size="13" />{{ graphDetailError }}
                </div>

                <template v-if="graphDetail">
                  <div class="node-detail-status">
                    <em :class="`is-${graphStatusMeta(graphDetail.status).tone}`">
                      {{ graphStatusMeta(graphDetail.status).label }}
                    </em>
                    <small v-if="selectedGraphNodeIsActive" class="node-attempt">
                      {{ currentAttemptLabel }}
                    </small>
                    <span>
                      <small>更新时间</small>
                      <time :datetime="currentGraphDetailUpdatedAt ?? undefined">{{
                        formatGraphDetailTime(currentGraphDetailUpdatedAt)
                      }}</time>
                    </span>
                  </div>
                  <p class="node-summary">{{ graphDetail.summary }}</p>

                  <details
                    v-for="section in graphDetailSections(graphDetail)"
                    :key="section.kind"
                    class="node-detail-section"
                    :class="`is-${section.kind.toLowerCase()}`"
                    :open="section.kind !== 'EXECUTION'"
                  >
                    <summary class="node-detail-section__heading">
                      <span class="node-detail-section__icon">
                        <ArrowDownToLine v-if="section.kind === 'INPUT'" :size="13" />
                        <ArrowUpFromLine v-else-if="section.kind === 'OUTPUT'" :size="13" />
                        <Activity v-else :size="13" />
                      </span>
                      <span>
                        <strong>{{ section.title }}</strong>
                        <small>{{ section.summary }}</small>
                      </span>
                      <em :class="`is-${section.state.toLowerCase()}`">
                        {{ graphSectionStateLabel(section.state) }}
                      </em>
                    </summary>

                    <div class="node-detail-section__content">
                      <dl v-if="section.fields.length" class="node-fields">
                        <div
                          v-for="(field, index) in section.fields"
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
                        v-for="(block, blockIndex) in section.blocks"
                        :key="`${block.kind}-${blockIndex}`"
                        class="node-result-block"
                      >
                        <h3>{{ block.title }}</h3>

                        <div v-if="block.kind === 'TEXT_CONTENT'" class="node-text-content">
                          <div v-if="block.sourceLabels.length" class="node-sample-tags">
                            <span v-for="source in block.sourceLabels" :key="source">{{
                              source
                            }}</span>
                          </div>
                          <p>{{ block.content }}</p>
                        </div>

                        <div
                          v-else-if="block.kind === 'CREATIVE_PLAN_LIST'"
                          class="node-creative-plan-list"
                        >
                          <p class="node-sample-count">
                            {{ block.territoryCount }} 个产品创意空间 ·
                            {{ block.directionCount }} 个创意方向
                          </p>
                          <details v-for="territory in block.items" :key="territory.title" open>
                            <summary>
                              <span>
                                <strong>{{ territory.title }}</strong>
                                {{ territory.directions.length }} 个方向
                              </span>
                              <em>目标承载 {{ territory.targetSlots }} 条</em>
                            </summary>
                            <div class="node-creative-territory-summary">
                              <p><b>适用画面</b>{{ territory.sceneBoundary }}</p>
                              <p><b>差异目标</b>{{ territory.differentiationGoal }}</p>
                              <p v-if="territory.actions.length" class="node-sample-tags">
                                <span v-for="action in territory.actions" :key="action">{{
                                  action
                                }}</span>
                              </p>
                            </div>
                            <ol>
                              <li
                                v-for="direction in territory.directions"
                                :key="`${direction.code}-${direction.creativeDirection}`"
                              >
                                <header>
                                  <strong>{{ direction.code }}</strong>
                                  <span
                                    v-for="dimension in direction.priorityDimensions"
                                    :key="dimension"
                                  >
                                    {{ dimension }}
                                  </span>
                                </header>
                                <p>{{ direction.creativeDirection }}</p>
                                <small>主要动作：{{ direction.primaryAction }}</small>
                              </li>
                            </ol>
                          </details>
                        </div>

                        <div
                          v-else-if="block.kind === 'CREATIVE_SAMPLE_LIST'"
                          class="node-creative-list"
                        >
                          <p class="node-sample-count">
                            共 {{ block.totalCount }} 条<span v-if="block.remainingCount"
                              >，其余 {{ block.remainingCount }} 条未展开</span
                            >
                          </p>
                          <details
                            v-for="item in block.items"
                            :key="`${item.code}-${item.content}`"
                          >
                            <summary>
                              <span>
                                <strong>{{ item.code }}</strong>
                                {{
                                  item.primaryPurpose
                                    ? EFFECT_PROMPT_FRAGMENT_TYPE_LABELS[item.primaryPurpose]
                                    : '待分类'
                                }}
                              </span>
                              <em :class="`is-${item.outcome.toLowerCase()}`">
                                {{ graphCreativeOutcomeLabel(item.outcome) }} · 展开
                              </em>
                            </summary>
                            <p class="node-creative-core"><b>创意主线</b>{{ item.creativeCore }}</p>
                            <div v-if="item.sourceFacts.length" class="node-sample-tags">
                              <span v-for="source in item.sourceFacts" :key="source">{{
                                source
                              }}</span>
                            </div>
                            <p class="node-prompt-content">{{ item.content }}</p>
                            <dl class="node-prompt-dimensions">
                              <div
                                v-for="dimension in EFFECT_PROMPT_DIMENSIONS"
                                :key="dimension.key"
                              >
                                <dt>{{ dimension.label }}</dt>
                                <dd>{{ graphPromptDimensionValue(item, dimension.key) }}</dd>
                              </div>
                            </dl>
                            <div v-if="item.compatiblePurposes.length" class="node-purpose-tags">
                              <strong>兼容用途</strong>
                              <span v-for="purpose in item.compatiblePurposes" :key="purpose">
                                {{ EFFECT_PROMPT_FRAGMENT_TYPE_LABELS[purpose] }}
                              </span>
                            </div>
                            <dl v-if="item.scores" class="node-score-grid">
                              <div
                                v-for="score in graphQualityScoreRows(item.scores)"
                                :key="score.label"
                              >
                                <dt>{{ score.label }}</dt>
                                <dd>{{ score.value.toFixed(0) }}</dd>
                              </div>
                            </dl>
                            <p v-if="item.reasons.length" class="node-sample-reasons">
                              {{ item.reasons.join('；') }}
                            </p>
                          </details>
                        </div>

                        <div
                          v-else-if="block.kind === 'RELATIONSHIP_LIST'"
                          class="node-relationship-list"
                        >
                          <article v-for="item in block.items" :key="item.title">
                            <header>
                              <span>
                                <strong>{{ item.title }}</strong>
                                <small>{{
                                  EFFECT_PROMPT_FRAGMENT_TYPE_LABELS[item.fragmentType]
                                }}</small>
                              </span>
                              <em>{{ item.blueprintQuota }} 张蓝图</em>
                            </header>
                            <dl>
                              <div>
                                <dt>主要事实</dt>
                                <dd>{{ item.primaryFact }}</dd>
                              </div>
                              <div>
                                <dt>辅助事实</dt>
                                <dd>
                                  <span v-for="fact in item.auxiliaryFacts" :key="fact">{{
                                    fact
                                  }}</span>
                                  <i v-if="!item.auxiliaryFacts.length">无</i>
                                </dd>
                              </div>
                              <div>
                                <dt>组合意图</dt>
                                <dd>{{ item.creativeIntent }}</dd>
                              </div>
                            </dl>
                          </article>
                        </div>

                        <div
                          v-else-if="block.kind === 'COORDINATE_LIST'"
                          class="node-coordinate-list"
                        >
                          <section v-for="group in block.groups" :key="group.dimension">
                            <header>
                              <strong>{{ group.label }}</strong>
                              <span>{{ group.items.length }} 个候选</span>
                            </header>
                            <article v-for="item in group.items" :key="item.value">
                              <strong>{{ item.value }}</strong>
                              <p>
                                <span>适配 {{ item.compatibleBundleCount }} 个营销组合</span>
                                <span v-if="item.sourceFacts.length">
                                  来源：{{ item.sourceFacts.join('、') }}
                                </span>
                              </p>
                            </article>
                          </section>
                        </div>

                        <div
                          v-else-if="block.kind === 'BLUEPRINT_LIST'"
                          class="node-blueprint-list"
                        >
                          <details v-for="item in block.items" :key="item.title">
                            <summary>
                              <span>
                                <strong>{{ item.title }}</strong>
                                {{ EFFECT_PROMPT_FRAGMENT_TYPE_LABELS[item.fragmentType] }} ·
                                {{ item.relationshipTitle }}
                              </span>
                              <em>{{ item.targetDurationSeconds }} 秒 · 展开蓝图</em>
                            </summary>
                            <dl class="node-blueprint-states">
                              <div>
                                <dt>首帧状态</dt>
                                <dd>{{ item.openingState }}</dd>
                              </div>
                              <div>
                                <dt>连续动作</dt>
                                <dd>{{ item.actionArc }}</dd>
                              </div>
                              <div>
                                <dt>结束状态</dt>
                                <dd>{{ item.endingState }}</dd>
                              </div>
                            </dl>
                            <dl class="node-prompt-dimensions">
                              <div
                                v-for="dimension in EFFECT_PROMPT_DIMENSIONS"
                                :key="dimension.key"
                              >
                                <dt>{{ dimension.label }}</dt>
                                <dd>{{ graphPromptDimensionValue(item, dimension.key) }}</dd>
                              </div>
                            </dl>
                          </details>
                        </div>

                        <div
                          v-else-if="block.kind === 'ORTHOGONAL_PAIR_LIST'"
                          class="node-orthogonal-pair-list"
                        >
                          <details
                            v-for="(item, pairIndex) in block.items"
                            :key="`${item.left.title}-${item.right.title}-${pairIndex}`"
                          >
                            <summary>
                              <span>
                                <strong>{{ item.left.title }} ↔ {{ item.right.title }}</strong>
                                相同维度：
                                {{
                                  item.sameDimensions.length
                                    ? item.sameDimensions.map(graphDimensionLabel).join('、')
                                    : '无'
                                }}
                              </span>
                              <em>差异 {{ item.distance }}/6 · 展开对比</em>
                            </summary>
                            <div class="node-blueprint-compare">
                              <article
                                v-for="candidate in [item.left, item.right]"
                                :key="candidate.title"
                              >
                                <header>
                                  <strong>{{ candidate.title }}</strong>
                                  <span>{{ candidate.relationshipTitle }}</span>
                                </header>
                                <p><b>首帧</b>{{ candidate.openingState }}</p>
                                <p><b>动作</b>{{ candidate.actionArc }}</p>
                                <p><b>结束</b>{{ candidate.endingState }}</p>
                                <dl class="node-prompt-dimensions">
                                  <div
                                    v-for="dimension in EFFECT_PROMPT_DIMENSIONS"
                                    :key="dimension.key"
                                  >
                                    <dt>{{ dimension.label }}</dt>
                                    <dd>{{ candidate.dimensions[dimension.key] }}</dd>
                                  </div>
                                </dl>
                              </article>
                            </div>
                          </details>
                        </div>

                        <div v-else-if="block.kind === 'TAG_LIST'" class="node-tag-groups">
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
                            <small v-if="route.failedShards"
                              >{{ route.failedShards }} 个分片失败</small
                            >
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
                              <div
                                v-for="dimension in EFFECT_PROMPT_DIMENSIONS"
                                :key="dimension.key"
                              >
                                <dt>{{ dimension.label }}</dt>
                                <dd>{{ graphPromptDimensionValue(item, dimension.key) }}</dd>
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
                          <details
                            v-for="item in block.items"
                            :key="`${item.code}-${item.content}`"
                          >
                            <summary>
                              <span
                                ><strong>{{ item.code }}</strong
                                >{{ EFFECT_PROMPT_FRAGMENT_TYPE_LABELS[item.fragmentType] }}</span
                              ><em>{{ item.targetDurationSeconds }} 秒 · 展开全文</em>
                            </summary>
                            <p class="node-prompt-content">{{ item.content }}</p>
                            <dl class="node-prompt-dimensions">
                              <div
                                v-for="dimension in EFFECT_PROMPT_DIMENSIONS"
                                :key="dimension.key"
                              >
                                <dt>{{ dimension.label }}</dt>
                                <dd>{{ graphPromptDimensionValue(item, dimension.key) }}</dd>
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
                        v-if="!section.fields.length && !section.blocks.length"
                        class="node-detail-no-fields"
                      >
                        <Workflow :size="16" />
                        <span>{{ section.summary || graphDetailEmptyMessage(graphDetail) }}</span>
                      </div>
                    </div>
                  </details>

                  <div
                    v-if="!graphDetailSections(graphDetail).length"
                    class="node-detail-no-fields"
                  >
                    <Workflow :size="16" />
                    <span>{{ graphDetailEmptyMessage(graphDetail) }}</span>
                  </div>

                  <div v-for="warning in graphDetail.warnings" :key="warning" class="node-warning">
                    <AlertCircle :size="12" />{{ warning }}
                  </div>
                  <div v-if="selectedGraphNodeIsActive && currentRetryWarning" class="node-warning">
                    <AlertCircle :size="12" />{{ currentRetryWarning }}
                  </div>
                  <div v-if="graphDetail.errorMessage" class="node-warning error">
                    <AlertCircle :size="12" />{{ graphDetail.errorMessage }}
                  </div>
                </template>
              </template>
      </WorkflowExecutionGraphDialog>
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
.effect-prompt-heading__actions .secondary-button {
  min-width: 139px;
}
.heading-generate-button {
  min-width: 160px;
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
  padding: 0 13px;
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
.setting-card {
  display: grid;
  min-width: 0;
  min-height: 78px;
  padding: 13px 14px;
  grid-template-columns: 1fr;
  align-content: start;
  gap: 8px;
  color: #58657a;
  background: #f8fbff;
  border: 1px solid #e5eaf2;
  border-radius: 12px;
  font-size: 12px;
}
.setting-card:not(.setting-card--disabled) {
  grid-template-columns: 96px minmax(0, 1fr);
  align-content: center;
  align-items: center;
}
.setting-card > span:first-child {
  font-weight: 700;
  white-space: nowrap;
}
.simple-setting-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
}
.setting-card--disabled {
  min-height: auto;
  grid-column: 1 / -1;
}
.setting-card--disabled textarea {
  width: 100%;
  min-height: 76px;
  padding: 10px 12px;
  box-sizing: border-box;
  resize: vertical;
  color: #46566f;
  background: #fff;
  border: 1px solid #dbe4f2;
  border-radius: 10px;
  outline: none;
  font: inherit;
  line-height: 1.6;
}
.setting-card--disabled textarea:focus {
  border-color: #7da7ef;
  box-shadow: 0 0 0 3px rgb(37 99 235 / 8%);
}
.simple-setting-grid .number-control {
  height: 38px;
  grid-row: 1;
  grid-column: 2;
  grid-template-columns: 32px minmax(50px, 1fr) 28px 32px;
}
.setting-card--select > .effect-up-select {
  grid-row: 1;
  grid-column: 2;
  align-self: center;
}
.setting-card .number-control,
.setting-card--select > .effect-up-select {
  width: 100%;
  max-width: 260px;
  justify-self: end;
}
.number-suffix {
  display: grid;
  place-items: center;
  color: #7c8798;
  background: #fff;
  border-right: 1px solid #e3e8f0;
  font-size: 10px;
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
.partial-preview-banner {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  margin-top: 14px;
  padding: 14px 16px;
  color: #8a5a16;
  background: #fff9eb;
  border: 1px solid #f2d49a;
  border-radius: 14px;
}
.partial-preview-banner svg {
  flex: none;
  margin-top: 1px;
}
.partial-preview-banner div {
  display: grid;
  gap: 4px;
}
.partial-preview-banner strong {
  font-size: 13px;
}
.partial-preview-banner span {
  color: #8a6b3e;
  font-size: 11px;
  line-height: 1.6;
}
.shared-prompt-panel {
  display: grid;
  margin-top: 10px;
  padding: 14px 16px;
  gap: 12px;
  background: #fffaf7;
  border: 1px solid #f1dfd6;
  border-radius: 16px;
}
.shared-prompt-panel > header,
.shared-prompt-panel > footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.shared-prompt-panel > header div {
  display: grid;
  gap: 3px;
}
.shared-prompt-panel strong {
  color: #2f405c;
  font-size: 12px;
}
.shared-prompt-panel span,
.shared-prompt-panel em {
  color: #7b8799;
  font-size: 10px;
  font-style: normal;
}
.shared-prompt-panel > header em {
  padding: 4px 8px;
  color: #39856a;
  background: #edf8f3;
  border-radius: 999px;
  white-space: nowrap;
}
.shared-prompt-panel > header em.dirty {
  color: #a86a16;
  background: #fff2d9;
}
.shared-prompt-editor {
  display: grid;
}
.shared-prompt-panel textarea {
  box-sizing: border-box;
  width: 100%;
  min-height: 112px;
  margin: 0;
  padding: 10px 12px;
  color: #5d6d84;
  background: #fff;
  border: 1px solid #eadfd9;
  border-radius: 12px;
  font-size: 10px;
  line-height: 1.7;
  white-space: pre-wrap;
}
.shared-prompt-panel textarea {
  resize: vertical;
  outline: none;
}
.shared-prompt-panel textarea:focus {
  border-color: #ff9f80;
  box-shadow: 0 0 0 3px rgb(255 90 95 / 8%);
}
.shared-prompt-panel > footer {
  justify-content: flex-end;
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
.prompt-search__clear {
  display: grid;
  width: 24px;
  height: 24px;
  flex: 0 0 24px;
  padding: 0;
  place-items: center;
  color: #7d8ba0;
  background: transparent;
  border: 0;
  border-radius: 6px;
}
.prompt-search__clear:hover {
  color: #2563eb;
  background: #eef4ff;
}
.prompt-search__clear:focus-visible {
  outline: 2px solid #93b4ff;
  outline-offset: 1px;
}
.prompt-result-count {
  margin-right: auto;
  color: #8b95a5;
  font-size: 12px;
}
.purpose-filter-bar {
  display: flex;
  padding: 8px 0 2px;
  flex-wrap: wrap;
  gap: 7px;
}
.purpose-filter-bar button {
  display: inline-flex;
  min-height: 30px;
  padding: 0 11px;
  align-items: center;
  gap: 5px;
  color: #62728a;
  background: #f7f9fc;
  border: 1px solid #e1e7f0;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 800;
}
.purpose-filter-bar button small {
  min-width: 18px;
  padding: 1px 5px;
  color: #8795aa;
  background: #fff;
  border-radius: 999px;
  font-size: 9px;
  line-height: 16px;
  text-align: center;
}
.purpose-filter-bar button.active {
  color: #245fca;
  background: #edf4ff;
  border-color: #bcd0f5;
}
.purpose-filter-bar button.active small {
  color: #245fca;
  background: #dce9ff;
}
.compatible-purpose-toggle {
  display: inline-flex;
  min-height: 30px;
  margin-left: auto;
  padding: 0 4px;
  align-items: center;
  gap: 7px;
  color: #5d6d84;
  cursor: pointer;
  font-size: 11px;
  font-weight: 700;
  user-select: none;
}
.compatible-purpose-toggle input {
  width: 15px;
  height: 15px;
  margin: 0;
  accent-color: #2f6dea;
}
.prompt-card {
  display: grid;
  min-width: 0;
  padding: 15px;
  grid-template-columns: 38px minmax(0, 1fr) 142px;
  column-gap: 8px;
  row-gap: 10px;
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
.prompt-main > header em.classification-pending {
  color: #9a6508;
  background: #fff7df;
  border-color: #efd69a;
}
.prompt-main > header em.classification-needs-revision {
  color: #b33a46;
  background: #fff0f1;
  border-color: #f3bcc2;
}
.prompt-review-issues {
  display: grid;
  margin-top: 8px;
  padding: 9px 11px;
  gap: 4px;
  color: #9c3440;
  background: #fff7f7;
  border: 1px solid #f3c9ce;
  border-radius: 8px;
  font-size: 10px;
}
.prompt-review-issues strong {
  font-size: 11px;
}
.prompt-review-issues span::before {
  content: '· ';
}
.compatible-purpose-tags {
  display: flex;
  margin: 3px 0 2px;
  align-items: center;
  flex-wrap: wrap;
  gap: 5px;
}
.compatible-purpose-tags small {
  color: #8995a8;
  font-size: 9px;
}
.compatible-purpose-tags span {
  padding: 3px 7px;
  color: #6656a8;
  background: #f4f1ff;
  border: 1px solid #ded6fb;
  border-radius: 999px;
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
.prompt-semantic-rate {
  display: inline-flex;
  min-height: 28px;
  padding: 0 10px;
  align-items: center;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 800;
  white-space: nowrap;
}
.prompt-semantic-rate--passed {
  color: #177a59;
  background: #edf8f3;
}
.prompt-semantic-rate--warning {
  color: #9a6712;
  background: #fff7df;
}
.prompt-semantic-rate--pending,
.prompt-semantic-rate--running {
  color: #6e7f96;
  background: #f1f4f8;
}
.prompt-fact-list,
.prompt-creative-core,
.prompt-detail-empty {
  margin: 7px 0 0;
}
.prompt-fact-list {
  display: grid;
  gap: 5px;
}
.prompt-fact-groups {
  display: grid;
  gap: 10px;
  margin-top: 8px;
}
.prompt-fact-group > header {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.prompt-fact-group > header strong {
  color: #334155;
  font-size: 12px;
}
.prompt-fact-group > header small {
  color: #8a98aa;
  font-size: 10px;
}
.prompt-fact-list > div {
  display: grid;
  grid-template-columns: minmax(70px, max-content) 1fr;
  gap: 8px;
  padding: 7px 9px;
  color: #253047;
  background: #f4f8ff;
  border: 1px solid #cfe0ff;
  border-radius: 7px;
}
.prompt-fact-list dt {
  color: #2f6fed;
  font-weight: 700;
}
.prompt-fact-list dd {
  min-width: 0;
  margin: 0;
  overflow-wrap: anywhere;
}
.prompt-creative-core {
  padding: 8px 10px;
  color: #253047;
  background: #f4f8ff;
  border: 1px solid #cfe0ff;
  border-radius: 7px;
  line-height: 1.6;
}
.prompt-detail-empty {
  color: #98a3b3;
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
  min-height: 260px;
  padding: 10px 14px;
  resize: none;
  overflow-x: hidden;
  overflow-y: auto;
  scrollbar-color: #b9c8df #f3f6fb;
  scrollbar-width: thin;
  color: #5b6270;
  background: #fff;
  border: 1px solid #dfe4eb;
  border-radius: 10px;
  font-family: inherit;
  font-size: 13px;
  line-height: 1.78;
}
.prompt-main > textarea::-webkit-scrollbar {
  width: 8px;
}
.prompt-main > textarea::-webkit-scrollbar-track {
  background: #f3f6fb;
  border-radius: 999px;
}
.prompt-main > textarea::-webkit-scrollbar-thumb {
  background: #b9c8df;
  border: 2px solid #f3f6fb;
  border-radius: 999px;
}
.prompt-main > textarea::-webkit-scrollbar-thumb:hover {
  background: #8ea5c6;
}
.editor-duration-readonly {
  display: flex;
  align-items: center;
  min-height: 36px;
  padding: 0 10px;
  background: #f5f8fc;
  border: 1px solid #dfe5ed;
  border-radius: 8px;
  font-weight: 600;
}
.prompt-actions {
  display: grid;
  grid-template-columns: repeat(2, 68px);
  align-content: center;
  gap: 6px;
}
.prompt-actions button {
  display: inline-flex;
  min-width: 0;
  height: 34px;
  padding: 0 8px;
  align-items: center;
  justify-content: center;
  gap: 4px;
  color: #46556c;
  background: #fff;
  border: 1px solid #dfe5ed;
  border-radius: 8px;
  font-size: 12px;
  font-weight: 700;
  white-space: nowrap;
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
.prompt-page-size select,
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
.prompt-page-size select {
  min-width: 108px;
  appearance: auto;
  cursor: pointer;
}
.prompt-page-size select:disabled {
  cursor: wait;
}
.prompt-dialog-backdrop {
  --effect-blue: #2563eb;
  position: fixed;
  z-index: 1200;
  inset: 0;
  display: grid;
  padding: 20px;
  place-items: center;
  background: #0f172a66;
  backdrop-filter: blur(3px);
}
.prompt-editor-dialog{
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
.selling-point-note {
  display: block;
  margin-top: 8px;
  color: #7b879a;
  font-size: 9px;
  line-height: 1.45;
}
.prompt-editor-dialog > header{
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
}
.prompt-editor-dialog > header {
  margin-bottom: 18px;
}
.prompt-editor-dialog header span{
  color: #6f50c4;
  font-size: 10px;
  font-weight: 900;
  letter-spacing: 0.08em;
}
.prompt-editor-dialog h2{
  margin: 4px 0 0;
  color: #1d2940;
  font-size: 20px;
}
.prompt-editor-dialog > header button{
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
.editor-creative-structure {
  margin-top: 14px;
  padding: 14px;
  background: #f8faff;
  border: 1px solid #dce7fb;
  border-radius: 12px;
}
.editor-creative-structure > header {
  display: flex;
  margin-bottom: 12px;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.editor-creative-structure > header h3 {
  margin: 0;
  color: #263650;
  font-size: 13px;
}
.editor-creative-structure > header p {
  margin: 4px 0 0;
  color: #718099;
  font-size: 10px;
  line-height: 1.5;
}
.editor-ai-fill-button {
  display: inline-flex;
  min-height: 32px;
  padding: 0 11px;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  gap: 5px;
  color: #2563eb;
  background: #eef4ff;
  border: 1px solid #cfe0ff;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 800;
}
.editor-ai-fill-button:hover:not(:disabled) {
  background: #e3edff;
  border-color: #9fbcff;
}
.editor-ai-fill-button:disabled {
  color: #98a6ba;
  background: #f1f4f8;
  border-color: #e1e7ef;
}
.editor-dimension-grid {
  display: grid;
  margin-top: 11px;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}
.prompt-editor-dialog .editor-creative-core textarea,
.prompt-editor-dialog .editor-dimension-grid textarea {
  min-height: 62px;
  padding: 9px 11px;
  resize: vertical;
  line-height: 1.55;
}
.editor-structure-hint {
  margin: 10px 0 0;
  color: #8a6a2f;
  font-size: 9px;
  line-height: 1.55;
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
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}
.prompt-editor-dialog > footer p {
  margin: 0 auto 0 0;
  color: #7e8a9d;
  font-size: 10px;
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
@media (max-width: 1280px) {
  .simple-setting-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
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
  .simple-setting-grid {
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
}
@media (max-width: 760px) {
  .effect-prompt-node {
    padding: 18px;
    border-radius: 20px;
  }
  .effect-prompt-heading__actions,
  .secondary-button,
  .heading-generate-button {
    width: 100%;
  }
  .effect-prompt-settings,
  .simple-setting-grid {
    grid-template-columns: 1fr;
  }
  .settings-heading {
    grid-column: 1;
  }
  .setting-card {
    grid-template-columns: 1fr;
  }
  .setting-card:not(.setting-card--disabled) {
    grid-template-columns: 1fr;
  }
  .setting-card .number-control,
  .setting-card--select > .effect-up-select {
    grid-row: auto;
    grid-column: 1;
    max-width: none;
    justify-self: stretch;
  }
  .prompt-card {
    grid-template-columns: 38px minmax(0, 1fr);
    padding: 12px;
  }
  .prompt-actions {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .prompt-fact-list > div {
    grid-template-columns: 1fr;
    gap: 3px;
  }
  .editor-grid,
  .editor-dimension-grid{
    grid-template-columns: 1fr;
  }
  .prompt-editor-dialog .editor-creative-core textarea,
  .prompt-editor-dialog .editor-dimension-grid textarea {
    min-height: 88px;
  }
  .prompt-editor-dialog > footer {
    align-items: stretch;
    flex-direction: column;
  }
  .prompt-editor-dialog > footer p {
    margin-right: 0;
  }
  .prompt-editor-dialog > footer button {
    width: 100%;
  }
  .prompt-dialog-backdrop {
    padding: 10px;
  }
}

</style>
