import type { EffectImportProduct, EffectVideoConfig } from '@ai-marketing/contracts';

import { ApiClientError } from '../../../api/http-client';

export type EffectImportSaveState =
  'clean' | 'conflict' | 'dirty' | 'saveError' | 'saved' | 'saving';

export type ProjectWriteQueue = {
  enqueue: <T>(projectId: string, operation: () => Promise<T>) => Promise<T>;
};

export type VersionedDraftSnapshot<T> = {
  value: T;
  version: number;
};

export type VersionedDraftBuffer<T> = {
  acknowledge: (key: string, version: number) => boolean;
  discard: (key: string) => void;
  edit: (key: string, value: T) => VersionedDraftSnapshot<T>;
  get: (key: string) => VersionedDraftSnapshot<T> | null;
  has: (key?: string) => boolean;
  keys: () => string[];
  reset: () => void;
};

export type IdempotencyKeyRegistry = {
  bind: (resourceId: string, key: string) => string;
  forget: (resourceId: string) => void;
  get: (resourceId: string) => string | null;
  getOrCreate: (resourceId: string) => string;
};

export const createIdempotencyKeyRegistry = (createKey: () => string): IdempotencyKeyRegistry => {
  const keys = new Map<string, string>();
  return {
    bind: (resourceId, key) => {
      const existing = keys.get(resourceId);
      if (existing) return existing;
      keys.set(resourceId, key);
      return key;
    },
    forget: (resourceId) => keys.delete(resourceId),
    get: (resourceId) => keys.get(resourceId) ?? null,
    getOrCreate: (resourceId) => {
      const existing = keys.get(resourceId);
      if (existing) return existing;
      const key = createKey();
      keys.set(resourceId, key);
      return key;
    },
  };
};

export const invalidateIdempotencyKeyOnRevisionChange = (
  registry: Pick<IdempotencyKeyRegistry, 'forget'>,
  resourceId: string,
  previousRevision: number,
  nextRevision: number,
): void => {
  if (previousRevision !== nextRevision) registry.forget(resourceId);
};

export const drainPendingEdits = async (
  hasPendingEdits: () => boolean,
  flushRound: () => Promise<boolean>,
): Promise<boolean> => {
  while (hasPendingEdits()) {
    if (!(await flushRound())) return false;
  }
  return true;
};

export const createVersionedDraftBuffer = <T>(): VersionedDraftBuffer<T> => {
  const entries = new Map<string, VersionedDraftSnapshot<T>>();
  const versions = new Map<string, number>();
  return {
    acknowledge: (key, version) => {
      const current = entries.get(key);
      if (!current || current.version !== version) return false;
      entries.delete(key);
      return true;
    },
    discard: (key) => entries.delete(key),
    edit: (key, value) => {
      const snapshot = { value, version: (versions.get(key) ?? 0) + 1 };
      versions.set(key, snapshot.version);
      entries.set(key, snapshot);
      return snapshot;
    },
    get: (key) => entries.get(key) ?? null,
    has: (key) => (key ? entries.has(key) : entries.size > 0),
    keys: () => [...entries.keys()],
    reset: () => entries.clear(),
  };
};

export const resolveReloadSaveState = (
  reason: 'conflict' | 'normal',
  hasPendingEdits: boolean,
): EffectImportSaveState => {
  if (reason === 'conflict') return 'conflict';
  return hasPendingEdits ? 'dirty' : 'saved';
};

export const resolveSuccessfulWriteSaveState = (hasPendingEdits: boolean): EffectImportSaveState =>
  hasPendingEdits ? 'dirty' : 'saved';

export const synchronizeCollectionItemById = <T extends { id: string }>(
  first: T[],
  second: T[],
  item: T,
): [T[], T[]] => {
  const upsert = (items: T[]): T[] => {
    const found = items.some((candidate) => candidate.id === item.id);
    return found
      ? items.map((candidate) => (candidate.id === item.id ? item : candidate))
      : [...items, item];
  };
  const replaceExisting = (items: T[]): T[] =>
    items.map((candidate) => (candidate.id === item.id ? item : candidate));
  return [upsert(first), replaceExisting(second)];
};

export const createProjectWriteQueue = (): ProjectWriteQueue => {
  const tails = new Map<string, Promise<unknown>>();
  return {
    enqueue: <T>(projectId: string, operation: () => Promise<T>): Promise<T> => {
      const previous = tails.get(projectId) ?? Promise.resolve();
      const current = previous.catch(() => undefined).then(operation);
      tails.set(projectId, current);
      const clear = (): void => {
        if (tails.get(projectId) === current) tails.delete(projectId);
      };
      void current.then(clear, clear);
      return current;
    },
  };
};

export type EffectImportGenerationGate = {
  begin: () => number;
  current: (generation: number) => boolean;
  invalidate: () => void;
};

export const createEffectImportGenerationGate = (): EffectImportGenerationGate => {
  let generation = 0;
  return {
    begin: () => ++generation,
    current: (candidate) => candidate === generation,
    invalidate: () => {
      generation += 1;
    },
  };
};

export const isRevisionConflict = (error: unknown): boolean =>
  error instanceof ApiClientError && error.status === 409;

export const cloneVideoConfig = (config: EffectVideoConfig): EffectVideoConfig => ({
  ...config,
  disabledElements: [...config.disabledElements],
});

export const editableProductSnapshot = (
  product: EffectImportProduct,
): Pick<EffectImportProduct, 'category' | 'commerceUrl' | 'configOverride' | 'name'> => ({
  name: product.name,
  category: product.category,
  commerceUrl: product.commerceUrl,
  configOverride: {
    ...product.configOverride,
    ...(product.configOverride.disabledElements
      ? { disabledElements: [...product.configOverride.disabledElements] }
      : {}),
  },
});
