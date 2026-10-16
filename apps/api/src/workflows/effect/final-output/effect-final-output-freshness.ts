import type {
  EffectTemplateMixVariant,
  FinalOutputSnapshot,
  PackagingCheckpoint,
} from '@ai-marketing/contracts';
import {
  EFFECT_TEMPLATE_MIX_TRANSITION_DEFAULT_DURATION,
  effectTemplateMixContentDuration,
  effectTemplateMixPlacedContentDuration,
  effectVideoTransformSnapshot,
  packagingTimelineClips,
} from '@ai-marketing/contracts';
import { workflowStateHash } from '../../../platform/workflow/workflow-state-hash';
import { matchesVisualHash } from '../template-mix/effect-packaging.domain';

const renderPackagingHash = (cp: PackagingCheckpoint) =>
  workflowStateHash({
    voices: cp.voices ?? {},
    captionVoices: cp.captionVoices ?? {},
    music: cp.music ?? null,
    captions: cp.captions ?? [],
    captionFontSize: cp.captionFontSize ?? 16,
    captionBoxes: cp.captionBoxes ?? {},
  });

/** Only placed picture layers count; empty slot signs and editor metadata do not render. */
const placedPictureHash = (variant: EffectTemplateMixVariant) =>
  workflowStateHash(
    packagingTimelineClips(variant)
      .filter(({ slot }) => Boolean(variant.bindings[slot.id]))
      .map(({ slot, start, lane }) => ({
        slotId: slot.id,
        start,
        lane,
        duration: slot.duration,
        offset: variant.offsets[slot.id] ?? 0,
        transition: slot.transition,
        transitionDuration:
          slot.transitionDuration ??
          (slot.transition === '硬切' ? 0 : EFFECT_TEMPLATE_MIX_TRANSITION_DEFAULT_DURATION),
        transform: effectVideoTransformSnapshot(variant.videoTransforms?.[slot.id]),
      }))
      .sort((a, b) => a.start - b.start || a.lane - b.lane || a.slotId.localeCompare(b.slotId)),
  );

/** Shared by output cards and the branch tree. Never writes an artifact or launches a task. */
export function finalOutputSavedDraftDiffers(
  variant: EffectTemplateMixVariant,
  snapshot: FinalOutputSnapshot,
  latestPackaging?: PackagingCheckpoint,
): boolean {
  return (
    !matchesVisualHash(variant, snapshot.timeline.sourceTimelineHash, snapshot.timeline.variant) ||
    placedPictureHash(variant) !== placedPictureHash(snapshot.timeline.variant) ||
    Boolean(
      latestPackaging &&
      renderPackagingHash(latestPackaging) !== renderPackagingHash(snapshot.packaging),
    ) ||
    (variant.canvasRatio ?? null) !== (snapshot.timeline.variant.canvasRatio ?? null) ||
    workflowStateHash(variant.detachedAudios ?? []) !==
      workflowStateHash(snapshot.timeline.detachedAudios ?? []) ||
    (variant.originalVolume ?? snapshot.originalVolume) !== snapshot.originalVolume ||
    effectTemplateMixContentDuration(variant, snapshot.packaging) !== snapshot.timeline.duration
  );
}

/** The caller supplies artifacts resolved in this Run/template's source scope, never siblings. */
export function finalOutputConfirmedProjectIds(
  templateId: string,
  artifacts: readonly { nodeId?: string; artifactKey?: string; availability?: string }[],
): ReadonlySet<string> {
  const prefix = `timeline-project:${templateId}:`;
  const ids = new Set<string>();
  for (const artifact of artifacts) {
    if (
      artifact.nodeId === 'TEMPLATE_MIX' &&
      artifact.availability === 'AVAILABLE' &&
      artifact.artifactKey?.startsWith(prefix)
    )
      ids.add(artifact.artifactKey.slice(prefix.length));
  }
  return ids;
}

export function finalOutputSavedProjectChanges<T extends { id: string; variantId: string }>(
  variants: readonly EffectTemplateMixVariant[],
  items: readonly T[],
  confirmedVariantIds: ReadonlySet<string>,
  packaging: ReadonlyMap<string, PackagingCheckpoint> = new Map(),
) {
  return {
    added: variants.filter(
      (variant) =>
        !items.some((item) => item.variantId === variant.id) &&
        confirmedVariantIds.has(variant.id) &&
        effectTemplateMixPlacedContentDuration(variant, packaging.get(variant.id)) > 0,
    ),
    removedItemIds: items
      .filter((item) => !variants.some((variant) => variant.id === item.variantId))
      .map((item) => item.id),
  };
}

/** Unknown legacy snapshots are not evidence of a deletion or a paid re-render. */
export function finalOutputSavedBatchStale(
  run: {
    status: string;
    items: Array<{
      id: string;
      variantId: string;
      status: string;
      fileObjectId: string | null;
      assetId: string | null;
      snapshot: unknown;
    }>;
  },
  variants: readonly EffectTemplateMixVariant[] | null,
  packaging: ReadonlyMap<string, PackagingCheckpoint> = new Map(),
  sourceStaleVariantIds: ReadonlySet<string> = new Set(),
  confirmedVariantIds: ReadonlySet<string> = new Set(),
): boolean {
  if (!variants) return false;
  const membership = finalOutputSavedProjectChanges(
    variants,
    run.items,
    confirmedVariantIds,
    packaging,
  );
  if (membership.added.length || membership.removedItemIds.length) return true;
  if (['QUEUED', 'RUNNING'].includes(run.status)) return false;
  return run.items.some((item) => {
    const snapshot = item.snapshot as FinalOutputSnapshot | null;
    if (['FAILED', 'CANCELLED'].includes(item.status) && snapshot?.sourceDraft) return true;
    if (item.status !== 'COMPLETED') return false;
    const variant = variants.find((row) => row.id === item.variantId);
    if (
      !item.fileObjectId ||
      !item.assetId ||
      !variant ||
      !snapshot?.timeline?.variant ||
      !snapshot.packaging
    )
      return false;
    return (
      sourceStaleVariantIds.has(item.variantId) ||
      finalOutputSavedDraftDiffers(variant, snapshot, packaging.get(item.variantId))
    );
  });
}
