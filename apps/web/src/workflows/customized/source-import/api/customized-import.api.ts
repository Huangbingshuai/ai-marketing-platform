import type {
  ActivateWorkflowNodeData,
  ApiResponse,
  CustomizedWorkflowBranchTreeData,
  CustomizedWorkflowVersionData,
  Asset,
  CustomizedImportSection,
} from '@ai-marketing/contracts';
import { requestJson } from '../../../../api/http-client';

export const uploadCustomizedMaterial = (
  projectId: string,
  runId: string,
  section: CustomizedImportSection,
  file: File,
  signal?: AbortSignal,
): Promise<ApiResponse<Asset>> => {
  const form = new FormData();
  form.set('file', file);
  form.set('section', section);
  return requestJson(
    `/projects/${encodeURIComponent(projectId)}/workflows/customized/source-import/runs/${encodeURIComponent(runId)}/materials`,
    { method: 'POST', body: form, operation: '上传定制资料', signal },
  );
};

export const initializeCustomizedDraft = (
  projectId: string,
): Promise<ApiResponse<ActivateWorkflowNodeData>> =>
  requestJson(`/projects/${encodeURIComponent(projectId)}/workflow-runs/customized/draft`, {
    method: 'POST',
    operation: '初始化定制资料草稿',
  });

const branchPath = (projectId: string, runId: string) =>
  `/projects/${encodeURIComponent(projectId)}/workflow-runs/customized/branches/${encodeURIComponent(runId)}`;
export const getCustomizedBranchTree = (
  projectId: string,
  signal?: AbortSignal,
): Promise<ApiResponse<CustomizedWorkflowBranchTreeData>> =>
  requestJson(`/projects/${encodeURIComponent(projectId)}/workflow-runs/customized/branches`, {
    signal,
    operation: '加载版本分支树',
  });
export const beginCustomizedEdit = (
  projectId: string,
  runId: string,
): Promise<ApiResponse<ActivateWorkflowNodeData>> =>
  requestJson(`${branchPath(projectId, runId)}/nodes/SOURCE_IMPORT/edit`, {
    method: 'POST',
    operation: '进入资料编辑',
  });
export const cancelCustomizedEdit = (
  projectId: string,
  runId: string,
): Promise<ApiResponse<ActivateWorkflowNodeData>> =>
  requestJson(`${branchPath(projectId, runId)}/nodes/SOURCE_IMPORT/edit/cancel`, {
    method: 'POST',
    operation: '取消资料编辑',
  });
export const saveCustomizedVersion = (
  projectId: string,
  runId: string,
  expectedRevision: number,
): Promise<ApiResponse<CustomizedWorkflowVersionData>> =>
  requestJson(`${branchPath(projectId, runId)}/source-version`, {
    method: 'POST',
    body: { expectedRevision },
    operation: '保存资料版本',
  });
export const activateCustomizedBranch = (
  projectId: string,
  runId: string,
  nodeId: string,
): Promise<ApiResponse<ActivateWorkflowNodeData>> =>
  requestJson(`${branchPath(projectId, runId)}/nodes/${encodeURIComponent(nodeId)}/activate`, {
    method: 'POST',
    operation: '切换版本分支',
  });
