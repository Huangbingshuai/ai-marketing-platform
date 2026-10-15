import { describe, expect, it, vi } from 'vitest';
import { computed, ref } from 'vue';
import { ScriptTarget, transpileModule } from 'typescript';
import page from './EffectFinalOutputNodePage.vue?raw';
import parent from '../source-import/EffectImportNodePage.vue?raw';
import mix from '../template-mix/EffectTemplateMixNodePage.vue?raw';
import { readTemplateDeleted } from '../shared/effect-template-deletion';

const compile = (source: string, context: Record<string, unknown>, result: string) =>
  new Function(...Object.keys(context), `${transpileModule(source, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText}\nreturn ${result};`)(...Object.values(context));

describe('pending film navigation and current source directory', () => {
  it('opens the exact source engineer without activating or refreshing the global branch', async () => {
    const context = { workspace: ref({ workflowRunId: 'global' }), currentProjectId: ref('project'),
      mixPreviewTarget: ref(null), activeStep: ref(5), activateEffectWorkflowBranch: vi.fn(),
      refreshActiveRunInPlace: vi.fn(), selectWorkflowStep: vi.fn(async (step: number) => { context.activeStep.value = step; }) };
    const source = `const previewFinalOutputItem =${parent.split('const previewFinalOutputItem =')[1]!.split('const handleFinalOutputWorkflowRunChange =')[0]!}`;
    const execute = compile(source, context, 'previewFinalOutputItem');
    await execute({ workflowRunId: 'template-current', templateId: 't', variantId: 'v' });
    expect(context.mixPreviewTarget.value).toEqual({ projectId: 'project', workflowRunId: 'template-current', templateId: 't', variantId: 'v' });
    expect(context.workspace.value.workflowRunId).toBe('global');
    expect(context.activateEffectWorkflowBranch).not.toHaveBeenCalled();
    expect(context.refreshActiveRunInPlace).not.toHaveBeenCalled();
  });
  it('consumes a preview only after its source workspace is installed and opens the engineer directly', () => {
    const target = { projectId: 'project', workflowRunId: 'source', templateId: 't', variantId: 'v' };
    const context = { props: { projectId: 'project', workflowRunId: 'global', previewTarget: target },
      selectedTemplateWorkflowRunId: ref<string | null>(null), pageState: ref('READY'),
      installedWorkspaceScope: ref('project:global'), currentWorkspaceScope: ref('project:source'),
      catalog: ref([{ id: 't', workspace: { editVersion: 2, variants: [{ id: 'v' }] } }]),
      committedVersions: { t: 2 }, activeTemplateId: ref('other'), view: ref('CONFIG'),
      resetWorkbenchDefaults: vi.fn(), selectVariant: vi.fn(), showNotice: vi.fn() };
    const source = `let lastPreviewTarget = null; const applyPreviewTarget =${mix.split('const applyPreviewTarget =')[1]!.split('const leaveEditor =')[0]!}`;
    const execute = compile(source, context, 'applyPreviewTarget');
    execute();
    expect(context.selectedTemplateWorkflowRunId.value).toBe('source');
    expect(context.selectVariant).not.toHaveBeenCalled();
    context.props.workflowRunId = 'source';
    execute();
    expect(context.view.value).toBe('CONFIG');
    context.installedWorkspaceScope.value = 'project:source';
    execute();
    expect(context.view.value).toBe('EDITOR');
    expect(context.activeTemplateId.value).toBe('t');
    expect(context.selectVariant).toHaveBeenCalledExactlyOnceWith('v');
    execute();
    expect(context.selectVariant).toHaveBeenCalledOnce();
    expect(context.showNotice).not.toHaveBeenCalled();
  });
  it('includes an empty current template and ignores obsolete template copies', () => {
    const entry = (id: string, variants: unknown[]) => ({ id, workspace: { template: { name: id }, variants } });
    const context = { computed, runs: ref([]), mixWorkspace: ref({ draft: { templates: [entry('obsolete', [])] } }),
      templateDirectory: ref({ entries: [entry('test1', [{ slots: [{ id: 's' }], bindings: { s: 'clip' } }]), entry('test4', [])] }) };
    const source = `const templates =${page.split('const templates =')[1]!.split('const templateRuns =')[0]!}`;
    const cards = compile(source, context, 'templates').value;
    expect(cards.map((card: { templateId: string }) => card.templateId)).toEqual(['test1', 'test4']);
    expect(cards[1].pendingLabel).toBe('尚未创建成片工程');
  });
  it('uses that template path’s latest sources and offsets instead of the global material pool', () => {
    const context = { run: ref({ templateId: 't' }), templateDirectory: ref({ entries: [{ id: 't', workspace: {
      variants: [{ id: 'v', slots: [{ id: 's', duration: 4 }], bindings: { s: 'clip' }, offsets: { s: 2 } }],
      materials: [{ id: 'clip', fileObjectId: 'latest-file', contentHash: 'latest-hash', artifactRevision: 3, available: true }],
    } }] }) };
    const source = `const previewClips =${page.split('const previewClips =')[1]!.split('const previewVersion =')[0]!}`;
    const execute = compile(source, context, 'previewClips');
    const cover = { fileObjectId: 'old-file', contentHash: 'old', time: 0 };
    expect(execute({ variantId: 'v', cover })).toEqual([{ fileObjectId: 'latest-file', contentHash: 'latest-hash', time: 2.12, version: '3:latest-hash' }]);
    expect(execute({ variantId: 'missing', cover })).toEqual([cover]);
    expect(page).toContain('repeat(${previewClips(item).length}, minmax(0, 1fr))');
  });
  it('refreshes after changes from an independent template Run but ignores other projects', async () => {
    const context = { props: { projectId: 'p', workflowRunId: 'global' }, mounted: true,
      readTemplateDeleted,
      templateDirectory: ref({ workflowRunIds: { t: 'source' } }), refresh: vi.fn(async () => {}), refreshMixWorkspace: vi.fn() };
    const source = `const outputChanged =${page.split('const outputChanged =')[1]!.split('if (outputSyncChannel)')[0]!}`;
    const execute = compile(source, context, 'outputChanged');
    execute({ projectId: 'p', workflowRunId: 'source' });
    await Promise.resolve();
    expect(context.refresh).toHaveBeenCalledOnce();
    expect(context.refreshMixWorkspace).toHaveBeenCalledOnce();
    execute({ projectId: 'other', workflowRunId: 'source' });
    execute({ projectId: 'p', workflowRunId: 'unknown' });
    expect(context.refresh).toHaveBeenCalledOnce();
  });
  it('freezes the project and abort signal for all directory reads and rejects a late project result', async () => {
    const state = { mixGeneration: 0, mixController: undefined as AbortController | undefined, mounted: true };
    const context = { props: { projectId: 'p', workflowRunId: 'global' }, mixWorkspace: ref(null),
      mixLoading: ref(false), templateDirectory: ref({ entries: [] }), mixError: ref(''),
      selectedTemplateId: ref(''), templates: ref([]),
      requestJson: vi.fn(async () => ({ data: { draft: { templates: [] } } })),
      readMixTemplateCatalog: vi.fn(async (_tree, _id, _workspace, read) => {
        const signal = state.mixController!.signal;
        context.props.projectId = 'other';
        state.mixController = new AbortController();
        await read('source');
        expect(context.requestJson).toHaveBeenLastCalledWith(
          '/projects/p/workflows/effect/template-mix?workflowRunId=source',
          expect.objectContaining({ signal }),
        );
        return { entries: ['old-project'] };
      }) };
    const source = `async function refreshMixWorkspace${page.split('async function refreshMixWorkspace')[1]!.split('/** Repair a missed')[0]!}`;
    const execute = compile(`with (state) { ${source} return refreshMixWorkspace; }`, { state, ...context }, 'undefined');
    expect(await execute()).toBeNull();
    expect(context.mixWorkspace.value).toBeNull();
    expect(context.templateDirectory.value.entries).toEqual([]);
  });
  it('refreshes the shared current template directory in the existing output poll', () => {
    expect(page).toContain('void refreshMixWorkspace().then(() => { if (mounted) void refresh(); });');
    expect(page).toContain('mixController?.abort();');
  });
});
