import { rm } from 'node:fs/promises';

import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import type { Observable } from 'rxjs';
import { finalize } from 'rxjs/operators';

type RequestWithTemporaryFile = {
  file?: { path?: string };
  files?: Array<{ path?: string }>;
};

@Injectable()
export class UploadTemporaryFileCleanupInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<RequestWithTemporaryFile>();
    return next.handle().pipe(
      finalize(() => {
        const paths = [request.file, ...(request.files ?? [])]
          .map((file) => file?.path)
          .filter((path): path is string => Boolean(path));
        paths.forEach((path) => void rm(path, { force: true }).catch(() => undefined));
      }),
    );
  }
}
