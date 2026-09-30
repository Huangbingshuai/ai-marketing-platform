import { describe, expect, it } from 'vitest';

import pageSource from './EffectFinalOutputNodePage.vue?raw';

describe('effect final output re-render layout', () => {
  it('never hides the export button or the resolution and frame rate options', () => {
    // The settings row used to be replaced by a read-only summary once a batch had been exported.
    expect(pageSource).not.toContain('frozen-settings');
    expect(pageSource).not.toContain('v-if="run.status === \'PENDING_RENDER\' || active"');
    expect(pageSource).toContain('class="render-settings"');
    expect(pageSource).toContain('aria-label="成片分辨率"');
    expect(pageSource).toContain('aria-label="成片帧率"');
  });

  it('turns the second export into a re-export with a spinner icon', () => {
    expect(pageSource).toContain('重新导出成片（${run.counts.total}）');
    expect(pageSource).toContain(
      '<RefreshCw v-else-if="run.status !== \'PENDING_RENDER\'" :size="15" />',
    );
    expect(pageSource).toContain('<LoaderCircle v-if="busy || active" class="spin" :size="15" />');
    expect(pageSource).toContain('正在创建任务…');
    expect(pageSource).toContain('渲染中 ${run.counts.completed}/${run.counts.total}');
  });

  it('confirms a whole-batch re-export and keeps the settings editable between batches', () => {
    expect(pageSource).toContain('确认重新导出');
    expect(pageSource).toContain('创建此模板的新版本分支，原有成片保留在旧分支');
    expect(pageSource).toContain("operation: rerender ? '重新导出成片' : '开始导出成片'");
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
    // Export, single-item re-render and local update each ask before touching output files.
    expect(pageSource.match(/requestActionConfirmation\(/gu)).toHaveLength(3);
  });

  it('drops 完成校验: a finished batch publishes its branch on its own', () => {
    expect(pageSource).not.toContain('validateOutput');
    expect(pageSource).not.toContain('/complete');
    expect(pageSource).toContain(':show-validate="false"');
  });

  it('offers 局部更新 only for an already-exported batch that has moved upstream', () => {
    expect(pageSource).toContain('const staleItems = computed');
    expect(pageSource).toContain("run.status === 'COMPLETED' && staleItems.length");
    expect(pageSource).toContain('`${base.value}/${run.value.id}/local-update`');
    expect(pageSource).toContain('确认局部更新');
    expect(pageSource).toContain('body: { itemIds }');
    expect(pageSource).toContain('class="secondary-button local-update-button"');
    expect(pageSource).toContain('局部更新（{{ staleItems.length }}）');
    expect(pageSource).toContain('.local-update-button {');
  });

  it('distinguishes a smart-filled pending film from an export made without a package', () => {
    // A picture-only film looks like a broken render unless the card explains itself.
    expect(pageSource).toContain('v-if="item.unpackaged"');
    expect(pageSource).toContain('class="status-pill unpackaged"');
    expect(pageSource).toContain("run.status === 'PENDING_RENDER' ? '待包装' : '无包装'");
    expect(pageSource).toContain('成片工程已同步，尚未完成智能成片包装');
    expect(pageSource).toContain("item.unpackaged ? '无口播 / 字幕 / 配乐' : '内嵌字幕'");
    expect(pageSource).toContain('.status-pill.unpackaged {');
  });

  it('keeps delivered films available without an expiry marker', () => {
    expect(pageSource).toContain('run: outputRun,');
    expect(pageSource).toContain('v-if="item.stale" class="status-pill stale"');
    expect(pageSource).toContain('待更新</span>');
    expect(pageSource).toContain('.status-pill.stale {');
    expect(pageSource).toContain('v-if="item.fileObjectId"');
  });

  it('keeps a just-filled template visible before the workspace refresh arrives', () => {
    expect(pageSource).toContain('for (const outputRun of latestByTemplate.values())');
    expect(pageSource).toContain('cards.push({ templateId: outputRun.templateId');
  });

  it('reconciles missed pending-draft updates on entry without starting a render', () => {
    expect(pageSource).toContain('async function reconcilePending()');
    expect(pageSource).toContain('expectedDraftRevision: workspace.draftRevision');
    expect(pageSource).toContain('void reconcilePending();');
    expect(pageSource).toContain("new BroadcastChannel('effect-final-output-sync')");
    expect(pageSource).toContain('outputSyncChannel?.close()');
  });

  it('follows the fork a re-export opened instead of reading the published batch', () => {
    // A re-export is a full update: the service forks an unpublished child and queues the batch
    // there, so the page has to move to that Run before it reads the batch back.
    expect(pageSource).toContain('if (response.data.workflowRunId !== props.workflowRunId) {');
    expect(pageSource).toContain("emit('workflowRunChange');");
  });
});
