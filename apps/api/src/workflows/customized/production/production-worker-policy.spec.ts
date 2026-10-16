import { describe, it, expect } from 'vitest';
import { ConfigService } from '@nestjs/config';
import type { ExecutionContext } from '@nestjs/common';
import {
  assertWorkerOperation,
  productionQueue,
  workerNodeForPath,
} from './production-worker-policy';
import { ProductionWorkerGuard } from './production.controller';

describe('one node per worker', () => {
  it('routes only assets to the new durable queue', () => {
    expect(productionQueue('ASSETS')).toBe('customized.assets.requested');
    expect(productionQueue('IMAGE')).toBe('customized.assets.requested');
    expect(() => assertWorkerOperation('IMAGE', 'VIDEO')).toThrow();
    expect(() => assertWorkerOperation('IMAGE', 'ASSETS')).not.toThrow();
    for (const op of ['SHOTS', 'PROMPT'] as const) {
      expect(productionQueue(op)).toBe('customized.production.requested');
      expect(() => assertWorkerOperation(op, 'ASSETS')).toThrow();
      expect(() => assertWorkerOperation(op, 'VIDEO')).not.toThrow();
    }
    expect(() => assertWorkerOperation('ASSETS', 'VIDEO')).toThrow();
    expect(() => assertWorkerOperation('ASSETS', 'ASSETS')).not.toThrow();
    expect(workerNodeForPath('/api/internal/workers/customized-assets/tasks/id/claim')).toBe(
      'ASSETS',
    );
    expect(workerNodeForPath('/internal/workers/customized-production/tasks/id/complete')).toBe(
      'VIDEO',
    );
    expect(workerNodeForPath('/internal/workers/customized-assets-unknown')).toBeUndefined();
  });
  it('rejects each other node credential and missing configuration', () => {
    const config = new ConfigService({
      CUSTOMIZED_ASSETS_WORKER_TOKEN: 'asset-secret',
      CUSTOMIZED_PRODUCTION_WORKER_TOKEN: 'video-secret',
    });
    const guard = new ProductionWorkerGuard(config);
    for (const [node, valid, invalid] of [
      ['assets', 'asset-secret', 'video-secret'],
      ['production', 'video-secret', 'asset-secret'],
    ]) {
      const request = {
        path: `/api/internal/workers/customized-${node}/tasks/id/claim`,
        headers: { 'x-worker-token': valid },
        workerNode: undefined,
      };
      const context = {
        switchToHttp: () => ({ getRequest: () => request }),
      } as unknown as ExecutionContext;
      expect(guard.canActivate(context)).toBe(true);
      expect(request.workerNode).toBe(node === 'assets' ? 'ASSETS' : 'VIDEO');
      request.headers['x-worker-token'] = invalid!;
      expect(() => guard.canActivate(context)).toThrow();
      expect(() => new ProductionWorkerGuard(new ConfigService()).canActivate(context)).toThrow();
    }
  });
});
