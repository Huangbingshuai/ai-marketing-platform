import type {
  EffectTemplateMixAiClassification,
  EffectTemplateMixAiSelection,
  EffectTemplateMixAiSnapshot,
  EffectTemplateMixIncrementalPlan,
  EffectTemplateMixMaterial,
} from '@ai-marketing/contracts';
import {
  effectTemplateMixPendingAddedMaterials,
  type EffectTemplateMixSlot,
} from '@ai-marketing/contracts';
import { buildAssignedPools, enumerateAssignedVariants } from './effect-template-mix.domain';
import { workflowStateHash } from '../../../platform/workflow/workflow-state-hash';

type History = {
  templateId: string;
  status: string;
  inputSnapshot: unknown;
  selectionResult?: unknown;
};

/** Stable Prompt provenance distinguishes a replacement from a genuinely new clip. */
export function pendingAddedMaterials(
  templateId: string,
  materials: readonly (Pick<
    EffectTemplateMixMaterial,
    'id' | 'available' | 'activeSource' | 'sourcePromptId'
  > &
    Partial<Pick<EffectTemplateMixMaterial, 'duration'>>)[],
  history: readonly History[],
  slots?: readonly Pick<EffectTemplateMixSlot, 'duration'>[],
): string[] {
  return effectTemplateMixPendingAddedMaterials(templateId, materials, history, slots);
}

/** Local append may keep genuinely empty pools; legacy/full-fill snapshots stay strict. */
export function adaptiveIncrementalSelections(
  snapshot: EffectTemplateMixAiSnapshot,
  rows: EffectTemplateMixAiClassification[],
): EffectTemplateMixAiSelection[] {
  const addedIds = new Set(snapshot.incremental?.materialIds ?? []);
  const allowEmpty = snapshot.incremental?.emptySlotPolicy === 'ALLOW_EMPTY_POOLS';
  const pools = buildAssignedPools(
    snapshot.template.slots,
    snapshot.materials.map((item) => ({ ...item, available: true })),
    rows,
    new Set(),
    snapshot.materialRoleAssignments,
  );
  const eligible = new Set(
    [...pools.values()].flatMap((pool) => pool.map((item) => item.materialId)),
  );
  const usableAddedIds = new Set([...addedIds].filter((id) => eligible.has(id)));
  if (allowEmpty && !usableAddedIds.size)
    throw new Error('没有可采用的新增素材，未追加成片；请检查新增素材的归槽和时长');
  const emptySlotIds = snapshot.template.slots
    .filter((slot) => !pools.get(slot.role)?.length)
    .map((slot) => slot.id);
  const groups = enumerateAssignedVariants(
    snapshot.template.slots,
    snapshot.materials.map((item) => ({ ...item, available: true })),
    rows,
    snapshot.existingVariantBindings,
    snapshot.maxOutputVariants,
    undefined,
    snapshot.materialRoleAssignments,
    { requiredMaterialIds: allowEmpty ? usableAddedIds : addedIds, allowEmptyPools: allowEmpty },
  );
  const selected = new Set(groups.flatMap((group) => group.map((item) => item.materialId)));
  if (
    !groups.length ||
    [...(allowEmpty ? usableAddedIds : addedIds)].some((id) => !selected.has(id))
  )
    throw new Error(
      allowEmpty
        ? '可采用新增素材未能全部归入成片，请检查归槽、组合去重与数量上限'
        : '新增素材未能全部归入完整成片，请检查归槽、时长与可用素材',
    );
  const selections = groups.flatMap((group, variantIndex) =>
    group.map((item, index) => ({
      ...item,
      variantIndex,
      ...(allowEmpty && index === 0 ? { intentionallyEmptySlotIds: emptySlotIds } : {}),
    })),
  );
  if (allowEmpty) {
    const omitted = [...addedIds]
      .filter((id) => !selected.has(id))
      .map((materialId) => ({
        materialId,
        reason: '没有符合当前归槽和槽位时长的候选，未参与本次追加',
      }));
    if (omitted.length) selections[0]!.omittedNewMaterials = omitted;
    validatePartialAppendSelections(snapshot, rows, selections);
  }
  return selections;
}

/** Recheck persisted selections on completion; an empty sign cannot hide a missing real clip. */
export function validatePartialAppendSelections(
  snapshot: EffectTemplateMixAiSnapshot,
  rows: EffectTemplateMixAiClassification[],
  selections: EffectTemplateMixAiSelection[],
): void {
  if (snapshot.incremental?.emptySlotPolicy !== 'ALLOW_EMPTY_POOLS') return;
  const pools = buildAssignedPools(
    snapshot.template.slots,
    snapshot.materials.map((item) => ({ ...item, available: true })),
    rows,
    new Set(),
    snapshot.materialRoleAssignments,
  );
  const empty = snapshot.template.slots
    .filter((slot) => !pools.get(slot.role)?.length)
    .map((slot) => slot.id);
  const groups = new Map<number, EffectTemplateMixAiSelection[]>();
  for (const item of selections) {
    const index = item.variantIndex ?? 0;
    if (!Number.isSafeInteger(index) || index < 0) throw new Error('新增成片分组无效');
    groups.set(index, [...(groups.get(index) ?? []), item]);
  }
  const signatures = new Set(
    snapshot.existingVariantBindings.map((group) =>
      JSON.stringify(
        snapshot.template.slots.map(
          (slot) => group.find((item) => item.slotId === slot.id)?.materialId ?? null,
        ),
      ),
    ),
  );
  if (!groups.size || groups.size > snapshot.maxOutputVariants) throw new Error('新增成片数量无效');
  for (const [index, group] of groups) {
    const marks = group[0]?.intentionallyEmptySlotIds;
    if (
      index >= groups.size ||
      !marks ||
      new Set(marks).size !== marks.length ||
      marks.length !== empty.length ||
      marks.some((id) => !empty.includes(id)) ||
      group.slice(1).some((item) => item.intentionallyEmptySlotIds !== undefined) ||
      group.length + empty.length !== snapshot.template.slots.length ||
      new Set(group.map((item) => item.slotId)).size !== group.length ||
      new Set(group.map((item) => item.materialId)).size !== group.length ||
      !group.some((item) => snapshot.incremental!.materialIds.includes(item.materialId))
    )
      throw new Error('新增成片的素材与明确空槽必须完整覆盖模板');
    for (const item of group) {
      const slot = snapshot.template.slots.find((slot) => slot.id === item.slotId);
      if (
        !slot ||
        slot.role !== item.role ||
        item.duration !== slot.duration ||
        !pools.get(slot.role)?.some((candidate) => candidate.materialId === item.materialId)
      )
        throw new Error('新增成片素材归槽、来源或时长无效');
    }
    const signature = JSON.stringify(
      snapshot.template.slots.map(
        (slot) => group.find((item) => item.slotId === slot.id)?.materialId ?? null,
      ),
    );
    if (signatures.has(signature)) throw new Error('新增成片组合重复');
    signatures.add(signature);
  }
  const selected = new Set(selections.map((item) => item.materialId));
  const eligible = new Set(
    [...pools.values()].flatMap((pool) => pool.map((item) => item.materialId)),
  );
  if (snapshot.incremental.materialIds.some((id) => eligible.has(id) && !selected.has(id)))
    throw new Error('新增成片未覆盖全部可采用新增素材');
}

export function incrementalRoleAssignments(
  snapshot: EffectTemplateMixAiSnapshot,
  rows: EffectTemplateMixAiClassification[],
): Record<string, string> {
  return Object.fromEntries(
    [
      ...buildAssignedPools(
        snapshot.template.slots,
        snapshot.materials.map((material) => ({ ...material, available: true })),
        rows,
        new Set(),
        snapshot.materialRoleAssignments,
      ),
    ].flatMap(([role, pool]) => pool.map((item) => [item.materialId, role])),
  );
}

/** Only mechanical validation; viewing differences come from AI, never string similarity. */
export function validateIncrementalPlan(
  snapshot: EffectTemplateMixAiSnapshot,
  rows: EffectTemplateMixAiClassification[],
  plan: EffectTemplateMixIncrementalPlan,
): EffectTemplateMixAiSelection[] {
  if (
    !snapshot.incremental ||
    !Array.isArray(plan?.variants) ||
    !plan.variants.length ||
    plan.variants.length > snapshot.maxOutputVariants
  )
    throw new Error('新增成片方案数量无效');
  const roles = incrementalRoleAssignments(snapshot, rows);
  const rowById = new Map(rows.map((row) => [row.materialId, row]));
  const materialById = new Map(snapshot.materials.map((material) => [material.id, material]));
  const canonical = (bindings: Array<{ slotId: string; materialId: string }>) =>
    workflowStateHash(
      snapshot.template.slots.map((slot) => [
        slot.id,
        bindings.find((item) => item.slotId === slot.id)?.materialId,
      ]),
    );
  const seen = new Set(snapshot.existingVariantBindings.map(canonical));
  const selections = plan.variants.flatMap((variant, variantIndex) => {
    if (
      typeof variant.difference !== 'string' ||
      !variant.difference.trim() ||
      variant.difference.length > 1000 ||
      !Array.isArray(variant.bindings) ||
      variant.bindings.length !== snapshot.template.slots.length ||
      new Set(variant.bindings.map((item) => item.slotId)).size !==
        snapshot.template.slots.length ||
      new Set(variant.bindings.map((item) => item.materialId)).size !==
        snapshot.template.slots.length ||
      !variant.bindings.some((item) => snapshot.incremental!.materialIds.includes(item.materialId))
    )
      throw new Error('新增方案必须完整、素材不重复并使用新增素材');
    const key = canonical(variant.bindings);
    if (seen.has(key)) throw new Error('新增方案与已有方案完全重复');
    seen.add(key);
    return snapshot.template.slots.map((slot) => {
      const binding = variant.bindings.find((item) => item.slotId === slot.id);
      const material = binding ? materialById.get(binding.materialId) : undefined;
      const row = material ? rowById.get(material.id) : undefined;
      if (
        !material ||
        !row ||
        roles[material.id] !== slot.role ||
        material.duration + 0.001 < slot.duration
      )
        throw new Error('新增方案素材来源、归槽或时长无效');
      const score = row.scores[slot.role];
      return {
        variantIndex,
        slotId: slot.id,
        role: slot.role,
        materialId: material.id,
        matchScore: score,
        matchLevel: score >= 0.6 ? ('NORMAL' as const) : ('LOW_MATCH' as const),
        classificationReason: variant.difference.trim(),
        duration: slot.duration,
      };
    });
  });
  const used = new Set(selections.map((selection) => selection.materialId));
  const missing = snapshot.incremental.materialIds.filter((id) => !used.has(id));
  if (
    !Array.isArray(plan.omitted) ||
    plan.omitted.length !== missing.length ||
    new Set(plan.omitted.map((item) => item.materialId)).size !== missing.length ||
    plan.omitted.some(
      (item) =>
        !missing.includes(item.materialId) ||
        typeof item.reason !== 'string' ||
        !item.reason.trim() ||
        item.reason.length > 1000,
    )
  )
    throw new Error('未参与追加的新增素材必须有模型说明');
  const result: EffectTemplateMixAiSelection[] = selections;
  if (plan.omitted.length) result[0]!.omittedNewMaterials = plan.omitted;
  return result;
}

export function incrementalVariantId(runId: string, index: number): string {
  if (index === 0) return runId;
  const hash = workflowStateHash({ operation: 'INCREMENTAL_VARIANT', runId, index });
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
