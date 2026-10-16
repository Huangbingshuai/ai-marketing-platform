<script setup lang="ts">
import WorkflowPageLoading from '../../../platform/workflow/components/WorkflowPageLoading.vue';
import { computed, nextTick, onActivated, onDeactivated, onBeforeUnmount, ref, watch } from 'vue';
import { AlertCircle, ArrowLeft, CheckCircle2, ChevronLeft, ChevronRight, Download, Film, Layers, LoaderCircle, Play, RefreshCw, X } from '@lucide/vue';
import type {
  ApiResponse,
  EffectTemplateMixWorkspaceData,
  EffectWorkflowBranchTreeData,
  FinalOutputExportProgress,
  FinalOutputResolution,
  FinalOutputRun,
  SyncFinalOutputData,
} from '@ai-marketing/contracts';
import { WorkflowNodeFooter, WorkflowRunProgress } from '@ai-marketing/ui';
import { apiUrl, requestJson } from '../../../api/http-client';
import { requestActionConfirmation } from '../../../shared/composables/action-confirmation';
import EffectTemplateMixThumbnail from '../template-mix/EffectTemplateMixThumbnail.vue';
import { readMixTemplateCatalog, type MixTemplateCatalog } from '../template-mix/effect-template-mix-template-catalog';
import { effectBranchNavigationMatches, type EffectBranchNavigation } from '../shared/effect-branch-navigation';
import type { EffectOutputFreshness } from '../shared/effect-canvas-freshness';
import { outputFileDescription, outputPackagingLabel, outputTemplateStatus } from './effect-final-output-status';
import { activateEffectWorkflowBranch } from '../../../platform/workflow/api/workflow-working.api';
import {
  readTemplateDeleted, withoutDeletedMixCatalog, withoutDeletedMixTemplates,
} from '../shared/effect-template-deletion';

const props = defineProps<{
  projectId: string;
  workflowRunId: string;
  branchNavigation?: EffectBranchNavigation | null;
}>();
const emit = defineEmits<{
  back: [templateId?: string];
  preview: [selection: { workflowRunId: string; templateId: string; variantId: string }];
  workflowRunChange: [selection?: { workflowRunId: string; templateId: string }];
  freshness: [state: EffectOutputFreshness];
}>();
const OUTPUT_PAGE_SIZE_OPTIONS = [5, 10, 20, 50, 100] as const;
type OutputPreviewClip = {
  fileObjectId: string;
  time: number;
  contentHash: string;
  version?: string;
};
type OutputTemplateCard = {
  templateId: string;
  templateName: string;
  run: FinalOutputRun | undefined;
  pendingLabel: string;
  pendingTitle: string;
  pendingDetail: string;
};
const runs = ref<FinalOutputRun[]>([]),
  outputWorkflowRunId = ref(props.workflowRunId),
  selectedTemplateId = ref(''),
  selectedRunId = ref(''),
  mixWorkspace = ref<EffectTemplateMixWorkspaceData | null>(null),
  templateDirectory = ref<MixTemplateCatalog>({ entries: [], workflowRunIds: {}, pendingAddedMaterialIds: {}, workspaces: {} }),
  resolution = ref<FinalOutputResolution>('720p'),
  frameRate = ref<24 | 25 | 30 | 50 | 60>(30),
  page = ref(1),
  pageSize = ref(20),
  selectionMode = ref(false),
  selectedItemIds = ref<Set<string>>(new Set()),
  batchDownloading = ref(false),
  settingsByTemplate = ref(new Map<string, { resolution: FinalOutputResolution; frameRate: 24 | 25 | 30 | 50 | 60 }>());
const acceptedTemplateDeletions = new Map<string, Set<string>>();
const deletedTemplateIds = () => acceptedTemplateDeletions.get(props.projectId) ?? new Set<string>();
const deletionNotice = ref('');
const loading = ref(true),
  mixLoading = ref(true),
  busy = ref(false),
  exportStarting = ref(false),
  liveExport = ref<FinalOutputExportProgress | null>(null),
  itemRerenderingId = ref(''),
  previewItem = ref<FinalOutputRun['items'][number] | null>(null),
  previewLoading = ref(false),
  previewError = ref(''),
  error = ref(''),
  mixError = ref('');
const previewCloseButton = ref<HTMLButtonElement | null>(null);
const outputWorkspaceElement = ref<HTMLElement | null>(null);
let previewDialogTrigger: HTMLElement | null = null;
const templates = computed(() => {
  const latestByTemplate = new Map<string, FinalOutputRun>();
  for (const outputRun of runs.value) {
    if (outputRun.backgroundExportSourceRunId) continue;
    if (!latestByTemplate.has(outputRun.templateId))
      latestByTemplate.set(outputRun.templateId, outputRun);
  }
  if (!mixWorkspace.value) return [];
  const workspaceTemplates = templateDirectory.value.entries;
  const cards: OutputTemplateCard[] = workspaceTemplates.map((entry) => {
    const outputRun = latestByTemplate.get(entry.id);
    const variants = entry.workspace.variants;
    const hasIncompleteVariant = variants.some(
      (variant) =>
        !variant.slots.length ||
        variant.slots.some((slot) => !variant.bindings[slot.id]),
    );
    const pendingLabel = entry.needsAiFill
      ? '待重新智能填充'
      : entry.packagingLocked
        ? '待完成校验'
        : !variants.length
          ? '尚未创建成片工程'
          : hasIncompleteVariant
            ? '待完成混剪'
          : '待成片包装';
    const pendingTitle = entry.needsAiFill
      ? '模板需要重新智能填充'
      : entry.packagingLocked
        ? '该模板尚未进入成片输出'
        : !variants.length
          ? '该模板尚未创建成片工程'
          : hasIncompleteVariant
            ? '该模板还有未完成的混剪工程'
          : '该模板还没有待渲染成片';
    const pendingDetail = entry.needsAiFill
      ? '返回模板混剪，先按当前模板配置重新智能填充，再做智能成片包装。'
      : entry.packagingLocked
        ? '成片包装已启动。返回模板混剪，等待该模板全部包装成功，成片会自动进入这里。'
        : !variants.length
          ? '返回模板混剪，通过智能填充或新建成片创建工程；包装成功后会自动补齐音画。'
          : hasIncompleteVariant
            ? '返回模板混剪，补齐工程的素材槽位，然后进行智能成片包装。'
      : '返回模板混剪，智能填充成功后成片工程会自动进入这里；随后可继续智能成片包装。';
    return {
      templateId: entry.id,
      templateName: entry.workspace.template.name,
      run: outputRun,
      pendingLabel,
      pendingTitle,
      pendingDetail,
    };
  });
  return cards;
});
const templateRuns = computed(() => {
  const currentRun = templates.value.find(({ templateId }) => templateId === selectedTemplateId.value)?.run;
  return currentRun ? [currentRun] : [];
});
const run = computed(() => templateRuns.value.find((r) => r.id === selectedRunId.value) ?? templateRuns.value[0]);
const selectedTemplate = computed(
  () => templates.value.find(({ templateId }) => templateId === selectedTemplateId.value),
);
const pageLoading = computed(() => loading.value || mixLoading.value);
const active = computed(() => run.value && ['QUEUED', 'RUNNING'].includes(run.value.status));
const backgroundExport = computed(() => runs.value.find((entry) =>
  entry.backgroundExportSourceRunId === run.value?.workflowRunId &&
  entry.templateId === selectedTemplateId.value));
const currentExport = computed(() => {
  const live = liveExport.value;
  const full = backgroundExport.value;
  const latest = live && live.backgroundExportSourceRunId === run.value?.workflowRunId &&
    live.templateId === selectedTemplateId.value &&
    (!full || Date.parse(live.createdAt) >= Date.parse(full.createdAt)) ? live : full;
  if (exportStarting.value && exportAttempt && latest &&
    Date.parse(latest.createdAt) < exportAttempt.startedAt - 5000) return undefined;
  return latest;
});
const exportActive = computed(() => Boolean(currentExport.value &&
  ['PENDING_RENDER', 'QUEUED', 'RUNNING'].includes(currentExport.value.status)));
const exportPublishing = computed(() => Boolean(currentExport.value?.status === 'COMPLETED' &&
  !currentExport.value.backgroundExportPublished));
const exportProgressVisible = computed(() => exportStarting.value || Boolean(currentExport.value &&
  currentExport.value.status !== 'COMPLETED'));
const localProgressVisible = computed(() => Boolean(run.value &&
  ['QUEUED', 'RUNNING', 'FAILED', 'PARTIAL', 'CANCELLED'].includes(run.value.status)));
const staleItems = computed(() => run.value?.items.filter((item) => item.stale) ?? []);
const pendingProjects = computed(() => run.value?.projectChanges?.added ?? []);
const removedItemIds = computed(() => new Set(run.value?.projectChanges?.removedItemIds ?? []));
const canLocalUpdate = computed(() => Boolean(run.value?.projectChanges &&
  (['COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED'].includes(run.value.status) ||
    (run.value.status === 'PENDING_RENDER' && run.value.items.some((item) => item.fileObjectId && item.assetId))) &&
  run.value.counts.stale));
const pageCount = computed(() => Math.max(1, Math.ceil((run.value?.items.length ?? 0) / pageSize.value)));
const visibleItems = computed(() => {
  const source = run.value;
  if (!source) return [];
  // The first export runs on a child branch. Show its live delivery state against the
  // source's stable film order while the original branch remains selected.
  if (source.status !== 'PENDING_RENDER' || !currentExport.value) return source.items;
  const delivered = new Map(currentExport.value.items.map((item) => [item.variantId, item]));
  return source.items.map((item) => ({ ...item, ...delivered.get(item.variantId) }));
});
const items = computed(() => visibleItems.value.slice((page.value - 1) * pageSize.value, page.value * pageSize.value));
const downloadableItems = computed(() =>
  visibleItems.value.filter((item) => item.status === 'COMPLETED' && Boolean(item.fileObjectId)),
);
const selectedItems = computed(() =>
  downloadableItems.value.filter((item) => selectedItemIds.value.has(item.id)),
);
const allDownloadableSelected = computed(() =>
  downloadableItems.value.length > 0 && downloadableItems.value.every((item) => selectedItemIds.value.has(item.id)),
);
const displayName = (item: FinalOutputRun['items'][number]) => {
  const index = run.value?.items.findIndex(({ variantId }) => variantId === item.variantId) ?? -1;
  return index < 0 ? '成片' : `成片 ${String(index + 1).padStart(2, '0')}`;
};
const openTimelinePreview = (variantId: string) => {
  if (run.value) emit('preview', { workflowRunId: run.value.workflowRunId, templateId: run.value.templateId, variantId });
};
const activateOutputCard = (item: FinalOutputRun['items'][number], event: Event) => {
  if (!item.fileObjectId) {
    openTimelinePreview(item.variantId);
    return;
  }
  previewDialogTrigger = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
  previewItem.value = item;
  previewLoading.value = true;
  previewError.value = '';
  void nextTick(() => previewCloseButton.value?.focus());
};
const closePreviewDialog = (restoreFocus = true) => {
  previewItem.value = null;
  previewLoading.value = false;
  previewError.value = '';
  const trigger = previewDialogTrigger;
  previewDialogTrigger = null;
  if (restoreFocus) void nextTick(() => trigger?.isConnected && trigger.focus());
};
const handlePreviewVideoError = () => {
  previewLoading.value = false;
  previewError.value = '成片加载失败，请稍后重试';
};
const averageProgress = (value?: Pick<FinalOutputRun, 'items'> | FinalOutputExportProgress | null) => value?.items.length
  ? Math.floor(value.items.reduce((sum, item) => sum + item.progress, 0) / value.items.length)
  : 0;
const exportProgress = computed(() => averageProgress(currentExport.value));
const localProgress = computed(() => averageProgress(run.value));
const exportProgressSummary = computed(() => {
  const current = currentExport.value;
  if (!current) return `${run.value?.status === 'PENDING_RENDER' ? '导出成片' : '重新导出成片'} · 正在创建任务`;
  return `${run.value?.status === 'PENDING_RENDER' ? '导出成片' : '重新导出成片'} · ${labels[current.status]} · ${current.counts.completed} / ${current.counts.total} 条完成`;
});
const localProgressSummary = computed(() => {
  const current = run.value;
  if (!current) return '成片任务处理中';
  const action = backgroundExport.value ? '局部更新成片' : '成片输出';
  return `${action} · ${labels[current.status]} · ${current.counts.completed} / ${current.counts.total} 条完成`;
});
const exportProgressWarning = computed(() => currentExport.value?.counts.failed
  ? `${currentExport.value.counts.failed} 条成片失败或取消`
  : '');
const localProgressWarning = computed(() => run.value?.counts.failed
  ? `${run.value.counts.failed} 条成片失败或取消`
  : '');
const labels: Record<string, string> = {
  PENDING_RENDER: '待渲染',
  QUEUED: '排队中',
  RUNNING: '渲染中',
  COMPLETED: '已完成',
  FAILED: '失败',
  PARTIAL: '部分完成',
  CANCELLED: '已取消',
};
const statusTone = (status: string) => {
  if (status === 'COMPLETED') return 'success';
  if (status === 'FAILED' || status === 'CANCELLED' || status === 'PARTIAL') return 'danger';
  if (status === 'RUNNING') return 'running';
  return 'pending';
};
const base = computed(() => `/projects/${props.projectId}/workflows/effect/final-output`);
const fileUrl = (id: string) => apiUrl(`/projects/${props.projectId}/file-objects/${id}/content`);
let timer: ReturnType<typeof setTimeout> | undefined;
let exportTimer: ReturnType<typeof setTimeout> | undefined;
let controller: AbortController | undefined;
let mixController: AbortController | undefined;
let exportController: AbortController | undefined;
let generation = 0,
  mixGeneration = 0,
  exportGeneration = 0,
  mounted = true;
let initialActivationHandled = false;
const pendingExportNavigation = new Set<string>();
let openingExportRunId = '';
let exportAttempt: { projectId: string; sourceRunId: string; templateId: string; startedAt: number } | null = null;
const exportRetryKeys = new Map<string, string>();
const outputSyncChannel = typeof BroadcastChannel === 'undefined' ? null
  : new BroadcastChannel('effect-final-output-sync');
async function refreshExportProgress() {
  const sourceRunId = run.value?.workflowRunId;
  const templateId = selectedTemplateId.value;
  const projectId = props.projectId;
  const current = ++exportGeneration;
  clearTimeout(exportTimer);
  exportController?.abort();
  exportController = new AbortController();
  if (!sourceRunId || !templateId || !mounted) {
    liveExport.value = null;
    return;
  }
  try {
    const result = await requestJson<ApiResponse<FinalOutputExportProgress | null>>(
      `${base.value}/export-progress?sourceWorkflowRunId=${encodeURIComponent(sourceRunId)}&templateId=${encodeURIComponent(templateId)}`,
      { operation: '读取成片导出进度', signal: exportController.signal },
    );
    if (current !== exportGeneration || projectId !== props.projectId ||
      sourceRunId !== run.value?.workflowRunId || templateId !== selectedTemplateId.value) return;
    liveExport.value = result.data;
    if (result.data) {
      const attempt = exportAttempt;
      if (attempt?.projectId === projectId && attempt.sourceRunId === sourceRunId &&
        attempt.templateId === templateId &&
        Date.parse(result.data.createdAt) >= attempt.startedAt - 5000) {
        pendingExportNavigation.add(result.data.id);
        exportStarting.value = false;
      }
      if (['PENDING_RENDER', 'QUEUED', 'RUNNING'].includes(result.data.status))
        pendingExportNavigation.add(result.data.id);
      if (pendingExportNavigation.has(result.data.id) && result.data.status === 'COMPLETED' &&
        result.data.backgroundExportPublished)
        await viewExportBranch(result.data);
    }
  } catch {
    // The full output read remains the fallback while this small status request is unavailable.
  } finally {
    if (current === exportGeneration && mounted)
      exportTimer = setTimeout(() => { void refreshExportProgress(); },
        exportStarting.value || exportActive.value || exportPublishing.value ? 2500 : 15000);
  }
}
async function refresh(): Promise<boolean> {
  const current = ++generation;
  controller?.abort();
  controller = new AbortController();
  clearTimeout(timer);
  try {
    const result = await requestJson<ApiResponse<FinalOutputRun[]>>(
      `${base.value}?workflowRunId=${encodeURIComponent(outputWorkflowRunId.value)}`,
      { operation: '读取成片输出', signal: controller.signal },
    );
    if (current !== generation) return false;
    runs.value = result.data.filter((entry) => !deletedTemplateIds().has(entry.templateId));
    // The POST may still be waiting for its response (or the following refresh) after the
    // server has created the child. The read path is authoritative for its progress.
    const attempt = exportAttempt;
    if (attempt && attempt.projectId === props.projectId) {
      const observed = runs.value.find((entry) =>
        entry.backgroundExportSourceRunId === attempt.sourceRunId &&
        entry.templateId === attempt.templateId &&
        Date.parse(entry.createdAt) >= attempt.startedAt - 5000);
      if (observed) {
        pendingExportNavigation.add(observed.id);
        exportStarting.value = false;
      }
    }
    if (mounted) emit('freshness', { projectId: props.projectId, workflowRunId: props.workflowRunId, runs: runs.value });
    const savedSettings = new Map(settingsByTemplate.value);
    for (const template of templates.value) {
      if (template.run && !savedSettings.has(template.templateId)) {
        savedSettings.set(template.templateId, {
          resolution: template.run.resolution,
          frameRate: template.run.frameRate,
        });
      }
    }
    settingsByTemplate.value = savedSettings;
    error.value = '';
    if (!templates.value.some((r) => r.templateId === selectedTemplateId.value))
      selectedTemplateId.value = templates.value[0]?.templateId ?? '';
    if (!templateRuns.value.some((r) => r.id === selectedRunId.value))
      selectedRunId.value = templateRuns.value[0]?.id ?? '';
    // Follow only an export started here or observed in progress. Reopening historical
    // deliveries and completing an in-place local update must not navigate the workflow.
    for (const entry of runs.value) {
      if (entry.backgroundExportSourceRunId &&
        ['PENDING_RENDER', 'QUEUED', 'RUNNING'].includes(entry.status))
        pendingExportNavigation.add(entry.id);
    }
    const completedExport = runs.value.find((entry) =>
      pendingExportNavigation.has(entry.id) && entry.templateId === selectedTemplateId.value &&
      entry.status === 'COMPLETED' &&
      (!entry.backgroundExportSourceRunId || entry.backgroundExportPublished));
    if (completedExport) await viewExportBranch(completedExport);
    return current === generation;
  } catch (reason) {
    if (current === generation && !(reason instanceof DOMException && reason.name === 'AbortError'))
      error.value = reason instanceof Error ? reason.message : '读取输出失败';
    return false;
  } finally {
    if (current === generation) {
      loading.value = false;
      if (mounted) timer = setTimeout(() => {
        // Mix catalog reads can outlast this timer. Refresh them on activation or
        // explicit source changes so a slow read is not cancelled forever.
        void refresh();
      }, exportStarting.value || exportActive.value || exportPublishing.value ? 30000 : 8000);
    }
  }
}
async function refreshMixWorkspace(): Promise<EffectTemplateMixWorkspaceData | null> {
  const current = ++mixGeneration;
  mixController?.abort();
  const requestController = new AbortController();
  mixController = requestController;
  const projectId = props.projectId;
  const scopeId = props.workflowRunId;
  if (!mixWorkspace.value) mixLoading.value = true;
  try {
    const [result, tree] = await Promise.all([requestJson<ApiResponse<EffectTemplateMixWorkspaceData>>(
      `/projects/${projectId}/workflows/effect/template-mix?workflowRunId=${encodeURIComponent(scopeId)}`,
      { operation: '读取混剪成片预览', signal: requestController.signal },
    ), requestJson<ApiResponse<EffectWorkflowBranchTreeData>>(
      `/projects/${projectId}/workflow-runs/effect/branches`,
      { operation: '读取模板当前路径', signal: requestController.signal },
    )]);
    const directory = await readMixTemplateCatalog(tree.data, scopeId, result.data,
      async (workflowRunId) => (await requestJson<ApiResponse<EffectTemplateMixWorkspaceData>>(
        `/projects/${projectId}/workflows/effect/template-mix?workflowRunId=${encodeURIComponent(workflowRunId)}`,
        { operation: '读取模板当前工程', signal: requestController.signal },
      )).data, scopeId);
    if (current === mixGeneration && mounted && projectId === props.projectId && scopeId === props.workflowRunId) {
      mixWorkspace.value = { ...result.data,
        draft: withoutDeletedMixTemplates(result.data.draft, deletedTemplateIds()) };
      templateDirectory.value = withoutDeletedMixCatalog(directory, deletedTemplateIds());
      mixError.value = '';
      if (!templates.value.some(({ templateId }) => templateId === selectedTemplateId.value))
        selectedTemplateId.value = templates.value[0]?.templateId ?? '';
      return result.data;
    }
  } catch (reason) {
    if (current === mixGeneration && !(reason instanceof DOMException && reason.name === 'AbortError')) {
      // A transient background refresh failure must not blank a usable preview.
      mixError.value = reason instanceof Error ? reason.message : '读取混剪模板失败';
    }
  } finally {
    if (current === mixGeneration) mixLoading.value = false;
  }
  return null;
}
/** Repair a missed background sync when the output page is entered after a network interruption. */
async function reconcilePending(): Promise<void> {
  const projectId = props.projectId;
  const workflowRunId = props.workflowRunId;
  const workspace = await refreshMixWorkspace();
  if (!workspace || !mounted || projectId !== props.projectId ||
    workflowRunId !== props.workflowRunId) return;
  try {
    const directory = templateDirectory.value;
    await Promise.all(directory.entries.map(async entry => {
      const sourceRunId = directory.workflowRunIds[entry.id];
      const source = directory.workspaces[sourceRunId ?? ''];
      if (!sourceRunId || !source || !entry.workspace.variants.length) return;
      await requestJson<ApiResponse<SyncFinalOutputData>>(
        `/projects/${projectId}/workflows/effect/final-output/sync`, {
          method: 'POST', operation: '对齐待渲染成片',
          body: { workflowRunId: sourceRunId, templateId: entry.id,
            expectedDraftRevision: source.draftRevision },
        },
      );
    }));
    if (mounted && projectId === props.projectId &&
      workflowRunId === props.workflowRunId) await refresh();
  } catch (reason) {
    if (mounted && projectId === props.projectId && workflowRunId === props.workflowRunId)
      mixError.value = reason instanceof Error ? reason.message : '待渲染成片暂未同步';
  }
}
const refreshAll = () => {
  void reconcilePending();
  void refresh();
};
const outputChanged = (value: unknown) => {
  const receipt = readTemplateDeleted(value);
  if (receipt && receipt.projectId === props.projectId) {
    const deleted = acceptedTemplateDeletions.get(receipt.projectId) ?? new Set<string>();
    // CustomEvent and BroadcastChannel can carry the same acceptance; consume it only once.
    if (deleted.has(receipt.templateId)) return;
    deleted.add(receipt.templateId);
    acceptedTemplateDeletions.set(receipt.projectId, deleted);
    ++generation; controller?.abort();
    ++mixGeneration; mixController?.abort();
    loading.value = false;
    mixLoading.value = false;
    const wasSelected = selectedTemplateId.value === receipt.templateId;
    for (const entry of runs.value.filter(run => run.templateId === receipt.templateId))
      pendingExportNavigation.delete(entry.id);
    runs.value = runs.value.filter(run => run.templateId !== receipt.templateId);
    templateDirectory.value = withoutDeletedMixCatalog(templateDirectory.value, deleted);
    if (mixWorkspace.value) mixWorkspace.value = { ...mixWorkspace.value,
      draft: withoutDeletedMixTemplates(mixWorkspace.value.draft, deleted) };
    settingsByTemplate.value.delete(receipt.templateId);
    if (receipt.removedWorkflowRunIds?.includes(outputWorkflowRunId.value) ||
      (!receipt.removedWorkflowRunIds && outputWorkflowRunId.value === receipt.sourceWorkflowRunId &&
        outputWorkflowRunId.value !== receipt.workflowRunId))
      outputWorkflowRunId.value = receipt.workflowRunId;
    if (wasSelected) {
      closePreviewDialog(false);
      selectedTemplateId.value = templateDirectory.value.entries[0]?.id ?? '';
      selectedRunId.value = templateRuns.value[0]?.id ?? '';
      selectedItemIds.value = new Set();
      selectionMode.value = false;
      liveExport.value = null;
      exportStarting.value = false;
      exportAttempt = null;
      error.value = '';
      mixError.value = '';
    }
    deletionNotice.value = '模板及其成片已移除，后台清理已安排；其他成片可继续操作。';
    // Kept-alive pages retain the receipt but do not start network work while hidden.
    if (mounted) {
      emit('freshness', { projectId: props.projectId, workflowRunId: props.workflowRunId, runs: runs.value });
      void refresh();
      if (!receipt.removedWorkflowRunIds?.includes(props.workflowRunId)) void refreshMixWorkspace();
    }
    return;
  }
  const scope = value as { projectId?: string; workflowRunId?: string } | null;
  if (!mounted || scope?.projectId !== props.projectId ||
    (scope.workflowRunId !== props.workflowRunId &&
      !Object.values(templateDirectory.value.workflowRunIds).includes(scope.workflowRunId ?? ''))) return;
  // Update film warnings first. Workbench/history and tree reads are secondary and used to
  // compete with the same output query after every timeline save, especially across tabs.
  void refresh().then(() => {
    if (mounted && scope.projectId === props.projectId &&
      (scope.workflowRunId === props.workflowRunId ||
        Object.values(templateDirectory.value.workflowRunIds).includes(scope.workflowRunId ?? '')))
      void refreshMixWorkspace();
  });
};
if (outputSyncChannel) outputSyncChannel.onmessage = (event: MessageEvent) => outputChanged(event.data);
const savedOutputSource = (event: Event) => outputChanged((event as CustomEvent).detail);
window.addEventListener('effect-final-output-sync', savedOutputSource);
const previewClips = (item: FinalOutputRun['items'][number]): OutputPreviewClip[] => {
  const entry = templateDirectory.value.entries.find(({ id }) => id === run.value?.templateId);
  const variant = entry?.workspace.variants.find(({ id }) => id === item.variantId);
  if (!entry || !variant) return item.cover ? [item.cover] : [];
  const mixMaterials = new Map(entry.workspace.materials.map(material => [material.id, material]));
  const clips = variant.slots
    .map((slot) => {
      const material = mixMaterials.get(variant.bindings[slot.id] ?? '');
      return material?.available ? { fileObjectId: material.fileObjectId,
        time: Math.max(0, (variant.offsets[slot.id] ?? 0) + Math.min(0.12, slot.duration / 2)),
        contentHash: material.contentHash, version: `${material.artifactRevision}:${material.contentHash}` } : null;
    })
    .filter((clip): clip is NonNullable<typeof clip> => Boolean(clip));
  if (!clips.length) return item.cover ? [item.cover] : [];
  const sampleIndexes = [...new Set([0, Math.floor((clips.length - 1) / 2), clips.length - 1])];
  return sampleIndexes.map((index) => clips[index]!);
};
const previewVersion = (clip: OutputPreviewClip) => clip.version ?? clip.contentHash;
function toggleSelectionMode() {
  selectionMode.value = !selectionMode.value;
  if (!selectionMode.value) selectedItemIds.value = new Set();
}
function toggleItemSelection(itemId: string) {
  const next = new Set(selectedItemIds.value);
  if (next.has(itemId)) next.delete(itemId);
  else next.add(itemId);
  selectedItemIds.value = next;
}
function toggleSelectAllDownloadable() {
  selectedItemIds.value = allDownloadableSelected.value
    ? new Set()
    : new Set(downloadableItems.value.map((item) => item.id));
}
function downloadSelected() {
  if (!selectedItems.value.length || batchDownloading.value) return;
  batchDownloading.value = true;
  for (const item of selectedItems.value) {
    if (!item.fileObjectId) continue;
    const anchor = document.createElement('a');
    anchor.href = `${fileUrl(item.fileObjectId)}?download=true`;
    anchor.download = `${displayName(item)}.mp4`;
    anchor.style.display = 'none';
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  }
  window.setTimeout(() => { batchDownloading.value = false; }, 700);
}
async function retryFailedOutputs() {
  if (!run.value || busy.value) return;
  busy.value = true;
  try {
    await requestJson(`${base.value}/${run.value.id}/retry`, {
      method: 'POST',
      operation: '恢复失败输出',
    });
    await refresh();
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : '输出操作失败';
  } finally {
    busy.value = false;
  }
}
async function startRender() {
  if (!run.value || exportAttempt || exportStarting.value || exportActive.value || exportPublishing.value || busy.value) return;
  const selected = run.value;
  const projectId = props.projectId;
  const workflowRunId = props.workflowRunId;
  const settings = { resolution: resolution.value, frameRate: frameRate.value };
  const isCurrent = () => mounted && props.projectId === projectId &&
    props.workflowRunId === workflowRunId && run.value?.id === selected.id &&
    selectedTemplateId.value === selected.templateId;
  const rerender = selected.status !== 'PENDING_RENDER';
  let attempt: { projectId: string; sourceRunId: string; templateId: string; startedAt: number } | null = null;
  exportStarting.value = true;
  try {
    if (rerender) {
      const confirmed = await requestActionConfirmation({
        eyebrow: '重新导出成片',
        title: `重新导出 ${selected.counts.total} 条成片？`,
        description:
          '将按最新已保存的混剪工程和当前分辨率与帧率重新渲染全部成片（包括待更新成片）。原有成片保持可用，也可以继续局部更新。',
        confirmLabel: '确认重新导出',
        tone: 'warning',
      });
      if (!confirmed || !isCurrent()) return;
    }
    if (!isCurrent()) return;
    attempt = { projectId, sourceRunId: selected.workflowRunId,
      templateId: selected.templateId, startedAt: Date.now() };
    exportAttempt = attempt;
    void refreshExportProgress();
    const retryScope = `${projectId}:${selected.id}:${settings.resolution}:${settings.frameRate}`;
    const idempotencyKey = exportRetryKeys.get(retryScope) ?? crypto.randomUUID();
    exportRetryKeys.set(retryScope, idempotencyKey);
    const response = await requestJson<ApiResponse<FinalOutputRun>>(
      `/projects/${projectId}/workflows/effect/final-output/${selected.id}/render`,
      {
        method: 'POST',
        operation: rerender ? '重新导出成片' : '开始导出成片',
        headers: { 'Idempotency-Key': idempotencyKey },
        body: settings,
        signal: AbortSignal.timeout(120_000),
      },
    );
    if (!isCurrent()) return;
    exportRetryKeys.delete(retryScope);
    error.value = '';
    exportStarting.value = false;
    pendingExportNavigation.add(response.data.id);
    runs.value = [...runs.value.filter((entry) => entry.id !== response.data.id),
      { ...response.data, backgroundExportSourceRunId: selected.workflowRunId }];
    void refresh();
  } catch (reason) {
    if (!isCurrent()) return;
    if (!currentExport.value)
      error.value = reason instanceof DOMException && reason.name === 'TimeoutError'
        ? '创建任务响应超时，正在核对任务状态；可以稍后重试，重复请求不会创建第二批成片'
        : reason instanceof Error ? reason.message : '启动成片渲染失败';
    void refresh();
  } finally {
    if (!attempt || exportAttempt === attempt) {
      exportStarting.value = false;
      exportAttempt = null;
    }
  }
}
async function viewExportBranch(exported: FinalOutputRun | FinalOutputExportProgress) {
  if (exported.status !== 'COMPLETED' ||
    (exported.backgroundExportSourceRunId && !exported.backgroundExportPublished) ||
    !mounted || busy.value || openingExportRunId) return;
  const projectId = props.projectId;
  const sourceWorkflowRunId = props.workflowRunId;
  const templateId = selectedTemplateId.value;
  openingExportRunId = exported.id;
  busy.value = true;
  try {
    await activateEffectWorkflowBranch(projectId, exported.workflowRunId);
    if (projectId !== props.projectId || sourceWorkflowRunId !== props.workflowRunId ||
      templateId !== selectedTemplateId.value || !mounted) return;
    pendingExportNavigation.delete(exported.id);
    outputWorkflowRunId.value = exported.workflowRunId;
    emit('workflowRunChange', { workflowRunId: exported.workflowRunId, templateId: exported.templateId });
    await refresh();
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : '读取新成片版本失败';
  } finally {
    if (openingExportRunId === exported.id) openingExportRunId = '';
    busy.value = false;
  }
}
function handleProgressAction() {
  outputWorkspaceElement.value?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function handleLocalProgressAction() {
  if (!backgroundExport.value && run.value?.counts.failed && !active.value) {
    void retryFailedOutputs();
    return;
  }
  handleProgressAction();
}
async function rerenderItem(item: FinalOutputRun['items'][number]) {
  if (!run.value || busy.value || active.value || itemRerenderingId.value) return;
  const confirmed = await requestActionConfirmation({
    eyebrow: '重新渲染成片',
    title: `重新渲染「${displayName(item)}」？`,
    description: '将按这条成片已保存的分辨率与帧率重新渲染，完成后覆盖原有成片。',
    confirmLabel: '确认重新渲染',
    tone: 'warning',
  });
  if (!confirmed) return;
  itemRerenderingId.value = item.id;
  try {
    await requestJson(`${base.value}/${run.value.id}/items/${item.id}/render`, {
      method: 'POST',
      operation: '重新渲染成片',
    });
    await refresh();
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : '重新渲染成片失败';
  } finally {
    itemRerenderingId.value = '';
  }
}
async function localUpdate(itemIds: string[], syncProjects = false) {
  if (!run.value || !canLocalUpdate.value || busy.value ||
      (!itemIds.length && !syncProjects)) return;
  const targetId = run.value.id;
  const projectId = props.projectId;
  const workflowRunId = props.workflowRunId;
  busy.value = true;
  try {
    // KeepAlive can still show the previous saved draft when the user returns from
    // refinement. Confirm only after the server has supplied the latest revision.
    if (!(await refresh())) return;
    if (!mounted || props.projectId !== projectId || props.workflowRunId !== workflowRunId ||
      run.value?.id !== targetId || error.value || !canLocalUpdate.value) return;
    const target = run.value;
    const selected = run.value.items.filter((item) => itemIds.includes(item.id) && item.stale);
    if (selected.length !== new Set(itemIds).size) {
      error.value = '成片状态已变化，请刷新后重试';
      return;
    }
    const removed = target.projectChanges?.removedItemIds ?? [];
    const removeCount = syncProjects ? removed.length : selected.filter((item) => removed.includes(item.id)).length;
    const addCount = syncProjects ? target.projectChanges?.added.length ?? 0 : 0;
    const renderCount = selected.filter((item) => !removed.includes(item.id)).length + addCount;
    const expectedDraftRevision = target.projectChanges?.draftRevision;
    const confirmed = await requestActionConfirmation({
      eyebrow: '局部更新成片',
      title: `局部更新成片（新增 ${addCount} 条，修改 ${renderCount - addCount} 条，删除 ${removeCount} 条）？`,
      description: `将读取当前混剪工程，在当前分支移除已删除工程的成片，并渲染新增或选中的变更工程，其他成片和历史分支不变。素材变更时仅重做受影响槽位的选区、口播和字幕。${renderCount ? '此操作会产生生成或渲染费用。' : '仅删除，不启动渲染任务。'}`,
      confirmLabel: '确认局部更新',
      tone: 'warning',
    });
    if (!confirmed || !mounted || props.projectId !== projectId ||
      props.workflowRunId !== workflowRunId || run.value?.id !== target.id) return;
    await requestJson(`/projects/${projectId}/workflows/effect/final-output/${target.id}/local-update`, {
      method: 'POST', operation: '局部更新成片', body: { itemIds, ...(syncProjects ? { syncProjects: true } : {}),
        ...(expectedDraftRevision !== undefined ? { expectedDraftRevision } : {}) },
    });
    error.value = '';
    await refresh();
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : '局部更新成片失败';
  } finally {
    busy.value = false;
  }
}
function stop() {
  mounted = false;
  ++generation;
  ++mixGeneration;
  controller?.abort();
  mixController?.abort();
  ++exportGeneration;
  exportController?.abort();
  closePreviewDialog(false);
  clearTimeout(timer);
  clearTimeout(exportTimer);
}
watch(
  () => [props.projectId, props.workflowRunId] as const,
  ([projectId], previousScope) => {
    deletionNotice.value = '';
    // The parent adopts this page's completed export child Run. Keep the already-visible output
    // state in place while the parent refreshes its workflow context; this is not a user branch
    // navigation and must not blank the page or flash its loading state.
    if (previousScope?.[0] === projectId && runs.value.length && mixWorkspace.value &&
      outputWorkflowRunId.value === props.workflowRunId) {
      void refreshMixWorkspace();
      void refresh();
      return;
    }
    runs.value = [];
    liveExport.value = null;
    outputWorkflowRunId.value = props.workflowRunId;
    pendingExportNavigation.clear();
    selectedTemplateId.value = '';
    selectedRunId.value = '';
    closePreviewDialog(false);
    settingsByTemplate.value = new Map();
    selectedItemIds.value = new Set();
    selectionMode.value = false;
    mixWorkspace.value = null;
    templateDirectory.value = { entries: [], workflowRunIds: {}, pendingAddedMaterialIds: {}, workspaces: {} };
    mixLoading.value = true;
    mixError.value = '';
    loading.value = true;
    page.value = 1;
    void reconcilePending();
    void refresh();
  },
  { immediate: true },
);
let lastBranchNavigation: EffectBranchNavigation | null = null;
watch([() => props.branchNavigation, loading, mixLoading, templates], () => {
  const target = props.branchNavigation;
  if (!effectBranchNavigationMatches(target, props.projectId, props.workflowRunId) ||
    target.nodeId !== 'FINAL_OUTPUT' || target === lastBranchNavigation ||
    loading.value || mixLoading.value || error.value || mixError.value) return;
  lastBranchNavigation = target;
  if (target.templateId && templates.value.some(({ templateId }) => templateId === target.templateId))
    selectedTemplateId.value = target.templateId;
  else if (target.templateId) {
    selectedTemplateId.value = '';
    error.value = '所选模板不在此成片分支中，请重新选择模板';
  }
}, { flush: 'post' });
watch(selectedTemplateId, () => {
  page.value = 1;
  selectedRunId.value = templateRuns.value[0]?.id ?? '';
});
watch([() => props.projectId, () => run.value?.workflowRunId, selectedTemplateId], () => {
  void refreshExportProgress();
});
watch(selectedRunId, () => {
  page.value = 1;
  selectedItemIds.value = new Set();
  selectionMode.value = false;
});
watch(page, () => closePreviewDialog(false));
watch(() => run.value?.id, () => {
  page.value = 1;
  closePreviewDialog(false);
  selectedItemIds.value = new Set();
  selectionMode.value = false;
  if (run.value) {
    const saved = settingsByTemplate.value.get(run.value.templateId);
    resolution.value = saved?.resolution ?? run.value.resolution;
    frameRate.value = saved?.frameRate ?? run.value.frameRate;
  }
});
watch([resolution, frameRate], ([nextResolution, nextFrameRate]) => {
  if (!run.value) return;
  settingsByTemplate.value.set(run.value.templateId, {
    resolution: nextResolution,
    frameRate: nextFrameRate,
  });
});
onActivated(() => {
  mounted = true;
  // The immediate scope watcher already starts the first reads during setup. Avoid a second
  // workspace/tree reconciliation cancelling those reads and delaying the stale item controls.
  if (!initialActivationHandled) {
    initialActivationHandled = true;
    return;
  }
  // KeepAlive retains the old preview; entering from the mix workbench must reload its saved draft.
  void reconcilePending();
  void refresh();
  void refreshExportProgress();
});
onDeactivated(stop);
onBeforeUnmount(() => {
  stop(); outputSyncChannel?.close();
  window.removeEventListener('effect-final-output-sync', savedOutputSource);
});
</script>

<template>
  <section class="final-output" aria-labelledby="final-output-title">
    <header class="output-heading">
      <div class="output-heading__title">
        <span class="step">06</span>
        <div>
          <h2 id="final-output-title">成片输出</h2>
          <p>按模板隔离待渲染成片，设置分辨率与帧率后统一导出</p>
        </div>
      </div>
    </header>

    <div v-if="error || mixError" class="notice" role="alert">
      <AlertCircle :size="17" />
      <span>{{ error || mixError }}</span>
      <button class="secondary-button" type="button" @click="refreshAll">
        <RefreshCw :size="14" />重新读取
      </button>
    </div>
    <p v-if="deletionNotice" class="deletion-notice" role="status">
      <CheckCircle2 :size="16" />{{ deletionNotice }}
    </p>

    <WorkflowPageLoading
      v-if="pageLoading"
      icon="output"
      :min-height="360"
      title="正在读取成片输出"
      description="正在读取当前工作流的混剪模板和成片任务…"
    />
    <section v-else-if="!templates.length && !error && !mixError" class="page-state empty-state">
      <span class="state-icon"><Film :size="25" /></span>
      <h3>暂无混剪模板</h3>
      <p>完成模板混剪后，模板会按原有顺序显示在这里；每个模板的成片任务彼此独立。</p>
      <button class="secondary-button" type="button" @click="$emit('back', selectedTemplateId)">
        <ArrowLeft :size="14" />返回模板混剪
      </button>
    </section>

    <template v-else-if="templates.length">
      <div class="output-layout">
        <aside class="template-sidebar" aria-label="模板列表">
          <header class="template-sidebar__heading">
            <h3>我的模板</h3>
            <span>{{ templates.length }}</span>
          </header>
          <div class="template-list" role="tablist" aria-label="选择模板">
            <button
              v-for="template in templates"
              :key="template.templateId"
              class="template-card"
              :class="{ selected: selectedTemplateId === template.templateId }"
              type="button"
              role="tab"
              :aria-selected="selectedTemplateId === template.templateId"
              @click="selectedTemplateId = template.templateId"
            >
              <Layers :size="18" />
              <span class="template-card__copy">
                <strong>{{ template.templateName }}</strong>
                <small v-if="template.run" :class="{ 'template-update-label': template.run.counts.stale > 0 }">{{ outputTemplateStatus(template.run) }}</small>
                <small v-else>{{ template.pendingLabel }}</small>
              </span>
            </button>
          </div>
        </aside>

        <main class="output-main">
          <template v-if="run">
          <label v-if="templateRuns.length > 1" class="batch-select">
            <span>输出批次</span>
            <select v-model="selectedRunId" aria-label="选择输出批次">
              <option v-for="r in templateRuns" :key="r.id" :value="r.id">
                {{ new Date(r.createdAt).toLocaleString() }} · {{ labels[r.status] }} · {{ r.counts.total }} 条
              </option>
            </select>
          </label>
      <section class="render-settings" aria-label="成片输出设置">
        <div class="render-settings__copy">
          <span class="settings-icon"><Film :size="18" /></span>
          <div>
            <h3>成片输出设置</h3>
            <p v-if="run.status === 'PENDING_RENDER'">设置仅作用于左侧选中的模板；导出后将渲染 {{ run.counts.total }} 条成片</p>
            <p v-else-if="exportActive || exportPublishing">正在重新导出全部成片，原有成片仍可用</p>
            <p v-else-if="active">成片任务正在进行，可在下方查看进度</p>
            <p v-else>可调整分辨率与帧率；按当前模板工作流版本的工程重新导出全部成片</p>
          </div>
        </div>
        <label>
          <span>分辨率</span>
          <select v-model="resolution" :disabled="exportStarting || exportActive || exportPublishing" aria-label="成片分辨率">
            <option value="480p">480P</option><option value="720p">720P</option><option value="1080p">1080P</option>
            <option value="2K">2K</option><option value="4K">4K</option>
          </select>
        </label>
        <label>
          <span>帧率</span>
          <select v-model.number="frameRate" :disabled="exportStarting || exportActive || exportPublishing" aria-label="成片帧率">
            <option :value="24">24 fps</option><option :value="25">25 fps</option><option :value="30">30 fps</option><option :value="50">50 fps</option><option :value="60">60 fps</option>
          </select>
        </label>
        <button
          class="primary-button export-button"
          type="button"
          :disabled="exportStarting || exportActive || exportPublishing || busy"
          @click="startRender"
        >
          <LoaderCircle v-if="exportStarting || exportActive || exportPublishing" class="spin" :size="15" />
          <RefreshCw v-else-if="run.status !== 'PENDING_RENDER'" :size="15" />
          <Play v-else :size="15" />{{ currentExport && (exportActive || exportPublishing) ? `${run.status === 'PENDING_RENDER' ? '导出中' : '重新导出中'} ${currentExport.counts.completed}/${currentExport.counts.total}` : exportStarting ? '正在创建任务…' : run.status !== 'PENDING_RENDER' ? `重新导出成片（${run.counts.total}）` : `导出成片（${run.counts.total}）` }}
        </button>
      </section>
      <WorkflowRunProgress
        v-if="exportProgressVisible"
        class="output-run-progress"
        :progress="exportProgress"
        :summary="exportProgressSummary"
        :attempt-label="`按当前混剪工程${run.status === 'PENDING_RENDER' ? '导出' : '重新渲染'}全部 ${run.counts.total} 条成片`"
        :warning="exportProgressWarning"
        action-label="查看成片列表"
        @show-details="handleProgressAction"
      />
      <WorkflowRunProgress
        v-if="localProgressVisible"
        class="output-run-progress"
        tone="update"
        :progress="localProgress"
        :summary="localProgressSummary"
        :attempt-label="backgroundExport ? '仅更新当前选中的成片；整批导出独立进行' : '成片任务进度'"
        :warning="localProgressWarning"
        :action-label="localProgressWarning ? '恢复失败项' : '查看成片列表'"
        @show-details="handleLocalProgressAction"
      />

      <section ref="outputWorkspaceElement" class="output-workspace" aria-labelledby="output-list-title">
        <header class="workspace-heading">
          <div>
            <h3 id="output-list-title">{{ run.status === 'PENDING_RENDER' && !currentExport ? '待渲染成片' : '成片列表' }}</h3>
            <p v-if="run.counts.stale">{{ run.counts.stale }} 条成片待更新<span v-if="run.projectChanges?.added.length || run.projectChanges?.removedItemIds.length">（新增 {{ run.projectChanges?.added.length ?? 0 }} 条，删除 {{ run.projectChanges?.removedItemIds.length ?? 0 }} 条）</span>；局部更新后同步当前分支，其他成片不变。</p>
            <p v-else>{{ run.status === 'PENDING_RENDER' ? '智能填充后的成片工程已同步；未包装条目可先导出仅画面成片，包装成功后会自动补齐音画' : '在左侧选择模板，查看并播放该模板输出的成片' }}</p>
          </div>
          <div class="workspace-heading__actions">
            <button
              v-if="canLocalUpdate"
              class="secondary-button local-update-button"
              type="button"
              :disabled="busy"
              @click="localUpdate(staleItems.map((item) => item.id), true)"
            ><RefreshCw :size="14" />局部更新（{{ run.counts.stale }}）</button>
            <button
              v-if="downloadableItems.length"
              class="secondary-button selection-toggle"
              type="button"
              :aria-pressed="selectionMode"
              @click="toggleSelectionMode"
            >{{ selectionMode ? '退出选择' : '选择成片' }}</button>
            <span class="result-count">第 {{ page }} / {{ pageCount }} 页 · 共 {{ run.counts.total }} 条</span>
          </div>
        </header>
        <div v-if="selectionMode" class="selection-action-bar">
          <span>已选 {{ selectedItems.length }} 条可下载成片</span>
          <button type="button" :disabled="!downloadableItems.length" @click="toggleSelectAllDownloadable">
            {{ allDownloadableSelected ? '取消全选' : '全选成片' }}
          </button>
          <button
            class="primary-button"
            type="button"
            :disabled="!selectedItems.length || batchDownloading"
            @click="downloadSelected"
          ><Download :size="14" />{{ batchDownloading ? '已加入下载' : '批量下载' }}</button>
        </div>
        <section v-if="pendingProjects.length" class="pending-projects" aria-labelledby="pending-projects-title">
          <header class="workspace-heading">
            <h3 id="pending-projects-title">待渲染成片</h3>
            <span class="result-count">新增 {{ pendingProjects.length }} 条</span>
          </header>
          <div class="output-grid">
            <article v-for="project in pendingProjects" :key="project.variantId" class="output-card pending-project-card">
              <button class="output-preview pending-project-preview" type="button"
                :aria-label="`预览${project.name}`" @click="openTimelinePreview(project.variantId)">
                <EffectTemplateMixThumbnail v-if="project.cover" :source="fileUrl(project.cover.fileObjectId)"
                  :time="project.cover.time" :version="previewVersion(project.cover)" :alt="project.name" />
                <Film v-else class="pending-project-placeholder" :size="36" aria-hidden="true" />
                <span class="preview-play-icon" aria-hidden="true"><Play :size="22" /></span>
              </button>
              <div class="output-info">
                <div class="output-card__title">
                  <h4 :title="project.name">{{ project.name }}</h4>
                  <span class="status-pill stale">新增 · 待渲染</span>
                </div>
                <p class="output-meta">{{ Number(project.duration ?? 0).toFixed(1) }} 秒 · 局部更新后渲染</p>
                <p v-if="project.blockedReason" class="item-error" role="status"><AlertCircle :size="13" />{{ project.blockedReason }}</p>
              </div>
            </article>
          </div>
        </section>
        <h3 v-if="pendingProjects.length && items.length" class="delivered-projects-heading">已有成片</h3>
        <div v-if="items.length" class="output-grid">
          <article
            v-for="item in items"
            :key="item.id"
            class="output-card"
            :class="{
              abnormal: item.status === 'FAILED' || item.status === 'CANCELLED',
              selectable: selectionMode && item.status === 'COMPLETED' && Boolean(item.fileObjectId),
              selected: selectedItemIds.has(item.id),
            }"
            tabindex="0"
            :aria-label="`${item.fileObjectId ? '播放' : '预览'}${displayName(item)}`"
            @click="activateOutputCard(item, $event)"
            @keydown.enter.self.prevent="activateOutputCard(item, $event)"
            @keydown.space.self.prevent="activateOutputCard(item, $event)"
          >
            <div class="output-preview" :class="statusTone(item.status)">
              <label
                v-if="selectionMode && item.status === 'COMPLETED' && item.fileObjectId"
                class="output-checkbox"
                @click.stop
              >
                <input
                  type="checkbox"
                  :checked="selectedItemIds.has(item.id)"
                  :aria-label="`选择${displayName(item)}下载`"
                  @change.stop="toggleItemSelection(item.id)"
                />
              </label>
              <span v-if="previewClips(item).length" class="preview-cover preview-montage"
                :style="{ gridTemplateColumns: `repeat(${previewClips(item).length}, minmax(0, 1fr))` }" aria-hidden="true">
                <EffectTemplateMixThumbnail
                  v-for="(clip, clipIndex) in previewClips(item)"
                  :key="`${item.id}:${clip.fileObjectId}:${clip.contentHash}:${page}`"
                  :source="fileUrl(clip.fileObjectId)"
                  :time="clip.time"
                  :version="previewVersion(clip)"
                  :alt="`${displayName(item)} 第 ${clipIndex + 1} 段画面`"
                />
              </span>
              <span class="preview-play-icon" aria-hidden="true"><Play :size="22" /></span>
              <small v-if="item.status === 'PENDING_RENDER'">等待导出</small>
              <small v-else-if="item.status !== 'COMPLETED'">{{ item.progress }}%</small>
            </div>
            <div class="output-info">
              <div class="output-card__title">
                <h4 :title="displayName(item)">{{ displayName(item) }}</h4>
                <span class="status-pill" :class="statusTone(item.status)">
                  {{ labels[item.status] }}
                </span>
                <span v-if="removedItemIds.has(item.id)" class="status-pill stale">待移除</span>
                <span v-else-if="item.stale" class="status-pill stale" title="混剪工程已修改，当前成片仍保留旧文件">待更新</span>
                <span
                  v-if="outputPackagingLabel(item)"
                  class="status-pill"
                  :class="outputPackagingLabel(item)?.tone"
                >{{ outputPackagingLabel(item)?.text }}</span>
              </div>
              <p class="output-meta">{{ outputFileDescription(item, run.status === 'PENDING_RENDER' && currentExport ? currentExport.status : run.status) }}</p>
              <div v-if="item.status !== 'PENDING_RENDER' && item.status !== 'COMPLETED'" class="item-progress">
                <progress :value="item.progress" max="100" :aria-label="`${displayName(item)} 进度`" />
                <strong>{{ item.progress }}%</strong>
              </div>
              <p v-if="item.errorMessage" class="item-error" role="status">
                <AlertCircle :size="13" />{{ item.errorMessage }}
              </p>
              <a
                v-if="item.fileObjectId"
                class="download-button"
                :href="fileUrl(item.fileObjectId) + '?download=true'"
                :download="`${displayName(item)}.mp4`"
                @click.stop
              ><Download :size="14" />下载成片</a>
              <button
                v-if="item.stale && canLocalUpdate"
                class="item-rerender-button item-local-update-button"
                type="button"
                :disabled="busy || active"
                :title="removedItemIds.has(item.id) ? '移除当前分支中的对应成片' : '从当前混剪工程更新并重新渲染这条成片'"
                @click.stop="localUpdate([item.id])"
              ><RefreshCw :size="14" />局部更新</button>
              <button
                v-else-if="run.status !== 'PENDING_RENDER'"
                class="item-rerender-button"
                type="button"
                :disabled="busy || active || Boolean(itemRerenderingId)"
                title="按这条成片已保存的规格重新渲染"
                @click.stop="rerenderItem(item)"
              >
                <LoaderCircle v-if="itemRerenderingId === item.id" class="spin" :size="14" />
                <RefreshCw v-else :size="14" />{{ itemRerenderingId === item.id ? '重新渲染中…' : '重新渲染' }}
              </button>
            </div>
          </article>
        </div>
        <div v-else class="list-empty" role="status">
          <Film :size="22" />当前批次暂无成片条目
        </div>
        <nav v-if="run.items.length" class="prompt-pagination" aria-label="成片分页">
          <label class="prompt-page-size">
            <select v-model.number="pageSize" aria-label="每页显示成片数量" @change="page = 1">
              <option v-for="size in OUTPUT_PAGE_SIZE_OPTIONS" :key="size" :value="size">
                {{ size }} 条/页
              </option>
            </select>
          </label>
          <button type="button" :disabled="page <= 1" aria-label="上一页" @click="page -= 1">
            <ChevronLeft :size="14" />上一页
          </button>
          <strong>第 {{ page }} / {{ pageCount }} 页</strong>
          <button type="button" :disabled="page >= pageCount" aria-label="下一页" @click="page += 1">
            下一页<ChevronRight :size="14" />
          </button>
          <span>共 {{ run.counts.total }} 条</span>
          </nav>
      </section>
      <WorkflowNodeFooter
        back-label="上一步：模板混剪"
        next-label=""
        :show-validate="false"
        :show-next="false"
        @back="$emit('back', selectedTemplateId)"
      />
          </template>
          <section v-else class="template-readiness" role="status">
            <span class="state-icon"><Film :size="25" /></span>
            <span class="readiness-eyebrow">{{ selectedTemplate?.pendingLabel ?? '尚未进入成片输出' }}</span>
            <h3>{{ selectedTemplate?.pendingTitle ?? '该模板还没有待渲染成片' }}</h3>
            <p>{{ selectedTemplate?.pendingDetail ?? '返回模板混剪，完成当前模板的成片包装与校验。' }}</p>
            <button class="secondary-button" type="button" @click="$emit('back', selectedTemplateId)">
              <ArrowLeft :size="14" />返回模板混剪
            </button>
          </section>
        </main>
      </div>
    </template>

    <Teleport to="body">
      <div
        v-if="previewItem"
        class="output-dialog-backdrop"
        @mousedown.self="closePreviewDialog()"
      >
        <section
          class="output-preview-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="output-preview-dialog-title"
          @keydown.esc="closePreviewDialog()"
        >
          <header>
            <div>
              <h2 id="output-preview-dialog-title">{{ displayName(previewItem) }} · 成片预览</h2>
              <p>{{ previewItem.duration.toFixed(1) }} 秒 · {{ run?.resolution }} · {{ run?.frameRate }} fps · H.264 / AAC</p>
            </div>
            <button
              ref="previewCloseButton"
              class="output-preview-dialog__close"
              type="button"
              aria-label="关闭成片预览"
              @click="closePreviewDialog()"
            ><X :size="17" /></button>
          </header>
          <div class="output-dialog__video-frame">
            <video
              v-if="previewItem.fileObjectId && !previewError"
              :src="fileUrl(previewItem.fileObjectId)"
              controls
              autoplay
              playsinline
              preload="metadata"
              aria-label="成片视频播放"
              @canplay="previewLoading = false"
              @error="handlePreviewVideoError"
            />
            <span v-if="previewLoading" class="output-dialog__loading" role="status">
              <LoaderCircle class="spin" :size="32" />
              正在加载成片…
            </span>
            <span v-else-if="previewError" class="output-dialog__error" role="alert">
              <AlertCircle :size="25" />{{ previewError }}
            </span>
          </div>
        </section>
      </div>
    </Teleport>
  </section>
</template>

<style scoped>
.final-output {
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
.output-heading,
.output-heading__title,
.workspace-heading,
.output-card__title,
.item-progress,
.prompt-pagination {
  display: flex;
  align-items: center;
  min-width: 0;
}
.output-heading {
  min-height: 50px;
  margin-bottom: 22px;
  justify-content: space-between;
  gap: 18px;
}
.output-heading__title {
  gap: 14px;
}
.step {
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
.output-heading h2,
.output-heading p {
  margin: 0;
}
.output-heading h2 {
  color: #172033;
  font-size: 21px;
}
.output-heading p {
  margin-top: 5px;
  color: #7d899d;
  font-size: 13px;
}
.output-layout {
  display: grid;
  grid-template-columns: minmax(220px, 250px) minmax(0, 1fr);
  align-items: stretch;
  gap: 18px;
}
.template-sidebar {
  position: sticky;
  top: 12px;
  display: grid;
  min-width: 0;
  padding: 16px;
  grid-template-rows: auto minmax(0, 1fr);
  gap: 12px;
  background: #fbfcfe;
  border: 1px solid #dfe7f4;
  border-radius: 16px;
}
.template-sidebar__heading {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.template-sidebar__heading h3 {
  margin: 0;
  color: #172033;
  font-size: 20px;
  font-weight: 800;
}
.template-sidebar__heading > span {
  color: #7d899d;
  font-size: 11px;
}
.deletion-notice {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  border: 1px solid #b7e6d7;
  border-radius: 12px;
  background: #f0faf6;
  color: #16785b;
  font-size: 13px;
}
.deletion-notice svg { flex-shrink: 0; }
.template-list {
  display: grid;
  min-height: 0;
  align-content: start;
  grid-auto-rows: 72px;
  overflow-y: auto;
  gap: 8px;
}
.output-main {
  min-width: 0;
}
.template-readiness {
  display: flex;
  min-height: 440px;
  padding: 28px;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: 12px;
  color: #7f8da2;
  text-align: center;
  background: #fff;
  border: 1px solid #dfe7f4;
  border-radius: 16px;
}
.readiness-eyebrow {
  margin-top: 3px;
  color: #7d899d;
  font-size: 11px;
  font-weight: 700;
}
.template-readiness h3 {
  margin: 0;
  color: #34445c;
  font-size: 17px;
}
.template-readiness p {
  max-width: 620px;
  margin: 0 0 5px;
  font-size: 12px;
  line-height: 1.7;
}
.template-card {
  display: flex;
  min-width: 0;
  min-height: 72px;
  padding: 12px;
  align-items: flex-start;
  justify-content: flex-start;
  gap: 11px;
  text-align: left;
  border-color: #dbe4f6;
  border-radius: 12px;
  transition: 0.16s ease;
}
.template-card > svg {
  flex: 0 0 auto;
  margin-top: 2px;
  color: #29384f;
}
.template-card__copy {
  display: grid;
  min-width: 0;
  gap: 4px;
}
.template-card__copy strong {
  overflow: hidden;
  color: #172033;
  font-size: 14px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.template-card__copy small {
  color: #7d899d;
  font-size: 10px;
  font-weight: 500;
}
.template-card:hover {
  border-color: #9dbbfa;
}
.template-card.selected {
  color: #2563eb;
  background: #eff5ff;
  border-color: #8bb1ff;
  box-shadow: 0 0 0 2px #2563eb12;
}
.template-card.selected > svg,
.template-card.selected strong {
  color: #2563eb;
}
.batch-select {
  display: grid;
  width: min(360px, 100%);
  margin-bottom: 14px;
  gap: 6px;
  color: #506078;
  font-size: 11px;
  font-weight: 700;
}
.batch-select select {
  width: 100%;
  min-width: 0;
  min-height: 38px;
  padding: 0 10px;
}
button,
select,
a {
  font: inherit;
  font-size: 12px;
  border: 1px solid #dbe4f6;
  border-radius: 10px;
  background: white;
  color: #42526a;
}
.secondary-button,
.primary-button,
.download-button {
  display: inline-flex;
  min-height: 38px;
  padding: 0 14px;
  align-items: center;
  justify-content: center;
  gap: 5px;
  cursor: pointer;
  text-decoration: none;
  font-weight: 700;
}
.secondary-button:hover,
.download-button:hover {
  border-color: #a9c1ef;
  color: #2563eb;
}
.primary-button {
  color: #fff;
  background: var(--effect-blue);
  border-color: var(--effect-blue);
  box-shadow: 0 8px 18px #2563eb2e;
}
.spin {
  animation: spin 1s linear infinite;
}
@keyframes spin {
  to { transform: rotate(360deg); }
}
button:disabled,
select:disabled {
  opacity: 0.52;
  cursor: not-allowed;
}
.notice {
  display: flex;
  margin-bottom: 14px;
  padding: 12px 14px;
  align-items: center;
  gap: 9px;
  color: #a84148;
  background: #fff3f2;
  border: 1px solid #f3c6c4;
  border-radius: 10px;
  font-size: 12px;
}
.notice > span {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}
progress {
  width: 100%;
  height: 8px;
  accent-color: var(--effect-blue);
}
.page-state {
  display: flex;
  min-height: 360px;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  color: #7f8da2;
  text-align: center;
  gap: 10px;
}
.state-icon {
  display: grid;
  width: 48px;
  height: 48px;
  place-items: center;
  color: var(--effect-blue);
  background: #eaf2ff;
  border-radius: 15px;
}
.page-state h3 {
  margin: 2px 0 0;
  color: #34445c;
  font-size: 17px;
}
.page-state p {
  max-width: 560px;
  margin: 0;
  font-size: 12px;
  line-height: 1.7;
}
.render-settings {
  display: flex;
  margin-bottom: 14px;
  padding: 16px;
  align-items: end;
  gap: 14px;
  background: linear-gradient(110deg, #f7faff, #fffaf5);
  border: 1px solid #dce6f5;
  border-radius: 14px;
}
.render-settings__copy {
  display: flex;
  min-width: 220px;
  flex: 1;
  align-items: center;
  gap: 10px;
}
.settings-icon {
  display: grid;
  width: 38px;
  height: 38px;
  flex: 0 0 38px;
  place-items: center;
  color: #2563eb;
  background: #eaf2ff;
  border-radius: 11px;
}
.render-settings h3,
.render-settings p { margin: 0; }
.render-settings h3 { color: #29384f; font-size: 13px; }
.render-settings p { margin-top: 4px; color: #7d899d; font-size: 11px; }
.render-settings p strong { color: #42526a; }
.render-settings label {
  display: grid;
  width: 132px;
  gap: 5px;
  color: #53627a;
  font-size: 10px;
  font-weight: 700;
}
.render-settings select { width: 100%; min-height: 38px; padding: 0 10px; }
.export-button { min-width: 152px; min-height: 40px; }
.output-workspace {
  margin-top: 15px;
  overflow: hidden;
  background: #fff;
  border: 1px solid #e1e6ee;
  border-radius: 16px;
}
.workspace-heading {
  min-height: 68px;
  padding: 13px 16px;
  justify-content: space-between;
  gap: 12px;
  border-bottom: 1px solid #edf0f5;
}
.workspace-heading__actions {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 12px;
}
.selection-toggle {
  flex: 0 0 auto;
  min-height: 34px;
  padding: 0 12px;
}
.selection-action-bar {
  display: flex;
  min-height: 58px;
  padding: 9px 14px;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 10px;
  color: #53627a;
  background: #f3f7ff;
  border-bottom: 1px solid #dce7fb;
  font-size: 12px;
}
.selection-action-bar > span {
  margin-right: auto;
}
.selection-action-bar > button:not(.primary-button) {
  min-height: 36px;
  padding: 0 12px;
  background: #fff;
  cursor: pointer;
}
.selection-action-bar > button:disabled {
  cursor: not-allowed;
}
.selection-action-bar .primary-button {
  min-height: 36px;
  padding: 0 14px;
}
.workspace-heading h3,
.workspace-heading p {
  margin: 0;
}
.workspace-heading h3 {
  color: #29384f;
  font-size: 14px;
}
.workspace-heading p,
.result-count {
  margin-top: 4px;
  color: #7d899d;
  font-size: 11px;
}
.result-count {
  margin: 0;
  white-space: nowrap;
}
.output-grid {
  display: grid;
  align-content: start;
  padding: 12px;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  grid-auto-rows: max-content;
  gap: 11px;
}
.output-card {
  min-width: 0;
  overflow: hidden;
  background: #fff;
  border: 1px solid #e1e6ee;
  border-radius: 12px;
  transition: 0.18s ease;
  cursor: pointer;
}
.output-card:hover {
  border-color: #aac2f2;
  box-shadow: 0 8px 18px #315c9c13;
  transform: translateY(-1px);
}
.output-card.abnormal {
  border-color: #f0b9b3;
}
.output-card.selected {
  border-color: #7da7ff;
  box-shadow: 0 0 0 2px #2563eb1c;
}
.output-card:focus-visible {
  outline: 2px solid #2563eb;
  outline-offset: 2px;
}
.output-preview {
  position: relative;
  display: flex;
  width: 100%;
  aspect-ratio: 9 / 16;
  max-height: 180px;
  min-height: 155px;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  overflow: hidden;
  gap: 8px;
  color: #617fae;
  background: linear-gradient(135deg, #edf3fa, #e4ecf6);
  font-size: 11px;
}
.output-checkbox {
  position: absolute;
  z-index: 2;
  top: 9px;
  left: 9px;
  display: grid;
  width: 30px;
  height: 30px;
  place-items: center;
  background: #ffffffed;
  border: 1px solid #dce5f3;
  border-radius: 8px;
  box-shadow: 0 2px 8px #17203326;
  cursor: pointer;
}
.output-checkbox input {
  width: 16px;
  height: 16px;
  margin: 0;
  accent-color: #2563eb;
  cursor: pointer;
}
.output-preview.running,
.output-preview.pending {
  color: #fff;
  background: linear-gradient(135deg, #5f7cae, #7ea6df);
}
.output-preview.danger {
  color: #fff;
  background: linear-gradient(135deg, #be4f55, #e2786d);
}
.output-preview video {
  width: 100%;
  height: 100%;
  object-fit: contain;
  background: #111827;
}
.preview-cover {
  position: absolute;
  inset: 0;
  overflow: hidden;
}
.preview-montage {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 2px;
  background: #fff;
}
.preview-cover :deep(img),
.preview-cover :deep(.thumbnail-loading) {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.preview-play-icon {
  position: relative;
  z-index: 1;
  display: grid;
  width: 48px;
  height: 48px;
  place-items: center;
  color: #fff;
  background: #172033a8;
  border: 1px solid #ffffffa8;
  border-radius: 50%;
  box-shadow: 0 4px 14px #17203345;
  transition: transform 0.16s ease, background-color 0.16s ease;
}
.output-card:hover .preview-play-icon,
.output-card:focus-visible .preview-play-icon {
  background: #2563ebd9;
  transform: scale(1.08);
}
.output-dialog-backdrop {
  position: fixed;
  z-index: 1400;
  inset: 0;
  display: grid;
  padding: 20px;
  place-items: center;
  background: #0f172a99;
  backdrop-filter: blur(4px);
}
.output-preview-dialog {
  width: min(520px, 100%);
  max-height: calc(100vh - 40px);
  padding: 0 16px 16px;
  overflow: auto;
  background: #fff;
  border: 1px solid #dbe4f6;
  border-radius: 18px;
  box-shadow: 0 24px 70px #0f172a38;
}
.output-preview-dialog > header {
  display: flex;
  padding: 18px 2px 14px;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.output-preview-dialog h2,
.output-preview-dialog p {
  margin: 0;
}
.output-preview-dialog h2 {
  color: #253047;
  font-size: 17px;
}
.output-preview-dialog p {
  margin-top: 5px;
  color: #8490a4;
  font-size: 11px;
}
.output-preview-dialog__close {
  display: grid;
  width: 32px;
  height: 32px;
  flex: 0 0 32px;
  padding: 0;
  place-items: center;
  color: #7b8798;
  background: transparent;
  border: 0;
  border-radius: 8px;
  cursor: pointer;
}
.output-preview-dialog__close:hover {
  color: #253047;
  background: #f1f5f9;
}
.output-dialog__video-frame {
  position: relative;
  display: grid;
  width: auto;
  height: min(62vh, 640px);
  max-width: 100%;
  aspect-ratio: 9 / 16;
  margin: 0 auto;
  place-items: center;
  overflow: hidden;
  color: #5f7cae;
  background: #111827;
  border-radius: 12px;
}
.output-dialog__video-frame video {
  width: 100%;
  height: 100%;
  object-fit: contain;
}
.output-dialog__loading,
.output-dialog__error {
  position: absolute;
  inset: 0;
  display: flex;
  padding: 20px;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: 10px;
  color: #fff;
  background: #111827aa;
  font-size: 12px;
  text-align: center;
}
.output-preview small {
  position: absolute;
  right: 8px;
  bottom: 7px;
  padding: 3px 6px;
  color: #fff;
  background: #1720339c;
  border-radius: 5px;
  font-size: 10px;
}
.output-info {
  min-width: 0;
  padding: 11px 12px 12px;
}
.output-card__title {
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 7px;
}
.pending-projects {
  margin-bottom: 20px;
}
.pending-projects .workspace-heading {
  padding: 0 0 12px;
}
.pending-project-preview {
  border: 0;
  padding: 0;
  cursor: pointer;
}
.pending-project-preview:focus-visible {
  outline: 2px solid #2563eb;
  outline-offset: -2px;
}
.pending-project-preview :deep(img) {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.pending-project-placeholder {
  opacity: .65;
}
.delivered-projects-heading {
  margin: 0 0 12px;
  font-size: 14px;
}
.output-card__title h4 {
  flex: 0 0 auto;
  max-width: 100%;
  min-width: 0;
  margin: 0;
  overflow: hidden;
  color: #253047;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.status-pill {
  flex: 0 0 auto;
  padding: 3px 7px;
  color: #64748b;
  background: #f1f5f9;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 700;
}
.status-pill.success { color: #168365; background: #eaf8f2; }
.status-pill.running { color: #2563eb; background: #edf4ff; }
.status-pill.danger { color: #bc4b50; background: #fff0ef; }
.status-pill.stale { color: #9a5805; background: #fff2d8; }
.template-update-label { color: #b45309 !important; font-weight: 700; }
.status-pill.unpackaged { color: #92650c; background: #fdf6e3; }
.local-update-button { flex: 0 0 auto; color: #9a5805; border-color: #f2d7a8; }
.output-meta {
  margin: 6px 0 0;
  color: #8490a4;
  font-size: 10px;
}
.item-progress {
  margin-top: 9px;
  gap: 8px;
}
.item-progress progress {
  height: 6px;
}
.item-progress strong {
  color: #526078;
  font-size: 10px;
}
.item-error {
  display: flex;
  margin: 8px 0 0;
  align-items: flex-start;
  gap: 5px;
  color: #b42318;
  font-size: 10px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.item-error svg {
  flex: 0 0 auto;
  margin-top: 1px;
}
.download-button {
  width: 100%;
  min-height: 34px;
  margin-top: 9px;
  color: #2563eb;
  border-color: #dbe4f6;
  border-radius: 9px;
  font-size: 11px;
}
.item-rerender-button {
  display: inline-flex;
  width: 100%;
  min-height: 32px;
  margin-top: 6px;
  padding: 0 12px;
  align-items: center;
  justify-content: center;
  gap: 5px;
  color: #42526a;
  background: #fff;
  border: 1px solid #e2e8f3;
  border-radius: 9px;
  cursor: pointer;
  font-size: 11px;
  font-weight: 700;
}
.item-rerender-button:hover:not(:disabled) {
  color: #2563eb;
  border-color: #a9c1ef;
}
.item-local-update-button { color: #9a5805; border-color: #f2d7a8; background: #fffbf3; }
.list-empty {
  display: flex;
  min-height: 180px;
  align-items: center;
  justify-content: center;
  gap: 9px;
  color: #8490a4;
  font-size: 12px;
}
.prompt-pagination {
  min-height: 61px;
  margin-top: 2px;
  padding: 10px 14px;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 10px;
  color: #7d899d;
  border-top: 1px solid #f0f2f5;
  font-size: 12px;
}
.prompt-page-size select,
.prompt-pagination button {
  display: inline-flex;
  min-height: 40px;
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
  cursor: pointer;
}
.prompt-pagination button:disabled {
  color: #a5adba;
  background: #f8fafc;
  cursor: not-allowed;
}
.prompt-pagination strong {
  color: #43536c;
  font-size: 12px;
  white-space: nowrap;
}
@media (max-width: 1200px) {
  .output-layout {
    grid-template-columns: minmax(0, 1fr);
    align-items: start;
  }
  .template-sidebar {
    position: static;
    min-height: 0;
    max-height: none;
  }
  .template-list {
    overflow: visible;
    grid-auto-rows: 72px;
    grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
  }
}
@media (max-width: 900px) {
  .final-output {
    padding: 22px;
    border-radius: 22px;
  }
  .output-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}
@media (max-width: 680px) {
  .final-output {
    margin-top: 12px;
    padding: 18px;
    border-radius: 20px;
  }
  .output-heading,
  .output-heading__title,
  .workspace-heading {
    align-items: flex-start;
    flex-direction: column;
  }
  .workspace-heading__actions {
    width: 100%;
    justify-content: space-between;
    flex-wrap: wrap;
  }
  .selection-action-bar {
    justify-content: flex-start;
  }
  .selection-action-bar > span {
    flex: 1 0 100%;
  }
  .batch-select {
    width: 100%;
  }
  .template-readiness {
    min-height: 320px;
    padding: 22px 16px;
  }
  .render-settings {
    align-items: stretch;
    flex-wrap: wrap;
  }
  .render-settings__copy { flex-basis: 100%; }
  .render-settings label { flex: 1; }
  .export-button { flex: 1 1 100%; }
  .result-count {
    white-space: normal;
  }
  .output-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    padding: 9px;
    gap: 8px;
  }
  .output-preview {
    min-height: 130px;
    max-height: 250px;
  }
  .output-info {
    padding: 9px;
  }
  .output-card__title {
    align-items: flex-start;
    flex-direction: column;
  }
  .prompt-pagination {
    justify-content: center;
  }
  .output-layout {
    gap: 12px;
  }
}
@media (max-width: 480px) {
  .output-grid {
    grid-template-columns: 1fr;
  }
  .output-preview {
    max-height: 360px;
  }
  .notice {
    align-items: flex-start;
    flex-wrap: wrap;
  }
  .notice .secondary-button {
    margin-left: 25px;
  }
}
</style>
