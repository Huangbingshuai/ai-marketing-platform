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
  } = {},
): Promise<T> {
  for (;;) {
    options.signal?.throwIfAborted();
    const task = await load(options.signal);
    options.signal?.throwIfAborted();
    options.onUpdate?.(task);
    if (terminal(task)) return task;
    await waitForTaskPoll(options.intervalMs ?? 1200, options.signal);
  }
}
