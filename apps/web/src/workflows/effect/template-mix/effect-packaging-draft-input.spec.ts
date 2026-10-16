import { describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { transpileModule } from 'typescript';
import type { EffectTemplateMixTemplateEntry } from '@ai-marketing/contracts';
import page from './EffectTemplateMixNodePage.vue?raw';
import { samePackagingDraftInput } from './effect-packaging-draft-input';
import { MixDraftRaceGuard } from './effect-template-mix-draft-race';

const entry = (): EffectTemplateMixTemplateEntry =>
  ({
    id: 't',
    workspace: {
      editVersion: 1,
      template: { name: '测试1', slots: [] },
      variants: [{ id: 'v', bindings: { a: 'clip' }, offsets: { a: 1 } }],
    },
  }) as unknown as EffectTemplateMixTemplateEntry;

function harness() {
  const current = entry();
  const remote = entry();
  const context = {
    packagingActionBlockReason: ref<string | null>(null),
    showNotice: vi.fn(),
    currentWorkspaceScope: ref('p:w'),
    installedWorkspaceScope: ref('p:w'),
    props: { projectId: 'p', workflowRunId: 'w' },
    activeTemplateId: ref('t'),
    flushPendingEdits: vi.fn(async () => true),
    draftRace: new MixDraftRaceGuard(),
    draftRevision: ref(31),
    activeEntry: ref(current),
    cloneMix: (value: unknown) => JSON.parse(JSON.stringify(value)),
    loadEffectTemplateMixWorkspace: vi.fn(async () => ({
      data: {
        draftRevision: 33,
        draft: { templates: [remote] },
        materials: [],
      },
    })),
    saveState: ref('saved'),
    pendingSave: undefined,
    samePackagingDraftInput,
    hydrate: (value: unknown) => value,
    installWorkspaceData: vi.fn((_data: unknown, _scope: string, _preserve: boolean) => true),
  };
  context.installWorkspaceData.mockImplementation((data) => {
    context.draftRevision.value = (data as { draftRevision: number }).draftRevision;
    return true;
  });
  const source = `const preparePackaging${page.split('const preparePackaging')[1]!.split('const startAiFill')[0]!}`;
  const prepare = new Function(
    ...Object.keys(context),
    `${transpileModule(source, {}).outputText}\nreturn preparePackaging;`,
  )(...Object.values(context)) as () => Promise<number | null>;
  return { ...context, remote, prepare };
}

describe('packaging draft preparation', () => {
  it.each(['BATCH_PACKAGE', 'SINGLE_PACKAGE'])(
    'keeps %s on the selected template Run, not the global page Run',
    async () => {
      const h = harness();
      // The page can browse an older template tip while another branch stays globally active.
      const pageProps = { projectId: 'p', workflowRunId: 'global-run' };
      const panel = page.match(/<EffectTemplateMixPackaging\b[\s\S]*?\/>/)![0];
      const expression = panel.match(/:workflow-run-id="([^"]+)"/)![1]!;
      const panelRunId = new Function('props', 'workflowRunId', `return ${expression};`)(
        h.props,
        pageProps.workflowRunId,
      );
      const revision = await h.prepare();
      expect(h.loadEffectTemplateMixWorkspace).toHaveBeenCalledWith('p', h.props.workflowRunId);
      expect({ workflowRunId: panelRunId, expectedRevision: revision }).toEqual({
        workflowRunId: h.props.workflowRunId,
        expectedRevision: 33,
      });
    },
  );
  it('adopts the current revision without blocking on unrelated draft counters or navigation', async () => {
    const h = harness();
    h.remote.workspace.editVersion += 1;
    h.remote.packagingLocked = true;
    expect(await h.prepare()).toBe(33);
    expect(h.installWorkspaceData).toHaveBeenCalledWith(expect.anything(), 'p:w', true);
    expect(h.flushPendingEdits).toHaveBeenCalledTimes(2);
  });
  it('preserves local cuts when the remote template has really changed', async () => {
    const h = harness();
    h.remote.workspace.variants[0]!.offsets.a = 3;
    await expect(h.prepare()).rejects.toThrow('本页内容已保留');
    expect(h.installWorkspaceData).not.toHaveBeenCalled();
    expect(h.activeEntry.value.workspace.variants[0]!.offsets.a).toBe(1);
    expect(h.draftRevision.value).toBe(31);
  });
  it.each(['edit', 'scope', 'template'] as const)(
    'discards a read after a %s change',
    async (change) => {
      const h = harness();
      h.loadEffectTemplateMixWorkspace.mockImplementation(async () => {
        if (change === 'edit') {
          h.draftRace.changed();
          h.saveState.value = 'dirty';
        }
        if (change === 'scope') h.currentWorkspaceScope.value = 'p:other';
        if (change === 'template') h.activeTemplateId.value = 'other';
        return { data: { draftRevision: 33, draft: { templates: [h.remote] }, materials: [] } };
      });
      if (change === 'edit') await expect(h.prepare()).rejects.toThrow('新修改');
      else expect(await h.prepare()).toBeNull();
      expect(h.installWorkspaceData).not.toHaveBeenCalled();
    },
  );
  it('does not read or submit after a failed save', async () => {
    const h = harness();
    h.flushPendingEdits.mockResolvedValue(false);
    expect(await h.prepare()).toBeNull();
    expect(h.loadEffectTemplateMixWorkspace).not.toHaveBeenCalled();
  });
  it('does not freeze a rejected older response', async () => {
    const h = harness();
    h.installWorkspaceData.mockReturnValue(false);
    expect(await h.prepare()).toBeNull();
  });
  it('treats audio, template settings and film removal as real input changes', () => {
    const before = entry();
    for (const mutate of [
      (value: EffectTemplateMixTemplateEntry) => {
        value.workspace.template.name = '另一模板';
      },
      (value: EffectTemplateMixTemplateEntry) => {
        value.workspace.variants = [];
      },
      (value: EffectTemplateMixTemplateEntry) => {
        value.workspace.variants[0]!.bgm = {
          fileObjectId: 'music',
          name: '纯音乐',
          offset: 0,
          start: 0,
          duration: 4,
          volume: 0.12,
        };
      },
    ]) {
      const next = entry();
      mutate(next);
      expect(samePackagingDraftInput(before, next)).toBe(false);
    }
    expect(samePackagingDraftInput(before, undefined)).toBe(false);
  });
});
