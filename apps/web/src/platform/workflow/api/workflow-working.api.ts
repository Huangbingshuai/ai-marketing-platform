import type {
  ApiResponse,
  PutWorkflowNodeStateData,
  PutWorkflowNodeStateRequest,
  WorkingArtifactListData,
  WorkingArtifactListQuery,
  WorkflowNodeState,
  WorkflowRunOverviewData,
} from '@ai-marketing/contracts';
import { requestJson } from '../../../api/http-client';

const projectPath = (projectId: string): string => `/projects/${encodeURIComponent(projectId)}`;

export const getActiveWorkflowRunOverview = (
  projectId: string,
  workflow: WorkingArtifactListQuery['workflow'],
  space: WorkingArtifactListQuery['space'],
  signal?: AbortSignal,
): Promise<ApiResponse<WorkflowRunOverviewData>> => {
  const search = new URLSearchParams({ workflow: workflow!, space: space! });
  return requestJson(`${projectPath(projectId)}/workflow-runs/active/overview?${search}`, {
    operation: '加载项目工作流草稿',
    signal,
  });
};

export const getWorkflowNodeState = (
  projectId: string,
  workflowRunId: string,
  nodeId: string,
  signal?: AbortSignal,
): Promise<ApiResponse<WorkflowNodeState>> =>
  requestJson(
    `${projectPath(projectId)}/workflow-runs/${encodeURIComponent(workflowRunId)}/nodes/${encodeURIComponent(nodeId)}/state`,
    { operation: '加载节点草稿', signal },
  );

export const putWorkflowNodeState = (
  projectId: string,
  workflowRunId: string,
  nodeId: string,
  input: PutWorkflowNodeStateRequest,
  options: { keepalive?: boolean; signal?: AbortSignal } = {},
): Promise<ApiResponse<PutWorkflowNodeStateData>> =>
  requestJson(
    `${projectPath(projectId)}/workflow-runs/${encodeURIComponent(workflowRunId)}/nodes/${encodeURIComponent(nodeId)}/state`,
    {
      method: 'PUT',
      body: input,
      operation: '自动保存节点草稿',
      ...options,
    },
  );

export const pauseWorkflowRun = (
  projectId: string,
  workflowRunId: string,
): Promise<ApiResponse<{ paused: true }>> =>
  requestJson(
    `${projectPath(projectId)}/workflow-runs/${encodeURIComponent(workflowRunId)}/pause`,
    { method: 'POST', operation: '暂停工作流' },
  );

export const listWorkingArtifacts = (
  projectId: string,
  query: WorkingArtifactListQuery = {},
  signal?: AbortSignal,
): Promise<ApiResponse<WorkingArtifactListData>> => {
  const search = new URLSearchParams();
  if (query.workflowRunId) search.set('workflowRunId', query.workflowRunId);
  if (query.nodeId) search.set('nodeId', query.nodeId);
  if (query.workflow) search.set('workflow', query.workflow);
  if (query.space) search.set('space', query.space);
  const suffix = search.size ? `?${search.toString()}` : '';
  return requestJson(`${projectPath(projectId)}/working-artifacts${suffix}`, {
    operation: '加载当前项目工作副本',
    signal,
  });
};
