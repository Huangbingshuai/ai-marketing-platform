<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { ImagePlus, Video, CircleHelp } from '@lucide/vue';
import { BaseButton } from '@ai-marketing/ui';
import {
  CUSTOMIZED_IMAGE_MODELS,
  CUSTOMIZED_IMAGE_RESOLUTIONS,
  CUSTOMIZED_IMAGE_RATIOS,
  customizedAssetImageSelectionIssue,
  type CustomizedImageSettings,
  type ProductionAsset,
  type ProductionShot,
} from '@ai-marketing/contracts';
import WorkflowInformationDialog from '../../../platform/workflow/components/WorkflowInformationDialog.vue';
import ProductionImageComposer from './ProductionImageComposer.vue';
import { defaultAssetImagePrompt } from './production-image-input';
import { independentlyPrepared, imageOwnershipLabel } from './production-asset-images';
const props = defineProps<{
  open: boolean;
  type: 'IMAGE' | 'VIDEO';
  assets: ProductionAsset[];
  catalog?: ProductionAsset[];
  shot?: ProductionShot;
  prompt?: string;
  ratio?: string;
  resolution?: string;
  busy?: boolean;
  error?: string;
  projectId?: string;
  workflowRunId?: string;
  brandReferences?: { assetId: string; version: number; name: string }[] | undefined;
  settings?: CustomizedImageSettings | undefined;
}>();
const emit = defineEmits<{ close: []; generate: [settings: CustomizedImageSettings] }>();
const model = ref<CustomizedImageSettings['model']>(CUSTOMIZED_IMAGE_MODELS[0].id);
const imageResolution = ref<CustomizedImageSettings['resolution']>('2K');
const imageRatio = ref<CustomizedImageSettings['ratio']>('1:1');
const selectedIds = ref<string[]>([]);
const catalog = computed(() => props.catalog ?? props.assets);
const eligible = (asset: ProductionAsset) => independentlyPrepared(catalog.value, asset);
const eligibleAssets = computed(() => props.assets.filter(eligible));
watch(
  () => props.open,
  (open) => {
    if (!open) return;
    const missing = eligibleAssets.value.filter((a) => !a.image);
    selectedIds.value = (props.assets.length > 1 && missing.length ? missing : eligibleAssets.value)
      .slice(0, 20)
      .map((a) => a.id);
  },
  { immediate: true },
);
const selectedAssets = computed(() => props.assets.filter((a) => selectedIds.value.includes(a.id)));
const singleAsset = computed(() => (props.assets.length === 1 ? props.assets[0] : undefined));
const selectionIssue = computed(() =>
  customizedAssetImageSelectionIssue(catalog.value, selectedIds.value),
);
const valid = computed(
  () =>
    selectedAssets.value.length > 0 &&
    selectedAssets.value.length <= 20 &&
    selectedAssets.value.length === selectedIds.value.length &&
    !selectionIssue.value,
);
function submit() {
  if (!valid.value || props.busy) return;
  emit('generate', {
    model: model.value,
    resolution: imageResolution.value,
    ratio: imageRatio.value,
    assetIds: selectedIds.value,
    inputs: selectedAssets.value.map((asset) => ({
      assetId: asset.id,
      prompt: defaultAssetImagePrompt(asset),
      references: [],
    })),
  });
}
const title = computed(() =>
  props.type === 'IMAGE'
    ? props.assets.length > 1
      ? '批量生成资产图片'
      : singleAsset.value?.image
        ? '重新生成资产图片'
        : '生成资产图片'
    : '渲染当前镜头',
);
</script>
<template>
  <WorkflowInformationDialog
    :class="{ 'asset-image-dialog': type === 'IMAGE' }"
    :open="open"
    :title="title"
    description="核对本次制作内容"
    @close="$emit('close')"
  >
    <ProductionImageComposer
      v-if="
        open &&
        type === 'IMAGE' &&
        singleAsset &&
        eligible(singleAsset) &&
        projectId &&
        workflowRunId
      "
      :asset="singleAsset"
      :project-id="projectId"
      :workflow-run-id="workflowRunId"
      :brand-references="brandReferences"
      :settings="settings"
      :busy="busy"
      :error="error"
      @generate="emit('generate', $event)"
      @close="emit('close')"
    />
    <div v-else class="render-review">
      <div class="render-intro">
        <component :is="type === 'IMAGE' ? ImagePlus : Video" :size="23" />
        <div>
          <strong>{{
            type === 'IMAGE'
              ? singleAsset?.name || `${assets.length} 项资产`
              : shot?.title || '当前镜头'
          }}</strong>
          <p>
            {{
              type === 'IMAGE'
                ? '共用形象用于后续镜头保持一致'
                : `${shot?.durationSeconds ?? 0} 秒 · ${ratio ?? '16:9'} · ${resolution ?? '1080P'} · MP4`
            }}
          </p>
        </div>
      </div>
      <div v-if="type === 'IMAGE'" class="image-production-layout">
        <aside class="image-settings">
          <h3>制作设置</h3>
          <label
            >生图模型<select v-model="model" :disabled="busy" aria-label="生图模型">
              <option v-for="item in CUSTOMIZED_IMAGE_MODELS" :key="item.id" :value="item.id">
                {{ item.label }}
              </option>
            </select></label
          >
          <p class="model-description">
            {{
              model === CUSTOMIZED_IMAGE_MODELS[0].id
                ? '适合精细的公共形象与材质表现'
                : '适合快速探索形象与场景方案'
            }}
          </p>
          <label
            >图片清晰度<select v-model="imageResolution" :disabled="busy" aria-label="图片清晰度">
              <option v-for="item in CUSTOMIZED_IMAGE_RESOLUTIONS" :key="item">{{ item }}</option>
            </select></label
          >
          <label
            >图片画幅<select v-model="imageRatio" :disabled="busy" aria-label="图片画幅">
              <option v-for="item in CUSTOMIZED_IMAGE_RATIOS" :key="item">{{ item }}</option>
            </select></label
          >
          <p>
            每项制作一张多视角设定图，同一张图包含该对象的多个角度。生成后保存修改，用于后续镜头。
          </p>
        </aside>
        <section class="image-subjects" aria-label="本次生成的资产">
          <h3 v-if="singleAsset">当前资产</h3>
          <h3 v-else>本次制作 · 已选 {{ selectedIds.length }} / {{ eligibleAssets.length }}</h3>
          <article v-for="a in assets" :key="a.id">
            <label class="subject-choice"
              ><input
                v-if="!singleAsset"
                v-model="selectedIds"
                type="checkbox"
                :value="a.id"
                :disabled="busy || !eligible(a)"
              /><strong>{{ a.name }}</strong></label
            >
            <span class="image-state">{{
              !eligible(a)
                ? imageOwnershipLabel(catalog, a)
                : a.image
                  ? '重新制作 · 完成前保留原图'
                  : '首次制作'
            }}</span>
            <p>{{ a.description || '尚未补充公共形象' }}</p>
            <dl>
              <dt>图像制作要求</dt>
              <dd>{{ a.imageRequirements || '尚未填写' }}</dd>
              <dt>设计与待确认内容</dt>
              <dd>{{ a.designNotes || '无额外设计要求' }}</dd>
            </dl>
          </article>
        </section>
      </div>
      <template v-else
        ><h3>当前镜头提示词</h3>
        <p class="prompt">{{ prompt || '请先生成并保存当前镜头提示词' }}</p>
        <h3>本镜参考素材</h3>
        <div class="asset-chips">
          <span v-for="a in assets" :key="a.id"
            >{{ a.name }} · {{ a.image ? '已关联图片' : '图片待准备' }}</span
          ><span v-if="!assets.length">本镜尚未绑定素材</span>
        </div></template
      >
      <div v-if="type === 'VIDEO'" class="unavailable">
        <CircleHelp :size="18" />
        <p>历史分镜请先重新整理为新版完整分镜，再在右侧选择模型并生成视频。</p>
      </div>
      <p v-if="type === 'IMAGE' && !valid" role="alert">
        {{ selectionIssue || '请补齐公共形象描述，每次最多生成 20 项资产。' }}
      </p>
      <p v-if="error" class="generation-error" role="alert">{{ error }}</p>
      <footer>
        <button @click="$emit('close')">返回工作台</button
        ><BaseButton v-if="type === 'IMAGE'" :disabled="!valid" :loading="busy" @click="submit">
          <ImagePlus v-if="!busy" :size="16" />{{
            busy
              ? '正在提交'
              : singleAsset
                ? singleAsset.image
                  ? '重新生成此图片'
                  : '生成此图片'
                : '开始生成图片'
          }} </BaseButton
        ><button v-else class="primary" disabled>视频渲染暂不可用</button>
      </footer>
    </div>
  </WorkflowInformationDialog>
</template>
<style scoped>
.asset-image-dialog {
  width: min(1320px, calc(100vw - 64px));
}
@media (max-width: 680px) {
  .asset-image-dialog {
    width: calc(100vw - 20px);
  }
}
.image-production-layout {
  display: grid;
  grid-template-columns: 250px minmax(0, 1fr);
  gap: 28px;
}
.image-settings {
  padding-right: 24px;
  border-right: 1px solid #e8edf4;
}
.image-settings label {
  display: grid;
  gap: 8px;
  margin-top: 20px;
  color: #596278;
  font-size: 13px;
  font-weight: 650;
}
.image-settings select {
  width: 100%;
  height: 42px;
  padding: 0 11px;
  font: inherit;
  font-weight: 400;
  color: #42526a;
  background: #fff;
  border: 1px solid #dce3ec;
  border-radius: 10px;
}
.image-settings select:focus-visible {
  outline: 3px solid #2563eb14;
  border-color: #7da7ef;
}
.image-subjects {
  max-height: 390px;
  overflow: auto;
  padding-right: 8px;
}
.image-subjects article + article {
  padding-top: 18px;
}
.image-subjects dl {
  grid-template-columns: 100px 1fr;
}
.image-state {
  color: #7d899d;
  font-size: 11px;
}
.subject-choice {
  display: flex;
  align-items: center;
  gap: 9px;
  margin-bottom: 8px;
  font-size: 14px;
  cursor: pointer;
}
.subject-choice input {
  accent-color: #315ff2;
  width: 16px;
  height: 16px;
}
.model-description {
  font-size: 12px;
}
.generation-error {
  color: #b64a42;
}
.render-review footer :deep(.base-button) {
  min-height: 44px;
}
.render-review {
  display: grid;
  gap: 20px;
  color: #263b56;
}
.render-intro {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 18px;
  background: #f7f9fc;
  border: 1px solid #e6ebf2;
  border-radius: 12px;
}
.render-intro svg {
  color: #527ab7;
}
p {
  font-size: 13px;
  line-height: 1.8;
  color: #738197;
  margin: 6px 0 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
h3 {
  font-size: 14px;
  margin: 0 0 10px;
}
article {
  border-bottom: 1px solid #e8edf4;
  padding-bottom: 18px;
}
dl {
  font-size: 12px;
  display: grid;
  grid-template-columns: 120px 1fr;
  gap: 10px;
  margin-bottom: 0;
}
dt {
  color: #8a95a5;
}
dd {
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.asset-chips {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.asset-chips span {
  padding: 7px 10px;
  background: #f3f6fa;
  border-radius: 7px;
  font-size: 12px;
}
.unavailable {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 14px;
  background: #fff9ed;
  border: 1px solid #f0e3c9;
  border-radius: 10px;
  color: #a78343;
}
.unavailable svg {
  flex-shrink: 0;
  margin-top: 4px;
}
.unavailable p {
  margin: 0;
  color: #927346;
}
.prompt {
  max-height: 230px;
  overflow: auto;
  margin: 0;
}
footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}
button {
  border: 1px solid #dce4f0;
  border-radius: 9px;
  padding: 11px 16px;
  background: white;
  color: #526b8c;
  cursor: pointer;
}
.primary {
  background: #315ff2;
  border-color: #315ff2;
  color: white;
}
button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
@media (max-width: 600px) {
  .image-production-layout {
    grid-template-columns: 1fr;
    gap: 22px;
  }
  .image-settings {
    padding-right: 0;
    padding-bottom: 20px;
    border-right: 0;
    border-bottom: 1px solid #e8edf4;
  }
  dl {
    grid-template-columns: 1fr;
    gap: 6px;
  }
  footer {
    flex-wrap: wrap;
  }
}
</style>
