import type { CreateProjectRequest, Project } from '@ai-marketing/contracts';
import { Inject, Injectable } from '@nestjs/common';
import type { Project as ProjectRecord } from '../../generated/prisma/client';

import { ProjectRepository } from './project.repository';

const toProject = (project: ProjectRecord): Project => ({
  id: project.id,
  name: project.name,
  description: project.description,
  status: project.status,
  createdAt: project.createdAt.toISOString(),
  updatedAt: project.updatedAt.toISOString(),
});

const normalizeDescription = (description: string | null | undefined): string | null => {
  if (description === null || description === undefined) return null;
  const normalized = description.trim();
  return normalized === '' ? null : normalized;
};

@Injectable()
export class ProjectService {
  constructor(@Inject(ProjectRepository) private readonly repository: ProjectRepository) {}

  async create(input: CreateProjectRequest): Promise<Project> {
    const project = await this.repository.create({
      name: input.name.trim(),
      description: normalizeDescription(input.description),
      status: 'ACTIVE',
    });
    return toProject(project);
  }
}
