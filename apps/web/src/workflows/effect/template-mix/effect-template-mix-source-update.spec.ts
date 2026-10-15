import { describe, expect, it, vi } from 'vitest';
import { ScriptTarget, transpileModule } from 'typescript';
import { computed, ref } from 'vue';
import { resolveEffectTemplateMixMaterialRoles, packagingTimelineDuration, effectTemplateMixMaterialFitsTemplate } from '@ai-marketing/contracts';
import { effectTemplateMixTiming } from './effect-template-mix-state';
import page from './EffectTemplateMixNodePage.vue?raw';
import timeline from './EffectTemplateMixTimeline.vue?raw';
import { ApiClientError, isNetworkError } from '../../../api/http-client';

describe('current material library after repair or regeneration', () => {
  it('keeps deletion holes complete with their original extent, but not an unavailable bound source', () => {
    const variant = { slots: [{ id: 'first', duration: 4, transition: '硬切' },
      { id: 'last', duration: 4, transition: '硬切' }], bindings: {}, bindingRevisions: {},
      offsets: {}, conflictSlotIds: [], intentionallyEmptySlotIds: ['first', 'last'],
      preservedTimelineEnd: 11, timelineStarts: { last: 7 } };
    const workspace = ref({ variants: [variant] });
    const materialForSlot = () => null;
    const completeSource = page.split('const complete =')[1]!.split('const validated =')[0]!;
    const durationSource = page.split('const variantDuration =')[1]!.split('/**')[0]!;
    const script = transpileModule(`const complete =${completeSource}\nconst variantDuration =${durationSource}`, {
      compilerOptions: { target: ScriptTarget.ES2022 },
    }).outputText;
    const checks = new Function('computed', 'workspace', 'materialForSlot', 'effectTemplateMixTiming', 'packagingTimelineDuration', 'variantConflictCount',
      `${script}\nreturn { complete, variantDuration };`)(computed, workspace, materialForSlot, effectTemplateMixTiming, packagingTimelineDuration,
        (value: { conflictSlotIds: string[] }) => value.conflictSlotIds.length);
    expect(checks.complete.value).toBe(true);
    expect(checks.variantDuration(variant)).toBe(11);
    workspace.value.variants[0]!.intentionallyEmptySlotIds = [];
    Object.assign(workspace.value.variants[0]!.bindings, { first: 'unavailable-source' });
    expect(checks.complete.value).toBe(false);
  });
  it('replaces the old file with the current file once and inherits the old purpose', () => {
    const workspace = ref({ template: { slots: [{ duration: 4 }] }, materials: [
      { id: 'old', fileObjectId: 'old-file', available: true, activeSource: false },
      { id: 'latest', fileObjectId: 'new-file', duration: 5, available: true, activeSource: true,
        replacesMaterialIds: ['old'] },
      { id: 'latest-alias', fileObjectId: 'new-file', duration: 5, available: true, activeSource: true,
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
    const library = new Function('computed', 'workspace', 'activeEntry', 'activeClassificationPool', 'effectTemplateMixMaterialFitsTemplate',
      `${script}\nreturn availableMaterials;`)(computed, workspace, activeEntry, activeClassificationPool, effectTemplateMixMaterialFitsTemplate) as {
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
const action = page.split('async function updateSourceProjects(afterSuccess?: (run: FinalOutputRun) => Promise<void>) {')[1]!
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
    openTemplateWorkspace: vi.fn().mockResolvedValue(true),
    installedWorkspaceScope: ref('project:workflow'),
    currentWorkspaceScope: ref('project:workflow'), workbenchActive: true,
    sourceUpdateStarting: { value: false }, draftRevision: { value: 9 },
    sourceUpdatePendingVariantIds: { value: [] as string[] },
    syncEffectFinalOutput: vi.fn().mockResolvedValue({ data: { refreshed: [] } }),
    loadMixFinalOutputRuns: vi.fn().mockResolvedValue({ data: [run] }),
    updateMixSourceProjects: vi.fn().mockResolvedValue({ data: { ...run, status: 'QUEUED' } }),
    stopSourceUpdatePolling: vi.fn(), sourceUpdateItemIds: { value: [] as string[] },
    sourceUpdateRun: { value: null as unknown }, pollSourceUpdate: vi.fn(), sourceUpdateGeneration: 1,
    showNotice: vi.fn(),
    afterSuccess: undefined,
    pendingAddedCount: ref(0),
    sourceMaterials: ref([]), pendingAddedMaterialIds: ref({ template: [] }),
    autoPackagingTemplateIds: ref([]),
    effectTemplateMixSourceUpdateSignature: vi.fn(() => 'confirmed-source-difference'),
    crypto: { randomUUID: () => 'confirmed-operation' }, load: vi.fn().mockResolvedValue(undefined),
    ApiClientError, isNetworkError,
  };
  const executable = transpileModule(`async function execute() {${action}`, {
    compilerOptions: { target: ScriptTarget.ES2022 },
  }).outputText;
  const execute = new Function(...Object.keys(context), `${executable}\nreturn execute;`)
    (...Object.values(context)) as () => Promise<void>;
  return { context, execute };
}

describe('workbench source update orchestration', () => {
  it.each(['QUEUED', 'PENDING_RENDER'])('recovers only the exact persisted confirmation after a lost POST response (%s)', async (status) => {
    const { context, execute } = harness();
    context.updateMixSourceProjects.mockRejectedValue(new TypeError('Failed to fetch'));
    context.loadMixFinalOutputRuns.mockResolvedValue({ data: [
      { id: 'wrong-run', workflowRunId: 'other', templateId: 'template', sourceOperationId: 'confirmed-operation', items: [] },
      { id: 'old-confirmation', workflowRunId: 'workflow', templateId: 'template', sourceOperationId: 'old', items: [] },
      { id: 'confirmed', workflowRunId: 'workflow', templateId: 'template', sourceOperationId: 'confirmed-operation', status,
        items: [{ id: 'changed', variantId: 'v2' }, { id: 'unaffected', variantId: 'v1' }] },
    ] });
    await execute();
    expect(context.updateMixSourceProjects).toHaveBeenCalledOnce();
    expect(context.sourceUpdateRun.value).toMatchObject({ id: 'confirmed', status });
    expect(context.sourceUpdateItemIds.value).toEqual(['changed']);
    expect(context.pollSourceUpdate).toHaveBeenCalledWith(expect.objectContaining({ id: 'confirmed' }), 1, undefined);
    expect(context.showNotice).not.toHaveBeenCalled();
  });
  it('does not invent success or replay the write when the submission outcome is unknown', async () => {
    const { context, execute } = harness();
    context.updateMixSourceProjects.mockRejectedValue(new ApiClientError('服务器内部错误', 500));
    context.loadMixFinalOutputRuns.mockResolvedValue({ data: [] });
    await execute();
    expect(context.updateMixSourceProjects).toHaveBeenCalledOnce();
    expect(context.sourceUpdateRun.value).toBeNull();
    expect(context.pollSourceUpdate).not.toHaveBeenCalled();
    expect(context.showNotice).toHaveBeenCalledWith(expect.stringContaining('提交结果暂时无法确认'), 'warning');
  });
  it('ignores a recovered task if its template changed during the recovery read', async () => {
    const { context, execute } = harness();
    context.updateMixSourceProjects.mockRejectedValue(new TypeError('Failed to fetch'));
    context.loadMixFinalOutputRuns.mockImplementation(async () => {
      context.activeTemplateId.value = 'other';
      return { data: [] };
    });
    await execute();
    expect(context.pollSourceUpdate).not.toHaveBeenCalled();
    expect(context.showNotice).not.toHaveBeenCalled();
  });
  it('retains the durable operation and retries a progress read instead of reporting task failure', async () => {
    const source = page.split('async function pollSourceUpdate(')[1]!.replace(/^[\s\S]*?\)\s*\{/, '')
      .split('\nasync function updateSourceProjects(')[0]!;
    const run = { id: 'confirmed', workflowRunId: 'workflow', templateId: 'template', status: 'RUNNING' };
    const context = { props: { projectId: 'project', workflowRunId: 'workflow' }, sourceUpdateGeneration: 1,
      activeTemplateId: ref('template'), getMixSourceUpdateRun: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')),
      sourceUpdateRun: ref(run), sourceUpdateTimer: undefined, setTimeout: vi.fn(() => 1), showNotice: vi.fn() };
    const script = transpileModule(`async function execute(run, generation) {${source}`, {}).outputText;
    const execute = new Function(...Object.keys(context), `${script}\nreturn execute;`)(...Object.values(context));
    await execute(run, 1);
    expect(context.sourceUpdateRun.value).toEqual(run);
    expect(context.showNotice).not.toHaveBeenCalled();
    expect(context.setTimeout).toHaveBeenCalledWith(expect.any(Function), 3000);
  });
  it('clears cancelled net differences without polling, appending or invoking paid work', async () => {
    const { context, execute } = harness();
    context.updateMixSourceProjects.mockResolvedValue({ data: { noChanges: true } });
    await execute();
    expect(context.load).toHaveBeenCalledOnce();
    expect(context.sourceUpdatePendingVariantIds.value).toEqual([]);
    expect(context.pollSourceUpdate).not.toHaveBeenCalled();
    expect(context.showNotice).toHaveBeenCalledWith('待更新差异已抵消，无需更新');
  });
  it('continues only the confirmed frozen APPEND context, never a different template or duplicate', async () => {
    const source = page.split('async function continueFrozenAppend(run: FinalOutputRun) {')[1]!
      .split('\nwatch(')[0]!;
    const script = transpileModule(`async function execute(run) {${source}`, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText;
    const startAiFill = vi.fn();
    const execute = new Function('props', 'activeTemplateId', 'startAiFill', `${script}\nreturn execute;`)(
      { workflowRunId: 'w' }, ref('t'), startAiFill);
    const run = { workflowRunId: 'w', templateId: 't', sourceOperationHasAdditions: true, sourceOperationId: 'frozen-confirmation' };
    await execute(run);
    expect(startAiFill).toHaveBeenCalledExactlyOnceWith(null, false, true, 'frozen-confirmation');
    await execute({ ...run, workflowRunId: 'other' });
    await execute({ ...run, templateId: 'other' });
    await execute({ ...run, sourceOperationAppendStarted: true });
    expect(startAiFill).toHaveBeenCalledOnce();
  });
  it('stops before confirmation and API write while a different workspace is installed', async () => {
    const { context: c, execute } = harness();
    c.installedWorkspaceScope.value = 'project:other';
    await execute();
    expect(c.openTemplateWorkspace).not.toHaveBeenCalled();
    expect(c.requestActionConfirmation).not.toHaveBeenCalled();
    expect(c.updateMixSourceProjects).not.toHaveBeenCalled();
  });
  it.each(['PENDING_RENDER', 'COMPLETED'])('refreshes canvas artifacts immediately after local update succeeds (%s)', async (status) => {
    const source = page.split('async function pollSourceUpdate(')[1]!.replace(/^[\s\S]*?\)\s*\{/, '')
      .split('\nasync function updateSourceProjects(')[0]!;
    const context = {
      props: { projectId: 'project', workflowRunId: 'workflow' }, sourceUpdateGeneration: 1,
      activeTemplateId: ref('template'),
      getMixSourceUpdateRun: vi.fn().mockResolvedValue({ data: {
        id: 'local-update', workflowRunId: 'workflow', templateId: 'template', status, items: [],
      } }),
      sourceUpdateRun: { value: {} as unknown }, sourceUpdateTimer: undefined,
      sourceUpdateHandoff: ref(false), activeAppendRun: ref<unknown>(null),
      setTimeout: vi.fn(() => 1),
      flushPendingEdits: vi.fn().mockResolvedValue(true),
      loadEffectTemplateMixWorkspace: vi.fn().mockResolvedValue({ data: { draft: 'confirmed' } }),
      draftRace: { readToken: vi.fn(() => 1), canInstall: vi.fn(() => true) },
      saveState: ref('saved'),
      installWorkspaceData: vi.fn(() => true), packagingPanel: { value: { refresh: vi.fn() } },
      notifyOutputChange: vi.fn(), showNotice: vi.fn(),
      afterSuccess: vi.fn().mockResolvedValue(undefined),
      pendingAddedCount: ref(0),
    };
    const script = transpileModule(`async function execute(run, generation) {${source}`, {}).outputText;
    const execute = new Function(...Object.keys(context), `${script}\nreturn execute;`)(...Object.values(context));
    await execute({ id: 'local-update', workflowRunId: 'workflow', templateId: 'template' }, 1);
    expect(context.installWorkspaceData).toHaveBeenCalledWith({ draft: 'confirmed' }, 'project:workflow');
    expect(context.notifyOutputChange).toHaveBeenCalledExactlyOnceWith('project', 'workflow', true);
    expect(context.notifyOutputChange.mock.invocationCallOrder[0]).toBeLessThan(
      context.packagingPanel.value.refresh.mock.invocationCallOrder[0]!);
    expect(context.sourceUpdateRun.value).toBeNull();
    expect(context.afterSuccess).toHaveBeenCalledOnce();
    context.notifyOutputChange.mockClear();
    await execute({ id: 'late-task' }, 0);
    expect(context.notifyOutputChange).not.toHaveBeenCalled();
    context.installWorkspaceData.mockClear();
    context.draftRace.canInstall.mockReturnValue(false);
    await execute({ id: 'local-update', workflowRunId: 'workflow', templateId: 'template' }, 1);
    expect(context.installWorkspaceData).not.toHaveBeenCalled();
    expect(context.notifyOutputChange).not.toHaveBeenCalled();
    expect(context.setTimeout).toHaveBeenCalledWith(expect.any(Function), 1200);
    context.draftRace.canInstall.mockReturnValue(true);
    context.installWorkspaceData.mockReturnValue(false);
    await execute({ id: 'local-update', workflowRunId: 'workflow', templateId: 'template' }, 1);
    expect(context.notifyOutputChange).not.toHaveBeenCalled();
    expect(context.setTimeout).toHaveBeenCalledTimes(2);
    context.installWorkspaceData.mockReturnValue(true);
    context.flushPendingEdits.mockResolvedValueOnce(false);
    await execute({ id: 'local-update', workflowRunId: 'workflow', templateId: 'template' }, 1);
    expect(context.setTimeout).toHaveBeenCalledTimes(3);
    expect(context.sourceUpdateHandoff.value).toBe(true);
    expect(context.notifyOutputChange).not.toHaveBeenCalled();

    // The latest library can differ, but this click must consume its frozen additions.
    context.getMixSourceUpdateRun.mockResolvedValue({ data: {
      id: 'local-update', workflowRunId: 'workflow', templateId: 'template', status, items: [],
      sourceOperationId: 'one-confirmation', sourceOperationHasAdditions: true,
    } });
    context.showNotice.mockClear();
    context.afterSuccess.mockImplementationOnce(async () => {
      expect(context.sourceUpdateHandoff.value).toBe(true);
      expect(context.sourceUpdateRun.value).toMatchObject({ sourceOperationId: 'one-confirmation' });
      context.activeAppendRun.value = { id: 'append', status: 'RUNNING' };
    });
    await execute({ id: 'local-update', workflowRunId: 'workflow', templateId: 'template' }, 1);
    expect(context.afterSuccess).toHaveBeenLastCalledWith(expect.objectContaining({ sourceOperationId: 'one-confirmation' }));
    expect(context.sourceUpdateHandoff.value).toBe(true);
    expect(context.sourceUpdateRun.value).not.toBeNull();
    expect(context.showNotice).not.toHaveBeenCalledWith('局部更新已完成');
  });
  it('offers scoped local update only in the editor without forcing a refill for repairs', () => {
    const config = page.split('<footer>')[1]!.split('</footer>')[0]!;
    expect(config).not.toContain('@click="updateSourceProjects"');
    expect(page).toContain('@click="updateCurrentTemplate"');
    expect(page).not.toContain('当前模板配置或已绑定素材与确认版本不一致');
    const script = transpileModule(`const packagingActionBlockReason =${page
      .split('const packagingActionBlockReason =')[1]!.split('const committedVersions')[0]!}`, {}).outputText;
    const entry = ref({ needsAiFill: false, packagingSourceLocked: false });
    let count = 1;
    const pendingAddedCount = ref(0);
    const reason = new Function('computed', 'runSwitching', 'activeEntry', 'pendingAddedCount', 'templatePendingUpdateCount', 'localUpdateBusy',
      `${script}\nreturn packagingActionBlockReason;`)(computed, ref(false), entry, pendingAddedCount, () => count, ref(false)) as { value: string | null };
    expect(reason.value).toBe('当前模板有素材待更新，请先完成局部更新，再进行智能成片包装。');
    count = 0; entry.value = { ...entry.value }; // Invalidate the computed like an installed workspace.
    expect(reason.value).toBeNull();
    pendingAddedCount.value = 2;
    expect(reason.value).toContain('请先完成局部更新');
    pendingAddedCount.value = 0;
    expect(reason.value).toBeNull();
    entry.value.needsAiFill = true;
    expect(reason.value).toContain('模板槽位配置已修改');
  });
  it('rejects pending source updates before saving or preparing a packaging task', async () => {
    const source = page.split('const preparePackaging =')[1]!.split('const startAiFill =')[0]!;
    const script = transpileModule(`const execute =${source}`, {}).outputText;
    const reason = ref<string | null>('请先完成局部更新');
    const showNotice = vi.fn(), flush = vi.fn().mockResolvedValue(true);
    const execute = new Function('packagingActionBlockReason', 'showNotice', 'flushPendingEdits', 'draftRevision',
      `${script}\nreturn execute;`)(reason, showNotice, flush, ref(9));
    expect(await execute()).toBeNull();
    expect(showNotice).toHaveBeenCalledWith('请先完成局部更新', 'warning');
    expect(flush).not.toHaveBeenCalled();
    // Successful draft preparation (including its current-revision read) is exercised by
    // effect-packaging-draft-input.spec.ts; this harness intentionally tests the early guard.
  });
  it('keeps first packaging and repackaging icons and lets a blocked click explain the prerequisite', () => {
    const action = page.split('<div class="project-actions"')[1]!.split('project-workflow-action')[0]!;
    expect(action).toContain('<RefreshCw v-else-if="packagingActionLabel === \'重新成片包装\'" :size="14" />');
    expect(action).toContain('<WandSparkles v-else :size="14" />');
    expect(action).toContain('<LoaderCircle');
    expect(action).not.toContain('Boolean(packagingActionBlockReason)');
    expect(action).toContain('@click="openPackaging(\'ACTION\')"');
  });
  it('does not require local update before a full refill and does not route it to APPEND', () => {
    const source = page.split('const startAiFill =')[1]!.split('const refill =')[0]!;
    expect(source).not.toContain('packagingActionBlockReason');
    expect(page).toContain('const refill = (): void => void startAiFill(null);');
    expect(page).toContain('await startAiFill(null, false, true, run.sourceOperationId);');
    expect(source).toContain('createEffectTemplateMixAiRun(');
  });
  it('starts all three affected films directly without pre-validating obsolete source revisions', async () => {
    const { context, execute } = harness();
    context.syncEffectFinalOutput.mockRejectedValue(new Error('测试1 · 5 的当前画面素材不可用'));
    await execute();
    expect(context.syncEffectFinalOutput).not.toHaveBeenCalled();
    expect(context.updateMixSourceProjects).toHaveBeenCalledExactlyOnceWith('project', {
      workflowRunId: 'workflow', templateId: 'template', expectedDraftRevision: 9,
      variantIds: ['v2', 'v4', 'v5'],
      appendNewMaterials: true, expectedSourceSignature: 'confirmed-source-difference', operationId: 'confirmed-operation',
      expectedPackageNewVariants: false,
    });
    expect(context.loadMixFinalOutputRuns).not.toHaveBeenCalled();
    expect(context.sourceUpdateRun.value).toMatchObject({ status: 'QUEUED' });
    expect(context.sourceUpdateStarting.value).toBe(false);
    expect(context.showNotice).not.toHaveBeenCalled();
    expect(context.pollSourceUpdate).toHaveBeenCalledOnce();
  });
  it('does not create source or append tasks after cancelling the combined confirmation', async () => {
    const { context, execute } = harness();
    context.pendingAddedCount.value = 2;
    context.requestActionConfirmation.mockResolvedValue(false);
    await execute();
    expect(context.requestActionConfirmation).toHaveBeenCalledWith(expect.objectContaining({
      title: '更新已有工程并追加新成片？', description: expect.stringContaining('随后归槽新增素材'),
    }));
    expect(context.updateMixSourceProjects).not.toHaveBeenCalled();
    expect(context.pollSourceUpdate).not.toHaveBeenCalled();
  });
  it.each(['FAILED', 'PARTIAL', 'CANCELLED'])('does not append after an unsuccessful source update (%s)', async (status) => {
    const source = page.split('async function pollSourceUpdate(')[1]!.replace(/^[\s\S]*?\)\s*\{/, '')
      .split('\nasync function updateSourceProjects(')[0]!;
    const context = { props: { projectId: 'project', workflowRunId: 'workflow' }, sourceUpdateGeneration: 1,
      activeTemplateId: ref('template'),
      getMixSourceUpdateRun: vi.fn().mockResolvedValue({ data: {
        id: 'failed', workflowRunId: 'workflow', templateId: 'template', status, items: [],
      } }),
      sourceUpdateRun: ref<unknown>({}), showNotice: vi.fn(), afterSuccess: vi.fn(),
      sourceUpdateHandoff: ref(true),
    };
    const script = transpileModule(`async function execute(run, generation) {${source}`, {}).outputText;
    const execute = new Function(...Object.keys(context), `${script}\nreturn execute;`)(...Object.values(context));
    await execute({ id: 'failed', workflowRunId: 'workflow', templateId: 'template' }, 1);
    expect(context.afterSuccess).not.toHaveBeenCalled();
    expect(context.showNotice).toHaveBeenCalledWith('局部更新未完成，请重试', 'error');
    expect(context.sourceUpdateRun.value).toBeNull();
    expect(context.sourceUpdateHandoff.value).toBe(false);
  });
  it('does not infer confirmation from a missing output list or ordinary sync', async () => {
    const { context, execute } = harness();
    context.loadMixFinalOutputRuns.mockResolvedValueOnce({ data: [] });
    await execute();
    expect(context.syncEffectFinalOutput).not.toHaveBeenCalled();
    expect(context.updateMixSourceProjects).toHaveBeenCalledOnce();
  });
  it('does not reconcile or start a task after the user changes template', async () => {
    const { context, execute } = harness();
    context.flushPendingEdits.mockImplementationOnce(async () => {
      context.activeTemplateId.value = 'other';
      return true;
    });
    await execute();
    expect(context.syncEffectFinalOutput).not.toHaveBeenCalled();
    expect(context.updateMixSourceProjects).not.toHaveBeenCalled();
    expect(context.sourceUpdateStarting.value).toBe(false);
  });
  it('propagates an actual server error without pretending confirmed projects are missing', async () => {
    const { context, execute } = harness();
    context.updateMixSourceProjects.mockRejectedValue(new Error('成片工程已变化，请刷新后重试'));
    await execute();
    expect(context.showNotice).toHaveBeenCalledWith('成片工程已变化，请刷新后重试', 'error');
    expect(context.sourceUpdateStarting.value).toBe(false);
    expect(context.pollSourceUpdate).not.toHaveBeenCalled();
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
      packagingPreviewReadOnly: ref(false),
      variantPackagingLocked: () => false, packagingResults: ref([]),
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
  it('keeps a live packaging result read-only without using the edit lock as a playback guard', () => {
    const { context, locks } = setup();
    context.sourceUpdateBusy.value = false;
    context.packagingPreviewReadOnly.value = true;
    expect(locks.projectEditLocked.value).toBe(true);
    const playback = page.split('const togglePlay =')[1]!.split('const onTimelinePlayerWaiting =')[0]!;
    expect(playback).not.toContain('projectEditLocked');
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
    const progress = page.split('v-if="localUpdateProgress"')[1]!.split('/>')[0]!;
    expect(progress).toContain('action-label=""');
    expect(progress).not.toContain('show-details');
  });
});
