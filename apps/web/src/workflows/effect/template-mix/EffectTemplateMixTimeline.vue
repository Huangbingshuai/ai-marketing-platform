<script setup lang="ts">
import type {
  EffectTemplateMixAudio,
  EffectTemplateMixCaption,
  EffectTemplateMixMaterial,
  EffectTemplateMixSlot,
  EffectTemplateMixTransition,
  EffectTemplateMixVariant,
  PackagingItem,
} from '@ai-marketing/contracts';
import {
  Captions,
  Eye,
  EyeOff,
  Film,
  Focus,
  Lock,
  Magnet,
  MousePointer2,
  Music2,
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
  EFFECT_TEMPLATE_MIX_ROLE_LABELS,
  EFFECT_TEMPLATE_MIX_TRANSITIONS,
  effectTemplateMixTransitionDuration,
} from './effect-template-mix-state';
import EffectTemplateMixFilmstrip from './EffectTemplateMixFilmstrip.vue';
import EffectTemplateMixWaveform from './EffectTemplateMixWaveform.vue';

const props = withDefaults(
  defineProps<{
    duration: number;
    canRedo?: boolean;
    canUndo?: boolean;
    fps?: number;
    height?: number;
    materials: EffectTemplateMixMaterial[];
    playhead: number;
    projectId?: string;
    /** Set when the preview selects a caption, so both views show the same clip. */
    selectedAudioClipId?: string | null;
    selectedSlotId: string;
    variant: EffectTemplateMixVariant | null;
    packaging?: PackagingItem | null;
  }>(),
  { canRedo: false, canUndo: false, fps: 30, height: 260, selectedAudioClipId: null },
);

const emit = defineEmits<{
  assignMaterial: [materialId: string, slotId: string];
  applyTransition: [slotId: string, transition: EffectTemplateMixTransition];
  changeAudioVolume: [clipId: string, volume: number];
  moveAudioClip: [clipId: string, start: number];
  moveClip: [slotId: string, start: number, lane: number];
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
  /** The whole caption selection, so the editor can move and scale a group as one. */
  selectCaptionClips: [captionIds: string[]];
  /** The whole voice/music selection, so the editor can retune a group from one standard clip. */
  selectAudioClips: [clipIds: string[]];
  selectSlot: [slotId: string];
  trimSlot: [slotId: string, trimStartSeconds: number];
  previewTransitionDuration: [slotId: string, duration: number];
  updateTransitionDuration: [slotId: string, duration: number];
  undo: [];
}>();

type VisibleTrack = 'AUDIO' | 'CAPTION' | 'VIDEO';
type TimelineAudioKind = 'MUSIC' | 'VOICE';
/** One voiceover, BGM or caption block on the audio/caption lanes. */
type TimelineAudio = {
  /** Namespaced selection id: `voice:<lineId>`, `music`, `voice`, or `caption:<id>`. */
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
};
type ClipDragState = {
  currentLane: number;
  currentStart: number;
  currentClientX: number;
  currentClientY: number;
  grabOffset: number;
  initialLanes: Record<string, number>;
  initialStarts: Record<string, number>;
  selectedSlotIds: string[];
  selectionModifier: boolean;
  slotId: string;
  startClientX: number;
  startClientY: number;
  started: boolean;
  targetSlotId: string;
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
  /** Which lane it began in, so a drag only ever selects that lane's own blocks. */
  track: 'VIDEO' | 'CAPTION' | 'AUDIO';
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
const captionTrack = ref<HTMLElement | null>(null);
const audioTrack = ref<HTMLElement | null>(null);
const timelineShell = ref<HTMLElement | null>(null);
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
const trimDrag = ref<TrimDragState | null>(null);
const edgeTrimDrag = ref<EdgeTrimDragState | null>(null);
const marquee = ref<MarqueeState | null>(null);
const materialDropSlotId = ref('');
const selectedClipIds = ref<string[]>([]);
const selectedAudioIds = ref<string[]>([]);
const audioDrag = ref<AudioDragState | null>(null);
const trackHeaders = ref<HTMLElement | null>(null);
const trackLocked = reactive<Record<VisibleTrack, boolean>>({
  AUDIO: false,
  CAPTION: false,
  VIDEO: false,
});
const trackVisible = reactive<Record<VisibleTrack, boolean>>({
  AUDIO: true,
  CAPTION: true,
  VIDEO: true,
});
const trackMuted = reactive<Record<'AUDIO', boolean>>({ AUDIO: false });
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
  Math.max(0, props.variant?.timelineStarts?.[slotId] ?? sequentialStarts.value[slotId] ?? 0);
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
const videoLaneCount = computed(() =>
  Math.max(1, occupiedVideoLaneValues.value.length, (clipDrag.value?.currentLane ?? 0) + 1),
);
const layoutSlots = computed(() =>
  (props.variant?.slots ?? []).map((slot) => {
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
const timelineDuration = computed(() =>
  Math.max(
    0.1,
    props.duration,
    draggedTimelineEnd.value,
    ...layoutSlots.value.map(({ end }) => end),
  ),
);
const canvasWidth = computed(() =>
  Math.max(viewportWidth.value, timelineDuration.value * pixelsPerSecond.value + 96),
);
const playheadLeft = computed(() => props.playhead * pixelsPerSecond.value);
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
  if (!drag?.started) return null;
  return {
    lane: drag.currentLane - (drag.initialLanes[drag.slotId] ?? drag.currentLane),
    start: drag.currentStart - (drag.initialStarts[drag.slotId] ?? drag.currentStart),
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
    top: `${7 + Math.max(0, drag.currentLane) * 70}px`,
    width: `${Math.max(24, width)}px`,
  };
});
const dropGuideLeft = computed(() => {
  const target = layoutSlots.value.find(({ id }) => id === clipDrag.value?.targetSlotId);
  if (!target || !clipDrag.value?.started) return null;
  const distance = Math.min(
    Math.abs(clipDrag.value.currentStart - target.start),
    Math.abs(clipDrag.value.currentStart - target.end),
  );
  return snapEnabled.value && distance <= 7 / pixelsPerSecond.value
    ? target.start * pixelsPerSecond.value
    : null;
});

const materialForSlot = (slotId: string): EffectTemplateMixMaterial | null => {
  const materialId = props.variant?.bindings[slotId];
  return materialId ? (materialById.value.get(materialId) ?? null) : null;
};
type TimelineInterval = { end: number; id: string; start: number };
const assignIntervalLanes = (items: TimelineInterval[]): Map<string, number> => {
  const laneEnds: number[] = [];
  const lanes = new Map<string, number>();
  for (const item of [...items].sort((left, right) => left.start - right.start || left.id.localeCompare(right.id))) {
    const lane = laneEnds.findIndex((end) => end <= item.start + 1 / props.fps);
    const nextLane = lane >= 0 ? lane : laneEnds.length;
    laneEnds[nextLane] = item.end;
    lanes.set(item.id, nextLane);
  }
  return lanes;
};
const timelineCaptions = computed(() =>
  props.packaging?.checkpoint.captions ?? props.variant?.captions ?? [],
);
const captionLaneById = computed(() =>
  assignIntervalLanes(
    timelineCaptions.value.map((caption) => ({
      id: caption.id,
      start: Math.max(0, caption.start),
      end: Math.max(caption.start, caption.end),
    })),
  ),
);
const captionLaneCount = computed(() => Math.max(1, captionLaneById.value.size ? Math.max(...captionLaneById.value.values()) + 1 : 1));
const fileUrl = (id: string): string =>
  props.projectId ? apiUrl(`/projects/${props.projectId}/file-objects/${id}/content`) : '';
// Only a finished item can be saved, so unfinished drafts must not offer edit gestures.
const audioEditable = computed(() => props.packaging?.status === 'COMPLETED');
const timelineAudios = computed<TimelineAudio[]>(() => {
  const packaged = props.packaging;
  if (packaged) {
    const script = packaged.checkpoint.script ?? [];
    const voices = Object.entries(packaged.checkpoint.voices ?? {}).map(([id, audio]) => {
      const offset = Math.max(0, audio.offset ?? 0);
      return {
        id: `voice:${id}`,
        kind: 'VOICE' as const,
        label: '口播草稿',
        start: audio.start,
        duration: audio.duration,
        offset,
        sourceDuration: offset + audio.duration,
        volume: audio.volume,
        sourceUrl: fileUrl(audio.fileObjectId),
        editable: audioEditable.value,
        text: script.find((line) => line.id === id)?.text,
      };
    });
    const music = packaged.checkpoint.music
      ? [{
          id: 'music',
          kind: 'MUSIC' as const,
          label: '纯音乐草稿',
          start: packaged.checkpoint.music.start,
          duration: packaged.checkpoint.music.duration,
          offset: Math.max(0, packaged.checkpoint.music.offset ?? 0),
          sourceDuration:
            Math.max(0, packaged.checkpoint.music.offset ?? 0) +
            packaged.checkpoint.music.duration,
          volume: packaged.checkpoint.music.volume,
          sourceUrl: fileUrl(packaged.checkpoint.music.fileObjectId),
          editable: audioEditable.value,
        }]
      : [];
    return [...voices, ...music];
  }
  // Legacy variant audio has no packaging checkpoint behind it, so it stays read-only.
  const legacy = (id: string, kind: TimelineAudioKind, audio: EffectTemplateMixAudio) => ({
    id,
    kind,
    label: audio.name,
    start: audio.start,
    duration: audio.duration,
    offset: Math.max(0, audio.offset ?? 0),
    sourceDuration: Math.max(0, audio.offset ?? 0) + audio.duration,
    volume: audio.volume,
    sourceUrl: fileUrl(audio.fileObjectId),
    editable: false,
  });
  return [
    ...(props.variant?.voice ? [legacy('voice', 'VOICE', props.variant.voice)] : []),
    ...(props.variant?.bgm ? [legacy('music', 'MUSIC', props.variant.bgm)] : []),
  ];
});
// Captions are their own cards, so they carry no waveform and no audio geometry.
const timelineCaptionEntries = computed(() =>
  timelineCaptions.value.map((caption) => ({ caption, id: `caption:${caption.id}` })),
);
const audioLaneById = computed(() =>
  assignIntervalLanes(
    timelineAudios.value.map((audio) => ({
      id: audio.id,
      start: Math.max(0, audio.start),
      end: Math.max(audio.start, audio.start + audio.duration),
    })),
  ),
);
const audioLaneCount = computed(() => Math.max(1, audioLaneById.value.size ? Math.max(...audioLaneById.value.values()) + 1 : 1));
// Keep one baseline caption/audio lane visible like a conventional editor.
// Additional lanes are added by the interval packer when clips overlap; only
// those dynamically-created lanes should disappear when no longer occupied.
const hasCaptionTrack = computed(() => true);
const hasAudioTrack = computed(() => true);
const trackHeight = (track: VisibleTrack): number =>
  track === 'VIDEO'
    ? videoLaneCount.value * 70 + 6
    : (track === 'CAPTION'
        ? captionLaneCount.value * CAPTION_LANE_HEIGHT
        : audioLaneCount.value * AUDIO_LANE_HEIGHT) + 6;
const orderedTracks = computed<VisibleTrack[]>(() => {
  const tracks: VisibleTrack[] = [...trackOrder.value, 'AUDIO'];
  return tracks.filter(
    (track) => track === 'VIDEO' || (track === 'CAPTION' ? hasCaptionTrack.value : hasAudioTrack.value),
  );
});
const visiblePrimaryTracks = computed(() =>
  trackOrder.value.filter((track) => track === 'VIDEO' || hasCaptionTrack.value),
);
const setVideoTrackElement = (element: unknown): void => {
  const candidates = Array.isArray(element) ? element : [element];
  videoTrack.value =
    candidates.find((candidate): candidate is HTMLElement => candidate instanceof HTMLElement) ??
    null;
};
const setCaptionTrackElement = (element: unknown): void => {
  const candidates = Array.isArray(element) ? element : [element];
  captionTrack.value =
    candidates.find((candidate): candidate is HTMLElement => candidate instanceof HTMLElement) ??
    null;
};
const setAudioTrackElement = (element: unknown): void => {
  const candidates = Array.isArray(element) ? element : [element];
  audioTrack.value =
    candidates.find((candidate): candidate is HTMLElement => candidate instanceof HTMLElement) ??
    null;
};

const rangeForSlot = (slotId: string): { start: number; end: number } | null =>
  layoutSlots.value.find((item) => item.id === slotId) ?? null;

const edgeTrimBlocked = (slotId: string, side: 'LEFT' | 'RIGHT'): boolean => {
  const range = rangeForSlot(slotId);
  if (!range) return true;
  const threshold = 1 / props.fps;
  return layoutSlots.value.some((candidate) => {
    if (candidate.id === slotId || !materialForSlot(candidate.id)) return false;
    if (side === 'LEFT') {
      return candidate.start < range.start - threshold || candidate.end <= range.start + threshold;
    }
    return candidate.start >= range.end - threshold || candidate.end > range.end + threshold;
  });
};

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
  const isHardCut = slot.transition === '硬切';
  return {
    left: `${(range?.start ?? 0) * pixelsPerSecond.value}px`,
    top: `${7 + clipLane(slot.id) * 70}px`,
    width: isHardCut ? '8px' : `${Math.max(16, duration * pixelsPerSecond.value)}px`,
  };
};

const clipStyle = (slot: EffectTemplateMixSlot): Record<string, string> => {
  const range = rangeForSlot(slot.id);
  const edgeTrim = edgeTrimDrag.value?.slotId === slot.id ? edgeTrimDrag.value : null;
  const drag = clipDrag.value;
  const delta = draggingGroupDelta.value;
  const isDraggedSelection = Boolean(delta) && Boolean(drag?.selectedSlotIds.includes(slot.id));
  const start = edgeTrim
    ? edgeTrim.currentStart
    : isDraggedSelection
    ? Math.max(0, (drag?.initialStarts[slot.id] ?? range?.start ?? 0) + (delta?.start ?? 0))
    : (range?.start ?? 0);
  const lane = isDraggedSelection
    ? Math.max(
        0,
        (drag?.initialLanes[slot.id] ?? clipLane(slot.id)) + (delta?.lane ?? 0),
      )
    : clipLane(slot.id);
  return {
    left: `${start * pixelsPerSecond.value}px`,
    top: `${7 + lane * 70}px`,
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
  edgeTrimDrag.value?.slotId === slotId
    ? edgeTrimDrag.value.currentStart
    : clipStart(slotId);

const waveformBarCount = (slot: EffectTemplateMixSlot): number =>
  Math.max(28, Math.min(240, Math.ceil((activeSlotDuration(slot.id) * pixelsPerSecond.value) / 2)));

const audioWaveformBarCount = (seconds: number): number =>
  Math.max(24, Math.min(320, Math.ceil((seconds * pixelsPerSecond.value) / 2)));

/** BGM keeps the pipeline's conservative headroom; voiceovers may reach full scale. */
const audioVolumeMax = (kind: TimelineAudioKind): number => (kind === 'MUSIC' ? 0.3 : 1);

const activeAudioDrag = (id: string): AudioDragState | null =>
  audioDrag.value?.id === id ? audioDrag.value : null;

const audioClipStyle = (audio: TimelineAudio): Record<string, string> => {
  const drag = activeAudioDrag(audio.id);
  const start = drag ? drag.currentStart : audio.start;
  const duration = drag ? drag.currentDuration : audio.duration;
  return {
    height: `${AUDIO_CLIP_HEIGHT}px`,
    left: `${Math.max(0, start) * pixelsPerSecond.value}px`,
    top: `${AUDIO_CLIP_INSET + (audioLaneById.value.get(audio.id) ?? 0) * AUDIO_LANE_HEIGHT}px`,
    width: `${Math.max(14, duration * pixelsPerSecond.value)}px`,
  };
};

const audioVolumeLineStyle = (audio: TimelineAudio): Record<string, string> => {
  const drag = activeAudioDrag(audio.id);
  const volume = drag ? drag.currentVolume : audio.volume;
  const ratio = Math.max(0, Math.min(1, volume / audioVolumeMax(audio.kind)));
  return { top: `${(1 - ratio) * 100}%` };
};

const captionClipStyle = (caption: EffectTemplateMixCaption): Record<string, string> => {
  const drag = activeAudioDrag(`caption:${caption.id}`);
  const start = drag ? drag.currentStart : caption.start;
  const duration = drag ? drag.currentDuration : caption.end - caption.start;
  return {
    height: `${CAPTION_CLIP_HEIGHT}px`,
    left: `${Math.max(0, start) * pixelsPerSecond.value}px`,
    top: `${AUDIO_CLIP_INSET + (captionLaneById.value.get(caption.id) ?? 0) * CAPTION_LANE_HEIGHT}px`,
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

const slotIdFromDragEvent = (event: DragEvent): string => {
  const target =
    event.target instanceof Element ? event.target.closest<HTMLElement>('[data-slot-id]') : null;
  if (target?.dataset.slotId) return target.dataset.slotId;
  const element = viewport.value;
  if (!element || !layoutSlots.value.length) return '';
  const bounds = element.getBoundingClientRect();
  const time = (event.clientX - bounds.left + element.scrollLeft) / pixelsPerSecond.value;
  return (
    layoutSlots.value.find(({ start, end }) => time >= start && time < end)?.id ??
    layoutSlots.value.at(-1)?.id ??
    ''
  );
};

const acceptsMaterialDrag = (event: DragEvent): boolean =>
  Boolean(
    props.variant &&
    !trackLocked.VIDEO &&
    event.dataTransfer?.types.includes('application/x-effect-template-mix-material'),
  );

const onMaterialDragOver = (event: DragEvent): void => {
  if (!acceptsMaterialDrag(event)) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  materialDropSlotId.value = slotIdFromDragEvent(event);
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
};

const onMaterialDrop = (event: DragEvent): void => {
  if (!acceptsMaterialDrag(event)) return;
  event.preventDefault();
  const slotId = slotIdFromDragEvent(event) || materialDropSlotId.value;
  const materialId =
    event.dataTransfer?.getData('application/x-effect-template-mix-material') ?? '';
  materialDropSlotId.value = '';
  if (!slotId || !materialId) return;
  setSelection([slotId]);
  emit('assignMaterial', materialId, slotId);
};

const syncTrackScroll = (source: 'HEADERS' | 'VIEWPORT'): void => {
  const sourceElement = source === 'HEADERS' ? trackHeaders.value : viewport.value;
  const targetElement = source === 'HEADERS' ? viewport.value : trackHeaders.value;
  if (!sourceElement || !targetElement) return;
  if (Math.abs(targetElement.scrollTop - sourceElement.scrollTop) > 0.5) {
    targetElement.scrollTop = sourceElement.scrollTop;
  }
};

const startTransitionResize = (event: PointerEvent, slotId: string): void => {
  if (event.button !== 0 || trackLocked.VIDEO) return;
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
};

const onClipPointerDown = (event: PointerEvent, slotId: string): void => {
  if (event.button !== 0 || trackLocked.VIDEO) return;
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
      (nearLeftEdge && edgeTrimBlocked(slotId, 'LEFT')) ||
      (nearRightEdge && edgeTrimBlocked(slotId, 'RIGHT'))
    ) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
  }
  event.preventDefault();
  event.stopPropagation();
  timelineShell.value?.focus({ preventScroll: true });
  selectedAudioIds.value = [];
  if (event.ctrlKey || event.metaKey) {
    const next = selectedClipIds.value.includes(slotId)
      ? selectedClipIds.value.filter((id) => id !== slotId)
      : [...selectedClipIds.value, slotId];
    setSelection(next);
  } else if (!selectedClipIds.value.includes(slotId)) {
    setSelection([slotId]);
  }
  const element = viewport.value;
  const range = rangeForSlot(slotId);
  if (!element || !range) return;
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
    grabOffset:
      event.clientX - bounds.left + element.scrollLeft - range.start * pixelsPerSecond.value,
    initialLanes,
    initialStarts,
    selectedSlotIds,
    selectionModifier: event.ctrlKey || event.metaKey,
    slotId,
    startClientX: event.clientX,
    startClientY: event.clientY,
    started: false,
    targetSlotId: slotId,
  };
  addWindowPointerListeners();
};

const beginTrim = (event: PointerEvent, slotId: string): void => {
  if (event.button !== 0 || trackLocked.VIDEO) return;
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

const beginEdgeTrim = (
  event: PointerEvent,
  slotId: string,
  side: 'LEFT' | 'RIGHT',
): void => {
  if (event.button !== 0 || trackLocked.VIDEO) return;
  const slot = props.variant?.slots.find(({ id }) => id === slotId);
  const material = slot ? materialForSlot(slotId) : null;
  if (!slot || !material || edgeTrimBlocked(slotId, side)) return;
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
  (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
  addWindowPointerListeners();
};

const beginAudioDrag = (
  event: PointerEvent,
  target: AudioDragTarget,
  mode: AudioDragMode,
  bounds: DOMRect | null,
): void => {
  audioDrag.value = {
    id: target.id,
    kind: target.kind,
    mode,
    initialStart: target.start,
    initialOffset: target.offset,
    initialDuration: target.duration,
    initialVolume: target.volume,
    initialSourceDuration: target.sourceDuration,
    minStart: target.minStart ?? 0,
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

const onAudioPointerDown = (event: PointerEvent, audio: TimelineAudio): void => {
  if (event.button !== 0 || trackLocked.AUDIO) return;
  if (audioEdgeHandleDisabled(event)) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  if (!audio.editable) {
    selectedClipIds.value = [];
    selectedAudioIds.value = [];
    return;
  }
  if (event.ctrlKey || event.metaKey) {
    // A modifier click only edits the selection, so it never starts a drag.
    selectedClipIds.value = [];
    const group = audioGroupIds();
    selectedAudioIds.value = group.includes(audio.id)
      ? group.filter((id) => id !== audio.id)
      : [...group, audio.id];
    return;
  }
  // Clicking one of several selected blocks keeps the set, so the whole group can be dragged.
  if (!audioGroupIds().includes(audio.id)) selectAudio(audio.id);
  else if (selectedAudioIds.value[0] !== audio.id) {
    // The grabbed block leads the set because the editor row reads its volume and fades as the
    // standard the rest of the group takes, so reordering is what makes the pointer the reference.
    selectedAudioIds.value = [audio.id, ...selectedAudioIds.value.filter((id) => id !== audio.id)];
  }
  beginAudioDrag(event, audio, 'MOVE', null);
};

const beginAudioTrim = (
  event: PointerEvent,
  audio: AudioDragTarget,
  side: 'LEFT' | 'RIGHT',
): void => {
  if (event.button !== 0 || trackLocked.AUDIO) return;
  event.preventDefault();
  event.stopPropagation();
  selectAudio(audio.id);
  beginAudioDrag(event, audio, side, null);
};

const beginAudioVolume = (event: PointerEvent, audio: TimelineAudio): void => {
  if (event.button !== 0 || trackLocked.AUDIO) return;
  event.preventDefault();
  event.stopPropagation();
  // Volume is the audio counterpart of a caption's size, so a set takes one level together.
  if (!audioGroupIds().includes(audio.id)) selectAudio(audio.id);
  const clip =
    event.currentTarget instanceof Element
      ? event.currentTarget.closest('.audio-clip')
      : null;
  beginAudioDrag(event, audio, 'VOLUME', clip?.getBoundingClientRect() ?? null);
};

/** Captions move independently, so their neighbours are the only overlap fence. */
const captionBounds = (caption: EffectTemplateMixCaption): { minStart: number; maxEnd: number } => {
  const rows = [...timelineCaptions.value].sort((left, right) => left.start - right.start);
  const index = rows.findIndex((row) => row.id === caption.id);
  return {
    minStart: index > 0 ? rows[index - 1]!.end : 0,
    maxEnd:
      index >= 0 && index + 1 < rows.length ? rows[index + 1]!.start : timelineDuration.value,
  };
};

const captionDragTarget = (caption: EffectTemplateMixCaption): AudioDragTarget => ({
  id: `caption:${caption.id}`,
  kind: 'VOICE',
  start: caption.start,
  offset: 0,
  duration: Math.max(0, caption.end - caption.start),
  volume: 1,
  // Captions are pure text, so only the timeline and their neighbours limit them.
  sourceDuration: Number.POSITIVE_INFINITY,
  ...captionBounds(caption),
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
  if (event.button !== 0 || trackLocked.CAPTION) return;
  if (audioEdgeHandleDisabled(event)) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  if (!audioEditable.value) {
    selectedClipIds.value = [];
    selectedAudioIds.value = [];
    return;
  }
  const id = `caption:${caption.id}`;
  if (event.ctrlKey || event.metaKey) {
    // A modifier click only edits the selection, so it never starts a drag.
    const selected = selectedAudioIds.value.filter((current) => current.startsWith('caption:'));
    selectedAudioIds.value = selected.includes(id)
      ? selected.filter((current) => current !== id)
      : [...selected, id];
    return;
  }
  // Clicking one of several selected cards keeps the group, so the whole set can be dragged.
  if (!selectedAudioIds.value.includes(id)) selectAudio(`caption:${caption.id}`);
  beginAudioDrag(event, captionDragTarget(caption), 'MOVE', null);
};

const beginCaptionTrim = (
  event: PointerEvent,
  caption: EffectTemplateMixCaption,
  side: 'LEFT' | 'RIGHT',
): void => {
  if (event.button !== 0 || trackLocked.CAPTION) return;
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
defineExpose({ clearSelection });

/**
 * Anything on the timeline that is not the material itself clears the selection. The ruler and the
 * playhead are the two exceptions: both are scrubbing gestures, so they seek without touching what
 * is selected. A block is the material, and clicking it is how you pick it in the first place.
 */
const onShellPointerDown = (event: PointerEvent): void => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const keep = target.closest(
    '.time-ruler, .timeline-playhead, [data-slot-id], [data-audio-id], .selection-marquee',
  );
  if (keep) return;
  clearSelection();
};

const onTrackPointerDown = (event: PointerEvent, track: VisibleTrack): void => {
  if (event.button !== 0 || event.target !== event.currentTarget || trackLocked[track]) return;
  event.preventDefault();
  timelineShell.value?.focus({ preventScroll: true });
  setSelection([]);
  selectedAudioIds.value = [];
  seekFromClientX(event.clientX);
  // Every lane marquees, and each one only ever picks the blocks that live on it.
  if (track === 'VIDEO' || track === 'CAPTION' || track === 'AUDIO') {
    marquee.value = {
      currentClientX: event.clientX,
      currentClientY: event.clientY,
      moved: false,
      startClientX: event.clientX,
      startClientY: event.clientY,
      track,
    };
    addWindowPointerListeners();
  }
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
  const time = (clientX - bounds.left + element.scrollLeft) / pixelsPerSecond.value;
  drag.currentStart = rawStart;
  drag.targetSlotId = layoutSlots.value.reduce((best, candidate) => {
    const bestCenter = (best.start + best.end) / 2;
    const candidateCenter = (candidate.start + candidate.end) / 2;
    return Math.abs(candidateCenter - time) < Math.abs(bestCenter - time) ? candidate : best;
  }, layoutSlots.value[0]!).id;
  if (snapEnabled.value) {
    const snapThreshold = 7 / pixelsPerSecond.value;
    const draggedSelection = new Set(drag.selectedSlotIds);
    const candidates = [
      0,
      timelineDuration.value,
      ...layoutSlots.value
        .filter(({ id }) => !draggedSelection.has(id))
        .flatMap(({ start, end }) => [start, end]),
    ];
    const snapped = candidates.find((candidate) => Math.abs(candidate - rawStart) <= snapThreshold);
    if (snapped !== undefined) drag.currentStart = snapped;
  }
  const videoBounds = videoTrack.value?.getBoundingClientRect();
  if (videoBounds) {
    if (clientY < videoBounds.top) {
      // Dropping above the first visible lane asks the parent to insert a new
      // top lane instead of silently clamping the move back onto lane 0.
      drag.currentLane = -1;
    } else if (clientYInVideoTrack(clientY, videoBounds)) {
      drag.currentLane = Math.max(0, Math.floor((clientY - videoBounds.top) / 70));
    }
  }
  // Keep the ghost under the pointer while dragging, even when it temporarily
  // overlaps another clip. The parent resolves the final placement on pointerup,
  // matching Jianying's forgiving drag interaction instead of fighting the cursor.
  const edge = 40;
  if (clientX < bounds.left + edge) element.scrollLeft -= 16;
  if (clientX > bounds.right - edge) element.scrollLeft += 16;
};

const clientYInVideoTrack = (clientY: number, bounds: DOMRect): boolean =>
  clientY >= bounds.top && clientY <= bounds.bottom;

const updateMarqueeSelection = (): void => {
  const box = marquee.value;
  const element = viewport.value;
  const track =
    box?.track === 'CAPTION'
      ? captionTrack.value
      : box?.track === 'AUDIO'
        ? audioTrack.value
        : videoTrack.value;
  if (!box || !element || !track) return;
  const clear = (): void => {
    if (box.track === 'VIDEO') selectedClipIds.value = [];
    else selectedAudioIds.value = [];
  };
  const trackBounds = track.getBoundingClientRect();
  const verticalStart = Math.min(box.startClientY, box.currentClientY);
  const verticalEnd = Math.max(box.startClientY, box.currentClientY);
  if (verticalEnd < trackBounds.top || verticalStart > trackBounds.bottom) {
    clear();
    return;
  }
  const viewportBounds = element.getBoundingClientRect();
  const left =
    Math.min(box.startClientX, box.currentClientX) - viewportBounds.left + element.scrollLeft;
  const right =
    Math.max(box.startClientX, box.currentClientX) - viewportBounds.left + element.scrollLeft;
  // Captions and voice/BGM blocks share one selection list, so both lanes write to it.
  if (box.track === 'CAPTION' || box.track === 'AUDIO') {
    const entries =
      box.track === 'CAPTION'
        ? timelineCaptionEntries.value.map((entry) => ({
            id: entry.id,
            start: entry.caption.start,
            end: entry.caption.end,
          }))
        : timelineAudios.value
            // Legacy read-only audio has no checkpoint behind it, so it never joins a group.
            .filter((audio) => audio.editable)
            .map((audio) => ({
              id: audio.id,
              start: audio.start,
              end: audio.start + audio.duration,
            }));
    selectedAudioIds.value = entries
      .filter((entry) => {
        const clipLeft = Math.max(0, entry.start) * pixelsPerSecond.value;
        const clipRight = Math.max(entry.start, entry.end) * pixelsPerSecond.value;
        return clipRight >= left && clipLeft <= right;
      })
      .map(({ id }) => id);
    return;
  }
  if (!props.variant) return;
  selectedClipIds.value = props.variant.slots
    .filter((slot) => {
      const range = rangeForSlot(slot.id);
      if (!range) return false;
      const clipLeft = range.start * pixelsPerSecond.value;
      const clipRight = range.end * pixelsPerSecond.value;
      return clipRight >= left && clipLeft <= right;
    })
    .map(({ id }) => id);
};

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
    const delta = quantizeToFrame(
      (event.clientX - drag.startClientX) / pixelsPerSecond.value,
    );
    const minimumDuration = Math.min(0.1, material.duration);
    const sourceEnd = drag.initialOffset + drag.initialDuration;
    if (drag.side === 'LEFT') {
      const requestedOffset = Math.max(
        0,
        Math.min(sourceEnd - minimumDuration, drag.initialOffset + delta),
      );
      const requestedDuration = sourceEnd - requestedOffset;
      const maxTimelineDuration = drag.initialDuration + drag.initialStart;
      const currentDuration = Math.max(
        minimumDuration,
        Math.min(requestedDuration, maxTimelineDuration),
      );
      drag.currentDuration = currentDuration;
      drag.currentOffset = sourceEnd - currentDuration;
      drag.currentStart = Math.max(
        0,
        drag.initialStart + drag.initialDuration - currentDuration,
      );
    } else {
      drag.currentOffset = drag.initialOffset;
      drag.currentDuration = Math.max(
        minimumDuration,
        Math.min(material.duration - drag.initialOffset, drag.initialDuration + delta),
      );
      drag.currentStart = drag.initialStart;
    }
    drag.moved = Math.abs(event.clientX - drag.startClientX) > 2;
    return;
  }
  if (audioDrag.value) {
    const drag = audioDrag.value;
    const minimumDuration = Math.min(AUDIO_MIN_DURATION, 1 / props.fps);
    const delta = quantizeToFrame((event.clientX - drag.startClientX) / pixelsPerSecond.value);
    if (drag.mode === 'VOLUME') {
      const max = audioVolumeMax(drag.kind);
      const ratio =
        1 - (event.clientY - drag.volumeTop) / Math.max(1, drag.volumeHeight);
      drag.currentVolume = Math.max(0, Math.min(max, Math.round(ratio * max * 100) / 100));
    } else if (drag.mode === 'MOVE') {
      drag.currentStart = Math.max(
        drag.minStart,
        Math.min(
          drag.maxEnd - drag.initialDuration,
          Math.max(0, timelineDuration.value - drag.initialDuration),
          drag.initialStart + delta,
        ),
      );
    } else if (drag.mode === 'LEFT') {
      // The left edge can only reveal source that was trimmed away, or empty timeline.
      const minimumDelta = Math.max(drag.minStart - drag.initialStart, -drag.initialOffset);
      const requested = Math.max(
        minimumDelta,
        Math.min(drag.initialDuration - minimumDuration, delta),
      );
      drag.currentStart = Math.max(0, drag.initialStart + requested);
      drag.currentOffset = Math.max(
        0,
        drag.initialOffset + (drag.currentStart - drag.initialStart),
      );
      drag.currentDuration = drag.initialDuration - (drag.currentStart - drag.initialStart);
    } else {
      drag.currentOffset = drag.initialOffset;
      drag.currentStart = drag.initialStart;
      drag.currentDuration = Math.max(
        minimumDuration,
        Math.min(
          drag.initialSourceDuration - drag.initialOffset,
          drag.maxEnd - drag.initialStart,
          timelineDuration.value - drag.initialStart,
          drag.initialDuration + delta,
        ),
      );
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
    if (moves.length > 1) emit('moveClips', moves);
    else if (moves[0]) emit('moveClip', moves[0].slotId, moves[0].start, moves[0].lane);
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
  if (marquee.value?.moved && marquee.value.track === 'VIDEO') {
    emit('selectSlot', selectedClipIds.value.at(-1) ?? '');
  }
  const audio = audioDrag.value;
  if (audio?.moved) {
    const isCaption = audio.id.startsWith('caption:');
    const group = dragGroupIds(audio.id);
    if (audio.mode === 'VOLUME') {
      // Each kind has its own ceiling, so a shared level still lands inside every clip's range.
      if (!group.length) emit('changeAudioVolume', audio.id, audio.currentVolume);
      else
        for (const id of group) {
          const clip = timelineAudios.value.find((item) => item.id === id);
          if (clip) {
            emit('changeAudioVolume', id, Math.min(audio.currentVolume, audioVolumeMax(clip.kind)));
          }
        }
    } else if (audio.mode === 'MOVE') {
      const delta = audio.currentStart - audio.initialStart;
      if (!group.length) emit('moveAudioClip', audio.id, audio.currentStart);
      else if (isCaption) {
        // A group slides rigidly, so the shared delta is capped by the caption nearest the start
        // instead of letting each one clamp on its own and pull the group apart.
        const earliest = Math.min(
          ...group.map((id) => timelineCaptionEntries.value.find((e) => e.id === id)?.caption.start ?? 0),
        );
        const shared = Math.max(delta, -earliest);
        for (const id of group) {
          const entry = timelineCaptionEntries.value.find((item) => item.id === id);
          if (entry) emit('moveAudioClip', id, Math.max(0, entry.caption.start + shared));
        }
      } else {
        // Voice/BGM blocks slide rigidly too: the delta is bounded by whichever block would leave
        // the timeline first, so the set keeps its shape instead of bunching up at the edges.
        const clips = group
          .map((id) => timelineAudios.value.find((item) => item.id === id))
          .filter((clip): clip is TimelineAudio => Boolean(clip));
        const earliest = Math.min(...clips.map((clip) => clip.start));
        const latest = Math.max(...clips.map((clip) => clip.start + clip.duration));
        const shared = Math.min(
          Math.max(delta, -earliest),
          timelineDuration.value - latest,
        );
        for (const clip of clips) emit('moveAudioClip', clip.id, Math.max(0, clip.start + shared));
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
  clipDrag.value = null;
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
  if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'a') return;
  event.preventDefault();
  event.stopPropagation();
  setSelection(props.variant?.slots.map(({ id }) => id) ?? []);
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
  updateViewportWidth();
  resizeObserver = new ResizeObserver(updateViewportWidth);
  if (viewport.value) resizeObserver.observe(viewport.value);
  void fitTimeline();
});

onBeforeUnmount(() => {
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
          >素材可直接拖入 · 点击标尺定位 · 拖动片段换位 · 滚动查看上下轨道 · 拖边恢复素材时长</span
        >
      </div>
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
            :class="`track-${track.toLowerCase()}`"
            :style="{ height: `${trackHeight(track)}px` }"
          >
            <div class="track-name">
              <Film v-if="track === 'VIDEO'" :size="14" />
              <Captions v-else-if="track === 'CAPTION'" :size="14" />
              <Volume2 v-else :size="14" />
              <span>{{
                track === 'VIDEO' ? '主视频' : track === 'CAPTION' ? '字幕' : '音频'
              }}</span>
            </div>
            <div class="track-actions">
              <button
                type="button"
                :title="trackLocked[track] ? '解锁轨道' : '锁定轨道'"
                @click="trackLocked[track] = !trackLocked[track]"
              >
                <Lock v-if="trackLocked[track]" :size="12" />
                <Unlock v-else :size="12" />
              </button>
              <button
                type="button"
                :title="trackVisible[track] ? '隐藏轨道' : '显示轨道'"
                @click="trackVisible[track] = !trackVisible[track]"
              >
                <Eye v-if="trackVisible[track]" :size="12" />
                <EyeOff v-else :size="12" />
              </button>
              <button
                v-if="track === 'AUDIO'"
                type="button"
                :title="trackMuted.AUDIO ? '取消静音' : '静音轨道'"
                @click="trackMuted.AUDIO = !trackMuted.AUDIO"
              >
                <VolumeX v-if="trackMuted.AUDIO" :size="12" />
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

      <div
        ref="viewport"
        class="timeline-viewport"
        @scroll="syncTrackScroll('VIEWPORT')"
      >
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
              v-if="track === 'CAPTION'"
              :ref="setCaptionTrackElement"
              class="timeline-track caption-track"
              :style="{ height: `${trackHeight('CAPTION')}px` }"
              :class="{ 'is-hidden': !trackVisible.CAPTION, 'is-locked': trackLocked.CAPTION }"
              @pointerdown="onTrackPointerDown($event, 'CAPTION')"
            >
              <div
                v-for="entry in timelineCaptionEntries"
                :key="entry.caption.id"
                class="caption-clip"
                :class="{
                  'is-selected': selectedAudioIds.includes(entry.id),
                  'is-dragging': audioDrag?.id === entry.id && audioDrag.mode === 'MOVE',
                }"
                :style="captionClipStyle(entry.caption)"
                :data-audio-id="entry.id"
                :title="entry.caption.text"
                @pointerdown="onCaptionPointerDown($event, entry.caption)"
              >
                <Captions class="caption-clip-icon" :size="13" aria-hidden="true" />
                <span class="caption-clip-text">{{ entry.caption.text }}</span>
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
              :class="{ 'is-hidden': !trackVisible.VIDEO, 'is-locked': trackLocked.VIDEO }"
              @dragleave="onTrackDragLeave"
              @dragover="onTrackDragOver"
              @drop="onTrackDrop"
              @pointerdown="onTrackPointerDown($event, 'VIDEO')"
            >
              <template v-if="variant">
                <article
                  v-for="slot in variant.slots"
                  :key="slot.id"
                  class="video-clip"
                  :class="{
                    'is-selected': selectedClipIds.includes(slot.id),
                    'is-dragging':
                      clipDrag?.slotId === slot.id &&
                      clipDrag.started &&
                      clipDrag.selectedSlotIds.length === 1,
                    'is-low': variant.bindingMetadata?.[slot.id]?.matchLevel === 'LOW_MATCH',
                    'is-missing':
                      !materialForSlot(slot.id) || variant.conflictSlotIds.includes(slot.id),
                    'is-material-target': materialDropSlotId === slot.id,
                  }"
                  :style="{
                    ...clipStyle(slot),
                  }"
                  :data-slot-id="slot.id"
                  @pointerdown="onClipPointerDown($event, slot.id)"
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
                      <em v-if="variant.bindingMetadata?.[slot.id]?.matchLevel === 'LOW_MATCH'"
                        >低匹配</em
                      >
                    </div>
                    <EffectTemplateMixWaveform
                      :bar-count="waveformBarCount(slot)"
                      :duration="activeSlotDuration(slot.id)"
                      :source="materialForSlot(slot.id)!.contentUrl"
                      :trim-start="activeTrimOffset(slot.id)"
                    />
                  </template>
                  <div v-else class="missing-copy">
                    <b>待补素材</b>
                    <span
                      >{{ EFFECT_TEMPLATE_MIX_ROLE_LABELS[slot.role] }} · {{ slot.duration }}s</span
                    >
                  </div>
                  <button
                    v-if="selectedClipIds.includes(slot.id) && materialForSlot(slot.id)"
                    class="edge-trim-handle edge-trim-left"
                    :class="{ 'is-disabled': edgeTrimBlocked(slot.id, 'LEFT') }"
                    type="button"
                    :disabled="edgeTrimBlocked(slot.id, 'LEFT')"
                    :title="
                      edgeTrimBlocked(slot.id, 'LEFT')
                        ? '左侧已有素材，无法调整左边缘'
                        : '拖动左边缘调整素材起点和时长'
                    "
                    :aria-label="
                      edgeTrimBlocked(slot.id, 'LEFT')
                        ? '左侧已有素材，无法调整左边缘'
                        : '拖动左边缘调整素材起点和时长'
                    "
                    @pointerdown="beginEdgeTrim($event, slot.id, 'LEFT')"
                  />
                  <button
                    v-if="selectedClipIds.includes(slot.id) && materialForSlot(slot.id)"
                    class="edge-trim-handle edge-trim-right"
                    :class="{ 'is-disabled': edgeTrimBlocked(slot.id, 'RIGHT') }"
                    type="button"
                    :disabled="edgeTrimBlocked(slot.id, 'RIGHT')"
                    :title="
                      edgeTrimBlocked(slot.id, 'RIGHT')
                        ? '右侧已有素材，无法调整右边缘'
                        : '拖动右边缘调整素材时长'
                    "
                    :aria-label="
                      edgeTrimBlocked(slot.id, 'RIGHT')
                        ? '右侧已有素材，无法调整右边缘'
                        : '拖动右边缘调整素材时长'
                    "
                    @pointerdown="beginEdgeTrim($event, slot.id, 'RIGHT')"
                  />
                  <span v-if="edgeTrimDrag?.slotId === slot.id" class="trim-tooltip">
                    源 {{ edgeTrimDrag.currentOffset.toFixed(2) }}s —
                    {{ (edgeTrimDrag.currentOffset + edgeTrimDrag.currentDuration).toFixed(2) }}s
                    · {{ edgeTrimDrag.currentDuration.toFixed(2) }}s
                  </span>
                </article>
                <button
                  v-for="slot in variant.slots.slice(1)"
                  :key="`transition:${slot.id}`"
                  class="transition-junction"
                  :class="{
                    'is-hard-cut': slot.transition === '硬切',
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
                <span
                  v-if="dropGuideLeft !== null && clipDrag?.started"
                  class="snap-guide"
                  :style="{ left: `${dropGuideLeft}px` }"
                />
              </template>
              <div v-else class="timeline-empty-state">
                <Film :size="20" />
                <b>等待 AI 智能填充</b>
                <span>任务成功后，六段素材会按模板顺序自动上轨</span>
              </div>
            </div>
          </template>

          <div
            v-if="hasAudioTrack"
            :ref="setAudioTrackElement"
            class="timeline-track audio-track"
            :style="{ height: `${trackHeight('AUDIO')}px` }"
            :class="{ 'is-hidden': !trackVisible.AUDIO, 'is-locked': trackLocked.AUDIO }"
            @pointerdown="onTrackPointerDown($event, 'AUDIO')"
          >
            <div
              v-for="audio in timelineAudios"
              :key="audio.id"
              class="audio-clip"
              :class="[
                audio.kind === 'VOICE' ? 'voice-clip' : 'bgm-clip',
                {
                  'is-muted': trackMuted.AUDIO,
                  'is-selected': selectedAudioIds.includes(audio.id),
                  'is-dragging': audioDrag?.id === audio.id && audioDrag.mode === 'MOVE',
                },
              ]"
              :style="audioClipStyle(audio)"
              :data-audio-id="audio.id"
              :title="audio.text ?? audio.label"
              @pointerdown="onAudioPointerDown($event, audio)"
            >
              <EffectTemplateMixWaveform
                v-if="audio.sourceUrl"
                layout="fill"
                :tone="audio.kind === 'VOICE' ? 'VOICE' : 'MUSIC'"
                :bar-count="audioWaveformBarCount(audio.duration)"
                :duration="audio.duration"
                :source="audio.sourceUrl"
                :trim-start="audio.offset"
              />
              <span class="audio-clip-label">
                <Volume2 v-if="audio.kind === 'VOICE'" :size="13" />
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

          <div
            v-if="marqueeStyle && marquee?.moved"
            class="selection-marquee"
            :style="marqueeStyle"
          />
          <div
            class="timeline-playhead"
            :style="{ transform: `translate3d(${playheadLeft}px, 0, 0)` }"
          >
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
}
.timeline-tools,
.zoom-controls {
  min-width: 0;
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
}
.track-header.track-video {
  height: 76px;
  color: #263b59;
}
.track-header.track-audio {
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
.timeline-track.audio-track {
  height: 76px;
  background: #f7f9fc;
}
.timeline-track.is-locked {
  cursor: not-allowed;
}
.timeline-track.is-hidden > :not(.track-empty-copy) {
  opacity: 0.12;
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
.video-clip.is-material-target {
  z-index: 12;
  border: 2px solid #2563eb;
  background: #dbeafe;
  box-shadow: 0 0 0 4px #bfdbfeaa;
}
.video-clip.is-material-pointer-target {
  z-index: 12;
  border-color: #2563eb;
  background: #dbeafe;
  box-shadow: 0 0 0 3px #bfdbfe88;
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
  transition: opacity 100ms ease, background 100ms ease;
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
.transition-junction.is-hard-cut {
  width: 8px;
  min-width: 8px;
  height: 55px;
  border: 0;
  border-radius: 0;
  background: #9aabc2;
  color: transparent;
  cursor: pointer;
  opacity: 0.55;
  transform: translateX(-50%);
}
.transition-junction.is-hard-cut::before,
.transition-junction.is-hard-cut::after {
  display: none;
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
  z-index: 17;
  top: -38px;
  bottom: -76px;
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
.audio-clip.is-muted {
  opacity: 0.42;
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
