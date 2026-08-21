import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../database/prisma.service';
import { ProjectRepository } from './project.repository';

describe('ProjectRepository', () => {
  it('combines keyword and workflow-space search without losing either condition', async () => {
    const project = { findMany: vi.fn().mockResolvedValue([]) };
    const repository = new ProjectRepository({ project } as unknown as PrismaService);

    await repository.list({
      keyword: '椒香',
      workflow: 'FISSION',
      space: 'FISSION_CLONE',
    });

    expect(project.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          AND: [
            {
              OR: [
                { name: { contains: '椒香', mode: 'insensitive' } },
                { client: { contains: '椒香', mode: 'insensitive' } },
                { productName: { contains: '椒香', mode: 'insensitive' } },
              ],
            },
            {
              OR: [
                { defaultWorkflow: 'FISSION', defaultSpace: 'FISSION_CLONE' },
                {
                  assets: {
                    some: {
                      archivedAt: null,
                      storageWorkflow: 'FISSION',
                      workflowSpace: 'FISSION_CLONE',
                    },
                  },
                },
              ],
            },
          ],
        },
        include: {
          assets: {
            where: { archivedAt: null },
            select: { storageWorkflow: true, workflowSpace: true },
          },
        },
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      }),
    );
  });

  it('loads project detail by its id and counts only active assets', async () => {
    const project = { findUnique: vi.fn().mockResolvedValue(null) };
    const repository = new ProjectRepository({ project } as unknown as PrismaService);

    await repository.find('project-a');

    expect(project.findUnique).toHaveBeenCalledWith({
      where: { id: 'project-a' },
      include: {
        assets: {
          where: { archivedAt: null },
          select: { storageWorkflow: true, workflowSpace: true },
        },
      },
    });
  });
});
