<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { X } from '@lucide/vue';
defineProps<{ title: string; wide?: boolean }>();
const emit = defineEmits<{ close: [] }>();
const dialog = ref<HTMLElement | null>(null);
let trigger: HTMLElement | null = null;
onMounted(async () => {
  trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  await nextTick();
  dialog.value?.focus();
});
onBeforeUnmount(() => {
  if (trigger?.isConnected) trigger.focus();
});
function trap(event: KeyboardEvent) {
  if (event.key !== 'Tab') return;
  const items = [
    ...(dialog.value?.querySelectorAll<HTMLElement>(
      'button:not(:disabled),input,textarea,select,[tabindex="0"]',
    ) ?? []),
  ];
  const first = items[0],
    last = items.at(-1);
  if (
    event.shiftKey &&
    (document.activeElement === first || document.activeElement === dialog.value)
  ) {
    event.preventDefault();
    last?.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first?.focus();
  }
}
</script>
<template>
  <Teleport to="body"
    ><div class="clone-studio">
      <div class="clone-dialog-mask" @mousedown.self="emit('close')">
        <section
          ref="dialog"
          class="clone-dialog"
          :class="{ wide }"
          role="dialog"
          aria-modal="true"
          aria-labelledby="clone-dialog-title"
          tabindex="-1"
          @keydown.esc.stop="emit('close')"
          @keydown="trap"
        >
          <header>
            <div>
              <h2 id="clone-dialog-title">{{ title }}</h2>
              <small>本地 Mock 演示</small>
            </div>
            <button class="frg-btn" aria-label="关闭弹窗" @click="emit('close')">
              <X :size="17" />
            </button>
          </header>
          <div class="clone-dialog-body"><slot /></div>
          <footer>
            <slot name="footer"
              ><button class="frg-btn primary" @click="emit('close')">关闭</button></slot
            >
          </footer>
        </section>
      </div>
    </div></Teleport
  >
</template>
