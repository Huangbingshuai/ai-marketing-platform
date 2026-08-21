import type {
  ApiResponse,
  ArchiveAssetData,
  Asset,
  AssetWorkflow,
  AssetWorkflowSpace,
  BatchArchiveAssetsRequest,
  BatchAssetResult,
  BatchTagAssetsRequest,
  CreateAssetVersionRequest,
  ImportAssetSnapshotRequest,
  AssetListData,
  AssetListQuery,
  AssetVersion,
  CreateAssetMetadata,
  UpdateAssetRequest,
} from '@ai-marketing/contracts';

import { requestJson } from '../../../api/http-client';

const assetBasePath = (projectId: string): string =>
  `/projects/${encodeURIComponent(projectId)}/assets`;

export const listAssets = (
  projectId: string,
  query: AssetListQuery,
  signal?: AbortSignal,
): Promise<ApiResponse<AssetListData>> => {
  const search = new URLSearchParams();
  if (query.keyword) search.set('keyword', query.keyword);
  if (query.directory) search.set('directory', query.directory);
  if (query.type) search.set('type', query.type);
  if (query.tag) search.set('tag', query.tag);
  if (query.workflow) search.set('workflow', query.workflow);
  if (query.space) search.set('space', query.space);
  if (query.status) search.set('status', query.status);
  if (query.page) search.set('page', String(query.page));
  if (query.pageSize) search.set('pageSize', String(query.pageSize));
  const suffix = search.size ? `?${search.toString()}` : '';
  return requestJson<ApiResponse<AssetListData>>(`${assetBasePath(projectId)}${suffix}`, {
    operation: '加载资产列表',
    signal,
  });
};

export const importAssets = (
  projectId: string,
  files: File[],
  workflow: AssetWorkflow,
  space: AssetWorkflowSpace,
  type: Asset['type'],
  signal?: AbortSignal,
): Promise<ApiResponse<Asset[]>> => {
  const form = new FormData();
  files.forEach((file) => form.append('files', file));
  form.set('workflow', workflow);
  form.set('space', space);
  form.set('type', type);
  return requestJson<ApiResponse<Asset[]>>(`${assetBasePath(projectId)}/imports`, {
    method: 'POST',
    body: form,
    operation: '上传资产',
    signal,
  });
};

export const createAssetVersion = (
  projectId: string,
  assetId: string,
  input: CreateAssetVersionRequest,
  signal?: AbortSignal,
): Promise<ApiResponse<Asset>> =>
  requestJson<ApiResponse<Asset>>(
    `${assetBasePath(projectId)}/${encodeURIComponent(assetId)}/versions`,
    { method: 'POST', body: input, operation: '创建资产版本', signal },
  );

export const importAssetSnapshot = (
  targetProjectId: string,
  input: ImportAssetSnapshotRequest,
  signal?: AbortSignal,
): Promise<ApiResponse<Asset>> =>
  requestJson<ApiResponse<Asset>>(`${assetBasePath(targetProjectId)}/import-snapshot`, {
    method: 'POST',
    body: input,
    operation: '引用资产',
    signal,
  });

export const upgradeAssetSnapshot = (
  targetProjectId: string,
  assetId: string,
  signal?: AbortSignal,
): Promise<ApiResponse<Asset>> =>
  requestJson<ApiResponse<Asset>>(
    `${assetBasePath(targetProjectId)}/${encodeURIComponent(assetId)}/upgrade-source`,
    { method: 'POST', operation: '升级资产快照', signal },
  );

export const batchTagAssets = (
  projectId: string,
  input: BatchTagAssetsRequest,
  signal?: AbortSignal,
): Promise<ApiResponse<BatchAssetResult>> =>
  requestJson<ApiResponse<BatchAssetResult>>(`${assetBasePath(projectId)}/batch-tags`, {
    method: 'POST',
    body: input,
    operation: '批量打标签',
    signal,
  });

export const batchArchiveAssets = (
  projectId: string,
  input: BatchArchiveAssetsRequest,
  signal?: AbortSignal,
): Promise<ApiResponse<BatchAssetResult>> =>
  requestJson<ApiResponse<BatchAssetResult>>(`${assetBasePath(projectId)}/batch-archive`, {
    method: 'POST',
    body: input,
    operation: '批量移除资产',
    signal,
  });

export const getAsset = (
  projectId: string,
  assetId: string,
  signal?: AbortSignal,
): Promise<ApiResponse<Asset>> =>
  requestJson<ApiResponse<Asset>>(`${assetBasePath(projectId)}/${encodeURIComponent(assetId)}`, {
    operation: '加载资产详情',
    signal,
  });

export const listAssetVersions = (
  projectId: string,
  assetId: string,
  signal?: AbortSignal,
): Promise<ApiResponse<AssetVersion[]>> =>
  requestJson<ApiResponse<AssetVersion[]>>(
    `${assetBasePath(projectId)}/${encodeURIComponent(assetId)}/versions`,
    { operation: '加载资产版本', signal },
  );

export const importAsset = (
  projectId: string,
  file: File,
  metadata: CreateAssetMetadata,
  signal?: AbortSignal,
): Promise<ApiResponse<Asset>> => {
  const form = new FormData();
  form.set('file', file);
  form.set('name', metadata.name);
  form.set('directory', metadata.directory);
  form.set('type', metadata.type);
  form.set('tags', JSON.stringify(metadata.tags));
  if (metadata.notes) form.set('notes', metadata.notes);
  return requestJson<ApiResponse<Asset>>(assetBasePath(projectId), {
    method: 'POST',
    body: form,
    operation: '导入资产',
    signal,
  });
};

export const updateAsset = (
  projectId: string,
  assetId: string,
  input: UpdateAssetRequest,
  signal?: AbortSignal,
): Promise<ApiResponse<Asset>> =>
  requestJson<ApiResponse<Asset>>(`${assetBasePath(projectId)}/${encodeURIComponent(assetId)}`, {
    method: 'PATCH',
    body: input,
    operation: '编辑资产',
    signal,
  });

export const archiveAsset = (
  projectId: string,
  assetId: string,
  signal?: AbortSignal,
): Promise<ApiResponse<ArchiveAssetData>> =>
  requestJson<ApiResponse<ArchiveAssetData>>(
    `${assetBasePath(projectId)}/${encodeURIComponent(assetId)}/archive`,
    { method: 'POST', operation: '归档资产', signal },
  );
