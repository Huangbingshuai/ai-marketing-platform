import layouts from './customized-asset-image-layout.json';
import type { ProductionAsset } from './customized-production';

/** Shared by the editable single-image composer and frozen batch inputs. */
export function defaultCustomizedAssetImagePrompt(asset: ProductionAsset): string {
  return [
    layouts.common,
    `对象名称：${asset.name}`,
    `公共形象：${asset.description}`,
    asset.knownFacts && `已知特征：${asset.knownFacts}`,
    asset.designNotes && `设计设定：${asset.designNotes}`,
    asset.imageRequirements && `图片制作要求：${asset.imageRequirements}`,
    layouts[asset.kind],
  ]
    .filter(Boolean)
    .join('\n');
}
