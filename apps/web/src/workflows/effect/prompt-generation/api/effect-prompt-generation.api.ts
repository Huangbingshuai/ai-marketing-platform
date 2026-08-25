import type {
  ApiResponse,
  EffectPromptBatchResult,
  EffectPromptFragmentType,
  GetEffectPromptNodeDetailData,
  GetEffectPromptResultData,
  GetEffectPromptRunData,
  GetEffectPromptWorkspaceData,
  SaveEffectPromptSettingsData,
  SaveEffectPromptSettingsRequest,
  StartEffectPromptRunData,
  StartEffectPromptRunRequest,
  UpdateEffectPromptResultData,
  UpsertEffectPromptItemRequest,
  ValidateEffectPromptResultData,
  ValidateEffectPromptResultRequest,
} from '@ai-marketing/contracts';

import { requestJson } from '../../../../api/http-client';

export type ExportEffectPromptResultData = {
  schemaVersion: number;
  productId: string;
  resultId: string;
  revision: number;
  exportedAt: string;
  result: EffectPromptBatchResult;
};

const basePath = (projectId: string): string =>
  `/projects/${encodeURIComponent(projectId)}/workflows/effect/prompt-generation`;

const revisionHeaders = (revision: number | null): Record<string, string> => ({
  'If-Match': revision === null ? '*' : String(revision),
});

export const getEffectPromptWorkspace = (
  projectId: string,
  workflowRunId: string,
  signal?: AbortSignal,
): Promise<ApiResponse<GetEffectPromptWorkspaceData>> =>
  requestJson(`${basePath(projectId)}?workflowRunId=${encodeURIComponent(workflowRunId)}`, {
    operation: '加载差异化 Prompt 工作区',
    signal,
  });

export const saveEffectPromptSettings = (
  projectId: string,
  productId: string,
  input: SaveEffectPromptSettingsRequest,
  signal?: AbortSignal,
): Promise<ApiResponse<SaveEffectPromptSettingsData>> =>
  requestJson(`${basePath(projectId)}/products/${encodeURIComponent(productId)}/settings`, {
    method: 'PUT',
    body: input,
    headers: revisionHeaders(input.expectedRevision),
    operation: '保存 Prompt 批次设置',
    signal,
  });

export const getEffectPromptResult = (
  projectId: string,
  workflowRunId: string,
  productId: string,
  page: number,
  query: string,
  fragmentType?: EffectPromptFragmentType,
  signal?: AbortSignal,
): Promise<ApiResponse<GetEffectPromptResultData>> => {
  const search = new URLSearchParams({
    workflowRunId,
    page: String(page),
    pageSize: '10',
  });
  if (query.trim()) search.set('query', query.trim());
  if (fragmentType) search.set('fragmentType', fragmentType);
  return requestJson(
    `${basePath(projectId)}/products/${encodeURIComponent(productId)}/result?${search.toString()}`,
    { operation: '加载 Prompt 结果', signal },
  );
};

export const startEffectPromptRun = (
  projectId: string,
  productId: string,
  input: StartEffectPromptRunRequest,
  signal?: AbortSignal,
): Promise<ApiResponse<StartEffectPromptRunData>> =>
  requestJson(`${basePath(projectId)}/products/${encodeURIComponent(productId)}/runs`, {
    method: 'POST',
    body: input,
    headers: revisionHeaders(input.expectedSettingsRevision),
    operation: input.operation === 'ITEM_REGENERATE' ? '重新生成单条 Prompt' : '生成 Prompt 批次',
    signal,
  });

export const getEffectPromptRun = (
  projectId: string,
  runId: string,
  signal?: AbortSignal,
): Promise<ApiResponse<GetEffectPromptRunData>> =>
  requestJson(`${basePath(projectId)}/runs/${encodeURIComponent(runId)}`, {
    operation: '查询 Prompt 生成进度',
    signal,
  });

export const getEffectPromptNodeDetail = (
  projectId: string,
  runId: string,
  nodeId: string,
  signal?: AbortSignal,
): Promise<ApiResponse<GetEffectPromptNodeDetailData>> =>
  requestJson(
    `${basePath(projectId)}/runs/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(nodeId)}`,
    { operation: '加载 Prompt 子工作流节点详情', signal },
  );

export const addEffectPromptItem = (
  projectId: string,
  resultId: string,
  input: UpsertEffectPromptItemRequest,
  signal?: AbortSignal,
): Promise<ApiResponse<UpdateEffectPromptResultData>> =>
  requestJson(`${basePath(projectId)}/results/${encodeURIComponent(resultId)}/items`, {
    method: 'POST',
    body: input,
    headers: revisionHeaders(input.expectedRevision),
    operation: '添加人工 Prompt',
    signal,
  });

export const updateEffectPromptItem = (
  projectId: string,
  resultId: string,
  itemId: string,
  input: UpsertEffectPromptItemRequest,
  signal?: AbortSignal,
): Promise<ApiResponse<UpdateEffectPromptResultData>> =>
  requestJson(
    `${basePath(projectId)}/results/${encodeURIComponent(resultId)}/items/${encodeURIComponent(itemId)}`,
    {
      method: 'PUT',
      body: input,
      headers: revisionHeaders(input.expectedRevision),
      operation: '保存 Prompt 修改',
      signal,
    },
  );

export const deleteEffectPromptItem = (
  projectId: string,
  resultId: string,
  itemId: string,
  expectedRevision: number,
  signal?: AbortSignal,
): Promise<ApiResponse<UpdateEffectPromptResultData>> =>
  requestJson(
    `${basePath(projectId)}/results/${encodeURIComponent(resultId)}/items/${encodeURIComponent(itemId)}`,
    {
      method: 'DELETE',
      body: { expectedRevision },
      headers: revisionHeaders(expectedRevision),
      operation: '删除 Prompt',
      signal,
    },
  );

export const validateEffectPromptResult = (
  projectId: string,
  resultId: string,
  input: ValidateEffectPromptResultRequest,
  signal?: AbortSignal,
): Promise<ApiResponse<ValidateEffectPromptResultData>> =>
  requestJson(`${basePath(projectId)}/results/${encodeURIComponent(resultId)}/validate`, {
    method: 'POST',
    body: input,
    headers: revisionHeaders(input.expectedRevision),
    operation: '完成 Prompt 校验',
    signal,
  });

export const exportEffectPromptResult = (
  projectId: string,
  resultId: string,
  signal?: AbortSignal,
): Promise<ApiResponse<ExportEffectPromptResultData>> =>
  requestJson(`${basePath(projectId)}/results/${encodeURIComponent(resultId)}/export`, {
    operation: '导出 Prompt 批次',
    signal,
  });
