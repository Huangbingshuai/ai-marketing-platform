<script setup lang="ts">
import { computed } from 'vue';
import { ImagePlus, Video, CircleHelp } from '@lucide/vue';
import type { ProductionAsset, ProductionShot } from '@ai-marketing/contracts';
import WorkflowInformationDialog from '../../../platform/workflow/components/WorkflowInformationDialog.vue';
const props = defineProps<{
  open: boolean;
  type: 'IMAGE' | 'VIDEO';
  assets: ProductionAsset[];
  shot?: ProductionShot;
  prompt?: string;
  ratio?: string;
  resolution?: string;
}>();
defineEmits<{ close: [] }>();
const title = computed(() =>
  props.type === 'IMAGE'
    ? props.assets.length > 1
      ? '批量生成资产图片'
      : '生成资产图片'
    : '渲染当前镜头',
);
</script>
<template>
  <WorkflowInformationDialog
    :open="open"
    :title="title"
    description="核对本次制作内容"
    @close="$emit('close')"
  >
    <div class="render-review">
      <div class="render-intro">
        <component :is="type === 'IMAGE' ? ImagePlus : Video" :size="23" />
        <div>
          <strong>{{
            type === 'IMAGE' ? `${assets.length} 项资产` : shot?.title || '当前镜头'
          }}</strong>
          <p>
            {{
              type === 'IMAGE'
                ? '共用形象用于后续镜头保持一致'
                : `${shot?.durationSeconds ?? 0} 秒 · ${ratio ?? '16:9'} · ${resolution ?? '1080P'} · MP4`
            }}
          </p>
        </div>
      </div>
      <template v-if="type === 'IMAGE'"
        ><article v-for="a in assets" :key="a.id">
          <h3>{{ a.name }}</h3>
          <p>{{ a.description || '尚未补充公共形象' }}</p>
          <dl>
            <dt>图像制作要求</dt>
            <dd>{{ a.imageRequirements || '尚未填写' }}</dd>
            <dt>设计与待确认内容</dt>
            <dd>{{ a.designNotes || '无额外设计要求' }}</dd>
          </dl>
        </article></template
      >
      <template v-else
        ><h3>当前镜头提示词</h3>
        <p class="prompt">{{ prompt || '请先生成并保存当前镜头提示词' }}</p>
        <h3>本镜参考素材</h3>
        <div class="asset-chips">
          <span v-for="a in assets" :key="a.id"
            >{{ a.name }} · {{ a.image ? '已关联图片' : '图片待准备' }}</span
          ><span v-if="!assets.length">本镜尚未绑定素材</span>
        </div></template
      >
      <div class="unavailable">
        <CircleHelp :size="18" />
        <p>
          {{
            type === 'IMAGE'
              ? '图片生成服务尚未接通。可先整理资产定义并继续分镜，图片稍后补齐。'
              : '视频渲染服务尚未接通。分镜、素材绑定与提示词可正常编辑和保存。'
          }}
        </p>
      </div>
      <footer>
        <button @click="$emit('close')">返回工作台</button
        ><button class="primary" disabled>
          {{ type === 'IMAGE' ? '图片生成暂不可用' : '视频渲染暂不可用' }}
        </button>
      </footer>
    </div>
  </WorkflowInformationDialog>
</template>
<style scoped>
.render-review {
  display: grid;
  gap: 20px;
  color: #263b56;
}
.render-intro {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 18px;
  background: #f7f9fc;
  border: 1px solid #e6ebf2;
  border-radius: 12px;
}
.render-intro svg {
  color: #527ab7;
}
p {
  font-size: 13px;
  line-height: 1.8;
  color: #738197;
  margin: 6px 0 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
h3 {
  font-size: 14px;
  margin: 0 0 10px;
}
article {
  border-bottom: 1px solid #e8edf4;
  padding-bottom: 18px;
}
dl {
  font-size: 12px;
  display: grid;
  grid-template-columns: 120px 1fr;
  gap: 10px;
  margin-bottom: 0;
}
dt {
  color: #8a95a5;
}
dd {
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.asset-chips {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.asset-chips span {
  padding: 7px 10px;
  background: #f3f6fa;
  border-radius: 7px;
  font-size: 12px;
}
.unavailable {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 14px;
  background: #fff9ed;
  border: 1px solid #f0e3c9;
  border-radius: 10px;
  color: #a78343;
}
.unavailable svg {
  flex-shrink: 0;
  margin-top: 4px;
}
.unavailable p {
  margin: 0;
  color: #927346;
}
.prompt {
  max-height: 230px;
  overflow: auto;
  margin: 0;
}
footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}
button {
  border: 1px solid #dce4f0;
  border-radius: 9px;
  padding: 11px 16px;
  background: white;
  color: #526b8c;
  cursor: pointer;
}
.primary {
  background: #315ff2;
  border-color: #315ff2;
  color: white;
}
button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
@media (max-width: 600px) {
  dl {
    grid-template-columns: 1fr;
    gap: 6px;
  }
  footer {
    flex-wrap: wrap;
  }
}
</style>
