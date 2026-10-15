import { describe, expect, it, vi } from 'vitest';
import { createEffectRunRefreshQueue } from './effect-run-refresh';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe('effect Run refresh notifications', () => {
  it('keeps the latest completion notification and drops a late edit Run read', async () => {
    const started = deferred();
    const read = deferred();
    const applied: string[] = [];
    const refresh = vi.fn(async (run: string, isCurrent: () => boolean) => {
      if (run === 'edit') {
        started.resolve();
        await read.promise;
      }
      if (isCurrent()) applied.push(run);
    });
    const queue = createEffectRunRefreshQueue(refresh);
    const editing = queue.request('edit');
    await started.promise;
    const intermediate = queue.request('intermediate');
    const completion = queue.request('original-after-commit');
    read.resolve();
    await Promise.all([editing, intermediate, completion]);
    expect(refresh.mock.calls.map(([run]) => run)).toEqual(['edit', 'original-after-commit']);
    expect(applied).toEqual(['original-after-commit']);
  });

  it('re-reads the same Run on consecutive updates rather than treating it as unchanged', async () => {
    const refresh = vi.fn(async () => undefined);
    const queue = createEffectRunRefreshQueue(refresh);
    await queue.request('original');
    await queue.request('original');
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('invalidates in-flight and queued reads on unmount and permits a new project', async () => {
    const started = deferred();
    const read = deferred();
    const applied: string[] = [];
    const queue = createEffectRunRefreshQueue(async (project: string, isCurrent) => {
      started.resolve();
      await read.promise;
      if (isCurrent()) applied.push(project);
    });
    const old = queue.request('project-a');
    await started.promise;
    const queued = queue.request('project-a-later');
    queue.invalidate();
    read.resolve();
    await Promise.all([old, queued]);
    expect(applied).toEqual([]);
    await queue.request('project-b');
    expect(applied).toEqual(['project-b']);
  });

  it('recovers on the next notification after a failed read', async () => {
    const refresh = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValue(undefined);
    const queue = createEffectRunRefreshQueue(refresh);
    await expect(queue.request('failed')).rejects.toThrow('temporary');
    await queue.request('retry');
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});
