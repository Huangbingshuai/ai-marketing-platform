<script setup lang="ts">
import {
  type EffectWorkflowBranch,
  type EffectWorkflowBranchTreeData,
} from '@ai-marketing/contracts';
import { X } from '@lucide/vue';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import {
  BRANCH_TREE_AXIS_WIDTH,
  BRANCH_TREE_STAGES,
  BRANCH_TREE_ROW_GAP,
  BRANCH_TREE_TOP,
  buildEffectBranchLayout,
} from './effect-workflow-branch-layout';

const props = defineProps<{
  tree: EffectWorkflowBranchTreeData | null;
  loading: boolean;
  error: string;
  switching: boolean;
}>();
const emit = defineEmits<{ close: []; retry: []; select: [workflowRunId: string] }>();
const dialog = ref<HTMLElement | null>(null);
const selectedId = ref<string | null>(null);
const selectedNodeKey = ref<string | null>(null);
let returnFocus: HTMLElement | null = null;
let previousBodyOverflow = '';
const viewportWidth = ref(typeof window === 'undefined' ? 1440 : window.innerWidth);
const updateViewportWidth = () => {
  viewportWidth.value = window.innerWidth;
};

const layout = computed(() =>
  buildEffectBranchLayout(
    props.tree?.branches ?? [],
    viewportWidth.value <= 760 ? 132 : BRANCH_TREE_AXIS_WIDTH,
  ),
);
const selected = computed<EffectWorkflowBranch | null>(
  () =>
    props.tree?.branches.find((branch) => branch.workflowRunId === selectedId.value) ??
    props.tree?.branches.find((branch) => branch.isActive) ??
    null,
);
const selectedNode = computed(
  () =>
    layout.value.nodes.find(
      (node) =>
        node.workflowRunId === selected.value?.workflowRunId && node.key === selectedNodeKey.value,
    ) ?? null,
);
const stageName = (stageKey: (typeof BRANCH_TREE_STAGES)[number]['key']) =>
  BRANCH_TREE_STAGES.find((stage) => stage.key === stageKey)?.name ?? stageKey;
const versionText = (revision: number | null, revisions: number[] | undefined, count: number) => {
  const name = (value: number) => `版本${String(value).padStart(2, '0')}`;
  if (revision !== null) return name(revision);
  if (revisions?.length) return revisions.map(name).join(' / ');
  return count > 0 ? '版本未记录' : '尚未生成';
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
  status === 'CONFIRMED' ? `已确认 · ${count} 项` : status === 'STALE' ? '待更新' : '待处理';

watch(
  () => props.tree,
  (tree) => {
    if (!tree) return;
    if (!tree.branches.some((branch) => branch.workflowRunId === selectedId.value)) {
      selectedId.value = tree.activeWorkflowRunId;
      selectedNodeKey.value =
        layout.value.nodes.find(
          (node) =>
            node.workflowRunId === tree.activeWorkflowRunId &&
            node.nodeId === tree.branches.find((branch) => branch.isActive)?.currentNodeId,
        )?.key ?? null;
    }
  },
  { immediate: true },
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
  window.addEventListener('resize', updateViewportWidth);
  await nextTick();
  dialog.value?.focus();
});
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown);
  window.removeEventListener('resize', updateViewportWidth);
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
            <p>从资料导入向下展开各节点版本；分叉直接长在树上，红色标出当前工作流路径。</p>
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
        <div v-if="loading" class="branch-message" role="status">正在加载版本分支…</div>
        <div v-else-if="error" class="branch-message branch-message--error" role="alert">
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
              <span><i class="legend-pending" />待处理阶段</span>
            </div>
          </div>
          <div class="branch-scroll" aria-label="效果类工作流版本树">
            <div
              class="branch-canvas"
              :style="{ minWidth: `${layout.width}px`, height: `${layout.height}px` }"
            >
              <div
                class="branch-graph"
                :style="{ width: `${layout.width}px`, height: `${layout.height}px` }"
              >
                <svg
                  class="branch-lines"
                  :width="layout.width"
                  :height="layout.height"
                  aria-hidden="true"
                >
                  <defs>
                    <marker
                      id="branch-arrow-default"
                      markerUnits="userSpaceOnUse"
                      markerWidth="8"
                      markerHeight="8"
                      refX="8"
                      refY="4"
                      orient="auto"
                    >
                      <path class="branch-arrow-default" d="M 0 0 L 8 4 L 0 8 Z" />
                    </marker>
                    <marker
                      id="branch-arrow-active"
                      markerUnits="userSpaceOnUse"
                      markerWidth="8"
                      markerHeight="8"
                      refX="8"
                      refY="4"
                      orient="auto"
                    >
                      <path class="branch-arrow-active" d="M 0 0 L 8 4 L 0 8 Z" />
                    </marker>
                  </defs>
                  <path
                    v-for="edge in layout.edges"
                    :key="edge.key"
                    :d="edge.path"
                    :marker-end="
                      edge.onActivePath ? 'url(#branch-arrow-active)' : 'url(#branch-arrow-default)'
                    "
                    :class="{
                      'branch-line--active': edge.onActivePath,
                      'branch-line--pending': edge.pending,
                    }"
                  />
                </svg>
                <div class="branch-axis-rail">
                  <div
                    v-for="(stage, index) in BRANCH_TREE_STAGES"
                    :key="`axis:${stage.key}`"
                    class="branch-axis"
                    :class="{ 'branch-axis--mix': stage.nodeId === 'TEMPLATE_MIX' }"
                    :style="{ top: `${BRANCH_TREE_TOP + index * BRANCH_TREE_ROW_GAP}px` }"
                  >
                    <span class="branch-axis__number">{{
                      stage.nodeId === 'TEMPLATE_MIX'
                        ? '05'
                        : String(index < 4 ? index + 1 : 6).padStart(2, '0')
                    }}</span>
                    <span>{{ stage.name }}</span>
                  </div>
                </div>
                <button
                  v-for="node in layout.nodes"
                  :key="node.key"
                  type="button"
                  class="branch-node"
                  :class="{
                    'branch-node--active': node.onActivePath,
                    'branch-node--current': node.isCurrentStage,
                    'branch-node--pending': node.status === 'PENDING',
                    'branch-node--selected': selectedNode?.key === node.key,
                  }"
                  :style="{ left: `${node.x}px`, top: `${node.y}px` }"
                  :aria-label="`${stageName(node.stageKey)}${node.templateName && node.stageKey !== 'MIX_TEMPLATE' ? `，${node.templateName}` : ''}，${node.stageKey === 'MIX_TEMPLATE' ? (node.templateName ?? '尚未创建模板') : versionText(node.revision, node.revisions, node.artifactCount)}，${node.stageKey !== 'MIX_TEMPLATE' && node.artifactCount > 0 ? `${artifactCreatedAtText(node.createdAt)}，` : ''}${statusText(node.status, node.artifactCount)}${node.onActivePath ? '，当前工作流路径' : ''}`"
                  :title="`${stageName(node.stageKey)} · ${node.stageKey === 'MIX_TEMPLATE' ? (node.templateName ?? '尚未创建模板') : versionText(node.revision, node.revisions, node.artifactCount)} · ${statusText(node.status, node.artifactCount)}`"
                  @click="
                    selectedId = node.workflowRunId;
                    selectedNodeKey = node.key;
                  "
                >
                  <strong>{{
                    node.stageKey === 'MIX_TEMPLATE'
                      ? (node.templateName ?? '尚未创建模板')
                      : versionText(node.revision, node.revisions, node.artifactCount)
                  }}</strong>
                  <span
                    v-if="node.stageKey !== 'MIX_TEMPLATE' && node.artifactCount > 0"
                    class="branch-node__created-at"
                    title="已确认工作副本的创建时间；旧 revision 的单独确认时间不可追溯"
                    >{{ artifactCreatedAtText(node.createdAt) }}</span
                  >
                </button>
              </div>
            </div>
          </div>
          <footer v-if="selected" class="branch-footer">
            <div class="branch-footer__selection">
              <span>已选版本</span>
              <strong v-if="selectedNode"
                >{{ stageName(selectedNode.stageKey) }} ·
                {{
                  selectedNode.stageKey === 'MIX_TEMPLATE'
                    ? (selectedNode.templateName ?? '尚未创建模板')
                    : versionText(
                        selectedNode.revision,
                        selectedNode.revisions,
                        selectedNode.artifactCount,
                      )
                }}</strong
              >
              <span v-if="selectedNode"
                >· {{ statusText(selectedNode.status, selectedNode.artifactCount) }}</span
              >
            </div>
            <button
              type="button"
              class="branch-activate"
              :disabled="selected.isActive || switching"
              @click="emit('select', selected.workflowRunId)"
            >
              {{ switching ? '正在切换…' : selected.isActive ? '正在使用此分支' : '切换到此分支' }}
            </button>
          </footer>
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
.legend-pending {
  background: #fff;
  border: 1px dashed #aab8ca;
}
.branch-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
  background: #fff;
}
.branch-canvas {
  position: relative;
  width: 100%;
  box-sizing: border-box;
  background:
    radial-gradient(circle at 24px 24px, #edf2f9 1px, transparent 1.3px) 0 0 / 24px 24px,
    #fff;
  border: 0;
}
.branch-graph {
  position: relative;
  margin: 0 auto;
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
.branch-lines path.branch-line--pending {
  stroke-dasharray: 5 5;
}
.branch-lines path.branch-line--active {
  stroke: #df3547;
  stroke-width: 3.5;
}
.branch-lines .branch-arrow-default {
  fill: #b2c1d5;
  stroke: none;
}
.branch-lines .branch-arrow-active {
  fill: #df3547;
  stroke: none;
}
.branch-axis-rail {
  position: sticky;
  left: 0;
  z-index: 3;
  width: 178px;
  height: 100%;
  pointer-events: none;
  background: linear-gradient(90deg, #fff 88%, rgba(255, 255, 255, 0));
}
.branch-axis {
  position: absolute;
  left: 10px;
  display: flex;
  align-items: center;
  width: 154px;
  height: 62px;
  transform: translateY(-50%);
  gap: 9px;
  color: #52647e;
  font-size: 13px;
  font-weight: 700;
  box-sizing: border-box;
}
.branch-axis--mix {
  padding-left: 16px;
  font-size: 12px;
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
.branch-axis--mix .branch-axis__number {
  width: 21px;
  height: 21px;
  font-size: 10px;
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
.branch-node--pending {
  border-style: dashed;
  color: #7d8ba0;
  background: #fbfcff;
}
.branch-node--selected {
  outline: 3px solid rgba(46, 101, 221, 0.24);
  outline-offset: 4px;
}
.branch-node--active.branch-node--selected {
  outline-color: rgba(220, 53, 69, 0.3);
}
.branch-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 68px;
  padding: 10px 24px;
  gap: 18px;
  background: #fff;
  border-top: 1px solid #dde6f2;
}
.branch-footer__selection {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 7px;
  color: #6b7c93;
  font-size: 12px;
}
.branch-footer__selection strong {
  color: #233755;
  font-size: 14px;
}
.branch-activate {
  min-width: 150px;
  padding: 10px 16px;
  color: #fff;
  background: #2563eb;
  border: 0;
  border-radius: 10px;
  font-weight: 700;
  cursor: pointer;
  white-space: nowrap;
}
.branch-activate:disabled {
  color: #8895aa;
  background: #edf1f7;
  cursor: default;
}
.branch-close:focus-visible,
.branch-node:focus-visible,
.branch-activate:focus-visible {
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
    width: 137px;
  }
  .branch-axis {
    width: 126px;
    font-size: 11px;
  }
  .branch-footer {
    align-items: stretch;
    flex-direction: column;
    padding: 10px 14px;
    gap: 8px;
  }
  .branch-activate {
    width: 100%;
  }
}
</style>
