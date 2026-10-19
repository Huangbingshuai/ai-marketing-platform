import { trackApiWrite } from './read-request-generation';
import { authGeneration, notifyAuthRequired } from './auth-events';

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? '/api';

export const apiUrl = (path: string): string => `${apiBaseUrl}${path}`;

type JsonRequestOptions = {
  body?: FormData | unknown;
  headers?: Record<string, string>;
  method?: 'DELETE' | 'GET' | 'PATCH' | 'POST' | 'PUT';
  operation?: string;
  signal?: AbortSignal | undefined;
  keepalive?: boolean;
};

type ApiErrorPayload = {
  code?: unknown;
  message?: unknown;
  requestId?: unknown;
};

export class ApiClientError extends Error {
  readonly code: string | undefined;
  readonly requestId: string | undefined;
  readonly status: number;

  constructor(message: string, status: number, payload: ApiErrorPayload = {}) {
    super(message);
    this.name = 'ApiClientError';
    this.status = status;
    this.code = typeof payload.code === 'string' ? payload.code : undefined;
    this.requestId = typeof payload.requestId === 'string' ? payload.requestId : undefined;
  }
}

/** Keep transport/validator details out of user-facing feedback. */
export const safeApiErrorMessage = (error: unknown, fallback: string): string => {
  if (!(error instanceof Error)) return fallback;
  if (error instanceof ApiClientError && error.status >= 500) return fallback;
  const message = error.message.trim();
  if (
    /\b(?:property\s+\S+\s+should not exist|\S+\s+must be\b|\S+\s+should not be empty)\b/iu.test(
      message,
    )
  )
    return '系统暂时无法处理当前请求，请重新加载后重试。';
  return /\p{Script=Han}/u.test(message) ? message : fallback;
};

const responsePayload = async (response: Response): Promise<ApiErrorPayload> => {
  try {
    return (await response.json()) as ApiErrorPayload;
  } catch {
    return {};
  }
};

const recoveryDelays = [250, 750, 1500, 2500] as const;
const waitForRecovery = (milliseconds: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const aborted = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', aborted);
      reject(signal?.reason ?? new DOMException('aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', aborted);
      resolve();
    }, milliseconds);
    signal?.addEventListener('abort', aborted, { once: true });
    if (signal?.aborted) aborted();
  });

/** Only read requests can be replayed across a short service restart. */
const fetchJsonResponse = async (url: string, init: RequestInit): Promise<Response> => {
  const canRetry = init.method === 'GET' && init.body === undefined && !init.keepalive;
  for (let attempt = 0; ; attempt++) {
    init.signal?.throwIfAborted();
    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (error) {
      if (
        !canRetry ||
        attempt >= recoveryDelays.length ||
        init.signal?.aborted ||
        !isNetworkError(error)
      )
        throw error;
      await waitForRecovery(recoveryDelays[attempt]!, init.signal ?? undefined);
      continue;
    }
    if (!canRetry || ![502, 503, 504].includes(response.status) || attempt >= recoveryDelays.length)
      return response;
    await response.body?.cancel().catch(() => undefined);
    await waitForRecovery(recoveryDelays[attempt]!, init.signal ?? undefined);
  }
};

export const requestJson = async <T>(
  path: string,
  {
    body,
    headers: customHeaders,
    method = 'GET',
    operation = '请求',
    signal,
    keepalive,
  }: JsonRequestOptions = {},
): Promise<T> => {
  const requestGeneration = authGeneration();
  const headers: Record<string, string> = { Accept: 'application/json', ...customHeaders };
  const isFormData = body instanceof FormData;
  if (body !== undefined && !isFormData && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await trackApiWrite(method, () =>
    fetchJsonResponse(apiUrl(path), {
      credentials: 'include',
      method,
      headers,
      ...(signal ? { signal } : {}),
      ...(keepalive ? { keepalive: true } : {}),
      ...(body === undefined ? {} : { body: isFormData ? body : JSON.stringify(body) }),
    }),
  );

  if (!response.ok) {
    const fallback = `${operation}失败（HTTP ${response.status}）`;
    const payload = await responsePayload(response);
    notifyAuthRequired(payload.code, requestGeneration);
    const message =
      typeof payload.message === 'string' && payload.message ? payload.message : fallback;
    throw new ApiClientError(message, response.status, payload);
  }

  return (await response.json()) as T;
};

export const requestRaw = async (
  path: string,
  {
    body,
    headers: customHeaders,
    method = 'GET',
    operation = '请求',
    signal,
    keepalive,
  }: JsonRequestOptions = {},
): Promise<Response> => {
  const requestGeneration = authGeneration();
  const headers: Record<string, string> = { ...customHeaders };
  const isFormData = body instanceof FormData;
  if (body !== undefined && !isFormData && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  const response = await trackApiWrite(method, () =>
    fetch(apiUrl(path), {
      credentials: 'include',
      method,
      headers,
      ...(signal ? { signal } : {}),
      ...(keepalive ? { keepalive: true } : {}),
      ...(body === undefined ? {} : { body: isFormData ? body : JSON.stringify(body) }),
    }),
  );
  if (!response.ok) {
    const fallback = `${operation}失败（HTTP ${response.status}）`;
    const payload = await responsePayload(response);
    notifyAuthRequired(payload.code, requestGeneration);
    const message =
      typeof payload.message === 'string' && payload.message ? payload.message : fallback;
    throw new ApiClientError(message, response.status, payload);
  }
  return response;
};

export const getJson = <T>(path: string, operation = '请求', signal?: AbortSignal): Promise<T> =>
  requestJson<T>(path, { operation, signal });

export const isAbortError = (error: unknown): boolean =>
  error instanceof DOMException && error.name === 'AbortError';

export const isNetworkError = (error: unknown): boolean =>
  error instanceof TypeError || (error instanceof DOMException && error.name === 'NetworkError');
