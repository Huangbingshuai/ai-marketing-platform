import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  archiveAsset,
  batchArchiveAssets,
  batchTagAssets,
  createAssetVersion,
  importAsset,
  importAssets,
  importAssetSnapshot,
  listAssets,
  listAssetVersions,
  updateAsset,
  upgradeAssetSnapshot,
} from './asset.api';

const asset = {
  id: 'asset-1',
  projectId: 'project-1',
  name: '品牌原图',
  directory: 'SOURCE_MATERIALS',
  type: 'SOURCE_MATERIAL',
  tags: ['品牌', '原图'],
  notes: null,
  originalFileName: 'brand.png',
  mimeType: 'image/png',
  sizeBytes: 42,
  previewKind: 'IMAGE',
  contentUrl: '/api/projects/project-1/assets/asset-1/content',
  downloadUrl: '/api/projects/project-1/assets/asset-1/content?download=true',
  createdAt: '2026-08-20T02:00:00.000Z',
  updatedAt: '2026-08-20T02:00:00.000Z',
} as const;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('asset API', () => {
  it('serializes all list filters with URLSearchParams', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: { items: [], total: 0, facets: { directories: [], types: [], tags: [] } },
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await listAssets('project/one', {
      keyword: '品牌 图',
      directory: 'VISUAL_ASSETS',
      type: 'PRODUCT_ASSET',
      tag: '核心',
      workflow: 'EFFECT',
      space: 'EFFECT',
      status: 'AVAILABLE',
      page: 2,
      pageSize: 48,
    });

    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain('/api/projects/project%2Fone/assets?');
    const query = new URL(url, 'http://test.local').searchParams;
    expect(Object.fromEntries(query)).toEqual({
      keyword: '品牌 图',
      directory: 'VISUAL_ASSETS',
      type: 'PRODUCT_ASSET',
      tag: '核心',
      workflow: 'EFFECT',
      space: 'EFFECT',
      status: 'AVAILABLE',
      page: '2',
      pageSize: '48',
    });
  });

  it('uploads multiple files with only the V4 frozen multipart fields', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ success: true, data: [asset] })));
    vi.stubGlobal('fetch', fetchMock);
    const files = [
      new File(['one'], 'one.mp4', { type: 'video/mp4' }),
      new File(['two'], 'two.mp4', { type: 'video/mp4' }),
    ];

    await importAssets('project-1', files, 'FISSION', 'FISSION_CLONE', 'REFERENCE_VIDEO');

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/projects/project-1/assets/imports');
    const form = (fetchMock.mock.calls[0]?.[1] as RequestInit).body as FormData;
    expect(form.getAll('files')).toEqual(files);
    expect(Object.fromEntries(form.entries())).toMatchObject({
      workflow: 'FISSION',
      space: 'FISSION_CLONE',
      type: 'REFERENCE_VIDEO',
    });
    expect(form.get('name')).toBeNull();
  });

  it('uses frozen version, snapshot, upgrade and batch routes', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => new Response(JSON.stringify({ success: true, data: asset })));
    vi.stubGlobal('fetch', fetchMock);

    await createAssetVersion('project-1', 'asset-1', { changeNote: '更新画面' });
    await importAssetSnapshot('project-2', {
      sourceProjectId: 'project-1',
      sourceAssetId: 'asset-1',
      targetWorkflow: 'EFFECT',
      targetSpace: 'EFFECT',
    });
    await upgradeAssetSnapshot('project-2', 'snapshot-1');
    await batchTagAssets('project-2', { assetIds: ['snapshot-1'], tags: ['精选'] });
    await batchArchiveAssets('project-2', { assetIds: ['snapshot-1'] });

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      '/api/projects/project-1/assets/asset-1/versions',
      '/api/projects/project-2/assets/import-snapshot',
      '/api/projects/project-2/assets/snapshot-1/upgrade-source',
      '/api/projects/project-2/assets/batch-tags',
      '/api/projects/project-2/assets/batch-archive',
    ]);
  });

  it('loads the version timeline from the project-scoped asset route', async () => {
    const versions = [{ id: 'version-2', assetId: 'asset-1', version: 2, changeNote: '更新画面' }];
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ success: true, data: versions })));
    vi.stubGlobal('fetch', fetchMock);

    await expect(listAssetVersions('project-1', 'asset-1')).resolves.toMatchObject({
      data: versions,
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/projects/project-1/assets/asset-1/versions');
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'GET' });
  });

  it('sends the frozen multipart fields and tags as JSON', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ success: true, data: asset })));
    vi.stubGlobal('fetch', fetchMock);
    const file = new File(['pixels'], 'brand.png', { type: 'image/png' });

    await importAsset('project-1', file, {
      name: '品牌原图',
      directory: 'SOURCE_MATERIALS',
      type: 'SOURCE_MATERIAL',
      tags: ['品牌', '原图'],
      notes: '拍摄原片',
    });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const form = init.body as FormData;
    expect(form.get('file')).toBe(file);
    expect(form.get('name')).toBe('品牌原图');
    expect(form.get('directory')).toBe('SOURCE_MATERIALS');
    expect(form.get('type')).toBe('SOURCE_MATERIAL');
    expect(form.get('tags')).toBe('["品牌","原图"]');
    expect(form.get('notes')).toBe('拍摄原片');
  });

  it('uses project-scoped paths for edit and archive', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: asset })))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: true,
            data: { id: 'asset-1', archivedAt: '2026-08-20T03:00:00.000Z' },
          }),
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    await updateAsset('project-1', 'asset-1', {
      name: '新版名称',
      directory: 'SOURCE_MATERIALS',
      type: 'SOURCE_MATERIAL',
      tags: [],
      notes: null,
    });
    await archiveAsset('project-1', 'asset-1');

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/projects/project-1/assets/asset-1');
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'PATCH' });
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/projects/project-1/assets/asset-1/archive');
  });
});
