<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import {
  Box,
  UserRound,
  MapPin,
  Shapes,
  LayoutGrid,
  Search,
  Plus,
  ImagePlus,
  ArrowUpRight,
  SlidersHorizontal,
  Trash2,
  Merge,
  Check,
  Pencil,
} from '@lucide/vue';
import type { ProductionAsset, ProductionShot } from '@ai-marketing/contracts';
import WorkflowInformationDialog from '../../../platform/workflow/components/WorkflowInformationDialog.vue';
import WorkflowInformationField from '../../../platform/workflow/components/WorkflowInformationField.vue';
import ProductionAssetVisual from './ProductionAssetVisual.vue';
import ProductionRenderDialog from './ProductionRenderDialog.vue';
const props = defineProps<{
  projectId: string;
  assets: ProductionAsset[];
  shots: ProductionShot[];
  editing: boolean;
  locked: boolean;
}>();
const emit = defineEmits<{
  update: [asset: ProductionAsset];
  add: [kind: ProductionAsset['kind']];
  remove: [id: string];
  merge: [id: string];
  edit: [];
}>();
const categories = [
  { id: 'PRODUCT', name: '产品', icon: Box, description: '产品形象、结构与标识' },
  { id: 'CHARACTER', name: '人物', icon: UserRound, description: '角色形象与服装特征' },
  { id: 'SCENE', name: '场景', icon: MapPin, description: '空间布局与光影关系' },
  { id: 'PROP', name: '道具', icon: Shapes, description: '剧情中复用的物件' },
] as const;
const category = ref('ALL'),
  keyword = ref(''),
  filter = ref('ALL');
const detailId = ref(''),
  draft = ref<ProductionAsset | null>(null),
  detailEditing = ref(false);
const renderAssets = ref<ProductionAsset[]>([]),
  renderOpen = ref(false);
const adding = ref(false);
const selected = computed(() => props.assets.find((a) => a.id === detailId.value));
const filtered = computed(() =>
  props.assets.filter(
    (a) =>
      (category.value === 'ALL' || a.kind === category.value) &&
      (!keyword.value.trim() ||
        `${a.name} ${a.description}`
          .toLocaleLowerCase()
          .includes(keyword.value.trim().toLocaleLowerCase())) &&
      (filter.value === 'ALL' || (filter.value === 'READY' ? !!a.image : !a.image)),
  ),
);
const groups = computed(() =>
  categories
    .map((c) => ({ ...c, assets: filtered.value.filter((a) => a.kind === c.id) }))
    .filter((c) => c.assets.length),
);
const ready = computed(() => props.assets.filter((a) => a.image).length);
const usage = (id: string) => props.shots.filter((s) => s.bindings.some((b) => b.assetId === id));
function openDetail(a: ProductionAsset) {
  detailId.value = a.id;
  draft.value = JSON.parse(JSON.stringify(a));
  detailEditing.value = false;
}
function beginEdit() {
  emit('edit');
  detailEditing.value = true;
}
function apply() {
  if (!draft.value?.name.trim() || props.locked) return;
  emit('update', JSON.parse(JSON.stringify(draft.value)));
  detailId.value = '';
}
function render(items: ProductionAsset[]) {
  detailId.value = '';
  renderAssets.value = items;
  renderOpen.value = true;
}
function add() {
  adding.value = true;
  keyword.value = '';
  filter.value = 'ALL';
  emit('add', category.value === 'ALL' ? 'PRODUCT' : (category.value as ProductionAsset['kind']));
}
watch(
  () => props.assets.map((a) => a.id).join('|'),
  (ids, previous) => {
    if (detailId.value && !selected.value) detailId.value = '';
    if (adding.value) {
      const added = props.assets.find((a) => !previous.split('|').includes(a.id));
      adding.value = false;
      if (added) {
        openDetail(added);
        detailEditing.value = true;
      }
    }
  },
);
</script>
<template>
  <div class="asset-studio">
    <aside class="catalog-nav">
      <div class="catalog-caption">
        脚本资产库<small>{{ assets.length }} 项共用资产</small>
      </div>
      <button
        :class="{ active: category === 'ALL' }"
        :aria-pressed="category === 'ALL'"
        @click="category = 'ALL'"
      >
        <LayoutGrid :size="17" />全部资产<span>{{ assets.length }}</span>
      </button>
      <button
        v-for="c in categories"
        :key="c.id"
        :class="{ active: category === c.id }"
        :aria-pressed="category === c.id"
        @click="category = c.id"
      >
        <component :is="c.icon" :size="17" />{{ c.name
        }}<span>{{ assets.filter((a) => a.kind === c.id).length }}</span>
      </button>
      <div class="catalog-note">
        <Check :size="15" />
        <p>定义统一形象<br />图片可在视频制作前补齐</p>
      </div>
    </aside>
    <main class="catalog-main">
      <div class="catalog-toolbar">
        <label class="catalog-search"
          ><Search :size="17" /><input
            v-model="keyword"
            aria-label="搜索资产"
            placeholder="搜索名称、形象特征"
        /></label>
        <label class="catalog-filter"
          ><SlidersHorizontal :size="15" /><select v-model="filter" aria-label="图片准备状态">
            <option value="ALL">全部状态</option>
            <option value="MISSING">图片待准备</option>
            <option value="READY">已关联图片</option>
          </select></label
        >
        <button class="studio-button" :disabled="locked" @click="add">
          <Plus :size="16" />添加资产
        </button>
        <button
          class="studio-button primary"
          :disabled="!filtered.length || locked"
          @click="render(filtered)"
        >
          <ImagePlus :size="16" />批量生成图片
        </button>
      </div>
      <div class="catalog-status">
        <span
          >{{ filtered.length }} 项资产<span class="divider">/</span>{{ ready }} 项已关联图片</span
        ><span>共用形象 · 按镜头选用</span>
      </div>
      <div class="catalog-groups" :class="{ ungrouped: category === 'ALL' }">
        <section v-for="g in groups" :key="g.id" class="asset-group">
          <header>
            <div>
              <component :is="g.icon" :size="19" />
              <h3>{{ g.name }}</h3>
              <span>{{ g.assets.length }}</span>
            </div>
            <p>{{ g.description }}</p>
          </header>
          <div class="visual-grid">
            <article v-for="a in g.assets" :key="a.id" class="visual-card">
              <button
                class="cover"
                :aria-label="`查看${a.name || '未命名资产'}`"
                @click="openDetail(a)"
              >
                <ProductionAssetVisual :asset="a" :project-id="projectId" /><span
                  class="cover-type"
                  >{{ g.name }}</span
                ><span class="cover-open"><ArrowUpRight :size="15" /></span>
              </button>
              <div class="card-copy">
                <div class="card-title">
                  <h4>{{ a.name || '未命名资产' }}</h4>
                  <span :class="['image-badge', { ready: !!a.image }]">{{
                    a.image ? '已有图片' : '待备图'
                  }}</span>
                </div>
                <p>{{ a.description || '补充形象与特征，让每个镜头使用同一对象。' }}</p>
                <small>{{
                  usage(a.id).length ? `${usage(a.id).length} 个镜头使用` : '尚未绑定镜头'
                }}</small>
              </div>
              <footer>
                <button class="studio-button text-button" @click="openDetail(a)">
                  <Pencil :size="14" />查看定义</button
                ><button class="studio-button" :disabled="locked" @click="render([a])">
                  <ImagePlus :size="14" />{{ a.image ? '重新生成' : '生成图片' }}
                </button>
              </footer>
            </article>
          </div>
        </section>
      </div>
      <div v-if="!groups.length" class="catalog-empty">
        <LayoutGrid :size="38" :stroke-width="1.3" />
        <h3>{{ assets.length ? '没有匹配的资产' : '从故事建立统一的视觉资产' }}</h3>
        <p>
          {{
            assets.length
              ? '试试其他名称、分类或图片状态。'
              : '先整理脚本中的产品、人物、场景与道具，再按需要生成图片。'
          }}
        </p>
        <button
          v-if="assets.length"
          class="studio-button"
          @click="
            keyword = '';
            category = 'ALL';
            filter = 'ALL';
          "
        >
          清除筛选
        </button>
      </div>
    </main>
  </div>
  <WorkflowInformationDialog
    :open="!!selected"
    :title="selected?.name || '资产详情'"
    description="公共定义供所有关联镜头复用，本镜动作在视频制作中设置。"
    @close="detailId = ''"
  >
    <div v-if="selected && draft" class="asset-detail">
      <div class="detail-preview">
        <ProductionAssetVisual :asset="selected" :project-id="projectId" />
        <div>
          <strong>{{ selected.image ? '已关联图片' : '图片待准备' }}</strong>
          <p>先确定公共形象，图片无需立即生成。</p>
          <button class="studio-button" :disabled="locked" @click="render([selected])">
            <ImagePlus :size="15" />生成图片
          </button>
        </div>
      </div>
      <div class="detail-heading">
        <h3>资产定义</h3>
        <button v-if="!detailEditing" class="studio-button" :disabled="locked" @click="beginEdit">
          <Pencil :size="14" />编辑定义
        </button>
      </div>
      <div class="detail-fields">
        <WorkflowInformationField
          v-model="draft.name"
          label="资产名称"
          :readonly="!detailEditing || locked"
        /><label class="category-field"
          >资产类别<select v-model="draft.kind" :disabled="!detailEditing || locked">
            <option v-for="c in categories" :key="c.id" :value="c.id">{{ c.name }}</option>
          </select></label
        >
      </div>
      <WorkflowInformationField
        v-model="draft.description"
        label="公共形象与特征"
        multiline
        :readonly="!detailEditing || locked"
      />
      <div class="detail-fields">
        <WorkflowInformationField
          v-model="draft.knownFacts"
          label="已确认信息"
          multiline
          :readonly="!detailEditing || locked"
        /><WorkflowInformationField
          v-model="draft.designNotes"
          label="设计与待确认内容"
          multiline
          :readonly="!detailEditing || locked"
        />
      </div>
      <WorkflowInformationField
        :model-value="draft.imageRequirements ?? ''"
        label="图像制作要求"
        multiline
        :readonly="!detailEditing || locked"
        @update:model-value="draft.imageRequirements = $event"
      />
      <details>
        <summary>来源依据与使用镜头</summary>
        <WorkflowInformationField
          v-model="draft.sourceText"
          label="故事与简报依据"
          multiline
          :readonly="!detailEditing || locked"
        />
        <p>
          {{
            usage(selected.id)
              .map((s) => s.title)
              .join('、') || '尚未绑定镜头'
          }}
        </p>
      </details>
      <footer class="detail-footer">
        <div>
          <button
            class="studio-button danger"
            :disabled="locked || !editing"
            @click="emit('remove', selected.id)"
          >
            <Trash2 :size="14" />移除定义</button
          ><button
            class="studio-button"
            :disabled="locked || !editing"
            @click="
              detailId = '';
              emit('merge', selected.id);
            "
          >
            <Merge :size="14" />合并重复
          </button>
        </div>
        <button
          v-if="detailEditing"
          class="studio-button primary"
          :disabled="locked || !draft.name.trim()"
          @click="apply"
        >
          应用到草稿</button
        ><button v-else class="studio-button" @click="detailId = ''">关闭</button>
      </footer>
    </div>
  </WorkflowInformationDialog>
  <ProductionRenderDialog
    :open="renderOpen"
    type="IMAGE"
    :assets="renderAssets"
    @close="renderOpen = false"
  />
</template>
<style scoped>
.asset-detail :deep(.information-field textarea) {
  min-height: 100px;
}
.asset-studio {
  display: grid;
  grid-template-columns: 184px minmax(0, 1fr);
  border: 1px solid #e3e9f2;
  border-radius: 18px;
  overflow: hidden;
  margin-top: 24px;
  background: #fff;
}
.catalog-nav {
  padding: 24px 14px;
  background: #f8fafc;
  border-right: 1px solid #e8edf4;
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.catalog-caption {
  font-size: 14px;
  font-weight: 650;
  padding: 0 12px 20px;
  color: #2c3d54;
}
.catalog-caption small {
  display: block;
  font-weight: 400;
  font-size: 11px;
  color: #8794a8;
  margin-top: 8px;
}
.catalog-nav button {
  display: flex;
  align-items: center;
  gap: 11px;
  min-height: 43px;
  padding: 0 12px;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 9px;
  color: #6a7c94;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}
.catalog-nav button span {
  margin-left: auto;
  font-size: 11px;
  color: #94a1b4;
}
.catalog-nav button.active {
  background: #eaf0ff;
  color: #315fe7;
  border-color: #e2eaff;
}
.catalog-note {
  display: flex;
  gap: 7px;
  margin: 24px 10px;
  color: #90a09b;
}
.catalog-note svg {
  flex-shrink: 0;
  margin-top: 4px;
}
.catalog-note p {
  font-size: 11px;
  line-height: 1.8;
  margin: 0;
}
.catalog-main {
  padding: 24px;
  min-width: 0;
}
.catalog-toolbar {
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
}
.catalog-search {
  display: flex;
  align-items: center;
  gap: 10px;
  border: 1px solid #e0e6ee;
  border-radius: 9px;
  padding: 0 12px;
  min-height: 40px;
  flex: 1;
  min-width: 160px;
  color: #8f9bb0;
}
.catalog-search input {
  border: 0;
  outline: 0;
  min-width: 0;
  width: 100%;
  font: inherit;
  font-size: 12px;
  background: transparent;
  color: #354761;
}
.catalog-search input::placeholder {
  color: #9aa5b5;
}
.catalog-filter {
  display: flex;
  align-items: center;
  gap: 6px;
  color: #8593a8;
}
.catalog-filter select {
  border: 0;
  background: transparent;
  color: #6c7d96;
  font-size: 12px;
  max-width: 130px;
}
.catalog-status {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 18px 0 8px;
  font-size: 11px;
  color: #8e9aac;
}
.divider {
  margin: 0 9px;
  color: #d2d9e2;
}
.asset-group {
  margin-top: 22px;
}
.asset-group > header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 14px;
  gap: 12px;
}
.asset-group > header > div {
  display: flex;
  align-items: center;
  gap: 10px;
  color: #667f9b;
}
.asset-group h3 {
  font-size: 15px;
  color: #283c56;
  margin: 0;
}
.asset-group > header span {
  font-size: 11px;
  color: #8d9aaf;
}
.asset-group > header p {
  font-size: 11px;
  color: #97a2b3;
  margin: 0;
}
.visual-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(225px, 1fr));
  gap: 16px;
}
.visual-card {
  border: 1px solid #e4e9f0;
  border-radius: 13px;
  overflow: hidden;
  min-width: 0;
  transition:
    box-shadow 0.15s,
    border-color 0.15s;
}
.visual-card:hover {
  border-color: #cbd8ec;
  box-shadow: 0 5px 18px #273a5710;
}
.cover {
  position: relative;
  width: 100%;
  border: 0;
  padding: 0;
  background: transparent;
  display: block;
  cursor: pointer;
}
.cover-type {
  position: absolute;
  top: 12px;
  left: 12px;
  font-size: 10px;
  color: #778596;
  border: 1px solid #ffffffc4;
  background: #ffffffc9;
  border-radius: 5px;
  padding: 4px 7px;
}
.cover-open {
  display: grid;
  place-items: center;
  position: absolute;
  bottom: 10px;
  right: 10px;
  border-radius: 50%;
  background: #ffffffcf;
  width: 27px;
  height: 27px;
  color: #7e8da3;
}
.card-copy {
  padding: 15px 15px 12px;
}
.card-title {
  display: flex;
  align-items: start;
  justify-content: space-between;
  gap: 9px;
}
.card-title h4 {
  font-size: 13px;
  line-height: 1.6;
  color: #2b3e59;
  margin: 0;
}
.image-badge {
  font-size: 10px;
  white-space: nowrap;
  padding: 3px 6px;
  background: #f6f2e9;
  color: #a39169;
  border-radius: 5px;
}
.image-badge.ready {
  background: #edf6f0;
  color: #65927a;
}
.card-copy p {
  font-size: 12px;
  color: #8591a3;
  line-height: 1.8;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  min-height: 43px;
  margin: 10px 0;
}
.card-copy small {
  font-size: 10px;
  color: #9aa6b7;
}
.visual-card footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 12px;
  border-top: 1px solid #edf0f5;
  background: #fdfdfe;
}
.studio-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border: 1px solid #dce4f0;
  border-radius: 8px;
  background: #fff;
  color: #597392;
  min-height: 35px;
  padding: 0 11px;
  font-size: 11px;
  cursor: pointer;
  white-space: nowrap;
}
.catalog-toolbar > .studio-button {
  min-height: 40px;
}
.studio-button.primary {
  background: #315ff0;
  color: white;
  border-color: #315ff0;
}
.studio-button.text-button {
  background: transparent;
  border-color: transparent;
  padding-left: 0;
}
.studio-button:disabled {
  opacity: 0.45;
  cursor: default;
}
.studio-button.danger {
  color: #c77878;
}
.catalog-empty {
  min-height: 330px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: #a5afbd;
  gap: 10px;
  text-align: center;
}
.catalog-empty h3 {
  font-size: 16px;
  color: #526981;
}
.catalog-empty p {
  font-size: 12px;
  margin: 0 0 14px;
  line-height: 1.8;
}
.asset-detail {
  display: grid;
  gap: 20px;
}
.detail-preview {
  display: grid;
  grid-template-columns: 220px 1fr;
  gap: 24px;
  align-items: center;
}
.detail-preview :deep(.asset-visual) {
  border-radius: 12px;
}
.detail-preview strong {
  font-size: 14px;
  color: #435a77;
}
.detail-preview p {
  font-size: 12px;
  color: #8795a8;
  line-height: 1.8;
}
.detail-heading {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.detail-heading h3 {
  font-size: 15px;
  margin: 0;
}
.detail-fields {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 20px;
}
.category-field {
  display: grid;
  gap: 8px;
  font-size: 13px;
  color: #647a98;
}
.category-field select {
  min-width: 0;
  border: 1px solid #d7e2f4;
  border-radius: 11px;
  padding: 12px;
  color: #344d72;
  background: white;
  font: inherit;
}
details summary {
  cursor: pointer;
  color: #7b8fa9;
  font-size: 12px;
}
details p {
  font-size: 12px;
  color: #8696ad;
  line-height: 1.8;
}
.detail-footer,
.detail-footer > div {
  display: flex;
  align-items: center;
  gap: 8px;
  justify-content: space-between;
}
.detail-footer {
  border-top: 1px solid #e8edf4;
  padding-top: 18px;
}
button:focus-visible {
  outline: 2px solid #315ff0;
  outline-offset: 3px;
}
@media (min-width: 1700px) {
  .visual-grid {
    grid-template-columns: repeat(auto-fill, minmax(245px, 1fr));
  }
}
@media (max-width: 900px) {
  .asset-studio {
    grid-template-columns: 1fr;
  }
  .catalog-nav {
    flex-direction: row;
    border-right: 0;
    border-bottom: 1px solid #e8edf4;
    padding: 12px;
    overflow: auto;
  }
  .catalog-caption,
  .catalog-note {
    display: none;
  }
  .catalog-nav button {
    flex-shrink: 0;
    gap: 8px;
  }
  .catalog-main {
    padding: 18px;
  }
  .catalog-status > span:last-child {
    display: none;
  }
}
@media (max-width: 600px) {
  .visual-grid,
  .detail-fields,
  .detail-preview {
    grid-template-columns: 1fr;
  }
  .catalog-toolbar {
    gap: 12px;
  }
  .catalog-search {
    flex-basis: 100%;
  }
  .asset-group > header p {
    display: none;
  }
  .detail-footer {
    flex-wrap: wrap;
  }
  .catalog-main {
    padding: 14px;
  }
  .detail-preview :deep(.asset-visual) {
    max-height: 180px;
  }
  .visual-grid {
    grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
  }
}
.catalog-groups.ungrouped {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(225px, 1fr));
  gap: 16px;
  margin-top: 20px;
}
.ungrouped .asset-group,
.ungrouped .visual-grid {
  display: contents;
}
.ungrouped .asset-group > header {
  display: none;
}
@media (max-width: 600px) {
  .catalog-groups.ungrouped {
    grid-template-columns: 1fr;
  }
}
</style>
