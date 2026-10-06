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

/** Soft overlap preference; coverage is never blocked by this legacy preference. */
export const MAX_SLOT_REUSE_OVERLAP = 2;

/**
 * Cover all assigned materials, then grow only while combinations bring useful novelty.
 * The output ceiling is not a target. A bounded deterministic search balances quantity,
 * duration-weighted distance, new shot pairs and usage without enumerating permutations.
 * All comparisons are structural; they do not claim semantic/visual dissimilarity.
 */
export const enumerateAssignedVariants = (
  slots: Array<{ id: string; role: EffectTemplateMixRole; duration: number }>,
  materials: Array<Pick<EffectTemplateMixMaterial, 'id' | 'duration' | 'available'>>,
  classifications: EffectTemplateMixAiClassification[],
  existingGroups: ReadonlyArray<ReadonlyArray<{ slotId: string; materialId: string }>> = [],
  maxVariants = 0,
  maxOverlap = MAX_SLOT_REUSE_OVERLAP,
  fixedRoles: Readonly<Record<string, EffectTemplateMixRole>> = {},
  options: { requiredMaterialIds?: ReadonlySet<string> } = {},
): EffectTemplateMixAiSelection[][] => {
  const pools = buildAssignedPools(slots, materials, classifications, new Set(), fixedRoles);
  const limit = Math.max(0, Math.floor(maxVariants));
  if (!slots.length || !limit || slots.some((slot) => !pools.get(slot.role)?.length)) return [];
  const ordered = slots.map((slot) => pools.get(slot.role)!);
  const flexible = ordered.flatMap((pool, index) => (pool.length > 1 ? [index] : []));
  const flexibleDuration = flexible.reduce((sum, index) => sum + slots[index]!.duration, 0);
  const pairPositions = flexible.flatMap((left, index) =>
    flexible.slice(index + 1).map((right) => [left, right] as const),
  );
  const eligibleIds = new Set(
    ordered
      .flatMap((pool) => pool.map((item) => item.materialId))
      .filter((id) => !options.requiredMaterialIds || options.requiredMaterialIds.has(id)),
  );
  const signature = (ids: Array<string | undefined>) => JSON.stringify(ids);
  const references = existingGroups.map((group) =>
    slots.map((slot) => group.find((binding) => binding.slotId === slot.id)?.materialId),
  );
  const excluded = new Set(references.map(signature));
  const usage = new Map<string, number>();
  const covered = new Set<string>();
  const pairUsage = new Map<string, number>();
  const pairKey = (left: number, leftId: string, right: number, rightId: string) =>
    JSON.stringify(left < right ? [left, leftId, right, rightId] : [right, rightId, left, leftId]);
  const pairs = (ids: Array<string | undefined>) =>
    pairPositions.flatMap(([left, right]) =>
      ids[left] && ids[right] ? [pairKey(left, ids[left]!, right, ids[right]!)] : [],
    );
  for (const ids of references) {
    for (const id of ids) if (id) usage.set(id, (usage.get(id) ?? 0) + 1);
    for (const pair of pairs(ids)) pairUsage.set(pair, (pairUsage.get(pair) ?? 0) + 1);
  }
  type Candidate = {
    items: AssignedPoolItem[];
    ids: string[];
    key: string;
    maximumOverlap: number;
    squaredOverlap: number;
    minimumChangedDuration: number;
    minimumChangedSlots: number;
  };
  const candidates = new Map<string, Candidate>();
  const overlap = (ids: string[], reference: Array<string | undefined>) =>
    ids.reduce((count, id, index) => count + Number(reference[index] === id), 0);
  const compare = (candidate: Candidate, reference: Array<string | undefined>) => {
    const shared = overlap(candidate.ids, reference);
    const changed = flexible.filter((index) => candidate.ids[index] !== reference[index]);
    candidate.maximumOverlap = Math.max(candidate.maximumOverlap, shared);
    candidate.squaredOverlap += shared * shared;
    candidate.minimumChangedSlots = Math.min(candidate.minimumChangedSlots, changed.length);
    candidate.minimumChangedDuration = Math.min(
      candidate.minimumChangedDuration,
      changed.reduce((sum, index) => sum + slots[index]!.duration, 0),
    );
  };
  const freshPairs = (candidate: Candidate) =>
    pairs(candidate.ids).filter((key) => !pairUsage.has(key)).length;
  const addsNovelty = (candidate: Candidate) =>
    pairPositions.length > 0 &&
    candidate.minimumChangedSlots >= Math.ceil(flexible.length / 2) &&
    candidate.minimumChangedDuration + 1e-6 >= flexibleDuration / 2 &&
    freshPairs(candidate) >= Math.ceil(pairPositions.length / 2);
  const add = (items: AssignedPoolItem[]) => {
    const ids = items.map((item) => item.materialId);
    if (options.requiredMaterialIds && !ids.some((id) => options.requiredMaterialIds!.has(id)))
      return;
    const key = signature(ids);
    if (excluded.has(key) || candidates.has(key) || new Set(ids).size !== slots.length) return;
    const candidate: Candidate = {
      items,
      ids,
      key,
      maximumOverlap: 0,
      squaredOverlap: 0,
      minimumChangedDuration: flexibleDuration,
      minimumChangedSlots: flexible.length,
    };
    for (const reference of references) compare(candidate, reference);
    if (covered.size === eligibleIds.size && !addsNovelty(candidate)) return;
    candidates.set(key, candidate);
  };
  // Local fixed seed makes retries/input ordering reproducible; no global random state.
  let seed = 0x6d2b79f5;
  const random = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 0x1_0000_0000;
  };
  const replenish = () => {
    for (let count = 0; count < 256 && candidates.size < 2048; count++)
      add(ordered.map((pool) => pool[Math.floor(random() * pool.length)]!));
    // Search underserved combinations as well as uniform samples. Each pick stays in its pool.
    for (let count = 0; count < 32 && candidates.size < 2048; count++) {
      const items: AssignedPoolItem[] = [];
      const order = ordered
        .map((_, index) => ({ index, value: random() }))
        .sort((left, right) => left.value - right.value);
      for (const { index } of order) {
        const cost = (item: AssignedPoolItem) => {
          const repeats = flexible.includes(index)
            ? flexible.reduce(
                (sum, other) =>
                  sum +
                  (items[other]
                    ? (pairUsage.get(
                        pairKey(index, item.materialId, other, items[other]!.materialId),
                      ) ?? 0)
                    : 0),
                0,
              )
            : 0;
          return (
            Number(!eligibleIds.has(item.materialId) || covered.has(item.materialId)) * 1000 +
            repeats * 4 +
            (usage.get(item.materialId) ?? 0)
          );
        };
        const choices = [...ordered[index]!].sort(
          (left, right) =>
            cost(left) - cost(right) ||
            right.matchScore - left.matchScore ||
            left.materialId.localeCompare(right.materialId),
        );
        items[index] = choices[Math.floor(random() * Math.min(3, choices.length))]!;
      }
      add(items);
    }
  };
  // Each role's largest pool is visited in full, independent of random or quality rank.
  const coverageSize = Math.max(...ordered.map((pool) => pool.length));
  for (let index = 0; index < coverageSize; index++)
    add(ordered.map((pool) => pool[index % pool.length]!));
  const directed = (): AssignedPoolItem[] | null => {
    const choices = ordered.map((pool) =>
      [...pool].sort(
        (left, right) =>
          Number(!eligibleIds.has(left.materialId) || covered.has(left.materialId)) -
            Number(!eligibleIds.has(right.materialId) || covered.has(right.materialId)) ||
          (usage.get(left.materialId) ?? 0) - (usage.get(right.materialId) ?? 0) ||
          right.matchScore - left.matchScore ||
          left.materialId.localeCompare(right.materialId),
      ),
    );
    const picked: AssignedPoolItem[] = [];
    let visits = 0;
    const search = (index: number): boolean => {
      if (++visits > 4096) return false;
      if (index === slots.length)
        return (
          !excluded.has(signature(picked.map((item) => item.materialId))) &&
          (!options.requiredMaterialIds ||
            picked.some((item) => options.requiredMaterialIds!.has(item.materialId)))
        );
      for (const item of choices[index]!) {
        picked.push(item);
        if (search(index + 1)) return true;
        picked.pop();
      }
      return false;
    };
    return search(0) ? picked : null;
  };
  const results: EffectTemplateMixAiSelection[][] = [];
  const rank = (candidate: Candidate): number[] => [
    candidate.ids.filter((id) => eligibleIds.has(id) && !covered.has(id)).length,
    candidate.minimumChangedDuration,
    candidate.minimumChangedSlots,
    freshPairs(candidate),
    -Math.max(0, candidate.maximumOverlap - maxOverlap),
    -candidate.maximumOverlap,
    -pairs(candidate.ids).reduce((sum, pair) => sum + (pairUsage.get(pair) ?? 0), 0),
    -candidate.squaredOverlap,
    -candidate.ids.reduce((sum, id) => sum + (usage.get(id) ?? 0), 0),
    candidate.items.reduce((sum, item) => sum + item.matchScore, 0),
  ];
  const better = (left: number[], right: number[]): boolean => {
    for (let index = 0; index < left.length; index++)
      if (Math.abs(left[index]! - right[index]!) > 1e-9) return left[index]! > right[index]!;
    return false;
  };
  while (results.length < limit) {
    // Coverage precedes diversity: scarce footage may require some unavoidable repetition.
    if (covered.size < eligibleIds.size) {
      const items = directed();
      if (items) add(items);
    }
    const coverageComplete = covered.size === eligibleIds.size;
    if (coverageComplete)
      for (const [key, candidate] of candidates)
        if (!addsNovelty(candidate)) candidates.delete(key);
    let best: Candidate | undefined,
      bestRank: number[] = [];
    // A few bounded guided searches avoid stopping solely on an unlucky sample.
    for (let attempt = 0; attempt < 3 && !best; attempt++) {
      replenish();
      for (const candidate of candidates.values()) {
        const score = rank(candidate);
        if (!best || better(score, bestRank)) {
          best = candidate;
          bestRank = score;
        }
      }
    }
    if (!best) break;
    candidates.delete(best.key);
    excluded.add(best.key);
    references.push(best.ids);
    for (const id of best.ids) {
      if (eligibleIds.has(id)) covered.add(id);
      usage.set(id, (usage.get(id) ?? 0) + 1);
    }
    for (const pair of pairs(best.ids)) pairUsage.set(pair, (pairUsage.get(pair) ?? 0) + 1);
    results.push(best.items.map((item, index) => toSelection(slots[index]!, item)));
    for (const candidate of candidates.values()) compare(candidate, best.ids);
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
