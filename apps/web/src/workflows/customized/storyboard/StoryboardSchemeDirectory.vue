<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue';
import { Check, ChevronDown, ChevronLeft, ChevronRight, Clock3 } from '@lucide/vue';
import type { CustomizedStoryboardScript } from '@ai-marketing/contracts';
import { scriptDuration } from './storyboard-state';

const props = defineProps<{
  scripts: CustomizedStoryboardScript[];
  activeId: string | null;
}>();
const emit = defineEmits<{ select: [id: string] }>();
const directoryId = useId();
const track = ref<HTMLElement | null>(null);
const expanded = ref(false);
const canBack = ref(false);
const canForward = ref(false);
const focusedId = ref(props.activeId ?? props.scripts[0]?.id ?? '');
const activeIndex = computed(() => props.scripts.findIndex((s) => s.id === props.activeId));
let observer: ResizeObserver | undefined;
let disposed = false;

function measure() {
  const el = track.value;
  canBack.value = !!el && el.scrollLeft > 2;
  canForward.value = !!el && el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
}
function reveal(id: string | null) {
  const el = track.value;
  const index = props.scripts.findIndex((s) => s.id === id);
  const card = index < 0 ? null : (el?.children[index] as HTMLElement | undefined);
  if (!el || !card || expanded.value) return;
  const stride = card.getBoundingClientRect().width + 12;
  const columns = Math.max(1, Math.floor((el.clientWidth + 12) / stride));
  el.scrollLeft = Math.floor(index / columns) * columns * stride;
  measure();
}
function browse(direction: number) {
  const el = track.value;
  if (!el) return;
  const card = el.children[0] as HTMLElement | undefined;
  if (!card) return;
  const stride = card.getBoundingClientRect().width + 12;
  const columns = Math.max(1, Math.floor((el.clientWidth + 12) / stride));
  const page = el.scrollLeft / (columns * stride);
  el.scrollLeft = (direction > 0 ? Math.floor(page + 1) : Math.ceil(page - 1)) * columns * stride;
  measure();
}
async function toggleExpanded() {
  expanded.value = !expanded.value;
  await nextTick();
  if (disposed) return;
  reveal(props.activeId);
  measure();
}
function select(id: string) {
  if (id !== props.activeId) emit('select', id);
}
function navigate(event: KeyboardEvent, index: number) {
  let destination: number;
  switch (event.key) {
    case 'ArrowRight':
    case 'ArrowDown':
      destination = Math.min(index + 1, props.scripts.length - 1);
      break;
    case 'ArrowLeft':
    case 'ArrowUp':
      destination = Math.max(index - 1, 0);
      break;
    case 'Home':
      destination = 0;
      break;
    case 'End':
      destination = props.scripts.length - 1;
      break;
    default:
      return;
  }
  event.preventDefault();
  const script = props.scripts[destination];
  if (!script) return;
  focusedId.value = script.id;
  (track.value?.children[destination] as HTMLElement | undefined)?.focus({ preventScroll: true });
  if (expanded.value)
    (track.value?.children[destination] as HTMLElement | undefined)?.scrollIntoView({
      block: 'nearest',
    });
  else reveal(script.id);
}
watch(
  () => [props.activeId, ...props.scripts.map((s) => s.id)],
  async () => {
    if (!props.scripts.some((s) => s.id === focusedId.value))
      focusedId.value = props.activeId ?? props.scripts[0]?.id ?? '';
    await nextTick();
    if (disposed) return;
    reveal(props.activeId);
    measure();
  },
);
onMounted(() => {
  if (track.value) {
    observer = new ResizeObserver(() => {
      reveal(props.activeId);
      measure();
    });
    observer.observe(track.value);
  }
  reveal(props.activeId);
  measure();
});
onBeforeUnmount(() => {
  disposed = true;
  observer?.disconnect();
});
</script>

<template>
  <section v-if="scripts.length" class="scheme-directory" aria-label="脚本方案目录">
    <div class="directory-heading">
      <span class="directory-position">
        <span class="position-line" aria-hidden="true" />
        {{ activeIndex >= 0 ? `当前查看 ${String(activeIndex + 1).padStart(2, '0')}` : '浏览方案' }}
        <span class="position-total">/ {{ String(scripts.length).padStart(2, '0') }}</span>
      </span>
      <div v-if="scripts.length > 1" class="directory-controls">
        <button
          type="button"
          class="directory-expand"
          :aria-expanded="expanded"
          :aria-controls="directoryId"
          @click="toggleExpanded"
        >
          {{ expanded ? '收起目录' : '展开全部' }}
          <ChevronDown :size="14" :class="{ rotated: expanded }" />
        </button>
        <div v-if="!expanded" class="directory-arrows">
          <button type="button" aria-label="上一组方案" :disabled="!canBack" @click="browse(-1)">
            <ChevronLeft :size="16" />
          </button>
          <button type="button" aria-label="下一组方案" :disabled="!canForward" @click="browse(1)">
            <ChevronRight :size="16" />
          </button>
        </div>
      </div>
    </div>
    <div
      :id="directoryId"
      ref="track"
      class="scheme-track"
      :class="{ expanded }"
      role="group"
      aria-label="选择脚本方案"
      @scroll.passive="measure"
    >
      <button
        v-for="(script, index) in scripts"
        :key="script.id"
        type="button"
        class="scheme-card"
        :class="{ selected: script.id === activeId }"
        :aria-pressed="script.id === activeId"
        :aria-label="`方案 ${String(index + 1).padStart(2, '0')}：${script.name || '未命名脚本'}`"
        :aria-describedby="`${directoryId}-${index}-meta${scripts.length > 1 ? ` ${directoryId}-${index}-summary` : ''}`"
        :tabindex="script.id === focusedId ? 0 : -1"
        @focus="focusedId = script.id"
        @keydown="navigate($event, index)"
        @click="select(script.id)"
      >
        <span class="scheme-card-top">
          <span class="scheme-number"
            >方案 <b>{{ String(index + 1).padStart(2, '0') }}</b></span
          >
          <span v-if="script.id === activeId" class="scheme-current"
            ><Check :size="12" />当前查看</span
          >
          <span v-else class="scheme-indicator" aria-hidden="true" />
        </span>
        <span class="scheme-name" :title="script.name">{{ script.name || '未命名脚本' }}</span>
        <span
          v-if="scripts.length > 1"
          :id="`${directoryId}-${index}-summary`"
          class="scheme-synopsis"
          >{{ script.synopsis.trim() || '尚未填写故事概述' }}</span
        >
        <span :id="`${directoryId}-${index}-meta`" class="scheme-meta"
          ><Clock3 :size="12" />{{ scriptDuration(script) }} 秒<span class="scheme-read"
            >{{ script.id === activeId ? '正在阅读' : '阅读脚本' }}<ChevronRight :size="13" /></span
        ></span>
      </button>
    </div>
  </section>
</template>

<style scoped>
.scheme-directory {
  min-width: 0;
  margin-bottom: 24px;
}
.directory-heading,
.directory-position,
.directory-controls,
.directory-arrows,
.scheme-card-top,
.scheme-current,
.scheme-meta,
.scheme-read {
  display: flex;
  align-items: center;
}
.directory-heading {
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}
.directory-position {
  gap: 8px;
  color: #526986;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.position-line {
  width: 14px;
  height: 2px;
  background: #6483b5;
}
.position-total {
  color: #8b99ad;
}
.directory-controls {
  gap: 14px;
}
.scheme-directory button {
  font-family: inherit;
  cursor: pointer;
}
.directory-controls button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  height: 28px;
  min-height: 28px;
  padding: 0 6px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: #607795;
  font-size: 11px;
  font-weight: 500;
}
.directory-controls button:hover:not(:disabled) {
  background: #edf3fc;
  color: #2563eb;
}
.directory-controls button:disabled {
  opacity: 0.35;
  cursor: default;
}
.directory-arrows {
  gap: 4px;
  padding-left: 12px;
  border-left: 1px solid #e2e8f1;
}
.directory-arrows button {
  width: 28px;
  border: 1px solid #dfe6f1;
  background: #fff;
}
.rotated {
  transform: rotate(180deg);
}
.scheme-track {
  --scheme-columns: 4;
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: calc((100% - (var(--scheme-columns) - 1) * 12px) / var(--scheme-columns));
  gap: 12px;
  overflow-x: auto;
  overscroll-behavior-x: contain;
  padding: 3px 3px 10px;
  margin: -3px -3px 0;
  scrollbar-width: thin;
  scrollbar-color: #ced9e9 transparent;
}
.scheme-track.expanded {
  grid-auto-flow: row;
  grid-auto-columns: auto;
  grid-template-columns: repeat(var(--scheme-columns), minmax(0, 1fr));
  overflow: visible;
}
.scheme-track .scheme-card {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  justify-content: flex-start;
  min-width: 0;
  padding: 16px 18px 13px;
  border: 1px solid #dfe6f0;
  border-radius: 12px;
  background: #fff;
  color: #2d405d;
  text-align: left;
  white-space: normal;
  transition:
    border-color 0.15s,
    background-color 0.15s;
}
.scheme-track .scheme-card:hover {
  border-color: #9db6da;
  background: #fafcff;
}
.scheme-track .scheme-card.selected {
  border-color: #87a8df;
  background: #f5f8fe;
  box-shadow: inset 0 2px #4776c1;
}
.scheme-directory button:focus-visible {
  outline: 2px solid #2563eb;
  outline-offset: 2px;
}
.scheme-card-top {
  justify-content: space-between;
  gap: 8px;
  min-height: 18px;
  margin-bottom: 12px;
}
.scheme-number {
  color: #8695aa;
  font-size: 10px;
  font-weight: 500;
}
.scheme-number b {
  margin-left: 3px;
  color: #627a9c;
  font-size: 13px;
  font-weight: 650;
  font-variant-numeric: tabular-nums;
}
.scheme-current {
  gap: 4px;
  color: #3e6ab3;
  font-size: 10px;
  font-weight: 500;
}
.scheme-indicator {
  width: 12px;
  height: 12px;
  border: 1px solid #dbe3ef;
  border-radius: 50%;
}
.scheme-name {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  min-height: 42px;
  font-size: 14px;
  line-height: 1.5;
  font-weight: 650;
  overflow-wrap: anywhere;
}
.scheme-synopsis {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  min-height: 36px;
  margin: 9px 0 0;
  color: #7d8ca2;
  font-size: 11px;
  font-weight: 400;
  line-height: 1.65;
  overflow-wrap: anywhere;
}
.scheme-meta {
  gap: 5px;
  margin-top: 14px;
  padding-top: 10px;
  border-top: 1px solid #e8edf5;
  color: #8a99ad;
  font-size: 10px;
  font-weight: 400;
}
.scheme-read {
  gap: 3px;
  margin-left: auto;
  color: #6982a5;
}
.selected .scheme-read {
  color: #3e6ab3;
}
@media (max-width: 1599px) {
  .scheme-track {
    --scheme-columns: 3;
  }
}
@media (max-width: 1050px) {
  .scheme-track {
    --scheme-columns: 2;
  }
}
@media (max-width: 600px) {
  .scheme-track {
    --scheme-columns: 1;
    grid-auto-columns: 88%;
  }
  .scheme-track .scheme-card {
    padding: 15px 16px 12px;
  }
  .directory-controls {
    gap: 6px;
  }
  .directory-arrows {
    padding-left: 6px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .scheme-track .scheme-card {
    transition: none;
  }
}
</style>
