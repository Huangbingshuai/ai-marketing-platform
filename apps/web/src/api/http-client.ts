const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? '/api';

type JsonRequestOptions = {
  body?: unknown;
  method?: 'GET' | 'PATCH' | 'POST';
  operation?: string;
};

const responseMessage = async (response: Response, fallback: string): Promise<string> => {
  try {
    const payload = (await response.json()) as { message?: unknown };
    return typeof payload.message === 'string' && payload.message ? payload.message : fallback;
  } catch {
    return fallback;
  }
};

export const requestJson = async <T>(
  path: string,
  { body, method = 'GET', operation = '请求' }: JsonRequestOptions = {},
): Promise<T> => {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const response = await fetch(`${apiBaseUrl}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  if (!response.ok) {
    const fallback = `${operation}失败（HTTP ${response.status}）`;
    throw new Error(await responseMessage(response, fallback));
  }

  return (await response.json()) as T;
};

export const getJson = <T>(path: string, operation = '请求'): Promise<T> =>
  requestJson<T>(path, { operation });
