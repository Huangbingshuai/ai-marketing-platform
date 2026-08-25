<script setup lang="ts">
import {
  EFFECT_IMPORT_MATERIAL_TYPE_LABELS,
  type EffectImportMaterial,
  type EffectImportMaterialType,
  type EffectImportProduct,
  type EffectImportUploadMaterialType,
} from '@ai-marketing/contracts';
import {
  AlertTriangle,
  CheckCircle2,
  FileText,
  Image,
  Link2,
  Plus,
  RefreshCw,
  Trash2,
  Upload,
} from '@lucide/vue';
import { computed, ref } from 'vue';

const props = withDefaults(
  defineProps<{
    batch?: boolean;
    busyMaterialIds?: ReadonlySet<string>;
    disabled?: boolean;
    position?: number;
    product: EffectImportProduct;
    selected?: boolean;
  }>(),
  {
    batch: false,
    busyMaterialIds: () => new Set<string>(),
    disabled: false,
    position: 1,
    selected: false,
  },
);

const emit = defineEmits<{
  blur: [product: EffectImportProduct];
  change: [product: EffectImportProduct, field: 'commerceUrl' | 'name', value: string];
  delete: [product: EffectImportProduct];
  deleteMaterial: [product: EffectImportProduct, material: EffectImportMaterial];
  replace: [product: EffectImportProduct, material: EffectImportMaterial];
  retry: [product: EffectImportProduct, material: EffectImportMaterial];
  select: [product: EffectImportProduct, selected: boolean];
  upload: [product: EffectImportProduct, type: EffectImportMaterialType, files: File[]];
  validateLink: [product: EffectImportProduct];
}>();

const materialTypes: {
  accept: string;
  icon: typeof Image;
  type: EffectImportUploadMaterialType;
}[] = [
  { type: 'PRODUCT_IMAGE', icon: Image, accept: '.jpg,.jpeg,.png,.psd,.webp' },
  { type: 'PRODUCT_DOCUMENT', icon: FileText, accept: '.doc,.docx,.xls,.xlsx,.pdf,.txt,.md' },
];
const selectedMaterialType = ref<EffectImportUploadMaterialType>('PRODUCT_IMAGE');
const failedThumbnailIds = ref<ReadonlySet<string>>(new Set());
const hasProductName = computed(() => props.product.name.trim().length > 0);
const uploadDisabled = computed(() => props.disabled || !hasProductName.value);
const selectedType = computed(() =>
  materialTypes.find((item) => item.type === selectedMaterialType.value)!,
);
const completion = computed(() => {
  const hasName = props.product.name.trim().length > 0;
  const hasReadyImage = props.product.materials.some(
    (item) => item.type === 'PRODUCT_IMAGE' && item.status === 'READY',
  );
  return Number(hasName) * 50 + Number(hasReadyImage) * 50;
});
const commitStatusLabel = computed(
  () =>
    ({
      UNVALIDATED: '尚未校验',
      COMMITTED: '工作副本已提交',
      DRAFT_CHANGED: '存在未校验修改',
      STALE: '工作副本待更新',
    })[props.product.commitStatus],
);
const changeField = (field: 'commerceUrl' | 'name', event: Event): void =>
  emit('change', props.product, field, (event.target as HTMLInputElement).value);
const chooseFiles = (event: Event): void => {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  input.value = '';
  if (!uploadDisabled.value && files.length)
    emit('upload', props.product, selectedMaterialType.value, files);
};
const formatBytes = (value: number | null): string =>
  value === null
    ? '—'
    : value < 1048576
      ? `${Math.max(1, Math.round(value / 1024))} KB`
      : `${(value / 1048576).toFixed(1)} MB`;
const extension = (material: EffectImportMaterial): string => {
  const name = materialName(material);
  return name.includes('.') ? name.split('.').pop()!.slice(0, 5).toUpperCase() : 'FILE';
};
const materialName = (material: EffectImportMaterial): string =>
  material.originalFileName || material.expectedFileName || '待补传文件';
const thumbnailUrl = (material: EffectImportMaterial): string | null =>
  material.type === 'PRODUCT_IMAGE' &&
  material.status === 'READY' &&
  material.contentUrl &&
  !failedThumbnailIds.value.has(material.id)
    ? material.contentUrl
    : null;
const markThumbnailFailed = (materialId: string): void => {
  const next = new Set(failedThumbnailIds.value);
  next.add(materialId);
  failedThumbnailIds.value = next;
};
const statusText = (material: EffectImportMaterial): string =>
  props.busyMaterialIds.has(material.id)
    ? '处理中'
    : { READY: '已就绪', FAILED: '失败', MISSING: '待补传', UPLOADING: '上传中' }[material.status];
</script>

<template>
  <article class="product-editor" :class="{ batch, selected }">
    <header v-if="batch" class="batch-card-head">
      <input
        type="checkbox"
        :checked="selected"
        :disabled="disabled"
        :aria-label="`选择商品资料包 ${position}`"
        @change="emit('select', product, ($event.target as HTMLInputElement).checked)"
      />
      <span class="batch-card-no">商品 {{ String(position).padStart(2, '0') }}</span>
      <label class="batch-card-name">
        <span class="visually-hidden">产品名称</span>
        <input
          :value="product.name"
          :disabled="disabled"
          type="text"
          required
          maxlength="120"
          autocomplete="off"
          placeholder="请输入产品名称"
          aria-label="产品名称"
          :aria-invalid="!product.name.trim()"
          @input="changeField('name', $event)"
          @blur="emit('blur', product)"
        />
      </label>
      <em class="completion-badge" :class="{ complete: completion === 100 }"
        >完整度 {{ completion }}%</em
      >
      <small class="commit-status" :class="product.commitStatus.toLowerCase()">{{
        commitStatusLabel
      }}</small>
      <button
        class="icon-button danger"
        type="button"
        :disabled="disabled"
        title="删除产品"
        @click="emit('delete', product)"
      >
        <Trash2 :size="15" />
      </button>
    </header>

    <section v-if="!batch" class="source-card upload-source-card">
      <header class="panel-heading">
        <span class="panel-heading-icon"><Upload :size="20" /></span>
        <div>
          <h3>上传产品资料</h3>
          <p>支持商品主图、细节图、场景图与产品文本资料</p>
        </div>
      </header>
      <label class="product-name-field">
        <span>产品名称 <em>*</em></span>
        <input
          :value="product.name"
          :disabled="disabled"
          type="text"
          required
          maxlength="120"
          autocomplete="off"
          placeholder="请输入产品名称"
          :aria-invalid="!product.name.trim()"
          @input="changeField('name', $event)"
          @blur="emit('blur', product)"
        />
      </label>
      <div class="material-type-tabs">
        <button
          v-for="item in materialTypes"
          :key="item.type"
          type="button"
          :disabled="uploadDisabled"
          :class="{ active: selectedMaterialType === item.type }"
          @click="selectedMaterialType = item.type"
        >
          <component :is="item.icon" :size="13" />{{
            EFFECT_IMPORT_MATERIAL_TYPE_LABELS[item.type]
          }}
        </button>
      </div>
      <label class="source-dropzone" :class="{ disabled: uploadDisabled }">
        <span class="dropzone-plus"><Plus :size="25" /></span>
        <strong
          >点击或将{{ EFFECT_IMPORT_MATERIAL_TYPE_LABELS[selectedMaterialType] }}拖拽到此处</strong
        >
        <small v-if="!hasProductName">请先填写产品名称，再上传产品资料</small>
        <small v-else
          >当前资料类型：{{ EFFECT_IMPORT_MATERIAL_TYPE_LABELS[selectedMaterialType] }}</small
        >
        <small>图片支持 JPG/PNG/PSD/WebP，文档支持 Word/Excel/PDF/纯文本</small>
        <input
          type="file"
          hidden
          :multiple="selectedMaterialType === 'PRODUCT_IMAGE'"
          :accept="selectedType.accept"
          :disabled="uploadDisabled"
          @change="chooseFiles"
        />
      </label>
    </section>

    <template v-else>
      <div class="material-type-tabs compact">
        <button
          v-for="item in materialTypes"
          :key="item.type"
          type="button"
          :disabled="uploadDisabled"
          :class="{ active: selectedMaterialType === item.type }"
          @click="selectedMaterialType = item.type"
        >
          {{ EFFECT_IMPORT_MATERIAL_TYPE_LABELS[item.type] }}
        </button>
      </div>
      <label class="source-dropzone batch-dropzone" :class="{ disabled: uploadDisabled }">
        <span class="dropzone-plus"><Plus :size="20" /></span
        ><strong
          >点击或拖拽上传{{ EFFECT_IMPORT_MATERIAL_TYPE_LABELS[selectedMaterialType] }}</strong
        ><small>{{
          hasProductName ? '支持多文件，系统将保存到当前商品资料包' : '请先填写产品名称'
        }}</small>
        <input
          type="file"
          hidden
          :multiple="selectedMaterialType === 'PRODUCT_IMAGE'"
          :accept="selectedType.accept"
          :disabled="uploadDisabled"
          @change="chooseFiles"
        />
      </label>
    </template>

    <section class="commerce-parse" :class="{ 'source-card': !batch }">
      <header v-if="!batch" class="panel-heading compact-heading">
        <span class="panel-heading-icon blue"><Link2 :size="18" /></span>
        <div>
          <h3>电商链接解析</h3>
          <p>粘贴商品详情页链接，校验格式并保存到资料包</p>
        </div>
      </header>
      <div class="commerce-input-row">
        <Link2 :size="15" /><input
          :value="product.commerceUrl ?? ''"
          :disabled="disabled"
          type="url"
          placeholder="粘贴电商商品链接"
          @input="changeField('commerceUrl', $event)"
          @blur="emit('blur', product)"
        /><button
          type="button"
          :disabled="disabled || !product.commerceUrl"
          @click="emit('validateLink', product)"
        >
          解析链接
        </button>
      </div>
    </section>

    <section class="imported-materials" :class="{ 'source-card': !batch }">
      <header>
        <div>
          <strong>已导入素材</strong
          ><small>{{ batch ? '当前商品资料' : '文件将在服务端安全保存' }}</small>
        </div>
        <span>{{ product.materials.length }} 个文件</span>
      </header>
      <div v-if="!product.materials.length" class="materials-empty">
        暂无已导入资料，可从上方拖拽区上传
      </div>
      <div
        v-for="material in product.materials"
        :key="material.id"
        class="material-file-row"
        :class="material.status.toLowerCase()"
      >
        <span v-if="material.type === 'PRODUCT_IMAGE'" class="material-thumbnail">
          <img
            v-if="thumbnailUrl(material)"
            :src="thumbnailUrl(material)!"
            :alt="`${materialName(material)} 缩略图`"
            loading="lazy"
            decoding="async"
            @error="markThumbnailFailed(material.id)"
          />
          <small v-else>{{ material.status === 'UPLOADING' ? '上传中' : '暂无预览' }}</small>
        </span>
        <span v-else class="file-extension">{{ extension(material) }}</span>
        <span class="file-copy"
          ><strong>{{ materialName(material) }}</strong
          ><small
            >{{ EFFECT_IMPORT_MATERIAL_TYPE_LABELS[material.type] }} ·
            {{ formatBytes(material.sizeBytes)
            }}<template v-if="material.errorMessage">
              · {{ material.errorMessage }}</template
            ></small
          ></span
        >
        <em
          ><CheckCircle2 v-if="material.status === 'READY'" :size="13" /><AlertTriangle
            v-else-if="material.status === 'FAILED'"
            :size="13"
          /><RefreshCw v-else :size="13" :class="{ spin: material.status === 'UPLOADING' }" />{{
            statusText(material)
          }}</em
        >
        <button
          v-if="material.status === 'FAILED' && material.failureDisposition === 'RETRYABLE'"
          type="button"
          :disabled="disabled || busyMaterialIds.has(material.id)"
          @click="emit('retry', product, material)"
        >
          重试
        </button>
        <button
          type="button"
          :disabled="uploadDisabled || busyMaterialIds.has(material.id)"
          @click="emit('replace', product, material)"
        >
          重传
        </button>
        <button
          class="file-delete"
          type="button"
          :disabled="disabled || busyMaterialIds.has(material.id)"
          aria-label="删除资料"
          @click="emit('deleteMaterial', product, material)"
        >
          <Trash2 :size="13" />
        </button>
      </div>
    </section>
    <footer v-if="!batch" class="commit-footer">
      <span class="commit-status" :class="product.commitStatus.toLowerCase()">{{
        commitStatusLabel
      }}</span>
    </footer>
  </article>
</template>

<style scoped>
.product-editor {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 18px;
}
.product-editor.batch {
  position: relative;
  gap: 12px;
  padding: 16px;
  background: #f8fbff;
  border: 1px solid #f0e3dc;
  border-radius: 16px;
}
.commit-status {
  color: #7b879c;
  font-size: 12px;
  font-style: normal;
  white-space: nowrap;
}
.commit-status.committed {
  color: #0b8f68;
}
.commit-status.draft_changed,
.commit-status.stale {
  color: #c46a20;
}
.product-editor.batch.selected {
  border-color: #ffb9aa;
  box-shadow: 0 0 0 1px #ffb9aa inset;
}
.source-card {
  padding: 20px;
  background: #fff;
  border: 1px solid #f0e3dc;
  border-radius: 20px;
}
.panel-heading,
.batch-card-head,
.imported-materials > header,
.commerce-input-row {
  display: flex;
  align-items: center;
}
.panel-heading {
  margin-bottom: 16px;
  align-items: flex-start;
  gap: 11px;
}
.panel-heading-icon {
  display: grid;
  width: 40px;
  height: 40px;
  flex: 0 0 40px;
  place-items: center;
  color: #d84c4f;
  background: #fff0ed;
  border-radius: 13px;
}
.panel-heading-icon.blue {
  color: #2563eb;
  background: #eef3ff;
}
.panel-heading h3,
.panel-heading p {
  margin: 0;
}
.panel-heading h3 {
  color: #263247;
  font-size: 15px;
}
.panel-heading p {
  margin-top: 4px;
  color: #9198a7;
  font-size: 12px;
}
.upload-source-card {
  display: flex;
  flex-direction: column;
}
.product-name-field {
  display: grid;
  gap: 7px;
}
.product-name-field span {
  color: #4d596f;
  font-size: 11px;
  font-weight: 700;
}
.product-name-field em {
  color: #d84c4f;
  font-style: normal;
}
.product-name-field input,
.batch-card-name input {
  width: 100%;
  box-sizing: border-box;
  color: #263247;
  background: #fff;
  border: 1px solid #e2d9d4;
  outline: none;
}
.product-name-field input {
  height: 40px;
  padding: 0 12px;
  border-radius: 10px;
  font-size: 12px;
}
.product-name-field input:focus,
.batch-card-name input:focus {
  border-color: #93b4ff;
  box-shadow: 0 0 0 3px #2563eb10;
}
.product-name-field input[aria-invalid='true'] {
  border-color: #f2c9bd;
}
.commerce-input-row input {
  width: 100%;
  box-sizing: border-box;
  color: #263247;
  background: #fff;
  border: 1px solid #e2d9d4;
  outline: none;
}
.commerce-input-row:focus-within {
  border-color: #93b4ff;
  box-shadow: 0 0 0 3px #2563eb10;
}
.material-type-tabs {
  display: grid;
  margin: 15px 0 10px;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 7px;
}
.material-type-tabs button {
  display: inline-flex;
  min-height: 34px;
  padding: 0 8px;
  align-items: center;
  justify-content: center;
  gap: 5px;
  color: #687386;
  background: #fff;
  border: 1px solid #eaded7;
  border-radius: 9px;
  font-size: 10px;
  font-weight: 700;
}
.material-type-tabs button.active {
  color: #d84c4f;
  background: #fff5f1;
  border-color: #ffb9aa;
}
.source-dropzone {
  position: relative;
  display: flex;
  min-height: 160px;
  padding: 20px;
  box-sizing: border-box;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: 7px;
  color: #667085;
  background: #fcfdff;
  border: 1px dashed #e6cfc4;
  border-radius: 16px;
  text-align: center;
  cursor: pointer;
}
.source-dropzone:hover {
  background: #fffaf8;
  border-color: #ff9e8b;
}
.source-dropzone.disabled {
  cursor: not-allowed;
  opacity: 0.62;
}
.source-dropzone.disabled:hover {
  background: #fff;
  border-color: #f1d6ce;
}
.source-dropzone input[type='file'] {
  display: none !important;
}
.dropzone-plus {
  display: grid;
  width: 48px;
  height: 48px;
  margin-bottom: 4px;
  place-items: center;
  color: #2563eb;
  background: #fff0ed;
  border-radius: 50%;
}
.source-dropzone strong {
  color: #596278;
  font-size: 13px;
}
.source-dropzone small {
  color: #a4aab6;
  font-size: 10px;
}
.compact-heading {
  margin-bottom: 13px;
}
.commerce-input-row {
  min-height: 42px;
  padding-left: 12px;
  gap: 8px;
  color: #98a1b1;
  background: #fff;
  border: 1px solid #e2d9d4;
  border-radius: 11px;
  overflow: hidden;
}
.commerce-input-row input {
  min-width: 0;
  height: 40px;
  flex: 1;
  border: 0;
  font-size: 12px;
}
.commerce-input-row button {
  align-self: stretch;
  min-width: 92px;
  padding: 0 15px;
  color: #fff;
  background: #2563eb;
  border: 0;
  font-size: 11px;
  font-weight: 800;
}
.commerce-input-row button:disabled {
  background: #9db7e8;
}
.imported-materials > header {
  margin-bottom: 10px;
  justify-content: space-between;
}
.imported-materials > header strong,
.imported-materials > header small {
  display: block;
}
.imported-materials > header strong {
  color: #263247;
  font-size: 13px;
}
.imported-materials > header small {
  margin-top: 3px;
  color: #9aa1ae;
  font-size: 10px;
}
.imported-materials > header > span {
  padding: 4px 8px;
  color: #8b6455;
  background: #fff4ef;
  border-radius: 999px;
  font-size: 9px;
}
.materials-empty {
  padding: 15px;
  color: #a4aab6;
  border: 1px dashed #f0e3dc;
  border-radius: 12px;
  flex: 1;
  text-align: center;
  font-size: 11px;
}
.material-file-row {
  display: flex;
  min-height: 44px;
  margin-top: 8px;
  padding: 7px 9px;
  box-sizing: border-box;
  align-items: center;
  gap: 8px;
  background: #fff;
  border: 1px solid #f0e3dc;
  border-radius: 12px;
}
.file-extension {
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
.material-thumbnail {
  display: flex;
  width: 48px;
  height: 48px;
  box-sizing: border-box;
  flex: 0 0 48px;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  color: #a4aab6;
  background: #f8f5f3;
  border: 1px solid #f0e3dc;
  border-radius: 9px;
}
.material-thumbnail img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.material-thumbnail small {
  padding: 4px;
  text-align: center;
  font-size: 8px;
  line-height: 1.25;
}
.file-copy {
  min-width: 0;
  flex: 1;
}
.file-copy strong,
.file-copy small {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.file-copy strong {
  color: #263247;
  font-size: 11px;
}
.file-copy small {
  margin-top: 3px;
  color: #9aa1ae;
  font-size: 9px;
}
.material-file-row em {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: #218564;
  font-size: 9px;
  font-style: normal;
  white-space: nowrap;
}
.material-file-row.failed em {
  color: #d84c4f;
}
.material-file-row button {
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
}
.material-file-row button.file-delete {
  padding: 0 6px;
  color: #a6acb7;
  border-color: transparent;
}
.commit-footer {
  display: flex;
  justify-content: flex-end;
  margin-top: -8px;
}
.batch-card-head {
  min-width: 0;
  gap: 7px;
}
.batch-card-head > input {
  accent-color: #2563eb;
}
.batch-card-no {
  padding: 3px 8px;
  flex: 0 0 auto;
  color: #d84c4f;
  background: #fff0ed;
  border-radius: 8px;
  font-size: 10px;
  font-weight: 800;
}
.batch-card-name {
  min-width: 0;
  flex: 1;
}
.batch-card-name input {
  height: 30px;
  padding: 0 9px;
  border-radius: 8px;
  font-size: 11px;
  font-weight: 700;
}
.batch-card-name input[aria-invalid='true'] {
  background: #fffaf8;
  border-color: #f2c9bd;
}
.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
.completion-badge {
  padding: 3px 7px;
  color: #8a611b;
  background: #fff4da;
  border-radius: 999px;
  font-size: 9px;
  font-style: normal;
  white-space: nowrap;
}
.completion-badge.complete {
  color: #218564;
  background: #eaf8f2;
}
.icon-button {
  display: grid;
  width: 26px;
  height: 26px;
  padding: 0;
  place-items: center;
  color: #8e96a5;
  background: transparent;
  border: 0;
  border-radius: 7px;
}
.icon-button.danger:hover {
  color: #d84c4f;
  background: #fff0ed;
}
.batch-identity {
  grid-template-columns: 1.2fr 0.8fr;
}
.material-type-tabs.compact {
  margin: 0;
  gap: 5px;
}
.material-type-tabs.compact button {
  min-height: 28px;
  padding: 0 5px;
  font-size: 9px;
}
.batch-dropzone {
  min-height: 118px;
  padding: 12px;
  background: #fff;
  border-radius: 12px;
}
.batch-dropzone .dropzone-plus {
  width: 36px;
  height: 36px;
}
.batch .commerce-parse,
.batch .imported-materials {
  padding-top: 12px;
  border-top: 1px dashed #f0e3dc;
}
button:disabled,
input:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}
.spin {
  animation: spin 1s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
@media (max-width: 780px) {
  .material-type-tabs {
    grid-template-columns: repeat(2, 1fr);
  }
  .source-dropzone {
    min-height: 210px;
  }
  .completion-badge {
    display: none;
  }
}
</style>
