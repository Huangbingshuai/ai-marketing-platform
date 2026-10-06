import type { EffectSegmentImportDraft } from '@ai-marketing/contracts';

/** Polling updates task status; only successful recognition replaces editable fields. */
export function applyEffectSegmentImportRecognition(
  draft: EffectSegmentImportDraft,
  incoming: EffectSegmentImportDraft,
): void {
  const { promptText, primaryPurpose, compatiblePurposes, creativeCore, dimensions, ...state } =
    incoming;
  Object.assign(draft, state);
  if (incoming.descriptionStatus === 'COMPLETED')
    Object.assign(draft, {
      promptText,
      primaryPurpose,
      compatiblePurposes: [...(compatiblePurposes ?? [])],
      creativeCore: creativeCore ?? '',
      dimensions: { ...dimensions },
    });
}
