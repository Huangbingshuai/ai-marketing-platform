import { describe, expect, it } from 'vitest';

import viteConfigSource from '../../../../vite.config.ts?raw';
import parentSource from '../source-import/EffectImportNodePage.vue?raw';
import pageSource from './EffectPromptGenerationNodePage.vue?raw';
import graphSource from './effect-prompt-generation-graph.ts?raw';

describe('effect prompt generation V11 layout', () => {
  it('loads the live workspace contract source', () => {
    expect(viteConfigSource).toContain("'@ai-marketing/contracts': contractsSource");
    expect(viteConfigSource).toContain("exclude: ['@ai-marketing/contracts']");
  });

  it('only exposes total count and one shared duration as batch settings', () => {
    expect(pageSource).toContain('<h3>批次设置</h3>');
    expect(pageSource).not.toContain('仅以下参数可调');
    expect(pageSource).toMatch(/\.settings-heading\s*\{[^}]*padding:\s*0 13px;/u);
    expect(pageSource).toContain('Prompt 总数量');
    expect(pageSource).toContain('默认片段时长');
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

  it('shows recommendation and compatible purposes and filters by either purpose', () => {
    expect(pageSource).toContain('推荐：{{ fragmentTypeLabel(item.primaryPurpose) }}');
    expect(pageSource).toContain('item.compatiblePurposes');
    expect(pageSource).toContain('还适合');
    expect(pageSource).toContain('class="purpose-filter-bar"');
    expect(pageSource).toContain('togglePurposeFilter(purpose)');
    expect(pageSource).toContain('purposeFilter.value || undefined');
    expect(pageSource).not.toContain('fragmentTypeFilter');
  });

  it('uses product relation as the fourth creative dimension', () => {
    expect(pageSource).toContain('productRelation: []');
    expect(pageSource).toContain('dimensions.productRelation');
    expect(pageSource).toContain("dimension.key === 'productRelation'");
    expect(pageSource).toContain('查看六维创意信息');
    expect(pageSource).not.toContain('卖点侧重');
  });

  it('saves manual edits without a selected purpose and starts asynchronous evaluation', () => {
    expect(pageSource).not.toContain('固定主标签');
    expect(pageSource).toContain('保存后会异步重新评估推荐用途');
    expect(pageSource).toContain("operation: 'ITEM_EVALUATE'");
    expect(pageSource).toContain('targetItemId: item.id');
    expect(pageSource).toContain("item.classificationStatus === 'PENDING'");
    expect(pageSource).toContain('待重新评估');
    expect(pageSource).toContain('@click="evaluateItem(item)"');
    expect(pageSource).toMatch(/<RefreshCw\s+v-else\s+:size="13"\s*\/>\s*重新评估/u);
  });

  it('keeps list actions safe while evaluation or regeneration is active', () => {
    for (const handler of [
      'openEditor(undefined, $event)',
      'exportBatch',
      'openEditor(item, $event)',
      'copyItem(item)',
      'requestDeleteItem(item, $event)',
      'openRegenerationDialog(item, $event)',
    ])
      expect(pageSource).toContain(handler);
    expect(pageSource).toContain('role="alertdialog"');
    expect(pageSource).toContain('@keydown.esc="closeDeleteDialog"');
    expect(pageSource).toContain('replacementDimensions');
    expect(pageSource).toContain('用途会根据新内容重新判断');
  });

  it('renders the V11 seven-stage batch graph and operation-specific item graph', () => {
    for (const nodeId of [
      'LOAD_AND_SNAPSHOT',
      'INSIGHT_MAPPING',
      'SHARED_PROMPT_COMPILATION',
      'COHERENT_CREATIVE_GENERATION',
      'CREATIVE_EVALUATION_CLASSIFICATION',
      'EXACT_SELECTION_AND_SUPPLEMENT',
      'RESULT_SAVE',
      'ITEM_EVALUATE',
    ])
      expect(pageSource).toMatch(new RegExp(`\\b${nodeId}\\b`, 'u'));
    expect(pageSource).toMatch(
      /effectPromptRunGraphNodeIds\(\s*displayedGraphVersion\.value,\s*displayedGraphRun\.value\.operation,?\s*\)/u,
    );
    expect(pageSource).toMatch(
      /effectPromptRunGraphEdges\(\s*displayedGraphVersion\.value,\s*displayedGraphRun\.value\.operation,?\s*\)/u,
    );
    expect(pageSource).toContain('展示本次真实输入、连贯创意生成、用途评估和数量结果。');
    expect(graphSource).toContain('sourceIndex < targetIndex');
  });

  it('retains historical V8-V10 graph detail renderers', () => {
    expect(pageSource).toContain('effectPromptGraphNodeIds(displayedGraphVersion.value)');
    for (const blockKind of [
      'RELATIONSHIP_LIST',
      'COORDINATE_LIST',
      'BLUEPRINT_LIST',
      'ORTHOGONAL_PAIR_LIST',
      'TAG_LIST',
      'PROMPT_LIST',
      'ISSUE_LIST',
    ])
      expect(pageSource).toContain(`block.kind === '${blockKind}'`);
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
