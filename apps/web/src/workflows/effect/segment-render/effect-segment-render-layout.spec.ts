import { describe, expect, it } from 'vitest';
import { effectSegmentRenderModels } from './effect-segment-render-models';

import parentSource from '../source-import/EffectImportNodePage.vue?raw';
import apiSource from './api/effect-segment-render.api.ts?raw';
import importBatchSource from './effect-segment-import-batch.ts?raw';
import sourcePromptSource from './components/EffectSegmentRenderSourcePrompt.vue?raw';
import pageSource from './EffectSegmentRenderNodePage.vue?raw';
import serviceSource from './services/effect-segment-render.mock-service.ts?raw';

describe('effect segment render material gallery layout', () => {
  it('resolves remapped product identities on every load, including KeepAlive reactivation', () => {
    const loader = pageSource.split('const loadCurrentWorkspace = async')[1]!
      .split('const updateRenderSetting')[0]!;
    expect(loader.indexOf('effectSegmentRenderCurrentProductId(props.products, currentProductId.value)'))
      .toBeLessThan(loader.indexOf('const product = currentProduct.value'));
    expect(loader).toContain('if (nextProductId !== currentProductId.value)');
    expect(loader).toContain('skipNextProductLoad = true;');
    expect(loader).toContain('currentProductId.value = nextProductId;');
    expect(pageSource.split('onActivated(() => {')[1]!.split('onDeactivated')[0]!)
      .toContain('void loadCurrentWorkspace(false)');
    expect(loader).toContain('generation !== loadGeneration || controller.signal.aborted');
  });
  it('keeps the render component mounted while its own editing Run is synchronized in the background', () => {
    expect(parentSource).toContain(':key="`render:${currentProjectId}`"');
    expect(parentSource).not.toContain(':key="`render:${currentProjectId}:${workspace?.workflowRunId');
    expect(parentSource).toContain('{ showCurtain: false }).finally(settled)');
    expect(pageSource).toContain('expectedSynchronizedRunId === props.workflowRunId');
    expect(pageSource).toContain('generation === synchronizationGeneration');
    expect(pageSource).toContain('void loadCurrentWorkspace(!preserveView)');
    expect(pageSource).toContain(':inert="workspaceSynchronizing || runSynchronizing || undefined"');
    expect(pageSource).toContain('current.workflowRunId !== props.workflowRunId');
    expect(pageSource).toContain('workspaceSynchronizing.value = false');
  });
  it('continues polling after rejecting an obsolete batch response', () => {
    expect(pageSource).toContain('if (pollController === controller) {');
    expect(pageSource).toContain('workspace.value?.batchId === batchId && !pollTimer');
    expect(pageSource).toContain('schedulePolling(workspace.value)');
    expect(pageSource).toMatch(/pollTimer = setTimeout\(\(\) => \{ pollTimer = undefined; void pollBatch\(\); \},/);
  });
  it('auto-saves local updates and returns to the committed branch even when newer Prompt differences remain', () => {
    expect(pageSource).toContain('校验通过后自动保存到当前分支');
    expect(pageSource).not.toContain('完成后请保存修改');
    expect(pageSource).toContain('synchronizeWorkflowRun(nextWorkspace.committedWorkflowRunId)');
    expect(pageSource).toContain('v-if="!workspace?.autoCommitPending"');
    expect(pageSource).toContain('!workspace.value?.autoCommitPending && Boolean(props.editing');
  });
  it('uses signed confirmations, no-op responses and frozen draft saves with late-response protection', () => {
    expect(pageSource).toContain('expectedDifferenceSignature: current.refreshSignature');
    expect(pageSource).toContain('response.data.noChanges');
    expect(pageSource).toContain('canSaveFrozenResults');
    expect(pageSource).toContain('epoch !== pollEpoch');
    expect(pageSource).toContain('batch.revision < (current.batchRevision ?? 0)');
    expect(pageSource).toContain("window.addEventListener('focus', refreshOnFocus)");
    expect(pageSource).toContain('needsPolling(nextWorkspace) ? 3000 : 10000');
  });
  it('offers revision-guarded selective refresh for changed and newly added Prompts', () => {
    expect(pageSource).toContain(
      'tasksNeedingUpdate.value.length + (workspace.value?.pendingPromptIds?.length ?? 0)',
    );
    expect(pageSource).toContain('refreshEffectSegmentRenderBatch(');
    expect(pageSource).toContain('expectedBatchRevision: current.batchRevision');
    expect(pageSource).toContain('expectedPromptArtifactRevision: current.promptArtifactRevision');
    expect(pageSource).toContain('@click="startBatch(true)"');
    expect(apiSource).toContain('/refresh');
  });
  it('places the yellow local update action first and names full rerender concisely', () => {
    const actions = pageSource.split('<div class="segment-heading__actions">')[1]!
      .split('</div>')[0]!;
    expect(actions.indexOf('segment-local-update-button')).toBeLessThan(
      actions.indexOf('v-if="hasConfirmedRender && !editing"'),
    );
    expect(actions).toContain('<RefreshCw v-else :size="14" />{{ startButtonLabel }}');
    expect(actions).toContain('<RefreshCw :size="14" />重新渲染');
    expect(actions).not.toContain('全部重新渲染');
    expect(pageSource).toMatch(
      /\.segment-local-update-button\s*\{[^}]*color:\s*#a66a0b;[^}]*background:\s*#fffaf0;[^}]*border-color:\s*#f5ca80;/su,
    );
    expect(pageSource).toContain('<WorkflowRunProgress');
    expect(pageSource).toContain('v-if="creatingTaskCount !== null || batchActive"');
    expect(pageSource).toContain('tone="update"');
    expect(pageSource).toContain(":summary=\"updatingProgress ? '本次更新进度' : '视频渲染进度'\"");
    expect(pageSource).toContain(':attempt-label="batchProgressDetail"');
    expect(pageSource).toContain('effectSegmentRenderProgress(workspace.value, creatingTaskCount.value)');
    expect(pageSource).toContain('creatingTaskCount.value = selectiveRefresh ? updateCount : promptCount.value');
    expect(pageSource).toContain("updatingProgress.value ? '更新中' : '渲染中'");
  });
  it('replaces completed-validation with branch-safe editing controls', () => {
    expect(pageSource).toContain('<Pencil v-else :size="14" />进入编辑');
    expect(pageSource).toContain('<X :size="14" />取消编辑');
    expect(pageSource).toContain('<CheckCircle2 :size="14" />保存修改');
    expect(pageSource).toContain('beginEffectWorkflowNodeEdit');
    expect(pageSource).toContain('cancelEffectWorkflowNodeEdit');
    expect(pageSource).toContain('synchronizeWorkflowRun(props.workflowRunId)');
    expect(pageSource).toContain(':show-validate="false"');
    expect(pageSource).not.toContain('完成校验前仍可继续调整');
  });

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
    expect(pageSource).toContain('effectSegmentRenderCardTitle(task, cardCreativeCoreByPromptId.value[task.promptId])');
    expect(pageSource).not.toContain('创意方向待同步');
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
    expect(pageSource).toContain('const TASK_VIDEO_POSTER_CAPTURE_SECONDS = 0.5;');
    expect(pageSource).not.toContain(
      'video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) captureTaskVideoPoster(task, event)',
    );
    expect(pageSource).toContain("{ 'video-ready': isTaskVideoReady(task) }");
    expect(pageSource).toContain("{ 'is-ready': isTaskVideoReady(task) }");
    expect(pageSource).toContain('task.output');
    expect(pageSource).not.toContain('4 个分镜片段');
    expect(serviceSource).not.toContain('完整成片脚本');
  });

  it('reuses the AI-generated tag and confirmed prompt creative details in dialogs', () => {
    expect(pageSource).toContain(
      "previewTask.origin === 'EXTERNAL_IMPORT' ? '外部导入' : 'AI 生成'",
    );
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

  it('uses server posters and asynchronously caches legacy decoded frames', () => {
    expect(pageSource).toContain('const cardVideoPosterUrls = ref<Map<string, string>>(new Map())');
    expect(pageSource).toContain('const captureTaskVideoPoster =');
    expect(pageSource).toContain('canvas.toBlob(');
    expect(pageSource).toContain('URL.createObjectURL(blob)');
    expect(pageSource).toContain("'POSTER'");
    expect(pageSource).toContain('task.output.poster.version');
    expect(pageSource).toContain('v-if="taskVideoPosterUrl(task)"');
    expect(pageSource).toContain('loading="lazy"');
    expect(pageSource).toContain('decoding="async"');
    expect(pageSource).not.toContain('const pagedTaskVideoSignature = computed');
    expect(pageSource).toContain('v-if="isEffectSegmentRenderBusy(task.status)"');
    expect(pageSource).not.toContain('!isTaskVideoReady(task))');
  });

  it('limits legacy video poster decoding to cards approaching the viewport', () => {
    expect(pageSource).toContain("{ rootMargin: '240px 0px', threshold: 0.01 }");
    expect(pageSource).toContain(
      'v-task-video-visible="taskVideoPosterUrl(task) ? \'\' : taskVideoKey(task)"',
    );
    expect(pageSource).toContain('const TASK_VIDEO_FALLBACK_CONCURRENCY = 3');
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
    expect(pageSource).toContain('画面返修要求');
    expect(pageSource).not.toContain('这个范围内需要修改什么');
    expect(pageSource).toMatch(
      /\.repair-range-editor\s*\{[^}]*box-sizing:\s*border-box;[^}]*width:\s*100%;[^}]*margin:\s*15px 0 0;/su,
    );
    expect(pageSource).toMatch(
      /\.repair-instruction-field textarea\s*\{[^}]*box-sizing:\s*border-box;[^}]*min-height:\s*88px;/su,
    );
    expect(pageSource).not.toContain('开始时间（秒）');
    expect(pageSource).not.toContain('结束时间（秒）');
    expect(pageSource).toContain('startMs: Math.round(repairStartSeconds.value * 1000)');
    expect(pageSource).toContain('endMs: Math.round(repairEndSeconds.value * 1000)');
  });

  it('shows additional purposes without repeating the primary type or leaving an empty label', () => {
    expect(pageSource).toContain('v-if="effectSegmentRenderAdditionalPurposes(task).length"');
    expect(pageSource).toContain('v-for="compatibleType in effectSegmentRenderAdditionalPurposes(task)"');
    expect(pageSource).not.toContain('v-for="compatibleType in task.compatibleFragmentTypes"');
    expect(pageSource).toContain('task.compatibleFragmentTypes.includes(fragmentFilter.value)');
  });

  it('uses the prompt-node search and purpose filter pattern with toggleable selection actions', () => {
    for (const marker of [
      '导入素材',
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
    expect(pageSource).toContain('再次产生费用');
    expect(pageSource).toContain('严格按当前已确认 Prompt 创建新批次');
    expect(pageSource).toContain('人工导入的视频不会重新生成，也不会带入新分支');
    expect(pageSource).toContain('原版本保持可回溯');
    expect(pageSource).not.toContain('批量删除');
    expect(pageSource).toContain('deleteEffectSegmentRenderMaterials');
    expect(importBatchSource).toContain('stageEffectSegmentImport');
    expect(importBatchSource).toContain('confirmEffectSegmentImports');
    expect(importBatchSource).toContain('describeEffectSegmentImport');
    expect(pageSource).toContain('exportEffectSegmentRenderMaterials');
    expect(pageSource).not.toContain('尚未接入');
    expect(pageSource).not.toContain('AUTO_MATCHED');
    expect(pageSource).not.toContain('modelMatch');
    expect(pageSource).toContain('@keydown.esc="closeTransferPanel(true)"');
    expect(pageSource).toContain('trigger?.isConnected && trigger.focus()');
    expect(pageSource).toContain(
      'selectionMode ? toggleTaskSelection(task.id) : openPreview(task, $event)',
    );
    expect(pageSource).toContain('v-if="!selectionMode" class="material-card-actions"');
  });

  it('keeps import actions below optional creative fields, without redundant notices', () => {
    expect(pageSource).not.toContain('导入素材不会改变模板槽位时长上限');
    expect(pageSource).toContain('@click="imports.recognize(column)"');
    expect(pageSource).toContain('@click="imports.confirm(column)"');
    expect(pageSource.indexOf('class="import-creative-details"')).toBeLessThan(
      pageSource.indexOf('class="import-column-footer"'),
    );
    expect(pageSource).toContain('v-model="column.draft.promptText"');
  });

  it('imports up to five videos in independent centered columns with per-column actions', () => {
    const input = pageSource.match(/ref="importInput"[\s\S]*?\/>/u)?.[0];
    expect(input).toContain('multiple');
    expect(pageSource).toContain('v-for="column in importColumns"');
    expect(pageSource).toContain(':key="column.key"');
    expect(pageSource).toContain('importColumns.length >= 5');
    expect(pageSource).toContain('@click="imports.recognizeAll()"');
    expect(pageSource).toContain('segment-import-backdrop');
    expect(pageSource).toContain('segment-import-modal');
    expect(pageSource).toContain(
      'grid-template-columns: repeat(var(--import-columns), minmax(400px, 1fr))',
    );
    const importGrid = pageSource.match(
      /\.segment-import-modal > \.import-review-list \{([^}]+)\}/u,
    )?.[1];
    expect(importGrid).toContain('overflow-x: auto');
    expect(importGrid).toContain('scrollbar-width: auto');
    expect(pageSource).toContain('class="import-column-body"');
    expect(importBatchSource).toContain('URL.createObjectURL(file)');
    expect(importBatchSource).toContain('URL.revokeObjectURL(column.previewUrl)');
    expect(importBatchSource).toContain('column.video?.pause()');
    expect(pageSource).toContain('handleImportPreviewMetadata(column, $event)');
    expect(pageSource).toContain(':src="column.previewUrl"');
    expect(pageSource).toContain(':disabled="!importColumnReady(column)"');
    expect(pageSource).toContain('@keydown="handleTransferKeydown"');
    expect(pageSource).toContain('imports.dispose()');
    expect(pageSource).toContain('imports.hide()');
    expect(pageSource).toContain('@click="cancelImport"');
    expect(pageSource).toContain('取消导入');
    expect(pageSource).toContain(
      'importVideoPreviewStyle(column.previewSize ?? column.draft ?? {})',
    );
    expect(pageSource).toContain('segment-import-empty');
    const purposeRow = pageSource.match(/\.import-purpose-options \{([^}]+)\}/u)?.[1];
    expect(purposeRow).toContain('flex-wrap: nowrap');
    expect(purposeRow).not.toContain('overflow-x');
    const purposeOption = pageSource.match(/\.import-purpose-options label \{([^}]+)\}/u)?.[1];
    expect(purposeOption).toContain('flex: 0 0 auto');
    expect(purposeOption).toContain('white-space: nowrap');
    for (const label of ['时长', '分辨率', '画幅', '帧率', '大小', '格式'])
      expect(pageSource).toContain(`<dt>${label}</dt>`);
  });

  it('shows six actual video facts in aligned columns', () => {
    expect(pageSource).toContain('importVideoResolution(column.previewSize ?? column.draft)');
    expect(pageSource).toContain('importVideoAspectRatio(column.previewSize ?? column.draft)');
    expect(pageSource).toContain('importVideoFrameRate(column.draft.frameRate)');
    expect(pageSource).toMatch(
      /\.import-video-info\s*\{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/su,
    );
    expect(pageSource).toMatch(
      /\.import-video-info > div\s*\{[^}]*grid-template-columns:\s*3em minmax\(0, 1fr\)/su,
    );
  });

  it('requires purpose and prompt per column and applies complete independent AI results', () => {
    for (const label of [
      '主要片段类型',
      '兼容片段类型',
      'import-field-required',
      'import-field-optional',
    ])
      expect(pageSource).toContain(label);
    expect(pageSource).toContain('v-model="column.draft.creativeCore"');
    expect(pageSource).toContain('v-model="column.draft.dimensions[dimension.key]"');
    expect(pageSource).toContain('v-for="dimension in EFFECT_PROMPT_DIMENSIONS"');
    expect(pageSource).toContain('type="radio"');
    expect(pageSource).toContain('v-model="column.draft.compatiblePurposes"');
    expect(pageSource).toContain(':disabled="column.draft.primaryPurpose === purpose"');
    expect(importBatchSource).toContain('effectSegmentImportDescriptionValid(column.draft)');
    expect(importBatchSource).toContain(
      'applyEffectSegmentImportRecognition(column.draft, response.data.draft)',
    );
    expect(importBatchSource).toContain('primaryPurpose: draft.primaryPurpose!');
    expect(importBatchSource).toContain('compatiblePurposes: [...draft.compatiblePurposes!]');
  });

  it('spreads the four material actions across the full card footer', () => {
    expect(pageSource).toMatch(
      /\.material-card-actions\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*repeat\(4, minmax\(0, 1fr\)\);/,
    );
    expect(pageSource).toMatch(/\.material-card-actions button\s*\{[^}]*width:\s*100%;/);
    expect(pageSource).toContain('.material-card-actions button:hover:not(:disabled)');
    expect(pageSource).toContain('.material-card-actions button:focus-visible');
  });

  it('shows duration, aspect ratio, resolution and format below compatible purposes without progress percent', () => {
    expect(pageSource).toContain('class="material-facts"');
    expect(pageSource).toContain('materialAspectRatioLabel(task.mediaAspectRatio)');
    expect(pageSource).toContain('materialResolutionLabel(task.mediaResolution)');
    expect(pageSource).toContain('materialFormatLabel(task.output?.mimeType)');
    expect(pageSource).toContain('importVideoDuration(task.durationSeconds)');
    expect(pageSource).not.toContain('{{ task.progress }}%');
    expect(pageSource).toMatch(
      /\.material-facts\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*repeat\(4, minmax\(0, 1fr\)\)/s,
    );
    expect(pageSource).toMatch(
      /\.material-facts span\s*\{[^}]*justify-content:\s*center;/s,
    );
    expect(pageSource.indexOf('class="material-facts"')).toBeGreaterThan(
      pageSource.indexOf('class="compatible-purpose-tags"'),
    );
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
      expect(effectSegmentRenderModels.some((option) => option.label === model)).toBe(true);
    expect(pageSource).not.toContain("label: 'Seedance 1.5 Pro'");
    expect(pageSource).not.toContain("label: 'Seedance 1.0'");
    expect(effectSegmentRenderModels.find((model) => model.value === 'SEEDANCE_2_0')?.resolutions).toEqual(['480p', '720p', '1080p', '4k']);
    expect(effectSegmentRenderModels.find((model) => model.value === 'SEEDANCE_1_5_PRO')?.resolutions).toEqual(['480p', '720p', '1080p']);
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
    expect(pageSource).toContain('视频生成任务');
    expect(pageSource).not.toContain('真实');
    expect(pageSource).toContain('pollTimer = setTimeout');
    expect(pageSource).not.toContain('setInterval(');
    expect(pageSource).toContain('getEffectSegmentRenderTaskContent(');
    expect(pageSource).toContain('.then((response) => response.blob())');
    expect(pageSource).toContain('previewController?.abort()');
    expect(pageSource).toContain("loadPreviewVideo(task, variant, 'preview')");
    expect(pageSource).toContain("loadPreviewVideo(task, 'ACTIVE', 'repair')");
  });

  it('sizes the immediate preview frame from the video itself, not the mutable render settings', () => {
    // 画幅设置只作用于新建任务，历史素材可能是在别的画幅下渲染的；画框若跟着设置走，编辑态与非编辑态
    // 会因为「编辑分支没有克隆设置」而给出不同的预览画框。
    expect(pageSource).toContain("configuredRatio === 'adaptive' ? '16:9' : configuredRatio");
    expect(pageSource).toContain(':style="previewFrameStyle"');
    expect(pageSource).toContain(':style="repairFrameStyle"');
    expect(pageSource).toContain('aspectRatio: `${width} / ${height}`');
    expect(pageSource).toContain('width: `min(100%, calc(${maxHeightVh}vh * ${widthToHeight}))`');
    expect(pageSource).toContain('const width = videoSize?.width || widthPart || 16;');
    expect(pageSource).toContain('const height = videoSize?.height || heightPart || 9;');
    expect(pageSource).toContain('effectSegmentRenderFrameStyle(62, previewVideoSize.value)');
    expect(pageSource).toContain('effectSegmentRenderFrameStyle(44, repairVideoSize.value)');
    expect(
      pageSource.match(/@loadedmetadata="handle(?:Preview|Repair)VideoMetadata"/gu),
    ).toHaveLength(2);
    expect(pageSource).toContain('element.videoWidth > 0 && element.videoHeight > 0');
    expect(pageSource).toMatch(
      /const clearPreview = \(\): void => \{[\s\S]*?previewVideoSize\.value = null;[\s\S]*?repairVideoSize\.value = null;/,
    );
    expect(pageSource).not.toMatch(/\.large-preview\s*\{[^}]*height:\s*250px/su);
  });

  it('shows a real initial empty state without a duplicate call to action', () => {
    const emptyState = pageSource.match(
      /<div v-else-if="!hasBatch && !tasks\.length" class="segment-batch-empty">[\s\S]*?<\/div>/u,
    )?.[0];
    expect(emptyState).toContain('尚未创建视频渲染任务');
    expect(emptyState).toContain('从页头开始批量渲染');
    expect(emptyState).not.toContain('<button');
    expect(serviceSource).toContain("batchStatus: 'NOT_STARTED'");
    expect(serviceSource).toContain('tasks: []');
  });

  it('uses common workflow controls and only replaces step four', () => {
    expect(pageSource).not.toContain('<WorkflowNodeDraftBar');
    expect(pageSource).toContain('<WorkflowNodeFooter');
    expect(pageSource).not.toContain(':status-title=');
    expect(pageSource).toContain('back-label="上一步：素材 Prompt"');
    expect(pageSource).not.toContain('保存到项目资产库');
    expect(pageSource).not.toContain('localStorage');
    expect(parentSource).toContain(
      "import EffectSegmentRenderNodePage from '../segment-render/EffectSegmentRenderNodePage.vue'",
    );
    expect(parentSource).toContain('v-else-if="activeStep === 3"');
    expect(parentSource).toContain('@back="selectWorkflowStep(2)"');
    expect(parentSource).toContain('@next="selectWorkflowStep(4)"');
    expect(parentSource).not.toContain('v-if="activeDownstreamBoundary"');
  });

  it('renders a text-only first/re-recognition action without a leading icon', () => {
    const recognitionButton = pageSource.match(
      /<button\s+type="button"[^>]*@click="imports\.recognize\(column\)"[^>]*>[\s\S]*?<\/button>/u,
    )?.[0];
    expect(recognitionButton).toContain('{{ importRecognitionLabel(column) }}');
    expect(recognitionButton).not.toContain('<Sparkles');
    expect(recognitionButton).not.toContain('<LoaderCircle');
  });
  it('does not show an active-version note or its empty container in ordinary previews', () => {
    expect(pageSource).not.toContain('当前活动版本');
    expect(pageSource).not.toContain('返修候选会单独保存');
    expect(pageSource).toContain('<p v-if="previewVariant === \'REPAIR\'" class="dialog-note">');
    expect(pageSource).toContain('当前预览的是返修候选；采用前不会覆盖原视频。');
  });
  it('keeps each video error above its scrollable body and removes the duplicate footer error', () => {
    const top = pageSource.indexOf('class="import-column-top"');
    const error = pageSource.indexOf('aria-label="视频处理错误"', top);
    const body = pageSource.indexOf('class="import-column-body"', top);
    expect(top).toBeGreaterThan(-1);
    expect(error).toBeGreaterThan(top);
    expect(error).toBeLessThan(body);
    expect(pageSource.slice(top, body)).toContain('transfer-note import-column-error');
    const footer = pageSource.slice(
      pageSource.indexOf('class="import-column-footer"'),
      pageSource.indexOf('class="import-batch-footer"'),
    );
    expect(footer).not.toContain('column.draft?.errorMessage');
  });
});
