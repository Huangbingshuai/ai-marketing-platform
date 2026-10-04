export type UndoRedoHistory<T> = {
  undo: T[];
  redo: T[];
};

/** Keeps temporary editor history isolated while the user switches between timeline projects. */
export function createScopedTimelineHistory<T>() {
  const histories = new Map<string, UndoRedoHistory<T>>();
  let activeScope = '';
  const copy = (history: UndoRedoHistory<T>): UndoRedoHistory<T> => ({
    undo: [...history.undo],
    redo: [...history.redo],
  });

  return {
    switchScope(scope: string, current: UndoRedoHistory<T>): UndoRedoHistory<T> {
      if (activeScope) histories.set(activeScope, copy(current));
      activeScope = scope;
      return copy(histories.get(scope) ?? { undo: [], redo: [] });
    },
  };
}
