<script setup lang="ts">
import type {
  EffectImportProduct,
  EffectPromptFragmentType,
  EffectSegmentRenderBatch,
  EffectSegmentRenderSettings,
  SeedanceRatio,
  SeedanceResolution,
} from '@ai-marketing/contracts';
import {
  DEFAULT_EFFECT_SEGMENT_RENDER_SETTINGS,
  EFFECT_PROMPT_FRAGMENT_TYPE_LABELS,
  EFFECT_PROMPT_FRAGMENT_TYPES,
} from '@ai-marketing/contracts';
import { WorkflowNodeDraftBar, WorkflowNodeFooter } from '@ai-marketing/ui';
import {
  AlertCircle,
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  FileVideo2,
  FolderInput,
  LoaderCircle,
  Play,
  RefreshCw,
  Search,
  Settings2,
  Sparkles,
  Trash2,
  Upload,
  X,
} from '@lucide/vue';
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';

import { requestActionConfirmation } from '../../../shared/composables/action-confirmation';
import { EFFECT_PROMPT_PAGE_SIZE_OPTIONS } from '../prompt-generation/effect-prompt-generation-state';
import EffectUpwardCreatableSelect from '../source-import/components/EffectUpwardCreatableSelect.vue';
import {
  decideEffectSegmentRenderRepair,
  getEffectSegmentRenderBatch,
  getEffectSegmentRenderTaskContent,
  getEffectSegmentRenderWorkspace,
  regenerateEffectSegmentRenderTasks,
  saveEffectSegmentRenderSettings,
  startEffectSegmentRenderBatch,
  startEffectSegmentRenderRepair,
  validateEffectSegmentRenderBatch,
} from './api/effect-segment-render.api';
import {
  EFFECT_SEGMENT_RENDER_PAGE_SIZE,
  effectSegmentRenderPage,
  effectSegmentRenderPageCount,
  effectSegmentRenderSummary,
  effectSegmentRenderWorkspaceFromApi,
  effectSegmentRenderWorkspaceWithBatch,
  filterEffectSegmentRenderTasks,
  isEffectSegmentRenderExportable,
  isEffectSegmentRenderBusy,
  type EffectSegmentRenderStatus,
  type EffectSegmentRenderTask,
  type EffectSegmentRenderWorkspace,
} from './effect-segment-render-state';

const props = defineProps<{
  projectId: string;
  workflowRunId: string;
  products: EffectImportProduct[];
}>();

const emit = defineEmits<{ back: []; next: [] }>();

type PageStatus = 'empty' | 'error' | 'loading' | 'success';
type Operation = 'batch' | 'delete' | 'export' | 'import' | 'repair' | 'retry' | 'settings' | null;
type FragmentFilter = 'ABNORMAL' | 'ALL' | EffectPromptFragmentType;
type TransferPanel = 'export' | 'import' | null;
type ExportScope = 'ALL_COMPLETED' | 'FILTERED' | 'SELECTED';
type Notice = { kind: 'error' | 'success' | 'warning'; text: string };
type EffectSegmentRenderExportFormat = 'FAILURE_CSV' | 'MANIFEST_JSON' | 'VIDEO_PACKAGE';
type EffectSegmentRenderImportMatch = {
  id: string;
  fileName: string;
  size: number;
  promptCode: string | null;
  status: 'AUTO_ASSIGNED' | 'CONFLICT' | 'MATCHED' | 'UNMATCHED';
};

const pageStatus = ref<PageStatus>('loading');
const loadError = ref('');
const workspace = ref<EffectSegmentRenderWorkspace | null>(null);
const currentProductId = ref('');
const keyword = ref('');
const fragmentFilter = ref<FragmentFilter>('ALL');
const includeCompatiblePurposes = ref(false);
const page = ref(1);
const pageSize = ref<number>(EFFECT_SEGMENT_RENDER_PAGE_SIZE);
const operation = ref<Operation>(null);
const validated = ref(false);
const notice = ref<Notice | null>(null);
const transferPanel = ref<TransferPanel>(null);
const selectionMode = ref(false);
const selectedTaskIds = ref<Set<string>>(new Set());
const importFiles = ref<File[]>([]);
const importMatches = ref<EffectSegmentRenderImportMatch[]>([]);
const importInput = ref<HTMLInputElement | null>(null);
const transferCloseButton = ref<HTMLButtonElement | null>(null);
const exportScope = ref<ExportScope>('ALL_COMPLETED');
const exportFormats = ref<EffectSegmentRenderExportFormat[]>(['VIDEO_PACKAGE', 'MANIFEST_JSON']);
const renderSettings = ref<EffectSegmentRenderSettings>({
  ...DEFAULT_EFFECT_SEGMENT_RENDER_SETTINGS,
});
const renderSettingsRevision = ref<number | null>(null);

type RenderModelOption = {
  value: EffectSegmentRenderSettings['capabilityKey'];
  label: string;
  ratios: readonly SeedanceRatio[];
  resolutions: readonly SeedanceResolution[];
  defaultRatio: SeedanceRatio;
  defaultResolution: SeedanceResolution;
};

const supportedRenderRatios = [
  '16:9',
  '4:3',
  '1:1',
  '3:4',
  '9:16',
  '21:9',
  'adaptive',
] as const satisfies readonly SeedanceRatio[];

const capabilityOptions = [
  {
    value: 'SEEDANCE_1_5_PRO',
    label: 'Doubao-Seedance-2.5',
    ratios: supportedRenderRatios,
    resolutions: ['480p', '720p'],
    defaultRatio: 'adaptive',
    defaultResolution: '720p',
  },
  {
    value: 'SEEDANCE_2_0',
    label: 'Doubao-Seedance-2.0',
    ratios: supportedRenderRatios,
    resolutions: ['480p', '720p', '1080p'],
    defaultRatio: 'adaptive',
    defaultResolution: '720p',
  },
  {
    value: 'SEEDANCE_1_0',
    label: 'Doubao-Seedance-2.0-mini',
    ratios: supportedRenderRatios,
    resolutions: ['480p', '720p'],
    defaultRatio: 'adaptive',
    defaultResolution: '720p',
  },
  {
    value: 'SEEDANCE_2_0_FAST',
    label: 'Doubao-Seedance-2.0-fast',
    ratios: supportedRenderRatios,
    resolutions: ['480p', '720p'],
    defaultRatio: 'adaptive',
    defaultResolution: '720p',
  },
] as const satisfies readonly RenderModelOption[];

const selectedCapability = computed(
  () =>
    capabilityOptions.find(({ value }) => value === renderSettings.value.capabilityKey) ??
    capabilityOptions[1],
);
const ratioOptions = computed(() =>
  selectedCapability.value.ratios.map((value) => ({
    value,
    label: value === 'adaptive' ? '自适应' : value,
  })),
);
const resolutionOptions = computed(() =>
  selectedCapability.value.resolutions.map((value) => ({
    value,
    label: value,
  })),
);

const previewTask = ref<EffectSegmentRenderTask | null>(null);
const previewVariant = ref<'ACTIVE' | 'REPAIR'>('ACTIVE');
const previewUrl = ref('');
const previewLoading = ref(false);
const previewError = ref('');
const promptTask = ref<EffectSegmentRenderTask | null>(null);
const repairTask = ref<EffectSegmentRenderTask | null>(null);
const repairStartSeconds = ref(0);
const repairEndSeconds = ref(1);
const repairInstruction = ref('');
const previewCloseButton = ref<HTMLButtonElement | null>(null);
const promptCloseButton = ref<HTMLButtonElement | null>(null);
const repairCloseButton = ref<HTMLButtonElement | null>(null);

let dialogTrigger: HTMLElement | null = null;
let loadController: AbortController | null = null;
let operationController: AbortController | null = null;
let previewController: AbortController | null = null;
let pollController: AbortController | null = null;
let pollTimer: ReturnType<typeof setTimeout> | undefined;
let loadGeneration = 0;
let noticeTimer: ReturnType<typeof setTimeout> | undefined;

const activeProducts = computed(() =>
  props.products.filter((product) => product.status === 'ACTIVE'),
);
const activeProductSignature = computed(() =>
  activeProducts.value.map((product) => `${product.id}:${product.name}`).join('|'),
);
const currentProduct = computed(
  () => activeProducts.value.find((product) => product.id === currentProductId.value) ?? null,
);
const tasks = computed(() => workspace.value?.tasks ?? []);
const summary = computed(() => effectSegmentRenderSummary(tasks.value));
const promptTasks = computed(() => tasks.value.filter((task) => task.source === 'PROMPT'));
const completedTasks = computed(() => tasks.value.filter(isEffectSegmentRenderExportable));
const hasBatch = computed(
  () => Boolean(workspace.value) && workspace.value?.batchStatus !== 'NOT_STARTED',
);
const batchActive = computed(
  () => workspace.value?.batchStatus === 'QUEUED' || workspace.value?.batchStatus === 'RUNNING',
);
const promptCount = computed(() => workspace.value?.promptCount ?? 0);
const missingPromptCount = computed(() =>
  Math.max(0, promptCount.value - promptTasks.value.length),
);
const importedCount = computed(() => 0);
const remainingPromptCount = computed(() => Math.max(0, promptCount.value - importedCount.value));
const isPurposeFilter = (value: FragmentFilter): value is EffectPromptFragmentType =>
  EFFECT_PROMPT_FRAGMENT_TYPES.includes(value as EffectPromptFragmentType);
const filteredTasks = computed(() =>
  filterEffectSegmentRenderTasks(tasks.value, keyword.value).filter((task) => {
    if (fragmentFilter.value === 'ALL') return true;
    if (fragmentFilter.value === 'ABNORMAL') return task.status === 'FAILED';
    return (
      task.fragmentType === fragmentFilter.value ||
      (includeCompatiblePurposes.value &&
        task.compatibleFragmentTypes.includes(fragmentFilter.value))
    );
  }),
);
const totalPages = computed(() =>
  effectSegmentRenderPageCount(filteredTasks.value.length, pageSize.value),
);
const pagedTasks = computed(() =>
  effectSegmentRenderPage(filteredTasks.value, page.value, pageSize.value),
);
const selectedTasks = computed(() =>
  completedTasks.value.filter((task) => selectedTaskIds.value.has(task.id)),
);
const selectableFilteredTasks = computed(() =>
  filteredTasks.value.filter(isEffectSegmentRenderExportable),
);
const allFilteredSelected = computed(
  () =>
    selectableFilteredTasks.value.length > 0 &&
    selectableFilteredTasks.value.every((task) => selectedTaskIds.value.has(task.id)),
);
const exportRangeTasks = computed(() => {
  if (exportScope.value === 'SELECTED') return selectedTasks.value;
  if (exportScope.value === 'FILTERED')
    return filteredTasks.value.filter(isEffectSegmentRenderExportable);
  return completedTasks.value;
});

const canPreviewTask = (task: EffectSegmentRenderTask): boolean => Boolean(task.output);
const canRetryTask = (task: EffectSegmentRenderTask): boolean =>
  !isEffectSegmentRenderBusy(task.status) && !task.repair;

const promptExcerpt = (promptText: string): string => {
  const normalized = promptText.replace(/\s+/gu, ' ').trim();
  const characters = Array.from(normalized);
  return characters.length > 14 ? `${characters.slice(0, 14).join('')}…` : normalized;
};

const currentProductReady = computed(
  () =>
    hasBatch.value &&
    workspace.value?.batchStatus === 'COMPLETED' &&
    promptTasks.value.length === promptCount.value &&
    summary.value.running === 0 &&
    summary.value.failed === 0 &&
    tasks.value.every((task) => !task.repair) &&
    !workspace.value?.stale &&
    operation.value === null,
);
const canStartBatch = computed(
  () =>
    Boolean(workspace.value?.promptReady && workspace.value.promptArtifactRevision) &&
    promptCount.value > 0 &&
    !batchActive.value,
);
const startButtonLabel = computed(() => {
  if (operation.value === 'batch') return '正在创建任务…';
  if (batchActive.value) return `渲染中 ${summary.value.completed}/${summary.value.total}`;
  if (!workspace.value?.promptReady) return '等待上游 Prompt 完成校验';
  if (workspace.value?.stale) return '按最新 Prompt 重新渲染';
  if (hasBatch.value) return '重新渲染';
  return importedCount.value
    ? `渲染剩余片段（${remainingPromptCount.value}）`
    : `开始批量渲染（${promptCount.value}）`;
});
const currentCapabilityLabel = computed(
  () =>
    capabilityOptions.find((option) => option.value === renderSettings.value.capabilityKey)
      ?.label ?? renderSettings.value.capabilityKey,
);

const isAbortError = (error: unknown): boolean =>
  error instanceof DOMException ? error.name === 'AbortError' : false;

const safeMessage = (error: unknown, fallback: string): string => {
  const message = error instanceof Error ? error.message : fallback;
  return message
    .replace(/(?:https?|tos|s3):\/\/\S+/giu, '[链接已隐藏]')
    .replace(/[a-z]:\\(?:[^\\\s]+\\)+[^\s]+/giu, '[路径已隐藏]')
    .slice(0, 300);
};

const showNotice = (text: string, kind: Notice['kind'] = 'success'): void => {
  notice.value = { text, kind };
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => (notice.value = null), 3000);
};

const stopPolling = (): void => {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = undefined;
  pollController?.abort();
  pollController = null;
};

const needsPolling = (nextWorkspace: EffectSegmentRenderWorkspace): boolean =>
  nextWorkspace.batchStatus === 'QUEUED' ||
  nextWorkspace.batchStatus === 'RUNNING' ||
  nextWorkspace.tasks.some(
    (task) => task.repair?.status === 'QUEUED' || task.repair?.status === 'RENDERING',
  );

const pollBatch = async (): Promise<void> => {
  const current = workspace.value;
  if (!current?.batchId || !needsPolling(current)) return;
  const productId = current.productId;
  const batchId = current.batchId;
  const controller = new AbortController();
  pollController = controller;
  try {
    const response = await getEffectSegmentRenderBatch(props.projectId, batchId, controller.signal);
    if (controller.signal.aborted || productId !== currentProductId.value) return;
    applyBatch(response.data.batch);
  } catch (error) {
    if (!isAbortError(error)) {
      showNotice(safeMessage(error, '刷新视频渲染进度失败，将自动重试'), 'warning');
      pollTimer = setTimeout(() => void pollBatch(), 5000);
    }
  } finally {
    if (pollController === controller) pollController = null;
  }
};

const schedulePolling = (nextWorkspace: EffectSegmentRenderWorkspace): void => {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = undefined;
  if (needsPolling(nextWorkspace)) pollTimer = setTimeout(() => void pollBatch(), 3000);
};

const applyWorkspace = (nextWorkspace: EffectSegmentRenderWorkspace): void => {
  if (nextWorkspace.productId !== currentProductId.value) return;
  const previousStatus = workspace.value?.batchStatus;
  workspace.value = nextWorkspace;
  if (
    (previousStatus === 'QUEUED' || previousStatus === 'RUNNING') &&
    nextWorkspace.batchStatus === 'PARTIAL'
  )
    showNotice('批量渲染完成，异常片段已标记，请人工重生成', 'warning');
  else if (
    (previousStatus === 'QUEUED' || previousStatus === 'RUNNING' || previousStatus === 'PARTIAL') &&
    nextWorkspace.batchStatus === 'COMPLETED'
  )
    showNotice('全部视频片段已完成并进入素材池');
  validated.value = nextWorkspace.commitStatus === 'COMMITTED' && !nextWorkspace.stale;
  schedulePolling(nextWorkspace);
};

const applyBatch = (batch: EffectSegmentRenderBatch): void => {
  const current = workspace.value;
  if (!current || batch.productId !== currentProductId.value) return;
  applyWorkspace(effectSegmentRenderWorkspaceWithBatch(current, batch));
};

const clearPreview = (): void => {
  previewController?.abort();
  previewController = null;
  if (previewUrl.value) URL.revokeObjectURL(previewUrl.value);
  previewUrl.value = '';
  previewLoading.value = false;
  previewError.value = '';
};

const closeAllDialogs = (restoreFocus = false): void => {
  clearPreview();
  previewTask.value = null;
  previewVariant.value = 'ACTIVE';
  promptTask.value = null;
  repairTask.value = null;
  if (!restoreFocus) {
    dialogTrigger = null;
    return;
  }
  const trigger = dialogTrigger;
  dialogTrigger = null;
  void nextTick(() => trigger?.isConnected && trigger.focus());
};

const closeTransferPanel = (restoreFocus = false): void => {
  transferPanel.value = null;
  importFiles.value = [];
  importMatches.value = [];
  if (!restoreFocus) return;
  const trigger = dialogTrigger;
  dialogTrigger = null;
  void nextTick(() => trigger?.isConnected && trigger.focus());
};

const loadCurrentWorkspace = async (): Promise<void> => {
  const product = currentProduct.value;
  const generation = ++loadGeneration;
  loadController?.abort();
  operationController?.abort();
  stopPolling();
  operation.value = null;
  closeAllDialogs(false);
  closeTransferPanel(false);
  selectionMode.value = false;
  selectedTaskIds.value = new Set();
  page.value = 1;
  keyword.value = '';
  fragmentFilter.value = 'ALL';
  includeCompatiblePurposes.value = false;
  validated.value = false;
  if (!product || !props.projectId || !props.workflowRunId) {
    workspace.value = null;
    pageStatus.value = 'empty';
    return;
  }
  pageStatus.value = 'loading';
  loadError.value = '';
  const controller = new AbortController();
  loadController = controller;
  try {
    const settingsResponse = await getEffectSegmentRenderWorkspace(
      props.projectId,
      props.workflowRunId,
      product.id,
      controller.signal,
    );
    if (generation !== loadGeneration || controller.signal.aborted) return;
    renderSettings.value = { ...settingsResponse.data.settings };
    renderSettingsRevision.value = settingsResponse.data.settingsRevision;
    applyWorkspace(effectSegmentRenderWorkspaceFromApi(settingsResponse.data));
    pageStatus.value = 'success';
  } catch (error) {
    if (isAbortError(error) || generation !== loadGeneration) return;
    pageStatus.value = 'error';
    loadError.value = safeMessage(error, '渲染工作区加载失败');
  } finally {
    if (loadController === controller) loadController = null;
  }
};

const updateRenderSetting = async <Key extends keyof EffectSegmentRenderSettings>(
  key: Key,
  value: EffectSegmentRenderSettings[Key],
): Promise<void> => {
  const product = currentProduct.value;
  if (!product || operation.value || batchActive.value) return;
  const previous = { ...renderSettings.value };
  const next = { ...renderSettings.value, [key]: value };
  if (key === 'capabilityKey') {
    const capability: RenderModelOption =
      capabilityOptions.find((option) => option.value === next.capabilityKey) ??
      capabilityOptions[1];
    if (!capability.ratios.includes(next.ratio)) next.ratio = capability.defaultRatio;
    if (!capability.resolutions.includes(next.resolution))
      next.resolution = capability.defaultResolution;
  }
  renderSettings.value = next;
  operation.value = 'settings';
  try {
    const response = await saveEffectSegmentRenderSettings(props.projectId, product.id, {
      workflowRunId: props.workflowRunId,
      expectedRevision: renderSettingsRevision.value,
      settings: next,
    });
    if (product.id !== currentProductId.value) return;
    renderSettings.value = { ...response.data.settings };
    renderSettingsRevision.value = response.data.settingsRevision;
    showNotice('视频渲染设置已保存');
  } catch (error) {
    renderSettings.value = previous;
    showNotice(safeMessage(error, '视频渲染设置保存失败'), 'error');
  } finally {
    operation.value = null;
  }
};

watch(
  [() => props.projectId, () => props.workflowRunId, activeProductSignature],
  () => {
    if (!activeProducts.value.some((product) => product.id === currentProductId.value)) {
      currentProductId.value = activeProducts.value[0]?.id ?? '';
      void loadCurrentWorkspace();
      return;
    }
    void loadCurrentWorkspace();
  },
  { immediate: true },
);

watch(currentProductId, (next, previous) => {
  if (next !== previous) void loadCurrentWorkspace();
});

watch([keyword, fragmentFilter, includeCompatiblePurposes], () => {
  page.value = 1;
});

watch(fragmentFilter, (nextFilter) => {
  if (!isPurposeFilter(nextFilter)) includeCompatiblePurposes.value = false;
});

watch(totalPages, (nextTotalPages) => {
  if (page.value > nextTotalPages) page.value = nextTotalPages;
});

const statusMeta = (status: EffectSegmentRenderStatus): { label: string; tone: string } =>
  ({
    AUTO_RETRY: { label: '自动重试', tone: 'retry' },
    COMPLETED: { label: '已完成', tone: 'success' },
    FAILED: { label: '异常', tone: 'danger' },
    QUEUED: { label: '排队中', tone: 'pending' },
    RENDERING: { label: '生成中', tone: 'running' },
  })[status];

const fragmentTypeLabel = (fragmentType: EffectPromptFragmentType): string =>
  EFFECT_PROMPT_FRAGMENT_TYPE_LABELS[fragmentType];

const fragmentTypeCount = (fragmentType: EffectPromptFragmentType): number =>
  tasks.value.filter((task) => task.fragmentType === fragmentType).length;

const clearSearch = (): void => {
  keyword.value = '';
};

const toggleFragmentFilter = (fragmentType: EffectPromptFragmentType): void => {
  fragmentFilter.value = fragmentFilter.value === fragmentType ? 'ALL' : fragmentType;
};

const changePageSize = (): void => {
  page.value = 1;
};

const startBatch = async (): Promise<void> => {
  const product = currentProduct.value;
  const current = workspace.value;
  if (!product || operation.value || !current || !canStartBatch.value) return;
  const rerendering = hasBatch.value;
  if (
    !(await requestActionConfirmation(
      rerendering
        ? {
            eyebrow: current.stale ? '按最新 Prompt 重新渲染' : '重新渲染全部片段',
            title: `重新生成全部 ${promptCount.value} 个视频素材片段？`,
            description: `${product.name || '未命名产品'}；${currentCapabilityLabel.value}；${renderSettings.value.ratio}；${renderSettings.value.resolution}。确认后会创建新批次、提交 ${promptCount.value} 个真实 Seedance 任务并再次产生供应商费用。原批次数据不会删除，页面将切换到新批次；新结果完成校验后才会更新素材工作副本。`,
            confirmLabel: `重新提交 ${promptCount.value} 个真实任务`,
            tone: 'warning',
          }
        : {
            eyebrow: '创建视频渲染批次',
            title: `开始生成 ${promptCount.value} 个真实视频素材片段？`,
            description: `${product.name || '未命名产品'}；${currentCapabilityLabel.value}；${renderSettings.value.ratio}；${renderSettings.value.resolution}。确认后会提交 ${promptCount.value} 个真实 Seedance 任务并产生供应商费用。`,
            confirmLabel: `提交 ${promptCount.value} 个真实任务`,
            tone: 'warning',
          },
    ))
  )
    return;
  operationController?.abort();
  const controller = new AbortController();
  operationController = controller;
  operation.value = 'batch';
  validated.value = false;
  try {
    const response = await startEffectSegmentRenderBatch(
      props.projectId,
      product.id,
      {
        workflowRunId: props.workflowRunId,
        expectedPromptArtifactRevision: current.promptArtifactRevision!,
        expectedSettingsRevision: renderSettingsRevision.value ?? 0,
        idempotencyKey: crypto.randomUUID(),
      },
      controller.signal,
    );
    if (controller.signal.aborted || currentProductId.value !== product.id) return;
    applyBatch(response.data.batch);
    showNotice(
      rerendering
        ? `新批次已创建，${response.data.batch.tasks.length} 个真实视频任务已进入渲染队列`
        : `${response.data.batch.tasks.length} 个真实视频任务已进入渲染队列`,
    );
  } catch (error) {
    if (!isAbortError(error)) showNotice(safeMessage(error, '批量渲染失败'), 'error');
  } finally {
    if (operationController === controller) operationController = null;
    if (!controller.signal.aborted || currentProductId.value === product.id) operation.value = null;
  }
};

const retryTask = async (taskId: string): Promise<void> => {
  const product = currentProduct.value;
  const current = workspace.value;
  if (!product || operation.value || !current?.batchId || typeof current.batchRevision !== 'number')
    return;
  if (
    !(await requestActionConfirmation({
      eyebrow: '重新生成片段',
      title: '重新生成这个视频片段？',
      description:
        '重新生成会提交一个新的真实 Seedance 请求，原 Prompt 与该批次冻结的渲染配置保持不变，并产生供应商费用。',
      confirmLabel: '确认重新生成',
      tone: 'warning',
    }))
  )
    return;
  operationController?.abort();
  const controller = new AbortController();
  operationController = controller;
  operation.value = 'retry';
  validated.value = false;
  try {
    const response = await regenerateEffectSegmentRenderTasks(
      props.projectId,
      current.batchId,
      {
        taskIds: [taskId],
        expectedBatchRevision: current.batchRevision,
        idempotencyKey: crypto.randomUUID(),
      },
      controller.signal,
    );
    if (controller.signal.aborted || currentProductId.value !== product.id) return;
    applyBatch(response.data.batch);
    showNotice('视频素材片段已重新进入真实渲染队列');
  } catch (error) {
    if (!isAbortError(error)) showNotice(safeMessage(error, '片段重生成失败'), 'error');
  } finally {
    if (operationController === controller) operationController = null;
    if (!controller.signal.aborted || currentProductId.value === product.id) operation.value = null;
  }
};

const openPreview = (
  task: EffectSegmentRenderTask,
  event: Event,
  variant: 'ACTIVE' | 'REPAIR' = 'ACTIVE',
): void => {
  const current = workspace.value;
  if (!current?.batchId || (variant === 'ACTIVE' ? !task.output : !task.repair?.candidate)) return;
  clearPreview();
  dialogTrigger = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
  previewTask.value = task;
  previewVariant.value = variant;
  previewLoading.value = true;
  const controller = new AbortController();
  previewController = controller;
  void getEffectSegmentRenderTaskContent(
    props.projectId,
    current.batchId,
    task.id,
    variant,
    controller.signal,
  )
    .then((response) => response.blob())
    .then((blob) => {
      if (controller.signal.aborted || previewTask.value?.id !== task.id) return;
      previewUrl.value = URL.createObjectURL(blob);
    })
    .catch((error: unknown) => {
      if (!isAbortError(error)) previewError.value = safeMessage(error, '视频预览加载失败');
    })
    .finally(() => {
      if (previewController === controller) previewController = null;
      if (!controller.signal.aborted) previewLoading.value = false;
    });
  void nextTick(() => previewCloseButton.value?.focus());
};

const openRepair = (task: EffectSegmentRenderTask, event: Event): void => {
  if (!task.output || task.repair || task.durationSeconds > 15) return;
  dialogTrigger = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
  repairTask.value = task;
  repairStartSeconds.value = 0;
  repairEndSeconds.value = Math.min(task.durationSeconds, 2);
  repairInstruction.value = '';
  void nextTick(() => repairCloseButton.value?.focus());
};

const submitRepair = async (): Promise<void> => {
  const product = currentProduct.value;
  const task = repairTask.value;
  const current = workspace.value;
  if (
    !product ||
    !task ||
    !task.output ||
    operation.value ||
    !current?.batchId ||
    typeof current.batchRevision !== 'number'
  )
    return;
  operation.value = 'repair';
  validated.value = false;
  try {
    const response = await startEffectSegmentRenderRepair(
      props.projectId,
      current.batchId,
      task.id,
      {
        expectedBatchRevision: current.batchRevision,
        expectedSourceVersion: task.output.version,
        startMs: Math.round(repairStartSeconds.value * 1000),
        endMs: Math.round(repairEndSeconds.value * 1000),
        instruction: repairInstruction.value,
        idempotencyKey: crypto.randomUUID(),
      },
    );
    applyBatch(response.data.batch);
    closeAllDialogs(true);
    showNotice('真实返修任务已进入队列，完成后可预览并决定是否采用');
  } catch (error) {
    if (!isAbortError(error)) showNotice(safeMessage(error, '视频画面返修失败'), 'error');
  } finally {
    operation.value = null;
  }
};

const decideRepair = async (
  task: EffectSegmentRenderTask,
  decision: 'ACCEPT' | 'DISCARD',
): Promise<void> => {
  const product = currentProduct.value;
  const current = workspace.value;
  const repairVersion = task.repair?.version ?? task.repair?.candidateVersion;
  if (
    !product ||
    operation.value ||
    !task.repair ||
    !repairVersion ||
    !current?.batchId ||
    typeof current.batchRevision !== 'number'
  )
    return;
  if (
    !(await requestActionConfirmation({
      eyebrow: decision === 'ACCEPT' ? '采用修复版' : '放弃修复版',
      title: decision === 'ACCEPT' ? '用修复版替换当前素材？' : '放弃这个返修候选？',
      description:
        decision === 'ACCEPT'
          ? '采用后，修复版会成为当前活动素材；节点完成校验前仍可继续调整。'
          : '放弃后保留当前原视频，返修候选将不再可用。',
      confirmLabel: decision === 'ACCEPT' ? '确认采用' : '确认放弃',
      tone: 'warning',
    }))
  )
    return;
  operation.value = 'repair';
  validated.value = false;
  try {
    const response = await decideEffectSegmentRenderRepair(
      props.projectId,
      current.batchId,
      task.id,
      {
        expectedBatchRevision: current.batchRevision,
        repairVersion,
        decision,
        idempotencyKey: crypto.randomUUID(),
      },
    );
    applyBatch(response.data.batch);
    showNotice(decision === 'ACCEPT' ? '已采用修复版视频' : '已放弃返修候选');
  } catch (error) {
    showNotice(safeMessage(error, '处理返修候选失败'), 'error');
  } finally {
    operation.value = null;
  }
};

const openPrompt = (task: EffectSegmentRenderTask, event: Event): void => {
  dialogTrigger = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
  promptTask.value = task;
  void nextTick(() => promptCloseButton.value?.focus());
};

const openTransferPanel = (panel: Exclude<TransferPanel, null>, event: Event): void => {
  void event;
  showNotice(
    panel === 'import' ? '真实素材导入接口尚未接入' : '真实素材批量导出接口尚未接入',
    'warning',
  );
};

const inspectImportFiles = async (files: File[]): Promise<void> => {
  void files;
  showNotice('真实素材导入接口尚未接入', 'warning');
};

const handleImportFileChange = (event: Event): void => {
  const input = event.currentTarget as HTMLInputElement;
  void inspectImportFiles(Array.from(input.files ?? []));
  input.value = '';
};

const confirmImport = async (): Promise<void> => {
  showNotice('真实素材导入接口尚未接入', 'warning');
};

const toggleSelectionMode = (): void => {
  selectionMode.value = !selectionMode.value;
  if (!selectionMode.value) selectedTaskIds.value = new Set();
};

const toggleTaskSelection = (taskId: string): void => {
  const next = new Set(selectedTaskIds.value);
  if (next.has(taskId)) next.delete(taskId);
  else next.add(taskId);
  selectedTaskIds.value = next;
};

const selectAllFiltered = (): void => {
  if (allFilteredSelected.value) {
    const filteredIds = new Set(selectableFilteredTasks.value.map((task) => task.id));
    selectedTaskIds.value = new Set(
      [...selectedTaskIds.value].filter((taskId) => !filteredIds.has(taskId)),
    );
    return;
  }
  selectedTaskIds.value = new Set([
    ...selectedTaskIds.value,
    ...selectableFilteredTasks.value.map((task) => task.id),
  ]);
};

const deleteSelectedMaterials = async (): Promise<void> => {
  showNotice('真实素材删除接口尚未接入', 'warning');
};

const toggleExportFormat = (format: EffectSegmentRenderExportFormat): void => {
  const next = new Set(exportFormats.value);
  if (next.has(format)) next.delete(format);
  else next.add(format);
  exportFormats.value = [...next];
};

const downloadExport = async (): Promise<void> => {
  showNotice('真实素材批量导出接口尚未接入', 'warning');
};

const formatFileSize = (size: number): string =>
  size >= 1024 * 1024
    ? `${(size / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(size / 1024))} KB`;

const validateBatch = async (): Promise<void> => {
  if (!currentProductReady.value) {
    const message = !hasBatch.value
      ? '请先开始批量渲染'
      : missingPromptCount.value
        ? `当前批次缺少 ${missingPromptCount.value} 个 Prompt 片段，请返回 Prompt 节点检查上游数据`
        : summary.value.failed
          ? '请逐条重新生成异常片段'
          : '仍有片段正在生成，请等待任务完成';
    showNotice(message, 'warning');
    return;
  }
  const current = workspace.value;
  if (!current?.batchId || typeof current.batchRevision !== 'number') return;
  operation.value = 'batch';
  try {
    const response = await validateEffectSegmentRenderBatch(props.projectId, current.batchId, {
      expectedBatchRevision: current.batchRevision,
    });
    if (!response.data.valid) {
      showNotice(response.data.issues[0]?.message ?? '视频渲染批次校验未通过', 'warning');
      return;
    }
    validated.value = true;
    await loadCurrentWorkspace();
    showNotice(`已提交 ${response.data.artifacts.length} 个真实视频工作副本`);
  } catch (error) {
    showNotice(safeMessage(error, '视频渲染完成校验失败'), 'error');
  } finally {
    operation.value = null;
  }
};

const flushPendingEdits = async (): Promise<boolean> => operation.value === null;

defineExpose({ flushPendingEdits });

onBeforeUnmount(() => {
  loadController?.abort();
  operationController?.abort();
  stopPolling();
  clearPreview();
  if (noticeTimer) clearTimeout(noticeTimer);
});
</script>

<template>
  <section class="effect-segment-render-node" aria-labelledby="effect-segment-render-title">
    <Transition name="segment-notice">
      <div v-if="notice" class="segment-notice" :class="notice.kind" role="status">
        {{ notice.text }}
      </div>
    </Transition>

    <section v-if="pageStatus === 'loading'" class="segment-page-state" role="status">
      <LoaderCircle class="spin" :size="32" />
      <h2>正在恢复视频片段渲染队列</h2>
      <p>按当前项目和商品载入真实 Prompt 批次与 Seedance 任务…</p>
    </section>
    <section v-else-if="pageStatus === 'error'" class="segment-page-state error" role="alert">
      <AlertCircle :size="32" />
      <h2>视频片段渲染工作区加载失败</h2>
      <p>{{ loadError }}</p>
      <button type="button" @click="loadCurrentWorkspace"><RefreshCw :size="14" />重新加载</button>
    </section>
    <section v-else-if="pageStatus === 'empty' || !currentProduct" class="segment-page-state">
      <Sparkles :size="32" />
      <h2>暂无可渲染的 Prompt</h2>
      <p>请返回 Prompt 生成节点，完成至少一个产品的 Prompt 校验。</p>
      <button type="button" @click="emit('back')"><ChevronLeft :size="14" />返回上一步</button>
    </section>

    <template v-else>
      <header class="segment-heading">
        <div class="segment-heading__title">
          <span>04</span>
          <div>
            <h2 id="effect-segment-render-title">AI 视频片段批量渲染</h2>
            <p v-if="hasBatch">
              {{ promptCount }} 条 Prompt 任务 × 每条 1 个视频素材片段，成功片段自动进入素材池
            </p>
            <p v-else-if="importedCount">
              已导入 {{ importedCount }} 个素材，剩余 {{ remainingPromptCount }} 条 Prompt 待渲染
            </p>
            <p v-else-if="workspace?.promptReady">
              已就绪 {{ promptCount }} 条 Prompt，每条将生成 1 个视频素材片段
            </p>
            <p v-else>上游 Prompt 尚未完成校验，当前不会创建视频任务</p>
          </div>
        </div>
        <div class="segment-heading__actions">
          <label class="product-switcher">
            <span>当前商品</span>
            <select v-model="currentProductId" :disabled="operation !== null">
              <option v-for="product in activeProducts" :key="product.id" :value="product.id">
                {{ product.name || '未命名产品' }}
              </option>
            </select>
          </label>
          <button
            class="secondary-button"
            type="button"
            disabled
            title="真实素材导入后端尚未接入"
            @click="openTransferPanel('import', $event)"
          >
            <FolderInput :size="14" />导入素材
          </button>
          <button
            class="secondary-button"
            type="button"
            disabled
            title="真实素材批量导出后端尚未接入"
            @click="openTransferPanel('export', $event)"
          >
            <Download :size="14" />导出素材
          </button>
          <button
            class="primary-button start-render-button"
            type="button"
            :disabled="operation !== null || !canStartBatch"
            @click="startBatch"
          >
            <LoaderCircle v-if="operation === 'batch' || batchActive" class="spin" :size="14" />
            <RefreshCw v-else-if="hasBatch && canStartBatch" :size="14" />
            <Play v-else-if="canStartBatch" :size="14" />{{ startButtonLabel }}
          </button>
        </div>
      </header>

      <section class="render-settings-card" aria-labelledby="render-settings-title">
        <div class="render-settings-card__heading">
          <span><Settings2 :size="17" /></span>
          <div>
            <h3 id="render-settings-title">视频渲染设置</h3>
            <p>画幅和分辨率只用于新的视频任务，不会让 Prompt 或提炼结果过期。</p>
          </div>
          <small>{{
            batchActive ? '当前批次参数已锁定' : operation === 'settings' ? '保存中…' : '已自动保存'
          }}</small>
        </div>
        <div class="render-settings-grid">
          <label>
            <span>视频模型</span>
            <EffectUpwardCreatableSelect
              field-label="视频模型"
              :model-value="renderSettings.capabilityKey"
              :options="capabilityOptions"
              :creatable="false"
              :disabled="operation !== null || batchActive"
              @update:model-value="
                updateRenderSetting(
                  'capabilityKey',
                  $event as EffectSegmentRenderSettings['capabilityKey'],
                )
              "
            />
          </label>
          <label>
            <span>画幅</span>
            <EffectUpwardCreatableSelect
              field-label="画幅"
              :model-value="renderSettings.ratio"
              :options="ratioOptions"
              :creatable="false"
              :disabled="operation !== null || batchActive"
              @update:model-value="
                updateRenderSetting('ratio', $event as EffectSegmentRenderSettings['ratio'])
              "
            />
          </label>
          <label>
            <span>分辨率</span>
            <EffectUpwardCreatableSelect
              field-label="分辨率"
              :model-value="renderSettings.resolution"
              :options="resolutionOptions"
              :creatable="false"
              :disabled="operation !== null || batchActive"
              @update:model-value="
                updateRenderSetting(
                  'resolution',
                  $event as EffectSegmentRenderSettings['resolution'],
                )
              "
            />
          </label>
        </div>
      </section>

      <section class="segment-workspace" aria-label="AI 视频素材工作区">
        <div class="segment-material-panel">
          <div class="segment-toolbar">
            <div class="prompt-search" role="search">
              <Search :size="15" />
              <input
                v-model="keyword"
                type="search"
                aria-label="搜索视频素材"
                :disabled="!tasks.length || operation !== null"
                placeholder="搜索编号或多个关键词，例如：R012、厨房 特写"
              />
              <button
                v-if="keyword"
                class="prompt-search__clear"
                type="button"
                aria-label="清除搜索"
                @click="clearSearch"
              >
                <X :size="14" />
              </button>
            </div>
            <span class="prompt-result-count">{{ filteredTasks.length }} 个结果</span>
            <span v-if="hasBatch" class="toolbar-result-stats" aria-label="视频素材生成结果">
              <span class="success"
                ><i></i>成功 <strong>{{ summary.completed }}</strong></span
              >
              <span class="danger"
                ><i></i>异常 <strong>{{ summary.failed }}</strong></span
              >
            </span>
            <button
              class="selection-mode-button"
              :class="{ active: selectionMode }"
              type="button"
              :disabled="!completedTasks.length || operation !== null"
              @click="toggleSelectionMode"
            >
              <Check :size="14" />{{ selectionMode ? '退出选择' : '选择素材' }}
            </button>
          </div>

          <nav class="purpose-filter-bar" aria-label="按片段类型筛选视频素材">
            <button
              type="button"
              :class="{ active: fragmentFilter === 'ALL' }"
              :aria-pressed="fragmentFilter === 'ALL'"
              @click="fragmentFilter = 'ALL'"
            >
              全部用途 <small>{{ tasks.length }}</small>
            </button>
            <button
              v-for="fragmentType in EFFECT_PROMPT_FRAGMENT_TYPES"
              :key="fragmentType"
              type="button"
              :class="{ active: fragmentFilter === fragmentType }"
              :aria-pressed="fragmentFilter === fragmentType"
              @click="toggleFragmentFilter(fragmentType)"
            >
              {{ fragmentTypeLabel(fragmentType) }}
              <small>{{ fragmentTypeCount(fragmentType) }}</small>
            </button>
            <button
              class="abnormal-purpose-filter"
              type="button"
              :class="{ active: fragmentFilter === 'ABNORMAL' }"
              :aria-pressed="fragmentFilter === 'ABNORMAL'"
              @click="fragmentFilter = fragmentFilter === 'ABNORMAL' ? 'ALL' : 'ABNORMAL'"
            >
              异常片段 <small>{{ summary.failed }}</small>
            </button>
            <label
              class="compatible-purpose-toggle"
              :class="{ disabled: !isPurposeFilter(fragmentFilter) }"
              title="开启后，也会显示将该用途标记为兼容用途的视频素材"
            >
              <input
                v-model="includeCompatiblePurposes"
                type="checkbox"
                :disabled="!isPurposeFilter(fragmentFilter)"
              />
              <span>包含兼容用途</span>
            </label>
          </nav>

          <div v-if="selectionMode" class="selection-action-bar">
            <span>已选 {{ selectedTasks.length }} 个已完成素材</span>
            <button type="button" @click="selectAllFiltered">
              {{ allFilteredSelected ? '取消全选' : '全选筛选结果' }}
            </button>
            <button
              class="delete-selection-button"
              type="button"
              disabled
              title="真实素材删除后端尚未接入"
              @click="deleteSelectedMaterials"
            >
              <Trash2 :size="13" />删除
            </button>
            <button
              type="button"
              disabled
              title="真实素材批量导出后端尚未接入"
              @click="openTransferPanel('export', $event)"
            >
              导出所选
            </button>
          </div>

          <div v-if="pagedTasks.length" class="segment-material-grid">
            <article
              v-for="task in pagedTasks"
              :key="task.id"
              class="segment-material-card"
              :class="{
                abnormal: task.abnormal,
                selectable: selectionMode && canPreviewTask(task),
                selected: selectedTaskIds.has(task.id),
              }"
              @click="selectionMode && canPreviewTask(task) && toggleTaskSelection(task.id)"
            >
              <label
                v-if="selectionMode && canPreviewTask(task)"
                class="material-checkbox"
                @click.stop
              >
                <input
                  type="checkbox"
                  :checked="selectedTaskIds.has(task.id)"
                  :aria-label="`选择 ${task.renderCode}`"
                  @change.stop="toggleTaskSelection(task.id)"
                />
              </label>
              <button
                class="material-preview"
                :class="statusMeta(task.status).tone"
                type="button"
                :disabled="!canPreviewTask(task)"
                :aria-label="`${selectionMode ? '选择' : '预览'} ${task.renderCode}`"
                @click.stop="
                  selectionMode ? toggleTaskSelection(task.id) : openPreview(task, $event)
                "
              >
                <span class="material-status-pill" :class="statusMeta(task.status).tone">
                  {{ statusMeta(task.status).label }}
                </span>
                <LoaderCircle
                  v-if="isEffectSegmentRenderBusy(task.status)"
                  class="spin"
                  :size="25"
                />
                <Play v-else :size="27" />
                <small>{{ task.durationSeconds }}s · {{ task.progress }}%</small>
              </button>
              <div class="material-card-body">
                <div class="material-card-title">
                  <strong>{{ promptExcerpt(task.promptText) }}</strong>
                  <span>{{ task.renderCode }}</span>
                </div>
                <p>{{ task.promptCode }}</p>
                <div class="task-tags">
                  <span class="primary-tag">{{ fragmentTypeLabel(task.fragmentType) }}</span>
                  <span class="origin-tag ai">真实 AI 任务</span>
                </div>
                <div
                  v-if="task.compatibleFragmentTypes.length"
                  class="compatible-purpose-tags"
                  aria-label="该视频素材的兼容用途"
                >
                  <small>还适合</small>
                  <span
                    v-for="compatibleType in task.compatibleFragmentTypes"
                    :key="compatibleType"
                  >
                    {{ fragmentTypeLabel(compatibleType) }}
                  </span>
                </div>
                <div v-if="task.errorMessage" class="task-error" role="status">
                  <AlertCircle :size="12" />{{ task.errorMessage }}
                </div>
                <div
                  v-if="task.repair"
                  class="repair-status"
                  :class="task.repair.status.toLowerCase()"
                >
                  <Sparkles :size="11" />
                  <span>
                    {{
                      task.repair.status === 'READY'
                        ? '返修候选待确认'
                        : task.repair.status === 'FAILED'
                          ? '返修失败，原视频已保留'
                          : `返修中 ${task.repair.startMs / 1000}-${task.repair.endMs / 1000}s`
                    }}
                  </span>
                </div>
                <div v-if="isEffectSegmentRenderBusy(task.status)" class="material-progress">
                  <i :style="{ width: `${task.progress}%` }" />
                </div>
              </div>
              <footer v-if="!selectionMode" class="material-card-actions">
                <template v-if="task.repair?.status === 'READY'">
                  <button type="button" @click="openPreview(task, $event, 'REPAIR')">
                    预览修复版
                  </button>
                  <button
                    type="button"
                    :disabled="operation !== null"
                    @click="decideRepair(task, 'ACCEPT')"
                  >
                    采用
                  </button>
                  <button
                    type="button"
                    :disabled="operation !== null"
                    @click="decideRepair(task, 'DISCARD')"
                  >
                    放弃
                  </button>
                </template>
                <button
                  v-else-if="task.repair?.status === 'FAILED'"
                  type="button"
                  :disabled="operation !== null"
                  @click="decideRepair(task, 'DISCARD')"
                >
                  清除返修记录
                </button>
                <button v-else-if="task.repair" type="button" disabled>返修处理中</button>
                <button
                  v-else
                  type="button"
                  :disabled="operation !== null || !task.output || task.durationSeconds > 15"
                  @click="openRepair(task, $event)"
                >
                  画面返修
                </button>
                <button
                  type="button"
                  :disabled="!canPreviewTask(task)"
                  @click="openPreview(task, $event)"
                >
                  即时预览
                </button>
                <button type="button" @click="openPrompt(task, $event)">来源 Prompt</button>
                <button
                  type="button"
                  :disabled="operation !== null || !canRetryTask(task)"
                  @click="retryTask(task.id)"
                >
                  重新生成
                </button>
              </footer>
            </article>
          </div>

          <div v-else-if="!hasBatch && !tasks.length" class="segment-batch-empty">
            <span><Play :size="23" /></span>
            <strong>{{
              workspace?.promptReady ? '尚未创建视频渲染任务' : '等待上游 Prompt 校验'
            }}</strong>
            <p v-if="workspace?.promptReady">
              已确认 {{ promptCount }} 条片段 Prompt，可从页头开始提交真实批量渲染。
            </p>
            <p v-else>请返回 Prompt 节点完成校验，渲染节点只消费已确认的工作副本。</p>
          </div>

          <div v-else class="segment-empty-filter">
            <Search :size="24" />
            <strong>没有匹配当前筛选条件的素材</strong>
            <span>请调整关键词或片段类型。</span>
          </div>

          <div v-if="tasks.length" class="prompt-pagination">
            <label class="prompt-page-size">
              <select v-model.number="pageSize" aria-label="每页展示数量" @change="changePageSize">
                <option v-for="size in EFFECT_PROMPT_PAGE_SIZE_OPTIONS" :key="size" :value="size">
                  {{ size }} 条/页
                </option>
              </select> </label
            ><button type="button" :disabled="page <= 1" @click="page -= 1">
              <ChevronLeft :size="14" />上一页</button
            ><strong>第 {{ page }} / {{ totalPages }} 页</strong
            ><button type="button" :disabled="page >= totalPages" @click="page += 1">
              下一页<ChevronRight :size="14" />
            </button>
          </div>
        </div>
      </section>

      <WorkflowNodeDraftBar
        :detail="
          hasBatch
            ? `${currentProduct.name} · ${summary.total} 个真实视频任务 · 批次 revision ${workspace?.batchRevision ?? '-'}${workspace?.stale ? ' · 上游已更新' : ''}`
            : workspace?.promptReady
              ? `${currentProduct.name} · 已就绪 ${promptCount} 条 Prompt · 尚未创建渲染批次`
              : `${currentProduct.name} · 等待上游 Prompt 完成校验`
        "
        :state="operation || batchActive ? 'saving' : validated ? 'saved' : 'dirty'"
        :state-label="
          operation || batchActive
            ? '正在生成…'
            : validated
              ? '真实工作副本已提交'
              : hasBatch
                ? '真实批次已更新'
                : workspace?.promptReady
                  ? '等待开始'
                  : '上游未确认'
        "
        title="AI 视频片段批次"
      />

      <WorkflowNodeFooter
        back-label="上一步"
        :complete="validated"
        :status-title="
          validated
            ? '真实视频批次校验完成'
            : !hasBatch
              ? workspace?.promptReady
                ? '等待开始批量渲染'
                : '请先完成上游 Prompt 校验'
              : batchActive
                ? `正在渲染，已完成 ${summary.completed}/${summary.total}`
                : currentProductReady
                  ? '全部片段已完成，可完成校验'
                  : '等待处理异常或缺失片段'
        "
        :status-detail="`步骤 4 / 6 · ${currentProduct.name} · ${validated ? '真实工作副本已提交' : hasBatch ? '真实批次尚未校验' : workspace?.promptReady ? `已就绪 ${promptCount} 条 Prompt` : '等待上游确认'}`"
        :validate-disabled="!currentProductReady"
        :next-disabled="!validated || operation !== null"
        next-label="下一步：模板混剪"
        @back="emit('back')"
        @validate="validateBatch"
        @next="emit('next')"
      />
    </template>

    <Teleport to="body">
      <div
        v-if="previewTask"
        class="segment-dialog-backdrop"
        @mousedown.self="closeAllDialogs(true)"
      >
        <section
          class="segment-dialog preview-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="segment-preview-title"
          @keydown.esc="closeAllDialogs(true)"
        >
          <header>
            <h2 id="segment-preview-title">渲染片段即时预览</h2>
            <button
              ref="previewCloseButton"
              type="button"
              aria-label="关闭即时预览"
              @click="closeAllDialogs(true)"
            >
              <X :size="16" />
            </button>
          </header>
          <div class="large-preview">
            <LoaderCircle v-if="previewLoading" class="spin" :size="34" />
            <div v-else-if="previewError" class="preview-load-error" role="alert">
              <AlertCircle :size="28" />
              <small>{{ previewError }}</small>
            </div>
            <video v-else-if="previewUrl" :src="previewUrl" controls autoplay playsinline />
            <template v-else>
              <Play :size="34" />
              <small>{{ previewTask.durationSeconds }}s</small>
            </template>
          </div>
          <div class="preview-meta">
            <span>
              <strong>{{ previewTask.productName }} · {{ previewTask.renderCode }}</strong>
              <small
                >{{ previewTask.promptCode ?? previewTask.sourceName }} ·
                {{ fragmentTypeLabel(previewTask.fragmentType) }}</small
              >
            </span>
            <em>真实视频素材</em>
          </div>
          <p class="dialog-note">
            {{
              previewVariant === 'REPAIR'
                ? '当前预览的是返修候选；采用前不会覆盖原视频。'
                : `当前活动版本 v${previewTask.activeVersion}；返修候选会单独保存。`
            }}
          </p>
        </section>
      </div>

      <div
        v-if="repairTask"
        class="segment-dialog-backdrop"
        @mousedown.self="closeAllDialogs(true)"
      >
        <section
          class="segment-dialog repair-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="segment-repair-title"
          @keydown.esc="closeAllDialogs(true)"
        >
          <header>
            <div>
              <h2 id="segment-repair-title">返修指定画面</h2>
              <small>{{ repairTask.renderCode }} · 完整参考视频最长 15 秒</small>
            </div>
            <button
              ref="repairCloseButton"
              type="button"
              aria-label="关闭视频返修"
              @click="closeAllDialogs(true)"
            >
              <X :size="16" />
            </button>
          </header>
          <div class="repair-dialog-body">
            <p>
              原 Prompt
              不会改动。系统会把当前完整视频交给模型，只要求修改下面的时间段；生成结果先作为候选保存。
            </p>
            <div class="repair-time-fields">
              <label>
                <span>开始时间（秒）</span>
                <input
                  v-model.number="repairStartSeconds"
                  type="number"
                  min="0"
                  :max="repairTask.durationSeconds"
                  step="0.1"
                />
              </label>
              <label>
                <span>结束时间（秒）</span>
                <input
                  v-model.number="repairEndSeconds"
                  type="number"
                  min="0.1"
                  :max="repairTask.durationSeconds"
                  step="0.1"
                />
              </label>
            </div>
            <label class="repair-instruction-field">
              <span>需要修改什么</span>
              <textarea
                v-model="repairInstruction"
                maxlength="1000"
                placeholder="例如：12.3 秒开始，移除台面右侧的黑色污点，保持人物、产品和镜头运动不变。"
              />
              <small>{{ repairInstruction.trim().length }}/1000</small>
            </label>
          </div>
          <footer>
            <button type="button" @click="closeAllDialogs(true)">取消</button>
            <button
              class="primary"
              type="button"
              :disabled="
                operation !== null ||
                !repairInstruction.trim() ||
                repairStartSeconds < 0 ||
                repairEndSeconds <= repairStartSeconds ||
                repairEndSeconds > repairTask.durationSeconds
              "
              @click="submitRepair"
            >
              <LoaderCircle v-if="operation === 'repair'" class="spin" :size="14" />
              {{ operation === 'repair' ? '正在生成候选…' : '生成返修候选' }}
            </button>
          </footer>
        </section>
      </div>

      <div
        v-if="promptTask"
        class="segment-dialog-backdrop"
        @mousedown.self="closeAllDialogs(true)"
      >
        <section
          class="segment-dialog prompt-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="segment-prompt-title"
          @keydown.esc="closeAllDialogs(true)"
        >
          <header>
            <h2 id="segment-prompt-title">任务 Prompt 原文</h2>
            <button
              ref="promptCloseButton"
              type="button"
              aria-label="关闭 Prompt 原文"
              @click="closeAllDialogs(true)"
            >
              <X :size="16" />
            </button>
          </header>
          <div class="prompt-dialog-meta">
            <span>
              <strong>{{ promptTask.productName }} · {{ promptTask.renderCode }}</strong>
              <small
                >{{ promptTask.promptCode }} · 推荐用途：{{
                  fragmentTypeLabel(promptTask.fragmentType)
                }}</small
              >
            </span>
            <em>来源 Prompt</em>
          </div>
          <pre>{{ promptTask.promptText }}</pre>
          <footer><button type="button" @click="closeAllDialogs(true)">关闭</button></footer>
        </section>
      </div>

      <div
        v-if="transferPanel"
        class="segment-transfer-backdrop"
        @mousedown.self="closeTransferPanel(true)"
      >
        <section
          class="segment-transfer-drawer"
          role="dialog"
          aria-modal="true"
          :aria-labelledby="
            transferPanel === 'import' ? 'segment-import-title' : 'segment-export-title'
          "
          @keydown.esc="closeTransferPanel(true)"
        >
          <header>
            <div>
              <span
                ><Upload v-if="transferPanel === 'import'" :size="17" /><Download v-else :size="17"
              /></span>
              <div>
                <h2
                  :id="transferPanel === 'import' ? 'segment-import-title' : 'segment-export-title'"
                >
                  {{ transferPanel === 'import' ? '导入外部视频素材' : '导出视频素材' }}
                </h2>
                <p v-if="transferPanel === 'import'">
                  素材必须匹配到一个 Prompt 槽位，避免形成游离素材。
                </p>
                <p v-else>选择导出范围和随包清单，已完成素材才会进入导出结果。</p>
              </div>
            </div>
            <button
              ref="transferCloseButton"
              type="button"
              aria-label="关闭素材传输面板"
              @click="closeTransferPanel(true)"
            >
              <X :size="17" />
            </button>
          </header>

          <template v-if="transferPanel === 'import'">
            <input
              ref="importInput"
              class="visually-hidden"
              type="file"
              accept="video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm"
              multiple
              @change="handleImportFileChange"
            />
            <button
              class="import-dropzone"
              type="button"
              :disabled="operation !== null"
              @click="importInput?.click()"
            >
              <span><FileVideo2 :size="24" /></span>
              <strong>{{
                importFiles.length ? '继续添加视频素材' : '选择要导入的视频素材'
              }}</strong>
              <small>支持 MP4、MOV、WebM；文件名包含 Prompt 编号时优先精确匹配</small>
            </button>
            <div
              v-if="operation === 'import' && !importMatches.length"
              class="transfer-loading"
              role="status"
            >
              <LoaderCircle class="spin" :size="17" />正在检查文件并匹配 Prompt…
            </div>
            <div v-else-if="importMatches.length" class="import-review-list">
              <div class="transfer-section-heading">
                <strong>匹配结果</strong><span>{{ importMatches.length }} 个文件</span>
              </div>
              <article
                v-for="match in importMatches"
                :key="match.id"
                :class="match.status.toLowerCase()"
              >
                <span><FileVideo2 :size="16" /></span>
                <div>
                  <strong>{{ match.fileName }}</strong>
                  <small
                    >{{ formatFileSize(match.size) }} ·
                    {{ match.promptCode ?? '未找到可用 Prompt 槽位' }}</small
                  >
                </div>
                <em>
                  {{
                    match.status === 'MATCHED'
                      ? '编号匹配'
                      : match.status === 'AUTO_ASSIGNED'
                        ? '自动分配'
                        : match.status === 'CONFLICT'
                          ? '将替换现有素材'
                          : '无法导入'
                  }}
                </em>
              </article>
            </div>
            <div class="transfer-note">
              <AlertCircle :size="15" />
              <p>冲突素材会替换同一 Prompt 槽位的当前结果；真实素材导入接口尚未接入。</p>
            </div>
            <footer>
              <button type="button" @click="closeTransferPanel(true)">取消</button>
              <button
                class="primary"
                type="button"
                :disabled="
                  operation !== null || !importMatches.some((match) => match.status !== 'UNMATCHED')
                "
                @click="confirmImport"
              >
                <LoaderCircle v-if="operation === 'import'" class="spin" :size="14" />确认导入
              </button>
            </footer>
          </template>

          <template v-else>
            <div class="export-section">
              <div class="transfer-section-heading">
                <strong>导出范围</strong><span>{{ exportRangeTasks.length }} 个素材</span>
              </div>
              <label
                ><input v-model="exportScope" type="radio" value="ALL_COMPLETED" />全部已完成素材
                <small>{{ completedTasks.length }} 个</small></label
              >
              <label
                ><input v-model="exportScope" type="radio" value="FILTERED" />当前筛选结果
                <small
                  >{{ filteredTasks.filter(isEffectSegmentRenderExportable).length }} 个</small
                ></label
              >
              <label :class="{ disabled: !selectedTasks.length }"
                ><input
                  v-model="exportScope"
                  type="radio"
                  value="SELECTED"
                  :disabled="!selectedTasks.length"
                />已选择素材 <small>{{ selectedTasks.length }} 个</small></label
              >
            </div>
            <div class="export-section">
              <div class="transfer-section-heading">
                <strong>导出内容</strong><span>可多选</span>
              </div>
              <label
                ><input
                  type="checkbox"
                  :checked="exportFormats.includes('VIDEO_PACKAGE')"
                  @change="toggleExportFormat('VIDEO_PACKAGE')"
                />视频素材包 ZIP <small>真实批量导出接口尚未接入</small></label
              >
              <label
                ><input
                  type="checkbox"
                  :checked="exportFormats.includes('MANIFEST_JSON')"
                  @change="toggleExportFormat('MANIFEST_JSON')"
                />素材清单 JSON <small>含 Prompt 与用途映射</small></label
              >
              <label
                ><input
                  type="checkbox"
                  :checked="exportFormats.includes('FAILURE_CSV')"
                  @change="toggleExportFormat('FAILURE_CSV')"
                />异常明细 CSV <small>便于补录与追踪</small></label
              >
            </div>
            <div class="transfer-note">
              <AlertCircle :size="15" />
              <p>真实素材批量导出接口尚未接入，当前不会生成占位文件。</p>
            </div>
            <footer>
              <button type="button" @click="closeTransferPanel(true)">取消</button>
              <button
                class="primary"
                type="button"
                :disabled="operation !== null || !exportRangeTasks.length || !exportFormats.length"
                @click="downloadExport"
              >
                <LoaderCircle v-if="operation === 'export'" class="spin" :size="14" />生成导出清单
              </button>
            </footer>
          </template>
        </section>
      </div>
    </Teleport>
  </section>
</template>

<style scoped>
.effect-segment-render-node {
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
.segment-notice {
  position: fixed;
  z-index: 1300;
  top: 145px;
  right: 24px;
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
.segment-notice.warning {
  color: #926123;
  background: #fff9eb;
  border-color: #f3d69a;
}
.segment-notice.error {
  color: #a84148;
  background: #fff3f2;
  border-color: #f3c6c4;
}
.segment-notice-enter-active,
.segment-notice-leave-active {
  transition: 0.2s ease;
}
.segment-notice-enter-from,
.segment-notice-leave-to {
  opacity: 0;
  transform: translateY(-7px);
}
.segment-page-state {
  display: flex;
  min-height: 420px;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  color: #7f8da2;
  text-align: center;
}
.segment-page-state > svg {
  color: var(--effect-blue);
}
.segment-page-state.error > svg {
  color: #d65355;
}
.segment-page-state h2 {
  margin: 13px 0 5px;
  color: #34445c;
  font-size: 18px;
}
.segment-page-state p {
  margin: 0;
  font-size: 11px;
}
.segment-page-state button,
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
.segment-page-state button,
.secondary-button {
  color: #42526a;
  background: #fff;
  border: 1px solid #dbe4f6;
}
.segment-page-state button {
  margin-top: 15px;
}
.primary-button {
  color: #fff;
  background: var(--effect-blue);
  border: 1px solid var(--effect-blue);
  box-shadow: 0 8px 18px #2563eb2e;
}
button:disabled,
input:disabled,
select:disabled {
  cursor: not-allowed;
  opacity: 0.52;
}
.segment-heading {
  display: flex;
  min-height: 50px;
  margin-bottom: 22px;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
}
.segment-heading__title {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 14px;
}
.segment-heading__title > span {
  display: grid;
  width: 44px;
  height: 44px;
  flex: 0 0 44px;
  place-items: center;
  color: #d67b16;
  background: #fff5e7;
  border-radius: 14px;
  font-size: 13px;
  font-weight: 900;
}
.segment-heading h2,
.segment-heading p {
  margin: 0;
}
.segment-heading h2 {
  color: #172033;
  font-size: 21px;
}
.segment-heading p {
  margin-top: 5px;
  color: #7d899d;
  font-size: 13px;
}
.segment-heading__actions {
  display: flex;
  margin-left: auto;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
}
.render-settings-card {
  padding: 16px 18px;
  background: linear-gradient(135deg, #f8fbff 0%, #fffaf7 100%);
  border: 1px solid #dce6f5;
  border-radius: 16px;
}
.render-settings-card__heading {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 10px;
}
.render-settings-card__heading > span {
  display: grid;
  width: 34px;
  height: 34px;
  place-items: center;
  color: #2563eb;
  background: #eaf2ff;
  border-radius: 10px;
}
.render-settings-card h3,
.render-settings-card p {
  margin: 0;
}
.render-settings-card h3 {
  color: #29384f;
  font-size: 14px;
}
.render-settings-card p,
.render-settings-card small {
  color: #7b8aa1;
  font-size: 11px;
}
.render-settings-card p {
  margin-top: 3px;
}
.render-settings-card small {
  color: #15956f;
  font-weight: 700;
}
.render-settings-grid {
  display: grid;
  margin-top: 14px;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}
.render-settings-grid > label {
  display: grid;
  gap: 7px;
}
.render-settings-grid > label > span {
  color: #506078;
  font-size: 11px;
  font-weight: 700;
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
  width: 178px;
  height: 40px;
  padding: 0 34px 0 13px;
  color: #42526a;
  background: #fff;
  border: 1px solid #dbe4f6;
  border-radius: 10px;
}
.secondary-button {
  min-width: 171px;
}
.start-render-button {
  min-width: 154px;
}
.segment-stats {
  display: grid;
  margin-top: 18px;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
}
.stat-card {
  position: relative;
  min-height: 109px;
  padding: 17px 18px;
  overflow: hidden;
  border-radius: 17px;
}
.stat-card span,
.stat-card small {
  display: block;
  color: #838b9b;
  font-size: 11px;
}
.stat-card strong {
  display: block;
  margin: 7px 0 3px;
  font-size: 25px;
  line-height: 1;
}
.stat-card.neutral {
  background: #f7f8fa;
  border: 1px solid #e5e8ed;
}
.stat-card.neutral strong {
  color: #253047;
}
.stat-card.cyan {
  background: #eefafd;
  border: 1px solid #ccecf0;
}
.stat-card.cyan strong {
  color: #18859a;
}
.stat-card.amber {
  background: #fff8e8;
  border: 1px solid #f5e4b5;
}
.stat-card.amber strong {
  color: #bd7a12;
}
.stat-card.coral {
  background: #eef3ff;
  border: 1px solid #ffd9cf;
}
.stat-card.coral strong {
  color: #e14950;
}
.segment-task-list {
  display: grid;
  margin-top: 16px;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
.segment-toolbar {
  display: flex;
  min-height: 54px;
  padding: 10px 14px;
  grid-column: 1 / -1;
  align-items: center;
  gap: 12px;
  color: #253047;
  background: #f7f9fc;
  border: 1px solid #e5e9f2;
  border-radius: 12px;
}
.segment-filter-controls {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 8px;
}
.segment-search {
  display: flex;
  width: min(360px, 100%);
  height: 32px;
  padding: 0 9px;
  align-items: center;
  gap: 6px;
  color: #8792a4;
  background: #fff;
  border: 1px solid #d7dfeb;
  border-radius: 6px;
}
.segment-search:focus-within {
  border-color: #4f8df7;
}
.segment-search input {
  min-width: 0;
  flex: 1;
  border: 0;
  outline: 0;
  color: #334155;
  background: transparent;
  font-size: 10px;
}
.segment-filter select {
  height: 32px;
  min-width: 142px;
  padding: 0 30px 0 10px;
  color: #526078;
  background: #fff;
  border: 1px solid #d7dfeb;
  border-radius: 6px;
  outline: 0;
  font-size: 10px;
}
.segment-filter select:focus {
  border-color: #4f8df7;
}
.filtered-result-count {
  margin-left: auto;
  color: #7f8a9e;
  font-size: 10px;
  white-space: nowrap;
}
.segment-task-card {
  position: relative;
  display: grid;
  min-width: 0;
  min-height: 154px;
  padding: 14px 16px;
  grid-template-columns: 112px minmax(0, 1fr);
  align-items: center;
  gap: 12px;
  background: #fff;
  border: 1px solid #eadfd8;
  border-radius: 12px;
  transition: 0.15s;
}
.segment-task-card:hover {
  border-color: #8eb2ee;
}
.segment-task-card.abnormal {
  background: #fffafa;
  border-color: #ef9ba5;
}
.video-placeholder {
  position: relative;
  display: grid;
  width: 112px;
  height: 92px;
  padding: 0;
  place-items: center;
  overflow: hidden;
  color: #fff;
  background: linear-gradient(135deg, #ba604d, #f6a349);
  border: 0;
  border-radius: 12px;
}
.video-placeholder.running,
.video-placeholder.retry,
.video-placeholder.pending {
  background: linear-gradient(135deg, #5c7fc4, #65b9de);
}
.video-placeholder.danger {
  background: linear-gradient(135deg, #b6404e, #e77869);
}
.video-placeholder small {
  position: absolute;
  right: 6px;
  bottom: 5px;
  color: #fff;
  font-size: 9px;
}
.task-main {
  min-width: 0;
}
.task-title {
  position: relative;
  display: flex;
  min-width: 0;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.task-title > div:first-child {
  min-width: 180px;
  flex: 1 1 180px;
}
.task-title strong {
  display: block;
  overflow: hidden;
  color: #253047;
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.task-title p {
  margin: 4px 0 7px;
  overflow: hidden;
  color: #8490a4;
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.task-actions {
  display: flex;
  min-width: max-content;
  margin-left: auto;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
  white-space: nowrap;
}
.task-actions button {
  height: 26px;
  padding: 0 3px;
  color: #526078;
  background: transparent;
  border: 0;
  font-size: 9px;
  font-weight: 650;
}
.task-actions button:hover {
  color: #2563eb;
}
.task-actions button.danger {
  color: #b94a55;
}
.task-actions em {
  padding: 3px 7px;
  color: #0f8a68;
  background: #eaf8f3;
  border-radius: 5px;
  font-size: 9px;
  font-style: normal;
  font-weight: 800;
}
.task-actions em.running,
.task-actions em.pending {
  color: #2563eb;
  background: #eaf2ff;
}
.task-actions em.retry {
  color: #a46b0a;
  background: #fff5dc;
}
.task-actions em.danger {
  color: #c93448;
  background: #fff0f2;
}
.task-tags {
  display: flex;
  margin: 6px 0;
  flex-wrap: wrap;
  gap: 5px;
}
.task-tags span {
  min-height: 20px;
  padding: 2px 7px;
  color: #2874e8;
  background: #f8fbff;
  border: 1px solid #b9d3ff;
  border-radius: 4px;
  font-size: 10px;
}
.task-tags span.primary-tag {
  color: #ef5366;
  background: #fffafa;
  border-color: #ffb9bd;
}
.task-error {
  display: flex;
  margin: 5px 0;
  align-items: center;
  gap: 4px;
  color: #bd3346;
  font-size: 9px;
}
.task-progress {
  display: flex;
  margin-top: 7px;
  align-items: center;
  gap: 8px;
}
.task-progress > span {
  color: #526078;
  font-size: 10px;
  white-space: nowrap;
}
.task-progress > div {
  height: 6px;
  flex: 1;
  overflow: hidden;
  background: #e7ecf3;
  border-radius: 5px;
}
.task-progress i {
  display: block;
  height: 100%;
  background: #4f8df7;
  border-radius: inherit;
  transition: width 0.25s;
}
.task-progress i.retry {
  background: #d99a22;
}
.task-progress i.danger {
  background: #dc3f52;
}
.task-progress b {
  width: 34px;
  color: #2563eb;
  font-size: 10px;
  text-align: right;
}
.segment-batch-empty,
.segment-empty-filter {
  display: flex;
  min-height: 230px;
  grid-column: 1 / -1;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: 7px;
  color: #8792a4;
  border: 1px dashed #cbd5e1;
  border-radius: 12px;
}
.segment-batch-empty {
  padding: 28px;
  color: #79869c;
  background: linear-gradient(145deg, #fbfdff, #fffaf6);
  border-color: #cddcf4;
}
.segment-batch-empty > span {
  display: inline-flex;
  width: 48px;
  height: 48px;
  align-items: center;
  justify-content: center;
  color: #2563eb;
  background: #eaf2ff;
  border-radius: 15px;
}
.segment-batch-empty strong {
  margin-top: 3px;
  color: #253047;
  font-size: 16px;
}
.segment-batch-empty p {
  max-width: 520px;
  margin: 0;
  font-size: 12px;
  line-height: 1.75;
  text-align: center;
}
.segment-empty-filter strong {
  color: #526078;
  font-size: 13px;
}
.segment-empty-filter span {
  font-size: 10px;
}
.segment-pagination {
  display: flex;
  min-height: 61px;
  margin-top: 2px;
  padding: 10px 14px;
  grid-column: 1 / -1;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  color: #7d899d;
  border-top: 1px solid #f0f2f5;
  font-size: 12px;
}
.segment-pagination > span,
.segment-pagination button {
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
.segment-pagination > span {
  min-width: 90px;
}
.visually-hidden {
  position: fixed;
  width: 1px;
  height: 1px;
  opacity: 0;
  pointer-events: none;
}
.segment-dialog-backdrop {
  position: fixed;
  z-index: 1400;
  inset: 0;
  display: grid;
  padding: 20px;
  place-items: center;
  background: #0f172a66;
  backdrop-filter: blur(4px);
}
.segment-dialog {
  max-height: calc(100vh - 40px);
  overflow: auto;
  background: #fff;
  border: 1px solid #dbe4f6;
  border-radius: 18px;
  box-shadow: 0 24px 70px #0f172a38;
}
.segment-dialog > header {
  display: flex;
  padding: 18px 18px 12px;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.segment-dialog h2 {
  margin: 0;
  color: #253047;
  font-size: 19px;
}
.segment-dialog > header p {
  margin: 5px 0 0;
  color: #8490a4;
  font-size: 10px;
}
.segment-dialog > header button {
  display: grid;
  width: 30px;
  height: 30px;
  padding: 0;
  place-items: center;
  color: #7b8798;
  background: transparent;
  border: 0;
  border-radius: 8px;
}
.preview-dialog {
  width: min(520px, 100%);
  padding: 0 16px 16px;
}
.large-preview {
  position: relative;
  display: grid;
  height: 250px;
  place-items: center;
  color: #fff;
  background: linear-gradient(135deg, #be3f4f, #f4884d);
  border-radius: 18px;
  overflow: hidden;
}
.large-preview video {
  width: 100%;
  height: 100%;
  object-fit: contain;
  background: #111827;
}
.preview-load-error {
  display: grid;
  max-width: 360px;
  padding: 20px;
  gap: 10px;
  place-items: center;
  text-align: center;
}
.large-preview small {
  position: absolute;
  right: 14px;
  bottom: 10px;
  font-size: 11px;
}
.preview-meta,
.prompt-dialog-meta {
  display: flex;
  padding: 14px 0;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.preview-meta strong,
.preview-meta small,
.prompt-dialog-meta strong,
.prompt-dialog-meta small {
  display: block;
}
.preview-meta strong,
.prompt-dialog-meta strong {
  color: #334155;
  font-size: 12px;
}
.preview-meta small,
.prompt-dialog-meta small {
  margin-top: 4px;
  color: #8490a4;
  font-size: 9px;
}
.preview-meta em,
.prompt-dialog-meta em {
  padding: 4px 8px;
  color: #4a8b2a;
  background: #f0faea;
  border-radius: 999px;
  font-size: 9px;
  font-style: normal;
  white-space: nowrap;
}
.dialog-note {
  margin: 0;
  padding: 10px 12px;
  color: #8a94a5;
  background: #f5f6f8;
  font-size: 11px;
}
.prompt-dialog {
  width: min(620px, 100%);
  padding: 0 16px 16px;
}
.prompt-dialog-meta {
  border-bottom: 1px solid #e8edf5;
}
.prompt-dialog-meta em {
  color: #3473d4;
  background: #edf4ff;
}
.prompt-dialog pre {
  max-height: 310px;
  margin: 12px 0;
  padding: 14px;
  overflow: auto;
  color: #42526a;
  white-space: pre-wrap;
  background: #f8fafc;
  border: 1px solid #e4e9f1;
  border-radius: 10px;
  font-family: inherit;
  font-size: 11px;
  line-height: 1.75;
}
.prompt-dialog > footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
}
.prompt-dialog > footer button {
  height: 38px;
  padding: 0 18px;
  color: #fff;
  background: #2563eb;
  border: 0;
  border-radius: 9px;
  font-size: 12px;
  font-weight: 800;
}
.repair-dialog {
  width: min(560px, 100%);
  padding: 0 18px 18px;
}
.repair-dialog header > div small {
  display: block;
  margin-top: 4px;
  color: #8793a6;
  font-size: 10px;
}
.repair-dialog-body > p {
  margin: 16px 0;
  color: #65748a;
  font-size: 11px;
  line-height: 1.7;
}
.repair-time-fields {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
.repair-time-fields label,
.repair-instruction-field {
  display: grid;
  gap: 7px;
  color: #485970;
  font-size: 11px;
  font-weight: 700;
}
.repair-time-fields input,
.repair-instruction-field textarea {
  width: 100%;
  color: #34445b;
  background: #fbfcfe;
  border: 1px solid #dbe3ee;
  border-radius: 9px;
  outline: none;
  font: inherit;
  font-weight: 500;
}
.repair-time-fields input {
  height: 40px;
  padding: 0 11px;
}
.repair-instruction-field {
  position: relative;
  margin-top: 14px;
}
.repair-instruction-field textarea {
  min-height: 116px;
  padding: 11px;
  resize: vertical;
  line-height: 1.65;
}
.repair-instruction-field small {
  position: absolute;
  right: 9px;
  bottom: 8px;
  color: #98a3b3;
  font-size: 9px;
  font-weight: 500;
}
.repair-dialog > footer {
  display: flex;
  margin-top: 16px;
  justify-content: flex-end;
  gap: 8px;
}
.repair-dialog > footer button {
  display: inline-flex;
  height: 38px;
  padding: 0 15px;
  align-items: center;
  gap: 6px;
  color: #56657b;
  background: #fff;
  border: 1px solid #dbe3ee;
  border-radius: 9px;
  font-size: 10px;
  font-weight: 800;
}
.repair-dialog > footer button.primary {
  color: #fff;
  background: #2563eb;
  border-color: #2563eb;
}
.repair-dialog > footer button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}
.spin {
  animation: segment-spin 0.75s linear infinite;
}
@keyframes segment-spin {
  to {
    transform: rotate(360deg);
  }
}
@media (max-width: 1180px) {
  .segment-heading,
  .segment-toolbar {
    align-items: stretch;
    flex-wrap: wrap;
  }
  .segment-heading__actions {
    width: 100%;
    flex-wrap: wrap;
  }
  .segment-filter-controls {
    order: 3;
    width: 100%;
    flex-wrap: wrap;
  }
  .segment-search {
    flex: 1;
  }
}
@media (max-width: 980px) {
  .render-settings-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .segment-stats,
  .segment-task-list {
    grid-template-columns: 1fr;
  }
  .segment-task-card,
  .segment-toolbar,
  .segment-pagination {
    grid-column: 1;
  }
}
@media (max-width: 760px) {
  .effect-segment-render-node {
    padding: 18px;
    border-radius: 20px;
  }
  .segment-heading__actions,
  .product-switcher,
  .product-switcher select,
  .secondary-button,
  .start-render-button {
    width: 100%;
  }
  .product-switcher select {
    flex: 1;
  }
  .segment-stats {
    grid-template-columns: 1fr;
  }
  .render-settings-grid {
    grid-template-columns: 1fr;
  }
  .segment-task-card {
    min-height: 0;
    grid-template-columns: 1fr;
  }
  .video-placeholder {
    width: 100%;
    grid-column: 1;
  }
  .task-main {
    grid-column: 1;
  }
  .task-actions {
    width: 100%;
    margin-left: 0;
    flex-wrap: wrap;
    justify-content: flex-start;
  }
  .segment-search,
  .segment-filter,
  .segment-filter select {
    width: 100%;
  }
  .filtered-result-count {
    margin-left: 0;
  }
  .segment-dialog-backdrop {
    padding: 10px;
  }
}

/* 素材画廊 */
.segment-workspace {
  display: grid;
  margin-top: 14px;
  grid-template-columns: minmax(0, 1fr);
  align-items: start;
  gap: 14px;
}
.segment-material-panel {
  min-width: 0;
  background: #fff;
  border: 1px solid #dfe6f1;
  border-radius: 15px;
}
.segment-material-panel {
  overflow: hidden;
}
.segment-toolbar {
  display: flex;
  min-height: 56px;
  padding: 9px 12px;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  background: #f7f9fc;
  border: 0;
  border-bottom: 1px solid #e4e9f1;
  border-radius: 0;
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
.prompt-result-count {
  margin-right: auto;
  color: #8b95a5;
  font-size: 12px;
}
.toolbar-result-stats {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.toolbar-result-stats > span {
  display: inline-flex;
  min-height: 26px;
  padding: 0 9px;
  align-items: center;
  gap: 4px;
  color: #397761;
  background: #eef9f4;
  border: 1px solid #d2ebdf;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 700;
}
.toolbar-result-stats > span.danger {
  color: #b5545a;
  background: #fff3f2;
  border-color: #f1d2cf;
}
.toolbar-result-stats i {
  width: 5px;
  height: 5px;
  background: #27a176;
  border-radius: 50%;
}
.toolbar-result-stats .danger i {
  background: #df5b61;
}
.toolbar-result-stats strong {
  font-size: 11px;
}
.purpose-filter-bar {
  display: flex;
  padding: 8px 12px 10px;
  flex-wrap: wrap;
  gap: 7px;
  background: #fff;
  border-bottom: 1px solid #edf0f5;
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
.purpose-filter-bar .abnormal-purpose-filter {
  color: #b85a60;
  background: #fff7f6;
  border-color: #efd2cf;
}
.purpose-filter-bar .abnormal-purpose-filter.active {
  color: #c83f49;
  background: #fff0ef;
  border-color: #edaeaa;
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
.compatible-purpose-toggle.disabled {
  color: #aab4c3;
  cursor: not-allowed;
}
.segment-filter-controls {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 8px;
}
.segment-search {
  width: min(300px, 38vw);
}
.segment-search,
.segment-filter {
  display: flex;
  height: 36px;
  align-items: center;
  color: #8390a5;
  background: #fff;
  border: 1px solid #dbe3ef;
  border-radius: 9px;
}
.segment-search svg {
  flex: 0 0 auto;
  margin-left: 10px;
}
.segment-search input,
.segment-filter select {
  width: 100%;
  height: 100%;
  color: #42526a;
  background: transparent;
  border: 0;
  outline: none;
  font-size: 10px;
}
.segment-search input {
  padding: 0 10px 0 7px;
}
.segment-filter select {
  min-width: 132px;
  padding: 0 26px 0 10px;
}
.filtered-result-count {
  color: #8a97aa;
  font-size: 10px;
  white-space: nowrap;
}
.selection-mode-button,
.selection-action-bar button {
  display: inline-flex;
  height: 34px;
  padding: 0 11px;
  align-items: center;
  justify-content: center;
  gap: 5px;
  color: #4f5f75;
  background: #fff;
  border: 1px solid #d8e1ee;
  border-radius: 8px;
  font-size: 10px;
  font-weight: 700;
  white-space: nowrap;
}
.selection-mode-button.active {
  color: #2563eb;
  background: #edf4ff;
  border-color: #9ebdf9;
}
.selection-action-bar {
  display: flex;
  min-height: 43px;
  padding: 6px 12px;
  align-items: center;
  gap: 8px;
  color: #52647c;
  background: #eff5ff;
  border-bottom: 1px solid #d8e5fa;
  font-size: 10px;
}
.selection-action-bar span {
  margin-right: auto;
  font-weight: 700;
}
.selection-action-bar button:last-child {
  color: #fff;
  background: #2563eb;
  border-color: #2563eb;
}
.selection-action-bar .delete-selection-button {
  color: #d14d56;
  background: #fff;
  border-color: #efc2c0;
}
.segment-material-grid {
  display: grid;
  padding: 12px;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 11px;
}
.segment-material-card {
  position: relative;
  min-width: 0;
  overflow: hidden;
  background: #fff;
  border: 1px solid #e1e6ee;
  border-radius: 12px;
  transition: 0.18s ease;
}
.segment-material-card:hover {
  border-color: #aac2f2;
  box-shadow: 0 8px 18px #315c9c13;
  transform: translateY(-1px);
}
.segment-material-card.abnormal {
  border-color: #f0b9b3;
}
.segment-material-card.selected {
  border-color: #4f83ef;
  box-shadow: 0 0 0 2px #4f83ef1f;
}
.segment-material-card.selectable {
  cursor: pointer;
}
.material-checkbox {
  position: absolute;
  z-index: 3;
  top: 10px;
  left: 10px;
  display: grid;
  width: 22px;
  height: 22px;
  place-items: center;
  background: #ffffffee;
  border-radius: 6px;
  box-shadow: 0 2px 8px #17203330;
}
.material-checkbox input {
  width: 14px;
  height: 14px;
  margin: 0;
  accent-color: #2563eb;
}
.material-preview {
  position: relative;
  display: grid;
  width: 100%;
  aspect-ratio: 16 / 9;
  min-height: 112px;
  place-items: center;
  color: #fff;
  background: linear-gradient(135deg, #c9514f, #ed9445);
  border: 0;
}
.material-preview.running,
.material-preview.pending,
.material-preview.retry {
  background: linear-gradient(135deg, #5f7cae, #7ea6df);
}
.material-preview.danger {
  background: linear-gradient(135deg, #be4f55, #e2786d);
}
.material-preview:disabled {
  opacity: 1;
}
.material-preview > svg {
  filter: drop-shadow(0 2px 6px #17203340);
}
.material-preview > small {
  position: absolute;
  right: 9px;
  bottom: 7px;
  color: #fff;
  font-size: 9px;
  font-weight: 800;
}
.material-status-pill {
  position: absolute;
  top: 8px;
  right: 8px;
  padding: 3px 7px;
  color: #fff;
  background: #1720337a;
  border-radius: 999px;
  font-size: 8px;
  font-weight: 800;
}
.material-status-pill.danger {
  background: #a72e38d9;
}
.material-status-pill.retry {
  background: #b6751bd9;
}
.material-card-body {
  min-height: 112px;
  padding: 10px 11px 8px;
}
.material-card-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.material-card-title strong {
  overflow: hidden;
  color: #29364b;
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.material-card-title span {
  color: #9aa5b6;
  font-size: 9px;
}
.material-card-body > p {
  margin: 4px 0 8px;
  overflow: hidden;
  color: #8290a5;
  font-size: 9px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.task-tags {
  display: flex;
  gap: 5px;
}
.task-tags span {
  padding: 3px 6px;
  border-radius: 5px;
  font-size: 8px;
  font-weight: 700;
}
.task-tags .primary-tag {
  color: #e5505a;
  background: #fff5f4;
  border: 1px solid #f3b5b5;
}
.origin-tag {
  color: #7d5a22;
  background: #fff7df;
  border: 1px solid #f1d89a;
}
.origin-tag.ai {
  color: #287194;
  background: #edf9fd;
  border-color: #b8dfeb;
}
.compatible-purpose-tags {
  display: flex;
  margin: 7px 0 0;
  align-items: center;
  flex-wrap: wrap;
  gap: 5px;
}
.compatible-purpose-tags small {
  color: #8995a8;
  font-size: 8px;
}
.compatible-purpose-tags span {
  padding: 2px 6px;
  color: #6656a8;
  background: #f4f1ff;
  border: 1px solid #ded6fb;
  border-radius: 999px;
  font-size: 8px;
}
.task-error {
  display: flex;
  margin-top: 7px;
  align-items: flex-start;
  gap: 4px;
  color: #c34850;
  font-size: 8px;
  line-height: 1.45;
}
.repair-status {
  display: flex;
  margin-top: 7px;
  align-items: center;
  gap: 5px;
  color: #7653b8;
  font-size: 8px;
  line-height: 1.45;
}
.repair-status.ready {
  color: #28755c;
}
.repair-status.failed {
  color: #c34850;
}
.material-progress {
  height: 4px;
  margin-top: 9px;
  overflow: hidden;
  background: #e7ecf4;
  border-radius: 999px;
}
.material-progress i {
  display: block;
  height: 100%;
  background: #4f83ef;
  border-radius: inherit;
}
.material-card-actions {
  display: flex;
  min-height: 35px;
  padding: 0 10px;
  align-items: center;
  justify-content: flex-end;
  gap: 9px;
  flex-wrap: wrap;
  background: #fafbfd;
  border-top: 1px solid #edf0f5;
}
.material-card-actions button {
  padding: 0;
  color: #425679;
  background: transparent;
  border: 0;
  font-size: 8px;
  font-weight: 700;
}
.material-card-actions button:last-child {
  color: #d5535b;
}
.segment-batch-empty,
.segment-empty-filter {
  display: flex;
  min-height: 330px;
  padding: 32px;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  color: #8693a7;
  text-align: center;
}
.segment-batch-empty > span {
  display: grid;
  width: 50px;
  height: 50px;
  margin-bottom: 12px;
  place-items: center;
  color: #2563eb;
  background: #eaf2ff;
  border-radius: 14px;
}
.segment-batch-empty strong,
.segment-empty-filter strong {
  color: #314058;
  font-size: 14px;
}
.segment-batch-empty p,
.segment-empty-filter span {
  max-width: 460px;
  margin: 7px 0 0;
  font-size: 10px;
  line-height: 1.7;
}
.segment-pagination {
  display: flex;
  min-height: 52px;
  padding: 8px 12px;
  align-items: center;
  justify-content: flex-end;
  gap: 7px;
  border-top: 1px solid #edf0f5;
  font-size: 9px;
}
.segment-pagination button {
  height: 32px;
  border-radius: 8px;
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
.segment-transfer-backdrop {
  position: fixed;
  z-index: 1450;
  inset: 0;
  display: flex;
  justify-content: flex-end;
  background: #0f172a55;
  backdrop-filter: blur(3px);
}
.segment-transfer-drawer {
  display: flex;
  width: min(460px, 100%);
  height: 100%;
  padding: 0 20px;
  overflow: auto;
  flex-direction: column;
  color: #34445b;
  background: #fff;
  box-shadow: -18px 0 55px #17203325;
}
.segment-transfer-drawer > header {
  display: flex;
  min-height: 82px;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  border-bottom: 1px solid #e7ecf3;
}
.segment-transfer-drawer > header > div {
  display: flex;
  align-items: center;
  gap: 10px;
}
.segment-transfer-drawer > header > div > span {
  display: grid;
  width: 36px;
  height: 36px;
  flex: 0 0 auto;
  place-items: center;
  color: #2563eb;
  background: #eaf2ff;
  border-radius: 10px;
}
.segment-transfer-drawer h2 {
  margin: 0;
  font-size: 16px;
}
.segment-transfer-drawer header p {
  margin: 4px 0 0;
  color: #8793a6;
  font-size: 9px;
}
.segment-transfer-drawer > header > button {
  display: grid;
  width: 32px;
  height: 32px;
  padding: 0;
  flex: 0 0 auto;
  place-items: center;
  color: #778397;
  background: #f5f7fa;
  border: 0;
  border-radius: 8px;
}
.import-dropzone {
  display: flex;
  min-height: 168px;
  margin-top: 18px;
  padding: 20px;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  color: #697991;
  background: #f8fbff;
  border: 1px dashed #9bbbf5;
  border-radius: 13px;
  text-align: center;
}
.import-dropzone > span {
  display: grid;
  width: 48px;
  height: 48px;
  margin-bottom: 10px;
  place-items: center;
  color: #2563eb;
  background: #e7f0ff;
  border-radius: 14px;
}
.import-dropzone strong {
  color: #35445c;
  font-size: 12px;
}
.import-dropzone small {
  margin-top: 6px;
  color: #8a96a9;
  font-size: 9px;
}
.transfer-loading {
  display: flex;
  min-height: 70px;
  align-items: center;
  justify-content: center;
  gap: 7px;
  color: #75849a;
  font-size: 10px;
}
.transfer-section-heading {
  display: flex;
  margin-bottom: 9px;
  align-items: center;
  justify-content: space-between;
}
.transfer-section-heading strong {
  color: #35445c;
  font-size: 11px;
}
.transfer-section-heading span {
  color: #8b97a8;
  font-size: 9px;
}
.import-review-list {
  margin-top: 18px;
}
.import-review-list article {
  display: grid;
  padding: 10px;
  grid-template-columns: 27px minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  background: #fbfcfe;
  border: 1px solid #e3e8f0;
  border-radius: 9px;
}
.import-review-list article + article {
  margin-top: 7px;
}
.import-review-list article.unmatched {
  background: #fff7f6;
  border-color: #f0c5c0;
}
.import-review-list article > span {
  display: grid;
  width: 27px;
  height: 27px;
  place-items: center;
  color: #5c79a4;
  background: #edf3fb;
  border-radius: 7px;
}
.import-review-list strong,
.import-review-list small {
  display: block;
}
.import-review-list strong {
  overflow: hidden;
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.import-review-list small {
  margin-top: 3px;
  color: #8a96a9;
  font-size: 8px;
}
.import-review-list em {
  color: #3e7e5c;
  font-size: 8px;
  font-style: normal;
  font-weight: 700;
}
.import-review-list article.conflict em {
  color: #b46d1b;
}
.import-review-list article.unmatched em {
  color: #c24c54;
}
.export-section {
  margin-top: 20px;
  padding-bottom: 16px;
  border-bottom: 1px solid #edf0f4;
}
.export-section > label {
  display: grid;
  min-height: 48px;
  padding: 8px 10px;
  grid-template-columns: 18px minmax(0, 1fr) auto;
  align-items: center;
  gap: 7px;
  color: #42526a;
  background: #fafbfd;
  border: 1px solid #e4e9f1;
  border-radius: 9px;
  font-size: 10px;
  font-weight: 700;
}
.export-section > label + label {
  margin-top: 7px;
}
.export-section input {
  width: 14px;
  height: 14px;
  margin: 0;
  accent-color: #2563eb;
}
.export-section small {
  color: #8a96a9;
  font-size: 8px;
  font-weight: 500;
}
.export-section label.disabled {
  opacity: 0.5;
}
.transfer-note {
  display: flex;
  margin-top: 18px;
  padding: 10px;
  align-items: flex-start;
  gap: 7px;
  color: #7a6646;
  background: #fff9eb;
  border: 1px solid #f1dfb4;
  border-radius: 9px;
}
.transfer-note svg {
  flex: 0 0 auto;
  margin-top: 1px;
}
.transfer-note p {
  margin: 0;
  font-size: 9px;
  line-height: 1.6;
}
.segment-transfer-drawer > footer {
  display: flex;
  min-height: 74px;
  margin-top: auto;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  border-top: 1px solid #e7ecf3;
}
.segment-transfer-drawer > footer button {
  display: inline-flex;
  height: 38px;
  padding: 0 15px;
  align-items: center;
  gap: 5px;
  color: #56657b;
  background: #fff;
  border: 1px solid #dbe3ee;
  border-radius: 9px;
  font-size: 10px;
  font-weight: 800;
}
.segment-transfer-drawer > footer button.primary {
  color: #fff;
  background: #2563eb;
  border-color: #2563eb;
}
@media (max-width: 900px) {
  .segment-material-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}
@media (max-width: 680px) {
  .segment-toolbar,
  .segment-filter-controls {
    align-items: stretch;
    flex-direction: column;
  }
  .prompt-search,
  .segment-search,
  .segment-filter,
  .segment-filter select,
  .selection-mode-button {
    width: 100%;
  }
  .segment-material-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .selection-action-bar {
    flex-wrap: wrap;
  }
  .selection-action-bar span {
    width: 100%;
  }
  .segment-transfer-drawer {
    padding: 0 14px;
  }
}
@media (max-width: 480px) {
  .repair-time-fields {
    grid-template-columns: 1fr;
  }
  .segment-material-grid {
    grid-template-columns: 1fr;
  }
}
</style>
