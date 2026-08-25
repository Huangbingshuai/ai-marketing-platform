import { UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { EffectPromptWorkerGuard } from './effect-prompt-worker.guard';

const context = (token?: string): ExecutionContext =>
  ({
    switchToHttp: () => ({
      getRequest: () => ({ headers: token ? { 'x-worker-token': token } : {} }),
    }),
  }) as ExecutionContext;

describe('EffectPromptWorkerGuard', () => {
  it('accepts the dedicated prompt worker token', () => {
    const guard = new EffectPromptWorkerGuard({
      get: () => 'prompt-secret',
    } as never);
    expect(guard.canActivate(context('prompt-secret'))).toBe(true);
  });

  it('rejects missing or mismatched tokens', () => {
    const guard = new EffectPromptWorkerGuard({
      get: () => 'prompt-secret',
    } as never);
    expect(() => guard.canActivate(context())).toThrow(UnauthorizedException);
    expect(() => guard.canActivate(context('other-secret'))).toThrow(UnauthorizedException);
  });
});
