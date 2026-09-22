import { describe, expect, it } from 'vitest';
import type { PackagingItem, PackagingSnapshot } from '@ai-marketing/contracts';
import { packagingShardIndexes } from '@ai-marketing/contracts';
import { packagingExecution } from './effect-packaging.metrics';

describe('server packaging throughput', () => {
  it.each([1, 10, 100])('stable four-item shards for %i including long and fact-heavy inputs', (count) => {
    const snapshots = Array.from({ length: count }, () => ({ duration: 3600, facts: ['x'.repeat(100000)] }) as unknown as PackagingSnapshot);
    const shards = packagingShardIndexes(snapshots);
    expect(shards).toEqual(snapshots.map((_, i) => Math.floor(i / 4)));
    expect(new Set(shards).size).toBe(Math.ceil(count / 4));
  });
  const rows = () => Array.from({ length: 100 }, (_, i) => ({ id: String(i), shardIndex: Math.floor(i / 4), status: 'QUEUED', completedAt: null }) as PackagingItem);
  it('initial target is 2000 seconds, explicitly an estimate', () => {
    expect(packagingExecution(rows(), null, null, 'QUEUED')).toMatchObject({ queued: 100, estimatedRemainingSeconds: 2000, estimateBasis: 'BASELINE', throughputPerMinute: null });
  });
  it('rolling observed slowdown reports delay instead of promising the target', () => {
    const items = rows();
    for (const i of items.slice(0, 4)) { i.status = 'COMPLETED'; i.completedAt = new Date(300000).toISOString(); }
    const result = packagingExecution(items, new Date(0), null, 'RUNNING', 4, 300000);
    expect(result.throughputPerMinute).toBe(.8);
    expect(result.estimatedRemainingSeconds).toBe(7200);
    expect(result.delayed).toBe(true);
  });
  it('terminal failure does not report a fictitious completion time', () => {
    const items = rows(); items[0]!.status = 'FAILED';
    expect(packagingExecution(items, new Date(0), new Date(1000), 'FAILED')).toMatchObject({ estimateBasis: 'TERMINAL', estimatedRemainingSeconds: null, delayed: true });
  });
});
