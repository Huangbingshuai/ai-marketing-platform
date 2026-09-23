<script setup lang="ts">
import { computed, onActivated, onDeactivated, onBeforeUnmount, ref, watch } from 'vue';
import { AlertCircle, ArrowLeft, ChevronLeft, ChevronRight, Download, Film, Layers, LoaderCircle, Play, RefreshCw } from '@lucide/vue';
import type { ApiResponse, FinalOutputResolution, FinalOutputRun } from '@ai-marketing/contracts';
import { apiUrl, requestJson } from '../../../api/http-client';

const props = defineProps<{ projectId: string; workflowRunId: string }>();
defineEmits<{ back: [] }>();
const showDemoAction = import.meta.env.DEV;
const OUTPUT_PAGE_SIZE_OPTIONS = [5, 10, 20, 50, 100] as const;
const runs = ref<FinalOutputRun[]>([]),
  selectedTemplateId = ref(''),
  selectedRunId = ref(''),
  resolution = ref<FinalOutputResolution>('720p'),
  frameRate = ref<24 | 25 | 30 | 50 | 60>(30),
  page = ref(1),
  pageSize = ref(20),
  settingsByTemplate = ref(new Map<string, { resolution: FinalOutputResolution; frameRate: 24 | 25 | 30 | 50 | 60 }>());
const loading = ref(true),
  busy = ref(false),
  demoMode = ref(false),
  error = ref('');
const templates = computed(() => {
  const latestByTemplate = new Map<string, FinalOutputRun>();
  for (const outputRun of runs.value) {
    if (!latestByTemplate.has(outputRun.templateId))
      latestByTemplate.set(outputRun.templateId, outputRun);
  }
  return [...latestByTemplate.values()];
});
const templateRuns = computed(() => runs.value.filter((r) => r.templateId === selectedTemplateId.value));
const run = computed(() => templateRuns.value.find((r) => r.id === selectedRunId.value) ?? templateRuns.value[0]);
const active = computed(() => run.value && ['QUEUED', 'RUNNING'].includes(run.value.status));
const pageCount = computed(() => Math.max(1, Math.ceil((run.value?.items.length ?? 0) / pageSize.value)));
const items = computed(() => run.value?.items.slice((page.value - 1) * pageSize.value, page.value * pageSize.value) ?? []);
const progress = computed(() =>
  run.value?.items.length
    ? Math.floor(
        run.value.items.reduce((sum, item) => sum + item.progress, 0) / run.value.items.length,
      )
    : 0,
);
const labels: Record<string, string> = {
  PENDING_RENDER: '待渲染',
  QUEUED: '排队中',
  RUNNING: '渲染中',
  COMPLETED: '已完成',
  FAILED: '失败',
  PARTIAL: '部分完成',
  CANCELLED: '已取消',
};
const statusTone = (status: string) => {
  if (status === 'COMPLETED') return 'success';
  if (status === 'FAILED' || status === 'CANCELLED' || status === 'PARTIAL') return 'danger';
  if (status === 'RUNNING') return 'running';
  return 'pending';
};
const base = computed(() => `/projects/${props.projectId}/workflows/effect/final-output`);
const fileUrl = (id: string) =>
  demoMode.value && id === 'mock-video'
    ? '/tests/manual/fixtures/effect-final-output-demo.mp4'
    : apiUrl(`/projects/${props.projectId}/file-objects/${id}/content`);
let timer: ReturnType<typeof setTimeout> | undefined;
let controller: AbortController | undefined;
let generation = 0,
  mounted = true;
async function refresh() {
  if (demoMode.value) return;
  const current = ++generation;
  controller?.abort();
  controller = new AbortController();
  clearTimeout(timer);
  try {
    const result = await requestJson<ApiResponse<FinalOutputRun[]>>(
      `${base.value}?workflowRunId=${props.workflowRunId}`,
      { operation: '读取成片输出', signal: controller.signal },
    );
    if (current !== generation) return;
    runs.value = result.data;
    const savedSettings = new Map(settingsByTemplate.value);
    for (const template of templates.value) {
      if (!savedSettings.has(template.templateId)) {
        savedSettings.set(template.templateId, {
          resolution: template.resolution,
          frameRate: template.frameRate,
        });
      }
    }
    settingsByTemplate.value = savedSettings;
    error.value = '';
    if (!templates.value.some((r) => r.templateId === selectedTemplateId.value))
      selectedTemplateId.value = templates.value[0]?.templateId ?? '';
    if (!templateRuns.value.some((r) => r.id === selectedRunId.value))
      selectedRunId.value = templateRuns.value[0]?.id ?? '';
  } catch (reason) {
    if (current === generation && !(reason instanceof DOMException && reason.name === 'AbortError'))
      error.value = reason instanceof Error ? reason.message : '读取输出失败';
  } finally {
    if (current === generation) {
      loading.value = false;
      if (mounted) timer = setTimeout(() => void refresh(), 4000);
    }
  }
}
async function command(action: 'retry' | 'cancel') {
  if (!run.value || busy.value) return;
  if (demoMode.value) {
    const targetRunId = run.value.id;
    if (action === 'retry') {
      runs.value = runs.value.map((currentRun) =>
        currentRun.id === targetRunId
          ? {
              ...currentRun,
              status: 'COMPLETED',
              items: currentRun.items.map((item) => ({
                ...item,
                status: 'COMPLETED',
                progress: 100,
                fileObjectId: item.fileObjectId ?? 'mock-video',
                errorMessage: null,
              })),
              counts: {
                total: currentRun.counts.total,
                queued: 0,
                running: 0,
                completed: currentRun.counts.total,
                failed: 0,
              },
            }
          : currentRun,
      );
    } else {
      runs.value = runs.value.map((currentRun) => currentRun.id === targetRunId
        ? {
            ...currentRun,
            status: 'CANCELLED',
            items: currentRun.items.map((item) => item.status === 'COMPLETED'
              ? item
              : { ...item, status: 'CANCELLED', errorMessage: '演示已取消' }),
            counts: {
              ...currentRun.counts,
              queued: 0,
              running: 0,
              failed: currentRun.counts.total - currentRun.counts.completed,
            },
          }
        : currentRun);
    }
    return;
  }
  busy.value = true;
  try {
    await requestJson(`${base.value}/${run.value.id}/${action}`, {
      method: 'POST',
      operation: action === 'retry' ? '恢复失败输出' : '取消输出',
    });
    await refresh();
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : '输出操作失败';
  } finally {
    busy.value = false;
  }
}
async function startRender() {
  if (!run.value || run.value.status !== 'PENDING_RENDER' || busy.value) return;
  if (demoMode.value) {
    runs.value = runs.value.map((currentRun) => currentRun.id === run.value?.id
      ? {
          ...currentRun,
          status: 'RUNNING',
          resolution: resolution.value,
          frameRate: frameRate.value,
          items: currentRun.items.map((item) => ({ ...item, status: 'RUNNING', progress: 8 })),
          counts: { total: currentRun.counts.total, queued: 0, running: currentRun.counts.total, completed: 0, failed: 0 },
        }
      : currentRun);
    return;
  }
  busy.value = true;
  try {
    await requestJson(`${base.value}/${run.value.id}/render`, {
      method: 'POST',
      operation: '开始导出成片',
      body: { resolution: resolution.value, frameRate: frameRate.value },
    });
    await refresh();
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : '启动成片渲染失败';
  } finally {
    busy.value = false;
  }
}
function stop() {
  mounted = false;
  ++generation;
  controller?.abort();
  clearTimeout(timer);
}
function loadDemoData() {
  if (!showDemoAction) return;
  demoMode.value = true;
  ++generation;
  controller?.abort();
  controller = undefined;
  clearTimeout(timer);
  const createdAt = new Date().toISOString();
  const names = [
    '开场产品展示',
    '包装细节特写',
    '使用动作演示',
    '质地近景镜头',
    '生活场景切换',
    '多角度产品展示',
    '使用前准备',
    '镜头缓慢推进',
    '桌面陈列画面',
    '产品收尾镜头',
    '创意版本 A',
    '创意版本 B',
  ];
  const items: FinalOutputRun['items'] = names.map((name, index) => {
    const status =
      index < 6 ? 'COMPLETED' : index < 8 ? 'RUNNING' : index < 11 ? 'QUEUED' : 'FAILED';
    return {
      id: `demo-item-${index + 1}`,
      variantId: `demo-variant-${index + 1}`,
      name: `成片 ${String(index + 1).padStart(2, '0')} · ${name}`,
      status,
      duration: 4,
      fileObjectId: status === 'COMPLETED' ? 'mock-video' : null,
      assetId: null,
      errorMessage: status === 'FAILED' ? '演示失败：可恢复，已完成项目会保留' : null,
      progress: status === 'COMPLETED' ? 100 : status === 'RUNNING' ? 50 : 0,
    };
  });
  runs.value = [
    {
      id: 'demo-final-output',
      workflowRunId: props.workflowRunId,
      templateId: 'demo-template',
      templateName: '夏日冰饮模板',
      resolution: '720p',
      frameRate: 30,
      status: 'PARTIAL',
      createdAt,
      items,
      counts: { total: 12, queued: 3, running: 2, completed: 6, failed: 1 },
    },
    {
      id: 'demo-final-output-pending',
      workflowRunId: props.workflowRunId,
      templateId: 'demo-template-pending',
      templateName: '厨房料理模板',
      resolution: '720p',
      frameRate: 30,
      status: 'PENDING_RENDER',
      createdAt,
      items: names.slice(0, 6).map((name, index) => ({
        id: `demo-pending-${index + 1}`,
        variantId: `demo-pending-variant-${index + 1}`,
        name: `成片 ${String(index + 1).padStart(2, '0')} · ${name}`,
        status: 'PENDING_RENDER',
        duration: 4,
        fileObjectId: null,
        assetId: null,
        errorMessage: null,
        progress: 0,
      })),
      counts: { total: 6, queued: 0, running: 0, completed: 0, failed: 0 },
    },
  ];
  selectedTemplateId.value = 'demo-template-pending';
  selectedRunId.value = 'demo-final-output-pending';
  page.value = 1;
  loading.value = false;
  error.value = '';
}
function exitDemoMode() {
  demoMode.value = false;
  runs.value = [];
  selectedTemplateId.value = '';
  selectedRunId.value = '';
  settingsByTemplate.value = new Map();
  page.value = 1;
  loading.value = true;
  void refresh();
}
watch(
  () => [props.projectId, props.workflowRunId],
  () => {
    demoMode.value = false;
    runs.value = [];
    selectedTemplateId.value = '';
    selectedRunId.value = '';
    settingsByTemplate.value = new Map();
    loading.value = true;
    page.value = 1;
    void refresh();
  },
  { immediate: true },
);
watch(selectedTemplateId, () => {
  page.value = 1;
  selectedRunId.value = templateRuns.value[0]?.id ?? '';
});
watch(selectedRunId, () => { page.value = 1; });
watch(() => run.value?.id, () => {
  page.value = 1;
  if (run.value) {
    const saved = run.value.status === 'PENDING_RENDER'
      ? settingsByTemplate.value.get(run.value.templateId)
      : undefined;
    resolution.value = saved?.resolution ?? run.value.resolution;
    frameRate.value = saved?.frameRate ?? run.value.frameRate;
  }
});
watch([resolution, frameRate], ([nextResolution, nextFrameRate]) => {
  if (run.value?.status !== 'PENDING_RENDER') return;
  settingsByTemplate.value.set(run.value.templateId, {
    resolution: nextResolution,
    frameRate: nextFrameRate,
  });
});
onActivated(() => {
  mounted = true;
  void refresh();
});
onDeactivated(stop);
onBeforeUnmount(stop);
</script>

<template>
  <section class="final-output" aria-labelledby="final-output-title">
    <header class="output-heading">
      <div class="output-heading__title">
        <span class="step">06</span>
        <div>
          <h2 id="final-output-title">成片输出</h2>
          <p>按模板隔离待渲染成片，设置分辨率与帧率后统一导出</p>
        </div>
      </div>
    </header>

    <div v-if="error" class="notice" role="alert">
      <AlertCircle :size="17" />
      <span>{{ error }}</span>
      <button class="secondary-button" type="button" @click="refresh">
        <RefreshCw :size="14" />重新读取
      </button>
    </div>

    <div v-if="demoMode" class="demo-notice" role="status">
      <span><strong>演示数据</strong> · 以下内容仅供界面预览，不来自项目数据，也不会写入项目</span>
      <button class="secondary-button" type="button" @click="exitDemoMode">退出演示</button>
    </div>

    <section v-if="loading" class="page-state" role="status">
      <span class="state-icon loading-icon"><Film :size="24" /></span>
      <h3>正在读取成片输出</h3>
      <p>正在恢复当前项目和工作流运行的输出任务…</p>
    </section>
    <section v-else-if="!run && !error" class="page-state empty-state">
      <span class="state-icon"><Film :size="25" /></span>
      <h3>暂无待渲染成片</h3>
      <p>每个模板完成校验后会独立进入此处；选择模板并点击“导出成片”后，才开始渲染该模板下的全部成片。</p>
      <button class="secondary-button" type="button" @click="$emit('back')">
        <ArrowLeft :size="14" />返回模板混剪
      </button>
      <button
        v-if="showDemoAction"
        class="primary-button"
        type="button"
        @click="loadDemoData"
      >
        <Film :size="14" />加载演示数据
      </button>
    </section>

    <template v-else-if="run">
      <div class="output-layout">
        <aside class="template-sidebar" aria-label="模板列表">
          <header class="template-sidebar__heading">
            <h3>我的模板</h3>
            <span>{{ templates.length }}</span>
          </header>
          <div class="template-list" role="tablist" aria-label="选择模板">
            <button
              v-for="template in templates"
              :key="template.templateId"
              class="template-card"
              :class="{ selected: selectedTemplateId === template.templateId }"
              type="button"
              role="tab"
              :aria-selected="selectedTemplateId === template.templateId"
              @click="selectedTemplateId = template.templateId"
            >
              <Layers :size="18" />
              <span class="template-card__copy">
                <strong>{{ template.templateName }}</strong>
                <small>{{ template.counts.total }} 条成片 · {{ labels[template.status] }}</small>
              </span>
            </button>
          </div>
        </aside>

        <main class="output-main">
          <label v-if="templateRuns.length > 1" class="batch-select">
            <span>输出批次</span>
            <select v-model="selectedRunId" aria-label="选择输出批次">
              <option v-for="r in templateRuns" :key="r.id" :value="r.id">
                {{ new Date(r.createdAt).toLocaleString() }} · {{ labels[r.status] }} · {{ r.counts.total }} 条
              </option>
            </select>
          </label>
      <section v-if="run.status === 'PENDING_RENDER' || active" class="render-settings" aria-label="成片输出设置">
        <div class="render-settings__copy">
          <span class="settings-icon"><Film :size="18" /></span>
          <div>
            <h3>成片输出设置</h3>
            <p v-if="run.status === 'PENDING_RENDER'">设置仅作用于左侧选中的模板；导出后将渲染 {{ run.counts.total }} 条成片</p>
            <p v-else>正在渲染所选模板的成片，参数已冻结</p>
          </div>
        </div>
        <label>
          <span>分辨率</span>
          <select v-model="resolution" :disabled="busy || active" aria-label="成片分辨率">
            <option value="480p">480P</option><option value="720p">720P</option><option value="1080p">1080P</option>
            <option value="2K">2K</option><option value="4K">4K</option>
          </select>
        </label>
        <label>
          <span>帧率</span>
          <select v-model.number="frameRate" :disabled="busy || active" aria-label="成片帧率">
            <option :value="24">24 fps</option><option :value="25">25 fps</option><option :value="30">30 fps</option><option :value="50">50 fps</option><option :value="60">60 fps</option>
          </select>
        </label>
        <button class="primary-button export-button" type="button" :disabled="busy || active" @click="startRender">
          <LoaderCircle v-if="busy || active" class="spin" :size="15" />
          <Play v-else :size="15" />{{ busy ? '正在创建任务…' : active ? `渲染中 ${run.counts.completed}/${run.counts.total}` : `导出成片（${run.counts.total}）` }}
        </button>
      </section>
      <section v-else class="frozen-settings" aria-label="当前渲染规格">
        <span>输出规格：<strong>{{ run.resolution }} · {{ run.frameRate }} fps</strong></span>
      </section>
      <section v-if="run.status !== 'PENDING_RENDER'" class="batch-panel" aria-label="批次输出进度">
        <div class="batch-panel__heading">
          <div>
            <span class="eyebrow">成片渲染进度</span>
            <strong class="batch-status" :class="statusTone(run.status)">
              <i></i>{{ labels[run.status] }}
            </strong>
          </div>
          <button
            v-if="active"
            class="secondary-button danger-button"
            type="button"
            :disabled="busy"
            @click="command('cancel')"
          >
            取消剩余输出
          </button>
          <button
            v-else-if="run.counts.failed"
            class="primary-button"
            type="button"
            :disabled="busy"
            @click="command('retry')"
          >
            <RefreshCw :size="14" />恢复失败项
          </button>
        </div>
        <div class="batch-progress-line">
          <progress :value="progress" max="100" :aria-label="`本批生成进度 ${progress}%`" />
          <strong>{{ progress }}%</strong>
          <span>{{ run.counts.completed }} / {{ run.counts.total }} 条完成</span>
        </div>
        <div class="batch-counts">
          <div><span class="count-dot success"></span><span>已完成</span><strong>{{ run.counts.completed }}</strong></div>
          <div><span class="count-dot running"></span><span>渲染中</span><strong>{{ run.counts.running }}</strong></div>
          <div><span class="count-dot pending"></span><span>排队中</span><strong>{{ run.counts.queued }}</strong></div>
          <div><span class="count-dot danger"></span><span>失败/取消</span><strong>{{ run.counts.failed }}</strong></div>
        </div>
      </section>

      <section class="output-workspace" aria-labelledby="output-list-title">
        <header class="workspace-heading">
          <div>
            <h3 id="output-list-title">成片列表</h3>
            <p>在左侧选择模板，查看并播放该模板输出的成片</p>
          </div>
          <span class="result-count">第 {{ page }} / {{ pageCount }} 页 · 共 {{ run.counts.total }} 条</span>
        </header>
        <div v-if="items.length" class="output-grid">
          <article
            v-for="item in items"
            :key="item.id"
            class="output-card"
            :class="{ abnormal: item.status === 'FAILED' || item.status === 'CANCELLED' }"
          >
            <div class="output-preview" :class="statusTone(item.status)">
              <video
                v-if="item.fileObjectId"
                :src="fileUrl(item.fileObjectId)"
                controls
                preload="metadata"
                :aria-label="`${item.name} 成片播放`"
              />
              <template v-else>
                <Film :size="25" />
                <span>{{ labels[item.status] }}</span>
                <small v-if="run.status !== 'PENDING_RENDER'">{{ item.progress }}%</small>
                <small v-else>等待导出</small>
              </template>
            </div>
            <div class="output-info">
              <div class="output-card__title">
                <h4 :title="`${item.name}.mp4`">{{ item.name }}.mp4</h4>
                <span class="status-pill" :class="statusTone(item.status)">
                  {{ labels[item.status] }}
                </span>
              </div>
              <p class="output-meta">{{ item.duration.toFixed(1) }} 秒 · H.264 / AAC · 内嵌字幕</p>
              <div v-if="run.status !== 'PENDING_RENDER'" class="item-progress">
                <progress :value="item.progress" max="100" :aria-label="`${item.name} 进度`" />
                <strong>{{ item.progress }}%</strong>
              </div>
              <p v-if="item.errorMessage" class="item-error" role="status">
                <AlertCircle :size="13" />{{ item.errorMessage }}
              </p>
              <a
                v-if="item.fileObjectId"
                class="download-button"
                :href="fileUrl(item.fileObjectId) + '?download=true'"
                :download="`${item.name}.mp4`"
              ><Download :size="14" />下载成片</a>
            </div>
          </article>
        </div>
        <div v-else class="list-empty" role="status">
          <Film :size="22" />当前批次暂无成片条目
        </div>
        <nav v-if="run.items.length" class="prompt-pagination" aria-label="成片分页">
          <label class="prompt-page-size">
            <select v-model.number="pageSize" aria-label="每页显示成片数量" @change="page = 1">
              <option v-for="size in OUTPUT_PAGE_SIZE_OPTIONS" :key="size" :value="size">
                {{ size }} 条/页
              </option>
            </select>
          </label>
          <button type="button" :disabled="page <= 1" aria-label="上一页" @click="page -= 1">
            <ChevronLeft :size="14" />上一页
          </button>
          <strong>第 {{ page }} / {{ pageCount }} 页</strong>
          <button type="button" :disabled="page >= pageCount" aria-label="下一页" @click="page += 1">
            下一页<ChevronRight :size="14" />
          </button>
          <span>共 {{ run.counts.total }} 条</span>
        </nav>
      </section>
        </main>
      </div>
    </template>

    <footer class="output-footer">
      <button class="secondary-button" type="button" @click="$emit('back')">
        <ArrowLeft :size="14" />返回模板混剪
      </button>
      <span>步骤 6 / 6 · 失败恢复不会重渲染已成功的视频</span>
    </footer>
  </section>
</template>

<style scoped>
.final-output {
  --effect-blue: #2563eb;
  position: relative;
  margin-top: 18px;
  padding: 28px;
  color: #253047;
  background: #fff;
  border: 1px solid #dbe4f6;
  border-radius: 26px;
  box-shadow: 0 12px 34px #7a4e3b12;
}
.output-heading,
.output-heading__title,
.batch-panel__heading,
.batch-progress-line,
.workspace-heading,
.output-card__title,
.item-progress,
.prompt-pagination,
.output-footer {
  display: flex;
  align-items: center;
  min-width: 0;
}
.output-heading {
  min-height: 50px;
  margin-bottom: 22px;
  justify-content: space-between;
  gap: 18px;
}
.output-heading__title {
  gap: 14px;
}
.step {
  display: grid;
  width: 44px;
  height: 44px;
  flex: 0 0 44px;
  place-items: center;
  color: #d67b16;
  background: #fff5e7;
  border-radius: 14px;
  font-size: 13px;
  font-weight: 900;
}
.output-heading h2,
.output-heading p {
  margin: 0;
}
.output-heading h2 {
  color: #172033;
  font-size: 21px;
}
.output-heading p {
  margin-top: 5px;
  color: #7d899d;
  font-size: 13px;
}
.output-layout {
  position: sticky;
  top: 12px;
  display: grid;
  height: calc(100vh - 190px);
  min-height: 500px;
  grid-template-columns: minmax(220px, 250px) minmax(0, 1fr);
  align-items: stretch;
  gap: 18px;
}
.template-sidebar {
  position: sticky;
  top: 12px;
  display: grid;
  min-width: 0;
  min-height: 0;
  height: 100%;
  max-height: 100%;
  padding: 16px;
  grid-template-rows: auto minmax(0, 1fr);
  gap: 12px;
  background: #fbfcfe;
  border: 1px solid #dfe7f4;
  border-radius: 16px;
}
.template-sidebar__heading {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.template-sidebar__heading h3 {
  margin: 0;
  color: #172033;
  font-size: 20px;
  font-weight: 800;
}
.template-sidebar__heading > span {
  color: #7d899d;
  font-size: 11px;
}
.template-list {
  display: grid;
  min-height: 0;
  align-content: start;
  grid-auto-rows: 72px;
  overflow-y: auto;
  gap: 8px;
}
.output-main {
  display: flex;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  overflow-y: auto;
  scrollbar-gutter: stable;
}
.template-card {
  display: flex;
  min-width: 0;
  min-height: 72px;
  padding: 12px;
  align-items: flex-start;
  justify-content: flex-start;
  gap: 11px;
  text-align: left;
  border-color: #dbe4f6;
  border-radius: 12px;
  transition: 0.16s ease;
}
.template-card > svg {
  flex: 0 0 auto;
  margin-top: 2px;
  color: #29384f;
}
.template-card__copy {
  display: grid;
  min-width: 0;
  gap: 4px;
}
.template-card__copy strong {
  overflow: hidden;
  color: #172033;
  font-size: 14px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.template-card__copy small {
  color: #7d899d;
  font-size: 10px;
  font-weight: 500;
}
.template-card:hover {
  border-color: #9dbbfa;
}
.template-card.selected {
  color: #2563eb;
  background: #eff5ff;
  border-color: #8bb1ff;
  box-shadow: 0 0 0 2px #2563eb12;
}
.template-card.selected > svg,
.template-card.selected strong {
  color: #2563eb;
}
.batch-select {
  display: grid;
  width: min(360px, 100%);
  margin-bottom: 14px;
  gap: 6px;
  color: #506078;
  font-size: 11px;
  font-weight: 700;
}
.batch-select select {
  width: 100%;
  min-width: 0;
  min-height: 38px;
  padding: 0 10px;
}
button,
select,
a {
  font: inherit;
  font-size: 12px;
  border: 1px solid #dbe4f6;
  border-radius: 10px;
  background: white;
  color: #42526a;
}
.secondary-button,
.primary-button,
.download-button {
  display: inline-flex;
  min-height: 38px;
  padding: 0 14px;
  align-items: center;
  justify-content: center;
  gap: 5px;
  cursor: pointer;
  text-decoration: none;
  font-weight: 700;
}
.secondary-button:hover,
.download-button:hover {
  border-color: #a9c1ef;
  color: #2563eb;
}
.primary-button {
  color: #fff;
  background: var(--effect-blue);
  border-color: var(--effect-blue);
  box-shadow: 0 8px 18px #2563eb2e;
}
.spin {
  animation: spin 1s linear infinite;
}
@keyframes spin {
  to { transform: rotate(360deg); }
}
.danger-button {
  color: #b6404e;
  border-color: #efc2c0;
}
button:disabled,
select:disabled {
  opacity: 0.52;
  cursor: not-allowed;
}
.notice {
  display: flex;
  margin-bottom: 14px;
  padding: 12px 14px;
  align-items: center;
  gap: 9px;
  color: #a84148;
  background: #fff3f2;
  border: 1px solid #f3c6c4;
  border-radius: 10px;
  font-size: 12px;
}
.notice > span {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}
.demo-notice {
  display: flex;
  margin-bottom: 14px;
  padding: 11px 14px;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  color: #526078;
  background: #fffaf0;
  border: 1px solid #f0dfbd;
  border-radius: 10px;
  font-size: 11px;
}
.demo-notice strong {
  color: #a66b16;
}
progress {
  width: 100%;
  height: 8px;
  accent-color: var(--effect-blue);
}
.page-state {
  display: flex;
  min-height: 360px;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  color: #7f8da2;
  text-align: center;
  gap: 10px;
}
.state-icon {
  display: grid;
  width: 48px;
  height: 48px;
  place-items: center;
  color: var(--effect-blue);
  background: #eaf2ff;
  border-radius: 15px;
}
.page-state h3 {
  margin: 2px 0 0;
  color: #34445c;
  font-size: 17px;
}
.page-state p {
  max-width: 560px;
  margin: 0;
  font-size: 12px;
  line-height: 1.7;
}
.loading-icon {
  animation: pulse 1.2s ease-in-out infinite alternate;
}
@keyframes pulse {
  to { opacity: 0.45; transform: scale(0.94); }
}
.batch-panel {
  padding: 17px 18px;
  background: linear-gradient(135deg, #f8fbff 0%, #fffaf7 100%);
  border: 1px solid #dce6f5;
  border-radius: 16px;
}
.render-settings,
.frozen-settings {
  display: flex;
  margin-bottom: 14px;
  padding: 16px;
  align-items: end;
  gap: 14px;
  background: linear-gradient(110deg, #f7faff, #fffaf5);
  border: 1px solid #dce6f5;
  border-radius: 14px;
}
.render-settings__copy {
  display: flex;
  min-width: 220px;
  flex: 1;
  align-items: center;
  gap: 10px;
}
.settings-icon {
  display: grid;
  width: 38px;
  height: 38px;
  flex: 0 0 38px;
  place-items: center;
  color: #2563eb;
  background: #eaf2ff;
  border-radius: 11px;
}
.render-settings h3,
.render-settings p { margin: 0; }
.render-settings h3 { color: #29384f; font-size: 13px; }
.render-settings p { margin-top: 4px; color: #7d899d; font-size: 11px; }
.render-settings p strong { color: #42526a; }
.render-settings label {
  display: grid;
  width: 132px;
  gap: 5px;
  color: #53627a;
  font-size: 10px;
  font-weight: 700;
}
.render-settings select { width: 100%; min-height: 38px; padding: 0 10px; }
.export-button { min-width: 152px; min-height: 40px; }
.frozen-settings {
  min-height: 48px;
  align-items: center;
  color: #718096;
  font-size: 11px;
}
.frozen-settings strong { color: #34445c; }
.batch-panel__heading {
  justify-content: space-between;
  gap: 12px;
}
.batch-panel__heading > div {
  display: flex;
  align-items: center;
  gap: 12px;
}
.eyebrow {
  color: #7b8aa1;
  font-size: 11px;
}
.batch-status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: #5f7cae;
  font-size: 13px;
}
.batch-status i,
.count-dot {
  width: 8px;
  height: 8px;
  flex: 0 0 8px;
  background: currentColor;
  border-radius: 50%;
}
.batch-status.success,
.count-dot.success { color: #15956f; }
.batch-status.running,
.count-dot.running { color: #3d78d8; }
.batch-status.pending,
.count-dot.pending { color: #7c8ba2; }
.batch-status.danger,
.count-dot.danger { color: #d14d56; }
.batch-progress-line {
  margin-top: 16px;
  gap: 12px;
  color: #718096;
  font-size: 11px;
}
.batch-progress-line progress {
  flex: 1;
}
.batch-progress-line strong {
  color: #2563eb;
  font-size: 12px;
}
.batch-counts {
  display: grid;
  margin-top: 15px;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
}
.batch-counts > div {
  display: flex;
  min-width: 0;
  padding: 10px 12px;
  align-items: center;
  gap: 8px;
  color: #718096;
  background: #ffffffc9;
  border: 1px solid #e5ebf4;
  border-radius: 10px;
  font-size: 11px;
}
.batch-counts strong {
  margin-left: auto;
  color: #34445c;
  font-size: 14px;
}
.output-workspace {
  display: flex;
  min-height: 0;
  flex: 1 1 auto;
  flex-direction: column;
  margin-top: 15px;
  overflow: hidden;
  background: #fff;
  border: 1px solid #e1e6ee;
  border-radius: 16px;
}
.workspace-heading {
  min-height: 68px;
  padding: 13px 16px;
  justify-content: space-between;
  gap: 12px;
  border-bottom: 1px solid #edf0f5;
}
.workspace-heading h3,
.workspace-heading p {
  margin: 0;
}
.workspace-heading h3 {
  color: #29384f;
  font-size: 14px;
}
.workspace-heading p,
.result-count {
  margin-top: 4px;
  color: #7d899d;
  font-size: 11px;
}
.result-count {
  margin: 0;
  white-space: nowrap;
}
.output-grid {
  display: grid;
  min-height: 0;
  flex: 1 1 auto;
  align-content: start;
  overflow-y: auto;
  padding: 12px;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 11px;
}
.output-card {
  min-width: 0;
  overflow: hidden;
  background: #fff;
  border: 1px solid #e1e6ee;
  border-radius: 12px;
  transition: 0.18s ease;
}
.output-card:hover {
  border-color: #aac2f2;
  box-shadow: 0 8px 18px #315c9c13;
  transform: translateY(-1px);
}
.output-card.abnormal {
  border-color: #f0b9b3;
}
.output-preview {
  position: relative;
  display: flex;
  width: 100%;
  aspect-ratio: 9 / 16;
  max-height: 310px;
  min-height: 155px;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  overflow: hidden;
  gap: 8px;
  color: #617fae;
  background: linear-gradient(135deg, #edf3fa, #e4ecf6);
  font-size: 11px;
}
.output-preview.running,
.output-preview.pending {
  color: #fff;
  background: linear-gradient(135deg, #5f7cae, #7ea6df);
}
.output-preview.danger {
  color: #fff;
  background: linear-gradient(135deg, #be4f55, #e2786d);
}
.output-preview video {
  width: 100%;
  height: 100%;
  object-fit: contain;
  background: #111827;
}
.output-preview small {
  position: absolute;
  right: 8px;
  bottom: 7px;
  padding: 3px 6px;
  color: #fff;
  background: #1720339c;
  border-radius: 5px;
  font-size: 10px;
}
.output-info {
  min-width: 0;
  padding: 11px 12px 12px;
}
.output-card__title {
  justify-content: space-between;
  gap: 7px;
}
.output-card__title h4 {
  min-width: 0;
  margin: 0;
  overflow: hidden;
  color: #253047;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.status-pill {
  flex: 0 0 auto;
  padding: 3px 7px;
  color: #64748b;
  background: #f1f5f9;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 700;
}
.status-pill.success { color: #168365; background: #eaf8f2; }
.status-pill.running { color: #2563eb; background: #edf4ff; }
.status-pill.danger { color: #bc4b50; background: #fff0ef; }
.output-meta {
  margin: 6px 0 0;
  color: #8490a4;
  font-size: 10px;
}
.item-progress {
  margin-top: 9px;
  gap: 8px;
}
.item-progress progress {
  height: 6px;
}
.item-progress strong {
  color: #526078;
  font-size: 10px;
}
.item-error {
  display: flex;
  margin: 8px 0 0;
  align-items: flex-start;
  gap: 5px;
  color: #b42318;
  font-size: 10px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.item-error svg {
  flex: 0 0 auto;
  margin-top: 1px;
}
.download-button {
  width: 100%;
  min-height: 34px;
  margin-top: 9px;
  color: #2563eb;
  border-color: #dbe4f6;
  border-radius: 9px;
  font-size: 11px;
}
.list-empty {
  display: flex;
  min-height: 180px;
  align-items: center;
  justify-content: center;
  gap: 9px;
  color: #8490a4;
  font-size: 12px;
}
.prompt-pagination {
  min-height: 61px;
  margin-top: 2px;
  padding: 10px 14px;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 10px;
  color: #7d899d;
  border-top: 1px solid #f0f2f5;
  font-size: 12px;
}
.prompt-page-size select,
.prompt-pagination button {
  display: inline-flex;
  min-height: 40px;
  padding: 0 12px;
  align-items: center;
  justify-content: center;
  gap: 4px;
  color: #5b6679;
  background: #fff;
  border: 1px solid #dfe5ed;
  border-radius: 10px;
}
.prompt-page-size select {
  min-width: 108px;
  cursor: pointer;
}
.prompt-pagination button:disabled {
  color: #a5adba;
  background: #f8fafc;
  cursor: not-allowed;
}
.prompt-pagination strong {
  color: #43536c;
  font-size: 12px;
  white-space: nowrap;
}
.output-footer {
  margin-top: 14px;
  justify-content: space-between;
  gap: 12px;
  color: #7d899d;
  font-size: 11px;
}
@media (max-width: 1200px) {
  .output-layout {
    position: static;
    height: auto;
    min-height: 0;
    grid-template-columns: minmax(0, 1fr);
    align-items: start;
  }
  .template-sidebar {
    position: static;
    min-height: 0;
    height: auto;
    max-height: none;
  }
  .template-list {
    overflow: visible;
    grid-auto-rows: 72px;
    grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
  }
  .output-main {
    min-height: 0;
    overflow: visible;
  }
  .output-workspace {
    min-height: 0;
    flex: initial;
  }
  .output-grid {
    overflow: visible;
  }
}
@media (max-width: 900px) {
  .final-output {
    padding: 22px;
    border-radius: 22px;
  }
  .output-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
  .batch-counts {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
@media (max-width: 680px) {
  .final-output {
    margin-top: 12px;
    padding: 18px;
    border-radius: 20px;
  }
  .output-heading,
  .output-heading__title,
  .workspace-heading,
  .output-footer {
    align-items: flex-start;
    flex-direction: column;
  }
  .batch-select {
    width: 100%;
  }
  .render-settings {
    align-items: stretch;
    flex-wrap: wrap;
  }
  .render-settings__copy { flex-basis: 100%; }
  .render-settings label { flex: 1; }
  .export-button { flex: 1 1 100%; }
  .frozen-settings { align-items: flex-start; flex-direction: column; }
  .batch-panel__heading {
    align-items: flex-start;
  }
  .batch-panel__heading > div {
    align-items: flex-start;
    flex-direction: column;
    gap: 5px;
  }
  .batch-progress-line {
    flex-wrap: wrap;
  }
  .batch-progress-line progress {
    flex-basis: 100%;
    order: 2;
  }
  .batch-counts {
    gap: 7px;
  }
  .batch-counts > div {
    padding: 9px;
    gap: 6px;
  }
  .result-count {
    white-space: normal;
  }
  .output-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    padding: 9px;
    gap: 8px;
  }
  .output-preview {
    min-height: 130px;
    max-height: 250px;
  }
  .output-info {
    padding: 9px;
  }
  .output-card__title {
    align-items: flex-start;
    flex-direction: column;
  }
  .prompt-pagination {
    justify-content: center;
  }
  .output-layout {
    gap: 12px;
  }
  .output-footer > * {
    width: 100%;
  }
}
@media (max-width: 480px) {
  .output-grid {
    grid-template-columns: 1fr;
  }
  .output-preview {
    max-height: 360px;
  }
  .batch-counts > div {
    font-size: 10px;
  }
  .notice {
    align-items: flex-start;
    flex-wrap: wrap;
  }
  .demo-notice {
    align-items: flex-start;
    flex-direction: column;
  }
  .notice .secondary-button {
    margin-left: 25px;
  }
}
</style>
