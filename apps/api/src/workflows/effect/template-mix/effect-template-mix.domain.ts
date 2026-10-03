import type {
  EffectTemplateMixAiClassification,
  EffectTemplateMixAiSelection,
  EffectTemplateMixMaterial,
  EffectTemplateMixRole,
  EffectTemplateMixSlot,
  EffectTemplateMixVariant,
  EffectTemplateMixWorkspace,
} from '@ai-marketing/contracts';
import { syncEffectTemplateMixVariantSlots } from '@ai-marketing/contracts';
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

export const createEmptyVariant = (
  workspace: EffectTemplateMixWorkspace,
): EffectTemplateMixVariant => ({
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
});

export const createVariant = (workspace: EffectTemplateMixWorkspace): EffectTemplateMixVariant => {
  const variant = createEmptyVariant(workspace);
  fillVariant(workspace, variant);
  return variant;
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

type AssignedPoolItem = {
  materialId: string;
  duration: number;
  matchScore: number;
  reason: string;
};

const toSelection = (
  slot: { id: string; role: EffectTemplateMixRole; duration: number },
  item: AssignedPoolItem,
): EffectTemplateMixAiSelection => ({
  slotId: slot.id,
  role: slot.role,
  materialId: item.materialId,
  matchScore: item.matchScore,
  matchLevel: item.matchScore < 0.6 ? 'LOW_MATCH' : 'NORMAL',
  classificationReason: item.reason,
  duration: slot.duration,
});

/**
 * Hard-assign every classified material to exactly one slot role, then build a
 * duration-feasible, score-sorted candidate pool per role. Matching may only draw
 * from the role's own pool — cross-slot borrowing is forbidden.
 */
export const buildAssignedPools = (
  slots: Array<{ id: string; role: EffectTemplateMixRole; duration: number }>,
  materials: Array<Pick<EffectTemplateMixMaterial, 'id' | 'duration' | 'available'>>,
  classifications: EffectTemplateMixAiClassification[],
  lockedMaterialIds: ReadonlySet<string> = new Set(),
  fixedRoles: Readonly<Record<string, EffectTemplateMixRole>> = {},
): Map<EffectTemplateMixRole, AssignedPoolItem[]> => {
  const byMaterial = new Map(materials.map((material) => [material.id, material]));
  const eligible = classifications.filter((item) => {
    const material = byMaterial.get(item.materialId);
    const fixed = fixedRoles[item.materialId];
    return (
      Boolean(material?.available) &&
      !lockedMaterialIds.has(item.materialId) &&
      (!fixed || slots.some((slot) => slot.role === fixed))
    );
  });
  const feasibleRoles = new Map(
    eligible.map((item) => [
      item.materialId,
      new Set(
        slots
          .filter((slot) => byMaterial.get(item.materialId)!.duration + 0.001 >= slot.duration)
          .map((slot) => slot.role),
      ),
    ]),
  );
  const assignment = balancedSlotAssignment(
    slots.map((slot) => slot.role),
    eligible,
    feasibleRoles,
    fixedRoles,
  );
  const slotByRole = new Map(slots.map((slot) => [slot.role, slot]));
  const pools = new Map<EffectTemplateMixRole, AssignedPoolItem[]>(
    slots.map((slot) => [slot.role, []]),
  );
  for (const item of eligible) {
    const role = assignment.get(item.materialId);
    if (!role) continue;
    const slot = slotByRole.get(role);
    const material = byMaterial.get(item.materialId)!;
    if (!slot || material.duration + 0.001 < slot.duration) continue;
    pools.get(role)!.push({
      materialId: item.materialId,
      duration: material.duration,
      matchScore: item.scores[role],
      reason: item.reasons?.[role]?.trim() || '模型未提供说明',
    });
  }
  for (const items of pools.values()) {
    items.sort(
      (left, right) =>
        right.matchScore - left.matchScore || left.materialId.localeCompare(right.materialId),
    );
  }
  return pools;
};

/**
 * Fill a single target variant's unlocked slots, each drawing only from its own
 * hard-assigned pool. A material is eligible for exactly one role, and roles are
 * distinct across slots, so no cross-slot collision can occur within one variant.
 */
export const selectAssignedVariant = (
  slots: Array<{ id: string; role: EffectTemplateMixRole; duration: number }>,
  materials: Array<Pick<EffectTemplateMixMaterial, 'id' | 'duration' | 'available'>>,
  classifications: EffectTemplateMixAiClassification[],
  lockedMaterialIds: ReadonlySet<string> = new Set(),
  reuseCounts: ReadonlyMap<string, number> = new Map(),
  fixedRoles: Readonly<Record<string, EffectTemplateMixRole>> = {},
): EffectTemplateMixAiSelection[] => {
  const pools = buildAssignedPools(
    slots,
    materials,
    classifications,
    lockedMaterialIds,
    fixedRoles,
  );
  const selections: EffectTemplateMixAiSelection[] = [];
  for (const slot of slots) {
    const pool = pools.get(slot.role) ?? [];
    if (!pool.length) continue;
    const best = pool.reduce((current, item) => {
      const currentAdjusted =
        current.matchScore - (reuseCounts.get(current.materialId) ?? 0) * 0.02;
      const adjusted = item.matchScore - (reuseCounts.get(item.materialId) ?? 0) * 0.02;
      return adjusted > currentAdjusted ? item : current;
    });
    selections.push(toSelection(slot, best));
  }
  return selections;
};

/** Default pairwise overlap budget: two variants may share at most two slots' clips. */
export const MAX_SLOT_REUSE_OVERLAP = 2;

/**
 * Enumerate as many six-slot variants as the material pool allows, reusing clips
 * across variants while guaranteeing any two variants share at most `maxOverlap`
 * same-slot clips. The hard slot assignment collapses "撞一个槽位" into "共享一条素材",
 * because a clip can only ever appear on its assigned slot.
 *
 * Existing variants seed the collision sets so newly generated projects stay within
 * budget against what is already on the timeline, and least-used clips are preferred to
 * spread reuse before any clip needs to be shared a third time.
 */
export const enumerateAssignedVariants = (
  slots: Array<{ id: string; role: EffectTemplateMixRole; duration: number }>,
  materials: Array<Pick<EffectTemplateMixMaterial, 'id' | 'duration' | 'available'>>,
  classifications: EffectTemplateMixAiClassification[],
  existingGroups: ReadonlyArray<ReadonlyArray<{ slotId: string; materialId: string }>> = [],
  maxVariants = 0,
  maxOverlap = MAX_SLOT_REUSE_OVERLAP,
  fixedRoles: Readonly<Record<string, EffectTemplateMixRole>> = {},
): EffectTemplateMixAiSelection[][] => {
  const pools = buildAssignedPools(slots, materials, classifications, new Set(), fixedRoles);
  if (slots.some((slot) => !pools.get(slot.role)?.length)) return [];
  const bindingKey = (slotId: string, materialId: string): string => `${slotId}:${materialId}`;
  const allSets = existingGroups.map(
    (group) => new Set(group.map(({ slotId, materialId }) => bindingKey(slotId, materialId))),
  );
  const usage = new Map<string, number>();
  const results: EffectTemplateMixAiSelection[][] = [];

  const buildOne = (): EffectTemplateMixAiSelection[] | null => {
    const chosen: EffectTemplateMixAiSelection[] = [];
    const overlap = allSets.map(() => 0);
    const orderedPools = slots.map((slot) =>
      [...pools.get(slot.role)!].sort(
        (left, right) =>
          (usage.get(left.materialId) ?? 0) - (usage.get(right.materialId) ?? 0) ||
          right.matchScore - left.matchScore ||
          left.materialId.localeCompare(right.materialId),
      ),
    );
    const search = (slotIndex: number): boolean => {
      if (slotIndex === slots.length) return true;
      const slot = slots[slotIndex]!;
      for (const item of orderedPools[slotIndex]!) {
        const key = bindingKey(slot.id, item.materialId);
        let blocked = false;
        for (let setIndex = 0; setIndex < allSets.length; setIndex += 1) {
          if (allSets[setIndex]!.has(key) && overlap[setIndex]! >= maxOverlap) {
            blocked = true;
            break;
          }
        }
        if (blocked) continue;
        for (let setIndex = 0; setIndex < allSets.length; setIndex += 1) {
          if (allSets[setIndex]!.has(key)) overlap[setIndex]! += 1;
        }
        chosen.push(toSelection(slot, item));
        if (search(slotIndex + 1)) return true;
        chosen.pop();
        for (let setIndex = 0; setIndex < allSets.length; setIndex += 1) {
          if (allSets[setIndex]!.has(key)) overlap[setIndex]! -= 1;
        }
      }
      return false;
    };
    return search(0) ? chosen : null;
  };

  while (results.length < Math.max(0, maxVariants)) {
    const variant = buildOne();
    if (!variant) break;
    allSets.push(new Set(variant.map(({ slotId, materialId }) => bindingKey(slotId, materialId))));
    for (const { materialId } of variant) usage.set(materialId, (usage.get(materialId) ?? 0) + 1);
    results.push(variant);
  }
  return results;
};

/**
 * Soft penalty subtracted from a role's raw score for every clip the role already holds
 * above its fair share. Tune this to trade off matching quality against balance: a larger
 * value pushes marginal clips into their second-best role sooner.
 */
export const BALANCED_SLOT_PENALTY = 0.05;

/**
 * Reserve a distinct duration-feasible clip for each role when a full matching
 * exists, then assign every remaining material to exactly one role.
 *
 * Zero-score and too-short clips cannot satisfy coverage. When coverage is
 * impossible, callers retain the existing explicit missing-slot error. The
 * remaining clips keep the soft balancing penalty and their model scores.
 */
export const balancedSlotAssignment = (
  roles: readonly EffectTemplateMixRole[],
  classifications: EffectTemplateMixAiClassification[],
  feasibleRoles?: ReadonlyMap<string, ReadonlySet<EffectTemplateMixRole>>,
  fixedRoles: Readonly<Record<string, EffectTemplateMixRole>> = {},
): Map<string, EffectTemplateMixRole> => {
  const targetPerSlot = classifications.length / Math.max(1, roles.length);
  const counts = new Map<EffectTemplateMixRole, number>(roles.map((role) => [role, 0]));
  const assignment = new Map<string, EffectTemplateMixRole>();
  for (const item of classifications) {
    const role = fixedRoles[item.materialId];
    if (!role || !roles.includes(role)) continue;
    assignment.set(item.materialId, role);
    counts.set(role, (counts.get(role) ?? 0) + 1);
  }
  const uncoveredRoles = roles.filter((role) => !counts.get(role));
  // Six slots allow an exact subset DP. This guarantees full coverage when
  // feasible and maximizes the model's total role score across the anchors.
  const states: Array<{ score: number; materialIds: string[] } | undefined> = Array.from(
    { length: 1 << uncoveredRoles.length },
    () => undefined,
  );
  states[0] = { score: 0, materialIds: [] };
  for (const item of [...classifications].sort((a, b) =>
    a.materialId.localeCompare(b.materialId),
  )) {
    if (assignment.has(item.materialId)) continue;
    for (let mask = states.length - 1; mask >= 0; mask -= 1) {
      const current = states[mask];
      if (!current) continue;
      for (let roleIndex = 0; roleIndex < uncoveredRoles.length; roleIndex += 1) {
        const bit = 1 << roleIndex;
        if ((mask & bit) !== 0) continue;
        const role = uncoveredRoles[roleIndex]!;
        const score = item.scores[role];
        if (
          !Number.isFinite(score) ||
          score <= 0 ||
          (feasibleRoles && !feasibleRoles.get(item.materialId)?.has(role))
        )
          continue;
        const nextMask = mask | bit;
        const nextScore = current.score + score;
        if (states[nextMask] && states[nextMask]!.score >= nextScore - 1e-9) continue;
        const materialIds = [...current.materialIds];
        materialIds[roleIndex] = item.materialId;
        states[nextMask] = { score: nextScore, materialIds };
      }
    }
  }
  const anchors = states[states.length - 1]?.materialIds;
  if (anchors) {
    for (let index = 0; index < uncoveredRoles.length; index += 1) {
      assignment.set(anchors[index]!, uncoveredRoles[index]!);
      counts.set(uncoveredRoles[index]!, 1);
    }
  }
  const ordered = [...classifications].sort((left, right) => {
    const peak = (item: EffectTemplateMixAiClassification): number =>
      Math.max(...roles.map((role) => item.scores[role] ?? Number.NEGATIVE_INFINITY));
    return peak(right) - peak(left) || left.materialId.localeCompare(right.materialId);
  });
  for (const item of ordered) {
    if (assignment.has(item.materialId)) continue;
    let bestRole: EffectTemplateMixRole = roles[0]!;
    let bestScore = Number.NEGATIVE_INFINITY;
    const fittingRoles = roles.filter((role) => feasibleRoles?.get(item.materialId)?.has(role));
    const usableRoles = fittingRoles.length ? fittingRoles : roles;
    const positiveRoles = usableRoles.filter((role) => item.scores[role] > 0);
    for (const role of positiveRoles.length ? positiveRoles : usableRoles) {
      const raw = item.scores[role];
      if (!Number.isFinite(raw)) continue;
      const adjusted = raw - BALANCED_SLOT_PENALTY * ((counts.get(role) ?? 0) - targetPerSlot);
      if (adjusted > bestScore) {
        bestScore = adjusted;
        bestRole = role;
      }
    }
    assignment.set(item.materialId, bestRole);
    counts.set(bestRole, (counts.get(bestRole) ?? 0) + 1);
  }
  return assignment;
};

export const applyVariantToTemplate = (
  workspace: EffectTemplateMixWorkspace,
  sourceVariant: EffectTemplateMixVariant,
  syncOtherVariants: boolean,
): { conflicts: number; synced: number } => {
  // The variant carries template slots plus its own free clips; only the former describe the
  // template, so promoting a variant must not leak those extra clips into the shared template.
  const templateIds = new Set(workspace.template.slots.map(({ id }) => id));
  workspace.template.slots = sourceVariant.slots.filter(({ id }) => templateIds.has(id)).map(clone);
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

    variant.slots = syncEffectTemplateMixVariantSlots(workspace.template.slots, variant.slots);
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
