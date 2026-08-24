import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';

import type { ConfigService } from '@nestjs/config';
import type { Asset as AssetRecord } from '../../generated/prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { StoragePort } from '../file/storage.port';
import type { ProjectService } from '../project/project.service';
import type { AssetRepository } from './asset.repository';
import {
  AssetRangeNotSatisfiableError,
  AssetService,
  parseRangeHeader,
  previewKindForMimeType,
} from './asset.service';

const timestamp = new Date('2026-08-20T03:00:00.000Z');
const record: AssetRecord = {
  id: 'bb157bde-c253-4d02-91c2-e2f550d29df1',
  projectId: 'ea77ed70-8a2c-4548-91cb-28987657aa1b',
  name: '产品图',
  directory: 'VISUAL_ASSETS',
  type: 'PRODUCT_ASSET',
  tags: ['夏季', '产品'],
  notes: '主视觉',
  originalFileName: 'product.png',
  mimeType: 'image/png',
  sizeBytes: 4,
  storageKey: 'assets/key',
  hasFile: true,
  storageWorkflow: 'EFFECT',
  workflowSpace: 'EFFECT',
  status: 'AVAILABLE',
  qualityStatus: 'AVAILABLE',
  currentVersion: 1,
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
  idempotencyKey: null,
  sourceProjectId: null,
  sourceAssetId: null,
  sourceVersion: null,
  importedAt: null,
  dependencies: null,
  archivedAt: null,
  createdAt: timestamp,
  updatedAt: timestamp,
};

describe('AssetService', () => {
  let repository: {
    list: ReturnType<typeof vi.fn>;
    count: ReturnType<typeof vi.fn>;
    listForFacets: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    find: ReturnType<typeof vi.fn>;
    findVersion: ReturnType<typeof vi.fn>;
    listVersions: ReturnType<typeof vi.fn>;
    findByIdempotency: ReturnType<typeof vi.fn>;
    createFileVersion: ReturnType<typeof vi.fn>;
    createVersion: ReturnType<typeof vi.fn>;
    upgradeSnapshot: ReturnType<typeof vi.fn>;
    addTags: ReturnType<typeof vi.fn>;
    archiveMany: ReturnType<typeof vi.fn>;
    toArtifactRecord: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    archive: ReturnType<typeof vi.fn>;
  };
  let projects: {
    exists: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
  };
  let storage: {
    put: ReturnType<typeof vi.fn>;
    open: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
  let service: AssetService;
  let temporaryRoot: string;

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'asset-service-'));
    repository = {
      list: vi.fn(),
      count: vi.fn(),
      listForFacets: vi.fn(),
      create: vi.fn(),
      find: vi.fn(),
      findVersion: vi.fn(),
      listVersions: vi.fn(),
      findByIdempotency: vi.fn(),
      createFileVersion: vi.fn(),
      createVersion: vi.fn(),
      upgradeSnapshot: vi.fn(),
      addTags: vi.fn(),
      archiveMany: vi.fn(),
      toArtifactRecord: vi.fn(),
      update: vi.fn(),
      archive: vi.fn(),
    };
    projects = {
      exists: vi.fn().mockResolvedValue(true),
      get: vi.fn().mockResolvedValue({ id: 'project-1', name: '测试项目' }),
    };
    storage = {
      put: vi.fn(),
      open: vi.fn(),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    service = new AssetService(
      repository as unknown as AssetRepository,
      projects as unknown as ProjectService,
      storage as unknown as StoragePort,
      { getOrThrow: () => 512 * 1024 * 1024 } as unknown as ConfigService,
    );
  });

  afterEach(async () => {
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  it('returns filtered items with workflow-space facets and never exposes storageKey', async () => {
    repository.list.mockResolvedValue([record]);
    repository.listForFacets.mockResolvedValue([
      {
        directory: record.directory,
        type: record.type,
        status: record.status,
        tags: record.tags,
        businessData: { productId: 'product-a', productName: '广式腊肠' },
      },
      {
        directory: 'AUDIO_ASSETS',
        type: 'VOICE_AUDIO',
        status: 'AVAILABLE',
        tags: ['夏季'],
        businessData: null,
      },
      {
        directory: record.directory,
        type: record.type,
        status: record.status,
        tags: [],
        businessData: { productId: 'product-b', productName: '广式腊肠' },
      },
    ]);

    const result = await service.list(record.projectId, {
      directory: 'VISUAL_ASSETS',
      workflow: 'EFFECT',
      space: 'EFFECT',
    });

    expect(repository.list).toHaveBeenCalledWith(record.projectId, {
      directory: 'VISUAL_ASSETS',
      workflow: 'EFFECT',
      space: 'EFFECT',
    });
    expect(repository.listForFacets).toHaveBeenCalledWith(record.projectId, {
      workflow: 'EFFECT',
      space: 'EFFECT',
    });
    expect(result.total).toBe(1);
    expect(result.facets.tags).toEqual([
      { value: '产品', count: 1 },
      { value: '夏季', count: 2 },
    ]);
    expect(result.facets.products).toEqual([
      { value: 'product-a', label: '广式腊肠', count: 1 },
      { value: 'product-b', label: '广式腊肠', count: 1 },
    ]);
    expect(result.items[0]).not.toHaveProperty('storageKey');
    expect(result.items[0]?.previewKind).toBe('IMAGE');
  });

  it('uses the same not-found response for cross-project, archived and missing ids', async () => {
    repository.find.mockResolvedValue(null);
    repository.archive.mockResolvedValue(null);

    await expect(service.get('project-b', record.id)).rejects.toMatchObject({
      status: 404,
      response: { code: 'ASSET_NOT_FOUND' },
    });
    await expect(
      service.update('project-b', record.id, { name: '不会修改' }),
    ).rejects.toMatchObject({ response: { code: 'ASSET_NOT_FOUND' } });
    await expect(service.archive('project-b', record.id)).rejects.toMatchObject({
      response: { code: 'ASSET_NOT_FOUND' },
    });
    await expect(service.content('project-b', record.id)).rejects.toMatchObject({
      response: { code: 'ASSET_NOT_FOUND' },
    });
    expect(repository.find).toHaveBeenCalledWith('project-b', record.id);
    expect(repository.update).not.toHaveBeenCalled();
    expect(storage.open).not.toHaveBeenCalled();
  });

  it('returns workflow-space status facets and stable pagination metadata', async () => {
    repository.list.mockResolvedValue([record]);
    repository.listForFacets.mockResolvedValue([
      { directory: record.directory, type: record.type, status: 'AVAILABLE', tags: [] },
      { directory: record.directory, type: record.type, status: 'QUALITY_WARNING', tags: [] },
    ]);
    repository.count.mockResolvedValue(49);

    const result = await service.list(record.projectId, {
      workflow: 'EFFECT',
      space: 'EFFECT',
      status: 'AVAILABLE',
      page: 2,
      pageSize: 24,
    });

    expect(repository.count).toHaveBeenCalledWith(
      record.projectId,
      expect.objectContaining({ page: 2 }),
    );
    expect(result.total).toBe(49);
    expect(result.pagination).toEqual({ page: 2, pageSize: 24, pageCount: 3 });
    expect(result.facets.statuses).toEqual([
      { value: 'AVAILABLE', label: '可用', count: 1 },
      { value: 'QUALITY_WARNING', label: '质量预警', count: 1 },
    ]);
  });

  it('creates a new version for the same server-side multi-upload idempotency key', async () => {
    const path = join(temporaryRoot, 'repeat-upload.tmp');
    await writeFile(path, 'data');
    repository.findByIdempotency.mockResolvedValue(record);
    repository.createFileVersion.mockResolvedValue({ ...record, currentVersion: 2 });
    storage.put.mockImplementation(async (input: Parameters<StoragePort['put']>[0]) => {
      input.stream.resume();
      await finished(input.stream);
      return { key: 'assets/version-2', sizeBytes: 4 };
    });

    const result = await service.importMany(
      record.projectId,
      { workflow: 'EFFECT', space: 'EFFECT', type: record.type },
      [{ path, originalname: record.originalFileName, mimetype: record.mimeType, size: 4 }],
    );

    expect(repository.findByIdempotency).toHaveBeenCalledWith(
      record.projectId,
      'EFFECT',
      'EFFECT',
      'EFFECT|EFFECT|PRODUCT_ASSET|product.png|4',
    );
    expect(repository.create).not.toHaveBeenCalled();
    expect(repository.createFileVersion).toHaveBeenCalledWith(record.projectId, record.id, {
      originalFileName: record.originalFileName,
      mimeType: record.mimeType,
      sizeBytes: 4,
      storageKey: 'assets/version-2',
    });
    expect(result[0]?.currentVersion).toBe(2);
  });

  it('copies an explicit source version into a new project-scoped snapshot', async () => {
    const targetProjectId = '16726346-e726-463e-921e-6db3e080bf8a';
    const sourceVersion = {
      id: 'version-1',
      projectId: record.projectId,
      assetId: record.id,
      version: 1,
      changeNote: '初始导入版本',
      status: record.status,
      qualityStatus: record.qualityStatus,
      content: null,
      businessData: null,
      originalFileName: record.originalFileName,
      mimeType: record.mimeType,
      sizeBytes: record.sizeBytes,
      storageKey: record.storageKey,
      createdAt: timestamp,
    };
    const snapshot = {
      ...record,
      id: 'c858cb25-6fc3-42b2-b92b-785c4a149da6',
      projectId: targetProjectId,
      sourceProjectId: record.projectId,
      sourceAssetId: record.id,
      sourceVersion: 1,
      importedAt: timestamp,
    };
    repository.find.mockResolvedValueOnce(record).mockResolvedValueOnce(record);
    repository.findVersion.mockResolvedValue(sourceVersion);
    repository.create.mockResolvedValue(snapshot);

    const result = await service.importSnapshot(targetProjectId, {
      sourceProjectId: record.projectId,
      sourceAssetId: record.id,
      sourceVersion: 1,
      targetWorkflow: 'CUSTOMIZED',
      targetSpace: 'CUSTOMIZED_PROJECT',
    });

    expect(repository.find).toHaveBeenNthCalledWith(1, record.projectId, record.id);
    expect(repository.findVersion).toHaveBeenCalledWith(record.projectId, record.id, 1);
    expect(repository.create).toHaveBeenCalledWith(
      targetProjectId,
      expect.objectContaining({
        sourceProjectId: record.projectId,
        sourceAssetId: record.id,
        sourceVersion: 1,
        storageWorkflow: 'CUSTOMIZED',
        workflowSpace: 'CUSTOMIZED_PROJECT',
      }),
      expect.any(String),
    );
    expect(result).toMatchObject({ projectId: targetProjectId, isSnapshot: true, readOnly: true });
  });

  it('returns only project-scoped ids from batch tags and archive', async () => {
    repository.addTags.mockResolvedValue([record.id]);
    repository.archiveMany.mockResolvedValue([record.id]);

    await expect(
      service.batchTags(record.projectId, [record.id, 'cross-project'], [' 新标签 ']),
    ).resolves.toEqual({ affected: 1, assetIds: [record.id] });
    await expect(
      service.batchArchive(record.projectId, ['cross-project', record.id]),
    ).resolves.toEqual({ affected: 1, assetIds: [record.id] });
    expect(repository.addTags).toHaveBeenCalledWith(
      record.projectId,
      [record.id, 'cross-project'],
      ['新标签'],
    );
    expect(repository.archiveMany).toHaveBeenCalledWith(record.projectId, [
      'cross-project',
      record.id,
    ]);
  });

  it('versions an already stored workflow artifact by its scoped idempotency key', async () => {
    repository.findByIdempotency.mockResolvedValue(record);
    repository.createVersion.mockResolvedValue({ ...record, currentVersion: 2 });
    const input = {
      workflow: 'EFFECT' as const,
      space: 'EFFECT' as const,
      assets: [
        {
          idempotencyKey: 'run-42|prompt-3',
          name: ' Prompt 3 ',
          directory: 'PROMPTS' as const,
          type: 'PROMPT' as const,
          tags: [' 投放 ', '投放'],
          notes: '正式产物再次入库',
          content: { prompt: 'hello' },
        },
      ],
    };

    const result = await service.storeArtifacts(record.projectId, input);

    expect(repository.findByIdempotency).toHaveBeenCalledWith(
      record.projectId,
      'EFFECT',
      'EFFECT',
      'run-42|prompt-3',
    );
    expect(repository.createVersion).toHaveBeenCalledWith(record.projectId, record.id, {
      changeNote: '正式产物再次入库',
      status: 'PENDING_REVIEW',
      content: { prompt: 'hello' },
      businessData: undefined,
    });
    expect(result).toMatchObject({ created: 0, versioned: 1 });
    expect(result.items[0]?.currentVersion).toBe(2);
  });

  it('does not create a database row after storage failure and removes the multipart temp file', async () => {
    const path = join(temporaryRoot, 'upload.tmp');
    await writeFile(path, 'data');
    storage.put.mockRejectedValue(new Error('disk full'));

    await expect(
      service.import(
        record.projectId,
        {
          name: record.name,
          directory: record.directory,
          type: record.type,
          tags: record.tags,
          notes: record.notes,
        },
        { path, originalname: record.originalFileName, mimetype: record.mimeType, size: 4 },
      ),
    ).rejects.toMatchObject({ response: { code: 'STORAGE_WRITE_FAILED' } });
    expect(repository.create).not.toHaveBeenCalled();
    await expect(readFileExists(path)).resolves.toBe(false);
  });

  it('compensates the stored object when database creation fails', async () => {
    const path = join(temporaryRoot, 'upload.tmp');
    await writeFile(path, 'data');
    storage.put.mockResolvedValue({ key: 'assets/new', sizeBytes: 4 });
    repository.create.mockRejectedValue(new Error('database unavailable'));

    await expect(
      service.import(
        record.projectId,
        {
          name: record.name,
          directory: record.directory,
          type: record.type,
          tags: record.tags,
          notes: record.notes,
        },
        { path, originalname: record.originalFileName, mimetype: record.mimeType, size: 4 },
      ),
    ).rejects.toThrow('database unavailable');
    expect(storage.delete).toHaveBeenCalledWith('assets/new');
  });

  it('validates the final directory/type combination for partial updates', async () => {
    repository.find.mockResolvedValue(record);

    await expect(
      service.update(record.projectId, record.id, { directory: 'SCRIPTS' }),
    ).rejects.toMatchObject({
      response: { code: 'VALIDATION_ERROR' },
    });
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('archives without deleting stored content and returns the timestamp', async () => {
    repository.archive.mockResolvedValue(timestamp);

    await expect(service.archive(record.projectId, record.id)).resolves.toEqual({
      id: record.id,
      archivedAt: timestamp.toISOString(),
    });
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('opens media with parsed range and project-scoped metadata lookup', async () => {
    repository.find.mockResolvedValue({ ...record, mimeType: 'video/mp4' });
    storage.open.mockResolvedValue({
      stream: Readable.from('at'),
      sizeBytes: 4,
      start: 1,
      end: 2,
      contentLength: 2,
    });

    await expect(service.content(record.projectId, record.id, 'bytes=1-2')).resolves.toMatchObject({
      previewKind: 'VIDEO',
      partial: true,
      start: 1,
      end: 2,
    });
    expect(storage.open).toHaveBeenCalledWith(record.storageKey, { start: 1, end: 2 });
  });
});

const readFileExists = async (path: string): Promise<boolean> => {
  try {
    const { access } = await import('node:fs/promises');
    await access(path);
    return true;
  } catch {
    return false;
  }
};

describe('asset content helpers', () => {
  it('classifies only whitelisted media as inline previews', () => {
    expect(previewKindForMimeType('image/png')).toBe('IMAGE');
    expect(previewKindForMimeType('image/svg+xml')).toBe('DOWNLOAD');
    expect(previewKindForMimeType('text/html')).toBe('DOWNLOAD');
  });

  it('supports normal, open-ended and suffix ranges and rejects invalid ranges', () => {
    expect(parseRangeHeader('bytes=1-3', 10)).toEqual({ start: 1, end: 3 });
    expect(parseRangeHeader('bytes=8-', 10)).toEqual({ start: 8, end: 9 });
    expect(parseRangeHeader('bytes=-2', 10)).toEqual({ start: 8, end: 9 });
    expect(() => parseRangeHeader('bytes=10-', 10)).toThrow(AssetRangeNotSatisfiableError);
    expect(() => parseRangeHeader('bytes=1-2,4-5', 10)).toThrow(AssetRangeNotSatisfiableError);
  });
});
