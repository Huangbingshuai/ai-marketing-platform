import { Prisma } from '../../../generated/prisma/client';
import { customizedScope } from '../../../platform/workflow/customized-branches';

/** Called only after a full extraction passed validation, inside its completion transaction. */
export async function createAssetBranch(
  tx: Prisma.TransactionClient,
  projectId: string,
  sourceRunId: string,
  taskId: string,
) {
  const source = await tx.workflowRun.findFirstOrThrow({
    where: { ...customizedScope(projectId), id: sourceRunId },
  });
  // All asset versions belong directly to the same confirmed script head.
  let parent = source;
  const seen = new Set<string>();
  while (
    parent.forkNodeId === 'SHOT_PROMPT' &&
    parent.parentWorkflowRunId &&
    !seen.has(parent.id)
  ) {
    seen.add(parent.id);
    parent = await tx.workflowRun.findFirstOrThrow({
      where: { ...customizedScope(projectId), id: parent.parentWorkflowRunId },
    });
  }
  const child = await tx.workflowRun.create({
    data: {
      ...customizedScope(projectId),
      status: 'PAUSED',
      activeKey: null,
      parentWorkflowRunId: parent.id,
      forkScriptId: source.forkScriptId,
      forkNodeId: 'SHOT_PROMPT',
      currentNodeId: 'SHOT_PROMPT',
      branchCreationKey: `assets:${taskId}`,
      branchLabel: '资产准备',
      branchPublishedAt: new Date(),
    },
  });
  const originals = await tx.workingArtifact.findMany({
    where: {
      projectId,
      workflowRunId: sourceRunId,
      nodeId: { in: ['SOURCE_IMPORT', 'INFORMATION_EXTRACTION', 'STORYBOARD'] },
      availability: 'AVAILABLE',
    },
    include: { dependencies: true, files: true },
  });
  const ids = new Map<string, string>();
  for (const a of originals) {
    const { id, dependencies: _d, files: _f, updatedAt: _u, ...data } = a;
    void _d;
    void _f;
    void _u;
    const copy = await tx.workingArtifact.create({
      data: {
        ...data,
        workflowRunId: child.id,
        sourceArtifactId: a.sourceArtifactId ?? id,
        sourceRunId: a.sourceRunId ?? sourceRunId,
        payload: a.payload as Prisma.InputJsonValue,
        metadata: a.metadata === null ? Prisma.JsonNull : (a.metadata as Prisma.InputJsonValue),
      },
    });
    ids.set(id, copy.id);
  }
  for (const a of originals) {
    for (const d of a.dependencies) {
      // Replace an inherited ownership link with this exact source snapshot;
      // sourceKey is unique per dependent artifact.
      if (d.sourceType === 'WORKING_ARTIFACT' && d.sourceKey === a.artifactKey) continue;
      const { id: _id, ...data } = d;
      void _id;
      await tx.workingArtifactDependency.create({
        data: {
          ...data,
          workflowRunId: child.id,
          dependentArtifactId: ids.get(a.id)!,
          sourceArtifactId: d.sourceArtifactId
            ? (ids.get(d.sourceArtifactId) ?? d.sourceArtifactId)
            : null,
        },
      });
    }
    await tx.workingArtifactDependency.create({
      data: {
        projectId,
        workflowRunId: child.id,
        dependentArtifactId: ids.get(a.id)!,
        sourceType: 'WORKING_ARTIFACT',
        sourceArtifactId: a.id,
        sourceNodeId: a.nodeId,
        sourceKey: a.artifactKey,
        sourceRevision: a.revision,
        sourceHash: a.contentHash,
      },
    });
    for (const f of a.files) {
      const { id: _id, ...data } = f;
      void _id;
      await tx.workingArtifactFile.create({
        data: { ...data, workflowRunId: child.id, workingArtifactId: ids.get(a.id)! },
      });
    }
  }
  // Do not hijack another branch the user selected while the model was running.
  if (source.activeKey === 'ACTIVE') {
    await tx.workflowRun.update({
      where: { id: source.id },
      data: { activeKey: null, status: 'PAUSED' },
    });
    await tx.workflowRun.update({
      where: { id: child.id },
      data: { activeKey: 'ACTIVE', status: 'ACTIVE' },
    });
  }
  return child.id;
}
