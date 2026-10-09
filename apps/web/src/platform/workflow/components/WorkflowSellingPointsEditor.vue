<script setup lang="ts">
import { useId } from 'vue';
import { Plus, Trash2 } from '@lucide/vue';
const props = withDefaults(
  defineProps<{
    items: string[];
    readonly?: boolean;
    showHeading?: boolean;
    singleColumn?: boolean;
    title?: string;
  }>(),
  { readonly: false, showHeading: true, singleColumn: false, title: '卖点' },
);
const emit = defineEmits<{
  add: [];
  remove: [index: number];
  'update-item': [index: number, value: string];
}>();
const headingId = useId();
const updateItem = (index: number, value: string) => {
  if (!props.readonly) emit('update-item', index, value);
};
</script>

<template>
  <div class="selling-editor" role="group" :aria-label="title">
    <div v-if="showHeading" class="selling-editor-heading">
      <div class="selling-editor-title">
        <h4 :id="headingId" data-information-label>{{ title }}</h4>
        <small>{{ items.length }} 条</small>
        <slot name="heading-source" />
      </div>
      <button
        class="selling-add-button"
        type="button"
        :disabled="readonly"
        title="添加一个卖点"
        @click="!readonly && emit('add')"
      >
        <Plus :size="13" />添加
      </button>
    </div>
    <div
      class="selling-points selling-points--unified"
      :class="{ 'selling-points--single': singleColumn }"
    >
      <p v-if="!items.length" class="empty-inline">暂无卖点，可点击“添加”补充。</p>
      <div v-for="(point, index) in items" :key="index" class="selling-point-row">
        <input
          :value="point"
          :aria-label="`卖点 ${index + 1}`"
          :readonly="readonly"
          placeholder="例如：原料、工艺、功能、口味、用法、场景或可信背书"
          @input="updateItem(index, ($event.target as HTMLInputElement).value)"
        />
        <slot name="source" :index="index" />
        <button
          class="selling-remove-button"
          type="button"
          aria-label="删除卖点"
          :disabled="readonly"
          @click="!readonly && emit('remove', index)"
        >
          <Trash2 :size="14" />
        </button>
        <slot name="notice" :index="index" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.selling-editor {
  min-width: 0;
}
.selling-editor-heading {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}
.selling-editor-title {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  min-width: 0;
}
h4 {
  margin: 0;
  color: #596278;
  font-size: 14px;
  font-weight: 650;
}
small {
  color: #8492a8;
  font-size: 11px;
}
.selling-add-button {
  display: inline-flex;
  height: 40px;
  padding: 0 18px;
  align-items: center;
  gap: 5px;
  color: #42526a;
  background: #fff;
  border: 1px solid #dbe4f6;
  border-radius: 10px;
  font-size: 14px;
  font-weight: 700;
}
button {
  cursor: pointer;
}
button:disabled {
  opacity: 0.55;
  cursor: default;
}
button:focus-visible {
  outline: 2px solid #7da7ef;
  outline-offset: 3px;
}
.selling-point-row input {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  height: 40px;
  padding: 0 11px;
  color: #42526a;
  background: #fff;
  border: 1px solid #dce3ec;
  border-radius: 10px;
  outline: 0;
  font: inherit;
  font-size: 14px;
  font-weight: 400;
}
.selling-point-row input:focus {
  border-color: #7da7ef;
  box-shadow: 0 0 0 3px #2563eb14;
}
.empty-inline {
  margin: 0;
  color: #8a98ad;
  font-size: 12px;
}
.selling-points {
  display: grid;
  gap: 10px;
}
.selling-points--unified {
  margin-top: 12px;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  align-items: start;
}
.selling-points--unified > .empty-inline {
  grid-column: 1 / -1;
}
.selling-point-row {
  display: grid;
  align-items: center;
  grid-template-columns: minmax(0, 1fr) 38px;
  gap: 8px;
}
.selling-point-row :deep(em) {
  max-width: min(100%, 280px);
  height: 22px;
  padding: 0;
  grid-column: 1;
  justify-self: start;
  overflow: hidden;
  color: #8057c7;
  background: transparent;
  border-radius: 0;
  font-size: 10px;
  font-weight: 650;
  line-height: 22px;
  text-overflow: ellipsis;
}
.selling-point-row :deep(em::before) {
  margin-right: 4px;
  color: #9a86c4;
  content: '✦';
}
.selling-point-row :deep(.semantic-fact-notice) {
  display: flex;
  min-width: 0;
  margin: -2px 0 2px;
  padding: 7px 9px;
  align-items: flex-start;
  gap: 6px;
  color: #9a6508;
  background: #fff8e8;
  border: 1px solid #f5deb0;
  border-radius: 8px;
  font-size: 11px;
  line-height: 1.45;
  grid-column: 1 / -1;
}
.selling-point-row :deep(.semantic-fact-notice svg) {
  flex: 0 0 auto;
  margin-top: 1px;
}
.selling-point-row :deep(.semantic-fact-notice > span) {
  min-width: 0;
  flex: 1;
}
.selling-point-row button {
  display: grid;
  width: 38px;
  height: 40px;
  padding: 0;
  place-items: center;
  color: #7b8799;
  background: #fff;
  border: 1px solid #dbe4f6;
  border-radius: 10px;
  grid-column: 2;
  grid-row: 1;
}
.selling-point-row :deep(button.semantic-fact-notice__dismiss) {
  display: grid;
  width: 22px;
  height: 22px;
  margin: -3px -4px -3px 2px;
  padding: 0;
  flex: 0 0 22px;
  place-items: center;
  color: #a97a27;
  background: transparent;
  border: 0;
  border-radius: 6px;
  grid-column: auto;
  grid-row: auto;
}
.selling-point-row :deep(button.semantic-fact-notice__dismiss:hover) {
  color: #7d5209;
  background: #f9e9bd;
}
.selling-point-row :deep(button.semantic-fact-notice__dismiss:focus-visible) {
  box-shadow: 0 0 0 2px #e9bd5d;
  outline: none;
}

.selling-point-row :deep(em) {
  display: inline-flex;
  width: fit-content;
  align-items: center;
  font-style: normal;
  white-space: nowrap;
}
.selling-point-row :deep(em[data-origin='AI_IMAGE_SUGGESTION']) {
  color: #77649d;
  background: transparent;
}
.selling-point-row :deep(em[data-origin='USER_FACT']) {
  display: none;
}
.selling-points--single {
  grid-template-columns: minmax(0, 1fr);
}
@media (max-width: 860px) {
  .selling-points--unified {
    grid-template-columns: 1fr;
  }
}
</style>
