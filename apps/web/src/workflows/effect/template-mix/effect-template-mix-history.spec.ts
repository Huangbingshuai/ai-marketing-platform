import { describe, expect, it } from 'vitest';
import { createScopedTimelineHistory } from './effect-template-mix-history';

describe('scoped timeline history', () => {
  it('restores each film project undo and redo stacks after switching away and back', () => {
    const store = createScopedTimelineHistory<string>();
    const empty = { undo: [], redo: [] };
    expect(store.switchScope('project/run/template/film-a', empty)).toEqual(empty);

    const filmA = { undo: ['before edit A', 'before edit B'], redo: ['after undo'] };
    expect(store.switchScope('project/run/template/film-b', filmA)).toEqual(empty);

    const filmB = { undo: ['before edit C'], redo: [] };
    expect(store.switchScope('project/run/template/film-a', filmB)).toEqual(filmA);
    expect(store.switchScope('project/run/template/film-b', filmA)).toEqual(filmB);
  });

  it('does not share history between branches or templates', () => {
    const store = createScopedTimelineHistory<string>();
    store.switchScope('project/run-a/template/film', { undo: [], redo: [] });
    const runB = store.switchScope('project/run-b/template/film', {
      undo: ['old branch'], redo: [],
    });
    expect(runB).toEqual({
      undo: [], redo: [],
    });
    const otherTemplate = store.switchScope('project/run-a/other-template/film', runB);
    expect(otherTemplate).toEqual({
      undo: [], redo: [],
    });
    expect(store.switchScope('project/run-a/template/film', otherTemplate)).toEqual({
      undo: ['old branch'], redo: [],
    });
  });
});
