<script setup lang="ts">
import type {
  EffectTemplateMixMaterial,
  EffectTemplateMixSlot,
  EffectTemplateMixVariant,
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

import {
  EFFECT_TEMPLATE_MIX_ROLE_LABELS,
  effectTemplateMixTiming,
} from './effect-template-mix-state';
import EffectTemplateMixThumbnail from './EffectTemplateMixThumbnail.vue';
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
    selectedSlotId: string;
    variant: EffectTemplateMixVariant | null;
  }>(),
  { canRedo: false, canUndo: false, fps: 30, height: 260 },
);

const emit = defineEmits<{
  assignMaterial: [materialId: string, slotId: string];
  redo: [];
  reorderSlot: [slotId: string, targetSlotId: string];
  seek: [seconds: number];
  selectSlot: [slotId: string];
  trimSlot: [slotId: string, trimStartSeconds: number];
  undo: [];
}>();

type VisibleTrack = 'BGM' | 'CAPTION' | 'VIDEO' | 'VOICE';
type ClipDragState = {
  currentClientX: number;
  grabOffset: number;
  slotId: string;
  startClientX: number;
  started: boolean;
  targetSlotId: string;
};
type TrimDragState = {
  currentOffset: number;
  originalOffset: number;
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

const tracks: VisibleTrack[] = ['CAPTION', 'VIDEO', 'VOICE', 'BGM'];
const viewport = ref<HTMLElement | null>(null);
const canvas = ref<HTMLElement | null>(null);
const videoTrack = ref<HTMLElement | null>(null);
const timelineShell = ref<HTMLElement | null>(null);
const pixelsPerSecond = ref(52);
const viewportWidth = ref(0);
const trackHeaderWidth = ref(120);
const timelineResize = ref<TimelineResizeState | null>(null);
const scrubbing = ref(false);
const snapEnabled = ref(true);
const clipDrag = ref<ClipDragState | null>(null);
const trimDrag = ref<TrimDragState | null>(null);
const marquee = ref<MarqueeState | null>(null);
const materialDropSlotId = ref('');
const selectedClipIds = ref<string[]>([]);
const trackLocked = reactive<Record<VisibleTrack, boolean>>({
  BGM: false,
  CAPTION: false,
  VIDEO: false,
  VOICE: false,
});
const trackVisible = reactive<Record<VisibleTrack, boolean>>({
  BGM: true,
  CAPTION: true,
  VIDEO: true,
  VOICE: true,
});
const trackMuted = reactive<Record<'BGM' | 'VOICE', boolean>>({ BGM: false, VOICE: false });
let resizeObserver: ResizeObserver | null = null;

const timing = computed(() => effectTemplateMixTiming(props.variant?.slots ?? []));
const materialById = computed(() => new Map(props.materials.map((item) => [item.id, item])));
const timelineDuration = computed(() => Math.max(0.1, props.duration));
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
  const ticks: number[] = [];
  const end =
    Math.ceil(timelineDuration.value / majorTickSeconds.value) * majorTickSeconds.value +
    majorTickSeconds.value;
  for (let second = 0; second <= end; second += majorTickSeconds.value)
    ticks.push(Math.round(second * 1000) / 1000);
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
const dragGhostStyle = computed(() => {
  const drag = clipDrag.value;
  const element = viewport.value;
  const slot = draggedSlot.value;
  if (!drag?.started || !element || !slot) return null;
  const bounds = element.getBoundingClientRect();
  const width = slot.duration * pixelsPerSecond.value;
  const left = Math.max(
    0,
    Math.min(
      canvasWidth.value - width,
      drag.currentClientX - bounds.left + element.scrollLeft - drag.grabOffset,
    ),
  );
  return { left: `${left}px`, width: `${Math.max(24, width)}px` };
});
const dropGuideLeft = computed(() => {
  const target = timing.value.slots.find(({ id }) => id === clipDrag.value?.targetSlotId);
  return target ? target.start * pixelsPerSecond.value : null;
});

const materialForSlot = (slotId: string): EffectTemplateMixMaterial | null => {
  const materialId = props.variant?.bindings[slotId];
  return materialId ? (materialById.value.get(materialId) ?? null) : null;
};

const rangeForSlot = (slotId: string): { start: number; end: number } | null =>
  timing.value.slots.find((item) => item.id === slotId) ?? null;

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
  trimDrag.value?.slotId === slotId
    ? trimDrag.value.currentOffset
    : (props.variant?.offsets[slotId] ?? 0);

const thumbnailTimes = (slot: EffectTemplateMixSlot): number[] => {
  const material = materialForSlot(slot.id);
  if (!material) return [];
  // Keep sample timestamps independent of zoom so mounted film frames never
  // change keys or disappear while resizing the timeline.
  const count = 8;
  // A drag preview changes continuously; retain the committed strip until the
  // final trim is saved so all eight frames do not flicker on every pointer move.
  const sourceStart = props.variant?.offsets[slot.id] ?? 0;
  return Array.from({ length: count }, (_, index) =>
    Math.min(
      Math.max(0, material.duration - 0.04),
      sourceStart + ((index + 0.5) / count) * slot.duration,
    ),
  );
};

const waveformBarCount = (slot: EffectTemplateMixSlot): number =>
  Math.max(28, Math.min(240, Math.ceil((slot.duration * pixelsPerSecond.value) / 2)));

const quantizeToFrame = (seconds: number): number => Math.round(seconds * props.fps) / props.fps;

const snapTime = (seconds: number): number => {
  const frameTime = quantizeToFrame(seconds);
  if (!snapEnabled.value) return frameTime;
  const threshold = 7 / pixelsPerSecond.value;
  const targets = [
    0,
    timelineDuration.value,
    ...timing.value.slots.flatMap(({ start, end }) => [start, end]),
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
  if (!element || !timing.value.slots.length) return '';
  const bounds = element.getBoundingClientRect();
  const time = (event.clientX - bounds.left + element.scrollLeft) / pixelsPerSecond.value;
  return (
    timing.value.slots.find(({ start, end }) => time >= start && time < end)?.id ??
    timing.value.slots.at(-1)?.id ??
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

const addWindowPointerListeners = (): void => {
  window.addEventListener('pointermove', onWindowPointerMove);
  window.addEventListener('pointerup', onWindowPointerUp, { once: true });
};

const removeWindowPointerListeners = (): void => {
  window.removeEventListener('pointermove', onWindowPointerMove);
  window.removeEventListener('pointerup', onWindowPointerUp);
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
  event.preventDefault();
  event.stopPropagation();
  if (event.ctrlKey || event.metaKey) {
    const next = selectedClipIds.value.includes(slotId)
      ? selectedClipIds.value.filter((id) => id !== slotId)
      : [...selectedClipIds.value, slotId];
    setSelection(next);
  } else if (!selectedClipIds.value.includes(slotId) || selectedClipIds.value.length > 1) {
    setSelection([slotId]);
  }
  const element = viewport.value;
  const range = rangeForSlot(slotId);
  if (!element || !range) return;
  const bounds = element.getBoundingClientRect();
  clipDrag.value = {
    currentClientX: event.clientX,
    grabOffset:
      event.clientX - bounds.left + element.scrollLeft - range.start * pixelsPerSecond.value,
    slotId,
    startClientX: event.clientX,
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

const onTrackPointerDown = (event: PointerEvent, track: VisibleTrack): void => {
  if (event.button !== 0 || event.target !== event.currentTarget || trackLocked[track]) return;
  event.preventDefault();
  setSelection([]);
  seekFromClientX(event.clientX);
  if (track === 'VIDEO') {
    marquee.value = {
      currentClientX: event.clientX,
      currentClientY: event.clientY,
      moved: false,
      startClientX: event.clientX,
      startClientY: event.clientY,
    };
    addWindowPointerListeners();
  }
};

const updateDragTarget = (clientX: number): void => {
  const drag = clipDrag.value;
  const element = viewport.value;
  if (!drag || !element || !timing.value.slots.length) return;
  const bounds = element.getBoundingClientRect();
  const time = (clientX - bounds.left + element.scrollLeft) / pixelsPerSecond.value;
  drag.targetSlotId = timing.value.slots.reduce((best, candidate) => {
    const bestCenter = (best.start + best.end) / 2;
    const candidateCenter = (candidate.start + candidate.end) / 2;
    return Math.abs(candidateCenter - time) < Math.abs(bestCenter - time) ? candidate : best;
  }, timing.value.slots[0]!).id;
  const edge = 40;
  if (clientX < bounds.left + edge) element.scrollLeft -= 16;
  if (clientX > bounds.right - edge) element.scrollLeft += 16;
};

const updateMarqueeSelection = (): void => {
  const box = marquee.value;
  const element = viewport.value;
  const track = videoTrack.value;
  if (!box || !element || !track || !props.variant) return;
  const trackBounds = track.getBoundingClientRect();
  const verticalStart = Math.min(box.startClientY, box.currentClientY);
  const verticalEnd = Math.max(box.startClientY, box.currentClientY);
  if (verticalEnd < trackBounds.top || verticalStart > trackBounds.bottom) {
    selectedClipIds.value = [];
    return;
  }
  const viewportBounds = element.getBoundingClientRect();
  const left =
    Math.min(box.startClientX, box.currentClientX) - viewportBounds.left + element.scrollLeft;
  const right =
    Math.max(box.startClientX, box.currentClientX) - viewportBounds.left + element.scrollLeft;
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
  if (clipDrag.value) {
    clipDrag.value.currentClientX = event.clientX;
    if (Math.abs(event.clientX - clipDrag.value.startClientX) > 4) clipDrag.value.started = true;
    if (clipDrag.value.started) updateDragTarget(event.clientX);
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
  if (clipDrag.value?.started && clipDrag.value.targetSlotId !== clipDrag.value.slotId)
    emit('reorderSlot', clipDrag.value.slotId, clipDrag.value.targetSlotId);
  if (trimDrag.value) emit('trimSlot', trimDrag.value.slotId, trimDrag.value.currentOffset);
  if (marquee.value?.moved) emit('selectSlot', selectedClipIds.value.at(-1) ?? '');
  scrubbing.value = false;
  clipDrag.value = null;
  trimDrag.value = null;
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

const onWheel = (event: WheelEvent): void => {
  event.preventDefault();
  const element = viewport.value;
  if (!element) return;
  if (event.ctrlKey || event.metaKey || event.shiftKey) {
    const factor = Math.exp(-event.deltaY * 0.0018);
    setZoom(pixelsPerSecond.value * factor, event.clientX);
    return;
  }
  element.scrollLeft +=
    Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
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
    void fitTimeline();
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
    :class="{
      'is-scrubbing': scrubbing,
      'is-resizing-track-header': timelineResize,
    }"
    :style="timelineShellStyle"
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
          >素材可直接拖入 · 点击标尺定位 · 拖动片段换位 · 拖边调整源截取</span
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

    <div class="timeline-workarea">
      <div class="track-headers">
        <span class="ruler-corner" />
        <template v-for="track in tracks" :key="track">
          <div class="track-header" :class="[`track-${track.toLowerCase()}`]">
            <div class="track-name">
              <Film v-if="track === 'VIDEO'" :size="14" />
              <Captions v-else-if="track === 'CAPTION'" :size="14" />
              <Volume2 v-else-if="track === 'VOICE'" :size="14" />
              <Music2 v-else :size="14" />
              <span>{{
                track === 'VIDEO'
                  ? '主视频'
                  : track === 'CAPTION'
                    ? '字幕'
                    : track === 'VOICE'
                      ? '口播'
                      : 'BGM'
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
                v-if="track === 'VOICE' || track === 'BGM'"
                type="button"
                :title="trackMuted[track] ? '取消静音' : '静音轨道'"
                @click="trackMuted[track] = !trackMuted[track]"
              >
                <VolumeX v-if="trackMuted[track]" :size="12" />
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

      <div ref="viewport" class="timeline-viewport" @wheel="onWheel">
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

          <div
            class="timeline-track caption-track"
            :class="{ 'is-hidden': !trackVisible.CAPTION, 'is-locked': trackLocked.CAPTION }"
            @pointerdown="onTrackPointerDown($event, 'CAPTION')"
          >
            <div
              v-for="caption in variant?.captions ?? []"
              :key="caption.id"
              class="caption-clip"
              :style="{
                left: `${caption.start * pixelsPerSecond}px`,
                width: `${Math.max(14, (caption.end - caption.start) * pixelsPerSecond)}px`,
              }"
            >
              {{ caption.text }}
            </div>
            <span v-if="!variant?.captions.length" class="track-empty-copy">未配置字幕</span>
          </div>

          <div
            ref="videoTrack"
            class="timeline-track video-track"
            :class="{ 'is-hidden': !trackVisible.VIDEO, 'is-locked': trackLocked.VIDEO }"
            @dragleave="onMaterialDragLeave"
            @dragover="onMaterialDragOver"
            @drop="onMaterialDrop"
            @pointerdown="onTrackPointerDown($event, 'VIDEO')"
          >
            <template v-if="variant">
              <article
                v-for="slot in variant.slots"
                :key="slot.id"
                class="video-clip"
                :class="{
                  'is-selected': selectedClipIds.includes(slot.id),
                  'is-dragging': clipDrag?.slotId === slot.id && clipDrag.started,
                  'is-low': variant.bindingMetadata?.[slot.id]?.matchLevel === 'LOW_MATCH',
                  'is-missing':
                    !materialForSlot(slot.id) || variant.conflictSlotIds.includes(slot.id),
                  'is-material-target': materialDropSlotId === slot.id,
                }"
                :style="{
                  left: `${(rangeForSlot(slot.id)?.start ?? 0) * pixelsPerSecond}px`,
                  width: `${Math.max(24, slot.duration * pixelsPerSecond)}px`,
                }"
                :data-slot-id="slot.id"
                @pointerdown="onClipPointerDown($event, slot.id)"
              >
                <template v-if="materialForSlot(slot.id)">
                  <div class="clip-filmstrip" aria-hidden="true">
                    <EffectTemplateMixThumbnail
                      v-for="time in thumbnailTimes(slot)"
                      :key="`${slot.id}:${time}`"
                      :source="materialForSlot(slot.id)!.contentUrl"
                      :time="time"
                      :version="`${materialForSlot(slot.id)!.artifactRevision}:${materialForSlot(slot.id)!.contentHash}`"
                    />
                  </div>
                  <div class="clip-info">
                    <b>{{ materialForSlot(slot.id)?.code }}</b>
                    <span>{{ EFFECT_TEMPLATE_MIX_ROLE_LABELS[slot.role] }}</span>
                    <em v-if="variant.bindingMetadata?.[slot.id]?.matchLevel === 'LOW_MATCH'"
                      >低匹配</em
                    >
                  </div>
                  <EffectTemplateMixWaveform
                    :bar-count="waveformBarCount(slot)"
                    :duration="slot.duration"
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
                  class="trim-handle trim-left"
                  type="button"
                  title="拖动调整源视频截取起点，槽位时长保持不变"
                  aria-label="调整源视频截取起点"
                  @pointerdown="beginTrim($event, slot.id)"
                />
                <button
                  v-if="selectedClipIds.includes(slot.id) && materialForSlot(slot.id)"
                  class="trim-handle trim-right"
                  type="button"
                  title="拖动调整源视频截取起点，槽位时长保持不变"
                  aria-label="调整源视频截取起点"
                  @pointerdown="beginTrim($event, slot.id)"
                />
                <span v-if="trimDrag?.slotId === slot.id" class="trim-tooltip">
                  源 {{ trimDrag.currentOffset.toFixed(2) }}s —
                  {{ (trimDrag.currentOffset + slot.duration).toFixed(2) }}s
                </span>
              </article>
              <button
                v-for="slot in variant.slots.slice(1)"
                :key="`transition:${slot.id}`"
                class="transition-junction"
                :class="{ 'is-hard-cut': slot.transition === '硬切' }"
                :style="{ left: `${(rangeForSlot(slot.id)?.start ?? 0) * pixelsPerSecond}px` }"
                type="button"
                :title="`转场：${slot.transition}`"
                @pointerdown.stop
                @click.stop="setSelection([slot.id])"
              />
              <div v-if="dragGhostStyle && draggedSlot" class="drag-ghost" :style="dragGhostStyle">
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

          <div
            class="timeline-track voice-track"
            :class="{ 'is-hidden': !trackVisible.VOICE, 'is-locked': trackLocked.VOICE }"
            @pointerdown="onTrackPointerDown($event, 'VOICE')"
          >
            <div
              v-if="variant?.voice"
              class="audio-clip"
              :class="{ 'is-muted': trackMuted.VOICE }"
              :style="{ width: `${timelineDuration * pixelsPerSecond}px` }"
            >
              <Volume2 :size="13" />{{ variant.voice.name }}
            </div>
            <span v-else class="track-empty-copy">未配置口播</span>
          </div>

          <div
            class="timeline-track bgm-track"
            :class="{ 'is-hidden': !trackVisible.BGM, 'is-locked': trackLocked.BGM }"
            @pointerdown="onTrackPointerDown($event, 'BGM')"
          >
            <div
              v-if="variant?.bgm"
              class="audio-clip"
              :class="{ 'is-muted': trackMuted.BGM }"
              :style="{ width: `${timelineDuration * pixelsPerSecond}px` }"
            >
              <Music2 :size="13" />{{ variant.bgm.name }}
            </div>
            <span v-else class="track-empty-copy">未配置 BGM</span>
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
  height: 42px;
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
.timeline-workarea {
  height: var(--timeline-height, 220px);
  display: grid;
  grid-template-columns: var(--track-header-width, 120px) 7px minmax(0, 1fr);
  overflow: hidden;
  background: var(--timeline-bg);
}
.track-headers {
  position: relative;
  z-index: 30;
  overflow: hidden;
  background: #f8fafd;
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
  display: block;
  border-bottom: 1px solid var(--timeline-border);
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
  overflow: auto hidden;
  background: var(--timeline-bg);
  overscroll-behavior: contain;
  scrollbar-color: #b8c5d8 #edf2f8;
  scrollbar-width: thin;
}
.timeline-viewport::-webkit-scrollbar {
  height: 8px;
}
.timeline-viewport::-webkit-scrollbar-track {
  background: #edf2f8;
}
.timeline-viewport::-webkit-scrollbar-thumb {
  border-radius: 999px;
  background: #b8c5d8;
}
.timeline-canvas {
  min-height: 100%;
  position: relative;
}
.time-ruler {
  box-sizing: border-box;
  height: 30px;
  position: relative;
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
  background: #dbeafe;
  cursor: grab;
  transition:
    border-color 100ms ease,
    box-shadow 100ms ease,
    opacity 100ms ease;
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
.clip-filmstrip {
  height: 42px;
  display: flex;
  overflow: hidden;
  border-radius: 2px 2px 0 0;
  background: #dce8f7;
}
.clip-filmstrip > * {
  min-width: 0;
  flex: 1 1 0;
  pointer-events: none;
  filter: saturate(0.94) brightness(0.97);
}
.clip-info {
  height: 42px;
  padding: 4px 6px;
  position: absolute;
  inset: 0 0 auto;
  display: flex;
  align-items: flex-start;
  gap: 5px;
  overflow: hidden;
  background: linear-gradient(180deg, rgba(29, 78, 155, 0.76), transparent 72%);
  color: #fff;
  text-shadow: 0 1px 2px #24456f;
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
  color: #e8f2ff;
  font-size: 9px;
}
.clip-info em {
  margin-left: auto;
  color: #ffd6b8;
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
.trim-handle {
  width: 10px;
  height: 18px;
  position: absolute;
  z-index: 8;
  top: 50%;
  border: 2px solid #fff;
  border-radius: 999px;
  background: #2563eb;
  box-shadow: 0 0 0 1px #1d4ed8;
  cursor: ew-resize;
  transform: translateY(-50%);
}
.trim-left {
  left: -6px;
}
.trim-right {
  right: -6px;
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
  width: 16px;
  height: 16px;
  position: absolute;
  z-index: 7;
  top: 30px;
  padding: 0;
  border: 1px solid #8ba7cc;
  border-radius: 3px;
  background: #eef4fc;
  color: transparent;
  cursor: pointer;
  transform: translateX(-50%) rotate(45deg);
}
.transition-junction:hover {
  border-color: #2563eb;
  background: #dbeafe;
}
.transition-junction.is-hard-cut {
  width: 8px;
  height: 22px;
  border: 0;
  border-radius: 0;
  background: #9aabc2;
  opacity: 0.55;
  transform: translateX(-50%);
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
  height: 28px;
  position: absolute;
  z-index: 2;
  top: 5px;
  overflow: hidden;
  border-radius: 3px;
  display: flex;
  align-items: center;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 10px;
}
.caption-clip {
  padding: 0 7px;
  border: 1px solid #d5a77d;
  background: #fff1e6;
  color: #874d23;
}
.audio-clip {
  padding: 0 8px;
  gap: 5px;
  border: 1px solid #83c4a5;
  background: #e8f7ef;
  color: #27684a;
}
.audio-clip.is-muted {
  opacity: 0.42;
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
