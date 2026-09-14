<script setup lang="ts">
import type {
  EffectImportProduct,
  EffectTemplateMixDraft,
  EffectTemplateMixMaterial,
  EffectTemplateMixTemplateEntry,
  EffectTemplateMixTransition,
  EffectTemplateMixVariant,
} from '@ai-marketing/contracts';
import { WorkflowNodeDraftBar, WorkflowNodeFooter } from '@ai-marketing/ui';
import {
  AlertCircle,
  Film,
  Layers3,
  LoaderCircle,
  Music2,
  Pause,
  Play,
  Plus,
  Search,
  Sparkles,
  Type,
  WandSparkles,
  X,
} from '@lucide/vue';
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';

import {
  applyEffectTemplateMixVariant,
  createEffectTemplateMixVariant,
  loadEffectTemplateMixWorkspace,
  refillEffectTemplateMixVariant,
  saveEffectTemplateMixDraft,
  serializeEffectTemplateMixDraft,
  validateEffectTemplateMix,
} from './api/effect-template-mix.api';
import {
  EFFECT_TEMPLATE_MIX_PURPOSE_LABELS,
  EFFECT_TEMPLATE_MIX_ROLE_LABELS,
  EFFECT_TEMPLATE_MIX_TRANSITIONS,
  cloneMix,
  createEffectTemplateMixEntry,
  effectTemplateMixTiming,
  formatEffectTemplateMixTime,
  markEffectTemplateMixChanged,
  moveEffectTemplateMixSlot,
} from './effect-template-mix-state';

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
const resourceTab = ref<'AUDIO' | 'MATERIAL' | 'TEXT' | 'TRANSITION'>('MATERIAL');
const keyword = ref('');
const playing = ref(false);
const playhead = ref(0);
const zoom = ref(40);
const createOpen = ref(false);
const overwriteOpen = ref(false);
const notice = ref<Notice | null>(null);
const draggedSlotId = ref('');
const newTemplateName = ref('新品跑量模板');
const player = ref<HTMLVideoElement | null>(null);
const createNameInput = ref<HTMLInputElement | null>(null);
const dialogTrigger = ref<HTMLElement | null>(null);
let controller: AbortController | undefined;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let noticeTimer: ReturnType<typeof setTimeout> | undefined;
let pendingSave: Promise<boolean> | undefined;

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
const selectedSlot = computed(() => {
  const slots =
    view.value === 'EDITOR' && selectedVariant.value
      ? selectedVariant.value.slots
      : (workspace.value?.template.slots ?? []);
  return slots.find(({ id }) => id === activeUi.value?.selectedSlotId) ?? slots[0] ?? null;
});
const templateTiming = computed(() =>
  effectTemplateMixTiming(workspace.value?.template.slots ?? []),
);
const currentTiming = computed(() => effectTemplateMixTiming(selectedVariant.value?.slots ?? []));
const currentDuration = computed(() => currentTiming.value.duration);
const materialForSlot = (
  slotId: string,
  variant: EffectTemplateMixVariant | null = selectedVariant.value,
): EffectTemplateMixMaterial | null =>
  workspace.value?.materials.find(({ id }) => id === variant?.bindings[slotId]) ?? null;
const selectedMaterial = computed(() =>
  selectedSlot.value ? materialForSlot(selectedSlot.value.id) : null,
);
const filteredMaterials = computed(() => {
  const slot = selectedSlot.value;
  if (!workspace.value || !slot) return [];
  const search = keyword.value.trim().toLocaleLowerCase('zh-CN');
  return workspace.value.materials.filter(
    (item) =>
      item.available &&
      (item.purpose === slot.purpose || item.compatiblePurposes.includes(slot.purpose)) &&
      (!search || (item.name + item.code).toLocaleLowerCase('zh-CN').includes(search)),
  );
});
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
const timelineWidth = computed(() => Math.max(900, currentDuration.value * zoom.value));
const ticks = computed(() => {
  const step = Math.max(5, Math.ceil(currentDuration.value / 50) * 5);
  const values = Array.from(
    { length: Math.ceil(currentDuration.value / step) },
    (_, i) => i * step,
  );
  return [...values, currentDuration.value].filter(
    (value, index, list) => index === 0 || value !== list[index - 1],
  );
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
};
const load = async (): Promise<void> => {
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
const selectTemplate = (id: string): void => {
  activeTemplateId.value = id;
  keyword.value = '';
  resourceTab.value = 'MATERIAL';
  scheduleSave();
};
const addVariant = async (): Promise<void> => {
  if (!workspace.value || !activeUi.value || mutating.value) return;
  if (!(await flushPendingEdits()) || draftRevision.value === null) return;
  const templateId = activeTemplateId.value;
  mutating.value = true;
  try {
    const result = await createEffectTemplateMixVariant(
      props.projectId,
      props.workflowRunId,
      draftRevision.value,
      templateId,
    );
    installWorkspaceData(result.data);
    const entry = catalog.value.find(({ id }) => id === templateId);
    const variant = entry?.workspace.variants.at(-1);
    if (variant && uiByTemplate[templateId]) {
      uiByTemplate[templateId].selectedVariantId = variant.id;
      uiByTemplate[templateId].selectedSlotId = variant.slots[0]?.id ?? '';
    }
    view.value = 'EDITOR';
    saveState.value = 'saved';
    showNotice(
      variant?.conflictSlotIds.length
        ? '工程已创建，但素材不足，请补齐缺口'
        : '已在服务端创建并填充时间轴工程',
      variant?.conflictSlotIds.length ? 'warning' : 'success',
    );
  } catch (error) {
    showNotice(error instanceof Error ? error.message : '创建成片工程失败', 'error');
  } finally {
    mutating.value = false;
  }
};
const enterEditor = (): void => {
  if (workspace.value?.variants.length) view.value = 'EDITOR';
  else void addVariant();
};
const selectVariant = (id: string): void => {
  if (!activeUi.value || !workspace.value) return;
  activeUi.value.selectedVariantId = id;
  activeUi.value.selectedSlotId =
    workspace.value.variants.find((item) => item.id === id)?.slots[0]?.id ?? '';
  playhead.value = 0;
};
const selectSlot = (id: string): void => {
  if (!activeUi.value) return;
  activeUi.value.selectedSlotId = id;
  const position = currentTiming.value.slots.find((item) => item.id === id);
  if (position) seek(position.start);
};
const applyMaterial = (material: EffectTemplateMixMaterial): void => {
  const variant = selectedVariant.value;
  const slot = selectedSlot.value;
  if (!variant || !slot) return;
  if (
    Object.entries(variant.bindings).some(
      ([slotId, id]) => slotId !== slot.id && id === material.id,
    )
  ) {
    showNotice('同一成片不能重复使用同一素材', 'warning');
    return;
  }
  if (material.duration < slot.duration) {
    showNotice('素材短于槽位时长，请先缩短槽位', 'warning');
    return;
  }
  variant.bindings[slot.id] = material.id;
  variant.bindingRevisions[slot.id] = material.artifactRevision;
  variant.offsets[slot.id] = 0;
  if (!variant.manualSlotIds.includes(slot.id)) variant.manualSlotIds.push(slot.id);
  variant.conflictSlotIds = variant.conflictSlotIds.filter((id) => id !== slot.id);
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
const moveProjectSlot = (targetId: string): void => {
  if (!selectedVariant.value || !draggedSlotId.value) return;
  const from = selectedVariant.value.slots.findIndex(({ id }) => id === draggedSlotId.value);
  const to = selectedVariant.value.slots.findIndex(({ id }) => id === targetId);
  if (from < 0 || to < 0 || from === to) return;
  const [slot] = selectedVariant.value.slots.splice(from, 1);
  selectedVariant.value.slots.splice(to, 0, slot!);
  draggedSlotId.value = '';
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
  selectedSlot.value.duration = duration;
  bump();
};
const changeTransition = (transition: EffectTemplateMixTransition): void => {
  if (!selectedSlot.value) return;
  selectedSlot.value.transition = transition;
  bump();
};
const refill = async (): Promise<void> => {
  if (!workspace.value || !selectedVariant.value || mutating.value) return;
  if (!(await flushPendingEdits()) || draftRevision.value === null) return;
  const templateId = activeTemplateId.value;
  const variantId = selectedVariant.value.id;
  mutating.value = true;
  try {
    const result = await refillEffectTemplateMixVariant(
      props.projectId,
      props.workflowRunId,
      draftRevision.value,
      templateId,
      variantId,
    );
    installWorkspaceData(result.data);
    if (uiByTemplate[templateId]) uiByTemplate[templateId].selectedVariantId = variantId;
    const variant = catalog.value
      .find(({ id }) => id === templateId)
      ?.workspace.variants.find(({ id }) => id === variantId);
    saveState.value = 'saved';
    showNotice(
      variant?.conflictSlotIds.length
        ? '服务端重新填充完成，仍有素材缺口'
        : '未锁定槽位已由服务端重新填充',
      variant?.conflictSlotIds.length ? 'warning' : 'success',
    );
  } catch (error) {
    showNotice(error instanceof Error ? error.message : '重新填充失败', 'error');
  } finally {
    mutating.value = false;
  }
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
const seek = (raw: number): void => {
  playhead.value = Math.max(0, Math.min(currentDuration.value, raw));
  const index = currentTiming.value.slots.findIndex(
    ({ start, end }) => playhead.value >= start && playhead.value < end,
  );
  const slot =
    selectedVariant.value?.slots[
      index < 0 ? Math.max(0, currentTiming.value.slots.length - 1) : index
    ];
  const range = slot ? currentTiming.value.slots.find(({ id }) => id === slot.id) : undefined;
  if (slot && activeUi.value) activeUi.value.selectedSlotId = slot.id;
  nextTick(() => {
    if (player.value && slot && range && selectedVariant.value)
      player.value.currentTime =
        (selectedVariant.value.offsets[slot.id] ?? 0) + playhead.value - range.start;
  });
};
const togglePlay = async (): Promise<void> => {
  if (!player.value) return;
  if (playing.value) {
    player.value.pause();
    playing.value = false;
    return;
  }
  try {
    await player.value.play();
    playing.value = true;
  } catch {
    showNotice('浏览器未能开始播放，请再次点击', 'warning');
  }
};
const onTime = (): void => {
  if (!player.value || !selectedSlot.value || !selectedVariant.value) return;
  const range = currentTiming.value.slots.find(({ id }) => id === selectedSlot.value?.id);
  if (!range) return;
  playhead.value = Math.min(
    range.end,
    range.start +
      player.value.currentTime -
      (selectedVariant.value.offsets[selectedSlot.value.id] ?? 0),
  );
};
const onEnded = (): void => {
  if (!selectedVariant.value || !selectedSlot.value) return;
  const index = selectedVariant.value.slots.findIndex(({ id }) => id === selectedSlot.value?.id);
  const next = selectedVariant.value.slots[index + 1];
  if (!next) {
    playing.value = false;
    playhead.value = currentDuration.value;
    return;
  }
  const wasPlaying = playing.value;
  if (activeUi.value) activeUi.value.selectedSlotId = next.id;
  playhead.value = currentTiming.value.slots[index + 1]?.start ?? playhead.value;
  nextTick(() => {
    if (wasPlaying && player.value) void player.value.play();
  });
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
  }
};
watch(
  () => [props.projectId, props.workflowRunId],
  () => void load(),
);
watch(selectedMaterial, async () => {
  playing.value = false;
  await nextTick();
  player.value?.load();
});
onMounted(() => {
  window.addEventListener('keydown', onEscape);
  void load();
});
onBeforeUnmount(() => {
  controller?.abort();
  clearTimeout(saveTimer);
  clearTimeout(noticeTimer);
  window.removeEventListener('keydown', onEscape);
  if (saveState.value === 'dirty') void persist(true);
});
defineExpose({ flushPendingEdits });
</script>

<template>
  <section class="mix-node" :aria-busy="pageState === 'LOADING'">
    <Transition name="notice"
      ><div v-if="notice" class="notice" :class="notice.kind" role="status">
        {{ notice.text }}
      </div></Transition
    >
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
              <WandSparkles :size="15" />{{
                workspace.variants.length ? '进入精修工作台' : '智能填充并进入精修'
              }}
            </button>
          </footer>
        </div>
      </section>

      <section
        v-else-if="view === 'EDITOR' && workspace && selectedVariant"
        class="panel workbench"
      >
        <header class="workbench-head">
          <div class="brand">
            <span>AI</span>
            <div><strong>成片精修工作台</strong><small>修改自动保存到当前模板工程</small></div>
          </div>
          <div class="current">
            <b>{{ selectedVariant.name }}</b
            ><span>{{ workspace.template.name }} · {{ currentDuration.toFixed(1) }} 秒</span>
          </div>
          <button
            class="button"
            @click="
              view = 'CONFIG';
              playing = false;
            "
          >
            返回模板配置</button
          ><button class="button primary" :disabled="mutating" @click="openOverwrite">
            更新模板配置
          </button>
        </header>
        <div class="workbench-main">
          <aside class="resources">
            <nav class="resource-tabs">
              <button
                :class="{ active: resourceTab === 'MATERIAL' }"
                @click="resourceTab = 'MATERIAL'"
              >
                <Sparkles :size="14" />素材</button
              ><button :class="{ active: resourceTab === 'AUDIO' }" @click="resourceTab = 'AUDIO'">
                <Music2 :size="14" />音频</button
              ><button :class="{ active: resourceTab === 'TEXT' }" @click="resourceTab = 'TEXT'">
                <Type :size="14" />字幕</button
              ><button
                :class="{ active: resourceTab === 'TRANSITION' }"
                @click="resourceTab = 'TRANSITION'"
              >
                ◇ 转场
              </button>
            </nav>
            <template v-if="resourceTab === 'MATERIAL'"
              ><header>
                <strong>{{
                  selectedSlot ? EFFECT_TEMPLATE_MIX_ROLE_LABELS[selectedSlot.role] : '素材'
                }}</strong
                ><small>{{ filteredMaterials.length }} 条</small>
              </header>
              <label class="search"
                ><Search :size="13" /><input v-model="keyword" placeholder="搜索素材或标签"
              /></label>
              <nav class="slot-tabs">
                <button
                  v-for="(slot, index) in selectedVariant.slots"
                  :key="slot.id"
                  :class="{
                    active: slot.id === selectedSlot?.id,
                    conflict: selectedVariant.conflictSlotIds.includes(slot.id),
                  }"
                  @click="selectSlot(slot.id)"
                >
                  {{ index + 1 }} · {{ EFFECT_TEMPLATE_MIX_ROLE_LABELS[slot.role] }}
                </button>
              </nav>
              <div v-if="filteredMaterials.length" class="material-grid">
                <article
                  v-for="material in filteredMaterials"
                  :key="material.id"
                  :class="{ selected: selectedMaterial?.id === material.id }"
                  @click="applyMaterial(material)"
                >
                  <div class="thumb">
                    <video :src="material.contentUrl" muted preload="metadata" /><Play
                      :size="15"
                    /><small>{{ material.duration.toFixed(1) }}s</small>
                  </div>
                  <b>{{ material.name }}</b
                  ><small
                    >{{ EFFECT_TEMPLATE_MIX_PURPOSE_LABELS[material.purpose] }} ·
                    {{ material.code }}</small
                  >
                </article>
              </div>
              <div v-else class="resource-empty">
                <AlertCircle :size="24" /><b>没有匹配素材</b
                ><span>请回到视频渲染节点确认用途匹配且时长足够的片段。</span>
              </div></template
            >
            <template v-else-if="resourceTab === 'TEXT'"
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
            <template v-else-if="resourceTab === 'TRANSITION'"
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
          <section class="player-panel">
            <header>
              <strong>播放器</strong
              ><span
                >{{ selectedMaterial?.ratio || '画幅未记录' }} ·
                {{ selectedMaterial?.resolution || '分辨率未记录' }}</span
              >
            </header>
            <div class="stage">
              <video
                v-if="selectedMaterial"
                ref="player"
                :src="selectedMaterial.contentUrl"
                playsinline
                preload="metadata"
                @timeupdate="onTime"
                @ended="onEnded"
              />
              <div v-else class="player-empty"><Film :size="34" />当前槽位等待素材</div>
              <div v-if="selectedSlot" class="player-label">
                <span>{{ EFFECT_TEMPLATE_MIX_ROLE_LABELS[selectedSlot.role] }}</span
                ><b>{{ selectedMaterial?.name ?? '素材缺口' }}</b>
              </div>
            </div>
            <input
              :value="playhead"
              type="range"
              min="0"
              :max="currentDuration"
              step=".05"
              @input="seek(Number(($event.target as HTMLInputElement).value))"
            />
            <footer>
              <span
                >{{ formatEffectTemplateMixTime(playhead) }} /
                {{ formatEffectTemplateMixTime(currentDuration) }}</span
              ><button :disabled="!selectedMaterial" @click="togglePlay">
                <Pause v-if="playing" :size="15" /><Play v-else :size="15" /></button
              ><span>顺序预览</span>
            </footer>
          </section>
          <aside class="projects">
            <header>
              <strong>成片项目</strong
              ><button class="button compact" :disabled="mutating" @click="addVariant">
                <Plus :size="13" />新增
              </button>
            </header>
            <div>
              <article
                v-for="(variant, index) in workspace.variants"
                :key="variant.id"
                :class="{ active: variant.id === selectedVariant.id }"
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
            </div>
          </aside>
        </div>
        <div v-if="selectedSlot" class="slot-settings">
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
        <div class="tools">
          <b>时间轴工具</b
          ><button class="tool-pill" :disabled="mutating" @click="refill">
            <Sparkles :size="13" />{{ mutating ? '处理中…' : '重新智能填充' }}</button
          ><button disabled title="字幕自动对齐服务尚未接入">字幕对齐</button
          ><button disabled title="音频节拍服务尚未接入">BGM 卡点</button
          ><span>替换素材或拖动视频片段调整当前工程顺序</span>
          <div>
            <button @click="zoom = Math.max(18, zoom - 5)">－</button
            ><input v-model.number="zoom" type="range" min="18" max="70" /><button
              @click="zoom = Math.min(70, zoom + 5)"
            >
              ＋
            </button>
          </div>
        </div>
        <div class="timeline">
          <div class="ruler" :style="{ width: timelineWidth + 'px' }">
            <span v-for="tick in ticks" :key="tick" :style="{ left: tick * zoom + 'px' }">{{
              formatEffectTemplateMixTime(tick)
            }}</span
            ><i :style="{ left: playhead * zoom + 'px' }" />
          </div>
          <div class="track">
            <label><Film :size="13" />视频轨</label>
            <div class="lane" :style="{ width: timelineWidth + 'px' }">
              <button
                v-for="slot in selectedVariant.slots"
                :key="slot.id"
                :class="{
                  selected: slot.id === selectedSlot?.id,
                  conflict: selectedVariant.conflictSlotIds.includes(slot.id),
                }"
                :style="{ width: slot.duration * zoom + 'px' }"
                draggable="true"
                @dragstart="draggedSlotId = slot.id"
                @dragover.prevent
                @drop.prevent="moveProjectSlot(slot.id)"
                @click="selectSlot(slot.id)"
              >
                <b>{{ materialForSlot(slot.id)?.name ?? '素材缺口' }}</b
                ><small>{{ slot.duration.toFixed(1) }}s</small>
              </button>
            </div>
          </div>
          <div class="track">
            <label><Music2 :size="13" />音频轨</label>
            <div class="lane empty" :style="{ width: timelineWidth + 'px' }">未配置口播音频</div>
          </div>
          <div class="track">
            <label><Type :size="13" />字幕轨</label>
            <div class="lane" :style="{ width: timelineWidth + 'px' }">
              <span
                v-for="caption in selectedVariant.captions"
                :key="caption.id"
                class="caption-clip"
                :style="{
                  marginLeft: caption.start * zoom + 'px',
                  width: (caption.end - caption.start) * zoom + 'px',
                }"
                >{{ caption.text }}</span
              >
            </div>
          </div>
          <div class="track">
            <label><Music2 :size="13" />BGM 轨</label>
            <div class="lane empty" :style="{ width: timelineWidth + 'px' }">未配置 BGM</div>
          </div>
        </div>
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
  padding: 10px 14px;
  border-bottom: 1px solid #e2e8f0;
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
.current {
  text-align: center;
}
.workbench-main {
  display: grid;
  grid-template-columns: 320px minmax(300px, 1fr) 280px;
  height: 400px;
}
.resources {
  display: grid;
  grid-template-rows: auto auto auto 1fr;
  border-right: 1px solid #e2e8f0;
  overflow: hidden;
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
.resources > header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
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
.slot-tabs {
  display: flex;
  gap: 5px;
  overflow: auto;
  padding: 0 12px 8px;
}
.slot-tabs button {
  flex: none;
  padding: 5px 8px;
  color: #64748b;
  background: #fff;
  border: 1px solid #dce5f0;
  border-radius: 15px;
  font-size: 10px;
}
.slot-tabs button.active {
  color: #1d4ed8;
  background: #eff6ff;
  border-color: #93c5fd;
}
.slot-tabs button.conflict {
  color: #b42318;
  border-color: #fda29b;
}
.material-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  overflow: auto;
  padding: 0 12px 12px;
}
.material-grid article {
  display: grid;
  overflow: hidden;
  border: 1px solid #dce5f0;
  border-radius: 8px;
  cursor: pointer;
}
.material-grid article.selected {
  border-color: #2563eb;
  box-shadow: 0 0 0 1px #2563eb;
}
.thumb {
  position: relative;
  height: 72px;
  background: #111827;
}
.thumb video {
  width: 100%;
  height: 100%;
  object-fit: cover;
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
.material-grid article > b,
.material-grid article > small {
  padding: 5px 7px 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 10px;
}
.material-grid article > small {
  padding-bottom: 6px;
  color: #64748b;
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
  display: grid;
  grid-template-rows: auto 1fr auto auto;
  min-width: 0;
  padding: 11px;
  background: #eef2f7;
}
.player-panel > header,
.player-panel > footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: #64748b;
  font-size: 10px;
}
.stage {
  position: relative;
  display: grid;
  place-items: center;
  width: min(100%, 210px);
  min-height: 0;
  margin: 8px auto;
  overflow: hidden;
  background: #111827;
  border-radius: 8px;
}
.stage video {
  width: 100%;
  height: 100%;
  object-fit: contain;
}
.player-empty {
  display: grid;
  place-items: center;
  gap: 8px;
  color: #94a3b8;
}
.player-label {
  position: absolute;
  right: 8px;
  bottom: 8px;
  left: 8px;
  display: grid;
  padding: 18px 8px 8px;
  color: #fff;
  background: linear-gradient(transparent, #000c);
  text-align: center;
}
.player-label span {
  font-size: 9px;
}
.player-panel > input {
  width: 100%;
}
.player-panel footer button {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  color: #fff;
  background: #2563eb;
  border: 0;
  border-radius: 50%;
}
.projects {
  border-left: 1px solid #e2e8f0;
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
.slot-settings,
.tools {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 44px;
  padding: 0 14px;
  border-top: 1px solid #e2e8f0;
  font-size: 11px;
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
.tools button {
  height: 28px;
  background: #fff;
  border: 1px solid #dce5f0;
  border-radius: 6px;
}
.tools > span {
  color: #64748b;
}
.tools > div {
  display: flex;
  margin-left: auto;
}
.tools input {
  width: 80px;
}
.timeline {
  overflow-x: auto;
  background: #fff;
  border-top: 1px solid #dce5f0;
}
.ruler {
  position: relative;
  height: 28px;
  margin-left: 82px;
  border-bottom: 1px solid #cbd5e1;
}
.ruler span {
  position: absolute;
  top: 7px;
  color: #64748b;
  font-size: 9px;
  transform: translateX(-50%);
}
.ruler i {
  position: absolute;
  z-index: 3;
  top: 0;
  height: 235px;
  border-left: 1px solid #ef4444;
}
.track {
  display: flex;
  min-height: 52px;
  border-bottom: 1px solid #edf1f6;
}
.track > label {
  position: sticky;
  left: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 5px;
  width: 82px;
  padding: 0 8px;
  background: #f8fafc;
  border-right: 1px solid #dce5f0;
  font-size: 10px;
}
.lane {
  display: flex;
  align-items: center;
  min-width: 900px;
  background: repeating-linear-gradient(90deg, #fff, #fff 39px, #f1f5f9 40px);
}
.lane > button {
  flex: none;
  box-sizing: border-box;
  height: 38px;
  display: grid;
  overflow: hidden;
  padding: 5px 7px;
  color: #1e3a8a;
  background: #dbeafe;
  border: 1px solid #a7c7f7;
  text-align: left;
}
.lane > button.selected {
  box-shadow: inset 0 0 0 2px #2563eb;
}
.lane > button.conflict {
  color: #991b1b;
  background: #fee2e2;
  border-color: #fca5a5;
}
.lane small {
  font-size: 9px;
}
.empty {
  padding-left: 12px;
  color: #94a3b8;
  font-size: 10px;
}
.caption-clip {
  box-sizing: border-box;
  height: 38px;
  padding: 9px;
  color: #6b21a8;
  background: #f3e8ff;
  border: 1px solid #d8b4fe;
}
.notice {
  position: fixed;
  z-index: 1001;
  top: 18px;
  left: 50%;
  padding: 10px 15px;
  color: #fff;
  background: #15803d;
  border-radius: 8px;
  transform: translateX(-50%);
}
.notice.warning {
  background: #b45309;
}
.notice.error {
  background: #b42318;
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
  .slot-settings,
  .tools {
    flex-wrap: wrap;
    padding: 8px;
  }
}
</style>
