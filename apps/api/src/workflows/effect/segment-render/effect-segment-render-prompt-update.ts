import { createHash } from 'node:crypto';
import { effectSegmentRenderPromptDifference } from '@ai-marketing/contracts';
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
  ...(snapshot.sourcePrompt ? { sourcePrompt: { ...snapshot.sourcePrompt } } : {}),
  promptContentHash: snapshot.promptContentHash,
  sharedPromptHash: snapshot.sharedPromptHash,
  targetDurationSeconds: snapshot.request.duration,
  primaryPurpose: snapshot.primaryPurpose,
  compatiblePurposes: [...snapshot.compatiblePurposes],
  ...(snapshot.creativeCore !== undefined ? { creativeCore: snapshot.creativeCore } : {}),
  ...(snapshot.dimensions !== undefined ? { dimensions: { ...snapshot.dimensions } } : {}),
});

export const confirmedPromptBaseline = (
  batch: EffectPromptBatchResult,
  promptId: string,
): EffectSegmentRenderPromptBaseline | null => {
  const item = batch.items.find(({ id }) => id === promptId);
  return item
    ? {
        promptContentHash: createHash('sha256').update(item.content.trim()).digest('hex'),
        sharedPromptHash:
          batch.sharedPrompt?.contentHash ?? batch.renderProfile.sharedConstraints.contentHash,
        targetDurationSeconds: item.targetDurationSeconds,
        primaryPurpose: item.primaryPurpose,
        compatiblePurposes: [...item.compatiblePurposes],
        creativeCore: item.creativeCore,
        dimensions: { ...item.dimensions },
      }
    : null;
};

export const renderPromptUpdateKind = (
  snapshot: EffectSegmentRenderRequestSnapshot,
  batch: EffectPromptBatchResult | null,
): EffectSegmentRenderUpdateKind | undefined => {
  if (snapshot.importedMaterial || !batch) return undefined;
  const baseline = snapshot.adoptedPrompt ?? renderPromptBaseline(snapshot);
  return effectSegmentRenderPromptDifference(
    baseline,
    confirmedPromptBaseline(batch, snapshot.promptId),
  );
};
