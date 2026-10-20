<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { WorkflowNodeFooter } from '@ai-marketing/ui';
import {
  AlertTriangle,
  Boxes,
  Check,
  LoaderCircle,
  RefreshCw,
  ScanLine,
  Sparkles,
  RotateCcw,
} from '@lucide/vue';
import { useProjectContext } from '../../../platform/project/project-context';
import { requestActionConfirmation } from '../../../shared/composables/action-confirmation';
import EffectWorkflowCanvas from '../../effect/source-import/components/EffectWorkflowCanvas.vue';
import CloneUpload from './CloneUpload.vue';
import CloneReport from './CloneReport.vue';
import CloneMapping from './CloneMapping.vue';
import CloneResults from './CloneResults.vue';
import CloneDialog from './CloneDialog.vue';
import CloneIcon from './CloneIcon.vue';
import { clonePrototypeFixture as fixture } from './clone-prototype.fixture';
import {
  candidateFor,
  archiveCloneMock,
  contentSignature,
  cloneMockScope,
  confirmInput,
  confirmMapping,
  confirmReport,
  copy,
  createCloneMock,
  inputSignature,
  mappingSignature,
  reportSignature,
  restoreCloneMock,
  resultSignature,
  startResults,
  tickCloneMock,
  snapshotMapping,
  type CloneResult,
  type CloneCandidate,
} from './clone-mock';

const { currentProject } = useProjectContext();
const projectId = currentProject.value?.id ?? '';
const state = ref(createCloneMock(projectId));
const loading = ref(true),
  loadError = ref(''),
  error = ref(''),
  toast = ref(''),
  fetching = ref(false);
const referenceUrl = ref(''),
  previews = ref<Record<string, string>>({});
const modal = ref<'details' | 'retry' | 'preview' | 'archive' | ''>(''),
  activeResult = ref<CloneResult | null>(null),
  previewId = ref(''),
  note = ref('');
const archiveTags = ref('爆款复刻，Mock'),
  archiveNote = ref('');
let ticker: ReturnType<typeof setInterval> | undefined,
  fetchTimer: ReturnType<typeof setTimeout> | undefined,
  toastTimer: ReturnType<typeof setTimeout> | undefined;
const urls = new Set<string>();
const nodes = [
  {
    label: '上传素材',
    title: '上传素材',
    description: '上传爆款参考视频与商品原料',
    status: '就绪',
  },
  {
    label: '深度拆解',
    title: '深度拆解',
    description: '结构、创意、产品、镜头、音频、视觉六维解析',
    status: '就绪',
  },
  {
    label: '元素映射',
    title: '元素映射',
    description: '替换核心元素，锁定原视频结构与节奏',
    status: '就绪',
  },
  {
    label: '成片生成',
    title: '成片生成',
    description: '批量生成复刻成片并管理交付结果',
    status: '就绪',
  },
];
const headings = [
  '上传参考视频与商品原料',
  '爆款视频六维解析报告',
  '元素映射与替换',
  '成片生成与批量导出',
];
const descriptions = [
  '上传 1 条爆款参考视频，补充多角度商品原料；全部能力仅为本地 Mock',
  '按结构、创意、产品、镜头、音频、视觉依次拆解，并输出商品迁移建议',
  '逐项确认保留或替换策略，候选素材、映射关系和镜头影响互相隔离',
  '查看每条复刻成片的生成状态、映射快照与交付信息',
];
const inputDirty = computed(() => inputSignature(state.value) !== state.value.confirmedInput);
const reportStale = computed(
  () => state.value.reportReady && state.value.reportInput !== state.value.confirmedInput,
);
const reportDirty = computed(() => reportSignature(state.value) !== state.value.confirmedReport);
const mappingStale = computed(
  () => !!state.value.confirmedMapping && state.value.mappingReport !== state.value.confirmedReport,
);
const mappingDirty = computed(() => mappingSignature(state.value) !== state.value.confirmedMapping);
const blocked = computed(
  () =>
    !state.value.reference ||
    inputDirty.value ||
    reportStale.value ||
    reportDirty.value ||
    mappingStale.value ||
    mappingDirty.value ||
    !state.value.confirmedReport ||
    !state.value.elements[0] ||
    !candidateFor(state.value, state.value.elements[0]) ||
    !!state.value.job,
);
const staleCounts = computed(() => [
  0,
  reportStale.value ? 1 : 0,
  mappingStale.value ? 1 : 0,
  state.value.results.filter((i) => i.snapshot !== resultSignature(state.value)).length,
]);
const completedSteps = computed(() =>
  [
    state.value.confirmedInput && !inputDirty.value ? 0 : -1,
    state.value.reportReady && !reportStale.value && !reportDirty.value ? 1 : -1,
    state.value.confirmedMapping && !mappingStale.value && !mappingDirty.value ? 2 : -1,
    state.value.results.length &&
    state.value.results.every(
      (r) => r.status === 'done' && r.snapshot === resultSignature(state.value),
    )
      ? 3
      : -1,
  ].filter((i) => i >= 0),
);
const canvasNodes = computed(() =>
  nodes.map((n, i) => ({ ...n, status: completedSteps.value.includes(i) ? '已完成' : '待处理' })),
);
const artifactTitle = computed(
  () =>
    ['参考视频与商品原料', '六维深度拆解报告', '元素映射配置', '复刻成片批次'][state.value.step]!,
);
const artifactKey = computed(() => ['input', 'report', 'mapping', 'results'][state.value.step]!);
const artifactSignature = computed(
  () =>
    [
      !inputDirty.value ? state.value.confirmedInput : '',
      state.value.reportReady && !reportDirty.value && !reportStale.value
        ? state.value.confirmedReport
        : '',
      !mappingDirty.value && !mappingStale.value ? state.value.confirmedMapping : '',
      state.value.results.length && state.value.results.every((r) => r.status === 'done')
        ? contentSignature(state.value.results)
        : '',
    ][state.value.step] ?? '',
);
const artifactSaved = computed(
  () =>
    !!artifactSignature.value &&
    state.value.archived[artifactKey.value]?.signature === artifactSignature.value,
);
function archiveCurrent() {
  if (!artifactSignature.value) return;
  archiveCloneMock(
    state.value,
    artifactKey.value,
    artifactSignature.value,
    archiveTags.value,
    archiveNote.value,
  );
  modal.value = '';
  notify('已保存到当前项目的本地 Mock 归档');
}
const previewMaterial = computed(() => state.value.materials.find((i) => i.id === previewId.value));
const jobProgress = ref(0);
function notify(message: string) {
  toast.value = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.value = ''), 3000);
}
function persist(): boolean {
  if (loading.value || loadError.value) return false;
  try {
    localStorage.setItem(cloneMockScope(projectId), JSON.stringify(state.value));
    return true;
  } catch {
    error.value = '本地演示空间不足，当前修改暂未保存；可重置演示数据后重试';
    return false;
  }
}
function load() {
  loading.value = true;
  loadError.value = '';
  try {
    state.value = restoreCloneMock(localStorage, projectId);
    tickCloneMock(state.value, Date.now());
  } catch {
    loadError.value = '本地演示草稿无法读取，可重试或重置演示数据。';
  } finally {
    loading.value = false;
  }
}
watch(
  state,
  () => {
    if (!loading.value && !loadError.value) persist();
  },
  { deep: true },
);
onMounted(async () => {
  await nextTick();
  load();
  ticker = setInterval(() => {
    if (loadError.value) return;
    tickCloneMock(state.value, Date.now());
    jobProgress.value = state.value.job
      ? Math.min(99, Math.floor((Date.now() - state.value.job.startedAt) / 22))
      : 100;
  }, 250);
});
onBeforeUnmount(() => {
  clearInterval(ticker);
  clearTimeout(fetchTimer);
  clearTimeout(toastTimer);
  urls.forEach((url) => URL.revokeObjectURL(url));
});
function run(action: () => void) {
  error.value = '';
  try {
    action();
    persist();
  } catch (e) {
    error.value = e instanceof Error ? e.message : '操作失败，请重试';
  }
}
function go(step: number) {
  state.value.step = step;
  error.value = '';
}
function next() {
  run(() => {
    if (state.value.step === 0) confirmInput(state.value);
    if (state.value.step === 1) confirmReport(state.value);
    if (state.value.step === 2) confirmMapping(state.value);
    state.value.step = Math.min(3, state.value.step + 1);
  });
}
function startJob(kind: 'analysis' | 'mapping') {
  run(() => {
    if (state.value.job) return;
    if (kind === 'analysis') {
      confirmInput(state.value);
    } else if (reportDirty.value || reportStale.value || !state.value.confirmedReport)
      throw new Error('请先完成并确认最新六维拆解报告');
    state.value.job = {
      kind,
      startedAt: Date.now(),
      snapshot: kind === 'analysis' ? state.value.confirmedInput : state.value.confirmedReport,
    };
    jobProgress.value = 0;
  });
}
function confirmCurrent() {
  run(() => {
    if (state.value.step === 0) confirmInput(state.value);
    if (state.value.step === 1) confirmReport(state.value);
    if (state.value.step === 2) confirmMapping(state.value);
    notify('已保存当前演示工作副本');
  });
}
async function reset(empty = false) {
  if (
    !(await requestActionConfirmation({
      title: empty ? '清空本项目演示内容？' : '恢复原型演示数据？',
      description: '仅重置当前项目的本地 Mock 草稿和演示任务。',
      confirmLabel: empty ? '清空演示' : '恢复演示',
    }))
  )
    return;
  loadError.value = '';
  loading.value = false;
  urls.forEach((u) => URL.revokeObjectURL(u));
  urls.clear();
  referenceUrl.value = '';
  previews.value = {};
  state.value = createCloneMock(projectId, empty);
  error.value = '';
  persist();
}
function objectUrl(file: File) {
  const url = URL.createObjectURL(file);
  urls.add(url);
  return url;
}
function revoke(url: string | undefined) {
  if (url) {
    URL.revokeObjectURL(url);
    urls.delete(url);
  }
}
function uploadReference(files: FileList | null) {
  const file = files?.[0];
  if (!file) return;
  run(() => {
    if (files!.length !== 1) throw new Error('每次只能上传一条爆款参考视频');
    if (!file.type.startsWith('video/') && !/\.(mp4|mov|webm)$/i.test(file.name))
      throw new Error('请选择 MP4、MOV 或其他视频文件');
    if (file.size > 500 * 1024 * 1024) throw new Error('参考视频请控制在 500 MB 以内');
    revoke(referenceUrl.value);
    referenceUrl.value = objectUrl(file);
    state.value.reference = {
      name: file.name,
      size: (file.size / 1024 / 1024).toFixed(1) + ' MB',
      duration: '本地视频',
      resolution: '本地视频',
      ratio: '原始画幅',
      url: '',
      mock: false,
    };
  });
}
function uploadMaterials(files: FileList | null) {
  if (!files) return;
  run(() => {
    const all = [...files];
    if (all.some((f) => !f.type.startsWith('image/') && !f.type.startsWith('video/')))
      throw new Error('商品原料仅支持图片或视频');
    if (all.some((f) => f.size > 200 * 1024 * 1024))
      throw new Error('单份商品原料请控制在 200 MB 以内');
    for (const file of all) {
      const id = crypto.randomUUID();
      previews.value[id] = objectUrl(file);
      state.value.materials.push({
        id,
        name: file.name,
        type: file.type.startsWith('video/') ? 'video' : 'image',
        category: '本地上传',
        size: (file.size / 1024 / 1024).toFixed(1) + ' MB',
        resolution: '原始尺寸',
        tags: ['本地素材'],
        status: '演示待确认',
      });
    }
  });
}
function removeMaterial(id: string) {
  revoke(previews.value[id]);
  delete previews.value[id];
  state.value.materials = state.value.materials.filter((m) => m.id !== id);
  state.value.elements.filter((e) => e.targetId === id).forEach((e) => (e.targetId = ''));
}
function removeReference() {
  revoke(referenceUrl.value);
  referenceUrl.value = '';
  state.value.reference = null;
}
function fetchPid() {
  if (fetching.value) return;
  fetching.value = true;
  fetchTimer = setTimeout(() => {
    fixture.productMaterials.slice(0, 3).forEach((m, i) => {
      const id = 'pid-' + state.value.pid + '-' + i;
      if (!state.value.materials.some((a) => a.id === id))
        state.value.materials.push({ ...copy(m), id, tags: ['PID 演示', ...m.tags] });
    });
    fetching.value = false;
    notify('已获取 3 份 Mock 商品素材');
  }, 700);
}
function importCandidates(items: CloneCandidate[], sourceId: string) {
  for (const item of items)
    if (!state.value.candidates.some((c) => c.id === item.id))
      state.value.candidates.push(copy(item));
  const e = state.value.elements.find((e) => e.id === sourceId);
  if (e && items.length === 1) {
    e.targetId = items[0]!.id;
    e.strategy = 'replace';
  }
}
function generate(count: number, fail: boolean) {
  run(() => {
    startResults(state.value, count, Date.now(), fail);
    notify('已创建本地 Mock 成片任务');
  });
}
function openResult(kind: 'details' | 'retry' | 'preview', item: CloneResult) {
  activeResult.value = item;
  note.value = item.note;
  previewId.value = '';
  modal.value = kind;
}
function retry() {
  run(() => {
    if (!activeResult.value) return;
    if (blocked.value) throw new Error('请先确认最新素材、拆解报告和元素映射');
    const item = activeResult.value;
    item.status = 'running';
    item.progress = 0;
    item.startedAt = Date.now();
    item.fail = false;
    item.note = note.value.trim();
    item.mapping = snapshotMapping(state.value);
    item.referenceName = state.value.reference?.name ?? '';
    item.snapshot = resultSignature(state.value);
    modal.value = '';
  });
}
async function removeResults(ids: string[]) {
  if (
    !(await requestActionConfirmation({
      title: `删除 ${ids.length} 条演示成片？`,
      description: '本次只移除选中的 Mock 任务及结果卡片。',
      confirmLabel: '删除',
    }))
  )
    return;
  state.value.results = state.value.results.filter((i) => !ids.includes(i.id));
}
function exportResults(items: CloneResult[]) {
  run(() => {
    if (items.some((i) => i.status !== 'done')) throw new Error('请先完成所选成片的生成');
    const text = [
      '本地 Mock 演示清单（不含真实视频）',
      '名称\t状态\t参考视频\t创建时间',
      ...items.map(
        (i) =>
          `${i.name}\t${i.snapshot === resultSignature(state.value) ? '已完成' : '待更新'}\t${i.referenceName}\t${i.createdAt}`,
      ),
    ].join('\n');
    const url = URL.createObjectURL(
      new Blob(['\ufeff' + text], { type: 'text/plain;charset=utf-8' }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = '爆款复刻_Mock演示清单.txt';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    notify('已导出演示清单');
  });
}
defineExpose({
  flushPendingEdits: async () => persist(),
  workflowRunId: '',
  resumeWorkflowNode: async (nodeId: string) => {
    const index = ['upload', 'analysis', 'mapping', 'generation'].findIndex((s) =>
      nodeId.includes(s),
    );
    if (index >= 0) go(index);
    return index >= 0;
  },
});
</script>

<template>
  <div class="clone-studio">
    <div class="clone-demo-bar">
      <span><i />本地 Mock</span>
      <p>
        {{ currentProject ? '当前项目：' + currentProject.name : '未绑定项目 · 演示预览' }} ·
        演示数据保存在本机，不产生生成费用
      </p>
      <button @click="reset(true)">清空演示</button
      ><button @click="reset()"><RotateCcw :size="12" />恢复样例</button>
    </div>
    <div v-if="loading" class="clone-empty">
      <LoaderCircle class="clone-spin" :size="30" />
      <h3>正在加载演示工作区…</h3>
    </div>
    <div v-else-if="loadError" class="clone-empty" role="alert">
      <AlertTriangle :size="30" />
      <h3>{{ loadError }}</h3>
      <div>
        <button class="frg-btn" @click="load">重新加载</button
        ><button class="frg-btn primary" @click="reset()">重置演示数据</button>
      </div>
    </div>
    <template v-else>
      <EffectWorkflowCanvas
        :active-step="state.step"
        :completed-steps="completedSteps"
        :nodes="canvasNodes"
        :stale-counts="staleCounts"
        workflow-label="裂变类 · 爆款复刻"
        :workflow-number="String(state.step + 1).padStart(2, '0')"
        :show-branches="false"
        @select="go"
      />
      <div class="clone-artifact-bar">
        <span class="clone-artifact-icon"><Boxes :size="22" /></span>
        <div>
          <b>{{ artifactTitle }}</b
          ><small>{{ currentProject?.name ?? '未绑定演示预览' }} · 裂变类 · 爆款复刻存储区</small>
        </div>
        <em>{{ artifactSaved ? '演示已归档' : '待入库产物' }}</em
        ><button
          class="frg-btn primary"
          :disabled="!artifactSignature || !!state.job"
          @click="modal = 'archive'"
        >
          保存到项目资产库（Mock）
        </button>
      </div>
      <div v-if="error" class="clone-alert error" role="alert">
        <AlertTriangle :size="16" /><span>{{ error }}</span
        ><button @click="error = ''">关闭</button>
      </div>
      <div
        v-if="
          (state.step === 1 && reportStale) ||
          (state.step === 2 && mappingStale) ||
          (state.step === 3 && staleCounts[3])
        "
        class="clone-alert"
        role="status"
      >
        <RefreshCw :size="15" /><span
          >上游已确认内容发生变化，当前结果待更新。确认新输入后再主动重新生成。</span
        >
      </div>
      <section class="frg-shell">
        <header class="frg-head">
          <span class="frg-step">{{ String(state.step + 1).padStart(2, '0') }}</span>
          <div class="frg-title">
            <h2>{{ headings[state.step] }}</h2>
            <p>{{ descriptions[state.step] }}</p>
          </div>
          <div class="frg-head-actions">
            <button
              v-if="state.step === 1"
              class="frg-btn"
              :disabled="!!state.job || !state.reference"
              @click="startJob('analysis')"
            >
              <RefreshCw :size="14" />{{
                state.reportReady ? '重新生成拆解报告' : '开始 AI 深度拆解'
              }}</button
            ><button
              v-if="state.step === 2"
              class="frg-btn primary"
              :disabled="!!state.job || !state.confirmedReport || reportStale || reportDirty"
              @click="startJob('mapping')"
            >
              <Sparkles :size="14" />智能匹配全部</button
            ><button
              v-if="state.step < 3"
              class="frg-btn"
              :disabled="!!state.job || (state.step === 1 && !state.reportReady)"
              @click="confirmCurrent"
            >
              <Check :size="14" />{{
                state.step === 0 ? '确认素材' : state.step === 1 ? '保存报告' : '确认映射'
              }}
            </button>
          </div>
        </header>
        <div v-if="state.job" class="clone-empty" role="status">
          <LoaderCircle class="clone-spin" :size="36" />
          <h3>
            {{ state.job.kind === 'analysis' ? '正在进行六维深度拆解' : '正在智能匹配素材' }}
          </h3>
          <p>本地 Mock · {{ jobProgress }}%</p>
          <div class="clone-progress"><i :style="{ width: jobProgress + '%' }" /></div>
          <button class="frg-btn" @click="state.job = null">取消本次演示</button>
        </div>
        <CloneUpload
          v-else-if="state.step === 0"
          :state="state"
          :reference-url="referenceUrl"
          :previews="previews"
          :busy="fetching"
          @reference="uploadReference"
          @materials="uploadMaterials"
          @remove="removeMaterial"
          @remove-reference="removeReference"
          @fetch="fetchPid"
          @pid="state.pid = $event"
          @preview="
            previewId = $event;
            modal = 'preview';
            activeResult = null;
          "
        />
        <CloneReport v-else-if="state.step === 1 && state.reportReady" :state="state" />
        <div v-else-if="state.step === 1" class="frg-analysis-intro">
          <div class="frg-analysis-visual"><ScanLine :size="64" /></div>
          <div class="frg-analysis-copy">
            <h3>把爆款逻辑变成可复用的创作骨架</h3>
            <p>从结构、创意、产品、镜头、音频、视觉 6 个维度分析，并生成关键镜头时间线。</p>
            <ul>
              <li
                v-for="s in [
                  '结构节奏',
                  '创意与情绪',
                  '产品展示',
                  '镜头语言',
                  '音频卡点',
                  '视觉风格',
                ]"
                :key="s"
              >
                {{ s }}
              </li>
            </ul>
            <button
              class="frg-btn primary"
              :disabled="!state.reference"
              @click="startJob('analysis')"
            >
              开始 AI 深度拆解
            </button>
          </div>
        </div>
        <CloneMapping
          v-else-if="state.step === 2 && state.reportReady"
          :state="state"
          @import="importCandidates"
        />
        <div v-else-if="state.step === 2" class="clone-empty">
          <Boxes :size="36" />
          <h3>暂无可映射的拆解报告</h3>
          <p>上传参考视频并完成六维深度拆解后，再选择替换元素。</p>
          <button class="frg-btn primary" @click="go(1)">前往深度拆解</button>
        </div>
        <CloneResults
          v-else
          :state="state"
          :blocked="blocked"
          @generate="generate"
          @retry="openResult('retry', $event)"
          @details="openResult('details', $event)"
          @preview="openResult('preview', $event)"
          @remove="removeResults"
          @export="exportResults"
        />
      </section>
      <WorkflowNodeFooter
        :back-label="state.step > 0 ? '上一步' : ''"
        :show-validate="false"
        :show-next="state.step < 3"
        :next-disabled="!!state.job"
        :next-label="state.step === 2 ? '下一步：成片生成' : '下一步'"
        @back="go(Math.max(0, state.step - 1))"
        @next="next"
      />
    </template>
    <CloneDialog
      v-if="modal"
      :title="
        modal === 'archive'
          ? '保存到当前项目资产库（Mock）'
          : modal === 'retry'
            ? '输入修改意见并重新生成'
            : modal === 'details'
              ? '成片映射快照'
              : '素材预览'
      "
      @close="modal = ''"
    >
      <template v-if="modal === 'archive'"
        ><p class="clone-muted">
          当前项目：{{ currentProject?.name ?? '未绑定演示预览' }}。此操作只保存本地演示归档。
        </p>
        <div class="clone-snapshot">
          <div>
            <Boxes :size="22" /><b>{{ artifactTitle }}</b
            ><span>{{ artifactSaved ? '内容未变化' : '待入库' }}</span>
          </div>
        </div>
        <label class="clone-notes"
          >资产标签<input v-model="archiveTags" placeholder="使用逗号分隔" /></label
        ><label class="clone-notes"
          >版本说明<input v-model="archiveNote" placeholder="请输入本次入库说明" /></label
      ></template>
      <template v-else-if="modal === 'details' && activeResult"
        ><p class="clone-muted">{{ activeResult.name }} · 创建任务时锁定的输入</p>
        <div class="clone-snapshot">
          <div>
            <span>参考视频</span><b>{{ activeResult.referenceName }}</b>
          </div>
          <div v-for="e in activeResult.mapping" :key="e.id">
            <span>{{ e.name }}</span
            ><b>{{ e.strategy === 'retain' ? '保留原片' : e.targetName || '尚未绑定素材' }}</b>
          </div>
        </div></template
      >
      <template v-else-if="modal === 'retry'"
        ><p class="clone-muted">{{ activeResult?.name }}</p>
        <label class="clone-notes"
          >本次修改意见<textarea
            v-model="note"
            placeholder="例如：产品特写延长 1 秒，整体色温调整为暖光，CTA 字幕上移。"
          />
        </label>
        <p class="clone-muted">重新生成将使用当前已确认映射，保留原片结构与节奏。</p></template
      >
      <template v-else
        ><video v-if="previewId === 'reference' && referenceUrl" :src="referenceUrl" controls /><img
          v-else-if="previewMaterial?.type === 'image' && previews[previewId]"
          :src="previews[previewId]"
          :alt="previewMaterial.name"
          class="clone-preview-image"
        /><video
          v-else-if="previewMaterial?.type === 'video' && previews[previewId]"
          :src="previews[previewId]"
          controls
        />
        <div v-else class="clone-preview-placeholder">
          <CloneIcon type="video" :size="50" /><b>{{
            activeResult?.name ?? previewMaterial?.name ?? state.reference?.name
          }}</b>
          <p>
            {{
              previewMaterial?.category === '本地上传'
                ? '文件预览已随刷新释放，请重新选择本地文件。'
                : '当前为原型 Mock 封面，无真实生成视频。'
            }}
          </p>
        </div></template
      >
      <template v-if="modal === 'archive'" #footer
        ><button class="frg-btn" @click="modal = ''">取消</button
        ><button class="frg-btn primary" :disabled="!artifactSignature" @click="archiveCurrent">
          确认演示入库
        </button></template
      >
      <template v-else-if="modal === 'retry'" #footer
        ><button class="frg-btn" @click="modal = ''">取消</button
        ><button class="frg-btn primary" :disabled="blocked" @click="retry">
          {{ activeResult?.status === 'failed' ? '重试演示生成' : '按修改意见重新生成' }}
        </button></template
      >
    </CloneDialog>
    <div v-if="toast" class="clone-toast" role="status">{{ toast }}</div>
  </div>
</template>

<style src="./clone-prototype.css"></style>
