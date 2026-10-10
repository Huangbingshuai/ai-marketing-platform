<script setup lang="ts">
import { computed, ref } from 'vue';
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  Clock3,
  GripVertical,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  X,
  Check,
} from '@lucide/vue';
import {
  isCustomizedStoryboardScript,
  type CustomizedStoryboardShot,
  type CustomizedStoryboardAsset,
} from '@ai-marketing/contracts';
import WorkflowInformationField from '../../../platform/workflow/components/WorkflowInformationField.vue';
import { emptyStoryboardAssetRequirements, snapshotStoryboard } from './storyboard-state';
import StoryboardAssetRequirements from './StoryboardAssetRequirements.vue';
const props = defineProps<{
  shot: CustomizedStoryboardShot;
  index: number;
  total: number;
  editable: boolean;
  assets: CustomizedStoryboardAsset[];
  shots: CustomizedStoryboardShot[];
}>();
const emit = defineEmits<{
  update: [shot: CustomizedStoryboardShot, assets: CustomizedStoryboardAsset[]];
  edit: [];
  remove: [];
  move: [offset: number];
  regenerate: [];
  dragStart: [id: string];
  drop: [id: string];
}>();
const local = ref<CustomizedStoryboardShot | null>(null),
  expanded = ref(false);
const localAssets = ref<CustomizedStoryboardAsset[]>([]);
const editing = computed(() => local.value !== null);
const validDuration = computed(
  () =>
    !!local.value &&
    Number.isFinite(local.value.durationSeconds) &&
    local.value.durationSeconds > 0 &&
    local.value.durationSeconds <= 3600,
);
const validShot = computed(
  () =>
    validDuration.value &&
    isCustomizedStoryboardScript({
      id: 'local-validation',
      name: '',
      synopsis: '',
      structure: '',
      productFocus: '',
      assets: localAssets.value,
      shots: [local.value],
    }),
);
const shotTypes = ['远景', '全景', '中景', '近景', '特写', '大特写', '微距'];
const cameraMovements = [
  '固定镜头',
  '缓慢推进',
  '缓慢拉远',
  '横向轻移',
  '跟随运镜',
  '环绕运镜',
  '手持轻移',
];
const begin = () => {
  local.value = snapshotStoryboard(props.shot);
  local.value.assetRequirements ??= emptyStoryboardAssetRequirements();
  localAssets.value = snapshotStoryboard(props.assets);
};
const addDialogue = () =>
  local.value?.dialogues.push({ id: crypto.randomUUID(), speaker: '', text: '' });
const save = () => {
  if (local.value && validShot.value) {
    emit('update', snapshotStoryboard(local.value), snapshotStoryboard(localAssets.value));
    local.value = null;
  }
};
const dragging = (e: DragEvent) => {
  if (!props.editable || editing.value) {
    e.preventDefault();
    return;
  }
  e.dataTransfer?.setData('text/plain', props.shot.id);
  emit('dragStart', props.shot.id);
};
defineExpose({
  id: () => props.shot.id,
  begin,
  hasPendingEdit: () => editing.value,
  cancel: () => {
    local.value = null;
  },
});
</script>
<template>
  <article
    class="shot-card"
    :class="{ 'is-editing': editing }"
    :aria-label="`镜头 ${index + 1}`"
    @dragover.prevent
    @drop.prevent="editable && emit('drop', shot.id)"
  >
    <header>
      <span
        class="drag-handle"
        :draggable="editable && !editing"
        :title="editable ? '拖动调整镜头顺序' : '镜头顺序'"
        @dragstart="dragging"
        ><GripVertical :size="16"
      /></span>
      <span class="shot-number">{{ String(index + 1).padStart(2, '0') }}</span>
      <strong>{{ shot.title || '未命名镜头' }}</strong>
      <div class="shot-meta">
        <span>{{ shot.shotType }}</span
        ><span>{{ shot.cameraMovement }}</span
        ><span><Clock3 :size="12" />{{ shot.durationSeconds }} 秒</span>
      </div>
      <div class="shot-actions">
        <template v-if="editing"
          ><button type="button" @click="local = null"><X :size="13" />取消</button
          ><button class="accent" type="button" :disabled="!validShot" @click="save">
            <Check :size="13" />保存镜头
          </button></template
        >
        <template v-else
          ><button type="button" :disabled="!editable" @click="emit('edit')">
            <Pencil :size="13" />编辑</button
          ><button type="button" :disabled="!editable" @click="emit('regenerate')">
            <RefreshCw :size="13" />重新创作</button
          ><button
            type="button"
            :disabled="!editable || index === 0"
            aria-label="上移镜头"
            @click="emit('move', -1)"
          >
            <ArrowUp :size="14" /></button
          ><button
            type="button"
            :disabled="!editable || index === total - 1"
            aria-label="下移镜头"
            @click="emit('move', 1)"
          >
            <ArrowDown :size="14" /></button
          ><button
            class="danger"
            type="button"
            :disabled="!editable"
            aria-label="删除镜头"
            @click="emit('remove')"
          >
            <Trash2 :size="14" /></button
        ></template>
      </div>
    </header>
    <div class="shot-layout">
      <div class="shot-script">
        <div v-if="local" class="shot-editor">
          <div class="shot-editor-meta">
            <WorkflowInformationField v-model="local.title" label="镜头名称" /><label
              >景别<select v-model="local.shotType">
                <option v-if="local.shotType && !shotTypes.includes(local.shotType)">
                  {{ local.shotType }}
                </option>
                <option v-for="v in shotTypes" :key="v">
                  {{ v }}
                </option>
              </select></label
            ><label
              >运镜<select v-model="local.cameraMovement">
                <option
                  v-if="local.cameraMovement && !cameraMovements.includes(local.cameraMovement)"
                >
                  {{ local.cameraMovement }}
                </option>
                <option v-for="v in cameraMovements" :key="v">
                  {{ v }}
                </option>
              </select></label
            ><label
              >时长（秒）<input
                v-model.number="local.durationSeconds"
                type="number"
                min="1"
                max="3600"
            /></label>
          </div>
          <p v-if="!validDuration" role="alert" class="muted">镜头时长需在 1–3600 秒之间。</p>
          <div class="shot-body">
            <WorkflowInformationField
              v-model="local.visual"
              label="画面内容描述"
              multiline
              placeholder="描述主体、场景和一个完整的观看事件"
            />
            <section class="dialogue-editor">
              <div class="field-heading">
                <span>台词 / 口播</span
                ><button type="button" @click="addDialogue"><Plus :size="13" />添加台词</button>
              </div>
              <div v-for="d in local.dialogues" :key="d.id" class="dialogue-row">
                <input
                  v-model="d.speaker"
                  aria-label="说话者"
                  placeholder="人物名称 / 旁白"
                /><textarea
                  v-model="d.text"
                  aria-label="台词内容"
                  placeholder="填写台词内容"
                /><button
                  type="button"
                  aria-label="移除台词"
                  @click="local.dialogues = local.dialogues.filter((i) => i.id !== d.id)"
                >
                  <X :size="14" />
                </button>
              </div>
              <p v-if="!local.dialogues.length" class="muted">没有台词时，可保留为空。</p>
            </section>
          </div>
          <WorkflowInformationField
            v-model="local.audio"
            label="音效 / 音乐提示"
            multiline
          /><WorkflowInformationField v-model="local.continuity" label="衔接注意事项" multiline />
        </div>
        <template v-else
          ><div class="shot-body">
            <section class="visual">
              <div class="field-heading">画面内容描述</div>
              <p>{{ shot.visual || '尚未填写画面内容' }}</p>
            </section>
            <section class="dialogue">
              <div class="field-heading">台词 / 口播</div>
              <div v-for="d in shot.dialogues" :key="d.id" class="dialogue-line">
                <span>{{ d.speaker || '未指定说话者' }}</span>
                <p>{{ d.text }}</p>
              </div>
              <p v-if="!shot.dialogues.length" class="muted">无台词，以画面与环境声表达</p>
            </section>
          </div>
          <div class="audio">
            <span>音效 / 音乐</span>
            <p>{{ shot.audio || '尚未设置' }}</p>
            <button type="button" :aria-expanded="expanded" @click="expanded = !expanded">
              衔接说明<ChevronDown :size="14" :class="{ rotated: expanded }" />
            </button>
          </div>
          <p v-if="expanded" class="continuity">
            {{ shot.continuity || '尚未填写衔接说明，可在编辑中补充。' }}
          </p></template
        >
      </div>
      <StoryboardAssetRequirements
        v-if="local"
        v-model:requirements="local.assetRequirements"
        v-model:assets="localAssets"
        :shots="shots"
        :shot-id="shot.id"
        :editable="editable"
      />
      <StoryboardAssetRequirements
        v-else
        :requirements="shot.assetRequirements"
        :assets="assets"
        :shots="shots"
        :shot-id="shot.id"
      />
    </div>
  </article>
</template>
<style scoped>
.shot-card {
  min-width: 0;
  overflow: hidden;
  background: #fff;
  border: 1px solid #dce4f0;
  border-radius: 16px;
  box-shadow: 0 4px 16px #25385805;
}
.shot-card.is-editing {
  border-color: #99b8eb;
  box-shadow: 0 0 0 3px #2563eb08;
}
header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 18px;
  background: #f7f9fd;
  border-bottom: 1px solid #e4eaf3;
  flex-wrap: wrap;
}
header strong {
  font-size: 14px;
  color: #23344d;
}
.drag-handle {
  display: flex;
  color: #a2afc2;
  cursor: grab;
}
.shot-number {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  color: #3c67a9;
  background: #eaf0fa;
  border: 1px solid #dce6f5;
  border-radius: 8px;
  font-size: 12px;
  font-weight: 750;
}
.shot-meta,
.shot-actions {
  display: flex;
  align-items: center;
  gap: 7px;
}
.shot-meta {
  margin-left: 8px;
  color: #738198;
  font-size: 11px;
}
.shot-meta > span {
  display: flex;
  align-items: center;
  gap: 4px;
}
.shot-meta > span + span {
  border-left: 1px solid #dbe3ef;
  padding-left: 9px;
}
.shot-actions {
  margin-left: auto;
}
button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  min-height: 30px;
  padding: 0 9px;
  background: #fff;
  border: 1px solid #d7e1f0;
  border-radius: 7px;
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
button.accent {
  color: #2563eb;
  border-color: #b5cafa;
}
.danger {
  color: #af6570;
}
.shot-body {
  display: grid;
  grid-template-columns: minmax(0, 1.55fr) minmax(0, 1fr);
  gap: 0;
}
.shot-layout {
  display: grid;
  grid-template-columns: minmax(0, 1.25fr) minmax(480px, 1fr);
}
.shot-script {
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.shot-script > .shot-body {
  flex: 1;
  align-content: start;
  grid-template-columns: 1fr;
}
.shot-script > .shot-body .visual {
  padding: 24px 26px;
}
.shot-script > .shot-body .visual p {
  font-size: 14px;
  line-height: 2;
}
.shot-script > .shot-body .dialogue {
  border-left: 0;
  border-top: 1px solid #ecf0f5;
  padding: 20px 26px;
}
.shot-layout > :deep(.asset-requirements) {
  border-left: 1px solid #e4eaf3;
}
.shot-editor .shot-body {
  grid-template-columns: minmax(0, 1.5fr) minmax(0, 1fr);
}
.visual,
.dialogue {
  padding: 20px 22px;
}
.dialogue {
  border-left: 1px solid #ecf0f5;
  background: #fcfdff;
}
.field-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: #7b899e;
  font-size: 11px;
  font-weight: 700;
}
.visual p,
.dialogue p {
  margin: 10px 0 0;
  line-height: 1.9;
  font-size: 13px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: #3e4f67;
}
.dialogue-line + .dialogue-line {
  margin-top: 13px;
}
.dialogue-line > span {
  display: inline-block;
  margin-top: 10px;
  color: #536c8f;
  font-size: 10px;
  border: 1px solid #e1e8f2;
  padding: 3px 7px;
  border-radius: 5px;
  background: #fff;
}
.dialogue-line p {
  margin-top: 5px;
}
.muted {
  color: #98a4b7 !important;
  font-size: 12px !important;
}
.audio {
  display: flex;
  align-items: flex-start;
  gap: 14px;
  padding: 12px 22px;
  border-top: 1px solid #edf1f7;
  background: #fdfdfe;
}
.audio > span {
  padding-top: 4px;
  white-space: nowrap;
  color: #8190a5;
  font-size: 11px;
}
.audio p {
  flex: 1;
  margin: 2px 0;
  font-size: 12px;
  line-height: 1.7;
  color: #65758d;
  white-space: pre-wrap;
}
.audio button {
  border: 0;
  background: transparent;
  color: #71849e;
}
.rotated {
  transform: rotate(180deg);
}
.continuity {
  margin: 0;
  padding: 12px 22px;
  border-top: 1px dashed #e1e7f0;
  background: #f8faff;
  color: #738198;
  font-size: 12px;
  line-height: 1.7;
  white-space: pre-wrap;
}
.shot-editor {
  display: grid;
  gap: 20px;
  padding: 20px;
}
.shot-editor-meta {
  display: grid;
  grid-template-columns: 2fr 1fr 1.3fr 0.7fr;
  gap: 14px;
}
.shot-editor-meta label {
  display: grid;
  gap: 8px;
  align-content: start;
  color: #596278;
  font-size: 14px;
  font-weight: 650;
}
.shot-editor-meta input,
.shot-editor-meta select,
.dialogue-row input,
.dialogue-row textarea {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  padding: 10px 12px;
  border: 1px solid #d4dfef;
  border-radius: 9px;
  color: #42526a;
  background: #fff;
  font: inherit;
  font-size: 13px;
}
.shot-editor .shot-body {
  gap: 20px;
}
.dialogue-editor {
  display: grid;
  align-content: start;
  gap: 10px;
}
.dialogue-row {
  display: grid;
  grid-template-columns: 110px minmax(0, 1fr) 30px;
  gap: 8px;
  align-items: start;
}
.dialogue-row textarea {
  min-height: 80px;
  resize: vertical;
}
.dialogue-row button {
  padding: 0;
}
.shot-editor :deep(textarea) {
  min-height: 100px;
}
@media (max-width: 1100px) {
  .shot-layout {
    grid-template-columns: 1fr;
  }
  .shot-layout > :deep(.asset-requirements) {
    border-left: 0;
    border-top: 1px solid #e4eaf3;
  }
  .shot-meta {
    margin-left: 0;
  }
  .shot-actions {
    width: 100%;
    justify-content: flex-end;
  }
  .shot-editor-meta {
    grid-template-columns: 1fr 1fr;
  }
}
@media (max-width: 600px) {
  .shot-script > .shot-body .visual,
  .shot-script > .shot-body .dialogue {
    padding: 16px;
  }
  header {
    padding: 12px;
    gap: 7px;
  }
  .shot-layout .shot-body {
    grid-template-columns: 1fr;
  }
  .dialogue {
    border-left: 0;
    border-top: 1px solid #edf1f7;
  }
  .visual,
  .dialogue {
    padding: 16px;
  }
  .audio {
    padding: 12px 16px;
    flex-wrap: wrap;
  }
  .audio p {
    flex-basis: 70%;
  }
  .audio button {
    margin-left: auto;
  }
  .shot-editor {
    padding: 14px;
  }
  .dialogue-row {
    grid-template-columns: minmax(0, 1fr) 30px;
  }
  .dialogue-row input {
    grid-column: 1/-1;
  }
  .shot-actions {
    gap: 5px;
  }
  .shot-actions button {
    padding: 0 7px;
  }
}
</style>
