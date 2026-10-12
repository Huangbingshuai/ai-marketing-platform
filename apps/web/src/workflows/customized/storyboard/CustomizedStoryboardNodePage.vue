<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import {
  ArrowRight,
  Check,
  ChevronDown,
  Clock3,
  Download,
  GitCompareArrows,
  Layers3,
  ListOrdered,
  Plus,
  Upload,
  X,
  Pencil,
  BookOpen,
  Clapperboard,
} from '@lucide/vue';
import type {
  CustomizedStoryboardDraft,
  CustomizedStoryboardScript,
  CustomizedStoryboardShot,
  CustomizedStoryboardAsset,
  StoryboardTask,
  CustomizedBrief,
} from '@ai-marketing/contracts';
import { CUSTOMIZED_BRIEF_LABELS, isCustomizedStoryboardScript } from '@ai-marketing/contracts';
import { WorkflowNodeFooter, WorkflowRunProgress } from '@ai-marketing/ui';
import WorkflowNodeEditActions from '../../../platform/workflow/components/WorkflowNodeEditActions.vue';
import WorkflowEditingBanner from '../../../platform/workflow/components/WorkflowEditingBanner.vue';
import WorkflowExtractionActions from '../../../platform/workflow/components/WorkflowExtractionActions.vue';
import StoryboardExecutionDialog from './StoryboardExecutionDialog.vue';
import WorkflowInformationCard from '../../../platform/workflow/components/WorkflowInformationCard.vue';
import WorkflowInformationField from '../../../platform/workflow/components/WorkflowInformationField.vue';
import WorkflowInformationDialog from '../../../platform/workflow/components/WorkflowInformationDialog.vue';
import WorkflowExtractionFeedback from '../../../platform/workflow/components/WorkflowExtractionFeedback.vue';
import { requestActionConfirmation } from '../../../shared/composables/action-confirmation';
import StoryboardShotCard from './StoryboardShotCard.vue';
import StoryboardAssetRequirements from './StoryboardAssetRequirements.vue';
import {
  createStoryboardScript,
  createStoryboardShot,
  reorderStoryboardShot,
  scriptDuration,
  snapshotStoryboard,
  storyboardText,
  importStoryboardScript,
} from './storyboard-state';
const props = defineProps<{
  preview: boolean;
  editing: boolean;
  sourceReady: boolean;
  readonly: boolean;
  saving: boolean;
  dirty: boolean;
  productName: string;
  saveMessage: string;
  error: string;
  stale: boolean;
  projectId: string;
  task: StoryboardTask | null;
  brief: CustomizedBrief | null;
  sourceRevision: number | null;
  nextReady: boolean;
  canDiscard?: boolean;
  progress?: { value: number; summary: string; terminal: boolean } | undefined;
}>();
const draft = defineModel<CustomizedStoryboardDraft>('draft', { required: true });
const emit = defineEmits<{
  back: [];
  begin: [];
  cancel: [];
  save: [];
  preview: [];
  exitPreview: [];
  reload: [];
  generate: [];
  retry: [];
  stop: [];
  select: [id: string];
  create: [script: CustomizedStoryboardScript, origin: 'MANUAL' | 'IMPORT'];
  next: [];
  discard: [];
}>();
const settingsExpanded = ref(false),
  compareOpen = ref(false),
  graphOpen = ref(false),
  briefOpen = ref(false),
  scriptEditor = ref<CustomizedStoryboardScript | null>(null),
  importOpen = ref(false),
  notice = ref('');
const compareLeft = ref(''),
  compareRight = ref(''),
  dragId = ref('');
const shotCards = ref<InstanceType<typeof StoryboardShotCard>[]>([]);
let disposed = false;
onBeforeUnmount(() => {
  disposed = true;
});
const active = computed(
  () => draft.value.scripts.find((s) => s.id === draft.value.activeScriptId) ?? null,
);
const editable = computed(() => props.preview || (props.editing && !props.readonly));
const left = computed(() => draft.value.scripts.find((s) => s.id === compareLeft.value));
const right = computed(() => draft.value.scripts.find((s) => s.id === compareRight.value));
const duration = computed(() => (active.value ? scriptDuration(active.value) : 0));
const durationMismatch = computed(
  () => active.value?.shots.length && duration.value !== draft.value.settings.targetDurationSeconds,
);
const running = computed(() => !!props.task && ['QUEUED', 'RUNNING'].includes(props.task.status));
const settingsEditable = computed(
  () => props.preview || (props.sourceReady && !props.readonly && !running.value),
);
async function guardEditor() {
  const scope = draft.value;
  if (!shotCards.value.some((c) => c.hasPendingEdit())) return true;
  if (
    !(await requestActionConfirmation({
      title: '放弃尚未保存的镜头编辑？',
      description: '已保存到脚本的内容会保留，当前镜头输入将被放弃。',
      confirmLabel: '放弃编辑',
    }))
  )
    return false;
  if (disposed || draft.value !== scope) return false;
  shotCards.value.forEach((c) => c.cancel());
  return true;
}
async function selectScript(id: string) {
  if (id !== draft.value.activeScriptId && (await guardEditor())) {
    if (props.preview) draft.value.activeScriptId = id;
    else emit('select', id);
  }
}
async function addScript() {
  if (!settingsEditable.value || draft.value.scripts.length >= 100 || !(await guardEditor()))
    return;
  const script = createStoryboardScript(`自定义脚本 ${draft.value.scripts.length + 1}`);
  if (props.preview) {
    draft.value.scripts.push(script);
    draft.value.activeScriptId = script.id;
    scriptEditor.value = snapshotStoryboard(script);
  } else emit('create', script, 'MANUAL');
}
function saveScriptMeta() {
  if (!scriptEditor.value?.name.trim()) return;
  const target = draft.value.scripts.find((s) => s.id === scriptEditor.value!.id);
  if (target) {
    target.name = scriptEditor.value.name.trim();
    target.synopsis = scriptEditor.value.synopsis;
    target.structure = scriptEditor.value.structure;
    target.productFocus = scriptEditor.value.productFocus;
  }
  scriptEditor.value = null;
}
async function removeShot(id: string) {
  if (!active.value || !editable.value || !(await guardEditor())) return;
  if (
    await requestActionConfirmation({
      title: '删除这个镜头？',
      description: '其余镜头会保留，镜号将按新的顺序排列。',
      confirmLabel: '删除镜头',
      tone: 'danger',
    })
  )
    active.value.shots = active.value.shots.filter((s) => s.id !== id);
}
async function move(id: string, offset: number) {
  if (!active.value || !editable.value || !(await guardEditor())) return;
  const index = active.value.shots.findIndex((s) => s.id === id),
    target = active.value.shots[index + offset];
  if (target) reorderStoryboardShot(active.value, id, target.id);
}
async function drop(id: string) {
  if (active.value && editable.value && (await guardEditor()))
    reorderStoryboardShot(active.value, dragId.value, id);
  dragId.value = '';
}
async function editShot(id: string) {
  if (!editable.value || !(await guardEditor())) return;
  shotCards.value.find((c) => c.id() === id)?.begin();
}
function updateShot(shot: CustomizedStoryboardShot, assets: CustomizedStoryboardAsset[]) {
  if (!active.value || !editable.value) return;
  const i = active.value.shots.findIndex((s) => s.id === shot.id);
  if (i >= 0) {
    active.value.shots[i] = shot;
    active.value.assets = assets;
  }
}
async function addShot() {
  if (active.value && editable.value && active.value.shots.length < 500 && (await guardEditor()))
    active.value.shots.push(createStoryboardShot());
}
function openCompare() {
  compareLeft.value = active.value?.id ?? draft.value.scripts[0]?.id ?? '';
  compareRight.value = draft.value.scripts.find((s) => s.id !== compareLeft.value)?.id ?? '';
  compareOpen.value = true;
}
function download(format: 'json' | 'txt') {
  if (!active.value) return;
  const content =
    format === 'json'
      ? JSON.stringify({ schemaVersion: 1, script: active.value }, null, 2)
      : storyboardText(active.value);
  const url = URL.createObjectURL(
    new Blob([content], {
      type: format === 'json' ? 'application/json;charset=utf-8' : 'text/plain;charset=utf-8',
    }),
  );
  const a = document.createElement('a');
  a.href = url;
  a.download = `${active.value.name.replace(/[\\/:*?"<>|]/g, '_') || '分镜脚本'}${props.preview ? '-界面示例' : '-草稿'}.${format}`;
  a.click();
  URL.revokeObjectURL(url);
}
async function importScript(event: Event) {
  const input = event.target as HTMLInputElement,
    file = input.files?.[0];
  if (!file) return;
  const destination = draft.value;
  try {
    if (!settingsEditable.value || draft.value.scripts.length >= 100) return;
    if (file.size > 2 * 1024 * 1024) throw new Error('脚本文件不能超过 2 MB');
    const value: unknown = JSON.parse(await file.text());
    if (disposed || draft.value !== destination || !settingsEditable.value) return;
    const script = value && typeof value === 'object' && 'script' in value ? value.script : value;
    if (!isCustomizedStoryboardScript(script))
      throw new Error('文件结构不符合分镜脚本格式，请使用本节点导出的 JSON 文件');
    if (!(await guardEditor())) return;
    if (disposed || draft.value !== destination || !settingsEditable.value) return;
    const copy = importStoryboardScript(script);
    if (props.preview) {
      draft.value.scripts.push(copy);
      draft.value.activeScriptId = copy.id;
    } else emit('create', copy, 'IMPORT');
    importOpen.value = false;
  } catch (e) {
    notice.value = e instanceof Error ? e.message : '脚本读取失败';
  } finally {
    input.value = '';
  }
}
async function save() {
  if (await guardEditor()) emit('save');
}
async function cancel() {
  if (await guardEditor()) emit('cancel');
}
defineExpose({ guardEditor });
</script>
<template>
  <section class="storyboard-page" aria-label="分镜脚本工作台">
    <header class="storyboard-heading">
      <div class="heading-copy">
        <span class="node-index">03</span>
        <div>
          <h2>分镜脚本</h2>
          <p>探索完整叙事，逐镜打磨画面，每份脚本拥有独立制作路径</p>
        </div>
      </div>
      <div class="heading-actions extraction-heading__actions">
        <WorkflowNodeEditActions
          :editing="editing || preview"
          :temporary="true"
          :disabled="saving || (!editing && readonly && !preview)"
          :saving="saving"
          :save-disabled="preview || readonly"
          save-label="保存修改"
          saving-label="正在保存…"
          @begin="emit('begin')"
          @cancel="cancel"
          @save="save"
        /><WorkflowExtractionActions
          :label="running ? '正在 AI 创作' : draft.scripts.length ? '再次 AI 创作' : 'AI 创作脚本'"
          :reextract="draft.scripts.length > 0"
          :running="running"
          :disabled="!settingsEditable || preview || editing"
          @extract="emit('generate')"
          @details="graphOpen = true"
        />
      </div>
    </header>
    <WorkflowExtractionFeedback
      v-if="error"
      title="草稿保存未完成"
      :message="error"
      action="重新加载"
      @action="emit('reload')"
    />
    <div v-if="preview" class="preview-notice" role="status">
      <BookOpen :size="16" />
      <div>
        <strong>界面示例</strong
        ><span>虚构青梅酱脚本，仅用于体验方案选择、分镜编辑与对比，不写入项目。</span>
      </div>
      <button type="button" @click="emit('exitPreview')"><X :size="14" />退出示例</button>
    </div>
    <WorkflowEditingBanner
      v-else-if="editing"
      node-label="分镜脚本"
      description="修改会自动保存为独立草稿；保存修改更新当前脚本版本，取消恢复原脚本。"
    />
    <WorkflowExtractionFeedback
      v-if="stale && !preview"
      tone="warning"
      title="信息卡已有变化"
      message="当前脚本草稿基于较早的信息卡，请核对产品事实和品牌约束。旧内容会保留，不会自动重写。"
    />
    <WorkflowRunProgress
      v-if="progress"
      :progress="progress.value"
      :summary="progress.summary"
      :terminal="progress.terminal"
      action-label="查看工作流"
      @show-details="graphOpen = true"
    />
    <div v-if="task && !preview" class="toolbar-actions task-actions">
      <button v-if="running" type="button" @click="emit('stop')">取消本次创作</button
      ><button
        v-else-if="['FAILED', 'PARTIAL', 'CANCELLED'].includes(task.status)"
        type="button"
        @click="emit('retry')"
      >
        恢复未完成方案
      </button>
    </div>
    <WorkflowInformationCard class="creation-settings"
      ><div class="settings-head">
        <span class="section-symbol"><ListOrdered :size="17" /></span>
        <div>
          <h3>创作设置</h3>
          <p>{{ productName || '当前产品' }} · 各方案共用产品信息与品牌约束</p>
        </div>
        <button
          type="button"
          class="text-button"
          :aria-expanded="settingsExpanded"
          @click="settingsExpanded = !settingsExpanded"
        >
          {{ settingsExpanded ? '收起设置' : '更多设置'
          }}<ChevronDown :size="14" :class="{ rotated: settingsExpanded }" />
        </button>
      </div>
      <div class="settings-grid">
        <label
          >目标时长<span class="input-unit"
            ><input
              v-model.number="draft.settings.targetDurationSeconds"
              type="number"
              min="15"
              max="180"
              :disabled="!settingsEditable"
              aria-label="目标时长"
            /><span>秒</span></span
          ></label
        ><label
          >方案数量<select
            v-model.number="draft.settings.variantCount"
            :disabled="!settingsEditable"
            aria-label="方案数量"
          >
            <option v-for="n in 5" :key="n" :value="n">{{ n }} 套方案</option>
          </select></label
        >
        <div class="settings-context">
          <span>创作依据</span>
          <p>
            {{ productName || '视频创作信息卡' }} ·
            {{ sourceRevision ? `版本 ${sourceRevision}` : '尚未确认' }}
          </p>
          <button type="button" :disabled="!brief" @click="briefOpen = true">查看创作依据</button>
          <small>不提前锁定各方案的故事方向</small>
        </div>
      </div>
      <div
        v-if="settingsExpanded || draft.settings.structureMode !== 'AI'"
        class="advanced-settings"
      >
        <label
          >叙事结构<select
            v-model="draft.settings.structureMode"
            :disabled="!settingsEditable"
            aria-label="叙事结构"
          >
            <option value="AI">AI 设计</option>
            <option value="REFERENCE">参考结构</option>
            <option value="CUSTOM">自定义结构</option>
          </select></label
        >
        <label v-if="draft.settings.structureMode === 'REFERENCE'"
          >参考结构<select v-model="draft.settings.structure" :disabled="!settingsEditable">
            <option value="">选择参考结构</option>
            <option>产品细节 → 使用情境 → 价值呈现 → 品牌收束</option>
            <option>人物困境 → 产品介入 → 状态变化 → 情绪收束</option>
            <option>悬念开场 → 逐步揭示 → 产品亮相 → 主题回扣</option>
          </select></label
        ><WorkflowInformationField
          v-if="draft.settings.structureMode === 'CUSTOM'"
          v-model="draft.settings.structure"
          label="自定义叙事结构"
          :readonly="!settingsEditable"
          placeholder="例如：归家 → 准备晚餐 → 一勺点睛 → 落座享用"
        /><WorkflowInformationField
          v-model="draft.settings.instructions"
          label="创作要求（选填）"
          :readonly="!settingsEditable"
          multiline
          placeholder="例如：人物动作自然克制，三个方案分别探索不同的叙事切入，不使用夸张表演。"
        /></div
    ></WorkflowInformationCard>
    <div class="scripts-toolbar">
      <div class="section-title">
        <Layers3 :size="18" />
        <h3>脚本方案</h3>
        <span>{{ draft.scripts.length }} 套</span>
      </div>
      <div class="toolbar-actions">
        <button type="button" :disabled="!settingsEditable" @click="importOpen = true">
          <Upload :size="14" />导入脚本</button
        ><button type="button" :disabled="!settingsEditable" @click="addScript">
          <Plus :size="14" />自定义脚本</button
        ><button type="button" :disabled="draft.scripts.length < 2" @click="openCompare">
          <GitCompareArrows :size="14" />方案对比
        </button>
      </div>
    </div>
    <div v-if="draft.scripts.length" class="script-options" role="group" aria-label="脚本方案">
      <button
        v-for="(s, i) in draft.scripts"
        :key="s.id"
        type="button"
        class="script-option"
        :class="{ selected: s.id === draft.activeScriptId }"
        :aria-pressed="s.id === draft.activeScriptId"
        @click="selectScript(s.id)"
      >
        <div class="option-top">
          <span class="option-index">方案 {{ String(i + 1).padStart(2, '0') }}</span
          ><Check v-if="s.id === draft.activeScriptId" :size="15" />
        </div>
        <h4>{{ s.name }}</h4>
        <p>{{ s.synopsis || '尚未填写故事概述' }}</p>
        <div class="option-bottom">
          <span>{{ s.shots.length }} 镜</span><i /> <span>{{ scriptDuration(s) }} 秒</span
          ><span class="option-open"
            >{{ s.id === draft.activeScriptId ? '当前查看' : '查看脚本' }}<ArrowRight :size="12"
          /></span>
        </div>
      </button>
    </div>
    <section v-else class="empty-storyboard">
      <div class="empty-icon"><Clapperboard :size="30" /></div>
      <h3>从一个完整的故事开始</h3>
      <p>围绕产品与品牌信息，探索不同叙事，再把每一镜打磨清楚。</p>
      <div class="empty-steps">
        <span><b>01</b>比较脚本方案</span><i /><span><b>02</b>逐镜调整内容</span><i /><span
          ><b>03</b>进入独立制作</span
        >
      </div>
      <div class="empty-actions">
        <button
          type="button"
          class="primary-button"
          :disabled="!settingsEditable"
          @click="addScript"
        >
          <Plus :size="15" />创建空白脚本</button
        ><button type="button" @click="emit('preview')"><BookOpen :size="15" />查看界面示例</button>
      </div>
      <small>{{
        sourceReady
          ? '设置时长与数量后开始 AI 创作，也可以创建空白脚本。'
          : '请先保存信息提炼版本；也可查看独立界面示例。'
      }}</small>
    </section>
    <template v-if="active"
      ><WorkflowInformationCard class="script-overview"
        ><div class="overview-heading">
          <div>
            <span class="eyebrow">当前脚本</span>
            <h3>{{ active.name }}</h3>
          </div>
          <div class="overview-actions">
            <button
              v-if="canDiscard && !active.shots.length"
              type="button"
              :disabled="!editable"
              @click="emit('discard')"
            >
              删除空白脚本
            </button>
            <button
              type="button"
              :disabled="!editable"
              @click="scriptEditor = snapshotStoryboard(active)"
            >
              <Pencil :size="13" />编辑概述
            </button>
            <details class="export-menu">
              <summary><Download :size="13" />导出当前版本</summary>
              <div>
                <button type="button" @click="download('txt')">文字脚本 · TXT</button
                ><button type="button" @click="download('json')">可编辑脚本 · JSON</button>
              </div>
            </details>
          </div>
        </div>
        <p class="synopsis">{{ active.synopsis || '补充故事概述，让方案的表达重点更清晰。' }}</p>
        <div class="overview-grid">
          <div>
            <span>叙事结构</span>
            <p>{{ active.structure || '尚未填写' }}</p>
          </div>
          <div>
            <span>产品呈现重点</span>
            <p>{{ active.productFocus || '尚未填写' }}</p>
          </div>
        </div></WorkflowInformationCard
      >
      <div class="shots-toolbar">
        <div class="section-title">
          <Clapperboard :size="18" />
          <h3>逐镜脚本</h3>
          <span>{{ active.shots.length }} 镜</span>
        </div>
        <div class="duration-summary" :class="{ warning: durationMismatch }">
          <Clock3 :size="14" /><strong>{{ duration }} 秒</strong
          ><span>/ 目标 {{ draft.settings.targetDurationSeconds }} 秒</span>
        </div>
        <button type="button" :disabled="!editable" @click="addShot">
          <Plus :size="14" />添加镜头
        </button>
      </div>
      <div class="shot-list">
        <StoryboardShotCard
          v-for="(shot, index) in active.shots"
          :key="`${active.id}:${shot.id}`"
          ref="shotCards"
          :shot="shot"
          :index="index"
          :total="active.shots.length"
          :editable="editable"
          :assets="active.assets ?? []"
          :shots="active.shots"
          @edit="editShot(shot.id)"
          @update="updateShot"
          @remove="removeShot(shot.id)"
          @move="move(shot.id, $event)"
          @drag-start="dragId = $event"
          @drop="drop"
          @regenerate="notice = '单镜头 AI 创作尚未接通，当前可进入编辑手工调整。'"
        /><button
          v-if="!active.shots.length"
          class="add-first-shot"
          type="button"
          :disabled="!editable"
          @click="addShot"
        >
          <Plus :size="22" /><strong>添加第一个镜头</strong
          ><span>从空白开始，填写画面、对白和镜头时长</span>
        </button>
      </div></template
    >
    <p v-if="notice" class="notice" role="status">
      {{ notice
      }}<button type="button" aria-label="关闭提示" @click="notice = ''"><X :size="13" /></button>
    </p>
    <div class="draft-footnote">
      <span>{{ preview ? '示例内容不会保存到项目' : saveMessage }}</span
      ><span v-if="!preview">每份脚本独立保存与制作</span>
    </div>
    <WorkflowNodeFooter
      back-label="上一步：信息提炼"
      next-label="下一步：Prompt"
      :show-validate="false"
      :next-disabled="!nextReady || editing || preview"
      @next="emit('next')"
      @back="emit('back')"
    />
    <WorkflowInformationDialog
      :open="!!scriptEditor"
      title="编辑脚本概述"
      description="概述用于比较方案，不会替代逐镜画面内容。"
      @close="scriptEditor = null"
      ><div v-if="scriptEditor" class="dialog-form">
        <WorkflowInformationField
          v-model="scriptEditor.name"
          label="脚本名称"
        /><WorkflowInformationField
          v-model="scriptEditor.synopsis"
          label="故事概述"
          multiline
        /><WorkflowInformationField
          v-model="scriptEditor.structure"
          label="叙事结构"
        /><WorkflowInformationField
          v-model="scriptEditor.productFocus"
          label="产品呈现重点"
          multiline
        />
        <div class="dialog-actions">
          <button type="button" @click="scriptEditor = null">取消</button
          ><button
            class="primary-button"
            type="button"
            :disabled="!scriptEditor.name.trim()"
            @click="saveScriptMeta"
          >
            保存概述
          </button>
        </div>
      </div></WorkflowInformationDialog
    >
    <WorkflowInformationDialog
      :open="compareOpen"
      title="脚本方案对比"
      description="比较故事与产品表达，再阅读各自的镜头顺序；不同方案不强制逐镜对应。"
      @close="compareOpen = false"
      ><div class="compare-grid">
        <section v-for="(s, side) in [left, right]" :key="side" class="compare-column">
          <select
            :value="side === 0 ? compareLeft : compareRight"
            :aria-label="side === 0 ? '左侧脚本方案' : '右侧脚本方案'"
            @change="
              side === 0
                ? (compareLeft = ($event.target as HTMLSelectElement).value)
                : (compareRight = ($event.target as HTMLSelectElement).value)
            "
          >
            <option v-for="v in draft.scripts" :key="v.id" :value="v.id">
              {{ v.name }}
            </option></select
          ><template v-if="s"
            ><div class="compare-summary">
              <span>{{ s.shots.length }} 镜 · {{ scriptDuration(s) }} 秒</span>
              <h3>{{ s.name }}</h3>
              <p>{{ s.synopsis || '未填写故事概述' }}</p>
              <h4>叙事结构</h4>
              <p>{{ s.structure || '未填写' }}</p>
              <h4>产品呈现重点</h4>
              <p>{{ s.productFocus || '未填写' }}</p>
            </div>
            <article v-for="(shot, i) in s.shots" :key="shot.id" class="compare-shot">
              <header>
                <strong
                  >{{ String(i + 1).padStart(2, '0') }} · {{ shot.title || '未命名镜头' }}</strong
                ><span>{{ shot.durationSeconds }} 秒</span>
              </header>
              <small>{{ shot.shotType }} · {{ shot.cameraMovement }}</small>
              <p>{{ shot.visual || '未填写画面内容' }}</p>
              <div v-for="d in shot.dialogues" :key="d.id" class="compare-dialogue">
                {{ d.speaker }}：{{ d.text }}
              </div>
              <footer>{{ shot.audio || '无音效提示' }}</footer>
              <StoryboardAssetRequirements
                :requirements="shot.assetRequirements"
                :assets="s.assets ?? []"
                :shots="s.shots"
                :shot-id="shot.id"
                compact
              /></article
          ></template>
        </section></div
    ></WorkflowInformationDialog>
    <WorkflowInformationDialog
      :open="importOpen"
      title="导入分镜脚本"
      description="支持本节点导出的 JSON 脚本文件，导入后生成独立草稿，不覆盖已有方案。"
      @close="importOpen = false"
      ><label class="import-file"
        ><Upload :size="24" /><strong>选择脚本文件</strong><span>JSON · 最大 2 MB</span
        ><input type="file" accept=".json,application/json" @change="importScript"
      /></label>
      <p class="muted">导入将创建独立方案，保留原有方案及其版本。</p></WorkflowInformationDialog
    >
    <StoryboardExecutionDialog
      :open="graphOpen"
      :project-id="projectId"
      :task="task"
      :script-id="draft.activeScriptId"
      :scripts="draft.scripts"
      @close="graphOpen = false"
      @open-script="
        graphOpen = false;
        selectScript($event);
      "
    />
    <WorkflowInformationDialog
      :open="briefOpen"
      title="视频创作信息卡"
      :description="`本次创作依据 · 版本 ${sourceRevision ?? '未确认'}`"
      @close="briefOpen = false"
      ><div v-if="brief" class="dialog-form">
        <WorkflowInformationField
          v-for="(label, key) in CUSTOMIZED_BRIEF_LABELS"
          :key="key"
          :label="label"
          :model-value="
            Array.isArray(brief[key]) ? (brief[key] as string[]).join('\n') : String(brief[key])
          "
          readonly
          multiline
        /></div
    ></WorkflowInformationDialog>
  </section>
</template>
<style scoped src="./storyboard.css"></style>
<style scoped src="../../../platform/workflow/components/workflow-extraction-heading.css"></style>
