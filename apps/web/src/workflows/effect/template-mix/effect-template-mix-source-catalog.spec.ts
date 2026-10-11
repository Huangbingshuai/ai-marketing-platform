import { describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { ScriptTarget, transpileModule } from 'typescript';
import {
  effectTemplateMixSourceChanges,
  type EffectTemplateMixMaterial,
  type EffectTemplateMixSourcesData,
  type EffectTemplateMixWorkspaceData,
} from '@ai-marketing/contracts';
import {
  mixTemplateCatalogPendingAdded,
  mixTemplateCatalogWithSources,
  retainMixTemplateCatalogSources,
  type MixTemplateCatalog,
} from './effect-template-mix-template-catalog';
import { MixDraftRaceGuard, MixWorkspaceRevisionFence } from './effect-template-mix-draft-race';
import page from './EffectTemplateMixNodePage.vue?raw';

const material = (id: string, revision = 1): EffectTemplateMixMaterial => ({
  id,
  code: id,
  name: id,
  duration: 10,
  purpose: 'HOOK',
  compatiblePurposes: [],
  artifactId: id,
  artifactKey: `render-clip:${id}`,
  artifactRevision: revision,
  fileObjectId: `${id}:${revision}`,
  contentHash: `${id}:${revision}`,
  contentUrl: '/video',
  ratio: '4:3',
  resolution: '480p',
  available: true,
  activeSource: true,
  sourcePromptId: `prompt:${id}`,
});
const baseline = material('bound');
function workspace(id: string): EffectTemplateMixWorkspaceData {
  return {
    draftRevision: 5,
    materials: [baseline],
    commits: [],
    pendingAddedMaterialIds: { [id]: [] },
    draft: {
      schemaVersion: 1,
      activeTemplateId: id,
      templates: [
        {
          id,
          workspace: {
            template: { name: id, slots: [] },
            editVersion: 1,
            variants: [
              {
                id: `${id}:film`,
                slots: [{ id: 'slot', duration: 4, transition: '硬切' }],
                bindings: { slot: 'bound' },
                bindingRevisions: { slot: 1 },
                bindingSources: { slot: baseline },
              },
            ],
          },
        },
      ],
    },
  } as unknown as EffectTemplateMixWorkspaceData;
}
function directory(): MixTemplateCatalog {
  const a = workspace('a');
  const b = workspace('b');
  return {
    entries: [...a.draft.templates, ...b.draft.templates].map((entry) => ({
      ...entry,
      workspace: { ...entry.workspace, materials: [baseline] },
    })),
    workflowRunIds: { a: 'run-a', b: 'run-b' },
    pendingAddedMaterialIds: { a: [], b: [] },
    workspaces: { 'run-a': a, 'run-b': b },
  };
}
const sources = (
  materials: EffectTemplateMixMaterial[],
  added: string[] = [],
): EffectTemplateMixSourcesData => ({
  materials,
  draftRevision: 5,
  pendingAddedMaterialIds: { a: added, b: added },
});

describe('all current template paths track the latest net render difference', () => {
  it('merges two unconsumed rounds, retaining each engineering baseline and switch cache', () => {
    let catalog = directory();
    const before = JSON.stringify(catalog.workspaces['run-b']!.draft);
    for (const revision of [2, 3]) {
      const added = Array.from({ length: revision - 1 }, (_, i) => material(`new-${i}`));
      for (const run of ['run-a', 'run-b'])
        catalog = mixTemplateCatalogWithSources(
          catalog,
          run,
          sources(
            [material('bound', revision), ...added],
            added.map((m) => m.id),
          ),
        );
    }
    for (const entry of catalog.entries) {
      const changes = effectTemplateMixSourceChanges(
        entry.workspace.variants[0]!,
        entry.workspace.materials,
      );
      expect(changes).toHaveLength(1);
      expect(changes[0]!.material!.artifactRevision).toBe(3);
      expect(entry.workspace.variants[0]!.bindingSources!.slot!.artifactRevision).toBe(1);
      expect(
        mixTemplateCatalogPendingAdded(catalog, 'run-a', entry.id, { a: ['new-0', 'new-1'] }),
      ).toHaveLength(2);
    }
    expect(JSON.stringify(catalog.workspaces['run-b']!.draft)).toBe(before);
    expect(
      catalog.workspaces['run-b']!.materials.find((m) => m.id === 'bound')!.artifactRevision,
    ).toBe(3);
    expect(catalog.workspaces['run-b']!.pendingAddedMaterialIds!.b).toHaveLength(2);
  });

  it('clears an unadopted addition deleted in round two, without changing pictures', () => {
    let catalog = mixTemplateCatalogWithSources(
      directory(),
      'run-b',
      sources([baseline, material('new')], ['new']),
    );
    catalog = mixTemplateCatalogWithSources(catalog, 'run-b', sources([baseline]));
    const entry = catalog.entries.find((e) => e.id === 'b')!;
    expect(catalog.pendingAddedMaterialIds.b).toEqual([]);
    expect(
      effectTemplateMixSourceChanges(entry.workspace.variants[0]!, entry.workspace.materials),
    ).toEqual([]);
    expect(entry.workspace.variants[0]!.bindings.slot).toBe('bound');
  });

  it('merges replacement followed by deletion as deletion only', () => {
    let catalog = mixTemplateCatalogWithSources(
      directory(),
      'run-b',
      sources([material('bound', 2)]),
    );
    catalog = mixTemplateCatalogWithSources(
      catalog,
      'run-b',
      sources([{ ...baseline, activeSource: false, sourceRemoved: true }]),
    );
    const entry = catalog.entries.find((e) => e.id === 'b')!;
    expect(
      effectTemplateMixSourceChanges(entry.workspace.variants[0]!, entry.workspace.materials),
    ).toEqual([{ slotId: 'slot', kind: 'REMOVED' }]);
  });

  it('does not force equal differences on independently adopted templates', () => {
    const catalog = directory();
    const b = catalog.workspaces['run-b']!.draft.templates[0]!.workspace.variants[0]!;
    b.bindingSources!.slot = material('bound', 3);
    b.bindingRevisions.slot = 3;
    let next = mixTemplateCatalogWithSources(catalog, 'run-a', sources([material('bound', 3)]));
    next = mixTemplateCatalogWithSources(next, 'run-b', sources([material('bound', 3)]));
    expect(
      next.entries.map(
        (e) =>
          effectTemplateMixSourceChanges(e.workspace.variants[0]!, e.workspace.materials).length,
      ),
    ).toEqual([1, 0]);
  });

  it('keeps refreshed projections when directory hydration arrives late, but not failed paths', () => {
    const previous = directory();
    const refreshed = mixTemplateCatalogWithSources(
      previous,
      'run-b',
      sources([material('bound', 3)], ['new']),
    );
    const incoming = mixTemplateCatalogWithSources(
      directory(),
      'run-a',
      sources([material('bound', 4)]),
    );
    const retained = retainMixTemplateCatalogSources(incoming, refreshed, ['run-b']);
    expect(retained.workspaces['run-b']!.materials[0]!.artifactRevision).toBe(3);
    expect(retained.workspaces['run-a']!.materials[0]!.artifactRevision).toBe(4);
    expect(retained.pendingAddedMaterialIds.b).toEqual(['new']);
    expect(retained.workflowRunIds).toEqual(incoming.workflowRunIds);
  });

  it('requires fresh engineering data when a remote draft changed and rejects a backwards cache', () => {
    const catalog = directory();
    const data = { ...sources([material('bound', 3)]), draftRevision: 6 };
    expect(mixTemplateCatalogWithSources(catalog, 'run-b', data)).toBe(catalog);
    const fresh = { ...workspace('b'), draftRevision: 6, materials: data.materials };
    const next = mixTemplateCatalogWithSources(catalog, 'run-b', data, fresh);
    expect(next.workspaces['run-b']!.draftRevision).toBe(6);
    expect(mixTemplateCatalogWithSources(next, 'run-b', sources([baseline]), workspace('b'))).toBe(
      next,
    );
  });
});

function polling() {
  const initial = directory();
  const context = {
    workbenchActive: true,
    pageState: ref('READY'),
    sourcePollController: undefined as AbortController | undefined,
    mutating: ref(false),
    loadedWorkspaceRunId: 'run-a',
    props: { projectId: 'project', workflowRunId: 'run-a' },
    draftRace: new MixDraftRaceGuard(),
    workspaceRevisionFence: new MixWorkspaceRevisionFence(),
    templateDirectory: ref(initial),
    sourceProjectionEpoch: 0,
    sourceProjectionEpochs: new Map(),
    loadEffectTemplateMixSources: vi.fn(
      async (_project: string, _run: string, _signal?: AbortSignal) => ({
        data: sources([material('bound', 3), material('new')], ['new']),
      }),
    ),
    loadEffectTemplateMixWorkspace: vi.fn(
      async (_project: string, _run: string, _signal?: AbortSignal) => ({
        data: { ...workspace('b'), draftRevision: 6 },
      }),
    ),
    mixTemplateCatalogWithSources,
    sourceMaterials: ref([baseline]),
    renderAspectRatio: ref(null),
    classificationPools: ref([]),
    pendingAddedMaterialIds: ref({}),
    autoPackagingTemplateIds: ref([]),
    catalog: ref(initial.entries),
    draftRevision: ref(5),
    saveState: ref('saved'),
    pendingSave: false,
    load: vi.fn(),
  };
  const source = `const refreshMaterialSources =${page.split('const refreshMaterialSources =')[1]!.split('onMounted(() => {')[0]!}`;
  const js = transpileModule(source, {
    compilerOptions: { target: ScriptTarget.ES2022 },
  }).outputText;
  const poll = new Function('context', `with(context) { ${js}; return refreshMaterialSources; }`)(
    context,
  ) as () => Promise<void>;
  return { context, poll };
}

describe('source polling orchestration without workbench remounts', () => {
  it('refreshes every distinct owner, including unselected templates, without full reloads', async () => {
    const { context: c, poll } = polling();
    await poll();
    expect(c.loadEffectTemplateMixSources.mock.calls.map((args) => args[1])).toEqual([
      'run-a',
      'run-b',
    ]);
    expect(c.templateDirectory.value.pendingAddedMaterialIds.b).toEqual(['new']);
    expect(c.templateDirectory.value.workspaces['run-b']!.materials[0]!.artifactRevision).toBe(3);
    expect(c.loadEffectTemplateMixWorkspace).not.toHaveBeenCalled();
    expect(c.load).not.toHaveBeenCalled();
  });

  it('refreshes the remote engineering cache if its draft revision advanced', async () => {
    const { context: c, poll } = polling();
    c.loadEffectTemplateMixSources.mockImplementation(async (_project, run) => ({
      data: { ...sources([material('bound', 3)]), draftRevision: run === 'run-b' ? 6 : 5 },
    }));
    await poll();
    expect(c.loadEffectTemplateMixWorkspace).toHaveBeenCalledWith(
      'project',
      'run-b',
      expect.any(AbortSignal),
    );
    expect(c.templateDirectory.value.workspaces['run-b']!.draftRevision).toBe(6);
    expect(c.load).not.toHaveBeenCalled();
  });

  it('keeps a failed path while refreshing other paths', async () => {
    const { context: c, poll } = polling();
    c.loadEffectTemplateMixSources.mockImplementation(async (_project, run) => {
      if (run === 'run-b') throw new TypeError('network');
      return { data: sources([material('bound', 3)]) };
    });
    await poll();
    expect(c.templateDirectory.value.workspaces['run-a']!.materials[0]!.artifactRevision).toBe(3);
    expect(c.templateDirectory.value.workspaces['run-b']!.materials[0]!.artifactRevision).toBe(1);
    expect(c.sourceProjectionEpochs.has('project:run-b')).toBe(false);
  });

  it.each(['project', 'run', 'directory', 'edit', 'abort'])(
    'ignores a late source response after %s changes',
    async (change) => {
      const { context: c, poll } = polling();
      const previous = c.sourceMaterials.value;
      c.loadEffectTemplateMixSources.mockImplementation(async () => {
        if (change === 'project') c.props.projectId = 'other';
        if (change === 'run') c.props.workflowRunId = 'other';
        if (change === 'directory') c.templateDirectory.value = directory();
        if (change === 'edit') c.draftRace.changed();
        if (change === 'abort') (c.sourcePollController as AbortController | undefined)?.abort();
        return { data: sources([material('bound', 3)]) };
      });
      await poll();
      expect(c.sourceMaterials.value).toBe(previous);
      expect(c.sourceProjectionEpoch).toBe(0);
    },
  );
});
