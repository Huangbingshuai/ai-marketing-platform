const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? '/api';

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

const responsePayload = async (response: Response): Promise<ApiErrorPayload> => {
  try {
    return (await response.json()) as ApiErrorPayload;
  } catch {
    return {};
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
  const headers: Record<string, string> = { Accept: 'application/json', ...customHeaders };
  const isFormData = body instanceof FormData;
  if (body !== undefined && !isFormData && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(`${apiBaseUrl}${path}`, {
    method,
    headers,
    ...(signal ? { signal } : {}),
    ...(keepalive ? { keepalive: true } : {}),
    ...(body === undefined ? {} : { body: isFormData ? body : JSON.stringify(body) }),
  });

  if (!response.ok) {
    const fallback = `${operation}失败（HTTP ${response.status}）`;
    const payload = await responsePayload(response);
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
  const headers: Record<string, string> = { ...customHeaders };
  const isFormData = body instanceof FormData;
  if (body !== undefined && !isFormData && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method,
    headers,
    ...(signal ? { signal } : {}),
    ...(keepalive ? { keepalive: true } : {}),
    ...(body === undefined ? {} : { body: isFormData ? body : JSON.stringify(body) }),
  });
  if (!response.ok) {
    const fallback = `${operation}失败（HTTP ${response.status}）`;
    const payload = await responsePayload(response);
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
