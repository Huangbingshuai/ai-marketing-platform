import type { EffectPromptFragmentType } from '@ai-marketing/contracts';

export const EFFECT_SEGMENT_RENDER_PAGE_SIZE = 12;

export type EffectSegmentRenderStatus =
  'AUTO_RETRY' | 'COMPLETED' | 'FAILED' | 'IMPORTED' | 'QUEUED' | 'RENDERING';

export type EffectSegmentRenderSource = 'IMPORTED' | 'PROMPT';

export type EffectSegmentRenderTask = {
  id: string;
  renderCode: string;
  productId: string;
  productName: string;
  promptId: string | null;
  promptCode: string | null;
  promptText: string;
  fragmentType: EffectPromptFragmentType;
  materialTags: string[];
  durationSeconds: number;
  modelMatch: 'AUTO_MATCHED';
  source: EffectSegmentRenderSource;
  sourceName: string;
  status: EffectSegmentRenderStatus;
  progress: number;
  retryCount: number;
  maxAutoRetries: number;
  abnormal: boolean;
  errorMessage: string | null;
  updatedAt: string;
};

export type EffectSegmentRenderWorkspace = {
  projectId: string;
  workflowRunId: string;
  productId: string;
  tasks: EffectSegmentRenderTask[];
  updatedAt: string;
};

export type EffectSegmentRenderSummary = {
  total: number;
  completed: number;
  running: number;
  failed: number;
};

export const isEffectSegmentRenderBusy = (status: EffectSegmentRenderStatus): boolean =>
  status === 'AUTO_RETRY' || status === 'QUEUED' || status === 'RENDERING';

export const effectSegmentRenderSummary = (
  tasks: readonly EffectSegmentRenderTask[],
): EffectSegmentRenderSummary =>
  tasks.reduce<EffectSegmentRenderSummary>(
    (summary, task) => {
      summary.total += 1;
      if (task.status === 'COMPLETED' || task.status === 'IMPORTED') summary.completed += 1;
      else if (isEffectSegmentRenderBusy(task.status)) summary.running += 1;
      else if (task.status === 'FAILED') summary.failed += 1;
      return summary;
    },
    { total: 0, completed: 0, running: 0, failed: 0 },
  );

export const filterEffectSegmentRenderTasks = (
  tasks: readonly EffectSegmentRenderTask[],
  keyword: string,
): EffectSegmentRenderTask[] => {
  const normalized = keyword.trim().toLocaleLowerCase('zh-CN');
  if (!normalized) return [...tasks];
  return tasks.filter((task) =>
    [
      task.renderCode,
      task.promptCode ?? '',
      task.productName,
      task.sourceName,
      task.promptText,
      ...task.materialTags,
    ]
      .join(' ')
      .toLocaleLowerCase('zh-CN')
      .includes(normalized),
  );
};

export const effectSegmentRenderPageCount = (
  total: number,
  pageSize = EFFECT_SEGMENT_RENDER_PAGE_SIZE,
): number => Math.max(1, Math.ceil(total / pageSize));

export const effectSegmentRenderPage = (
  tasks: readonly EffectSegmentRenderTask[],
  page: number,
  pageSize = EFFECT_SEGMENT_RENDER_PAGE_SIZE,
): EffectSegmentRenderTask[] => {
  const safePage = Math.max(1, page);
  return tasks.slice((safePage - 1) * pageSize, safePage * pageSize);
};
