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
  BookOpen,
  Clapperboard,
  Trash2,
  ArrowUp,
  ArrowDown,
} from '@lucide/vue';
import type {
  CustomizedStoryboardDraft,
  CustomizedStoryboardScript,
  StoryboardTask,
  CustomizedBrief,
} from '@ai-marketing/contracts';
import {
  CUSTOMIZED_BRIEF_LABELS,
  CUSTOMIZED_VIDEO_TYPE_LABELS,
  CUSTOMIZED_VIDEO_TYPES,
  CUSTOMIZED_SCRIPT_STRUCTURES,
  isCustomizedStoryboardScript,
} from '@ai-marketing/contracts';
import { WorkflowNodeFooter, WorkflowRunProgress } from '@ai-marketing/ui';
import WorkflowNodeEditActions from '../../../platform/workflow/components/WorkflowNodeEditActions.vue';
import WorkflowEditingBanner from '../../../platform/workflow/components/WorkflowEditingBanner.vue';
import WorkflowExtractionActions from '../../../platform/workflow/components/WorkflowExtractionActions.vue';
import StoryboardExecutionDialog from './StoryboardExecutionDialog.vue';
import StoryboardSchemeDirectory from './StoryboardSchemeDirectory.vue';
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
  storyboardStructure,
  setStoryboardStructure,
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
const videoType = computed({
  get: () => draft.value.settings.videoType ?? 'DRAMA',
  set: (value) => {
    draft.value.settings.videoType = value;
    draft.value.settings.instructions = '';
  },
});
const structureSections = computed(() => storyboardStructure(draft.value.settings));
const structurePresets = computed(() => CUSTOMIZED_SCRIPT_STRUCTURES[videoType.value]);
const structurePresetValue = computed(() => {
  if (!structureSections.value.length) return '';
  const index = structurePresets.value.findIndex(
    (preset) =>
      preset.length === structureSections.value.length &&
      preset.every((section, i) => section === structureSections.value[i]),
  );
  return index < 0 ? 'custom' : String(index);
});
function chooseStructure(event: Event) {
  const value = (event.target as HTMLSelectElement).value;
  if (value === 'custom') return;
  setStoryboardStructure(
    draft.value.settings,
    value === '' ? [] : structurePresets.value[Number(value)]!,
  );
}
function editSection(index: number, event: Event) {
  const sections = [...structureSections.value];
  sections[index] = (event.target as HTMLInputElement).value;
  setStoryboardStructure(draft.value.settings, sections);
}
function moveSection(index: number, delta: number) {
  const sections = [...structureSections.value];
  [sections[index], sections[index + delta]] = [sections[index + delta]!, sections[index]!];
  setStoryboardStructure(draft.value.settings, sections);
}
function removeSection(index: number) {
  setStoryboardStructure(
    draft.value.settings,
    structureSections.value.filter((_, i) => i !== index),
  );
}
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
    if (target.story && scriptEditor.value.story) {
      target.story.opening = scriptEditor.value.story.opening;
      target.story.development = scriptEditor.value.story.development;
      target.story.ending = scriptEditor.value.story.ending;
      target.story.dialoguePlan = scriptEditor.value.story.dialoguePlan;
    }
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
          <p>围绕产品创作完整脚本，比较不同创意与表达</p>
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
    <WorkflowExtractionFeedback
      v-if="!running && task?.errorMessage && !error"
      title="本次创作未完成"
      :message="task.errorMessage"
    />
    <div
      v-if="task && ['FAILED', 'PARTIAL', 'CANCELLED'].includes(task.status)"
      class="toolbar-actions task-actions"
    >
      <button type="button" @click="emit('retry')">恢复未完成方案</button>
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
            {{ settingsExpanded ? '收起设置' : '高级设置'
            }}<ChevronDown :size="14" :class="{ rotated: settingsExpanded }" />
          </button>
        </div>
      </div>
      <div class="settings-grid">
        <label
          >视频类型<select v-model="videoType" :disabled="!settingsEditable" aria-label="视频类型">
            <option v-for="type in CUSTOMIZED_VIDEO_TYPES" :key="type" :value="type">
              {{ CUSTOMIZED_VIDEO_TYPE_LABELS[type] }}
            </option>
          </select></label
        >
        <label
          >参考时长<span class="input-unit"
            ><input
              v-model.number="draft.settings.targetDurationSeconds"
              type="number"
              min="15"
              max="180"
              :disabled="!settingsEditable"
              aria-label="参考时长"
            /><span>秒</span></span
          ></label
        >
      </div>
      <div v-if="settingsExpanded" class="advanced-settings structure-editor">
        <label
          >脚本结构<select
            :disabled="!settingsEditable"
            :value="structurePresetValue"
            aria-label="脚本结构"
            @change="chooseStructure"
          >
            <option value="">系统编排</option>
            <option
              v-for="(sections, index) in structurePresets"
              :key="index"
              :value="String(index)"
            >
              {{ sections.join(' → ') }}
            </option>
            <option v-if="structureSections.length" value="custom">自定义结构</option>
          </select></label
        >
        <p class="structure-hint">
          默认由系统安排内容。指定结构后，各方案按要求推进，正文篇章和场景自然展开。
        </p>
        <div v-for="(section, index) in structureSections" :key="index" class="structure-row">
          <span class="structure-number">{{ String(index + 1).padStart(2, '0') }}</span>
          <input
            :value="section"
            :disabled="!settingsEditable"
            maxlength="200"
            :aria-label="`第 ${index + 1} 段名称`"
            placeholder="段落名称"
            @input="editSection(index, $event)"
          />
          <button
            type="button"
            :disabled="!settingsEditable || index === 0"
            :aria-label="`上移第 ${index + 1} 段`"
            @click="moveSection(index, -1)"
          >
            <ArrowUp :size="16" />
          </button>
          <button
            type="button"
            :disabled="!settingsEditable || index === structureSections.length - 1"
            :aria-label="`下移第 ${index + 1} 段`"
            @click="moveSection(index, 1)"
          >
            <ArrowDown :size="16" />
          </button>
          <button
            type="button"
            :disabled="!settingsEditable"
            :aria-label="`删除第 ${index + 1} 段`"
            @click="removeSection(index)"
          >
            <X :size="16" />
          </button>
        </div>
        <button
          type="button"
          class="structure-add"
          :disabled="!settingsEditable || structureSections.length >= 20"
          @click="setStoryboardStructure(draft.settings, [...structureSections, '新段落'])"
        >
          <Plus :size="16" />添加段落
        </button>
      </div>
      <p v-else-if="structureSections.length" class="structure-summary">
        已启用自定义结构：{{ structureSections.join(' → ') }}
      </p>
    </WorkflowInformationCard>
    <WorkflowRunProgress
      v-if="progress && !progress.terminal"
      :progress="progress.value"
      :summary="progress.summary"
      :terminal="progress.terminal"
      action-label="查看工作流"
      @show-details="graphOpen = true"
    />
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
    <StoryboardSchemeDirectory
      :key="projectId"
      :scripts="draft.scripts"
      :active-id="draft.activeScriptId"
      @select="selectScript"
    />
    <section v-if="!draft.scripts.length" class="empty-storyboard">
      <div class="empty-icon"><Clapperboard :size="30" /></div>
      <h3>{{ running ? '正在创作完整脚本' : '还没有完整脚本' }}</h3>
      <p>
        {{
          !sourceReady
            ? '请先保存信息提炼版本，再开始创作。'
            : running
              ? '完成的方案会逐份显示，无需等待全部结束。'
              : '选择视频类型与参考时长后开始 AI 创作，也可以新建或导入脚本。'
        }}
      </p>
    </section>
    <WorkflowInformationCard v-if="active" :key="active.id" class="script-reader">
      <div class="overview-heading">
        <div>
          <span class="eyebrow"
            >{{
              active.creation
                ? CUSTOMIZED_VIDEO_TYPE_LABELS[active.creation.videoType]
                : active.story
                  ? '完整脚本'
                  : '历史脚本'
            }}
            · 预计 {{ scriptDuration(active) }} 秒
            <template v-if="active.creation">
              · 参考 {{ active.creation.referenceDurationSeconds }} 秒</template
            >
            <template v-if="active.story?.content">
              · {{ active.story.content.length }} 字</template
            ></span
          >
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
          <button type="button" @click="scriptEditor = snapshotStoryboard(active)">
            <BookOpen :size="13" />创作说明
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
      <section class="story-content" aria-label="完整脚本">
        <WorkflowInformationField
          v-if="active.story && editable"
          v-model="active.story.content"
          class="story-editor"
          label="完整脚本"
          multiline
        />
        <p v-else class="story-prose">
          {{ active.story?.content || '此方案尚未保存完整剧本正文。' }}
        </p>
        <p v-if="!active.story" class="muted">
          概述可在创作说明中查看；已有镜头和资产仍可继续使用。再次 AI 创作将生成新的完整剧本。
        </p>
      </section>
    </WorkflowInformationCard>
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
      :title="editable ? '编辑创作说明' : '创作说明'"
      :description="
        editable
          ? '概述用于比较方案，脚本正文在页面中直接编辑。'
          : '查看本方案的结构安排与产品表达。'
      "
      @close="scriptEditor = null"
      ><div v-if="scriptEditor && editable" class="dialog-form">
        <WorkflowInformationField
          v-model="scriptEditor.name"
          label="脚本名称"
        /><WorkflowInformationField
          v-model="scriptEditor.synopsis"
          label="方案概述"
          multiline
        /><WorkflowInformationField
          v-model="scriptEditor.structure"
          label="脚本结构"
        /><WorkflowInformationField
          v-model="scriptEditor.productFocus"
          label="产品呈现重点"
          multiline
        />
        <template v-if="scriptEditor.story">
          <WorkflowInformationField v-model="scriptEditor.story.opening" label="开场" multiline />
          <WorkflowInformationField
            v-model="scriptEditor.story.development"
            label="发展"
            multiline
          />
          <WorkflowInformationField v-model="scriptEditor.story.ending" label="收束" multiline />
          <WorkflowInformationField
            v-model="scriptEditor.story.dialoguePlan"
            label="对白安排"
            multiline
          />
        </template>
        <div class="dialog-actions">
          <button type="button" @click="scriptEditor = null">取消</button
          ><button
            class="primary-button"
            type="button"
            :disabled="!scriptEditor.name.trim()"
            @click="saveScriptMeta"
          >
            应用修改
          </button>
        </div>
      </div>
      <div v-else-if="scriptEditor" class="script-notes">
        <section
          v-for="item in [
            { label: '方案概述', content: scriptEditor.synopsis },
            { label: '脚本结构', content: scriptEditor.structure },
            { label: '产品呈现重点', content: scriptEditor.productFocus },
            ...(scriptEditor.story
              ? [
                  { label: '开场', content: scriptEditor.story.opening },
                  { label: '发展', content: scriptEditor.story.development },
                  { label: '收束', content: scriptEditor.story.ending },
                  { label: '对白安排', content: scriptEditor.story.dialoguePlan },
                ]
              : []),
          ]"
          :key="item.label"
        >
          <h3>{{ item.label }}</h3>
          <p>{{ item.content || '尚未填写' }}</p>
        </section>
      </div></WorkflowInformationDialog
    >
    <WorkflowInformationDialog
      :open="compareOpen"
      title="脚本方案对比"
      description="比较完整脚本、创意表达和产品呈现，选择适合继续制作的方案。"
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
              <span>{{ s.story ? '完整脚本' : '历史脚本' }} · {{ scriptDuration(s) }} 秒</span>
              <h3>{{ s.name }}</h3>
              <p>{{ s.synopsis || '未填写方案概述' }}</p>
              <h4>脚本结构</h4>
              <p>{{ s.structure || '未填写' }}</p>
              <h4>产品呈现重点</h4>
              <p>{{ s.productFocus || '未填写' }}</p>
              <h4>脚本正文</h4>
              <p style="white-space: pre-wrap">
                {{ s.story?.content || '此方案尚未保存完整剧本正文。' }}
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
