<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import {
  videoClipShots,
  videoClipMs,
  videoCueText,
  type VideoCandidate,
} from '@ai-marketing/contracts';
import WorkflowInformationDialog from '../../../platform/workflow/components/WorkflowInformationDialog.vue';
const props = defineProps<{ candidate: VideoCandidate | null; busy: boolean }>();
const emit = defineEmits<{ close: []; adopt: [] }>();
const original = ref(false);
watch(
  () => props.candidate,
  () => {
    original.value = false;
  },
);
const document = computed(() =>
  original.value
    ? (props.candidate?.originalDocument ?? props.candidate?.document)
    : props.candidate?.document,
);
</script>
<template>
  <WorkflowInformationDialog :open="!!candidate" title="核对未完成分镜" @close="emit('close')">
    <template v-if="candidate && document">
      <p>
        任务尚未通过。这里仅查看已保存候选。转入草稿后，页面中的编辑会自动保存；已有问题仍需逐项核对，转入操作不会自动修复问题或使
        AI 审校通过。
      </p>
      <div v-if="candidate.originalDocument" class="candidate-actions">
        <button :aria-pressed="original" @click="original = true">修订前</button>
        <button :aria-pressed="!original" @click="original = false">修订候选</button>
      </div>
      <section v-for="issue in candidate.issues" :key="issue.id" class="candidate-issue">
        <h4>{{ issue.severity === 'ERROR' ? '需修改' : '建议' }} · {{ issue.title }}</h4>
        <p>{{ issue.impact }}</p>
        <p>{{ issue.suggestedFix }}</p>
      </section>
      <section v-for="clip in document.videoPlan.clips" :key="clip.id" class="candidate-clip">
        <h4>{{ clip.title }} · {{ videoClipMs(document.videoPlan, clip) / 1000 }} 秒</h4>
        <p>{{ clip.transition }}</p>
        <article v-for="shot in videoClipShots(document.videoPlan, clip)" :key="shot.id">
          <strong>{{ shot.title }} · {{ shot.durationSeconds }} 秒 · {{ shot.shotType }}</strong>
          <p>{{ shot.visual }}</p>
          <p>{{ shot.startState }} → {{ shot.endState }}</p>
        </article>
      </section>
      <section class="candidate-clip">
        <h4>原稿声音与画面文字</h4>
        <p v-for="cue in document.videoPlan.cues" :key="cue.id">
          {{ videoCueText(document.videoPlan, cue) }}
        </p>
      </section>
      <p v-if="!candidate.validForDraft">
        候选的结构或引用尚未通过校验，只能查看，不能转入编辑草稿。
      </p>
      <div class="candidate-actions">
        <button
          :disabled="busy || !candidate.validForDraft || candidate.adopted || original"
          @click="emit('adopt')"
        >
          {{ candidate.adopted ? '已转入草稿' : '转入人工核对草稿' }}
        </button>
      </div>
    </template>
  </WorkflowInformationDialog>
</template>
<style scoped>
p {
  color: #667991;
  font-size: 13px;
  line-height: 1.8;
  white-space: pre-wrap;
}
h4 {
  color: #253751;
  margin: 0 0 10px;
}
.candidate-clip,
.candidate-issue {
  padding-top: 18px;
  margin-top: 18px;
  border-top: 1px solid #e5ebf3;
}
.candidate-clip article {
  margin-top: 16px;
  font-size: 13px;
}
.candidate-actions {
  display: flex;
  gap: 10px;
  margin-top: 16px;
}
button {
  padding: 10px 14px;
  border: 1px solid #ccdaf2;
  background: #fff;
  border-radius: 10px;
  color: #3665a6;
  cursor: pointer;
}
button[aria-pressed='true'] {
  background: #eff5ff;
}
button:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
