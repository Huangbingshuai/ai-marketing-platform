import {
  CUSTOMIZED_BRIEF_ARTIFACT_KEY,
  isCustomizedBrief,
  type CustomizedBriefCandidate,
} from '@ai-marketing/contracts';
import type { Prisma } from '../../generated/prisma/client';
import { workflowStateHash } from './workflow-state-hash';

/** Resolve only the saved Brief lineage, never another script's latest extraction. GET stays read-only. */
export async function readCustomizedExtractionResult(
  tx: Prisma.TransactionClient,
  projectId: string,
  workflowRunId: string,
  sourceFingerprint?: string,
) {
  const local = await tx.customizedExtractionResult.findUnique({
    where: { projectId_workflowRunId: { projectId, workflowRunId } },
  });
  if (local) return { record: local, inherited: false, evidenceMatches: true };

  const brief = await tx.workingArtifact.findFirst({
    where: {
      projectId,
      workflowRunId,
      nodeId: 'INFORMATION_EXTRACTION',
      artifactKey: CUSTOMIZED_BRIEF_ARTIFACT_KEY,
      availability: 'AVAILABLE',
    },
    include: { dependencies: true },
  });
  if (!brief || !isCustomizedBrief(brief.payload)) return null;

  const pending = [brief];
  const visited = new Set<string>();
  while (pending.length) {
    const artifact = pending.shift()!;
    if (visited.has(artifact.id)) continue;
    visited.add(artifact.id);
    if (artifact.workflowRunId !== workflowRunId) {
      const record = await tx.customizedExtractionResult.findUnique({
        where: { projectId_workflowRunId: { projectId, workflowRunId: artifact.workflowRunId } },
      });
      if (record) {
        const draft = record.draftResult as unknown as CustomizedBriefCandidate;
        const evidenceMatches =
          workflowStateHash(draft.fields) === workflowStateHash(brief.payload) &&
          (!sourceFingerprint || record.sourceFingerprint === sourceFingerprint);
        // The origin's working draft may have advanced since this branch was frozen.
        // Keep the branch's confirmed fields, and do not attach evidence for different content.
        const candidate: CustomizedBriefCandidate = {
          fields: brief.payload,
          fieldSources: evidenceMatches ? draft.fieldSources : {},
          issues: evidenceMatches ? draft.issues : [],
        };
        return {
          inherited: true,
          evidenceMatches,
          record: {
            ...record,
            draftResult: candidate as unknown as Prisma.JsonValue,
            generatedResult: evidenceMatches
              ? record.generatedResult
              : (candidate as unknown as Prisma.JsonValue),
            manualOverrides: evidenceMatches ? record.manualOverrides : {},
          },
        };
      }
    }
    const inheritedIds = artifact.dependencies
      .filter(
        (d) =>
          d.sourceType === 'WORKING_ARTIFACT' &&
          d.sourceKey === CUSTOMIZED_BRIEF_ARTIFACT_KEY &&
          d.sourceArtifactId,
      )
      .map((d) => d.sourceArtifactId!);
    if (artifact.sourceArtifactId) inheritedIds.push(artifact.sourceArtifactId);
    if (!inheritedIds.length) continue;
    const origins = await tx.workingArtifact.findMany({
      where: {
        projectId,
        id: { in: inheritedIds },
        artifactKey: CUSTOMIZED_BRIEF_ARTIFACT_KEY,
        nodeId: 'INFORMATION_EXTRACTION',
        workflowRun: { workflow: 'CUSTOMIZED', workflowSpace: 'CUSTOMIZED_PROJECT' },
      },
      include: { dependencies: true },
    });
    // Prefer an immediate frozen dependency over the oldest provenance pointer.
    origins.sort((a, b) => inheritedIds.indexOf(a.id) - inheritedIds.indexOf(b.id));
    pending.push(...origins);
  }
  return null;
}
