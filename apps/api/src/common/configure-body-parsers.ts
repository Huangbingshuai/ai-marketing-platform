import type { NestExpressApplication } from '@nestjs/platform-express';

/** Large mix drafts include multiple films and their frozen material/packaging snapshots. */
export function configureBodyParsers(app: NestExpressApplication): void {
  // Keep the larger allowance scoped to the draft save; other JSON endpoints retain 2 MB.
  app.useBodyParser('json', {
    limit: '16mb',
    type: (request) =>
      request.method === 'PUT' &&
      /^\/api\/projects\/[^/]+\/workflows\/effect\/template-mix\/draft(?:\?|$)/.test(
        request.url ?? '',
      ) &&
      request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() === 'application/json',
  });
  app.useBodyParser('json', { limit: '2mb' });
}
