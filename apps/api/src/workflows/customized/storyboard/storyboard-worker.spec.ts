import { ConfigService } from '@nestjs/config';
import type { ExecutionContext } from '@nestjs/common';
import { expect, it } from 'vitest';
import { StoryboardWorkerGuard } from './storyboard-worker.controller';
const context = (token: unknown) =>
  ({
    switchToHttp: () => ({ getRequest: () => ({ headers: { 'x-worker-token': token } }) }),
  }) as ExecutionContext;
it('requires the dedicated worker credential', () => {
  const guard = new StoryboardWorkerGuard(
    new ConfigService({ CUSTOMIZED_STORYBOARD_WORKER_TOKEN: 'storyboard-test-token' }),
  );
  expect(guard.canActivate(context('storyboard-test-token'))).toBe(true);
  for (const token of [undefined, '', 'extraction-test-token', ['storyboard-test-token']])
    expect(() => guard.canActivate(context(token))).toThrow();
  expect(() => new StoryboardWorkerGuard(new ConfigService()).canActivate(context(''))).toThrow();
});
