import type { EffectTemplateMixMaterial, EffectTemplateMixVariant } from '@ai-marketing/contracts';
import { stableJson } from './effect-template-mix-draft-race';

/** Server progress reads are not editor changes. Keep unchanged reactive/decoder identities. */
export const retainUnchangedMixValue = <T>(current: T | undefined, incoming: T): T =>
  current !== undefined && stableJson(current) === stableJson(incoming) ? current : incoming;

export const canRetainMixPlayback = (
  currentScope: string,
  nextScope: string,
  currentTemplateId: string,
  nextTemplateId: string,
  current: EffectTemplateMixVariant | null,
  incoming: EffectTemplateMixVariant | null,
  currentMaterials: EffectTemplateMixMaterial[],
  incomingMaterials: EffectTemplateMixMaterial[],
): boolean => {
  if (
    currentScope !== nextScope ||
    currentTemplateId !== nextTemplateId ||
    retainUnchangedMixValue(current, incoming) !== current
  )
    return false;
  return Object.entries(current?.bindings ?? {}).every(([slotId, id]) => {
    // Frozen adopted sources belong to the unchanged variant, not the latest library revision.
    if (current?.bindingSources?.[slotId]) return true;
    const revision = current?.bindingRevisions?.[slotId];
    const resolve = (materials: EffectTemplateMixMaterial[]) =>
      materials.find(
        (material) =>
          material.id === id && (revision === undefined || material.artifactRevision === revision),
      );
    const before = resolve(currentMaterials);
    const after = resolve(incomingMaterials);
    // A changed catalogue label/role is not a changed decoder input.
    return (
      before?.contentUrl === after?.contentUrl &&
      before?.fileObjectId === after?.fileObjectId &&
      before?.contentHash === after?.contentHash &&
      before?.artifactRevision === after?.artifactRevision &&
      before?.available === after?.available
    );
  });
};
