import { describe, expect, it, vi } from 'vitest';
import { computed, reactive, ref } from 'vue';
import { ScriptTarget, transpileModule } from 'typescript';
import page from './EffectTemplateMixNodePage.vue?raw';
import { MixDraftRaceGuard, MixWorkspaceRevisionFence } from './effect-template-mix-draft-race';
import {
  canRetainMixPlayback,
  retainUnchangedMixValue,
} from './effect-template-mix-background-sync';
import { cloneMix, createEffectTemplateMixEntry } from './effect-template-mix-state';
import { serializeEffectTemplateMixDraft } from './api/effect-template-mix.api';

function fixture(realInstall = false) {
  const entry = (id: string) => ({ ...createEffectTemplateMixEntry(id), id });
  const data = (id: string) => ({
    draftRevision: 4,
    draft: { schemaVersion: 1, activeTemplateId: id, templates: [entry(id)] },
    materials: [],
    commits: [],
  });
  const selectedTemplateWorkflowRunId = ref<string | null>('run-a');
  const props = reactive({
    projectId: 'p',
    workflowRunId: computed(() => selectedTemplateWorkflowRunId.value!),
  });
  const state = {
    loadedWorkspaceRunId: 'run-a',
    cachedNavigationScope: null,
    pendingSave: undefined,
    controller: new AbortController(),
    sourcePollController: new AbortController(),
    workbenchActive: true,
    savedDraftBaseline: null,
    draftSaveBlocked: false,
  };
  const context = {
    state,
    props,
    selectedTemplateWorkflowRunId,
    currentWorkspaceScope: computed(() => `p:${props.workflowRunId}`),
    installedWorkspaceScope: ref('p:run-a'),
    requestedWorkspaceScope: ref<string | null>(null),
    mutating: ref(false),
    pageState: ref('READY'),
    projectEditLocked: ref(false),
    runSwitching: ref(false),
    saveState: ref('saved'),
    flushPendingEdits: vi.fn().mockResolvedValue(true),
    templateNavigationPending: ref(false),
    templateNavigationTarget: ref<string | null>(null),
    templateDirectory: ref({
      entries: [entry('a'), entry('b')],
      workflowRunIds: { a: 'run-a', b: 'run-b' },
      workspaces: { 'run-a': data('a'), 'run-b': data('b') },
    }),
    templateListCatalog: ref([entry('a'), entry('b')]),
    catalog: ref([entry('a')]),
    activeTemplateId: ref('a'),
    uiByTemplate: reactive<Record<string, { selectedVariantId: string; selectedSlotId: string }>>(
      {},
    ),
    draftRevision: ref(4),
    sourceMaterials: ref([]),
    renderAspectRatio: ref(null),
    pendingAddedMaterialIds: ref({}),
    autoPackagingTemplateIds: ref([]),
    aiRuns: ref([]),
    classificationPools: ref([]),
    workspaceRevisionFence: new MixWorkspaceRevisionFence(),
    releaseExplicitWorkspaceTarget: vi.fn(),
    cloneMix: (value: unknown) => JSON.parse(JSON.stringify(value)),
    serializeEffectTemplateMixDraft,
    withoutDeletedMixTemplates: (draft: { templates: { id: string }[] }, deleted: Set<string>) => ({
      ...draft,
      templates: draft.templates.filter((e) => !deleted.has(e.id)),
    }),
    deletedTemplateIds: () => new Set<string>(),
    stopPolling: vi.fn(),
    installWorkspaceData: vi.fn(),
    selectTemplate: vi.fn(),
    enterEditor: vi.fn(),
    rememberWorkbench: vi.fn(),
    takeWorkbench: vi.fn(),
    resetWorkbenchDefaults: vi.fn(),
    view: ref('CONFIG'),
    load: vi.fn(),
    showNotice: vi.fn(),
    resetTimelinePlayerState: vi.fn(),
    effectTemplateMixSlotDurationLimit: () => 15,
    renderSlotDurationLimit: ref(15),
    templateCreationReady: ref(true),
    draftRace: new MixDraftRaceGuard(),
    committedVersions: reactive({}),
    normalizeVariantVideoLanes: vi.fn(),
    clearDetachedTransitions: vi.fn(() => false),
    normalizeVariantAudioLanes: vi.fn(),
    scheduleSave: vi.fn(),
    activateTimelineHistoryScope: vi.fn(),
    canRetainMixPlayback,
    retainUnchangedMixValue,
  };
  context.installWorkspaceData.mockImplementation((next) => {
    context.catalog.value = next.draft.templates;
    context.activeTemplateId.value = next.draft.activeTemplateId;
    context.draftRevision.value = next.draftRevision;
    return true;
  });
  if (realInstall) {
    const compile = (source: string, extra = {}) => {
      const js = transpileModule(`const execute =${source}`, {
        compilerOptions: { target: ScriptTarget.ES2022 },
      }).outputText;
      const deps = {
        ...context,
        cloneMix,
        activeUi: computed(() => context.uiByTemplate[context.activeTemplateId.value]),
        selectedVariant: computed(
          () =>
            context.catalog.value
              .find((e) => e.id === context.activeTemplateId.value)
              ?.workspace.variants.find(
                (v) =>
                  v.id === context.uiByTemplate[context.activeTemplateId.value]?.selectedVariantId,
              ) ?? null,
        ),
        ...extra,
      };
      return new Function(...Object.keys(deps), `with(state) { ${js} return execute; }`)(
        ...Object.values(deps),
      );
    };
    const hydrate = compile(page.split('const hydrate =')[1]!.split('const initializeUi =')[0]!);
    const initializeUi = compile(
      page.split('const initializeUi =')[1]!.split('const installWorkspaceData =')[0]!,
    );
    const install = compile(
      page.split('const installWorkspaceData =')[1]!.split('const stopPolling =')[0]!,
      { hydrate, initializeUi },
    );
    context.installWorkspaceData.mockImplementation(install);
  }
  const source = `async function openTemplateWorkspace(${page.split('async function openTemplateWorkspace(')[1]!.split('const selectVariant')[0]!}`;
  const js = transpileModule(source, {
    compilerOptions: { target: ScriptTarget.ES2022 },
  }).outputText;
  const action = new Function(
    ...Object.keys(context),
    `with(state) { ${js} return openTemplateWorkspace; }`,
  )(...Object.values(context));
  return { context, state, action };
}

describe('instant template configuration navigation', () => {
  it('uses the real installer to immediately switch inherited multi-template owner snapshots', async () => {
    const { context: c, state, action } = fixture(true);
    const both = cloneMix([
      ...c.catalog.value,
      c.templateDirectory.value.workspaces['run-b']!.draft.templates[0]!,
    ]);
    c.catalog.value = cloneMix(both);
    c.templateDirectory.value.workspaces['run-a']!.draft.templates = cloneMix(both);
    c.templateDirectory.value.workspaces['run-b']!.draft.templates = cloneMix(both);
    c.templateDirectory.value.workspaces['run-b']!.draft.templates[1]!.workspace.template.name =
      'B 当前配置';
    const first = action('b', 'CONFIG');
    expect(c.activeTemplateId.value).toBe('b');
    expect(
      c.catalog.value.find((e) => e.id === c.activeTemplateId.value)?.workspace.template.name,
    ).toBe('B 当前配置');
    expect(c.installedWorkspaceScope.value).toBe('p:run-b');
    expect(state.loadedWorkspaceRunId).toBe('run-b');
    expect(c.load).not.toHaveBeenCalled();
    await first;
    const back = action('a', 'CONFIG');
    expect(c.activeTemplateId.value).toBe('a');
    expect(c.installedWorkspaceScope.value).toBe('p:run-a');
    expect(c.load).not.toHaveBeenCalled();
    expect(c.flushPendingEdits).not.toHaveBeenCalled();
    expect(c.scheduleSave).not.toHaveBeenCalled();
    await back;
  });
  it('installs the selected owner synchronously without a read, save or global branch activation', async () => {
    const { context: c, state, action } = fixture();
    const task = action('b', 'CONFIG');
    expect(c.activeTemplateId.value).toBe('b'); // Before even awaiting the action.
    expect(c.selectedTemplateWorkflowRunId.value).toBe('run-b');
    expect(c.installedWorkspaceScope.value).toBe('p:run-b');
    expect(c.catalog.value.map((e) => e.id)).toEqual(['b']);
    expect(c.load).not.toHaveBeenCalled();
    expect(c.flushPendingEdits).not.toHaveBeenCalled();
    expect(c.rememberWorkbench).not.toHaveBeenCalled();
    expect(c.templateNavigationPending.value).toBe(false);
    expect(state.controller.signal.aborted).toBe(true);
    await expect(task).resolves.toBe(true);
  });
  it('preserves the last saved edits and exact revision when returning to a template', async () => {
    const { context: c, action } = fixture();
    c.catalog.value[0]!.workspace.template.name = '最新保存的名称';
    c.draftRevision.value = 7;
    await action('b', 'CONFIG');
    await action('a', 'CONFIG');
    expect(c.activeTemplateId.value).toBe('a');
    expect(c.catalog.value[0]!.workspace.template.name).toBe('最新保存的名称');
    expect(c.installWorkspaceData.mock.lastCall?.[0].draftRevision).toBe(7);
    expect(c.load).not.toHaveBeenCalled();
  });
  it('does not block view navigation merely because the old project is task-locked', async () => {
    const { context: c, action } = fixture();
    c.projectEditLocked.value = true;
    await expect(action('b', 'CONFIG')).resolves.toBe(true);
    expect(c.activeTemplateId.value).toBe('b');
  });
  it('allows entering the current workbench to view a running fill without saving or mutating it', async () => {
    const { context: c, action } = fixture();
    c.projectEditLocked.value = true;
    await expect(action('a', 'EDITOR')).resolves.toBe(true);
    expect(c.enterEditor).toHaveBeenCalledOnce();
    expect(c.flushPendingEdits).not.toHaveBeenCalled();
    expect(c.scheduleSave).not.toHaveBeenCalled();
  });
  it('keeps dirty edits on save failure instead of installing another owner', async () => {
    const { context: c, action } = fixture();
    c.saveState.value = 'dirty';
    c.flushPendingEdits.mockResolvedValue(false);
    await expect(action('b', 'CONFIG')).resolves.toBe(false);
    expect(c.activeTemplateId.value).toBe('a');
    expect(c.installWorkspaceData).not.toHaveBeenCalled();
  });
  it('cannot install a former project after an awaited save finishes late', async () => {
    const { context: c, action } = fixture();
    let finish!: (saved: boolean) => void;
    c.saveState.value = 'dirty';
    c.flushPendingEdits.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const task = action('b', 'CONFIG');
    c.props.projectId = 'other';
    finish(true);
    await expect(task).resolves.toBe(false);
    expect(c.installWorkspaceData).not.toHaveBeenCalled();
    expect(c.selectedTemplateWorkflowRunId.value).toBe('run-a');
  });
  it('never reuses a snapshot below an acknowledged revision', async () => {
    const { context: c, action } = fixture();
    c.workspaceRevisionFence.acknowledge('p:run-b', 8);
    await action('b', 'CONFIG');
    expect(c.installWorkspaceData).not.toHaveBeenCalled();
    expect(c.rememberWorkbench).toHaveBeenCalledWith(
      expect.objectContaining({ workflowRunId: 'run-b' }),
    );
  });
  it('cancels an older read during same-Run navigation without scheduling a navigation save', async () => {
    const { context: c, state, action } = fixture();
    c.templateDirectory.value.workflowRunIds.b = 'run-a';
    await expect(action('b', 'CONFIG')).resolves.toBe(true);
    expect(c.selectTemplate).toHaveBeenCalledWith('b', false);
    expect(state.controller.signal.aborted).toBe(true);
    expect(c.load).not.toHaveBeenCalled();
  });
  it('does not switch scope or discard a draft while a mutation is committing', async () => {
    const { context: c, action } = fixture();
    c.mutating.value = true;
    await expect(action('b', 'CONFIG')).resolves.toBe(false);
    expect(c.selectedTemplateWorkflowRunId.value).toBe('run-a');
  });
});
