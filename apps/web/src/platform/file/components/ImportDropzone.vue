<script setup lang="ts">
import { Plus } from '@lucide/vue';
import { ref } from 'vue';
withDefaults(
  defineProps<{
    accept: string;
    disabled?: boolean;
    compact?: boolean;
    prompt: string;
    hint?: string;
    formats?: string;
  }>(),
  { disabled: false, compact: false, hint: '', formats: '' },
);
const emit = defineEmits<{ files: [files: File[]] }>();
const dragging = ref(false);
const input = ref<HTMLInputElement | null>(null);
function choose(event: Event) {
  const target = event.target as HTMLInputElement;
  emit('files', Array.from(target.files ?? []));
  target.value = '';
}
</script>
<template>
  <div
    class="source-dropzone"
    :class="{ disabled, 'batch-dropzone': compact, dragging }"
    @dragover.prevent="dragging = !disabled"
    @dragleave.prevent="dragging = false"
    @drop.prevent="
      dragging = false;
      if (!disabled) emit('files', Array.from($event.dataTransfer?.files ?? []));
    "
  >
    <button
      type="button"
      class="dropzone-trigger"
      :disabled="disabled"
      :aria-label="prompt"
      @click="input?.click()"
    >
      <span class="dropzone-plus"><Plus :size="compact ? 20 : 25" /></span>
      <strong>{{ prompt }}</strong
      ><small v-if="hint">{{ hint }}</small
      ><small v-if="formats">{{ formats }}</small>
    </button>
    <input
      ref="input"
      type="file"
      hidden
      multiple
      :accept="accept"
      :disabled="disabled"
      @change="choose"
    />
  </div>
</template>
<style scoped src="./import-source.css"></style>
<style scoped>
.source-dropzone {
  padding: 0;
}
.dropzone-trigger {
  display: flex;
  width: 100%;
  min-height: inherit;
  padding: 24px;
  box-sizing: border-box;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: 8px;
  border: 0;
  background: transparent;
  cursor: pointer;
  border-radius: inherit;
}
.dropzone-trigger:focus-visible {
  outline: 2px solid #2563eb;
  outline-offset: 3px;
}
.source-dropzone.dragging {
  border-color: #2563eb;
  background: #f4f8ff;
}
.batch-dropzone .dropzone-trigger {
  padding: 12px;
}
</style>
