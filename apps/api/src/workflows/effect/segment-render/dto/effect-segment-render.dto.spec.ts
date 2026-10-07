import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { SegmentRenderWorkerCompleteDto } from './effect-segment-render.dto';

describe('render media duration callback', () => {
  const callback = {
    projectId: '11111111-1111-4111-8111-111111111111',
    taskVersion: 1,
    providerTaskId: 'provider-task',
  };
  it('accepts fractional measured duration independently of floored provider duration', () => {
    const dto = plainToInstance(SegmentRenderWorkerCompleteDto, {
      ...callback,
      duration: '14',
      actualDuration: '14.9',
    });
    expect(validateSync(dto, { whitelist: true, forbidNonWhitelisted: true })).toEqual([]);
    expect(dto.actualDuration).toBe(14.9);
  });
  it.each(['NaN', 'Infinity', '0', '32'])(
    'rejects invalid measured duration %s',
    (actualDuration) => {
      const dto = plainToInstance(SegmentRenderWorkerCompleteDto, { ...callback, actualDuration });
      expect(validateSync(dto).some((issue) => issue.property === 'actualDuration')).toBe(true);
    },
  );
  it('accepts old callbacks without measured duration', () => {
    expect(validateSync(plainToInstance(SegmentRenderWorkerCompleteDto, callback))).toEqual([]);
  });
});
