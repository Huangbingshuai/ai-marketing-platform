import type {
  ApiResponse,
  CustomizedExtractionWorkspace,
  CustomizedExtractionTask,
  ExtractionNodeDetail,
  SaveCustomizedExtractionRequest,
  StartCustomizedExtractionRequest,
} from '@ai-marketing/contracts';
import { requestJson } from '../../../api/http-client';
const base = (projectId: string) =>
  `/projects/${encodeURIComponent(projectId)}/workflows/customized/information-extraction`;
export const extractionApi = {
  workspace: (projectId: string, workflowRunId: string, signal?: AbortSignal) =>
    requestJson<ApiResponse<CustomizedExtractionWorkspace>>(
      `${base(projectId)}?workflowRunId=${encodeURIComponent(workflowRunId)}`,
      { signal },
    ),
  task: (projectId: string, taskId: string, signal?: AbortSignal) =>
    requestJson<ApiResponse<{ task: CustomizedExtractionTask }>>(
      `${base(projectId)}/tasks/${taskId}`,
      { signal },
    ),
  detail: (projectId: string, taskId: string, nodeId: string, signal?: AbortSignal) =>
    requestJson<ApiResponse<ExtractionNodeDetail>>(
      `${base(projectId)}/tasks/${taskId}/nodes/${nodeId}`,
      { signal },
    ),
  start: (projectId: string, body: StartCustomizedExtractionRequest, signal?: AbortSignal) =>
    requestJson<ApiResponse<{ task: CustomizedExtractionTask }>>(`${base(projectId)}/tasks`, {
      method: 'POST',
      body,
      signal,
    }),
  retry: (projectId: string, taskId: string, signal?: AbortSignal) =>
    requestJson<ApiResponse<{ task: CustomizedExtractionTask }>>(
      `${base(projectId)}/tasks/${taskId}/retry`,
      { method: 'POST', signal },
    ),
  edit: (projectId: string, workflowRunId: string, cancel = false, signal?: AbortSignal) =>
    requestJson<ApiResponse<{ workflowRunId: string }>>(
      `${base(projectId)}/${cancel ? 'cancel-edit' : 'edit'}`,
      { method: 'POST', body: { workflowRunId }, signal },
    ),
  update: (
    projectId: string,
    resultId: string,
    body: SaveCustomizedExtractionRequest,
    signal?: AbortSignal,
  ) =>
    requestJson<ApiResponse<{ id: string; revision: number }>>(
      `${base(projectId)}/results/${resultId}`,
      { method: 'PUT', body, signal },
    ),
  confirm: (projectId: string, resultId: string, expectedRevision: number, signal?: AbortSignal) =>
    requestJson<ApiResponse<{ workflowRunId: string; unchanged: boolean }>>(
      `${base(projectId)}/results/${resultId}/confirm`,
      { method: 'POST', body: { expectedRevision }, signal },
    ),
};
