import type { DeleteEffectTemplateMixData, EffectTemplateMixDraft } from '@ai-marketing/contracts';
import type { MixTemplateCatalog } from '../template-mix/effect-template-mix-template-catalog';

/** Accepted deletion is a receipt, not a request to wait for files or create another branch. */
export type EffectTemplateDeleted = DeleteEffectTemplateMixData & {
  kind: 'TEMPLATE_DELETED';
  projectId: string;
  sourceWorkflowRunId: string;
};

export function withoutDeletedMixTemplates(
  draft: EffectTemplateMixDraft,
  deleted: ReadonlySet<string>,
): EffectTemplateMixDraft {
  const templates = draft.templates.filter(({ id }) => !deleted.has(id));
  return {
    ...draft,
    templates,
    activeTemplateId: templates.some(({ id }) => id === draft.activeTemplateId)
      ? draft.activeTemplateId
      : (templates[0]?.id ?? ''),
  };
}

/** Also prune cached copied configurations: a late directory read must not revive a receipt. */
export function withoutDeletedMixCatalog(
  directory: MixTemplateCatalog,
  deleted: ReadonlySet<string>,
): MixTemplateCatalog {
  const keep = <T>(values: Record<string, T>) =>
    Object.fromEntries(Object.entries(values).filter(([id]) => !deleted.has(id)));
  return {
    entries: directory.entries.filter(({ id }) => !deleted.has(id)),
    workflowRunIds: keep(directory.workflowRunIds),
    pendingAddedMaterialIds: keep(directory.pendingAddedMaterialIds),
    // Workspaces are keyed by Run, not template ID. Do not drop another template's owner.
    workspaces: Object.fromEntries(
      Object.entries(directory.workspaces).map(([id, data]) => [
        id,
        {
          ...data,
          draft: withoutDeletedMixTemplates(data.draft, deleted),
          aiRuns: data.aiRuns?.filter((run) => !deleted.has(run.templateId)),
        },
      ]),
    ),
  };
}

export function templateDeletionDestination(
  directory: MixTemplateCatalog,
  selectedTemplateId: string,
  currentRunId: string,
  receipt: DeleteEffectTemplateMixData,
): { templateId: string; workflowRunId: string; selectionRemoved: boolean } {
  const selectionRemoved = selectedTemplateId === receipt.templateId;
  const templateId = directory.entries.some(({ id }) => id === selectedTemplateId)
    ? selectedTemplateId
    : (directory.entries[0]?.id ?? '');
  const currentRemoved = receipt.removedWorkflowRunIds?.includes(currentRunId) ?? false;
  return {
    templateId,
    workflowRunId:
      selectionRemoved || currentRemoved
        ? (directory.workflowRunIds[templateId] ?? receipt.workflowRunId)
        : currentRunId,
    selectionRemoved,
  };
}

export function readTemplateDeleted(value: unknown): EffectTemplateDeleted | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Partial<EffectTemplateDeleted>;
  return item.kind === 'TEMPLATE_DELETED' &&
    typeof item.projectId === 'string' &&
    typeof item.templateId === 'string' &&
    typeof item.workflowRunId === 'string' &&
    typeof item.sourceWorkflowRunId === 'string' &&
    ['QUEUED', 'RUNNING', 'COMPLETED'].includes(item.status ?? '') &&
    (item.removedWorkflowRunIds === undefined ||
      (Array.isArray(item.removedWorkflowRunIds) &&
        item.removedWorkflowRunIds.every((id) => typeof id === 'string')))
    ? (item as EffectTemplateDeleted)
    : null;
}

export function notifyTemplateDeleted(
  receipt: EffectTemplateDeleted,
  channel: BroadcastChannel | null,
): void {
  window.dispatchEvent(new CustomEvent('effect-final-output-sync', { detail: receipt }));
  try {
    channel?.postMessage(receipt);
  } catch {
    // Navigation/unmount may have closed this channel while the accepted POST was in flight.
    // The local receipt and server tombstone are still valid; do not report deletion as failed.
  }
}
