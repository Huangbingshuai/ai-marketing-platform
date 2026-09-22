<script setup lang="ts">
import { computed, ref } from 'vue';
import { WorkflowNodeFooter } from '@ai-marketing/ui';
import type { EffectTemplateMixVariant } from '@ai-marketing/contracts';
import Packaging from '../../src/workflows/effect/template-mix/EffectTemplateMixPackaging.vue';
import Output from '../../src/workflows/effect/final-output/EffectFinalOutputNodePage.vue';
const scenario = ref('running'),
  step = ref('packaging'),
  ready = ref(false);
const packaging = ref<InstanceType<typeof Packaging>>();
const variants = Array.from(
  { length: 100 },
  (_, i) =>
    ({
      id: `v${i}`,
      name: `成片 ${i + 1}`,
      slots: [],
      bindings: {},
      bindingRevisions: {},
      offsets: {},
    }) as unknown as EffectTemplateMixVariant,
);
const projectId = computed(() => `fixture-${scenario.value}`);
function change(mode: string) {
  scenario.value = mode;
  ready.value = false;
}
</script>
<template>
  <main style="max-width: 1200px; margin: 20px auto; font-family: system-ui; color: #24354f">
    <h2>隔离测试数据 · 100 条 · 不连接数据库或付费供应商</h2>
    <nav style="display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 20px">
      <button
        v-for="s in ['empty', 'running', 'failed', 'ready', 'stale', 'error']"
        :key="s"
        @click="change(s)"
      >
        {{ s }}
      </button>
      <button @click="step = 'packaging'">包装测试</button
      ><button @click="step = 'output'">输出测试</button>
    </nav>
    <template v-if="step === 'packaging'">
      <button @click="packaging?.open('WORKFLOW')">查看工作流</button>
      <Packaging
        :key="projectId"
        ref="packaging"
        :project-id="projectId"
        workflow-run-id="fixture-run"
        template-id="fixture-template"
        :variants="variants"
        selected-variant-id="v0"
        :prepare="async () => 1"
        :playhead="0"
        :playing="false"
        @ready="ready = $event"
      />
      <WorkflowNodeFooter
        :complete="ready"
        :validate-disabled="!ready"
        :show-next="false"
        validate-label="完成校验并进入成片输出"
        next-label="输出"
        :status-title="ready ? '全部成片就绪' : '等待全部成片成功且未过期'"
        status-detail="隔离浏览器状态测试"
        @validate="step = 'output'"
      />
    </template>
    <Output
      v-else
      :key="projectId"
      :project-id="projectId"
      workflow-run-id="fixture-run"
      @back="step = 'packaging'"
    />
  </main>
</template>
