<script setup lang="ts">
import {
  type Asset,
  type AssetListFacets,
  type AssetType,
  type AssetVersion,
  type AssetWorkflow,
  type AssetWorkflowSpace,
  type Project,
} from '@ai-marketing/contracts';
import {
  AlertTriangle,
  ArrowLeft,
  Boxes,
  Check,
  ChevronRight,
  CirclePlus,
  FolderKanban,
  GitBranch,
  Link2,
  LoaderCircle,
  PackageOpen,
  RefreshCw,
  Search,
  Sparkles,
  Square,
  Target,
  Trash2,
  UploadCloud,
  X,
} from '@lucide/vue';
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';

import { isAbortError } from '../../api/http-client';
import { createProject, listProjects as listProjectLibrary } from '../project/api/project.api';
import { presentProjectBinding, useProjectContext } from '../project/project-context';
import {
  archiveAsset,
  batchArchiveAssets,
  batchTagAssets,
  createAssetVersion,
  getAsset,
  importAssets,
  importAssetSnapshot,
  listAssets,
  listAssetVersions,
  upgradeAssetSnapshot,
} from './api/asset.api';
import {
  GLOBAL_SPACES,
  SPACE_LABELS,
  STATUS_CLASS,
  STATUS_LABELS,
  WORKFLOW_META,
  WORKFLOW_SPACES,
  projectMatchesSpace,
  statusOf,
  typeLabel,
  typesForSpace,
  uploadAccept,
  versionOf,
  type AssetCenterView,
} from './asset-v4';
import AssetPreview from './components/AssetPreview.vue';

const props = withDefaults(defineProps<{ initialWorkflow?: AssetWorkflow; open: boolean }>(), {
  initialWorkflow: 'EFFECT',
});
const emit = defineEmits<{ close: [] }>();
const {
  currentProject,
  error: projectsError,
  loading: projectsLoading,
  projects,
  reload,
  selectProject,
} = useProjectContext();
const currentProjectBinding = computed(() =>
  presentProjectBinding(
    currentProject.value,
    projects.value,
    projectsLoading.value,
    projectsError.value,
  ),
);
const currentProjectEmptyCopy = computed(() => {
  if (currentProjectBinding.value.state === 'empty') {
    return { title: '尚未创建项目', copy: '新建项目后会自动绑定，并显示在当前项目资产中。' };
  }
  if (currentProjectBinding.value.state === 'loading') {
    return { title: '正在加载项目', copy: '项目列表加载完成后即可选择当前项目。' };
  }
  if (currentProjectBinding.value.state === 'error') {
    return { title: '项目状态不可用', copy: '请刷新项目列表后重试。' };
  }
  return { title: '尚未绑定当前项目', copy: '请前往项目资产库，将一个项目设为当前项目。' };
});

type LoadStatus = 'idle' | 'loading' | 'success' | 'error';
const emptyFacets = (): AssetListFacets => ({ directories: [], types: [], tags: [] });
const view = ref<AssetCenterView>('current');
const workflow = ref<AssetWorkflow>(props.initialWorkflow);
const space = ref<AssetWorkflowSpace>(WORKFLOW_SPACES[props.initialWorkflow][0]!);
const browseProjectId = ref('');
const projectKeyword = ref('');
const globalProjectKeyword = ref('');
const libraryProjects = ref<Project[]>([]);
const libraryProjectsLoading = ref(false);
const libraryProjectsError = ref('');
const keyword = ref('');
const type = ref<'' | AssetType>('');
const page = ref(1);
const pageSize = ref(24);
const items = ref<Asset[]>([]);
const total = ref(0);
const facets = ref<AssetListFacets>(emptyFacets());
const paginationPageCount = ref(1);
const listStatus = ref<LoadStatus>('idle');
const listError = ref('');
const detail = ref<Asset | null>(null);
const detailStatus = ref<LoadStatus>('idle');
const detailError = ref('');
const versions = ref<AssetVersion[]>([]);
const versionsError = ref('');
const selectedIds = ref<string[]>([]);
const actionBusy = ref(false);
const actionError = ref('');
const toast = ref('');
const versionNote = ref('');
const fileInput = ref<HTMLInputElement | null>(null);
const drawer = ref<HTMLElement | null>(null);
let listController: AbortController | undefined;
let detailController: AbortController | undefined;
let actionController: AbortController | undefined;
let keywordTimer: ReturnType<typeof setTimeout> | undefined;
let projectKeywordTimer: ReturnType<typeof setTimeout> | undefined;
let projectListController: AbortController | undefined;
let toastTimer: ReturnType<typeof setTimeout> | undefined;
let generation = 0;

const browseProject = computed(
  () =>
    [...libraryProjects.value, ...projects.value].find(
      (project) => project.id === browseProjectId.value,
    ) ?? null,
);
const activeProject = computed(() =>
  view.value === 'current' ? currentProject.value : browseProject.value,
);
const isGlobalLibrary = computed(
  () => view.value === 'library' && GLOBAL_SPACES.has(space.value) && !browseProjectId.value,
);
const showingAssets = computed(
  () => view.value === 'current' || (view.value === 'library' && Boolean(browseProjectId.value)),
);
const availableTypes = computed(() =>
  typesForSpace(
    space.value,
    facets.value.types.map((option) => option.value),
  ),
);
const matchingProjects = computed(() => {
  const globalNeedle = globalProjectKeyword.value.trim().toLowerCase();
  const needle = (globalNeedle || projectKeyword.value.trim()).toLowerCase();
  return libraryProjects.value.filter((project) => {
    if (!globalNeedle && !projectMatchesSpace(project, space.value)) return false;
    if (!needle) return true;
    return [project.name, project.id, project.client, project.productName]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
      .includes(needle);
  });
});
const workflowCount = (key: AssetWorkflow): number => {
  if (view.value === 'library') {
    return projects.value.filter((project) =>
      WORKFLOW_SPACES[key].some((workflowSpace) => projectMatchesSpace(project, workflowSpace)),
    ).length;
  }
  const project = currentProject.value;
  if (!project) return 0;
  return WORKFLOW_SPACES[key].reduce(
    (sum, workflowSpace) => sum + (project.assetCounts?.[workflowSpace] ?? 0),
    0,
  );
};
const workflowDescription = (key: AssetWorkflow): string => {
  if (view.value === 'library') {
    return key === 'FISSION' ? '项目按 3 个业务分区隔离' : '先选项目，再浏览素材';
  }
  return key === 'FISSION' ? '包含 3 个业务分区' : '按项目隔离存储';
};
const contextTitle = computed(() => {
  if (view.value === 'current') return currentProjectBinding.value.label;
  if (browseProject.value) return browseProject.value.name;
  if (GLOBAL_SPACES.has(space.value))
    return `${WORKFLOW_META[workflow.value].label} · ${SPACE_LABELS[space.value]}`;
  return `${WORKFLOW_META[workflow.value].label}项目`;
});
const contextCopy = computed(() => {
  const project = activeProject.value;
  if (view.value === 'current' && !project) return currentProjectEmptyCopy.value.copy;
  if (view.value === 'current' && project) {
    return `${project.id} · ${project.status} · 仅展示本项目源资产和已调用引用`;
  }
  if (project) return `${project.id} · ${project.status} · 仅展示该项目在当前工作流的素材`;
  if (GLOBAL_SPACES.has(space.value)) return '全局共享资产空间，不归属具体项目';
  return '选择项目后再进入素材库，工作流之间独立存储';
});

const loadProjectLibrary = async (): Promise<void> => {
  if (
    !props.open ||
    view.value !== 'library' ||
    browseProjectId.value ||
    GLOBAL_SPACES.has(space.value)
  ) {
    libraryProjects.value = [];
    return;
  }
  projectListController?.abort();
  const controller = new AbortController();
  projectListController = controller;
  libraryProjectsLoading.value = true;
  libraryProjectsError.value = '';
  try {
    const response = await listProjectLibrary(
      {
        ...((globalProjectKeyword.value || projectKeyword.value).trim()
          ? { keyword: (globalProjectKeyword.value || projectKeyword.value).trim() }
          : {}),
        ...(globalProjectKeyword.value.trim()
          ? {}
          : { workflow: workflow.value, space: space.value }),
      },
      controller.signal,
    );
    if (!controller.signal.aborted) libraryProjects.value = response.data;
  } catch (error) {
    if (!isAbortError(error)) {
      libraryProjectsError.value = error instanceof Error ? error.message : '项目加载失败';
    }
  } finally {
    if (!controller.signal.aborted) libraryProjectsLoading.value = false;
  }
};
const allPageSelected = computed(
  () =>
    items.value.length > 0 && items.value.every((asset) => selectedIds.value.includes(asset.id)),
);
const pageCount = computed(() => Math.max(1, paginationPageCount.value));
const canUseInCurrent = computed(
  () => detail.value && currentProject.value && detail.value.projectId !== currentProject.value.id,
);

const showToast = (message: string): void => {
  toast.value = message;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.value = ''), 3200);
};

const resetAssetState = (): void => {
  listController?.abort();
  detailController?.abort();
  generation += 1;
  items.value = [];
  total.value = 0;
  facets.value = emptyFacets();
  selectedIds.value = [];
  detail.value = null;
  detailStatus.value = 'idle';
  detailError.value = '';
  versions.value = [];
  versionsError.value = '';
  listError.value = '';
};

const assetQuery = () => ({
  ...(keyword.value.trim() ? { keyword: keyword.value.trim() } : {}),
  ...(type.value ? { type: type.value } : {}),
  workflow: workflow.value,
  space: space.value,
  page: page.value,
  pageSize: pageSize.value,
});

const loadAssets = async (): Promise<void> => {
  const projectId = activeProject.value?.id;
  if (!props.open || !showingAssets.value || !projectId) {
    listStatus.value = 'idle';
    return;
  }
  listController?.abort();
  const controller = new AbortController();
  listController = controller;
  const requestGeneration = ++generation;
  items.value = [];
  selectedIds.value = [];
  listStatus.value = 'loading';
  listError.value = '';
  try {
    const response = await listAssets(projectId, assetQuery(), controller.signal);
    if (
      controller.signal.aborted ||
      requestGeneration !== generation ||
      activeProject.value?.id !== projectId
    )
      return;
    items.value = response.data.items;
    total.value = response.data.total;
    facets.value = response.data.facets;
    paginationPageCount.value =
      response.data.pagination?.pageCount ?? Math.ceil(response.data.total / pageSize.value);
    listStatus.value = 'success';
  } catch (error) {
    if (isAbortError(error)) return;
    if (requestGeneration !== generation) return;
    listError.value = error instanceof Error ? error.message : '资产加载失败';
    listStatus.value = 'error';
  }
};

const selectAsset = async (asset: Asset): Promise<void> => {
  const projectId = activeProject.value?.id;
  if (!projectId) return;
  detailController?.abort();
  const controller = new AbortController();
  detailController = controller;
  const assetId = asset.id;
  detail.value = asset;
  detailStatus.value = 'loading';
  detailError.value = '';
  versions.value = [];
  versionsError.value = '';
  try {
    const [detailResult, versionResult] = await Promise.allSettled([
      getAsset(projectId, assetId, controller.signal),
      listAssetVersions(projectId, assetId, controller.signal),
    ]);
    if (detailResult.status === 'rejected') throw detailResult.reason;
    if (
      controller.signal.aborted ||
      activeProject.value?.id !== projectId ||
      detail.value?.id !== assetId
    )
      return;
    detail.value = detailResult.value.data;
    if (versionResult.status === 'fulfilled') versions.value = versionResult.value.data.slice(0, 5);
    else versionsError.value = '版本时间线暂时不可用';
    detailStatus.value = 'success';
  } catch (error) {
    if (isAbortError(error)) return;
    detailError.value = error instanceof Error ? error.message : '详情加载失败';
    detailStatus.value = 'error';
  }
};

const setWorkflow = (next: AssetWorkflow): void => {
  workflow.value = next;
  space.value = WORKFLOW_SPACES[next][0]!;
};
const setSpace = (next: AssetWorkflowSpace): void => {
  space.value = next;
};

const enterProject = (project: Project): void => {
  browseProjectId.value = project.id;
  keyword.value = '';
  type.value = '';
  page.value = 1;
};

const createContextProject = async (): Promise<void> => {
  if (GLOBAL_SPACES.has(space.value)) return;
  actionBusy.value = true;
  actionError.value = '';
  try {
    const response = await createProject({
      name: '未命名营销项目',
      description: '等待补充项目资料',
      client: '待填写客户',
      productName: '待填写产品',
      workflow: workflow.value,
      space: space.value,
    });
    await reload();
    selectProject(response.data.id);
    view.value = 'current';
    browseProjectId.value = '';
    showToast(`“${response.data.name}”已创建并设为当前项目`);
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : '创建项目失败';
  } finally {
    actionBusy.value = false;
  }
};

const openUpload = (): void => {
  if (!type.value) {
    showToast('请先选择资产类型');
    return;
  }
  fileInput.value?.click();
};

const uploadFiles = async (event: Event): Promise<void> => {
  const target = event.target as HTMLInputElement;
  const files = Array.from(target.files ?? []);
  const projectId = activeProject.value?.id;
  if (!files.length || !projectId || !type.value) return;
  actionController?.abort();
  const controller = new AbortController();
  actionController = controller;
  actionBusy.value = true;
  actionError.value = '';
  try {
    const response = await importAssets(
      projectId,
      files,
      workflow.value,
      space.value,
      type.value,
      controller.signal,
    );
    showToast(`已上传 ${response.data.length} 个资产`);
    await loadAssets();
    if (response.data[0]) await selectAsset(response.data[0]);
  } catch (error) {
    if (!isAbortError(error))
      actionError.value = error instanceof Error ? error.message : '上传失败';
  } finally {
    actionBusy.value = false;
    target.value = '';
  }
};

const toggleSelect = (assetId: string): void => {
  selectedIds.value = selectedIds.value.includes(assetId)
    ? selectedIds.value.filter((id) => id !== assetId)
    : [...selectedIds.value, assetId];
};
const togglePage = (): void => {
  const pageIds = items.value.map((asset) => asset.id);
  selectedIds.value = allPageSelected.value
    ? selectedIds.value.filter((id) => !pageIds.includes(id))
    : [...new Set([...selectedIds.value, ...pageIds])];
};
const selectAllFiltered = async (): Promise<void> => {
  const projectId = activeProject.value?.id;
  if (!projectId || !total.value) return;
  actionController?.abort();
  const controller = new AbortController();
  actionController = controller;
  actionBusy.value = true;
  actionError.value = '';
  try {
    const ids: string[] = [];
    const batchSize = 96;
    const batchCount = Math.ceil(total.value / batchSize);
    for (let batchPage = 1; batchPage <= batchCount; batchPage += 1) {
      const response = await listAssets(
        projectId,
        { ...assetQuery(), page: batchPage, pageSize: batchSize },
        controller.signal,
      );
      ids.push(...response.data.items.map((asset) => asset.id));
    }
    selectedIds.value = [...new Set(ids)];
    showToast(`已选择全部 ${selectedIds.value.length} 项筛选结果`);
  } catch (error) {
    if (!isAbortError(error)) {
      actionError.value = error instanceof Error ? error.message : '全选筛选结果失败';
    }
  } finally {
    actionBusy.value = false;
  }
};

const runBatchTags = async (): Promise<void> => {
  const projectId = activeProject.value?.id;
  const tags = ['批量标记'];
  if (!projectId || !selectedIds.value.length) return;
  actionBusy.value = true;
  try {
    const response = await batchTagAssets(projectId, { assetIds: selectedIds.value, tags });
    showToast(`已为 ${response.data.affected} 项添加标签`);
    await loadAssets();
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : '批量打标签失败';
  } finally {
    actionBusy.value = false;
  }
};
const runBatchArchive = async (): Promise<void> => {
  const projectId = activeProject.value?.id;
  if (
    !projectId ||
    !selectedIds.value.length ||
    !window.confirm('确定移除选中的资产？移除后将不再出现在项目资产中。')
  )
    return;
  actionBusy.value = true;
  try {
    const response = await batchArchiveAssets(projectId, { assetIds: selectedIds.value });
    if (detail.value && selectedIds.value.includes(detail.value.id)) detail.value = null;
    showToast(`已移除 ${response.data.affected} 项`);
    await loadAssets();
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : '批量移除失败';
  } finally {
    actionBusy.value = false;
  }
};

const useAsset = async (): Promise<void> => {
  if (!detail.value || !currentProject.value) return;
  if (!canUseInCurrent.value) {
    showToast('资产已在当前项目，可直接用于工作流节点');
    return;
  }
  actionBusy.value = true;
  try {
    await importAssetSnapshot(currentProject.value.id, {
      sourceProjectId: detail.value.projectId,
      sourceAssetId: detail.value.id,
      sourceVersion: versionOf(detail.value),
      targetWorkflow: workflow.value,
      targetSpace: space.value,
    });
    showToast(`已引用到“${currentProject.value.name}”`);
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : '引用资产失败';
  } finally {
    actionBusy.value = false;
  }
};

const createVersion = async (): Promise<void> => {
  if (!detail.value || !versionNote.value.trim()) return;
  actionBusy.value = true;
  try {
    const response = await createAssetVersion(detail.value.projectId, detail.value.id, {
      changeNote: versionNote.value.trim(),
    });
    detail.value = response.data;
    versionNote.value = '';
    showToast(`已创建 v${versionOf(response.data)}`);
    await loadAssets();
    await selectAsset(response.data);
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : '创建版本失败';
  } finally {
    actionBusy.value = false;
  }
};

const upgradeSnapshot = async (): Promise<void> => {
  if (!detail.value) return;
  actionBusy.value = true;
  try {
    const response = await upgradeAssetSnapshot(detail.value.projectId, detail.value.id);
    detail.value = response.data;
    showToast(`已升级到源资产 v${versionOf(response.data)}`);
    await loadAssets();
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : '升级快照失败';
  } finally {
    actionBusy.value = false;
  }
};

const removeAsset = async (): Promise<void> => {
  if (!detail.value || !window.confirm('确定移除当前引用？源资产不会受到影响。')) return;
  const projectId = detail.value.projectId;
  const assetId = detail.value.id;
  actionBusy.value = true;
  try {
    await archiveAsset(projectId, assetId);
    detail.value = null;
    showToast('已移除引用，源资产未受影响');
    await loadAssets();
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : '移除失败';
  } finally {
    actionBusy.value = false;
  }
};

const close = (): void => {
  if (!actionBusy.value) emit('close');
};

watch([workflow, space], () => {
  browseProjectId.value = '';
  type.value = '';
  keyword.value = '';
  page.value = 1;
  resetAssetState();
  void loadAssets();
  void loadProjectLibrary();
});
watch(
  () => props.initialWorkflow,
  (nextWorkflow) => {
    if (workflow.value !== nextWorkflow) setWorkflow(nextWorkflow);
  },
);
watch([view, () => currentProject.value?.id, browseProjectId], () => {
  type.value = '';
  keyword.value = '';
  page.value = 1;
  resetAssetState();
  void loadAssets();
  void loadProjectLibrary();
});
watch([type, page, pageSize], () => {
  resetAssetState();
  void loadAssets();
});
watch(keyword, () => {
  if (keywordTimer) clearTimeout(keywordTimer);
  keywordTimer = setTimeout(() => {
    page.value = 1;
    resetAssetState();
    void loadAssets();
  }, 300);
});
watch(projectKeyword, () => {
  if (projectKeywordTimer) clearTimeout(projectKeywordTimer);
  projectKeywordTimer = setTimeout(() => void loadProjectLibrary(), 300);
});
watch(globalProjectKeyword, () => {
  if (projectKeywordTimer) clearTimeout(projectKeywordTimer);
  projectKeywordTimer = setTimeout(() => void loadProjectLibrary(), 300);
});
watch(
  () => props.open,
  (open) => {
    if (open) {
      void nextTick(() => drawer.value?.focus());
      void loadAssets();
      void loadProjectLibrary();
    } else resetAssetState();
  },
);

onBeforeUnmount(() => {
  listController?.abort();
  detailController?.abort();
  actionController?.abort();
  projectListController?.abort();
  if (keywordTimer) clearTimeout(keywordTimer);
  if (projectKeywordTimer) clearTimeout(projectKeywordTimer);
  if (toastTimer) clearTimeout(toastTimer);
});
</script>

<template>
  <Transition name="drawer-fade">
    <div v-if="open" class="asset-overlay" @mousedown.self="close">
      <section
        ref="drawer"
        class="asset-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="asset-title"
        tabindex="-1"
        @keydown.esc="close"
      >
        <header class="global-head">
          <h2 id="asset-title">项目与素材资产管理</h2>
          <button
            class="icon-button"
            type="button"
            aria-label="关闭"
            :disabled="actionBusy"
            @click="close"
          >
            <X :size="16" />
          </button>
        </header>

        <div class="asset-workbench">
          <aside class="asset-nav">
            <strong>项目与素材资产</strong>
            <div class="nav-business">
              <small>当前业务</small>
              <strong>{{ WORKFLOW_META[workflow].label }}</strong>
              <span>按工作流隔离存储，资产调用不受工作流限制</span>
            </div>
            <button :class="{ active: view === 'library' }" type="button" @click="view = 'library'">
              <Boxes :size="15" />项目资产库
            </button>
            <button :class="{ active: view === 'current' }" type="button" @click="view = 'current'">
              <FolderKanban :size="15" />当前项目资产
            </button>
            <small class="nav-section-label">当前项目</small>
            <div class="nav-current">
              <strong><FolderKanban :size="12" />{{ currentProjectBinding.label }}</strong>
              <span
                >{{ currentProject?.id || '—' }}<br />{{
                  currentProject?.status || currentProjectBinding.label
                }}</span
              >
            </div>
          </aside>

          <main class="asset-main">
            <header class="page-head">
              <div>
                <strong>{{ view === 'library' ? '项目资产库' : '当前项目资产' }}</strong>
                <span>{{
                  view === 'library'
                    ? '先选择工作流与项目，再浏览该项目素材'
                    : '管理当前项目自产资产与已调用的锁定版本'
                }}</span>
              </div>
              <button
                v-if="view === 'library' && !browseProjectId && !GLOBAL_SPACES.has(space)"
                class="secondary-button"
                type="button"
                :disabled="actionBusy"
                @click="createContextProject"
              >
                <CirclePlus :size="14" />新建{{ WORKFLOW_META[workflow].label }}项目
              </button>
            </header>
            <div class="project-context">
              <span class="context-icon"><FolderKanban :size="17" /></span>
              <div>
                <strong>{{ contextTitle }}</strong
                ><span>{{ contextCopy }}</span>
              </div>
              <button
                v-if="
                  view === 'library' && browseProject && browseProject.id !== currentProject?.id
                "
                class="primary-button"
                type="button"
                @click="selectProject(browseProject.id)"
              >
                设为当前项目
              </button>
              <span v-else class="context-badge">
                {{ view === 'current' ? (currentProject ? '当前项目' : '尚未绑定') : '项目级隔离' }}
              </span>
            </div>
            <label
              v-if="view === 'library' && !browseProjectId && !GLOBAL_SPACES.has(space)"
              class="global-search"
              ><strong><Search :size="14" />全局搜索项目</strong
              ><input
                v-model="globalProjectKeyword"
                placeholder="搜索项目名称、项目ID、客户或产品"
              /><small>覆盖效果类、定制类和裂变类项目</small></label
            >
            <div class="workflow-cards" role="tablist" aria-label="工作流">
              <button
                v-for="(meta, key) in WORKFLOW_META"
                :key="key"
                :class="{ active: workflow === key }"
                type="button"
                role="tab"
                :aria-selected="workflow === key"
                @click="setWorkflow(key)"
              >
                <i
                  ><Target v-if="key === 'EFFECT'" :size="15" /><Sparkles
                    v-else-if="key === 'CUSTOMIZED'"
                    :size="15" /><GitBranch v-else :size="15" /></i
                ><span
                  ><strong>{{ meta.label }}</strong
                  ><small>{{ workflowDescription(key) }}</small></span
                ><b>{{ workflowCount(key) }}</b>
              </button>
            </div>
            <div v-if="WORKFLOW_SPACES[workflow].length > 1" class="space-tabs">
              <button
                v-for="option in WORKFLOW_SPACES[workflow]"
                :key="option"
                :class="{ active: space === option }"
                type="button"
                @click="setSpace(option)"
              >
                {{ SPACE_LABELS[option] }}
              </button>
            </div>
            <div v-if="view === 'library' && browseProject" class="breadcrumb">
              <button type="button" @click="browseProjectId = ''">项目资产库</button
              ><ChevronRight :size="11" /><span
                >{{ WORKFLOW_META[workflow].label }} / {{ SPACE_LABELS[space] }}</span
              ><ChevronRight :size="11" /><strong>{{ browseProject.name }}</strong
              ><button type="button" @click="browseProjectId = ''">
                <ArrowLeft :size="12" />返回项目列表
              </button>
            </div>

            <section v-if="view === 'library' && !browseProjectId" class="project-library">
              <label class="project-search"
                ><input v-model="projectKeyword" placeholder="在当前工作流内搜索项目" /><span
                  >{{ WORKFLOW_META[workflow].label }} / {{ SPACE_LABELS[space] }} ·
                  {{ matchingProjects.length }} 个项目</span
                ></label
              >
              <div v-if="libraryProjectsLoading" class="large-state" aria-busy="true">
                <LoaderCircle class="spinner" :size="25" /><strong>正在加载项目…</strong>
              </div>
              <div v-else-if="libraryProjectsError" class="large-state error" role="alert">
                <AlertTriangle :size="25" /><strong>项目加载失败</strong>
                <p>{{ libraryProjectsError }}</p>
                <button class="secondary-button" type="button" @click="loadProjectLibrary">
                  <RefreshCw :size="14" />重试
                </button>
              </div>
              <div v-else-if="isGlobalLibrary" class="large-state">
                <PackageOpen :size="35" /><strong>{{ SPACE_LABELS[space] }}暂无公共资产</strong>
                <p>
                  公共{{
                    space === 'FISSION_AVATAR' ? '数字人' : '音色'
                  }}需先导入当前项目，才能用于工作流。
                </p>
              </div>
              <div v-else-if="!matchingProjects.length" class="large-state">
                <FolderKanban :size="35" /><strong>{{
                  projectKeyword ? '没有匹配的项目' : '该工作流还没有项目'
                }}</strong>
                <p>创建项目后即可进入专属资产空间。</p>
              </div>
              <div v-else class="project-grid">
                <article
                  v-for="project in matchingProjects"
                  :key="project.id"
                  class="project-card"
                  :class="{ current: project.id === currentProject?.id }"
                  role="button"
                  tabindex="0"
                  @click="enterProject(project)"
                  @keydown.enter="enterProject(project)"
                >
                  <header>
                    <span class="project-card-icon"><FolderKanban :size="18" /></span>
                    <div>
                      <h3>{{ project.name }}</h3>
                      <p>
                        {{ project.id }} · {{ project.client || '未填写客户' }} ·
                        {{ project.status }}
                      </p>
                    </div>
                    <span v-if="project.id === currentProject?.id" class="current-badge"
                      >当前项目</span
                    >
                  </header>
                  <p>{{ project.description || '等待补充项目简介' }}</p>
                  <footer>
                    <em>{{ WORKFLOW_META[workflow].label }} / {{ SPACE_LABELS[space] }}</em
                    ><span>{{ project.productName || '未填写产品' }}</span
                    ><b
                      >{{ project.assetCounts?.[space] || 0 }} 项素材 <ChevronRight :size="11"
                    /></b>
                  </footer>
                </article>
              </div>
            </section>

            <section v-else class="asset-space">
              <div v-if="!activeProject" class="large-state">
                <FolderKanban :size="35" /><strong>{{ currentProjectEmptyCopy.title }}</strong>
                <p>{{ currentProjectEmptyCopy.copy }}</p>
              </div>
              <template v-else>
                <div class="asset-tools">
                  <label class="asset-search"
                    ><Search :size="14" /><input
                      v-model="keyword"
                      placeholder="搜索名称、Prompt ID、任务ID、镜号或标签"
                  /></label>
                  <div class="type-chips">
                    <button :class="{ active: !type }" type="button" @click="type = ''">
                      全部 <small>{{ total }}</small></button
                    ><button
                      v-for="option in availableTypes"
                      :key="option"
                      :class="{ active: type === option }"
                      type="button"
                      @click="type = option"
                    >
                      {{ typeLabel(option) }}
                      <small>{{
                        facets.types.find((facet) => facet.value === option)?.count ?? 0
                      }}</small>
                    </button>
                  </div>
                  <button
                    v-if="type"
                    class="upload-button"
                    type="button"
                    :disabled="actionBusy"
                    @click="openUpload"
                  >
                    <UploadCloud :size="14" />上传{{ typeLabel(type) }}
                  </button>
                  <label class="select-control"
                    ><input
                      type="checkbox"
                      :checked="allPageSelected"
                      @change="togglePage"
                    />全选本页 {{ items.length }} 项</label
                  >
                  <label class="select-control"
                    ><input
                      type="checkbox"
                      :checked="selectedIds.length === total && total > 0"
                      @change="selectAllFiltered"
                    />全选筛选结果 {{ total }} 项</label
                  >
                  <button
                    class="secondary-button"
                    type="button"
                    :disabled="!selectedIds.length || actionBusy"
                    @click="runBatchTags"
                  >
                    批量打标签
                  </button>
                  <button
                    class="secondary-button danger-link"
                    type="button"
                    :disabled="!selectedIds.length || actionBusy"
                    @click="runBatchArchive"
                  >
                    批量删除
                  </button>
                  <input
                    ref="fileInput"
                    class="sr-only"
                    type="file"
                    multiple
                    :accept="type ? uploadAccept(type) : undefined"
                    @change="uploadFiles"
                  />
                </div>

                <div class="workspace" :aria-busy="listStatus === 'loading'">
                  <div class="asset-browser">
                    <div v-if="listStatus === 'loading'" class="card-grid">
                      <div v-for="index in 6" :key="index" class="asset-card skeleton-card">
                        <span class="skeleton preview" /><span class="skeleton title" /><span
                          class="skeleton line"
                        />
                      </div>
                    </div>
                    <div v-else-if="listStatus === 'error'" class="large-state error" role="alert">
                      <AlertTriangle :size="27" /><strong>资产加载失败</strong>
                      <p>{{ listError }}</p>
                      <button class="secondary-button" type="button" @click="loadAssets">
                        <RefreshCw :size="14" />重新加载
                      </button>
                    </div>
                    <div v-else-if="listStatus === 'success' && !items.length" class="large-state">
                      <PackageOpen :size="35" /><strong>{{
                        keyword || type ? '没有符合条件的资产' : '当前项目还没有资产'
                      }}</strong>
                      <p>
                        {{
                          type
                            ? `可通过“按${typeLabel(type)}上传”添加多个文件。`
                            : '选择资产类型后即可按类型批量上传。'
                        }}
                      </p>
                    </div>
                    <div v-else class="card-grid">
                      <article
                        v-for="asset in items"
                        :key="asset.id"
                        class="asset-card"
                        :class="{
                          selected: detail?.id === asset.id,
                          checked: selectedIds.includes(asset.id),
                        }"
                        tabindex="0"
                        role="button"
                        :aria-pressed="detail?.id === asset.id"
                        @click="selectAsset(asset)"
                        @keydown.enter="selectAsset(asset)"
                      >
                        <button
                          class="card-check"
                          type="button"
                          :aria-label="`选择${asset.name}`"
                          @click.stop="toggleSelect(asset.id)"
                        >
                          <Check v-if="selectedIds.includes(asset.id)" :size="12" /><Square
                            v-else
                            :size="13"
                          />
                        </button>
                        <AssetPreview :asset="asset" compact />
                        <div class="card-copy">
                          <div>
                            <span class="type-badge">{{ typeLabel(asset.type) }}</span
                            ><span class="status-dot" :class="STATUS_CLASS[statusOf(asset)]">{{
                              STATUS_LABELS[statusOf(asset)]
                            }}</span>
                          </div>
                          <strong>{{ asset.name }}</strong>
                          <p>{{ asset.notes || asset.originalFileName }}</p>
                          <footer>
                            <span>v{{ versionOf(asset) }}</span
                            ><span v-if="asset.isSnapshot || asset.sourceAssetId"
                              ><Link2 :size="10" />快照</span
                            ><span>{{
                              new Date(asset.updatedAt).toLocaleDateString('zh-CN')
                            }}</span>
                          </footer>
                        </div>
                      </article>
                    </div>
                    <footer v-if="listStatus === 'success'" class="pager">
                      <span
                        >显示 {{ total ? (page - 1) * pageSize + 1 : 0 }}–{{
                          Math.min(page * pageSize, total)
                        }}
                        / {{ total }} 项</span
                      ><label
                        >每页
                        <select v-model.number="pageSize">
                          <option :value="24">24</option>
                          <option :value="48">48</option>
                          <option :value="96">96</option>
                        </select></label
                      ><button type="button" :disabled="page <= 1" @click="page -= 1">上一页</button
                      ><strong>第 {{ page }} / {{ pageCount }} 页</strong
                      ><button type="button" :disabled="page >= pageCount" @click="page += 1">
                        下一页
                      </button>
                    </footer>
                  </div>

                  <aside class="asset-detail" :class="{ open: detail }">
                    <button v-if="detail" class="mobile-close" type="button" @click="detail = null">
                      <X :size="15" />
                    </button>
                    <div v-if="!detail" class="detail-placeholder">
                      <Boxes :size="34" /><strong>选择一项资产查看详情</strong
                      ><span>这里会显示内容、来源、依赖与版本记录</span>
                    </div>
                    <div v-else-if="detailStatus === 'error'" class="large-state error">
                      <AlertTriangle :size="25" /><strong>详情加载失败</strong>
                      <p>{{ detailError }}</p>
                      <button class="secondary-button" type="button" @click="selectAsset(detail)">
                        重试
                      </button>
                    </div>
                    <div v-else class="detail-content">
                      <AssetPreview :asset="detail" />
                      <header>
                        <div>
                          <span class="type-badge">{{ typeLabel(detail.type) }}</span
                          ><span class="status-dot" :class="STATUS_CLASS[statusOf(detail)]">{{
                            STATUS_LABELS[statusOf(detail)]
                          }}</span
                          ><span v-if="detail.readOnly" class="readonly">只读快照</span>
                        </div>
                        <h2>{{ detail.name }}</h2>
                        <p>{{ detail.notes || '暂无资产说明' }}</p>
                      </header>
                      <section>
                        <h3>内容与规格</h3>
                        <dl>
                          <div>
                            <dt>文件</dt>
                            <dd>{{ detail.originalFileName || '结构化资产' }}</dd>
                          </div>
                          <div>
                            <dt>格式</dt>
                            <dd>{{ detail.mimeType || detail.contentKind || '结构化内容' }}</dd>
                          </div>
                          <div>
                            <dt>版本</dt>
                            <dd>v{{ versionOf(detail) }}</dd>
                          </div>
                          <div>
                            <dt>更新时间</dt>
                            <dd>{{ new Date(detail.updatedAt).toLocaleString('zh-CN') }}</dd>
                          </div>
                        </dl>
                        <div class="tag-row">
                          <span v-for="tag in detail.tags" :key="tag"># {{ tag }}</span
                          ><span v-if="!detail.tags.length">暂无标签</span>
                        </div>
                      </section>
                      <footer class="detail-actions">
                        <button
                          v-if="(detail.isSnapshot || detail.sourceAssetId) && detail.outdated"
                          class="primary-button detail-wide"
                          type="button"
                          :disabled="actionBusy"
                          @click="upgradeSnapshot"
                        >
                          升级到来源最新版
                        </button>
                        <button
                          class="primary-button"
                          :class="{ 'detail-wide': !(detail.isSnapshot || detail.sourceAssetId) }"
                          type="button"
                          :disabled="actionBusy || !currentProject"
                          @click="useAsset"
                        >
                          <Link2 :size="14" />调用到当前模块</button
                        ><button
                          v-if="detail.isSnapshot || detail.sourceAssetId"
                          class="remove-button"
                          type="button"
                          :disabled="actionBusy"
                          @click="removeAsset"
                        >
                          <Trash2 :size="14" />移除引用
                        </button>
                      </footer>
                      <details class="detail-fold">
                        <summary>查看来源、版本与依赖</summary>
                        <section>
                          <dl>
                            <div>
                              <dt>来源项目</dt>
                              <dd>{{ detail.sourceProjectId || detail.projectId }}</dd>
                            </div>
                            <div>
                              <dt>来源节点</dt>
                              <dd>{{ detail.sourceNode || '本地上传' }}</dd>
                            </div>
                            <div>
                              <dt>
                                {{
                                  detail.isSnapshot || detail.sourceAssetId
                                    ? '锁定版本'
                                    : '当前版本'
                                }}
                              </dt>
                              <dd>v{{ detail.sourceVersion || versionOf(detail) }}</dd>
                            </div>
                            <div v-if="detail.isSnapshot || detail.sourceAssetId">
                              <dt>来源最新版</dt>
                              <dd>
                                v{{
                                  detail.sourceCurrentVersion ||
                                  detail.sourceVersion ||
                                  versionOf(detail)
                                }}{{ detail.outdated ? ' · 可升级' : '' }}
                              </dd>
                            </div>
                          </dl>
                          <h3>上游依赖</h3>
                          <div v-if="detail.dependencies?.length" class="dependencies">
                            <span
                              v-for="dependency in detail.dependencies"
                              :key="dependency.sourceAssetId"
                              ><Link2 :size="11" />{{
                                dependency.name || dependency.sourceAssetId
                              }}
                              · v{{ dependency.lockedVersion }}</span
                            >
                          </div>
                          <p v-else class="muted">该资产没有登记上游依赖。</p>
                          <h3>版本时间线</h3>
                          <div v-if="versions.length" class="version-timeline">
                            <article v-for="version in versions" :key="version.id">
                              <strong>v{{ version.version }}</strong
                              ><span>{{ version.changeNote }}</span
                              ><small>{{
                                new Date(version.createdAt).toLocaleString('zh-CN')
                              }}</small>
                            </article>
                          </div>
                          <p v-else class="muted">{{ versionsError || '暂无版本记录' }}</p>
                        </section>
                      </details>
                      <div v-if="detail.isSnapshot || detail.sourceAssetId" class="snapshot-note">
                        <Link2 :size="13" /><span
                          >当前项目使用锁定版本；来源升级不会自动改变现有任务。</span
                        >
                      </div>
                      <details v-else class="detail-fold">
                        <summary>生成新版本</summary>
                        <section class="version-panel">
                          <textarea
                            v-model="versionNote"
                            rows="2"
                            placeholder="填写本次版本修改说明"
                          /><button
                            class="primary-button detail-wide"
                            type="button"
                            :disabled="!versionNote.trim() || actionBusy"
                            @click="createVersion"
                          >
                            生成新版本
                          </button>
                        </section>
                      </details>
                    </div>
                  </aside>
                </div>
              </template>
            </section>
          </main>
        </div>
        <div v-if="actionBusy" class="operation-mask" aria-live="polite">
          <LoaderCircle class="spinner" :size="20" />处理中…
        </div>
        <div v-if="actionError" class="action-error" role="alert">
          <AlertTriangle :size="14" />{{ actionError
          }}<button type="button" @click="actionError = ''"><X :size="13" /></button>
        </div>
        <Transition name="toast">
          <div v-if="toast" class="asset-toast" role="status"><Check :size="14" />{{ toast }}</div>
        </Transition>
      </section>
    </div>
  </Transition>
</template>

<style scoped>
.asset-overlay {
  position: fixed;
  z-index: 80;
  inset: 0;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  background: #0f172a72;
  backdrop-filter: blur(2px);
}
.asset-drawer {
  --blue: #2766ed;
  position: relative;
  width: min(96vw, 1760px);
  height: 100vh;
  overflow: hidden;
  color: #17233a;
  background: #fff;
  box-shadow: 0 22px 70px #101a2e3d;
  outline: none;
}
.global-head {
  height: 54px;
  display: flex;
  padding: 8px 14px 8px 16px;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid #dce5f1;
  background: #fff;
}
.global-head > div {
  display: flex;
  align-items: center;
  gap: 9px;
}
.global-icon {
  display: grid;
  width: 32px;
  height: 32px;
  place-items: center;
  border-radius: 8px;
  background: #2766ed;
  color: #fff;
}
.global-head h2 {
  margin: 0;
  font-size: 16px;
}
.global-head p {
  margin: 2px 0 0;
  color: #8290a5;
  font-size: 8px;
}
.icon-button {
  display: grid;
  width: 31px;
  height: 31px;
  padding: 0;
  place-items: center;
  border: 1px solid #d7e1ee;
  border-radius: 7px;
  background: #fff;
  color: #69788e;
}
.asset-workbench {
  height: calc(100% - 54px);
  display: grid;
  grid-template-columns: 184px minmax(0, 1fr);
}
.asset-nav {
  display: flex;
  min-height: 0;
  padding: 15px 10px 12px;
  flex-direction: column;
  border-right: 1px solid #dce4ef;
  background: #f6f9fd;
}
.asset-nav > strong {
  padding: 0 8px 9px;
  color: #8895a8;
  font-size: 8px;
  letter-spacing: 0.14em;
}
.asset-nav > button {
  display: flex;
  width: 100%;
  padding: 10px 9px;
  align-items: center;
  gap: 8px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: #52627a;
  text-align: left;
}
.asset-nav > button.active {
  background: #e8f0ff;
  color: #2766ed;
}
.asset-nav > button span {
  display: flex;
  flex-direction: column;
  font-size: 10px;
  font-weight: 900;
}
.asset-nav > button small {
  margin-top: 2px;
  color: #8c98aa;
  font-size: 7px;
  font-weight: 600;
}
.nav-current {
  margin-top: 16px;
  padding: 10px;
  border: 1px solid #d8e3f3;
  border-radius: 9px;
  background: #fff;
}
.nav-current > * {
  display: block;
}
.nav-current small {
  color: #8a96a8;
  font-size: 7px;
}
.nav-current strong {
  margin: 5px 0;
  overflow: hidden;
  font-size: 9px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.nav-current span {
  color: #8390a3;
  font-size: 7px;
}
.asset-nav > p {
  margin: auto 6px 0;
  color: #8c98aa;
  font-size: 7px;
  line-height: 1.6;
}
.asset-main {
  display: flex;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
}
.workflow-tabs {
  height: 47px;
  display: flex;
  padding: 0 12px;
  align-items: stretch;
  gap: 4px;
  border-bottom: 1px solid #dde5ef;
}
.workflow-tabs > button:not(.icon-button) {
  position: relative;
  display: flex;
  padding: 0 14px;
  align-items: center;
  gap: 6px;
  border: 0;
  background: transparent;
  color: #627187;
  font-size: 10px;
  font-weight: 900;
}
.workflow-tabs > button.active {
  color: #2766ed;
}
.workflow-tabs > button.active:after {
  position: absolute;
  right: 9px;
  bottom: 0;
  left: 9px;
  height: 3px;
  border-radius: 3px 3px 0 0;
  background: #2766ed;
  content: '';
}
.workflow-tabs > span {
  flex: 1;
}
.workflow-tabs .icon-button {
  align-self: center;
}
.space-tabs {
  height: 38px;
  display: flex;
  padding: 5px 13px;
  gap: 5px;
  border-bottom: 1px solid #e3e9f2;
  background: #f8faff;
}
.space-tabs button {
  padding: 0 10px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: #6d7b8f;
  font-size: 9px;
  font-weight: 800;
}
.space-tabs button.active {
  border-color: #c5d7f8;
  background: #fff;
  color: #2766ed;
  box-shadow: 0 2px 7px #2f65b814;
}
.project-library,
.asset-space {
  min-height: 0;
  flex: 1;
  overflow: auto;
  background: #f7f9fc;
}
.page-heading {
  display: flex;
  padding: 22px 24px 17px;
  align-items: center;
  justify-content: space-between;
}
.page-heading span {
  color: #2766ed;
  font-size: 8px;
  font-weight: 900;
  letter-spacing: 0.14em;
}
.page-heading h1,
.asset-heading h1 {
  margin: 5px 0 4px;
  font-size: 19px;
}
.page-heading p,
.asset-heading p {
  margin: 0;
  color: #7d899c;
  font-size: 9px;
}
.primary-button,
.secondary-button,
.back-button {
  display: inline-flex;
  min-height: 32px;
  padding: 0 11px;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border-radius: 7px;
  font-size: 9px;
  font-weight: 900;
  text-decoration: none;
}
.primary-button {
  border: 1px solid #2766ed;
  background: #2766ed;
  color: #fff;
}
.secondary-button,
.back-button {
  border: 1px solid #d3deec;
  background: #fff;
  color: #53647b;
}
.wide-search {
  height: 38px;
  display: flex;
  margin: 0 24px 16px;
  padding: 0 11px;
  align-items: center;
  gap: 7px;
  border: 1px solid #d8e2ef;
  border-radius: 8px;
  background: #fff;
  color: #7b899d;
}
.wide-search input,
.filter-row input,
.batch-bar input {
  width: 100%;
  border: 0;
  outline: 0;
  background: transparent;
  color: #26364f;
  font-size: 9px;
}
.project-grid {
  display: grid;
  padding: 0 24px 24px;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}
.project-card {
  display: grid;
  min-height: 82px;
  padding: 13px;
  grid-template-columns: 39px minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  border: 1px solid #d9e3ef;
  border-radius: 10px;
  background: #fff;
  color: #25354d;
  text-align: left;
  box-shadow: 0 4px 13px #3659870a;
}
.project-card:hover {
  border-color: #7ea5ee;
  background: #f8fbff;
}
.project-card-icon {
  display: grid;
  width: 39px;
  height: 39px;
  place-items: center;
  border-radius: 9px;
  background: #e8f0ff;
  color: #2766ed;
}
.project-card strong {
  display: block;
  overflow: hidden;
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.project-card p {
  margin: 5px 0;
  color: #708097;
  font-size: 8px;
}
.project-card small {
  color: #929daf;
  font-size: 7px;
}
.asset-heading {
  padding: 10px 16px 9px;
  border-bottom: 1px solid #dfe6f0;
  background: #fff;
}
.back-button {
  min-height: 27px;
  margin-bottom: 6px;
  padding: 0 8px;
}
.breadcrumb {
  display: flex;
  align-items: center;
  gap: 4px;
  color: #8390a3;
  font-size: 7px;
}
.breadcrumb strong {
  color: #54657c;
}
.asset-heading-row {
  display: flex;
  margin-top: 5px;
  align-items: center;
  justify-content: space-between;
}
.asset-heading h1 {
  margin: 0;
  font-size: 15px;
}
.asset-heading-row select,
.pager select {
  height: 29px;
  padding: 0 24px 0 8px;
  border: 1px solid #d4dfed;
  border-radius: 6px;
  background: #fff;
  color: #43546d;
  font-size: 9px;
}
.type-toolbar {
  display: flex;
  padding: 9px 13px;
  align-items: flex-start;
  gap: 9px;
  border-bottom: 1px solid #e0e7f0;
  background: #fff;
}
.type-chips {
  display: flex;
  flex: 1;
  flex-wrap: wrap;
  gap: 5px;
}
.type-chips button {
  height: 26px;
  padding: 0 8px;
  border: 1px solid #d6e0ec;
  border-radius: 999px;
  background: #fff;
  color: #647389;
  font-size: 8px;
  font-weight: 800;
}
.type-chips button.active {
  border-color: #2766ed;
  background: #eaf1ff;
  color: #2766ed;
}
.type-chips small {
  margin-left: 3px;
  color: #8f9aab;
  font-size: 7px;
}
.upload-button {
  min-height: 29px;
  white-space: nowrap;
}
.filter-row {
  height: 42px;
  display: flex;
  padding: 6px 13px;
  align-items: center;
  gap: 11px;
  border-bottom: 1px solid #e2e8f0;
  background: #f8faff;
}
.filter-row label {
  height: 30px;
  display: flex;
  min-width: 240px;
  max-width: 460px;
  flex: 1;
  padding: 0 9px;
  align-items: center;
  gap: 6px;
  border: 1px solid #d7e1ed;
  border-radius: 7px;
  background: #fff;
  color: #7a889c;
}
.filter-row > span {
  color: #8190a4;
  font-size: 8px;
}
.selection-row,
.batch-bar {
  height: 36px;
  display: flex;
  padding: 5px 13px;
  align-items: center;
  gap: 9px;
  border-bottom: 1px solid #dfe6f0;
  background: #fff;
  color: #7d899b;
  font-size: 8px;
}
.selection-row button,
.batch-bar > button {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border: 0;
  background: transparent;
  color: #586981;
  font-size: 8px;
  font-weight: 800;
}
.batch-bar {
  background: #edf4ff;
  color: #2766ed;
}
.batch-bar strong {
  font-size: 8px;
}
.batch-bar label {
  height: 26px;
  display: flex;
  margin-left: auto;
  padding-left: 7px;
  align-items: center;
  border: 1px solid #cbdcf9;
  border-radius: 6px;
  background: #fff;
}
.batch-bar label input {
  width: 130px;
}
.batch-bar label button {
  height: 100%;
  border: 0;
  border-left: 1px solid #dbe6f7;
  background: #f7faff;
  color: #2766ed;
  font-size: 8px;
  font-weight: 900;
}
.batch-bar .danger-link {
  color: #b42318;
}
.workspace {
  height: calc(100% - 187px);
  min-height: 400px;
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(480px, 34%);
}
.asset-browser {
  display: flex;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  overflow: auto;
}
.card-grid {
  display: grid;
  padding: 12px;
  grid-template-columns: repeat(2, minmax(238px, 1fr));
  gap: 9px;
}
.asset-card {
  position: relative;
  min-width: 0;
  overflow: hidden;
  border: 1px solid #d9e2ed;
  border-radius: 10px;
  background: #fff;
  outline: 0;
  box-shadow: 0 4px 12px #334f7508;
}
.asset-card:hover,
.asset-card:focus-visible,
.asset-card.selected {
  border-color: #6d9aef;
  box-shadow: 0 0 0 2px #dfebff;
}
.asset-card.checked {
  background: #f5f8ff;
}
.card-check {
  position: absolute;
  z-index: 2;
  top: 7px;
  left: 7px;
  display: grid;
  width: 22px;
  height: 22px;
  padding: 0;
  place-items: center;
  border: 1px solid #cedbeb;
  border-radius: 5px;
  background: #fffffff0;
  color: #2766ed;
}
.card-copy {
  padding: 9px 10px 10px;
}
.card-copy > div {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.type-badge {
  display: inline-block;
  padding: 3px 6px;
  border-radius: 4px;
  background: #e9f1ff;
  color: #2766ed;
  font-size: 7px;
  font-weight: 900;
}
.status-dot {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: #627187;
  font-size: 7px;
}
.status-dot:before {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: #2fa678;
  content: '';
}
.status-dot.orange:before {
  background: #e8952c;
}
.status-dot.red:before {
  background: #d34b45;
}
.card-copy > strong {
  display: block;
  margin-top: 7px;
  overflow: hidden;
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.card-copy > p {
  margin: 5px 0 8px;
  overflow: hidden;
  color: #7d899c;
  font-size: 8px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.card-copy footer {
  display: flex;
  align-items: center;
  gap: 8px;
  color: #8290a3;
  font-size: 7px;
}
.card-copy footer span {
  display: inline-flex;
  align-items: center;
  gap: 3px;
}
.card-copy footer span:last-child {
  margin-left: auto;
}
.pager {
  height: 42px;
  display: flex;
  margin-top: auto;
  padding: 6px 13px;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
  border-top: 1px solid #dfe6ef;
  background: #fff;
  color: #77859a;
  font-size: 8px;
}
.pager span {
  margin-right: auto;
}
.pager button {
  display: grid;
  width: 27px;
  height: 27px;
  padding: 0;
  place-items: center;
  border: 1px solid #d5dfeb;
  border-radius: 6px;
  background: #fff;
  color: #53647a;
}
.pager strong {
  padding: 0 5px;
  color: #53647a;
  font-size: 8px;
}
.asset-detail {
  min-width: 0;
  min-height: 0;
  padding: 12px;
  overflow: auto;
  border-left: 1px solid #dfe6ef;
  background: #fff;
}
.detail-placeholder,
.large-state {
  min-height: 260px;
  display: flex;
  padding: 30px;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: 8px;
  color: #8491a4;
  text-align: center;
}
.detail-placeholder strong,
.large-state strong {
  color: #43536a;
  font-size: 11px;
}
.detail-placeholder span,
.large-state p {
  margin: 0;
  color: #8591a4;
  font-size: 9px;
  line-height: 1.5;
}
.large-state.error {
  color: #b42318;
}
.large-state.error strong {
  color: #a62821;
}
.detail-content > header {
  padding: 12px 2px;
  border-bottom: 1px solid #e5eaf1;
}
.detail-content > header > div {
  display: flex;
  align-items: center;
  gap: 7px;
}
.readonly {
  padding: 3px 6px;
  border-radius: 4px;
  background: #f1f3f7;
  color: #6b7789;
  font-size: 7px;
  font-weight: 800;
}
.detail-content h2 {
  margin: 9px 0 4px;
  font-size: 15px;
}
.detail-content > header p,
.muted {
  margin: 0;
  color: #78869a;
  font-size: 8px;
  line-height: 1.6;
}
.detail-content section {
  padding: 11px 2px;
  border-bottom: 1px solid #e8edf3;
}
.detail-content h3 {
  margin: 0 0 7px;
  color: #46566d;
  font-size: 9px;
}
dl {
  margin: 0;
}
dl div {
  display: grid;
  padding: 3px 0;
  grid-template-columns: 68px minmax(0, 1fr);
  gap: 6px;
  font-size: 8px;
}
dt {
  color: #8b97a8;
}
dd {
  margin: 0;
  overflow-wrap: anywhere;
  color: #53637a;
}
.tag-row,
.dependencies {
  display: flex;
  margin-top: 8px;
  flex-wrap: wrap;
  gap: 5px;
}
.tag-row span,
.dependencies span {
  display: inline-flex;
  padding: 4px 6px;
  align-items: center;
  gap: 4px;
  border-radius: 5px;
  background: #f0f4fa;
  color: #586d8c;
  font-size: 7px;
}
.version-panel textarea {
  width: 100%;
  padding: 8px;
  border: 1px solid #d6e0ec;
  border-radius: 7px;
  outline: 0;
  resize: vertical;
  font-size: 8px;
}
.version-panel .secondary-button {
  margin-top: 6px;
}
.snapshot-note {
  display: flex;
  padding: 8px;
  align-items: center;
  gap: 7px;
  border: 1px solid #cbdcf9;
  border-radius: 7px;
  background: #f1f6ff;
  color: #41679e;
  font-size: 8px;
}
.snapshot-note span {
  flex: 1;
}
.snapshot-note button {
  border: 0;
  background: transparent;
  color: #2766ed;
  font-size: 8px;
  font-weight: 900;
}
.snapshot-note.outdated {
  border-color: #f2cf9c;
  background: #fff8eb;
  color: #9a621e;
}
.detail-actions {
  display: grid;
  padding: 12px 0;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
}
.detail-wide {
  grid-column: 1 / -1;
}
.detail-fold {
  border-bottom: 1px solid #e5ebf3;
}
.detail-fold summary {
  padding: 13px 2px;
  color: #40516c;
  font-size: 10px;
  font-weight: 800;
  cursor: pointer;
}
.detail-fold section {
  padding-top: 4px;
}
.version-timeline {
  display: grid;
  gap: 3px;
}
.version-timeline article {
  display: grid;
  padding: 6px 0;
  grid-template-columns: 34px minmax(0, 1fr) auto;
  gap: 8px;
  color: #77859a;
  font-size: 8px;
}
.version-timeline strong {
  color: #2766ed;
}
.version-timeline small {
  color: #97a1af;
}
.detail-content > .snapshot-note {
  margin: 9px 2px 12px;
}
.remove-button {
  display: inline-flex;
  min-height: 32px;
  padding: 0 9px;
  align-items: center;
  gap: 5px;
  border: 1px solid #edcbc8;
  border-radius: 7px;
  background: #fff8f7;
  color: #b42318;
  font-size: 8px;
  font-weight: 900;
}
.mobile-close {
  display: none;
}
.operation-mask {
  position: absolute;
  z-index: 6;
  top: 62px;
  left: 50%;
  display: flex;
  padding: 8px 12px;
  align-items: center;
  gap: 6px;
  border-radius: 999px;
  background: #17233ae8;
  color: #fff;
  font-size: 9px;
  transform: translateX(-50%);
}
.action-error {
  position: absolute;
  z-index: 7;
  right: 18px;
  bottom: 17px;
  display: flex;
  max-width: 440px;
  padding: 9px 11px;
  align-items: center;
  gap: 7px;
  border: 1px solid #f1c4bf;
  border-radius: 8px;
  background: #fff4f2;
  color: #a92e26;
  font-size: 9px;
  box-shadow: 0 10px 24px #17233a1f;
}
.action-error button {
  display: grid;
  margin-left: auto;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
}
.asset-toast {
  position: absolute;
  z-index: 8;
  top: 63px;
  left: 50%;
  display: flex;
  padding: 8px 13px;
  align-items: center;
  gap: 6px;
  border-radius: 999px;
  background: #17233aed;
  color: #fff;
  font-size: 9px;
  font-weight: 800;
  transform: translateX(-50%);
}
.skeleton {
  display: block;
  border-radius: 6px;
  background: linear-gradient(90deg, #edf1f6, #fafbfd, #edf1f6);
  background-size: 200% 100%;
  animation: shimmer 1.2s infinite;
}
.skeleton.preview {
  height: 144px;
  border-radius: 0;
}
.skeleton.title {
  width: 67%;
  height: 10px;
  margin: 11px;
}
.skeleton.line {
  width: 42%;
  height: 7px;
  margin: 0 11px 12px;
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
.spinner {
  animation: spin 0.8s linear infinite;
}
button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}
.drawer-fade-enter-active,
.drawer-fade-leave-active,
.toast-enter-active,
.toast-leave-active {
  transition: opacity 0.16s;
}
.drawer-fade-enter-from,
.drawer-fade-leave-to,
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
@keyframes shimmer {
  to {
    background-position: -200% 0;
  }
}
@media (max-width: 1320px) {
  .workspace {
    grid-template-columns: minmax(0, 1fr) 480px;
  }
  .card-grid {
    grid-template-columns: 1fr;
  }
}
@media (max-width: 980px) {
  .asset-drawer {
    width: 100vw;
  }
  .asset-workbench {
    grid-template-columns: 1fr;
  }
  .asset-nav {
    display: none;
  }
  .workspace {
    position: relative;
    grid-template-columns: 1fr;
  }
  .asset-detail {
    position: absolute;
    z-index: 4;
    top: 0;
    right: 0;
    bottom: 0;
    width: min(520px, 100%);
    display: none;
    box-shadow: -16px 0 38px #17233a2b;
  }
  .asset-detail.open {
    display: block;
  }
  .mobile-close {
    position: sticky;
    z-index: 5;
    top: 0;
    display: grid;
    width: 28px;
    height: 28px;
    margin: 0 0 6px auto;
    place-items: center;
    border: 1px solid #d6e0ec;
    border-radius: 6px;
    background: #fff;
    color: #66758b;
  }
  .project-grid {
    grid-template-columns: 1fr;
  }
}
@media (max-width: 640px) {
  .global-head p {
    display: none;
  }
  .workflow-tabs > button:not(.icon-button) {
    padding: 0 8px;
    font-size: 9px;
  }
  .page-heading {
    padding: 16px;
  }
  .wide-search {
    margin: 0 16px 12px;
  }
  .project-grid {
    padding: 0 16px 16px;
  }
  .asset-heading-row {
    align-items: flex-start;
    flex-direction: column;
    gap: 7px;
  }
  .asset-heading-row select {
    width: 100%;
  }
  .type-toolbar {
    align-items: stretch;
    flex-direction: column;
  }
  .filter-row {
    height: auto;
    align-items: stretch;
    flex-direction: column;
  }
  .filter-row label {
    width: 100%;
    min-width: 0;
  }
  .batch-bar {
    height: auto;
    align-items: flex-start;
    flex-wrap: wrap;
  }
  .batch-bar label {
    margin-left: 0;
  }
  .card-grid {
    grid-template-columns: 1fr;
  }
  .workspace {
    height: calc(100% - 250px);
  }
}

/* Frozen V4 layout tokens from the integrated prototype. */
.global-head {
  height: 54px;
  padding: 10px 18px;
}
.global-head h2 {
  margin: 0;
  font-size: 18px;
}
.asset-workbench {
  grid-template-columns: 184px minmax(0, 1fr);
}
.asset-nav {
  padding: 12px 10px;
  background: #fff;
}
.asset-nav > strong {
  padding: 2px 7px 8px;
  color: #8a96aa;
  font-size: 11px;
  letter-spacing: 0;
}
.nav-business {
  margin-bottom: 9px;
  padding: 8px 10px;
  border: 1px solid #d5e2f8;
  border-radius: 14px;
  background: #f4f8ff;
}
.nav-business > * {
  display: block;
}
.nav-business small {
  color: #8794a9;
  font-size: 9px;
}
.nav-business strong {
  margin-top: 4px;
  color: #2766ed;
  font-size: 12px;
}
.nav-business span {
  display: none;
  margin-top: 4px;
  color: #66758c;
  font-size: 9px;
  line-height: 1.5;
}
.asset-nav > button {
  margin-bottom: 4px;
  padding: 10px 11px;
  border-radius: 12px;
  font-size: 12px;
  font-weight: 700;
}
.nav-section-label {
  margin: 7px 8px 0;
  color: #8a96aa;
  font-size: 9px;
}
.nav-current {
  margin-top: 8px;
  padding: 9px 10px;
  border-radius: 14px;
  background: #fbfcfe;
}
.nav-current strong {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
}
.nav-current span {
  margin-top: 5px;
  color: #8491a5;
  font-size: 9px;
  line-height: 1.5;
}
.asset-main {
  background: #f4f7fb;
}
.page-head {
  min-height: 50px;
  display: flex;
  padding: 8px 16px;
  align-items: center;
  gap: 8px;
  border-bottom: 1px solid #dce5f1;
  background: #fff;
}
.page-head > div {
  min-width: 0;
  flex: 1;
}
.page-head strong,
.page-head span {
  display: block;
}
.page-head strong {
  font-size: 15px;
}
.page-head span {
  display: none;
  margin-top: 3px;
  color: #7c899f;
  font-size: 10px;
}
.project-context {
  min-height: 48px;
  display: flex;
  padding: 7px 16px;
  align-items: center;
  gap: 12px;
  border-bottom: 1px solid #dce5f1;
  background: #fff;
}
.project-context .context-icon {
  display: grid;
  width: 32px;
  height: 32px;
  flex: 0 0 auto;
  place-items: center;
  border-radius: 10px;
  background: #eaf1ff;
  color: #2766ed;
}
.project-context > div {
  min-width: 0;
  flex: 1;
}
.project-context strong,
.project-context span {
  display: block;
}
.project-context strong {
  font-size: 11px;
}
.project-context > div span {
  margin-top: 1px;
  color: #7d899f;
  font-size: 10px;
}
.project-context select {
  min-width: 210px;
  height: 32px;
  padding: 0 10px;
  border: 1px solid #d5deeb;
  border-radius: 10px;
  background: #fff;
  color: #44526a;
}
.context-badge,
.current-badge {
  padding: 3px 6px;
  border-radius: 999px;
  background: #edf3ff;
  color: #2766ed;
  font-size: 8px;
  font-weight: 800;
}
.global-search {
  position: relative;
  display: flex;
  padding: 10px 18px;
  align-items: center;
  gap: 10px;
  border-bottom: 1px solid #dce5f1;
  background: #fff;
}
.global-search strong {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: #2766ed;
  font-size: 12px;
}
.global-search input {
  min-width: 0;
  height: 36px;
  flex: 1;
  padding: 0 12px;
  border: 1px solid #cfd9e8;
  border-radius: 11px;
  background: #f8faff;
  outline: none;
}
.global-search small {
  color: #8290a5;
  font-size: 9px;
}
.workflow-cards {
  display: grid;
  padding: 7px 16px;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 7px;
  border-bottom: 1px solid #dce5f1;
  background: #f8faff;
}
.workflow-cards button {
  min-height: 50px;
  display: flex;
  padding: 7px 10px;
  align-items: center;
  gap: 10px;
  border: 1px solid #dce5f1;
  border-radius: 12px;
  background: #fff;
  color: #59677c;
  text-align: left;
}
.workflow-cards button.active {
  border-color: #2766ed;
  background: #f2f6ff;
  color: #174fc7;
  box-shadow: 0 0 0 2px #dae7ff;
}
.workflow-cards i {
  display: grid;
  width: 28px;
  height: 28px;
  place-items: center;
  border-radius: 9px;
  background: #eaf1ff;
  color: #2766ed;
  font-style: normal;
}
.workflow-cards span {
  min-width: 0;
  flex: 1;
}
.workflow-cards strong,
.workflow-cards small {
  display: block;
}
.workflow-cards strong {
  font-size: 11px;
}
.workflow-cards small {
  display: none;
  margin-top: 2px;
  color: #8b97a9;
  font-size: 9px;
}
.workflow-cards b {
  font-size: 13px;
}
.space-tabs {
  height: auto;
  padding: 7px 16px;
  gap: 7px;
  background: #fff;
}
.space-tabs button {
  min-height: 28px;
  padding: 0 12px;
  border: 1px solid #dce5f1;
  border-radius: 999px;
}
.space-tabs button.active {
  border-color: #2766ed;
  background: #2766ed;
  color: #fff;
}
.breadcrumb {
  min-height: 32px;
  padding: 6px 16px;
  gap: 7px;
  background: #f8faff;
}
.breadcrumb button {
  display: inline-flex;
  padding: 0;
  align-items: center;
  gap: 4px;
  border: 0;
  background: transparent;
  color: #2766ed;
  font-size: 10px;
  font-weight: 800;
}
.breadcrumb button:last-child {
  margin-left: auto;
}
.project-library {
  min-height: 0;
  display: flex;
  flex: 1;
  flex-direction: column;
  overflow: hidden;
}
.project-search {
  min-height: 60px;
  display: flex;
  padding: 12px 18px;
  align-items: center;
  gap: 9px;
  border-bottom: 1px solid #dce5f1;
  background: #fff;
}
.project-search input {
  width: min(420px, 46vw);
  height: 36px;
  padding: 0 12px;
  border: 1px solid #d4deeb;
  border-radius: 11px;
  outline: none;
}
.project-search span {
  color: #7b889d;
  font-size: 10px;
}
.project-grid {
  min-height: 0;
  padding: 14px 18px 18px;
  overflow: auto;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
.project-card {
  min-height: 148px;
  display: flex;
  padding: 16px;
  flex-direction: column;
  align-items: stretch;
  gap: 0;
  border-radius: 16px;
}
.project-card.current {
  border-color: #2766ed;
  background: #f5f8ff;
}
.project-card header {
  display: flex;
  align-items: flex-start;
  gap: 11px;
}
.project-card header > div {
  min-width: 0;
  flex: 1;
}
.project-card h3 {
  margin: 0;
  font-size: 13px;
}
.project-card header p {
  margin: 5px 0 0;
  color: #7d899f;
  font-size: 9px;
}
.project-card > p {
  margin: 13px 0;
  color: #65738a;
  font-size: 10px;
  line-height: 1.65;
}
.project-card footer {
  display: flex;
  margin-top: auto;
  padding-top: 11px;
  align-items: center;
  gap: 7px;
  border-top: 1px solid #e8edf4;
  color: #7b899d;
  font-size: 9px;
}
.project-card footer em {
  padding: 3px 6px;
  border-radius: 999px;
  background: #eef4ff;
  color: #2766ed;
  font-style: normal;
  font-weight: 800;
}
.project-card footer b {
  display: inline-flex;
  margin-left: auto;
  align-items: center;
  gap: 3px;
  color: #2766ed;
  font-size: 11px;
}
.asset-space {
  min-height: 0;
  display: flex;
  flex: 1;
  flex-direction: column;
  overflow: hidden;
}
.asset-tools {
  display: flex;
  padding: 7px 16px;
  align-items: center;
  gap: 7px;
  border-bottom: 1px solid #dce5f1;
  background: #fff;
}
.asset-search {
  width: 260px;
  min-width: 190px;
  height: 36px;
  display: flex;
  padding: 0 9px;
  align-items: center;
  gap: 6px;
  border: 1px solid #d5deeb;
  border-radius: 9px;
  color: #7b899d;
}
.asset-search input {
  min-width: 0;
  flex: 1;
  border: 0;
  outline: 0;
  font-size: 9px;
}
.type-chips {
  min-width: 0;
  display: flex;
  flex: 1;
  padding: 2px 1px;
  gap: 5px;
  overflow-x: auto;
  flex-wrap: nowrap;
  scrollbar-width: none;
}
.type-chips button {
  height: 32px;
  flex: 0 0 auto;
  padding: 0 9px;
  border-radius: 999px;
  background: #f8faff;
  font-size: 10px;
}
.type-chips button.active {
  background: #2766ed;
  color: #fff;
  box-shadow: 0 4px 12px #2766ed2e;
}
.type-chips small {
  font-size: 9px;
}
.upload-button {
  height: 32px;
  display: inline-flex;
  flex: 0 0 auto;
  padding: 0 11px;
  align-items: center;
  gap: 5px;
  border: 1px solid #2766ed;
  border-radius: 999px;
  background: #fff;
  color: #2766ed;
  font-size: 10px;
  font-weight: 800;
}
.select-control {
  display: flex;
  align-items: center;
  gap: 4px;
  color: #647289;
  font-size: 10px;
  white-space: nowrap;
}
.asset-tools > .secondary-button {
  min-height: 32px;
  padding: 0 10px;
  white-space: nowrap;
}
.workspace {
  height: auto;
  min-height: 0;
  flex: 1;
  padding: 9px 16px 14px;
  grid-template-columns: minmax(0, 1.28fr) minmax(480px, 0.72fr);
  gap: 14px;
  background: #f3f6fb;
}
.asset-browser,
.asset-detail {
  min-height: 0;
  overflow: auto;
  border: 1px solid #dce5f1;
  border-radius: 16px;
  background: #fff;
}
.asset-detail {
  padding: 0;
}
.card-grid {
  padding: 10px;
  grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
  gap: 10px;
}
.pager {
  position: sticky;
  z-index: 5;
  bottom: 0;
  min-height: 51px;
  padding: 10px 12px;
  gap: 9px;
  background: #fffffff7;
  backdrop-filter: blur(8px);
}
.pager label {
  display: flex;
  align-items: center;
  gap: 5px;
}
.pager button {
  width: auto;
  height: 30px;
  padding: 0 10px;
}
.detail-placeholder,
.large-state {
  min-height: 100%;
}
@media (max-width: 1320px) {
  .asset-tools {
    flex-wrap: wrap;
  }
  .type-chips {
    order: 3;
    width: 100%;
  }
  .workspace {
    grid-template-columns: minmax(0, 1fr) minmax(360px, 0.82fr);
  }
}
@media (max-width: 980px) {
  .asset-workbench {
    grid-template-columns: 1fr;
  }
  .asset-nav {
    display: none;
  }
  .workflow-cards {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
  .workspace {
    grid-template-columns: 1fr;
  }
}
</style>
