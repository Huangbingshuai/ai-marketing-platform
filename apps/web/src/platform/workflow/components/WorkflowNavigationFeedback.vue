<script setup lang="ts">
import { GitBranch, LoaderCircle } from '@lucide/vue';
withDefaults(
  defineProps<{
    pendingStepLabel?: string | null;
    contextSwitching?: boolean;
    branchToast?: string;
  }>(),
  { pendingStepLabel: null, contextSwitching: false, branchToast: '' },
);
</script>

<template>
  <Teleport to="body">
    <Transition name="branch-switch-toast">
      <div v-if="branchToast" class="branch-switch-toast" role="status" aria-live="polite">
        <GitBranch :size="18" aria-hidden="true" /><span>{{ branchToast }}</span>
      </div>
    </Transition>
  </Teleport>
  <Transition name="run-switch">
    <div v-if="contextSwitching" class="run-switch-curtain" role="status" aria-live="polite">
      <div class="run-switch-card">
        <span class="run-switch-card__icon"><GitBranch :size="20" /></span>
        <span
          ><strong>正在切换编辑状态</strong><small>当前节点保持可见，正在载入对应版本</small></span
        >
        <LoaderCircle class="spin" :size="18" />
      </div>
    </div>
  </Transition>
  <Transition name="node-switch">
    <div
      v-if="pendingStepLabel !== null"
      class="node-switch-progress"
      role="status"
      aria-live="polite"
    >
      <LoaderCircle class="spin" :size="18" />
      <span
        ><strong>正在切换到{{ pendingStepLabel }}</strong
        ><small>保存当前草稿并准备目标节点…</small></span
      >
    </div>
  </Transition>
</template>

<style scoped>
.run-switch-curtain {
  position: fixed;
  z-index: 1080;
  inset: 0;
  display: grid;
  place-items: center;
  background: #f4f7ff24;
  backdrop-filter: blur(1.5px);
}
.run-switch-card {
  display: flex;
  align-items: center;
  gap: 13px;
  min-width: min(360px, calc(100vw - 32px));
  padding: 14px 17px;
  color: #193565;
  background: #fff;
  border: 1px solid #cbdcfa;
  border-radius: 16px;
  box-shadow: 0 20px 50px #17305b30;
}
.run-switch-card__icon {
  display: grid;
  flex: 0 0 39px;
  height: 39px;
  place-items: center;
  color: #285ff0;
  background: #eaf0ff;
  border-radius: 11px;
}
.run-switch-card > span:nth-child(2) {
  display: grid;
  flex: 1;
  gap: 3px;
}
.run-switch-card strong {
  font-size: 13px;
}
.run-switch-card small {
  color: #71809b;
  font-size: 11px;
}
.run-switch-card > svg {
  color: #285ff0;
}
.run-switch-enter-active,
.run-switch-leave-active {
  transition: opacity 0.16s ease;
}
.run-switch-enter-from,
.run-switch-leave-to {
  opacity: 0;
}
.node-switch-progress {
  position: fixed;
  top: 144px;
  left: 50%;
  z-index: 1090;
  display: flex;
  min-width: 290px;
  padding: 12px 16px;
  align-items: center;
  gap: 11px;
  color: #23416f;
  background: #f8fbff;
  border: 1px solid #bfd2fa;
  border-radius: 13px;
  box-shadow: 0 14px 34px #173b7930;
  transform: translateX(-50%);
}
.node-switch-progress > svg {
  flex: 0 0 auto;
  color: var(--effect-blue, #2563eb);
}
.node-switch-progress span {
  display: grid;
  gap: 2px;
}
.node-switch-progress strong {
  font-size: 12px;
}
.node-switch-progress small {
  color: #71809a;
  font-size: 10px;
}
.node-switch-enter-active,
.node-switch-leave-active {
  transition: 0.16s ease;
}
.node-switch-enter-from,
.node-switch-leave-to {
  opacity: 0;
  transform: translate(-50%, -8px);
}
.branch-switch-toast {
  position: fixed;
  top: 50%;
  left: 50%;
  z-index: 1500;
  display: flex;
  align-items: center;
  gap: 10px;
  max-width: calc(100vw - 32px);
  padding: 15px 20px;
  color: #fff;
  background: #172d58;
  border: 1px solid #4364a2;
  border-radius: 12px;
  box-shadow: 0 18px 50px #15264b50;
  font-size: 14px;
  font-weight: 700;
  line-height: 1.5;
  pointer-events: none;
  transform: translate(-50%, -50%);
}
.branch-switch-toast-enter-active,
.branch-switch-toast-leave-active {
  transition:
    opacity 0.35s ease,
    transform 0.45s ease;
}
.branch-switch-toast-enter-from {
  opacity: 0;
  transform: translate(-50%, calc(-50% + 18px));
}
.branch-switch-toast-leave-to {
  opacity: 0;
  transform: translate(-50%, calc(-50% - 48px));
}
@media (prefers-reduced-motion: reduce) {
  .branch-switch-toast-enter-active,
  .branch-switch-toast-leave-active {
    transition-duration: 0.01ms;
  }
}
.spin {
  animation: workflow-spin 1s linear infinite;
}
@keyframes workflow-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
