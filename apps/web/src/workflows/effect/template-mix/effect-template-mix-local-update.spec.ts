import { describe, expect, it, vi } from 'vitest';
import { transpileModule } from 'typescript';
import { computed, ref } from 'vue';
import page from './EffectTemplateMixNodePage.vue?raw';
import {
  createMixLocalUpdateProgressTracker,
  mixLocalUpdateProgress,
} from './effect-template-mix-operation-progress';

const frozenOperation = {
  sourceOperationHasAdditions: true,
  sourceOperationId: 'frozen-operation',
};

function harness(changed = 0, added = 0) {
  const context = {
    localUpdateBusy: ref(false),
    projectEditLocked: ref(false),
    mutating: ref(false),
    activeAiRun: ref(null),
    packagingInFlight: ref(false),
    backgroundAiBusy: ref(false),
    localUpdateStarting: ref(false),
    activeTemplateId: ref('template'),
    activeEntry: ref({ id: 'template' }),
    pendingAddedCount: ref(added),
    props: { projectId: 'project', workflowRunId: 'workflow' },
    openTemplateWorkspace: vi.fn().mockResolvedValue(true),
    installedWorkspaceScope: ref('project:workflow'),
    currentWorkspaceScope: ref('project:workflow'),
    workbenchActive: true,
    view: ref('EDITOR'),
    enterEditor: vi.fn(),
    templatePendingUpdateCount: vi.fn(() => changed),
    updateSourceProjects: vi.fn().mockResolvedValue(undefined),
    startAiFill: vi.fn().mockResolvedValue(undefined),
  };
  const source = page
    .split('async function updateCurrentTemplate(): Promise<void> {')[1]!
    .split('const preparePackaging =')[0]!;
  const script = transpileModule(`async function execute() {${source}`, {}).outputText;
  const execute = new Function(...Object.keys(context), `${script}\nreturn execute;`)(
    ...Object.values(context),
  );
  return { context, execute };
}

describe('one local-update action for additions, replacements and deletions', () => {
  it('freezes additions through the same source operation before APPEND and never starts full refill', async () => {
    const { context: c, execute } = harness(0, 2);
    await execute();
    expect(c.updateSourceProjects).toHaveBeenCalledOnce();
    expect(c.startAiFill).not.toHaveBeenCalled();
    await c.updateSourceProjects.mock.calls[0]![0](frozenOperation);
    expect(c.startAiFill).toHaveBeenCalledExactlyOnceWith(null, false, true, 'frozen-operation');
    expect(c.localUpdateStarting.value).toBe(false);
  });
  it.each(['replacement', 'deletion'])(
    'uses the existing source-update path for %s only',
    async () => {
      const { context: c, execute } = harness(3, 0);
      await execute();
      expect(c.updateSourceProjects).toHaveBeenCalledOnce();
      await c.updateSourceProjects.mock.calls[0]![0]({ sourceOperationHasAdditions: false });
      expect(c.startAiFill).not.toHaveBeenCalled();
    },
  );
  it('updates old films first and starts APPEND only after successful source update', async () => {
    const { context: c, execute } = harness(3, 2);
    await execute();
    expect(c.startAiFill).not.toHaveBeenCalled(); // Confirmation cancelled or task failed: no continuation.
    const afterSuccess = c.updateSourceProjects.mock.calls[0]![0];
    await afterSuccess(frozenOperation);
    expect(c.startAiFill).toHaveBeenCalledExactlyOnceWith(null, false, true, 'frozen-operation');
  });
  it.each([
    { sourceOperationHasAdditions: true },
    { sourceOperationHasAdditions: false, sourceOperationId: 'frozen-operation' },
  ])('does not append without a confirmed frozen addition set: %j', async (run) => {
    const { context: c, execute } = harness(3, 2);
    await execute();
    await c.updateSourceProjects.mock.calls[0]![0](run);
    expect(c.startAiFill).not.toHaveBeenCalled();
  });
  it.each(['project', 'workflow', 'template'])(
    'does not continue into a different %s scope',
    async (scope) => {
      const { context: c, execute } = harness(3, 2);
      await execute();
      if (scope === 'project') c.props.projectId = 'other';
      if (scope === 'workflow') c.props.workflowRunId = 'other';
      if (scope === 'template') c.activeTemplateId.value = 'other';
      await c.updateSourceProjects.mock.calls[0]![0](frozenOperation);
      expect(c.startAiFill).not.toHaveBeenCalled();
    },
  );
  it('does not start an update during a busy task or uninstalled workspace', async () => {
    const { context: c, execute } = harness(3, 2);
    c.localUpdateBusy.value = true;
    await execute();
    expect(c.openTemplateWorkspace).not.toHaveBeenCalled();
    c.localUpdateBusy.value = false;
    c.installedWorkspaceScope.value = 'project:other';
    await execute();
    expect(c.updateSourceProjects).not.toHaveBeenCalled();
    expect(c.startAiFill).not.toHaveBeenCalled();
    expect(c.localUpdateStarting.value).toBe(false);
  });
  it('updates the opened Run without jumping to a cached directory branch', async () => {
    const { context: c, execute } = harness(0, 2);
    await execute();
    expect(c.openTemplateWorkspace).not.toHaveBeenCalled();
    expect(c.props.workflowRunId).toBe('workflow');
    await c.updateSourceProjects.mock.calls[0]![0](frozenOperation);
    expect(c.startAiFill).toHaveBeenCalledExactlyOnceWith(null, false, true, 'frozen-operation');
  });
  it('restores a local-update handoff through the unified action, never source-only orchestration', () => {
    const recovery = page
      .split("handoff?.action === 'SOURCE_UPDATE'")[1]!
      .split('for (const run of running')[0]!;
    expect(recovery).toContain('void updateCurrentTemplate()');
    expect(recovery).not.toContain('void updateSourceProjects()');
  });
  it('preserves only explicit history or in-flight work, never the obsolete editor visual mode', () => {
    expect(page).not.toContain("view.value === 'CONFIG' || configNavigation");
    expect(page).toContain(
      'explicit: historyTemplateId === initialTemplateId || previewTemplateId === initialTemplateId',
    );
    expect(page).toContain('running: runningOnTemplate');
  });
  it('chooses a single progress display for starting, source updates and APPEND, hiding at completion', () => {
    const context = {
      computed,
      mixLocalUpdateProgress,
      trackLocalUpdateProgress: createMixLocalUpdateProgressTracker(),
      props: { projectId: 'project', workflowRunId: 'run' },
      completedAppendRun: ref(null),
      sourceUpdateHandoff: ref(false),
      pendingAppendContinuation: ref(false),
      sourceUpdateBusy: ref(false),
      sourceUpdateProgress: ref(40),
      sourceUpdateRun: ref({
        status: 'RUNNING',
        items: [
          { id: 'one', status: 'COMPLETED' },
          { id: 'two', status: 'RUNNING' },
        ],
      }),
      sourceUpdateItemIds: ref(['one', 'two']),
      sourceUpdateStarting: ref(false),
      appendProgress: ref<{ progress: number } | null>(null),
      activeAppendRun: ref(null),
      activeAppendPackaging: ref(null),
      autoPackagingTemplateIds: ref([]),
      activeTemplateId: ref('template'),
      localUpdateStarting: ref(false),
      mutating: ref(false),
    };
    const source = page
      .split('const localUpdateProgress =')[1]!
      .split('const workspaceTaskLocked =')[0]!;
    const script = transpileModule(`const progress =${source}`, {}).outputText;
    const progress = new Function(...Object.keys(context), `${script}\nreturn progress;`)(
      ...Object.values(context),
    );
    expect(progress.value).toBeNull();
    context.localUpdateStarting.value = true;
    expect(progress.value).toBeNull(); // Awaiting confirmation is not a task.
    context.mutating.value = true;
    expect(progress.value.progress).toBe(0);
    context.sourceUpdateBusy.value = true;
    expect(progress.value.progress).toBe(40);
    expect(progress.value.detail).toBe('正在更新成片工程 · 已完成 1/2');
    context.appendProgress.value = { progress: 65 };
    expect(progress.value.progress).toBe(40);
    context.sourceUpdateBusy.value = false;
    expect(progress.value.progress).toBe(65);
    context.localUpdateStarting.value = false;
    context.appendProgress.value = null;
    expect(progress.value).toBeNull();
  });
});
