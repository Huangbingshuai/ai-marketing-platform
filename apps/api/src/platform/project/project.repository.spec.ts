import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../database/prisma.service';
import { ProjectRepository } from './project.repository';

describe('ProjectRepository', () => {
  it('combines keyword and workflow-space search without losing either condition', async () => {
    const project = { findMany: vi.fn().mockResolvedValue([]) };
    const repository = new ProjectRepository({ project } as unknown as PrismaService);

    await repository.list({ keyword: '椒香', workflow: 'FISSION', space: 'FISSION_CLONE' });

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

function fixture() {
  const project = {
    id: 'project-a',
    name: 'Tea Launch',
    client: 'Brand',
    productName: 'Green Tea',
  };
  const jobs = [
    { projectSnapshot: null, status: 'QUEUED', lastError: null },
    {
      projectSnapshot: { project, spaces: ['CUSTOMIZED_PROJECT', 'FISSION_CLONE'] },
      status: 'QUEUED',
      lastError: null,
    },
    {
      projectSnapshot: { project: { ...project, id: 'project-b' }, spaces: ['EFFECT'] },
      status: 'RUNNING',
      lastError: '正在重试',
    },
  ];
  const findMany = vi.fn().mockResolvedValue(jobs);
  const count = vi.fn().mockResolvedValue(0);
  const repository = new ProjectRepository({
    projectDeletionCleanup: { findMany },
    project: { count },
  } as unknown as PrismaService);
  return { repository, findMany, count };
}

describe('project deletion list projection', () => {
  it('restores cleanup rows after project deletion and ignores legacy jobs without snapshots', async () => {
    const { repository, findMany } = fixture();
    const result = await repository.listDeletingFiles({});
    expect(result.map((item) => item.id)).toEqual(['project-a', 'project-b']);
    expect(result[1]?.deletion).toEqual({ status: 'RUNNING', phase: 'FILES', message: '正在重试' });
    expect(findMany.mock.calls[0]?.[0].where).toEqual({ phase: 'FILES' });
  });
  it('isolates cleanup snapshots by the selected workflow and exact business space', async () => {
    const { repository } = fixture();
    expect(
      (
        await repository.listDeletingFiles({ workflow: 'CUSTOMIZED', space: 'CUSTOMIZED_PROJECT' })
      ).map((item) => item.id),
    ).toEqual(['project-a']);
    expect(
      (await repository.listDeletingFiles({ workflow: 'FISSION', space: 'FISSION_CLONE' })).map(
        (item) => item.id,
      ),
    ).toEqual(['project-a']);
    expect(
      await repository.listDeletingFiles({ workflow: 'FISSION', space: 'FISSION_AVATAR' }),
    ).toEqual([]);
    expect(
      await repository.listDeletingFiles({ workflow: 'EFFECT', space: 'CUSTOMIZED_PROJECT' }),
    ).toEqual([]);
  });
  it('retains the normal case-insensitive name, client and product search behavior', async () => {
    const { repository } = fixture();
    for (const keyword of ['  tea LAUNCH ', 'brand', 'GREEN'])
      expect(await repository.listDeletingFiles({ workflow: 'CUSTOMIZED', keyword })).toHaveLength(
        1,
      );
    expect(await repository.listDeletingFiles({ keyword: 'absent' })).toEqual([]);
  });
  it('does not restore a frozen project as writable', async () => {
    const { repository, count } = fixture();
    await expect(repository.exists('project-a')).resolves.toBe(false);
    expect(count).toHaveBeenCalledWith({ where: { id: 'project-a', deletionState: null } });
  });
});
