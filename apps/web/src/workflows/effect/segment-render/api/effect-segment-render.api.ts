import type {
  ApiResponse,
  EffectSegmentImportDraft,
  EffectSegmentImportConfirmItem,
  DecideEffectSegmentRenderRepairData,
  DecideEffectSegmentRenderRepairRequest,
  EffectSegmentRenderBatch,
  DeleteEffectSegmentRenderMaterialsRequest,
  ExportEffectSegmentRenderMaterialsRequest,
  GetEffectSegmentRenderWorkspaceData,
  ImportEffectSegmentRenderMaterialsData,
  ImportEffectSegmentRenderMaterialsRequest,
  RegenerateEffectSegmentRenderTasksRequest,
  RefreshEffectSegmentRenderBatchRequest,
  SaveEffectSegmentRenderSettingsData,
  SaveEffectSegmentRenderSettingsRequest,
  StartEffectSegmentRenderRepairData,
  StartEffectSegmentRenderRepairRequest,
  StartEffectSegmentRenderBatchData,
  StartEffectSegmentRenderBatchRequest,
  ValidateEffectSegmentRenderBatchData,
  ValidateEffectSegmentRenderBatchRequest,
} from '@ai-marketing/contracts';

import { apiUrl, requestJson, requestRaw } from '../../../../api/http-client';

const basePath = (projectId: string): string =>
  `/projects/${encodeURIComponent(projectId)}/workflows/effect/segment-render`;

export const getEffectSegmentRenderWorkspace = (
  projectId: string,
  workflowRunId: string,
  productId: string,
  signal?: AbortSignal,
): Promise<ApiResponse<GetEffectSegmentRenderWorkspaceData>> =>
  requestJson(
    `${basePath(projectId)}/products/${encodeURIComponent(productId)}?workflowRunId=${encodeURIComponent(workflowRunId)}`,
    { operation: '加载视频渲染设置', signal },
  );

export const saveEffectSegmentRenderSettings = (
  projectId: string,
  productId: string,
  input: SaveEffectSegmentRenderSettingsRequest,
  signal?: AbortSignal,
): Promise<ApiResponse<SaveEffectSegmentRenderSettingsData>> =>
  requestJson(`${basePath(projectId)}/products/${encodeURIComponent(productId)}/settings`, {
    method: 'PUT',
    body: input,
    operation: '保存视频渲染设置',
    signal,
  });

export const getEffectSegmentRenderBatch = (
  projectId: string,
  batchId: string,
  signal?: AbortSignal,
): Promise<ApiResponse<{ batch: EffectSegmentRenderBatch }>> =>
  requestJson(`${basePath(projectId)}/batches/${encodeURIComponent(batchId)}`, {
    operation: '加载视频渲染批次',
    signal,
  });

export const startEffectSegmentRenderBatch = (
  projectId: string,
  productId: string,
  input: StartEffectSegmentRenderBatchRequest,
  signal?: AbortSignal,
): Promise<ApiResponse<StartEffectSegmentRenderBatchData>> =>
  requestJson(`${basePath(projectId)}/products/${encodeURIComponent(productId)}/batches`, {
    method: 'POST',
    body: input,
    operation: '创建视频渲染批次',
    signal,
  });

export const regenerateEffectSegmentRenderTasks = (
  projectId: string,
  batchId: string,
  input: RegenerateEffectSegmentRenderTasksRequest,
  signal?: AbortSignal,
): Promise<ApiResponse<{ batch: EffectSegmentRenderBatch; replayed: boolean }>> =>
  requestJson(`${basePath(projectId)}/batches/${encodeURIComponent(batchId)}/tasks/regenerate`, {
    method: 'POST',
    body: input,
    operation: '重新生成视频片段',
    signal,
  });

export const refreshEffectSegmentRenderBatch = (
  projectId: string,
  batchId: string,
  input: RefreshEffectSegmentRenderBatchRequest,
  signal?: AbortSignal,
): Promise<ApiResponse<StartEffectSegmentRenderBatchData>> =>
  requestJson(`${basePath(projectId)}/batches/${encodeURIComponent(batchId)}/refresh`, {
    method: 'POST',
    body: input,
    operation: '局部更新渲染素材',
    signal,
  });

export const importEffectSegmentRenderMaterials = (
  projectId: string,
  batchId: string,
  input: ImportEffectSegmentRenderMaterialsRequest,
  files: readonly File[],
  signal?: AbortSignal,
): Promise<ApiResponse<ImportEffectSegmentRenderMaterialsData>> => {
  const body = new FormData();
  body.append('expectedBatchRevision', String(input.expectedBatchRevision));
  body.append('idempotencyKey', input.idempotencyKey);
  body.append('mappings', JSON.stringify(input.mappings));
  files.forEach((file) => body.append('files', file, file.name));
  return requestJson(`${basePath(projectId)}/batches/${encodeURIComponent(batchId)}/tasks/import`, {
    method: 'POST',
    body,
    operation: '导入视频素材',
    signal,
  });
};

export const deleteEffectSegmentRenderMaterials = (
  projectId: string,
  batchId: string,
  input: DeleteEffectSegmentRenderMaterialsRequest,
  signal?: AbortSignal,
): Promise<ApiResponse<{ batch: EffectSegmentRenderBatch; replayed: boolean }>> =>
  requestJson(`${basePath(projectId)}/batches/${encodeURIComponent(batchId)}/tasks/delete`, {
    method: 'POST',
    body: input,
    operation: '删除视频素材',
    signal,
  });

export const exportEffectSegmentRenderMaterials = (
  projectId: string,
  batchId: string,
  input: ExportEffectSegmentRenderMaterialsRequest,
  signal?: AbortSignal,
): Promise<Response> =>
  requestRaw(`${basePath(projectId)}/batches/${encodeURIComponent(batchId)}/export`, {
    method: 'POST',
    body: input,
    operation: '导出视频素材',
    signal,
  });

export const startEffectSegmentRenderRepair = (
  projectId: string,
  batchId: string,
  taskId: string,
  input: StartEffectSegmentRenderRepairRequest,
  signal?: AbortSignal,
): Promise<ApiResponse<StartEffectSegmentRenderRepairData>> =>
  requestJson(
    `${basePath(projectId)}/batches/${encodeURIComponent(batchId)}/tasks/${encodeURIComponent(taskId)}/repair`,
    {
      method: 'POST',
      body: input,
      operation: '创建视频画面返修任务',
      signal,
    },
  );

export const stageEffectSegmentImport = (
  projectId: string,
  batchId: string,
  file: File,
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<ApiResponse<{ draft: EffectSegmentImportDraft }>> => {
  const body = new FormData();
  body.append('idempotencyKey', idempotencyKey);
  body.append('files', file, file.name);
  return requestJson(
    `${basePath(projectId)}/batches/${encodeURIComponent(batchId)}/imports/drafts`,
    { method: 'POST', body, signal, operation: '校验导入视频' },
  );
};
export const describeEffectSegmentImport = (
  projectId: string,
  batchId: string,
  id: string,
  idempotencyKey: string,
): Promise<ApiResponse<{ draft: EffectSegmentImportDraft }>> =>
  requestJson(
    `${basePath(projectId)}/batches/${encodeURIComponent(batchId)}/imports/drafts/${encodeURIComponent(id)}/describe`,
    { method: 'POST', body: { idempotencyKey }, operation: 'AI 生成视频素材提示词' },
  );
export const getEffectSegmentImport = (
  projectId: string,
  batchId: string,
  id: string,
  signal?: AbortSignal,
): Promise<ApiResponse<{ draft: EffectSegmentImportDraft }>> =>
  requestJson(
    `${basePath(projectId)}/batches/${encodeURIComponent(batchId)}/imports/drafts/${encodeURIComponent(id)}`,
    { method: 'GET', signal, operation: '读取视频素材提示词进度' },
  );
export const cancelEffectSegmentImport = (projectId: string, batchId: string, id: string) =>
  requestJson(
    `${basePath(projectId)}/batches/${encodeURIComponent(batchId)}/imports/drafts/${encodeURIComponent(id)}/cancel`,
    { method: 'POST', operation: '取消视频素材导入' },
  );
export const confirmEffectSegmentImports = (
  projectId: string,
  batchId: string,
  input: {
    items: EffectSegmentImportConfirmItem[];
    expectedBatchRevision: number;
    idempotencyKey: string;
  },
): Promise<
  ApiResponse<{ batch: EffectSegmentRenderBatch; importedCount: number; replayed: boolean }>
> =>
  requestJson(`${basePath(projectId)}/batches/${encodeURIComponent(batchId)}/imports/confirm`, {
    method: 'POST',
    body: input,
    operation: '新增视频素材',
  });

export const decideEffectSegmentRenderRepair = (
  projectId: string,
  batchId: string,
  taskId: string,
  input: DecideEffectSegmentRenderRepairRequest,
  signal?: AbortSignal,
): Promise<ApiResponse<DecideEffectSegmentRenderRepairData>> =>
  requestJson(
    `${basePath(projectId)}/batches/${encodeURIComponent(batchId)}/tasks/${encodeURIComponent(taskId)}/repair/decision`,
    {
      method: 'POST',
      body: input,
      operation: input.decision === 'ACCEPT' ? '采用视频返修结果' : '放弃视频返修结果',
      signal,
    },
  );

export const getEffectSegmentRenderTaskContent = (
  projectId: string,
  batchId: string,
  taskId: string,
  variant: 'ACTIVE' | 'REPAIR',
  version?: number,
  signal?: AbortSignal,
): Promise<Response> =>
  requestRaw(
    `${basePath(projectId)}/batches/${encodeURIComponent(batchId)}/tasks/${encodeURIComponent(taskId)}/content?variant=${variant}&kind=VIDEO${version ? `&version=${version}` : ''}`,
    { operation: variant === 'REPAIR' ? '加载视频返修候选' : '加载视频素材', signal },
  );

export const effectSegmentRenderTaskContentUrl = (
  projectId: string,
  batchId: string,
  taskId: string,
  variant: 'ACTIVE' | 'REPAIR' = 'ACTIVE',
  kind: 'VIDEO' | 'POSTER' = 'VIDEO',
  version?: number,
): string =>
  apiUrl(
    `${basePath(projectId)}/batches/${encodeURIComponent(batchId)}/tasks/${encodeURIComponent(taskId)}/content?variant=${variant}&kind=${kind}${version ? `&version=${version}` : ''}`,
  );

export const validateEffectSegmentRenderBatch = (
  projectId: string,
  batchId: string,
  input: ValidateEffectSegmentRenderBatchRequest,
  signal?: AbortSignal,
): Promise<ApiResponse<ValidateEffectSegmentRenderBatchData>> =>
  requestJson(`${basePath(projectId)}/batches/${encodeURIComponent(batchId)}/validate`, {
    method: 'POST',
    body: input,
    operation: '完成视频渲染校验',
    signal,
  });
