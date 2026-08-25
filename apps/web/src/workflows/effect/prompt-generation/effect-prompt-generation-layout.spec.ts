import { describe, expect, it } from 'vitest';

import parentSource from '../source-import/EffectImportNodePage.vue?raw';
import pageSource from './EffectPromptGenerationNodePage.vue?raw';

describe('effect prompt generation prototype layout', () => {
  it('reproduces the four-section prompt workspace and ten-item pagination', () => {
    expect(pageSource).toContain('class="effect-prompt-heading"');
    expect(pageSource).toContain('class="effect-prompt-settings"');
    expect(pageSource).toMatch(/grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/u);
    expect(pageSource).toContain('class="effect-prompt-stats"');
    expect(pageSource).toContain('class="effect-prompt-toolbar"');
    expect(pageSource).toContain('class="prompt-card"');
    expect(pageSource).toMatch(/grid-template-columns:\s*43px\s+minmax\(0,\s*1fr\)\s+134px/u);
    expect(pageSource).toContain('{{ EFFECT_PROMPT_LIMITS.pageSize }} 条/页');
  });

  it('keeps the prototype controls and excludes the rejected extra batch-adjustment fields', () => {
    for (const label of [
      '生成数量',
      '统一时长',
      '语义重复度上限',
      '画面重合度上限',
      '人工添加提示词',
      '批量导出',
    ])
      expect(pageSource).toContain(label);
    expect(pageSource).toContain("? '重新批量生成'");
    expect(pageSource).toContain(": '开始批量生成'");
    expect(pageSource).not.toContain('一键批量全部刷新');
    expect(pageSource.match(/@click="\s*generateCurrentBatch/g)).toHaveLength(1);
    expect(pageSource).not.toContain('卖点权重');
    expect(pageSource).not.toContain('统一风格');
    expect(pageSource).not.toContain('禁用元素');
  });

  it('uses working-copy status instead of a node-level asset save action', () => {
    expect(pageSource).toContain('<WorkflowNodeDraftBar');
    expect(pageSource).toContain('差异化 Prompt 批次草稿');
    expect(pageSource).toContain('工作副本已更新');
    expect(pageSource).toContain('尚未归档');
    expect(pageSource).toContain('<WorkflowNodeFooter');
    expect(pageSource).not.toContain('class="prompt-working-bar"');
    expect(pageSource).not.toContain('class="prompt-node-footer"');
    expect(pageSource).not.toContain('保存到项目资产库');
    expect(pageSource).not.toContain('本地 Mock 工作副本');
    expect(pageSource).not.toContain('localStorage');
  });

  it('adds the recoverable sub-workflow and complete six-dimensional editor', () => {
    expect(pageSource).toContain('差异化 Prompt 生成子工作流');
    expect(pageSource).toContain('EFFECT_PROMPT_GRAPH_NODES');
    expect(pageSource).toContain('loadEffectPromptNodeDetail');
    expect(pageSource).toContain('pollEffectPromptRun');
    expect(pageSource).toContain('v-for="dimension in EFFECT_PROMPT_DIMENSIONS"');
    expect(pageSource).toContain('请选择或输入片段类型');
    expect(pageSource).toContain('生成前结构化代理指标');
  });

  it('persists server defaults before the first generation run', () => {
    expect(pageSource).toContain('state.settingsRevision !== null');
  });

  it('wires only step three and keeps later nodes on their existing placeholder', () => {
    expect(parentSource).toContain(
      "import EffectPromptGenerationNodePage from '../prompt-generation/EffectPromptGenerationNodePage.vue'",
    );
    expect(parentSource).toContain('v-else-if="activeStep === 2"');
    expect(parentSource).toContain('@next="selectWorkflowStep(3)"');
    expect(parentSource).toContain('v-else-if="activeDownstreamBoundary"');
  });
});
