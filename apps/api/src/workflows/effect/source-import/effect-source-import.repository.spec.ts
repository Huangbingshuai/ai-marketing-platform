import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../../database/prisma.service';
import { EffectSourceImportRepository } from './effect-source-import.repository';

describe('EffectSourceImportRepository project isolation', () => {
  it('scopes product lookup by project and draft', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const repository = new EffectSourceImportRepository(
      {
        effectImportProduct: { findFirst },
      } as unknown as PrismaService,
      {} as never,
    );

    await repository.product('project-a', 'draft-a', 'product-a');

    expect(findFirst).toHaveBeenCalledWith({
      where: { projectId: 'project-a', draftId: 'draft-a', id: 'product-a' },
      include: { materials: true },
    });
  });

  it('scopes material lookup by project and product', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const repository = new EffectSourceImportRepository(
      {
        effectImportMaterial: { findFirst },
      } as unknown as PrismaService,
      {} as never,
    );

    await repository.material('project-b', 'product-b', 'material-b');

    expect(findFirst).toHaveBeenCalledWith({
      where: { projectId: 'project-b', productId: 'product-b', id: 'material-b' },
    });
  });

  it('keeps search, count and category facets inside the same project draft', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const count = vi.fn().mockResolvedValue(0);
    const repository = new EffectSourceImportRepository(
      {
        effectImportProduct: { findMany, count },
      } as unknown as PrismaService,
      {} as never,
    );

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

  it('protects objects held by extraction runs', async () => {
    const extractionCount = vi.fn().mockResolvedValue(1);
    const repository = new EffectSourceImportRepository(
      {
        effectExtractionFileHold: { count: extractionCount },
      } as unknown as PrismaService,
      {} as never,
    );

    await expect(repository.isStorageHeld('project-a', 'source/object')).resolves.toBe(true);
    expect(extractionCount).toHaveBeenCalledWith({
      where: { projectId: 'project-a', storageKey: 'source/object' },
    });
  });

  it('uses the compound project key for product mutations', async () => {
    const update = vi.fn().mockResolvedValue({ id: 'product-a', materials: [] });
    const transaction = {
      effectImportProduct: { count: vi.fn().mockResolvedValue(1), update },
      effectImportDraft: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    const repository = new EffectSourceImportRepository(
      {
        $transaction: (callback: (client: typeof transaction) => unknown) => callback(transaction),
      } as unknown as PrismaService,
      {} as never,
    );

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
    const repository = new EffectSourceImportRepository(
      {
        $transaction: (callback: (client: typeof transaction) => unknown) => callback(transaction),
      } as unknown as PrismaService,
      {} as never,
    );

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
    const repository = new EffectSourceImportRepository(
      {
        $transaction: async (callback: (client: typeof transaction) => unknown) =>
          callback(transaction),
      } as unknown as PrismaService,
      {} as never,
    );

    await expect(
      repository.commitManifest('project-a', 'draft-a', 'manifest-a', 2, 'commit-key', []),
    ).resolves.toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it('commits a ready material and its working artifact in the same transaction', async () => {
    const material = { id: 'material-a', storageKey: '01-working/new.png' };
    const transaction = {
      effectImportProduct: { count: vi.fn().mockResolvedValue(1) },
      effectImportDraft: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      effectImportMaterial: { create: vi.fn().mockResolvedValue(material) },
    };
    const upsertArtifactInTransaction = vi.fn().mockResolvedValue({
      record: { id: 'working-a' },
      previousStorageKey: null,
    });
    const repository = new EffectSourceImportRepository(
      {
        $transaction: async (callback: (client: typeof transaction) => unknown) =>
          callback(transaction),
      } as unknown as PrismaService,
      { upsertArtifactInTransaction } as never,
    );
    const projection = {
      workflowRunId: 'run-a',
      nodeId: 'SOURCE_IMPORT',
      artifactKey: 'material:material-a',
      input: {
        kind: 'FILE' as const,
        name: '产品 A · image.png',
        directory: 'SOURCE_MATERIALS' as const,
        type: 'SOURCE_MATERIAL' as const,
        storageKey: '01-working/new.png',
      },
    };

    await expect(
      repository.createMaterialWithArtifact(
        'project-a',
        'draft-a',
        'product-a',
        4,
        { id: 'material-a', type: 'PRODUCT_IMAGE', status: 'READY' },
        projection,
      ),
    ).resolves.toEqual({ material, previousArtifactStorageKey: null });
    expect(upsertArtifactInTransaction).toHaveBeenCalledWith(
      transaction,
      'project-a',
      'run-a',
      'SOURCE_IMPORT',
      'material:material-a',
      projection.input,
    );
  });
});
