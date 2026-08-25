import type {
  ApiResponse,
  GetEffectExtractionNodeDetailData,
  GetEffectExtractionRunData,
  GetEffectExtractionWorkspaceData,
  StartEffectExtractionRunData,
  StartEffectExtractionRunRequest,
  UpdateEffectExtractionResultData,
  UpdateEffectExtractionResultRequest,
  ValidateEffectExtractionResultData,
  ValidateEffectExtractionResultRequest,
} from '@ai-marketing/contracts';

import { requestJson } from '../../../../api/http-client';

const basePath = (projectId: string): string =>
  `/projects/${encodeURIComponent(projectId)}/workflows/effect/information-extraction`;

const revisionHeaders = (revision: number): Record<string, string> => ({
  'If-Match': String(revision),
});

export const getEffectExtractionWorkspace = (
  projectId: string,
  draftId: string,
  signal?: AbortSignal,
): Promise<ApiResponse<GetEffectExtractionWorkspaceData>> =>
  requestJson(`${basePath(projectId)}?draftId=${encodeURIComponent(draftId)}`, {
    operation: '加载 AI 信息提炼工作区',
    signal,
  });

export const startEffectExtractionRun = (
  projectId: string,
  productId: string,
  input: StartEffectExtractionRunRequest,
  signal?: AbortSignal,
): Promise<ApiResponse<StartEffectExtractionRunData>> =>
  requestJson(`${basePath(projectId)}/products/${encodeURIComponent(productId)}/runs`, {
    method: 'POST',
    body: input,
    headers: revisionHeaders(input.expectedRevision),
    operation: '启动 AI 信息提炼',
    signal,
  });

export const getEffectExtractionRun = (
  projectId: string,
  runId: string,
  signal?: AbortSignal,
): Promise<ApiResponse<GetEffectExtractionRunData>> =>
  requestJson(`${basePath(projectId)}/runs/${encodeURIComponent(runId)}`, {
    operation: '查询 AI 信息提炼进度',
    signal,
  });

export const getEffectExtractionNodeDetail = (
  projectId: string,
  runId: string,
  nodeId: string,
  signal?: AbortSignal,
): Promise<ApiResponse<GetEffectExtractionNodeDetailData>> =>
  requestJson(
    `${basePath(projectId)}/runs/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(nodeId)}`,
    {
      operation: '加载 AI 信息提炼节点详情',
      signal,
    },
  );

export const updateEffectExtractionResult = (
  projectId: string,
  resultId: string,
  input: UpdateEffectExtractionResultRequest,
  signal?: AbortSignal,
): Promise<ApiResponse<UpdateEffectExtractionResultData>> =>
  requestJson(`${basePath(projectId)}/results/${encodeURIComponent(resultId)}`, {
    method: 'PUT',
    body: input,
    headers: revisionHeaders(input.expectedRevision),
    operation: '保存 AI 信息提炼草稿',
    signal,
  });

export const validateEffectExtractionResult = (
  projectId: string,
  resultId: string,
  input: ValidateEffectExtractionResultRequest,
  signal?: AbortSignal,
): Promise<ApiResponse<ValidateEffectExtractionResultData>> =>
  requestJson(`${basePath(projectId)}/results/${encodeURIComponent(resultId)}/validate`, {
    method: 'POST',
    body: input,
    headers: revisionHeaders(input.expectedRevision),
    operation: '完成 AI 信息提炼校验',
    signal,
  });
