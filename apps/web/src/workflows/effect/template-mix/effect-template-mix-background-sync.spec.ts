import type { EffectTemplateMixMaterial, EffectTemplateMixVariant } from '@ai-marketing/contracts';
import { computed, reactive, ref } from 'vue';
import { transpileModule } from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import page from './EffectTemplateMixNodePage.vue?raw';
import parent from '../source-import/EffectImportNodePage.vue?raw';
import {
  canRetainMixPlayback,
  retainUnchangedMixValue,
} from './effect-template-mix-background-sync';
import { cloneMix, createEffectTemplateMixEntry } from './effect-template-mix-state';
import { MixDraftRaceGuard, MixWorkspaceRevisionFence } from './effect-template-mix-draft-race';
import { serializeEffectTemplateMixDraft } from './api/effect-template-mix.api';

const material = (id = 'clip'): EffectTemplateMixMaterial =>
  ({
    id,
    fileObjectId: id,
    contentUrl: `/content/${id}`,
    contentHash: id,
    artifactRevision: 1,
    available: true,
  }) as EffectTemplateMixMaterial;
const variant = (): EffectTemplateMixVariant => ({
  id: 'film',
  name: '成片',
  appliedTemplateVersion: 1,
  slots: [],
  bindings: { slot: 'clip' },
  bindingRevisions: {},
  offsets: {},
  timelineStarts: {},
  videoLanes: {},
  bindingMetadata: {},
  manualSlotIds: [],
  conflictSlotIds: [],
  status: 'CURRENT',
  captions: [],
  subtitleStyle: 'standard',
  bgm: null,
  voice: null,
  originalVolume: 1,
});

function compile(source: string, c: Record<string, unknown>) {
  const script = transpileModule(`const execute =${source}`, {}).outputText;
  return new Function(...Object.keys(c), `${script}\nreturn execute;`)(...Object.values(c));
}

function installation() {
  const entry = createEffectTemplateMixEntry('模板');
  entry.id = 'template';
  entry.workspace.materials = [material()];
  entry.workspace.variants = [variant()];
  entry.workspace.variants[0]!.slots = cloneMix(entry.workspace.template.slots);
  const c = {
    props: { projectId: 'project' },
    pageState: ref('READY'),
    currentWorkspaceScope: ref('project:run'),
    installedWorkspaceScope: ref('project:run'),
    workspaceRevisionFence: new MixWorkspaceRevisionFence(),
    activeTemplateId: ref('template'),
    catalog: ref([entry]),
    uiByTemplate: reactive({
      template: {
        selectedVariantId: 'film',
        selectedSlotId: entry.workspace.template.slots[2]!.id,
      },
    }),
    sourceMaterials: ref(entry.workspace.materials),
    resetTimelinePlayerState: vi.fn(),
    renderAspectRatio: ref(null),
    pendingAddedMaterialIds: ref({}),
    autoPackagingTemplateIds: ref([]),
    renderSlotDurationLimit: ref(15),
    templateCreationReady: ref(true),
    draftRevision: ref(1),
    savedDraftBaseline: null,
    draftSaveBlocked: false,
    draftRace: new MixDraftRaceGuard(),
    effectTemplateMixSlotDurationLimit: () => 15,
    committedVersions: reactive({}),
    classificationPools: ref([]),
    aiRuns: ref([]),
    templateDirectory: ref({ workspaces: {} }),
    normalizeVariantVideoLanes: vi.fn(),
    clearDetachedTransitions: vi.fn(() => false),
    normalizeVariantAudioLanes: vi.fn(),
    scheduleSave: vi.fn(),
    activateTimelineHistoryScope: vi.fn(),
    cloneMix,
    serializeEffectTemplateMixDraft,
    canRetainMixPlayback,
    retainUnchangedMixValue,
  };
  const context = {
    ...c,
    activeUi: computed(() => c.uiByTemplate.template),
    selectedVariant: computed(
      () =>
        c.catalog.value
          .find((e) => e.id === c.activeTemplateId.value)
          ?.workspace.variants.find((v) => v.id === c.uiByTemplate.template.selectedVariantId) ??
        null,
    ),
  };
  const hydrate = compile(
    page.split('const hydrate =')[1]!.split('const initializeUi =')[0]!,
    context,
  );
  const initializeUi = compile(
    page.split('const initializeUi =')[1]!.split('const installWorkspaceData =')[0]!,
    context,
  );
  const execute = compile(
    page.split('const installWorkspaceData =')[1]!.split('const stopPolling =')[0]!,
    { ...context, hydrate, initializeUi },
  );
  const data = () => ({
    draft: cloneMix(serializeEffectTemplateMixDraft([entry], 'template')),
    materials: [material()],
    draftRevision: 2,
    commits: [],
    classificationPools: [],
    aiRuns: [{ id: 'fill', status: 'RUNNING' }],
  });
  return { c, execute, data };
}

describe('smart fill background workspace synchronization', () => {
  it('preserves selected film, slot, decoder and reactive identities across unchanged progress reads', () => {
    const { c, execute, data } = installation();
    const oldCatalog = c.catalog.value,
      oldVariant = oldCatalog[0]!.workspace.variants[0];
    const oldUi = c.uiByTemplate.template,
      slot = oldUi.selectedSlotId;
    execute(data(), 'project:run');
    execute(data(), 'project:run');
    expect(c.resetTimelinePlayerState).not.toHaveBeenCalled();
    expect(c.catalog.value).toBe(oldCatalog);
    expect(c.catalog.value[0]!.workspace.variants[0]).toBe(oldVariant);
    expect(c.uiByTemplate.template).toBe(oldUi);
    expect(c.uiByTemplate.template.selectedSlotId).toBe(slot);
    expect(c.draftRevision.value).toBe(2);
    expect(c.aiRuns.value[0]).toMatchObject({ status: 'RUNNING' });
  });

  it('updates server locks and progress without pausing unchanged media', () => {
    const { c, execute, data } = installation();
    const incoming = data();
    const oldVariant = c.catalog.value[0]!.workspace.variants[0];
    incoming.draft.templates[0]!.aiFillLocked = true;
    execute(incoming, 'project:run');
    expect(c.catalog.value[0]!.aiFillLocked).toBe(true);
    expect(c.catalog.value[0]!.workspace.variants[0]).toBe(oldVariant);
    expect(c.resetTimelinePlayerState).not.toHaveBeenCalled();
  });

  it('normalizes legacy optional fields before comparing playback inputs', () => {
    const { c, execute, data } = installation();
    const incoming = data();
    const film = incoming.draft.templates[0]!.workspace.variants[0]!;
    delete film.timelineStarts;
    delete film.videoLanes;
    delete film.bindingMetadata;
    execute(incoming, 'project:run');
    expect(c.resetTimelinePlayerState).not.toHaveBeenCalled();
  });

  it('does not treat JSON property order as an editor or decoder change', () => {
    const original = { media: 'clip', metadata: { a: 1, b: 2 } };
    expect(retainUnchangedMixValue(original, { metadata: { b: 2, a: 1 }, media: 'clip' })).toBe(
      original,
    );
  });

  it('keeps local template selection instead of restoring an old server navigation pointer', () => {
    const { c, execute, data } = installation();
    const incoming = data();
    const other = createEffectTemplateMixEntry('另一模板');
    other.id = 'other';
    incoming.draft.templates.push(other);
    incoming.draft.activeTemplateId = 'other';
    execute(incoming, 'project:run');
    expect(c.activeTemplateId.value).toBe('template');
    expect(c.resetTimelinePlayerState).not.toHaveBeenCalled();
  });

  it.each(['scope', 'engineering', 'source'])(
    'resets playback only for a real %s change',
    (kind) => {
      const { c, execute, data } = installation();
      const incoming = data();
      if (kind === 'scope') c.installedWorkspaceScope.value = 'project:other';
      if (kind === 'engineering')
        incoming.draft.templates[0]!.workspace.variants[0]!.offsets.slot = 3;
      if (kind === 'source') incoming.materials[0]!.contentUrl = '/changed';
      execute(incoming, 'project:run');
      expect(c.resetTimelinePlayerState).toHaveBeenCalledOnce();
    },
  );

  it('rejects old revisions before touching playback or editing state', () => {
    const { c, execute, data } = installation();
    c.workspaceRevisionFence.acknowledge('project:run', 5);
    expect(execute(data(), 'project:run')).toBe(false);
    expect(c.resetTimelinePlayerState).not.toHaveBeenCalled();
    expect(c.draftRevision.value).toBe(1);
  });

  it('does not pause a frozen adopted source when only the live material pool advances', () => {
    const v = variant();
    v.bindingSources = { slot: material() };
    expect(canRetainMixPlayback('p:r', 'p:r', 't', 't', v, cloneMix(v), [material()], [])).toBe(
      true,
    );
  });

  it('does not reset playback for another unused material, but detects missing pinned media', () => {
    const v = variant();
    expect(
      canRetainMixPlayback(
        'p:r',
        'p:r',
        't',
        't',
        v,
        cloneMix(v),
        [material()],
        [material(), material('unused')],
      ),
    ).toBe(true);
    v.bindingRevisions = { slot: 1 };
    expect(
      canRetainMixPlayback(
        'p:r',
        'p:r',
        't',
        't',
        v,
        cloneMix(v),
        [material()],
        [{ ...material(), artifactRevision: 2 }],
      ),
    ).toBe(false);
  });

  it('retains variant-only duplicated slot selection during background hydration', () => {
    const { c, execute, data } = installation();
    const incoming = data();
    const extra = { ...incoming.draft.templates[0]!.workspace.template.slots[0]!, id: 'copy' };
    incoming.draft.templates[0]!.workspace.variants[0]!.slots.push(extra);
    c.uiByTemplate.template.selectedSlotId = 'copy';
    execute(incoming, 'project:run');
    expect(c.uiByTemplate.template.selectedSlotId).toBe('copy');
  });

  it('limits running-task navigation restoration to initial entry or a real Run switch', () => {
    expect(page).toContain('if (resumedRun && (!wasReady || switchedRun))');
    const load = page.split('const load =')[1]!.split('const queuedOutputRevision')[0]!;
    expect(load).toContain(
      'if (wasReady && installedWorkspaceScope.value === `${projectId}:${workflowRunId}`)',
    );
    expect(load.indexOf('当前工作台和编辑已保留')).toBeLessThan(
      load.indexOf("pageState.value = 'ERROR'"),
    );
    const finish = page.split('const finishAiRun =')[1]!.split('const pollAiRun =')[0]!;
    expect(finish).toContain("if (view.value !== 'EDITOR') resetWorkbenchDefaults();");
  });

  it.each(['background', 'initial', 'new-scope'])(
    'handles a %s read failure without hiding an already usable same-scope workbench',
    (kind) => {
      const request = new AbortController();
      const c = {
        requestController: request,
        controller: request,
        DOMException,
        workflowRunId: 'run',
        projectId: 'project',
        props: { workflowRunId: 'run' },
        wasReady: kind !== 'initial',
        installedWorkspaceScope: ref(kind === 'new-scope' ? 'project:old' : 'project:run'),
        pageState: ref(kind === 'initial' ? 'LOADING' : 'READY'),
        errorMessage: ref(''),
        aiRuns: ref([
          { id: 'running', status: 'RUNNING' },
          { id: 'done', status: 'COMPLETED' },
        ]),
        showNotice: vi.fn(),
        pollAiRun: vi.fn(),
      };
      const load = page.split('const load =')[1]!.split('const notifyOutputChange =')[0]!;
      const catchBody = load
        .slice(load.lastIndexOf('} catch (error) {') + '} catch (error) {'.length)
        .split('} finally {')[0]!;
      const execute = compile(`(error: unknown) => {${catchBody}}`, c);
      execute(new Error('temporary read failure'));
      if (kind === 'background') {
        expect(c.pageState.value).toBe('READY');
        expect(c.errorMessage.value).toBe('');
        expect(c.pollAiRun.mock.calls).toEqual([['running']]);
      } else {
        expect(c.pageState.value).toBe('ERROR');
        expect(c.pollAiRun).not.toHaveBeenCalled();
      }
    },
  );

  it('refreshes fill Run context without the full-page switching curtain', async () => {
    const context = {
      currentProjectId: ref('project'),
      workspace: ref({ workflowRunId: 'old' }),
      refreshActiveRunInPlace: vi.fn(),
      showBranchSwitchToast: vi.fn(),
    };
    const execute = compile(
      parent.split('const handleTemplateMixWorkflowRunChange =')[1]!.split(/\r?\n};/)[0]! + '\n};',
      context,
    );
    await execute({ kind: 'FILL', workflowRunId: 'new', fromRevision: 1, toRevision: 2 });
    expect(context.refreshActiveRunInPlace).toHaveBeenCalledTimes(2);
    for (const args of context.refreshActiveRunInPlace.mock.calls)
      expect(args).toEqual(['project', { showCurtain: false }]);
  });
});
