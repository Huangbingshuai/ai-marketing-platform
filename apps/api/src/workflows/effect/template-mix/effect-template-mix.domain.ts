import type {
  EffectTemplateMixAiClassification,
  EffectTemplateMixAiSelection,
  EffectTemplateMixMaterial,
  EffectTemplateMixSlot,
  EffectTemplateMixVariant,
  EffectTemplateMixWorkspace,
} from '@ai-marketing/contracts';
import { randomUUID } from 'node:crypto';

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export const materialFitsSlot = (
  material: EffectTemplateMixMaterial,
  slot: EffectTemplateMixSlot,
  offset = 0,
): boolean =>
  material.available &&
  (material.purpose === slot.purpose || material.compatiblePurposes.includes(slot.purpose)) &&
  Number.isFinite(offset) &&
  offset >= 0 &&
  material.duration + 0.001 >= slot.duration + offset;

/**
 * Fill every unlocked slot with a maximum matching. This prevents a flexible clip from
 * greedily occupying a slot whose later sibling has fewer candidates.
 */
export const fillVariant = (
  workspace: EffectTemplateMixWorkspace,
  variant: EffectTemplateMixVariant,
): void => {
  const fixed = new Set(variant.manualSlotIds);
  const used = new Set<string>();
  const assignment = new Map<string, string>();
  variant.conflictSlotIds = [];

  const usage = (materialId: string): number =>
    workspace.variants.filter(
      (candidate) =>
        candidate.id !== variant.id && Object.values(candidate.bindings).includes(materialId),
    ).length;
  const candidates = (slot: EffectTemplateMixSlot): EffectTemplateMixMaterial[] =>
    workspace.materials
      .filter((material) => materialFitsSlot(material, slot))
      .sort(
        (left, right) =>
          usage(left.id) - usage(right.id) ||
          Number(right.purpose === slot.purpose) - Number(left.purpose === slot.purpose) ||
          left.id.localeCompare(right.id),
      );

  for (const slot of variant.slots.filter(({ id }) => fixed.has(id))) {
    const material = workspace.materials.find(({ id }) => id === variant.bindings[slot.id]);
    if (
      !material ||
      used.has(material.id) ||
      !materialFitsSlot(material, slot, variant.offsets[slot.id] ?? 0)
    ) {
      variant.conflictSlotIds.push(slot.id);
    }
    if (material) used.add(material.id);
  }

  const bind = (slot: EffectTemplateMixSlot, seen: Set<string>): boolean => {
    for (const material of candidates(slot)) {
      if (used.has(material.id) || seen.has(material.id)) continue;
      seen.add(material.id);
      const previousSlotId = assignment.get(material.id);
      const previousSlot = previousSlotId
        ? variant.slots.find(({ id }) => id === previousSlotId)
        : undefined;
      if (!previousSlot || bind(previousSlot, seen)) {
        assignment.set(material.id, slot.id);
        return true;
      }
    }
    return false;
  };

  for (const slot of variant.slots.filter(({ id }) => !fixed.has(id))) {
    delete variant.bindings[slot.id];
    delete variant.bindingRevisions[slot.id];
    delete variant.offsets[slot.id];
    if (variant.bindingMetadata) delete variant.bindingMetadata[slot.id];
    if (!bind(slot, new Set())) variant.conflictSlotIds.push(slot.id);
  }
  for (const [materialId, slotId] of assignment) {
    const material = workspace.materials.find(({ id }) => id === materialId)!;
    variant.bindings[slotId] = materialId;
    variant.bindingRevisions[slotId] = material.artifactRevision;
    variant.offsets[slotId] = 0;
  }
};

export const createVariant = (workspace: EffectTemplateMixWorkspace): EffectTemplateMixVariant => {
  const variant: EffectTemplateMixVariant = {
    id: randomUUID(),
    name: workspace.template.name + ' · ' + (workspace.variants.length + 1),
    appliedTemplateVersion: workspace.template.editVersion,
    slots: clone(workspace.template.slots),
    bindings: {},
    bindingRevisions: {},
    offsets: {},
    bindingMetadata: {},
    manualSlotIds: [],
    conflictSlotIds: [],
    status: 'CURRENT',
    captions: [],
    subtitleStyle: 'standard',
    bgm: null,
    voice: null,
    originalVolume: 1,
  };
  fillVariant(workspace, variant);
  return variant;
};

/** Recombine validated AI trims without spending another model call. */
export const composeAlgorithmicVariants = (
  workspace: EffectTemplateMixWorkspace,
  limit = 100 - workspace.variants.length,
): EffectTemplateMixVariant[] => {
  const slots = workspace.template.slots;
  type Candidate = {
    material: EffectTemplateMixMaterial;
    offset: number;
    metadata: NonNullable<EffectTemplateMixVariant['bindingMetadata']>[string];
  };
  const materials = new Map(workspace.materials.map((material) => [material.id, material]));
  const pools = slots.map((slot) => {
    const byMaterial = new Map<string, Candidate>();
    for (const variant of workspace.variants) {
      const sourceSlot = variant.slots.find(({ id }) => id === slot.id);
      const material = materials.get(variant.bindings[slot.id] ?? '');
      const metadata = variant.bindingMetadata?.[slot.id];
      const offset = variant.offsets[slot.id] ?? 0;
      if (
        sourceSlot?.role !== slot.role ||
        !material?.available ||
        variant.bindingRevisions[slot.id] !== material.artifactRevision ||
        metadata?.source !== 'AI' ||
        !Number.isFinite(offset) ||
        offset < 0 ||
        material.duration + 0.001 < offset + slot.duration
      )
        continue;
      const previous = byMaterial.get(material.id);
      if (!previous || (metadata.matchScore ?? 0) > (previous.metadata.matchScore ?? 0))
        byMaterial.set(material.id, { material, offset, metadata });
    }
    return [...byMaterial.values()].sort((left, right) =>
      left.material.id.localeCompare(right.material.id),
    );
  });
  if (pools.some((pool) => pool.length === 0)) return [];

  const signature = (variant: EffectTemplateMixVariant): string =>
    slots.map((slot) => variant.bindings[slot.id] ?? '').join('|');
  const seen = new Set(workspace.variants.map(signature));
  const usage = slots.map((slot) => {
    const counts = new Map<string, number>();
    for (const variant of workspace.variants) {
      const id = variant.bindings[slot.id];
      if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return counts;
  });
  const tieBreak = (id: string, index: number, salt: number, slotIndex: number): number => {
    let value = 2166136261;
    const key = `${id}:${index}:${salt}:${slotIndex}`;
    for (let position = 0; position < key.length; position += 1)
      value = Math.imul(value ^ key.charCodeAt(position), 16777619);
    return value >>> 0;
  };
  const created: EffectTemplateMixVariant[] = [];
  for (let index = 0; index < Math.max(0, limit); index += 1) {
    let picks: Candidate[] | null = null;
    for (let salt = 0; salt < 500; salt += 1) {
      const used = new Set<string>();
      const attempt: Candidate[] = [];
      for (let slotIndex = 0; slotIndex < slots.length; slotIndex += 1) {
        const pool = pools[slotIndex]!;
        const ordered = [...pool].sort(
          (left, right) =>
            (usage[slotIndex]!.get(left.material.id) ?? 0) -
              (usage[slotIndex]!.get(right.material.id) ?? 0) ||
            // Deterministic shuffling of equally used clips avoids cyclic duplicate tuples.
            tieBreak(left.material.id, index, salt, slotIndex) -
              tieBreak(right.material.id, index, salt, slotIndex) ||
            (right.metadata.matchScore ?? 0) - (left.metadata.matchScore ?? 0),
        );
        const candidate = ordered.find(({ material }) => !used.has(material.id));
        if (!candidate) break;
        used.add(candidate.material.id);
        attempt.push(candidate);
      }
      if (attempt.length !== slots.length) continue;
      const key = attempt.map(({ material }) => material.id).join('|');
      if (!seen.has(key)) {
        seen.add(key);
        picks = attempt;
        break;
      }
    }
    if (!picks) break;
    const variant = createVariant(workspace);
    variant.name =
      workspace.template.name + ' · ' + (workspace.variants.length + created.length + 1);
    variant.bindings = {};
    variant.bindingRevisions = {};
    variant.offsets = {};
    variant.bindingMetadata = {};
    variant.conflictSlotIds = [];
    for (let slotIndex = 0; slotIndex < slots.length; slotIndex += 1) {
      const slot = slots[slotIndex]!;
      const pick = picks[slotIndex]!;
      variant.bindings[slot.id] = pick.material.id;
      variant.bindingRevisions[slot.id] = pick.material.artifactRevision;
      variant.offsets[slot.id] = pick.offset;
      variant.bindingMetadata[slot.id] = clone(pick.metadata);
      const counts = usage[slotIndex]!;
      counts.set(pick.material.id, (counts.get(pick.material.id) ?? 0) + 1);
    }
    created.push(variant);
  }
  return created;
};

export const maximumWeightedAiSelection = (
  slots: EffectTemplateMixSlot[],
  materials: Array<Pick<EffectTemplateMixMaterial, 'id' | 'duration' | 'available'>>,
  classifications: EffectTemplateMixAiClassification[],
  lockedMaterialIds: ReadonlySet<string> = new Set(),
  reuseCounts: ReadonlyMap<string, number> = new Map(),
): EffectTemplateMixAiSelection[] | null => {
  const candidates = materials
    .filter((material) => material.available && !lockedMaterialIds.has(material.id))
    .sort((left, right) => left.id.localeCompare(right.id));
  const byMaterial = new Map(classifications.map((item) => [item.materialId, item]));
  type State = { score: number; picks: Array<{ slotIndex: number; materialId: string }> };
  let states = new Map<number, State>([[0, { score: 0, picks: [] }]]);
  for (const material of candidates) {
    const classification = byMaterial.get(material.id);
    if (!classification) continue;
    const next = new Map(states);
    for (const [mask, state] of states) {
      for (let slotIndex = 0; slotIndex < slots.length; slotIndex += 1) {
        const bit = 1 << slotIndex;
        const slot = slots[slotIndex]!;
        if ((mask & bit) !== 0 || material.duration + 0.001 < slot.duration) continue;
        const raw = classification.scores[slot.role];
        if (!Number.isFinite(raw)) continue;
        const score = state.score + raw - (reuseCounts.get(material.id) ?? 0) * 0.02;
        const candidate = {
          score,
          picks: [...state.picks, { slotIndex, materialId: material.id }],
        };
        const key = mask | bit;
        const current = next.get(key);
        if (!current || score > current.score + 1e-9) next.set(key, candidate);
      }
    }
    states = next;
  }
  const result = states.get((1 << slots.length) - 1);
  if (!result) return null;
  return result.picks
    .sort((left, right) => left.slotIndex - right.slotIndex)
    .map(({ slotIndex, materialId }) => {
      const slot = slots[slotIndex]!;
      const classification = byMaterial.get(materialId)!;
      const matchScore = classification.scores[slot.role];
      return {
        slotId: slot.id,
        role: slot.role,
        materialId,
        matchScore,
        matchLevel: matchScore < 0.6 ? 'LOW_MATCH' : 'NORMAL',
        classificationReason: classification.reasons?.[slot.role]?.trim() || '模型未提供说明',
        duration: slot.duration,
      };
    });
};

export const maximumWeightedAiSelectionBatch = (
  slots: EffectTemplateMixSlot[],
  materials: Array<Pick<EffectTemplateMixMaterial, 'id' | 'duration' | 'available'>>,
  classifications: EffectTemplateMixAiClassification[],
  unavailableMaterialIds: ReadonlySet<string> = new Set(),
  reuseCounts: ReadonlyMap<string, number> = new Map(),
  maxGroups = 20,
): EffectTemplateMixAiSelection[][] => {
  const consumed = new Set(unavailableMaterialIds);
  const groups: EffectTemplateMixAiSelection[][] = [];
  while (groups.length < Math.max(0, maxGroups)) {
    const selection = maximumWeightedAiSelection(
      slots,
      materials,
      classifications,
      consumed,
      reuseCounts,
    );
    if (!selection) break;
    const variantIndex = groups.length;
    const group = selection.map((item) => ({ ...item, variantIndex }));
    groups.push(group);
    group.forEach(({ materialId }) => consumed.add(materialId));
  }
  return groups;
};

export const applyVariantToTemplate = (
  workspace: EffectTemplateMixWorkspace,
  sourceVariant: EffectTemplateMixVariant,
  syncOtherVariants: boolean,
): { conflicts: number; synced: number } => {
  workspace.template.slots = clone(sourceVariant.slots);
  workspace.template.editVersion += 1;
  workspace.editVersion += 1;
  sourceVariant.appliedTemplateVersion = workspace.template.editVersion;
  sourceVariant.status = 'CURRENT';

  let conflicts = 0;
  let synced = 0;
  for (const variant of workspace.variants) {
    if (variant.id === sourceVariant.id) continue;
    variant.status = 'PENDING';
    if (!syncOtherVariants) continue;

    variant.slots = clone(workspace.template.slots);
    const slotIds = new Set(variant.slots.map(({ id }) => id));
    variant.bindings = Object.fromEntries(
      Object.entries(variant.bindings).filter(([slotId]) => slotIds.has(slotId)),
    );
    variant.bindingRevisions = Object.fromEntries(
      Object.entries(variant.bindingRevisions).filter(([slotId]) => slotIds.has(slotId)),
    );
    variant.offsets = Object.fromEntries(
      Object.entries(variant.offsets).filter(([slotId]) => slotIds.has(slotId)),
    );
    variant.bindingMetadata = Object.fromEntries(
      Object.entries(variant.bindingMetadata ?? {}).filter(([slotId]) => slotIds.has(slotId)),
    );
    variant.manualSlotIds = variant.manualSlotIds.filter((slotId) => slotIds.has(slotId));
    const used = new Set<string>();
    variant.conflictSlotIds = [];
    for (const slot of variant.slots) {
      const materialId = variant.bindings[slot.id];
      const material = workspace.materials.find(({ id }) => id === materialId);
      const offset = variant.offsets[slot.id] ?? 0;
      if (
        !material ||
        !material.available ||
        used.has(material.id) ||
        offset < 0 ||
        offset + slot.duration > material.duration + 0.001
      )
        variant.conflictSlotIds.push(slot.id);
      if (material) used.add(material.id);
    }
    variant.appliedTemplateVersion = workspace.template.editVersion;
    variant.status = 'SYNCED';
    conflicts += variant.conflictSlotIds.length;
    synced += 1;
  }
  return { conflicts, synced };
};
