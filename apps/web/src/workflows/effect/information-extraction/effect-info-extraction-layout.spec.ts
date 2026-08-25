import { describe, expect, it } from 'vitest';

import viteConfigSource from '../../../../vite.config.ts?raw';
import pageSource from './EffectInfoExtractionNodePage.vue?raw';

describe('effect info extraction result layout', () => {
  it('always renders the complete extraction form and keeps ungenerated fields empty', () => {
    expect(pageSource).toContain('class="product-info-layout"');
    expect(pageSource).toContain('class="result-grid"');
    expect(pageSource).toContain("currentState.value?.result?.[field] ?? ''");
    expect(pageSource).toContain("coreSellingPoints: ['']");
    expect(pageSource).not.toContain('v-else-if="!currentState.result"');
  });

  it('uses the heading action as the only extraction trigger instead of a lower empty-state button', () => {
    expect(pageSource).not.toContain('empty-result-card');
    expect(pageSource).not.toContain('processing-card');
    expect(pageSource).not.toContain('尚未生成提炼结果');
    expect(pageSource.match(/@click="runCurrentExtraction"/g)).toHaveLength(3);
  });

  it('runs only the selected product and exposes progress, warnings and conflict recovery', () => {
    expect(pageSource).not.toContain('全部提炼');
    expect(pageSource).not.toContain('runBatchExtraction');
    expect(pageSource).not.toContain('batchBusy');
    expect(pageSource).toContain('currentState.progress');
    expect(pageSource).toContain('currentState.warnings');
    expect(pageSource).toContain('加载最新结果');
  });

  it('uses the same global validation footer as the source import node', () => {
    expect(pageSource).toContain('<WorkflowNodeFooter');
    expect(pageSource).toContain('back-label="上一步"');
    expect(pageSource).toContain('next-label="下一步：Prompt 生成"');
    expect(pageSource).toContain('@validate="validateCurrentResult"');
    expect(pageSource).not.toContain('class="extraction-footer"');
  });

  it('treats a missing first-visit node state as an empty draft without issuing a failing GET', () => {
    expect(pageSource).toContain('getActiveWorkflowRunOverview(');
    expect(pageSource).toContain(
      "overview.data.nodeStates.find((item) => item.nodeId === 'INFORMATION_EXTRACTION')",
    );
    expect(pageSource).toContain('nodeStateRevision.value = 0');
  });

  it('opens one accessible real-status workflow dialog without exposing intermediate payloads', () => {
    expect(pageSource.match(/>查看工作流/g)).toHaveLength(1);
    expect(pageSource).toContain('role="dialog"');
    expect(pageSource).toContain('aria-modal="true"');
    expect(pageSource).toContain('EFFECT_EXTRACTION_GRAPH_EDGES.filter');
    expect(pageSource).toContain("graphExecution('FUSION')");
    expect(pageSource).toContain("graphExecution('NORMALIZATION')");
    expect(pageSource).toContain('ref="graphCloseButton"');
    expect(pageSource).toContain("graphExecution('FUSION').errorMessage");
    expect(pageSource).toContain("graphExecution('NORMALIZATION').warnings");
    expect(pageSource).toContain('role="button"');
    expect(pageSource).toContain('@keydown.enter.prevent="selectGraphNode');
    expect(pageSource).toContain('class="workflow-node-detail"');
    expect(pageSource).toContain('点击节点查看数据');
    expect(pageSource).toContain('loadEffectExtractionNodeDetail');
    expect(pageSource).toContain('仅展示安全摘要');
    expect(pageSource).not.toContain('structuredOutput');
    expect(pageSource).not.toContain('textStorageKey');
  });

  it('renders snapshot materials as import-style cards and explains an unclaimed queued task', () => {
    expect(pageSource).toContain('本次共使用');
    expect(pageSource).toContain("materialCount('PRODUCT_IMAGE')");
    expect(pageSource).toContain('class="workflow-node-detail__source-visual"');
    expect(pageSource).toContain(':src="graphPreviewUrl(source)!"');
    expect(pageSource).toContain('graphDetailBytes(source.media.sizeBytes)');
    expect(pageSource).toContain('AI 提炼服务暂未接单');
    expect(pageSource).toContain('任务已经保存，不会丢失');
    expect(pageSource).toContain('正在等待 AI 提炼服务接单');
    expect(pageSource).not.toContain('等待异步 Worker 接收任务');
  });

  it('shows only the five global video fields in the form node and keeps image results per file', () => {
    for (const label of ['视频时长', '画幅比例', '风格基调', '投放渠道', '禁用元素']) {
      expect(pageSource).toContain(`'${label}'`);
    }
    expect(pageSource).toContain("FORM: '读取导入节点的全局视频配置'");
    expect(pageSource).toContain("materialSources(['PRODUCT_IMAGE'])");
    expect(pageSource).toContain('v-for="(source, sourceIndex) in graphDetail.sources"');
    expect(pageSource).not.toContain("detailField('resolution', '分辨率'");
    expect(pageSource).not.toContain("detailField('frameRate', '帧率'");
  });

  it('treats the recommended selling-point count as guidance instead of a hard limit', () => {
    expect(pageSource).toContain('EFFECT_EXTRACTION_MAX_CORE_SELLING_POINTS');
    expect(pageSource).toContain("result.coreSellingPoints.push('')");
    expect(pageSource).toContain('placeholder="请输入核心卖点"');
    expect(pageSource).not.toContain('result.coreSellingPoints.length >= 3');
    expect(pageSource).not.toContain('visibleResult.coreSellingPoints.length >= 3');
  });

  it('translates internal fusion conflict messages into concise user-facing Chinese', () => {
    expect(pageSource).toContain('const presentWarningMessage');
    expect(pageSource).toContain("product_category: '品类'");
    expect(pageSource).toContain('存在多种识别结果，已优先采用');
    expect(pageSource).not.toContain(
      '{{ warningBranchLabel(warning.branch) }}：{{ warning.message }}',
    );
  });

  it('keeps CommonJS contracts named exports available in the Vite dev server', () => {
    expect(viteConfigSource).toContain("needsInterop: ['@ai-marketing/contracts']");
  });
});
