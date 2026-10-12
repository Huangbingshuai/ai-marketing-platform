<script setup lang="ts">
import {
  EFFECT_WORKFLOW_BRANCH_NODES,
  type EffectWorkflowBranchTreeData,
} from '@ai-marketing/contracts';
import {
  AudioLines,
  Clapperboard,
  Clock3,
  FileText,
  Film,
  FolderInput,
  FolderOpen,
  GitBranch,
  LayoutTemplate,
  LocateFixed,
  Maximize,
  Minus,
  Plus,
  Sparkles,
  X,
} from '@lucide/vue';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  effectBranchDestination,
  type EffectBranchNavigation,
} from '../../shared/effect-branch-navigation';

import {
  BRANCH_TREE_AXIS_WIDTH,
  BRANCH_TREE_NODE_WIDTH,
  BRANCH_TREE_NODE_HEIGHT,
  BRANCH_TREE_ROOT_TOP,
  BRANCH_TREE_STAGES,
  BRANCH_TREE_ROW_GAP,
  BRANCH_TREE_TOP,
  buildEffectBranchLayout,
  type WorkflowBranchDisplayNode,
  type WorkflowBranchDisplayLayout,
} from './effect-workflow-branch-layout';
import {
  BRANCH_MAX_ZOOM,
  BRANCH_MIN_ZOOM,
  branchZoomScroll,
  clampBranchZoom,
  fitBranchZoom,
} from './effect-workflow-branch-viewport';

const props = defineProps<{
  projectName: string;
  // Optional display adapters keep all tree interactions shared across workflows.
  alternateLayout?: WorkflowBranchDisplayLayout | undefined;
  alternateStages?: readonly { key: string; nodeId: string; name: string }[];
  workflowLabel?: string;
  activeWorkflowRunId?: string | null | undefined;
  tree: EffectWorkflowBranchTreeData | null;
  loading: boolean;
  error: string;
  switching: boolean;
  forkDisabled: boolean;
  activeTemplateId: string | null;
  viewedWorkflowRunId?: string | null;
  assetBrowse?: boolean;
  selectableNodeKeys?: string[];
  browsedNodeKey?: string;
}>();
const emit = defineEmits<{
  close: [];
  retry: [];
  select: [destination: Omit<EffectBranchNavigation, 'projectId'>];
  fork: [];
  selectWorkflow: [destination: { workflowRunId: string; nodeId: string }];
}>();
const dialog = ref<HTMLElement | null>(null);
const scrollContainer = ref<HTMLElement | null>(null);
const graphElement = ref<HTMLElement | null>(null);
const treeZoom = ref(1);
let initialViewReady = false;
let returnFocus: HTMLElement | null = null;
let previousBodyOverflow = '';
const layout = computed(
  () =>
    props.alternateLayout ??
    buildEffectBranchLayout(
      props.tree?.branches ?? [],
      props.activeTemplateId,
      props.viewedWorkflowRunId,
    ),
);
const stages = computed(() => props.alternateStages ?? BRANCH_TREE_STAGES);
const workflowLabel = computed(() => props.workflowLabel ?? '效果类');
const stageIcons: Record<string, typeof FolderInput> = {
  SOURCE_IMPORT: FolderInput,
  INFORMATION_EXTRACTION: Sparkles,
  PROMPT_GENERATION: FileText,
  SEGMENT_RENDER: Film,
  MIX_TEMPLATE: LayoutTemplate,
  MIX_FILL: Clapperboard,
  MIX_PACKAGING: AudioLines,
  FINAL_OUTPUT: Film,
  STORYBOARD: Clapperboard,
  SHOT_PROMPT: FileText,
  VISUAL_ASSETS: FolderOpen,
  SHOT_RENDER: Film,
  DELIVERY: Film,
};
const currentViewNode = computed(
  () =>
    (props.assetBrowse
      ? layout.value.nodes.find((node) => node.key === props.browsedNodeKey)
      : undefined) ??
    [...layout.value.nodes]
      .filter((node) => node.isCurrentStage)
      .sort((left, right) => right.stageIndex - left.stageIndex)[0] ??
    [...layout.value.nodes].reverse().find((node) => node.onActivePath),
);
const mixStartIndex = stages.value.findIndex((stage) => stage.nodeId === 'TEMPLATE_MIX');
const mixStages = stages.value.filter((stage) => stage.nodeId === 'TEMPLATE_MIX');
const stageName = (stageKey: string) =>
  stages.value.find((stage) => stage.key === stageKey)?.name ?? stageKey;
const versionText = (
  revision: number | null,
  revisions: number[] | undefined,
  count: number,
  status: string,
) => {
  const name = (value: number) => `版本${String(value).padStart(2, '0')}`;
  if (revision !== null) return name(revision);
  if (revisions?.length) return revisions.map(name).join(' / ');
  return status === 'PENDING' && count > 0 ? '待校验' : '版本未记录';
};
const artifactCreatedAtText = (value: string | null) => {
  if (!value) return '创建时间未记录';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '创建时间未知';
  return `创建于 ${new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date)}`;
};
const compactCreatedAtText = (value: string | null) =>
  artifactCreatedAtText(value).replace(/^创建于 \d{4}\//, '');
const statusText = (status: string, count: number) =>
  status === 'CONFIRMED'
    ? `已确认 · ${count} 项`
    : status === 'STALE'
      ? '待更新'
      : count > 0
        ? '待校验'
        : '待处理';
const nodeStatusText = (node: WorkflowBranchDisplayNode) =>
  node.stageKey === 'MIX_TEMPLATE' && node.status === 'PENDING'
    ? '模板已创建'
    : node.stageKey === 'MIX_FILL' && node.status === 'STALE' && !node.showStaleWarning
      ? `已填充 · ${node.artifactCount} 项`
      : statusText(node.status, node.artifactCount);

const selectNode = (node: WorkflowBranchDisplayNode) => {
  if (
    props.switching ||
    props.loading ||
    props.error ||
    (props.assetBrowse && !props.selectableNodeKeys?.includes(node.key))
  )
    return;
  if (props.alternateStages) {
    emit('selectWorkflow', { workflowRunId: node.workflowRunId, nodeId: node.nodeId });
    return;
  }
  const nodeId = EFFECT_WORKFLOW_BRANCH_NODES.find((id) => id === node.nodeId);
  if (nodeId) emit('select', effectBranchDestination({ ...node, nodeId }));
};
const centerTree = async () => {
  await nextTick();
  const scroll = scrollContainer.value;
  const graph = graphElement.value;
  if (!scroll || !graph) return;
  const axisWidth =
    scroll.querySelector<HTMLElement>('.branch-axis-rail')?.getBoundingClientRect().width ??
    BRANCH_TREE_AXIS_WIDTH;
  const graphCenter =
    graph.getBoundingClientRect().left -
    scroll.getBoundingClientRect().left +
    scroll.scrollLeft +
    layout.value.root.x * treeZoom.value;
  const visibleTreeCenter = axisWidth + (scroll.clientWidth - axisWidth) / 2;
  scroll.scrollLeft = Math.max(0, graphCenter - visibleTreeCenter);
};
const fitTree = async () => {
  const scroll = scrollContainer.value;
  if (!scroll) return;
  treeZoom.value = fitBranchZoom(
    { width: scroll.clientWidth, height: Math.max(0, scroll.clientHeight - 56) },
    { width: layout.value.width + BRANCH_TREE_AXIS_WIDTH, height: layout.value.height },
  );
  await nextTick();
  scroll.scrollLeft = 0;
  scroll.scrollTop = 0;
};
const changeZoom = async (value: number) => {
  const scroll = scrollContainer.value;
  if (!scroll) return;
  const previous = treeZoom.value;
  const next = clampBranchZoom(value);
  const left = branchZoomScroll(scroll.scrollLeft, scroll.clientWidth, previous, next);
  const top = branchZoomScroll(scroll.scrollTop, scroll.clientHeight, previous, next);
  treeZoom.value = next;
  await nextTick();
  scroll.scrollLeft = left;
  scroll.scrollTop = top;
};
const locateCurrent = async () => {
  const current = currentViewNode.value;
  if (!current) return;
  treeZoom.value = 1;
  await nextTick();
  const scroll = scrollContainer.value;
  const card = Array.from(
    graphElement.value?.querySelectorAll<HTMLElement>('[data-branch-key]') ?? [],
  ).find((element) => element.dataset.branchKey === current.key);
  if (!scroll || !card) return;
  const bounds = card.getBoundingClientRect();
  const viewport = scroll.getBoundingClientRect();
  const axisWidth = scroll.querySelector('.branch-axis-rail')?.getBoundingClientRect().width ?? 0;
  scroll.scrollLeft +=
    bounds.left +
    bounds.width / 2 -
    viewport.left -
    (axisWidth + (scroll.clientWidth - axisWidth) / 2);
  scroll.scrollTop += bounds.top + bounds.height / 2 - viewport.top - scroll.clientHeight / 2;
  card.focus({ preventScroll: true });
};
const initializeView = async () => {
  await nextTick();
  if (!initialViewReady && scrollContainer.value && layout.value.nodes.length) {
    initialViewReady = true;
    const scroll = scrollContainer.value;
    // Start readable. A full-tree overview can be requested explicitly rather
    // than making every version label tiny on a short or narrow screen.
    treeZoom.value = Math.max(
      0.8,
      fitBranchZoom(
        { width: scroll.clientWidth, height: Math.max(0, scroll.clientHeight - 56) },
        { width: layout.value.width + BRANCH_TREE_AXIS_WIDTH, height: layout.value.height },
      ),
    );
    await centerTree();
  }
};
const onViewportResize = () => {
  // Keep the user's zoom/scroll during ordinary background refreshes.
  if (initialViewReady) void centerTree();
};
watch(
  () => props.alternateLayout ?? props.tree,
  () => void initializeView(),
  { flush: 'post' },
);
const onKeydown = (event: KeyboardEvent) => {
  if (event.key === 'Escape' && !props.switching) {
    event.preventDefault();
    emit('close');
  }
  if (event.key !== 'Tab' || !dialog.value) return;
  const focusable = Array.from(
    dialog.value.querySelectorAll<HTMLElement>(
      'button:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((element) => element.getAttribute('tabindex') !== '-1');
  if (!focusable.length) return;
  const first = focusable[0]!;
  const last = focusable[focusable.length - 1]!;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
};
onMounted(async () => {
  returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  previousBodyOverflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';
  document.addEventListener('keydown', onKeydown);
  window.addEventListener('resize', onViewportResize);
  await nextTick();
  dialog.value?.focus();
  await initializeView();
});
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown);
  window.removeEventListener('resize', onViewportResize);
  document.body.style.overflow = previousBodyOverflow;
  returnFocus?.focus();
});
</script>

<template>
  <Teleport to="body">
    <div class="branch-backdrop">
      <section
        ref="dialog"
        class="branch-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="branch-title"
        tabindex="-1"
      >
        <header class="branch-header">
          <div class="branch-header__intro">
            <div class="branch-header__icon"><GitBranch :size="22" /></div>
            <div>
              <span class="branch-eyebrow">{{
                alternateStages ? 'CUSTOMIZED WORKFLOW' : 'EFFECT WORKFLOW'
              }}</span>
              <h2 id="branch-title">版本分支树</h2>
              <p v-if="layout.nodes.length">
                {{
                  assetBrowse
                    ? '点击版本查看对应资产，不切换正在编辑的工作流。'
                    : '以项目为中心，分支向两侧展开。点击版本切换工作流。'
                }}
              </p>
            </div>
          </div>
          <button
            type="button"
            class="branch-close"
            aria-label="关闭版本分支树"
            :disabled="switching"
            @click="emit('close')"
          >
            <X :size="20" />
          </button>
        </header>
        <div v-if="loading && !tree && !alternateLayout" class="branch-message" role="status">
          正在加载版本分支…
        </div>
        <div
          v-else-if="error && !tree && !alternateLayout"
          class="branch-message branch-message--error"
          role="alert"
        >
          <span>{{ error }}</span
          ><button type="button" @click="emit('retry')">重试</button>
        </div>
        <template v-else>
          <div v-if="layout.nodes.length || switching || loading || error" class="branch-toolbar">
            <div v-if="layout.nodes.length" class="branch-toolbar__legend">
              <span><i class="legend-current" />当前工作流路径</span>
              <span><i class="legend-other" />其他版本</span>
              <span><i class="legend-stale" />待更新</span>
            </div>
            <span v-if="switching" class="branch-switching" role="status">正在切换分支…</span>
            <span v-else-if="loading" class="branch-switching" role="status"
              >正在同步最新分支…</span
            >
            <span v-else-if="error" class="branch-switching branch-switching--error" role="alert">
              更新失败，当前显示上次结果
              <button type="button" @click="emit('retry')">重试</button>
            </span>
          </div>
          <div class="branch-workspace">
            <div
              ref="scrollContainer"
              class="branch-scroll"
              :aria-label="`${workflowLabel}工作流版本树`"
              :aria-busy="switching || loading"
            >
              <div
                class="branch-canvas"
                :style="{
                  minWidth: `${layout.width + BRANCH_TREE_AXIS_WIDTH}px`,
                  height: `${layout.height}px`,
                  zoom: treeZoom,
                }"
              >
                <div
                  v-for="(stage, index) in stages"
                  :key="`band:${stage.key}`"
                  class="branch-stage-band"
                  :class="{ 'branch-stage-band--alternate': index % 2 === 1 }"
                  :style="{
                    top: `${BRANCH_TREE_TOP + index * BRANCH_TREE_ROW_GAP - BRANCH_TREE_ROW_GAP / 2}px`,
                    height: `${BRANCH_TREE_ROW_GAP}px`,
                  }"
                  aria-hidden="true"
                />
                <div class="branch-axis-rail">
                  <div
                    class="branch-axis branch-axis--root"
                    :style="{
                      top: `${BRANCH_TREE_ROOT_TOP}px`,
                      height: `${BRANCH_TREE_ROW_GAP}px`,
                    }"
                  >
                    <span class="branch-axis__number">00</span>
                    <span>项目</span>
                  </div>
                  <template v-for="(stage, index) in stages" :key="`axis:${stage.key}`">
                    <div
                      v-if="stage.nodeId !== 'TEMPLATE_MIX'"
                      class="branch-axis"
                      :class="{ 'branch-axis--alternate': index % 2 === 1 }"
                      :style="{
                        top: `${BRANCH_TREE_TOP + index * BRANCH_TREE_ROW_GAP}px`,
                        height: `${BRANCH_TREE_ROW_GAP}px`,
                      }"
                    >
                      <span class="branch-axis__number">{{
                        String(mixStartIndex < 0 || index < mixStartIndex ? index + 1 : 6).padStart(
                          2,
                          '0',
                        )
                      }}</span>
                      <span>{{ stage.name }}</span>
                    </div>
                  </template>
                  <div
                    v-if="mixStages.length"
                    class="branch-axis-mix-group"
                    role="group"
                    :aria-label="`${'模板混剪'}：混剪模板、智能填充、智能成片包装`"
                    :style="{
                      top: `${BRANCH_TREE_TOP + mixStartIndex * BRANCH_TREE_ROW_GAP - BRANCH_TREE_ROW_GAP / 2}px`,
                      height: `${mixStages.length * BRANCH_TREE_ROW_GAP}px`,
                    }"
                  >
                    <div class="branch-axis-mix-group__parent">
                      <span class="branch-axis__number">05</span>
                      <span>混剪</span>
                    </div>
                    <div class="branch-axis-mix-group__rows">
                      <div
                        v-for="stage in mixStages"
                        :key="stage.key"
                        class="branch-axis-mix-group__row"
                        :style="{ height: `${BRANCH_TREE_ROW_GAP}px` }"
                      >
                        <span>{{ stage.name }}</span>
                      </div>
                    </div>
                  </div>
                </div>
                <div
                  ref="graphElement"
                  class="branch-graph"
                  :style="{ width: `${layout.width}px`, height: `${layout.height}px` }"
                >
                  <svg
                    class="branch-lines"
                    :width="layout.width"
                    :height="layout.height"
                    aria-hidden="true"
                  >
                    <g v-for="edge in layout.edges" :key="edge.key">
                      <path :d="edge.path" :class="{ 'branch-line--active': edge.onActivePath }" />
                      <path
                        :d="edge.arrowPath"
                        class="branch-arrow"
                        :class="{ 'branch-arrow--active': edge.onActivePath }"
                      />
                    </g>
                  </svg>
                  <div
                    class="branch-project-root"
                    :class="{
                      'branch-project-root--active':
                        activeWorkflowRunId ?? tree?.activeWorkflowRunId,
                    }"
                    :style="{ left: `${layout.root.x}px`, top: `${layout.root.y}px` }"
                    :aria-label="`项目：${projectName}`"
                  >
                    <span class="branch-project-root__icon" aria-hidden="true"
                      ><FolderOpen :size="22"
                    /></span>
                    <span class="branch-project-root__content"
                      ><small>{{ workflowLabel }}项目</small
                      ><strong>{{ projectName }}</strong></span
                    >
                  </div>
                  <button
                    v-for="node in layout.nodes"
                    :key="node.key"
                    :data-branch-key="node.key"
                    :data-stage="node.stageKey"
                    type="button"
                    class="branch-node"
                    :class="{
                      'branch-node--active': node.onActivePath,
                      'branch-node--current': currentViewNode?.key === node.key,
                      'branch-node--stale': node.showStaleWarning,
                    }"
                    :disabled="
                      switching ||
                      loading ||
                      Boolean(error) ||
                      (assetBrowse && !selectableNodeKeys?.includes(node.key))
                    "
                    :style="{
                      left: `${node.x}px`,
                      top: `${node.y}px`,
                      width: `${BRANCH_TREE_NODE_WIDTH}px`,
                      height: `${BRANCH_TREE_NODE_HEIGHT}px`,
                    }"
                    :aria-label="`${stageName(node.stageKey)}${node.templateName && node.stageKey !== 'MIX_TEMPLATE' ? `，${node.templateName}` : ''}，${node.displayLabel ?? (node.stageKey === 'MIX_TEMPLATE' ? (node.templateName ?? '模板') : versionText(node.revision, node.revisions, node.artifactCount, node.status))}，${node.stageKey === 'MIX_TEMPLATE' || (node.artifactCount > 0 && node.status !== 'PENDING') ? `${artifactCreatedAtText(node.createdAt)}，` : ''}${nodeStatusText(node)}${node.onActivePath ? '，当前工作流路径' : ''}`"
                    :title="`${stageName(node.stageKey)} · ${node.displayLabel ?? (node.stageKey === 'MIX_TEMPLATE' ? (node.templateName ?? '模板') : versionText(node.revision, node.revisions, node.artifactCount, node.status))} · ${nodeStatusText(node)}`"
                    @click="selectNode(node)"
                  >
                    <span class="branch-node__heading">
                      <span class="branch-node__icon" aria-hidden="true"
                        ><component :is="stageIcons[node.stageKey]" :size="19"
                      /></span>
                      <span class="branch-node__identity">
                        <small>{{ stageName(node.stageKey) }}</small>
                        <strong>{{
                          node.displayLabel ?? (node.stageKey === 'MIX_TEMPLATE'
                            ? (node.templateName ?? '模板')
                            : versionText(
                                node.revision,
                                node.revisions,
                                node.artifactCount,
                                node.status,
                              )
                        }}</strong>
                      </span>
                    </span>
                    <span class="branch-node__footer">
                      <span
                        v-if="
                          node.stageKey === 'MIX_TEMPLATE' ||
                          (node.artifactCount > 0 && node.status !== 'PENDING')
                        "
                        class="branch-node__created-at"
                        :title="
                          node.stageKey === 'MIX_TEMPLATE'
                            ? `${artifactCreatedAtText(node.createdAt)} · 模板创建时间；旧草稿可能未记录`
                            : `${artifactCreatedAtText(node.createdAt)} · 已确认工作副本创建时间`
                        "
                        ><Clock3 :size="10" aria-hidden="true" />{{
                          compactCreatedAtText(node.createdAt)
                        }}</span
                      >
                      <span v-if="node.showStaleWarning" class="branch-node__stale">待更新</span>
                      <span
                        v-else-if="currentViewNode?.key === node.key"
                        class="branch-node__current"
                        >当前查看</span
                      >
                    </span>
                  </button>
                </div>
              </div>
            </div>
            <div class="branch-view-controls" role="group" aria-label="版本树视图">
              <button type="button" @click="fitTree"><Maximize :size="15" />查看全图</button>
              <button v-if="currentViewNode" type="button" @click="locateCurrent">
                <LocateFixed :size="15" />定位当前
              </button>
              <span class="branch-view-controls__separator" aria-hidden="true" />
              <button
                type="button"
                aria-label="缩小版本树"
                :disabled="treeZoom <= BRANCH_MIN_ZOOM"
                @click="changeZoom(treeZoom - 0.1)"
              >
                <Minus :size="16" />
              </button>
              <button
                type="button"
                class="branch-zoom-value"
                aria-label="恢复版本树原始大小"
                @click="changeZoom(1)"
              >
                {{ Math.round(treeZoom * 100) }}%
              </button>
              <button
                type="button"
                aria-label="放大版本树"
                :disabled="treeZoom >= BRANCH_MAX_ZOOM"
                @click="changeZoom(treeZoom + 0.1)"
              >
                <Plus :size="16" />
              </button>
            </div>
          </div>
        </template>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.branch-backdrop {
  position: fixed;
  inset: 0;
  z-index: 1200;
  background: rgba(21, 34, 61, 0.42);
}
.branch-dialog {
  display: flex;
  flex-direction: column;
  width: 100vw;
  height: 100dvh;
  color: #20304e;
  background: #f7f9fd;
  outline: none;
}
.branch-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  padding: 18px 24px;
  gap: 16px;
  background: #fff;
  border-bottom: 1px solid #dfe7f4;
}
.branch-header__intro {
  display: flex;
  align-items: center;
  gap: 14px;
}
.branch-header__icon {
  display: grid;
  width: 44px;
  height: 44px;
  flex: none;
  place-items: center;
  color: #2563eb;
  background: #edf4ff;
  border: 1px solid #dce8fc;
  border-radius: 12px;
}
.branch-eyebrow {
  color: #2563eb;
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 1.7px;
}
.branch-header h2 {
  margin: 4px 0;
  color: #17243d;
  font-size: 21px;
}
.branch-header p {
  margin: 0;
  color: #77849b;
  font-size: 13px;
}
.branch-close {
  display: grid;
  width: 38px;
  height: 38px;
  flex: none;
  place-items: center;
  color: #63738d;
  background: #f2f5fa;
  border: 0;
  border-radius: 10px;
  cursor: pointer;
}
.branch-message {
  margin: auto;
  padding: 24px;
  color: #66748d;
  text-align: center;
}
.branch-message--error {
  color: #bd3434;
}
.branch-message button {
  margin-left: 12px;
  padding: 6px 12px;
  color: #2563eb;
  background: white;
  border: 1px solid #bfd1f9;
  border-radius: 8px;
  cursor: pointer;
}
.branch-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 52px;
  padding: 8px 24px;
  gap: 14px;
  background: #fff;
  border-bottom: 1px solid #e1e7f2;
}
.branch-view-controls {
  position: absolute;
  bottom: 18px;
  left: 50%;
  z-index: 8;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 3px;
  background: rgba(255, 255, 255, 0.94);
  border: 1px solid #dce4ef;
  border-radius: 12px;
  backdrop-filter: blur(12px);
  box-shadow: 0 6px 24px rgba(35, 55, 85, 0.12);
  white-space: nowrap;
}
.branch-view-controls button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 34px;
  padding: 0 8px;
  color: #52647e;
  background: transparent;
  border: 0;
  border-radius: 7px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
.branch-view-controls button:hover {
  color: #1d4ed8;
  background: #fff;
}
.branch-view-controls button:disabled {
  color: #bcc6d5;
  cursor: not-allowed;
}
.branch-view-controls .branch-zoom-value {
  min-width: 46px;
  font-variant-numeric: tabular-nums;
}
.branch-view-controls__separator {
  width: 1px;
  height: 16px;
  margin: 0 4px;
  background: #dce4ef;
}
.branch-toolbar__legend {
  display: flex;
  flex-wrap: wrap;
  gap: 18px;
  color: #697991;
  font-size: 12px;
}
.branch-toolbar__legend span {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.branch-toolbar__legend i {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
}
.legend-current {
  background: #dc3545;
}
.legend-other {
  background: #a2b3cd;
}
.legend-stale {
  background: #e0c200;
}
.branch-workspace {
  position: relative;
  display: flex;
  flex: 1;
  min-height: 0;
}
.branch-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
  background: #f8fafd;
  scrollbar-width: thin;
  scrollbar-color: #bcc9dc #f8fafd;
}
.branch-canvas {
  position: relative;
  display: flex;
  width: 100%;
  box-sizing: border-box;
  background:
    radial-gradient(circle, #d7e1ee 0.8px, transparent 1px) 0 0 / 20px 20px,
    #f4f7fb;
  border: 0;
}
.branch-stage-band {
  position: absolute;
  right: 0;
  left: 0;
  background: rgba(255, 255, 255, 0.12);
  border-top: 1px dashed #e3eaf4;
  box-sizing: border-box;
  pointer-events: none;
}
.branch-stage-band--alternate {
  background: rgba(236, 242, 250, 0.18);
}
.branch-graph {
  position: relative;
  flex: 0 0 auto;
  margin: 0 auto;
}
.branch-project-root {
  position: absolute;
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 13px;
  width: 232px;
  height: 88px;
  padding: 16px;
  transform: translate(-50%, -50%);
  color: #fff;
  background: #24334c;
  border: 1.5px solid #354862;
  border-radius: 16px;
  box-shadow: 0 5px 16px rgba(35, 55, 85, 0.13);
  box-sizing: border-box;
  font-size: 14px;
  font-weight: 800;
  overflow-wrap: anywhere;
  text-align: left;
}
.branch-project-root__icon {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  flex: none;
  color: #dfe9fc;
}
.branch-project-root__content {
  display: flex;
  flex-direction: column;
  gap: 7px;
  min-width: 0;
}
.branch-project-root__content small {
  font-size: 10px;
  font-weight: 500;
  color: #b5c4da;
  letter-spacing: 1px;
}
.branch-project-root__content strong {
  font-size: 16px;
  line-height: 1.3;
}
.branch-project-root--active {
  border-color: #df3547;
}
.branch-project-root--active .branch-project-root__icon {
  color: #ffd5dd;
}
.branch-lines {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
.branch-lines path {
  fill: none;
  stroke: #b8c8dc;
  stroke-width: 1.7;
  stroke-linecap: round;
}
.branch-lines path.branch-line--active {
  stroke: #df3547;
  stroke-width: 2.5;
}
.branch-lines path.branch-arrow {
  fill: #b2c1d5;
  stroke: none;
}
.branch-lines path.branch-arrow--active {
  fill: #df3547;
}
.branch-axis-rail {
  position: sticky;
  left: 0;
  z-index: 3;
  width: 178px;
  flex: 0 0 178px;
  height: 100%;
  pointer-events: none;
  background: rgba(248, 250, 253, 0.97);
  border-right: 1px solid #e3eaf4;
  box-sizing: border-box;
}
.branch-axis {
  position: absolute;
  left: 0;
  display: flex;
  align-items: center;
  width: 100%;
  padding: 0 10px;
  transform: translateY(-50%);
  gap: 9px;
  color: #52647e;
  font-size: 13px;
  font-weight: 700;
  box-sizing: border-box;
}
.branch-axis--alternate {
  background: transparent;
}
.branch-axis-mix-group {
  position: absolute;
  right: 0;
  left: 0;
  display: grid;
  grid-template-columns: 91px minmax(0, 1fr);
  background: #fafcff;
  box-shadow:
    inset 0 1px #dce6f3,
    inset 0 -1px #dce6f3;
  box-sizing: border-box;
}
.branch-axis-mix-group__parent {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  padding: 0 10px;
  gap: 9px;
  color: #52647e;
  background: #f0f5fc;
  border-right: 1px solid #cbd9ed;
  font-size: 13px;
  font-weight: 700;
  box-sizing: border-box;
}
.branch-axis-mix-group__rows {
  min-width: 0;
}
.branch-axis-mix-group__row {
  display: flex;
  align-items: center;
  padding: 0 8px;
  color: #435b7b;
  font-size: 11px;
  font-weight: 700;
  box-sizing: border-box;
}
.branch-axis-mix-group__row + .branch-axis-mix-group__row {
  border-top: 1px solid #e0e8f3;
}
.branch-axis-mix-group__row:nth-child(even) {
  background: #f7f9fd;
}
.branch-axis__number {
  display: grid;
  width: 27px;
  height: 27px;
  flex: none;
  place-items: center;
  color: #71839b;
  background: #eff3f9;
  border-radius: 5px;
  font-size: 11px;
}
.branch-node {
  position: absolute;
  z-index: 2;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  justify-content: space-between;
  padding: 12px;
  gap: 8px;
  transform: translate(-50%, -50%);
  color: #3b5575;
  background: #fff;
  border: 1.5px solid #c8d5e5;
  border-radius: 16px;
  box-shadow: 0 3px 7px rgba(35, 67, 105, 0.06);
  cursor: pointer;
  box-sizing: border-box;
}
.branch-node:hover:not(:disabled) {
  box-shadow: 0 4px 12px rgba(35, 67, 105, 0.12);
}
.branch-node__heading {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.branch-node__icon {
  display: grid;
  place-items: center;
  flex: none;
  width: 36px;
  height: 36px;
  border-radius: 10px;
  color: #4378c8;
  background: #edf4ff;
}
.branch-node[data-stage='INFORMATION_EXTRACTION'] .branch-node__icon {
  color: #9363cf;
  background: #f3edfc;
}
.branch-node[data-stage='PROMPT_GENERATION'] .branch-node__icon {
  color: #6b69c6;
  background: #f0effc;
}
.branch-node[data-stage='SEGMENT_RENDER'] .branch-node__icon {
  color: #278e9a;
  background: #e9f7f8;
}
.branch-node[data-stage='MIX_PACKAGING'] .branch-node__icon {
  color: #9465b9;
  background: #f5edf9;
}
.branch-node[data-stage='FINAL_OUTPUT'] .branch-node__icon {
  color: #278c76;
  background: #e8f7f1;
}
.branch-node__identity {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}
.branch-node__identity small {
  font-size: 10px;
  font-weight: 500;
  color: #8391a5;
  white-space: nowrap;
}
.branch-node__footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 3px;
  min-height: 12px;
}
.branch-node strong {
  max-width: 100%;
  font-size: 15px;
  line-height: 1.15;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: left;
}
.branch-node__created-at {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 100%;
  color: #73859c;
  font-size: 10px;
  white-space: nowrap;
}
.branch-node--active {
  color: #b72437;
  background: #fff;
  border-color: #df3547;
  box-shadow: 0 2px 6px rgba(211, 47, 63, 0.08);
}
.branch-node--current {
  box-shadow:
    0 0 0 3px rgba(223, 53, 71, 0.1),
    0 2px 6px rgba(211, 47, 63, 0.08);
}
.branch-node.branch-node--stale {
  color: #8a7600;
  border-width: 1px;
  border-color: #e0c200;
  background: #fff;
  box-shadow: 0 3px 10px rgba(200, 175, 0, 0.08);
}
.branch-node.branch-node--stale.branch-node--active {
  color: #b91c1c;
  border-width: 2px;
  border-color: transparent;
  background:
    linear-gradient(#fff, #fff) padding-box,
    linear-gradient(112deg, #dc2626 0%, #dc2626 40%, #e0c200 100%) border-box;
  box-shadow: 0 2px 6px rgba(185, 28, 28, 0.08);
}
.branch-node__current {
  padding: 1px 6px;
  color: #bd3344;
  background: #ffecef;
  border-radius: 4px;
  font-size: 9px;
  font-weight: 600;
  line-height: 1.2;
}
.branch-node__stale {
  color: #8a7600;
  background: #fff4bc;
  padding: 1px 5px;
  border-radius: 4px;
  font-size: 10px;
  font-weight: 700;
}
.branch-node:disabled {
  cursor: wait;
}
.branch-switching {
  color: #2563eb;
  font-size: 12px;
  font-weight: 700;
}
.branch-switching--error {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: #c33342;
}
.branch-switching--error button {
  padding: 3px 8px;
  color: #2563eb;
  background: #fff;
  border: 1px solid #c8d7f2;
  border-radius: 6px;
  cursor: pointer;
}
.branch-close:focus-visible,
.branch-view-controls button:focus-visible,
.branch-node:focus-visible {
  outline: 2px solid #2563eb;
  outline-offset: 2px;
}
@media (max-width: 1080px) {
  .branch-toolbar {
    flex-wrap: wrap;
    gap: 8px 12px;
  }
  .branch-toolbar__legend {
    gap: 10px;
  }
}
@media (max-width: 760px) {
  .branch-header {
    padding: 15px;
  }
  .branch-header h2 {
    font-size: 21px;
  }
  .branch-toolbar {
    align-items: center;
    padding: 9px 14px;
  }
  .branch-header__icon {
    display: none;
  }
  .branch-header p {
    font-size: 11px;
  }
  .branch-scroll {
    padding: 0;
  }
  .branch-axis-rail {
    width: 156px;
    flex-basis: 156px;
  }
  .branch-axis {
    padding: 0 8px;
    font-size: 11px;
  }
  .branch-axis-mix-group {
    grid-template-columns: 73px minmax(0, 1fr);
  }
  .branch-axis-mix-group__parent {
    padding: 0 8px;
    gap: 5px;
    font-size: 11px;
  }
  .branch-axis-mix-group__row {
    padding: 0 8px;
    font-size: 10px;
  }
}
@media (max-width: 420px) {
  .branch-toolbar {
    gap: 10px;
  }
  .branch-toolbar__legend {
    font-size: 10px;
    gap: 9px;
  }
  .branch-view-controls {
    bottom: 12px;
  }
  .branch-view-controls button {
    padding: 0 6px;
    font-size: 11px;
    gap: 4px;
  }
}
</style>
