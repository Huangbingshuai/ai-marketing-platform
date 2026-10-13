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
          <div class="workflow-graph-canvas">
            <template v-for="(row, index) in rows" :key="index"
              ><div v-if="index" class="graph-connector"><i /></div>
              <p v-if="rowTitles?.[index]" class="graph-row-title">{{ rowTitles[index] }}</p>
              <div
                class="graph-row"
                :class="{ parallel: row.length > 1, 'six-branch': row.length === 6 }"
              >
                <button
                  v-for="id in row"
                  :key="id"
                  class="graph-node"
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
