<script setup lang="ts">
withDefaults(
  defineProps<{
    backLabel?: string;
    complete?: boolean;
    nextDisabled?: boolean;
    nextLabel: string;
    statusDetail: string;
    statusTitle: string;
    validateDisabled?: boolean;
    validating?: boolean;
  }>(),
  {
    backLabel: '',
    complete: false,
    nextDisabled: false,
    validateDisabled: false,
    validating: false,
  },
);

defineEmits<{
  back: [];
  next: [];
  validate: [];
}>();
</script>

<template>
  <footer class="workflow-node-footer">
    <button
      v-if="backLabel"
      class="workflow-node-footer__back"
      type="button"
      @click="$emit('back')"
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="m15 18-6-6 6-6" />
      </svg>
      {{ backLabel }}
    </button>

    <div
      class="workflow-node-footer__status"
      :class="{ complete }"
      role="status"
      aria-live="polite"
    >
      <svg v-if="complete" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <path d="m8.5 12 2.2 2.2 4.8-5" />
      </svg>
      <svg v-else viewBox="0 0 24 24" aria-hidden="true">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
        <path d="M14 2v6h6M9 15l2 2 4-4" />
      </svg>
      <span>
        <strong>{{ statusTitle }}</strong>
        <small>{{ statusDetail }}</small>
      </span>
    </div>

    <div class="workflow-node-footer__actions">
      <button type="button" :disabled="validateDisabled || validating" @click="$emit('validate')">
        <span v-if="validating" class="workflow-node-footer__spinner" aria-hidden="true" />
        <svg v-else viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          <path d="m8.5 12 2.2 2.2 4.8-5" />
        </svg>
        {{ validating ? '正在校验…' : '完成校验' }}
      </button>
      <button
        class="workflow-node-footer__next"
        type="button"
        :disabled="nextDisabled"
        @click="$emit('next')"
      >
        {{ nextLabel }}
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="m9 18 6-6-6-6" />
        </svg>
      </button>
    </div>
  </footer>
</template>

<style scoped>
.workflow-node-footer {
  display: flex;
  min-height: 72px;
  margin-top: 14px;
  padding: 13px 16px;
  box-sizing: border-box;
  align-items: center;
  gap: 8px;
  background: #fff;
  border: 1px solid #f0e0d7;
  border-radius: 20px;
  box-shadow: 0 8px 25px #7a4e3b12;
}
.workflow-node-footer__status {
  display: flex;
  min-width: 220px;
  margin-right: auto;
  align-items: center;
  gap: 8px;
  color: #718096;
}
.workflow-node-footer__status.complete {
  color: #168361;
}
.workflow-node-footer__status > svg {
  width: 17px;
  height: 17px;
  flex: 0 0 17px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.workflow-node-footer__status strong,
.workflow-node-footer__status small {
  display: block;
}
.workflow-node-footer__status strong {
  color: #41516a;
  font-size: 10px;
}
.workflow-node-footer__status small {
  margin-top: 3px;
  color: #718096;
  font-size: 8px;
}
.workflow-node-footer__actions {
  display: flex;
  gap: 8px;
}
.workflow-node-footer button {
  display: inline-flex;
  height: 35px;
  padding: 0 12px;
  box-sizing: border-box;
  align-items: center;
  justify-content: center;
  gap: 5px;
  color: #41516a;
  background: #fff;
  border: 1px solid #d3ddea;
  border-radius: 8px;
  font: inherit;
  font-size: 10px;
  font-weight: 800;
  cursor: pointer;
}
.workflow-node-footer button > svg {
  width: 15px;
  height: 15px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.workflow-node-footer button.workflow-node-footer__next {
  color: #fff;
  background: #2563eb;
  border-color: #2563eb;
}
.workflow-node-footer button:disabled {
  cursor: not-allowed;
  opacity: 0.48;
}
.workflow-node-footer__spinner {
  width: 13px;
  height: 13px;
  box-sizing: border-box;
  border: 2px solid #9aabc2;
  border-top-color: transparent;
  border-radius: 50%;
  animation: workflow-node-footer-spin 700ms linear infinite;
}
@keyframes workflow-node-footer-spin {
  to {
    transform: rotate(360deg);
  }
}
@media (max-width: 1080px) {
  .workflow-node-footer {
    align-items: stretch;
    flex-wrap: wrap;
  }
  .workflow-node-footer__status {
    min-width: 0;
    flex: 1;
  }
  .workflow-node-footer__actions {
    margin-left: auto;
  }
}
@media (max-width: 680px) {
  .workflow-node-footer__back,
  .workflow-node-footer__status,
  .workflow-node-footer__actions {
    width: 100%;
  }
  .workflow-node-footer__actions button {
    flex: 1;
  }
}
</style>
