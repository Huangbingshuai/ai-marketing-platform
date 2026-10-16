import { describe, expect, it, vi } from 'vitest';
import {
  computed,
  effectScope,
  nextTick,
  reactive,
  ref,
  shallowReactive,
  toRefs,
  watch,
} from 'vue';
import { transpileModule } from 'typescript';
import page from './EffectTemplateMixNodePage.vue?raw';
import parent from '../source-import/EffectImportNodePage.vue?raw';
import {
  consumeEffectNavigation,
  effectBranchNavigationMatches,
  effectMixHistoryTemplateId,
  type EffectBranchNavigation,
} from '../shared/effect-branch-navigation';
import { mixTemplateCatalogFromWorkspace } from './effect-template-mix-template-catalog';
import { MixDraftRaceGuard } from './effect-template-mix-draft-race';

const compile = (source: string, context: Record<string, unknown>, result: string) =>
  new Function(
    ...Object.keys(context),
    `${transpileModule(source, {}).outputText}\nreturn ${result};`,
  )(...Object.values(context));

// Execute the page's actual reactive scope/watcher, not a duplicated selection algorithm.
function scopeHarness(editing = false) {
  const scope = effectScope();
  const pageProps = reactive({
    projectId: 'project',
    workflowRunId: editing ? 'edit' : 'published',
    publishedWorkflowRunId: editing ? 'published' : (null as string | null),
  });
  const templateDirectory = ref({
    entries: ['a', 'b', 'c'],
    workflowRunIds: {},
    pendingAddedMaterialIds: {},
    workspaces: {},
  });
  const source = `const selectedTemplateWorkflowRunId =${
    page.split('const selectedTemplateWorkflowRunId =')[1]!.split('const emit = defineEmits')[0]!
  }`;
  const state = scope.run(() =>
    compile(
      source,
      {
        pageProps,
        templateDirectory,
        templateDirectoryStatus: ref('READY'),
        ref,
        computed,
        reactive,
        toRefs,
        watch,
      },
      '{ props, selectedTemplateWorkflowRunId }',
    ),
  ) as {
    props: { projectId: string; workflowRunId: string };
    selectedTemplateWorkflowRunId: { value: string | null };
  };
  return { scope, pageProps, templateDirectory, ...state };
}

function loadHarness() {
  const state = {
    workbenchActive: true,
    controller: null as AbortController | null,
    loadedWorkspaceRunId: 'published',
    focusedBranchTemplate: null,
    explicitWorkspaceTarget: null as {
      projectId: string;
      workflowRunId: string;
      templateId: string;
    } | null,
    lastBranchNavigation: null as EffectBranchNavigation | null,
    lastPreviewTarget: null,
  };
  const context = {
    sourceProjectionEpoch: 0,
    sourceProjectionEpochs: new Map(),
    retainMixTemplateCatalogSources: (incoming: unknown) => incoming,
    packagingTaskWorkspaceScope: '',
    withoutDeletedMixTemplates: <T>(draft: T) => draft,
    withoutDeletedMixCatalog: <T>(directory: T) => directory,
    deletedTemplateIds: () => new Set(),
    peekWorkbench: () => null,
    props: { projectId: 'project', workflowRunId: 'published', branchTemplateId: null },
    requestedWorkspaceScope: { value: null },
    installedWorkspaceScope: { value: 'project:published' },
    pageState: { value: 'READY' },
    saveState: { value: 'saved' },
    draftRace: { readToken: () => 1, canInstall: vi.fn(() => true) },
    stopPolling: vi.fn(),
    flushPendingEdits: vi.fn(async () => true),
    readMixWorkspaceWithDeadline: async (
      read: (signal: AbortSignal) => Promise<unknown>,
      c: AbortController,
    ) => read(c.signal),
    loadEffectTemplateMixWorkspace: vi.fn(async () => ({
      data: { draft: { templates: [] }, aiRuns: [] },
    })),
    getEffectWorkflowBranchTree: vi.fn(async () => ({ data: {} })),
    readMixTemplateCatalog: vi.fn(async () => ({ entries: ['a', 'b', 'c'] })),
    installWorkspaceData: vi.fn(() => true),
    templateDirectory: { value: { entries: ['old'] } },
    templateDirectoryStatus: { value: 'LOADING' },
    catalog: { value: [] },
    aiRuns: { value: [] },
    activeTemplateId: { value: '' },
    templateNavigationTarget: { value: null },
    templateNavigationPending: { value: false },
    errorMessage: { value: '' },
    view: { value: 'CONFIG' },
    uiByTemplate: {},
    takeWorkbench: vi.fn(() => null),
    scheduleSave: vi.fn(),
    applyBranchNavigation: vi.fn(),
    applyPreviewTarget: vi.fn(),
    pollAiRun: vi.fn(),
    refreshBackgroundAiRun: vi.fn(),
    resumeDeferredFill: vi.fn(),
    showNotice: vi.fn(),
    updateSourceProjects: vi.fn(),
    pageProps: {
      branchNavigation: null as EffectBranchNavigation | null,
      previewTarget: null as null | {
        projectId: string;
        workflowRunId: string;
        templateId: string;
        variantId: string;
      },
    },
    templateContextWorkflowRunId: ref('published'),
    effectBranchNavigationMatches,
    effectMixHistoryTemplateId,
    mixTemplateCatalogFromWorkspace,
    mixTemplateCatalogTargetRun: vi.fn(() => 'other-run'),
    currentMixTemplateWorkspace: vi.fn(
      () => null as null | { workflowRunId: string; workspace: unknown },
    ),
    selectedTemplateWorkflowRunId: ref<string | null>(null),
    rememberWorkbench: vi.fn(),
    cloneMix: <T>(value: T): T => structuredClone(value),
  };
  const source = `const load =${
    page.split('const load =')[1]!.split('/** Read authoritative freshness')[0]!
  }`;
  const execute = compile(
    `with (state) { ${source} return load; }`,
    { state, ...context },
    'undefined',
  ) as () => Promise<void>;
  return { state, context, execute };
}

describe('mix templates survive upstream isolation editing', () => {
  it.each([false, true])(
    'publishes the read-only directory after installation advances the draft epoch (editing=%s)',
    async (editing) => {
      const h = loadHarness();
      const guard = new MixDraftRaceGuard();
      h.context.draftRace.readToken = () => guard.readToken();
      h.context.draftRace.canInstall.mockImplementation((...args: unknown[]) =>
        guard.canInstall(args[0] as number, args[1] as boolean),
      );
      h.context.mixTemplateCatalogTargetRun.mockReturnValue('published');
      h.context.loadEffectTemplateMixWorkspace.mockResolvedValue({
        data: { draft: { templates: [], activeTemplateId: '' }, aiRuns: [] },
      } as never);
      h.context.installWorkspaceData.mockImplementation(() => {
        guard.changed();
        return true;
      });
      let release!: (value: { entries: string[] }) => void;
      h.context.readMixTemplateCatalog.mockImplementation(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );
      await h.execute();
      expect(h.context.installWorkspaceData).toHaveBeenCalledTimes(1);
      expect(h.context.templateDirectoryStatus.value).toBe('LOADING');
      if (editing) {
        guard.changed();
        h.context.saveState.value = 'dirty';
      }
      release({ entries: ['a', 'b', 'c'] });
      await vi.waitFor(() => expect(h.context.templateDirectoryStatus.value).toBe('READY'));
      expect(h.context.templateDirectory.value.entries).toEqual(['a', 'b', 'c']);
      expect(h.context.installWorkspaceData).toHaveBeenCalledTimes(1);
      expect(h.context.saveState.value).toBe(editing ? 'dirty' : 'saved');
    },
  );
  it.each(['project', 'run', 'cancelled', 'hidden'] as const)(
    'ignores a late background directory after %s changes',
    async (change) => {
      const h = loadHarness();
      h.context.mixTemplateCatalogTargetRun.mockReturnValue('published');
      let release!: (value: { entries: string[] }) => void;
      h.context.readMixTemplateCatalog.mockImplementation(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );
      await h.execute();
      if (change === 'project') h.context.props.projectId = 'other';
      if (change === 'run') h.context.props.workflowRunId = 'history';
      if (change === 'cancelled') h.state.controller!.abort();
      if (change === 'hidden') h.state.workbenchActive = false;
      release({ entries: ['late'] });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(h.context.templateDirectoryStatus.value).toBe('LOADING');
      expect(h.context.templateDirectory.value.entries).toEqual(['old']);
      expect(h.context.installWorkspaceData).toHaveBeenCalledTimes(1);
    },
  );
  it('allows retry after a background directory failure without reusing the failed request', async () => {
    const h = loadHarness();
    h.context.mixTemplateCatalogTargetRun.mockReturnValue('published');
    h.context.readMixTemplateCatalog.mockRejectedValueOnce(new Error('目录超时'));
    await h.execute();
    await vi.waitFor(() => expect(h.context.templateDirectoryStatus.value).toBe('ERROR'));
    expect(h.context.pageState.value).toBe('READY');
    await h.execute();
    await vi.waitFor(() => expect(h.context.templateDirectoryStatus.value).toBe('READY'));
    expect(h.context.templateDirectory.value.entries).toEqual(['a', 'b', 'c']);
  });
  it('acknowledges old navigation at the parent so a fresh component cannot resurrect it', () => {
    const target: EffectBranchNavigation = {
      projectId: 'project',
      workflowRunId: 'history',
      nodeId: 'TEMPLATE_MIX',
      templateId: 'a',
      mixStage: 'PACKAGING',
    };
    const preview = {
      projectId: 'project',
      workflowRunId: 'history',
      templateId: 'a',
      variantId: 'old-film',
    };
    const pageProps = {
      branchNavigation: target as EffectBranchNavigation | null,
      previewTarget: preview as typeof preview | null,
    };
    const state = {
      explicitWorkspaceTarget: target as unknown,
      lastBranchNavigation: null,
      lastPreviewTarget: null,
    };
    const emit = (event: string, consumed: unknown) => {
      if (event === 'navigationConsumed')
        pageProps.branchNavigation = consumeEffectNavigation(
          pageProps.branchNavigation,
          consumed as EffectBranchNavigation,
        );
      else
        pageProps.previewTarget = consumeEffectNavigation(
          pageProps.previewTarget,
          consumed as typeof preview,
        );
    };
    const source = `const releaseExplicitWorkspaceTarget =${
      page.split('const releaseExplicitWorkspaceTarget =')[1]!.split('};')[0]!
    }};`;
    const release = compile(
      `with (state) { ${source} return releaseExplicitWorkspaceTarget; }`,
      { state, pageProps, emit },
      'undefined',
    ) as () => void;
    release();
    expect(state.explicitWorkspaceTarget).toBeNull();
    expect(pageProps.branchNavigation).toBeNull();
    expect(pageProps.previewTarget).toBeNull();
    expect(
      effectMixHistoryTemplateId(pageProps.branchNavigation, 'project', 'history', 'EDITOR', true),
    ).toBeNull();
  });
  it('cold-opens on the published source rather than the empty edit Run', () => {
    const h = scopeHarness(true);
    expect(h.props.workflowRunId).toBe('published');
    expect(h.pageProps.workflowRunId).toBe('edit');
    h.scope.stop();
  });
  it('retains all templates and local selection on entering and cancelling an upstream edit', async () => {
    const h = scopeHarness();
    h.selectedTemplateWorkflowRunId.value = 'template-b-current';
    h.pageProps.workflowRunId = 'edit';
    h.pageProps.publishedWorkflowRunId = 'published';
    await nextTick();
    expect(h.props.workflowRunId).toBe('template-b-current');
    expect(h.templateDirectory.value.entries).toEqual(['a', 'b', 'c']);
    h.pageProps.workflowRunId = 'published';
    h.pageProps.publishedWorkflowRunId = null;
    await nextTick();
    expect(h.props.workflowRunId).toBe('template-b-current');
    expect(h.templateDirectory.value.entries).toEqual(['a', 'b', 'c']);
    h.scope.stop();
  });
  it.each(['saved-new-source', 'manual-copy'])(
    'reloads a genuinely different published context: %s',
    async (run) => {
      const h = scopeHarness(true);
      h.selectedTemplateWorkflowRunId.value = 'template-b-current';
      h.pageProps.workflowRunId = run;
      h.pageProps.publishedWorkflowRunId = null;
      await nextTick();
      expect(h.props.workflowRunId).toBe(run);
      expect(h.templateDirectory.value.entries).toEqual([]);
      h.scope.stop();
    },
  );
  it('does not retain templates across projects even with an equal Run label', async () => {
    const h = scopeHarness(true);
    h.pageProps.projectId = 'other';
    await nextTick();
    expect(h.templateDirectory.value.entries).toEqual([]);
    h.scope.stop();
  });
  it('does not load or install workspace data while the KeepAlive page is hidden', async () => {
    const h = loadHarness();
    h.state.workbenchActive = false;
    await h.execute();
    expect(h.context.loadEffectTemplateMixWorkspace).not.toHaveBeenCalled();
    expect(h.context.installWorkspaceData).not.toHaveBeenCalled();
  });
  it('installs only after the complete directory succeeds, including unchanged Run reloads', async () => {
    const h = loadHarness();
    h.context.readMixTemplateCatalog.mockImplementation(async () => {
      expect(h.context.installWorkspaceData).not.toHaveBeenCalled();
      return { entries: ['a', 'b', 'c'] };
    });
    await h.execute();
    expect(h.context.installWorkspaceData).toHaveBeenCalledOnce();
    expect(h.context.templateDirectory.value.entries).toEqual(['a', 'b', 'c']);
  });
  it('installs the current Run before the read-only historical directory finishes', async () => {
    const h = loadHarness();
    h.context.mixTemplateCatalogTargetRun.mockReturnValue('published');
    let finishDirectory!: (value: { entries: string[] }) => void;
    h.context.readMixTemplateCatalog.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishDirectory = resolve;
        }),
    );
    await h.execute();
    expect(h.context.installWorkspaceData).toHaveBeenCalledOnce();
    expect(h.context.pageState.value).toBe('READY');
    expect(h.context.templateDirectoryStatus.value).toBe('LOADING');
    finishDirectory({ entries: ['a', 'b', 'c'] });
    await vi.waitFor(() =>
      expect(h.context.templateDirectory.value.entries).toEqual(['a', 'b', 'c']),
    );
  });
  it('resolves the pending card’s template before a stale draft active-template selection', async () => {
    const h = loadHarness();
    h.context.activeTemplateId.value = 'other';
    h.context.pageProps.previewTarget = {
      projectId: 'project',
      workflowRunId: 'published',
      templateId: 'a',
      variantId: 'film',
    };
    await h.execute();
    expect(h.context.currentMixTemplateWorkspace).toHaveBeenCalledWith(
      expect.anything(),
      'a',
      'published',
      { explicit: true, running: false },
    );
    expect(h.context.applyPreviewTarget).toHaveBeenCalledOnce();
  });
  it('does not replace the visible workspace if directory reading fails', async () => {
    const h = loadHarness();
    h.context.readMixTemplateCatalog.mockRejectedValue(new Error('读取失败'));
    await h.execute();
    expect(h.context.installWorkspaceData).not.toHaveBeenCalled();
    expect(h.context.templateDirectory.value.entries).toEqual(['old']);
    expect(h.context.pageState.value).toBe('READY');
    expect(h.context.showNotice).toHaveBeenCalledWith(
      '后台同步暂未完成，当前工作台和编辑已保留，将继续读取任务进度',
      'warning',
    );
  });
  it('reroutes a normal open editor to the current directory without installing its cached snapshot', async () => {
    const h = loadHarness();
    h.context.view.value = 'EDITOR';
    h.context.currentMixTemplateWorkspace.mockReturnValue({
      workflowRunId: 'old-child',
      workspace: {},
    });
    await h.execute();
    expect(h.context.installWorkspaceData).not.toHaveBeenCalled();
    expect(h.context.selectedTemplateWorkflowRunId.value).toBe('old-child');
    expect(h.context.rememberWorkbench).toHaveBeenCalledOnce();
    expect(h.state.loadedWorkspaceRunId).toBe('published');
  });
  it('restores the current workspace on the same Run after exiting a consumed historical destination', async () => {
    const h = loadHarness();
    h.context.activeTemplateId.value = 'a';
    const navigation: EffectBranchNavigation = {
      projectId: 'project',
      workflowRunId: 'published',
      nodeId: 'TEMPLATE_MIX',
      templateId: 'a',
      mixStage: 'PACKAGING',
    };
    h.context.pageProps.branchNavigation = h.state.lastBranchNavigation = navigation;
    const current = { draft: { activeTemplateId: 'a', templates: [{ id: 'a', count: 13 }] } };
    h.context.currentMixTemplateWorkspace.mockReturnValue({
      workflowRunId: 'updated',
      workspace: current,
    });
    await h.execute();
    expect(h.context.installWorkspaceData).not.toHaveBeenCalled();
    expect(h.context.selectedTemplateWorkflowRunId.value).toBe('updated');
    expect(h.state.loadedWorkspaceRunId).toBe('published'); // Only the scoped loader can install updated.
    expect(h.context.activeTemplateId.value).toBe('a');
    expect(h.context.readMixTemplateCatalog.mock.calls[0]).toHaveLength(5); // Never pin the list.
  });
  it.each(['FILL', 'PACKAGING'] as const)(
    'keeps a pending explicit %s editor on history while its directory stays current',
    async (mixStage) => {
      const h = loadHarness();
      h.context.activeTemplateId.value = 'a';
      h.context.pageProps.branchNavigation = {
        projectId: 'project',
        workflowRunId: 'published',
        nodeId: 'TEMPLATE_MIX',
        templateId: 'a',
        mixStage,
      };
      await h.execute();
      expect(h.context.currentMixTemplateWorkspace).toHaveBeenCalledWith(
        expect.anything(),
        'a',
        'published',
        { explicit: true, running: false },
      );
      expect(h.context.selectedTemplateWorkflowRunId.value).toBeNull();
      expect(h.context.installWorkspaceData).toHaveBeenCalledWith(
        (await h.context.loadEffectTemplateMixWorkspace()).data,
        'project:published',
      );
      expect(h.context.readMixTemplateCatalog.mock.calls[0]).toHaveLength(5);
    },
  );
  it('treats a tree template destination as current configuration even from an old editor', async () => {
    const h = loadHarness();
    h.context.view.value = 'EDITOR';
    h.context.activeTemplateId.value = 'a';
    h.context.pageProps.branchNavigation = {
      projectId: 'project',
      workflowRunId: 'published',
      nodeId: 'TEMPLATE_MIX',
      templateId: 'a',
      mixStage: 'TEMPLATE',
    };
    h.context.currentMixTemplateWorkspace.mockReturnValue({
      workflowRunId: 'updated',
      workspace: { count: 13 },
    });
    await h.execute();
    expect(h.context.selectedTemplateWorkflowRunId.value).toBe('updated');
    expect(h.context.installWorkspaceData).not.toHaveBeenCalled();
    expect(h.context.view.value).toBe('CONFIG');
  });
  it.each([true, false])(
    'flushes the history editor before returning to current configuration (saved=%s)',
    async (saved) => {
      const context = {
        playing: { value: true },
        pauseTimelinePlayers: vi.fn(),
        resetTimelinePlayerState: vi.fn(),
        closeMaterialPreview: vi.fn(),
        stopPlaybackClock: vi.fn(),
        transitionFrame: { value: 'frame' },
        view: { value: 'EDITOR' },
        load: vi.fn(),
        releaseExplicitWorkspaceTarget: vi.fn(),
        flushPendingEdits: vi.fn(async () => {
          expect(context.view.value).toBe('EDITOR');
          expect(context.load).not.toHaveBeenCalled();
          return saved;
        }),
        syncOutputOnExit: vi.fn(async () => saved),
      };
      const source = `const leaveEditor =${page.split('const leaveEditor =')[1]!.split('const selectSlot =')[0]!}`;
      await (compile(source, context, 'leaveEditor') as () => Promise<void>)();
      expect(context.view.value).toBe(saved ? 'CONFIG' : 'EDITOR');
      expect(context.load).toHaveBeenCalledTimes(saved ? 1 : 0);
      expect(context.flushPendingEdits).toHaveBeenCalledOnce();
      expect(context.syncOutputOnExit).not.toHaveBeenCalled();
    },
  );
  it('returns after the draft saves even while pending-output synchronization is unresolved', async () => {
    let completeSave!: (saved: boolean) => void;
    let completeOutput!: (saved: boolean) => void;
    const draftSave = new Promise<boolean>((resolve) => {
      completeSave = resolve;
    });
    const outputSync = new Promise<boolean>((resolve) => {
      completeOutput = resolve;
    });
    const context = {
      playing: ref(true),
      pauseTimelinePlayers: vi.fn(),
      resetTimelinePlayerState: vi.fn(),
      closeMaterialPreview: vi.fn(),
      stopPlaybackClock: vi.fn(),
      transitionFrame: ref('frame'),
      view: ref('EDITOR'),
      load: vi.fn(async () => {}),
      releaseExplicitWorkspaceTarget: vi.fn(),
      flushPendingEdits: vi.fn(() => draftSave),
      syncOutputOnExit: vi.fn(() => outputSync),
    };
    const source = `const leaveEditor =${page.split('const leaveEditor =')[1]!.split('const selectSlot =')[0]!}`;
    const leaving = (compile(source, context, 'leaveEditor') as () => Promise<void>)();
    expect(context.view.value).toBe('EDITOR');
    expect(context.load).not.toHaveBeenCalled();
    completeSave(true);
    await Promise.resolve();
    await Promise.resolve();
    const returnedBeforeOutputSync = context.view.value === 'CONFIG';
    completeOutput(true);
    await leaving;
    expect(returnedBeforeOutputSync).toBe(true);
    expect(context.load).toHaveBeenCalledOnce();
    expect(context.syncOutputOnExit).not.toHaveBeenCalled();
  });
  it('keeps only the configuration return button even for output previews', () => {
    expect(page).not.toContain('返回成片输出');
    expect(page).not.toContain('returnToFinalOutput');
    expect(page).toContain('<button class="button" @click="leaveEditor">返回模板配置</button>');
  });
  it.each(['FILL', 'PACKAGING'] as const)(
    'consumes %s navigation once and releases it on config entry',
    async (mixStage) => {
      const target: EffectBranchNavigation = {
        projectId: 'project',
        workflowRunId: 'history',
        nodeId: 'TEMPLATE_MIX',
        templateId: 'a',
        mixStage,
      };
      const pageProps = shallowReactive({
        branchNavigation: target,
        projectId: 'project',
        workflowRunId: 'history',
      });
      const props = reactive({ ...toRefs(pageProps) });
      const state = {
        lastBranchNavigation: null as EffectBranchNavigation | null,
        explicitWorkspaceTarget: null as unknown,
        branchNavigationReloading: false,
        workbenchActive: true,
      };
      const context = {
        pageProps,
        props,
        effectBranchNavigationMatches,
        templateContextWorkflowRunId: ref('history'),
        pageState: ref('READY'),
        installedWorkspaceScope: ref('project:history'),
        currentWorkspaceScope: ref('project:history'),
        selectedTemplateWorkflowRunId: ref(null),
        workflowDialogOpen: ref(false),
        catalog: ref([{ id: 'a' }]),
        view: ref('CONFIG'),
        focusBranchTemplate: vi.fn(),
        enterEditor: vi.fn(),
        nextTick,
        openPackaging: vi.fn(),
        emit: vi.fn(),
        openWorkflowDialog: vi.fn(),
        showNotice: vi.fn(),
        load: vi.fn(),
        activeTemplateId: ref('a'),
      };
      const source = `const applyBranchNavigation =${
        page.split('const applyBranchNavigation =')[1]!.split('let lastPreviewTarget:')[0]!
      }`;
      const execute = compile(
        `with (state) { ${source} return applyBranchNavigation; }`,
        { state, ...context },
        'undefined',
      ) as () => Promise<void>;
      await execute();
      expect(context.enterEditor).toHaveBeenCalledOnce();
      expect(context.emit).toHaveBeenCalledWith('navigationConsumed', target);
      expect(state.lastBranchNavigation).toBe(pageProps.branchNavigation);
      expect(
        effectMixHistoryTemplateId(
          pageProps.branchNavigation,
          'project',
          'history',
          'CONFIG',
          pageProps.branchNavigation !== state.lastBranchNavigation,
        ),
      ).toBeNull();
      await execute();
      expect(context.enterEditor).toHaveBeenCalledOnce();
    },
  );
  it('uses a normal awaited save for large drafts before navigation, reserving keepalive for teardown', async () => {
    const context = {
      saveState: ref('dirty'),
      saveTimer: undefined,
      pendingSave: null as Promise<boolean> | null,
      persist: vi.fn(async () => true),
      finishVideoWheelGesture: vi.fn(),
    };
    const source = `const flushPendingEdits =${page.split('const flushPendingEdits =')[1]!.split('const onEscape =')[0]!}`;
    const execute = compile(
      `with (context) { ${source} return flushPendingEdits; }`,
      { context },
      'undefined',
    ) as () => Promise<boolean>;
    expect(await execute()).toBe(true);
    expect(context.persist).toHaveBeenCalledWith();
    expect(page.split('onBeforeUnmount(() => {')[1]).toContain(
      "if (saveState.value === 'dirty') void persist(true)",
    );
  });
  it.each(['hidden', 'aborted', 'other-project', 'dirty'] as const)(
    'rejects a directory result that became %s',
    async (change) => {
      const h = loadHarness();
      h.context.readMixTemplateCatalog.mockImplementation(async () => {
        if (change === 'hidden') h.state.workbenchActive = false;
        if (change === 'aborted') h.state.controller!.abort();
        if (change === 'other-project') h.context.props.projectId = 'other';
        if (change === 'dirty') h.context.draftRace.canInstall.mockReturnValue(false);
        return { entries: ['a', 'b', 'c'] };
      });
      await h.execute();
      expect(h.context.installWorkspaceData).not.toHaveBeenCalled();
      expect(h.context.templateDirectory.value.entries).toEqual(['old']);
    },
  );
  it('wires the published context, aborts hidden reads and reuses an installed same-Run workspace', () => {
    expect(parent).toMatch(
      /:published-workflow-run-id="[\s\S]*?activeWorkflowRun\?\.isTemporaryBranch/,
    );
    const hidden = page.split('onDeactivated(() => {')[1]!.split('onBeforeUnmount')[0]!;
    expect(hidden).toContain('controller?.abort()');
    expect(page).toContain(
      'if (requestedWorkspaceScope.value !== currentWorkspaceScope.value) await load()',
    );
    expect(page).toContain("pageState.value === 'READY'");
    expect(page).toContain('void refreshMaterialSources()');
    expect(page).toContain('SOURCE_POLL_INTERVAL_MS = 15_000');
    expect(page).not.toContain('requestedWorkspaceRunId');
  });
});
