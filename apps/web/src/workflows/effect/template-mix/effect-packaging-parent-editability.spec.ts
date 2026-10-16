import { reactive, ref } from 'vue';
import { describe, expect, it, vi } from 'vitest';
import { transpileModule } from 'typescript';
import type { PackagingItem } from '@ai-marketing/contracts';
import page from './EffectTemplateMixNodePage.vue?raw';

const item = (workflowRunId: string, variantId: string, status = 'COMPLETED') =>
  ({
    id: `${workflowRunId}-${variantId}`,
    runId: `${workflowRunId}-package`,
    workflowRunId,
    variantId,
    operation: 'BATCH_PACKAGE',
    status,
  }) as PackagingItem;

function harness(alreadyPackaged: boolean) {
  const context = {
    props: reactive({ projectId: 'project', workflowRunId: 'parent' }),
    activeEntry: ref({ packagingLocked: alreadyPackaged }),
    activeTemplateId: ref('template'),
    activeUi: ref({ selectedVariantId: 'film' }),
    packagingResults: ref<PackagingItem[]>([item('parent', 'film')]),
    workbenchActive: true,
    pageState: ref('READY'),
    load: vi.fn(async () => undefined),
    loadEffectTemplateMixWorkspace: vi.fn(async () => ({ data: { draft: {} } })),
    flushPendingEdits: vi.fn(async () => true),
    controller: undefined,
    sourcePollController: undefined,
    stopPolling: vi.fn(),
    selectedTemplateWorkflowRunId: ref('parent'),
    installedWorkspaceScope: ref('project:parent'),
    saveState: ref('saved'),
    installWorkspaceData: vi.fn(() => true),
    rememberWorkbench: vi.fn(),
    nextTick: vi.fn(async () => undefined),
    showNotice: vi.fn(),
  };
  const source = `let installingPackagingResults = false;
    let packagingTaskWorkspaceScope = ''; let cachedNavigationScope = '';
    let loadedWorkspaceRunId = 'parent';
    ${page.slice(page.indexOf('const handlePackagingResults = async'), page.indexOf('const handleBackgroundPackagingFinished ='))}`;
  const receive = new Function(
    ...Object.keys(context),
    `${transpileModule(source, {}).outputText}\nreturn handlePackagingResults;`,
  )(...Object.values(context)) as (items: PackagingItem[]) => Promise<void>;
  return { ...context, receive };
}

describe('packaging result handoff keeps the source branch editable', () => {
  it('keeps an already packaged parent selected when the child has only partial results', async () => {
    const h = harness(true);
    const results = [
      item('parent', 'film'),
      item('child', 'film'),
      item('child', 'other', 'RUNNING'),
    ];
    await h.receive(results);
    expect(h.packagingResults.value).toEqual(results);
    expect(h.loadEffectTemplateMixWorkspace).not.toHaveBeenCalled();
    expect(h.installWorkspaceData).not.toHaveBeenCalled();
    expect(h.selectedTemplateWorkflowRunId.value).toBe('parent');
    expect(h.stopPolling).not.toHaveBeenCalled();
  });

  it('leaves the published-child transition to batch completion even when every child item is ready', async () => {
    const h = harness(true);
    await h.receive([item('parent', 'film'), item('child', 'film')]);
    expect(h.loadEffectTemplateMixWorkspace).not.toHaveBeenCalled();
    expect(h.selectedTemplateWorkflowRunId.value).toBe('parent');
  });

  it('still opens first-packaging results so completed films can be edited while the rest run', async () => {
    const h = harness(false);
    await h.receive([item('child', 'film'), item('child', 'other', 'RUNNING')]);
    expect(h.loadEffectTemplateMixWorkspace).toHaveBeenCalledWith('project', 'child');
    expect(h.installWorkspaceData).toHaveBeenCalledOnce();
    expect(h.selectedTemplateWorkflowRunId.value).toBe('child');
  });
});
