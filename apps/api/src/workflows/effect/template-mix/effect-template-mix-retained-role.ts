import type { EffectTemplateMixMaterial } from '@ai-marketing/contracts';

type FrozenRoleSource = {
  id: string;
  fileObjectId: string;
  promptId: string;
  prompt: string;
};

/** Retain a confirmed purpose by identity, never an old trim or visual assessment. */
export function retainedRoleMaterials<
  T extends Pick<
    EffectTemplateMixMaterial,
    'id' | 'fileObjectId' | 'sourcePromptId' | 'promptText' | 'replacesMaterialIds'
  >,
>(frozen: FrozenRoleSource, materials: readonly T[]): T[] {
  const candidates = materials.filter(
    (material) =>
      material.id === frozen.id ||
      material.replacesMaterialIds?.includes(frozen.id) ||
      (Boolean(material.sourcePromptId) && material.sourcePromptId === frozen.promptId) ||
      (material.fileObjectId === frozen.fileObjectId && material.promptText === frozen.prompt),
  );
  // Multiple live files for one identity are ambiguous; do not select an arbitrary head.
  return new Set(candidates.map((material) => material.fileObjectId)).size === 1
    ? candidates.slice(0, 1)
    : [];
}
