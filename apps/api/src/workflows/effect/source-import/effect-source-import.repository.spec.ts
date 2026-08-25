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
      where: { projectId: 'project-a', draftId: 'draft-a', id: 'product-a', status: 'ACTIVE' },
      include: { materials: { include: { fileObject: true } } },
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
      include: { fileObject: true },
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
        effectImportMaterial: { count: vi.fn().mockResolvedValue(0) },
        workingArtifactFile: { count: vi.fn().mockResolvedValue(0) },
        effectImportUploadItem: { count: vi.fn().mockResolvedValue(0) },
        asset: { count: vi.fn().mockResolvedValue(0) },
        assetVersion: { count: vi.fn().mockResolvedValue(0) },
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
      effectImportDraft: {
        findFirst: vi.fn().mockResolvedValue({ workspace: { workflowRunId: 'workflow-run-a' } }),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
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

  it('creates upload session items explicitly inside the same transaction', async () => {
    const createSession = vi.fn().mockResolvedValue({ id: 'session-a' });
    const createMany = vi.fn().mockResolvedValue({ count: 2 });
    const completedSession = { id: 'session-a', items: [{ id: 'item-a' }, { id: 'item-b' }] };
    const transaction = {
      effectImportProduct: { findFirst: vi.fn().mockResolvedValue({ id: 'product-a' }) },
      effectImportUploadSession: {
        create: createSession,
        findUniqueOrThrow: vi.fn().mockResolvedValue(completedSession),
      },
      effectImportUploadItem: { createMany },
    };
    const repository = new EffectSourceImportRepository(
      {
        $transaction: (callback: (client: typeof transaction) => unknown) => callback(transaction),
      } as unknown as PrismaService,
      {} as never,
    );

    await expect(
      repository.createUploadSession('project-a', 'run-a', 'draft-a', 'product-a', 7, [
        {
          id: 'item-a',
          clientFileId: 'client-a',
          type: 'PRODUCT_IMAGE',
          expectedFileName: null,
          originalFileName: 'a.png',
          mimeType: 'image/png',
          sizeBytes: 100,
        },
        {
          id: 'item-b',
          clientFileId: 'client-b',
          type: 'PRODUCT_DOCUMENT',
          expectedFileName: null,
          originalFileName: 'b.docx',
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          sizeBytes: 200,
        },
      ]),
    ).resolves.toEqual(completedSession);
    expect(createSession).toHaveBeenCalledWith({
      data: expect.objectContaining({
        projectId: 'project-a',
        workflowRunId: 'run-a',
        draftId: 'draft-a',
        productId: 'product-a',
        expectedRevision: 7,
      }),
    });
    expect(createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({ projectId: 'project-a', sessionId: 'session-a', id: 'item-a' }),
        expect.objectContaining({ projectId: 'project-a', sessionId: 'session-a', id: 'item-b' }),
      ]),
    });
  });

  it('creates the FileObject before assigning it to an uploaded session item', async () => {
    const updateItem = vi.fn().mockResolvedValue({ id: 'item-a' });
    const transaction = {
      effectImportUploadItem: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'item-a',
          fileObjectId: null,
          session: { workflowRunId: 'run-a' },
        }),
        update: updateItem,
      },
      fileObject: { update: vi.fn() },
    };
    const upsertFileObjectInTransaction = vi.fn().mockResolvedValue({ id: 'file-a' });
    const repository = new EffectSourceImportRepository(
      {
        $transaction: (callback: (client: typeof transaction) => unknown) => callback(transaction),
      } as unknown as PrismaService,
      { upsertFileObjectInTransaction } as never,
    );

    await expect(
      repository.storeUploadSessionItem('project-a', 'session-a', 'client-a', {
        originalFileName: '商品.png',
        mimeType: 'image/png',
        sizeBytes: 100,
        storageKey: 'projects/project-a/01-working/file.png',
        sha256: 'a'.repeat(64),
        fileObjectId: 'file-a',
      }),
    ).resolves.toEqual({ count: 1 });
    expect(upsertFileObjectInTransaction).toHaveBeenCalledWith(
      transaction,
      'project-a',
      'run-a',
      expect.objectContaining({ id: 'file-a', nodeId: 'SOURCE_IMPORT' }),
    );
    expect(updateItem).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'item-a' },
        data: expect.objectContaining({ fileObjectId: 'file-a', status: 'UPLOADED' }),
      }),
    );
  });

  it('detaches and orphans an uploaded FileObject when a session item is removed', async () => {
    const updateItem = vi.fn().mockResolvedValue({ id: 'item-a' });
    const orphanFile = vi.fn().mockResolvedValue({ id: 'file-a' });
    const transaction = {
      effectImportUploadItem: {
        findFirst: vi.fn().mockResolvedValue({ id: 'item-a', fileObjectId: 'file-a' }),
        update: updateItem,
      },
      fileObject: { update: orphanFile },
    };
    const repository = new EffectSourceImportRepository(
      {
        $transaction: (callback: (client: typeof transaction) => unknown) => callback(transaction),
      } as unknown as PrismaService,
      {} as never,
    );

    await expect(
      repository.removeUploadSessionItem('project-a', 'session-a', 'client-a'),
    ).resolves.toEqual({ count: 1 });
    expect(updateItem).toHaveBeenCalledWith({
      where: { id: 'item-a' },
      data: { status: 'REMOVED', fileObjectId: null },
    });
    expect(orphanFile).toHaveBeenCalledWith({
      where: { id: 'file-a' },
      data: { status: 'ORPHANED', orphanedAt: expect.any(Date) },
    });
  });

  it('commits a ready material and FileObject without a working artifact', async () => {
    const material = { id: 'material-a', storageKey: '01-working/new.png' };
    const transaction = {
      effectImportProduct: {
        findFirst: vi.fn().mockResolvedValue({ workflowRunId: 'run-a' }),
      },
      effectImportDraft: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      effectImportMaterial: { create: vi.fn().mockResolvedValue(material) },
    };
    const upsertFileObjectInTransaction = vi.fn().mockResolvedValue({ id: 'file-a' });
    const repository = new EffectSourceImportRepository(
      {
        $transaction: async (callback: (client: typeof transaction) => unknown) =>
          callback(transaction),
      } as unknown as PrismaService,
      { upsertFileObjectInTransaction } as never,
    );
    const projection = {
      workflowRunId: 'run-a',
      nodeId: 'SOURCE_IMPORT',
      fileObject: {
        id: 'file-a',
        nodeId: 'SOURCE_IMPORT',
        originalFileName: 'image.png',
        mimeType: 'image/png',
        sizeBytes: 100,
        storageKey: '01-working/new.png',
        sha256: 'a'.repeat(64),
      },
    };

    await expect(
      repository.createMaterialWithFileObject(
        'project-a',
        'draft-a',
        'product-a',
        4,
        { id: 'material-a', type: 'PRODUCT_IMAGE', status: 'READY' },
        projection,
      ),
    ).resolves.toEqual(material);
    expect(upsertFileObjectInTransaction).toHaveBeenCalledWith(
      transaction,
      'project-a',
      'run-a',
      projection.fileObject,
    );
  });

  it('completes a ten-file upload batch with one draft bump and no package commit', async () => {
    const items = Array.from({ length: 10 }, (_, index) => ({
      id: `item-${index}`,
      projectId: 'project-a',
      workflowRunId: 'run-a',
      sessionId: 'session-a',
      clientFileId: `client-${index}`,
      type: 'PRODUCT_IMAGE' as const,
      expectedFileName: null,
      status: 'UPLOADED' as const,
      originalFileName: `image-${index}.png`,
      mimeType: 'image/png',
      sizeBytes: 100 + index,
      storageKey: `01-working/image-${index}.png`,
      sha256: String(index).padStart(64, '0'),
      fileObjectId: `file-${index}`,
      errorCode: null,
      errorMessage: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));
    const session = {
      id: 'session-a',
      projectId: 'project-a',
      workflowRunId: 'run-a',
      draftId: 'draft-a',
      productId: 'product-a',
      expectedRevision: 7,
      status: 'UPLOADING' as const,
      completionKey: null,
      expiresAt: new Date(Date.now() + 60_000),
      completedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      items,
    };
    const createMaterial = vi.fn().mockImplementation(({ data }) => ({ id: data.fileObjectId }));
    const updateDraft = vi.fn().mockResolvedValue({ count: 1 });
    const transaction = {
      effectImportUploadSession: {
        findFirst: vi.fn().mockResolvedValue(session),
        update: vi.fn().mockResolvedValue({
          ...session,
          status: 'COMPLETED',
          completionKey: 'complete-a',
          completedAt: new Date(),
        }),
      },
      effectImportDraft: { updateMany: updateDraft },
      effectImportMaterial: { create: createMaterial },
    };
    const upsertFileObjectInTransaction = vi.fn().mockResolvedValue({});
    const upsertArtifactInTransaction = vi.fn().mockResolvedValue({ record: { id: 'package-a' } });
    const repository = new EffectSourceImportRepository(
      {
        $transaction: (callback: (client: typeof transaction) => unknown) => callback(transaction),
      } as unknown as PrismaService,
      { upsertFileObjectInTransaction, upsertArtifactInTransaction } as never,
    );
    await expect(
      repository.completeUploadSession('project-a', 'session-a', 'complete-a'),
    ).resolves.toMatchObject({ revision: 8, unchanged: false });
    expect(updateDraft).toHaveBeenCalledTimes(1);
    expect(createMaterial).toHaveBeenCalledTimes(10);
    expect(upsertFileObjectInTransaction).not.toHaveBeenCalled();
    expect(upsertArtifactInTransaction).not.toHaveBeenCalled();
  });
});
