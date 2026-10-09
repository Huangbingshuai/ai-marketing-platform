import type {
  AssetWorkflow,
  AssetWorkflowSpace,
  ProjectListQuery,
  ProjectStatus,
  Project,
} from '@ai-marketing/contracts';
import { Inject, Injectable } from '@nestjs/common';
import type { Prisma, Project as ProjectRecord } from '../../generated/prisma/client';

import { PrismaService } from '../../database/prisma.service';

type CreateProjectData = {
  name: string;
  description: string | null;
  status: ProjectStatus;
  client?: string | null;
  productName?: string | null;
  iconKey?: string | null;
  defaultWorkflow?: AssetWorkflow | null;
  defaultSpace?: AssetWorkflowSpace | null;
};

export type ProjectWithAssets = Prisma.ProjectGetPayload<{
  include: { assets: { select: { storageWorkflow: true; workflowSpace: true } } };
}>;

@Injectable()
export class ProjectRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  create(data: CreateProjectData): Promise<ProjectRecord> {
    return this.prisma.project.create({ data });
  }

  list(query: ProjectListQuery = {}): Promise<ProjectWithAssets[]> {
    const keyword = query.keyword?.trim();
    const assetWhere: Prisma.AssetWhereInput = {
      archivedAt: null,
      ...(query.workflow ? { storageWorkflow: query.workflow } : {}),
      ...(query.space ? { workflowSpace: query.space } : {}),
    };
    const where: Prisma.ProjectWhereInput = {
      AND: [
        ...(keyword
          ? [
              {
                OR: [
                  { name: { contains: keyword, mode: 'insensitive' as const } },
                  { client: { contains: keyword, mode: 'insensitive' as const } },
                  { productName: { contains: keyword, mode: 'insensitive' as const } },
                ],
              },
            ]
          : []),
        ...(query.workflow || query.space
          ? [
              {
                OR: [
                  {
                    ...(query.workflow ? { defaultWorkflow: query.workflow } : {}),
                    ...(query.space ? { defaultSpace: query.space } : {}),
                  },
                  { assets: { some: assetWhere } },
                ],
              },
            ]
          : []),
      ],
    };
    return this.prisma.project.findMany({
      where,
      include: {
        assets: {
          where: { archivedAt: null },
          select: { storageWorkflow: true, workflowSpace: true },
        },
      },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
    });
  }

  find(projectId: string): Promise<ProjectWithAssets | null> {
    return this.prisma.project.findUnique({
      where: { id: projectId },
      include: {
        assets: {
          where: { archivedAt: null },
          select: { storageWorkflow: true, workflowSpace: true },
        },
      },
    });
  }

  async exists(id: string): Promise<boolean> {
    return (await this.prisma.project.count({ where: { id, deletionState: null } })) > 0;
  }

  async listDeletingFiles(query: ProjectListQuery): Promise<Project[]> {
    const jobs = await this.prisma.projectDeletionCleanup.findMany({
      where: { phase: 'FILES' },
      select: { projectSnapshot: true, status: true, lastError: true },
    });
    const keyword = query.keyword?.trim().toLowerCase();
    return jobs.flatMap((job) => {
      if (!job.projectSnapshot) return [];
      const snapshot = job.projectSnapshot as unknown as {
        project: Project;
        spaces: AssetWorkflowSpace[];
      };
      const project = snapshot.project;
      if (query.space && !snapshot.spaces.includes(query.space)) return [];
      if (
        query.workflow &&
        !snapshot.spaces.some((space) =>
          query.workflow === 'EFFECT'
            ? space === 'EFFECT'
            : query.workflow === 'CUSTOMIZED'
              ? space.startsWith('CUSTOMIZED_')
              : space.startsWith('FISSION_'),
        )
      )
        return [];
      if (
        keyword &&
        ![project.name, project.client, project.productName].some((value) =>
          value?.toLowerCase().includes(keyword),
        )
      )
        return [];
      return [
        {
          ...project,
          deletion: {
            status: job.status as 'QUEUED' | 'RUNNING' | 'FAILED',
            phase: 'FILES' as const,
            ...(job.lastError ? { message: job.lastError } : {}),
          },
        },
      ];
    });
  }
}
