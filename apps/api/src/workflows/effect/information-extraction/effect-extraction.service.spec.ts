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
  branches: [
    {
      branch: 'DOCUMENT' as const,
      status: 'SUCCEEDED' as const,
      warnings: [],
      errorMessage: null,
    },
    {
      branch: 'IMAGE' as const,
      status: 'RUNNING' as const,
      warnings: [],
      errorMessage: null,
    },
  ],
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
    expect(result.run.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ nodeId: 'LOAD_AND_SNAPSHOT', status: 'SUCCEEDED' }),
        expect.objectContaining({ nodeId: 'DOCUMENT', status: 'SUCCEEDED' }),
        expect.objectContaining({ nodeId: 'IMAGE', status: 'RUNNING' }),
        expect.objectContaining({ nodeId: 'FUSION', status: 'PENDING' }),
      ]),
    );
  });

  it('maps an unfinished branch to failed without exposing its structured output', async () => {
    const repository = {
      run: vi.fn().mockResolvedValue({
        ...runRecord,
        status: 'FAILED',
        errorMessage: '模型响应不符合结构',
        branches: [
          {
            branch: 'NORMALIZATION',
            status: 'RUNNING',
            warnings: [],
            errorMessage: null,
            structuredOutput: { secret: 'must-not-leak' },
            textStorageKey: 'private/markdown.md',
          },
        ],
      }),
    } as unknown as EffectExtractionRepository;
    const service = new EffectExtractionService(
      repository,
      projectService(),
      { get: vi.fn().mockResolvedValue(null) } as unknown as JobProgressStore,
      storage,
    );

    const result = await service.run('project-a', 'run-a');

    expect(result.run.nodes.find((node) => node.nodeId === 'NORMALIZATION')).toMatchObject({
      status: 'FAILED',
      errorMessage: '模型响应不符合结构',
    });
    expect(JSON.stringify(result)).not.toContain('must-not-leak');
    expect(JSON.stringify(result)).not.toContain('private/markdown.md');
  });

  it('keeps the snapshot running after claim until a persisted branch starts', async () => {
    const repository = {
      run: vi.fn().mockResolvedValue({
        ...runRecord,
        currentNode: null,
        branches: [],
      }),
    } as unknown as EffectExtractionRepository;
    const service = new EffectExtractionService(
      repository,
      projectService(),
      { get: vi.fn().mockResolvedValue(null) } as unknown as JobProgressStore,
      storage,
    );

    const result = await service.run('project-a', 'run-a');

    expect(result.run.nodes[0]).toMatchObject({
      nodeId: 'LOAD_AND_SNAPSHOT',
      status: 'RUNNING',
    });
  });

  it('preserves partial, skipped and failed branch states and their public warnings', async () => {
    const warning = {
      code: 'SOURCE_WARNING',
      message: '部分文档无法解析',
      branch: 'DOCUMENT' as const,
      sourceId: 'material-a',
      structuredOutput: { prompt: 'must-not-leak' },
      textStorageKey: 'private/source.md',
    };
    const repository = {
      run: vi.fn().mockResolvedValue({
        ...runRecord,
        branches: [
          {
            branch: 'DOCUMENT',
            status: 'PARTIAL',
            warnings: [warning],
            errorMessage: null,
          },
          {
            branch: 'COMMERCE',
            status: 'SKIPPED',
            warnings: [],
            errorMessage: null,
          },
          {
            branch: 'FORM',
            status: 'FAILED',
            warnings: [],
            errorMessage: '表单缺少产品名称或品类',
          },
        ],
      }),
    } as unknown as EffectExtractionRepository;
    const service = new EffectExtractionService(
      repository,
      projectService(),
      { get: vi.fn().mockResolvedValue(null) } as unknown as JobProgressStore,
      storage,
    );

    const result = await service.run('project-a', 'run-a');

    expect(result.run.nodes.find((node) => node.nodeId === 'DOCUMENT')).toMatchObject({
      status: 'PARTIAL',
      warnings: [
        {
          code: 'SOURCE_WARNING',
          message: '部分文档无法解析',
          branch: 'DOCUMENT',
          sourceId: 'material-a',
        },
      ],
    });
    expect(result.run.nodes.find((node) => node.nodeId === 'COMMERCE')).toMatchObject({
      status: 'SKIPPED',
    });
    expect(result.run.nodes.find((node) => node.nodeId === 'FORM')).toMatchObject({
      status: 'FAILED',
      errorMessage: '表单缺少产品名称或品类',
    });
    expect(JSON.stringify(result)).not.toContain('must-not-leak');
    expect(JSON.stringify(result)).not.toContain('private/source.md');
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
