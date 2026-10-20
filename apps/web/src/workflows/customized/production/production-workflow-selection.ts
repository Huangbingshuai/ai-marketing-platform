import type { ProductionOperation, ProductionTask } from '@ai-marketing/contracts';
export function productionNodeTasks(tasks: readonly ProductionTask[], mode: 'ASSETS' | 'SHOTS') {
  return tasks.filter((task) =>
    mode === 'ASSETS'
      ? task.operation === 'ASSETS' || task.operation === 'IMAGE'
      : task.operation === 'SHOTS' || task.operation === 'PROMPT' || task.operation === 'RENDER',
  );
}
/** Page-wide progress belongs to bulk authoring; per-clip work stays in its own card. */
export function productionPageProgressTask(
  tasks: readonly ProductionTask[],
  mode: 'ASSETS' | 'SHOTS',
) {
  return productionNodeTasks(tasks, mode).find(
    (task) => ['QUEUED', 'RUNNING'].includes(task.status) && task.operation === mode,
  );
}
export function productionWorkflowTask(
  tasks: readonly ProductionTask[],
  operation: ProductionOperation,
  taskId?: string,
  clipId?: string,
) {
  const matching = tasks.filter(
    (task) => task.operation === operation && (!clipId || task.target?.id === clipId),
  );
  return matching.find((task) => task.id === taskId) ?? matching[0];
}
