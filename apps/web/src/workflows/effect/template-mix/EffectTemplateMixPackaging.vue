<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { AlertCircle, Workflow, X } from '@lucide/vue';
import { WorkflowRunProgress } from '@ai-marketing/ui';
import {
  packagingProgress,
  packagingStageSamples,
  packagingStageDetails,
  packagingStageState,
  currentPackagingRun,
  livePackagingItem,
} from './effect-packaging-progress';
import { createPackagingPoller } from './effect-packaging-poller';
import { PackagingBackgroundReader } from './effect-packaging-background-reader';
import type { PackagingStage } from './effect-packaging-progress';
import { PackagingSampleClock } from './effect-packaging-sample-clock';
import type { ScheduledPackagingClip } from './effect-packaging-sample-clock';
import {
  PACKAGING_STAGES,
  PACKAGING_STAGE_LABELS,
  packagingSlotBoundaryError,
  packagingPictureOnlyVariant,
} from '@ai-marketing/contracts';
import type {
  ApiResponse,
  EffectTemplateMixVariant,
  PackagingItem,
  PackagingRun,
  PackagingAudio,
} from '@ai-marketing/contracts';
import { apiUrl, requestJson } from '../../../api/http-client';
import {
  forgetPackagingNavigation,
  hasOpenedPackagingBranch,
  pendingPackagingNavigation,
  rememberPackagingNavigation,
} from './effect-packaging-navigation';

const props = defineProps<{
  projectId: string;
  workflowRunId: string;
  templateId: string;
  localUpdateActive?: boolean;
  variants: EffectTemplateMixVariant[];
  selectedVariantId: string;
  prepare: () => Promise<number | null>;
  playhead: number;
  seekVersion: number;
  playing: boolean;
  /**
   * Mirror the workbench's audio rows: one flag per row, so silencing a row leaves every other row
   * playing. Rows carry no meaning — every one of them is just 音频 — so the flag follows the row
   * number and `audioRowByClipId` says which row each clip is currently on.
   */
  audioRowMuted: boolean[];
  audioRowByClipId: Record<string, number>;
}>();
const emit = defineEmits<{
  selected: [item: PackagingItem | null];
  preview: [enabled: boolean];
  playbackFailed: [];
  playbackChanged: [];
  ready: [ready: boolean];
  started: [];
  submissionPending: [templateId: string, workflowRunId: string, variantId?: string];
  submissionSettled: [templateId: string, workflowRunId: string];
  /** A separate packaging branch started; the source workbench stays in place. */
  backgroundStarted: [run?: PackagingRun];
  backgroundFinished: [run: PackagingRun, variantId: string];
  status: [status: PackagingRun['status'] | null];
  appendPackaging: [run: PackagingRun | null];
  results: [items: PackagingItem[]];
  previewReadOnly: [readOnly: boolean];
  /** Films whose packaging failed; they will still be submitted, playing picture only. */
  failures: [failures: { variantId: string; name: string; message: string }[]];
}>();
const dialog = ref<HTMLDialogElement | null>(null);
const visible = ref(false),
  busy = ref(false),
  loading = ref(false);
const starting = ref(false);
const startingVariantId = ref('');
const requestError = ref(''), previewError = ref('');
const readUnavailable = ref(false);
const error = computed(() => requestError.value || previewError.value);
const runs = ref<PackagingRun[]>([]);
const backgroundRun = ref<PackagingRun | null>(null);
let backgroundTimer: ReturnType<typeof setTimeout> | undefined;
const backgroundReader = new PackagingBackgroundReader();
const displayedBackgroundRun = computed(() => backgroundRun.value);
const selectedStage = ref<PackagingStage | null>(null);
let generation = 0;
let pendingCreate: { fingerprint: string; key: string } | null = null;
const base = computed(() => `/projects/${props.projectId}/workflows/effect/template-mix`);
const run = computed(() => {
  const value = displayedBackgroundRun.value ?? currentPackagingRun(runs.value);
  return value ? { ...value, items: value.items.map(currentItem) } : undefined;
});
const completeCount = computed(
  () =>
    props.variants.filter((v) => v.slots.some((s) => v.bindings[s.id])).length,
);
const active = computed(() => runs.value.some((r) => ['QUEUED', 'RUNNING'].includes(r.status)));
const backgroundActive = computed(() =>
  ['QUEUED', 'RUNNING'].includes(backgroundRun.value?.status ?? ''),
);
const batchSubmitting = computed(() => starting.value && !startingVariantId.value);
const batchActive = computed(() => Boolean(progressRun.value));
const progressRun = computed(() => {
  // A new submission has no task progress yet. Never borrow the previous batch's results.
  if (batchSubmitting.value) return undefined;
  const all = [displayedBackgroundRun.value, ...runs.value].filter((run): run is PackagingRun => Boolean(run));
  const seen = new Set<string>();
  return all.find((run) => {
    if (seen.has(run.id)) return false;
    seen.add(run.id); // The directly polled task beats an older history copy of the same task.
    return run.operation !== 'SINGLE_PACKAGE' && run.operation !== 'APPEND_PACKAGE' &&
      ['QUEUED', 'RUNNING'].includes(run.status);
  });
});
// Finished tasks remain available in workflow details, never as workbench status banners.
const batchProgressVisible = computed(() =>
  batchSubmitting.value || Boolean(progressRun.value),
);
const manualRun = computed(() => currentPackagingRun(
  [displayedBackgroundRun.value, ...runs.value].filter((run): run is PackagingRun =>
    Boolean(run && run.operation !== 'APPEND_PACKAGE'))));
watch(manualRun, (value) => emit('status', value?.status ?? null), { immediate: true });
const progress = computed(
  () => progressRun.value?.execution?.progressPercent ?? packagingProgress(progressRun.value),
);
const executionSummary = computed(() => {
  if (!batchProgressVisible.value) return '';
  const value = progressRun.value;
  if (!value) return '';
  const e = value.execution;
  const base = `已完成 ${value.counts.completed} / ${value.counts.total} 条 · ${value.counts.shards} 个分片`;
  if (!e) return base;
  const eta =
    e.estimatedRemainingSeconds === null
      ? (active.value || backgroundActive.value) && e.delayed
        ? ' · 暂无可靠完成时间'
        : ''
      : ` · 预计剩余 ${Math.ceil(e.estimatedRemainingSeconds / 60)} 分钟${e.estimateBasis === 'BASELINE' ? '（初始估算）' : ''}`;
  return `${base} · 排队 ${e.queued} · 运行 ${e.running}${eta}`;
});
const progressSummary = computed(() => {
  if (batchSubmitting.value) return '智能成片包装 · 正在提交任务…';
  if (!batchProgressVisible.value) return '';
  const value = progressRun.value;
  if (!value) return '';
  const item = value.items.find((i) => i.status === 'RUNNING');
  const retrying = value.items.some((entry) => entry.status === 'RUNNING' &&
    [entry.checkpoint.recovery?.waitingUntil, ...Object.values(entry.checkpoint.voiceRecovery ?? {}).map((state) => state.waitingUntil)]
      .some((until) => until && Date.parse(until) > Date.now()));
  return `智能成片包装 · ${item ? PACKAGING_STAGE_LABELS[item.stage] : statusLabel[value.status]}${retrying ? ' · 自动重试中' : ''} · 阶段进度 ${progress.value}%`;
});
const stageStates = computed(
  () =>
    Object.fromEntries(
      PACKAGING_STAGES.map((stage) => [stage, packagingStageState(run.value?.items ?? [], stage)]),
    ) as Record<PackagingStage, ReturnType<typeof packagingStageState>>,
);
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
function currentItem(item: PackagingItem): PackagingItem {
  // Once generated, a package is the user's editable draft. Source/timeline changes do not expire it.
  return item;
}
const orderedRuns = computed(() => [backgroundRun.value, ...runs.value]
  .filter((run): run is PackagingRun => Boolean(run))
  .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)));
// A background child shares film IDs with its parent, but owns different audio, locks and drafts.
const workspaceRuns = computed(() => orderedRuns.value.filter((run) =>
  run.workflowRunId === props.workflowRunId && run.templateId === props.templateId));
watch(workspaceRuns, (runs) => emit('appendPackaging',
  runs.find((run) => run.operation === 'APPEND_PACKAGE') ?? null), { immediate: true });
const selected = computed(() => {
  const latest = workspaceRuns.value
    .flatMap((run) => run.items).find((item) => item.variantId === props.selectedVariantId);
  if (latest?.operation && ['QUEUED', 'RUNNING'].includes(latest.status)) return null;
  const item = workspaceRuns.value
    .flatMap((r) => r.items)
    .find((i) => i.variantId === props.selectedVariantId &&
      (!i.operation || i.status === 'COMPLETED'));
  const variant = props.variants.find((v) => v.id === props.selectedVariantId);
  const live = backgroundRun.value?.workflowRunId === props.workflowRunId &&
    backgroundRun.value.templateId === props.templateId ? livePackagingItem(backgroundRun.value, variant) : null;
  if (live && live.id === latest?.id) return live;
  if (!item || !variant) return null;
  return currentItem(item);
});
const selectedVariant = computed(() => {
  const variant = props.variants.find((variant) => variant.id === props.selectedVariantId);
  const latest = workspaceRuns.value.flatMap((run) => run.items)
    .find((item) => item.variantId === props.selectedVariantId);
  return variant && latest?.operation && ['QUEUED', 'RUNNING'].includes(latest.status)
    ? packagingPictureOnlyVariant(variant) : variant;
});
const boundaryError = computed(() => {
  const variant = props.variants.find((v) => v.id === props.selectedVariantId);
  return variant ? packagingSlotBoundaryError(variant) : null;
});
const fileUrl = (id: string) => apiUrl(`/projects/${props.projectId}/file-objects/${id}/content`);
watch(selected, (item) => emit('selected', item), { immediate: true });
watch([selected, backgroundRun], ([item, background]) => {
  emit('previewReadOnly', Boolean(item && background && item.runId === background.id &&
    background.workflowRunId !== props.workflowRunId));
}, { immediate: true });
watch([runs, backgroundRun], () => {
  const latest = new Map<string, PackagingItem>();
  for (const run of orderedRuns.value)
    for (const item of run.items) {
      const key = `${run.workflowRunId}:${item.variantId}`;
      if (!latest.has(key)) latest.set(key, item);
    }
  emit('results', [...latest.values()]);
}, { immediate: true });
const packageableVariants = computed(() =>
  props.variants.filter(
    (variant) =>
      variant.slots.some((slot) => Boolean(variant.bindings[slot.id])),
  ),
);
/**
 * How a variant's packaging ended, as far as 完成校验 is concerned. `FAILED` still counts as an
 * answer: the film is submitted as a picture-only one rather than holding the whole batch hostage.
 */
type Conclusion = 'PACKAGED' | 'FAILED' | 'PENDING';
function conclusion(variant: EffectTemplateMixVariant): {
  state: Conclusion;
  item?: PackagingItem;
} {
  const item = runs.value.flatMap((r) => r.items).find((i) => i.variantId === variant.id);
  if (!item) return { state: 'PENDING' };
  if (item.status === 'COMPLETED')
    return item.checkpoint.narrationLayoutVersion === 'SLOT_V1'
      ? { state: 'PACKAGED', item }
      : { state: 'PENDING' };
  return ['FAILED', 'CANCELLED'].includes(item.status)
    ? { state: 'FAILED', item }
    : { state: 'PENDING' };
}
const conclusions = computed(() =>
  packageableVariants.value.map((variant) => ({ variant, ...conclusion(variant) })),
);
const allReady = computed(
  () =>
    !active.value &&
    !readUnavailable.value &&
    packageableVariants.value.length > 0 &&
    conclusions.value.every((entry) => entry.state !== 'PENDING'),
);
const failures = computed(() =>
  conclusions.value
    .map((entry) => {
      const live = backgroundRun.value?.items.find((item) => item.variantId === entry.variant.id);
      return live ? { ...entry, item: live, state: ['FAILED', 'CANCELLED'].includes(live.status) ? 'FAILED' : 'PENDING' } : entry;
    })
    .filter((entry) => entry.state === 'FAILED')
    .map((entry) => ({
      variantId: entry.variant.id,
      name: entry.variant.name,
      message: entry.item?.errorMessage || '包装失败',
    })),
);
watch(allReady, (ready) => emit('ready', ready), { immediate: true });
watch(failures, (value) => emit('failures', value), { immediate: true });

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
    readUnavailable.value = false;
    if (!backgroundRun.value || !backgroundActive.value) void loadBackgroundRun();
  },
  onError() {
    // Read failures stay internal: retain the last result and let the poller reconnect.
    // Submission and playback errors still use their own user-facing error state.
    readUnavailable.value = true;
  },
  onLoading(value) {
    loading.value = value && !runs.value.length;
  },
  // Discover tasks started in another session even when this workspace is idle.
  interval: () => (props.localUpdateActive || visible.value || active.value || readUnavailable.value ? 4000 : 30_000),
});
const refresh = () => poller.refresh();
function loadBackgroundRun(): Promise<void> {
  return backgroundReader.read(async (signal, current) => {
    const version = generation;
    const path = base.value;
    const workflowRunId = props.workflowRunId;
    const templateId = props.templateId;
    if (!templateId) return;
    const pending = pendingPackagingNavigation(props.projectId, workflowRunId, templateId);
    try {
      const response = await requestJson<ApiResponse<PackagingRun | null>>(
        pending
          ? `${path}/packaging-runs/${pending.runId}`
          : `${path}/templates/${templateId}/background-packaging-run?workflowRunId=${workflowRunId}`,
        { operation: '读取后台包装任务', signal },
      );
      if (version !== generation || !current()) return;
      const found = response.data;
      if (!found) return;
      if (pending && (found.id !== pending.runId || found.workflowRunId !== pending.workflowRunId || found.templateId !== templateId)) {
        forgetPackagingNavigation(props.projectId, workflowRunId, templateId, pending.runId);
        return;
      }
      // An active run has its own serialized poll. A terminal run may have been resumed by
      // another session: install that response and restart polling, even when its id is unchanged.
      if (backgroundRun.value?.id === found.id && backgroundActive.value) return;
      backgroundRun.value = found;
      if (['QUEUED', 'RUNNING'].includes(found.status)) {
        emit('backgroundStarted', found);
        clearTimeout(backgroundTimer);
        backgroundTimer = setTimeout(() => void pollBackgroundRun(path, found.id, version), 4000);
      } else if (found.status === 'COMPLETED' || (found.operation && found.status === 'PARTIAL')) {
        const recentlyCompleted =
          found.completedAt !== null && Date.now() - Date.parse(found.completedAt) < 24 * 60 * 60 * 1000;
        if (
          (pending || recentlyCompleted) &&
          !hasOpenedPackagingBranch(props.projectId, workflowRunId, templateId, found.workflowRunId)
        )
          emit('backgroundFinished', found, pending?.variantId ?? props.selectedVariantId);
      } else if (pending) {
        forgetPackagingNavigation(props.projectId, workflowRunId, templateId, found.id);
      }
    } catch {
      // The next discovery read reconnects without replacing the last valid task.
    }
  });
}
async function pollBackgroundRun(path: string, runId: string, version: number) {
  try {
    const response = await requestJson<ApiResponse<PackagingRun>>(
      `${path}/packaging-runs/${runId}`,
      {
        operation: '读取新分支包装进度',
      },
    );
    if (version !== generation) return;
    backgroundRun.value = response.data;
    if (!['QUEUED', 'RUNNING'].includes(response.data.status)) {
      const pending = pendingPackagingNavigation(props.projectId, props.workflowRunId, props.templateId);
      if (response.data.status === 'COMPLETED')
        emit('backgroundFinished', response.data, pending?.runId === runId ? pending.variantId : props.selectedVariantId);
      else {
        if (pending?.runId === runId)
          forgetPackagingNavigation(props.projectId, props.workflowRunId, props.templateId, runId);
        emit('backgroundFinished', response.data, props.selectedVariantId);
      }
      return;
    }
  } catch {
    if (version !== generation) return;
  }
  backgroundTimer = setTimeout(() => void pollBackgroundRun(path, runId, version), 4000);
}
function refreshOnReturn() {
  if (props.templateId && document.visibilityState === 'visible') {
    void refresh();
    void loadBackgroundRun();
  }
}
async function open(mode: 'ACTION' | 'WORKFLOW') {
  if (mode === 'ACTION') {
    if (busy.value || active.value || backgroundActive.value) return;
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
  holdPlaybackAudio,
  continuePlaybackAudio,
  createSingle: () => create(props.selectedVariantId),
  startingVariantId,
  refresh,
  open,
  visible,
  busy,
  active,
  backgroundActive,
  batchActive,
  batchSubmitting,
  loading,
  starting,
  startPlaybackAudio,
  preparePlaybackAudio,
  stopPlaybackAudio,
  playbackAudioTime,
  hasPlaybackAudio,
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
async function create(variantId?: string) {
  if (busy.value) return;
  const context = {
    generation,
    path: base.value,
    templateId: props.templateId,
    workflowRunId: props.workflowRunId,
  };
  startingVariantId.value = variantId ?? '';
  emit('submissionPending', context.templateId, context.workflowRunId, variantId);
  starting.value = true;
  try {
    await execute(async () => {
      const expectedRevision = await props.prepare();
      if (context.generation !== generation) return;
      if (expectedRevision === null) throw new Error('请先保存时间轴草稿');
      const body = {
        workflowRunId: context.workflowRunId,
        expectedRevision,
        component: 'ALL' as const,
        operation: variantId ? 'SINGLE_PACKAGE' as const : 'BATCH_PACKAGE' as const,
        ...(variantId ? { variantId } : {}),
      };
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
      // Both a forked package and the first package in an already delivered Run need the
      // same completion handoff. Keeping the task in the background also survives a refresh.
      rememberPackagingNavigation(
        props.projectId,
        context.workflowRunId,
        context.templateId,
        response.data.id,
        response.data.workflowRunId,
        props.selectedVariantId,
      );
      backgroundReader.invalidate();
      backgroundRun.value = response.data;
      // Acceptance ends submission, even if the following history refresh is still pending.
      // Otherwise a fast task can finish while an unrelated GET leaves a stale 0% banner up.
      starting.value = false;
      startingVariantId.value = '';
      clearTimeout(backgroundTimer);
      backgroundTimer = setTimeout(
        () => void pollBackgroundRun(context.path, response.data.id, context.generation),
        4000,
      );
      emit('backgroundStarted', response.data);
    });
  } finally {
    if (context.generation === generation) {
      starting.value = false;
      startingVariantId.value = '';
      emit('submissionSettled', context.templateId, context.workflowRunId);
    }
  }
}

// Decode once, then schedule every narration and music clip on one audio-device clock.
const previewAvailable = computed(() => {
  const item = selected.value;
  return Boolean((item && item.status === 'COMPLETED') || selectedVariant.value?.voice || selectedVariant.value?.bgm);
});
watch(previewAvailable, (enabled) => {
  if (enabled) previewError.value = '';
  emit('preview', enabled);
}, { immediate: true });
const rowMuted = (clipId: string): boolean =>
  props.audioRowMuted[props.audioRowByClipId[clipId] ?? 0] ?? false;
const previewAudioClips = computed<ScheduledPackagingClip[]>(() => {
  if (!previewAvailable.value) return [];
  const checkpoint = selected.value?.checkpoint;
  const clips: ScheduledPackagingClip[] = Object.entries(checkpoint?.voices ?? {})
    .map(([lineId, audio]) => ({ id: `voice:${lineId}`, kind: 'VOICE', audio, muted: rowMuted(`voice:${lineId}`) }));
  for (const [captionId, audio] of Object.entries(checkpoint?.captionVoices ?? {})) {
    const id = `capvoice:${captionId}`;
    clips.push({ id, kind: 'VOICE', audio, muted: rowMuted(id) });
  }
  if (!checkpoint || checkpoint.narrationLayoutVersion !== 'SLOT_V1') {
    const legacy = selectedVariant.value?.voice as PackagingAudio | undefined;
    if (!clips.length && legacy) clips.push({ id: 'voice', kind: 'VOICE', audio: legacy, muted: rowMuted('voice') });
  }
  const music = checkpoint?.music ?? (checkpoint?.narrationLayoutVersion !== 'SLOT_V1'
    ? selectedVariant.value?.bgm as PackagingAudio | undefined : undefined);
  if (music) clips.push({ id: 'music', kind: 'MUSIC', audio: music, muted: rowMuted('music') });
  return clips;
});
const sampleClock = new PackagingSampleClock(fileUrl);
let audioPlaybackRequest = 0;
function hasPlaybackAudio(): boolean {
  return previewAudioClips.value.length > 0;
}
function playbackAudioTime(): number | null {
  return sampleClock.time();
}
function preparePlaybackAudio(): Promise<void> {
  return sampleClock.prepare(previewAudioClips.value);
}
async function startPlaybackAudio(seconds = props.playhead, frameReady?: Promise<boolean>): Promise<boolean> {
  previewError.value = '';
  const version = generation;
  const request = ++audioPlaybackRequest;
  try {
    return await sampleClock.start(previewAudioClips.value, seconds, frameReady);
  } catch {
    if (version === generation && request === audioPlaybackRequest) {
      previewError.value = '口播或配乐暂时无法播放，请再次点击播放；字幕不会提前继续。';
      emit('playbackFailed');
    }
    return false;
  }
}
function stopPlaybackAudio(): void {
  audioPlaybackRequest++;
  sampleClock.stop();
}
function holdPlaybackAudio(): Promise<void> {
  return sampleClock.hold();
}
async function continuePlaybackAudio(frameReady: Promise<boolean>): Promise<boolean> {
  try {
    return await sampleClock.continue(frameReady);
  } catch {
    emit('playbackFailed');
    return false;
  }
}
watch(() => JSON.stringify(previewAudioClips.value), () => {
  // The parent owns the frame barrier, including seeks and changed audio.
  if (props.playing) emit('playbackChanged');
  else void sampleClock.prepare(previewAudioClips.value).catch(() => undefined);
}, { immediate: true });
watch(() => props.playing, (playing) => {
  if (!playing) stopPlaybackAudio();
});
watch(() => props.selectedVariantId, () => stopPlaybackAudio());
watch(
  () => [props.projectId, props.workflowRunId, props.templateId],
  (_scope, previous) => {
    // The first committed batch item opens its child workspace. Keep that exact task across
    // the handoff, rather than emitting an empty result/lock set until the next GET finishes.
    const carriedRuns = previous?.[0] === props.projectId
      ? orderedRuns.value.filter((run) => run.workflowRunId === props.workflowRunId &&
        run.templateId === props.templateId)
      : [];
    generation++;
    poller.stop();
    backgroundReader.invalidate();
    clearTimeout(backgroundTimer);
    backgroundRun.value = null;
    runs.value = carriedRuns;
    pendingCreate = null;
    requestError.value = '';
    readUnavailable.value = false;
    previewError.value = '';
    busy.value = false;
    starting.value = false;
    startingVariantId.value = '';
    close();
    sampleClock.dispose();
    if (props.templateId) {
      void refresh();
      void loadBackgroundRun();
    }
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
  backgroundReader.invalidate();
  clearTimeout(backgroundTimer);
  window.removeEventListener('focus', refreshOnReturn);
  document.removeEventListener('visibilitychange', refreshOnReturn);
  sampleClock.dispose();
});
</script>

<template>
  <div v-if="boundaryError" class="notice error" role="alert">{{ boundaryError }}</div>
  <WorkflowRunProgress
    v-if="batchProgressVisible"
    class="packaging-progress"
    :progress="progress"
    :summary="progressSummary"
    :attempt-label="executionSummary"
    action-label="查看当前工作流"
    @show-details="open('WORKFLOW')"
  />
  <div v-if="error && !props.localUpdateActive && !visible && !active && !busy" class="notice error" role="alert">
    <AlertCircle :size="16" />{{ error }}
  </div>
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
    <div v-if="error && !props.localUpdateActive" class="notice error" role="alert">
      <AlertCircle :size="16" />{{ error }}
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
                ></small
              >
              <small v-if="stageState(stage).summary" class="packaging-stage-counts">{{
                stageState(stage).summary
              }}</small>
            </span>
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
              <li
                v-for="(sample, index) in selectedStageSamples.inputSamples"
                :key="`input-${index}`"
              >
                {{ sample }}
              </li>
            </ul>
            <p v-else class="workflow-detail-empty-samples">
              {{ run ? '当前阶段暂无已保存的输入样例' : '读取任务后显示实际输入样例' }}
            </p>
          </section>
          <section class="workflow-detail-block is-output">
            <span>OUTPUT</span><strong>本阶段结果示例（最多 4 项）</strong>
            <p>{{ packagingStageDetails[selectedStage].output }}</p>
            <ul v-if="selectedStageSamples.outputSamples.length">
              <li
                v-for="(sample, index) in selectedStageSamples.outputSamples"
                :key="`output-${index}`"
              >
                {{ sample }}
              </li>
            </ul>
            <p v-else class="workflow-detail-empty-samples">
              {{ run ? '当前阶段暂无已保存的结果样例' : '读取任务后显示实际结果样例' }}
            </p>
            <div v-if="selectedStageSamples.audioPreviews.length" class="workflow-audio-previews">
              <label
                v-for="(preview, index) in selectedStageSamples.audioPreviews"
                :key="`audio-${index}`"
              >
                <span>{{ preview.label }}</span>
                <audio controls preload="none" :src="fileUrl(preview.fileObjectId)">
                  {{ preview.label }}
                </audio>
              </label>
            </div>
            <p v-if="run" role="status">阶段状态：{{ stageState(selectedStage).label }}</p>
            <p v-else role="status">
              {{ loading || readUnavailable ? '正在读取结果…' : '尚未生成结果' }}
            </p>
          </section>
        </template>
      </aside>
    </main>
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
.workflow-graph-node small.packaging-stage-counts {
  color: #435b7d;
}
.workflow-audio-previews {
  display: grid;
  margin-top: 8px;
  gap: 8px;
}
.workflow-audio-previews label {
  display: grid;
  gap: 4px;
  color: #52617a;
  font-size: 9px;
}
.workflow-audio-previews audio {
  width: 100%;
  height: 32px;
}
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
