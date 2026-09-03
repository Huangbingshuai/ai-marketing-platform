<script setup lang="ts">
import { AlertTriangle } from '@lucide/vue';
import { nextTick, onBeforeUnmount, ref, watch } from 'vue';

import { useActionConfirmation } from '../composables/action-confirmation';

const { state, confirm, cancel } = useActionConfirmation();
const confirmButton = ref<HTMLButtonElement | null>(null);
let trigger: HTMLElement | null = null;

watch(
  () => state.open,
  async (open) => {
    if (open) {
      trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      await nextTick();
      confirmButton.value?.focus();
      return;
    }
    const target = trigger;
    trigger = null;
    await nextTick();
    if (target?.isConnected) target.focus();
  },
);

onBeforeUnmount(cancel);
</script>

<template>
  <Teleport to="body">
    <div v-if="state.open" class="action-confirmation-backdrop" @mousedown.self="cancel">
      <section
        class="action-confirmation-dialog"
        :class="`action-confirmation-dialog--${state.tone}`"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="action-confirmation-title"
        aria-describedby="action-confirmation-description"
        tabindex="-1"
        @keydown.esc="cancel"
      >
        <span class="action-confirmation-icon" aria-hidden="true">
          <AlertTriangle :size="21" />
        </span>
        <div class="action-confirmation-copy">
          <small v-if="state.eyebrow">{{ state.eyebrow }}</small>
          <h2 id="action-confirmation-title">{{ state.title }}</h2>
          <p id="action-confirmation-description">{{ state.description }}</p>
        </div>
        <footer>
          <button type="button" @click="cancel">{{ state.cancelLabel }}</button>
          <button
            ref="confirmButton"
            class="action-confirmation-primary"
            type="button"
            @click="confirm"
          >
            {{ state.confirmLabel }}
          </button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.action-confirmation-backdrop {
  position: fixed;
  z-index: 1800;
  inset: 0;
  display: grid;
  padding: 24px;
  place-items: center;
  background: rgb(26 35 51 / 48%);
  backdrop-filter: blur(3px);
}
.action-confirmation-dialog {
  display: grid;
  width: min(460px, 100%);
  padding: 24px;
  grid-template-columns: 44px minmax(0, 1fr);
  gap: 14px;
  color: #26334a;
  background: #fff;
  border: 1px solid #e1e7f0;
  border-radius: 18px;
  box-shadow: 0 24px 70px rgb(31 45 70 / 24%);
}
.action-confirmation-icon {
  display: grid;
  width: 42px;
  height: 42px;
  place-items: center;
  color: #b77913;
  background: #fff5db;
  border-radius: 13px;
}
.action-confirmation-dialog--danger .action-confirmation-icon {
  color: #d83b49;
  background: #fff0f1;
}
.action-confirmation-copy small {
  color: #9b6a17;
  font-size: 11px;
  font-weight: 800;
}
.action-confirmation-dialog--danger .action-confirmation-copy small {
  color: #d83b49;
}
.action-confirmation-copy h2 {
  margin: 4px 0 8px;
  color: #202d43;
  font-size: 18px;
  line-height: 1.35;
}
.action-confirmation-copy p {
  margin: 0;
  color: #68758a;
  font-size: 13px;
  line-height: 1.7;
}
.action-confirmation-dialog footer {
  display: flex;
  grid-column: 1 / -1;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 8px;
}
.action-confirmation-dialog footer button {
  min-width: 92px;
  height: 38px;
  padding: 0 16px;
  color: #526078;
  background: #fff;
  border: 1px solid #dce3ee;
  border-radius: 10px;
  font: inherit;
  font-size: 13px;
  font-weight: 700;
  cursor: pointer;
}
.action-confirmation-dialog footer .action-confirmation-primary {
  color: #fff;
  background: #d48a16;
  border-color: #d48a16;
}
.action-confirmation-dialog--danger footer .action-confirmation-primary {
  background: #e24654;
  border-color: #e24654;
}
.action-confirmation-dialog footer button:focus-visible {
  outline: 3px solid rgb(47 111 237 / 22%);
  outline-offset: 2px;
}
@media (max-width: 520px) {
  .action-confirmation-backdrop {
    padding: 14px;
  }
  .action-confirmation-dialog {
    padding: 20px;
    grid-template-columns: 40px minmax(0, 1fr);
  }
  .action-confirmation-dialog footer {
    display: grid;
    grid-template-columns: 1fr 1fr;
  }
  .action-confirmation-dialog footer button {
    min-width: 0;
  }
}
</style>
