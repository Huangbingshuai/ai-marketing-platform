import type { WorkingArtifact } from '@ai-marketing/contracts';

const metadataRecord = (artifact: WorkingArtifact): Record<string, unknown> | null =>
  artifact.metadata && typeof artifact.metadata === 'object' && !Array.isArray(artifact.metadata)
    ? (artifact.metadata as Record<string, unknown>)
    : null;

const payloadRecord = (artifact: WorkingArtifact): Record<string, unknown> | null =>
  artifact.payload && typeof artifact.payload === 'object' && !Array.isArray(artifact.payload)
    ? (artifact.payload as Record<string, unknown>)
    : null;

const productIdFromArtifact = (artifact: WorkingArtifact): string | null => {
  const metadataProductId = metadataRecord(artifact)?.productId;
  if (typeof metadataProductId === 'string' && metadataProductId.trim())
    return metadataProductId.trim();
  const separatorIndex = artifact.artifactKey.indexOf(':');
  const keyProductId = separatorIndex >= 0 ? artifact.artifactKey.slice(separatorIndex + 1) : '';
  return keyProductId.trim() || null;
};

export const isRenderBatchArtifact = (artifact: WorkingArtifact): boolean =>
  artifact.artifactKey.startsWith('render-batch:');

const isRenderClipArtifact = (artifact: WorkingArtifact): boolean =>
  artifact.artifactKey.startsWith('render-clip:');

export const aggregateWorkspaceArtifacts = (
  artifacts: readonly WorkingArtifact[],
): WorkingArtifact[] => {
  const pooledProductIds = new Set(
    artifacts
      .filter(isRenderBatchArtifact)
      .map(productIdFromArtifact)
      .filter((productId): productId is string => productId !== null),
  );
  return artifacts.filter((artifact) => {
    if (!isRenderClipArtifact(artifact)) return true;
    const productId = productIdFromArtifact(artifact);
    return !productId || !pooledProductIds.has(productId);
  });
};

export const renderBatchClipCount = (artifact: WorkingArtifact): number => {
  if (!isRenderBatchArtifact(artifact)) return 0;
  const completedCount = metadataRecord(artifact)?.completedCount;
  if (typeof completedCount === 'number' && Number.isFinite(completedCount))
    return Math.max(0, Math.trunc(completedCount));
  const clips = payloadRecord(artifact)?.clips;
  if (Array.isArray(clips)) return clips.length;
  return Math.max(0, artifact.fileCount);
};
