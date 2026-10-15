import { describe, expect, it } from 'vitest';
import { renderUpdateCompletions } from './effect-segment-render-progress';

const task = (id: string, signature = 'current', deleted = false) => ({
  id,
  errorCode: deleted ? 'MATERIAL_DELETED' : null,
  requestSnapshot: { refreshContext: { confirmationSignature: signature } },
});
describe('render update free-operation progress', () => {
  it('recovers an existing six-video plus one-removal update without changing persisted data', () => {
    const videos = Array.from({ length: 6 }, (_, i) => task(`video-${i}`));
    const scope = { batchId: 'batch', taskIds: videos.map(({ id }) => id) };
    expect(
      renderUpdateCompletions(
        'batch',
        [
          ...videos,
          task('deleted', 'current', true),
          task('older', 'previous', true),
          task('unchanged', 'other'),
        ],
        scope,
      ),
    ).toEqual({
      progressSynchronizedCount: 0,
      progressRemovedCount: 1,
    });
  });
  it('validates batch ownership, duplicates, removals, overlaps and empty operation scope', () => {
    const tasks = [task('paid'), task('metadata'), task('deleted', 'current', true)];
    const scope = {
      batchId: 'batch',
      taskIds: ['paid'],
      synchronizedTaskIds: ['metadata', 'metadata', 'paid', 'deleted', 'foreign'],
      removedTaskIds: ['deleted', 'deleted', 'paid', 'foreign'],
    };
    expect(renderUpdateCompletions('batch', tasks, scope)).toEqual({
      progressSynchronizedCount: 1,
      progressRemovedCount: 1,
    });
    expect(renderUpdateCompletions('other-batch', tasks, scope)).toEqual({});
    expect(
      renderUpdateCompletions('batch', tasks, {
        ...scope,
        taskIds: [],
        synchronizedTaskIds: [],
        removedTaskIds: [],
      }),
    ).toEqual({
      progressSynchronizedCount: 0,
      progressRemovedCount: 0,
    });
  });
  it('replaces the first operation with a second scope, including pure free changes', () => {
    const tasks = [task('first', 'old', true), task('second', 'new'), task('sync', 'new')];
    expect(
      renderUpdateCompletions('batch', tasks, { batchId: 'batch', taskIds: ['second'] }),
    ).toEqual({ progressSynchronizedCount: 1, progressRemovedCount: 0 });
    expect(
      renderUpdateCompletions('batch', tasks, {
        batchId: 'batch',
        taskIds: [],
        synchronizedTaskIds: ['sync'],
        removedTaskIds: [],
      }),
    ).toEqual({ progressSynchronizedCount: 1, progressRemovedCount: 0 });
  });
});
