<script setup lang="ts">
import { computed } from 'vue';
import { WandSparkles } from '@lucide/vue';
import { PACKAGING_STAGES, PACKAGING_STAGE_LABELS } from '@ai-marketing/contracts';
import type { PackagingItem } from '@ai-marketing/contracts';
const props = defineProps<{ item?: PackagingItem | undefined; submitting: boolean; disabled: boolean }>();
const emit = defineEmits<{ package: []; details: [] }>();
// Batch/append items still lock this film, but are not a single-button submission.
const active = computed(() => props.submitting || props.item?.operation === 'SINGLE_PACKAGE' &&
  ['QUEUED', 'RUNNING'].includes(props.item.status));
const progress = computed(() => props.submitting ? 0 :
  Math.floor(PACKAGING_STAGES.indexOf(props.item?.stage ?? 'SNAPSHOT') / PACKAGING_STAGES.length * 100));
const detail = computed(() => {
  if (!active.value) return '';
  if (props.submitting) return '正在提交';
  const item = props.item;
  if (!item) return '';
  const waiting = item.checkpoint.recovery?.waitingUntil;
  const voiceWaiting = Object.values(item.checkpoint.voiceRecovery ?? {}).some((state) =>
    state.waitingUntil && Date.parse(state.waitingUntil) > Date.now());
  return `${PACKAGING_STAGE_LABELS[item.stage]}${voiceWaiting || waiting && Date.parse(waiting) > Date.now() ? ' · 自动重试中' : ''} · ${progress.value}%`;
});
</script>
<template>
  <div class="single-packaging-control">
    <button type="button" :disabled="disabled || active" @click="emit('package')"><WandSparkles :size="14" />单条成片包装</button>
    <div v-if="active" class="single-packaging-meter" role="progressbar" aria-label="当前成片包装进度" :aria-valuenow="progress" aria-valuemin="0" aria-valuemax="100"><i :style="{ width: `${progress}%` }" /></div>
    <button v-if="active && detail" class="single-packaging-detail" type="button" @click="emit('details')">{{ detail }}</button>
  </div>
</template>
<style scoped>
.single-packaging-control { display:flex; align-items:center; gap:10px; flex:0 0 auto; min-width:0; }
button { display:inline-flex; align-items:center; gap:5px; white-space:nowrap; color:#176847; border:1px solid #b6ddce; background:#f4fcf8; border-radius:7px; padding:7px 10px; cursor:pointer; font:inherit; font-size:12px; }
button:disabled { opacity:.55; cursor:default; }
.single-packaging-meter { width:100px; height:6px; background:#dcefe5; border-radius:4px; overflow:hidden; }
.single-packaging-meter i { display:block; height:100%; background:#20aa6e; transition:width .2s; }
.single-packaging-detail { padding:4px 0; border:0; background:transparent; }
@media(max-width:700px) { .single-packaging-meter { width:60px; } }
</style>
