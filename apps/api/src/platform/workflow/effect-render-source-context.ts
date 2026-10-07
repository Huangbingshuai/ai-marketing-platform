import type { Prisma } from '../../generated/prisma/client';
import { effectRenderSourceOwner } from './effect-branch-freshness';

/** The shared pool belongs to its confirmed source, not a downstream Run's copied task rows. */
export async function confirmedEffectRenderSourceRun(
  db: Pick<Prisma.TransactionClient, 'workflowRun' | 'workingArtifact'>,
  projectId: string,
  workflowRunId: string,
): Promise<string> {
  const branches = await db.workflowRun.findMany({
    where: { projectId, workflow: 'EFFECT', workflowSpace: 'EFFECT' },
    select: { id: true, parentWorkflowRunId: true, forkNodeId: true,
      branchPublishedAt: true, editSessionNodeId: true },
  });
  const run = branches.find((branch) => branch.id === workflowRunId);
  // A live isolated edit owns its draft; never silently replace or publish it on a read.
  if (!run || run.editSessionNodeId || (run.parentWorkflowRunId && !run.branchPublishedAt))
    return workflowRunId;
  const artifacts = await db.workingArtifact.findMany({
    where: { projectId, workflowRunId: { in: branches.map((branch) => branch.id) },
      nodeId: 'SEGMENT_RENDER', availability: 'AVAILABLE' },
    select: { workflowRunId: true, nodeId: true, artifactKey: true, revision: true,
      metadata: true, payload: true, updatedAt: true },
  });
  return effectRenderSourceOwner(branches, workflowRunId, artifacts);
}
