import { describe, expect, it, vi } from 'vitest';
import { computed, ref } from 'vue';
import { ScriptTarget, transpileModule } from 'typescript';
import page from './EffectFinalOutputNodePage.vue?raw';
import { readTemplateDeleted, withoutDeletedMixCatalog, withoutDeletedMixTemplates } from '../shared/effect-template-deletion';

function fixture(mounted = true) {
  const state = { generation: 1, mixGeneration: 1, controller: new AbortController(),
    mixController: new AbortController(), mounted, exportAttempt: { templateId: 'a' } };
  const draft = { activeTemplateId: 'a', templates: [{ id: 'a' }, { id: 'b' }] };
  const selectedTemplateId = ref('a');
  const runs = ref([{ id: 'film-a', templateId: 'a' }, { id: 'film-b', templateId: 'b' }]);
  const context = { state, props: { projectId: 'p', workflowRunId: 'output-a' },
    acceptedTemplateDeletions: new Map(), readTemplateDeleted, withoutDeletedMixCatalog, withoutDeletedMixTemplates,
    loading: ref(true), mixLoading: ref(true), selectedTemplateId, runs,
    pendingExportNavigation: new Set(['film-a', 'film-b']),
    templateDirectory: ref({ entries: draft.templates, workflowRunIds: { a: 'run-a', b: 'run-b' },
      pendingAddedMaterialIds: {}, workspaces: {} }), mixWorkspace: ref({ draft }),
    settingsByTemplate: ref(new Map([['a', 'a-settings'], ['b', 'b-settings']])),
    outputWorkflowRunId: ref('output-a'), closePreviewDialog: vi.fn(), selectedRunId: ref('film-a'),
    selectedItemIds: ref(new Set(['item-a'])), selectionMode: ref(true), liveExport: ref({}),
    exportStarting: ref(true), error: ref('old'), mixError: ref('old'), deletionNotice: ref(''),
    emit: vi.fn(), refresh: vi.fn(() => new Promise(() => {})), refreshMixWorkspace: vi.fn(),
    templateRuns: computed(() => runs.value.filter(run => run.templateId === selectedTemplateId.value)),
  };
  const source = `const outputChanged =${page.split('const outputChanged =')[1]!.split('if (outputSyncChannel)')[0]!}`;
  const js = transpileModule(source, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText;
  const change = new Function(...Object.keys(context), `with(state) { ${js} return outputChanged; }`)(...Object.values(context));
  return { context, state, change };
}
const receipt = { kind: 'TEMPLATE_DELETED', projectId: 'p', templateId: 'a', workflowRunId: 'render',
  sourceWorkflowRunId: 'run-a', removedWorkflowRunIds: ['run-a', 'output-a'], status: 'QUEUED' };

describe('output page receives async deletion acceptance', () => {
  it('closes only the deleted preview, retains other deliveries and is not blocked by refresh', () => {
    const { context, state, change } = fixture();
    change(receipt);
    expect(context.runs.value.map(run => run.id)).toEqual(['film-b']);
    expect(context.templateDirectory.value.entries.map(entry => entry.id)).toEqual(['b']);
    expect(context.selectedTemplateId.value).toBe('b');
    expect(context.selectedRunId.value).toBe('film-b');
    expect(context.settingsByTemplate.value.has('a')).toBe(false);
    expect(context.settingsByTemplate.value.get('b')).toBe('b-settings');
    expect(context.closePreviewDialog).toHaveBeenCalledOnce();
    expect(context.outputWorkflowRunId.value).toBe('render');
    expect(context.loading.value).toBe(false);
    expect(context.mixLoading.value).toBe(false);
    expect(state.controller.signal.aborted).toBe(true);
    expect(context.pendingExportNavigation).toEqual(new Set(['film-b']));
    expect(context.refresh).toHaveBeenCalledOnce();
    expect(context.refreshMixWorkspace).not.toHaveBeenCalled(); // Parent is adopting a fallback Run.
    change(receipt);
    expect(context.refresh).toHaveBeenCalledOnce();
  });
  it('does not close an unrelated current film when another template disappears', () => {
    const { context, change } = fixture();
    context.selectedTemplateId.value = 'b';
    context.selectedRunId.value = 'film-b';
    change(receipt);
    expect(context.closePreviewDialog).not.toHaveBeenCalled();
    expect(context.selectedRunId.value).toBe('film-b');
    expect(context.selectedTemplateId.value).toBe('b');
  });
  it('updates kept-alive pages while hidden without starting requests', () => {
    const { context, change } = fixture(false);
    change(receipt);
    expect(context.runs.value.map(run => run.id)).toEqual(['film-b']);
    expect(context.refresh).not.toHaveBeenCalled();
    expect(context.refreshMixWorkspace).not.toHaveBeenCalled();
  });
  it('ignores other projects even when template and Run IDs in the event are similar', () => {
    const { context, change } = fixture();
    change({ ...receipt, projectId: 'other' });
    expect(context.runs.value).toHaveLength(2);
    expect(context.closePreviewDialog).not.toHaveBeenCalled();
    expect(context.refresh).not.toHaveBeenCalled();
  });
});
