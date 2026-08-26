<script setup lang="ts">
import type {
  Asset,
  AssetVersion,
  AssetWorkflow,
  AssetWorkflowSpace,
  Project,
  WorkingArtifact,
  WorkflowNodeState,
  WorkflowRun,
} from '@ai-marketing/contracts';
import {
  AlertTriangle,
  Archive,
  ArrowRight,
  Clock3,
  FileText,
  FolderClock,
  Globe2,
  Layers3,
  LoaderCircle,
  RefreshCw,
} from '@lucide/vue';
import { computed, onBeforeUnmount, ref, watch } from 'vue';

import { isAbortError } from '../../../api/http-client';
import {
  getActiveWorkflowRunOverview,
  listWorkingArtifacts,
} from '../../workflow/api/workflow-working.api';
import {
  latestWorkflowNodeStateMap,
  workflowNodeBaseId,
} from '../../workflow/workflow-node-id';
import { listAssets, listAssetVersions } from '../api/asset.api';
import { SPACE_LABELS, WORKFLOW_META, typeLabel } from '../asset-v4';
import AssetPreview from './AssetPreview.vue';

const props = withDefaults(
  defineProps<{
    project: Project;
    workflow: AssetWorkflow;
    space: AssetWorkflowSpace;
    canResume?: boolean;
  }>(),
  { canResume: false },
);
const emit = defineEmits<{ resumeNode: [nodeId: string] }>();

type LoadStatus = 'loading' | 'success' | 'error';
type WorkflowNodeDefinition = { id: string; label: string };

const EFFECT_NODES: readonly WorkflowNodeDefinition[] = [
  { id: 'SOURCE_IMPORT', label: '资料包导入' },
  { id: 'INFORMATION_EXTRACTION', label: 'AI 信息提炼' },
  { id: 'PROMPT_GENERATION', label: 'Prompt 生成' },
  { id: 'SEGMENT_RENDER', label: '片段渲染' },
  { id: 'TEMPLATE_MIX', label: '模板混剪' },
  { id: 'FINAL_OUTPUT', label: '成片生成与批量导出' },
] as const;

const status = ref<LoadStatus>('loading');
const error = ref('');
const run = ref<WorkflowRun | null>(null);
const nodeStates = ref<WorkflowNodeState[]>([]);
const artifacts = ref<WorkingArtifact[]>([]);
const archivedAssets = ref<Asset[]>([]);
const versionsByAsset = ref<Record<string, AssetVersion[]>>({});
let controller: AbortController | undefined;
let generation = 0;

const workflowNodes = computed<readonly WorkflowNodeDefinition[]>(() =>
  props.workflow === 'EFFECT' ? EFFECT_NODES : [],
);
const stateByNode = computed(() => latestWorkflowNodeStateMap(nodeStates.value));
const latestState = computed(
  () =>
    [...nodeStates.value].sort(
      (left, right) => Date.parse(right.savedAt) - Date.parse(left.savedAt),
    )[0],
);
const currentNodeIndex = computed(() => {
  const index = workflowNodes.value.findIndex(
    (node) =>
      node.id === workflowNodeBaseId(run.value?.currentNodeId ?? latestState.value?.nodeId),
  );
  return index >= 0 ? index : 0;
});
const currentNodeLabel = computed(
  () =>
    workflowNodes.value[currentNodeIndex.value]?.label ?? latestState.value?.nodeId ?? '尚未开始',
);
const activeNodeId = computed(() =>
  workflowNodeBaseId(run.value?.currentNodeId ?? latestState.value?.nodeId),
);
const lastSavedAt = computed(() => {
  const timestamps = [
    props.project.updatedAt,
    run.value?.updatedAt,
    ...nodeStates.value.map((item) => item.savedAt),
    ...artifacts.value.map((item) => item.updatedAt),
  ].filter((value): value is string => Boolean(value));
  return timestamps.sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null;
});

const projectStatusLabel = computed(() => {
  if (props.project.status === 'COMPLETED') return '已完成';
  if (props.project.status === 'ACTIVE') return '进行中';
  return '草稿';
});

const formatTime = (value: string | null): string =>
  value
    ? new Intl.DateTimeFormat('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(new Date(value))
    : '尚未保存';

const nodeLabel = (nodeId: string): string =>
  workflowNodes.value.find((node) => node.id === nodeId)?.label ?? nodeId;

const nodeStatus = (definition: WorkflowNodeDefinition): string => {
  const state = stateByNode.value.get(definition.id);
  if (definition.id === activeNodeId.value) return '编辑中';
  if (!state) return '尚未开始';
  return '已自动保存';
};

const artifactSummary = (artifact: WorkingArtifact): string => {
  if (artifact.kind === 'FILE')
    return artifact.originalFileName || artifact.mimeType || '文件工作副本';
  const value = artifact.payload;
  if (!value || typeof value !== 'object') return '结构化工作副本';
  const text = JSON.stringify(value);
  return text.length > 90 ? `${text.slice(0, 90)}…` : text;
};

const artifactStateLabel = (artifact: WorkingArtifact): string => {
  if (artifact.availability === 'PENDING_DELETE') return '待删除，可恢复';
  if (artifact.availability === 'SOURCE_REMOVED') return '来源已删除';
  return artifact.freshness === 'STALE' ? '待更新' : '最新';
};

const configEntries = (artifact: WorkingArtifact): Array<[string, string]> => {
  if (artifact.type !== 'VIDEO_CONFIG' || !artifact.payload || typeof artifact.payload !== 'object')
    return [];
  const payload = artifact.payload as Record<string, unknown>;
  const fields: Array<[string, string]> = [
    ['视频时长', `${String(payload.durationSeconds ?? '—')} 秒`],
    ['画幅比例', String(payload.aspectRatio ?? '—')],
    ['风格基调', String(payload.styleTone ?? '—')],
    ['投放渠道', String(payload.deliveryChannel ?? '—')],
  ];
  return fields;
};

const load = async (): Promise<void> => {
  controller?.abort();
  const request = new AbortController();
  controller = request;
  const requestGeneration = ++generation;
  status.value = 'loading';
  error.value = '';
  run.value = null;
  nodeStates.value = [];
  artifacts.value = [];
  archivedAssets.value = [];
  versionsByAsset.value = {};
  try {
    const [overviewResponse, artifactResponse, assetResponse] = await Promise.all([
      getActiveWorkflowRunOverview(props.project.id, props.workflow, props.space, request.signal),
      listWorkingArtifacts(
        props.project.id,
        { workflow: props.workflow, space: props.space },
        request.signal,
      ),
      listAssets(
        props.project.id,
        { workflow: props.workflow, space: props.space, page: 1, pageSize: 96 },
        request.signal,
      ),
    ]);
    if (request.signal.aborted || requestGeneration !== generation) return;
    run.value = overviewResponse.data.run;
    nodeStates.value = overviewResponse.data.nodeStates;
    artifacts.value = artifactResponse.data.items;
    archivedAssets.value = assetResponse.data.items;
    const versionEntries = await Promise.all(
      assetResponse.data.items.map(async (asset) => {
        try {
          const response = await listAssetVersions(props.project.id, asset.id, request.signal);
          return [asset.id, response.data] as const;
        } catch (versionError) {
          if (isAbortError(versionError)) throw versionError;
          return [asset.id, []] as const;
        }
      }),
    );
    if (request.signal.aborted || requestGeneration !== generation) return;
    versionsByAsset.value = Object.fromEntries(versionEntries);
    status.value = 'success';
  } catch (loadError) {
    if (isAbortError(loadError) || requestGeneration !== generation) return;
    error.value = loadError instanceof Error ? loadError.message : '项目工作数据加载失败';
    status.value = 'error';
  }
};

watch(
  () => [props.project.id, props.workflow, props.space] as const,
  () => void load(),
  { immediate: true },
);
onBeforeUnmount(() => controller?.abort());
</script>

<template>
  <div class="project-overview" :aria-busy="status === 'loading'">
    <div v-if="status === 'loading'" class="overview-state">
      <LoaderCircle class="spinner" :size="25" /><strong>正在加载项目工作数据…</strong>
    </div>
    <div v-else-if="status === 'error'" class="overview-state is-error" role="alert">
      <AlertTriangle :size="26" /><strong>项目工作数据加载失败</strong>
      <p>{{ error }}</p>
      <button type="button" @click="load"><RefreshCw :size="14" />重新加载</button>
    </div>
    <template v-else>
      <section class="project-summary">
        <div class="summary-main">
          <span class="summary-icon"><Layers3 :size="20" /></span>
          <div>
            <h2>{{ project.name }}</h2>
            <p>{{ project.id }} · {{ WORKFLOW_META[workflow].label }} · {{ projectStatusLabel }}</p>
          </div>
        </div>
        <div class="summary-metrics">
          <span
            ><small>当前节点</small><strong>{{ currentNodeLabel }}</strong></span
          >
          <span
            ><small>工作流进度</small
            ><strong>{{ currentNodeIndex + 1 }}/{{ workflowNodes.length || 1 }}</strong></span
          >
          <span
            ><small>最后保存</small><strong>{{ formatTime(lastSavedAt) }}</strong></span
          >
          <span
            ><small>工作空间</small><strong>{{ SPACE_LABELS[space] }}</strong></span
          >
        </div>
        <p class="project-description">{{ project.description || '暂无项目说明' }}</p>
      </section>

      <div class="overview-grid">
        <section class="overview-panel drafts-panel">
          <header>
            <span><FolderClock :size="17" /></span>
            <div>
              <h3>工作流草稿</h3>
              <p>节点编辑状态，仅保存在当前项目</p>
            </div>
            <b>{{ nodeStates.length }}</b>
          </header>
          <div v-if="!run" class="section-empty">
            <FileText :size="27" /><strong>尚无工作流草稿</strong>
            <p>进入节点编辑后会自动保存到这里。</p>
          </div>
          <div v-else class="draft-list">
            <button
              v-for="(definition, index) in workflowNodes"
              :key="definition.id"
              type="button"
              :disabled="!stateByNode.has(definition.id) || !canResume"
              @click="emit('resumeNode', definition.id)"
            >
              <span class="step-index">{{ index + 1 }}</span>
              <span
                ><strong>{{ definition.label }}</strong
                ><small v-if="stateByNode.get(definition.id)"
                  >revision {{ stateByNode.get(definition.id)?.revision }} ·
                  {{ formatTime(stateByNode.get(definition.id)?.savedAt ?? null) }}</small
                ><small v-else>暂无已保存内容</small></span
              >
              <em :class="{ active: definition.id === latestState?.nodeId }">{{
                nodeStatus(definition)
              }}</em>
              <ArrowRight v-if="stateByNode.has(definition.id) && canResume" :size="14" />
            </button>
          </div>
          <p v-if="run && !canResume" class="resume-hint">
            只有当前绑定项目可以直接返回节点继续编辑。
          </p>
        </section>

        <section class="overview-panel artifacts-panel">
          <header>
            <span><Clock3 :size="17" /></span>
            <div>
              <h3>工作区产物</h3>
              <p>最新工作副本，不进入跨项目选择器</p>
            </div>
            <b>{{ artifacts.length }}</b>
          </header>
          <div v-if="!artifacts.length" class="section-empty">
            <FolderClock :size="27" /><strong>暂无工作区产物</strong>
            <p>上传或生成成功后会自动维护最新副本。</p>
          </div>
          <div v-else class="artifact-grid">
            <article v-for="artifact in artifacts" :key="artifact.id">
              <div
                class="working-preview"
                :class="{ package: artifact.type === 'SOURCE_MATERIAL' }"
              >
                <img
                  v-if="artifact.mainPreviewUrl"
                  :src="artifact.mainPreviewUrl"
                  :alt="artifact.name"
                />
                <FileText v-else :size="32" />
                <span v-if="artifact.type === 'SOURCE_MATERIAL'">
                  {{ artifact.fileCount }} 个文件
                </span>
              </div>
              <div class="artifact-copy">
                <span class="artifact-type">{{ typeLabel(artifact.type) }}</span
                ><strong>{{ artifact.name }}</strong>
                <div v-if="artifact.type === 'SOURCE_MATERIAL'" class="package-files">
                  <a
                    v-for="file in artifact.files"
                    :key="file.id"
                    :href="file.downloadUrl"
                    target="_blank"
                    rel="noreferrer"
                    >{{ file.originalFileName }}</a
                  >
                </div>
                <dl v-else-if="artifact.type === 'VIDEO_CONFIG'" class="config-summary">
                  <div v-for="entry in configEntries(artifact)" :key="entry[0]">
                    <dt>{{ entry[0] }}</dt>
                    <dd>{{ entry[1] }}</dd>
                  </div>
                </dl>
                <p v-else>{{ artifactSummary(artifact) }}</p>
                <footer>
                  <span>revision {{ artifact.revision }}</span
                  ><span>{{ nodeLabel(artifact.nodeId) }}</span
                  ><em
                    :class="{
                      stale:
                        artifact.freshness === 'STALE' || artifact.availability !== 'AVAILABLE',
                    }"
                    >{{ artifactStateLabel(artifact) }}</em
                  ><b>尚未归档</b>
                </footer>
              </div>
            </article>
          </div>
        </section>

        <section class="overview-panel archived-panel">
          <header>
            <span><Archive :size="17" /></span>
            <div>
              <h3>已归档资产</h3>
              <p>正式 ProjectAsset 与版本记录</p>
            </div>
            <b>{{ archivedAssets.length }}</b>
          </header>
          <div v-if="!archivedAssets.length" class="section-empty">
            <Archive :size="27" /><strong>尚无已归档资产</strong>
            <p>当前尚未实现“完成工作流并归档”，这里不会用工作副本冒充正式资产。</p>
          </div>
          <div v-else class="archived-list">
            <article v-for="asset in archivedAssets" :key="asset.id">
              <AssetPreview :asset="asset" compact />
              <div>
                <span>{{ typeLabel(asset.type) }}</span
                ><strong>{{ asset.name }}</strong>
                <p>{{ asset.originalFileName || '结构化资产' }}</p>
                <footer>
                  <em v-for="version in versionsByAsset[asset.id] ?? []" :key="version.id"
                    >v{{ version.version }} · {{ formatTime(version.createdAt) }}</em
                  ><em v-if="!versionsByAsset[asset.id]?.length"
                    >v{{ asset.currentVersion ?? 1 }}</em
                  >
                </footer>
              </div>
            </article>
          </div>
        </section>

        <section class="overview-panel global-panel">
          <header>
            <span><Globe2 :size="17" /></span>
            <div>
              <h3>全局发布资产</h3>
              <p>由当前项目明确发布、可跨项目复用</p>
            </div>
            <b>0</b>
          </header>
          <div class="section-empty">
            <Globe2 :size="27" /><strong>暂无全局发布资产</strong>
            <p>全局发布能力暂未实现；正式 ProjectAsset 不会自动成为全局资产。</p>
          </div>
        </section>
      </div>
    </template>
  </div>
</template>

<style scoped>
.project-overview {
  height: 100%;
  padding: 14px 16px 22px;
  overflow: auto;
  background: #f3f6fb;
  box-sizing: border-box;
  color: #17233a;
}
.overview-state {
  display: flex;
  min-height: 320px;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: 9px;
  color: #72809a;
}
.overview-state.is-error {
  color: #b45353;
}
.overview-state button {
  display: flex;
  height: 34px;
  padding: 0 13px;
  align-items: center;
  gap: 6px;
  border: 1px solid #c8d6ed;
  border-radius: 9px;
  background: #fff;
  color: #245ec7;
  font-weight: 800;
}
.spinner {
  animation: spin 1s linear infinite;
}
.project-summary,
.overview-panel {
  background: #fff;
  border: 1px solid #dce5f2;
  border-radius: 16px;
  box-shadow: 0 7px 22px rgba(31, 65, 126, 0.045);
}
.project-summary {
  padding: 16px 18px;
}
.summary-main {
  display: flex;
  align-items: center;
  gap: 10px;
}
.summary-icon {
  display: grid;
  width: 38px;
  height: 38px;
  place-items: center;
  border-radius: 11px;
  background: #eaf1ff;
  color: #2563eb;
}
.summary-main h2 {
  margin: 0;
  font-size: 20px;
}
.summary-main p,
.project-description {
  margin: 4px 0 0;
  color: #72809a;
  font-size: 12px;
}
.summary-metrics {
  display: grid;
  margin-top: 14px;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 9px;
}
.summary-metrics span {
  padding: 10px 12px;
  border: 1px solid #e4eaf4;
  border-radius: 11px;
  background: #f8faff;
}
.summary-metrics small,
.summary-metrics strong {
  display: block;
}
.summary-metrics small {
  color: #7e8aa0;
  font-size: 10px;
}
.summary-metrics strong {
  margin-top: 3px;
  font-size: 13px;
}
.project-description {
  padding-top: 11px;
  border-top: 1px solid #edf1f7;
}
.overview-grid {
  display: grid;
  margin-top: 12px;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 12px;
}
.overview-panel {
  min-width: 0;
  padding: 14px;
}
.overview-panel > header {
  display: flex;
  align-items: center;
  gap: 9px;
  padding-bottom: 11px;
  border-bottom: 1px solid #edf1f7;
}
.overview-panel > header > span {
  display: grid;
  width: 31px;
  height: 31px;
  place-items: center;
  border-radius: 9px;
  background: #edf3ff;
  color: #2563eb;
}
.overview-panel > header div {
  min-width: 0;
  flex: 1;
}
.overview-panel h3 {
  margin: 0;
  font-size: 14px;
}
.overview-panel header p {
  margin: 2px 0 0;
  color: #8490a5;
  font-size: 10px;
}
.overview-panel header > b {
  display: grid;
  min-width: 25px;
  height: 25px;
  padding: 0 6px;
  place-items: center;
  border-radius: 999px;
  background: #edf3ff;
  color: #2563eb;
  font-size: 11px;
}
.draft-list {
  display: flex;
  padding-top: 7px;
  flex-direction: column;
}
.draft-list button {
  display: grid;
  width: 100%;
  padding: 8px 5px;
  grid-template-columns: 28px minmax(0, 1fr) auto 16px;
  align-items: center;
  gap: 8px;
  border: 0;
  border-bottom: 1px solid #f0f3f8;
  background: transparent;
  color: inherit;
  text-align: left;
}
.draft-list button:not(:disabled) {
  cursor: pointer;
}
.draft-list button:disabled {
  opacity: 0.55;
}
.step-index {
  display: grid;
  width: 25px;
  height: 25px;
  place-items: center;
  border-radius: 8px;
  background: #eef3fb;
  color: #4e6284;
  font-size: 10px;
  font-weight: 900;
}
.draft-list strong,
.draft-list small {
  display: block;
}
.draft-list strong {
  font-size: 12px;
}
.draft-list small {
  margin-top: 2px;
  color: #8a96aa;
  font-size: 9px;
}
.draft-list em {
  color: #71809a;
  font-size: 9px;
  font-style: normal;
}
.draft-list em.active {
  color: #2563eb;
  font-weight: 900;
}
.resume-hint {
  margin: 9px 4px 0;
  color: #8490a5;
  font-size: 9px;
}
.artifact-grid {
  display: grid;
  padding-top: 10px;
  grid-template-columns: repeat(auto-fit, minmax(225px, 1fr));
  gap: 9px;
}
.artifact-grid article,
.archived-list article {
  display: flex;
  min-width: 0;
  padding: 8px;
  gap: 9px;
  border: 1px solid #e1e8f3;
  border-radius: 12px;
  background: #fbfcff;
}
.working-preview,
.archived-list :deep(.asset-preview) {
  width: 72px;
  min-width: 72px;
  height: 72px;
  border-radius: 9px;
}
.working-preview {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  background: #edf3ff;
  color: #5474ac;
}
.working-preview img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.working-preview span {
  position: absolute;
  right: 4px;
  bottom: 4px;
  padding: 2px 5px;
  border-radius: 999px;
  background: rgb(16 35 68 / 76%);
  color: white;
  font-size: 8px;
}
.package-files {
  display: flex;
  margin: 4px 0;
  flex-wrap: wrap;
  gap: 3px;
}
.package-files a {
  max-width: 125px;
  overflow: hidden;
  color: #52647f;
  font-size: 8px;
  text-decoration: none;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.config-summary {
  display: grid;
  margin: 5px 0;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 3px;
}
.config-summary div {
  padding: 3px 4px;
  border-radius: 5px;
  background: #f0f4fb;
}
.config-summary dt,
.config-summary dd {
  margin: 0;
  font-size: 8px;
}
.config-summary dt {
  color: #8793a7;
}
.config-summary dd {
  color: #344b70;
  font-weight: 800;
}
.artifact-copy,
.archived-list article > div {
  min-width: 0;
  flex: 1;
}
.artifact-type,
.archived-list article > div > span {
  color: #2563eb;
  font-size: 9px;
  font-weight: 800;
}
.artifact-copy > strong,
.archived-list article > div > strong {
  display: block;
  margin-top: 3px;
  overflow: hidden;
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.artifact-copy > p,
.archived-list article > div > p {
  margin: 4px 0;
  color: #8390a5;
  font-size: 9px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.artifact-copy footer {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.artifact-copy footer span,
.artifact-copy footer em,
.artifact-copy footer b,
.archived-list footer em {
  padding: 2px 5px;
  border-radius: 5px;
  background: #edf2f8;
  color: #65748e;
  font-size: 8px;
  font-style: normal;
  font-weight: 700;
}
.artifact-copy footer em {
  background: #e8f7f0;
  color: #16845e;
}
.artifact-copy footer em.stale {
  background: #fff2df;
  color: #a85f00;
}
.artifact-copy footer b {
  background: #edf3ff;
  color: #2563eb;
}
.section-empty {
  display: flex;
  min-height: 125px;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  color: #8a96aa;
  text-align: center;
}
.section-empty strong {
  margin-top: 7px;
  color: #516079;
  font-size: 12px;
}
.section-empty p {
  max-width: 390px;
  margin: 4px 0 0;
  font-size: 10px;
  line-height: 1.55;
}
.archived-list {
  display: flex;
  padding-top: 9px;
  flex-direction: column;
  gap: 8px;
}
.archived-list footer {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.global-panel .section-empty {
  min-height: 156px;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
@media (max-width: 1100px) {
  .overview-grid {
    grid-template-columns: 1fr;
  }
  .summary-metrics {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
@media (max-width: 650px) {
  .summary-metrics {
    grid-template-columns: 1fr;
  }
}
</style>
