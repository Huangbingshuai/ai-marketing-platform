<script setup lang="ts">
import { computed, ref } from 'vue';
import { LockKeyhole, ArrowRight, Boxes, Check, Search, AlertTriangle } from '@lucide/vue';
import type { CloneMockState, CloneElement, CloneCandidate } from './clone-mock';
import { candidateFor, candidatesFor } from './clone-mock';
import { clonePrototypeFixture as fixture } from './clone-prototype.fixture';
import CloneIcon from './CloneIcon.vue';
import CloneDialog from './CloneDialog.vue';
const props = defineProps<{ state: CloneMockState }>();
const emit = defineEmits<{ import: [items: CloneCandidate[], sourceId: string] }>();
const selected = ref('SRC-PRODUCT'),
  tab = ref('assets'),
  query = ref(''),
  origin = ref('all'),
  page = ref(1);
const library = ref(false),
  folder = ref('食品复刻素材'),
  libraryQuery = ref(''),
  checked = ref<string[]>([]);
const previewAssetId = ref('');
const previewAsset = computed(() => libraryItems.value.find((i) => i.id === previewAssetId.value));
const source = computed(
  () => props.state.elements.find((e) => e.id === selected.value) ?? props.state.elements[0]!,
);
const target = computed(() => candidateFor(props.state, source.value));
const complete = (e: CloneElement) => e.strategy === 'retain' || !!candidateFor(props.state, e);
const stats = computed(() => ({
  complete: props.state.elements.filter(complete).length,
  retained: props.state.elements.filter((e) => e.strategy === 'retain').length,
  replaced: props.state.elements.filter((e) => e.strategy === 'replace' && complete(e)).length,
}));
const filtered = computed(() =>
  candidatesFor(props.state, source.value.type).filter(
    (item) =>
      (origin.value === 'all' || (origin.value === 'imported' ? !!item.source : !item.source)) &&
      [item.name, item.style, ...item.tags].join(' ').includes(query.value.trim()),
  ),
);
const pages = computed(() => Math.max(1, Math.ceil(filtered.value.length / 6)));
const visible = computed(() =>
  filtered.value.slice(
    (Math.min(page.value, pages.value) - 1) * 6,
    Math.min(page.value, pages.value) * 6,
  ),
);
const libraryItems = computed<CloneCandidate[]>(() =>
  Array.from({ length: 6 }, (_, i) => ({
    id: `library-${folder.value}-${source.value.type}-${i}`,
    type: source.value.type,
    name: `${folder.value} · ${source.value.name}方案 ${i + 1}`,
    tags: ['复刻', '同类型素材'],
    version: `v${(i % 3) + 1}`,
    style: ['商业写实', '自然暖光', '高识别'][i % 3]!,
    shots: '匹配当前关联镜头',
    score: 96 - i * 2,
    source: folder.value,
  })).filter((i) => i.name.includes(libraryQuery.value.trim())),
);
function choose(e: CloneElement) {
  selected.value = e.id;
  query.value = '';
  origin.value = 'all';
  page.value = 1;
}
function importAssets() {
  const items = libraryItems.value.filter((i) => checked.value.includes(i.id));
  emit('import', items, source.value.id);
  library.value = false;
  checked.value = [];
}
</script>
<template>
  <div class="frg-map-body">
    <section class="frg-lock-panel">
      <header class="frg-lock-head">
        <span><LockKeyhole :size="18" /></span>
        <div>
          <b>原视频结构时间线（锁定）</b
          ><small>映射只替换素材，不改变镜头顺序、阶段占比与 112 BPM 卡点</small>
        </div>
        <div class="frg-lock-meta">
          <em>00:32</em><em>6 个阶段</em><em>6 个节奏点</em
          ><strong class="frg-lock-status"><LockKeyhole :size="12" /> 结构已锁定</strong>
        </div>
      </header>
      <div class="frg-map-timeline">
        <div
          v-for="(s, i) in state.shots"
          :key="s.time"
          class="frg-map-stage"
          :style="{ flex: [3, 4, 5, 10, 6, 4][i] }"
        >
          <b>{{ s.title }}</b
          ><span>{{ s.time }} · 节奏点 {{ i + 1 }}</span>
        </div>
      </div>
    </section>
    <section class="fem-layout">
      <aside class="fem-sidebar">
        <header class="fem-sidebar-head"><b>原视频元素</b><small>一次编辑一项</small></header>
        <div class="fem-nav">
          <button
            v-for="e in state.elements"
            :key="e.id"
            class="fem-nav-card"
            :class="{ active: e.id === source.id }"
            @click="choose(e)"
          >
            <span class="fem-nav-icon"><CloneIcon :type="e.type" /></span
            ><span class="fem-nav-copy"
              ><strong>{{ e.name }}</strong
              ><span>{{
                e.strategy === 'retain'
                  ? '保留 · ' + e.original
                  : '替换 · ' + (candidateFor(state, e)?.name ?? '尚未选择')
              }}</span></span
            ><span class="fem-nav-meta"
              ><em :class="{ required: e.required }">{{ e.required ? '必换' : '可选' }}</em
              ><i :class="{ done: complete(e) }">{{
                e.strategy === 'retain' ? '已保留' : complete(e) ? '已映射' : '待映射'
              }}</i></span
            >
          </button>
        </div>
        <div class="fem-summary">
          <div class="fem-summary-head">
            <span>映射完整度</span><b>{{ Math.round((stats.complete / 6) * 100) }}%</b>
          </div>
          <div class="fem-summary-track">
            <i :style="{ width: (stats.complete / 6) * 100 + '%' }" />
          </div>
          <div class="fem-summary-grid">
            <span
              >必换完成 <b>{{ complete(state.elements[0]!) ? 1 : 0 }}/1</b></span
            ><span
              >可选替换 <b>{{ Math.max(0, stats.replaced - 1) }}</b></span
            ><span
              >保留原片 <b>{{ stats.retained }}</b></span
            ><span
              >待映射 <b>{{ 6 - stats.complete }}</b></span
            >
          </div>
        </div>
      </aside>
      <div class="fem-workspace">
        <header class="fem-workspace-head">
          <div class="fem-workspace-title">
            <strong>{{ source.name }}映射工作区</strong
            ><span>{{ source.original }} · {{ source.shots }} 个关联镜头</span>
          </div>
          <span class="fem-confidence">识别 {{ source.confidence }}%</span>
          <div class="fem-strategy">
            <button
              :class="{ active: source.strategy === 'replace' }"
              @click="source.strategy = 'replace'"
            >
              替换</button
            ><button
              :disabled="source.required"
              :class="{ active: source.strategy === 'retain' }"
              @click="source.strategy = 'retain'"
            >
              保留
            </button>
          </div>
        </header>
        <section class="fem-flow">
          <article class="fem-flow-card">
            <span class="fem-flow-visual"><CloneIcon :type="source.type" /></span>
            <div class="fem-flow-copy">
              <span>原视频识别元素</span><strong>{{ source.original }}</strong
              ><small>{{ source.shots }} 个关联镜头 · 置信度 {{ source.confidence }}%</small>
            </div>
          </article>
          <div class="fem-flow-arrow">
            <ArrowRight :size="19" /><small>{{
              source.strategy === 'retain' ? '保留' : '映射'
            }}</small>
          </div>
          <article
            class="fem-flow-card target"
            :class="{ empty: source.strategy === 'replace' && !target }"
          >
            <span class="fem-flow-visual"><CloneIcon :type="source.type" /></span>
            <div class="fem-flow-copy">
              <span>目标素材</span
              ><strong>{{
                source.strategy === 'retain' ? '保留原片' : (target?.name ?? '尚未选择目标素材')
              }}</strong
              ><small>{{
                source.strategy === 'retain'
                  ? '原素材、镜头与节奏保持不变'
                  : (target?.style ?? '请在候选素材页选择同类型资产')
              }}</small>
            </div>
          </article>
        </section>
        <nav class="fem-tabs">
          <button :class="{ active: tab === 'assets' }" @click="tab = 'assets'">候选素材</button
          ><button :class="{ active: tab === 'impact' }" @click="tab = 'impact'">镜头影响</button
          ><span class="grow" /><button class="frg-btn" @click="library = true">
            <Boxes :size="13" />从全局资产库导入
          </button>
        </nav>
        <div v-if="tab === 'assets'" class="fem-pane">
          <div v-if="source.strategy === 'retain'" class="fem-retain-empty">
            <div>
              <b>当前保留原片{{ source.name }}</b>
              <p>候选素材仍被保留，切换回“替换”即可继续选择。</p>
            </div>
          </div>
          <template v-else
            ><div class="fem-toolbar">
              <label class="clone-search"
                ><Search :size="14" /><input
                  v-model="query"
                  placeholder="搜索素材名称、标签或版本"
                  @input="page = 1" /></label
              ><select v-model="origin" class="fem-select" aria-label="素材来源" @change="page = 1">
                <option value="all">全部来源</option>
                <option value="project">当前项目</option>
                <option value="imported">已导入素材</option></select
              ><span class="fem-toolbar-note">共 {{ filtered.length }} 项同类型素材</span>
            </div>
            <div class="fem-candidate-grid">
              <button
                v-for="item in visible"
                :key="item.id"
                class="frg-target-card"
                :class="{ selected: item.id === source.targetId }"
                @click="source.targetId = item.id"
              >
                <span class="frg-target-thumb"><CloneIcon :type="source.type" /></span
                ><span class="frg-target-copy"
                  ><b :title="item.name">{{ item.name }}</b
                  ><small>{{ item.version }} · {{ item.style }}</small
                  ><small>适配：{{ item.shots }}</small
                  ><span class="frg-target-tags"
                    ><span v-for="tag in item.tags" :key="tag">{{ tag }}</span></span
                  ></span
                ><em class="frg-match-score">{{ item.score }}%</em
                ><span class="fem-origin">{{ item.source ? '导入副本' : '当前项目' }}</span>
              </button>
              <div v-if="!visible.length" class="frg-map-empty">
                <div>
                  <b>没有匹配的{{ source.name }}素材</b>
                  <p>调整搜索条件，或导入同类型素材。</p>
                </div>
              </div>
            </div>
            <div class="fem-pager">
              <button class="frg-btn" :disabled="page <= 1" @click="page--">上一页</button
              ><span>第 {{ Math.min(page, pages) }} / {{ pages }} 页</span
              ><button class="frg-btn" :disabled="page >= pages" @click="page++">下一页</button>
            </div>
          </template>
        </div>
        <div v-else class="fem-pane">
          <div class="fem-impact-label">
            <b>镜头影响与连续性策略</b><span>结构时间线始终锁定</span>
          </div>
          <div class="clone-impact-shots">
            <article v-for="shot in state.shots.slice(0, source.shots)" :key="shot.time">
              <b>{{ shot.time }} · {{ shot.title }}</b>
              <p>{{ shot.move }} · {{ shot.composition }}</p>
              <small>{{
                source.strategy === 'retain'
                  ? '保持原片元素与节奏'
                  : '替换为 ' + (target?.name ?? '待选择素材')
              }}</small>
            </article>
          </div>
          <div class="frg-warning-list">
            <article
              v-for="w in fixture.mappingWarnings.filter((w) => w.sourceId === source.id)"
              :key="w.title"
              class="frg-warning"
            >
              <AlertTriangle :size="15" />
              <div>
                <b>{{ w.title }}</b>
                <p>{{ w.text }}</p>
              </div>
            </article>
          </div>
        </div>
      </div>
    </section>
    <div v-if="!complete(state.elements[0]!)" class="fem-gate-note">
      产品属于必换元素：完成产品目标素材映射后，才能进入成片生成。
    </div>
    <CloneDialog
      v-if="library"
      :title="`全局资产库 · 导入${source.name}素材`"
      wide
      @close="library = false"
      ><p class="clone-muted">
        Mock 目录 · 单选导入自动建立映射，多选加入当前演示候选区，保留来源信息。
      </p>
      <div class="clone-library">
        <aside>
          <button
            v-for="f in ['食品复刻素材', '品牌视觉素材', '营销音画素材']"
            :key="f"
            class="frg-btn"
            :class="{ primary: folder === f }"
            @click="
              folder = f;
              checked = [];
            "
          >
            <Boxes :size="15" />{{ f }}
          </button>
        </aside>
        <section class="clone-library-browser">
          <label class="clone-search"
            ><Search :size="15" /><input v-model="libraryQuery" placeholder="按名称搜索素材"
          /></label>
          <div class="clone-library-grid">
            <label
              v-for="item in libraryItems"
              :key="item.id"
              :class="{ selected: checked.includes(item.id) }"
              ><input v-model="checked" type="checkbox" :value="item.id" />
              <button
                class="clone-library-contact"
                :aria-label="`预览${item.name}`"
                @click.prevent="previewAssetId = item.id"
              >
                <CloneIcon :type="source.type" :size="30" /><span>预览素材</span></button
              ><b>{{ item.name }}</b
              ><small>{{ item.version }} · {{ item.style }}</small
              ><span>来源：{{ item.source }}</span></label
            >
            <p v-if="!libraryItems.length">没有匹配素材</p>
          </div>
        </section>
        <aside class="fem-library-detail">
          <template v-if="previewAsset"
            ><div class="clone-library-contact large">
              <CloneIcon :type="source.type" :size="45" />
            </div>
            <h4>{{ previewAsset.name }}</h4>
            <p class="clone-muted">{{ previewAsset.style }}</p>
            <div class="clone-snapshot">
              <div>
                <span>所属项目</span><b>{{ previewAsset.source }}</b>
              </div>
              <div>
                <span>锁定版本</span><b>{{ previewAsset.version }}</b>
              </div>
              <div>
                <span>素材类型</span><b>{{ source.name }}</b>
              </div>
            </div>
            <p class="clone-muted">导入后复制为当前演示素材，保留来源项目与版本。</p></template
          >
          <div v-else class="fem-library-detail-empty">
            <div>
              <Boxes :size="30" /><b>素材详情预览</b>
              <p>点击素材预览，查看来源与版本。</p>
            </div>
          </div>
        </aside>
      </div>
      <template #footer
        ><span class="clone-muted">已选 {{ checked.length }} 项</span
        ><button class="frg-btn" @click="library = false">取消</button
        ><button class="frg-btn primary" :disabled="!checked.length" @click="importAssets">
          <Check :size="14" />导入所选素材
        </button></template
      ></CloneDialog
    >
  </div>
</template>
