<script setup lang="ts">
import WorkflowExtractionGraphDialog from '../../../platform/workflow/components/WorkflowExtractionGraphDialog.vue';
import WorkflowExtractionActions from '../../../platform/workflow/components/WorkflowExtractionActions.vue';
import WorkflowExtractionFeedback from '../../../platform/workflow/components/WorkflowExtractionFeedback.vue';
import {
  CUSTOMIZED_EXTRACTION_NODES,
  type CustomizedExtractionTask,
  type ExtractionNodeDetail,
} from '@ai-marketing/contracts';
import { computed, ref, watch } from 'vue';
import { AlertCircle, CheckCircle2, FileText, RefreshCw } from '@lucide/vue';
import { CUSTOMIZED_IMAGE_USAGE_LABELS } from '@ai-marketing/contracts';
import { WorkflowNodeFooter, WorkflowRunProgress } from '@ai-marketing/ui';
import WorkflowPageLoading from '../../../platform/workflow/components/WorkflowPageLoading.vue';
import WorkflowNodeEditActions from '../../../platform/workflow/components/WorkflowNodeEditActions.vue';
import WorkflowEditingBanner from '../../../platform/workflow/components/WorkflowEditingBanner.vue';
import WorkflowInformationCard from '../../../platform/workflow/components/WorkflowInformationCard.vue';
import WorkflowInformationField from '../../../platform/workflow/components/WorkflowInformationField.vue';
import WorkflowSellingPointsEditor from '../../../platform/workflow/components/WorkflowSellingPointsEditor.vue';
import { requestActionConfirmation } from '../../../shared/composables/action-confirmation';
import WorkflowInformationDialog from '../../../platform/workflow/components/WorkflowInformationDialog.vue';
import ImportMaterialRow from '../../../platform/file/components/ImportMaterialRow.vue';
import ImportImagePreview from '../../../platform/file/components/ImportImagePreview.vue';
import {
  emptyCustomizedExtractionView,
  customizedExtractionEditable,
  customizedExtractionReady,
  type CustomizedExtractionView,
  type CustomizedExtractionFieldKey,
  type CustomizedExtractionTextFieldKey,
  type CustomizedExtractionSource,
} from './customized-extraction-view';

const props = withDefaults(
  defineProps<{
    projectId: string;
    workflowRunId: string;
    sourceConfirmed: boolean;
    sources: CustomizedExtractionSource[];
    view?: CustomizedExtractionView;
    available?: boolean;
    loading?: boolean;
    loadError?: string;
    task?: CustomizedExtractionTask | null;
    selectedGraphNode?: string | null;
    graphDetail?: ExtractionNodeDetail | null;
    graphLoading?: boolean;
    graphError?: string;
  }>(),
  {
    view: () => emptyCustomizedExtractionView(),
    available: false,
    loading: false,
    loadError: '',
  },
);
const emit = defineEmits<{
  back: [];
  next: [];
  retry: [];
  beginEdit: [];
  cancelEdit: [];
  save: [];
  extract: [];
  retryTask: [];
  selectGraphNode: [nodeId: string];
  closeGraph: [];
  'update:view': [view: CustomizedExtractionView];
  viewSource: [assetId: string, event: MouseEvent, returnFocus: HTMLElement | null];
}>();
const sourcesOpen = ref(false);
const workflowOpen = ref(false);
const selectedSourceIds = ref<string[] | null>(null);
let sourceTrigger: HTMLElement | null = null;
watch(
  () => [props.projectId, props.workflowRunId],
  () => {
    sourcesOpen.value = false;
    workflowOpen.value = false;
    selectedSourceIds.value = null;
  },
);
const running = computed(() => props.view.status === 'RUNNING' || props.view.status === 'QUEUED');
const editable = computed(() =>
  customizedExtractionEditable(props.view, props.available, props.sourceConfirmed),
);
const ready = computed(() =>
  customizedExtractionReady(props.view, props.available, props.sourceConfirmed),
);
const shownSources = computed(() =>
  selectedSourceIds.value === null
    ? props.sources
    : props.sources.filter((source) => selectedSourceIds.value!.includes(source.reference.assetId)),
);
const actionDisabled = computed(
  () => !props.available || !props.sourceConfirmed || running.value || props.view.saving,
);
const openSources = (ids: string[] | null = null) => {
  sourceTrigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  selectedSourceIds.value = ids;
  sourcesOpen.value = true;
};
const readSource = (assetId: string, event: MouseEvent) => {
  sourcesOpen.value = false;
  emit('viewSource', assetId, event, sourceTrigger);
};
const fieldDefinitions: {
  id: string;
  title: string;
  description: string;
  badge?: string;
  fields: {
    key: CustomizedExtractionFieldKey;
    label: string;
    wide?: boolean;
    multiline?: boolean;
  }[];
}[] = [
  {
    id: 'brand',
    title: '品牌基础信息',
    description: '',
    badge: '品牌',
    fields: [
      { key: 'brandName', label: '品牌名称', wide: true },
      { key: 'projectName', label: '项目名称', wide: true },
      { key: 'projectBackground', label: '项目背景', wide: true, multiline: true },
      { key: 'brandTone', label: '品牌调性', wide: true, multiline: true },
      { key: 'visualConsistencyRules', label: '视觉统一规则', wide: true, multiline: true },
      { key: 'avoidedElements', label: '画面禁用元素', wide: true, multiline: true },
    ],
  },
  {
    id: 'product',
    title: '产品核心信息',
    description: '',
    badge: '产品',
    fields: [
      { key: 'productName', label: '产品名称', wide: true },
      { key: 'productDescription', label: '产品介绍', wide: true, multiline: true },
      { key: 'productSpecifications', label: '产品规格', wide: true, multiline: true },
      { key: 'productAppearance', label: '产品外观', wide: true, multiline: true },
      { key: 'sellingPoints', label: '核心卖点', wide: true, multiline: true },
      { key: 'targetAudience', label: '目标受众', wide: true, multiline: true },
    ],
  },
];
const updateField = (field: CustomizedExtractionTextFieldKey, value: string) => {
  if (!editable.value) return;
  emit('update:view', {
    ...props.view,
    fields: { ...props.view.fields, [field]: value },
    suggestions: props.view.suggestions.filter((key) => key !== field),
    fieldSources: { ...props.view.fieldSources, [field]: [] },
  });
};
const updateSellingPoints = (points: string[]) => {
  if (!editable.value) return;
  emit('update:view', {
    ...props.view,
    fields: { ...props.view.fields, sellingPoints: points },
    suggestions: props.view.suggestions.filter((key) => key !== 'sellingPoints'),
    fieldSources: { ...props.view.fieldSources, sellingPoints: [] },
  });
};
const addSellingPoint = () => updateSellingPoints([...props.view.fields.sellingPoints, '']);
const updateSellingPoint = (index: number, value: string) => {
  if (index < 0 || index >= props.view.fields.sellingPoints.length) return;
  updateSellingPoints(
    props.view.fields.sellingPoints.map((point, i) => (i === index ? value : point)),
  );
};
const removeSellingPoint = async (index: number) => {
  if (!editable.value) return;
  const points = props.view.fields.sellingPoints;
  const value = points[index];
  if (value === undefined) return;
  const projectId = props.projectId;
  const workflowRunId = props.workflowRunId;
  if (
    value.trim() &&
    !(await requestActionConfirmation({
      eyebrow: '删除卖点',
      title: `删除“${value.trim().slice(0, 36)}${value.trim().length > 36 ? '…' : ''}”？`,
      description: '该卖点会从当前信息卡草稿中移除，保存后用于后续分镜创作。',
      confirmLabel: '确认删除',
      tone: 'danger',
    }))
  )
    return;
  if (
    projectId !== props.projectId ||
    workflowRunId !== props.workflowRunId ||
    points !== props.view.fields.sellingPoints
  )
    return;
  updateSellingPoints(points.filter((_point, i) => i !== index));
};
const acknowledgeIssue = (id: string) => {
  if (editable.value)
    emit('update:view', {
      ...props.view,
      issues: props.view.issues.filter((issue) => issue.id !== id),
    });
};
const useAlternative = (id: string, field: CustomizedExtractionTextFieldKey, value: string) => {
  if (!editable.value) return;
  emit('update:view', {
    ...props.view,
    fields: { ...props.view.fields, [field]: value },
    issues: props.view.issues.filter((issue) => issue.id !== id),
    fieldSources: { ...props.view.fieldSources, [field]: [] },
    suggestions: props.view.suggestions.filter((key) => key !== field),
  });
};

// Execution status and details are supplied by the API-backed workspace adapter.
</script>

<template>
  <section class="customized-extraction-node" aria-labelledby="customized-extraction-title">
    <WorkflowPageLoading
      v-if="loading"
      icon="extraction"
      title="正在恢复信息提炼"
      description="正在读取当前项目的视频创作信息…"
    />
    <div v-else-if="loadError" class="extraction-page-state" role="alert">
      <AlertCircle :size="30" />
      <h2>信息提炼加载失败</h2>
      <p>{{ loadError }}</p>
      <button type="button" @click="emit('retry')"><RefreshCw :size="14" />重新加载</button>
    </div>
    <template v-else>
      <WorkflowEditingBanner
        v-if="view.temporary"
        node-label="信息提炼"
        description="修改先保留在编辑副本中；保存版本后用于分镜创作，取消编辑返回原版本。"
      />
      <header class="extraction-heading">
        <div class="extraction-heading__title">
          <span>02</span>
          <div>
            <h2 id="customized-extraction-title">视频创作信息卡</h2>
            <p>整理品牌信息、产品信息与视觉约束，确认后用于分镜创作</p>
          </div>
        </div>
        <div class="extraction-heading__actions">
          <WorkflowNodeEditActions
            :editing="view.editing"
            :temporary="view.temporary"
            :disabled="actionDisabled || (!view.committed && !view.editing)"
            :save-disabled="!editable || view.status !== 'COMPLETED'"
            :saving="view.saving"
            @begin="emit('beginEdit')"
            @cancel="emit('cancelEdit')"
            @save="emit('save')"
          />
          <WorkflowExtractionActions
            :disabled="actionDisabled"
            :running="running"
            :label="view.status === 'EMPTY' ? 'AI 提炼' : '重新 AI 提炼'"
            @extract="emit('extract')"
            @details="workflowOpen = true"
          />
        </div>
      </header>

      <div v-if="sourceConfirmed && !available" class="state-alert information" role="status">
        <AlertCircle :size="17" />
        <div>
          <strong>尚未开始提炼</strong>
          <p>资料已保留，AI 提炼功能待接入；下方展示信息卡结构，生成后可审阅与修改。</p>
        </div>
      </div>
      <div v-if="view.status === 'STALE'" class="state-alert warning" role="status">
        <AlertCircle :size="17" />
        <div>
          <strong>上游资料已更新</strong>
          <p>旧结果仍可查看，重新提炼并保存版本后继续分镜创作。</p>
        </div>
      </div>
      <WorkflowExtractionFeedback
        v-if="view.status === 'FAILED' || view.status === 'PARTIAL'"
        :title="view.status === 'PARTIAL' ? '部分资料未能完成提炼' : '本次提炼失败'"
        :message="view.error || '请重试，已确认的信息仍保留。'"
        action="重试失败文档"
        :disabled="actionDisabled"
        @action="emit('retryTask')"
      />
      <WorkflowRunProgress
        v-if="running"
        :progress="view.progress"
        :summary="view.progressMessage || '正在等待任务状态'"
        @show-details="workflowOpen = true"
      />

      <div class="result-grid" :aria-busy="running">
        <WorkflowInformationCard
          v-for="section in fieldDefinitions"
          :key="section.title"
          class="content-block"
          :class="[`card-${section.id}`, { 'content-block--identity': section.badge }]"
          :data-section="section.id"
        >
          <div class="block-heading">
            <div>
              <h3>{{ section.title }}</h3>
              <p v-if="section.description">{{ section.description }}</p>
            </div>
            <span v-if="section.badge" class="identity-badge">{{ section.badge }}</span>
          </div>
          <div class="base-fields">
            <template v-for="field in section.fields" :key="field.key">
              <WorkflowSellingPointsEditor
                v-if="field.key === 'sellingPoints'"
                class="wide"
                title="核心卖点"
                :items="view.fields.sellingPoints"
                :readonly="!editable"
                single-column
                @add="addSellingPoint"
                @update-item="updateSellingPoint"
                @remove="removeSellingPoint"
              >
                <template #heading-source>
                  <span v-if="view.suggestions.includes('sellingPoints')" class="suggestion-label"
                    >AI 建议</span
                  >
                  <button
                    v-if="view.fieldSources.sellingPoints?.length"
                    type="button"
                    class="field-source"
                    aria-label="查看核心卖点来源"
                    @click="openSources(view.fieldSources.sellingPoints)"
                  >
                    来源
                  </button>
                </template>
              </WorkflowSellingPointsEditor>
              <WorkflowInformationField
                v-else
                :label="field.label"
                :model-value="view.fields[field.key]"
                :multiline="!!field.multiline"
                :readonly="!editable"
                :class="{ wide: field.wide }"
                :placeholder="view.status === 'EMPTY' ? '待提炼' : '未提供 / 待确认'"
                @update:model-value="updateField(field.key, $event)"
              >
                <template #source
                  ><span v-if="view.suggestions.includes(field.key)" class="suggestion-label"
                    >AI 建议</span
                  ><button
                    v-if="view.fieldSources[field.key]?.length"
                    type="button"
                    class="field-source"
                    :aria-label="`查看${field.label}来源`"
                    @click="openSources(view.fieldSources[field.key]!)"
                  >
                    来源
                  </button></template
                >
              </WorkflowInformationField>
              <div
                v-for="issue in view.issues.filter((item) => item.field === field.key)"
                :key="issue.id"
                class="field-issue wide"
              >
                <WorkflowExtractionFeedback
                  title="待确认信息"
                  :message="issue.message"
                  tone="warning"
                />
                <div class="issue-actions">
                  <button type="button" @click="openSources(issue.sourceIds)">查看来源</button
                  ><button
                    v-for="option in issue.alternatives"
                    :key="option"
                    type="button"
                    :disabled="!editable"
                    @click="useAlternative(issue.id, issue.field, option)"
                  >
                    采用：{{ option }}</button
                  ><button type="button" :disabled="!editable" @click="acknowledgeIssue(issue.id)">
                    确认保留当前填写
                  </button>
                </div>
              </div>
            </template>
          </div>
        </WorkflowInformationCard>
      </div>
      <div v-if="view.committed && !view.editing" class="confirmed-note">
        <CheckCircle2 :size="14" />版本已保存，进入编辑后可修改
      </div>
      <WorkflowNodeFooter
        back-label="上一步：资料导入"
        next-label="下一步：分镜创作"
        :show-validate="false"
        :next-disabled="!ready"
        @back="emit('back')"
        @next="emit('next')"
      />
    </template>

    <WorkflowInformationDialog
      :open="sourcesOpen"
      title="来源资料"
      description="查看已确认简报与品牌素材；历史图片保留原有参考用途"
      @close="sourcesOpen = false"
    >
      <p v-if="!shownSources.length" class="dialog-empty">
        {{
          sourceConfirmed
            ? '暂无可查看的来源，请返回资料导入核对。'
            : '请先在资料导入中保存版本，未确认的草稿不会作为提炼来源。'
        }}
      </p>
      <div class="source-files">
        <ImportMaterialRow
          v-for="source in shownSources"
          :key="`${source.reference.assetId}:${source.reference.assetVersion}`"
          :name="source.asset?.originalFileName || '资料暂不可用'"
          :error="source.error"
          :description="
            source.reference.category === 'VISUAL_REFERENCE'
              ? source.reference.imageUsage
                ? CUSTOMIZED_IMAGE_USAGE_LABELS[source.reference.imageUsage]
                : '未指定参考用途'
              : '视频创作简报 / 补充文档'
          "
        >
          <template #preview
            ><span class="source-thumbnail"
              ><ImportImagePreview
                v-if="source.asset && source.reference.category === 'VISUAL_REFERENCE'"
                :file="{
                  id: source.reference.assetId,
                  projectId,
                  name: source.asset.originalFileName,
                  mimeType: source.asset.mimeType,
                  contentUrl: source.asset.contentUrl,
                  updatedAt: source.asset.updatedAt,
                  ready: !source.error,
                }" /><FileText v-else :size="23" /></span
          ></template>
          <template #actions
            ><button
              type="button"
              :disabled="!source.asset || !!source.error"
              @click="readSource(source.reference.assetId, $event)"
            >
              <FileText :size="13" />查看内容
            </button></template
          >
        </ImportMaterialRow>
      </div>
    </WorkflowInformationDialog>
    <WorkflowExtractionGraphDialog
      :open="workflowOpen"
      title="视频创作信息提炼工作流"
      :subtitle="`${view.fields.productName || '当前简报'} · ${view.progress}%`"
      :nodes="CUSTOMIZED_EXTRACTION_NODES"
      :executions="task?.nodes ?? []"
      :selected-node-id="selectedGraphNode ?? null"
      :detail="graphDetail ?? null"
      :detail-loading="graphLoading ?? false"
      :detail-error="graphError ?? ''"
      @close="
        workflowOpen = false;
        emit('closeGraph');
      "
      @select="emit('selectGraphNode', $event)"
      @refresh="selectedGraphNode && emit('selectGraphNode', selectedGraphNode)"
    />
  </section>
</template>

<style scoped>
.customized-extraction-node {
  padding: 22px;
  color: #17233a;
  background: #fff;
  border: 1px solid #e2e9f4;
  border-radius: 20px;
  box-shadow: 0 8px 25px #7a4e3b0c;
}
.extraction-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  margin-bottom: 22px;
  flex-wrap: wrap;
}
.extraction-heading__title {
  display: flex;
  gap: 13px;
  align-items: center;
}
.extraction-heading__title > span {
  display: grid;
  flex: 0 0 44px;
  height: 44px;
  place-items: center;
  color: #d83e69;
  background: #fff0f4;
  border-radius: 14px;
  font-size: 13px;
  font-weight: 900;
}
h2,
h3,
h4,
p {
  margin: 0;
}
h2 {
  font-size: 21px;
}
h3 {
  color: #263247;
  font-size: 15px;
}
h4 {
  color: #263247;
  font-size: 14px;
}
.extraction-heading p {
  margin-top: 5px;
  color: #7d899d;
  font-size: 12px;
  line-height: 1.6;
}
.extraction-heading__actions {
  display: flex;
  flex-wrap: wrap;
  margin-left: auto;
  gap: 10px;
}
button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 36px;
  padding: 0 13px;
  color: #3f5f8c;
  background: #fff;
  border: 1px solid #cbd8ea;
  border-radius: 8px;
  font-size: 11px;
  font-weight: 750;
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
.state-alert {
  display: flex;
  gap: 12px;
  align-items: flex-start;
  margin-bottom: 18px;
  padding: 14px 16px;
  border: 1px solid;
  border-radius: 12px;
  font-size: 13px;
}
.state-alert > svg {
  flex-shrink: 0;
  margin-top: 1px;
}
.state-alert > div {
  flex: 1;
}
.state-alert p {
  margin-top: 4px;
  font-size: 12px;
  line-height: 1.6;
}
.warning {
  color: #956315;
  background: #fff8e8;
  border-color: #f2dfb4;
}
.information {
  color: #35658a;
  background: #f1f8fc;
  border-color: #cfe5f2;
}
.danger {
  color: #a53d4b;
  background: #fff1f2;
  border-color: #f7c8ce;
}
.result-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  grid-template-areas: 'brand product';
  gap: 18px;
  margin-top: 18px;
}
.card-product {
  grid-area: product;
}
.card-brand {
  grid-area: brand;
}
.content-block--identity {
  padding: 0;
  overflow: hidden;
  background: #f7faff;
}
.content-block--identity .block-heading {
  align-items: center;
  margin-bottom: 0;
  padding: 22px 24px;
  border-bottom: 1px solid #f0e2db;
}
.identity-badge {
  padding: 6px 12px;
  color: #2563eb;
  background: #edf4ff;
  border-radius: 10px;
  font-size: 12px;
  font-weight: 650;
}
.base-fields {
  grid-template-columns: minmax(0, 1fr);
  gap: 24px;
  padding: 24px;
}
.content-block--identity :deep(input) {
  height: 52px;
  padding: 0 14px;
}
.content-block--identity :deep(.selling-point-row input) {
  height: 40px;
  padding: 0 11px;
}
.content-block--identity :deep(textarea) {
  height: 100px;
  min-height: 100px;
  padding: 9px 14px;
  resize: vertical;
}
@media (max-width: 680px) {
  .content-block--identity .block-heading {
    padding: 18px 16px;
  }
  .content-block--identity .base-fields {
    padding: 20px 16px;
  }
}
.block-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 16px;
}
.block-heading p {
  margin-top: 5px;
  color: #9198a7;
  font-size: 12px;
  line-height: 1.6;
}
.block-heading small {
  color: #8492a8;
  font-size: 11px;
  font-weight: 400;
  margin-left: 6px;
}
.base-fields {
  display: grid;
  align-items: start;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 18px 16px;
}
.wide {
  grid-column: 1 / -1;
}
.field-source {
  padding: 0;
  min-height: 22px;
  border: 0;
  color: #6b85ab;
  font-size: 11px;
  font-weight: 400;
}
.suggestion-label {
  margin-left: auto;
  color: #8057c7;
  font-size: 11px;
  font-weight: 400;
}
.issues-panel {
  padding: 16px;
  background: #fff8e8;
  border: 1px solid #f2dfb4;
  border-radius: 12px;
}
.issues-panel article {
  display: flex;
  gap: 10px;
  margin-top: 12px;
  color: #956315;
  font-size: 12px;
}
.issues-panel svg {
  flex-shrink: 0;
}
.issues-panel p {
  margin-top: 5px;
  line-height: 1.6;
}
.issue-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 10px;
}
.issue-actions button {
  height: auto;
  padding: 6px 10px;
  text-align: left;
  overflow-wrap: anywhere;
}
.confirmed-note {
  display: flex;
  gap: 6px;
  margin-top: 18px;
  color: #759182;
  font-size: 12px;
}
.source-files {
  display: grid;
  gap: 12px;
}
.source-thumbnail {
  display: grid;
  width: 48px;
  height: 48px;
  place-items: center;
  color: #6f89ad;
  background: #eef3fb;
  border-radius: 10px;
  overflow: hidden;
}
.dialog-empty,
.workflow-explanation {
  color: #8492a8;
  font-size: 13px;
  line-height: 1.7;
}
.workflow-overview {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 12px;
}
.workflow-overview > div {
  display: grid;
  gap: 9px;
  padding: 16px 12px;
  border: 1px solid #e2e9f4;
  border-radius: 12px;
  text-align: center;
}
.workflow-overview span {
  color: #6b85ab;
  font-size: 12px;
}
.workflow-overview strong {
  font-size: 13px;
}
.workflow-overview small {
  color: #a0aec0;
  font-size: 10px;
}
.workflow-explanation {
  margin-top: 16px;
}
.extraction-page-state {
  display: grid;
  gap: 12px;
  min-height: 260px;
  align-content: center;
  justify-items: center;
  color: #8492a8;
  text-align: center;
}
@media (max-width: 980px) {
  .result-grid {
    grid-template-columns: minmax(0, 1fr);
    grid-template-areas: none;
  }
  .content-block {
    grid-area: auto;
  }
}
@media (max-width: 680px) {
  .customized-extraction-node {
    padding: 16px;
  }
  .extraction-heading__actions {
    margin-left: 0;
  }
  .base-fields {
    grid-template-columns: minmax(0, 1fr);
  }
  .state-alert {
    flex-wrap: wrap;
  }
  .workflow-overview {
    grid-template-columns: minmax(0, 1fr);
  }
  .workflow-overview > div {
    grid-template-columns: 24px minmax(0, 1fr) auto;
    align-items: center;
    text-align: left;
  }
}
</style>
