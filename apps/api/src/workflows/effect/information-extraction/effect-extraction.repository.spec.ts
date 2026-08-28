import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../../database/prisma.service';
import { EffectExtractionRepository } from './effect-extraction.repository';

const runRecord = (overrides: Record<string, unknown> = {}) => ({
  id: '00000000-0000-4000-8000-000000000101',
  projectId: '00000000-0000-4000-8000-000000000201',
  draftId: '00000000-0000-4000-8000-000000000301',
  productId: '00000000-0000-4000-8000-000000000401',
  requestRevision: 3,
  idempotencyKey: 'click-1',
  requestHash: 'hash',
  sourceFingerprint: 'fingerprint',
  inputSnapshot: {},
  status: 'QUEUED',
  progress: 0,
  currentNode: null,
  warnings: [],
  errorCode: null,
  errorMessage: null,
  attemptCount: 0,
  attemptToken: null,
  leaseExpiresAt: null,
  startedAt: null,
  heartbeatAt: null,
  completedAt: null,
  createdAt: new Date('2026-08-21T00:00:00.000Z'),
  updatedAt: new Date('2026-08-21T00:00:00.000Z'),
  ...overrides,
});

describe('EffectExtractionRepository isolation and idempotency', () => {
  it('scopes run lookup by projectId and runId', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const repository = new EffectExtractionRepository({
      effectExtractionRun: { findFirst },
    } as unknown as PrismaService);

    await repository.run('project-a', 'run-a');

    expect(findFirst).toHaveBeenCalledWith({
      where: { projectId: 'project-a', id: 'run-a' },
      include: { result: true, branches: { orderBy: { createdAt: 'asc' } } },
    });
  });

  it('uses project and revision for optimistic result updates', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const repository = new EffectExtractionRepository({
      effectExtractionResult: { updateMany },
    } as unknown as PrismaService);

    await expect(
      repository.updateResult('project-a', 'result-a', 2, {} as never, {}),
    ).resolves.toBeNull();
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { projectId: 'project-a', id: 'result-a', revision: 2 } }),
    );
  });

  it('replays the same idempotent request without locking or creating a second run', async () => {
    const request = {
      projectId: '00000000-0000-4000-8000-000000000201',
      draftId: '00000000-0000-4000-8000-000000000301',
      productId: '00000000-0000-4000-8000-000000000401',
      expectedRevision: 3,
      refreshImageRecognition: false,
    };
    const { canonicalHash } = await import('./effect-extraction.validation');
    const existing = runRecord({ requestHash: canonicalHash(request) });
    const queryRaw = vi.fn();
    const transaction = {
      effectExtractionRun: { findUnique: vi.fn().mockResolvedValue(existing) },
      $queryRaw: queryRaw,
    };
    const repository = new EffectExtractionRepository({
      $transaction: (callback: (client: typeof transaction) => unknown) => callback(transaction),
    } as unknown as PrismaService);

    const result = await repository.startRun(
      request.projectId,
      request.draftId,
      request.productId,
      request.expectedRevision,
      'click-1',
      request.refreshImageRecognition,
    );

    expect(result).toEqual({ kind: 'REPLAYED', run: existing });
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it('rejects reuse of an idempotency key for a different request', async () => {
    const transaction = {
      effectExtractionRun: {
        findUnique: vi.fn().mockResolvedValue(runRecord({ requestHash: 'different' })),
      },
    };
    const repository = new EffectExtractionRepository({
      $transaction: (callback: (client: typeof transaction) => unknown) => callback(transaction),
    } as unknown as PrismaService);

    await expect(
      repository.startRun(
        '00000000-0000-4000-8000-000000000201',
        '00000000-0000-4000-8000-000000000301',
        '00000000-0000-4000-8000-000000000401',
        4,
        'click-1',
      ),
    ).resolves.toEqual({ kind: 'KEY_CONFLICT' });
  });

  it('requires the current project-scoped lease when serving source material', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const repository = new EffectExtractionRepository({
      effectExtractionRun: { findFirst },
    } as unknown as PrismaService);

    await expect(
      repository.source('project-a', 'run-a', 'material-a', 'attempt-a'),
    ).resolves.toBeNull();
    expect(findFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({
        projectId: 'project-a',
        id: 'run-a',
        status: 'RUNNING',
        attemptToken: 'attempt-a',
      }),
    });
  });

  it('reads resumable branch outputs only after a project-scoped lease check', async () => {
    const repository = new EffectExtractionRepository({} as PrismaService);
    const authorized = vi.spyOn(repository, 'authorizedRun').mockResolvedValue(null);

    await expect(repository.branches('project-a', 'run-a', 'attempt-a')).resolves.toBeNull();
    expect(authorized).toHaveBeenCalledWith('project-a', 'run-a', 'attempt-a');
  });

  it('scopes artifact idempotency by project and run', async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    const repository = new EffectExtractionRepository({
      effectExtractionArtifact: { findUnique },
    } as unknown as PrismaService);

    await repository.artifactByKey('project-a', 'run-a', 'docling:material-a');

    expect(findUnique).toHaveBeenCalledWith({
      where: {
        projectId_runId_idempotencyKey: {
          projectId: 'project-a',
          runId: 'run-a',
          idempotencyKey: 'docling:material-a',
        },
      },
    });
  });

  it('reads image cache only after a project-scoped lease check and records the hit', async () => {
    const record = {
      id: 'cache-a',
      projectId: 'project-a',
      cacheKey: 'a'.repeat(64),
      candidate: { productName: '商品' },
      metadata: {},
    };
    const transaction = {
      effectExtractionRun: { count: vi.fn().mockResolvedValue(1) },
      effectExtractionImageCache: {
        findUnique: vi.fn().mockResolvedValue(record),
        update: vi.fn().mockResolvedValue(record),
      },
    };
    const repository = new EffectExtractionRepository({
      $transaction: (callback: (client: typeof transaction) => unknown) => callback(transaction),
    } as unknown as PrismaService);

    await expect(
      repository.imageCache('project-a', 'run-a', 'attempt-a', 'a'.repeat(64)),
    ).resolves.toEqual({ authorized: true, record });
    expect(transaction.effectExtractionRun.count).toHaveBeenCalledWith({
      where: expect.objectContaining({
        projectId: 'project-a',
        id: 'run-a',
        attemptToken: 'attempt-a',
      }),
    });
    expect(transaction.effectExtractionImageCache.findUnique).toHaveBeenCalledWith({
      where: { projectId_cacheKey: { projectId: 'project-a', cacheKey: 'a'.repeat(64) } },
    });
    expect(transaction.effectExtractionImageCache.update).toHaveBeenCalledWith({
      where: { id: 'cache-a' },
      data: { hitCount: { increment: 1 }, lastHitAt: expect.any(Date) },
    });
  });

  it('does not read or write image cache after the worker lease expires', async () => {
    const transaction = {
      effectExtractionRun: { count: vi.fn().mockResolvedValue(0) },
      effectExtractionImageCache: {
        findUnique: vi.fn(),
        update: vi.fn(),
        upsert: vi.fn(),
      },
    };
    const repository = new EffectExtractionRepository({
      $transaction: (callback: (client: typeof transaction) => unknown) => callback(transaction),
    } as unknown as PrismaService);

    await expect(
      repository.imageCache('project-a', 'run-a', 'attempt-a', 'b'.repeat(64)),
    ).resolves.toEqual({ authorized: false, record: null });
    await expect(
      repository.saveImageCache('project-a', 'run-a', 'attempt-a', {
        cacheKey: 'b'.repeat(64),
        candidate: {},
        metadata: {},
      }),
    ).resolves.toBe(false);
    expect(transaction.effectExtractionImageCache.findUnique).not.toHaveBeenCalled();
    expect(transaction.effectExtractionImageCache.upsert).not.toHaveBeenCalled();
  });

  it('upserts image cache by project and content-derived key', async () => {
    const transaction = {
      effectExtractionRun: { count: vi.fn().mockResolvedValue(1) },
      effectExtractionImageCache: { upsert: vi.fn().mockResolvedValue({ id: 'cache-a' }) },
    };
    const repository = new EffectExtractionRepository({
      $transaction: (callback: (client: typeof transaction) => unknown) => callback(transaction),
    } as unknown as PrismaService);
    const input = {
      cacheKey: 'c'.repeat(64),
      candidate: { productName: '商品' },
      metadata: { promptVersion: '4.0.0' },
    };

    await expect(repository.saveImageCache('project-a', 'run-a', 'attempt-a', input)).resolves.toBe(
      true,
    );
    expect(transaction.effectExtractionImageCache.upsert).toHaveBeenCalledWith({
      where: { projectId_cacheKey: { projectId: 'project-a', cacheKey: 'c'.repeat(64) } },
      create: expect.objectContaining({ projectId: 'project-a', cacheKey: 'c'.repeat(64) }),
      update: expect.objectContaining({ candidate: input.candidate, metadata: input.metadata }),
    });
  });
});
