import { describe, expect, it } from 'vitest';

import viteConfigSource from '../../../../vite.config.ts?raw';
import pageSource from './EffectInfoExtractionNodePage.vue?raw';
import listSource from '../../../platform/workflow/components/WorkflowSellingPointsEditor.vue?raw';

import graphSource from '../../../platform/workflow/components/WorkflowExtractionGraphDialog.vue?raw';
import actionsSource from '../../../platform/workflow/components/WorkflowExtractionActions.vue?raw';
import editSource from '../../../platform/workflow/components/WorkflowNodeEditActions.vue?raw';
const normalizedPageSource = pageSource.replace(/\r\n?/gu, '\n');

describe('effect info extraction result layout', () => {
  it('always renders the complete extraction form and keeps ungenerated fields empty', () => {
    expect(pageSource).toContain('class="result-grid"');
    expect(pageSource).toContain('class="content-block product-base-card"');
    expect(pageSource).toContain("currentState.value?.result?.[field] ?? ''");
    expect(pageSource).toContain("sellingPoints: ['']");
    expect(pageSource).not.toContain('v-else-if="!currentState.result"');
  });

  it('stacks product basics above a two-column selling-point layer', () => {
    expect(pageSource).not.toContain('class="product-info-layout"');
    expect(pageSource).toContain('grid-template-columns: minmax(0, 1fr);');
    expect(normalizedPageSource).toContain("grid-template-areas:\n    'base'\n    'selling';");
    expect(pageSource).toContain('.product-base-card {');
    expect(pageSource).toContain('grid-area: base;');
    expect(pageSource).toContain('class="content-block selling-layer-card"');
    expect(pageSource).toContain('.selling-layer-card {');
    expect(pageSource).toContain('grid-area: selling;');
    expect(pageSource).toContain('<WorkflowSellingPointsEditor');
    expect(listSource).toContain('.selling-points--unified {');
    expect(pageSource).toContain('grid-template-columns: repeat(2, minmax(0, 1fr));');
    expect(listSource.replace(/\r\n?/gu, '\n')).toContain(
      '@media (max-width: 860px) {\n  .selling-points--unified {',
    );
    expect(pageSource).not.toContain('grid-area: user;');
    expect(pageSource).not.toContain('grid-area: scenario;');
  });

  it('uses one selling-point heading without row prefixes or hierarchy', () => {
    expect(pageSource).toContain('<h3>卖点</h3>');
    expect(pageSource).toContain('class="selling-point-count"');
    expect(pageSource).toContain('class="selling-point-count__value"');
    expect(pageSource).toContain('{{ visibleResult.sellingPoints.length }} 条卖点');
    expect(pageSource).toContain(
      '建议精简至 ${EFFECT_EXTRACTION_RECOMMENDED_SELLING_POINTS} 条以内',
    );
    expect(pageSource).toContain('这些卖点可用于后续视频创作，您可以按需修改、添加或删除。');
    expect(pageSource).toContain('EFFECT_EXTRACTION_RECOMMENDED_SELLING_POINTS');
    expect(listSource).toContain(':aria-label="`卖点 ${index + 1}`"');
    expect(pageSource).not.toContain('卖点分层');
    expect(pageSource).not.toContain('>核心卖点');
    expect(pageSource).not.toContain('>次要卖点');
    expect(listSource).toContain('grid-template-columns: minmax(0, 1fr) 38px;');
  });

  it('uses the heading action as the only extraction trigger instead of a lower empty-state button', () => {
    expect(pageSource).not.toContain('empty-result-card');
    expect(pageSource).not.toContain('processing-card');
    expect(pageSource).not.toContain('尚未生成提炼结果');
    expect(pageSource).toContain('@extract="runCurrentExtraction()"');
  });

  it('keeps re-extraction clickable after a version is confirmed and enters the isolated edit itself', () => {
    expect(pageSource).not.toContain(':disabled="currentRunning || !editing"');
    expect(pageSource).not.toContain(':disabled="!editing"');
    expect(
      pageSource.match(
        /:disabled="editBusy \|\| currentRunning"\s+@click="runCurrentExtraction\(\)"/g,
      ),
    ).toHaveLength(1);
    expect(pageSource).toContain(
      'const ensureExtractionEdit = async (productId: string): Promise<boolean> => {',
    );
    expect(pageSource).toContain('const result = await beginEffectNodeEdit(');
    expect(pageSource).toContain("'INFORMATION_EXTRACTION',");
    expect(pageSource).toContain('result.data.run.id === props.workflowRunId');
    expect(pageSource).toContain('result.data.productIdMap[productId] ?? productId');
    expect(pageSource).toContain('requestPendingExtractionRun(');
    expect(pageSource).toContain('const resumePendingExtraction = (): void => {');
    expect(pageSource).toContain('takePendingExtractionRun(props.projectId)');
    expect(pageSource).toContain('void runCurrentExtraction({ skipConfirm: true })');
    expect(pageSource).toContain("'请先保存或取消当前编辑，再重新提炼'");
  });

  it('flushes pending field edits before opening the isolated edit branch', () => {
    const extractionSource = normalizedPageSource.match(
      /const runCurrentExtraction = async[\s\S]*?\n\};/,
    )?.[0];

    expect(extractionSource).toBeDefined();
    expect(extractionSource).toContain('await flushPendingEdits()');
    expect(extractionSource).toContain('await ensureExtractionEdit(product.id)');
    expect(extractionSource!.indexOf('await flushPendingEdits()')).toBeLessThan(
      extractionSource!.indexOf('await ensureExtractionEdit(product.id)'),
    );
  });

  it('uses the only active product without rendering a product selector', () => {
    expect(pageSource).not.toContain('class="product-switcher"');
    expect(pageSource).not.toContain('<span>当前商品</span>');
    expect(pageSource).not.toContain('<select :value="currentProductId"');
    expect(actionsSource).toContain('class="secondary-button workflow-graph-trigger"');
  });

  it('runs only the selected product and exposes progress and conflict recovery', () => {
    expect(pageSource).not.toContain('全部提炼');
    expect(pageSource).not.toContain('runBatchExtraction');
    expect(pageSource).not.toContain('batchBusy');
    expect(pageSource).toContain('currentState.progress');
    expect(pageSource).toContain('加载最新结果');
    expect(pageSource).not.toContain('部分来源有提示，已使用其余有效资料完成提炼');
    expect(pageSource).not.toContain('class="state-alert warning extraction-warnings"');
    expect(pageSource).toContain('refreshImageRecognition: Boolean(state.runId || state.resultId)');
  });

  it('uses the shared workflow progress component and opens the node graph from it', () => {
    expect(pageSource).toContain('WorkflowRunProgress');
    expect(pageSource).toContain(':progress="currentState.progress"');
    expect(pageSource).toContain(':summary="currentProgressLabel"');
    expect(pageSource).toContain('@show-details="openGraphDialog"');
    expect(pageSource).not.toContain('class="run-progress"');
    expect(pageSource).not.toContain('class="state-alert running"');
  });

  it('does not turn a browser connection interruption into a failed extraction run', () => {
    expect(pageSource).toContain('isNetworkError(error)');
    expect(pageSource).toContain('const previousState = cloneExtractionProductState(state)');
    expect(pageSource).toContain('replaceState(previousState)');
    expect(pageSource).toContain('任务不会因此被标记为失败');
    expect(pageSource).toContain('任务仍在后台运行');
  });

  it('uses the same global draft bar and footer, with validation beside the edit button', () => {
    expect(pageSource).not.toContain('<WorkflowNodeDraftBar');
    expect(pageSource).toContain('<WorkflowNodeFooter');
    expect(pageSource).toContain('back-label="上一步：资料导入"');
    expect(pageSource).toContain('next-label="下一步：素材 Prompt"');
    expect(pageSource).toContain('<WorkflowNodeEditActions');
    expect(editSource).toContain('进入编辑');
    expect(pageSource).toContain(':show-validate="false"');
    expect(pageSource).toContain('@save="validateCurrentResult"');
    expect(editSource).toContain('取消编辑');
    expect(editSource).toContain('CheckCircle2');
    expect(editSource).toContain('保存版本');
    expect(pageSource).not.toContain('class="extraction-footer"');
    expect(pageSource).not.toContain('class="draft-save-bar"');
  });

  it('treats a missing first-visit node state as an empty draft without issuing a failing GET', () => {
    expect(pageSource).toContain('getActiveWorkflowRunOverview(');
    expect(pageSource).toContain(
      "overview.data.nodeStates.find((item) => item.nodeId === 'INFORMATION_EXTRACTION')",
    );
    expect(pageSource).toContain('nodeStateRevision.value = 0');
  });

  it('shares the accessible real-status graph renderer with customized extraction', () => {
    expect(pageSource).toContain('<WorkflowExtractionGraphDialog');
    expect(pageSource).toContain('EFFECT_EXTRACTION_GRAPH_NODES.map');
    expect(pageSource).toContain('loadEffectExtractionNodeDetail');
    for (const token of [
      'role=',
      'aria-modal=',
      'graphCloseButton',
      'workflow-node-detail',
      '仅展示安全摘要',
    ])
      expect(graphSource).toContain(token);
    expect(graphSource).toContain('grid-template-columns: repeat(3, minmax(0, 1fr));');
    expect(pageSource).not.toContain('structuredOutput');
    expect(graphSource).not.toContain('textStorageKey');
  });

  it('renders snapshot materials as import-style cards and explains an unclaimed queued task', () => {
    expect(pageSource).toContain('本次共使用');
    expect(pageSource).toContain("materialCount('PRODUCT_IMAGE')");
    expect(pageSource).toContain("kind: 'LINK' as const");
    expect(graphSource).toContain("source.media.kind === 'LINK'");
    expect(pageSource).toContain("'commerceUrlCount', '电商链接', '个'");
    expect(graphSource).toContain('class="workflow-node-detail__source-visual"');
    expect(graphSource).toContain(':src="graphPreviewUrl(source)!"');
    expect(graphSource).toContain('graphDetailBytes(source.media.sizeBytes)');
    expect(pageSource).toContain('AI 提炼服务暂未接单');
    expect(pageSource).toContain('任务已经保存，不会丢失');
    expect(pageSource).toContain(
      'extractionProgressMessage(currentState.value, currentGraphNodes.value)',
    );
    expect(pageSource).not.toContain('等待异步 Worker 接收任务');
  });

  it('lets document and image branches extract product identity without a form branch', () => {
    expect(pageSource).not.toContain("FORM: '");
    expect(pageSource).toContain("materialSources(['PRODUCT_IMAGE'])");
    expect(graphSource).toContain('v-for="(source, sourceIndex) in graphDetail.sources"');
    expect(pageSource).not.toContain("nodeId === 'FORM'");
    expect(pageSource).not.toContain("detailField('productName', '产品名称', product.name");
    expect(pageSource).not.toContain("detailField('resolution', '分辨率'");
  });

  it('keeps product facts editable and only marks image-recognition additions', () => {
    expect(pageSource).toContain('EFFECT_EXTRACTION_RECOMMENDED_SELLING_POINTS');
    expect(pageSource).toContain("result.sellingPoints.push('')");
    expect(pageSource).toContain(':disabled="baseFieldsReadonly"');
    expect(pageSource).not.toContain('最多添加');
    expect(listSource).toContain(
      'placeholder="例如：原料、工艺、功能、口味、用法、场景或可信背书"',
    );
    expect(pageSource).toContain('class="selling-add-button"');
    expect(pageSource).not.toContain('.block-heading .selling-add-button');
    for (const field of ['secondarySellingPoints', 'corePainPoints', 'usageScenarios'])
      expect(pageSource).not.toContain(field);
    expect(pageSource).not.toContain('<h3>全局视频配置</h3>');
    expect(pageSource).not.toContain('updateProductionRule');
    expect(pageSource).not.toContain('v-model="newDisabledElement"');
    expect(pageSource).toContain('图片识别补充 ·');
    expect(pageSource).toContain('图片识别已完成，本次没有新增信息');
    expect(pageSource).toContain('imageRecognitionWithoutNewFacts');
    expect(pageSource).toContain("if (!shouldShowOrigin(origin)) return ''");
    expect(pageSource).toContain('originSourceLabel');
    expect(pageSource).toContain('origin-chip');
    expect(pageSource).toContain("em[data-origin='USER_FACT']");
    expect(pageSource).toContain('display: none;');
    expect(pageSource).toContain("itemOrigin('sellingPoints', index)");
    expect(pageSource).toContain("fieldOrigin('priceRange')");
    expect(pageSource).toContain('semantic-fact-notice');
    expect(pageSource).toContain("itemSemanticNotices('sellingPoints', index)");
    expect(pageSource).toContain("markListFieldDirty('sellingPoints')");
    expect(pageSource).toContain('delete item.semanticNotices');
    expect(pageSource).toContain('dismissSemanticNotice');
    expect(pageSource).toContain('aria-label="关闭这条建议"');
    expect(pageSource).toContain('dismissedSemanticNoticesByProduct');
    expect(pageSource).toContain('dismissedSemanticNotices: Object.fromEntries');
    expect(pageSource).toContain('dismissed?.resultId === state.resultId');
    expect(pageSource).toContain('persistNodeState(false, false)');
  });

  it('does not maintain separate audience, pain, decision or scenario editors', () => {
    expect(pageSource).not.toContain('addUserInsightItem');
    expect(pageSource).not.toContain('addScenarioItem');
    expect(pageSource).not.toContain('class="field-label user-marketing-goal"');
    expect(pageSource).not.toContain('class="content-block user-layer-card"');
    expect(pageSource).not.toContain('class="content-block scenario-layer-card"');
  });

  it('edits every selling point as an independent row', () => {
    expect(pageSource).toContain(':items="visibleResult.sellingPoints"');
    expect(pageSource).toContain('@update-item="updateSellingPoint"');
    expect(pageSource).toContain('result.sellingPoints[index] = value;');
    expect(pageSource).toContain('@remove="removeSellingPoint"');
    expect(pageSource).toContain('@click="addSellingPoint"');
    expect(pageSource).toContain('if (value.trim() && !(await confirmInformationRemoval');
    expect(listSource).toContain('暂无卖点，可点击“添加”补充。');
    expect(pageSource).not.toContain('visibleResult.sellingPoints.length <= 1');
    expect(pageSource).not.toContain('textListValue');
    expect(pageSource).not.toContain('updateTextList');
  });

  it('translates internal fusion conflict messages into concise user-facing Chinese', () => {
    expect(pageSource).toContain('const presentWarningMessage');
    expect(pageSource).toContain("product_category: '品类'");
    expect(pageSource).toContain("visual_style_baseline: '视觉风格基线'");
    expect(pageSource).toContain('存在多种识别结果，已优先采用');
    expect(pageSource).not.toContain(
      '{{ warningBranchLabel(warning.branch) }}：{{ warning.message }}',
    );
  });

  it('does not let an old result save overwrite a rerun result', () => {
    expect(pageSource).toContain(
      'if (saveResult && current && isExtractionRunning(current)) return true',
    );
    expect(pageSource).toContain('const savingResultId = current?.resultId ?? null');
    expect(pageSource).toContain('const savingResultRevision = current?.resultRevision ?? null');
    expect(pageSource).toContain('latest.resultId !== savingResultId');
    expect(pageSource).toContain('latest.resultRevision !== savingResultRevision');
    expect(pageSource).toContain('saveController?.abort()');
  });

  it('loads contracts source directly in the Vite dev server', () => {
    expect(viteConfigSource).toContain("'@ai-marketing/contracts': contractsSource");
    expect(viteConfigSource).toContain("exclude: ['@ai-marketing/contracts']");
    expect(viteConfigSource).not.toContain("needsInterop: ['@ai-marketing/contracts']");
  });
});
