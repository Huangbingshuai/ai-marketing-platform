<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
defineProps<{ title: string; panelClass: string }>();
const emit = defineEmits<{ close: [] }>();
const root = ref<HTMLElement>();
const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
function keydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    emit('close');
  }
  if (event.key !== 'Tab') return;
  const nodes = [
    ...(root.value?.querySelectorAll<HTMLElement>(
      'button:not(:disabled),input:not(:disabled),select,textarea,[tabindex="0"]',
    ) ?? []),
  ].filter((el) => el.getClientRects().length);
  const first = nodes[0],
    last = nodes.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last?.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first?.focus();
  }
}
onMounted(async () => {
  await nextTick();
  root.value?.querySelector<HTMLElement>('input,textarea,button')?.focus();
});
onBeforeUnmount(() => previous?.isConnected && previous.focus());
</script>
<template>
  <Teleport to="body"
    ><div class="fas-modal-mask" @click.self="emit('close')" @keydown="keydown">
      <section ref="root" :class="panelClass" role="dialog" aria-modal="true" :aria-label="title">
        <slot />
      </section></div
  ></Teleport>
</template>
