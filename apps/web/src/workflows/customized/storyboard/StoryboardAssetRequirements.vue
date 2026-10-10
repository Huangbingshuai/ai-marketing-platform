<script setup lang="ts">
import { computed, ref } from 'vue';
import { Box, ChevronDown, MapPin, Pencil, Plus, Users, X } from '@lucide/vue';
import {
  CUSTOMIZED_STORYBOARD_ASSET_KINDS,
  type CustomizedStoryboardAsset,
  type CustomizedStoryboardAssetKind,
  type CustomizedStoryboardAssetRequirements,
  type CustomizedStoryboardShot,
} from '@ai-marketing/contracts';
import WorkflowInformationDialog from '../../../platform/workflow/components/WorkflowInformationDialog.vue';
import WorkflowInformationField from '../../../platform/workflow/components/WorkflowInformationField.vue';
import { requestActionConfirmation } from '../../../shared/composables/action-confirmation';
import {
  emptyStoryboardAssetRequirements,
  snapshotStoryboard,
  storyboardAssetLabels,
} from './storyboard-state';

const props = withDefaults(
  defineProps<{
    requirements?: CustomizedStoryboardAssetRequirements | undefined;
    assets: CustomizedStoryboardAsset[];
    shots: CustomizedStoryboardShot[];
    shotId: string;
    editable?: boolean;
    compact?: boolean;
  }>(),
  { editable: false, compact: false, requirements: undefined },
);
const emit = defineEmits<{
  'update:requirements': [value: CustomizedStoryboardAssetRequirements];
  'update:assets': [value: CustomizedStoryboardAsset[]];
}>();
const groups = computed(() => props.requirements ?? emptyStoryboardAssetRequirements());
const icons = { characters: Users, products: Box, scenes: MapPin };
const hints = {
  characters: '外观、服饰与本镜姿态',
  products: '固定外观与本镜展示状态',
  scenes: '空间、时间与本镜光线',
};
const placeholders = {
  characters: '例如：浅米色衬衫，右手取酱，只呈现手部',
  products: '例如：瓶盖打开，瓶身右侧入画，保持标签方向',
  scenes: '例如：傍晚暖光从左侧进入，保留餐桌空间关系',
};
const editor = ref<{
  kind: CustomizedStoryboardAssetKind;
  assetId: string | null;
  mode: 'new' | 'existing';
  selectedId: string;
  name: string;
  description: string;
  shotDescription: string;
} | null>(null);
const available = computed(() =>
  editor.value
    ? props.assets.filter(
        (asset) =>
          asset.kind === editor.value!.kind &&
          !groups.value[editor.value!.kind].items.some((item) => item.assetId === asset.id),
      )
    : [],
);
const validEditor = computed(() => {
  const e = editor.value;
  return (
    !!e &&
    e.shotDescription.length <= 20000 &&
    (e.mode === 'existing'
      ? available.value.some((a) => a.id === e.selectedId)
      : !!e.name.trim() &&
        e.name.trim().length <= 200 &&
        e.description.length <= 20000 &&
        (!!e.assetId || props.assets.length < 1000))
  );
});
const assetFor = (id: string) => props.assets.find((asset) => asset.id === id);
function usage(id: string) {
  return props.shots
    .filter((shot) => {
      const requirements = shot.id === props.shotId ? groups.value : shot.assetRequirements;
      return Object.values(requirements ?? {}).some((group) =>
        group.items.some((item) => item.assetId === id),
      );
    })
    .map((shot, index) => {
      const number = props.shots.findIndex((s) => s.id === shot.id) + 1;
      return `${String(number || index + 1).padStart(2, '0')} ${shot.title || '未命名镜头'}`;
    });
}
function start(kind: CustomizedStoryboardAssetKind, asset?: CustomizedStoryboardAsset) {
  if (!props.editable) return;
  editor.value = {
    kind,
    assetId: asset?.id ?? null,
    mode: 'new',
    selectedId: '',
    name: asset?.name ?? '',
    description: asset?.description ?? '',
    shotDescription: '',
  };
}
function saveObject() {
  const e = editor.value;
  if (!e || !props.editable || !validEditor.value) return;
  let id = e.assetId;
  if (e.mode === 'existing') id = e.selectedId;
  else {
    id ??= crypto.randomUUID();
    const updated = snapshotStoryboard(props.assets);
    const asset = { id, kind: e.kind, name: e.name.trim(), description: e.description };
    const i = updated.findIndex((a) => a.id === id);
    if (i >= 0) updated[i] = asset;
    else updated.push(asset);
    emit('update:assets', updated);
  }
  if (!e.assetId) {
    const next = snapshotStoryboard(groups.value);
    if (next[e.kind].items.length >= 100) return;
    next[e.kind].state = 'DEFINED';
    next[e.kind].items.push({ assetId: id!, description: e.shotDescription });
    emit('update:requirements', next);
  }
  editor.value = null;
}
function updateDescription(kind: CustomizedStoryboardAssetKind, id: string, text: string) {
  if (!props.editable) return;
  const next = snapshotStoryboard(groups.value);
  const item = next[kind].items.find((i) => i.assetId === id);
  if (item) item.description = text;
  emit('update:requirements', next);
}
function remove(kind: CustomizedStoryboardAssetKind, id: string) {
  if (!props.editable) return;
  const next = snapshotStoryboard(groups.value);
  next[kind].items = next[kind].items.filter((i) => i.assetId !== id);
  if (!next[kind].items.length) next[kind].state = 'UNDEFINED';
  emit('update:requirements', next);
}
async function setNone(kind: CustomizedStoryboardAssetKind) {
  if (!props.editable) return;
  const current = props.requirements;
  if (
    groups.value[kind].items.length &&
    !(await requestActionConfirmation({
      title: `本镜不需要${storyboardAssetLabels[kind]}资产？`,
      description: '将移除本镜的关联，其他镜头与公共对象定义仍会保留。',
      confirmLabel: '确认不需要',
    }))
  )
    return;
  if (!props.editable || current !== props.requirements) return;
  const next = snapshotStoryboard(groups.value);
  next[kind] = { state: groups.value[kind].state === 'NONE' ? 'UNDEFINED' : 'NONE', items: [] };
  emit('update:requirements', next);
}
</script>

<template>
  <aside
    class="asset-requirements"
    :class="{ compact, 'is-editable': editable }"
    aria-label="镜头资产需求"
  >
    <div v-if="!compact" class="requirements-heading">
      <strong>资产需求</strong><span>公共定义 · 本镜呈现</span>
    </div>
    <div class="asset-groups">
      <section v-for="kind in CUSTOMIZED_STORYBOARD_ASSET_KINDS" :key="kind" class="asset-group">
        <header class="group-heading">
          <component :is="icons[kind]" :size="15" />
          <h4>{{ storyboardAssetLabels[kind] }}资产</h4>
          <span v-if="groups[kind].state === 'DEFINED'" class="count">{{
            groups[kind].items.length
          }}</span>
          <button
            v-if="editable"
            type="button"
            :aria-label="`添加${storyboardAssetLabels[kind]}资产`"
            :disabled="groups[kind].items.length >= 100"
            @click="start(kind)"
          >
            <Plus :size="13" />添加
          </button>
        </header>
        <div v-for="item in groups[kind].items" :key="item.assetId" class="asset-object">
          <div class="object-heading">
            <strong>{{ assetFor(item.assetId)?.name ?? '对象引用缺失' }}</strong>
            <span
              v-if="usage(item.assetId).length > 1"
              class="reuse"
              :title="usage(item.assetId).join('\n')"
            >
              {{ usage(item.assetId).length }} 镜复用
            </span>
            <template v-if="editable">
              <button
                type="button"
                :aria-label="`编辑公共定义：${assetFor(item.assetId)?.name}`"
                @click="start(kind, assetFor(item.assetId))"
              >
                <Pencil :size="12" />
              </button>
              <button
                type="button"
                :aria-label="`移除本镜关联：${assetFor(item.assetId)?.name}`"
                @click="remove(kind, item.assetId)"
              >
                <X :size="12" />
              </button>
            </template>
          </div>
          <p v-if="editable" class="object-definition">
            {{ assetFor(item.assetId)?.description || '公共外观尚未填写' }}
          </p>
          <details v-else class="common-definition">
            <summary>公共外观定义<ChevronDown :size="12" /></summary>
            <p class="object-definition">
              {{ assetFor(item.assetId)?.description || '公共外观尚未填写' }}
            </p>
          </details>
          <WorkflowInformationField
            v-if="editable"
            label="本镜呈现要求"
            :model-value="item.description"
            multiline
            :placeholder="placeholders[kind]"
            @update:model-value="updateDescription(kind, item.assetId, $event)"
          />
          <p v-else class="shot-requirement">
            <span>本镜</span>{{ item.description || '呈现要求尚未填写' }}
          </p>
        </div>
        <div
          v-if="!groups[kind].items.length"
          class="asset-empty"
          :class="{ intentional: groups[kind].state === 'NONE' }"
        >
          <span>{{
            groups[kind].state === 'NONE'
              ? `本镜不需要${storyboardAssetLabels[kind]}资产`
              : '尚未定义'
          }}</span>
          <small v-if="!compact && groups[kind].state !== 'NONE'">{{ hints[kind] }}</small>
        </div>
        <button
          v-if="editable"
          class="none-toggle"
          type="button"
          :aria-pressed="groups[kind].state === 'NONE'"
          @click="setNone(kind)"
        >
          {{
            groups[kind].state === 'NONE'
              ? '恢复为尚未定义'
              : `本镜不需要${storyboardAssetLabels[kind]}`
          }}
        </button>
      </section>
    </div>
    <p v-if="!compact" class="requirements-note">图片生成与素材绑定在逐镜工作台完成</p>
    <WorkflowInformationDialog
      :open="!!editor"
      :title="
        editor
          ? `${editor.assetId ? '编辑' : '添加'}${storyboardAssetLabels[editor.kind]}资产对象`
          : '资产对象'
      "
      description="公共定义由同一脚本内引用该对象的镜头共用，本镜呈现要求单独保存。"
      @close="editor = null"
    >
      <div v-if="editor" class="object-form">
        <div v-if="!editor.assetId" class="object-mode" role="group" aria-label="资产对象来源">
          <button type="button" :aria-pressed="editor.mode === 'new'" @click="editor.mode = 'new'">
            新建对象
          </button>
          <button
            type="button"
            :aria-pressed="editor.mode === 'existing'"
            @click="editor.mode = 'existing'"
          >
            复用已有对象
          </button>
        </div>
        <template v-if="editor.mode === 'new'">
          <WorkflowInformationField
            v-model="editor.name"
            label="对象名称"
            placeholder="使用易于识别、全片一致的名称"
          />
          <WorkflowInformationField
            v-model="editor.description"
            label="公共外观定义"
            multiline
            placeholder="记录跨镜保持一致的特征；尚未确定的部分可注明待设计"
          />
          <p v-if="editor.assetId" class="shared-warning">
            当前关联 {{ usage(editor.assetId).length }} 个镜头：{{
              usage(editor.assetId).join('、')
            }}。保存镜头后同步公共定义。
          </p>
        </template>
        <template v-else>
          <label class="existing-label"
            >已有对象
            <select v-model="editor.selectedId" aria-label="选择已有资产对象">
              <option value="">请选择同脚本的对象</option>
              <option v-for="asset in available" :key="asset.id" :value="asset.id">
                {{ asset.name }}
              </option>
            </select>
          </label>
          <p v-if="editor.selectedId" class="selected-definition">
            {{ assetFor(editor.selectedId)?.description || '公共外观尚未填写' }}
          </p>
          <p v-if="!available.length" class="shared-warning">
            没有可复用的同类对象，可先新建；已关联的对象无需重复添加。
          </p>
        </template>
        <WorkflowInformationField
          v-if="!editor.assetId"
          v-model="editor.shotDescription"
          label="本镜呈现要求"
          multiline
          :placeholder="placeholders[editor.kind]"
        />
        <div class="object-form-actions">
          <button type="button" @click="editor = null">取消</button>
          <button type="button" class="save-object" :disabled="!validEditor" @click="saveObject">
            {{ editor.assetId ? '应用修改' : '添加到本镜' }}
          </button>
        </div>
      </div>
    </WorkflowInformationDialog>
  </aside>
</template>

<style scoped>
.asset-requirements {
  min-width: 0;
  padding: 20px;
  background: #f8fafd;
  color: #526782;
}
.requirements-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 16px;
}
.requirements-heading strong {
  font-size: 13px;
  color: #344961;
}
.requirements-heading > span {
  color: #8a98ac;
  font-size: 10px;
}
.asset-group + .asset-group {
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px solid #e5ebf3;
}
.asset-requirements:not(.compact):not(.is-editable) .asset-groups {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}
.asset-requirements:not(.compact):not(.is-editable) .asset-group + .asset-group {
  margin: 0;
  padding: 0;
  border: 0;
}
.asset-group {
  min-width: 0;
}
.group-heading,
.object-heading {
  display: flex;
  gap: 7px;
  align-items: center;
}
.group-heading {
  color: #6b83a4;
}
.group-heading h4 {
  margin: 0;
  font-size: 12px;
  font-weight: 650;
  color: #4b607c;
}
.group-heading button {
  margin-left: auto;
}
.count {
  display: grid;
  place-items: center;
  min-width: 18px;
  height: 18px;
  background: #e9eff8;
  border-radius: 5px;
  font-size: 10px;
}
button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  min-height: 28px;
  padding: 0 8px;
  background: #fff;
  border: 1px solid #d7e1f0;
  border-radius: 6px;
  color: #526782;
  font: inherit;
  font-size: 11px;
  cursor: pointer;
  white-space: nowrap;
}
button:disabled {
  opacity: 0.4;
  cursor: default;
}
button:focus-visible,
select:focus-visible {
  outline: 2px solid #7da7ef;
  outline-offset: 2px;
}
.asset-object {
  margin-top: 10px;
  padding: 12px;
  border: 1px solid #e0e7f1;
  border-radius: 10px;
  background: #fff;
}
.object-heading {
  flex-wrap: wrap;
}
.object-heading strong {
  flex: 1;
  color: #3c506b;
  font-size: 12px;
  overflow-wrap: anywhere;
}
.object-heading button {
  min-height: 25px;
  width: 25px;
  padding: 0;
}
.reuse {
  color: #6985ac;
  background: #f0f5fc;
  border-radius: 4px;
  padding: 3px 5px;
  font-size: 10px;
  white-space: nowrap;
}
.object-definition {
  margin: 8px 0 0;
  color: #7f8da1;
  font-size: 11px;
  line-height: 1.8;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.common-definition summary {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-top: 8px;
  color: #8a99ad;
  font-size: 10px;
  cursor: pointer;
  list-style: none;
}
.common-definition summary::-webkit-details-marker {
  display: none;
}
.common-definition[open] summary svg {
  transform: rotate(180deg);
}
.shot-requirement {
  display: flex;
  gap: 7px;
  margin: 9px 0 0;
  padding-top: 8px;
  border-top: 1px dashed #e7ecf4;
  font-size: 11px;
  line-height: 1.8;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.shot-requirement > span {
  flex-shrink: 0;
  color: #96a3b5;
}
.asset-empty {
  display: grid;
  gap: 5px;
  margin-top: 10px;
  padding: 12px;
  border: 1px dashed #dce4ef;
  border-radius: 9px;
  color: #8e9caf;
  font-size: 12px;
}
.asset-empty small {
  color: #a2aec0;
  font-size: 10px;
}
.asset-empty.intentional {
  border-style: solid;
  border-color: #e7ecf3;
  background: #f2f5f9;
}
button.none-toggle {
  margin-top: 8px;
  min-height: 22px;
  padding: 0;
  background: transparent;
  border: 0;
  color: #8a99ae;
  font-size: 10px;
}
.requirements-note {
  margin: 16px 0 0;
  color: #94a1b4;
  font-size: 10px;
  line-height: 1.7;
}
.asset-object :deep(.information-field) {
  margin-top: 12px;
  font-size: 11px;
}
.asset-object :deep(textarea) {
  min-height: 72px;
  height: 72px;
  font-size: 12px;
  line-height: 1.8;
  resize: vertical;
}
.object-form {
  display: grid;
  gap: 18px;
}
.object-form :deep(textarea) {
  min-height: 100px;
  resize: vertical;
}
.object-mode {
  display: flex;
  gap: 8px;
}
.object-mode button {
  min-height: 34px;
  padding: 0 14px;
  font-size: 12px;
}
.object-mode [aria-pressed='true'] {
  color: #2563eb;
  border-color: #b7cdf5;
  background: #f2f6fe;
}
.existing-label {
  display: grid;
  gap: 8px;
  color: #596278;
  font-size: 14px;
  font-weight: 650;
}
select {
  width: 100%;
  padding: 11px;
  border: 1px solid #dce3ec;
  border-radius: 10px;
  background: #fff;
  color: #42526a;
  font: inherit;
  font-size: 13px;
}
.selected-definition,
.shared-warning {
  margin: 0;
  font-size: 12px;
  line-height: 1.8;
  color: #7b899e;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.shared-warning {
  padding: 12px;
  border-radius: 9px;
  background: #f5f8fd;
}
.object-form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}
.object-form-actions button {
  min-height: 38px;
  padding: 0 18px;
  font-size: 13px;
}
.save-object {
  color: #fff;
  background: #2563eb;
  border-color: #2563eb;
}
.compact {
  padding: 12px 0 0;
  border-top: 1px solid #e8edf5;
  background: transparent;
}
.compact .asset-group + .asset-group {
  margin-top: 10px;
  padding-top: 10px;
}
.compact .asset-object {
  padding: 10px;
}
.compact .asset-empty {
  padding: 7px 10px;
}
@media (max-width: 900px) {
  .asset-requirements:not(.compact):not(.is-editable) .asset-groups {
    grid-template-columns: 1fr;
  }
  .asset-requirements:not(.compact):not(.is-editable) .asset-group + .asset-group {
    padding-top: 12px;
    border-top: 1px solid #e5ebf3;
  }
}
@media (max-width: 600px) {
  .asset-requirements {
    padding: 16px;
  }
  .compact {
    padding: 12px 0 0;
  }
}
</style>
