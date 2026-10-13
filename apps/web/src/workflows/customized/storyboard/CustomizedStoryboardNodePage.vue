<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import {
  ChevronDown,
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
  Trash2,
} from '@lucide/vue';
import type {
  CustomizedStoryboardDraft,
  CustomizedStoryboardScript,
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
import {
  createStoryboardScript,
  scriptDuration,
  snapshotStoryboard,
  storyboardText,
  importStoryboardScript,
} from './storyboard-state';
const props = defineProps<{
  editing: boolean;
  sourceReady: boolean;
  readonly: boolean;
  saving: boolean;
  productName: string;
  saveMessage: string;
  error: string;
  stale: boolean;
  projectId: string;
  task: StoryboardTask | null;
  brief: CustomizedBrief | null;
  sourceRevision: number | null;
  nextReady: boolean;
  canDelete?: boolean;
  deleting?: boolean;
  progress?: { value: number; summary: string; terminal: boolean } | undefined;
}>();
const draft = defineModel<CustomizedStoryboardDraft>('draft', { required: true });
const emit = defineEmits<{
  back: [];
  begin: [];
  cancel: [];
  save: [];
  reload: [];
  generate: [];
  retry: [];
  stop: [];
  select: [id: string];
  create: [script: CustomizedStoryboardScript, origin: 'MANUAL' | 'IMPORT'];
  next: [];
  remove: [];
}>();
const settingsExpanded = ref(false),
  compareOpen = ref(false),
  graphOpen = ref(false),
  briefOpen = ref(false),
  scriptEditor = ref<CustomizedStoryboardScript | null>(null),
  importOpen = ref(false),
  notice = ref('');
const compareLeft = ref(''),
  compareRight = ref('');
let disposed = false;
onBeforeUnmount(() => {
  disposed = true;
});
const active = computed(
  () => draft.value.scripts.find((s) => s.id === draft.value.activeScriptId) ?? null,
);
const editable = computed(() => props.editing && !props.readonly);
const left = computed(() => draft.value.scripts.find((s) => s.id === compareLeft.value));
const right = computed(() => draft.value.scripts.find((s) => s.id === compareRight.value));
const running = computed(() => !!props.task && ['QUEUED', 'RUNNING'].includes(props.task.status));
const settingsEditable = computed(() => props.sourceReady && !props.readonly && !running.value);
async function guardEditor() {
  return true;
}
async function selectScript(id: string) {
  if (id !== draft.value.activeScriptId && (await guardEditor())) {
    emit('select', id);
  }
}
async function addScript() {
  if (!settingsEditable.value || draft.value.scripts.length >= 100 || !(await guardEditor()))
    return;
  const script = createStoryboardScript(`自定义脚本 ${draft.value.scripts.length + 1}`);
  if (script.story)
    script.story.beats[0]!.durationSeconds = draft.value.settings.targetDurationSeconds;
  emit('create', script, 'MANUAL');
}
function saveScriptMeta() {
  if (!editable.value || !scriptEditor.value?.name.trim()) return;
  const target = draft.value.scripts.find((s) => s.id === scriptEditor.value!.id);
  if (target) {
    target.name = scriptEditor.value.name.trim();
    target.synopsis = scriptEditor.value.synopsis;
    target.structure = scriptEditor.value.structure;
    target.productFocus = scriptEditor.value.productFocus;
  }
  scriptEditor.value = null;
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
  a.download = `${active.value.name.replace(/[\\/:*?"<>|]/g, '_') || '完整脚本'}${props.editing ? '-草稿' : ''}.${format}`;
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
      throw new Error('文件结构不符合完整脚本格式，请使用本节点导出的 JSON 文件');
    if (!(await guardEditor())) return;
    if (disposed || draft.value !== destination || !settingsEditable.value) return;
    const copy = importStoryboardScript(script);
    emit('create', copy, 'IMPORT');
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
  <section class="storyboard-page" aria-label="完整脚本工作台">
    <header class="storyboard-heading">
      <div class="heading-copy">
        <span class="node-index">03</span>
        <div>
          <h2>完整脚本</h2>
          <p>围绕产品创作完整故事，比较不同叙事与表达</p>
        </div>
      </div>
      <div class="heading-actions extraction-heading__actions">
        <WorkflowNodeEditActions
          v-if="active"
          :editing="editing"
          :temporary="true"
          :disabled="saving || (!editing && readonly)"
          :saving="saving"
          :save-disabled="readonly"
          save-label="保存修改"
          saving-label="正在保存…"
          @begin="emit('begin')"
          @cancel="cancel"
          @save="save"
        /><WorkflowExtractionActions
          :label="running ? '正在 AI 创作' : draft.scripts.length ? '再次 AI 创作' : 'AI 创作脚本'"
          :reextract="draft.scripts.length > 0"
          :running="running"
          :disabled="!settingsEditable || editing"
          @extract="emit('generate')"
          @details="graphOpen = true"
        />
      </div>
    </header>
    <WorkflowExtractionFeedback
      v-if="error"
      title="操作未完成"
      :message="error"
      action="重新加载"
      @action="emit('reload')"
    />
    <WorkflowEditingBanner
      v-if="editing"
      node-label="完整脚本"
      description="修改会自动保存为独立草稿；保存修改更新当前脚本版本，取消恢复原脚本。"
    />
    <WorkflowExtractionFeedback
      v-if="stale"
      tone="warning"
      title="信息卡已有变化"
      message="当前脚本草稿基于较早的信息卡，请核对产品事实和品牌约束。旧内容会保留，不会自动重写。"
    />
    <WorkflowRunProgress
      v-if="progress && !progress.terminal"
      :progress="progress.value"
      :summary="progress.summary"
      :terminal="progress.terminal"
      action-label="查看工作流"
      @show-details="graphOpen = true"
    />
    <WorkflowExtractionFeedback
      v-if="!running && task?.errorMessage && !error"
      title="本次创作未完成"
      :message="task.errorMessage"
    />
    <div v-if="task && task.status !== 'COMPLETED'" class="toolbar-actions task-actions">
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
          <p>
            {{ productName || '视频创作信息卡'
            }}{{ sourceRevision ? ` · 版本 ${sourceRevision}` : ' · 尚未确认' }}
          </p>
        </div>
        <div class="settings-actions">
          <button v-if="brief" type="button" @click="briefOpen = true">
            <BookOpen :size="14" />创作依据
          </button>
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
        ><button v-if="draft.scripts.length > 1" type="button" @click="openCompare">
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
          <span>完整故事</span><i /> <span>{{ scriptDuration(s) }} 秒</span>
        </div>
      </button>
    </div>
    <section v-else class="empty-storyboard">
      <div class="empty-icon"><Clapperboard :size="30" /></div>
      <h3>{{ running ? '正在创作完整脚本' : '还没有完整脚本' }}</h3>
      <p>
        {{
          !sourceReady
            ? '请先保存信息提炼版本，再开始创作。'
            : running
              ? '完成的方案会逐份显示，无需等待全部结束。'
              : '设置时长与数量后开始 AI 创作，也可以新建或导入脚本。'
        }}
      </p>
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
              v-if="canDelete"
              type="button"
              class="script-delete-button"
              :disabled="deleting || saving"
              @click="emit('remove')"
            >
              <Trash2 :size="14" />{{ deleting ? '正在删除…' : '删除脚本' }}
            </button>
            <button
              v-if="editable"
              type="button"
              @click="scriptEditor = snapshotStoryboard(active)"
            >
              <Pencil :size="13" />编辑故事概述
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
      <WorkflowInformationCard class="full-story-card">
        <h3>完整故事</h3>
        <WorkflowInformationField
          v-if="active.story"
          v-model="active.story.content"
          label="故事正文"
          multiline
          :readonly="!editable"
        />
        <p v-else class="synopsis">{{ active.synopsis }}</p>
        <div v-if="active.story" class="overview-grid">
          <WorkflowInformationField
            v-model="active.story.opening"
            label="开场"
            multiline
            :readonly="!editable"
          />
          <WorkflowInformationField
            v-model="active.story.development"
            label="发展"
            multiline
            :readonly="!editable"
          />
          <WorkflowInformationField
            v-model="active.story.ending"
            label="收束"
            multiline
            :readonly="!editable"
          />
          <WorkflowInformationField
            v-model="active.story.dialoguePlan"
            label="对白安排"
            multiline
            :readonly="!editable"
          />
        </div>
        <p v-if="!active.story" class="muted">
          旧版脚本的镜头和资产已保留，可在资产准备与视频制作中继续使用。
        </p>
      </WorkflowInformationCard></template
    >
    <p v-if="notice" class="notice" role="status">
      {{ notice
      }}<button type="button" aria-label="关闭提示" @click="notice = ''"><X :size="13" /></button>
    </p>
    <p v-if="saveMessage && active" class="draft-footnote" role="status">{{ saveMessage }}</p>
    <WorkflowNodeFooter
      back-label="上一步：信息提炼"
      next-label="下一步：资产准备"
      :show-validate="false"
      :next-disabled="!nextReady || editing"
      @next="emit('next')"
      @back="emit('back')"
    />
    <WorkflowInformationDialog
      :open="!!scriptEditor"
      title="编辑脚本概述"
      description="概述用于比较方案，故事正文在页面中直接编辑。"
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
      description="比较完整故事、叙事发展和产品表达，选择适合继续制作的方案。"
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
              <span>完整故事 · {{ scriptDuration(s) }} 秒</span>
              <h3>{{ s.name }}</h3>
              <p>{{ s.synopsis || '未填写故事概述' }}</p>
              <h4>叙事结构</h4>
              <p>{{ s.structure || '未填写' }}</p>
              <h4>产品呈现重点</h4>
              <p>{{ s.productFocus || '未填写' }}</p>
              <h4>故事正文</h4>
              <p style="white-space: pre-wrap">
                {{ s.story?.content || s.synopsis || '尚未填写' }}
              </p>
              <template v-if="s.story">
                <h4>开场</h4>
                <p>{{ s.story.opening }}</p>
                <h4>发展</h4>
                <p>{{ s.story.development }}</p>
                <h4>收束</h4>
                <p>{{ s.story.ending }}</p>
                <h4>对白安排</h4>
                <p>{{ s.story.dialoguePlan }}</p>
              </template>
            </div>
          </template>
        </section>
      </div></WorkflowInformationDialog
    >
    <WorkflowInformationDialog
      :open="importOpen"
      title="导入完整脚本"
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
