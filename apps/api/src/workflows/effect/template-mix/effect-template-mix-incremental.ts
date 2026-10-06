import type {
  EffectTemplateMixAiClassification,
  EffectTemplateMixAiSelection,
  EffectTemplateMixAiSnapshot,
  EffectTemplateMixIncrementalPlan,
  EffectTemplateMixMaterial,
} from '@ai-marketing/contracts';
import {
  effectTemplateMixMaterialFitsTemplate,
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
  const knownPrompts = new Set<string>();
  let hasBaseline = false;
  for (const run of history) {
    if (run.templateId !== templateId || run.status !== 'COMPLETED') continue;
    const snapshot = run.inputSnapshot as Partial<EffectTemplateMixAiSnapshot> | null;
    if (!Array.isArray(snapshot?.materials)) continue;
    hasBaseline = true;
    const selected = new Set(
      Array.isArray(run.selectionResult)
        ? (run.selectionResult as EffectTemplateMixAiSelection[]).map((item) => item.materialId)
        : [],
    );
    for (const material of snapshot.materials) {
      if (
        !snapshot.incremental ||
        !snapshot.incremental.materialIds.includes(material.id) ||
        selected.has(material.id)
      )
        knownPrompts.add(material.promptId);
    }
  }
  if (!hasBaseline) return [];
  return materials
    .filter(
      (material) =>
        material.available &&
        material.activeSource !== false &&
        (!slots || effectTemplateMixMaterialFitsTemplate(material.duration ?? NaN, slots)) &&
        Boolean(material.sourcePromptId) &&
        !knownPrompts.has(material.sourcePromptId!),
    )
    .map(({ id }) => id);
}

/** New runs share the full-fill combination policy; old snapshots keep their AI plan. */
export function adaptiveIncrementalSelections(
  snapshot: EffectTemplateMixAiSnapshot,
  rows: EffectTemplateMixAiClassification[],
): EffectTemplateMixAiSelection[] {
  const addedIds = new Set(snapshot.incremental?.materialIds ?? []);
  const groups = enumerateAssignedVariants(
    snapshot.template.slots,
    snapshot.materials.map((item) => ({ ...item, available: true })),
    rows,
    snapshot.existingVariantBindings,
    snapshot.maxOutputVariants,
    undefined,
    snapshot.materialRoleAssignments,
    { requiredMaterialIds: addedIds },
  );
  const selected = new Set(groups.flatMap((group) => group.map((item) => item.materialId)));
  if (!groups.length || [...addedIds].some((id) => !selected.has(id)))
    throw new Error('新增素材未能全部归入完整成片，请检查归槽、时长与可用素材');
  return groups.flatMap((group, variantIndex) => group.map((item) => ({ ...item, variantIndex })));
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
