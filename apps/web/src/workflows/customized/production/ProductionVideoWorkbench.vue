<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { Sparkles, RefreshCw, SlidersHorizontal, Workflow, Loader2 } from '@lucide/vue';
import {
  videoClipProjection,
  videoTaskShot,
  mergeVideoTaskShots,
  type VideoShot,
  videoClipMs,
  videoClipAssetIds,
  videoPromptReferences,
  type ProductionVideoDocument,
  type ProductionWorkspace,
  type ProductionAsset,
  type ProductionClipPrompt,
  type VideoPlan,
  DEFAULT_CUSTOMIZED_VIDEO_RENDER_SETTINGS,
  type CustomizedVideoRenderSettings,
  type ProductionTask,
  type CustomizedVideoSettingsDraft,
} from '@ai-marketing/contracts';
import WorkflowInformationField from '../../../platform/workflow/components/WorkflowInformationField.vue';
import WorkflowInformationDialog from '../../../platform/workflow/components/WorkflowInformationDialog.vue';
import { isAbortError } from '../../../api/http-client';
import { productionApi } from './production.api';
import ProductionShotDirectory from './ProductionShotDirectory.vue';
import ProductionReferenceLibrary from './ProductionReferenceLibrary.vue';
import ProductionShotRenderPanel from './ProductionShotRenderPanel.vue';
import ProductionTaskActivity from './ProductionTaskActivity.vue';
const ProductionPromptEditor = defineAsyncComponent(() => import('./ProductionPromptEditor.vue'));

const props = defineProps<{
  projectId: string;
  workflowRunId: string;
  document: ProductionVideoDocument;
  workspace: ProductionWorkspace;
  editing: boolean;
  locked: boolean;
  dirty: boolean;
  savePlan: () => Promise<boolean>;
}>();
const emit = defineEmits<{
  generate: [clipId: string];
  workflow: [clipId: string];
  refresh: [];
  edit: [];
  preview: [asset: ProductionAsset];
  prepare: [asset: ProductionAsset];
  error: [message: string];
  'save-error': [message: string];
  'update-plan': [plan: VideoPlan];
  'render-started': [task: ProductionTask];
  'render-workflow': [task: ProductionTask];
  'settings-saved': [settings: CustomizedVideoSettingsDraft];
}>();
const selectedClip = ref(''),
  promptText = ref(''),
  promptBase = ref(''),
  saving = ref(false),
  parameters = ref(false);
const panel = ref<{ open: () => void } | null>(null);
const renderSettings = ref<CustomizedVideoRenderSettings>({
  ...DEFAULT_CUSTOMIZED_VIDEO_RENDER_SETTINGS,
});
const renderSettingsBase = ref(''),
  settingsRevision = ref(0),
  settingsSaving = ref(false),
  rendering = ref(false);
let settingsAutosave: ReturnType<typeof setTimeout> | undefined;
const settingsDirty = computed(
  () => JSON.stringify(renderSettings.value) !== renderSettingsBase.value,
);
let controller = new AbortController();
let promptAutosave: ReturnType<typeof setTimeout> | undefined;
const plan = computed(() => props.document.videoPlan);
const clip = computed(
  () => plan.value.clips.find((c) => c.id === selectedClip.value) ?? plan.value.clips[0],
);
const task = computed(() => (clip.value ? videoTaskShot(plan.value, clip.value) : undefined));
const clipPreview = computed(() =>
  clip.value ? videoClipProjection(plan.value, clip.value) : undefined,
);
const directory = computed(() => plan.value.clips.map((c) => videoClipProjection(plan.value, c)));
const prompt = computed(() =>
  props.workspace.prompts.find((p) => 'target' in p.value && p.value.target.id === clip.value?.id),
);
const promptDirty = computed(() => promptText.value !== promptBase.value);
const video = computed(() =>
  props.workspace.videos?.find((v) => v.value.clipId === clip.value?.id),
);
const renderTask = computed(() =>
  props.workspace.tasks.find((t) => t.operation === 'RENDER' && t.target?.id === clip.value?.id),
);
const promptTask = computed(() =>
  props.workspace.tasks.find((t) => t.operation === 'PROMPT' && t.target?.id === clip.value?.id),
);
const generatingPrompt = computed(
  () => !!promptTask.value && ['QUEUED', 'RUNNING'].includes(promptTask.value.status),
);
watch(
  () => clip.value?.id,
  () => {
    clearTimeout(settingsAutosave);
    const saved = props.workspace.videoSettings?.find((s) => s.clipId === clip.value?.id);
    renderSettings.value = { ...(saved?.settings ?? DEFAULT_CUSTOMIZED_VIDEO_RENDER_SETTINGS) };
    settingsRevision.value = saved?.revision ?? 0;
    renderSettingsBase.value = JSON.stringify(renderSettings.value);
  },
  { immediate: true },
);
async function saveSettings(): Promise<boolean> {
  clearTimeout(settingsAutosave);
  if (!settingsDirty.value) return true;
  if (settingsSaving.value || !clip.value || props.locked) return false;
  const scope = controller,
    id = clip.value.id,
    value = { ...renderSettings.value };
  settingsSaving.value = true;
  try {
    const saved = await productionApi.videoSettings(
      props.projectId,
      props.workflowRunId,
      id,
      settingsRevision.value,
      value,
      scope.signal,
    );
    if (scope !== controller || clip.value?.id !== id) return false;
    settingsRevision.value = saved.revision;
    renderSettingsBase.value = JSON.stringify(value);
    emit('settings-saved', saved);
    return true;
  } catch (e) {
    if (!isAbortError(e) && scope === controller)
      emit('error', e instanceof Error ? e.message : '渲染设置保存失败，本地选择保留');
    return false;
  } finally {
    if (scope === controller) settingsSaving.value = false;
  }
}
watch(
  renderSettings,
  () => {
    clearTimeout(settingsAutosave);
    if (settingsDirty.value && !props.locked)
      settingsAutosave = setTimeout(() => void saveSettings(), 600);
  },
  { deep: true },
);
async function renderVideo() {
  if (
    props.locked ||
    rendering.value ||
    !clip.value ||
    !(await saveSettings()) ||
    !(await savePrompt())
  )
    return;
  if ((props.dirty || !props.workspace.shotsConfirmed) && !(await props.savePlan())) return;
  rendering.value = true;
  const scope = controller;
  try {
    await nextTick();
    const created = await productionApi.start(
      props.projectId,
      props.workflowRunId,
      props.workspace.draftRevision,
      'RENDER',
      undefined,
      scope.signal,
      undefined,
      undefined,
      { target: { kind: 'CLIP', id: clip.value.id }, renderSettings: { ...renderSettings.value } },
    );
    if (scope === controller) emit('render-started', created);
  } catch (e) {
    if (scope === controller && !isAbortError(e)) {
      emit('error', e instanceof Error ? e.message : '视频渲染提交失败');
      // The server may have accepted the task before the response was interrupted.
      emit('refresh');
    }
  } finally {
    if (scope === controller) rendering.value = false;
  }
}
const boundAssets = computed(() =>
  clip.value
    ? videoClipAssetIds(plan.value, clip.value)
        .map((id) => props.document.assets.find((a) => a.id === id)!)
        .filter(Boolean)
    : [],
);
const promptAssets = computed(() => {
  const ids = videoPromptReferences(promptText.value, boundAssets.value).assetIds;
  return ids.map((id) => boundAssets.value.find((a) => a.id === id)!);
});
watch(
  () => [props.projectId, props.workflowRunId],
  () => {
    controller.abort();
    controller = new AbortController();
    clearTimeout(promptAutosave);
    saving.value = false;
    settingsSaving.value = false;
    rendering.value = false;
    clearTimeout(settingsAutosave);
    selectedClip.value = '';
    parameters.value = false;
  },
);
watch(
  () => [clip.value?.id, prompt.value?.revision],
  (next, previous) => {
    if (saving.value) return;
    // Do not overwrite a newer edit when an earlier save's status arrives late.
    if (previous && next[0] === previous[0] && promptDirty.value) return;
    promptText.value = prompt.value?.value.content ?? '';
    promptBase.value = promptText.value;
  },
  { immediate: true },
);
async function savePrompt(automatic = false): Promise<boolean> {
  clearTimeout(promptAutosave);
  if (!promptDirty.value) return true;
  if (props.locked || saving.value || !clip.value || !promptText.value.trim()) return false;
  if (videoPromptReferences(promptText.value, boundAssets.value).unknown.length) {
    if (!automatic) emit('save-error', '请先完成 @素材引用，当前文字已保留');
    return false;
  }
  emit('save-error', '');
  const scope = controller,
    id = clip.value.id,
    content = promptText.value;
  saving.value = true;
  try {
    if ((props.dirty || !props.workspace.shotsConfirmed) && !(await props.savePlan())) return false;
    if (scope !== controller) return false;
    await nextTick();
    const current = plan.value.clips.find((c) => c.id === id);
    if (!current) return false;
    const value: ProductionClipPrompt = {
      target: { kind: 'CLIP', id },
      content,
      assetIds: videoPromptReferences(
        content,
        props.document.assets.filter((a) => videoClipAssetIds(plan.value, current).includes(a.id)),
      ).assetIds,
    };
    const revision =
      props.workspace.prompts.find((p) => 'target' in p.value && p.value.target.id === id)
        ?.revision ?? 0;
    await productionApi.prompt(props.projectId, props.workflowRunId, revision, value, scope.signal);
    if (scope !== controller) return false;
    promptBase.value = content;
    emit('refresh');
    return true;
  } catch (e) {
    if (scope === controller && !isAbortError(e)) {
      emit('error', e instanceof Error ? e.message : '提示词保存失败，本地修改保留');
      emit('save-error', e instanceof Error ? e.message : '提示词自动保存失败，本地修改保留');
    }
    return false;
  } finally {
    if (scope === controller) saving.value = false;
  }
}
watch([promptText, () => props.locked], () => {
  clearTimeout(promptAutosave);
  if (!props.locked && !saving.value && promptDirty.value)
    promptAutosave = setTimeout(() => void savePrompt(true), 900);
});
async function selectClip(id: string) {
  if (!(await saveSettings()) || !(await savePrompt())) return false;
  selectedClip.value = id;
  parameters.value = false;
  return true;
}
async function produce(id: string) {
  if (props.locked || !(await selectClip(id))) return;
  await nextTick();
  panel.value?.open();
}
function mutateTask(change: (task: VideoShot, value: VideoPlan) => void) {
  if (props.locked || !clip.value) return;
  emit('edit');
  const value = mergeVideoTaskShots(plan.value, clip.value.id);
  const current = value.clips.find((c) => c.id === clip.value!.id)!;
  const item = value.shots.find((s) => s.id === current.shotIds[0]);
  if (!item) return;
  change(item, value);
  current.title = item.title;
  current.startState = item.startState;
  current.endState = item.endState;
  emit('update-plan', value);
}
function updateTask(
  key:
    | 'visual'
    | 'title'
    | 'information'
    | 'shotType'
    | 'angle'
    | 'cameraMovement'
    | 'framing'
    | 'atmosphere'
    | 'audio',
  value: string,
) {
  mutateTask((s) => {
    s[key] = value;
  });
}
function toggleBinding(asset: ProductionAsset) {
  mutateTask((s) => {
    if (s.bindings.some((b) => b.assetId === asset.id))
      s.bindings = s.bindings.filter((b) => b.assetId !== asset.id);
    else s.bindings.push({ assetId: asset.id, description: '' });
  });
}
function updateBinding(assetId: string, value: string) {
  mutateTask((s) => {
    const binding = s.bindings.find((b) => b.assetId === assetId);
    if (binding) binding.description = value;
  });
}
function addShot() {
  if (props.locked) return;
  const scene = plan.value.scenes[0];
  if (!scene) {
    emit('error', '请先生成分镜，再补充分镜任务');
    return;
  }
  const value = JSON.parse(JSON.stringify(plan.value)) as VideoPlan,
    id = crypto.randomUUID(),
    clipId = crypto.randomUUID();
  value.shots.push({
    id,
    title: '新分镜',
    shotType: '近景',
    cameraMovement: '固定',
    durationSeconds: 4,
    visual: '',
    audio: '',
    atmosphere: '',
    information: '',
    framing: '',
    angle: '平视',
    startState: '',
    endState: '',
    sourceEventIds: [],
    bindings: [],
  });
  value.clips.push({
    id: clipId,
    title: '新分镜',
    sceneId: scene.id,
    shotIds: [id],
    startState: '',
    endState: '',
    transition: '',
  });
  emit('edit');
  emit('update-plan', value);
  selectedClip.value = clipId;
}
function duration(value: number) {
  if (Number.isFinite(value) && value > 0)
    mutateTask((s) => {
      s.durationSeconds = value;
    });
}

onBeforeUnmount(() => {
  clearTimeout(settingsAutosave);
  clearTimeout(promptAutosave);
  controller.abort();
});
defineExpose({
  flushPendingEdits: async () => (await saveSettings()) && (await savePrompt()),
  hasDirty: computed(() => promptDirty.value || settingsDirty.value),
  addShot,
});
</script>
<template>
  <div class="video-v2">
    <ProductionShotDirectory
      :shots="directory"
      :assets="document.assets"
      :selected-id="clip?.id ?? ''"
      :locked="locked || saving"
      :videos="workspace.videos ?? []"
      :render-tasks="workspace.tasks"
      :project-id="projectId"
      :workflow-run-id="workflowRunId"
      unit="分镜"
      @select="selectClip"
      @produce="produce"
    />
    <main v-if="clip && task && clipPreview" class="clip-editor">
      <header class="clip-heading">
        <div>
          <small>当前分镜</small>
          <h3>{{ clip.title }}</h3>
        </div>
        <span>{{ videoClipMs(plan, clip) / 1000 }} 秒</span>
      </header>
      <div class="shot-composition">
        <section class="shot-copy">
          <header>
            <h3>分镜描述</h3>
            <button :disabled="locked" aria-label="编辑分镜参数" @click="parameters = true">
              <SlidersHorizontal :size="15" />
            </button>
          </header>
          <WorkflowInformationField
            :model-value="task.visual"
            label="画面描述"
            multiline
            :readonly="locked"
            @update:model-value="updateTask('visual', $event)"
          />
          <WorkflowInformationField
            :model-value="task.atmosphere"
            label="氛围"
            multiline
            :readonly="locked"
            @update:model-value="updateTask('atmosphere', $event)"
          />
        </section>
        <ProductionReferenceLibrary
          :project-id="projectId"
          :assets="document.assets"
          :shot="clipPreview"
          :locked="locked"
          @toggle="toggleBinding"
          @preview="emit('preview', $event)"
          @prepare="emit('prepare', $event)"
        />
      </div>
      <section class="prompt-section">
        <header>
          <h3>分镜视频提示词</h3>
          <small v-if="prompt?.stale || dirty">待更新</small>
          <small v-if="saving" role="status">正在自动保存…</small>
          <div>
            <button
              :disabled="locked || saving || !workspace.shotsConfirmed"
              @click="emit('generate', clip.id)"
            >
              <Loader2 v-if="generatingPrompt" :size="13" class="prompt-spinner" />
              <RefreshCw v-else-if="prompt" :size="13" /><Sparkles v-else :size="13" />{{
                generatingPrompt ? '正在生成' : prompt ? '重新生成' : 'AI 生成'
              }}
            </button>
            <button aria-label="查看当前分镜提示词工作流" @click="emit('workflow', clip.id)">
              <Workflow :size="14" />查看工作流
            </button>
          </div>
        </header>
        <ProductionTaskActivity :task="promptTask" label="当前分镜提示词生成进度" />
        <ProductionPromptEditor
          v-model="promptText"
          :project-id="projectId"
          :scope-id="clip.id"
          :assets="boundAssets"
          :readonly="locked || saving"
          @blur="savePrompt()"
        />
      </section>
    </main>
    <ProductionShotRenderPanel
      v-if="clipPreview"
      ref="panel"
      :project-id="projectId"
      :workflow-run-id="workflowRunId"
      :clip-id="clip?.id ?? ''"
      :video="video"
      :render-task="renderTask"
      :settings="renderSettings"
      :settings-saving="settingsSaving"
      :render-submitting="rendering"
      :prompt-ready="!!prompt && (!prompt.stale || promptDirty)"
      :shot="clipPreview"
      :index="plan.clips.findIndex((c) => c.id === clip?.id) + 1"
      :assets="promptAssets"
      :prompt="promptText"
      :locked="locked || saving"
      :editing="true"
      unit="分镜"
      @workflow="emit('render-workflow', $event)"
      @preview="emit('preview', $event)"
      @update-settings="renderSettings = $event"
      @render="renderVideo"
    />
    <WorkflowInformationDialog
      :open="parameters && !!task"
      title="分镜参数"
      @close="parameters = false"
    >
      <div v-if="task" class="parameter-fields">
        <WorkflowInformationField
          v-for="f in [
            { key: 'title', label: '分镜名称' },
            { key: 'information', label: '观看信息' },
            { key: 'shotType', label: '景别' },
            { key: 'angle', label: '观察角度' },
            { key: 'cameraMovement', label: '运镜' },
            { key: 'framing', label: '构图与起落幅' },
            { key: 'audio', label: '环境声与动作音' },
          ] as const"
          :key="f.key"
          :model-value="task[f.key]"
          :label="f.label"
          multiline
          :readonly="locked"
          @update:model-value="updateTask(f.key, $event)"
        />
        <label
          >分镜时长（秒）<input
            :value="task.durationSeconds"
            type="number"
            min="0.1"
            step="0.1"
            :disabled="locked"
            @change="duration(Number(($event.target as HTMLInputElement).value))"
        /></label>
        <WorkflowInformationField
          v-for="b in task.bindings"
          :key="b.assetId"
          :model-value="b.description"
          :label="document.assets.find((a) => a.id === b.assetId)?.name ?? '对象状态'"
          multiline
          :readonly="locked"
          @update:model-value="updateBinding(b.assetId, $event)"
        />
      </div>
    </WorkflowInformationDialog>
  </div>
</template>
<style scoped>
.video-v2 {
  display: grid;
  grid-template-columns: 240px minmax(0, 1fr) 300px;
  gap: 18px;
  align-items: start;
}
.clip-editor {
  min-width: 0;
  border: 1px solid #e1e8f1;
  border-radius: 12px;
  padding: 20px;
  background: #fff;
  color: #405674;
}
.clip-heading,
.shot-copy > header,
.prompt-section > header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.clip-heading h3 {
  margin: 5px 0 0;
  font-size: 17px;
  color: #183252;
}
.clip-heading small,
.clip-heading > span,
.muted {
  font-size: 12px;
  color: #8596ae;
}
.shot-composition {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(200px, 0.8fr);
  gap: 20px;
  margin-top: 20px;
}
.shot-copy {
  min-width: 0;
}
.shot-copy h3,
.prompt-section h3 {
  font-size: 13px;
  margin: 0;
}
.shot-copy > header {
  margin-bottom: 12px;
}
.shot-copy:deep(textarea) {
  min-height: 100px;
  height: auto;
  field-sizing: content;
}
.prompt-section {
  margin-top: 20px;
  border-top: 1px solid #e5ebf4;
  padding-top: 16px;
}
.prompt-spinner {
  animation: prompt-spin 1s linear infinite;
}
@keyframes prompt-spin {
  to {
    transform: rotate(360deg);
  }
}
.prompt-section header > div {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.prompt-section > header {
  flex-wrap: wrap;
  row-gap: 8px;
}
.prompt-section header button {
  white-space: nowrap;
}
.prompt-section header > small {
  color: #c28b24;
  margin-right: auto;
}
.prompt-section textarea {
  box-sizing: border-box;
  width: 100%;
  min-height: 210px;
  margin-top: 12px;
  border: 1px solid #dce4f1;
  border-radius: 9px;
  padding: 14px;
  resize: vertical;
  line-height: 1.9;
  font: inherit;
  font-size: 13px;
  color: #405674;
}
.parameter-fields {
  display: grid;
  gap: 14px;
}
.parameter-fields > label {
  display: grid;
  gap: 8px;
  font-size: 13px;
}
.parameter-fields select[multiple] {
  min-height: 110px;
}
.edit-tools {
  display: flex;
  gap: 8px;
}
button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  border: 1px solid #dae3f0;
  background: #fff;
  border-radius: 7px;
  padding: 7px 10px;
  color: #55749f;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
button:disabled {
  opacity: 0.45;
  cursor: default;
}
input,
select {
  border: 1px solid #dce4f1;
  border-radius: 7px;
  padding: 8px;
  color: #405674;
  background: #fff;
  font: inherit;
}
textarea:focus,
input:focus,
select:focus {
  outline: 2px solid #c6d7ff;
  outline-offset: 1px;
}
@media (min-width: 1750px) {
  .video-v2 {
    grid-template-columns: 280px minmax(0, 1fr) 350px;
  }
}
@media (max-width: 1200px) {
  .video-v2 {
    grid-template-columns: 210px minmax(0, 1fr);
  }
  .video-v2 > :last-of-type {
    grid-column: 2;
  }
  .shot-composition {
    grid-template-columns: 1fr;
  }
}
@media (max-width: 760px) {
  .video-v2 {
    grid-template-columns: 1fr;
  }
  .video-v2 > :last-of-type {
    grid-column: auto;
  }
  .clip-editor {
    padding: 14px;
  }
}
</style>
