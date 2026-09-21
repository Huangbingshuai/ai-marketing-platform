<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { AlertCircle, CheckCircle2, LoaderCircle, Sparkles, X } from '@lucide/vue';
import {
  PACKAGING_STAGES,
  PACKAGING_STAGE_LABELS,
  packagingVisualTimeline,
} from '@ai-marketing/contracts';
import type {
  ApiResponse,
  EffectTemplateMixVariant,
  PackagingComponent,
  PackagingItem,
  PackagingRun,
} from '@ai-marketing/contracts';
import { apiUrl, requestJson } from '../../../api/http-client';

const props = defineProps<{
  projectId: string;
  workflowRunId: string;
  templateId: string;
  variants: EffectTemplateMixVariant[];
  selectedVariantId: string;
  prepare: () => Promise<number | null>;
  playhead: number;
  playing: boolean;
}>();
const emit = defineEmits<{ selected: [item: PackagingItem | null] }>();
const dialog = ref<HTMLDialogElement | null>(null);
const visible = ref(false),
  busy = ref(false),
  loading = ref(false);
const error = ref(''),
  message = ref(''),
  runs = ref<PackagingRun[]>([]),
  chosenRun = ref('');
const tab = ref<'ACTION' | 'WORKFLOW'>('ACTION');
const detailId = ref('');
let controller: AbortController | null = null,
  timer: ReturnType<typeof setTimeout> | null = null;
let generation = 0;
let pendingCreate: { fingerprint: string; key: string } | null = null;
const base = computed(() => `/projects/${props.projectId}/workflows/effect/template-mix`);
const run = computed(() => {
  const value = runs.value.find((r) => r.id === chosenRun.value) ?? runs.value[0];
  return value ? { ...value, items: value.items.map(currentItem) } : undefined;
});
const completeCount = computed(
  () =>
    props.variants.filter((v) => v.slots.length && v.slots.every((s) => v.bindings[s.id])).length,
);
const active = computed(() => runs.value.some((r) => ['QUEUED', 'RUNNING'].includes(r.status)));
const statusLabel: Record<string, string> = {
  QUEUED: '排队中',
  RUNNING: '处理中',
  COMPLETED: '草稿就绪',
  PARTIAL: '部分完成',
  FAILED: '失败',
  CANCELLED: '已取消',
};
const signature = (variant: EffectTemplateMixVariant) =>
  JSON.stringify(packagingVisualTimeline(variant));
function currentItem(item: PackagingItem): PackagingItem {
  const variant = props.variants.find((v) => v.id === item.variantId);
  return {
    ...item,
    stale:
      item.stale || !variant || JSON.stringify(item.sourceVisualTimeline) !== signature(variant),
  };
}
const selected = computed(() => {
  const item = runs.value
    .flatMap((r) => r.items)
    .find((i) => i.variantId === props.selectedVariantId);
  const variant = props.variants.find((v) => v.id === props.selectedVariantId);
  if (!item || !variant) return null;
  return currentItem(item);
});
const detail = computed(
  () => run.value?.items.find((i) => i.id === detailId.value) ?? run.value?.items[0],
);
const fileUrl = (id: string) => apiUrl(`/projects/${props.projectId}/file-objects/${id}/content`);
watch(selected, (item) => emit('selected', item), { immediate: true });

async function refresh() {
  const version = generation;
  controller?.abort();
  controller = new AbortController();
  if (timer) clearTimeout(timer);
  loading.value = !runs.value.length;
  try {
    const response = await requestJson<ApiResponse<PackagingRun[]>>(
      `${base.value}/templates/${props.templateId}/packaging-runs?workflowRunId=${props.workflowRunId}`,
      { signal: controller.signal, operation: '读取包装任务' },
    );
    if (version !== generation) return;
    runs.value = response.data;
    error.value = '';
    if (!response.data.some((r) => r.id === chosenRun.value))
      chosenRun.value = response.data[0]?.id ?? '';
  } catch (reason) {
    if (version === generation && !(reason instanceof DOMException && reason.name === 'AbortError'))
      error.value = reason instanceof Error ? reason.message : '读取包装失败';
  } finally {
    if (version === generation) {
      loading.value = false;
      if (visible.value || active.value) timer = setTimeout(() => void refresh(), 4000);
    }
  }
}
async function open(mode: 'ACTION' | 'WORKFLOW') {
  tab.value = mode;
  visible.value = true;
  message.value = '';
  await nextTick();
  dialog.value?.showModal();
  void refresh();
}
function close() {
  visible.value = false;
  dialog.value?.close();
}
defineExpose({ open, visible });
async function execute(action: () => Promise<unknown>) {
  if (busy.value) return;
  const version = generation;
  busy.value = true;
  error.value = '';
  message.value = '';
  try {
    await action();
    if (version === generation) await refresh();
  } catch (reason) {
    if (version === generation) error.value = reason instanceof Error ? reason.message : '操作失败';
  } finally {
    if (version === generation) busy.value = false;
  }
}
async function create(variantId?: string, component: PackagingComponent = 'ALL') {
  const context = {
    generation,
    path: base.value,
    templateId: props.templateId,
    workflowRunId: props.workflowRunId,
  };
  await execute(async () => {
    const expectedRevision = await props.prepare();
    if (context.generation !== generation) return;
    if (expectedRevision === null) throw new Error('请先保存时间轴草稿');
    const body = { workflowRunId: context.workflowRunId, expectedRevision, variantId, component };
    const fingerprint = JSON.stringify(body);
    if (pendingCreate?.fingerprint !== fingerprint)
      pendingCreate = { fingerprint, key: crypto.randomUUID() };
    const response = await requestJson<ApiResponse<PackagingRun>>(
      `${context.path}/templates/${context.templateId}/packaging-runs`,
      {
        method: 'POST',
        operation: '创建包装任务',
        body: { ...body, idempotencyKey: pendingCreate.key },
      },
    );
    if (context.generation !== generation) return;
    pendingCreate = null;
    chosenRun.value = response.data.id;
    tab.value = 'WORKFLOW';
  });
}
async function command(action: 'cancel' | 'retry') {
  if (!run.value) return;
  await execute(() =>
    requestJson(`${base.value}/packaging-runs/${run.value!.id}/${action}`, {
      method: 'POST',
      operation: action === 'cancel' ? '取消包装' : '恢复包装',
    }),
  );
}
async function confirm(item: PackagingItem) {
  const context = { generation, path: base.value, runId: run.value?.id };
  await execute(async () => {
    const revision = await props.prepare();
    if (context.generation !== generation || !context.runId) return;
    if (revision === null) throw new Error('请先保存时间轴');
    await requestJson(`${context.path}/packaging-runs/${context.runId}/items/${item.id}/confirm`, {
      method: 'POST',
      operation: '确认包装',
    });
    if (context.generation !== generation) return;
    message.value = '包装工作副本已确认，可由成片输出节点消费';
  });
}

// Use the player clock without writing packaging fields back into the visual draft.
const voiceElement = ref<HTMLAudioElement | null>(null),
  musicElement = ref<HTMLAudioElement | null>(null);
const previewEnabled = ref(false);
const currentVoice = computed(() =>
  selected.value && !selected.value.stale
    ? Object.values(selected.value.checkpoint.voices ?? {}).find(
        (a) => props.playhead >= a.start && props.playhead < a.start + a.duration,
      )
    : undefined,
);
const currentMusic = computed(() =>
  selected.value && !selected.value.stale ? selected.value.checkpoint.music : undefined,
);
function syncAudio() {
  for (const [element, audio] of [
    [voiceElement.value, currentVoice.value],
    [musicElement.value, currentMusic.value],
  ] as const) {
    if (!element || !audio || !previewEnabled.value || !props.playing) {
      element?.pause();
      continue;
    }
    const time = props.playhead - audio.start;
    if (time < 0 || time >= audio.duration) {
      element.pause();
      continue;
    }
    if (Math.abs(element.currentTime - time) > 0.2) element.currentTime = time;
    element.volume =
      audio === currentMusic.value && currentVoice.value
        ? Math.min(audio.volume, 0.08)
        : audio.volume;
    if (element.paused)
      void element.play().catch(() => {
        previewEnabled.value = false;
        error.value = '浏览器阻止音频播放，请再次开启试听';
      });
  }
}
watch(
  () => [
    props.playhead,
    props.playing,
    previewEnabled.value,
    currentVoice.value?.fileObjectId,
    currentMusic.value?.fileObjectId,
  ],
  () => void nextTick(syncAudio),
);
watch(
  () => [props.projectId, props.workflowRunId, props.templateId],
  () => {
    generation++;
    controller?.abort();
    if (timer) clearTimeout(timer);
    runs.value = [];
    chosenRun.value = '';
    pendingCreate = null;
    busy.value = false;
    close();
    previewEnabled.value = false;
    if (props.templateId) void refresh();
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  generation++;
  controller?.abort();
  if (timer) clearTimeout(timer);
  voiceElement.value?.pause();
  musicElement.value?.pause();
});
</script>

<template>
  <div class="packaging-strip">
    <Sparkles :size="14" /><span>口播 · 配乐 · 字幕</span>
    <span v-if="selected">{{
      selected.stale ? '画面已变更，包装待更新' : statusLabel[selected.status]
    }}</span>
    <span v-else>未生成包装</span>
    <button
      v-if="selected?.status === 'COMPLETED' && !selected.stale"
      :aria-pressed="previewEnabled"
      @click="previewEnabled = !previewEnabled"
    >
      {{ previewEnabled ? '关闭同步试听' : '开启同步试听' }}
    </button>
    <button @click="open('WORKFLOW')">查看包装</button>
    <audio
      v-if="currentVoice"
      ref="voiceElement"
      :src="fileUrl(currentVoice.fileObjectId)"
      preload="auto"
      @loadedmetadata="syncAudio"
    />
    <audio
      v-if="currentMusic"
      ref="musicElement"
      :src="fileUrl(currentMusic.fileObjectId)"
      preload="auto"
      @loadedmetadata="syncAudio"
    />
  </div>
  <dialog
    ref="dialog"
    class="packaging-dialog"
    aria-labelledby="packaging-title"
    @close="visible = false"
    @click="$event.target === dialog && close()"
  >
    <header>
      <div>
        <small>SMART PACKAGING WORKFLOW</small>
        <h2 id="packaging-title">智能成片包装</h2>
        <p>为每条完整成片生成口播、专属纯音乐与同步字幕，确认后交给成片输出。</p>
      </div>
      <button aria-label="关闭包装工作流" @click="close"><X :size="20" /></button>
    </header>
    <div v-if="error" class="notice error" role="alert">
      <AlertCircle :size="16" />{{ error
      }}<button :disabled="busy" @click="refresh">重新读取</button>
    </div>
    <div v-if="message" class="notice success" role="status">{{ message }}</div>
    <section v-if="tab === 'ACTION'" class="strategy">
      <h3>本次覆盖 {{ completeCount }} 条完整成片</h3>
      <p>
        空成片不参与。逐条理解镜头，仅使用已确认的商品事实策划口播；逐句配音，按真实音频时长对齐字幕。音乐为无人声纯器乐，自动裁切或循环并降低音量。
      </p>
      <p>
        将调用火山视觉、豆包配音和 AI
        音乐服务，产生服务费用。不会修改画面时间轴，也不会直接输出最终视频。
      </p>
      <button
        class="primary"
        :disabled="busy || loading || active || !completeCount"
        @click="create()"
      >
        <Sparkles :size="16" />{{ busy ? '正在创建…' : '确认并生成全部包装' }}
      </button>
      <button @click="tab = 'WORKFLOW'">查看已有任务</button>
    </section>
    <section v-else class="workflow-body">
      <div v-if="loading" class="empty"><LoaderCircle :size="20" />正在读取真实任务状态…</div>
      <div v-else-if="!run" class="empty">
        尚未创建包装任务。<button @click="tab = 'ACTION'">配置本次包装</button>
      </div>
      <template v-else>
        <div class="summary">
          <select v-model="chosenRun" aria-label="选择包装批次">
            <option v-for="r in runs" :key="r.id" :value="r.id">
              {{ new Date(r.createdAt).toLocaleString() }} · {{ statusLabel[r.status] }}
            </option>
          </select>
          <span
            >成功 {{ run.counts.completed }} / {{ run.counts.total }} · 失败
            {{ run.counts.failed }} · 过期 {{ run.counts.stale }} ·
            {{ run.counts.shards }} 个分片</span
          >
          <button
            v-if="['QUEUED', 'RUNNING'].includes(run.status)"
            :disabled="busy"
            @click="command('cancel')"
          >
            取消任务
          </button>
          <button
            v-else-if="['FAILED', 'PARTIAL', 'CANCELLED'].includes(run.status)"
            :disabled="busy || active || !!run.counts.stale"
            @click="command('retry')"
          >
            恢复未完成项
          </button>
        </div>
        <ol class="stage-graph" aria-label="包装流程阶段">
          <li
            v-for="stage in PACKAGING_STAGES"
            :key="stage"
            :class="{
              running: run.items.some((i) => i.stage === stage && i.status === 'RUNNING'),
              failed: run.items.some((i) => i.stage === stage && i.status === 'FAILED'),
              done: run.items.every((i) => i.status === 'COMPLETED' || PACKAGING_STAGES.indexOf(i.stage) > PACKAGING_STAGES.indexOf(stage)),
            }"
          >
            <span>{{ PACKAGING_STAGE_LABELS[stage] }}</span
            ><small
              >{{
                run.items.filter(
                  (i) =>
                    i.status === 'COMPLETED' ||
                    PACKAGING_STAGES.indexOf(i.stage) > PACKAGING_STAGES.indexOf(stage),
                ).length
              }}
              / {{ run.counts.total }} 完成</small
            >
          </li>
        </ol>
        <div class="results">
          <div class="item-list">
            <button
              v-for="item in run.items"
              :key="item.id"
              :class="{ selected: detail?.id === item.id }"
              @click="detailId = item.id"
            >
              <strong>{{ item.name }}</strong
              ><small
                >分片 {{ item.shardIndex + 1 }} ·
                {{ item.stale ? '已过期' : statusLabel[item.status] }} ·
                {{ PACKAGING_STAGE_LABELS[item.stage] }}</small
              >
            </button>
          </div>
          <section v-if="detail" class="detail">
            <h3>{{ detail.name }}</h3>
            <p v-if="detail.errorMessage" class="error" role="alert">{{ detail.errorMessage }}</p>
            <p v-if="detail.stale" class="error">来源已变更，请重新生成；旧包装不可确认或输出。</p>
            <div class="actions">
              <button :disabled="busy || active" @click="create(detail.variantId)">重做整条</button
              ><button
                v-for="entry in [
                  ['VOICE', '口播'],
                  ['MUSIC', '音乐'],
                  ['CAPTIONS', '字幕'],
                ] as const"
                :key="entry[0]"
                :disabled="busy || active || detail.stale || !['COMPLETED', 'FAILED', 'CANCELLED'].includes(detail.status)"
                @click="create(detail.variantId, entry[0])"
              >
                重做{{ entry[1] }}
              </button>
            </div>
            <div v-for="line in detail.checkpoint.script" :key="line.id" class="line">
              <p>{{ line.text }}</p>
              <small>引用 {{ line.factIds.length }} 条确认事实</small
              ><audio
                v-if="detail.checkpoint.voices?.[line.id]"
                controls
                preload="none"
                :src="fileUrl(detail.checkpoint.voices[line.id]!.fileObjectId)"
              />
            </div>
            <div v-if="detail.checkpoint.music" class="line">
              <strong>专属纯音乐</strong
              ><audio
                controls
                preload="none"
                :src="fileUrl(detail.checkpoint.music.fileObjectId)"
              />
            </div>
            <div v-if="detail.checkpoint.captions?.length" class="captions">
              <h4>同步字幕</h4>
              <p v-for="c in detail.checkpoint.captions" :key="c.id">
                <time>{{ c.start.toFixed(2) }}–{{ c.end.toFixed(2) }}s</time>{{ c.text }}
              </p>
            </div>
            <button
              class="primary"
              :disabled="busy || detail.stale || detail.status !== 'COMPLETED'"
              @click="confirm(detail)"
            >
              <CheckCircle2 :size="16" />完成包装校验</button
            ><small class="hint"
              >请先完成画面时间轴校验。此处只提交包装工作副本，不编码最终成片。</small
            >
          </section>
        </div>
      </template>
    </section>
  </dialog>
</template>

<style scoped>
.packaging-strip {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 14px;
  border-block: 1px solid #dbe5f5;
  background: #f7faff;
  color: #5274a5;
  font-size: 12px;
  flex-wrap: wrap;
}
button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  border: 1px solid #d4dff1;
  border-radius: 7px;
  background: white;
  color: #265dd1;
  padding: 7px 11px;
  cursor: pointer;
  font: inherit;
}
button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
button:focus-visible,
select:focus-visible {
  outline: 2px solid #2563eb;
  outline-offset: 3px;
}
.primary {
  background: #2563eb;
  color: white;
  border-color: #2563eb;
}
.packaging-dialog {
  width: min(1060px, 94vw);
  max-height: 90vh;
  padding: 0;
  border: 1px solid #d7e2f2;
  border-radius: 14px;
  color: #163963;
  box-shadow: 0 22px 70px #1f355a30;
}
.packaging-dialog::backdrop {
  background: #18305266;
}
header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 20px;
  padding: 22px;
  border-bottom: 1px solid #e1e9f4;
}
h2 {
  margin: 5px 0;
  font-size: 23px;
}
h3 {
  margin: 0 0 12px;
}
p {
  line-height: 1.7;
}
header p {
  margin: 6px 0 0;
  font-size: 13px;
  color: #6881a6;
}
header small {
  color: #7190b7;
  letter-spacing: 1px;
  font-size: 10px;
}
.strategy,
.workflow-body {
  padding: 22px;
}
.strategy > button {
  margin-right: 10px;
}
.strategy p {
  color: #607a9d;
}
.notice {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 22px;
  background: #fff7f7;
  font-size: 13px;
}
.error {
  color: #b83448;
}
.success {
  background: #f0fbf5;
  color: #238055;
}
.summary {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  font-size: 12px;
}
select {
  padding: 8px;
  border: 1px solid #dbe5f4;
  border-radius: 6px;
  background: white;
  color: #33567f;
  max-width: 100%;
}
.stage-graph {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  gap: 10px;
  padding: 0;
  margin: 20px 0;
  list-style: none;
}
.stage-graph li {
  position: relative;
  border: 1px solid #dce5f3;
  background: #f6f9fe;
  border-radius: 9px;
  padding: 14px 7px;
  font-size: 12px;
  text-align: center;
}
.stage-graph li + li::before {
  content: '›';
  position: absolute;
  left: -9px;
  color: #7798c2;
}
.stage-graph small {
  display: block;
  color: #7c92b3;
  margin-top: 7px;
  font-size: 10px;
}
.stage-graph .running {
  border-color: #588af2;
  background: #eaf2ff;
}
.stage-graph .done { background: #f0faf5; border-color: #bcdccb; }
.stage-graph .failed { background: #fff4f4; border-color: #efb9c1; }
.results {
  display: grid;
  grid-template-columns: 235px minmax(0, 1fr);
  gap: 18px;
  border-top: 1px solid #e3ebf5;
  padding-top: 18px;
}
.item-list {
  max-height: 440px;
  overflow: auto;
}
.item-list button {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  width: 100%;
  margin-bottom: 7px;
  text-align: left;
}
.item-list small {
  color: #7a91b1;
  font-size: 11px;
}
.item-list .selected {
  background: #edf4ff;
  border-color: #92b6fa;
}
.detail {
  max-height: 500px;
  overflow: auto;
  padding-right: 6px;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  font-size: 12px;
}
.line {
  padding: 10px 0;
  border-bottom: 1px solid #edf1f7;
}
.line p {
  margin: 3px 0;
}
.line small,
.hint {
  color: #7d92ac;
  font-size: 11px;
}
audio {
  display: block;
  width: 100%;
  height: 34px;
  margin-top: 7px;
}
.captions {
  font-size: 12px;
}
time {
  margin-right: 12px;
  color: #7b94b4;
}
.hint {
  display: block;
  margin-top: 8px;
}
.empty {
  padding: 50px 10px;
  text-align: center;
  color: #8295af;
}
@media (max-width: 700px) {
  .results {
    grid-template-columns: 1fr;
  }
  .item-list {
    max-height: 150px;
  }
  .stage-graph {
    grid-template-columns: repeat(3, 1fr);
  }
  header,
  .strategy,
  .workflow-body {
    padding: 14px;
  }
}
</style>
