import {
  DEFAULT_EFFECT_VIDEO_CONFIG,
  type EffectImportDraft,
  type PublishEffectImportDraftData,
} from '@ai-marketing/contracts';
import { describe, expect, it, vi } from 'vitest';

import type { AssetService } from '../../../platform/asset/asset.service';
import type { StoragePort } from '../../../platform/file/storage.port';
import type { ProjectService } from '../../../platform/project/project.service';
import type { EffectSourceImportRepository } from './effect-source-import.repository';
import {
  EFFECT_MANIFEST_UPLOAD_TOTAL_BYTES,
  EffectSourceImportService,
} from './effect-source-import.service';

const serviceWith = (
  repository: Partial<EffectSourceImportRepository> = {},
  storage: Partial<StoragePort> = {},
  assetService: Partial<AssetService> = {},
) =>
  new EffectSourceImportService(
    {
      expireManifestPreviews: vi.fn().mockResolvedValue([]),
      storageCleanupTasks: vi.fn().mockResolvedValue([]),
      isStorageHeld: vi.fn().mockResolvedValue(false),
      enqueueStorageCleanup: vi.fn().mockResolvedValue(undefined),
      deleteStorageCleanup: vi.fn().mockResolvedValue(undefined),
      failStorageCleanup: vi.fn().mockResolvedValue(undefined),
      releaseExpiredPublishHolds: vi.fn().mockResolvedValue({ count: 0 }),
      ...repository,
    } as EffectSourceImportRepository,
    { exists: vi.fn().mockResolvedValue(true) } as unknown as ProjectService,
    assetService as AssetService,
    storage as StoragePort,
  );

const draftValue = (overrides: Partial<EffectImportDraft> = {}): EffectImportDraft => ({
  id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  projectId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  mode: 'BATCH',
  status: 'VALID',
  revision: 3,
  validatedRevision: 3,
  productCount: 0,
  issueCount: 0,
  completedAt: null,
  lastPublish: null,
  createdAt: '2026-08-20T00:00:00.000Z',
  updatedAt: '2026-08-20T00:00:00.000Z',
  globalConfig: DEFAULT_EFFECT_VIDEO_CONFIG,
  validationIssues: [],
  products: [],
  ...overrides,
});

const publishableDraft = (): EffectImportDraft =>
  draftValue({
    productCount: 1,
    products: [
      {
        id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        projectId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        draftId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        name: '产品',
        category: '食品',
        sku: 'SKU-1',
        normalizedSku: 'SKU-1',
        commerceUrl: null,
        configOverride: {},
        effectiveConfig: DEFAULT_EFFECT_VIDEO_CONFIG,
        sortOrder: 0,
        sourceManifestImportId: null,
        sourceManifestRowNumber: null,
        materials: [
          {
            id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
            projectId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            productId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
            type: 'PRODUCT_IMAGE',
            status: 'READY',
            expectedFileName: null,
            originalFileName: 'front.jpg',
            mimeType: 'image/jpeg',
            sizeBytes: 3,
            contentUrl: '/content',
            failureDisposition: null,
            errorCode: null,
            errorMessage: null,
            retryCount: 0,
            createdAt: '2026-08-20T00:00:00.000Z',
            updatedAt: '2026-08-20T00:00:00.000Z',
          },
        ],
        createdAt: '2026-08-20T00:00:00.000Z',
        updatedAt: '2026-08-20T00:00:00.000Z',
      },
    ],
  });

describe('EffectSourceImportService', () => {
  it('allows one maximum reference video plus one maximum manifest in the aggregate budget', () => {
    expect(EFFECT_MANIFEST_UPLOAD_TOTAL_BYTES).toBe(522 * 1024 * 1024);
  });
  it('accepts only absolute HTTP(S) commerce links without credentials', () => {
    const service = serviceWith();
    expect(service.validateLink(' https://shop.example.com/item/1#details ')).toMatchObject({
      valid: true,
      normalizedUrl: 'https://shop.example.com/item/1',
    });
    expect(service.validateLink('javascript:alert(1)').valid).toBe(false);
    expect(service.validateLink('https://user:secret@example.com/item').valid).toBe(false);
    expect(service.validateLink('/relative/item').valid).toBe(false);
  });

  it('returns an atomically initialized workspace containing both draft modes', async () => {
    const now = new Date('2026-08-20T00:00:00.000Z');
    const draft = (mode: 'SINGLE' | 'BATCH') => ({
      id: `${mode === 'SINGLE' ? '11111111' : '22222222'}-1111-4111-8111-111111111111`,
      projectId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      workspaceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      mode,
      status: 'DRAFT' as const,
      globalConfig: DEFAULT_EFFECT_VIDEO_CONFIG,
      revision: 1,
      validatedRevision: null,
      validationIssues: [],
      validatedAt: null,
      completedAt: null,
      lastPublish: null,
      createdAt: now,
      updatedAt: now,
      _count: { products: 0 },
    });
    const initialize = vi.fn().mockResolvedValue({
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      projectId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      currentMode: 'SINGLE',
      revision: 1,
      createdAt: now,
      updatedAt: now,
      drafts: [draft('SINGLE'), draft('BATCH')],
    });
    const service = serviceWith({ initialize } as Partial<EffectSourceImportRepository>);

    const result = await service.getWorkspace('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');

    expect(Object.keys(result.workspace.drafts).sort()).toEqual(['BATCH', 'SINGLE']);
    expect(result.workspace.nodeStatuses).toEqual({
      SOURCE_IMPORT: 'CURRENT',
      AI_INFO_EXTRACTION: 'LOCKED',
    });
    expect(initialize).toHaveBeenCalledWith(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      DEFAULT_EFFECT_VIDEO_CONFIG,
    );
  });

  it('validates a link only after the product is found in the scoped project draft', async () => {
    const product = vi.fn().mockResolvedValue(null);
    const service = serviceWith({ product });
    vi.spyOn(service, 'getDraft').mockResolvedValue(draftValue());

    await expect(
      service.validateLinkScoped(
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        'BATCH',
        'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        'https://example.com',
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(product).toHaveBeenCalledWith(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    );
  });

  it('reprocesses retained failed content before marking it ready', async () => {
    const retryMaterials = vi.fn().mockResolvedValue([
      {
        id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        projectId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        productId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        status: 'FAILED',
        failureDisposition: 'RETRYABLE',
        storageKey: 'retained/object',
      },
    ]);
    const finishMaterialRetry = vi.fn().mockResolvedValue({ count: 1 });
    const stream = { destroy: vi.fn() };
    const service = serviceWith(
      { retryMaterials, finishMaterialRetry },
      { open: vi.fn().mockResolvedValue({ stream }) },
    );
    vi.spyOn(service, 'getDraft').mockResolvedValue(draftValue());

    const result = await service.batchRetry(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'BATCH',
      ['cccccccc-cccc-4ccc-8ccc-cccccccccccc'],
      3,
    );

    expect(stream.destroy).toHaveBeenCalled();
    expect(finishMaterialRetry).toHaveBeenCalledWith(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      true,
    );
    expect(result.results[0]?.status).toBe('RETRYING');
  });

  it('keeps the READY material and old object when replacement storage fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'effect-replace-'));
    const path = join(directory, 'front.jpg');
    await writeFile(path, Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...new Array(20).fill(0)]));
    const current = {
      id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      projectId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      productId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      type: 'PRODUCT_IMAGE' as const,
      status: 'READY' as const,
      expectedFileName: null,
      originalFileName: 'old.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 10,
      storageKey: 'old/storage-object',
      failureDisposition: null,
      errorCode: null,
      errorMessage: null,
      retryCount: 0,
      createdAt: new Date('2026-08-20T00:00:00.000Z'),
      updatedAt: new Date('2026-08-20T00:00:00.000Z'),
    };
    const replaceMaterial = vi.fn();
    const deleteObject = vi.fn();
    const service = serviceWith(
      {
        material: vi.fn().mockResolvedValue(current),
        product: vi.fn().mockResolvedValue({ id: current.productId }),
        replaceMaterial,
      },
      {
        put: vi.fn().mockRejectedValue(new Error('storage unavailable')),
        delete: deleteObject,
      },
    );
    vi.spyOn(service, 'getDraft').mockResolvedValue(draftValue());

    try {
      await expect(
        service.replaceMaterial(current.projectId, 'BATCH', current.productId, current.id, 3, {
          path,
          originalname: 'new.jpg',
          mimetype: 'image/jpeg',
          size: 24,
        }),
      ).rejects.toMatchObject({
        status: 500,
        response: { code: 'STORAGE_WRITE_FAILED' },
      });
      expect(replaceMaterial).not.toHaveBeenCalled();
      expect(deleteObject).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects RIFF without WEBP and legacy DOC without OLE signatures', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'effect-signature-'));
    const riffPath = join(directory, 'fake.webp');
    const docPath = join(directory, 'fake.doc');
    await writeFile(riffPath, Buffer.from('RIFF0000WAVE0000'));
    await writeFile(docPath, Buffer.from('plain text document'));
    const service = serviceWith();
    const assertFile = (
      service as unknown as {
        assertMaterialFile: (
          file: { path: string; originalname: string; mimetype: string; size: number },
          type: 'PRODUCT_IMAGE' | 'PRODUCT_DOCUMENT',
        ) => Promise<unknown>;
      }
    ).assertMaterialFile.bind(service);
    try {
      await expect(
        assertFile(
          { path: riffPath, originalname: 'fake.webp', mimetype: 'image/webp', size: 16 },
          'PRODUCT_IMAGE',
        ),
      ).rejects.toMatchObject({ status: 400 });
      await expect(
        assertFile(
          { path: docPath, originalname: 'fake.doc', mimetype: 'application/msword', size: 19 },
          'PRODUCT_DOCUMENT',
        ),
      ).rejects.toMatchObject({ status: 400 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('persists deferred cleanup instead of deleting an object held by a publish snapshot', async () => {
    const enqueueStorageCleanup = vi.fn().mockResolvedValue(undefined);
    const deleteObject = vi.fn();
    const service = serviceWith(
      {
        isStorageHeld: vi.fn().mockResolvedValue(true),
        enqueueStorageCleanup,
      },
      { delete: deleteObject },
    );
    const deleteOrQueue = (
      service as unknown as {
        deleteOrQueue: (projectId: string, storageKey: string, reason: string) => Promise<void>;
      }
    ).deleteOrQueue.bind(service);

    await deleteOrQueue('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'held/source', 'MATERIAL_DELETED');

    expect(deleteObject).not.toHaveBeenCalled();
    expect(enqueueStorageCleanup).toHaveBeenCalledWith(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'held/source',
      'MATERIAL_DELETED',
    );
  });

  it('recovers a failed publish from its snapshot after the live draft changes', async () => {
    const snapshot = {
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      projectId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      mode: 'BATCH',
      revision: 3,
      globalConfig: DEFAULT_EFFECT_VIDEO_CONFIG,
      products: [
        {
          id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          name: '产品',
          category: '食品',
          sku: 'SKU-1',
          commerceUrl: null,
          configOverride: {},
          materials: [
            {
              id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
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
    };
    const operation = {
      id: 'operation-1',
      draftId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      revision: 3,
      status: 'RUNNING',
      result: null,
      snapshot,
    };
    const startPublishOperation = vi.fn().mockResolvedValue({
      owner: true,
      requestMatches: true,
      operation,
    });
    const failPublishOperation = vi.fn().mockResolvedValue(undefined);
    const completePublishOperation = vi.fn().mockResolvedValue(true);
    let configFailed = false;
    const storeWorkflowArtifact = vi
      .fn()
      .mockImplementation(
        async (
          _projectId: string,
          _workflow: string,
          _space: string,
          artifact: { type: string },
        ) => {
          if (artifact.type === 'VIDEO_CONFIG' && !configFailed) {
            configFailed = true;
            throw new Error('temporary asset failure');
          }
          return {
            asset: { id: artifact.type === 'VIDEO_CONFIG' ? 'asset-config' : 'asset-metadata' },
            assetVersionId:
              artifact.type === 'VIDEO_CONFIG' ? 'version-config' : 'version-metadata',
            version: 1,
          };
        },
      );
    const storeWorkflowFileOperation = vi.fn().mockResolvedValue({
      asset: { id: 'asset-file' },
      assetVersionId: 'version-file',
      version: 1,
    });
    const service = serviceWith(
      {
        publishOperationByKey: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(operation),
        startPublishOperation,
        failPublishOperation,
        completePublishOperation,
      },
      {},
      { storeWorkflowArtifact, storeWorkflowFileOperation },
    );
    vi.spyOn(service, 'getDraft')
      .mockResolvedValueOnce(publishableDraft())
      .mockResolvedValueOnce(draftValue({ revision: 4, validatedRevision: null }));

    await expect(
      service.publish('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'BATCH', 3, 'publish-click-retry'),
    ).rejects.toThrow('temporary asset failure');
    const recovered = await service.publish(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'BATCH',
      4,
      'publish-click-retry',
    );

    expect(recovered.publishedAssets).toHaveLength(3);
    expect(failPublishOperation).toHaveBeenCalledTimes(1);
    expect(completePublishOperation).toHaveBeenCalledTimes(1);
    expect(storeWorkflowArtifact.mock.calls[0]?.[4]).toBe(
      'operation-1:product:cccccccc-cccc-4ccc-8ccc-cccccccccccc:metadata',
    );
    expect(storeWorkflowArtifact.mock.calls[2]?.[4]).toBe(
      'operation-1:product:cccccccc-cccc-4ccc-8ccc-cccccccccccc:metadata',
    );
  });

  it('creates another asset version when the user publishes again with a new key', async () => {
    const baseSnapshot = {
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      projectId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      mode: 'BATCH',
      revision: 3,
      globalConfig: DEFAULT_EFFECT_VIDEO_CONFIG,
      products: [
        {
          id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          name: '产品',
          category: '食品',
          sku: 'SKU-1',
          commerceUrl: null,
          configOverride: {},
          materials: [],
        },
      ],
    };
    const startPublishOperation = vi
      .fn()
      .mockImplementation(
        async (_project: string, _draft: string, _revision: number, key: string) => ({
          owner: true,
          requestMatches: true,
          operation: {
            id: key === 'click-1' ? 'operation-1' : 'operation-2',
            status: 'RUNNING',
            result: null,
            snapshot: baseSnapshot,
          },
        }),
      );
    const storeWorkflowArtifact = vi
      .fn()
      .mockImplementation(
        async (
          _project: string,
          _workflow: string,
          _space: string,
          artifact: { type: string },
          operationKey: string,
        ) => ({
          asset: { id: `asset-${artifact.type}` },
          assetVersionId: `version-${operationKey}`,
          version: operationKey.startsWith('operation-1') ? 1 : 2,
        }),
      );
    const service = serviceWith(
      {
        publishOperationByKey: vi.fn().mockResolvedValue(null),
        startPublishOperation,
        completePublishOperation: vi.fn().mockResolvedValue(true),
        failPublishOperation: vi.fn(),
      },
      {},
      { storeWorkflowArtifact },
    );
    vi.spyOn(service, 'getDraft').mockResolvedValue(publishableDraft());

    const first = await service.publish(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'BATCH',
      3,
      'click-1',
    );
    const second = await service.publish(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'BATCH',
      3,
      'click-2',
    );

    expect(first.publishedAssets.every((item) => item.version === 1)).toBe(true);
    expect(second.publishedAssets.every((item) => item.version === 2)).toBe(true);
    expect(startPublishOperation.mock.calls.map((call) => call[3])).toEqual(['click-1', 'click-2']);
  });

  it('returns the exact completed publish result without creating another asset version', async () => {
    const completed: PublishEffectImportDraftData = {
      projectId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      draftId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      mode: 'BATCH',
      revision: 3,
      publishedAssets: [],
      summary: { publishedAt: '2026-08-20T00:00:00.000Z', assetCount: 0, assetVersionCount: 0 },
    };
    const startPublishOperation = vi.fn().mockResolvedValue({
      owner: false,
      requestMatches: true,
      operation: { status: 'COMPLETED', result: completed },
    });
    const storeWorkflowArtifact = vi.fn();
    const service = serviceWith(
      {
        publishOperationByKey: vi.fn().mockResolvedValue({
          id: 'existing-operation',
          draftId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          revision: 3,
        }),
        startPublishOperation,
      },
      {},
      { storeWorkflowArtifact },
    );
    vi.spyOn(service, 'getDraft').mockResolvedValue(publishableDraft());

    await expect(
      service.publish('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'BATCH', 3, 'publish-click-1'),
    ).resolves.toEqual(completed);
    expect(storeWorkflowArtifact).not.toHaveBeenCalled();
  });
});
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
