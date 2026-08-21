import type {
  AssetWorkflow,
  AssetWorkflowSpace,
  CreateProjectRequest,
  Project,
  ProjectListQuery,
  ProjectWorkflowSpaces,
} from '@ai-marketing/contracts';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { Project as ProjectRecord } from '../../generated/prisma/client';

import { ProjectRepository } from './project.repository';
import type { ProjectWithAssets } from './project.repository';
import { ApiHttpException } from '../../common/api-http-exception';

const emptySpaces = (): ProjectWorkflowSpaces => ({
  effect: false,
  customized: false,
  fission: { clone: false, avatar: false, localReplace: false },
});
const applySpace = (
  spaces: ProjectWorkflowSpaces,
  space: AssetWorkflowSpace | null | undefined,
): void => {
  if (space === 'EFFECT') spaces.effect = true;
  else if (space === 'CUSTOMIZED_PROJECT' || space === 'CUSTOMIZED_VOICE_LIBRARY')
    spaces.customized = true;
  else if (space === 'FISSION_CLONE') spaces.fission.clone = true;
  else if (space === 'FISSION_AVATAR') spaces.fission.avatar = true;
  else if (space === 'FISSION_LOCAL_REPLACE') spaces.fission.localReplace = true;
};
const toProject = (project: ProjectRecord | ProjectWithAssets): Project => {
  const spaces = emptySpaces();
  if ('defaultSpace' in project) applySpace(spaces, project.defaultSpace);
  if ('assets' in project)
    for (const asset of project.assets) applySpace(spaces, asset.workflowSpace);
  const assetCounts =
    'assets' in project
      ? project.assets.reduce<Partial<Record<AssetWorkflowSpace, number>>>(
          (counts, asset) => ({
            ...counts,
            [asset.workflowSpace]: (counts[asset.workflowSpace] ?? 0) + 1,
          }),
          {},
        )
      : undefined;
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    status: project.status,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
    client: 'client' in project ? project.client : null,
    productName: 'productName' in project ? project.productName : null,
    iconKey: 'iconKey' in project ? project.iconKey : null,
    workflowSpaces: spaces,
    ...(assetCounts ? { assetCounts } : {}),
  };
};

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
    return toProject(project);
  }

  async list(query: ProjectListQuery = {}): Promise<Project[]> {
    const projects = await this.repository.list(query);
    return projects.map(toProject);
  }

  async get(projectId: string): Promise<Project> {
    const project = await this.repository.find(projectId);
    if (!project) {
      throw new ApiHttpException('项目不存在', HttpStatus.NOT_FOUND, 'PROJECT_NOT_FOUND');
    }
    return toProject(project);
  }

  exists(projectId: string): Promise<boolean> {
    return this.repository.exists(projectId);
  }
}
