<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import {
  Boxes,
  Clapperboard,
  Plus,
  Trash2,
  ArrowUp,
  ArrowDown,
  Image,
  RefreshCw,
  Sparkles,
  Save,
} from '@lucide/vue';
import { WorkflowNodeFooter, WorkflowRunProgress } from '@ai-marketing/ui';
import {
  productionStages,
  type ProductionWorkspace,
  type ProductionDocument,
  type ProductionAsset,
  type ProductionOperation,
  type ProductionTask,
} from '@ai-marketing/contracts';
import WorkflowPageLoading from '../../../platform/workflow/components/WorkflowPageLoading.vue';
import WorkflowNodeEditActions from '../../../platform/workflow/components/WorkflowNodeEditActions.vue';
import WorkflowInformationCard from '../../../platform/workflow/components/WorkflowInformationCard.vue';
import WorkflowInformationField from '../../../platform/workflow/components/WorkflowInformationField.vue';
import WorkflowInformationDialog from '../../../platform/workflow/components/WorkflowInformationDialog.vue';
import WorkflowExtractionActions from '../../../platform/workflow/components/WorkflowExtractionActions.vue';
import WorkflowExtractionFeedback from '../../../platform/workflow/components/WorkflowExtractionFeedback.vue';
import WorkflowExecutionGraphDialog from '../../../platform/workflow/components/WorkflowExecutionGraphDialog.vue';
import { requestActionConfirmation } from '../../../shared/composables/action-confirmation';
import { isAbortError } from '../../../api/http-client';
import { productionApi } from './production.api';
import ProductionAssetStudio from './ProductionAssetStudio.vue';
import ProductionReferenceLibrary from './ProductionReferenceLibrary.vue';
import ProductionShotRenderPanel from './ProductionShotRenderPanel.vue';
import ProductionRenderDialog from './ProductionRenderDialog.vue';
import ProductionAssetPreparation from './ProductionAssetPreparation.vue';
const props = defineProps<{ projectId: string; workflowRunId: string; mode: 'ASSETS' | 'SHOTS' }>();
const emit = defineEmits<{ back: []; next: []; saved: [] }>();
const workspace = ref<ProductionWorkspace | null>(null),
  document = ref<ProductionDocument>({ assets: [], shots: [] });
const promptText = ref(''),
  promptBase = ref('');
const editing = ref(false);
const loading = ref(true),
  busy = ref(false),
  error = ref(''),
  notice = ref(''),
  kind = ref<ProductionAsset['kind']>('PRODUCT'),
  selectedShotId = ref(''),
  graphOpen = ref(false),
  graphNode = ref('SNAPSHOT'),
  graphTaskId = ref('');
const mergeSource = ref(''),
  mergeTarget = ref('');
const inspectAsset = ref<ProductionAsset | null>(null);
const imageAssets = ref<ProductionAsset[]>([]);
const imageDialogOpen = ref(false);
function prepareImage(asset: ProductionAsset) {
  inspectAsset.value = null;
  imageAssets.value = [asset];
  imageDialogOpen.value = true;
}
function updateAsset(asset: ProductionAsset) {
  if (busy.value || running.value) return;
  const current = document.value.assets.find((a) => a.id === asset.id);
  if (current) Object.assign(current, asset);
}
function createAsset(assetKind: ProductionAsset['kind']) {
  kind.value = assetKind;
  editing.value = true;
  addAsset();
}
const labels: Record<ProductionAsset['kind'], string> = {
  PRODUCT: '产品',
  CHARACTER: '人物',
  SCENE: '场景',
  PROP: '道具',
};
let controller = new AbortController(),
  poll: ReturnType<typeof setTimeout> | undefined,
  autosave: ReturnType<typeof setTimeout> | undefined,
  baseline = '',
  disposed = false;
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const dirty = computed(() => JSON.stringify(document.value) !== baseline);
const promptDirty = computed(() => promptText.value !== promptBase.value);
const tasks = computed(() => workspace.value?.tasks ?? []);
const running = computed(() => tasks.value.find((t) => ['RUNNING', 'QUEUED'].includes(t.status)));
const shownAssets = computed(() => document.value.assets.filter((a) => a.kind === kind.value));
const shot = computed(
  () => document.value.shots.find((s) => s.id === selectedShotId.value) ?? document.value.shots[0],
);
const prompt = computed(() =>
  workspace.value?.prompts.find((p) => p.value.shotId === shot.value?.id),
);
const graphTasks = computed(() =>
  tasks.value.filter((t) =>
    props.mode === 'ASSETS' ? t.operation === 'ASSETS' : t.operation !== 'ASSETS',
  ),
);
const graphTask = computed(
  () => graphTasks.value.find((t) => t.id === graphTaskId.value) ?? graphTasks.value[0],
);
const graphStages = computed(() =>
  productionStages(
    graphTask.value?.operation ?? props.mode,
    graphTask.value?.assetWorkflowVersion ?? (graphTask.value ? undefined : 2),
  ).filter((s) => !graphTask.value || graphTask.value.steps.some((step) => step.id === s.id)),
);
const graphRows = computed(() =>
  graphTask.value?.assetWorkflowVersion === 2 || (!graphTask.value && props.mode === 'ASSETS')
    ? [
        ['SNAPSHOT'],
        ['INVENTORY'],
        ['IDENTITY'],
        ['PRODUCT', 'CHARACTER', 'SCENE', 'PROP'],
        ['IMAGE_PLAN'],
        ['REVIEW'],
        ['REPAIR'],
        ['SAVE'],
      ]
    : graphStages.value.map((s) => [s.id]),
);
const graphNodes = computed(() =>
  graphStages.value.map((n) => {
    const step = graphTask.value?.steps.find((s) => s.id === n.id),
      status = step?.status ?? 'PENDING';
    return {
      ...n,
      tone:
        status === 'SUCCEEDED'
          ? 'success'
          : status === 'RUNNING'
            ? 'running'
            : status === 'FAILED'
              ? 'danger'
              : 'pending',
      statusLabel:
        status === 'SUCCEEDED'
          ? '已完成'
          : status === 'RUNNING'
            ? '执行中'
            : status === 'FAILED'
              ? '未完成'
              : '等待执行',
    };
  }),
);
const graphDetail = computed(() => graphTask.value?.steps.find((s) => s.id === graphNode.value));
watch(graphStages, (stages) => {
  if (!stages.some((s) => s.id === graphNode.value)) graphNode.value = stages[0]?.id ?? 'SNAPSHOT';
});
const boundAssets = computed(
  () =>
    shot.value?.bindings
      .map((b) => ({ binding: b, asset: document.value.assets.find((a) => a.id === b.assetId)! }))
      .filter((b) => b.asset) ?? [],
);
async function load() {
  clearTimeout(autosave);
  controller.abort();
  controller = new AbortController();
  const scope = controller;
  clearTimeout(poll);
  loading.value = true;
  error.value = '';
  try {
    const result = await productionApi.workspace(
      props.projectId,
      props.workflowRunId,
      scope.signal,
    );
    if (scope !== controller) return;
    workspace.value = result;
    document.value = clone(result.document);
    baseline = JSON.stringify(document.value);
    const section = props.mode === 'ASSETS' ? 'assets' : 'shots';
    editing.value =
      !(props.mode === 'ASSETS' ? result.assetsConfirmed : result.shotsConfirmed) ||
      JSON.stringify(result.document[section]) !==
        JSON.stringify(result.confirmedDocument[section]);
    if (!document.value.shots.some((s) => s.id === selectedShotId.value))
      selectedShotId.value = document.value.shots[0]?.id ?? '';
    schedule();
  } catch (e) {
    if (scope === controller && !isAbortError(e))
      error.value = e instanceof Error ? e.message : '工作区加载失败';
  } finally {
    if (scope === controller) {
      loading.value = false;
      busy.value = false;
    }
  }
}
function schedule() {
  clearTimeout(poll);
  if (!disposed && running.value) poll = setTimeout(() => void refreshTask(), 1800);
}
async function refreshTask() {
  const scope = controller,
    current = running.value;
  if (!current) return;
  try {
    const result = await productionApi.task(props.projectId, current.id, scope.signal);
    if (scope !== controller || !workspace.value) return;
    workspace.value.tasks = workspace.value.tasks.map((t) => (t.id === result.id ? result : t));
    if (['RUNNING', 'QUEUED'].includes(result.status)) schedule();
    else {
      // A prompt commits independently of the shot draft. Refresh the shared
      // canvas as soon as the task settles, including when local edits remain.
      emit('saved');
      if (!dirty.value && !promptDirty.value) await load();
      else notice.value = '任务已结束，保存当前修改后可重新加载结果';
    }
  } catch (e) {
    if (scope === controller && !isAbortError(e)) {
      error.value = '进度查询暂时中断，后台任务仍会继续';
      poll = setTimeout(() => void refreshTask(), 5000);
    }
  }
}
async function mergeAssets() {
  const source = document.value.assets.find((a) => a.id === mergeSource.value),
    target = document.value.assets.find((a) => a.id === mergeTarget.value);
  if (!source || !target || source.id === target.id) return;
  if (
    !(await requestActionConfirmation({
      title: `将“${source.name}”合并到“${target.name}”？`,
      description: '保留目标定义，替换当前草稿里的相关镜头绑定。保存前可取消编辑。',
      confirmLabel: '合并定义',
    }))
  )
    return;
  document.value.shots.forEach((s) => {
    const seen = new Set<string>();
    s.bindings = s.bindings
      .map((b) => ({ ...b, assetId: b.assetId === source.id ? target.id : b.assetId }))
      .filter((b) => {
        if (seen.has(b.assetId)) return false;
        seen.add(b.assetId);
        return true;
      });
  });
  document.value.assets = document.value.assets.filter((a) => a.id !== source.id);
  mergeSource.value = '';
  mergeTarget.value = '';
}
async function cancelEdit() {
  if (!workspace.value) return;
  if (
    !(await requestActionConfirmation({
      title: '取消本次编辑？',
      description: '恢复已确认内容，当前未确认修改会被丢弃。',
      confirmLabel: '取消编辑',
    }))
  )
    return;
  const section = props.mode === 'ASSETS' ? 'assets' : 'shots';
  document.value[section] = clone(workspace.value.confirmedDocument[section]) as never;
  if (props.mode === 'ASSETS') {
    // Restore affected references without discarding unrelated shot edits.
    const ids = new Set(document.value.assets.map((a) => a.id));
    document.value.shots.forEach((s) => {
      const original = workspace.value!.confirmedDocument.shots.find((v) => v.id === s.id);
      if (original) s.bindings = clone(original.bindings.filter((b) => ids.has(b.assetId)));
    });
  }
  if (await save(false)) {
    await load();
    editing.value = false;
    notice.value = '已取消编辑';
  }
}
async function save(confirm = true) {
  if (!workspace.value || busy.value || running.value) return false;
  busy.value = true;
  error.value = '';
  const scope = controller;
  try {
    const value = clone(document.value);
    const result = await productionApi.save(
      props.projectId,
      props.workflowRunId,
      workspace.value.draftRevision,
      value,
      props.mode,
      confirm,
      scope.signal,
    );
    if (scope !== controller) return false;
    workspace.value.draftRevision = result.revision;
    baseline = JSON.stringify(value);
    notice.value = confirm ? '修改已保存' : '草稿已保存';
    if (confirm) {
      await load();
      emit('saved');
    }
    return true;
  } catch (e) {
    if (scope === controller && !isAbortError(e))
      error.value = e instanceof Error ? e.message : '保存失败，本地修改已保留';
    return false;
  } finally {
    if (scope === controller) busy.value = false;
  }
}
async function generate(operation: ProductionOperation, shotId?: string, targetAssetId?: string) {
  if (!workspace.value || busy.value || running.value) return;
  if (promptDirty.value && !(await savePrompt())) return;
  if (dirty.value && !(await save())) return;
  if (
    (operation === 'ASSETS' && document.value.assets.length) ||
    (operation === 'SHOTS' && document.value.shots.length)
  ) {
    if (
      !(await requestActionConfirmation({
        title:
          operation === 'ASSETS'
            ? targetAssetId
              ? '重新整理选定资产？'
              : '重新整理资产目录？'
            : '重新生成分镜？',
        description: '新结果完成后保存为可编辑草稿，现有已确认内容保留到你再次保存。',
        confirmLabel: '开始生成',
      }))
    )
      return;
  }
  busy.value = true;
  error.value = '';
  const scope = controller;
  try {
    const t = await productionApi.start(
      props.projectId,
      props.workflowRunId,
      workspace.value.draftRevision,
      operation,
      shotId,
      scope.signal,
      targetAssetId,
    );
    if (scope !== controller) return;
    workspace.value.tasks = [t, ...workspace.value.tasks];
    graphTaskId.value = t.id;
    schedule();
  } catch (e) {
    if (scope === controller && !isAbortError(e))
      error.value = e instanceof Error ? e.message : '任务创建失败';
  } finally {
    if (scope === controller) busy.value = false;
  }
}
async function taskAction(t: ProductionTask, cancel: boolean) {
  try {
    await productionApi.action(props.projectId, t.id, cancel, controller.signal);
    await load();
  } catch (e) {
    if (!isAbortError(e)) error.value = e instanceof Error ? e.message : '操作未完成';
  }
}
function addAsset() {
  document.value.assets.push({
    id: crypto.randomUUID(),
    kind: kind.value,
    name: `新${labels[kind.value]}`,
    description: '',
    knownFacts: '',
    designNotes: '',
    sourceText: '',
    imageRequirements: '',
  });
}
async function removeAsset(id: string) {
  if (
    !(await requestActionConfirmation({
      title: '移除这个资产定义？',
      description: '本脚本中的相关镜头绑定也会移除，其他资产保持不变。',
      confirmLabel: '移除',
      tone: 'danger',
    }))
  )
    return;
  document.value.assets = document.value.assets.filter((a) => a.id !== id);
  document.value.shots.forEach((s) => (s.bindings = s.bindings.filter((b) => b.assetId !== id)));
}
function addShot() {
  const id = crypto.randomUUID();
  document.value.shots.push({
    id,
    title: '新镜头',
    shotType: '近景',
    cameraMovement: '固定镜头',
    durationSeconds: 5,
    visual: '',
    dialogue: '',
    audio: '',
    atmosphere: '',
    bindings: [],
  });
  selectedShotId.value = id;
}
async function removeShot() {
  if (!shot.value) return;
  if (
    !(await requestActionConfirmation({
      title: '删除当前镜头？',
      description: '其他镜头及已保存的结果将保留。',
      confirmLabel: '删除镜头',
      tone: 'danger',
    }))
  )
    return;
  document.value.shots = document.value.shots.filter((s) => s.id !== shot.value?.id);
  selectedShotId.value = document.value.shots[0]?.id ?? '';
}
function moveShot(offset: number) {
  if (!shot.value) return;
  const i = document.value.shots.indexOf(shot.value),
    j = i + offset;
  if (j < 0 || j >= document.value.shots.length) return;
  const [s] = document.value.shots.splice(i, 1);
  document.value.shots.splice(j, 0, s!);
}
function toggleBinding(a: ProductionAsset) {
  if (!shot.value) return;
  const i = shot.value.bindings.findIndex((b) => b.assetId === a.id);
  if (i < 0) shot.value.bindings.push({ assetId: a.id, description: '' });
  else shot.value.bindings.splice(i, 1);
}
async function savePrompt() {
  if (!shot.value || busy.value || running.value) return false;
  const content = promptText.value;
  const selectedId = shot.value.id;
  if (dirty.value && !(await save())) return false;
  busy.value = true;
  error.value = '';
  const scope = controller;
  try {
    await productionApi.prompt(
      props.projectId,
      props.workflowRunId,
      prompt.value?.revision ?? 0,
      {
        shotId: selectedId,
        content,
        assetIds: shot.value.bindings.map((b) => b.assetId),
      },
      scope.signal,
    );
    if (scope !== controller) return false;
    promptBase.value = promptText.value;
    await load();
    emit('saved');
    return true;
  } catch (e) {
    if (scope === controller && shot.value?.id === selectedId) promptText.value = content;
    if (!isAbortError(e))
      error.value = e instanceof Error ? e.message : '提示词保存失败，本地文字已保留';
    return false;
  } finally {
    if (scope === controller) busy.value = false;
  }
}
async function selectShot(id: string) {
  if (promptDirty.value && !(await savePrompt())) return;
  selectedShotId.value = id;
}
async function flushPendingEdits() {
  if (promptDirty.value && !(await savePrompt())) return false;
  return !dirty.value || (await save(false));
}
watch(
  () => [shot.value?.id, prompt.value?.revision],
  () => {
    promptText.value = prompt.value?.value.content ?? '';
    promptBase.value = promptText.value;
  },
);
function beforeUnload(e: BeforeUnloadEvent) {
  if (dirty.value || promptDirty.value) {
    e.preventDefault();
    e.returnValue = '';
  }
}
window.addEventListener('beforeunload', beforeUnload);
watch(
  document,
  () => {
    clearTimeout(autosave);
    if (loading.value || !editing.value || running.value || !dirty.value || error.value) return;
    autosave = setTimeout(() => {
      if (!disposed && !busy.value) void save(false);
    }, 900);
  },
  { deep: true },
);
watch(
  () => [props.projectId, props.workflowRunId, props.mode],
  () => void load(),
  { immediate: true },
);
onBeforeUnmount(() => {
  disposed = true;
  controller.abort();
  clearTimeout(poll);
  clearTimeout(autosave);
  window.removeEventListener('beforeunload', beforeUnload);
});
defineExpose({ flushPendingEdits });
</script>
<template>
  <WorkflowPageLoading
    v-if="loading"
    :title="mode === 'ASSETS' ? '正在加载资产准备…' : '正在加载视频制作…'"
    description="读取当前脚本与制作内容"
    icon="extraction"
  />
  <section v-else class="production-page">
    <header class="production-heading">
      <div>
        <span class="eyebrow">{{ mode === 'ASSETS' ? '04 / 资产准备' : '05 / 视频制作' }}</span>
        <h2>{{ mode === 'ASSETS' ? '资产准备' : '视频制作' }}</h2>
        <p>
          {{ workspace?.script.name || '请先选定完整脚本' }} ·
          {{
            mode === 'ASSETS'
              ? '统一产品、人物与空间定义，图片可以稍后准备'
              : '分镜、资产绑定与镜头提示词'
          }}
        </p>
      </div>
      <div class="actions extraction-heading__actions">
        <WorkflowNodeEditActions
          :editing="editing"
          :temporary="true"
          :disabled="busy || !!running || !workspace"
          :saving="busy"
          save-label="保存修改"
          @begin="editing = true"
          @cancel="cancelEdit"
          @save="save()"
        /><WorkflowExtractionActions
          :disabled="
            busy ||
            !!running ||
            !workspace?.sourceReady ||
            (mode === 'SHOTS' && !workspace?.assetsConfirmed)
          "
          :running="!!running"
          :reextract="mode === 'ASSETS' ? !!document.assets.length : !!document.shots.length"
          :label="mode === 'ASSETS' ? 'AI 整理资产' : 'AI 生成分镜'"
          @extract="generate(mode)"
          @details="graphOpen = true"
        />
      </div>
    </header>
    <WorkflowExtractionFeedback
      v-if="error"
      title="操作未完成"
      :message="error"
      action="重新加载"
      @action="load"
    />
    <WorkflowExtractionFeedback
      v-if="workspace && !workspace.sourceReady"
      tone="warning"
      title="创作依据已变化"
      message="请返回脚本创作确认当前故事，再继续制作。"
    />
    <WorkflowRunProgress
      v-if="running"
      :progress="running.progress"
      :summary="
        running.operation === 'ASSETS'
          ? '正在整理资产定义'
          : running.operation === 'SHOTS'
            ? '正在创作连续分镜'
            : '正在生成当前镜头提示词'
      "
      :terminal="false"
      action-label="查看工作流"
      @show-details="
        graphTaskId = running.id;
        graphOpen = true;
      "
    />
    <div v-if="running" class="task-note">
      <span>你可以查看已有内容</span><button @click="taskAction(running, true)">取消任务</button>
    </div>
    <div
      v-else-if="tasks[0] && ['FAILED', 'CANCELLED'].includes(tasks[0].status)"
      class="task-note"
    >
      <span>{{ tasks[0].errorMessage || '任务已取消，已保存的内容保留' }}</span
      ><button @click="taskAction(tasks[0]!, false)">恢复任务</button>
    </div>
    <template v-if="workspace">
      <ProductionAssetStudio
        v-if="mode === 'ASSETS'"
        :project-id="projectId"
        :assets="document.assets"
        :shots="document.shots"
        :editing="editing"
        :locked="busy || !!running"
        @edit="editing = true"
        @update="updateAsset"
        @add="createAsset"
        @remove="removeAsset"
        @merge="mergeSource = $event"
        @regenerate="generate('ASSETS', undefined, $event)"
      />
      <div v-else class="video-workspace">
        <aside class="shot-directory">
          <header>
            <h3>镜头列表</h3>
            <span
              >{{ document.shots.length }} 镜 ·
              {{ document.shots.reduce((n, s) => n + s.durationSeconds, 0) }} 秒</span
            >
          </header>
          <button
            v-for="(s, i) in document.shots"
            :key="s.id"
            class="shot-choice"
            :class="{ selected: s.id === shot?.id }"
            @click="selectShot(s.id)"
          >
            <span class="shot-number">{{ String(i + 1).padStart(2, '0') }}</span>
            <div>
              <strong>{{ s.title || '未命名镜头' }}</strong>
              <p>{{ s.visual || '补充镜头画面' }}</p>
              <small
                >{{ s.durationSeconds }} 秒 · {{ s.bindings.length }} 个绑定 ·
                {{
                  workspace.prompts.find((p) => p.value.shotId === s.id)?.stale
                    ? '提示词待更新'
                    : workspace.prompts.some((p) => p.value.shotId === s.id)
                      ? '提示词已保存'
                      : '待创作提示词'
                }}</small
              >
            </div></button
          ><button class="add" :disabled="busy || !!running || !editing" @click="addShot">
            <Plus :size="16" />添加镜头
          </button>
        </aside>
        <main v-if="shot" class="shot-editor">
          <div class="shot-composition">
            <WorkflowInformationCard
              ><header class="editor-heading">
                <h3>{{ shot.title || '当前镜头' }}</h3>
                <div v-if="editing" class="actions">
                  <button
                    class="icon-button"
                    :disabled="busy || !!running || !editing"
                    aria-label="上移镜头"
                    @click="moveShot(-1)"
                  >
                    <ArrowUp :size="15" /></button
                  ><button
                    class="icon-button"
                    :disabled="busy || !!running || !editing"
                    aria-label="下移镜头"
                    @click="moveShot(1)"
                  >
                    <ArrowDown :size="15" /></button
                  ><button
                    class="icon-button"
                    :disabled="busy || !!running || !editing"
                    aria-label="删除镜头"
                    @click="removeShot"
                  >
                    <Trash2 :size="15" />
                  </button>
                </div>
              </header>
              <p class="shot-metadata">
                {{ shot.shotType }} · {{ shot.cameraMovement }} · {{ shot.durationSeconds }} 秒
              </p>
              <WorkflowInformationField
                v-model="shot.visual"
                label="画面描述"
                multiline
                :readonly="busy || !!running || !editing"
              /><WorkflowInformationField
                v-model="shot.atmosphere"
                label="氛围与连续性"
                multiline
                :readonly="busy || !!running || !editing"
              />
              <details class="shot-details">
                <summary>镜头参数与声音</summary>
                <WorkflowInformationField
                  v-model="shot.title"
                  label="镜头名称"
                  :readonly="busy || !!running || !editing"
                />
                <div class="shot-spec">
                  <WorkflowInformationField
                    v-model="shot.shotType"
                    label="景别"
                    :readonly="busy || !!running || !editing"
                  /><WorkflowInformationField
                    v-model="shot.cameraMovement"
                    label="运镜"
                    :readonly="busy || !!running || !editing"
                  /><label
                    >时长（秒）<input
                      v-model.number="shot.durationSeconds"
                      type="number"
                      min="1"
                      max="3600"
                      :disabled="busy || !!running || !editing"
                  /></label>
                </div>
                <div class="asset-facts">
                  <WorkflowInformationField
                    v-model="shot.dialogue"
                    label="台词与旁白"
                    multiline
                    :readonly="busy || !!running || !editing"
                  /><WorkflowInformationField
                    v-model="shot.audio"
                    label="声音"
                    multiline
                    :readonly="busy || !!running || !editing"
                  />
                </div>
              </details>
            </WorkflowInformationCard>
            <ProductionReferenceLibrary
              :project-id="projectId"
              :assets="document.assets"
              :shot="shot"
              :editing="editing"
              :locked="busy || !!running"
              @toggle="toggleBinding"
              @edit="editing = true"
              @prepare="prepareImage"
              @details="inspectAsset = $event"
            />
          </div>
          <WorkflowInformationCard
            ><header class="editor-heading">
              <h3>镜头提示词</h3>
              <button
                :disabled="busy || !!running || !workspace.shotsConfirmed"
                @click="generate('PROMPT', shot.id)"
              >
                <RefreshCw v-if="prompt" :size="15" /><Sparkles v-else :size="15" />{{
                  prompt ? '重新生成' : '生成提示词'
                }}
              </button>
            </header>
            <p v-if="prompt?.stale || dirty" class="warning">
              镜头或相关资产已修改，保存后可重新生成提示词。
            </p>
            <WorkflowInformationField
              v-model="promptText"
              label="视频提示词"
              multiline
              :readonly="busy || !!running"
              placeholder="保存分镜与绑定后，可生成或编写当前镜头的视频提示词。"
            />
            <div class="actions">
              <button
                :disabled="busy || !!running || !promptText.trim() || !promptDirty"
                @click="savePrompt"
              >
                <Save :size="15" />保存提示词
              </button>
            </div></WorkflowInformationCard
          >
        </main>
        <main v-else class="empty">
          <Clapperboard :size="36" />
          <h3>从完整故事展开镜头</h3>
          <p>确认资产目录后，AI 会按故事时序拆镜，并为每镜绑定需要的对象。</p>
        </main>
        <ProductionShotRenderPanel
          v-if="shot"
          :project-id="projectId"
          :shot="shot"
          :index="document.shots.findIndex((s) => s.id === shot?.id) + 1"
          :assets="boundAssets.map((b) => b.asset)"
          :prompt="prompt?.value.content ?? ''"
          :stale="!!prompt?.stale || dirty"
          :locked="busy || !!running"
          @prepare="prepareImage"
        />
      </div>
    </template>
    <p v-if="notice" class="notice" role="status">{{ notice }}</p>
    <WorkflowNodeFooter
      :back-label="mode === 'ASSETS' ? '上一步：脚本创作' : '上一步：资产准备'"
      :next-label="mode === 'ASSETS' ? '下一步：视频制作' : '下一步：素材交付'"
      :show-validate="false"
      :next-disabled="mode === 'ASSETS' ? !workspace?.assetsConfirmed || dirty : true"
      @back="emit('back')"
      @next="emit('next')"
    />
    <ProductionRenderDialog
      :open="imageDialogOpen"
      type="IMAGE"
      :assets="imageAssets"
      @close="imageDialogOpen = false"
    />
    <WorkflowInformationDialog
      :open="!!inspectAsset"
      :title="inspectAsset?.name || '素材定义'"
      description="素材公共定义，不会因查看而改变当前镜头绑定"
      @close="inspectAsset = null"
    >
      <div v-if="inspectAsset" class="asset-inspection">
        <ProductionAssetPreparation :asset="inspectAsset" readonly />
        <WorkflowInformationField
          :model-value="inspectAsset.description"
          label="公共形象与特征"
          multiline
          readonly
        />
        <WorkflowInformationField
          :model-value="inspectAsset.knownFacts"
          label="已确认信息"
          multiline
          readonly
        />
        <WorkflowInformationField
          :model-value="inspectAsset.designNotes"
          label="设计与待确认内容"
          multiline
          readonly
        />
        <WorkflowInformationField
          :model-value="inspectAsset.imageRequirements ?? ''"
          label="图像制作要求"
          multiline
          readonly
        />
        <WorkflowInformationField
          v-if="editing && shot?.bindings.some((b) => b.assetId === inspectAsset?.id)"
          :model-value="
            shot.bindings.find((b) => b.assetId === inspectAsset?.id)?.description ?? ''
          "
          label="本镜呈现要求"
          multiline
          @update:model-value="
            (value) => {
              const b = shot?.bindings.find((b) => b.assetId === inspectAsset?.id);
              if (b) b.description = value;
            }
          "
        />
        <button @click="prepareImage(inspectAsset)">生成资产图片</button>
      </div>
    </WorkflowInformationDialog>
    <WorkflowInformationDialog
      :open="!!mergeSource"
      title="合并重复定义"
      description="选择保留的对象；相关镜头绑定随草稿更新。请先将需要保留的描述补充到目标对象。"
      @close="mergeSource = ''"
    >
      <div class="binding-picker">
        <label
          >保留对象<select v-model="mergeTarget">
            <option value="">请选择</option>
            <option
              v-for="a in document.assets.filter((a) => a.id !== mergeSource)"
              :key="a.id"
              :value="a.id"
            >
              {{ labels[a.kind] }} · {{ a.name }}
            </option>
          </select></label
        ><button :disabled="!mergeTarget" @click="mergeAssets">合并定义</button>
      </div>
    </WorkflowInformationDialog>
    <WorkflowExecutionGraphDialog
      :open="graphOpen"
      :title="mode === 'ASSETS' ? '当前资产整理工作流' : '当前制作工作流'"
      eyebrow="执行详情"
      description="查看本次任务的实际内容与审校结果"
      :rows="graphRows"
      :nodes="graphNodes"
      :selected="graphNode"
      @select="graphNode = $event"
      @close="graphOpen = false"
    >
      <article v-if="graphDetail" class="execution-content">
        <template v-if="graphDetail.detail">
          <h3>{{ graphDetail.detail.title }}</h3>
          <p v-if="graphDetail.detail.summary" class="execution-summary">
            {{ graphDetail.detail.summary }}
          </p>
          <section
            v-for="(section, index) in graphDetail.detail.sections"
            :key="index"
            class="execution-business-section"
          >
            <h4>{{ section.title }}</h4>
            <dl>
              <template v-for="(field, fieldIndex) in section.fields" :key="fieldIndex">
                <dt>{{ field.label }}</dt>
                <dd>{{ field.value }}</dd>
              </template>
            </dl>
          </section>
          <p
            v-if="!graphDetail.detail.sections.length && graphDetail.detail.emptyMessage"
            class="execution-empty"
          >
            {{ graphDetail.detail.emptyMessage }}
          </p>
        </template>
        <template v-else>
          <h3>{{ graphDetail.title }}</h3>
          <p>{{ graphDetail.content || '此步骤尚未产生内容' }}</p>
        </template>
      </article>
      <p v-else>开始整理后，可查看每一步生成的内容与核对结果。</p></WorkflowExecutionGraphDialog
    >
  </section>
</template>
<style scoped>
.execution-summary {
  color: #73829a;
  font-size: 13px;
}
.execution-business-section {
  margin-top: 22px;
  padding-top: 18px;
  border-top: 1px solid #e5ebf3;
}
.execution-business-section h4 {
  margin: 0 0 14px;
  color: #253751;
  font-size: 15px;
}
.execution-business-section dl {
  margin: 0;
}
.execution-business-section dt {
  margin-top: 14px;
  color: #75859c;
  font-size: 12px;
}
.execution-business-section dd {
  margin: 5px 0 0;
  color: #42526a;
  font-size: 13px;
  line-height: 1.8;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.execution-empty {
  color: #8190a7;
  font-size: 13px;
}
.production-page {
  padding: 26px 28px;
  color: #23344d;
  border: 1px solid #dbe4f6;
  border-radius: 24px;
  background: #fff;
}
.production-heading,
.actions,
.editor-heading,
.task-note {
  display: flex;
  align-items: center;
  gap: 12px;
  justify-content: space-between;
}
.production-heading {
  margin-bottom: 24px;
  flex-wrap: wrap;
}
.production-heading h2 {
  font-size: 22px;
  margin: 8px 0;
}
.production-heading p,
.eyebrow,
.task-note {
  font-size: 12px;
  color: #8190a7;
}
.actions {
  justify-content: flex-end;
  flex-wrap: wrap;
}
.production-page button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  min-height: 38px;
  padding: 0 14px;
  border: 1px solid #d6e1f4;
  border-radius: 10px;
  background: #fff;
  color: #3f5f8c;
  cursor: pointer;
  font: inherit;
  font-size: 12px;
}
.production-page button:disabled {
  opacity: 0.5;
  cursor: default;
}
.production-page button:focus-visible {
  outline: 2px solid #2563eb;
  outline-offset: 2px;
}
.video-workspace {
  display: grid;
  grid-template-columns: 180px minmax(0, 1fr) 270px;
  gap: 16px;
  margin-top: 24px;
  align-items: start;
}
.shot-directory {
  border: 1px solid #e1e8f4;
  border-radius: 13px;
  padding: 12px;
  background: #f8faff;
  max-height: 950px;
  overflow: auto;
}
.shot-directory header {
  padding: 4px 4px 18px;
}
.shot-directory h3,
.editor-heading h3 {
  font-size: 14px;
  margin: 0;
  color: #304663;
}
.shot-directory header span {
  display: block;
  font-size: 10px;
  color: #91a0b5;
  margin-top: 7px;
}
.shot-directory .shot-choice {
  width: 100%;
  text-align: left;
  padding: 12px 9px;
  align-items: flex-start;
  justify-content: flex-start;
  margin-bottom: 8px;
  border-radius: 9px;
}
.shot-number {
  font-size: 10px;
  color: #9aa9bd;
}
.shot-choice strong {
  font-size: 11px;
  line-height: 1.6;
}
.shot-choice p {
  font-size: 10px;
  line-height: 1.7;
  margin: 6px 0;
  color: #8e9bb0;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.shot-choice small {
  font-size: 9px;
  color: #8b9eb9;
  line-height: 1.7;
}
.selected {
  border-color: #a9bff1 !important;
  background: #f0f5ff !important;
  color: #315fe6 !important;
}
.shot-editor {
  display: grid;
  gap: 16px;
  min-width: 0;
}
.shot-composition {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(255px, 0.9fr);
  gap: 16px;
  align-items: start;
}
.shot-editor :deep(.workflow-information-card) {
  min-width: 0;
  padding: 20px;
}
.shot-editor :deep(.information-field textarea) {
  min-height: 110px;
}
.shot-metadata {
  margin: 0 0 20px;
  color: #8796aa;
  font-size: 12px;
  line-height: 1.6;
}
.shot-composition > .workflow-information-card {
  display: grid;
  gap: 18px;
}
.shot-editor > .workflow-information-card {
  display: grid;
  gap: 18px;
}
.shot-editor > .workflow-information-card :deep(textarea) {
  min-height: 240px;
  line-height: 1.9;
  font-size: 12px;
}
.shot-details {
  border-top: 1px solid #e8edf4;
  padding-top: 14px;
}
.shot-details summary {
  font-size: 11px;
  color: #8395ad;
  cursor: pointer;
  margin-bottom: 18px;
}
.shot-details[open] {
  display: grid;
  gap: 16px;
}
.shot-spec {
  display: grid;
  grid-template-columns: 1fr 1fr 70px;
  gap: 10px;
}
.shot-spec label {
  font-size: 11px;
  color: #7c8fa9;
  display: grid;
  gap: 8px;
}
.shot-spec input {
  width: 100%;
  box-sizing: border-box;
  height: 40px;
  border: 1px solid #d7e1f2;
  border-radius: 9px;
  padding: 8px;
  color: #34445b;
}
.asset-facts {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
  margin-top: 16px;
}
.icon-button {
  padding: 0 8px !important;
  min-height: 30px !important;
}
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 350px;
  color: #91a0b5;
  text-align: center;
  padding: 30px;
}
.empty h3 {
  color: #526881;
  font-size: 16px;
}
.empty p {
  font-size: 12px;
  line-height: 1.8;
}
.warning {
  font-size: 12px;
  color: #ae8544;
  line-height: 1.7;
}
.notice {
  font-size: 12px;
  color: #77a18e;
}
.task-note {
  padding: 12px 0;
}
.task-note button {
  border: 0;
  color: #6488c6;
}
.binding-picker {
  display: grid;
  gap: 12px;
}
.binding-picker label {
  display: flex;
  gap: 12px;
  padding: 16px;
  border: 1px solid #e1e8f4;
  border-radius: 12px;
}
.binding-picker small {
  display: block;
  margin-top: 7px;
  color: #7d8da6;
  line-height: 1.7;
}
.execution-content {
  padding: 12px;
}
.execution-content p {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  line-height: 1.8;
  font-size: 13px;
  color: #6b7f9d;
}
.asset-inspection {
  display: grid;
  gap: 18px;
}
.production-page :deep(.reference-library) {
  align-self: stretch;
}
.production-page :deep(.reference-copy strong) {
  max-width: 150px;
}
@media (min-width: 1700px) {
  .video-workspace {
    grid-template-columns: 210px minmax(0, 1fr) 310px;
    gap: 20px;
  }
  .shot-composition {
    grid-template-columns: minmax(0, 1.1fr) minmax(300px, 1fr);
  }
  .shot-directory {
    max-height: 1050px;
  }
}
@media (max-width: 1350px) {
  .video-workspace {
    grid-template-columns: 170px minmax(0, 1fr) 245px;
    gap: 12px;
  }
  .shot-composition {
    grid-template-columns: 1fr;
  }
  .shot-editor :deep(.reference-grid) {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
@media (max-width: 1000px) {
  .video-workspace {
    grid-template-columns: 170px minmax(0, 1fr);
  }
  .video-workspace :deep(.render-panel) {
    grid-column: 2;
  }
  .shot-composition {
    grid-template-columns: 1fr;
  }
}
@media (max-width: 760px) {
  .production-page {
    padding: 18px 14px;
  }
  .video-workspace {
    grid-template-columns: 1fr;
  }
  .video-workspace :deep(.render-panel) {
    grid-column: auto;
  }
  .shot-directory {
    max-height: 250px;
  }
  .shot-spec,
  .asset-facts {
    grid-template-columns: 1fr;
  }
  .production-heading {
    gap: 18px;
  }
  .production-heading p {
    line-height: 1.8;
  }
  .shot-editor :deep(.reference-grid) {
    grid-template-columns: 1fr;
  }
  .shot-editor :deep(.workflow-information-card) {
    padding: 16px;
  }
}
</style>

<style scoped src="../../../platform/workflow/components/workflow-extraction-heading.css"></style>
