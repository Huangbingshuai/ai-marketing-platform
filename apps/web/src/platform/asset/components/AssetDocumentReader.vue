<script setup lang="ts">
import { computed } from 'vue';
import { Download } from '@lucide/vue';
import { assetDocument, type AssetDocument } from '../asset-document';
import { formatAssetTime, type BrowserAsset } from '../project-asset-browser';

const props = defineProps<{
  item: BrowserAsset;
  content?: AssetDocument | null;
  loading?: boolean;
  error?: string;
}>();
defineEmits<{ export: [item: BrowserAsset]; retry: [] }>();
const document = computed(() =>
  props.content === undefined ? assetDocument(props.item) : props.content,
);
const hasContent = computed(() =>
  document.value?.sections.some((section) => section.fields.length),
);
</script>

<template>
  <article class="document-reader" :aria-label="item.name">
    <header>
      <div>
        <h2>{{ document?.title ?? item.name }}</h2>
        <p>{{ item.status }} · 更新于 {{ formatAssetTime(item.updatedAt) }}</p>
      </div>
      <slot name="actions"
        ><button
          type="button"
          :disabled="!hasContent || item.unavailable"
          @click="$emit('export', item)"
        >
          <Download :size="15" />导出文档
        </button></slot
      >
    </header>
    <p v-if="loading" class="document-empty" role="status">正在读取文档正文…</p>
    <div v-else-if="error" class="document-error" role="alert">
      <p>{{ error }}</p>
      <button type="button" @click="$emit('retry')">重新读取</button>
    </div>
    <p v-else-if="!hasContent" class="document-empty">此版本暂无可阅读的文档内容。</p>
    <section
      v-for="(section, index) in loading || error ? [] : document?.sections"
      :key="index"
      class="document-section"
    >
      <h3>{{ section.title }}</h3>
      <dl>
        <div v-for="(field, fieldIndex) in section.fields" :key="fieldIndex">
          <dt v-if="field.label">{{ field.label }}</dt>
          <dd :class="{ 'full-width': !field.label }">{{ field.value }}</dd>
        </div>
      </dl>
    </section>
  </article>
</template>

<style scoped>
.document-reader {
  min-width: 0;
  border: 1px solid #dce5f2;
  border-radius: 8px;
  background: #fff;
  padding: 24px 28px;
  color: #17263f;
}
header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  padding-bottom: 20px;
}
header > div {
  min-width: 0;
}
h2 {
  margin: 0;
  font-size: 17px;
  font-weight: 600;
  overflow-wrap: anywhere;
}
header p,
.document-empty {
  font-size: 12px;
  color: #72809a;
  margin: 8px 0 0;
}
button,
:slotted(a) {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  padding: 8px 12px;
  border: 1px solid #dce5f2;
  border-radius: 6px;
  background: #f8faff;
  color: #2563eb;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  text-decoration: none;
}
button:hover:not(:disabled) {
  background: #eaf1ff;
  border-color: #b8cefa;
}
button:focus-visible {
  outline: 2px solid #2563eb;
  outline-offset: 3px;
}
button:disabled {
  opacity: 0.48;
  cursor: not-allowed;
}
.document-section {
  padding: 20px 0;
  border-top: 1px solid #e4eaf4;
}
.document-section:last-child {
  padding-bottom: 0;
}
h3 {
  margin: 0 0 16px;
  font-size: 14px;
  font-weight: 600;
  color: #2563eb;
}
dl {
  margin: 0;
}
dl > div {
  display: grid;
  grid-template-columns: 86px minmax(0, 1fr);
  gap: 16px;
  margin: 12px 0;
  font-size: 13px;
  line-height: 1.8;
}
dt {
  color: #72809a;
}
dd {
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.full-width {
  grid-column: 1 / -1;
}
.document-error {
  color: #a6605e;
  font-size: 13px;
  line-height: 1.7;
}
@media (max-width: 650px) {
  .document-reader {
    padding: 18px 16px;
  }
  header {
    flex-wrap: wrap;
  }
  h2 {
    font-size: 15px;
  }
  dl > div {
    grid-template-columns: 1fr;
    gap: 4px;
    margin: 16px 0;
  }
}
</style>
