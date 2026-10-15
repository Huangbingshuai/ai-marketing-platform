/** One latest, bounded read. A stalled/late response must never freeze or rewind the graph. */
const MAX_ERROR_BACKOFF_MS = 30_000;

export function createPackagingPoller<T>(options: {
  read: (signal: AbortSignal) => Promise<T>;
  onData: (data: T) => void;
  onError: (error: unknown) => void;
  onLoading: (loading: boolean) => void;
  interval: () => number;
}) {
  let revision = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  let consecutiveErrors = 0;
  function stop(resetBackoff = true) {
    revision++;
    clearTimeout(timer);
    abort?.();
    abort = undefined;
    if (resetBackoff) consecutiveErrors = 0;
    options.onLoading(false);
  }
  async function refresh() {
    // A new read supersedes the previous one but keeps its consecutive failure
    // count so repeated network outages back off instead of hammering the API.
    stop(false);
    const current = revision;
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    options.onLoading(true);
    const interrupted = new Promise<never>((_, reject) => {
      abort = () => {
        clearTimeout(timeout);
        controller.abort();
        reject(new Error('读取已取消'));
      };
      timeout = setTimeout(() => {
        controller.abort();
        reject(new Error('读取包装状态超时'));
      }, 15_000);
    });
    try {
      const data = await Promise.race([options.read(controller.signal), interrupted]);
      if (current === revision) {
        consecutiveErrors = 0;
        options.onData(data);
      }
    } catch (error) {
      if (current === revision) {
        consecutiveErrors++;
        options.onError(error);
      }
    } finally {
      clearTimeout(timeout);
      if (current === revision) {
        abort = undefined;
        options.onLoading(false);
        const baseInterval = Math.max(0, options.interval());
        const backoff = consecutiveErrors
          ? Math.min(baseInterval * 2 ** (consecutiveErrors - 1), MAX_ERROR_BACKOFF_MS)
          : baseInterval;
        timer = setTimeout(() => void refresh(), backoff);
      }
    }
  }
  return { refresh, stop };
}
