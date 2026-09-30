import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';

import { EffectTemplateMixWorkerController } from './effect-template-mix-worker.controller';
import type { EffectTemplateMixService } from './effect-template-mix.service';
import type { EffectTemplateMixCompletionService } from './effect-template-mix-completion.service';
import {
  EffectTemplateMixWorkerClassificationDto,
  EffectTemplateMixWorkerCompleteDto,
  EffectTemplateMixWorkerFailDto,
  EffectTemplateMixWorkerProgressDto,
  EffectTemplateMixWorkerProjectDto,
} from './dto/effect-template-mix.dto';

describe('EffectTemplateMixWorkerController validation metadata', () => {
  it.each([
    ['claim', 1, EffectTemplateMixWorkerProjectDto],
    ['progress', 2, EffectTemplateMixWorkerProgressDto],
    ['classify', 2, EffectTemplateMixWorkerClassificationDto],
    ['checkpointClassifications', 2, EffectTemplateMixWorkerClassificationDto],
    ['checkpointTrims', 2, EffectTemplateMixWorkerCompleteDto],
    ['complete', 2, EffectTemplateMixWorkerCompleteDto],
    ['fail', 2, EffectTemplateMixWorkerFailDto],
    ['material', 3, EffectTemplateMixWorkerProjectDto],
  ] as const)('%s retains its DTO at parameter %i', (method, index, dto) => {
    const paramTypes = Reflect.getMetadata(
      'design:paramtypes',
      EffectTemplateMixWorkerController.prototype,
      method,
    ) as unknown[];
    expect(paramTypes[index]).toBe(dto);
  });
});

describe('smart-fill completion routing', () => {
  it('passes the worker result to the completion coordinator', async () => {
    const completion = { complete: vi.fn().mockResolvedValue({ status: 'COMPLETED' }) };
    const controller = new EffectTemplateMixWorkerController(
      {} as EffectTemplateMixService,
      completion as unknown as EffectTemplateMixCompletionService,
    );
    await controller.complete('project', 'token', {
      projectId: 'project', trims: [],
    } as EffectTemplateMixWorkerCompleteDto);
    expect(completion.complete).toHaveBeenCalledWith('project', 'project', 'token', []);
  });
});
