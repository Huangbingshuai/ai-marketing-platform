<script setup lang="ts">
import { computed } from 'vue';
import { Video } from '@lucide/vue';
import type { ProductionAsset, ProductionShot } from '@ai-marketing/contracts';
const props = defineProps<{
  shots: ProductionShot[];
  assets: ProductionAsset[];
  selectedId?: string;
  locked: boolean;
}>();
defineEmits<{ select: [id: string]; produce: [id: string] }>();
type VideoState = 'waiting' | 'generating' | 'done' | 'failed';
const rows = computed(() => {
  const assets = new Map(props.assets.map((asset) => [asset.id, asset]));
  return props.shots.map((shot, index) => ({
    shot,
    index,
    heading: `【镜头${index + 1}】${shot.shotType ? `${shot.shotType}：` : ''}${shot.visual || shot.title || '未命名镜头'}`,
    context:
      shot.bindings.map((b) => assets.get(b.assetId)).find((a) => a?.kind === 'SCENE')?.name || '',
    // Video rendering has no result/task contract yet. Prompt completion is not a rendered video.
    state: 'waiting' as VideoState,
  }));
});
const labels: Record<VideoState, string> = {
  waiting: '待生成',
  generating: '生成中',
  done: '已完成',
  failed: '失败',
};
const number = (index: number) => String(index + 1).padStart(2, '0');
</script>
<template>
  <aside class="shot-task-directory" aria-label="视频任务列表">
    <header>
      <h3>视频任务列表</h3>
      <p>按镜头顺序 · {{ shots.length }} 个任务</p>
    </header>
    <ol aria-label="分镜任务" class="shot-task-list">
      <li
        v-for="row in rows"
        :key="row.shot.id"
        :class="['shot-task-row', { selected: row.shot.id === selectedId }]"
      >
        <button
          class="shot-select"
          type="button"
          :aria-current="row.shot.id === selectedId ? 'true' : undefined"
          :aria-label="`选择镜头${number(row.index)}：${row.shot.title || '未命名镜头'}`"
          :title="row.heading"
          @click="$emit('select', row.shot.id)"
        >
          <span class="shot-preview" aria-label="尚无视频预览"
            ><Video :size="20" :stroke-width="1.3" />
            <span class="shot-index">#{{ number(row.index) }}</span>
          </span>
          <span class="shot-copy">
            <strong>{{ row.heading }}</strong>
            <span class="shot-meta"
              ><span :class="['shot-state', row.state]"><i />{{ labels[row.state] }}</span>
              <span class="separator">·</span><span>{{ row.shot.durationSeconds }}s</span>
              <span v-if="row.context" class="shot-context">· {{ row.context }}</span>
            </span>
          </span>
        </button>
        <button
          class="shot-produce"
          type="button"
          :disabled="locked"
          :aria-label="`打开镜头${number(row.index)}制作`"
          title="查看本镜制作设置"
          @click="$emit('produce', row.shot.id)"
        >
          <Video :size="14" />
        </button>
      </li>
    </ol>
  </aside>
</template>
<style scoped>
.shot-task-directory {
  min-width: 0;
  overflow: hidden;
  border: 1px solid #e1e8f1;
  border-radius: 12px;
  background: #fafbfd;
  color: #304663;
}
header {
  padding: 12px;
  border-bottom: 1px solid #e6ebf3;
}
h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 650;
}
header p {
  margin: 5px 0 0;
  font-size: 11px;
  color: #8a98ac;
  line-height: 1.5;
}
button {
  font: inherit;
  cursor: pointer;
}
.shot-task-list {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 720px;
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: #cbd5e2 transparent;
}
.shot-task-row {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 6px 8px;
  min-width: 0;
  position: relative;
  border-bottom: 1px solid #edf0f5;
}
.shot-task-row:last-child {
  border-bottom: 0;
}
.shot-task-row:hover {
  background: #f3f6fc;
}
.shot-task-row.selected {
  background: #edf3ff;
  box-shadow: inset 0 0 0 1.5px #a9bff0;
}
.shot-select {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0;
  margin: 0;
  min-width: 0;
  flex: 1;
  border: 0;
  text-align: left;
  color: inherit;
  background: transparent;
}
.shot-preview {
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  width: 56px;
  height: 34px;
  flex-shrink: 0;
  border-radius: 5px;
  border: 1px solid #dce4ef;
  background: #edf1f7;
  color: #a4b0c1;
}
.shot-index {
  position: absolute;
  top: 2px;
  left: 3px;
  background: #64758c;
  border-radius: 3px;
  color: white;
  padding: 1px 3px;
  font-size: 9px;
  line-height: 1.2;
  font-variant-numeric: tabular-nums;
}
.shot-copy {
  display: grid;
  gap: 3px;
  min-width: 0;
}
.shot-copy > strong {
  font-size: 12px;
  font-weight: 600;
  line-height: 1.4;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.selected .shot-copy > strong {
  color: #315fd5;
}
.shot-meta {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  color: #91a0b5;
  font-size: 10px;
  white-space: nowrap;
}
.shot-state {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
  color: #8b99ab;
}
.shot-state i {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentColor;
}
.shot-context {
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}
.shot-produce {
  width: 28px;
  height: 28px;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  color: #7d90ac;
  background: #edf1f7;
  border: 1px solid #e6ebf3;
  border-radius: 50%;
}
.shot-produce:hover:not(:disabled) {
  color: #315fd5;
  border-color: #b5c9f2;
  background: #e6eeff;
}
button:disabled {
  opacity: 0.45;
  cursor: default;
}
button:focus-visible {
  outline: 2px solid #4b77ed;
  outline-offset: 2px;
}
@media (max-width: 760px) {
  .shot-task-list {
    max-height: 310px;
  }
}
</style>
