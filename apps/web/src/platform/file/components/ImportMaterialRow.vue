<script setup lang="ts">
defineProps<{ name: string; description?: string | undefined; error?: string | undefined }>();
</script>
<template>
  <div class="material-file-row" :class="{ failed: error }">
    <slot name="preview" />
    <span class="file-copy"
      ><strong :title="name">{{ name }}</strong
      ><small>{{ description }}</small
      ><small v-if="error" class="row-error" role="alert">{{ error }}</small
      ><slot name="details"
    /></span>
    <slot name="actions" />
  </div>
</template>
<style scoped src="./import-source.css"></style>
<style scoped>
.row-error {
  color: #d84c4f;
  white-space: normal;
}
:deep(button),
:deep(a) {
  display: inline-flex;
  min-height: 26px;
  padding: 0 7px;
  align-items: center;
  gap: 4px;
  color: #667085;
  background: #fff;
  border: 1px solid #e5ddd8;
  border-radius: 7px;
  font-size: 9px;
  text-decoration: none;
}
:deep(button.file-read) {
  color: #2563eb;
  border-color: #cfddfb;
}
:deep(button.file-delete) {
  color: #a6acb7;
  border-color: transparent;
}
:deep(button:disabled) {
  cursor: not-allowed;
  opacity: 0.55;
}
:deep(em) {
  font-size: 9px;
  font-style: normal;
  white-space: nowrap;
  color: #218564;
}
:deep(.material-thumbnail) {
  display: flex;
  width: 48px;
  height: 48px;
  flex: 0 0 48px;
  overflow: hidden;
  background: #f8f5f3;
  border: 1px solid #f0e3dc;
  border-radius: 9px;
}
:deep(.material-thumbnail img) {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
:deep(.file-extension) {
  min-width: 38px;
  padding: 4px 6px;
  box-sizing: border-box;
  color: #d84c4f;
  background: #fff0ed;
  border-radius: 8px;
  text-align: center;
  font-size: 9px;
  font-weight: 900;
}
</style>
