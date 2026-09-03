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

  it('only exposes total count and one shared duration as batch settings', () => {
    expect(pageSource).toContain('<h3>批次设置</h3>');
    expect(pageSource).not.toContain('仅以下参数可调');
    expect(pageSource).toMatch(/\.settings-heading\s*\{[^}]*padding:\s*0 13px;/u);
    expect(pageSource).toContain('Prompt 总数量');
    expect(pageSource).toContain('每批最多 ${EFFECT_PROMPT_LIMITS.maxCount} 条');
    expect(pageSource).toContain("label: '片段时长'");
    expect(pageSource).not.toContain('默认片段时长');
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
  });

  it('keeps one editable shared prompt instead of splitting shared requirements', () => {
    expect(pageSource).toContain('aria-label="共用提示词"');
    expect(pageSource).toContain('aria-label="共用提示词内容"');
    expect(pageSource).toContain('v-model="sharedPromptDraft"');
    expect(pageSource).toContain('@click="saveSharedPrompt"');
    expect(pageSource).not.toContain('系统共用内容');
    expect(pageSource).not.toContain('最终共用提示词');
    expect(pageSource).toContain('await writeClipboardText(item.content)');
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

  it('shows the fixed semantic duplicate-rate result without restoring a user setting', () => {
    expect(pageSource).toContain('currentSemanticDisplay');
    expect(pageSource).toContain('语义重复度 ${evaluation.duplicateRate.toFixed(1)}%');
    expect(pageSource).toContain('正在计算语义重复度');
    expect(pageSource).toContain('语义重复度待评估');
    expect(pageSource).toContain('偏高，但不影响提交');
    expect(pageSource).toContain('prompt-semantic-rate--');
  });

  it('uses product relation as the fourth creative dimension', () => {
    expect(pageSource).toContain("['productRelation']");
    expect(pageSource).toContain("key !== 'productRelation'");
    expect(pageSource).toContain('查看提炼信息依据');
    expect(pageSource).toContain('itemInsightFacts(item)');
    expect(pageSource).toContain('{{ fact.value }}');
    expect(pageSource).toContain('查看创意主线');
    expect(pageSource).toContain('{{ item.creativeCore }}');
    expect(pageSource).toContain('查看六维创意信息');
    expect(pageSource).not.toContain('卖点侧重');
  });

  it('saves manual edits without a selected purpose and makes AI evaluation optional', () => {
    expect(pageSource).not.toContain('固定主标签');
    expect(pageSource).toContain('分析六维创意、可信事实和推荐用途，不会改写正文');
    expect(pageSource).toContain('draft.useAiAnalysis && state.settingsRevision === null');
    expect(pageSource).toContain('saved.evaluationRun');
    expect(pageSource).toContain('saved.affectedItemIndex');
    expect(pageSource).not.toContain('saved.result.items.findIndex');
    expect(pageSource).not.toContain('existingItemIds');
    expect(pageSource).toContain("operation: 'ITEM_EVALUATE'");
    expect(pageSource).toContain('targetItemId: item.id');
    expect(pageSource).toContain("item.classificationStatus === 'PENDING'");
    expect(pageSource).toContain('NEEDS_REVISION');
    expect(pageSource).toContain('需修改');
    expect(pageSource).toContain('@click="evaluateItem(item)"');
    expect(pageSource).toContain("item.classificationStatus === 'NEEDS_REVISION' ? '修改后评估'");
    expect(pageSource).not.toContain('v-model="editorDraft.dimensions');
  });

  it('keeps list actions safe while evaluation or regeneration is active', () => {
    for (const handler of [
      'openEditor(undefined, $event)',
      'exportBatch',
      'openEditor(item, $event)',
      'copyItem(item)',
      'requestDeleteItem(item)',
      'openRegenerationDialog(item, $event)',
    ])
      expect(pageSource).toContain(handler);
    expect(pageSource).toContain('requestActionConfirmation');
    expect(pageSource).not.toContain('prompt-delete-dialog');
    expect(pageSource).toContain('regenerationMode: regenerationMode.value');
    expect(pageSource).toContain('生成 3 个备选');
    expect(pageSource).toContain('采用这个方案');
    expect(pageSource).toContain('撤销本次替换');
  });

  it('keeps manual editing concise without a batch-import entry', () => {
    expect(pageSource).not.toContain('批量导入');
    expect(pageSource).not.toContain('parseEffectPromptImportJson');
    expect(pageSource).not.toContain('importEffectPromptBatchDraft');
    expect(pageSource).not.toContain('次级标签');
    expect(pageSource).not.toContain('次级素材标签');
    expect(pageSource).toContain('<Plus :size="15" />新增 Prompt');
    expect(pageSource).toContain('v-model.number="editorDraft.targetDurationSeconds"');
    expect(pageSource).toContain('v-model="editorDraft.useAiAnalysis"');
    expect(pageSource).toContain('role="switch"');
    expect(pageSource).toContain('仅保存草稿');
    expect(pageSource).toContain('本次不会调用 AI');
    expect(pageSource).toContain('短片只安排一个连续动作');
    expect(pageSource).toContain('currentCountStats.actualCount} 条 Prompt');
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
    expect(pageSource).toContain("displayedGraphRun.value?.status !== 'RUNNING'");
    expect(pageSource).toContain('displayedGraphRun.value.currentNode !== nodeId');
    expect(pageSource).toContain('void refreshGraphDetail()');
    expect(pageSource).toContain('graphDetailRefreshTimer = setTimeout');
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
    expect(pageSource).toContain('<WorkflowNodeDraftBar');
    expect(pageSource).toContain('工作副本已更新');
    expect(pageSource).toContain('尚未归档');
    expect(pageSource).not.toContain('保存到项目资产库');
    expect(pageSource).toContain('currentAttemptLabel');
    expect(pageSource).toContain('currentRetryWarning');
    expect(pageSource).toContain('@keydown.esc="closeGraph"');
    expect(pageSource).toContain('@media (max-width: 760px)');
  });

  it('acknowledges generation immediately and does not auto-open the graph', () => {
    const start = pageSource.indexOf('const generateCurrentBatch');
    const end = pageSource.indexOf('const openRegenerationDialog', start);
    const generation = pageSource.slice(start, end);
    expect(generation.indexOf('batchStartPending.value = true')).toBeLessThan(
      generation.indexOf('await flushSettings(productId)'),
    );
    expect(generation).not.toContain('graphDialogOpen.value = true');
    expect(pageSource).toContain(':aria-busy="currentRunning || batchStartPending"');
    expect(pageSource).toContain("? '正在提交…'");
  });

  it('keeps failed candidates as a copy-only temporary preview', () => {
    expect(pageSource).toContain('class="partial-preview-banner"');
    expect(pageSource).toContain('本次任务未完成，已保留');
    expect(pageSource).toContain('当前仅支持查看和复制');
    expect(pageSource).toContain(
      ':validate-disabled="partialPreview || currentRunning || validating',
    );
  });

  it('wires only effect workflow step three', () => {
    expect(parentSource).toContain(
      "import EffectPromptGenerationNodePage from '../prompt-generation/EffectPromptGenerationNodePage.vue'",
    );
    expect(parentSource).toContain('v-else-if="activeStep === 2"');
    expect(parentSource).toContain('@next="selectWorkflowStep(3)"');
    expect(parentSource).toContain('v-else-if="activeDownstreamBoundary"');
  });
});
