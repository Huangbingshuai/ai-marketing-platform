import type { ProductionOperation, ProductionTask } from '@ai-marketing/contracts';
export function productionNodeTasks(tasks: readonly ProductionTask[], mode: 'ASSETS' | 'SHOTS') {
  return tasks.filter((task) =>
    mode === 'ASSETS'
      ? task.operation === 'ASSETS' || task.operation === 'IMAGE'
      : task.operation === 'SHOTS' || task.operation === 'PROMPT',
  );
}
export function productionWorkflowTask(
  tasks: readonly ProductionTask[],
  operation: ProductionOperation,
  taskId?: string,
) {
  const matching = tasks.filter((task) => task.operation === operation);
  return matching.find((task) => task.id === taskId) ?? matching[0];
}
