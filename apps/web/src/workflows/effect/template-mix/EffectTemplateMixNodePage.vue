<script setup lang="ts">
import type {
  EffectImportProduct,
  EffectTemplateMixAiRun,
  EffectTemplateMixClassificationPool,
  EffectTemplateMixDraft,
  EffectTemplateMixMaterial,
  EffectTemplateMixRole,
  EffectTemplateMixSlot,
  EffectTemplateMixTemplateEntry,
  EffectTemplateMixTransition,
  EffectTemplateMixVariant,
  PackagingItem,
} from '@ai-marketing/contracts';
import { WorkflowNodeDraftBar, WorkflowNodeFooter, WorkflowRunProgress } from '@ai-marketing/ui';
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
  Maximize2,
  Minimize2,
  Music2,
  Pause,
  Play,
  Plus,
  Search,
  Sparkles,
  WandSparkles,
  Workflow,
  X,
  ZoomIn,
  ZoomOut,
} from '@lucide/vue';
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';

import {
  applyEffectTemplateMixVariant,
  createEffectTemplateMixAiRun,
  createEmptyEffectTemplateMixVariant,
  getEffectTemplateMixAiRun,
  loadEffectTemplateMixWorkspace,
  saveEffectTemplateMixDraft,
  serializeEffectTemplateMixDraft,
  validateEffectTemplateMix,
} from './api/effect-template-mix.api';
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
import { effectTemplateMixTransitionPresentation } from './effect-template-mix-transition';
import EffectTemplateMixThumbnail from './EffectTemplateMixThumbnail.vue';
import EffectTemplateMixTimeline from './EffectTemplateMixTimeline.vue';
import EffectTemplateMixPackaging from './EffectTemplateMixPackaging.vue';
import EffectSegmentRenderSourcePrompt from '../segment-render/components/EffectSegmentRenderSourcePrompt.vue';

const props = defineProps<{
  products: EffectImportProduct[];
  projectId: string;
  workflowRunId: string;
}>();
const emit = defineEmits<{ back: []; next: [] }>();
type Notice = { kind: 'error' | 'success' | 'warning'; text: string };
type TemplateUi = { selectedSlotId: string; selectedVariantId: string };

const pageState = ref<'ERROR' | 'LOADING' | 'READY'>('LOADING');
const errorMessage = ref('');
const catalog = ref<EffectTemplateMixTemplateEntry[]>([]);
const activeTemplateId = ref('');
const draftRevision = ref<number | null>(null);
const packagingPanel = ref<InstanceType<typeof EffectTemplateMixPackaging> | null>(null);
const selectedPackaging = ref<PackagingItem | null>(null);
const packagingPreviewEnabled = ref(false);
const committedVersions = reactive<Record<string, number>>({});
const uiByTemplate = reactive<Record<string, TemplateUi>>({});
const view = ref<'CONFIG' | 'EDITOR'>('CONFIG');
const saveState = ref<'dirty' | 'saved' | 'saving'>('saved');
const validating = ref(false);
const mutating = ref(false);
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
const resourceTab = ref<'AUDIO' | 'MATERIAL' | 'TEXT' | 'TRANSITION'>('MATERIAL');
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
const playhead = ref(0);
const playerPanel = ref<HTMLElement | null>(null);
const playerMenu = ref<'DISPLAY' | null>(null);
const previewZoom = ref(100);
const playerFullscreen = ref(false);
const materialAudioPresence = reactive<Record<string, boolean | undefined>>({});
const createOpen = ref(false);
const overwriteOpen = ref(false);
const workflowDialogOpen = ref(false);
const selectedWorkflowStage = ref<EffectTemplateMixAiRun['stage'] | null>(null);
const notice = ref<Notice | null>(null);
const newTemplateName = ref('新品跑量模板');
const displayedTimelineSlotId = ref('');
const playerUnavailableSlotId = ref('');
const transitionFrame = ref('');
const timelinePlayers = new Map<string, HTMLVideoElement>();
const primedTimelinePlayers = new WeakSet<HTMLVideoElement>();
const positionedTimelinePlayers = new WeakSet<HTMLVideoElement>();
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
type TimelineEditSnapshot = {
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
let playbackAnchorMilliseconds = 0;
let playbackAnchorSeconds = 0;
let activePlaybackSlotId = '';
let activeTransitionSignature = '';
let pendingSeekSyncFrame: number | undefined;
let seekSyncRequestId = 0;
let materialGridResizeObserver: ResizeObserver | null = null;
let materialGridResizeFrame: number | undefined;
const pollTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pollControllers = new Map<string, AbortController>();

const activeEntry = computed(
  () => catalog.value.find(({ id }) => id === activeTemplateId.value) ?? null,
);
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
const canUndoTimeline = computed(() => timelineUndoStack.value.length > 0);
const canRedoTimeline = computed(() => timelineRedoStack.value.length > 0);
const clearTimelineHistory = (): void => {
  timelineUndoStack.value = [];
  timelineRedoStack.value = [];
};
const captureTimelineSnapshot = (): TimelineEditSnapshot | null =>
  selectedVariant.value
    ? {
        selectedSlotId: activeUi.value?.selectedSlotId ?? '',
        variant: cloneMix(selectedVariant.value),
      }
    : null;
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
  if (activeUi.value) activeUi.value.selectedSlotId = snapshot.selectedSlotId;
  playhead.value = Math.min(playhead.value, currentDuration.value);
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
    if (item.category !== '热门') return false;
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
const currentDuration = computed(() => {
  const variant = selectedVariant.value;
  if (!variant) return templateTiming.value.duration;
  return variantDuration(variant);
});
const coverMaterial = (variant: EffectTemplateMixVariant): EffectTemplateMixMaterial | null =>
  variant.slots.map((slot) => materialForSlot(slot.id, variant)).find(Boolean) ?? null;
const selectedMaterial = computed(() =>
  selectedSlot.value ? materialForSlot(selectedSlot.value.id) : null,
);
const slotMoveSourceLabel = computed(() => {
  const materialId = slotMoveMaterial.value?.id;
  const variant = selectedVariant.value;
  return (
    variant?.slots.find((slot) => variant.bindings[slot.id] === materialId)?.label || '未分配'
  );
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
const activeTransitionPreview = computed<ActiveTransitionPreview | null>(() => {
  const variant = selectedVariant.value;
  if (!variant) return null;
  const ranges = currentTiming.value.slots;
  const safeTime = Math.max(0, Math.min(playhead.value, currentDuration.value));
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
});
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
const previewHasAudibleTrack = computed(() =>
  Boolean(
    previewIsPlaying.value && stageMaterial.value && materialAudioPresence[stageMaterial.value.id],
  ),
);
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
const selectedBindingMetadata = computed(() =>
  selectedSlot.value ? selectedVariant.value?.bindingMetadata?.[selectedSlot.value.id] : undefined,
);
const pendingCount = computed(
  () => workspace.value?.variants.filter(({ status }) => status === 'PENDING').length ?? 0,
);
const variantDisplayName = (_variant: EffectTemplateMixVariant, index: number): string =>
  `成片 ${String(index + 1).padStart(2, '0')}`;
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
  CLASSIFYING: '六槽位定义、素材编号，以及每条素材对应的原始 Prompt 正文。',
  MATCHING: '上一阶段的六槽位评分、模板槽位时长与跨工程使用记录。',
  SAMPLING: '服务端选出的六条不同视频素材及其精确素材版本。',
  TRIMMING: '带时间戳的关键帧、原始 Prompt、槽位语义与模板目标时长。',
  COMPLETED: '六条素材绑定、AI 截取起点、模板顺序与转场配置。',
};
const aiStageOutputs: Record<EffectTemplateMixAiRun['stage'], string> = {
  CLASSIFYING: '每条素材针对六个槽位的匹配分和简短分类理由。',
  MATCHING: '六个槽位各自唯一的素材绑定，以及低匹配补位标记。',
  SAMPLING: '每条选中视频最多 12 张带真实时间戳的关键帧。',
  TRIMMING: '每个槽位的截取起点与理由；结束时间由模板时长自动计算。',
  COMPLETED: '自动铺好六个片段、可继续人工精修的时间轴工程草稿。',
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
): 'done' | 'failed' | 'pending' | 'running' => {
  const run = workflowRunForDisplay.value;
  if (!run) return 'pending';
  const stageIndex = aiStageOrder.indexOf(stage);
  const currentIndex = aiStageOrder.indexOf(run.stage);
  if (run.status === 'FAILED' && stageIndex === currentIndex) return 'failed';
  if ((run.status === 'QUEUED' || run.status === 'RUNNING') && stageIndex === currentIndex)
    return 'running';
  if (run.status === 'COMPLETED' || stageIndex < currentIndex) return 'done';
  return 'pending';
};
const workflowStageStatusLabel = (stage: EffectTemplateMixAiRun['stage']): string =>
  ({
    done: '已完成',
    failed: '失败',
    pending: '等待中',
    running: '进行中',
  })[workflowStageState(stage)];
const workflowStageTone = (stage: EffectTemplateMixAiRun['stage']): string =>
  ({ done: 'success', failed: 'danger', pending: 'pending', running: 'running' })[
    workflowStageState(stage)
  ];
const workflowNotice = computed(() => {
  const run = workflowRunForDisplay.value;
  if (!run)
    return {
      tone: 'pending',
      title: '当前成片工程尚未执行智能填充',
      detail: '下方展示当前流程。点击“AI 智能填充”后，节点会显示本次真实执行状态。',
    };
  if (run.status === 'FAILED')
    return {
      tone: 'danger',
      title: '本次智能填充执行失败',
      detail: run.errorMessage || '请选择失败节点查看阶段说明，修正素材条件后可重新执行。',
    };
  if (run.status === 'QUEUED' || run.status === 'RUNNING')
    return {
      tone: 'running',
      title: `${aiStageLabels[run.stage]} · ${run.progress}%`,
      detail: '任务在后台继续执行，关闭面板或刷新页面都不会丢失真实进度。',
    };
  return {
    tone: 'success',
    title: '本次智能填充已生成时间轴工程',
    detail: '六个片段已进入视频轨，可关闭面板继续人工精修和完成校验。',
  };
});

const showNotice = (text: string, kind: Notice['kind'] = 'success'): void => {
  notice.value = { text, kind };
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => (notice.value = null), 3600);
};
const openCreate = async (event: MouseEvent): Promise<void> => {
  dialogTrigger.value = event.currentTarget as HTMLElement;
  createOpen.value = true;
  await nextTick();
  createNameInput.value?.focus();
};
const closeCreate = async (): Promise<void> => {
  createOpen.value = false;
  await nextTick();
  dialogTrigger.value?.focus();
};
const openOverwrite = (event: MouseEvent): void => {
  dialogTrigger.value = event.currentTarget as HTMLElement;
  overwriteOpen.value = true;
};
const closeOverwrite = async (): Promise<void> => {
  overwriteOpen.value = false;
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
  catalog.value = data.draft.templates.map((entry) => hydrate(entry, data.materials));
  draftRevision.value = data.draftRevision;
  activeTemplateId.value =
    catalog.value.find(({ id }) => id === data.draft.activeTemplateId)?.id ??
    catalog.value[0]?.id ??
    '';
  Object.keys(committedVersions).forEach((key) => delete committedVersions[key]);
  data.commits
    .filter(({ stale }) => !stale)
    .forEach(({ templateId, editVersion }) => (committedVersions[templateId] = editVersion));
  initializeUi();
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
    for (const run of running ?? []) void pollAiRun(run.id);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return;
    errorMessage.value = error instanceof Error ? error.message : '混剪工作区加载失败';
    pageState.value = 'ERROR';
  }
};
const persist = async (keepalive = false): Promise<boolean> => {
  if (pageState.value !== 'READY') return false;
  clearTimeout(saveTimer);
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
    saveState.value = 'dirty';
    showNotice(error instanceof Error ? error.message : '草稿保存失败', 'error');
    return false;
  }
};
const scheduleSave = (): void => {
  saveState.value = 'dirty';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => (pendingSave = persist()), 450);
};
const bump = (): void => {
  if (workspace.value) workspace.value.editVersion += 1;
  scheduleSave();
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
  const entry = createEffectTemplateMixEntry(newTemplateName.value.trim() || '未命名混剪模板');
  entry.workspace.materials =
    workspace.value?.materials ?? catalog.value[0]?.workspace.materials ?? [];
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
const setTimelinePlayer = (slotId: string, element: unknown): void => {
  if (element instanceof HTMLVideoElement) {
    timelinePlayers.set(slotId, element);
  } else timelinePlayers.delete(slotId);
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
  if (player.currentTime >= 0.35 && player.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA)
    materialAudioPresence[material.id] = false;
};
const activeTimelinePlayer = (): HTMLVideoElement | null =>
  previewSlot.value ? (timelinePlayers.get(previewSlot.value.id) ?? null) : null;
const timelinePlaybackStart = (slotId: string): number => {
  const transition = activeTransitionPreview.value;
  if (transition?.incomingSlot.id === slotId) return transition.start;
  return currentTiming.value.slots.find(({ id }) => id === slotId)?.start ?? 0;
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
const leaveEditor = (): void => {
  playing.value = false;
  pauseTimelinePlayers();
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
  if (activeUi.value) activeUi.value.selectedSlotId = targetSlot.id;
  bump();
  showNotice(
    sourceSlot && targetMaterial
      ? `已将${material.name}与${targetSlot.label}素材交换槽位`
      : `已将${material.name}移动到${targetSlot.label}`,
  );
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
  if (activeUi.value) activeUi.value.selectedSlotId = slot.id;
  bump();
};
const removeMaterialFromSlot = (slotId: string): void => {
  const variant = selectedVariant.value;
  const slot = variant?.slots.find(({ id }) => id === slotId);
  if (!variant || !slot || !variant.bindings[slot.id]) return;
  rememberTimelineEdit();
  delete variant.bindings[slot.id];
  delete variant.bindingRevisions[slot.id];
  delete variant.offsets[slot.id];
  if (variant.bindingMetadata) delete variant.bindingMetadata[slot.id];
  variant.manualSlotIds = variant.manualSlotIds.filter((id) => id !== slot.id);
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
  if (!material) {
    showNotice('拖入的素材已失效，请刷新素材库', 'warning');
    return;
  }
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
const changeTemplate = (): void => {
  if (!workspace.value) return;
  for (const [index, slot] of workspace.value.template.slots.entries()) {
    slot.duration = Number.isFinite(Number(slot.duration))
      ? Math.min(120, Math.max(0.1, Math.round(Number(slot.duration) * 10) / 10))
      : 0.1;
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
  bump();
};
const overlapsTimelineClip = (
  start: number,
  duration: number,
  otherStart: number,
  otherEnd: number,
): boolean =>
  start < otherEnd - 1 / TIMELINE_FPS && start + duration > otherStart + 1 / TIMELINE_FPS;
const resolveTimelinePlacement = (
  variant: EffectTemplateMixVariant,
  slotId: string,
  requestedStart: number,
  requestedLane: number,
  excludedSlotIds: ReadonlySet<string> = new Set(),
): { start: number; lane: number } => {
  const slot = variant.slots.find(({ id }) => id === slotId);
  if (!slot) return { start: requestedStart, lane: requestedLane };
  const ranges = currentTiming.value.slots
    .filter(({ id }) => id !== slotId && !excludedSlotIds.has(id))
    .map((range) => ({
      ...range,
      lane: variant.videoLanes?.[range.id] ?? 0,
    }));
  const requestedDuration = Math.max(0.1, slot.duration);
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

  // If no upper lane is available, append after the blocking clips instead of
  // covering them. This also walks through adjacent clips until a free gap is found.
  let appendedStart = requestedStart;
  const laneRanges = ranges
    .filter(({ lane }) => lane === requestedLane)
    .sort((left, right) => left.start - right.start);
  let blocker = laneRanges.find((range) =>
    overlapsTimelineClip(appendedStart, requestedDuration, range.start, range.end),
  );
  while (blocker) {
    appendedStart = blocker.end;
    blocker = laneRanges.find((range) =>
      overlapsTimelineClip(appendedStart, requestedDuration, range.start, range.end),
    );
  }
  return { start: appendedStart, lane: requestedLane };
};
type TimelineClipMove = { slotId: string; start: number; lane: number };

const moveTimelineClips = (moves: TimelineClipMove[]): void => {
  const variant = selectedVariant.value;
  if (!variant || !moves.length) return;
  const excludedSlotIds = new Set(moves.map(({ slotId }) => slotId));
  const resolvedMoves = moves.flatMap(({ slotId, start, lane }) => {
    const slot = variant.slots.find(({ id }) => id === slotId);
    if (!slot) return [];
    const nextStart = Math.max(0, Math.round(start * 30) / 30);
    const nextLane = Math.max(0, Math.min(2, Math.round(lane)));
    const resolved = resolveTimelinePlacement(
      variant,
      slotId,
      nextStart,
      nextLane,
      excludedSlotIds,
    );
    const currentStart =
      variant.timelineStarts?.[slotId] ??
      effectTemplateMixTiming(variant.slots).slots.find(({ id }) => id === slotId)?.start ??
      0;
    const currentLane = variant.videoLanes?.[slotId] ?? 0;
    const resolvedStart = Math.max(0, Math.round(resolved.start * 30) / 30);
    const resolvedLane = Math.max(0, Math.min(2, Math.round(resolved.lane)));
    return resolvedStart === currentStart && resolvedLane === currentLane
      ? []
      : [{ slotId, start: resolvedStart, lane: resolvedLane }];
  });
  if (!resolvedMoves.length) return;
  rememberTimelineEdit();
  variant.timelineStarts ??= {};
  variant.videoLanes ??= {};
  for (const move of resolvedMoves) {
    variant.timelineStarts[move.slotId] = move.start;
    variant.videoLanes[move.slotId] = move.lane;
  }
  bump();
};
const moveTimelineClip = (slotId: string, start: number, lane: number): void =>
  moveTimelineClips([{ slotId, start, lane }]);
const changeProjectDuration = (raw: string): void => {
  if (!selectedSlot.value || !selectedVariant.value) return;
  const duration = Math.round(Number(raw) * 10) / 10;
  const material = materialForSlot(selectedSlot.value.id);
  if (!Number.isFinite(duration) || duration < 0.1 || duration > 120) return;
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
  bump();
};
const deleteSelectedTimelineItem = (): void => {
  const variant = selectedVariant.value;
  if (!variant) return;
  const transitionSlotId = activeTransitionSlotId.value;
  const transitionSlot = variant.slots.find(({ id }) => id === transitionSlotId);
  console.log('[del] transitionSlotId=', transitionSlotId, 'selectedSlotId=', activeUi.value?.selectedSlotId, 'transition=', transitionSlot?.transition);
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
const selectResourceTab = (tab: 'AUDIO' | 'MATERIAL' | 'TEXT' | 'TRANSITION'): void => {
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
  void packagingPanel.value?.open(target);
};
const preparePackaging = async (): Promise<number | null> =>
  (await flushPendingEdits()) ? draftRevision.value : null;
const startAiFill = async (target: EffectTemplateMixVariant | null): Promise<void> => {
  if (!workspace.value || mutating.value || activeAiRun.value) return;
  if (!(await flushPendingEdits()) || draftRevision.value === null) return;
  const templateId = activeTemplateId.value;
  const variantId = target?.id;
  mutating.value = true;
  try {
    const result = await createEffectTemplateMixAiRun(
      props.projectId,
      props.workflowRunId,
      draftRevision.value,
      templateId,
      variantId,
    );
    aiRuns.value = [result.data, ...aiRuns.value.filter(({ id }) => id !== result.data.id)];
    showNotice(
      target?.manualSlotIds.length
        ? '智能填充已开始，人工槽位会保留，其余槽位重新计算'
        : target
          ? '重新智能填充已开始，正在按原始 Prompt 归槽并裁剪'
          : '智能填充已开始；完成前不会创建成片工程',
    );
    void pollAiRun(result.data.id);
  } catch (error) {
    showNotice(error instanceof Error ? error.message : '重新填充失败', 'error');
  } finally {
    mutating.value = false;
  }
};
const refill = (): void => void startAiFill(selectedVariant.value);
const retryFailedAiRun = (): void => {
  const run = failedAiRun.value;
  if (run?.targetVariantId && activeUi.value) {
    activeUi.value.selectedVariantId = run.targetVariantId;
    void startAiFill(selectedVariant.value);
    return;
  }
  void startAiFill(null);
};
const overwrite = async (sync: boolean): Promise<void> => {
  if (!workspace.value || !selectedVariant.value || mutating.value) return;
  if (!(await flushPendingEdits()) || draftRevision.value === null) return;
  const templateId = activeTemplateId.value;
  const variantId = selectedVariant.value.id;
  mutating.value = true;
  try {
    const result = await applyEffectTemplateMixVariant(
      props.projectId,
      props.workflowRunId,
      draftRevision.value,
      templateId,
      variantId,
      sync,
    );
    installWorkspaceData(result.data);
    if (uiByTemplate[templateId]) uiByTemplate[templateId].selectedVariantId = variantId;
    const conflicts =
      catalog.value
        .find(({ id }) => id === templateId)
        ?.workspace.variants.reduce((sum, variant) => sum + variant.conflictSlotIds.length, 0) ?? 0;
    overwriteOpen.value = false;
    saveState.value = 'saved';
    showNotice(
      conflicts
        ? '已同步，但部分工程仍有素材缺口'
        : sync
          ? '已更新模板并同步其他工程'
          : '已更新模板，其他工程等待同步',
      conflicts ? 'warning' : 'success',
    );
  } catch (error) {
    showNotice(error instanceof Error ? error.message : '更新模板失败', 'error');
  } finally {
    mutating.value = false;
  }
};
const addCaption = (): void => {
  if (!selectedVariant.value || !selectedSlot.value) return;
  const range = currentTiming.value.slots.find(({ id }) => id === selectedSlot.value?.id);
  if (!range) return;
  selectedVariant.value.captions.push({
    id: crypto.randomUUID(),
    text: '输入字幕',
    start: range.start,
    end: range.end,
  });
  bump();
};
const removeCaption = (id: string): void => {
  if (!selectedVariant.value) return;
  selectedVariant.value.captions = selectedVariant.value.captions.filter((item) => item.id !== id);
  bump();
};
const quantizeTimelineTime = (raw: number): number =>
  Math.round(Math.max(0, Math.min(currentDuration.value, raw)) * TIMELINE_FPS) / TIMELINE_FPS;
const stopPlaybackClock = (): void => {
  if (playbackAnimationFrame !== undefined) cancelAnimationFrame(playbackAnimationFrame);
  playbackAnimationFrame = undefined;
  activePlaybackSlotId = '';
  activeTransitionSignature = '';
};
const resetPlaybackClock = (): void => {
  playbackAnchorMilliseconds = performance.now();
  playbackAnchorSeconds = playhead.value;
};
const syncPlayingVideoFrame = (): void => {
  const transition = activeTransitionPreview.value;
  if (transition) {
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
  const visibleProjectTime = Math.min(
    playhead.value,
    Math.max(range.start, range.end - 1 / TIMELINE_FPS),
  );
  const sourceTime =
    (selectedVariant.value.offsets[slot.id] ?? 0) + visibleProjectTime - range.start;
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
  if (next >= currentDuration.value) {
    playhead.value = currentDuration.value;
    playing.value = false;
    pauseTimelinePlayers();
    stopPlaybackClock();
    return;
  }
  playhead.value = next;
  syncPlayingVideoFrame();
  playbackAnimationFrame = requestAnimationFrame(updatePlaybackFrame);
};
const startPlaybackClock = (): void => {
  stopPlaybackClock();
  resetPlaybackClock();
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
    const transition = activeTransitionPreview.value;
    if (transition) {
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
    const video = activeTimelinePlayer();
    // The slot may have just mounted after a variant switch. Ask the caller to
    // retry after Vue flushes once, but never keep an old seek request alive.
    if (!video) return false;
    pauseTimelinePlayers(slot.id);
    const visibleProjectTime = Math.min(
      playhead.value,
      Math.max(range.start, range.end - 1 / TIMELINE_FPS),
    );
    const sourceTime =
      (selectedVariant.value.offsets[slot.id] ?? 0) + visibleProjectTime - range.start;
    if (
      Number.isFinite(sourceTime) &&
      Math.abs(video.currentTime - sourceTime) > 1 / TIMELINE_FPS
    ) {
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
  playhead.value = quantizeTimelineTime(raw);
  if (playing.value) resetPlaybackClock();
  scheduleSeekSync();
};
const seekPreview = (raw: number): void => {
  const value = Math.max(0, Math.min(previewDuration.value, raw));
  if (auditionMaterial.value && auditionPlayer.value) {
    auditionPlayer.value.currentTime = value;
    auditionTime.value = value;
    return;
  }
  seek(value);
};
const togglePlay = async (): Promise<void> => {
  if (!selectedVariant.value) return;
  closeMaterialPreview();
  if (playing.value) {
    pauseTimelinePlayers();
    playing.value = false;
    stopPlaybackClock();
    return;
  }
  if (playhead.value >= currentDuration.value - 1 / TIMELINE_FPS) seek(0);
  playing.value = true;
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
  playing.value = false;
  stopPlaybackClock();
  showNotice('视频素材服务不可用，请恢复后端并刷新页面', 'error');
};
const onTimelinePlayerTimeUpdate = (slotId: string): void => {
  detectMaterialAudio(materialForSlot(slotId), timelinePlayers.get(slotId) ?? null);
};
const onAuditionTime = (): void => {
  auditionTime.value = auditionPlayer.value?.currentTime ?? 0;
  detectMaterialAudio(auditionMaterial.value, auditionPlayer.value);
};
const onAuditionEnded = (): void => {
  auditionPlaying.value = false;
};
const toggleAuditionPlayback = async (): Promise<void> => {
  const video = auditionPlayer.value;
  if (!video) return;
  if (!video.paused) {
    video.pause();
    return;
  }
  if (video.currentTime >= video.duration - 0.04) video.currentTime = 0;
  try {
    await video.play();
  } catch {
    showNotice('浏览器未能开始播放，请再次点击', 'warning');
  }
};
const togglePreviewPlayback = (): void => {
  if (auditionMaterial.value) void toggleAuditionPlayback();
  else void togglePlay();
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
    const result = await validateEffectTemplateMix(
      props.projectId,
      props.workflowRunId,
      draftRevision.value,
      activeEntry.value.id,
    );
    committedVersions[activeEntry.value.id] = activeEntry.value.workspace.editVersion;
    showNotice(
      result.data.artifacts.some(({ unchanged }) => !unchanged)
        ? '模板和时间轴工程已提交'
        : '内容未变化，沿用当前版本',
    );
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
    if (overwriteOpen.value) void closeOverwrite();
    if (workflowDialogOpen.value) void closeWorkflowDialog();
  }
};
const onEditorKeydown = (event: KeyboardEvent): void => {
  onEscape(event);
  if (
    view.value !== 'EDITOR' ||
    createOpen.value ||
    overwriteOpen.value ||
    workflowDialogOpen.value ||
    packagingPanel.value?.visible ||
    event.defaultPrevented
  )
    return;
  const target = event.target as HTMLElement | null;
  if (
    target?.matches('input, textarea, select, [contenteditable="true"]') ||
    (target?.matches('button') &&
      !target.closest('.transition-junction') &&
      !activeTransitionSlotId.value) ||
    target?.closest('[role="dialog"]')
  )
    return;
  if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === 'z') {
    event.preventDefault();
    if (event.shiftKey) redoTimelineEdit();
    else undoTimelineEdit();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === 'y') {
    event.preventDefault();
    redoTimelineEdit();
    return;
  }
  if (event.code === 'Space') {
    event.preventDefault();
    togglePreviewPlayback();
    return;
  }
  if (event.key === 'Delete' || event.key === 'Backspace') {
    console.log('[del] keydown', event.key, 'target=', target?.tagName, target?.className, 'defaultPrevented=', event.defaultPrevented);
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
onBeforeUnmount(() => {
  stopPlaybackClock();
  if (pendingSeekSyncFrame !== undefined) cancelAnimationFrame(pendingSeekSyncFrame);
  pendingSeekSyncFrame = undefined;
  seekSyncRequestId += 1;
  stopPaneResize();
  stopEditorHeightResize();
  pauseTimelinePlayers();
  timelinePlayers.clear();
  removeMaterialPointerListeners();
  materialPointerDrag.value = null;
  materialDragGhost?.remove();
  materialDragGhost = null;
  clearMaterialPointerTarget();
  materialGridResizeObserver?.disconnect();
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
        <div>
          <h1>混剪模板</h1>
          <p>配置模板后进入精修工作台，每个模板独立管理成片工程。</p>
        </div>
        <button class="button" @click="openCreate"><Plus :size="15" />新建模板</button>
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
              @change="changeTemplate"
          /></label>
          <div class="slot-table">
            <div class="slot-heading">
              <span>槽位 / 顺序</span><span>时间区间（自动）</span><span>时长（秒）</span
              ><span>转场</span>
            </div>
            <div v-for="(slot, index) in workspace.template.slots" :key="slot.id" class="slot-row">
              <div class="slot-name">
                <b>{{ index + 1 }}</b
                ><span>{{ EFFECT_TEMPLATE_MIX_ROLE_LABELS[slot.role] }}</span
                ><button :disabled="index === 0" @click="moveTemplateSlot(slot.id, -1)">↑</button
                ><button
                  :disabled="index === workspace.template.slots.length - 1"
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
                min=".1"
                max="120"
                step=".1"
                @change="changeTemplate"
              /><select v-model="slot.transition" @change="changeTemplate">
                <option v-for="item in EFFECT_TEMPLATE_MIX_TRANSITIONS" :key="item">
                  {{ item }}
                </option>
              </select>
            </div>
          </div>
          <footer>
            <div>
              <p v-if="workspace.materials.length">
                已载入 {{ workspace.materials.length }} 个已确认视频片段。
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
        </div>
      </section>

      <section
        v-else-if="view === 'EDITOR' && workspace"
        class="panel workbench"
        @dragstart.capture="onNativeImageDragStart"
      >
        <header class="workbench-head">
          <div class="brand">
            <span>AI</span>
            <div><strong>成片精修工作台</strong><small>修改自动保存到当前模板工程</small></div>
          </div>
          <div class="current">
            <b>{{ selectedVariant?.name ?? '尚未生成成片工程' }}</b
            ><span
              >{{ workspace.template.name }} · 模板时长 {{ currentDuration.toFixed(1) }} 秒</span
            >
          </div>
          <div class="workbench-actions">
            <button
              class="button primary"
              type="button"
              :disabled="
                mutating ||
                Boolean(activeAiRun) ||
                !selectedVariant ||
                workspace.materials.length < 6
              "
              @click="refill"
            >
              <Bot :size="15" />{{
                activeAiRun ? '智能填充中…' : selectedVariant ? '重新智能填充' : '智能填充'
              }}
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
            <button class="button" @click="leaveEditor">返回模板配置</button
            ><button class="button" :disabled="mutating || !selectedVariant" @click="openOverwrite">
              更新模板配置
            </button>
          </div>
        </header>
        <WorkflowRunProgress
          v-if="activeAiRun"
          class="mix-run-progress"
          :progress="activeAiRun.progress"
          :summary="aiStageLabels[activeAiRun.stage]"
          attempt-label="完成后自动把六个片段铺入当前视频轨"
          action-label="查看当前工作流"
          @show-details="openWorkflowDialog"
        />
        <div v-else-if="failedAiRun" class="ai-run-card editor-run failed" role="alert">
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
                :class="{ active: resourceTab === 'AUDIO' }"
                :disabled="!selectedVariant"
                @click="selectResourceTab('AUDIO')"
              >
                <AudioLines :size="14" />音频</button
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
              <div v-if="filteredMaterials.length" ref="materialGrid" class="material-grid">
                <article
                  v-for="material in displayedMaterials"
                  :key="material.id"
                  :class="{
                    selected: auditionMaterial?.id === material.id,
                    used: materialUsageLabel(material.id),
                    disabled: !selectedVariant,
                    dragging: draggingMaterialId === material.id,
                  }"
                  :draggable="Boolean(selectedVariant)"
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
                ><button class="button compact" @click="addCaption"><Plus :size="13" />添加</button>
              </header>
              <label class="subtitle-style"
                >字幕样式
                <select v-model="selectedVariant.subtitleStyle" @change="bump">
                  <option value="standard">标准白字</option>
                  <option value="bold">加粗描边</option>
                  <option value="yellow">重点黄字</option>
                </select>
              </label>
              <div class="caption-list">
                <article v-for="caption in selectedVariant.captions" :key="caption.id">
                  <input v-model="caption.text" maxlength="120" @input="bump" /><small
                    >{{ formatEffectTemplateMixTime(caption.start) }} —
                    {{ formatEffectTemplateMixTime(caption.end) }}</small
                  ><button @click="removeCaption(caption.id)"><X :size="14" /></button>
                </article>
                <p v-if="!selectedVariant.captions.length">选择一个槽位后添加字幕。</p>
              </div></template
            >
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
                  <h4>热门</h4>
                  <div class="transition-card-grid">
                    <button
                      v-for="item in filteredTransitions"
                      :key="item.id"
                      class="transition-card"
                      :class="{ active: item.id === selectedSlot?.transition }"
                      type="button"
                      draggable="true"
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
            <div v-else class="resource-empty">
              <Music2 :size="28" /><b>项目音频库尚未接入</b
              ><span>这里不会生成假 BGM、假口播或假卡点结果。</span>
            </div>
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
          <section ref="playerPanel" class="player-panel" @click="playerMenu = null">
            <header>
              <strong>播放器</strong
              ><span
                >{{ stageMaterial?.ratio || '画幅未记录' }} ·
                {{ stageMaterial?.resolution || '分辨率未记录' }}</span
              >
            </header>
            <div class="stage-space" :class="{ 'is-zoomed': previewZoom > 100 }">
              <div class="stage" :class="{ landscape: stageAspectRatio >= 1 }" :style="stageStyle">
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
                  @pause="auditionPlaying = false"
                  @play="auditionPlaying = true"
                  @timeupdate="onAuditionTime"
                />
                <template v-for="slot in selectedVariant?.slots ?? []" :key="`player:${slot.id}`">
                  <video
                    v-if="materialForSlot(slot.id)"
                    :ref="(element) => setTimelinePlayer(slot.id, element)"
                    class="timeline-stage-video"
                    :class="{
                      'is-visible': !auditionMaterial && visibleTimelineSlotIds.has(slot.id),
                    }"
                    :style="timelinePlayerStyle(slot.id)"
                    :src="materialForSlot(slot.id)?.contentUrl"
                    :volume="
                      packagingPreviewEnabled && selectedPackaging && !selectedPackaging.stale
                        ? 0.15
                        : (selectedVariant?.originalVolume ?? 1)
                    "
                    playsinline
                    preload="metadata"
                    draggable="false"
                    @canplay="onTimelinePlayerReady(slot.id)"
                    @seeked="onTimelinePlayerReady(slot.id)"
                    @loadedmetadata="onTimelinePlayerReady(slot.id)"
                    @timeupdate="onTimelinePlayerTimeUpdate(slot.id)"
                    @error="onTimelinePlayerError(slot.id)"
                  />
                </template>
                <div
                  v-if="activeTransitionPreview && transitionOverlayStyle"
                  class="player-transition-overlay"
                  :style="transitionOverlayStyle"
                  aria-hidden="true"
                />
                <div
                  v-if="selectedVariant && !auditionMaterial && !previewMaterial"
                  class="player-blackout"
                  aria-label="素材缺口黑屏"
                />
                <div
                  v-if="
                    selectedVariant &&
                    !auditionMaterial &&
                    playerUnavailableSlotId === previewSlot?.id
                  "
                  class="player-source-error"
                >
                  当前视频素材暂时无法读取，请恢复素材服务后刷新
                </div>
                <div v-if="!selectedVariant && !auditionMaterial" class="player-empty">
                  <Film :size="34" />
                  <b>尚未生成成片</b>
                  <span>点击右侧“新建成片”，再从素材库拖入画面</span>
                </div>
              </div>
            </div>
            <footer class="player-controls" @click.stop>
              <input
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
                <span class="player-time current">{{
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
                @click="togglePreviewPlayback"
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
                    packagingPanel?.loading
                  "
                  title="为本模板下全部完整成片生成口播、配乐和字幕，将调用付费 AI 服务"
                  @click="openPackaging('ACTION')"
                >
                  <Sparkles :size="13" />{{
                    packagingPanel?.busy || packagingPanel?.active ? '成片包装中…' : '智能成片包装'
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
                  :disabled="mutating || Boolean(activeAiRun) || workspace.variants.length >= 100"
                  title="新建一个不包含任何素材的空成片工程"
                  @click="createEmptyVariant"
                >
                  <Plus :size="13" />新建成片
                </button>
              </div>
            </header>
            <div>
              <article
                v-for="(variant, index) in workspace.variants"
                :key="variant.id"
                :class="{ active: variant.id === selectedVariant?.id }"
                :title="`${variantDisplayName(variant, index)} · ${variantDuration(variant).toFixed(1)}s · ${
                  variant.conflictSlotIds.length
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
                  <small class="project-duration">{{ variantDuration(variant).toFixed(0) }}s</small>
                  <span
                    class="project-status"
                    :class="{
                      pending: variant.status === 'PENDING',
                      incomplete: variant.conflictSlotIds.length > 0,
                    }"
                    :title="
                      variant.status === 'PENDING'
                        ? '待同步'
                        : variant.conflictSlotIds.length
                          ? '待补齐'
                          : '可精修'
                    "
                  />
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
          ><label v-if="!selectedTransitionInfo"
            >时长
            <input
              :value="selectedSlot.duration"
              type="number"
              min=".1"
              max="120"
              step=".1"
              @change="changeProjectDuration(($event.target as HTMLInputElement).value)"
            />
            秒</label
          ><label v-if="!selectedTransitionInfo && selectedMaterial"
            >截取起点
            <input
              :value="selectedVariant.offsets[selectedSlot.id] ?? 0"
              type="number"
              min="0"
              :max="Math.max(0, selectedMaterial.duration - selectedSlot.duration)"
              step=".1"
              @change="changeTrimStart(($event.target as HTMLInputElement).value)"
            />
            秒</label
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
        <EffectTemplateMixPackaging
          ref="packagingPanel"
          :project-id="projectId"
          :workflow-run-id="workflowRunId"
          :template-id="activeTemplateId"
          :variants="workspace.variants"
          :selected-variant-id="selectedVariant?.id ?? ''"
          :prepare="preparePackaging"
          :playhead="playhead"
          :playing="playing"
          @selected="selectedPackaging = $event"
          @preview="packagingPreviewEnabled = $event"
        />
        <EffectTemplateMixTimeline
          :packaging="selectedPackaging?.stale ? null : selectedPackaging"
          :can-redo="canRedoTimeline"
          :can-undo="canUndoTimeline"
          :duration="currentDuration"
          :height="timelineHeight"
          :materials="workspace.materials"
          :playhead="playhead"
          :selected-slot-id="selectedSlot?.id ?? ''"
          :variant="selectedVariant"
          @reorder-slot="moveProjectSlot"
          @move-clip="moveTimelineClip"
          @move-clips="moveTimelineClips"
          @assign-material="assignDroppedMaterial"
          @apply-transition="changeTransitionForSlot"
          @open-transition="openTransitionPanel"
          @redo="redoTimelineEdit"
          @seek="seek"
          @select-slot="selectSlot"
          @trim-slot="changeTimelineTrimStart"
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
        :complete="validated"
        :status-title="
          validated
            ? '当前模板已确认'
            : pendingCount
              ? '仍有工程待同步'
              : complete
                ? '可完成校验'
                : '请先补齐所有素材槽位'
        "
        :status-detail="'步骤 5 / 6 · ' + workspace.template.name"
        :validate-disabled="!canValidate"
        :validating="validating"
        :next-disabled="!validated || validating"
        next-label="下一步：成片输出"
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
              >模板名称<input ref="createNameInput" v-model="newTemplateName" maxlength="40"
            /></label>
            <p>成片时长由各槽位时长实时累加。</p>
          </main>
          <footer>
            <button type="button" class="button" @click="closeCreate">取消</button>
            <button
              type="button"
              class="button primary modal-submit"
              :disabled="!newTemplateName.trim()"
              @click="addTemplate"
            >
              <Plus :size="14" />创建模板
            </button>
          </footer>
        </section>
      </div>
      <div v-if="overwriteOpen && workspace" class="mask" @mousedown.self="closeOverwrite">
        <section
          class="modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="mix-overwrite-title"
        >
          <header>
            <div>
              <h3 id="mix-overwrite-title">更新当前模板配置</h3>
              <p>使用当前工程的顺序、时长和转场更新模板。</p>
            </div>
            <button aria-label="关闭更新模板弹窗" @click="closeOverwrite"><X :size="18" /></button>
          </header>
          <main>
            <p>同步时只更新「{{ workspace.template.name }}」下的其他工程，并保留人工选择素材。</p>
          </main>
          <footer>
            <button class="button" :disabled="mutating" @click="overwrite(false)">仅更新模板</button
            ><button class="button primary" :disabled="mutating" @click="overwrite(true)">
              更新并同步其他工程
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
          <div class="workflow-version-notice" :class="`is-${workflowNotice.tone}`">
            <LoaderCircle v-if="workflowNotice.tone === 'running'" class="spin" :size="15" />
            <AlertCircle v-else-if="workflowNotice.tone === 'danger'" :size="15" />
            <CheckCircle2 v-else-if="workflowNotice.tone === 'success'" :size="15" />
            <Sparkles v-else :size="15" />
            <span>
              <strong>{{ workflowNotice.title }}</strong>
              {{ workflowNotice.detail }}
            </span>
          </div>
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
                    <small>任务进度</small>
                    <b>{{ workflowRunForDisplay.progress }}%</b>
                  </span>
                </div>
                <p class="workflow-node-summary">
                  {{ aiStageDescriptions[selectedWorkflowStage] }}
                </p>
                <section class="workflow-detail-block is-input">
                  <span>INPUT</span>
                  <strong>本阶段输入</strong>
                  <p>{{ aiStageInputs[selectedWorkflowStage] }}</p>
                </section>
                <section class="workflow-detail-block is-output">
                  <span>OUTPUT</span>
                  <strong>本阶段输出</strong>
                  <p>{{ aiStageOutputs[selectedWorkflowStage] }}</p>
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
            <button type="button" @click="closeWorkflowDialog">
              <ArrowLeft :size="14" />返回工作区
            </button>
          </footer>
        </section>
      </div></Teleport
    >
  </section>
</template>

<style scoped>
.mix-node {
  --blue: #2563eb;
  margin-top: 18px;
  padding: 12px;
  color: #17233a;
  background: #f4f7fb;
  border: 1px solid #dbe4f2;
  border-radius: 20px;
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
.config-head,
.workbench-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 4px 16px;
}
.config-head > div,
.current {
  flex: 1;
}
.config-head h1 {
  margin: 0 0 4px;
  font-size: 22px;
}
.config-head p,
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
  grid-template-columns: 245px 1fr;
  gap: 12px;
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
  padding: 18px;
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
  margin: 4px 0;
  color: #64748b;
  font-size: 12px;
}
.config-panel > header > span {
  padding: 9px;
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  font-size: 12px;
}
.config-panel > header b {
  color: #1d4ed8;
}
.name-field {
  display: grid;
  gap: 5px;
  margin: 17px 0 13px;
  font-size: 12px;
  font-weight: 700;
}
.name-field input,
.slot-row input,
.slot-row select,
.slot-settings input,
.slot-settings select,
.modal input,
.caption-list input {
  height: 34px;
  padding: 0 9px;
  border: 1px solid #cfd9e8;
  border-radius: 7px;
}
.slot-table {
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  overflow: hidden;
}
.slot-heading,
.slot-row {
  display: grid;
  grid-template-columns: minmax(210px, 1.3fr) minmax(160px, 1fr) 100px 105px;
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
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
.slot-name {
  display: flex;
  align-items: center;
  gap: 6px;
}
.slot-name > b {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  color: #1d4ed8;
  background: #dbeafe;
  border-radius: 6px;
}
.slot-name span {
  flex: 1;
  font-size: 12px;
  font-weight: 700;
}
.slot-name button {
  width: 25px;
  height: 25px;
  background: #fff;
  border: 1px solid #dce5f0;
  border-radius: 5px;
}
.slot-row code {
  color: #64748b;
  font-size: 11px;
}
.config-panel > footer {
  margin-top: 15px;
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
  overflow: hidden;
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
  background: radial-gradient(circle, transparent 0 12%, #d8e7f2 14% 19%, transparent 21% 29%, #506b86 31% 100%);
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
  background: linear-gradient(110deg, #506b86 0 22%, #f472b6 35%, #fef08a 50%, #67e8f9 65%, #506b86 82%);
}
.transition-preview.is-noise-dissolve {
  background:
    radial-gradient(circle at 25% 35%, #d8e7f2 0 3px, transparent 4px),
    radial-gradient(circle at 70% 65%, #273747 0 3px, transparent 4px),
    #506b86;
  background-size: 18px 18px, 23px 23px, auto;
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
.caption-list {
  display: grid;
  align-content: start;
  gap: 8px;
  overflow: auto;
  padding: 0 12px;
}
.subtitle-style {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 0 12px 8px;
  color: #64748b;
  font-size: 11px;
}
.subtitle-style select {
  height: 30px;
  padding: 0 8px;
  border: 1px solid #dce5f0;
  border-radius: 6px;
}
.caption-list article {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 4px;
  padding: 8px;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
}
.caption-list input {
  grid-column: 1/3;
}
.caption-list button {
  background: none;
  border: 0;
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
.player-blackout {
  position: absolute;
  z-index: 3;
  inset: 0;
  background: #000;
}
.player-source-error {
  position: absolute;
  z-index: 5;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 24px;
  text-align: center;
  color: #334155;
  background: #f1f5f9;
  font-size: 12px;
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
  z-index: 2;
  top: -3px;
  left: 0;
  width: 100%;
  height: 6px;
  margin: 0;
  accent-color: #2563eb;
  cursor: pointer;
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
  width: 100%;
  justify-content: center;
  white-space: nowrap;
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
.project-empty {
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
.slot-settings label {
  display: flex;
  align-items: center;
  gap: 5px;
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
  .workflow-version-notice,
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
