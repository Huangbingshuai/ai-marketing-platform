import type { CustomizedBrief } from './customized-extraction';

export const BRAND_CREATION_VERSION = '2026-10-14.7';
export const BRAND_EXPRESSION_LABELS: Record<string, string> = {
  LIFE_OBSERVATION: '生活观察',
  PRODUCT_DESIGN: '产品设计',
  VISUAL_EXPRESSION: '视觉表达',
  DOCUMENTARY: '纪实证明',
  OTHER: '其他表达',
};
export function brandFactCatalog(brief: CustomizedBrief) {
  const facts: { id: string; field: string; text: string }[] = [];
  for (const [field, value] of Object.entries(brief).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  ))
    for (const text of Array.isArray(value) ? value : [value])
      if (typeof text === 'string' && text.trim())
        facts.push({ id: `F${String(facts.length + 1).padStart(2, '0')}`, field, text });
  return facts;
}
const obj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const strings = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string' && !!x.trim());
export function validateBrandDevelopment(
  value: unknown,
  brief: CustomizedBrief,
  count: number,
): boolean {
  if (
    !obj(value) ||
    !obj(value.proposition) ||
    !Array.isArray(value.ideas) ||
    value.ideas.length !== count
  )
    return false;
  const p = value.proposition,
    facts = new Set(brandFactCatalog(brief).map((f) => f.id));
  if (
    !strings(p.supportingFactIds) ||
    !p.supportingFactIds.length ||
    !strings(p.requiredFactIds) ||
    !['BRIEF', 'CREATIVE_HYPOTHESIS'].includes(String(p.observationBasis)) ||
    !['message', 'audienceObservation', 'requiredReason'].every(
      (k) => typeof p[k] === 'string' && !!p[k].trim(),
    ) ||
    [...p.supportingFactIds, ...p.requiredFactIds].some((id) => !facts.has(id))
  )
    return false;
  return (
    new Set(value.ideas.map((i) => (obj(i) ? i.id : null))).size === count &&
    value.ideas.every(
      (i) =>
        obj(i) &&
        ['id', 'name', 'viewingHook', 'mechanism', 'productRole', 'memory', 'risk'].every(
          (k) => typeof i[k] === 'string' && !!i[k].trim(),
        ) &&
        Object.hasOwn(BRAND_EXPRESSION_LABELS, String(i.approach)) &&
        strings(i.keyImages) &&
        i.keyImages.length >= 2 &&
        i.keyImages.length <= 4 &&
        strings(i.factIds) &&
        i.factIds.length > 0 &&
        i.factIds.every((id) => facts.has(id)),
    )
  );
}
export function validateBrandSelection(
  value: unknown,
  development: unknown,
  scriptIds: string[],
  brief: CustomizedBrief,
): boolean {
  if (
    !obj(value) ||
    !obj(development) ||
    !Array.isArray(development.ideas) ||
    !Array.isArray(value.evaluations) ||
    !Array.isArray(value.commitments) ||
    !Array.isArray(value.concepts)
  )
    return false;
  const ids = new Set(development.ideas.map((i) => (obj(i) ? i.id : null)));
  const evaluations = value.evaluations;
  if (
    evaluations.length !== ids.size ||
    new Set(evaluations.map((e) => (obj(e) ? e.ideaId : null))).size !== ids.size ||
    !evaluations.every(
      (e) =>
        obj(e) &&
        ids.has(e.ideaId) &&
        ['ADVANCE', 'REJECT'].includes(String(e.verdict)) &&
        ['attraction', 'productConnection', 'clarity', 'distinctiveness'].every(
          (k) => Number.isInteger(e[k]) && Number(e[k]) >= 1 && Number(e[k]) <= 5,
        ) &&
        typeof e.reason === 'string' &&
        !!e.reason.trim(),
    )
  )
    return false;
  if (value.status === 'NEEDS_INFORMATION')
    return (
      value.concepts.length === 0 &&
      value.commitments.length === 0 &&
      strings(value.missing) &&
      value.missing.length > 0
    );
  if (value.status !== 'READY' || !strings(value.missing) || value.missing.length) return false;
  const facts = new Set(brandFactCatalog(brief).map((f) => f.id));
  const matches = (rows: unknown[]) =>
    rows.length === scriptIds.length &&
    new Set(rows.map((c) => (obj(c) ? c.scriptId : null))).size === scriptIds.length &&
    rows.every((c) => obj(c) && scriptIds.includes(String(c.scriptId)));
  return (
    matches(value.concepts) &&
    matches(value.commitments) &&
    new Set(value.commitments.map((c) => (obj(c) ? c.ideaId : null))).size === scriptIds.length &&
    value.commitments.every(
      (c) =>
        obj(c) &&
        ids.has(c.ideaId) &&
        evaluations.some((e) => obj(e) && e.ideaId === c.ideaId && e.verdict === 'ADVANCE') &&
        Object.hasOwn(BRAND_EXPRESSION_LABELS, String(c.approach)) &&
        strings(c.mustPreserve) &&
        c.mustPreserve.length >= 2 &&
        c.mustPreserve.length <= 5 &&
        strings(c.essentialFactIds) &&
        c.essentialFactIds.length > 0 &&
        c.essentialFactIds.every((id) => facts.has(id)),
    )
  );
}
