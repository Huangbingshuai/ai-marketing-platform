import { isAbortError } from '../../api/http-client';

export const PROJECT_LOAD_RETRY_DELAYS_MS = [300, 700, 1_500, 3_000, 5_000] as const;

type RetryableHttpError = {
  status?: unknown;
};

const abortError = (): DOMException => new DOMException('项目加载已取消', 'AbortError');

export const isRetryableProjectLoadError = (error: unknown): boolean => {
  if (isAbortError(error)) return false;
  if (error instanceof TypeError) return true;
  const status = (error as RetryableHttpError | null)?.status;
  return (
    typeof status === 'number' &&
    (status === 408 || status === 425 || status === 429 || status >= 500)
  );
};

const waitForRetry = (delayMs: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', handleAbort);
      resolve();
    }, delayMs);
    const handleAbort = (): void => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal.addEventListener('abort', handleAbort, { once: true });
  });

type ProjectLoadRetryOptions = {
  delays?: readonly number[];
  wait?: (delayMs: number, signal: AbortSignal) => Promise<void>;
};

export const loadProjectListWithRetry = async <T>(
  request: () => Promise<T>,
  signal: AbortSignal,
  { delays = PROJECT_LOAD_RETRY_DELAYS_MS, wait = waitForRetry }: ProjectLoadRetryOptions = {},
): Promise<T> => {
  let retryIndex = 0;
  while (true) {
    if (signal.aborted) throw abortError();
    try {
      return await request();
    } catch (error) {
      if (!isRetryableProjectLoadError(error) || retryIndex >= delays.length) throw error;
      await wait(delays[retryIndex]!, signal);
      retryIndex += 1;
    }
  }
};
