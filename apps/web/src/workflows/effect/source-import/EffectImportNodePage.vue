<script setup lang="ts">
import {
  DEFAULT_EFFECT_VIDEO_CONFIG,
  type BatchRetryEffectImportProductsData,
  type EffectImportDraft,
  type EffectImportMaterial,
  type EffectImportMaterialMutationData,
  type EffectImportMaterialType,
  type EffectImportMode,
  type EffectImportProduct,
  type EffectImportProductMutationData,
  type EffectImportWorkspace,
  type EffectManifestFormat,
  type EffectVideoConfig,
  type EffectVideoConfigOverride,
  type PreviewEffectManifestData,
} from '@ai-marketing/contracts';
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  CloudUpload,
  FileCheck2,
  FileSpreadsheet,
  FolderInput,
  LoaderCircle,
  PackageOpen,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
} from '@lucide/vue';
import { computed, inject, onBeforeUnmount, ref, watch } from 'vue';

import { ApiClientError, isAbortError } from '../../../api/http-client';
import { projectContextKey } from '../../../platform/project/project-context';
import EffectInfoExtractionNodePage from '../information-extraction/EffectInfoExtractionNodePage.vue';
import {
  advanceEffectImportDraft,
  batchDeleteEffectImportProducts,
  batchRetryEffectImportProducts,
  cancelEffectManifest,
  commitEffectManifest,
  createEffectImportProduct,
  deleteEffectImportMaterial,
  deleteEffectImportProduct,
  downloadEffectManifestTemplate,
  getEffectImportDraft,
  getEffectImportWorkspace,
  listEffectImportProducts,
  previewEffectManifest,
  publishEffectImportDraft,
  replaceEffectImportMaterial,
  switchEffectImportMode,
  updateEffectImportDraft,
  updateEffectImportProduct,
  uploadEffectImportMaterial,
  validateEffectImportDraft,
  validateEffectImportLink,
} from './api/effect-import.api';
import BatchManifestImportDialog from './components/BatchManifestImportDialog.vue';
import EffectWorkflowCanvas from './components/EffectWorkflowCanvas.vue';
import GlobalVideoConfigPanel from './components/GlobalVideoConfigPanel.vue';
import ProductConfigOverrideDialog from './components/ProductConfigOverrideDialog.vue';
import ProductImportEditor from './components/ProductImportEditor.vue';
import {
  cloneVideoConfig,
  createEffectImportGenerationGate,
  createIdempotencyKeyRegistry,
  createProjectWriteQueue,
  createVersionedDraftBuffer,
  drainPendingEdits,
  editableProductSnapshot,
  invalidateIdempotencyKeyOnRevisionChange,
  isRevisionConflict,
  resolveReloadSaveState,
  resolveSuccessfulWriteSaveState,
  synchronizeCollectionItemById,
  type EffectImportSaveState,
} from './effect-import-state';

type PageStatus = 'error' | 'idle' | 'loading' | 'success';
type EditableProductSnapshot = ReturnType<typeof editableProductSnapshot>;

const projectContext = inject(projectContextKey);
if (!projectContext) throw new Error('EffectImportNodePage must be used inside project context');

const pageStatus = ref<PageStatus>('idle');
const pageError = ref('');
const workspace = ref<EffectImportWorkspace | null>(null);
const draft = ref<EffectImportDraft | null>(null);
const listedProducts = ref<EffectImportProduct[]>([]);
const saveState = ref<EffectImportSaveState>('clean');
const transitioning = ref(false);
const activeStep = ref(0);
const downstreamBoundaries = [
  { title: 'Prompt 生成', description: '批量生成差异化提示词' },
  { title: '片段渲染', description: 'AI 视频片段批量渲染' },
  { title: '自动混剪', description: '模板化自动混剪' },
  { title: '校验与导出', description: '质量校验与成片导出' },
] as const;
const activeDownstreamBoundary = computed(() => downstreamBoundaries[activeStep.value - 2]);
const keyword = ref('');
const selectedProductIds = ref(new Set<string>());
const busyMaterialIds = ref(new Set<string>());
const notice = ref<{ kind: 'error' | 'success' | 'warning'; text: string } | null>(null);
const manifestOpen = ref(false);
const manifestBusy = ref(false);
const manifestError = ref('');
const manifestPreview = ref<PreviewEffectManifestData | null>(null);
const overrideOpen = ref(false);
const overrideProduct = ref<EffectImportProduct | null>(null);
const overrideSaving = ref(false);
const replacementTarget = ref<{
  material: EffectImportMaterial;
  product: EffectImportProduct;
} | null>(null);
const replacementInput = ref<HTMLInputElement | null>(null);

const writeQueue = createProjectWriteQueue();
const generationGate = createEffectImportGenerationGate();
const productDraftBuffer = createVersionedDraftBuffer<EditableProductSnapshot>();
const globalDraftBuffer = createVersionedDraftBuffer<EffectVideoConfig>();
const draftCache = new Map<EffectImportMode, EffectImportDraft>();
const createClientIdempotencyKey = (): string =>
  globalThis.crypto?.randomUUID?.() ??
  `effect-import-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const manifestCommitKeys = createIdempotencyKeyRegistry(createClientIdempotencyKey);
const publishKeys = createIdempotencyKeyRegistry(createClientIdempotencyKey);
const loadedProjectId = ref('');
let activeGeneration = 0;
let projectSelectionSequence = 0;
let transitionOperationCount = 0;
let pageController: AbortController | null = null;
let listController: AbortController | null = null;
let noticeTimer: ReturnType<typeof setTimeout> | undefined;
let configTimer: ReturnType<typeof setTimeout> | undefined;
let searchTimer: ReturnType<typeof setTimeout> | undefined;
const productTimers = new Map<string, ReturnType<typeof setTimeout>>();

const currentProjectId = computed(() => projectContext.currentProject.value?.id ?? '');
const currentMode = computed<EffectImportMode>(() => workspace.value?.currentMode ?? 'SINGLE');
const products = computed(() =>
  currentMode.value === 'BATCH' ? listedProducts.value : (draft.value?.products ?? []),
);
const singleProduct = computed(() => draft.value?.products[0] ?? null);
const validationErrors = computed(
  () => draft.value?.validationIssues.filter((issue) => issue.severity === 'ERROR') ?? [],
);
const validatedCurrentRevision = computed(
  () =>
    Boolean(draft.value) &&
    draft.value?.validatedRevision === draft.value?.revision &&
    validationErrors.value.length === 0,
);
const selectedCount = computed(() => selectedProductIds.value.size);
const failedProductCount = computed(
  () =>
    products.value.filter((product) => product.materials.some((item) => item.status === 'FAILED'))
      .length,
);
const manifestCommitIdempotencyKey = computed(() =>
  manifestPreview.value ? manifestCommitKeys.getOrCreate(manifestPreview.value.id) : '',
);
const publishContextKey = (value: EffectImportDraft | null = draft.value): string =>
  value ? `${loadedProjectId.value}:${value.mode}:${value.id}` : '';

const saveStateLabel = computed(
  () =>
    ({
      clean: '草稿已加载',
      conflict: '检测到版本冲突，已重新加载',
      dirty: '有未保存修改',
      saveError: '保存失败',
      saved: '草稿已保存',
      saving: '正在保存…',
    })[saveState.value],
);

const showNotice = (text: string, kind: 'error' | 'success' | 'warning' = 'success'): void => {
  notice.value = { text, kind };
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => (notice.value = null), 3600);
};

const clearPendingTimers = (): void => {
  clearTimeout(configTimer);
  clearTimeout(searchTimer);
  productTimers.forEach(clearTimeout);
  productTimers.clear();
};

const beginTransition = (): void => {
  transitionOperationCount += 1;
  transitioning.value = true;
};

const endTransition = (): void => {
  transitionOperationCount = Math.max(0, transitionOperationCount - 1);
  transitioning.value = transitionOperationCount > 0;
};

const hasPendingDraftEdits = (): boolean => globalDraftBuffer.has() || productDraftBuffer.has();

const isCurrentContext = (projectId: string, generation: number): boolean =>
  loadedProjectId.value === projectId && generationGate.current(generation);

const relockDownstreamNode = (): void => {
  if (!workspace.value) return;
  workspace.value.currentNode = 'SOURCE_IMPORT';
  workspace.value.nodeStatuses.SOURCE_IMPORT = 'CURRENT';
  workspace.value.nodeStatuses.AI_INFO_EXTRACTION = 'LOCKED';
  activeStep.value = 0;
};

const syncWorkspaceSummary = (): void => {
  if (!workspace.value || !draft.value) return;
  const summary = workspace.value.drafts[draft.value.mode];
  Object.assign(summary, {
    status: draft.value.status,
    revision: draft.value.revision,
    validatedRevision: draft.value.validatedRevision,
    productCount: draft.value.productCount,
    issueCount: draft.value.validationIssues.length,
    completedAt: draft.value.completedAt,
    lastPublish: draft.value.lastPublish,
    updatedAt: draft.value.updatedAt,
  });
};

const setDraft = (value: EffectImportDraft): void => {
  const previous = draft.value;
  if (previous?.id === value.id) {
    invalidateIdempotencyKeyOnRevisionChange(
      publishKeys,
      publishContextKey(previous),
      previous.revision,
      value.revision,
    );
  }
  draft.value = value;
  draftCache.set(value.mode, value);
  if (value.mode === 'SINGLE' || !keyword.value) {
    listedProducts.value = value.products;
  }
  syncWorkspaceSummary();
};

const markDraftMutation = (revision: number): void => {
  if (!draft.value) return;
  invalidateIdempotencyKeyOnRevisionChange(
    publishKeys,
    publishContextKey(),
    draft.value.revision,
    revision,
  );
  draft.value.revision = revision;
  draft.value.validatedRevision = null;
  draft.value.status = 'DRAFT';
  draft.value.validationIssues = [];
  draft.value.issueCount = 0;
  draft.value.updatedAt = new Date().toISOString();
  relockDownstreamNode();
  syncWorkspaceSummary();
};

const replaceProduct = (product: EffectImportProduct): void => {
  if (!draft.value) return;
  const [draftProducts, visibleProducts] = synchronizeCollectionItemById(
    draft.value.products,
    listedProducts.value,
    product,
  );
  draft.value.products = draftProducts;
  listedProducts.value = visibleProducts;
};

const syncEditableProductSnapshot = (
  productId: string,
  snapshot: EditableProductSnapshot,
): void => {
  const source =
    listedProducts.value.find((item) => item.id === productId) ??
    draft.value?.products.find((item) => item.id === productId);
  if (source) replaceProduct({ ...source, ...snapshot });
};

const restorePendingDraftEdits = (): void => {
  const globalPending = globalDraftBuffer.get('global');
  if (globalPending && draft.value) {
    draft.value.globalConfig = cloneVideoConfig(globalPending.value);
    draft.value.validatedRevision = null;
  }
  productDraftBuffer.keys().forEach((productId) => {
    const pending = productDraftBuffer.get(productId);
    if (pending) syncEditableProductSnapshot(productId, pending.value);
  });
  if (globalPending || productDraftBuffer.has()) relockDownstreamNode();
};

const applyMaterialMutation = (
  productId: string,
  value: EffectImportMaterialMutationData,
): void => {
  const product =
    (currentMode.value === 'BATCH' ? listedProducts.value : (draft.value?.products ?? [])).find(
      (item) => item.id === productId,
    ) ?? draft.value?.products.find((item) => item.id === productId);
  if (!product) return;
  const index = product.materials.findIndex((item) => item.id === value.material.id);
  const materials =
    index < 0
      ? [value.material, ...product.materials]
      : product.materials.map((item) => (item.id === value.material.id ? value.material : item));
  replaceProduct({ ...product, materials });
  markDraftMutation(value.revision);
};

const reloadCurrentDraft = async (reason: 'conflict' | 'normal' = 'normal'): Promise<void> => {
  const projectId = loadedProjectId.value;
  const mode = currentMode.value;
  const generation = activeGeneration;
  if (!projectId || !pageController) return;
  try {
    const response = await getEffectImportDraft(projectId, mode, pageController.signal);
    if (!isCurrentContext(projectId, generation)) return;
    setDraft(response.data);
    if (mode === 'BATCH') await refreshProductList();
    restorePendingDraftEdits();
    saveState.value = resolveReloadSaveState(
      reason,
      globalDraftBuffer.has() || productDraftBuffer.has(),
    );
  } catch (error) {
    if (!isAbortError(error))
      showNotice(error instanceof Error ? error.message : '重新加载草稿失败', 'error');
  }
};

const runWrite = async <T,>(
  operation: (expectedRevision: number, signal: AbortSignal) => Promise<T>,
  apply?: (result: T) => void,
): Promise<T | null> => {
  const projectId = loadedProjectId.value;
  const generation = activeGeneration;
  const controller = pageController;
  if (!projectId || !draft.value || !controller) return null;
  try {
    return await writeQueue.enqueue(projectId, async () => {
      if (!isCurrentContext(projectId, generation) || controller.signal.aborted) {
        throw new DOMException('stale project request', 'AbortError');
      }
      saveState.value = 'saving';
      const result = await operation(draft.value!.revision, controller.signal);
      if (isCurrentContext(projectId, generation)) {
        apply?.(result);
        saveState.value = resolveSuccessfulWriteSaveState(hasPendingDraftEdits());
      }
      return result;
    });
  } catch (error) {
    if (isAbortError(error)) return null;
    if (isRevisionConflict(error)) {
      saveState.value = 'conflict';
      await reloadCurrentDraft('conflict');
      showNotice('草稿已被更新，已载入服务端最新版本', 'warning');
      return null;
    }
    saveState.value = 'saveError';
    showNotice(error instanceof Error ? error.message : '保存失败', 'error');
    return null;
  }
};

const refreshProductList = async (): Promise<void> => {
  const projectId = loadedProjectId.value;
  const generation = activeGeneration;
  if (!projectId || currentMode.value !== 'BATCH') return;
  listController?.abort();
  listController = new AbortController();
  try {
    const response = await listEffectImportProducts(
      projectId,
      'BATCH',
      {
        keyword: keyword.value || undefined,
        page: 1,
        pageSize: 100,
      },
      listController.signal,
    );
    if (!isCurrentContext(projectId, generation)) return;
    listedProducts.value = response.data.items;
    productDraftBuffer.keys().forEach((productId) => {
      const pending = productDraftBuffer.get(productId);
      if (pending) syncEditableProductSnapshot(productId, pending.value);
    });
    if (draft.value && response.data.revision > draft.value.revision) {
      invalidateIdempotencyKeyOnRevisionChange(
        publishKeys,
        publishContextKey(),
        draft.value.revision,
        response.data.revision,
      );
      draft.value.revision = response.data.revision;
    }
  } catch (error) {
    if (!isAbortError(error))
      showNotice(error instanceof Error ? error.message : '加载产品列表失败', 'error');
  }
};

const loadProject = async (projectId: string): Promise<void> => {
  clearPendingTimers();
  globalDraftBuffer.reset();
  productDraftBuffer.reset();
  pageController?.abort();
  listController?.abort();
  generationGate.invalidate();
  workspace.value = null;
  draft.value = null;
  draftCache.clear();
  listedProducts.value = [];
  selectedProductIds.value = new Set();
  activeStep.value = 0;
  pageError.value = '';
  if (!projectId) {
    loadedProjectId.value = '';
    pageStatus.value = 'idle';
    return;
  }
  pageController = new AbortController();
  loadedProjectId.value = projectId;
  activeGeneration = generationGate.begin();
  const generation = activeGeneration;
  pageStatus.value = 'loading';
  try {
    const workspaceResponse = await getEffectImportWorkspace(projectId, pageController.signal);
    if (!isCurrentContext(projectId, generation)) return;
    workspace.value = workspaceResponse.data.workspace;
    const draftResponse = await getEffectImportDraft(
      projectId,
      workspace.value.currentMode,
      pageController.signal,
    );
    if (!isCurrentContext(projectId, generation)) return;
    setDraft(draftResponse.data);
    activeStep.value = workspace.value.currentNode === 'AI_INFO_EXTRACTION' ? 1 : 0;
    pageStatus.value = 'success';
    saveState.value = 'clean';
    if (workspace.value.currentMode === 'BATCH') await refreshProductList();
    const backgroundMode: EffectImportMode =
      workspace.value.currentMode === 'SINGLE' ? 'BATCH' : 'SINGLE';
    void getEffectImportDraft(projectId, backgroundMode, pageController.signal)
      .then((response) => {
        if (isCurrentContext(projectId, generation)) draftCache.set(backgroundMode, response.data);
      })
      .catch(() => undefined);
  } catch (error) {
    if (isAbortError(error)) return;
    pageStatus.value = 'error';
    pageError.value = error instanceof Error ? error.message : '资料包工作区加载失败';
  }
};

const switchMode = async (mode: EffectImportMode): Promise<void> => {
  if (
    transitioning.value ||
    !workspace.value ||
    mode === currentMode.value ||
    !loadedProjectId.value ||
    !pageController
  )
    return;
  const previousMode = currentMode.value;
  let previousDraft = draft.value;
  let previousListedProducts = listedProducts.value;
  const workspaceRevision = workspace.value.revision;
  beginTransition();
  try {
    if (!(await flushPendingEdits()) || hasPendingDraftEdits()) {
      showNotice('当前模式仍有未保存修改，请重试保存后再切换', 'error');
      return;
    }
    previousDraft = draft.value;
    previousListedProducts = listedProducts.value;
    const projectId = loadedProjectId.value;
    const generation = activeGeneration;
    const cachedDraft = draftCache.get(mode);
    if (cachedDraft) {
      workspace.value.currentMode = mode;
      keyword.value = '';
      selectedProductIds.value = new Set();
      setDraft(cachedDraft);
      saveState.value = 'clean';
    }
    const response = await writeQueue.enqueue(projectId, () =>
      switchEffectImportMode(
        projectId,
        { mode, expectedRevision: workspaceRevision },
        pageController!.signal,
      ),
    );
    if (!isCurrentContext(projectId, generation)) return;
    workspace.value = response.data.workspace;
    keyword.value = '';
    selectedProductIds.value = new Set();
    setDraft(response.data.draft);
    saveState.value = 'clean';
    if (mode === 'BATCH') void refreshProductList();
  } catch (error) {
    if (isAbortError(error)) return;
    if (workspace.value && previousDraft) {
      workspace.value.currentMode = previousMode;
      setDraft(previousDraft);
      listedProducts.value = previousListedProducts;
    }
    if (error instanceof ApiClientError && error.status === 409)
      await loadProject(loadedProjectId.value);
    else showNotice(error instanceof Error ? error.message : '切换模式失败', 'error');
  } finally {
    endTransition();
  }
};

const updateGlobalConfig = (config: EffectVideoConfig): void => {
  if (!draft.value || transitioning.value) return;
  const snapshot = cloneVideoConfig(config);
  draft.value.globalConfig = snapshot;
  draft.value.validatedRevision = null;
  globalDraftBuffer.edit('global', cloneVideoConfig(snapshot));
  relockDownstreamNode();
  saveState.value = 'dirty';
  clearTimeout(configTimer);
  configTimer = setTimeout(() => void flushGlobalConfig(), 600);
};

const flushGlobalConfig = async (): Promise<boolean> => {
  clearTimeout(configTimer);
  configTimer = undefined;
  const pending = globalDraftBuffer.get('global');
  if (!draft.value || !pending) return true;
  const snapshot = cloneVideoConfig(pending.value);
  const sentVersion = pending.version;
  const result = await runWrite(
    (expectedRevision, signal) =>
      updateEffectImportDraft(
        loadedProjectId.value,
        currentMode.value,
        { globalConfig: snapshot, expectedRevision },
        signal,
      ),
    (response) => {
      setDraft(response.data.draft);
      const latest = globalDraftBuffer.get('global');
      if (latest && latest.version !== sentVersion && draft.value) {
        draft.value.globalConfig = cloneVideoConfig(latest.value);
        draft.value.validatedRevision = null;
      }
      relockDownstreamNode();
    },
  );
  if (!result) return false;
  globalDraftBuffer.acknowledge('global', sentVersion);
  if (globalDraftBuffer.has('global')) {
    const latest = globalDraftBuffer.get('global');
    if (latest && draft.value) draft.value.globalConfig = cloneVideoConfig(latest.value);
    saveState.value = 'dirty';
  } else saveState.value = resolveSuccessfulWriteSaveState(hasPendingDraftEdits());
  return true;
};

const scheduleProductSave = (productId: string, snapshot: EditableProductSnapshot): void => {
  productDraftBuffer.edit(productId, snapshot);
  saveState.value = 'dirty';
  if (draft.value) draft.value.validatedRevision = null;
  relockDownstreamNode();
  clearTimeout(productTimers.get(productId));
  productTimers.set(
    productId,
    setTimeout(() => void flushProduct(productId), 600),
  );
};

const updateProductField = (
  product: EffectImportProduct,
  field: 'category' | 'commerceUrl' | 'name',
  value: string,
): void => {
  if (transitioning.value) return;
  const snapshot = editableProductSnapshot(product);
  if (field === 'commerceUrl') snapshot.commerceUrl = value || null;
  else snapshot[field] = value;
  syncEditableProductSnapshot(product.id, snapshot);
  scheduleProductSave(product.id, snapshot);
};

const flushProduct = async (productOrId: EffectImportProduct | string): Promise<boolean> => {
  const productId = typeof productOrId === 'string' ? productOrId : productOrId.id;
  clearTimeout(productTimers.get(productId));
  productTimers.delete(productId);
  const pending = productDraftBuffer.get(productId);
  if (!pending) return true;
  const snapshot = pending.value;
  const sentVersion = pending.version;
  const result = await runWrite(
    (expectedRevision, signal) =>
      updateEffectImportProduct(
        loadedProjectId.value,
        currentMode.value,
        productId,
        { ...snapshot, expectedRevision },
        signal,
      ),
    (response) => {
      const latest = productDraftBuffer.get(productId);
      replaceProduct({
        ...response.data.product,
        ...(latest?.value ?? snapshot),
      });
      markDraftMutation(response.data.revision);
    },
  );
  if (!result) return false;
  productDraftBuffer.acknowledge(productId, sentVersion);
  const latest = productDraftBuffer.get(productId);
  if (latest) {
    syncEditableProductSnapshot(productId, latest.value);
    saveState.value = 'dirty';
  } else saveState.value = resolveSuccessfulWriteSaveState(hasPendingDraftEdits());
  if (currentMode.value === 'BATCH' && keyword.value) {
    await refreshProductList();
  }
  return true;
};

async function flushPendingEdits(): Promise<boolean> {
  return drainPendingEdits(hasPendingDraftEdits, async () => {
    if (globalDraftBuffer.has() && !(await flushGlobalConfig())) return false;
    for (const productId of productDraftBuffer.keys()) {
      if (!(await flushProduct(productId))) return false;
    }
    return true;
  });
}

const createProduct = async (): Promise<void> => {
  await runWrite(
    (expectedRevision, signal) =>
      createEffectImportProduct(
        loadedProjectId.value,
        currentMode.value,
        {
          commerceUrl: null,
          configOverride: {},
          expectedRevision,
        },
        signal,
      ),
    (response) => {
      replaceProduct(response.data.product);
      if (draft.value) draft.value.productCount += 1;
      markDraftMutation(response.data.revision);
    },
  );
  if (currentMode.value === 'BATCH') await refreshProductList();
};

const deleteProduct = async (product: EffectImportProduct): Promise<void> => {
  if (!window.confirm(`确定删除“${product.name || '未命名产品'}”及其草稿资料吗？`)) return;
  await runWrite(
    (expectedRevision, signal) =>
      deleteEffectImportProduct(
        loadedProjectId.value,
        currentMode.value,
        product.id,
        expectedRevision,
        signal,
      ),
    (response) => {
      if (!draft.value) return;
      draft.value.products = draft.value.products.filter((item) => item.id !== product.id);
      listedProducts.value = listedProducts.value.filter((item) => item.id !== product.id);
      draft.value.productCount = Math.max(0, draft.value.productCount - 1);
      selectedProductIds.value = new Set(
        [...selectedProductIds.value].filter((id) => id !== product.id),
      );
      productDraftBuffer.discard(product.id);
      clearTimeout(productTimers.get(product.id));
      productTimers.delete(product.id);
      markDraftMutation(response.data.revision);
    },
  );
};

const toggleSelected = (product: EffectImportProduct, selected: boolean): void => {
  const next = new Set(selectedProductIds.value);
  if (selected) next.add(product.id);
  else next.delete(product.id);
  selectedProductIds.value = next;
};

const batchDelete = async (): Promise<void> => {
  const ids = [...selectedProductIds.value];
  if (!ids.length || !window.confirm(`确定批量删除已选择的 ${ids.length} 个产品吗？`)) return;
  await runWrite(
    (expectedRevision, signal) =>
      batchDeleteEffectImportProducts(
        loadedProjectId.value,
        'BATCH',
        { productIds: ids, expectedRevision },
        signal,
      ),
    (response) => {
      if (!draft.value) return;
      const deleted = new Set(response.data.deletedProductIds);
      draft.value.products = draft.value.products.filter((item) => !deleted.has(item.id));
      listedProducts.value = listedProducts.value.filter((item) => !deleted.has(item.id));
      draft.value.productCount = Math.max(0, draft.value.productCount - deleted.size);
      deleted.forEach((id) => {
        productDraftBuffer.discard(id);
        clearTimeout(productTimers.get(id));
        productTimers.delete(id);
      });
      selectedProductIds.value = new Set();
      markDraftMutation(response.data.revision);
    },
  );
};

const retryProducts = async (productIds: string[]): Promise<void> => {
  if (!productIds.length) return;
  let result: BatchRetryEffectImportProductsData | null = null;
  await runWrite(
    (expectedRevision, signal) =>
      batchRetryEffectImportProducts(
        loadedProjectId.value,
        currentMode.value,
        { productIds, expectedRevision },
        signal,
      ),
    (response) => {
      result = response.data;
      markDraftMutation(response.data.revision);
    },
  );
  if (result) {
    const needsFile = (result as BatchRetryEffectImportProductsData).results.filter(
      (item) => item.status === 'REQUIRES_NEW_FILE',
    ).length;
    showNotice(
      needsFile ? `${needsFile} 项资料需要重新选择文件，其余失败项已重试` : '失败资料已提交重试',
      needsFile ? 'warning' : 'success',
    );
    await reloadCurrentDraft();
  }
};

const setMaterialBusy = (key: string, busy: boolean): void => {
  const next = new Set(busyMaterialIds.value);
  if (busy) next.add(key);
  else next.delete(key);
  busyMaterialIds.value = next;
};

const uploadMaterials = async (
  product: EffectImportProduct,
  type: EffectImportMaterialType,
  files: File[],
): Promise<void> => {
  const busyKey = `${product.id}:${type}`;
  setMaterialBusy(busyKey, true);
  for (const file of files) {
    await runWrite(
      (expectedRevision, signal) =>
        uploadEffectImportMaterial(
          loadedProjectId.value,
          currentMode.value,
          product.id,
          file,
          { type, expectedRevision },
          signal,
        ),
      (response) => applyMaterialMutation(product.id, response.data),
    );
  }
  setMaterialBusy(busyKey, false);
};

const requestReplacement = (product: EffectImportProduct, material: EffectImportMaterial): void => {
  replacementTarget.value = { product, material };
  replacementInput.value?.click();
};

const replaceMaterialFile = async (event: Event): Promise<void> => {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  const target = replacementTarget.value;
  replacementTarget.value = null;
  if (!file || !target) return;
  setMaterialBusy(target.material.id, true);
  await runWrite(
    (expectedRevision, signal) =>
      replaceEffectImportMaterial(
        loadedProjectId.value,
        currentMode.value,
        target.product.id,
        target.material.id,
        file,
        { expectedRevision },
        signal,
      ),
    (response) => applyMaterialMutation(target.product.id, response.data),
  );
  setMaterialBusy(target.material.id, false);
};

const removeMaterial = async (
  product: EffectImportProduct,
  material: EffectImportMaterial,
): Promise<void> => {
  if (
    !window.confirm(
      `确定删除资料“${material.originalFileName || material.expectedFileName || ''}”吗？`,
    )
  )
    return;
  setMaterialBusy(material.id, true);
  await runWrite(
    (expectedRevision, signal) =>
      deleteEffectImportMaterial(
        loadedProjectId.value,
        currentMode.value,
        product.id,
        material.id,
        expectedRevision,
        signal,
      ),
    (response) => {
      replaceProduct({
        ...product,
        materials: product.materials.filter((item) => item.id !== material.id),
      });
      markDraftMutation(response.data.revision);
    },
  );
  setMaterialBusy(material.id, false);
};

const checkCommerceLink = async (product: EffectImportProduct): Promise<void> => {
  if (!product.commerceUrl || !pageController) return;
  try {
    const response = await validateEffectImportLink(
      loadedProjectId.value,
      currentMode.value,
      product.id,
      { commerceUrl: product.commerceUrl },
      pageController.signal,
    );
    if (response.data.valid && response.data.normalizedUrl) {
      updateProductField(product, 'commerceUrl', response.data.normalizedUrl);
      await flushProduct(product.id);
      showNotice('电商链接格式有效');
    } else showNotice(response.data.issue?.message ?? '电商链接格式不正确', 'error');
  } catch (error) {
    if (!isAbortError(error))
      showNotice(error instanceof Error ? error.message : '链接校验失败', 'error');
  }
};

const openOverride = (product: EffectImportProduct): void => {
  overrideProduct.value = product;
  overrideOpen.value = true;
};

const saveOverride = async (value: EffectVideoConfigOverride): Promise<void> => {
  if (!overrideProduct.value) return;
  overrideSaving.value = true;
  const product = overrideProduct.value;
  await runWrite(
    (expectedRevision, signal) =>
      updateEffectImportProduct(
        loadedProjectId.value,
        currentMode.value,
        product.id,
        { configOverride: value, expectedRevision },
        signal,
      ),
    (response) => {
      replaceProduct((response.data as EffectImportProductMutationData).product);
      markDraftMutation(response.data.revision);
      overrideOpen.value = false;
      showNotice('单品覆盖配置已保存');
    },
  );
  overrideSaving.value = false;
};

const startManifestPreview = async (
  manifest: File,
  files: File[],
  idempotencyKey: string,
): Promise<void> => {
  manifestBusy.value = true;
  manifestError.value = '';
  const result = await runWrite((expectedRevision, signal) =>
    previewEffectManifest(
      loadedProjectId.value,
      manifest,
      files,
      expectedRevision,
      idempotencyKey,
      signal,
    ),
  );
  if (result) {
    manifestCommitKeys.bind(result.data.id, idempotencyKey);
    manifestPreview.value = result.data;
  } else manifestError.value = '清单预览失败，请检查文件后重试';
  manifestBusy.value = false;
};

const commitManifest = async (idempotencyKey: string): Promise<void> => {
  if (!manifestPreview.value) return;
  manifestBusy.value = true;
  const importId = manifestPreview.value.id;
  const stableIdempotencyKey = manifestCommitKeys.bind(importId, idempotencyKey);
  const result = await runWrite(
    (expectedRevision, signal) =>
      commitEffectManifest(
        loadedProjectId.value,
        importId,
        { expectedRevision, idempotencyKey: stableIdempotencyKey },
        signal,
      ),
    (response) => markDraftMutation(response.data.revision),
  );
  manifestBusy.value = false;
  if (!result) return;
  manifestCommitKeys.forget(importId);
  manifestPreview.value = null;
  manifestOpen.value = false;
  showNotice(`已从清单写入 ${result.data.createdProductCount} 个产品`);
  await reloadCurrentDraft();
};

const cancelManifest = async (): Promise<void> => {
  const preview = manifestPreview.value;
  if (!preview) return;
  const result = await runWrite(
    (expectedRevision, signal) =>
      cancelEffectManifest(loadedProjectId.value, preview.id, expectedRevision, signal),
    (response) => markDraftMutation(response.data.revision),
  );
  if (result) {
    manifestCommitKeys.forget(preview.id);
    manifestPreview.value = null;
  }
};

const downloadTemplate = async (format: EffectManifestFormat): Promise<void> => {
  if (!loadedProjectId.value || !pageController) return;
  try {
    const result = await downloadEffectManifestTemplate(
      loadedProjectId.value,
      format,
      pageController.signal,
    );
    const url = URL.createObjectURL(result.blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = result.fileName;
    anchor.click();
    URL.revokeObjectURL(url);
    showNotice(`${format.toUpperCase()} 模板已下载`);
  } catch (error) {
    if (!isAbortError(error))
      showNotice(error instanceof Error ? error.message : '模板下载失败', 'error');
  }
};

const validateDraft = async (): Promise<void> => {
  if (!(await flushPendingEdits())) {
    showNotice('仍有修改保存失败，请保存后再校验', 'error');
    return;
  }
  const response = await runWrite(
    (expectedRevision, signal) =>
      validateEffectImportDraft(
        loadedProjectId.value,
        currentMode.value,
        { expectedRevision },
        signal,
      ),
    (result) => setDraft(result.data.draft),
  );
  if (response?.data.validation.valid) showNotice('资料包校验通过，可以进入下一节点');
  else if (response)
    showNotice(`发现 ${response.data.validation.issues.length} 项问题，请修复后重试`, 'warning');
};

const publishDraft = async (): Promise<void> => {
  if (!draft.value) return;
  const publishContext = publishContextKey();
  const idempotencyKey = publishKeys.getOrCreate(publishContext);
  const response = await runWrite((expectedRevision, signal) =>
    publishEffectImportDraft(
      loadedProjectId.value,
      currentMode.value,
      { expectedRevision, idempotencyKey },
      signal,
    ),
  );
  if (response) {
    publishKeys.forget(publishContext);
    showNotice(`已保存 ${response.data.summary.assetCount} 项资产到当前项目资产库`);
    await reloadCurrentDraft();
  }
};

const advanceDraft = async (): Promise<void> => {
  if (!validatedCurrentRevision.value) return;
  const response = await runWrite((expectedRevision, signal) =>
    advanceEffectImportDraft(
      loadedProjectId.value,
      currentMode.value,
      { expectedRevision },
      signal,
    ),
  );
  if (!response || !workspace.value) return;
  workspace.value.currentNode = 'AI_INFO_EXTRACTION';
  workspace.value.nodeStatuses.SOURCE_IMPORT = 'COMPLETED';
  workspace.value.nodeStatuses.AI_INFO_EXTRACTION = 'AVAILABLE';
  activeStep.value = 1;
  window.scrollTo({ top: 0, behavior: 'smooth' });
};

const selectWorkflowStep = (step: number): void => {
  if (step < 0 || step > 5) return;
  activeStep.value = step;
  window.scrollTo({ top: 0, behavior: 'smooth' });
};

const enterPromptBoundary = (): void => {
  activeStep.value = 2;
  window.scrollTo({ top: 0, behavior: 'smooth' });
};

const handleProjectSelection = async (projectId: string): Promise<void> => {
  const sequence = ++projectSelectionSequence;
  const previousProjectId = loadedProjectId.value;
  if (projectId === previousProjectId && pageStatus.value !== 'idle') return;
  beginTransition();
  try {
    if (previousProjectId && projectId !== previousProjectId) {
      const saved = await flushPendingEdits();
      if (sequence !== projectSelectionSequence) return;
      if (!saved || hasPendingDraftEdits()) {
        showNotice('当前项目仍有未保存修改，已阻止项目切换', 'error');
        projectContext.selectProject(previousProjectId);
        return;
      }
    }
    if (sequence === projectSelectionSequence) await loadProject(projectId);
  } finally {
    endTransition();
  }
};

watch(currentProjectId, (projectId) => void handleProjectSelection(projectId), { immediate: true });
watch(keyword, () => {
  if (currentMode.value !== 'BATCH') return;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => void refreshProductList(), 300);
});

onBeforeUnmount(() => {
  clearPendingTimers();
  clearTimeout(noticeTimer);
  pageController?.abort();
  listController?.abort();
  generationGate.invalidate();
});
</script>

<template>
  <div class="effect-import-page">
    <Transition name="notice">
      <div v-if="notice" class="effect-notice" :class="notice.kind" role="status">
        {{ notice.text }}
      </div>
    </Transition>

    <section v-if="pageStatus === 'idle'" class="page-state">
      <PackageOpen :size="34" />
      <h2>请选择一个项目</h2>
      <p>资料包草稿将按当前项目严格隔离保存。</p>
    </section>
    <section v-else-if="pageStatus === 'loading'" class="page-state loading">
      <LoaderCircle class="spin" :size="34" />
      <h2>正在恢复资料包草稿</h2>
      <p>加载当前项目的导入模式、产品资料和全局视频配置…</p>
    </section>
    <section v-else-if="pageStatus === 'error'" class="page-state error">
      <AlertCircle :size="34" />
      <h2>资料包工作区加载失败</h2>
      <p>{{ pageError }}</p>
      <button type="button" @click="loadProject(currentProjectId)">
        <RefreshCw :size="14" />重新加载
      </button>
    </section>

    <template v-else>
      <EffectWorkflowCanvas :active-step="activeStep" @select="selectWorkflowStep" />

      <EffectInfoExtractionNodePage
        v-if="activeStep === 1"
        :project-id="currentProjectId"
        :draft-id="draft?.id ?? ''"
        :mode="currentMode"
        :products="draft?.products ?? []"
        :global-config="draft?.globalConfig ?? DEFAULT_EFFECT_VIDEO_CONFIG"
        @back="activeStep = 0"
        @next="enterPromptBoundary"
      />

      <section v-else-if="activeDownstreamBoundary" class="ai-placeholder">
        <span><Sparkles :size="23" /></span>
        <small>STEP {{ String(activeStep + 1).padStart(2, '0') }}</small>
        <h2>{{ activeDownstreamBoundary.title }}</h2>
        <p>
          {{ activeDownstreamBoundary.description }}。该节点可自由进入，业务内容不在本次开发范围内。
        </p>
        <button type="button" @click="selectWorkflowStep(activeStep - 1)">
          <ArrowLeft :size="14" />返回上一节点
        </button>
      </section>

      <template v-else>
        <section class="import-workspace-card">
          <section class="node-heading">
            <span>01</span>
            <div>
              <h1>资料包导入</h1>
              <p>汇集商品图片、产品文本资料与电商链接，统一视频生产规格</p>
            </div>
            <div class="save-indicator" :class="saveState">
              <CloudUpload :size="14" />{{ saveStateLabel }}
            </div>
            <button type="button" @click="downloadTemplate('csv')">
              <FileSpreadsheet :size="14" />下载资料包模板
            </button>
          </section>

          <section class="import-mode-segment" aria-label="导入模式">
            <strong>导入模式</strong>
            <div>
              <button
                type="button"
                :class="{ active: currentMode === 'SINGLE' }"
                :disabled="transitioning"
                @click="switchMode('SINGLE')"
              >
                <FolderInput :size="13" />单产品导入
              </button>
              <button
                type="button"
                :class="{ active: currentMode === 'BATCH' }"
                :disabled="transitioning"
                @click="switchMode('BATCH')"
              >
                <FileSpreadsheet :size="13" />多品类批量导入
              </button>
            </div>
          </section>

          <div
            class="import-layout"
            :class="{ 'batch-mode': currentMode === 'BATCH' }"
            :inert="transitioning"
            :aria-busy="transitioning"
          >
            <template v-if="currentMode === 'SINGLE'">
              <section class="import-source-column">
                <div v-if="!singleProduct" class="empty-products">
                  <PackageOpen :size="31" />
                  <h3>尚未创建单产品资料包</h3>
                  <p>创建后直接上传商品图片和产品文档，产品信息将在下一节点由 AI 提炼。</p>
                  <button type="button" @click="createProduct">
                    <Plus :size="14" />开始填写产品资料
                  </button>
                </div>
                <ProductImportEditor
                  v-else
                  :product="singleProduct"
                  :busy-material-ids="busyMaterialIds"
                  :disabled="transitioning"
                  @change="updateProductField"
                  @blur="flushProduct"
                  @upload="uploadMaterials"
                  @replace="requestReplacement"
                  @delete-material="removeMaterial"
                  @retry="(product) => retryProducts([product.id])"
                  @override="openOverride"
                  @validate-link="checkCommerceLink"
                />
              </section>
              <GlobalVideoConfigPanel
                :config="draft?.globalConfig ?? DEFAULT_EFFECT_VIDEO_CONFIG"
                :disabled="transitioning || saveState === 'saving'"
                @update:config="updateGlobalConfig"
              />
            </template>

            <template v-else>
              <section class="batch-panel">
                <header class="batch-panel-head">
                  <div>
                    <h3>商品卡片列表</h3>
                    <p>每个商品独立维护资料、链接与覆盖配置，产品信息由下一节点 AI 提炼</p>
                  </div>
                  <div class="batch-toolbar">
                    <label class="batch-search"
                      ><Search :size="14" /><input
                        v-model="keyword"
                        type="search"
                        placeholder="搜索电商链接或资料文件"
                    /></label>
                    <button type="button" @click="manifestOpen = true">
                      <FileSpreadsheet :size="14" />清单导入
                    </button>
                    <button class="primary" type="button" @click="createProduct">
                      <Plus :size="14" />新增商品
                    </button>
                  </div>
                </header>
                <section class="batch-actions">
                  <span>当前 {{ products.length }} 个产品 · 已选 {{ selectedCount }} 个</span>
                  <button
                    type="button"
                    :disabled="!selectedCount"
                    @click="retryProducts([...selectedProductIds])"
                  >
                    <RefreshCw :size="13" />失败重试
                  </button>
                  <button
                    class="danger"
                    type="button"
                    :disabled="!selectedCount"
                    @click="batchDelete"
                  >
                    <Trash2 :size="13" />批量删除
                  </button>
                </section>
                <div v-if="!products.length" class="empty-products">
                  <PackageOpen :size="31" />
                  <h3>{{ keyword ? '没有匹配的资料包' : '批量草稿还是空的' }}</h3>
                  <p>
                    {{
                      keyword ? '请调整搜索条件。' : '可以逐个新增产品，或导入 CSV / Excel 清单。'
                    }}
                  </p>
                  <button v-if="!keyword" type="button" @click="manifestOpen = true">
                    <FileSpreadsheet :size="14" />导入产品清单
                  </button>
                </div>
                <div v-else class="batch-product-list">
                  <ProductImportEditor
                    v-for="product in products"
                    :key="product.id"
                    batch
                    :position="products.indexOf(product) + 1"
                    :product="product"
                    :disabled="transitioning"
                    :selected="selectedProductIds.has(product.id)"
                    :busy-material-ids="busyMaterialIds"
                    @select="toggleSelected"
                    @change="updateProductField"
                    @blur="flushProduct"
                    @delete="deleteProduct"
                    @upload="uploadMaterials"
                    @replace="requestReplacement"
                    @delete-material="removeMaterial"
                    @retry="(item) => retryProducts([item.id])"
                    @override="openOverride"
                    @validate-link="checkCommerceLink"
                  />
                </div>
              </section>
              <GlobalVideoConfigPanel
                class="batch-global-config"
                :config="draft?.globalConfig ?? DEFAULT_EFFECT_VIDEO_CONFIG"
                :disabled="transitioning || saveState === 'saving'"
                @update:config="updateGlobalConfig"
              />
            </template>
          </div>

          <section v-if="validationErrors.length" class="validation-panel">
            <header>
              <AlertCircle :size="16" /><span
                >校验未通过，共 {{ validationErrors.length }} 项需要处理</span
              >
            </header>
            <div>
              <p
                v-for="(issue, index) in validationErrors.slice(0, 8)"
                :key="`${issue.code}-${index}`"
              >
                {{ issue.productId ? '产品资料：' : '' }}{{ issue.message }}
              </p>
            </div>
          </section>

          <section class="asset-publish-bar">
            <span class="asset-publish-icon"><CloudUpload :size="18" /></span>
            <div>
              <strong>保存完整资料包到项目资产库</strong>
              <small>当前模式的商品资料与有效视频配置将创建新的资产版本</small>
            </div>
            <em>{{ draft?.lastPublish ? '已入库，可再次保存新版本' : '待入库' }}</em>
            <button
              type="button"
              :disabled="!validatedCurrentRevision || saveState === 'saving'"
              @click="publishDraft"
            >
              <CloudUpload :size="14" />保存到项目资产库
            </button>
          </section>

          <footer class="node-footer">
            <div class="node-footer__status" :class="{ valid: validatedCurrentRevision }">
              <ShieldCheck v-if="validatedCurrentRevision" :size="17" />
              <FileCheck2 v-else :size="17" />
              <span
                ><strong>{{
                  validatedCurrentRevision ? '当前草稿校验通过' : '进入下一节点前需要完成校验'
                }}</strong
                ><small
                  >revision {{ draft?.revision ?? 0 }} ·
                  {{ draft?.productCount ?? 0 }} 个产品<template v-if="failedProductCount">
                    · {{ failedProductCount }} 个产品存在失败资料</template
                  ></small
                ></span
              >
            </div>
            <button type="button" :disabled="saveState === 'saving'" @click="validateDraft">
              <CheckCircle2 :size="14" />完成校验
            </button>
            <button
              class="primary"
              type="button"
              :disabled="!validatedCurrentRevision || saveState === 'saving'"
              @click="advanceDraft"
            >
              下一步：AI 信息提炼<ArrowRight :size="15" />
            </button>
          </footer>
        </section>
      </template>
    </template>

    <input
      ref="replacementInput"
      class="visually-hidden"
      type="file"
      @change="replaceMaterialFile"
    />
    <BatchManifestImportDialog
      :open="manifestOpen"
      :busy="manifestBusy"
      :error="manifestError"
      :preview="manifestPreview"
      :commit-idempotency-key="manifestCommitIdempotencyKey"
      @close="manifestOpen = false"
      @cancel="cancelManifest"
      @download="downloadTemplate"
      @preview="startManifestPreview"
      @commit="commitManifest"
    />
    <ProductConfigOverrideDialog
      :open="overrideOpen"
      :product="overrideProduct"
      :global-config="draft?.globalConfig ?? DEFAULT_EFFECT_VIDEO_CONFIG"
      :saving="overrideSaving"
      @close="overrideOpen = false"
      @save="saveOverride"
    />
  </div>
</template>

<style scoped>
.effect-import-page {
  --effect-blue: #2563eb;
  min-height: 100%;
  margin: 18px;
  padding: 26px 28px 30px;
  color: #17233a;
  background: #fff;
  border: 1px solid #dbe4f6;
  border-radius: 26px;
  box-shadow: 0 12px 34px #7a4e3b12;
}
.effect-notice {
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
.effect-notice.warning {
  color: #926123;
  background: #fff9eb;
  border-color: #f3d69a;
}
.effect-notice.error {
  color: #a84148;
  background: #fff3f2;
  border-color: #f3c6c4;
}
.notice-enter-active,
.notice-leave-active {
  transition: 0.2s ease;
}
.notice-enter-from,
.notice-leave-to {
  opacity: 0;
  transform: translateY(-7px);
}
.page-state {
  min-height: 430px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  color: #7f8da2;
  text-align: center;
}
.page-state > svg {
  color: #2563eb;
}
.page-state h2 {
  margin: 13px 0 5px;
  color: #34445c;
  font-size: 18px;
}
.page-state p {
  margin: 0;
  font-size: 11px;
}
.page-state button {
  display: inline-flex;
  height: 35px;
  margin-top: 15px;
  padding: 0 13px;
  align-items: center;
  gap: 6px;
  color: #fff;
  background: #2563eb;
  border: 0;
  border-radius: 8px;
  font-size: 11px;
  font-weight: 800;
}
.page-state.error > svg {
  color: #d65355;
}
.import-workspace-card {
  margin-top: 18px;
  padding: 22px;
  background: #fff;
  border: 1px solid #f0e3dc;
  border-radius: 24px;
  box-shadow: 0 8px 25px #7a4e3b0c;
}
.node-heading {
  display: flex;
  min-height: 78px;
  margin-bottom: 12px;
  padding: 0;
  align-items: center;
  gap: 12px;
  background: #fff;
  border: 0;
  border-radius: 0;
  box-shadow: none;
}
.node-heading > span {
  display: grid;
  width: 44px;
  height: 44px;
  flex: 0 0 44px;
  place-items: center;
  color: #d93946;
  background: #fff0ed;
  border-radius: 14px;
  font-size: 14px;
  font-weight: 900;
  letter-spacing: 0.04em;
}
.node-heading h1,
.node-heading p {
  margin: 0;
}
.node-heading h1 {
  color: #263247;
  font-size: 17px;
}
.node-heading p {
  margin-top: 4px;
  color: #8792a4;
  font-size: 11px;
}
.save-indicator {
  display: inline-flex;
  margin-left: auto;
  align-items: center;
  gap: 5px;
  color: #708098;
  font-size: 9px;
  font-weight: 800;
}
.save-indicator.saving {
  color: #2563eb;
}
.save-indicator.saveError {
  color: #d65355;
}
.save-indicator.dirty {
  color: #b47a26;
}
.node-heading > button {
  display: inline-flex;
  height: 34px;
  padding: 0 12px;
  align-items: center;
  gap: 6px;
  color: #3f5f8c;
  background: #fff;
  border: 1px solid #cbd8ea;
  border-radius: 8px;
  font-size: 10px;
  font-weight: 800;
}
.import-mode-segment {
  display: flex;
  margin: 0 0 16px;
  align-items: center;
  gap: 12px;
  color: #596278;
  font-size: 11px;
}
.import-mode-segment > div {
  display: inline-flex;
  padding: 3px;
  background: #f5f7fa;
  border: 1px solid #ece0da;
  border-radius: 10px;
}
.import-mode-segment button {
  display: inline-flex;
  min-height: 30px;
  padding: 0 12px;
  align-items: center;
  justify-content: center;
  gap: 5px;
  color: #66758c;
  background: transparent;
  border: 0;
  border-radius: 7px;
  font-size: 10px;
  font-weight: 700;
}
.import-mode-segment button.active {
  color: #2563eb;
  background: #fff;
  box-shadow: 0 3px 9px #7a4e3b12;
}
.import-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 18px;
  align-items: start;
}
.import-layout.batch-mode {
  grid-template-columns: 1fr;
}
.import-source-column {
  min-width: 0;
}
.import-layout:not(.batch-mode) > .import-source-column {
  display: contents;
}
.import-layout:not(.batch-mode) > .import-source-column > :deep(.product-editor:not(.batch)) {
  display: contents;
}
.import-layout:not(.batch-mode) :deep(.upload-source-card) {
  height: auto;
  box-sizing: border-box;
  align-self: stretch;
  grid-column: 1;
  grid-row: 1;
}
.import-layout:not(.batch-mode) > :deep(.global-config-card) {
  height: auto;
  box-sizing: border-box;
  align-self: stretch;
  grid-column: 2;
  grid-row: 1;
}
.import-layout:not(.batch-mode) :deep(.commerce-parse) {
  grid-column: 1 / -1;
  grid-row: 2;
}
.import-layout:not(.batch-mode) :deep(.imported-materials) {
  grid-column: 1 / -1;
  grid-row: 3;
}
.import-layout:not(.batch-mode) :deep(.override-footer) {
  grid-column: 1 / -1;
  grid-row: 4;
}
.empty-products {
  display: flex;
  min-height: 330px;
  padding: 30px;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  color: #8090a6;
  background: #fff;
  border: 1px dashed #bfcde0;
  border-radius: 18px;
  text-align: center;
}
.empty-products svg {
  color: #7297d8;
}
.empty-products h3 {
  margin: 12px 0 5px;
  color: #40506a;
  font-size: 14px;
}
.empty-products p {
  margin: 0;
  font-size: 10px;
}
.empty-products button {
  display: inline-flex;
  height: 34px;
  margin-top: 15px;
  padding: 0 12px;
  align-items: center;
  gap: 5px;
  color: #fff;
  background: #2563eb;
  border: 0;
  border-radius: 8px;
  font-size: 10px;
  font-weight: 800;
}
.batch-toolbar {
  display: flex;
  margin: 0;
  padding: 0;
  align-items: center;
  gap: 7px;
  background: transparent;
  border: 0;
}
.batch-search {
  position: relative;
  display: flex;
  min-width: 150px;
  flex: 1;
  align-items: center;
}
.batch-search svg {
  position: absolute;
  left: 9px;
  color: #8794a6;
}
.batch-search input {
  width: 100%;
  height: 36px;
  padding: 0 10px 0 29px;
  border: 1px solid #d7dfeb;
  border-radius: 8px;
  outline: 0;
  font-size: 10px;
}
.batch-toolbar > button,
.batch-actions button {
  display: inline-flex;
  height: 36px;
  padding: 0 10px;
  align-items: center;
  gap: 5px;
  color: #42628f;
  background: #fff;
  border: 1px solid #cfdbec;
  border-radius: 8px;
  white-space: nowrap;
  font-size: 9px;
  font-weight: 800;
}
.batch-toolbar > button.primary {
  color: #fff;
  background: #2563eb;
  border-color: #2563eb;
}
.batch-actions {
  display: flex;
  min-height: 40px;
  margin-bottom: 9px;
  padding: 6px 9px;
  align-items: center;
  gap: 7px;
  color: #7e8b9e;
  background: #f7faff;
  border: 1px solid #dce6f5;
  border-radius: 10px;
  font-size: 9px;
}
.batch-actions span {
  margin-right: auto;
}
.batch-actions button {
  height: 27px;
}
.batch-actions button.danger {
  color: #d65355;
  border-color: #efc9c9;
}
.batch-product-list {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}
.batch-panel {
  padding: 20px;
  background: #fff;
  border: 1px solid #f0e3dc;
  border-radius: 20px;
}
.batch-panel-head {
  display: flex;
  margin-bottom: 16px;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}
.batch-panel-head h3,
.batch-panel-head p {
  margin: 0;
}
.batch-panel-head h3 {
  color: #263247;
  font-size: 15px;
}
.batch-panel-head p {
  margin-top: 4px;
  color: #9198a7;
  font-size: 12px;
}
.batch-global-config {
  position: static !important;
  width: 100%;
  box-sizing: border-box;
}
.validation-panel {
  margin-top: 14px;
  padding: 12px 14px;
  color: #9f4c46;
  background: #fff7f5;
  border: 1px solid #ffd4cb;
  border-radius: 12px;
}
.validation-panel header {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 11px;
  font-weight: 800;
}
.validation-panel div {
  display: grid;
  margin-top: 7px;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 4px 12px;
}
.validation-panel p {
  margin: 0;
  font-size: 9px;
}
.node-footer {
  display: flex;
  min-height: 72px;
  margin-top: 14px;
  padding: 13px 16px;
  align-items: center;
  gap: 8px;
  background: #fff;
  border: 1px solid #f0e0d7;
  border-radius: 20px;
  box-shadow: 0 8px 25px #7a4e3b12;
}
.asset-publish-bar {
  display: flex;
  min-height: 66px;
  margin-top: 18px;
  padding: 12px 15px;
  box-sizing: border-box;
  align-items: center;
  gap: 11px;
  color: #1e2b43;
  background: linear-gradient(90deg, #f4f8ff, #fff);
  border: 1px solid #d8e3f3;
  border-radius: 13px;
}
.asset-publish-icon {
  display: grid;
  width: 38px;
  height: 38px;
  flex: 0 0 38px;
  place-items: center;
  color: #2766ed;
  background: #e8f1ff;
  border-radius: 11px;
}
.asset-publish-bar > div {
  min-width: 0;
  flex: 1;
}
.asset-publish-bar strong,
.asset-publish-bar small {
  display: block;
}
.asset-publish-bar strong {
  font-size: 13px;
}
.asset-publish-bar small {
  margin-top: 3px;
  color: #7d899f;
  font-size: 10px;
}
.asset-publish-bar em {
  padding: 5px 9px;
  color: #68768c;
  background: #eef2f7;
  border-radius: 999px;
  font-size: 10px;
  font-style: normal;
  white-space: nowrap;
}
.asset-publish-bar button {
  display: inline-flex;
  height: 36px;
  padding: 0 14px;
  align-items: center;
  gap: 5px;
  color: #fff;
  background: #2766ed;
  border: 1px solid #2766ed;
  border-radius: 9px;
  font-size: 10px;
  font-weight: 800;
}
.node-footer__status {
  display: flex;
  min-width: 220px;
  margin-right: auto;
  align-items: center;
  gap: 8px;
  color: #718096;
}
.node-footer__status.valid {
  color: #168361;
}
.node-footer__status strong,
.node-footer__status small {
  display: block;
}
.node-footer__status strong {
  color: #41516a;
  font-size: 10px;
}
.node-footer__status small {
  margin-top: 3px;
  font-size: 8px;
}
.node-footer button {
  display: inline-flex;
  height: 35px;
  padding: 0 12px;
  align-items: center;
  gap: 5px;
  color: #41516a;
  background: #fff;
  border: 1px solid #d3ddea;
  border-radius: 8px;
  font-size: 10px;
  font-weight: 800;
}
.node-footer button.primary {
  color: #fff;
  background: #2563eb;
  border-color: #2563eb;
}
.node-footer button:disabled,
.batch-actions button:disabled {
  cursor: not-allowed;
  opacity: 0.48;
}
.ai-placeholder {
  display: flex;
  min-height: 460px;
  padding: 50px;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  background: #fff;
  border: 1px solid #dbe4f2;
  border-radius: 18px;
  text-align: center;
}
.ai-placeholder > span {
  display: grid;
  width: 58px;
  height: 58px;
  place-items: center;
  color: #2563eb;
  background: #eaf2ff;
  border-radius: 18px;
}
.ai-placeholder > small {
  margin-top: 16px;
  color: #2563eb;
  font-size: 9px;
  font-weight: 900;
  letter-spacing: 0.12em;
}
.ai-placeholder h2 {
  margin: 7px 0 6px;
  color: #2f3f57;
  font-size: 20px;
}
.ai-placeholder p {
  max-width: 520px;
  margin: 0;
  color: #8490a4;
  font-size: 11px;
  line-height: 1.8;
}
.ai-placeholder button {
  display: inline-flex;
  height: 35px;
  margin-top: 18px;
  padding: 0 12px;
  align-items: center;
  gap: 5px;
  color: #2563eb;
  background: #f2f6ff;
  border: 1px solid #b9cff6;
  border-radius: 8px;
  font-size: 10px;
  font-weight: 800;
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
@media (max-width: 1080px) {
  .import-layout {
    grid-template-columns: 1fr;
  }
  .node-footer {
    align-items: stretch;
    flex-wrap: wrap;
  }
  .node-footer__status {
    width: 100%;
  }
  .node-heading {
    flex-wrap: wrap;
  }
  .save-indicator {
    margin-left: 0;
  }
  .node-heading > button {
    margin-left: auto;
  }
  .batch-product-list {
    grid-template-columns: 1fr;
  }
  .batch-panel-head {
    flex-direction: column;
  }
}
@media (max-width: 680px) {
  .effect-import-page {
    margin: 8px;
    padding: 14px;
    border-radius: 20px;
  }
  .import-workspace-card {
    padding: 14px;
    border-radius: 18px;
  }
  .import-mode-segment {
    margin-left: 0;
  }
  .node-heading > div:nth-child(2) {
    width: calc(100% - 60px);
  }
  .node-heading p {
    display: none;
  }
  .batch-toolbar {
    flex-wrap: wrap;
  }
  .batch-search {
    width: 100%;
    flex-basis: 100%;
  }
  .validation-panel div {
    grid-template-columns: 1fr;
  }
  .node-footer button {
    flex: 1;
    justify-content: center;
  }
  .node-footer button.primary {
    flex-basis: 100%;
  }
  .effect-notice {
    top: 126px;
    right: 14px;
    left: 14px;
  }
  .import-mode-segment button small {
    display: none;
  }
  .asset-publish-bar {
    align-items: flex-start;
    flex-wrap: wrap;
  }
  .asset-publish-bar > div {
    width: calc(100% - 52px);
  }
  .asset-publish-bar button {
    margin-left: auto;
  }
}
</style>
