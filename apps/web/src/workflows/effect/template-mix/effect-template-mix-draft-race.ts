import type { EffectTemplateMixDraft } from '@ai-marketing/contracts';

type DraftTemplate = EffectTemplateMixDraft['templates'][number];

/** Request epochs, not business revisions: a read may never undo a local edit or save. */
export class MixDraftRaceGuard {
  private epoch = 0;
  private writes = 0;
  changed(): void { this.epoch += 1; }
  beginWrite(): void { this.writes += 1; this.changed(); }
  endWrite(): void { this.writes -= 1; this.changed(); }
  readToken(): number { return this.epoch; }
  canInstall(token: number, dirty: boolean): boolean {
    return !dirty && this.writes === 0 && token === this.epoch;
  }
}

export const saveLatestMixDraft = async (
  write: () => Promise<boolean>,
  hasUnsavedTail: () => boolean,
): Promise<boolean> => {
  do {
    if (!(await write())) return false;
  } while (hasUnsavedTail());
  return true;
};

const stableJson = (value: unknown): string => JSON.stringify(value, (_key, entry: unknown) => {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
  return Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b)));
});

const editableEntry = (entry: DraftTemplate | undefined): string => {
  if (!entry) return 'absent';
  // These are computed by the server, not user edits. Lock validation still runs on every PUT.
  const { aiFillLocked: _fill, packagingLocked: _package, packagingSourceLocked: _source,
    filledTemplateHash: _hash, needsAiFill: _needs, createdAt: _created, ...editable } = entry;
  return stableJson(editable);
};

/** Only merge independent templates. Concurrent edits of the same template are never overwritten. */
export const rebaseMixDraft = (
  baseline: EffectTemplateMixDraft,
  local: EffectTemplateMixDraft,
  remote: EffectTemplateMixDraft,
): EffectTemplateMixDraft | null => {
  const templates: DraftTemplate[] = [];
  const ids = new Set([...remote.templates, ...local.templates].map(({ id }) => id));
  for (const id of ids) {
    const before = baseline.templates.find((entry) => entry.id === id);
    const ours = local.templates.find((entry) => entry.id === id);
    const theirs = remote.templates.find((entry) => entry.id === id);
    const beforeKey = editableEntry(before);
    const oursKey = editableEntry(ours);
    const theirsKey = editableEntry(theirs);
    if (oursKey !== beforeKey && theirsKey !== beforeKey && oursKey !== theirsKey) return null;
    const selected = oursKey === beforeKey ? theirs : ours;
    if (selected) templates.push(selected);
  }
  return {
    ...remote, templates,
    activeTemplateId: templates.some(({ id }) => id === local.activeTemplateId)
      ? local.activeTemplateId : remote.activeTemplateId,
  };
};
