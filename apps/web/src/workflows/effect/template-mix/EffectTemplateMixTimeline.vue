<script setup lang="ts">
import type {
  EffectTemplateMixCaption,
  EffectTemplateMixDetachedAudio,
  EffectTemplateMixMaterial,
  EffectTemplateMixSlot,
  EffectTemplateMixTransition,
  EffectTemplateMixVariant,
  EffectVideoTransform,
  PackagingItem,
} from '@ai-marketing/contracts';
import {
  effectTemplateMixContentDuration,
  packagingTimelineClips,
  effectTemplateMixSourceChanges,
  PACKAGING_AUDIO_DB_CEILING,
  PACKAGING_AUDIO_DB_FLOOR,
  packagingAudioFade,
  packagingAudioFromDb,
  packagingAudioLevel,
} from '@ai-marketing/contracts';
import {
  AudioLines,
  Captions,
  Copy,
  Eye,
  EyeOff,
  Film,
  Focus,
  Lock,
  Magnet,
  MousePointer2,
  Music2,
  ClipboardPaste,
  Redo2,
  Undo2,
  Unlock,
  Volume2,
  VolumeX,
  ZoomIn,
  ZoomOut,
} from '@lucide/vue';
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';

import { apiUrl } from '../../../api/http-client';
import {
  audioRowCount as audioRowCountOf,
  audioRowKey,
  audioRowOf as audioRowOfClip,
  audioRowOfKey,
  detachedAudioSourceUrl,
  timelineAudioClipRefs,
  type AudioClipKind,
  type AudioClipRef,
  type AudioRowTrack,
} from './effect-template-mix-audio-lanes';
import {
  assignEffectTemplateMixCaptionLanes,
  EFFECT_TEMPLATE_MIX_ROLE_LABELS,
  EFFECT_TEMPLATE_MIX_TRANSITIONS,
  effectTemplateMixCaptionRowKeys,
  effectTemplateMixCaptionTrackKey,
  effectTemplateMixTransitionDuration,
} from './effect-template-mix-state';
import EffectTemplateMixFilmstrip from './EffectTemplateMixFilmstrip.vue';
import EffectTemplateMixWaveform from './EffectTemplateMixWaveform.vue';
import { splitRangeAtPlayhead } from './effect-template-mix-split';
import { resizeVideoRangeAtEdge } from './effect-template-mix-edge-trim';

const props = withDefaults(
  defineProps<{
    duration: number;
    templateId?: string;
    canRedo?: boolean;
    canUndo?: boolean;
    readOnly?: boolean;
    /** An active packaging task keeps this source project's tracks locked until it ends. */
    packagingSourceLock?: boolean;
    /** Local update freezes only the participating project's tracks until the task ends. */
    sourceUpdateLock?: boolean;
    fps?: number;
    height?: number;
    materials: EffectTemplateMixMaterial[];
    playhead: number;
    playing?: boolean;
    projectId?: string;
    /** Set when the preview selects a caption, so both views show the same clip. */
    selectedAudioClipId?: string | null;
    /** Track controls are owned by the workbench player, not by this view. */
    audioRowMuted?: boolean[];
    videoMuted?: boolean;
    videoVisible?: boolean;
    captionVisible?: boolean;
    selectedSlotId: string;
    variant: EffectTemplateMixVariant | null;
    packaging?: PackagingItem | null;
  }>(),
  {
    canRedo: false,
    canUndo: false,
    readOnly: false,
    packagingSourceLock: false,
    sourceUpdateLock: false,
    fps: 30,
    height: 260,
    playing: false,
    selectedAudioClipId: null,
    audioRowMuted: () => [],
    videoMuted: false,
    videoVisible: true,
    captionVisible: true,
  },
);

const pendingSourceSlotIds = computed(() => new Set(props.variant
  ? effectTemplateMixSourceChanges(props.variant, props.materials).map((change) => change.slotId) : []));

const emit = defineEmits<{
  assignMaterial: [materialId: string, slotId: string];
  /** A library clip released on a track border: the row to create and where in time it starts. */
  insertMaterialTrack: [materialId: string, lane: number, start: number];
  /** A library clip released in free space uses the existing video row. */
  placeMaterialTrack: [materialId: string, lane: number, start: number];
  /** `insertRow` is set when the track was let go on a row border: open a row there for it. */
  addMusicAsset: [
    music: MusicAssetDrop & { row: number; start: number; insertRow?: number | undefined },
  ];
  applyTransition: [slotId: string, transition: EffectTemplateMixTransition];
  changeAudioVolume: [clipId: string, volume: number];
  // `row` is the audio row the clip was dropped on; a caption has no row, so it omits the argument
  // and only its time changes. `insertRow` is set when it was let go on a row border instead: open a
  // row there for it, the same answer a library track gets.
  moveAudioClip: [clipId: string, start: number, row?: number, insertRow?: number];
  /**
   * A subtitle let go on a caption row border. Caption rows are derived from the caption's track, so
   * giving it a row of its own means minting a new track for it — there is no lane number to pass.
   */
  splitCaptionTrack: [captionId: string, start: number];
  /**
   * A subtitle let go on a row that already exists and can take it. The row travels as the same key
   * the packer groups captions by, so the workbench writes it back without having to know how rows
   * are ordered or that a row is a track at all.
   */
  moveCaptionToRow: [captionId: string, start: number, rowKey: string];
  /** A library track let go on top of an audio clip: take the clip's place, keeping its own length. */
  replaceAudioWithMusic: [clipId: string, music: MusicAssetDrop];
  moveAudioClips: [moves: Array<{ clipId: string; start: number; row?: number }>];
  moveTimelineSelection: [moves: {
    videos: Array<{ slotId: string; start: number; lane: number }>;
    audios: Array<{ clipId: string; start: number }>;
  }];
  /** `insertLane` is set when the clip was let go on a track border: open a row there for it. */
  moveClip: [slotId: string, start: number, lane: number, insertLane?: number];
  moveClips: [moves: Array<{ slotId: string; start: number; lane: number }>];
  openTransition: [slotId: string];
  redo: [];
  reorderSlot: [slotId: string, targetSlotId: string];
  resizeAudioClip: [
    clipId: string,
    side: 'LEFT' | 'RIGHT',
    start: number,
    offset: number,
    duration: number,
  ];
  resizeSlot: [
    slotId: string,
    side: 'LEFT' | 'RIGHT',
    start: number,
    trimStartSeconds: number,
    duration: number,
  ];
  seek: [seconds: number];
  selectAudioClip: [clipId: string | null];
  toggleAudioMute: [track: AudioTrack | 'VIDEO', muted: boolean];
  toggleTrackVisibility: [track: 'CAPTION' | 'VIDEO', visible: boolean];
  toggleVideoLock: [locked: boolean];
  /** The whole caption selection, so the editor can move and scale a group as one. */
  selectCaptionClips: [captionIds: string[]];
  /** The whole voice/music selection, so the editor can retune a group from one standard clip. */
  selectAudioClips: [clipIds: string[]];
  selectSlot: [slotId: string];
  selectVideoClips: [slotIds: string[]];
  splitMaterial: [target: { kind: 'VIDEO' | 'AUDIO' | 'CAPTION'; id: string }, at: number];
  separateAudio: [slotId: string];
  pasteVideoMaterials: [
    items: Array<{
      materialId: string;
      targetSlotId: string;
      offset: number;
      duration: number;
      detachedAudio?: EffectTemplateMixDetachedAudio;
      transform?: EffectVideoTransform;
    }>,
  ];
  pasteAudioMaterial: [
    audio: {
      fileObjectId: string;
      name: string;
      sourceAssetId?: string;
      audioKind?: 'VOICE' | 'MUSIC' | 'DETACHED';
      loopSource?: boolean;
      sourceDuration: number;
      duration: number;
      start: number;
      offset: number;
      volume: number;
      /** The row the paste was asked for; absent when it came from the keyboard, not a row menu. */
      row?: number;
    },
  ];
  requestNotice: [message: string, kind?: 'success' | 'warning' | 'error'];
  trimSlot: [slotId: string, trimStartSeconds: number];
  previewTransitionDuration: [slotId: string, duration: number];
  updateTransitionDuration: [slotId: string, duration: number];
  undo: [];
}>();

/** 音频行是通用轨道，只按行号编号；口播、纯音乐、分离原声只是颜色不同的片段。 */
type AudioTrack = AudioRowTrack;
type CaptionTrack = `CAPTION:${number}`;
type VisibleTrack = 'CAPTION' | CaptionTrack | 'VIDEO' | AudioTrack;
type TimelineAudioKind = AudioClipKind;
type MusicAssetDrop = { assetId: string; fileObjectId: string; name: string; duration: number };
/** One audio clip or caption block; kind affects its colour, not its track. */
type TimelineAudio = {
  /**
   * Namespaced selection id: `voice:<lineId>`, `capvoice:<captionId>`, `music`, `voice`,
   * `detached:<id>`, or `caption:<id>`.
   */
  id: string;
  kind: TimelineAudioKind;
  label: string;
  start: number;
  /** Visible timeline length after trimming. */
  duration: number;
  /** Seconds trimmed from the source head. */
  offset: number;
  /** Longest playable window; limits right-edge trimming. */
  sourceDuration: number;
  volume: number;
  /** Effective head fade in seconds, already resolved against the pipeline default. */
  fadeIn: number;
  /** Effective tail fade in seconds, already resolved against the pipeline default. */
  fadeOut: number;
  sourceUrl: string;
  /** Captions and packaged audio are persisted through the audio-edit API. */
  editable: boolean;
  /** Optional overlay text (caption copy or script line). */
  text?: string;
};
type AudioDragMode = 'LEFT' | 'MOVE' | 'RIGHT' | 'VOLUME';
/** Geometry a drag needs; captions reuse it without a real source file. */
type AudioDragTarget = {
  id: string;
  kind: TimelineAudioKind;
  start: number;
  offset: number;
  duration: number;
  volume: number;
  sourceDuration: number;
  /** Neighbouring clips bound the gesture so independent caption moves cannot overlap. */
  minStart?: number;
  maxEnd?: number;
};
type AudioDragState = {
  id: string;
  kind: TimelineAudioKind;
  mode: AudioDragMode;
  initialStart: number;
  initialOffset: number;
  initialDuration: number;
  initialVolume: number;
  initialSourceDuration: number;
  minStart: number;
  maxEnd: number;
  currentStart: number;
  currentOffset: number;
  currentDuration: number;
  currentVolume: number;
  moved: boolean;
  startClientX: number;
  startClientY: number;
  volumeTop: number;
  volumeHeight: number;
  /** The row the grabbed clip rounds to while the pointer moves; unclamped on purpose. */
  currentRow: number;
  /** The audio row border the pointer is on, when one is under it: open a row there instead. */
  insertRow: number | null;
  /** The caption row border the pointer is on: the subtitle is given a row of its own there. */
  insertCaptionTrack: boolean;
  /** Vertical position of the ghost inside the audio area, in pixels, following the pointer. */
  ghostTop: number;
  /** Row each member of the selection started on, so a group rides one shared row delta. */
  initialRows: Record<string, number>;
};
type ClipDragState = {
  currentLane: number;
  currentStart: number;
  currentClientX: number;
  currentClientY: number;
  /** Vertical position of the ghost in the video track, in pixels, following the pointer exactly. */
  ghostTop: number;
  grabOffset: number;
  /** The border the pointer is on, when one is under it: the clip opens a row there instead. */
  insertLane: number | null;
  initialLanes: Record<string, number>;
  initialStarts: Record<string, number>;
  selectedSlotIds: string[];
  selectionModifier: boolean;
  slotId: string;
  startClientX: number;
  startClientY: number;
  started: boolean;
};
type TrimDragState = {
  currentOffset: number;
  originalOffset: number;
  slotId: string;
  startClientX: number;
};
type EdgeTrimDragState = {
  currentDuration: number;
  currentOffset: number;
  currentStart: number;
  initialDuration: number;
  initialOffset: number;
  initialStart: number;
  moved: boolean;
  side: 'LEFT' | 'RIGHT';
  slotId: string;
  startClientX: number;
};
type MarqueeState = {
  currentClientX: number;
  currentClientY: number;
  moved: boolean;
  startClientX: number;
  startClientY: number;
};
type TimelineResizeState = {
  startClientX: number;
  startValue: number;
};
type TransitionDragState = {
  currentDuration: number;
  initialDuration: number;
  moved: boolean;
  side: 'LEFT' | 'RIGHT';
  slotId: string;
  startClientX: number;
};

const trackOrder = ref<VisibleTrack[]>(['CAPTION', 'VIDEO']);
/**
 * A row is named after what it carries, never after its number: every audio row reads as 音频
 * (口播、纯音乐、分离原声 are told apart by clip colour only) and every caption row as 字幕, because
 * the lane is a position the user can rearrange rather than an identity. Adding a subtitle from the
 * library mints its own track, so numbering would also leak the library's bookkeeping into the UI.
 */
const AUDIO_TRACK_LABEL = '音频';
const CAPTION_TRACK_LABEL = '字幕';
const VIDEO_TRACK_LABEL = '视频';
const isCaptionTrack = (track: VisibleTrack): track is CaptionTrack | 'CAPTION' =>
  track === 'CAPTION' || track.startsWith('CAPTION:');
const captionTrackKey = (lane: number): CaptionTrack => `CAPTION:${lane}`;
const captionLaneOfTrack = (track: CaptionTrack | 'CAPTION'): number =>
  track === 'CAPTION' ? 0 : Math.max(0, Number(track.slice('CAPTION:'.length)) || 0);
const trackLabel = (track: VisibleTrack): string => {
  if (isCaptionTrack(track)) return CAPTION_TRACK_LABEL;
  return track === 'VIDEO' ? VIDEO_TRACK_LABEL : AUDIO_TRACK_LABEL;
};
/** Every audio row shares one header style, so the row number never reaches a class name. */
const trackClassName = (track: VisibleTrack): string =>
  track === 'VIDEO' ? 'video' : isCaptionTrack(track) ? 'caption' : 'audio';
/** CapCut-like lane geometry: audio lanes stay tall, subtitle lanes are slim strips. */
const AUDIO_LANE_HEIGHT = 50;
const AUDIO_CLIP_HEIGHT = 44;
/** Captions carry one short line of text, so their row is a fraction of an audio row. */
const CAPTION_LANE_HEIGHT = 34;
const CAPTION_CLIP_HEIGHT = 28;
const AUDIO_CLIP_INSET = 3;
const AUDIO_MIN_DURATION = 0.1;
const viewport = ref<HTMLElement | null>(null);
const canvas = ref<HTMLElement | null>(null);
const videoTrack = ref<HTMLElement | null>(null);
const captionTrackElements = new Map<CaptionTrack, HTMLElement>();
/** One row per audio track, so a marquee only ever measures the lane it began in. */
const audioTrackElements = new Map<AudioTrack, HTMLElement>();
const timelineShell = ref<HTMLElement | null>(null);
const playheadElement = ref<HTMLElement | null>(null);
const pixelsPerSecond = ref(52);
const viewportWidth = ref(0);
const trackHeaderWidth = ref(120);
const timelineResize = ref<TimelineResizeState | null>(null);
const scrubbing = ref(false);
const snapEnabled = ref(true);
const clipDrag = ref<ClipDragState | null>(null);
const transitionDrag = ref<TransitionDragState | null>(null);
const suppressTransitionClick = ref(false);
const transitionDropSlotId = ref('');
/** Row a library track is hovering over, so only that row highlights as a drop target. */
const musicDropRow = ref<number | null>(null);
/** The audio clip a library track is hovering, so it is the one that dims and gets outlined. */
const musicDropClipId = ref('');
const trimDrag = ref<TrimDragState | null>(null);
const edgeTrimDrag = ref<EdgeTrimDragState | null>(null);
const marquee = ref<MarqueeState | null>(null);
const materialDropSlotId = ref('');
const selectedClipIds = ref<string[]>([]);
const selectedAudioIds = ref<string[]>([]);
const audioDrag = ref<AudioDragState | null>(null);
type TimelineClipboard =
  | {
      kind: 'VIDEO';
      entries: Array<{
        sourceSlotId: string;
        materialId: string;
        offset: number;
        duration: number;
        detachedAudio?: EffectTemplateMixDetachedAudio;
        transform?: EffectVideoTransform;
      }>;
    }
  | {
      kind: 'AUDIO';
      audio: {
        fileObjectId: string;
        name: string;
        sourceAssetId?: string;
        audioKind?: 'VOICE' | 'MUSIC' | 'DETACHED';
        loopSource?: boolean;
        sourceDuration: number;
        duration: number;
        offset: number;
        volume: number;
      };
    };
const timelineClipboard = ref<TimelineClipboard | null>(null);
const clipContextMenu = ref<{
  kind: 'VIDEO' | 'AUDIO' | 'EMPTY_VIDEO' | 'EMPTY_AUDIO';
  slotId?: string;
  audioId?: string;
  pasteStart?: number;
  /** The audio row the menu was opened on, so a paste lands there rather than on a default row. */
  pasteRow?: number;
  left: number;
  top: number;
} | null>(null);
const trackHeaders = ref<HTMLElement | null>(null);
/** Audio rows are numbered at runtime, so their lock flags are written lazily by the header. */
const trackLocked = reactive<Record<string, boolean>>({
  CAPTION: false,
  VIDEO: false,
});
const trackIsLocked = (track: VisibleTrack): boolean =>
  props.packagingSourceLock || props.sourceUpdateLock || Boolean(trackLocked[track]);
const toggleTrackLock = (track: VisibleTrack): void => {
  if (props.sourceUpdateLock) {
    emit('requestNotice', '局部更新正在进行，此成片工程暂时不能编辑；任务结束后自动解锁。', 'warning');
    return;
  }
  if (props.packagingSourceLock) {
    emit('requestNotice', '智能成片包装正在进行，成片工程暂时不能编辑；任务结束后自动解锁。', 'warning');
    return;
  }
  trackLocked[track] = !trackLocked[track];
  if (track === 'VIDEO') emit('toggleVideoLock', Boolean(trackLocked.VIDEO));
};
let resizeObserver: ResizeObserver | null = null;

const materialById = computed(() => new Map(props.materials.map((item) => [item.id, item])));
const sequentialStarts = computed(() => {
  const starts: Record<string, number> = {};
  let cursor = 0;
  for (const slot of props.variant?.slots ?? []) {
    starts[slot.id] = cursor;
    cursor += Math.max(0, slot.duration);
  }
  return starts;
});
const clipStart = (slotId: string): number =>
  Math.max(0, props.variant && (props.variant.bindings[slotId] || props.variant.intentionallyEmptySlotIds?.includes(slotId))
    ? packagingTimelineClips(props.variant).find(({ slot }) => slot.id === slotId)?.start ?? 0
    : sequentialStarts.value[slotId] ?? 0);
const rawClipLane = (slotId: string): number =>
  Math.max(0, Math.round(props.variant?.videoLanes?.[slotId] ?? 0));
const occupiedVideoLaneValues = computed(() => {
  const lanes = new Set<number>();
  for (const slot of props.variant?.slots ?? []) {
    if (materialForSlot(slot.id)) lanes.add(rawClipLane(slot.id));
  }
  return [...lanes].sort((left, right) => left - right);
});
const clipLane = (slotId: string): number => {
  const rawLane = rawClipLane(slotId);
  const index = occupiedVideoLaneValues.value.indexOf(rawLane);
  return index >= 0 ? index : 0;
};
/**
 * Rows are compacted, so no empty lane is reserved and the row count is exactly what the clips
 * occupy. A drag deliberately does not inflate it either: the ghost is free to travel past the last
 * row while the pointer moves, and the row a drop lands on is created on release — growing the track
 * mid-drag would shift the very rows the pointer is being measured against.
 */
const videoLaneCount = computed(() => Math.max(1, occupiedVideoLaneValues.value.length));
const layoutSlots = computed(() =>
  (props.variant?.slots ?? []).filter((slot) => props.variant?.bindings[slot.id]).map((slot) => {
    const start = activeClipStart(slot.id);
    return { id: slot.id, start, end: start + Math.max(0, activeSlotDuration(slot.id)) };
  }),
);
const draggedTimelineEnd = computed(() => {
  const drag = clipDrag.value;
  if (!drag?.started || drag.selectedSlotIds.length === 0) return 0;
  const startDelta = drag.currentStart - (drag.initialStarts[drag.slotId] ?? drag.currentStart);
  return Math.max(
    0,
    ...drag.selectedSlotIds.map((slotId) => {
      const slot = props.variant?.slots.find((item) => item.id === slotId);
      if (!slot) return 0;
      return (drag.initialStarts[slotId] ?? clipStart(slotId)) + startDelta + slot.duration;
    }),
  );
});
/**
 * The live audio or caption drag's own end. Both share one drag state, so a single term covers them:
 * the canvas has to grow under the pointer, otherwise the drag would be fenced by the film's current
 * length instead of by the pointer, and a clip could never be carried past the last of the material.
 */
const draggedAudioEnd = computed(() => {
  const drag = audioDrag.value;
  if (drag?.mode !== 'MOVE') return 0;
  return Math.max(0, drag.currentStart + drag.currentDuration);
});
/**
 * How far the timeline reaches. Audio and captions count as much as the video clips do — a clip
 * dragged past the last video clip extends the film, and everything it is measured against (the
 * canvas, the ticks, the playhead range) has to grow with it.
 */
const timelineDuration = computed(() =>
  Math.max(
    0.1,
    props.duration,
    draggedTimelineEnd.value,
    draggedAudioEnd.value,
    props.variant
      ? effectTemplateMixContentDuration(props.variant, props.packaging?.checkpoint)
      : 0,
    ...layoutSlots.value.map(({ end }) => end),
  ),
);
const canvasWidth = computed(() =>
  Math.max(viewportWidth.value, timelineDuration.value * pixelsPerSecond.value + 96),
);
let playbackNeedleAnimation: Animation | undefined;
let playbackNeedleStartSeconds = 0;
const setPlaybackNeedle = (seconds = props.playhead): void => {
  if (!playheadElement.value) return;
  const left = Math.max(0, seconds) * pixelsPerSecond.value;
  playheadElement.value.style.transform = `translate3d(${left}px, 0, 0)`;
};
const stopPlaybackNeedle = (seconds = props.playhead): void => {
  playbackNeedleAnimation?.cancel();
  playbackNeedleAnimation = undefined;
  setPlaybackNeedle(seconds);
};
const startPlaybackNeedle = (startSeconds: number, endSeconds = props.duration): void => {
  const element = playheadElement.value;
  if (!element) return;
  stopPlaybackNeedle(startSeconds);
  const safeStart = Math.max(0, Math.min(endSeconds, startSeconds));
  const safeEnd = Math.max(safeStart, endSeconds);
  playbackNeedleStartSeconds = safeStart;
  if (safeEnd <= safeStart) return;
  playbackNeedleAnimation = element.animate(
    [
      { transform: `translate3d(${safeStart * pixelsPerSecond.value}px, 0, 0)` },
      { transform: `translate3d(${safeEnd * pixelsPerSecond.value}px, 0, 0)` },
    ],
    {
      duration: (safeEnd - safeStart) * 1000,
      easing: 'linear',
      fill: 'both',
    },
  );
};
const animatedNeedleSeconds = (): number =>
  playbackNeedleStartSeconds + Number(playbackNeedleAnimation?.currentTime ?? 0) / 1000;
const syncPlaybackNeedleClock = (seconds: number): void => {
  if (playbackNeedleAnimation) {
    playbackNeedleAnimation.currentTime = Math.max(0, seconds - playbackNeedleStartSeconds) * 1000;
  } else setPlaybackNeedle(seconds);
};
const timelineShellStyle = computed(() => ({
  '--timeline-height': `${props.height}px`,
  '--track-header-width': `${trackHeaderWidth.value}px`,
}));
const majorTickSeconds = computed(() => {
  if (pixelsPerSecond.value >= 180) return 0.5;
  if (pixelsPerSecond.value >= 110) return 1;
  if (pixelsPerSecond.value >= 64) return 2;
  if (pixelsPerSecond.value >= 34) return 5;
  return 10;
});
const minorTickSeconds = computed(() => majorTickSeconds.value / 5);
const majorTicks = computed(() => {
  const duration = Math.max(0, timelineDuration.value);
  const interval = majorTickSeconds.value;
  const ticks: number[] = [];
  for (let second = 0; second <= duration + 0.0001; second += interval)
    ticks.push(Math.round(second * 1000) / 1000);
  const last = ticks.at(-1) ?? 0;
  if (duration - last > 0.0001) ticks.push(Math.round(duration * 1000) / 1000);
  return ticks;
});
const marqueeStyle = computed(() => {
  if (!marquee.value || !canvas.value) return null;
  const bounds = canvas.value.getBoundingClientRect();
  const left = Math.min(marquee.value.startClientX, marquee.value.currentClientX) - bounds.left;
  const top = Math.min(marquee.value.startClientY, marquee.value.currentClientY) - bounds.top;
  return {
    height: `${Math.abs(marquee.value.currentClientY - marquee.value.startClientY)}px`,
    left: `${left}px`,
    top: `${top}px`,
    width: `${Math.abs(marquee.value.currentClientX - marquee.value.startClientX)}px`,
  };
});
const draggedSlot = computed(() =>
  props.variant?.slots.find(({ id }) => id === clipDrag.value?.slotId),
);
const draggingGroupDelta = computed(() => {
  const drag = clipDrag.value;
  if (!drag?.started) {
    const audio = audioDrag.value;
    return audio?.mode === 'MOVE' && audio.moved
      ? { start: audio.currentStart - audio.initialStart, topPx: 0 }
      : null;
  }
  const originTop = 7 + (drag.initialLanes[drag.slotId] ?? drag.currentLane) * 70;
  return {
    start: drag.currentStart - (drag.initialStarts[drag.slotId] ?? drag.currentStart),
    // The rest of the selection rides the same continuous pixel offset as the ghost, so a group moves
    // as one piece instead of each member hopping a row at a time.
    topPx: drag.ghostTop - originTop,
  };
});
const dragGhostStyle = computed(() => {
  const drag = clipDrag.value;
  const slot = draggedSlot.value;
  if (!drag?.started || !slot) return null;
  const width = slot.duration * pixelsPerSecond.value;
  const left = Math.max(
    0,
    Math.min(canvasWidth.value - width, drag.currentStart * pixelsPerSecond.value),
  );
  return {
    left: `${left}px`,
    // The ghost rides the pointer pixel for pixel rather than hopping a whole row at a time, so a free
    // vertical drag reads as one continuous movement. It may sit above the first row or past the last
    // one, where no row exists yet; the row only matters at the drop, which is where it is rounded
    // into a lane and turned into a real track.
    top: `${drag.ghostTop}px`,
    width: `${Math.max(24, width)}px`,
  };
});
const materialForSlot = (slotId: string): EffectTemplateMixMaterial | null => {
  const materialId = props.variant?.bindings[slotId];
  return materialId ? (materialById.value.get(materialId) ?? null) : null;
};
type TimelineInterval = { end: number; id: string; start: number };
const assignIntervalLanes = (items: TimelineInterval[]): Map<string, number> => {
  const laneEnds: number[] = [];
  const lanes = new Map<string, number>();
  for (const item of [...items].sort(
    (left, right) => left.start - right.start || left.id.localeCompare(right.id),
  )) {
    const lane = laneEnds.findIndex((end) => end <= item.start + 1 / props.fps);
    const nextLane = lane >= 0 ? lane : laneEnds.length;
    laneEnds[nextLane] = item.end;
    lanes.set(item.id, nextLane);
  }
  return lanes;
};
const timelineCaptions = computed(
  () => props.packaging?.checkpoint.captions ?? props.variant?.captions ?? [],
);
const captionLaneById = computed(() =>
  assignEffectTemplateMixCaptionLanes(timelineCaptions.value, props.fps),
);
const captionLaneCount = computed(() =>
  Math.max(1, captionLaneById.value.size ? Math.max(...captionLaneById.value.values()) + 1 : 1),
);
const fileUrl = (id: string): string =>
  props.projectId ? apiUrl(`/projects/${props.projectId}/file-objects/${id}/content`) : '';
// Only a finished item can be saved, so unfinished drafts must not offer edit gestures. A completed
// checkpoint stays visible and editable as the user changes picture lanes.
const audioEditable = computed(
  () => !props.readOnly && props.packaging?.status === 'COMPLETED',
);
/**
 * The clips the audio area draws. Membership comes from the shared clip list rather than being
 * decided again here, so the row a clip is drawn on cannot drift from the row it is muted by or
 * the row the workbench persists.
 */
const timelineAudios = computed<TimelineAudio[]>(() => {
  const packaged = props.packaging;
  const checkpoint = packaged?.checkpoint;
  const script = checkpoint?.script ?? [];
  return timelineAudioClipRefs(props.variant, packaged, props.materials, props.projectId).flatMap(
    (ref): TimelineAudio[] => {
      if (ref.source === 'PACKAGED' && checkpoint) {
        // A caption narration is a narration line the editor generated from a subtitle, so it is
        // keyed by caption rather than by script line and needs its own lookup.
        const captionId = ref.id.startsWith('capvoice:')
          ? ref.id.slice('capvoice:'.length)
          : undefined;
        // Either namespace resolves to one string key; only the collection it indexes differs.
        const lineId = captionId ?? ref.id.slice('voice:'.length);
        const audio =
          ref.kind === 'MUSIC'
            ? checkpoint.music
            : captionId === undefined
              ? checkpoint.voices?.[lineId]
              : checkpoint.captionVoices?.[captionId];
        if (!audio) return [];
        const offset = Math.max(0, audio.offset ?? 0);
        // The packaged branch is only reached for a narration line or the music bed, so the fade
        // default is resolved against one of those two rather than the detached kind.
        const fadeKind: 'MUSIC' | 'VOICE' = ref.kind === 'MUSIC' ? 'MUSIC' : 'VOICE';
        const lineText =
          ref.kind !== 'VOICE'
            ? undefined
            : captionId === undefined
              ? script.find((line) => line.id === lineId)?.text
              : checkpoint.captions?.find((caption) => caption.id === captionId)?.text;
        return [
          {
            id: ref.id,
            kind: ref.kind,
            label:
              ref.kind === 'MUSIC'
                ? '纯音乐草稿'
                : captionId === undefined
                  ? '口播草稿'
                  : '字幕口播',
            start: audio.start,
            duration: audio.duration,
            offset,
            sourceDuration: offset + audio.duration,
            volume: audio.volume,
            fadeIn: packagingAudioFade(audio, fadeKind, 'fadeIn'),
            fadeOut: packagingAudioFade(audio, fadeKind, 'fadeOut'),
            sourceUrl: fileUrl(audio.fileObjectId),
            editable: audioEditable.value,
            ...(lineText === undefined ? {} : { text: lineText }),
          },
        ];
      }
      if (ref.source === 'LEGACY') {
        const audio = ref.kind === 'MUSIC' ? props.variant?.bgm : props.variant?.voice;
        if (!audio) return [];
        return [
          {
            id: ref.id,
            kind: ref.kind,
            label: audio.name,
            start: audio.start,
            duration: audio.duration,
            offset: Math.max(0, audio.offset ?? 0),
            sourceDuration: Math.max(0, audio.offset ?? 0) + audio.duration,
            volume: audio.volume,
            // The legacy variant audio predates the fade concept, so its strip keeps a flat envelope
            // rather than borrowing the packaged pipeline's default and promising an easing nobody applies.
            fadeIn: 0,
            fadeOut: 0,
            sourceUrl: fileUrl(audio.fileObjectId),
            editable: false,
          },
        ];
      }
      const audio = (props.variant?.detachedAudios ?? []).find(
        (row) => `detached:${row.id}` === ref.id,
      );
      if (!audio) return [];
      const material = props.materials.find(
        ({ fileObjectId }) => fileObjectId === audio.fileObjectId,
      );
      return [
        {
          id: ref.id,
          kind: ref.kind,
          label: audio.name,
          start: audio.start,
          duration: audio.duration,
          offset: Math.max(0, audio.offset),
          sourceDuration:
            audio.sourceDuration ?? material?.duration ?? audio.offset + audio.duration,
            volume: audio.volume,
            fadeIn: audio.fadeIn ?? 0,
            fadeOut: audio.fadeOut ?? 0,
          sourceUrl: detachedAudioSourceUrl(audio, props.materials, props.projectId),
          editable: true,
        },
      ];
    },
  );
});
// Captions are their own cards, so they carry no waveform and no audio geometry.
const timelineCaptionEntries = computed(() =>
  timelineCaptions.value.map((caption) => ({ caption, id: `caption:${caption.id}` })),
);
/**
 * A clip's row is stored on the variant, so the rows are the user's arrangement rather than
 * something the packer infers — exactly how video lanes work. `audioRowOf` is the shared
 * definition, so the row drawn here, the row muted here and the row persisted all agree.
 */
const audioRefs = computed<AudioClipRef[]>(() =>
  timelineAudioClipRefs(props.variant, props.packaging, props.materials, props.projectId),
);
const audioRowOf = (clipId: string): number =>
  audioRowOfClip(audioRefs.value, props.variant?.audioLanes, clipId);
const audioRowCount = computed(() => audioRowCountOf(audioRefs.value, props.variant?.audioLanes));
const audiosForTrack = (track: AudioTrack): TimelineAudio[] =>
  timelineAudios.value.filter((audio) => audioRowOf(audio.id) === audioRowOfKey(track));

/** One head or tail, tagged with the block it belongs to so a drag can skip its own. */
type SnapEdge = { ownerId: string; time: number };
/**
 * Every head and tail on the timeline — video slots, captions and voice/BGM blocks alike — so a
 * block dragged on any lane can line up with a block on any other. The timeline's own end is left
 * out on purpose: it is derived from the clips, so while a drag stretches it the tail would find
 * itself there and snap to nothing.
 */
const snapEdges = computed<SnapEdge[]>(() => {
  const edges: SnapEdge[] = [{ ownerId: '', time: 0 }];
  for (const row of layoutSlots.value) {
    edges.push({ ownerId: row.id, time: row.start }, { ownerId: row.id, time: row.end });
  }
  for (const entry of timelineCaptionEntries.value) {
    edges.push(
      { ownerId: entry.id, time: entry.caption.start },
      { ownerId: entry.id, time: entry.caption.end },
    );
  }
  for (const audio of timelineAudios.value) {
    edges.push(
      { ownerId: audio.id, time: audio.start },
      { ownerId: audio.id, time: audio.start + audio.duration },
    );
  }
  return edges;
});
/** Where the guide line is drawn, as a time so one value serves every lane's own origin. */
const snapGuideTime = ref<number | null>(null);
const snapGuideLeft = computed(() =>
  snapGuideTime.value === null ? null : snapGuideTime.value * pixelsPerSecond.value,
);
/**
 * Lines a dragged block's head or tail up with the nearest other head or tail, and reports the edge
 * it caught so the guide is drawn exactly where the two meet. `ignored` keeps a block from snapping
 * to itself or to the rest of the group travelling with it; `window` is the span the caller already
 * lets the start take, because a snap that would leave it is not a snap the user can see.
 */
const snapDraggedBlock = (
  rawStart: number,
  duration: number,
  ignored: Set<string>,
  window: { maxStart: number; minStart: number },
): { guide: number | null; start: number } => {
  if (!snapEnabled.value) return { guide: null, start: rawStart };
  const threshold = 7 / pixelsPerSecond.value;
  let best: { distance: number; guide: number; start: number } | null = null;
  for (const edge of snapEdges.value) {
    if (ignored.has(edge.ownerId)) continue;
    // The head leads the block; the tail trails it by its own length, so one pass covers both ends.
    for (const [offset, probe] of [
      [0, rawStart],
      [duration, rawStart + duration],
    ] as const) {
      const start = edge.time - offset;
      const distance = Math.abs(edge.time - probe);
      if (distance > threshold || start < window.minStart || start > window.maxStart) continue;
      if (best && best.distance <= distance) continue;
      best = { distance, guide: edge.time, start };
    }
  }
  return best ? { guide: best.guide, start: best.start } : { guide: null, start: rawStart };
};
/**
 * Lines one moving edge up with the nearest other head or tail. A trim drags a single end of a block
 * rather than the whole of it, so it cannot use `snapDraggedBlock`'s head-and-tail pair; the guide is
 * reported the same way, so a trim and a move draw the identical line. `window` is the span the
 * caller already lets that end take, because a snap that would leave it is not a snap the user sees.
 */
const snapEdgeTime = (
  time: number,
  ignored: Set<string>,
  window: { max: number; min: number },
): { guide: number | null; time: number } => {
  if (!snapEnabled.value) return { guide: null, time };
  const threshold = 7 / pixelsPerSecond.value;
  let best: { distance: number; guide: number } | null = null;
  for (const edge of snapEdges.value) {
    if (ignored.has(edge.ownerId)) continue;
    const distance = Math.abs(edge.time - time);
    if (distance > threshold || edge.time < window.min || edge.time > window.max) continue;
    if (best && best.distance <= distance) continue;
    best = { distance, guide: edge.time };
  }
  return best ? { guide: best.guide, time: best.guide } : { guide: null, time };
};

/** How close, in px, the pointer must come to a track border before it becomes an insert target. */
const TRACK_INSERT_THRESHOLD = 6;
/**
 * Audio rows are hit on their own edges rather than on a gap between clips, and the row is only one
 * lane tall, so the band has to be a slice of the row instead of the few pixels a video's gap gives.
 * A quarter of a row each side leaves the middle half still meaning "use this row".
 */
const AUDIO_INSERT_THRESHOLD = Math.round(AUDIO_LANE_HEIGHT / 4);
/** Video rows sit on a fixed pitch, and a clip is inset inside its own row. */
const VIDEO_LANE_PITCH = 70;
const VIDEO_CLIP_INSET = 7;
/**
 * One border between two rows, and the row a drop on it should open. A video border opens a video
 * row, an audio border opens an audio one, and a caption border gives a subtitle a row of its own —
 * the kinds are never each other's target, which is what keeps music under the picture however it
 * was dropped.
 */
type TrackInsertTarget =
  | { kind: 'VIDEO'; lane: number; top: number }
  | { kind: 'AUDIO'; row: number; top: number }
  | { kind: 'CAPTION'; lane: number; top: number };
const trackInsertTarget = ref<TrackInsertTarget | null>(null);
/** Which borders a given drag is allowed to see: a clip opens a video row, music opens an audio one. */
const VIDEO_INSERT_KINDS: ReadonlySet<TrackInsertTarget['kind']> = new Set(['VIDEO']);
const AUDIO_INSERT_KINDS: ReadonlySet<TrackInsertTarget['kind']> = new Set(['AUDIO']);
const CAPTION_INSERT_KINDS: ReadonlySet<TrackInsertTarget['kind']> = new Set(['CAPTION']);
/**
 * Where the guide is drawn, in canvas pixels. Kept as a client-space position and resolved here so
 * the line stays glued to the border it marks even if the viewport scrolls mid-drag.
 */
const trackInsertGuideTop = computed(() => {
  const target = trackInsertTarget.value;
  const element = canvas.value;
  if (!target || !element) return null;
  return target.top - element.getBoundingClientRect().top;
});
/**
 * The track border the pointer is on, if any. Every video row contributes its top edge plus one
 * final edge below the last row, so a clip can also be dropped past everything that is there. A
 * caption row owns no video rows, so both of its edges create the first video row instead — unless
 * it is a subtitle being dragged, which reads the same edges as rows of its own kind. Audio rows
 * contribute their own edges the same way, one row further down per border.
 */
const trackInsertTargetFrom = (
  clientY: number,
  kinds: ReadonlySet<TrackInsertTarget['kind']>,
): TrackInsertTarget | null => {
  const candidates: TrackInsertTarget[] = [];
  const videoElement = videoTrack.value;
  if (videoElement && kinds.has('VIDEO')) {
    const bounds = videoElement.getBoundingClientRect();
    // The border is the centre of the gap two neighbouring clips leave between them.
    const first = bounds.top + VIDEO_CLIP_INSET - 4;
    for (let lane = 0; lane <= videoLaneCount.value; lane += 1) {
      candidates.push({ kind: 'VIDEO', lane, top: first + lane * VIDEO_LANE_PITCH });
    }
  }
  if (kinds.has('VIDEO')) {
    for (const element of captionTrackElements.values()) {
      const bounds = element.getBoundingClientRect();
      candidates.push(
        { kind: 'VIDEO', lane: 0, top: bounds.top },
        { kind: 'VIDEO', lane: 0, top: bounds.bottom },
      );
    }
  }
  if (kinds.has('CAPTION')) {
    for (const [track, element] of captionTrackElements) {
      const bounds = element.getBoundingClientRect();
      const lane = captionLaneOfTrack(track);
      candidates.push(
        { kind: 'CAPTION', lane, top: bounds.top },
        { kind: 'CAPTION', lane: lane + 1, top: bounds.bottom },
      );
    }
  }
  if (kinds.has('AUDIO')) {
    for (const [track, element] of audioTrackElements) {
      const bounds = element.getBoundingClientRect();
      const row = audioRowOfKey(track);
      // The row below the last one has no top edge of its own, so the bottom edge opens it.
      candidates.push(
        { kind: 'AUDIO', row, top: bounds.top },
        { kind: 'AUDIO', row: row + 1, top: bounds.bottom },
      );
    }
  }
  let best: TrackInsertTarget | null = null;
  let bestDistance = kinds.has('AUDIO') ? AUDIO_INSERT_THRESHOLD : TRACK_INSERT_THRESHOLD;
  for (const candidate of candidates) {
    const distance = Math.abs(candidate.top - clientY);
    if (distance > bestDistance) continue;
    best = candidate;
    bestDistance = distance;
  }
  return best;
};
/**
 * The drop column as a time. `snap` is off for a drop that opens a row of its own: that clip is a free
 * placement which may overlap what is already there, so pulling it up against a neighbour's edge — the
 * whole point of the magnetic snap — would land it somewhere other than where it was let go.
 */
const dropTimeFromClientX = (clientX: number, snap = true): number => {
  const element = viewport.value;
  if (!element) return 0;
  const bounds = element.getBoundingClientRect();
  const raw = Math.max(0, (clientX - bounds.left + element.scrollLeft) / pixelsPerSecond.value);
  return snap ? snapTime(raw) : quantizeToFrame(raw);
};

// Keep one baseline caption lane visible, then give every additional lane its own row/header.
const hasCaptionTrack = computed(() => true);
const trackHeight = (track: VisibleTrack): number =>
  track === 'VIDEO'
    ? videoLaneCount.value * 70 + 6
    : isCaptionTrack(track)
      ? CAPTION_LANE_HEIGHT
      : // An audio row is exactly one lane tall on purpose: the drag ghost rounds its vertical
        // position by dividing by AUDIO_LANE_HEIGHT, so any extra padding here would make the row
        // it lands on drift away from the row it looks like it is on.
        AUDIO_LANE_HEIGHT;
/**
 * One row per occupied audio lane, plus a baseline row when nothing is on the audio area at all —
 * the same shape video lanes take. An empty row simply stops existing, so a project that never
 * separated its original audio never shows a spare track.
 */
const audioTracks = computed<AudioTrack[]>(() =>
  Array.from({ length: audioRowCount.value }, (_, row) => audioRowKey(row)),
);
const captionTracks = computed<CaptionTrack[]>(() =>
  Array.from({ length: captionLaneCount.value }, (_, lane) => captionTrackKey(lane)),
);
const expandedPrimaryTracks = computed<VisibleTrack[]>(() =>
  trackOrder.value.flatMap((track) => (track === 'CAPTION' ? captionTracks.value : [track])),
);
const orderedTracks = computed<VisibleTrack[]>(() => [
  ...expandedPrimaryTracks.value,
  ...audioTracks.value,
]);
const visiblePrimaryTracks = computed(() => expandedPrimaryTracks.value);
const setVideoTrackElement = (element: unknown): void => {
  const candidates = Array.isArray(element) ? element : [element];
  videoTrack.value =
    candidates.find((candidate): candidate is HTMLElement => candidate instanceof HTMLElement) ??
    null;
};
const setCaptionTrackElement = (track: CaptionTrack, element: unknown): void => {
  const candidates = Array.isArray(element) ? element : [element];
  const target =
    candidates.find((candidate): candidate is HTMLElement => candidate instanceof HTMLElement) ??
    null;
  if (target) captionTrackElements.set(track, target);
  else captionTrackElements.delete(track);
};
const setAudioTrackElement = (track: AudioTrack, element: unknown): void => {
  const candidates = Array.isArray(element) ? element : [element];
  const target =
    candidates.find((candidate): candidate is HTMLElement => candidate instanceof HTMLElement) ??
    null;
  if (target) audioTrackElements.set(track, target);
  else audioTrackElements.delete(track);
};

const rangeForSlot = (slotId: string): { start: number; end: number } | null =>
  layoutSlots.value.find((item) => item.id === slotId) ?? null;

const edgeTrimBlocked = (slotId: string): boolean =>
  props.readOnly || trackLocked.VIDEO || !materialForSlot(slotId);

const transitionDurationFor = (slotId: string): number => {
  const slots = props.variant?.slots ?? [];
  const index = slots.findIndex(({ id }) => id === slotId);
  const slot = index >= 0 ? slots[index] : null;
  if (!slot || index === 0) return 0;
  return effectTemplateMixTransitionDuration(slot, slots[index - 1]);
};

const transitionStyle = (slot: EffectTemplateMixSlot): Record<string, string> => {
  const range = rangeForSlot(slot.id);
  const activeDrag = transitionDrag.value?.slotId === slot.id ? transitionDrag.value : null;
  const duration = activeDrag?.currentDuration ?? transitionDurationFor(slot.id);
  return {
    left: `${(range?.start ?? 0) * pixelsPerSecond.value}px`,
    top: `${7 + clipLane(slot.id) * 70}px`,
    width: `${Math.max(16, duration * pixelsPerSecond.value)}px`,
  };
};

const clipStyle = (slot: EffectTemplateMixSlot): Record<string, string> => {
  const range = rangeForSlot(slot.id);
  const edgeTrim = edgeTrimDrag.value?.slotId === slot.id ? edgeTrimDrag.value : null;
  const drag = clipDrag.value;
  const delta = draggingGroupDelta.value;
  const isDraggedSelection = Boolean(delta) && selectedClipIds.value.includes(slot.id);
  const isVideoDragMember = Boolean(drag?.selectedSlotIds.includes(slot.id));
  const start = edgeTrim
    ? edgeTrim.currentStart
    : isDraggedSelection
      ? Math.max(0, (drag?.initialStarts[slot.id] ?? range?.start ?? 0) + (delta?.start ?? 0))
      : (range?.start ?? clipStart(slot.id));
  const top = isVideoDragMember
    ? 7 + (drag?.initialLanes[slot.id] ?? clipLane(slot.id)) * 70 + (delta?.topPx ?? 0)
    : 7 + clipLane(slot.id) * 70;
  return {
    left: `${start * pixelsPerSecond.value}px`,
    top: `${Math.max(0, top)}px`,
    width: `${Math.max(24, (edgeTrim?.currentDuration ?? slot.duration) * pixelsPerSecond.value)}px`,
  };
};

const formatRulerTime = (seconds: number): string => {
  const safe = Math.max(0, seconds);
  const minutes = Math.floor(safe / 60)
    .toString()
    .padStart(2, '0');
  const remainder = Math.floor(safe % 60)
    .toString()
    .padStart(2, '0');
  return `${minutes}:${remainder}`;
};

const formatTimecode = (seconds: number): string => {
  const frames = Math.max(0, Math.round(seconds * props.fps));
  const frame = (frames % props.fps).toString().padStart(2, '0');
  const totalSeconds = Math.floor(frames / props.fps);
  const second = (totalSeconds % 60).toString().padStart(2, '0');
  const minute = (Math.floor(totalSeconds / 60) % 60).toString().padStart(2, '0');
  const hour = Math.floor(totalSeconds / 3600)
    .toString()
    .padStart(2, '0');
  return `${hour}:${minute}:${second}:${frame}`;
};

const activeTrimOffset = (slotId: string): number =>
  edgeTrimDrag.value?.slotId === slotId
    ? edgeTrimDrag.value.currentOffset
    : trimDrag.value?.slotId === slotId
      ? trimDrag.value.currentOffset
      : (props.variant?.offsets[slotId] ?? 0);

const activeSlotDuration = (slotId: string): number =>
  edgeTrimDrag.value?.slotId === slotId
    ? edgeTrimDrag.value.currentDuration
    : (props.variant?.slots.find((slot) => slot.id === slotId)?.duration ?? 0);

const activeClipStart = (slotId: string): number =>
  edgeTrimDrag.value?.slotId === slotId ? edgeTrimDrag.value.currentStart : clipStart(slotId);

const waveformBarCount = (slot: EffectTemplateMixSlot): number =>
  Math.max(28, Math.min(240, Math.ceil((activeSlotDuration(slot.id) * pixelsPerSecond.value) / 2)));

const audioWaveformBarCount = (seconds: number): number =>
  Math.max(24, Math.min(320, Math.ceil((seconds * pixelsPerSecond.value) / 2)));

/**
 * The strip is a dB scale, the same one the editor's row above shows: the pointer's height picks a
 * decibel and the gain that decibel stands for is what gets stored. Drawing the raw gain instead
 * would put unity — a normal level — near the bottom of the strip and read as almost silent.
 */
const audioDbSpan = PACKAGING_AUDIO_DB_CEILING - PACKAGING_AUDIO_DB_FLOOR;
const audioLevel = (volume: number): number => packagingAudioLevel(volume);

const activeAudioDrag = (id: string): AudioDragState | null =>
  audioDrag.value?.id === id ? audioDrag.value : null;

const audioClipStyle = (audio: TimelineAudio): Record<string, string> => {
  const drag = activeAudioDrag(audio.id);
  const groupDelta = draggingGroupDelta.value?.start ?? 0;
  const start = drag
    ? drag.currentStart
    : audio.start + (selectedAudioIds.value.includes(audio.id) ? groupDelta : 0);
  const duration = drag ? drag.currentDuration : audio.duration;
  // A clip is drawn inside its own row, so its vertical travel is measured against the row it
  // started on: `ghostTop` is the ghost's top in the audio area's own coordinates, and subtracting
  // the row it started on turns that back into an offset inside that row's element. The ghost is
  // free to cross the first and last rows — the row it lands on is only decided on release — which
  // is why this is a pixel distance rather than a row count.
  const initialRow = drag?.initialRows[audio.id];
  const top =
    drag && drag.mode === 'MOVE' && initialRow !== undefined
      ? drag.ghostTop - initialRow * AUDIO_LANE_HEIGHT
      : AUDIO_CLIP_INSET;
  return {
    height: `${AUDIO_CLIP_HEIGHT}px`,
    left: `${Math.max(0, start) * pixelsPerSecond.value}px`,
    top: `${top}px`,
    width: `${Math.max(14, duration * pixelsPerSecond.value)}px`,
  };
};

const audioVolumeLineStyle = (audio: TimelineAudio): Record<string, string> => {
  const drag = activeAudioDrag(audio.id);
  const volume = drag ? drag.currentVolume : audio.volume;
  return { top: `${(1 - audioLevel(volume)) * 100}%` };
};

const audioGain = (audio: TimelineAudio): number => {
  const drag = activeAudioDrag(audio.id);
  return audioLevel(drag?.currentVolume ?? audio.volume);
};

const audioFadeStyle = (audio: TimelineAudio, side: 'LEFT' | 'RIGHT'): Record<string, string> => {
  const drag = activeAudioDrag(audio.id);
  const duration = drag?.currentDuration ?? audio.duration;
  const fade = Math.min(side === 'LEFT' ? audio.fadeIn : audio.fadeOut, duration);
  return { width: `${Math.max(0, fade * pixelsPerSecond.value)}px` };
};

const trackVisible = (track: 'CAPTION' | 'VIDEO'): boolean =>
  track === 'VIDEO' ? props.videoVisible : props.captionVisible;

const toggleTrackVisible = (track: 'CAPTION' | 'VIDEO'): void => {
  emit('toggleTrackVisibility', track, !trackVisible(track));
};

/** Each audio row owns its mute, so silencing one row leaves every other row playing. */
const trackMuted = (track: AudioTrack | 'VIDEO'): boolean =>
  track === 'VIDEO' ? props.videoMuted : (props.audioRowMuted[audioRowOfKey(track)] ?? false);

const captionClipStyle = (caption: EffectTemplateMixCaption): Record<string, string> => {
  const captionId = `caption:${caption.id}`;
  const drag = activeAudioDrag(captionId);
  const groupDelta = draggingGroupDelta.value?.start ?? 0;
  const start = drag
    ? drag.currentStart
    : caption.start + (selectedAudioIds.value.includes(captionId) ? groupDelta : 0);
  const duration = drag ? drag.currentDuration : caption.end - caption.start;
  // A card is drawn inside its own row, so its vertical travel is measured against the lane it
  // started on: `ghostTop` is the ghost's top in the caption area's own coordinates, and subtracting
  // that lane turns it back into an offset inside that row's element. The ghost is free to cross the
  // first and last rows — the row it lands on is only decided on release.
  const initialLane = drag?.initialRows[`caption:${caption.id}`];
  const top =
    drag && drag.mode === 'MOVE' && initialLane !== undefined
      ? drag.ghostTop - initialLane * CAPTION_LANE_HEIGHT
      : AUDIO_CLIP_INSET;
  return {
    height: `${CAPTION_CLIP_HEIGHT}px`,
    left: `${Math.max(0, start) * pixelsPerSecond.value}px`,
    top: `${top}px`,
    width: `${Math.max(14, duration * pixelsPerSecond.value)}px`,
  };
};

const quantizeToFrame = (seconds: number): number => Math.round(seconds * props.fps) / props.fps;

const snapTime = (seconds: number): number => {
  const frameTime = quantizeToFrame(seconds);
  if (!snapEnabled.value) return frameTime;
  const threshold = 7 / pixelsPerSecond.value;
  const targets = [
    0,
    timelineDuration.value,
    ...layoutSlots.value.flatMap(({ start, end }) => [start, end]),
  ];
  return targets.reduce(
    (best, target) =>
      Math.abs(target - seconds) <= threshold &&
      Math.abs(target - seconds) < Math.abs(best - seconds)
        ? target
        : best,
    frameTime,
  );
};

const seekFromClientX = (clientX: number): void => {
  const element = viewport.value;
  if (!element) return;
  const bounds = element.getBoundingClientRect();
  const raw = (clientX - bounds.left + element.scrollLeft) / pixelsPerSecond.value;
  emit('seek', Math.max(0, Math.min(timelineDuration.value, snapTime(raw))));
};

const videoLaneAtClientY = (clientY: number): number | null => {
  const bounds = videoTrack.value?.getBoundingClientRect();
  if (!bounds || !Number.isFinite(clientY) || clientY < bounds.top || clientY > bounds.bottom) return null;
  const row = Math.max(0, Math.min(videoLaneCount.value - 1, Math.floor((clientY - bounds.top - 3) / 70)));
  return occupiedVideoLaneValues.value[row] ?? 0;
};
const slotIdFromDragEvent = (event: DragEvent): string => {
  const target =
    event.target instanceof Element ? event.target.closest<HTMLElement>('[data-slot-id]') : null;
  if (target?.dataset.slotId) return target.dataset.slotId;
  const lane = videoLaneAtClientY(event.clientY);
  const element = viewport.value;
  const dropSlots = props.variant
    ? packagingTimelineClips(props.variant)
        .filter(
          ({ slot }) => props.variant!.bindings[slot.id] ||
            props.variant!.intentionallyEmptySlotIds?.includes(slot.id),
        )
        .filter(({ slot }) => lane === null || Math.max(0, Math.round(props.variant!.videoLanes?.[slot.id] ?? 0)) === lane)
        .map(({ slot, start, end }) => ({ id: slot.id, start, end }))
    : [];
  if (!element || !dropSlots.length) return '';
  const bounds = element.getBoundingClientRect();
  const time = (event.clientX - bounds.left + element.scrollLeft) / pixelsPerSecond.value;
  return (
    dropSlots.find(({ start, end }) => time >= start && time < end)?.id ??
    ''
  );
};

const acceptsMaterialDrag = (event: DragEvent): boolean =>
  Boolean(
    props.variant &&
    !props.readOnly &&
    !trackLocked.VIDEO &&
    event.dataTransfer?.types.includes('application/x-effect-template-mix-material'),
  );

const onMaterialDragOver = (event: DragEvent): void => {
  if (!acceptsMaterialDrag(event)) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  const target = trackInsertTargetFrom(event.clientY, VIDEO_INSERT_KINDS);
  trackInsertTarget.value = target;
  // A border and a slot are two answers to one gesture, so only ever show one of them.
  materialDropSlotId.value = target ? '' : slotIdFromDragEvent(event);
};

/**
 * A caption row is never a slot, so it accepts a library clip only as an insert target — anywhere
 * else the drag stays refused and the drop falls through to nothing, as it always did.
 */
const onCaptionTrackDragOver = (event: DragEvent): void => {
  if (!acceptsMaterialDrag(event)) return;
  const target = trackInsertTargetFrom(event.clientY, VIDEO_INSERT_KINDS);
  trackInsertTarget.value = target;
  materialDropSlotId.value = '';
  if (!target) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
};

const onMaterialDragLeave = (event: DragEvent): void => {
  const current = event.currentTarget;
  if (
    current instanceof Node &&
    event.relatedTarget instanceof Node &&
    current.contains(event.relatedTarget)
  )
    return;
  materialDropSlotId.value = '';
  trackInsertTarget.value = null;
};

const onMaterialDrop = (event: DragEvent): void => {
  if (!acceptsMaterialDrag(event)) return;
  event.preventDefault();
  const materialId =
    event.dataTransfer?.getData('application/x-effect-template-mix-material') ?? '';
  const target = trackInsertTarget.value;
  const slotId = slotIdFromDragEvent(event) || materialDropSlotId.value;
  trackInsertTarget.value = null;
  materialDropSlotId.value = '';
  if (!materialId) return;
  if (target?.kind === 'VIDEO') {
    // A border drop is a free placement, not a butt-join, so only the frame grid applies to it.
    emit('insertMaterialTrack', materialId, target.lane, dropTimeFromClientX(event.clientX, false));
    return;
  }
  if (!slotId) {
    const lane = videoLaneAtClientY(event.clientY);
    if (lane === null) return;
    emit('placeMaterialTrack', materialId, lane, dropTimeFromClientX(event.clientX, false));
    return;
  }
  setSelection([slotId]);
  emit('assignMaterial', materialId, slotId);
};

const acceptsMusicAssetDrag = (event: DragEvent, track: AudioTrack): boolean =>
  Boolean(
    props.variant &&
    !props.readOnly &&
    !trackLocked[track] &&
    event.dataTransfer?.types.includes('application/x-effect-template-mix-music'),
  );

/**
 * The audio clip under the pointer, if there is one. A drag carries no element of its own over the
 * page, but the event still names what it is over — the same reading the video track takes — so the
 * clip is looked up from the drag itself first. The row's own padding has no clip under it and is
 * resolved from the pointer's time instead, which is the only other place a clip can be.
 */
const audioClipIdAtPoint = (event: DragEvent, track: AudioTrack): string => {
  const target =
    event.target instanceof Element ? event.target.closest<HTMLElement>('.audio-clip') : null;
  if (target?.dataset.audioId) return target.dataset.audioId;
  const time = dropTimeFromClientX(event.clientX, false);
  return (
    audiosForTrack(track).find(
      (audio) => time >= audio.start && time < audio.start + audio.duration,
    )?.id ?? ''
  );
};

/**
 * The clip a library track may take the place of, if the pointer is on one. Only a clip whose source
 * lives on the project draft can be swapped: every other audio clip is a packaging checkpoint whose
 * file the server owns and refuses a replacement for, so offering the swap there would dim a clip the
 * drop then turns down. The pointer falls back to the row for those and the track lands beside them,
 * which is what any other row does.
 */
const replaceableAudioClipId = (clipId: string): string =>
  clipId.startsWith('detached:') ? clipId : '';

const onMusicTrackDragOver = (event: DragEvent, track: AudioTrack): void => {
  // Any audio row takes a library track, so the drop decides the row rather than the clip's kind.
  if (!acceptsMusicAssetDrag(event, track)) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  // A border between two rows, a clip under the pointer and the row itself are three answers to one
  // gesture, so only one of them is ever shown. A border opens a row of its own; a clip that can take
  // the drop is offered it as a replacement of itself, keeping that clip's place and length; anywhere
  // else the track takes the row.
  const target = trackInsertTargetFrom(event.clientY, AUDIO_INSERT_KINDS);
  const clipId = target ? '' : replaceableAudioClipId(audioClipIdAtPoint(event, track));
  trackInsertTarget.value = target;
  musicDropClipId.value = clipId;
  musicDropRow.value = target || clipId ? null : audioRowOfKey(track);
};

const onMusicTrackDragLeave = (event: DragEvent): void => {
  const current = event.currentTarget;
  if (
    current instanceof Node &&
    event.relatedTarget instanceof Node &&
    current.contains(event.relatedTarget)
  )
    return;
  musicDropRow.value = null;
  musicDropClipId.value = '';
  trackInsertTarget.value = null;
};

const onMusicTrackDrop = (event: DragEvent, track: AudioTrack): void => {
  if (!acceptsMusicAssetDrag(event, track)) return;
  event.preventDefault();
  const target = trackInsertTarget.value;
  const replaceClipId = musicDropClipId.value;
  musicDropRow.value = null;
  musicDropClipId.value = '';
  trackInsertTarget.value = null;
  const viewportElement = viewport.value;
  if (!viewportElement) return;
  let data: MusicAssetDrop;
  try {
    data = JSON.parse(
      event.dataTransfer?.getData('application/x-effect-template-mix-music') ?? '',
    ) as MusicAssetDrop;
  } catch {
    return;
  }
  if (
    !data.assetId ||
    !data.fileObjectId ||
    !data.name ||
    !Number.isFinite(data.duration) ||
    data.duration <= 0
  )
    return;
  const bounds = viewportElement.getBoundingClientRect();
  const start = Math.max(
    0,
    (event.clientX - bounds.left + viewportElement.scrollLeft) / pixelsPerSecond.value,
  );
  // Let go on top of a clip: the track takes that clip's place rather than opening a row for itself.
  if (replaceClipId) {
    emit('replaceAudioWithMusic', replaceClipId, data);
    return;
  }
  emit('addMusicAsset', {
    ...data,
    row: audioRowOfKey(track),
    start,
    ...(target?.kind === 'AUDIO' ? { insertRow: target.row } : {}),
  });
};

const syncTrackScroll = (source: 'HEADERS' | 'VIEWPORT'): void => {
  const sourceElement = source === 'HEADERS' ? trackHeaders.value : viewport.value;
  const targetElement = source === 'HEADERS' ? viewport.value : trackHeaders.value;
  if (!sourceElement || !targetElement) return;
  if (Math.abs(targetElement.scrollTop - sourceElement.scrollTop) > 0.5) {
    targetElement.scrollTop = sourceElement.scrollTop;
  }
};

/**
 * The column only moves when it has to: a clip let go under the pointer is already where the user is
 * looking, so scrolling it away would be a jump backwards. What it must guarantee is that the *whole*
 * clip is shown — one dropped near the right edge would otherwise be revealed with its tail cut off.
 * A clip longer than the viewport cannot fit at all, so its head wins and sits a margin in from the edge.
 */
const revealTimelineColumn = (time: number, duration: number): void => {
  const element = viewport.value;
  if (!element) return;
  const margin = 24;
  const left = Math.max(0, time * pixelsPerSecond.value);
  const right = left + Math.max(0, duration) * pixelsPerSecond.value;
  if (right - left > element.clientWidth - margin * 2)
    element.scrollLeft = Math.max(0, left - margin);
  else if (left < element.scrollLeft + margin) element.scrollLeft = Math.max(0, left - margin);
  else if (right > element.scrollLeft + element.clientWidth - margin)
    element.scrollLeft = right - element.clientWidth + margin;
};

/** Brings a newly created video row and the clip on it into view, the way a drop should land visibly. */
const scrollToLane = (lane: number, time: number, duration = 0): void => {
  const element = viewport.value;
  if (!element) return;
  const rowTop = VIDEO_CLIP_INSET + Math.max(0, lane) * VIDEO_LANE_PITCH;
  element.scrollTop = Math.max(0, rowTop - element.clientHeight / 2 + VIDEO_LANE_PITCH / 2);
  revealTimelineColumn(time, duration);
  syncTrackScroll('VIEWPORT');
};

/**
 * Brings an audio row and the clip on it into view. A row opened below the last one is off the bottom
 * of the viewport, so without this the drop would look like it did nothing at all. The row is measured
 * from its own element rather than from a pitch, because the rows above it are only one lane tall.
 */
const scrollToAudioRow = (row: number, time: number, duration = 0): void => {
  const element = viewport.value;
  if (!element) return;
  const top = audioTrackElements.get(audioRowKey(Math.max(0, Math.round(row))))?.getBoundingClientRect()
    .top;
  if (top !== undefined) {
    const rowTop = top - element.getBoundingClientRect().top + element.scrollTop;
    element.scrollTop = Math.max(0, rowTop - element.clientHeight / 2 + AUDIO_LANE_HEIGHT / 2);
  }
  revealTimelineColumn(time, duration);
  syncTrackScroll('VIEWPORT');
};

/**
 * Brings a subtitle's own row into view once it has been given one. Caption rows are drawn as separate
 * strips rather than one tall lane, so the row is measured from the first strip's position plus the
 * lane the caption now occupies.
 */
const scrollToCaption = (captionId: string, time: number, duration = 0): void => {
  const element = viewport.value;
  if (!element) return;
  const lane = captionLaneById.value.get(captionId) ?? 0;
  const first = captionTrackElements.get(captionTrackKey(0))?.getBoundingClientRect();
  if (first) {
    const rowTop =
      first.top - element.getBoundingClientRect().top + element.scrollTop + lane * CAPTION_LANE_HEIGHT;
    element.scrollTop = Math.max(
      0,
      rowTop - element.clientHeight / 2 + CAPTION_LANE_HEIGHT / 2,
    );
  }
  revealTimelineColumn(time, duration);
  syncTrackScroll('VIEWPORT');
};

const startTransitionResize = (event: PointerEvent, slotId: string): void => {
  if (props.readOnly || event.button !== 0 || trackLocked.VIDEO) return;
  const slots = props.variant?.slots ?? [];
  const index = slots.findIndex(({ id }) => id === slotId);
  const slot = index >= 0 ? slots[index] : null;
  if (!slot || index === 0 || slot.transition === '硬切') return;
  const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect();
  const side = event.clientX <= bounds.left + bounds.width / 2 ? 'LEFT' : 'RIGHT';
  event.preventDefault();
  event.stopPropagation();
  emit('openTransition', slotId);
  const initialDuration = transitionDurationFor(slotId);
  transitionDrag.value = {
    currentDuration: initialDuration,
    initialDuration,
    moved: false,
    side,
    slotId,
    startClientX: event.clientX,
  };
  addWindowPointerListeners();
};

const openTransition = (slotId: string): void => {
  if (suppressTransitionClick.value) {
    suppressTransitionClick.value = false;
    return;
  }
  emit('openTransition', slotId);
};
const transitionDragActive = (event: DragEvent): boolean =>
  Boolean(
    props.variant &&
    !props.readOnly &&
    !trackLocked.VIDEO &&
    event.dataTransfer?.types.includes('application/x-effect-transition'),
  );
const transitionTargetSlotIdFromClientX = (clientX: number): string => {
  const slots = props.variant?.slots ?? [];
  const element = viewport.value;
  if (!element || slots.length < 2) return '';
  const bounds = element.getBoundingClientRect();
  const time = (clientX - bounds.left + element.scrollLeft) / pixelsPerSecond.value;
  let bestId = '';
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 1; index < slots.length; index += 1) {
    const slot = slots[index]!;
    const range = rangeForSlot(slot.id);
    if (!range) continue;
    const distance = Math.abs(range.start - time);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestId = slot.id;
    }
  }
  return bestId;
};
const onTransitionDragOver = (event: DragEvent): void => {
  if (!transitionDragActive(event)) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  transitionDropSlotId.value = transitionTargetSlotIdFromClientX(event.clientX);
};
const onTransitionDragLeave = (event: DragEvent): void => {
  const current = event.currentTarget;
  if (
    current instanceof Node &&
    event.relatedTarget instanceof Node &&
    current.contains(event.relatedTarget)
  )
    return;
  transitionDropSlotId.value = '';
};
const onTransitionDrop = (event: DragEvent): void => {
  if (props.readOnly) return;
  const transition = event.dataTransfer?.getData('application/x-effect-transition') ?? '';
  const slotId = transitionTargetSlotIdFromClientX(event.clientX) || transitionDropSlotId.value;
  transitionDropSlotId.value = '';
  if (!slotId) return;
  if (!EFFECT_TEMPLATE_MIX_TRANSITIONS.includes(transition as EffectTemplateMixTransition)) return;
  event.preventDefault();
  emit('applyTransition', slotId, transition as EffectTemplateMixTransition);
};
const onTrackDragOver = (event: DragEvent): void => {
  onMaterialDragOver(event);
  onTransitionDragOver(event);
};
const onTrackDragLeave = (event: DragEvent): void => {
  onMaterialDragLeave(event);
  onTransitionDragLeave(event);
};
const onTrackDrop = (event: DragEvent): void => {
  if (props.readOnly) return;
  onMaterialDrop(event);
  onTransitionDrop(event);
};

const addWindowPointerListeners = (): void => {
  window.addEventListener('pointermove', onWindowPointerMove);
  window.addEventListener('pointerup', onWindowPointerUp, { once: true });
  window.addEventListener('pointercancel', onWindowPointerUp, { once: true });
};

const removeWindowPointerListeners = (): void => {
  window.removeEventListener('pointermove', onWindowPointerMove);
  window.removeEventListener('pointerup', onWindowPointerUp);
  window.removeEventListener('pointercancel', onWindowPointerUp);
};

const onRulerPointerDown = (event: PointerEvent): void => {
  if (event.button !== 0) return;
  event.preventDefault();
  scrubbing.value = true;
  seekFromClientX(event.clientX);
  addWindowPointerListeners();
};

const onPlayheadPointerDown = (event: PointerEvent): void => {
  if (event.button !== 0) return;
  event.preventDefault();
  event.stopPropagation();
  scrubbing.value = true;
  addWindowPointerListeners();
};

const startTimelineResize = (event: PointerEvent): void => {
  if (event.button !== 0) return;
  event.preventDefault();
  event.stopPropagation();
  timelineResize.value = {
    startClientX: event.clientX,
    startValue: trackHeaderWidth.value,
  };
  addWindowPointerListeners();
};

const setSelection = (slotIds: string[]): void => {
  selectedClipIds.value = slotIds;
  emit('selectSlot', slotIds.at(-1) ?? '');
  emit('selectVideoClips', slotIds);
};

const onClipPointerDown = (event: PointerEvent, slotId: string): void => {
  if (event.button !== 0 || trackIsLocked('VIDEO')) return;
  const edgeHandle =
    event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>('.edge-trim-handle')
      : null;
  if (edgeHandle?.disabled) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  const clipElement = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
  if (clipElement) {
    const bounds = clipElement.getBoundingClientRect();
    const edgeThreshold = Math.min(12, Math.max(4, bounds.width * 0.2));
    const nearLeftEdge = event.clientX <= bounds.left + edgeThreshold;
    const nearRightEdge = event.clientX >= bounds.right - edgeThreshold;
    if (
      ((nearLeftEdge || nearRightEdge) && edgeTrimBlocked(slotId))
    ) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
  }
  event.preventDefault();
  event.stopPropagation();
  timelineShell.value?.focus({ preventScroll: true });
  if (event.ctrlKey || event.metaKey) {
    const next = selectedClipIds.value.includes(slotId)
      ? selectedClipIds.value.filter((id) => id !== slotId)
      : [...selectedClipIds.value, slotId];
    setSelection(next);
  } else if (!selectedClipIds.value.includes(slotId)) {
    selectedAudioIds.value = [];
    setSelection([slotId]);
  } else {
    // A restored or already highlighted clip still needs to activate its contextual controls.
    selectedAudioIds.value = [];
    setSelection([...selectedClipIds.value]);
  }
  const element = viewport.value;
  const range = rangeForSlot(slotId);
  if (!element || !range) return;
  if (props.readOnly) return;
  const bounds = element.getBoundingClientRect();
  const selectedSlotIds = selectedClipIds.value.includes(slotId)
    ? [...selectedClipIds.value]
    : [slotId];
  const initialStarts: Record<string, number> = {};
  const initialLanes: Record<string, number> = {};
  for (const selectedId of selectedSlotIds) {
    const selectedRange = rangeForSlot(selectedId);
    if (!selectedRange) continue;
    initialStarts[selectedId] = selectedRange.start;
    initialLanes[selectedId] = clipLane(selectedId);
  }
  clipDrag.value = {
    currentLane: clipLane(slotId),
    currentStart: range.start,
    currentClientX: event.clientX,
    currentClientY: event.clientY,
    ghostTop: 7 + clipLane(slotId) * 70,
    grabOffset:
      event.clientX - bounds.left + element.scrollLeft - range.start * pixelsPerSecond.value,
    insertLane: null,
    initialLanes,
    initialStarts,
    selectedSlotIds,
    selectionModifier: event.ctrlKey || event.metaKey,
    slotId,
    startClientX: event.clientX,
    startClientY: event.clientY,
    started: false,
  };
  addWindowPointerListeners();
};
const onVideoClipContextMenu = (event: MouseEvent, slotId: string): void => {
  if (!materialForSlot(slotId)) return;
  event.preventDefault();
  event.stopPropagation();
  timelineShell.value?.focus({ preventScroll: true });
  selectedAudioIds.value = [];
  setSelection([slotId]);
  clipContextMenu.value = {
    kind: 'VIDEO',
    slotId,
    left: Math.min(event.clientX, window.innerWidth - 208),
    top: Math.min(event.clientY, window.innerHeight - 120),
  };
};
const videoClipboardEntries = (
  slotIds: string[],
): NonNullable<Extract<TimelineClipboard, { kind: 'VIDEO' }>['entries']> =>
  slotIds.flatMap((slotId) => {
    const slot = props.variant?.slots.find(({ id }) => id === slotId);
    const material = slot ? materialForSlot(slotId) : null;
    if (!slot || !material) return [];
    const detachedAudio = props.variant?.detachedAudios?.find(
      (audio) => audio.sourceSlotId === slotId,
    );
    return [
      {
        sourceSlotId: slotId,
        materialId: material.id,
        offset: Math.max(0, props.variant?.offsets[slotId] ?? 0),
        duration: slot.duration,
        ...(props.variant?.videoTransforms?.[slotId] ? { transform: { ...props.variant.videoTransforms[slotId]! } } : {}),
        ...(detachedAudio ? { detachedAudio: { ...detachedAudio } } : {}),
      },
    ];
  });
const copyVideoSlots = (slotIds: string[]): void => {
  const entries = videoClipboardEntries(slotIds);
  if (!entries.length) {
    emit('requestNotice', '所选位置没有可复制的视频素材');
    return;
  }
  timelineClipboard.value = { kind: 'VIDEO', entries };
  emit('requestNotice', `${entries.length} 个视频素材已复制，可切换到同一模板的其他成片粘贴`);
};
const copyAudioClip = (audioId: string): void => {
  const detachedId = audioId.startsWith('detached:') ? audioId.slice('detached:'.length) : '';
  const detached = props.variant?.detachedAudios?.find(({ id }) => id === detachedId);
  let source: {
    fileObjectId: string;
    name: string;
    sourceAssetId?: string;
    audioKind?: 'VOICE' | 'MUSIC' | 'DETACHED';
    loopSource?: boolean;
    sourceDuration: number;
    duration: number;
    offset: number;
    volume: number;
  } | null = detached
    ? {
        fileObjectId: detached.fileObjectId,
        name: detached.name,
        ...(detached.sourceAssetId ? { sourceAssetId: detached.sourceAssetId } : {}),
        ...(detached.audioKind ? { audioKind: detached.audioKind } : {}),
        ...(detached.loopSource !== undefined ? { loopSource: detached.loopSource } : {}),
        sourceDuration: detached.sourceDuration ?? detached.offset + detached.duration,
        duration: detached.duration,
        offset: detached.offset,
        volume: detached.volume,
      }
    : null;
  const packagedMusic = props.packaging?.checkpoint.music;
  if (!source && audioId === 'music' && packagedMusic) {
    const offset = packagedMusic.offset ?? 0;
    source = {
      fileObjectId: packagedMusic.fileObjectId,
      name: '配乐',
      audioKind: 'MUSIC',
      loopSource: true,
      sourceDuration: offset + packagedMusic.duration,
      duration: packagedMusic.duration,
      offset,
      volume: packagedMusic.volume,
    };
  }
  if (!source && audioId === 'music' && props.variant?.bgm) {
    const audio = props.variant.bgm;
    const offset = audio.offset ?? 0;
    source = {
      fileObjectId: audio.fileObjectId,
      name: '配乐',
      audioKind: 'MUSIC',
      loopSource: true,
      sourceDuration: offset + audio.duration,
      duration: audio.duration,
      offset,
      volume: audio.volume,
    };
  }
  if (!source && audioId === 'voice' && props.variant?.voice) {
    const audio = props.variant.voice;
    const offset = audio.offset ?? 0;
    source = {
      fileObjectId: audio.fileObjectId,
      name: '口播',
      audioKind: 'VOICE',
      sourceDuration: offset + audio.duration,
      duration: audio.duration,
      offset,
      volume: audio.volume,
    };
  }
  if (!source && audioId.startsWith('voice:')) {
    const lineId = audioId.slice('voice:'.length);
    const audio = props.packaging?.checkpoint.voices?.[lineId];
    if (audio) {
      const offset = audio.offset ?? 0;
      source = {
        fileObjectId: audio.fileObjectId,
        name: '口播',
        audioKind: 'VOICE',
        sourceDuration: offset + audio.duration,
        duration: audio.duration,
        offset,
        volume: audio.volume,
      };
    }
  }
  if (!source && audioId.startsWith('capvoice:')) {
    const captionId = audioId.slice('capvoice:'.length);
    const audio = props.packaging?.checkpoint.captionVoices?.[captionId];
    if (audio) {
      const offset = audio.offset ?? 0;
      source = {
        fileObjectId: audio.fileObjectId,
        name: '字幕口播',
        audioKind: 'VOICE',
        sourceDuration: offset + audio.duration,
        duration: audio.duration,
        offset,
        volume: audio.volume,
      };
    }
  }
  if (!source) {
    emit('requestNotice', '当前音频素材无法复制');
    return;
  }
  timelineClipboard.value = { kind: 'AUDIO', audio: source };
  emit('requestNotice', '音频素材已复制，可切换到同一模板的其他成片粘贴');
};
const contextAudioDetached = (): boolean =>
  Boolean(
    clipContextMenu.value?.slotId &&
    props.variant?.detachedAudios?.some(
      (audio) => audio.sourceSlotId === clipContextMenu.value?.slotId,
    ),
  );
const canPasteAtContext = computed(() =>
  Boolean(
    !props.readOnly &&
    (((clipContextMenu.value?.kind === 'VIDEO' || clipContextMenu.value?.kind === 'EMPTY_VIDEO') &&
      timelineClipboard.value?.kind === 'VIDEO' &&
      clipContextMenu.value.slotId) ||
      ((clipContextMenu.value?.kind === 'AUDIO' || clipContextMenu.value?.kind === 'EMPTY_AUDIO') &&
        timelineClipboard.value?.kind === 'AUDIO')),
  ),
);
const openEmptyTrackContextMenu = (event: MouseEvent, kind: 'VIDEO' | AudioTrack): void => {
  if (!timelineClipboard.value || event.target !== event.currentTarget) return;
  event.preventDefault();
  event.stopPropagation();
  timelineShell.value?.focus({ preventScroll: true });
  const bounds = viewport.value?.getBoundingClientRect();
  const time = bounds
    ? Math.max(
        0,
        Math.min(
          timelineDuration.value,
          (event.clientX - bounds.left + (viewport.value?.scrollLeft ?? 0)) / pixelsPerSecond.value,
        ),
      )
    : Math.max(0, Math.min(timelineDuration.value, props.playhead));
  const selectedTarget = selectedClipIds.value.at(-1) ?? props.selectedSlotId;
  const targetSlotId = kind === 'VIDEO' && selectedTarget && props.variant?.bindings[selectedTarget]
    ? selectedTarget : undefined;
  clipContextMenu.value = {
    kind: kind === 'VIDEO' ? 'EMPTY_VIDEO' : 'EMPTY_AUDIO',
    ...(targetSlotId ? { slotId: targetSlotId } : {}),
    ...(kind === 'VIDEO' ? {} : { pasteRow: audioRowOfKey(kind) }),
    pasteStart: time,
    left: Math.min(event.clientX, window.innerWidth - 208),
    top: Math.min(event.clientY, window.innerHeight - 120),
  };
};
const onAudioClipContextMenu = (event: MouseEvent, audioId: string): void => {
  event.preventDefault();
  event.stopPropagation();
  timelineShell.value?.focus({ preventScroll: true });
  selectedClipIds.value = [];
  selectAudio(audioId);
  clipContextMenu.value = {
    kind: 'AUDIO',
    audioId,
    // A paste on an existing clip's menu continues on that clip's row, so pasting beside a clip
    // never drops the copy onto a different row.
    pasteRow: audioRowOf(audioId),
    left: Math.min(event.clientX, window.innerWidth - 208),
    top: Math.min(event.clientY, window.innerHeight - 92),
  };
};
const pasteVideoSlots = (targetSlotIds: string[]): void => {
  const clipboard = timelineClipboard.value;
  if (props.readOnly || clipboard?.kind !== 'VIDEO' || !targetSlotIds.length) return;
  if (targetSlotIds.length !== clipboard.entries.length) {
    emit('requestNotice', '请选中与复制素材数量相同的目标槽位后再粘贴');
    return;
  }
  emit(
    'pasteVideoMaterials',
    clipboard.entries.map((entry, index) => ({
      materialId: entry.materialId,
      targetSlotId: targetSlotIds[index]!,
      offset: entry.offset,
      duration: entry.duration,
      ...(entry.transform ? { transform: { ...entry.transform } } : {}),
      ...(entry.detachedAudio ? { detachedAudio: { ...entry.detachedAudio } } : {}),
    })),
  );
};
const pasteClipboard = (targetSlotId?: string, start?: number, row?: number): void => {
  const clipboard = timelineClipboard.value;
  if (props.readOnly || !clipboard) return;
  if (clipboard.kind === 'VIDEO') {
    const slots = (props.variant?.slots ?? []).filter(({ id }) => props.variant?.bindings[id]);
    const targets = selectedClipIds.value.length
      ? selectedClipIds.value
      : targetSlotId
        ? [targetSlotId]
        : props.selectedSlotId && props.variant?.bindings[props.selectedSlotId]
          ? [props.selectedSlotId]
          : [];
    if (targets.length === clipboard.entries.length) {
      pasteVideoSlots(targets);
      return;
    }
    const first = targets[0] ?? props.selectedSlotId;
    const startIndex = slots.findIndex(({ id }) => id === first);
    if (startIndex < 0 || startIndex + clipboard.entries.length > slots.length) {
      emit('requestNotice', '目标成片没有足够的素材槽位用于粘贴');
      return;
    }
    pasteVideoSlots(
      slots.slice(startIndex, startIndex + clipboard.entries.length).map(({ id }) => id),
    );
    return;
  }
  const pasteStart = Math.max(0, Math.min(timelineDuration.value, start ?? props.playhead));
  // No row means the paste was started from the keyboard rather than from a row's menu, so the
  // workbench decides which row a fresh copy lands on.
  emit('pasteAudioMaterial', {
    ...clipboard.audio,
    start: pasteStart,
    ...(row === undefined ? {} : { row }),
  });
};
const runClipContextAction = (action: 'COPY' | 'PASTE' | 'SEPARATE'): void => {
  const menu = clipContextMenu.value;
  if (!menu) return;
  clipContextMenu.value = null;
  if (action === 'SEPARATE' && menu.slotId) {
    emit('separateAudio', menu.slotId);
    return;
  }
  if (action === 'COPY') {
    if (menu.slotId && (menu.kind === 'VIDEO' || menu.kind === 'EMPTY_VIDEO'))
      copyVideoSlots([menu.slotId]);
    else if (menu.audioId) copyAudioClip(menu.audioId);
    return;
  }
  pasteClipboard(menu.slotId, menu.pasteStart, menu.pasteRow);
};
const onVideoClipDoubleClick = (event: MouseEvent, slotId: string): void => {
  if (props.readOnly || !materialForSlot(slotId)) return;
  event.preventDefault();
  event.stopPropagation();
  setSelection([slotId]);
  emit('separateAudio', slotId);
};

const beginTrim = (event: PointerEvent, slotId: string): void => {
  if (props.readOnly || event.button !== 0 || trackLocked.VIDEO) return;
  event.preventDefault();
  event.stopPropagation();
  setSelection([slotId]);
  const originalOffset = props.variant?.offsets[slotId] ?? 0;
  trimDrag.value = {
    currentOffset: originalOffset,
    originalOffset,
    slotId,
    startClientX: event.clientX,
  };
  addWindowPointerListeners();
};

const beginEdgeTrim = (event: PointerEvent, slotId: string, side: 'LEFT' | 'RIGHT'): void => {
  if (props.readOnly || event.button !== 0 || trackLocked.VIDEO) return;
  const slot = props.variant?.slots.find(({ id }) => id === slotId);
  const material = slot ? materialForSlot(slotId) : null;
  if (!slot || !material || edgeTrimBlocked(slotId)) return;
  event.preventDefault();
  event.stopPropagation();
  setSelection([slotId]);
  const initialOffset = Math.max(0, props.variant?.offsets[slotId] ?? 0);
  const initialStart = clipStart(slotId);
  edgeTrimDrag.value = {
    currentDuration: slot.duration,
    currentOffset: initialOffset,
    currentStart: initialStart,
    initialDuration: slot.duration,
    initialOffset,
    initialStart,
    moved: false,
    side,
    slotId,
    startClientX: event.clientX,
  };
  snapGuideTime.value = side === 'LEFT' ? initialStart : initialStart + slot.duration;
  (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
  addWindowPointerListeners();
};

/** Top of the first audio row in client coordinates; a drag measures its ghost against it. */
const audioAreaTop = (): number =>
  audioTrackElements.get(audioRowKey(0))?.getBoundingClientRect().top ?? 0;

/**
 * Top of the first caption row in client coordinates. Caption rows are drawn as their own strips
 * rather than as one tall lane, so a subtitle's ghost is measured against the first strip and the
 * lane it started on, the same way an audio clip's is measured against row 0.
 */
const captionAreaTop = (): number =>
  captionTrackElements.get(captionTrackKey(0))?.getBoundingClientRect().top ?? 0;

/**
 * The row a clip currently sits on. An audio clip has a row number of its own; a subtitle's row is
 * the lane it was packed into, which is derived from its track instead of stored on it.
 */
const dragRowOf = (clipId: string): number =>
  clipId.startsWith('caption:')
    ? (captionLaneById.value.get(clipId.slice('caption:'.length)) ?? 0)
    : audioRowOf(clipId);

const beginAudioDrag = (
  event: PointerEvent,
  target: AudioDragTarget,
  mode: AudioDragMode,
  bounds: DOMRect | null,
): void => {
  // A vertical move carries the whole selection, so every member's starting row is frozen here: the
  // release applies one shared row delta, which is what keeps a group from bunching up on the row
  // the pointer happens to be over. A subtitle's row is the lane it was packed into, so it is frozen
  // the same way — the two row kinds are counted in their own heights but never mixed.
  const initialRows: Record<string, number> = {};
  if (mode === 'MOVE') {
    for (const id of [target.id, ...dragGroupIds(target.id)]) initialRows[id] = dragRowOf(id);
  }
  const row = dragRowOf(target.id);
  const caption = target.id.startsWith('caption:');
  audioDrag.value = {
    id: target.id,
    kind: target.kind,
    mode,
    initialStart: target.start,
    initialOffset: target.offset,
    initialDuration: target.duration,
    initialVolume: target.volume,
    initialSourceDuration: target.sourceDuration,
    minStart:
      selectedClipIds.value.length || selectedAudioIds.value.length > 1
        ? target.start - earliestSelectedStart()
        : (target.minStart ?? 0),
    maxEnd: target.maxEnd ?? Number.POSITIVE_INFINITY,
    currentStart: target.start,
    currentOffset: target.offset,
    currentDuration: target.duration,
    currentVolume: target.volume,
    moved: false,
    startClientX: event.clientX,
    startClientY: event.clientY,
    volumeTop: bounds?.top ?? 0,
    volumeHeight: bounds?.height ?? AUDIO_CLIP_HEIGHT,
    currentRow: row,
    insertRow: null,
    insertCaptionTrack: false,
    ghostTop: AUDIO_CLIP_INSET + row * (caption ? CAPTION_LANE_HEIGHT : AUDIO_LANE_HEIGHT),
    initialRows,
  };
  addWindowPointerListeners();
};

const selectAudio = (id: string): void => {
  selectedClipIds.value = [];
  selectedAudioIds.value = [id];
};

/**
 * The voice/BGM blocks currently selected. The caption and audio lanes share one selection list,
 * so this is what keeps a group gesture from reaching across lanes.
 */
const audioGroupIds = (): string[] =>
  selectedAudioIds.value.filter((id) => !id.startsWith('caption:'));

/** The blocks that follow a drag: a lone one moves alone, a selected one carries its whole set. */
const dragGroupIds = (id: string): string[] => {
  if (id.startsWith('caption:')) return captionGroupIds(id);
  const selected = audioGroupIds();
  return selected.length > 1 && selected.includes(id) ? selected : [];
};

const audioEdgeHandleDisabled = (event: PointerEvent): boolean => {
  const handle =
    event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>('.edge-trim-handle')
      : null;
  return Boolean(handle?.disabled);
};

/** A clip is fenced by the row it currently sits on, because locking is a property of the row. */
const audioRowLocked = (clipId: string): boolean =>
  trackIsLocked(audioRowKey(audioRowOf(clipId)));
const isMaterialLocked = (kind: 'VIDEO' | 'AUDIO' | 'CAPTION', id: string): boolean => {
  if (kind === 'VIDEO') return trackIsLocked('VIDEO');
  if (kind === 'CAPTION') return trackIsLocked(captionTrackKey(captionLaneById.value.get(id) ?? 0));
  return audioRowLocked(id);
};

const onAudioPointerDown = (event: PointerEvent, audio: TimelineAudio): void => {
  if (event.button !== 0 || audioRowLocked(audio.id)) return;
  if (audioEdgeHandleDisabled(event)) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  if (event.ctrlKey || event.metaKey) {
    // A modifier click only edits the selection, so it never starts a drag.
    const group = audioGroupIds();
    selectedAudioIds.value = group.includes(audio.id)
      ? selectedAudioIds.value.filter((id) => id !== audio.id)
      : [...selectedAudioIds.value, audio.id];
    return;
  }
  // Clicking one of several selected blocks keeps the set, so the whole group can be dragged.
  if (!selectedAudioIds.value.includes(audio.id)) selectAudio(audio.id);
  else if (selectedAudioIds.value[0] !== audio.id) {
    // The grabbed block leads the set because the editor row reads its volume and fades as the
    // standard the rest of the group takes, so reordering is what makes the pointer the reference.
    selectedAudioIds.value = [audio.id, ...selectedAudioIds.value.filter((id) => id !== audio.id)];
  }
  if (props.readOnly || !audio.editable) return;
  beginAudioDrag(event, audio, 'MOVE', null);
};

const beginAudioTrim = (
  event: PointerEvent,
  audio: AudioDragTarget,
  side: 'LEFT' | 'RIGHT',
): void => {
  if (props.readOnly || event.button !== 0 || audioRowLocked(audio.id)) return;
  event.preventDefault();
  event.stopPropagation();
  selectAudio(audio.id);
  beginAudioDrag(event, audio, side, null);
};

const beginAudioVolume = (event: PointerEvent, audio: TimelineAudio): void => {
  if (props.readOnly || event.button !== 0 || audioRowLocked(audio.id)) return;
  event.preventDefault();
  event.stopPropagation();
  // Volume is the audio counterpart of a caption's size, so a set takes one level together.
  if (!audioGroupIds().includes(audio.id)) selectAudio(audio.id);
  const clip =
    event.currentTarget instanceof Element ? event.currentTarget.closest('.audio-clip') : null;
  beginAudioDrag(event, audio, 'VOLUME', clip?.getBoundingClientRect() ?? null);
};

/**
 * Whether a subtitle would come to rest on top of another card on the row named by `key`. Two cards
 * on one row may never overlap — the checkpoint is rejected (`effect-packaging.domain.ts`) and the
 * renderer refuses the film outright with `字幕越界或重叠` — while two cards on different rows are
 * drawn on different lanes and are free to be on screen together. A landing that collides is
 * answered by giving the card a row of its own, which is the subtitle counterpart of a video clip
 * finding another lane; that is why this asks about the row rather than fencing the drag.
 */
const captionOverlapsTrack = (
  clipId: string,
  start: number,
  duration: number,
  key: string,
  moving: ReadonlySet<string> = new Set([clipId]),
): boolean => {
  const entries = timelineCaptionEntries.value;
  const end = start + duration;
  // The row packer treats two cards as sharing a row when one starts within a frame of the other's
  // end, so the same tolerance is what decides whether this landing is a real overlap.
  return entries.some(
    (entry) =>
      !moving.has(entry.id) &&
      effectTemplateMixCaptionTrackKey(entry.caption) === key &&
      start < entry.caption.end - 1 / props.fps &&
      entry.caption.start < end - 1 / props.fps,
  );
};

/** Whether a subtitle would land on top of another card on the row it is already on. */
const captionOverlapsOwnTrack = (
  clipId: string,
  start: number,
  duration: number,
  moving: ReadonlySet<string> = new Set([clipId]),
): boolean => {
  const dragged = timelineCaptionEntries.value.find((entry) => entry.id === clipId)?.caption;
  if (!dragged) return false;
  return captionOverlapsTrack(
    clipId,
    start,
    duration,
    effectTemplateMixCaptionTrackKey(dragged),
    moving,
  );
};

const captionDragTarget = (caption: EffectTemplateMixCaption): AudioDragTarget => ({
  id: `caption:${caption.id}`,
  kind: 'VOICE',
  start: caption.start,
  offset: 0,
  duration: Math.max(0, caption.end - caption.start),
  volume: 1,
  // Captions are pure text, so nothing of their own limits them: they travel as freely as a video
  // clip, and a landing that would overlap a card on their track is answered with a track of its
  // own rather than by stopping the drag short.
  sourceDuration: Number.POSITIVE_INFINITY,
  minStart: 0,
  maxEnd: Number.POSITIVE_INFINITY,
});

/**
 * The captions that should follow a drag. A lone card moves by itself; a card that is part of a
 * multi-selection carries the whole group with it.
 */
const captionGroupIds = (draggedId: string): string[] => {
  const selected = selectedAudioIds.value.filter((id) => id.startsWith('caption:'));
  return selected.length > 1 && selected.includes(draggedId) ? selected : [];
};
const onCaptionPointerDown = (event: PointerEvent, caption: EffectTemplateMixCaption): void => {
  const lane = captionLaneById.value.get(caption.id) ?? 0;
  if (props.readOnly || event.button !== 0 || trackIsLocked(captionTrackKey(lane))) return;
  if (audioEdgeHandleDisabled(event)) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  const id = `caption:${caption.id}`;
  if (event.ctrlKey || event.metaKey) {
    // A modifier click only edits the selection, so it never starts a drag.
    selectedAudioIds.value = selectedAudioIds.value.includes(id)
      ? selectedAudioIds.value.filter((current) => current !== id)
      : [...selectedAudioIds.value, id];
    return;
  }
  // Clicking one of several selected cards keeps the group, so the whole set can be dragged. The
  // playhead stays put: picking a card is not a scrub, and moving the needle out from under the user
  // made every selection look like a seek.
  if (!selectedAudioIds.value.includes(id)) selectAudio(id);
  if (!audioEditable.value) return;
  beginAudioDrag(event, captionDragTarget(caption), 'MOVE', null);
};

const beginCaptionTrim = (
  event: PointerEvent,
  caption: EffectTemplateMixCaption,
  side: 'LEFT' | 'RIGHT',
): void => {
  const lane = captionLaneById.value.get(caption.id) ?? 0;
  if (props.readOnly || event.button !== 0 || trackLocked[captionTrackKey(lane)]) return;
  event.preventDefault();
  event.stopPropagation();
  selectAudio(`caption:${caption.id}`);
  beginAudioDrag(event, captionDragTarget(caption), side, null);
};

/** Drops every selection this component owns, so a click elsewhere clears the whole editor. */
const clearSelection = (): void => {
  selectedClipIds.value = [];
  selectedAudioIds.value = [];
};
watch(
  [() => props.playhead, () => props.playing],
  () => {
    if (!props.playing) stopPlaybackNeedle();
    else if (!playbackNeedleAnimation) startPlaybackNeedle(props.playhead);
  },
  { flush: 'post' },
);
watch(pixelsPerSecond, () => {
  if (props.playing && playbackNeedleAnimation) {
    startPlaybackNeedle(animatedNeedleSeconds());
  } else setPlaybackNeedle();
});
defineExpose({
  isMaterialLocked,
  clearSelection,
  scrollToAudioRow,
  scrollToCaption,
  scrollToLane,
  setPlaybackNeedle,
  startPlaybackNeedle,
  syncPlaybackNeedleClock,
  stopPlaybackNeedle,
});

/**
 * Anything on the timeline that is not the material itself clears the selection. The ruler and the
 * playhead are the two exceptions: both are scrubbing gestures, so they seek without touching what
 * is selected. A block is the material, and clicking it is how you pick it in the first place.
 */
const onShellPointerDown = (event: PointerEvent): void => {
  clipContextMenu.value = null;
  const target = event.target;
  if (!(target instanceof Element)) return;
  const keep = target.closest(
    '.time-ruler, .timeline-playhead, [data-slot-id], [data-audio-id], .selection-marquee',
  );
  if (keep) return;
  clearSelection();
};

const onTrackPointerDown = (event: PointerEvent, track: VisibleTrack): void => {
  if (event.button !== 0 || event.target !== event.currentTarget || trackIsLocked(track)) return;
  event.preventDefault();
  timelineShell.value?.focus({ preventScroll: true });
  setSelection([]);
  selectedAudioIds.value = [];
  seekFromClientX(event.clientX);
  // A marquee starts on any blank lane and resolves against every visible, unlocked track.
  marquee.value = {
    currentClientX: event.clientX,
    currentClientY: event.clientY,
    moved: false,
    startClientX: event.clientX,
    startClientY: event.clientY,
  };
  addWindowPointerListeners();
};

const updateDragTarget = (clientX: number, clientY: number): void => {
  const drag = clipDrag.value;
  const element = viewport.value;
  if (!drag || !element || !layoutSlots.value.length) return;
  const bounds = element.getBoundingClientRect();
  const rawStart = Math.max(
    0,
    (clientX - bounds.left + element.scrollLeft - drag.grabOffset) / pixelsPerSecond.value,
  );
  drag.currentStart = rawStart;
  // The ghost's own head and tail both get a turn, so a clip can be butted up against a neighbour
  // either way round. A clip cannot be dragged before zero, so that is the only bound here.
  const snapped = snapDraggedBlock(
    rawStart,
    Math.max(0, activeSlotDuration(drag.slotId)),
    new Set([...drag.selectedSlotIds, ...selectedAudioIds.value]),
    {
      maxStart: Number.POSITIVE_INFINITY,
      // Clamp the shared group delta against its earliest member, not against the dragged clip
      // alone, so no selected item can travel before time zero.
      minStart: (drag.initialStarts[drag.slotId] ?? 0) - earliestSelectedStart(),
    },
  );
  drag.currentStart = snapped.start;
  snapGuideTime.value = snapped.guide;
  const videoBounds = videoTrack.value?.getBoundingClientRect();
  // A hidden or collapsed track measures as an all-zero rect, so only a real one describes rows.
  if (videoBounds && videoBounds.height > 0) {
    const mixedSelection = selectedAudioIds.value.length > 0;
    if (mixedSelection) {
      drag.ghostTop = 7 + (drag.initialLanes[drag.slotId] ?? drag.currentLane) * 70;
      drag.currentLane = drag.initialLanes[drag.slotId] ?? drag.currentLane;
    } else {
    // Free vertical travel: the ghost may cross any clip, any row and any neighbouring track, so it is
    // never clamped to the rows that happen to exist, and it follows the pointer pixel for pixel — a
    // row-by-row hop is what made the drag feel stiff. It is measured from a row's centre (the 7px
    // inset plus half of the 62px clip) so the lane it rounds to changes in the gap between two rows
    // rather than the instant it leaves one.
    const pointerTop = clientY - videoBounds.top - 38;
    drag.ghostTop = pointerTop;
    drag.currentLane = Math.round(pointerTop / 70);
    }
  }
  // A border under the pointer means "open a row here", which is a different answer from the row the
  // pointer happens to be inside, so it wins and the guide says so. Only a single clip is offered it:
  // a group slides rigidly, and there is no one row to open for the whole of it.
  const border =
    drag.selectedSlotIds.length === 1 && !selectedAudioIds.value.length
      ? trackInsertTargetFrom(clientY, VIDEO_INSERT_KINDS)
      : null;
  trackInsertTarget.value = border;
  drag.insertLane = border?.kind === 'VIDEO' ? border.lane : null;
  if (drag.insertLane !== null) drag.currentLane = drag.insertLane;
  // Keep the ghost under the pointer while dragging, even when it temporarily
  // overlaps another clip. The parent resolves the final placement on pointerup,
  // matching Jianying's forgiving drag interaction instead of fighting the cursor.
  const edge = 40;
  if (clientX < bounds.left + edge) element.scrollLeft -= 16;
  if (clientX > bounds.right - edge) element.scrollLeft += 16;
};

const updateMarqueeSelection = (): void => {
  const box = marquee.value;
  const element = canvas.value;
  if (!box || !element) return;
  const left = Math.min(box.startClientX, box.currentClientX);
  const right = Math.max(box.startClientX, box.currentClientX);
  const top = Math.min(box.startClientY, box.currentClientY);
  const bottom = Math.max(box.startClientY, box.currentClientY);
  const intersects = (rect: DOMRect): boolean =>
    rect.right >= left && rect.left <= right && rect.bottom >= top && rect.top <= bottom;
  const unlocked = (item: HTMLElement): boolean =>
    !item.closest('.timeline-track')?.classList.contains('is-locked');
  selectedClipIds.value = Array.from(element.querySelectorAll<HTMLElement>('[data-slot-id]'))
    .filter((item) => intersects(item.getBoundingClientRect()) && unlocked(item))
    .map((item) => item.dataset.slotId!)
    .filter((id) => Boolean(materialForSlot(id)));
  selectedAudioIds.value = Array.from(
    element.querySelectorAll<HTMLElement>('.audio-clip[data-audio-id], .caption-clip[data-audio-id]'),
  )
    .filter((item) => intersects(item.getBoundingClientRect()) && unlocked(item))
    .map((item) => item.dataset.audioId!);
};

const timelineStartOfSelectionItem = (id: string): number => {
  if (id.startsWith('caption:'))
    return timelineCaptionEntries.value.find((entry) => entry.id === id)?.caption.start ?? 0;
  return timelineAudios.value.find((audio) => audio.id === id)?.start ?? 0;
};

const earliestSelectedStart = (): number =>
  Math.min(
    ...selectedClipIds.value.map((id) => clipStart(id)),
    ...selectedAudioIds.value.map(timelineStartOfSelectionItem),
  );

function onWindowPointerMove(event: PointerEvent): void {
  if (timelineResize.value) {
    const shellWidth = timelineShell.value?.clientWidth ?? window.innerWidth;
    trackHeaderWidth.value = Math.max(
      88,
      Math.min(
        Math.min(260, Math.max(88, shellWidth - 320)),
        timelineResize.value.startValue + event.clientX - timelineResize.value.startClientX,
      ),
    );
    return;
  }
  if (scrubbing.value) {
    seekFromClientX(event.clientX);
    return;
  }
  if (transitionDrag.value) {
    const drag = transitionDrag.value;
    const slots = props.variant?.slots ?? [];
    const index = slots.findIndex(({ id }) => id === drag.slotId);
    const slot = index >= 0 ? slots[index] : null;
    if (!slot || index === 0) return;
    const delta =
      ((event.clientX - drag.startClientX) / pixelsPerSecond.value) *
      (drag.side === 'LEFT' ? -1 : 1);
    const maxDuration = Math.min(5, slot.duration, slots[index - 1]?.duration ?? slot.duration);
    drag.currentDuration = Math.max(0.1, Math.min(maxDuration, drag.initialDuration + delta));
    drag.moved = Math.abs(event.clientX - drag.startClientX) > 3;
    emit('previewTransitionDuration', drag.slotId, drag.currentDuration);
    return;
  }
  if (clipDrag.value) {
    clipDrag.value.currentClientX = event.clientX;
    clipDrag.value.currentClientY = event.clientY;
    if (
      Math.hypot(
        event.clientX - clipDrag.value.startClientX,
        event.clientY - clipDrag.value.startClientY,
      ) > 4
    ) {
      clipDrag.value.started = true;
    }
    if (clipDrag.value.started) updateDragTarget(event.clientX, event.clientY);
    return;
  }
  if (trimDrag.value) {
    const slot = props.variant?.slots.find(({ id }) => id === trimDrag.value?.slotId);
    const material = slot ? materialForSlot(slot.id) : null;
    if (!slot || !material) return;
    const delta = (event.clientX - trimDrag.value.startClientX) / pixelsPerSecond.value;
    trimDrag.value.currentOffset = Math.max(
      0,
      Math.min(
        material.duration - slot.duration,
        quantizeToFrame(trimDrag.value.originalOffset + delta),
      ),
    );
    return;
  }
  if (edgeTrimDrag.value) {
    const drag = edgeTrimDrag.value;
    const slot = props.variant?.slots.find(({ id }) => id === drag.slotId);
    const material = slot ? materialForSlot(slot.id) : null;
    if (!slot || !material) return;
    let resized = resizeVideoRangeAtEdge({ start: drag.initialStart,
      offset: drag.initialOffset, duration: drag.initialDuration }, material.duration, drag.side,
      (event.clientX - drag.startClientX) / pixelsPerSecond.value, props.fps);
    if (!resized) return;
    const minimum = Math.min(1 / props.fps, drag.initialDuration);
    const movingEdge = drag.side === 'LEFT' ? resized.start : resized.start + resized.duration;
    const snapped = snapEdgeTime(movingEdge, new Set([drag.slotId]), drag.side === 'LEFT'
      ? { min: Math.max(0, drag.initialStart - drag.initialOffset),
          max: drag.initialStart + drag.initialDuration - minimum }
      : { min: drag.initialStart + minimum,
          max: drag.initialStart + material.duration - drag.initialOffset });
    if (snapped.guide !== null) {
      const aligned = resizeVideoRangeAtEdge({ start: drag.initialStart,
        offset: drag.initialOffset, duration: drag.initialDuration }, material.duration, drag.side,
        snapped.time - (drag.side === 'LEFT' ? drag.initialStart : drag.initialStart + drag.initialDuration), props.fps);
      // Only catch a legal frame; a fractional audio edge must not draw a false alignment.
      if (aligned && Math.abs((drag.side === 'LEFT' ? aligned.start : aligned.start + aligned.duration) - snapped.time) < 0.00001)
        resized = aligned;
    }
    drag.currentStart = resized.start;
    drag.currentOffset = resized.offset;
    drag.currentDuration = resized.duration;
    // Draw the actual moving edge even when magnetic snapping is switched off.
    snapGuideTime.value = drag.side === 'LEFT' ? resized.start : resized.start + resized.duration;
    drag.moved = Math.abs(event.clientX - drag.startClientX) > 2;
    return;
  }
  if (audioDrag.value) {
    const drag = audioDrag.value;
    const minimumDuration = Math.min(AUDIO_MIN_DURATION, 1 / props.fps);
    const delta = quantizeToFrame((event.clientX - drag.startClientX) / pixelsPerSecond.value);
    // Nothing a gesture moves may snap to itself, nor to the rest of a group travelling with it.
    const ignoredIds = new Set([
      drag.id,
      ...(selectedAudioIds.value.includes(drag.id)
        ? selectedAudioIds.value
        : dragGroupIds(drag.id)),
      ...selectedClipIds.value,
    ]);
    if (drag.mode === 'VOLUME') {
      const ratio = 1 - (event.clientY - drag.volumeTop) / Math.max(1, drag.volumeHeight);
      // Whole decibels, matching the editor row's step, so the strip and the row agree on the value.
      const db = Math.round(
        PACKAGING_AUDIO_DB_FLOOR + Math.max(0, Math.min(1, ratio)) * audioDbSpan,
      );
      drag.currentVolume = packagingAudioFromDb(db);
    } else if (drag.mode === 'MOVE') {
      // The film is as long as its content, so only the clip's own source tail and its neighbours
      // limit a move — carrying a clip past the last of the material is how the film is extended.
      const maxStart = Math.max(0, drag.maxEnd - drag.initialDuration);
      const requested = Math.max(drag.minStart, Math.min(maxStart, drag.initialStart + delta));
      // One rule for every block: magnetic alignment against the other timeline edges, with the
      // guide line saying what it caught. Subtitles are included — frame quantization above already
      // guarantees a valid frame boundary when the edit is saved, so snapping is a help, not a risk.
      const snapped = snapDraggedBlock(requested, drag.initialDuration, ignoredIds, {
        maxStart,
        minStart: drag.minStart,
      });
      drag.currentStart = snapped.start;
      snapGuideTime.value = snapped.guide;
      // Free vertical travel, exactly like a video clip: the ghost follows the pointer pixel for
      // pixel and may cross every existing row, so the row is deliberately not clamped — landing
      // past the last one is how a new row gets made. It is measured from a row's centre so the row
      // it rounds to changes in the gap between two rows rather than the instant it leaves one. A
      // subtitle travels its own, shorter rows, measured against the caption area rather than the
      // audio one, because the two areas are stacked and only one of them is under the pointer.
      const mixedSelection =
        selectedClipIds.value.length > 0 ||
        (selectedAudioIds.value.some((id) => id.startsWith('caption:')) &&
          selectedAudioIds.value.some((id) => !id.startsWith('caption:')));
      if (drag.initialRows[drag.id] !== undefined && !mixedSelection) {
        const caption = drag.id.startsWith('caption:');
        const areaTop = caption ? captionAreaTop() : audioAreaTop();
        const rowHeight = caption ? CAPTION_LANE_HEIGHT : AUDIO_LANE_HEIGHT;
        const clipHeight = caption ? CAPTION_CLIP_HEIGHT : AUDIO_CLIP_HEIGHT;
        const pointerTop = event.clientY - areaTop - (AUDIO_CLIP_INSET + clipHeight / 2);
        drag.ghostTop = AUDIO_CLIP_INSET + pointerTop;
        drag.currentRow = Math.round(pointerTop / rowHeight);
      }
      // A border under the pointer means "open a row here", which is a different answer from the row
      // the pointer happens to be inside, so it wins and the guide says so. A group slides rigidly, so
      // there is no one row to open for the whole of it and only a lone clip is offered this. A
      // subtitle reads the caption borders, which are the only ones that can give it a row of its own.
      const insertTarget = dragGroupIds(drag.id).length || mixedSelection
        ? null
        : trackInsertTargetFrom(
            event.clientY,
            drag.id.startsWith('caption:') ? CAPTION_INSERT_KINDS : AUDIO_INSERT_KINDS,
          );
      trackInsertTarget.value = insertTarget;
      drag.insertRow = insertTarget?.kind === 'AUDIO' ? insertTarget.row : null;
      drag.insertCaptionTrack = insertTarget?.kind === 'CAPTION';
    } else if (drag.mode === 'LEFT') {
      // An audio clip's head can only reveal source that was trimmed away, so it is pinned to its
      // source in-point. A subtitle is pure text and has no source at all — its `sourceDuration` is
      // infinite — which is what lets its head travel back as freely as a video clip's rather than
      // staying where it already is.
      const headFloor =
        drag.initialSourceDuration === Number.POSITIVE_INFINITY
          ? drag.minStart
          : Math.max(drag.minStart, drag.initialStart - drag.initialOffset);
      const headCeiling = drag.initialStart + drag.initialDuration - minimumDuration;
      const requested = Math.max(headFloor, Math.min(headCeiling, drag.initialStart + delta));
      // A trim draws the same guide a move does, so the head can be parked exactly on the clip it
      // meets rather than a few frames short of it.
      const snapped = snapEdgeTime(requested, ignoredIds, { max: headCeiling, min: headFloor });
      drag.currentStart = snapped.time;
      drag.currentOffset = Math.max(
        0,
        drag.initialOffset + (drag.currentStart - drag.initialStart),
      );
      drag.currentDuration = drag.initialDuration - (drag.currentStart - drag.initialStart);
      snapGuideTime.value = snapped.guide;
    } else {
      drag.currentOffset = drag.initialOffset;
      drag.currentStart = drag.initialStart;
      // Stretching the tail is how a clip is made to reach past the last of the material, so the
      // film's current length is not a bound here either; the ceiling is the rest of the source, and
      // a subtitle has none, so its tail is bounded by nothing but its own minimum length.
      const tailCeiling = Math.min(
        drag.initialStart + drag.initialSourceDuration - drag.initialOffset,
        drag.maxEnd,
      );
      const tailFloor = drag.initialStart + minimumDuration;
      const requested = Math.max(
        tailFloor,
        Math.min(tailCeiling, drag.initialStart + drag.initialDuration + delta),
      );
      const snapped = snapEdgeTime(requested, ignoredIds, { max: tailCeiling, min: tailFloor });
      drag.currentDuration = snapped.time - drag.initialStart;
      snapGuideTime.value = snapped.guide;
    }
    drag.moved =
      Math.abs(event.clientX - drag.startClientX) > 2 ||
      Math.abs(event.clientY - drag.startClientY) > 2;
    return;
  }
  if (marquee.value) {
    marquee.value.currentClientX = event.clientX;
    marquee.value.currentClientY = event.clientY;
    marquee.value.moved =
      Math.hypot(
        event.clientX - marquee.value.startClientX,
        event.clientY - marquee.value.startClientY,
      ) > 4;
    if (marquee.value.moved) updateMarqueeSelection();
  }
}

function onWindowPointerUp(): void {
  const transition = transitionDrag.value;
  if (transition?.moved) {
    suppressTransitionClick.value = true;
    window.setTimeout(() => {
      suppressTransitionClick.value = false;
    }, 120);
    emit('updateTransitionDuration', transition.slotId, transition.currentDuration);
  } else if (transition) {
    openTransition(transition.slotId);
  }
  const drag = clipDrag.value;
  if (drag?.started) {
    const startDelta = drag.currentStart - (drag.initialStarts[drag.slotId] ?? drag.currentStart);
    const laneDelta = drag.currentLane - (drag.initialLanes[drag.slotId] ?? drag.currentLane);
    const moves = drag.selectedSlotIds
      .filter((slotId) => drag.initialStarts[slotId] !== undefined)
      .map((slotId) => ({
        slotId,
        start: (drag.initialStarts[slotId] ?? 0) + startDelta,
        lane: (drag.initialLanes[slotId] ?? 0) + laneDelta,
      }));
    if (selectedAudioIds.value.length) {
      const lead = moves[0];
      const sharedDelta = lead ? lead.start - (drag.initialStarts[lead.slotId] ?? 0) : 0;
      emit('moveTimelineSelection', {
        videos: moves.map((move) => ({
          ...move,
          lane: drag.initialLanes[move.slotId] ?? move.lane,
        })),
        audios: selectedAudioIds.value.map((clipId) => ({
          clipId,
          start: Math.max(0, timelineStartOfSelectionItem(clipId) + sharedDelta),
        })),
      });
    } else if (moves.length > 1) emit('moveClips', moves);
    else if (moves[0])
      emit('moveClip', moves[0].slotId, moves[0].start, moves[0].lane, drag.insertLane ?? undefined);
    // A plain click on one item in a multi-selection collapses the selection;
    // an actual drag keeps the whole group selected for the next operation.
  } else if (
    drag &&
    !drag.selectionModifier &&
    drag.selectedSlotIds.length > 1 &&
    drag.selectedSlotIds.includes(drag.slotId)
  ) {
    setSelection([drag.slotId]);
  }
  if (trimDrag.value) emit('trimSlot', trimDrag.value.slotId, trimDrag.value.currentOffset);
  const edgeTrim = edgeTrimDrag.value;
  if (edgeTrim?.moved) {
    emit(
      'resizeSlot',
      edgeTrim.slotId,
      edgeTrim.side,
      edgeTrim.currentStart,
      edgeTrim.currentOffset,
      edgeTrim.currentDuration,
    );
  }
  if (marquee.value?.moved) {
    emit('selectSlot', selectedClipIds.value.at(-1) ?? '');
    emit('selectVideoClips', selectedClipIds.value);
  }
  const audio = audioDrag.value;
  if (audio?.moved) {
    const isCaption = audio.id.startsWith('caption:');
    const group = dragGroupIds(audio.id);
    if (audio.mode === 'VOLUME') {
      // One scale for every kind, so a shared level needs no per-clip re-clamp.
      if (!group.length) emit('changeAudioVolume', audio.id, audio.currentVolume);
      else for (const id of group) emit('changeAudioVolume', id, audio.currentVolume);
    } else if (
      audio.mode === 'MOVE' &&
      (selectedClipIds.value.length > 0 ||
        (selectedAudioIds.value.some((id) => id.startsWith('caption:')) &&
          selectedAudioIds.value.some((id) => !id.startsWith('caption:'))))
    ) {
      const delta = audio.currentStart - audio.initialStart;
      const sharedDelta = Math.max(delta, -earliestSelectedStart());
      emit('moveTimelineSelection', {
        videos: selectedClipIds.value.flatMap((slotId) => {
          const range = rangeForSlot(slotId);
          return range
            ? [{ slotId, start: Math.max(0, range.start + sharedDelta), lane: clipLane(slotId) }]
            : [];
        }),
        audios: selectedAudioIds.value.map((clipId) => ({
          clipId,
          start: Math.max(0, timelineStartOfSelectionItem(clipId) + sharedDelta),
        })),
      });
    } else if (audio.mode === 'MOVE') {
      const delta = audio.currentStart - audio.initialStart;
      // Every member of the selection rides one shared row delta, so the set keeps its shape
      // vertically as well as horizontally. A subtitle's row is derived from its track rather than
      // stored, so its vertical travel is not reported as a row at all: a row it was not on is
      // answered by minting a track, which is what `splitCaptionTrack` below does.
      const rowMove = audio.initialRows[audio.id] !== undefined;
      const rowDelta = rowMove && !isCaption ? audio.currentRow - audio.initialRows[audio.id]! : 0;
      const rowFor = (id: string): number =>
        Math.max(0, (audio.initialRows[id] ?? audioRowOf(id)) + rowDelta);
      if (!group.length) {
        if (isCaption) {
          const captionId = audio.id.slice('caption:'.length);
          // The rows as they are drawn, so the row the card was let go over can be named rather than
          // guessed at. A drop past either end of them has no key at all, which is the "somewhere
          // there is no row yet" case.
          const own = timelineCaptionEntries.value.find((entry) => entry.id === audio.id)?.caption;
          const ownKey = own ? effectTemplateMixCaptionTrackKey(own) : '';
          const targetKey = effectTemplateMixCaptionRowKeys(timelineCaptions.value, props.fps)[
            audio.currentRow
          ];
          const overlaps = (key: string): boolean =>
            captionOverlapsTrack(audio.id, audio.currentStart, audio.initialDuration, key);
          // A landing that no existing row can take is answered with a track of its own: let go on a
          // row border, let go past the last row, or come to rest on top of a card on the target row.
          // A landing on a row that can take it joins that row instead, which is what lets a card
          // that was sent up to a row of its own come back down again.
          if (
            audio.insertCaptionTrack ||
            targetKey === undefined ||
            (targetKey !== ownKey && overlaps(targetKey))
          )
            emit('splitCaptionTrack', captionId, audio.currentStart);
          else if (targetKey !== ownKey)
            emit('moveCaptionToRow', captionId, audio.currentStart, targetKey);
          else if (overlaps(ownKey)) emit('splitCaptionTrack', captionId, audio.currentStart);
          else emit('moveAudioClip', audio.id, audio.currentStart);
        } else if (audio.insertRow !== null) {
          // Let go on a border: the clip takes the row opened there, and the row it was over is not
          // consulted at all — the border is the answer, exactly as it is for a library track.
          emit('moveAudioClip', audio.id, audio.currentStart, audio.insertRow, audio.insertRow);
        } else if (rowMove) emit('moveAudioClip', audio.id, audio.currentStart, rowFor(audio.id));
        else emit('moveAudioClip', audio.id, audio.currentStart);
      } else if (isCaption) {
        // A group slides rigidly, so the shared delta is capped by the caption nearest the start
        // instead of letting each one clamp on its own and pull the group apart.
        const earliest = Math.min(
          ...group.map(
            (id) => timelineCaptionEntries.value.find((e) => e.id === id)?.caption.start ?? 0,
          ),
        );
        const shared = Math.max(delta, -earliest);
        const moving = new Set(group);
        // A member that would come to rest on a card outside the set is given a track of its own
        // instead of riding along: the set keeps its shape in time, but two cards on one track may
        // never overlap. The set is checked as a whole, so a sibling that is moving too is not what
        // a member is measured against.
        const riders: { clipId: string; start: number }[] = [];
        const split: string[] = [];
        for (const id of group) {
          const entry = timelineCaptionEntries.value.find((item) => item.id === id);
          if (!entry) continue;
          const start = Math.max(0, entry.caption.start + shared);
          const length = entry.caption.end - entry.caption.start;
          if (captionOverlapsOwnTrack(id, start, length, moving)) split.push(id);
          else riders.push({ clipId: id, start });
        }
        // One event for the whole gesture, so the workbench records a single undo step instead of
        // one per caption and the group still lands in the same tick.
        if (riders.length) emit('moveAudioClips', riders);
        for (const id of split)
          emit(
            'splitCaptionTrack',
            id.slice('caption:'.length),
            Math.max(
              0,
              (timelineCaptionEntries.value.find((item) => item.id === id)?.caption.start ?? 0) +
                shared,
            ),
          );
      } else {
        // Voice/BGM blocks slide rigidly too: the delta is bounded by whichever block would leave
        // the timeline first, so the set keeps its shape instead of bunching up at the edges. There
        // is no right-hand bound, because the film grows to whatever the set is dragged out to.
        const clips = group
          .map((id) => timelineAudios.value.find((item) => item.id === id))
          .filter((clip): clip is TimelineAudio => Boolean(clip));
        const earliest = Math.min(...clips.map((clip) => clip.start));
        const shared = Math.max(delta, -earliest);
        const moves = clips.map((clip) => ({
          clipId: clip.id,
          row: rowFor(clip.id),
          start: Math.max(0, clip.start + shared),
        }));
        if (moves.length > 1) emit('moveAudioClips', moves);
        else if (moves[0]) emit('moveAudioClip', moves[0].clipId, moves[0].start, moves[0].row);
      }
    } else
      emit(
        'resizeAudioClip',
        audio.id,
        audio.mode,
        audio.currentStart,
        audio.currentOffset,
        audio.currentDuration,
      );
  }
  scrubbing.value = false;
  snapGuideTime.value = null;
  clipDrag.value = null;
  trackInsertTarget.value = null;
  transitionDrag.value = null;
  trimDrag.value = null;
  edgeTrimDrag.value = null;
  audioDrag.value = null;
  marquee.value = null;
  timelineResize.value = null;
  removeWindowPointerListeners();
}

const setZoom = (raw: number, clientX?: number): void => {
  const element = viewport.value;
  const next = Math.max(24, Math.min(220, raw));
  if (!element || next === pixelsPerSecond.value) {
    pixelsPerSecond.value = next;
    return;
  }
  const bounds = element.getBoundingClientRect();
  const anchor = clientX === undefined ? element.clientWidth / 2 : clientX - bounds.left;
  const anchorTime = (element.scrollLeft + anchor) / pixelsPerSecond.value;
  pixelsPerSecond.value = next;
  void nextTick(() => {
    element.scrollLeft = Math.max(0, anchorTime * pixelsPerSecond.value - anchor);
  });
};

/**
 * Wheel deltas arrive in pixels, lines or pages depending on the device. A line-based mouse reports
 * `deltaY = 3, deltaMode = 1`, which would creep the tracks three pixels a notch — slow enough to
 * read as "the wheel does nothing at all". Normalising to pixels keeps every device scrolling.
 */
const wheelDelta = (event: WheelEvent): number => {
  if (event.deltaMode === 1) return event.deltaY * 16;
  if (event.deltaMode === 2) return event.deltaY * (viewport.value?.clientHeight ?? 0);
  return event.deltaY;
};

const onWheel = (event: WheelEvent): void => {
  event.preventDefault();
  const element = viewport.value;
  if (!element) return;
  const delta = wheelDelta(event);
  if (event.ctrlKey || event.metaKey || event.shiftKey) {
    setZoom(pixelsPerSecond.value * Math.exp(-delta * 0.0018), event.clientX);
    return;
  }
  // The tracks are the only thing that scrolls vertically, so the wheel moves them from anywhere in
  // the timeline — over the lane headers too, which would otherwise swallow it on their own column.
  if (Math.abs(delta) > Math.abs(event.deltaX)) element.scrollTop += delta;
  else element.scrollLeft += event.deltaX;
};

const fitTimeline = async (): Promise<void> => {
  await nextTick();
  const width = viewport.value?.clientWidth ?? viewportWidth.value;
  if (!width) return;
  pixelsPerSecond.value = Math.max(24, Math.min(220, (width - 96) / timelineDuration.value));
  if (viewport.value) viewport.value.scrollLeft = 0;
};

const updateViewportWidth = (): void => {
  viewportWidth.value = viewport.value?.clientWidth ?? 0;
};

const onTimelineKeydown = (event: KeyboardEvent): void => {
  if (event.key === 'Escape' && clipContextMenu.value) {
    clipContextMenu.value = null;
    return;
  }
  if ((event.ctrlKey || event.metaKey) && !event.altKey) {
    const target = event.target;
    const editingText =
      target instanceof Element &&
      Boolean(target.closest('input, textarea, select, [contenteditable="true"]'));
    const key = event.key.toLowerCase();
    if (!editingText && key === 'b') {
      event.preventDefault();
      event.stopPropagation();
      if (props.readOnly) return;
      const selectedAudioId = selectedAudioIds.value.length === 1 ? selectedAudioIds.value[0] : null;
      const hasMultipleSelected =
        selectedAudioIds.value.length > 1 || selectedClipIds.value.length > 1;
      if (hasMultipleSelected) {
        emit('requestNotice', '请一次选择一个素材进行裁剪');
        return;
      }
      if (selectedAudioId) {
        if (selectedAudioId.startsWith('caption:')) {
          const id = selectedAudioId.slice('caption:'.length);
          const caption = timelineCaptions.value.find((item) => item.id === id);
          const lane = caption ? (captionLaneById.value.get(caption.id) ?? 0) : 0;
          if (caption && !trackLocked[captionTrackKey(lane)] &&
            splitRangeAtPlayhead(caption.start, caption.end - caption.start, props.playhead, props.fps)) {
            emit('splitMaterial', { kind: 'CAPTION', id: caption.id }, props.playhead);
          } else emit('requestNotice', '播放针需位于已选字幕内部才能裁剪');
          return;
        }
        const audio = timelineAudios.value.find((item) => item.id === selectedAudioId);
        const track = audioRowKey(audio ? audioRowOf(audio.id) : 0);
        if (audio?.editable && !trackLocked[track] &&
          splitRangeAtPlayhead(audio.start, audio.duration, props.playhead, props.fps)) {
          emit('splitMaterial', { kind: 'AUDIO', id: audio.id }, props.playhead);
        } else emit('requestNotice', '当前音频不可裁剪，或播放针不在素材内部');
        return;
      }
      const selectedSlotId = selectedClipIds.value[0];
      const range = selectedSlotId ? rangeForSlot(selectedSlotId) : null;
      if (
        selectedSlotId &&
        materialForSlot(selectedSlotId) &&
        !trackLocked.VIDEO &&
        range &&
        splitRangeAtPlayhead(range.start, range.end - range.start, props.playhead, props.fps)
      ) {
        emit('splitMaterial', { kind: 'VIDEO', id: selectedSlotId }, props.playhead);
      } else emit('requestNotice', '请先选中素材，并将播放针移到素材内部再裁剪');
      return;
    }
    if (!editingText && key === 'c') {
      event.preventDefault();
      event.stopPropagation();
      if (selectedAudioIds.value.length === 1) {
        if (selectedAudioIds.value[0]!.startsWith('caption:'))
          emit('requestNotice', '字幕不单独复制，以免与口播声音失去同步');
        else copyAudioClip(selectedAudioIds.value[0]!);
      } else if (selectedAudioIds.value.length > 1) {
        emit('requestNotice', '请一次选择一个音频素材进行复制');
      } else {
        copyVideoSlots(
          selectedClipIds.value.length ? selectedClipIds.value : [props.selectedSlotId],
        );
      }
      return;
    }
    if (!editingText && key === 'v') {
      event.preventDefault();
      event.stopPropagation();
      pasteClipboard();
      return;
    }
  }
  if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'a') return;
  event.preventDefault();
  event.stopPropagation();
  setSelection(props.variant?.slots.filter(({ id }) => props.variant?.bindings[id]).map(({ id }) => id) ?? []);
};

watch(
  () => props.selectedSlotId,
  (slotId) => {
    if (slotId && selectedClipIds.value.includes(slotId)) return;
    selectedClipIds.value = slotId ? [slotId] : [];
  },
  { immediate: true },
);

watch(
  () => props.variant?.id,
  () => {
    selectedClipIds.value = props.selectedSlotId ? [props.selectedSlotId] : [];
    selectedAudioIds.value = [];
    void fitTimeline();
  },
);
watch(
  () => props.templateId,
  () => {
    // Keep the clipboard available while switching成片 in this template, but never leak it
    // into another template where its source materials may not belong.
    timelineClipboard.value = null;
  },
);

// Each packaging item owns its own audio, so a selection never carries over.
watch(
  () => props.packaging?.id,
  () => {
    selectedAudioIds.value = [];
  },
);

// The caption text editor lives above the timeline, so it follows this selection. The whole set
// travels too, because a group can be moved and scaled from the preview as one.
watch(
  selectedAudioIds,
  (ids) => {
    emit('selectAudioClip', ids.length === 1 ? ids[0]! : null);
    emit(
      'selectCaptionClips',
      ids.filter((id) => id.startsWith('caption:')).map((id) => id.slice('caption:'.length)),
    );
    // Captions carry their own font-size control, so the audio row only tracks voice and music.
    emit(
      'selectAudioClips',
      ids.filter((id) => !id.startsWith('caption:')),
    );
  },
);

// Mirror a caption picked in the preview. Only a non-null id ever arrives from there, so a group
// selection made here is never collapsed by this component's own echo. Voice and music
// selections are left alone too.
watch(
  () => props.selectedAudioClipId,
  (id) => {
    if (!id) return;
    if (selectedAudioIds.value.some((current) => !current.startsWith('caption:'))) return;
    const next = [id];
    if (selectedAudioIds.value.join() === next.join()) return;
    selectedClipIds.value = [];
    selectedAudioIds.value = next;
  },
);

onMounted(() => {
  setPlaybackNeedle();
  updateViewportWidth();
  resizeObserver = new ResizeObserver(updateViewportWidth);
  if (viewport.value) resizeObserver.observe(viewport.value);
  void fitTimeline();
});

onBeforeUnmount(() => {
  playbackNeedleAnimation?.cancel();
  resizeObserver?.disconnect();
  removeWindowPointerListeners();
});
</script>

<template>
  <section
    ref="timelineShell"
    class="mix-timeline-shell"
    tabindex="0"
    :class="{
      'is-scrubbing': scrubbing,
      'is-resizing-track-header': timelineResize,
    }"
    :style="timelineShellStyle"
    @keydown="onTimelineKeydown"
    @pointerdown="onShellPointerDown"
  >
    <Teleport to="body">
      <div
        v-if="clipContextMenu"
        class="clip-context-menu"
        role="menu"
        :style="{ left: `${clipContextMenu.left}px`, top: `${clipContextMenu.top}px` }"
        @pointerdown.stop
      >
        <button
          v-if="clipContextMenu.kind === 'VIDEO' || clipContextMenu.kind === 'AUDIO'"
          type="button"
          role="menuitem"
          @click="runClipContextAction('COPY')"
        >
          <Copy :size="14" />复制素材
        </button>
        <button
          v-if="clipContextMenu.kind === 'VIDEO'"
          type="button"
          role="menuitem"
          :disabled="props.readOnly"
          @click="runClipContextAction('SEPARATE')"
        >
          {{ contextAudioDetached() ? '恢复视频原声' : '分离音频' }}
        </button>
        <button
          v-if="canPasteAtContext"
          type="button"
          role="menuitem"
          @click="runClipContextAction('PASTE')"
        >
          <ClipboardPaste :size="14" />粘贴素材
        </button>
      </div>
    </Teleport>
    <header class="timeline-toolstrip">
      <div class="timeline-tools">
        <button
          type="button"
          title="撤销时间轴编辑 (Ctrl+Z)"
          aria-label="撤销时间轴编辑"
          :disabled="!canUndo"
          @click="emit('undo')"
        >
          <Undo2 :size="15" />
        </button>
        <button
          type="button"
          title="重做时间轴编辑 (Ctrl+Shift+Z)"
          aria-label="重做时间轴编辑"
          :disabled="!canRedo"
          @click="emit('redo')"
        >
          <Redo2 :size="15" />
        </button>
        <span class="tool-divider" />
        <button class="is-active" type="button" title="选择工具" aria-label="选择工具">
          <MousePointer2 :size="15" />
        </button>
        <span class="tool-divider" />
        <button
          type="button"
          title="吸附片段边缘与播放头"
          aria-label="切换吸附"
          :class="{ 'is-active': snapEnabled }"
          @click="snapEnabled = !snapEnabled"
        >
          <Magnet :size="15" />
        </button>
        <span class="timeline-time">{{ formatTimecode(playhead) }}</span>
        <span class="timeline-hint"
          >素材可直接拖入 · Ctrl/Cmd+C、V 复制粘贴 · 右键打开操作 · 点击标尺定位 ·
          拖动片段换位</span
        >
      </div>
      <slot name="packaging-action" />
      <div class="zoom-controls" aria-label="时间轴缩放">
        <button
          type="button"
          title="缩小时间轴"
          aria-label="缩小时间轴"
          @click="setZoom(pixelsPerSecond - 12)"
        >
          <ZoomOut :size="15" />
        </button>
        <input
          :value="pixelsPerSecond"
          type="range"
          min="24"
          max="220"
          aria-label="时间轴缩放比例"
          @input="setZoom(Number(($event.target as HTMLInputElement).value))"
        />
        <button
          type="button"
          title="放大时间轴"
          aria-label="放大时间轴"
          @click="setZoom(pixelsPerSecond + 12)"
        >
          <ZoomIn :size="15" />
        </button>
        <button type="button" title="适应工程时长" aria-label="适应工程时长" @click="fitTimeline">
          <Focus :size="15" />
        </button>
      </div>
    </header>

    <div class="timeline-workarea" @wheel="onWheel">
      <div ref="trackHeaders" class="track-headers" @scroll="syncTrackScroll('HEADERS')">
        <span class="ruler-corner" />
        <template v-for="track in orderedTracks" :key="track">
          <div
            class="track-header"
            :class="`track-${trackClassName(track)}`"
            :style="{ height: `${trackHeight(track)}px` }"
          >
            <div class="track-name">
              <Film v-if="track === 'VIDEO'" :size="14" />
              <Captions v-else-if="isCaptionTrack(track)" :size="14" />
              <AudioLines v-else :size="14" />
              <span>{{ trackLabel(track) }}</span>
            </div>
            <div class="track-actions">
              <button
                type="button"
                :title="props.sourceUpdateLock ? '局部更新中，暂时不能解锁轨道' : props.packagingSourceLock ? '智能成片包装中，暂时不能解锁' : trackIsLocked(track) ? '解锁轨道' : '锁定轨道'"
                :aria-label="props.sourceUpdateLock ? '局部更新中，暂时不能解锁轨道' : props.packagingSourceLock ? '包装中，暂时不能解锁轨道' : trackIsLocked(track) ? '解锁轨道' : '锁定轨道'"
                @click="toggleTrackLock(track)"
              >
                <Lock v-if="trackIsLocked(track)" :size="12" />
                <Unlock v-else :size="12" />
              </button>
              <button
                v-if="track === 'VIDEO' || isCaptionTrack(track)"
                type="button"
                :title="
                  trackVisible(track === 'VIDEO' ? 'VIDEO' : 'CAPTION') ? '隐藏轨道' : '显示轨道'
                "
                @click="toggleTrackVisible(track === 'VIDEO' ? 'VIDEO' : 'CAPTION')"
              >
                <Eye v-if="trackVisible(track === 'VIDEO' ? 'VIDEO' : 'CAPTION')" :size="12" />
                <EyeOff v-else :size="12" />
              </button>
              <button
                v-if="!isCaptionTrack(track)"
                type="button"
                :title="trackMuted(track) ? '取消静音' : '静音轨道'"
                :aria-label="`${trackMuted(track) ? '取消' : ''}${trackLabel(track)}轨道静音`"
                @click="emit('toggleAudioMute', track, !trackMuted(track))"
              >
                <VolumeX v-if="trackMuted(track)" :size="12" />
                <Volume2 v-else :size="12" />
              </button>
            </div>
          </div>
        </template>
      </div>

      <div
        class="track-header-resizer"
        role="separator"
        aria-label="调整轨道控制区宽度"
        aria-orientation="vertical"
        :aria-valuemin="88"
        :aria-valuemax="260"
        :aria-valuenow="trackHeaderWidth"
        title="拖动调整轨道名称与控制区宽度，双击恢复默认宽度"
        @dblclick="trackHeaderWidth = 120"
        @pointerdown="startTimelineResize"
      >
        <span />
      </div>

      <div ref="viewport" class="timeline-viewport" @scroll="syncTrackScroll('VIEWPORT')">
        <div ref="canvas" class="timeline-canvas" :style="{ width: `${canvasWidth}px` }">
          <div
            class="time-ruler"
            :style="{
              '--minor-width': `${minorTickSeconds * pixelsPerSecond}px`,
              '--major-width': `${majorTickSeconds * pixelsPerSecond}px`,
            }"
            @pointerdown="onRulerPointerDown"
          >
            <span
              v-for="tick in majorTicks"
              :key="tick"
              class="major-tick"
              :style="{ left: `${tick * pixelsPerSecond}px` }"
            >
              {{ formatRulerTime(tick) }}
            </span>
          </div>

          <template v-for="track in visiblePrimaryTracks" :key="`canvas:${track}`">
            <div
              v-if="isCaptionTrack(track)"
              :ref="
                (element) =>
                  setCaptionTrackElement(track === 'CAPTION' ? captionTrackKey(0) : track, element)
              "
              class="timeline-track caption-track"
              :style="{ height: `${trackHeight(track)}px` }"
              :class="{ 'is-hidden': !props.captionVisible, 'is-locked': trackIsLocked(track) }"
              @dragleave="onMaterialDragLeave"
              @dragover="onCaptionTrackDragOver"
              @drop="onMaterialDrop"
              @pointerdown="onTrackPointerDown($event, track)"
            >
              <div
                v-for="entry in timelineCaptionEntries.filter(
                  (item) =>
                    (captionLaneById.get(item.caption.id) ?? 0) ===
                    captionLaneOfTrack(track === 'CAPTION' ? captionTrackKey(0) : track),
                )"
                :key="entry.caption.id"
                class="caption-clip"
                :class="{
                  'is-selected': selectedAudioIds.includes(entry.id),
                  'is-dragging': audioDrag?.id === entry.id && audioDrag.mode === 'MOVE',
                }"
                :style="captionClipStyle(entry.caption)"
                :data-audio-id="entry.id"
                :title="entry.caption.text || '新字幕素材'"
                @pointerdown="onCaptionPointerDown($event, entry.caption)"
              >
                <Captions class="caption-clip-icon" :size="13" aria-hidden="true" />
                <span class="caption-clip-text">{{ entry.caption.text || '新字幕' }}</span>
                <template v-if="audioEditable && selectedAudioIds.includes(entry.id)">
                  <button
                    class="edge-trim-handle edge-trim-left"
                    type="button"
                    title="拖动左边缘调整字幕起点"
                    aria-label="拖动左边缘调整字幕起点"
                    @pointerdown="beginCaptionTrim($event, entry.caption, 'LEFT')"
                  />
                  <button
                    class="edge-trim-handle edge-trim-right"
                    type="button"
                    title="拖动右边缘调整字幕终点"
                    aria-label="拖动右边缘调整字幕终点"
                    @pointerdown="beginCaptionTrim($event, entry.caption, 'RIGHT')"
                  />
                </template>
              </div>
            </div>

            <div
              v-else
              :ref="setVideoTrackElement"
              class="timeline-track video-track"
              :style="{ height: `${trackHeight('VIDEO')}px` }"
              :class="{ 'is-hidden': !props.videoVisible, 'is-locked': trackIsLocked('VIDEO') }"
              @dragleave="onTrackDragLeave"
              @dragover="onTrackDragOver"
              @drop="onTrackDrop"
              @contextmenu="openEmptyTrackContextMenu($event, 'VIDEO')"
              @pointerdown="onTrackPointerDown($event, 'VIDEO')"
            >
              <template v-if="variant">
                <article
                  v-for="slot in variant.slots"
                  :key="slot.id"
                  class="video-clip"
                  :class="{
                    'is-template-marker': !variant.bindings[slot.id],
                    'is-selected': selectedClipIds.includes(slot.id),
                    'is-source-stale': pendingSourceSlotIds.has(slot.id),
                    'is-dragging':
                      clipDrag?.slotId === slot.id &&
                      clipDrag.started &&
                      clipDrag.selectedSlotIds.length === 1,
                    'is-low': variant.bindingMetadata?.[slot.id]?.matchLevel === 'LOW_MATCH',
                    'is-missing':
                      Boolean(variant.bindings[slot.id]) && (!materialForSlot(slot.id) || variant.conflictSlotIds.includes(slot.id)),
                    'is-material-target': materialDropSlotId === slot.id,
                    // Silencing the video track washes out the audio strip at the clip's foot — the
                    // picture itself is untouched, which is what 声音关闭 means.
                    'is-muted': trackMuted('VIDEO'),
                  }"
                  :style="{
                    ...clipStyle(slot),
                  }"
                  :data-slot-id="variant.bindings[slot.id] ? slot.id : undefined"
                  :aria-hidden="!variant.bindings[slot.id] && !variant.intentionallyEmptySlotIds?.includes(slot.id) ? true : undefined"
                  @pointerdown="onClipPointerDown($event, slot.id)"
                  @contextmenu="onVideoClipContextMenu($event, slot.id)"
                  @dblclick="onVideoClipDoubleClick($event, slot.id)"
                >
                  <template v-if="materialForSlot(slot.id)">
                    <div class="clip-mini-preview" aria-hidden="true">
                      <EffectTemplateMixFilmstrip
                        :source="materialForSlot(slot.id)!.contentUrl"
                        :source-duration="materialForSlot(slot.id)!.duration"
                        :duration="activeSlotDuration(slot.id)"
                        :trim-start="activeTrimOffset(slot.id)"
                        :version="`${materialForSlot(slot.id)!.artifactRevision}:${materialForSlot(slot.id)!.contentHash}`"
                      />
                    </div>
                    <time
                      class="clip-duration-badge"
                      :aria-label="`素材时长 ${formatTimecode(activeSlotDuration(slot.id))}`"
                    >
                      {{ formatTimecode(activeSlotDuration(slot.id)) }}
                    </time>
                    <div class="clip-info">
                      <b>{{ materialForSlot(slot.id)?.code }}</b>
                      <span>{{ EFFECT_TEMPLATE_MIX_ROLE_LABELS[slot.role] }}</span>
                      <em v-if="pendingSourceSlotIds.has(slot.id)" class="source-stale-label">待更新</em>
                      <em v-if="variant.bindingMetadata?.[slot.id]?.matchLevel === 'LOW_MATCH'"
                        >低匹配</em
                      >
                    </div>
                    <EffectTemplateMixWaveform
                      v-if="
                        !variant.detachedAudios?.some((audio) => audio.sourceSlotId === slot.id)
                      "
                      :bar-count="waveformBarCount(slot)"
                      :duration="activeSlotDuration(slot.id)"
                      :source="materialForSlot(slot.id)!.contentUrl"
                      :trim-start="activeTrimOffset(slot.id)"
                    />
                  </template>
                  <div v-else class="missing-copy">
                    <b>{{ variant.bindings[slot.id] ? '素材不可用' : variant.intentionallyEmptySlotIds?.includes(slot.id) ? '空槽待补充' : '模板槽位' }}</b>
                    <span
                      >{{ EFFECT_TEMPLATE_MIX_ROLE_LABELS[slot.role] }} · {{ slot.duration }}s</span
                    >
                  </div>
                  <button
                    v-if="selectedClipIds.includes(slot.id) && materialForSlot(slot.id)"
                    class="edge-trim-handle edge-trim-left"
                    :class="{ 'is-disabled': edgeTrimBlocked(slot.id) }"
                    type="button"
                    :disabled="edgeTrimBlocked(slot.id)"
                    title="拖动左边缘调整素材起点和时长"
                    aria-label="拖动左边缘调整素材起点和时长"
                    @pointerdown="beginEdgeTrim($event, slot.id, 'LEFT')"
                  />
                  <button
                    v-if="selectedClipIds.includes(slot.id) && materialForSlot(slot.id)"
                    class="edge-trim-handle edge-trim-right"
                    :class="{ 'is-disabled': edgeTrimBlocked(slot.id) }"
                    type="button"
                    :disabled="edgeTrimBlocked(slot.id)"
                    title="拖动右边缘调整素材时长"
                    aria-label="拖动右边缘调整素材时长"
                    @pointerdown="beginEdgeTrim($event, slot.id, 'RIGHT')"
                  />
                  <span v-if="edgeTrimDrag?.slotId === slot.id" class="trim-tooltip">
                    源 {{ edgeTrimDrag.currentOffset.toFixed(2) }}s —
                    {{ (edgeTrimDrag.currentOffset + edgeTrimDrag.currentDuration).toFixed(2) }}s ·
                    {{ edgeTrimDrag.currentDuration.toFixed(2) }}s
                  </span>
                </article>
                <button
                  v-for="slot in variant.slots.slice(1).filter((slot, index) => slot.transition !== '硬切' && variant?.bindings[slot.id] && variant?.bindings[variant.slots[index]!.id])"
                  :key="`transition:${slot.id}`"
                  class="transition-junction"
                  :class="{
                    'is-active': selectedSlotId === slot.id || transitionDrag?.slotId === slot.id,
                    'is-transition-target': transitionDropSlotId === slot.id,
                  }"
                  :style="transitionStyle(slot)"
                  type="button"
                  :title="`转场：${slot.transition} · ${transitionDurationFor(slot.id).toFixed(1)} 秒 · 拖动左右边缘调整时长`"
                  @pointerdown="startTransitionResize($event, slot.id)"
                  @click.stop="openTransition(slot.id)"
                >
                  <span aria-hidden="true">◀▶</span>
                </button>
                <div
                  v-if="dragGhostStyle && draggedSlot && clipDrag?.selectedSlotIds.length === 1"
                  class="drag-ghost"
                  :style="dragGhostStyle"
                >
                  <b>{{ materialForSlot(draggedSlot.id)?.code ?? '待补素材' }}</b>
                  <span>{{ EFFECT_TEMPLATE_MIX_ROLE_LABELS[draggedSlot.role] }}</span>
                </div>
              </template>
              <div v-else class="timeline-empty-state">
                <Film :size="20" />
                <b>等待 AI 智能填充</b>
                <span>任务成功后，六段素材会按模板顺序自动上轨</span>
              </div>
            </div>
          </template>

          <div
            v-for="track in audioTracks"
            :key="`canvas:${track}`"
            :ref="(element) => setAudioTrackElement(track, element)"
            class="timeline-track audio-track"
            :class="{
              'is-locked': trackIsLocked(track),
              'is-drop-target': musicDropRow === audioRowOfKey(track),
            }"
            :style="{ height: `${trackHeight(track)}px` }"
            @dragleave="onMusicTrackDragLeave"
            @dragover="onMusicTrackDragOver($event, track)"
            @drop="onMusicTrackDrop($event, track)"
            @contextmenu="openEmptyTrackContextMenu($event, track)"
            @pointerdown="onTrackPointerDown($event, track)"
          >
            <div
              v-for="audio in audiosForTrack(track)"
              :key="audio.id"
              class="audio-clip"
              :class="[
                audio.kind === 'VOICE'
                  ? 'voice-clip'
                  : audio.kind === 'DETACHED'
                    ? 'detached-audio-clip'
                    : 'bgm-clip',
                {
                  'is-muted': trackMuted(track),
                  'is-selected': selectedAudioIds.includes(audio.id),
                  'is-dragging': audioDrag?.id === audio.id && audioDrag.mode === 'MOVE',
                  // A library track let go here takes this clip's place, so the clip it would replace
                  // is the one that says so.
                  'is-material-target': musicDropClipId === audio.id,
                },
              ]"
              :style="audioClipStyle(audio)"
              :data-audio-id="audio.id"
              :title="audio.text ?? audio.label"
              @pointerdown="onAudioPointerDown($event, audio)"
              @contextmenu="onAudioClipContextMenu($event, audio.id)"
            >
              <EffectTemplateMixWaveform
                v-if="audio.sourceUrl"
                layout="fill"
                :tone="audio.kind"
                :bar-count="audioWaveformBarCount(audio.duration)"
                :duration="audio.duration"
                :fade-in="audio.fadeIn"
                :fade-out="audio.fadeOut"
                :gain="audioGain(audio)"
                :source="audio.sourceUrl"
                :trim-start="audio.offset"
              />
              <span
                v-if="audio.fadeIn > 0"
                class="audio-fade-mask audio-fade-in"
                :style="audioFadeStyle(audio, 'LEFT')"
                aria-hidden="true"
              />
              <span
                v-if="audio.fadeOut > 0"
                class="audio-fade-mask audio-fade-out"
                :style="audioFadeStyle(audio, 'RIGHT')"
                aria-hidden="true"
              />
              <span class="audio-clip-label">
                <Volume2 v-if="audio.kind !== 'MUSIC'" :size="13" />
                <Music2 v-else :size="13" />
                {{ audio.label }}
              </span>
              <span
                v-if="audioDrag?.id === audio.id && audioDrag.mode === 'VOLUME'"
                class="audio-volume-readout"
                >音量 {{ Math.round(audioDrag.currentVolume * 100) }}%</span
              >
              <span
                v-if="audio.editable && selectedAudioIds.includes(audio.id)"
                class="audio-volume-line"
                :style="audioVolumeLineStyle(audio)"
                title="上下拖动调整音量"
                @pointerdown="beginAudioVolume($event, audio)"
              >
                <i />
              </span>
              <template v-if="audio.editable && selectedAudioIds.includes(audio.id)">
                <button
                  class="edge-trim-handle edge-trim-left"
                  type="button"
                  title="拖动左边缘裁剪口播/纯音乐"
                  aria-label="拖动左边缘裁剪口播或纯音乐"
                  @pointerdown="beginAudioTrim($event, audio, 'LEFT')"
                />
                <button
                  class="edge-trim-handle edge-trim-right"
                  type="button"
                  title="拖动右边缘裁剪口播/纯音乐"
                  aria-label="拖动右边缘裁剪口播或纯音乐"
                  @pointerdown="beginAudioTrim($event, audio, 'RIGHT')"
                />
              </template>
            </div>
          </div>

          <!-- Spans every lane, so the line reads as one vertical alignment rather than a per-track hint. -->
          <span
            v-if="snapGuideLeft !== null"
            class="snap-guide"
            :style="{ left: `${snapGuideLeft}px` }"
          />
          <!-- The border under the pointer; releasing on it opens a row of that kind right there. -->
          <span
            v-if="trackInsertGuideTop !== null"
            class="track-insert-guide"
            :style="{ top: `${trackInsertGuideTop}px` }"
          />
          <div
            v-if="marqueeStyle && marquee?.moved"
            class="selection-marquee"
            :style="marqueeStyle"
          />
          <div ref="playheadElement" class="timeline-playhead">
            <button
              class="playhead-handle"
              type="button"
              aria-label="拖动播放头"
              @pointerdown="onPlayheadPointerDown"
            />
            <span class="playhead-line" />
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.video-clip.is-template-marker {
  pointer-events: none;
  user-select: none;
}
.mix-timeline-shell {
  --timeline-accent: #2563eb;
  --timeline-bg: #f6f8fc;
  --timeline-border: #d8e1ee;
  --timeline-muted: #7b8aa3;
  --timeline-text: #334155;
  /* The toolstrip sits inside the height the editor allots to the timeline. */
  --timeline-toolstrip-height: 42px;
  overflow: hidden;
  border-top: 1px solid var(--timeline-border);
  background: var(--timeline-bg);
  color: var(--timeline-text);
  user-select: none;
}
.mix-timeline-shell.is-resizing-track-header,
.mix-timeline-shell.is-resizing-track-header * {
  cursor: col-resize !important;
  user-select: none !important;
}
.mix-timeline-shell.is-scrubbing,
.mix-timeline-shell.is-scrubbing * {
  cursor: ew-resize !important;
}
.timeline-toolstrip {
  height: var(--timeline-toolstrip-height);
  padding: 0 10px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid var(--timeline-border);
  background: #fff;
  gap: 12px;
  overflow-x: auto;
  overscroll-behavior-x: contain;
}
.timeline-tools,
.zoom-controls {
  min-width: 0;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 5px;
}
.timeline-toolstrip button,
.track-actions button {
  display: grid;
  place-items: center;
  border: 0;
  background: transparent;
  color: #708198;
  cursor: pointer;
}
.timeline-toolstrip button {
  width: 28px;
  height: 28px;
  border-radius: 5px;
}
.timeline-toolstrip button:hover,
.timeline-toolstrip button.is-active,
.track-actions button:hover {
  background: #eaf2ff;
  color: var(--timeline-accent);
}
.timeline-toolstrip button:disabled,
.track-actions button:disabled {
  color: #b9c3d0;
  cursor: not-allowed;
}
.tool-divider {
  width: 1px;
  height: 17px;
  margin: 0 3px;
  background: #d7e0ed;
}
.timeline-time {
  margin-left: 6px;
  color: #29405f;
  font-variant-numeric: tabular-nums;
  font-size: 11px;
}
.timeline-hint {
  margin-left: 8px;
  overflow: hidden;
  color: var(--timeline-muted);
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.zoom-controls input {
  width: 94px;
  height: 3px;
  accent-color: var(--timeline-accent);
}
/* Only the track area scrolls, and it is exactly what the toolstrip left over. Sizing it to the
   full allotted height used to push the shell past its row, so the editor clipped the bottom
   track away and the viewport never overflowed — leaving nothing to scroll. */
.timeline-workarea {
  height: calc(var(--timeline-height, 220px) - var(--timeline-toolstrip-height));
  min-height: 178px;
  display: grid;
  grid-template-columns: var(--track-header-width, 120px) 7px minmax(0, 1fr);
  overflow: hidden;
  background: var(--timeline-bg);
}
.track-headers {
  position: relative;
  z-index: 30;
  overflow-x: hidden;
  overflow-y: auto;
  background: #f8fafd;
  scrollbar-width: none;
}
.track-headers::-webkit-scrollbar {
  width: 0;
  height: 0;
}
.track-header-resizer {
  position: relative;
  z-index: 35;
  border-right: 1px solid var(--timeline-border);
  border-left: 1px solid var(--timeline-border);
  background: #f5f8fc;
  cursor: col-resize;
  touch-action: none;
}
.track-header-resizer span {
  width: 2px;
  height: 34px;
  position: absolute;
  top: 50%;
  left: 50%;
  border-radius: 999px;
  background: #b7c5d8;
  transform: translate(-50%, -50%);
}
.track-header-resizer:hover,
.mix-timeline-shell.is-resizing-track-header .track-header-resizer {
  border-color: #9fc0f5;
  background: #eaf2ff;
}
.track-header-resizer:hover span,
.mix-timeline-shell.is-resizing-track-header .track-header-resizer span {
  background: var(--timeline-accent);
}
.ruler-corner {
  height: 30px;
  position: sticky;
  z-index: 20;
  top: 0;
  display: block;
  border-bottom: 1px solid var(--timeline-border);
  background: #f8fafd;
}
.track-header {
  box-sizing: border-box;
  height: 38px;
  padding: 0 7px 0 10px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: #65758d;
  font-size: 11px;
}
.track-header.track-audio {
  cursor: default;
  height: 76px;
  color: #263b59;
}
.track-header.track-video {
  height: 76px;
  color: #263b59;
}
.track-name,
.track-actions {
  display: flex;
  align-items: center;
}
.track-name {
  min-width: 0;
  gap: 7px;
}
.track-actions {
  gap: 1px;
}
.track-actions button {
  width: 20px;
  height: 22px;
  border-radius: 4px;
}
.timeline-viewport {
  min-width: 0;
  /* Definite height, so the canvas below can size itself to the viewport with a percentage. */
  height: 100%;
  overflow: auto;
  background: var(--timeline-bg);
  overscroll-behavior: contain;
  scrollbar-color: #8fa2bd #edf2f8;
  scrollbar-width: auto;
}
/* Wide enough to actually grab: the tracks scroll as one column, so this bar is the only way to
   bring a lane that sits below the fold into view. */
.timeline-viewport::-webkit-scrollbar {
  height: 12px;
  width: 12px;
}
.timeline-viewport::-webkit-scrollbar-track {
  background: #edf2f8;
}
.timeline-viewport::-webkit-scrollbar-thumb {
  border: 2px solid #edf2f8;
  border-radius: 999px;
  background: #8fa2bd;
}
.timeline-viewport::-webkit-scrollbar-thumb:hover {
  background: #6f86a6;
}
/* Fills the viewport so the lanes end at its bottom edge instead of leaving a gap, and grows past it
   only when the lanes really need the room. The old fixed 220px floor sat a couple of pixels above
   the viewport height, which painted a scrollbar that promised a scroll the tracks could not give. */
.timeline-canvas {
  min-height: 100%;
  position: relative;
}
.time-ruler {
  box-sizing: border-box;
  height: 30px;
  position: sticky;
  z-index: 20;
  top: 0;
  border-bottom: 1px solid var(--timeline-border);
  cursor: ew-resize;
  background-image:
    repeating-linear-gradient(
      to right,
      transparent 0,
      transparent calc(var(--minor-width) - 1px),
      #cfd8e6 calc(var(--minor-width) - 1px),
      #cfd8e6 var(--minor-width)
    ),
    repeating-linear-gradient(
      to right,
      transparent 0,
      transparent calc(var(--major-width) - 1px),
      #9aabc2 calc(var(--major-width) - 1px),
      #9aabc2 var(--major-width)
    );
  background-position:
    0 22px,
    0 17px;
  background-size:
    auto 8px,
    auto 13px;
  background-repeat: repeat-x;
  background-color: #fbfcfe;
}
.major-tick {
  position: absolute;
  top: 4px;
  transform: translateX(4px);
  color: #718198;
  font-size: 9px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.timeline-track {
  box-sizing: border-box;
  height: 38px;
  position: relative;
  border-bottom: 1px solid #dde5f0;
  background: #fbfcfe;
}
.timeline-track.video-track {
  height: 76px;
  background: #f7f9fc;
}
/* No clipping on an audio row: a clip being dragged up or down has to be visible while it crosses
   its neighbours, exactly like a video clip does on the video track. */
.timeline-track.audio-track {
  height: 76px;
  background: #f7f9fc;
}
.timeline-track.caption-track {
  background-image: repeating-linear-gradient(
    to bottom,
    #fbfcfe 0,
    #fbfcfe calc(34px - 1px),
    #dde5f0 calc(34px - 1px),
    #dde5f0 34px
  );
}
.timeline-track.audio-track.is-drop-target {
  box-shadow: inset 0 0 0 2px #477eff;
  background: #edf4ff;
}
.timeline-track.is-locked {
  cursor: not-allowed;
}
/* A locked lane has to *look* locked: the diagonal hatch is the signal, and the guards in the
   pointer handlers — not this layer — are what actually reject the edit. */
.timeline-track.is-locked::after {
  content: '';
  position: absolute;
  inset: 0;
  /* Above the clips and their trim handles (6–8), below the playhead and the marquee (20+). */
  z-index: 10;
  pointer-events: none;
  background-image: repeating-linear-gradient(
    45deg,
    rgba(38, 59, 89, 0.16) 0 6px,
    transparent 6px 12px
  );
}
/* Hiding a lane dims the whole lane, not just its clips. The caption lane paints its rows with a
   gradient, so it needs the same override to dim with the others. The tone is a mid slate — halfway
   between the lane's own near-white and the dark navy the app accents with — so the lane reads as
   switched off without going black. */
.timeline-track.is-hidden,
.timeline-track.caption-track.is-hidden {
  background: #8f9aab;
}
.timeline-track.is-hidden > :not(.track-empty-copy) {
  opacity: 0.3;
  filter: grayscale(1);
  pointer-events: none;
}
.track-empty-copy {
  position: absolute;
  top: 50%;
  left: 12px;
  color: #96a3b6;
  font-size: 10px;
  transform: translateY(-50%);
  pointer-events: none;
}
.video-clip {
  box-sizing: border-box;
  height: 62px;
  position: absolute;
  z-index: 3;
  top: 7px;
  overflow: visible;
  border: 1px solid #8fb7ee;
  border-radius: 3px;
  background: #e8f1ff;
  cursor: grab;
  transition:
    border-color 100ms ease,
    box-shadow 100ms ease,
    opacity 100ms ease;
}
.video-track::before,
.video-track::after {
  position: absolute;
  inset: 0;
  pointer-events: none;
  content: '';
}
.video-track::before {
  background: repeating-linear-gradient(
    to bottom,
    transparent 0,
    transparent 69px,
    #dce5f1 69px,
    #dce5f1 70px
  );
}
.video-clip:active {
  cursor: grabbing;
}
.video-clip.is-selected {
  z-index: 6;
  border: 2px solid #2563eb;
  box-shadow: 0 0 0 2px #bfdbfe;
}
.video-clip.is-dragging {
  opacity: 0.22;
}
.video-clip.is-source-stale {
  border: 2px solid #f59e0b;
  box-shadow: 0 0 0 1px #fcd34d;
}
.clip-info .source-stale-label {
  flex: 0 0 auto;
  color: #92400e;
  background: #fef3c7;
}
.video-clip.is-low::after {
  width: 7px;
  height: 7px;
  position: absolute;
  top: 5px;
  right: 5px;
  border-radius: 50%;
  background: #fb923c;
  content: '';
}
.video-clip.is-missing {
  border: 1px dashed #ef8f8f;
  background: #fff1f2;
}
.video-clip.is-template-marker {
  border: 1px dashed #cbd5e1;
  background: #f8fafc;
  color: #64748b;
}
.video-clip.is-template-marker .missing-copy b {
  color: #64748b;
}
/* 拖入的素材松手就会顶替这一条，所以它要看起来是被压住的那条：整条压暗，外加一圈描边，
   而不是像被选中那样只是变亮。描边画在元素自己的边框上，压暗画在内容层上，两者互不冲淡。 */
.video-clip.is-material-target {
  z-index: 12;
  border: 2px solid #2563eb;
  box-shadow: 0 0 0 4px #bfdbfeaa;
}
.video-clip.is-material-pointer-target {
  z-index: 12;
  border: 2px solid #2563eb;
  box-shadow: 0 0 0 3px #bfdbfe88;
}
.audio-clip.is-material-target {
  z-index: 12;
  border-color: #2563eb;
  box-shadow: 0 0 0 3px #bfdbfeaa;
}
.video-clip.is-material-target::before,
.video-clip.is-material-pointer-target::before,
.audio-clip.is-material-target::before {
  position: absolute;
  z-index: 3;
  inset: 0;
  border-radius: inherit;
  background: rgba(15, 23, 42, 0.5);
  content: '';
  pointer-events: none;
}
.clip-mini-preview {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  max-width: 100%;
  position: relative;
  height: 21px;
  overflow: hidden;
  border-radius: 2px 2px 0 0;
  background: #d7e5f8;
  pointer-events: none;
  contain: paint;
  clip-path: inset(0 round 2px 2px 0 0);
}
.clip-duration-badge {
  box-sizing: border-box;
  max-width: calc(100% - 6px);
  position: absolute;
  z-index: 2;
  top: 3px;
  right: 3px;
  padding: 1px 4px;
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.42);
  border-radius: 2px;
  background: rgba(15, 23, 42, 0.78);
  color: #fff;
  font-size: 9px;
  font-variant-numeric: tabular-nums;
  line-height: 14px;
  text-overflow: ellipsis;
  white-space: nowrap;
  pointer-events: none;
}
.clip-info {
  height: 21px;
  padding: 2px 7px 1px;
  position: absolute;
  inset: 21px 0 auto;
  display: flex;
  align-items: center;
  gap: 5px;
  overflow: hidden;
  background: rgba(232, 241, 255, 0.96);
  color: #1e4f91;
  pointer-events: none;
}
.clip-info b,
.clip-info span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.clip-info b {
  font-size: 10px;
}
.clip-info span {
  color: #52729f;
  font-size: 9px;
}
.clip-info em {
  margin-left: auto;
  color: #b45309;
  font-size: 8px;
  font-style: normal;
}
.missing-copy {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  overflow: hidden;
  color: #c94a5a;
}
.missing-copy b {
  font-size: 11px;
}
.missing-copy span {
  font-size: 9px;
  white-space: nowrap;
}
.edge-trim-handle {
  width: 8px;
  height: 34px;
  position: absolute;
  z-index: 8;
  top: 50%;
  padding: 0;
  border: 2px solid rgba(255, 255, 255, 0.95);
  border-radius: 3px;
  background: rgba(37, 99, 235, 0.82);
  box-shadow: 0 0 0 1px rgba(29, 78, 216, 0.85);
  cursor: ew-resize;
  touch-action: none;
  opacity: 0.5;
  transform: translateY(-50%);
  transition:
    opacity 100ms ease,
    background 100ms ease;
}
.edge-trim-handle:hover,
.video-clip.is-selected .edge-trim-handle,
.video-clip:has(.edge-trim-handle:focus-visible) .edge-trim-handle,
.audio-clip.is-selected .edge-trim-handle,
.caption-clip.is-selected .edge-trim-handle {
  opacity: 1;
  background: #2563eb;
}
/* Tall audio blocks get a taller grab area than video clips; captions are slimmer again. */
.audio-clip .edge-trim-handle {
  height: 30px;
  border-radius: 4px;
}
.caption-clip .edge-trim-handle {
  height: 22px;
  border-radius: 4px;
}
.edge-trim-handle.is-disabled,
.edge-trim-handle:disabled {
  border-color: rgba(255, 255, 255, 0.66);
  background: rgba(100, 116, 139, 0.7);
  cursor: not-allowed;
  opacity: 0.42;
}
.edge-trim-handle.is-disabled:hover,
.edge-trim-handle:disabled:hover {
  background: rgba(100, 116, 139, 0.7);
}
.edge-trim-left {
  left: 1px;
}
.edge-trim-right {
  right: 1px;
}
.trim-tooltip {
  position: absolute;
  z-index: 20;
  top: -29px;
  left: 50%;
  padding: 4px 7px;
  border: 1px solid #aac4ee;
  border-radius: 4px;
  background: #eff6ff;
  color: #24476f;
  font-size: 9px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  transform: translateX(-50%);
}
.transition-junction {
  box-sizing: border-box;
  min-width: 16px;
  position: absolute;
  z-index: 7;
  top: 7px;
  height: 55px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 1px solid rgba(226, 230, 234, 0.68);
  border-radius: 3px;
  background: rgba(123, 131, 138, 0.48);
  color: rgba(255, 255, 255, 0.82);
  font-size: 16px;
  cursor: ew-resize;
  transform: translateX(-50%);
}
.transition-junction::before,
.transition-junction::after {
  display: none;
  width: 3px;
  height: 22px;
  position: absolute;
  top: 16px;
  border-radius: 2px;
  background: #f8fafc;
  content: '';
  opacity: 0.95;
}
.transition-junction::before {
  left: -2px;
}
.transition-junction::after {
  right: -2px;
}
.transition-junction span {
  display: inline-block;
  letter-spacing: -3px;
  pointer-events: none;
}
.transition-junction:hover {
  border-color: #2563eb;
  background: rgba(104, 113, 120, 0.6);
}
.transition-junction.is-active {
  border-color: rgba(248, 250, 252, 0.9);
  background: rgba(123, 131, 138, 0.78);
  box-shadow: 0 0 0 1px rgba(100, 116, 139, 0.42);
  color: #fff;
}
.transition-junction.is-active::before,
.transition-junction.is-active::after {
  display: block;
}
.transition-junction.is-active:hover {
  background: rgba(104, 113, 120, 0.86);
}
.transition-junction.is-transition-target {
  border-color: #2563eb;
  background: rgba(100, 124, 150, 0.68);
  box-shadow: 0 0 0 3px #93c5fd88;
  color: #fff;
  cursor: copy;
}
.drag-ghost {
  box-sizing: border-box;
  height: 62px;
  position: absolute;
  z-index: 18;
  top: 7px;
  padding: 7px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid #4d8fea;
  border-radius: 3px;
  background: rgba(53, 112, 205, 0.9);
  box-shadow: 0 8px 22px #4a6a963d;
  color: #fff;
  pointer-events: none;
}
.drag-ghost b {
  font-size: 10px;
}
.drag-ghost span {
  font-size: 9px;
}
.snap-guide {
  width: 1px;
  position: absolute;
  /* Inside the canvas rather than a track, so it runs the whole lane stack from the ruler down. */
  z-index: 17;
  top: 0;
  bottom: 0;
  background: #2563eb;
  box-shadow: 0 0 0 1px #bfdbfe;
  pointer-events: none;
}
/* The same guide laid on its side: it marks a row border instead of a column of time. */
.track-insert-guide {
  height: 1px;
  position: absolute;
  z-index: 17;
  left: 0;
  right: 0;
  background: #2563eb;
  box-shadow: 0 0 0 1px #bfdbfe;
  pointer-events: none;
}
.caption-clip,
.audio-clip {
  box-sizing: border-box;
  height: 44px;
  position: absolute;
  z-index: 2;
  top: 5px;
  overflow: hidden;
  border-radius: 4px;
  display: flex;
  align-items: center;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 10px;
  cursor: grab;
}
.clip-context-menu {
  min-width: 192px;
  position: fixed;
  z-index: 10000;
  padding: 5px;
  border: 1px solid #d4dce8;
  border-radius: 8px;
  background: #fff;
  box-shadow: 0 10px 28px rgba(15, 23, 42, 0.18);
}
.clip-context-menu button {
  width: 100%;
  padding: 8px 10px;
  display: flex;
  align-items: center;
  gap: 8px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: #17345d;
  text-align: left;
  cursor: pointer;
}
.clip-context-menu button:hover,
.clip-context-menu button:focus-visible {
  outline: none;
  background: #edf4ff;
}
.clip-context-menu button:disabled {
  color: #94a3b8;
  cursor: not-allowed;
}
.clip-context-menu button:disabled:hover {
  background: transparent;
}
.caption-clip.is-selected,
.audio-clip.is-selected {
  border-color: #2563eb;
  box-shadow:
    0 0 0 1px #2563eb,
    0 2px 6px rgba(15, 23, 42, 0.22);
}
.caption-clip.is-dragging,
.audio-clip.is-dragging {
  cursor: grabbing;
  opacity: 0.85;
}
/* A clip changing rows rides above the rows it crosses rather than sliding underneath them. A
   caption needs this too: its rows are separate strips stacked in order, so without it the card
   would disappear under the row below the moment it was carried off its own. */
.caption-clip.is-dragging,
.audio-clip.is-dragging {
  z-index: 8;
}
/* Captions read as standalone rounded cards, not as labels painted on the lane. */
.caption-clip {
  gap: 5px;
  padding: 0 9px;
  border: 1px solid #a8513f;
  border-radius: 6px;
  background: #8c3b2e;
  color: #fff5f0;
}
.caption-clip-icon {
  position: relative;
  z-index: 2;
  flex: none;
  opacity: 0.85;
}
.caption-clip-text {
  position: relative;
  z-index: 2;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  text-shadow: 0 1px 3px rgba(28, 8, 4, 0.75);
}
.audio-clip {
  padding: 0 8px;
  gap: 5px;
  border: 1px solid #83c4a5;
  background: #e8f7ef;
  color: #27684a;
}
.audio-clip.voice-clip {
  border-color: #3f6ac0;
  background: #2f4b8f;
  color: #eaf0ff;
}
.audio-clip.bgm-clip {
  border-color: #7d4f9c;
  background: #5b3a75;
  color: #f4e9fb;
}
.audio-clip.detached-audio-clip {
  border-color: #b27a35;
  background: #79501f;
  color: #fff3d7;
}
.audio-clip.is-muted {
  opacity: 0.42;
}
/* Silencing a video clip leaves its picture alone: only the audio strip along its foot washes out,
   which is the same read as a muted audio row. A plain opacity would instead show the filmstrip
   through the strip, so the palette the strip paints itself with is overridden with a pale one. */
.video-clip.is-muted .clip-waveform {
  --wave-border: #ccd5e1;
  --wave-border-solid: #ccd5e1;
  --wave-bg: #eaeef4;
  --wave-bg-solid: #eaeef4;
  --wave-line: #ccd5e1;
  --wave-line-solid: #ccd5e1;
  --wave-bar: #c2cbd7;
}
.audio-clip-label {
  position: relative;
  z-index: 2;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 5px;
  overflow: hidden;
  border-radius: 3px;
  background: rgba(9, 18, 38, 0.42);
  text-overflow: ellipsis;
  pointer-events: none;
}
.audio-fade-mask {
  max-width: 100%;
  position: absolute;
  z-index: 1;
  top: 0;
  bottom: 0;
  background: rgba(7, 13, 26, 0.64);
  pointer-events: none;
}
.audio-fade-in {
  left: 0;
  clip-path: polygon(0 0, 100% 0, 0 100%);
}
.audio-fade-out {
  right: 0;
  clip-path: polygon(0 0, 100% 0, 100% 100%);
}
.audio-volume-readout {
  position: absolute;
  z-index: 4;
  top: 2px;
  right: 4px;
  padding: 1px 5px;
  border-radius: 3px;
  background: rgba(9, 18, 38, 0.72);
  color: #fff;
  font-variant-numeric: tabular-nums;
  pointer-events: none;
}
.audio-volume-line {
  position: absolute;
  z-index: 3;
  right: 3px;
  left: 3px;
  height: 12px;
  margin-top: -6px;
  border-top: 1px solid rgba(255, 255, 255, 0.85);
  cursor: ns-resize;
}
.audio-volume-line i {
  width: 9px;
  height: 9px;
  position: absolute;
  right: 0;
  top: -5px;
  border: 1px solid #fff;
  border-radius: 50%;
  background: #2563eb;
}
.timeline-empty-state {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3px;
  color: #8a99ae;
  pointer-events: none;
}
.timeline-empty-state b {
  color: #63758e;
  font-size: 11px;
}
.timeline-empty-state span {
  font-size: 10px;
}
.selection-marquee {
  position: absolute;
  z-index: 22;
  border: 1px solid #4d8fea;
  background: rgba(37, 99, 235, 0.12);
  pointer-events: none;
}
.timeline-playhead {
  width: 1px;
  position: absolute;
  z-index: 25;
  top: 0;
  left: 0;
  bottom: 0;
  pointer-events: none;
  will-change: transform;
}
.playhead-line {
  width: 1px;
  position: absolute;
  top: 19px;
  bottom: 0;
  left: 0;
  background: #ef4444;
  box-shadow: 0 0 0 1px #fecaca;
}
.playhead-handle {
  width: 11px;
  height: 14px;
  position: absolute;
  z-index: 2;
  top: 4px;
  left: -5px;
  padding: 0;
  border: 2px solid #fff;
  border-radius: 3px 3px 5px 5px;
  background: #ef4444;
  box-shadow: 0 0 0 1px #dc2626;
  cursor: ew-resize;
  pointer-events: auto;
}
@media (max-width: 1050px) {
  .timeline-hint {
    display: none;
  }
  .track-actions button {
    width: 18px;
  }
  .zoom-controls input {
    width: 64px;
  }
}
</style>
