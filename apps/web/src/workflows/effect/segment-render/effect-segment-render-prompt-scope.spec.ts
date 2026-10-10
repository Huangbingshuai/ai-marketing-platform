import { describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { ScriptTarget, transpileModule } from 'typescript';
import page from './EffectSegmentRenderNodePage.vue?raw';

function harness() {
  const initial = {
    workflowRunId: 'view-run',
    productId: 'view-product',
    batchId: 'owner-batch',
    batchRevision: 5,
    promptArtifactRevision: 12,
  };
  const context = {
    workspace: ref(initial),
    props: { projectId: 'p', workflowRunId: 'view-run' },
    currentProductId: ref('view-product'),
    nodeActive: true,
    pollController: null,
    pollEpoch: 0,
    operation: ref(null),
    workspaceSynchronizing: ref(false),
    runSynchronizing: ref(false),
    document: { visibilityState: 'visible' },
    pollTimer: undefined,
    getEffectSegmentRenderWorkspace: vi.fn(async () => ({ data: { ...initial } })),
    getEffectSegmentRenderBatch: vi.fn(),
    effectSegmentRenderWorkspaceFromApi: (data: unknown) => data,
    applyWorkspace: vi.fn(),
    schedulePolling: vi.fn(),
    isAbortError: () => false,
    safeMessage: () => '',
    showNotice: vi.fn(),
    setTimeout: vi.fn(),
  };
  const source = `const pollBatch =${page.split('const pollBatch =')[1]!.split('const schedulePolling =')[0]!}`;
  const js = transpileModule(source, {
    compilerOptions: { target: ScriptTarget.ES2022 },
  }).outputText;
  const poll = new Function('context', `with(context) { ${js}; return pollBatch; }`)(
    context,
  ) as () => Promise<void>;
  return { context, poll };
}

describe('render Prompt difference workspace polling', () => {
  it('polls the viewing scope rather than clearing its difference with the ancestor batch', async () => {
    const { context: c, poll } = harness();
    await poll();
    expect(c.getEffectSegmentRenderWorkspace).toHaveBeenCalledWith(
      'p',
      'view-run',
      'view-product',
      expect.any(AbortSignal),
    );
    expect(c.getEffectSegmentRenderBatch).not.toHaveBeenCalled();
    expect(c.applyWorkspace).toHaveBeenCalledWith(c.workspace.value);
  });

  it.each(['prompt', 'batch', 'scope'])(
    'rejects a late %s response and keeps polling',
    async (kind) => {
      const { context: c, poll } = harness();
      const next = { ...c.workspace.value };
      if (kind === 'prompt') next.promptArtifactRevision -= 1;
      if (kind === 'batch') next.batchRevision -= 1;
      if (kind === 'scope') next.workflowRunId = 'other-run';
      c.getEffectSegmentRenderWorkspace.mockResolvedValue({ data: next });
      await poll();
      expect(c.applyWorkspace).not.toHaveBeenCalled();
      expect(c.schedulePolling).toHaveBeenCalled();
    },
  );

  it('accepts a newly confirmed pool selected by the same workspace', async () => {
    const { context: c, poll } = harness();
    const next = { ...c.workspace.value, batchId: 'new-confirmed-pool', batchRevision: 1 };
    c.getEffectSegmentRenderWorkspace.mockResolvedValue({ data: next });
    await poll();
    expect(c.applyWorkspace).toHaveBeenCalledWith(next);
  });

  it('ignores a pending response after the user switches branches', async () => {
    const { context: c, poll } = harness();
    let finish!: (value: { data: typeof c.workspace.value }) => void;
    c.getEffectSegmentRenderWorkspace.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const running = poll();
    c.props.workflowRunId = 'other-run';
    finish({ data: { ...c.workspace.value } });
    await running;
    expect(c.applyWorkspace).not.toHaveBeenCalled();
  });
});

describe('single material refresh context', () => {
  function action() {
    const context = {
      workspace: ref({
        batchId: 'owner-batch',
        batchRevision: 5,
        promptArtifactRevision: 12,
        tasks: [
          { id: 'task', needsUpdate: true, updateKind: 'RENDER', refreshSignature: 'signature' },
        ],
      }),
      props: { projectId: 'p', workflowRunId: 'view-run' },
      currentProduct: ref({ id: 'view-product' }),
      currentProductId: ref('view-product'),
      renderSettingsRevision: ref(3),
      canEditMaterials: ref(false),
      operation: ref<string | null>(null),
      operationController: null,
      validated: ref(true),
      creatingTaskCount: ref<number | null>(null),
      creatingLocalUpdate: ref(false),
      canRetryTask: () => true,
      requestActionConfirmation: vi.fn(async () => true),
      refreshEffectSegmentRenderBatch: vi.fn(async () => ({
        data: {
          noChanges: true,
          batch: { workflowRunId: 'owner-run' },
        },
      })),
      regenerateEffectSegmentRenderTasks: vi.fn(),
      loadCurrentWorkspace: vi.fn(),
      synchronizeWorkflowRun: vi.fn(),
      applyBatch: vi.fn(),
      showNotice: vi.fn(),
      isAbortError: () => false,
      safeMessage: () => '',
    };
    const source = `const retryTask =${page.split('const retryTask =')[1]!.split('const loadPreviewVideo =')[0]!}`;
    const js = transpileModule(source, {
      compilerOptions: { target: ScriptTarget.ES2022 },
    }).outputText;
    const execute = new Function('context', `with(context) { ${js}; return retryTask; }`)(
      context,
    ) as (id: string) => Promise<void>;
    return { context, execute };
  }

  it('sends the current path for a single card and never navigates to the media owner after cancellation of the difference', async () => {
    const { context: c, execute } = action();
    await execute('task');
    expect(c.refreshEffectSegmentRenderBatch).toHaveBeenCalledWith(
      'p',
      'owner-batch',
      expect.objectContaining({
        taskIds: ['task'],
        settingsContext: {
          workflowRunId: 'view-run',
          productId: 'view-product',
          expectedSettingsRevision: 3,
        },
      }),
      expect.any(AbortSignal),
    );
    expect(c.loadCurrentWorkspace).toHaveBeenCalledWith(false);
    expect(c.synchronizeWorkflowRun).not.toHaveBeenCalled();
    expect(c.regenerateEffectSegmentRenderTasks).not.toHaveBeenCalled();
  });

  it('does not submit a confirmation after switching paths', async () => {
    const { context: c, execute } = action();
    c.requestActionConfirmation.mockImplementation(async () => {
      c.props.workflowRunId = 'other-run';
      return true;
    });
    await execute('task');
    expect(c.refreshEffectSegmentRenderBatch).not.toHaveBeenCalled();
  });
});
