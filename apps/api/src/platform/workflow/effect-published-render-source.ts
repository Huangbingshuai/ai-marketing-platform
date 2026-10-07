import { createHash } from 'node:crypto';
import type { EffectSegmentRenderRequestSnapshot } from '@ai-marketing/contracts';

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** A confirmed clip retains its own Prompt even while that upstream Prompt awaits a refresh. */
export function hasAdoptedRenderPrompt(payload: unknown): boolean {
  const clip = record(payload);
  const adopted = record(clip.adoptedPrompt);
  return (
    typeof clip.promptText === 'string' &&
    typeof adopted.promptContentHash === 'string' &&
    createHash('sha256').update(clip.promptText.trim()).digest('hex') === adopted.promptContentHash
  );
}

/** Read-only legacy recovery, proven by exact task, Run, Prompt and active file identity. */
export function recoverPublishedRenderPrompt<
  T extends { nodeId: string; workflowRunId: string; payload?: unknown },
>(
  artifact: T,
  tasks: readonly {
    id: string;
    workflowRunId: string;
    promptId: string;
    outputFileObjectId: string | null;
    requestSnapshot: unknown;
    generationRequestSnapshot: unknown;
  }[],
): T {
  if (artifact.nodeId !== 'SEGMENT_RENDER') return artifact;
  const recover = (value: unknown): unknown => {
    const clip = record(value);
    if (clip.adoptedPrompt || clip.importedMaterial || typeof clip.promptContentHash !== 'string')
      return value;
    const task = tasks.find(
      (row) =>
        row.id === clip.taskId &&
        row.workflowRunId === artifact.workflowRunId &&
        row.promptId === clip.promptId &&
        row.outputFileObjectId === clip.fileObjectId &&
        row.outputFileObjectId,
    );
    if (!task) return value;
    const requested = (task.generationRequestSnapshot ??
      task.requestSnapshot) as EffectSegmentRenderRequestSnapshot | null;
    const snapshot = requested?.adoptedInput ?? requested;
    if (
      !snapshot?.sourcePrompt ||
      typeof snapshot.promptText !== 'string' ||
      snapshot.promptContentHash !== clip.promptContentHash ||
      createHash('sha256').update(snapshot.promptText.trim()).digest('hex') !==
        clip.promptContentHash ||
      !snapshot.sharedPromptHash ||
      !snapshot.request?.duration
    )
      return value;
    const adoptedPrompt = snapshot.adoptedPrompt ?? {
      sourcePrompt: snapshot.sourcePrompt,
      promptContentHash: snapshot.promptContentHash,
      sharedPromptHash: snapshot.sharedPromptHash,
      targetDurationSeconds: snapshot.request.duration,
      primaryPurpose: snapshot.primaryPurpose,
      compatiblePurposes: snapshot.compatiblePurposes,
      ...(snapshot.creativeCore !== undefined ? { creativeCore: snapshot.creativeCore } : {}),
      ...(snapshot.dimensions !== undefined ? { dimensions: snapshot.dimensions } : {}),
    };
    return {
      ...clip,
      adoptedPrompt,
      promptText: snapshot.promptText,
      sourcePrompt: adoptedPrompt.sourcePrompt,
    };
  };
  const pool = record(artifact.payload);
  return {
    ...artifact,
    payload: Array.isArray(pool.clips)
      ? { ...pool, clips: pool.clips.map(recover) }
      : recover(artifact.payload),
  };
}

/** Consumer-only projection; the render node itself still displays its latest Prompt difference. */
export function publishedRenderSource<
  T extends {
    nodeId: string;
    artifactKey: string;
    freshness: string;
    availability: string;
    payload?: unknown;
    metadata?: unknown;
  },
>(artifact: T): T {
  if (
    artifact.nodeId !== 'SEGMENT_RENDER' ||
    artifact.availability !== 'AVAILABLE' ||
    record(artifact.metadata).promptSourcePending !== true
  )
    return artifact;
  const pool = record(artifact.payload);
  const proven = artifact.artifactKey.startsWith('render-clip:')
    ? hasAdoptedRenderPrompt(pool)
    : artifact.artifactKey.startsWith('render-batch:') &&
      Array.isArray(pool.clips) &&
      pool.clips.every((clip) => record(clip).importedMaterial || hasAdoptedRenderPrompt(clip));
  return proven ? { ...artifact, freshness: 'CURRENT' } : artifact;
}
