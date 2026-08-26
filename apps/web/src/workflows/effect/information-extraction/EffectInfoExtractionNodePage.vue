<script setup lang="ts">
import type {
  EffectExtractionNodeDetail,
  EffectExtractionNodeExecution,
  EffectExtractionNodeId,
  EffectExtractionNodeStatus,
  EffectImportMode,
  EffectImportProduct,
  EffectVideoConfig,
} from '@ai-marketing/contracts';
import {
  EFFECT_EXTRACTION_GRAPH_EDGES,
  EFFECT_EXTRACTION_GRAPH_NODES,
  EFFECT_EXTRACTION_MAX_AUDIENCE_ITEMS,
  EFFECT_EXTRACTION_MAX_CORE_SELLING_POINTS,
  EFFECT_EXTRACTION_MAX_SCENARIO_ITEMS,
  EFFECT_EXTRACTION_MAX_SECONDARY_SELLING_POINTS,
  EFFECT_EXTRACTION_MAX_TRUST_BACKINGS,
  EFFECT_IMPORT_ASPECT_RATIOS,
  EFFECT_IMPORT_DELIVERY_CHANNELS,
  EFFECT_IMPORT_LIMITS,
  EFFECT_IMPORT_MATERIAL_TYPE_LABELS,
} from '@ai-marketing/contracts';
import { WorkflowNodeDraftBar, WorkflowNodeFooter } from '@ai-marketing/ui';
import {
  AlertCircle,
  ArrowLeft,
  FileText,
  Link2,
  LoaderCircle,
  Plus,
  RefreshCw,
  Trash2,
  Workflow,
  X,
} from '@lucide/vue';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import { ApiClientError, isAbortError } from '../../../api/http-client';
import {
  getActiveWorkflowRunOverview,
  getWorkflowNodeState,
  putWorkflowNodeState,
} from '../../../platform/workflow/api/workflow-working.api';
import EffectUpwardCreatableSelect from '../source-import/components/EffectUpwardCreatableSelect.vue';
import { EFFECT_IMPORT_PROTOTYPE_STYLE_TONES } from '../source-import/effect-import-options';

import {
  cloneExtractionProductState,
  cloneExtractionResult,
  EFFECT_EXTRACTION_STATUS_META,
  isExtractionReadyForNext,
  isExtractionRunning,
  toExtractionProductState,
  type EffectExtractionProductState,
  type EffectExtractionResult,
} from './effect-info-extraction-state';
import {
  beginEffectExtraction,
  loadEffectExtractionNodeDetail,
  loadEffectExtractionRun,
  loadEffectExtractionWorkspace,
  pollEffectExtractionRun,
  saveEffectExtractionResult,
  type EffectExtractionContext,
} from './services/effect-info-extraction.service';
import { validateEffectExtractionResult } from './api/effect-info-extraction.api';

const props = defineProps<{
  projectId: string;
  workflowRunId: string;
  draftId: string;
  mode: EffectImportMode;
  products: EffectImportProduct[];
  globalConfig: EffectVideoConfig;
}>();

const emit = defineEmits<{
  back: [];
  next: [];
}>();

const productStates = ref<Record<string, EffectExtractionProductState>>({});
const currentProductId = ref('');
const loading = ref(true);
const loadingError = ref('');
const sourceRevision = ref(0);
const pollingErrors = ref<Record<string, string>>({});
const newDisabledElement = ref('');
const graphDialogOpen = ref(false);
const graphLoading = ref(false);
const validating = ref(false);
const validationMessage = ref('');
const graphError = ref('');
const graphNodesByProduct = ref<Record<string, EffectExtractionNodeExecution[]>>({});
const selectedGraphNodeId = ref<EffectExtractionNodeId | null>(null);
const graphDetail = ref<EffectExtractionNodeDetail | null>(null);
const graphDetailLoading = ref(false);
const graphDetailError = ref('');
const failedGraphPreviewUrls = ref<ReadonlySet<string>>(new Set());
const graphPanel = ref<HTMLElement | null>(null);
const graphTrigger = ref<HTMLButtonElement | null>(null);
const graphCloseButton = ref<HTMLButtonElement | null>(null);
let loadGeneration = 0;
let disposed = false;
let workspaceController: AbortController | null = null;
let saveController: AbortController | null = null;
let graphController: AbortController | null = null;
let graphDetailController: AbortController | null = null;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
const nodeStateRevision = ref(0);
let lastSavedNodeState = '';
const activeRunControllers = new Map<string, { controller: AbortController; runId: string }>();

const context = computed<EffectExtractionContext>(() => ({
  projectId: props.projectId,
  draftId: props.draftId,
}));

const sourceSignature = computed(() =>
  JSON.stringify(
    props.products.map((product) => ({
      id: product.id,
      name: product.name,
      category: product.category,
      effectiveConfig: product.effectiveConfig,
      materials: product.materials.map((material) => ({
        id: material.id,
        status: material.status,
        updatedAt: material.updatedAt,
      })),
    })),
  ),
);

const currentProduct = computed(
  () => props.products.find((product) => product.id === currentProductId.value) ?? null,
);
const currentState = computed(() => productStates.value[currentProductId.value] ?? null);
const currentConfig = computed(() => currentProduct.value?.effectiveConfig ?? props.globalConfig);
const currentStatusMeta = computed(() =>
  currentState.value
    ? EFFECT_EXTRACTION_STATUS_META[currentState.value.status]
    : EFFECT_EXTRACTION_STATUS_META.NOT_GENERATED,
);
const readyForNext = computed(
  () =>
    Object.values(productStates.value).length > 0 &&
    Object.values(productStates.value).every(
      (state) => isExtractionReadyForNext(state) && state.commitStatus === 'COMMITTED',
    ),
);
const currentRunning = computed(() => isExtractionRunning(currentState.value));
const queueWaitingTooLong = computed(
  () =>
    currentState.value?.status === 'QUEUED' &&
    Date.now() - new Date(currentState.value.updatedAt).getTime() >= 30_000,
);
const currentProgressLabel = computed(() => {
  if (!currentState.value) return '';
  if (currentState.value.status === 'QUEUED') return '正在等待 AI 提炼服务接单';
  return currentState.value.currentNode || '正在分析产品资料';
});
const pendingGraphNodes = (): EffectExtractionNodeExecution[] =>
  EFFECT_EXTRACTION_GRAPH_NODES.map(({ id }) => ({
    nodeId: id,
    status: 'PENDING',
    warnings: [],
    errorMessage: null,
  }));
const currentGraphNodes = computed(
  () => graphNodesByProduct.value[currentProductId.value] ?? pendingGraphNodes(),
);
const graphExecution = (nodeId: EffectExtractionNodeId): EffectExtractionNodeExecution =>
  currentGraphNodes.value.find((node) => node.nodeId === nodeId) ?? {
    nodeId,
    status: 'PENDING',
    warnings: [],
    errorMessage: null,
  };
const graphStatusMeta = (status: EffectExtractionNodeStatus): { label: string; tone: string } =>
  ({
    PENDING: { label: '等待中', tone: 'pending' },
    RUNNING: { label: '执行中', tone: 'running' },
    SUCCEEDED: { label: '已完成', tone: 'success' },
    PARTIAL: { label: '部分完成', tone: 'warning' },
    SKIPPED: { label: '已跳过', tone: 'skipped' },
    FAILED: { label: '失败', tone: 'danger' },
  })[status];
const graphNodeDefinition = (nodeId: EffectExtractionNodeId) =>
  EFFECT_EXTRACTION_GRAPH_NODES.find((node) => node.id === nodeId)!;
const graphNodeDescription = (nodeId: EffectExtractionNodeId): string =>
  ({
    LOAD_AND_SNAPSHOT: '汇总本次提炼使用的图片、文档、视频和电商链接',
    DOCUMENT: '读取文档中的产品信息',
    IMAGE: '识别图片中的商品信息',
    COMMERCE: '检查商品链接中的信息',
    FORM: '读取导入节点的全局视频配置',
    FUSION: '合并不同资料中的有效信息',
    NORMALIZATION: '生成可继续编辑的产品信息卡',
  })[nodeId];
const graphDetailValue = (value: EffectExtractionNodeDetail['fields'][number]['value']): string => {
  if (Array.isArray(value)) return value.length ? value.join('、') : '—';
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (value === null || value === '') return '—';
  return String(value);
};
const graphDetailBytes = (value: number | null): string =>
  value === null
    ? '—'
    : value < 1048576
      ? `${Math.max(1, Math.round(value / 1024))} KB`
      : `${(value / 1048576).toFixed(1)} MB`;
const graphDetailExtension = (name: string): string =>
  name.includes('.') ? name.split('.').pop()!.slice(0, 5).toUpperCase() : 'FILE';
const graphPreviewUrl = (source: EffectExtractionNodeDetail['sources'][number]): string | null => {
  const url = source.media?.previewUrl;
  return url && !failedGraphPreviewUrls.value.has(url) ? url : null;
};
const markGraphPreviewFailed = (url: string): void => {
  failedGraphPreviewUrls.value = new Set([...failedGraphPreviewUrls.value, url]);
};
const localMaterialStatus = (): EffectExtractionNodeStatus =>
  currentState.value?.runId ? 'RUNNING' : 'PENDING';
const safeCommerceHost = (value: string | null): string | null => {
  if (!value) return null;
  try {
    return new URL(value).hostname;
  } catch {
    return '链接格式不可识别';
  }
};
const safeCommerceUrl = (value: string | null): string | null => {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.username = '';
    url.password = '';
    return url.toString().slice(0, 2000);
  } catch {
    return null;
  }
};
const safeLocalText = (value: string, maxLength = 500): string =>
  value
    .replace(/data:[^\s,]+;base64,[a-z\d+/=]+/giu, '[图片数据已隐藏]')
    .replace(/(?:https?|tos|s3):\/\/\S+/giu, '[链接已隐藏]')
    .replace(/[a-z]:\\(?:[^\\\s]+\\)+[^\s]+/giu, '[本地路径已隐藏]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
const warningFieldLabels: Record<string, string> = {
  product_category: '品类',
  product_name: '产品名称',
  core_specification: '核心规格',
  price_range: '价格带',
  visual_features: '外观特征',
  target_audience: '目标受众',
  marketing_goal: '营销目标',
  usage_scenarios: '使用场景',
  delivery_channels: '投放渠道',
  brand_tone: '品牌调性',
  core_selling_points: '核心卖点',
  disabled_elements: '禁用元素',
};
const warningSourceLabels: Record<string, string> = {
  FORM: '人工填写',
  DOCUMENT: '产品文档',
  COMMERCE: '商品链接',
  IMAGE: '商品图片',
};
const presentWarningMessage = (message: string): string => {
  const safeMessage = safeLocalText(message);
  const conflict =
    /^([a-z_]+) conflict resolved in favor of ([A-Z]+); .+ retained as alternatives$/u.exec(
      safeMessage,
    );
  if (!conflict) return safeMessage;
  const field = warningFieldLabels[conflict[1] ?? ''] ?? '产品信息';
  const source = warningSourceLabels[conflict[2] ?? ''] ?? '优先级更高的资料';
  return `${field}存在多种识别结果，已优先采用${source}内容`;
};
const safeLocalFileName = (value: string | null): string =>
  (value ? value.split(/[\\/]/).at(-1)?.trim() : null) || '未命名素材';
const localGraphDetail = (nodeId: EffectExtractionNodeId): EffectExtractionNodeDetail => {
  const product = currentProduct.value!;
  const config = props.globalConfig;
  const execution = graphExecution(nodeId);
  const base = {
    nodeId,
    status: execution.status,
    warnings: execution.warnings.map((warning) => ({
      code: warning.code,
      message: presentWarningMessage(warning.message),
      branch: warning.branch,
    })),
    errorMessage: execution.errorMessage ? safeLocalText(execution.errorMessage) : null,
    updatedAt: product.updatedAt,
  };
  const detailField = (
    key: string,
    label: string,
    value: string | number | boolean | string[] | null,
    source: string | null = null,
  ) => ({ key, label, value, source });
  const materialSources = (
    types: EffectImportProduct['materials'][number]['type'][],
  ): EffectExtractionNodeDetail['sources'] =>
    product.materials
      .filter((material) => types.includes(material.type))
      .map((material) => ({
        name: safeLocalFileName(material.originalFileName ?? material.expectedFileName),
        status: localMaterialStatus(),
        media: {
          kind:
            material.type === 'PRODUCT_IMAGE'
              ? ('IMAGE' as const)
              : material.type === 'PRODUCT_DOCUMENT' || material.type === 'BRAND_GUIDELINE'
                ? ('DOCUMENT' as const)
                : material.type === 'REFERENCE_VIDEO'
                  ? ('VIDEO' as const)
                  : ('FILE' as const),
          typeLabel: EFFECT_IMPORT_MATERIAL_TYPE_LABELS[material.type],
          previewUrl: material.type === 'PRODUCT_IMAGE' ? material.contentUrl : null,
          sizeBytes: material.sizeBytes,
        },
        fields: [],
        warnings: material.errorMessage ? [safeLocalText(material.errorMessage)] : [],
      }));
  const materialCount = (type: EffectImportProduct['materials'][number]['type']): number =>
    product.materials.filter((material) => material.type === type).length;
  const materialCounts = [
    ['imageCount', '商品图片', '份', materialCount('PRODUCT_IMAGE')],
    ['documentCount', '产品文档', '份', materialCount('PRODUCT_DOCUMENT')],
    ['brandGuideCount', '品牌规范', '份', materialCount('BRAND_GUIDELINE')],
    ['videoCount', '参考视频', '份', materialCount('REFERENCE_VIDEO')],
    ['commerceUrlCount', '电商链接', '个', safeCommerceUrl(product.commerceUrl) ? 1 : 0],
  ] as const;
  const materialSummary = materialCounts
    .filter(([, , , count]) => count > 0)
    .map(([, label, unit, count]) => `${count} ${unit}${label}`)
    .join('、');
  const commerceUrl = safeCommerceUrl(product.commerceUrl);
  const snapshotSourceCount = product.materials.length + Number(Boolean(commerceUrl));
  const snapshotSources: EffectExtractionNodeDetail['sources'] = [
    ...materialSources(['PRODUCT_IMAGE', 'PRODUCT_DOCUMENT', 'BRAND_GUIDELINE', 'REFERENCE_VIDEO']),
    ...(commerceUrl
      ? [
          {
            name: commerceUrl,
            status: localMaterialStatus(),
            media: {
              kind: 'LINK' as const,
              typeLabel: '电商链接',
              previewUrl: null,
              sizeBytes: null,
            },
            fields: [],
            warnings: [],
          },
        ]
      : []),
  ];

  if (nodeId === 'LOAD_AND_SNAPSHOT') {
    return {
      ...base,
      summary: snapshotSourceCount
        ? `本次共使用 ${snapshotSourceCount} 项资料：${materialSummary}`
        : '本次没有可用资料',
      fields: [],
      sources: snapshotSources,
    };
  }
  if (nodeId === 'DOCUMENT') {
    return {
      ...base,
      summary: '等待读取文档中的产品信息',
      fields: [],
      sources: materialSources(['PRODUCT_DOCUMENT', 'BRAND_GUIDELINE']),
    };
  }
  if (nodeId === 'IMAGE') {
    return {
      ...base,
      summary: '等待识别图片中的商品信息',
      fields: [],
      sources: materialSources(['PRODUCT_IMAGE']),
    };
  }
  if (nodeId === 'COMMERCE') {
    return {
      ...base,
      summary: '等待检查商品链接',
      fields: [
        detailField('hasCommerceUrl', '是否提供电商链接', Boolean(product.commerceUrl)),
        detailField('commerceHost', '链接域名', safeCommerceHost(product.commerceUrl)),
      ],
      sources: [],
    };
  }
  if (nodeId === 'FORM') {
    return {
      ...base,
      summary: '当前导入节点的全局视频配置',
      fields: [
        detailField('durationSeconds', '视频时长', `${config.durationSeconds} 秒`, '全局配置'),
        detailField('aspectRatio', '画幅比例', config.aspectRatio, '全局配置'),
        detailField('styleTone', '风格基调', config.styleTone, '全局配置'),
        detailField('deliveryChannel', '投放渠道', config.deliveryChannel, '全局配置'),
        detailField('disabledElements', '禁用元素', config.disabledElements, '全局配置'),
      ],
      sources: [],
    };
  }
  return {
    ...base,
    summary: nodeId === 'FUSION' ? '等待合并不同资料中的产品信息' : '等待生成可编辑的产品信息卡',
    fields: [],
    sources: [],
  };
};
const parallelGraphNodeIds: EffectExtractionNodeId[] = EFFECT_EXTRACTION_GRAPH_EDGES.filter(
  ({ from }) => from === 'LOAD_AND_SNAPSHOT',
).map(({ to }) => to);
type ProductBaseField = keyof Pick<
  EffectExtractionResult,
  'productCategory' | 'productName' | 'coreSpecification' | 'priceRange' | 'visualFeatures'
>;
const emptyExtractionResult: EffectExtractionResult = {
  productCategory: '',
  productName: '',
  coreSpecification: '',
  priceRange: '',
  visualFeatures: '',
  coreSellingPoints: [''],
  secondarySellingPoints: [],
  trustBackings: [],
  targetAudience: '',
  corePainPoints: [],
  decisionDrivers: [],
  marketingGoal: '',
  usageScenarios: [],
  purchaseScenarios: [],
  emotionalScenarios: [],
  durationSeconds: props.globalConfig.durationSeconds,
  aspectRatio: props.globalConfig.aspectRatio,
  resolution: props.globalConfig.resolution,
  deliveryChannels: '',
  disabledElements: [],
  visualStyleBaseline: '',
};
const visibleResult = computed(() => currentState.value?.result ?? emptyExtractionResult);
const baseFieldsReadonly = computed(() => !currentState.value?.result || currentRunning.value);
const selectOptions = (values: readonly string[]) =>
  values.map((value) => ({ label: value, value }));
const aspectRatioOptions = selectOptions(EFFECT_IMPORT_ASPECT_RATIOS);
const deliveryChannelOptions = selectOptions(EFFECT_IMPORT_DELIVERY_CHANNELS);
const visualStyleOptions = selectOptions(EFFECT_IMPORT_PROTOTYPE_STYLE_TONES);
const saveStateLabel = computed(() => {
  const state = currentState.value?.saveState ?? 'CLEAN';
  return {
    CLEAN: '已自动保存',
    DIRTY: '有未保存修改',
    SAVING: '正在保存…',
    SAVED: '已自动保存',
    SAVE_FAILED: '保存失败',
  }[state];
});
const draftBarState = computed<'clean' | 'dirty' | 'save_failed' | 'saved' | 'saving'>(
  () =>
    (currentState.value?.saveState ?? 'CLEAN').toLowerCase() as
      'clean' | 'dirty' | 'save_failed' | 'saved' | 'saving',
);
const commitStatusLabel = computed(() =>
  currentState.value
    ? {
        UNVALIDATED: '尚未提交工作副本',
        COMMITTED: `工作副本 revision ${currentState.value.workingArtifactRevision ?? 1}`,
        DRAFT_CHANGED: '存在未校验修改',
        STALE: '工作副本待更新',
      }[currentState.value.commitStatus]
    : '',
);
const currentActionLabel = computed(() => {
  if (!currentState.value) return '开始 AI 提取';
  if (isExtractionRunning(currentState.value)) return 'AI 提取中…';
  if (currentState.value.status === 'NOT_GENERATED') return '开始 AI 提取';
  return '重新 AI 提取';
});

const stateLabel = (productId: string): string => {
  const status = productStates.value[productId]?.status ?? 'NOT_GENERATED';
  return EFFECT_EXTRACTION_STATUS_META[status].label;
};

const saveConflict = computed(() =>
  Boolean(currentState.value?.saveErrorMessage?.includes('其他窗口更新')),
);

const replaceState = (state: EffectExtractionProductState): void => {
  productStates.value = {
    ...productStates.value,
    [state.productId]: cloneExtractionProductState(state),
  };
};

const patchProductState = (
  productId: string,
  patch: Partial<EffectExtractionProductState>,
): void => {
  const existing = productStates.value[productId];
  if (!existing) return;
  replaceState({ ...existing, ...patch });
};

const stopProductPoll = (productId: string): void => {
  activeRunControllers.get(productId)?.controller.abort();
  activeRunControllers.delete(productId);
};

const stopAllRequests = (): void => {
  workspaceController?.abort();
  workspaceController = null;
  saveController?.abort();
  saveController = null;
  graphController?.abort();
  graphController = null;
  graphDetailController?.abort();
  graphDetailController = null;
  activeRunControllers.forEach(({ controller }) => controller.abort());
  activeRunControllers.clear();
};

const applyWorkspace = (
  workspace: Awaited<ReturnType<typeof loadEffectExtractionWorkspace>>,
  preserveLocalEdits: boolean,
): void => {
  sourceRevision.value = workspace.sourceRevision;
  const next = Object.fromEntries(
    workspace.products.map((product) => {
      const state = toExtractionProductState(product);
      const previous = productStates.value[product.productId];
      if (
        preserveLocalEdits &&
        previous?.result &&
        previous.resultId === state.resultId &&
        (previous.saveState === 'DIRTY' || previous.saveState === 'SAVE_FAILED')
      ) {
        state.result = cloneExtractionResult(previous.result);
        state.saveState = previous.saveState;
        state.saveErrorMessage = previous.saveErrorMessage;
      }
      return [state.productId, state];
    }),
  );
  productStates.value = next;
};

type ExtractionNodeDraft = {
  products?: Record<
    string,
    { resultId: string | null; result: EffectExtractionResult; sourceResultRevision: number | null }
  >;
};

const nodeStatePayload = (): ExtractionNodeDraft => ({
  products: Object.fromEntries(
    Object.values(productStates.value)
      .filter((state) => state.result)
      .map((state) => [
        state.productId,
        {
          resultId: state.resultId,
          result: cloneExtractionResult(state.result!),
          sourceResultRevision: state.resultRevision,
        },
      ]),
  ),
});

const applyNodeState = (value: unknown): void => {
  if (!value || typeof value !== 'object') return;
  const products = (value as ExtractionNodeDraft).products;
  if (!products) return;
  for (const [productId, saved] of Object.entries(products)) {
    const current = productStates.value[productId];
    if (
      !current ||
      !saved?.result ||
      !Array.isArray(saved.result.usageScenarios) ||
      !Array.isArray(saved.result.secondarySellingPoints) ||
      current.resultId !== saved.resultId
    )
      continue;
    patchProductState(productId, {
      result: cloneExtractionResult(saved.result),
      saveState: 'SAVED',
      saveErrorMessage: null,
    });
  }
};

const persistNodeState = async (keepalive = false): Promise<boolean> => {
  if (!props.projectId || !props.workflowRunId) return true;
  const productId = currentProductId.value;
  const current = productId ? productStates.value[productId] : null;
  let state = nodeStatePayload();
  let serialized = JSON.stringify(state);
  if (
    serialized === lastSavedNodeState &&
    current?.saveState !== 'DIRTY' &&
    current?.saveState !== 'SAVE_FAILED'
  )
    return true;
  if (productId) patchProductState(productId, { saveState: 'SAVING', saveErrorMessage: null });
  saveController?.abort();
  const controller = new AbortController();
  saveController = controller;
  try {
    if (current?.result && current.resultId && current.resultRevision !== null) {
      const saved = await saveEffectExtractionResult(
        props.projectId,
        current.resultId,
        current.resultRevision,
        current.result,
        controller.signal,
      );
      patchProductState(productId, {
        resultRevision: saved.revision,
        result: cloneExtractionResult(saved.result),
        commitStatus: current.workingArtifactRevision === null ? 'UNVALIDATED' : 'DRAFT_CHANGED',
      });
      state = nodeStatePayload();
      serialized = JSON.stringify(state);
    }
    const response = await putWorkflowNodeState(
      props.projectId,
      props.workflowRunId,
      'INFORMATION_EXTRACTION',
      { expectedRevision: nodeStateRevision.value, state },
      { keepalive, ...(!keepalive ? { signal: controller.signal } : {}) },
    );
    if (disposed || controller.signal.aborted) return false;
    nodeStateRevision.value = response.data.nodeState.revision;
    lastSavedNodeState = serialized;
    if (productId && productStates.value[productId]?.saveState === 'SAVING')
      patchProductState(productId, {
        saveState: 'SAVED',
        saveErrorMessage: null,
        updatedAt: response.data.nodeState.savedAt,
      });
    return true;
  } catch (error) {
    if (isAbortError(error) || disposed) return false;
    if (productId)
      patchProductState(productId, {
        saveState: 'SAVE_FAILED',
        saveErrorMessage:
          error instanceof ApiClientError && error.status === 409
            ? '该节点草稿已在其他窗口更新。当前编辑仍保留，请加载最新结果后再编辑。'
            : error instanceof Error
              ? error.message
              : '提炼草稿自动保存失败',
      });
    return false;
  } finally {
    if (saveController === controller) saveController = null;
  }
};

const patchFromRun = (
  productId: string,
  run: Awaited<ReturnType<typeof beginEffectExtraction>>,
): void => {
  const status =
    run.status === 'QUEUED' ? 'QUEUED' : run.status === 'RUNNING' ? 'PROCESSING' : run.status;
  patchProductState(productId, {
    status,
    runId: run.id,
    resultId: run.extractResultId ?? productStates.value[productId]?.resultId ?? null,
    progress: run.progress,
    currentNode: run.currentNode,
    warnings: run.warnings,
    errorMessage: run.errorMessage,
    updatedAt: run.updatedAt,
  });
  graphNodesByProduct.value = {
    ...graphNodesByProduct.value,
    [productId]: (run.nodes ?? pendingGraphNodes()).map((node) => ({
      ...node,
      warnings: node.warnings.map((warning) => ({ ...warning })),
    })),
  };
};

const refreshProductFromWorkspace = async (
  productId: string,
  signal: AbortSignal,
): Promise<void> => {
  const workspace = await loadEffectExtractionWorkspace(context.value, signal);
  if (disposed || signal.aborted) return;
  sourceRevision.value = workspace.sourceRevision;
  const product = workspace.products.find((item) => item.productId === productId);
  if (product) replaceState(toExtractionProductState(product));
};

const monitorProductRun = async (
  productId: string,
  runId: string,
  controller = new AbortController(),
): Promise<void> => {
  const active = activeRunControllers.get(productId);
  if (active && active.controller !== controller) active.controller.abort();
  activeRunControllers.set(productId, { controller, runId });
  pollingErrors.value = { ...pollingErrors.value, [productId]: '' };
  try {
    const terminal = await pollEffectExtractionRun(props.projectId, runId, {
      signal: controller.signal,
      onUpdate: (run) => {
        if (!disposed && !controller.signal.aborted) patchFromRun(productId, run);
      },
    });
    if (terminal.status === 'COMPLETED') {
      await refreshProductFromWorkspace(productId, controller.signal);
      const saved = await getWorkflowNodeState(
        props.projectId,
        props.workflowRunId,
        'INFORMATION_EXTRACTION',
        controller.signal,
      );
      nodeStateRevision.value = saved.data.revision;
      applyNodeState(saved.data.state);
      lastSavedNodeState = JSON.stringify(saved.data.state);
    }
  } catch (error) {
    if (!isAbortError(error) && !disposed) {
      pollingErrors.value = {
        ...pollingErrors.value,
        [productId]: error instanceof Error ? error.message : '任务进度查询失败',
      };
    }
  } finally {
    if (activeRunControllers.get(productId)?.controller === controller) {
      activeRunControllers.delete(productId);
    }
  }
};

const resumeWorkspaceRuns = (): void => {
  Object.values(productStates.value).forEach((state) => {
    if (isExtractionRunning(state) && state.runId)
      void monitorProductRun(state.productId, state.runId);
  });
};

const loadWorkspace = async (): Promise<void> => {
  const generation = ++loadGeneration;
  stopAllRequests();
  closeGraphDialog(false);
  graphNodesByProduct.value = {};
  const controller = new AbortController();
  workspaceController = controller;
  loading.value = true;
  loadingError.value = '';
  try {
    const workspace = await loadEffectExtractionWorkspace(context.value, controller.signal);
    if (disposed || controller.signal.aborted || generation !== loadGeneration) return;
    applyWorkspace(workspace, true);
    const overview = await getActiveWorkflowRunOverview(
      props.projectId,
      'EFFECT',
      'EFFECT',
      controller.signal,
    );
    const saved =
      overview.data.run?.id === props.workflowRunId
        ? overview.data.nodeStates.find((item) => item.nodeId === 'INFORMATION_EXTRACTION')
        : undefined;
    if (saved) {
      nodeStateRevision.value = saved.revision;
      applyNodeState(saved.state);
      lastSavedNodeState = JSON.stringify(saved.state);
    } else {
      nodeStateRevision.value = 0;
      lastSavedNodeState = JSON.stringify(nodeStatePayload());
    }
    if (!props.products.some((product) => product.id === currentProductId.value)) {
      currentProductId.value = props.products[0]?.id ?? '';
    }
    resumeWorkspaceRuns();
  } catch (error) {
    if (isAbortError(error) || disposed || generation !== loadGeneration) return;
    loadingError.value = error instanceof Error ? error.message : '提炼工作区加载失败';
  } finally {
    if (!disposed && generation === loadGeneration) loading.value = false;
    if (workspaceController === controller) workspaceController = null;
  }
};

const runCurrentExtraction = async (): Promise<void> => {
  const product = currentProduct.value;
  const state = currentState.value;
  if (!product || !state || isExtractionRunning(state)) return;
  if (!(await flushPendingEdits())) return;
  stopProductPoll(product.id);
  const controller = new AbortController();
  activeRunControllers.set(product.id, { controller, runId: '' });
  pollingErrors.value = { ...pollingErrors.value, [product.id]: '' };
  patchProductState(product.id, {
    status: 'QUEUED',
    runId: null,
    progress: 0,
    currentNode: null,
    warnings: [],
    errorMessage: null,
  });
  graphNodesByProduct.value = {
    ...graphNodesByProduct.value,
    [product.id]: pendingGraphNodes(),
  };
  try {
    const run = await beginEffectExtraction(
      context.value,
      product.id,
      sourceRevision.value,
      controller.signal,
    );
    if (disposed || controller.signal.aborted) return;
    patchFromRun(product.id, run);
    void monitorProductRun(product.id, run.id, controller);
  } catch (error) {
    if (isAbortError(error) || disposed) return;
    if (error instanceof ApiClientError && error.status === 409) {
      await loadWorkspace();
      return;
    }
    patchProductState(product.id, {
      status: 'FAILED',
      errorMessage: error instanceof Error ? error.message : 'AI 信息提炼启动失败',
    });
    if (activeRunControllers.get(product.id)?.controller === controller) {
      activeRunControllers.delete(product.id);
    }
  }
};

const resumeCurrentPolling = (): void => {
  const state = currentState.value;
  if (!state?.runId) return;
  void monitorProductRun(state.productId, state.runId);
};

const closeGraphDialog = (restoreFocus = true): void => {
  graphController?.abort();
  graphController = null;
  graphDetailController?.abort();
  graphDetailController = null;
  graphDialogOpen.value = false;
  graphLoading.value = false;
  graphDetailLoading.value = false;
  selectedGraphNodeId.value = null;
  graphDetail.value = null;
  graphDetailError.value = '';
  if (restoreFocus) void nextTick(() => graphTrigger.value?.focus());
};

const refreshGraphDetail = async (): Promise<void> => {
  const nodeId = selectedGraphNodeId.value;
  const state = currentState.value;
  const productId = currentProductId.value;
  if (!nodeId || !state || !productId) return;
  graphDetail.value = localGraphDetail(nodeId);
  graphDetailError.value = '';
  if (!state.runId) return;

  graphDetailController?.abort();
  const controller = new AbortController();
  graphDetailController = controller;
  graphDetailLoading.value = true;
  try {
    const detail = await loadEffectExtractionNodeDetail(
      props.projectId,
      state.runId,
      nodeId,
      controller.signal,
    );
    if (
      disposed ||
      controller.signal.aborted ||
      currentProductId.value !== productId ||
      selectedGraphNodeId.value !== nodeId
    )
      return;
    graphDetail.value = detail;
  } catch (error) {
    if (!isAbortError(error) && !disposed) {
      graphDetailError.value = error instanceof Error ? error.message : '节点详情加载失败';
    }
  } finally {
    if (graphDetailController === controller) graphDetailController = null;
    if (!controller.signal.aborted) graphDetailLoading.value = false;
  }
};

const selectGraphNode = (nodeId: EffectExtractionNodeId): void => {
  selectedGraphNodeId.value = nodeId;
  void refreshGraphDetail();
};

const openGraphDialog = async (): Promise<void> => {
  const state = currentState.value;
  const productId = currentProductId.value;
  if (!state || !productId) return;
  graphDialogOpen.value = true;
  graphError.value = '';
  selectedGraphNodeId.value = null;
  graphDetail.value = null;
  graphDetailError.value = '';
  void nextTick(() => graphCloseButton.value?.focus());
  if (!state.runId) return;

  graphController?.abort();
  const controller = new AbortController();
  graphController = controller;
  graphLoading.value = true;
  try {
    const run = await loadEffectExtractionRun(props.projectId, state.runId, controller.signal);
    if (disposed || controller.signal.aborted || currentProductId.value !== productId) return;
    graphNodesByProduct.value = {
      ...graphNodesByProduct.value,
      [productId]: (run.nodes ?? pendingGraphNodes()).map((node) => ({
        ...node,
        warnings: node.warnings.map((warning) => ({ ...warning })),
      })),
    };
  } catch (error) {
    if (!isAbortError(error) && !disposed) {
      graphError.value = error instanceof Error ? error.message : '工作流状态加载失败';
    }
  } finally {
    if (graphController === controller) graphController = null;
    if (!controller.signal.aborted) graphLoading.value = false;
  }
};

const trapGraphFocus = (event: KeyboardEvent): void => {
  if (event.key !== 'Tab' || !graphPanel.value) return;
  const focusable = Array.from(
    graphPanel.value.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  );
  if (!focusable.length) return;
  const first = focusable[0]!;
  const last = focusable.at(-1)!;
  const active = document.activeElement as HTMLElement | null;
  if (!active || !focusable.includes(active)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  } else if (event.shiftKey && active === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
};

const handlePageKeydown = (event: KeyboardEvent): void => {
  if (event.key === 'Escape' && graphDialogOpen.value) closeGraphDialog();
};

const markDirty = (): void => {
  if (!currentState.value?.result || currentState.value.saveState === 'SAVING') return;
  currentState.value.saveState = 'DIRTY';
  if (!currentState.value.saveErrorMessage?.includes('其他窗口更新')) {
    currentState.value.saveErrorMessage = null;
  }
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void saveDraft(), 1000);
};

type ProductionRuleField =
  'aspectRatio' | 'deliveryChannels' | 'durationSeconds' | 'visualStyleBaseline';

const updateProductionRule = (field: ProductionRuleField, value: number | string): void => {
  const result = currentState.value?.result;
  if (!result || baseFieldsReadonly.value) return;
  if (field === 'durationSeconds') {
    result.durationSeconds = Math.min(
      EFFECT_IMPORT_LIMITS.maxDurationSeconds,
      Math.max(EFFECT_IMPORT_LIMITS.minDurationSeconds, Number(value) || 1),
    );
  } else {
    result[field] = String(value);
  }
  markDirty();
};

const productBaseValue = (field: ProductBaseField): string => {
  return currentState.value?.result?.[field] ?? '';
};

const updateProductBaseField = (field: ProductBaseField, event: Event): void => {
  const result = currentState.value?.result;
  if (!result) return;
  result[field] = (event.target as HTMLInputElement | HTMLTextAreaElement).value;
  markDirty();
};

const addSellingPoint = (): void => {
  const result = currentState.value?.result;
  if (!result || result.coreSellingPoints.length >= EFFECT_EXTRACTION_MAX_CORE_SELLING_POINTS)
    return;
  result.coreSellingPoints.push('');
  markDirty();
};

const removeSellingPoint = (index: number): void => {
  const result = currentState.value?.result;
  if (!result || result.coreSellingPoints.length <= 1) return;
  result.coreSellingPoints.splice(index, 1);
  markDirty();
};

type AdditionalSellingField = 'secondarySellingPoints' | 'trustBackings';
type UserInsightListField = 'corePainPoints' | 'decisionDrivers';
type ScenarioListField = 'usageScenarios' | 'purchaseScenarios' | 'emotionalScenarios';

const addAdditionalSellingPoint = (field: AdditionalSellingField): void => {
  const result = currentState.value?.result;
  const limit =
    field === 'secondarySellingPoints'
      ? EFFECT_EXTRACTION_MAX_SECONDARY_SELLING_POINTS
      : EFFECT_EXTRACTION_MAX_TRUST_BACKINGS;
  if (!result || result[field].length >= limit) return;
  result[field].push('');
  markDirty();
};

const removeAdditionalSellingPoint = (field: AdditionalSellingField, index: number): void => {
  const result = currentState.value?.result;
  if (!result) return;
  result[field].splice(index, 1);
  markDirty();
};

const addUserInsightItem = (field: UserInsightListField): void => {
  const result = currentState.value?.result;
  if (!result || result[field].length >= EFFECT_EXTRACTION_MAX_AUDIENCE_ITEMS) return;
  result[field].push('');
  markDirty();
};

const removeUserInsightItem = (field: UserInsightListField, index: number): void => {
  const result = currentState.value?.result;
  if (!result) return;
  result[field].splice(index, 1);
  markDirty();
};

const addScenarioItem = (field: ScenarioListField): void => {
  const result = currentState.value?.result;
  if (!result || result[field].length >= EFFECT_EXTRACTION_MAX_SCENARIO_ITEMS) return;
  result[field].push('');
  markDirty();
};

const removeScenarioItem = (field: ScenarioListField, index: number): void => {
  const result = currentState.value?.result;
  if (!result) return;
  result[field].splice(index, 1);
  markDirty();
};

const addDisabledElement = (): void => {
  const result = currentState.value?.result;
  const value = newDisabledElement.value.trim();
  if (!result || !value || result.disabledElements.includes(value)) return;
  result.disabledElements.push(value);
  newDisabledElement.value = '';
  markDirty();
};

const removeDisabledElement = (index: number): void => {
  const result = currentState.value?.result;
  if (!result) return;
  result.disabledElements.splice(index, 1);
  markDirty();
};

const saveDraft = async (): Promise<boolean> => {
  clearTimeout(saveTimer);
  saveTimer = undefined;
  const state = currentState.value;
  if (!state?.result || state.saveState === 'SAVING') return state?.saveState !== 'SAVE_FAILED';
  if (state.saveState !== 'DIRTY' && state.saveState !== 'SAVE_FAILED') return true;
  if (saveConflict.value) return false;
  return persistNodeState();
};

async function flushPendingEdits(): Promise<boolean> {
  clearTimeout(saveTimer);
  saveTimer = undefined;
  const dirty = Object.values(productStates.value).some(
    (state) => state.saveState === 'DIRTY' || state.saveState === 'SAVE_FAILED',
  );
  return dirty ? persistNodeState() : true;
}

const validateCurrentResult = async (): Promise<void> => {
  const state = currentState.value;
  if (!state?.resultId || state.resultRevision === null || state.status !== 'COMPLETED') return;
  if (!(await flushPendingEdits())) return;
  const refreshed = currentState.value;
  if (!refreshed?.resultId || refreshed.resultRevision === null) return;
  validating.value = true;
  validationMessage.value = '';
  try {
    const response = await validateEffectExtractionResult(props.projectId, refreshed.resultId, {
      expectedRevision: refreshed.resultRevision,
    });
    const artifact = response.data.artifacts[0];
    patchProductState(refreshed.productId, {
      commitStatus: 'COMMITTED',
      workingArtifactRevision: artifact?.revision ?? refreshed.workingArtifactRevision,
    });
    validationMessage.value = artifact?.unchanged
      ? '内容未变化，工作副本保持不变'
      : '工作副本已更新';
    if (!response.data.allProductsValidated) validationMessage.value += '，请继续完成其他产品校验';
  } catch (error) {
    validationMessage.value = error instanceof Error ? error.message : '完成校验失败';
  } finally {
    validating.value = false;
  }
};

const loadLatestResult = (): void => {
  void loadWorkspace();
};

const selectProduct = async (event: Event): Promise<void> => {
  const nextProductId = (event.target as HTMLSelectElement).value;
  if (!(await flushPendingEdits())) return;
  closeGraphDialog(false);
  currentProductId.value = nextProductId;
  newDisabledElement.value = '';
};

watch(
  [
    () => props.projectId,
    () => props.workflowRunId,
    () => props.draftId,
    () => props.mode,
    sourceSignature,
  ],
  () => void loadWorkspace(),
  { immediate: true },
);

const warnBeforeUnload = (event: BeforeUnloadEvent): void => {
  if (!Object.values(productStates.value).some((state) => state.saveState === 'DIRTY')) return;
  event.preventDefault();
  void persistNodeState(true);
};

onMounted(() => {
  window.addEventListener('beforeunload', warnBeforeUnload);
  window.addEventListener('keydown', handlePageKeydown);
});

defineExpose({ flushPendingEdits });

onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', warnBeforeUnload);
  window.removeEventListener('keydown', handlePageKeydown);
  clearTimeout(saveTimer);
  disposed = true;
  loadGeneration += 1;
  stopAllRequests();
});
</script>

<template>
  <section
    class="effect-extraction-node"
    aria-labelledby="effect-extraction-title"
    @focusout="saveDraft"
  >
    <section v-if="loading" class="extraction-page-state" role="status">
      <LoaderCircle class="spin" :size="31" />
      <h2>正在准备 AI 信息提炼</h2>
      <p>载入当前项目的产品资料与独立提炼草稿…</p>
    </section>
    <section v-else-if="loadingError" class="extraction-page-state error" role="alert">
      <AlertCircle :size="31" />
      <h2>AI 信息提炼加载失败</h2>
      <p>{{ loadingError }}</p>
      <button type="button" @click="loadWorkspace"><RefreshCw :size="14" />重新加载</button>
    </section>
    <section v-else-if="!currentProduct || !currentState" class="extraction-page-state">
      <FileText :size="31" />
      <h2>暂无可提炼的产品</h2>
      <p>请返回资料包导入节点补充并校验产品资料。</p>
      <button type="button" @click="emit('back')"><ArrowLeft :size="14" />返回上一步</button>
    </section>

    <template v-else>
      <header class="extraction-heading">
        <div class="extraction-heading__title">
          <span>02</span>
          <div>
            <h2 id="effect-extraction-title">产品素材制作信息卡</h2>
            <p>全部字段均可人工修订，红色标签为合规风险词</p>
          </div>
        </div>
        <div class="extraction-heading__actions">
          <label class="product-switcher">
            <span>当前商品</span>
            <select :value="currentProductId" @change="selectProduct">
              <option v-for="product in products" :key="product.id" :value="product.id">
                {{ product.name || '未命名产品' }} · {{ stateLabel(product.id) }}
              </option>
            </select>
          </label>
          <button
            ref="graphTrigger"
            class="secondary-button workflow-graph-trigger"
            type="button"
            aria-haspopup="dialog"
            @click="openGraphDialog"
          >
            <Workflow :size="14" />查看工作流
          </button>
          <button
            class="secondary-button"
            type="button"
            :disabled="currentRunning"
            @click="runCurrentExtraction"
          >
            <LoaderCircle v-if="currentRunning" class="spin" :size="14" />
            <RefreshCw v-else :size="14" />{{ currentActionLabel }}
          </button>
        </div>
      </header>

      <div v-if="currentState.status === 'FAILED'" class="state-alert danger" role="alert">
        <AlertCircle :size="17" />
        <div>
          <strong>本次 AI 提炼失败</strong>
          <p>{{ currentState.errorMessage }}</p>
        </div>
        <button type="button" @click="runCurrentExtraction">
          <RefreshCw :size="13" />重新提炼
        </button>
      </div>
      <div v-else-if="queueWaitingTooLong" class="state-alert warning" role="status">
        <AlertCircle :size="17" />
        <div>
          <strong>AI 提炼服务暂未接单</strong>
          <p>任务已经保存，不会丢失；如果持续等待，请联系管理员检查提炼服务。</p>
        </div>
      </div>
      <div v-else-if="currentState.status === 'STALE'" class="state-alert warning">
        <AlertCircle :size="17" />
        <div>
          <strong>上游产品资料已发生变化</strong>
          <p>当前结果仍可查看和编辑，重新提炼后才能进入下一节点。</p>
        </div>
        <button type="button" @click="runCurrentExtraction">
          <RefreshCw :size="13" />更新提炼结果
        </button>
      </div>

      <div v-if="currentRunning" class="state-alert running" role="status">
        <LoaderCircle class="spin" :size="17" />
        <div>
          <strong>{{
            currentState.status === 'QUEUED' ? '任务已进入处理队列' : '正在提炼产品资料'
          }}</strong>
          <p>{{ currentProgressLabel }} · {{ currentState.progress }}%</p>
          <span class="run-progress" aria-hidden="true">
            <i :style="{ width: `${currentState.progress}%` }" />
          </span>
        </div>
      </div>

      <div v-if="pollingErrors[currentState.productId]" class="state-alert danger" role="alert">
        <AlertCircle :size="17" />
        <div>
          <strong>任务进度暂时无法更新</strong>
          <p>{{ pollingErrors[currentState.productId] }}</p>
        </div>
        <button type="button" @click="resumeCurrentPolling">
          <RefreshCw :size="13" />恢复查询
        </button>
      </div>

      <div v-if="currentState.saveErrorMessage" class="state-alert danger" role="alert">
        <AlertCircle :size="17" />
        <div>
          <strong>{{ saveConflict ? '提炼草稿存在版本冲突' : '提炼草稿保存失败' }}</strong>
          <p>{{ currentState.saveErrorMessage }}</p>
        </div>
        <button v-if="saveConflict" type="button" @click="loadLatestResult">
          <RefreshCw :size="13" />加载最新结果
        </button>
      </div>

      <div class="product-info-layout">
        <section
          class="content-block product-base-card"
          :class="{ processing: currentRunning }"
          :aria-busy="currentRunning"
        >
          <h3>产品基础层</h3>
          <div class="base-fields">
            <label
              ><span>品类</span
              ><input
                :value="productBaseValue('productCategory')"
                :readonly="baseFieldsReadonly"
                @input="updateProductBaseField('productCategory', $event)"
            /></label>
            <label
              ><span>产品名称</span
              ><input
                :value="productBaseValue('productName')"
                :readonly="baseFieldsReadonly"
                @input="updateProductBaseField('productName', $event)"
            /></label>
            <label
              ><span>核心规格</span
              ><input
                :value="productBaseValue('coreSpecification')"
                :readonly="baseFieldsReadonly"
                @input="updateProductBaseField('coreSpecification', $event)"
            /></label>
            <label
              ><span>价格带</span
              ><input
                :value="productBaseValue('priceRange')"
                :readonly="baseFieldsReadonly"
                @input="updateProductBaseField('priceRange', $event)"
            /></label>
            <label class="wide"
              ><span>核心外观特征</span
              ><textarea
                :value="productBaseValue('visualFeatures')"
                :readonly="baseFieldsReadonly"
                @input="updateProductBaseField('visualFeatures', $event)"
              />
            </label>
          </div>
        </section>
        <aside class="inherit-card">
          <span>继承自步骤 1 · 只读</span>
          <h3>统一制作规则</h3>
          <dl>
            <div>
              <dt>画幅</dt>
              <dd>{{ currentConfig.aspectRatio }}</dd>
            </div>
            <div>
              <dt>时长</dt>
              <dd>{{ currentConfig.durationSeconds }} 秒</dd>
            </div>
            <div>
              <dt>风格</dt>
              <dd>{{ currentConfig.styleTone }}</dd>
            </div>
            <div>
              <dt>渠道</dt>
              <dd>{{ currentConfig.deliveryChannel }}</dd>
            </div>
          </dl>
          <p>如需修改，请返回步骤 1，后续将按影响范围增量更新。</p>
        </aside>
      </div>

      <div
        class="result-grid"
        :class="{
          muted: currentState.status === 'FAILED',
          processing: currentRunning,
        }"
        :aria-busy="currentRunning"
      >
        <section class="content-block">
          <div class="block-heading">
            <div>
              <h3>卖点分层</h3>
              <p>核心卖点建议 1–3 个</p>
            </div>
            <button
              class="selling-add-button"
              type="button"
              :disabled="
                baseFieldsReadonly ||
                visibleResult.coreSellingPoints.length >= EFFECT_EXTRACTION_MAX_CORE_SELLING_POINTS
              "
              :title="
                visibleResult.coreSellingPoints.length >= EFFECT_EXTRACTION_MAX_CORE_SELLING_POINTS
                  ? `最多添加 ${EFFECT_EXTRACTION_MAX_CORE_SELLING_POINTS} 个核心卖点`
                  : '添加一个核心卖点'
              "
              @click="addSellingPoint"
            >
              <Plus :size="13" />添加
            </button>
          </div>
          <div class="selling-points">
            <div
              v-for="(_point, index) in visibleResult.coreSellingPoints"
              :key="index"
              class="selling-point-row"
            >
              <span>核心卖点</span>
              <input
                v-model="visibleResult.coreSellingPoints[index]"
                :readonly="baseFieldsReadonly"
                placeholder="请输入核心卖点"
                @input="markDirty"
              />
              <button
                type="button"
                aria-label="删除卖点"
                :disabled="baseFieldsReadonly || visibleResult.coreSellingPoints.length <= 1"
                @click="removeSellingPoint(index)"
              >
                <Trash2 :size="14" />
              </button>
            </div>
            <div class="selling-subheading">
              <strong>次要卖点</strong>
              <button
                type="button"
                :disabled="
                  baseFieldsReadonly ||
                  visibleResult.secondarySellingPoints.length >=
                    EFFECT_EXTRACTION_MAX_SECONDARY_SELLING_POINTS
                "
                @click="addAdditionalSellingPoint('secondarySellingPoints')"
              >
                <Plus :size="13" />添加
              </button>
            </div>
            <div
              v-for="(_point, index) in visibleResult.secondarySellingPoints"
              :key="`secondary-${index}`"
              class="selling-point-row"
            >
              <span>次要卖点</span>
              <input
                v-model="visibleResult.secondarySellingPoints[index]"
                :readonly="baseFieldsReadonly"
                placeholder="请输入次要卖点"
                @input="markDirty"
              />
              <button
                type="button"
                aria-label="删除次要卖点"
                :disabled="baseFieldsReadonly"
                @click="removeAdditionalSellingPoint('secondarySellingPoints', index)"
              >
                <Trash2 :size="14" />
              </button>
            </div>
            <div class="selling-subheading">
              <strong>辅助信任背书</strong>
              <button
                type="button"
                :disabled="
                  baseFieldsReadonly ||
                  visibleResult.trustBackings.length >= EFFECT_EXTRACTION_MAX_TRUST_BACKINGS
                "
                @click="addAdditionalSellingPoint('trustBackings')"
              >
                <Plus :size="13" />添加
              </button>
            </div>
            <p v-if="!visibleResult.trustBackings.length" class="empty-inline">
              暂无可验证的信任背书
            </p>
            <div
              v-for="(_point, index) in visibleResult.trustBackings"
              :key="`trust-${index}`"
              class="selling-point-row"
            >
              <span>信任背书</span>
              <input
                v-model="visibleResult.trustBackings[index]"
                :readonly="baseFieldsReadonly"
                placeholder="仅填写有资料证据的背书"
                @input="markDirty"
              />
              <button
                type="button"
                aria-label="删除信任背书"
                :disabled="baseFieldsReadonly"
                @click="removeAdditionalSellingPoint('trustBackings', index)"
              >
                <Trash2 :size="14" />
              </button>
            </div>
          </div>
        </section>

        <section class="content-block user-layer-card">
          <div class="block-heading compact">
            <div><h3>用户层</h3></div>
          </div>
          <label class="field-label">
            <span>目标受众画像</span>
            <textarea
              v-model="visibleResult.targetAudience"
              :readonly="baseFieldsReadonly"
              @input="markDirty"
            />
          </label>
          <div class="selling-subheading">
            <strong>核心痛点</strong>
            <button
              type="button"
              :disabled="
                baseFieldsReadonly ||
                visibleResult.corePainPoints.length >= EFFECT_EXTRACTION_MAX_AUDIENCE_ITEMS
              "
              @click="addUserInsightItem('corePainPoints')"
            >
              <Plus :size="13" />添加
            </button>
          </div>
          <div class="structured-item-list">
            <p v-if="!visibleResult.corePainPoints.length" class="empty-inline">暂无核心痛点</p>
            <div
              v-for="(_item, index) in visibleResult.corePainPoints"
              :key="`pain-${index}`"
              class="selling-point-row"
            >
              <span>核心痛点</span>
              <input
                v-model="visibleResult.corePainPoints[index]"
                :readonly="baseFieldsReadonly"
                placeholder="请输入核心痛点"
                @input="markDirty"
              />
              <button
                type="button"
                aria-label="删除核心痛点"
                :disabled="baseFieldsReadonly"
                @click="removeUserInsightItem('corePainPoints', index)"
              >
                <Trash2 :size="14" />
              </button>
            </div>
          </div>
          <div class="selling-subheading">
            <strong>决策动因</strong>
            <button
              type="button"
              :disabled="
                baseFieldsReadonly ||
                visibleResult.decisionDrivers.length >= EFFECT_EXTRACTION_MAX_AUDIENCE_ITEMS
              "
              @click="addUserInsightItem('decisionDrivers')"
            >
              <Plus :size="13" />添加
            </button>
          </div>
          <div class="structured-item-list">
            <p v-if="!visibleResult.decisionDrivers.length" class="empty-inline">暂无决策动因</p>
            <div
              v-for="(_item, index) in visibleResult.decisionDrivers"
              :key="`driver-${index}`"
              class="selling-point-row"
            >
              <span>决策动因</span>
              <input
                v-model="visibleResult.decisionDrivers[index]"
                :readonly="baseFieldsReadonly"
                placeholder="请输入决策动因"
                @input="markDirty"
              />
              <button
                type="button"
                aria-label="删除决策动因"
                :disabled="baseFieldsReadonly"
                @click="removeUserInsightItem('decisionDrivers', index)"
              >
                <Trash2 :size="14" />
              </button>
            </div>
          </div>
          <label class="field-label user-marketing-goal">
            <span>营销目标</span>
            <textarea
              v-model="visibleResult.marketingGoal"
              :readonly="baseFieldsReadonly"
              @input="markDirty"
            />
          </label>
        </section>

        <section class="content-block scenario-layer-card">
          <div class="block-heading compact">
            <div><h3>场景层</h3></div>
          </div>
          <div class="selling-subheading">
            <strong>核心使用场景</strong>
            <button
              type="button"
              :disabled="
                baseFieldsReadonly ||
                visibleResult.usageScenarios.length >= EFFECT_EXTRACTION_MAX_SCENARIO_ITEMS
              "
              @click="addScenarioItem('usageScenarios')"
            >
              <Plus :size="13" />添加
            </button>
          </div>
          <div class="structured-item-list">
            <p v-if="!visibleResult.usageScenarios.length" class="empty-inline">暂无核心使用场景</p>
            <div
              v-for="(_item, index) in visibleResult.usageScenarios"
              :key="`usage-${index}`"
              class="selling-point-row"
            >
              <span>使用场景</span>
              <input
                v-model="visibleResult.usageScenarios[index]"
                :readonly="baseFieldsReadonly"
                placeholder="请输入核心使用场景"
                @input="markDirty"
              />
              <button
                type="button"
                aria-label="删除核心使用场景"
                :disabled="baseFieldsReadonly"
                @click="removeScenarioItem('usageScenarios', index)"
              >
                <Trash2 :size="14" />
              </button>
            </div>
          </div>
          <div class="selling-subheading">
            <strong>购买场景</strong>
            <button
              type="button"
              :disabled="
                baseFieldsReadonly ||
                visibleResult.purchaseScenarios.length >= EFFECT_EXTRACTION_MAX_SCENARIO_ITEMS
              "
              @click="addScenarioItem('purchaseScenarios')"
            >
              <Plus :size="13" />添加
            </button>
          </div>
          <div class="structured-item-list">
            <p v-if="!visibleResult.purchaseScenarios.length" class="empty-inline">暂无购买场景</p>
            <div
              v-for="(_item, index) in visibleResult.purchaseScenarios"
              :key="`purchase-${index}`"
              class="selling-point-row"
            >
              <span>购买场景</span>
              <input
                v-model="visibleResult.purchaseScenarios[index]"
                :readonly="baseFieldsReadonly"
                placeholder="请输入购买场景"
                @input="markDirty"
              />
              <button
                type="button"
                aria-label="删除购买场景"
                :disabled="baseFieldsReadonly"
                @click="removeScenarioItem('purchaseScenarios', index)"
              >
                <Trash2 :size="14" />
              </button>
            </div>
          </div>
          <div class="selling-subheading">
            <strong>情绪共鸣场景</strong>
            <button
              type="button"
              :disabled="
                baseFieldsReadonly ||
                visibleResult.emotionalScenarios.length >= EFFECT_EXTRACTION_MAX_SCENARIO_ITEMS
              "
              @click="addScenarioItem('emotionalScenarios')"
            >
              <Plus :size="13" />添加
            </button>
          </div>
          <div class="structured-item-list">
            <p v-if="!visibleResult.emotionalScenarios.length" class="empty-inline">
              暂无情绪共鸣场景
            </p>
            <div
              v-for="(_item, index) in visibleResult.emotionalScenarios"
              :key="`emotional-${index}`"
              class="selling-point-row"
            >
              <span>情绪场景</span>
              <input
                v-model="visibleResult.emotionalScenarios[index]"
                :readonly="baseFieldsReadonly"
                placeholder="请输入情绪共鸣场景"
                @input="markDirty"
              />
              <button
                type="button"
                aria-label="删除情绪共鸣场景"
                :disabled="baseFieldsReadonly"
                @click="removeScenarioItem('emotionalScenarios', index)"
              >
                <Trash2 :size="14" />
              </button>
            </div>
          </div>
        </section>

        <section class="content-block">
          <div class="block-heading">
            <div>
              <h3>制作规则层</h3>
              <p>初始值继承资料导入节点，可在当前信息卡中调整</p>
            </div>
          </div>
          <div class="production-rule-grid">
            <label class="field-label">
              <span>统一时长</span>
              <div class="production-duration-input">
                <input
                  :value="visibleResult.durationSeconds"
                  type="number"
                  :min="EFFECT_IMPORT_LIMITS.minDurationSeconds"
                  :max="EFFECT_IMPORT_LIMITS.maxDurationSeconds"
                  :disabled="baseFieldsReadonly"
                  @change="
                    updateProductionRule(
                      'durationSeconds',
                      ($event.target as HTMLInputElement).value,
                    )
                  "
                />
                <small>秒</small>
              </div>
            </label>
            <label class="field-label">
              <span>画幅</span>
              <EffectUpwardCreatableSelect
                field-label="画幅"
                :model-value="visibleResult.aspectRatio"
                :options="aspectRatioOptions"
                :disabled="baseFieldsReadonly"
                @update:model-value="updateProductionRule('aspectRatio', $event)"
              />
            </label>
            <label class="field-label wide">
              <span>投放渠道</span>
              <EffectUpwardCreatableSelect
                field-label="投放渠道"
                :model-value="visibleResult.deliveryChannels"
                :options="deliveryChannelOptions"
                :disabled="baseFieldsReadonly"
                @update:model-value="updateProductionRule('deliveryChannels', $event)"
              />
            </label>
          </div>
          <label class="field-label">
            <span>视觉风格基线</span>
            <EffectUpwardCreatableSelect
              field-label="视觉风格基线"
              :model-value="visibleResult.visualStyleBaseline"
              :options="visualStyleOptions"
              :disabled="baseFieldsReadonly"
              @update:model-value="updateProductionRule('visualStyleBaseline', $event)"
            />
          </label>
          <div class="field-label disabled-field">
            <span>合规禁用词库</span>
          </div>
          <div class="field-label disabled-field">
            <div class="disabled-tags">
              <button
                v-for="(element, index) in visibleResult.disabledElements"
                :key="`${element}-${index}`"
                type="button"
                :disabled="baseFieldsReadonly"
                @click="removeDisabledElement(index)"
              >
                {{ element }} <b>×</b>
              </button>
            </div>
            <div class="disabled-input-row">
              <input
                v-model="newDisabledElement"
                placeholder="输入新禁用词"
                :disabled="baseFieldsReadonly"
                @keydown.enter.prevent="addDisabledElement"
              />
              <button type="button" :disabled="baseFieldsReadonly" @click="addDisabledElement">
                添加
              </button>
            </div>
          </div>
        </section>
      </div>

      <WorkflowNodeDraftBar
        v-if="currentState.result"
        :detail="`${currentProduct.name} · 已自动保存到节点草稿 · ${commitStatusLabel}`"
        :state="draftBarState"
        :state-label="saveStateLabel"
        title="AI 营销信息提炼草稿"
      />

      <p v-if="validationMessage" class="validation-message" aria-live="polite">
        {{ validationMessage }}
      </p>

      <WorkflowNodeFooter
        back-label="上一步"
        :complete="readyForNext"
        :status-title="
          readyForNext
            ? '全部产品已完成校验'
            : currentState.commitStatus === 'COMMITTED'
              ? '当前产品已提交，请继续校验其他产品'
              : '当前产品完成校验后可继续'
        "
        :status-detail="`步骤 2 / 6 · ${currentProduct.name} · ${currentStatusMeta.label}`"
        :validating="validating"
        :validate-disabled="
          currentState.status !== 'COMPLETED' ||
          !currentState.result ||
          currentState.saveState === 'SAVING'
        "
        :next-disabled="!readyForNext"
        next-label="下一步：Prompt 生成"
        @back="emit('back')"
        @validate="validateCurrentResult"
        @next="emit('next')"
      />

      <Teleport to="body">
        <div
          v-if="graphDialogOpen"
          class="workflow-graph-backdrop"
          @mousedown.self="closeGraphDialog()"
        >
          <section
            ref="graphPanel"
            class="workflow-graph-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="workflow-graph-title"
            tabindex="-1"
            @keydown="trapGraphFocus"
          >
            <header class="workflow-graph-dialog__header">
              <div>
                <span class="workflow-graph-dialog__eyebrow">LANGGRAPH · 实时执行状态</span>
                <h3 id="workflow-graph-title">AI 信息提炼工作流</h3>
                <p>
                  {{ currentProduct.name }} · {{ currentStatusMeta.label }} ·
                  {{ currentState.progress }}%
                </p>
              </div>
              <button
                ref="graphCloseButton"
                type="button"
                aria-label="关闭工作流详情"
                @click="closeGraphDialog()"
              >
                <X :size="18" />
              </button>
            </header>

            <div v-if="graphError" class="workflow-graph-dialog__error" role="alert">
              <AlertCircle :size="16" />
              <span>{{ graphError }}</span>
              <button type="button" @click="openGraphDialog"><RefreshCw :size="13" />重试</button>
            </div>
            <div v-else-if="graphLoading" class="workflow-graph-dialog__loading" role="status">
              <LoaderCircle class="spin" :size="16" />正在同步节点状态…
            </div>

            <div class="workflow-graph-content">
              <div class="workflow-graph-canvas" aria-label="AI 信息提炼节点执行图">
                <article
                  class="workflow-graph-node workflow-graph-node--single"
                  :class="`is-${graphStatusMeta(graphExecution('LOAD_AND_SNAPSHOT').status).tone}`"
                  role="button"
                  tabindex="0"
                  :aria-pressed="selectedGraphNodeId === 'LOAD_AND_SNAPSHOT'"
                  @click="selectGraphNode('LOAD_AND_SNAPSHOT')"
                  @keydown.enter.prevent="selectGraphNode('LOAD_AND_SNAPSHOT')"
                  @keydown.space.prevent="selectGraphNode('LOAD_AND_SNAPSHOT')"
                >
                  <div class="workflow-graph-node__heading">
                    <span class="workflow-graph-node__icon"><FileText :size="17" /></span>
                    <div>
                      <strong>{{ graphNodeDefinition('LOAD_AND_SNAPSHOT').label }}</strong>
                      <small>{{ graphNodeDescription('LOAD_AND_SNAPSHOT') }}</small>
                    </div>
                    <em>{{ graphStatusMeta(graphExecution('LOAD_AND_SNAPSHOT').status).label }}</em>
                  </div>
                  <p v-if="graphExecution('LOAD_AND_SNAPSHOT').errorMessage" class="node-error">
                    {{ graphExecution('LOAD_AND_SNAPSHOT').errorMessage }}
                  </p>
                </article>

                <div class="workflow-graph-connector" aria-hidden="true"><i /></div>

                <div class="workflow-graph-parallel">
                  <article
                    v-for="nodeId in parallelGraphNodeIds"
                    :key="nodeId"
                    class="workflow-graph-node"
                    :class="`is-${graphStatusMeta(graphExecution(nodeId).status).tone}`"
                    role="button"
                    tabindex="0"
                    :aria-pressed="selectedGraphNodeId === nodeId"
                    @click="selectGraphNode(nodeId)"
                    @keydown.enter.prevent="selectGraphNode(nodeId)"
                    @keydown.space.prevent="selectGraphNode(nodeId)"
                  >
                    <div class="workflow-graph-node__heading">
                      <span class="workflow-graph-node__status-dot" aria-hidden="true" />
                      <div>
                        <strong>{{ graphNodeDefinition(nodeId).label }}</strong>
                        <small>{{ graphNodeDescription(nodeId) }}</small>
                      </div>
                      <em>{{ graphStatusMeta(graphExecution(nodeId).status).label }}</em>
                    </div>
                    <p v-if="graphExecution(nodeId).errorMessage" class="node-error">
                      {{ graphExecution(nodeId).errorMessage }}
                    </p>
                    <p
                      v-for="(warning, index) in graphExecution(nodeId).warnings"
                      :key="`${warning.code}-${warning.sourceId}-${index}`"
                      class="node-warning"
                    >
                      {{ presentWarningMessage(warning.message) }}
                    </p>
                  </article>
                </div>

                <div
                  class="workflow-graph-connector workflow-graph-connector--join"
                  aria-hidden="true"
                >
                  <i />
                </div>

                <article
                  class="workflow-graph-node workflow-graph-node--single"
                  :class="`is-${graphStatusMeta(graphExecution('FUSION').status).tone}`"
                  role="button"
                  tabindex="0"
                  :aria-pressed="selectedGraphNodeId === 'FUSION'"
                  @click="selectGraphNode('FUSION')"
                  @keydown.enter.prevent="selectGraphNode('FUSION')"
                  @keydown.space.prevent="selectGraphNode('FUSION')"
                >
                  <div class="workflow-graph-node__heading">
                    <span class="workflow-graph-node__status-dot" aria-hidden="true" />
                    <div>
                      <strong>{{ graphNodeDefinition('FUSION').label }}</strong>
                      <small>{{ graphNodeDescription('FUSION') }}</small>
                    </div>
                    <em>{{ graphStatusMeta(graphExecution('FUSION').status).label }}</em>
                  </div>
                  <p
                    v-for="(warning, index) in graphExecution('FUSION').warnings"
                    :key="`${warning.code}-${index}`"
                    class="node-warning"
                  >
                    {{ presentWarningMessage(warning.message) }}
                  </p>
                  <p v-if="graphExecution('FUSION').errorMessage" class="node-error">
                    {{ graphExecution('FUSION').errorMessage }}
                  </p>
                </article>

                <div class="workflow-graph-connector" aria-hidden="true"><i /></div>

                <article
                  class="workflow-graph-node workflow-graph-node--single"
                  :class="`is-${graphStatusMeta(graphExecution('NORMALIZATION').status).tone}`"
                  role="button"
                  tabindex="0"
                  :aria-pressed="selectedGraphNodeId === 'NORMALIZATION'"
                  @click="selectGraphNode('NORMALIZATION')"
                  @keydown.enter.prevent="selectGraphNode('NORMALIZATION')"
                  @keydown.space.prevent="selectGraphNode('NORMALIZATION')"
                >
                  <div class="workflow-graph-node__heading">
                    <span class="workflow-graph-node__status-dot" aria-hidden="true" />
                    <div>
                      <strong>{{ graphNodeDefinition('NORMALIZATION').label }}</strong>
                      <small>{{ graphNodeDescription('NORMALIZATION') }}</small>
                    </div>
                    <em>{{ graphStatusMeta(graphExecution('NORMALIZATION').status).label }}</em>
                  </div>
                  <p v-if="graphExecution('NORMALIZATION').errorMessage" class="node-error">
                    {{ graphExecution('NORMALIZATION').errorMessage }}
                  </p>
                  <p
                    v-for="(warning, index) in graphExecution('NORMALIZATION').warnings"
                    :key="`${warning.code}-${index}`"
                    class="node-warning"
                  >
                    {{ presentWarningMessage(warning.message) }}
                  </p>
                </article>
              </div>

              <aside class="workflow-node-detail" aria-live="polite">
                <div v-if="!selectedGraphNodeId" class="workflow-node-detail__empty">
                  <Workflow :size="24" />
                  <strong>点击节点查看数据</strong>
                  <p>仅展示安全摘要，不包含原始 Markdown、模型输入或内部存储地址。</p>
                </div>
                <template v-else>
                  <header class="workflow-node-detail__header">
                    <div>
                      <span>节点详情</span>
                      <strong>{{ graphNodeDefinition(selectedGraphNodeId).label }}</strong>
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
                    v-if="graphDetailLoading"
                    class="workflow-node-detail__loading"
                    role="status"
                  >
                    <LoaderCircle class="spin" :size="14" />正在同步安全摘要…
                  </div>
                  <div v-if="graphDetailError" class="workflow-node-detail__error" role="alert">
                    <AlertCircle :size="14" />{{ graphDetailError }}
                  </div>

                  <template v-if="graphDetail">
                    <div class="workflow-node-detail__status">
                      <em :class="`is-${graphStatusMeta(graphDetail.status).tone}`">
                        {{ graphStatusMeta(graphDetail.status).label }}
                      </em>
                    </div>
                    <p class="workflow-node-detail__summary">{{ graphDetail.summary }}</p>

                    <dl v-if="graphDetail.fields.length" class="workflow-node-detail__fields">
                      <div v-for="item in graphDetail.fields" :key="item.key">
                        <dt>
                          {{ item.label }}
                          <span v-if="item.source">{{ item.source }}</span>
                        </dt>
                        <dd>{{ graphDetailValue(item.value) }}</dd>
                      </div>
                    </dl>

                    <section
                      v-for="(source, sourceIndex) in graphDetail.sources"
                      :key="`${source.name}-${sourceIndex}`"
                      class="workflow-node-detail__source"
                    >
                      <header>
                        <div class="workflow-node-detail__source-identity">
                          <span
                            v-if="source.media"
                            class="workflow-node-detail__source-visual"
                            :class="`is-${source.media.kind.toLowerCase()}`"
                          >
                            <img
                              v-if="source.media.kind === 'IMAGE' && graphPreviewUrl(source)"
                              :src="graphPreviewUrl(source)!"
                              :alt="`${source.name} 预览图`"
                              loading="lazy"
                              decoding="async"
                              @error="markGraphPreviewFailed(source.media.previewUrl!)"
                            />
                            <small v-else-if="source.media.kind === 'IMAGE'">暂无预览</small>
                            <Link2 v-else-if="source.media.kind === 'LINK'" :size="18" />
                            <FileText v-else-if="source.media.kind === 'VIDEO'" :size="18" />
                            <span v-else>{{ graphDetailExtension(source.name) }}</span>
                          </span>
                          <span class="workflow-node-detail__source-copy">
                            <strong>{{ source.name }}</strong>
                            <small v-if="source.media">
                              {{ source.media.typeLabel
                              }}<template v-if="source.media.sizeBytes !== null">
                                · {{ graphDetailBytes(source.media.sizeBytes) }}</template
                              >
                            </small>
                          </span>
                        </div>
                        <em
                          v-if="selectedGraphNodeId !== 'LOAD_AND_SNAPSHOT'"
                          :class="`is-${graphStatusMeta(source.status).tone}`"
                        >
                          {{ graphStatusMeta(source.status).label }}
                        </em>
                      </header>
                      <dl v-if="source.fields.length" class="workflow-node-detail__fields">
                        <div v-for="item in source.fields" :key="`${sourceIndex}-${item.key}`">
                          <dt>
                            {{ item.label }}
                            <span v-if="item.source">{{ item.source }}</span>
                          </dt>
                          <dd>{{ graphDetailValue(item.value) }}</dd>
                        </div>
                      </dl>
                      <p v-for="warning in source.warnings" :key="warning" class="node-warning">
                        {{ warning }}
                      </p>
                    </section>

                    <p
                      v-for="(warning, index) in graphDetail.warnings"
                      :key="`${warning.code}-${index}`"
                      class="node-warning"
                    >
                      {{ presentWarningMessage(warning.message) }}
                    </p>
                    <p v-if="graphDetail.errorMessage" class="node-error">
                      {{ graphDetail.errorMessage }}
                    </p>
                  </template>
                </template>
              </aside>
            </div>

            <footer class="workflow-graph-dialog__footer">
              <span><i class="legend-running" />执行中</span>
              <span><i class="legend-success" />已完成</span>
              <span><i class="legend-warning" />部分完成 / 跳过</span>
              <span><i class="legend-danger" />失败</span>
              <button type="button" @click="closeGraphDialog()">关闭</button>
            </footer>
          </section>
        </div>
      </Teleport>
    </template>
  </section>
</template>

<style scoped>
.validation-message {
  margin: 0;
  color: #49647f;
  font-size: 13px;
  text-align: right;
}
.effect-extraction-node {
  --effect-blue: #2563eb;
  min-height: 460px;
  padding: 28px;
  color: #253047;
  background: #fff;
  border: 1px solid #dbe4f6;
  border-radius: 26px;
  box-shadow: 0 12px 34px #7a4e3b12;
}
.extraction-heading {
  display: flex;
  min-height: 50px;
  margin-bottom: 22px;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
}
.extraction-heading__title {
  display: flex;
  min-width: 330px;
  align-items: center;
  gap: 13px;
}
.extraction-heading__title > span {
  display: grid;
  width: 44px;
  height: 44px;
  flex: 0 0 44px;
  place-items: center;
  color: #d83e69;
  background: #fff0f4;
  border-radius: 14px;
  font-size: 13px;
  font-weight: 900;
}
.extraction-heading h2,
.extraction-heading p {
  margin: 0;
}
.extraction-heading h2 {
  color: #172033;
  font-size: 21px;
}
.extraction-heading p {
  margin-top: 5px;
  color: #7d899d;
  font-size: 12px;
}
.extraction-heading__actions {
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
  padding: 0 32px 0 12px;
  color: #42526a;
  background: #fff;
  border: 1px solid #dbe4f6;
  border-radius: 10px;
  outline: 0;
  font-size: 12px;
}
.extraction-heading__actions .secondary-button {
  min-width: 139px;
}
.product-switcher select:focus,
input:focus,
textarea:focus {
  border-color: #7da7ef;
  box-shadow: 0 0 0 3px #2563eb14;
  outline: 0;
}
.status-pill {
  display: inline-flex;
  min-height: 24px;
  padding: 2px 8px;
  align-items: center;
  justify-content: center;
  gap: 4px;
  color: #64748b;
  background: #f3f6fa;
  border: 1px solid #dce5f1;
  border-radius: 7px;
  font-size: 11px;
  font-weight: 650;
  white-space: nowrap;
}
.status-pill.success {
  color: #0f8a68;
  background: #eefaf6;
  border-color: #ccebdc;
}
.status-pill.running {
  color: #2563eb;
  background: #eef4ff;
  border-color: #cfe0ff;
}
.status-pill.warning {
  color: #b7791f;
  background: #fff8e8;
  border-color: #f2dfb4;
}
.status-pill.danger {
  color: #dc3f52;
  background: #fff1f2;
  border-color: #f7c8ce;
}
.secondary-button,
.primary-button,
.extraction-page-state button,
.state-alert button {
  display: inline-flex;
  height: 40px;
  padding: 0 14px;
  align-items: center;
  justify-content: center;
  gap: 6px;
  color: #42526a;
  background: #fff;
  border: 1px solid #dbe4f6;
  border-radius: 10px;
  font-size: 11px;
  font-weight: 700;
  white-space: nowrap;
}
.primary-button {
  color: #fff;
  background: #2563eb;
  border-color: #2563eb;
  box-shadow: 0 8px 18px #2563eb2e;
}
button:disabled {
  cursor: not-allowed;
  opacity: 0.46;
  box-shadow: none !important;
}
.state-alert {
  display: flex;
  min-height: 58px;
  margin: 0 0 18px;
  padding: 10px 12px;
  align-items: center;
  gap: 10px;
  border-radius: 12px;
}
.state-alert > div {
  min-width: 0;
  flex: 1;
}
.state-alert strong,
.state-alert p {
  margin: 0;
}
.state-alert strong {
  font-size: 12px;
}
.state-alert p {
  margin-top: 3px;
  font-size: 10px;
  line-height: 1.5;
}
.state-alert button {
  height: 32px;
  padding: 0 10px;
}
.state-alert.danger {
  color: #a53d4b;
  background: #fff1f2;
  border: 1px solid #f7c8ce;
}
.state-alert.warning {
  color: #956315;
  background: #fff8e8;
  border: 1px solid #f2dfb4;
}
.state-alert.running {
  color: #2559a7;
  background: #eef4ff;
  border: 1px solid #cfe0ff;
}
.run-progress {
  display: block;
  height: 4px;
  margin-top: 7px;
  overflow: hidden;
  background: #dbe7fb;
  border-radius: 999px;
}
.run-progress i {
  display: block;
  height: 100%;
  background: #2563eb;
  border-radius: inherit;
  transition: width 0.2s ease;
}
.product-info-layout {
  display: grid;
  grid-template-columns: minmax(0, 3fr) minmax(240px, 1fr);
  gap: 18px;
}
.content-block,
.inherit-card {
  padding: 20px;
  background: #fff;
  border: 1px solid #f0e2db;
  border-radius: 20px;
}
.product-base-card,
.inherit-card {
  min-height: 346px;
}
.content-block h3,
.inherit-card h3 {
  margin: 0;
  color: #263247;
  font-size: 15px;
}
.base-fields {
  display: grid;
  margin-top: 0;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  column-gap: 16px;
  row-gap: 18px;
}
.base-fields label {
  display: grid;
  gap: 8px;
  color: #596278;
  font-size: 14px;
  font-weight: 650;
}
.base-fields label > span {
  line-height: 22px;
}
.field-label {
  display: grid;
  gap: 8px;
  color: #596278;
  font-size: 14px;
  font-weight: 650;
}
.field-label > span {
  line-height: 22px;
}
.base-fields label.wide {
  grid-column: 1 / -1;
}
input,
textarea,
select {
  font: inherit;
}
.base-fields input,
.base-fields textarea,
.field-label input,
.field-label textarea,
.selling-point-row input,
.disabled-input-row input {
  width: 100%;
  color: #42526a;
  background: #fff;
  border: 1px solid #dce3ec;
  border-radius: 10px;
  outline: 0;
  font-size: 14px;
  font-weight: 400;
}
.field-label input,
.selling-point-row input,
.disabled-input-row input {
  height: 42px;
  padding: 0 11px;
}
.production-duration-input {
  display: flex;
  min-height: 42px;
  align-items: center;
  gap: 8px;
}
.production-duration-input input {
  min-width: 0;
  flex: 1;
}
.production-duration-input small {
  flex: 0 0 auto;
  color: #7f8ca0;
  font-size: 12px;
}
.selling-point-row input {
  height: 40px;
}
.field-label textarea {
  height: 56px;
  min-height: 56px;
  padding: 5px 11px;
  line-height: 23px;
  resize: none;
}
.base-fields input {
  height: 42px;
  padding: 0 11px;
  font-size: 14px;
}
.base-fields textarea {
  height: 56px;
  min-height: 56px;
  padding: 5px 11px;
  font-size: 14px;
  line-height: 23px;
  resize: none;
}
.base-fields input[readonly],
.base-fields textarea[readonly] {
  color: #606266;
  background: #fff;
}
.product-base-card.processing .base-fields input,
.product-base-card.processing .base-fields textarea {
  color: #2563eb;
  background: #f5f8ff;
}
.inherit-card {
  background: linear-gradient(145deg, #fffdfb, #fff6f2);
  border-color: #f7d6c7;
}
.inherit-card > span {
  display: inline-flex;
  padding: 4px 8px;
  color: #d9574e;
  background: #fff;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 800;
}
.inherit-card h3 {
  margin: 14px 0 12px;
  font-size: 16px;
}
.inherit-card dl {
  margin: 0;
}
.inherit-card dl > div {
  display: flex;
  min-height: 34px;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  border-bottom: 1px solid #f2ddd5;
}
.inherit-card dt {
  color: #8e7a70;
  font-size: 12px;
}
.inherit-card dd {
  margin: 0;
  color: #253047;
  font-size: 12px;
  font-weight: 700;
  text-align: right;
}
.inherit-card p {
  margin: 12px 0 0;
  color: #a08377;
  font-size: 11px;
  line-height: 1.65;
}
.result-grid {
  display: grid;
  margin-top: 18px;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 18px;
}
.result-grid .content-block {
  min-height: 332px;
}
.result-grid .content-block:nth-child(-n + 2) {
  min-height: 374px;
}
.result-grid.muted {
  opacity: 0.78;
}
.block-heading {
  display: flex;
  margin-bottom: 15px;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.block-heading h3,
.block-heading p {
  margin: 0;
}
.block-heading p {
  margin-top: 4px;
  color: #9198a7;
  font-size: 12px;
}
.block-heading.compact {
  margin-bottom: 0;
}
.block-heading button {
  display: inline-flex;
  height: 40px;
  padding: 0 18px;
  align-items: center;
  gap: 5px;
  color: #42526a;
  background: #fff;
  border: 1px solid #dbe4f6;
  border-radius: 10px;
  font-size: 14px;
  font-weight: 700;
}
.field-label + .field-label {
  margin-top: 18px;
}
.selling-points {
  display: grid;
  gap: 10px;
}
.selling-subheading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 10px;
  color: #304664;
  font-size: 13px;
}
.selling-subheading button,
.selling-add-button {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-height: 30px;
  padding: 0 10px;
  color: #2f6df6;
  background: #f5f8ff;
  border: 1px solid #d6e3ff;
  border-radius: 9px;
}
.empty-inline {
  margin: 0;
  color: #8a98ad;
  font-size: 12px;
}
.structured-item-list {
  display: grid;
  gap: 10px;
}
.selling-subheading + .structured-item-list {
  margin-top: 10px;
}
.user-marketing-goal {
  margin-top: 18px;
}
.selling-point-row {
  display: grid;
  grid-template-columns: 112px minmax(0, 1fr) 38px;
  gap: 8px;
}
.selling-point-row > span {
  display: flex;
  height: 40px;
  align-items: center;
  justify-content: center;
  color: #596278;
  background: #f8fafc;
  border: 1px solid #dce3ec;
  border-radius: 10px;
  font-size: 14px;
  font-weight: 650;
}
.selling-point-row button {
  display: grid;
  width: 38px;
  height: 40px;
  padding: 0;
  place-items: center;
  color: #7b8799;
  background: #fff;
  border: 1px solid #dbe4f6;
  border-radius: 10px;
}
.disabled-field {
  margin-top: 14px;
}
.production-rule-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
.production-rule-grid .field-label + .field-label {
  margin-top: 0;
}
.production-rule-grid .wide {
  grid-column: 1 / -1;
}
.production-rule-grid + .field-label {
  margin-top: 18px;
}
.disabled-tags {
  display: flex;
  min-height: 28px;
  flex-wrap: wrap;
  gap: 6px;
}
.disabled-tags button {
  display: inline-flex;
  min-height: 24px;
  padding: 2px 8px;
  align-items: center;
  gap: 5px;
  color: #dc3f52;
  background: #fff1f2;
  border: 1px solid #f7c8ce;
  border-radius: 7px;
  font-size: 11px;
}
.disabled-tags b {
  font-size: 12px;
}
.disabled-input-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 58px;
  gap: 8px;
}
.disabled-input-row button {
  color: #42526a;
  background: #fff;
  border: 1px solid #dbe4f6;
  border-radius: 10px;
  font-size: 14px;
  font-weight: 700;
}
.extraction-page-state {
  display: flex;
  min-height: 430px;
  padding: 30px;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  color: #7f8da2;
  text-align: center;
}
.extraction-page-state > svg {
  color: #2563eb;
}
.extraction-page-state h2 {
  margin: 13px 0 5px;
  color: #34445c;
  font-size: 18px;
}
.extraction-page-state p {
  margin: 0;
  font-size: 11px;
}
.extraction-page-state button {
  margin-top: 15px;
}
.extraction-page-state.error > svg {
  color: #dc3f52;
}
.workflow-graph-backdrop {
  position: fixed;
  z-index: 1200;
  inset: 0;
  display: grid;
  padding: 28px;
  place-items: center;
  background: #17233f80;
  backdrop-filter: blur(3px);
}
.workflow-graph-dialog {
  width: min(1180px, 100%);
  max-height: min(820px, calc(100vh - 56px));
  overflow: auto;
  color: #253047;
  background: #f8faff;
  border: 1px solid #dbe4f6;
  border-radius: 22px;
  outline: none;
  box-shadow: 0 28px 80px #17233f40;
}
.workflow-graph-dialog__header {
  position: sticky;
  z-index: 2;
  top: 0;
  display: flex;
  padding: 20px 22px;
  align-items: flex-start;
  justify-content: space-between;
  gap: 18px;
  background: #ffffffed;
  border-bottom: 1px solid #dbe4f6;
  backdrop-filter: blur(8px);
}
.workflow-graph-dialog__header h3,
.workflow-graph-dialog__header p {
  margin: 0;
}
.workflow-graph-dialog__header h3 {
  margin-top: 4px;
  font-size: 19px;
}
.workflow-graph-dialog__header p {
  margin-top: 5px;
  color: #718096;
  font-size: 11px;
}
.workflow-graph-dialog__eyebrow {
  color: #2563eb;
  font-size: 9px;
  font-weight: 850;
  letter-spacing: 0.12em;
}
.workflow-graph-dialog__header > button {
  display: grid;
  width: 36px;
  height: 36px;
  padding: 0;
  flex: 0 0 auto;
  place-items: center;
  color: #5f6d82;
  background: #f5f8ff;
  border: 1px solid #dbe4f6;
  border-radius: 10px;
}
.workflow-graph-dialog__loading,
.workflow-graph-dialog__error {
  display: flex;
  margin: 14px 22px 0;
  padding: 10px 12px;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  border-radius: 10px;
}
.workflow-graph-dialog__loading {
  color: #2563eb;
  background: #edf4ff;
}
.workflow-graph-dialog__error {
  color: #b83246;
  background: #fff1f2;
}
.workflow-graph-dialog__error span {
  flex: 1;
}
.workflow-graph-dialog__error button {
  display: inline-flex;
  padding: 4px 8px;
  align-items: center;
  gap: 4px;
  color: inherit;
  background: #fff;
  border: 1px solid #f3c5cc;
  border-radius: 7px;
  font-size: 10px;
}
.workflow-graph-content {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 320px;
  align-items: start;
  gap: 0;
}
.workflow-graph-canvas {
  padding: 22px;
}
.workflow-graph-node {
  position: relative;
  min-width: 0;
  padding: 13px;
  background: #fff;
  border: 1px solid #dbe4f6;
  border-radius: 14px;
  cursor: pointer;
  outline: none;
  box-shadow: 0 7px 20px #2f5f9910;
  transition:
    border-color 0.16s ease,
    box-shadow 0.16s ease,
    transform 0.16s ease;
}
.workflow-graph-node:hover {
  border-color: #9bb9ef;
  transform: translateY(-1px);
}
.workflow-graph-node:focus-visible {
  box-shadow: 0 0 0 3px #cfe0ff;
}
.workflow-graph-node[aria-pressed='true'] {
  border-color: #2563eb;
  box-shadow: 0 0 0 3px #dbeafe;
}
.workflow-graph-node--single {
  width: min(440px, 100%);
  margin: 0 auto;
}
.workflow-graph-node__heading {
  display: flex;
  align-items: flex-start;
  gap: 9px;
}
.workflow-graph-node__heading > div {
  min-width: 0;
  flex: 1;
}
.workflow-graph-node__heading strong,
.workflow-graph-node__heading small {
  display: block;
}
.workflow-graph-node__heading strong {
  font-size: 12px;
}
.workflow-graph-node__heading small {
  margin-top: 4px;
  color: #7d899f;
  font-size: 9px;
  line-height: 1.55;
}
.workflow-graph-node__heading em {
  padding: 4px 7px;
  flex: 0 0 auto;
  color: #718096;
  background: #f1f4f8;
  border-radius: 999px;
  font-size: 8px;
  font-style: normal;
  font-weight: 800;
}
.workflow-graph-node__icon {
  display: grid;
  width: 32px;
  height: 32px;
  flex: 0 0 auto;
  place-items: center;
  color: #2563eb;
  background: #eaf2ff;
  border-radius: 9px;
}
.workflow-graph-node__status-dot {
  width: 9px;
  height: 9px;
  margin-top: 4px;
  flex: 0 0 auto;
  background: #a7b0bf;
  border: 2px solid #eef1f5;
  border-radius: 999px;
  box-sizing: content-box;
}
.workflow-graph-node.is-running {
  background: #f7faff;
  border-color: #91b7ff;
  box-shadow: 0 0 0 3px #dbeafe;
}
.workflow-graph-node.is-running .workflow-graph-node__status-dot {
  background: #2563eb;
  border-color: #dbeafe;
  animation: pulse-node 1.2s ease-in-out infinite;
}
.workflow-graph-node.is-running em {
  color: #2563eb;
  background: #eaf2ff;
}
.workflow-graph-node.is-success {
  border-color: #b9e1d5;
}
.workflow-graph-node.is-success .workflow-graph-node__status-dot {
  background: #0f9f78;
  border-color: #ddf6ee;
}
.workflow-graph-node.is-success em {
  color: #0f8a68;
  background: #eaf8f3;
}
.workflow-graph-node.is-warning {
  border-color: #efd89a;
}
.workflow-graph-node.is-warning .workflow-graph-node__status-dot,
.workflow-graph-node.is-skipped .workflow-graph-node__status-dot {
  background: #d99a22;
  border-color: #fff4d8;
}
.workflow-graph-node.is-warning em,
.workflow-graph-node.is-skipped em {
  color: #a46b0a;
  background: #fff5dc;
}
.workflow-graph-node.is-danger {
  border-color: #efb7c0;
}
.workflow-graph-node.is-danger .workflow-graph-node__status-dot {
  background: #dc3f52;
  border-color: #ffe4e8;
}
.workflow-graph-node.is-danger em {
  color: #c93448;
  background: #fff0f2;
}
.workflow-graph-connector {
  display: grid;
  height: 28px;
  place-items: center;
}
.workflow-graph-connector i {
  display: block;
  width: 1px;
  height: 100%;
  background: #b9c8df;
}
.workflow-graph-parallel {
  position: relative;
  display: grid;
  padding-top: 16px;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
}
.workflow-graph-parallel::before {
  position: absolute;
  top: 0;
  right: 12.5%;
  left: 12.5%;
  height: 1px;
  content: '';
  background: #b9c8df;
}
.workflow-graph-parallel > article::before {
  position: absolute;
  top: -16px;
  left: 50%;
  width: 1px;
  height: 16px;
  content: '';
  background: #b9c8df;
}
.workflow-graph-connector--join {
  height: 34px;
}
.node-warning,
.node-error {
  margin: 8px 0 0;
  padding: 6px 8px;
  font-size: 9px;
  line-height: 1.5;
  border-radius: 7px;
}
.node-warning {
  color: #956109;
  background: #fff8e8;
}
.node-error {
  color: #bd3346;
  background: #fff1f2;
}
.workflow-node-detail {
  position: sticky;
  top: 98px;
  min-height: 430px;
  max-height: 620px;
  margin: 22px 22px 22px 0;
  padding: 16px;
  overflow: auto;
  background: #fff;
  border: 1px solid #dbe4f6;
  border-radius: 16px;
  box-shadow: 0 9px 24px #2f5f9910;
}
.workflow-node-detail__empty {
  display: grid;
  min-height: 390px;
  padding: 28px 18px;
  place-content: center;
  justify-items: center;
  color: #7d899f;
  text-align: center;
}
.workflow-node-detail__empty svg {
  margin-bottom: 12px;
  color: #2563eb;
}
.workflow-node-detail__empty strong {
  color: #33415a;
  font-size: 13px;
}
.workflow-node-detail__empty p {
  max-width: 230px;
  margin: 8px 0 0;
  font-size: 10px;
  line-height: 1.65;
}
.workflow-node-detail__header {
  display: flex;
  padding-bottom: 12px;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  border-bottom: 1px solid #e7edf8;
}
.workflow-node-detail__header span,
.workflow-node-detail__header strong {
  display: block;
}
.workflow-node-detail__header span {
  color: #2563eb;
  font-size: 9px;
  font-weight: 850;
  letter-spacing: 0.1em;
}
.workflow-node-detail__header strong {
  margin-top: 4px;
  color: #253047;
  font-size: 14px;
}
.workflow-node-detail__header button {
  display: grid;
  width: 30px;
  height: 30px;
  padding: 0;
  place-items: center;
  color: #2563eb;
  background: #edf4ff;
  border: 0;
  border-radius: 8px;
}
.workflow-node-detail__header button:disabled {
  opacity: 0.55;
}
.workflow-node-detail__loading,
.workflow-node-detail__error {
  display: flex;
  margin-top: 10px;
  padding: 8px 9px;
  align-items: center;
  gap: 6px;
  font-size: 9px;
  border-radius: 8px;
}
.workflow-node-detail__loading {
  color: #2563eb;
  background: #edf4ff;
}
.workflow-node-detail__error {
  color: #bd3346;
  background: #fff1f2;
}
.workflow-node-detail__status {
  display: flex;
  margin-top: 13px;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.workflow-node-detail__status em,
.workflow-node-detail__source header em {
  padding: 4px 7px;
  color: #718096;
  background: #f1f4f8;
  border-radius: 999px;
  font-size: 8px;
  font-style: normal;
  font-weight: 800;
}
.workflow-node-detail__status em.is-running,
.workflow-node-detail__source header em.is-running {
  color: #2563eb;
  background: #eaf2ff;
}
.workflow-node-detail__status em.is-success,
.workflow-node-detail__source header em.is-success {
  color: #0f8a68;
  background: #eaf8f3;
}
.workflow-node-detail__status em.is-warning,
.workflow-node-detail__status em.is-skipped,
.workflow-node-detail__source header em.is-warning,
.workflow-node-detail__source header em.is-skipped {
  color: #a46b0a;
  background: #fff5dc;
}
.workflow-node-detail__status em.is-danger,
.workflow-node-detail__source header em.is-danger {
  color: #c93448;
  background: #fff0f2;
}
.workflow-node-detail__status time {
  color: #8994a8;
  font-size: 8px;
}
.workflow-node-detail__summary {
  margin: 10px 0 0;
  color: #5f6d82;
  font-size: 10px;
  line-height: 1.65;
}
.workflow-node-detail__fields {
  display: grid;
  margin: 12px 0 0;
  gap: 7px;
}
.workflow-node-detail__fields > div {
  display: grid;
  padding: 8px 9px;
  gap: 5px;
  background: #f7f9fd;
  border-radius: 8px;
}
.workflow-node-detail__fields dt {
  display: flex;
  margin: 0;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  color: #7b879a;
  font-size: 8px;
}
.workflow-node-detail__fields dt span {
  color: #2563eb;
}
.workflow-node-detail__fields dd {
  margin: 0;
  overflow-wrap: anywhere;
  color: #33415a;
  font-size: 10px;
  font-weight: 700;
  line-height: 1.5;
}
.workflow-node-detail__source {
  margin-top: 11px;
  padding: 10px;
  background: #fbfcff;
  border: 1px solid #e4eaf6;
  border-radius: 10px;
}
.workflow-node-detail__source > header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.workflow-node-detail__source-identity {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 9px;
}
.workflow-node-detail__source-visual {
  display: grid;
  width: 48px;
  height: 48px;
  flex: 0 0 48px;
  overflow: hidden;
  place-items: center;
  color: #2563eb;
  background: #edf4ff;
  border: 1px solid #dbe7fb;
  border-radius: 10px;
  font-size: 9px;
  font-weight: 900;
}
.workflow-node-detail__source-visual.is-image {
  color: #8b94a6;
  background: #f5f7fb;
}
.workflow-node-detail__source-visual img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.workflow-node-detail__source-visual small {
  padding: 4px;
  text-align: center;
  font-size: 8px;
  line-height: 1.25;
}
.workflow-node-detail__source-copy {
  min-width: 0;
}
.workflow-node-detail__source-copy strong,
.workflow-node-detail__source-copy small {
  display: block;
}
.workflow-node-detail__source-copy strong {
  overflow-wrap: anywhere;
  color: #33415a;
  font-size: 10px;
}
.workflow-node-detail__source-copy small {
  margin-top: 4px;
  color: #8a96a9;
  font-size: 8px;
}
.workflow-node-detail__source .workflow-node-detail__fields {
  margin-top: 8px;
}
.workflow-graph-dialog__footer {
  display: flex;
  padding: 14px 22px 18px;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
  color: #718096;
  font-size: 9px;
}
.workflow-graph-dialog__footer span {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.workflow-graph-dialog__footer i {
  width: 7px;
  height: 7px;
  background: #a7b0bf;
  border-radius: 999px;
}
.workflow-graph-dialog__footer .legend-running {
  background: #2563eb;
}
.workflow-graph-dialog__footer .legend-success {
  background: #0f9f78;
}
.workflow-graph-dialog__footer .legend-warning {
  background: #d99a22;
}
.workflow-graph-dialog__footer .legend-danger {
  background: #dc3f52;
}
.workflow-graph-dialog__footer > button {
  height: 34px;
  margin-left: auto;
  padding: 0 16px;
  color: #fff;
  background: #2563eb;
  border: 0;
  border-radius: 9px;
  font-size: 10px;
  font-weight: 800;
}
@keyframes pulse-node {
  50% {
    opacity: 0.45;
    transform: scale(0.78);
  }
}
.visually-hidden {
  position: fixed;
  width: 1px;
  height: 1px;
  opacity: 0;
  pointer-events: none;
}
.spin {
  animation: spin 1s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
@keyframes shimmer {
  to {
    opacity: 0.45;
    transform: scaleX(0.92);
  }
}
@media (max-width: 1120px) {
  .extraction-heading {
    align-items: flex-start;
    flex-direction: column;
  }
  .extraction-heading__actions {
    width: 100%;
    margin-left: 0;
    justify-content: flex-start;
    flex-wrap: wrap;
  }
  .product-switcher {
    flex: 1;
  }
  .product-switcher select {
    width: 100%;
  }
  .workflow-graph-content {
    grid-template-columns: 1fr;
  }
  .workflow-node-detail {
    position: static;
    min-height: 260px;
    max-height: none;
    margin: 0 22px 22px;
  }
  .workflow-node-detail__empty {
    min-height: 220px;
  }
}
@media (max-width: 860px) {
  .product-info-layout,
  .result-grid {
    grid-template-columns: 1fr;
  }
}
@media (max-width: 620px) {
  .effect-extraction-node {
    padding: 16px;
  }
  .base-fields {
    grid-template-columns: 1fr;
  }
  .base-fields label.wide {
    grid-column: auto;
  }
  .extraction-heading__title {
    min-width: 0;
  }
  .extraction-heading__actions > button {
    flex: 1;
  }
  .workflow-graph-backdrop {
    padding: 10px;
  }
  .workflow-graph-dialog {
    max-height: calc(100vh - 20px);
    border-radius: 16px;
  }
  .workflow-graph-dialog__header,
  .workflow-graph-canvas,
  .workflow-graph-dialog__footer {
    padding-right: 14px;
    padding-left: 14px;
  }
  .workflow-node-detail {
    margin-right: 14px;
    margin-left: 14px;
  }
  .workflow-graph-parallel {
    padding-top: 0;
    grid-template-columns: 1fr;
  }
  .workflow-graph-parallel::before,
  .workflow-graph-parallel > article::before {
    display: none;
  }
  .workflow-graph-parallel > article + article {
    margin-top: 2px;
  }
}
</style>
