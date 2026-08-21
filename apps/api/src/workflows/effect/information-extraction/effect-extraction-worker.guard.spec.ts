import type { ExecutionContext } from '@nestjs/common';
import { UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';

import { EffectExtractionWorkerGuard } from './effect-extraction-worker.guard';

const context = (token?: string): ExecutionContext =>
  ({
    switchToHttp: () => ({
      getRequest: () => ({ headers: token ? { 'x-worker-token': token } : {} }),
    }),
  }) as unknown as ExecutionContext;

describe('EffectExtractionWorkerGuard', () => {
  it('requires the configured EFFECT_EXTRACTION_WORKER_TOKEN', () => {
    const guard = new EffectExtractionWorkerGuard({
      get: (key: string) =>
        key === 'EFFECT_EXTRACTION_WORKER_TOKEN' ? 'worker-secret' : undefined,
    } as ConfigService);

    expect(guard.canActivate(context('worker-secret'))).toBe(true);
    expect(() => guard.canActivate(context('wrong'))).toThrow(UnauthorizedException);
    expect(() => guard.canActivate(context())).toThrow(UnauthorizedException);
  });

  it('fails closed when the worker token is not configured', () => {
    const guard = new EffectExtractionWorkerGuard({
      get: () => undefined,
    } as unknown as ConfigService);
    expect(() => guard.canActivate(context('anything'))).toThrow(UnauthorizedException);
  });
});
