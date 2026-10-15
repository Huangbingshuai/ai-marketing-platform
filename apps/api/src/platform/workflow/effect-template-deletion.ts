/** Exact identities only. Never match template names or arbitrary JSON strings. */
export const artifactTemplateId = (key: string): string | null =>
  /^(?:mix-template|timeline-project|timeline-package|final-delivery|final-video):([^:]+)(?::|$)/.exec(
    key,
  )?.[1] ?? null;

export function pruneDeletedTemplates(state: unknown, deleted: ReadonlySet<string>): unknown {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return state;
  const value = structuredClone(state) as Record<string, unknown>;
  if (Array.isArray(value.templates)) {
    value.templates = value.templates.filter(
      (entry) =>
        !entry || typeof entry !== 'object' || !deleted.has(String((entry as { id?: unknown }).id)),
    );
    if (deleted.has(String(value.activeTemplateId)))
      value.activeTemplateId = (value.templates as { id?: string }[])[0]?.id ?? '';
  }
  for (const field of ['selectedTemplates', 'templateSettings', 'settingsByTemplate']) {
    const map = value[field];
    if (map && typeof map === 'object' && !Array.isArray(map))
      for (const id of deleted) delete (map as Record<string, unknown>)[id];
  }
  if (deleted.has(String(value.templateId))) value.templateId = '';
  if (deleted.has(String(value.selectedTemplateId))) value.selectedTemplateId = '';
  return value;
}

type Branch = {
  id: string;
  parentWorkflowRunId: string | null;
  forkNodeId: string | null;
  forkTemplateId: string | null;
};
/** Another template is a sibling business scope even if its storage Run is nested. */
export function templateDeletionRuns(
  runs: readonly Branch[],
  templateId: string,
  legacyRoots: ReadonlySet<string> = new Set(),
  sharedOrForeignRuns: ReadonlySet<string> = new Set(),
): Set<string> {
  // A historical parent/child relationship is not business ownership. Old forks often
  // have no forkTemplateId even when they start a different template's workflow.
  // Keep unknown containers rather than cascading through them; cleanup detaches them.
  return new Set(
    runs
      .filter(
        (run) =>
          !sharedOrForeignRuns.has(run.id) &&
          ['TEMPLATE_MIX', 'FINAL_OUTPUT'].includes(run.forkNodeId ?? '') &&
          (run.forkTemplateId === templateId || (!run.forkTemplateId && legacyRoots.has(run.id))),
      )
      .map((run) => run.id),
  );
}
