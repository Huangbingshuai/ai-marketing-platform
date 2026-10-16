import type { ProductionOperation, ProductionTask } from '@ai-marketing/contracts';
export function productionWorkflowTask(
  tasks: readonly ProductionTask[],
  operation: ProductionOperation,
  taskId?: string,
) {
  const matching = tasks.filter((task) => task.operation === operation);
  return matching.find((task) => task.id === taskId) ?? matching[0];
}
