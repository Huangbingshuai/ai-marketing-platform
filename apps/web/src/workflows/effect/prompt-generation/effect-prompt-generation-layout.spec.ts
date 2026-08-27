import { describe, expect, it } from 'vitest';

import viteConfigSource from '../../../../vite.config.ts?raw';
import parentSource from '../source-import/EffectImportNodePage.vue?raw';
import pageSource from './EffectPromptGenerationNodePage.vue?raw';
import graphSource from './effect-prompt-generation-graph.ts?raw';

describe('effect prompt generation prototype layout', () => {
  it('loads the live workspace contract source instead of a stale optimized dependency', () => {
    expect(viteConfigSource).toContain("'@ai-marketing/contracts': contractsSource");
    expect(viteConfigSource).toContain("exclude: ['@ai-marketing/contracts']");
    expect(viteConfigSource).not.toContain("include: ['@ai-marketing/contracts']");
  });

  it('reproduces the four-section prompt workspace and ten-item pagination', () => {
    expect(pageSource).toContain('class="effect-prompt-heading"');
    expect(pageSource).toContain('class="effect-prompt-settings"');
    expect(pageSource).toMatch(/grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/u);
    expect(pageSource).toContain('class="effect-prompt-stats"');
    expect(pageSource).toContain('class="effect-prompt-toolbar"');
    expect(pageSource).toContain('class="prompt-card"');
    expect(pageSource).toMatch(/grid-template-columns:\s*43px\s+minmax\(0,\s*1fr\)\s+138px/u);
    expect(pageSource).toContain('{{ EFFECT_PROMPT_LIMITS.pageSize }} 条/页');
  });

  it('shows all six independent configurations without an all-types selector', () => {
    for (const label of [
      '素材片段总数',
      '单条成片预计时长',
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
    expect(pageSource).toContain('currentFinishedVideoDurationSeconds');
    expect(pageSource).toContain('currentFinishedVideoDurationLabel');
    expect(pageSource).toMatch(
      /total\s*\+\s*currentSettings\.value\.fragmentConfigs\[fragmentType\]\.durationSeconds/su,
    );
    expect(pageSource).not.toMatch(/durationSeconds\s*\*\s*[^\n]*\.count/u);
    expect(pageSource).toMatch(/EFFECT_PROMPT_LIMITS\.minCount\s*-\s*otherCount/su);
    expect(pageSource).toContain('class="fragment-config-grid"');
    expect(pageSource).toContain('toggleFragmentTypeFilter(fragmentType)');
    expect(pageSource).toContain("fragmentTypeFilter.value === fragmentType ? '' : fragmentType");
    expect(pageSource).not.toContain('v-model="fragmentTypeFilter"');
    expect(pageSource).not.toContain('<option value="">全部片段</option>');
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

  it('adds the recoverable workflow and complete six-dimensional editor', () => {
    expect(pageSource).toContain('差异化 Prompt 生成工作流');
    expect(pageSource).toContain('PROMPT WORKFLOW');
    expect(pageSource).not.toContain('子工作流');
    expect(pageSource).not.toContain('SUB-WORKFLOW');
    expect(pageSource).toContain('EFFECT_PROMPT_GRAPH_NODES');
    expect(pageSource).toContain('loadEffectPromptNodeDetail');
    expect(pageSource).toContain('pollEffectPromptRun');
    expect(pageSource).toContain('currentAttemptLabel');
    expect(pageSource).toContain('currentRetryWarning');
    expect(pageSource).toContain('run.attemptCount');
    expect(pageSource).toContain('run.maxAttempts');
    expect(pageSource).toContain('v-for="dimension in EFFECT_PROMPT_DIMENSIONS"');
    expect(pageSource).toContain('固定主标签');
    expect(pageSource).toContain('次级素材标签');
    expect(pageSource).toContain('目标片段时长');
    expect(pageSource).toContain('editorTargetDurationSeconds');
    expect(pageSource).toContain('type="number" readonly');
    expect(pageSource).toContain('生成前结构化代理指标');
  });

  it('uses concise generation copy and keeps tags separate from generation copy', () => {
    expect(pageSource).toContain('基于提炼结果，批量生成差异化视频素材 Prompt');
    expect(pageSource).not.toContain('条 Prompt =');
    expect(pageSource).toContain('EFFECT_PROMPT_FRAGMENT_TYPE_LABELS');
    expect(pageSource).toContain('fragmentTypeFilter');
    expect(pageSource).toContain('item.materialTags');
    expect(pageSource).toContain('item.targetDurationSeconds');
    expect(pageSource).toContain('查看六维差异化设定');
    expect(pageSource).toContain('fragmentTypeDistribution');
    expect(pageSource).toContain('sellingPointCoverage');
    expect(pageSource).toContain('removedExecutionInvalid');
    expect(pageSource).toContain('currentQuotaStats');
    expect(pageSource).not.toContain('currentFragmentDistribution');
    expect(pageSource).toContain('缺少 ');
    expect(pageSource).toContain('超出 ');
    expect(pageSource).toContain('数量一致');
  });

  it('shows one editable shared prompt and keeps copy limited to clean item content', () => {
    expect(pageSource).toContain('aria-label="共用提示词"');
    expect(pageSource).toContain('aria-label="共用提示词内容"');
    expect(pageSource).toContain('v-model="sharedPromptDraft"');
    expect(pageSource).toContain('@click="saveSharedPrompt"');
    expect(pageSource).not.toContain('系统共用内容');
    expect(pageSource).not.toContain('最终共用提示词');
    expect(pageSource).not.toContain('shared-prompt-preview');
    expect(pageSource).not.toContain('currentDisabledElements');
    expect(pageSource).not.toContain('aria-label="配额与提炼信息覆盖"');
    expect(pageSource).not.toContain('class="quality-breakdown"');
    expect(pageSource).not.toContain('统一渲染设置');
    expect(pageSource).not.toContain('currentRenderProfile.ratio');
    expect(pageSource).not.toContain('currentRenderProfile.resolution');
    expect(pageSource).not.toContain('模型时长范围');
    expect(pageSource).not.toContain('currentMetrics.fallbackCount');
    expect(pageSource).toContain('await writeClipboardText(item.content)');
    expect(pageSource).not.toContain('writeClipboardText(item.targetDurationSeconds');
  });

  it('wires every prompt-list action with safe destructive and busy states', () => {
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
    expect(pageSource).toContain('ref="deleteConfirmButton"');
    expect(pageSource).toContain("itemOperation.kind === 'delete'");
    expect(pageSource).toContain('<RefreshCw v-else :size="13" />重新生成');
    expect(pageSource).not.toContain('重新生成此条');
    expect(pageSource).toContain('grid-template-columns: 56px 76px;');
    expect(pageSource).toContain('font-weight: 700;\n  white-space: nowrap;');
    expect(pageSource).toContain('class="prompt-regeneration-dialog"');
    expect(pageSource).toContain('已调整 {{ regenerationChangedKeys.length }}/6');
    expect(pageSource).toContain('恢复原始六维');
    expect(pageSource).toContain('regenerationInstruction.length }}/500');
    expect(pageSource).toContain(
      '<LoaderCircle v-if="regenerationSaving" class="spin" :size="14" />',
    );
    expect(pageSource).toMatch(/@click="regenerateItem"[\s\S]*?重新生成[\s\S]*?<\/button>/u);
    expect(pageSource).not.toContain('直接换一版');
    expect(pageSource).not.toContain('按当前设置重新生成');
    expect(pageSource).toContain('.prompt-dialog-backdrop {\n  --effect-blue: #2563eb;');
    expect(pageSource).toContain('replacementDimensions');
    expect(pageSource).toContain('targetItemId: item.id');
    expect(pageSource).not.toContain(
      'graphDialogOpen.value = true;\n    startPolling(state.productId, run)',
    );
    expect(pageSource).toContain("document.execCommand('copy')");
    expect(pageSource).toContain('currentRunning || exporting');
    expect(pageSource).toMatch(/:disabled="!resultData \|\| currentRunning/u);
  });

  it('renders the conditional router and all six generation branches', () => {
    for (const nodeId of [
      'LOAD_AND_SNAPSHOT',
      'INSIGHT_MAPPING',
      'SHARED_PROMPT_COMPILATION',
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
      expect(pageSource).toMatch(new RegExp(`\\b${nodeId}\\b`, 'u'));

    expect(pageSource).not.toContain("'CANDIDATE_GENERATION'");
    expect(pageSource).not.toContain('GENERATE_EFFECT_DEMONSTRATION');
    expect(pageSource).toContain(
      `:class="{ parallel: row.length > 1, 'six-branch': row.length === 6 }"`,
    );
    expect(pageSource).toContain('.graph-row.six-branch');

    expect(pageSource).toContain('aria-label="刷新当前节点详情"');
    expect(pageSource).toContain('@click="refreshGraphDetail"');
    expect(pageSource).toContain('graphStatusMeta(graphDetail.status)');
    expect(pageSource).toContain('formatGraphDetailTime(currentGraphDetailUpdatedAt)');
    expect(pageSource).toContain('v-for="(field, index) in graphDetail.fields"');
    expect(pageSource).toContain('v-if="field.description"');
    expect(pageSource).toContain('graphDetailValueIsMultiline(field.value)');
    expect(pageSource).toContain('该节点尚未执行，暂无实际产出。');
    expect(pageSource).toMatch(/\.node-fields dd\.is-multiline\s*\{[^}]*white-space:\s*pre-wrap/su);
    expect(pageSource).toContain('展示本次真实输入、阶段产物和质量结论。');
    for (const blockKind of [
      'TAG_LIST',
      'COMBINATION_LIST',
      'ROUTE_LIST',
      'PROMPT_LIST',
      'PAIR_LIST',
      'ISSUE_LIST',
    ])
      expect(pageSource).toContain(`block.kind === '${blockKind}'`);
    expect(pageSource).toContain('class="node-prompt-content"');
    expect(pageSource).toContain('展开全文');
    expect(pageSource).toContain('展开对比');
    expect(pageSource).toMatch(
      /\.workflow-graph-content\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s*420px/su,
    );
    expect(pageSource).not.toContain('执行依赖');
    expect(pageSource).not.toContain('仅展示固定业务示例');
    expect(pageSource).not.toMatch(
      /storageKey|sourceFingerprint|attemptToken|promptVersion|ARK_PROMPT_MODEL/u,
    );
  });

  it('renders the V10 relationship, coordinate, blueprint and prompt branch groups', () => {
    expect(pageSource).toContain('CURRENT_EFFECT_PROMPT_GRAPH_VERSION');
    expect(pageSource).toContain('buildEffectPromptGraphRows(');
    expect(pageSource).toContain('effectPromptGraphNodeIds(currentGraphVersion.value)');
    expect(pageSource).toContain('currentGraphEdges.value');
    expect(graphSource).toContain('sourceIndex < targetIndex');

    for (const nodeId of [
      'RELATIONSHIP_FRAGMENT_ROUTER',
      'PLAN_HOOK_RELATIONSHIPS',
      'PLAN_PAIN_RELATIONSHIPS',
      'PLAN_PRODUCT_DISPLAY_RELATIONSHIPS',
      'PLAN_SELLING_POINT_EXPLANATION_RELATIONSHIPS',
      'PLAN_CTA_RELATIONSHIPS',
      'PLAN_OUTRO_RELATIONSHIPS',
      'RELATIONSHIP_MERGE_VALIDATION',
      'DIMENSION_COORDINATE_ROUTER',
      'PLAN_HOOK_COORDINATES',
      'PLAN_PAIN_COORDINATES',
      'PLAN_PRODUCT_DISPLAY_COORDINATES',
      'PLAN_SELLING_POINT_EXPLANATION_COORDINATES',
      'PLAN_CTA_COORDINATES',
      'PLAN_OUTRO_COORDINATES',
      'COORDINATE_MERGE_VALIDATION',
      'BLUEPRINT_QUOTA_ALLOCATION',
      'BLUEPRINT_FRAGMENT_ROUTER',
      'GENERATE_HOOK_BLUEPRINTS',
      'GENERATE_PAIN_BLUEPRINTS',
      'GENERATE_PRODUCT_DISPLAY_BLUEPRINTS',
      'GENERATE_SELLING_POINT_EXPLANATION_BLUEPRINTS',
      'GENERATE_CTA_BLUEPRINTS',
      'GENERATE_OUTRO_BLUEPRINTS',
      'BLUEPRINT_ORTHOGONAL_GATE',
    ])
      expect(pageSource).toMatch(new RegExp(`\\b${nodeId}\\b`, 'u'));

    for (const blockKind of [
      'RELATIONSHIP_LIST',
      'COORDINATE_LIST',
      'BLUEPRINT_LIST',
      'ORTHOGONAL_PAIR_LIST',
    ])
      expect(pageSource).toContain(`block.kind === '${blockKind}'`);

    expect(pageSource).toContain('item.blueprintQuota');
    expect(pageSource).toContain('item.compatibleBundleCount');
    expect(pageSource).toContain('item.openingState');
    expect(pageSource).toContain('item.actionArc');
    expect(pageSource).toContain('item.endingState');
    expect(pageSource).toContain('差异 {{ item.distance }}/6');
    expect(pageSource).toContain('item.sameDimensions.map(graphDimensionLabel)');
    expect(pageSource).toContain(
      'effectPromptGraphNodeIds(currentGraphVersion.value).includes(nodeId)',
    );
    for (const groupTitle of [
      '六类营销组合并行规划',
      '六类产品专属坐标并行规划',
      '六类组合级蓝图并行生成',
      '六类视频 Prompt 并行生成',
    ])
      expect(pageSource).toContain(groupTitle);
  });

  it('persists server defaults before the first generation run', () => {
    expect(pageSource).toContain('state.settingsRevision !== null');
  });

  it('starts batch generation without automatically opening the workflow dialog', () => {
    const generationStart = pageSource.indexOf('const generateCurrentBatch');
    const generationEnd = pageSource.indexOf('const regenerateItem', generationStart);
    const generationSource = pageSource.slice(generationStart, generationEnd);

    expect(generationSource).toContain('startPolling(productId, run)');
    expect(generationSource).not.toContain('graphDialogOpen.value = true');
    expect(generationSource).not.toContain('graphCloseButton.value?.focus()');
  });

  it('acknowledges batch generation immediately and reuses an in-flight settings save', () => {
    const generationStart = pageSource.indexOf('const generateCurrentBatch');
    const generationEnd = pageSource.indexOf('const openRegenerationDialog', generationStart);
    const generationSource = pageSource.slice(generationStart, generationEnd);
    const buttonStart = pageSource.indexOf('class="primary-button heading-generate-button"');
    const buttonEnd = pageSource.indexOf('</button>', buttonStart);
    const buttonSource = pageSource.slice(buttonStart, buttonEnd);

    expect(generationSource.indexOf('batchStartPending.value = true')).toBeLessThan(
      generationSource.indexOf('await flushSettings(productId)'),
    );
    expect(generationSource).toContain('batchStartPending.value = false');
    expect(pageSource).toContain(
      'const settingsSavePromises = new Map<string, Promise<boolean>>()',
    );
    expect(pageSource).toContain('const pendingSave = settingsSavePromises.get(productId)');
    expect(buttonSource).toContain(':disabled="currentRunning || batchStartPending"');
    expect(buttonSource).toContain(':aria-busy="currentRunning || batchStartPending"');
    expect(buttonSource).toContain("? '正在提交…'");
    expect(buttonSource).not.toContain("currentSaveStatus === 'saving'");
  });

  it('shows failed-run Prompt candidates as a copy-only temporary preview', () => {
    expect(pageSource).toContain('const partialPreview = computed(');
    expect(pageSource).toContain("(!state?.resultId && state?.status !== 'FAILED')");
    expect(pageSource).toContain('class="partial-preview-banner"');
    expect(pageSource).toContain('本次任务未完成，已保留');
    expect(pageSource).toContain('当前仅支持查看和复制');
    expect(pageSource).toMatch(/v-if="!partialPreview"[\s\S]*?<Pencil/u);
    expect(pageSource).toContain(
      ':validate-disabled="partialPreview || currentRunning || validating',
    );
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
