<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { Check, ChevronLeft, ChevronRight, LoaderCircle } from '@lucide/vue';
import type { ApiResponse, EffectVoiceCatalog, EffectVoiceProfile } from '@ai-marketing/contracts';
import { apiUrl, requestJson } from '../../../api/http-client';

const props = defineProps<{
  projectId: string;
  workflowRunId: string;
  templateId: string;
  selectedId?: string | undefined;
  playing: boolean;
}>();
const emit = defineEmits<{ select: [id: string]; audition: [] }>();
const catalog = ref<EffectVoiceCatalog>({ profiles: [], defaultId: null });
const loading = ref(true),
  error = ref('');
const currentPage = ref(1);
const pageSize = 20;
const selectedId = computed(() => props.selectedId || catalog.value.defaultId);
const pageCount = computed(() => Math.max(1, Math.ceil(catalog.value.profiles.length / pageSize)));
const paginatedProfiles = computed(() => {
  const start = (currentPage.value - 1) * pageSize;
  return catalog.value.profiles.slice(start, start + pageSize);
});
const player = ref<HTMLAudioElement | null>(null);
const audioUrl = ref('');
const playingVoiceProfileId = ref('');
const loadingVoiceProfileId = ref('');
const currentPlayingId = ref('');
const sampleUrls = new Map<string, string>();
const sampleRequests = new Map<string, Promise<string>>();
let generation = 0,
  sampleCacheGeneration = 0,
  playbackRequest = 0,
  timer: ReturnType<typeof setTimeout> | undefined,
  controller: AbortController | undefined;
const root = () => `/projects/${props.projectId}/workflows/effect/template-mix`;
const base = () => `${root()}/templates/${props.templateId}`;
const query = () => `?workflowRunId=${encodeURIComponent(props.workflowRunId)}`;
const samplePath = (profile: EffectVoiceProfile) =>
  `${base()}/voice-profiles/${encodeURIComponent(profile.id)}/sample?workflowRunId=${encodeURIComponent(props.workflowRunId)}&version=${encodeURIComponent(profile.version)}`;
async function prepareSample(profile: EffectVoiceProfile): Promise<string> {
  const key = `${profile.id}:${profile.version}`;
  const ready = sampleUrls.get(key);
  if (ready) return ready;
  const pending = sampleRequests.get(key);
  if (pending) return pending;
  const currentCacheGeneration = sampleCacheGeneration;
  const request = fetch(apiUrl(samplePath(profile)))
    .then((response) => {
      if (!response.ok) throw new Error('试听样本暂不可用');
      return response.blob();
    })
    .then((blob) => {
      const url = URL.createObjectURL(blob);
      if (currentCacheGeneration !== sampleCacheGeneration) {
        URL.revokeObjectURL(url);
        throw new DOMException('Sample preload cancelled', 'AbortError');
      }
      sampleUrls.set(key, url);
      return url;
    })
    .finally(() => {
      if (sampleRequests.get(key) === request) sampleRequests.delete(key);
    });
  sampleRequests.set(key, request);
  return request;
}
function clearSampleCache() {
  sampleCacheGeneration++;
  sampleRequests.clear();
  sampleUrls.forEach((url) => URL.revokeObjectURL(url));
  sampleUrls.clear();
}
function preloadVisiblePage() {
  const profiles = [...paginatedProfiles.value];
  const selected = catalog.value.profiles.find((profile) => profile.id === selectedId.value);
  if (selected && !profiles.some((profile) => profile.id === selected.id))
    profiles.unshift(selected);
  let cursor = 0;
  const preloadWorker = async () => {
    while (cursor < profiles.length) {
      const profile = profiles[cursor++];
      if (!profile) return;
      try {
        await prepareSample(profile);
      } catch {
        // Background preloading is best-effort; the click path reports a safe error.
      }
    }
  };
  void Promise.all([preloadWorker(), preloadWorker(), preloadWorker()]);
}
function stop() {
  playbackRequest++;
  player.value?.pause();
  playingVoiceProfileId.value = '';
  loadingVoiceProfileId.value = '';
}
function markPreviewPlaying() {
  playingVoiceProfileId.value = currentPlayingId.value;
}
function markPreviewStopped() {
  playingVoiceProfileId.value = '';
}
async function selectAndPlay(profile: EffectVoiceProfile) {
  emit('select', profile.id);
  emit('audition');
  stop();
  const currentRequest = ++playbackRequest;
  currentPlayingId.value = profile.id;
  loadingVoiceProfileId.value = profile.id;
  error.value = '';
  try {
    audioUrl.value = await prepareSample(profile);
  } catch {
    if (currentRequest !== playbackRequest) return;
    error.value = '试听样本暂不可用，请稍后重试';
    loadingVoiceProfileId.value = '';
    return;
  }
  if (currentRequest !== playbackRequest) return;
  loadingVoiceProfileId.value = '';
  await nextTick();
  if (currentRequest !== playbackRequest) return;
  const audio = player.value;
  if (!audio) return;
  audio.currentTime = 0;
  await audio.play().catch(() => {
    error.value = '试听样本暂不可用，请稍后重试';
  });
}
function stopLoading() {
  clearTimeout(timer);
  controller?.abort();
}
async function refresh() {
  const current = generation;
  clearTimeout(timer);
  controller?.abort();
  const read = (controller = new AbortController());
  try {
    const voices = await requestJson<ApiResponse<EffectVoiceCatalog>>(
      base() + '/voice-profiles' + query(),
      {
        signal: read.signal,
      },
    );
    if (current !== generation) return;
    catalog.value = voices.data;
    currentPage.value = Math.min(currentPage.value, pageCount.value);
    error.value = '';
    preloadVisiblePage();
  } catch (reason) {
    if (current === generation && !read.signal.aborted) {
      error.value = reason instanceof Error ? reason.message : '音色库读取失败';
      timer = setTimeout(() => void refresh(), 5000);
    }
  } finally {
    if (current === generation) loading.value = false;
  }
}
watch(
  () => props.playing,
  (playing) => {
    if (playing) stop();
  },
);
watch(
  () => [props.projectId, props.workflowRunId, props.templateId],
  () => {
    generation++;
    stopLoading();
    stop();
    clearSampleCache();
    audioUrl.value = '';
    currentPlayingId.value = '';
    catalog.value = { profiles: [], defaultId: null };
    currentPage.value = 1;
    loading.value = true;
    void refresh();
  },
  { immediate: true },
);
watch(currentPage, preloadVisiblePage);
onBeforeUnmount(() => {
  generation++;
  stopLoading();
  stop();
  clearSampleCache();
});
</script>

<template>
  <section class="voice-library" aria-label="音色选择">
    <p v-if="error" class="voice-error" role="alert">{{ error }}</p>
    <p v-if="loading" class="voice-state" role="status">
      <LoaderCircle class="spin" :size="17" />正在读取音色…
    </p>
    <p v-if="!loading && !catalog.profiles.length && !error" class="voice-state">暂无可用音色</p>
    <p
      v-if="
        selectedId && catalog.profiles.length && !catalog.profiles.some((p) => p.id === selectedId)
      "
      class="voice-error"
    >
      原选择的音色已不可用，请重新选择；已有配音仍可播放。
    </p>
    <div class="voice-cards">
      <button
        v-for="profile in paginatedProfiles"
        :key="profile.id"
        class="voice-card"
        :class="{ selected: selectedId === profile.id }"
        :aria-pressed="selectedId === profile.id"
        :aria-label="`${selectedId === profile.id ? '已选择' : '选择'} ${profile.name}${playingVoiceProfileId === profile.id ? '，正在播放' : ''}`"
        @mouseenter="void prepareSample(profile).catch(() => undefined)"
        @focus="void prepareSample(profile).catch(() => undefined)"
        @click="selectAndPlay(profile)"
      >
        <span class="voice-card-name">{{ profile.name }}</span>
        <span
          v-if="playingVoiceProfileId === profile.id"
          class="voice-card-playing"
          role="img"
          aria-label="正在播放试听"
        >
          <i v-for="bar in 4" :key="bar" />
        </span>
        <LoaderCircle
          v-else-if="loadingVoiceProfileId === profile.id"
          class="spin voice-card-loading"
          :size="15"
          aria-label="试听加载中"
        />
        <Check v-else-if="selectedId === profile.id" class="voice-card-check" :size="15" />
      </button>
    </div>
    <nav v-if="!loading && pageCount > 1" class="voice-pagination" aria-label="音色分页">
      <button
        type="button"
        :disabled="currentPage <= 1"
        aria-label="上一页音色"
        @click="currentPage--"
      >
        <ChevronLeft :size="15" />
        上一页
      </button>
      <span aria-live="polite">{{ currentPage }} / {{ pageCount }}</span>
      <button
        type="button"
        :disabled="currentPage >= pageCount"
        aria-label="下一页音色"
        @click="currentPage++"
      >
        下一页
        <ChevronRight :size="15" />
      </button>
    </nav>
    <audio
      v-if="audioUrl"
      ref="player"
      :src="audioUrl"
      preload="auto"
      @error="error = '试听样本暂不可用，请稍后重试'"
      @play="markPreviewPlaying"
      @pause="markPreviewStopped"
      @ended="markPreviewStopped"
    />
  </section>
</template>

<style scoped>
.voice-library {
  min-height: 0;
  overflow: auto;
  flex: 1;
  padding: 12px;
  color: #29476c;
  background: #f8faff;
}
.voice-state {
  display: flex;
  align-items: center;
  gap: 9px;
}
button {
  cursor: pointer;
  border: 1px solid #d9e4f3;
  border-radius: 6px;
  background: white;
  color: #375985;
  padding: 6px 8px;
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
button:focus-visible {
  outline: 2px solid #2563eb;
  outline-offset: 2px;
}
button:disabled {
  cursor: wait;
  opacity: 0.6;
}
.voice-cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(82px, 1fr));
  gap: 8px;
}
.voice-card {
  position: relative;
  min-height: 82px;
  padding: 12px 8px 10px;
  border: 1px solid #dce5f1;
  background: #fff;
  border-radius: 10px;
  display: grid;
  justify-items: center;
  align-content: center;
  gap: 5px;
  color: #29476c;
  text-align: center;
  white-space: normal;
  cursor: pointer;
  transition:
    border-color 120ms ease,
    background-color 120ms ease,
    box-shadow 120ms ease;
}
.voice-card.selected {
  border-color: #477eff;
  background: #edf4ff;
  box-shadow: inset 0 0 0 1px #477eff;
}
.voice-card:focus-visible {
  outline: 2px solid #2563eb;
  outline-offset: 2px;
}
.voice-card-name {
  max-width: 100%;
  font-size: 12px;
  font-weight: 600;
  line-height: 1.4;
  overflow-wrap: anywhere;
  white-space: normal;
}
.voice-card-check {
  color: #2563eb;
}
.voice-card-loading {
  color: #477eff;
}
.voice-card-playing {
  display: inline-flex;
  height: 16px;
  align-items: flex-end;
  justify-content: center;
  gap: 2px;
  color: #f5c400;
}
.voice-card-playing i {
  display: block;
  width: 2px;
  height: 5px;
  border-radius: 1px;
  background: currentColor;
  transform-origin: bottom;
  animation: equalize 620ms ease-in-out infinite alternate;
}
.voice-card-playing i:nth-child(2) {
  animation-delay: -130ms;
}
.voice-card-playing i:nth-child(3) {
  animation-delay: -260ms;
}
.voice-card-playing i:nth-child(4) {
  animation-delay: -390ms;
}
.voice-pagination {
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 10px;
  padding: 14px 0 4px;
  color: #7486a0;
  font-size: 12px;
}
.voice-pagination button {
  min-height: 30px;
}
.voice-pagination button:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}
.voice-error {
  color: #b54736;
  font-size: 11px;
  line-height: 1.6;
}
.voice-state {
  color: #7486a0;
  font-size: 12px;
  padding: 15px 0;
}
audio {
  display: none;
}
.spin {
  animation: rotate 1s linear infinite;
}
@keyframes rotate {
  to {
    transform: rotate(360deg);
  }
}
@keyframes equalize {
  from {
    transform: scaleY(0.45);
  }
  to {
    transform: scaleY(2.2);
  }
}
</style>
