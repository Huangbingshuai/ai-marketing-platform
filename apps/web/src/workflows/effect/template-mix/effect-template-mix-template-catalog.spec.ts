import { describe, expect, it, vi } from 'vitest';
import type { EffectTemplateMixTemplateEntry, EffectTemplateMixWorkspaceData,
  EffectWorkflowBranch, EffectWorkflowBranchTreeData } from '@ai-marketing/contracts';
import { currentMixTemplateWorkspace, mixTemplateCatalogEntries, mixTemplateCatalogPendingAdded, readMixTemplateCatalog } from './effect-template-mix-template-catalog';
import page from './EffectTemplateMixNodePage.vue?raw';

const branch = (id: string, parent: string | null, templateId: string | null,
  templates: string[], createdAt = id): EffectWorkflowBranch => ({
  workflowRunId: id, parentWorkflowRunId: parent,
  forkNodeId: parent ? 'TEMPLATE_MIX' : 'SEGMENT_RENDER', forkTemplateId: templateId,
  createdAt, templates: templates.map((templateId) => ({ templateId })),
}) as EffectWorkflowBranch;
const workspace = (ids: string[], marker: string): EffectTemplateMixWorkspaceData => ({
  draft: { schemaVersion: 1, activeTemplateId: ids[0], templates: ids.map((id) => ({
    id, createdAt: id, workspace: { template: { name: `${id}:${marker}`, slots: [] },
      variants: [{ id: `${id}:${marker}` }], editVersion: 1 },
  })) }, materials: [{ id: marker }], pendingAddedMaterialIds: { a: [marker] },
  draftRevision: 1, commits: [], aiRuns: [],
}) as unknown as EffectTemplateMixWorkspaceData;
const tree = (): EffectWorkflowBranchTreeData => ({ projectId: 'project', activeWorkflowRunId: 'a1', branches: [
  branch('render', null, null, []), branch('a1', 'render', 'a', ['a']),
  branch('b1', 'render', 'b', ['a', 'b']), branch('c1', 'render', 'c', ['a', 'b', 'c']),
  branch('unrelated', null, null, ['foreign']),
] });

describe('read-only directory of each template current workflow', () => {
  it('returns to the user-selected workflow after leaving history and while browsing another template', async () => {
    const data = tree();
    data.branches.find(b => b.workflowRunId === 'a1')!.templates[0]!.currentSelectedAt = '2026-10-07T01:00:00.000Z';
    const newest = branch('a2', 'a1', 'a', ['a'], '2026-10-08');
    newest.templates[0]!.currentConfirmedAt = '2026-10-08T01:00:00.000Z';
    data.branches.push(newest);
    const read = vi.fn(async (id: string) => workspace([id[0]!], id));
    for (const run of ['a1', 'c1', 'a2']) {
      const directory = await readMixTemplateCatalog(data, run, workspace([run[0]!], run), read, 'a1');
      expect(directory.workflowRunIds).toEqual({ a: 'a1', b: 'b1', c: 'c1' });
      expect(currentMixTemplateWorkspace(directory, 'a', 'a1')).toBeNull();
    }
    expect(read).not.toHaveBeenCalledWith('a2');
  });
  it('reloads the overwritten current result even when the global pointer remains on an old fork', async () => {
    const data = tree();
    data.branches.find(b => b.workflowRunId === 'a1')!.templates[0]!.currentConfirmedAt = '2026-10-07';
    const old = branch('a2', 'a1', 'a', ['a'], '2026-10-06');
    old.templates[0]!.currentConfirmedAt = '2026-10-06';
    data.branches.push(old);
    data.activeWorkflowRunId = 'a2';
    const read = vi.fn(async (id: string) => workspace([id[0]!], id));
    const result = await readMixTemplateCatalog(data, 'a2', workspace(['a'], 'old-five'), read, 'a2');
    expect(result.workflowRunIds).toEqual({ a: 'a1', b: 'b1', c: 'c1' });
    expect(currentMixTemplateWorkspace(result, 'a', 'a2')?.workflowRunId).toBe('a1');
    expect(currentMixTemplateWorkspace(result, 'a', 'a1')).toBeNull();
    expect(currentMixTemplateWorkspace(result, 'deleted', 'a2')).toBeNull();
    const local = workspace(['a'], 'old-five').draft.templates as EffectTemplateMixTemplateEntry[];
    expect(mixTemplateCatalogEntries(result, 'a2', local).find(e => e.id === 'a')?.workspace.template.name)
      .toBe('a:a1');
    result.pendingAddedMaterialIds.a = [];
    // Navigation requests a1 while the installed old a2 draft still has two unassigned clips.
    // Never combine a1's thirteen films with a2's obsolete pending badge/canvas status.
    expect(mixTemplateCatalogPendingAdded(result, 'a2', 'a', { a: ['r21', 'r22'] })).toEqual([]);
    expect(mixTemplateCatalogPendingAdded(result, 'a1', 'a', { a: ['new-real-clip'] })).toEqual(['new-real-clip']);
    const switched = await readMixTemplateCatalog(data, 'c1', workspace(['a', 'b', 'c'], 'copy'), read, 'a2');
    expect(switched.workflowRunIds).toEqual(result.workflowRunIds);
    const historical = await readMixTemplateCatalog(data, 'a2', workspace(['a'], 'old-five'), read, 'a2', 'a');
    expect(historical.workflowRunIds.a).toBe('a2');
    expect(currentMixTemplateWorkspace(historical, 'a', 'a2')).toBeNull();
    expect(page).toContain('currentMixTemplateWorkspace(directory, initialTemplateId, workflowRunId, {');
    expect(page).not.toContain('installWorkspaceData(cloneMix(currentTarget.workspace))');
    expect(page).not.toContain('installWorkspaceData(cloneMix(cached))');
    // The editor being open is no longer permission to keep an obsolete global pointer.
    expect(page).not.toContain("(!wasReady || switchedRun || view.value === 'CONFIG' || configNavigation)");
    expect(currentMixTemplateWorkspace(result, 'a', 'a2', { explicit: true })).toBeNull();
    expect(currentMixTemplateWorkspace(result, 'a', 'a2', { running: true })).toBeNull();
    expect(currentMixTemplateWorkspace(result, 'a', 'a2', { explicit: false, running: false })?.workflowRunId)
      .toBe('a1');
  });
  it('keeps the page current path when browsing a sibling instead of reviving a newer historical fork', async () => {
    const data = tree();
    data.branches.push(branch('a2', 'a1', 'a', ['a'], 'later'));
    const read = vi.fn(async (id: string) => workspace([id[0]!], id));
    const initial = await readMixTemplateCatalog(data, 'a1', workspace(['a'], 'adopted'), read, 'a1');
    const onSibling = await readMixTemplateCatalog(data, 'c1', workspace(['a', 'b', 'c'], 'copied'), read, 'a1');
    expect(onSibling.workflowRunIds).toEqual(initial.workflowRunIds);
    expect(onSibling.workflowRunIds.a).toBe('a1');
    expect(onSibling.entries.find(e => e.id === 'a')?.workspace.template.name).toBe('a:a1');
    expect(read).not.toHaveBeenCalledWith('a2');
    const back = await readMixTemplateCatalog(data, 'a1', workspace(['a'], 'adopted'), read, 'a1');
    expect(back.workflowRunIds).toEqual(initial.workflowRunIds);
  });
  it('keeps all three templates on the oldest a-only Run without changing its draft', async () => {
    const current = workspace(['a'], 'current');
    const before = JSON.stringify(current);
    const read = vi.fn(async (id: string) => workspace(id === 'b1' ? ['a', 'b'] : ['a', 'b', 'c'], id));
    const result = await readMixTemplateCatalog(tree(), 'a1', current, read);
    expect(result.entries.map(({ id }) => id)).toEqual(['a', 'b', 'c']);
    expect(result.entries.map((e) => e.workspace.template.name)).toEqual(['a:current', 'b:b1', 'c:c1']);
    expect(result.workflowRunIds).toEqual({ a: 'a1', b: 'b1', c: 'c1' });
    expect(read.mock.calls.map(([id]) => id).sort()).toEqual(['b1', 'c1']);
    expect(JSON.stringify(current)).toBe(before);
    expect(result.entries[1]?.workspace.materials[0]?.id).toBe('b1');
  });
  it('overlays only locally editable entries, never obsolete sibling copies', async () => {
    const current = workspace(['a', 'b', 'c'], 'copied');
    const directory = await readMixTemplateCatalog(tree(), 'c1', current,
      async (id) => workspace([id[0]!], id));
    const local = current.draft.templates.map((e) => ({ ...e,
      workspace: { ...e.workspace, materials: current.materials },
    })) as EffectTemplateMixTemplateEntry[];
    const entries = mixTemplateCatalogEntries(directory, 'c1', local);
    expect(entries.map((e) => e.workspace.template.name)).toEqual(['a:a1', 'b:b1', 'c:copied']);
    expect(local.map((e) => e.workspace.template.name)).toEqual(['a:copied', 'b:copied', 'c:copied']);
  });
  it('keeps newly created local templates and removes locally deleted unfilled ones', async () => {
    const current = workspace(['a', 'new'], 'local');
    const directory = await readMixTemplateCatalog(tree(), 'a1', current, async (id) => workspace([id[0]!], id));
    expect(directory.workflowRunIds.new).toBe('a1');
    const local = directory.entries.filter(({ id }) => id === 'a');
    expect(mixTemplateCatalogEntries(directory, 'a1', local).map(({ id }) => id)).toEqual(['a', 'b', 'c']);
  });
  it('does not load a manual copy or a different rendering lineage', async () => {
    const data = tree();
    data.branches.push({ ...branch('copy', 'render', null, ['copied']),
      creationKind: 'MANUAL_COPY', forkNodeId: null });
    const read = vi.fn(async (id) => workspace([id[0]!], id));
    const result = await readMixTemplateCatalog(data, 'a1', workspace(['a'], 'local'), read);
    expect(result.entries.map(({ id }) => id)).toEqual(['a', 'b', 'c']);
    expect(read).not.toHaveBeenCalledWith('copy');
    expect(read).not.toHaveBeenCalledWith('unrelated');
  });
  it('does not install a silently shortened directory when a sibling read fails', async () => {
    await expect(readMixTemplateCatalog(tree(), 'a1', workspace(['a'], 'local'),
      async () => { throw new Error('读取失败'); })).rejects.toThrow('读取失败');
  });
  it('renders directory separately but serializes only the loaded workspace', () => {
    expect(page.includes('templateContextWorkflowRunId.value,')).toBe(true);
    expect(page).toContain('v-for="entry in templateListCatalog"');
    expect(page).toContain('serializeEffectTemplateMixDraft(catalog.value, activeTemplateId.value)');
    expect(page).not.toContain('serializeEffectTemplateMixDraft(templateListCatalog');
    const selection = page.split('async function openTemplateWorkspace(')[1]?.split('const selectVariant')[0];
    expect(selection).not.toContain('activateEffectWorkflowBranch');
    expect(selection).not.toContain("emit('workflowRunChange'");
    expect(selection).toContain('selectedTemplateWorkflowRunId.value = targetRunId');
    expect(selection).not.toContain('installWorkspaceData');
    expect(selection).toContain('releaseExplicitWorkspaceTarget()');
    const leaving = page.split('const leaveEditor =')[1]?.split('const selectSlot')[0];
    expect(leaving).toContain('releaseExplicitWorkspaceTarget()');
    expect(page).toContain("templateContextWorkflowRunId.value, 'CONFIG', pageProps.branchNavigation !== lastBranchNavigation");
  });
});
