import { describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { transpileModule } from 'typescript';
import page from './EffectTemplateMixNodePage.vue?raw';
import { saveLatestMixDraft } from './effect-template-mix-draft-race';

function execute(source: string, context: Record<string, unknown>) {
  return new Function('state', `with (state) { ${transpileModule(source, {}).outputText} }`)(context);
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function saveHarness() {
  const state = {
    clearTimeout: vi.fn(), saveTimer: undefined, pendingSave: undefined as Promise<boolean> | undefined,
    currentWorkspaceScope: ref('project:run'), draftSaveBlocked: false,
    saveState: ref('saved'), saveLatestMixDraft, persistNow: vi.fn().mockResolvedValue(true),
  };
  const source = page.split('const persist =')[1]!.split('const persistNow =')[0]!;
  const persist = execute(`const persist =${source}; return persist;`, state);
  return { state, persist };
}

describe('local update save queue and task ownership', () => {
  it('leaving the node stops foreground work without cancelling or retrying the server task', () => {
    const context = {
      closeMaterialPreview: vi.fn(), resetPlayerSpace: vi.fn(), framePresentation: { reset: vi.fn() },
      finishVideoWheelGesture: vi.fn(), clearVideoGuides: vi.fn(), releaseExplicitWorkspaceTarget: vi.fn(),
      stopSourceUpdatePolling: vi.fn(), workbenchActive: true, controller: { abort: vi.fn() },
      clearInterval: vi.fn(), sourcePollTimer: 1, sourcePollController: { abort: vi.fn() },
      mixWorkbenchWasDeactivated: false, playing: ref(true), pauseTimelinePlayers: vi.fn(),
      stopPlaybackClock: vi.fn(), packagingPanel: ref({ stopPlaybackAudio: vi.fn() }),
    };
    const source = page.split('onDeactivated(() => {')[1]!.split('onBeforeUnmount')[0]!;
    execute(`const leave = () => {${source.split('});')[0]!}}; return leave;`, context)();
    expect(context.stopSourceUpdatePolling).toHaveBeenCalledOnce();
    expect(context.controller.abort).toHaveBeenCalledOnce();
    expect(context.sourcePollController.abort).toHaveBeenCalledOnce();
    expect(context.workbenchActive).toBe(false);
    expect(context.mixWorkbenchWasDeactivated).toBe(true);
    expect(context.playing.value).toBe(false);
    // No mutation service is present in this harness: a cancellation or task
    // restart from this lifecycle hook would fail the execution above.
  });

  function completionHarness() {
    const context = {
      props: { projectId: 'p', workflowRunId: 'current' },
      currentWorkspaceScope: ref('p:current'), runSwitching: ref(false),
      stopPolling: vi.fn(), mutating: ref(false), load: vi.fn(), showNotice: vi.fn(),
      sourceUpdateHandoff: ref(true), sourceUpdateRun: ref<unknown>({ id: 'source' }),
      activeTemplateId: ref('t'), catalog: ref([{ id: 't', workspace: { variants: [] } }]),
      flushPendingEdits: vi.fn().mockResolvedValue(true), setTimeout: vi.fn(() => 1), pollTimers: new Map(),
      draftRace: { readToken: vi.fn(() => 1), canInstall: vi.fn(() => true) },
      loadEffectTemplateMixWorkspace: vi.fn().mockResolvedValue({ data: {} }),
      saveState: ref('saved'), installWorkspaceData: vi.fn(() => true), uiByTemplate: {}, view: ref('EDITOR'),
    };
    const source = page.split('const finishAiRun =')[1]!.split('const pollAiRun =')[0]!;
    const finish = execute(`const finishAiRun =${source}; return finishAiRun;`, context);
    return { context, finish };
  }
  const append = { id: 'append', templateId: 't', workflowRunId: 'current', operation: 'APPEND' };
  it.each(['COMPLETED', 'FAILED'])('does not release an unrelated write request when a task ends (%s)', async status => {
    const { context, finish } = completionHarness();
    context.mutating.value = true;
    await finish({ ...append, status });
    expect(context.mutating.value).toBe(true);
  });
  it.each(['FAILED', 'CANCELLED'])('explains an unsuccessful append without claiming the source phase failed (%s)', async (status) => {
    const { context, finish } = completionHarness();
    await finish({ ...append, status, errorMessage: '素材下载中断' });
    expect(context.showNotice).toHaveBeenCalledWith(expect.stringContaining('已成功更新的工程保留'), expect.any(String));
    expect(context.sourceUpdateHandoff.value).toBe(false);
    expect(context.sourceUpdateRun.value).toBeNull();
  });
  it('retries completion installation after saving is temporarily unavailable', async () => {
    const { context, finish } = completionHarness();
    context.flushPendingEdits.mockResolvedValueOnce(false);
    await finish({ ...append, status: 'COMPLETED' });
    expect(context.pollTimers.has('append')).toBe(true);
    expect(context.sourceUpdateHandoff.value).toBe(true);
    expect(context.loadEffectTemplateMixWorkspace).not.toHaveBeenCalled();
    expect(context.showNotice).not.toHaveBeenCalled();
    await finish({ ...append, status: 'COMPLETED' });
    expect(context.sourceUpdateHandoff.value).toBe(false);
    expect(context.showNotice).toHaveBeenCalledWith(expect.stringContaining('本次局部更新已完成'));
  });
  it('does not report full success when append persistence or automatic packaging continuation failed', async () => {
    const { context, finish } = completionHarness();
    await finish({ ...append, status: 'COMPLETED', errorCode: 'APPEND_CONTINUATION_FAILED' });
    expect(context.showNotice).toHaveBeenCalledWith(expect.stringContaining('不要重复追加'), 'error');
    expect(context.showNotice).not.toHaveBeenCalledWith(expect.stringContaining('本次局部更新已完成'));
  });
  it('releases the completed save so source polling can install the next worker revision', async () => {
    const { state, persist } = saveHarness();
    await persist();
    expect(state.pendingSave).toBeUndefined();
    // Repeated updates cannot leave a permanently occupied save queue.
    await persist();
    expect(state.persistNow).toHaveBeenCalledTimes(2);
    expect(state.pendingSave).toBeUndefined();
  });
  it('keeps the queue occupied until the last of two serialized saves settles', async () => {
    const { state, persist } = saveHarness();
    const first = deferred<boolean>();
    const second = deferred<boolean>();
    state.persistNow.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const a = persist();
    const b = persist();
    first.resolve(true);
    await a;
    expect(state.pendingSave).toBe(b);
    second.resolve(true);
    await b;
    expect(state.pendingSave).toBeUndefined();
  });
  it('releases failed saves too, without treating failure as a successful update', async () => {
    const { state, persist } = saveHarness();
    state.persistNow.mockResolvedValue(false);
    expect(await persist()).toBe(false);
    expect(state.pendingSave).toBeUndefined();
  });
  it.each(['project', 'run', 'template', 'installed-scope'])(
    'does not start a task against a different %s while waiting for saves', async (changed) => {
      const context = {
        runSwitching: ref(false), packagingInFlight: ref(false), workspace: ref({ variants: [] }),
        mutating: ref(false), fillStartPending: ref(false), activeAiRun: ref(null), backgroundAiBusy: ref(false),
        aiFillBlockReason: ref(''), draftRevision: ref(4), activeTemplateId: ref('template'),
        props: { projectId: 'project', workflowRunId: 'run' },
        currentWorkspaceScope: ref('project:run'), flushPendingEdits: vi.fn(),
        createEffectTemplateMixAiRun: vi.fn(), showNotice: vi.fn(),
      };
      context.flushPendingEdits.mockImplementation(async () => {
        if (changed === 'project') context.props.projectId = 'other';
        if (changed === 'run') context.props.workflowRunId = 'other';
        if (changed === 'template') context.activeTemplateId.value = 'other';
        if (changed === 'installed-scope') context.currentWorkspaceScope.value = 'other';
        return true;
      });
      const source = page.split('const startAiFill =')[1]!.split('// The top-level action')[0]!;
      await execute(`const startAiFill =${source}; return startAiFill;`, context)(null);
      expect(context.createEffectTemplateMixAiRun).not.toHaveBeenCalled();
      expect(context.mutating.value).toBe(false);
    },
  );
  it('releases request locks before a first-fill child Run handoff changes page ownership', async () => {
    const context = {
      runSwitching: ref(false), packagingInFlight: ref(false), workspace: ref({ variants: [] }),
      mutating: ref(false), activeAiRun: ref(null), backgroundAiBusy: ref(false),
      aiFillBlockReason: ref(''), draftRevision: ref(4), activeTemplateId: ref('template'),
      props: { projectId: 'project', workflowRunId: 'run' }, currentWorkspaceScope: ref('project:run'),
      flushPendingEdits: vi.fn().mockResolvedValue(true), fillStartPending: ref(false),
      createEffectTemplateMixAiRun: vi.fn().mockResolvedValue({ data: {
        id: 'fill', templateId: 'template', workflowRunId: 'child', status: 'QUEUED',
      } }),
      rememberWorkbench: vi.fn(), selectedVariant: ref(null), emit: vi.fn(), showNotice: vi.fn(), aiRuns: ref<unknown[]>([]),
    };
    context.emit.mockImplementation(() => {
      expect(context.fillStartPending.value).toBe(false);
      expect(context.mutating.value).toBe(false);
      expect(context.aiRuns.value).toMatchObject([{ id: 'fill', workflowRunId: 'child' }]);
      context.props.workflowRunId = 'child';
      context.currentWorkspaceScope.value = 'project:child';
    });
    const source = page.split('const startAiFill =')[1]!.split('// The top-level action')[0]!;
    await execute(`const startAiFill =${source}; return startAiFill;`, context)(null);
    expect(context.emit).toHaveBeenCalledExactlyOnceWith('workflowRunChange');
    expect(context.mutating.value).toBe(false);
    expect(context.fillStartPending.value).toBe(false);
  });
  it.each(['read-failed', 'install-blocked'])(
    'keeps polling an accepted append when its workspace projection is %s', async (failure) => {
      const run = { id: 'append', templateId: 'template', workflowRunId: 'run', operation: 'APPEND', status: 'QUEUED' };
      const context = {
        runSwitching: ref(false), packagingInFlight: ref(false), workspace: ref({ variants: [] }),
        mutating: ref(false), activeAiRun: ref(null), backgroundAiBusy: ref(false),
        aiFillBlockReason: ref(''), draftRevision: ref(4), activeTemplateId: ref('template'),
        props: { projectId: 'project', workflowRunId: 'run' }, currentWorkspaceScope: ref('project:run'),
        flushPendingEdits: vi.fn().mockResolvedValue(true), fillStartPending: ref(false),
        createEffectTemplateMixAiRun: vi.fn().mockResolvedValue({ data: run }), aiRuns: ref<unknown[]>([]),
        pollAiRun: vi.fn(), loadEffectTemplateMixWorkspace: vi.fn().mockResolvedValue({ data: {} }),
        installWorkspaceData: vi.fn(() => false), load: vi.fn(), showNotice: vi.fn(),
      };
      if (failure === 'read-failed') context.loadEffectTemplateMixWorkspace.mockRejectedValue(new Error('offline'));
      const source = page.split('const startAiFill =')[1]!.split('// The top-level action')[0]!;
      await execute(`const startAiFill =${source}; return startAiFill;`, context)(null, false, true, 'frozen');
      expect(context.pollAiRun).toHaveBeenCalledExactlyOnceWith('append');
      expect(context.aiRuns.value).toEqual([run]);
      expect(context.load).not.toHaveBeenCalled();
      expect(context.mutating.value).toBe(false);
      expect(context.createEffectTemplateMixAiRun).toHaveBeenCalledWith('project', 'run', 4, 'template', undefined, false, true, 'frozen');
    },
  );
  it('rejects completion from another Run before saving or loading anything', async () => {
    const context = {
      props: { projectId: 'p', workflowRunId: 'current' },
      currentWorkspaceScope: ref('p:current'), runSwitching: ref(false),
      stopPolling: vi.fn(), flushPendingEdits: vi.fn(), loadEffectTemplateMixWorkspace: vi.fn(),
    };
    const source = page.split('const finishAiRun =')[1]!.split('const pollAiRun =')[0]!;
    await execute(`const finishAiRun =${source}; return finishAiRun;`, context)({
      id: 'old-task', workflowRunId: 'old', status: 'COMPLETED',
    });
    expect(context.stopPolling).not.toHaveBeenCalled();
    expect(context.flushPendingEdits).not.toHaveBeenCalled();
    expect(context.loadEffectTemplateMixWorkspace).not.toHaveBeenCalled();
  });
});
