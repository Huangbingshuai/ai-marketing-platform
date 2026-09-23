<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { AudioLines, Check, LoaderCircle, Play, RefreshCw } from '@lucide/vue';
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
    if (rows.data.some(isActive)) timer = setTimeout(() => void refresh(), 1500);
  } catch (reason) {
    if (current === generation && !read.signal.aborted) {
      error.value = reason instanceof Error ? reason.message : '音色库读取失败';
      if (!initial) timer = setTimeout(() => void refresh(), 5000);
    }
  } finally {
    if (current === generation) loading.value = false;
  }
}
async function listen(profile: EffectVoiceProfile) {
  if (busyId.value) return;
  const cached = previewFor(profile);
  if (cached?.status === 'COMPLETED' && cached.fileObjectId) {
    stop();
    emit('audition');
    audition.value = cached;
    await nextTick();
    await player.value?.play().catch(() => {
      error.value = '请点击下方播放器播放试听';
    });
    return;
  }
  if (isActive(cached)) return;
  const current = generation;
  busyId.value = profile.id;
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
      error.value = reason instanceof Error ? reason.message : '试听生成失败';
  } finally {
    if (current === generation) busyId.value = '';
  }
}
async function cancel(row: EffectVoicePreview) {
  const current = generation;
  try {
    await requestJson(root() + `/voice-previews/${row.id}/cancel`, {
      method: 'POST',
      operation: '取消试听',
    });
    if (current === generation) await refresh();
  } catch (reason) {
    if (current === generation) error.value = reason instanceof Error ? reason.message : '取消失败';
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
  <section class="voice-library" aria-label="火山音色库">
    <header>
      <div><strong>火山音色库</strong><span>选择后用于下一次包装或重做口播</span></div>
      <button aria-label="刷新音色库" @click="refresh(true)"><RefreshCw :size="15" /></button>
    </header>
    <p v-if="loading" class="voice-state" role="status">
      <LoaderCircle class="spin" :size="17" />正在读取音色…
    </p>
    <p v-if="error" class="voice-error" role="alert">{{ error }}</p>
    <p v-if="!loading && !catalog.profiles.length && !error" class="voice-state">
      暂无已验证音色，请先配置火山音色库。
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
      <article
        v-for="profile in catalog.profiles"
        :key="profile.id"
        class="voice-card"
        :class="{ selected: selectedId === profile.id }"
      >
        <button
          class="voice-select"
          :aria-pressed="selectedId === profile.id"
          :aria-label="`选择音色 ${profile.name}`"
          @click="emit('select', profile.id)"
        >
          <span class="voice-avatar"><AudioLines :size="23" /></span>
          <span class="voice-copy"
            ><b
              >{{ profile.name }}
              <small>{{ profile.gender === 'FEMALE' ? '女声' : '男声' }}</small></b
            ><span>{{ profile.description }}</span></span
          >
          <Check v-if="selectedId === profile.id" :size="17" />
        </button>
        <div class="voice-actions">
          <button :disabled="!!busyId || isActive(previewFor(profile))" @click="listen(profile)">
            <LoaderCircle
              v-if="busyId === profile.id || isActive(previewFor(profile))"
              class="spin"
              :size="13"
            /><Play v-else :size="13" />
            {{
              isActive(previewFor(profile))
                ? previewFor(profile)?.status === 'QUEUED'
                  ? '排队中'
                  : '生成中'
                : previewFor(profile)?.status === 'COMPLETED'
                  ? '试听'
                  : ['FAILED', 'CANCELLED'].includes(previewFor(profile)?.status ?? '')
                    ? '重新生成试听'
                    : '生成试听'
            }}
          </button>
          <button v-if="isActive(previewFor(profile))" @click="cancel(previewFor(profile)!)">
            取消
          </button>
          <small v-else>{{
            previewFor(profile)?.status === 'COMPLETED'
              ? '已缓存，可重复播放'
              : previewFor(profile)?.status === 'CANCELLED'
                ? '已取消，可重新生成'
                : '首次试听调用火山配音'
          }}</small>
        </div>
        <p v-if="previewFor(profile)?.errorMessage" class="voice-error">
          {{ previewFor(profile)?.errorMessage }}
        </p>
      </article>
    </div>
    <footer v-if="audioUrl">
      <span
        >{{ catalog.profiles.find((p) => p.id === audition?.voiceProfileId)?.name }} ·
        音色试听</span
      >
      <audio
        ref="player"
        :src="audioUrl"
        controls
        preload="none"
        @play="emit('audition')"
        @error="error = '试听音频读取失败，请刷新后重试'"
      />
    </footer>
  </section>
</template>

<style scoped>
.voice-library {
  min-height: 0;
  overflow: auto;
  flex: 1;
  padding: 14px;
  color: #29476c;
  background: #f8faff;
}
header,
.voice-actions,
.voice-select,
.voice-state {
  display: flex;
  align-items: center;
  gap: 9px;
}
header {
  justify-content: space-between;
  margin-bottom: 14px;
}
header div,
.voice-copy {
  display: grid;
  gap: 5px;
  min-width: 0;
}
header strong {
  font-size: 14px;
}
header span,
.voice-actions small,
.voice-copy > span {
  font-size: 11px;
  color: #7486a0;
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
  grid-template-columns: repeat(auto-fit, minmax(min(240px, 100%), 1fr));
  gap: 10px;
}
.voice-card {
  border: 1px solid #dce5f1;
  background: #fff;
  border-radius: 9px;
  padding: 10px;
}
.voice-card.selected {
  border-color: #71a1ff;
  background: #eff5ff;
}
.voice-select {
  padding: 0;
  width: 100%;
  text-align: left;
  border: 0;
  background: transparent;
}
.voice-copy {
  flex: 1;
}
.voice-copy b {
  font-size: 13px;
}
.voice-copy small {
  font-size: 10px;
  color: #8292aa;
  font-weight: 400;
}
.voice-avatar {
  display: grid;
  place-items: center;
  width: 38px;
  height: 38px;
  flex: none;
  background: #e8f0ff;
  color: #2563eb;
  border-radius: 8px;
}
.voice-actions {
  margin-top: 12px;
  flex-wrap: wrap;
}
.voice-actions button {
  font-size: 11px;
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
footer {
  position: sticky;
  bottom: -14px;
  margin: 14px -14px -14px;
  padding: 10px 14px;
  border-top: 1px solid #dce5f1;
  background: #fff;
  display: grid;
  gap: 7px;
  font-size: 11px;
}
audio {
  width: 100%;
  height: 34px;
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
