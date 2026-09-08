import type {
  ApiResponse,
  DecideEffectSegmentRenderRepairData,
  DecideEffectSegmentRenderRepairRequest,
  EffectSegmentRenderBatch,
  GetEffectSegmentRenderWorkspaceData,
  SaveEffectSegmentRenderSettingsData,
  SaveEffectSegmentRenderSettingsRequest,
  StartEffectSegmentRenderRepairData,
  StartEffectSegmentRenderRepairRequest,
} from '@ai-marketing/contracts';

import { requestJson, requestRaw } from '../../../../api/http-client';

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
  signal?: AbortSignal,
): Promise<Response> =>
  requestRaw(
    `${basePath(projectId)}/batches/${encodeURIComponent(batchId)}/tasks/${encodeURIComponent(taskId)}/content?variant=${variant}`,
    { operation: variant === 'REPAIR' ? '加载视频返修候选' : '加载视频素材', signal },
  );
