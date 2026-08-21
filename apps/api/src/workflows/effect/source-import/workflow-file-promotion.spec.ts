import { Readable } from 'node:stream';

import type { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';

import type { Asset as AssetRecord } from '../../../generated/prisma/client';
import type { AssetRepository } from '../../../platform/asset/asset.repository';
import { AssetService } from '../../../platform/asset/asset.service';
import type { StoragePort } from '../../../platform/file/storage.port';
import type { ProjectService } from '../../../platform/project/project.service';

const now = new Date('2026-08-20T00:00:00.000Z');
const assetRecord = (version: number, storageKey: string): AssetRecord => ({
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  projectId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  name: '商品正面图',
  directory: 'SOURCE_MATERIALS',
  type: 'SOURCE_MATERIAL',
  storageWorkflow: 'EFFECT',
  workflowSpace: 'EFFECT',
  status: 'PENDING_REVIEW',
  qualityStatus: 'PENDING_REVIEW',
  currentVersion: version,
  tags: [],
  notes: null,
  originalFileName: 'front.jpg',
  mimeType: 'image/jpeg',
  sizeBytes: 3,
  storageKey,
  hasFile: true,
  assetClass: null,
  businessType: null,
  contentKind: null,
  content: null,
  businessData: null,
  views: [],
  sourceArtifactId: null,
  sourceRunId: null,
  sourceNode: null,
  sourceShot: null,
  idempotencyKey: 'effect-import:draft:material:1',
  sourceProjectId: null,
  sourceAssetId: null,
  sourceVersion: null,
  importedAt: null,
  dependencies: null,
  archivedAt: null,
  createdAt: now,
  updatedAt: now,
});

const input = {
  name: '商品正面图',
  directory: 'SOURCE_MATERIALS' as const,
  type: 'SOURCE_MATERIAL' as const,
  originalFileName: 'front.jpg',
  mimeType: 'image/jpeg',
  sizeBytes: 3,
  sourceStorageKey: 'draft/source',
  workflow: 'EFFECT' as const,
  space: 'EFFECT' as const,
  idempotencyKey: 'effect-import:draft:material:1',
};

describe('AssetService workflow file promotion', () => {
  it('replays a completed operation without copying or versioning again', async () => {
    const existing = assetRecord(2, 'asset/copied');
    const repository = {
      findOperation: vi.fn().mockResolvedValue({
        asset: existing,
        assetVersionId: 'version-2',
        version: 2,
      }),
      findByIdempotency: vi.fn(),
      createFileVersion: vi.fn(),
    };
    const storage = { open: vi.fn(), put: vi.fn(), delete: vi.fn() };
    const service = new AssetService(
      repository as unknown as AssetRepository,
      { exists: vi.fn().mockResolvedValue(true) } as unknown as ProjectService,
      storage as unknown as StoragePort,
      { getOrThrow: () => 512 * 1024 * 1024 } as unknown as ConfigService,
    );

    const result = await service.storeWorkflowFileOperation(existing.projectId, {
      ...input,
      operationKey: 'publish-operation:material',
    });

    expect(result).toMatchObject({ assetVersionId: 'version-2', version: 2 });
    expect(storage.open).not.toHaveBeenCalled();
    expect(storage.put).not.toHaveBeenCalled();
    expect(repository.createFileVersion).not.toHaveBeenCalled();
  });

  it('copies the staged object and creates a new version for a stable idempotency key', async () => {
    const existing = assetRecord(1, 'asset/old');
    const repository = {
      findByIdempotency: vi.fn().mockResolvedValue(existing),
      createFileVersion: vi.fn().mockResolvedValue(assetRecord(2, 'asset/copied')),
    };
    const storage = {
      open: vi.fn().mockResolvedValue({
        stream: Readable.from('abc'),
        sizeBytes: 3,
        start: 0,
        end: 2,
        contentLength: 3,
      }),
      put: vi.fn().mockResolvedValue({ key: 'asset/copied', sizeBytes: 3 }),
      delete: vi.fn(),
    };
    const service = new AssetService(
      repository as unknown as AssetRepository,
      { exists: vi.fn().mockResolvedValue(true) } as unknown as ProjectService,
      storage as unknown as StoragePort,
      { getOrThrow: () => 512 * 1024 * 1024 } as unknown as ConfigService,
    );

    const asset = await service.storeWorkflowFile(existing.projectId, input);

    expect(asset.currentVersion).toBe(2);
    expect(repository.createFileVersion).toHaveBeenCalledWith(
      existing.projectId,
      existing.id,
      {
        originalFileName: 'front.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 3,
        storageKey: 'asset/copied',
      },
      undefined,
    );
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('deletes the copied object when the asset transaction fails', async () => {
    const repository = {
      findByIdempotency: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockRejectedValue(new Error('database failed')),
    };
    const storage = {
      open: vi.fn().mockResolvedValue({
        stream: Readable.from('abc'),
        sizeBytes: 3,
        start: 0,
        end: 2,
        contentLength: 3,
      }),
      put: vi.fn().mockResolvedValue({ key: 'asset/orphan', sizeBytes: 3 }),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    const service = new AssetService(
      repository as unknown as AssetRepository,
      { exists: vi.fn().mockResolvedValue(true) } as unknown as ProjectService,
      storage as unknown as StoragePort,
      { getOrThrow: () => 512 * 1024 * 1024 } as unknown as ConfigService,
    );

    await expect(
      service.storeWorkflowFile('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', input),
    ).rejects.toThrow('database failed');
    expect(storage.delete).toHaveBeenCalledWith('asset/orphan');
  });
});
