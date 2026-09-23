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
  packagingStageSamples,
  packagingStageDetails,
  packagingStageState,
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
const runs = ref<PackagingRun[]>([]);
const selectedStage = ref<PackagingStage | null>(null);
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
const selectedStageSamples = computed(() =>
  selectedStage.value && run.value
    ? packagingStageSamples(run.value.items, selectedStage.value)
    : { inputSamples: [], outputSamples: [], audioPreviews: [] },
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
  },
  onError(reason) {
    loadError.value = reason instanceof Error ? reason.message : '读取包装失败';
  },
  onLoading(value) {
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
async function create() {
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
      const body = { workflowRunId: context.workflowRunId, expectedRevision, component: 'ALL' as const };
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
        <p>点击节点查看本阶段的输入与输出结果。</p>
      </div>
      <button class="workflow-graph-close" aria-label="关闭包装工作流" @click="close">
        <X :size="18" />
      </button>
    </header>
    <div v-if="error" class="notice error" role="alert">
      <AlertCircle :size="16" />{{ error
      }}<button :disabled="busy" @click="refresh">重新读取</button>
    </div>
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
          <Workflow :size="30" /><strong>选择节点查看输入与输出</strong>
          <p>点击左侧节点，查看该阶段接收什么、产出什么。</p>
        </div>
        <template v-else>
          <header class="workflow-node-detail-header">
            <div>
              <span>NODE DETAIL</span><strong>{{ PACKAGING_STAGE_LABELS[selectedStage] }}</strong>
            </div>
          </header>
          <section class="workflow-detail-block is-input">
            <span>INPUT</span><strong>本阶段输入示例（最多 4 项）</strong>
            <p>{{ packagingStageDetails[selectedStage].input }}</p>
            <ul v-if="selectedStageSamples.inputSamples.length">
              <li v-for="(sample, index) in selectedStageSamples.inputSamples" :key="`input-${index}`">
                {{ sample }}
              </li>
            </ul>
            <p v-else class="workflow-detail-empty-samples">{{ run ? '当前阶段暂无已保存的输入样例' : '读取任务后显示实际输入样例' }}</p>
          </section>
          <section class="workflow-detail-block is-output">
            <span>OUTPUT</span><strong>本阶段结果示例（最多 4 项）</strong>
            <p>{{ packagingStageDetails[selectedStage].output }}</p>
            <ul v-if="selectedStageSamples.outputSamples.length">
              <li v-for="(sample, index) in selectedStageSamples.outputSamples" :key="`output-${index}`">
                {{ sample }}
              </li>
            </ul>
            <p v-else class="workflow-detail-empty-samples">{{ run ? '当前阶段暂无已保存的结果样例' : '读取任务后显示实际结果样例' }}</p>
            <div v-if="selectedStageSamples.audioPreviews.length" class="workflow-audio-previews">
              <label v-for="(preview, index) in selectedStageSamples.audioPreviews" :key="`audio-${index}`">
                <span>{{ preview.label }}</span>
                <audio controls preload="none" :src="fileUrl(preview.fileObjectId)">{{ preview.label }}</audio>
              </label>
            </div>
            <p v-if="run" role="status">阶段状态：{{ stageState(selectedStage).label }}</p>
            <p v-else role="status">{{ loading ? '正在读取结果…' : loadError ? '暂时无法读取结果' : '尚未生成结果' }}</p>
          </section>
        </template>
      </aside>
    </main>
    <footer>
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
button:focus-visible {
  outline: 2px solid #2563eb;
  outline-offset: 3px;
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
p {
  line-height: 1.7;
}
.packaging-dialog > header p {
  margin: 6px 0 0;
  font-size: 13px;
  color: #6881a6;
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
@media (max-width: 700px) {
  .packaging-dialog > header {
    padding: 14px;
  }
}
.packaging-progress {
  margin: 8px 12px;
  flex-shrink: 0;
}
.workflow-graph-node small.packaging-stage-counts { color: #435b7d; }
.workflow-audio-previews { display: grid; margin-top: 8px; gap: 8px; }
.workflow-audio-previews label { display: grid; gap: 4px; color: #52617a; font-size: 9px; }
.workflow-audio-previews audio { width: 100%; height: 32px; }
.packaging-dialog {
  max-width: calc(100vw - 32px);
}
.packaging-dialog > footer {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
}
</style>
<style scoped src="./effect-template-mix-workflow.css"></style>
