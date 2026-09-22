import type { PackagingExecution, PackagingItem } from '@ai-marketing/contracts';
import { PACKAGING_STAGES } from '@ai-marketing/contracts';

export function packagingExecution(
  items: PackagingItem[],
  startedAt: Date | null,
  completedAt: Date | null,
  status: string,
  concurrency = 4,
  now = Date.now(),
): PackagingExecution {
  const terminal = !['QUEUED', 'RUNNING'].includes(status);
  const elapsed = startedAt
    ? Math.max(0, ((completedAt?.getTime() ?? now) - startedAt.getTime()) / 1000)
    : 0;
  const completed = items.filter((i) => i.status === 'COMPLETED');
  // A rolling completion interval includes slow in-flight work; do not extrapolate only fast items.
  const windowStart = Math.max(startedAt?.getTime() ?? now, now - 300_000);
  const recent = completed.filter((i) => i.completedAt && Date.parse(i.completedAt) >= windowStart);
  const observed = recent.length >= 2 && now > windowStart;
  const stalled = !terminal && elapsed > 160 && !recent.length;
  const rate = observed ? (recent.length * 60_000) / (now - windowStart) : stalled ? 0 : null;
  const pending = items.filter((i) => ['QUEUED', 'RUNNING'].includes(i.status)).length;
  const estimate =
    terminal || stalled
      ? null
      : rate
        ? Math.ceil((pending / rate) * 60)
        : Math.ceil(pending / Math.max(1, Math.min(4, concurrency))) * 80;
  return {
    progressPercent: items.length
      ? Math.floor(
          (items.reduce(
            (sum, i) =>
              sum +
              (i.status === 'COMPLETED'
                ? PACKAGING_STAGES.length
                : Math.max(0, PACKAGING_STAGES.indexOf(i.stage))),
            0,
          ) /
            (items.length * PACKAGING_STAGES.length)) *
            100,
        )
      : 0,
    queued: items.filter((i) => i.status === 'QUEUED').length,
    running: items.filter((i) => i.status === 'RUNNING').length,
    completed: completed.length,
    elapsedSeconds: Math.round(elapsed),
    throughputPerMinute: rate,
    estimatedRemainingSeconds: estimate,
    estimateBasis: terminal ? 'TERMINAL' : observed ? 'OBSERVED' : 'BASELINE',
    delayed:
      items.some((i) => i.status === 'FAILED') ||
      (!terminal && elapsed + (estimate ?? 0) > 2100) ||
      stalled,
    shards: [...new Set(items.map((i) => i.shardIndex))]
      .sort((a, b) => a - b)
      .map((index) => {
        const rows = items.filter((i) => i.shardIndex === index);
        return {
          index,
          total: rows.length,
          completed: rows.filter((i) => i.status === 'COMPLETED').length,
          running: rows.filter((i) => i.status === 'RUNNING').length,
          failed: rows.filter((i) => ['FAILED', 'CANCELLED'].includes(i.status)).length,
        };
      }),
  };
}
