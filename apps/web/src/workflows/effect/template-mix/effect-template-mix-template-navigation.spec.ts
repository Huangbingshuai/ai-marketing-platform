import { describe, expect, it, vi } from 'vitest';
import { transpileModule } from 'typescript';
import { effectTemplateBranchTips } from '@ai-marketing/contracts';
import page from './EffectTemplateMixNodePage.vue?raw';
import parentPage from '../source-import/EffectImportNodePage.vue?raw';

// Run the page's real orchestration while keeping the project active pointer unchanged.
const source = page.split('async function openTemplateWorkspace(')[1]!
  .split('\nconst selectVariant =')[0]!;
function harness() {
  const context = {
    runSwitching: { value: false }, mutating: { value: false }, projectEditLocked: { value: false },
    pageState: { value: 'READY' }, installedWorkspaceScope: { value: 'project:t3' },
    currentWorkspaceScope: { value: 'project:t3' }, props: { projectId: 'project', workflowRunId: 't3' },
    workbenchActive: true, templateNavigationPending: { value: false },
    templateNavigationTarget: { value: null as string | null }, activeTemplateId: { value: 'template2' },
    view: { value: 'CONFIG' }, uiByTemplate: { template2: { selectedVariantId: 'v1' } },
    templateDirectory: { value: { workflowRunIds: { template2: 't2-package', new: 't3' },
      workspaces: {} as Record<string, unknown>, entries: [] } },
    templateListCatalog: { value: [] }, cloneMix: <T>(value: T): T => structuredClone(value),
    catalog: { value: [{ id: 'template2' }, { id: 'new' }] },
    selectedTemplateWorkflowRunId: { value: null as string | null },
    installWorkspaceData: vi.fn(), loadedWorkspaceRunId: 't3',
    flushPendingEdits: vi.fn().mockResolvedValue(true),
    releaseExplicitWorkspaceTarget: vi.fn(),
    getEffectWorkflowBranchTree: vi.fn().mockResolvedValue({ data: {
      activeWorkflowRunId: 't3', branches: [
        { workflowRunId: 'render', parentWorkflowRunId: null, forkNodeId: 'SEGMENT_RENDER',
          createdAt: '2026-10-01', templates: [] },
        { workflowRunId: 't2-fill', parentWorkflowRunId: 'render', forkNodeId: 'TEMPLATE_MIX',
          forkTemplateId: 'template2', createdAt: '2026-10-02', templates: [{ templateId: 'template2' }] },
        { workflowRunId: 't2-package', parentWorkflowRunId: 't2-fill', forkNodeId: 'TEMPLATE_MIX',
          forkTemplateId: 'template2', createdAt: '2026-10-03', templates: [{ templateId: 'template2' }] },
        { workflowRunId: 't3', parentWorkflowRunId: 'render', forkNodeId: 'TEMPLATE_MIX',
          forkTemplateId: 'template3', createdAt: '2026-10-04',
          templates: [{ templateId: 'template2' }, { templateId: 'template3' }, { templateId: 'new' }] },
        { workflowRunId: 'unrelated', parentWorkflowRunId: null, forkNodeId: 'SEGMENT_RENDER',
          forkTemplateId: 'template2', createdAt: '2026-10-05', templates: [{ templateId: 'template2' }] },
      ],
    } }),
    effectTemplateBranchTips, activateEffectWorkflowBranch: vi.fn().mockResolvedValue({}),
    rememberWorkbench: vi.fn(), emit: vi.fn(), showNotice: vi.fn(),
    selectTemplate: vi.fn(), enterEditor: vi.fn(),
  };
  const script = transpileModule(`async function openTemplateWorkspace(${source}`, {}).outputText;
  const execute = new Function(...Object.keys(context), `${script}\nreturn openTemplateWorkspace;`)
    (...Object.values(context)) as (templateId: string, view: 'CONFIG' | 'EDITOR', action?: 'SOURCE_UPDATE') => Promise<boolean>;
  return { context, execute };
}

describe('template workbench selects the template current workspace without global activation', () => {
  it('passes the actual editor Run to the tree without changing the global branch', () => {
    expect(page).toContain("view.value === 'EDITOR' ? props.workflowRunId || null : null");
    expect(parentPage).toContain('templateMixNode.value?.getBranchTreeWorkflowRunId()');
    expect(parentPage).toContain(':viewed-workflow-run-id="branchTreeViewedRunId"');
  });
  it('hands an update click to the actual branch without submitting copied draft data', async () => {
    const { context: c, execute } = harness();
    expect(await execute('template2', 'EDITOR', 'SOURCE_UPDATE')).toBe(false);
    expect(c.rememberWorkbench).toHaveBeenCalledWith({ workflowRunId: 't2-package',
      templateId: 'template2', variantId: 'v1', view: 'EDITOR', action: 'SOURCE_UPDATE' });
    expect(c.enterEditor).not.toHaveBeenCalled();
  });

  it('does not reset player or film selection when updating the correctly scoped branch', async () => {
    const { context: c, execute } = harness();
    c.props.workflowRunId = 't2-package';
    c.installedWorkspaceScope.value = c.currentWorkspaceScope.value = 'project:t2-package';
    (await c.getEffectWorkflowBranchTree()).data.activeWorkflowRunId = 't2-package';
    c.view.value = 'EDITOR';
    expect(await execute('template2', 'EDITOR', 'SOURCE_UPDATE')).toBe(true);
    expect(c.enterEditor).not.toHaveBeenCalled();
    expect(c.view.value).toBe('EDITOR');
    expect(c.activateEffectWorkflowBranch).not.toHaveBeenCalled();
  });

  it('does not install a cached directory response as the destination writable draft', async () => {
    const { context: c, execute } = harness();
    const cached = { draftRevision: 7, draft: { activeTemplateId: 'template2' } };
    c.templateDirectory.value.workspaces['t2-package'] = cached;
    await execute('template2', 'CONFIG');
    expect(c.installWorkspaceData).not.toHaveBeenCalled();
    expect(c.installedWorkspaceScope.value).toBe('project:t3');
    expect(c.activeTemplateId.value).toBe('template2');
    expect(c.templateNavigationPending.value).toBe(true);
    expect(c.activateEffectWorkflowBranch).not.toHaveBeenCalled();
    expect(c.emit).not.toHaveBeenCalled();
  });
  it.each(['CONFIG', 'EDITOR'] as const)('loads template2 on its actual confirmed packaging path (%s)', async (view) => {
    const { context: c, execute } = harness();
    await execute('template2', view);
    expect(c.activateEffectWorkflowBranch).not.toHaveBeenCalled();
    expect(c.selectedTemplateWorkflowRunId.value).toBe('t2-package');
    expect(c.flushPendingEdits).toHaveBeenCalledOnce();
    expect(c.rememberWorkbench).toHaveBeenCalledWith({ workflowRunId: 't2-package', templateId: 'template2', variantId: 'v1', view });
    expect(c.emit).not.toHaveBeenCalled();
    expect(c.enterEditor).not.toHaveBeenCalled(); // Never expose the copied t3 draft as confirmed t2.
    expect(c.templateNavigationPending.value).toBe(true);
    expect(c.templateNavigationTarget.value).toBe('project:t2-package');
  });

  it('defers cached editor selection and source-update handoffs to the fresh scoped loader', async () => {
    const { context: c, execute } = harness();
    c.templateDirectory.value.workspaces['t2-package'] = { draftRevision: 7 };
    await execute('template2', 'EDITOR');
    expect(c.enterEditor).not.toHaveBeenCalled();
    c.enterEditor.mockClear();
    c.installedWorkspaceScope.value = 'project:t3';
    await execute('template2', 'EDITOR', 'SOURCE_UPDATE');
    expect(c.enterEditor).not.toHaveBeenCalled();
  });

  it('releases a historical editor when reselecting the template from the current list', async () => {
    const { context: c, execute } = harness();
    c.props.workflowRunId = 't2-fill';
    c.installedWorkspaceScope.value = c.currentWorkspaceScope.value = 'project:t2-fill';
    (await c.getEffectWorkflowBranchTree()).data.activeWorkflowRunId = 't2-fill';
    await execute('template2', 'EDITOR');
    expect(c.activateEffectWorkflowBranch).not.toHaveBeenCalled();
    expect(c.enterEditor).not.toHaveBeenCalled();
    expect(c.releaseExplicitWorkspaceTarget).toHaveBeenCalledOnce();
    expect(c.selectedTemplateWorkflowRunId.value).toBe('t2-package');
    expect(c.templateNavigationPending.value).toBe(true);
  });

  it('uses the current Run for a new template with no separate branch', async () => {
    const { context: c, execute } = harness();
    await execute('new', 'CONFIG');
    expect(c.activateEffectWorkflowBranch).not.toHaveBeenCalled();
    expect(c.selectTemplate).toHaveBeenCalledWith('new');
    expect(c.view.value).toBe('CONFIG');
    expect(c.templateNavigationPending.value).toBe(false);
  });

  it('does not leave the current branch if saving fails', async () => {
    const { context: c, execute } = harness();
    c.flushPendingEdits.mockResolvedValue(false);
    await execute('template2', 'EDITOR');
    expect(c.getEffectWorkflowBranchTree).not.toHaveBeenCalled();
    expect(c.activateEffectWorkflowBranch).not.toHaveBeenCalled();
    expect(c.templateNavigationPending.value).toBe(false);
  });

  it('does not load a stale target after the project changes during save', async () => {
    const { context: c, execute } = harness();
    const tree = await c.getEffectWorkflowBranchTree();
    c.flushPendingEdits.mockImplementation(async () => {
      c.props.projectId = 'other';
      return true;
    });
    await execute('template2', 'EDITOR');
    expect(c.activateEffectWorkflowBranch).not.toHaveBeenCalled();
    expect(c.rememberWorkbench).not.toHaveBeenCalled();
    expect(c.templateNavigationPending.value).toBe(false);
  });

  it('does not couple template selection to the global active pointer', async () => {
    const { context: c, execute } = harness();
    (await c.getEffectWorkflowBranchTree()).data.activeWorkflowRunId = 'external';
    await execute('template2', 'EDITOR');
    expect(c.activateEffectWorkflowBranch).not.toHaveBeenCalled();
    expect(c.emit).not.toHaveBeenCalled();
    expect(c.selectedTemplateWorkflowRunId.value).toBe('t2-package');
    expect(c.getEffectWorkflowBranchTree).toHaveBeenCalledTimes(1); // Test setup only.
  });

  it('unlocks the current page when the template is no longer in the directory', async () => {
    const { context: c, execute } = harness();
    await execute('removed', 'EDITOR');
    expect(c.showNotice).toHaveBeenCalledWith('所选模板已不在当前素材分支中，请刷新后重试', 'error');
    expect(c.emit).not.toHaveBeenCalled();
    expect(c.templateNavigationPending.value).toBe(false);
  });

  it('uses the scoped entry points for both template selection and workbench entry', () => {
    expect(page).toContain("openTemplateWorkspace(entry.id, 'CONFIG')");
    expect(page).toContain("openTemplateWorkspace(activeTemplateId, 'EDITOR')");
    expect(page).toContain("view.value = handoff.view ?? 'EDITOR'");
    expect(page).not.toContain('class="mix-run-switch"');
    expect(page).not.toContain('正在同步新分支');
  });
});
