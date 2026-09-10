type EffectWorkspacePrefetchEntry = {
  createdAt: number;
  promise: Promise<unknown>;
};

export type EffectWorkspaceSnapshot<T> = {
  data: T;
  prefetched: boolean;
};

const EFFECT_WORKSPACE_PREFETCH_TTL_MS = 5_000;
const entries = new Map<string, EffectWorkspacePrefetchEntry>();

const abortError = (): DOMException => new DOMException('工作区加载已取消', 'AbortError');

const waitForSharedPromise = <T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> => {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort);
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
};

const currentEntry = (key: string): EffectWorkspacePrefetchEntry | undefined => {
  const entry = entries.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.createdAt <= EFFECT_WORKSPACE_PREFETCH_TTL_MS) return entry;
  entries.delete(key);
  return undefined;
};

export const prefetchEffectWorkspace = <T>(key: string, loader: () => Promise<T>): Promise<T> => {
  const existing = currentEntry(key);
  if (existing) return existing.promise as Promise<T>;

  const entry: EffectWorkspacePrefetchEntry = {
    createdAt: Date.now(),
    promise: Promise.resolve(undefined),
  };
  entry.promise = loader().catch((error: unknown) => {
    if (entries.get(key) === entry) entries.delete(key);
    throw error;
  });
  entries.set(key, entry);
  return entry.promise as Promise<T>;
};

export const loadEffectWorkspaceSnapshot = async <T>(
  key: string,
  loader: (signal?: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
): Promise<EffectWorkspaceSnapshot<T>> => {
  const entry = currentEntry(key);
  if (!entry) return { data: await loader(signal), prefetched: false };
  entries.delete(key);
  return {
    data: await waitForSharedPromise(entry.promise as Promise<T>, signal),
    prefetched: true,
  };
};

export const clearEffectWorkspacePrefetches = (prefix = ''): void => {
  for (const key of entries.keys()) {
    if (!prefix || key.startsWith(prefix)) entries.delete(key);
  }
};
