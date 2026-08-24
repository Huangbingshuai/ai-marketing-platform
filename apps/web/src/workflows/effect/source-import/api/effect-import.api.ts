import type {
  AdvanceEffectImportDraftData,
  AdvanceEffectImportDraftRequest,
  ApiResponse,
  BatchDeleteEffectImportProductsData,
  BatchDeleteEffectImportProductsRequest,
  BatchRetryEffectImportProductsData,
  BatchRetryEffectImportProductsRequest,
  CancelEffectManifestData,
  CommitEffectManifestData,
  CommitEffectManifestRequest,
  CreateEffectImportMaterialRequest,
  CreateEffectImportProductRequest,
  EffectImportDeleteData,
  EffectImportDraft,
  EffectImportMaterialMutationData,
  EffectImportMode,
  EffectImportProductListData,
  EffectImportProductListQuery,
  EffectImportProductMutationData,
  EffectManifestFormat,
  GetEffectImportWorkspaceData,
  PreviewEffectManifestData,
  ReplaceEffectImportMaterialContentRequest,
  SwitchEffectImportModeData,
  SwitchEffectImportModeRequest,
  UpdateEffectImportDraftData,
  UpdateEffectImportDraftRequest,
  UpdateEffectImportProductRequest,
  ValidateEffectImportDraftData,
  ValidateEffectImportDraftRequest,
  ValidateEffectImportLinkData,
  ValidateEffectImportLinkRequest,
} from '@ai-marketing/contracts';

import { requestJson, requestRaw } from '../../../../api/http-client';

const basePath = (projectId: string): string =>
  `/projects/${encodeURIComponent(projectId)}/workflows/effect/source-import`;

const draftPath = (projectId: string, mode: EffectImportMode): string =>
  `${basePath(projectId)}/drafts/${mode}`;

const revisionHeaders = (revision: number): Record<string, string> => ({
  'If-Match': String(revision),
});

export const getEffectImportWorkspace = (
  projectId: string,
  signal?: AbortSignal,
): Promise<ApiResponse<GetEffectImportWorkspaceData>> =>
  requestJson(`${basePath(projectId)}`, {
    operation: '加载资料包工作区',
    signal,
  });

export const switchEffectImportMode = (
  projectId: string,
  input: SwitchEffectImportModeRequest,
  signal?: AbortSignal,
): Promise<ApiResponse<SwitchEffectImportModeData>> =>
  requestJson(`${basePath(projectId)}/mode`, {
    method: 'PATCH',
    body: input,
    headers: revisionHeaders(input.expectedRevision),
    operation: '切换导入模式',
    signal,
  });

export const getEffectImportDraft = (
  projectId: string,
  mode: EffectImportMode,
  signal?: AbortSignal,
): Promise<ApiResponse<EffectImportDraft>> =>
  requestJson(draftPath(projectId, mode), {
    operation: '加载导入草稿',
    signal,
  });

export const updateEffectImportDraft = (
  projectId: string,
  mode: EffectImportMode,
  input: UpdateEffectImportDraftRequest,
  signal?: AbortSignal,
): Promise<ApiResponse<UpdateEffectImportDraftData>> =>
  requestJson(draftPath(projectId, mode), {
    method: 'PUT',
    body: input,
    headers: revisionHeaders(input.expectedRevision),
    operation: '保存全局视频配置',
    signal,
  });

export const listEffectImportProducts = (
  projectId: string,
  mode: EffectImportMode,
  query: EffectImportProductListQuery,
  signal?: AbortSignal,
): Promise<ApiResponse<EffectImportProductListData>> => {
  const search = new URLSearchParams();
  if (query.keyword) search.set('keyword', query.keyword);
  if (query.category) search.set('category', query.category);
  if (query.page) search.set('page', String(query.page));
  if (query.pageSize) search.set('pageSize', String(query.pageSize));
  const suffix = search.size ? `?${search.toString()}` : '';
  return requestJson(`${draftPath(projectId, mode)}/products${suffix}`, {
    operation: '加载产品列表',
    signal,
  });
};

export const createEffectImportProduct = (
  projectId: string,
  mode: EffectImportMode,
  input: CreateEffectImportProductRequest,
  signal?: AbortSignal,
): Promise<ApiResponse<EffectImportProductMutationData>> =>
  requestJson(`${draftPath(projectId, mode)}/products`, {
    method: 'POST',
    body: input,
    headers: revisionHeaders(input.expectedRevision),
    operation: '新增产品',
    signal,
  });

export const updateEffectImportProduct = (
  projectId: string,
  mode: EffectImportMode,
  productId: string,
  input: UpdateEffectImportProductRequest,
  signal?: AbortSignal,
): Promise<ApiResponse<EffectImportProductMutationData>> =>
  requestJson(`${draftPath(projectId, mode)}/products/${encodeURIComponent(productId)}`, {
    method: 'PATCH',
    body: input,
    headers: revisionHeaders(input.expectedRevision),
    operation: '保存产品资料',
    signal,
  });

export const deleteEffectImportProduct = (
  projectId: string,
  mode: EffectImportMode,
  productId: string,
  expectedRevision: number,
  signal?: AbortSignal,
): Promise<ApiResponse<EffectImportDeleteData>> =>
  requestJson(`${draftPath(projectId, mode)}/products/${encodeURIComponent(productId)}`, {
    method: 'DELETE',
    body: { expectedRevision },
    headers: revisionHeaders(expectedRevision),
    operation: '删除产品',
    signal,
  });

export const batchDeleteEffectImportProducts = (
  projectId: string,
  mode: EffectImportMode,
  input: BatchDeleteEffectImportProductsRequest,
  signal?: AbortSignal,
): Promise<ApiResponse<BatchDeleteEffectImportProductsData>> =>
  requestJson(`${draftPath(projectId, mode)}/products/batch-delete`, {
    method: 'POST',
    body: input,
    headers: revisionHeaders(input.expectedRevision),
    operation: '批量删除产品',
    signal,
  });

export const batchRetryEffectImportProducts = (
  projectId: string,
  mode: EffectImportMode,
  input: BatchRetryEffectImportProductsRequest,
  signal?: AbortSignal,
): Promise<ApiResponse<BatchRetryEffectImportProductsData>> =>
  requestJson(`${draftPath(projectId, mode)}/products/batch-retry`, {
    method: 'POST',
    body: input,
    headers: revisionHeaders(input.expectedRevision),
    operation: '重试失败资料',
    signal,
  });

export const validateEffectImportLink = (
  projectId: string,
  mode: EffectImportMode,
  productId: string,
  input: ValidateEffectImportLinkRequest,
  signal?: AbortSignal,
): Promise<ApiResponse<ValidateEffectImportLinkData>> =>
  requestJson(
    `${draftPath(projectId, mode)}/products/${encodeURIComponent(productId)}/validate-link`,
    { method: 'POST', body: input, operation: '校验电商链接', signal },
  );

export const uploadEffectImportMaterial = (
  projectId: string,
  mode: EffectImportMode,
  productId: string,
  file: File,
  input: CreateEffectImportMaterialRequest,
  signal?: AbortSignal,
): Promise<ApiResponse<EffectImportMaterialMutationData>> => {
  const form = new FormData();
  form.set('file', file);
  form.set('type', input.type);
  form.set('expectedRevision', String(input.expectedRevision));
  if (input.expectedFileName) form.set('expectedFileName', input.expectedFileName);
  return requestJson(
    `${draftPath(projectId, mode)}/products/${encodeURIComponent(productId)}/materials`,
    {
      method: 'POST',
      body: form,
      headers: revisionHeaders(input.expectedRevision),
      operation: '上传产品资料',
      signal,
    },
  );
};

export const replaceEffectImportMaterial = (
  projectId: string,
  mode: EffectImportMode,
  productId: string,
  materialId: string,
  file: File,
  input: ReplaceEffectImportMaterialContentRequest,
  signal?: AbortSignal,
): Promise<ApiResponse<EffectImportMaterialMutationData>> => {
  const form = new FormData();
  form.set('file', file);
  form.set('expectedRevision', String(input.expectedRevision));
  return requestJson(
    `${draftPath(projectId, mode)}/products/${encodeURIComponent(productId)}/materials/${encodeURIComponent(materialId)}/content`,
    {
      method: 'PUT',
      body: form,
      headers: revisionHeaders(input.expectedRevision),
      operation: '重新上传资料',
      signal,
    },
  );
};

export const deleteEffectImportMaterial = (
  projectId: string,
  mode: EffectImportMode,
  productId: string,
  materialId: string,
  expectedRevision: number,
  signal?: AbortSignal,
): Promise<ApiResponse<EffectImportDeleteData>> =>
  requestJson(
    `${draftPath(projectId, mode)}/products/${encodeURIComponent(productId)}/materials/${encodeURIComponent(materialId)}`,
    {
      method: 'DELETE',
      body: { expectedRevision },
      headers: revisionHeaders(expectedRevision),
      operation: '删除资料',
      signal,
    },
  );

export const previewEffectManifest = (
  projectId: string,
  manifest: File,
  files: File[],
  expectedRevision: number,
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<ApiResponse<PreviewEffectManifestData>> => {
  const form = new FormData();
  form.set('manifest', manifest);
  files.forEach((file) => form.append('files', file));
  form.set('expectedRevision', String(expectedRevision));
  form.set('idempotencyKey', idempotencyKey);
  return requestJson(`${draftPath(projectId, 'BATCH')}/manifest-imports/preview`, {
    method: 'POST',
    body: form,
    headers: revisionHeaders(expectedRevision),
    operation: '预览批量清单',
    signal,
  });
};

export const commitEffectManifest = (
  projectId: string,
  importId: string,
  input: CommitEffectManifestRequest,
  signal?: AbortSignal,
): Promise<ApiResponse<CommitEffectManifestData>> =>
  requestJson(
    `${draftPath(projectId, 'BATCH')}/manifest-imports/${encodeURIComponent(importId)}/commit`,
    {
      method: 'POST',
      body: input,
      headers: revisionHeaders(input.expectedRevision),
      operation: '确认导入清单',
      signal,
    },
  );

export const cancelEffectManifest = (
  projectId: string,
  importId: string,
  expectedRevision: number,
  signal?: AbortSignal,
): Promise<ApiResponse<CancelEffectManifestData>> =>
  requestJson(`${draftPath(projectId, 'BATCH')}/manifest-imports/${encodeURIComponent(importId)}`, {
    method: 'DELETE',
    body: { expectedRevision },
    headers: revisionHeaders(expectedRevision),
    operation: '取消清单预览',
    signal,
  });

export const downloadEffectManifestTemplate = async (
  projectId: string,
  format: EffectManifestFormat,
  signal?: AbortSignal,
): Promise<{ blob: Blob; fileName: string }> => {
  const response = await requestRaw(`${basePath(projectId)}/manifest-template?format=${format}`, {
    operation: '下载清单模板',
    signal,
  });
  const disposition = response.headers.get('content-disposition') ?? '';
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
  const plain = /filename="?([^";]+)"?/i.exec(disposition)?.[1];
  const fileName = encoded
    ? decodeURIComponent(encoded)
    : (plain ?? `效果类资料包清单模板.${format}`);
  return { blob: await response.blob(), fileName };
};

export const validateEffectImportDraft = (
  projectId: string,
  mode: EffectImportMode,
  input: ValidateEffectImportDraftRequest,
  signal?: AbortSignal,
): Promise<ApiResponse<ValidateEffectImportDraftData>> =>
  requestJson(`${draftPath(projectId, mode)}/validate`, {
    method: 'POST',
    body: input,
    headers: revisionHeaders(input.expectedRevision),
    operation: '校验资料包',
    signal,
  });

export const advanceEffectImportDraft = (
  projectId: string,
  mode: EffectImportMode,
  input: AdvanceEffectImportDraftRequest,
  signal?: AbortSignal,
): Promise<ApiResponse<AdvanceEffectImportDraftData>> =>
  requestJson(`${draftPath(projectId, mode)}/advance`, {
    method: 'POST',
    body: input,
    headers: revisionHeaders(input.expectedRevision),
    operation: '进入 AI 信息提炼',
    signal,
  });
