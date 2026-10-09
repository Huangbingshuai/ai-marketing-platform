import { describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { RedisConnectionService } from '../../../platform/cache/redis-connection.service';
import type { StoragePort } from '../../../platform/file/storage.port';
import {
  artifactTemplateId,
  pruneDeletedTemplates,
  templateDeletionRuns,
} from '../../../platform/workflow/effect-template-deletion';
import { EffectTemplateDeletionCache } from './effect-template-deletion-cache.service';
import { EffectTemplateDeletionRepository } from './effect-template-deletion.repository';
import { EffectTemplateDeletionService } from './effect-template-deletion.service';

describe('template deletion boundaries', () => {
  it('matches identities at a complete key boundary, never names or similar ids', () => {
    expect(artifactTemplateId('timeline-project:a:film')).toBe('a');
    expect(artifactTemplateId('mix-template:a')).toBe('a');
    expect(artifactTemplateId('render-clip:a')).toBeNull();
    expect(artifactTemplateId('prefix:mix-template:a')).toBeNull();
    expect(artifactTemplateId('mix-template:aa')).not.toBe('a');
  });
  it('deletes the target branch and unpublished children, not other-template or upstream forks', () => {
    const rows = [
      { id: 'root', parentWorkflowRunId: null, forkNodeId: 'SEGMENT_RENDER', forkTemplateId: null },
      { id: 'a', parentWorkflowRunId: 'root', forkNodeId: 'TEMPLATE_MIX', forkTemplateId: 'a' },
      { id: 'pack', parentWorkflowRunId: 'a', forkNodeId: 'TEMPLATE_MIX', forkTemplateId: 'a' },
      {
        id: 'output',
        parentWorkflowRunId: 'pack',
        forkNodeId: 'FINAL_OUTPUT',
        forkTemplateId: null,
      },
      { id: 'b', parentWorkflowRunId: 'pack', forkNodeId: 'TEMPLATE_MIX', forkTemplateId: 'b' },
      { id: 'copy', parentWorkflowRunId: 'pack', forkNodeId: 'MANUAL_COPY', forkTemplateId: null },
      {
        id: 'edit',
        parentWorkflowRunId: 'pack',
        forkNodeId: 'SEGMENT_RENDER',
        forkTemplateId: null,
      },
    ];
    expect([...templateDeletionRuns(rows, 'a')]).toEqual(['a', 'pack', 'output']);
  });
  it('prunes navigation/config without touching another template or mutating the input', () => {
    const state = {
      templates: [{ id: 'a' }, { id: 'b' }],
      activeTemplateId: 'a',
      selectedTemplates: { a: 'now', b: 'before' },
    };
    expect(pruneDeletedTemplates(state, new Set(['a']))).toEqual({
      templates: [{ id: 'b' }],
      activeTemplateId: 'b',
      selectedTemplates: { b: 'before' },
    });
    expect(state.templates).toHaveLength(2);
  });
});

describe('durable background cleanup', () => {
  it('returns acceptance without waiting for files/cache', async () => {
    const repository = {
      enqueue: vi.fn().mockResolvedValue({ status: 'QUEUED' }),
      pending: vi.fn().mockResolvedValue([]),
    };
    const storage = { delete: vi.fn() };
    const cache = { clear: vi.fn() };
    const service = new EffectTemplateDeletionService(
      repository as unknown as EffectTemplateDeletionRepository,
      storage as unknown as StoragePort,
      cache as unknown as EffectTemplateDeletionCache,
    );
    expect(await service.remove('p', 'r', 'a', 3)).toEqual({ status: 'QUEUED' });
    expect(storage.delete).not.toHaveBeenCalled();
    expect(cache.clear).not.toHaveBeenCalled();
    service.onModuleDestroy();
  });
  it('releases the database phase without losing its persisted file list', async () => {
    const repository = {
      claim: vi.fn().mockResolvedValue({ phase: 'DATABASE' }),
      removeData: vi.fn(),
      releaseFiles: vi.fn(),
      finish: vi.fn(),
      retry: vi.fn(),
    };
    const service = new EffectTemplateDeletionService(
      repository as unknown as EffectTemplateDeletionRepository,
      {} as StoragePort,
      {} as EffectTemplateDeletionCache,
    );
    await service.cleanup('job');
    expect(repository.removeData).toHaveBeenCalled();
    expect(repository.releaseFiles).toHaveBeenCalled();
    expect(repository.finish).not.toHaveBeenCalled();
  });
  it('protects shared files and persists failures for retry without redoing database cleanup', async () => {
    const repository = {
      claim: vi.fn().mockResolvedValue({
        phase: 'FILES',
        projectId: 'p',
        storageKeys: ['owned', 'shared', 'failed'],
      }),
      unreferenced: vi.fn(async (key) => key !== 'shared'),
      finish: vi.fn(),
      retry: vi.fn(),
      removeData: vi.fn(),
    };
    const storage = {
      delete: vi.fn(async (key) => {
        if (key === 'failed') throw new Error('down');
      }),
    };
    const cache = { clear: vi.fn().mockRejectedValue(new Error('down')) };
    await new EffectTemplateDeletionService(
      repository as unknown as EffectTemplateDeletionRepository,
      storage as unknown as StoragePort,
      cache as unknown as EffectTemplateDeletionCache,
    ).cleanup('job');
    expect(storage.delete.mock.calls.map(([key]) => key)).toEqual(['owned', 'failed']);
    expect(repository.finish).toHaveBeenCalledWith('job', expect.any(String), ['failed'], false);
    expect(repository.removeData).not.toHaveBeenCalled();
  });
  it('invalidates only the effect projection namespace with incremental asynchronous unlink', async () => {
    const evalCall = vi.fn().mockResolvedValueOnce('12').mockResolvedValueOnce('0');
    const redis = { execute: vi.fn((operation) => operation({ eval: evalCall })) };
    const config = { get: () => 'test[cache]' };
    await new EffectTemplateDeletionCache(
      redis as unknown as RedisConnectionService,
      config as unknown as ConfigService,
    ).clear('project');
    expect(evalCall.mock.calls[0]![1].arguments).toEqual(['0', 'test\\[cache\\]:project:EFFECT:*']);
    expect(evalCall.mock.calls[1]![1].arguments[0]).toBe('12');
    expect(evalCall.mock.calls[0]![0]).toContain('UNLINK');
    expect(evalCall.mock.calls[0]![0]).not.toContain('FLUSH');
  });
});
