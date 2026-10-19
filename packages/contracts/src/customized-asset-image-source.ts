import type { ProductionAsset } from './customized-production';

export type CustomizedAssetImageSource =
  | { ok: true; source: ProductionAsset; path: string[] }
  | { ok: false; reason: 'MISSING' | 'DUPLICATE_ID' | 'CYCLE' | 'INVALID_PARENT' };

/** Resolve exact ownership only within the caller's current Run-scoped catalog. */
export function resolveCustomizedAssetImageSource(
  assets: readonly ProductionAsset[],
  objectId: string,
): CustomizedAssetImageSource {
  const byId = new Map(assets.map((a) => [a.id, a]));
  if (byId.size !== assets.length) return { ok: false, reason: 'DUPLICATE_ID' };
  const path: string[] = [];
  let current = byId.get(objectId);
  while (current) {
    if (path.includes(current.id)) return { ok: false, reason: 'CYCLE' };
    path.push(current.id);
    const prep = current.preparation;
    if (!prep) return { ok: true, source: current, path };
    if (prep.treatment === 'INDEPENDENT')
      return prep.parentId === null
        ? { ok: true, source: current, path }
        : { ok: false, reason: 'INVALID_PARENT' };
    if (!['SCENE_DETAIL', 'CHARACTER_DETAIL'].includes(prep.treatment) || !prep.parentId)
      return { ok: false, reason: 'INVALID_PARENT' };
    const parent = byId.get(prep.parentId);
    if (!parent) return { ok: false, reason: 'MISSING' };
    if (
      current.kind === 'PRODUCT' ||
      parent.kind !== (prep.treatment === 'SCENE_DETAIL' ? 'SCENE' : 'CHARACTER')
    )
      return { ok: false, reason: 'INVALID_PARENT' };
    current = parent;
  }
  return { ok: false, reason: 'MISSING' };
}

/** Reject the entire explicit IMAGE selection before creating any paid task. */
export function customizedAssetImageSelectionIssue(
  assets: readonly ProductionAsset[],
  objectIds: readonly string[],
): string | null {
  if (!objectIds.length || new Set(objectIds).size !== objectIds.length)
    return '请选择有效且不重复的独立制图资产';
  for (const id of objectIds) {
    const resolved = resolveCustomizedAssetImageSource(assets, id);
    const item = assets.find((a) => a.id === id);
    if (!resolved.ok || !item?.description.trim())
      return '资产归属或公共形象无效，请在当前资产目录核对后重试';
    if (resolved.source.id !== id)
      return `“${item.name}”随“${resolved.source.name}”准备，无需独立制图；请移除该项后重试`;
  }
  return null;
}
