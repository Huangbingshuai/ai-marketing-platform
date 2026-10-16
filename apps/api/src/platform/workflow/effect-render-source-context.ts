import type { Prisma, WorkingArtifact } from '../../generated/prisma/client';
import { effectRenderPromptSource, effectRenderSourceOwner } from './effect-branch-freshness';

/** Resolve the same confirmed Prompt before cloning an editor and before saving it. */
export async function confirmedEffectPromptEditSource(
  db: Pick<Prisma.TransactionClient, 'workflowRun' | 'workingArtifact'>,
  projectId: string,
  workflowRunId: string,
  viewing: WorkingArtifact,
): Promise<WorkingArtifact> {
  const owner = await confirmedEffectRenderSourceRun(db, projectId, workflowRunId);
  const pools = await db.workingArtifact.findMany({
    where: {
      projectId,
      workflowRunId: owner,
      nodeId: 'SEGMENT_RENDER',
      artifactKey: { startsWith: 'render-batch:' },
      availability: 'AVAILABLE',
    },
  });
  // Multi-product historical pools require explicit mapping, never a label/order guess.
  if (pools.length !== 1) return viewing;
  const source = (
    pools[0]!.payload as {
      sourcePrompt?: {
        artifactId?: string;
        revision?: number;
        contentHash?: string;
      };
    } | null
  )?.sourcePrompt;
  if (!source?.artifactId) return viewing;
  return (
    (await confirmedEffectRenderPromptArtifact(db, projectId, workflowRunId, viewing, {
      workflowRunId: owner,
      sourcePromptArtifactId: source.artifactId,
      ...(source.revision !== undefined ? { sourcePromptRevision: source.revision } : {}),
      ...(source.contentHash !== undefined ? { sourcePromptHash: source.contentHash } : {}),
    })) ?? viewing
  );
}

/** Shared by reads, refresh confirmation and isolated-edit preparation. */
export async function confirmedEffectRenderPromptArtifact(
  db: Pick<Prisma.TransactionClient, 'workflowRun' | 'workingArtifact'>,
  projectId: string,
  workflowRunId: string,
  viewing: WorkingArtifact | null,
  render: {
    workflowRunId: string;
    sourcePromptArtifactId: string;
    sourcePromptRevision?: number;
    sourcePromptHash?: string;
  } | null,
): Promise<WorkingArtifact | null> {
  if (!render || render.sourcePromptArtifactId === viewing?.id) return viewing;
  const branches = await db.workflowRun.findMany({
    where: { projectId, workflow: 'EFFECT', workflowSpace: 'EFFECT' },
    select: {
      id: true,
      parentWorkflowRunId: true,
      forkNodeId: true,
      branchPublishedAt: true,
      editSessionNodeId: true,
    },
  });
  const run = branches.find((row) => row.id === workflowRunId);
  // A draft's inputs are frozen/remapped together; a read must not switch its source.
  if (!run || run.editSessionNodeId || (run.parentWorkflowRunId && !run.branchPublishedAt))
    return viewing;
  const adopted = await db.workingArtifact.findFirst({
    where: {
      projectId,
      id: render.sourcePromptArtifactId,
      nodeId: 'PROMPT_GENERATION',
    },
  });
  const selected = effectRenderPromptSource(
    branches,
    {
      id: 'read-source',
      workflowRunId: render.workflowRunId,
      nodeId: 'SEGMENT_RENDER',
      artifactKey: 'render-batch:read-source',
      revision: 0,
      freshness: 'CURRENT',
      payload: {
        sourcePrompt: {
          artifactId: render.sourcePromptArtifactId,
          revision: render.sourcePromptRevision,
          contentHash: render.sourcePromptHash,
        },
      },
    },
    viewing ?? undefined,
    adopted ? [adopted] : [],
  );
  return selected ?? null;
}

/** The shared pool belongs to its confirmed source, not a downstream Run's copied task rows. */
export async function confirmedEffectRenderSourceRun(
  db: Pick<Prisma.TransactionClient, 'workflowRun' | 'workingArtifact'>,
  projectId: string,
  workflowRunId: string,
): Promise<string> {
  const branches = await db.workflowRun.findMany({
    where: { projectId, workflow: 'EFFECT', workflowSpace: 'EFFECT' },
    select: {
      id: true,
      parentWorkflowRunId: true,
      forkNodeId: true,
      branchPublishedAt: true,
      editSessionNodeId: true,
    },
  });
  const run = branches.find((branch) => branch.id === workflowRunId);
  // A live isolated edit owns its draft; never silently replace or publish it on a read.
  if (!run || run.editSessionNodeId || (run.parentWorkflowRunId && !run.branchPublishedAt))
    return workflowRunId;
  const artifacts = await db.workingArtifact.findMany({
    where: {
      projectId,
      workflowRunId: { in: branches.map((branch) => branch.id) },
      nodeId: 'SEGMENT_RENDER',
      availability: 'AVAILABLE',
    },
    select: {
      workflowRunId: true,
      nodeId: true,
      artifactKey: true,
      revision: true,
      metadata: true,
      payload: true,
      updatedAt: true,
    },
  });
  return effectRenderSourceOwner(branches, workflowRunId, artifacts);
}
