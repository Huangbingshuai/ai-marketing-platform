import { describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { transpileModule } from 'typescript';
import page from './EffectTemplateMixNodePage.vue?raw';

function harness() {
  const context = {
    stopPolling: vi.fn(),
    pollControllers: new Map(),
    pollTimers: new Map(),
    props: { projectId: 'project', workflowRunId: 'workflow' },
    getEffectTemplateMixAiRun: vi.fn().mockResolvedValue({
      data: {
        id: 'append',
        workflowRunId: 'workflow',
        operation: 'APPEND',
        status: 'RUNNING',
        progress: 78,
      },
    }),
    aiRuns: ref([]),
    mutating: ref(true),
    finishAiRun: vi.fn(),
    refreshMaterialSources: vi.fn().mockResolvedValue(undefined),
    showNotice: vi.fn(),
    setTimeout: vi.fn(() => 1),
    AbortController,
    DOMException,
  };
  const source = page.split('const pollAiRun =')[1]!.split("let loadedWorkspaceRunId = '';")[0]!;
  const script = transpileModule(`const execute =${source}`, {}).outputText;
  const execute = new Function(...Object.keys(context), `${script}\nreturn execute;`)(
    ...Object.values(context),
  );
  return { c: context, execute };
}

function sourceHarness() {
  const c = {
    workbenchActive: true,
    pageState: ref('READY'),
    sourcePollController: undefined,
    draftRace: { readToken: vi.fn(() => 1), canInstall: vi.fn(() => true) },
    workspaceRevisionFence: { isCurrent: vi.fn(() => true) },
    mutating: ref(false),
    loadedWorkspaceRunId: 'workflow',
    props: { projectId: 'project', workflowRunId: 'workflow' },
    AbortController,
    loadEffectTemplateMixSources: vi.fn().mockResolvedValue({
      data: {
        materials: [{ id: 'new' }],
        classificationPools: [
          { templateId: 'template', items: [{ materialId: 'new', role: 'HOOK' }] },
        ],
        pendingAddedMaterialIds: { template: ['new'] },
        draftRevision: 2,
      },
    }),
    sourceMaterials: ref([{ id: 'old' }]),
    renderAspectRatio: ref(null),
    autoPackagingTemplateIds: ref([]),
    classificationPools: ref([{ templateId: 'old', items: [] }]),
    pendingAddedMaterialIds: ref({}),
    catalog: ref([
      { workspace: { materials: [{ id: 'old' }], variants: [{ id: 'keep-dirty-edits' }] } },
    ]),
    draftRevision: ref(1),
    saveState: ref('dirty'),
    pendingSave: undefined,
    load: vi.fn(),
  };
  const source = page.split('const refreshMaterialSources =')[1]!.split('onMounted(')[0]!;
  const script = transpileModule(`const execute =${source}`, {}).outputText;
  const execute = new Function(...Object.keys(c), `${script}\nreturn execute;`)(
    ...Object.values(c),
  );
  return { c, execute };
}

describe('live APPEND classification uses existing lightweight library refresh', () => {
  it('refreshes the library on every live progress poll, not just final completion', async () => {
    const { c, execute } = harness();
    c.refreshMaterialSources.mockImplementation(async () => {
      expect(c.mutating.value).toBe(false);
      expect(c.aiRuns.value[0]).toMatchObject({ progress: 78 });
    });
    await execute('append');
    expect(c.refreshMaterialSources).toHaveBeenCalledOnce();
    expect(c.finishAiRun).not.toHaveBeenCalled();
    expect(c.pollTimers.has('append')).toBe(true);
  });
  it('keeps full fill on its own existing lifecycle', async () => {
    const { c, execute } = harness();
    c.getEffectTemplateMixAiRun.mockResolvedValue({
      data: { id: 'fill', workflowRunId: 'workflow', operation: 'FILL', status: 'RUNNING', progress: 20 },
    });
    await execute('fill');
    expect(c.refreshMaterialSources).not.toHaveBeenCalled();
    expect(c.mutating.value).toBe(true);
  });
  it.each(['projectId', 'workflowRunId', 'abort'])(
    'ignores stale progress after %s changes',
    async (scope) => {
      const { c, execute } = harness();
      c.getEffectTemplateMixAiRun.mockImplementation(async () => {
        if (scope === 'abort') c.pollControllers.get('append').abort();
        else c.props[scope as 'projectId' | 'workflowRunId'] = 'other';
        return { data: { id: 'append', workflowRunId: 'workflow', operation: 'APPEND', status: 'RUNNING', progress: 78 } };
      });
      await execute('append');
      expect(c.aiRuns.value).toEqual([]);
      expect(c.refreshMaterialSources).not.toHaveBeenCalled();
      expect(c.pollTimers.size).toBe(0);
      expect(c.showNotice).not.toHaveBeenCalled();
    },
  );
  it('applies checkpoint roles without replacing edited variants or reloading dirty drafts', async () => {
    const { c, execute } = sourceHarness();
    await execute();
    expect(c.classificationPools.value[0]?.items).toEqual([{ materialId: 'new', role: 'HOOK' }]);
    expect(c.sourceMaterials.value).toEqual([{ id: 'new' }]);
    expect(c.catalog.value[0]?.workspace.variants).toEqual([{ id: 'keep-dirty-edits' }]);
    expect(c.load).not.toHaveBeenCalled();
  });
  it('reloads the current saved workspace for each externally completed update revision', async () => {
    const { c, execute } = sourceHarness();
    c.saveState.value = 'saved';
    await execute();
    expect(c.load).toHaveBeenCalledOnce();
    c.draftRevision.value = 2;
    c.loadEffectTemplateMixSources.mockResolvedValue({ data: { materials: [{ id: 'new' }],
      classificationPools: [], pendingAddedMaterialIds: {}, draftRevision: 3 } });
    await execute();
    expect(c.load).toHaveBeenCalledTimes(2);
  });
  it('rejects a task response whose identity does not match the poll owner', async () => {
    const { c, execute } = harness();
    c.getEffectTemplateMixAiRun.mockResolvedValue({ data: { id: 'append', workflowRunId: 'other',
      operation: 'APPEND', status: 'COMPLETED', progress: 100 } });
    await execute('append');
    expect(c.aiRuns.value).toEqual([]);
    expect(c.finishAiRun).not.toHaveBeenCalled();
  });
  it('does not clear library or dirty edits on a transient source refresh failure', async () => {
    const { c, execute } = sourceHarness();
    c.loadEffectTemplateMixSources.mockRejectedValue(new Error('temporary timeout'));
    await execute();
    expect(c.classificationPools.value).toEqual([{ templateId: 'old', items: [] }]);
    expect(c.sourceMaterials.value).toEqual([{ id: 'old' }]);
    expect(c.load).not.toHaveBeenCalled();
  });
  it.each(['revision', 'epoch'])('rejects old classification responses after an update (%s)', async (reason) => {
    const { c, execute } = sourceHarness();
    if (reason === 'revision') c.workspaceRevisionFence.isCurrent.mockReturnValue(false);
    else c.draftRace.canInstall.mockReturnValue(false);
    await execute();
    expect(c.classificationPools.value).toEqual([{ templateId: 'old', items: [] }]);
    expect(c.sourceMaterials.value).toEqual([{ id: 'old' }]);
    expect(c.load).not.toHaveBeenCalled();
  });
  it('ignores classifications arriving after the source scope changes', async () => {
    const { c, execute } = sourceHarness();
    c.loadEffectTemplateMixSources.mockImplementation(async () => {
      c.props.workflowRunId = 'other';
      return { data: { classificationPools: [{ templateId: 'other' }], materials: [] } };
    });
    await execute();
    expect(c.classificationPools.value).toEqual([{ templateId: 'old', items: [] }]);
    expect(c.sourceMaterials.value).toEqual([{ id: 'old' }]);
    expect(c.load).not.toHaveBeenCalled();
  });
});
