import type { FinalOutputItem, FinalOutputRun } from '@ai-marketing/contracts';

export function outputPackagingLabel(item: FinalOutputItem) {
  if (item.currentPackagingReady === true) return null;
  if (!item.unpackaged) return null;
  return { text: '未包装', tone: 'unpackaged' };
}

export function outputFileDescription(item: FinalOutputItem, status: FinalOutputRun['status']) {
  if (status === 'PENDING_RENDER') return `预计 ${item.duration.toFixed(1)} 秒 · 待导出`;
  return `${item.duration.toFixed(1)} 秒 · H.264 / AAC`;
}

export function outputTemplateStatus(run: FinalOutputRun) {
  if (run.counts.stale) return `${run.counts.stale} 条成片待更新`;
  const status: Record<FinalOutputRun['status'], string> = {
    PENDING_RENDER: '待渲染',
    QUEUED: '排队中',
    RUNNING: '渲染中',
    COMPLETED: '已完成',
    PARTIAL: '部分失败',
    FAILED: '失败',
    CANCELLED: '已取消',
  };
  return `${run.counts.total} 条成片 · ${status[run.status]}`;
}
