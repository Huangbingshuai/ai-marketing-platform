<script setup lang="ts">
import { computed, onActivated, onDeactivated, onBeforeUnmount, ref, watch } from 'vue';
import { AlertCircle, ArrowLeft, Download, Film, RefreshCw } from '@lucide/vue';
import type { ApiResponse, FinalOutputRun } from '@ai-marketing/contracts';
import { apiUrl, requestJson } from '../../../api/http-client';

const props = defineProps<{ projectId: string; workflowRunId: string }>();
defineEmits<{ back: [] }>();
const runs = ref<FinalOutputRun[]>([]), selectedRun = ref(''), page = ref(1);
const loading = ref(true), busy = ref(false), error = ref('');
const run = computed(() => runs.value.find((r) => r.id === selectedRun.value) ?? runs.value[0]);
const active = computed(() => run.value && ['QUEUED', 'RUNNING'].includes(run.value.status));
const pageCount = computed(() => Math.max(1, Math.ceil((run.value?.items.length ?? 0) / 12)));
const items = computed(() => run.value?.items.slice((page.value - 1) * 12, page.value * 12) ?? []);
const progress = computed(() => run.value?.items.length ? Math.floor(run.value.items.reduce((sum, item) => sum + item.progress, 0) / run.value.items.length) : 0);
const labels: Record<string, string> = { QUEUED: '排队中', RUNNING: '渲染中', COMPLETED: '已完成', FAILED: '失败', PARTIAL: '部分完成', CANCELLED: '已取消' };
const base = computed(() => `/projects/${props.projectId}/workflows/effect/final-output`);
const fileUrl = (id: string) => apiUrl(`/projects/${props.projectId}/file-objects/${id}/content`);
let timer: ReturnType<typeof setTimeout> | undefined;
let controller: AbortController | undefined;
let generation = 0, mounted = true;
async function refresh() {
  const current = ++generation;
  controller?.abort(); controller = new AbortController(); clearTimeout(timer);
  try {
    const result = await requestJson<ApiResponse<FinalOutputRun[]>>(`${base.value}?workflowRunId=${props.workflowRunId}`, { operation: '读取成片输出', signal: controller.signal });
    if (current !== generation) return;
    runs.value = result.data; error.value = '';
    if (!runs.value.some((r) => r.id === selectedRun.value)) selectedRun.value = runs.value[0]?.id ?? '';
  } catch (reason) {
    if (current === generation && !(reason instanceof DOMException && reason.name === 'AbortError')) error.value = reason instanceof Error ? reason.message : '读取输出失败';
  } finally {
    if (current === generation) { loading.value = false; if (mounted) timer = setTimeout(() => void refresh(), 4000); }
  }
}
async function command(action: 'retry' | 'cancel') {
  if (!run.value || busy.value) return;
  busy.value = true;
  try { await requestJson(`${base.value}/${run.value.id}/${action}`, { method: 'POST', operation: action === 'retry' ? '恢复失败输出' : '取消输出' }); await refresh(); }
  catch (reason) { error.value = reason instanceof Error ? reason.message : '输出操作失败'; }
  finally { busy.value = false; }
}
function stop() { mounted = false; ++generation; controller?.abort(); clearTimeout(timer); }
watch(() => [props.projectId, props.workflowRunId], () => { runs.value = []; selectedRun.value = ''; loading.value = true; page.value = 1; void refresh(); }, { immediate: true });
watch(selectedRun, () => { page.value = 1; });
onActivated(() => { mounted = true; void refresh(); });
onDeactivated(stop); onBeforeUnmount(stop);
</script>

<template>
  <section class="final-output" aria-label="成片输出">
    <header class="output-header">
      <span class="step">06</span>
      <div><h2>成片生成与批量导出</h2><p>只渲染已统一确认的画面、口播、配乐与字幕；成功视频自动保存到项目资产。</p></div>
      <select v-if="runs.length > 1" v-model="selectedRun" aria-label="选择输出批次"><option v-for="r in runs" :key="r.id" :value="r.id">{{ new Date(r.createdAt).toLocaleString() }} · {{ r.counts.total }} 条</option></select>
    </header>
    <div v-if="error" class="notice" role="alert"><AlertCircle :size="18" />{{ error }}<button @click="refresh">重新读取</button></div>
    <div v-if="loading" class="empty" role="status">正在读取成片输出…</div>
    <div v-else-if="!run" class="empty"><Film :size="36" /><h3>暂无已确认的输出任务</h3><p>请回到模板混剪，待全部成片包装成功后，点击“完成校验并进入成片输出”。</p><button @click="$emit('back')">返回模板混剪</button></div>
    <template v-else>
      <div class="output-toolbar" role="status">
        <strong>{{ labels[run.status] }} · {{ run.counts.completed }} / {{ run.counts.total }} 条</strong>
        <span>排队 {{ run.counts.queued }} · 运行 {{ run.counts.running }} · 失败/取消 {{ run.counts.failed }}</span>
        <progress :value="progress" max="100" :aria-label="`本批生成进度 ${progress}%`" /><span>{{ progress }}%</span>
        <button v-if="active" :disabled="busy" @click="command('cancel')">取消剩余输出</button>
        <button v-else-if="run.counts.failed" :disabled="busy" @click="command('retry')"><RefreshCw :size="15" />恢复失败项</button>
      </div>
      <div class="output-grid">
        <article v-for="item in items" :key="item.id" class="output-card">
          <video v-if="item.fileObjectId" :src="fileUrl(item.fileObjectId)" controls preload="metadata" :aria-label="`${item.name} 成片播放`" />
          <div v-else class="thumbnail"><Film :size="30" /><span>{{ labels[item.status] }}</span></div>
          <div class="output-info"><h3>{{ item.name }}.mp4</h3><small>{{ item.duration.toFixed(1) }} 秒 · H.264 / AAC · 内嵌字幕</small>
            <div class="item-state"><span>{{ labels[item.status] }}</span><strong>{{ item.progress }}%</strong></div>
            <progress :value="item.progress" max="100" :aria-label="`${item.name} 进度`" />
            <p v-if="item.errorMessage" class="item-error">{{ item.errorMessage }}</p>
            <a v-if="item.fileObjectId" :href="fileUrl(item.fileObjectId) + '?download=true'" :download="`${item.name}.mp4`"><Download :size="14" />下载成片</a>
          </div>
        </article>
      </div>
      <nav class="pagination" aria-label="输出分页"><button :disabled="page <= 1" @click="page--">上一页</button><span>{{ page }} / {{ pageCount }} · 共 {{ run.counts.total }} 条</span><button :disabled="page >= pageCount" @click="page++">下一页</button></nav>
    </template>
    <footer><button @click="$emit('back')"><ArrowLeft :size="15" />返回模板混剪</button><span>步骤 6 / 6 · 失败恢复不会重渲染已成功的视频</span></footer>
  </section>
</template>

<style scoped>
.final-output{padding:14px;border:1px solid #e0e7ef;background:#f7f9fe;border-radius:20px;color:#24354f}
.output-header,.output-toolbar,footer,.pagination{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:14px;background:white;border:1px solid #e0e7ef;border-radius:12px;margin-bottom:12px}
.step{background:#eaf1ff;color:#2563eb;font-weight:800;border-radius:12px;padding:14px}.output-header h2{font-size:18px;margin:0}.output-header p{font-size:12px;color:#718096;margin:6px 0 0}.output-header select{margin-left:auto;max-width:100%}
button,select,a{font:inherit;font-size:12px;border:1px solid #d3ddea;border-radius:8px;background:white;color:#2563eb;padding:8px 12px}button,a{display:inline-flex;align-items:center;gap:5px;cursor:pointer;text-decoration:none}button:disabled{opacity:.45;cursor:not-allowed}.output-toolbar{font-size:12px}.output-toolbar>progress{margin-left:auto;width:180px}
progress{height:8px;accent-color:#2563eb;max-width:100%}.output-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.output-card{display:flex;gap:12px;padding:14px;border:1px solid #c9d9ef;border-radius:14px;background:white;min-width:0}video,.thumbnail{width:150px;height:140px;flex-shrink:0;object-fit:contain;background:#edf2f8;border-radius:9px}.thumbnail{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;color:#8092ac;font-size:12px}.output-info{flex:1;min-width:0}.output-info h3{font-size:14px;margin:3px 0 8px;overflow-wrap:anywhere}.output-info small{color:#718096;font-size:11px}.output-info progress{width:100%;margin:8px 0}.item-state{display:flex;justify-content:space-between;font-size:12px;color:#2563eb;margin-top:10px}.item-error,.notice{color:#b42318;font-size:12px;overflow-wrap:anywhere}.notice{display:flex;gap:8px;align-items:center;padding:12px;background:#fff5f5;border-radius:10px;margin-bottom:12px}.empty{display:flex;min-height:280px;align-items:center;justify-content:center;flex-direction:column;text-align:center;gap:10px}.empty p{max-width:600px;color:#718096;font-size:13px}.pagination{justify-content:center;margin-top:12px;font-size:12px}footer{margin-bottom:0;justify-content:space-between;font-size:12px;color:#718096}
@media(max-width:1000px){.output-grid{grid-template-columns:1fr}}@media(max-width:600px){.output-card{flex-direction:column}video,.thumbnail{width:100%;height:200px}.output-toolbar>progress{margin-left:0}}
</style>
