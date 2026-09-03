import { UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { EffectSegmentRenderWorkerGuard } from './effect-segment-render-worker.guard';

const context = (token?: string): ExecutionContext =>
  ({
    switchToHttp: () => ({
      getRequest: () => ({ headers: token ? { 'x-worker-token': token } : {} }),
    }),
  }) as ExecutionContext;

describe('EffectSegmentRenderWorkerGuard', () => {
  it('accepts only the dedicated segment-render worker token', () => {
    const guard = new EffectSegmentRenderWorkerGuard({
      get: () => 'segment-secret',
    } as never);

    expect(guard.canActivate(context('segment-secret'))).toBe(true);
    expect(() => guard.canActivate(context())).toThrow(UnauthorizedException);
    expect(() => guard.canActivate(context('other-secret'))).toThrow(UnauthorizedException);
  });
});
