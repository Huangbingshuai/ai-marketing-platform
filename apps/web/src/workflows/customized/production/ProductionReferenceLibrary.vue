<script setup lang="ts">
import { computed, ref } from 'vue';
import { Search, Check, ArrowUpRight, Pencil } from '@lucide/vue';
import type { ProductionAsset, ProductionShot } from '@ai-marketing/contracts';
import ProductionAssetVisual from './ProductionAssetVisual.vue';
const props = defineProps<{
  projectId: string;
  assets: ProductionAsset[];
  shot: ProductionShot;
  editing: boolean;
  locked: boolean;
}>();
defineEmits<{
  toggle: [asset: ProductionAsset];
  edit: [];
  prepare: [asset: ProductionAsset];
  details: [asset: ProductionAsset];
}>();
const keyword = ref(''),
  onlyBound = ref(false);
const categories = [
  { id: 'PRODUCT', name: '产品' },
  { id: 'CHARACTER', name: '人物' },
  { id: 'SCENE', name: '场景' },
  { id: 'PROP', name: '道具' },
];
const bound = (id: string) => props.shot.bindings.some((b) => b.assetId === id);
const groups = computed(() =>
  categories
    .map((c) => ({
      ...c,
      assets: props.assets.filter(
        (a) =>
          a.kind === c.id &&
          (!onlyBound.value || bound(a.id)) &&
          (!keyword.value.trim() || `${a.name} ${a.description}`.includes(keyword.value.trim())),
      ),
    }))
    .filter((c) => c.assets.length),
);
</script>
<template>
  <section class="reference-library" aria-label="镜头素材库">
    <header>
      <div>
        <h3>参考素材</h3>
        <span>{{ shot.bindings.length }} / {{ assets.length }} 已绑定</span>
      </div>
      <button v-if="!editing" :disabled="locked" @click="$emit('edit')">
        <Pencil :size="13" />编辑绑定</button
      ><span v-else class="edit-label">点击素材切换绑定</span>
    </header>
    <div class="library-tools">
      <label
        ><Search :size="14" /><input
          v-model="keyword"
          placeholder="搜索素材"
          aria-label="搜索镜头素材" /></label
      ><button
        :class="{ active: !onlyBound }"
        :aria-pressed="!onlyBound"
        @click="onlyBound = false"
      >
        全部</button
      ><button :class="{ active: onlyBound }" :aria-pressed="onlyBound" @click="onlyBound = true">
        本镜
      </button>
    </div>
    <div class="library-groups">
      <section v-for="g in groups" :key="g.id">
        <h4>
          {{ g.name }}<span>{{ g.assets.length }}</span>
        </h4>
        <div class="reference-grid">
          <article
            v-for="a in g.assets"
            :key="a.id"
            :class="['reference-item', { bound: bound(a.id) }]"
          >
            <button
              class="reference-choice"
              role="checkbox"
              :aria-checked="bound(a.id)"
              :aria-label="`绑定${a.name}`"
              :disabled="locked || !editing"
              @click="$emit('toggle', a)"
            >
              <ProductionAssetVisual :asset="a" :project-id="projectId" compact /><span
                class="reference-copy"
                ><strong>{{ a.name }}</strong
                ><small>{{
                  bound(a.id) ? (a.image ? '已绑定 · 已关联图片' : '已绑定 · 待备图') : '未绑定'
                }}</small></span
              ><span v-if="bound(a.id)" class="check"><Check :size="12" /></span>
            </button>
            <div class="reference-actions">
              <button @click="$emit('details', a)">查看定义</button
              ><button
                v-if="bound(a.id) && !a.image"
                :disabled="locked"
                @click="$emit('prepare', a)"
              >
                去生成<ArrowUpRight :size="11" />
              </button>
            </div>
          </article>
        </div>
      </section>
      <p v-if="!groups.length" class="empty">
        {{ onlyBound ? '当前镜头没有匹配的绑定素材' : '没有匹配的素材' }}
      </p>
    </div>
    <p class="library-hint">全部素材供选择；只有已绑定对象参与本镜提示词。</p>
  </section>
</template>
<style scoped>
.reference-library {
  padding: 20px;
  border: 1px solid #e5eaf2;
  border-radius: 13px;
  background: #fafbfd;
  min-width: 0;
}
header,
header > div {
  display: flex;
  align-items: center;
  gap: 10px;
  justify-content: space-between;
}
h3 {
  font-size: 14px;
  color: #2b405e;
  margin: 0;
}
header span {
  font-size: 10px;
  color: #8394ae;
  white-space: nowrap;
}
header .edit-label {
  font-size: 10px;
  color: #5275b5;
}
button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  background: #fff;
  color: #6e82a0;
  border: 1px solid #dde5f1;
  border-radius: 7px;
  padding: 6px 8px;
  font-size: 10px;
  cursor: pointer;
}
button:disabled {
  cursor: default;
}
.library-tools {
  display: flex;
  gap: 6px;
  margin: 18px 0;
}
.library-tools label {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  flex: 1;
  color: #92a0b3;
  border: 1px solid #e3e8f0;
  background: #fff;
  border-radius: 7px;
  padding: 8px;
}
.library-tools input {
  width: 100%;
  min-width: 0;
  border: 0;
  background: transparent;
  outline: 0;
  font: inherit;
  font-size: 11px;
  color: #4d6585;
}
.library-tools input::placeholder {
  color: #a0aabb;
}
.library-tools button {
  border-color: transparent;
  background: transparent;
}
.library-tools button.active {
  background: #eaf0ff;
  color: #426ddd;
}
.library-groups {
  max-height: 510px;
  overflow: auto;
  padding-right: 2px;
}
.library-groups section + section {
  margin-top: 18px;
}
h4 {
  font-size: 11px;
  font-weight: 500;
  color: #8291a6;
  display: flex;
  gap: 8px;
  margin: 0 0 9px;
}
h4 span {
  color: #a0acbc;
}
.reference-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}
.reference-item {
  border: 1px solid #e2e8f1;
  border-radius: 9px;
  background: #fff;
  overflow: hidden;
  min-width: 0;
}
.reference-item.bound {
  border-color: #b7c9ee;
  background: #f5f8ff;
}
.reference-choice {
  position: relative;
  display: flex;
  width: 100%;
  justify-content: flex-start;
  gap: 9px;
  padding: 9px;
  border: 0;
  background: transparent;
  text-align: left;
  border-radius: 0;
}
.reference-copy {
  min-width: 0;
}
.reference-copy strong {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #4e627e;
  font-size: 11px;
  font-weight: 550;
}
.reference-copy small {
  display: block;
  font-size: 9px;
  color: #a0aabb;
  margin-top: 6px;
}
.bound .reference-copy small {
  color: #788db5;
}
.check {
  position: absolute;
  right: 5px;
  top: 4px;
  color: #6f91da;
}
.reference-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 8px 8px;
  gap: 5px;
}
.reference-actions button {
  font-size: 9px;
  border: 0;
  padding: 0;
  background: transparent;
  min-height: 18px;
  color: #8a9ab2;
}
.reference-actions button:last-child {
  color: #6485be;
}
.library-hint {
  font-size: 10px;
  color: #9aa7b9;
  line-height: 1.7;
  margin: 15px 0 0;
}
.empty {
  font-size: 12px;
  color: #96a4b8;
  padding: 25px 0;
  text-align: center;
}
button:focus-visible {
  outline: 2px solid #315ff0;
  outline-offset: 2px;
}
@media (max-width: 600px) {
  .reference-library {
    padding: 15px;
  }
  .reference-grid {
    grid-template-columns: 1fr;
  }
  header > div {
    align-items: flex-start;
    flex-direction: column;
    gap: 5px;
  }
  .library-groups {
    max-height: 400px;
  }
}
</style>
