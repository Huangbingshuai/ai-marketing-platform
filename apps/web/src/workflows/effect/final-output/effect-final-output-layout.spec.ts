import { describe, expect, it } from 'vitest';

import pageSource from './EffectFinalOutputNodePage.vue?raw';
import parentSource from '../source-import/EffectImportNodePage.vue?raw';

describe('effect final output re-render layout', () => {
  it('uses yellow for current-branch updates and keeps whole exports blue', () => {
    const localProgress = pageSource.split('v-if="localProgressVisible"')[1]?.split('/>')[0];
    const exportProgress = pageSource.split('v-if="exportProgressVisible"')[1]?.split('/>')[0];
    expect(localProgress).toContain('tone="update"');
    expect(exportProgress).not.toContain('tone="update"');
  });
  it('returns the selected template and never previews an inherited film against another branch draft', () => {
    expect(pageSource.match(/\$emit\('back', selectedTemplateId\)/gu)).toHaveLength(3);
    const previewSource = pageSource.match(/const openTimelinePreview = [\s\S]*?\n\};/)?.[0];
    expect(previewSource).not.toContain('switchToSelectedBranch');
    expect(previewSource).toContain("emit('preview', { workflowRunId: run.value.workflowRunId, templateId: run.value.templateId, variantId })");
    expect(pageSource).not.toContain('related-template-branches');
  });

  it('describes an empty current-branch template without pretending it has unfinished films', () => {
    expect(pageSource).toContain("? '尚未创建成片工程'");
    expect(pageSource).toContain("? '该模板尚未创建成片工程'");
  });

  it('never hides the export button or the resolution and frame rate options', () => {
    // The settings row used to be replaced by a read-only summary once a batch had been exported.
    expect(pageSource).not.toContain('frozen-settings');
    expect(pageSource).not.toContain('v-if="run.status === \'PENDING_RENDER\' || active"');
    expect(pageSource).toContain('class="render-settings"');
    expect(pageSource).toContain('aria-label="成片分辨率"');
    expect(pageSource).toContain('aria-label="成片帧率"');
  });

  it('keeps the primary action exporting the current template after automatically opening completed results', () => {
    expect(pageSource).toContain('重新导出成片（${run.counts.total}）');
    expect(pageSource).toContain(
      '<RefreshCw v-else-if="run.status !== \'PENDING_RENDER\'" :size="15" />',
    );
    expect(pageSource).toContain('<LoaderCircle v-if="exportStarting || exportActive || exportPublishing" class="spin" :size="15" />');
    expect(pageSource).toContain('正在创建任务…');
    expect(pageSource).toContain('重新导出中 ${backgroundExport?.counts.completed}/${backgroundExport?.counts.total}');
    const settings = pageSource.match(/<section class="render-settings"[\s\S]*?<\/section>/)?.[0];
    expect(settings).toContain('@click="startRender"');
    expect(settings).not.toContain('canSwitchToExport');
    expect(pageSource).toContain('if (completedExport) await viewExportBranch(completedExport);');
    expect(parentSource).toContain("showBranchSwitchToast('成片导出完成，已自动切换至新成片分支')");
    expect(pageSource).not.toContain('切换至新版本');
    expect(pageSource).not.toContain('新分支渲染中');
  });

  it('confirms a whole-batch re-export and keeps the settings editable between batches', () => {
    expect(pageSource).toContain('确认重新导出');
    expect(pageSource).toContain('重新渲染全部成片（包括待更新成片）');
    expect(pageSource).toContain("operation: rerender ? '重新导出成片' : '开始导出成片'");
    expect(pageSource).toContain('原有成片保持可用，也可以继续局部更新');
    expect(pageSource).not.toContain("if (run.value?.status !== 'PENDING_RENDER') return;");
  });

  it('re-renders a single item through its own stored spec without freezing the page', () => {
    expect(pageSource).toContain("itemRerenderingId = ref('')");
    expect(pageSource).toContain(
      "async function rerenderItem(item: FinalOutputRun['items'][number])",
    );
    expect(pageSource).toContain('`${base.value}/${run.value.id}/items/${item.id}/render`');
    expect(pageSource).toContain('确认重新渲染');
    expect(pageSource).toContain('将按这条成片已保存的分辨率与帧率重新渲染');
    expect(pageSource).toContain('class="item-rerender-button"');
    expect(pageSource).toContain(
      "{{ itemRerenderingId === item.id ? '重新渲染中…' : '重新渲染' }}",
    );
    // A single-item re-render must not grey out the whole page the way `busy` would.
    expect(pageSource).toContain(':disabled="busy || active || Boolean(itemRerenderingId)"');
    expect(pageSource).toContain('.item-rerender-button {');
  });

  it('routes every batch-changing action through the shared confirmation dialog', () => {
    expect(pageSource).toContain(
      "import { requestActionConfirmation } from '../../../shared/composables/action-confirmation';",
    );
    // Re-export, a stale activity pointer, single-item re-render and local update each confirm.
    expect(pageSource.match(/requestActionConfirmation\(/gu)).toHaveLength(3);
  });

  it('drops 完成校验: a finished batch publishes its branch on its own', () => {
    expect(pageSource).not.toContain('validateOutput');
    expect(pageSource).not.toContain('/complete');
    expect(pageSource).toContain(':show-validate="false"');
  });

  it('offers 局部更新 only for an already-exported batch that has moved upstream', () => {
    expect(pageSource).toContain('const staleItems = computed');
    expect(pageSource).toContain('v-if="canLocalUpdate"');
    expect(pageSource).toContain('/final-output/${target.id}/local-update`');
    expect(pageSource).toContain('确认局部更新');
    expect(pageSource).toContain('body: { itemIds, ...(syncProjects ? { syncProjects: true } : {}),');
    expect(pageSource).toContain('expectedDraftRevision');
    expect(pageSource).toContain('class="secondary-button local-update-button"');
    expect(pageSource).toContain('局部更新（{{ run.counts.stale }}）');
    expect(pageSource).toContain('localUpdate(staleItems.map((item) => item.id), true)');
    expect(pageSource).toContain('仅删除，不启动渲染任务。');
    expect(pageSource).toContain('.local-update-button {');
  });

  it('uses the current packaging state without crowding the film name or explaining old files', () => {
    expect(pageSource).toContain('v-if="outputPackagingLabel(item)"');
    expect(pageSource).toContain('{{ outputFileDescription(item, run.status) }}');
    expect(pageSource).not.toContain('工程已包装');
    expect(pageSource).not.toContain('仅画面文件');
    expect(pageSource).toMatch(/\.output-card__title \{[^}]*flex-wrap: wrap/s);
    expect(pageSource).toMatch(/\.output-card__title h4 \{[^}]*flex: 0 0 auto/s);
    expect(pageSource).toContain('.status-pill.unpackaged {');
  });

  it('keeps delivered films available without an expiry marker', () => {
    expect(pageSource).toContain('run: outputRun,');
    expect(pageSource).toContain('v-else-if="item.stale" class="status-pill stale"');
    expect(pageSource).toContain('待更新</span>');
    expect(pageSource).toContain('.status-pill.stale {');
    expect(pageSource).toContain('v-if="item.fileObjectId"');
  });
  it('separates pending projects from downloadable output and uses real variant identities', () => {
    const pending = pageSource.split('class="pending-projects"')[1]?.split('</section>')[0];
    expect(pending).toContain('待渲染成片');
    expect(pending).toContain(':key="project.variantId"');
    expect(pending).toContain('openTimelinePreview(project.variantId)');
    expect(pending).toContain('新增 · 待渲染');
    expect(pending).toContain('project.blockedReason');
    expect(pending).not.toContain('downloadItem');
    expect(pending).not.toContain('rerenderItem');
  });

  it('uses the current mix template catalog as the only source of output template cards', () => {
    expect(pageSource).toContain('if (!mixWorkspace.value) return []');
    expect(pageSource).toContain('const workspaceTemplates = templateDirectory.value.entries');
    expect(pageSource).toContain('const cards: OutputTemplateCard[] = workspaceTemplates.map');
    expect(pageSource).not.toContain('for (const outputRun of latestByTemplate.values())');
    expect(pageSource).not.toContain('cards.push({ templateId: outputRun.templateId');
    expect(pageSource).not.toContain('for (const [templateId, path] of templatePaths.value)');
    expect(pageSource).toContain('templateName: entry.workspace.template.name');
    expect(pageSource).toContain('readMixTemplateCatalog(tree.data, scopeId, result.data');
    expect(pageSource).toContain("'读取模板当前路径'");
  });

  it('does not resurrect a deleted template from output history or a stale branch tip', () => {
    const templatesBlock = pageSource.match(/const templates = computed\(\(\) => \{[\s\S]*?\n\}\);/)?.[0];
    expect(templatesBlock).toBeDefined();
    expect(templatesBlock).toContain('latestByTemplate.get(entry.id)');
    expect(templatesBlock).toContain('workspaceTemplates.map');
    expect(templatesBlock).not.toContain('latestByTemplate.values()');
    expect(templatesBlock).not.toContain('templatePaths.value)');
    expect(templatesBlock).not.toContain('cards.push');
  });

  it('exports the selected template without a global branch-switch action', () => {
    expect(pageSource).not.toContain('切换至该模板分支');
    const start = pageSource.match(/async function startRender\(\)[\s\S]*?async function viewExportBranch/)?.[0];
    expect(start).not.toContain('activateEffectWorkflowBranch');
    expect(start).toContain('exportStarting.value || exportActive.value');
    expect(start).not.toContain('active.value) return');
  });

  it('reconciles missed pending-draft updates on entry without starting a render', () => {
    expect(pageSource).toContain("window.addEventListener('effect-final-output-sync', savedOutputSource)");
    expect(pageSource).toContain("window.removeEventListener('effect-final-output-sync', savedOutputSource)");
    expect(pageSource).toContain('async function reconcilePending()');
    expect(pageSource).toContain('expectedDraftRevision: source.draftRevision');
    expect(pageSource).toContain('workflowRunId: sourceRunId, templateId: entry.id');
    expect(pageSource).toContain('void reconcilePending();');
    expect(pageSource).toContain("new BroadcastChannel('effect-final-output-sync')");
    expect(pageSource).toContain('outputSyncChannel?.close()');
  });

  it('does not duplicate the first page read between the immediate scope watcher and KeepAlive activation', () => {
    expect(pageSource).toContain('let initialActivationHandled = false;');
    const activation = pageSource.match(/onActivated\(\(\) => \{[\s\S]*?\n\}\);/)?.[0];
    expect(activation).toContain('if (!initialActivationHandled)');
    expect(activation).toContain('initialActivationHandled = true;');
    expect(activation).toContain('return;');
  });

  it('keeps the source delivery visible while an independent export is rendering', () => {
    expect(pageSource).not.toContain('outputWorkflowRunId.value = response.data.workflowRunId;');
    expect(pageSource).toContain('backgroundExportSourceRunId: selected.workflowRunId');
    expect(pageSource).toContain('if (outputRun.backgroundExportSourceRunId) continue;');
    expect(pageSource).toContain("import { WorkflowNodeFooter, WorkflowRunProgress } from '@ai-marketing/ui';");
    expect(pageSource.match(/<WorkflowRunProgress/gu)).toHaveLength(2);
    expect(pageSource).toContain('v-if="exportProgressVisible"');
    expect(pageSource).toContain('v-if="localProgressVisible"');
    expect(pageSource).toContain(':summary="exportProgressSummary"');
    expect(pageSource).toContain(':summary="localProgressSummary"');
    expect(pageSource).toContain("backgroundExport.value.status !== 'COMPLETED'");
    expect(pageSource).toContain("['QUEUED', 'RUNNING', 'FAILED', 'PARTIAL', 'CANCELLED'].includes(run.value.status)");
    expect(pageSource).toContain('局部更新进行中；可以同时重新导出全部成片');
    expect(pageSource).toContain('pendingExportNavigation.add(response.data.id)');
    expect(pageSource).not.toContain('新分支整批导出');
    expect(pageSource).not.toContain('background-export-panel');
    expect(pageSource).not.toContain('class="batch-panel"');
    expect(pageSource).not.toContain('batch-counts');
    const local = pageSource.match(/async function localUpdate[\s\S]*?function stop/)?.[0];
    expect(local).not.toContain('exportActive');
    expect(local).not.toContain('exportStarting');
    expect(local).not.toContain('activateEffectWorkflowBranch');
    expect(local).not.toContain('workflowRunChange');
    expect(local).toContain('run.value?.id !== target.id');
    expect(pageSource).toContain('workflowRunId=${encodeURIComponent(outputWorkflowRunId.value)}');
    expect(pageSource).toContain('pendingExportNavigation.has(entry.id)');
    expect(pageSource).toContain('(!entry.backgroundExportSourceRunId || entry.backgroundExportPublished)');
    expect(pageSource).toContain("emit('workflowRunChange', {");
    expect(pageSource).not.toContain('if (response.data.workflowRunId !== props.workflowRunId) {');
  });

  it('adopts a completed export branch without remounting or covering the output page', () => {
    expect(parentSource).toContain(':key="`output:${currentProjectId}`"');
    expect(parentSource).toContain('refreshActiveRunInPlace(projectId, { showCurtain: false })');
    expect(pageSource).toContain('outputWorkflowRunId.value === props.workflowRunId');
    expect(pageSource).toContain('void refreshMixWorkspace();');
    expect(pageSource).not.toContain(':key="`output:${currentProjectId}:${workspace?.workflowRunId ?? \'\'}`"');
  });

  it('delegates template-scope validation to the server and freezes selected batch and specs', () => {
    expect(pageSource).not.toContain('prepareFinalOutputBranch');
    expect(pageSource).not.toContain('切换并继续导出');
    expect(pageSource).toContain('body: settings,');
    expect(pageSource).toContain('run.value?.id === selected.id');

  });
});
