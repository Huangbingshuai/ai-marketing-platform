import type {
  EffectTemplateMixAiRun,
  EffectTemplateMixWorkspaceData,
} from '@ai-marketing/contracts';

/** A completed task receipt is not proof that its confirmed editor projection has arrived. */
export function mixFillResultReady(
  run: EffectTemplateMixAiRun,
  data: EffectTemplateMixWorkspaceData,
): boolean {
  const entry = data.draft.templates.find(({ id }) => id === run.templateId);
  if (
    run.status !== 'COMPLETED' ||
    !entry ||
    entry.aiFillLocked ||
    !data.aiRuns.some(
      (item) =>
        item.id === run.id &&
        item.workflowRunId === run.workflowRunId &&
        item.status === 'COMPLETED',
    )
  )
    return false;
  const ids = run.outputVariantIds?.length
    ? run.outputVariantIds
    : [run.outputVariantId ?? run.targetVariantId].filter((id): id is string => Boolean(id));
  return (
    ids.length > 0 &&
    ids.every((id) => entry.workspace.variants.some((variant) => variant.id === id)) &&
    data.commits.some(
      (commit) =>
        commit.templateId === run.templateId && commit.editVersion === entry.workspace.editVersion,
    )
  );
}

export type MixFillResultHandoff = {
  projectId: string;
  sourceWorkflowRunId: string;
  run: EffectTemplateMixAiRun;
};
