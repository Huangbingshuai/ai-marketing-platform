<script setup lang="ts">
import { AlertCircle, Check, ChevronRight, GitBranch } from '@lucide/vue';
import { computed } from 'vue';
import { EFFECT_NODE_LABELS } from '../../shared/effect-node-labels';

const props = withDefaults(
  defineProps<{
    activeStep: number;
    staleCounts?: readonly number[];
    // Absence selects the effect workflow's built-in nodes.
    // eslint-disable-next-line vue/require-default-prop
    nodes?: readonly { label: string; status: string; title: string; description: string }[];
    workflowLabel?: string;
    workflowNumber?: string;
    showBranches?: boolean;
    disabled?: boolean;
  }>(),
  {
    showBranches: true,
    workflowLabel: '效果类',
    workflowNumber: '01',
    staleCounts: () => [],
  },
);
const emit = defineEmits<{ select: [step: number]; branches: [] }>();

const effectNodes = [
  {
    label: EFFECT_NODE_LABELS.SOURCE_IMPORT,
    status: '就绪',
    title: EFFECT_NODE_LABELS.SOURCE_IMPORT,
    description: '汇集商品图片、文档与链接，统一视频生产规格',
  },
  {
    label: EFFECT_NODE_LABELS.INFORMATION_EXTRACTION,
    status: '就绪',
    title: EFFECT_NODE_LABELS.INFORMATION_EXTRACTION,
    description: '把非结构化资料整理为可人工修订的制作信息卡',
  },
  {
    label: EFFECT_NODE_LABELS.PROMPT_GENERATION,
    status: '就绪',
    title: EFFECT_NODE_LABELS.PROMPT_GENERATION,
    description: '批量生成带用途标签的素材片段 Prompt，不生成完整成片脚本',
  },
  {
    label: EFFECT_NODE_LABELS.SEGMENT_RENDER,
    status: '就绪',
    title: EFFECT_NODE_LABELS.SEGMENT_RENDER,
    description: '每条 Prompt 渲染为一个可供混剪的视频素材片段',
  },
  {
    label: EFFECT_NODE_LABELS.TEMPLATE_MIX,
    status: '就绪',
    title: EFFECT_NODE_LABELS.TEMPLATE_MIX,
    description: '按模板规则批量搭建成片工程，再逐条进入时间轴精修',
  },
  {
    label: EFFECT_NODE_LABELS.FINAL_OUTPUT,
    status: '就绪',
    title: EFFECT_NODE_LABELS.FINAL_OUTPUT,
    description: '渲染已统一确认的成片，查看进度、恢复失败项、分页播放与下载',
  },
] as const;
const nodes = computed(() => props.nodes ?? effectNodes);

type NodeState = 'completed' | 'current' | 'ready';

const currentNode = computed(
  () => nodes.value[props.activeStep] ?? nodes.value[0] ?? effectNodes[0],
);
const currentStepLabel = computed(() => String(props.activeStep + 1).padStart(2, '0'));
const staleCount = (index: number) => props.staleCounts?.[index] ?? 0;
const statusText = (index: number) =>
  staleCount(index) > 0
    ? '待更新'
    : index === props.activeStep
      ? '当前'
      : nodes.value[index]?.status;

const nodeState = (index: number): NodeState => {
  if (index === props.activeStep) return 'current';
  if (index < props.activeStep) return 'completed';
  return 'ready';
};
</script>

<template>
  <section class="effect-flow" :aria-label="`${workflowLabel ?? '效果类'}工作流节点`">
    <header class="effect-flow__title-row">
      <div>
        <span class="effect-flow__eyebrow">WORKFLOW {{ workflowNumber ?? '01' }}</span>
        <h2>{{ currentNode.title }}</h2>
        <p>{{ currentNode.description }}</p>
      </div>
      <div class="effect-flow__actions">
        <button
          v-if="showBranches !== false"
          type="button"
          class="effect-flow__branch-button"
          @click="emit('branches')"
        >
          <GitBranch :size="15" aria-hidden="true" />查看版本分支树
        </button>
        <div class="effect-flow__progress" aria-label="当前步骤">
          <strong>{{ currentStepLabel }}</strong
          ><span>/ {{ String(nodes.length).padStart(2, '0') }}</span>
        </div>
      </div>
    </header>

    <div class="effect-flow__track">
      <template v-for="(node, index) in nodes" :key="node.title">
        <article
          class="effect-flow__node"
          :class="[nodeState(index), { 'needs-update': staleCount(index) > 0 }]"
        >
          <button
            type="button"
            class="effect-flow__main"
            :disabled="disabled"
            :aria-current="index === activeStep ? 'step' : undefined"
            :title="staleCount(index) > 0 ? `${node.title}待更新，旧结果仍可查看` : node.title"
            @click="emit('select', index)"
          >
            <span class="effect-flow__number">
              <AlertCircle
                v-if="staleCount(index) > 0"
                :size="17"
                :stroke-width="2.5"
                aria-hidden="true"
              />
              <Check v-else-if="nodeState(index) === 'completed'" :size="12" :stroke-width="3" />
              <template v-else>{{ index + 1 }}</template>
            </span>
            <span class="effect-flow__copy">
              <b>{{ node.label }}</b>
              <small>{{ statusText(index) }}</small>
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
.effect-flow__actions {
  display: flex;
  align-items: center;
  gap: 16px;
}
.effect-flow__branch-button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 11px;
  color: #2455b8;
  background: #f6f9ff;
  border: 1px solid #cbdafa;
  border-radius: 10px;
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
}
.effect-flow__branch-button:hover {
  background: #eaf1ff;
}
.effect-flow__branch-button:focus-visible {
  outline: 2px solid #2563eb;
  outline-offset: 2px;
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
  transition:
    border-color 0.18s ease,
    box-shadow 0.18s ease,
    background-color 0.18s ease;
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
.effect-flow__node.needs-update {
  background: #fffaf1;
  border-color: #f3ae54;
  box-shadow: inset 0 3px 0 #f59e0b;
}
.effect-flow__node.needs-update.current {
  border: 1.5px solid transparent;
  background:
    linear-gradient(135deg, #eff5ff 0%, #fff4df 100%) padding-box,
    linear-gradient(112deg, #2563eb 0%, #7652c8 48%, #d97706 100%) border-box;
  box-shadow:
    0 4px 14px rgba(37, 99, 235, 0.2),
    0 2px 9px rgba(217, 119, 6, 0.17);
}
.effect-flow__node.needs-update .effect-flow__number {
  color: #b45309;
  background: #fff0d4;
}
.effect-flow__node.needs-update small {
  color: #b45309;
  font-weight: 800;
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
  .effect-flow__title-row {
    gap: 8px;
  }
  .effect-flow__actions {
    align-items: flex-end;
    flex-direction: column-reverse;
    gap: 5px;
  }
  .effect-flow__branch-button {
    white-space: nowrap;
  }
}
</style>
