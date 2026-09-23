<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { AudioLines, Check, LoaderCircle, RefreshCw } from '@lucide/vue';
import type {
  ApiResponse,
  EffectVoiceCatalog,
  EffectVoicePreview,
  EffectVoiceProfile,
} from '@ai-marketing/contracts';
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
const previews = ref<EffectVoicePreview[]>([]);
const loading = ref(true),
  busyId = ref(''),
  error = ref('');
const selectedId = computed(() => props.selectedId || catalog.value.defaultId);
const player = ref<HTMLAudioElement | null>(null);
const audition = ref<EffectVoicePreview | null>(null);
const playAfterGenerationId = ref('');
let generation = 0,
  timer: ReturnType<typeof setTimeout> | undefined,
  controller: AbortController | undefined;
const pendingKeys = new Map<string, string>();
const root = () => `/projects/${props.projectId}/workflows/effect/template-mix`;
const base = () => `${root()}/templates/${props.templateId}`;
const query = () => `?workflowRunId=${encodeURIComponent(props.workflowRunId)}`;
const previewFor = (p: EffectVoiceProfile) =>
  previews.value.find((r) => r.voiceProfileId === p.id && r.version === p.version);
const unavailableFailure = computed(
  () =>
    previews.value.find(
      (r) =>
        r.status === 'FAILED' &&
        r.errorMessage &&
        !catalog.value.profiles.some((p) => p.id === r.voiceProfileId),
    )?.errorMessage,
);
const isActive = (p: EffectVoicePreview | undefined) =>
  !!p && ['QUEUED', 'RUNNING'].includes(p.status);
const audioUrl = computed(() =>
  audition.value?.fileObjectId
    ? apiUrl(`/projects/${props.projectId}/file-objects/${audition.value.fileObjectId}/content`)
    : '',
);
function stop() {
  player.value?.pause();
}
async function playPreview(row: EffectVoicePreview) {
  if (!row.fileObjectId) return;
  stop();
  audition.value = row;
  await nextTick();
  const audio = player.value;
  if (!audio) return;
  audio.currentTime = 0;
  await audio.play().catch(() => {
    error.value = '浏览器未能播放音色，请再次点击该音色重播';
  });
}
function stopPolling() {
  clearTimeout(timer);
  controller?.abort();
}
async function refresh(initial = false) {
  const current = generation;
  clearTimeout(timer);
  controller?.abort();
  const read = (controller = new AbortController());
  try {
    const [voices, rows] = await Promise.all([
      requestJson<ApiResponse<EffectVoiceCatalog>>(base() + '/voice-profiles' + query(), {
        signal: read.signal,
      }),
      requestJson<ApiResponse<EffectVoicePreview[]>>(base() + '/voice-previews' + query(), {
        signal: read.signal,
      }),
    ]);
    if (current !== generation) return;
    catalog.value = voices.data;
    previews.value = rows.data;
    error.value = '';
    const pendingProfileId = playAfterGenerationId.value;
    if (pendingProfileId) {
      const profile = voices.data.profiles.find((item) => item.id === pendingProfileId);
      const row = profile && rows.data.find(
        (item) => item.voiceProfileId === profile.id && item.version === profile.version,
      );
      if (row?.status === 'COMPLETED' && row.fileObjectId) {
        playAfterGenerationId.value = '';
        if (selectedId.value === pendingProfileId) await playPreview(row);
      } else if (row && ['FAILED', 'CANCELLED'].includes(row.status)) {
        playAfterGenerationId.value = '';
      }
    }
    if (rows.data.some(isActive) || playAfterGenerationId.value) {
      timer = setTimeout(() => void refresh(), 1500);
    }
  } catch (reason) {
    if (current === generation && !read.signal.aborted) {
      error.value = reason instanceof Error ? reason.message : '音色库读取失败';
      if (!initial) timer = setTimeout(() => void refresh(), 5000);
    }
  } finally {
    if (current === generation) loading.value = false;
  }
}
async function selectAndPlay(profile: EffectVoiceProfile) {
  emit('select', profile.id);
  emit('audition');
  if (busyId.value) return;
  const cached = previewFor(profile);
  if (cached?.status === 'COMPLETED' && cached.fileObjectId) {
    await playPreview(cached);
    return;
  }
  if (isActive(cached)) return;
  const current = generation;
  busyId.value = profile.id;
  playAfterGenerationId.value = profile.id;
  error.value = '';
  // Keep the key on an uncertain network response; a repeat click safely replays that request.
  const key = pendingKeys.get(profile.id) ?? crypto.randomUUID();
  pendingKeys.set(profile.id, key);
  try {
    const result = await requestJson<ApiResponse<EffectVoicePreview>>(base() + '/voice-previews', {
      method: 'POST',
      operation: '生成音色试听',
      body: { workflowRunId: props.workflowRunId, voiceProfileId: profile.id, idempotencyKey: key },
    });
    if (current !== generation) return;
    pendingKeys.delete(profile.id);
    previews.value = [result.data, ...previews.value.filter((r) => r.id !== result.data.id)];
    await refresh();
  } catch (reason) {
    if (current === generation)
      error.value = reason instanceof Error ? reason.message : '音色播放失败';
    if (current === generation) playAfterGenerationId.value = '';
  } finally {
    if (current === generation) busyId.value = '';
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
    stopPolling();
    stop();
    audition.value = null;
    playAfterGenerationId.value = '';
    pendingKeys.clear();
    previews.value = [];
    catalog.value = { profiles: [], defaultId: null };
    busyId.value = '';
    loading.value = true;
    void refresh(true);
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  generation++;
  stopPolling();
  stop();
});
</script>

<template>
  <section class="voice-library" aria-label="音色选择">
    <div class="voice-toolbar">
      <span v-if="error" class="voice-error" role="alert">{{ error }}</span>
      <button aria-label="刷新音色" title="刷新音色" @click="refresh(true)">
        <RefreshCw :size="15" />
      </button>
    </div>
    <p v-if="loading" class="voice-state" role="status">
      <LoaderCircle class="spin" :size="17" />正在读取音色…
    </p>
    <p v-if="!loading && !catalog.profiles.length && !error" class="voice-state">
      暂无可用音色
    </p>
    <p
      v-if="
        selectedId && catalog.profiles.length && !catalog.profiles.some((p) => p.id === selectedId)
      "
      class="voice-error"
    >
      原选择的音色已不可用，请重新选择；已有配音仍可播放。
    </p>
    <p v-if="unavailableFailure" class="voice-error" role="alert">{{ unavailableFailure }}</p>
    <div class="voice-cards">
      <button
        v-for="profile in catalog.profiles"
        :key="profile.id"
        class="voice-card"
        :class="{ selected: selectedId === profile.id }"
        :disabled="isActive(previewFor(profile))"
        :aria-pressed="selectedId === profile.id"
        :aria-label="`选择并播放 ${profile.name}`"
        @click="selectAndPlay(profile)"
      >
        <span class="voice-card-name">{{ profile.name }}</span>
        <span class="voice-card-meta">{{ profile.gender === 'FEMALE' ? '女声' : '男声' }}</span>
        <span v-if="busyId === profile.id || isActive(previewFor(profile))" class="voice-card-state">
          <LoaderCircle class="spin" :size="13" />
          {{ previewFor(profile)?.status === 'QUEUED' ? '排队中' : '生成中' }}
        </span>
        <AudioLines v-else-if="selectedId === profile.id" class="voice-card-selected" :size="16" />
        <Check v-else class="voice-card-check" :size="15" />
        <span v-if="previewFor(profile)?.errorMessage" class="voice-error">
          {{ previewFor(profile)?.errorMessage }}
        </span>
      </button>
    </div>
    <audio
      v-if="audioUrl"
      ref="player"
      :src="audioUrl"
      preload="none"
      @error="error = '音色音频读取失败，请刷新后重试'"
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
.voice-toolbar {
  min-height: 28px;
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
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
  transition: border-color 120ms ease, background-color 120ms ease, box-shadow 120ms ease;
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
  overflow: hidden;
  max-width: 100%;
  font-size: 12px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.voice-card-meta {
  color: #8292aa;
  font-size: 10px;
}
.voice-card-selected,
.voice-card-check {
  color: #2563eb;
}
.voice-card-state {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 10px;
  color: #8292aa;
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
</style>
