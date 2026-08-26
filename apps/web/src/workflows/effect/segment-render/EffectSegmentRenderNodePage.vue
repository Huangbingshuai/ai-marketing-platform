<script setup lang="ts">
import type {
  EffectImportProduct,
  EffectPromptFragmentType,
  EffectVideoConfig,
} from '@ai-marketing/contracts';
import {
  EFFECT_PROMPT_FRAGMENT_TYPE_LABELS,
  EFFECT_PROMPT_FRAGMENT_TYPES,
} from '@ai-marketing/contracts';
import { WorkflowNodeDraftBar, WorkflowNodeFooter } from '@ai-marketing/ui';
import {
  AlertCircle,
  Boxes,
  ChevronLeft,
  ChevronRight,
  Download,
  FileUp,
  LoaderCircle,
  Play,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
  X,
} from '@lucide/vue';
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';

import {
  EFFECT_SEGMENT_RENDER_PAGE_SIZE,
  effectSegmentRenderPage,
  effectSegmentRenderPageCount,
  effectSegmentRenderSummary,
  filterEffectSegmentRenderTasks,
  isEffectSegmentRenderBusy,
  type EffectSegmentRenderStatus,
  type EffectSegmentRenderTask,
  type EffectSegmentRenderWorkspace,
} from './effect-segment-render-state';
import {
  deleteEffectSegmentRenderTasks,
  exportEffectSegmentRenderTasks,
  importEffectSegmentRenderFiles,
  loadEffectSegmentRenderWorkspace,
  regenerateEffectSegmentRenderTasks,
  startEffectSegmentRenderBatch,
  type EffectSegmentRenderContext,
} from './services/effect-segment-render.mock-service';

const props = defineProps<{
  projectId: string;
  workflowRunId: string;
  products: EffectImportProduct[];
  globalConfig: EffectVideoConfig;
}>();

const emit = defineEmits<{ back: []; next: [] }>();

type PageStatus = 'empty' | 'error' | 'loading' | 'success';
type Operation = 'batch' | 'delete' | 'export' | 'import' | 'retry' | null;
type Notice = { kind: 'error' | 'success' | 'warning'; text: string };

const pageStatus = ref<PageStatus>('loading');
const loadError = ref('');
const workspace = ref<EffectSegmentRenderWorkspace | null>(null);
const currentProductId = ref('');
const keyword = ref('');
const page = ref(1);
const selectedTaskIds = ref(new Set<string>());
const operation = ref<Operation>(null);
const validated = ref(false);
const notice = ref<Notice | null>(null);

const fileInput = ref<HTMLInputElement | null>(null);
const previewTask = ref<EffectSegmentRenderTask | null>(null);
const promptTask = ref<EffectSegmentRenderTask | null>(null);
const poolOpen = ref(false);
const deleteTaskIds = ref<string[]>([]);
const deleteDialogOpen = ref(false);
const previewCloseButton = ref<HTMLButtonElement | null>(null);
const promptCloseButton = ref<HTMLButtonElement | null>(null);
const poolCloseButton = ref<HTMLButtonElement | null>(null);
const deleteConfirmButton = ref<HTMLButtonElement | null>(null);

let dialogTrigger: HTMLElement | null = null;
let loadController: AbortController | null = null;
let operationController: AbortController | null = null;
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
const filteredTasks = computed(() => filterEffectSegmentRenderTasks(tasks.value, keyword.value));
const totalPages = computed(() => effectSegmentRenderPageCount(filteredTasks.value.length));
const pagedTasks = computed(() => effectSegmentRenderPage(filteredTasks.value, page.value));
const selectedCount = computed(() => selectedTaskIds.value.size);

const taskSequenceLabel = (task: EffectSegmentRenderTask): string => {
  const matched = /^R-(\d+)$/u.exec(task.renderCode);
  return matched ? String(Number.parseInt(matched[1]!, 10)) : task.renderCode;
};

const allFilteredSelected = computed(
  () =>
    filteredTasks.value.length > 0 &&
    filteredTasks.value.every((task) => selectedTaskIds.value.has(task.id)),
);
const currentProductReady = computed(
  () =>
    tasks.value.length > 0 &&
    summary.value.running === 0 &&
    summary.value.failed === 0 &&
    operation.value === null,
);
const selectedTasks = computed(() =>
  tasks.value.filter((task) => selectedTaskIds.value.has(task.id)),
);
const poolGroups = computed(() =>
  EFFECT_PROMPT_FRAGMENT_TYPES.map((fragmentType) => ({
    fragmentType,
    label: EFFECT_PROMPT_FRAGMENT_TYPE_LABELS[fragmentType],
    tasks: tasks.value.filter(
      (task) =>
        task.fragmentType === fragmentType &&
        (task.status === 'COMPLETED' || task.status === 'IMPORTED'),
    ),
  })),
);

const context = (): EffectSegmentRenderContext => ({
  projectId: props.projectId,
  workflowRunId: props.workflowRunId,
});

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

const applyWorkspace = (nextWorkspace: EffectSegmentRenderWorkspace): void => {
  if (nextWorkspace.productId !== currentProductId.value) return;
  workspace.value = nextWorkspace;
};

const closeAllDialogs = (restoreFocus = false): void => {
  previewTask.value = null;
  promptTask.value = null;
  poolOpen.value = false;
  deleteDialogOpen.value = false;
  deleteTaskIds.value = [];
  if (!restoreFocus) {
    dialogTrigger = null;
    return;
  }
  const trigger = dialogTrigger;
  dialogTrigger = null;
  void nextTick(() => trigger?.isConnected && trigger.focus());
};

const loadCurrentWorkspace = async (): Promise<void> => {
  const product = currentProduct.value;
  const generation = ++loadGeneration;
  loadController?.abort();
  operationController?.abort();
  operation.value = null;
  closeAllDialogs(false);
  selectedTaskIds.value = new Set();
  page.value = 1;
  keyword.value = '';
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
    const nextWorkspace = await loadEffectSegmentRenderWorkspace(
      context(),
      product,
      props.globalConfig,
      controller.signal,
    );
    if (generation !== loadGeneration || controller.signal.aborted) return;
    workspace.value = nextWorkspace;
    pageStatus.value = 'success';
  } catch (error) {
    if (isAbortError(error) || generation !== loadGeneration) return;
    pageStatus.value = 'error';
    loadError.value = safeMessage(error, '渲染工作区加载失败');
  } finally {
    if (loadController === controller) loadController = null;
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

watch(keyword, () => {
  page.value = 1;
});

watch(totalPages, (nextTotalPages) => {
  if (page.value > nextTotalPages) page.value = nextTotalPages;
});

const toggleTask = (taskId: string, checked: boolean): void => {
  const next = new Set(selectedTaskIds.value);
  if (checked) next.add(taskId);
  else next.delete(taskId);
  selectedTaskIds.value = next;
};

const toggleAllFiltered = (checked: boolean): void => {
  const next = new Set(selectedTaskIds.value);
  for (const task of filteredTasks.value) {
    if (checked) next.add(task.id);
    else next.delete(task.id);
  }
  selectedTaskIds.value = next;
};

const statusMeta = (status: EffectSegmentRenderStatus): { label: string; tone: string } =>
  ({
    AUTO_RETRY: { label: '自动重试', tone: 'retry' },
    COMPLETED: { label: '已完成', tone: 'success' },
    FAILED: { label: '异常', tone: 'danger' },
    IMPORTED: { label: '已导入', tone: 'success' },
    QUEUED: { label: '排队中', tone: 'pending' },
    RENDERING: { label: '生成中', tone: 'running' },
  })[status];

const fragmentTypeLabel = (fragmentType: EffectPromptFragmentType): string =>
  EFFECT_PROMPT_FRAGMENT_TYPE_LABELS[fragmentType];

const startBatch = async (): Promise<void> => {
  const product = currentProduct.value;
  if (!product || operation.value) return;
  operationController?.abort();
  const controller = new AbortController();
  operationController = controller;
  operation.value = 'batch';
  validated.value = false;
  try {
    const nextWorkspace = await startEffectSegmentRenderBatch(
      context(),
      product,
      props.globalConfig,
      { signal: controller.signal, onUpdate: applyWorkspace },
    );
    if (controller.signal.aborted || currentProductId.value !== product.id) return;
    applyWorkspace(nextWorkspace);
    showNotice(
      nextWorkspace.tasks.some((task) => task.status === 'FAILED')
        ? '批量渲染完成，异常片段已标记，请人工重生成'
        : '批量渲染完成，片段已进入素材池',
      nextWorkspace.tasks.some((task) => task.status === 'FAILED') ? 'warning' : 'success',
    );
  } catch (error) {
    if (!isAbortError(error)) showNotice(safeMessage(error, '批量渲染失败'), 'error');
  } finally {
    if (operationController === controller) operationController = null;
    if (!controller.signal.aborted || currentProductId.value === product.id) operation.value = null;
  }
};

const retryTasks = async (taskIds: readonly string[]): Promise<void> => {
  const product = currentProduct.value;
  if (!product || operation.value || !taskIds.length) return;
  operationController?.abort();
  const controller = new AbortController();
  operationController = controller;
  operation.value = 'retry';
  validated.value = false;
  try {
    const nextWorkspace = await regenerateEffectSegmentRenderTasks(
      context(),
      product,
      props.globalConfig,
      taskIds,
      { signal: controller.signal, onUpdate: applyWorkspace },
    );
    if (controller.signal.aborted || currentProductId.value !== product.id) return;
    applyWorkspace(nextWorkspace);
    selectedTaskIds.value = new Set();
    showNotice(`已重新生成 ${taskIds.length} 个视频素材片段`);
  } catch (error) {
    if (!isAbortError(error)) showNotice(safeMessage(error, '片段重生成失败'), 'error');
  } finally {
    if (operationController === controller) operationController = null;
    if (!controller.signal.aborted || currentProductId.value === product.id) operation.value = null;
  }
};

const requestDelete = (taskIds: readonly string[], event: Event): void => {
  if (!taskIds.length || operation.value) return;
  dialogTrigger = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
  deleteTaskIds.value = [...taskIds];
  deleteDialogOpen.value = true;
  void nextTick(() => deleteConfirmButton.value?.focus());
};

const confirmDelete = async (): Promise<void> => {
  const product = currentProduct.value;
  const taskIds = [...deleteTaskIds.value];
  if (!product || operation.value || !taskIds.length) return;
  operation.value = 'delete';
  const controller = new AbortController();
  operationController = controller;
  validated.value = false;
  try {
    const nextWorkspace = await deleteEffectSegmentRenderTasks(
      context(),
      product,
      props.globalConfig,
      taskIds,
      controller.signal,
    );
    if (controller.signal.aborted || currentProductId.value !== product.id) return;
    applyWorkspace(nextWorkspace);
    const nextSelected = new Set(selectedTaskIds.value);
    taskIds.forEach((taskId) => nextSelected.delete(taskId));
    selectedTaskIds.value = nextSelected;
    closeAllDialogs(true);
    showNotice(`已删除 ${taskIds.length} 个素材片段`, 'warning');
  } catch (error) {
    if (!isAbortError(error)) showNotice(safeMessage(error, '片段删除失败'), 'error');
  } finally {
    if (operationController === controller) operationController = null;
    if (!controller.signal.aborted || currentProductId.value === product.id) operation.value = null;
  }
};

const requestImport = (): void => fileInput.value?.click();

const importFiles = async (event: Event): Promise<void> => {
  const target = event.target as HTMLInputElement;
  const product = currentProduct.value;
  const files = [...(target.files ?? [])];
  target.value = '';
  if (!product || !files.length || operation.value) return;
  operation.value = 'import';
  validated.value = false;
  const controller = new AbortController();
  operationController = controller;
  try {
    const nextWorkspace = await importEffectSegmentRenderFiles(
      context(),
      product,
      props.globalConfig,
      files.map(({ name, size, type }) => ({ name, size, type })),
      controller.signal,
    );
    if (controller.signal.aborted || currentProductId.value !== product.id) return;
    applyWorkspace(nextWorkspace);
    showNotice(`已导入 ${files.length} 个外部素材`);
  } catch (error) {
    if (!isAbortError(error)) showNotice(safeMessage(error, '素材导入失败'), 'error');
  } finally {
    if (operationController === controller) operationController = null;
    if (!controller.signal.aborted || currentProductId.value === product.id) operation.value = null;
  }
};

const exportSelected = (): void => {
  const product = currentProduct.value;
  if (!product || !selectedTasks.value.length || operation.value) return;
  operation.value = 'export';
  try {
    const exported = exportEffectSegmentRenderTasks(product, selectedTasks.value);
    const url = URL.createObjectURL(exported.blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = exported.fileName;
    anchor.click();
    requestAnimationFrame(() => URL.revokeObjectURL(url));
    showNotice(`已导出 ${selectedTasks.value.length} 个素材片段清单`);
  } finally {
    operation.value = null;
  }
};

const openPreview = (task: EffectSegmentRenderTask, event: Event): void => {
  dialogTrigger = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
  previewTask.value = task;
  void nextTick(() => previewCloseButton.value?.focus());
};

const openPrompt = (task: EffectSegmentRenderTask, event: Event): void => {
  dialogTrigger = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
  promptTask.value = task;
  void nextTick(() => promptCloseButton.value?.focus());
};

const openPool = (event: Event): void => {
  dialogTrigger = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
  poolOpen.value = true;
  void nextTick(() => poolCloseButton.value?.focus());
};

const validateBatch = (): void => {
  if (!currentProductReady.value) {
    showNotice(
      summary.value.failed ? '请先重新生成全部异常片段' : '仍有片段正在生成，请等待任务完成',
      'warning',
    );
    return;
  }
  validated.value = true;
  showNotice('演示批次校验完成；未写入真实工作副本');
};

const flushPendingEdits = async (): Promise<boolean> => operation.value === null;

defineExpose({ flushPendingEdits });

onBeforeUnmount(() => {
  loadController?.abort();
  operationController?.abort();
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
      <p>按当前项目和商品载入 Prompt 对应的演示任务…</p>
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
            <p>
              {{ summary.total }} 条 Prompt 任务 × 每条 1 个视频素材片段，成功片段自动进入素材池
            </p>
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
          <button class="secondary-button" type="button" @click="openPool">
            <Boxes :size="14" />查看 AI 渲染素材池
          </button>
          <button
            class="primary-button start-render-button"
            type="button"
            :disabled="operation !== null"
            @click="startBatch"
          >
            <LoaderCircle v-if="operation === 'batch'" class="spin" :size="14" />
            <Play v-else :size="14" />{{ operation === 'batch' ? '正在批量渲染' : '开始批量渲染' }}
          </button>
        </div>
      </header>

      <section class="segment-stats" aria-label="渲染任务统计">
        <article class="stat-card neutral">
          <span>任务总数</span><strong>{{ summary.total }}</strong
          ><small>Prompt 对应队列</small>
        </article>
        <article class="stat-card cyan">
          <span>已完成</span><strong>{{ summary.completed }}</strong
          ><small>已进入素材池</small>
        </article>
        <article class="stat-card amber">
          <span>生成中</span><strong>{{ summary.running }}</strong
          ><small>含自动重试任务</small>
        </article>
        <article class="stat-card coral">
          <span>异常失败</span><strong>{{ summary.failed }}</strong
          ><small>支持单条重生成</small>
        </article>
      </section>

      <section class="segment-task-list" aria-label="AI 视频片段任务列表">
        <div class="segment-toolbar">
          <label class="select-all">
            <input
              type="checkbox"
              :checked="allFilteredSelected"
              :disabled="!filteredTasks.length || operation !== null"
              @change="toggleAllFiltered(($event.target as HTMLInputElement).checked)"
            />
            <span>全选</span>
          </label>
          <span class="selected-count"
            >已选 {{ selectedCount }} / {{ filteredTasks.length }} 条</span
          >
          <div class="segment-manage">
            <label class="segment-search">
              <Search :size="14" />
              <input
                v-model="keyword"
                type="search"
                placeholder="按标签或素材名称查询，例如：钩子 / 产品 / 场景"
              />
            </label>
            <button type="button" :disabled="operation !== null" @click="requestImport">
              <FileUp :size="13" />导入素材
            </button>
            <button
              type="button"
              :disabled="!selectedCount || operation !== null"
              @click="retryTasks([...selectedTaskIds])"
            >
              <RefreshCw :size="13" />批量重新生成
            </button>
            <button
              class="danger"
              type="button"
              :disabled="!selectedCount || operation !== null"
              @click="requestDelete([...selectedTaskIds], $event)"
            >
              <Trash2 :size="13" />批量删除
            </button>
          </div>
          <button
            class="batch-export-button"
            type="button"
            :disabled="!selectedCount || operation !== null"
            @click="exportSelected"
          >
            <Download :size="13" />批量导出
          </button>
          <input
            ref="fileInput"
            class="visually-hidden"
            type="file"
            accept="video/*"
            multiple
            @change="importFiles"
          />
        </div>

        <article
          v-for="task in pagedTasks"
          :key="task.id"
          class="segment-task-card"
          :class="{
            selected: selectedTaskIds.has(task.id),
            abnormal: task.abnormal,
          }"
        >
          <input
            class="task-checkbox"
            type="checkbox"
            :aria-label="`选择 ${task.renderCode}`"
            :checked="selectedTaskIds.has(task.id)"
            :disabled="operation !== null"
            @change="toggleTask(task.id, ($event.target as HTMLInputElement).checked)"
          />
          <button
            class="video-placeholder"
            :class="statusMeta(task.status).tone"
            type="button"
            :disabled="task.status === 'FAILED'"
            :aria-label="`预览 ${task.renderCode}`"
            @click="openPreview(task, $event)"
          >
            <Play :size="25" />
            <small>{{ task.progress }}%</small>
          </button>
          <div class="task-main">
            <div class="task-title">
              <div>
                <strong>{{ task.productName }}视频任务 {{ taskSequenceLabel(task) }}</strong>
                <p>
                  {{ task.renderCode }} ·
                  {{
                    task.source === 'PROMPT'
                      ? `来源 ${task.promptCode}`
                      : `外部导入 ${task.sourceName}`
                  }}
                  · 1 个素材片段
                </p>
              </div>
              <div class="task-actions">
                <button
                  type="button"
                  :disabled="task.status === 'FAILED'"
                  @click="openPreview(task, $event)"
                >
                  即时预览
                </button>
                <button type="button" @click="openPrompt(task, $event)">查看提示词</button>
                <button
                  type="button"
                  :disabled="operation !== null || isEffectSegmentRenderBusy(task.status)"
                  @click="retryTasks([task.id])"
                >
                  重新生成
                </button>
                <button
                  class="danger"
                  type="button"
                  :disabled="operation !== null || isEffectSegmentRenderBusy(task.status)"
                  @click="requestDelete([task.id], $event)"
                >
                  删除
                </button>
                <em :class="statusMeta(task.status).tone">{{ statusMeta(task.status).label }}</em>
              </div>
            </div>
            <div class="task-tags">
              <span class="primary-tag">{{ fragmentTypeLabel(task.fragmentType) }}</span>
              <span v-for="tag in task.materialTags" :key="tag">{{ tag }}</span>
            </div>
            <div v-if="task.errorMessage" class="task-error" role="status">
              <AlertCircle :size="12" />{{ task.errorMessage }}
            </div>
            <div class="task-progress">
              <span>{{
                task.status === 'AUTO_RETRY'
                  ? `自动重试 ${task.retryCount}/${task.maxAutoRetries}`
                  : '生成进度'
              }}</span>
              <div>
                <i :class="statusMeta(task.status).tone" :style="{ width: `${task.progress}%` }" />
              </div>
              <b>{{ task.progress }}%</b>
            </div>
          </div>
        </article>

        <div v-if="!pagedTasks.length" class="segment-empty-filter">
          <Search :size="24" />
          <strong>没有匹配该标签或素材名称的片段</strong>
          <span>请调整搜索关键词。</span>
        </div>

        <div class="segment-pagination">
          <span>{{ EFFECT_SEGMENT_RENDER_PAGE_SIZE }} 条/页</span>
          <button type="button" :disabled="page <= 1" @click="page -= 1">
            <ChevronLeft :size="14" />上一页
          </button>
          <strong>第 {{ page }} / {{ totalPages }} 页</strong>
          <button type="button" :disabled="page >= totalPages" @click="page += 1">
            下一页<ChevronRight :size="14" />
          </button>
        </div>
      </section>

      <WorkflowNodeDraftBar
        :detail="`${currentProduct.name} · ${summary.total} 个素材片段 · 演示队列仅保留在当前前端会话，尚未提交真实工作副本`"
        :state="operation || summary.running ? 'saving' : validated ? 'saved' : 'dirty'"
        :state-label="
          operation || summary.running ? '正在生成…' : validated ? '演示校验完成' : '当前会话已更新'
        "
        title="AI 视频片段批次"
      />

      <WorkflowNodeFooter
        back-label="上一步"
        :complete="validated"
        :status-title="validated ? '演示批次校验完成' : '等待全部片段生成并处理异常'"
        :status-detail="`步骤 4 / 6 · ${currentProduct.name} · ${validated ? '未写入真实工作副本' : '演示队列尚未校验'}`"
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
            <Play :size="34" />
            <small>{{ previewTask.durationSeconds }}s</small>
          </div>
          <div class="preview-meta">
            <span>
              <strong>{{ previewTask.productName }} · {{ previewTask.renderCode }}</strong>
              <small
                >{{ previewTask.promptCode ?? previewTask.sourceName }} ·
                {{ fragmentTypeLabel(previewTask.fragmentType) }}</small
              >
            </span>
            <em>演示片段预览</em>
          </div>
          <p class="dialog-note">该预览为本地动画占位，不调用真实视频生成或播放能力。</p>
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
                >{{ promptTask.promptCode ?? '外部导入' }} · 标签：{{
                  fragmentTypeLabel(promptTask.fragmentType)
                }}
                / {{ promptTask.materialTags.join(' / ') }}</small
              >
            </span>
            <em>{{ promptTask.source === 'PROMPT' ? '来源 Prompt' : '外部素材' }}</em>
          </div>
          <pre>{{ promptTask.promptText }}</pre>
          <footer><button type="button" @click="closeAllDialogs(true)">关闭</button></footer>
        </section>
      </div>

      <div v-if="poolOpen" class="segment-dialog-backdrop" @mousedown.self="closeAllDialogs(true)">
        <section
          class="segment-dialog pool-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="segment-pool-title"
          @keydown.esc="closeAllDialogs(true)"
        >
          <header>
            <div>
              <h2 id="segment-pool-title">AI 渲染素材池</h2>
              <p>已完成片段按 Prompt 主标签分类存储</p>
            </div>
            <button
              ref="poolCloseButton"
              type="button"
              aria-label="关闭素材池"
              @click="closeAllDialogs(true)"
            >
              <X :size="16" />
            </button>
          </header>
          <div class="pool-groups">
            <article v-for="group in poolGroups" :key="group.fragmentType">
              <span>{{ group.label }}</span>
              <strong>{{ group.tasks.length }}</strong>
              <small>{{
                group.tasks
                  .slice(0, 3)
                  .map((task) => task.renderCode)
                  .join(' · ') || '暂无完成片段'
              }}</small>
            </article>
          </div>
          <footer>
            <span>共 {{ summary.completed }} 个可用素材片段</span
            ><button type="button" @click="closeAllDialogs(true)">关闭</button>
          </footer>
        </section>
      </div>

      <div
        v-if="deleteDialogOpen"
        class="segment-dialog-backdrop"
        @mousedown.self="closeAllDialogs(true)"
      >
        <section
          class="segment-dialog delete-dialog"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="segment-delete-title"
          @keydown.esc="closeAllDialogs(true)"
        >
          <span class="delete-icon"><Trash2 :size="20" /></span>
          <div>
            <small>删除素材</small>
            <h2 id="segment-delete-title">确认删除 {{ deleteTaskIds.length }} 个片段？</h2>
            <p>本操作只影响当前前端演示会话，不会发送网络请求。</p>
          </div>
          <footer>
            <button type="button" :disabled="operation === 'delete'" @click="closeAllDialogs(true)">
              取消
            </button>
            <button
              ref="deleteConfirmButton"
              class="danger-button"
              type="button"
              :disabled="operation === 'delete'"
              @click="confirmDelete"
            >
              <LoaderCircle v-if="operation === 'delete'" class="spin" :size="14" />确认删除
            </button>
          </footer>
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
.select-all {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  color: #536178;
  font-size: 12px;
  white-space: nowrap;
}
.selected-count {
  color: #7f8a9e;
  font-size: 10px;
  white-space: nowrap;
}
.segment-manage {
  display: flex;
  margin-left: auto;
  align-items: center;
  gap: 7px;
}
.segment-search {
  display: flex;
  width: 210px;
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
.segment-manage button,
.batch-export-button {
  display: inline-flex;
  height: 30px;
  padding: 0 10px;
  align-items: center;
  justify-content: center;
  gap: 4px;
  color: #526078;
  background: #fff;
  border: 1px solid #d7dfeb;
  border-radius: 7px;
  font-size: 10px;
  font-weight: 700;
  white-space: nowrap;
}
.segment-manage button.danger {
  color: #dc3f52;
  border-color: #f0cbd0;
}
.batch-export-button {
  margin-left: auto;
  color: #fff;
  background: #4f8df7;
  border-color: #4f8df7;
}
.segment-task-card {
  position: relative;
  display: grid;
  min-width: 0;
  min-height: 154px;
  padding: 14px 16px;
  grid-template-columns: 24px 112px minmax(0, 1fr);
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
.segment-task-card.selected {
  background: #fbfdff;
  border-color: #75a7f4;
}
.segment-task-card.abnormal {
  background: #fffafa;
  border-color: #ef9ba5;
}
.task-checkbox {
  align-self: start;
  margin-top: 11px;
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
.prompt-dialog > footer,
.pool-dialog > footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
}
.prompt-dialog > footer button,
.pool-dialog > footer button {
  height: 38px;
  padding: 0 18px;
  color: #fff;
  background: #2563eb;
  border: 0;
  border-radius: 9px;
  font-size: 12px;
  font-weight: 800;
}
.pool-dialog {
  width: min(760px, 100%);
  padding: 0 18px 18px;
}
.pool-groups {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}
.pool-groups article {
  padding: 14px;
  background: #f8faff;
  border: 1px solid #dce6f5;
  border-radius: 12px;
}
.pool-groups span,
.pool-groups strong,
.pool-groups small {
  display: block;
}
.pool-groups span {
  color: #526078;
  font-size: 11px;
  font-weight: 800;
}
.pool-groups strong {
  margin: 9px 0 6px;
  color: #2563eb;
  font-size: 24px;
}
.pool-groups small {
  overflow: hidden;
  color: #8490a4;
  font-size: 9px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pool-dialog > footer {
  margin-top: 16px;
  gap: 12px;
  color: #718096;
  font-size: 10px;
}
.delete-dialog {
  display: grid;
  width: min(470px, 100%);
  padding: 22px;
  grid-template-columns: 44px minmax(0, 1fr);
  gap: 14px;
}
.delete-icon {
  display: grid;
  width: 42px;
  height: 42px;
  place-items: center;
  color: #dc2626;
  background: #fff1f2;
  border: 1px solid #fecdd3;
  border-radius: 12px;
}
.delete-dialog small {
  color: #dc2626;
  font-size: 9px;
  font-weight: 900;
}
.delete-dialog h2 {
  margin: 4px 0 7px;
}
.delete-dialog p {
  margin: 0;
  color: #66758c;
  font-size: 11px;
  line-height: 1.7;
}
.delete-dialog footer {
  display: flex;
  grid-column: 1 / -1;
  justify-content: flex-end;
  gap: 8px;
}
.delete-dialog footer button {
  display: inline-flex;
  height: 38px;
  padding: 0 16px;
  align-items: center;
  gap: 5px;
  color: #536178;
  background: #fff;
  border: 1px solid #dbe4f6;
  border-radius: 9px;
  font-size: 12px;
  font-weight: 800;
}
.delete-dialog footer .danger-button {
  color: #fff;
  background: #dc2626;
  border-color: #dc2626;
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
  .segment-manage {
    order: 3;
    width: 100%;
    margin-left: 0;
    flex-wrap: wrap;
  }
  .segment-search {
    flex: 1;
  }
}
@media (max-width: 980px) {
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
  .segment-task-card {
    min-height: 0;
    grid-template-columns: 24px minmax(0, 1fr);
  }
  .video-placeholder {
    width: 100%;
    grid-column: 2;
  }
  .task-main {
    grid-column: 2;
  }
  .task-actions {
    width: 100%;
    margin-left: 0;
    flex-wrap: wrap;
    justify-content: flex-start;
  }
  .segment-search,
  .segment-manage button,
  .batch-export-button {
    width: 100%;
  }
  .batch-export-button {
    margin-left: 0;
  }
  .pool-groups {
    grid-template-columns: 1fr;
  }
  .segment-dialog-backdrop {
    padding: 10px;
  }
}
</style>
