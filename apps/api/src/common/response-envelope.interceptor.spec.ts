import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { firstValueFrom, of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';

import { AssetController } from '../platform/asset/asset.controller';
import { ResponseEnvelopeInterceptor } from './response-envelope.interceptor';

describe('ResponseEnvelopeInterceptor raw responses', () => {
  it('keeps raw content unwrapped while applying x-request-id', async () => {
    const setHeader = vi.fn();
    const context = {
      getHandler: () => AssetController.prototype.content,
      getClass: () => AssetController,
      switchToHttp: () => ({
        getRequest: () => ({ headers: { 'x-request-id': 'request-asset-content' } }),
        getResponse: () => ({ setHeader }),
      }),
    } as unknown as ExecutionContext;
    const interceptor = new ResponseEnvelopeInterceptor(new Reflector());

    const result = await firstValueFrom(
      interceptor.intercept(context, { handle: () => of('raw-bytes') } as CallHandler<string>),
    );

    expect(result).toBe('raw-bytes');
    expect(setHeader).toHaveBeenCalledWith('x-request-id', 'request-asset-content');
  });
});
