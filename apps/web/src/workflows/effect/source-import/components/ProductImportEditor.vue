<script setup lang="ts">
import {
  EFFECT_IMPORT_MATERIAL_TYPE_LABELS,
  type EffectImportMaterial,
  type EffectImportMaterialType,
  type EffectImportProduct,
} from '@ai-marketing/contracts';
import {
  AlertTriangle,
  CheckCircle2,
  FileText,
  Image,
  Link2,
  Plus,
  RefreshCw,
  Settings2,
  Trash2,
  Upload,
  Video,
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
  change: [product: EffectImportProduct, field: 'category' | 'commerceUrl' | 'name', value: string];
  delete: [product: EffectImportProduct];
  deleteMaterial: [product: EffectImportProduct, material: EffectImportMaterial];
  override: [product: EffectImportProduct];
  replace: [product: EffectImportProduct, material: EffectImportMaterial];
  retry: [product: EffectImportProduct, material: EffectImportMaterial];
  select: [product: EffectImportProduct, selected: boolean];
  upload: [product: EffectImportProduct, type: EffectImportMaterialType, files: File[]];
  validateLink: [product: EffectImportProduct];
}>();

const materialTypes: { accept: string; icon: typeof Image; type: EffectImportMaterialType }[] = [
  { type: 'PRODUCT_IMAGE', icon: Image, accept: '.jpg,.jpeg,.png,.webp' },
  { type: 'PRODUCT_DOCUMENT', icon: FileText, accept: '.doc,.docx,.xls,.xlsx,.pdf,.txt' },
  { type: 'BRAND_GUIDELINE', icon: Settings2, accept: '.doc,.docx,.pdf,.txt' },
  { type: 'REFERENCE_VIDEO', icon: Video, accept: '.mp4,.mov,.webm' },
];
const selectedMaterialType = ref<EffectImportMaterialType>('PRODUCT_IMAGE');
const selectedType = computed(() =>
  materialTypes.find((item) => item.type === selectedMaterialType.value)!,
);
const completion = computed(() => {
  const checks = [
    props.product.name.trim(),
    props.product.category.trim(),
    props.product.materials.some(
      (item) => item.type === 'PRODUCT_IMAGE' && item.status === 'READY',
    ),
  ];
  return Math.round((checks.filter(Boolean).length / checks.length) * 100);
});
const changeField = (field: 'category' | 'commerceUrl' | 'name', event: Event): void =>
  emit('change', props.product, field, (event.target as HTMLInputElement).value);
const chooseFiles = (event: Event): void => {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  input.value = '';
  if (files.length) emit('upload', props.product, selectedMaterialType.value, files);
};
const formatBytes = (value: number | null): string =>
  value === null
    ? '—'
    : value < 1048576
      ? `${Math.max(1, Math.round(value / 1024))} KB`
      : `${(value / 1048576).toFixed(1)} MB`;
const extension = (material: EffectImportMaterial): string => {
  const name = material.originalFileName || material.expectedFileName || '';
  return name.includes('.') ? name.split('.').pop()!.slice(0, 5).toUpperCase() : 'FILE';
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
        :aria-label="`选择产品 ${product.name || '未命名'}`"
        @change="emit('select', product, ($event.target as HTMLInputElement).checked)"
      />
      <span class="batch-card-no">商品 {{ String(position).padStart(2, '0') }}</span>
      <strong class="batch-card-name">{{ product.name || '未命名商品' }}</strong>
      <em class="completion-badge" :class="{ complete: completion === 100 }"
        >完整度 {{ completion }}%</em
      >
      <button
        class="icon-button"
        type="button"
        :disabled="disabled"
        title="单品配置覆盖"
        @click="emit('override', product)"
      >
        <Settings2 :size="14" />
      </button>
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
          <p>支持商品图片、产品文档、品牌规范与参考视频</p>
        </div>
      </header>
      <div class="product-identity">
        <label
          ><span>产品名称<b>*</b></span
          ><input
            :value="product.name"
            :disabled="disabled"
            type="text"
            placeholder="请输入产品名称"
            @input="changeField('name', $event)"
            @blur="emit('blur', product)"
        /></label>
        <label
          ><span>品类<b>*</b></span
          ><input
            :value="product.category"
            :disabled="disabled"
            type="text"
            placeholder="请输入品类"
            @input="changeField('category', $event)"
            @blur="emit('blur', product)"
        /></label>
      </div>
      <div class="material-type-tabs">
        <button
          v-for="item in materialTypes"
          :key="item.type"
          type="button"
          :disabled="disabled"
          :class="{ active: selectedMaterialType === item.type }"
          @click="selectedMaterialType = item.type"
        >
          <component :is="item.icon" :size="13" />{{
            EFFECT_IMPORT_MATERIAL_TYPE_LABELS[item.type]
          }}
        </button>
      </div>
      <label class="source-dropzone">
        <span class="dropzone-plus"><Plus :size="25" /></span>
        <strong
          >点击或将{{ EFFECT_IMPORT_MATERIAL_TYPE_LABELS[selectedMaterialType] }}拖拽到此处</strong
        >
        <small>当前资料类型：{{ EFFECT_IMPORT_MATERIAL_TYPE_LABELS[selectedMaterialType] }}</small>
        <small>图片最大 50 MiB，文档 100 MiB，视频最大 512 MiB</small>
        <input
          type="file"
          :multiple="selectedMaterialType === 'PRODUCT_IMAGE'"
          :accept="selectedType.accept"
          :disabled="disabled"
          @change="chooseFiles"
        />
      </label>
    </section>

    <template v-else>
      <div class="product-identity batch-identity">
        <label
          ><span>产品名称<b>*</b></span
          ><input
            :value="product.name"
            :disabled="disabled"
            type="text"
            placeholder="产品名称"
            @input="changeField('name', $event)"
            @blur="emit('blur', product)"
        /></label>
        <label
          ><span>品类<b>*</b></span
          ><input
            :value="product.category"
            :disabled="disabled"
            type="text"
            placeholder="品类"
            @input="changeField('category', $event)"
            @blur="emit('blur', product)"
        /></label>
      </div>
      <div class="material-type-tabs compact">
        <button
          v-for="item in materialTypes"
          :key="item.type"
          type="button"
          :disabled="disabled"
          :class="{ active: selectedMaterialType === item.type }"
          @click="selectedMaterialType = item.type"
        >
          {{ EFFECT_IMPORT_MATERIAL_TYPE_LABELS[item.type] }}
        </button>
      </div>
      <label class="source-dropzone batch-dropzone">
        <span class="dropzone-plus"><Plus :size="20" /></span
        ><strong
          >点击或拖拽上传{{ EFFECT_IMPORT_MATERIAL_TYPE_LABELS[selectedMaterialType] }}</strong
        ><small>支持多文件，系统将保存到当前商品资料包</small>
        <input
          type="file"
          :multiple="selectedMaterialType === 'PRODUCT_IMAGE'"
          :accept="selectedType.accept"
          :disabled="disabled"
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
        <span class="file-extension">{{ extension(material) }}</span>
        <span class="file-copy"
          ><strong>{{
            material.originalFileName || material.expectedFileName || '待补传文件'
          }}</strong
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
          :disabled="disabled || busyMaterialIds.has(material.id)"
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
    <footer v-if="!batch" class="override-footer">
      <button type="button" :disabled="disabled" @click="emit('override', product)">
        <Settings2 :size="13" />单品覆盖配置
      </button>
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
.product-identity {
  display: grid;
  grid-template-columns: 1.35fr 1fr;
  gap: 10px;
}
.product-identity label,
.product-identity label > span {
  display: flex;
}
.product-identity label {
  min-width: 0;
  flex-direction: column;
  gap: 6px;
}
.product-identity label > span {
  color: #596278;
  gap: 2px;
  font-size: 11px;
  font-weight: 700;
}
.product-identity b {
  color: #e05356;
}
.product-identity input,
.commerce-input-row input {
  width: 100%;
  box-sizing: border-box;
  color: #263247;
  background: #fff;
  border: 1px solid #e2d9d4;
  outline: none;
}
.product-identity input {
  height: 38px;
  padding: 0 11px;
  border-radius: 10px;
  font-size: 12px;
}
.product-identity input:focus,
.commerce-input-row:focus-within {
  border-color: #93b4ff;
  box-shadow: 0 0 0 3px #2563eb10;
}
.material-type-tabs {
  display: grid;
  margin: 15px 0 10px;
  grid-template-columns: repeat(4, minmax(0, 1fr));
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
  min-height: 286px;
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
.source-dropzone input {
  position: absolute;
  inset: 0;
  opacity: 0;
  cursor: pointer;
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
.material-file-row button,
.override-footer button {
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
.override-footer {
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
  overflow: hidden;
  color: #263247;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
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
  .product-identity,
  .batch-identity {
    grid-template-columns: 1fr;
  }
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
