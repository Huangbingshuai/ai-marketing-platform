import type { Asset } from '@ai-marketing/contracts';
import { describe, expect, it } from 'vitest';

import {
  allowedTypesForDirectory,
  assetMatchesFilters,
  normalizeTags,
  validateAssetMetadata,
} from './asset-validation';

const asset: Asset = {
  id: 'asset-1',
  projectId: 'project-1',
  name: '夏季品牌主视觉',
  directory: 'VISUAL_ASSETS',
  type: 'PRODUCT_ASSET',
  tags: ['品牌核心', '夏季'],
  notes: '用于首页首屏',
  originalFileName: 'hero-original.png',
  mimeType: 'image/png',
  sizeBytes: 128,
  previewKind: 'IMAGE',
  contentUrl: '/content',
  downloadUrl: '/download',
  createdAt: '2026-08-20T02:00:00.000Z',
  updatedAt: '2026-08-20T02:00:00.000Z',
};

describe('asset validation', () => {
  it('exposes only legal types for each directory', () => {
    expect(allowedTypesForDirectory('SCRIPTS')).toEqual(['SCRIPT_COPY', 'STORYBOARD_SCRIPT']);
    expect(allowedTypesForDirectory('REPORTS_DELIVERABLES')).toEqual([
      'ANALYSIS_QUALITY_REPORT',
      'DELIVERY_MANIFEST',
    ]);
  });

  it('normalizes comma-separated tags by trimming and deduplicating', () => {
    expect(normalizeTags(' 品牌，夏季,品牌 ,, ')).toEqual(['品牌', '夏季']);
  });

  it('validates file, lengths and directory/type combinations', () => {
    expect(
      validateAssetMetadata(
        {
          name: '',
          directory: 'SOURCE_MATERIALS',
          type: 'SOURCE_MATERIAL',
          tags: [],
          notes: null,
          file: null,
        },
        { fileRequired: true },
      ),
    ).toBe('资产名称长度必须为 1 到 120 个字符');
    expect(
      validateAssetMetadata({
        name: '错误组合',
        directory: 'SOURCE_MATERIALS',
        type: 'FINAL_VIDEO',
        tags: [],
      }),
    ).toBe('资产目录与类型不匹配');
    expect(
      validateAssetMetadata(
        {
          name: '超限文件',
          directory: 'SOURCE_MATERIALS',
          type: 'SOURCE_MATERIAL',
          tags: [],
          file: new File(['1234'], 'large.bin'),
        },
        { maxUploadBytes: 3 },
      ),
    ).toBe('文件大小超过 512 MiB');
  });

  it('matches backend keyword semantics including exact tag matches', () => {
    expect(assetMatchesFilters(asset, { keyword: '品牌主' })).toBe(true);
    expect(assetMatchesFilters(asset, { keyword: 'hero-original' })).toBe(true);
    expect(assetMatchesFilters(asset, { keyword: '首页首屏' })).toBe(true);
    expect(assetMatchesFilters(asset, { keyword: '品牌核心' })).toBe(true);
    expect(assetMatchesFilters(asset, { keyword: '核心' })).toBe(false);
    expect(assetMatchesFilters(asset, { directory: 'FINAL_VIDEOS' })).toBe(false);
  });
});
