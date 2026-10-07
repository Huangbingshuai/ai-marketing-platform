<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { Download } from '@lucide/vue';
import { ApiClientError, isAbortError } from '../../../api/http-client';
import type { AssetDocument } from '../asset-document';
import { assetFileFormat, formatAssetSize, type BrowserAsset } from '../project-asset-browser';
import { parseSourceDocx, readSourceDocument, sourceDocumentMode } from '../asset-source-document';
import AssetDocumentReader from './AssetDocumentReader.vue';

const props = defineProps<{ item: BrowserAsset }>();
const mode = computed(() => sourceDocumentMode(props.item));
const content = ref<AssetDocument | null>(null);
const loading = ref(false);
const error = ref('');
const pdfUrl = ref('');
let request: AbortController | undefined;
let generation = 0;
function releasePdf(): void {
  if (pdfUrl.value) URL.revokeObjectURL(pdfUrl.value);
  pdfUrl.value = '';
}
async function read(): Promise<void> {
  request?.abort();
  releasePdf();
  const controller = new AbortController();
  request = controller;
  const stamp = ++generation;
  const item = props.item;
  const selectedMode = sourceDocumentMode(item);
  const current = () => stamp === generation && !controller.signal.aborted;
  error.value = '';
  content.value = null;
  loading.value = true;
  try {
    if (selectedMode === 'UNSUPPORTED')
      throw new Error(`暂不支持 ${assetFileFormat(item)} 在线阅读，请下载原文件查看。`);
    const blob = await readSourceDocument(item, controller.signal);
    if (!current()) return;
    if (selectedMode === 'PDF') {
      pdfUrl.value = URL.createObjectURL(blob);
      return;
    }
    const text =
      selectedMode === 'DOCX'
        ? await parseSourceDocx(await blob.arrayBuffer(), controller.signal)
        : await blob.text();
    if (!current()) return;
    if (text.length > 1_000_000) throw new Error('文档正文过大，请下载原文件查看完整内容。');
    content.value = {
      title: item.name,
      sections: text.trim()
        ? [{ title: '文档正文', fields: [{ label: '', value: text.trim() }] }]
        : [],
    };
  } catch (caught) {
    if (!current() || isAbortError(caught)) return;
    error.value =
      caught instanceof ApiClientError
        ? `原文件读取失败（HTTP ${caught.status}），请重试。`
        : caught instanceof TypeError
          ? '原文件读取失败，请检查网络后重试。'
          : caught instanceof Error
            ? caught.message
            : '文档读取失败，请重试。';
  } finally {
    if (current()) loading.value = false;
  }
}
watch(
  () => [
    props.item.id,
    props.item.contentUrl,
    props.item.unavailable,
    props.item.source.kind === 'working'
      ? props.item.source.artifact.revision
      : props.item.source.asset.updatedAt,
  ],
  () => void read(),
  { immediate: true },
);
onBeforeUnmount(() => {
  generation++;
  request?.abort();
  releasePdf();
});
</script>

<template>
  <div class="source-document">
    <AssetDocumentReader
      v-if="mode !== 'PDF'"
      :item="item"
      :content="content"
      :loading="loading"
      :error="error"
      @retry="read"
    >
      <template #actions>
        <a
          v-if="item.downloadUrl && !item.unavailable"
          :href="item.downloadUrl"
          target="_blank"
          rel="noreferrer"
          ><Download :size="15" />下载原文件</a
        >
      </template>
    </AssetDocumentReader>
    <article v-else class="pdf-reader" :aria-label="item.name">
      <header>
        <h2>{{ item.name }}</h2>
        <a
          v-if="item.downloadUrl && !item.unavailable"
          :href="item.downloadUrl"
          target="_blank"
          rel="noreferrer"
          ><Download :size="15" />下载原文件</a
        >
      </header>
      <p v-if="loading" role="status">正在读取文档正文…</p>
      <div v-else-if="error" role="alert">
        <p>{{ error }}</p>
        <button type="button" @click="read">重新读取</button>
      </div>
      <object
        v-else-if="pdfUrl"
        :data="pdfUrl"
        type="application/pdf"
        :aria-label="`${item.name} 内容`"
      >
        <p>当前浏览器不支持 PDF 在线阅读，请下载原文件查看。</p>
      </object>
    </article>
    <p class="file-info">
      {{ assetFileFormat(item) }} · {{ formatAssetSize(item.sizeBytes) }} · 原始资料
    </p>
  </div>
</template>

<style scoped>
.source-document {
  min-width: 0;
}
.file-info {
  margin: 8px 4px 0;
  color: #72809a;
  font-size: 11px;
}
.pdf-reader {
  padding: 24px 28px;
  background: #fff;
  border: 1px solid #dce5f2;
  border-radius: 8px;
  color: #17263f;
}
header {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  margin-bottom: 20px;
}
h2 {
  margin: 0;
  font-size: 17px;
  overflow-wrap: anywhere;
}
a,
button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  border: 1px solid #dce5f2;
  border-radius: 6px;
  background: #f8faff;
  color: #2563eb;
  font: inherit;
  font-size: 12px;
  text-decoration: none;
  cursor: pointer;
}
a:focus-visible,
button:focus-visible {
  outline: 2px solid #2563eb;
  outline-offset: 3px;
}
p {
  font-size: 13px;
  line-height: 1.7;
}
[role='alert'] {
  color: #a6605e;
}
object {
  display: block;
  width: 100%;
  height: 680px;
  border: 0;
}
@media (max-width: 650px) {
  .pdf-reader {
    padding: 18px 16px;
  }
  object {
    height: 500px;
  }
}
</style>
