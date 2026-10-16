export const waitForTaskPoll = (duration: number, signal?: AbortSignal): Promise<void> => {
  if (signal?.aborted) return Promise.reject(new DOMException('任务查询已取消', 'AbortError'));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('任务查询已取消', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, duration);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
};
export async function pollAsyncTask<T>(
  load: (signal?: AbortSignal) => Promise<T>,
  terminal: (task: T) => boolean,
  options: {
    intervalMs?: number | undefined;
    signal?: AbortSignal | undefined;
    onUpdate?: ((task: T) => void) | undefined;
    retryDelayMs?: ((error: unknown, failures: number) => number | null) | undefined;
  } = {},
): Promise<T> {
  let failures = 0;
  for (;;) {
    options.signal?.throwIfAborted();
    let task: T;
    try {
      task = await load(options.signal);
    } catch (error) {
      options.signal?.throwIfAborted();
      const delay = options.retryDelayMs?.(error, ++failures);
      if (delay == null) throw error;
      await waitForTaskPoll(delay, options.signal);
      continue;
    }
    failures = 0;
    options.signal?.throwIfAborted();
    options.onUpdate?.(task);
    if (terminal(task)) return task;
    await waitForTaskPoll(options.intervalMs ?? 1200, options.signal);
  }
}
