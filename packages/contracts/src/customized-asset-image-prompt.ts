import layouts from './customized-asset-image-layout.json';
import type { ProductionAsset } from './customized-production';
import { ASSET_FIELD_LABELS } from './customized-asset-preparation';

/** Shared by the editable single-image composer and frozen batch inputs. */
export function defaultCustomizedAssetImagePrompt(asset: ProductionAsset): string {
  const preparation = asset.preparation;
  return [
    layouts.common,
    `对象名称：${asset.name}`,
    `公共形象：${asset.description}`,
    asset.knownFacts && `已知特征：${asset.knownFacts}`,
    asset.designNotes && `设计设定：${asset.designNotes}`,
    asset.imageRequirements && `图片制作要求：${asset.imageRequirements}`,
    ...(preparation?.details.map(
      (detail) => `${ASSET_FIELD_LABELS[detail.key] ?? detail.key}：${detail.value}`,
    ) ?? []),
    ...(preparation?.images.map(
      (image) => `具体视图要求 · ${image.name}：${image.purpose}\n${image.requirements}`,
    ) ?? []),
    ...(preparation?.questions.map(
      (question) => `待确认 · ${question.question}\n限制与影响：${question.impact}`,
    ) ?? []),
    layouts[asset.kind],
  ]
    .filter(Boolean)
    .join('\n');
}
