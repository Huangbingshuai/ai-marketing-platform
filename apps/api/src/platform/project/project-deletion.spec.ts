import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../database/prisma.service';
import type { StoragePort } from '../file/storage.port';
import { ProjectDeletionRepository, PROJECT_STORAGE_COLUMNS } from './project-deletion.repository';
import { ProjectDeletionService } from './project-deletion.service';
import { ProjectDeletionCacheService } from './project-deletion-cache.service';
import type { RedisConnectionService } from '../cache/redis-connection.service';
import type { ConfigService } from '@nestjs/config';

const activeModels = [
  'customizedProductionTask',
  'customizedStoryboardTask',
  'customizedExtractionTask',
  'effectExtractionRun',
  'effectPromptRun',
  'effectSegmentRenderBatch',
  'effectSegmentRenderTask',
  'effectTemplateMixAiRun',
  'effectVoicePreview',
  'effectPackagingRun',
  'effectPackagingItem',
  'effectFinalOutputRun',
  'effectFinalOutputItem',
  'effectImportUploadSession',
  'effectSegmentImportDraft',
  'effectImportMaterial',
];
const restricted = [
  'workingArtifactDependency',
  'workingArtifactRevisionFile',
  'workingArtifactFile',
  'effectPackagingFile',
  'effectVoicePreview',
  'effectFinalOutputItem',
  'effectSegmentImportDraft',
  'effectImportUploadItem',
  'effectImportMaterial',
  'effectImportProduct',
  'assetOperationReceipt',
  'assetVersion',
  'asset',
];

function fixture(busy?: string) {
  const tx: Record<string, any> = {
    $queryRaw: vi.fn().mockImplementation(async (query: { sql?: string }) => {
      if (query.sql?.includes('WITH refs')) return [{ key: 'owned-file' }];
      return [{ id: 'project-a' }];
    }),
    project: {
      delete: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      count: vi.fn().mockResolvedValue(0),
      findUniqueOrThrow: vi.fn().mockResolvedValue({
        id: 'project-a',
        name: 'fixture',
        status: 'ACTIVE',
        description: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        defaultSpace: 'EFFECT',
        assets: [],
        deletionState: null,
        deletionError: null,
      }),
    },
    projectDeletionCleanup: {
      create: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      upsert: vi.fn(),
      findUnique: vi.fn().mockResolvedValue({ status: 'QUEUED', phase: 'DATABASE' }),
    },
    workflowRun: { updateMany: vi.fn() },
  };
  for (const model of new Set([...activeModels, ...restricted]))
    tx[model] = {
      count: vi.fn().mockResolvedValue(model === busy ? 1 : 0),
      deleteMany: vi.fn(),
    };
  return {
    tx,
    repository: new ProjectDeletionRepository({
      $transaction: (callback: any) => callback(tx),
      project: tx.project,
      projectDeletionCleanup: tx.projectDeletionCleanup,
    } as PrismaService),
  };
}

describe('permanent project deletion', () => {
  it.each(activeModels)('rejects submission while %s is active', async (model) => {
    const { tx, repository } = fixture(model);
    tx.projectDeletionCleanup.findUnique.mockResolvedValue(null);
    await expect(repository.enqueue('project-a')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'PROJECT_BUSY' }),
    });
    expect(tx.projectDeletionCleanup.upsert).not.toHaveBeenCalled();
    expect(tx.project.update).not.toHaveBeenCalled();
  });

  it('reuses a queued job without rescanning files or resetting its lease', async () => {
    const { tx, repository } = fixture();
    await expect(repository.enqueue('project-a')).resolves.toMatchObject({
      status: 'QUEUED',
      deleted: false,
    });
    expect(tx.projectDeletionCleanup.upsert).not.toHaveBeenCalled();
    expect(tx.effectPromptRun.count).not.toHaveBeenCalled();
    expect(tx.project.delete).not.toHaveBeenCalled();
  });

  it('queues a failed job again with a clean lease, while bulk deletion remains deferred', async () => {
    const { tx, repository } = fixture();
    tx.projectDeletionCleanup.findUnique.mockResolvedValue({ phase: 'DATABASE', status: 'FAILED' });
    await repository.enqueue('project-a');
    expect(tx.projectDeletionCleanup.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { projectId: 'project-a' },
        update: expect.objectContaining({
          phase: 'DATABASE',
          status: 'QUEUED',
          leaseToken: null,
          attempts: 0,
          storageKeys: [],
        }),
      }),
    );
    expect(tx.project.update).toHaveBeenCalledWith({
      where: { id: 'project-a' },
      data: { deletionState: 'QUEUED', deletionError: null },
    });
    expect(tx.project.delete).not.toHaveBeenCalled();
    expect(
      tx.$queryRaw.mock.calls.some((call: [{ sql?: string }]) =>
        call[0].sql?.includes('WITH refs'),
      ),
    ).toBe(false);
  });
  it.each(activeModels)('rejects active %s before touching files or data', async (model) => {
    const { tx, repository } = fixture(model);
    await expect(repository.remove('project-a', 'lease-token')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'PROJECT_BUSY' }),
    });
    expect(tx.project.delete).not.toHaveBeenCalled();
    expect(tx.projectDeletionCleanup.create).not.toHaveBeenCalled();
    for (const item of activeModels)
      expect(tx[item].count.mock.calls[0][0].where.projectId).toBe('project-a');
  });

  it('persists cleanup before resolving Restrict relationships and deleting only the scoped project', async () => {
    const { tx, repository } = fixture();
    await repository.remove('project-a', 'lease-token');
    expect(tx.projectDeletionCleanup.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { projectId: 'project-a', leaseToken: 'lease-token' },
        data: expect.objectContaining({
          storageKeys: ['owned-file'],
          phase: 'FILES',
          leaseToken: null,
        }),
      }),
    );
    for (const model of restricted)
      expect(tx[model].deleteMany).toHaveBeenCalledWith({ where: { projectId: 'project-a' } });
    expect(tx.workflowRun.updateMany).toHaveBeenCalledWith({
      where: { projectId: 'project-a' },
      data: { parentWorkflowRunId: null },
    });
    expect(tx.project.delete).toHaveBeenCalledWith({ where: { id: 'project-a' } });
    expect(tx.projectDeletionCleanup.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      tx.project.delete.mock.invocationCallOrder[0],
    );
  });

  it('is idempotent when the project no longer exists', async () => {
    const { tx, repository } = fixture();
    tx.$queryRaw.mockReset().mockResolvedValue([]);
    await repository.remove('project-a', 'lease-token');
    expect(tx.project.delete).not.toHaveBeenCalled();
    expect(tx.projectDeletionCleanup.create).not.toHaveBeenCalled();
  });

  it('keeps cleanup coverage aligned with every project-owned typed storage-key column', () => {
    const schema = readFileSync('prisma/schema.prisma', 'utf8');
    const columns: string[] = [];
    for (const match of schema.matchAll(/model \w+ \{([\s\S]*?)\n\}/g)) {
      const body = match[1]!;
      if (!/^\s*projectId\s+String/m.test(body)) continue;
      const table = body.match(/@@map\("([^"]+)"\)/)?.[1];
      for (const field of body.matchAll(/^\s*(\w*[Ss]torageKey)\s+String\??\s/gm))
        columns.push(`${table}.${field[1]}`);
    }
    expect(PROJECT_STORAGE_COLUMNS.map(([table, field]) => `${table}.${field}`).sort()).toEqual(
      columns.sort(),
    );
  });
});

describe('durable asynchronous project deletion', () => {
  function setup(keys: string[], phase = 'FILES') {
    let pending = [...keys];
    let exists = true;
    const repository = {
      enqueue: vi.fn().mockResolvedValue({
        projectId: 'project-a',
        deleted: false,
        status: 'QUEUED',
        storageCleanup: 'PENDING',
      }),
      remove: vi.fn().mockImplementation(async () => {
        phase = 'FILES';
        return true;
      }),
      claim: vi
        .fn()
        .mockImplementation(async () =>
          exists ? { keys: [...pending], phase, attempts: 1 } : null,
        ),
      finish: vi.fn().mockImplementation(async (_id, _token, remaining, cacheCleared) => {
        pending = remaining;
        exists = remaining.length > 0 || !cacheCleared;
      }),
      fail: vi.fn(),
      status: vi.fn().mockImplementation(async () => ({
        projectId: 'project-a',
        deleted: phase === 'FILES',
        status: exists ? 'QUEUED' : 'COMPLETED',
        storageCleanup: exists ? 'PENDING' : 'COMPLETED',
      })),
    };
    const storage = { delete: vi.fn().mockResolvedValue(undefined) };
    const cache = { clear: vi.fn().mockResolvedValue(undefined) };
    const service = new ProjectDeletionService(
      repository as unknown as ProjectDeletionRepository,
      storage as unknown as StoragePort,
      cache as unknown as ProjectDeletionCacheService,
    );
    return { repository, storage, service, cache };
  }

  it('returns acceptance without awaiting database deletion, files or cache', async () => {
    const { repository, storage, service, cache } = setup(['a'], 'DATABASE');
    await expect(service.remove('project-a')).resolves.toEqual({
      projectId: 'project-a',
      deleted: false,
      status: 'QUEUED',
      storageCleanup: 'PENDING',
    });
    expect(repository.remove).not.toHaveBeenCalled();
    expect(repository.claim).not.toHaveBeenCalled();
    expect(storage.delete).not.toHaveBeenCalled();
    expect(cache.clear).not.toHaveBeenCalled();
  });

  it('rejects the current project before creating a job', async () => {
    const { service, repository } = setup([]);
    await expect(
      service.remove('project-a', { currentProjectId: 'project-a' }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'PROJECT_CURRENT_DELETE_FORBIDDEN' }),
    });
    expect(repository.enqueue).not.toHaveBeenCalled();
  });

  it('runs both phases in the background with files after the deletion transaction', async () => {
    const { repository, service, storage } = setup(['a', 'b'], 'DATABASE');
    await service.cleanup('project-a');
    expect((await service.status('project-a')).status).toBe('COMPLETED');
    expect(repository.remove).toHaveBeenCalledTimes(1);
    expect(storage.delete.mock.invocationCallOrder[0]).toBeGreaterThan(
      repository.remove.mock.invocationCallOrder[0]!,
    );
    expect(storage.delete.mock.calls.map(([key]) => key)).toEqual(['a', 'b']);
  });

  it('retains failed files and a fresh service instance resumes the persisted job', async () => {
    const { repository, storage, service, cache } = setup(['a', 'b']);
    storage.delete.mockRejectedValueOnce(new Error('storage unavailable'));
    await service.cleanup('project-a');
    expect((await service.status('project-a')).status).toBe('QUEUED');
    expect(repository.finish.mock.calls[0]?.[2]).toEqual(['a']);
    expect(repository.finish.mock.calls[0]?.[4]).toBe(true);
    const restarted = new ProjectDeletionService(
      repository as unknown as ProjectDeletionRepository,
      storage as unknown as StoragePort,
      cache as unknown as ProjectDeletionCacheService,
    );
    await restarted.cleanup('project-a');
    expect((await service.status('project-a')).status).toBe('COMPLETED');
    expect(storage.delete.mock.calls.map(([key]) => key)).toEqual(['a', 'b', 'a']);
  });

  it('preserves all data when submission is rejected', async () => {
    const { repository, storage, service } = setup(['a']);
    repository.enqueue.mockRejectedValueOnce(new Error('busy'));
    await expect(service.remove('project-a')).rejects.toThrow('busy');
    expect(storage.delete).not.toHaveBeenCalled();
    expect(repository.claim).not.toHaveBeenCalled();
  });

  it('makes database errors retryable without attempting file deletion', async () => {
    const { repository, service, storage } = setup(['a'], 'DATABASE');
    repository.remove.mockRejectedValueOnce(new Error('database unavailable'));
    await service.cleanup('project-a');
    expect(repository.fail).toHaveBeenCalledWith(
      'project-a',
      expect.any(String),
      '项目删除暂时失败，请重试删除。',
      false,
    );
    expect(storage.delete).not.toHaveBeenCalled();
    expect(repository.finish).not.toHaveBeenCalled();
  });

  it('does not execute an unclaimed or superseded job', async () => {
    const { repository, service, storage } = setup(['a'], 'DATABASE');
    repository.claim.mockResolvedValueOnce(null);
    await service.cleanup('project-a');
    expect(repository.remove).not.toHaveBeenCalled();
    repository.remove.mockResolvedValueOnce(false);
    await service.cleanup('project-a');
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('keeps large manifests durable across bounded file batches', async () => {
    const { storage, service, repository } = setup(
      Array.from({ length: 41 }, (_, index) => `file-${index}`),
    );
    await service.cleanup('project-a');
    expect((await service.status('project-a')).status).toBe('QUEUED');
    expect(storage.delete).toHaveBeenCalledTimes(40);
    expect(repository.finish.mock.calls[0]?.[4]).toBe(false);
    await service.cleanup('project-a');
    expect((await service.status('project-a')).status).toBe('COMPLETED');
    expect(storage.delete).toHaveBeenCalledTimes(41);
  });

  it('retries cache deletion even with no remaining files', async () => {
    const { cache, service } = setup([]);
    cache.clear.mockRejectedValueOnce(new Error('redis unavailable'));
    await service.cleanup('project-a');
    expect((await service.status('project-a')).status).toBe('QUEUED');
    await service.cleanup('project-a');
    expect((await service.status('project-a')).status).toBe('COMPLETED');
  });
});

describe('project cache isolation', () => {
  it('scans only exact project prefixes, including custom namespaces', async () => {
    const evalMock = vi.fn().mockResolvedValueOnce('7').mockResolvedValue('0');
    const redis = { execute: (operation: any) => operation({ eval: evalMock }) };
    const service = new ProjectDeletionCacheService(
      redis as RedisConnectionService,
      { get: () => 'test:*' } as unknown as ConfigService,
    );
    await service.clear('project-a');
    expect(evalMock.mock.calls.map(([, options]) => options.arguments)).toEqual([
      ['0', 'test:\\*:project-a:*'],
      ['7', 'test:\\*:project-a:*'],
      ['0', 'job:effect-extraction:project-a:*'],
    ]);
  });
});
