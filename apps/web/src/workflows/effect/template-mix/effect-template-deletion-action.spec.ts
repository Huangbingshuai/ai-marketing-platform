import { describe, expect, it, vi } from 'vitest';
import { computed, ref } from 'vue';
import { ScriptTarget, transpileModule } from 'typescript';
import { ApiClientError } from '../../../api/http-client';
import page from './EffectTemplateMixNodePage.vue?raw';
import {
  templateDeletionDestination,
  withoutDeletedMixCatalog,
  withoutDeletedMixTemplates,
} from '../shared/effect-template-deletion';
import { sameEditableMixTemplate } from './effect-template-mix-draft-race';
import { serializeEffectTemplateMixDraft } from './api/effect-template-mix.api';
import { cloneMix } from './effect-template-mix-state';

const hydrateSource = page.slice(
  page.indexOf('const hydrate = ('),
  page.indexOf('const initializeUi ='),
);
const hydrate = new Function(
  'cloneMix',
  `${transpileModule(hydrateSource, {}).outputText}\nreturn hydrate;`,
)(cloneMix);

// Execute the actual SFC action with deferred API/read promises, rather than asserting only text.
function fixture(selected = 'b') {
  const entries = ['a', 'b'].map((id) => ({
    id,
    workspace: { template: { name: id }, variants: [] },
  }));
  const state = {
    controller: new AbortController(),
    sourcePollController: new AbortController(),
    loadedWorkspaceRunId: selected === 'a' ? 'run-a' : 'run-b',
    savedDraftBaseline: { schemaVersion: 1, activeTemplateId: selected, templates: entries },
    saveTimer: undefined,
    deletionContextHandoff: null,
  };
  const context = {
    state,
    deletingTemplateId: ref(''),
    currentWorkspaceScope: ref(`p:${state.loadedWorkspaceRunId}`),
    props: { projectId: 'p', workflowRunId: state.loadedWorkspaceRunId },
    templateDirectoryStatus: ref('READY'),
    templateDirectory: ref({
      entries,
      workflowRunIds: { a: 'run-a', b: 'run-b' },
      pendingAddedMaterialIds: {},
      workspaces: {
        'run-a': { draftRevision: 4, draft: state.savedDraftBaseline },
        'run-b': { draftRevision: 4, draft: state.savedDraftBaseline },
      },
    }),
    requestActionConfirmation: vi.fn().mockResolvedValue(true),
    flushPendingEdits: vi.fn().mockResolvedValue(true),
    draftRevision: ref(4),
    deleteEffectTemplateMix: vi.fn(),
    acceptedTemplateDeletions: new Map(),
    notifyTemplateDeleted: vi.fn(),
    outputSyncChannel: null,
    emit: vi.fn(),
    draftRace: { changed: vi.fn() },
    requestedWorkspaceScope: ref('p:run-a'),
    templateNavigationTarget: ref('p:obsolete'),
    templateNavigationPending: ref(true),
    activeTemplateId: ref(selected),
    catalog: ref(entries),
    uiByTemplate: { a: {}, b: {} },
    committedVersions: { a: 1, b: 1 },
    aiRuns: ref([{ id: 'job-a', templateId: 'a', status: 'RUNNING', operation: 'FILL' }]),
    stopPolling: vi.fn(),
    mutating: ref(false),
    workspaceRevisionFence: { acknowledge: vi.fn() },
    view: ref('EDITOR'),
    saveState: ref('saved'),
    releaseExplicitWorkspaceTarget: vi.fn(),
    rememberWorkbench: vi.fn(),
    selectedTemplateWorkflowRunId: ref<string | null>(null),
    load: vi.fn(() => new Promise(() => {})),
    showNotice: vi.fn(),
    ApiClientError,
    templateDeletionDestination,
    withoutDeletedMixCatalog,
    withoutDeletedMixTemplates,
    sameEditableMixTemplate,
    serializeEffectTemplateMixDraft,
    cloneMix,
    hydrate,
    loadEffectTemplateMixWorkspace: vi.fn().mockResolvedValue({
      data: {
        draftRevision: 7,
        draft: cloneMix(state.savedDraftBaseline),
        materials: [],
      },
    }),
  };
  Object.assign(context, { templateListCatalog: computed(() => context.catalog.value) });
  const source = `const deleteTemplate =${page.split('const deleteTemplate =')[1]!.split('const submitTemplateOnEnter')[0]!}`;
  const js = transpileModule(source, {
    compilerOptions: { target: ScriptTarget.ES2022 },
  }).outputText;
  const action = new Function(
    ...Object.keys(context),
    `with(state) { ${js} return deleteTemplate; }`,
  )(...Object.values(context));
  return { context, state, action, entry: entries[0]! };
}
const receipt = {
  templateId: 'a',
  workflowRunId: 'render',
  status: 'QUEUED',
  draftRevision: 5,
  removedWorkflowRunIds: ['run-a'],
};

describe('nonblocking permanent delete action', () => {
  it('silently retries a stale Run revision once when the confirmed target has not changed', async () => {
    const { context, state, action, entry } = fixture();
    context.deleteEffectTemplateMix
      .mockRejectedValueOnce(new ApiClientError('模板已修改，请刷新后确认删除', 409))
      .mockResolvedValueOnce({ data: { ...receipt, draftRevision: 8 } });
    await action(entry);
    expect(context.loadEffectTemplateMixWorkspace).toHaveBeenCalledExactlyOnceWith('p', 'run-a');
    expect(context.deleteEffectTemplateMix.mock.calls).toEqual([
      ['p', 'run-a', 'a', 4],
      ['p', 'run-a', 'a', 7],
    ]);
    expect(context.requestActionConfirmation).toHaveBeenCalledOnce();
    expect(context.catalog.value.map((e) => e.id)).toEqual(['b']);
    expect(context.showNotice.mock.calls).toEqual([['已提交后台删除，可继续操作其他模板']]);
    expect(context.draftRevision.value).toBe(4); // Never acknowledge a different Run's revision.
    expect(state.savedDraftBaseline.templates.map((e) => e.id)).toEqual(['b']);
  });
  it.each(['remote', 'local'])(
    'preserves a genuinely edited %s target rather than deleting newer content',
    async (side) => {
      const { context, action, entry } = fixture();
      context.deleteEffectTemplateMix.mockRejectedValueOnce(new ApiClientError('模板已修改', 409));
      context.loadEffectTemplateMixWorkspace.mockImplementationOnce(async () => {
        const draft = cloneMix(context.catalog.value);
        if (side === 'remote') draft[0]!.workspace.template.name = '另一页面编辑';
        else context.catalog.value[0]!.workspace.template.name = '本页新编辑';
        return { data: { draftRevision: 7, draft: { templates: draft }, materials: [] } };
      });
      await action(entry);
      expect(context.deleteEffectTemplateMix).toHaveBeenCalledOnce();
      expect(context.notifyTemplateDeleted).not.toHaveBeenCalled();
      expect(context.catalog.value).toHaveLength(2);
      expect(context.showNotice).toHaveBeenCalledWith(
        '目标模板内容已变化，已保留模板，请核对后再确认删除',
        'error',
      );
      expect(context.deletingTemplateId.value).toBe('');
    },
  );
  it.each(['project', 'Run', 'path'])(
    'abandons conflict recovery after switching the %s',
    async (kind) => {
      const { context, action, entry } = fixture();
      context.deleteEffectTemplateMix.mockRejectedValueOnce(new ApiClientError('模板已修改', 409));
      context.loadEffectTemplateMixWorkspace.mockImplementationOnce(async () => {
        if (kind === 'project') context.props.projectId = 'other';
        else if (kind === 'Run') context.currentWorkspaceScope.value = 'p:other';
        else context.templateDirectory.value.workflowRunIds.a = 'other';
        return {
          data: {
            draftRevision: 7,
            draft: cloneMix(context.state.savedDraftBaseline),
            materials: [],
          },
        };
      });
      await action(entry);
      expect(context.deleteEffectTemplateMix).toHaveBeenCalledOnce();
      expect(context.notifyTemplateDeleted).not.toHaveBeenCalled();
      expect(context.catalog.value).toHaveLength(2);
      expect(context.deletingTemplateId.value).toBe('');
    },
  );
  it('does not loop or force a second conflict, and retains independent edits during reread', async () => {
    const { context, action, entry } = fixture();
    context.deleteEffectTemplateMix.mockRejectedValue(new ApiClientError('模板已修改', 409));
    context.loadEffectTemplateMixWorkspace.mockImplementationOnce(async () => {
      context.catalog.value[1]!.workspace.template.name = '其他模板新编辑';
      context.saveState.value = 'dirty';
      return {
        data: {
          draftRevision: 7,
          draft: cloneMix(context.state.savedDraftBaseline),
          materials: [],
        },
      };
    });
    await action(entry);
    expect(context.deleteEffectTemplateMix).toHaveBeenCalledTimes(2);
    expect(context.loadEffectTemplateMixWorkspace).toHaveBeenCalledOnce();
    expect(context.catalog.value[1]!.workspace.template.name).toBe('其他模板新编辑');
    expect(context.saveState.value).toBe('dirty');
    expect(context.notifyTemplateDeleted).not.toHaveBeenCalled();
  });
  it('releases the target on acceptance without awaiting a stalled full workspace refresh', async () => {
    const { context, state, action, entry } = fixture();
    let accept!: (result: unknown) => void;
    context.deleteEffectTemplateMix.mockImplementation(
      () =>
        new Promise((resolve) => {
          accept = resolve;
        }),
    );
    const task = action(entry);
    await vi.waitFor(() => expect(context.deleteEffectTemplateMix).toHaveBeenCalledOnce());
    expect(context.deletingTemplateId.value).toBe('a');
    expect(context.catalog.value).toHaveLength(2);
    accept({ data: receipt });
    await task;
    expect(context.showNotice.mock.calls).toEqual([['已提交后台删除，可继续操作其他模板']]);
    expect(context.load).toHaveBeenCalledOnce(); // Never settles, but cannot own the delete spinner.
    expect(context.deletingTemplateId.value).toBe('');
    expect(context.catalog.value.map((e) => e.id)).toEqual(['b']);
    expect(context.view.value).toBe('EDITOR');
    expect(context.activeTemplateId.value).toBe('b');
    expect(context.templateNavigationPending.value).toBe(false);
    expect(context.mutating.value).toBe(false);
    expect(state.controller.signal.aborted).toBe(true);
    expect(context.emit).toHaveBeenCalledWith(
      'templateDeleted',
      expect.objectContaining({ templateId: 'a' }),
    );
    expect(context.emit).not.toHaveBeenCalledWith('workflowRunChange');
  });
  it('changes only the deleted current selection and acknowledges its exact persisted draft revision', async () => {
    const { context, state, action, entry } = fixture('a');
    context.deleteEffectTemplateMix.mockResolvedValue({ data: receipt });
    await action(entry);
    expect(context.showNotice.mock.calls).toEqual([['已提交后台删除，可继续操作其他模板']]);
    expect(context.selectedTemplateWorkflowRunId.value).toBe('run-b');
    expect(context.activeTemplateId.value).toBe('b');
    expect(context.view.value).toBe('CONFIG');
    expect(context.draftRevision.value).toBe(5);
    expect(state.savedDraftBaseline.templates.map((e) => e.id)).toEqual(['b']);
  });
  it('retains the template on failure and allows the user to retry', async () => {
    const { context, action, entry } = fixture();
    context.deleteEffectTemplateMix.mockRejectedValue(new Error('暂时不可用'));
    await action(entry);
    expect(context.catalog.value).toHaveLength(2);
    expect(context.deletingTemplateId.value).toBe('');
    expect(context.notifyTemplateDeleted).not.toHaveBeenCalled();
    context.deleteEffectTemplateMix.mockResolvedValue({ data: receipt });
    await action(entry);
    expect(context.catalog.value).toHaveLength(1);
  });
  it('does not remove anything on confirmation cancellation or save failure', async () => {
    const { context, action, entry } = fixture();
    context.requestActionConfirmation.mockResolvedValueOnce(false);
    await action(entry);
    context.flushPendingEdits.mockResolvedValueOnce(false);
    await action(entry);
    expect(context.deleteEffectTemplateMix).not.toHaveBeenCalled();
    expect(context.catalog.value).toHaveLength(2);
    expect(context.deletingTemplateId.value).toBe('');
  });
  it('keeps unrelated edits made while the POST was pending and does not mark them saved', async () => {
    const { context, action, entry } = fixture();
    let accept!: (result: unknown) => void;
    context.deleteEffectTemplateMix.mockImplementation(
      () =>
        new Promise((resolve) => {
          accept = resolve;
        }),
    );
    const task = action(entry);
    await vi.waitFor(() => expect(context.deleteEffectTemplateMix).toHaveBeenCalledOnce());
    context.catalog.value[1]!.workspace.template.name = '用户新编辑';
    context.saveState.value = 'dirty';
    accept({ data: receipt });
    await task;
    expect(context.saveState.value).toBe('dirty');
    expect(context.catalog.value[0]!.workspace.template.name).toBe('用户新编辑');
    expect(context.activeTemplateId.value).toBe('b');
  });
  it('does not install an old project response but still publishes its scoped acceptance', async () => {
    const { context, action, entry } = fixture();
    let accept!: (result: unknown) => void;
    context.deleteEffectTemplateMix.mockImplementation(
      () =>
        new Promise((resolve) => {
          accept = resolve;
        }),
    );
    const task = action(entry);
    await vi.waitFor(() => expect(context.deleteEffectTemplateMix).toHaveBeenCalledOnce());
    context.props.projectId = 'other';
    accept({ data: receipt });
    await task;
    expect(context.catalog.value).toHaveLength(2);
    expect(context.notifyTemplateDeleted).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'p' }),
      null,
    );
    expect(context.load).not.toHaveBeenCalled();
  });
  it('does not drag the user back after switching to another template during acceptance', async () => {
    const { context, state, action, entry } = fixture('a');
    let accept!: (result: unknown) => void;
    context.deleteEffectTemplateMix.mockImplementation(
      () =>
        new Promise((resolve) => {
          accept = resolve;
        }),
    );
    const task = action(entry);
    await vi.waitFor(() => expect(context.deleteEffectTemplateMix).toHaveBeenCalledOnce());
    context.props.workflowRunId = 'run-b';
    context.currentWorkspaceScope.value = 'p:run-b';
    state.loadedWorkspaceRunId = 'run-b';
    context.activeTemplateId.value = 'b';
    context.draftRevision.value = 12;
    accept({ data: receipt });
    await task;
    expect(context.activeTemplateId.value).toBe('b');
    expect(context.view.value).toBe('EDITOR');
    expect(context.draftRevision.value).toBe(12);
    expect(context.selectedTemplateWorkflowRunId.value).toBeNull();
    expect(context.catalog.value.map((e) => e.id)).toEqual(['b']);
    expect(context.deletingTemplateId.value).toBe('');
  });
});
