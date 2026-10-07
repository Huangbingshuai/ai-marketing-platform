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
        mutating: ref(false), activeAiRun: ref(null), backgroundAiBusy: ref(false),
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
