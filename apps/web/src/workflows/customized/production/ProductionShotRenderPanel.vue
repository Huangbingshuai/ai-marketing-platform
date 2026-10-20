<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { Video, Download, Loader2, Workflow, Settings2, Clock3, Pencil } from '@lucide/vue';
import {
  customizedVideoRenderIssues,
  isCustomizedVideoRenderSettings,
  type ProductionAsset,
  type ProductionShot,
  type CustomizedVideoResult,
  type CustomizedVideoRenderSettings,
  type ProductionTask,
} from '@ai-marketing/contracts';
import { apiUrl } from '../../../api/http-client';
import WorkflowVideoRenderSettings from '../../../platform/workflow/components/WorkflowVideoRenderSettings.vue';
import ProductionAssetVisual from './ProductionAssetVisual.vue';
import ProductionRenderDialog from './ProductionRenderDialog.vue';
import ProductionTaskActivity from './ProductionTaskActivity.vue';
import ProductionTaskFailureFeedback from './ProductionTaskFailureFeedback.vue';
const props = defineProps<{
  projectId: string;
  shot: ProductionShot;
  assets: ProductionAsset[];
  prompt: string;
  locked: boolean;
  editing: boolean;
  index: number;
  unit?: '片段' | '分镜';
  workflowRunId?: string;
  clipId?: string;
  video?: { value: CustomizedVideoResult; revision: number; stale: boolean } | undefined;
  renderTask?: ProductionTask | undefined;
  settings?: CustomizedVideoRenderSettings;
  settingsSaving?: boolean;
  renderSubmitting?: boolean;
  promptReady?: boolean;
  retrying?: boolean;
  retryError?: string | undefined;
}>();
const emit = defineEmits<{
  preview: [asset: ProductionAsset];
  'update-settings': [settings: CustomizedVideoRenderSettings];
  render: [];
  workflow: [task: ProductionTask];
  retry: [taskId: string];
  'edit-duration': [];
}>();
const renderOpen = ref(false);
const controls = ref<HTMLElement>(),
  playerFailed = ref(false);
const active = computed(
  () => !!props.renderTask && ['QUEUED', 'RUNNING'].includes(props.renderTask.status),
);
const mediaUrl = computed(() =>
  props.video && props.workflowRunId && props.clipId
    ? apiUrl(
        `/projects/${encodeURIComponent(props.projectId)}/workflows/customized/production/videos/${encodeURIComponent(props.clipId)}?workflowRunId=${encodeURIComponent(props.workflowRunId)}&revision=${props.video.revision}`,
      )
    : '',
);
const status = computed(() =>
  active.value
    ? props.renderTask?.status === 'QUEUED'
      ? '排队中'
      : '生成中'
    : props.renderTask?.status === 'FAILED'
      ? '生成失败'
      : props.video
        ? props.video.stale
          ? '待更新'
          : '已完成'
        : '待生成',
);
const issues = computed(() => [
  ...(!props.promptReady || !props.prompt.trim() ? ['请先生成或保存本镜提示词'] : []),
  ...(props.assets.some((a) => !a.image)
    ? ['本镜引用的素材尚缺少参考图，请先准备图片或调整引用']
    : []),
  ...(props.settings
    ? customizedVideoRenderIssues(props.settings, props.shot.durationSeconds, props.assets.length)
    : []),
]);
const fractionalDurationHint = computed(() => {
  const seconds = props.shot.durationSeconds;
  if (
    !props.settings ||
    !isCustomizedVideoRenderSettings(props.settings) ||
    !Number.isFinite(seconds) ||
    Number.isInteger(seconds) ||
    !customizedVideoRenderIssues(props.settings, seconds, 0).length
  )
    return null;
  return `当前模型仅支持整数秒，当前${props.clipId ? '分镜' : '片段'}为${seconds}秒。${
    props.clipId
      ? '请点击上方时长，在「分镜参数」的「分镜时长（秒）」中调整。'
      : '请先整理为新版分镜，再核对并调整时长。'
  }`;
});
const disabled = computed(
  () =>
    props.locked ||
    props.settingsSaving ||
    props.renderSubmitting ||
    active.value ||
    !!issues.value.length,
);
watch(mediaUrl, () => {
  playerFailed.value = false;
});
function render() {
  if (!props.workflowRunId || !props.clipId) {
    renderOpen.value = true;
    return;
  }
  if (!disabled.value) emit('render');
}
const referenceImages = computed(() => props.assets.filter((asset) => !!asset.image));
defineExpose({
  open: () => {
    if (props.workflowRunId && props.clipId)
      controls.value?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    else renderOpen.value = true;
  },
});
</script>
<template>
  <aside class="render-panel" aria-label="逐镜渲染">
    <section class="player-card" :aria-busy="active">
      <header>
        <h3>{{ unit ?? '分镜' }} {{ String(index).padStart(2, '0') }}</h3>
        <button
          v-if="renderTask"
          type="button"
          class="render-workflow"
          aria-label="查看当前分镜视频工作流"
          title="查看视频工作流"
          @click="emit('workflow', renderTask)"
        >
          <Workflow :size="13" />
        </button>
        <span class="status" :class="{ active, failed: renderTask?.status === 'FAILED' }"
          ><i />{{ status }}</span
        ><small>{{ video?.value.durationSeconds?.toFixed(1) ?? shot.durationSeconds }}s</small>
      </header>
      <div v-if="mediaUrl" class="video-player">
        <video
          :key="mediaUrl"
          :src="mediaUrl"
          :poster="`${mediaUrl}&poster=1`"
          controls
          playsinline
          preload="metadata"
          @error="playerFailed = true"
        />
        <p v-if="playerFailed" role="alert">暂时无法播放视频，请刷新后重试</p>
        <a :href="`${mediaUrl}&download=1`" download aria-label="下载当前分镜视频"
          ><Download :size="13" />下载视频</a
        >
      </div>
      <div v-else class="player-stage">
        <Loader2 v-if="active" :size="24" class="spinner" />
        <Video v-else :size="24" :stroke-width="1.4" />
        <strong>{{ active ? '正在生成视频' : '暂无视频' }}</strong>
        <span>{{ active ? '生成完成后在此预览' : '生成后在此预览' }}</span>
        <button v-if="!active" type="button" :disabled="disabled" @click="render">生成视频</button>
      </div>
      <ProductionTaskActivity
        class="render-activity"
        :task="renderTask"
        label="当前分镜视频渲染进度"
      />
    </section>
    <footer ref="controls" aria-label="视频配置">
      <header class="configuration-heading">
        <h3><Settings2 :size="14" />视频配置</h3>
        <button
          v-if="clipId"
          type="button"
          class="fixed-duration duration-editor"
          :aria-label="`编辑分镜时长：${shot.durationSeconds}秒`"
          title="打开分镜参数，编辑分镜时长"
          :disabled="locked || settingsSaving || renderSubmitting || active"
          @click="emit('edit-duration')"
        >
          <Clock3 :size="13" /><strong>{{ shot.durationSeconds }}</strong
          ><span>秒</span><Pencil :size="11" />
        </button>
        <span
          v-else
          class="fixed-duration"
          :aria-label="`分镜时长：${shot.durationSeconds}秒，沿用已确认分镜`"
          title="沿用已确认分镜时长"
        >
          <Clock3 :size="13" /><strong>{{ shot.durationSeconds }}</strong
          ><span>秒</span>
        </span>
      </header>
      <WorkflowVideoRenderSettings
        v-if="settings"
        :model-value="settings"
        :disabled="locked || settingsSaving || renderSubmitting || active"
        @update:model-value="emit('update-settings', $event)"
      />
      <small v-if="settingsSaving" role="status">正在保存渲染设置…</small>
      <p
        v-if="!active && (fractionalDurationHint || issues.length) && workflowRunId"
        class="render-hint"
      >
        {{ fractionalDurationHint || issues[0] }}
      </p>
      <ProductionTaskFailureFeedback
        :task="renderTask"
        :disabled="locked || settingsSaving || renderSubmitting"
        :retrying="retrying"
        :retry-error="retryError"
        @workflow="renderTask && emit('workflow', renderTask)"
        @retry="emit('retry', $event)"
      />
      <button
        class="generate-button"
        type="button"
        :disabled="disabled"
        :aria-label="`生成当前${unit ?? '分镜'}视频`"
        @click="render"
      >
        <Loader2 v-if="active || renderSubmitting" :size="14" class="spinner" />{{
          renderSubmitting
            ? '正在提交…'
            : active
              ? '正在生成视频'
              : video
                ? '重新生成视频'
                : '生成视频'
        }}
      </button>
    </footer>
    <div class="inspector-body">
      <section class="bound-section">
        <header>
          <h3>绑定参考图</h3>
          <span class="count">{{ referenceImages.length }}</span>
        </header>
        <div v-if="referenceImages.length" class="reference-strip">
          <button
            v-for="asset in referenceImages"
            :key="asset.id"
            type="button"
            :disabled="!asset.image"
            :title="asset.name"
            :aria-label="`预览绑定图片${asset.name}`"
            @click="$emit('preview', asset)"
          >
            <ProductionAssetVisual :asset="asset" :project-id="projectId" compact /><small>{{
              asset.name
            }}</small>
          </button>
        </div>
        <p v-else>
          {{ assets.length ? '提示词引用的素材尚未准备参考图' : '提示词尚未引用参考图' }}
        </p>
      </section>
    </div>
    <ProductionRenderDialog
      :open="renderOpen"
      type="VIDEO"
      :assets="assets"
      :shot="shot"
      :prompt="prompt"
      @close="renderOpen = false"
    />
  </aside>
</template>
<style scoped>
.render-panel {
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  border-left: 1px solid #e4e9f2;
  background: #f8fafd;
  color: #405674;
}
header {
  display: flex;
  align-items: center;
  gap: 8px;
}
h3 {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
}
.player-card > header {
  padding: 13px 12px;
  border-bottom: 1px solid #e5eaf1;
}
.render-workflow {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  color: #7187ab;
  border: 1px solid #e1e7f1;
  border-radius: 7px;
  background: #fff;
  cursor: pointer;
}
.render-workflow:hover {
  color: #315fd8;
  border-color: #9db7f0;
}
.status {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
  font-size: 10px;
  color: #95a1b2;
}
.status i {
  width: 5px;
  height: 5px;
  background: currentColor;
  border-radius: 50%;
}
.status.active {
  color: #486cce;
}
.status.failed,
.render-error {
  color: #b75b50;
}
.video-player {
  display: grid;
  background: #edf1f7;
}
.render-activity {
  padding: 12px;
  border-bottom: 1px solid #e5eaf1;
}
.video-player video {
  display: block;
  width: 100%;
  max-height: 350px;
  background: #182235;
}
.video-player a {
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
  gap: 5px;
  padding: 9px 12px;
  text-decoration: none;
  color: #4d6f9f;
  font-size: 11px;
}
.render-hint,
.render-error,
.video-player p {
  margin: 0;
  font-size: 11px;
  line-height: 1.7;
  overflow-wrap: anywhere;
}
.render-hint {
  color: #8190a7;
}
.generate-button {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
}
.spinner {
  animation: video-spin 1s linear infinite;
}
@keyframes video-spin {
  to {
    transform: rotate(360deg);
  }
}
header > small {
  color: #9aa5b6;
  font-size: 10px;
}
.player-stage {
  aspect-ratio: 16/9;
  min-height: 160px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 16px;
  background: #eef2f7;
  color: #a0acbd;
  border-bottom: 1px solid #e4e9f1;
}
.player-stage strong {
  font-size: 12px;
  color: #8191a8;
  font-weight: 550;
  margin-top: 3px;
}
.player-stage > span {
  font-size: 10px;
}
button {
  font: inherit;
  cursor: pointer;
}
.player-stage button {
  margin-top: 6px;
  padding: 6px 12px;
  border: 0;
  border-radius: 7px;
  background: #315ff0;
  color: #fff;
  font-size: 11px;
}
.inspector-body {
  flex: 0 1 auto;
  max-height: 240px;
  border-top: 1px solid #e2e8f2;
  min-height: 0;
  overflow-y: auto;
  padding: 16px 14px;
}
.count {
  padding: 2px 6px;
  background: #edf1f7;
  border-radius: 6px;
  color: #91a0b5;
  font-size: 10px;
}
.reference-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}
.reference-strip button {
  padding: 0;
  width: 58px;
  border: 0;
  background: transparent;
  text-align: left;
  color: #8798b0;
}
.reference-strip :deep(.asset-visual) {
  width: 58px;
  height: 44px;
  border: 1px solid #e2e7ef;
  border-radius: 7px;
  box-sizing: border-box;
}
.reference-strip small {
  display: block;
  margin-top: 4px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 9px;
}
.bound-section p {
  color: #9ba7b8;
  font-size: 11px;
  margin-top: 12px;
}
footer {
  display: flex;
  flex-direction: column;
  gap: 14px;
  margin: 12px;
  padding: 14px;
  border: 1px solid #dfe6f0;
  border-radius: 12px;
  background: #fff;
  box-shadow: 0 2px 5px #243b5b04;
}
.configuration-heading {
  justify-content: space-between;
  padding-bottom: 12px;
  border-bottom: 1px solid #edf1f6;
}
.configuration-heading h3 {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
  color: #294566;
}
.configuration-heading h3 svg {
  color: #6f88ac;
}
.fixed-duration {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 5px 8px;
  border: 1px solid #e6ecf4;
  border-radius: 7px;
  background: #f6f8fc;
  font-size: 11px;
  color: #788ba5;
  white-space: nowrap;
}
.fixed-duration strong {
  color: #355477;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.duration-editor {
  cursor: pointer;
}
.duration-editor:hover:not(:disabled) {
  border-color: #aec3e4;
  color: #456fa8;
}
.duration-editor:focus-visible {
  outline: 2px solid #6d95e8;
  outline-offset: 2px;
}
.duration-editor:disabled {
  cursor: default;
  opacity: 0.6;
}
.generate-button {
  width: 100%;
  min-height: 40px;
  padding: 9px 12px;
  border: 0;
  border-radius: 8px;
  background: #315ff0;
  color: white;
  font-size: 12px;
  font-weight: 550;
}
button:disabled {
  cursor: default;
  opacity: 0.5;
}
button:focus-visible,
input:focus-visible {
  outline: 2px solid #4a74e5;
  outline-offset: 2px;
}
</style>
