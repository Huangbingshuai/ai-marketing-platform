import { describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { ScriptTarget, transpileModule } from 'typescript';
import page from './EffectTemplateMixNodePage.vue?raw';
import { MixDraftRaceGuard } from './effect-template-mix-draft-race';
import { readMixWorkspaceWithDeadline } from './effect-template-mix-workspace-load';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function harness() {
  const run = {
    id: 'fill',
    templateId: 'template',
    workflowRunId: 'run',
    operation: 'FILL',
    status: 'QUEUED',
    progress: 0,
  };
  const c = {
    runSwitching: ref(false),
    packagingInFlight: ref(false),
    workspace: ref({ variants: [] }),
    mutating: ref(false),
    fillStartPending: ref(false),
    activeAiRun: ref(null),
    backgroundAiBusy: ref(false),
    aiFillBlockReason: ref(''),
    draftRevision: ref<number | null>(4),
    activeTemplateId: ref('template'),
    props: { projectId: 'project', workflowRunId: 'run' },
    currentWorkspaceScope: ref('project:run'),
    flushPendingEdits: vi.fn().mockResolvedValue(true),
    createEffectTemplateMixAiRun: vi.fn().mockResolvedValue({ data: run }),
    aiRuns: ref<unknown[]>([]),
    pollAiRun: vi.fn(),
    loadEffectTemplateMixWorkspace: vi.fn().mockResolvedValue({ data: {} }),
    readMixWorkspaceWithDeadline,
    draftRace: new MixDraftRaceGuard(),
    saveState: ref('saved'),
    pendingSave: undefined,
    installWorkspaceData: vi.fn(() => false),
    load: vi.fn(),
    showNotice: vi.fn(),
  };
  const source = page.split('const startAiFill =')[1]!.split('// The top-level action')[0]!;
  const js = transpileModule(`const start =${source}`, {
    compilerOptions: { target: ScriptTarget.ES2022 },
  }).outputText;
  const start = new Function(...Object.keys(c), `${js}\nreturn start;`)(...Object.values(c));
  return { c, run, start };
}

describe('smart-fill submission feedback precedes network waits', () => {
  it('sets submission flags synchronously before a slow save and blocks duplicate clicks', async () => {
    const { c, start } = harness();
    const save = deferred<boolean>();
    c.flushPendingEdits.mockReturnValue(save.promise);
    const task = start(null);
    expect(c.fillStartPending.value).toBe(true);
    expect(c.mutating.value).toBe(true);
    expect(c.createEffectTemplateMixAiRun).not.toHaveBeenCalled();
    await start(null);
    expect(c.flushPendingEdits).toHaveBeenCalledOnce();
    save.resolve(false);
    await task;
    expect(c.fillStartPending.value).toBe(false);
    expect(c.mutating.value).toBe(false);
    expect(c.createEffectTemplateMixAiRun).not.toHaveBeenCalled();
  });

  it('retains submission feedback while waiting for task creation', async () => {
    const { c, run, start } = harness();
    const accepted = deferred<{ data: typeof run }>();
    c.createEffectTemplateMixAiRun.mockReturnValue(accepted.promise);
    const task = start(null);
    await vi.waitFor(() => expect(c.createEffectTemplateMixAiRun).toHaveBeenCalledOnce());
    expect(c.fillStartPending.value).toBe(true);
    expect(c.aiRuns.value).toEqual([]); // No synthetic task or fake execution percentage.
    accepted.resolve({ data: run });
    await task;
    expect(c.fillStartPending.value).toBe(false);
  });

  it('publishes and polls the actual receipt before a stalled workspace read finishes', async () => {
    const { c, run, start } = harness();
    const workspace = deferred<{ data: object }>();
    c.loadEffectTemplateMixWorkspace.mockReturnValue(workspace.promise);
    const task = start(null);
    await vi.waitFor(() => expect(c.loadEffectTemplateMixWorkspace).toHaveBeenCalledOnce());
    expect(c.aiRuns.value).toEqual([run]);
    expect(c.pollAiRun).toHaveBeenCalledExactlyOnceWith('fill');
    expect(c.installWorkspaceData).not.toHaveBeenCalled();
    expect(c.fillStartPending.value).toBe(false);
    expect(c.mutating.value).toBe(false);
    workspace.resolve({ data: {} });
    await task;
    expect(c.fillStartPending.value).toBe(false);
  });

  it('keeps tracking an accepted fill when the workspace read fails, instead of reporting generation failure', async () => {
    const { c, run, start } = harness();
    c.loadEffectTemplateMixWorkspace.mockRejectedValue(new Error('read failed'));
    await start(null);
    expect(c.aiRuns.value).toEqual([run]);
    expect(c.pollAiRun).toHaveBeenCalledExactlyOnceWith('fill');
    expect(c.load).not.toHaveBeenCalled();
    expect(c.showNotice).toHaveBeenCalledWith(
      expect.stringContaining('智能填充任务已开始'),
      'warning',
    );
  });

  it('does not install a delayed workspace over edits made after task acceptance', async () => {
    const { c, start } = harness();
    const workspace = deferred<{ data: object }>();
    c.loadEffectTemplateMixWorkspace.mockReturnValue(workspace.promise);
    const task = start(null);
    await vi.waitFor(() => expect(c.pollAiRun).toHaveBeenCalledOnce());
    c.draftRace.changed();
    workspace.resolve({ data: {} });
    await task;
    expect(c.installWorkspaceData).not.toHaveBeenCalled();
  });

  it('bounds a stalled post-acceptance read without losing or restarting the task', async () => {
    vi.useFakeTimers();
    try {
      const { c, run, start } = harness();
      c.loadEffectTemplateMixWorkspace.mockReturnValue(new Promise(() => {}));
      const task = start(null);
      await vi.advanceTimersByTimeAsync(0);
      expect(c.fillStartPending.value).toBe(false);
      expect(c.mutating.value).toBe(false);
      await vi.advanceTimersByTimeAsync(30_001);
      await task;
      expect(c.aiRuns.value).toEqual([run]);
      expect(c.createEffectTemplateMixAiRun).toHaveBeenCalledOnce();
      expect(c.pollAiRun).toHaveBeenCalledOnce();
      expect(c.load).not.toHaveBeenCalled();
      expect(c.loadEffectTemplateMixWorkspace.mock.calls[0]?.[2].aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not release a newer submission lock when an old workspace read settles', async () => {
    const { c, start } = harness();
    const workspace = deferred<{ data: object }>();
    c.loadEffectTemplateMixWorkspace.mockReturnValue(workspace.promise);
    const oldTask = start(null);
    await vi.waitFor(() => expect(c.pollAiRun).toHaveBeenCalledOnce());
    c.activeTemplateId.value = 'other-template';
    const accepted = deferred<never>();
    c.createEffectTemplateMixAiRun.mockReturnValue(accepted.promise);
    const newTask = start(null);
    await vi.waitFor(() => expect(c.createEffectTemplateMixAiRun).toHaveBeenCalledTimes(2));
    workspace.resolve({ data: {} });
    await oldTask;
    expect(c.fillStartPending.value).toBe(true);
    expect(c.mutating.value).toBe(true);
    accepted.resolve({ data: { ...harness().run, templateId: 'other-template' } } as never);
    await newTask;
    expect(c.fillStartPending.value).toBe(false);
  });

  it('does not roll polled progress back to the creation receipt after a slow workspace read', async () => {
    const { c, run, start } = harness();
    const workspace = deferred<{ data: object }>();
    c.loadEffectTemplateMixWorkspace.mockReturnValue(workspace.promise);
    c.installWorkspaceData.mockImplementation(() => {
      c.aiRuns.value = [run];
      return true;
    });
    const task = start(null);
    await vi.waitFor(() => expect(c.loadEffectTemplateMixWorkspace).toHaveBeenCalledOnce());
    const polled = { ...run, status: 'RUNNING', progress: 45 };
    c.aiRuns.value = [polled];
    workspace.resolve({ data: {} });
    await task;
    expect(c.aiRuns.value).toEqual([polled]);
  });

  it('clears submission flags without publishing a late receipt into another scope', async () => {
    const { c, run, start } = harness();
    const accepted = deferred<{ data: typeof run }>();
    c.createEffectTemplateMixAiRun.mockReturnValue(accepted.promise);
    const task = start(null);
    await vi.waitFor(() => expect(c.createEffectTemplateMixAiRun).toHaveBeenCalledOnce());
    c.props.projectId = 'other';
    accepted.resolve({ data: run });
    await task;
    expect(c.aiRuns.value).toEqual([]);
    expect(c.pollAiRun).not.toHaveBeenCalled();
    expect(c.fillStartPending.value).toBe(false);
    expect(c.mutating.value).toBe(false);
  });

  it('reuses the existing progress component for pending feedback without a fake detail action', () => {
    expect(page).toContain('v-if="displayedFillRun || fillStartPending"');
    expect(page).toContain(':progress="displayedFillRun?.progress ?? 0"');
    expect(page).toContain("aiStageLabels[displayedFillRun.stage] : '正在提交智能填充'");
    expect(page).toContain(":action-label=\"displayedFillRun ? '查看当前工作流' : ''\"");
  });
});
