import type {
  ApiResponse,
  GetEffectSegmentRenderWorkspaceData,
  SaveEffectSegmentRenderSettingsData,
  SaveEffectSegmentRenderSettingsRequest,
} from '@ai-marketing/contracts';

import { requestJson } from '../../../../api/http-client';

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
