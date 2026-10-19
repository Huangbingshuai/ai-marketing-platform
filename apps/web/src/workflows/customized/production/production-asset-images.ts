import { resolveCustomizedAssetImageSource, type ProductionAsset } from '@ai-marketing/contracts';

/** Presentation only: the original object and its bindings remain unchanged. */
export function imageSource(assets: readonly ProductionAsset[], asset: ProductionAsset) {
  const result = resolveCustomizedAssetImageSource(assets, asset.id);
  return result.ok ? result.source : null;
}

export function independentlyPrepared(assets: readonly ProductionAsset[], asset: ProductionAsset) {
  return imageSource(assets, asset)?.id === asset.id;
}

export function imageOwnershipLabel(assets: readonly ProductionAsset[], asset: ProductionAsset) {
  const source = imageSource(assets, asset);
  return !source
    ? '制作归属待核对'
    : source.id !== asset.id
      ? `随「${source.name}」制作`
      : source.image
        ? '已有图片'
        : '待备图';
}

/** Keep unresolved objects visible so render validation still blocks missing references. */
export function referenceImageSources(
  catalog: readonly ProductionAsset[],
  objects: readonly ProductionAsset[],
) {
  const sources = objects.map((asset) => imageSource(catalog, asset) ?? { ...asset, image: null });
  return sources.filter((source, index) => sources.findIndex((a) => a.id === source.id) === index);
}
