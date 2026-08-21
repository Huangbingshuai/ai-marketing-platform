<script setup lang="ts">
import { Check, ChevronRight } from '@lucide/vue';
import { computed } from 'vue';

const props = defineProps<{
  activeStep: number;
}>();
const emit = defineEmits<{ select: [step: number] }>();

const nodes = [
  {
    label: '导入',
    status: '当前',
    title: '资料包导入',
    description: '汇集商品图片、文档与链接，统一视频生产规格',
  },
  {
    label: '提炼',
    status: '就绪',
    title: 'AI 信息提炼',
    description: '把非结构化资料整理为可人工修订的制作信息卡',
  },
  {
    label: 'Prompt',
    status: '就绪',
    title: 'Prompt 生成',
    description: '通过多维正交组合生成高差异化视频描述',
  },
  {
    label: '渲染',
    status: '就绪',
    title: '片段渲染',
    description: '模拟批量生成带业务标签的视频分镜片段',
  },
  {
    label: '混剪',
    status: '就绪',
    title: '模板混剪',
    description: '按模板规则批量搭建成片工程，再逐条进入时间轴精修',
  },
  {
    label: '导出',
    status: '就绪',
    title: '成片生成与批量导出',
    description: '查看生成进度，支持单选、全选、分页管理与批量导出',
  },
] as const;

type NodeState = 'completed' | 'current' | 'ready';

const currentNode = computed(() => nodes[props.activeStep] ?? nodes[0]);
const currentStepLabel = computed(() => String(props.activeStep + 1).padStart(2, '0'));

const nodeState = (index: number): NodeState => {
  if (index === props.activeStep) return 'current';
  if (index < props.activeStep) return 'completed';
  return 'ready';
};

</script>

<template>
  <section class="effect-flow" aria-label="效果类工作流节点">
    <header class="effect-flow__title-row">
      <div>
        <span class="effect-flow__eyebrow">WORKFLOW 01</span>
        <h2>{{ currentNode.title }}</h2>
        <p>{{ currentNode.description }}</p>
      </div>
      <div class="effect-flow__progress" aria-label="当前步骤">
        <strong>{{ currentStepLabel }}</strong><span>/ 06</span>
      </div>
    </header>

    <div class="effect-flow__track">
      <template v-for="(node, index) in nodes" :key="node.title">
        <article class="effect-flow__node" :class="nodeState(index)">
          <button type="button" class="effect-flow__main" @click="emit('select', index)">
            <span class="effect-flow__number">
              <Check v-if="nodeState(index) === 'completed'" :size="12" :stroke-width="3" />
              <template v-else>{{ index + 1 }}</template>
            </span>
            <span class="effect-flow__copy">
              <b>{{ node.label }}</b>
              <small>{{ node.status }}</small>
            </span>
          </button>
        </article>
        <ChevronRight
          v-if="index < nodes.length - 1"
          class="effect-flow__connector"
          :class="nodeState(index)"
          :size="12"
          aria-hidden="true"
        />
      </template>
    </div>

    <div v-if="activeStep > 0" class="effect-flow__notice" role="note">
      <svg class="effect-flow__notice-icon" viewBox="0 0 1024 1024" aria-hidden="true">
        <path
          fill="currentColor"
          d="M512 64a448 448 0 1 1 0 896.064A448 448 0 0 1 512 64m67.2 275.072c33.28 0 60.288-23.104 60.288-57.344s-27.072-57.344-60.288-57.344c-33.28 0-60.16 23.104-60.16 57.344s26.88 57.344 60.16 57.344M590.912 699.2c0-6.848 2.368-24.64 1.024-34.752l-52.608 60.544c-10.88 11.456-24.512 19.392-30.912 17.28a12.99 12.99 0 0 1-8.256-14.72l87.68-276.992c7.168-35.136-12.544-67.2-54.336-71.296-44.096 0-108.992 44.736-148.48 101.504 0 6.784-1.28 23.68.064 33.792l52.544-60.608c10.88-11.328 23.552-19.328 29.952-17.152a12.8 12.8 0 0 1 7.808 16.128L388.48 728.576c-10.048 32.256 8.96 63.872 55.04 71.04 67.84 0 107.904-43.648 147.456-100.416z"
        />
      </svg>
      <span>任意节点均可回退编辑；修改后下游会标记为待更新，可一键按影响范围增量刷新。</span>
    </div>
  </section>
</template>

<style scoped>
.effect-flow {
  margin-bottom: 18px;
  padding: 18px 22px 16px;
  color: #253047;
  background: #fff;
  border: 1px solid #dbe4f6;
  border-radius: 20px;
  box-shadow: 0 12px 34px rgba(30, 64, 175, 0.07);
  box-sizing: border-box;
  overflow: hidden;
}
.effect-flow__title-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
}
.effect-flow__eyebrow {
  color: #2563eb;
  font-size: 11px;
  font-weight: 900;
  letter-spacing: 1.8px;
}
.effect-flow__title-row h2 {
  margin: 3px 0 4px;
  color: #182236;
  font-size: 22px;
  line-height: normal;
}
.effect-flow__title-row p {
  margin: 0;
  color: #7d8698;
  font-size: 12px;
  line-height: normal;
}
.effect-flow__progress {
  display: flex;
  align-items: baseline;
  color: #253047;
}
.effect-flow__progress strong {
  color: #2563eb;
  font-size: 30px;
  line-height: normal;
}
.effect-flow__progress span {
  color: #a7adba;
  font-weight: 700;
}
.effect-flow__track {
  display: flex;
  margin-top: 14px;
  padding: 2px 0 4px;
  align-items: stretch;
  overflow-x: auto;
  scrollbar-color: #cbd5e1 transparent;
  scrollbar-width: thin;
}
.effect-flow__node {
  min-width: 118px;
  min-height: 70px;
  flex: 1 1 0;
  background: #fff;
  border: 1px solid #e8edf5;
  border-radius: 13px;
  box-sizing: border-box;
  overflow: hidden;
  transition: border-color 0.18s ease, box-shadow 0.18s ease, background-color 0.18s ease;
}
.effect-flow__node.current {
  background: #fbfdff;
  border-color: #93b4ff;
  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.08);
}
.effect-flow__node.completed {
  border-color: #a7e3d2;
}
.effect-flow__main {
  display: flex;
  width: 100%;
  padding: 8px 9px;
  align-items: center;
  gap: 6px;
  color: inherit;
  background: transparent;
  border: 0;
  box-sizing: border-box;
  cursor: pointer;
  text-align: left;
}
.effect-flow__number {
  display: grid;
  width: 27px;
  height: 27px;
  flex: 0 0 27px;
  place-items: center;
  color: #64748b;
  background: #f1f5f9;
  border-radius: 8px;
  font-size: 11px;
  font-weight: 900;
}
.effect-flow__copy {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 2px;
}
.effect-flow__copy b {
  overflow: hidden;
  color: #172033;
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.effect-flow__copy small {
  color: #94a3b8;
  font-size: 9px;
}
.effect-flow__node.current .effect-flow__number {
  color: #fff;
  background: #2563eb;
}
.effect-flow__node.completed .effect-flow__number {
  color: #2aa27d;
  background: #effaf6;
}
.effect-flow__connector {
  width: 18px;
  min-width: 18px;
  height: 70px;
  align-self: stretch;
  color: #cbd5e1;
}
.effect-flow__connector.completed {
  color: #2aa27d;
}
.effect-flow__notice {
  display: flex;
  min-height: 40px;
  margin-top: 18px;
  padding: 8px 16px;
  align-items: center;
  gap: 8px;
  color: #909399;
  background: #f4f4f5;
  border-radius: 12px;
  box-sizing: border-box;
  font-size: 14px;
  line-height: 24px;
}
.effect-flow__notice-icon {
  width: 16px;
  height: 16px;
  flex: 0 0 16px;
}
@media (max-width: 1024px) {
  .effect-flow__node {
    min-width: 112px;
  }
}
@media (max-width: 760px) {
  .effect-flow {
    padding: 15px;
    border-radius: 18px;
  }
  .effect-flow__title-row p {
    max-width: 72vw;
  }
}
</style>
