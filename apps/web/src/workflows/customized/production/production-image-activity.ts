import type { ProductionTask } from '@ai-marketing/contracts';

export type ImageActivity = {
  state: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
  taskId: string;
  error?: string;
};
export const imageActivityRunning = (activity?: ImageActivity) =>
  activity?.state === 'QUEUED' || activity?.state === 'RUNNING';

/** Tasks arrive newest first; a failed replacement must not mark an older saved file failed. */
export function assetImageActivity(
  tasks: readonly ProductionTask[],
  assetId: string,
): ImageActivity | undefined {
  const task = tasks.find(
    (t) => t.operation === 'IMAGE' && t.imageSettings?.assetIds.includes(assetId),
  );
  if (!task) return;
  if (task.completedImageAssetIds?.includes(assetId) || task.status === 'COMPLETED')
    return { taskId: task.id, state: 'SUCCEEDED' };
  if (
    task.status === 'QUEUED' ||
    task.status === 'RUNNING' ||
    task.status === 'FAILED' ||
    task.status === 'CANCELLED'
  )
    return {
      taskId: task.id,
      state: task.status,
      ...(task.status === 'FAILED' && task.errorMessage ? { error: task.errorMessage } : {}),
    };
}
