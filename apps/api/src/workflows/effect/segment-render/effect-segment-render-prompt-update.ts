import { createHash } from 'node:crypto';
import type {
  EffectPromptBatchResult,
  EffectSegmentRenderPromptBaseline,
  EffectSegmentRenderRequestSnapshot,
  EffectSegmentRenderUpdateKind,
} from '@ai-marketing/contracts';

/** Legacy snapshots have no creative metadata: unknown fields are not invented differences. */
export const renderPromptBaseline = (
  snapshot: EffectSegmentRenderRequestSnapshot,
): EffectSegmentRenderPromptBaseline => ({
  promptContentHash: snapshot.promptContentHash,
  sharedPromptHash: snapshot.sharedPromptHash,
  targetDurationSeconds: snapshot.request.duration,
  primaryPurpose: snapshot.primaryPurpose,
  compatiblePurposes: [...snapshot.compatiblePurposes],
  ...(snapshot.creativeCore !== undefined ? { creativeCore: snapshot.creativeCore } : {}),
  ...(snapshot.dimensions !== undefined ? { dimensions: { ...snapshot.dimensions } } : {}),
});

export const renderPromptUpdateKind = (
  snapshot: EffectSegmentRenderRequestSnapshot,
  batch: EffectPromptBatchResult | null,
): EffectSegmentRenderUpdateKind | undefined => {
  if (snapshot.importedMaterial || !batch) return undefined;
  const item = batch.items.find(({ id }) => id === snapshot.promptId);
  if (!item) return 'REMOVE';
  const baseline = snapshot.adoptedPrompt ?? renderPromptBaseline(snapshot);
  if (
    createHash('sha256').update(item.content.trim()).digest('hex') !== baseline.promptContentHash ||
    item.targetDurationSeconds !== baseline.targetDurationSeconds ||
    (batch.sharedPrompt?.contentHash ?? batch.renderProfile.sharedConstraints.contentHash) !==
      baseline.sharedPromptHash
  )
    return 'RENDER';
  if (
    item.primaryPurpose !== baseline.primaryPurpose ||
    JSON.stringify([...item.compatiblePurposes].sort()) !==
      JSON.stringify([...baseline.compatiblePurposes].sort()) ||
    (baseline.creativeCore !== undefined && item.creativeCore !== baseline.creativeCore) ||
    (baseline.dimensions !== undefined &&
      Object.entries(baseline.dimensions).some(
        ([key, value]) => item.dimensions[key as keyof typeof item.dimensions] !== value,
      ))
  )
    return 'METADATA';
  return undefined;
};
