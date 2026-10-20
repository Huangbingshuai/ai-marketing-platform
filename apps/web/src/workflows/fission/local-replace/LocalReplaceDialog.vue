<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { X } from '@lucide/vue';
defineProps<{ title: string; description?: string; kind?: string }>();
const emit = defineEmits<{ close: [] }>();
const dialog = ref<HTMLElement>();
let returnFocus: HTMLElement | null = null;
const keyboard = (event: KeyboardEvent): void => {
  if (event.key === 'Escape') {
    event.preventDefault();
    emit('close');
  }
  if (event.key !== 'Tab') return;
  const nodes = [
    ...(dialog.value?.querySelectorAll<HTMLElement>(
      'button:not(:disabled),input:not(:disabled),select,textarea,[tabindex="0"]',
    ) ?? []),
  ];
  const first = nodes[0],
    last = nodes.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last?.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first?.focus();
  }
};
onMounted(async () => {
  returnFocus = document.activeElement as HTMLElement;
  document.addEventListener('keydown', keyboard);
  await nextTick();
  dialog.value?.querySelector<HTMLElement>('button')?.focus();
});
onBeforeUnmount(() => {
  document.removeEventListener('keydown', keyboard);
  returnFocus?.focus();
});
</script>
<template>
  <div class="lr-mask" @click.self="emit('close')">
    <section
      ref="dialog"
      :class="['lr-library', kind]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="lr-dialog-title"
    >
      <header>
        <div class="lr-dialog-heading">
          <slot name="title-icon" />
          <div>
            <h2 id="lr-dialog-title">{{ title }}</h2>
            <p>{{ description }}</p>
          </div>
        </div>
        <slot name="header-extra" />
        <button class="lr-icon-btn" aria-label="关闭弹窗" @click="emit('close')">
          <X :size="18" />
        </button>
      </header>
      <slot />
      <footer><slot name="footer" /></footer>
    </section>
  </div>
</template>
