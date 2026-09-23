<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import {
  AlertCircle,
  ArrowLeft,
  Workflow,
  X,
} from '@lucide/vue';
import { WorkflowRunProgress } from '@ai-marketing/ui';
import {
  packagingProgress,
  packagingStageDetails,
  packagingStageState,
  packagingItemStageState,
  packagingItemStageLabels,
  currentPackagingRun,
} from './effect-packaging-progress';
import { createPackagingPoller } from './effect-packaging-poller';
import type { PackagingStage } from './effect-packaging-progress';
import { packagingPlaybackError } from './effect-packaging-audio';
import {
  PACKAGING_STAGES,
  PACKAGING_STAGE_LABELS,
  packagingAudioFade,
  packagingVisualTimeline,
  packagingSlotBoundaryError,
} from '@ai-marketing/contracts';
import type {
  ApiResponse,
  EffectTemplateMixAudio,
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
  seekVersion: number;
  playing: boolean;
  /** Shared with the workbench's single audio track control. */
  audioMuted: boolean;
}>();
const emit = defineEmits<{ selected: [item: PackagingItem | null]; preview: [enabled: boolean]; ready: [ready: boolean] }>();
const dialog = ref<HTMLDialogElement | null>(null);
const visible = ref(false),
  busy = ref(false),
  loading = ref(false);
const starting = ref(false);
const requestError = ref(''),
  loadError = ref(''),
  previewError = ref('');
const error = computed(() => requestError.value || loadError.value || previewError.value);
const message = ref(''),
  runs = ref<PackagingRun[]>([]);
const refreshing = ref(false), lastReadAt = ref('');
const selectedStage = ref<PackagingStage | null>(null);
const detailId = ref('');
let generation = 0;
let pendingCreate: { fingerprint: string; key: string } | null = null;
const base = computed(() => `/projects/${props.projectId}/workflows/effect/template-mix`);
const run = computed(() => {
  const value = currentPackagingRun(runs.value);
  return value ? { ...value, items: value.items.map(currentItem) } : undefined;
});
const completeCount = computed(
  () =>
    props.variants.filter((v) => v.slots.length && v.slots.every((s) => v.bindings[s.id])).length,
);
const active = computed(() => runs.value.some((r) => ['QUEUED', 'RUNNING'].includes(r.status)));
const progressRun = computed(
  () => currentPackagingRun(runs.value),
);
const progress = computed(() => progressRun.value?.execution?.progressPercent ?? packagingProgress(progressRun.value));
const executionSummary = computed(() => {
  const value = progressRun.value;
  if (!value) return `本次覆盖 ${completeCount.value} 条完整成片`;
  const e = value.execution;
  const base = `已完成 ${value.counts.completed} / ${value.counts.total} 条 · ${value.counts.shards} 个分片`;
  if (!e) return base;
  const eta = e.estimatedRemainingSeconds === null ? (active.value && e.delayed ? ' · 暂无可靠完成时间' : '') : ` · 预计剩余 ${Math.ceil(e.estimatedRemainingSeconds / 60)} 分钟${e.estimateBasis === 'BASELINE' ? '（初始估算）' : ''}`;
  return `${base} · 排队 ${e.queued} · 运行 ${e.running}${eta}${e.delayed ? ' · 当前吞吐低于目标或存在失败' : ''}`;
});
const progressSummary = computed(() => {
  if (starting.value && !active.value) return '智能成片包装 · 正在提交任务…';
  const value = progressRun.value;
  if (!value) return '';
  const item = value.items.find((i) => i.status === 'RUNNING');
  return `智能成片包装 · ${item ? PACKAGING_STAGE_LABELS[item.stage] : statusLabel[value.status]} · 阶段进度 ${progress.value}%`;
});
const stageStates = computed(() => Object.fromEntries(
  PACKAGING_STAGES.map((stage) => [stage, packagingStageState(run.value?.items ?? [], stage)]),
) as Record<PackagingStage, ReturnType<typeof packagingStageState>>);
const stageState = (stage: PackagingStage) => stageStates.value[stage];
const stageItems = computed(() => run.value?.items ?? []);
const batchCreatedAt = computed(() => run.value
  ? new Date(run.value.createdAt).toLocaleString('zh-CN', { hour12: false }) : '');
const staleCount = computed(() => run.value?.items.filter((item) => item.stale).length ?? 0);
const shardStates = computed(() =>
  [...new Set(run.value?.items.map((i) => i.shardIndex) ?? [])].map((index) => {
    const items = run.value!.items.filter((i) => i.shardIndex === index);
    return {
      index,
      total: items.length,
      completed: items.filter((i) => i.status === 'COMPLETED').length,
      failed: items.filter((i) => i.status === 'FAILED').length,
    };
  }),
);
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
const selectedVariant = computed(() =>
  props.variants.find((variant) => variant.id === props.selectedVariantId),
);
const boundaryError = computed(() => {
  const variant = props.variants.find((v) => v.id === props.selectedVariantId);
  return variant ? packagingSlotBoundaryError(variant) : null;
});
const detail = computed(
  () => run.value?.items.find((i) => i.id === detailId.value) ?? run.value?.items[0],
);
const fileUrl = (id: string) => apiUrl(`/projects/${props.projectId}/file-objects/${id}/content`);
watch(selected, (item) => emit('selected', item), { immediate: true });
const allReady = computed(() => !active.value && !loadError.value && props.variants.length > 0 && props.variants.every((v) => {
  const item = runs.value.flatMap((r) => r.items).find((i) => i.variantId === v.id);
  return item && item.status === 'COMPLETED' && !currentItem(item).stale &&
    item.checkpoint.narrationLayoutVersion === 'SLOT_V1' && !packagingSlotBoundaryError(v);
}));
watch(allReady, (ready) => emit('ready', ready), { immediate: true });

const poller = createPackagingPoller({
  async read(signal) {
    const response = await requestJson<ApiResponse<PackagingRun[]>>(
      `${base.value}/templates/${props.templateId}/packaging-runs?workflowRunId=${props.workflowRunId}`,
      { signal, operation: '读取包装任务' },
    );
    return response.data;
  },
  onData(data) {
    runs.value = data;
    loadError.value = '';
    lastReadAt.value = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  },
  onError(reason) {
    loadError.value = reason instanceof Error ? reason.message : '读取包装失败';
  },
  onLoading(value) {
    refreshing.value = value;
    loading.value = value && !runs.value.length;
  },
  // Discover tasks started in another session even when this workspace is idle.
  interval: () => visible.value || active.value || loadError.value ? 4000 : 30_000,
});
const refresh = () => poller.refresh();
function refreshOnReturn() {
  if (props.templateId && document.visibilityState === 'visible') void refresh();
}
async function open(mode: 'ACTION' | 'WORKFLOW') {
  if (mode === 'ACTION') {
    if (busy.value || active.value || loading.value) return;
    if (!completeCount.value) {
      requestError.value = '请先完成至少一条成片的画面时间轴，空成片不参与包装';
      return;
    }
    await create();
    return;
  }
  selectedStage.value = null;
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
defineExpose({
  open,
  visible,
  busy,
  active,
  loading,
  starting,
  startPlaybackAudio,
  stopPlaybackAudio,
});
async function execute(action: () => Promise<unknown>) {
  if (busy.value) return;
  const version = generation;
  busy.value = true;
  requestError.value = '';
  message.value = '';
  try {
    await action();
    if (version === generation) await refresh();
  } catch (reason) {
    if (version === generation)
      requestError.value = reason instanceof Error ? reason.message : '操作失败';
  } finally {
    if (version === generation) busy.value = false;
  }
}
async function create(variantId?: string, component: PackagingComponent = 'ALL', slotId?: string) {
  if (busy.value) return;
  const context = {
    generation,
    path: base.value,
    templateId: props.templateId,
    workflowRunId: props.workflowRunId,
  };
  starting.value = true;
  try {
    await execute(async () => {
      const expectedRevision = await props.prepare();
      if (context.generation !== generation) return;
      if (expectedRevision === null) throw new Error('请先保存时间轴草稿');
      const body = { workflowRunId: context.workflowRunId, expectedRevision, variantId, component, slotId };
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
      poller.stop();
      runs.value = [response.data, ...runs.value.filter((r) => r.id !== response.data.id)];
    });
  } finally {
    if (context.generation === generation) starting.value = false;
  }
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

// Use the player clock without writing packaging fields back into the visual draft.
const voiceElement = ref<HTMLAudioElement | null>(null),
  musicElement = ref<HTMLAudioElement | null>(null);
// The main player owns all track playback. Only a failed play attempt blocks
// audio until the next player gesture; there is no separate audition switch.
const playbackBlocked = reactive({ MUSIC: false, VOICE: false });
const previewAvailable = computed(() => {
  const item = selected.value;
  // Stale only describes the saved visual snapshot. It must not silence already-generated audio
  // while the user is editing the timeline.
  return Boolean(
    (item && item.status === 'COMPLETED') || selectedVariant.value?.voice || selectedVariant.value?.bgm,
  );
});
watch(
  previewAvailable,
  (enabled) => {
    if (enabled) previewError.value = '';
    emit('preview', enabled);
  },
  { immediate: true },
);
watch(
  () => [props.playing, props.selectedVariantId],
  () => {
    playbackBlocked.MUSIC = false;
    playbackBlocked.VOICE = false;
    previewError.value = '';
  },
);
type PreviewAudio = {
  fileObjectId: string;
  duration: number;
  start: number;
  volume: number;
  offset?: number;
  fadeIn?: number;
  fadeOut?: number;
};
const currentVoice = computed<PreviewAudio | undefined>(() => {
  if (!previewAvailable.value) return undefined;
  const voices = Object.values(selected.value?.checkpoint.voices ?? {}).sort(
    (left, right) => left.start - right.start,
  );
  const slotVoice =
    voices.find((audio) => props.playhead >= audio.start && props.playhead < audio.start + audio.duration) ??
    voices.find((audio) => audio.start > props.playhead);
  if (slotVoice) return slotVoice;
  // Legacy packaging stored one whole-film voice on the variant instead of a slot-keyed
  // checkpoint. Keep that already-generated audio playable while the user repackages it.
  if (!selected.value || selected.value.checkpoint.narrationLayoutVersion !== 'SLOT_V1') {
    return selectedVariant.value?.voice as EffectTemplateMixAudio | undefined;
  }
  return undefined;
});
const nextVoice = computed<PreviewAudio | undefined>(() => {
  if (!previewAvailable.value) return undefined;
  const voices = Object.values(selected.value?.checkpoint.voices ?? {}).sort(
    (left, right) => left.start - right.start,
  );
  const currentIndex = voices.findIndex(
    (audio) => audio.fileObjectId === currentVoice.value?.fileObjectId,
  );
  return currentIndex >= 0
    ? voices[currentIndex + 1]
    : voices.find((audio) => audio.start > props.playhead);
});
const currentMusic = computed<PreviewAudio | undefined>(() => {
  if (!previewAvailable.value) return undefined;
  if (selected.value?.checkpoint.music) return selected.value.checkpoint.music;
  if (!selected.value || selected.value.checkpoint.narrationLayoutVersion !== 'SLOT_V1') {
    return selectedVariant.value?.bgm as EffectTemplateMixAudio | undefined;
  }
  return undefined;
});
function syncAudio(forceSeek = false) {
  for (const [kind, element, audio, muted] of [
    ['VOICE', voiceElement.value, currentVoice.value, props.audioMuted],
    ['MUSIC', musicElement.value, currentMusic.value, props.audioMuted],
  ] as const) {
    if (!element || !audio || playbackBlocked[kind] || !props.playing) {
      element?.pause();
      if (element) {
        element.dataset.timelineActive = 'false';
        element.dataset.timelineStarting = 'false';
        element.dataset.timelineEntryKey = '';
      }
      continue;
    }
    element.muted = muted;
    if (muted) {
      element.pause();
      element.dataset.timelineActive = 'false';
      element.dataset.timelineStarting = 'false';
      element.dataset.timelineEntryKey = '';
      continue;
    }
    const timelineTime = props.playhead - audio.start;
    if (timelineTime < 0 || timelineTime >= audio.duration) {
      if (timelineTime < 0 && element.dataset.timelinePriming === audio.fileObjectId) continue;
      element.pause();
      element.dataset.timelineActive = 'false';
      element.dataset.timelineStarting = 'false';
      element.dataset.timelineEntryKey = '';
      continue;
    }
    const time = timelineTime + Math.max(0, audio.offset ?? 0);
    const fadeIn = packagingAudioFade(audio, kind, 'fadeIn');
    const fadeOut = packagingAudioFade(audio, kind, 'fadeOut');
    const fadeInGain = fadeIn > 0 ? Math.min(1, Math.max(0, timelineTime / fadeIn)) : 1;
    const fadeOutGain = fadeOut > 0
      ? Math.min(1, Math.max(0, (audio.duration - timelineTime) / fadeOut))
      : 1;
    element.volume = Math.max(0, Math.min(1, audio.volume * Math.min(fadeInGain, fadeOutGain)));
    if (element.readyState < HTMLMediaElement.HAVE_METADATA) {
      if (element.dataset.timelinePriming === audio.fileObjectId) continue;
      element.pause();
      element.dataset.timelineActive = 'false';
      element.dataset.timelineStarting = 'false';
      continue;
    }
    const entryKey = `${audio.fileObjectId}:${audio.start}:${audio.offset ?? 0}`;
    if (forceSeek || element.dataset.timelineEntryKey !== entryKey) {
      try {
        element.currentTime = time;
      } catch {
        // The active source is switching; the next media readiness event retries this seek.
        element.dataset.timelineActive = 'false';
        continue;
      }
      element.dataset.timelineEntryKey = entryKey;
    }
    // Do not start from the beginning while the requested seek is still being decoded.
    // `seeked` and `canplay` call this again once the browser can output the right samples.
    if (element.seeking || element.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      if (element.dataset.timelinePriming === audio.fileObjectId) continue;
      element.dataset.timelineActive = 'false';
      continue;
    }
    element.dataset.timelineActive = 'true';
    if (element.paused && element.dataset.timelineStarting !== 'true') {
      const version = generation;
      const fileId = audio.fileObjectId;
      const isMusic = element === musicElement.value;
      element.dataset.timelineStarting = 'true';
      void element.play().catch((reason: unknown) => {
        const current = isMusic ? currentMusic.value : currentVoice.value;
        const bound = isMusic ? musicElement.value : voiceElement.value;
        const warning = packagingPlaybackError(
          reason,
          version === generation &&
            !playbackBlocked[kind] &&
            props.playing &&
            bound === element &&
            current?.fileObjectId === fileId,
        );
        if (!warning) return;
        playbackBlocked[kind] = true;
        previewError.value = warning;
      }).finally(() => {
        element.dataset.timelineStarting = 'false';
        if (element.dataset.timelineActive !== 'true') element.pause();
      });
    }
  }
}
/** Start packaged audio directly from the player's user gesture. */
function startPlaybackAudio() {
  playbackBlocked.MUSIC = false;
  playbackBlocked.VOICE = false;
  previewError.value = '';
  syncAudio(true);
  // A narration line may begin well after the play button's user gesture. Prime the
  // persistent voice element silently now so the browser won't reject its later play().
  const audio = currentVoice.value;
  const element = voiceElement.value;
  if (audio && element && props.playhead < audio.start) {
    const fileId = audio.fileObjectId;
    const originalVolume = element.volume;
    element.dataset.timelinePriming = fileId;
    element.dataset.timelinePrimeVolume = String(originalVolume);
    element.volume = 0;
    element.muted = false;
    try {
      void element.play().catch(() => undefined).finally(() => {
        const ownsPrime = element.dataset.timelinePriming === fileId;
        if (ownsPrime && element.dataset.timelineActive !== 'true') {
          element.pause();
          try {
            element.currentTime = 0;
          } catch {
            // A source reload can temporarily make the current position unavailable.
          }
        }
        const savedVolume = Number(element.dataset.timelinePrimeVolume);
        element.volume = Number.isFinite(savedVolume) ? savedVolume : originalVolume;
        element.dataset.timelinePrimeVolume = '';
        element.muted = props.audioMuted;
        if (ownsPrime) element.dataset.timelinePriming = '';
        if (element.dataset.timelineActive !== 'true') element.pause();
      });
    } catch {
      element.dataset.timelinePriming = '';
      element.volume = originalVolume;
      element.dataset.timelinePrimeVolume = '';
      element.muted = props.audioMuted;
    }
  }
}
function stopPlaybackAudio() {
  voiceElement.value?.pause();
  musicElement.value?.pause();
  if (voiceElement.value) {
    voiceElement.value.dataset.timelineActive = 'false';
    voiceElement.value.dataset.timelineStarting = 'false';
    voiceElement.value.dataset.timelinePriming = '';
    const primeVolume = Number(voiceElement.value.dataset.timelinePrimeVolume);
    if (Number.isFinite(primeVolume)) voiceElement.value.volume = primeVolume;
    voiceElement.value.dataset.timelinePrimeVolume = '';
  }
  if (musicElement.value) {
    musicElement.value.dataset.timelineActive = 'false';
    musicElement.value.dataset.timelineStarting = 'false';
  }
}
watch(
  () => [
    props.playhead,
    props.playing,
    props.audioMuted,
    playbackBlocked.VOICE,
    playbackBlocked.MUSIC,
    currentVoice.value?.fileObjectId,
    currentVoice.value?.volume,
    currentVoice.value?.fadeIn,
    currentVoice.value?.fadeOut,
    currentMusic.value?.fileObjectId,
    currentMusic.value?.volume,
    currentMusic.value?.fadeIn,
    currentMusic.value?.fadeOut,
  ],
  () => void nextTick(() => syncAudio()),
);
watch(() => props.seekVersion, () => void nextTick(() => syncAudio(true)));
watch(
  () => [props.projectId, props.workflowRunId, props.templateId],
  () => {
    generation++;
    poller.stop();
    runs.value = [];
    lastReadAt.value = '';
    pendingCreate = null;
    requestError.value = '';
    loadError.value = '';
    previewError.value = '';
    busy.value = false;
    starting.value = false;
    close();
    playbackBlocked.MUSIC = false;
    playbackBlocked.VOICE = false;
    if (props.templateId) void refresh();
  },
  { immediate: true },
);
onMounted(() => {
  window.addEventListener('focus', refreshOnReturn);
  document.addEventListener('visibilitychange', refreshOnReturn);
});
onBeforeUnmount(() => {
  generation++;
  poller.stop();
  window.removeEventListener('focus', refreshOnReturn);
  document.removeEventListener('visibilitychange', refreshOnReturn);
  voiceElement.value?.pause();
  musicElement.value?.pause();
});
</script>

<template>
  <div v-if="boundaryError" class="notice error" role="alert">{{ boundaryError }}</div>
  <WorkflowRunProgress
    v-if="starting || active"
    class="packaging-progress"
    :progress="starting && !active ? 0 : progress"
    :summary="progressSummary"
    :attempt-label="executionSummary"
    :warning="
      error ||
      (progressRun?.counts.failed ? `${progressRun.counts.failed} 条失败，请查看当前工作流` : '')
    "
    action-label="查看当前工作流"
    @show-details="open('WORKFLOW')"
  />
  <div v-if="error && !visible && !active && !busy" class="notice error" role="alert">
    <AlertCircle :size="16" />{{ error }}<button @click="refresh">重新读取</button>
  </div>
  <audio
    v-if="currentVoice"
    ref="voiceElement"
    :src="fileUrl(currentVoice.fileObjectId)"
    preload="auto"
    @loadedmetadata="syncAudio()"
    @seeked="syncAudio()"
    @canplay="syncAudio()"
  />
  <audio
    v-if="nextVoice"
    :key="`prefetch:${nextVoice.fileObjectId}`"
    :src="fileUrl(nextVoice.fileObjectId)"
    preload="auto"
    aria-hidden="true"
  />
  <audio
    v-if="currentMusic"
    :key="currentMusic.fileObjectId"
    ref="musicElement"
    :src="fileUrl(currentMusic.fileObjectId)"
    preload="auto"
    @loadedmetadata="syncAudio()"
    @seeked="syncAudio()"
    @canplay="syncAudio()"
  />
  <dialog
    ref="dialog"
    class="packaging-dialog workflow-dialog"
    aria-labelledby="packaging-title"
    @close="visible = false"
    @click="$event.target === dialog && close()"
  >
    <header>
      <div class="workflow-graph-title">
        <span>SMART PACKAGING WORKFLOW</span>
        <h2 id="packaging-title">智能成片包装工作流</h2>
        <p>查看本次视觉理解、口播策划、配音、音乐和字幕的真实执行状态。</p>
      </div>
      <button class="workflow-graph-close" aria-label="关闭包装工作流" @click="close">
        <X :size="18" />
      </button>
    </header>
    <div v-if="error" class="notice error" role="alert">
      <AlertCircle :size="16" />{{ error
      }}<button :disabled="busy" @click="refresh">重新读取</button>
    </div>
    <div v-if="message" class="notice success" role="status">{{ message }}</div>
    <section class="packaging-run-summary" aria-label="当前包装批次">
      <div v-if="run">
        <strong>{{ statusLabel[run.status] }} · {{ run.counts.completed }} / {{ run.counts.total }} 条完成</strong>
        <p>{{ executionSummary }} · 失败 {{ run.counts.failed }}<template v-if="staleCount"> · 来源待更新 {{ staleCount }}</template></p>
        <small>本批创建于 {{ batchCreatedAt }} · {{ loadError ? '同步中断，以下为上次读取结果' : '最后读取 ' + lastReadAt }}</small>
      </div>
      <p v-else role="status">{{ loading ? '正在读取包装任务…' : loadError ? '暂时无法读取包装任务' : '尚未创建包装任务' }}</p>
      <button :disabled="refreshing" @click="refresh">{{ refreshing ? '读取中…' : '刷新状态' }}</button>
      <p class="packaging-parallel-hint">以下按成片汇总各阶段，不同成片并行推进；部分失败不会阻止其他成片继续。连线表示单条成片的处理顺序。</p>
    </section>
    <main class="workflow-graph-content">
      <div class="workflow-graph-canvas" aria-label="智能成片包装执行图">
        <template v-for="(stage, index) in PACKAGING_STAGES" :key="stage">
          <div v-if="index" class="workflow-connector" aria-hidden="true"><i /></div>
          <button
            class="workflow-graph-node"
            :class="`is-${stageState(stage).tone}`"
            type="button"
            :aria-pressed="selectedStage === stage"
            @click="selectedStage = stage"
          >
            <span class="workflow-node-dot" />
            <span
              ><strong>{{ PACKAGING_STAGE_LABELS[stage] }}</strong
              ><small
                >{{ packagingStageDetails[stage].description
                }}<template v-if="run">
                  · {{ stageState(stage).completed }} / {{ run.items.length }} 完成</template
                ></small>
                <small v-if="stageState(stage).summary" class="packaging-stage-counts">{{ stageState(stage).summary }}</small>
              </span
            >
            <em>{{ stageState(stage).label }}</em>
          </button>
        </template>
      </div>
      <aside class="workflow-node-detail" aria-live="polite">
        <div v-if="!selectedStage" class="workflow-node-detail-empty">
          <Workflow :size="30" /><strong>选择节点查看真实状态</strong>
          <p>点击左侧节点查看本阶段输入、输出和各成片执行情况。</p>
        </div>
        <template v-else>
          <header class="workflow-node-detail-header">
            <div>
              <span>NODE DETAIL</span><strong>{{ PACKAGING_STAGE_LABELS[selectedStage] }}</strong>
            </div>
          </header>
          <div class="workflow-node-detail-status">
            <em :class="`is-${stageState(selectedStage).tone}`">{{
              stageState(selectedStage).label
            }}</em
            ><span
              ><small>本阶段完成</small
              ><b>{{ stageState(selectedStage).completed }} / {{ run?.items.length ?? 0 }}</b></span
            >
          </div>
          <p class="workflow-node-summary">
            {{ packagingStageDetails[selectedStage].description }}
          </p>
          <section class="workflow-detail-block is-input">
            <span>INPUT</span><strong>本阶段输入</strong>
            <p>{{ packagingStageDetails[selectedStage].input }}</p>
          </section>
          <section class="workflow-detail-block is-output">
            <span>OUTPUT</span><strong>本阶段输出</strong>
            <p>{{ packagingStageDetails[selectedStage].output }}</p>
          </section>
          <section v-if="run" class="workflow-detail-block">
            <span>EXECUTION</span><strong>成片执行情况</strong>
            <p>
              执行中 {{ stageState(selectedStage).running }} · 失败
              {{ stageState(selectedStage).failed }} · 取消
              {{ stageState(selectedStage).cancelled }}
            </p>
            <p v-if="!stageItems.length">本阶段尚未执行。</p>
            <ul class="stage-items">
              <li v-for="item in stageItems" :key="item.id">
                <b>{{ item.name }}</b
                ><span>{{
                  item.stale
                    ? '已过期'
                    : packagingItemStageLabels[packagingItemStageState(item, selectedStage)]
                }}</span
                ><small v-if="item.stage === selectedStage && item.errorMessage" class="error">{{
                  item.errorMessage
                }}</small>
              </li>
            </ul>
          </section>
        </template>
      </aside>
    </main>
    <details v-if="run" class="packaging-results">
      <summary>成片结果与分片进度 · {{ run.items.length }} 条成片</summary>
      <p>{{ executionSummary }}</p>
      <div v-if="run.execution?.performance" class="shard-list">
        <span>视觉缓存 {{ run.execution.performance.cacheHits }}/{{ run.execution.performance.cacheLookups }} 命中</span>
        <span v-for="(stage, name) in run.execution.performance.stages" :key="name">
          {{ ({ preprocessingSeconds: '媒体读取与预处理', visionSeconds: '视觉请求（槽位分摊）', scriptSeconds: '策划请求', voiceSeconds: '配音及缩句请求', musicWaitSeconds: '音乐提交与供应商等待', localQueueSeconds: '本地并发排队' } as Record<string, string>)[name] }}
          · P50 {{ stage.p50Seconds.toFixed(1) }}s / P95 {{ stage.p95Seconds.toFixed(1) }}s
        </span>
      </div>
      <div class="shard-list">
        <span v-for="shard in shardStates" :key="shard.index"
          >分片 {{ shard.index + 1 }} · 完成 {{ shard.completed }}/{{ shard.total }} · 失败
          {{ shard.failed }}</span
        >
      </div>
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
              :disabled="
                busy ||
                active ||
                detail.stale ||
                detail.checkpoint.narrationLayoutVersion !== 'SLOT_V1' ||
                !['COMPLETED', 'FAILED', 'CANCELLED'].includes(detail.status)
              "
              @click="create(detail.variantId, entry[0])"
            >
              重做{{ entry[1] }}
            </button>
          </div>
          <div v-for="line in detail.checkpoint.script" :key="line.id" class="line">
            <strong v-if="line.slotId">{{ detail.sourceVisualTimeline.slots.find(s => s.id === line.slotId)?.label }} · {{ line.start }}–{{ line.end }}s</strong>
            <p>{{ line.text }}</p>
            <small v-if="line.slotId && detail.checkpoint.narrationMetrics?.[line.slotId]">
              {{ detail.checkpoint.narrationMetrics[line.slotId]!.characters }} 字 / 目标 {{ detail.checkpoint.narrationMetrics[line.slotId]!.targetCharacters }} 字 ·
              配音 {{ detail.checkpoint.narrationMetrics[line.slotId]!.audioSeconds.toFixed(1) }}s / 槽位 {{ detail.checkpoint.narrationMetrics[line.slotId]!.slotSeconds.toFixed(1) }}s ·
              利用率 {{ (detail.checkpoint.narrationMetrics[line.slotId]!.utilization * 100).toFixed(0) }}%
            </small>
            <small>音色：{{ detail.checkpoint.voices?.[line.id]?.voiceProfile?.name || '历史默认音色' }}</small>
            <button v-if="line.slotId" :disabled="busy || active || detail.stale" @click="create(detail.variantId, 'VOICE', line.slotId)">重做此槽位口播</button>
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
            ><audio controls preload="none" :src="fileUrl(detail.checkpoint.music.fileObjectId)" />
          </div>
          <div v-if="detail.checkpoint.captions?.length" class="captions">
            <h4>同步字幕</h4>
            <p v-for="c in detail.checkpoint.captions" :key="c.id">
              <time>{{ c.start.toFixed(2) }}–{{ c.end.toFixed(2) }}s</time>{{ c.text }}
            </p>
          </div>
          <small class="hint">全部成片就绪后，在节点底部统一完成校验并进入成片输出。</small>
        </section>
      </div>
    </details>
    <footer>
      <span><i class="running" />执行中</span><span><i class="success" />已完成</span
      ><span><i />等待中</span><span><i class="danger" />失败</span>
      <span class="workflow-edge-count">6 条执行边</span>
      <button
        v-if="run && ['QUEUED', 'RUNNING'].includes(run.status)"
        :disabled="busy"
        type="button"
        @click="command('cancel')"
      >
        取消任务
      </button>
      <button
        v-else-if="run && ['FAILED', 'PARTIAL', 'CANCELLED'].includes(run.status)"
        :disabled="busy || active || run.items.some((i) => i.status !== 'COMPLETED' && i.stale)"
        type="button"
        @click="command('retry')"
      >
        恢复未完成项
      </button>
      <button type="button" @click="close"><ArrowLeft :size="14" />返回工作区</button>
    </footer>
  </dialog>
</template>

<style scoped>
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
.packaging-dialog > header {
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
.packaging-dialog > header p {
  margin: 6px 0 0;
  font-size: 13px;
  color: #6881a6;
}
.packaging-dialog > header small {
  color: #7190b7;
  letter-spacing: 1px;
  font-size: 10px;
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
  padding: 14px 20px 0;
}
select {
  padding: 8px;
  border: 1px solid #dbe5f4;
  border-radius: 6px;
  background: white;
  color: #33567f;
  max-width: 100%;
}
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
  .packaging-dialog > header {
    padding: 14px;
  }
}
.packaging-progress {
  margin: 8px 12px;
  flex-shrink: 0;
}
.packaging-run-summary {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 16px;
  padding: 14px 20px 0;
  font-size: 12px;
}
.packaging-run-summary > div { flex: 1; min-width: 200px; }
.packaging-run-summary p { margin: 4px 0; }
.packaging-run-summary small,
.packaging-parallel-hint { color: #718096; font-size: 11px; }
.packaging-parallel-hint { flex-basis: 100%; }
.workflow-graph-node small.packaging-stage-counts { color: #435b7d; }
.packaging-dialog {
  max-width: calc(100vw - 32px);
}
.packaging-dialog > footer {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
}
.packaging-results {
  margin: 0 20px 16px;
  border: 1px solid #dbe4f6;
  border-radius: 12px;
  background: white;
}
.packaging-results > summary {
  cursor: pointer;
  padding: 14px;
  font-size: 12px;
  font-weight: 700;
  color: #33415a;
}
.packaging-results > .results {
  margin: 0 14px 14px;
}
.shard-list {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  padding: 0 14px 14px;
  font-size: 11px;
  color: #60708a;
}
.shard-list span {
  padding: 6px 9px;
  background: #f4f8ff;
  border-radius: 6px;
}
.stage-items {
  margin: 0;
  padding: 0;
  list-style: none;
  max-height: 190px;
  overflow: auto;
}
.stage-items li {
  display: flex;
  align-items: start;
  flex-wrap: wrap;
  gap: 5px;
  padding: 8px 0;
  border-bottom: 1px solid #edf1f7;
  font-size: 10px;
}
.stage-items li b {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}
.stage-items li small {
  flex-basis: 100%;
}
</style>
<style scoped src="./effect-template-mix-workflow.css"></style>
