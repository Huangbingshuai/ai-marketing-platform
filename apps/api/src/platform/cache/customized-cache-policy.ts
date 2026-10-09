import { CUSTOMIZED_IMAGE_USAGES, CUSTOMIZED_MATERIAL_CATEGORIES } from '@ai-marketing/contracts';
import type { EffectCacheResource } from './effect-cache-revision.service';

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const only = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).every((key) => keys.includes(key));

/** Fail closed: legacy text and future unknown node payloads must never enter Redis. */
const sourceState = (value: unknown): boolean => {
  if (
    !object(value) ||
    value.nodeId !== 'SOURCE_IMPORT' ||
    !only(value, [
      'id',
      'projectId',
      'workflowRunId',
      'nodeId',
      'schemaVersion',
      'revision',
      'contentHash',
      'executionInputHash',
      'executionInputSchemaVersion',
      'state',
      'savedAt',
      'createdAt',
      'updatedAt',
    ])
  )
    return false;
  const state = value.state;
  return (
    object(state) &&
    only(state, ['schemaVersion', 'requirements', 'materials']) &&
    state.schemaVersion === 3 &&
    state.requirements === '' &&
    Array.isArray(state.materials) &&
    state.materials.every(
      (item: unknown) =>
        object(item) &&
        only(item, ['assetId', 'assetVersion', 'category', 'imageUsage']) &&
        typeof item.assetId === 'string' &&
        /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(item.assetId) &&
        Number.isInteger(item.assetVersion) &&
        (item.assetVersion as number) > 0 &&
        (CUSTOMIZED_MATERIAL_CATEGORIES as readonly unknown[]).includes(item.category) &&
        (item.imageUsage === undefined ||
          (CUSTOMIZED_IMAGE_USAGES as readonly unknown[]).includes(item.imageUsage)),
    )
  );
};

export const canCacheCustomizedProjection = (resource: EffectCacheResource, value: unknown) => {
  if (resource === 'customized-import-draft') return sourceState(value);
  if (resource === 'customized-overview') {
    return (
      object(value) &&
      only(value, ['run', 'nodeStates']) &&
      Array.isArray(value.nodeStates) &&
      value.nodeStates.every(sourceState) &&
      object(value.run) &&
      value.run.workflow === 'CUSTOMIZED' &&
      value.run.workflowSpace === 'CUSTOMIZED_PROJECT'
    );
  }
  // Tree is constructed field-by-field and contains no artifact payload or draft state.
  return true;
};
