import { isAbortError } from '../../api/http-client';

export const PROJECT_LOAD_RETRY_DELAYS_MS = [300, 700, 1_500] as const;
export const PROJECT_LOAD_ATTEMPT_TIMEOUT_MS = 4_000;

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
  attemptTimeoutMs?: number;
  delays?: readonly number[];
  wait?: (delayMs: number, signal: AbortSignal) => Promise<void>;
};

const runAttempt = <T>(
  request: (signal: AbortSignal) => Promise<T>,
  parentSignal: AbortSignal,
  timeoutMs: number,
): Promise<T> =>
  new Promise((resolve, reject) => {
    const controller = new AbortController();
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = (): void => {
      if (timer) clearTimeout(timer);
      parentSignal.removeEventListener('abort', handleParentAbort);
    };
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const handleParentAbort = (): void => {
      controller.abort(parentSignal.reason);
      finish(() => reject(abortError()));
    };

    parentSignal.addEventListener('abort', handleParentAbort, { once: true });
    if (parentSignal.aborted) {
      handleParentAbort();
      return;
    }
    timer = setTimeout(() => {
      controller.abort();
      finish(() => reject(new TypeError('项目列表请求超时')));
    }, timeoutMs);

    request(controller.signal).then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });

export const loadProjectListWithRetry = async <T>(
  request: (signal: AbortSignal) => Promise<T>,
  signal: AbortSignal,
  {
    attemptTimeoutMs = PROJECT_LOAD_ATTEMPT_TIMEOUT_MS,
    delays = PROJECT_LOAD_RETRY_DELAYS_MS,
    wait = waitForRetry,
  }: ProjectLoadRetryOptions = {},
): Promise<T> => {
  let retryIndex = 0;
  while (true) {
    if (signal.aborted) throw abortError();
    try {
      return await runAttempt(request, signal, attemptTimeoutMs);
    } catch (error) {
      if (signal.aborted) throw abortError();
      if (!isRetryableProjectLoadError(error) || delays.length === 0) throw error;
      if (retryIndex >= delays.length) throw error;
      const delay = delays[retryIndex]!;
      await wait(delay, signal);
      retryIndex += 1;
    }
  }
};
