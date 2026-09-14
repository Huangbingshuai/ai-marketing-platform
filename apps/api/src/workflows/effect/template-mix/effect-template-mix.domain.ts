import type {
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
    variant.manualSlotIds = variant.manualSlotIds.filter((slotId) => slotIds.has(slotId));
    fillVariant(workspace, variant);
    variant.appliedTemplateVersion = workspace.template.editVersion;
    variant.status = 'SYNCED';
    conflicts += variant.conflictSlotIds.length;
    synced += 1;
  }
  return { conflicts, synced };
};
