<script setup lang="ts">
import WorkflowExtractionActions from '../../../platform/workflow/components/WorkflowExtractionActions.vue';
import WorkflowExtractionFeedback from '../../../platform/workflow/components/WorkflowExtractionFeedback.vue';
import WorkflowNodeEditActions from '../../../platform/workflow/components/WorkflowNodeEditActions.vue';
import WorkflowExtractionGraphDialog from '../../../platform/workflow/components/WorkflowExtractionGraphDialog.vue';
import WorkflowPageLoading from '../../../platform/workflow/components/WorkflowPageLoading.vue';
import WorkflowInformationField from '../../../platform/workflow/components/WorkflowInformationField.vue';
import WorkflowInformationCard from '../../../platform/workflow/components/WorkflowInformationCard.vue';
import WorkflowSellingPointsEditor from '../../../platform/workflow/components/WorkflowSellingPointsEditor.vue';
import type {
  EffectExtractionNodeDetail,
  EffectExtractionNodeExecution,
  EffectExtractionNodeId,
  EffectExtractionNodeStatus,
  EffectExtractionSemanticNotice,
  EffectExtractionValueOrigin,
  EffectImportMode,
  EffectImportProduct,
} from '@ai-marketing/contracts';
import {
  EFFECT_EXTRACTION_GRAPH_NODES,
  EFFECT_EXTRACTION_RECOMMENDED_SELLING_POINTS,
  EFFECT_IMPORT_MATERIAL_TYPE_LABELS,
} from '@ai-marketing/contracts';
import { WorkflowNodeFooter, WorkflowRunProgress } from '@ai-marketing/ui';
import { AlertCircle, ArrowLeft, FileText, Plus, RefreshCw, Sparkles, X } from '@lucide/vue';
import {
  computed,
  nextTick,
  onActivated,
  onBeforeUnmount,
  onDeactivated,
  onMounted,
  ref,
  watch,
} from 'vue';

import { ApiClientError, isAbortError, isNetworkError } from '../../../api/http-client';
import { requestActionConfirmation } from '../../../shared/composables/action-confirmation';
import { confirmDiscardEffectEdit } from '../shared/effect-edit-session';
import {
  beginEffectNodeEdit,
  cancelEffectNodeEdit,
  getActiveWorkflowRunOverview,
  getWorkflowNodeState,
  publishEffectNodeEdit,
  putWorkflowNodeState,
} from '../../../platform/workflow/api/workflow-working.api';
import {
  cloneExtractionProductState,
  cloneExtractionResult,
  EFFECT_EXTRACTION_STATUS_META,
  isExtractionRunning,
  requestPendingExtractionRun,
  takePendingExtractionRun,
  toExtractionProductState,
  type EffectExtractionProductState,
  type EffectExtractionResult,
} from './effect-info-extraction-state';
import {
  beginEffectExtraction,
  loadEffectExtractionNodeDetail,
  loadEffectExtractionRun,
  loadEffectExtractionWorkspace,
  loadEffectExtractionWorkspaceSnapshot,
  pollEffectExtractionRun,
  saveEffectExtractionResult,
  type EffectExtractionContext,
} from './services/effect-info-extraction.service';
import { validateEffectExtractionResult } from './api/effect-info-extraction.api';
import { extractionProgressMessage } from './effect-info-extraction-progress';

const props = defineProps<{
  projectId: string;
  workflowRunId: string;
  draftId: string;
  mode: EffectImportMode;
  products: EffectImportProduct[];
  temporaryBranch: boolean;
  activeEditNodeId: string | null;
}>();

const emit = defineEmits<{
  back: [];
  next: [];
  workflowRunChange: [];
}>();

const productStates = ref<Record<string, EffectExtractionProductState>>({});
const dismissedSemanticNoticesByProduct = ref<
  Record<string, { resultId: string | null; keys: string[] }>
>({});
const currentProductId = ref('');
const loading = ref(true);
const loadingError = ref('');
const sourceRevision = ref(0);
const pollingErrors = ref<Record<string, string>>({});
const graphDialogOpen = ref(false);
const graphLoading = ref(false);
const validating = ref(false);
const editBusy = ref(false);
const validationMessage = ref('');
const graphError = ref('');
const graphNodesByProduct = ref<Record<string, EffectExtractionNodeExecution[]>>({});
const selectedGraphNodeId = ref<EffectExtractionNodeId | null>(null);
const graphDetail = ref<EffectExtractionNodeDetail | null>(null);
const graphDetailLoading = ref(false);
const graphDetailError = ref('');
const graphTrigger = ref<HTMLButtonElement | null>(null);
let loadGeneration = 0;
let disposed = false;
let nodeActive = true;
let activatedOnce = false;
let workspaceController: AbortController | null = null;
let saveController: AbortController | null = null;
let graphController: AbortController | null = null;
let graphDetailController: AbortController | null = null;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let workspaceRevalidationTimer: ReturnType<typeof setTimeout> | undefined;
const nodeStateRevision = ref(0);
let lastSavedNodeState = '';
const activeRunControllers = new Map<string, { controller: AbortController; runId: string }>();
const transientNetworkMessage =
  '网络连接暂时中断，任务不会因此被标记为失败。恢复连接后可继续查询或重新提炼。';

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
const currentStatusMeta = computed(() =>
  currentState.value
    ? EFFECT_EXTRACTION_STATUS_META[currentState.value.status]
    : EFFECT_EXTRACTION_STATUS_META.NOT_GENERATED,
);
const currentRunning = computed(() => isExtractionRunning(currentState.value));
const editing = computed(() =>
  props.temporaryBranch
    ? props.activeEditNodeId === 'INFORMATION_EXTRACTION'
    : currentState.value?.workingArtifactRevision === null,
);
const imageRecognitionWithoutNewFacts = computed(() => {
  const summary = currentState.value?.imageRecognitionSummary;
  return summary && summary.retainedSuggestionCount === 0 ? summary : null;
});
const queueWaitingTooLong = computed(
  () =>
    currentState.value?.status === 'QUEUED' &&
    Date.now() - new Date(currentState.value.updatedAt).getTime() >= 30_000,
);
const currentProgressLabel = computed(() =>
  extractionProgressMessage(currentState.value, currentGraphNodes.value),
);
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
const graphNodeDescription = (nodeId: EffectExtractionNodeId): string =>
  ({
    LOAD_AND_SNAPSHOT: '汇总本次提炼使用的图片、文档、视频和电商链接',
    DOCUMENT: '读取文档中的产品信息',
    IMAGE: '识别图片中的商品信息',
    COMMERCE: '检查商品链接中的信息',
    FUSION: '合并不同资料中的有效信息',
    SEMANTIC_REFINEMENT: '保留用户事实，只整理图片建议并给出待确认提示',
    NORMALIZATION: '生成可继续编辑的产品信息卡',
  })[nodeId];
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
  visual_style_baseline: '视觉风格基线',
};
const warningSourceLabels: Record<string, string> = {
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
  return {
    ...base,
    summary:
      nodeId === 'FUSION'
        ? '等待合并不同资料中的产品信息'
        : nodeId === 'SEMANTIC_REFINEMENT'
          ? '等待整理含义重复的信息'
          : '等待生成可编辑的产品信息卡',
    fields: [],
    sources: [],
  };
};
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
  sellingPoints: [''],
};
const visibleResult = computed(() => currentState.value?.result ?? emptyExtractionResult);
const baseFieldsReadonly = computed(
  () => !editing.value || !currentState.value?.result || currentRunning.value,
);
const semanticNoticeDismissDisabled = computed(
  () => baseFieldsReadonly.value || currentState.value?.saveState === 'SAVING',
);
type OriginListField = 'sellingPoints';
const shouldShowOrigin = (origin: EffectExtractionValueOrigin): boolean =>
  origin === 'AI_IMAGE_SUGGESTION';
const fieldOrigin = (field: keyof EffectExtractionResult): EffectExtractionValueOrigin =>
  currentState.value?.provenance.fieldOrigins[field] ?? 'USER_FACT';
const fieldSourceNames = (field: keyof EffectExtractionResult): string[] =>
  currentState.value?.provenance.fieldSourceNames?.[field] ?? ['用户资料'];
const itemProvenance = (field: OriginListField, index: number) => {
  const value = visibleResult.value[field][index]?.replace(/\s+/g, ' ').trim();
  const recorded = currentState.value?.provenance.itemOrigins[field] ?? [];
  return recorded.find((item) => item.value.replace(/\s+/g, ' ').trim() === value);
};
const itemOrigin = (field: OriginListField, index: number): EffectExtractionValueOrigin => {
  return itemProvenance(field, index)?.origin ?? 'USER_FACT';
};
const itemSourceNames = (field: OriginListField, index: number): string[] =>
  itemProvenance(field, index)?.sourceNames?.length
    ? (itemProvenance(field, index)?.sourceNames ?? [])
    : ['人工修改'];
const semanticNoticeKey = (
  field: OriginListField,
  value: string,
  notice: EffectExtractionSemanticNotice,
): string =>
  JSON.stringify([
    field,
    value.replace(/\s+/g, ' ').trim(),
    notice.issue,
    notice.suggestedField,
    [...notice.relatedValues].map((value) => value.replace(/\s+/g, ' ').trim()).sort(),
  ]);
const dismissedSemanticNoticeKeys = (): ReadonlySet<string> => {
  const state = currentState.value;
  if (!state) return new Set();
  const dismissed = dismissedSemanticNoticesByProduct.value[state.productId];
  return dismissed?.resultId === state.resultId ? new Set(dismissed.keys) : new Set();
};
const itemSemanticNotices = (
  field: OriginListField,
  index: number,
): EffectExtractionSemanticNotice[] => {
  const dismissed = dismissedSemanticNoticeKeys();
  const value = visibleResult.value[field][index] ?? '';
  return (itemProvenance(field, index)?.semanticNotices ?? []).filter(
    (notice) => !dismissed.has(semanticNoticeKey(field, value, notice)),
  );
};
const recordDismissedSemanticNoticeKeys = (keys: readonly string[]): void => {
  const state = currentState.value;
  if (!state || !keys.length) return;
  const existing = dismissedSemanticNoticesByProduct.value[state.productId];
  const previousKeys = existing?.resultId === state.resultId ? existing.keys : [];
  dismissedSemanticNoticesByProduct.value = {
    ...dismissedSemanticNoticesByProduct.value,
    [state.productId]: {
      resultId: state.resultId,
      keys: [...new Set([...previousKeys, ...keys])].slice(-200),
    },
  };
};
const originSourceLabel = (
  origin: EffectExtractionValueOrigin,
  sourceNames: readonly string[],
): string => {
  if (!shouldShowOrigin(origin)) return '';
  const firstSource = sourceNames[0] ?? '产品图片';
  return `图片识别补充 · ${firstSource}${sourceNames.length > 1 ? ` +${sourceNames.length - 1}` : ''}`;
};
const originSourceTitle = (sourceNames: readonly string[]): string =>
  `来源：${sourceNames.join('、') || '用户资料'}`;
const currentActionLabel = computed(() => {
  if (!currentState.value) return '开始 AI 提取';
  if (isExtractionRunning(currentState.value)) return 'AI 提取中…';
  if (currentState.value.status === 'NOT_GENERATED') return '开始 AI 提取';
  return '重新 AI 提取';
});

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
  clearTimeout(workspaceRevalidationTimer);
  workspaceRevalidationTimer = undefined;
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
  dismissedSemanticNotices?: Record<string, { resultId: string | null; keys: string[] }>;
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
  dismissedSemanticNotices: Object.fromEntries(
    Object.entries(dismissedSemanticNoticesByProduct.value)
      .filter(
        ([productId, dismissed]) =>
          dismissed.keys.length > 0 &&
          productStates.value[productId]?.resultId === dismissed.resultId,
      )
      .map(([productId, dismissed]) => [
        productId,
        { resultId: dismissed.resultId, keys: [...new Set(dismissed.keys)].slice(-200) },
      ]),
  ),
});

const applyNodeState = (value: unknown): void => {
  if (!value || typeof value !== 'object') return;
  const draft = value as ExtractionNodeDraft;
  dismissedSemanticNoticesByProduct.value = Object.fromEntries(
    Object.entries(draft.dismissedSemanticNotices ?? {})
      .filter(
        ([productId, dismissed]) =>
          dismissed?.resultId === productStates.value[productId]?.resultId &&
          Array.isArray(dismissed.keys),
      )
      .map(([productId, dismissed]) => [
        productId,
        {
          resultId: dismissed.resultId,
          keys: [...new Set(dismissed.keys.filter((key) => typeof key === 'string'))].slice(-200),
        },
      ]),
  );
  const products = draft.products;
  if (!products) return;
  for (const [productId, saved] of Object.entries(products)) {
    const current = productStates.value[productId];
    if (
      !current ||
      !saved?.result ||
      !Array.isArray(saved.result.sellingPoints) ||
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

const persistNodeState = async (keepalive = false, saveResult = true): Promise<boolean> => {
  if (!props.projectId || !props.workflowRunId) return true;
  const productId = currentProductId.value;
  const current = productId ? productStates.value[productId] : null;
  if (saveResult && current && isExtractionRunning(current)) return true;
  const savingResultId = current?.resultId ?? null;
  const savingResultRevision = current?.resultRevision ?? null;
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
    if (saveResult && current?.result && current.resultId && current.resultRevision !== null) {
      const saved = await saveEffectExtractionResult(
        props.projectId,
        current.resultId,
        current.resultRevision,
        current.result,
        controller.signal,
      );
      const latest = productStates.value[productId];
      if (
        !latest ||
        latest.resultId !== savingResultId ||
        latest.resultRevision !== savingResultRevision
      )
        return true;
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
      clearTimeout(saveTimer);
      saveTimer = undefined;
      saveController?.abort();
      saveController = null;
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
        [productId]: isNetworkError(error)
          ? '网络连接暂时中断，任务仍在后台运行。恢复连接后请继续查询。'
          : error instanceof Error
            ? error.message
            : '任务进度查询失败',
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

const loadWorkspace = async (showLoading = true): Promise<void> => {
  const generation = ++loadGeneration;
  stopAllRequests();
  closeGraphDialog(false);
  graphNodesByProduct.value = {};
  const controller = new AbortController();
  workspaceController = controller;
  if (showLoading || !Object.keys(productStates.value).length) loading.value = true;
  loadingError.value = '';
  try {
    const [snapshot, overview] = await Promise.all([
      loadEffectExtractionWorkspaceSnapshot(context.value, controller.signal),
      getActiveWorkflowRunOverview(props.projectId, 'EFFECT', 'EFFECT', controller.signal),
    ]);
    const workspace = snapshot.data;
    if (disposed || controller.signal.aborted || generation !== loadGeneration) return;
    applyWorkspace(workspace, true);
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
      dismissedSemanticNoticesByProduct.value = {};
      lastSavedNodeState = JSON.stringify(nodeStatePayload());
    }
    if (!props.products.some((product) => product.id === currentProductId.value)) {
      currentProductId.value = props.products[0]?.id ?? '';
    }
    resumeWorkspaceRuns();
    resumePendingExtraction();
    if (snapshot.prefetched) {
      workspaceRevalidationTimer = setTimeout(() => {
        workspaceRevalidationTimer = undefined;
        if (nodeActive && generation === loadGeneration) void loadWorkspace(false);
      }, 600);
    }
  } catch (error) {
    if (isAbortError(error) || disposed || generation !== loadGeneration) return;
    loadingError.value = error instanceof Error ? error.message : '提炼工作区加载失败';
  } finally {
    if (!disposed && generation === loadGeneration) loading.value = false;
    if (workspaceController === controller) workspaceController = null;
  }
};

const runCurrentExtraction = async (options: { skipConfirm?: boolean } = {}): Promise<void> => {
  const product = currentProduct.value;
  const state = currentState.value;
  if (!product || !state || isExtractionRunning(state) || editBusy.value) return;
  if (
    !options.skipConfirm &&
    state.status !== 'NOT_GENERATED' &&
    !(await requestActionConfirmation({
      eyebrow: '重新提炼',
      title: `重新提炼“${product.name || '当前商品'}”？`,
      description:
        '系统会重新读取已确认资料并生成新的信息卡结果，当前结果中的人工调整可能需要重新核对。',
      confirmLabel: '确认重新提炼',
      tone: 'warning',
    }))
  )
    return;
  if (!(await flushPendingEdits())) return;
  if (!(await ensureExtractionEdit(product.id))) return;
  clearTimeout(saveTimer);
  saveTimer = undefined;
  saveController?.abort();
  saveController = null;
  const previousState = cloneExtractionProductState(state);
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
    const run = await beginEffectExtraction(context.value, product.id, sourceRevision.value, {
      refreshImageRecognition: Boolean(state.runId || state.resultId),
      signal: controller.signal,
    });
    if (disposed || controller.signal.aborted) return;
    patchFromRun(product.id, run);
    void monitorProductRun(product.id, run.id, controller);
  } catch (error) {
    if (isAbortError(error) || disposed) return;
    if (error instanceof ApiClientError && error.status === 409) {
      await loadWorkspace();
      return;
    }
    if (isNetworkError(error)) {
      let monitoringRecoveredRun = false;
      try {
        await refreshProductFromWorkspace(product.id, controller.signal);
        const recovered = productStates.value[product.id];
        if (recovered && isExtractionRunning(recovered) && recovered.runId) {
          monitoringRecoveredRun = true;
          void monitorProductRun(product.id, recovered.runId, controller);
        } else {
          pollingErrors.value = {
            ...pollingErrors.value,
            [product.id]: transientNetworkMessage,
          };
        }
      } catch (recoveryError) {
        if (isAbortError(recoveryError) || disposed) return;
        replaceState(previousState);
        pollingErrors.value = {
          ...pollingErrors.value,
          [product.id]: transientNetworkMessage,
        };
      }
      if (
        !monitoringRecoveredRun &&
        activeRunControllers.get(product.id)?.controller === controller
      ) {
        activeRunControllers.delete(product.id);
      }
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

const clearFieldSemanticNotices = (field: OriginListField): void => {
  const items = currentState.value?.provenance.itemOrigins[field];
  if (!items) return;
  const keys: string[] = [];
  for (const item of items) {
    for (const notice of item.semanticNotices ?? [])
      keys.push(semanticNoticeKey(field, item.value, notice));
    delete item.semanticNotices;
  }
  recordDismissedSemanticNoticeKeys(keys);
};

const dismissSemanticNotice = (
  field: OriginListField,
  index: number,
  notice: EffectExtractionSemanticNotice,
): void => {
  if (semanticNoticeDismissDisabled.value) return;
  recordDismissedSemanticNoticeKeys([
    semanticNoticeKey(field, visibleResult.value[field][index] ?? '', notice),
  ]);
  const state = currentState.value;
  if (state?.saveState === 'DIRTY' || state?.saveState === 'SAVE_FAILED') {
    markDirty();
    return;
  }
  void persistNodeState(false, false);
};

const markListFieldDirty = (field: OriginListField): void => {
  clearFieldSemanticNotices(field);
  markDirty();
};

const markFieldDirty = (field: keyof EffectExtractionResult): void => {
  if (currentState.value) {
    currentState.value.provenance.fieldOrigins[field] = 'USER_FACT';
    currentState.value.provenance.fieldSourceNames[field] = ['人工修改'];
  }
  markDirty();
};

const productBaseValue = (field: ProductBaseField): string => {
  return currentState.value?.result?.[field] ?? '';
};

const updateProductBaseField = (field: ProductBaseField, value: string): void => {
  const result = currentState.value?.result;
  if (!result) return;
  result[field] = value;
  markFieldDirty(field);
};

const addSellingPoint = (): void => {
  const result = currentState.value?.result;
  if (!result) return;
  result.sellingPoints.push('');
  markListFieldDirty('sellingPoints');
};

const updateSellingPoint = (index: number, value: string): void => {
  const result = currentState.value?.result;
  if (!result || baseFieldsReadonly.value || index < 0 || index >= result.sellingPoints.length)
    return;
  result.sellingPoints[index] = value;
  markListFieldDirty('sellingPoints');
};

const summarizedRemovalValue = (value: string): string => {
  const normalized = value.trim() || '空白条目';
  return normalized.length > 36 ? `${normalized.slice(0, 36)}…` : normalized;
};

const confirmInformationRemoval = (label: string, value: string): Promise<boolean> =>
  requestActionConfirmation({
    eyebrow: `删除${label}`,
    title: `删除“${summarizedRemovalValue(value)}”？`,
    description: `该${label}会从当前信息卡草稿中移除，保存后下游需要基于更新后的信息重新校验。`,
    confirmLabel: '确认删除',
    tone: 'danger',
  });

const removeSellingPoint = async (index: number): Promise<void> => {
  const result = currentState.value?.result;
  const value = result?.sellingPoints[index];
  if (!result || value === undefined) return;
  if (value.trim() && !(await confirmInformationRemoval('卖点', value))) return;
  result.sellingPoints.splice(index, 1);
  markListFieldDirty('sellingPoints');
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
    if (!response.data.valid) {
      validationMessage.value = response.data.issues.map((issue) => issue.message).join('；');
      return;
    }
    if (!response.data.allProductsValidated) {
      validationMessage.value = '当前产品已保存，请继续保存其他产品版本';
      return;
    }
    const published = await publishEffectNodeEdit(
      props.projectId,
      props.workflowRunId,
      'INFORMATION_EXTRACTION',
    );
    validationMessage.value = published.data.createdBranch
      ? '信息卡已保存为新版本'
      : artifact?.unchanged
        ? '内容未变化，保持当前版本'
        : '信息卡版本已保存';
    emit('workflowRunChange');
  } catch (error) {
    validationMessage.value = error instanceof Error ? error.message : '保存版本失败';
  } finally {
    validating.value = false;
  }
};

/** AI 提炼只能在隔离编辑态里跑：已确认版本后先建隔离分支，重挂载后由待运行意图接着开跑。 */
const ensureExtractionEdit = async (productId: string): Promise<boolean> => {
  if (editing.value) return true;
  editBusy.value = true;
  validationMessage.value = '';
  try {
    const result = await beginEffectNodeEdit(
      props.projectId,
      props.workflowRunId,
      'INFORMATION_EXTRACTION',
    );
    if (result.data.run.id === props.workflowRunId) return true;
    // 隔离 Run 里的商品是克隆出来的新 ID，重挂载后必须按新 ID 找回同一个商品。
    requestPendingExtractionRun(props.projectId, result.data.productIdMap[productId] ?? productId);
    emit('workflowRunChange');
    return false;
  } catch (error) {
    validationMessage.value =
      error instanceof ApiClientError && error.status === 409
        ? '请先保存或取消当前编辑，再重新提炼'
        : error instanceof Error
          ? error.message
          : '进入编辑失败';
    return false;
  } finally {
    editBusy.value = false;
  }
};

/** 隔离编辑分支已就位，接着跑那次被重挂载打断的提炼。 */
const resumePendingExtraction = (): void => {
  if (!editing.value) return;
  const productId = takePendingExtractionRun(props.projectId);
  if (!productId || !props.products.some((product) => product.id === productId)) return;
  currentProductId.value = productId;
  void runCurrentExtraction({ skipConfirm: true });
};

const beginExtractionEdit = async (): Promise<void> => {
  if (editBusy.value || editing.value || currentRunning.value) return;
  editBusy.value = true;
  validationMessage.value = '';
  try {
    await beginEffectNodeEdit(props.projectId, props.workflowRunId, 'INFORMATION_EXTRACTION');
    emit('workflowRunChange');
  } catch (error) {
    validationMessage.value = error instanceof Error ? error.message : '进入编辑失败';
  } finally {
    editBusy.value = false;
  }
};

const cancelExtractionEdit = async (): Promise<void> => {
  if (
    !props.temporaryBranch ||
    props.activeEditNodeId !== 'INFORMATION_EXTRACTION' ||
    editBusy.value
  )
    return;
  if (!(await confirmDiscardEffectEdit())) return;
  if (
    !props.temporaryBranch ||
    props.activeEditNodeId !== 'INFORMATION_EXTRACTION' ||
    editBusy.value
  )
    return;
  editBusy.value = true;
  validationMessage.value = '';
  try {
    await cancelEffectNodeEdit(props.projectId, props.workflowRunId, 'INFORMATION_EXTRACTION');
    emit('workflowRunChange');
  } catch (error) {
    validationMessage.value = error instanceof Error ? error.message : '取消编辑失败';
  } finally {
    editBusy.value = false;
  }
};

const loadLatestResult = (): void => {
  void loadWorkspace();
};

watch(
  [
    () => props.projectId,
    () => props.workflowRunId,
    () => props.draftId,
    () => props.mode,
    sourceSignature,
  ],
  () => {
    if (nodeActive) void loadWorkspace();
  },
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

onActivated(() => {
  nodeActive = true;
  if (!activatedOnce) {
    activatedOnce = true;
    return;
  }
  void loadWorkspace(false);
});

onDeactivated(() => {
  nodeActive = false;
  loadGeneration += 1;
  stopAllRequests();
});

defineExpose({ flushPendingEdits });

onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', warnBeforeUnload);
  window.removeEventListener('keydown', handlePageKeydown);
  clearTimeout(saveTimer);
  disposed = true;
  nodeActive = false;
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
    <WorkflowPageLoading
      v-if="loading"
      icon="extraction"
      title="正在恢复 AI 信息提炼"
      description="正在读取当前项目的产品资料和提炼草稿…"
    />
    <section v-else-if="loadingError" class="extraction-page-state error" role="alert">
      <AlertCircle :size="31" />
      <h2>AI 信息提炼加载失败</h2>
      <p>{{ loadingError }}</p>
      <button type="button" @click="loadWorkspace()"><RefreshCw :size="14" />重新加载</button>
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
          <WorkflowNodeEditActions
            :editing="editing"
            :temporary="temporaryBranch"
            :disabled="editBusy || validating || currentRunning"
            :save-disabled="
              currentState.status !== 'COMPLETED' ||
              !currentState.result ||
              currentState.saveState === 'SAVING'
            "
            :saving="validating"
            @begin="beginExtractionEdit"
            @cancel="cancelExtractionEdit"
            @save="validateCurrentResult"
          />
          <WorkflowExtractionActions
            :disabled="currentRunning || editBusy || validating"
            :running="currentRunning || editBusy"
            :reextract="currentState.status !== 'NOT_GENERATED'"
            :label="currentActionLabel"
            @extract="runCurrentExtraction()"
            @details="openGraphDialog"
          />
        </div>
      </header>

      <WorkflowExtractionFeedback
        v-if="currentState.status === 'FAILED'"
        title="本次 AI 提炼失败"
        :message="currentState.errorMessage || '请重试'"
        action="重新提炼"
        :disabled="editBusy || currentRunning"
        @action="runCurrentExtraction()"
      />
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
          <p>当前结果仍可查看；进入编辑并重新提炼后才能进入下一节点。</p>
        </div>
        <button
          type="button"
          :disabled="editBusy || currentRunning"
          @click="runCurrentExtraction()"
        >
          <RefreshCw :size="13" />更新提炼结果
        </button>
      </div>

      <WorkflowRunProgress
        v-if="currentRunning"
        :progress="currentState.progress"
        :summary="currentProgressLabel"
        @show-details="openGraphDialog"
      />

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

      <div v-if="imageRecognitionWithoutNewFacts" class="state-alert information" role="status">
        <AlertCircle :size="17" />
        <div>
          <strong>图片识别已完成，本次没有新增信息</strong>
          <p>
            已分析 {{ imageRecognitionWithoutNewFacts.processedImageCount }} 张图片，产生
            {{ imageRecognitionWithoutNewFacts.candidateSuggestionCount }}
            条候选信息；经与已有资料逐条核对，没有需要新增到信息卡的图片补充。
          </p>
        </div>
      </div>

      <div
        class="result-grid"
        :class="{
          muted: currentState.status === 'FAILED',
          processing: currentRunning,
        }"
        :aria-busy="currentRunning"
      >
        <WorkflowInformationCard
          class="content-block product-base-card"
          :class="{ processing: currentRunning }"
          :aria-busy="currentRunning"
        >
          <h3>产品基础层</h3>
          <div class="base-fields">
            <WorkflowInformationField
              label="品类"
              :model-value="productBaseValue('productCategory')"
              :readonly="baseFieldsReadonly"
              @update:model-value="updateProductBaseField('productCategory', $event)"
            >
              <template #source
                ><em
                  :data-origin="fieldOrigin('productCategory')"
                  :title="originSourceTitle(fieldSourceNames('productCategory'))"
                  >{{
                    originSourceLabel(
                      fieldOrigin('productCategory'),
                      fieldSourceNames('productCategory'),
                    )
                  }}</em
                ></template
              >
            </WorkflowInformationField>
            <WorkflowInformationField
              label="产品名称"
              :model-value="productBaseValue('productName')"
              :readonly="baseFieldsReadonly"
              @update:model-value="updateProductBaseField('productName', $event)"
            >
              <template #source
                ><em
                  :data-origin="fieldOrigin('productName')"
                  :title="originSourceTitle(fieldSourceNames('productName'))"
                  >{{
                    originSourceLabel(fieldOrigin('productName'), fieldSourceNames('productName'))
                  }}</em
                ></template
              >
            </WorkflowInformationField>
            <WorkflowInformationField
              label="核心规格"
              :model-value="productBaseValue('coreSpecification')"
              :readonly="baseFieldsReadonly"
              @update:model-value="updateProductBaseField('coreSpecification', $event)"
            >
              <template #source
                ><em
                  :data-origin="fieldOrigin('coreSpecification')"
                  :title="originSourceTitle(fieldSourceNames('coreSpecification'))"
                  >{{
                    originSourceLabel(
                      fieldOrigin('coreSpecification'),
                      fieldSourceNames('coreSpecification'),
                    )
                  }}</em
                ></template
              >
            </WorkflowInformationField>
            <WorkflowInformationField
              label="价格带"
              :model-value="productBaseValue('priceRange')"
              :readonly="baseFieldsReadonly"
              @update:model-value="updateProductBaseField('priceRange', $event)"
            >
              <template #source
                ><em
                  :data-origin="fieldOrigin('priceRange')"
                  :title="originSourceTitle(fieldSourceNames('priceRange'))"
                  >{{
                    originSourceLabel(fieldOrigin('priceRange'), fieldSourceNames('priceRange'))
                  }}</em
                ></template
              >
            </WorkflowInformationField>
            <WorkflowInformationField
              class="wide"
              multiline
              label="核心外观特征"
              :model-value="productBaseValue('visualFeatures')"
              :readonly="baseFieldsReadonly"
              @update:model-value="updateProductBaseField('visualFeatures', $event)"
            >
              <template #source
                ><em
                  :data-origin="fieldOrigin('visualFeatures')"
                  :title="originSourceTitle(fieldSourceNames('visualFeatures'))"
                  >{{
                    originSourceLabel(
                      fieldOrigin('visualFeatures'),
                      fieldSourceNames('visualFeatures'),
                    )
                  }}</em
                ></template
              >
            </WorkflowInformationField>
          </div>
        </WorkflowInformationCard>
        <WorkflowInformationCard class="content-block selling-layer-card">
          <div class="block-heading compact">
            <div>
              <div class="selling-heading-row">
                <h3>卖点</h3>
                <span
                  class="selling-point-count"
                  :class="{
                    'selling-point-count--over':
                      visibleResult.sellingPoints.length >
                      EFFECT_EXTRACTION_RECOMMENDED_SELLING_POINTS,
                  }"
                >
                  <span class="selling-point-count__icon"><Sparkles :size="12" /></span>
                  <span class="selling-point-count__value">
                    {{ visibleResult.sellingPoints.length }} 条卖点
                  </span>
                  <span class="selling-point-count__divider" aria-hidden="true"></span>
                  <span class="selling-point-count__hint">
                    {{
                      visibleResult.sellingPoints.length >
                      EFFECT_EXTRACTION_RECOMMENDED_SELLING_POINTS
                        ? `建议精简至 ${EFFECT_EXTRACTION_RECOMMENDED_SELLING_POINTS} 条以内`
                        : `建议 ${EFFECT_EXTRACTION_RECOMMENDED_SELLING_POINTS} 条以内`
                    }}
                  </span>
                </span>
              </div>
              <p>这些卖点可用于后续视频创作，您可以按需修改、添加或删除。</p>
            </div>
            <button
              class="selling-add-button"
              type="button"
              :disabled="baseFieldsReadonly"
              title="添加一个卖点"
              @click="addSellingPoint"
            >
              <Plus :size="13" />添加
            </button>
          </div>
          <WorkflowSellingPointsEditor
            :items="visibleResult.sellingPoints"
            :readonly="baseFieldsReadonly"
            :show-heading="false"
            @update-item="updateSellingPoint"
            @remove="removeSellingPoint"
          >
            <template #source="{ index }">
              <em
                class="origin-chip"
                :data-origin="itemOrigin('sellingPoints', index)"
                :title="originSourceTitle(itemSourceNames('sellingPoints', index))"
                >{{
                  originSourceLabel(
                    itemOrigin('sellingPoints', index),
                    itemSourceNames('sellingPoints', index),
                  )
                }}</em
              >
            </template>
            <template #notice="{ index }">
              <p
                v-for="notice in itemSemanticNotices('sellingPoints', index)"
                :key="`${notice.issue}-${notice.message}`"
                class="semantic-fact-notice"
              >
                <AlertCircle :size="13" />
                <span>{{ notice.message }}</span>
                <button
                  type="button"
                  class="semantic-fact-notice__dismiss"
                  aria-label="关闭这条建议"
                  title="关闭这条建议"
                  :disabled="semanticNoticeDismissDisabled"
                  @click="dismissSemanticNotice('sellingPoints', index, notice)"
                >
                  <X :size="12" />
                </button>
              </p>
            </template>
          </WorkflowSellingPointsEditor>
        </WorkflowInformationCard>
      </div>

      <p v-if="validationMessage" class="validation-message" aria-live="polite">
        {{ validationMessage }}
      </p>

      <WorkflowNodeFooter
        back-label="上一步：资料导入"
        :show-validate="false"
        :next-disabled="validating || editBusy"
        next-label="下一步：素材 Prompt"
        @back="emit('back')"
        @next="emit('next')"
      />

      <WorkflowExtractionGraphDialog
        :open="graphDialogOpen"
        title="AI 信息提炼工作流"
        :subtitle="`${currentProduct.name} · ${currentStatusMeta.label} · ${currentState.progress}%`"
        :nodes="
          EFFECT_EXTRACTION_GRAPH_NODES.map((node) => ({
            ...node,
            description: graphNodeDescription(node.id),
          }))
        "
        :executions="currentGraphNodes"
        :selected-node-id="selectedGraphNodeId"
        :detail="graphDetail"
        :loading="graphLoading"
        :error="graphError"
        :detail-loading="graphDetailLoading"
        :detail-error="graphDetailError"
        @close="closeGraphDialog()"
        @select="selectGraphNode($event as EffectExtractionNodeId)"
        @refresh="refreshGraphDetail"
        @retry="openGraphDialog"
      />
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
.extraction-heading__actions .secondary-button {
  min-width: 139px;
}
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
.state-alert.information {
  color: #35658a;
  background: #f1f8fc;
  border: 1px solid #cfe5f2;
}
.content-block,
.inherit-card {
  padding: 20px;
  background: #fff;
  border: 1px solid #f0e2db;
  border-radius: 20px;
}
.product-base-card {
  min-height: 0;
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
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  line-height: 22px;
}
.base-fields em,
.field-label em {
  display: inline-flex;
  width: fit-content;
  padding: 2px 7px;
  align-items: center;
  color: #16795d;
  background: #eaf8f2;
  border-radius: 999px;
  font-size: 10px;
  font-style: normal;
  font-weight: 750;
  line-height: 18px;
  white-space: nowrap;
}
.base-fields em[data-origin='AI_IMAGE_SUGGESTION'],
.field-label em[data-origin='AI_IMAGE_SUGGESTION'] {
  color: #8057c7;
  background: #f2edff;
}
.base-fields em[data-origin='USER_FACT'],
.field-label em[data-origin='USER_FACT'] {
  display: none;
}
.field-label {
  display: grid;
  gap: 8px;
  color: #596278;
  font-size: 14px;
  font-weight: 650;
}
.field-label > span {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  line-height: 22px;
}
.base-fields .wide {
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
.product-base-card.processing .base-fields :deep(input),
.product-base-card.processing .base-fields :deep(textarea) {
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
  align-items: start;
  grid-template-columns: minmax(0, 1fr);
  grid-template-areas:
    'base'
    'selling';
  gap: 18px;
}
.product-base-card {
  grid-area: base;
}
.selling-layer-card {
  grid-area: selling;
}
.result-grid .content-block {
  min-height: 0;
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
.selling-heading-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.selling-point-count {
  display: inline-flex;
  min-height: 28px;
  padding: 3px 10px 3px 6px;
  align-items: center;
  gap: 7px;
  color: #5c7193;
  background: linear-gradient(135deg, #f8faff 0%, #eef4ff 100%);
  border: 1px solid #d9e5fb;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 650;
  line-height: 1;
  box-shadow: 0 3px 10px rgba(51, 101, 202, 0.06);
}
.selling-point-count__icon {
  display: inline-flex;
  width: 18px;
  height: 18px;
  align-items: center;
  justify-content: center;
  color: #3267d6;
  background: #e4edff;
  border-radius: 6px;
}
.selling-point-count__value {
  color: #29436d;
  font-weight: 800;
}
.selling-point-count__divider {
  width: 1px;
  height: 12px;
  background: #cfdbef;
}
.selling-point-count--over {
  color: #94600b;
  background: linear-gradient(135deg, #fffcf4 0%, #fff3d8 100%);
  border-color: #f1d18c;
  box-shadow: 0 3px 10px rgba(193, 126, 17, 0.08);
}
.selling-point-count--over .selling-point-count__icon {
  color: #ad6e05;
  background: #ffe8b5;
}
.selling-point-count--over .selling-point-count__value {
  color: #7f520a;
}
.selling-point-count--over .selling-point-count__divider {
  background: #e8c87f;
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
.selling-subheading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 10px;
  color: #304664;
  font-size: 13px;
}
.selling-subheading--first {
  margin-top: 0;
  margin-bottom: 10px;
}
.selling-subheading small {
  margin-left: 4px;
  color: #8a98ad;
  font-size: 11px;
  font-weight: 400;
}
.selling-subheading button {
  display: inline-flex;
  height: 30px;
  min-height: 30px;
  padding: 0 10px;
  align-items: center;
  gap: 4px;
  color: #2f6df6;
  background: #f5f8ff;
  border: 1px solid #d6e3ff;
  border-radius: 9px;
  font-size: 13px;
  font-weight: 400;
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
@media (max-width: 620px) {
  .effect-extraction-node {
    padding: 16px;
  }
  .base-fields {
    grid-template-columns: 1fr;
  }
  .base-fields .wide {
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

<style scoped src="../../../platform/workflow/components/workflow-extraction-heading.css"></style>
