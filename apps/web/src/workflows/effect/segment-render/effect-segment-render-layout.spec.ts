import { describe, expect, it } from 'vitest';

import parentSource from '../source-import/EffectImportNodePage.vue?raw';
import apiSource from './api/effect-segment-render.api.ts?raw';
import sourcePromptSource from './components/EffectSegmentRenderSourcePrompt.vue?raw';
import pageSource from './EffectSegmentRenderNodePage.vue?raw';
import serviceSource from './services/effect-segment-render.mock-service.ts?raw';

describe('effect segment render material gallery layout', () => {
  it('uses the only active product without rendering a product selector', () => {
    expect(pageSource).not.toContain('class="product-switcher"');
    expect(pageSource).not.toContain('<span>当前商品</span>');
    expect(pageSource).not.toContain('<select v-model="currentProductId"');
  });

  it('uses an inline result summary and a five-column material gallery without a queue rail', () => {
    for (const marker of [
      'class="segment-heading"',
      'AI 视频片段批量渲染',
      '开始批量渲染',
      'class="toolbar-result-stats"',
      '成功 <strong>{{ summary.completed }}</strong>',
      '异常 <strong>{{ summary.failed }}</strong>',
      'class="segment-material-grid"',
      'class="segment-material-card"',
      'class="prompt-pagination"',
    ])
      expect(pageSource).toContain(marker);
    expect(pageSource).toMatch(
      /\.segment-material-grid\s*\{[^}]*grid-template-columns:\s*repeat\(5,\s*minmax\(0,\s*1fr\)\)/su,
    );
    expect(pageSource).toContain('v-if="isEffectSegmentRenderBusy(task.status)"');
    expect(pageSource).not.toContain('segment-queue-rail');
    expect(pageSource).not.toContain('实时队列');
    expect(pageSource).not.toContain('segment-live-summary');
    expect(pageSource).not.toContain('live-result-counts');
    expect(pageSource).not.toContain('class="segment-stats"');
    expect(pageSource).not.toContain('AI 渲染素材池');
  });

  it('keeps one prompt mapped to one real material fragment', () => {
    expect(pageSource).toContain('每条 1 个视频素材片段');
    expect(pageSource).toContain('creativeCoreForTask(task)');
    expect(pageSource).toContain('effectSegmentRenderCreativeCoreMap(promptArtifact.payload)');
    expect(pageSource).toContain("nodeId: 'PROMPT_GENERATION'");
    expect(pageSource).not.toContain('promptExcerpt(task.promptText)');
    expect(pageSource).toContain('<p>{{ task.promptCode }}</p>');
    expect(pageSource).not.toContain('{{ task.productName }}片段 {{ taskSequenceLabel(task) }}');
    expect(pageSource).not.toContain('{{ task.promptCode }} · 每条 1 个视频素材片段');
    expect(pageSource).toContain('EFFECT_PROMPT_FRAGMENT_TYPE_LABELS');
    expect(pageSource).toContain('AI 生成');
    expect(pageSource).not.toContain('真实 AI 任务');
    expect(pageSource).toContain('class="material-preview-video"');
    expect(pageSource).toContain(':src="taskVideoUrl(task)"');
    expect(pageSource).toContain('preload="metadata"');
    expect(pageSource).toContain('@seeked="captureTaskVideoPoster(task, $event)"');
    expect(pageSource).toContain("{ 'video-ready': isTaskVideoReady(task) }");
    expect(pageSource).toContain("{ 'is-ready': isTaskVideoReady(task) }");
    expect(pageSource).toContain('task.output');
    expect(pageSource).not.toContain('4 个分镜片段');
    expect(serviceSource).not.toContain('完整成片脚本');
  });

  it('reuses the AI-generated tag and confirmed prompt creative details in dialogs', () => {
    expect(pageSource).toContain('class="origin-tag ai preview-origin-tag">AI 生成</span>');
    expect(pageSource).not.toContain('真实视频素材</em>');
    expect(pageSource).toContain('effectSegmentRenderPromptDetailsMap(promptArtifact.payload)');
    expect(pageSource.match(/<EffectSegmentRenderSourcePrompt/gu)).toHaveLength(2);
    expect(pageSource).toContain(':prompt-text="previewTask.promptText"');
    expect(pageSource).toContain(':details="previewTaskDetails"');
    expect(pageSource).toContain('heading="来源 Prompt"');
    expect(pageSource).toContain(':prompt-text="promptTask.promptText"');
    expect(pageSource).toContain(':details="promptTaskDetails"');
    expect(sourcePromptSource).toContain(
      '<pre class="source-prompt-content">{{ promptText }}</pre>',
    );
    expect(sourcePromptSource).toContain('<summary>查看创意方向</summary>');
    expect(sourcePromptSource).toContain('<summary>查看六维创意信息</summary>');
    expect(sourcePromptSource).toContain('v-for="dimension in EFFECT_PROMPT_DIMENSIONS"');
    expect(sourcePromptSource).toContain('details.dimensions[dimension.key]');
    expect(sourcePromptSource.indexOf('<pre class="source-prompt-content"')).toBeLessThan(
      sourcePromptSource.indexOf('<summary>查看创意方向</summary>'),
    );
  });

  it('caches decoded poster frames across material page changes', () => {
    expect(pageSource).toContain('const cardVideoPosterUrls = ref<Map<string, string>>(new Map())');
    expect(pageSource).toContain('const captureTaskVideoPoster =');
    expect(pageSource).toContain("canvas.toDataURL('image/jpeg', 0.76)");
    expect(pageSource).toContain('v-if="taskVideoPosterUrl(task)"');
    expect(pageSource).not.toContain('const pagedTaskVideoSignature = computed');
    expect(pageSource).toContain('v-if="isEffectSegmentRenderBusy(task.status)"');
    expect(pageSource).not.toContain('!isTaskVideoReady(task))');
  });

  it('loads video poster metadata only when a card approaches the viewport', () => {
    expect(pageSource).toContain("{ rootMargin: '240px 0px', threshold: 0.01 }");
    expect(pageSource).toContain('v-task-video-visible="taskVideoKey(task)"');
    expect(pageSource).toContain('taskVideoUrl(task) && shouldLoadTaskVideo(task)');
    expect(pageSource).toContain('loadEffectSegmentRenderWorkspaceSnapshot(');
    expect(pageSource).toContain('if (snapshot.prefetched)');
    expect(pageSource).toContain('onDeactivated(() => {');
    expect(pageSource).toContain('void loadCurrentWorkspace(false);');
  });

  it('selects the repair interval with video-backed range handles instead of time fields', () => {
    expect(pageSource).toContain('class="large-preview repair-video-preview"');
    expect(pageSource).toContain('ref="repairVideo"');
    expect(pageSource).toContain('class="repair-range-input repair-range-input-start"');
    expect(pageSource).toContain('class="repair-range-input repair-range-input-end"');
    expect(pageSource).toContain('aria-label="返修范围开始位置"');
    expect(pageSource).toContain('aria-label="返修范围结束位置"');
    expect(pageSource.match(/:disabled="!previewVideoReady"/gu)).toHaveLength(7);
    expect(pageSource).toContain('@timeupdate="stopRepairRangePreviewAtEnd"');
    expect(pageSource).toContain('toggleRepairRangePreview');
    expect(pageSource).toContain('@pointerdown="selectRepairBoundaryAtTrack"');
    expect(pageSource).toContain('@click="selectRepairBoundary(\'start\')"');
    expect(pageSource).toContain('@click="selectRepairBoundary(\'end\')"');
    expect(pageSource).toContain('@click="setRepairBoundaryFromCurrentFrame(\'start\')"');
    expect(pageSource).toContain('@click="setRepairBoundaryFromCurrentFrame(\'end\')"');
    expect(pageSource).toContain('@click="nudgeRepairBoundary(-0.1)"');
    expect(pageSource).toContain('@click="nudgeRepairBoundary(0.1)"');
    expect(pageSource).toContain('当前画面');
    expect(pageSource).toContain('这个范围内需要修改什么');
    expect(pageSource).not.toContain('开始时间（秒）');
    expect(pageSource).not.toContain('结束时间（秒）');
    expect(pageSource).toContain('startMs: Math.round(repairStartSeconds.value * 1000)');
    expect(pageSource).toContain('endMs: Math.round(repairEndSeconds.value * 1000)');
  });

  it('uses the prompt-node search and purpose filter pattern with toggleable selection actions', () => {
    for (const marker of [
      '导入素材',
      '导出素材',
      "openTransferPanel('import', $event)",
      "openTransferPanel('export', $event)",
      'class="segment-transfer-drawer"',
      '选择素材',
      'v-if="selectionMode && canPreviewTask(task)"',
      'class="prompt-search"',
      'class="prompt-search__clear"',
      'class="purpose-filter-bar"',
      '包含兼容用途',
      'class="compatible-purpose-tags"',
      '还适合',
      '异常片段',
      "allFilteredSelected ? '取消全选' : '全选筛选结果'",
      'deleteSelectedMaterials',
      '导出所选',
      'retryTask(task.id)',
      '画面返修',
      '生成返修候选',
      "decideRepair(task, 'ACCEPT')",
      "decideRepair(task, 'DISCARD')",
    ])
      expect(pageSource).toContain(marker);
    expect(pageSource).toContain("if (hasBatch.value) return '重新渲染'");
    expect(pageSource).not.toContain('重新渲染（${promptCount.value}）');
    expect(pageSource).toContain('<RefreshCw v-else-if="hasBatch && canStartBatch" :size="14" />');
    expect(pageSource).toContain('重新渲染全部片段');
    expect(pageSource).toContain('再次产生供应商费用');
    expect(pageSource).toContain('原批次数据不会删除');
    expect(pageSource).not.toContain('批量删除');
    expect(pageSource).toContain('真实素材删除接口尚未接入');
    expect(pageSource).toContain('@keydown.esc="closeTransferPanel(true)"');
    expect(pageSource).toContain('trigger?.isConnected && trigger.focus()');
    expect(pageSource).toContain(
      'selectionMode ? toggleTaskSelection(task.id) : openPreview(task, $event)',
    );
    expect(pageSource).toContain('v-if="!selectionMode" class="material-card-actions"');
  });

  it('copies the prompt-node pagination controls and page size options', () => {
    expect(pageSource).toContain('class="prompt-pagination"');
    expect(pageSource).toContain('class="prompt-page-size"');
    expect(pageSource).toContain('EFFECT_PROMPT_PAGE_SIZE_OPTIONS');
    expect(pageSource).toContain('@change="changePageSize"');
    expect(pageSource).toContain('aria-label="每页展示数量"');
    expect(pageSource).not.toContain('class="segment-pagination"');
  });

  it('only exposes the four approved video models and constrains dependent settings', () => {
    for (const model of [
      'Doubao-Seedance-2.5',
      'Doubao-Seedance-2.0',
      'Doubao-Seedance-2.0-mini',
      'Doubao-Seedance-2.0-fast',
    ])
      expect(pageSource).toContain(`label: '${model}'`);
    expect(pageSource).not.toContain("label: 'Seedance 1.5 Pro'");
    expect(pageSource).not.toContain("label: 'Seedance 1.0'");
    expect(pageSource).toContain("resolutions: ['480p', '720p', '1080p']");
    expect(pageSource.match(/resolutions: \['480p', '720p'\]/gu)).toHaveLength(3);
    expect(pageSource).toContain('selectedCapability.value.ratios.map');
    expect(pageSource).toContain('selectedCapability.value.resolutions.map');
    expect(pageSource).toContain('next.resolution = capability.defaultResolution');
    expect(pageSource).toContain('field-label="视频模型"');
  });

  it('uses the real API for all supported render lifecycle operations', () => {
    for (const handler of [
      'startEffectSegmentRenderBatch',
      'regenerateEffectSegmentRenderTasks',
      'getEffectSegmentRenderTaskContent',
      'effectSegmentRenderTaskContentUrl',
      'startEffectSegmentRenderRepair',
      'decideEffectSegmentRenderRepair',
      'validateEffectSegmentRenderBatch',
    ])
      expect(apiSource).toContain(handler);
    expect(pageSource).not.toContain("from './services/effect-segment-render.mock-service'");
    expect(pageSource).toContain('真实 Seedance 任务');
    expect(pageSource).toContain('pollTimer = setTimeout');
    expect(pageSource).not.toContain('setInterval(');
  });

  it('matches the immediate preview frame to the configured render ratio', () => {
    expect(pageSource).toContain("configuredRatio === 'adaptive' ? '16:9' : configuredRatio");
    expect(pageSource).toContain(':style="previewFrameStyle"');
    expect(pageSource).toContain(':style="repairFrameStyle"');
    expect(pageSource).toContain('aspectRatio: `${width} / ${height}`');
    expect(pageSource).toContain('width: `min(100%, calc(${maxHeightVh}vh * ${widthToHeight}))`');
    expect(pageSource).toContain('effectSegmentRenderFrameStyle(62)');
    expect(pageSource).toContain('effectSegmentRenderFrameStyle(44)');
    expect(pageSource).not.toMatch(/\.large-preview\s*\{[^}]*height:\s*250px/su);
  });

  it('shows a real initial empty state without a duplicate call to action', () => {
    const emptyState = pageSource.match(
      /<div v-else-if="!hasBatch && !tasks\.length" class="segment-batch-empty">[\s\S]*?<\/div>/u,
    )?.[0];
    expect(emptyState).toContain('尚未创建视频渲染任务');
    expect(emptyState).toContain('从页头开始提交真实批量渲染');
    expect(emptyState).not.toContain('<button');
    expect(serviceSource).toContain("batchStatus: 'NOT_STARTED'");
    expect(serviceSource).toContain('tasks: []');
  });

  it('uses common workflow controls and only replaces step four', () => {
    expect(pageSource).toContain('<WorkflowNodeDraftBar');
    expect(pageSource).toContain('<WorkflowNodeFooter');
    expect(pageSource).toContain('真实工作副本已提交');
    expect(pageSource).not.toContain('保存到项目资产库');
    expect(pageSource).not.toContain('localStorage');
    expect(parentSource).toContain(
      "import EffectSegmentRenderNodePage from '../segment-render/EffectSegmentRenderNodePage.vue'",
    );
    expect(parentSource).toContain('v-else-if="activeStep === 3"');
    expect(parentSource).toContain('@back="selectWorkflowStep(2)"');
    expect(parentSource).toContain('@next="selectWorkflowStep(4)"');
    expect(parentSource).toContain('v-if="activeDownstreamBoundary"');
  });
});
