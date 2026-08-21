import type { ApiResponse } from '@ai-marketing/contracts';
import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

import { resolveRequestId } from './request-context';
import { SKIP_RESPONSE_ENVELOPE } from './raw-response.decorator';

@Injectable()
export class ResponseEnvelopeInterceptor<T> implements NestInterceptor<T, ApiResponse<T>> {
  constructor(private readonly reflector = new Reflector()) {}

  intercept(context: ExecutionContext, next: CallHandler<T>): Observable<ApiResponse<T>> {
    const requestId = resolveRequestId(context);
    const response = context
      .switchToHttp()
      .getResponse<{ setHeader(name: string, value: string): void }>();
    response.setHeader('x-request-id', requestId);

    if (
      this.reflector.getAllAndOverride<boolean>(SKIP_RESPONSE_ENVELOPE, [
        context.getHandler(),
        context.getClass(),
      ])
    ) {
      return next.handle() as Observable<ApiResponse<T>>;
    }

    return next.handle().pipe(
      map((data) => ({
        success: true,
        data,
        requestId,
      })),
    );
  }
}
