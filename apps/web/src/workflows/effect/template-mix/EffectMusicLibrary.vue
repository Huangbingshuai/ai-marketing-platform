<script setup lang="ts">
import type { ApiResponse, Asset } from '@ai-marketing/contracts';
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { ChevronDown, LoaderCircle, Music2, Pause, Play, Search, Upload, X } from '@lucide/vue';
import { importAsset, listAssets } from '../../../platform/asset/api/asset.api';

const props = defineProps<{ projectId: string; workflowRunId: string }>();

const MUSIC_LIBRARY_TAG = '模板混剪音乐库';
const MP3_FILE_ACCEPT = 'audio/mpeg,.mp3';
const PAGE_SIZE = 24;
const assets = ref<Asset[]>([]);
const loading = ref(true);
const uploading = ref(false);
const error = ref('');
const keyword = ref('');
const currentPage = ref(1);
const input = ref<HTMLInputElement | null>(null);
const player = ref<HTMLAudioElement | null>(null);
const selectedAssetId = ref('');
const playing = ref(false);
const currentTime = ref(0);
const durations = reactive<Record<string, number>>({});
let generation = 0;
let listController: AbortController | undefined;
let uploadController: AbortController | undefined;

const activeAsset = computed(
  () => assets.value.find((asset) => asset.id === selectedAssetId.value) ?? null,
);
const filteredAssets = computed(() => {
  const term = keyword.value.trim().toLocaleLowerCase();
  return term
    ? assets.value.filter((asset) => asset.name.toLocaleLowerCase().includes(term))
    : assets.value;
});
const pageCount = computed(() => Math.max(1, Math.ceil(filteredAssets.value.length / PAGE_SIZE)));
const pageAssets = computed(() => {
  const start = (currentPage.value - 1) * PAGE_SIZE;
  return filteredAssets.value.slice(start, start + PAGE_SIZE);
});
const playerDuration = computed(() =>
  Math.max(0, durations[selectedAssetId.value] ?? player.value?.duration ?? 0),
);
const progressPercent = computed(() =>
  playerDuration.value > 0 ? Math.min(100, (currentTime.value / playerDuration.value) * 100) : 0,
);

function isMp3File(file: File): boolean {
  return /\.mp3$/i.test(file.name);
}
function isMp3Asset(asset: Asset): boolean {
  return /\.mp3$/i.test(asset.originalFileName);
}
function displayMusicName(name: string): string {
  return name.replace(/\.mp3$/i, '');
}
function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00';
  const total = Math.floor(seconds);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}
function setDuration(assetId: string, duration: number) {
  if (Number.isFinite(duration) && duration > 0) durations[assetId] = duration;
}
async function refreshAssets() {
  const current = generation;
  listController?.abort();
  const controller = (listController = new AbortController());
  loading.value = true;
  try {
    const response = await listAssets(
      props.projectId,
      {
        type: 'VOICE_AUDIO',
        workflow: 'EFFECT',
        space: 'EFFECT',
        tag: MUSIC_LIBRARY_TAG,
        page: 1,
        pageSize: 96,
      },
      controller.signal,
    );
    if (current !== generation) return;
    assets.value = response.data.items;
    error.value = '';
    currentPage.value = Math.min(currentPage.value, pageCount.value);
  } catch (reason) {
    if (current === generation && !controller.signal.aborted) {
      error.value = reason instanceof Error ? reason.message : '音乐读取失败';
    }
  } finally {
    if (current === generation) loading.value = false;
  }
}
function openFilePicker() {
  input.value?.click();
}
async function importMusic(event: Event) {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return;
  const file = target.files?.[0];
  target.value = '';
  if (!file) return;
  if (!isMp3File(file)) {
    error.value = '音乐库仅支持导入 MP3 文件';
    return;
  }
  const current = generation;
  const controller = (uploadController = new AbortController());
  uploading.value = true;
  error.value = '';
  try {
    const response: ApiResponse<Asset> = await importAsset(
      props.projectId,
      file,
      {
        name: file.name,
        directory: 'AUDIO_ASSETS',
        type: 'VOICE_AUDIO',
        tags: [MUSIC_LIBRARY_TAG],
        workflowRunId: props.workflowRunId,
      },
      controller.signal,
    );
    if (current === generation) {
      assets.value = [
        response.data,
        ...assets.value.filter((asset) => asset.id !== response.data.id),
      ];
      currentPage.value = 1;
      selectedAssetId.value = response.data.id;
      await nextTick();
      await playSelected();
    }
  } catch (reason) {
    if (current === generation && !controller.signal.aborted) {
      error.value = reason instanceof Error ? reason.message : '音乐导入失败，请重试';
    }
  } finally {
    if (current === generation) uploading.value = false;
  }
}
async function playSelected() {
  await nextTick();
  const audio = player.value;
  if (!audio || !activeAsset.value) return;
  if (audio.src !== new URL(activeAsset.value.contentUrl, window.location.href).href) {
    audio.src = activeAsset.value.contentUrl;
  }
  if (audio.readyState === HTMLMediaElement.HAVE_NOTHING) audio.load();
  await audio
    .play()
    .then(() => (playing.value = true))
    .catch(() => {
      playing.value = false;
      error.value = '音乐暂时无法播放，请稍后重试';
    });
}
async function toggleAsset(asset: Asset) {
  if (!isMp3Asset(asset)) {
    error.value = '该音乐格式暂不支持，请导入 MP3 文件';
    return;
  }
  if (selectedAssetId.value === asset.id && playing.value) {
    player.value?.pause();
    playing.value = false;
    return;
  }
  selectedAssetId.value = asset.id;
  currentTime.value = 0;
  error.value = '';
  await playSelected();
}
function updateCurrentTime() {
  currentTime.value = player.value?.currentTime ?? 0;
}
function updateActiveDuration() {
  if (activeAsset.value && player.value) setDuration(activeAsset.value.id, player.value.duration);
}
function seek(event: Event) {
  const value = Number((event.target as HTMLInputElement).value);
  if (!Number.isFinite(value) || !player.value) return;
  player.value.currentTime = value;
  currentTime.value = value;
}
function closePlayer() {
  player.value?.pause();
  selectedAssetId.value = '';
  currentTime.value = 0;
  playing.value = false;
}
function startMusicDrag(event: DragEvent, asset: Asset) {
  const duration = durations[asset.id];
  if (!isMp3Asset(asset)) {
    event.preventDefault();
    error.value = '音乐库仅支持 MP3 文件';
    return;
  }
  if (!event.dataTransfer || !asset.workflowFileObjectId || !duration) {
    event.preventDefault();
    error.value = asset.workflowFileObjectId
      ? '正在读取音乐时长，请稍后拖动'
      : '这首音乐暂不支持上轨，请重新导入';
    return;
  }
  event.dataTransfer.effectAllowed = 'copy';
  event.dataTransfer.setData(
    'application/x-effect-template-mix-music',
    JSON.stringify({
      assetId: asset.id,
      fileObjectId: asset.workflowFileObjectId,
      name: asset.name,
      duration,
    }),
  );
  event.dataTransfer.setData('text/plain', asset.name);
}
watch(
  () => [props.projectId, props.workflowRunId],
  () => {
    generation++;
    listController?.abort();
    uploadController?.abort();
    player.value?.pause();
    assets.value = [];
    Object.keys(durations).forEach((key) => delete durations[key]);
    selectedAssetId.value = '';
    currentTime.value = 0;
    playing.value = false;
    keyword.value = '';
    error.value = '';
    void refreshAssets();
  },
  { immediate: true },
);
watch(keyword, () => (currentPage.value = 1));
onBeforeUnmount(() => {
  generation++;
  listController?.abort();
  uploadController?.abort();
  player.value?.pause();
});
</script>

<template>
  <section class="music-library" aria-label="音乐">
    <header class="music-library-header">
      <strong>音乐</strong>
      <small class="music-format-note">仅支持 MP3</small>
      <button type="button" class="import-button" :disabled="uploading" @click="openFilePicker">
        <LoaderCircle v-if="uploading" class="spin" :size="14" />
        <Upload v-else :size="14" />
        {{ uploading ? '正在导入' : '导入音乐' }}
      </button>
      <input
        ref="input"
        class="music-file-input"
        type="file"
        :accept="MP3_FILE_ACCEPT"
        aria-label="选择要导入的音乐文件"
        @change="importMusic"
      />
    </header>

    <div class="music-search-row">
      <label class="music-search">
        <Search :size="15" aria-hidden="true" />
        <input v-model="keyword" placeholder="搜索音乐名称" aria-label="搜索音乐名称" />
      </label>
      <button type="button" class="music-filter" aria-label="音乐分类：全部">
        全部 <ChevronDown :size="14" aria-hidden="true" />
      </button>
    </div>

    <div class="music-library-body">
      <h3>推荐音乐</h3>
      <p v-if="error" class="music-error" role="alert">{{ error }}</p>
      <p v-if="loading" class="music-state" role="status">
        <LoaderCircle class="spin" :size="16" />正在读取音乐…
      </p>
      <p v-else-if="!filteredAssets.length && !error" class="music-state music-empty">
        <Music2 :size="26" />
        <span>{{ keyword ? '没有找到匹配的音乐' : '暂无音乐，点击“导入音乐”添加' }}</span>
      </p>
      <div v-else class="music-card-grid">
        <article
          v-for="(asset, index) in pageAssets"
          :key="asset.id"
          class="music-card"
          :class="{
            selected: selectedAssetId === asset.id,
            'is-playing': selectedAssetId === asset.id && playing,
            'is-unsupported': !isMp3Asset(asset),
          }"
          :draggable="
            Boolean(isMp3Asset(asset) && asset.workflowFileObjectId && durations[asset.id])
          "
          :title="
            isMp3Asset(asset)
              ? asset.workflowFileObjectId
                ? '拖动到下方音频轨道'
                : '请重新导入后添加到时间轴'
              : '音乐库仅支持 MP3 文件'
          "
          @click="void toggleAsset(asset)"
          @dragstart="startMusicDrag($event, asset)"
        >
          <span class="music-art" :class="`art-${index % 6}`" aria-hidden="true">
            <Music2 :size="30" />
            <span class="art-play"
              ><Pause v-if="selectedAssetId === asset.id && playing" :size="18" /><Play
                v-else
                :size="18"
            /></span>
          </span>
          <span class="music-card-copy">
            <strong :title="displayMusicName(asset.name)">{{
              displayMusicName(asset.name)
            }}</strong>
            <em>{{
              !isMp3Asset(asset)
                ? '不支持的格式'
                : durations[asset.id]
                  ? formatTime(durations[asset.id]!)
                  : '读取时长…'
            }}</em>
          </span>
          <audio
            v-if="isMp3Asset(asset)"
            class="metadata-probe"
            :src="asset.contentUrl"
            preload="metadata"
            @loadedmetadata="setDuration(asset.id, ($event.target as HTMLAudioElement).duration)"
          />
        </article>
      </div>
      <footer
        v-if="filteredAssets.length > PAGE_SIZE"
        class="music-pagination"
        aria-label="音乐分页"
      >
        <button type="button" :disabled="currentPage <= 1" @click="currentPage--">上一页</button>
        <span>{{ currentPage }} / {{ pageCount }}</span>
        <button type="button" :disabled="currentPage >= pageCount" @click="currentPage++">
          下一页
        </button>
      </footer>
    </div>

    <footer v-if="activeAsset" class="music-player" aria-label="音乐播放器">
      <button
        type="button"
        class="player-play"
        :aria-label="playing ? '暂停音乐' : '播放音乐'"
        @click="playing ? (player?.pause(), (playing = false)) : void playSelected()"
      >
        <Pause v-if="playing" :size="16" />
        <Play v-else :size="16" />
      </button>
      <div class="player-main">
        <strong :title="activeAsset.name">{{ activeAsset.name }}</strong>
        <div class="player-progress-row">
          <span>{{ formatTime(currentTime) }}</span>
          <input
            type="range"
            min="0"
            :max="playerDuration || 0"
            step="0.1"
            :value="currentTime"
            :style="{ '--progress': `${progressPercent}%` }"
            aria-label="音乐播放进度"
            @input="seek"
          />
          <span>{{ formatTime(playerDuration) }}</span>
        </div>
      </div>
      <button type="button" class="player-close" aria-label="关闭音乐播放器" @click="closePlayer">
        <X :size="16" />
      </button>
      <audio
        ref="player"
        class="active-player"
        :src="activeAsset.contentUrl"
        preload="metadata"
        @timeupdate="updateCurrentTime"
        @loadedmetadata="updateActiveDuration"
        @play="playing = true"
        @pause="playing = false"
        @ended="playing = false"
      />
    </footer>
  </section>
</template>

<style scoped>
.music-library {
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  overflow: hidden;
  color: #29476c;
  background: #f8faff;
}
.music-library-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 12px 7px;
  font-size: 13px;
}
.music-format-note {
  margin-left: auto;
  color: #7b8eaa;
  font-size: 10px;
}
.import-button,
.music-filter,
.music-pagination button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 6px 9px;
  border: 1px solid #bfd4ff;
  border-radius: 6px;
  color: #2563eb;
  background: #fff;
  cursor: pointer;
  font: inherit;
  font-size: 11px;
}
.import-button:disabled,
.music-pagination button:disabled {
  cursor: wait;
  opacity: 0.55;
}
.music-file-input,
.metadata-probe,
.active-player {
  display: none;
}
.music-search-row {
  display: flex;
  gap: 7px;
  padding: 3px 10px 9px;
  border-bottom: 1px solid #e3eaf5;
}
.music-search {
  display: flex;
  min-width: 0;
  flex: 1;
  align-items: center;
  gap: 7px;
  padding: 7px 9px;
  border: 1px solid #dce5f1;
  border-radius: 7px;
  color: #7486a0;
  background: #fff;
}
.music-search input {
  width: 100%;
  min-width: 0;
  border: 0;
  outline: 0;
  color: #29476c;
  background: transparent;
  font: inherit;
  font-size: 11px;
}
.music-filter {
  flex: none;
  color: #516987;
  border-color: #dce5f1;
}
.music-library-body {
  min-height: 0;
  flex: 1;
  overflow: auto;
  padding: 8px 10px 14px;
}
.music-library-body h3 {
  margin: 4px 0 9px;
  color: #526984;
  font-size: 11px;
  font-weight: 600;
}
.music-card-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}
.music-card {
  display: flex;
  min-width: 0;
  min-height: 74px;
  align-items: center;
  gap: 8px;
  padding: 6px;
  border: 1px solid #dce5f1;
  border-radius: 9px;
  background: #fff;
  cursor: pointer;
  text-align: left;
}
.music-card[draggable='true'] {
  cursor: grab;
}
.music-card:active[draggable='true'] {
  cursor: grabbing;
}
.music-card.selected {
  border-color: #477eff;
  box-shadow: inset 0 0 0 1px #477eff;
  background: #f0f5ff;
}
.music-art {
  position: relative;
  display: flex;
  width: 66px;
  min-width: 66px;
  height: 62px;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  border-radius: 6px;
  color: rgb(255 255 255 / 88%);
  background: linear-gradient(135deg, #335da8, #91b4ee);
}
.music-art::before,
.music-art::after {
  position: absolute;
  right: -9px;
  bottom: -24px;
  width: 82px;
  height: 48px;
  border-radius: 50%;
  background: rgb(255 255 255 / 12%);
  content: '';
}
.music-art::after {
  right: 22px;
  bottom: -32px;
  width: 56px;
  height: 56px;
  background: rgb(0 0 0 / 10%);
}
.art-1 {
  background: linear-gradient(135deg, #218b95, #90d1c5);
}
.art-2 {
  background: linear-gradient(135deg, #5e5ba9, #a8a4e9);
}
.art-3 {
  background: linear-gradient(135deg, #b36d3d, #f0bd77);
}
.art-4 {
  background: linear-gradient(135deg, #9d4966, #e5a1ae);
}
.art-5 {
  background: linear-gradient(135deg, #47766d, #9cc9a2);
}
.music-art > svg,
.art-play {
  position: relative;
  z-index: 1;
}
.art-play {
  position: absolute;
  display: grid;
  width: 27px;
  height: 27px;
  place-items: center;
  border-radius: 50%;
  color: #fff;
  background: rgb(20 36 60 / 65%);
}
.music-card-copy {
  display: grid;
  min-width: 0;
  align-self: stretch;
  flex: 1;
  align-content: space-between;
  padding: 3px 0 2px;
}
.music-card-copy strong {
  display: -webkit-box;
  overflow: hidden;
  color: #29476c;
  font-size: 11px;
  font-weight: 600;
  line-height: 1.4;
  overflow-wrap: anywhere;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}
.music-card-copy small {
  overflow: hidden;
  color: #8292a8;
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.music-card-copy em {
  color: #8292a8;
  font-size: 10px;
  font-style: normal;
}
.music-state,
.music-error {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 14px 0;
  color: #7185a3;
  font-size: 12px;
}
.music-error {
  color: #b42318;
}
.music-empty {
  flex: 1;
  flex-direction: column;
  justify-content: center;
  text-align: center;
}
.music-pagination {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 9px;
  padding: 12px 0 1px;
  color: #7185a3;
  font-size: 11px;
}
.music-player {
  display: flex;
  flex: none;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-top: 1px solid #dce5f1;
  background: #fff;
  box-shadow: 0 -5px 14px rgb(35 65 105 / 7%);
}
.player-play,
.player-close {
  display: grid;
  width: 32px;
  min-width: 32px;
  height: 32px;
  place-items: center;
  border: 0;
  border-radius: 50%;
  color: #fff;
  background: #2563eb;
  cursor: pointer;
}
.player-main {
  display: grid;
  min-width: 0;
  flex: 1;
  gap: 6px;
}
.player-main strong {
  overflow: hidden;
  color: #29476c;
  font-size: 11px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.player-progress-row {
  display: flex;
  align-items: center;
  gap: 7px;
  color: #70829c;
  font-size: 10px;
  font-variant-numeric: tabular-nums;
}
.player-progress-row input {
  width: 100%;
  min-width: 30px;
  height: 4px;
  flex: 1;
  appearance: none;
  border-radius: 4px;
  background: linear-gradient(to right, #2563eb var(--progress), #d9e3f2 var(--progress));
  cursor: pointer;
}
.player-progress-row input::-webkit-slider-thumb {
  width: 10px;
  height: 10px;
  appearance: none;
  border: 2px solid #fff;
  border-radius: 50%;
  background: #2563eb;
  box-shadow: 0 0 0 1px #2563eb;
}
.player-close {
  color: #7587a0;
  background: #eef2f8;
}
.spin {
  animation: spin 1s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
@media (max-width: 360px) {
  .music-card-grid {
    grid-template-columns: 1fr;
  }
}
</style>
