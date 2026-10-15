type ProgressTask = { id: string; errorCode: string | null; requestSnapshot: unknown };
type Scope = {
  batchId?: string;
  taskIds?: unknown;
  synchronizedTaskIds?: unknown;
  removedTaskIds?: unknown;
};

/** Only the current operation's frozen, batch-owned records can contribute free completions. */
export const renderUpdateCompletions = (batchId: string, tasks: ProgressTask[], scope?: Scope) => {
  if (scope?.batchId !== batchId || !Array.isArray(scope.taskIds)) return {};
  const paidIds = new Set(scope.taskIds);
  const context = (task: ProgressTask) =>
    (
      task.requestSnapshot as {
        refreshContext?: { confirmationSignature?: string };
      } | null
    )?.refreshContext?.confirmationSignature;
  // Read compatibility for updates already queued before explicit free-operation IDs existed.
  const signatures = new Set(
    tasks
      .filter((task) => paidIds.has(task.id))
      .map(context)
      .filter(Boolean),
  );
  const legacy = tasks.filter(
    (task) => !paidIds.has(task.id) && context(task) && signatures.has(context(task)),
  );
  const synchronized = new Set(
    Array.isArray(scope.synchronizedTaskIds)
      ? scope.synchronizedTaskIds
      : legacy.filter((task) => task.errorCode !== 'MATERIAL_DELETED').map(({ id }) => id),
  );
  const removed = new Set(
    Array.isArray(scope.removedTaskIds)
      ? scope.removedTaskIds
      : legacy.filter((task) => task.errorCode === 'MATERIAL_DELETED').map(({ id }) => id),
  );
  return {
    progressSynchronizedCount: tasks.filter(
      (task) =>
        !paidIds.has(task.id) &&
        synchronized.has(task.id) &&
        !removed.has(task.id) &&
        task.errorCode !== 'MATERIAL_DELETED',
    ).length,
    progressRemovedCount: tasks.filter(
      (task) =>
        !paidIds.has(task.id) && removed.has(task.id) && task.errorCode === 'MATERIAL_DELETED',
    ).length,
  };
};
