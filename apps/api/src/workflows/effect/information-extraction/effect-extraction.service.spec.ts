import { HttpStatus } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { StoragePort } from '../../../platform/file/storage.port';
import type { JobProgressStore } from '../../../platform/job/job.ports';
import type { ProjectService } from '../../../platform/project/project.service';
import type { EffectExtractionRepository } from './effect-extraction.repository';
import { EffectExtractionService } from './effect-extraction.service';

const projectService = (): ProjectService =>
  ({ get: vi.fn().mockResolvedValue({ id: 'project-a' }) }) as unknown as ProjectService;
const storage = {} as StoragePort;

const runRecord = {
  id: 'run-a',
  projectId: 'project-a',
  draftId: 'draft-a',
  productId: 'product-a',
  status: 'RUNNING' as const,
  progress: 20,
  currentNode: 'DOCUMENT',
  warnings: [],
  errorMessage: null,
  createdAt: new Date('2026-08-21T00:00:00.000Z'),
  updatedAt: new Date('2026-08-21T00:01:00.000Z'),
  result: null,
};

describe('EffectExtractionService', () => {
  it('keeps run lookup project-scoped and falls back to database progress when Redis fails', async () => {
    const repository = {
      run: vi.fn().mockResolvedValue({ ...runRecord }),
    } as unknown as EffectExtractionRepository;
    const progress = {
      get: vi.fn().mockRejectedValue(new Error('redis down')),
    } as unknown as JobProgressStore;
    const service = new EffectExtractionService(repository, projectService(), progress, storage);

    const result = await service.run('project-a', 'run-a');

    expect(repository.run).toHaveBeenCalledWith('project-a', 'run-a');
    expect(result.run.progress).toBe(20);
    expect(result.run.currentNode).toBe('DOCUMENT');
  });

  it('uses newer Redis progress without allowing it to lower database progress', async () => {
    const repository = {
      run: vi.fn().mockResolvedValue({ ...runRecord }),
    } as unknown as EffectExtractionRepository;
    const progress = {
      get: vi.fn().mockResolvedValue({ progress: 65, currentNode: 'FUSION' }),
    } as unknown as JobProgressStore;
    const service = new EffectExtractionService(repository, projectService(), progress, storage);

    const result = await service.run('project-a', 'run-a');

    expect(result.run.progress).toBe(65);
    expect(result.run.currentNode).toBe('FUSION');
  });

  it('rejects malformed manual result updates before touching persistence', async () => {
    const repository = {
      result: vi.fn(),
      updateResult: vi.fn(),
    } as unknown as EffectExtractionRepository;
    const service = new EffectExtractionService(
      repository,
      projectService(),
      {} as JobProgressStore,
      storage,
    );

    await expect(
      service.updateResult('project-a', 'result-a', 1, { productName: 'only one field' }),
    ).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
    expect(repository.result).not.toHaveBeenCalled();
  });

  it('maps a stale revision to a conflict and does not create a response run', async () => {
    const repository = {
      startRun: vi.fn().mockResolvedValue({ kind: 'REVISION_CONFLICT' }),
    } as unknown as EffectExtractionRepository;
    const service = new EffectExtractionService(
      repository,
      projectService(),
      {} as JobProgressStore,
      storage,
    );

    await expect(
      service.start('project-a', 'product-a', {
        draftId: 'draft-a',
        expectedRevision: 3,
        idempotencyKey: 'click-a',
      }),
    ).rejects.toMatchObject({ status: HttpStatus.CONFLICT });
  });

  it('does not fail a heartbeat when Redis progress caching is unavailable', async () => {
    const repository = {
      progress: vi.fn().mockResolvedValue(true),
    } as unknown as EffectExtractionRepository;
    const progress = {
      set: vi.fn().mockRejectedValue(new Error('redis down')),
    } as unknown as JobProgressStore;
    const service = new EffectExtractionService(repository, projectService(), progress, storage);

    await expect(service.progress('project-a', 'run-a', 'attempt-a', 45, 'IMAGE')).resolves.toEqual(
      { accepted: true },
    );
  });

  it('replays an artifact upload idempotently without writing object storage again', async () => {
    const repository = {
      authorizedRun: vi.fn().mockResolvedValue({ inputSnapshot: {}, productId: 'product-a' }),
      artifactByKey: vi.fn().mockResolvedValue({
        id: 'artifact-a',
        artifactKind: 'DOCLING_MARKDOWN',
        sourceId: 'material-a',
        storageKey: 'stored/doc.md',
        sizeBytes: 42,
      }),
    } as unknown as EffectExtractionRepository;
    const storagePort = { put: vi.fn(), delete: vi.fn() } as unknown as StoragePort;
    const service = new EffectExtractionService(
      repository,
      projectService(),
      {} as JobProgressStore,
      storagePort,
    );

    await expect(
      service.storeArtifact(
        'project-a',
        'run-a',
        'attempt-a',
        {
          artifactKind: 'DOCLING_MARKDOWN',
          sourceId: 'material-a',
          idempotencyKey: 'docling:material-a',
        },
        {
          path: 'Z:/missing-but-force-removable.md',
          originalname: 'result.md',
          mimetype: 'text/markdown',
          size: 42,
        },
      ),
    ).resolves.toEqual({
      artifactId: 'artifact-a',
      storageKey: 'stored/doc.md',
      sizeBytes: 42,
      replayed: true,
    });
    expect(storagePort.put).not.toHaveBeenCalled();
  });
});
