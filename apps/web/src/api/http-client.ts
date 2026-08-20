const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? '/api';

export const getJson = async <T>(path: string, operation = '请求'): Promise<T> => {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    headers: { Accept: 'application/json' },
  });

  if (!response.ok) {
    throw new Error(`${operation}失败（HTTP ${response.status}）`);
  }

  return (await response.json()) as T;
};
