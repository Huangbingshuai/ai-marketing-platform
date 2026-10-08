import { describe, expect, it, vi } from 'vitest';
import { createWorkflowNodeActivationQueue } from './workflow-node-activation';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const settle = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

describe('shared effect and customized navigation synchronization', () => {
  it('keeps navigation non-blocking, serializes writes and skips superseded destinations', async () => {
    const first = deferred();
    const activate = vi.fn(async (step: number) => {
      if (step === 1) await first.promise;
    });
    const queue = createWorkflowNodeActivationQueue({
      activate,
      isCurrent: () => true,
      onError: vi.fn(),
    });
    queue.enqueue(1);
    await settle();
    queue.enqueue(2);
    queue.enqueue(3);
    expect(activate.mock.calls).toEqual([[1]]);
    first.resolve();
    await settle();
    expect(activate.mock.calls).toEqual([[1], [3]]);
  });

  it('retries the current destination once and reports only its final failure', async () => {
    const error = new Error('offline');
    const activate = vi.fn().mockRejectedValue(error);
    const onError = vi.fn();
    const queue = createWorkflowNodeActivationQueue({
      activate,
      isCurrent: () => true,
      onError,
      waitForRetry: async () => {},
    });
    queue.enqueue(4);
    await settle();
    expect(activate).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledExactlyOnceWith(error);
  });

  it('suppresses stale errors and retries after a newer node selection', async () => {
    const retry = deferred();
    const activate = vi.fn(async (step: number) => {
      if (step === 1) throw new Error('offline');
    });
    const onError = vi.fn();
    const queue = createWorkflowNodeActivationQueue({
      activate,
      isCurrent: () => true,
      onError,
      waitForRetry: () => retry.promise,
    });
    queue.enqueue(1);
    await settle();
    queue.enqueue(6);
    retry.resolve();
    await settle();
    expect(activate.mock.calls).toEqual([[1], [6]]);
    expect(onError).not.toHaveBeenCalled();
  });

  it('drains in-flight navigation before a branch switch and cancels queued old destinations', async () => {
    const first = deferred();
    const activate = vi.fn(async () => first.promise);
    const queue = createWorkflowNodeActivationQueue({
      activate,
      isCurrent: () => true,
      onError: vi.fn(),
    });
    queue.enqueue('old-run:source');
    await settle();
    queue.enqueue('old-run:storyboard');
    let drained = false;
    const drain = queue.drain().then(() => {
      drained = true;
    });
    await settle();
    expect(drained).toBe(false);
    first.resolve();
    await drain;
    expect(activate).toHaveBeenCalledExactlyOnceWith('old-run:source');
    expect(drained).toBe(true);
  });

  it('does not write after disposal or a context change', async () => {
    const activate = vi.fn(async () => {});
    const queue = createWorkflowNodeActivationQueue({
      activate,
      isCurrent: () => false,
      onError: vi.fn(),
    });
    queue.enqueue('other-project');
    await settle();
    expect(activate).not.toHaveBeenCalled();
    const valid = createWorkflowNodeActivationQueue({
      activate,
      isCurrent: () => true,
      onError: vi.fn(),
    });
    valid.enqueue('unmounted');
    valid.invalidate();
    await settle();
    expect(activate).not.toHaveBeenCalled();
  });
});
