<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ArrowUp, ChevronDown, ImagePlus, X, Check, Loader2, Link2, Upload } from '@lucide/vue';
import { BaseButton } from '@ai-marketing/ui';
import {
  CUSTOMIZED_IMAGE_MODELS,
  CUSTOMIZED_IMAGE_RATIOS,
  CUSTOMIZED_IMAGE_RESOLUTIONS,
  CUSTOMIZED_IMAGE_DIMENSIONS,
  CUSTOMIZED_IMAGE_REFERENCE_LIMIT,
  CUSTOMIZED_IMAGE_REFERENCE_MAX_BYTES,
  type CustomizedImageSettings,
  type CustomizedImageReference,
  type ProductionAsset,
} from '@ai-marketing/contracts';
import ProductionAssetVisual from './ProductionAssetVisual.vue';
import { productionApi } from './production.api';
import { defaultAssetImagePrompt } from './production-image-input';
import { isAbortError } from '../../../api/http-client';
import { imageActivityRunning, type ImageActivity } from './production-image-activity';
import ProductionImageStatus from './ProductionImageStatus.vue';

const props = defineProps<{
  asset: ProductionAsset;
  projectId: string;
  workflowRunId: string;
  brandReferences?: { assetId: string; version: number; name: string }[] | undefined;
  settings?: CustomizedImageSettings | undefined;
  busy?: boolean | undefined;
  submitting?: boolean | undefined;
  activity?: ImageActivity | undefined;
  interrupted?: boolean | undefined;
  error?: string | undefined;
}>();
const emit = defineEmits<{ generate: [settings: CustomizedImageSettings]; close: [] }>();
type Reference = CustomizedImageReference & { name: string; source: string };
const root = ref<HTMLElement>(),
  editor = ref<HTMLTextAreaElement>(),
  fileInput = ref<HTMLInputElement>();
const text = ref(''),
  model = ref<CustomizedImageSettings['model']>(CUSTOMIZED_IMAGE_MODELS[0].id);
const resolution = ref<CustomizedImageSettings['resolution']>('2K'),
  ratio = ref<CustomizedImageSettings['ratio']>('auto');
const references = ref<Reference[]>([]),
  uploading = ref(false),
  uploadError = ref(''),
  scopeNotice = ref(''),
  basisChanged = ref(false);
const panel = ref<'images' | 'models' | 'parameters' | ''>('');
let scope = new AbortController();
const modelName = computed(() => CUSTOMIZED_IMAGE_MODELS.find((m) => m.id === model.value)!.label);
const dimensions = computed(() =>
  ratio.value === 'auto' ? null : CUSTOMIZED_IMAGE_DIMENSIONS[resolution.value][ratio.value],
);
const locked = computed(
  () => props.busy || imageActivityRunning(props.activity) || uploading.value || basisChanged.value,
);
const generating = computed(
  () => props.submitting || imageActivityRunning(props.activity) || (props.busy && !props.activity),
);
const identity = computed(() =>
  JSON.stringify([props.projectId, props.workflowRunId, props.asset.id]),
);
const preset = computed(() => {
  const input = props.settings?.inputs?.find((i) => i.assetId === props.asset.id);
  return {
    prompt: input?.prompt ?? defaultAssetImagePrompt(props.asset),
    model: props.settings?.model ?? CUSTOMIZED_IMAGE_MODELS[0].id,
    resolution: props.settings?.resolution ?? '2K',
    ratio: props.settings?.ratio ?? 'auto',
    references: input?.references ?? [],
  };
});
// Compare generation inputs, not object identity or preview/ownership projections.
const basis = computed(() =>
  JSON.stringify(
    {
      definition: {
        kind: props.asset.kind,
        name: props.asset.name,
        description: props.asset.description,
        knownFacts: props.asset.knownFacts,
        designNotes: props.asset.designNotes,
        sourceText: props.asset.sourceText,
        imageRequirements: props.asset.imageRequirements ?? '',
        preparation: props.asset.preparation ?? null,
      },
      preset: preset.value,
    },
    (_key, value: unknown) =>
      value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
        : value,
  ),
);
const valid = computed(
  () =>
    (!props.asset.preparation ||
      (props.asset.preparation.treatment === 'INDEPENDENT' &&
        props.asset.preparation.parentId === null)) &&
    !!text.value.trim() &&
    text.value.length <= 10000 &&
    !locked.value,
);
function resize() {
  void nextTick(() => {
    if (editor.value) {
      editor.value.style.height = 'auto';
      editor.value.style.height = `${Math.min(210, Math.max(74, editor.value.scrollHeight))}px`;
    }
  });
}
function loadPreset() {
  const input = preset.value;
  text.value = input.prompt;
  model.value = input.model;
  resolution.value = input.resolution;
  ratio.value = input.ratio;
  references.value = input.references.map((r, index) => ({
    ...r,
    name:
      props.brandReferences?.find((b) => b.assetId === r.assetId && b.version === r.version)
        ?.name ?? `参考图 ${index + 1}`,
    source: '已选参考图',
  }));
  resize();
}
function reviewBasis(useLatest: boolean) {
  if (props.busy || uploading.value || !basisChanged.value) return;
  if (useLatest) loadPreset();
  basisChanged.value = false;
  uploadError.value = '';
  scopeNotice.value = useLatest
    ? '已载入最新设置，请核对参考图片后生成。'
    : '已沿用本次输入，请核对参考图片后生成。';
}
watch(
  [identity, basis],
  (next, previous) => {
    scope.abort();
    scope = new AbortController();
    panel.value = '';
    uploading.value = false;
    uploadError.value = '';
    if (previous?.[0] && previous[0] === next[0]) {
      basisChanged.value = true;
      scopeNotice.value =
        '资产定义或已保存的生图设置已更新。本次输入已保留，未完成上传已停止，请重新核对后再生成。';
    } else {
      basisChanged.value = false;
      loadPreset();
      scopeNotice.value = previous?.[0]
        ? '已切换制作对象或工作流，本次输入已重新载入，原上传已停止。请核对提示词和参考图片。'
        : '';
    }
  },
  { immediate: true },
);
watch(text, resize);
function toggle(value: typeof panel.value) {
  if (!locked.value) panel.value = panel.value === value ? '' : value;
}
function outside(event: PointerEvent) {
  const target = event.target instanceof Element ? event.target : null;
  if (
    root.value &&
    (!target ||
      !root.value.contains(target) ||
      (!target.closest('.composer-popover') && !target.closest('button[aria-expanded]')))
  )
    panel.value = '';
}
function escape(event: KeyboardEvent) {
  if (panel.value) {
    const label = { images: '添加参考图片', models: '选择生图模型', parameters: '图片生成参数' }[
      panel.value
    ];
    event.preventDefault();
    event.stopPropagation();
    panel.value = '';
    void nextTick(() =>
      root.value?.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)?.focus(),
    );
  }
}
onMounted(() => document.addEventListener('pointerdown', outside));
onBeforeUnmount(() => {
  scope.abort();
  document.removeEventListener('pointerdown', outside);
});
function selected(r: CustomizedImageReference) {
  return references.value.some((v) => v.assetId === r.assetId && v.version === r.version);
}
function chooseBrand(r: Reference | { assetId: string; version: number; name: string }) {
  if (locked.value) return;
  if (selected(r))
    references.value = references.value.filter(
      (v) => !(v.assetId === r.assetId && v.version === r.version),
    );
  else if (references.value.length < CUSTOMIZED_IMAGE_REFERENCE_LIMIT)
    references.value.push({ ...r, source: '来自资料导入' });
  else uploadError.value = `最多选择 ${CUSTOMIZED_IMAGE_REFERENCE_LIMIT} 张参考图片`;
}
function visual(
  r: Reference | { assetId: string; version: number; name: string },
): ProductionAsset {
  return {
    id: r.assetId,
    kind: 'PROP',
    name: r.name,
    description: '',
    knownFacts: '',
    designNotes: '',
    sourceText: '',
    image: r,
  };
}
async function upload(event: Event) {
  const input = event.target as HTMLInputElement,
    files = [...(input.files ?? [])];
  input.value = '';
  if (locked.value || !files.length) return;
  uploadError.value = '';
  if (files.length + references.value.length > CUSTOMIZED_IMAGE_REFERENCE_LIMIT) {
    uploadError.value = `最多选择 ${CUSTOMIZED_IMAGE_REFERENCE_LIMIT} 张参考图片`;
    return;
  }
  if (
    files.some(
      (f) =>
        !['image/png', 'image/jpeg', 'image/webp'].includes(f.type) ||
        !f.size ||
        f.size > CUSTOMIZED_IMAGE_REFERENCE_MAX_BYTES,
    )
  ) {
    uploadError.value = '请选择不超过 10 MB 的 PNG、JPG 或 WebP 图片';
    return;
  }
  const active = scope,
    uploadIdentity = identity.value,
    uploadBasis = basis.value,
    projectId = props.projectId,
    workflowRunId = props.workflowRunId;
  const current = () =>
    active === scope &&
    !active.signal.aborted &&
    identity.value === uploadIdentity &&
    basis.value === uploadBasis;
  uploading.value = true;
  panel.value = '';
  try {
    for (const file of files) {
      if (!current()) return;
      const asset = await productionApi.uploadImageReference(
        projectId,
        workflowRunId,
        file,
        active.signal,
      );
      if (!current()) return;
      if (!asset.currentVersion) throw new Error('图片版本未返回，请重新上传');
      const reference = {
        assetId: asset.id,
        version: asset.currentVersion,
        name: asset.name,
        source: '本次上传',
      };
      if (!selected(reference)) references.value.push(reference);
    }
  } catch (e) {
    if (current() && !isAbortError(e))
      uploadError.value = e instanceof Error ? e.message : '参考图片上传失败，请重试';
  } finally {
    if (current()) uploading.value = false;
  }
}
function submit() {
  if (!valid.value) return;
  panel.value = '';
  emit('generate', {
    model: model.value,
    resolution: resolution.value,
    ratio: ratio.value,
    assetIds: [props.asset.id],
    inputs: [
      {
        assetId: props.asset.id,
        prompt: text.value.trim(),
        references: references.value.map(({ assetId, version }) => ({ assetId, version })),
      },
    ],
  });
}
</script>
<template>
  <div class="image-composer-workspace">
    <figure class="current-image">
      <div class="current-image-preview" :aria-busy="generating">
        <ProductionAssetVisual :asset="asset" :project-id="projectId" />
        <div v-if="generating" class="image-generation-overlay">
          <div>
            <ProductionImageStatus
              :activity="activity"
              :submitting="submitting || (!activity && busy)"
              :interrupted="interrupted"
            />
            <small>{{ asset.image ? '完成前保留当前图片' : '图片生成后会显示在这里' }}</small>
          </div>
        </div>
      </div>
      <figcaption>
        <ProductionImageStatus
          v-if="activity && !imageActivityRunning(activity)"
          :activity="activity"
        />
        <span v-else>{{ asset.image ? '当前图片' : '图片待生成' }}</span
        ><span>{{ asset.name }}</span>
      </figcaption>
    </figure>
    <div
      ref="root"
      class="composer"
      :class="{ 'has-references': references.length || uploading }"
      @keydown.esc="escape"
    >
      <div class="prompt-area">
        <div class="attachments">
          <button
            class="add-image"
            type="button"
            aria-label="添加参考图片"
            :aria-expanded="panel === 'images'"
            :disabled="locked"
            @click="toggle('images')"
          >
            <ImagePlus :size="20" /><span>图片</span>
          </button>
          <div
            v-for="(reference, index) in references"
            :key="`${reference.assetId}:${reference.version}`"
            class="reference"
            :title="`${reference.name} · ${reference.source}`"
          >
            <ProductionAssetVisual :asset="visual(reference)" :project-id="projectId" compact />
            <button
              type="button"
              :aria-label="`移除${reference.name}`"
              :disabled="locked"
              @click="references.splice(index, 1)"
            >
              <X :size="12" />
            </button>
          </div>
          <span v-if="uploading" class="uploading"><Loader2 :size="18" class="spin" />上传中</span>
        </div>
        <textarea
          ref="editor"
          v-model="text"
          :disabled="locked"
          aria-label="资产图片提示词"
          placeholder="结合图片，输入当前资产的形象描述"
          spellcheck="false"
        />
      </div>
      <div class="composer-toolbar">
        <div class="toolbar-options">
          <button
            type="button"
            class="option"
            :aria-expanded="panel === 'models'"
            aria-label="选择生图模型"
            :disabled="locked"
            @click="toggle('models')"
          >
            <ImagePlus :size="16" /><span>{{ modelName }}</span
            ><ChevronDown :size="14" />
          </button>
          <button
            type="button"
            class="option parameter-summary"
            :aria-expanded="panel === 'parameters'"
            aria-label="图片生成参数"
            :disabled="locked"
            @click="toggle('parameters')"
          >
            <span>{{ ratio === 'auto' ? '智能比例' : ratio }}</span
            ><i />{{ resolution }}<i />1张
          </button>
        </div>
        <BaseButton
          class="generate-image"
          :disabled="!valid"
          :loading="busy"
          aria-label="生成图片"
          title="生成当前资产图片"
          @click="submit"
          ><ArrowUp v-if="!busy" :size="21"
        /></BaseButton>
      </div>
      <section
        v-if="panel === 'images'"
        class="composer-popover image-picker"
        aria-label="添加参考图片"
      >
        <header>
          <strong>参考图片</strong><span>最多 {{ CUSTOMIZED_IMAGE_REFERENCE_LIMIT }} 张</span>
        </header>
        <button type="button" class="upload-action" :disabled="locked" @click="fileInput?.click()">
          <Upload :size="17" />上传图片<small>PNG / JPG / WebP · 10 MB 内</small>
        </button>
        <h4>资料导入中的品牌素材</h4>
        <div v-if="brandReferences?.length" class="brand-references">
          <button
            v-for="reference in brandReferences"
            :key="`${reference.assetId}:${reference.version}`"
            type="button"
            :aria-pressed="selected(reference)"
            :class="{ selected: selected(reference) }"
            :disabled="locked"
            @click="chooseBrand(reference)"
          >
            <ProductionAssetVisual
              :asset="visual(reference)"
              :project-id="projectId"
              compact
            /><span>{{ reference.name }}<small>来自资料导入</small></span
            ><Check v-if="selected(reference)" :size="16" />
          </button>
        </div>
        <p v-else>当前已确认资料中没有可用的品牌图片，可直接上传。</p>
      </section>
      <section
        v-if="panel === 'models'"
        class="composer-popover model-picker"
        aria-label="生图模型"
      >
        <header><strong>选择生图模型</strong></header>
        <button
          v-for="item in CUSTOMIZED_IMAGE_MODELS"
          :key="item.id"
          type="button"
          :aria-pressed="item.id === model"
          :disabled="locked"
          @click="
            model = item.id;
            panel = '';
          "
        >
          <span
            >{{ item.label
            }}<small>{{
              item.id === CUSTOMIZED_IMAGE_MODELS[0].id
                ? '适合精细形象与材质表现'
                : '适合快速探索形象方案'
            }}</small></span
          ><Check v-if="item.id === model" :size="16" />
        </button>
      </section>
      <section
        v-if="panel === 'parameters'"
        class="composer-popover parameter-picker"
        aria-label="图片参数设置"
      >
        <h4>图片比例</h4>
        <div class="ratios" role="group" aria-label="图片比例">
          <button
            v-for="item in CUSTOMIZED_IMAGE_RATIOS"
            :key="item"
            type="button"
            :aria-pressed="ratio === item"
            :disabled="locked"
            :class="{ active: ratio === item }"
            @click="ratio = item"
          >
            <span
              class="ratio-icon"
              :style="{
                aspectRatio: item === 'auto' ? '1' : item.replace(':', '/'),
                height: ['9:16', '2:3', '3:4'].includes(item) ? '17px' : '13px',
              }"
            />{{ item === 'auto' ? '智能' : item }}
          </button>
        </div>
        <h4>图片尺寸</h4>
        <div class="dimensions">
          <label>W<input aria-label="图片宽度" readonly :value="dimensions?.[0] ?? '—'" /></label
          ><Link2 :size="16" /><label
            >H<input aria-label="图片高度" readonly :value="dimensions?.[1] ?? '—'"
          /></label>
        </div>
        <h4>选择分辨率</h4>
        <div class="resolutions" role="group" aria-label="图片分辨率">
          <button
            v-for="item in CUSTOMIZED_IMAGE_RESOLUTIONS"
            :key="item"
            type="button"
            :aria-pressed="resolution === item"
            :disabled="locked"
            :class="{ active: resolution === item }"
            @click="resolution = item"
          >
            {{ item }}
          </button>
        </div>
        <p>每项生成 1 张多视角设定图</p>
      </section>
      <input
        ref="fileInput"
        hidden
        type="file"
        accept="image/png,image/jpeg,image/webp"
        multiple
        :disabled="locked"
        @change="upload"
      />
    </div>
    <div v-if="scopeNotice" class="composer-notice" :role="basisChanged ? 'alert' : 'status'">
      <p>{{ scopeNotice }}</p>
      <div v-if="basisChanged">
        <button type="button" :disabled="busy || uploading" @click="reviewBasis(false)">
          沿用本次输入
        </button>
        <button type="button" :disabled="busy || uploading" @click="reviewBasis(true)">
          载入最新设置
        </button>
      </div>
    </div>
    <p v-if="text.length > 10000" class="composer-error" role="alert">
      提示词最多 10000 字，请精简后生成。
    </p>
    <p
      v-if="uploadError || error || activity?.state === 'FAILED'"
      class="composer-error"
      role="alert"
    >
      {{
        uploadError ||
        error ||
        activity?.error ||
        '本次图片未生成完成，提示词和原图已保留，可重新生成。'
      }}
    </p>
    <footer>
      <span v-if="busy" class="generation-hint">可关闭此窗口，生成会继续</span>
      <button type="button" @click="emit('close')">返回工作台</button>
    </footer>
  </div>
</template>
<style scoped>
.current-image-preview {
  position: relative;
}
.image-generation-overlay {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  background: #f5f8fc66;
}
.image-generation-overlay > div {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 16px 22px;
  background: #ffffffed;
  border: 1px solid #e3eaf4;
  border-radius: 12px;
  box-shadow: 0 6px 24px #243e6010;
}
.image-generation-overlay small,
.generation-hint {
  color: #7a8ba3;
  font-size: 12px;
}
.image-composer-workspace {
  color: #273b55;
}
.composer-notice {
  margin: 12px 0;
  padding: 12px 14px;
  border: 1px solid #dce5f3;
  border-radius: 10px;
  background: #f5f8fd;
  color: #526984;
  font-size: 12px;
  line-height: 1.7;
}
.composer-notice p {
  margin: 0;
}
.composer-notice > div {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 10px;
}
.composer-notice button {
  padding: 6px 10px;
  border: 1px solid #d4dfef;
  border-radius: 7px;
  color: #42659a;
  background: #fff;
  font: inherit;
  cursor: pointer;
}
.composer-notice button:disabled {
  opacity: 0.5;
  cursor: default;
}
.current-image {
  margin: 0 0 20px;
  background: #f6f8fb;
  border: 1px solid #e9edf3;
  border-radius: 13px;
  overflow: hidden;
}
.current-image :deep(.asset-visual) {
  height: clamp(270px, 42dvh, 460px);
  aspect-ratio: auto;
  background: #f4f6f8;
}
.current-image figcaption {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  padding: 11px 16px;
  color: #8190a5;
  font-size: 12px;
  border-top: 1px solid #e9edf3;
}
.current-image figcaption span:last-child {
  color: #52677f;
}
.composer {
  position: relative;
  border: 1px solid #d9e1ee;
  border-radius: 20px;
  padding: 18px 18px 14px;
  background: #fff;
  box-shadow: 0 5px 20px #223f6f06;
}
.composer:focus-within {
  border-color: #a1b9e5;
  box-shadow: 0 0 0 3px #2563eb08;
}
.prompt-area {
  display: flex;
  gap: 15px;
  align-items: flex-start;
}
.attachments {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  flex-wrap: wrap;
  flex-shrink: 0;
}
.has-references .prompt-area {
  flex-direction: column;
  gap: 12px;
}
.prompt-area textarea {
  box-sizing: border-box;
  width: 100%;
  flex: 1;
  min-height: 74px;
  max-height: 210px;
  overflow: auto;
  border: 0;
  outline: none;
  resize: none;
  padding: 4px 0;
  font: inherit;
  font-size: 14px;
  line-height: 1.85;
  color: #344c68;
  background: transparent;
}
.prompt-area textarea::placeholder {
  color: #a5b0c2;
}
.add-image {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 7px;
  width: 58px;
  height: 58px;
  border: 1px dashed #dce3ef;
  background: #f7f9fc;
  border-radius: 7px;
  color: #8494ad;
  font-size: 11px;
}
.reference {
  position: relative;
  width: 58px;
  height: 58px;
  border: 1px solid #e1e7f0;
  border-radius: 7px;
}
.reference :deep(.compact) {
  width: 58px;
  height: 58px;
  border-radius: 6px;
}
.reference > button {
  position: absolute;
  top: -6px;
  right: -6px;
  width: 18px;
  height: 18px;
  padding: 0;
  display: grid;
  place-items: center;
  background: #7385a2;
  color: #fff;
  border: 2px solid #fff;
  border-radius: 50%;
  opacity: 0;
}
.reference:hover > button,
.reference:focus-within > button {
  opacity: 1;
}
.uploading {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: #7890b0;
  height: 58px;
}
.composer-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 14px;
}
.toolbar-options {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.option {
  display: flex;
  align-items: center;
  gap: 7px;
  min-height: 32px;
  border: 0;
  border-radius: 20px;
  padding: 6px 9px;
  background: transparent;
  color: #34516f;
  font: inherit;
  font-size: 12px;
}
.option:hover,
.option[aria-expanded='true'] {
  background: #f1f5fb;
}
.parameter-summary {
  gap: 8px;
}
.parameter-summary i {
  height: 12px;
  border-left: 1px solid #d9e0ec;
}
.generate-image {
  width: 36px !important;
  height: 36px !important;
  min-height: 36px !important;
  padding: 0 !important;
  border-radius: 50% !important;
  flex-shrink: 0;
}
.composer-popover {
  position: absolute;
  z-index: 5;
  bottom: 57px;
  left: 16px;
  box-sizing: border-box;
  max-width: calc(100% - 32px);
  padding: 18px;
  background: #fff;
  border: 1px solid #dde5f1;
  border-radius: 17px;
  box-shadow: 0 12px 40px #162d5524;
}
.composer-popover header {
  display: flex;
  justify-content: space-between;
  gap: 14px;
  font-size: 13px;
  margin-bottom: 14px;
}
.composer-popover header > span {
  color: #91a0b4;
  font-size: 11px;
}
.composer-popover h4 {
  font-size: 12px;
  font-weight: 500;
  margin: 17px 0 9px;
  color: #53647d;
}
.composer-popover p {
  font-size: 11px;
  color: #8c9bb0;
  line-height: 1.8;
  margin: 12px 0 0;
}
.image-picker {
  width: 380px;
}
.upload-action {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 11px;
  border: 1px dashed #d6e1f1;
  border-radius: 9px;
  background: #f7faff;
  color: #41638a;
  font-size: 12px;
}
.upload-action small {
  font-size: 10px;
  color: #94a2b6;
  margin-left: auto;
}
.brand-references {
  max-height: 215px;
  overflow: auto;
  display: grid;
  gap: 5px;
}
.brand-references button,
.model-picker button {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px;
  border: 0;
  border-radius: 8px;
  background: white;
  text-align: left;
  width: 100%;
  color: #476383;
  font: inherit;
  font-size: 12px;
}
.brand-references button:hover,
.brand-references button.selected,
.model-picker button:hover {
  background: #f1f6ff;
}
.brand-references button > span,
.model-picker button > span {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}
.brand-references small,
.model-picker small {
  display: block;
  color: #93a1b5;
  font-size: 11px;
  margin-top: 5px;
}
.model-picker {
  width: 300px;
}
.parameter-picker {
  left: 150px;
  width: 520px;
}
.parameter-picker h4:first-child {
  margin-top: 0;
}
.ratios,
.resolutions {
  display: flex;
  gap: 3px;
  padding: 5px;
  background: #f4f6fa;
  border-radius: 8px;
}
.ratios button,
.resolutions button {
  flex: 1;
  min-width: 0;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: #64748b;
  font: inherit;
  font-size: 11px;
  padding: 8px 4px;
}
.ratios button {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  justify-content: center;
}
.ratio-icon {
  display: block;
  border: 1.3px solid #79869b;
  box-sizing: border-box;
  border-radius: 2px;
  max-width: 25px;
  min-width: 9px;
}
.ratios .active,
.resolutions .active {
  background: #fff;
  border-color: #dce5f2;
  color: #204d96;
}
.dimensions {
  display: flex;
  gap: 12px;
  align-items: center;
  color: #8a98ad;
}
.dimensions label {
  display: flex;
  align-items: center;
  gap: 12px;
  flex: 1;
  min-width: 0;
  border: 1px solid #dce4f0;
  border-radius: 6px;
  background: #f7f9fc;
  padding: 9px 11px;
  font-size: 12px;
}
.dimensions input {
  width: 100%;
  min-width: 0;
  border: 0;
  outline: 0;
  text-align: right;
  color: #677b96;
  background: transparent;
  font: inherit;
  font-size: 12px;
}
.composer-error {
  font-size: 12px;
  color: #b74b41;
  line-height: 1.8;
}
footer {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
  justify-content: flex-end;
  margin-top: 18px;
}
footer button {
  padding: 9px 14px;
  background: white;
  border: 1px solid #dfe7f2;
  border-radius: 8px;
  color: #7084a0;
  font: inherit;
  font-size: 12px;
}
button {
  cursor: pointer;
}
button:disabled,
textarea:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}
.spin {
  animation: rotate 1s linear infinite;
}
@keyframes rotate {
  to {
    transform: rotate(360deg);
  }
}
@media (max-width: 680px) {
  .reference > button {
    opacity: 1;
  }
  .current-image :deep(.asset-visual) {
    height: 220px;
  }
  .composer {
    padding: 14px;
    border-radius: 16px;
  }
  .parameter-picker {
    left: 8px;
    max-width: calc(100% - 16px);
    width: 520px;
  }
  .ratios {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
  }
  .option {
    font-size: 11px;
    padding: 5px 6px;
  }
  .toolbar-options {
    gap: 3px;
  }
  .image-picker {
    left: 8px;
    max-width: calc(100% - 16px);
  }
  .upload-action {
    flex-wrap: wrap;
  }
  .upload-action small {
    margin-left: 0;
  }
}
</style>
