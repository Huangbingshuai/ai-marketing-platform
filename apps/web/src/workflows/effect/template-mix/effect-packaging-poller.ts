/** One latest, bounded read. A stalled/late response must never freeze or rewind the graph. */
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
  function stop() {
    revision++;
    clearTimeout(timer);
    abort?.();
    abort = undefined;
    options.onLoading(false);
  }
  async function refresh() {
    stop();
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
        reject(new Error('读取包装进度超时，正在重新连接；下方保留上次读取结果。'));
      }, 15_000);
    });
    try {
      const data = await Promise.race([options.read(controller.signal), interrupted]);
      if (current === revision) options.onData(data);
    } catch (error) {
      if (current === revision) options.onError(error);
    } finally {
      clearTimeout(timeout);
      if (current === revision) {
        abort = undefined;
        options.onLoading(false);
        timer = setTimeout(() => void refresh(), options.interval());
      }
    }
  }
  return { refresh, stop };
}
