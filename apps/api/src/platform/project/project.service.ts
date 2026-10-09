import type {
  AssetWorkflow,
  AssetWorkflowSpace,
  CreateProjectRequest,
  Project,
  ProjectListQuery,
} from '@ai-marketing/contracts';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';

import { ProjectRepository } from './project.repository';
import { presentProject } from './project-presenter';
import { ApiHttpException } from '../../common/api-http-exception';

const workflowForSpace = (space: AssetWorkflowSpace): AssetWorkflow =>
  space === 'EFFECT' ? 'EFFECT' : space.startsWith('CUSTOMIZED_') ? 'CUSTOMIZED' : 'FISSION';

const normalizeDescription = (description: string | null | undefined): string | null => {
  if (description === null || description === undefined) return null;
  const normalized = description.trim();
  return normalized === '' ? null : normalized;
};

@Injectable()
export class ProjectService {
  constructor(@Inject(ProjectRepository) private readonly repository: ProjectRepository) {}

  async create(input: CreateProjectRequest): Promise<Project> {
    if (input.workflow && input.space && workflowForSpace(input.space) !== input.workflow) {
      throw new ApiHttpException(
        '项目工作流与空间不匹配',
        HttpStatus.BAD_REQUEST,
        'VALIDATION_ERROR',
      );
    }
    const defaultWorkflow = input.workflow ?? (input.space ? workflowForSpace(input.space) : null);
    const project = await this.repository.create({
      name: input.name.trim(),
      description: normalizeDescription(input.description),
      status: 'ACTIVE',
      client: normalizeDescription(input.client),
      productName: normalizeDescription(input.productName),
      iconKey: normalizeDescription(input.iconKey),
      defaultWorkflow,
      defaultSpace: input.space ?? null,
    });
    return presentProject(project);
  }

  async list(query: ProjectListQuery = {}): Promise<Project[]> {
    const projects = await this.repository.list(query);
    const deletingFiles = await this.repository.listDeletingFiles(query);
    return [
      ...new Map(
        [...projects.map(presentProject), ...deletingFiles].map((project) => [project.id, project]),
      ).values(),
    ];
  }

  async get(projectId: string): Promise<Project> {
    const project = await this.repository.find(projectId);
    if (!project) {
      throw new ApiHttpException('项目不存在', HttpStatus.NOT_FOUND, 'PROJECT_NOT_FOUND');
    }
    if (project.deletionState) {
      throw new ApiHttpException(
        '项目正在删除或等待重试，暂时不能进入。',
        HttpStatus.CONFLICT,
        'PROJECT_DELETING',
      );
    }
    return presentProject(project);
  }

  exists(projectId: string): Promise<boolean> {
    return this.repository.exists(projectId);
  }
}
