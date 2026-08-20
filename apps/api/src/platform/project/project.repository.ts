import type { ProjectStatus } from '@ai-marketing/contracts';
import { Inject, Injectable } from '@nestjs/common';
import type { Project as ProjectRecord } from '../../generated/prisma/client';

import { PrismaService } from '../../database/prisma.service';

type CreateProjectData = {
  name: string;
  description: string | null;
  status: ProjectStatus;
};

@Injectable()
export class ProjectRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  create(data: CreateProjectData): Promise<ProjectRecord> {
    return this.prisma.project.create({ data });
  }
}
