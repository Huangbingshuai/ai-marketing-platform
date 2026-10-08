// A write can complete while a prefetched read is still in flight. No response data is kept here.
let generation = 0;
let writes = 0;

export const readRequestGeneration = (): number => (writes > 0 ? -1 : generation);

export const trackApiWrite = async <T>(method: string, request: () => Promise<T>): Promise<T> => {
  if (method === 'GET' || method === 'HEAD') return request();
  generation++;
  writes++;
  try {
    return await request();
  } finally {
    writes--;
    generation++;
  }
};
