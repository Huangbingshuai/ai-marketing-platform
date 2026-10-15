<script setup lang="ts">
import type {
  Asset,
  AssetVersion,
  AssetWorkflow,
  AssetWorkflowSpace,
  Project,
  WorkingArtifact,
  EffectWorkflowBranchTreeData,
} from '@ai-marketing/contracts';
import {
  AlertTriangle,
  ArrowUpRight,
  Download,
  FileText,
  GitBranch,
  LayoutGrid,
  List,
  LoaderCircle,
  RefreshCw,
  Search,
  X,
} from '@lucide/vue';
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { ApiClientError, isAbortError } from '../../../api/http-client';
import { requestActionConfirmation } from '../../../shared/composables/action-confirmation';
import {
  getActiveWorkflowRunOverview,
  getEffectWorkflowBranchTree,
  listWorkingArtifacts,
} from '../../workflow/api/workflow-working.api';
import {
  archiveAsset,
  createAssetVersion,
  importAssetSnapshot,
  listAssets,
  listAssetVersions,
  upgradeAssetSnapshot,
} from '../api/asset.api';
import { isCurrentOnlyEffectImportAsset, projectMatchesSpace, typeLabel } from '../asset-v4';
import {
  ASSET_CATEGORIES,
  SOURCE_ASSET_CATEGORIES,
  EFFECT_ASSET_NODES,
  UNKNOWN_ASSET_NODE,
  browserAssetNodeId,
  filterBrowserAssetsByNode,
  assetSourceLabel,
  assetFileFormat,
  assetSummary,
  assetTextFields,
  buildBrowserAssets,
  filterBrowserAssets,
  formatAssetSize,
  formatAssetTime,
  groupSourceAssets,
  type AssetCategory,
  type BrowserAsset,
} from '../project-asset-browser';
import AssetMediaThumbnail from './AssetMediaThumbnail.vue';
import AssetDocumentReader from './AssetDocumentReader.vue';
import AssetSourceDocumentReader from './AssetSourceDocumentReader.vue';
import { assetDocument, assetDocumentExport } from '../asset-document';
import EffectWorkflowBranchTree from '../../../workflows/effect/source-import/components/EffectWorkflowBranchTree.vue';
import type { EffectBranchNavigation } from '../../../workflows/effect/shared/effect-branch-navigation';
import {
  assetVersionCatalog,
  defaultAssetVersion,
  versionsForNode,
} from '../project-asset-versions';

const props = defineProps<{
  project: Project;
  workflow: AssetWorkflow;
  space: AssetWorkflowSpace;
  currentProject: Project | null;
}>();
const emit = defineEmits<{ resumeNode: [nodeId: string] }>();
const working = ref<WorkingArtifact[]>([]);
const assets = ref<Asset[]>([]);
const workflowRunId = ref<string | null>(null);
const loading = ref(true);
const errors = ref<string[]>([]);
const keyword = ref('');
const category = ref<AssetCategory>('ALL');
const selectedNode = ref('SEGMENT_RENDER');
const branchTree = ref<EffectWorkflowBranchTreeData | null>(null);
const templateId = ref<string | null>(null);
const browseVersionKey = ref('');
const showVersionTree = ref(false);
const scopeChoices = new Map<string, string>();
let snapshotController: AbortController | undefined;
let snapshotGeneration = 0;
const versionCatalog = computed(() => assetVersionCatalog(branchTree.value));
const browseVersions = computed(() =>
  versionsForNode(versionCatalog.value.versions, selectedNode.value, templateId.value),
);
const browseVersion = computed(
  () => browseVersions.value.find((item) => item.key === browseVersionKey.value) ?? null,
);
const scopeChoiceKey = () =>
  `${selectedNode.value}:${selectedNode.value === 'FINAL_OUTPUT' ? templateId.value : '-'}`;
const sort = ref<'media' | 'recent' | 'name'>('media');
const layout = ref<'grid' | 'list'>('grid');
const page = ref(1);
const selectedId = ref<string | null>(null);
const detailPanel = ref<HTMLElement | null>(null);
const resultPanel = ref<HTMLElement | null>(null);
const mediaFailed = ref(false);
const versions = ref<AssetVersion[]>([]);
const versionNote = ref('');
const versionsLoading = ref(false);
const versionsError = ref('');
const busy = ref(false);
const actionError = ref('');
const actionMessage = ref('');
let controller: AbortController | undefined;
let versionController: AbortController | undefined;
let generation = 0;
let trigger: HTMLElement | null = null;

const catalog = computed(() =>
  buildBrowserAssets(working.value, assets.value, {
    projectId: props.project.id,
    workflow: props.workflow,
    space: props.space,
    workflowRunId: workflowRunId.value,
    strictVersion: props.workflow === 'EFFECT',
    renderSourceHeads: props.workflow === 'EFFECT' && selectedNode.value === 'SEGMENT_RENDER',
    templateId:
      props.workflow === 'EFFECT' && selectedNode.value === 'FINAL_OUTPUT'
        ? templateId.value
        : null,
  }),
);
const tabs = computed(() =>
  props.workflow === 'EFFECT'
    ? [
        ...EFFECT_ASSET_NODES,
        ...(catalog.value.some((item) => browserAssetNodeId(item) === UNKNOWN_ASSET_NODE)
          ? [{ value: UNKNOWN_ASSET_NODE, label: '未标注来源' }]
          : []),
      ]
    : ASSET_CATEGORIES,
);
const selectedTab = computed(() =>
  props.workflow === 'EFFECT' ? selectedNode.value : category.value,
);
const nodeAssets = computed(() =>
  props.workflow === 'EFFECT'
    ? filterBrowserAssetsByNode(catalog.value, selectedNode.value)
    : catalog.value,
);
const sourceView = computed(
  () => props.workflow === 'EFFECT' && selectedNode.value === 'SOURCE_IMPORT',
);
const sourceCategory = ref<AssetCategory>('ALL');
const sourceFilters = computed(() =>
  SOURCE_ASSET_CATEGORIES.map((option) => ({
    ...option,
    count:
      option.value === 'ALL'
        ? nodeAssets.value.length
        : nodeAssets.value.filter((item) => item.category === option.value).length,
  })),
);
const filtered = computed(() =>
  filterBrowserAssets(
    nodeAssets.value,
    sourceView.value ? sourceCategory.value : props.workflow === 'EFFECT' ? 'ALL' : category.value,
    keyword.value,
    sort.value,
  ),
);
function selectTab(value: string): void {
  sourceCategory.value = 'ALL';
  if (props.workflow === 'EFFECT') selectedNode.value = value;
  else category.value = value as AssetCategory;
  selectedId.value = null;
  if (props.workflow === 'EFFECT') chooseScope();
}
const pageCount = computed(() => Math.max(1, Math.ceil(filtered.value.length / 30)));
const displayed = computed(() => filtered.value.slice((page.value - 1) * 30, page.value * 30));
const displayGroups = computed(() =>
  sourceView.value
    ? groupSourceAssets(displayed.value)
    : [{ value: 'ALL', label: '', items: displayed.value }],
);
function selectSourceCategory(value: AssetCategory): void {
  sourceCategory.value = value;
  selectedId.value = null;
}
const documentView = computed(
  () => filtered.value.length > 0 && filtered.value.every((item) => assetDocument(item) !== null),
);
const exportError = ref('');
function exportDocument(item: BrowserAsset): void {
  exportError.value = '';
  const exported = assetDocumentExport(
    item,
    browseVersion.value?.label ?? '版本未记录',
    props.project.name,
  );
  if (!exported) return;
  let url: string | undefined;
  try {
    url = URL.createObjectURL(new Blob([exported.content], { type: 'text/plain;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = exported.fileName;
    anchor.click();
  } catch {
    exportError.value = '文档导出失败，请重试。';
  } finally {
    if (url) {
      const downloadUrl = url;
      requestAnimationFrame(() => URL.revokeObjectURL(downloadUrl));
    }
  }
}
const selected = computed(() => catalog.value.find((item) => item.id === selectedId.value) ?? null);
const projectAsset = computed(() =>
  selected.value?.source.kind === 'project' ? selected.value.source.asset : null,
);
const canResume = computed(
  () =>
    props.currentProject?.id === props.project.id &&
    props.workflow === 'EFFECT' &&
    browseVersion.value?.workflowRunId === branchTree.value?.activeWorkflowRunId &&
    selectedNode.value !== 'FINAL_OUTPUT',
);
const canImport = computed(() =>
  Boolean(
    projectAsset.value &&
    props.currentProject &&
    projectAsset.value.projectId !== props.currentProject.id &&
    projectMatchesSpace(props.currentProject, props.space),
  ),
);
const resumeId = computed(() => {
  if (!selected.value || selected.value.source.kind !== 'working' || !canResume.value) return null;
  const id = selected.value.nodeId?.split(':')[0];
  return id &&
    [
      'SOURCE_IMPORT',
      'INFORMATION_EXTRACTION',
      'PROMPT_GENERATION',
      'SEGMENT_RENDER',
      'TEMPLATE_MIX',
      'FINAL_OUTPUT',
    ].includes(id)
    ? id
    : null;
});
const counts = computed(() =>
  Object.fromEntries(
    tabs.value.map((option) => [
      option.value,
      props.workflow === 'EFFECT'
        ? filterBrowserAssetsByNode(catalog.value, option.value).length
        : option.value === 'ALL'
          ? catalog.value.length
          : catalog.value.filter((item) => item.category === option.value).length,
    ]),
  ),
);
const textFields = computed(() =>
  selected.value && !sourceView.value ? assetTextFields(selected.value) : [],
);
const displayTags = computed(() =>
  sourceView.value
    ? []
    : (selected.value?.tags.filter((tag) => !['EFFECT', 'CUSTOMIZED', 'FISSION'].includes(tag)) ??
      []),
);

async function load(): Promise<void> {
  controller?.abort();
  snapshotController?.abort();
  snapshotGeneration++;
  versionController?.abort();
  const request = new AbortController();
  controller = request;
  const stamp = ++generation;
  const scope = { projectId: props.project.id, workflow: props.workflow, space: props.space };
  const isCurrent = () => !request.signal.aborted && stamp === generation;
  loading.value = true;
  errors.value = [];
  working.value = [];
  assets.value = [];
  workflowRunId.value = null;
  selectedId.value = null;
  page.value = 1;
  const readWorking = async () => {
    if (scope.workflow === 'EFFECT') {
      const result = await getEffectWorkflowBranchTree(scope.projectId, request.signal);
      if (isCurrent()) branchTree.value = result.data;
      return;
    }
    const overview = await getActiveWorkflowRunOverview(
      scope.projectId,
      scope.workflow,
      scope.space,
      request.signal,
    );
    const runId = overview.data.run?.id ?? null;
    const result = runId
      ? await listWorkingArtifacts(
          scope.projectId,
          { workflow: scope.workflow, space: scope.space, workflowRunId: runId },
          request.signal,
        )
      : null;
    if (isCurrent()) {
      workflowRunId.value = runId;
      working.value = result?.data.items ?? [];
    }
  };
  const readAssets = async () => {
    const result: Asset[] = [];
    let next = 1;
    let last: number;
    do {
      const response = await listAssets(
        scope.projectId,
        { workflow: scope.workflow, space: scope.space, page: next, pageSize: 96 },
        request.signal,
      );
      result.push(...response.data.items);
      last = response.data.pagination?.pageCount ?? Math.ceil(response.data.total / 96);
      next += 1;
    } while (next <= last && isCurrent());
    if (isCurrent()) assets.value = result;
  };
  const results = await Promise.allSettled([readWorking(), readAssets()]);
  if (!isCurrent()) return;
  results.forEach((result, index) => {
    if (result.status === 'rejected' && !isAbortError(result.reason))
      errors.value.push(
        index === 0
          ? scope.workflow === 'EFFECT'
            ? '版本目录加载失败，请重试。'
            : '工作副本加载失败，当前内容可能不完整。'
          : '项目资产加载失败，当前内容可能不完整。',
      );
  });
  loading.value = false;
  if (scope.workflow === 'EFFECT') {
    if (!versionCatalog.value.templates.some((item) => item.id === templateId.value))
      templateId.value =
        versionCatalog.value.versions.find(
          (item) => item.nodeId === 'FINAL_OUTPUT' && item.onActivePath,
        )?.templateId ??
        versionCatalog.value.templates[0]?.id ??
        null;
    chooseScope();
  }
}
function chooseScope(): void {
  const remembered = scopeChoices.get(scopeChoiceKey());
  browseVersionKey.value =
    browseVersions.value.find((item) => item.key === remembered)?.key ??
    defaultAssetVersion(browseVersions.value)?.key ??
    '';
  void loadSnapshot();
}
function changeBrowseVersion(): void {
  scopeChoices.set(scopeChoiceKey(), browseVersionKey.value);
  void loadSnapshot();
}
async function loadSnapshot(): Promise<void> {
  snapshotController?.abort();
  const request = new AbortController();
  snapshotController = request;
  const stamp = ++snapshotGeneration;
  const version = browseVersion.value;
  const projectId = props.project.id;
  working.value = [];
  workflowRunId.value = version?.workflowRunId ?? null;
  selectedId.value = null;
  page.value = 1;
  errors.value = errors.value.filter((message) => !message.startsWith('版本资产'));
  loading.value = !!version;
  if (!version) return;
  try {
    const response = await listWorkingArtifacts(
      projectId,
      {
        workflowRunId: version.workflowRunId,
        workflow: 'EFFECT',
        space: 'EFFECT',
        ...(version.nodeId === 'SEGMENT_RENDER'
          ? { nodeId: 'SEGMENT_RENDER' }
          : { view: 'SNAPSHOT' as const }),
      },
      request.signal,
    );
    if (!request.signal.aborted && stamp === snapshotGeneration && props.project.id === projectId)
      working.value = response.data.items;
  } catch (error) {
    if (!request.signal.aborted && stamp === snapshotGeneration && !isAbortError(error))
      errors.value.push(
        `版本资产加载失败${error instanceof ApiClientError ? `（HTTP ${error.status}）` : ''}，请重新加载；不会替换为其他版本。`,
      );
  } finally {
    if (!request.signal.aborted && stamp === snapshotGeneration) loading.value = false;
  }
}
function selectTreeVersion(destination: Omit<EffectBranchNavigation, 'projectId'>): void {
  const version = versionCatalog.value.versions.find(
    (item) =>
      item.workflowRunId === destination.workflowRunId &&
      item.nodeId === destination.nodeId &&
      item.templateId === destination.templateId,
  );
  if (!version) return;
  selectedNode.value = version.nodeId;
  if (version.templateId) templateId.value = version.templateId;
  browseVersionKey.value = version.key;
  showVersionTree.value = false;
  changeBrowseVersion();
}
function selectItem(item: BrowserAsset): void {
  trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  selectedId.value = item.id;
  void nextTick(() => detailPanel.value?.focus());
}
function closeDetail(): void {
  if (busy.value) return;
  selectedId.value = null;
  void nextTick(() => trigger?.isConnected && trigger.focus());
}
async function loadVersions(): Promise<void> {
  versionController?.abort();
  versions.value = [];
  versionsError.value = '';
  const asset = projectAsset.value;
  if (!asset || isCurrentOnlyEffectImportAsset(asset)) {
    versionsLoading.value = false;
    return;
  }
  const request = new AbortController();
  versionController = request;
  versionsLoading.value = true;
  try {
    const response = await listAssetVersions(asset.projectId, asset.id, request.signal);
    if (!request.signal.aborted && projectAsset.value?.id === asset.id)
      versions.value = response.data.slice(0, 5);
  } catch (error) {
    if (!request.signal.aborted && !isAbortError(error)) versionsError.value = '版本记录加载失败';
  } finally {
    if (!request.signal.aborted) versionsLoading.value = false;
  }
}
async function assetAction(action: 'import' | 'version' | 'upgrade' | 'remove'): Promise<void> {
  const asset = projectAsset.value;
  if (!asset || busy.value) return;
  if (
    action === 'remove' &&
    !(await requestActionConfirmation({
      eyebrow: '移除项目资产',
      title: '移除这项资产？',
      description: '只移除本项目中的资产记录，其他项目中的资产不会受到影响。',
      confirmLabel: '确认移除',
      tone: 'danger',
    }))
  )
    return;
  busy.value = true;
  actionError.value = '';
  actionMessage.value = '';
  try {
    if (action === 'import' && props.currentProject && canImport.value) {
      await importAssetSnapshot(props.currentProject.id, {
        sourceProjectId: asset.projectId,
        sourceAssetId: asset.id,
        sourceVersion: asset.currentVersion ?? 1,
        targetWorkflow: props.workflow,
        targetSpace: props.space,
      });
      actionMessage.value = `已引用到“${props.currentProject.name}”`;
    } else if (action === 'remove') {
      await archiveAsset(asset.projectId, asset.id);
      await load();
    } else if (action === 'version' || action === 'upgrade') {
      const response =
        action === 'version'
          ? await createAssetVersion(asset.projectId, asset.id, {
              changeNote: versionNote.value.trim(),
            })
          : await upgradeAssetSnapshot(asset.projectId, asset.id);
      assets.value = assets.value.map((item) => (item.id === asset.id ? response.data : item));
      versionNote.value = '';
      await loadVersions();
      actionMessage.value = '资产版本已更新';
    }
  } catch {
    actionError.value = '操作失败，请稍后重试。';
  } finally {
    busy.value = false;
  }
}
function resetResultsScroll(): void {
  void nextTick(() => {
    if (resultPanel.value) resultPanel.value.scrollTop = 0;
  });
}
watch([keyword, category, sourceCategory, selectedNode, sort], () => {
  page.value = 1;
  resetResultsScroll();
});
watch(page, resetResultsScroll);
watch(selectedId, () => {
  mediaFailed.value = false;
  actionError.value = '';
  actionMessage.value = '';
  versionNote.value = '';
  void loadVersions();
});
watch(
  () => [props.project.id, props.workflow, props.space],
  () => {
    keyword.value = '';
    category.value = 'ALL';
    sourceCategory.value = 'ALL';
    selectedNode.value = 'SEGMENT_RENDER';
    branchTree.value = null;
    templateId.value = null;
    browseVersionKey.value = '';
    scopeChoices.clear();
    showVersionTree.value = false;
    page.value = 1;
    void load();
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  controller?.abort();
  snapshotController?.abort();
  snapshotGeneration++;
  versionController?.abort();
  generation += 1;
});
</script>

<template>
  <section class="project-assets" :aria-busy="loading">
    <div class="browser-toolbar">
      <label class="asset-search"
        ><Search :size="16" /><input
          v-model="keyword"
          aria-label="搜索项目资产"
          placeholder="搜索素材名称或标签" /><button
          v-if="keyword"
          type="button"
          aria-label="清空资产搜索"
          @click="keyword = ''"
        >
          <X :size="14" /></button
      ></label>
      <div class="browser-actions">
        <select v-model="sort" aria-label="资产排序">
          <option value="media">素材优先</option>
          <option value="recent">最近更新</option>
          <option value="name">名称排序</option>
        </select>
        <div v-if="!documentView" class="view-switch" role="group" aria-label="浏览方式">
          <button
            type="button"
            :aria-pressed="layout === 'grid'"
            aria-label="网格视图"
            @click="layout = 'grid'"
          >
            <LayoutGrid :size="16" /></button
          ><button
            type="button"
            :aria-pressed="layout === 'list'"
            aria-label="列表视图"
            @click="layout = 'list'"
          >
            <List :size="16" />
          </button>
        </div>
        <button type="button" aria-label="刷新资产" :disabled="loading || busy" @click="load">
          <RefreshCw :size="16" />
        </button>
      </div>
    </div>
    <div
      class="category-tabs"
      role="tablist"
      :aria-label="workflow === 'EFFECT' ? '来源节点' : '资产分类'"
    >
      <button
        v-for="option in tabs"
        :key="option.value"
        type="button"
        role="tab"
        :aria-selected="selectedTab === option.value"
        @click="selectTab(option.value)"
      >
        {{ option.label
        }}<span v-if="workflow !== 'EFFECT' || selectedTab === option.value">{{
          loading ? '—' : counts[option.value]
        }}</span>
      </button>
    </div>
    <div v-if="workflow === 'EFFECT'" class="asset-scope-toolbar">
      <div class="asset-scope-controls">
        <label v-if="selectedNode === 'FINAL_OUTPUT'">
          <span>混剪模板</span>
          <select v-model="templateId" aria-label="筛选成片模板" @change="chooseScope">
            <option v-if="!versionCatalog.templates.length" :value="null">暂无模板</option>
            <option
              v-for="template in versionCatalog.templates"
              :key="template.id"
              :value="template.id"
            >
              {{ template.name }}
            </option>
          </select>
        </label>
        <label>
          <span>版本</span>
          <select
            v-model="browseVersionKey"
            aria-label="筛选资产版本"
            @change="changeBrowseVersion"
          >
            <option v-if="!browseVersions.length" value="">暂无已确认版本</option>
            <option v-for="version in browseVersions" :key="version.key" :value="version.key">
              {{ version.label }}
            </option>
          </select>
        </label>
        <button type="button" class="version-tree-button" @click="showVersionTree = true">
          <GitBranch :size="15" />版本树
        </button>
      </div>
    </div>
    <div v-if="errors.length" class="load-alert" role="alert">
      <AlertTriangle :size="16" /><span>{{ errors.join(' ') }}</span
      ><button type="button" @click="load">重新加载</button>
    </div>
    <p v-if="exportError" class="load-alert" role="alert">{{ exportError }}</p>
    <div v-if="sourceView" class="source-filters" role="group" aria-label="资料文件分类">
      <button
        v-for="option in sourceFilters"
        :key="option.value"
        type="button"
        :aria-pressed="sourceCategory === option.value"
        @click="selectSourceCategory(option.value)"
      >
        {{ option.label }}<span>{{ loading ? '—' : option.count }}</span>
      </button>
    </div>
    <div class="browser-content" :class="{ 'has-detail': selected }">
      <div ref="resultPanel" class="asset-results">
        <div v-if="loading" class="browser-state">
          <LoaderCircle class="spinner" :size="24" />
          <p>正在加载资产…</p>
        </div>
        <div v-else-if="!filtered.length" class="browser-state">
          <FileText :size="32" />
          <h3>
            {{
              errors.length
                ? '资产暂时无法完整显示'
                : keyword ||
                    (sourceView && sourceCategory !== 'ALL') ||
                    (workflow !== 'EFFECT' && category !== 'ALL')
                  ? '没有匹配的资产'
                  : workflow === 'EFFECT'
                    ? selectedNode === 'FINAL_OUTPUT'
                      ? '此模板暂无已确认成片'
                      : '此节点暂无资产'
                    : '暂无资产'
            }}
          </h3>
          <p>
            {{
              keyword ||
              (sourceView && sourceCategory !== 'ALL') ||
              (workflow !== 'EFFECT' && category !== 'ALL')
                ? '调整分类或搜索关键词试试。'
                : workflow === 'EFFECT'
                  ? selectedNode === 'FINAL_OUTPUT'
                    ? '所选模板已完成输出的成片，会按版本展示在这里。'
                    : '此节点确认的素材与产物会显示在这里。'
                  : '项目中上传或确认的素材会显示在这里。'
            }}
          </p>
          <button
            v-if="
              keyword ||
              (sourceView && sourceCategory !== 'ALL') ||
              (workflow !== 'EFFECT' && category !== 'ALL')
            "
            type="button"
            @click="
              keyword = '';
              category = 'ALL';
              sourceCategory = 'ALL';
            "
          >
            清除筛选
          </button>
        </div>
        <div v-else-if="documentView" class="asset-documents">
          <AssetDocumentReader
            v-for="item in displayed"
            :key="item.id"
            :item="item"
            @export="exportDocument"
          />
        </div>
        <div v-else class="asset-groups">
          <section
            v-for="group in displayGroups"
            :key="group.value"
            :aria-label="group.label || '资产列表'"
          >
            <h3 v-if="sourceView" class="source-group-title">
              {{ group.label
              }}<span>{{ filtered.filter((item) => item.category === group.value).length }}</span>
            </h3>
            <div
              v-if="sourceView && group.value === 'DOCUMENT'"
              class="asset-documents source-documents"
            >
              <AssetSourceDocumentReader v-for="item in group.items" :key="item.id" :item="item" />
            </div>
            <div
              v-else
              class="asset-items"
              :class="[layout, { 'source-images': sourceView && group.value === 'IMAGE' }]"
            >
              <button
                v-for="item in group.items"
                :key="item.id"
                type="button"
                class="asset-tile"
                :class="{ selected: selectedId === item.id }"
                :aria-pressed="selectedId === item.id"
                @click="selectItem(item)"
              >
                <span class="tile-preview"
                  ><AssetMediaThumbnail
                    :item="item"
                    :intrinsic-image="
                      sourceView && item.category === 'IMAGE' && layout === 'grid'
                    " /></span
                ><span class="tile-copy"
                  ><strong :title="item.name">{{ item.name }}</strong
                  ><span>{{ typeLabel(item.type) }} · {{ assetSourceLabel(item) }}</span></span
                ><span class="tile-meta"
                  ><span :class="{ warning: item.status !== '可用' }">{{ item.status }}</span
                  ><small>{{ formatAssetTime(item.updatedAt) }}</small></span
                >
              </button>
            </div>
          </section>
        </div>
        <footer v-if="!loading && filtered.length" class="result-footer">
          <span>{{ filtered.length }} 项资产</span>
          <div>
            <button type="button" :disabled="page <= 1" @click="page--">上一页</button
            ><span>{{ page }} / {{ pageCount }}</span
            ><button type="button" :disabled="page >= pageCount" @click="page++">下一页</button>
          </div>
        </footer>
      </div>
      <aside
        v-if="selected"
        ref="detailPanel"
        class="asset-detail"
        tabindex="-1"
        aria-label="资产详情"
        @keydown.esc.stop="closeDetail"
      >
        <header>
          <span>资产详情</span
          ><button type="button" aria-label="关闭资产详情" :disabled="busy" @click="closeDetail">
            <X :size="17" />
          </button>
        </header>
        <div
          v-if="['VIDEO', 'IMAGE', 'AUDIO'].includes(selected.previewKind)"
          class="detail-preview"
        >
          <p v-if="selected.unavailable">{{ selected.status }}，预览暂不可用。</p>
          <p v-else-if="mediaFailed">预览加载失败，请刷新后重试。</p>
          <video
            v-else-if="selected.previewKind === 'VIDEO' && selected.contentUrl"
            :key="selected.id"
            :src="selected.contentUrl"
            :poster="selected.previewUrl ?? undefined"
            controls
            playsinline
            preload="metadata"
            @error="mediaFailed = true"
          />
          <img
            v-else-if="selected.previewKind === 'IMAGE' && selected.contentUrl"
            :src="selected.contentUrl"
            :alt="selected.name"
            @error="mediaFailed = true"
          />
          <audio
            v-else-if="selected.previewKind === 'AUDIO' && selected.contentUrl"
            :key="selected.id"
            :src="selected.contentUrl"
            controls
            preload="metadata"
            @error="mediaFailed = true"
          />
          <FileText v-else :size="40" />
        </div>
        <div class="detail-copy">
          <span v-if="sourceView && selected.category === 'DOCUMENT'" class="detail-file-format"
            ><FileText :size="18" />{{ assetFileFormat(selected) }} 文档</span
          >
          <h2>{{ selected.name }}</h2>
          <p v-if="assetSummary(selected) && assetSummary(selected) !== selected.name">
            {{ assetSummary(selected) }}
          </p>
          <p v-if="sourceView && selected.category === 'DOCUMENT'">
            {{
              selected.unavailable
                ? `${selected.status}，文件暂不可用。`
                : '下载原文件查看完整资料。'
            }}
          </p>
          <dl>
            <div v-if="sourceView">
              <dt>格式</dt>
              <dd>{{ assetFileFormat(selected) }}</dd>
            </div>
            <div>
              <dt>类型</dt>
              <dd>{{ typeLabel(selected.type) }}</dd>
            </div>
            <div>
              <dt>来源</dt>
              <dd>{{ assetSourceLabel(selected) }}</dd>
            </div>
            <div>
              <dt>状态</dt>
              <dd>{{ selected.status }}</dd>
            </div>
            <div>
              <dt>更新</dt>
              <dd>{{ formatAssetTime(selected.updatedAt) }}</dd>
            </div>
            <div>
              <dt>大小</dt>
              <dd>{{ formatAssetSize(selected.sizeBytes) }}</dd>
            </div>
            <div v-if="selected.durationSeconds">
              <dt>时长</dt>
              <dd>{{ Math.round(selected.durationSeconds) }} 秒</dd>
            </div>
            <div v-for="field in textFields" :key="field.label">
              <dt>{{ field.label }}</dt>
              <dd>{{ field.value }}</dd>
            </div>
          </dl>
          <div v-if="displayTags.length" class="detail-tags">
            <span v-for="tag in displayTags" :key="tag">{{ tag }}</span>
          </div>
          <div class="detail-actions">
            <a
              v-if="selected.downloadUrl && !selected.unavailable"
              :href="selected.downloadUrl"
              target="_blank"
              rel="noreferrer"
              ><Download :size="15" />下载文件</a
            ><button v-if="resumeId" type="button" @click="emit('resumeNode', resumeId)">
              <ArrowUpRight :size="15" />返回节点查看</button
            ><button
              v-if="canImport"
              type="button"
              :disabled="busy || selected.unavailable"
              @click="assetAction('import')"
            >
              引用到当前项目</button
            ><button
              v-if="projectAsset?.outdated"
              type="button"
              :disabled="busy"
              @click="assetAction('upgrade')"
            >
              更新来源版本
            </button>
          </div>
          <details
            v-if="projectAsset && !isCurrentOnlyEffectImportAsset(projectAsset)"
            class="version-records"
          >
            <summary>版本记录</summary>
            <p v-if="versionsLoading">正在加载…</p>
            <p v-else-if="versionsError">{{ versionsError }}</p>
            <p v-for="version in versions" :key="version.id">
              v{{ version.version }} · {{ version.changeNote
              }}<small>{{ formatAssetTime(version.createdAt) }}</small>
            </p>
            <label
              >版本说明<textarea
                v-model="versionNote"
                rows="2"
                placeholder="填写本次版本说明"
              /></label
            ><button
              type="button"
              :disabled="busy || !versionNote.trim()"
              @click="assetAction('version')"
            >
              创建版本
            </button>
          </details>
          <button
            v-if="projectAsset && !isCurrentOnlyEffectImportAsset(projectAsset)"
            class="remove-asset"
            type="button"
            :disabled="busy"
            @click="assetAction('remove')"
          >
            移除项目资产
          </button>
          <p v-if="actionError" class="action-error" role="alert">{{ actionError }}</p>
          <p v-if="actionMessage" role="status">{{ actionMessage }}</p>
        </div>
      </aside>
    </div>
  </section>
  <EffectWorkflowBranchTree
    v-if="showVersionTree"
    :project-name="project.name"
    :tree="branchTree"
    :loading="loading"
    :error="errors.find((message) => message.startsWith('版本目录')) ?? ''"
    :switching="false"
    :fork-disabled="true"
    :active-template-id="selectedNode === 'FINAL_OUTPUT' ? templateId : null"
    :viewed-workflow-run-id="workflowRunId"
    asset-browse
    :selectable-node-keys="versionCatalog.versions.map((item) => item.key)"
    :browsed-node-key="browseVersionKey"
    @close="showVersionTree = false"
    @retry="load"
    @select="selectTreeVersion"
  />
</template>

<style scoped>
.project-assets {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: #fff;
}
button,
select,
input,
textarea {
  font: inherit;
}
button {
  cursor: pointer;
  color: inherit;
}
button:disabled {
  opacity: 0.48;
  cursor: not-allowed;
}
button:focus-visible,
a:focus-visible,
input:focus-visible,
select:focus-visible {
  outline: 2px solid #2563eb;
  outline-offset: 3px;
}
.browser-toolbar {
  display: flex;
  gap: 16px;
  align-items: center;
  justify-content: space-between;
  padding: 20px 28px 12px;
}
.asset-search {
  display: flex;
  align-items: center;
  gap: 9px;
  width: min(400px, 50%);
  height: 36px;
  border: 1px solid #dce5f2;
  border-radius: 6px;
  padding: 0 10px;
  color: #72809a;
}
.asset-search input {
  flex: 1;
  min-width: 0;
  border: 0;
  outline: 0;
  background: transparent;
  color: #17263f;
  font-size: 13px;
}
.asset-search button,
.browser-actions > button,
.view-switch button,
.asset-detail header button {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border: 0;
  background: transparent;
  border-radius: 4px;
}
.browser-actions {
  display: flex;
  align-items: center;
  gap: 14px;
}
.browser-actions select {
  border: 0;
  background: #fff;
  color: #526582;
  font-size: 12px;
}
.view-switch {
  display: flex;
  padding: 2px;
  background: #eaf1ff;
  border-radius: 5px;
}
.view-switch button[aria-pressed='true'] {
  background: #fff;
  box-shadow: 0 1px 3px #0001;
  color: #2563eb;
}
.category-tabs {
  display: flex;
  gap: 24px;
  padding: 0 28px;
  border-bottom: 1px solid #e4eaf4;
  overflow-x: auto;
  flex-shrink: 0;
}
.category-tabs button {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 13px 0;
  border: 0;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: #526582;
  font-size: 13px;
  white-space: nowrap;
}
.category-tabs button[aria-selected='true'] {
  border-bottom-color: #2563eb;
  color: #2563eb;
  font-weight: 600;
}
.category-tabs span {
  font-size: 11px;
  color: #72809a;
}
.load-alert {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 28px;
  background: #fff9ee;
  color: #956d31;
  font-size: 12px;
}
.asset-scope-toolbar {
  flex-shrink: 0;
  padding: 14px 28px 12px;
  border-bottom: 1px solid #e4eaf4;
  background: #f8faff;
}
.asset-scope-controls {
  display: flex;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
}
.asset-scope-controls label {
  display: flex;
  align-items: center;
  gap: 9px;
  min-width: 0;
  font-size: 12px;
  color: #526582;
}
.asset-scope-controls select {
  width: 260px;
  max-width: 100%;
  min-width: 0;
  height: 34px;
  padding: 0 28px 0 10px;
  border: 1px solid #dce5f2;
  border-radius: 6px;
  background: #fff;
  color: #17263f;
  font-size: 12px;
  text-overflow: ellipsis;
}
.asset-scope-controls label:first-child:not(:last-of-type) select {
  width: 180px;
}
.version-tree-button {
  display: flex;
  align-items: center;
  gap: 7px;
  height: 34px;
  padding: 0 11px;
  border: 1px solid #dce5f2;
  border-radius: 6px;
  background: #fff;
  font-size: 12px;
}
@media (max-width: 700px) {
  .asset-scope-toolbar {
    padding: 12px 18px;
  }
  .asset-scope-controls {
    gap: 10px;
  }
  .asset-scope-controls label {
    flex: 1 1 220px;
  }
  .asset-scope-controls select {
    flex: 1;
    width: auto;
  }
}
.load-alert span {
  flex: 1;
}
.load-alert button {
  border: 0;
  background: transparent;
  color: inherit;
  text-decoration: underline;
}
.browser-content {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  position: relative;
}
.browser-content.has-detail {
  grid-template-columns: minmax(0, 1fr) 350px;
}
.asset-results {
  min-width: 0;
  min-height: 0;
  overflow: auto;
  display: flex;
  flex-direction: column;
}
.asset-items {
  padding: 24px 28px;
}
.source-filters {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 10px 28px;
  border-bottom: 1px solid #edf1f7;
}
.source-filters button {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  font-size: 12px;
  color: #526582;
}
.source-filters button[aria-pressed='true'] {
  background: #eaf1ff;
  border-color: #d0def9;
  color: #2563eb;
}
.source-filters span,
.source-group-title span {
  font-size: 11px;
  color: #72809a;
}
.source-group-title {
  display: flex;
  align-items: center;
  gap: 9px;
  margin: 22px 28px 0;
  font-size: 13px;
  font-weight: 600;
  color: #17263f;
}
.source-group-title + .asset-items,
.source-group-title + .asset-documents {
  padding-top: 12px;
}
.detail-file-format {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-bottom: 14px;
  color: #5379b7;
  font-size: 12px;
  font-weight: 600;
}
.asset-documents {
  display: flex;
  flex-direction: column;
  gap: 20px;
  padding: 24px 28px;
}
.asset-items.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(195px, 1fr));
  gap: 24px 20px;
  align-content: start;
}
.asset-items.source-images.grid {
  grid-template-columns: repeat(auto-fill, minmax(140px, 180px));
  align-items: start;
}
.source-images.grid .tile-preview {
  height: auto;
}
.asset-tile {
  min-width: 0;
  padding: 0;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 6px;
  text-align: left;
}
.asset-tile.selected {
  border-color: #2563eb;
  background: #eaf1ff;
}
.asset-tile:hover:not(.selected) {
  background: #f3f7ff;
}
.tile-preview {
  display: block;
  height: 150px;
  border-radius: 5px;
  overflow: hidden;
}
.tile-copy {
  display: flex;
  flex-direction: column;
  padding: 10px 5px 0;
  gap: 5px;
}
.tile-copy strong {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 13px;
  font-weight: 500;
  color: #17263f;
}
.tile-copy > span {
  font-size: 11px;
  color: #526582;
}
.tile-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  padding: 8px 5px 5px;
  font-size: 11px;
  color: #526582;
}
.tile-meta small {
  font-size: 11px;
}
.tile-meta .warning {
  color: #aa7938;
}
.asset-items.list {
  display: flex;
  flex-direction: column;
  gap: 0;
}
.list .asset-tile {
  display: grid;
  grid-template-columns: 68px minmax(0, 1fr) 160px;
  gap: 16px;
  align-items: center;
  padding: 10px;
  border-bottom: 1px solid #edf1f7;
  border-radius: 0;
}
.list .tile-preview {
  height: 48px;
}
.list .tile-copy {
  padding: 0;
}
.list .tile-meta {
  padding: 0;
}
.browser-state {
  display: flex;
  flex: 1;
  min-height: 280px;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  color: #72809a;
  gap: 7px;
  text-align: center;
  padding: 30px;
}
.browser-state h3 {
  font-size: 15px;
  font-weight: 500;
  color: #526582;
  margin: 8px 0 0;
}
.browser-state p {
  margin: 4px 0;
  font-size: 13px;
}
.browser-state button {
  border: 1px solid #dce5f2;
  padding: 7px 12px;
  border-radius: 5px;
  background: #fff;
  font-size: 12px;
}
.result-footer {
  margin-top: auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 28px;
  color: #72809a;
  font-size: 12px;
  border-top: 1px solid #edf1f7;
}
.result-footer > div {
  display: flex;
  align-items: center;
  gap: 12px;
}
.result-footer button {
  border: 1px solid #dce5f2;
  padding: 5px 10px;
  background: #fff;
  border-radius: 4px;
  font-size: 12px;
}
.asset-detail {
  min-height: 0;
  overflow: auto;
  border-left: 1px solid #dce5f2;
  background: #f8faff;
  outline: 0;
}
.asset-detail > header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 18px;
  font-size: 12px;
  color: #526582;
}
.detail-preview {
  display: flex;
  min-height: 200px;
  max-height: 320px;
  align-items: center;
  justify-content: center;
  background: #eaf1ff;
  margin: 0 18px;
  overflow: hidden;
  border-radius: 4px;
  color: #72809a;
}
.detail-preview img,
.detail-preview video {
  width: 100%;
  max-height: 320px;
  object-fit: contain;
}
.detail-preview audio {
  width: 95%;
}
.detail-preview p {
  font-size: 12px;
  padding: 16px;
}
.detail-copy {
  padding: 18px;
}
.detail-copy h2 {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  overflow-wrap: anywhere;
}
.detail-copy > p {
  font-size: 12px;
  color: #72809a;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
dl {
  padding: 10px 0;
  border-top: 1px solid #e4eaf4;
  margin: 18px 0 8px;
}
dl > div {
  display: grid;
  grid-template-columns: 60px minmax(0, 1fr);
  gap: 10px;
  padding: 6px 0;
  font-size: 12px;
}
dt {
  color: #72809a;
}
dd {
  margin: 0;
  color: #526582;
  overflow-wrap: anywhere;
}
.detail-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}
.detail-tags span {
  padding: 3px 6px;
  background: #eaf1ff;
  color: #526582;
  font-size: 11px;
  border-radius: 3px;
}
.detail-actions {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 20px;
}
.detail-actions a,
.detail-actions button,
.version-records button {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  padding: 9px;
  background: #fff;
  border: 1px solid #dce5f2;
  border-radius: 5px;
  color: #2563eb;
  font-size: 12px;
  text-decoration: none;
}
.version-records {
  font-size: 12px;
  color: #526582;
  margin-top: 20px;
  padding-top: 15px;
  border-top: 1px solid #e4eaf4;
}
.version-records summary {
  cursor: pointer;
}
.version-records p small {
  display: block;
  color: #72809a;
  margin-top: 4px;
}
.version-records textarea {
  display: block;
  width: 100%;
  box-sizing: border-box;
  border: 1px solid #dce5f2;
  border-radius: 5px;
  padding: 8px;
  margin: 8px 0;
  resize: vertical;
}
.remove-asset {
  border: 0;
  background: transparent;
  padding: 0;
  margin-top: 25px;
  color: #a6605e;
  font-size: 12px;
}
.action-error {
  color: #a6605e !important;
}
.category-tabs button:hover,
.category-tabs button[aria-selected='true'] span {
  color: #2563eb;
}
.asset-search:focus-within {
  border-color: #2563eb;
  box-shadow: 0 0 0 3px #2563eb14;
}
.browser-actions > button:hover,
.asset-detail header button:hover {
  background: #eaf1ff;
  color: #2563eb;
}
.version-tree-button,
.browser-state button,
.result-footer button {
  color: #2563eb;
}
.version-tree-button:hover,
.browser-state button:hover,
.result-footer button:hover:not(:disabled),
.detail-actions a:hover,
.detail-actions button:hover:not(:disabled),
.version-records button:hover:not(:disabled) {
  border-color: #b8cefa;
  background: #eaf1ff;
}
.spinner {
  animation: spin 1s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
@media (max-width: 1000px) {
  .browser-content.has-detail {
    grid-template-columns: 1fr;
  }
  .asset-detail {
    position: absolute;
    right: 0;
    top: 0;
    bottom: 0;
    width: min(350px, 100%);
    box-shadow: -10px 0 25px #0001;
    z-index: 2;
  }
}
@media (max-width: 650px) {
  .browser-toolbar {
    padding: 16px;
    gap: 8px;
    flex-wrap: wrap;
  }
  .asset-search {
    width: 100%;
  }
  .browser-actions {
    margin-left: auto;
  }
  .category-tabs {
    padding: 0 16px;
    gap: 20px;
  }
  .asset-items {
    padding: 18px 16px;
  }
  .asset-documents {
    padding: 18px 16px;
  }
  .asset-items.grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 16px 12px;
  }
  .tile-preview {
    height: 115px;
  }
  .tile-copy strong {
    font-size: 12px;
  }
  .tile-meta small {
    display: none;
  }
  .list .asset-tile {
    grid-template-columns: 60px minmax(0, 1fr);
    gap: 12px;
  }
  .list .tile-meta {
    display: none;
  }
  .result-footer {
    padding: 12px 16px;
  }
  .load-alert {
    padding: 12px 16px;
  }
}
</style>
