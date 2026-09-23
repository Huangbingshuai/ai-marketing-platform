import { describe, expect, it } from 'vitest';
import type { PackagingItem, PackagingSnapshot } from '@ai-marketing/contracts';
import { packagingShardIndexes } from '@ai-marketing/contracts';
import { packagingExecution, packagingPerformance } from './effect-packaging.metrics';

describe('server packaging throughput', () => {
  it('reports persisted measurements and does not count a batched script once per slot', () => {
    const items = [{ checkpoint: { timings: {
      _item: { scriptSeconds: 12, musicWaitSeconds: 20 },
      a: { scriptSeconds: 6, voiceSeconds: 2, cacheHit: true, localQueueSeconds: .5 },
      b: { scriptSeconds: 6, voiceSeconds: 4, cacheHit: false, preprocessingSeconds: 1 },
    } } }] as unknown as PackagingItem[];
    const result = packagingPerformance(items);
    expect(result.cacheHitRate).toBe(.5);
    expect(result.stages.scriptSeconds).toEqual({ samples: 1, p50Seconds: 12, p95Seconds: 12, totalSeconds: 12 });
    expect(result.stages.voiceSeconds?.p95Seconds).toBe(4);
    expect(result.stages.localQueueSeconds?.totalSeconds).toBe(.5);
    expect(packagingPerformance([]).cacheHitRate).toBeNull();
  });
  it.each([1, 10, 100])(
    'stable four-item shards for %i including long and fact-heavy inputs',
    (count) => {
      const snapshots = Array.from(
        { length: count },
        () => ({ duration: 3600, facts: ['x'.repeat(100000)] }) as unknown as PackagingSnapshot,
      );
      const shards = packagingShardIndexes(snapshots);
      expect(shards).toEqual(snapshots.map((_, i) => Math.floor(i / 4)));
      expect(new Set(shards).size).toBe(Math.ceil(count / 4));
    },
  );
  const rows = () =>
    Array.from(
      { length: 100 },
      (_, i) =>
        ({
          id: String(i),
          shardIndex: Math.floor(i / 4),
          status: 'QUEUED',
          completedAt: null,
        }) as PackagingItem,
    );
  it('initial target is 2000 seconds, explicitly an estimate', () => {
    expect(packagingExecution(rows(), null, null, 'QUEUED')).toMatchObject({
      queued: 100,
      estimatedRemainingSeconds: 2000,
      estimateBasis: 'BASELINE',
      throughputPerMinute: null,
    });
  });
  it('uses a short local baseline for subtitle-only work and ignores a failed attempt in its rate', () => {
    const items = rows();
    expect(packagingExecution(items, null, null, 'QUEUED', 4, 300_000, true).estimatedRemainingSeconds).toBe(200);
    for (const item of items.slice(0, 20)) {
      item.status = 'COMPLETED';
      item.completedAt = new Date(290_000).toISOString();
    }
    const result = packagingExecution(items, new Date(0), null, 'RUNNING', 4, 300_000, true);
    expect(result.estimatedRemainingSeconds).toBeLessThan(200);
    expect(result.estimateBasis).toBe('OBSERVED');
  });
  it('rolling observed slowdown reports delay instead of promising the target', () => {
    const items = rows();
    for (const i of items.slice(0, 4)) {
      i.status = 'COMPLETED';
      i.completedAt = new Date(300000).toISOString();
    }
    const result = packagingExecution(items, new Date(0), null, 'RUNNING', 4, 300000);
    expect(result.throughputPerMinute).toBe(0.8);
    expect(result.estimatedRemainingSeconds).toBe(7200);
    expect(result.delayed).toBe(true);
  });
  it('terminal failure does not report a fictitious completion time', () => {
    const items = rows();
    items[0]!.status = 'FAILED';
    expect(packagingExecution(items, new Date(0), new Date(1000), 'FAILED')).toMatchObject({
      estimateBasis: 'TERMINAL',
      estimatedRemainingSeconds: null,
      delayed: true,
    });
  });
  it('a stalled supplier removes the obsolete baseline ETA', () => {
    expect(packagingExecution(rows(), new Date(0), null, 'RUNNING', 4, 301000)).toMatchObject({
      estimatedRemainingSeconds: null,
      throughputPerMinute: 0,
      delayed: true,
    });
  });
});
