<script setup lang="ts">
import { computed, nextTick, onActivated, onDeactivated, onBeforeUnmount, ref, watch } from 'vue';
import { AlertCircle, ArrowLeft, ChevronLeft, ChevronRight, Download, Film, Layers, LoaderCircle, Play, RefreshCw, X } from '@lucide/vue';
import type {
  ApiResponse,
  EffectTemplateMixMaterial,
  EffectTemplateMixWorkspaceData,
  FinalOutputResolution,
  FinalOutputRun,
  SyncFinalOutputData,
} from '@ai-marketing/contracts';
import { WorkflowNodeFooter } from '@ai-marketing/ui';
import { apiUrl, requestJson } from '../../../api/http-client';
import { requestActionConfirmation } from '../../../shared/composables/action-confirmation';
import EffectTemplateMixThumbnail from '../template-mix/EffectTemplateMixThumbnail.vue';

const props = defineProps<{ projectId: string; workflowRunId: string }>();
const emit = defineEmits<{
  back: [];
  preview: [selection: { templateId: string; variantId: string }];
  workflowRunChange: [];
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
  selectedTemplateId = ref(''),
  selectedRunId = ref(''),
  mixWorkspace = ref<EffectTemplateMixWorkspaceData | null>(null),
  resolution = ref<FinalOutputResolution>('720p'),
  frameRate = ref<24 | 25 | 30 | 50 | 60>(30),
  page = ref(1),
  pageSize = ref(20),
  selectionMode = ref(false),
  selectedItemIds = ref<Set<string>>(new Set()),
  batchDownloading = ref(false),
  settingsByTemplate = ref(new Map<string, { resolution: FinalOutputResolution; frameRate: 24 | 25 | 30 | 50 | 60 }>());
const loading = ref(true),
  mixLoading = ref(true),
  busy = ref(false),
  itemRerenderingId = ref(''),
  previewItem = ref<FinalOutputRun['items'][number] | null>(null),
  previewLoading = ref(false),
  previewError = ref(''),
  error = ref(''),
  mixError = ref('');
const previewCloseButton = ref<HTMLButtonElement | null>(null);
let previewDialogTrigger: HTMLElement | null = null;
const templates = computed(() => {
  const latestByTemplate = new Map<string, FinalOutputRun>();
  for (const outputRun of runs.value) {
    if (!latestByTemplate.has(outputRun.templateId))
      latestByTemplate.set(outputRun.templateId, outputRun);
  }
  if (!mixWorkspace.value) {
    return [...latestByTemplate.values()].map((run) => ({
      templateId: run.templateId,
      templateName: run.templateName,
      run,
      pendingLabel: '',
      pendingTitle: '',
      pendingDetail: '',
    }));
  }
  const workspaceTemplates = mixWorkspace.value?.draft.templates ?? [];
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
        : !variants.length || hasIncompleteVariant
          ? '待完成混剪'
          : '待成片包装';
    const pendingTitle = entry.needsAiFill
      ? '模板需要重新智能填充'
      : entry.packagingLocked
        ? '该模板尚未进入成片输出'
        : !variants.length || hasIncompleteVariant
          ? '该模板还有未完成的混剪工程'
          : '该模板还没有待渲染成片';
    const pendingDetail = entry.needsAiFill
      ? '返回模板混剪，先按当前模板配置重新智能填充，再做智能成片包装。'
      : entry.packagingLocked
        ? '成片包装已启动。返回模板混剪，等待该模板全部包装成功，成片会自动进入这里。'
        : !variants.length || hasIncompleteVariant
          ? '返回模板混剪，补齐工程的素材槽位，然后进行智能成片包装。'
          : '返回模板混剪，为该模板做智能成片包装；包装成功后成片会自动进入这里。';
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
const validateStatusTitle = computed(() => {
  if (!run.value) return '等待成片输出';
  if (run.value.status === 'COMPLETED') return '本批成片已全部导出';
  if (run.value.validated) return '本批成片已全部导出';
  return run.value.status === 'PENDING_RENDER' ? '等待导出成片' : '等待成片导出完成';
});
const pageCount = computed(() => Math.max(1, Math.ceil((run.value?.items.length ?? 0) / pageSize.value)));
const items = computed(() => run.value?.items.slice((page.value - 1) * pageSize.value, page.value * pageSize.value) ?? []);
const downloadableItems = computed(() =>
  run.value?.items.filter((item) => item.status === 'COMPLETED' && Boolean(item.fileObjectId)) ?? [],
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
  if (run.value) emit('preview', { templateId: run.value.templateId, variantId });
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
const progress = computed(() =>
  run.value?.items.length
    ? Math.floor(
        run.value.items.reduce((sum, item) => sum + item.progress, 0) / run.value.items.length,
      )
    : 0,
);
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
const mixMaterials = computed(
  () => new Map((mixWorkspace.value?.materials ?? []).map((material) => [material.id, material])),
);
let timer: ReturnType<typeof setTimeout> | undefined;
let controller: AbortController | undefined;
let mixController: AbortController | undefined;
let generation = 0,
  mixGeneration = 0,
  mounted = true;
const outputSyncChannel = typeof BroadcastChannel === 'undefined' ? null
  : new BroadcastChannel('effect-final-output-sync');
async function refresh() {
  const current = ++generation;
  controller?.abort();
  controller = new AbortController();
  clearTimeout(timer);
  try {
    const result = await requestJson<ApiResponse<FinalOutputRun[]>>(
      `${base.value}?workflowRunId=${props.workflowRunId}`,
      { operation: '读取成片输出', signal: controller.signal },
    );
    if (current !== generation) return;
    runs.value = result.data;
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
  } catch (reason) {
    if (current === generation && !(reason instanceof DOMException && reason.name === 'AbortError'))
      error.value = reason instanceof Error ? reason.message : '读取输出失败';
  } finally {
    if (current === generation) {
      loading.value = false;
      if (mounted) timer = setTimeout(() => void refresh(), 4000);
    }
  }
}
async function refreshMixWorkspace(): Promise<EffectTemplateMixWorkspaceData | null> {
  const current = ++mixGeneration;
  mixController?.abort();
  mixController = new AbortController();
  if (!mixWorkspace.value) mixLoading.value = true;
  try {
    const result = await requestJson<ApiResponse<EffectTemplateMixWorkspaceData>>(
      `/projects/${props.projectId}/workflows/effect/template-mix?workflowRunId=${encodeURIComponent(props.workflowRunId)}`,
      { operation: '读取混剪成片预览', signal: mixController.signal },
    );
    if (current === mixGeneration) {
      mixWorkspace.value = result.data;
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
    const response = await requestJson<ApiResponse<SyncFinalOutputData>>(
      `/projects/${projectId}/workflows/effect/final-output/sync`, {
        method: 'POST', operation: '对齐待渲染成片',
        body: { workflowRunId, expectedDraftRevision: workspace.draftRevision },
      },
    );
    if (!response.data.superseded && mounted && projectId === props.projectId &&
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
if (outputSyncChannel) outputSyncChannel.onmessage = (event: MessageEvent) => {
  const scope = event.data as { projectId?: string; workflowRunId?: string } | null;
  if (!mounted || scope?.projectId !== props.projectId ||
    scope.workflowRunId !== props.workflowRunId) return;
  void refreshMixWorkspace();
  void refresh();
};
const previewClips = (item: FinalOutputRun['items'][number]): OutputPreviewClip[] => {
  const entry = mixWorkspace.value?.draft.templates.find(({ id }) => id === run.value?.templateId);
  const variant = entry?.workspace.variants.find(({ id }) => id === item.variantId);
  if (!entry || !variant) return item.cover ? [item.cover] : [];
  const clips = variant.slots
    .map((slot) => mixMaterials.value.get(variant.bindings[slot.id] ?? ''))
    .filter((material): material is EffectTemplateMixMaterial => Boolean(material?.available))
    .map((material) => ({
      fileObjectId: material.fileObjectId,
      time: Math.min(0.12, material.duration / 2),
      contentHash: material.contentHash,
      version: `${material.artifactRevision}:${material.contentHash}`,
    }));
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
  if (!run.value || busy.value || active.value) return;
  const rerender = run.value.status !== 'PENDING_RENDER';
  if (rerender) {
    const confirmed = await requestActionConfirmation({
      eyebrow: '重新导出成片',
      title: `重新导出 ${run.value.counts.total} 条成片？`,
      description:
        '将按当前分辨率与帧率创建此模板的新版本分支，原有成片保留在旧分支。',
      confirmLabel: '确认重新导出',
      tone: 'warning',
    });
    if (!confirmed) return;
  }
  busy.value = true;
  try {
    const response = await requestJson<ApiResponse<FinalOutputRun>>(
      `${base.value}/${run.value.id}/render`,
      {
        method: 'POST',
        operation: rerender ? '重新导出成片' : '开始导出成片',
        body: { resolution: resolution.value, frameRate: frameRate.value },
      },
    );
    if (response.data.workflowRunId !== props.workflowRunId) {
      emit('workflowRunChange');
      return;
    }
    await refresh();
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : '启动成片渲染失败';
  } finally {
    busy.value = false;
  }
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
function stop() {
  mounted = false;
  ++generation;
  ++mixGeneration;
  controller?.abort();
  mixController?.abort();
  closePreviewDialog(false);
  clearTimeout(timer);
}
watch(
  () => [props.projectId, props.workflowRunId],
  () => {
    runs.value = [];
    selectedTemplateId.value = '';
    selectedRunId.value = '';
    closePreviewDialog(false);
    settingsByTemplate.value = new Map();
    selectedItemIds.value = new Set();
    selectionMode.value = false;
    mixWorkspace.value = null;
    mixLoading.value = true;
    mixError.value = '';
    loading.value = true;
    page.value = 1;
    void reconcilePending();
    void refresh();
  },
  { immediate: true },
);
watch(selectedTemplateId, () => {
  page.value = 1;
  selectedRunId.value = templateRuns.value[0]?.id ?? '';
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
  // KeepAlive retains the old preview; entering from the mix workbench must reload its saved draft.
  void reconcilePending();
  void refresh();
});
onDeactivated(stop);
onBeforeUnmount(() => { stop(); outputSyncChannel?.close(); });
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

    <section v-if="pageLoading" class="page-state" role="status">
      <span class="state-icon loading-icon"><Film :size="24" /></span>
      <h3>正在读取成片输出</h3>
      <p>正在读取当前工作流的混剪模板和成片任务…</p>
    </section>
    <section v-else-if="!templates.length && !error && !mixError" class="page-state empty-state">
      <span class="state-icon"><Film :size="25" /></span>
      <h3>暂无混剪模板</h3>
      <p>完成模板混剪后，模板会按原有顺序显示在这里；每个模板的成片任务彼此独立。</p>
      <button class="secondary-button" type="button" @click="$emit('back')">
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
                <small v-if="template.run">{{ template.run.counts.total }} 条成片 · {{ labels[template.run.status] }}</small>
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
            <p v-else-if="active">正在渲染所选模板的成片，渲染期间不可修改</p>
            <p v-else>可调整分辨率与帧率；重新导出成功后会创建此模板的新版本分支</p>
          </div>
        </div>
        <label>
          <span>分辨率</span>
          <select v-model="resolution" :disabled="busy || active" aria-label="成片分辨率">
            <option value="480p">480P</option><option value="720p">720P</option><option value="1080p">1080P</option>
            <option value="2K">2K</option><option value="4K">4K</option>
          </select>
        </label>
        <label>
          <span>帧率</span>
          <select v-model.number="frameRate" :disabled="busy || active" aria-label="成片帧率">
            <option :value="24">24 fps</option><option :value="25">25 fps</option><option :value="30">30 fps</option><option :value="50">50 fps</option><option :value="60">60 fps</option>
          </select>
        </label>
        <button class="primary-button export-button" type="button" :disabled="busy || active" @click="startRender">
          <LoaderCircle v-if="busy || active" class="spin" :size="15" />
          <RefreshCw v-else-if="run.status !== 'PENDING_RENDER'" :size="15" />
          <Play v-else :size="15" />{{ busy ? '正在创建任务…' : active ? `渲染中 ${run.counts.completed}/${run.counts.total}` : run.status !== 'PENDING_RENDER' ? `重新导出成片（${run.counts.total}）` : `导出成片（${run.counts.total}）` }}
        </button>
      </section>
      <section v-if="run.status !== 'PENDING_RENDER' && run.status !== 'COMPLETED'" class="batch-panel" aria-label="批次输出进度">
        <div class="batch-panel__heading">
          <div>
            <span class="eyebrow">成片渲染进度</span>
            <strong class="batch-status" :class="statusTone(run.status)">
              <i></i>{{ labels[run.status] }}
            </strong>
          </div>
          <button
            v-if="!active && run.counts.failed"
            class="primary-button"
            type="button"
            :disabled="busy"
            @click="retryFailedOutputs"
          >
            <RefreshCw :size="14" />恢复失败项
          </button>
        </div>
        <div class="batch-progress-line">
          <progress :value="progress" max="100" :aria-label="`本批生成进度 ${progress}%`" />
          <strong>{{ progress }}%</strong>
          <span>{{ run.counts.completed }} / {{ run.counts.total }} 条完成</span>
        </div>
        <div class="batch-counts">
          <div><span class="count-dot success"></span><span>已完成</span><strong>{{ run.counts.completed }}</strong></div>
          <div><span class="count-dot running"></span><span>渲染中</span><strong>{{ run.counts.running }}</strong></div>
          <div><span class="count-dot pending"></span><span>排队中</span><strong>{{ run.counts.queued }}</strong></div>
          <div><span class="count-dot danger"></span><span>失败/取消</span><strong>{{ run.counts.failed }}</strong></div>
        </div>
      </section>

      <section class="output-workspace" aria-labelledby="output-list-title">
        <header class="workspace-heading">
          <div>
            <h3 id="output-list-title">{{ run.status === 'PENDING_RENDER' ? '待渲染成片' : '成片列表' }}</h3>
            <p>{{ run.status === 'PENDING_RENDER' ? '当前模板已完成校验，点击导出后渲染此模板的全部成片' : '在左侧选择模板，查看并播放该模板输出的成片' }}</p>
          </div>
          <div class="workspace-heading__actions">
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
              <span v-if="previewClips(item).length" class="preview-cover preview-montage" aria-hidden="true">
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
              <small v-if="run.status === 'PENDING_RENDER'">等待导出</small>
              <small v-else-if="item.status !== 'COMPLETED'">{{ item.progress }}%</small>
            </div>
            <div class="output-info">
              <div class="output-card__title">
                <h4 :title="displayName(item)">{{ displayName(item) }}</h4>
                <span class="status-pill" :class="statusTone(item.status)">
                  {{ labels[item.status] }}
                </span>
                <!--
                  A film confirmed without a package plays silent by design. Without this the viewer
                  would read the missing narration as a broken render.
                -->
                <span
                  v-if="item.unpackaged"
                  class="status-pill unpackaged"
                  title="这条成片的包装未成功，以无包装成片提交：只有画面，没有口播、字幕与配乐"
                >无包装</span>
              </div>
              <p class="output-meta">{{ run.status === 'PENDING_RENDER' ? `预计 ${item.duration.toFixed(1)} 秒 · 待导出` : `${item.duration.toFixed(1)} 秒 · H.264 / AAC · ${item.unpackaged ? '无口播 / 字幕 / 配乐' : '内嵌字幕'}` }}</p>
              <div v-if="run.status !== 'PENDING_RENDER' && item.status !== 'COMPLETED'" class="item-progress">
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
                v-if="run.status !== 'PENDING_RENDER'"
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
        back-label="返回模板混剪"
        :complete="Boolean(run.validated)"
        :status-title="validateStatusTitle"
        :status-detail="`步骤 6 / 6 · 当前模板：${selectedTemplate?.templateName ?? run.templateName}`"
        next-label=""
        :show-validate="false"
        :show-next="false"
        @back="$emit('back')"
      />
          </template>
          <section v-else class="template-readiness" role="status">
            <span class="state-icon"><Film :size="25" /></span>
            <span class="readiness-eyebrow">{{ selectedTemplate?.pendingLabel ?? '尚未进入成片输出' }}</span>
            <h3>{{ selectedTemplate?.pendingTitle ?? '该模板还没有待渲染成片' }}</h3>
            <p>{{ selectedTemplate?.pendingDetail ?? '返回模板混剪，完成当前模板的成片包装与校验。' }}</p>
            <button class="secondary-button" type="button" @click="$emit('back')">
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
.batch-panel__heading,
.batch-progress-line,
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
.loading-icon {
  animation: pulse 1.2s ease-in-out infinite alternate;
}
@keyframes pulse {
  to { opacity: 0.45; transform: scale(0.94); }
}
.batch-panel {
  padding: 17px 18px;
  background: linear-gradient(135deg, #f8fbff 0%, #fffaf7 100%);
  border: 1px solid #dce6f5;
  border-radius: 16px;
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
.batch-panel__heading {
  justify-content: space-between;
  gap: 12px;
}
.batch-panel__heading > div {
  display: flex;
  align-items: center;
  gap: 12px;
}
.eyebrow {
  color: #7b8aa1;
  font-size: 11px;
}
.batch-status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: #5f7cae;
  font-size: 13px;
}
.batch-status i,
.count-dot {
  width: 8px;
  height: 8px;
  flex: 0 0 8px;
  background: currentColor;
  border-radius: 50%;
}
.batch-status.success,
.count-dot.success { color: #15956f; }
.batch-status.running,
.count-dot.running { color: #3d78d8; }
.batch-status.pending,
.count-dot.pending { color: #7c8ba2; }
.batch-status.danger,
.count-dot.danger { color: #d14d56; }
.batch-progress-line {
  margin-top: 16px;
  gap: 12px;
  color: #718096;
  font-size: 11px;
}
.batch-progress-line progress {
  flex: 1;
}
.batch-progress-line strong {
  color: #2563eb;
  font-size: 12px;
}
.batch-counts {
  display: grid;
  margin-top: 15px;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
}
.batch-counts > div {
  display: flex;
  min-width: 0;
  padding: 10px 12px;
  align-items: center;
  gap: 8px;
  color: #718096;
  background: #ffffffc9;
  border: 1px solid #e5ebf4;
  border-radius: 10px;
  font-size: 11px;
}
.batch-counts strong {
  margin-left: auto;
  color: #34445c;
  font-size: 14px;
}
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
  gap: 7px;
}
.output-card__title h4 {
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
.status-pill.unpackaged { color: #92650c; background: #fdf6e3; }
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
  .batch-counts {
    grid-template-columns: repeat(2, minmax(0, 1fr));
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
  .batch-panel__heading {
    align-items: flex-start;
  }
  .batch-panel__heading > div {
    align-items: flex-start;
    flex-direction: column;
    gap: 5px;
  }
  .batch-progress-line {
    flex-wrap: wrap;
  }
  .batch-progress-line progress {
    flex-basis: 100%;
    order: 2;
  }
  .batch-counts {
    gap: 7px;
  }
  .batch-counts > div {
    padding: 9px;
    gap: 6px;
  }
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
  .batch-counts > div {
    font-size: 10px;
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
