<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import {
  Archive,
  AudioLines,
  Captions,
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  FileText,
  Image as ImageIcon,
  Mic2,
  Pause,
  Play,
  RotateCcw,
  Search,
  Sparkles,
  Upload,
  UserRound,
  Video,
  X,
} from '@lucide/vue';
import AvatarDialog from './AvatarDialog.vue';
import AvatarSubtitleSettings from './AvatarSubtitleSettings.vue';
import AvatarTimeline from './AvatarTimeline.vue';
import {
  avatars,
  voices,
  backgrounds,
  clone,
  completeSubtitles,
  completeVideo,
  compositionFingerprint,
  createDemo,
  defaultStyle,
  estimateDuration,
  isCompositionStale,
  isSourceStale,
  restoreDemo,
  splitSubtitle,
  storageKey,
  timeLabel,
  parseSubtitleFile,
  type DemoAsset,
  type SubtitleStyle,
  type Tool,
  type Track,
} from './avatar-mock';
const props = withDefaults(
  defineProps<{ projectId: string; projectName: string; scenario?: string }>(),
  { scenario: 'normal' },
);
const state = ref(
  restoreDemo(localStorage.getItem(storageKey(props.projectId)), props.projectId) ??
    createDemo(props.projectId),
);
const root = ref<HTMLElement>();
const query = ref('');
const page = ref(1);
const busy = ref('');
const progress = ref(0);
const failure = ref('');
const toast = ref('');
const storageError = ref('');
const modal = ref<'export' | 'assets' | 'avatar' | ''>('');
const playhead = ref(0);
const playing = ref(false);
const audition = ref(false);
const selection = ref<string[]>([]);
const selectedTrack = ref<Track>('subtitle');
const importedAvatars = ref<DemoAsset[]>([]);
const importedVoices = ref<DemoAsset[]>([]);
const importedBackgrounds = ref<DemoAsset[]>([]);
const undo = ref<DemoStateSnapshot[]>([]);
const redo = ref<DemoStateSnapshot[]>([]);
type DemoStateSnapshot = ReturnType<typeof clone<typeof state.value>>;
let taskTimer: ReturnType<typeof setInterval> | undefined;
let playTimer: ReturnType<typeof setInterval> | undefined;
let toastTimer: ReturnType<typeof setTimeout> | undefined;
let auditionTimer: ReturnType<typeof setTimeout> | undefined;
const urls = new Set<string>();
let disposed = false;
const avatarList = computed(() => [...avatars, ...importedAvatars.value]);
const voiceList = computed(() => [...voices, ...importedVoices.value]);
const sceneList = computed(() => [...backgrounds, ...importedBackgrounds.value]);
const selectedAvatar = computed(
  () => avatarList.value.find((a) => a.id === state.value.avatarId) ?? avatars[0]!,
);
const selectedVoice = computed(
  () => voiceList.value.find((a) => a.id === state.value.voiceId) ?? voices[0]!,
);
const selectedScene = computed(
  () => sceneList.value.find((a) => a.id === state.value.backgroundId) ?? backgrounds[0]!,
);
const matches = computed(() =>
  props.scenario === 'empty'
    ? []
    : avatarList.value.filter((a) => `${a.name} ${a.tags.join(' ')}`.includes(query.value.trim())),
);
const totalPages = computed(() => Math.max(1, Math.ceil(matches.value.length / 6)));
const pagedAvatars = computed(() => matches.value.slice((page.value - 1) * 6, page.value * 6));
watch(query, () => (page.value = 1));
const generated = computed(() => state.value.status === 'completed');
const stale = computed(() => isSourceStale(state.value));
const compositionStale = computed(() => isCompositionStale(state.value));
const duration = computed(() =>
  generated.value
    ? Math.max(
        estimateDuration(state.value),
        ...Object.values(state.value.tracks)
          .flat()
          .map((c) => c.start + c.duration),
      )
    : estimateDuration(state.value),
);
const activeClip = computed(() =>
  selection.value.length === 1
    ? state.value.tracks[selectedTrack.value].find((c) => c.id === selection.value[0])
    : undefined,
);
const selectedStyle = computed(
  () =>
    activeClip.value?.style ??
    state.value.tracks.subtitle.find((c) => selection.value.includes(c.id))?.style ??
    state.value.style,
);
const subtitle = computed(() =>
  state.value.tracks.subtitle.find(
    (c) => playhead.value >= c.start && playhead.value < c.start + c.duration,
  ),
);
const summary = computed(() =>
  busy.value
    ? `${busy.value} ${progress.value}%`
    : failure.value
      ? '处理失败，可重试'
      : stale.value
        ? '口播来源已变化 · 待更新'
        : compositionStale.value
          ? '合成方案已变化 · 待渲染'
          : generated.value
            ? '数字人口播视频已生成'
            : '等待生成数字人口播视频',
);
const tools: { key: Tool; name: string; icon: typeof UserRound }[] = [
  { key: 'avatar', name: '数字人', icon: UserRound },
  { key: 'voice', name: '音色', icon: AudioLines },
  { key: 'background', name: '背景', icon: ImageIcon },
  { key: 'copy', name: '文案', icon: FileText },
  { key: 'subtitle', name: '字幕', icon: Captions },
];
const assetNames = computed(() => [
  '口播文案',
  '数字人版本引用',
  '音色配置',
  '背景配置',
  '字幕配置',
  ...(generated.value ? ['数字人口播工程', '口播音频', '同步检测报告', '数字人口播成片'] : []),
  ...(state.value.tracks.subtitle.length ? ['同步字幕文件'] : []),
]);
const assetSelection = ref<string[]>([]);
const assetTags = ref('数字人口播, 裂变类');
const assetNote = ref('');
const exportName = ref('数字人口播成片');
const exportFormat = ref('MP4');
const exportResolution = ref('1080P');
const exportRatio = ref('9:16');
const exportSubtitles = ref(true);
const exported = ref(false);
const reference = ref('');
const referenceName = ref('');
const avatarName = ref('');
const avatarTags = ref('带货, 品宣');
const avatarFeedback = ref('');
const avatarVersion = ref(0);
const preset = ref<SubtitleStyle | null>(null);
const icons: Record<string, typeof UserRound> = {
  user: UserRound,
  mic: Mic2,
  search: Search,
  audio: AudioLines,
  image: ImageIcon,
};
const icon = (asset: DemoAsset) => icons[asset.icon] ?? UserRound;
function notify(text: string) {
  toast.value = text;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.value = ''), 3200);
}
function persist() {
  try {
    localStorage.setItem(
      storageKey(props.projectId),
      JSON.stringify({
        ...state.value,
        avatarId: state.value.avatarId.startsWith('import-')
          ? avatars[0]!.id
          : state.value.avatarId,
        voiceId: state.value.voiceId.startsWith('import-') ? voices[0]!.id : state.value.voiceId,
        backgroundId: state.value.backgroundId.startsWith('import-')
          ? backgrounds[0]!.id
          : state.value.backgroundId,
      }),
    );
    storageError.value = '';
  } catch {
    storageError.value = '浏览器草稿保存失败，请导出 Mock 工程保留当前内容';
  }
}
watch(state, persist, { deep: true });
watch(
  () =>
    JSON.stringify([
      state.value.avatarId,
      state.value.voiceId,
      state.value.backgroundId,
      state.value.copy,
      state.value.speed,
      state.value.pitch,
      state.value.scale,
      state.value.opacity,
      state.value.position,
      state.value.style,
      state.value.tracks,
    ]),
  () => {
    state.value.stored = [];
  },
);
function checkpoint() {
  undo.value.push(clone(state.value));
  if (undo.value.length > 30) undo.value.shift();
  redo.value = [];
}
function history(back: boolean) {
  const from = back ? undo : redo;
  const to = back ? redo : undo;
  const snapshot = from.value.pop();
  if (!snapshot) return;
  to.value.push(clone(state.value));
  state.value = clone(snapshot);
  selection.value = [];
}
function choose(tool: Tool) {
  if (busy.value) return;
  state.value.tool = tool;
  selection.value = [];
}
function select(track: Track, id: string, additive = false) {
  if (busy.value) return;
  const sameTrack = selectedTrack.value === track;
  selectedTrack.value = track;
  selection.value =
    additive && sameTrack && track === 'subtitle'
      ? selection.value.includes(id)
        ? selection.value.filter((x) => x !== id)
        : [...selection.value, id]
      : [id];
}
function patchStyle(patch: Partial<SubtitleStyle>) {
  if (busy.value) return;
  checkpoint();
  Object.assign(state.value.style, patch);
  for (const clip of state.value.tracks.subtitle)
    if (selection.value.includes(clip.id))
      clip.style = { ...(clip.style ?? defaultStyle()), ...patch };
}
function remove() {
  checkpoint();
  state.value.tracks[selectedTrack.value] = state.value.tracks[selectedTrack.value].filter(
    (c) => !selection.value.includes(c.id),
  );
  selection.value = [];
}
function split() {
  if (selectedTrack.value !== 'subtitle' || selection.value.length !== 1)
    return notify('请选择一条字幕，在片段内部移动播放头后分割');
  checkpoint();
  if (!splitSubtitle(state.value.tracks.subtitle, selection.value[0]!, playhead.value))
    notify('播放头需位于字幕内部，分割后每段至少 0.25 秒');
}
function stopPlayback() {
  clearInterval(playTimer);
  playTimer = undefined;
  playing.value = false;
}
function togglePlay() {
  if (playing.value) return stopPlayback();
  playing.value = true;
  if (playhead.value >= duration.value) playhead.value = 0;
  playTimer = setInterval(() => {
    playhead.value = Math.min(duration.value, playhead.value + 0.1);
    if (playhead.value >= duration.value) stopPlayback();
  }, 100);
}
function task(label: string, done: () => void | Promise<void>, canFail = false) {
  if (busy.value) return;
  stopPlayback();
  failure.value = '';
  busy.value = label;
  progress.value = 0;
  taskTimer = setInterval(() => {
    progress.value = Math.min(100, progress.value + 8);
    if (progress.value < 100) return;
    clearInterval(taskTimer);
    taskTimer = undefined;
    if (canFail && ['failure', 'partial'].includes(props.scenario)) {
      busy.value = '';
      failure.value =
        props.scenario === 'partial'
          ? '部分片段模拟失败，当前结果未提交，请重试'
          : 'Mock 生成失败，请调整演示状态后重试';
      return;
    }
    void Promise.resolve(done())
      .catch(() => {
        if (!disposed) failure.value = 'Mock 处理失败，请重试';
      })
      .finally(() => {
        if (!disposed) {
          busy.value = '';
          persist();
        }
      });
  }, 120);
}
function generate() {
  if (!state.value.copy.trim()) {
    choose('copy');
    return notify('请先填写口播文案');
  }
  if (props.scenario === 'empty') return notify('请先选择或导入数字人形象');
  checkpoint();
  task(
    '正在生成视频',
    () => {
      completeVideo(state.value);
      selection.value = [];
      playhead.value = 0;
      notify('Mock 视频已生成，可单独生成同步字幕');
    },
    true,
  );
}
function generateSubtitles() {
  if (!generated.value || stale.value) return notify('请先生成最新的数字人口播视频');
  choose('subtitle');
  checkpoint();
  task(
    '正在识别口播',
    () => {
      completeSubtitles(state.value);
      selection.value = [];
      notify('同步字幕已生成');
    },
    true,
  );
}
function render() {
  if (!generated.value) return generate();
  if (stale.value) return notify('口播来源已变化，请先重新生成视频');
  task('正在合成成片', () => {
    state.value.composition = compositionFingerprint(state.value);
    modal.value = 'export';
    exported.value = false;
  });
}
function openAssets() {
  assetSelection.value = assetNames.value.filter((n) => !state.value.stored.includes(n));
  modal.value = 'assets';
}
function closeModal() {
  if (busy.value) return;
  modal.value = '';
}
function saveAssets() {
  task('正在模拟入库', () => {
    state.value.stored = [...new Set([...state.value.stored, ...assetSelection.value])];
    modal.value = '';
    notify('Mock 入库已完成，仅保存本地演示记录');
  });
}
function urlFor(file: File) {
  const url = URL.createObjectURL(file);
  urls.add(url);
  return url;
}
async function importFile(event: Event, kind: Tool | 'reference') {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  if (file.size > 100 * 1024 * 1024) return notify('请选择小于 100MB 的本地预览素材');
  if (kind === 'subtitle') {
    if (!/\.(srt|vtt|ass)$/i.test(file.name)) return notify('请选择 SRT / ASS / VTT 字幕文件');
    const text = await file.text();
    if (disposed) return;
    const cues = parseSubtitleFile(text);
    if (!cues.length) return notify('未识别到有效时间码，请检查 SRT / ASS / VTT 文件');
    checkpoint();
    state.value.tracks.subtitle = cues;
    return;
  }
  if (kind === 'reference') {
    if (!file.type.startsWith('image/')) return notify('请选择图片参考素材');
    reference.value = urlFor(file);
    referenceName.value = file.name;
    avatarName.value = file.name.replace(/\.[^.]+$/, '');
    avatarVersion.value = 0;
    return;
  }
  const isVoice = kind === 'voice';
  if (
    !(isVoice
      ? file.type.startsWith('audio/')
      : file.type.startsWith('image/') || file.type.startsWith('video/'))
  )
    return notify('文件类型不符合当前素材要求');
  const asset: DemoAsset = {
    id: `import-${Date.now()}`,
    name: file.name.replace(/\.[^.]+$/, ''),
    version: 'v1',
    meta: '本地预览 · 刷新后需重新导入',
    tags: ['本地导入'],
    icon: isVoice ? 'audio' : 'image',
    previewUrl: urlFor(file),
    mediaType: file.type.startsWith('video/') ? 'video' : 'image',
    tone: 'white',
  };
  checkpoint();
  if (isVoice) {
    importedVoices.value.push(asset);
    state.value.voiceId = asset.id;
  } else {
    importedBackgrounds.value.push(asset);
    state.value.backgroundId = asset.id;
  }
  notify('已加载本地预览素材，未上传到服务器');
}
function generateAvatar() {
  if (!reference.value || !avatarName.value.trim()) return notify('请上传参考图片并填写数字人名称');
  task(avatarVersion.value ? '正在返修形象' : '正在生成形象', () => {
    avatarVersion.value++;
  });
}
function adoptAvatar() {
  const asset: DemoAsset = {
    id: `import-avatar-${Date.now()}`,
    name: avatarName.value.trim(),
    version: `v${avatarVersion.value}`,
    meta: '参考图 Mock · 本地预览',
    tags: avatarTags.value
      .split(/[,，]/)
      .map((s) => s.trim())
      .filter(Boolean),
    icon: 'user',
    previewUrl: reference.value,
  };
  importedAvatars.value.push(asset);
  state.value.avatarId = asset.id;
  modal.value = '';
  notify('已采用 Mock 形象，参考图仅用于本地预览');
}
function auditionVoice() {
  audition.value = !audition.value;
  clearTimeout(auditionTimer);
  if (audition.value) auditionTimer = setTimeout(() => (audition.value = false), 3000);
}
async function download() {
  task('正在导出工程', async () => {
    try {
      const { default: JSZip } = await import('jszip');
      const zip = new JSZip();
      zip.file(
        'Mock工程.json',
        JSON.stringify(
          {
            mock: true,
            notice: '仅前端演示工程，不包含真实生成的视频或音频',
            export: {
              name: exportName.value,
              format: exportFormat.value,
              resolution: exportResolution.value,
              ratio: exportRatio.value,
            },
            state: state.value,
          },
          null,
          2,
        ),
      );
      if (exportSubtitles.value)
        zip.file(
          '字幕.srt',
          state.value.tracks.subtitle
            .map(
              (c, i) =>
                `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.start + c.duration)}\n${c.text}\n`,
            )
            .join('\n'),
        );
      const blob = await zip.generateAsync({ type: 'blob' });
      if (disposed) return;
      const url = URL.createObjectURL(blob);
      urls.add(url);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${exportName.value.trim() || '数字人口播'}-Mock.zip`;
      link.click();
      exported.value = true;
      notify('Mock 工程包已导出');
    } catch {
      failure.value = 'Mock 工程导出失败，请重试';
    }
  });
}
function srtTime(t: number) {
  return `${String(Math.floor(t / 3600)).padStart(2, '0')}:${String(Math.floor(t / 60) % 60).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')},${String(Math.round((t % 1) * 1000)).padStart(3, '0')}`;
}
function keyboard(event: KeyboardEvent) {
  if (modal.value || busy.value || (event.target as HTMLElement).closest('input,textarea,select'))
    return;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'b') {
    event.preventDefault();
    split();
  } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    history(!event.shiftKey);
  } else if (event.key === 'Delete' && selection.value.length) remove();
}
let subtitleDrag: {
  x: number;
  y: number;
  left: number;
  top: number;
  width: number;
  height: number;
  target: HTMLElement;
} | null = null;
function startSubtitleDrag(e: PointerEvent) {
  if (!subtitle.value) return;
  select('subtitle', subtitle.value.id);
  checkpoint();
  const target = e.currentTarget as HTMLElement;
  const box = target.parentElement!.getBoundingClientRect();
  target.setPointerCapture(e.pointerId);
  const style = subtitle.value.style ?? state.value.style;
  subtitleDrag = {
    x: e.clientX,
    y: e.clientY,
    left: style.positionX,
    top: style.positionY,
    width: box.width,
    height: box.height,
    target,
  };
}
function moveSubtitle(e: PointerEvent) {
  if (!subtitleDrag || !subtitle.value) return;
  const d = subtitleDrag;
  const style = subtitle.value.style ?? defaultStyle();
  style.position = '自定义';
  style.positionX = Math.max(5, Math.min(95, d.left + ((e.clientX - d.x) / d.width) * 100));
  style.positionY = Math.max(5, Math.min(95, d.top + ((e.clientY - d.y) / d.height) * 100));
  subtitle.value.style = style;
}
const previewStyle = computed(() => {
  const s = subtitle.value?.style ?? state.value.style;
  return {
    left: `${s.positionX}%`,
    top: `${s.positionY}%`,
    fontFamily: s.fontFamily,
    fontSize: `${s.fontSize / 3}px`,
    fontWeight: s.fontWeight,
    fontStyle: s.italic ? 'italic' : 'normal',
    textDecoration: s.underline ? 'underline' : 'none',
    color: s.color,
    textShadow: `0 1px 2px ${s.outlineColor}`,
    letterSpacing: `${s.letterSpacing / 3}px`,
    lineHeight: s.lineHeight,
    textAlign: s.textAlign,
    background: s.backgroundEnabled ? s.backgroundColor : 'transparent',
  };
});
const highlighted = computed(() => {
  const text = subtitle.value?.text ?? '';
  const words = (subtitle.value?.style?.highlightWords ?? state.value.style.highlightWords)
    .split(/[,，]/)
    .map((w) => w.trim())
    .filter(Boolean);
  if (!words.length) return [{ text, highlight: false }];
  const escaped = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return text
    .split(new RegExp(`(${escaped.join('|')})`, 'g'))
    .map((text) => ({ text, highlight: words.includes(text) }));
});
watch(
  () => props.scenario,
  () => {
    failure.value = '';
  },
);
defineExpose({
  flushPendingEdits: async () => {
    persist();
    return !storageError.value;
  },
  resumeWorkflowNode: async () => true,
  workflowRunId: 'mock-run-v1',
});
onBeforeUnmount(() => {
  disposed = true;
  persist();
  clearInterval(taskTimer);
  stopPlayback();
  clearTimeout(toastTimer);
  clearTimeout(auditionTimer);
  urls.forEach((url) => URL.revokeObjectURL(url));
});
</script>

<template>
  <div ref="root" class="fas-studio" aria-label="数字人口播自由配置工作台" @keydown="keyboard">
    <header class="fas-topbar">
      <div class="fas-brand">
        <span>AI</span>
        <div>
          <b>数字人口播剪辑工作台</b><small>当前项目 · {{ projectId }}</small>
        </div>
      </div>
      <div class="fas-output-name">
        <b>{{ state.outputId || '未命名数字人口播' }}</b
        ><small>{{ selectedAvatar.name }} · {{ selectedVoice.name }} · {{ duration }}s</small>
      </div>
      <div class="fas-save-state" role="status">
        <i :class="busy ? 'rendering' : state.status" />{{ summary }}
      </div>
      <div class="fas-top-spacer" />
      <button class="fas-btn" :disabled="!!busy" @click="choose('copy')">编辑口播文案</button
      ><button class="fas-btn primary" :disabled="!!busy" @click="generate">
        <Sparkles :size="14" />{{
          busy ? `${progress}%` : generated ? '重新生成视频' : '生成数字人口播视频'
        }}
      </button>
    </header>
    <section class="fas-workspace" :inert="!!busy">
      <aside class="fas-left-panel">
        <nav class="fas-tool-tabs" aria-label="数字人口播配置">
          <button
            v-for="tool in tools"
            :key="tool.key"
            :class="{
              active: state.tool === tool.key,
              locked: tool.key === 'subtitle' && !generated,
            }"
            :disabled="!!busy || (tool.key === 'subtitle' && !generated)"
            @click="choose(tool.key)"
          >
            <component :is="tool.icon" :size="16" /><span>{{ tool.name }}</span
            ><i v-if="tool.key === 'subtitle' && !generated">生成后</i>
          </button>
        </nav>
        <div class="fas-resource-panel">
          <template v-if="state.tool === 'avatar'"
            ><div class="fas-panel-head">
              <div>
                <b>全局数字人资产库</b><small>{{ matches.length }} 个可用 · 支持跨项目复用</small>
              </div>
            </div>
            <label class="fas-search"
              ><Search :size="14" /><input
                v-model="query"
                aria-label="搜索数字人"
                placeholder="按名称搜索数字人"
                :disabled="!!busy"
            /></label>
            <div class="fas-avatar-list">
              <button
                v-for="a in pagedAvatars"
                :key="a.id"
                class="fas-avatar-item"
                :class="{ selected: state.avatarId === a.id }"
                :disabled="!!busy"
                @click="
                  state.avatarId = a.id;
                  selection = [];
                "
              >
                <span class="fas-avatar-face"
                  ><img v-if="a.previewUrl" :src="a.previewUrl" :alt="a.name" /><component
                    :is="icon(a)"
                    v-else
                    :size="22" /></span
                ><span
                  ><b>{{ a.name }}</b
                  ><small>{{ a.tags.join(' · ') }}</small
                  ><em>{{ a.previewUrl ? '本地导入' : '共享资产' }} · {{ a.version }}</em></span
                ><i><Check v-if="state.avatarId === a.id" :size="12" /></i>
              </button>
            </div>
            <div v-if="!matches.length" class="fas-empty">
              没有匹配的数字人资产，请调整检索词或上传参考图。
            </div>
            <div class="fas-pager">
              <button aria-label="上一页" :disabled="page <= 1" @click="page--">
                <ChevronLeft :size="14" /></button
              ><span>{{ page }} / {{ totalPages }}</span
              ><button aria-label="下一页" :disabled="page >= totalPages" @click="page++">
                <ChevronRight :size="14" />
              </button>
            </div>
            <button class="fas-wide-import" :disabled="!!busy" @click="modal = 'avatar'">
              <Upload :size="14" />上传真人参考图生成数字人
            </button></template
          >
          <template v-else-if="state.tool === 'voice'"
            ><div class="fas-panel-head">
              <div><b>音色素材</b><small>选择音色后在右侧调整语速和语调</small></div>
            </div>
            <div class="fas-choice-list">
              <button
                v-for="v in voiceList"
                :key="v.id"
                :class="{ selected: state.voiceId === v.id }"
                :disabled="!!busy"
                @click="state.voiceId = v.id"
              >
                <i><component :is="icon(v)" :size="16" /></i
                ><span
                  ><b>{{ v.name }}</b
                  ><small>{{ v.meta }}</small></span
                ><em><Check v-if="state.voiceId === v.id" :size="14" /></em>
              </button>
            </div>
            <label class="fas-wide-import"
              ><input
                type="file"
                accept="audio/*"
                :disabled="!!busy"
                @change="importFile($event, 'voice')"
              /><Upload :size="14" />人工导入音色 / 口播音频</label
            ></template
          >
          <template v-else-if="state.tool === 'background'"
            ><div class="fas-panel-head">
              <div><b>背景素材</b><small>图片 / 视频均可作为合成背景</small></div>
            </div>
            <div class="fas-background-grid">
              <button
                v-for="scene in sceneList"
                :key="scene.id"
                :class="{ selected: state.backgroundId === scene.id }"
                :disabled="!!busy"
                @click="state.backgroundId = scene.id"
              >
                <i
                  :class="`tone-${scene.tone}`"
                  :style="
                    scene.previewUrl && scene.mediaType !== 'video'
                      ? { backgroundImage: `url(${scene.previewUrl})`, backgroundSize: 'cover' }
                      : {}
                  "
                /><b>{{ scene.name }}</b
                ><small
                  >{{ scene.mediaType === 'video' ? '视频' : '图片' }} · {{ scene.meta }}</small
                >
              </button>
            </div>
            <label class="fas-wide-import"
              ><input
                type="file"
                accept="image/*,video/*"
                :disabled="!!busy"
                @change="importFile($event, 'background')"
              /><Upload :size="14" />人工导入背景图片 / 视频</label
            ></template
          >
          <template v-else-if="state.tool === 'copy'"
            ><div class="fas-panel-head">
              <div>
                <b>口播文案</b
                ><small>{{ state.copy.length }} 字 · 预计 {{ estimateDuration(state) }} 秒</small>
              </div>
            </div>
            <textarea
              v-model="state.copy"
              class="fas-copy-editor"
              aria-label="口播文案"
              placeholder="请输入数字人口播文案…"
              :disabled="!!busy"
            />
            <div class="fas-copy-note">
              文案用于生成口播音频；同步字幕需在视频生成完成后单独生成。
            </div></template
          >
          <template v-else
            ><div class="fas-panel-head">
              <div><b>同步字幕</b><small>先识别口播，再统一配置字幕样式</small></div>
            </div>
            <div v-if="!state.tracks.subtitle.length" class="fas-subtitle-empty">
              <span><Captions :size="24" /></span
              ><b>{{ busy ? '正在识别口播并匹配时间码' : '视频已生成，尚未生成字幕' }}</b>
              <p>系统将根据口播停顿拆分字幕，并自动对齐视频时间轴。</p>
              <div class="fas-mini-progress"><i :style="{ width: `${progress}%` }" /></div>
              <button :disabled="!!busy || stale" @click="generateSubtitles">
                {{ busy ? '生成中…' : '生成同步字幕' }}
              </button>
            </div>
            <template v-else
              ><div class="fas-subtitle-toolbar">
                <span>{{ state.tracks.subtitle.length }} 条字幕</span
                ><button :disabled="!!busy" @click="generateSubtitles">重新生成</button>
              </div>
              <button v-if="preset" class="fas-btn" @click="patchStyle(preset)">
                应用已保存样式预设
              </button>
              <div class="fas-subtitle-list">
                <button
                  v-for="(clip, i) in state.tracks.subtitle"
                  :key="clip.id"
                  :class="{ selected: selection.includes(clip.id) }"
                  @click="
                    select(
                      'subtitle',
                      clip.id,
                      $event.ctrlKey || $event.metaKey || $event.shiftKey,
                    );
                    playhead = clip.start;
                  "
                >
                  <i>{{ i + 1 }}</i
                  ><span
                    ><b>{{ clip.text }}</b
                    ><small
                      >{{ timeLabel(clip.start) }} -
                      {{ timeLabel(clip.start + clip.duration) }}</small
                    ></span
                  >
                </button>
              </div></template
            ><label class="fas-wide-import"
              ><input
                type="file"
                accept=".srt,.ass,.vtt"
                :disabled="!!busy"
                @change="importFile($event, 'subtitle')"
              /><Upload :size="14" />人工导入 SRT / ASS / VTT</label
            ></template
          >
        </div>
      </aside>
      <section class="fas-player-panel">
        <header>
          <b>播放器（画面预览区）</b
          ><span>9:16 竖屏 · 1080P · {{ generated ? '已生成' : '配置预览' }}</span>
        </header>
        <div class="fas-preview-stage">
          <div class="fas-video-frame" :class="`tone-${selectedScene.tone}`">
            <video
              v-if="selectedScene.previewUrl && selectedScene.mediaType === 'video'"
              :src="selectedScene.previewUrl"
              muted
              autoplay
              loop
            /><img
              v-else-if="selectedScene.previewUrl"
              class="fas-background-media"
              :src="selectedScene.previewUrl"
              alt="导入的背景"
            />
            <div class="fas-frame-shade" />
            <span class="fas-frame-badge">{{ state.outputId || '组合预览' }}</span>
            <div
              class="fas-person"
              :style="{
                opacity: state.opacity / 100,
                transform: `translateX(-50%) scale(${state.scale / 100})`,
                left: state.position === '左侧' ? '35%' : state.position === '右侧' ? '65%' : '50%',
              }"
            >
              <img
                v-if="selectedAvatar.previewUrl"
                :src="selectedAvatar.previewUrl"
                :alt="selectedAvatar.name"
              /><strong v-else><component :is="icon(selectedAvatar)" :size="34" /></strong><i />
            </div>
            <div
              v-if="subtitle"
              class="fas-preview-subtitle"
              :class="{ selected: selection.includes(subtitle.id) }"
              :style="previewStyle"
              title="拖动调整字幕位置"
              @pointerdown="startSubtitleDrag"
              @pointermove="moveSubtitle"
              @pointerup="subtitleDrag = null"
              @pointercancel="subtitleDrag = null"
            >
              <template v-for="(part, i) in highlighted" :key="i"
                ><mark v-if="part.highlight" :style="{ color: subtitle.style?.highlightColor }">{{
                  part.text
                }}</mark
                ><span v-else>{{ part.text }}</span></template
              >
            </div>
            <div v-if="busy" class="fas-render-mask">
              <strong>{{ progress }}%</strong><span>{{ busy }}</span>
            </div>
          </div>
        </div>
        <footer class="fas-player-controls">
          <input
            v-model.number="playhead"
            type="range"
            min="0"
            :max="duration"
            step="0.1"
            class="avatar-seek"
            aria-label="播放进度"
          />
          <div>
            <span>{{ timeLabel(playhead) }} / {{ timeLabel(duration) }}</span
            ><button :aria-label="playing ? '暂停' : '播放'" @click="togglePlay">
              <Pause v-if="playing" :size="16" /><Play v-else :size="16" /></button
            ><button
              aria-label="返回开头"
              @click="
                stopPlayback();
                playhead = 0;
              "
            >
              <RotateCcw :size="15" /></button
            ><em>1x · 精剪 · 9:16</em>
          </div>
        </footer>
      </section>
      <aside class="fas-inspector">
        <header>
          <b>{{
            selectedTrack === 'subtitle' && selection.length
              ? '字幕设置'
              : activeClip
                ? '片段属性'
                : '参数配置'
          }}</b
          ><span v-if="selection.length">已选 {{ selection.length }} 条</span>
        </header>
        <div class="fas-inspector-body">
          <template v-if="selection.length && selectedTrack === 'subtitle'"
            ><div class="fas-selected-summary">
              <i class="subtitle">T</i>
              <div>
                <b>{{
                  selection.length === 1 ? activeClip?.title : `已选择 ${selection.length} 条字幕`
                }}</b
                ><small>下方设置将即时覆盖选中字幕</small>
              </div>
            </div>
            <label v-if="activeClip" class="fas-field"
              >字幕文本<textarea
                v-model="activeClip.text"
                rows="3"
                :disabled="!!busy"
                @focus="checkpoint"
              /></label
            ><AvatarSubtitleSettings
              :style-value="selectedStyle"
              :count="selection.length"
              @patch="patchStyle"
              @preset="
                preset = clone(selectedStyle);
                notify('样式预设已保存到当前演示会话');
              "
          /></template>
          <template v-else-if="activeClip"
            ><div class="fas-selected-summary">
              <i :class="selectedTrack"
                ><Video v-if="selectedTrack === 'video'" :size="18" /><AudioLines v-else :size="18"
              /></i>
              <div>
                <b>{{ activeClip.title }}</b
                ><small
                  >{{ timeLabel(activeClip.start) }} ·
                  {{ activeClip.duration.toFixed(2) }} 秒</small
                >
              </div>
            </div>
            <label class="fas-field"
              >片段名称<input v-model="activeClip.title" @focus="checkpoint" /></label
            ><label v-if="activeClip.text" class="fas-field"
              >口播内容<textarea v-model="activeClip.text" rows="4" @focus="checkpoint" />
            </label>
            <div class="fas-two-fields">
              <label class="fas-field"
                >开始时间<input
                  v-model.number="activeClip.start"
                  type="number"
                  min="0"
                  :max="duration - activeClip.duration"
                  step="0.25"
                  @focus="checkpoint" /></label
              ><label class="fas-field"
                >时长（秒）<input
                  v-model.number="activeClip.duration"
                  type="number"
                  min="0.25"
                  :max="duration - activeClip.start"
                  step="0.25"
                  @focus="checkpoint"
              /></label>
            </div>
            <div class="fas-inline-actions">
              <button class="danger" @click="remove">删除片段</button>
            </div></template
          >
          <template v-else-if="state.tool === 'avatar'"
            ><div class="fas-selected-summary">
              <span class="fas-avatar-face"
                ><img
                  v-if="selectedAvatar.previewUrl"
                  :src="selectedAvatar.previewUrl"
                  :alt="selectedAvatar.name" /><UserRound v-else :size="22"
              /></span>
              <div>
                <b>{{ selectedAvatar.name }}</b
                ><small>共享资产 · {{ selectedAvatar.version }}</small>
              </div>
            </div>
            <dl class="fas-meta-list">
              <div>
                <dt>资产范围</dt>
                <dd>全局数字人资产库</dd>
              </div>
              <div>
                <dt>三视图</dt>
                <dd>{{ selectedAvatar.meta }}</dd>
              </div>
              <div>
                <dt>标签</dt>
                <dd>{{ selectedAvatar.tags.join(' / ') }}</dd>
              </div>
              <div>
                <dt>授权状态</dt>
                <dd>Mock 演示授权 · 版本锁定 {{ selectedAvatar.version }}</dd>
              </div>
            </dl></template
          >
          <template v-else-if="state.tool === 'voice'"
            ><div class="fas-selected-summary">
              <i class="audio"><AudioLines :size="18" /></i>
              <div>
                <b>{{ selectedVoice.name }}</b
                ><small>{{ selectedVoice.meta }}</small>
              </div>
            </div>
            <label class="fas-field fas-range"
              >语速<output>{{ state.speed.toFixed(2) }}x</output
              ><input
                v-model.number="state.speed"
                type="range"
                min="0.7"
                max="1.5"
                step="0.05"
                :disabled="!!busy" /></label
            ><label class="fas-field fas-range"
              >语调<output>{{ state.pitch === 0 ? '自然' : state.pitch }}</output
              ><input
                v-model.number="state.pitch"
                type="range"
                min="-5"
                max="5"
                :disabled="!!busy" /></label
            ><button class="avatar-audition" @click="auditionVoice">
              <Pause v-if="audition" :size="20" /><Play v-else :size="20" /><span
                ><b>{{ audition ? '正在试听…' : '试听当前音色' }}</b
                ><small>本地 Mock · 动效示例</small></span
              >
            </button></template
          >
          <template v-else-if="state.tool === 'background'"
            ><div class="fas-selected-summary">
              <i><ImageIcon :size="18" /></i>
              <div>
                <b>{{ selectedScene.name }}</b
                ><small>{{ selectedScene.meta }}</small>
              </div>
            </div>
            <label class="fas-field"
              >数字人位置<select v-model="state.position" :disabled="!!busy">
                <option>居中</option>
                <option>左侧</option>
                <option>右侧</option>
              </select></label
            ><label class="fas-field fas-range"
              >人物缩放<output>{{ state.scale }}%</output
              ><input
                v-model.number="state.scale"
                type="range"
                min="60"
                max="140"
                :disabled="!!busy" /></label
            ><label class="fas-field fas-range"
              >背景融合<output>{{ state.opacity }}%</output
              ><input
                v-model.number="state.opacity"
                type="range"
                min="20"
                max="100"
                :disabled="!!busy"
            /></label>
            <div class="fas-copy-note">仅修改背景与构图，口播文案和音轨保留。</div></template
          >
          <template v-else-if="state.tool === 'copy'"
            ><h4>口播文案配置</h4>
            <div class="fas-copy-note">
              {{ state.copy.length }} 字 · 预计
              {{ estimateDuration(state) }} 秒<br />确认文案后点击上方“生成数字人口播视频”。
            </div>
            <label class="fas-field"
              >音色<select v-model="state.voiceId" :disabled="!!busy">
                <option v-for="voice in voiceList" :key="voice.id" :value="voice.id">
                  {{ voice.name }}
                </option>
              </select></label
            ></template
          >
          <template v-else
            ><div class="fas-copy-note">
              选择左侧字幕或时间轴片段，调整文字、样式与位置。按 Ctrl/⌘ 可多选。
            </div></template
          >
        </div>
      </aside>
    </section>
    <AvatarTimeline
      :tracks="state.tracks"
      :duration="duration"
      :playhead="playhead"
      :selection="selection"
      :can-undo="!!undo.length"
      :can-redo="!!redo.length"
      :generated="generated"
      :busy="!!busy"
      @select="select"
      @select-many="
        selectedTrack = 'subtitle';
        selection = $event;
      "
      @seek="playhead = $event"
      @checkpoint="checkpoint"
      @undo="history(true)"
      @redo="history(false)"
      @remove="remove"
      @split="split"
      @subtitles="generateSubtitles"
    />
    <section class="fas-artifact-entry-bar">
      <span class="fas-artifact-entry-icon"><Archive :size="23" /></span>
      <div>
        <b>数字人口播项目产物</b
        ><small>{{ projectName }} · {{ projectId }} · 裂变类 · 数字人口播存储区</small>
      </div>
      <em :class="{ stored: state.stored.length === assetNames.length }">{{
        state.stored.length === assetNames.length
          ? '已模拟入库'
          : `待入库 ${assetNames.filter((n) => !state.stored.includes(n)).length} 项`
      }}</em
      ><button class="fas-btn primary" :disabled="!!busy" @click="openAssets">
        保存到项目资产库
      </button>
    </section>
    <footer class="fas-render-dock">
      <div>
        <i :class="busy ? 'rendering' : state.status" /><span
          ><b>{{ summary }}</b
          ><small>所有处理均为本地 Mock，不调用真实 AI 或视频接口</small></span
        >
      </div>
      <div v-if="busy" class="fas-mini-progress"><i :style="{ width: `${progress}%` }" /></div>
      <button :disabled="!!busy" @click="render">
        <Download v-if="generated" :size="14" /><Video v-else :size="14" />{{
          busy ? `${progress}%` : generated ? '导出视频' : '渲染输出成片'
        }}
      </button>
    </footer>
  </div>
  <div v-if="failure || storageError" class="avatar-error" role="alert">
    {{ failure || storageError }}<button v-if="failure" @click="generate">重新尝试</button>
  </div>
  <div v-if="toast" class="fas-toast" role="status">{{ toast }}</div>
  <AvatarDialog
    v-if="modal === 'export'"
    title="导出数字人口播成片"
    panel-class="fas-export-modal"
    @close="closeModal"
    ><header>
      <div><b>导出数字人口播成片</b><small>配置输出规格并导出本地 Mock 工程包</small></div>
      <button aria-label="关闭导出" :disabled="!!busy" @click="closeModal"><X :size="18" /></button>
    </header>
    <main>
      <label class="fas-field">成片名称<input v-model="exportName" /></label>
      <div class="fas-two-fields">
        <label class="fas-field"
          >格式<select v-model="exportFormat">
            <option>MP4</option>
            <option>MOV</option>
          </select></label
        ><label class="fas-field"
          >分辨率<select v-model="exportResolution">
            <option>1080P</option>
            <option>720P</option>
            <option>4K</option>
          </select></label
        >
      </div>
      <label class="fas-field"
        >画幅<select v-model="exportRatio">
          <option>9:16</option>
          <option>16:9</option>
          <option>1:1</option>
        </select></label
      ><label class="fas-field"
        ><span><input v-model="exportSubtitles" type="checkbox" />包含同步字幕</span></label
      >
      <div class="fas-copy-note">
        Mock 导出为 ZIP（工程配置及 SRT 字幕），不包含真实生成的视频或音频。
      </div>
      <div v-if="busy" class="fas-mini-progress"><i :style="{ width: `${progress}%` }" /></div>
      <p v-if="exported" class="avatar-export-success">Mock 工程包已导出</p>
    </main>
    <footer>
      <button class="fas-btn" :disabled="!!busy" @click="closeModal">取消</button
      ><button class="fas-btn primary" :disabled="!!busy" @click="download">
        {{ busy ? '正在导出…' : '导出 Mock 工程包' }}
      </button>
    </footer></AvatarDialog
  >
  <AvatarDialog
    v-if="modal === 'assets'"
    title="保存到当前项目资产库"
    panel-class="fas-artifact-modal"
    @close="closeModal"
    ><header>
      <div><b>保存到当前项目资产库</b><small>Mock 演示 · 选择本次需要入库的项目产物</small></div>
      <button aria-label="关闭入库" :disabled="!!busy" @click="closeModal"><X :size="18" /></button>
    </header>
    <div class="fas-artifact-project">
      <b>{{ projectName }}</b
      ><small>{{ projectId }} · 当前项目只读</small>
    </div>
    <main>
      <label
        v-for="name in assetNames"
        :key="name"
        class="fas-artifact-row"
        :class="{ stored: state.stored.includes(name) }"
        ><input v-model="assetSelection" type="checkbox" :value="name" :disabled="!!busy" /><i
          ><FileText :size="16" /></i
        ><span
          ><b>{{ name }}</b
          ><small>裂变类 / 数字人口播 / 当前演示工作副本</small></span
        ><em>{{ state.stored.includes(name) ? '已入库' : '待入库' }}</em></label
      >
    </main>
    <div class="fas-artifact-fields">
      <label>资产标签<input v-model="assetTags" /></label
      ><label>版本说明<input v-model="assetNote" placeholder="请输入本次入库说明" /></label>
    </div>
    <footer>
      <span>已选择 {{ assetSelection.length }} 项 · 仅本地模拟，不创建正式资产</span
      ><button :disabled="!!busy" @click="closeModal">取消</button
      ><button class="primary" :disabled="!assetSelection.length || !!busy" @click="saveAssets">
        {{ busy ? `${progress}%` : '确认入库' }}
      </button>
    </footer></AvatarDialog
  >
  <AvatarDialog
    v-if="modal === 'avatar'"
    title="上传真人参考图生成数字人"
    panel-class="fas-avatar-generator-modal"
    @close="closeModal"
    ><header>
      <div>
        <b>上传真人参考图生成数字人</b><small>参考图生成、返修与采用均为本地 Mock 演示</small>
      </div>
      <button aria-label="关闭数字人生成" :disabled="!!busy" @click="closeModal">
        <X :size="18" />
      </button>
    </header>
    <div class="fas-avatar-generator-body">
      <div class="fas-avatar-generator-form">
        <label class="fas-avatar-reference-upload" :class="{ ready: reference }"
          ><input
            type="file"
            accept="image/*"
            :disabled="!!busy"
            @change="importFile($event, 'reference')"
          /><img v-if="reference" :src="reference" alt="真人参考图" /><span v-else
            ><Upload :size="26" /></span
          ><b>{{ referenceName || '上传真人参考图' }}</b
          ><small>选择清晰正面照 · 仅在本地预览</small></label
        ><label class="fas-field"
          >数字人名称<input
            v-model="avatarName"
            :disabled="!!busy"
            placeholder="请输入数字人名称" /></label
        ><label class="fas-field">标签<input v-model="avatarTags" :disabled="!!busy" /></label
        ><label class="fas-field"
          >返修说明<textarea
            v-model="avatarFeedback"
            rows="4"
            :disabled="!!busy"
            placeholder="说明服装、姿态、背景等调整需求"
          />
        </label>
        <p class="fas-avatar-generator-note">
          Mock
          复用上传的参考图片展示结果，不调用形象生成服务。采用后仅加入当前演示素材列表，刷新需重新导入。
        </p>
      </div>
      <div class="fas-avatar-draft-panel">
        <div class="fas-avatar-draft-preview">
          <img v-if="reference" :src="reference" alt="数字人草稿预览" /><UserRound
            v-else
            :size="56"
          /><i v-if="avatarVersion">v{{ avatarVersion }}</i>
          <div v-if="busy" class="fas-avatar-generating">
            <b>{{ progress }}%</b><small>正在生成 Mock 形象</small>
          </div>
        </div>
        <div class="fas-avatar-draft-copy">
          <b>{{ avatarName || '待生成数字人' }}</b
          ><small>{{
            avatarVersion ? `草稿 v${avatarVersion} · 待采用` : '上传参考图后生成预览'
          }}</small>
        </div>
      </div>
    </div>
    <footer>
      <button :disabled="!!busy" @click="closeModal">取消</button
      ><button :disabled="!!busy || !reference || !avatarName.trim()" @click="generateAvatar">
        {{ avatarVersion ? '按说明返修' : '生成数字人' }}</button
      ><button class="primary" :disabled="!!busy || !avatarVersion" @click="adoptAvatar">
        采用此版本
      </button>
    </footer></AvatarDialog
  >
</template>
<style src="./avatar-studio.css"></style>
<style src="./avatar-integration.css"></style>
