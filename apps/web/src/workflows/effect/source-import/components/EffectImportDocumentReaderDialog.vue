<script setup lang="ts">
import type { EffectImportMaterial, EffectImportMode } from '@ai-marketing/contracts';
import { ExternalLink, FileText, Image as ImageIcon, RefreshCw, X } from '@lucide/vue';
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { apiUrl, ApiClientError, isAbortError } from '../../../../api/http-client';
import {
  parseSourceDocx,
  readSourceDocumentAtPath,
  sourceDocumentModeFromFileName,
} from '../../../../platform/asset/asset-source-document';
import { effectImportMaterialContentPath } from '../api/effect-import.api';

const props = defineProps<{
  material: EffectImportMaterial;
  mode: EffectImportMode;
}>();

const emit = defineEmits<{ close: [] }>();
const closeButton = ref<HTMLButtonElement | null>(null);
const loading = ref(false);
const error = ref('');
const textContent = ref('');
const pdfUrl = ref('');
const imageSource = ref('');
let request: AbortController | undefined;
let generation = 0;

const fileName = computed(
  () =>
    props.material.originalFileName ||
    props.material.expectedFileName ||
    (props.material.type === 'PRODUCT_IMAGE' ? '商品图片' : '产品文档'),
);
const fileFormat = computed(() => {
  const dot = fileName.value.lastIndexOf('.');
  return dot >= 0 ? fileName.value.slice(dot + 1).toUpperCase() : 'FILE';
});
const documentMode = computed(() => sourceDocumentModeFromFileName(fileName.value));
const isImage = computed(() => props.material.type === 'PRODUCT_IMAGE');
const contentPath = computed(() =>
  effectImportMaterialContentPath(
    props.material.projectId,
    props.mode,
    props.material.productId,
    props.material.id,
  ),
);
const originalContentUrl = computed(() => apiUrl(contentPath.value));

function releasePdf(): void {
  if (pdfUrl.value) URL.revokeObjectURL(pdfUrl.value);
  pdfUrl.value = '';
}

async function read(): Promise<void> {
  request?.abort();
  releasePdf();
  imageSource.value = '';
  const controller = new AbortController();
  request = controller;
  const stamp = ++generation;
  const current = (): boolean => stamp === generation && !controller.signal.aborted;
  error.value = '';
  textContent.value = '';
  loading.value = true;
  let waitingForImage = false;
  try {
    if (!props.material.contentUrl) throw new Error('当前文件内容暂不可用，请稍后重试。');
    if (isImage.value) {
      if (
        /\.psd$/i.test(fileName.value) ||
        props.material.mimeType === 'image/vnd.adobe.photoshop'
      ) {
        throw new Error('PSD 文件暂不支持站内查看，请打开原文件查看。');
      }
      const version = encodeURIComponent(`${props.material.updatedAt}:${stamp}`);
      imageSource.value = `${originalContentUrl.value}?view=${version}`;
      waitingForImage = true;
      return;
    }
    if (documentMode.value === 'UNSUPPORTED') {
      throw new Error(`暂不支持 ${fileFormat.value} 站内阅读，请打开原文件查看。`);
    }
    const blob = await readSourceDocumentAtPath(
      contentPath.value,
      props.material.sizeBytes,
      documentMode.value,
      controller.signal,
    );
    if (!current()) return;
    if (documentMode.value === 'PDF') {
      pdfUrl.value = URL.createObjectURL(blob);
      return;
    }
    const text =
      documentMode.value === 'DOCX'
        ? await parseSourceDocx(await blob.arrayBuffer(), controller.signal)
        : await blob.text();
    if (!current()) return;
    if (text.length > 1_000_000) throw new Error('文档正文过大，请打开原文件查看完整内容。');
    textContent.value = text.trim();
  } catch (caught) {
    if (!current() || isAbortError(caught)) return;
    error.value =
      caught instanceof ApiClientError
        ? `文件读取失败（HTTP ${caught.status}），请重试。`
        : caught instanceof TypeError
          ? '文件读取失败，请检查网络后重试。'
          : caught instanceof Error
            ? caught.message
            : '文件读取失败，请重试。';
  } finally {
    if (current() && !waitingForImage) loading.value = false;
  }
}

function imageLoaded(source: string): void {
  if (source !== imageSource.value) return;
  error.value = '';
  loading.value = false;
}

function imageFailed(source: string): void {
  if (source !== imageSource.value) return;
  error.value = '图片加载失败，请重试或打开原文件查看。';
  loading.value = false;
}

function close(): void {
  emit('close');
}

onMounted(() => {
  void nextTick(() => closeButton.value?.focus());
  void read();
});

onBeforeUnmount(() => {
  generation++;
  request?.abort();
  releasePdf();
  imageSource.value = '';
});
</script>

<template>
  <Teleport to="body">
    <div class="document-reader-overlay" @mousedown.self="close">
      <section
        class="document-reader-dialog"
        role="dialog"
        aria-modal="true"
        :aria-label="`${fileName} 内容`"
        @keydown.esc.stop="close"
      >
        <header>
          <span class="document-icon">
            <ImageIcon v-if="isImage" :size="20" />
            <FileText v-else :size="20" />
          </span>
          <div class="document-title">
            <span>{{ fileFormat }}</span>
            <h2>{{ fileName }}</h2>
            <p>只读查看，不会修改草稿或工作副本</p>
          </div>
          <a v-if="material.contentUrl" :href="originalContentUrl" target="_blank" rel="noreferrer">
            <ExternalLink :size="15" />打开原文件
          </a>
          <button ref="closeButton" type="button" aria-label="关闭内容查看" @click="close">
            <X :size="18" />
          </button>
        </header>

        <main>
          <figure v-if="isImage && imageSource" class="image-reader">
            <img
              :src="imageSource"
              :alt="fileName"
              :class="{ loaded: !loading && !error }"
              :data-source="imageSource"
              @load="imageLoaded(($event.target as HTMLImageElement).dataset.source ?? '')"
              @error="imageFailed(($event.target as HTMLImageElement).dataset.source ?? '')"
            />
            <div v-if="loading" class="reader-state image-state" role="status">
              <RefreshCw class="spin" :size="22" />
              <strong>正在读取图片内容…</strong>
              <span>图片仅在当前项目范围内读取</span>
            </div>
            <div v-else-if="error" class="reader-state image-state reader-error" role="alert">
              <ImageIcon :size="28" />
              <strong>{{ error }}</strong>
              <button type="button" @click="read"><RefreshCw :size="14" />重新读取</button>
            </div>
            <figcaption v-else>按原始比例显示，图片内容不会被裁切</figcaption>
          </figure>
          <div v-else-if="loading" class="reader-state" role="status">
            <RefreshCw class="spin" :size="22" />
            <strong>正在读取文档内容…</strong>
            <span>文件仅在当前项目范围内读取</span>
          </div>
          <div v-else-if="error" class="reader-state reader-error" role="alert">
            <ImageIcon v-if="isImage" :size="28" />
            <FileText v-else :size="28" />
            <strong>{{ error }}</strong>
            <button type="button" @click="read"><RefreshCw :size="14" />重新读取</button>
          </div>
          <object
            v-else-if="pdfUrl"
            :data="pdfUrl"
            type="application/pdf"
            :aria-label="`${fileName} 正文`"
          >
            <p>当前浏览器不支持 PDF 站内阅读，请打开原文件查看。</p>
          </object>
          <pre v-else-if="textContent">{{ textContent }}</pre>
          <div v-else class="reader-state">
            <FileText :size="28" />
            <strong>文档中没有可读取的文字内容</strong>
            <span>可打开原文件检查图片、表格或其他内容</span>
          </div>
        </main>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.document-reader-overlay {
  position: fixed;
  z-index: 1200;
  inset: 0;
  display: grid;
  padding: 32px;
  place-items: center;
  background: #18243a75;
  backdrop-filter: blur(5px);
}
.document-reader-dialog {
  display: flex;
  width: min(960px, 100%);
  max-height: min(820px, calc(100vh - 64px));
  flex-direction: column;
  overflow: hidden;
  background: #fff;
  border: 1px solid #dfe6f1;
  border-radius: 22px;
  box-shadow: 0 28px 80px #14203836;
}
.document-reader-dialog > header {
  display: flex;
  min-height: 76px;
  padding: 15px 18px;
  box-sizing: border-box;
  align-items: center;
  gap: 12px;
  background: linear-gradient(135deg, #fff 0%, #f7faff 100%);
  border-bottom: 1px solid #e7ecf4;
}
.document-icon {
  display: grid;
  width: 42px;
  height: 42px;
  flex: 0 0 42px;
  place-items: center;
  color: #2563eb;
  background: #edf3ff;
  border-radius: 13px;
}
.document-title {
  min-width: 0;
  flex: 1;
}
.document-title > span {
  color: #d84c4f;
  font-size: 9px;
  font-weight: 900;
}
.document-title h2,
.document-title p {
  margin: 0;
}
.document-title h2 {
  overflow: hidden;
  color: #23314b;
  font-size: 15px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.document-title p {
  margin-top: 3px;
  color: #8b96aa;
  font-size: 10px;
}
.document-reader-dialog > header > a,
.document-reader-dialog > header > button,
.reader-state button {
  display: inline-flex;
  min-height: 34px;
  padding: 0 11px;
  align-items: center;
  justify-content: center;
  gap: 6px;
  color: #42516c;
  background: #fff;
  border: 1px solid #dce4f0;
  border-radius: 10px;
  text-decoration: none;
  font-size: 11px;
  font-weight: 700;
}
.document-reader-dialog > header > button {
  width: 34px;
  padding: 0;
}
.document-reader-dialog > main {
  min-height: 360px;
  flex: 1;
  overflow: auto;
  background: #f5f7fb;
}
.document-reader-dialog object {
  display: block;
  width: 100%;
  height: min(700px, calc(100vh - 142px));
  min-height: 480px;
  border: 0;
}
.image-reader {
  position: relative;
  display: flex;
  min-height: min(620px, calc(100vh - 142px));
  margin: 0;
  padding: 28px 28px 52px;
  box-sizing: border-box;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  background:
    linear-gradient(45deg, #edf1f7 25%, transparent 25%) 0 0 / 20px 20px,
    linear-gradient(-45deg, #edf1f7 25%, transparent 25%) 0 10px / 20px 20px,
    linear-gradient(45deg, transparent 75%, #edf1f7 75%) 10px -10px / 20px 20px,
    linear-gradient(-45deg, transparent 75%, #edf1f7 75%) -10px 0 / 20px 20px,
    #f8f9fc;
}
.image-reader > img {
  display: block;
  max-width: 100%;
  max-height: min(560px, calc(100vh - 205px));
  object-fit: contain;
  opacity: 0;
  border-radius: 10px;
  box-shadow: 0 18px 48px #1a294326;
}
.image-reader > img.loaded {
  opacity: 1;
}
.image-reader figcaption {
  position: absolute;
  right: 18px;
  bottom: 14px;
  left: 18px;
  color: #6f7c91;
  text-align: center;
  font-size: 10px;
}
.image-state {
  position: absolute;
  z-index: 1;
  inset: 0;
  min-height: 0;
  background: #f8f9fced;
}
.document-reader-dialog pre {
  width: min(780px, calc(100% - 48px));
  min-height: calc(100% - 48px);
  margin: 24px auto;
  padding: 34px 40px;
  box-sizing: border-box;
  overflow: visible;
  color: #26344e;
  background: #fff;
  border: 1px solid #e2e7f0;
  border-radius: 14px;
  box-shadow: 0 12px 36px #23314b0d;
  font:
    13px/1.85 ui-sans-serif,
    system-ui,
    sans-serif;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.reader-state {
  display: flex;
  min-height: 360px;
  padding: 32px;
  box-sizing: border-box;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: 9px;
  color: #748198;
  text-align: center;
}
.reader-state strong {
  color: #31405a;
  font-size: 13px;
}
.reader-state span {
  font-size: 10px;
}
.reader-error svg {
  color: #d84c4f;
}
.reader-state button {
  margin-top: 7px;
  color: #2563eb;
}
.spin {
  animation: spin 1s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
@media (max-width: 700px) {
  .document-reader-overlay {
    padding: 12px;
  }
  .document-reader-dialog {
    max-height: calc(100vh - 24px);
    border-radius: 16px;
  }
  .document-title p,
  .document-reader-dialog > header > a {
    display: none;
  }
  .document-reader-dialog pre {
    width: calc(100% - 24px);
    margin: 12px;
    padding: 22px 18px;
  }
  .image-reader {
    min-height: calc(100vh - 112px);
    padding: 16px 12px 44px;
  }
  .image-reader > img {
    max-height: calc(100vh - 176px);
  }
}
</style>
