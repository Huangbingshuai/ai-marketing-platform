import type { EffectImportMaterial } from '@ai-marketing/contracts';
import { useImportImagePreview } from '../../../platform/file/import-image-preview';
export const useEffectImportImagePreview = (material: () => EffectImportMaterial) =>
  useImportImagePreview(() => {
    const item = material();
    return {
      id: item.id,
      projectId: item.projectId,
      groupId: item.productId,
      name: item.originalFileName || item.expectedFileName || '图片',
      contentUrl: item.contentUrl ?? '',
      updatedAt: item.updatedAt,
      mimeType: item.mimeType,
      ready: item.type === 'PRODUCT_IMAGE' && item.status === 'READY',
    };
  });
