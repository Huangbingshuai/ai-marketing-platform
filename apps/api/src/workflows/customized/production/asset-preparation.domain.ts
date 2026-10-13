import {
  ASSET_DETAIL_KEYS,
  ASSET_EDITABLE_FIELDS,
  assetEvidenceValue,
  isProductionDocument,
  type ProductionAsset,
  type ProductionDocument,
  type ProductionInput,
} from '@ai-marketing/contracts';

const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export function recordAssetEdits(
  previous: ProductionAsset[],
  next: ProductionAsset[],
): ProductionAsset[] {
  return next.map((a) => {
    const old = previous.find((v) => v.id === a.id);
    const manual = new Set(old?.manualFields ?? []);
    for (const field of ASSET_EDITABLE_FIELDS) {
      if (!equal(old?.[field], a[field])) manual.add(field);
    }
    if (!manual.size && old?.manualFields === undefined) {
      const { manualFields: ignored, ...value } = a;
      return value;
    }
    return { ...a, manualFields: [...manual] };
  });
}
export function protectedAssetFields(a: ProductionAsset): string[] {
  return a.manualFields ?? (a.preparation ? [] : ASSET_EDITABLE_FIELDS.filter((k) => !!a[k]));
}
export function mergePreparedAssets(
  previous: ProductionAsset[],
  generated: ProductionAsset[],
): ProductionAsset[] {
  const next = generated.map((a) => {
    const old = previous.find((v) => v.id === a.id);
    if (!old) return { ...a, manualFields: [] };
    const merged = {
      ...a,
      ...(old.image !== undefined ? { image: old.image } : {}),
      manualFields: protectedAssetFields(old),
    };
    for (const field of ASSET_EDITABLE_FIELDS) {
      if (merged.manualFields.includes(field)) Object.assign(merged, { [field]: old[field] });
    }
    return merged;
  });
  // Re-extraction is not an implicit deletion command.
  return [...next, ...previous.filter((a) => !next.some((v) => v.id === a.id))];
}
export function validatePreparedAssets(
  output: ProductionDocument,
  input: ProductionInput,
): string | null {
  if (!isProductionDocument(output) || output.shots.length) return '资产整理结果结构不正确';
  const allowedIds = new Set(input.document.assets.map((a) => a.id));
  const ids = new Set(output.assets.map((a) => a.id));
  if (input.targetAssetId && (ids.size !== 1 || !ids.has(input.targetAssetId)))
    return '单项整理超出选定对象';
  for (const a of output.assets) {
    const prep = a.preparation;
    if (!prep || !prep.sources.length) return '资产缺少可核对依据';
    const previous = input.document.assets.find((v) => v.id === a.id);
    if (previous && previous.kind !== a.kind) return '资产类别与原身份不一致';
    if (
      previous &&
      protectedAssetFields(previous).some(
        (field) =>
          !equal(previous[field as keyof ProductionAsset], a[field as keyof ProductionAsset]),
      )
    )
      return '人工修改未被保留';
    if (!allowedIds.has(a.id) && !a.id.startsWith(`asset-${input.identitySeed}-`))
      return '资产身份不属于本次任务';
    if (
      prep.details.some((d) => !(ASSET_DETAIL_KEYS[a.kind] as readonly string[]).includes(d.key)) ||
      new Set(prep.details.map((d) => d.key)).size !== prep.details.length
    )
      return '分类定义字段不正确';
    if (
      prep.treatment === 'INDEPENDENT'
        ? prep.parentId !== null
        : !prep.parentId ||
          prep.parentId === a.id ||
          (!ids.has(prep.parentId) && !allowedIds.has(prep.parentId))
    )
      return '附属对象引用不正确';
    if (prep.parentId) {
      const parent =
        output.assets.find((v) => v.id === prep.parentId) ??
        input.document.assets.find((v) => v.id === prep.parentId);
      if (parent?.kind !== (prep.treatment === 'SCENE_DETAIL' ? 'SCENE' : 'CHARACTER'))
        return '附属对象类别不正确';
    }
    if (a.kind === 'PRODUCT' && prep.treatment !== 'INDEPENDENT') return '产品必须独立定义';
    for (const ref of prep.sources) {
      const value = assetEvidenceValue(
        ref.source === 'BRIEF' ? input.brief : input.script,
        ref.path,
      );
      if (typeof value !== 'string' || !ref.quote.trim() || !value.includes(ref.quote))
        return '资产原文依据无法核对';
      if (
        a.kind === 'PRODUCT' &&
        ['description', 'knownFacts', 'structure', 'material', 'markings'].includes(ref.field) &&
        ref.source !== 'BRIEF'
      )
        return '产品事实必须引用信息卡';
    }
  }
  return null;
}
