/** Only independent, explicitly targeted video clips may run concurrently. */
export type ProductionTaskScope = {
  operation: string;
  target?: { kind: string; id: string } | null | undefined;
};

export function productionTasksConflict(a: ProductionTaskScope, b: ProductionTaskScope): boolean {
  const clipId = (task: ProductionTaskScope) =>
    ['PROMPT', 'RENDER'].includes(task.operation) &&
    task.target?.kind === 'CLIP' &&
    task.target.id.trim()
      ? task.target.id
      : null;
  const left = clipId(a);
  const right = clipId(b);
  return !left || !right || left === right;
}
