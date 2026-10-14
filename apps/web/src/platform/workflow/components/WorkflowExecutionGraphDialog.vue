<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch, useId } from 'vue';
import { AlertCircle, CheckCircle2, LoaderCircle, Sparkles, X } from '@lucide/vue';
export type ExecutionGraphNode = {
  id: string;
  label: string;
  description: string;
  tone: string;
  statusLabel: string;
};
const props = defineProps<{
  open: boolean;
  title: string;
  eyebrow: string;
  description: string;
  rows: string[][];
  nodes: ExecutionGraphNode[];
  rowTitles?: string[];
  edges?: { from: string; to: string; label?: string; muted?: boolean }[] | undefined;
  selected: string | null;
  edgeCount?: number;
  loading?: boolean;
  error?: string;
  emptyMessage?: string | undefined;
}>();
const emit = defineEmits<{ close: []; select: [id: string] }>();
const panel = ref<HTMLElement | null>(null),
  closeButton = ref<HTMLButtonElement | null>(null);
const titleId = useId();
const canvas = ref<HTMLElement | null>(null);
const paths = ref<{ d: string; label: string; x: number; y: number; muted: boolean }[]>([]);
let observer: ResizeObserver | undefined;
function measureEdges() {
  if (!canvas.value || !props.edges) {
    paths.value = [];
    return;
  }
  const rect = canvas.value.getBoundingClientRect();
  const buttons = [...canvas.value.querySelectorAll<HTMLElement>('[data-node-id]')];
  paths.value = props.edges.flatMap((edge) => {
    const from = buttons.find((b) => b.dataset.nodeId === edge.from)?.getBoundingClientRect();
    const to = buttons.find((b) => b.dataset.nodeId === edge.to)?.getBoundingClientRect();
    if (!from || !to) return [];
    const x = from.left + from.width / 2 - rect.left,
      y = from.bottom - rect.top;
    const tx = to.left + to.width / 2 - rect.left,
      ty = to.top - rect.top;
    const bend = y + Math.min(18, (ty - y) / 2);
    const side = Math.max(from.right, to.right) - rect.left + 12;
    return [
      {
        d:
          ty - y > 100
            ? `M ${x} ${y} V ${bend} H ${side} V ${ty - 14} H ${tx} V ${ty}`
            : `M ${x} ${y} V ${bend} H ${tx} V ${ty}`,
        label: edge.label ?? '',
        x: ty - y > 100 ? side - 26 : (x + tx) / 2,
        y: ty - y > 100 ? (y + ty) / 2 : bend - 4,
        muted: !!edge.muted,
      },
    ];
  });
}
watch(
  [() => props.open, () => props.rows, () => props.edges],
  async () => {
    await nextTick();
    observer?.disconnect();
    if (canvas.value && props.edges) {
      observer = new ResizeObserver(measureEdges);
      observer.observe(canvas.value);
    }
    measureEdges();
  },
  { immediate: true },
);
let trigger: HTMLElement | null = null;
const node = (id: string) => props.nodes.find((n) => n.id === id)!;
function keydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault();
    emit('close');
  }
  if (event.key === 'Tab') {
    const controls = [
      ...(panel.value?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), select:not(:disabled), a[href], summary, [tabindex="0"]',
      ) ?? []),
    ].filter((el) => el.getClientRects().length);
    const first = controls[0],
      last = controls.at(-1);
    if (
      event.shiftKey &&
      (document.activeElement === first || !panel.value?.contains(document.activeElement))
    ) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  }
  if (
    ['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft'].includes(event.key) &&
    (event.target as HTMLElement)?.classList.contains('graph-node')
  ) {
    const buttons = [...(panel.value?.querySelectorAll<HTMLButtonElement>('.graph-node') ?? [])];
    const index = buttons.indexOf(event.target as HTMLButtonElement),
      delta = ['ArrowDown', 'ArrowRight'].includes(event.key) ? 1 : -1;
    event.preventDefault();
    buttons[(index + delta + buttons.length) % buttons.length]?.focus();
  }
}
watch(
  () => props.open,
  async (open) => {
    if (open) {
      trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      await nextTick();
      closeButton.value?.focus();
    } else {
      if (trigger?.isConnected) trigger.focus();
      trigger = null;
    }
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  observer?.disconnect();
  if (props.open && trigger?.isConnected) trigger.focus();
});
</script>
<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="workflow-execution-graph prompt-dialog-backdrop"
      @mousedown.self="emit('close')"
    >
      <section
        ref="panel"
        class="workflow-graph-dialog"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="titleId"
        tabindex="-1"
        @keydown="keydown"
      >
        <header>
          <div class="graph-title-group">
            <span>{{ eyebrow }}</span>
            <h2 :id="titleId">{{ title }}</h2>
            <p>{{ description }}</p>
          </div>
          <div class="graph-header-actions">
            <button
              ref="closeButton"
              class="graph-close-button"
              type="button"
              aria-label="关闭工作流"
              @click="emit('close')"
            >
              <X :size="17" />
            </button>
          </div>
        </header>
        <div v-if="loading" class="graph-message">
          <LoaderCircle class="spin" :size="14" />正在恢复节点进度…
        </div>
        <div v-if="error" class="graph-message error" role="alert">
          <AlertCircle :size="14" />{{ error }}
        </div>
        <div v-if="emptyMessage" class="graph-version-notice">
          <Sparkles :size="15" /><span>{{ emptyMessage }}</span>
        </div>
        <slot name="toolbar" />
        <div class="workflow-graph-content">
          <div class="workflow-graph-scroll">
            <div
              ref="canvas"
              class="workflow-graph-canvas"
              :class="{ 'has-explicit-edges': edges }"
            >
              <svg v-if="edges" class="graph-explicit-edges" aria-hidden="true">
                <defs>
                  <marker
                    :id="`${titleId}-arrow`"
                    markerWidth="6"
                    markerHeight="6"
                    refX="5"
                    refY="3"
                    orient="auto"
                  >
                    <path d="M0,0 L6,3 L0,6" fill="currentColor" />
                  </marker>
                </defs>
                <g v-for="(edge, i) in paths" :key="i" :class="{ muted: edge.muted }">
                  <path :d="edge.d" :marker-end="`url(#${titleId}-arrow)`" />
                  <text :x="edge.x" :y="edge.y" text-anchor="middle">{{ edge.label }}</text>
                </g>
              </svg>
              <template v-for="(row, index) in rows" :key="index"
                ><div v-if="index && !edges" class="graph-connector"><i /></div>
                <p v-if="rowTitles?.[index]" class="graph-row-title">{{ rowTitles[index] }}</p>
                <div
                  class="graph-row"
                  :class="{ parallel: row.length > 1, 'six-branch': row.length === 6 }"
                  :style="
                    edges && row.length > 1
                      ? { gridTemplateColumns: `repeat(${row.length}, minmax(150px, 1fr))` }
                      : undefined
                  "
                >
                  <button
                    v-for="id in row"
                    :key="id"
                    class="graph-node"
                    :data-node-id="id"
                    :class="`is-${node(id).tone}`"
                    type="button"
                    :aria-pressed="selected === id"
                    @click="emit('select', id)"
                  >
                    <span class="node-dot" /><span
                      ><strong>{{ node(id).label }}</strong
                      ><small>{{ node(id).description }}</small></span
                    ><em>{{ node(id).statusLabel }}</em>
                  </button>
                </div></template
              >
            </div>
          </div>
          <aside class="workflow-node-detail" aria-live="polite"><slot /></aside>
        </div>
        <footer>
          <span><i class="running" />执行中</span><span><i class="success" />已完成</span
          ><span><i class="warning" />需关注</span><span><i class="danger" />失败</span
          ><span v-if="edgeCount !== undefined" class="edge-count">{{ edgeCount }} 条执行边</span
          ><button type="button" @click="emit('close')">
            <CheckCircle2 :size="14" />返回工作区
          </button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>
<style src="./workflow-execution-graph.css"></style>

<style scoped>
.workflow-graph-scroll {
  min-width: 0;
  overflow: auto;
}
.has-explicit-edges {
  position: relative;
}
.has-explicit-edges:has(.parallel) {
  min-width: 720px;
}
.has-explicit-edges .graph-row {
  position: relative;
  margin-bottom: 32px;
}
.has-explicit-edges .graph-node.is-unselected {
  opacity: 0.55;
}
.graph-explicit-edges {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  color: #8ba9d4;
  overflow: visible;
}
.graph-explicit-edges g > path {
  fill: none;
  stroke: currentColor;
  stroke-width: 1.5;
}
.graph-explicit-edges text {
  fill: #61738c;
  font-size: 10px;
}
.graph-explicit-edges .muted {
  opacity: 0.35;
}
</style>
