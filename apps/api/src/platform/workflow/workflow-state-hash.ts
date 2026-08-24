import { createHash } from 'node:crypto';

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  return value;
};

export const workflowStateHash = (state: unknown): string =>
  createHash('sha256')
    .update(JSON.stringify(canonicalize(state)))
    .digest('hex');
