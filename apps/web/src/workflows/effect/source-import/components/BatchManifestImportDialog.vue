<script setup lang="ts">
import type { EffectManifestFormat, PreviewEffectManifestData } from '@ai-marketing/contracts';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Download,
  FileSpreadsheet,
  Upload,
  X,
} from '@lucide/vue';
import { computed, ref, watch } from 'vue';

const props = defineProps<{
  busy?: boolean;
  commitIdempotencyKey?: string;
  error?: string;
  open: boolean;
  preview: PreviewEffectManifestData | null;
}>();
const emit = defineEmits<{
  cancel: [];
  close: [];
  commit: [idempotencyKey: string];
  download: [format: EffectManifestFormat];
  preview: [manifest: File, files: File[], idempotencyKey: string];
}>();

const manifest = ref<File | null>(null);
const companionFiles = ref<File[]>([]);
const localError = ref('');
const idempotencyKey = ref('');
const expandedRows = ref(new Set<number>());
const allIssues = computed(() => [
  ...(props.preview?.issues ?? []),
  ...(props.preview?.rows.flatMap((row) => row.issues) ?? []),
]);

const newKey = (): string =>
  globalThis.crypto?.randomUUID?.() ??
  `manifest-${Date.now()}-${Math.random().toString(16).slice(2)}`;

const reset = (): void => {
  manifest.value = null;
  companionFiles.value = [];
  localError.value = '';
  idempotencyKey.value =
    props.preview && props.commitIdempotencyKey
      ? props.commitIdempotencyKey
      : props.preview
        ? idempotencyKey.value || newKey()
        : newKey();
  expandedRows.value = new Set();
};

const toggleRowIssues = (rowNumber: number): void => {
  const next = new Set(expandedRows.value);
  if (next.has(rowNumber)) next.delete(rowNumber);
  else next.add(rowNumber);
  expandedRows.value = next;
};

const selectManifest = (event: Event): void => {
  manifest.value = (event.target as HTMLInputElement).files?.[0] ?? null;
  localError.value = '';
};

const selectCompanions = (event: Event): void => {
  companionFiles.value = Array.from((event.target as HTMLInputElement).files ?? []);
};

const startPreview = (): void => {
  if (!manifest.value) {
    localError.value = '请先选择 CSV 或 XLSX 清单';
    return;
  }
  emit('preview', manifest.value, companionFiles.value, idempotencyKey.value);
};

const close = (): void => {
  if (props.busy) return;
  emit('close');
};

const cancel = (): void => {
  if (props.busy) return;
  if (props.preview) emit('cancel');
  emit('close');
};

watch(
  () => props.open,
  (open) => {
    if (open) reset();
  },
);
watch(
  () => [props.preview?.id, props.commitIdempotencyKey] as const,
  ([previewId, commitKey]) => {
    if (previewId && commitKey) idempotencyKey.value = commitKey;
  },
);
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="manifest-mask" @click.self="close">
      <section
        class="manifest-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="manifest-title"
      >
        <header>
          <span><FileSpreadsheet :size="19" /></span>
          <div>
            <h2 id="manifest-title">CSV / Excel 清单导入</h2>
            <p>先预览逐行校验和文件匹配结果，确认后再写入批量草稿</p>
          </div>
          <button type="button" aria-label="关闭" :disabled="busy" @click="close">
            <X :size="18" />
          </button>
        </header>
        <main>
          <div class="manifest-downloads">
            <span>请使用正式模板填写，最多 100 行</span>
            <button type="button" @click="emit('download', 'csv')">
              <Download :size="13" />CSV 模板
            </button>
            <button type="button" @click="emit('download', 'xlsx')">
              <Download :size="13" />Excel 模板
            </button>
          </div>
          <div v-if="!preview" class="manifest-pickers">
            <label class="manifest-picker primary">
              <FileSpreadsheet :size="25" />
              <strong>{{ manifest?.name || '选择 CSV 或 XLSX 清单' }}</strong>
              <small>最大 10 MiB，仅解析第一张非空工作表</small>
              <input type="file" accept=".csv,.xlsx" :disabled="busy" @change="selectManifest" />
            </label>
            <label class="manifest-picker">
              <Upload :size="24" />
              <strong>选择清单中引用的配套资料</strong>
              <small>{{
                companionFiles.length
                  ? `已选择 ${companionFiles.length} 个文件`
                  : '可多选，文件名将按规则精确匹配'
              }}</small>
              <input type="file" multiple :disabled="busy" @change="selectCompanions" />
            </label>
            <div v-if="companionFiles.length" class="companion-list">
              <span v-for="file in companionFiles" :key="`${file.name}-${file.size}`">{{
                file.name
              }}</span>
            </div>
          </div>
          <template v-else>
            <div class="manifest-summary">
              <span
                ><strong>{{ preview.rowCount }}</strong
                ><small>清单行数</small></span
              >
              <span
                ><strong>{{ preview.stagedFiles.length }}</strong
                ><small>配套文件</small></span
              >
              <span :class="{ warn: allIssues.length }"
                ><strong>{{ allIssues.length }}</strong
                ><small>校验问题</small></span
              >
              <span
                ><strong>{{ preview.rows.filter((row) => row.valid).length }}</strong
                ><small>完整行</small></span
              >
            </div>
            <div class="manifest-table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>行</th>
                    <th>电商链接</th>
                    <th>资料匹配</th>
                    <th>状态</th>
                  </tr>
                </thead>
                <tbody>
                  <template v-for="row in preview.rows" :key="row.rowNumber">
                    <tr>
                      <td>{{ row.rowNumber }}</td>
                      <td>{{ row.commerceUrl || '—' }}</td>
                      <td>
                        {{
                          row.materialReferences.filter((item) => item.matchStatus === 'MATCHED')
                            .length
                        }}/{{ row.materialReferences.length }}
                      </td>
                      <td>
                        <button
                          v-if="row.issues.length"
                          class="row-issue-toggle invalid"
                          type="button"
                          :aria-expanded="expandedRows.has(row.rowNumber)"
                          @click="toggleRowIssues(row.rowNumber)"
                        >
                          <AlertTriangle :size="13" />
                          {{ row.issues.length }} 项问题
                          <ChevronDown
                            :size="12"
                            :class="{ expanded: expandedRows.has(row.rowNumber) }"
                          />
                        </button>
                        <span v-else class="valid"> <CheckCircle2 :size="13" />可导入 </span>
                      </td>
                    </tr>
                    <tr v-if="expandedRows.has(row.rowNumber)" class="manifest-row-issues">
                      <td colspan="4">
                        <p v-for="(issue, index) in row.issues" :key="`${issue.code}-${index}`">
                          <AlertTriangle :size="13" />
                          <span>{{ issue.message }}</span>
                          <small v-if="issue.fileName">{{ issue.fileName }}</small>
                        </p>
                      </td>
                    </tr>
                  </template>
                </tbody>
              </table>
            </div>
            <div v-if="preview.issues.length" class="manifest-issues">
              <p
                v-for="(issue, index) in preview.issues.slice(0, 12)"
                :key="`${issue.code}-${index}`"
              >
                <AlertTriangle :size="13" />
                <span
                  >{{ issue.manifestRowNumber ? `第 ${issue.manifestRowNumber} 行：` : ''
                  }}{{ issue.message }}</span
                >
              </p>
              <small v-if="preview.issues.length > 12"
                >另有 {{ preview.issues.length - 12 }} 项问题，导入后可在产品卡片中继续修复。</small
              >
            </div>
          </template>
          <p v-if="localError || error" class="manifest-error">{{ localError || error }}</p>
        </main>
        <footer>
          <span>{{
            preview ? '存在问题的行也会创建为可编辑草稿' : '预览不会直接写入产品草稿'
          }}</span>
          <button type="button" :disabled="busy" @click="cancel">取消</button>
          <button
            v-if="!preview"
            class="primary"
            type="button"
            :disabled="busy"
            @click="startPreview"
          >
            {{ busy ? '正在解析…' : '预览并校验' }}
          </button>
          <button
            v-else
            class="primary"
            type="button"
            :disabled="busy"
            @click="emit('commit', commitIdempotencyKey || idempotencyKey)"
          >
            {{ busy ? '正在导入…' : '确认写入草稿' }}
          </button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.manifest-mask {
  position: fixed;
  inset: 0;
  z-index: 1200;
  display: grid;
  padding: 22px;
  place-items: center;
  background: #17233a70;
  backdrop-filter: blur(3px);
}
.manifest-dialog {
  width: min(900px, 96vw);
  max-height: 92vh;
  overflow: hidden;
  background: #fff;
  border: 1px solid #dbe4f2;
  border-radius: 20px;
  box-shadow: 0 24px 70px #0f1d3840;
}
.manifest-dialog > header {
  display: flex;
  min-height: 76px;
  padding: 16px 20px;
  align-items: center;
  gap: 11px;
  border-bottom: 1px solid #e2e9f3;
}
.manifest-dialog > header > span {
  display: grid;
  width: 40px;
  height: 40px;
  place-items: center;
  color: #2563eb;
  background: #eaf2ff;
  border-radius: 11px;
}
.manifest-dialog h2,
.manifest-dialog p {
  margin: 0;
}
.manifest-dialog h2 {
  color: #263247;
  font-size: 16px;
}
.manifest-dialog header p {
  margin-top: 3px;
  color: #8490a4;
  font-size: 11px;
}
.manifest-dialog > header > button {
  display: grid;
  width: 34px;
  height: 34px;
  margin-left: auto;
  place-items: center;
  color: #6f7c90;
  background: #f6f8fb;
  border: 0;
  border-radius: 9px;
}
.manifest-dialog > main {
  max-height: calc(92vh - 142px);
  padding: 18px 20px;
  overflow: auto;
}
.manifest-downloads {
  display: flex;
  min-height: 38px;
  padding: 8px 10px;
  align-items: center;
  gap: 8px;
  color: #63769a;
  background: #f4f8ff;
  border: 1px solid #dbe7fb;
  border-radius: 9px;
  font-size: 11px;
}
.manifest-downloads > span {
  margin-right: auto;
}
.manifest-downloads button {
  display: flex;
  height: 25px;
  padding: 0 8px;
  align-items: center;
  gap: 4px;
  color: #2563eb;
  background: #fff;
  border: 1px solid #bad0f7;
  border-radius: 6px;
  font-size: 10px;
  font-weight: 800;
}
.manifest-pickers {
  display: grid;
  margin-top: 14px;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
.manifest-picker {
  position: relative;
  display: flex;
  min-height: 128px;
  padding: 18px;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: 6px;
  color: #6680a8;
  background: #fbfdff;
  border: 1px dashed #b8c9e3;
  border-radius: 14px;
  text-align: center;
  cursor: pointer;
}
.manifest-picker.primary {
  color: #2563eb;
  background: #f7faff;
  border-color: #83aaf0;
}
.manifest-picker strong {
  color: #3b4d68;
  font-size: 12px;
}
.manifest-picker small {
  color: #98a3b4;
  font-size: 10px;
}
.manifest-picker input {
  position: absolute;
  inset: 0;
  opacity: 0;
  cursor: pointer;
}
.companion-list {
  grid-column: 1/-1;
  display: flex;
  padding: 8px;
  flex-wrap: wrap;
  gap: 5px;
  background: #f8fafc;
  border-radius: 9px;
}
.companion-list span {
  padding: 4px 7px;
  color: #5d6c81;
  background: #fff;
  border: 1px solid #dfe6ef;
  border-radius: 6px;
  font-size: 9px;
}
.manifest-summary {
  display: grid;
  margin-top: 14px;
  grid-template-columns: repeat(4, 1fr);
  gap: 9px;
}
.manifest-summary span {
  display: flex;
  min-height: 62px;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  background: #f8fbff;
  border: 1px solid #e0e8f3;
  border-radius: 10px;
}
.manifest-summary strong {
  color: #2563eb;
  font-size: 18px;
}
.manifest-summary small {
  margin-top: 2px;
  color: #8994a7;
  font-size: 9px;
}
.manifest-summary span.warn strong {
  color: #e55c55;
}
.manifest-table-wrap {
  margin-top: 12px;
  overflow: auto;
  border: 1px solid #dfe6ef;
  border-radius: 10px;
}
table {
  width: 100%;
  border-collapse: collapse;
  font-size: 10px;
}
th {
  padding: 9px 10px;
  color: #637188;
  background: #f4f7fb;
  text-align: left;
  white-space: nowrap;
}
td {
  padding: 9px 10px;
  color: #3f4d63;
  border-top: 1px solid #edf0f5;
}
td span {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  white-space: nowrap;
}
td span.valid {
  color: #188561;
}
td span.invalid {
  color: #d64e4f;
}
.row-issue-toggle {
  display: inline-flex;
  padding: 0;
  align-items: center;
  gap: 4px;
  color: #d64e4f;
  background: transparent;
  border: 0;
  font: inherit;
  white-space: nowrap;
  cursor: pointer;
}
.row-issue-toggle svg:last-child {
  transition: transform 160ms ease;
}
.row-issue-toggle svg:last-child.expanded {
  transform: rotate(180deg);
}
.manifest-row-issues td {
  padding: 8px 12px;
  color: #a34b42;
  background: #fff9f7;
}
.manifest-row-issues p {
  display: flex;
  margin: 4px 0;
  align-items: center;
  gap: 5px;
  font-size: 10px;
}
.manifest-row-issues small {
  margin-left: auto;
  color: #ad756d;
  font-size: 9px;
}
.manifest-issues {
  margin-top: 10px;
  padding: 10px 11px;
  color: #a34b42;
  background: #fff7f5;
  border: 1px solid #ffd7cf;
  border-radius: 9px;
}
.manifest-issues p {
  display: flex;
  margin: 4px 0;
  gap: 5px;
  font-size: 10px;
}
.manifest-issues svg {
  flex: 0 0 auto;
}
.manifest-issues small {
  display: block;
  margin-top: 7px;
  color: #ad756d;
  font-size: 9px;
}
.manifest-error {
  margin-top: 10px !important;
  color: #cf424d;
  font-size: 11px;
}
.manifest-dialog > footer {
  display: flex;
  min-height: 66px;
  padding: 13px 20px;
  align-items: center;
  gap: 9px;
  background: #f9fbfe;
  border-top: 1px solid #e2e9f3;
}
.manifest-dialog > footer span {
  margin-right: auto;
  color: #8490a4;
  font-size: 10px;
}
.manifest-dialog > footer button {
  height: 34px;
  padding: 0 13px;
  color: #41516a;
  background: #fff;
  border: 1px solid #d7dfeb;
  border-radius: 8px;
  font-size: 11px;
  font-weight: 800;
}
.manifest-dialog > footer button.primary {
  color: #fff;
  background: #2563eb;
  border-color: #2563eb;
}
button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}
@media (max-width: 620px) {
  .manifest-pickers,
  .manifest-summary {
    grid-template-columns: 1fr;
  }
  .manifest-downloads {
    align-items: flex-start;
    flex-wrap: wrap;
  }
  .manifest-downloads > span {
    width: 100%;
  }
  .manifest-dialog > footer span {
    display: none;
  }
}
</style>
