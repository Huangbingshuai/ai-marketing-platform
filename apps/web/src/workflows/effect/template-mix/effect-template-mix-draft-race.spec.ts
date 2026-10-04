import type { EffectTemplateMixDraft } from '@ai-marketing/contracts';
import { describe, expect, it } from 'vitest';
import page from './EffectTemplateMixNodePage.vue?raw';
import { createEffectTemplateMixEntry } from './effect-template-mix-state';
import { MixDraftRaceGuard, rebaseMixDraft, saveLatestMixDraft } from './effect-template-mix-draft-race';

const draft = (): EffectTemplateMixDraft => ({
  schemaVersion: 1, activeTemplateId: 'a',
  templates: ['a', 'b'].map((id) => ({ ...createEffectTemplateMixEntry(id), id })),
});
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe('mix draft save races', () => {
  it('rejects a read started before a write, even when the write has already finished', () => {
    const guard = new MixDraftRaceGuard();
    const token = guard.readToken();
    guard.beginWrite();
    expect(guard.canInstall(token, false)).toBe(false);
    guard.endWrite();
    expect(guard.canInstall(token, false)).toBe(false);
    expect(guard.canInstall(guard.readToken(), false)).toBe(true);
  });
  it('keeps new local edits and dirty drafts from being replaced by a background read', () => {
    const guard = new MixDraftRaceGuard();
    const token = guard.readToken();
    guard.changed();
    expect(guard.canInstall(token, false)).toBe(false);
    expect(guard.canInstall(guard.readToken(), true)).toBe(false);
  });
  it('flushes edits arriving during an in-flight save using its returned revision', async () => {
    let local = 'first';
    let persisted = '';
    let revision = 7;
    let release!: () => void;
    const requests: Array<{ value: string; revision: number }> = [];
    const completed = saveLatestMixDraft(async () => {
      const value = local;
      requests.push({ value, revision });
      if (requests.length === 1) await new Promise<void>((resolve) => { release = resolve; });
      revision += 1;
      persisted = value;
      return true;
    }, () => local !== persisted);
    local = 'latest';
    release();
    await expect(completed).resolves.toBe(true);
    expect(requests).toEqual([{ value: 'first', revision: 7 }, { value: 'latest', revision: 8 }]);
    expect(persisted).toBe('latest');
  });
  it('stops on failed writes instead of retrying or losing unsaved edits', async () => {
    let calls = 0;
    await expect(saveLatestMixDraft(async () => { calls += 1; return false; }, () => true))
      .resolves.toBe(false);
    expect(calls).toBe(1);
  });
  it('does not save an old scope after the current request settles', async () => {
    let scope = 'old';
    let calls = 0;
    await expect(saveLatestMixDraft(async () => { calls += 1; scope = 'new'; return true; },
      () => scope === 'old')).resolves.toBe(true);
    expect(calls).toBe(1);
  });
  it('wires read protection, snapshot acknowledgement, rebase and scope checks into the page', () => {
    expect(page).toContain('draftRace.canInstall(readToken');
    expect(page).toContain('savedDraftBaseline = snapshot');
    expect(page).toContain('const saved = await saveLatestMixDraft');
    expect(page).toContain('if (scope !== currentWorkspaceScope.value || draftSaveBlocked) return false');
    expect(page).toContain('const merged = rebaseMixDraft(savedDraftBaseline');
    expect(page).toContain('draftSaveBlocked = true');
  });
});

describe('guarded template-level rebase', () => {
  it('retains independent local and remote template edits', () => {
    const base = draft(); const local = copy(base); const remote = copy(base);
    local.templates[0]!.workspace.template.name = 'local a';
    remote.templates[1]!.workspace.template.name = 'remote b';
    expect(rebaseMixDraft(base, local, remote)?.templates.map((t) => t.workspace.template.name))
      .toEqual(['local a', 'remote b']);
  });
  it('accepts the same edit and UI-only selection changes', () => {
    const base = draft(); const local = copy(base); const remote = copy(base);
    local.templates[0]!.workspace.template.name = 'same';
    remote.templates[0]!.workspace.template.name = 'same';
    remote.activeTemplateId = 'b';
    expect(rebaseMixDraft(base, local, remote)?.activeTemplateId).toBe('a');
  });
  it('does not mistake computed server flags for a conflicting edit', () => {
    const base = draft(); const local = copy(base); const remote = copy(base);
    local.templates[0]!.workspace.template.name = 'local';
    remote.templates[0]!.packagingLocked = true;
    remote.templates[0]!.createdAt = '2026-10-04T00:00:00Z';
    expect(rebaseMixDraft(base, local, remote)?.templates[0]!.workspace.template.name).toBe('local');
  });
  it('rejects two different edits to the same template', () => {
    const base = draft(); const local = copy(base); const remote = copy(base);
    local.templates[0]!.workspace.template.name = 'ours';
    remote.templates[0]!.workspace.template.name = 'theirs';
    expect(rebaseMixDraft(base, local, remote)).toBeNull();
    expect(local.templates[0]!.workspace.template.name).toBe('ours');
  });
  it('rejects deletion versus editing; preserves a remote deletion when locally untouched', () => {
    const base = draft(); const local = copy(base); const remote = copy(base);
    remote.templates.shift();
    expect(rebaseMixDraft(base, local, remote)?.templates.map((t) => t.id)).toEqual(['b']);
    local.templates[0]!.workspace.template.name = 'edited';
    expect(rebaseMixDraft(base, local, remote)).toBeNull();
  });
  it('retains independently added templates and rejects conflicting additions of one ID', () => {
    const base = draft(); const local = copy(base); const remote = copy(base);
    local.templates.push({ ...createEffectTemplateMixEntry('c'), id: 'c' });
    remote.templates.push({ ...createEffectTemplateMixEntry('d'), id: 'd' });
    expect(rebaseMixDraft(base, local, remote)?.templates.map((t) => t.id)).toEqual(['a', 'b', 'd', 'c']);
    remote.templates.push({ ...createEffectTemplateMixEntry('other'), id: 'c' });
    expect(rebaseMixDraft(base, local, remote)).toBeNull();
  });
});
