import { describe, expect, it } from 'vitest';

import viteConfigSource from '../../../../vite.config.ts?raw';
import parentSource from '../source-import/EffectImportNodePage.vue?raw';
import pageSource from './EffectPromptGenerationNodePage.vue?raw';
import graphSource from './effect-prompt-generation-graph.ts?raw';

describe('effect prompt generation current layout', () => {
  it('loads the live workspace contract source', () => {
    expect(viteConfigSource).toContain("'@ai-marketing/contracts': contractsSource");
    expect(viteConfigSource).toContain("exclude: ['@ai-marketing/contracts']");
  });

  it('uses the only active product without rendering a product selector', () => {
    expect(pageSource).not.toContain('class="product-switcher"');
    expect(pageSource).not.toContain('<span>当前商品</span>');
    expect(pageSource).not.toContain('<select v-model="currentProductId">');
    expect(pageSource).toContain('class="secondary-button workflow-graph-trigger"');
  });

  it('only exposes total count and one shared duration as batch settings', () => {
    expect(pageSource).toContain('<h3>批次设置</h3>');
    expect(pageSource).not.toContain('仅以下参数可调');
    expect(pageSource).toMatch(/\.settings-heading\s*\{[^}]*padding:\s*0 13px;/u);
    expect(pageSource).toContain('生成片段数');
    expect(pageSource).not.toContain('Prompt 总数量');
    expect(pageSource).not.toContain('每批最多 ${EFFECT_PROMPT_LIMITS.maxCount} 条');
    expect(pageSource).toContain("label: '单条片段时长'");
    expect(pageSource).not.toContain('默认片段时长');
    expect(pageSource).not.toContain('作为独立渲染参数，不写入 Prompt 正文');
    expect(pageSource).not.toContain('用于调整节奏和表达习惯，不会写成 Prompt 元数据');
    expect(pageSource).not.toContain('智能调度会按事实和场景选择视觉语言');
    expect(pageSource).toContain('currentSettings.value.targetCount');
    expect(pageSource).toContain('currentSettings.value.defaultDurationSeconds');
    for (const removed of [
      '素材片段总数',
      '单条成片预计时长',
      '生成数量',
      '语义重复度上限',
      '画面重合度上限',
      'currentSettings.value.fragmentConfigs',
      'currentSettings.semanticLimit',
      'currentSettings.visualLimit',
    ])
      expect(pageSource).not.toContain(removed);
    expect(pageSource).not.toContain('class="fragment-config-grid"');
    expect(pageSource).not.toContain('class="effect-prompt-stats"');
    expect(pageSource).toContain(
      "type NumericPromptSetting = 'targetCount' | 'defaultDurationSeconds'",
    );
    expect(pageSource).toMatch(
      /\.setting-card--select\s*>\s*\.effect-up-select\s*\{[^}]*grid-row:\s*1;[^}]*grid-column:\s*2;/u,
    );
    expect(pageSource).toMatch(
      /\.simple-setting-grid\s+\.number-control\s*\{[^}]*height:\s*38px;[^}]*grid-row:\s*1;[^}]*grid-column:\s*2;/u,
    );
    expect(pageSource).toMatch(
      /@media \(max-width:\s*1280px\)\s*\{[\s\S]*?\.simple-setting-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2,/u,
    );
  });

  it('keeps disabled elements as the single user-owned shared constraint input', () => {
    expect(pageSource).toContain('<span>禁用元素</span>');
    expect(pageSource).toContain(':value="currentDisabledElementsText"');
    expect(pageSource).toContain('@input="updateDisabledElementsText');
    expect(pageSource).not.toContain('支持顿号、逗号或换行分隔');
    expect(pageSource).not.toContain('系统共用内容');
    expect(pageSource).not.toContain('最终共用提示词');
    expect(pageSource).not.toContain('sharedPromptDraft');
    expect(pageSource).not.toContain('writeClipboardText');
  });

  it('shows recommendation and compatible purposes with primary matching as the default', () => {
    expect(pageSource).toContain('推荐：{{ fragmentTypeLabel(item.primaryPurpose) }}');
    expect(pageSource).toContain('item.compatiblePurposes');
    expect(pageSource).toContain('还适合');
    expect(pageSource).toContain('class="purpose-filter-bar"');
    expect(pageSource).toContain('togglePurposeFilter(purpose)');
    expect(pageSource).toContain('purposeFilter.value || undefined');
    expect(pageSource).toContain('includeCompatiblePurposes');
    expect(pageSource).toContain('包含兼容用途');
    expect(pageSource).toContain('<input v-model="includeCompatiblePurposes" type="checkbox" />');
    expect(pageSource).not.toContain(':disabled="!purposeFilter"');
    expect(pageSource).not.toContain(':class="{ disabled: !purposeFilter }"');
    expect(pageSource).toContain("? 'PRIMARY_OR_COMPATIBLE' : 'PRIMARY'");
    expect(pageSource).toContain('purposeCount(purpose)');
    expect(pageSource).not.toContain('fragmentTypeFilter');
  });

  it('keeps purpose filters and explains predictable multi-keyword search', () => {
    expect(pageSource).toContain('placeholder="搜索编号或多个关键词，例如：P012、厨房 果肉 特写"');
    expect(pageSource).toContain('aria-label="搜索 Prompt"');
    expect(pageSource).toContain('aria-label="清除搜索"');
    expect(pageSource).toContain('@click="clearPromptSearch"');
    expect(pageSource).toContain('找到 ${resultData.value?.total ?? 0} 条');
    expect(pageSource).toContain('批次共 ${currentCountStats.value.actualCount} 条');
    expect(pageSource).toContain('purposeFilter.value || undefined');
  });

  it('lets users switch the number of prompts shown per page', () => {
    expect(pageSource).toContain('v-model.number="pageSize"');
    expect(pageSource).toContain('aria-label="每页展示数量"');
    expect(pageSource).toContain('EFFECT_PROMPT_PAGE_SIZE_OPTIONS');
    expect(pageSource).toContain('@change="changePageSize"');
    expect(pageSource).toContain('pageSize.value');
    expect(pageSource).toMatch(/\.prompt-main\s*>\s*textarea\s*\{[^}]*min-height:\s*260px;/u);
    expect(pageSource).toMatch(/\.prompt-main\s*>\s*textarea\s*\{[^}]*overflow-y:\s*auto;/u);
    expect(pageSource).toContain('.prompt-main > textarea::-webkit-scrollbar-thumb');
    expect(pageSource).not.toContain('<span>{{ EFFECT_PROMPT_LIMITS.pageSize }} 条/页</span');
  });

  it('shows the fixed semantic duplicate-rate result without restoring a user setting', () => {
    expect(pageSource).toContain('currentSemanticDisplay');
    expect(pageSource).toContain('语义重复度 ${evaluation.duplicateRate.toFixed(1)}%');
    expect(pageSource).toContain('正在计算语义重复度');
    expect(pageSource).toContain('语义重复度待评估');
    expect(pageSource).toContain('偏高，但不影响提交');
    expect(pageSource).toContain('prompt-semantic-rate--');
  });

  it('renders the shared six dimensions without asking users to lock them', () => {
    expect(pageSource).toContain('v-for="dimension in EFFECT_PROMPT_DIMENSIONS"');
    expect(pageSource).not.toContain('regenerationPreservedDimensions');
    expect(pageSource).toContain('查看提炼信息依据');
    expect(pageSource).toContain('itemInsightFacts(item)');
    expect(pageSource).toContain('{{ fact.value }}');
    expect(pageSource).toContain('查看创意主线');
    expect(pageSource).toContain('{{ item.creativeCore }}');
    expect(pageSource).toContain('查看六维创意信息');
    expect(pageSource).not.toContain('卖点侧重');
  });

  it('places Prompt first and lets the user explicitly request AI creative-structure autofill', () => {
    expect(pageSource).toContain('创意方向与六维信息');
    expect(pageSource).toContain('用于创意评估、展示与追溯，请与 Prompt 正文保持一致');
    expect(pageSource).toContain('v-model="editorDraft.primaryPurpose"');
    expect(pageSource).toContain('v-model="editorDraft.creativeCore"');
    expect(pageSource).toContain('v-model="editorDraft.dimensions[dimension.key]"');
    expect(pageSource).toContain('AI 自动生成不会覆盖你的选择');
    expect(pageSource).not.toContain('editorDraft.useAiAnalysis');
    expect(pageSource).not.toContain('保存后使用 AI 分析');
    expect(pageSource).toContain('只有点击“AI 自动生成”才会调用 AI');
    expect(pageSource).toContain('!editorDraft.content.trim()');
    expect(pageSource).toContain('@click="autoFillEditorCreativeStructure"');
    expect(pageSource.indexOf('class="editor-content"')).toBeLessThan(
      pageSource.indexOf('class="editor-creative-structure"'),
    );
    expect(pageSource).toContain('saved.affectedItemIndex');
    expect(pageSource).not.toContain('saved.result.items.findIndex');
    expect(pageSource).not.toContain('existingItemIds');
    expect(pageSource).toContain("item.classificationStatus === 'PENDING'");
    expect(pageSource).toContain('NEEDS_REVISION');
    expect(pageSource).toContain('需修改');
    expect(pageSource).not.toContain('@click="evaluateItem(item)"');
    expect(pageSource).not.toContain('重新评估');
    expect(pageSource).toContain("editorMode === 'add' ? '添加提示词' : '编辑提示词'");
    expect(pageSource).toContain('<Pencil :size="13" />编辑');
  });

  it('keeps editing and deletion safe without single-item generation or copying', () => {
    for (const handler of [
      'openEditor(undefined, $event)',
      'exportBatch',
      'openEditor(item, $event)',
      'requestDeleteItem(item)',
    ])
      expect(pageSource).toContain(handler);
    expect(pageSource).toContain('requestActionConfirmation');
    for (const removed of [
      'copyItem',
      'openRegenerationDialog',
      'regeneration-dialog',
      '采用这个方案',
      '撤销本次替换',
    ])
      expect(pageSource).not.toContain(removed);
  });

  it('restores the latest completed regeneration preview after a page refresh', () => {
    expect(pageSource).toContain(
      'isPromptRunActive(state) || state.productId === currentProductId.value',
    );
    expect(pageSource).toContain('else updateRun(state.productId, run);');
    expect(pageSource).toContain('void resumeRuns();');
  });

  it('keeps exactly two equal-width 34px card actions on one responsive row', () => {
    expect(pageSource).toMatch(
      /\.prompt-actions\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*68px\)/u,
    );
    expect(pageSource).toMatch(/\.prompt-actions button\s*\{[^}]*height:\s*34px/u);
    expect(pageSource).toContain('grid-template-columns: repeat(2, minmax(0, 1fr));');
    expect(pageSource).toContain('grid-column: 2;');
    expect(pageSource).toContain('v-if="editorMode === \'add\'"');
    expect(pageSource).toContain('class="editor-duration-readonly"');
    expect(pageSource).toContain('EFFECT_PROMPT_LIMITS.maxManualDurationSeconds');
  });

  it('keeps manual editing concise without a batch-import entry', () => {
    expect(pageSource).not.toContain('批量导入');
    expect(pageSource).not.toContain('parseEffectPromptImportJson');
    expect(pageSource).not.toContain('importEffectPromptBatchDraft');
    expect(pageSource).not.toContain('次级标签');
    expect(pageSource).not.toContain('次级素材标签');
    expect(pageSource).toContain('<Plus :size="15" />新增 Prompt');
    expect(pageSource).toContain('v-model.number="editorDraft.targetDurationSeconds"');
    expect(pageSource).toContain('v-model="editorDraft.primaryPurpose"');
    expect(pageSource).not.toContain('role="switch"');
    expect(pageSource).toContain("editorMode === 'add' ? '添加提示词' : '保存编辑'");
    expect(pageSource).toContain('已有 Prompt 的时长不可修改');
    expect(pageSource).not.toContain('title="差异化 Prompt 批次草稿"');
  });

  it('publishes the new total before correcting an out-of-range page', () => {
    const correction = pageSource.indexOf('if (page.value !== validPage)');
    const assignment = pageSource.indexOf('resultData.value = loaded;', correction);
    const pageAssignment = pageSource.indexOf('page.value = validPage;', assignment);
    expect(correction).toBeGreaterThan(-1);
    expect(assignment).toBeGreaterThan(correction);
    expect(pageAssignment).toBeGreaterThan(assignment);
    expect(pageSource.slice(pageAssignment, pageAssignment + 80)).toContain('return;');
  });

  it('renders the current batch graph without version or history controls', () => {
    expect(pageSource).toContain('下一阶段 AI 审片并只修订确诊的执行问题');
    expect(pageSource).toContain('再由 AI 完成整段画面执行修正');
    for (const nodeId of [
      'LOAD_AND_SNAPSHOT',
      'INSIGHT_MAPPING',
      'FACT_VISUAL_STRATEGY_COMPILATION',
      'SHARED_PROMPT_COMPILATION',
      'COHERENT_CREATIVE_GENERATION',
      'CREATIVE_EVALUATION_CLASSIFICATION',
      'EXACT_SELECTION_AND_SUPPLEMENT',
      'RESULT_SAVE',
      'ITEM_EVALUATE',
    ])
      expect(pageSource).toMatch(new RegExp(`\\b${nodeId}\\b`, 'u'));
    expect(pageSource).toMatch(
      /effectPromptRunGraphNodeIds\(displayedGraphRun\.value\.operation\)/u,
    );
    expect(pageSource).toMatch(/effectPromptRunGraphEdges\(displayedGraphRun\.value\.operation\)/u);
    expect(pageSource).toContain('展示本次真实输入、连贯创意生成、用途评估和数量结果。');
    expect(graphSource).toContain('sourceIndex < targetIndex');
  });

  it('shows live worker summaries and refreshes the selected running-node detail', () => {
    expect(pageSource).toContain('if (executionSummary) return executionSummary');
    expect(pageSource).toContain('graphNodeDescription(nodeId)');
    expect(pageSource).toContain(
      'promptGraphDetailRefreshKey(displayedGraphRun.value, selectedGraphNodeId.value)',
    );
    expect(pageSource).toContain('displayedGraphRun.value?.id !== runId');
    expect(pageSource).toContain('void refreshGraphDetail()');
    expect(pageSource).toContain('graphDetailRefreshTimer = setTimeout');
    expect(pageSource).toContain('graphDetail.value?.nodeId !== nodeId');
    expect(pageSource).toContain('promptGraphDetailContentKey(graphDetail.value)');
    expect(pageSource).toContain('graphDetailLoading && !graphDetail');
  });

  it('uses the shared workflow progress component without duplicating page styles', () => {
    expect(pageSource).toContain('WorkflowRunProgress');
    expect(pageSource).toContain(':progress="currentState.progress"');
    expect(pageSource).toContain(':attempt-label="currentAttemptLabel"');
    expect(pageSource).toContain(':warning="currentRetryWarning"');
    expect(pageSource).toContain('@show-details="openGraph"');
    expect(pageSource).not.toContain('class="run-progress"');
    expect(pageSource).not.toContain('.run-progress {');
  });

  it('keeps current real-result detail renderers without historical navigation', () => {
    expect(pageSource).toContain('EFFECT_PROMPT_GRAPH_NODE_IDS');
    expect(pageSource).not.toContain('历史执行');
    for (const blockKind of [
      'CREATIVE_PLAN_LIST',
      'RELATIONSHIP_LIST',
      'COORDINATE_LIST',
      'BLUEPRINT_LIST',
      'ORTHOGONAL_PAIR_LIST',
      'TAG_LIST',
      'PROMPT_LIST',
      'ISSUE_LIST',
    ])
      expect(pageSource).toContain(`block.kind === '${blockKind}'`);
    expect(pageSource).toContain('产品创意空间 ·');
    expect(pageSource).toContain('territory.directions');
    expect(pageSource).toContain('direction.creativeDirection');
    expect(pageSource).toContain('主要动作：{{ direction.primaryAction }}');
    expect(pageSource).toContain('graphPromptDimensionValue(item, dimension.key)');
  });

  it('keeps working-copy lifecycle and responsive interaction states', () => {
    expect(pageSource).not.toContain('<WorkflowNodeDraftBar');
    expect(pageSource).not.toContain('工作副本已更新');
    expect(pageSource).not.toContain('尚未归档');
    expect(pageSource).not.toContain('保存到项目资产库');
    expect(pageSource).toContain('currentAttemptLabel');
    expect(pageSource).toContain('currentRetryWarning');
    expect(pageSource).toContain('@keydown.esc="closeGraph"');
    expect(pageSource).toContain('@media (max-width: 760px)');
  });

  it('acknowledges generation immediately and does not auto-open the graph', () => {
    const start = pageSource.indexOf('const generateCurrentBatch');
    const end = pageSource.indexOf('async function handleMutationError', start);
    const generation = pageSource.slice(start, end);
    expect(generation.indexOf('batchStartPending.value = true')).toBeLessThan(
      generation.indexOf('await flushSettings(productId)'),
    );
    expect(generation).not.toContain('graphDialogOpen.value = true');
    expect(pageSource).toContain(':aria-busy="currentRunning || batchStartPending"');
    expect(pageSource).toContain("? '正在提交…'");
  });

  it('keeps failed candidates as a read-only temporary preview', () => {
    expect(pageSource).toContain('class="partial-preview-banner"');
    expect(pageSource).toContain('本次任务未完成，已保留');
    expect(pageSource).toContain('当前仅支持查看');
    expect(pageSource).toMatch(
      /:disabled="\s*partialPreview \|\|\s*currentRunning \|\|\s*validating/,
    );
    expect(pageSource).toContain('<CheckCircle2 v-else :size="14" />');
    expect(pageSource).not.toContain('currentQualityReady');
  });

  it('reuses the warm node view without duplicating the initial product load', () => {
    expect(pageSource).toContain('workspaceHydrating = true');
    expect(pageSource).toContain('if (!nodeActive || workspaceHydrating) return;');
    expect(pageSource).toContain('loadEffectPromptWorkspaceSnapshot(');
    expect(pageSource).toContain('if (snapshot.prefetched)');
    expect(pageSource).toContain('onDeactivated(() => {');
    expect(pageSource).toContain('void reloadWorkspace(false);');
  });

  it('wires only effect workflow step three', () => {
    expect(parentSource).toContain(
      "import EffectPromptGenerationNodePage from '../prompt-generation/EffectPromptGenerationNodePage.vue'",
    );
    expect(parentSource).toContain('v-else-if="activeStep === 2"');
    expect(parentSource).toContain('@next="selectWorkflowStep(3)"');
    expect(parentSource).not.toContain('v-if="activeDownstreamBoundary"');
  });
});
