<script setup lang="ts">
import type { EffectImportProduct, EffectVideoConfig } from '@ai-marketing/contracts';
import { WorkflowNodeDraftBar, WorkflowNodeFooter } from '@ai-marketing/ui';
import {
  AlertCircle,
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
  X,
} from '@lucide/vue';
import { computed, onBeforeUnmount, ref, watch } from 'vue';

import {
  EFFECT_PROMPT_LIMITS,
  isPromptWorkspaceComplete,
  normalizePromptSettings,
  promptMatchesKeyword,
  promptPageCount,
  promptPageItems,
  type EffectPromptBatchSettings,
  type EffectPromptItem,
  type EffectPromptPageStatus,
  type EffectPromptWorkspace,
} from './effect-prompt-generation-state';
import {
  addEffectPrompt,
  createEffectPromptExport,
  deleteEffectPrompt,
  generateEffectPromptBatch,
  loadEffectPromptWorkspace,
  persistEffectPromptWorkspace,
  regenerateEffectPrompt,
  updateEffectPrompt,
  type EffectPromptContext,
} from './services/effect-prompt-generation.service';

const props = defineProps<{
  projectId: string;
  workflowRunId: string;
  products: EffectImportProduct[];
  globalConfig: EffectVideoConfig;
}>();

const emit = defineEmits<{
  back: [];
  next: [];
}>();

const status = ref<EffectPromptPageStatus>('loading');
const loadError = ref('');
const workspaces = ref<Record<string, EffectPromptWorkspace>>({});
const currentProductId = ref('');
const keyword = ref('');
const page = ref(1);
const generatingProductId = ref('');
const generatingItemId = ref('');
const notice = ref<{ kind: 'error' | 'success' | 'warning'; text: string } | null>(null);
const editorOpen = ref(false);
const editorMode = ref<'add' | 'edit'>('edit');
const editorItemId = ref('');
const editorContent = ref('');
let loadGeneration = 0;
let loadController: AbortController | null = null;
let operationController: AbortController | null = null;
let noticeTimer: ReturnType<typeof setTimeout> | undefined;

const activeProducts = computed(() =>
  props.products.filter((product) => product.status === 'ACTIVE'),
);
const currentProduct = computed(
  () =>
    activeProducts.value.find((product) => product.id === currentProductId.value) ??
    activeProducts.value[0] ??
    null,
);
const currentConfig = computed(() => currentProduct.value?.effectiveConfig ?? props.globalConfig);
const currentWorkspace = computed(() =>
  currentProduct.value ? (workspaces.value[currentProduct.value.id] ?? null) : null,
);
const currentContext = computed<EffectPromptContext | null>(() =>
  currentProduct.value
    ? {
        projectId: props.projectId,
        workflowRunId: props.workflowRunId,
        productId: currentProduct.value.id,
      }
    : null,
);
const filteredItems = computed(() =>
  (currentWorkspace.value?.items ?? []).filter((item) => promptMatchesKeyword(item, keyword.value)),
);
const totalPages = computed(() => promptPageCount(filteredItems.value.length));
const visibleItems = computed(() => promptPageItems(filteredItems.value, page.value));
const currentGenerating = computed(() => generatingProductId.value === currentProduct.value?.id);
const allProductsComplete = computed(
  () =>
    activeProducts.value.length > 0 &&
    activeProducts.value.every((product) => {
      const workspace = workspaces.value[product.id];
      return Boolean(workspace && isPromptWorkspaceComplete(workspace));
    }),
);
const currentProductComplete = computed(() =>
  currentWorkspace.value ? isPromptWorkspaceComplete(currentWorkspace.value) : false,
);

const showNotice = (text: string, kind: 'error' | 'success' | 'warning' = 'success'): void => {
  notice.value = { text, kind };
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    notice.value = null;
  }, 2800);
};

const isAbortError = (error: unknown): boolean =>
  error instanceof Error && error.name === 'AbortError';

const productSignature = computed(() =>
  JSON.stringify({
    projectId: props.projectId,
    workflowRunId: props.workflowRunId,
    products: activeProducts.value.map((product) => ({
      id: product.id,
      name: product.name,
      category: product.category,
      updatedAt: product.updatedAt,
      effectiveConfig: product.effectiveConfig,
    })),
    globalConfig: props.globalConfig,
  }),
);

const loadWorkspaces = async (): Promise<void> => {
  const generation = ++loadGeneration;
  loadController?.abort();
  operationController?.abort();
  const controller = new AbortController();
  loadController = controller;
  status.value = 'loading';
  loadError.value = '';
  generatingProductId.value = '';
  generatingItemId.value = '';
  try {
    if (!activeProducts.value.length) {
      workspaces.value = {};
      currentProductId.value = '';
      status.value = 'ready';
      return;
    }
    const loaded = await Promise.all(
      activeProducts.value.map(async (product) => {
        const workspace = await loadEffectPromptWorkspace(
          {
            projectId: props.projectId,
            workflowRunId: props.workflowRunId,
            productId: product.id,
          },
          product,
          product.effectiveConfig ?? props.globalConfig,
          controller.signal,
        );
        return [product.id, workspace] as const;
      }),
    );
    if (generation !== loadGeneration || controller.signal.aborted) return;
    workspaces.value = Object.fromEntries(loaded);
    if (!activeProducts.value.some((product) => product.id === currentProductId.value))
      currentProductId.value = activeProducts.value[0]!.id;
    status.value = 'ready';
  } catch (error) {
    if (isAbortError(error) || generation !== loadGeneration) return;
    status.value = 'error';
    loadError.value = error instanceof Error ? error.message : 'Prompt 工作区加载失败';
  }
};

watch(productSignature, () => void loadWorkspaces(), { immediate: true });
watch([currentProductId, keyword], () => {
  page.value = 1;
});
watch(totalPages, (count) => {
  if (page.value > count) page.value = count;
});

const settingRange = (key: keyof EffectPromptBatchSettings): { maximum: number; minimum: number } =>
  ({
    count: { minimum: EFFECT_PROMPT_LIMITS.minCount, maximum: EFFECT_PROMPT_LIMITS.maxCount },
    durationSeconds: {
      minimum: EFFECT_PROMPT_LIMITS.minDurationSeconds,
      maximum: EFFECT_PROMPT_LIMITS.maxDurationSeconds,
    },
    semanticLimit: {
      minimum: EFFECT_PROMPT_LIMITS.minSemanticSimilarity,
      maximum: EFFECT_PROMPT_LIMITS.maxSemanticSimilarity,
    },
    visualLimit: {
      minimum: EFFECT_PROMPT_LIMITS.minVisualSimilarity,
      maximum: EFFECT_PROMPT_LIMITS.maxVisualSimilarity,
    },
  })[key];

const saveCurrentSettings = (): void => {
  if (!currentWorkspace.value || !currentContext.value) return;
  const workspace = {
    ...currentWorkspace.value,
    settings: normalizePromptSettings(currentWorkspace.value.settings),
  };
  workspaces.value[currentContext.value.productId] = persistEffectPromptWorkspace(
    currentContext.value,
    workspace,
  );
};

const adjustSetting = (key: keyof EffectPromptBatchSettings, delta: number): void => {
  if (!currentWorkspace.value) return;
  currentWorkspace.value.settings[key] += delta;
  saveCurrentSettings();
};

const generateCurrentBatch = async (message = '全量 Prompt 已刷新'): Promise<void> => {
  if (!currentProduct.value || !currentWorkspace.value || !currentContext.value) return;
  operationController?.abort();
  const controller = new AbortController();
  operationController = controller;
  generatingProductId.value = currentProduct.value.id;
  generatingItemId.value = '';
  status.value = 'generating';
  loadError.value = '';
  try {
    const workspace = await generateEffectPromptBatch(
      currentContext.value,
      currentProduct.value,
      currentConfig.value,
      currentWorkspace.value.settings,
      controller.signal,
    );
    if (controller.signal.aborted) return;
    workspaces.value[currentProduct.value.id] = workspace;
    page.value = 1;
    showNotice(message);
  } catch (error) {
    if (isAbortError(error)) return;
    loadError.value = error instanceof Error ? error.message : 'Prompt 生成失败';
    showNotice(loadError.value, 'error');
  } finally {
    if (!controller.signal.aborted) {
      status.value = 'ready';
      generatingProductId.value = '';
    }
  }
};

const regenerateItem = async (item: EffectPromptItem): Promise<void> => {
  if (!currentProduct.value || !currentWorkspace.value || !currentContext.value) return;
  operationController?.abort();
  const controller = new AbortController();
  operationController = controller;
  generatingProductId.value = currentProduct.value.id;
  generatingItemId.value = item.id;
  try {
    const workspace = await regenerateEffectPrompt(
      currentContext.value,
      currentWorkspace.value,
      item.id,
      currentProduct.value,
      currentConfig.value,
      controller.signal,
    );
    if (controller.signal.aborted) return;
    workspaces.value[currentProduct.value.id] = workspace;
    showNotice(`${item.code} 已生成新版本`);
  } catch (error) {
    if (isAbortError(error)) return;
    showNotice(error instanceof Error ? error.message : '单条 Prompt 生成失败', 'error');
  } finally {
    if (!controller.signal.aborted) {
      generatingProductId.value = '';
      generatingItemId.value = '';
    }
  }
};

const openEditor = (item?: EffectPromptItem): void => {
  editorMode.value = item ? 'edit' : 'add';
  editorItemId.value = item?.id ?? '';
  editorContent.value = item?.content ?? '';
  editorOpen.value = true;
};

const closeEditor = (): void => {
  editorOpen.value = false;
  editorItemId.value = '';
  editorContent.value = '';
};

const commitEditor = (): void => {
  if (!currentProduct.value || !currentWorkspace.value || !currentContext.value) return;
  if (!editorContent.value.trim()) {
    showNotice('请输入 Prompt 内容', 'warning');
    return;
  }
  const workspace =
    editorMode.value === 'add'
      ? addEffectPrompt(
          currentContext.value,
          currentWorkspace.value,
          currentProduct.value,
          currentConfig.value,
          editorContent.value,
        )
      : updateEffectPrompt(
          currentContext.value,
          currentWorkspace.value,
          editorItemId.value,
          editorContent.value,
        );
  workspaces.value[currentProduct.value.id] = workspace;
  closeEditor();
  showNotice(editorMode.value === 'add' ? '已添加人工 Prompt' : 'Prompt 修改已保存');
};

const removeItem = (item: EffectPromptItem): void => {
  if (!currentProduct.value || !currentWorkspace.value || !currentContext.value) return;
  workspaces.value[currentProduct.value.id] = deleteEffectPrompt(
    currentContext.value,
    currentWorkspace.value,
    item.id,
  );
  showNotice(`${item.code} 已从工作副本删除`, 'warning');
};

const copyItem = async (item: EffectPromptItem): Promise<void> => {
  try {
    await navigator.clipboard.writeText(item.content);
    showNotice(`${item.code} 已复制`);
  } catch {
    showNotice('浏览器未允许写入剪贴板，请使用修改窗口手动复制', 'warning');
  }
};

const exportBatch = (): void => {
  if (!currentProduct.value || !currentWorkspace.value) return;
  const exported = createEffectPromptExport(currentWorkspace.value, currentProduct.value.name);
  const url = URL.createObjectURL(new Blob([exported.content], { type: exported.mimeType }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = exported.fileName;
  anchor.click();
  requestAnimationFrame(() => URL.revokeObjectURL(url));
  showNotice(`已导出 ${currentWorkspace.value.items.length} 条 Prompt`);
};

const goToPage = (nextPage: number): void => {
  page.value = Math.min(totalPages.value, Math.max(1, nextPage));
  const toolbar = document.querySelector('.effect-prompt-toolbar');
  toolbar?.scrollIntoView({ behavior: 'smooth', block: 'start' });
};

const formatPercent = (value: number): string => `${value.toFixed(1)}%`;

const validatePromptBatch = (): void => {
  if (!allProductsComplete.value) {
    showNotice('请先完成全部产品的 Prompt 批次生成', 'warning');
    return;
  }
  showNotice('全部产品 Prompt 已通过数量与相似度校验');
};

const flushPendingEdits = async (): Promise<boolean> => {
  saveCurrentSettings();
  return true;
};

defineExpose({ flushPendingEdits });

onBeforeUnmount(() => {
  loadGeneration += 1;
  loadController?.abort();
  operationController?.abort();
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
      <h2>正在恢复差异化 Prompt 工作副本</h2>
      <p>载入当前项目各产品的批次设置、质量指标与生成结果…</p>
    </section>
    <section v-else-if="status === 'error'" class="prompt-page-state error" role="alert">
      <AlertCircle :size="32" />
      <h2>Prompt 工作区加载失败</h2>
      <p>{{ loadError }}</p>
      <button type="button" @click="loadWorkspaces"><RefreshCw :size="14" />重新加载</button>
    </section>
    <section v-else-if="!currentProduct || !currentWorkspace" class="prompt-page-state">
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
              默认 {{ currentWorkspace.settings.count }} 条 ×
              {{
                currentWorkspace.settings.durationSeconds
              }}
              秒，系统自动执行六维差异化组合与双重去重
            </p>
          </div>
        </div>
        <div class="effect-prompt-heading__actions">
          <label class="product-switcher">
            <span>当前商品</span>
            <select v-model="currentProductId" :disabled="Boolean(generatingProductId)">
              <option v-for="product in activeProducts" :key="product.id" :value="product.id">
                {{ product.name || '未命名产品' }}
              </option>
            </select>
          </label>
          <button
            class="primary-button heading-generate-button"
            type="button"
            :disabled="currentGenerating"
            @click="
              generateCurrentBatch(
                currentWorkspace.hasGenerated ? '批量 Prompt 已重新生成' : '批量 Prompt 生成完成',
              )
            "
          >
            <LoaderCircle v-if="currentGenerating && !generatingItemId" class="spin" :size="14" />
            <RefreshCw v-else-if="currentWorkspace.hasGenerated" :size="14" />
            <Sparkles v-else :size="14" />
            {{
              currentGenerating
                ? '正在生成…'
                : currentWorkspace.hasGenerated
                  ? '重新批量生成'
                  : '开始批量生成'
            }}
          </button>
        </div>
      </header>

      <section class="effect-prompt-settings" aria-label="批次设置">
        <h3>批次设置（仅以下参数可调）</h3>

        <label class="setting-card">
          <span>生成数量</span>
          <span class="number-control">
            <button
              type="button"
              aria-label="减少生成数量"
              :disabled="
                currentGenerating ||
                currentWorkspace.settings.count <= EFFECT_PROMPT_LIMITS.minCount
              "
              @click="adjustSetting('count', -1)"
            >
              −
            </button>
            <input
              v-model.number="currentWorkspace.settings.count"
              type="number"
              :min="EFFECT_PROMPT_LIMITS.minCount"
              :max="EFFECT_PROMPT_LIMITS.maxCount"
              :disabled="currentGenerating"
              @change="saveCurrentSettings"
            />
            <button
              type="button"
              aria-label="增加生成数量"
              :disabled="
                currentGenerating ||
                currentWorkspace.settings.count >= EFFECT_PROMPT_LIMITS.maxCount
              "
              @click="adjustSetting('count', 1)"
            >
              ＋
            </button>
          </span>
          <small>默认 50 条</small>
        </label>

        <label class="setting-card">
          <span>统一时长</span>
          <span class="number-control">
            <button
              type="button"
              aria-label="减少统一时长"
              :disabled="
                currentGenerating ||
                currentWorkspace.settings.durationSeconds <= settingRange('durationSeconds').minimum
              "
              @click="adjustSetting('durationSeconds', -1)"
            >
              −
            </button>
            <input
              v-model.number="currentWorkspace.settings.durationSeconds"
              type="number"
              :min="settingRange('durationSeconds').minimum"
              :max="settingRange('durationSeconds').maximum"
              :disabled="currentGenerating"
              @change="saveCurrentSettings"
            />
            <button
              type="button"
              aria-label="增加统一时长"
              :disabled="
                currentGenerating ||
                currentWorkspace.settings.durationSeconds >= settingRange('durationSeconds').maximum
              "
              @click="adjustSetting('durationSeconds', 1)"
            >
              ＋
            </button>
          </span>
          <small>秒</small>
        </label>

        <label class="setting-card">
          <span>语义重复度上限</span>
          <span class="number-control">
            <button
              type="button"
              aria-label="降低语义重复度上限"
              :disabled="
                currentGenerating ||
                currentWorkspace.settings.semanticLimit <= settingRange('semanticLimit').minimum
              "
              @click="adjustSetting('semanticLimit', -1)"
            >
              −
            </button>
            <input
              v-model.number="currentWorkspace.settings.semanticLimit"
              type="number"
              :min="settingRange('semanticLimit').minimum"
              :max="settingRange('semanticLimit').maximum"
              :disabled="currentGenerating"
              @change="saveCurrentSettings"
            />
            <button
              type="button"
              aria-label="提高语义重复度上限"
              :disabled="
                currentGenerating ||
                currentWorkspace.settings.semanticLimit >= settingRange('semanticLimit').maximum
              "
              @click="adjustSetting('semanticLimit', 1)"
            >
              ＋
            </button>
          </span>
          <small>%</small>
        </label>

        <label class="setting-card">
          <span>画面重合度上限</span>
          <span class="number-control">
            <button
              type="button"
              aria-label="降低画面重合度上限"
              :disabled="
                currentGenerating ||
                currentWorkspace.settings.visualLimit <= settingRange('visualLimit').minimum
              "
              @click="adjustSetting('visualLimit', -1)"
            >
              −
            </button>
            <input
              v-model.number="currentWorkspace.settings.visualLimit"
              type="number"
              :min="settingRange('visualLimit').minimum"
              :max="settingRange('visualLimit').maximum"
              :disabled="currentGenerating"
              @change="saveCurrentSettings"
            />
            <button
              type="button"
              aria-label="提高画面重合度上限"
              :disabled="
                currentGenerating ||
                currentWorkspace.settings.visualLimit >= settingRange('visualLimit').maximum
              "
              @click="adjustSetting('visualLimit', 1)"
            >
              ＋
            </button>
          </span>
          <small>%</small>
        </label>
      </section>

      <section class="effect-prompt-stats" aria-label="生成质量统计">
        <article class="coral">
          <span>生成结果</span>
          <strong>{{ currentWorkspace.metrics.generatedCount }}</strong>
          <small>条 Prompt</small>
        </article>
        <article class="amber">
          <span>剔除重复</span>
          <strong>{{ currentWorkspace.metrics.removedDuplicates }}</strong>
          <small>条相似方案</small>
        </article>
        <article class="cyan">
          <span>当前语义重复度</span>
          <strong>{{ formatPercent(currentWorkspace.metrics.semanticSimilarity) }}</strong>
          <small>目标 ≤ {{ currentWorkspace.settings.semanticLimit }}%</small>
        </article>
        <article class="violet">
          <span>当前画面重合度</span>
          <strong>{{ formatPercent(currentWorkspace.metrics.visualSimilarity) }}</strong>
          <small>目标 ≤ {{ currentWorkspace.settings.visualLimit }}%</small>
        </article>
      </section>

      <section class="effect-prompt-list" aria-label="Prompt 生成结果">
        <div class="effect-prompt-toolbar">
          <label class="prompt-search">
            <Search :size="15" />
            <input v-model="keyword" type="search" placeholder="搜索提示词（ID / 内容 / 标签）" />
          </label>
          <span class="prompt-result-count">
            {{ filteredItems.length }} / {{ currentWorkspace.items.length }} 条
          </span>
          <button class="primary-button" type="button" @click="openEditor()">
            <Plus :size="15" />人工添加提示词
          </button>
          <button class="primary-button" type="button" @click="exportBatch">
            <Download :size="15" />批量导出
          </button>
        </div>

        <div v-if="!visibleItems.length" class="prompt-empty-state">
          <Search :size="25" />
          <strong>没有匹配的 Prompt</strong>
          <span>请调整搜索词，或人工添加新的提示词。</span>
        </div>

        <article v-for="(item, index) in visibleItems" :key="item.id" class="prompt-card">
          <span class="prompt-number">
            {{ String((page - 1) * EFFECT_PROMPT_LIMITS.pageSize + index + 1).padStart(2, '0') }}
          </span>
          <div class="prompt-main">
            <header>
              <strong>{{ item.code }}</strong>
              <em>片段类型 · {{ item.fragmentType }}</em>
            </header>
            <div class="prompt-dimensions">
              <small>差异化标签</small>
              <span v-for="dimension in item.dimensions" :key="dimension.key">
                <b>{{ dimension.label }}：</b>{{ dimension.value }}
              </span>
            </div>
            <textarea :value="item.content" readonly aria-label="Prompt 内容" />
          </div>
          <div class="prompt-actions">
            <button type="button" @click="openEditor(item)"><Pencil :size="13" />修改</button>
            <button type="button" @click="copyItem(item)"><Copy :size="13" />复制</button>
            <button class="danger" type="button" @click="removeItem(item)">
              <Trash2 :size="13" />删除
            </button>
            <button
              type="button"
              :disabled="Boolean(generatingProductId)"
              @click="regenerateItem(item)"
            >
              <LoaderCircle v-if="generatingItemId === item.id" class="spin" :size="13" />
              <RefreshCw v-else :size="13" />重新生成
            </button>
          </div>
        </article>

        <div class="prompt-pagination">
          <span>{{ EFFECT_PROMPT_LIMITS.pageSize }} 条/页</span>
          <button type="button" :disabled="page <= 1" @click="goToPage(page - 1)">
            <ChevronLeft :size="14" />上一页
          </button>
          <strong>第 {{ page }} / {{ totalPages }} 页</strong>
          <button type="button" :disabled="page >= totalPages" @click="goToPage(page + 1)">
            下一页<ChevronRight :size="14" />
          </button>
        </div>
      </section>

      <WorkflowNodeDraftBar
        :detail="`${currentProduct.name} · ${currentWorkspace.items.length} 条 Prompt · 已自动保存到节点草稿 · 尚未归档`"
        :state="currentGenerating ? 'saving' : currentProductComplete ? 'saved' : 'dirty'"
        :state-label="
          currentGenerating
            ? '正在生成…'
            : currentProductComplete
              ? '工作副本已更新'
              : '结果尚未补全'
        "
        title="差异化 Prompt 批次草稿"
      />

      <WorkflowNodeFooter
        back-label="上一步"
        :complete="allProductsComplete"
        :status-title="allProductsComplete ? '全部产品 Prompt 已完成' : '请完成全部产品 Prompt'"
        :status-detail="`步骤 3 / 6 · ${currentProduct.name} · 本地 Mock 工作副本`"
        :validate-disabled="Boolean(generatingProductId) || !allProductsComplete"
        :next-disabled="!allProductsComplete || Boolean(generatingProductId)"
        next-label="下一步：片段渲染"
        @back="emit('back')"
        @validate="validatePromptBatch"
        @next="emit('next')"
      />
    </template>

    <Teleport to="body">
      <div v-if="editorOpen" class="prompt-editor-backdrop" @mousedown.self="closeEditor">
        <section
          class="prompt-editor-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="prompt-editor-title"
          @keydown.esc="closeEditor"
        >
          <header>
            <div>
              <span>{{ editorMode === 'add' ? '人工补充' : '工作副本编辑' }}</span>
              <h2 id="prompt-editor-title">
                {{ editorMode === 'add' ? '添加提示词' : '修改提示词' }}
              </h2>
            </div>
            <button type="button" aria-label="关闭 Prompt 编辑窗口" @click="closeEditor">
              <X :size="17" />
            </button>
          </header>
          <label>
            <span>Prompt 内容</span>
            <textarea v-model="editorContent" autofocus placeholder="请输入结构化视频 Prompt" />
          </label>
          <footer>
            <button type="button" @click="closeEditor">取消</button>
            <button class="primary-button" type="button" @click="commitEditor">
              {{ editorMode === 'add' ? '添加到工作副本' : '保存修改' }}
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
  z-index: 1100;
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
.prompt-page-state button {
  display: inline-flex;
  height: 36px;
  margin-top: 16px;
  padding: 0 14px;
  align-items: center;
  gap: 5px;
  color: #42526a;
  background: #fff;
  border: 1px solid #dbe4f6;
  border-radius: 9px;
  font-size: 12px;
  font-weight: 700;
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
  line-height: 1.35;
}
.effect-prompt-heading p {
  margin-top: 5px;
  color: #7d899d;
  font-size: 13px;
}
.effect-prompt-heading__actions {
  display: flex;
  align-items: center;
  gap: 18px;
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
  width: 180px;
  height: 40px;
  padding: 0 34px 0 13px;
  color: #42526a;
  background: #fff;
  border: 1px solid #dbe4f6;
  border-radius: 10px;
  outline: none;
}
.secondary-button,
.primary-button {
  display: inline-flex;
  height: 40px;
  padding: 0 18px;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border-radius: 10px;
  font-size: 14px;
  font-weight: 700;
  white-space: nowrap;
}
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
.secondary-button:disabled,
.primary-button:disabled {
  cursor: not-allowed;
  opacity: 0.52;
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
.effect-prompt-settings > h3 {
  grid-column: 1 / -1;
  margin: 0;
  color: #263247;
  font-size: 15px;
}
.heading-generate-button {
  min-width: 176px;
}
.setting-card {
  display: grid;
  min-width: 0;
  min-height: 57px;
  padding: 10px 12px;
  grid-template-columns: minmax(78px, 1fr) 148px;
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
  grid-row: 1 / 3;
  grid-column: 2;
  grid-template-columns: 32px minmax(54px, 1fr) 32px;
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
  color: #94a0b2;
  background: #f6f8fb;
  font-size: 15px;
}
.number-control button:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}
.number-control input {
  width: 100%;
  border-right: 1px solid #e3e8f0;
  border-left: 1px solid #e3e8f0;
  outline: none;
  appearance: textfield;
  font-size: 12px;
}
.number-control input::-webkit-inner-spin-button,
.number-control input::-webkit-outer-spin-button {
  margin: 0;
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
.prompt-search input::placeholder {
  color: #a3adbc;
}
.prompt-result-count {
  margin-right: auto;
  color: #8b95a5;
  font-size: 12px;
  white-space: nowrap;
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
  min-height: 20px;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.prompt-main > header strong {
  color: #5b6980;
  font-size: 12px;
}
.prompt-main > header em {
  min-height: 22px;
  padding: 2px 8px;
  color: #ef5366;
  background: #fffafa;
  border: 1px solid #ffb9bd;
  border-radius: 5px;
  font-size: 10px;
  font-style: normal;
  font-weight: 700;
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
  min-height: 258px;
  padding: 10px 14px;
  resize: none;
  overflow: hidden;
  color: #5b6270;
  background: #fff;
  border: 1px solid #dfe4eb;
  border-radius: 10px;
  outline: none;
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
  white-space: nowrap;
}
.prompt-actions button.danger {
  color: #df4d58;
  border-color: #f1cbd0;
}
.prompt-actions button:disabled {
  cursor: not-allowed;
  opacity: 0.5;
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
.prompt-pagination strong {
  font-size: 11px;
  font-weight: 500;
}
.prompt-pagination button:disabled {
  cursor: not-allowed;
  opacity: 0.42;
}
.spin {
  animation: prompt-spin 0.75s linear infinite;
}
@keyframes prompt-spin {
  to {
    transform: rotate(360deg);
  }
}
.prompt-editor-backdrop {
  position: fixed;
  z-index: 1200;
  inset: 0;
  display: grid;
  padding: 20px;
  place-items: center;
  background: #0f172a66;
  backdrop-filter: blur(3px);
}
.prompt-editor-dialog {
  width: min(760px, 100%);
  padding: 22px;
  background: #fff;
  border: 1px solid #dbe4f6;
  border-radius: 20px;
  box-shadow: 0 24px 70px #0f172a38;
}
.prompt-editor-dialog > header {
  display: flex;
  margin-bottom: 18px;
  align-items: flex-start;
  justify-content: space-between;
}
.prompt-editor-dialog > header span {
  color: #6f50c4;
  font-size: 10px;
  font-weight: 900;
  letter-spacing: 0.08em;
}
.prompt-editor-dialog h2 {
  margin: 4px 0 0;
  color: #1d2940;
  font-size: 20px;
}
.prompt-editor-dialog > header button {
  display: grid;
  width: 34px;
  height: 34px;
  place-items: center;
  color: #64748b;
  background: #f7f9fc;
  border: 1px solid #dfe6f0;
  border-radius: 9px;
}
.prompt-editor-dialog > label > span {
  display: block;
  margin-bottom: 8px;
  color: #4d5b72;
  font-size: 12px;
  font-weight: 800;
}
.prompt-editor-dialog textarea {
  width: 100%;
  min-height: 300px;
  padding: 13px;
  resize: vertical;
  color: #4e5b70;
  border: 1px solid #dbe4f6;
  border-radius: 12px;
  outline: none;
  font-family: inherit;
  font-size: 13px;
  line-height: 1.75;
}
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
.prompt-editor-dialog > footer button.primary-button {
  color: #fff;
  background: var(--effect-blue);
  border-color: var(--effect-blue);
}
@media (max-width: 1100px) {
  .effect-prompt-heading,
  .effect-prompt-toolbar {
    align-items: stretch;
    flex-wrap: wrap;
  }
  .effect-prompt-heading__actions {
    margin-left: auto;
  }
  .effect-prompt-settings {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .effect-prompt-settings > h3 {
    grid-column: 1 / -1;
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
  .product-switcher,
  .product-switcher select,
  .secondary-button {
    width: 100%;
  }
  .product-switcher select,
  .secondary-button {
    flex: 1;
  }
  .effect-prompt-settings,
  .effect-prompt-stats {
    grid-template-columns: 1fr;
  }
  .effect-prompt-settings > h3,
  .heading-generate-button {
    width: 100%;
    grid-column: 1;
  }
  .setting-card {
    grid-template-columns: 1fr 148px;
  }
  .prompt-card {
    grid-template-columns: 38px minmax(0, 1fr);
    padding: 12px;
  }
  .prompt-actions {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
