<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, useId, watch } from 'vue';
import { X } from '@lucide/vue';
const props = defineProps<{ open: boolean; title: string; description?: string }>();
const emit = defineEmits<{ close: [] }>();
const dialog = ref<HTMLDialogElement | null>(null);
const titleId = useId();
let trigger: HTMLElement | null = null;
watch(
  () => props.open,
  async (open) => {
    if (open)
      trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    await nextTick();
    if (open !== props.open || !dialog.value) return;
    if (open && !dialog.value.open) dialog.value.showModal();
    else if (!open && dialog.value.open) dialog.value.close();
  },
  { immediate: true },
);
const restoreFocus = () => {
  if (trigger?.isConnected) trigger.focus();
};
onBeforeUnmount(() => {
  dialog.value?.close();
  restoreFocus();
});
</script>

<template>
  <dialog
    ref="dialog"
    :aria-labelledby="titleId"
    @cancel.prevent="emit('close')"
    @close="restoreFocus"
    @click="$event.target === dialog && emit('close')"
  >
    <section class="information-dialog">
      <header>
        <div>
          <h2 :id="titleId">{{ title }}</h2>
          <p v-if="description">{{ description }}</p>
        </div>
        <button type="button" :aria-label="`关闭${title}`" autofocus @click="emit('close')">
          <X :size="20" />
        </button>
      </header>
      <div class="information-dialog__body"><slot /></div>
    </section>
  </dialog>
</template>

<style scoped>
dialog {
  box-sizing: border-box;
  width: min(900px, calc(100vw - 40px));
  max-height: calc(100dvh - 40px);
  padding: 0;
  color: #263247;
  background: #fff;
  border: 1px solid #dbe4f6;
  border-radius: 22px;
  box-shadow: 0 30px 90px #17233a33;
}
dialog::backdrop {
  background: #17233a66;
}
header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 22px 24px;
  border-bottom: 1px solid #e8edf5;
}
h2 {
  margin: 0;
  font-size: 19px;
}
p {
  margin: 7px 0 0;
  color: #7d899d;
  font-size: 12px;
  line-height: 1.6;
}
button {
  display: grid;
  flex-shrink: 0;
  width: 34px;
  height: 34px;
  place-items: center;
  color: #7285a3;
  background: #f5f7fb;
  border: 0;
  border-radius: 9px;
  cursor: pointer;
}
.information-dialog__body {
  padding: 22px 24px;
}
@media (max-width: 680px) {
  dialog {
    width: calc(100vw - 20px);
    max-height: calc(100dvh - 20px);
    border-radius: 16px;
  }
  header,
  .information-dialog__body {
    padding: 16px;
  }
}
</style>
