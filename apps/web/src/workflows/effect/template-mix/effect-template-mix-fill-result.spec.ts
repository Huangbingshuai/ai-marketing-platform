import type {
  EffectTemplateMixAiRun,
  EffectTemplateMixWorkspaceData,
} from '@ai-marketing/contracts';
import { computed, reactive, ref } from 'vue';
import { ScriptTarget, transpileModule } from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import page from './EffectTemplateMixNodePage.vue?raw';
import { mixFillResultReady, type MixFillResultHandoff } from './effect-template-mix-fill-result';
import { createEffectTemplateMixEntry } from './effect-template-mix-state';

const receipt = (): EffectTemplateMixAiRun => ({
  id: 'fill',
  workflowRunId: 'run',
  templateId: 't',
  operation: 'FILL',
  status: 'COMPLETED',
  stage: 'COMPLETED',
  progress: 100,
  targetVariantId: null,
  outputVariantId: 'film',
  outputVariantIds: ['film'],
  errorCode: null,
  errorMessage: null,
  createdAt: '',
  updatedAt: '',
});
function result(): EffectTemplateMixWorkspaceData {
  const entry = createEffectTemplateMixEntry('测试模板');
  entry.id = 't';
  entry.workspace.variants.push({
    id: 'film',
    name: '成片',
    appliedTemplateVersion: 1,
    slots: [],
    bindings: {},
    bindingRevisions: {},
    offsets: {},
    manualSlotIds: [],
    conflictSlotIds: [],
    status: 'CURRENT',
    captions: [],
    subtitleStyle: 'standard',
    bgm: null,
    voice: null,
    originalVolume: 1,
  });
  return {
    draft: { schemaVersion: 1, activeTemplateId: 't', templates: [entry] },
    draftRevision: 5,
    materials: [],
    aiRuns: [receipt()],
    classificationPools: [],
    commits: [
      {
        templateId: 't',
        revision: 1,
        contentHash: 'hash',
        stale: false,
        editVersion: entry.workspace.editVersion,
      },
    ],
  };
}
function execute(source: string, context: Record<string, unknown>) {
  const js = transpileModule(source, {
    compilerOptions: { target: ScriptTarget.ES2022 },
  }).outputText;
  return new Function('state', `with (state) { ${js}\nreturn finishAiRun; }`)(context);
}
function harness() {
  const pending = ref<MixFillResultHandoff[]>([]);
  const context = {
    props: { projectId: 'p', workflowRunId: 'run' },
    currentWorkspaceScope: ref('p:run'),
    workbenchActive: true,
    runSwitching: ref(false),
    activeTemplateId: ref('t'),
    stopPolling: vi.fn(),
    catalog: ref(result().draft.templates),
    flushPendingEdits: vi.fn().mockResolvedValue(true),
    draftRace: { readToken: vi.fn(() => 1), canInstall: vi.fn(() => true) },
    saveState: ref('saved'),
    loadEffectTemplateMixWorkspace: vi.fn().mockResolvedValue({ data: result() }),
    mixFillResultReady,
    retainFillResult: (run: EffectTemplateMixAiRun) => {
      pending.value = [{ projectId: 'p', sourceWorkflowRunId: 'run', run }];
    },
    installWorkspaceData: vi.fn((data: EffectTemplateMixWorkspaceData) => {
      pending.value = pending.value.filter((item) => !mixFillResultReady(item.run, data));
      return true;
    }),
    pollTimers: new Map(),
    setTimeout: vi.fn((callback: () => void) => callback),
    uiByTemplate: { t: { selectedVariantId: '', selectedSlotId: '' } },
    view: ref('EDITOR'),
    resetWorkbenchDefaults: vi.fn(),
    showNotice: vi.fn(),
  };
  const source = `const finishAiRun =${page.split('const finishAiRun =')[1]!.split('const pollAiRun =')[0]!}`;
  return { context, pending, finish: execute(source, context) };
}

describe('smart-fill completion waits for its confirmed editor result', () => {
  it('requires the exact output IDs, terminal receipt, unlocked template and matching commit', () => {
    const data = result();
    expect(mixFillResultReady(receipt(), data)).toBe(true);
    for (const change of [
      (v: typeof data) => {
        v.draft.templates[0]!.aiFillLocked = true;
      },
      (v: typeof data) => {
        v.draft.templates[0]!.workspace.variants = [];
      },
      (v: typeof data) => {
        v.commits = [];
      },
      (v: typeof data) => {
        v.commits[0]!.editVersion += 1;
      },
      (v: typeof data) => {
        v.aiRuns[0]!.status = 'RUNNING';
      },
      (v: typeof data) => {
        v.aiRuns[0]!.workflowRunId = 'other-run';
      },
    ]) {
      const old = result();
      change(old);
      expect(mixFillResultReady(receipt(), old)).toBe(false);
    }
    expect(mixFillResultReady({ ...receipt(), outputVariantIds: ['film', 'missing'] }, data)).toBe(
      false,
    );
  });

  it('supports historical single output identity without mistaking an arbitrary film for the result', () => {
    const { outputVariantIds: _ids, ...legacy } = receipt();
    expect(mixFillResultReady(legacy, result())).toBe(true);
    expect(
      mixFillResultReady({ ...receipt(), outputVariantIds: [], outputVariantId: null }, result()),
    ).toBe(false);
  });

  it('retains the real 100% receipt throughout a slow workspace read and releases it after installation', async () => {
    const { context, pending, finish } = harness();
    let resolve!: (value: { data: EffectTemplateMixWorkspaceData }) => void;
    context.loadEffectTemplateMixWorkspace.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const waiting = finish(receipt());
    await vi.waitFor(() => expect(context.loadEffectTemplateMixWorkspace).toHaveBeenCalledOnce());
    expect(pending.value[0]!.run.progress).toBe(100);
    expect(context.installWorkspaceData).not.toHaveBeenCalled();
    resolve({ data: result() });
    await waiting;
    expect(pending.value).toEqual([]);
    expect(context.uiByTemplate.t.selectedVariantId).toBe('film');
  });

  it('does not install an empty/unconfirmed projection and automatically reads again', async () => {
    const { context, pending, finish } = harness();
    const early = result();
    early.commits = [];
    context.loadEffectTemplateMixWorkspace.mockResolvedValueOnce({ data: early });
    await finish(receipt());
    expect(pending.value).toHaveLength(1);
    expect(context.installWorkspaceData).not.toHaveBeenCalled();
    await context.pollTimers.get('fill')();
    await vi.waitFor(() => expect(context.installWorkspaceData).toHaveBeenCalledOnce());
    expect(pending.value).toHaveLength(0);
  });

  it('automatically recovers a failed completion read, without requesting generation again', async () => {
    const { context, pending, finish } = harness();
    context.loadEffectTemplateMixWorkspace.mockRejectedValueOnce(
      new TypeError('network disconnected'),
    );
    await finish(receipt());
    expect(pending.value).toHaveLength(1);
    expect(context.showNotice).not.toHaveBeenCalled();
    expect(context.setTimeout).toHaveBeenCalledWith(expect.any(Function), 3000);
    await context.pollTimers.get('fill')();
    await vi.waitFor(() => expect(pending.value).toHaveLength(0));
  });

  it.each(['project', 'run', 'deactivated'])(
    'discards a late completion read after %s changes',
    async (scope) => {
      const { context, finish } = harness();
      context.loadEffectTemplateMixWorkspace.mockImplementation(async () => {
        if (scope === 'project') context.props.projectId = 'other';
        if (scope === 'run') context.props.workflowRunId = 'other';
        if (scope === 'deactivated') context.workbenchActive = false;
        return { data: result() };
      });
      await finish(receipt());
      expect(context.installWorkspaceData).not.toHaveBeenCalled();
      expect(context.showNotice).not.toHaveBeenCalled();
    },
  );

  it('retains pending installation through a revision fence conflict, without overwriting local edits', async () => {
    const { context, pending, finish } = harness();
    context.draftRace.canInstall.mockReturnValueOnce(false);
    await finish(receipt());
    expect(pending.value).toHaveLength(1);
    expect(context.installWorkspaceData).not.toHaveBeenCalled();
    await context.pollTimers.get('fill')();
    await vi.waitFor(() => expect(pending.value).toHaveLength(0));
  });

  it('scopes completed-result visibility by project, owner Run and template', () => {
    const fillResultHandoffs = ref<MixFillResultHandoff[]>([
      { projectId: 'p', sourceWorkflowRunId: 'parent', run: receipt() },
    ]);
    const props = reactive({ projectId: 'p', workflowRunId: 'run' });
    const activeTemplateId = ref('t');
    const context = { fillResultHandoffs, props, activeTemplateId, computed };
    const declarations = page
      .split('const pendingFillRun =')[1]!
      .split('const retainFillResult =')[0]!;
    const js = transpileModule(`const pendingFillRun =${declarations}`, {}).outputText;
    const views = new Function(
      ...Object.keys(context),
      `${js};return { pendingFillRun,pendingBackgroundFillRun };`,
    )(...Object.values(context));
    expect(views.pendingFillRun.value?.id).toBe('fill');
    expect(views.pendingBackgroundFillRun.value).toBeNull();
    activeTemplateId.value = 'other';
    expect(views.pendingFillRun.value).toBeNull();
    activeTemplateId.value = 't';
    props.workflowRunId = 'parent';
    expect(views.pendingBackgroundFillRun.value?.id).toBe('fill');
    props.projectId = 'other';
    expect(views.pendingBackgroundFillRun.value).toBeNull();
  });

  it.each(['not-published', 'unconfirmed', 'read-failed', 'ready'])(
    'keeps background regeneration continuous through %s publication coordination',
    async (phase) => {
      const run = { ...receipt(), workflowRunId: 'child' };
      const child = result();
      child.aiRuns = [run];
      if (phase === 'unconfirmed') child.commits = [];
      const context = {
        props: { projectId: 'p', workflowRunId: 'parent' },
        workbenchActive: true,
        activeTemplateId: ref('t'),
        templateNavigationPending: ref(false),
        pageState: ref('READY'),
        openingFillRunId: null,
        backgroundAiGeneration: 1,
        backgroundAiTimer: undefined,
        deferredFillCompletion: null,
        retainFillResult: vi.fn(),
        mixFillResultReady,
        getEffectWorkflowBranchTree: vi.fn().mockResolvedValue({
          data: {
            branches:
              phase === 'not-published'
                ? []
                : [{ workflowRunId: 'child', templates: [{ templateId: 't', fillRevision: 1 }] }],
          },
        }),
        flushPendingEdits: vi.fn().mockResolvedValue(true),
        loadEffectTemplateMixWorkspace: vi.fn().mockResolvedValue({ data: child }),
        activateEffectWorkflowBranch: vi.fn().mockResolvedValue({}),
        rememberWorkbench: vi.fn(),
        emit: vi.fn(),
        showNotice: vi.fn(),
        selectedVariant: ref(null),
        pollBackgroundAiRun: vi.fn(),
        setTimeout: vi.fn((callback: () => void, delay: number) => {
          if (delay === 1500) callback(); // Publication probe; no real timer in this test.
          return 1;
        }),
      };
      if (phase === 'read-failed')
        context.loadEffectTemplateMixWorkspace.mockRejectedValue(new TypeError('offline'));
      const source = `const handleBackgroundFillFinished =${page.split('const handleBackgroundFillFinished =')[1]!.split('const resumeDeferredFill =')[0]!}`;
      const js = transpileModule(source, {
        compilerOptions: { target: ScriptTarget.ES2022 },
      }).outputText;
      const handle = new Function(
        'state',
        `with(state) { ${js};return handleBackgroundFillFinished; }`,
      )(context);
      await handle(run, 'p', 'parent');
      expect(context.retainFillResult).toHaveBeenCalledWith(run, 'p', 'parent');
      expect(context.showNotice).not.toHaveBeenCalled();
      if (phase === 'ready') {
        expect(context.activateEffectWorkflowBranch).toHaveBeenCalledWith('p', 'child');
        expect(context.emit).toHaveBeenCalledWith(
          'workflowRunChange',
          expect.objectContaining({ workflowRunId: 'child' }),
        );
        expect(context.setTimeout).not.toHaveBeenCalled();
      } else {
        expect(context.activateEffectWorkflowBranch).not.toHaveBeenCalled();
        expect(context.setTimeout).toHaveBeenCalledWith(expect.any(Function), 3000);
      }
    },
  );
});
