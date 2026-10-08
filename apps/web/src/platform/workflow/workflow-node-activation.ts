/** Navigation is immediate; only the latest destination is synchronized in the background. */
export function createWorkflowNodeActivationQueue<T>(options: {
  activate: (target: T) => Promise<void>;
  isCurrent: (target: T) => boolean;
  onError: (error: unknown) => void;
  waitForRetry?: () => Promise<void>;
}) {
  let sequence = 0;
  let queue: Promise<void> = Promise.resolve();
  const invalidate = () => {
    sequence += 1;
  };
  const enqueue = (target: T) => {
    const request = ++sequence;
    const current = () => request === sequence && options.isCurrent(target);
    queue = queue
      .catch(() => undefined)
      .then(async () => {
        if (!current()) return;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            await options.activate(target);
            return;
          } catch (error) {
            if (!current()) return;
            if (attempt === 0) {
              await (options.waitForRetry?.() ??
                new Promise<void>((resolve) => globalThis.setTimeout(resolve, 600)));
              if (!current()) return;
            } else options.onError(error);
          }
        }
      });
  };
  const drain = async () => {
    invalidate();
    await queue.catch(() => undefined);
  };
  return { enqueue, invalidate, drain };
}
