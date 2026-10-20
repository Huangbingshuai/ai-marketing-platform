<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { Play, Download, Sparkles, RotateCcw, Trash2 } from '@lucide/vue';
import type { CloneMockState, CloneResult } from './clone-mock';
import { resultSignature } from './clone-mock';
const props = defineProps<{ state: CloneMockState; blocked: boolean }>();
const emit = defineEmits<{
  generate: [count: number, fail: boolean];
  retry: [item: CloneResult];
  remove: [ids: string[]];
  export: [items: CloneResult[]];
  details: [item: CloneResult];
  preview: [item: CloneResult];
}>();
const count = ref(6),
  failure = ref(false),
  selected = ref<string[]>([]),
  page = ref(1),
  pageSize = ref(6),
  filter = ref('all');
const filtered = computed(() =>
  props.state.results.filter(
    (i) =>
      filter.value === 'all' || (filter.value === 'stale' ? stale(i) : i.status === filter.value),
  ),
);
const pages = computed(() => Math.max(1, Math.ceil(filtered.value.length / pageSize.value)));
watch(pages, (p) => {
  page.value = Math.min(page.value, p);
});
const visible = computed(() =>
  filtered.value.slice((page.value - 1) * pageSize.value, page.value * pageSize.value),
);
const chosen = computed(() => props.state.results.filter((i) => selected.value.includes(i.id)));
const pageAll = computed(
  () => !!visible.value.length && visible.value.every((i) => selected.value.includes(i.id)),
);
const running = computed(() => props.state.results.some((i) => i.status === 'running'));
function stale(item: CloneResult) {
  return item.snapshot !== resultSignature(props.state);
}
function togglePage() {
  const ids = visible.value.map((i) => i.id);
  selected.value = pageAll.value
    ? selected.value.filter((id) => !ids.includes(id))
    : [...new Set([...selected.value, ...ids])];
}
</script>
<template>
  <div class="clone-output">
    <div v-if="blocked" class="frg-note warn">
      当前输入尚未确认或已变化，请返回上游确认素材、拆解报告和元素映射后再生成。
    </div>
    <section class="fco-summary">
      <div class="fco-summary-copy">
        <b>本批成片 {{ state.results.length }} 条</b
        ><span>锁定参考结构与映射快照，直接批量生成；全部结果为本地 Mock。</span>
      </div>
      <div class="fco-summary-actions">
        <label class="clone-quantity"
          >生成数量<input
            v-model.number="count"
            type="number"
            min="1"
            max="100"
            step="1"
            aria-label="生成数量" /></label
        ><button
          class="fco-btn primary"
          :disabled="blocked || running"
          @click="emit('generate', count, failure)"
        >
          <Sparkles :size="14" />{{ running ? '成片生成中…' : '生成复刻成片' }}</button
        ><button
          class="fco-btn"
          :disabled="!chosen.length || chosen.some((i) => i.status !== 'done')"
          @click="emit('export', chosen)"
        >
          <Download :size="14" />导出演示清单（{{ chosen.length }}）
        </button>
      </div>
    </section>
    <div class="clone-simulation">
      <label><input v-model="failure" type="checkbox" />模拟首条生成失败</label
      ><span>演示结果提供封面和任务信息，无真实生成视频文件。</span>
    </div>
    <section class="fco-panel">
      <div class="fco-toolbar">
        <label
          ><input
            type="checkbox"
            :checked="pageAll"
            :disabled="!visible.length"
            @change="togglePage"
          />全选本页</label
        ><button
          class="fco-btn"
          :disabled="!state.results.length"
          @click="selected = state.results.map((i) => i.id)"
        >
          全选全部</button
        ><button class="fco-btn" :disabled="!chosen.length" @click="selected = []">取消选择</button
        ><span class="count">已选 {{ chosen.length }} / {{ state.results.length }} 条</span
        ><button
          class="fco-btn danger"
          :disabled="!chosen.length"
          @click="
            emit(
              'remove',
              chosen.map((i) => i.id),
            )
          "
        >
          删除所选</button
        ><span class="grow" /><select v-model="filter" aria-label="筛选任务状态" @change="page = 1">
          <option value="all">全部状态</option>
          <option value="done">已完成</option>
          <option value="running">生成中</option>
          <option value="failed">生成失败</option>
          <option value="stale">待更新</option>
        </select>
      </div>
      <div class="fco-list">
        <article
          v-for="item in visible"
          :key="item.id"
          class="fco-card"
          :class="{ selected: selected.includes(item.id) }"
        >
          <input
            v-model="selected"
            type="checkbox"
            :value="item.id"
            :aria-label="`选择${item.name}`"
          /><button
            class="fco-thumb"
            :disabled="item.status !== 'done'"
            :aria-label="`预览${item.name}`"
            @click="emit('preview', item)"
          >
            <span><Play :size="17" /></span><small>00:32</small>
          </button>
          <div class="fco-main">
            <div class="fco-name-row">
              <strong :title="item.name">{{ item.name }}</strong
              ><span
                class="fco-status"
                :class="stale(item) ? 'pending' : item.status === 'done' ? '' : item.status"
                >{{
                  stale(item)
                    ? '待更新'
                    : item.status === 'done'
                      ? '已完成'
                      : item.status === 'failed'
                        ? '生成失败'
                        : '生成中'
                }}</span
              >
            </div>
            <div class="fco-meta">9:16 · 1080P · {{ item.createdAt }}</div>
            <div class="fco-lineage"><span>MOCK</span><b>继承原片结构 · 6 个节奏点</b></div>
            <div class="fco-tags">
              <span class="selling">广式腊肠</span><span>产品替换</span><span>结构锁定</span>
            </div>
            <div v-if="item.note" class="fco-revision-note">修改意见：{{ item.note }}</div>
            <div v-if="item.status === 'failed'" class="fco-revision-note">
              模拟生成失败，可重试恢复
            </div>
            <div class="fco-card-progress">
              <span>生成进度</span>
              <div class="bar"><i :style="{ width: item.progress + '%' }" /></div>
              <b>{{ item.progress }}%</b>
            </div>
          </div>
          <div class="fco-actions">
            <button @click="emit('details', item)">查看映射快照</button
            ><button :disabled="blocked || item.status === 'running'" @click="emit('retry', item)">
              <RotateCcw :size="11" />{{
                item.status === 'failed' ? '失败重试' : '重新生成'
              }}</button
            ><button :disabled="item.status !== 'done'" @click="emit('export', [item])">
              导出清单</button
            ><button class="danger" @click="emit('remove', [item.id])">
              <Trash2 :size="11" />删除
            </button>
          </div>
        </article>
        <div v-if="!visible.length" class="fco-empty">
          <div>
            <Sparkles :size="30" /><b>{{
              state.results.length ? '没有匹配的成片' : '当前没有可交付成片'
            }}</b>
            <p>
              {{
                state.results.length
                  ? '切换状态筛选查看其他成片。'
                  : '确认元素映射后，设置数量开始生成。'
              }}
            </p>
          </div>
        </div>
      </div>
      <div class="fco-pager">
        <select v-model.number="pageSize" aria-label="每页数量" @change="page = 1">
          <option :value="6">6 条/页</option>
          <option :value="12">12 条/页</option></select
        ><button class="fco-btn text" :disabled="page <= 1" @click="page--">‹ 上一页</button
        ><span
          >第 <b>{{ page }}</b> / {{ pages }} 页</span
        ><button class="fco-btn text" :disabled="page >= pages" @click="page++">下一页 ›</button>
      </div>
    </section>
  </div>
</template>
