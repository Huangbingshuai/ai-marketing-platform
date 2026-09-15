<script setup lang="ts">
import type {
  EffectImportProduct,
  EffectTemplateMixAiRun,
  EffectTemplateMixClassificationPool,
  EffectTemplateMixDraft,
  EffectTemplateMixMaterial,
  EffectTemplateMixRole,
  EffectTemplateMixTemplateEntry,
  EffectTemplateMixTransition,
  EffectTemplateMixVariant,
} from '@ai-marketing/contracts';
import { WorkflowNodeDraftBar, WorkflowNodeFooter, WorkflowRunProgress } from '@ai-marketing/ui';
import {
  AlertCircle,
  ArrowLeft,
  Bot,
  CheckCircle2,
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
  Type,
  WandSparkles,
  Workflow,
  X,
  ZoomIn,
  ZoomOut,
} from '@lucide/vue';
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';

import {
  applyEffectTemplateMixVariant,
  composeEffectTemplateMixVariants,
  createEffectTemplateMixAiRun,
  getEffectTemplateMixAiRun,
  loadEffectTemplateMixWorkspace,
  saveEffectTemplateMixDraft,
  serializeEffectTemplateMixDraft,
  validateEffectTemplateMix,
} from './api/effect-template-mix.api';
import {
  EFFECT_TEMPLATE_MIX_ROLE_LABELS,
  EFFECT_TEMPLATE_MIX_TRANSITIONS,
  cloneMix,
  createEffectTemplateMixEntry,
  effectTemplateMixTiming,
  formatEffectTemplateMixTime,
  markEffectTemplateMixChanged,
  moveEffectTemplateMixSlot,
} from './effect-template-mix-state';
import EffectTemplateMixThumbnail from './EffectTemplateMixThumbnail.vue';
import EffectTemplateMixTimeline from './EffectTemplateMixTimeline.vue';

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
const materialRoleFilter = ref<'ALL' | EffectTemplateMixRole>('ALL');
const materialPage = ref(1);
const draggingMaterialId = ref('');
const auditionMaterial = ref<EffectTemplateMixMaterial | null>(null);
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
const timelinePlayers = new Map<string, HTMLVideoElement>();
const workbenchMain = ref<HTMLElement | null>(null);
const materialGrid = ref<HTMLElement | null>(null);
const materialGridWidth = ref(0);
const leftPaneWidth = ref(340);
const rightPaneWidth = ref(270);
const topPaneHeight = ref(480);
const timelineHeight = ref(260);
const compactWorkbench = ref(false);
const resizingPane = ref<'LEFT' | 'RIGHT' | null>(null);
const resizingEditorHeight = ref<{
  startClientY: number;
  startTopHeight: number;
  totalHeight: number;
} | null>(null);
const TIMELINE_FPS = 30;
const LEFT_PANE_MIN_WIDTH = 230;
const LEFT_PANE_MAX_WIDTH = 680;
const CENTER_PANE_MIN_WIDTH = 420;
const AUDIO_METER_LEVELS = [2, 4, 3] as const;
type TimelineEditSnapshot = {
  selectedSlotId: string;
  variant: EffectTemplateMixVariant;
};
const timelineUndoStack = ref<TimelineEditSnapshot[]>([]);
const timelineRedoStack = ref<TimelineEditSnapshot[]>([]);
const createNameInput = ref<HTMLInputElement | null>(null);
const dialogTrigger = ref<HTMLElement | null>(null);
const workflowTrigger = ref<HTMLButtonElement | null>(null);
const workflowCloseButton = ref<HTMLButtonElement | null>(null);
let controller: AbortController | undefined;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let noticeTimer: ReturnType<typeof setTimeout> | undefined;
let pendingSave: Promise<boolean> | undefined;
let playbackAnimationFrame: number | undefined;
let playbackAnchorMilliseconds = 0;
let playbackAnchorSeconds = 0;
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
const templateTiming = computed(() =>
  effectTemplateMixTiming(workspace.value?.template.slots ?? []),
);
const currentTiming = computed(() => effectTemplateMixTiming(selectedVariant.value?.slots ?? []));
const currentDuration = computed(() =>
  selectedVariant.value ? currentTiming.value.duration : templateTiming.value.duration,
);
const materialForSlot = (
  slotId: string,
  variant: EffectTemplateMixVariant | null = selectedVariant.value,
): EffectTemplateMixMaterial | null =>
  workspace.value?.materials.find(({ id }) => id === variant?.bindings[slotId]) ?? null;
const selectedMaterial = computed(() =>
  selectedSlot.value ? materialForSlot(selectedSlot.value.id) : null,
);
const materialUsageLabel = (materialId: string): string => {
  const variant = selectedVariant.value;
  if (!variant) return '';
  const slot = variant.slots.find(({ id }) => variant.bindings[id] === materialId);
  return slot ? EFFECT_TEMPLATE_MIX_ROLE_LABELS[slot.role] : '';
};
const previewSlot = computed(() => {
  const variant = selectedVariant.value;
  if (!variant?.slots.length) return null;
  const safeTime = Math.min(Math.max(0, playhead.value), currentDuration.value);
  const index = currentTiming.value.slots.findIndex(
    ({ start, end }) => safeTime >= start && safeTime < end,
  );
  return variant.slots[index < 0 ? Math.max(0, variant.slots.length - 1) : index] ?? null;
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
const filteredMaterials = computed(() => {
  const slot = selectedSlot.value;
  if (!workspace.value) return [];
  const search = keyword.value.trim().toLocaleLowerCase('zh-CN');
  return workspace.value.materials.filter(
    (item) =>
      item.available &&
      (materialRoleFilter.value === 'ALL' ||
        classificationByRoleAndMaterial.value.has(`${materialRoleFilter.value}:${item.id}`)) &&
      (!slot || item.duration + 0.001 >= slot.duration) &&
      (!search || (item.name + item.code).toLocaleLowerCase('zh-CN').includes(search)),
  );
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
const pauseTimelinePlayers = (exceptSlotId = ''): void => {
  for (const [slotId, video] of timelinePlayers) {
    if (slotId !== exceptSlotId) video.pause();
  }
};
const closeMaterialPreview = (): void => {
  auditionPlayer.value?.pause();
  auditionPlaying.value = false;
  auditionMaterial.value = null;
  auditionTime.value = 0;
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
  activeTemplateId.value = id;
  clearTimelineHistory();
  keyword.value = '';
  resourceTab.value = 'MATERIAL';
  scheduleSave();
};
const enterEditor = (): void => {
  playing.value = false;
  pauseTimelinePlayers();
  closeMaterialPreview();
  stopPlaybackClock();
  resourceTab.value = 'MATERIAL';
  keyword.value = '';
  playhead.value = 0;
  clearTimelineHistory();
  view.value = 'EDITOR';
};
const selectVariant = (id: string): void => {
  if (!activeUi.value || !workspace.value) return;
  playing.value = false;
  pauseTimelinePlayers();
  closeMaterialPreview();
  stopPlaybackClock();
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
  view.value = 'CONFIG';
};
const selectSlot = (id: string): void => {
  if (!activeUi.value) return;
  closeMaterialPreview();
  activeUi.value.selectedSlotId = id;
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
  variant.bindingMetadata[slot.id] = { source: 'MANUAL', trimReason: '人工替换素材' };
  if (!variant.manualSlotIds.includes(slot.id)) variant.manualSlotIds.push(slot.id);
  variant.conflictSlotIds = variant.conflictSlotIds.filter((id) => id !== slot.id);
  if (activeUi.value) activeUi.value.selectedSlotId = slot.id;
  bump();
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
  for (const slot of workspace.value.template.slots) {
    slot.duration = Number.isFinite(Number(slot.duration))
      ? Math.min(120, Math.max(0.1, Math.round(Number(slot.duration) * 10) / 10))
      : 0.1;
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
const changeTransition = (transition: EffectTemplateMixTransition): void => {
  if (!selectedSlot.value) return;
  if (selectedSlot.value.transition === transition) return;
  rememberTimelineEdit();
  selectedSlot.value.transition = transition;
  bump();
};
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
const createVariantWithAi = (): void => void startAiFill(null);
const composeVariants = async (): Promise<void> => {
  if (!workspace.value || mutating.value || activeAiRun.value) return;
  if (!(await flushPendingEdits()) || draftRevision.value === null) return;
  const templateId = activeTemplateId.value;
  const previousCount = workspace.value.variants.length;
  mutating.value = true;
  try {
    const response = await composeEffectTemplateMixVariants(
      props.projectId,
      props.workflowRunId,
      draftRevision.value,
      templateId,
    );
    installWorkspaceData(response.data);
    showNotice(
      `已用归槽与 AI 截取素材组合 ${workspace.value!.variants.length - previousCount} 条不同成片，未重复调用模型`,
      'success',
    );
  } catch (error) {
    showNotice(error instanceof Error ? error.message : '算法组合失败', 'error');
  } finally {
    mutating.value = false;
  }
};
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
};
const resetPlaybackClock = (): void => {
  playbackAnchorMilliseconds = performance.now();
  playbackAnchorSeconds = playhead.value;
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
  playbackAnimationFrame = requestAnimationFrame(updatePlaybackFrame);
};
const startPlaybackClock = (): void => {
  stopPlaybackClock();
  resetPlaybackClock();
  playbackAnimationFrame = requestAnimationFrame(updatePlaybackFrame);
};
const syncPlayerToPlayhead = async (resume = false): Promise<void> => {
  await nextTick();
  const slot = previewSlot.value;
  const range = previewRange.value;
  const material = previewMaterial.value;
  if (!slot || !range || !selectedVariant.value || !material) {
    pauseTimelinePlayers();
    displayedTimelineSlotId.value = '';
    playerUnavailableSlotId.value = '';
    return;
  }
  const video = activeTimelinePlayer();
  if (!video) return;
  pauseTimelinePlayers(slot.id);
  const sourceTime = (selectedVariant.value.offsets[slot.id] ?? 0) + playhead.value - range.start;
  if (Number.isFinite(sourceTime) && Math.abs(video.currentTime - sourceTime) > 1 / TIMELINE_FPS) {
    // Keep the last decoded frame visible while the replacement clip seeks.
    video.currentTime = Math.max(0, sourceTime);
  }
  if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && !video.seeking) {
    playerUnavailableSlotId.value = '';
    displayedTimelineSlotId.value = slot.id;
  }
  if (resume && video.paused) {
    try {
      await video.play();
    } catch {
      // The project clock remains authoritative. A temporarily unavailable source
      // is rendered as black while the playhead continues through the timeline.
    }
  }
};
const seek = (raw: number): void => {
  closeMaterialPreview();
  playhead.value = quantizeTimelineTime(raw);
  if (playing.value) resetPlaybackClock();
  void syncPlayerToPlayhead(playing.value);
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
  if (auditionMaterial.value || previewSlot.value?.id !== slotId) return;
  const video = timelinePlayers.get(slotId);
  if (!video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
  detectMaterialAudio(materialForSlot(slotId), video);
  playerUnavailableSlotId.value = '';
  displayedTimelineSlotId.value = slotId;
  // Readiness callbacks may arrive repeatedly during decoding. Re-seeking here to
  // the advancing project clock would create a permanent seek/buffer loop.
  if (playing.value && video.paused) void video.play().catch(() => undefined);
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
    event.defaultPrevented
  )
    return;
  const target = event.target as HTMLElement | null;
  if (
    target?.matches('input, textarea, select, button, [contenteditable="true"]') ||
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
  stopPaneResize();
  stopEditorHeightResize();
  pauseTimelinePlayers();
  timelinePlayers.clear();
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

      <section v-else-if="view === 'EDITOR' && workspace" class="panel workbench">
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
              :disabled="mutating || Boolean(activeAiRun) || workspace.materials.length < 6"
              @click="refill"
            >
              <Bot :size="15" />{{
                activeAiRun ? '智能填充中…' : selectedVariant ? '重新智能填充' : 'AI 智能填充'
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
                @click="resourceTab = 'MATERIAL'"
              >
                <Sparkles :size="14" />素材</button
              ><button
                :class="{ active: resourceTab === 'AUDIO' }"
                :disabled="!selectedVariant"
                @click="resourceTab = 'AUDIO'"
              >
                <Music2 :size="14" />音频</button
              ><button
                :class="{ active: resourceTab === 'TEXT' }"
                :disabled="!selectedVariant"
                @click="resourceTab = 'TEXT'"
              >
                <Type :size="14" />字幕</button
              ><button
                :class="{ active: resourceTab === 'TRANSITION' }"
                :disabled="!selectedVariant"
                @click="resourceTab = 'TRANSITION'"
              >
                ◇ 转场
              </button>
            </nav>
            <template v-if="resourceTab === 'MATERIAL'"
              ><header>
                <strong>素材库</strong><small>{{ filteredMaterials.length }} 条可用素材</small>
              </header>
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
                  @click="previewLibraryMaterial(material)"
                  @dragend="endMaterialDrag"
                  @dragstart="beginMaterialDrag($event, material)"
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
                    <small>{{ material.code }} · {{ material.duration.toFixed(1) }} 秒</small>
                    <em>{{
                      !selectedVariant
                        ? '等待 AI 创建成片工程'
                        : auditionMaterial?.id === material.id
                          ? '正在播放器中预览'
                          : materialUsageLabel(material.id)
                            ? '已用于：' + materialUsageLabel(material.id)
                            : '点击预览 · 拖到时间轴使用'
                    }}</em>
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
            <template v-else-if="resourceTab === 'TRANSITION' && selectedVariant"
              ><header><strong>当前片段转场</strong></header>
              <div class="transition-grid">
                <button
                  v-for="item in EFFECT_TEMPLATE_MIX_TRANSITIONS"
                  :key="item"
                  :class="{ active: item === selectedSlot?.transition }"
                  @click="changeTransition(item)"
                >
                  ◇ {{ item }}
                </button>
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
                <video
                  v-if="auditionMaterial"
                  ref="auditionPlayer"
                  class="audition-video is-visible"
                  :src="auditionMaterial.contentUrl"
                  playsinline
                  preload="auto"
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
                      'is-visible': !auditionMaterial && displayedTimelineSlotId === slot.id,
                    }"
                    :src="materialForSlot(slot.id)?.contentUrl"
                    playsinline
                    preload="auto"
                    @canplay="onTimelinePlayerReady(slot.id)"
                    @seeked="onTimelinePlayerReady(slot.id)"
                    @loadedmetadata="onTimelinePlayerReady(slot.id)"
                    @timeupdate="onTimelinePlayerTimeUpdate(slot.id)"
                    @error="onTimelinePlayerError(slot.id)"
                  />
                </template>
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
                  <span>点击右上角“AI 智能填充”开始生成时间轴工程</span>
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
            aria-label="调整成片项目宽度"
            aria-orientation="vertical"
            :aria-valuenow="rightPaneWidth"
            @pointerdown="startPaneResize($event, 'RIGHT')"
          >
            <span />
          </div>
          <aside class="projects">
            <header>
              <strong>成片项目</strong
              ><button
                class="button compact"
                :disabled="
                  mutating ||
                  Boolean(activeAiRun) ||
                  workspace.variants.length >= 100 ||
                  workspace.materials.length < 6
                "
                :title="
                  workspace.variants.length
                    ? '复用已归槽并经 AI 裁剪的素材，算法组合至 100 条不同工程'
                    : '先运行 AI 智能填充建立素材裁剪池'
                "
                @click="workspace.variants.length ? composeVariants() : createVariantWithAi()"
              >
                <Plus :size="13" />{{ workspace.variants.length ? '算法批量组合' : 'AI 智能填充' }}
              </button>
            </header>
            <div>
              <article
                v-for="(variant, index) in workspace.variants"
                :key="variant.id"
                :class="{ active: variant.id === selectedVariant?.id }"
                @click="selectVariant(variant.id)"
              >
                <span class="cover">{{ String(index + 1).padStart(2, '0') }}</span>
                <div>
                  <b>{{ variant.name }}</b
                  ><small
                    >{{ effectTemplateMixTiming(variant.slots).duration.toFixed(1) }}s ·
                    {{
                      variant.conflictSlotIds.length
                        ? variant.conflictSlotIds.length + ' 个缺口'
                        : '时间轴完整'
                    }}</small
                  >
                </div>
                <em>{{
                  variant.status === 'PENDING'
                    ? '待同步'
                    : variant.conflictSlotIds.length
                      ? '待补齐'
                      : '可精修'
                }}</em>
              </article>
              <div v-if="!workspace.variants.length" class="project-empty">
                <Film :size="24" />
                <b>还没有成片工程</b>
                <span>先运行 AI 归槽与裁剪；后续可用算法复用六槽素材，批量组合不同成片。</span>
              </div>
            </div>
          </aside>
        </div>
        <div v-if="selectedSlot && selectedVariant" class="slot-settings">
          <b>{{ EFFECT_TEMPLATE_MIX_ROLE_LABELS[selectedSlot.role] }}</b
          ><label
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
          ><label v-if="selectedMaterial"
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
          ><span v-if="selectedMaterial" class="trim-range"
            >截取 {{ (selectedVariant.offsets[selectedSlot.id] ?? 0).toFixed(1) }}s —
            {{
              ((selectedVariant.offsets[selectedSlot.id] ?? 0) + selectedSlot.duration).toFixed(1)
            }}s</span
          ><span
            v-if="selectedBindingMetadata?.source === 'AI'"
            class="ai-binding-note"
            :title="
              selectedBindingMetadata.classificationReason || selectedBindingMetadata.trimReason
            "
            ><Bot :size="12" />AI 匹配
            {{ selectedBindingMetadata.matchScore?.toFixed(2) ?? '—' }}</span
          ><span
            v-if="selectedVariant.bindingMetadata?.[selectedSlot.id]?.matchLevel === 'LOW_MATCH'"
            class="low-match-note"
            :title="selectedVariant.bindingMetadata?.[selectedSlot.id]?.classificationReason"
            >低匹配补位</span
          ><label
            >转场
            <select
              :value="selectedSlot.transition"
              @change="
                changeTransition(
                  ($event.target as HTMLSelectElement).value as EffectTemplateMixTransition,
                )
              "
            >
              <option v-for="item in EFFECT_TEMPLATE_MIX_TRANSITIONS" :key="item">
                {{ item }}
              </option>
            </select></label
          ><span>{{ pendingCount ? pendingCount + ' 个同模板工程待同步' : '模板工程已同步' }}</span>
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
        <EffectTemplateMixTimeline
          :can-redo="canRedoTimeline"
          :can-undo="canUndoTimeline"
          :duration="currentDuration"
          :height="timelineHeight"
          :materials="workspace.materials"
          :playhead="playhead"
          :selected-slot-id="selectedSlot?.id ?? ''"
          :variant="selectedVariant"
          @reorder-slot="moveProjectSlot"
          @assign-material="assignDroppedMaterial"
          @redo="redoTimelineEdit"
          @seek="seek"
          @select-slot="selectSlot"
          @trim-slot="changeTimelineTrimStart"
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
  grid-template-columns: 340px 7px minmax(420px, 1fr) 7px 270px;
  height: 480px;
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
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  border-bottom: 1px solid #e2e8f0;
}
.resource-tabs button {
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
  margin: 0 12px 8px;
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
  display: flex;
  flex: none;
  gap: 5px;
  margin: 0 12px 8px;
  overflow-x: auto;
  scrollbar-width: thin;
}
.material-role-filters button {
  display: inline-flex;
  align-items: center;
  flex: none;
  gap: 4px;
  min-height: 25px;
  padding: 0 8px;
  border: 1px solid #dce5f0;
  border-radius: 999px;
  color: #52647e;
  background: #fff;
  font-size: 9px;
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
.material-copy b,
.material-copy small,
.material-copy em {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 10px;
}
.material-copy small {
  color: #64748b;
  font-size: 9px;
}
.material-copy em {
  margin-top: 2px;
  color: #2563eb;
  font-size: 8px;
  font-style: normal;
  font-weight: 700;
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
  z-index: 4;
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
}
.projects > header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 11px;
  border-bottom: 1px solid #e2e8f0;
}
.projects > div {
  height: 346px;
  overflow: auto;
}
.projects article {
  display: grid;
  grid-template-columns: 38px 1fr auto;
  align-items: center;
  gap: 8px;
  padding: 9px;
  border-bottom: 1px solid #edf1f6;
  cursor: pointer;
}
.projects article.active {
  background: #eff6ff;
}
.cover {
  display: grid;
  place-items: center;
  width: 38px;
  height: 50px;
  color: #fff;
  background: #334155;
  border-radius: 5px;
}
.projects article div {
  display: grid;
  min-width: 0;
}
.projects article b {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
}
.projects article small,
.projects article em {
  color: #64748b;
  font-size: 9px;
}
.projects article em {
  color: #b45309;
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
.slot-settings > span {
  margin-left: auto;
  color: #64748b;
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
.workflow-dialog {
  width: min(1180px, 100%);
  max-height: calc(100vh - 40px);
  overflow: auto;
  background: #f8faff;
  border-radius: 18px;
}
.workflow-dialog > header {
  position: sticky;
  z-index: 2;
  top: 0;
  padding: 20px 22px;
  background: #ffffffed;
  border-bottom: 1px solid #dbe4f6;
}
.workflow-graph-title > span {
  color: #7557b6;
  font-size: 9px;
  font-weight: 900;
  letter-spacing: 0.08em;
}
.workflow-graph-title h2 {
  margin: 5px 0 0;
  color: #17233a;
  font-size: 20px;
}
.workflow-graph-title p {
  margin: 5px 0 0;
  color: #718096;
  font-size: 11px;
}
.workflow-graph-close {
  display: grid;
  width: 34px;
  height: 34px;
  padding: 0;
  flex: none;
  place-items: center;
  color: #60708a;
  background: #f6f8fc !important;
  border: 1px solid #e2e8f0;
  border-radius: 9px;
}
.workflow-version-notice {
  display: flex;
  margin: 14px 20px 0;
  padding: 11px 13px;
  align-items: flex-start;
  gap: 9px;
  color: #536178;
  background: #eef5ff;
  border: 1px solid #d5e5ff;
  border-radius: 11px;
  font-size: 10px;
  line-height: 1.6;
}
.workflow-version-notice svg {
  flex: none;
  margin-top: 1px;
  color: #2563eb;
}
.workflow-version-notice strong {
  display: block;
  color: #28446f;
  font-size: 11px;
}
.workflow-version-notice.is-danger {
  color: #8f3040;
  background: #fff1f2;
  border-color: #fecdd3;
}
.workflow-version-notice.is-danger svg,
.workflow-version-notice.is-danger strong {
  color: #bd3346;
}
.workflow-version-notice.is-success {
  color: #28705c;
  background: #ecf9f4;
  border-color: #ccecdf;
}
.workflow-version-notice.is-success svg,
.workflow-version-notice.is-success strong {
  color: #0f8a68;
}
.workflow-graph-content {
  display: grid;
  padding: 0 !important;
  grid-template-columns: minmax(0, 1fr) 390px;
  align-items: start;
}
.workflow-graph-canvas {
  padding: 20px;
}
.workflow-graph-node {
  display: grid;
  width: 100%;
  min-width: 0;
  padding: 12px;
  grid-template-columns: 12px minmax(0, 1fr) auto;
  align-items: start;
  gap: 9px;
  color: #33415a;
  text-align: left;
  background: #fff;
  border: 1px solid #dbe4f6;
  border-radius: 13px;
}
.workflow-graph-node:hover,
.workflow-graph-node[aria-pressed='true'] {
  border-color: #81a9f5;
  box-shadow: 0 0 0 3px #dbeafe;
}
.workflow-graph-node > span:nth-child(2) {
  display: grid;
  gap: 4px;
}
.workflow-graph-node strong {
  font-size: 12px;
}
.workflow-graph-node small {
  color: #7d899f;
  font-size: 9px;
  line-height: 1.5;
}
.workflow-graph-node em {
  padding: 4px 7px;
  color: #718096;
  background: #f1f4f8;
  border-radius: 99px;
  font-size: 8px;
  font-style: normal;
  font-weight: 800;
}
.workflow-node-dot {
  box-sizing: content-box;
  width: 9px;
  height: 9px;
  margin-top: 4px;
  background: #a7b0bf;
  border: 2px solid #eef1f5;
  border-radius: 99px;
}
.workflow-graph-node.is-running {
  background: #f7faff;
  border-color: #91b7ff;
}
.workflow-graph-node.is-running .workflow-node-dot {
  background: #2563eb;
  border-color: #dbeafe;
  animation: pulse-node 1.2s infinite;
}
.workflow-graph-node.is-success .workflow-node-dot {
  background: #0f9f78;
  border-color: #ddf6ee;
}
.workflow-graph-node.is-danger .workflow-node-dot {
  background: #dc3f52;
  border-color: #ffe4e8;
}
.workflow-connector {
  display: grid;
  height: 19px;
  place-items: center;
}
.workflow-connector i {
  width: 1px;
  height: 100%;
  background: #b9c8df;
}
.workflow-node-detail {
  position: sticky;
  top: 95px;
  min-height: 410px;
  max-height: 590px;
  margin: 20px 20px 20px 0;
  padding: 16px;
  overflow: auto;
  background: #fff;
  border: 1px solid #dbe4f6;
  border-radius: 16px;
}
.workflow-node-detail-empty {
  display: grid;
  min-height: 378px;
  place-content: center;
  justify-items: center;
  color: #7d899f;
  text-align: center;
}
.workflow-node-detail-empty strong {
  margin-top: 10px;
  color: #33415a;
  font-size: 13px;
}
.workflow-node-detail-empty p {
  max-width: 240px;
  font-size: 10px;
  line-height: 1.65;
}
.workflow-node-detail-header {
  padding-bottom: 12px;
  border-bottom: 1px solid #e7edf8;
}
.workflow-node-detail-header span,
.workflow-node-detail-header strong {
  display: block;
}
.workflow-node-detail-header span {
  color: #2563eb;
  font-size: 9px;
  font-weight: 850;
  letter-spacing: 0.08em;
}
.workflow-node-detail-header strong {
  margin-top: 4px;
  color: #253047;
  font-size: 14px;
}
.workflow-node-detail-status {
  display: flex;
  margin-top: 13px;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.workflow-node-detail-status em {
  padding: 4px 7px;
  color: #718096;
  background: #f1f4f8;
  border-radius: 999px;
  font-size: 8px;
  font-style: normal;
  font-weight: 800;
}
.workflow-node-detail-status em.is-running {
  color: #2563eb;
  background: #eaf2ff;
}
.workflow-node-detail-status em.is-success {
  color: #0f8a68;
  background: #eaf8f3;
}
.workflow-node-detail-status em.is-danger {
  color: #c93448;
  background: #fff0f2;
}
.workflow-node-detail-status > span {
  display: grid;
  justify-items: end;
  gap: 2px;
  color: #8994a8;
  font-size: 8px;
}
.workflow-node-summary {
  margin: 10px 0 0 !important;
  color: #4d5b72 !important;
  font-size: 10px !important;
  line-height: 1.65;
}
.workflow-detail-block {
  margin-top: 12px;
  padding: 11px;
  background: #fbfcff;
  border: 1px solid #e2e9f5;
  border-radius: 11px;
}
.workflow-detail-block.is-input {
  background: #f7fbff;
  border-color: #dce9fb;
}
.workflow-detail-block.is-output {
  background: #f8fcfa;
  border-color: #dcefe7;
}
.workflow-detail-block.is-boundary {
  background: #faf9ff;
  border-color: #e7e2f5;
}
.workflow-detail-block > span {
  display: block;
  color: #2563eb;
  font-size: 8px;
  font-weight: 900;
  letter-spacing: 0.08em;
}
.workflow-detail-block.is-output > span {
  color: #0f8a68;
}
.workflow-detail-block.is-boundary > span {
  color: #7557b6;
}
.workflow-detail-block strong {
  display: block;
  margin-top: 4px;
  color: #35435a;
  font-size: 10px;
}
.workflow-detail-block p {
  margin: 5px 0 0;
  font-size: 9px;
  line-height: 1.65;
}
.workflow-dialog > footer {
  padding: 13px 20px 18px;
  justify-content: flex-start;
  gap: 12px;
  color: #718096;
  font-size: 9px;
}
.workflow-dialog > footer span {
  display: flex;
  align-items: center;
  gap: 5px;
}
.workflow-dialog > footer i {
  width: 7px;
  height: 7px;
  background: #a7b0bf;
  border-radius: 99px;
}
.workflow-dialog > footer i.running {
  background: #2563eb;
}
.workflow-dialog > footer i.success {
  background: #0f9f78;
}
.workflow-dialog > footer i.danger {
  background: #dc3f52;
}
.workflow-dialog > footer .workflow-edge-count {
  margin-left: auto;
}
.workflow-dialog > footer button {
  display: inline-flex;
  height: 34px;
  padding: 0 13px;
  align-items: center;
  gap: 5px;
  color: #fff;
  background: #2563eb;
  border: 0;
  border-radius: 9px;
  font-size: 10px;
  font-weight: 800;
}
@keyframes pulse-node {
  50% {
    box-shadow: 0 0 0 5px #bfdbfe66;
  }
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
    height: 180px;
  }
  .projects > div {
    height: 130px;
    display: grid;
    grid-template-columns: repeat(3, 1fr);
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
    display: block;
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
