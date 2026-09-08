import type {
  EffectPromptFragmentType,
  EffectSegmentRenderBatch,
  EffectSegmentRenderOutput,
  EffectSegmentRenderTask as ApiEffectSegmentRenderTask,
  GetEffectSegmentRenderWorkspaceData,
  WorkingArtifactCommitStatus,
} from '@ai-marketing/contracts';

export const EFFECT_SEGMENT_RENDER_PAGE_SIZE = 20;

export type EffectSegmentRenderStatus =
  'AUTO_RETRY' | 'COMPLETED' | 'FAILED' | 'QUEUED' | 'RENDERING';

export type EffectSegmentRenderSource = 'PROMPT';

export type EffectSegmentRenderOrigin = 'AI_GENERATED' | 'EXTERNAL_IMPORT';

export type EffectSegmentRenderBatchStatus =
  'COMPLETED' | 'FAILED' | 'NOT_STARTED' | 'PARTIAL' | 'QUEUED' | 'RUNNING';

export type EffectSegmentRenderRepairStatus = 'FAILED' | 'QUEUED' | 'READY' | 'RENDERING';

export type EffectSegmentRenderRepair = {
  version?: number;
  sourceVersion: number;
  startMs: number;
  endMs: number;
  instruction: string;
  status: EffectSegmentRenderRepairStatus;
  candidateVersion: number | null;
  candidate?: EffectSegmentRenderOutput | null;
  errorMessage: string | null;
  errorCode?: string | null;
};

export type EffectSegmentRenderTask = {
  id: string;
  renderCode: string;
  productId: string;
  productName: string;
  promptId: string;
  promptCode: string;
  promptText: string;
  fragmentType: EffectPromptFragmentType;
  compatibleFragmentTypes: EffectPromptFragmentType[];
  durationSeconds: number;
  modelMatch: 'AUTO_MATCHED';
  source: EffectSegmentRenderSource;
  origin: EffectSegmentRenderOrigin;
  sourceName: string;
  status: EffectSegmentRenderStatus;
  progress: number;
  retryCount: number;
  maxAutoRetries: number;
  abnormal: boolean;
  errorCode?: string | null;
  errorMessage: string | null;
  providerTaskId?: string | null;
  output?: EffectSegmentRenderOutput | null;
  activeVersion: number;
  repair: EffectSegmentRenderRepair | null;
  updatedAt: string;
};

export type EffectSegmentRenderWorkspace = {
  projectId: string;
  workflowRunId: string;
  productId: string;
  promptCount: number;
  promptReady?: boolean;
  promptArtifactRevision?: number | null;
  settingsRevision?: number | null;
  batchId?: string | null;
  batchRevision?: number | null;
  stale?: boolean;
  commitStatus?: WorkingArtifactCommitStatus | null;
  batchStatus: EffectSegmentRenderBatchStatus;
  tasks: EffectSegmentRenderTask[];
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
};

const effectSegmentRenderTaskFromApi = (
  task: ApiEffectSegmentRenderTask,
): EffectSegmentRenderTask => ({
  ...task,
  compatibleFragmentTypes: [...task.compatiblePurposes],
  origin: 'AI_GENERATED',
  activeVersion: task.output?.version ?? 1,
  repair: task.repair
    ? {
        ...task.repair,
        candidateVersion: task.repair.candidate?.version ?? null,
      }
    : null,
});

export const effectSegmentRenderWorkspaceFromApi = (
  data: GetEffectSegmentRenderWorkspaceData,
): EffectSegmentRenderWorkspace => ({
  projectId: data.projectId,
  workflowRunId: data.workflowRunId,
  productId: data.productId,
  promptCount: data.promptCount,
  promptReady: data.promptReady,
  promptArtifactRevision: data.promptArtifactRevision,
  settingsRevision: data.settingsRevision,
  batchId: data.batch?.id ?? null,
  batchRevision: data.batch?.revision ?? null,
  stale: data.batch?.stale ?? false,
  commitStatus: data.batch?.commitStatus ?? null,
  batchStatus: data.batch?.status ?? 'NOT_STARTED',
  tasks: data.batch?.tasks.map(effectSegmentRenderTaskFromApi) ?? [],
  startedAt: data.batch?.createdAt ?? null,
  completedAt: data.batch?.status === 'COMPLETED' ? data.batch.updatedAt : null,
  updatedAt: data.batch?.updatedAt ?? new Date().toISOString(),
});

export const effectSegmentRenderWorkspaceWithBatch = (
  current: EffectSegmentRenderWorkspace,
  batch: EffectSegmentRenderBatch,
): EffectSegmentRenderWorkspace => ({
  ...current,
  productId: batch.productId,
  batchId: batch.id,
  batchRevision: batch.revision,
  stale: batch.stale,
  commitStatus: batch.commitStatus,
  batchStatus: batch.status,
  tasks: batch.tasks.map(effectSegmentRenderTaskFromApi),
  startedAt: batch.createdAt,
  completedAt: batch.status === 'COMPLETED' ? batch.updatedAt : null,
  updatedAt: batch.updatedAt,
});

export type EffectSegmentRenderSummary = {
  total: number;
  completed: number;
  running: number;
  failed: number;
};

export const isEffectSegmentRenderExportable = (task: EffectSegmentRenderTask): boolean =>
  task.status === 'COMPLETED';

export const isEffectSegmentRenderBusy = (status: EffectSegmentRenderStatus): boolean =>
  status === 'AUTO_RETRY' || status === 'QUEUED' || status === 'RENDERING';

export const effectSegmentRenderSummary = (
  tasks: readonly EffectSegmentRenderTask[],
): EffectSegmentRenderSummary =>
  tasks.reduce<EffectSegmentRenderSummary>(
    (summary, task) => {
      summary.total += 1;
      if (task.status === 'COMPLETED') summary.completed += 1;
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
    [task.renderCode, task.promptCode ?? '', task.productName, task.sourceName, task.promptText]
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
