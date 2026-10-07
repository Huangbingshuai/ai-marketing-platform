<script setup lang="ts">
import { type EffectWorkflowBranchTreeData } from '@ai-marketing/contracts';
import { X } from '@lucide/vue';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { effectBranchDestination, type EffectBranchNavigation } from '../../shared/effect-branch-navigation';

import {
  BRANCH_TREE_AXIS_WIDTH,
  BRANCH_TREE_ROOT_TOP,
  BRANCH_TREE_STAGES,
  BRANCH_TREE_ROW_GAP,
  BRANCH_TREE_TOP,
  buildEffectBranchLayout,
  type BranchTreeNode,
} from './effect-workflow-branch-layout';

const props = defineProps<{
  projectName: string;
  tree: EffectWorkflowBranchTreeData | null;
  loading: boolean;
  error: string;
  switching: boolean;
  forkDisabled: boolean;
  activeTemplateId: string | null;
  viewedWorkflowRunId?: string | null;
}>();
const emit = defineEmits<{
  close: [];
  retry: [];
  select: [destination: Omit<EffectBranchNavigation, 'projectId'>];
  fork: [];
}>();
const dialog = ref<HTMLElement | null>(null);
const scrollContainer = ref<HTMLElement | null>(null);
const graphElement = ref<HTMLElement | null>(null);
let returnFocus: HTMLElement | null = null;
let previousBodyOverflow = '';
const layout = computed(() =>
  buildEffectBranchLayout(props.tree?.branches ?? [], props.activeTemplateId, props.viewedWorkflowRunId),
);
const mixStartIndex = BRANCH_TREE_STAGES.findIndex((stage) => stage.nodeId === 'TEMPLATE_MIX');
const mixStages = BRANCH_TREE_STAGES.filter((stage) => stage.nodeId === 'TEMPLATE_MIX');
const stageName = (stageKey: (typeof BRANCH_TREE_STAGES)[number]['key']) =>
  BRANCH_TREE_STAGES.find((stage) => stage.key === stageKey)?.name ?? stageKey;
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
const statusText = (status: string, count: number) =>
  status === 'CONFIRMED'
    ? `已确认 · ${count} 项`
    : status === 'STALE'
      ? '待更新'
      : count > 0
        ? '待校验'
        : '待处理';
const nodeStatusText = (node: BranchTreeNode) =>
  node.stageKey === 'MIX_TEMPLATE' && node.status === 'PENDING'
    ? '模板已创建'
    : node.stageKey === 'MIX_FILL' && node.status === 'STALE' && !node.showStaleWarning
      ? `已填充 · ${node.artifactCount} 项`
      : statusText(node.status, node.artifactCount);

const selectNode = (node: BranchTreeNode) => {
  if (!props.switching && !props.loading && !props.error)
    emit('select', effectBranchDestination(node));
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
    layout.value.root.x;
  const visibleTreeCenter = axisWidth + (scroll.clientWidth - axisWidth) / 2;
  scroll.scrollLeft = Math.max(0, graphCenter - visibleTreeCenter);
};
const onViewportResize = () => void centerTree();
watch(
  () => props.tree,
  () => void centerTree(),
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
  await centerTree();
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
          <div>
            <span class="branch-eyebrow">EFFECT WORKFLOW</span>
            <h2 id="branch-title">版本分支树</h2>
            <p>
              从项目向下展开各节点版本；分叉直接长在树上，红色标出当前工作流路径。点击其他分支的版本即可切换。
            </p>
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
        <div v-if="loading && !tree" class="branch-message" role="status">正在加载版本分支…</div>
        <div v-else-if="error && !tree" class="branch-message branch-message--error" role="alert">
          <span>{{ error }}</span
          ><button type="button" @click="emit('retry')">重试</button>
        </div>
        <div v-else-if="!layout.nodes.length" class="branch-message">
          当前项目还没有已建立的效果类工作流分支。
        </div>
        <template v-else>
          <div class="branch-toolbar">
            <div class="branch-toolbar__legend">
              <span><i class="legend-current" />当前工作流路径</span>
              <span><i class="legend-other" />其他版本</span>
              <span><i class="legend-stale" />待更新</span>
            </div>
            <button type="button" class="branch-copy-button"
              :disabled="switching || loading || Boolean(error) || forkDisabled || !tree?.activeWorkflowRunId"
              :title="forkDisabled ? '请先保存或取消当前编辑' : '复制当前分支的已确认内容'"
              @click="emit('fork')">从当前分支新建分支</button>
            <span v-if="switching" class="branch-switching" role="status">正在切换分支…</span>
            <span v-else-if="loading" class="branch-switching" role="status">正在同步最新分支…</span>
            <span v-else-if="error" class="branch-switching branch-switching--error" role="alert">
              更新失败，当前显示上次结果
              <button type="button" @click="emit('retry')">重试</button>
            </span>
          </div>
          <div
            ref="scrollContainer"
            class="branch-scroll"
            aria-label="效果类工作流版本树"
            :aria-busy="switching || loading"
          >
            <div
              class="branch-canvas"
              :style="{
                minWidth: `${layout.width + BRANCH_TREE_AXIS_WIDTH}px`,
                height: `${layout.height}px`,
              }"
            >
              <div
                v-for="(stage, index) in BRANCH_TREE_STAGES"
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
                <template v-for="(stage, index) in BRANCH_TREE_STAGES" :key="`axis:${stage.key}`">
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
                      String(index < mixStartIndex ? index + 1 : 6).padStart(2, '0')
                    }}</span>
                    <span>{{ stage.name }}</span>
                  </div>
                </template>
                <div
                  class="branch-axis-mix-group"
                  role="group"
                  aria-label="混剪：混剪模板、智能填充、智能成片包装"
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
                    <path :d="edge.arrowPath" class="branch-arrow"
                      :class="{ 'branch-arrow--active': edge.onActivePath }" />
                  </g>
                </svg>
                <div
                  class="branch-project-root"
                  :class="{ 'branch-project-root--active': tree?.activeWorkflowRunId }"
                  :style="{ left: `${layout.root.x}px`, top: `${layout.root.y}px` }"
                  :aria-label="`项目：${projectName}`"
                >
                  {{ projectName }}
                </div>
                <button
                  v-for="node in layout.nodes"
                  :key="node.key"
                  type="button"
                  class="branch-node"
                  :class="{
                    'branch-node--active': node.onActivePath,
                    'branch-node--current': node.isCurrentStage,
                    'branch-node--stale': node.showStaleWarning,
                  }"
                  :disabled="switching || loading || Boolean(error)"
                  :style="{ left: `${node.x}px`, top: `${node.y}px` }"
                  :aria-label="`${stageName(node.stageKey)}${node.templateName && node.stageKey !== 'MIX_TEMPLATE' ? `，${node.templateName}` : ''}，${node.stageKey === 'MIX_TEMPLATE' ? (node.templateName ?? '模板') : versionText(node.revision, node.revisions, node.artifactCount, node.status)}，${node.stageKey === 'MIX_TEMPLATE' || (node.artifactCount > 0 && node.status !== 'PENDING') ? `${artifactCreatedAtText(node.createdAt)}，` : ''}${nodeStatusText(node)}${node.onActivePath ? '，当前工作流路径' : ''}`"
                  :title="`${stageName(node.stageKey)} · ${node.stageKey === 'MIX_TEMPLATE' ? (node.templateName ?? '模板') : versionText(node.revision, node.revisions, node.artifactCount, node.status)} · ${nodeStatusText(node)}`"
                  @click="selectNode(node)"
                >
                  <strong>{{
                    node.stageKey === 'MIX_TEMPLATE'
                      ? (node.templateName ?? '模板')
                      : versionText(node.revision, node.revisions, node.artifactCount, node.status)
                  }}</strong>
                  <span
                    v-if="
                      node.stageKey === 'MIX_TEMPLATE' ||
                      (node.artifactCount > 0 && node.status !== 'PENDING')
                    "
                    class="branch-node__created-at"
                    :title="
                      node.stageKey === 'MIX_TEMPLATE'
                        ? '模板创建时间；旧草稿可能未记录'
                        : '已确认工作副本的创建时间；旧 revision 的单独确认时间不可追溯'
                    "
                  >{{ artifactCreatedAtText(node.createdAt) }}</span
                  >
                  <span v-if="node.showStaleWarning" class="branch-node__stale">待更新</span>
                </button>
              </div>
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
  padding: 22px 32px;
  gap: 16px;
  background: #fff;
  border-bottom: 1px solid #dfe7f4;
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
  font-size: 25px;
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
  min-height: 54px;
  padding: 7px 24px;
  gap: 16px;
  background: #fff;
  border-bottom: 1px solid #e1e7f2;
}
.branch-toolbar__legend {
  display: flex;
  flex-wrap: wrap;
  gap: 18px;
  color: #697991;
  font-size: 12px;
}
.branch-copy-button {
  margin-left: auto;
  padding: 9px 14px;
  color: #1d4ed8;
  background: #eff5ff;
  border: 1px solid #bcd0ff;
  border-radius: 9px;
  font-weight: 700;
  cursor: pointer;
}
.branch-copy-button:disabled { color: #9aa8bd; background: #f4f6fa; cursor: not-allowed; }
.branch-toolbar__legend span {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.branch-toolbar__legend i {
  display: inline-block;
  width: 11px;
  height: 11px;
  border-radius: 50%;
}
.legend-current {
  background: #dc3545;
}
.legend-other {
  background: #a2b3cd;
}
.legend-stale { background: #f59e0b; }
.branch-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
  background: #fff;
}
.branch-canvas {
  position: relative;
  display: flex;
  width: 100%;
  box-sizing: border-box;
  background:
    radial-gradient(circle at 24px 24px, #edf2f9 1px, transparent 1.3px) 0 0 / 24px 24px,
    #fff;
  border: 0;
}
.branch-stage-band {
  position: absolute;
  right: 0;
  left: 0;
  background: rgba(250, 252, 255, 0.78);
  border-top: 1px solid #edf1f7;
  box-sizing: border-box;
  pointer-events: none;
}
.branch-stage-band--alternate {
  background: rgba(242, 246, 252, 0.78);
}
.branch-graph {
  position: relative;
  flex: 0 0 auto;
  margin: 0 auto;
}
.branch-project-root {
  position: absolute;
  z-index: 2;
  display: grid;
  width: 240px;
  height: 72px;
  padding: 8px 12px;
  transform: translate(-50%, -50%);
  place-items: center;
  color: #253755;
  background: #fff;
  border: 2px solid #9eb4cf;
  border-radius: 8px;
  box-shadow: 0 5px 15px rgba(35, 67, 105, 0.12);
  box-sizing: border-box;
  font-size: 14px;
  font-weight: 800;
  overflow-wrap: anywhere;
  text-align: center;
}
.branch-project-root--active {
  color: #b72437;
  background: #fff5f5;
  border-color: #df3547;
}
.branch-lines {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
.branch-lines path {
  fill: none;
  stroke: #b2c1d5;
  stroke-width: 2.5;
  stroke-linecap: round;
}
.branch-lines path.branch-line--active {
  stroke: #df3547;
  stroke-width: 3.5;
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
  background: #fafcff;
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
  background: #f2f6fc;
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
  background: #e8f0fc;
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
  background: #f2f6fc;
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
  align-items: center;
  justify-content: center;
  width: 128px;
  height: 72px;
  padding: 4px 8px;
  gap: 2px;
  transform: translate(-50%, -50%);
  color: #3b5575;
  background: #fff;
  border: 2px solid #9eb4cf;
  border-radius: 8px;
  box-shadow: 0 5px 15px rgba(35, 67, 105, 0.12);
  cursor: pointer;
  box-sizing: border-box;
}
.branch-node strong {
  max-width: 100%;
  font-size: 14px;
  line-height: 1.15;
  overflow-wrap: anywhere;
  text-align: center;
}
.branch-node__created-at {
  display: block;
  max-width: 100%;
  color: #73859c;
  font-size: 9px;
  white-space: nowrap;
}
.branch-node--active {
  color: #b72437;
  background: #fff5f5;
  border-color: #df3547;
  box-shadow: 0 5px 18px rgba(211, 47, 63, 0.2);
}
.branch-node--current {
  box-shadow:
    0 0 0 5px rgba(223, 53, 71, 0.14),
    0 5px 18px rgba(211, 47, 63, 0.2);
}
.branch-node--stale {
  border-color: #f59e0b;
  background: #fffaf0;
  box-shadow: 0 0 0 3px rgba(245, 158, 11, 0.18), 0 5px 15px rgba(146, 92, 12, 0.12);
}
.branch-node__stale {
  color: #b45309;
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
.branch-node:focus-visible {
  outline: 2px solid #2563eb;
  outline-offset: 2px;
}
@media (max-width: 760px) {
  .branch-header {
    padding: 15px;
  }
  .branch-header h2 {
    font-size: 21px;
  }
  .branch-toolbar {
    align-items: flex-start;
    flex-direction: column;
    padding: 9px 14px;
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
</style>
