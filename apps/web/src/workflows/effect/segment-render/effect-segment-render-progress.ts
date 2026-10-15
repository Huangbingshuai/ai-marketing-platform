import {
  effectSegmentRenderSummary,
  type EffectSegmentRenderWorkspace,
} from './effect-segment-render-state';

export const effectSegmentRenderProgress = (
  workspace: Pick<EffectSegmentRenderWorkspace, 'tasks' | 'progressTaskIds' |
    'progressSynchronizedCount' | 'progressRemovedCount'> | null,
  creatingTaskCount: number | null = null,
) => {
  // A POST still in flight must never borrow the old completed batch's progress.
  if (creatingTaskCount !== null) return {
    total: creatingTaskCount, completed: 0, progress: 0,
    detail: `正在创建任务，已完成 0/${creatingTaskCount} 条`,
  };
  const ids = workspace?.progressTaskIds ? new Set(workspace.progressTaskIds) : null;
  const tasks = workspace?.tasks.filter((task) => ids
    ? ids.has(task.id) : !task.independentImport) ?? [];
  const summary = effectSegmentRenderSummary(tasks);
  const synchronized = workspace?.progressSynchronizedCount ?? 0;
  const removed = workspace?.progressRemovedCount ?? 0;
  const freeCompleted = synchronized + removed;
  const total = summary.total + freeCompleted;
  const completed = summary.completed + freeCompleted;
  const average = tasks.reduce((sum, task) => sum + (task.status === 'COMPLETED' ? 100 :
    Number.isFinite(task.progress) ? Math.min(99, Math.max(0, task.progress)) : 0), 0) /
    (tasks.length || 1);
  const progress = total > 0 && completed === total
    ? 100 : Math.min(99, Math.round((average * summary.total + freeCompleted * 100) / (total || 1)));
  const waiting = tasks.length > 0 && tasks.every((task) => task.status === 'QUEUED');
  return {
    ...summary, total, completed, progress,
    detail: freeCompleted
      ? `已完成 ${completed}/${total} 项 · 视频 ${summary.completed}/${summary.total}${synchronized ? ` · 同步 ${synchronized}` : ''}${removed ? ` · 移除 ${removed}` : ''}${summary.failed ? ` · 异常 ${summary.failed}` : ''}`
      : `${waiting ? '等待渲染，' : ''}已完成 ${summary.completed}/${summary.total} 条${summary.failed ? `，异常 ${summary.failed} 条` : ''}`,
  };
};
