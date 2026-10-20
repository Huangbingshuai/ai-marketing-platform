<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronRight,
  Copy,
  Download,
  Film,
  FolderOpen,
  Image,
  Library,
  Lock,
  Package,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  TriangleAlert,
  Upload,
  UserRound,
} from '@lucide/vue';
import LocalReplaceVisual from './LocalReplaceVisual.vue';
import LocalReplaceDialog from './LocalReplaceDialog.vue';
import {
  ASSETS,
  DIMENSIONS,
  QUALITY,
  STEPS,
  VIDEOS,
  bindAsset,
  createMockDraft,
  draftKey,
  generateMockPrompts,
  regenerateMockPromptField,
  invalidateAfter,
  interruptMockTasks,
  rangeError,
  restoreMockDraft,
  mockArtifactFingerprint,
  mockNodeStatus,
  timecode,
  videoResolution,
  videoRatio,
  rangeTimelineWidth,
  rangeTimelineTicks,
  type Dimension,
  type MockDraft,
  type MockVideo,
} from './local-replace.mock';
import './local-replace.css';
import { seekLocalVideo } from './local-replace-media';

const props = withDefaults(
  defineProps<{ projectId?: string; projectName?: string; preview?: boolean }>(),
  { projectId: '', projectName: '', preview: false },
);
const enabled = ref(props.preview);
const scope = computed(() => props.projectId || 'isolated-preview');
const projectName = computed(() => props.projectName || '广味食品 · 广式腊味夏季投放');
const readDraft = (): MockDraft => {
  try {
    return restoreMockDraft(localStorage.getItem(draftKey(scope.value)));
  } catch {
    return createMockDraft();
  }
};
const draft = reactive(readDraft());
const dimensions = DIMENSIONS;
const assets = computed(() => [...ASSETS, ...draft.importedAssets]);
const assetPreviews = ref<Record<string, string>>({});
const releaseAssetPreviews = (): void => {
  Object.values(assetPreviews.value).forEach((url) => URL.revokeObjectURL(url));
  assetPreviews.value = {};
};
const statusLabel: Record<string, string> = {
  current: '当前节点',
  done: '已完成',
  pending: '待处理',
  failed: '失败',
  warning: '质量预警',
  stale: '待更新',
};
const icon = { person: UserRound, product: Package, scene: Image };
const dim = ref<Dimension>('person');
const dimInfo = computed(() => dimensions.find((d) => d.id === dim.value)!);
const candidateId = ref(draft.bindings.person || '');
const query = ref('');
const tag = ref('');
const candidates = computed(() =>
  assets.value.filter(
    (a) =>
      a.type === dim.value &&
      (!tag.value || a.tags.includes(tag.value)) &&
      `${a.name}${a.tags.join('')}`.includes(query.value),
  ),
);
const candidate = computed(() =>
  assets.value.find((a) => a.id === candidateId.value && a.type === dim.value),
);
const tags = computed(() => [
  ...new Set(assets.value.filter((a) => a.type === dim.value).flatMap((a) => a.tags)),
]);
const count = computed(() => Object.keys(draft.bindings).length);
const error = computed(() => rangeError(draft));
const rangeHint = computed(() =>
  draft.start === 0 && draft.end === 0
    ? '请在视频轨上拖动入点 / 出点，或用播放头设置范围。'
    : error.value,
);
const rangeLabel = computed(() => `${timecode(draft.start)}–${timecode(draft.end)}`);
const rangeLength = computed(() => Math.max(0, draft.end - draft.start));
const duration = computed(() => draft.source?.duration || 32);
const playhead = ref(0);
const playing = ref(false);
const zoom = ref(1);
const timelineWidth = computed(() => rangeTimelineWidth(duration.value, zoom.value));
const timelineTicks = computed(() => rangeTimelineTicks(duration.value));
const progress = ref(0);
const phase = ref('');
const busy = computed(() => [draft.analysis, draft.prompt, draft.render].includes('running'));
const outcome = ref('success');
const toast = ref('');
const modal = ref<'' | 'source' | 'assets' | 'save'>('');
const libraryCandidateId = ref('');
const libraryQuery = ref('');
const libraryCandidates = computed(() =>
  assets.value.filter(
    (a) => a.type === dim.value && `${a.name}${a.tags.join('')}`.includes(libraryQuery.value),
  ),
);
const libraryCandidate = computed(() =>
  libraryCandidates.value.find((a) => a.id === libraryCandidateId.value),
);
const openLibrary = (): void => {
  libraryCandidateId.value = candidateId.value;
  libraryQuery.value = '';
  modal.value = 'assets';
};
const sourceQuery = ref('');
const sourceWorkflow = ref('效果类');
const sourceKind = ref('项目成片');
const sourceProject = ref('');
const sourceId = ref('');
const sourceProjects = computed(() => [
  ...new Set(VIDEOS.filter((v) => v.workflow === sourceWorkflow.value).map((v) => v.project)),
]);
const sourceVideos = computed(() =>
  VIDEOS.filter(
    (v) =>
      v.workflow === sourceWorkflow.value &&
      v.kind === sourceKind.value &&
      (!sourceProject.value || v.project === sourceProject.value) &&
      `${v.name}${v.project}`.includes(sourceQuery.value),
  ),
);
const selectedVideo = computed(() => sourceVideos.value.find((v) => v.id === sourceId.value));
const sourceKinds = computed(() => [
  ...new Set(
    VIDEOS.filter(
      (v) => v.workflow === sourceWorkflow.value && v.project === sourceProject.value,
    ).map((v) => v.kind),
  ),
]);
const sourceProjectCount = computed(() => new Set(VIDEOS.map((v) => v.project)).size);
const projectVideoCount = (project: string, kind: string): number =>
  VIDEOS.filter((v) => v.project === project && v.kind === kind).length;
const selectSourceProject = (project: string): void => {
  sourceProject.value = project;
  const videos = VIDEOS.filter((v) => v.workflow === sourceWorkflow.value && v.project === project);
  sourceKind.value = videos.some((v) => v.kind === sourceKind.value)
    ? sourceKind.value
    : videos[0]?.kind || '项目成片';
  sourceId.value = '';
};
const selectSourceWorkflow = (workflow: string): void => {
  sourceWorkflow.value = workflow;
  selectSourceProject(VIDEOS.find((v) => v.workflow === workflow)?.project || '');
};
const openSource = (): void => {
  const source = VIDEOS.find((v) => v.id === draft.source?.id) || VIDEOS[0]!;
  sourceWorkflow.value = source.workflow;
  sourceProject.value = source.project;
  sourceKind.value = source.kind;
  sourceQuery.value = '';
  sourceId.value = source.id;
  modal.value = 'source';
};
const fileInput = ref<HTMLInputElement>();
const assetInput = ref<HTMLInputElement>();
const localVideoUrl = ref('');
const localVideoElement = ref<HTMLVideoElement | null>(null);
watch(playhead, (seconds) => seekLocalVideo(localVideoElement.value, seconds), { flush: 'sync' });
const syncMediaTime = (event: Event): void => {
  const video = event.currentTarget as HTMLVideoElement;
  if (video !== localVideoElement.value) return;
  playhead.value = Math.min(duration.value, Math.max(0, Math.round(video.currentTime * 10) / 10));
};
const localVideoId = ref('');
const importError = ref('');
const selectedArtifacts = ref<string[]>([]);
const saveTags = ref('局部替换, 广式腊味');
const saveNote = ref('');
let taskTimer: ReturnType<typeof setInterval> | undefined;
let importSequence = 0;
let playTimer: ReturnType<typeof setInterval> | undefined;
let toastTimer: ReturnType<typeof setTimeout> | undefined;
const notify = (message: string): void => {
  toast.value = message;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.value = ''), 3500);
};
const stopTask = (): void => {
  if (taskTimer) clearInterval(taskTimer);
  taskTimer = undefined;
};
const persist = (): void => {
  if (!enabled.value) return;
  try {
    localStorage.setItem(draftKey(scope.value), JSON.stringify(draft));
  } catch {
    notify('浏览器未能保存演示草稿，请检查本地存储空间');
  }
};
watch(draft, persist, { deep: true });
watch(scope, () => {
  importSequence++;
  stopTask();
  pause();
  modal.value = '';
  candidateId.value = '';
  query.value = '';
  tag.value = '';
  releaseVideo();
  releaseAssetPreviews();
  Object.assign(draft, readDraft());
  candidateId.value = draft.bindings[dim.value] || '';
  playhead.value = 0;
});
watch(dim, () => {
  candidateId.value = draft.bindings[dim.value] || '';
  query.value = '';
  tag.value = '';
});
const pause = (): void => {
  localVideoElement.value?.pause();
  playing.value = false;
  if (playTimer) clearInterval(playTimer);
  playTimer = undefined;
};
const releaseVideo = (): void => {
  if (localVideoUrl.value) URL.revokeObjectURL(localVideoUrl.value);
  localVideoUrl.value = '';
  localVideoId.value = '';
};
const togglePlay = async (): Promise<void> => {
  if (playing.value) {
    pause();
    return;
  }
  if (playhead.value >= duration.value) playhead.value = 0;
  const video = localVideoElement.value;
  if (video) {
    seekLocalVideo(video, playhead.value);
    try {
      await video.play();
    } catch {
      if (video === localVideoElement.value) notify('本地视频暂时无法播放，请重新导入可播放的视频');
    }
    return;
  }
  playing.value = true;
  playTimer = setInterval(() => {
    playhead.value = Math.min(duration.value, Math.round((playhead.value + 0.1) * 10) / 10);
    if (playhead.value >= duration.value) pause();
  }, 100);
};
const seek = (event: Event): void => {
  playhead.value = Number((event.target as HTMLInputElement).value);
};
const updateRange = (key: 'start' | 'end', value: number): void => {
  if (busy.value) return;
  const next = Math.round(value * 10) / 10;
  if (draft[key] === next) return;
  draft[key] = next;
  invalidateAfter(draft, 'range');
  candidateId.value = '';
  playhead.value = Number.isFinite(next) ? Math.max(0, Math.min(duration.value, next)) : 0;
};
const chooseSource = (video: MockVideo): void => {
  if (draft.source?.id !== video.id || draft.source.version !== video.version) {
    stopTask();
    pause();
    invalidateAfter(draft, 'source');
    draft.source = { ...video };
    playhead.value = 0;
    candidateId.value = '';
    if (video.id !== localVideoId.value) releaseVideo();
  }
  modal.value = '';
  importError.value = '';
  notify('已选择原成片，素材仅用于当前 Mock 工作台');
};
const importVideo = async (event: Event): Promise<void> => {
  const attempt = ++importSequence;
  const input = event.target as HTMLInputElement,
    file = input.files?.[0];
  input.value = '';
  if (!file) return;
  if (!file.type.startsWith('video/')) {
    importError.value = '请选择可播放的视频文件';
    return;
  }
  const url = URL.createObjectURL(file),
    video = document.createElement('video');
  video.preload = 'metadata';
  video.src = url;
  try {
    const seconds = await new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('无法读取视频时长，请重新选择')), 5000);
      video.onloadedmetadata = () => {
        clearTimeout(timeout);
        resolve(video.duration);
      };
      video.onerror = () => {
        clearTimeout(timeout);
        reject(new Error('该视频格式无法预览，请选择 MP4 或 WebM'));
      };
    });
    if (attempt !== importSequence) {
      URL.revokeObjectURL(url);
      return;
    }
    if (!Number.isFinite(seconds) || seconds < 0.1) throw new Error('视频时长无效');
    releaseVideo();
    localVideoUrl.value = url;
    localVideoId.value = `local-${Date.now()}`;
    chooseSource({
      id: localVideoId.value,
      name: file.name,
      project: projectName.value,
      version: '本地',
      duration: Math.round(seconds * 10) / 10,
      ratio: videoRatio(video.videoWidth, video.videoHeight),
      resolution: `${video.videoWidth} × ${video.videoHeight}`,
      workflow: '当前项目',
      kind: '本地导入',
    });
  } catch (e) {
    URL.revokeObjectURL(url);
    if (attempt === importSequence)
      importError.value = e instanceof Error ? e.message : '视频导入失败';
  }
};
const importAsset = (event: Event): void => {
  const input = event.target as HTMLInputElement,
    file = input.files?.[0];
  input.value = '';
  if (!file) return;
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
    notify('请选择 PNG、JPEG 或 WebP 图片');
    return;
  }
  if (file.size > 20 * 1024 * 1024) {
    notify('图片大小不能超过 20 MB');
    return;
  }
  const id = 'local-asset-' + crypto.randomUUID();
  draft.importedAssets.push({
    id,
    type: dim.value,
    name: file.name,
    version: '本地 v1',
    label: '本地导入',
    variant: 'local',
    fit: 100,
    tags: ['本地导入'],
    local: true,
  });
  assetPreviews.value[id] = URL.createObjectURL(file);
  candidateId.value = id;
  query.value = '';
  tag.value = '';
  notify('已加载当前项目的本地素材预览，请确认替换；文件未上传服务器');
};
const go = (step: number): void => {
  if (busy.value) {
    notify('请等待当前模拟任务完成，或取消任务');
    return;
  }
  if (step > 1 && !draft.source) {
    notify('请先选择成片');
    return;
  }
  if (step > 2 && error.value) {
    notify(error.value);
    return;
  }
  if (step > 3 && (draft.analysis !== 'done' || !count.value)) {
    notify('请先完成范围解析，并确认至少一个替换维度');
    return;
  }
  if (step > 4 && draft.prompt !== 'done') {
    notify('请先生成提示词包');
    return;
  }
  draft.step = step;
  pause();
};
const run = (
  key: 'analysis' | 'prompt' | 'render',
  field?: 'text' | 'composition' | 'negative',
): void => {
  if (busy.value) return;
  if (error.value || !draft.source) {
    notify(error.value);
    return;
  }
  if (key === 'prompt' && (draft.analysis !== 'done' || !count.value)) {
    notify('请先确认替换素材');
    return;
  }
  if (
    key === 'render' &&
    (draft.prompt !== 'done' ||
      ![draft.text, draft.composition, draft.negative].every((t) => t.trim()))
  ) {
    notify('请补齐提示词内容后再渲染');
    return;
  }
  if (key === 'analysis') {
    invalidateAfter(draft, 'range');
    candidateId.value = '';
  }
  if (key === 'prompt' && !field) invalidateAfter(draft, 'binding');
  if (key === 'prompt') draft.promptRegeneration = field ?? null;
  draft[key] = 'running';
  progress.value = 0;
  const phases =
    key === 'analysis'
      ? ['选定范围切片', '人物、产品与场景识别', '范围边界校验']
      : key === 'prompt'
        ? ['聚合时间边界', '绑定资产版本', '锁定范围外结构']
        : ['局部主体跟踪', '画面融合与合成', '范围外一致性校验'];
  phase.value = phases[0]!;
  const expectedOutcome = outcome.value;
  taskTimer = setInterval(() => {
    progress.value = Math.min(100, progress.value + 8);
    phase.value = phases[Math.min(2, Math.floor(progress.value / 34))]!;
    if (progress.value < 100) return;
    stopTask();
    if (expectedOutcome === 'error') {
      draft[key] = field ? 'done' : 'failed';
      draft.promptRegeneration = null;
      notify('模拟任务失败，草稿已保留，可重新执行');
      return;
    }
    if (key === 'prompt') {
      if (field) regenerateMockPromptField(draft, field);
      else generateMockPrompts(draft);
      draft.promptRegeneration = null;
    } else draft[key] = key === 'render' && expectedOutcome === 'warning' ? 'warning' : 'done';
    notify(
      key === 'analysis'
        ? '范围解析已完成'
        : key === 'prompt'
          ? 'Mock 提示词包已生成'
          : draft.render === 'warning'
            ? '存在边缘接缝质量预警，请重新渲染并校验'
            : 'Mock 渲染及质量校验完成',
    );
  }, 150);
};
const cancelTask = (): void => {
  stopTask();
  interruptMockTasks(draft);
  notify('模拟任务已取消，当前草稿已保留');
};
const confirmBinding = (): void => {
  if (bindAsset(draft, dim.value, candidateId.value))
    notify(`已为 ${rangeLabel.value} 绑定${dimInfo.value.name}素材`);
};
const removeBinding = (): void => {
  delete draft.bindings[dim.value];
  candidateId.value = '';
  invalidateAfter(draft, 'binding');
};
const editPrompt = (): void => {
  invalidateAfter(draft, 'prompt');
};
const copyText = async (text: string): Promise<void> => {
  try {
    await navigator.clipboard.writeText(text);
    notify('已复制');
  } catch {
    notify('复制失败，请选中文本手动复制');
  }
};
const download = (kind: 'prompts' | 'manifest' | 'result'): void => {
  const payload = {
    mock: true,
    notice: '前端演示，不包含真实生成视频',
    project: projectName.value,
    workflow: 'FISSION_LOCAL_REPLACE',
    source: draft.source,
    range: { start: draft.start, end: draft.end },
    bindings: draft.bindings,
    ...(kind === 'prompts'
      ? { text: draft.text, composition: draft.composition, negative: draft.negative }
      : {}),
    ...(kind === 'result' ? { quality: QUALITY } : {}),
  };
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }),
  );
  const a = document.createElement('a');
  a.href = url;
  a.download = `局部替换-Mock-${kind}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  notify('已导出 Mock 演示数据；未生成真实视频');
};
const artifactNames = computed(() =>
  draft.step === 1
    ? draft.source
      ? ['原成片素材']
      : []
    : draft.step === 2
      ? !error.value
        ? ['替换时长范围配置']
        : []
      : draft.step === 3
        ? draft.analysis === 'done'
          ? ['范围解析报告', ...(count.value ? ['替换方案', '绑定素材清单'] : [])]
          : []
        : draft.step === 4
          ? draft.prompt === 'done'
            ? ['局部替换 Prompt 包']
            : []
          : ['done', 'warning'].includes(draft.render)
            ? ['素材清单', '质量报告', '替换成片演示记录']
            : [],
);
const artifactTitles = [
  '原成片素材',
  '替换时长范围配置',
  '解析报告与替换方案',
  '局部替换 Prompt 包',
  '替换成片与质量报告',
];
const artifactFingerprint = computed(() => mockArtifactFingerprint(draft));
const currentArchive = computed(() => draft.archives[artifactFingerprint.value]);
const openSave = (): void => {
  selectedArtifacts.value = [...artifactNames.value];
  saveTags.value = currentArchive.value?.tags || draft.savedTags || '局部替换,项目产物';
  saveNote.value = currentArchive.value?.note || draft.savedNote || '用户手动确认入库';
  modal.value = 'save';
};
const saveMock = (): void => {
  draft.savedFingerprint = artifactFingerprint.value;
  draft.savedArtifacts = [...selectedArtifacts.value];
  draft.savedTags = saveTags.value;
  draft.savedNote = saveNote.value;
  draft.archives[artifactFingerprint.value] = {
    names: [...new Set([...(currentArchive.value?.names || []), ...selectedArtifacts.value])],
    tags: saveTags.value,
    note: saveNote.value,
  };
  modal.value = '';
  notify('已保存模拟入库记录，仅保存在当前浏览器演示草稿');
};
const reset = (): void => {
  importSequence++;
  stopTask();
  pause();
  releaseVideo();
  releaseAssetPreviews();
  Object.assign(draft, createMockDraft());
  candidateId.value = '';
  playhead.value = 0;
  notify('已重置当前 Mock 演示');
};
const nodeStatus = (i: number): string => mockNodeStatus(draft, i);
const dragRange = (event: PointerEvent, key: 'start' | 'end'): void => {
  const button = event.currentTarget as HTMLElement,
    lane = button.parentElement!;
  button.setPointerCapture(event.pointerId);
  const move = (e: PointerEvent): void => {
    const box = lane.getBoundingClientRect();
    updateRange(
      key,
      Math.min(duration.value, Math.max(0, ((e.clientX - box.left) / box.width) * duration.value)),
    );
  };
  const end = (): void => {
    button.removeEventListener('pointermove', move);
    button.removeEventListener('pointerup', end);
    button.removeEventListener('pointercancel', end);
  };
  button.addEventListener('pointermove', move);
  button.addEventListener('pointerup', end);
  button.addEventListener('pointercancel', end);
};
defineExpose({
  flushPendingEdits: async () => {
    persist();
    return true;
  },
  workflowRunId: '',
});
onBeforeUnmount(() => {
  importSequence++;
  stopTask();
  pause();
  releaseVideo();
  releaseAssetPreviews();
  if (toastTimer) clearTimeout(toastTimer);
});
</script>

<template>
  <div class="lr-shell">
    <div class="lr-mock-toolbar">
      <span><i />前端 Mock 演示 <small>所有生成、质检与入库均为模拟</small></span>
      <div v-if="enabled">
        <label
          >模拟结果
          <select v-model="outcome" :disabled="busy" aria-label="模拟任务结果">
            <option value="success">成功</option>
            <option value="error">失败</option>
            <option value="warning">质量预警</option>
          </select></label
        ><button class="lr-btn" @click="reset">重置演示</button
        ><button class="lr-btn" :disabled="busy" @click="enabled = false">退出 Mock</button>
      </div>
    </div>
    <section v-if="!enabled" class="lr-panel lr-analysis-empty">
      <Sparkles :size="42" />
      <h2>局部元素替换</h2>
      <p>
        按冻结原型体验完整五步交互。加载示例后可选择成片、设置范围、配置替换素材并查看模拟结果。
      </p>
      <button
        class="lr-btn primary"
        @click="
          enabled = true;
          persist();
        "
      >
        加载 Mock 示例
      </button>
    </section>
    <template v-else>
      <section class="lr-flow uwf-flow">
        <header>
          <div>
            <span>WORKFLOW {{ String(draft.step).padStart(2, '0') }}</span>
            <h2>{{ STEPS[draft.step - 1] }}</h2>
            <p class="lr-flow-description">
              {{
                [
                  '选择需要替换的原始成片',
                  '精确设置连续时间范围',
                  '解析范围主体并配置替换素材',
                  '生成时间范围替换提示词',
                  '一致性校验与结果输出',
                ][draft.step - 1]
              }}
            </p>
          </div>
          <div class="lr-legend">
            <i class="done">✓ 已完成</i><i class="current">● 当前</i><i class="stale">↻ 待更新</i
            ><i class="warning">⚠ 质量预警</i>
          </div>
        </header>
        <div class="lr-nodes uwf-flow-track">
          <template v-for="(step, i) in STEPS" :key="step"
            ><article :class="[nodeStatus(i + 1), 'clickable', 'uwf-flow-node']">
              <button :disabled="busy" @click="go(i + 1)">
                <i
                  ><Check v-if="nodeStatus(i + 1) === 'done'" :size="14" /><template v-else>{{
                    i + 1
                  }}</template></i
                ><span
                  ><b>{{ step }}</b
                  ><small>{{ statusLabel[nodeStatus(i + 1)] }}</small></span
                >
              </button>
            </article>
            <span v-if="i < 4" class="lr-arrow" :class="nodeStatus(i + 1)"
              ><ArrowRight :size="15" /></span
          ></template>
        </div>
      </section>

      <section class="lr-panel">
        <header class="lr-panel-head">
          <div>
            <span>{{ String(draft.step).padStart(2, '0') }}</span>
            <div>
              <h2>
                {{
                  [
                    '选择需要替换的成片',
                    '选择需要替换的时长范围',
                    '选中范围主体解析与替换',
                    '生成时间范围替换提示词',
                    '渲染输出成片',
                  ][draft.step - 1]
                }}
              </h2>
              <p>
                {{
                  [
                    '从全局资产库调用已有成片，或导入一条本地视频。',
                    '在剪辑工作台中定位播放头，再拖动视频轨上的入点与出点。',
                    '将前一步选中的连续时段作为一个整体，只解析人物、产品与场景，不再拆分展示多个镜头。',
                    `把 ${rangeLabel} 内的全部替换维度聚合为一条提示词，并锁定范围外画面。`,
                    `仅渲染 ${rangeLabel} 的替换内容，并校验范围外画面逐帧一致性。`,
                  ][draft.step - 1]
                }}
              </p>
            </div>
          </div>
          <em v-if="draft.step < 3">{{
            draft.step === 1 ? '视频来源' : '视频轨 · 精确到 0.1 秒'
          }}</em>
          <div v-else-if="draft.step === 3">
            <button v-if="draft.analysis === 'done'" class="lr-btn" @click="run('analysis')">
              <RefreshCw :size="14" />重新生成解析结果</button
            ><em
              >{{ rangeLabel }} ·
              {{
                draft.analysis === 'done'
                  ? '解析完成'
                  : draft.analysis === 'running'
                    ? '解析中'
                    : '待解析'
              }}</em
            >
          </div>
          <div v-else-if="draft.step === 4">
            <button class="lr-btn" :disabled="busy" @click="run('prompt')">
              <RefreshCw :size="14" />{{
                draft.prompt === 'done' ? '全部重新生成' : '生成提示词包'
              }}</button
            ><button
              class="lr-btn"
              :disabled="draft.prompt !== 'done'"
              @click="download('prompts')"
            >
              <Download :size="14" />导出
            </button>
          </div>
          <button v-else class="lr-btn primary" :disabled="busy" @click="run('render')">
            <Play :size="14" />{{
              ['done', 'warning', 'stale'].includes(draft.render) ? '重新渲染' : '开始渲染成片'
            }}
          </button>
        </header>

        <div v-if="draft.step === 1" class="lr-source-layout">
          <article v-if="draft.source" class="lr-video-card">
            <div class="lr-video-thumb">
              <Play :size="28" fill="currentColor" /><b>{{ timecode(duration).split('.')[0] }}</b>
            </div>
            <div>
              <small>{{ draft.source.project }} · {{ draft.source.version }}</small>
              <h3>{{ draft.source.name }}</h3>
              <p>
                {{ draft.source.project }} · {{ draft.source.ratio }} ·
                {{ videoResolution(draft.source) }}
              </p>
              <i>食品</i><i>腊味</i><i>{{ draft.source.workflow }}</i>
            </div>
            <strong><CheckCircle2 :size="18" />已选择</strong>
          </article>
          <div v-else class="lr-analysis-empty lr-source-empty">
            <Film :size="36" />
            <h3>尚未选择原成片</h3>
            <p>从资产库选择一条视频，或本地导入。</p>
          </div>
          <aside class="lr-source-actions">
            <button class="lr-btn primary" @click="openSource">
              <Library :size="16" />从资产库选择</button
            ><button class="lr-btn" @click="fileInput?.click()">
              <Upload :size="16" />本地导入视频</button
            ><button
              v-if="draft.source"
              class="lr-clear-source"
              @click="
                draft.source = null;
                invalidateAfter(draft, 'source');
                releaseVideo();
              "
            >
              清除已选成片
            </button>
            <p>更换成片会清空旧解析、替换项和渲染结果。</p>
            <small v-if="draft.source?.version === '本地' && !localVideoUrl"
              >刷新后请重新导入本地视频以恢复播放预览。</small
            >
            <p v-if="importError" role="alert">{{ importError }}</p>
          </aside>
        </div>

        <template v-else-if="draft.step === 2">
          <div class="lr-trim-workbench">
            <header class="lr-trim-topbar">
              <div class="lr-trim-file">
                <i><Film :size="20" /></i
                ><span
                  ><b>{{ draft.source?.name }}</b
                  ><small
                    >{{ draft.source?.project }} · {{ draft.source?.version }} ·
                    {{ draft.source?.ratio }} · {{ videoResolution(draft.source) }}</small
                  ></span
                >
              </div>
              <span class="lr-trim-sync">● 本地 Mock 工程已同步</span
              ><strong :class="{ ready: !error }">{{
                error ? '等待设置入点 / 出点' : rangeLabel
              }}</strong>
            </header>
            <div class="lr-trim-upper">
              <section class="lr-trim-player">
                <header>
                  <b>播放器（画面预览区）</b
                  ><span
                    >{{ draft.source?.ratio }} · {{ videoResolution(draft.source) }} ·
                    原片锁定</span
                  >
                </header>
                <div class="lr-trim-stage">
                  <video
                    v-if="localVideoUrl"
                    ref="localVideoElement"
                    :src="localVideoUrl"
                    controls
                    class="lr-local-video"
                    @loadedmetadata="seekLocalVideo(localVideoElement, playhead)"
                    @timeupdate="syncMediaTime"
                    @play="playing = true"
                    @pause="pause"
                    @ended="pause"
                  />
                  <div
                    v-else-if="draft.source?.kind === '本地导入'"
                    class="lr-local-video-missing"
                    role="status"
                  >
                    <Film :size="36" />
                    <strong>请重新导入本地视频以恢复预览</strong>
                    <span>浏览器刷新后不会保留本地文件；已保存范围和配置。</span>
                    <button class="lr-secondary" @click="fileInput?.click()">重新导入视频</button>
                  </div>
                  <div
                    v-else
                    class="lr-trim-video"
                    :style="{ aspectRatio: draft.source?.ratio.replace(':', ' / ') }"
                  >
                    <span class="visual-window" /><span class="visual-counter" /><span
                      class="visual-person"
                    /><span class="visual-product sausage-box" /><small>{{
                      playhead < 8 ? '还在买又干又柴的腊肠？' : '传统工艺 · 一口岭南味'
                    }}</small
                    ><em>原片预览</em>
                  </div>
                </div>
                <div class="lr-trim-player-controls">
                  <input
                    aria-label="播放位置"
                    type="range"
                    min="0"
                    :max="duration"
                    step="0.1"
                    :value="playhead"
                    @input="seek"
                  />
                  <div>
                    <span>{{ timecode(playhead) }} / {{ timecode(duration) }}</span
                    ><button :aria-label="playing ? '暂停' : '播放'" @click="togglePlay">
                      <Pause v-if="playing" :size="18" /><Play
                        v-else
                        :size="18"
                        fill="currentColor"
                      /></button
                    ><button
                      aria-label="回到开始"
                      @click="
                        playhead = 0;
                        pause();
                      "
                    >
                      <RotateCcw :size="16" /></button
                    ><strong>1x · {{ draft.source?.ratio }}</strong>
                  </div>
                </div>
              </section>
              <aside class="lr-trim-inspector">
                <header>
                  <div>
                    <SlidersHorizontal :size="18" /><span
                      ><b>范围属性</b><small>播放头 {{ timecode(playhead) }}</small></span
                    >
                  </div>
                  <button
                    :disabled="draft.start === 0 && draft.end === 0"
                    @click="
                      updateRange('start', 0);
                      updateRange('end', 0);
                    "
                  >
                    <Trash2 :size="12" />清空
                  </button>
                </header>
                <div class="lr-trim-mark-actions">
                  <button @click="updateRange('start', playhead)">
                    <b>I</b
                    ><span
                      >设为入点<small>{{ timecode(playhead) }}</small></span
                    ></button
                  ><button @click="updateRange('end', playhead)">
                    <b>O</b
                    ><span
                      >设为出点<small>{{ timecode(playhead) }}</small></span
                    >
                  </button>
                </div>
                <div class="lr-trim-time-fields">
                  <label
                    >开始时间
                    <div>
                      <input
                        type="number"
                        aria-label="开始时间"
                        min="0"
                        :max="duration"
                        step="0.1"
                        :value="draft.start"
                        @input="
                          updateRange('start', Number(($event.target as HTMLInputElement).value))
                        "
                      /><small>秒</small>
                    </div></label
                  ><ArrowRight :size="16" /><label
                    >结束时间
                    <div>
                      <input
                        type="number"
                        aria-label="结束时间"
                        min="0"
                        :max="duration"
                        step="0.1"
                        :value="draft.end"
                        @input="
                          updateRange('end', Number(($event.target as HTMLInputElement).value))
                        "
                      /><small>秒</small>
                    </div></label
                  >
                </div>
                <div class="lr-trim-stats">
                  <article>
                    <small>范围时长</small><b>{{ error ? '—' : rangeLength.toFixed(1) + 's' }}</b>
                  </article>
                  <article>
                    <small>原片占比</small
                    ><b>{{ error ? '—' : ((rangeLength / duration) * 100).toFixed(1) + '%' }}</b>
                  </article>
                  <article>
                    <small>涉及镜头</small
                    ><b>{{
                      error
                        ? '—'
                        : Math.ceil(draft.end / (duration / 8)) -
                          Math.floor(draft.start / (duration / 8))
                    }}</b>
                  </article>
                </div>
                <p class="lr-trim-validation" :class="{ ok: !error }">
                  <ShieldCheck :size="15" />{{ rangeHint || '范围有效，可进入解析与素材替换。' }}
                </p>
              </aside>
            </div>
            <div class="lr-trim-timeline-panel">
              <header class="lr-trim-toolbar">
                <span><SlidersHorizontal :size="14" />范围选择</span
                ><button @click="playhead = 0"><RotateCcw :size="12" />回到开始</button><i />
                <p>单击轨道定位播放头，拖动两侧蓝色手柄调整替换范围</p>
                <div>
                  −
                  <input
                    v-model.number="zoom"
                    aria-label="时间轴缩放"
                    type="range"
                    min="1"
                    max="3"
                    step="0.25"
                  />
                  ＋
                </div>
              </header>
              <div class="lr-trim-timeline-scroll">
                <div class="lr-trim-timeline-inner" :style="{ width: `${timelineWidth + 104}px` }">
                  <div class="lr-trim-ruler">
                    <span>时间</span>
                    <div :style="{ width: `${timelineWidth}px` }">
                      <i
                        v-for="tick in timelineTicks"
                        :key="tick"
                        :style="{ left: `${(tick / duration) * 100}%` }"
                        >{{ timecode(tick) }}</i
                      >
                    </div>
                  </div>
                  <div class="lr-trim-track-row">
                    <div class="lr-trim-track-label">
                      <Film :size="18" /><span><b>视频轨</b><small>V1 · 原片</small></span
                      ><em>1</em>
                    </div>
                    <div
                      class="lr-trim-track-lane"
                      :style="{ width: `${timelineWidth}px` }"
                      @click="
                        playhead =
                          Math.round(
                            Math.max(
                              0,
                              Math.min(
                                duration,
                                (($event.clientX -
                                  ($event.currentTarget as HTMLElement).getBoundingClientRect()
                                    .left) /
                                  ($event.currentTarget as HTMLElement).getBoundingClientRect()
                                    .width) *
                                  duration,
                              ),
                            ) * 10,
                          ) / 10
                      "
                    >
                      <div class="lr-trim-video-clip">
                        <div v-for="n in 8" :key="n" class="lr-trim-track-frame">
                          <span class="frame-window" /><span class="frame-person" /><span
                            class="frame-product"
                          /><small>{{
                            n === 1 ? draft.source?.name : timecode(((n - 1) * duration) / 8)
                          }}</small>
                        </div>
                      </div>
                      <div
                        v-if="!error"
                        class="lr-trim-selected"
                        :style="{
                          left: `${(draft.start / duration) * 100}%`,
                          width: `${(rangeLength / duration) * 100}%`,
                        }"
                      >
                        <span>{{ rangeLength.toFixed(1) }}s</span>
                      </div>
                      <button
                        v-for="key in ['start', 'end'] as const"
                        :key="key"
                        class="lr-trim-handle"
                        :class="[key, { overlapping: Math.abs(draft.end - draft.start) < 0.5 }]"
                        :style="{
                          left: `${(Math.max(0, Math.min(duration, draft[key])) / duration) * 100}%`,
                        }"
                        :aria-label="key === 'start' ? '拖动入点' : '拖动出点'"
                        @click.stop
                        @pointerdown.stop="dragRange($event, key)"
                        @keydown.left.prevent="updateRange(key, Math.max(0, draft[key] - 0.1))"
                        @keydown.right.prevent="
                          updateRange(key, Math.min(duration, draft[key] + 0.1))
                        "
                      >
                        <span>{{ key === 'start' ? '入' : '出' }}</span
                        >⋮</button
                      ><i
                        class="lr-playhead"
                        :style="{ left: `${(playhead / duration) * 100}%` }"
                      />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div class="lr-lock-note">
            <Lock :size="22" />
            <div>
              <b>原片结构保护</b>
              <p>镜头顺序、阶段时长、钩子位置、转化点和音效卡点均不会改变。</p>
            </div>
          </div>
        </template>

        <template v-else-if="draft.step === 3">
          <div v-if="draft.analysis !== 'done'" class="lr-analysis-empty">
            <span v-if="draft.analysis === 'running'" class="lr-spinner" /><Film
              v-else
              :size="40"
            />
            <h3>
              {{
                draft.analysis === 'running'
                  ? phase
                  : draft.analysis === 'failed'
                    ? '范围解析未完成'
                    : `准备解析 ${rangeLabel}`
              }}
            </h3>
            <p>
              {{
                draft.analysis === 'running'
                  ? `本地 Mock 正在处理当前成片 · ${progress}%`
                  : draft.analysis === 'failed'
                    ? '模拟解析失败或已取消，当前范围已保留，请重试。'
                    : '系统把所选连续时段作为一个整体，只识别人物、产品和场景三类主体。'
              }}
            </p>
            <i v-if="draft.analysis === 'running'" class="lr-progress"
              ><u :style="{ width: progress + '%' }" /></i
            ><button v-else class="lr-btn primary" @click="run('analysis')">
              {{ draft.analysis === 'failed' ? '重试范围解析' : '开始范围解析' }}</button
            ><button
              v-if="draft.analysis === 'running'"
              class="lr-btn lr-cancel"
              @click="cancelTask"
            >
              取消模拟任务
            </button>
          </div>
          <div v-else class="lr-workbench">
            <section class="lr-timeline-pane lr-range-pane">
              <header>
                <div>
                  <i><Film :size="20" /></i
                  ><span
                    ><b>当前选中范围</b
                    ><small
                      >{{ rangeLabel }} · {{ rangeLength.toFixed(1) }} 秒 · 不拆分镜头</small
                    ></span
                  >
                </div>
                <strong>{{ count }}/3 个主体维度已配置</strong>
              </header>
              <div class="lr-range-aggregate">
                <article>
                  <LocalReplaceVisual class="lr-range-main-visual" :caption="rangeLabel" />
                  <section>
                    <header>
                      <div>
                        <b>范围主体解析结果</b><small>只保留当前范围内的人物、产品、场景对象</small>
                      </div>
                      <span>范围级</span>
                    </header>
                    <div class="lr-range-object-grid">
                      <button
                        v-for="d in dimensions"
                        :key="d.id"
                        :class="{ selected: dim === d.id, bound: draft.bindings[d.id] }"
                        @click="dim = d.id"
                      >
                        <i :style="{ background: d.color }"
                          ><component :is="icon[d.id]" :size="20" /></i
                        ><span
                          ><b>{{ d.name }}</b
                          ><small>{{ d.original }}</small></span
                        ><em>{{ draft.bindings[d.id] ? '已绑定' : '选择替换素材' }}</em>
                      </button>
                    </div>
                    <div class="lr-range-only-note">
                      <Lock :size="15" /><span
                        ><b>严格限定 {{ rangeLabel }}</b
                        ><small>仅解析和替换人物、产品、场景，范围外画面保持不变。</small></span
                      >
                    </div>
                  </section>
                </article>
              </div>
            </section>
            <aside class="lr-inspector lr-library-workspace">
              <div class="lr-selection-strip">
                <header>
                  <div>
                    <i :style="{ background: dimInfo.color }"
                      ><component :is="icon[dim]" :size="19" /></i
                    ><span
                      ><b>替换{{ dimInfo.name }}</b
                      ><small>{{ rangeLabel }} · 作用于选中范围</small></span
                    >
                  </div>
                  <div class="lr-selection-tabs">
                    <button
                      v-for="d in dimensions"
                      :key="d.id"
                      :class="{ selected: dim === d.id, bound: draft.bindings[d.id] }"
                      @click="dim = d.id"
                    >
                      {{ d.name }}
                    </button>
                  </div>
                </header>
                <div class="lr-selection-preview-row">
                  <div class="lr-selection-preview source">
                    <div class="lr-context-contact is-range single">
                      <LocalReplaceVisual :caption="rangeLabel" />
                    </div>
                    <span
                      ><b>原范围{{ dimInfo.name }}</b
                      ><small>保持原片结构与范围边界</small></span
                    >
                  </div>
                  <ArrowRight class="lr-swap" :size="23" />
                  <div class="lr-selection-preview target" :class="{ empty: !candidate }">
                    <LocalReplaceVisual
                      v-if="candidate"
                      :asset="candidate"
                      :preview-url="assetPreviews[candidate.id] || ''"
                    />
                    <div v-else class="lr-selection-empty">
                      <Library :size="25" />从下方选择素材
                    </div>
                    <span
                      ><b>{{ candidate?.name || '待选择替换素材' }}</b
                      ><small>{{
                        candidate ? `${candidate.version} · ${projectName}` : '点击素材卡即可预览'
                      }}</small></span
                    >
                  </div>
                  <div v-if="candidate" class="lr-selection-checks">
                    <i
                      v-for="check in ['素材授权', '画幅与内容适配', '角度、色温与边缘']"
                      :key="check"
                      ><Check :size="12" />{{ check }}（模拟）</i
                    ><button v-if="draft.bindings[dim]" @click="removeBinding">
                      <Trash2 :size="12" />解除绑定
                    </button>
                  </div>
                </div>
              </div>
              <section class="lr-asset-browser">
                <header>
                  <div>
                    <b>{{ dimInfo.name }}素材库</b
                    ><span>{{ candidates.length }} 项可用 · 选择素材后在上方预览</span>
                  </div>
                  <div>
                    <button @click="openLibrary"><FolderOpen :size="13" />全局资产库</button
                    ><button @click="assetInput?.click()"><Upload :size="13" />外部导入</button>
                  </div>
                </header>
                <div class="lr-browser-filters">
                  <label
                    ><Search :size="14" /><input
                      v-model="query"
                      :aria-label="`搜索${dimInfo.name}素材`"
                      placeholder="搜索素材名称或标签" /></label
                  ><select aria-label="素材项目">
                    <option>{{ projectName }}（当前项目）</option></select
                  ><select v-model="tag" aria-label="素材标签">
                    <option value="">全部标签</option>
                    <option v-for="t in tags" :key="t">{{ t }}</option>
                  </select>
                </div>
                <div v-if="candidates.length" class="lr-candidate-grid">
                  <button
                    v-for="a in candidates"
                    :key="a.id"
                    :class="{ selected: candidateId === a.id }"
                    @click="candidateId = a.id"
                  >
                    <LocalReplaceVisual :asset="a" :preview-url="assetPreviews[a.id] || ''" /><span
                      ><b>{{ a.name }}</b
                      ><small>{{ a.version }} · {{ projectName }}</small
                      ><em v-if="draft.bindings[dim] === a.id">已绑定</em></span
                    >
                  </button>
                </div>
                <div v-else class="lr-browser-empty">
                  <Search :size="26" /><b>没有匹配的{{ dimInfo.name }}素材</b>
                  <p>试试其他关键词，或清空筛选条件。</p>
                  <button
                    class="lr-btn"
                    @click="
                      query = '';
                      tag = '';
                    "
                  >
                    清空筛选
                  </button>
                </div>
              </section>
              <footer class="lr-confirm-bar">
                <span>{{
                  candidate ? `已预览：${candidate.name}` : '请选择一项素材进行前后对比'
                }}</span
                ><button class="lr-btn primary" :disabled="!candidate" @click="confirmBinding">
                  {{
                    candidate && draft.bindings[dim] === candidate.id ? '已确认替换' : '确认替换'
                  }}
                </button>
              </footer>
            </aside>
          </div>
        </template>

        <template v-else-if="draft.step === 4">
          <div v-if="draft.prompt === 'done'" class="lr-prompts">
            <section>
              <header>
                <h3>时间范围替换提示词</h3>
                <span>1 条</span>
              </header>
              <article>
                <div>
                  <b
                    >时间范围 {{ rangeLabel }} ·
                    {{
                      dimensions
                        .filter((d) => draft.bindings[d.id])
                        .map((d) => d.name)
                        .join(' / ')
                    }}</b
                  ><span
                    ><button aria-label="复制时间范围替换提示词" @click="copyText(draft.text)">
                      <Copy :size="13" />复制</button
                    ><button aria-label="重新生成时间范围替换提示词" @click="run('prompt', 'text')">
                      <RefreshCw :size="13" />重新生成
                    </button></span
                  >
                </div>
                <textarea
                  v-model="draft.text"
                  aria-label="时间范围替换提示词"
                  @input="editPrompt"
                />
              </article>
            </section>
            <aside>
              <template
                v-for="(title, key) in { composition: '整片合成提示词', negative: '统一负面约束' }"
                :key="key"
                ><label
                  ><b>{{ title }}</b
                  ><span
                    ><button :aria-label="`复制${title}`" @click="copyText(draft[key])">复制</button
                    ><button :aria-label="`重新生成${title}`" @click="run('prompt', key)">
                      <RefreshCw :size="12" />重新生成
                    </button></span
                  ></label
                ><textarea
                  v-model="draft[key]"
                  :class="{ negative: key === 'negative' }"
                  :aria-label="title"
                  @input="editPrompt"
                />
              </template>
            </aside>
          </div>
          <div v-else class="lr-analysis-empty">
            <span v-if="draft.prompt === 'running'" class="lr-spinner" /><Sparkles
              v-else
              :size="40"
            />
            <h3>
              {{
                draft.prompt === 'running'
                  ? '正在生成时间范围替换提示词'
                  : draft.prompt === 'failed'
                    ? '提示词生成未完成'
                    : '素材映射已准备完成'
              }}
            </h3>
            <p>
              {{
                draft.prompt === 'running'
                  ? `${phase} ${progress}%`
                  : draft.prompt === 'failed'
                    ? '模拟任务失败或已取消，替换方案已保留，请重试。'
                    : `${count} 个替换维度将聚合为 1 条时间范围提示词`
              }}
            </p>
            <i v-if="draft.prompt === 'running'" class="lr-progress"
              ><u :style="{ width: progress + '%' }" /></i
            ><button v-else class="lr-btn primary" @click="run('prompt')">
              {{ draft.prompt === 'failed' ? '重试生成' : '开始生成' }}</button
            ><button v-if="draft.prompt === 'running'" class="lr-btn lr-cancel" @click="cancelTask">
              取消模拟任务
            </button>
          </div>
        </template>

        <template v-else>
          <div v-if="draft.render === 'stale'" class="lr-dependency" role="status">
            提示词已修改，已有 Mock 输出待更新。请重新渲染以使用当前内容。
          </div>
          <div class="lr-render-layout">
            <section>
              <article>
                <span>原片</span><Play :size="32" fill="currentColor" /><b>{{
                  draft.source?.name
                }}</b
                ><small
                  >{{ timecode(duration).split('.')[0] }} · {{ draft.source?.ratio }} · 替换范围
                  {{ rangeLabel }}</small
                >
              </article>
              <article :class="{ ready: ['done', 'warning'].includes(draft.render) }">
                <span>替换后</span
                ><Play
                  v-if="['done', 'warning'].includes(draft.render)"
                  :size="32"
                  fill="currentColor"
                /><i v-else>…</i
                ><b>{{
                  ['done', 'warning'].includes(draft.render)
                    ? '局部替换成片_Mock预览'
                    : '等待渲染输出'
                }}</b
                ><small>{{
                  draft.render === 'running' ? phase : '本地 Mock 成片 · 未生成真实视频'
                }}</small>
              </article>
            </section>
            <aside>
              <span v-if="draft.render === 'running'" class="lr-spinner" /><CheckCircle2
                v-else-if="draft.render === 'done'"
                :size="42"
              /><TriangleAlert
                v-else-if="draft.render === 'warning' || draft.render === 'failed'"
                :size="42"
              /><Film v-else :size="42" />
              <h3>
                {{
                  draft.render === 'running'
                    ? phase
                    : draft.render === 'done'
                      ? '成片可交付（模拟）'
                      : draft.render === 'warning'
                        ? '存在质量预警'
                        : draft.render === 'failed'
                          ? '渲染未完成'
                          : '准备生成最终成片'
                }}
              </h3>
              <b v-if="draft.render === 'running'">{{ progress }}%</b
              ><i v-if="draft.render === 'running'" class="lr-progress"
                ><u :style="{ width: progress + '%' }"
              /></i>
              <p v-if="draft.render === 'failed'">模拟渲染失败或已取消，请重试。</p>
              <p v-if="draft.render === 'warning'">边缘接缝未达门槛，请重新渲染并校验。</p>
              <button
                v-if="draft.render === 'running'"
                class="lr-btn lr-cancel"
                @click="cancelTask"
              >
                取消模拟任务
              </button>
            </aside>
          </div>
          <div v-if="['done', 'warning'].includes(draft.render)" class="lr-quality">
            <article
              v-for="q in QUALITY"
              :key="q.name"
              :class="{ warn: draft.render === 'warning' && q.name === '边缘接缝' }"
            >
              <i
                ><TriangleAlert
                  v-if="draft.render === 'warning' && q.name === '边缘接缝'"
                  :size="15" /><Check v-else :size="15" /></i
              ><span
                ><b>{{ q.name }}</b
                ><small>门槛 {{ q.threshold }} · 模拟评分</small></span
              ><strong>{{
                draft.render === 'warning' && q.name === '边缘接缝' ? 82 : q.score
              }}</strong>
            </article>
          </div>
        </template>

        <div class="lr-artifact-bar project-asset-entry">
          <span class="lr-artifact-icon"><Library :size="21" /></span>
          <div>
            <b>{{ artifactTitles[draft.step - 1] }}</b
            ><small
              >{{ projectName }} · {{ props.projectId || '独立演示空间' }} · 裂变类 ·
              局部属性变更存储区</small
            >
          </div>
          <i>{{
            !artifactNames.length
              ? '暂无可入库产物'
              : currentArchive
                ? `已模拟入库 ${currentArchive.names.length}/${artifactNames.length} 项`
                : `待入库 ${artifactNames.length} 项`
          }}</i
          ><button
            class="lr-btn primary"
            :disabled="!artifactNames.length || busy"
            @click="openSave"
          >
            保存到项目资产库
          </button>
        </div>
        <footer class="lr-footer">
          <button v-if="draft.step > 1" class="lr-btn" :disabled="busy" @click="go(draft.step - 1)">
            <ArrowLeft :size="15" />{{ draft.step === 4 ? '返回解析与替换' : '上一步' }}</button
          ><span>{{
            draft.step === 1
              ? '原片结构将在解析后锁定；当前成片将先登记为待入库产物'
              : draft.step === 2
                ? rangeHint || `${rangeLabel} · ${rangeLength.toFixed(1)} 秒`
                : draft.step === 3
                  ? draft.analysis !== 'done'
                    ? '请先完成所选时间范围解析'
                    : `${count} 个主体维度已配置 · ${rangeLabel} · 仅作用于选中范围`
                  : draft.step === 4
                    ? '所有提示词均引用当前选中范围和绑定资产'
                    : draft.render === 'done'
                      ? '模拟质量校验完成'
                      : '尚未完成可交付成片'
          }}</span
          ><button
            v-if="draft.step < 5"
            class="lr-btn primary"
            :disabled="
              busy ||
              (draft.step === 1 && !draft.source) ||
              (draft.step === 2 && !!error) ||
              (draft.step === 3 && (draft.analysis !== 'done' || !count)) ||
              (draft.step === 4 && draft.prompt !== 'done')
            "
            @click="go(draft.step + 1)"
          >
            下一步：{{ STEPS[draft.step] }}<ChevronRight :size="16" />
          </button>
          <div v-else>
            <button
              class="lr-btn"
              :disabled="draft.render !== 'done'"
              @click="download('manifest')"
            >
              <Download :size="15" />素材清单</button
            ><button
              class="lr-btn primary"
              :disabled="draft.render !== 'done'"
              @click="download('result')"
            >
              <Download :size="15" />导出 Mock 结果
            </button>
          </div>
        </footer>
      </section>
    </template>
    <input
      ref="fileInput"
      class="lr-hidden-input"
      type="file"
      accept="video/*"
      aria-label="导入本地视频"
      @change="importVideo"
    />
    <input
      ref="assetInput"
      class="lr-hidden-input"
      type="file"
      accept="image/png,image/jpeg,image/webp"
      aria-label="导入替换素材"
      @change="importAsset"
    />

    <LocalReplaceDialog
      v-if="modal === 'source'"
      title="全局资产库 · 可替换视频"
      description="按工作流真实素材类型隔离：项目成片与渲染视频素材不会混为一类。当前列表均为 Mock 示例。"
      kind="lr-source-library"
      @close="modal = ''"
    >
      <template #header-extra
        ><div class="lr-source-library-count">
          <Film :size="18" /><span
            ><b>{{ sourceProjectCount }}</b
            ><small>个视频项目</small></span
          >
        </div></template
      >
      <main>
        <aside class="lr-source-sidebar">
          <div class="lr-source-side-title"><b>业务工作流</b><small>先选择业务</small></div>
          <div class="lr-source-workflows">
            <button
              v-for="w in ['效果类', '定制类', '裂变类']"
              :key="w"
              :class="{ selected: sourceWorkflow === w }"
              @click="selectSourceWorkflow(w)"
            >
              <i>{{ w[0] }}</i
              ><b>{{ w }}</b
              ><em>{{
                new Set(VIDEOS.filter((v) => v.workflow === w).map((v) => v.project)).size
              }}</em>
            </button>
          </div>
          <div class="lr-source-side-title projects">
            <b>{{ sourceWorkflow }}项目</b><small>{{ sourceProjects.length }} 个</small>
          </div>
          <div class="lr-source-projects">
            <button
              v-for="p in sourceProjects"
              :key="p"
              :class="{ selected: sourceProject === p }"
              @click="selectSourceProject(p)"
            >
              <i><FolderOpen :size="18" /></i
              ><span
                ><b>{{ p }}</b
                ><small
                  >{{ projectVideoCount(p, '项目成片') }} 个项目成片 ·
                  {{ projectVideoCount(p, '渲染视频素材') }} 条渲染素材</small
                ></span
              >
            </button>
          </div>
        </aside>
        <section class="lr-source-results">
          <div class="lr-search">
            <Search :size="16" /><input
              v-model="sourceQuery"
              aria-label="搜索视频"
              placeholder="搜索视频名称、项目、节点或标签"
            /><span>{{ sourceVideos.length }} 条</span>
          </div>
          <div class="lr-modal-kind-tabs" aria-label="视频素材类型">
            <button
              v-for="k in sourceKinds"
              :key="k"
              class="lr-btn"
              :class="{ selected: sourceKind === k }"
              @click="
                sourceKind = k;
                sourceId = '';
              "
            >
              <Film :size="14" />{{ k }}<em>{{ projectVideoCount(sourceProject, k) }}</em>
            </button>
          </div>
          <div v-if="sourceVideos.length" class="lr-source-video-grid">
            <button
              v-for="v in sourceVideos"
              :key="v.id"
              :class="{ selected: sourceId === v.id }"
              @click="sourceId = v.id"
            >
              <div class="lr-source-video-preview theme-food">
                <span class="source-video-scene" /><span class="source-video-person" /><span
                  class="source-video-product"
                /><i><Play :size="20" fill="currentColor" /></i><em>{{ v.kind }}</em
                ><b>{{ timecode(v.duration).split('.')[0] }}</b>
              </div>
              <div class="lr-source-video-meta">
                <header>
                  <strong>{{ v.name }}</strong
                  ><i v-if="sourceId === v.id"><Check :size="13" /></i>
                </header>
                <p>{{ v.project }}</p>
                <small>{{ v.version }} · {{ v.ratio }} · {{ videoResolution(v) }}</small>
                <div>
                  <span>{{ v.workflow }}</span
                  ><span>{{ v.kind === '项目成片' ? '成片输出' : '视频渲染' }}</span
                  ><span>多渠道交付</span>
                </div>
              </div>
            </button>
          </div>
          <div v-else class="lr-browser-empty">
            <Film :size="30" /><b>当前项目暂无已完成视频</b>
            <p>请切换工作流、项目或清空搜索条件。</p>
          </div>
        </section>
      </main>
      <template #footer
        ><span
          ><b>已选择：{{ selectedVideo?.name || '暂无' }}</b
          ><small>{{
            selectedVideo
              ? selectedVideo.project + ' · ' + selectedVideo.version + ' · ' + selectedVideo.kind
              : '请选择一条视频；来源和版本将保留在当前 Mock 草稿中'
          }}</small></span
        ><button class="lr-btn" @click="modal = ''">取消</button
        ><button
          class="lr-btn primary"
          :disabled="!selectedVideo"
          @click="selectedVideo && chooseSource(selectedVideo)"
        >
          使用该视频
        </button></template
      >
    </LocalReplaceDialog>
    <LocalReplaceDialog
      v-if="modal === 'assets'"
      :title="'全局资产库 · ' + dimInfo.name"
      :description="
        '仅展示当前项目的' + dimInfo.name + ' Mock 素材。外部或跨项目资产须先导入当前项目。'
      "
      kind="lr-replace-library"
      @close="modal = ''"
    >
      <template #header-extra
        ><div class="lr-source-library-count">
          <component :is="icon[dim]" :size="18" /><span
            ><b>{{ assets.filter((a) => a.type === dim).length }}</b
            ><small>项隔离资产</small></span
          >
        </div></template
      >
      <main>
        <aside class="lr-source-sidebar">
          <div class="lr-source-side-title"><b>业务空间</b><small>已固定</small></div>
          <div class="lr-replace-space">
            <i>裂</i><span><b>裂变类</b><small>局部元素替换</small></span
            ><Check :size="14" />
          </div>
          <div class="lr-source-side-title projects"><b>项目文件夹</b><small>1 个项目</small></div>
          <div class="lr-source-projects">
            <button class="selected">
              <i><component :is="icon[dim]" :size="18" /></i
              ><span
                ><b>{{ projectName }}</b
                ><small
                  >{{ assets.filter((a) => a.type === dim).length }} 项{{ dimInfo.name }} ·
                  当前项目</small
                ></span
              >
            </button>
          </div>
        </aside>
        <section class="lr-replace-assets">
          <div class="lr-search">
            <Search :size="16" /><input
              v-model="libraryQuery"
              aria-label="搜索资产库素材"
              placeholder="搜索素材名称或标签"
            /><span class="lr-type-lock"><Lock :size="12" />{{ dimInfo.name }}类型已锁定</span
            ><b>{{ libraryCandidates.length }} 项</b>
          </div>
          <div class="lr-library-type-heading">
            <i :style="{ background: dimInfo.color }"><component :is="icon[dim]" :size="16" /></i
            ><span
              ><b>{{ dimInfo.name }}素材</b
              ><small>其他工作流和其他素材类型不会出现在当前列表</small></span
            >
          </div>
          <div v-if="libraryCandidates.length" class="lr-replace-asset-grid">
            <button
              v-for="a in libraryCandidates"
              :key="a.id"
              :class="{ selected: libraryCandidateId === a.id }"
              @click="libraryCandidateId = a.id"
            >
              <LocalReplaceVisual :asset="a" :preview-url="assetPreviews[a.id] || ''" />
              <div>
                <header>
                  <strong>{{ a.name }}</strong
                  ><i v-if="libraryCandidateId === a.id"><Check :size="13" /></i>
                </header>
                <p>{{ a.version }} · {{ projectName }}</p>
                <small>{{
                  a.type === 'person'
                    ? '正侧背三视图 · 主体替换参考'
                    : a.type === 'product'
                      ? '产品外观 · 多角度参考'
                      : '空间光影 · 场景替换参考'
                }}</small
                ><span
                  ><em v-for="t in a.tags" :key="t">{{ t }}</em></span
                >
              </div>
            </button>
          </div>
          <div v-else class="lr-browser-empty">
            <Library :size="28" /><b>当前项目暂无匹配素材</b>
            <p>请尝试其他关键词。</p>
          </div>
        </section>
      </main>
      <template #footer
        ><span
          ><b>{{ libraryCandidate?.name || '尚未选择素材' }}</b
          ><small>{{
            libraryCandidate
              ? projectName + ' · ' + libraryCandidate.version
              : '只能选择当前项目的' + dimInfo.name + '资产'
          }}</small></span
        ><button class="lr-btn" @click="modal = ''">取消</button
        ><button
          class="lr-btn primary"
          :disabled="!libraryCandidate"
          @click="
            candidateId = libraryCandidateId;
            modal = '';
            notify('已选择素材，请在前后对比确认后点击确认替换');
          "
        >
          使用所选素材
        </button></template
      >
    </LocalReplaceDialog>
    <LocalReplaceDialog
      v-if="modal === 'save'"
      title="保存到当前项目资产库"
      :description="`当前项目只读：${projectName} · ${props.projectId || '独立演示空间'}`"
      kind="lr-save-mock"
      @close="modal = ''"
    >
      <template #title-icon
        ><span class="lr-dialog-title-icon"><Library :size="20" /></span
      ></template>
      <div class="lr-save-body">
        <div class="lr-lock-note">
          <Lock :size="20" />
          <div>
            <b>裂变类 / 局部属性变更项目</b>
            <p>Mock 仅记录模拟入库状态，不写入正式资产库。</p>
          </div>
        </div>
        <label
          v-for="name in artifactNames"
          :key="name"
          :class="[
            'lr-save-artifact',
            'lr-artifact-row',
            { selected: selectedArtifacts.includes(name) },
          ]"
          ><input v-model="selectedArtifacts" type="checkbox" :value="name" /><span
            ><b>{{ name }}</b
            ><small>{{ STEPS[draft.step - 1] }} · Mock 演示产物</small></span
          ><i :class="{ saved: currentArchive?.names.includes(name) }">{{
            currentArchive?.names.includes(name) ? '已模拟入库' : '待模拟入库'
          }}</i></label
        >
        <div class="lr-save-fields">
          <label>资产标签<input v-model="saveTags" placeholder="使用逗号分隔" /></label
          ><label>版本说明<input v-model="saveNote" placeholder="请输入本次入库说明" /></label>
        </div>
      </div>
      <template #footer
        ><span>已选择 {{ selectedArtifacts.length }} 项 · 当前浏览器演示记录</span
        ><button class="lr-btn" @click="modal = ''">取消</button
        ><button class="lr-btn primary" :disabled="!selectedArtifacts.length" @click="saveMock">
          确认模拟入库
        </button></template
      >
    </LocalReplaceDialog>
    <Transition name="lr-toast"
      ><div v-if="toast" class="lr-toast" role="status">{{ toast }}</div></Transition
    >
  </div>
</template>
