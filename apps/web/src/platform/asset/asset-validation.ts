import {
  ASSET_DIRECTORY_TYPES,
  type Asset,
  type AssetDirectory,
  type AssetListQuery,
  type AssetType,
  type CreateAssetMetadata,
} from '@ai-marketing/contracts';

export const DEFAULT_MAX_UPLOAD_BYTES = 512 * 1024 * 1024;

export type AssetMetadataValidationInput = CreateAssetMetadata & { file?: File | null };

export const allowedTypesForDirectory = (directory: AssetDirectory): readonly AssetType[] =>
  ASSET_DIRECTORY_TYPES[directory] as readonly AssetType[];

export const isDirectoryTypePair = (directory: AssetDirectory, type: AssetType): boolean =>
  allowedTypesForDirectory(directory).includes(type);

export const normalizeTags = (value: string | readonly string[]): string[] => {
  const source = typeof value === 'string' ? value.split(/[,，]/) : value;
  return [...new Set(source.map((tag) => tag.trim()).filter(Boolean))];
};

export const validateAssetMetadata = (
  input: AssetMetadataValidationInput,
  options: { fileRequired?: boolean; maxUploadBytes?: number } = {},
): string | null => {
  const name = input.name.trim();
  const tags = normalizeTags(input.tags);
  if (name.length < 1 || name.length > 120) return '资产名称长度必须为 1 到 120 个字符';
  if (!isDirectoryTypePair(input.directory, input.type)) return '资产目录与类型不匹配';
  if (tags.length > 20) return '标签不能超过 20 个';
  if (tags.some((tag) => tag.length > 40)) return '每个标签最多 40 个字符';
  if ((input.notes?.trim().length ?? 0) > 2000) return '备注最多 2000 个字符';
  if (options.fileRequired && !input.file) return '请选择要导入的文件';
  if (input.file && input.file.size < 1) return '文件不能为空';
  if (input.file && input.file.size > (options.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES)) {
    return '文件大小超过 512 MiB';
  }
  return null;
};

export const assetMatchesFilters = (asset: Asset, filters: AssetListQuery): boolean => {
  const trimmedKeyword = filters.keyword?.trim();
  const keyword = trimmedKeyword?.toLocaleLowerCase('zh-CN');
  const keywordMatches =
    !keyword ||
    [asset.name, asset.originalFileName, asset.notes ?? ''].some((value) =>
      value.toLocaleLowerCase('zh-CN').includes(keyword),
    ) ||
    asset.tags.includes(trimmedKeyword ?? '');
  const businessData =
    asset.businessData &&
    typeof asset.businessData === 'object' &&
    !Array.isArray(asset.businessData)
      ? asset.businessData
      : null;
  const assetProductId = businessData ? Reflect.get(businessData, 'productId') : undefined;
  return (
    (!filters.directory || asset.directory === filters.directory) &&
    (!filters.type || asset.type === filters.type) &&
    (!filters.tag || asset.tags.includes(filters.tag)) &&
    (!filters.productId || assetProductId === filters.productId) &&
    keywordMatches
  );
};
