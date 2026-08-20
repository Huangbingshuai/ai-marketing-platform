import { randomUUID } from 'node:crypto';

import type { ExecutionContext } from '@nestjs/common';

type HeaderValue = string | string[] | undefined;

export const resolveRequestId = (context: ExecutionContext): string => {
  const request = context.switchToHttp().getRequest<{ headers: Record<string, HeaderValue> }>();
  const incoming = request.headers['x-request-id'];
  const candidate = Array.isArray(incoming) ? incoming[0] : incoming;

  return candidate && candidate.length <= 128 ? candidate : randomUUID();
};
