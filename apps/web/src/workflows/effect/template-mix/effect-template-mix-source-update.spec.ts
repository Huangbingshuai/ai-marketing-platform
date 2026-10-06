import { describe, expect, it, vi } from 'vitest';
import { ScriptTarget, transpileModule } from 'typescript';
import { computed, ref } from 'vue';
import { resolveEffectTemplateMixMaterialRoles } from '@ai-marketing/contracts';
import page from './EffectTemplateMixNodePage.vue?raw';
import timeline from './EffectTemplateMixTimeline.vue?raw';

describe('current material library after repair or regeneration', () => {
  it('replaces the old file with the current file once and inherits the old purpose', () => {
    const workspace = ref({ materials: [
      { id: 'old', fileObjectId: 'old-file', available: true, activeSource: false },
      { id: 'latest', fileObjectId: 'new-file', available: true, activeSource: true,
        replacesMaterialIds: ['old'] },
      { id: 'latest-alias', fileObjectId: 'new-file', available: true, activeSource: true,
        replacesMaterialIds: ['old'] },
      { id: 'candidate', fileObjectId: 'candidate-file', available: true, activeSource: false },
    ] });
    const activeEntry = ref({ materialRoleOverrides: {} as Record<string, 'HOOK' | null> });
    const activeClassificationPool = ref({ items: [{ materialId: 'old', role: 'HOOK' as const,
      matchScore: 0.9 }] });
    const source = page.split('const availableMaterials =')[1]!.split('const expiredMaterialCount')[0]!;
    const script = transpileModule(`const availableMaterials =${source}`, {
      compilerOptions: { target: ScriptTarget.ES2022 },
    }).outputText;
    const library = new Function('computed', 'workspace', 'activeEntry', 'activeClassificationPool',
      `${script}\nreturn availableMaterials;`)(computed, workspace, activeEntry, activeClassificationPool) as {
        value: typeof workspace.value.materials;
      };
    expect(library.value.map((item) => item.id)).toEqual(['latest']);
    expect(library.value.map((item) => item.fileObjectId)).toEqual(['new-file']);
    expect(resolveEffectTemplateMixMaterialRoles(activeClassificationPool.value.items,
      activeEntry.value.materialRoleOverrides, workspace.value.materials).get('latest')?.role).toBe('HOOK');
    activeEntry.value.materialRoleOverrides = { old: 'HOOK' };
    expect(resolveEffectTemplateMixMaterialRoles([], activeEntry.value.materialRoleOverrides,
      workspace.value.materials).get('latest')).toMatchObject({ role: 'HOOK', source: 'MANUAL' });
    // Old references stay lookup-able for pending-update tracks, never as library cards.
    expect(workspace.value.materials.some((item) => item.id === 'old')).toBe(true);
    expect(page).not.toContain('条旧素材仅保留在原成片工程中');
    expect(page).not.toContain('旧成片另保留');
  });
});

// Execute the page's actual orchestration with scoped API doubles, without mounting media players.
const action = page.split('async function updateSourceProjects() {')[1]!
  .split('\nasync function resumeSourceUpdate()')[0]!;
function harness() {
  const entry = { workspace: { variants: [{ id: 'v2' }, { id: 'v4' }, { id: 'v5' }] } };
  const run = { id: 'output', workflowRunId: 'workflow', templateId: 'template',
    items: entry.workspace.variants.map((variant) => ({ id: `item-${variant.id}`, variantId: variant.id })) };
  const context = {
    sourceUpdateBusy: { value: false }, projectEditLocked: { value: false }, mutating: { value: false },
    activeEntry: { value: entry }, activeTemplateId: { value: 'template' },
    props: { projectId: 'project', workflowRunId: 'workflow' },
    variantSourceChanges: vi.fn(() => [{ slotId: 'changed' }]), templatePendingUpdateCount: vi.fn(() => 3),
    requestActionConfirmation: vi.fn().mockResolvedValue(true), flushPendingEdits: vi.fn().mockResolvedValue(true),
    sourceUpdateStarting: { value: false }, draftRevision: { value: 9 },
    sourceUpdatePendingVariantIds: { value: [] as string[] },
    syncEffectFinalOutput: vi.fn().mockResolvedValue({ data: { refreshed: [] } }),
    loadMixFinalOutputRuns: vi.fn().mockResolvedValue({ data: [run] }),
    updateMixSourceProjects: vi.fn().mockResolvedValue({ data: { ...run, status: 'QUEUED' } }),
    stopSourceUpdatePolling: vi.fn(), sourceUpdateItemIds: { value: [] as string[] },
    sourceUpdateRun: { value: null as unknown }, pollSourceUpdate: vi.fn(), sourceUpdateGeneration: 1,
    showNotice: vi.fn(),
  };
  const executable = transpileModule(`async function execute() {${action}`, {}).outputText;
  const execute = new Function(...Object.keys(context), `${executable}\nreturn execute;`)
    (...Object.values(context)) as () => Promise<void>;
  return { context, execute };
}

describe('workbench source update orchestration', () => {
  it.each(['PENDING_RENDER', 'COMPLETED'])('refreshes canvas artifacts immediately after local update succeeds (%s)', async (status) => {
    const source = page.split('async function pollSourceUpdate(run: FinalOutputRun, generation: number) {')[1]!
      .split('\nasync function updateSourceProjects()')[0]!;
    const context = {
      props: { projectId: 'project', workflowRunId: 'workflow' }, sourceUpdateGeneration: 1,
      getMixSourceUpdateRun: vi.fn().mockResolvedValue({ data: { status, items: [] } }),
      sourceUpdateRun: { value: {} as unknown }, sourceUpdateTimer: undefined,
      flushPendingEdits: vi.fn().mockResolvedValue(true),
      loadEffectTemplateMixWorkspace: vi.fn().mockResolvedValue({ data: { draft: 'confirmed' } }),
      installWorkspaceData: vi.fn(), packagingPanel: { value: { refresh: vi.fn() } },
      notifyOutputChange: vi.fn(), showNotice: vi.fn(),
    };
    const script = transpileModule(`async function execute(run, generation) {${source}`, {}).outputText;
    const execute = new Function(...Object.keys(context), `${script}\nreturn execute;`)(...Object.values(context));
    await execute({ id: 'local-update' }, 1);
    expect(context.installWorkspaceData).toHaveBeenCalledWith({ draft: 'confirmed' });
    expect(context.notifyOutputChange).toHaveBeenCalledExactlyOnceWith('project', 'workflow', true);
    expect(context.notifyOutputChange.mock.invocationCallOrder[0]).toBeLessThan(
      context.packagingPanel.value.refresh.mock.invocationCallOrder[0]!);
    expect(context.sourceUpdateRun.value).toBeNull();
    context.notifyOutputChange.mockClear();
    await execute({ id: 'late-task' }, 0);
    expect(context.notifyOutputChange).not.toHaveBeenCalled();
  });
  it('offers the same scoped local-update action in configuration and editor without forcing a refill for repairs', () => {
    const config = page.split('<footer>')[1]!.split('</footer>')[0]!;
    expect(config).toContain('@click="updateSourceProjects"');
    expect(config).toContain('templatePendingUpdateCount(activeEntry)');
    expect(page).not.toContain('当前模板配置或已绑定素材与确认版本不一致');
    const script = transpileModule(`const packagingActionBlockReason =${page
      .split('const packagingActionBlockReason =')[1]!.split('const committedVersions')[0]!}`, {}).outputText;
    const entry = ref({ needsAiFill: false, packagingSourceLocked: false });
    let count = 1;
    const reason = new Function('computed', 'runSwitching', 'activeEntry', 'templatePendingUpdateCount',
      `${script}\nreturn packagingActionBlockReason;`)(computed, ref(false), entry, () => count) as { value: string | null };
    expect(reason.value).toBe('成片引用的素材已更新，请先局部更新成片。');
    count = 0; entry.value = { ...entry.value }; // Invalidate the computed like an installed workspace.
    expect(reason.value).toBeNull();
    entry.value.needsAiFill = true;
    expect(reason.value).toContain('模板槽位配置已修改');
  });
  it('starts all three affected films directly without pre-validating obsolete source revisions', async () => {
    const { context, execute } = harness();
    context.syncEffectFinalOutput.mockRejectedValue(new Error('测试1 · 5 的当前画面素材不可用'));
    await execute();
    expect(context.syncEffectFinalOutput).not.toHaveBeenCalled();
    expect(context.updateMixSourceProjects).toHaveBeenCalledExactlyOnceWith('project', 'output', ['item-v2', 'item-v4', 'item-v5']);
    expect(context.sourceUpdateRun.value).toMatchObject({ status: 'QUEUED' });
    expect(context.sourceUpdateStarting.value).toBe(false);
    expect(context.showNotice).not.toHaveBeenCalled();
    expect(context.pollSourceUpdate).toHaveBeenCalledOnce();
  });
  it('reconciles a missing confirmed batch only, then starts the scoped update', async () => {
    const { context, execute } = harness();
    context.loadMixFinalOutputRuns.mockResolvedValueOnce({ data: [] });
    await execute();
    expect(context.syncEffectFinalOutput).toHaveBeenCalledExactlyOnceWith('project', 'workflow', {
      templateId: 'template', expectedDraftRevision: 9,
    });
    expect(context.updateMixSourceProjects).toHaveBeenCalledOnce();
  });
  it('does not reconcile or start a task after the user changes template', async () => {
    const { context, execute } = harness();
    context.loadMixFinalOutputRuns.mockImplementationOnce(async () => {
      context.activeTemplateId.value = 'other';
      return { data: [] };
    });
    await execute();
    expect(context.syncEffectFinalOutput).not.toHaveBeenCalled();
    expect(context.updateMixSourceProjects).not.toHaveBeenCalled();
    expect(context.sourceUpdateStarting.value).toBe(false);
  });
});

describe('source update project locks', () => {
  it('uses durable task status for queued/running locks and clears them for terminal or other scopes', () => {
    const context = { computed, props: { workflowRunId: 'w' },
      sourceUpdateStarting: ref(false), activeTemplateId: ref('t'),
      sourceUpdateRun: ref({ workflowRunId: 'w', templateId: 't', status: 'QUEUED' }),
    };
    const source = page.split('const sourceUpdateBusy =')[1]!.split('const sourceUpdateProgress')[0]!;
    const script = transpileModule(`const sourceUpdateBusy =${source}`, {}).outputText;
    const busy = new Function(...Object.keys(context), `${script}\nreturn sourceUpdateBusy;`)
      (...Object.values(context)) as { value: boolean };
    expect(busy.value).toBe(true);
    context.sourceUpdateRun.value.status = 'RUNNING'; expect(busy.value).toBe(true);
    for (const status of ['COMPLETED', 'PENDING_RENDER', 'FAILED', 'PARTIAL', 'CANCELLED']) {
      context.sourceUpdateRun.value.status = status; expect(busy.value).toBe(false);
    }
    context.sourceUpdateRun.value.status = 'RUNNING';
    context.sourceUpdateRun.value.workflowRunId = 'other'; expect(busy.value).toBe(false);
    context.sourceUpdateRun.value.workflowRunId = 'w';
    context.activeTemplateId.value = 'other'; expect(busy.value).toBe(false);
  });
  const setup = () => {
    const context = {
      computed, sourceUpdateBusy: ref(true), sourceUpdateStarting: ref(false),
      sourceUpdatePendingVariantIds: ref(['v2']), sourceUpdateItemIds: ref(['i2']),
      workspaceTaskLocked: ref(false), selectedVariant: ref({ id: 'v2' }),
      sourceUpdateRun: ref({ items: [{ id: 'i1', variantId: 'v1' }, { id: 'i2', variantId: 'v2' }] }),
    };
    const source = page.split('const sourceUpdateLockedVariantIds =')[1]!
      .split('/**')[0]!;
    const script = transpileModule(`const sourceUpdateLockedVariantIds =${source}`, {}).outputText;
    const locks = new Function(...Object.keys(context), `${script}\nreturn {
      projectEditLocked, templateEditLocked, variantEditLocked, selectedSourceUpdateLocked };`)
      (...Object.values(context)) as {
        projectEditLocked: { value: boolean }; templateEditLocked: { value: boolean };
        variantEditLocked: (id: string) => boolean; selectedSourceUpdateLocked: { value: boolean };
      };
    return { context, locks };
  };
  it('locks participating films only, including switching away from and back to them', () => {
    const { context, locks } = setup();
    expect(locks.projectEditLocked.value).toBe(true);
    expect(locks.templateEditLocked.value).toBe(true);
    expect(locks.variantEditLocked('v1')).toBe(false);
    context.selectedVariant.value = { id: 'v1' };
    expect(locks.projectEditLocked.value).toBe(false);
    expect(locks.variantEditLocked('v2')).toBe(true);
    context.selectedVariant.value = { id: 'v2' };
    expect(locks.projectEditLocked.value).toBe(true);
    context.sourceUpdateBusy.value = false;
    expect(locks.projectEditLocked.value).toBe(false);
    expect(locks.templateEditLocked.value).toBe(false);
  });
  it('locks the affected films while starting, before a run response exists', () => {
    const { context, locks } = setup();
    context.sourceUpdateStarting.value = true;
    context.sourceUpdateRun.value.items = [];
    expect(locks.variantEditLocked('v2')).toBe(true);
    expect(locks.variantEditLocked('v1')).toBe(false);
  });
  it('reuses effective track locks without clearing manual locks after a task', () => {
    const props = { packagingSourceLock: false, sourceUpdateLock: true };
    const trackLocked = { VIDEO: false, CAPTION: true };
    const emit = vi.fn();
    const source = timeline.split('const trackIsLocked =')[1]!.split('let resizeObserver')[0]!;
    const script = transpileModule(`const trackIsLocked =${source}`, {}).outputText;
    const { trackIsLocked, toggleTrackLock } = new Function('props', 'trackLocked', 'emit',
      `${script}\nreturn { trackIsLocked, toggleTrackLock };`)(props, trackLocked, emit);
    expect(trackIsLocked('VIDEO')).toBe(true);
    toggleTrackLock('VIDEO');
    expect(trackLocked.VIDEO).toBe(false);
    expect(emit).toHaveBeenCalledWith('requestNotice', expect.stringContaining('局部更新'), 'warning');
    props.sourceUpdateLock = false;
    expect(trackIsLocked('VIDEO')).toBe(false);
    expect(trackIsLocked('CAPTION')).toBe(true);
    expect(page).toContain(':source-update-lock="selectedSourceUpdateLocked"');
    const progress = page.split('v-if="sourceUpdateBusy && sourceUpdateRun"')[1]!.split('/>')[0]!;
    expect(progress).toContain('action-label=""');
    expect(progress).not.toContain('show-details');
  });
});
