import type { ApiResponse, CreateProjectRequest, Project } from '@ai-marketing/contracts';

import { requestJson } from '../../../api/http-client';

export const createProject = (input: CreateProjectRequest): Promise<ApiResponse<Project>> =>
  requestJson<ApiResponse<Project>>('/projects', {
    method: 'POST',
    body: input,
    operation: '创建项目',
  });
