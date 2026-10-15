import type {
  ApiResponse,
  CreateProjectRequest,
  DeleteProjectResult,
  DeleteProjectRequest,
  Project,
  ProjectListQuery,
} from '@ai-marketing/contracts';

import { requestJson } from '../../../api/http-client';

export const listProjects = (
  query: ProjectListQuery = {},
  signal?: AbortSignal,
): Promise<ApiResponse<Project[]>> => {
  const search = new URLSearchParams();
  if (query.keyword) search.set('keyword', query.keyword);
  if (query.workflow) search.set('workflow', query.workflow);
  if (query.space) search.set('space', query.space);
  const suffix = search.size ? `?${search.toString()}` : '';
  return requestJson<ApiResponse<Project[]>>(`/projects${suffix}`, {
    operation: '加载项目列表',
    signal,
  });
};

export const createProject = (input: CreateProjectRequest): Promise<ApiResponse<Project>> =>
  requestJson<ApiResponse<Project>>('/projects', {
    method: 'POST',
    body: input,
    operation: '创建项目',
  });

export const deleteProject = (
  projectId: string,
  context: DeleteProjectRequest = {},
): Promise<ApiResponse<DeleteProjectResult>> =>
  requestJson<ApiResponse<DeleteProjectResult>>(`/projects/${encodeURIComponent(projectId)}`, {
    method: 'DELETE',
    body: context,
    operation: '删除项目',
  });
