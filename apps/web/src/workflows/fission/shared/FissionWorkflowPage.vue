<script setup lang="ts">
import { GitBranch, Replace, UserRound } from '@lucide/vue';
import { ref, watch } from 'vue';
import LocalReplaceWorkspace from '../local-replace/LocalReplaceWorkspace.vue';
const props = withDefaults(
  defineProps<{
    projectId?: string;
    projectName?: string;
    preview?: boolean;
    initialModule?: 'clone' | 'avatar' | 'replace' | '';
  }>(),
  {
    projectId: '',
    projectName: '',
    preview: false,
    initialModule: '',
  },
);
const savedModule = localStorage.getItem('ai-marketing.fission.active-module');
const active = ref(
  props.initialModule ||
    (savedModule && ['clone', 'avatar', 'replace'].includes(savedModule) ? savedModule : 'replace'),
);
watch(active, (value) => localStorage.setItem('ai-marketing.fission.active-module', value));
const workspace = ref<InstanceType<typeof LocalReplaceWorkspace>>();
defineExpose({
  flushPendingEdits: async () => workspace.value?.flushPendingEdits() ?? true,
  workflowRunId: '',
});
</script>
<template>
  <div class="fission-page">
    <nav class="fission-module-tabs" aria-label="裂变功能">
      <button :class="{ active: active === 'clone' }" @click="active = 'clone'">
        <i><GitBranch :size="21" /></i
        ><span><b>爆款视频复刻</b><small>拆解结构 · 映射元素 · 批量裂变</small></span
        ><em>›</em>
      </button>
      <button :class="{ active: active === 'avatar' }" @click="active = 'avatar'">
        <i><UserRound :size="21" /></i
        ><span><b>数字人口播</b><small>定制形象 · 口播驱动 · 长视频输出</small></span
        ><em>›</em>
      </button>
      <button :class="{ active: active === 'replace' }" @click="active = 'replace'">
        <i><Replace :size="21" /></i
        ><span><b>局部元素替换</b><small>精细替换 · 一致性校验 · 快速变体</small></span
        ><em>›</em>
      </button>
    </nav>
    <LocalReplaceWorkspace
      v-if="active === 'replace'"
      ref="workspace"
      :key="projectId || 'preview'"
      :project-id="projectId"
      :project-name="projectName"
      :preview="preview"
    />
    <section v-else class="fission-placeholder">
      <GitBranch :size="36" />
      <h2>{{ active === 'clone' ? '爆款视频复刻' : '数字人口播' }}</h2>
      <p>此模块尚未接入。</p>
      <button class="lr-btn primary" @click="active = 'replace'">返回局部元素替换</button>
    </section>
  </div>
</template>
<style scoped>
.fission-page {
  max-width: 1360px;
  margin: auto;
  padding: 24px 24px 64px;
}
.fission-module-tabs {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 14px;
  margin-bottom: 20px;
}
.fission-module-tabs button {
  display: flex;
  align-items: center;
  gap: 13px;
  padding: 17px 18px;
  border: 1px solid #dbe4f6;
  border-radius: 22px;
  background: #fff;
  color: #475569;
  text-align: left;
}
.fission-module-tabs button.active {
  border-color: #dfd4e4;
  background: #eef3ff;
  box-shadow: 0 0 0 2px #f8e9ed;
}
.fission-module-tabs i {
  display: grid;
  place-items: center;
  width: 42px;
  height: 42px;
  flex-shrink: 0;
  border-radius: 14px;
  background: #f1f5f9;
  font-style: normal;
}
.fission-module-tabs .active i {
  background: #2563eb;
  color: #fff;
}
.fission-module-tabs span {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.fission-module-tabs b {
  font-size: 14px;
  color: #172033;
}
.fission-module-tabs small {
  color: #94a3b8;
  font-size: 11px;
}
.fission-module-tabs em {
  margin-left: auto;
  color: #cbd5e1;
  font-style: normal;
}
.fission-placeholder {
  display: grid;
  justify-items: center;
  gap: 10px;
  padding: 90px 20px;
  background: white;
  border: 1px solid #dbe4f6;
  border-radius: 22px;
  color: #64748b;
}
.fission-placeholder h2,
.fission-placeholder p {
  margin: 0;
}
@media (max-width: 720px) {
  .fission-page {
    padding: 14px 8px 30px;
  }
  .fission-module-tabs {
    grid-template-columns: 1fr;
    gap: 8px;
  }
  .fission-module-tabs button {
    padding: 10px 14px;
    border-radius: 16px;
  }
  .fission-module-tabs span {
    gap: 2px;
  }
}
</style>
