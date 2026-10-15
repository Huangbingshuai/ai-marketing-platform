<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { AlertCircle, FileText, Link2, LoaderCircle, RefreshCw, Workflow, X } from '@lucide/vue';
import type {
  ExtractionGraphNode,
  ExtractionNodeDetail,
  ExtractionStepExecution,
  ExtractionStepStatus,
} from '@ai-marketing/contracts';
const props = defineProps<{
  open: boolean;
  title: string;
  subtitle: string;
  eyebrow?: string;
  graphLabel?: string;
  refreshable?: boolean;
  nodes: readonly ExtractionGraphNode[];
  executions: readonly ExtractionStepExecution[];
  selectedNodeId: string | null;
  detail: ExtractionNodeDetail | null;
  loading?: boolean;
  error?: string;
  detailLoading?: boolean;
  detailError?: string;
}>();
const emit = defineEmits<{ close: []; select: [nodeId: string]; refresh: []; retry: [] }>();
const graphPanel = ref<HTMLElement | null>(null);
const graphCloseButton = ref<HTMLButtonElement | null>(null);
const failedGraphPreviewUrls = ref(new Set<string>());
let returnFocus: HTMLElement | null = null;
const graphDetail = computed(() => props.detail);
const graphDetailLoading = computed(() => props.detailLoading);
const graphDetailError = computed(() => props.detailError);
const selectedGraphNodeId = computed(() => props.selectedNodeId);
const rows = computed(() => {
  const result: ExtractionGraphNode[][] = [];
  for (const node of props.nodes) {
    if (result.at(-1)?.[0]?.group === node.group) result.at(-1)!.push(node);
    else result.push([node]);
  }
  return result;
});
const graphNodeDefinition = (id: string) => props.nodes.find((n) => n.id === id)!;
const graphExecution = (id: string): ExtractionStepExecution =>
  props.executions.find((n) => n.nodeId === id) ?? {
    nodeId: id,
    status: 'PENDING',
    warnings: [],
    errorMessage: null,
  };
const graphStatusMeta = (status: ExtractionStepStatus) =>
  ({
    PENDING: { label: '等待中', tone: 'pending' },
    RUNNING: { label: '执行中', tone: 'running' },
    SUCCEEDED: { label: '已完成', tone: 'success' },
    PARTIAL: { label: '部分完成', tone: 'warning' },
    SKIPPED: { label: '已跳过', tone: 'skipped' },
    FAILED: { label: '失败', tone: 'danger' },
  })[status];
const graphDetailValue = (value: ExtractionNodeDetail['fields'][number]['value']) =>
  Array.isArray(value)
    ? value.join('、') || '—'
    : typeof value === 'boolean'
      ? value
        ? '是'
        : '否'
      : value === null || value === ''
        ? '—'
        : String(value);
const graphDetailBytes = (v: number | null) =>
  v === null
    ? '—'
    : v < 1048576
      ? `${Math.max(1, Math.round(v / 1024))} KB`
      : `${(v / 1048576).toFixed(1)} MB`;
const graphDetailExtension = (name: string) =>
  name.split('.').at(-1)?.slice(0, 5).toUpperCase() || 'FILE';
const graphPreviewUrl = (source: ExtractionNodeDetail['sources'][number]) =>
  source.media?.previewUrl && !failedGraphPreviewUrls.value.has(source.media.previewUrl)
    ? source.media.previewUrl
    : null;
const markGraphPreviewFailed = (url: string) => failedGraphPreviewUrls.value.add(url);
const refreshGraphDetail = () => emit('refresh');
const close = () => emit('close');
const keydown = (event: KeyboardEvent) => {
  if (event.key === 'Escape') {
    event.stopPropagation();
    close();
  }
  if (event.key !== 'Tab') return;
  const all = Array.from(
    graphPanel.value?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], [tabindex="0"]',
    ) ?? [],
  );
  const first = all[0],
    last = all.at(-1);
  if (!first || !last) return;
  if (
    !all.includes(document.activeElement as HTMLElement) ||
    (event.shiftKey && document.activeElement === first) ||
    (!event.shiftKey && document.activeElement === last)
  ) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  }
};
watch(
  () => props.open,
  async (open) => {
    if (open) {
      returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      failedGraphPreviewUrls.value = new Set();
      await nextTick();
      graphCloseButton.value?.focus();
    } else {
      await nextTick();
      returnFocus?.focus();
    }
  },
);
onBeforeUnmount(() => {
  if (props.open) returnFocus?.focus();
});
</script>
<template>
  <Teleport to="body"
    ><div v-if="open" class="workflow-graph-backdrop" @mousedown.self="close">
      <section
        ref="graphPanel"
        class="workflow-graph-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="extraction-graph-title"
        tabindex="-1"
        @keydown="keydown"
      >
        <header class="workflow-graph-dialog__header">
          <div>
            <span class="workflow-graph-dialog__eyebrow">{{ eyebrow ?? '实时执行状态' }}</span>
            <h3 id="extraction-graph-title">{{ title }}</h3>
            <p>{{ subtitle }}</p>
          </div>
          <button ref="graphCloseButton" type="button" aria-label="关闭工作流详情" @click="close">
            <X :size="18" />
          </button>
        </header>
        <div v-if="error" class="workflow-graph-dialog__error" role="alert">
          <AlertCircle :size="16" /><span>{{ error }}</span
          ><button type="button" @click="emit('retry')"><RefreshCw :size="13" />重试</button>
        </div>
        <div v-else-if="loading" class="workflow-graph-dialog__loading" role="status">
          <LoaderCircle class="spin" :size="16" />正在同步节点状态…
        </div>
        <div class="workflow-graph-content">
          <div class="workflow-graph-canvas" :aria-label="graphLabel ?? 'AI 信息提炼节点执行图'">
            <template v-for="(row, index) in rows" :key="row[0]!.id">
              <div
                v-if="index"
                class="workflow-graph-connector"
                :class="{ 'workflow-graph-connector--join': rows[index - 1]!.length > 1 }"
                aria-hidden="true"
              >
                <i />
              </div>
              <div :class="{ 'workflow-graph-parallel': row.length > 1 }">
                <article
                  v-for="node in row"
                  :key="node.id"
                  class="workflow-graph-node"
                  :class="[
                    `is-${graphStatusMeta(graphExecution(node.id).status).tone}`,
                    { 'workflow-graph-node--single': row.length === 1 },
                  ]"
                  role="button"
                  tabindex="0"
                  :aria-pressed="selectedNodeId === node.id"
                  @click="emit('select', node.id)"
                  @keydown.enter.prevent="emit('select', node.id)"
                  @keydown.space.prevent="emit('select', node.id)"
                >
                  <div class="workflow-graph-node__heading">
                    <span v-if="index === 0" class="workflow-graph-node__icon"
                      ><FileText :size="17" /></span
                    ><span v-else class="workflow-graph-node__status-dot" aria-hidden="true" />
                    <div>
                      <strong>{{ node.label }}</strong
                      ><small>{{ node.description }}</small>
                    </div>
                    <em>{{ graphStatusMeta(graphExecution(node.id).status).label }}</em>
                  </div>
                  <p v-if="graphExecution(node.id).warnings.length" class="node-warning">
                    <AlertCircle :size="12" /><span
                      >有 {{ graphExecution(node.id).warnings.length }} 项提示，点击查看详情</span
                    >
                  </p>
                  <p v-if="graphExecution(node.id).errorMessage" class="node-error">
                    {{ graphExecution(node.id).errorMessage }}
                  </p>
                </article>
              </div></template
            >
          </div>
          <aside class="workflow-node-detail" aria-live="polite">
            <div v-if="!selectedGraphNodeId" class="workflow-node-detail__empty">
              <Workflow :size="24" />
              <strong>点击节点查看数据</strong>
              <p>仅展示安全摘要，不包含原始 Markdown、模型输入或内部存储地址。</p>
            </div>
            <template v-else>
              <header class="workflow-node-detail__header">
                <div>
                  <span>节点详情</span>
                  <strong>{{ graphNodeDefinition(selectedGraphNodeId).label }}</strong>
                </div>
                <button
                  v-if="refreshable !== false"
                  type="button"
                  aria-label="刷新当前节点详情"
                  :disabled="graphDetailLoading"
                  @click="refreshGraphDetail"
                >
                  <RefreshCw :class="{ spin: graphDetailLoading }" :size="14" />
                </button>
              </header>

              <div v-if="graphDetailLoading" class="workflow-node-detail__loading" role="status">
                <LoaderCircle class="spin" :size="14" />正在同步安全摘要…
              </div>
              <div v-if="graphDetailError" class="workflow-node-detail__error" role="alert">
                <AlertCircle :size="14" />{{ graphDetailError }}
              </div>

              <template v-if="graphDetail">
                <div class="workflow-node-detail__status">
                  <em :class="`is-${graphStatusMeta(graphDetail.status).tone}`">
                    {{ graphStatusMeta(graphDetail.status).label }}
                  </em>
                </div>
                <p class="workflow-node-detail__summary">{{ graphDetail.summary }}</p>

                <dl v-if="graphDetail.fields.length" class="workflow-node-detail__fields">
                  <div v-for="item in graphDetail.fields" :key="item.key">
                    <dt>
                      {{ item.label }}
                      <span v-if="item.source">{{ item.source }}</span>
                    </dt>
                    <dd>{{ graphDetailValue(item.value) }}</dd>
                  </div>
                </dl>

                <section
                  v-for="(source, sourceIndex) in graphDetail.sources"
                  :key="`${source.name}-${sourceIndex}`"
                  class="workflow-node-detail__source"
                >
                  <header>
                    <div class="workflow-node-detail__source-identity">
                      <span
                        v-if="source.media"
                        class="workflow-node-detail__source-visual"
                        :class="`is-${source.media.kind.toLowerCase()}`"
                      >
                        <img
                          v-if="source.media.kind === 'IMAGE' && graphPreviewUrl(source)"
                          :src="graphPreviewUrl(source)!"
                          :alt="`${source.name} 预览图`"
                          loading="lazy"
                          decoding="async"
                          @error="markGraphPreviewFailed(source.media.previewUrl!)"
                        />
                        <small v-else-if="source.media.kind === 'IMAGE'">暂无预览</small>
                        <Link2 v-else-if="source.media.kind === 'LINK'" :size="18" />
                        <FileText v-else-if="source.media.kind === 'VIDEO'" :size="18" />
                        <span v-else>{{ graphDetailExtension(source.name) }}</span>
                      </span>
                      <span class="workflow-node-detail__source-copy">
                        <strong>{{ source.name }}</strong>
                        <small v-if="source.media">
                          {{ source.media.typeLabel
                          }}<template v-if="source.media.sizeBytes !== null">
                            · {{ graphDetailBytes(source.media.sizeBytes) }}</template
                          >
                        </small>
                      </span>
                    </div>
                    <em
                      v-if="selectedGraphNodeId !== 'LOAD_AND_SNAPSHOT'"
                      :class="`is-${graphStatusMeta(source.status).tone}`"
                    >
                      {{ graphStatusMeta(source.status).label }}
                    </em>
                  </header>
                  <dl v-if="source.fields.length" class="workflow-node-detail__fields">
                    <div v-for="item in source.fields" :key="`${sourceIndex}-${item.key}`">
                      <dt>
                        {{ item.label }}
                        <span v-if="item.source">{{ item.source }}</span>
                      </dt>
                      <dd>{{ graphDetailValue(item.value) }}</dd>
                    </div>
                  </dl>
                  <p v-for="warning in source.warnings" :key="warning" class="node-warning">
                    {{ warning }}
                  </p>
                </section>

                <p
                  v-for="(warning, index) in graphDetail.warnings"
                  :key="`${warning.code}-${index}`"
                  class="node-warning"
                >
                  {{ warning.message }}
                </p>
                <p v-if="graphDetail.errorMessage" class="node-error">
                  {{ graphDetail.errorMessage }}
                </p>
              </template>
            </template>
          </aside>
        </div>
        <footer class="workflow-graph-dialog__footer">
          <span><i class="legend-running" />执行中</span
          ><span><i class="legend-success" />已完成</span
          ><span><i class="legend-warning" />部分完成 / 跳过</span
          ><span><i class="legend-danger" />失败</span
          ><button type="button" @click="close">关闭</button>
        </footer>
      </section>
    </div></Teleport
  >
</template>
<style scoped>
.workflow-graph-backdrop {
  position: fixed;
  z-index: 1200;
  inset: 0;
  display: grid;
  padding: 28px;
  place-items: center;
  background: #17233f80;
  backdrop-filter: blur(3px);
}
.workflow-graph-dialog {
  width: min(1180px, 100%);
  max-height: min(820px, calc(100vh - 56px));
  overflow: auto;
  color: #253047;
  background: #f8faff;
  border: 1px solid #dbe4f6;
  border-radius: 22px;
  outline: none;
  box-shadow: 0 28px 80px #17233f40;
}
.workflow-graph-dialog__header {
  position: sticky;
  z-index: 2;
  top: 0;
  display: flex;
  padding: 20px 22px;
  align-items: flex-start;
  justify-content: space-between;
  gap: 18px;
  background: #ffffffed;
  border-bottom: 1px solid #dbe4f6;
  backdrop-filter: blur(8px);
}
.workflow-graph-dialog__header h3,
.workflow-graph-dialog__header p {
  margin: 0;
}
.workflow-graph-dialog__header h3 {
  margin-top: 4px;
  font-size: 19px;
}
.workflow-graph-dialog__header p {
  margin-top: 5px;
  color: #718096;
  font-size: 11px;
}
.workflow-graph-dialog__eyebrow {
  color: #2563eb;
  font-size: 9px;
  font-weight: 850;
  letter-spacing: 0.12em;
}
.workflow-graph-dialog__header > button {
  display: grid;
  width: 36px;
  height: 36px;
  padding: 0;
  flex: 0 0 auto;
  place-items: center;
  color: #5f6d82;
  background: #f5f8ff;
  border: 1px solid #dbe4f6;
  border-radius: 10px;
}
.workflow-graph-dialog__loading,
.workflow-graph-dialog__error {
  display: flex;
  margin: 14px 22px 0;
  padding: 10px 12px;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  border-radius: 10px;
}
.workflow-graph-dialog__loading {
  color: #2563eb;
  background: #edf4ff;
}
.workflow-graph-dialog__error {
  color: #b83246;
  background: #fff1f2;
}
.workflow-graph-dialog__error span {
  flex: 1;
}
.workflow-graph-dialog__error button {
  display: inline-flex;
  padding: 4px 8px;
  align-items: center;
  gap: 4px;
  color: inherit;
  background: #fff;
  border: 1px solid #f3c5cc;
  border-radius: 7px;
  font-size: 10px;
}
.workflow-graph-content {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 320px;
  align-items: start;
  gap: 0;
}
.workflow-graph-canvas {
  padding: 22px;
}
.workflow-graph-node {
  position: relative;
  min-width: 0;
  padding: 13px;
  background: #fff;
  border: 1px solid #dbe4f6;
  border-radius: 14px;
  cursor: pointer;
  outline: none;
  box-shadow: 0 7px 20px #2f5f9910;
  transition:
    border-color 0.16s ease,
    box-shadow 0.16s ease,
    transform 0.16s ease;
}
.workflow-graph-node:hover {
  border-color: #9bb9ef;
  transform: translateY(-1px);
}
.workflow-graph-node:focus-visible {
  box-shadow: 0 0 0 3px #cfe0ff;
}
.workflow-graph-node[aria-pressed='true'] {
  border-color: #2563eb;
  box-shadow: 0 0 0 3px #dbeafe;
}
.workflow-graph-node--single {
  width: min(440px, 100%);
  margin: 0 auto;
}
.workflow-graph-node__heading {
  display: flex;
  align-items: flex-start;
  gap: 9px;
}
.workflow-graph-node__heading > div {
  min-width: 0;
  flex: 1;
}
.workflow-graph-node__heading strong,
.workflow-graph-node__heading small {
  display: block;
}
.workflow-graph-node__heading strong {
  font-size: 12px;
}
.workflow-graph-node__heading small {
  margin-top: 4px;
  color: #7d899f;
  font-size: 9px;
  line-height: 1.55;
}
.workflow-graph-node__heading em {
  padding: 4px 7px;
  flex: 0 0 auto;
  color: #718096;
  background: #f1f4f8;
  border-radius: 999px;
  font-size: 8px;
  font-style: normal;
  font-weight: 800;
}
.workflow-graph-node__icon {
  display: grid;
  width: 32px;
  height: 32px;
  flex: 0 0 auto;
  place-items: center;
  color: #2563eb;
  background: #eaf2ff;
  border-radius: 9px;
}
.workflow-graph-node__status-dot {
  width: 9px;
  height: 9px;
  margin-top: 4px;
  flex: 0 0 auto;
  background: #a7b0bf;
  border: 2px solid #eef1f5;
  border-radius: 999px;
  box-sizing: content-box;
}
.workflow-graph-node.is-running {
  background: #f7faff;
  border-color: #91b7ff;
  box-shadow: 0 0 0 3px #dbeafe;
}
.workflow-graph-node.is-running .workflow-graph-node__status-dot {
  background: #2563eb;
  border-color: #dbeafe;
  animation: pulse-node 1.2s ease-in-out infinite;
}
.workflow-graph-node.is-running em {
  color: #2563eb;
  background: #eaf2ff;
}
.workflow-graph-node.is-success {
  border-color: #b9e1d5;
}
.workflow-graph-node.is-success .workflow-graph-node__status-dot {
  background: #0f9f78;
  border-color: #ddf6ee;
}
.workflow-graph-node.is-success em {
  color: #0f8a68;
  background: #eaf8f3;
}
.workflow-graph-node.is-warning {
  border-color: #efd89a;
}
.workflow-graph-node.is-warning .workflow-graph-node__status-dot,
.workflow-graph-node.is-skipped .workflow-graph-node__status-dot {
  background: #d99a22;
  border-color: #fff4d8;
}
.workflow-graph-node.is-warning em,
.workflow-graph-node.is-skipped em {
  color: #a46b0a;
  background: #fff5dc;
}
.workflow-graph-node.is-danger {
  border-color: #efb7c0;
}
.workflow-graph-node.is-danger .workflow-graph-node__status-dot {
  background: #dc3f52;
  border-color: #ffe4e8;
}
.workflow-graph-node.is-danger em {
  color: #c93448;
  background: #fff0f2;
}
.workflow-graph-connector {
  display: grid;
  height: 28px;
  place-items: center;
}
.workflow-graph-connector i {
  display: block;
  width: 1px;
  height: 100%;
  background: #b9c8df;
}
.workflow-graph-parallel {
  position: relative;
  display: grid;
  padding-top: 16px;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}
.workflow-graph-parallel::before {
  position: absolute;
  top: 0;
  right: 16.6667%;
  left: 16.6667%;
  height: 1px;
  content: '';
  background: #b9c8df;
}
.workflow-graph-parallel > article::before {
  position: absolute;
  top: -16px;
  left: 50%;
  width: 1px;
  height: 16px;
  content: '';
  background: #b9c8df;
}
.workflow-graph-connector--join {
  height: 34px;
}
.node-warning,
.node-error {
  margin: 8px 0 0;
  padding: 6px 8px;
  font-size: 9px;
  line-height: 1.5;
  border-radius: 7px;
}
.node-warning {
  color: #956109;
  background: #fff8e8;
}
.node-warning--summary {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 6px;
}
.node-warning--summary > svg {
  flex: 0 0 auto;
}
.node-warning--summary > span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.node-error {
  color: #bd3346;
  background: #fff1f2;
}
.workflow-node-detail {
  position: sticky;
  top: 98px;
  min-height: 430px;
  max-height: 620px;
  margin: 22px 22px 22px 0;
  padding: 16px;
  overflow: auto;
  background: #fff;
  border: 1px solid #dbe4f6;
  border-radius: 16px;
  box-shadow: 0 9px 24px #2f5f9910;
}
.workflow-node-detail__empty {
  display: grid;
  min-height: 390px;
  padding: 28px 18px;
  place-content: center;
  justify-items: center;
  color: #7d899f;
  text-align: center;
}
.workflow-node-detail__empty svg {
  margin-bottom: 12px;
  color: #2563eb;
}
.workflow-node-detail__empty strong {
  color: #33415a;
  font-size: 13px;
}
.workflow-node-detail__empty p {
  max-width: 230px;
  margin: 8px 0 0;
  font-size: 10px;
  line-height: 1.65;
}
.workflow-node-detail__header {
  display: flex;
  padding-bottom: 12px;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  border-bottom: 1px solid #e7edf8;
}
.workflow-node-detail__header span,
.workflow-node-detail__header strong {
  display: block;
}
.workflow-node-detail__header span {
  color: #2563eb;
  font-size: 9px;
  font-weight: 850;
  letter-spacing: 0.1em;
}
.workflow-node-detail__header strong {
  margin-top: 4px;
  color: #253047;
  font-size: 14px;
}
.workflow-node-detail__header button {
  display: grid;
  width: 30px;
  height: 30px;
  padding: 0;
  place-items: center;
  color: #2563eb;
  background: #edf4ff;
  border: 0;
  border-radius: 8px;
}
.workflow-node-detail__header button:disabled {
  opacity: 0.55;
}
.workflow-node-detail__loading,
.workflow-node-detail__error {
  display: flex;
  margin-top: 10px;
  padding: 8px 9px;
  align-items: center;
  gap: 6px;
  font-size: 9px;
  border-radius: 8px;
}
.workflow-node-detail__loading {
  color: #2563eb;
  background: #edf4ff;
}
.workflow-node-detail__error {
  color: #bd3346;
  background: #fff1f2;
}
.workflow-node-detail__status {
  display: flex;
  margin-top: 13px;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.workflow-node-detail__status em,
.workflow-node-detail__source header em {
  padding: 4px 7px;
  color: #718096;
  background: #f1f4f8;
  border-radius: 999px;
  font-size: 8px;
  font-style: normal;
  font-weight: 800;
}
.workflow-node-detail__status em.is-running,
.workflow-node-detail__source header em.is-running {
  color: #2563eb;
  background: #eaf2ff;
}
.workflow-node-detail__status em.is-success,
.workflow-node-detail__source header em.is-success {
  color: #0f8a68;
  background: #eaf8f3;
}
.workflow-node-detail__status em.is-warning,
.workflow-node-detail__status em.is-skipped,
.workflow-node-detail__source header em.is-warning,
.workflow-node-detail__source header em.is-skipped {
  color: #a46b0a;
  background: #fff5dc;
}
.workflow-node-detail__status em.is-danger,
.workflow-node-detail__source header em.is-danger {
  color: #c93448;
  background: #fff0f2;
}
.workflow-node-detail__status time {
  color: #8994a8;
  font-size: 8px;
}
.workflow-node-detail__summary {
  margin: 10px 0 0;
  color: #5f6d82;
  font-size: 10px;
  line-height: 1.65;
}
.workflow-node-detail__fields {
  display: grid;
  margin: 12px 0 0;
  gap: 7px;
}
.workflow-node-detail__fields > div {
  display: grid;
  padding: 8px 9px;
  gap: 5px;
  background: #f7f9fd;
  border-radius: 8px;
}
.workflow-node-detail__fields dt {
  display: flex;
  flex-wrap: wrap;
  margin: 0;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  color: #7b879a;
  font-size: 8px;
}
.workflow-node-detail__fields dt span {
  flex-basis: 100%;
  overflow-wrap: anywhere;
  color: #2563eb;
}
.workflow-node-detail__fields dd {
  margin: 0;
  white-space: pre-line;
  overflow-wrap: anywhere;
  color: #33415a;
  font-size: 10px;
  font-weight: 700;
  line-height: 1.5;
}
.workflow-node-detail__source {
  margin-top: 11px;
  padding: 10px;
  background: #fbfcff;
  border: 1px solid #e4eaf6;
  border-radius: 10px;
}
.workflow-node-detail__source > header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.workflow-node-detail__source-identity {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 9px;
}
.workflow-node-detail__source-visual {
  display: grid;
  width: 48px;
  height: 48px;
  flex: 0 0 48px;
  overflow: hidden;
  place-items: center;
  color: #2563eb;
  background: #edf4ff;
  border: 1px solid #dbe7fb;
  border-radius: 10px;
  font-size: 9px;
  font-weight: 900;
}
.workflow-node-detail__source-visual.is-image {
  color: #8b94a6;
  background: #f5f7fb;
}
.workflow-node-detail__source-visual img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.workflow-node-detail__source-visual small {
  padding: 4px;
  text-align: center;
  font-size: 8px;
  line-height: 1.25;
}
.workflow-node-detail__source-copy {
  min-width: 0;
}
.workflow-node-detail__source-copy strong,
.workflow-node-detail__source-copy small {
  display: block;
}
.workflow-node-detail__source-copy strong {
  overflow-wrap: anywhere;
  color: #33415a;
  font-size: 10px;
}
.workflow-node-detail__source-copy small {
  margin-top: 4px;
  color: #8a96a9;
  font-size: 8px;
}
.workflow-node-detail__source .workflow-node-detail__fields {
  margin-top: 8px;
}
.workflow-graph-dialog__footer {
  display: flex;
  padding: 14px 22px 18px;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
  color: #718096;
  font-size: 9px;
}
.workflow-graph-dialog__footer span {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.workflow-graph-dialog__footer i {
  width: 7px;
  height: 7px;
  background: #a7b0bf;
  border-radius: 999px;
}
.workflow-graph-dialog__footer .legend-running {
  background: #2563eb;
}
.workflow-graph-dialog__footer .legend-success {
  background: #0f9f78;
}
.workflow-graph-dialog__footer .legend-warning {
  background: #d99a22;
}
.workflow-graph-dialog__footer .legend-danger {
  background: #dc3f52;
}
.workflow-graph-dialog__footer > button {
  height: 34px;
  margin-left: auto;
  padding: 0 16px;
  color: #fff;
  background: #2563eb;
  border: 0;
  border-radius: 9px;
  font-size: 10px;
  font-weight: 800;
}
.spin {
  animation: spin 1s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
@media (max-width: 1100px) {
  .workflow-graph-content {
    grid-template-columns: 1fr;
  }
}
@media (max-width: 700px) {
  .workflow-graph-backdrop {
    padding: 12px;
  }
  .workflow-graph-dialog {
    width: 100%;
    max-height: 94vh;
  }
  .workflow-graph-parallel {
    grid-template-columns: 1fr;
  }
  .workflow-graph-parallel::before,
  .workflow-graph-parallel > article::before {
    display: none;
  }
}
</style>
