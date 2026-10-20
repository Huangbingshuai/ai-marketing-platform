<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { LoaderCircle, UserRound } from '@lucide/vue';
import AvatarStudio from './AvatarStudio.vue';
const props = withDefaults(
  defineProps<{ projectId?: string; projectName?: string; preview?: boolean }>(),
  { projectId: '', projectName: '', preview: false },
);
const scope = computed(() => props.projectId || 'isolated-avatar-preview');
const key = computed(() => `ai-marketing.mock.FISSION_AVATAR.enabled.${scope.value}`);
const enabled = ref(props.preview || localStorage.getItem(key.value) === '1');
const scenario = ref('normal');
const loading = ref(false);
const studio = ref<InstanceType<typeof AvatarStudio>>();
let timer: ReturnType<typeof setTimeout> | undefined;
function enable() {
  enabled.value = true;
  localStorage.setItem(key.value, '1');
  loading.value = true;
  timer = setTimeout(() => (loading.value = false), 300);
}
watch(scenario, () => {
  clearTimeout(timer);
  loading.value = scenario.value === 'loading';
  if (loading.value)
    timer = setTimeout(() => {
      loading.value = false;
      scenario.value = 'normal';
    }, 1600);
});
watch(scope, () => {
  enabled.value = props.preview || localStorage.getItem(key.value) === '1';
  scenario.value = 'normal';
});
defineExpose({
  flushPendingEdits: async () => (await studio.value?.flushPendingEdits()) ?? true,
  workflowRunId: '',
});
onBeforeUnmount(() => clearTimeout(timer));
</script>
<template>
  <section class="avatar-workspace">
    <div class="avatar-demo-controls">
      <span
        ><i />{{ enabled ? '本地 Mock 演示 · 草稿仅保存在当前浏览器' : '数字人口播前端预览' }}</span
      ><label v-if="enabled"
        >演示状态<select v-model="scenario" aria-label="Mock 演示状态">
          <option value="normal">正常流程</option>
          <option value="empty">空数据</option>
          <option value="loading">加载中</option>
          <option value="error">加载失败</option>
          <option value="failure">生成失败</option>
          <option value="partial">部分失败</option>
        </select></label
      >
    </div>
    <div v-if="!enabled" class="avatar-placeholder">
      <UserRound :size="42" />
      <h2>数字人口播剪辑工作台</h2>
      <p>参照产品原型体验数字人、音色、口播文案、背景、字幕及时间轴编辑。</p>
      <small>真实生成服务尚未接入。启用演示后使用独立 Mock 数据，不产生付费任务。</small
      ><button @click="enable">启用 Mock 演示</button>
    </div>
    <div v-else-if="loading" class="avatar-placeholder" role="status">
      <LoaderCircle :size="32" class="avatar-spin" />
      <h2>正在加载数字人口播工作台…</h2>
    </div>
    <div v-else-if="scenario === 'error'" class="avatar-placeholder" role="alert">
      <h2>数字人素材加载失败</h2>
      <p>这是显式选择的 Mock 错误状态，草稿已保留。</p>
      <button @click="scenario = 'normal'">重新加载</button>
    </div>
    <AvatarStudio
      v-else
      :key="scope"
      ref="studio"
      :project-id="scope"
      :project-name="projectName || '广味食品 · 广式腊味夏季投放'"
      :scenario="scenario"
    />
  </section>
</template>
<style scoped>
.avatar-demo-controls {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 30px;
  margin: 0 2px 8px;
  font-size: 10px;
  color: #718096;
}
.avatar-demo-controls > span {
  display: flex;
  align-items: center;
  gap: 6px;
}
.avatar-demo-controls i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #14b8a6;
}
.avatar-demo-controls label {
  display: flex;
  gap: 8px;
  align-items: center;
}
.avatar-demo-controls select {
  padding: 4px 8px;
  border: 1px solid #dbe4f6;
  border-radius: 6px;
  background: #fff;
  font-size: 10px;
  color: #475569;
}
.avatar-placeholder {
  display: flex;
  min-height: 570px;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  padding: 24px;
  border: 1px solid #dbe4f6;
  border-radius: 20px;
  background: #fff;
  text-align: center;
  color: #718096;
}
.avatar-placeholder h2 {
  margin: 0;
  color: #172033;
  font-size: 20px;
}
.avatar-placeholder p {
  margin: 0;
  font-size: 13px;
}
.avatar-placeholder small {
  font-size: 11px;
}
.avatar-placeholder > svg {
  color: #2563eb;
}
.avatar-placeholder button {
  padding: 10px 20px;
  border: 0;
  border-radius: 8px;
  background: #2563eb;
  color: white;
  cursor: pointer;
}
.avatar-spin {
  animation: avatar-spin 1s linear infinite;
}
@keyframes avatar-spin {
  to {
    transform: rotate(360deg);
  }
}
@media (max-width: 700px) {
  .avatar-demo-controls {
    flex-wrap: wrap;
  }
}
</style>
