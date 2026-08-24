import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../database/prisma.service';
import { AssetRepository } from './asset.repository';

describe('AssetRepository project isolation', () => {
  it('includes projectId and active scope in list, facets, detail, update and archive', async () => {
    const asset = {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    };
    const repository = new AssetRepository({ asset } as unknown as PrismaService);

    await repository.list('project-a', {
      keyword: '片',
      tag: '夏季',
      productId: '11111111-1111-4111-8111-111111111111',
    });
    await repository.listForFacets('project-a', {
      workflow: 'CUSTOMIZED',
      space: 'CUSTOMIZED_PROJECT',
    });
    await repository.find('project-a', 'asset-a');
    await repository.update('project-a', 'asset-a', {
      name: '名称',
      directory: 'SOURCE_MATERIALS',
      type: 'SOURCE_MATERIAL',
      tags: [],
      notes: null,
    });
    await repository.archive('project-a', 'asset-a');

    expect(asset.findMany.mock.calls[0]?.[0].where).toMatchObject({
      projectId: 'project-a',
      archivedAt: null,
      tags: { has: '夏季' },
      businessData: {
        path: ['productId'],
        equals: '11111111-1111-4111-8111-111111111111',
      },
    });
    expect(asset.findMany.mock.calls[0]?.[0].where.OR).toContainEqual({ tags: { has: '片' } });
    expect(asset.findMany.mock.calls[1]?.[0].where).toEqual({
      projectId: 'project-a',
      archivedAt: null,
      storageWorkflow: 'CUSTOMIZED',
      workflowSpace: 'CUSTOMIZED_PROJECT',
    });
    expect(asset.findMany.mock.calls[1]?.[0].select).toEqual({
      directory: true,
      type: true,
      status: true,
      tags: true,
      businessData: true,
    });
    expect(asset.findFirst).toHaveBeenCalledWith({
      where: { projectId: 'project-a', archivedAt: null, id: 'asset-a' },
    });
    expect(asset.updateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: { projectId: 'project-a', archivedAt: null, id: 'asset-a' },
      }),
    );
    expect(asset.updateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: { projectId: 'project-a', archivedAt: null, id: 'asset-a' },
      }),
    );
  });

  it('scopes versions, idempotency lookup and batch archive by projectId', async () => {
    const asset = {
      findMany: vi.fn().mockResolvedValue([{ id: 'asset-a' }]),
      findFirst: vi.fn().mockResolvedValue(null),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    };
    const assetVersion = {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
    };
    const repository = new AssetRepository({ asset, assetVersion } as unknown as PrismaService);

    await repository.findByIdempotency('project-a', 'EFFECT', 'EFFECT', 'upload-key');
    await repository.listVersions('project-a', 'asset-a');
    await repository.findVersion('project-a', 'asset-a', 2);
    await expect(repository.archiveMany('project-a', ['asset-a', 'asset-from-b'])).resolves.toEqual(
      ['asset-a'],
    );

    expect(asset.findFirst).toHaveBeenCalledWith({
      where: {
        projectId: 'project-a',
        archivedAt: null,
        storageWorkflow: 'EFFECT',
        workflowSpace: 'EFFECT',
        idempotencyKey: 'upload-key',
      },
    });
    expect(assetVersion.findMany).toHaveBeenCalledWith({
      where: { projectId: 'project-a', assetId: 'asset-a', asset: { archivedAt: null } },
      orderBy: { version: 'desc' },
    });
    expect(assetVersion.findFirst).toHaveBeenCalledWith({
      where: {
        projectId: 'project-a',
        assetId: 'asset-a',
        version: 2,
        asset: { archivedAt: null },
      },
    });
    expect(asset.findMany).toHaveBeenCalledWith({
      where: { projectId: 'project-a', archivedAt: null, id: { in: ['asset-a', 'asset-from-b'] } },
      select: { id: true },
    });
    expect(asset.updateMany).toHaveBeenCalledWith({
      where: { projectId: 'project-a', archivedAt: null, id: { in: ['asset-a'] } },
      data: { archivedAt: expect.any(Date) },
    });
  });
});
