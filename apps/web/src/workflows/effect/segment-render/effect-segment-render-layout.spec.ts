import { describe, expect, it } from 'vitest';

import parentSource from '../source-import/EffectImportNodePage.vue?raw';
import pageSource from './EffectSegmentRenderNodePage.vue?raw';
import serviceSource from './services/effect-segment-render.mock-service.ts?raw';

describe('effect segment render material gallery layout', () => {
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

  it('keeps one prompt mapped to one material fragment and distinguishes imported origins', () => {
    expect(pageSource).toContain('每条 1 个视频素材片段');
    expect(pageSource).toContain('promptExcerpt(task.promptText)');
    expect(pageSource).toContain('<p>{{ task.promptCode }}</p>');
    expect(pageSource).not.toContain('{{ task.productName }}片段 {{ taskSequenceLabel(task) }}');
    expect(pageSource).not.toContain('{{ task.promptCode }} · 每条 1 个视频素材片段');
    expect(pageSource).toContain('EFFECT_PROMPT_FRAGMENT_TYPE_LABELS');
    expect(serviceSource).toContain("source: 'PROMPT'");
    expect(serviceSource).toContain("origin: 'AI_GENERATED'");
    expect(serviceSource).toContain("origin: 'EXTERNAL_IMPORT'");
    expect(serviceSource).toContain('importedByPromptId');
    expect(pageSource).not.toContain('4 个分镜片段');
    expect(serviceSource).not.toContain('完整成片脚本');
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
    ])
      expect(pageSource).toContain(marker);
    expect(pageSource).not.toContain('批量重新生成');
    expect(pageSource).not.toContain('批量删除');
    expect(pageSource).toContain('删除视频素材');
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

  it('keeps async mock operations in the service and never performs a network request', () => {
    for (const handler of [
      'startEffectSegmentRenderBatch',
      'regenerateEffectSegmentRenderTasks',
      'inspectEffectSegmentRenderImports',
      'importEffectSegmentRenderFiles',
      'deleteEffectSegmentRenderMaterials',
      'createEffectSegmentRenderExport',
    ])
      expect(serviceSource).toContain(handler);
    expect(serviceSource).toContain('const workspaces = new Map');
    expect(serviceSource).toContain('自动重试已达上限');
    expect(serviceSource).not.toContain('fetch(');
    expect(pageSource).not.toContain('setInterval(');
  });

  it('shows a real initial empty state without a duplicate call to action', () => {
    const emptyState = pageSource.match(
      /<div v-else-if="!hasBatch && !tasks\.length" class="segment-batch-empty">[\s\S]*?<\/div>/u,
    )?.[0];
    expect(emptyState).toContain('尚未创建视频渲染任务');
    expect(emptyState).toContain('从页头导入已有素材，或开始批量渲染');
    expect(emptyState).not.toContain('<button');
    expect(serviceSource).toContain("batchStatus: 'NOT_STARTED'");
    expect(serviceSource).toContain('tasks: []');
  });

  it('uses common workflow controls and only replaces step four', () => {
    expect(pageSource).toContain('<WorkflowNodeDraftBar');
    expect(pageSource).toContain('<WorkflowNodeFooter');
    expect(pageSource).toContain('尚未提交真实工作副本');
    expect(pageSource).not.toContain('保存到项目资产库');
    expect(pageSource).not.toContain('localStorage');
    expect(parentSource).toContain(
      "import EffectSegmentRenderNodePage from '../segment-render/EffectSegmentRenderNodePage.vue'",
    );
    expect(parentSource).toContain('v-else-if="activeStep === 3"');
    expect(parentSource).toContain('@back="selectWorkflowStep(2)"');
    expect(parentSource).toContain('@next="selectWorkflowStep(4)"');
    expect(parentSource).toContain('v-else-if="activeDownstreamBoundary"');
  });
});
