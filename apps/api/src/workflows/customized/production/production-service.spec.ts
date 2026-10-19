import { describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { CUSTOMIZED_IMAGE_MODELS } from '@ai-marketing/contracts';
import type { ProjectService } from '../../../platform/project/project.service';
import type { ProductionRepository } from './production.repository';
import { ProductionService } from './production.controller';

describe('independent asset image worker configuration', () => {
  const body = {
    workflowRunId: 'run',
    expectedRevision: 1,
    operation: 'IMAGE' as const,
    idempotencyKey: 'controlled-request',
    imageSettings: {
      model: CUSTOMIZED_IMAGE_MODELS[0].id,
      resolution: '2K' as const,
      ratio: '1:1' as const,
      assetIds: ['product'],
    },
  };
  it('creates the task without requiring the worker provider secret in the API process', async () => {
    const repository = { start: vi.fn().mockResolvedValue({ id: 'task' }) };
    const service = new ProductionService(
      repository as unknown as ProductionRepository,
      { get: vi.fn().mockResolvedValue({ id: 'project' }) } as unknown as ProjectService,
      new ConfigService({ CUSTOMIZED_ASSETS_WORKER_TOKEN: 'controlled-worker-token' }),
    );
    expect(await service.start('project', body)).toEqual({ id: 'task' });
    expect(repository.start).toHaveBeenCalledWith(
      'project',
      'run',
      1,
      'IMAGE',
      'controlled-request',
      null,
      expect.any(Object),
      null,
      body.imageSettings,
      { version: 2 },
    );
  });
  it('rejects a missing protected worker channel before enqueuing', async () => {
    const repository = { start: vi.fn() };
    const service = new ProductionService(
      repository as unknown as ProductionRepository,
      { get: vi.fn().mockResolvedValue({ id: 'project' }) } as unknown as ProjectService,
      new ConfigService({}),
    );
    await expect(service.start('project', body)).rejects.toThrow('资产Worker通道');
    expect(repository.start).not.toHaveBeenCalled();
  });
});
