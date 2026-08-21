import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../../database/prisma.service';
import { EffectSourceImportRepository } from './effect-source-import.repository';

describe('EffectSourceImportRepository project isolation', () => {
  it('scopes product lookup by project and draft', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const repository = new EffectSourceImportRepository({
      effectImportProduct: { findFirst },
    } as unknown as PrismaService);

    await repository.product('project-a', 'draft-a', 'product-a');

    expect(findFirst).toHaveBeenCalledWith({
      where: { projectId: 'project-a', draftId: 'draft-a', id: 'product-a' },
      include: { materials: true },
    });
  });

  it('scopes material lookup by project and product', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const repository = new EffectSourceImportRepository({
      effectImportMaterial: { findFirst },
    } as unknown as PrismaService);

    await repository.material('project-b', 'product-b', 'material-b');

    expect(findFirst).toHaveBeenCalledWith({
      where: { projectId: 'project-b', productId: 'product-b', id: 'material-b' },
    });
  });

  it('keeps search, count and category facets inside the same project draft', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const count = vi.fn().mockResolvedValue(0);
    const repository = new EffectSourceImportRepository({
      effectImportProduct: { findMany, count },
    } as unknown as PrismaService);

    await repository.listProducts('project-c', 'draft-c', {
      keyword: 'sku',
      category: '食品',
      skip: 0,
      take: 20,
    });

    expect(findMany).toHaveBeenCalledTimes(2);
    for (const [call] of findMany.mock.calls as Array<[{ where: Record<string, unknown> }]>) {
      expect(call.where).toMatchObject({ projectId: 'project-c', draftId: 'draft-c' });
    }
    expect(count.mock.calls[0]?.[0].where).toMatchObject({
      projectId: 'project-c',
      draftId: 'draft-c',
    });
  });

  it('uses the compound project key for product mutations', async () => {
    const update = vi.fn().mockResolvedValue({ id: 'product-a', materials: [] });
    const transaction = {
      effectImportProduct: { count: vi.fn().mockResolvedValue(1), update },
      effectImportDraft: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    const repository = new EffectSourceImportRepository({
      $transaction: (callback: (client: typeof transaction) => unknown) => callback(transaction),
    } as unknown as PrismaService);

    await repository.updateProduct('project-a', 'draft-a', 'product-a', 3, { name: 'new' });

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { projectId_id: { projectId: 'project-a', id: 'product-a' } },
      }),
    );
  });

  it('does not let cancellation overwrite a committed manifest or fetch files for cleanup', async () => {
    const findUniqueOrThrow = vi.fn();
    const transaction = {
      effectManifestImport: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        findUniqueOrThrow,
      },
    };
    const repository = new EffectSourceImportRepository({
      $transaction: (callback: (client: typeof transaction) => unknown) => callback(transaction),
    } as unknown as PrismaService);

    await expect(
      repository.cancelManifest('project-a', 'draft-a', 'manifest-a'),
    ).resolves.toBeNull();
    expect(transaction.effectManifestImport.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          projectId: 'project-a',
          draftId: 'draft-a',
          id: 'manifest-a',
          status: 'PREVIEW',
        }),
      }),
    );
    expect(findUniqueOrThrow).not.toHaveBeenCalled();
  });

  it('rolls back the manifest claim when the draft revision is stale', async () => {
    const create = vi.fn();
    const transaction = {
      effectManifestImport: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      effectImportDraft: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      effectImportProduct: { create },
    };
    const repository = new EffectSourceImportRepository({
      $transaction: async (callback: (client: typeof transaction) => unknown) =>
        callback(transaction),
    } as unknown as PrismaService);

    await expect(
      repository.commitManifest('project-a', 'draft-a', 'manifest-a', 2, 'commit-key', []),
    ).resolves.toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it('locks and snapshots the validated revision while holding READY file objects', async () => {
    const now = new Date('2026-08-20T00:00:00.000Z');
    const operation = {
      id: 'operation-a',
      projectId: 'project-a',
      draftId: 'draft-a',
      revision: 3,
      idempotencyKey: 'publish-click-a',
      status: 'RUNNING',
      attemptToken: 'attempt-a',
      snapshot: {},
      result: null,
      errorMessage: null,
      completedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    const findUnique = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    const create = vi.fn().mockResolvedValue(operation);
    const createMany = vi.fn().mockResolvedValue({ count: 1 });
    const queryRaw = vi.fn().mockResolvedValue([{ id: 'draft-a' }]);
    const transaction = {
      $queryRaw: queryRaw,
      effectImportPublishOperation: { findUnique, create },
      effectImportDraft: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          id: 'draft-a',
          projectId: 'project-a',
          mode: 'BATCH',
          revision: 3,
          globalConfig: {},
          products: [
            {
              id: 'product-a',
              name: '产品',
              category: '食品',
              sku: 'SKU-1',
              commerceUrl: null,
              configOverride: {},
              materials: [
                {
                  id: 'material-a',
                  type: 'PRODUCT_IMAGE',
                  status: 'READY',
                  originalFileName: 'front.jpg',
                  mimeType: 'image/jpeg',
                  sizeBytes: 3,
                  storageKey: 'held/source',
                },
              ],
            },
          ],
        }),
      },
      effectImportPublishFileHold: { createMany },
    };
    const repository = new EffectSourceImportRepository({
      $transaction: (callback: (client: typeof transaction) => unknown) => callback(transaction),
    } as unknown as PrismaService);

    await expect(
      repository.startPublishOperation('project-a', 'draft-a', 3, 'publish-click-a', 'attempt-a'),
    ).resolves.toMatchObject({ owner: true, requestMatches: true });
    expect(queryRaw).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          projectId: 'project-a',
          idempotencyKey: 'publish-click-a',
          revision: 3,
        }),
      }),
    );
    expect(createMany).toHaveBeenCalledWith({
      data: [{ projectId: 'project-a', operationId: 'operation-a', storageKey: 'held/source' }],
    });
  });
});
