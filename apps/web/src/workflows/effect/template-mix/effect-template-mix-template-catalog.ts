import {
  effectTemplateBranchTips,
  type EffectTemplateMixTemplateEntry,
  type EffectTemplateMixWorkspaceData,
  type EffectTemplateMixSourcesData,
  type EffectWorkflowBranchTreeData,
} from '@ai-marketing/contracts';

/** Read-only directory. These entries must never be serialized into another Run's draft. */
export type MixTemplateCatalog = {
  entries: EffectTemplateMixTemplateEntry[];
  workflowRunIds: Record<string, string>;
  pendingAddedMaterialIds: Record<string, string[]>;
  workspaces: Record<string, EffectTemplateMixWorkspaceData>;
};

/**
 * A current-Run directory is enough to render the first useful frame. Historical template heads
 * are read-only projections and can be hydrated after the writable workspace is installed.
 */
export function mixTemplateCatalogFromWorkspace(
  workflowRunId: string,
  current: EffectTemplateMixWorkspaceData,
): MixTemplateCatalog {
  const entries = current.draft.templates.map((entry) => ({
    ...entry,
    workspace: { ...entry.workspace, materials: current.materials },
  }));
  return {
    entries,
    workflowRunIds: Object.fromEntries(entries.map((entry) => [entry.id, workflowRunId])),
    pendingAddedMaterialIds: Object.fromEntries(
      entries.map((entry) => [entry.id, current.pendingAddedMaterialIds?.[entry.id] ?? []]),
    ),
    workspaces: { [workflowRunId]: current },
  };
}

/** Resolve routing without loading every historical workspace. */
export function mixTemplateCatalogTargetRun(
  tree: EffectWorkflowBranchTreeData,
  workflowRunId: string,
  templateId: string,
  catalogContextWorkflowRunId = workflowRunId,
  selectedTemplateId: string | null = null,
): string | null {
  return (
    effectTemplateBranchTips(tree.branches, catalogContextWorkflowRunId, {
      current: true,
      selectedTemplateId,
    }).get(templateId)?.workflowRunId ?? null
  );
}

/** Pending badges and entries must use the installed draft's owner, not the requested Run. */
export function mixTemplateCatalogPendingAdded(
  directory: MixTemplateCatalog,
  loadedRunId: string,
  templateId: string,
  local: Record<string, string[]>,
): string[] {
  const owner = directory.workflowRunIds[templateId];
  return owner && owner !== loadedRunId
    ? (directory.pendingAddedMaterialIds[templateId] ?? [])
    : (local[templateId] ?? []);
}

/** Refresh read-only projections, including the cache used by immediate template switches.
 * Source polling never adopts a new baseline or serializes another Run into the writable draft.
 */
export function mixTemplateCatalogWithSources(
  directory: MixTemplateCatalog,
  workflowRunId: string,
  sources: EffectTemplateMixSourcesData,
  freshWorkspace?: EffectTemplateMixWorkspaceData,
): MixTemplateCatalog {
  const previous = directory.workspaces[workflowRunId];
  if (!previous || (!freshWorkspace && previous.draftRevision !== sources.draftRevision))
    return directory;
  const workspace = freshWorkspace ?? {
    ...previous,
    materials: sources.materials,
    pendingAddedMaterialIds: sources.pendingAddedMaterialIds ?? {},
    classificationPools: sources.classificationPools ?? previous.classificationPools,
    renderAspectRatio:
      sources.renderAspectRatio !== undefined
        ? sources.renderAspectRatio
        : (previous.renderAspectRatio ?? null),
    autoPackagingTemplateIds: sources.autoPackagingTemplateIds ?? [],
  };
  if ((workspace.draftRevision ?? 0) < (previous.draftRevision ?? 0)) return directory;
  const pendingAddedMaterialIds = { ...directory.pendingAddedMaterialIds };
  const entries = directory.entries.flatMap((entry) => {
    if (directory.workflowRunIds[entry.id] !== workflowRunId) return [entry];
    pendingAddedMaterialIds[entry.id] = workspace.pendingAddedMaterialIds?.[entry.id] ?? [];
    const updated = freshWorkspace
      ? workspace.draft.templates.find(({ id }) => id === entry.id)
      : entry;
    return updated
      ? [{ ...updated, workspace: { ...updated.workspace, materials: workspace.materials } }]
      : [];
  });
  return {
    ...directory,
    entries,
    pendingAddedMaterialIds,
    workspaces: { ...directory.workspaces, [workflowRunId]: workspace },
  };
}

/** A directory request started before a source poll must not roll those sources back. */
export function retainMixTemplateCatalogSources(
  incoming: MixTemplateCatalog,
  refreshed: MixTemplateCatalog,
  refreshedRunIds: readonly string[],
): MixTemplateCatalog {
  let result = incoming;
  // Completed local updates can advance a workspace while the directory's reads
  // are still pending, without a material-source polling epoch having changed.
  const newerWorkspaceIds = Object.keys(refreshed.workspaces).filter((runId) =>
    (refreshed.workspaces[runId]?.draftRevision ?? 0) >
    (incoming.workspaces[runId]?.draftRevision ?? 0));
  for (const runId of new Set([...refreshedRunIds, ...newerWorkspaceIds])) {
    const workspace = refreshed.workspaces[runId];
    const previous = incoming.workspaces[runId];
    if (!workspace || !previous || (workspace.draftRevision ?? 0) < (previous.draftRevision ?? 0))
      continue;
    result = mixTemplateCatalogWithSources(result, runId, workspace, workspace);
  }
  return result;
}

/** Resolve the editor from the same directory as the list, without changing the global Run. */
export function currentMixTemplateWorkspace(
  directory: MixTemplateCatalog,
  templateId: string,
  loadedRunId: string,
  destination: { explicit?: boolean; running?: boolean } = {},
): { workflowRunId: string; workspace: EffectTemplateMixWorkspaceData } | null {
  // The editor's visual mode is irrelevant. Only an explicit history/preview or an
  // in-flight job may retain a different Run from the current template head.
  if (destination.explicit || destination.running) return null;
  const workflowRunId = directory.workflowRunIds[templateId];
  const workspace = workflowRunId ? directory.workspaces[workflowRunId] : undefined;
  return workflowRunId &&
    workflowRunId !== loadedRunId &&
    workspace &&
    workspace.draft.templates.some((entry) => entry.id === templateId)
    ? { workflowRunId, workspace }
    : null;
}

export async function readMixTemplateCatalog(
  tree: EffectWorkflowBranchTreeData,
  workflowRunId: string,
  current: EffectTemplateMixWorkspaceData,
  readWorkspace: (runId: string) => Promise<EffectTemplateMixWorkspaceData>,
  catalogContextWorkflowRunId = workflowRunId,
  selectedTemplateId: string | null = null,
): Promise<MixTemplateCatalog> {
  // Template selection scopes the editor's writes, not the directory's published path.
  // Current paths keep each template's explicit user choice. Without one they follow local
  // confirmations. A copied sibling or ordinary navigation cannot undo that choice.
  const tips = effectTemplateBranchTips(tree.branches, catalogContextWorkflowRunId, {
    current: true,
    selectedTemplateId,
  });
  const paths = new Set([...tips.values()].map((tip) => tip.workflowRunId));
  const workspaces = new Map<string, EffectTemplateMixWorkspaceData>([[workflowRunId, current]]);
  await Promise.all(
    [...paths]
      .filter((id) => id !== workflowRunId)
      .map(async (id) => {
        workspaces.set(id, await readWorkspace(id));
      }),
  );
  const entries: EffectTemplateMixTemplateEntry[] = [];
  const workflowRunIds: Record<string, string> = {};
  const pendingAddedMaterialIds: Record<string, string[]> = {};
  const add = (
    entry: EffectTemplateMixWorkspaceData['draft']['templates'][number],
    runId: string,
    workspace: EffectTemplateMixWorkspaceData,
  ) => {
    // Attach that path's sources, not the active project's copied material pool.
    entries.push({ ...entry, workspace: { ...entry.workspace, materials: workspace.materials } });
    workflowRunIds[entry.id] = runId;
    pendingAddedMaterialIds[entry.id] = workspace.pendingAddedMaterialIds?.[entry.id] ?? [];
  };
  for (const [templateId, tip] of tips) {
    const workspace = workspaces.get(tip.workflowRunId)!;
    const entry = workspace.draft.templates.find(({ id }) => id === templateId);
    if (entry) add(entry, tip.workflowRunId, workspace);
  }
  // A new, unfilled template may not have a published branch yet.
  for (const entry of current.draft.templates) {
    if (!tips.has(entry.id)) add(entry, workflowRunId, current);
  }
  entries.sort(
    (a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? '') || a.id.localeCompare(b.id),
  );
  return {
    entries,
    workflowRunIds,
    pendingAddedMaterialIds,
    workspaces: Object.fromEntries(workspaces),
  };
}

/** Overlay edits only for the loaded Run; never revive its obsolete copies of sibling templates. */
export function mixTemplateCatalogEntries(
  directory: MixTemplateCatalog,
  workflowRunId: string,
  local: EffectTemplateMixTemplateEntry[],
): EffectTemplateMixTemplateEntry[] {
  const localById = new Map(local.map((entry) => [entry.id, entry]));
  const entries = directory.entries.flatMap((entry) => {
    if (directory.workflowRunIds[entry.id] !== workflowRunId) return [entry];
    const current = localById.get(entry.id);
    return current ? [current] : [];
  });
  const ids = new Set(directory.entries.map(({ id }) => id));
  return [...entries, ...local.filter(({ id }) => !ids.has(id))];
}
