import { packagingVisualTimeline } from '@ai-marketing/contracts';
import type { EffectTemplateMixVariant, PackagingItem } from '@ai-marketing/contracts';

type PackagingSourceTimeline = PackagingItem['sourceVisualTimeline'];

/**
 * Packaging audio follows the source clips and their cuts, not the user's later picture edit.
 * Keep this projection aligned with the API's visualHash source projection: lane, position and
 * transition edits stay live while binding, source cut, duration and detached source audio matter.
 */
function sourceIdentity(timeline: PackagingSourceTimeline): string {
  return JSON.stringify({
    id: timeline.id,
    slots: timeline.slots.map(({ id, duration }) => ({ id, duration })),
    bindings: timeline.bindings,
    bindingRevisions: timeline.bindingRevisions,
    offsets: timeline.offsets,
  });
}

export function packagingSourceMatches(
  source: PackagingSourceTimeline,
  variant: EffectTemplateMixVariant,
): boolean {
  return sourceIdentity(source) === sourceIdentity(packagingVisualTimeline(variant));
}
