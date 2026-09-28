<script setup lang="ts">
import type {
  EffectImportProduct,
  EffectTemplateMixAiRun,
  EffectTemplateMixCaption,
  EffectTemplateMixClassificationPool,
  EffectTemplateMixDraft,
  EffectTemplateMixDetachedAudio,
  EffectTemplateMixMaterial,
  EffectTemplateMixPurpose,
  EffectTemplateMixRole,
  EffectTemplateMixSlot,
  EffectTemplateMixTemplateEntry,
  EffectTemplateMixTransition,
  EffectTemplateMixVariant,
  PackagingAudio,
  PackagingAudioEdit,
  PackagingCaptionBox,
  PackagingCheckpoint,
  PackagingItem,
  PackagingRun,
} from '@ai-marketing/contracts';
import {
  effectTemplateMixContentDuration,
  PACKAGING_AUDIO_DB_CEILING,
  PACKAGING_AUDIO_DB_FLOOR,
  PACKAGING_AUDIO_GAIN_CEILING,
  packagingAudioFade,
  packagingAudioFromDb,
  packagingAudioToDb,
} from '@ai-marketing/contracts';
import {
  ParameterAdjustList,
  WorkflowNodeDraftBar,
  WorkflowNodeFooter,
  WorkflowRunProgress,
} from '@ai-marketing/ui';
import type { ParameterAdjustItem } from '@ai-marketing/ui';
import {
  AlertCircle,
  ArrowLeft,
  AudioLines,
  Blend,
  Bot,
  Captions,
  CheckCircle2,
  Clapperboard,
  Film,
  Focus,
  Layers3,
  LoaderCircle,
  Lock,
  Maximize2,
  Minimize2,
  Music2,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  WandSparkles,
  Workflow,
  X,
  ZoomIn,
  ZoomOut,
} from '@lucide/vue';
import {
  computed,
  nextTick,
  onActivated,
  onBeforeUnmount,
  onDeactivated,
  onMounted,
  reactive,
  ref,
  watch,
} from 'vue';

import {
  createEffectCaptionVoice,
  createEffectTemplateMixAiRun,
  createEmptyEffectTemplateMixVariant,
  getEffectTemplateMixAiRun,
  loadEffectTemplateMixWorkspace,
  saveEffectTemplateMixDraft,
  serializeEffectTemplateMixDraft,
  completeEffectTemplateMixPackaging,
  updateEffectPackagingAudio,
} from './api/effect-template-mix.api';
import { apiUrl } from '../../../api/http-client';
import {
  EFFECT_TEMPLATE_MIX_ROLE_LABELS,
  EFFECT_TEMPLATE_MIX_TRANSITION_LIBRARY,
  EFFECT_TEMPLATE_MIX_TRANSITIONS,
  cloneMix,
  createEffectTemplateMixEntry,
  effectTemplateMixTiming,
  effectTemplateMixTransitionDuration,
  formatEffectTemplateMixTime,
  markEffectTemplateMixChanged,
  moveEffectTemplateMixSlot,
} from './effect-template-mix-state';
import {
  effectTemplateMixDissolvePlaybackKeyframes,
  effectTemplateMixFlashPlaybackKeyframes,
  effectTemplateMixTransitionPresentation,
} from './effect-template-mix-transition';
import EffectTemplateMixThumbnail from './EffectTemplateMixThumbnail.vue';
import EffectTemplateMixTimeline from './EffectTemplateMixTimeline.vue';
import EffectTemplateMixPackaging from './EffectTemplateMixPackaging.vue';
import { packagingActionText, packagingLockMessage } from './effect-packaging-progress';
import {
  DEFAULT_AUDIO_LANE,
  audioRowOf as audioRowOfClip,
  audioRowOfKey,
  compactAudioLanes,
  rawAudioLane,
  timelineAudioClipRefs,
  type AudioRowTrack,
} from './effect-template-mix-audio-lanes';
import EffectVoiceLibrary from './EffectVoiceLibrary.vue';
import EffectMusicLibrary from './EffectMusicLibrary.vue';
import { pauseEffectTemplateMixThumbnailCapture } from './effect-template-mix-thumbnail-cache';
import { pauseEffectTemplateMixWaveformDecoding } from './effect-template-mix-waveform-cache';
import EffectSegmentRenderSourcePrompt from '../segment-render/components/EffectSegmentRenderSourcePrompt.vue';

const props = defineProps<{
  products: EffectImportProduct[];
  projectId: string;
  workflowRunId: string;
  previewTarget?: {
    projectId: string;
    workflowRunId: string;
    templateId: string;
    variantId: string;
  } | null;
}>();
const emit = defineEmits<{ back: []; next: [] }>();
type Notice = { kind: 'error' | 'success' | 'warning'; text: string };
type TemplateUi = { selectedSlotId: string; selectedVariantId: string };

const pageState = ref<'ERROR' | 'LOADING' | 'READY'>('LOADING');
const errorMessage = ref('');
const catalog = ref<EffectTemplateMixTemplateEntry[]>([]);
// Keep the confirmed pool even when a project has no templates yet.
const sourceMaterials = ref<EffectTemplateMixMaterial[]>([]);
const activeTemplateId = ref('');
const draftRevision = ref<number | null>(null);
const packagingPanel = ref<InstanceType<typeof EffectTemplateMixPackaging> | null>(null);
const selectedPackaging = ref<PackagingItem | null>(null);
const packagingPreviewEnabled = ref(false);
const packagingReady = ref(false);
const packagingRunStatus = ref<PackagingRun['status'] | null>(null);
/**
 * Films the packaging gave up on. They no longer block 完成校验 — they are submitted as picture-only
 * ones — but a film that quietly loses its narration is a surprise, so every one of them is named.
 */
const packagingFailures = ref<{ variantId: string; name: string; message: string }[]>([]);
const stalePackagingVariantIds = ref<Set<string>>(new Set());
const packagingFailureByVariant = computed(
  () => new Map(packagingFailures.value.map((failure) => [failure.variantId, failure])),
);
const packagingLockNotice = computed(() => packagingLockMessage(packagingRunStatus.value));
const packagingActionLabel = computed(() =>
  packagingActionText(packagingReady.value, packagingRunStatus.value),
);
const packagingActionBlockReason = computed(() => {
  const entry = activeEntry.value;
  if (!entry) return null;
  if (entry.needsAiFill)
    return '当前模板或成片仍需重新智能填充；请先更新素材并完成混剪校验。';

  // Packaging submits every complete variant in this template as one batch. Check all of those
  // variants, not only the selected card, so an expired source cannot leave an apparently usable
  // batch action that the API will reject.
  const materialById = new Map(
    (workspace.value?.materials ?? []).map((material) => [material.id, material]),
  );
  const completeVariants = entry.workspace.variants.filter(
    (variant) =>
      variant.slots.length > 0 && variant.slots.every((slot) => variant.bindings[slot.id]),
  );
  const hasStaleSource = completeVariants.some((variant) =>
    variant.slots.some((slot) => {
      const materialId = variant.bindings[slot.id];
      const material = materialId ? materialById.get(materialId) : undefined;
      return (
        !material?.available ||
        !Number.isInteger(variant.bindingRevisions[slot.id]) ||
        material.artifactRevision !== variant.bindingRevisions[slot.id]
      );
    }),
  );
  return hasStaleSource
    ? '本模板有成片引用了过期素材；请先在视频渲染节点更新素材，再智能填充并完成校验。'
    : null;
});
let completionKey: { signature: string; key: string } | null = null;
const committedVersions = reactive<Record<string, number>>({});
const uiByTemplate = reactive<Record<string, TemplateUi>>({});
const view = ref<'CONFIG' | 'EDITOR'>('CONFIG');
const saveState = ref<'dirty' | 'saved' | 'saving'>('saved');
const validating = ref(false);
const mutating = ref(false);
const fillStartPending = ref(false);
const aiRuns = ref<EffectTemplateMixAiRun[]>([]);
const classificationPools = ref<EffectTemplateMixClassificationPool[]>([]);
const activeAiRun = computed(
  () =>
    aiRuns.value.find(
      (run) =>
        run.templateId === activeTemplateId.value &&
        (run.status === 'QUEUED' || run.status === 'RUNNING'),
    ) ?? null,
);
const failedAiRun = computed(() => {
  const latest = aiRuns.value.find((run) => run.templateId === activeTemplateId.value);
  return latest?.status === 'FAILED' ? latest : null;
});
const aiStageLabels: Record<EffectTemplateMixAiRun['stage'], string> = {
  CLASSIFYING: '大模型按 Prompt 归槽',
  MATCHING: '计算六槽位最优匹配',
  SAMPLING: '抽取选中视频关键帧',
  TRIMMING: '大模型选择截取区间',
  COMPLETED: '时间轴已生成',
};
const resourceTab = ref<'VOICE' | 'MUSIC' | 'MATERIAL' | 'TEXT' | 'TRANSITION'>('MATERIAL');
const keyword = ref('');
const transitionKeyword = ref('');
const activeTransitionSlotId = ref('');
const transitionPreviewDurations = reactive<Record<string, number>>({});
const transitionCategoriesExpanded = ref(true);
const clearTransitionPreviews = (): void => {
  Object.keys(transitionPreviewDurations).forEach((slotId) => {
    delete transitionPreviewDurations[slotId];
  });
};
const materialRoleFilter = ref<'ALL' | EffectTemplateMixRole>('ALL');
const materialPage = ref(1);
const draggingMaterialId = ref('');
const materialPointerDrag = ref<{
  materialId: string;
  startX: number;
  startY: number;
  clientX: number;
  clientY: number;
  active: boolean;
  targetSlotId: string;
} | null>(null);
let materialDragGhost: HTMLElement | null = null;
let suppressMaterialClick = false;
const auditionMaterial = ref<EffectTemplateMixMaterial | null>(null);
const promptMaterial = ref<EffectTemplateMixMaterial | null>(null);
const slotMoveMaterial = ref<EffectTemplateMixMaterial | null>(null);
const auditionPlayer = ref<HTMLVideoElement | null>(null);
const auditionPlaying = ref(false);
const auditionTime = ref(0);
const playing = ref(false);
/** Player-owned track controls mirror the timeline header buttons. */
const videoTrackMuted = ref(false);
/**
 * One mute per audio row, indexed by row. A row is a position rather than an identity — every
 * audio row is just 音频 — so the flag belongs to the row number, exactly like the header button
 * that sets it, and it is not carried along when a clip moves to another row.
 */
const audioRowMuted = ref<boolean[]>([]);
const videoTrackVisible = ref(true);
const captionTrackVisible = ref(true);
const setTimelineTrackMute = (track: 'VIDEO' | AudioRowTrack, muted: boolean): void => {
  if (track === 'VIDEO') {
    videoTrackMuted.value = muted;
    return;
  }
  const row = audioRowOfKey(track);
  const rows = [...audioRowMuted.value];
  while (rows.length <= row) rows.push(false);
  rows[row] = muted;
  audioRowMuted.value = rows;
  // The detached players are the only ones this page drives itself; packaged audio follows through
  // the packaging panel, which reads the same per-row flags.
  syncDetachedAudio(true);
};
const setTimelineTrackVisibility = (track: 'CAPTION' | 'VIDEO', visible: boolean): void => {
  if (track === 'VIDEO') videoTrackVisible.value = visible;
  else captionTrackVisible.value = visible;
};
const playhead = ref(0);
const playbackSeekVersion = ref(0);
const playerPanel = ref<HTMLElement | null>(null);
const playerScrubber = ref<HTMLInputElement | null>(null);
const playerScrubberFill = ref<HTMLElement | null>(null);
const playerScrubberThumb = ref<HTMLElement | null>(null);
const playerTimecode = ref<HTMLSpanElement | null>(null);
const stageElement = ref<HTMLElement | null>(null);
/** The render burns captions at roughly 1/22 of the video width, so the preview matches. */
const stageCaptionFontSize = ref(14);
const playerMenu = ref<'DISPLAY' | null>(null);
const previewZoom = ref(100);
const playerFullscreen = ref(false);
const materialAudioPresence = reactive<Record<string, boolean | undefined>>({});
const createOpen = ref(false);
const workflowDialogOpen = ref(false);
const selectedWorkflowStage = ref<EffectTemplateMixAiRun['stage'] | null>(null);
const notice = ref<Notice | null>(null);
const newTemplateName = ref('新品跑量模板');
const templateNameBeforeEdit = ref('');
const templateNameKey = (name: string): string => name.normalize('NFKC').trim().toLowerCase();
const hasTemplateNameConflict = (name: string, exceptId?: string): boolean => {
  const key = templateNameKey(name);
  return Boolean(
    key &&
    catalog.value.some(
      (entry) => entry.id !== exceptId && templateNameKey(entry.workspace.template.name) === key,
    ),
  );
};
const createTemplateNameConflict = computed(() => hasTemplateNameConflict(newTemplateName.value));
const activeTemplateNameConflict = computed(() =>
  workspace.value
    ? hasTemplateNameConflict(workspace.value.template.name, activeTemplateId.value)
    : false,
);
const nextAvailableTemplateName = (baseName: string): string => {
  if (!hasTemplateNameConflict(baseName)) return baseName;
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${baseName} ${suffix}`;
    if (!hasTemplateNameConflict(candidate)) return candidate;
  }
  return `${baseName} ${crypto.randomUUID().slice(0, 8)}`;
};
const displayedTimelineSlotId = ref('');
const playerUnavailableSlotId = ref('');
const transitionFrame = ref('');
const timelinePlayers = new Map<string, HTMLVideoElement>();
const detachedAudioPlayers = new Map<string, HTMLAudioElement>();
let primedTimelinePlayers = new WeakSet<HTMLVideoElement>();
let positionedTimelinePlayers = new WeakSet<HTMLVideoElement>();
const workbenchMain = ref<HTMLElement | null>(null);
const materialGrid = ref<HTMLElement | null>(null);
const materialGridWidth = ref(0);
const leftPaneWidth = ref(480);
const rightPaneWidth = ref(270);
const topPaneHeight = ref(480);
const timelineHeight = ref(260);
const compactWorkbench = ref(false);
const resetWorkbenchDefaults = (): void => {
  resourceTab.value = 'MATERIAL';
  keyword.value = '';
  transitionKeyword.value = '';
  materialRoleFilter.value = 'ALL';
  materialPage.value = 1;
  activeTransitionSlotId.value = '';
  clearTransitionPreviews();
  transitionCategoriesExpanded.value = true;
};
const resizingPane = ref<'LEFT' | 'RIGHT' | null>(null);
const resizingEditorHeight = ref<{
  startClientY: number;
  startTopHeight: number;
  totalHeight: number;
} | null>(null);
const TIMELINE_FPS = 30;
const LEFT_PANE_MIN_WIDTH = 230;
const LEFT_PANE_MAX_WIDTH = 680;
const CENTER_PANE_MIN_WIDTH = 380;
const AUDIO_METER_LEVELS = [2, 4, 3] as const;
/**
 * The checkpoint the selected packaging item was showing, so a subtitle edit can be undone. The
 * timeline writes to two places — rows and video geometry on the variant, everything the packer
 * produced (subtitles, narration, music, subtitle boxes) on the server-owned checkpoint — so a
 * snapshot that only carried the variant would restore nothing after a subtitle gesture.
 */
type TimelinePackagingSnapshot = {
  checkpoint: PackagingCheckpoint;
  itemId: string;
  updatedAt: string;
};
type TimelineEditSnapshot = {
  packaging: TimelinePackagingSnapshot | null;
  selectedSlotId: string;
  variant: EffectTemplateMixVariant;
};
const timelineUndoStack = ref<TimelineEditSnapshot[]>([]);
const timelineRedoStack = ref<TimelineEditSnapshot[]>([]);
const createNameInput = ref<HTMLInputElement | null>(null);
const dialogTrigger = ref<HTMLElement | null>(null);
const promptCloseButton = ref<HTMLButtonElement | null>(null);
const slotMoveCloseButton = ref<HTMLButtonElement | null>(null);
const workflowTrigger = ref<HTMLButtonElement | null>(null);
const workflowCloseButton = ref<HTMLButtonElement | null>(null);
let controller: AbortController | undefined;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let noticeTimer: ReturnType<typeof setTimeout> | undefined;
let pendingSave: Promise<boolean> | undefined;
let playbackAnimationFrame: number | undefined;
let playerScrubberAnimations: Animation[] = [];
let dissolvePlaybackAnimation: Animation | null = null;
let flashPlaybackAnimation: Animation | null = null;
let dissolvePlaybackSignature = '';
const transitionOverlayElement = ref<HTMLDivElement | null>(null);
let playbackAnchorMilliseconds = 0;
let playbackAnchorSeconds = 0;
let lastUiPlaybackMilliseconds = 0;
let playbackSyncBoundaries: number[] = [];
let nextPlaybackBoundaryIndex = 0;
let activePlaybackSlotId = '';
let activeTransitionSignature = '';
let pendingSeekSyncFrame: number | undefined;
let seekSyncRequestId = 0;
let materialGridResizeObserver: ResizeObserver | null = null;
let materialGridResizeFrame: number | undefined;
let stageResizeObserver: ResizeObserver | null = null;
let stageResizeFrame: number | undefined;
const pollTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pollControllers = new Map<string, AbortController>();

const activeEntry = computed(
  () => catalog.value.find(({ id }) => id === activeTemplateId.value) ?? null,
);
const packagingLocked = computed(() => Boolean(activeEntry.value?.packagingLocked));
const projectEditLocked = computed(() =>
  Boolean(
    activeEntry.value?.aiFillLocked ||
    activeAiRun.value ||
    fillStartPending.value ||
    (packagingLocked.value &&
      (!packagingRunStatus.value || ['QUEUED', 'RUNNING'].includes(packagingRunStatus.value))),
  ),
);
const templateEditLocked = computed(() => projectEditLocked.value || packagingLocked.value);
/**
 * The voice only feeds future packaging and voice redos, never existing audio, so it stays editable
 * once the run has finished. It is still locked while a run is in flight, because that run already
 * froze its own voice.
 */
const voiceSelectLocked = computed(() => projectEditLocked.value);
const workspace = computed(() => activeEntry.value?.workspace ?? null);
const activeUi = computed(() =>
  activeEntry.value ? uiByTemplate[activeEntry.value.id] : undefined,
);
const selectedVariant = computed(
  () =>
    workspace.value?.variants.find(({ id }) => id === activeUi.value?.selectedVariantId) ??
    workspace.value?.variants[0] ??
    null,
);
/**
 * Which row each visible audio clip sits on, using the same definition the timeline draws with.
 * Muting is a property of the row rather than of the clip, so every playback path has to resolve a
 * clip to its row through here or the row a clip is drawn on and the row that silences it diverge.
 */
const audioRowByClipId = computed<Record<string, number>>(() => {
  const refs = timelineAudioClipRefs(
    selectedVariant.value,
    selectedPackaging.value,
    workspace.value?.materials ?? [],
    props.projectId,
  );
  const lanes = selectedVariant.value?.audioLanes;
  return Object.fromEntries(refs.map((ref) => [ref.id, audioRowOfClip(refs, lanes, ref.id)]));
});
const mutedAudioClip = (clipId: string): boolean =>
  audioRowMuted.value[audioRowByClipId.value[clipId] ?? 0] ?? false;
const selectedVariantRefreshSlotIds = computed(() => {
  const variant = selectedVariant.value;
  if (!variant || !workspace.value) return [];
  return variant.slots.flatMap((slot) => {
    const materialId = variant.bindings[slot.id];
    const material = materialId
      ? workspace.value?.materials.find(({ id }) => id === materialId)
      : undefined;
    const boundRevision = variant.bindingRevisions[slot.id];
    return material?.available &&
      (typeof boundRevision !== 'number' ||
        !Number.isInteger(boundRevision) ||
        material.artifactRevision > boundRevision)
      ? [slot.id]
      : [];
  });
});
const canUndoTimeline = computed(() => timelineUndoStack.value.length > 0);
const canRedoTimeline = computed(() => timelineRedoStack.value.length > 0);
const clearTimelineHistory = (): void => {
  timelineUndoStack.value = [];
  timelineRedoStack.value = [];
};
const captureTimelineSnapshot = (): TimelineEditSnapshot | null => {
  const variant = selectedVariant.value;
  if (!variant) return null;
  const item = selectedPackaging.value;
  return {
    packaging: item
      ? { checkpoint: cloneCheckpoint(item.checkpoint), itemId: item.id, updatedAt: item.updatedAt }
      : null,
    selectedSlotId: activeUi.value?.selectedSlotId ?? '',
    variant: cloneMix(variant),
  };
};
const rememberTimelineEdit = (): void => {
  const snapshot = captureTimelineSnapshot();
  if (!snapshot) return;
  timelineUndoStack.value = [...timelineUndoStack.value.slice(-49), snapshot];
  timelineRedoStack.value = [];
};
const restoreTimelineSnapshot = (snapshot: TimelineEditSnapshot): void => {
  const variants = workspace.value?.variants;
  if (!variants) return;
  const index = variants.findIndex(({ id }) => id === snapshot.variant.id);
  if (index < 0) return;
  variants.splice(index, 1, cloneMix(snapshot.variant));
  // Subtitles and subtitle boxes live on the server-owned checkpoint, so the variant alone is not the
  // whole story — writing back only the variant would leave the text unchanged and read as "undo did
  // nothing". `editPackagingAudio`'s baseline rule is reused so the revert is diffed against what the
  // server actually holds: an edit still inside the debounce window has nothing to send, a saved one
  // does. The completed packaging remains writable even when its source is marked stale.
  const packaging = snapshot.packaging;
  const item = selectedPackaging.value;
  if (
    packaging &&
    item &&
    item.id === packaging.itemId &&
    item.runId &&
    item.status === 'COMPLETED'
  ) {
    if (audioBaseline?.itemId !== item.id) {
      audioBaseline = {
        itemId: item.id,
        checkpoint: cloneCheckpoint(item.checkpoint),
        updatedAt: item.updatedAt,
      };
    }
    item.checkpoint = cloneCheckpoint(packaging.checkpoint);
    scheduleAudioEdit();
  }
  if (activeUi.value) activeUi.value.selectedSlotId = snapshot.selectedSlotId;
  playhead.value = Math.min(playhead.value, currentDuration.value);
  resetTimelinePlayerState();
  bump();
};
const undoTimelineEdit = (): void => {
  const target = timelineUndoStack.value.at(-1);
  const current = captureTimelineSnapshot();
  if (!target || !current || target.variant.id !== current.variant.id) return;
  timelineUndoStack.value = timelineUndoStack.value.slice(0, -1);
  timelineRedoStack.value = [...timelineRedoStack.value.slice(-49), current];
  restoreTimelineSnapshot(target);
};
const redoTimelineEdit = (): void => {
  const target = timelineRedoStack.value.at(-1);
  const current = captureTimelineSnapshot();
  if (!target || !current || target.variant.id !== current.variant.id) return;
  timelineRedoStack.value = timelineRedoStack.value.slice(0, -1);
  timelineUndoStack.value = [...timelineUndoStack.value.slice(-49), current];
  restoreTimelineSnapshot(target);
};
const selectedSlot = computed(() => {
  const slots =
    view.value === 'EDITOR'
      ? (selectedVariant.value?.slots ?? [])
      : (workspace.value?.template.slots ?? []);
  const selected = slots.find(({ id }) => id === activeUi.value?.selectedSlotId) ?? null;
  return view.value === 'EDITOR' ? selected : (selected ?? slots[0] ?? null);
});
const selectedTransitionInfo = computed(() => {
  const variant = selectedVariant.value;
  const slot = variant?.slots.find(({ id }) => id === activeTransitionSlotId.value) ?? null;
  if (!variant || !slot) return null;
  const index = variant.slots.findIndex(({ id }) => id === slot.id);
  if (index <= 0 || slot.transition === '硬切') return null;
  const previous = variant.slots[index - 1];
  if (!previous) return null;
  return {
    name: slot.transition,
    slotId: slot.id,
    duration:
      transitionPreviewDurations[slot.id] ?? effectTemplateMixTransitionDuration(slot, previous),
    max: Math.min(5, slot.duration, previous.duration),
  };
});
const filteredTransitions = computed(() => {
  const query = transitionKeyword.value.trim().toLowerCase();
  return EFFECT_TEMPLATE_MIX_TRANSITION_LIBRARY.filter((item) => {
    if (item.id !== '硬切' && item.category !== '热门') return false;
    if (!query) return true;
    return `${item.label} ${item.description} ${item.category}`.toLowerCase().includes(query);
  });
});
const templateTiming = computed(() =>
  effectTemplateMixTiming(workspace.value?.template.slots ?? []),
);
const currentTiming = computed(() => {
  const variant = selectedVariant.value;
  const base = effectTemplateMixTiming(variant?.slots ?? []);
  if (!variant) return base;
  const slots = base.slots.map((range) => {
    const start = Math.max(0, variant.timelineStarts?.[range.id] ?? range.start);
    const duration = range.end - range.start;
    return { id: range.id, start, end: start + duration };
  });
  return {
    duration: Math.max(base.duration, ...slots.map(({ end }) => end)),
    slots,
  };
});
const materialForSlot = (
  slotId: string,
  variant: EffectTemplateMixVariant | null = selectedVariant.value,
): EffectTemplateMixMaterial | null =>
  workspace.value?.materials.find(({ id }) => id === variant?.bindings[slotId]) ?? null;
const variantDuration = (variant: EffectTemplateMixVariant): number => {
  const timing = effectTemplateMixTiming(variant.slots);
  const occupiedEnds = timing.slots
    .map((range) => {
      const start = Math.max(0, variant.timelineStarts?.[range.id] ?? range.start);
      return { id: range.id, end: start + (range.end - range.start) };
    })
    .filter(({ id }) => Boolean(materialForSlot(id, variant)))
    .map(({ end }) => end);
  return occupiedEnds.length ? Math.max(...occupiedEnds) : 0;
};
/**
 * The film's length: the furthest end over everything on the timeline, not just the video clips.
 * An audio or caption clip carried past the last video clip extends the film, so the playhead range,
 * the seek bounds and the timeline's own scale all follow the furthest piece of content.
 */
const currentDuration = computed(() => {
  const variant = selectedVariant.value;
  if (!variant) return templateTiming.value.duration;
  return Math.max(
    variantDuration(variant),
    effectTemplateMixContentDuration(variant, selectedPackaging.value?.checkpoint),
  );
});
const coverMaterial = (variant: EffectTemplateMixVariant): EffectTemplateMixMaterial | null =>
  variant.slots.map((slot) => materialForSlot(slot.id, variant)).find(Boolean) ?? null;
const selectedMaterial = computed(() =>
  selectedSlot.value ? materialForSlot(selectedSlot.value.id) : null,
);
const slotMoveSourceLabel = computed(() => {
  const materialId = slotMoveMaterial.value?.id;
  const variant = selectedVariant.value;
  return variant?.slots.find((slot) => variant.bindings[slot.id] === materialId)?.label || '未分配';
});
const slotMoveOptions = computed(() => {
  const variant = selectedVariant.value;
  return variant
    ? variant.slots.map((slot) => ({ slot, materialId: variant.bindings[slot.id] ?? '' }))
    : [];
});
const materialUsageLabel = (materialId: string): string => {
  const variant = selectedVariant.value;
  if (!variant) return '';
  const slot = variant.slots.find(({ id }) => variant.bindings[id] === materialId);
  return slot ? EFFECT_TEMPLATE_MIX_ROLE_LABELS[slot.role] : '';
};
const previewSlot = computed(() => {
  const variant = selectedVariant.value;
  if (!variant?.slots.length) return null;
  // Keep the playhead's public time at the exact project end, but resolve the
  // visible frame one video tick before the clip boundary so the final frame
  // remains visible instead of falling through to the blackout layer.
  const safeTime = Math.min(
    Math.max(0, playhead.value),
    Math.max(0, currentDuration.value - 1 / TIMELINE_FPS),
  );
  const candidates = currentTiming.value.slots
    .map((range, index) => ({
      index,
      lane: variant.videoLanes?.[range.id] ?? 0,
      range,
    }))
    .filter(({ range }) => safeTime >= range.start && safeTime < range.end)
    .sort(
      (left, right) =>
        left.lane - right.lane || right.range.start - left.range.start || right.index - left.index,
    );
  return candidates.length ? (variant.slots[candidates[0]!.index] ?? null) : null;
});
type ActiveTransitionPreview = {
  duration: number;
  end: number;
  incomingSlot: EffectTemplateMixSlot;
  outgoingSlot: EffectTemplateMixSlot;
  progress: number;
  start: number;
  transition: EffectTemplateMixTransition;
};
const transitionPreviewAt = (time: number): ActiveTransitionPreview | null => {
  const variant = selectedVariant.value;
  if (!variant) return null;
  const ranges = currentTiming.value.slots;
  const safeTime = Math.max(0, Math.min(time, currentDuration.value));
  for (let index = 1; index < variant.slots.length; index += 1) {
    const incomingSlot = variant.slots[index]!;
    if (incomingSlot.transition === '硬切') continue;
    const outgoingSlot = variant.slots[index - 1]!;
    const incomingRange = ranges.find(({ id }) => id === incomingSlot.id);
    const outgoingRange = ranges.find(({ id }) => id === outgoingSlot.id);
    if (!incomingRange || !outgoingRange) continue;
    const duration = effectTemplateMixTransitionDuration(incomingSlot, outgoingSlot);
    if (duration <= 0) continue;
    // Centered transition: the duration is split evenly, half on the outgoing
    // clip's tail and half on the incoming clip's head around the cut point.
    const start = Math.max(outgoingRange.start, incomingRange.start - duration / 2);
    const end = Math.min(
      currentDuration.value,
      Math.max(start + 1 / TIMELINE_FPS, incomingRange.start + duration / 2),
    );
    if (safeTime < start || safeTime >= end) continue;
    return {
      duration: end - start,
      end,
      incomingSlot,
      outgoingSlot,
      progress: Math.max(
        0,
        Math.min(1, (safeTime - start) / Math.max(end - start, 1 / TIMELINE_FPS)),
      ),
      start,
      transition: incomingSlot.transition,
    };
  }
  return null;
};
const activeTransitionPreview = computed<ActiveTransitionPreview | null>(() =>
  transitionPreviewAt(playhead.value),
);
const visibleTimelineSlotIds = computed(() => {
  const transition = activeTransitionPreview.value;
  return transition
    ? new Set([transition.outgoingSlot.id, transition.incomingSlot.id])
    : new Set(previewSlot.value ? [previewSlot.value.id] : []);
});
const timelinePlayerStyle = (slotId: string): Record<string, string> => {
  const transition = activeTransitionPreview.value;
  if (!transition) {
    return { opacity: slotId === previewSlot.value?.id ? '1' : '0' };
  }
  const presentation = effectTemplateMixTransitionPresentation(
    transition.transition,
    transition.progress,
  );
  const style =
    slotId === transition.outgoingSlot.id
      ? presentation.outgoing
      : slotId === transition.incomingSlot.id
        ? presentation.incoming
        : { opacity: '0' };
  return { ...style, zIndex: slotId === transition.incomingSlot.id ? '3' : '2' };
};
const transitionOverlayStyle = computed<Record<string, string> | undefined>(() => {
  const transition = activeTransitionPreview.value;
  if (!transition) return undefined;
  const presentation = effectTemplateMixTransitionPresentation(
    transition.transition,
    transition.progress,
  );
  return presentation.overlay;
});
const stopTransitionPlaybackAnimation = (): void => {
  dissolvePlaybackAnimation?.cancel();
  dissolvePlaybackAnimation = null;
  flashPlaybackAnimation?.cancel();
  flashPlaybackAnimation = null;
  dissolvePlaybackSignature = '';
};
const syncTransitionPlaybackAnimation = (
  transition: ActiveTransitionPreview | null,
  playbackTime: number,
): void => {
  if (!transition || (transition.transition !== '叠化' && transition.transition !== '闪白')) {
    stopTransitionPlaybackAnimation();
    return;
  }
  const signature = `${transition.outgoingSlot.id}->${transition.incomingSlot.id}:${transition.transition}`;
  if (signature === dissolvePlaybackSignature && dissolvePlaybackAnimation?.playState === 'running')
    return;
  stopTransitionPlaybackAnimation();
  const incoming = timelinePlayers.get(transition.incomingSlot.id);
  const remaining = Math.max(0, transition.end - playbackTime);
  if (!incoming || remaining <= 0 || typeof incoming.animate !== 'function') return;
  dissolvePlaybackSignature = signature;
  dissolvePlaybackAnimation = incoming.animate(
    effectTemplateMixDissolvePlaybackKeyframes(transition.progress),
    { duration: remaining * 1000, easing: 'linear', fill: 'both' },
  );
  if (transition.transition === '闪白') {
    void nextTick(() => {
      if (!playing.value || dissolvePlaybackSignature !== signature) return;
      const overlay = transitionOverlayElement.value;
      if (!overlay || typeof overlay.animate !== 'function') return;
      flashPlaybackAnimation = overlay.animate(effectTemplateMixFlashPlaybackKeyframes(), {
        duration: transition.duration * 1000,
        easing: 'linear',
        fill: 'both',
      });
      flashPlaybackAnimation.currentTime = Math.max(
        0,
        Math.min(transition.duration, currentPlaybackClockSeconds() - transition.start) * 1000,
      );
    });
  }
};
const previewRange = computed(() =>
  previewSlot.value
    ? (currentTiming.value.slots.find(({ id }) => id === previewSlot.value?.id) ?? null)
    : null,
);
const previewMaterial = computed(() =>
  previewSlot.value ? materialForSlot(previewSlot.value.id) : null,
);
const stageMaterial = computed(() => auditionMaterial.value ?? previewMaterial.value);
const sourceAspectLabel = computed(() => {
  const ratio = stageMaterial.value?.ratio.trim();
  return ratio && /^\d+(?:\.\d+)?\s*[:/]\s*\d+(?:\.\d+)?$/u.test(ratio)
    ? ratio.replace(/\s*[/]\s*/u, ':').replace(/\s+/gu, '')
    : '9:16';
});
const stageAspectRatio = computed(() => {
  const match = sourceAspectLabel.value.match(/(\d+(?:\.\d+)?)\s*[:/]\s*(\d+(?:\.\d+)?)/u);
  const width = Number(match?.[1]);
  const height = Number(match?.[2]);
  return width > 0 && height > 0 ? width / height : 3 / 4;
});
const stageStyle = computed(() => ({
  aspectRatio: String(stageAspectRatio.value),
  transform: previewZoom.value === 100 ? undefined : `scale(${previewZoom.value / 100})`,
}));
const previewCurrentTime = computed(() =>
  auditionMaterial.value ? auditionTime.value : playhead.value,
);
const previewDuration = computed(() =>
  auditionMaterial.value ? auditionMaterial.value.duration : currentDuration.value,
);
const previewIsPlaying = computed(() =>
  auditionMaterial.value ? auditionPlaying.value : playing.value,
);
const setPlayerScrubber = (seconds: number): void => {
  const scrubber = playerScrubber.value;
  if (!scrubber) return;
  const duration = Math.max(previewDuration.value, 0.001);
  const safeSeconds = Math.max(0, Math.min(duration, seconds));
  const progress = safeSeconds / duration;
  scrubber.max = String(duration);
  scrubber.value = String(safeSeconds);
  if (playerScrubberFill.value) {
    playerScrubberFill.value.style.transform = `scaleX(${progress})`;
  }
  if (playerScrubberThumb.value) {
    playerScrubberThumb.value.style.transform = `translate3d(${progress * scrubber.clientWidth}px, 0, 0)`;
  }
};
const stopPlayerScrubberMotion = (seconds = previewCurrentTime.value): void => {
  for (const animation of playerScrubberAnimations) animation.cancel();
  playerScrubberAnimations = [];
  setPlayerScrubber(seconds);
};
const startPlayerScrubberMotion = (startSeconds: number): void => {
  const scrubber = playerScrubber.value;
  const fill = playerScrubberFill.value;
  const thumb = playerScrubberThumb.value;
  if (!scrubber || !fill || !thumb) return;
  stopPlayerScrubberMotion(startSeconds);
  const duration = Math.max(previewDuration.value, 0.001);
  const safeStart = Math.max(0, Math.min(duration, startSeconds));
  if (safeStart >= duration) return;
  const startProgress = safeStart / duration;
  const width = scrubber.clientWidth;
  const timing: KeyframeAnimationOptions = {
    duration: (duration - safeStart) * 1000,
    easing: 'linear',
    fill: 'both',
  };
  playerScrubberAnimations = [
    fill.animate([{ transform: `scaleX(${startProgress})` }, { transform: 'scaleX(1)' }], timing),
    thumb.animate(
      [
        { transform: `translate3d(${startProgress * width}px, 0, 0)` },
        { transform: `translate3d(${width}px, 0, 0)` },
      ],
      timing,
    ),
  ];
};
watch(
  [previewCurrentTime, previewDuration, previewIsPlaying],
  () => {
    if (!previewIsPlaying.value) stopPlayerScrubberMotion(previewCurrentTime.value);
  },
  { flush: 'post' },
);
const previewHasPackagingAudio = computed(() => {
  if (auditionMaterial.value) return false;
  const current = previewCurrentTime.value;
  const checkpoint = selectedPackaging.value?.checkpoint;
  const hasPackagedAudio = Boolean(
    checkpoint &&
    (checkpoint.narrationLayoutVersion === 'SLOT_V1' ||
      Object.keys(checkpoint.voices ?? {}).length ||
      Object.keys(checkpoint.captionVoices ?? {}).length ||
      checkpoint.music),
  );
  const active = (audio: { duration: number; start: number; volume: number } | null | undefined) =>
    Boolean(
      audio && audio.volume > 0 && current >= audio.start && current < audio.start + audio.duration,
    );
  // Every clip is silenced by the row it sits on, so each one is checked against its own row
  // rather than against a row its kind used to be pinned to.
  if (hasPackagedAudio) {
    const voice = Object.entries(checkpoint?.voices ?? {}).some(
      ([lineId, audio]) => !mutedAudioClip(`voice:${lineId}`) && active(audio),
    );
    const music = !mutedAudioClip('music') && active(checkpoint?.music);
    const captionVoice = Object.entries(checkpoint?.captionVoices ?? {}).some(
      ([captionId, audio]) => !mutedAudioClip(`capvoice:${captionId}`) && active(audio),
    );
    const detached =
      selectedVariant.value?.detachedAudios?.some(
        (audio) => !mutedAudioClip(`detached:${audio.id}`) && active(audio),
      ) ?? false;
    return voice || music || captionVoice || detached;
  }
  // Legacy variant audio predates the split, so the whole-film narration reads as 口播 and the
  // bed as 纯音乐 — each still silenced only by its own row.
  return (
    (selectedVariant.value?.detachedAudios?.some(
      (audio) => !mutedAudioClip(`detached:${audio.id}`) && active(audio),
    ) ??
      false) ||
    (!mutedAudioClip('voice') && active(selectedVariant.value?.voice)) ||
    (!mutedAudioClip('music') && active(selectedVariant.value?.bgm))
  );
});
const previewHasAudibleTrack = computed(() =>
  Boolean(
    previewIsPlaying.value &&
    ((!videoTrackMuted.value &&
      stageMaterial.value &&
      !slotHasDetachedAudio(displayedTimelineSlotId.value) &&
      materialAudioPresence[stageMaterial.value.id]) ||
      previewHasPackagingAudio.value),
  ),
);
/** Captions are burned into the render, so the stage has to show them at the same clock. */
const previewCaption = computed(() => {
  if (!captionTrackVisible.value || auditionMaterial.value) return undefined;
  const captions =
    selectedPackaging.value?.checkpoint.captions ?? selectedVariant.value?.captions ?? [];
  return captions.find(
    (caption) =>
      previewCurrentTime.value >= caption.start && previewCurrentTime.value < caption.end,
  );
});
const formatPlayerTimecode = (seconds: number): string => {
  const totalFrames = Math.max(
    0,
    Math.round((Number.isFinite(seconds) ? seconds : 0) * TIMELINE_FPS),
  );
  const frames = totalFrames % TIMELINE_FPS;
  const totalSeconds = Math.floor(totalFrames / TIMELINE_FPS);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const wholeSeconds = totalSeconds % 60;
  return [hours, minutes, wholeSeconds, frames]
    .map((item) => String(item).padStart(2, '0'))
    .join(':');
};
// Keep the player timecode frame-accurate without triggering a render of the
// full editor tree on every playback frame.
const syncPlayerTimecode = (seconds: number): void => {
  if (playerTimecode.value) {
    playerTimecode.value.textContent = formatPlayerTimecode(seconds);
  }
};
const workbenchGridStyle = computed(() =>
  compactWorkbench.value
    ? undefined
    : {
        gridTemplateColumns: `${leftPaneWidth.value}px 7px minmax(${CENTER_PANE_MIN_WIDTH}px, 1fr) 7px ${rightPaneWidth.value}px`,
        height: `${topPaneHeight.value}px`,
      },
);
const activeClassificationPool = computed(
  () =>
    classificationPools.value.find(({ templateId }) => templateId === activeTemplateId.value) ??
    null,
);
const classificationByRoleAndMaterial = computed(
  () =>
    new Map(
      (activeClassificationPool.value?.items ?? []).map((item) => [
        `${item.role}:${item.materialId}`,
        item,
      ]),
    ),
);
const bestClassificationByMaterial = computed(() => {
  const result = new Map<string, EffectTemplateMixClassificationPool['items'][number]>();
  for (const item of activeClassificationPool.value?.items ?? []) {
    const current = result.get(item.materialId);
    if (!current || item.matchScore > current.matchScore) result.set(item.materialId, item);
  }
  return result;
});
const classificationForMaterial = (materialId: string) =>
  materialRoleFilter.value === 'ALL'
    ? bestClassificationByMaterial.value.get(materialId)
    : classificationByRoleAndMaterial.value.get(`${materialRoleFilter.value}:${materialId}`);
const materialRoleOptions = computed(() =>
  (workspace.value?.template.slots ?? []).map(({ role }) => ({
    role,
    label: EFFECT_TEMPLATE_MIX_ROLE_LABELS[role],
    count: activeClassificationPool.value?.items.filter((item) => item.role === role).length ?? 0,
  })),
);
const selectMaterialRole = (role: 'ALL' | EffectTemplateMixRole): void => {
  materialRoleFilter.value = role;
  if (role === 'ALL' || !activeUi.value) return;
  const slot = selectedVariant.value?.slots.find((item) => item.role === role);
  if (slot) activeUi.value.selectedSlotId = slot.id;
};
const compareMaterialsByName = (
  left: EffectTemplateMixMaterial,
  right: EffectTemplateMixMaterial,
): number =>
  Number(right.available) - Number(left.available) ||
  left.name.localeCompare(right.name, 'zh-CN', { numeric: true, sensitivity: 'base' }) ||
  left.code.localeCompare(right.code, 'zh-CN', { numeric: true, sensitivity: 'base' }) ||
  left.id.localeCompare(right.id);
const filteredMaterials = computed(() => {
  const slot = selectedSlot.value;
  if (!workspace.value) return [];
  const search = keyword.value.trim().toLocaleLowerCase('zh-CN');
  return workspace.value.materials
    .filter(
      (item) =>
        item.available &&
        (materialRoleFilter.value === 'ALL' ||
          classificationByRoleAndMaterial.value.has(`${materialRoleFilter.value}:${item.id}`)) &&
        (!slot || item.duration + 0.001 >= slot.duration) &&
        (!search || (item.name + item.code).toLocaleLowerCase('zh-CN').includes(search)),
    )
    .sort(compareMaterialsByName);
});
const materialColumnCount = computed(() => {
  const availableWidth = Math.max(142, materialGridWidth.value - 24);
  return Math.max(1, Math.floor((availableWidth + 8) / 150));
});
const materialPageSize = computed(() => materialColumnCount.value * 3);
const materialPageCount = computed(() =>
  Math.max(1, Math.ceil(filteredMaterials.value.length / materialPageSize.value)),
);
const displayedMaterials = computed(() => {
  const safePage = Math.min(materialPage.value, materialPageCount.value);
  const start = (safePage - 1) * materialPageSize.value;
  return filteredMaterials.value.slice(start, start + materialPageSize.value);
});
/**
 * Old clips remain in workspace data so existing timelines can still play them. The selectable
 * library and smart fill only expose confirmed current clips; otherwise the user would see old
 * material cards next to new renders and mistake them for eligible refill sources.
 */
const availableMaterials = computed(
  () => workspace.value?.materials.filter(({ available }) => available) ?? [],
);
const expiredMaterialCount = computed(
  () => (workspace.value?.materials.length ?? 0) - availableMaterials.value.length,
);
/**
 * Smart fill gives every slot it has to fill a *distinct* current clip of at least the slot's length,
 * so "fewer current clips than slots" and "a slot longer than every current clip" are both certain
 * failures. Both are necessary conditions of the server's assignment, so disabling the button on them
 * can never refuse a fill the server would have accepted — it only swaps the generic
 * "剩余未使用素材不足以再生成一条完整成片" for the actual reason.
 */
const aiFillBlockReason = computed<string | null>(() => {
  const entry = activeEntry.value;
  const slots = entry?.workspace.template.slots ?? [];
  if (!entry || !slots.length) return null;
  if (!workspace.value?.materials.length)
    return '上一步没有已确认的视频素材，请先在视频渲染节点生成素材。';
  const variant = selectedVariant.value;
  const lockedSlotIds = new Set(variant?.manualSlotIds ?? []);
  const lockedMaterialIds = new Set(
    [...lockedSlotIds]
      .map((slotId) => variant?.bindings[slotId] ?? '')
      .filter((materialId) => Boolean(materialId)),
  );
  const candidates = availableMaterials.value.filter(({ id }) => !lockedMaterialIds.has(id));
  const unlockedSlots = slots.filter(({ id }) => !lockedSlotIds.has(id));
  const expired = expiredMaterialCount.value;
  const detail = expired ? `，其中 ${expired} 条已过期（对应的 Prompt 已更新）` : '';
  if (!candidates.length)
    return `当前没有已确认的可用素材${detail}；请先在视频渲染节点更新素材并完成校验。`;
  if (candidates.length < unlockedSlots.length)
    return `当前可用素材 ${candidates.length} 条${detail}，不足 ${unlockedSlots.length} 个待填槽位；请先在视频渲染节点更新素材并完成校验。`;
  const shortSlot = unlockedSlots.find(
    (slot) => !candidates.some((material) => material.duration + 0.001 >= slot.duration),
  );
  if (shortSlot)
    return `当前可用素材都短于「${shortSlot.label}」所需的 ${shortSlot.duration} 秒${detail}；请先在视频渲染节点更新更长的素材并完成校验。`;
  return null;
});
const selectedBindingMetadata = computed(() =>
  selectedSlot.value ? selectedVariant.value?.bindingMetadata?.[selectedSlot.value.id] : undefined,
);
const pendingCount = computed(
  () => workspace.value?.variants.filter(({ status }) => status === 'PENDING').length ?? 0,
);
const variantDisplayName = (_variant: EffectTemplateMixVariant, index: number): string =>
  `成片 ${String(index + 1).padStart(2, '0')}`;
const selectedVariantDisplayName = computed(() => {
  if (!selectedVariant.value || !workspace.value) return '尚未生成成片工程';
  return variantDisplayName(
    selectedVariant.value,
    workspace.value.variants.findIndex(({ id }) => id === selectedVariant.value?.id),
  );
});
const variantTemplateLabel = computed(() => workspace.value?.template.name?.trim() || '当前模板');
const complete = computed(
  () =>
    Boolean(workspace.value?.variants.length) &&
    workspace.value!.variants.every(
      (variant) =>
        !variant.conflictSlotIds.length &&
        variant.slots.every((slot) => {
          const material = materialForSlot(slot.id, variant);
          return (
            material?.available &&
            variant.bindingRevisions[slot.id] === material.artifactRevision &&
            (variant.offsets[slot.id] ?? 0) + slot.duration <= material.duration + 0.001
          );
        }),
    ),
);
const canValidate = computed(
  () =>
    complete.value &&
    packagingReady.value &&
    !pendingCount.value &&
    saveState.value === 'saved' &&
    draftRevision.value !== null,
);
const validated = computed(
  () =>
    Boolean(workspace.value) &&
    committedVersions[activeTemplateId.value] === workspace.value?.editVersion &&
    saveState.value === 'saved',
);
/**
 * The footer has to name the real blocker. The old single fallback told the user to wait for the
 * packaging to succeed, but a finished-and-partly-failed run has nothing left to wait for — only
 * failed items to recover from inside the packaging panel — so the user was left staring at a
 * disabled validate button with no idea why.
 */
const validateStatusTitle = computed(() => {
  if (validated.value && packagingReady.value) return '当前模板已确认';
  if (pendingCount.value) return '仍有工程待同步';
  if (!complete.value) return '请先补齐所有素材槽位';
  // Ready with failures is still ready: saying "就绪" alone would hide that some films will play
  // without narration, so the count is spelled out before the button is pressed.
  if (packagingReady.value)
    return packagingFailures.value.length
      ? `成片包装就绪，其中 ${packagingFailures.value.length} 条失败将按无包装成片提交（仅画面）`
      : '全部成片包装就绪';
  if (packagingRunStatus.value === null) return '请先在包装面板中为全部成片生成包装';
  return ['QUEUED', 'RUNNING'].includes(packagingRunStatus.value)
    ? '成片包装进行中，请等待完成'
    : '成片包装未全部就绪，请在包装面板中恢复未完成项';
});
const aiStageOrder: EffectTemplateMixAiRun['stage'][] = [
  'CLASSIFYING',
  'MATCHING',
  'SAMPLING',
  'TRIMMING',
  'COMPLETED',
];
const aiStageDescriptions: Record<EffectTemplateMixAiRun['stage'], string> = {
  CLASSIFYING: '仅读取每条素材对应的原始 Prompt，计算六槽位匹配分。',
  MATCHING: '选择六条互不重复的视频，并优先减少跨工程重复使用。',
  SAMPLING: '为选中视频均匀抽取关键帧，保留真实时间戳。',
  TRIMMING: '结合槽位语义、目标时长和画面帧选择截取起点。',
  COMPLETED: '按模板顺序把六个片段写入当前工程的视频轨。',
};
const aiStageInputs: Record<EffectTemplateMixAiRun['stage'], string> = {
  CLASSIFYING: '实际参与比对的视频创意主线、视频时长，以及模板六个槽位的名称与目标时长。',
  MATCHING: '每条视频对不同槽位的评分和理由，并结合成片之间的素材复用情况确定匹配。',
  SAMPLING: '已经匹配到槽位的视频片段、片段长度，以及该槽位需要呈现的内容和时长。',
  TRIMMING: '实际抽出的关键画面时间点、视频创意主线、槽位内容和目标片段时长。',
  COMPLETED: '已选镜头、截取起止时间、槽位顺序与模板转场配置。',
};
const aiStageOutputs: Record<EffectTemplateMixAiRun['stage'], string> = {
  CLASSIFYING: '各视频最适合的槽位、匹配度和简要理由。',
  MATCHING: '最终选中的视频、目标槽位、匹配度和选择理由。',
  SAMPLING: '实际抽取的关键画面时间点，以及这些画面如何支持最终截取选择。',
  TRIMMING: '实际截取的时间范围和画面选择理由。',
  COMPLETED: '已按模板顺序生成的成片镜头组合，可继续人工精修。',
};
const workflowRunForDisplay = computed(
  () =>
    activeAiRun.value ??
    failedAiRun.value ??
    aiRuns.value.find((run) => run.templateId === activeTemplateId.value) ??
    null,
);
const workflowStageState = (
  stage: EffectTemplateMixAiRun['stage'],
): 'done' | 'failed' | 'incomplete' | 'pending' | 'running' => {
  const run = workflowRunForDisplay.value;
  if (!run) return 'pending';
  const stageIndex = aiStageOrder.indexOf(stage);
  const currentIndex = aiStageOrder.indexOf(run.stage);
  if (run.status === 'FAILED' && stageIndex === currentIndex) return 'failed';
  const detail = run.stageDetails?.[stage];
  const complete = Boolean(detail && detail.total > 0 && detail.completed >= detail.total);
  if (complete) return 'done';
  // Do not let a terminal run hide an incomplete persisted stage (e.g. old runs whose
  // sampling checkpoint was absent). The API repairs provable legacy sampling from trims;
  // anything still incomplete must remain visible as a data issue, not green success.
  if (run.status === 'COMPLETED') return 'incomplete';
  if (run.status === 'FAILED' && stageIndex < currentIndex) return 'failed';
  if ((run.status === 'QUEUED' || run.status === 'RUNNING') && stageIndex <= currentIndex)
    return 'running';
  return 'pending';
};
const workflowStageStatusLabel = (stage: EffectTemplateMixAiRun['stage']): string =>
  ({
    done: '已完成',
    failed: '失败',
    incomplete: '记录不完整',
    pending: '等待中',
    running: '进行中',
  })[workflowStageState(stage)];
const workflowStageTone = (stage: EffectTemplateMixAiRun['stage']): string =>
  ({
    done: 'success',
    failed: 'danger',
    incomplete: 'danger',
    pending: 'pending',
    running: 'running',
  })[workflowStageState(stage)];
const workflowStageDetail = (stage: EffectTemplateMixAiRun['stage']) =>
  workflowRunForDisplay.value?.stageDetails?.[stage] ?? null;
const workflowStageProgress = (stage: EffectTemplateMixAiRun['stage']): string => {
  const detail = workflowStageDetail(stage);
  if (!detail || detail.total <= 0) return '暂无处理记录';
  const unit = {
    CLASSIFYING: '已分析素材',
    MATCHING: '完成匹配批次',
    SAMPLING: '已抽帧视频',
    TRIMMING: '已选截取区间',
    COMPLETED: '已生成时间轴工程',
  }[stage];
  return `${unit} ${Math.min(detail.completed, detail.total)}/${detail.total}`;
};
const showNotice = (text: string, kind: Notice['kind'] = 'success'): void => {
  notice.value = { text, kind };
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => (notice.value = null), 3600);
};
const openCreate = async (event: MouseEvent): Promise<void> => {
  dialogTrigger.value = event.currentTarget as HTMLElement;
  newTemplateName.value = nextAvailableTemplateName('新品跑量模板');
  createOpen.value = true;
  await nextTick();
  createNameInput.value?.focus();
};
const closeCreate = async (): Promise<void> => {
  createOpen.value = false;
  await nextTick();
  dialogTrigger.value?.focus();
};
const openMaterialPrompt = async (
  material: EffectTemplateMixMaterial,
  event?: Event,
): Promise<void> => {
  if (!material.promptText) {
    showNotice('当前素材没有可回溯的 Prompt', 'warning');
    return;
  }
  if (event?.currentTarget instanceof HTMLElement) dialogTrigger.value = event.currentTarget;
  promptMaterial.value = material;
  await nextTick();
  promptCloseButton.value?.focus();
};
const closeMaterialPrompt = async (): Promise<void> => {
  promptMaterial.value = null;
  await nextTick();
  dialogTrigger.value?.focus();
};
const openMaterialSlotPicker = async (
  material: EffectTemplateMixMaterial,
  event?: Event,
): Promise<void> => {
  if (!selectedVariant.value) {
    showNotice('请先创建成片工程，再更换素材槽位', 'warning');
    return;
  }
  if (event?.currentTarget instanceof HTMLElement) dialogTrigger.value = event.currentTarget;
  slotMoveMaterial.value = material;
  await nextTick();
  slotMoveCloseButton.value?.focus();
};
const closeMaterialSlotPicker = async (): Promise<void> => {
  slotMoveMaterial.value = null;
  await nextTick();
  dialogTrigger.value?.focus();
};
const chooseMaterialSlot = async (slotId: string): Promise<void> => {
  const material = slotMoveMaterial.value;
  if (!material) return;
  moveMaterialToSlot(material, slotId);
  await closeMaterialSlotPicker();
};
const openWorkflowDialog = async (event?: Event): Promise<void> => {
  if (event?.currentTarget instanceof HTMLButtonElement)
    workflowTrigger.value = event.currentTarget;
  workflowDialogOpen.value = true;
  selectedWorkflowStage.value = null;
  await nextTick();
  workflowCloseButton.value?.focus();
};
const closeWorkflowDialog = async (): Promise<void> => {
  workflowDialogOpen.value = false;
  selectedWorkflowStage.value = null;
  await nextTick();
  workflowTrigger.value?.focus();
};
const hydrate = (
  entry: EffectTemplateMixDraft['templates'][number],
  materials: EffectTemplateMixMaterial[],
): EffectTemplateMixTemplateEntry => {
  const next: EffectTemplateMixTemplateEntry = {
    ...cloneMix(entry),
    workspace: { ...cloneMix(entry.workspace), materials },
  };
  next.workspace.editVersion ||= next.workspace.template.editVersion || 1;
  for (const variant of next.workspace.variants) {
    variant.slots ||= cloneMix(next.workspace.template.slots);
    variant.bindingRevisions ||= {};
    variant.offsets ||= {};
    variant.timelineStarts ||= {};
    variant.videoLanes ||= {};
    variant.bindingMetadata ||= {};
    variant.captions ||= [];
    variant.originalVolume ??= 1;
  }
  return next;
};
const initializeUi = (): void => {
  for (const entry of catalog.value) {
    const current = uiByTemplate[entry.id];
    uiByTemplate[entry.id] = {
      selectedVariantId:
        entry.workspace.variants.find(({ id }) => id === current?.selectedVariantId)?.id ??
        entry.workspace.variants[0]?.id ??
        '',
      selectedSlotId:
        entry.workspace.template.slots.find(({ id }) => id === current?.selectedSlotId)?.id ??
        entry.workspace.template.slots[0]?.id ??
        '',
    };
  }
};
const installWorkspaceData = (
  data: Awaited<ReturnType<typeof loadEffectTemplateMixWorkspace>>['data'],
): void => {
  clearTimelineHistory();
  resetTimelinePlayerState();
  sourceMaterials.value = data.materials;
  catalog.value = data.draft.templates.map((entry) => hydrate(entry, data.materials));
  draftRevision.value = data.draftRevision;
  activeTemplateId.value =
    catalog.value.find(({ id }) => id === data.draft.activeTemplateId)?.id ??
    catalog.value[0]?.id ??
    '';
  let detachedTransitionChanged = false;
  const activeEntryForCleanup = catalog.value.find(({ id }) => id === activeTemplateId.value);
  if (!activeEntryForCleanup?.aiFillLocked) {
    for (const variant of activeEntryForCleanup?.workspace.variants ?? []) {
      normalizeVariantVideoLanes(variant);
      detachedTransitionChanged = clearDetachedTransitions(variant) || detachedTransitionChanged;
    }
  }
  Object.keys(committedVersions).forEach((key) => delete committedVersions[key]);
  data.commits
    .filter(({ stale }) => !stale)
    .forEach(({ templateId, editVersion }) => (committedVersions[templateId] = editVersion));
  initializeUi();
  // The rows are compacted against the packaging checkpoint, which only exists for the project the
  // user is on, so only that one is normalized here.
  if (selectedVariant.value) normalizeVariantAudioLanes(selectedVariant.value);
  if (detachedTransitionChanged) scheduleSave();
  aiRuns.value = data.aiRuns ?? [];
  classificationPools.value = data.classificationPools ?? [];
};
const stopPolling = (runId?: string): void => {
  const ids = runId ? [runId] : [...new Set([...pollTimers.keys(), ...pollControllers.keys()])];
  for (const id of ids) {
    clearTimeout(pollTimers.get(id));
    pollTimers.delete(id);
    pollControllers.get(id)?.abort();
    pollControllers.delete(id);
  }
};
const finishAiRun = async (run: EffectTemplateMixAiRun): Promise<void> => {
  stopPolling(run.id);
  mutating.value = false;
  if (run.status === 'FAILED' || run.status === 'CANCELLED') {
    await load();
    showNotice(run.errorMessage || '智能填充失败，请重试', 'error');
    return;
  }
  const previousVariantCount =
    catalog.value.find(({ id }) => id === run.templateId)?.workspace.variants.length ?? 0;
  const response = await loadEffectTemplateMixWorkspace(props.projectId, props.workflowRunId);
  installWorkspaceData(response.data);
  const variantId = run.outputVariantId;
  const ui = uiByTemplate[run.templateId];
  if (variantId && ui) {
    ui.selectedVariantId = variantId;
    const entry = catalog.value.find(({ id }) => id === run.templateId);
    ui.selectedSlotId =
      entry?.workspace.variants.find(({ id }) => id === variantId)?.slots[0]?.id ?? '';
  }
  activeTemplateId.value = run.templateId;
  resetWorkbenchDefaults();
  view.value = 'EDITOR';
  saveState.value = 'saved';
  const entry = catalog.value.find(({ id }) => id === run.templateId);
  const affectedVariants = run.targetVariantId
    ? (entry?.workspace.variants.filter(({ id }) => id === run.targetVariantId) ?? [])
    : (entry?.workspace.variants.slice(previousVariantCount) ?? []);
  const lowMatches = affectedVariants.reduce(
    (sum, variant) =>
      sum +
      Object.values(variant.bindingMetadata ?? {}).filter(
        ({ matchLevel }) => matchLevel === 'LOW_MATCH',
      ).length,
    0,
  );
  const createdCount = run.targetVariantId ? 0 : affectedVariants.length;
  showNotice(
    lowMatches
      ? `${createdCount ? `已批量生成 ${createdCount} 条成片，` : '时间轴已更新，'}其中 ${lowMatches} 个槽位为低匹配补位`
      : createdCount
        ? `已批量生成 ${createdCount} 条六片段时间轴工程`
        : 'AI 已更新六片段时间轴工程',
    lowMatches ? 'warning' : 'success',
  );
};
const pollAiRun = async (runId: string): Promise<void> => {
  stopPolling(runId);
  const pollController = new AbortController();
  pollControllers.set(runId, pollController);
  try {
    const response = await getEffectTemplateMixAiRun(props.projectId, runId, pollController.signal);
    const run = response.data;
    aiRuns.value = [run, ...aiRuns.value.filter(({ id }) => id !== run.id)];
    if (run.status === 'COMPLETED' || run.status === 'FAILED' || run.status === 'CANCELLED') {
      await finishAiRun(run);
      return;
    }
    mutating.value = true;
    pollTimers.set(
      runId,
      setTimeout(() => void pollAiRun(runId), 1200),
    );
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return;
    mutating.value = false;
    showNotice(error instanceof Error ? error.message : '智能填充进度读取失败', 'error');
  }
};
const load = async (): Promise<void> => {
  stopPolling();
  controller?.abort();
  controller = new AbortController();
  pageState.value = 'LOADING';
  try {
    if (!props.projectId || !props.workflowRunId) throw new Error('当前工作流运行尚未准备好');
    const response = await loadEffectTemplateMixWorkspace(
      props.projectId,
      props.workflowRunId,
      controller.signal,
    );
    installWorkspaceData(response.data);
    pageState.value = 'READY';
    const running = response.data.aiRuns?.filter(
      ({ status }) => status === 'QUEUED' || status === 'RUNNING',
    );
    const resumedRun = running?.find(({ targetVariantId, templateId }) => {
      const entry = response.data.draft.templates.find(({ id }) => id === templateId);
      return Boolean(
        entry &&
        (!targetVariantId || entry.workspace.variants.some(({ id }) => id === targetVariantId)),
      );
    });
    if (resumedRun) {
      activeTemplateId.value = resumedRun.templateId;
      const ui = uiByTemplate[resumedRun.templateId];
      const entry = catalog.value.find(({ id }) => id === resumedRun.templateId);
      if (ui && entry) {
        ui.selectedVariantId = resumedRun.targetVariantId ?? '';
        ui.selectedSlotId = resumedRun.targetVariantId
          ? (entry.workspace.variants.find(({ id }) => id === resumedRun.targetVariantId)?.slots[0]
              ?.id ?? '')
          : '';
      }
      resetWorkbenchDefaults();
      view.value = 'EDITOR';
    }
    applyPreviewTarget();
    for (const run of running ?? []) void pollAiRun(run.id);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return;
    errorMessage.value = error instanceof Error ? error.message : '混剪工作区加载失败';
    pageState.value = 'ERROR';
  }
};
/**
 * Serialised so two saves never share a revision. The revision a request carries stops being valid
 * the moment the next one lands, so a second request sent while the first is still on the wire comes
 * back as "节点内容已在其他页面更新" even though nothing is actually out of date — and a drag that
 * outlives a save is exactly how that happens. Chaining also means each save reads the revision the
 * previous one returned.
 */
const persist = (keepalive = false): Promise<boolean> => {
  clearTimeout(saveTimer);
  const previous = pendingSave ?? Promise.resolve(true);
  const next = previous.then(
    () => persistNow(keepalive),
    () => persistNow(keepalive),
  );
  pendingSave = next;
  return next;
};
const persistNow = async (keepalive = false): Promise<boolean> => {
  if (pageState.value !== 'READY') return false;
  saveState.value = 'saving';
  try {
    const result = await saveEffectTemplateMixDraft(
      props.projectId,
      props.workflowRunId,
      draftRevision.value,
      serializeEffectTemplateMixDraft(catalog.value, activeTemplateId.value),
      keepalive,
    );
    draftRevision.value = result.data.draftRevision;
    saveState.value = 'saved';
    return true;
  } catch (error) {
    if (error instanceof Error && error.message.includes('已进入智能填充并锁定')) {
      saveState.value = 'saved';
      await load();
      showNotice('智能填充开始后，此模板已锁定；如需修改请新建模板', 'warning');
      return false;
    }
    saveState.value = 'dirty';
    showNotice(error instanceof Error ? error.message : '草稿保存失败', 'error');
    return false;
  }
};
const scheduleSave = (): void => {
  if (projectEditLocked.value) {
    clearTimeout(saveTimer);
    saveState.value = 'saved';
    if (!fillStartPending.value) void load();
    return;
  }
  saveState.value = 'dirty';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => (pendingSave = persist()), 450);
};
const bump = (): void => {
  if (workspace.value) workspace.value.editVersion += 1;
  scheduleSave();
};
const selectVoiceProfile = (id: string): void => {
  if (voiceSelectLocked.value) return;
  if (!workspace.value || workspace.value.template.voiceProfileId === id) return;
  workspace.value.template.voiceProfileId = id;
  bump();
};
const pauseForVoiceAudition = (): void => {
  closeMaterialPreview();
  playing.value = false;
  pauseTimelinePlayers();
  packagingPanel.value?.stopPlaybackAudio();
  syncDetachedAudio();
  stopPlaybackClock();
};

/**
 * Packaging audio lives on the server-owned checkpoint, so edits are diffed
 * against the last confirmed copy and PUT separately from the workflow draft.
 */
type PackagingAudioTarget =
  | { kind: 'CAPTION'; key: string }
  | { kind: 'CAPTION_VOICE'; key: string }
  | { kind: 'MUSIC' }
  | { kind: 'VOICE'; key: string };
const packagingAudioTarget = (clipId: string): PackagingAudioTarget | null => {
  if (clipId.startsWith('capvoice:')) return { kind: 'CAPTION_VOICE', key: clipId.slice(9) };
  if (clipId.startsWith('caption:')) return { kind: 'CAPTION', key: clipId.slice(8) };
  if (clipId === 'music') return { kind: 'MUSIC' };
  if (clipId.startsWith('voice:')) return { kind: 'VOICE', key: clipId.slice(6) };
  return null;
};
const packagingAudio = (
  checkpoint: PackagingCheckpoint,
  target: PackagingAudioTarget,
): PackagingAudio | undefined =>
  target.kind === 'MUSIC'
    ? checkpoint.music
    : target.kind === 'VOICE'
      ? checkpoint.voices?.[target.key]
      : target.kind === 'CAPTION_VOICE'
        ? checkpoint.captionVoices?.[target.key]
        : undefined;
/**
 * The volume row is shown in dB — how an editor reasons about a level — while the checkpoint keeps
 * the gain the worker multiplies by. The scale is shared with the timeline and the server's own
 * check, so the loudest the row reaches is exactly the gain the domain accepts.
 */
const AUDIO_DB_FLOOR = PACKAGING_AUDIO_DB_FLOOR;
const audioToDb = packagingAudioToDb;
const audioFromDb = packagingAudioFromDb;
/**
 * The longest fade the row offers. A clip can never hold more than its own length — the server
 * rejects a pair whose sum exceeds it — so each edge is also capped by what the other edge leaves.
 */
const AUDIO_FADE_MAX = 6.1;
const sameAudio = (left: PackagingAudio, right: PackagingAudio, kind: 'MUSIC' | 'VOICE'): boolean =>
  left.start === right.start &&
  left.volume === right.volume &&
  left.duration === right.duration &&
  (left.offset ?? 0) === (right.offset ?? 0) &&
  // Compared as effective seconds: dragging the music fade from its 0.5s default down to 0 is a
  // real edit, but "absent" and "0.5" would look identical if the raw fields were compared.
  packagingAudioFade(left, kind, 'fadeIn') === packagingAudioFade(right, kind, 'fadeIn') &&
  packagingAudioFade(left, kind, 'fadeOut') === packagingAudioFade(right, kind, 'fadeOut');
const sameBox = (left: PackagingCaptionBox, right: PackagingCaptionBox): boolean =>
  left.x === right.x &&
  left.y === right.y &&
  left.width === right.width &&
  left.scale === right.scale;
const audioEdit = (audio: PackagingAudio, kind: 'MUSIC' | 'VOICE'): PackagingAudioEdit => ({
  start: audio.start,
  offset: audio.offset ?? 0,
  duration: audio.duration,
  volume: audio.volume,
  // Spelled out rather than left absent: the server reads absent as "pipeline default", so an
  // editor who deliberately pulled the fade to 0 has to say so or it would spring back to 0.5s.
  fadeIn: packagingAudioFade(audio, kind, 'fadeIn'),
  fadeOut: packagingAudioFade(audio, kind, 'fadeOut'),
});
const audioDiff = (current: PackagingCheckpoint, baseline: PackagingCheckpoint) => {
  const voices: Record<string, PackagingAudioEdit> = {};
  for (const [id, audio] of Object.entries(current.voices ?? {})) {
    const before = baseline.voices?.[id];
    if (!before || sameAudio(before, audio, 'VOICE')) continue;
    voices[id] = audioEdit(audio, 'VOICE');
  }
  // A narration is an optional overlay on its script line, so a deleted one is a key that went away.
  // The line and its subtitle are untouched, so nothing else has to be said about the deletion.
  const removedVoices = Object.keys(baseline.voices ?? {}).filter(
    (id) => !Object.hasOwn(current.voices ?? {}, id),
  );
  // Caption narrations are separate clips from the script-line voices, so they diff separately and
  // only the ones the editor actually moved are sent.
  const captionVoices: Record<string, PackagingAudioEdit> = {};
  for (const [id, audio] of Object.entries(current.captionVoices ?? {})) {
    const before = baseline.captionVoices?.[id];
    if (!before || sameAudio(before, audio, 'VOICE')) continue;
    captionVoices[id] = audioEdit(audio, 'VOICE');
  }
  // A deleted clip is a key that was there and is not any more: the geometry diff cannot see it,
  // because there is no current entry left to compare.
  const removedCaptionVoices = Object.keys(baseline.captionVoices ?? {}).filter(
    (id) => !Object.hasOwn(current.captionVoices ?? {}, id),
  );
  const music =
    current.music && baseline.music && !sameAudio(baseline.music, current.music, 'MUSIC')
      ? audioEdit(current.music, 'MUSIC')
      : null;
  // The music bed is a single field rather than a keyed map, so its removal is its own flag.
  const removeMusic = Boolean(baseline.music) && !current.music;
  const captions =
    JSON.stringify(current.captions ?? []) === JSON.stringify(baseline.captions ?? [])
      ? null
      : (current.captions ?? []).map(({ id, text, start, end, manual, trackId }) => {
          const previous = baseline.captions?.find((caption) => caption.id === id);
          return {
            id,
            text,
            start,
            end,
            ...(manual ? { manual: true } : {}),
            // Dropping the field is not the same as sending it back to the implicit row: the server
            // reads an absent `trackId` as "leave it where it is", so a row that was cleared has to
            // say so out loud.
            ...(trackId ? { trackId } : previous?.trackId ? { trackId: null } : {}),
          };
        });
  // Only the boxes this editor touched, so an unrelated drag never rewrites the others.
  const boxes: Record<string, PackagingCaptionBox> = {};
  for (const [id, box] of Object.entries(current.captionBoxes ?? {})) {
    const before = baseline.captionBoxes?.[id];
    if (!before || !sameBox(before, box)) boxes[id] = box;
  }
  if (
    !Object.keys(voices).length &&
    !removedVoices.length &&
    !Object.keys(captionVoices).length &&
    !removedCaptionVoices.length &&
    !music &&
    !removeMusic &&
    !captions &&
    !Object.keys(boxes).length
  )
    return null;
  return {
    voices,
    removedVoices,
    captionVoices,
    removedCaptionVoices,
    music,
    removeMusic,
    captions,
    boxes,
  };
};
/** Unsaved local geometry, always owned by one item so diffs never cross items. */
let audioBaseline: {
  itemId: string;
  checkpoint: PackagingCheckpoint;
  updatedAt: string;
} | null = null;
let audioTimer: ReturnType<typeof setTimeout> | undefined;
let audioInFlight = false;
let audioResend = false;
const cloneCheckpoint = (checkpoint: PackagingCheckpoint): PackagingCheckpoint =>
  JSON.parse(JSON.stringify(checkpoint)) as PackagingCheckpoint;
/** The packaging panel polls the server; the editor keeps only geometry it has not saved yet. */
const onPackagingSelected = (item: PackagingItem | null): void => {
  const current = selectedPackaging.value;
  if (item && current && item.id === current.id) {
    if (audioBaseline?.itemId !== item.id) {
      selectedPackaging.value = item;
      return;
    }
    // A generated caption narration arrives on the polled copy while a local drag may still be
    // unsaved, and the branch below keeps the local checkpoint wholesale — so the one entry that
    // was just written is carried across explicitly rather than dropped with the rest.
    const pending = pendingCaptionVoice.value;
    const captionId = pending?.itemId === item.id ? pending.captionId : null;
    const arrived = captionId ? item.checkpoint.captionVoices?.[captionId] : undefined;
    selectedPackaging.value = {
      ...item,
      checkpoint:
        captionId && arrived
          ? {
              ...current.checkpoint,
              captionVoices: { ...current.checkpoint.captionVoices, [captionId]: arrived },
            }
          : current.checkpoint,
      updatedAt: current.updatedAt,
    };
    return;
  }
  // Leaving an item mid-debounce: persist its edit instead of dropping it silently.
  if (current && audioBaseline?.itemId === current.id) void flushAudioEdit();
  selectedPackaging.value = item;
};
const scheduleAudioEdit = (): void => {
  clearTimeout(audioTimer);
  audioTimer = setTimeout(() => void flushAudioEdit(), 250);
};
const flushAudioEdit = async (): Promise<void> => {
  if (audioInFlight) {
    audioResend = true;
    return;
  }
  const item = selectedPackaging.value;
  const baseline = audioBaseline;
  if (!item || !baseline || baseline.itemId !== item.id) return;
  const diff = audioDiff(item.checkpoint, baseline.checkpoint);
  if (!diff) {
    audioBaseline = null;
    return;
  }
  const targetId = item.id;
  audioInFlight = true;
  try {
    const response = await updateEffectPackagingAudio(props.projectId, item.runId, targetId, {
      expectedUpdatedAt: baseline.updatedAt,
      ...(Object.keys(diff.voices).length ? { voices: diff.voices } : {}),
      ...(diff.removedVoices.length ? { removedVoices: diff.removedVoices } : {}),
      ...(Object.keys(diff.captionVoices).length ? { captionVoices: diff.captionVoices } : {}),
      ...(diff.removedCaptionVoices.length
        ? { removedCaptionVoices: diff.removedCaptionVoices }
        : {}),
      ...(diff.music ? { music: diff.music } : {}),
      ...(diff.removeMusic ? { removeMusic: true } : {}),
      ...(diff.captions ? { captions: diff.captions } : {}),
      ...(Object.keys(diff.boxes).length ? { boxes: diff.boxes } : {}),
    });
    const current = selectedPackaging.value;
    if (current?.id !== targetId) {
      // The editor moved on; only the item that was just saved loses its baseline.
      if (audioBaseline?.itemId === targetId) audioBaseline = null;
      return;
    }
    current.updatedAt = response.data.updatedAt;
    // Adopt the server copy only when the editor has no newer local geometry.
    if (!audioDiff(current.checkpoint, response.data.checkpoint)) {
      current.checkpoint = response.data.checkpoint;
      audioBaseline = null;
    } else {
      audioBaseline = {
        itemId: targetId,
        checkpoint: response.data.checkpoint,
        updatedAt: current.updatedAt,
      };
      audioResend = true;
    }
  } catch (error) {
    const current = selectedPackaging.value;
    if (current?.id === targetId) {
      current.checkpoint = baseline.checkpoint;
      current.updatedAt = baseline.updatedAt;
    }
    if (audioBaseline?.itemId === targetId) audioBaseline = null;
    showNotice(error instanceof Error ? error.message : '音频编辑保存失败', 'error');
  } finally {
    audioInFlight = false;
    if (audioResend) {
      audioResend = false;
      scheduleAudioEdit();
    }
  }
};
const editPackagingAudio = (mutate: (checkpoint: PackagingCheckpoint) => void): void => {
  const item = selectedPackaging.value;
  if (!item || !item.runId || item.status !== 'COMPLETED') {
    showNotice('包装尚未完成，无法编辑音频轨道', 'warning');
    return;
  }
  if (audioBaseline?.itemId !== item.id) {
    audioBaseline = {
      itemId: item.id,
      checkpoint: cloneCheckpoint(item.checkpoint),
      updatedAt: item.updatedAt,
    };
  }
  mutate(item.checkpoint);
  scheduleAudioEdit();
};
const editDetachedAudio = (
  clipId: string,
  mutate: (audio: EffectTemplateMixDetachedAudio, variant: EffectTemplateMixVariant) => void,
): boolean => {
  if (!clipId.startsWith('detached:')) return false;
  const variant = selectedVariant.value;
  const audio = variant?.detachedAudios?.find(({ id }) => `detached:${id}` === clipId);
  if (!variant || !audio) return true;
  rememberTimelineEdit();
  mutate(audio, variant);
  bump();
  return true;
};
/** The caption a `caption:` clip id points at, from whichever source the workbench is editing. */
const captionStartOf = (clipId: string): number | undefined => {
  if (!clipId.startsWith('caption:')) return undefined;
  const id = clipId.slice('caption:'.length);
  const captions = selectedPackaging.value?.checkpoint.captions ?? selectedVariant.value?.captions;
  return captions?.find((caption) => caption.id === id)?.start;
};
/** Where a clip's time lives: a separated clip on the project draft, everything else on the
 * server-owned checkpoint. Shared by a single move and a group move so both write the same place. */
const applyAudioStart = (clipId: string, start: number): void => {
  if (editDetachedAudio(clipId, (audio) => (audio.start = start))) return;
  const target = packagingAudioTarget(clipId);
  if (!target) return;
  // A subtitle carries its own length, so moving it keeps the end exactly as far away as it was.
  if (target.kind === 'CAPTION' && !selectedPackaging.value) {
    const caption = selectedVariant.value?.captions.find((item) => item.id === target.key);
    if (!caption || projectEditLocked.value) return;
    const length = caption.end - caption.start;
    caption.start = start;
    caption.end = start + length;
    bump();
    return;
  }
  editPackagingAudio((checkpoint) => {
    if (target.kind === 'CAPTION') {
      const caption = checkpoint.captions?.find((c) => c.id === target.key);
      if (caption) {
        const length = caption.end - caption.start;
        caption.start = start;
        caption.end = start + length;
      }
      return;
    }
    const audio = packagingAudio(checkpoint, target);
    if (audio) audio.start = start;
  });
};
/** `side` is redundant: the caller already resolved start/offset/duration. */
const resizePackagingAudio = (
  clipId: string,
  _side: 'LEFT' | 'RIGHT',
  start: number,
  offset: number,
  duration: number,
): void => {
  if (
    editDetachedAudio(clipId, (audio) => {
      audio.start = start;
      audio.offset = offset;
      audio.duration = duration;
    })
  )
    return;
  const target = packagingAudioTarget(clipId);
  if (!target) return;
  editPackagingAudio((checkpoint) => {
    if (target.kind === 'CAPTION') {
      const caption = checkpoint.captions?.find((c) => c.id === target.key);
      if (caption) {
        // Captured before the trim is written, so undo steps back to the untrimmed caption.
        rememberTimelineEdit();
        caption.start = start;
        caption.end = start + duration;
      }
      return;
    }
    const audio = packagingAudio(checkpoint, target);
    if (audio) {
      audio.start = start;
      audio.offset = offset;
      audio.duration = duration;
    }
  });
};
const changePackagingAudioVolume = (clipId: string, volume: number): void => {
  if (editDetachedAudio(clipId, (audio) => (audio.volume = volume))) return;
  const target = packagingAudioTarget(clipId);
  if (!target || target.kind === 'CAPTION') return;
  editPackagingAudio((checkpoint) => {
    const audio = packagingAudio(checkpoint, target);
    if (audio) audio.volume = volume;
  });
};
/**
 * The timeline owns the selection; the editor row above it mirrors the selected caption. A whole
 * set can be selected at once, so geometry edits reach every caption in it.
 */
const selectedCaptionIds = ref<string[]>([]);
/** The text editor and font stepper speak about one caption, so they need exactly one. */
const selectedCaptionId = computed(() =>
  selectedCaptionIds.value.length === 1 ? selectedCaptionIds.value[0]! : null,
);
const captionTextInput = ref<HTMLInputElement | null>(null);
const captionItems = computed(() => {
  const packaging = selectedPackaging.value;
  if (packaging) return packaging.checkpoint.captions ?? [];
  return selectedVariant.value?.captions ?? [];
});
const canAddCaption = computed(
  () => !projectEditLocked.value && (!selectedPackaging.value || captionEditable.value),
);
const onAudioClipSelected = (clipId: string | null): void => {
  // Captions arrive as a whole set on their own event, so this one only handles voice and music.
  if (clipId?.startsWith('caption:')) return;
  selectedCaptionIds.value = [];
};
const onCaptionClipsSelected = (captionIds: string[]): void => {
  selectedCaptionIds.value = captionIds;
};
/**
 * Voice and music clips the timeline has selected. The row above the timeline speaks about the
 * whole set the same way the caption font stepper does: the pointer's clip is the standard and the
 * rest take its values, rather than the set sliding by the standard's delta.
 */
const selectedAudioClipIds = ref<string[]>([]);
const onAudioClipsSelected = (clipIds: string[]): void => {
  selectedAudioClipIds.value = clipIds;
};
const separatingAudioSlots = new Set<string>();
const probeMaterialAudio = async (material: EffectTemplateMixMaterial): Promise<boolean> => {
  const known = materialAudioPresence[material.id];
  if (typeof known === 'boolean') return known;
  const player = document.createElement('video') as AudioDetectableVideo;
  player.muted = true;
  player.preload = 'auto';
  player.playsInline = true;
  player.src = material.contentUrl;
  const timeout = (delay: number) => new Promise<void>((resolve) => setTimeout(resolve, delay));
  try {
    await Promise.race([
      new Promise<void>((resolve, reject) => {
        if (player.readyState >= HTMLMediaElement.HAVE_METADATA) return resolve();
        player.addEventListener('loadedmetadata', () => resolve(), { once: true });
        player.addEventListener('error', () => reject(new Error('素材读取失败')), { once: true });
      }),
      timeout(8000).then(() => {
        throw new Error('素材读取超时');
      }),
    ]);
    if (typeof player.mozHasAudio === 'boolean') {
      materialAudioPresence[material.id] = player.mozHasAudio;
      return player.mozHasAudio;
    }
    if (player.audioTracks) {
      materialAudioPresence[material.id] = player.audioTracks.length > 0;
      return materialAudioPresence[material.id]!;
    }
    player.currentTime = Math.min(0.25, Math.max(0, material.duration / 4));
    await player.play();
    await timeout(850);
    const present = (player.webkitAudioDecodedByteCount ?? 0) > 0;
    materialAudioPresence[material.id] = present;
    return present;
  } catch {
    return false;
  } finally {
    player.pause();
    player.removeAttribute('src');
    player.load();
  }
};
const removeDetachedAudioForSlot = (slotId: string): void => {
  const variant = selectedVariant.value;
  if (!variant?.detachedAudios?.some((audio) => audio.sourceSlotId === slotId)) return;
  rememberTimelineEdit();
  clearDetachedAudioForSlots(variant, [slotId]);
  bump();
};
const clearDetachedAudioForSlots = (variant: EffectTemplateMixVariant, slotIds: string[]): void => {
  const removedIds = new Set(
    (variant.detachedAudios ?? [])
      .filter((audio) => audio.sourceSlotId && slotIds.includes(audio.sourceSlotId))
      .map(({ id }) => id),
  );
  if (!removedIds.size) return;
  variant.detachedAudios = (variant.detachedAudios ?? []).filter(
    (audio) => !removedIds.has(audio.id),
  );
  selectedAudioClipIds.value = selectedAudioClipIds.value.filter(
    (clipId) => !removedIds.has(clipId.slice('detached:'.length)),
  );
};
const separateAudioForSlot = async (slotId: string): Promise<void> => {
  const variant = selectedVariant.value;
  const slot = variant?.slots.find(({ id }) => id === slotId);
  const material = slot ? materialForSlot(slotId, variant) : null;
  if (!variant || !slot || !material || separatingAudioSlots.has(slotId)) return;
  if (variant.detachedAudios?.some((audio) => audio.sourceSlotId === slotId)) {
    removeDetachedAudioForSlot(slotId);
    showNotice('已恢复视频素材原声', 'success');
    return;
  }
  separatingAudioSlots.add(slotId);
  try {
    if (!(await probeMaterialAudio(material))) {
      showNotice('这段视频素材没有可分离的音轨', 'warning');
      return;
    }
    if (
      selectedVariant.value !== variant ||
      variant.bindings[slotId] !== material.id ||
      variant.detachedAudios?.some((audio) => audio.sourceSlotId === slotId)
    )
      return;
    const start = currentTiming.value.slots.find(({ id }) => id === slotId)?.start ?? 0;
    const audio: EffectTemplateMixDetachedAudio = {
      id: crypto.randomUUID(),
      sourceSlotId: slotId,
      fileObjectId: material.fileObjectId,
      name: `${material.code} 分离音频`,
      start,
      duration: slot.duration,
      offset: Math.max(0, variant.offsets[slotId] ?? 0),
      volume: 1,
    };
    rememberTimelineEdit();
    variant.detachedAudios = [...(variant.detachedAudios ?? []), audio];
    // A separated original is a new clip with no row of its own, so it lands below everything else
    // and the extra row appears only now that there is something to put on it.
    normalizeVariantAudioLanes(variant);
    // A direct assignment here bypasses the timeline's own selection, so a stale caption set would
    // otherwise still be what Delete acts on.
    selectedCaptionIds.value = [];
    selectedAudioClipIds.value = [`detached:${audio.id}`];
    bump();
    resetTimelinePlayerState();
    showNotice('音频已分离到音频轨道', 'success');
  } finally {
    separatingAudioSlots.delete(slotId);
  }
};
const addMusicAssetToTimeline = (music: {
  assetId: string;
  fileObjectId: string;
  name: string;
  duration: number;
  start: number;
  row: number;
  insertRow?: number | undefined;
}): void => {
  const variant = selectedVariant.value;
  // Only the template configuration is frozen once a packaging exists; where the audio sits is the
  // editor's arrangement and stays editable, exactly as a clip moved between rows already is. Gating
  // this on `templateEditLocked` would make the audio rows read-only in the very state — a completed
  // packaging — in which the rest of the audio area is offered for editing.
  if (!variant || projectEditLocked.value) return;
  if (!Number.isFinite(music.duration) || music.duration <= 0) return;
  // The film is as long as its content, so a track dropped past the current end extends it rather
  // than being trimmed back to fit: where it lands is where the user put it.
  const start = Math.max(0, music.start);
  const duration = music.duration;
  const audio: EffectTemplateMixDetachedAudio = {
    id: crypto.randomUUID(),
    sourceAssetId: music.assetId,
    fileObjectId: music.fileObjectId,
    name: music.name,
    sourceDuration: music.duration,
    duration,
    start,
    offset: 0,
    volume: 1,
  };
  rememberTimelineEdit();
  variant.detachedAudios = [...(variant.detachedAudios ?? []), audio];
  variant.audioLanes ??= {};
  if (music.insertRow === undefined) {
    // The library track lands on the row it was dropped on, not on a row picked for its kind, and
    // dropping past the last row is how the user opens a new one.
    variant.audioLanes[`detached:${audio.id}`] = Math.max(0, Math.round(music.row));
  } else {
    // Dropping on a border opens a row instead: every row from there down moves one further, the way
    // a video lane insert does, and the track takes the row that was made. Rows are stored sparsely
    // and default by kind, so the ones in the way are written out before they can be shifted.
    const refs = timelineAudioClipRefs(
      variant,
      selectedPackaging.value,
      workspace.value?.materials ?? [],
      props.projectId,
    );
    for (const ref of refs) variant.audioLanes[ref.id] = rawAudioLane(variant.audioLanes, ref);
    const row = Math.max(0, Math.round(music.insertRow));
    for (const ref of refs) {
      const lane = variant.audioLanes[ref.id]!;
      if (lane >= row) variant.audioLanes[ref.id] = lane + 1;
    }
    variant.audioLanes[`detached:${audio.id}`] = row;
  }
  normalizeVariantAudioLanes(variant);
  selectedCaptionIds.value = [];
  selectedAudioClipIds.value = [`detached:${audio.id}`];
  bump();
  resetTimelinePlayerState();
  // A row opened below the last one is off the bottom of the viewport, so the drop would read as
  // "nothing happened" until the user scrolled. Show the new row and the track on it.
  const landedRow = audioRowOfClip(
    timelineAudioClipRefs(
      variant,
      selectedPackaging.value,
      workspace.value?.materials ?? [],
      props.projectId,
    ),
    variant.audioLanes,
    `detached:${audio.id}`,
  );
  void nextTick().then(() => timelineRef.value?.scrollToAudioRow(landedRow, start, duration));
};
/** The timeline owns its own selection, so clearing it from out here needs its own handle. */
const timelineRef = ref<{
  clearSelection: () => void;
  /** The clip's own length, so the jump reveals all of it rather than just its head. */
  scrollToLane: (lane: number, time: number, duration?: number) => void;
  scrollToAudioRow: (row: number, time: number, duration?: number) => void;
  scrollToCaption: (captionId: string, time: number, duration?: number) => void;
  setPlaybackNeedle: (seconds: number) => void;
  startPlaybackNeedle: (startSeconds: number, endSeconds?: number) => void;
  stopPlaybackNeedle: (seconds: number) => void;
} | null>(null);
/**
 * Clicking anywhere in the player other than the picture itself clears the selection, the way a
 * blank click does in the timeline. The picture is exempt: it is the material, not empty space.
 */
const onPlayerPanelPointerDown = (event: PointerEvent): void => {
  const target = event.target;
  if (!(target instanceof Element) || target.closest('.stage')) return;
  selectedCaptionIds.value = [];
  timelineRef.value?.clearSelection();
};
const editingCaption = computed(() => {
  if (!selectedCaptionId.value) return null;
  return captionItems.value.find((caption) => caption.id === selectedCaptionId.value) ?? null;
});
const setCaptionText = (captionId: string, value: string): void => {
  if (selectedPackaging.value) {
    if (!captionEditable.value) return;
    editPackagingAudio((checkpoint) => {
      const caption = checkpoint.captions?.find((item) => item.id === captionId);
      if (caption) caption.text = value;
    });
    return;
  }
  const caption = selectedVariant.value?.captions.find((item) => item.id === captionId);
  if (!caption || projectEditLocked.value) return;
  caption.text = value;
  bump();
};
const changeCaptionText = (event: Event): void => {
  const captionId = selectedCaptionId.value;
  if (captionId) setCaptionText(captionId, (event.target as HTMLInputElement).value);
};
/**
 * The text box owns the keyboard only while the pointer is on it. Picking a caption on the timeline
 * must not pull the caret in — Delete and Ctrl+Z are handed to a focused input, so a box that focused
 * itself turned "delete this subtitle" into "delete this subtitle's text". The box is focused by
 * clicking it and only then, and a pointer anywhere else in the workbench takes that focus back: every
 * timeline gesture calls `preventDefault()` on pointerdown, so the browser never blurs it on its own,
 * and a card that was already selected changes nothing a watcher could key off.
 */
const onWorkbenchPointerDown = (event: PointerEvent): void => {
  const target = event.target;
  if (target instanceof Node && captionTextInput.value?.contains(target)) return;
  if (document.activeElement === captionTextInput.value) captionTextInput.value?.blur();
};
/** Matches the burned-in default: near the bottom-centre, wrapping at 90% of the frame width. */
const DEFAULT_CAPTION_BOX: PackagingCaptionBox = { x: 0.5, y: 0.03, width: 0.9, scale: 1 };
const CAPTION_SNAP = 0.015;
/** Width of the invisible left/right grab zones that stretch the frame instead of moving it. */
const CAPTION_EDGE_GRAB = 10;
const captionBox = (id: string): PackagingCaptionBox =>
  selectedPackaging.value?.checkpoint.captionBoxes?.[id] ?? DEFAULT_CAPTION_BOX;
/**
 * Geometry lands on the checkpoint, so it is only offered once packaging has finished. A stale
 * checkpoint remains editable as a frozen snapshot; its source status is shown separately.
 */
const captionEditable = computed(
  () => selectedPackaging.value?.status === 'COMPLETED' && !projectEditLocked.value,
);
const captionTextEditable = computed(
  () => !projectEditLocked.value && (!selectedPackaging.value || captionEditable.value),
);
/** The caption the font stepper reads its current size from: the lone one, or the set's first. */
const captionScaleTarget = computed(() => {
  if (!captionEditable.value) return null;
  return editingCaption.value?.id ?? selectedCaptionIds.value[0] ?? null;
});
const captionFontSize = computed(() => {
  const target = captionScaleTarget.value;
  return target
    ? Math.max(11, Math.round(stageCaptionFontSize.value * captionBox(target).scale))
    : stageCaptionFontSize.value;
});
/**
 * The caption narration the editor has asked for and not yet seen arrive. One at a time is enough:
 * the button is per-caption and disabled while busy, so a second request could only be a double
 * click. The worker answers out of band, so the arrival is detected by watching the checkpoint the
 * packaging panel polls rather than by this promise resolving.
 */
const pendingCaptionVoice = ref<{ itemId: string; captionId: string } | null>(null);
const captionVoiceBusy = ref(false);
let captionVoiceTimer: ReturnType<typeof setTimeout> | undefined;
/** How long to wait for the worker before telling the user to try again. */
const CAPTION_VOICE_TIMEOUT_MS = 90_000;
const captionVoiceReady = computed(
  () =>
    captionEditable.value &&
    !captionVoiceBusy.value &&
    Boolean(editingCaption.value?.text.trim()) &&
    Boolean(selectedPackaging.value),
);
const generateCaptionVoice = async (): Promise<void> => {
  const caption = editingCaption.value;
  const packaging = selectedPackaging.value;
  if (!caption || !packaging || !captionVoiceReady.value) return;
  // The text box debounces its save, and the server asserts the text it is given against the
  // caption it has stored — voicing before the flush lands would fail that assertion.
  await flushAudioEdit();
  const text =
    selectedPackaging.value?.checkpoint.captions?.find((item) => item.id === caption.id)?.text ??
    caption.text;
  captionVoiceBusy.value = true;
  pendingCaptionVoice.value = { itemId: packaging.id, captionId: caption.id };
  try {
    await createEffectCaptionVoice(props.projectId, packaging.runId, packaging.id, {
      captionId: caption.id,
      text,
    });
    captionVoiceTimer = setTimeout(() => {
      pendingCaptionVoice.value = null;
      captionVoiceBusy.value = false;
      showNotice('字幕口播生成超时，请稍后重试', 'warning');
    }, CAPTION_VOICE_TIMEOUT_MS);
  } catch (error) {
    pendingCaptionVoice.value = null;
    captionVoiceBusy.value = false;
    showNotice(error instanceof Error ? error.message : '字幕口播生成请求失败', 'warning');
  }
};
/**
 * Landing the clip is the only thing the arrival has to do: the server already wrote it at the
 * caption's start, so the placement only decides which row it occupies.
 */
watch(
  () => selectedPackaging.value?.checkpoint.captionVoices,
  (captionVoices) => {
    const pending = pendingCaptionVoice.value;
    const packaging = selectedPackaging.value;
    if (!pending || !packaging || packaging.id !== pending.itemId) return;
    const audio = captionVoices?.[pending.captionId];
    if (!audio) return;
    clearTimeout(captionVoiceTimer);
    pendingCaptionVoice.value = null;
    captionVoiceBusy.value = false;
    placeGeneratedCaptionVoice(`capvoice:${pending.captionId}`, audio.start);
    showNotice('字幕口播已生成，可拖动或调整音量');
  },
);
const captionBoxStyle = (id: string): Record<string, string> => {
  const box = captionBox(id);
  return {
    left: `${(box.x - box.width / 2) * 100}%`,
    width: `${box.width * 100}%`,
    bottom: `${box.y * 100}%`,
    fontSize: `${Math.max(11, Math.round(stageCaptionFontSize.value * box.scale))}px`,
  };
};
/**
 * The audio row reads its values from the first selected clip — the standard — and every step is
 * written to the whole set. The standard is whichever clip the pointer reached first, so a group
 * of voiceovers converges on one volume and one pair of fades in a single click.
 */
const audioStandard = computed<{ kind: 'MUSIC' | 'VOICE'; audio: PackagingAudio } | null>(() => {
  const packaging = selectedPackaging.value;
  if (!packaging || packaging.status !== 'COMPLETED') return null;
  for (const clipId of selectedAudioClipIds.value) {
    const target = packagingAudioTarget(clipId);
    if (!target || target.kind === 'CAPTION') continue;
    const audio = packagingAudio(packaging.checkpoint, target);
    // A caption narration is a voice clip for every purpose the row cares about.
    if (audio) return { kind: target.kind === 'MUSIC' ? 'MUSIC' : 'VOICE', audio };
  }
  return null;
});
/**
 * The rows handed to the parameter list. Each fade's ceiling is what the *other* fade leaves, so
 * the two can never be dragged into a pair the clip cannot hold — the invariant is carried by the
 * ranges instead of by a rejection after the fact.
 */
const audioParamItems = computed<ParameterAdjustItem[]>(() => {
  const standard = audioStandard.value;
  if (!standard) return [];
  const length = standard.audio.duration;
  const fadeIn = packagingAudioFade(standard.audio, standard.kind, 'fadeIn');
  const fadeOut = packagingAudioFade(standard.audio, standard.kind, 'fadeOut');
  return [
    // dB, so the row reads the way a level is normally described. The bottom of the scale is silence,
    // which is why it is marked `-∞`; 0 dB is unity gain and is marked so it can be found again.
    {
      key: 'volume',
      label: '音量',
      unit: 'dB',
      min: AUDIO_DB_FLOOR,
      max: PACKAGING_AUDIO_DB_CEILING,
      step: 1,
      default: 0,
      floorLabel: '-∞',
      marks: [
        { value: AUDIO_DB_FLOOR, label: '-∞' },
        { value: 0, label: '0dB' },
      ],
    },
    {
      key: 'fadeIn',
      label: '淡入',
      unit: 's',
      min: 0,
      max: Math.min(AUDIO_FADE_MAX, Math.max(0, length - fadeOut)),
      step: 0.1,
    },
    {
      key: 'fadeOut',
      label: '淡出',
      unit: 's',
      min: 0,
      max: Math.min(AUDIO_FADE_MAX, Math.max(0, length - fadeIn)),
      step: 0.1,
    },
  ];
});
/** The standard's own numbers, in the rows' units, so the list and the checkpoint agree. */
const audioParamValues = computed<Record<string, number>>(() => {
  const standard = audioStandard.value;
  if (!standard) return {};
  return {
    // Whole dB, matching the row's 1 dB step, so a value that came from a gain lands on the grid.
    volume: Math.round(audioToDb(standard.audio.volume)),
    fadeIn: packagingAudioFade(standard.audio, standard.kind, 'fadeIn'),
    fadeOut: packagingAudioFade(standard.audio, standard.kind, 'fadeOut'),
  };
});
/**
 * Applies the list's numbers to every selected clip, so the set converges on the standard the row
 * was showing. Only the row that actually moved is written: the list reports all three numbers on
 * every gesture, and taking the untouched ones along would mean a fade nudge silently reset a gain,
 * or invented a fade on the edge nobody asked about.
 */
const onAudioParamsChange = (values: Record<string, number>): void => {
  const standard = audioStandard.value;
  if (!standard) return;
  const db = values.volume ?? Math.round(audioToDb(standard.audio.volume));
  const volumeTouched = Math.abs(audioToDb(standard.audio.volume) - db) >= 0.5;
  const fadeInTouched =
    (values.fadeIn ?? 0) !== packagingAudioFade(standard.audio, standard.kind, 'fadeIn');
  const fadeOutTouched =
    (values.fadeOut ?? 0) !== packagingAudioFade(standard.audio, standard.kind, 'fadeOut');
  if (!volumeTouched && !fadeInTouched && !fadeOutTouched) return;
  editPackagingAudio((checkpoint) => {
    for (const clipId of selectedAudioClipIds.value) {
      const target = packagingAudioTarget(clipId);
      if (!target || target.kind === 'CAPTION') continue;
      const audio = packagingAudio(checkpoint, target);
      if (!audio) continue;
      // A caption narration takes the narration fade default, so only the music bed differs.
      const kind: 'MUSIC' | 'VOICE' = target.kind === 'MUSIC' ? 'MUSIC' : 'VOICE';
      if (volumeTouched) {
        // One ceiling for every kind: the row's own top end, which the server accepts as-is.
        audio.volume = audioFromDb(
          Math.min(PACKAGING_AUDIO_DB_CEILING, Math.max(AUDIO_DB_FLOOR, db)),
        );
      }
      // A clip shorter than the standard cannot hold the same fade, so each one keeps the other
      // edge it already has and caps this one by what is left — never past its own end.
      if (fadeInTouched) {
        const room = Math.max(0, audio.duration - packagingAudioFade(audio, kind, 'fadeOut'));
        const fadeIn = Math.min(values.fadeIn ?? 0, room);
        if (fadeIn !== packagingAudioFade(audio, kind, 'fadeIn'))
          audio.fadeIn = Math.round(fadeIn * 100) / 100;
      }
      if (fadeOutTouched) {
        const room = Math.max(0, audio.duration - packagingAudioFade(audio, kind, 'fadeIn'));
        const fadeOut = Math.min(values.fadeOut ?? 0, room);
        if (fadeOut !== packagingAudioFade(audio, kind, 'fadeOut'))
          audio.fadeOut = Math.round(fadeOut * 100) / 100;
      }
    }
  });
};
type CaptionDragMode = 'MOVE' | 'LEFT' | 'RIGHT' | 'SCALE';
/** Snapped alignment lines, so the drag reads like an editor instead of free-floating. */
const captionGuideX = ref<number | null>(null);
const captionGuideY = ref<number | null>(null);
/**
 * The stage clips its overflow, so a line drawn exactly on the far border would fall outside it;
 * pulling it in by its own width puts it on the border instead. The width comes from the same
 * custom property the line is drawn with.
 */
const captionGuideOffset = (value: number): string =>
  `calc(${value * 100}%${value >= 1 ? ' - var(--caption-guide-width)' : ''})`;
let captionDrag: {
  id: string;
  mode: CaptionDragMode;
  startX: number;
  startY: number;
  /** Starting geometry of every caption that moves with this drag, keyed by caption id. */
  boxes: Record<string, PackagingCaptionBox>;
  bounds: DOMRect;
  height: number;
  /** Visible frame size, which is what actually reaches a border — the wrap box is wider. */
  frameWidth: number;
  /** Client Y of the frame's bottom edge, which the corner drag scales the text away from. */
  frameBottom: number;
  moved: boolean;
} | null = null;
/**
 * Picks the first alignment target within the snap threshold, and reports which guide line to
 * draw. Ordered by preference, so a box dragged near the middle prefers the centre line.
 */
const snapAxis = (
  value: number,
  candidates: Array<{ target: number; guide: number }>,
  threshold: number,
): { value: number; guide: number | null } => {
  for (const { target, guide } of candidates) {
    if (Math.abs(value - target) <= threshold) return { value: target, guide };
  }
  return { value, guide: null };
};
/**
 * Three lines can sit within a hair of each other once the caption nearly fills the frame — the
 * centre and both borders collapse together — and their snap zones would then merge into one that
 * no drag can escape, which reads as "it snapped and now it is stuck". Holding the threshold to a
 * third of the gap between neighbouring targets keeps a free strip between every pair, so the
 * caption always has somewhere to rest and can be dragged back off a line.
 */
const snapThreshold = (span: number): number => Math.min(CAPTION_SNAP, Math.max(0, span) / 3);
/**
 * The frame has no side handles, so which part of it was grabbed decides move versus stretch.
 * The zones straddle the edges rather than extending inwards, so clicking the empty wrap space
 * beside a short caption still moves it instead of stretching it.
 */
const captionDragMode = (clientX: number, rect: DOMRect): CaptionDragMode => {
  // A frame too narrow for three grab zones could never be moved, so it only ever moves.
  if (rect.width < CAPTION_EDGE_GRAB * 3) return 'MOVE';
  if (clientX >= rect.left - CAPTION_EDGE_GRAB && clientX <= rect.left + CAPTION_EDGE_GRAB) {
    return 'LEFT';
  }
  if (clientX >= rect.right - CAPTION_EDGE_GRAB && clientX <= rect.right + CAPTION_EDGE_GRAB) {
    return 'RIGHT';
  }
  return 'MOVE';
};
const onCaptionBoxPointerDown = (event: PointerEvent, forced?: CaptionDragMode): void => {
  const caption = previewCaption.value;
  const box = (event.currentTarget as HTMLElement | null)?.closest<HTMLElement>(
    '.player-caption-box',
  );
  const stage = stageElement.value;
  if (!caption || !box || !stage || event.button !== 0) return;
  event.preventDefault();
  event.stopPropagation();
  if (event.ctrlKey || event.metaKey) {
    // A modifier click only edits the selection, so it never starts a drag.
    selectedCaptionIds.value = selectedCaptionIds.value.includes(caption.id)
      ? selectedCaptionIds.value.filter((id) => id !== caption.id)
      : [...selectedCaptionIds.value, caption.id];
    return;
  }
  // Clicking one of several selected captions keeps the set, so the whole group can be dragged.
  if (!selectedCaptionIds.value.includes(caption.id)) selectedCaptionIds.value = [caption.id];
  if (!captionEditable.value) return;
  const bounds = stage.getBoundingClientRect();
  if (!bounds.width || !bounds.height) return;
  const rect = box.getBoundingClientRect();
  // The frame is what the user sees, so its edges — not the wider wrap box — own the grab zones.
  const frame = box.querySelector<HTMLElement>('.player-caption')?.getBoundingClientRect() ?? rect;
  const mode = forced ?? captionDragMode(event.clientX, frame);
  // Wrap width belongs to one caption's own text, so a stretch never reaches the rest of the set.
  const ids = mode === 'LEFT' || mode === 'RIGHT' ? [caption.id] : selectedCaptionIds.value;
  box.setPointerCapture(event.pointerId);
  captionDrag = {
    id: caption.id,
    mode,
    startX: event.clientX,
    startY: event.clientY,
    boxes: Object.fromEntries(ids.map((id) => [id, { ...captionBox(id) }])),
    bounds,
    height: rect.height / bounds.height,
    frameWidth: frame.width / bounds.width,
    frameBottom: frame.bottom,
    moved: false,
  };
};
const onCaptionBoxPointerMove = (event: PointerEvent): void => {
  const drag = captionDrag;
  if (!drag) return;
  const rawX = event.clientX - drag.startX;
  const rawY = event.clientY - drag.startY;
  if (!drag.moved && Math.hypot(rawX, rawY) <= 4) return;
  drag.moved = true;
  const dx = rawX / drag.bounds.width;
  const dy = -rawY / drag.bounds.height;
  const origin = drag.boxes[drag.id]!;
  const next: Record<string, PackagingCaptionBox> = {};
  captionGuideX.value = null;
  captionGuideY.value = null;
  if (drag.mode === 'SCALE') {
    // Proportional, the way a corner resize works everywhere: the frame's bottom edge is the
    // anchor, so pulling the dot up away from it enlarges the text and pushing it back shrinks it.
    const startDistance = Math.max(1, drag.frameBottom - drag.startY);
    const distance = Math.max(1, drag.frameBottom - event.clientY);
    const scale = Math.min(4, Math.max(0.25, (origin.scale * distance) / startDistance));
    for (const [id, box] of Object.entries(drag.boxes)) next[id] = { ...box, scale };
  } else if (drag.mode === 'MOVE') {
    // Clamped and snapped on the visible frame, not the wrap box: the text hugs its glyphs, so
    // the box's edges would stop it well short of the border and the line would never appear.
    const half = Math.min(0.5, drag.frameWidth / 2);
    // Five snap lines, as in CapCut: the player's four borders plus the middle column. It is the
    // caption's own edge that lands on a border, so those targets are shifted by half the frame
    // width across and by the full block height up. The middle column wins when both are in range.
    const across = snapAxis(
      Math.min(Math.max(origin.x + dx, half), 1 - half),
      [
        { target: 0.5, guide: 0.5 },
        { target: half, guide: 0 },
        { target: 1 - half, guide: 1 },
      ],
      snapThreshold(0.5 - half),
    );
    // A block taller than the frame cannot reach the top border, so the ceiling collapses to the
    // floor rather than inverting the clamp.
    const down = snapAxis(
      Math.min(Math.max(origin.y + dy, 0), Math.max(0, 1 - drag.height)),
      [
        { target: 0, guide: 0 },
        { target: 1 - drag.height, guide: 1 },
      ],
      snapThreshold(1 - drag.height),
    );
    captionGuideX.value = across.guide;
    captionGuideY.value = down.guide;
    // The grabbed caption is the standard: the rest of the set takes its position and its font
    // size outright, rather than sliding by the same amount. A group is only ever as aligned as
    // this gesture makes it, so one drag lines up both where the captions sit and how big they are.
    for (const id of Object.keys(drag.boxes)) {
      next[id] = { ...drag.boxes[id]!, x: across.value, y: down.value, scale: origin.scale };
    }
  } else {
    // The opposite edge stays put, so stretching only ever grows one side. Wrap width is a
    // property of this caption's own text, so a stretch never reaches the rest of the set.
    const left = origin.x - origin.width / 2;
    const right = origin.x + origin.width / 2;
    let width =
      drag.mode === 'RIGHT'
        ? Math.min(Math.max(origin.width + dx, 0.1), 1 - left)
        : Math.min(Math.max(origin.width - dx, 0.1), right);
    if (drag.mode === 'RIGHT' && Math.abs(left + width - 1) <= CAPTION_SNAP) {
      width = 1 - left;
      captionGuideX.value = 1;
    } else if (drag.mode === 'LEFT' && Math.abs(right - width) <= CAPTION_SNAP) {
      width = right;
      captionGuideX.value = 0;
    }
    next[drag.id] = {
      ...origin,
      width,
      x: drag.mode === 'RIGHT' ? left + width / 2 : right - width / 2,
    };
  }
  editPackagingAudio((checkpoint) => {
    checkpoint.captionBoxes = { ...(checkpoint.captionBoxes ?? {}), ...next };
  });
};
const onCaptionBoxPointerUp = (event: PointerEvent): void => {
  const box = (event.currentTarget as HTMLElement | null)?.closest<HTMLElement>(
    '.player-caption-box',
  );
  if (box?.hasPointerCapture(event.pointerId)) box.releasePointerCapture(event.pointerId);
  captionDrag = null;
  captionGuideX.value = null;
  captionGuideY.value = null;
};
/** Steps by one rendered pixel so the control reads in the same units the preview shows. */
const changeCaptionScale = (step: number): void => {
  const target = captionScaleTarget.value;
  if (!target || !captionEditable.value) return;
  const base = stageCaptionFontSize.value;
  const scale = Math.min(4, Math.max(0.25, (captionFontSize.value + step) / base));
  // A set holds one size, so every selected caption takes the stepped value.
  const ids = selectedCaptionIds.value.length ? selectedCaptionIds.value : [target];
  editPackagingAudio((checkpoint) => {
    // Captured before the new size is written, so undo steps back to the previous size.
    rememberTimelineEdit();
    const boxes = { ...(checkpoint.captionBoxes ?? {}) };
    for (const id of ids) boxes[id] = { ...captionBox(id), scale };
    checkpoint.captionBoxes = boxes;
  });
};
const updateWorkbenchMode = (): void => {
  compactWorkbench.value = window.innerWidth <= 1050;
  if (view.value === 'EDITOR') void fitPlayerPaneToMaterial();
};
const fitPlayerPaneToMaterial = async (): Promise<void> => {
  if (compactWorkbench.value || view.value !== 'EDITOR') return;
  await nextTick();
  const bounds = workbenchMain.value?.getBoundingClientRect();
  if (!bounds) return;
  const maximumLeft = Math.min(
    LEFT_PANE_MAX_WIDTH,
    Math.max(LEFT_PANE_MIN_WIDTH, bounds.width - rightPaneWidth.value - CENTER_PANE_MIN_WIDTH - 14),
  );
  leftPaneWidth.value = Math.round(
    Math.max(LEFT_PANE_MIN_WIDTH, Math.min(maximumLeft, leftPaneWidth.value)),
  );
};
const stopPaneResize = (): void => {
  resizingPane.value = null;
  window.removeEventListener('pointermove', resizePane);
  window.removeEventListener('pointerup', stopPaneResize);
};
function resizePane(event: PointerEvent): void {
  const bounds = workbenchMain.value?.getBoundingClientRect();
  if (!bounds || !resizingPane.value) return;
  if (resizingPane.value === 'LEFT') {
    const maximum = Math.min(
      LEFT_PANE_MAX_WIDTH,
      Math.max(
        LEFT_PANE_MIN_WIDTH,
        bounds.width - rightPaneWidth.value - CENTER_PANE_MIN_WIDTH - 14,
      ),
    );
    leftPaneWidth.value = Math.round(
      Math.max(LEFT_PANE_MIN_WIDTH, Math.min(maximum, event.clientX - bounds.left)),
    );
    return;
  }
  const maximum = Math.min(440, bounds.width - leftPaneWidth.value - CENTER_PANE_MIN_WIDTH - 14);
  rightPaneWidth.value = Math.round(Math.max(220, Math.min(maximum, bounds.right - event.clientX)));
}
const startPaneResize = (event: PointerEvent, pane: 'LEFT' | 'RIGHT'): void => {
  if (event.button !== 0 || compactWorkbench.value) return;
  event.preventDefault();
  resizingPane.value = pane;
  window.addEventListener('pointermove', resizePane);
  window.addEventListener('pointerup', stopPaneResize, { once: true });
};
const stopEditorHeightResize = (): void => {
  resizingEditorHeight.value = null;
  window.removeEventListener('pointermove', resizeEditorHeight);
  window.removeEventListener('pointerup', stopEditorHeightResize);
};
function resizeEditorHeight(event: PointerEvent): void {
  const resize = resizingEditorHeight.value;
  if (!resize) return;
  const nextTopHeight = Math.max(
    320,
    Math.min(resize.totalHeight - 220, resize.startTopHeight + event.clientY - resize.startClientY),
  );
  topPaneHeight.value = Math.round(nextTopHeight);
  timelineHeight.value = Math.round(resize.totalHeight - nextTopHeight);
}
const startEditorHeightResize = (event: PointerEvent): void => {
  if (event.button !== 0) return;
  event.preventDefault();
  resizingEditorHeight.value = {
    startClientY: event.clientY,
    startTopHeight: topPaneHeight.value,
    totalHeight: topPaneHeight.value + timelineHeight.value,
  };
  window.addEventListener('pointermove', resizeEditorHeight);
  window.addEventListener('pointerup', stopEditorHeightResize, { once: true });
};
const resetEditorHeight = (): void => {
  topPaneHeight.value = 480;
  timelineHeight.value = 260;
};
const addTemplate = (): void => {
  const name = newTemplateName.value.trim();
  if (!name) {
    showNotice('请输入模板名称', 'warning');
    return;
  }
  if (createTemplateNameConflict.value) {
    showNotice('当前工作流已有同名模板，请修改名称', 'warning');
    return;
  }
  const entry = createEffectTemplateMixEntry(name);
  entry.workspace.materials = sourceMaterials.value;
  catalog.value.push(entry);
  uiByTemplate[entry.id] = {
    selectedSlotId: entry.workspace.template.slots[0]?.id ?? '',
    selectedVariantId: '',
  };
  activeTemplateId.value = entry.id;
  createOpen.value = false;
  view.value = 'CONFIG';
  scheduleSave();
};
const submitTemplateOnEnter = (event: KeyboardEvent): void => {
  // Enter may still be accepting a Chinese IME candidate; only submit after composition ends.
  if (event.isComposing || event.keyCode === 229) return;
  event.preventDefault();
  addTemplate();
};
const setTimelinePlayer = (slotId: string, element: unknown): void => {
  if (element instanceof HTMLVideoElement) {
    timelinePlayers.set(slotId, element);
  } else timelinePlayers.delete(slotId);
};
const setDetachedAudioPlayer = (clipId: string, element: unknown): void => {
  if (element instanceof HTMLAudioElement) detachedAudioPlayers.set(clipId, element);
  else detachedAudioPlayers.delete(clipId);
};
const detachedAudioSourceUrl = (audio: EffectTemplateMixDetachedAudio): string => {
  if (audio.sourceAssetId)
    return apiUrl(
      `/projects/${encodeURIComponent(props.projectId)}/assets/${encodeURIComponent(audio.sourceAssetId)}/content`,
    );
  return (
    workspace.value?.materials.find((item) => item.fileObjectId === audio.fileObjectId)
      ?.contentUrl ??
    apiUrl(
      `/projects/${encodeURIComponent(props.projectId)}/file-objects/${encodeURIComponent(audio.fileObjectId)}/content`,
    )
  );
};
const resetTimelinePlayerState = (): void => {
  primedTimelinePlayers = new WeakSet<HTMLVideoElement>();
  positionedTimelinePlayers = new WeakSet<HTMLVideoElement>();
  activePlaybackSlotId = '';
  activeTransitionSignature = '';
  for (const video of timelinePlayers.values()) video.pause();
  for (const player of detachedAudioPlayers.values()) {
    player.pause();
    player.dataset.timelineActive = 'false';
  }
};
type AudioDetectableVideo = HTMLVideoElement & {
  audioTracks?: { length: number };
  mozHasAudio?: boolean;
  webkitAudioDecodedByteCount?: number;
};
const detectMaterialAudio = (
  material: EffectTemplateMixMaterial | null,
  player: HTMLVideoElement | null,
): void => {
  if (!material || !player) return;
  const audioPlayer = player as AudioDetectableVideo;
  if (typeof audioPlayer.mozHasAudio === 'boolean') {
    materialAudioPresence[material.id] = audioPlayer.mozHasAudio;
    return;
  }
  if (audioPlayer.audioTracks) {
    materialAudioPresence[material.id] = audioPlayer.audioTracks.length > 0;
    return;
  }
  if ((audioPlayer.webkitAudioDecodedByteCount ?? 0) > 0) {
    materialAudioPresence[material.id] = true;
    return;
  }
  // No decoded bytes at one arbitrary frame is inconclusive for sources with sparse audio.
};
const activeTimelinePlayer = (): HTMLVideoElement | null =>
  previewSlot.value ? (timelinePlayers.get(previewSlot.value.id) ?? null) : null;
const slotHasDetachedAudio = (slotId: string): boolean =>
  Boolean(selectedVariant.value?.detachedAudios?.some((audio) => audio.sourceSlotId === slotId));
const syncDetachedAudio = (forceSeek = false): void => {
  const rows = selectedVariant.value?.detachedAudios ?? [];
  const activeIds = new Set(rows.map(({ id }) => id));
  for (const [id, player] of detachedAudioPlayers) {
    const row = rows.find((audio) => audio.id === id);
    if (!row || !activeIds.has(id)) {
      player.pause();
      player.dataset.timelineActive = 'false';
      player.dataset.timelineStarting = 'false';
      continue;
    }
    const localTime = playhead.value - row.start;
    // Each separated or imported clip follows the row it was dropped on, so muting one row no
    // longer silences every detached clip at once.
    const active =
      playing.value &&
      !mutedAudioClip(`detached:${row.id}`) &&
      localTime >= 0 &&
      localTime < row.duration;
    if (!active) {
      player.pause();
      player.dataset.timelineActive = 'false';
      player.dataset.timelineStarting = 'false';
      continue;
    }
    const sourceTime = Math.max(0, row.offset + localTime);
    const entering = player.dataset.timelineActive !== 'true';
    if (forceSeek || entering) {
      try {
        player.currentTime = sourceTime;
      } catch {
        // The browser retries the source position once its audio metadata is ready.
      }
    }
    player.volume = Math.max(0, Math.min(1, row.volume));
    player.dataset.timelineActive = 'true';
    if (player.paused && player.dataset.timelineStarting !== 'true') {
      player.dataset.timelineStarting = 'true';
      void player
        .play()
        .catch(() => undefined)
        .finally(() => {
          player.dataset.timelineStarting = 'false';
          if (player.dataset.timelineActive !== 'true') player.pause();
        });
    }
  }
};
// A centered transition starts the incoming media before its nominal cut. Keep
// that same origin after the transition so the native video clock never jumps
// back to the clip's first frame when the transition layer is removed.
const timelinePlaybackStart = (slotId: string): number => {
  const variant = selectedVariant.value;
  const slotIndex = variant?.slots.findIndex(({ id }) => id === slotId) ?? -1;
  const range = currentTiming.value.slots.find(({ id }) => id === slotId);
  if (!variant || slotIndex <= 0 || !range) return range?.start ?? 0;
  const slot = variant.slots[slotIndex];
  const previousSlot = variant.slots[slotIndex - 1];
  const previousRange = currentTiming.value.slots.find(({ id }) => id === previousSlot?.id);
  if (!slot || !previousSlot || !previousRange || slot.transition === '硬切') return range.start;
  const duration = effectTemplateMixTransitionDuration(slot, previousSlot);
  return Math.max(previousRange.start, range.start - duration / 2);
};
const timelineSourceTime = (slotId: string): number | null => {
  const slot = selectedVariant.value?.slots.find(({ id }) => id === slotId);
  const material = materialForSlot(slotId);
  if (!slot || !material) return null;
  const elapsed = Math.max(0, playhead.value - timelinePlaybackStart(slotId));
  const offset = selectedVariant.value?.offsets[slotId] ?? 0;
  return Math.max(0, Math.min(material.duration - 1 / TIMELINE_FPS, offset + elapsed));
};
const syncTimelineVideo = (
  slotId: string,
  resume: boolean,
  seekMode: 'drift' | 'once' = 'drift',
): HTMLVideoElement | null => {
  const video = timelinePlayers.get(slotId);
  const sourceTime = timelineSourceTime(slotId);
  if (!video || sourceTime === null) return null;
  if (
    video.readyState === HTMLMediaElement.HAVE_NOTHING &&
    video.src &&
    !primedTimelinePlayers.has(video)
  ) {
    video.preload = 'auto';
    video.load();
    primedTimelinePlayers.add(video);
  }
  if (video.readyState >= HTMLMediaElement.HAVE_METADATA) {
    const needsSeek =
      seekMode === 'once'
        ? !positionedTimelinePlayers.has(video)
        : !positionedTimelinePlayers.has(video) ||
          Math.abs(video.currentTime - sourceTime) > 1 / TIMELINE_FPS;
    if (needsSeek) {
      try {
        video.currentTime = sourceTime;
        positionedTimelinePlayers.add(video);
      } catch {
        // Metadata can be replaced while a source is loading; the ready callback retries.
      }
    }
  }
  if (resume && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.paused) {
    void video.play().catch(() => undefined);
  }
  return video;
};
const primeUpcomingTimelinePlayer = (range: { id: string; end: number }): void => {
  const upcoming = currentTiming.value.slots
    .filter(
      (candidate) =>
        candidate.id !== range.id &&
        candidate.start >= range.end &&
        Boolean(materialForSlot(candidate.id)),
    )
    .sort((left, right) => left.start - right.start)[0];
  if (!upcoming) return;
  const video = timelinePlayers.get(upcoming.id);
  if (!video) return;
  if (!primedTimelinePlayers.has(video)) {
    video.preload = 'auto';
    video.load();
    primedTimelinePlayers.add(video);
  }
  if (!positionedTimelinePlayers.has(video) && video.readyState >= HTMLMediaElement.HAVE_METADATA) {
    const targetTime = selectedVariant.value?.offsets[upcoming.id] ?? 0;
    try {
      if (Math.abs(video.currentTime - targetTime) > 1 / TIMELINE_FPS) {
        video.currentTime = targetTime;
      }
      positionedTimelinePlayers.add(video);
    } catch {
      // Metadata may be replaced while a source is loading; the ready callback retries.
    }
  }
};
const pauseTimelinePlayers = (exceptSlotId: string | string[] = ''): void => {
  const keep = new Set(Array.isArray(exceptSlotId) ? exceptSlotId : [exceptSlotId]);
  for (const [slotId, video] of timelinePlayers) {
    if (!keep.has(slotId)) video.pause();
  }
};
const closeMaterialPreview = (): void => {
  auditionPlayer.value?.pause();
  auditionPlaying.value = false;
  auditionMaterial.value = null;
  auditionTime.value = 0;
};
const captureDisplayedFrame = (): string => {
  const slotId = displayedTimelineSlotId.value;
  const video = slotId ? timelinePlayers.get(slotId) : null;
  if (!video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return '';
  try {
    const scale = Math.min(1, 640 / Math.max(video.videoWidth, 1));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const context = canvas.getContext('2d');
    if (!context) return '';
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.82);
  } catch {
    // Cross-origin media without CORS cannot be copied to a canvas. In that
    // case the normal video readiness path remains the fallback.
    return '';
  }
};
const previewLibraryMaterial = async (material: EffectTemplateMixMaterial): Promise<void> => {
  playing.value = false;
  stopPlaybackClock();
  pauseTimelinePlayers();
  auditionMaterial.value = material;
  auditionTime.value = 0;
  await nextTick();
  const video = auditionPlayer.value;
  if (!video) return;
  video.load();
  video.currentTime = 0;
  try {
    await video.play();
  } catch {
    showNotice('浏览器阻止了自动播放，请点击播放器中的播放按钮', 'warning');
  }
};
const selectTemplate = (id: string): void => {
  playing.value = false;
  pauseTimelinePlayers();
  resetTimelinePlayerState();
  closeMaterialPreview();
  stopPlaybackClock();
  transitionFrame.value = '';
  activeTemplateId.value = id;
  clearTimelineHistory();
  resetWorkbenchDefaults();
  scheduleSave();
};
const enterEditor = (): void => {
  playing.value = false;
  pauseTimelinePlayers();
  resetTimelinePlayerState();
  closeMaterialPreview();
  stopPlaybackClock();
  transitionFrame.value = '';
  resetWorkbenchDefaults();
  playhead.value = 0;
  clearTimelineHistory();
  view.value = 'EDITOR';
};
const selectVariant = (id: string): void => {
  if (!activeUi.value || !workspace.value) return;
  transitionFrame.value = captureDisplayedFrame();
  playing.value = false;
  pauseTimelinePlayers();
  resetTimelinePlayerState();
  closeMaterialPreview();
  stopPlaybackClock();
  activeTransitionSlotId.value = '';
  clearTransitionPreviews();
  activeUi.value.selectedVariantId = id;
  activeUi.value.selectedSlotId =
    workspace.value.variants.find((item) => item.id === id)?.slots[0]?.id ?? '';
  playhead.value = 0;
  clearTimelineHistory();
  void syncPlayerToPlayhead(false);
};
let lastPreviewTarget: typeof props.previewTarget = null;
const applyPreviewTarget = (): void => {
  const target = props.previewTarget;
  if (
    !target ||
    target === lastPreviewTarget ||
    pageState.value !== 'READY' ||
    target.projectId !== props.projectId ||
    target.workflowRunId !== props.workflowRunId
  )
    return;
  lastPreviewTarget = target;
  const entry = catalog.value.find(({ id }) => id === target.templateId);
  if (!entry || !entry.workspace.variants.some(({ id }) => id === target.variantId)) {
    showNotice('这条成片工程已不在当前混剪草稿中，无法预览', 'warning');
    return;
  }
  activeTemplateId.value = target.templateId;
  resetWorkbenchDefaults();
  view.value = 'EDITOR';
  selectVariant(target.variantId);
  if (committedVersions[target.templateId] !== entry.workspace.editVersion)
    showNotice('当前混剪草稿已变化，播放器展示的是最新草稿画面', 'warning');
};
const returnToFinalOutput = (): void => {
  playing.value = false;
  pauseTimelinePlayers();
  stopPlaybackClock();
  packagingPanel.value?.stopPlaybackAudio();
  emit('next');
};
const leaveEditor = (): void => {
  playing.value = false;
  pauseTimelinePlayers();
  resetTimelinePlayerState();
  closeMaterialPreview();
  stopPlaybackClock();
  transitionFrame.value = '';
  view.value = 'CONFIG';
};
const selectSlot = (id: string): void => {
  if (!activeUi.value) return;
  closeMaterialPreview();
  activeTransitionSlotId.value = '';
  clearTransitionPreviews();
  activeUi.value.selectedSlotId = id;
};
const moveMaterialToSlot = (material: EffectTemplateMixMaterial, targetSlotId: string): void => {
  const variant = selectedVariant.value;
  const targetSlot = variant?.slots.find(({ id }) => id === targetSlotId);
  if (!variant || !targetSlot) return;
  const sourceSlot = variant.slots.find(({ id }) => variant.bindings[id] === material.id) ?? null;
  if (sourceSlot?.id === targetSlot.id) {
    showNotice(`${material.code} 已经在${targetSlot.label}`, 'warning');
    return;
  }
  const targetMaterialId = variant.bindings[targetSlot.id];
  const targetMaterial = targetMaterialId
    ? (workspace.value?.materials.find(({ id }) => id === targetMaterialId) ?? null)
    : null;
  if (!sourceSlot && targetMaterial) {
    showNotice(`${targetSlot.label} 已有素材，请先选择一个空槽位`, 'warning');
    return;
  }
  if (material.duration < targetSlot.duration) {
    showNotice('素材短于目标槽位时长，请先缩短目标槽位', 'warning');
    return;
  }
  if (sourceSlot && targetMaterial && targetMaterial.duration < sourceSlot.duration) {
    showNotice('原目标素材不满足交换后的槽位时长，无法更换', 'warning');
    return;
  }
  rememberTimelineEdit();
  if (sourceSlot && targetMaterial) {
    variant.bindings[sourceSlot.id] = targetMaterial.id;
    variant.bindingRevisions[sourceSlot.id] = targetMaterial.artifactRevision;
    variant.offsets[sourceSlot.id] = 0;
    variant.bindingMetadata ??= {};
    variant.bindingMetadata[sourceSlot.id] = {
      source: 'MANUAL',
      classificationReason: '人工交换素材槽位',
    };
    if (!variant.manualSlotIds.includes(sourceSlot.id)) variant.manualSlotIds.push(sourceSlot.id);
  } else if (sourceSlot) {
    delete variant.bindings[sourceSlot.id];
    delete variant.bindingRevisions[sourceSlot.id];
    delete variant.offsets[sourceSlot.id];
    if (variant.bindingMetadata) delete variant.bindingMetadata[sourceSlot.id];
    variant.manualSlotIds = variant.manualSlotIds.filter((id) => id !== sourceSlot.id);
  }
  clearDetachedAudioForSlots(variant, [targetSlot.id, ...(sourceSlot ? [sourceSlot.id] : [])]);
  variant.bindings[targetSlot.id] = material.id;
  variant.bindingRevisions[targetSlot.id] = material.artifactRevision;
  variant.offsets[targetSlot.id] = 0;
  variant.bindingMetadata ??= {};
  variant.bindingMetadata[targetSlot.id] = {
    source: 'MANUAL',
    classificationReason: sourceSlot && targetMaterial ? '人工交换素材槽位' : '人工移动素材槽位',
  };
  if (!variant.manualSlotIds.includes(targetSlot.id)) variant.manualSlotIds.push(targetSlot.id);
  variant.conflictSlotIds = variant.conflictSlotIds.filter(
    (id) => id !== targetSlot.id && (!sourceSlot || id !== sourceSlot.id),
  );
  clearDetachedTransitions(variant);
  if (activeUi.value) activeUi.value.selectedSlotId = targetSlot.id;
  resetTimelinePlayerState();
  bump();
  showNotice(
    sourceSlot && targetMaterial
      ? `已将${material.name}与${targetSlot.label}素材交换槽位`
      : `已将${material.name}移动到${targetSlot.label}`,
  );
};
type TimelineVideoPaste = {
  materialId: string;
  targetSlotId: string;
  offset: number;
  duration: number;
  detachedAudio?: EffectTemplateMixDetachedAudio;
};
const pasteTimelineVideoMaterials = (items: TimelineVideoPaste[]): void => {
  const variant = selectedVariant.value;
  const materials = workspace.value?.materials;
  if (!variant || !materials?.length || !items.length) return;
  if (projectEditLocked.value) {
    showNotice('当前任务正在运行，暂时不能粘贴素材', 'warning');
    return;
  }
  const targets = new Set(items.map(({ targetSlotId }) => targetSlotId));
  const materialIds = items.map(({ materialId }) => materialId);
  if (targets.size !== items.length || new Set(materialIds).size !== items.length) {
    showNotice('复制内容与目标槽位重复，请重新选择后粘贴', 'warning');
    return;
  }
  const resolved = items.map((item) => {
    const slot = variant.slots.find(({ id }) => id === item.targetSlotId);
    const material = materials.find(({ id }) => id === item.materialId);
    if (
      !slot ||
      !material?.available ||
      item.duration < 4 ||
      item.duration > 15 ||
      item.offset < 0 ||
      item.offset + item.duration > material.duration
    )
      return null;
    return { ...item, slot, material };
  });
  if (resolved.some((item) => !item)) {
    showNotice('复制素材已失效或超出目标时长，未粘贴任何内容', 'warning');
    return;
  }
  const overwrittenSlots = new Set(items.map(({ targetSlotId }) => targetSlotId));
  if (
    resolved.some((item) =>
      variant.slots.some(
        (slot) => !overwrittenSlots.has(slot.id) && variant.bindings[slot.id] === item!.material.id,
      ),
    )
  ) {
    showNotice('同一成片不能重复使用同一个视频素材', 'warning');
    return;
  }
  rememberTimelineEdit();
  clearDetachedAudioForSlots(variant, [...overwrittenSlots]);
  for (const item of resolved) {
    if (!item) continue;
    variant.bindings[item.slot.id] = item.material.id;
    variant.bindingRevisions[item.slot.id] = item.material.artifactRevision;
    variant.offsets[item.slot.id] = item.offset;
    item.slot.duration = item.duration;
    variant.bindingMetadata ??= {};
    variant.bindingMetadata[item.slot.id] = {
      source: 'MANUAL',
      classificationReason: '从同模板其他成片粘贴素材',
      trimReason: '复制素材截取范围',
    };
    if (!variant.manualSlotIds.includes(item.slot.id)) variant.manualSlotIds.push(item.slot.id);
    variant.conflictSlotIds = variant.conflictSlotIds.filter((id) => id !== item.slot.id);
    if (item.detachedAudio) {
      const start = currentTiming.value.slots.find(({ id }) => id === item.slot.id)?.start ?? 0;
      variant.detachedAudios = [
        ...(variant.detachedAudios ?? []),
        {
          ...item.detachedAudio,
          id: crypto.randomUUID(),
          sourceSlotId: item.slot.id,
          start,
          duration: item.duration,
        },
      ];
    }
  }
  clearDetachedTransitions(variant);
  activeUi.value &&
    (activeUi.value.selectedSlotId = resolved.at(-1)?.slot.id ?? activeUi.value.selectedSlotId);
  resetTimelinePlayerState();
  bump();
  showNotice(`已粘贴 ${items.length} 个视频素材`);
};
const pasteTimelineAudioMaterial = (audio: {
  fileObjectId: string;
  name: string;
  sourceAssetId?: string;
  sourceDuration: number;
  duration: number;
  start: number;
  offset: number;
  volume: number;
  row?: number;
}): void => {
  const variant = selectedVariant.value;
  if (!variant) return;
  if (projectEditLocked.value) {
    showNotice('当前任务正在运行，暂时不能粘贴音频', 'warning');
    return;
  }
  const start = Math.max(0, Math.min(currentDuration.value, audio.start));
  const duration = Math.min(
    audio.duration,
    Math.max(0, currentDuration.value - start),
    Math.max(0, audio.sourceDuration - audio.offset),
  );
  if (!audio.fileObjectId || duration < 0.1) {
    showNotice('音频素材已失效，或播放头超出成片范围', 'warning');
    return;
  }
  rememberTimelineEdit();
  const pasted: EffectTemplateMixDetachedAudio = {
    id: crypto.randomUUID(),
    ...(audio.sourceAssetId ? { sourceAssetId: audio.sourceAssetId } : {}),
    fileObjectId: audio.fileObjectId,
    name: audio.name,
    sourceDuration: audio.sourceDuration,
    duration,
    start,
    offset: audio.offset,
    volume: audio.volume,
  };
  variant.detachedAudios = [...(variant.detachedAudios ?? []), pasted];
  // A paste asked for from a row's menu continues on that row; one asked for from the keyboard has
  // no row, so the clip falls back to the default row for its kind.
  if (audio.row !== undefined) {
    variant.audioLanes ??= {};
    variant.audioLanes[`detached:${pasted.id}`] = Math.max(0, Math.round(audio.row));
  }
  normalizeVariantAudioLanes(variant);
  selectedCaptionIds.value = [];
  selectedAudioClipIds.value = [`detached:${pasted.id}`];
  resetTimelinePlayerState();
  bump();
  showNotice('音频素材已粘贴到当前成片');
};
const applyMaterialToSlot = (material: EffectTemplateMixMaterial, slotId: string): void => {
  const variant = selectedVariant.value;
  const slot = variant?.slots.find(({ id }) => id === slotId);
  if (!variant || !slot) return;
  const occupiedSlotId = Object.entries(variant.bindings).find(
    ([boundSlotId, materialId]) => boundSlotId !== slot.id && materialId === material.id,
  )?.[0];
  if (occupiedSlotId) {
    const occupiedSlot = variant.slots.find(({ id }) => id === occupiedSlotId);
    showNotice(
      `${material.code} 已用于“${occupiedSlot ? EFFECT_TEMPLATE_MIX_ROLE_LABELS[occupiedSlot.role] : '其他槽位'}”，同一成片不能重复使用`,
      'warning',
    );
    return;
  }
  if (material.duration < slot.duration) {
    showNotice('素材短于槽位时长，请先缩短槽位', 'warning');
    return;
  }
  rememberTimelineEdit();
  clearDetachedAudioForSlots(variant, [slot.id]);
  variant.bindings[slot.id] = material.id;
  variant.bindingRevisions[slot.id] = material.artifactRevision;
  variant.offsets[slot.id] = 0;
  variant.bindingMetadata ??= {};
  variant.bindingMetadata[slot.id] = {
    source: 'MANUAL',
    classificationReason: '人工更换素材槽位',
  };
  if (!variant.manualSlotIds.includes(slot.id)) variant.manualSlotIds.push(slot.id);
  variant.conflictSlotIds = variant.conflictSlotIds.filter((id) => id !== slot.id);
  clearDetachedTransitions(variant);
  if (activeUi.value) activeUi.value.selectedSlotId = slot.id;
  resetTimelinePlayerState();
  bump();
};
const removeMaterialFromSlot = (slotId: string): void => {
  const variant = selectedVariant.value;
  const slot = variant?.slots.find(({ id }) => id === slotId);
  if (!variant || !slot || !variant.bindings[slot.id]) return;
  rememberTimelineEdit();
  clearDetachedAudioForSlots(variant, [slot.id]);
  delete variant.bindings[slot.id];
  delete variant.bindingRevisions[slot.id];
  delete variant.offsets[slot.id];
  if (variant.bindingMetadata) delete variant.bindingMetadata[slot.id];
  variant.manualSlotIds = variant.manualSlotIds.filter((id) => id !== slot.id);
  // An overlay exists only because a material was dropped on it, so emptying it takes the whole
  // clip away. A template slot stays behind instead: the template still describes that beat.
  if (slot.overlay) {
    variant.slots = variant.slots.filter(({ id }) => id !== slot.id);
    delete variant.videoLanes?.[slot.id];
    delete variant.timelineStarts?.[slot.id];
    normalizeVariantVideoLanes(variant);
  }
  clearDetachedTransitions(variant);
  resetTimelinePlayerState();
  bump();
};
const clearMaterialPointerTarget = (): void => {
  document
    .querySelectorAll<HTMLElement>('.video-clip.is-material-pointer-target')
    .forEach((element) => {
      element.classList.remove('is-material-pointer-target');
    });
};
const updateMaterialPointerTarget = (clientX: number, clientY: number): string => {
  const element = document
    .elementFromPoint(clientX, clientY)
    ?.closest<HTMLElement>('.video-track [data-slot-id]');
  const slotId = element?.dataset.slotId ?? '';
  clearMaterialPointerTarget();
  if (element && slotId) element.classList.add('is-material-pointer-target');
  return slotId;
};
const removeMaterialPointerListeners = (): void => {
  window.removeEventListener('pointermove', onMaterialPointerMove);
  window.removeEventListener('pointerup', onMaterialPointerUp);
  window.removeEventListener('pointercancel', onMaterialPointerUp);
};
const onMaterialPointerMove = (event: PointerEvent): void => {
  const drag = materialPointerDrag.value;
  if (!drag) return;
  drag.clientX = event.clientX;
  drag.clientY = event.clientY;
  if (!drag.active && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 5) {
    drag.active = true;
    draggingMaterialId.value = drag.materialId;
  }
  if (!drag.active) return;
  event.preventDefault();
  if (materialDragGhost) {
    materialDragGhost.style.transform = `translate3d(${event.clientX + 14}px, ${event.clientY + 14}px, 0)`;
  }
  drag.targetSlotId = updateMaterialPointerTarget(event.clientX, event.clientY);
};
const onMaterialPointerUp = (): void => {
  const drag = materialPointerDrag.value;
  if (!drag) return;
  removeMaterialPointerListeners();
  materialPointerDrag.value = null;
  draggingMaterialId.value = '';
  materialDragGhost?.remove();
  materialDragGhost = null;
  clearMaterialPointerTarget();
  if (!drag.active) return;
  suppressMaterialClick = true;
  window.setTimeout(() => (suppressMaterialClick = false), 0);
  if (drag.targetSlotId) assignDroppedMaterial(drag.materialId, drag.targetSlotId);
};
const beginMaterialPointerDrag = (
  event: PointerEvent,
  material: EffectTemplateMixMaterial,
): void => {
  // Mouse drags use the browser's native drag/drop path below. Keep the
  // pointer implementation for touch/pen input, where HTML5 drag is not
  // consistently available.
  if (event.button !== 0 || event.pointerType === 'mouse' || !selectedVariant.value) return;
  materialPointerDrag.value = {
    materialId: material.id,
    startX: event.clientX,
    startY: event.clientY,
    clientX: event.clientX,
    clientY: event.clientY,
    active: false,
    targetSlotId: '',
  };
  materialDragGhost = document.createElement('div');
  materialDragGhost.className = 'material-drag-ghost';
  materialDragGhost.textContent = `拖入 ${material.code}`;
  materialDragGhost.setAttribute('aria-hidden', 'true');
  document.body.appendChild(materialDragGhost);
  materialDragGhost.style.transform = `translate3d(${event.clientX + 14}px, ${event.clientY + 14}px, 0)`;
  window.addEventListener('pointermove', onMaterialPointerMove, { passive: false });
  window.addEventListener('pointerup', onMaterialPointerUp, { once: true });
  window.addEventListener('pointercancel', onMaterialPointerUp, { once: true });
};
const beginMaterialDrag = (event: DragEvent, material: EffectTemplateMixMaterial): void => {
  if (!selectedVariant.value || !event.dataTransfer) {
    event.preventDefault();
    return;
  }
  draggingMaterialId.value = material.id;
  event.dataTransfer.effectAllowed = 'copy';
  event.dataTransfer.setData('application/x-effect-template-mix-material', material.id);
  event.dataTransfer.setData('text/plain', material.id);
};
const endMaterialDrag = (): void => {
  draggingMaterialId.value = '';
};
const onMaterialCardClick = (material: EffectTemplateMixMaterial): void => {
  if (suppressMaterialClick) return;
  void previewLibraryMaterial(material);
};
// Firefox may still promote an <img> into a native drag ghost. Keep image
// dragging disabled at the workbench boundary while allowing material cards
// to use the native drag/drop path.
const onNativeImageDragStart = (event: DragEvent): void => {
  const target = event.target;
  if (
    (target instanceof HTMLImageElement || (target instanceof Element && target.closest('img'))) &&
    !(target instanceof Element && target.closest('.material-grid article'))
  ) {
    event.preventDefault();
  }
};
const assignDroppedMaterial = (materialId: string, slotId: string): void => {
  const material = workspace.value?.materials.find(({ id }) => id === materialId);
  if (!material) return;
  applyMaterialToSlot(material, slotId);
};
const changeTrimStart = (raw: string): void => {
  const variant = selectedVariant.value;
  const slot = selectedSlot.value;
  const material = selectedMaterial.value;
  if (!variant || !slot || !material) return;
  const value = Math.round(Number(raw) * 1000) / 1000;
  if (!Number.isFinite(value)) return;
  const nextValue = Math.min(Math.max(0, value), Math.max(0, material.duration - slot.duration));
  if (nextValue === (variant.offsets[slot.id] ?? 0)) return;
  rememberTimelineEdit();
  variant.offsets[slot.id] = nextValue;
  variant.bindingMetadata ??= {};
  variant.bindingMetadata[slot.id] = {
    ...(variant.bindingMetadata[slot.id] ?? { source: 'MANUAL' }),
    trimReason: '人工调整截取起点',
  };
  bump();
};
const changeTimelineTrimStart = (slotId: string, raw: number): void => {
  const variant = selectedVariant.value;
  const slot = variant?.slots.find(({ id }) => id === slotId);
  const material = slot ? materialForSlot(slot.id) : null;
  if (!variant || !slot || !material) return;
  const value = Math.round(raw * 1000) / 1000;
  if (!Number.isFinite(value)) return;
  const nextValue = Math.min(Math.max(0, value), Math.max(0, material.duration - slot.duration));
  if (nextValue === (variant.offsets[slot.id] ?? 0)) return;
  rememberTimelineEdit();
  variant.offsets[slot.id] = nextValue;
  variant.bindingMetadata ??= {};
  variant.bindingMetadata[slot.id] = {
    ...(variant.bindingMetadata[slot.id] ?? { source: 'MANUAL' }),
    trimReason: '人工调整截取起点',
  };
  if (activeUi.value) activeUi.value.selectedSlotId = slot.id;
  bump();
};
const resizeTimelineSlot = (
  slotId: string,
  side: 'LEFT' | 'RIGHT',
  rawStart: number,
  rawOffset: number,
  rawDuration: number,
): void => {
  const variant = selectedVariant.value;
  const slot = variant?.slots.find(({ id }) => id === slotId);
  const material = slot ? materialForSlot(slot.id) : null;
  if (!variant || !slot || !material) return;
  const duration = Math.round(Number(rawDuration) * 1000) / 1000;
  const offset = Math.round(Number(rawOffset) * 1000) / 1000;
  const start = Math.round(Number(rawStart) * TIMELINE_FPS) / TIMELINE_FPS;
  if (![duration, offset, start].every(Number.isFinite)) return;
  const slotIndex = variant.slots.findIndex(({ id }) => id === slotId);
  const hasMaterialOnSide = variant.slots.some((candidate, index) => {
    if (candidate.id === slotId || !materialForSlot(candidate.id, variant)) return false;
    return side === 'LEFT' ? index < slotIndex : index > slotIndex;
  });
  if (hasMaterialOnSide) return;
  const nextOffset = Math.min(
    Math.max(0, offset),
    Math.max(0, Math.round((material.duration - 4) * 1000) / 1000),
  );
  if (material.duration < 4) return;
  const minimumDuration = 4;
  const maximumDuration = Math.min(15, Math.max(minimumDuration, material.duration - nextOffset));
  const nextDuration = Math.min(
    Math.max(minimumDuration, duration),
    Math.round(maximumDuration * 1000) / 1000,
  );
  const currentStart =
    variant.timelineStarts?.[slotId] ??
    effectTemplateMixTiming(variant.slots).slots.find(({ id }) => id === slotId)?.start ??
    0;
  const hadExplicitTimelineStarts = Boolean(
    variant.timelineStarts && Object.keys(variant.timelineStarts).length,
  );
  const originalRanges = effectTemplateMixTiming(variant.slots).slots;
  const nextStart = Math.max(0, start);
  if (
    nextDuration === slot.duration &&
    nextOffset === (variant.offsets[slotId] ?? 0) &&
    nextStart === currentStart
  )
    return;
  rememberTimelineEdit();
  slot.duration = nextDuration;
  variant.offsets[slotId] = nextOffset;
  if (!hadExplicitTimelineStarts) {
    variant.timelineStarts = {};
    let cursor = 0;
    for (const [index, currentSlot] of variant.slots.entries()) {
      if (index < slotIndex) {
        cursor = originalRanges[index]?.start ?? cursor;
      } else if (index === slotIndex) {
        cursor = nextStart;
      } else {
        cursor += variant.slots[index - 1]?.duration ?? 0;
      }
      variant.timelineStarts[currentSlot.id] = Math.max(0, cursor);
    }
  } else if (side === 'LEFT' || variant.timelineStarts?.[slotId] !== undefined) {
    variant.timelineStarts ??= {};
    variant.timelineStarts[slotId] = nextStart;
  }
  variant.bindingMetadata ??= {};
  variant.bindingMetadata[slotId] = {
    ...(variant.bindingMetadata[slotId] ?? { source: 'MANUAL' }),
    trimReason: side === 'LEFT' ? '人工调整左边缘时长' : '人工调整右边缘时长',
  };
  if (activeUi.value) activeUi.value.selectedSlotId = slotId;
  resetTimelinePlayerState();
  bump();
};
const changeTemplate = (): void => {
  if (!workspace.value) return;
  for (const [index, slot] of workspace.value.template.slots.entries()) {
    slot.duration = Number.isFinite(Number(slot.duration))
      ? Math.min(15, Math.max(4, Math.round(Number(slot.duration) * 10) / 10))
      : 4;
    if (index === 0) {
      slot.transition = '硬切';
      slot.transitionDuration = 0;
      continue;
    }
    const previous = workspace.value.template.slots[index - 1];
    slot.transitionDuration =
      slot.transition === '硬切' ? 0 : effectTemplateMixTransitionDuration(slot, previous);
  }
  if (selectedVariant.value) {
    markEffectTemplateMixChanged(workspace.value, selectedVariant.value.id);
  } else {
    workspace.value.template.editVersion += 1;
    workspace.value.editVersion += 1;
  }
  scheduleSave();
};
const beginTemplateNameEdit = (): void => {
  templateNameBeforeEdit.value = workspace.value?.template.name ?? '';
};
const changeTemplateName = (): void => {
  if (!workspace.value) return;
  if (activeTemplateNameConflict.value) {
    workspace.value.template.name = templateNameBeforeEdit.value;
    showNotice('当前工作流已有同名模板，请使用其他名称', 'warning');
    return;
  }
  templateNameBeforeEdit.value = workspace.value.template.name;
  changeTemplate();
};
const templateTransitionForRow = (index: number): EffectTemplateMixSlot | null =>
  workspace.value?.template.slots[index + 1] ?? null;
const changeTemplateTransition = (index: number, event: Event): void => {
  const transitionSlot = templateTransitionForRow(index);
  if (!transitionSlot) return;
  const transition = (event.target as HTMLSelectElement).value as EffectTemplateMixTransition;
  if (!EFFECT_TEMPLATE_MIX_TRANSITIONS.includes(transition)) return;
  transitionSlot.transition = transition;
  changeTemplate();
};
const moveTemplateSlot = (id: string, direction: -1 | 1): void => {
  if (!workspace.value) return;
  workspace.value.template.slots = moveEffectTemplateMixSlot(
    workspace.value.template.slots,
    id,
    direction,
  );
  changeTemplate();
};
const moveProjectSlot = (slotId: string, targetId: string): void => {
  if (!selectedVariant.value) return;
  const from = selectedVariant.value.slots.findIndex(({ id }) => id === slotId);
  const to = selectedVariant.value.slots.findIndex(({ id }) => id === targetId);
  if (from < 0 || to < 0 || from === to) return;
  rememberTimelineEdit();
  const [slot] = selectedVariant.value.slots.splice(from, 1);
  selectedVariant.value.slots.splice(to, 0, slot!);
  clearDetachedTransitions(selectedVariant.value);
  bump();
};
const overlapsTimelineClip = (
  start: number,
  duration: number,
  otherStart: number,
  otherEnd: number,
): boolean =>
  start < otherEnd - 1 / TIMELINE_FPS && start + duration > otherStart + 1 / TIMELINE_FPS;
const normalizeVariantVideoLanes = (variant: EffectTemplateMixVariant): void => {
  variant.videoLanes ??= {};
  const used = [
    ...new Set(
      variant.slots
        .filter((slot) => Boolean(materialForSlot(slot.id, variant)))
        .map((slot) => Math.max(0, Math.round(variant.videoLanes?.[slot.id] ?? 0))),
    ),
  ].sort((left, right) => left - right);
  const laneMap = new Map(used.map((lane, index) => [lane, index]));
  for (const slot of variant.slots) {
    if (!materialForSlot(slot.id, variant)) {
      delete variant.videoLanes[slot.id];
      continue;
    }
    const rawLane = Math.max(0, Math.round(variant.videoLanes[slot.id] ?? 0));
    variant.videoLanes[slot.id] = laneMap.get(rawLane) ?? 0;
  }
};
const clearDetachedTransitions = (variant: EffectTemplateMixVariant): boolean => {
  const baseRanges = effectTemplateMixTiming(variant.slots).slots;
  const ranges = baseRanges.map((range) => {
    const start = Math.max(0, variant.timelineStarts?.[range.id] ?? range.start);
    return { ...range, start, end: start + (range.end - range.start) };
  });
  const laneFor = (slotId: string): number =>
    Math.max(0, Math.round(variant.videoLanes?.[slotId] ?? 0));
  let changed = false;
  for (let index = 1; index < variant.slots.length; index += 1) {
    const slot = variant.slots[index]!;
    if (slot.transition === '硬切') continue;
    const previousSlot = variant.slots[index - 1]!;
    const currentRange = ranges[index];
    const previousRange = ranges[index - 1];
    const remainsAttached =
      Boolean(materialForSlot(slot.id, variant)) &&
      Boolean(materialForSlot(previousSlot.id, variant)) &&
      laneFor(slot.id) === laneFor(previousSlot.id) &&
      Math.abs(currentRange!.start - previousRange!.end) <= 1 / TIMELINE_FPS;
    if (!remainsAttached) {
      slot.transition = '硬切';
      slot.transitionDuration = 0;
      changed = true;
    }
  }
  return changed;
};
type TimelinePlacement = { insertLaneAt?: number; lane: number; start: number };
const resolveTimelinePlacement = (
  variant: EffectTemplateMixVariant,
  slotId: string,
  requestedStart: number,
  requestedLane: number,
  excludedSlotIds: ReadonlySet<string> = new Set(),
  forceInsertLane = false,
): TimelinePlacement => {
  const slot = variant.slots.find(({ id }) => id === slotId);
  if (!slot) return { start: requestedStart, lane: requestedLane };
  if (requestedLane < 0) {
    return { insertLaneAt: 0, start: requestedStart, lane: 0 };
  }
  if (forceInsertLane) {
    return { insertLaneAt: requestedLane, start: requestedStart, lane: requestedLane };
  }
  const ranges = currentTiming.value.slots
    .filter(
      ({ id }) =>
        id !== slotId && !excludedSlotIds.has(id) && Boolean(materialForSlot(id, variant)),
    )
    .map((range) => ({
      ...range,
      lane: variant.videoLanes?.[range.id] ?? 0,
    }));
  const requestedDuration = Math.max(4, Math.min(15, slot.duration));
  const isBlocked = (start: number, lane: number): boolean =>
    ranges.some(
      (range) =>
        range.lane === lane &&
        overlapsTimelineClip(start, requestedDuration, range.start, range.end),
    );
  if (!isBlocked(requestedStart, requestedLane)) {
    return { start: requestedStart, lane: requestedLane };
  }

  // If the user drops onto an occupied clip, prefer an empty lane above it.
  for (let lane = requestedLane - 1; lane >= 0; lane -= 1) {
    if (!isBlocked(requestedStart, lane)) return { start: requestedStart, lane };
  }

  // There is no free lane above the requested one. Insert a new lane at the
  // requested position and shift the existing clips down instead of covering.
  return { insertLaneAt: requestedLane, start: requestedStart, lane: requestedLane };
};
type TimelineClipMove = {
  slotId: string;
  start: number;
  lane: number;
  insertLane?: number | undefined;
};

const moveTimelineClips = (moves: TimelineClipMove[]): void => {
  const variant = selectedVariant.value;
  if (!variant || !moves.length) return;
  normalizeVariantVideoLanes(variant);
  const excludedSlotIds = new Set(moves.map(({ slotId }) => slotId));
  let insertLaneAt: number | null = null;
  const resolvedMoves = moves.flatMap(({ slotId, start, lane, insertLane }) => {
    const slot = variant.slots.find(({ id }) => id === slotId);
    if (!slot) return [];
    const nextStart = Math.max(0, Math.round(start * 30) / 30);
    const nextLane = Math.round(lane);
    const currentLane = Math.max(0, Math.round(variant.videoLanes?.[slotId] ?? 0));
    // A border drop asks for a row of its own rather than a row to sit in, so it never looks for a
    // free one — the rows it lands between move down instead.
    const resolved = resolveTimelinePlacement(
      variant,
      slotId,
      nextStart,
      insertLane ?? nextLane,
      excludedSlotIds,
      insertLane !== undefined || nextLane < currentLane,
    );
    const currentStart =
      variant.timelineStarts?.[slotId] ??
      effectTemplateMixTiming(variant.slots).slots.find(({ id }) => id === slotId)?.start ??
      0;
    const resolvedStart = Math.max(0, Math.round(resolved.start * 30) / 30);
    if (resolved.insertLaneAt !== undefined) {
      insertLaneAt =
        insertLaneAt === null
          ? resolved.insertLaneAt
          : Math.min(insertLaneAt, resolved.insertLaneAt);
    }
    const resolvedLane = Math.max(0, Math.round(resolved.lane));
    const shouldApplyMove =
      resolved.insertLaneAt !== undefined ||
      resolvedStart !== currentStart ||
      resolvedLane !== currentLane;
    return shouldApplyMove ? [{ slotId, start: resolvedStart, lane: resolvedLane }] : [];
  });
  if (!resolvedMoves.length) return;
  rememberTimelineEdit();
  variant.timelineStarts ??= {};
  variant.videoLanes ??= {};
  if (insertLaneAt !== null) {
    for (const candidate of variant.slots) {
      if (excludedSlotIds.has(candidate.id) || !materialForSlot(candidate.id, variant)) continue;
      const lane = Math.max(0, Math.round(variant.videoLanes[candidate.id] ?? 0));
      if (lane >= insertLaneAt) variant.videoLanes[candidate.id] = lane + 1;
    }
  }
  for (const move of resolvedMoves) {
    variant.timelineStarts[move.slotId] = move.start;
    variant.videoLanes[move.slotId] = move.lane;
  }
  normalizeVariantVideoLanes(variant);
  clearDetachedTransitions(variant);
  resetTimelinePlayerState();
  bump();
};
const moveTimelineClip = (
  slotId: string,
  start: number,
  lane: number,
  insertLane?: number,
): void => moveTimelineClips([{ slotId, start, lane, insertLane }]);

/** A dropped clip keeps a role so the timeline still labels it; the template's six roles are hints. */
const EFFECT_TEMPLATE_MIX_PURPOSE_ROLES: Record<EffectTemplateMixPurpose, EffectTemplateMixRole> = {
  HOOK: 'HOOK',
  EFFECT: 'SELLING_POINT',
  PRODUCT_DISPLAY: 'PRODUCT',
  END_CONVERSION: 'END',
};
/**
 * Adds a library material as an overlay clip on a new track. The clip is a variant slot appended
 * after the template's own, so the timeline, packaging and renderer all already know what to do with
 * it — the template itself never sees it. It is marked `overlay`, which keeps it out of the narration
 * pipeline: it covers the picture underneath instead of being spoken over it.
 *
 * Nothing else on the timeline moves. The clip lands exactly where it was dropped and may overlap its
 * neighbours, because covering them is the point. The existing clips are left untouched, starts and
 * all: the new slot is appended after them, so the packaging cursor fallback can only ever lay out
 * clips behind it, and nothing already placed is pushed along.
 */
const insertMaterialTrack = (materialId: string, lane: number, start: number): void => {
  const variant = selectedVariant.value;
  const material = workspace.value?.materials.find(({ id }) => id === materialId);
  if (!variant || !material) return;
  if (!material.available) {
    showNotice('素材已失效，无法新增轨道', 'warning');
    return;
  }
  if (material.duration < 4) {
    showNotice('素材不足 4 秒，无法新增轨道', 'warning');
    return;
  }
  if (Object.values(variant.bindings).includes(material.id)) {
    showNotice(`${material.code} 已用于当前成片，同一成片不能重复使用`, 'warning');
    return;
  }
  if (!material.promptText) {
    showNotice('素材缺少已确认原始 Prompt，无法成片', 'warning');
    return;
  }
  rememberTimelineEdit();
  // Only the new clip gets an explicit start. Writing starts for the clips already there would restate
  // the visual hash the packaging was confirmed against, and it is not needed: the cursor fallback
  // lays a start-less slot out after its predecessor, and this one is appended last.
  variant.timelineStarts ??= {};
  const insertAt = Math.max(0, start);
  const duration = Math.min(
    Math.min(15, Math.max(4, Math.round(material.duration * 10) / 10)),
    Math.floor(material.duration * 10) / 10,
  );
  const slot: EffectTemplateMixSlot = {
    id: crypto.randomUUID(),
    role: EFFECT_TEMPLATE_MIX_PURPOSE_ROLES[material.purpose] ?? 'PRODUCT',
    purpose: material.purpose,
    label: material.code,
    duration,
    transition: '硬切',
    transitionDuration: 0,
    overlay: true,
  };
  const insertLane = Math.max(0, Math.round(lane));
  variant.videoLanes ??= {};
  for (const candidate of variant.slots) {
    if (!materialForSlot(candidate.id, variant)) continue;
    const current = Math.max(0, Math.round(variant.videoLanes[candidate.id] ?? 0));
    if (current >= insertLane) variant.videoLanes[candidate.id] = current + 1;
  }
  variant.slots.push(slot);
  variant.timelineStarts[slot.id] = insertAt;
  variant.videoLanes[slot.id] = insertLane;
  variant.bindings[slot.id] = material.id;
  variant.bindingRevisions[slot.id] = material.artifactRevision;
  variant.offsets[slot.id] = 0;
  variant.bindingMetadata ??= {};
  variant.bindingMetadata[slot.id] = {
    source: 'MANUAL',
    classificationReason: '拖入新轨道',
  };
  variant.manualSlotIds.push(slot.id);
  normalizeVariantVideoLanes(variant);
  clearDetachedTransitions(variant);
  if (activeUi.value) activeUi.value.selectedSlotId = slot.id;
  resetTimelinePlayerState();
  bump();
  showNotice(`${material.code} 已作为叠加画面放入新轨道`);
  const compactedLane = variant.videoLanes[slot.id] ?? insertLane;
  void nextTick().then(() => timelineRef.value?.scrollToLane(compactedLane, insertAt, duration));
};

/**
 * Compact the stored rows down to 0..n-1, so a row number means the same thing to the timeline —
 * which draws rows compacted — as it does to the placement below, which reads lanes raw. Only the
 * selected project has a packaging checkpoint to list its clips with, so only it is compacted;
 * `compactAudioLanes` leaves the rows of clips it cannot see alone.
 */
const normalizeVariantAudioLanes = (variant: EffectTemplateMixVariant): void => {
  variant.audioLanes ??= {};
  compactAudioLanes(
    variant.audioLanes,
    timelineAudioClipRefs(
      variant,
      selectedPackaging.value,
      workspace.value?.materials ?? [],
      props.projectId,
    ),
  );
};
/** Start and length of every visible audio clip, keyed by the id the shared module produced. */
const audioClipPlacements = (
  variant: EffectTemplateMixVariant,
): Array<{ clipId: string; duration: number; start: number }> => {
  const checkpoint = selectedPackaging.value?.checkpoint;
  return timelineAudioClipRefs(
    variant,
    selectedPackaging.value,
    workspace.value?.materials ?? [],
    props.projectId,
  ).flatMap((ref) => {
    if (ref.source === 'PACKAGED') {
      // The clip id already carries its own namespace, so the same resolver the edit rows use is
      // what decides which checkpoint collection a placement reads from.
      const target = packagingAudioTarget(ref.id);
      const audio = target && checkpoint ? packagingAudio(checkpoint, target) : undefined;
      return audio ? [{ clipId: ref.id, duration: audio.duration, start: audio.start }] : [];
    }
    if (ref.source === 'LEGACY') {
      const audio = ref.kind === 'MUSIC' ? variant.bgm : variant.voice;
      return audio ? [{ clipId: ref.id, duration: audio.duration, start: audio.start }] : [];
    }
    const audio = variant.detachedAudios?.find((row) => `detached:${row.id}` === ref.id);
    return audio ? [{ clipId: ref.id, duration: audio.duration, start: audio.start }] : [];
  });
};
type AudioRowPlacement = { insertRowAt?: number; row: number };
/** The audio counterpart of `resolveTimelinePlacement`: same rules, on rows instead of lanes. */
const resolveAudioPlacement = (
  rows: Array<{ clipId: string; duration: number; lane: number; start: number }>,
  requestedStart: number,
  requestedDuration: number,
  requestedRow: number,
  excludedClipIds: ReadonlySet<string>,
): AudioRowPlacement => {
  if (requestedRow < 0) return { insertRowAt: 0, row: 0 };
  const others = rows.filter(({ clipId }) => !excludedClipIds.has(clipId));
  const isBlocked = (row: number): boolean =>
    others.some(
      (other) =>
        other.lane === row &&
        overlapsTimelineClip(
          requestedStart,
          requestedDuration,
          other.start,
          other.start + other.duration,
        ),
    );
  if (!isBlocked(requestedRow)) return { row: requestedRow };
  // If the user drops onto an occupied clip, prefer an empty row above it.
  for (let row = requestedRow - 1; row >= 0; row -= 1) if (!isBlocked(row)) return { row };
  // There is no free row above, so a new row opens where it was asked for and the clips already
  // there move down rather than being covered.
  return { insertRowAt: requestedRow, row: requestedRow };
};
type TimelineAudioMove = {
  clipId: string;
  row?: number;
  start: number;
  /** Set when the clip was let go on a row border: open that row and put the clip on it. */
  insertRow?: number;
};
/**
 * Move audio clips horizontally, vertically, or both. The row lives on the project draft while a
 * packaged clip's time lives on the server-owned checkpoint, so one gesture writes to two places.
 */
const movePackagingAudios = (moves: TimelineAudioMove[]): void => {
  const variant = selectedVariant.value;
  if (!variant || !moves.length) return;
  normalizeVariantAudioLanes(variant);
  const placements = audioClipPlacements(variant);
  const laneOf = (clipId: string): number =>
    Math.max(0, Math.round(variant.audioLanes?.[clipId] ?? 0));
  const excludedClipIds = new Set(moves.map(({ clipId }) => clipId));
  const rows = placements.map((placement) => ({ ...placement, lane: laneOf(placement.clipId) }));
  const durationOf = (clipId: string): number =>
    placements.find((placement) => placement.clipId === clipId)?.duration ?? 0;
  let insertRowAt: number | null = null;
  const rowMoves = moves.flatMap(({ clipId, row, insertRow, start }) => {
    if (row === undefined) return [];
    const requestedRow = Math.max(0, Math.round(row));
    const requestedStart = Math.max(0, Math.round(start * 30) / 30);
    // Let go on a row border: the row opens exactly there. The "prefer an empty row above" rule is
    // skipped on purpose — the border is the answer the user gave, not a hint to be improved on.
    const resolved =
      insertRow === undefined
        ? resolveAudioPlacement(
            rows,
            requestedStart,
            durationOf(clipId),
            requestedRow,
            excludedClipIds,
          )
        : { insertRowAt: requestedRow, row: requestedRow };
    if (resolved.insertRowAt !== undefined) {
      insertRowAt =
        insertRowAt === null ? resolved.insertRowAt : Math.min(insertRowAt, resolved.insertRowAt);
    }
    const resolvedRow = Math.max(0, Math.round(resolved.row));
    return resolvedRow === laneOf(clipId) ? [] : [{ clipId, row: resolvedRow }];
  });
  const shouldApplyMove =
    rowMoves.length > 0 ||
    // A clip let go on its own row's border asks for a row to be opened even though neither its row
    // nor its time changes, so the border alone is enough to make the gesture do something.
    moves.some(({ insertRow }) => insertRow !== undefined) ||
    moves.some(({ clipId, start }) => {
      // Captions are not audio placements — they live on their own rows in the checkpoint — so
      // their current time has to be read separately or a caption drag would be dropped here.
      const placement = placements.find((entry) => entry.clipId === clipId);
      const current = placement?.start ?? captionStartOf(clipId);
      return current !== undefined && Math.round(start * 30) / 30 !== Math.round(current * 30) / 30;
    });
  if (!shouldApplyMove) return;
  rememberTimelineEdit();
  variant.audioLanes ??= {};
  if (insertRowAt !== null) {
    for (const placement of placements) {
      if (excludedClipIds.has(placement.clipId)) continue;
      const lane = laneOf(placement.clipId);
      if (lane >= insertRowAt) variant.audioLanes[placement.clipId] = lane + 1;
    }
  }
  for (const move of rowMoves) variant.audioLanes[move.clipId] = move.row;
  for (const { clipId, start } of moves) applyAudioStart(clipId, Math.max(0, start));
  normalizeVariantAudioLanes(variant);
  resetTimelinePlayerState();
  bump();
};
const movePackagingAudio = (
  clipId: string,
  start: number,
  row?: number,
  insertRow?: number,
): void =>
  movePackagingAudios([
    row === undefined
      ? { clipId, start }
      : { clipId, row, start, ...(insertRow === undefined ? {} : { insertRow }) },
  ]);
/**
 * Put a subtitle on a row and leave it where it was let go. Caption rows are derived from the
 * caption's own track rather than stored, so "which row" *is* "which `trackId`" — the lane it lands
 * on follows from that, and no row number has to be written. A `null` track is the implicit row the
 * pipeline lays out edge to edge, so clearing the field is how a card comes back down to it.
 */
const writeCaptionRow = (captionId: string, start: number, trackId: string | null): void => {
  const packaging = selectedPackaging.value;
  const variant = selectedVariant.value;
  if (projectEditLocked.value) return;
  // Whichever source the workbench is editing owns the caption; the timeline draws the checkpoint's
  // copy when a completed packaging is selected, so the row has to be changed on that same object.
  const caption =
    packaging?.checkpoint.captions?.find((item) => item.id === captionId) ??
    variant?.captions.find((item) => item.id === captionId);
  if (!caption) return;
  rememberTimelineEdit();
  const next = quantizeTimelineTime(start);
  // A subtitle carries its own length, so it keeps it: only the row and the time were asked for.
  const length = Math.max(1 / TIMELINE_FPS, caption.end - caption.start);
  if (packaging) {
    // Written through the packaging editor rather than onto the object the lookup returned, because
    // that is what captures the checkpoint baseline the save is later diffed against.
    editPackagingAudio((checkpoint) => {
      const target = checkpoint.captions?.find((item) => item.id === captionId);
      if (!target) return;
      if (trackId === null) delete target.trackId;
      else target.trackId = trackId;
      target.start = next;
      target.end = next + length;
    });
  } else {
    if (trackId === null) delete caption.trackId;
    else caption.trackId = trackId;
    caption.start = next;
    caption.end = next + length;
    bump();
  }
  void nextTick().then(() => timelineRef.value?.scrollToCaption(captionId, next, length));
};

/**
 * Give a subtitle a row of its own, by moving it onto a brand new track and leaving it where it was
 * let go. This is the answer to a landing no existing row can take.
 */
const splitCaptionTrack = (captionId: string, start: number): void => {
  const trackId = `subtitle-track-${Date.now().toString().padStart(13, '0')}-${crypto.randomUUID()}`;
  writeCaptionRow(captionId, start, trackId);
};

/**
 * Move a subtitle onto a row the timeline named. The row arrives as the same key the packer groups
 * captions by, so the implicit row is a clear and another card's row is that card's track. A manual
 * card's row key carries that card's own id, so it can never be joined and falls back to a new track.
 */
const moveCaptionToRow = (captionId: string, start: number, rowKey: string): void => {
  if (rowKey === 'legacy-generated') return writeCaptionRow(captionId, start, null);
  if (rowKey.startsWith('track:'))
    return writeCaptionRow(captionId, start, rowKey.slice('track:'.length));
  splitCaptionTrack(captionId, start);
};
/**
 * A library track let go on top of a separated audio clip takes its place. The clip keeps its own
 * start and length — the replacement is asked to fit the hole, not the other way round — so a track
 * shorter than the clip it would cover is refused rather than silently stretched or shortened.
 *
 * Only a separated clip can be replaced this way: every other audio row is server-owned (a narration
 * line is bound to its script line, a packaged track to the confirmed checkpoint), and swapping those
 * from the draft would leave the checkpoint describing audio that is no longer there.
 */
const replaceAudioWithMusic = (
  clipId: string,
  music: { assetId: string; fileObjectId: string; name: string; duration: number },
): void => {
  const variant = selectedVariant.value;
  // Same rule as adding a track: the arrangement survives a packaging, so only a template that is
  // frozen or mid-run refuses the swap.
  if (projectEditLocked.value) return;
  const audio = variant?.detachedAudios?.find(({ id }) => `detached:${id}` === clipId);
  if (!variant || !audio) {
    showNotice('只有分离出来的原声轨道可以这样替换', 'warning');
    return;
  }
  if (music.duration < audio.duration) {
    showNotice(`${music.name} 短于被覆盖的片段，无法替换`, 'warning');
    return;
  }
  rememberTimelineEdit();
  audio.fileObjectId = music.fileObjectId;
  audio.name = music.name;
  audio.sourceAssetId = music.assetId;
  audio.sourceDuration = music.duration;
  // The covered clip's window is what is kept, so the new track starts from its own head.
  audio.offset = 0;
  bump();
  showNotice(`${music.name} 已替换该片段`);
};
/**
 * Land a caption narration the editor just generated. `movePackagingAudios` cannot do this: the
 * clip already sits at its caption's start on the default row, so `shouldApplyMove` would see
 * nothing changed and drop the row insert — which here is the whole point.
 */
const placeGeneratedCaptionVoice = (clipId: string, start: number): void => {
  const variant = selectedVariant.value;
  if (!variant) return;
  normalizeVariantAudioLanes(variant);
  const placements = audioClipPlacements(variant);
  const duration = placements.find((placement) => placement.clipId === clipId)?.duration ?? 0;
  const laneOf = (id: string): number => Math.max(0, Math.round(variant.audioLanes?.[id] ?? 0));
  const resolved = resolveAudioPlacement(
    placements.map((placement) => ({ ...placement, lane: laneOf(placement.clipId) })),
    Math.max(0, start),
    duration,
    DEFAULT_AUDIO_LANE.VOICE,
    new Set([clipId]),
  );
  rememberTimelineEdit();
  variant.audioLanes ??= {};
  if (resolved.insertRowAt !== undefined) {
    // The row the clip asked for is taken, so everything from there down moves instead of being
    // covered — the same rule a manual drop onto an occupied row follows.
    for (const placement of placements) {
      if (placement.clipId === clipId) continue;
      if (laneOf(placement.clipId) >= resolved.insertRowAt) {
        variant.audioLanes[placement.clipId] = laneOf(placement.clipId) + 1;
      }
    }
  }
  variant.audioLanes[clipId] = Math.max(0, Math.round(resolved.row));
  normalizeVariantAudioLanes(variant);
  resetTimelinePlayerState();
  bump();
};
const changeProjectDuration = (raw: string): void => {
  if (!selectedSlot.value || !selectedVariant.value) return;
  const duration = Math.round(Number(raw) * 10) / 10;
  const material = materialForSlot(selectedSlot.value.id);
  if (!Number.isFinite(duration) || duration < 4 || duration > 15) {
    showNotice('槽位时长必须为 4–15 秒', 'warning');
    return;
  }
  if (
    material &&
    duration + (selectedVariant.value.offsets[selectedSlot.value.id] ?? 0) > material.duration
  ) {
    showNotice('槽位时长不能超过素材可用时长', 'warning');
    return;
  }
  if (selectedSlot.value.duration === duration) return;
  rememberTimelineEdit();
  selectedSlot.value.duration = duration;
  resetTimelinePlayerState();
  bump();
};
const changeTransitionForSlot = (slotId: string, transition: EffectTemplateMixTransition): void => {
  const variant = selectedVariant.value;
  const slot = variant?.slots.find(({ id }) => id === slotId);
  if (!variant || !slot) return;
  const index = variant.slots.findIndex(({ id }) => id === slot.id);
  if (slot.transition === transition) return;
  rememberTimelineEdit();
  slot.transition = transition;
  slot.transitionDuration =
    transition === '硬切' ? 0 : effectTemplateMixTransitionDuration(slot, variant.slots[index - 1]);
  resetTimelinePlayerState();
  bump();
};
const changeTransition = (transition: EffectTemplateMixTransition): void => {
  if (!selectedSlot.value) return;
  changeTransitionForSlot(selectedSlot.value.id, transition);
};
const removeTransitionFromSlot = (slotId: string): void => {
  const variant = selectedVariant.value;
  const slot = variant?.slots.find(({ id }) => id === slotId);
  if (!variant || !slot) return;
  const index = variant.slots.findIndex(({ id }) => id === slot.id);
  if (index <= 0 || slot.transition === '硬切') return;
  rememberTimelineEdit();
  slot.transition = '硬切';
  slot.transitionDuration = 0;
  activeTransitionSlotId.value = '';
  resetTimelinePlayerState();
  bump();
};
/**
 * Remove the selected audio clips. Every kind the editor owns can go: a separated source track, a
 * caption narration, the packaged music bed, and a script-line narration — a narration is only an
 * optional overlay on its line, so dropping it leaves the line, its subtitle and the film's length
 * alone. Only an id the checkpoint does not know (a legacy whole-film voice) is refused out loud —
 * silently doing nothing is what made the shortcut look broken in the first place.
 */
const deleteSelectedAudioClips = (clipIds: string[]): void => {
  const variant = selectedVariant.value;
  if (!variant) return;
  const detachedIds = new Set<string>();
  const captionVoiceIds = new Set<string>();
  const voiceIds = new Set<string>();
  let musicSelected = false;
  for (const clipId of clipIds) {
    if (clipId.startsWith('detached:')) detachedIds.add(clipId.slice('detached:'.length));
    else if (clipId.startsWith('capvoice:')) captionVoiceIds.add(clipId.slice('capvoice:'.length));
    else if (clipId.startsWith('voice:')) voiceIds.add(clipId.slice('voice:'.length));
    else if (clipId === 'music') musicSelected = true;
  }
  const checkpoint = selectedPackaging.value?.checkpoint;
  const removesDetached =
    detachedIds.size > 0 && (variant.detachedAudios?.some((audio) => detachedIds.has(audio.id)) ?? false);
  const removesCaptionVoice =
    captionVoiceIds.size > 0 &&
    [...captionVoiceIds].some((id) => Boolean(checkpoint?.captionVoices?.[id]));
  const removesVoice =
    voiceIds.size > 0 && [...voiceIds].some((id) => Boolean(checkpoint?.voices?.[id]));
  const removesMusic = musicSelected && Boolean(checkpoint?.music);
  if (removesDetached) {
    rememberTimelineEdit();
    variant.detachedAudios = (variant.detachedAudios ?? []).filter(
      (audio) => !detachedIds.has(audio.id),
    );
  }
  if (removesVoice || removesCaptionVoice || removesMusic) {
    editPackagingAudio((next) => {
      // Captured before the clips are removed, so undo brings the selection back.
      rememberTimelineEdit();
      if (removesMusic) delete next.music;
      if (removesVoice) for (const id of voiceIds) delete next.voices?.[id];
      if (removesCaptionVoice) for (const id of captionVoiceIds) delete next.captionVoices?.[id];
    });
  }
  if (!removesDetached && !removesVoice && !removesCaptionVoice && !removesMusic) {
    showNotice('该音频片段不能删除', 'warning');
    return;
  }
  selectedAudioClipIds.value = [];
  if (removesDetached) bump();
};
const deleteSelectedTimelineItem = (): void => {
  const selectedCaptions = [...selectedCaptionIds.value];
  if (selectedCaptions.length) {
    if (selectedPackaging.value) {
      // Only an unfinished packaging is read-only; staleness is an informational source marker.
      if (!captionEditable.value) {
        showNotice('当前包装尚未完成，字幕不可编辑', 'warning');
        return;
      }
      editPackagingAudio((checkpoint) => {
        // Captured before the captions are removed, so undo brings the selection back.
        rememberTimelineEdit();
        checkpoint.captions = (checkpoint.captions ?? []).filter(
          (caption) => !selectedCaptions.includes(caption.id),
        );
      });
    } else {
      const variant = selectedVariant.value;
      if (!variant || projectEditLocked.value) return;
      rememberTimelineEdit();
      variant.captions = variant.captions.filter(
        (caption) => !selectedCaptions.includes(caption.id),
      );
      bump();
    }
    selectedCaptionIds.value = [];
    timelineRef.value?.clearSelection();
    return;
  }
  const variant = selectedVariant.value;
  if (!variant) return;
  // An audio clip on screen is what Delete is about. This is checked before the video slot rather
  // than after: falling through used to make a selected narration delete an unrelated slot instead,
  // which is why the shortcut looked like it did nothing at all.
  if (selectedAudioClipIds.value.length) {
    deleteSelectedAudioClips([...selectedAudioClipIds.value]);
    return;
  }
  const transitionSlotId = activeTransitionSlotId.value;
  const transitionSlot = variant.slots.find(({ id }) => id === transitionSlotId);
  if (transitionSlot && transitionSlot.transition !== '硬切') {
    removeTransitionFromSlot(transitionSlotId);
    return;
  }
  const slotId = activeUi.value?.selectedSlotId ?? '';
  const slot = variant.slots.find(({ id }) => id === slotId);
  if (slot && variant.bindings[slot.id]) removeMaterialFromSlot(slot.id);
};
const previewTransitionDuration = (slotId: string, duration: number): void => {
  transitionPreviewDurations[slotId] = duration;
};
const changeTransitionDuration = (slotId: string, raw: string | number): void => {
  delete transitionPreviewDurations[slotId];
  const variant = selectedVariant.value;
  const index = variant?.slots.findIndex(({ id }) => id === slotId) ?? -1;
  const slot = index >= 0 ? variant?.slots[index] : undefined;
  const previous = index > 0 ? variant?.slots[index - 1] : undefined;
  if (!variant || !slot || !previous || slot.transition === '硬切') return;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return;
  const max = Math.min(5, slot.duration, previous.duration);
  const nextValue = Math.max(0.1, Math.min(max, Math.round(parsed * 10) / 10));
  const currentValue = effectTemplateMixTransitionDuration(slot, previous);
  if (nextValue === currentValue && slot.transitionDuration === nextValue) return;
  rememberTimelineEdit();
  slot.transitionDuration = nextValue;
  bump();
};
const openTransitionPanel = (slotId: string): void => {
  selectSlot(slotId);
  activeTransitionSlotId.value = slotId;
  transitionKeyword.value = '';
  resourceTab.value = 'TRANSITION';
};
const selectResourceTab = (tab: 'VOICE' | 'MUSIC' | 'MATERIAL' | 'TEXT' | 'TRANSITION'): void => {
  resourceTab.value = tab;
  if (tab !== 'TRANSITION') {
    activeTransitionSlotId.value = '';
    clearTransitionPreviews();
  }
};
const beginTransitionDrag = (event: DragEvent, transition: EffectTemplateMixTransition): void => {
  if (!event.dataTransfer) return;
  event.dataTransfer.effectAllowed = 'copy';
  event.dataTransfer.setData('application/x-effect-transition', transition);
  event.dataTransfer.setData('text/plain', transition);
};
const createEmptyVariant = async (): Promise<void> => {
  if (!workspace.value || mutating.value || activeAiRun.value) return;
  if (!(await flushPendingEdits()) || draftRevision.value === null) return;
  const templateId = activeTemplateId.value;
  const previousIds = new Set(workspace.value.variants.map(({ id }) => id));
  mutating.value = true;
  try {
    const response = await createEmptyEffectTemplateMixVariant(
      props.projectId,
      props.workflowRunId,
      draftRevision.value,
      templateId,
    );
    installWorkspaceData(response.data);
    activeTemplateId.value = templateId;
    const entry = catalog.value.find(({ id }) => id === templateId);
    const created = entry?.workspace.variants.find(({ id }) => !previousIds.has(id));
    const ui = uiByTemplate[templateId];
    if (created && ui) {
      ui.selectedVariantId = created.id;
      ui.selectedSlotId = created.slots[0]?.id ?? '';
    }
    saveState.value = 'saved';
    showNotice('已新建空成片，可从左侧素材库拖入画面');
  } catch (error) {
    showNotice(error instanceof Error ? error.message : '新建成片失败', 'error');
  } finally {
    mutating.value = false;
  }
};
const openPackaging = (target: 'ACTION' | 'WORKFLOW'): void => {
  if (target === 'ACTION' && packagingActionBlockReason.value) {
    showNotice(packagingActionBlockReason.value, 'error');
    return;
  }
  void packagingPanel.value?.open(target);
};
const onStalePackagingVariants = (variantIds: string[]): void => {
  stalePackagingVariantIds.value = new Set(variantIds);
};
const handlePackagingStarted = async (): Promise<void> => {
  await load();
  if (activeEntry.value) activeEntry.value.packagingLocked = true;
};
const preparePackaging = async (): Promise<number | null> => {
  if (selectedVariantRefreshSlotIds.value.length) {
    showNotice('请先更新已替换素材的截取区间并完成混剪校验', 'error');
    return null;
  }
  return (await flushPendingEdits()) ? draftRevision.value : null;
};
const startAiFill = async (
  target: EffectTemplateMixVariant | null,
  refreshAffectedSlots = false,
): Promise<void> => {
  if (packagingLocked.value && !refreshAffectedSlots) {
    showNotice('智能成片包装已启动或完成，此模板不能重新智能填充', 'error');
    return;
  }
  if (!workspace.value || mutating.value || activeAiRun.value) return;
  // Retry and other entry points bypass the disabled button, so the reason is checked here too —
  // sending the request would only come back as the generic "剩余未使用素材不足".
  if (!refreshAffectedSlots && aiFillBlockReason.value) {
    showNotice(aiFillBlockReason.value, 'warning');
    return;
  }
  if (!(await flushPendingEdits()) || draftRevision.value === null) return;
  const templateId = activeTemplateId.value;
  const variantId = target?.id;
  mutating.value = true;
  fillStartPending.value = true;
  try {
    const result = await createEffectTemplateMixAiRun(
      props.projectId,
      props.workflowRunId,
      draftRevision.value,
      templateId,
      variantId,
      refreshAffectedSlots,
    );
    const workspaceResponse = await loadEffectTemplateMixWorkspace(
      props.projectId,
      props.workflowRunId,
    );
    installWorkspaceData(workspaceResponse.data);
    activeTemplateId.value = templateId;
    aiRuns.value = [result.data, ...aiRuns.value.filter(({ id }) => id !== result.data.id)];
    showNotice(
      refreshAffectedSlots
        ? '正在为已更新素材位重新分析截取起点；槽位归属、其他素材和剪辑位置保持不变'
        : target?.manualSlotIds.length
          ? '智能填充已开始，人工槽位会保留，其余槽位重新计算'
          : target
            ? '重新智能填充已开始；可用的原素材归属尽量保留，已过期素材会重新匹配'
            : '智能填充已开始；完成前不会创建成片工程',
    );
    void pollAiRun(result.data.id);
  } catch (error) {
    await load();
    showNotice(error instanceof Error ? error.message : '重新填充失败', 'error');
  } finally {
    fillStartPending.value = false;
    mutating.value = false;
  }
};
const refill = (): void => void startAiFill(selectedVariant.value);
const refreshAffectedClips = (): void => {
  if (selectedVariantRefreshSlotIds.value.length) void startAiFill(selectedVariant.value, true);
};
const retryFailedAiRun = (): void => {
  const run = failedAiRun.value;
  if (run?.targetVariantId && activeUi.value) {
    activeUi.value.selectedVariantId = run.targetVariantId;
    void startAiFill(selectedVariant.value, run.operation === 'REFRESH_TRIMS');
    return;
  }
  void startAiFill(null);
};
const addCaption = (): void => {
  const packaging = selectedPackaging.value;
  const variant = selectedVariant.value;
  // A completed packaging checkpoint is itself an editable caption source. It can remain
  // selected while the timeline workspace is still loading (or when no variant is selected),
  // so do not silently require a variant before taking the packaging-edit path below.
  if (!variant && !packaging) {
    showNotice('请先打开一条成片，再新增字幕', 'warning');
    return;
  }
  if (!canAddCaption.value) {
    showNotice('当前包装正在运行，暂时不能新增字幕', 'warning');
    return;
  }
  const start = quantizeTimelineTime(playhead.value);
  const end = quantizeTimelineTime(Math.min(currentDuration.value, start + 3));
  if (end - start < 1 / TIMELINE_FPS) {
    showNotice('播放头已到成片末尾，请先移动播放头再新增字幕', 'warning');
    return;
  }
  const caption = {
    id: crypto.randomUUID(),
    manual: true,
    trackId: `subtitle-track-${Date.now().toString().padStart(13, '0')}-${crypto.randomUUID()}`,
    text: '',
    start,
    end,
  };
  selectedCaptionIds.value = [caption.id];
  selectedAudioClipIds.value = [];
  // Captured before the caption lands in either source, so undo removes the one just added.
  rememberTimelineEdit();
  if (packaging) {
    editPackagingAudio((checkpoint) => {
      checkpoint.captions ??= [];
      checkpoint.captions.push(caption);
    });
    return;
  }
  if (!variant) return;
  variant.captions.push(caption);
  bump();
};
const quantizeTimelineTime = (raw: number): number =>
  Math.round(Math.max(0, Math.min(currentDuration.value, raw)) * TIMELINE_FPS) / TIMELINE_FPS;
const stopPlaybackClock = (resumeBackgroundMediaWork = true, freezeVisualClock = true): void => {
  if (playbackAnimationFrame !== undefined) cancelAnimationFrame(playbackAnimationFrame);
  playbackAnimationFrame = undefined;
  stopTransitionPlaybackAnimation();
  if (freezeVisualClock) {
    timelineRef.value?.stopPlaybackNeedle(playhead.value);
    stopPlayerScrubberMotion(playhead.value);
    syncPlayerTimecode(playhead.value);
  }
  activePlaybackSlotId = '';
  activeTransitionSignature = '';
  if (resumeBackgroundMediaWork) {
    pauseEffectTemplateMixThumbnailCapture(false);
    pauseEffectTemplateMixWaveformDecoding(false);
  }
};
const resetPlaybackClock = (): void => {
  playbackAnchorMilliseconds = performance.now();
  playbackAnchorSeconds = playhead.value;
};
const collectPlaybackSyncBoundaries = (): number[] => {
  const values = new Set<number>([0, currentDuration.value]);
  const variant = selectedVariant.value;
  const ranges = currentTiming.value.slots;
  for (const range of ranges) {
    values.add(range.start);
    values.add(range.end);
  }
  if (variant) {
    for (let index = 1; index < variant.slots.length; index += 1) {
      const incoming = variant.slots[index]!;
      if (incoming.transition === '硬切') continue;
      const outgoing = variant.slots[index - 1]!;
      const range = ranges.find(({ id }) => id === incoming.id);
      if (!range) continue;
      const duration = effectTemplateMixTransitionDuration(incoming, outgoing);
      values.add(Math.max(0, range.start - duration / 2));
      values.add(Math.min(currentDuration.value, range.start + duration / 2));
    }
    for (const caption of selectedPackaging.value?.checkpoint.captions ?? variant.captions) {
      values.add(caption.start);
      values.add(caption.end);
    }
    for (const audio of variant.detachedAudios ?? []) {
      values.add(audio.start);
      values.add(audio.start + audio.duration);
    }
  }
  const checkpoint = selectedPackaging.value?.checkpoint;
  for (const audio of Object.values(checkpoint?.voices ?? {})) {
    values.add(audio.start);
    values.add(audio.start + audio.duration);
  }
  if (checkpoint?.music) {
    values.add(checkpoint.music.start);
    values.add(checkpoint.music.start + checkpoint.music.duration);
  }
  return [...values]
    .filter((value) => Number.isFinite(value) && value >= 0 && value <= currentDuration.value)
    .sort((left, right) => left - right);
};
const resetPlaybackSyncBoundaries = (): void => {
  playbackSyncBoundaries = collectPlaybackSyncBoundaries();
  nextPlaybackBoundaryIndex = playbackSyncBoundaries.findIndex(
    (value) => value > playhead.value + 1 / (TIMELINE_FPS * 2),
  );
  if (nextPlaybackBoundaryIndex < 0) nextPlaybackBoundaryIndex = playbackSyncBoundaries.length;
};
const currentPlaybackClockSeconds = (): number =>
  Math.max(
    0,
    Math.min(
      currentDuration.value,
      playbackAnchorSeconds + (performance.now() - playbackAnchorMilliseconds) / 1000,
    ),
  );
const syncPlayingVideoFrame = (): void => {
  const playbackTime = currentPlaybackClockSeconds();
  const transition = transitionPreviewAt(playbackTime);
  if (transition) {
    syncTransitionPlaybackAnimation(transition, playbackTime);
    const activeIds = [transition.outgoingSlot.id, transition.incomingSlot.id];
    pauseTimelinePlayers(activeIds);
    const signature = `${transition.outgoingSlot.id}->${transition.incomingSlot.id}`;
    const entering = activeTransitionSignature !== signature;
    if (entering) activeTransitionSignature = signature;
    const outgoing = syncTimelineVideo(
      transition.outgoingSlot.id,
      true,
      entering ? 'drift' : 'once',
    );
    const incoming = syncTimelineVideo(
      transition.incomingSlot.id,
      true,
      entering ? 'drift' : 'once',
    );
    if (!outgoing && !incoming) {
      displayedTimelineSlotId.value = '';
      return;
    }
    activePlaybackSlotId = transition.incomingSlot.id;
    if (incoming?.readyState && incoming.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      playerUnavailableSlotId.value = '';
      displayedTimelineSlotId.value = transition.incomingSlot.id;
    }
    return;
  }
  syncTransitionPlaybackAnimation(null, playbackTime);
  const slot = previewSlot.value;
  const range = previewRange.value;
  const material = previewMaterial.value;
  if (!slot || !range || !selectedVariant.value || !material) {
    pauseTimelinePlayers();
    displayedTimelineSlotId.value = '';
    playerUnavailableSlotId.value = '';
    activePlaybackSlotId = '';
    return;
  }
  const video = timelinePlayers.get(slot.id);
  if (!video) {
    displayedTimelineSlotId.value = '';
    return;
  }
  const sourceTime = timelineSourceTime(slot.id) ?? 0;
  const switchedSlot = activePlaybackSlotId !== slot.id;
  const needsSlotSeek = switchedSlot || !positionedTimelinePlayers.has(video);
  if (switchedSlot) {
    activePlaybackSlotId = slot.id;
    displayedTimelineSlotId.value = '';
    pauseTimelinePlayers(slot.id);
    for (const [slotId, otherVideo] of timelinePlayers) {
      otherVideo.preload = slotId === slot.id ? 'auto' : 'metadata';
    }
    video.preload = 'auto';
  }
  if (video.readyState >= HTMLMediaElement.HAVE_METADATA) {
    // Seek only when entering a clip. During playback the browser's native
    // media clock owns frame delivery; correcting currentTime from our RAF on
    // every drift would turn normal decode jitter into visible stutter.
    if (needsSlotSeek) {
      try {
        video.currentTime = Math.max(0, sourceTime);
        positionedTimelinePlayers.add(video);
      } catch {
        // Metadata can be replaced while a source is loading; the ready callback retries.
      }
    }
  }
  if (switchedSlot) primeUpcomingTimelinePlayer(range);
  if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
    playerUnavailableSlotId.value = '';
    displayedTimelineSlotId.value = slot.id;
    if (video.paused) void video.play().catch(() => undefined);
  }
};
const updatePlaybackFrame = (now: number): void => {
  if (!playing.value) {
    stopPlaybackClock();
    return;
  }
  const next = playbackAnchorSeconds + (now - playbackAnchorMilliseconds) / 1000;
  syncPlayerTimecode(next);
  if (next >= currentDuration.value) {
    playhead.value = currentDuration.value;
    syncPlayerTimecode(currentDuration.value);
    playing.value = false;
    pauseTimelinePlayers();
    syncDetachedAudio();
    stopPlaybackClock();
    return;
  }
  // The playhead and player progress are compositor animations. This RAF only updates business
  // state and clip switching, so a busy Vue render cannot make the visual clock stutter.
  // Keep the native video clock smooth and the needle on its own RAF transform. Full timeline
  // reactivity is intentionally lower-rate so the large editor tree cannot starve compositor frames.
  const nextBoundary = playbackSyncBoundaries[nextPlaybackBoundaryIndex];
  const crossedBoundary = nextBoundary !== undefined && next >= nextBoundary;
  if (crossedBoundary) {
    while (
      nextPlaybackBoundaryIndex < playbackSyncBoundaries.length &&
      next >= playbackSyncBoundaries[nextPlaybackBoundaryIndex]!
    ) {
      nextPlaybackBoundaryIndex += 1;
    }
  }
  if (crossedBoundary || now - lastUiPlaybackMilliseconds >= 1000) {
    lastUiPlaybackMilliseconds = now;
    playhead.value = next;
    syncPlayingVideoFrame();
    syncDetachedAudio();
  }
  playbackAnimationFrame = requestAnimationFrame(updatePlaybackFrame);
};
const startPlaybackClock = (): void => {
  stopPlaybackClock(false, false);
  pauseEffectTemplateMixThumbnailCapture(true);
  pauseEffectTemplateMixWaveformDecoding(true);
  resetPlaybackClock();
  syncPlayerTimecode(playhead.value);
  resetPlaybackSyncBoundaries();
  timelineRef.value?.startPlaybackNeedle(playhead.value, currentDuration.value);
  startPlayerScrubberMotion(playhead.value);
  // `performance.now()` is already much larger than one second. Starting from zero made the
  // very first RAF publish a full-page reactive playhead update immediately, which could keep
  // the main thread busy long enough for the pause pointer event to feel delayed.
  lastUiPlaybackMilliseconds = performance.now();
  playbackAnimationFrame = requestAnimationFrame(updatePlaybackFrame);
};
const syncPlayerToPlayhead = async (resume = false): Promise<void> => {
  const requestId = ++seekSyncRequestId;
  const apply = (): boolean => {
    if (requestId !== seekSyncRequestId) return true;
    const slot = previewSlot.value;
    const range = previewRange.value;
    const material = previewMaterial.value;
    if (!slot || !range || !selectedVariant.value || !material) {
      pauseTimelinePlayers();
      displayedTimelineSlotId.value = '';
      playerUnavailableSlotId.value = '';
      return true;
    }
    const playbackTime = resume ? currentPlaybackClockSeconds() : playhead.value;
    const transition = transitionPreviewAt(playbackTime);
    if (transition) {
      if (resume) syncTransitionPlaybackAnimation(transition, playbackTime);
      else syncTransitionPlaybackAnimation(null, playbackTime);
      const activeIds = [transition.outgoingSlot.id, transition.incomingSlot.id];
      pauseTimelinePlayers(activeIds);
      const outgoing = syncTimelineVideo(transition.outgoingSlot.id, resume);
      const incoming = syncTimelineVideo(transition.incomingSlot.id, resume);
      if (incoming?.readyState && incoming.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        playerUnavailableSlotId.value = '';
        displayedTimelineSlotId.value = transition.incomingSlot.id;
        transitionFrame.value = '';
      } else if (
        outgoing?.readyState &&
        outgoing.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
      ) {
        playerUnavailableSlotId.value = '';
        displayedTimelineSlotId.value = transition.outgoingSlot.id;
      }
      return true;
    }
    syncTransitionPlaybackAnimation(null, playbackTime);
    const video = activeTimelinePlayer();
    // The slot may have just mounted after a variant switch. Ask the caller to
    // retry after Vue flushes once, but never keep an old seek request alive.
    if (!video) return false;
    pauseTimelinePlayers(slot.id);
    const sourceTime = timelineSourceTime(slot.id);
    if (sourceTime !== null && Math.abs(video.currentTime - sourceTime) > 1 / TIMELINE_FPS) {
      try {
        video.currentTime = Math.max(0, sourceTime);
      } catch {
        // Metadata may be replaced while a source is loading; the ready callback retries.
      }
    }
    primeUpcomingTimelinePlayer(range);
    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && !video.seeking) {
      playerUnavailableSlotId.value = '';
      displayedTimelineSlotId.value = slot.id;
      transitionFrame.value = '';
    }
    if (resume && video.paused) {
      void video.play().catch(() => undefined);
    }
    return true;
  };
  if (apply()) return;
  await nextTick();
  if (requestId === seekSyncRequestId) apply();
};
const scheduleSeekSync = (): void => {
  if (pendingSeekSyncFrame !== undefined) return;
  pendingSeekSyncFrame = requestAnimationFrame(() => {
    pendingSeekSyncFrame = undefined;
    void syncPlayerToPlayhead(playing.value);
  });
};
const seek = (raw: number): void => {
  closeMaterialPreview();
  stopTransitionPlaybackAnimation();
  playhead.value = quantizeTimelineTime(raw);
  syncPlayerTimecode(playhead.value);
  timelineRef.value?.setPlaybackNeedle(playhead.value);
  setPlayerScrubber(playhead.value);
  playbackSeekVersion.value += 1;
  if (playing.value) {
    resetPlaybackClock();
    resetPlaybackSyncBoundaries();
    timelineRef.value?.startPlaybackNeedle(playhead.value, currentDuration.value);
    startPlayerScrubberMotion(playhead.value);
  }
  syncDetachedAudio(playing.value);
  scheduleSeekSync();
};
const seekPreview = (raw: number): void => {
  const value = Math.max(0, Math.min(previewDuration.value, raw));
  if (auditionMaterial.value && auditionPlayer.value) {
    auditionPlayer.value.currentTime = value;
    auditionTime.value = value;
    syncPlayerTimecode(value);
    return;
  }
  seek(value);
};
const togglePlay = async (): Promise<void> => {
  if (!selectedVariant.value) return;
  closeMaterialPreview();
  if (playing.value) {
    const pausedAt = currentPlaybackClockSeconds();
    // Invalidate a pending async seek/play request before it can resume a video after pause.
    seekSyncRequestId++;
    playing.value = false;
    playhead.value = pausedAt;
    stopPlaybackClock(false);
    pauseTimelinePlayers();
    packagingPanel.value?.stopPlaybackAudio();
    syncDetachedAudio();
    stopPlaybackClock();
    return;
  }
  if (playhead.value >= currentDuration.value - 1 / TIMELINE_FPS) seek(0);
  playing.value = true;
  // Start packaged audio before the async video seek so the browser still treats it as the
  // player's user gesture. The child continues syncing it to the shared playhead afterwards.
  packagingPanel.value?.startPlaybackAudio();
  syncDetachedAudio(true);
  startPlaybackClock();
  await syncPlayerToPlayhead(true);
};
const onTimelinePlayerReady = (slotId: string): void => {
  const transition = activeTransitionPreview.value;
  const isVisibleSlot =
    previewSlot.value?.id === slotId ||
    transition?.incomingSlot.id === slotId ||
    transition?.outgoingSlot.id === slotId;
  if (auditionMaterial.value || !isVisibleSlot) return;
  const video = timelinePlayers.get(slotId);
  if (!video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
  detectMaterialAudio(materialForSlot(slotId), video);
  playerUnavailableSlotId.value = '';
  displayedTimelineSlotId.value = slotId;
  transitionFrame.value = '';
  // Readiness callbacks may arrive repeatedly during decoding. The project RAF
  // advances the timeline while the active media element owns frame delivery.
  if (playing.value) syncPlayingVideoFrame();
  else void syncPlayerToPlayhead(false);
};
const onTimelinePlayerError = (slotId: string): void => {
  if (previewSlot.value?.id !== slotId) return;
  playerUnavailableSlotId.value = slotId;
  displayedTimelineSlotId.value = '';
};
const onTimelinePlayerTimeUpdate = (slotId: string): void => {
  detectMaterialAudio(materialForSlot(slotId), timelinePlayers.get(slotId) ?? null);
};
const onAuditionTime = (): void => {
  auditionTime.value = auditionPlayer.value?.currentTime ?? 0;
  syncPlayerTimecode(auditionTime.value);
  setPlayerScrubber(auditionTime.value);
  detectMaterialAudio(auditionMaterial.value, auditionPlayer.value);
};
const onAuditionEnded = (): void => {
  auditionPlaying.value = false;
  stopPlayerScrubberMotion(auditionPlayer.value?.duration ?? auditionTime.value);
};
const onAuditionPlay = (): void => {
  auditionPlaying.value = true;
  startPlayerScrubberMotion(auditionPlayer.value?.currentTime ?? auditionTime.value);
};
const onAuditionPause = (): void => {
  auditionPlaying.value = false;
  stopPlayerScrubberMotion(auditionPlayer.value?.currentTime ?? auditionTime.value);
};
const toggleAuditionPlayback = async (): Promise<void> => {
  const video = auditionPlayer.value;
  if (!video) return;
  if (!video.paused) {
    onAuditionPause();
    video.pause();
    return;
  }
  if (video.currentTime >= video.duration - 0.04) video.currentTime = 0;
  try {
    await video.play();
    onAuditionPlay();
  } catch {
    showNotice('浏览器未能开始播放，请再次点击', 'warning');
  }
};
const togglePreviewPlayback = (): void => {
  if (auditionMaterial.value) void toggleAuditionPlayback();
  else void togglePlay();
};
const onPreviewPlaybackPointerDown = (event: PointerEvent): void => {
  if (event.button !== 0) return;
  event.preventDefault();
  togglePreviewPlayback();
};
const onPreviewPlaybackClick = (event: MouseEvent): void => {
  // Mouse/touch already toggles on pointer-down for editor-grade pause latency.
  // A synthetic keyboard click has detail 0 and still needs the normal button action.
  if (event.detail === 0) togglePreviewPlayback();
};
const togglePlayerMenu = (menu: 'DISPLAY'): void => {
  playerMenu.value = playerMenu.value === menu ? null : menu;
};
const setPreviewZoom = (value: number): void => {
  previewZoom.value = Math.max(25, Math.min(200, Math.round(value / 5) * 5));
};
const adjustPreviewZoom = (delta: number): void => setPreviewZoom(previewZoom.value + delta);
const toggleFullscreen = async (): Promise<void> => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await playerPanel.value?.requestFullscreen();
  } catch {
    showNotice('当前浏览器无法进入全屏预览', 'warning');
  }
};
const onFullscreenChange = (): void => {
  playerFullscreen.value = document.fullscreenElement === playerPanel.value;
};
const validateDraft = async (): Promise<void> => {
  if (!activeEntry.value || draftRevision.value === null || !canValidate.value) return;
  validating.value = true;
  try {
    const signature = `${props.projectId}:${props.workflowRunId}:${activeEntry.value.id}:${draftRevision.value}`;
    if (completionKey?.signature !== signature)
      completionKey = { signature, key: crypto.randomUUID() };
    await completeEffectTemplateMixPackaging(
      props.projectId,
      props.workflowRunId,
      draftRevision.value,
      activeEntry.value.id,
      completionKey.key,
    );
    committedVersions[activeEntry.value.id] = activeEntry.value.workspace.editVersion;
    showNotice('全部视觉与包装已提交，已进入成片待渲染区');
    emit('next');
  } catch (error) {
    showNotice(error instanceof Error ? error.message : '提交失败', 'error');
  } finally {
    validating.value = false;
  }
};
const flushPendingEdits = async (): Promise<boolean> => {
  clearTimeout(saveTimer);
  if (saveState.value === 'dirty') pendingSave = persist(true);
  return (await pendingSave) ?? true;
};
const onEscape = (event: KeyboardEvent): void => {
  if (event.key === 'Escape') {
    if (createOpen.value) void closeCreate();
    if (workflowDialogOpen.value) void closeWorkflowDialog();
  }
};
const onEditorKeydown = (event: KeyboardEvent): void => {
  onEscape(event);
  if (
    view.value !== 'EDITOR' ||
    createOpen.value ||
    workflowDialogOpen.value ||
    packagingPanel.value?.visible ||
    event.defaultPrevented
  )
    return;
  const target = event.target as HTMLElement | null;
  // The player scrubber keeps focus after seeking. It is a range input, but
  // Space is still the editor's play/pause shortcut there (unlike text inputs).
  if (event.code === 'Space' && target === playerScrubber.value) {
    event.preventDefault();
    if (!event.repeat) togglePreviewPlayback();
    return;
  }
  // A focused control only owns the keys it can actually act on: a text field takes them all, and a
  // button takes Space and Enter. Delete and Ctrl+Z mean the same thing everywhere else in the editor,
  // so a stale focus left on a button must not swallow them — clicking 「添加」 leaves the button
  // focused, and that is what made "delete this subtitle" and undo go missing.
  // The timeline's own buttons are the one exception: clicking a track's mute leaves it focused, and
  // letting it take Space meant the next Space re-toggled the mute instead of playing. Space belongs
  // to the player inside the timeline, so those buttons only keep Enter.
  const buttonOwnsKey =
    Boolean(target?.matches('button')) &&
    !target?.closest('.mix-timeline-shell') &&
    !target?.closest('.transition-junction') &&
    !activeTransitionSlotId.value &&
    (event.code === 'Space' || event.key === 'Enter');
  if (
    target?.matches('input, textarea, select, [contenteditable="true"]') ||
    buttonOwnsKey ||
    target?.closest('[role="dialog"]')
  )
    return;
  const key = event.key.toLocaleLowerCase();
  if (
    projectEditLocked.value &&
    (((event.ctrlKey || event.metaKey) && ['z', 'y'].includes(key)) ||
      key === 'delete' ||
      key === 'backspace')
  ) {
    event.preventDefault();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && key === 'z') {
    event.preventDefault();
    if (event.shiftKey) redoTimelineEdit();
    else undoTimelineEdit();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && key === 'y') {
    event.preventDefault();
    redoTimelineEdit();
    return;
  }
  if (event.code === 'Space') {
    event.preventDefault();
    if (!event.repeat) togglePreviewPlayback();
    return;
  }
  if (event.key === 'Delete' || event.key === 'Backspace') {
    event.preventDefault();
    deleteSelectedTimelineItem();
    return;
  }
  if (event.key.toLocaleLowerCase() === 'f') {
    event.preventDefault();
    void toggleFullscreen();
    return;
  }
  if (event.key === 'Home' || event.key === 'End') {
    event.preventDefault();
    auditionPlayer.value?.pause();
    pauseTimelinePlayers();
    playing.value = false;
    seekPreview(event.key === 'Home' ? 0 : previewDuration.value);
    return;
  }
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    event.preventDefault();
    auditionPlayer.value?.pause();
    pauseTimelinePlayers();
    playing.value = false;
    seekPreview(previewCurrentTime.value + (event.key === 'ArrowRight' ? 1 : -1) / TIMELINE_FPS);
  }
};
watch(
  () => [props.projectId, props.workflowRunId],
  () => void load(),
);
watch(() => props.previewTarget, applyPreviewTarget);
watch([() => previewSlot.value?.id, () => previewMaterial.value?.id], () => {
  if (!auditionMaterial.value) void syncPlayerToPlayhead(playing.value);
});
watch(auditionMaterial, (material) => {
  if (!material) void syncPlayerToPlayhead(playing.value);
});
watch([stageAspectRatio, view], () => void fitPlayerPaneToMaterial());
watch(
  () => [selectedSlot.value?.id, keyword.value, materialRoleFilter.value],
  () => (materialPage.value = 1),
);
watch(activeTemplateId, () => (materialRoleFilter.value = 'ALL'));
watch(materialGrid, (element) => {
  materialGridResizeObserver?.disconnect();
  materialGridResizeObserver = null;
  if (materialGridResizeFrame !== undefined) cancelAnimationFrame(materialGridResizeFrame);
  materialGridWidth.value = element?.clientWidth ?? 0;
  if (!element) return;
  materialGridResizeObserver = new ResizeObserver(() => {
    if (materialGridResizeFrame !== undefined) cancelAnimationFrame(materialGridResizeFrame);
    materialGridResizeFrame = requestAnimationFrame(() => {
      materialGridResizeFrame = undefined;
      const nextWidth = element.clientWidth;
      if (Math.abs(materialGridWidth.value - nextWidth) >= 1) materialGridWidth.value = nextWidth;
    });
  });
  materialGridResizeObserver.observe(element);
});
watch(stageElement, (element) => {
  stageResizeObserver?.disconnect();
  stageResizeObserver = null;
  if (stageResizeFrame !== undefined) cancelAnimationFrame(stageResizeFrame);
  stageResizeFrame = undefined;
  const measure = (): void => {
    const size = element ? Math.max(11, Math.round(element.clientWidth / 22)) : 14;
    if (size !== stageCaptionFontSize.value) stageCaptionFontSize.value = size;
  };
  measure();
  if (!element) return;
  stageResizeObserver = new ResizeObserver(() => {
    if (stageResizeFrame !== undefined) cancelAnimationFrame(stageResizeFrame);
    stageResizeFrame = requestAnimationFrame(() => {
      stageResizeFrame = undefined;
      measure();
    });
  });
  stageResizeObserver.observe(element);
});
watch(materialColumnCount, () => (materialPage.value = 1));
watch(materialPageCount, (count) => {
  if (materialPage.value > count) materialPage.value = count;
});
onMounted(() => {
  updateWorkbenchMode();
  window.addEventListener('resize', updateWorkbenchMode);
  window.addEventListener('keydown', onEditorKeydown);
  document.addEventListener('fullscreenchange', onFullscreenChange);
  void load();
});
let mixWorkbenchWasDeactivated = false;
onActivated(() => {
  if (!mixWorkbenchWasDeactivated) {
    applyPreviewTarget();
    return;
  }
  mixWorkbenchWasDeactivated = false;
  void (async () => {
    if (!(await flushPendingEdits())) return;
    await load();
  })();
});
onDeactivated(() => {
  mixWorkbenchWasDeactivated = true;
  playing.value = false;
  pauseTimelinePlayers();
  stopPlaybackClock();
  packagingPanel.value?.stopPlaybackAudio();
});
onBeforeUnmount(() => {
  stopPlaybackClock();
  if (pendingSeekSyncFrame !== undefined) cancelAnimationFrame(pendingSeekSyncFrame);
  pendingSeekSyncFrame = undefined;
  seekSyncRequestId += 1;
  stopPaneResize();
  stopEditorHeightResize();
  pauseTimelinePlayers();
  for (const player of detachedAudioPlayers.values()) player.pause();
  timelinePlayers.clear();
  detachedAudioPlayers.clear();
  removeMaterialPointerListeners();
  materialPointerDrag.value = null;
  materialDragGhost?.remove();
  materialDragGhost = null;
  clearMaterialPointerTarget();
  materialGridResizeObserver?.disconnect();
  stageResizeObserver?.disconnect();
  stageResizeObserver = null;
  if (stageResizeFrame !== undefined) cancelAnimationFrame(stageResizeFrame);
  stageResizeFrame = undefined;
  if (materialGridResizeFrame !== undefined) cancelAnimationFrame(materialGridResizeFrame);
  window.removeEventListener('resize', updateWorkbenchMode);
  controller?.abort();
  clearTimeout(saveTimer);
  clearTimeout(noticeTimer);
  stopPolling();
  window.removeEventListener('keydown', onEditorKeydown);
  document.removeEventListener('fullscreenchange', onFullscreenChange);
  if (saveState.value === 'dirty') void persist(true);
});
defineExpose({ flushPendingEdits });
</script>

<template>
  <section class="mix-node" :aria-busy="pageState === 'LOADING'">
    <Transition name="notice"
      ><div v-if="notice" class="notice" :class="notice.kind" role="status">
        <CheckCircle2 v-if="notice.kind === 'success'" :size="17" />
        <AlertCircle v-else :size="17" />
        <span>{{ notice.text }}</span>
        <button type="button" aria-label="关闭提示" @click="notice = null">
          <X :size="14" />
        </button></div
    ></Transition>
    <section v-if="pageState === 'LOADING'" class="page-state">
      <LoaderCircle class="spin" :size="34" />
      <h2>正在恢复混剪工作区</h2>
      <p>读取当前运行的模板草稿与已确认视频片段。</p>
    </section>
    <section v-else-if="pageState === 'ERROR'" class="page-state error">
      <AlertCircle :size="34" />
      <h2>混剪工作区加载失败</h2>
      <p>{{ errorMessage }}</p>
      <button class="button" @click="load">重新加载</button>
    </section>
    <template v-else>
      <header v-if="view === 'CONFIG'" class="config-head">
        <div class="config-head__title">
          <span>05</span>
          <div>
            <h1>混剪模板</h1>
            <p>按模板规则批量搭建成片工程，再逐条进入时间轴精修</p>
          </div>
        </div>
        <div class="config-head__actions">
          <button class="button" @click="openCreate"><Plus :size="15" />新建模板</button>
        </div>
      </header>
      <section v-if="view === 'CONFIG' && !activeEntry" class="page-state">
        <Layers3 :size="38" />
        <h2>还没有混剪模板</h2>
        <p>先新建模板，再使用上一步已确认的视频素材填充。</p>
        <button class="button primary" @click="openCreate">
          <Plus :size="15" />新建第一个模板
        </button>
      </section>
      <section v-else-if="view === 'CONFIG' && workspace" class="config-layout">
        <aside class="panel template-list">
          <h2>
            我的模板 <small>{{ catalog.length }}</small>
          </h2>
          <button
            v-for="entry in catalog"
            :key="entry.id"
            :class="{ active: entry.id === activeTemplateId }"
            @click="selectTemplate(entry.id)"
          >
            <Layers3 :size="17" /><span
              ><b>{{ entry.workspace.template.name }}</b
              ><small
                >{{ entry.workspace.template.slots.length }} 个槽位 ·
                {{ entry.workspace.variants.length }} 个工程</small
              ></span
            ></button
          ><button class="button new-template" @click="openCreate">
            <Plus :size="14" />新建模板
          </button>
        </aside>
        <div class="panel config-panel">
          <header>
            <div>
              <h2>模板配置</h2>
              <p>槽位区间和成片总时长会实时计算。</p>
            </div>
            <span
              >成片总时长 <b>{{ templateTiming.duration.toFixed(1) }} 秒</b></span
            >
          </header>
          <label class="name-field"
            >模板名称<input
              v-model="workspace.template.name"
              maxlength="40"
              :disabled="templateEditLocked"
              :aria-invalid="activeTemplateNameConflict"
              @focus="beginTemplateNameEdit"
              @change="changeTemplateName"
          /></label>
          <small v-if="activeTemplateNameConflict" class="name-conflict" role="alert">
            当前工作流已有同名模板，请修改名称。
          </small>
          <div class="slot-table">
            <div class="slot-heading">
              <span>槽位 / 顺序</span><span>时间区间（自动）</span><span>时长（秒）</span
              ><span>转场衔接</span>
            </div>
            <div v-for="(slot, index) in workspace.template.slots" :key="slot.id" class="slot-row">
              <div class="slot-name">
                <b>{{ index + 1 }}</b
                ><span>{{ EFFECT_TEMPLATE_MIX_ROLE_LABELS[slot.role] }}</span
                ><button
                  :disabled="templateEditLocked || index === 0"
                  @click="moveTemplateSlot(slot.id, -1)"
                >
                  ↑</button
                ><button
                  :disabled="templateEditLocked || index === workspace.template.slots.length - 1"
                  @click="moveTemplateSlot(slot.id, 1)"
                >
                  ↓
                </button>
              </div>
              <code
                >{{ formatEffectTemplateMixTime(templateTiming.slots[index]?.start ?? 0) }} —
                {{ formatEffectTemplateMixTime(templateTiming.slots[index]?.end ?? 0) }}</code
              ><input
                v-model.number="slot.duration"
                type="number"
                min="4"
                max="15"
                step=".1"
                :disabled="templateEditLocked"
                @change="changeTemplate"
              /><template v-if="index < workspace.template.slots.length - 1">
                <select
                  :value="templateTransitionForRow(index)?.transition ?? '硬切'"
                  :aria-label="`${EFFECT_TEMPLATE_MIX_ROLE_LABELS[slot.role]}到下一槽位的转场`"
                  :disabled="templateEditLocked"
                  @change="changeTemplateTransition(index, $event)"
                >
                  <option v-for="item in EFFECT_TEMPLATE_MIX_TRANSITIONS" :key="item" :value="item">
                    {{ item === '硬切' ? '无转场' : item }}
                  </option>
                </select>
              </template>
              <span v-else class="slot-transition-empty">—</span>
            </div>
          </div>
          <footer>
            <div>
              <p v-if="availableMaterials.length">
                已载入 {{ availableMaterials.length }} 个已确认视频片段<template
                  v-if="expiredMaterialCount"
                  >；旧成片另保留 {{ expiredMaterialCount }} 条历史素材</template
                >。
              </p>
              <p v-else-if="expiredMaterialCount" class="warning">
                {{ expiredMaterialCount }} 条旧素材已过期；请先在视频渲染节点更新素材并完成校验，再重新智能填充。
              </p>
              <p v-else class="warning">上一步没有已确认视频片段，可配置模板，但无法完成填充。</p>
              <small v-if="workspace.variants.length"
                >已有 {{ workspace.variants.length }} 个工程，进入后继续编辑。</small
              >
            </div>
            <button
              class="button primary"
              :disabled="!workspace.template.name.trim() || mutating"
              @click="enterEditor"
            >
              <WandSparkles :size="15" />进入精修工作台
            </button>
          </footer>
          <p v-if="packagingLocked" class="template-lock-banner" role="status">
            <Lock
              :size="15"
            />模板槽位配置和常规智能填充已锁定；音色仍可切换，影响后续包装与口播；上游素材更新时可仅重算受影响素材的截取区间；仍可新建空成片并精修未包装工程。
          </p>
          <p v-else-if="templateEditLocked" class="template-lock-banner" role="status">
            <Lock :size="15" />智能填充正在运行，模板暂时锁定；任务结束后可修改。
          </p>
          <p
            v-else-if="activeEntry?.needsAiFill"
            class="template-lock-banner warning"
            role="status"
          >
            <AlertCircle
              :size="15"
            />模板配置或素材版本已变化；请逐条重新智能填充受影响的成片，完成后才能开始包装。
          </p>
        </div>
      </section>

      <section
        v-else-if="view === 'EDITOR' && workspace"
        class="panel workbench"
        @dragstart.capture="onNativeImageDragStart"
        @pointerdown.capture="onWorkbenchPointerDown"
      >
        <header class="workbench-head">
          <div class="brand">
            <span aria-hidden="true"><Film :size="18" /></span>
            <div><strong>成片精修工作台</strong><small>修改自动保存到当前模板工程</small></div>
          </div>
          <div class="current">
            <b>{{ selectedVariantDisplayName }}</b
            ><span
              >{{ workspace.template.name }} · 模板时长 {{ currentDuration.toFixed(1) }} 秒</span
            >
          </div>
          <div class="workbench-actions">
            <button
              v-if="selectedVariantRefreshSlotIds.length"
              class="button primary"
              type="button"
              :disabled="
                mutating || Boolean(activeAiRun) || selectedVariantRefreshSlotIds.length === 0
              "
              :title="`保留槽位和其他剪辑，只重新分析 ${selectedVariantRefreshSlotIds.length} 个已更新素材的截取起点`"
              @click="refreshAffectedClips"
            >
              <LoaderCircle
                v-if="activeAiRun?.operation === 'REFRESH_TRIMS'"
                class="spin"
                :size="15"
              />
              <WandSparkles v-else :size="15" />
              {{
                activeAiRun?.operation === 'REFRESH_TRIMS'
                  ? '正在更新素材截取…'
                  : `自动更新截取区间（${selectedVariantRefreshSlotIds.length}）`
              }}
            </button>
            <button
              class="button primary"
              type="button"
              :disabled="
                mutating ||
                Boolean(activeAiRun) ||
                packagingLocked ||
                Boolean(aiFillBlockReason)
              "
              :title="aiFillBlockReason ?? '按模板规则为每个槽位挑选一条不重复的当前素材'"
              @click="refill"
            >
              <LoaderCircle v-if="activeAiRun" class="spin" :size="15" />
              <RefreshCw v-else-if="selectedVariant" :size="15" />
              {{ activeAiRun ? '智能填充中…' : selectedVariant ? '重新智能填充' : '智能填充' }}
            </button>
            <button
              ref="workflowTrigger"
              class="button workflow-graph-trigger"
              type="button"
              aria-haspopup="dialog"
              @click="openWorkflowDialog"
            >
              <Workflow :size="14" />查看工作流
            </button>
            <button
              v-if="
                previewTarget?.projectId === projectId &&
                previewTarget?.workflowRunId === workflowRunId
              "
              class="button"
              type="button"
              @click="returnToFinalOutput"
            >
              返回成片输出
            </button>
            <button class="button" @click="leaveEditor">返回模板配置</button>
          </div>
        </header>
        <div v-if="packagingLocked" class="template-lock-banner" role="status">
          <Lock :size="15" />{{ packagingLockNotice }}
        </div>
        <div v-else-if="templateEditLocked" class="template-lock-banner" role="status">
          <Lock :size="15" />智能填充正在运行，模板和成片工程暂时锁定。
        </div>
        <div
          v-else-if="activeEntry?.needsAiFill"
          class="template-lock-banner warning"
          role="status"
        >
          <AlertCircle
            :size="15"
          />模板配置或素材版本已变化；请重新智能填充受影响的成片。可用的原素材归属尽量保留，已过期素材会重新匹配。
        </div>
        <div
          v-if="packagingFailures.length"
          class="template-lock-banner warning"
          role="alert"
          data-testid="packaging-failure-banner"
        >
          <AlertCircle :size="15" />{{ packagingFailures.length }} 条成片包装失败：{{
            packagingFailures
              .map((failure) => failure.name)
              .slice(0, 3)
              .join('、')
          }}{{ packagingFailures.length > 3 ? ' 等' : '' }}。仍可完成校验，这些成片会以无包装成片提交，仅保留画面、没有口播字幕配乐。
          <button class="button compact" type="button" @click="openPackaging('WORKFLOW')">
            打开包装面板恢复
          </button>
        </div>
        <div v-if="failedAiRun" class="ai-run-card editor-run failed" role="alert">
          <AlertCircle :size="18" />
          <div>
            <b>智能填充失败</b><span>{{ failedAiRun.errorMessage || '请检查素材后重试。' }}</span>
          </div>
          <button class="button compact" @click="openWorkflowDialog">查看工作流</button>
          <button class="button compact" @click="retryFailedAiRun">重试</button>
        </div>
        <div
          ref="workbenchMain"
          class="workbench-main"
          :class="{ 'is-resizing': resizingPane }"
          :style="workbenchGridStyle"
        >
          <aside class="resources">
            <nav class="resource-tabs">
              <button
                :class="{ active: resourceTab === 'MATERIAL' }"
                @click="selectResourceTab('MATERIAL')"
              >
                <Clapperboard :size="14" />素材</button
              ><button
                :class="{ active: resourceTab === 'VOICE' }"
                @click="selectResourceTab('VOICE')"
              >
                <AudioLines :size="14" />音色</button
              ><button
                :class="{ active: resourceTab === 'MUSIC' }"
                @click="selectResourceTab('MUSIC')"
              >
                <Music2 :size="14" />音乐</button
              ><button
                :class="{ active: resourceTab === 'TEXT' }"
                :disabled="!selectedVariant"
                @click="selectResourceTab('TEXT')"
              >
                <Captions :size="14" />字幕</button
              ><button
                :class="{ active: resourceTab === 'TRANSITION' }"
                :disabled="!selectedVariant"
                @click="selectResourceTab('TRANSITION')"
              >
                <Blend :size="14" />转场
              </button>
            </nav>
            <template v-if="resourceTab === 'MATERIAL'">
              <label class="search"
                ><Search :size="13" /><input v-model="keyword" placeholder="搜索素材或标签"
              /></label>
              <div
                v-if="activeClassificationPool"
                class="material-role-filters"
                aria-label="AI 归槽素材筛选"
              >
                <button
                  :class="{ active: materialRoleFilter === 'ALL' }"
                  @click="selectMaterialRole('ALL')"
                >
                  全部 <small>{{ bestClassificationByMaterial.size }}</small>
                </button>
                <button
                  v-for="option in materialRoleOptions"
                  :key="option.role"
                  :class="{ active: materialRoleFilter === option.role }"
                  @click="selectMaterialRole(option.role)"
                >
                  {{ option.label }} <small>{{ option.count }}</small>
                </button>
              </div>
              <p v-if="expiredMaterialCount && !availableMaterials.length" class="material-expired-banner" role="status">
                <AlertCircle :size="14" />当前没有已确认的可用素材；请先在视频渲染节点完成校验。
              </p>
              <p v-else-if="expiredMaterialCount" class="material-expired-banner" role="status">
                <AlertCircle :size="14" />已载入 {{ availableMaterials.length }} 条当前素材；{{ expiredMaterialCount }} 条旧素材仅保留在原成片工程中，不参与重新智能填充。
              </p>
              <div v-if="filteredMaterials.length" ref="materialGrid" class="material-grid">
                <article
                  v-for="material in displayedMaterials"
                  :key="material.id"
                  :class="{
                    selected: auditionMaterial?.id === material.id,
                    used: materialUsageLabel(material.id),
                    disabled: !selectedVariant || projectEditLocked,
                    dragging: draggingMaterialId === material.id,
                  }"
                  :draggable="Boolean(selectedVariant) && !projectEditLocked"
                  @click="onMaterialCardClick(material)"
                  @pointerdown="beginMaterialPointerDrag($event, material)"
                  @dragstart="beginMaterialDrag($event, material)"
                  @dragend="endMaterialDrag"
                >
                  <div class="thumb">
                    <EffectTemplateMixThumbnail
                      :source="material.contentUrl"
                      :time="Math.min(0.12, material.duration / 2)"
                      :version="`${material.artifactRevision}:${material.contentHash}`"
                    />
                    <Play :size="15" /><small>{{ material.duration.toFixed(1) }}s</small>
                  </div>
                  <div class="material-copy">
                    <div class="material-name-row">
                      <b :title="material.name">{{ material.name }}</b>
                      <span
                        v-if="classificationForMaterial(material.id)"
                        class="material-ai-role"
                        :class="{ low: classificationForMaterial(material.id)!.matchScore < 0.6 }"
                        :title="`AI 归槽分 ${(classificationForMaterial(material.id)!.matchScore * 100).toFixed(0)}`"
                      >
                        {{
                          EFFECT_TEMPLATE_MIX_ROLE_LABELS[
                            classificationForMaterial(material.id)!.role
                          ]
                        }}
                      </span>
                    </div>
                    <div class="material-card-actions">
                      <button
                        type="button"
                        class="material-action"
                        :disabled="!material.promptText"
                        @pointerdown.stop
                        @click.stop="openMaterialPrompt(material, $event)"
                      >
                        查看 Prompt
                      </button>
                      <button
                        type="button"
                        class="material-action material-action-primary"
                        :disabled="!selectedVariant"
                        title="选择另一个素材槽位，可与目标槽位素材交换"
                        @pointerdown.stop
                        @click.stop="openMaterialSlotPicker(material, $event)"
                      >
                        更换槽位
                      </button>
                    </div>
                  </div>
                </article>
              </div>
              <footer v-if="filteredMaterials.length" class="material-pagination">
                <button :disabled="materialPage <= 1" @click="materialPage--">上一页</button>
                <span>{{ materialPage }} / {{ materialPageCount }}</span>
                <button :disabled="materialPage >= materialPageCount" @click="materialPage++">
                  下一页
                </button>
              </footer>
              <div v-else class="resource-empty">
                <AlertCircle :size="24" /><b>没有可用素材</b
                ><span>请回到视频渲染节点确认可用片段。</span>
              </div></template
            >
            <template v-else-if="resourceTab === 'TEXT' && selectedVariant"
              ><header>
                <strong>字幕</strong
                ><button class="button compact" :disabled="!canAddCaption" @click="addCaption">
                  <Plus :size="13" />添加
                </button>
              </header>
            </template>
            <template v-else-if="resourceTab === 'TRANSITION' && selectedVariant">
              <div class="transition-browser">
                <aside class="transition-categories" aria-label="转场分类">
                  <button
                    class="transition-category-title"
                    type="button"
                    :aria-expanded="transitionCategoriesExpanded"
                    aria-controls="transition-category-list"
                    aria-label="展开或收起转场效果分类"
                    @click="transitionCategoriesExpanded = !transitionCategoriesExpanded"
                  >
                    <span
                      class="transition-category-toggle"
                      :class="{ expanded: transitionCategoriesExpanded }"
                      aria-hidden="true"
                    >
                      ▸
                    </span>
                    转场效果
                  </button>
                  <div
                    v-show="transitionCategoriesExpanded"
                    id="transition-category-list"
                    class="transition-category-list"
                  >
                    <button
                      v-for="category in [
                        '热门',
                        '叠化',
                        '幻灯片',
                        '运镜',
                        '最新',
                        '模糊',
                        '光效',
                        '拍摄',
                        '扭曲',
                      ]"
                      :key="category"
                      class="transition-category"
                      :class="{ active: category === '热门' }"
                      :disabled="category !== '热门'"
                      type="button"
                      :title="category === '热门' ? '当前分类' : '更多转场分类即将支持'"
                    >
                      {{ category }}
                    </button>
                  </div>
                </aside>
                <div class="transition-library">
                  <label class="transition-search"
                    ><Search :size="13" /><input
                      v-model="transitionKeyword"
                      placeholder="搜索转场名称/元素"
                  /></label>
                  <h4>转场效果</h4>
                  <div class="transition-card-grid">
                    <button
                      v-for="item in filteredTransitions"
                      :key="item.id"
                      class="transition-card"
                      :class="{ active: item.id === selectedSlot?.transition }"
                      type="button"
                      :disabled="projectEditLocked"
                      :draggable="!projectEditLocked"
                      @dragstart="beginTransitionDrag($event, item.id)"
                      @click="changeTransition(item.id)"
                    >
                      <span class="transition-preview" :class="item.previewClass">
                        <i v-if="item.id !== '硬切'">↔</i>
                      </span>
                      <strong>{{ item.label }}</strong>
                      <small>{{ item.description }}</small>
                    </button>
                  </div>
                  <p v-if="!filteredTransitions.length" class="resource-empty">没有匹配的转场</p>
                </div>
              </div></template
            >
            <EffectVoiceLibrary
              v-else-if="resourceTab === 'VOICE'"
              :project-id="props.projectId"
              :workflow-run-id="props.workflowRunId"
              :template-id="activeTemplateId"
              :selected-id="workspace.template.voiceProfileId"
              :playing="previewIsPlaying"
              :disabled="voiceSelectLocked"
              @select="selectVoiceProfile"
              @audition="pauseForVoiceAudition"
            />
            <EffectMusicLibrary
              v-else-if="resourceTab === 'MUSIC'"
              :project-id="props.projectId"
              :workflow-run-id="props.workflowRunId"
            />
          </aside>
          <div
            class="pane-resizer pane-resizer-left"
            role="separator"
            aria-label="调整素材库宽度"
            aria-orientation="vertical"
            :aria-valuemin="LEFT_PANE_MIN_WIDTH"
            :aria-valuemax="LEFT_PANE_MAX_WIDTH"
            :aria-valuenow="leftPaneWidth"
            @pointerdown="startPaneResize($event, 'LEFT')"
          >
            <span />
          </div>
          <section
            ref="playerPanel"
            class="player-panel"
            @click="playerMenu = null"
            @pointerdown="onPlayerPanelPointerDown"
          >
            <header>
              <strong>播放器</strong
              ><span
                >{{ stageMaterial?.ratio || '画幅未记录' }} ·
                {{ stageMaterial?.resolution || '分辨率未记录' }}</span
              >
            </header>
            <div class="stage-space" :class="{ 'is-zoomed': previewZoom > 100 }">
              <div
                ref="stageElement"
                class="stage"
                :class="{ landscape: stageAspectRatio >= 1 }"
                :style="stageStyle"
              >
                <img
                  v-if="transitionFrame"
                  class="player-transition-frame"
                  :src="transitionFrame"
                  alt=""
                  aria-hidden="true"
                />
                <video
                  v-if="auditionMaterial"
                  ref="auditionPlayer"
                  class="audition-video is-visible"
                  :src="auditionMaterial.contentUrl"
                  playsinline
                  preload="auto"
                  draggable="false"
                  @ended="onAuditionEnded"
                  @loadedmetadata="onAuditionTime"
                  @pause="onAuditionPause"
                  @play="onAuditionPlay"
                  @timeupdate="onAuditionTime"
                />
                <template v-for="slot in selectedVariant?.slots ?? []" :key="`player:${slot.id}`">
                  <video
                    v-if="materialForSlot(slot.id)"
                    :ref="(element) => setTimelinePlayer(slot.id, element)"
                    class="timeline-stage-video"
                    :class="{
                      'is-visible':
                        videoTrackVisible &&
                        !auditionMaterial &&
                        visibleTimelineSlotIds.has(slot.id),
                    }"
                    :style="timelinePlayerStyle(slot.id)"
                    :src="materialForSlot(slot.id)?.contentUrl"
                    :volume="
                      packagingPreviewEnabled && selectedPackaging
                        ? 0.15
                        : (selectedVariant?.originalVolume ?? 1)
                    "
                    playsinline
                    :muted="videoTrackMuted || slotHasDetachedAudio(slot.id)"
                    preload="metadata"
                    draggable="false"
                    @canplay="onTimelinePlayerReady(slot.id)"
                    @seeked="onTimelinePlayerReady(slot.id)"
                    @loadedmetadata="onTimelinePlayerReady(slot.id)"
                    @timeupdate="onTimelinePlayerTimeUpdate(slot.id)"
                    @error="onTimelinePlayerError(slot.id)"
                  />
                </template>
                <audio
                  v-for="audio in selectedVariant?.detachedAudios ?? []"
                  :key="`detached-player:${audio.id}`"
                  :ref="(element) => setDetachedAudioPlayer(audio.id, element)"
                  :src="detachedAudioSourceUrl(audio)"
                  preload="auto"
                  @loadedmetadata="syncDetachedAudio(true)"
                />
                <div
                  v-if="activeTransitionPreview && transitionOverlayStyle"
                  ref="transitionOverlayElement"
                  class="player-transition-overlay"
                  :style="transitionOverlayStyle"
                  aria-hidden="true"
                />
                <div
                  v-if="
                    selectedVariant && !auditionMaterial && (!videoTrackVisible || !previewMaterial)
                  "
                  class="player-blackout"
                  :aria-label="videoTrackVisible ? '素材缺口黑屏' : '视频轨道已隐藏'"
                />
                <div
                  v-if="previewCaption"
                  class="player-caption-box"
                  :class="{ 'is-selected': selectedCaptionIds.includes(previewCaption.id) }"
                  :style="captionBoxStyle(previewCaption.id)"
                  @pointercancel="onCaptionBoxPointerUp"
                  @pointerdown="onCaptionBoxPointerDown"
                  @pointermove="onCaptionBoxPointerMove"
                  @pointerup="onCaptionBoxPointerUp"
                >
                  <div class="player-caption">
                    {{ previewCaption.text }}
                    <button
                      v-if="captionEditable && selectedCaptionIds.includes(previewCaption.id)"
                      type="button"
                      class="caption-scale-handle"
                      title="向上拖动放大字幕，向下拖动缩小字幕"
                      aria-label="拖动调整字幕字号"
                      @pointerdown.stop="onCaptionBoxPointerDown($event, 'SCALE')"
                    />
                  </div>
                </div>
                <div
                  v-if="captionGuideX !== null"
                  class="caption-guide is-vertical"
                  :style="{ left: captionGuideOffset(captionGuideX) }"
                  aria-hidden="true"
                />
                <div
                  v-if="captionGuideY !== null"
                  class="caption-guide is-horizontal"
                  :style="{ bottom: captionGuideOffset(captionGuideY) }"
                  aria-hidden="true"
                />
                <div v-if="!selectedVariant && !auditionMaterial" class="player-empty">
                  <Film :size="34" />
                  <b>尚未生成成片</b>
                  <span>点击右侧“新建成片”，再从素材库拖入画面</span>
                </div>
              </div>
            </div>
            <footer class="player-controls" @click.stop>
              <div class="player-scrubber-visual" aria-hidden="true">
                <i ref="playerScrubberFill" />
                <b ref="playerScrubberThumb" />
              </div>
              <input
                ref="playerScrubber"
                class="player-scrubber"
                type="range"
                min="0"
                :max="Math.max(previewDuration, 0.001)"
                :step="1 / TIMELINE_FPS"
                :value="previewCurrentTime"
                aria-label="播放进度"
                @input="seekPreview(Number(($event.target as HTMLInputElement).value))"
              />
              <div class="player-control-left">
                <span ref="playerTimecode" class="player-time current">{{
                  formatPlayerTimecode(previewCurrentTime)
                }}</span>
                <span class="player-time-divider">/</span>
                <span class="player-time">{{ formatPlayerTimecode(previewDuration) }}</span>
                <span
                  class="player-audio-status"
                  role="status"
                  :title="previewHasAudibleTrack ? '声音监控：检测到声音' : '声音监控：当前无声音'"
                  :aria-label="
                    previewHasAudibleTrack ? '声音监控：检测到声音' : '声音监控：当前无声音'
                  "
                >
                  <span
                    class="player-audio-meter"
                    :class="{
                      active: previewHasAudibleTrack,
                      playing: previewHasAudibleTrack && previewIsPlaying,
                    }"
                    aria-hidden="true"
                  >
                    <i v-for="column in 3" :key="column">
                      <b
                        v-for="segment in 4"
                        :key="segment"
                        :class="{
                          lit: previewHasAudibleTrack && segment <= AUDIO_METER_LEVELS[column - 1]!,
                        }"
                      />
                    </i>
                  </span>
                </span>
              </div>
              <button
                class="player-play-button"
                type="button"
                :disabled="!auditionMaterial && !selectedVariant"
                :aria-label="
                  auditionMaterial
                    ? auditionPlaying
                      ? '暂停素材'
                      : '播放素材'
                    : playing
                      ? '暂停成片'
                      : '播放成片'
                "
                @pointerdown="onPreviewPlaybackPointerDown"
                @click="onPreviewPlaybackClick"
              >
                <Pause v-if="auditionMaterial ? auditionPlaying : playing" :size="19" />
                <Play v-else :size="19" />
              </button>
              <div class="player-control-right">
                <div class="player-menu-anchor">
                  <button
                    class="player-icon-button player-display-button"
                    type="button"
                    :title="`预览缩放 ${previewZoom}%`"
                    :aria-expanded="playerMenu === 'DISPLAY'"
                    @click="togglePlayerMenu('DISPLAY')"
                  >
                    <Focus :size="18" />
                  </button>
                  <div
                    v-if="playerMenu === 'DISPLAY'"
                    class="player-popover zoom-popover"
                    @click.stop
                  >
                    <button
                      class="zoom-step-button"
                      type="button"
                      title="缩小画面"
                      aria-label="缩小预览画面"
                      :disabled="previewZoom <= 25"
                      @click="adjustPreviewZoom(-5)"
                    >
                      <ZoomOut :size="17" />
                    </button>
                    <input
                      :value="previewZoom"
                      type="range"
                      min="25"
                      max="200"
                      step="5"
                      aria-label="预览画面缩放"
                      @input="setPreviewZoom(Number(($event.target as HTMLInputElement).value))"
                    />
                    <button
                      class="zoom-step-button"
                      type="button"
                      title="放大画面"
                      aria-label="放大预览画面"
                      :disabled="previewZoom >= 200"
                      @click="adjustPreviewZoom(5)"
                    >
                      <ZoomIn :size="17" />
                    </button>
                  </div>
                </div>
                <span
                  class="player-aspect-label"
                  title="画幅跟随当前素材，不可修改"
                  :aria-label="`当前素材画幅 ${sourceAspectLabel}`"
                  >{{ sourceAspectLabel }}</span
                >
                <button
                  class="player-icon-button"
                  type="button"
                  :title="playerFullscreen ? '退出全屏（F）' : '全屏预览（F）'"
                  :aria-label="playerFullscreen ? '退出全屏预览' : '进入全屏预览'"
                  @click="toggleFullscreen"
                >
                  <Minimize2 v-if="playerFullscreen" :size="18" />
                  <Maximize2 v-else :size="18" />
                </button>
              </div>
            </footer>
          </section>
          <div
            class="pane-resizer pane-resizer-right"
            role="separator"
            aria-label="调整成片项目宽度与列数"
            aria-orientation="vertical"
            :aria-valuenow="rightPaneWidth"
            title="左右拖动调整成片项目宽度与每行列数"
            @pointerdown="startPaneResize($event, 'RIGHT')"
          >
            <span />
          </div>
          <aside class="projects">
            <header>
              <div class="projects-title">
                <strong>成片项目</strong>
                <span class="project-count">{{ workspace.variants.length }} 个</span>
              </div>
              <small class="projects-subtitle">{{ variantTemplateLabel }} · 可精修成片</small>
              <div class="project-actions">
                <button
                  class="button compact"
                  type="button"
                  :disabled="
                    !selectedVariant ||
                    packagingPanel?.busy ||
                    packagingPanel?.active ||
                    packagingPanel?.loading ||
                    Boolean(packagingActionBlockReason)
                  "
                  :title="
                    packagingActionBlockReason ??
                    '为本模板下全部完整成片生成口播、配乐和字幕，将调用付费 AI 服务'
                  "
                  @click="openPackaging('ACTION')"
                >
                  <LoaderCircle
                    v-if="packagingPanel?.busy || packagingPanel?.active"
                    class="spin"
                    :size="13"
                  />
                  {{
                    packagingPanel?.busy || packagingPanel?.active
                      ? '成片包装中…'
                      : packagingActionLabel
                  }}
                </button>
                <button
                  class="button compact"
                  type="button"
                  title="查看智能成片包装真实任务进度"
                  @click="openPackaging('WORKFLOW')"
                >
                  <Workflow :size="13" />查看工作流
                </button>
                <button
                  class="button compact primary"
                  type="button"
                  :disabled="mutating || Boolean(activeAiRun)"
                  title="新建一个不包含任何素材的空成片工程"
                  @click="createEmptyVariant"
                >
                  <Plus :size="13" />新建成片
                </button>
              </div>
            </header>
            <div :class="{ 'is-empty': !workspace.variants.length }">
              <article
                v-for="(variant, index) in workspace.variants"
                :key="variant.id"
                v-memo="[
                  workspace.editVersion,
                  variant,
                  variant.id === selectedVariant?.id,
                  packagingReady,
                  packagingFailureByVariant.get(variant.id)?.message,
                  stalePackagingVariantIds.has(variant.id),
                ]"
                :class="{
                  active: variant.id === selectedVariant?.id,
                  failed: packagingFailureByVariant.has(variant.id),
                }"
                :title="`${variantDisplayName(variant, index)} · ${variantDuration(variant).toFixed(1)}s · ${
                  packagingFailureByVariant.get(variant.id)
                    ? `包装失败：${packagingFailureByVariant.get(variant.id)!.message}`
                    : variant.conflictSlotIds.length
                      ? variant.conflictSlotIds.length + ' 个缺口'
                      : '时间轴完整'
                } · ${
                  variant.status === 'PENDING'
                    ? '待同步'
                    : variant.conflictSlotIds.length
                      ? '待补齐'
                      : '可精修'
                }`"
                @click="selectVariant(variant.id)"
              >
                <span class="cover">
                  <EffectTemplateMixThumbnail
                    v-if="coverMaterial(variant)"
                    :source="coverMaterial(variant)!.contentUrl"
                    :version="`${coverMaterial(variant)!.artifactRevision}:${coverMaterial(variant)!.contentHash}`"
                    :alt="`${variantDisplayName(variant, index)} 封面`"
                  />
                  <b v-else>{{ String(index + 1).padStart(2, '0') }}</b>
                </span>
                <div class="project-card-info">
                  <b>{{ variantDisplayName(variant, index) }}</b>
                  <small
                    v-if="stalePackagingVariantIds.has(variant.id)"
                    class="project-expired-badge"
                    title="上游素材或时间轴已更新；现有成片仍可播放和编辑"
                  >
                    已过期
                  </small>
                  <small class="project-duration">{{ variantDuration(variant).toFixed(0) }}s</small>
                  <span
                    v-if="!stalePackagingVariantIds.has(variant.id)"
                    class="project-status"
                    :class="{
                      pending: variant.status === 'PENDING',
                      incomplete: variant.conflictSlotIds.length > 0,
                      failed: packagingFailureByVariant.has(variant.id),
                    }"
                    :title="
                      packagingFailureByVariant.get(variant.id)
                        ? `包装失败：${packagingFailureByVariant.get(variant.id)!.message}`
                        : variant.status === 'PENDING'
                          ? '待同步'
                          : variant.conflictSlotIds.length
                            ? '待补齐'
                            : '可精修'
                    "
                  />
                  <small
                    v-if="packagingFailureByVariant.has(variant.id)"
                    class="project-package-failure"
                  >
                    包装失败 · 将仅出画面
                  </small>
                </div>
              </article>
              <div v-if="!workspace.variants.length" class="project-empty">
                <Film :size="24" />
                <b>还没有成片工程</b>
                <span>点击“新建成片”创建空工程，再从素材库拖入需要的画面。</span>
              </div>
            </div>
          </aside>
        </div>
        <div
          v-if="selectedSlot && selectedVariant"
          class="slot-settings"
          :class="{ 'is-transition-only': selectedTransitionInfo }"
        >
          <b v-if="!selectedTransitionInfo">{{
            EFFECT_TEMPLATE_MIX_ROLE_LABELS[selectedSlot.role]
          }}</b
          ><span v-if="!selectedTransitionInfo" class="slot-readonly-control"
            ><span>时长</span><b>{{ selectedSlot.duration }}</b
            ><span>秒</span></span
          ><span v-if="!selectedTransitionInfo && selectedMaterial" class="slot-readonly-control"
            ><span>截取起点</span><b>{{ selectedVariant.offsets[selectedSlot.id] ?? 0 }}</b
            ><span>秒</span></span
          ><span v-if="!selectedTransitionInfo && selectedMaterial" class="trim-range"
            >截取 {{ (selectedVariant.offsets[selectedSlot.id] ?? 0).toFixed(1) }}s —
            {{
              ((selectedVariant.offsets[selectedSlot.id] ?? 0) + selectedSlot.duration).toFixed(1)
            }}s</span
          ><span
            v-if="!selectedTransitionInfo && selectedBindingMetadata?.source === 'AI'"
            class="ai-binding-note"
            :title="
              selectedBindingMetadata.classificationReason || selectedBindingMetadata.trimReason
            "
            ><Bot :size="12" />AI 匹配
            {{ selectedBindingMetadata.matchScore?.toFixed(2) ?? '—' }}</span
          ><span
            v-if="
              !selectedTransitionInfo &&
              selectedVariant.bindingMetadata?.[selectedSlot.id]?.matchLevel === 'LOW_MATCH'
            "
            class="low-match-note"
            :title="selectedVariant.bindingMetadata?.[selectedSlot.id]?.classificationReason"
            >低匹配补位</span
          ><span v-if="selectedTransitionInfo" class="transition-name"
            >转场：{{ selectedTransitionInfo.name }}</span
          ><label v-if="selectedTransitionInfo" class="transition-duration-control"
            >转场时长
            <input
              :value="selectedTransitionInfo.duration"
              type="range"
              min=".1"
              :max="selectedTransitionInfo.max"
              step=".1"
              @input="
                changeTransitionDuration(
                  selectedTransitionInfo.slotId,
                  ($event.target as HTMLInputElement).value,
                )
              "
            /><input
              :value="selectedTransitionInfo.duration.toFixed(1)"
              type="number"
              min=".1"
              :max="selectedTransitionInfo.max"
              step=".1"
              @change="
                changeTransitionDuration(
                  selectedTransitionInfo.slotId,
                  ($event.target as HTMLInputElement).value,
                )
              "
            />
            秒</label
          ><span v-if="!selectedTransitionInfo">{{
            pendingCount ? pendingCount + ' 个同模板工程待同步' : '模板工程已同步'
          }}</span>
        </div>
        <div
          class="editor-horizontal-resizer"
          :class="{ active: resizingEditorHeight }"
          role="separator"
          aria-label="调整预览区与时间轴高度"
          aria-orientation="horizontal"
          :aria-valuemin="220"
          :aria-valuemax="topPaneHeight + timelineHeight - 320"
          :aria-valuenow="timelineHeight"
          title="上下拖动调整预览区与时间轴占比"
          @pointerdown="startEditorHeightResize"
          @dblclick="resetEditorHeight"
        >
          <span />
        </div>
        <div class="editor-workflow-progress">
          <WorkflowRunProgress
            v-if="activeAiRun"
            class="mix-run-progress"
            :progress="activeAiRun.progress"
            :summary="aiStageLabels[activeAiRun.stage]"
            attempt-label="完成后自动把六个片段铺入当前视频轨"
            action-label="查看当前工作流"
            @show-details="openWorkflowDialog"
          />
          <EffectTemplateMixPackaging
            ref="packagingPanel"
            :project-id="projectId"
            :workflow-run-id="workflowRunId"
            :template-id="activeTemplateId"
            :variants="workspace.variants"
            :selected-variant-id="selectedVariant?.id ?? ''"
            :prepare="preparePackaging"
            :playhead="playhead"
            :seek-version="playbackSeekVersion"
            :playing="playing"
            :audio-row-muted="audioRowMuted"
            :audio-row-by-clip-id="audioRowByClipId"
            @selected="onPackagingSelected"
            @preview="packagingPreviewEnabled = $event"
            @ready="packagingReady = $event"
            @started="handlePackagingStarted"
            @status="packagingRunStatus = $event"
            @failures="packagingFailures = $event"
            @stale-variants="onStalePackagingVariants"
          />
        </div>
        <div v-if="editingCaption" class="caption-text-editor">
          <Captions :size="14" aria-hidden="true" />
          <span class="caption-text-time"
            >{{ formatEffectTemplateMixTime(editingCaption.start) }} —
            {{ formatEffectTemplateMixTime(editingCaption.end) }}</span
          >
          <input
            ref="captionTextInput"
            :value="editingCaption.text"
            :disabled="!captionTextEditable"
            maxlength="500"
            placeholder="输入字幕文本"
            aria-label="字幕文本"
            @input="changeCaptionText"
          />
          <span class="caption-font-size">
            <button
              type="button"
              aria-label="减小字号"
              :disabled="!captionEditable"
              @click="changeCaptionScale(-1)"
            >
              −
            </button>
            <span>字号 {{ captionFontSize }}</span>
            <button
              type="button"
              aria-label="增大字号"
              :disabled="!captionEditable"
              @click="changeCaptionScale(1)"
            >
              ＋
            </button>
            <!-- 用模板当前音色把这条字幕合成为一段新口播；不选音色，一键生成。 -->
            <button
              type="button"
              class="caption-voice-generate"
              :disabled="!captionVoiceReady"
              @click="generateCaptionVoice"
            >
              {{ captionVoiceBusy ? '生成中…' : '生成口播' }}
            </button>
          </span>
        </div>
        <div v-else-if="selectedCaptionIds.length > 1" class="caption-text-editor">
          <Captions :size="14" aria-hidden="true" />
          <span class="caption-text-time">已选中 {{ selectedCaptionIds.length }} 条字幕</span>
          <span class="caption-font-size">
            <button
              type="button"
              aria-label="减小字号"
              :disabled="!captionEditable"
              @click="changeCaptionScale(-1)"
            >
              −
            </button>
            <span>字号 {{ captionFontSize }}</span>
            <button
              type="button"
              aria-label="增大字号"
              :disabled="!captionEditable"
              @click="changeCaptionScale(1)"
            >
              ＋
            </button>
          </span>
        </div>
        <div v-else-if="audioStandard" class="audio-edit-row">
          <AudioLines :size="14" aria-hidden="true" />
          <span class="audio-edit-label">
            {{ audioStandard.kind === 'MUSIC' ? '纯音乐' : '口播' }}
            <template v-if="selectedAudioClipIds.length > 1">
              · 已选中 {{ selectedAudioClipIds.length }} 条
            </template>
          </span>
          <ParameterAdjustList
            class="audio-edit-params"
            :disabled="!captionEditable"
            :items="audioParamItems"
            :model-value="audioParamValues"
            @update:model-value="onAudioParamsChange"
          />
        </div>
        <!-- A stale item is passed through rather than nulled: its captions and voice/BGM blocks
             are the arrangement the user is looking at, and hiding them the moment a lane moves
             reads as "my materials vanished". The timeline marks them stale and keeps them
             read-only instead. -->
        <EffectTemplateMixTimeline
          ref="timelineRef"
          :template-id="activeTemplateId"
          :packaging="selectedPackaging"
          :read-only="projectEditLocked"
          :can-redo="canRedoTimeline && !projectEditLocked"
          :can-undo="canUndoTimeline && !projectEditLocked"
          :duration="currentDuration"
          :height="timelineHeight"
          :materials="workspace.materials"
          :playhead="playhead"
          :playing="playing"
          :project-id="projectId"
          :audio-row-muted="audioRowMuted"
          :video-muted="videoTrackMuted"
          :video-visible="videoTrackVisible"
          :caption-visible="captionTrackVisible"
          :selected-audio-clip-id="
            selectedCaptionId ? `caption:${selectedCaptionId}` : (selectedAudioClipIds[0] ?? null)
          "
          :selected-slot-id="selectedSlot?.id ?? ''"
          :variant="selectedVariant"
          @reorder-slot="moveProjectSlot"
          @change-audio-volume="changePackagingAudioVolume"
          @separate-audio="separateAudioForSlot"
          @paste-video-materials="pasteTimelineVideoMaterials"
          @paste-audio-material="pasteTimelineAudioMaterial"
          @request-notice="showNotice"
          @add-music-asset="addMusicAssetToTimeline"
          @move-audio-clip="movePackagingAudio"
          @move-audio-clips="movePackagingAudios"
          @resize-audio-clip="resizePackagingAudio"
          @move-clip="moveTimelineClip"
          @move-clips="moveTimelineClips"
          @assign-material="assignDroppedMaterial"
          @insert-material-track="insertMaterialTrack"
          @replace-audio-with-music="replaceAudioWithMusic"
          @split-caption-track="splitCaptionTrack"
          @move-caption-to-row="moveCaptionToRow"
          @apply-transition="changeTransitionForSlot"
          @open-transition="openTransitionPanel"
          @redo="redoTimelineEdit"
          @seek="seek"
          @select-audio-clip="onAudioClipSelected"
          @select-audio-clips="onAudioClipsSelected"
          @toggle-audio-mute="setTimelineTrackMute"
          @toggle-track-visibility="setTimelineTrackVisibility"
          @select-caption-clips="onCaptionClipsSelected"
          @select-slot="selectSlot"
          @trim-slot="changeTimelineTrimStart"
          @resize-slot="resizeTimelineSlot"
          @preview-transition-duration="previewTransitionDuration"
          @update-transition-duration="changeTransitionDuration"
          @undo="undoTimelineEdit"
        />
      </section>
      <WorkflowNodeDraftBar
        v-if="workspace"
        title="混剪模板与时间轴草稿"
        :detail="
          '当前模板：' +
          workspace.template.name +
          ' · ' +
          workspace.variants.length +
          ' 个工程' +
          (pendingCount ? ' · ' + pendingCount + ' 个待同步' : '')
        "
        :state="saveState"
        :state-label="
          saveState === 'saving'
            ? '正在自动保存…'
            : saveState === 'dirty'
              ? '有未保存修改'
              : '草稿已保存'
        "
      />
      <WorkflowNodeFooter
        v-if="view === 'EDITOR' && workspace"
        back-label="上一步"
        :complete="validated && packagingReady"
        :status-title="validateStatusTitle"
        :status-detail="'步骤 5 / 6 · ' + workspace.template.name"
        :validate-disabled="!canValidate"
        :validating="validating"
        :next-disabled="!validated || validating"
        next-label="下一步：成片输出"
        validate-label="完成校验"
        :show-next="false"
        @back="emit('back')"
        @validate="validateDraft"
        @next="emit('next')"
      />
    </template>
    <Teleport to="body"
      ><div v-if="createOpen" class="mask" @mousedown.self="closeCreate">
        <section class="modal" role="dialog" aria-modal="true" aria-labelledby="mix-create-title">
          <header>
            <div>
              <h3 id="mix-create-title">新建独立混剪模板</h3>
              <p>新模板拥有独立槽位和成片工程空间。</p>
            </div>
            <button aria-label="关闭新建模板弹窗" @click="closeCreate"><X :size="18" /></button>
          </header>
          <main>
            <label
              >模板名称<input
                ref="createNameInput"
                v-model="newTemplateName"
                maxlength="40"
                :aria-invalid="createTemplateNameConflict"
                @keydown.enter="submitTemplateOnEnter"
            /></label>
            <p v-if="createTemplateNameConflict" class="name-conflict" role="alert">
              当前工作流已有同名模板，请修改名称后再创建。
            </p>
            <p v-else>成片时长由各槽位时长实时累加。</p>
          </main>
          <footer>
            <button type="button" class="button" @click="closeCreate">取消</button>
            <button
              type="button"
              class="button primary modal-submit"
              :disabled="!newTemplateName.trim() || createTemplateNameConflict"
              @click="addTemplate"
            >
              <Plus :size="14" />创建模板
            </button>
          </footer>
        </section>
      </div>
      <div
        v-if="promptMaterial"
        class="mask material-prompt-mask"
        @mousedown.self="closeMaterialPrompt"
      >
        <section
          class="modal material-prompt-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="mix-material-prompt-title"
          @keydown.esc="closeMaterialPrompt"
        >
          <header>
            <div>
              <h3 id="mix-material-prompt-title">素材来源 Prompt</h3>
              <p>
                {{ promptMaterial.name }} · {{ promptMaterial.promptCode || promptMaterial.code }}
              </p>
            </div>
            <button
              ref="promptCloseButton"
              type="button"
              aria-label="关闭素材 Prompt"
              @click="closeMaterialPrompt"
            >
              <X :size="18" />
            </button>
          </header>
          <main>
            <EffectSegmentRenderSourcePrompt
              :prompt-text="promptMaterial.promptText || '暂无 Prompt 原文'"
              :heading="promptMaterial.promptCreativeCore ? '来源 Prompt' : ''"
            />
            <p v-if="promptMaterial.promptCreativeCore" class="material-prompt-core">
              <strong>创意方向</strong>{{ promptMaterial.promptCreativeCore }}
            </p>
          </main>
          <footer>
            <button type="button" class="button" @click="closeMaterialPrompt">关闭</button>
          </footer>
        </section>
      </div>
      <div
        v-if="slotMoveMaterial && selectedVariant"
        class="mask material-slot-mask"
        @mousedown.self="closeMaterialSlotPicker"
      >
        <section
          class="modal material-slot-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="mix-material-slot-title"
          @keydown.esc="closeMaterialSlotPicker"
        >
          <header>
            <div>
              <h3 id="mix-material-slot-title">更换素材槽位</h3>
              <p>
                {{ slotMoveMaterial.name }} 当前位于
                {{ slotMoveSourceLabel }}
              </p>
            </div>
            <button
              ref="slotMoveCloseButton"
              type="button"
              aria-label="关闭素材槽位选择"
              @click="closeMaterialSlotPicker"
            >
              <X :size="18" />
            </button>
          </header>
          <main class="material-slot-options">
            <button
              v-for="option in slotMoveOptions"
              :key="option.slot.id"
              type="button"
              :disabled="option.materialId === slotMoveMaterial.id"
              @click="chooseMaterialSlot(option.slot.id)"
            >
              <span>
                <strong>{{ option.slot.label }}</strong>
                <small>{{ option.materialId ? '已有素材，将交换槽位' : '空槽位' }}</small>
              </span>
              <ArrowLeft :size="14" />
            </button>
          </main>
          <footer>
            <button type="button" class="button" @click="closeMaterialSlotPicker">取消</button>
          </footer>
        </section>
      </div>
      <div
        v-if="workflowDialogOpen"
        class="mask workflow-graph-backdrop"
        @mousedown.self="closeWorkflowDialog"
      >
        <section
          class="modal workflow-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="mix-workflow-title"
        >
          <header>
            <div class="workflow-graph-title">
              <span>TEMPLATE MIX WORKFLOW</span>
              <h2 id="mix-workflow-title">智能填充工作流</h2>
              <p>展示本次真实的 Prompt 归槽、素材匹配、视频抽帧、AI 截取与时间轴结果。</p>
            </div>
            <button
              ref="workflowCloseButton"
              class="workflow-graph-close"
              aria-label="关闭当前工作流弹窗"
              @click="closeWorkflowDialog"
            >
              <X :size="18" />
            </button>
          </header>
          <main class="workflow-graph-content">
            <div class="workflow-graph-canvas" aria-label="智能填充执行图">
              <template v-for="(stage, index) in aiStageOrder" :key="stage">
                <div v-if="index" class="workflow-connector" aria-hidden="true"><i /></div>
                <button
                  class="workflow-graph-node"
                  :class="`is-${workflowStageTone(stage)}`"
                  type="button"
                  :aria-pressed="selectedWorkflowStage === stage"
                  @click="selectedWorkflowStage = stage"
                >
                  <span class="workflow-node-dot" />
                  <span>
                    <strong>{{ aiStageLabels[stage] }}</strong>
                    <small>{{ aiStageDescriptions[stage] }}</small>
                    <small class="workflow-node-progress">
                      处理进度 {{ workflowStageProgress(stage) }}
                    </small>
                  </span>
                  <em>{{ workflowStageStatusLabel(stage) }}</em>
                </button>
              </template>
            </div>
            <aside class="workflow-node-detail" aria-live="polite">
              <div v-if="!selectedWorkflowStage" class="workflow-node-detail-empty">
                <Workflow :size="30" />
                <strong>选择节点查看真实状态</strong>
                <p v-if="workflowRunForDisplay">
                  展示当前任务所处阶段，同时隐藏模型指令、Prompt 原文和内部标识。
                </p>
                <p v-else>当前工程尚无执行产物；运行智能填充后，这里会显示真实阶段状态。</p>
              </div>
              <template v-else>
                <header class="workflow-node-detail-header">
                  <div>
                    <span>NODE DETAIL</span>
                    <strong>{{ aiStageLabels[selectedWorkflowStage] }}</strong>
                  </div>
                </header>
                <div class="workflow-node-detail-status">
                  <em :class="`is-${workflowStageTone(selectedWorkflowStage)}`">
                    {{ workflowStageStatusLabel(selectedWorkflowStage) }}
                  </em>
                  <span v-if="workflowRunForDisplay">
                    <small>本节点处理进度</small>
                    <b>{{ workflowStageProgress(selectedWorkflowStage) }}</b>
                  </span>
                </div>
                <p class="workflow-node-summary">
                  {{ aiStageDescriptions[selectedWorkflowStage] }}
                </p>
                <section class="workflow-detail-block is-input">
                  <span>INPUT</span>
                  <strong>本阶段实际输入（最多展示 4 项）</strong>
                  <p>{{ aiStageInputs[selectedWorkflowStage] }}</p>
                  <ul v-if="workflowStageDetail(selectedWorkflowStage)?.inputSamples.length">
                    <li
                      v-for="(sample, sampleIndex) in workflowStageDetail(selectedWorkflowStage)
                        ?.inputSamples"
                      :key="`input-${sampleIndex}`"
                    >
                      {{ sample }}
                    </li>
                  </ul>
                </section>
                <section class="workflow-detail-block is-output">
                  <span>OUTPUT</span>
                  <strong>本阶段实际结果（最多展示 4 项）</strong>
                  <p>{{ aiStageOutputs[selectedWorkflowStage] }}</p>
                  <ul v-if="workflowStageDetail(selectedWorkflowStage)?.outputSamples.length">
                    <li
                      v-for="(sample, sampleIndex) in workflowStageDetail(selectedWorkflowStage)
                        ?.outputSamples"
                      :key="`output-${sampleIndex}`"
                    >
                      {{ sample }}
                    </li>
                  </ul>
                </section>
                <section class="workflow-detail-block is-boundary">
                  <span>BOUNDARY</span>
                  <strong>节点职责边界</strong>
                  <p>
                    只生成可精修的时间轴工程，不渲染最终视频；确认后的时间轴交给下一步“成片输出”。
                  </p>
                </section>
              </template>
            </aside>
          </main>
          <footer>
            <span><i class="running" />执行中</span>
            <span><i class="success" />已完成</span>
            <span><i />等待中</span>
            <span><i class="danger" />失败</span>
            <span class="workflow-edge-count">4 条执行边</span>
          </footer>
        </section>
      </div></Teleport
    >
  </section>
</template>

<style scoped>
.mix-node {
  --blue: #2563eb;
  margin-top: 14px;
  padding: 10px;
  color: #17233a;
  background: linear-gradient(180deg, #f7faff 0%, #f2f6fb 100%);
  border: 1px solid #dbe4f2;
  border-radius: 18px;
}
.panel {
  min-width: 0;
  background: #fff;
  border: 1px solid #dce5f0;
  border-radius: 14px;
  overflow: hidden;
}
.button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 36px;
  padding: 0 14px;
  color: #334155;
  background: #fff;
  border: 1px solid #cfd9e8;
  border-radius: 8px;
  font-weight: 700;
  cursor: pointer;
}
.primary {
  color: #fff;
  background: var(--blue, #2563eb);
  border-color: var(--blue, #2563eb);
}
button:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}
.compact {
  height: 28px;
  padding: 0 9px;
}
.workbench-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 4px 16px;
}
.config-head {
  display: flex;
  min-height: 50px;
  margin-bottom: 18px;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  padding: 0 2px;
}
.config-head__title {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 14px;
}
.config-head__title > span {
  display: grid;
  width: 44px;
  height: 44px;
  flex: 0 0 44px;
  place-items: center;
  color: #d67b16;
  background: #fff5e7;
  border-radius: 14px;
  font-size: 13px;
  font-weight: 900;
}
.config-head__title > div,
.current {
  flex: 1;
}
.config-head h1,
.config-head p {
  margin: 0;
}
.config-head h1 {
  color: #172033;
  font-size: 21px;
}
.config-head p {
  margin-top: 5px;
  color: #7d899d;
  font-size: 13px;
}
.config-head__actions {
  display: flex;
  margin-left: auto;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
}
.page-state p {
  margin: 0;
  color: #64748b;
  font-size: 13px;
}
.page-state {
  display: grid;
  justify-items: center;
  align-content: center;
  gap: 10px;
  min-height: 320px;
  background: #fff;
  border: 1px solid #dce5f0;
  border-radius: 14px;
  text-align: center;
}
.error {
  color: #b42318;
}
.spin {
  animation: spin 1s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
.config-layout {
  display: grid;
  grid-template-columns: 220px minmax(0, 1fr);
  gap: 10px;
}
.template-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 15px;
}
.template-list h2 {
  margin: 0;
}
.template-list > button:not(.button) {
  display: flex;
  gap: 8px;
  padding: 10px;
  text-align: left;
  background: #fff;
  border: 1px solid #dce5f0;
  border-radius: 8px;
}
.template-list > button.active {
  color: #1d4ed8;
  background: #eff6ff;
  border-color: #93c5fd;
}
.template-list span {
  display: grid;
  gap: 3px;
}
.template-list small {
  color: #64748b;
  font-size: 10px;
}
.new-template {
  margin-top: auto;
}
.config-panel {
  padding: 14px;
  box-shadow: 0 4px 14px rgb(30 64 175 / 4%);
}
.template-lock-banner {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 12px 0 0;
  padding: 9px 11px;
  color: #82550f;
  background: #fff8e8;
  border: 1px solid #f2d69b;
  border-radius: 8px;
  font-size: 12px;
}
.config-panel > header,
.config-panel > footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.config-panel h2 {
  margin: 0;
}
.config-panel p {
  margin: 3px 0;
  color: #64748b;
  font-size: 12px;
}
.config-panel > header > span {
  padding: 7px 9px;
  color: #475569;
  background: #f8fbff;
  border: 1px solid #e2e8f0;
  border-radius: 999px;
  font-size: 12px;
  white-space: nowrap;
}
.config-panel > header b {
  color: #1d4ed8;
}
.name-field {
  display: grid;
  gap: 5px;
  margin: 12px 0 10px;
  font-size: 12px;
  font-weight: 700;
}
.name-conflict {
  color: #dc2626 !important;
  font-size: 12px;
  font-weight: 600;
}
.name-field input,
.slot-row input,
.slot-row select,
.slot-settings input,
.slot-settings select,
.modal input {
  height: 34px;
  padding: 0 9px;
  border: 1px solid #cfd9e8;
  border-radius: 7px;
}
.slot-table {
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  overflow: hidden;
  background: #fff;
}
.slot-heading,
.slot-row {
  display: grid;
  grid-template-columns: minmax(210px, 1.3fr) minmax(160px, 1fr) 92px 110px;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
}
.slot-heading {
  color: #64748b;
  background: #f8fafc;
  font-size: 11px;
  font-weight: 700;
}
.slot-row {
  border-top: 1px solid #edf1f6;
}
.slot-row:hover {
  background: #fbfdff;
}
.slot-name {
  display: flex;
  align-items: center;
  gap: 6px;
}
.slot-name > b {
  display: grid;
  place-items: center;
  width: 23px;
  height: 23px;
  color: #1d4ed8;
  background: #dbeafe;
  border-radius: 7px;
  font-size: 12px;
}
.slot-name span {
  flex: 1;
  font-size: 12px;
  font-weight: 700;
}
.slot-name button {
  width: 23px;
  height: 23px;
  background: #fff;
  border: 1px solid #dce5f0;
  border-radius: 5px;
  color: #475569;
}
.slot-row code {
  color: #64748b;
  font-size: 11px;
}
.slot-transition-empty {
  color: #94a3b8;
  font-size: 18px;
  text-align: center;
}
.config-panel > footer {
  margin-top: 11px;
  padding-top: 2px;
}
.warning {
  color: #b45309 !important;
}
.workbench-head {
  padding: 12px 16px;
  border-bottom: 1px solid #e2e8f0;
  background: #fff;
}
.brand {
  display: flex;
  align-items: center;
  gap: 8px;
}
.brand > span {
  display: grid;
  place-items: center;
  width: 31px;
  height: 31px;
  color: #fff;
  background: #2563eb;
  border-radius: 8px;
  font-weight: 900;
}
.brand div,
.current {
  display: grid;
}
.brand small,
.current span {
  color: #64748b;
  font-size: 10px;
}
.workbench-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.workflow-graph-trigger {
  color: #1d4ed8;
  border-color: #bfdbfe;
  background: #eff6ff;
}
.mix-run-progress {
  margin: 0;
  border-width: 0 0 1px;
  border-radius: 0;
}
.current {
  text-align: center;
}
.workbench-main {
  display: grid;
  grid-template-columns: 480px 7px minmax(380px, 1fr) 7px 270px;
  height: 480px;
}
.workbench-main > * {
  min-height: 0;
}
.workbench-main.is-resizing,
.workbench-main.is-resizing * {
  cursor: col-resize !important;
  user-select: none !important;
}
.pane-resizer {
  position: relative;
  z-index: 12;
  background: #f5f8fc;
  border-right: 1px solid #dbe4f0;
  border-left: 1px solid #dbe4f0;
  cursor: col-resize;
  touch-action: none;
}
.pane-resizer span {
  width: 2px;
  height: 34px;
  position: absolute;
  top: 50%;
  left: 50%;
  background: #b7c5d8;
  border-radius: 999px;
  transform: translate(-50%, -50%);
}
.pane-resizer:hover,
.workbench-main.is-resizing .pane-resizer {
  background: #eaf2ff;
  border-color: #9fc0f5;
}
.pane-resizer:hover span,
.workbench-main.is-resizing .pane-resizer span {
  background: #2563eb;
}
.resources {
  display: flex;
  min-height: 0;
  flex-direction: column;
  overflow: hidden;
  background: #fff;
}
.resource-tabs {
  display: flex;
  align-items: stretch;
  justify-content: flex-start;
  overflow-x: auto;
  overflow-y: hidden;
  border-bottom: 1px solid #e2e8f0;
}
.resource-tabs button {
  flex: 0 1 86px;
  min-width: 54px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 3px;
  padding: 9px 3px;
  color: #64748b;
  background: #f8fafc;
  border: 0;
}
.resource-tabs button.active {
  color: #2563eb;
  background: #fff;
}
.resource-tabs button:disabled {
  color: #a8b3c4;
  cursor: not-allowed;
}
.resources > header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
}
.resources > header small {
  color: #64748b;
  font-size: 10px;
}
.search {
  display: flex;
  align-items: center;
  gap: 5px;
  margin: 10px 12px 8px;
  padding: 0 8px;
  border: 1px solid #dce5f0;
  border-radius: 7px;
}
.search input {
  width: 100%;
  height: 29px;
  border: 0;
  outline: 0;
}
.material-role-filters {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  flex: none;
  gap: 5px;
  margin: 0 12px 8px;
}
.material-role-filters button {
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 0;
  gap: 4px;
  min-height: 25px;
  padding: 0 4px;
  border: 1px solid #dce5f0;
  border-radius: 5px;
  color: #52647e;
  background: #fff;
  font-size: 9px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  cursor: pointer;
}
.material-role-filters button.active {
  border-color: #8bb7ff;
  color: #1d4ed8;
  background: #eff6ff;
}
.material-role-filters small {
  color: inherit;
  font-size: 8px;
}
.material-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(142px, 1fr));
  grid-auto-rows: 122px;
  align-content: start;
  min-height: 0;
  flex: 1;
  gap: 8px;
  overflow: auto;
  padding: 0 12px 12px;
}
.material-grid article {
  display: grid;
  grid-template-rows: 72px 1fr;
  min-height: 0;
  overflow: hidden;
  border: 1px solid #dce5f0;
  border-radius: 10px;
  background: #fff;
  cursor: pointer;
  transition:
    border-color 0.16s ease,
    box-shadow 0.16s ease,
    transform 0.16s ease;
}
.material-grid article:hover {
  border-color: #93c5fd;
  box-shadow: 0 6px 16px #1d4ed81a;
  transform: translateY(-1px);
}
.material-grid article.disabled {
  cursor: default;
}
.material-grid article.disabled:hover {
  border-color: #dce5f0;
  box-shadow: none;
  transform: none;
}
.material-grid article.selected {
  border-color: #2563eb;
  box-shadow: 0 0 0 1px #2563eb;
}
.material-grid article.used:not(.selected) {
  border-color: #b9c9df;
  background: #f8fafc;
}
.material-expired-banner {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 12px 8px;
  padding: 7px 9px;
  color: #82550f;
  background: #fff8e8;
  border: 1px solid #f2d69b;
  border-radius: 8px;
  font-size: 11px;
  line-height: 1.35;
}
.material-expired-banner svg {
  flex: none;
}
.material-grid article.dragging {
  border-color: #2563eb;
  box-shadow: 0 0 0 2px #bfdbfe;
  opacity: 0.58;
  transform: scale(0.98);
}
.thumb {
  position: relative;
  height: 72px;
  overflow: hidden;
  background: #e8eef6;
}
.thumb :deep(img) {
  /* Firefox otherwise starts a native image drag before the card handler can
     install its tiny cross-browser drag image. */
  pointer-events: none;
}
.material-drag-ghost {
  position: fixed;
  z-index: 1000;
  width: max-content;
  max-width: 180px;
  padding: 6px 9px;
  border: 1px solid #93c5fd;
  border-radius: 6px;
  color: #1d4ed8;
  background: #eff6ff;
  box-shadow: 0 8px 18px #1e3a8a24;
  font-size: 11px;
  font-weight: 700;
  pointer-events: none;
  user-select: none;
  white-space: nowrap;
}
.thumb svg {
  position: absolute;
  top: 28px;
  left: calc(50% - 8px);
  color: #fff;
}
.thumb small {
  position: absolute;
  right: 4px;
  bottom: 4px;
  padding: 2px 4px;
  color: #fff;
  background: #0009;
}
.material-copy {
  display: grid;
  align-content: center;
  min-width: 0;
  padding: 5px 7px 6px;
}
.material-name-row {
  display: flex;
  align-items: center;
  min-width: 0;
  gap: 4px;
}
.material-name-row b {
  min-width: 0;
  flex: 1;
}
.material-ai-role {
  flex: none;
  max-width: 52px;
  overflow: hidden;
  padding: 1px 4px;
  border-radius: 4px;
  color: #1d4ed8;
  background: #eaf2ff;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 8px;
  font-weight: 700;
}
.material-ai-role.low {
  color: #a45318;
  background: #fff1dc;
}
.material-copy b {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 10px;
}
.material-card-actions {
  display: flex;
  min-width: 0;
  gap: 4px;
  margin-top: 3px;
}
.material-action {
  min-width: 0;
  flex: 1;
  height: 20px;
  padding: 0 4px;
  overflow: hidden;
  color: #52647e;
  background: #f8fafc;
  border: 1px solid #dce5f0;
  border-radius: 4px;
  font-size: 8px;
  font-weight: 700;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}
.material-action-primary {
  color: #1d4ed8;
  background: #eff6ff;
  border-color: #bfdbfe;
}
.material-action:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}
.material-pagination {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  flex: none;
  min-height: 36px;
  border-top: 1px solid #e2e8f0;
  color: #64748b;
  font-size: 10px;
}
.material-pagination button {
  height: 24px;
  padding: 0 8px;
  color: #475569;
  background: #fff;
  border: 1px solid #dce5f0;
  border-radius: 7px;
}
.material-prompt-modal {
  width: min(640px, calc(100vw - 32px));
}
.material-prompt-modal main {
  min-height: 0;
  max-height: min(62vh, 540px);
  overflow: auto;
}
.material-prompt-modal :deep(.source-prompt-content) {
  max-height: 360px;
  margin-top: 4px;
}
.material-prompt-core {
  margin: 0;
  padding: 10px 12px;
  color: #42526a;
  background: #f4f8ff;
  border: 1px solid #cfe0ff;
  border-radius: 8px;
  font-size: 11px;
  line-height: 1.6;
}
.material-prompt-core strong {
  display: block;
  margin-bottom: 3px;
  color: #2f6fed;
}
.material-slot-modal {
  width: min(480px, calc(100vw - 32px));
}
.material-slot-options {
  display: grid;
  gap: 7px;
  max-height: min(52vh, 380px);
  overflow: auto;
}
.material-slot-options > button {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-height: 48px;
  padding: 8px 11px;
  color: #334155;
  text-align: left;
  background: #fff;
  border: 1px solid #dce5f0;
  border-radius: 8px;
  cursor: pointer;
}
.material-slot-options > button:hover:not(:disabled) {
  color: #1d4ed8;
  background: #eff6ff;
  border-color: #93c5fd;
}
.material-slot-options > button:disabled {
  color: #94a3b8;
  background: #f8fafc;
}
.material-slot-options span {
  display: grid;
  gap: 3px;
}
.material-slot-options small {
  color: #7b8aa0;
  font-size: 9px;
}
.resource-empty {
  display: grid;
  place-items: center;
  align-content: center;
  gap: 7px;
  padding: 30px;
  color: #64748b;
  text-align: center;
  font-size: 11px;
}
.transition-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  padding: 12px;
}
.transition-grid button {
  height: 38px;
  background: #fff;
  border: 1px solid #dce5f0;
  border-radius: 7px;
}
.transition-grid button.active {
  color: #1d4ed8;
  background: #eff6ff;
  border-color: #93c5fd;
}
.transition-search {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 0 0 12px;
  padding: 0 9px;
  height: 32px;
  border: 1px solid #dce5f0;
  border-radius: 7px;
  color: #7890ae;
  background: #fff;
}
.transition-search input {
  min-width: 0;
  flex: 1;
  border: 0;
  outline: 0;
  color: #304c70;
  background: transparent;
  font-size: 11px;
}
.transition-search input::placeholder {
  color: #9aabc0;
}
.transition-browser {
  display: flex;
  min-height: 0;
  flex: 1;
  overflow: hidden;
  background: #f5f8fc;
}
.transition-categories {
  width: 100px;
  flex: none;
  overflow: auto;
  padding: 9px 7px 12px;
  border-right: 1px solid #dce5f0;
  background: #f5f8fc;
}
.transition-category-title,
.transition-category {
  width: 100%;
  min-height: 38px;
  padding: 0 4px;
  border: 0;
  border-radius: 0;
  color: #607895;
  background: transparent;
  text-align: left;
  font-size: 11px;
  white-space: nowrap;
}
.transition-category-title {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-bottom: 5px;
  color: #2563eb;
  font-weight: 700;
  cursor: pointer;
}
.transition-category-title span {
  color: #2563eb;
  font-size: 10px;
}
.transition-category-toggle {
  display: inline-flex;
  width: 10px;
  justify-content: center;
  transition: transform 140ms ease;
}
.transition-category-toggle.expanded {
  transform: rotate(90deg);
}
.transition-category-list {
  display: flex;
  flex-direction: column;
}
.transition-category {
  margin-top: 2px;
  cursor: pointer;
}
.transition-category:hover:not(:disabled),
.transition-category.active {
  color: #2563eb;
  background: transparent;
}
.transition-category:disabled {
  color: #7890ae;
  cursor: default;
}
.transition-library {
  min-height: 0;
  flex: 1;
  overflow: auto;
  padding: 10px 12px 14px;
  color: #294668;
  background: #f8fafc;
}
.transition-library h4 {
  margin: 0 0 9px;
  color: #294668;
  font-size: 12px;
}
.transition-card-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 9px;
}
.transition-card {
  min-width: 0;
  padding: 0 0 6px;
  overflow: hidden;
  border: 1px solid #dce5f0;
  border-radius: 7px;
  color: #4c6687;
  background: #fff;
  text-align: left;
  cursor: pointer;
}
.transition-card:hover {
  border-color: #93b7ee;
  background: #f8fbff;
}
.transition-card.active {
  border-color: #2563eb;
  box-shadow: 0 0 0 1px #2563eb33;
}
.transition-preview {
  display: grid;
  place-items: center;
  height: 70px;
  margin-bottom: 5px;
  overflow: hidden;
  color: #fff;
  font-size: 21px;
  font-style: normal;
}
.transition-preview.is-dissolve {
  background: linear-gradient(90deg, #657889, #ecf2f4 50%, #445565);
}
.transition-preview.is-push {
  background: linear-gradient(120deg, #405a76 0 40%, #d8e7f2 40% 56%, #849ab0 56%);
}
.transition-preview.is-flash {
  background: radial-gradient(circle, #fff 0 12%, #ffe8a8 30%, #4b5f77 76%);
}
.transition-preview.is-zoom {
  background: radial-gradient(circle, #f1d6ba 0 14%, #6283a0 38%, #273747 78%);
}
.transition-preview.is-slide-left {
  background: linear-gradient(90deg, #d8e7f2 0 48%, #506b86 48% 100%);
}
.transition-preview.is-slide-up {
  background: linear-gradient(0deg, #d8e7f2 0 48%, #506b86 48% 100%);
}
.transition-preview.is-wipe {
  background: linear-gradient(110deg, #506b86 0 42%, #edf4f8 42% 62%, #a3b7c8 62% 100%);
}
.transition-preview.is-circle {
  background: radial-gradient(circle, #f5f8fb 0 25%, #506b86 27% 100%);
}
.transition-preview.is-flip {
  background: linear-gradient(90deg, #334a63 0 48%, #dce8f0 48% 52%, #8ca3b6 52%);
}
.transition-preview.is-blur {
  background: radial-gradient(circle at 65% 38%, #eef5f7 0 18%, #a4b7c5 32%, #40566b 85%);
}
.transition-preview.is-slide-right {
  background: linear-gradient(90deg, #506b86 0 48%, #d8e7f2 48% 100%);
}
.transition-preview.is-slide-down {
  background: linear-gradient(0deg, #506b86 0 48%, #d8e7f2 48% 100%);
}
.transition-preview.is-rotate {
  background: conic-gradient(from 45deg, #d8e7f2, #506b86, #d8e7f2, #506b86, #d8e7f2);
}
.transition-preview.is-blinds {
  background: repeating-linear-gradient(90deg, #506b86 0 9px, #d8e7f2 9px 13px);
}
.transition-preview.is-diamond {
  background: linear-gradient(45deg, #506b86 0 49%, #d8e7f2 49% 51%, #506b86 51%);
  clip-path: polygon(50% 0, 100% 50%, 50% 100%, 0 50%);
}
.transition-preview.is-pixel {
  background:
    repeating-linear-gradient(0deg, #506b86 0 8px, #7f98ad 8px 10px),
    repeating-linear-gradient(90deg, transparent 0 8px, #d8e7f2 8px 10px);
  background-blend-mode: screen;
}
.transition-preview.is-glitch {
  background: repeating-linear-gradient(0deg, #ef476f 0 7px, #273747 7px 13px, #22d3ee 13px 18px);
}
.transition-preview.is-chromatic {
  background: linear-gradient(90deg, #ef4444 0 35%, #506b86 35% 65%, #22d3ee 65%);
}
.transition-preview.is-ripple {
  background: radial-gradient(
    circle,
    transparent 0 12%,
    #d8e7f2 14% 19%,
    transparent 21% 29%,
    #506b86 31% 100%
  );
}
.transition-preview.is-black-flash {
  background: radial-gradient(circle, #506b86 0 18%, #05070b 20% 54%, #d8e7f2 56%);
}
.transition-preview.is-shrink {
  background: radial-gradient(circle, #d8e7f2 0 27%, #506b86 29% 100%);
}
.transition-preview.is-circle-spread {
  background: radial-gradient(circle, #d8e7f2 0 22%, #506b86 24% 100%);
}
.transition-preview.is-linear-wipe {
  background: linear-gradient(105deg, #d8e7f2 0 46%, #506b86 47% 100%);
}
.transition-preview.is-four-corners {
  background: radial-gradient(circle, #d8e7f2 0 34%, #506b86 36% 100%);
  clip-path: inset(4% round 12px);
}
.transition-preview.is-split {
  background: linear-gradient(90deg, #506b86 0 46%, #d8e7f2 46% 54%, #506b86 54% 100%);
}
.transition-preview.is-mirror {
  background: linear-gradient(135deg, #506b86 0 48%, #d8e7f2 49% 51%, #506b86 52% 100%);
}
.transition-preview.is-page-turn {
  background: linear-gradient(90deg, #d8e7f2 0 48%, #506b86 50% 100%);
  transform: perspective(180px) rotateY(-12deg);
}
.transition-preview.is-cube {
  background: linear-gradient(90deg, #506b86 0 48%, #d8e7f2 48% 52%, #40566b 52% 100%);
  transform: perspective(180px) rotateY(-10deg);
}
.transition-preview.is-zoom-blur {
  background: radial-gradient(circle at 55% 42%, #d8e7f2 0 19%, #8199ac 39%, #506b86 78%);
  filter: blur(0.4px);
}
.transition-preview.is-color-flash {
  background: linear-gradient(
    110deg,
    #506b86 0 22%,
    #f472b6 35%,
    #fef08a 50%,
    #67e8f9 65%,
    #506b86 82%
  );
}
.transition-preview.is-noise-dissolve {
  background:
    radial-gradient(circle at 25% 35%, #d8e7f2 0 3px, transparent 4px),
    radial-gradient(circle at 70% 65%, #273747 0 3px, transparent 4px), #506b86;
  background-size:
    18px 18px,
    23px 23px,
    auto;
}
.transition-preview.is-liquid {
  background: radial-gradient(ellipse at 45% 52%, #d8e7f2 0 18%, #8da3b6 38%, #506b86 72%);
  border-radius: 42% 58% 55% 45% / 48% 42% 58% 52%;
}
.transition-preview.is-diagonal-wipe {
  background: linear-gradient(135deg, #d8e7f2 0 46%, #506b86 47% 100%);
}
.transition-preview.is-cut {
  background: linear-gradient(90deg, #506072 0 48%, #16181d 48% 52%, #a0b2bf 52%);
}
.transition-card strong,
.transition-card small {
  display: block;
  overflow: hidden;
  padding: 0 7px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.transition-card strong {
  color: #294668;
  font-size: 11px;
}
.transition-card small {
  margin-top: 2px;
  color: #7890ae;
  font-size: 9px;
}
.transition-duration-control {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.transition-duration-control input[type='range'] {
  width: 90px;
  accent-color: #2563eb;
}
.transition-duration-control input[type='number'] {
  width: 52px;
}
.player-panel {
  position: relative;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  min-width: 0;
  min-height: 0;
  padding: 0;
  overflow: hidden;
  color: #334155;
  background: #eef2f7;
}
.player-panel > header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 36px;
  padding: 0 12px;
  color: #64748b;
  font-size: 10px;
}
.player-panel > header strong {
  color: #334155;
}
.stage-space {
  min-width: 0;
  min-height: 0;
  padding: 10px 14px;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  background: #eef2f7;
}
.stage-space.is-zoomed {
  overflow: auto;
}
.stage {
  position: relative;
  display: grid;
  place-items: center;
  width: auto;
  max-width: 100%;
  min-width: 0;
  min-height: 0;
  height: 100%;
  max-height: 100%;
  overflow: hidden;
  background: #05070b;
  border-radius: 6px;
  box-shadow: 0 0 0 1px #d7deea;
  transform-origin: center;
  transition: transform 160ms ease;
}
.stage.landscape {
  width: 100%;
  height: auto;
}
.player-transition-frame {
  position: absolute;
  z-index: 3;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  pointer-events: none;
}
.player-transition-overlay {
  position: absolute;
  z-index: 4;
  inset: 0;
  pointer-events: none;
}
.stage video {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  background: transparent;
  opacity: 0;
  pointer-events: none;
}
.stage video.is-visible {
  z-index: 2;
  opacity: 1;
}
/* Mirrors the burned-in ASS subtitle: the box is the wrap width, so stretching it reads
   directly as "how wide the caption may wrap". Flex lets the text inside hug its own glyphs
   within that width, which is what the white frame is drawn around. */
.player-caption-box {
  position: absolute;
  z-index: 4;
  display: flex;
  justify-content: center;
}
.player-caption {
  position: relative;
  /* A flex item refuses to shrink below its longest word by default, which let a long caption
     overflow the wrap box and grow as wide as the stage — leaving no room to drag it sideways. */
  min-width: 0;
  color: #fff;
  font-weight: 600;
  line-height: 1.35;
  overflow-wrap: anywhere;
  text-align: center;
  text-shadow:
    0 1px 0 #181818,
    0 -1px 0 #181818,
    1px 0 0 #181818,
    -1px 0 0 #181818,
    0 0 4px rgba(0, 0, 0, 0.85);
  outline-offset: 2px;
  pointer-events: none;
}
/* A solid dot marks the frame's top-left corner; dragging it away from the bottom edge scales
   the caption. It re-enables pointer events the caption text itself switches off. */
.caption-scale-handle {
  position: absolute;
  top: -5px;
  left: -5px;
  width: 11px;
  height: 11px;
  padding: 0;
  border: 1px solid rgba(0, 0, 0, 0.45);
  border-radius: 50%;
  background: #fff;
  cursor: nwse-resize;
  touch-action: none;
  pointer-events: auto;
}
/* The white frame hugs the caption itself rather than the whole wrap width, and only while this
   caption is the selected one. The box carries no handles: its own edge grab zones, measured on
   the text frame, do the stretching. */
.player-caption-box.is-selected {
  cursor: move;
  touch-action: none;
}
.player-caption-box.is-selected .player-caption {
  outline: 2px solid #fff;
}
/* Green is reserved for the snap lines the player's borders draw, never for the caption frame.
   The width lives here alone so the edge offset below cannot drift away from it. */
.caption-guide {
  --caption-guide-width: 2px;
  position: absolute;
  z-index: 5;
  background: #22c55e;
  pointer-events: none;
}
.caption-guide.is-vertical {
  top: 0;
  bottom: 0;
  width: var(--caption-guide-width);
}
.caption-guide.is-horizontal {
  right: 0;
  left: 0;
  height: var(--caption-guide-width);
}
.player-blackout {
  position: absolute;
  z-index: 3;
  inset: 0;
  background: #000;
}
.player-empty {
  position: relative;
  z-index: 3;
  display: grid;
  place-items: center;
  gap: 8px;
  color: #94a3b8;
  padding: 24px;
  text-align: center;
}
.player-empty b {
  color: #d7deea;
  font-size: 13px;
}
.player-empty span {
  max-width: 190px;
  font-size: 10px;
  line-height: 1.6;
}
.player-controls {
  position: relative;
  display: flex;
  align-items: center;
  min-height: 50px;
  padding: 8px 12px 6px;
  color: #64748b;
  background: #eef2f7;
  border-top: 1px solid #dce3ed;
  font-size: 11px;
}
.player-scrubber {
  position: absolute;
  z-index: 3;
  top: -9px;
  left: 0;
  width: 100%;
  height: 18px;
  margin: 0;
  opacity: 0;
  cursor: pointer;
}
.player-scrubber-visual {
  height: 4px;
  position: absolute;
  z-index: 2;
  top: -2px;
  right: 0;
  left: 0;
  overflow: visible;
  background: #cbd7e8;
  pointer-events: none;
}
.player-scrubber-visual i {
  position: absolute;
  inset: 0;
  background: #2563eb;
  transform: scaleX(0);
  transform-origin: left center;
  will-change: transform;
}
.player-scrubber-visual b {
  width: 14px;
  height: 14px;
  position: absolute;
  top: -5px;
  left: -7px;
  border: 2px solid #fff;
  border-radius: 50%;
  background: #64748b;
  box-shadow: 0 1px 3px rgba(15, 23, 42, 0.35);
  transform: translate3d(0, 0, 0);
  will-change: transform;
}
.player-control-left,
.player-control-right {
  display: flex;
  align-items: center;
  min-width: 0;
  gap: 5px;
}
.player-control-left {
  margin-right: auto;
}
.player-control-right {
  margin-left: auto;
  justify-content: flex-end;
}
.player-time {
  color: #52647c;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.player-time.current {
  color: #315681;
}
.player-time-divider {
  color: #94a3b8;
}
.player-icon-button,
.player-play-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: #64748b;
  background: transparent;
  border: 0;
  border-radius: 5px;
  cursor: pointer;
}
.player-icon-button {
  min-width: 28px;
  height: 28px;
  padding: 0 6px;
}
.player-audio-status {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 33px;
  height: 28px;
  flex: none;
  cursor: default;
}
.player-audio-meter {
  display: flex;
  align-items: flex-end;
  gap: 2px;
  height: 17px;
}
.player-audio-meter i {
  display: flex;
  flex-direction: column-reverse;
  gap: 1px;
  font-style: normal;
}
.player-audio-meter b {
  display: block;
  width: 7px;
  height: 3px;
  background: #94a3b8;
  border-radius: 1px;
}
.player-audio-meter b.lit {
  background: #18a542;
}
.player-audio-meter.playing i:nth-child(1) b:nth-child(2),
.player-audio-meter.playing i:nth-child(2) b:nth-child(3),
.player-audio-meter.playing i:nth-child(3) b:nth-child(2) {
  animation: audio-meter-signal 0.54s steps(2, end) infinite;
}
.player-audio-meter.playing i:nth-child(2) b:nth-child(4),
.player-audio-meter.playing i:nth-child(3) b:nth-child(3) {
  animation: audio-meter-signal 0.72s 0.18s steps(2, end) infinite reverse;
}
.player-icon-button:hover,
.player-icon-button[aria-expanded='true'] {
  color: #1e3a8a;
  background: #dfe7f2;
}
.player-play-button {
  position: absolute;
  top: 50%;
  left: 50%;
  width: 34px;
  height: 34px;
  color: #fff;
  background: #2563eb;
  border-radius: 50%;
  transform: translate(-50%, -50%);
}
.player-play-button:hover {
  background: #1d4ed8;
}
.player-play-button:disabled {
  color: #94a3b8;
  background: #dbe4f0;
  cursor: not-allowed;
}
.player-aspect-label {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 34px;
  height: 22px;
  padding: 0 4px;
  color: #64748b;
  border: 1px solid #b9c6d8;
  border-radius: 2px;
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  cursor: default;
}
.player-menu-anchor {
  position: relative;
  display: inline-flex;
}
.player-popover {
  position: absolute;
  z-index: 20;
  bottom: calc(100% + 8px);
  min-width: 150px;
  padding: 6px;
  color: #334155;
  background: #fff;
  border: 1px solid #d8e0eb;
  border-radius: 8px;
  box-shadow: 0 12px 28px rgb(49 68 94 / 18%);
}
.player-control-left .player-popover {
  left: 0;
}
.player-control-right .player-popover {
  right: 0;
}
.player-popover button,
.player-popover label {
  display: flex;
  align-items: center;
  width: 100%;
  min-height: 32px;
  gap: 8px;
  padding: 0 8px;
  color: #334155;
  background: transparent;
  border: 0;
  border-radius: 5px;
  font-size: 11px;
  text-align: left;
}
.player-popover button:hover,
.player-popover button.active {
  background: #edf3fb;
}
.player-popover button.active {
  color: #2563eb;
}
.player-popover em {
  margin-left: auto;
  color: #64748b;
  font-style: normal;
  font-size: 10px;
}
.player-popover label {
  justify-content: space-between;
}
.player-popover select {
  height: 25px;
  color: #334155;
  background: #fff;
  border: 1px solid #cbd5e1;
  border-radius: 4px;
}
.zoom-popover {
  display: grid;
  right: -64px !important;
  grid-template-columns: 24px minmax(132px, 1fr) 24px;
  align-items: center;
  gap: 8px;
  width: 236px;
  min-width: 236px;
  height: 46px;
  padding: 8px 10px;
  color: #d6d8de;
  background: #0c0d10;
  border-color: #2a2c32;
  border-radius: 10px;
  box-shadow: 0 8px 22px rgb(0 0 0 / 38%);
}
.zoom-popover .zoom-step-button {
  display: inline-flex;
  width: 24px;
  min-height: 24px;
  justify-content: center;
  padding: 0;
  color: #d6d8de;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 50%;
}
.zoom-popover .zoom-step-button:hover:not(:disabled) {
  color: #fff;
  background: #24262b;
  border-color: #3b3e45;
}
.zoom-popover .zoom-step-button:disabled {
  color: #60636b;
  cursor: not-allowed;
}
.zoom-popover input {
  appearance: none;
  width: 100%;
  height: 2px;
  margin: 0;
  background: #4d5058;
  border-radius: 999px;
  cursor: pointer;
}
.zoom-popover input::-webkit-slider-thumb {
  appearance: none;
  width: 11px;
  height: 11px;
  background: #f8f9fb;
  border: 0;
  border-radius: 3px;
  box-shadow: 0 0 0 1px rgb(0 0 0 / 16%);
}
.zoom-popover input::-moz-range-thumb {
  width: 11px;
  height: 11px;
  background: #f8f9fb;
  border: 0;
  border-radius: 3px;
}
.player-popover small {
  display: block;
  padding: 4px 8px 6px;
  color: #7b8aa0;
  font-size: 9px;
}
@keyframes audio-meter-signal {
  50% {
    background: #94a3b8;
  }
}
@media (prefers-reduced-motion: reduce) {
  .player-audio-meter.playing b {
    animation: none !important;
  }
}
.option-popover {
  min-width: 118px;
}
.player-panel:fullscreen {
  width: 100vw;
  height: 100vh;
}
.player-panel:fullscreen .stage-space {
  padding: 22px;
}
.projects {
  min-width: 0;
  min-height: 0;
  align-self: stretch;
  height: 100%;
  display: flex;
  flex-direction: column;
}
.projects > header {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 8px;
  padding: 11px;
  border-bottom: 1px solid #e2e8f0;
}
.projects > header > strong {
  flex: 0 0 auto;
}
.projects-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.project-count {
  flex: 0 0 auto;
  padding: 2px 7px;
  color: #2563eb;
  background: #eff6ff;
  border: 1px solid #bfdbfe;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 800;
}
.projects-subtitle {
  overflow: hidden;
  color: #64748b;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 9px;
}
.project-actions {
  min-width: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 5px;
}
.project-actions .button {
  display: inline-flex;
  align-items: center;
  width: 100%;
  justify-content: center;
  gap: 6px;
  line-height: 1;
  white-space: nowrap;
}
.project-actions .button svg {
  flex: 0 0 auto;
}
.project-actions .button:disabled {
  color: #94a3b8;
  background: #fff;
  border-color: #dbe3ef;
  opacity: 1;
}
.project-actions .primary {
  grid-column: 1 / -1;
}
.projects > div {
  min-height: 0;
  flex: 1 1 auto;
  padding: 6px;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(100px, 1fr));
  grid-auto-rows: 48px;
  align-content: start;
  justify-content: stretch;
  gap: 4px;
  overflow: auto;
}
.projects > div.is-empty {
  display: flex;
  align-items: stretch;
  justify-content: center;
}
.projects article {
  display: grid;
  grid-template-columns: 36px minmax(0, 1fr);
  grid-template-rows: auto;
  align-items: center;
  gap: 2px 5px;
  min-width: 0;
  min-height: 48px;
  width: 100%;
  padding: 4px;
  border: 1px solid #e2e8f0;
  border-radius: 7px;
  border-bottom: 1px solid #edf1f6;
  cursor: pointer;
}
.projects article.active {
  background: #eff6ff;
}
.cover {
  display: grid;
  place-items: center;
  width: 36px;
  height: 38px;
  grid-row: 1;
  color: #fff;
  background: #334155;
  border-radius: 5px;
  overflow: hidden;
}
.cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.projects article div {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}
.projects article b {
  min-width: 0;
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
}
.project-duration {
  flex: 0 0 auto;
  color: #64748b;
  font-size: 10px;
  line-height: 1;
  white-space: nowrap;
}
.project-expired-badge {
  flex: 0 0 auto;
  padding: 1px 4px;
  border: 1px solid #f5d48a;
  border-radius: 4px;
  background: #fff7e6;
  color: #9a6700;
  font-size: 9px;
  line-height: 1.2;
  white-space: nowrap;
}
.project-status {
  flex: 0 0 auto;
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: #22c55e;
}
.project-status.pending {
  background: #f59e0b;
}
.project-status.incomplete {
  background: #ef4444;
}
.project-status.failed {
  background: #ef4444;
}
/* The failure note gets its own line under the name, so a long message cannot push the dot out. */
.project-card-info {
  flex-wrap: wrap;
}
.projects article .project-package-failure {
  flex: 1 0 100%;
  color: #fca5a5;
  font-size: 10px;
  line-height: 1.2;
}
.projects article.failed {
  border-color: #ef4444;
}
.project-empty {
  width: 100%;
  height: 100%;
  padding: 28px 18px;
  display: grid;
  align-content: center;
  justify-items: center;
  gap: 7px;
  color: #8a98ad;
  text-align: center;
}
.project-empty b {
  color: #43536c;
  font-size: 12px;
}
.project-empty span {
  max-width: 190px;
  font-size: 10px;
  line-height: 1.55;
}
.slot-settings {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 44px;
  padding: 0 14px;
  border-top: 1px solid #e2e8f0;
  font-size: 11px;
}
.slot-settings.is-transition-only {
  gap: 14px;
  justify-content: flex-start;
}
.editor-horizontal-resizer {
  height: 10px;
  position: relative;
  z-index: 40;
  border-top: 1px solid #d8e1ee;
  border-bottom: 1px solid #d8e1ee;
  background: #f5f8fc;
  cursor: row-resize;
  touch-action: none;
}
.editor-horizontal-resizer span {
  width: 46px;
  height: 3px;
  position: absolute;
  top: 50%;
  left: 50%;
  border-radius: 999px;
  background: #aebdd0;
  transform: translate(-50%, -50%);
}
.editor-horizontal-resizer:hover,
.editor-horizontal-resizer.active {
  border-color: #93b7ee;
  background: #eaf2ff;
}
.editor-horizontal-resizer:hover span,
.editor-horizontal-resizer.active span {
  background: #2563eb;
}
/* Sits in the gap between the workbench and the timeline, only while a caption is picked. */
.caption-text-editor {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 40px;
  padding: 0 14px;
  border-top: 1px solid #d8e1ee;
  background: #fbf6f4;
  color: #8c3b2e;
}
.caption-text-time {
  flex: none;
  color: #94a3b8;
  font-size: 10px;
  font-variant-numeric: tabular-nums;
}
.caption-text-editor input {
  min-width: 0;
  /* Capped rather than left to eat the row: the controls beside it are the point of this bar, and a
     subtitle is short enough that the extra width only pushed them off the edge. */
  flex: 1;
  max-width: 320px;
  height: 26px;
  padding: 0 8px;
  border: 1px solid #d5a77d;
  border-radius: 4px;
  background: #fff;
  color: #7c3327;
  font-size: 12px;
}
.caption-text-editor input:focus {
  border-color: #2563eb;
  outline: none;
  box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.18);
}
/* Sits right next to the text box, so sizing reads as part of editing the caption. */
.caption-font-size {
  display: flex;
  flex: none;
  align-items: center;
  gap: 4px;
  color: #8c3b2e;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.caption-font-size button {
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 1px solid #d5a77d;
  border-radius: 4px;
  background: #fff;
  color: #8c3b2e;
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
}
.caption-font-size button:hover:not(:disabled) {
  border-color: #2563eb;
  color: #2563eb;
}
.caption-font-size button:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}
/* The steppers are square glyphs; the generate button carries a label, so it sizes to its text
   instead of being clipped to 22px. */
.caption-font-size button.caption-voice-generate {
  width: auto;
  padding: 0 8px;
  white-space: nowrap;
}
/* Sits where the caption font stepper does, in a cool palette so the two never read alike. One line
   for all three numbers, so it takes no more height than the caption row it swaps with. */
.audio-edit-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 2px 10px;
  border: 1px solid #bfd3e8;
  border-radius: 6px;
  background: #f4f8fc;
  color: #2c4a6b;
  font-size: 11px;
}
.audio-edit-label {
  flex: none;
  max-width: 7em;
  overflow: hidden;
  color: #33587f;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* Keep the three controls on one line, but size them like editing controls rather than distributing
   them across the full inspector width. The shared component still owns their interaction. */
.audio-edit-params {
  flex: none;
  width: fit-content;
  max-width: calc(100% - 92px);
  min-width: 0;
  --parameter-accent: #2563eb;
  --parameter-field-border: 1px solid #c7d6e6;
  --parameter-field-background: #ffffff;
  --parameter-field-height: 24px;
  --parameter-field-radius: 6px;
  --parameter-row-flex: 0 1 auto;
  --parameter-row-width: clamp(150px, 16vw, 218px);
  --parameter-label-width: 2.8em;
  --parameter-row-gap: 16px;
  --parameter-column-gap: 7px;
  --parameter-slider-height: 16px;
  --parameter-track-height: 2px;
  --parameter-track-fill: #2563eb;
  --parameter-track-rest: #cbd5e1;
  --parameter-thumb-width: 10px;
  --parameter-thumb-height: 14px;
  --parameter-thumb-radius: 4px;
  --parameter-thumb-border: 0;
  --parameter-thumb-background: #2563eb;
  --parameter-thumb-shadow: 0 1px 2px rgb(15 23 42 / 16%);
  --parameter-mark-size: 8px;
  --parameter-mark-color: #2563eb;
  --parameter-mark-height: 7px;
  --parameter-mark-label-display: none;
  --parameter-input-width: 3.5em;
  --parameter-input-align: center;
  --parameter-step-divider: 1px solid #dce6f0;
  --parameter-step-background: #f5f8fc;
  --parameter-step-width: 15px;
  --parameter-step-height: 11px;
  --parameter-step-font-size: 6px;
  --parameter-mark-font-size: 8px;
  font-variant-numeric: tabular-nums;
}
.slot-settings label {
  display: flex;
  align-items: center;
  gap: 5px;
}
.slot-readonly-control {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-left: 0 !important;
  color: #475569;
  white-space: nowrap;
}
.slot-readonly-control b {
  display: inline-flex;
  min-width: 42px;
  height: 28px;
  padding: 0 8px;
  align-items: center;
  justify-content: center;
  color: #334155;
  background: #f8fafc;
  border: 1px solid #dbe4f0;
  border-radius: 7px;
  font-variant-numeric: tabular-nums;
  font-weight: 700;
}
.slot-settings input {
  width: 65px;
}
.slot-settings.is-transition-only .transition-duration-control input[type='number'] {
  width: 64px;
}
.slot-settings > span {
  margin-left: auto;
  color: #64748b;
}
.slot-settings > span.transition-name {
  margin-left: 0;
  color: #1e4f91;
  font-weight: 700;
}
.ai-run-card {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 14px;
  padding: 12px 14px;
  color: #1e3a8a;
  background: #eff6ff;
  border: 1px solid #bfdbfe;
  border-radius: 10px;
}
.ai-run-card span {
  color: #64748b;
  font-size: 10px;
}
.editor-run {
  margin: 0;
  padding: 12px 16px;
  border-width: 0 0 1px;
  border-radius: 0;
}
.ai-run-card.failed {
  color: #991b1b;
  background: #fff1f2;
  border-color: #fecdd3;
}
.slot-settings .trim-range {
  margin-left: 0;
  color: #475569;
}
.slot-settings .ai-binding-note {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  margin-left: 0;
  padding: 3px 7px;
  color: #1d4ed8;
  background: #eff6ff;
  border-radius: 999px;
  font-weight: 700;
}
.slot-settings .low-match-note {
  margin-left: 0;
  padding: 3px 7px;
  color: #92400e;
  background: #fef3c7;
  border-radius: 999px;
  font-weight: 700;
}
.notice {
  position: fixed;
  z-index: 1001;
  top: 20px;
  right: 24px;
  display: grid;
  width: min(420px, calc(100vw - 48px));
  min-height: 46px;
  padding: 10px 10px 10px 13px;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 9px;
  color: #286344;
  background: #f3fbf7;
  border: 1px solid #b9e3cc;
  border-radius: 10px;
  box-shadow: 0 12px 30px #41587924;
  font-size: 12px;
  font-weight: 700;
  line-height: 1.5;
}
.notice.warning {
  color: #8a551c;
  background: #fff9ed;
  border-color: #f1d49d;
}
.notice.error {
  color: #a43845;
  background: #fff5f6;
  border-color: #efc4ca;
}
.notice > span {
  min-width: 0;
  overflow-wrap: anywhere;
}
.notice > button {
  display: grid;
  width: 26px;
  height: 26px;
  padding: 0;
  place-items: center;
  color: currentColor;
  background: transparent;
  border: 0;
  border-radius: 6px;
  cursor: pointer;
}
.notice > button:hover {
  background: #ffffffb8;
}
.notice-enter-active,
.notice-leave-active {
  transition:
    opacity 160ms ease,
    transform 160ms ease;
}
.notice-enter-from,
.notice-leave-to {
  opacity: 0;
  transform: translateY(-8px);
}
.mask {
  position: fixed;
  z-index: 1000;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 20px;
  background: #0f172a80;
}
.modal {
  width: min(520px, 100%);
  background: #fff;
  border-radius: 14px;
}
.modal > header,
.modal > footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 15px 18px;
  border-bottom: 1px solid #e2e8f0;
}
.modal h3 {
  margin: 0;
}
.modal p {
  margin: 4px 0;
  color: #64748b;
  font-size: 12px;
}
.modal header > button {
  background: none;
  border: 0;
}
.modal main {
  padding: 18px;
}
.modal main label {
  display: grid;
  gap: 6px;
}
.modal > footer {
  justify-content: flex-end;
  flex-wrap: wrap;
  border: 0;
  border-top: 1px solid #e2e8f0;
}
.modal > footer .modal-submit {
  display: inline-flex;
  flex: 0 0 auto;
  min-width: 108px;
  visibility: visible;
}
@media (max-width: 1050px) {
  .workbench-head {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 8px;
  }
  .current {
    min-width: 0;
  }
  .workbench-actions {
    flex-wrap: wrap;
  }
  .pane-resizer {
    display: none;
  }
  .workflow-graph-content {
    grid-template-columns: 1fr;
  }
  .workflow-node-detail {
    position: static;
    min-height: 280px;
    margin: 0 20px 20px;
  }
  .workflow-node-detail-empty {
    min-height: 245px;
  }
  .workbench-main {
    grid-template-columns: 280px 1fr;
    height: 580px;
  }
  .projects {
    grid-column: 1/3;
    height: max-content;
    max-height: 180px;
  }
  .projects > div {
    height: auto;
    max-height: 130px;
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
@media (max-width: 760px) {
  .config-head {
    flex-wrap: wrap;
    gap: 10px;
  }
  .config-head__title {
    flex: 1 1 100%;
  }
  .config-head__actions {
    width: 100%;
    justify-content: flex-start;
  }
  .config-layout {
    grid-template-columns: 1fr;
  }
  .slot-heading {
    display: none;
  }
  .slot-row {
    grid-template-columns: 1fr 1fr;
  }
  .workbench-head {
    flex-wrap: wrap;
  }
  .workbench-actions {
    width: 100%;
    flex-wrap: wrap;
  }
  .current {
    order: 3;
    flex-basis: 100%;
  }
  .workbench-main {
    display: block;
    height: auto;
  }
  .resources,
  .player-panel,
  .projects {
    min-height: 360px;
  }
  .projects > div {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .slot-settings {
    flex-wrap: wrap;
    padding: 8px;
  }
  .workflow-graph-backdrop {
    padding: 8px;
  }
  .workflow-dialog {
    max-height: calc(100vh - 16px);
  }
  .workflow-dialog > header {
    padding: 16px;
  }
  .workflow-graph-canvas,
  .workflow-node-detail {
    margin-right: 12px;
    margin-left: 12px;
  }
  .workflow-graph-canvas {
    padding: 14px 0;
  }
  .workflow-dialog > footer {
    gap: 8px;
  }
  .workflow-dialog > footer .workflow-edge-count {
    display: none;
  }
  .workflow-dialog > footer button {
    width: 100%;
    justify-content: center;
  }
}
</style>
<style scoped src="./effect-template-mix-workflow.css"></style>
