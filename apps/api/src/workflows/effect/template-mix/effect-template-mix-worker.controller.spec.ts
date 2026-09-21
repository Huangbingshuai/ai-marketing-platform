import 'reflect-metadata';
import { describe, expect, it } from 'vitest';

import { EffectTemplateMixWorkerController } from './effect-template-mix-worker.controller';
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
