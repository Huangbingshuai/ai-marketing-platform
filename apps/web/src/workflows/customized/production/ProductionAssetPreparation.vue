<script setup lang="ts">
import {
  ASSET_FIELD_LABELS,
  type ProductionAsset,
  type AssetPreparation,
} from '@ai-marketing/contracts';
import WorkflowInformationField from '../../../platform/workflow/components/WorkflowInformationField.vue';
defineProps<{ asset: ProductionAsset; readonly?: boolean }>();
const emit = defineEmits<{ update: [value: AssetPreparation] }>();
function detail(prep: AssetPreparation, key: string, value: string) {
  emit('update', {
    ...prep,
    details: prep.details.map((d) => (d.key === key ? { ...d, value } : d)),
  });
}
</script>
<template>
  <div v-if="asset.preparation" class="preparation-detail">
    <p class="purpose">
      {{ asset.preparation.usage
      }}<span>{{
        { INDEPENDENT: '独立对象', SCENE_DETAIL: '随场景制作', CHARACTER_DETAIL: '随人物制作' }[
          asset.preparation.treatment
        ]
      }}</span>
    </p>
    <div class="definition-grid">
      <WorkflowInformationField
        v-for="d in asset.preparation.details"
        :key="d.key"
        :label="ASSET_FIELD_LABELS[d.key] ?? d.key"
        :model-value="d.value"
        multiline
        :readonly="readonly"
        @update:model-value="detail(asset.preparation!, d.key, $event)"
      />
    </div>
    <div v-if="asset.preparation.questions.length" class="open-questions">
      <h4>制作前待确认</h4>
      <article v-for="(q, index) in asset.preparation.questions" :key="index">
        <strong>{{ q.question }}</strong>
        <p>{{ q.impact }}</p>
        <button
          v-if="!readonly"
          type="button"
          @click="
            emit('update', {
              ...asset.preparation,
              questions: asset.preparation.questions.filter((_, i) => i !== index),
            })
          "
        >
          已处理，移除此项
        </button>
      </article>
    </div>
    <details>
      <summary>图片制作清单 · {{ asset.preparation.images.length }} 项</summary>
      <article v-for="(item, index) in asset.preparation.images" :key="index" class="image-need">
        <strong>{{ item.name }}</strong>
        <p>{{ item.purpose }}</p>
        <p>{{ item.requirements }}</p>
      </article>
      <p v-if="!asset.preparation.images.length">暂不需要独立制作图片，可按分镜需要补充。</p>
    </details>
    <details>
      <summary>原文依据 · {{ asset.preparation.sources.length }} 处</summary>
      <article v-for="(source, index) in asset.preparation.sources" :key="index" class="evidence">
        <small
          >{{ source.source === 'BRIEF' ? '已确认信息卡' : '当前脚本' }} ·
          {{ ASSET_FIELD_LABELS[source.field] ?? '对象依据' }}</small
        >
        <blockquote>{{ source.quote }}</blockquote>
      </article>
    </details>
    <p v-if="asset.manualFields?.length" class="protected">人工修改会在重新整理时保留。</p>
  </div>
</template>
<style scoped>
.preparation-detail {
  display: grid;
  gap: 16px;
  color: #33455e;
}
.purpose {
  line-height: 1.7;
  font-size: 13px;
}
.purpose span {
  display: inline-block;
  margin-left: 10px;
  padding: 2px 8px;
  background: #eef4ff;
  border-radius: 6px;
  color: #42638d;
  font-size: 11px;
}
.definition-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}
details {
  border-top: 1px solid #e7edf5;
  padding-top: 14px;
}
summary {
  cursor: pointer;
  font-size: 13px;
  font-weight: 600;
}
article {
  padding: 12px 0;
  font-size: 13px;
  line-height: 1.65;
}
p {
  margin: 5px 0;
  white-space: pre-wrap;
}
.open-questions {
  padding: 14px 18px;
  border: 1px solid #efdfba;
  border-radius: 12px;
  background: #fffbf2;
}
h4 {
  margin: 0;
  font-size: 14px;
}
.open-questions button {
  color: #796340;
  background: transparent;
  border: 0;
  padding: 5px 0;
  cursor: pointer;
}
blockquote {
  margin: 8px 0 0;
  border-left: 2px solid #ccd9ed;
  padding: 4px 12px;
  white-space: pre-wrap;
}
small,
.protected {
  color: #8190a7;
  font-size: 12px;
}
@media (max-width: 600px) {
  .definition-grid {
    grid-template-columns: 1fr;
  }
}
</style>
