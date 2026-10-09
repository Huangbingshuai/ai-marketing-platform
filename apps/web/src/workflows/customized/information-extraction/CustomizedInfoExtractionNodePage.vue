<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  FileText,
  Images,
  Plus,
  RefreshCw,
  Trash2,
  Workflow,
} from '@lucide/vue';
import { CUSTOMIZED_IMAGE_USAGE_LABELS } from '@ai-marketing/contracts';
import { WorkflowNodeFooter, WorkflowRunProgress } from '@ai-marketing/ui';
import WorkflowPageLoading from '../../../platform/workflow/components/WorkflowPageLoading.vue';
import WorkflowNodeEditActions from '../../../platform/workflow/components/WorkflowNodeEditActions.vue';
import WorkflowEditingBanner from '../../../platform/workflow/components/WorkflowEditingBanner.vue';
import WorkflowInformationCard from '../../../platform/workflow/components/WorkflowInformationCard.vue';
import WorkflowInformationField from '../../../platform/workflow/components/WorkflowInformationField.vue';
import WorkflowInformationDialog from '../../../platform/workflow/components/WorkflowInformationDialog.vue';
import ImportMaterialRow from '../../../platform/file/components/ImportMaterialRow.vue';
import ImportImagePreview from '../../../platform/file/components/ImportImagePreview.vue';
import {
  emptyCustomizedExtractionView,
  customizedExtractionEditable,
  customizedExtractionReady,
  type CustomizedExtractionView,
  type CustomizedExtractionFieldKey,
  type CustomizedExtractionSource,
} from './customized-extraction-view';

const props = withDefaults(
  defineProps<{
    projectId: string;
    workflowRunId: string;
    projectName: string;
    sourceConfirmed: boolean;
    sourceRevision?: number | null;
    sources: CustomizedExtractionSource[];
    view?: CustomizedExtractionView;
    available?: boolean;
    loading?: boolean;
    loadError?: string;
  }>(),
  {
    view: () => emptyCustomizedExtractionView(),
    available: false,
    loading: false,
    loadError: '',
    sourceRevision: null,
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
const docs = computed(() =>
  props.sources.filter((source) => source.reference.category !== 'VISUAL_REFERENCE'),
);
const images = computed(() =>
  props.sources.filter((source) => source.reference.category === 'VISUAL_REFERENCE'),
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
  title: string;
  description: string;
  fields: {
    key: CustomizedExtractionFieldKey;
    label: string;
    wide?: boolean;
    multiline?: boolean;
    options?: string[];
  }[];
}[] = [
  {
    title: '项目与视频用途',
    description: '明确视频的用途与发布位置',
    fields: [
      { key: 'videoPurpose', label: '视频用途' },
      { key: 'publication', label: '发布平台或位置' },
    ],
  },
  {
    title: '品牌与产品信息',
    description: '整理资料中已有的主体介绍、规格和使用方式',
    fields: [
      { key: 'subjectName', label: '品牌或产品名称', wide: true },
      { key: 'subjectDescription', label: '品牌或产品介绍', wide: true, multiline: true },
      { key: 'specificationAndUsage', label: '相关规格与用法', wide: true, multiline: true },
    ],
  },
  {
    title: '目标受众',
    description: '未限定的受众信息可以留空，不自动推测',
    fields: [
      {
        key: 'audienceAge',
        label: '目标人群年龄段',
        options: ['18-24', '25-30', '31-40', '41-50', '50+', '不限'],
      },
      { key: 'audienceGender', label: '性别倾向', options: ['女性为主', '男性为主', '不限'] },
      { key: 'audienceRegion', label: '地域', options: ['一线城市', '全国', '特定省份'] },
      { key: 'audienceProfile', label: '兴趣标签 / 人群画像', wide: true, multiline: true },
    ],
  },
  {
    title: '创意与风格',
    description: '保留希望表达的信息与全片视觉偏好',
    fields: [
      { key: 'coreMessage', label: '核心主题 / 传达信息', wide: true, multiline: true },
      {
        key: 'visualStyle',
        label: '视觉风格偏好',
        wide: true,
        options: [
          '写实',
          '插画',
          '国潮',
          '科技感',
          '极简',
          '温暖',
          '高端',
          '卡通',
          '赛博朋克',
          '复古',
          '清新',
          '商务',
          '其他',
        ],
      },
      { key: 'mainColors', label: '主色调偏好' },
      {
        key: 'emotionalTone',
        label: '情绪调性',
        options: ['活泼轻快', '温馨治愈', '高级质感', '炫酷冲击', '沉稳专业', '趣味搞怪', '待确认'],
      },
    ],
  },
  {
    title: '视频规格',
    description: '保留时长范围、画幅与尚待确定的内容',
    fields: [
      {
        key: 'duration',
        label: '视频时长',
        options: ['5～15 秒', '15～30 秒', '30～60 秒', '60 秒以上', '自定义'],
      },
      {
        key: 'aspectRatio',
        label: '画幅或尺寸',
        options: ['竖屏 9:16', '横屏 16:9', '方形 1:1', '自定义尺寸'],
      },
    ],
  },
];
const updateField = (field: CustomizedExtractionFieldKey, value: string) => {
  if (!editable.value) return;
  emit('update:view', {
    ...props.view,
    fields: { ...props.view.fields, [field]: value },
    suggestions: props.view.suggestions.filter((key) => key !== field),
    fieldSources: { ...props.view.fieldSources, [field]: [] },
  });
};
const chooseOption = (field: CustomizedExtractionFieldKey, option: string) => {
  const multi = field === 'visualStyle';
  const value = props.view.fields[field].trim();
  updateField(field, multi && value ? `${value}、${option}` : option);
};
type ListKey = 'facts' | 'avoidedElements';
const updateList = (key: ListKey, id: string, text: string) => {
  if (!editable.value) return;
  emit('update:view', {
    ...props.view,
    [key]: props.view[key].map((item) =>
      item.id === id ? { ...item, text, sourceIds: [] } : item,
    ),
  });
};
const addItem = (key: ListKey) => {
  if (!editable.value) return;
  emit('update:view', {
    ...props.view,
    [key]: [...props.view[key], { id: crypto.randomUUID(), text: '', sourceIds: [] }],
  });
};
const removeItem = (key: ListKey, id: string) => {
  if (editable.value)
    emit('update:view', { ...props.view, [key]: props.view[key].filter((item) => item.id !== id) });
};
const acknowledgeIssue = (id: string) => {
  if (editable.value)
    emit('update:view', {
      ...props.view,
      issues: props.view.issues.filter((issue) => issue.id !== id),
    });
};
const useAlternative = (id: string, field: CustomizedExtractionFieldKey, value: string) => {
  if (!editable.value) return;
  emit('update:view', {
    ...props.view,
    fields: { ...props.view.fields, [field]: value },
    issues: props.view.issues.filter((issue) => issue.id !== id),
    fieldSources: { ...props.view.fieldSources, [field]: [] },
    suggestions: props.view.suggestions.filter((key) => key !== field),
  });
};
const phaseLabels = ['读取资料', '文档解析', '信息整理', '差异核对', '结果保存'];
// No fabricated per-step progress: the future adapter must provide real execution detail.
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
        v-if="view.editing"
        node-label="信息提炼"
        description="修改先保留在编辑副本中；保存版本后用于分镜创作，取消编辑返回原版本。"
      />
      <header class="extraction-heading">
        <div class="extraction-heading__title">
          <span>02</span>
          <div>
            <h2 id="customized-extraction-title">视频创作信息卡</h2>
            <p>整理主体信息、创作方向和视频规格，确认后用于分镜创作</p>
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
          <button
            type="button"
            :disabled="actionDisabled"
            :title="!available ? 'AI 提炼功能待接入' : !sourceConfirmed ? '请先保存资料版本' : ''"
            @click="emit('extract')"
          >
            <RefreshCw :size="14" />{{ view.status === 'EMPTY' ? 'AI 提炼' : '重新 AI 提炼' }}
          </button>
          <button type="button" @click="workflowOpen = true">
            <Workflow :size="14" />查看工作流
          </button>
        </div>
      </header>

      <div class="source-summary">
        <div>
          <FileText :size="17" /><span>{{ projectName }}</span
          ><small>{{
            sourceConfirmed
              ? `资料版本 ${sourceRevision ?? '已确认'} · ${docs.length} 份文档 · ${images.length} 张参考图片`
              : '尚无已确认的资料包'
          }}</small>
        </div>
        <button type="button" @click="openSources()"><Images :size="14" />查看来源资料</button>
      </div>
      <div v-if="!sourceConfirmed" class="state-alert warning" role="status">
        <AlertCircle :size="17" />
        <div>
          <strong>请先确认导入资料</strong>
          <p>返回资料导入并保存版本后，再以已确认的简报开始提炼。</p>
        </div>
        <button type="button" @click="emit('back')"><ArrowLeft :size="14" />返回资料导入</button>
      </div>
      <div v-else-if="!available" class="state-alert information" role="status">
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
      <div
        v-if="view.status === 'FAILED' || view.status === 'PARTIAL'"
        class="state-alert danger"
        role="alert"
      >
        <AlertCircle :size="17" />
        <div>
          <strong>{{ view.status === 'PARTIAL' ? '部分资料未能完成提炼' : '本次提炼失败' }}</strong>
          <p>{{ view.error || '请重试，已确认的信息不会被本次失败覆盖。' }}</p>
        </div>
        <button type="button" :disabled="actionDisabled" @click="emit('extract')">重新提炼</button>
      </div>
      <WorkflowRunProgress
        v-if="running"
        :progress="view.progress"
        :summary="view.progressMessage || '正在等待任务状态'"
        @show-details="workflowOpen = true"
      />

      <div v-if="view.issues.length" class="issues-panel">
        <h3>
          待确认信息 <small>{{ view.issues.length }} 项</small>
        </h3>
        <article v-for="issue in view.issues" :key="issue.id">
          <AlertCircle :size="16" />
          <div>
            <strong>{{ issue.message }}</strong>
            <p>查看来源后选择采用内容，也可在对应字段中自行修改。</p>
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
        </article>
      </div>

      <div class="result-grid" :aria-busy="running">
        <WorkflowInformationCard
          v-for="section in fieldDefinitions"
          :key="section.title"
          class="content-block"
        >
          <div class="block-heading">
            <div>
              <h3>{{ section.title }}</h3>
              <p>{{ section.description }}</p>
            </div>
          </div>
          <div class="base-fields">
            <WorkflowInformationField
              v-for="field in section.fields"
              :key="field.key"
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
              <details v-if="field.options && editable" class="option-reference">
                <summary>可选项参考</summary>
                <div>
                  <button
                    v-for="option in field.options"
                    :key="option"
                    type="button"
                    @click="chooseOption(field.key, option)"
                  >
                    {{ option }}
                  </button>
                </div>
              </details>
            </WorkflowInformationField>
          </div>
          <div
            v-if="section.title === '品牌与产品信息' || section.title === '创意与风格'"
            class="item-section"
          >
            <template
              v-for="list in [
                section.title === '品牌与产品信息'
                  ? ('facts' as const)
                  : ('avoidedElements' as const),
              ]"
              :key="list"
            >
              <div class="block-heading">
                <div>
                  <h4>
                    {{ list === 'facts' ? '产品特点与事实' : '必须避免的元素' }}
                    <small>{{ view[list].length }} 条</small>
                  </h4>
                  <p>
                    {{
                      list === 'facts'
                        ? '保留有资料依据的特点，不将创作愿望作为产品事实'
                        : '没有特别限制时可以留空'
                    }}
                  </p>
                </div>
                <button
                  type="button"
                  :disabled="!editable"
                  :aria-label="list === 'facts' ? '添加产品事实' : '添加避免元素'"
                  @click="addItem(list)"
                >
                  <Plus :size="13" />添加
                </button>
              </div>
              <p v-if="!view[list].length" class="empty-inline">
                {{
                  view.status === 'EMPTY'
                    ? '尚未提炼'
                    : list === 'facts'
                      ? '暂无产品事实，可在编辑时补充'
                      : '暂无避免元素'
                }}
              </p>
              <div v-for="(item, index) in view[list]" :key="item.id" class="information-item">
                <textarea
                  :value="item.text"
                  :readonly="!editable"
                  :aria-label="`${list === 'facts' ? '产品事实' : '避免元素'} ${index + 1}`"
                  placeholder="填写一条完整内容"
                  @input="updateList(list, item.id, ($event.target as HTMLTextAreaElement).value)"
                />
                <button
                  type="button"
                  :disabled="!editable"
                  :aria-label="`删除${list === 'facts' ? '产品事实' : '避免元素'} ${index + 1}`"
                  @click="removeItem(list, item.id)"
                >
                  <Trash2 :size="14" />
                </button>
                <button
                  v-if="item.sourceIds.length"
                  class="field-source item-source"
                  type="button"
                  :aria-label="`查看${list === 'facts' ? '产品事实' : '避免元素'} ${index + 1}来源`"
                  @click="openSources(item.sourceIds)"
                >
                  查看来源资料
                </button>
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
      description="查看已确认简报与参考图片；图片保留原有参考用途"
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
    <WorkflowInformationDialog
      :open="workflowOpen"
      title="信息提炼工作流"
      description="将确认的资料整理为视频创作信息，提炼结果需审阅后保存版本"
      @close="workflowOpen = false"
    >
      <div class="workflow-overview">
        <div v-for="(phase, index) in phaseLabels" :key="phase">
          <span>{{ String(index + 1).padStart(2, '0') }}</span
          ><strong>{{ phase }}</strong
          ><small>待接入执行状态</small>
        </div>
      </div>
      <p class="workflow-explanation">
        {{
          available
            ? '当前整体任务状态由进度条展示，步骤详情待接入。'
            : 'AI 提炼尚未接入，当前没有执行任务。'
        }}
      </p>
    </WorkflowInformationDialog>
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
button:focus-visible,
summary:focus-visible {
  outline: 2px solid #7da7ef;
  outline-offset: 3px;
}
.source-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px;
  padding: 12px 15px;
  margin-bottom: 18px;
  background: #f8faff;
  border: 1px solid #e3ebf7;
  border-radius: 12px;
}
.source-summary > div {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 9px;
  min-width: 0;
  font-size: 13px;
}
.source-summary span {
  overflow-wrap: anywhere;
}
.source-summary small {
  color: #8492a8;
  font-size: 11px;
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
  grid-template-columns: minmax(0, 1fr);
  gap: 18px;
  margin-top: 18px;
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
.item-section {
  margin-top: 22px;
  padding-top: 20px;
  border-top: 1px solid #edf0f5;
}
.empty-inline {
  padding: 12px 0;
  color: #a0aec0;
  font-size: 13px;
}
.information-item {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 38px;
  gap: 7px;
  margin-top: 12px;
}
.information-item textarea {
  box-sizing: border-box;
  min-width: 0;
  width: 100%;
  min-height: 56px;
  padding: 8px 11px;
  border: 1px solid #dce3ec;
  border-radius: 10px;
  color: #42526a;
  font: inherit;
  font-size: 14px;
  line-height: 1.6;
  resize: vertical;
}
.information-item > button {
  padding: 0;
  align-self: start;
}
.item-source {
  grid-column: 1;
  justify-self: start;
}
.option-reference {
  color: #8492a8;
  font-size: 11px;
  font-weight: 400;
}
.option-reference summary {
  cursor: pointer;
}
.option-reference > div {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding-top: 8px;
}
.option-reference button {
  min-height: 28px;
  padding: 3px 8px;
  font-weight: 400;
  font-size: 11px;
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
