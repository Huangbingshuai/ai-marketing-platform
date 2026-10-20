<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import { Captions, Scissors, Undo2, Redo2, Trash2, Video, AudioLines } from '@lucide/vue';
import { timeLabel, type Clip, type Track } from './avatar-mock';
const props = defineProps<{
  tracks: Record<Track, Clip[]>;
  duration: number;
  playhead: number;
  selection: string[];
  canUndo: boolean;
  canRedo: boolean;
  generated: boolean;
  busy: boolean;
}>();
const emit = defineEmits<{
  select: [track: Track, id: string, additive: boolean];
  selectMany: [ids: string[]];
  seek: [time: number];
  checkpoint: [];
  change: [];
  undo: [];
  redo: [];
  remove: [];
  split: [];
  subtitles: [];
}>();
const zoom = ref(42);
const px = computed(() => zoom.value);
const width = computed(() => Math.max(30, props.duration + 3) * px.value);
const rows = [
  { key: 'video' as const, name: '视频轨', icon: Video },
  { key: 'audio' as const, name: '口播音频轨', icon: AudioLines },
  { key: 'subtitle' as const, name: '字幕轨', icon: Captions },
];
let drag: {
  clip: Clip;
  x: number;
  start: number;
  duration: number;
  mode: string;
  element: HTMLElement;
  moved: boolean;
} | null = null;
function begin(event: PointerEvent, track: Track, clip: Clip, mode = 'move') {
  if (event.button !== 0 || props.busy) return;
  emit('select', track, clip.id, event.ctrlKey || event.metaKey || event.shiftKey);
  const element = event.currentTarget as HTMLElement;
  element.setPointerCapture(event.pointerId);
  drag = {
    clip,
    x: event.clientX,
    start: clip.start,
    duration: clip.duration,
    mode,
    element,
    moved: false,
  };
}
function move(event: PointerEvent) {
  if (!drag) return;
  if (!drag.moved) {
    if (Math.abs(event.clientX - drag.x) < 2) return;
    emit('checkpoint');
    drag.moved = true;
  }
  const delta = (event.clientX - drag.x) / px.value;
  if (drag.mode === 'left') {
    const change = Math.max(-drag.start, Math.min(drag.duration - 0.25, delta));
    drag.clip.start = drag.start + change;
    drag.clip.duration = drag.duration - change;
  } else if (drag.mode === 'right')
    drag.clip.duration = Math.max(
      0.25,
      Math.min(props.duration - drag.start, drag.duration + delta),
    );
  else drag.clip.start = Math.max(0, Math.min(props.duration - drag.duration, drag.start + delta));
  emit('change');
}
function end() {
  drag = null;
}
const marquee = ref<{ start: number; end: number; base: string[] } | null>(null);
function startMarquee(event: PointerEvent, track: Track) {
  if (track !== 'subtitle' || props.busy || event.button !== 0) return;
  const element = event.currentTarget as HTMLElement;
  const x = event.clientX - element.getBoundingClientRect().left;
  element.setPointerCapture(event.pointerId);
  marquee.value = {
    start: x,
    end: x,
    base: event.ctrlKey || event.metaKey ? [...props.selection] : [],
  };
}
function moveMarquee(event: PointerEvent) {
  if (!marquee.value) return;
  marquee.value.end = Math.max(
    0,
    event.clientX - (event.currentTarget as HTMLElement).getBoundingClientRect().left,
  );
  const left = Math.min(marquee.value.start, marquee.value.end) / px.value,
    right = Math.max(marquee.value.start, marquee.value.end) / px.value;
  emit('selectMany', [
    ...new Set([
      ...marquee.value.base,
      ...props.tracks.subtitle
        .filter((c) => c.start < right && c.start + c.duration > left)
        .map((c) => c.id),
    ]),
  ]);
}
function endMarquee() {
  marquee.value = null;
}
function seek(event: MouseEvent) {
  const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
  emit('seek', Math.max(0, Math.min(props.duration, (event.clientX - box.left) / px.value)));
}
onBeforeUnmount(end);
</script>
<template>
  <section class="fas-timeline-panel" aria-label="时间轴编辑">
    <div class="fas-timeline-toolbar">
      <strong class="avatar-timeline-label">时间轴编辑</strong
      ><button title="撤销" aria-label="撤销" :disabled="!canUndo || busy" @click="emit('undo')">
        <Undo2 :size="14" /></button
      ><button title="重做" aria-label="重做" :disabled="!canRedo || busy" @click="emit('redo')">
        <Redo2 :size="14" /></button
      ><button
        title="删除"
        aria-label="删除"
        class="danger"
        :disabled="!selection.length || busy"
        @click="emit('remove')"
      >
        <Trash2 :size="14" /></button
      ><i /><button :disabled="!generated || busy" @click="emit('subtitles')">
        <Captions :size="13" />生成同步字幕</button
      ><button
        title="分割字幕"
        aria-label="分割字幕"
        :disabled="selection.length !== 1 || busy"
        @click="emit('split')"
      >
        <Scissors :size="13" /></button
      ><span class="fas-timeline-hint"
        >拖框多选字幕 · Ctrl/⌘+B 分割 · 拖动片段移动 · 两侧控制点拉伸</span
      ><label class="avatar-zoom"
        >−<input
          v-model.number="zoom"
          type="range"
          min="20"
          max="80"
          aria-label="时间轴缩放"
        />+</label
      >
    </div>
    <div class="fas-timeline-scroll">
      <div
        class="fas-timeline-inner"
        :style="{ width: `${width + 96}px`, '--grid-size': `${5 * px}px` }"
      >
        <div class="fas-ruler">
          <div class="fas-ruler-label">轨道</div>
          <div class="fas-ruler-lane" @click="seek">
            <span
              v-for="n in Math.ceil(width / px / 5)"
              :key="n"
              :style="{ left: `${(n - 1) * 5 * px}px` }"
              >{{ timeLabel((n - 1) * 5).slice(0, 5) }}</span
            >
          </div>
        </div>
        <div v-for="row in rows" :key="row.key" class="fas-track-row">
          <div class="fas-track-label">
            <component :is="row.icon" :size="14" /><span>{{ row.name }}</span
            ><small>{{ tracks[row.key].length }}</small>
          </div>
          <div
            class="fas-track-lane"
            @click.self="seek"
            @pointerdown.self="startMarquee($event, row.key)"
            @pointermove="moveMarquee"
            @pointerup="endMarquee"
            @pointercancel="endMarquee"
          >
            <div
              v-if="row.key === 'subtitle' && marquee"
              class="avatar-marquee"
              :style="{
                left: `${Math.min(marquee.start, marquee.end)}px`,
                width: `${Math.abs(marquee.end - marquee.start)}px`,
              }"
            />
            <div
              v-for="clip in tracks[row.key]"
              :key="clip.id"
              role="button"
              tabindex="0"
              :aria-label="`${row.name} ${clip.title}`"
              :aria-pressed="selection.includes(clip.id)"
              class="fas-clip"
              :class="[row.key, { selected: selection.includes(clip.id) }]"
              :style="{ left: `${clip.start * px}px`, width: `${clip.duration * px}px` }"
              @keydown.enter="emit('select', row.key, clip.id, false)"
              @pointerdown.stop="begin($event, row.key, clip)"
              @pointermove="move"
              @pointerup="end"
              @pointercancel="end"
            >
              <b>{{ clip.title }}</b
              ><span>{{ clip.text }}</span
              ><em>{{ clip.duration.toFixed(1) }}s</em
              ><i
                class="avatar-trim left"
                @pointerdown.stop="begin($event, row.key, clip, 'left')"
                @pointermove="move"
                @pointerup="end"
              /><i
                class="avatar-trim right"
                @pointerdown.stop="begin($event, row.key, clip, 'right')"
                @pointermove="move"
                @pointerup="end"
              />
            </div>
          </div>
        </div>
        <div class="avatar-playhead" :style="{ left: `${96 + playhead * px}px` }" />
        <div v-if="!generated" class="fas-timeline-empty">
          <b>生成数字人口播视频后，将自动建立视频轨与口播音频轨</b
          ><span>同步字幕需要在视频生成完成后单独生成。</span>
        </div>
      </div>
    </div>
  </section>
</template>
