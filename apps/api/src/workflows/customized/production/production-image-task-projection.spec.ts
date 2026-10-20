import { expect, it } from 'vitest';
import type { CustomizedProductionTask } from '../../../generated/prisma/client';
import { presentProductionTask } from './production.repository';

const task = (status: string, output: unknown) =>
  ({
    id: 'image-task',
    operation: 'IMAGE',
    status,
    shotId: null,
    steps: [],
    errorMessage: null,
    inputSnapshot: { imageSettings: { assetIds: ['a', 'b', 'constructor'] } },
    output,
  }) as unknown as CustomizedProductionTask;

it('projects only selected objects with persisted valid file references, including partial failure', () => {
  const value = presentProductionTask(
    task('FAILED', {
      a: { assetId: 'file-a', version: 2 },
      b: { assetId: 'file-b', version: 0 },
      outside: { assetId: 'private-file', version: 1 },
    }),
  );
  expect(value.completedImageAssetIds).toEqual(['a']);
  expect(JSON.stringify(value)).not.toContain('private-file');
  expect(JSON.stringify(value)).not.toContain('file-a');
  expect(value.status).toBe('FAILED');
});

it('does not infer completion from prototype keys, image settings, or missing output', () => {
  expect(presentProductionTask(task('RUNNING', null)).completedImageAssetIds).toEqual([]);
  expect(
    presentProductionTask(task('QUEUED', { a: 'invalid', b: null })).completedImageAssetIds,
  ).toEqual([]);
  expect(
    presentProductionTask(task('RUNNING', { a: { assetId: '', version: 1 } }))
      .completedImageAssetIds,
  ).toEqual([]);
  const other = task('RUNNING', { a: { assetId: 'file', version: 1 } });
  other.operation = 'ASSETS';
  expect(presentProductionTask(other).completedImageAssetIds).toBeUndefined();
});
