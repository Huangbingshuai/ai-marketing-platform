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

  it('uses one type selector for six independent count and duration settings', () => {
    for (const label of [
      '片段类型',
      '生成数量',
      '片段时长',
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
    expect(pageSource).not.toContain('风格覆盖');
    expect(pageSource).not.toContain('七类素材标签配比');
    expect(pageSource).not.toContain('卖点权重');
    expect(pageSource).not.toContain('追加禁用元素');
    expect(pageSource).toContain('currentSettings.value.fragmentConfigs[fragmentType]');
    expect(pageSource).toContain('currentTargetCount');
    expect(pageSource).toContain('currentDurationSummary');
    expect(pageSource).toContain('EFFECT_PROMPT_LIMITS.minCount - otherCount');
    expect(pageSource.match(/v-model="fragmentTypeFilter"/gu)).toHaveLength(1);
    expect(pageSource).not.toContain('v-model="fragmentTypeFilter" :disabled="currentRunning"');
    expect(pageSource).toContain('fragmentTypeFilter.value || undefined');
  });

  it('matches the extraction heading action order and labels', () => {
    const productSwitcher = pageSource.indexOf('<label class="product-switcher">');
    const workflowTrigger = pageSource.indexOf('class="secondary-button workflow-graph-trigger"');
    const generationTrigger = pageSource.indexOf('class="primary-button heading-generate-button"');

    expect(pageSource).toContain('<span>当前商品</span>');
    expect(pageSource).toContain('<Workflow :size="14" />查看工作流');
    expect(pageSource).not.toContain('查看生成子工作流');
    expect(productSwitcher).toBeGreaterThan(-1);
    expect(productSwitcher).toBeLessThan(workflowTrigger);
    expect(workflowTrigger).toBeLessThan(generationTrigger);
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
    expect(pageSource).toContain('固定主标签');
    expect(pageSource).toContain('次级素材标签');
    expect(pageSource).toContain('目标片段时长');
    expect(pageSource).toContain('editorTargetDurationSeconds');
    expect(pageSource).toContain('type="number" readonly');
    expect(pageSource).toContain('生成前结构化代理指标');
  });

  it('states the fragment semantics and keeps tags separate from generation copy', () => {
    expect(pageSource).toContain('条 Prompt =');
    expect(pageSource).toContain('不是');
    expect(pageSource).toContain('EFFECT_PROMPT_FRAGMENT_TYPE_LABELS');
    expect(pageSource).toContain('fragmentTypeFilter');
    expect(pageSource).toContain('item.materialTags');
    expect(pageSource).toContain('item.targetDurationSeconds');
    expect(pageSource).toContain('查看六维差异化设定');
    expect(pageSource).toContain('fragmentTypeDistribution');
    expect(pageSource).toContain('sellingPointCoverage');
    expect(pageSource).toContain('removedExecutionInvalid');
    expect(pageSource).toContain('currentQuotaStats');
    expect(pageSource).toContain('currentFragmentDistribution');
    expect(pageSource).toContain('缺口');
  });

  it('wires every prompt-list action with safe destructive and busy states', () => {
    for (const handler of [
      'openEditor(undefined, $event)',
      'exportBatch',
      'openEditor(item, $event)',
      'copyItem(item)',
      'requestDeleteItem(item, $event)',
      'regenerateItem(item)',
    ])
      expect(pageSource).toContain(handler);

    expect(pageSource).toContain('role="alertdialog"');
    expect(pageSource).toContain('@keydown.esc="closeDeleteDialog"');
    expect(pageSource).toContain('ref="deleteConfirmButton"');
    expect(pageSource).toContain("itemOperation.kind === 'delete'");
    expect(pageSource).toContain("itemOperation.kind === 'regenerate'");
    expect(pageSource).toContain("document.execCommand('copy')");
    expect(pageSource).toContain('currentRunning || exporting');
    expect(pageSource).toMatch(/:disabled="!resultData \|\| currentRunning/u);
  });

  it('renders the conditional router and all six generation branches', () => {
    for (const nodeId of [
      'LOAD_AND_SNAPSHOT',
      'STRATEGY_PLANNING',
      'DIMENSION_COMBINATION',
      'FRAGMENT_TYPE_ROUTER',
      'GENERATE_HOOK',
      'GENERATE_PAIN',
      'GENERATE_PRODUCT_DISPLAY',
      'GENERATE_SELLING_POINT_EXPLANATION',
      'GENERATE_CTA',
      'GENERATE_OUTRO',
      'NORMALIZATION',
      'SEMANTIC_DEDUP',
      'VISUAL_DEDUP',
      'QUALITY_GATE',
      'REPLENISH',
      'RESULT_SAVE',
    ])
      expect(pageSource).toContain(`'${nodeId}'`);

    expect(pageSource).not.toContain("'CANDIDATE_GENERATION'");
    expect(pageSource).not.toContain('GENERATE_EFFECT_DEMONSTRATION');
    expect(pageSource).toContain(
      ':class="{ parallel: row.length > 1, generation: row.length === 6 }"',
    );

    expect(pageSource).toContain('aria-label="刷新当前节点详情"');
    expect(pageSource).toContain('@click="refreshGraphDetail"');
    expect(pageSource).toContain('graphStatusMeta(graphDetail.status)');
    expect(pageSource).toContain('formatGraphDetailTime(graphDetail.updatedAt)');
    expect(pageSource).toContain('v-for="(field, index) in graphDetail.fields"');
    expect(pageSource).toContain('v-if="field.description"');
    expect(pageSource).toContain('graphDetailValueIsMultiline(field.value)');
    expect(pageSource).toContain('该节点尚未执行，暂无运行字段');
    expect(pageSource).toMatch(/\.node-fields dd\.is-multiline\s*\{[^}]*white-space:\s*pre-wrap/su);
    expect(pageSource).not.toMatch(
      /storageKey|sourceFingerprint|attemptToken|promptVersion|ARK_PROMPT_MODEL/u,
    );
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
