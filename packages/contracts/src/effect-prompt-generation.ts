import type { WorkingArtifactCommitStatus, WorkingArtifactCommitSummary } from './workflow-working';

export const EFFECT_PROMPT_SCHEMA_VERSION = 1 as const;
export const EFFECT_PROMPT_API_BASE =
  '/api/projects/:projectId/workflows/effect/prompt-generation' as const;

export const EFFECT_PROMPT_LIMITS = {
  minCount: 10,
  maxCount: 200,
  defaultCount: 50,
  minDurationSeconds: 10,
  maxDurationSeconds: 120,
  minSemanticDuplicateRate: 5,
  maxSemanticDuplicateRate: 15,
  defaultSemanticDuplicateRate: 15,
  minVisualOverlapRate: 10,
  maxVisualOverlapRate: 20,
  defaultVisualOverlapRate: 20,
  pageSize: 10,
  maxReplenishmentRounds: 3,
  shardSize: 8,
} as const;

export const EFFECT_PROMPT_DIMENSIONS = [
  { key: 'narrative', label: '叙事结构' },
  { key: 'scene', label: '场景变量' },
  { key: 'persona', label: '人物变量' },
  { key: 'sellingPoint', label: '卖点侧重' },
  { key: 'camera', label: '镜头语言' },
  { key: 'emotion', label: '情绪基调' },
] as const;
export type EffectPromptDimensionKey = (typeof EFFECT_PROMPT_DIMENSIONS)[number]['key'];

export type EffectPromptDimensions = Record<EffectPromptDimensionKey, string>;

export type EffectPromptBatchSettings = {
  count: number;
  durationSeconds: number;
  semanticLimit: number;
  visualLimit: number;
};

export const DEFAULT_EFFECT_PROMPT_SETTINGS: EffectPromptBatchSettings = {
  count: EFFECT_PROMPT_LIMITS.defaultCount,
  durationSeconds: 15,
  semanticLimit: EFFECT_PROMPT_LIMITS.defaultSemanticDuplicateRate,
  visualLimit: EFFECT_PROMPT_LIMITS.defaultVisualOverlapRate,
};

export const EFFECT_PROMPT_ITEM_ORIGINS = ['AI', 'MANUAL'] as const;
export type EffectPromptItemOrigin = (typeof EFFECT_PROMPT_ITEM_ORIGINS)[number];

export type EffectPromptItem = {
  id: string;
  code: string;
  origin: EffectPromptItemOrigin;
  fragmentType: string;
  dimensions: EffectPromptDimensions;
  content: string;
  manualEdited: boolean;
  createdAt: string;
  updatedAt: string;
};

export type EffectPromptMetrics = {
  targetCount: number;
  acceptedCount: number;
  generatedCandidateCount: number;
  removedSemanticDuplicates: number;
  removedVisualDuplicates: number;
  removedDimensionConflicts: number;
  semanticDuplicateRate: number;
  visualOverlapRate: number;
  replenishmentRounds: number;
};

export const EFFECT_PROMPT_QUALITY_STATUSES = ['PASS', 'NEEDS_REVIEW'] as const;
export type EffectPromptQualityStatus = (typeof EFFECT_PROMPT_QUALITY_STATUSES)[number];

export type EffectPromptBatchResult = {
  schemaVersion: typeof EFFECT_PROMPT_SCHEMA_VERSION;
  settings: EffectPromptBatchSettings;
  items: EffectPromptItem[];
  metrics: EffectPromptMetrics;
  qualityStatus: EffectPromptQualityStatus;
};

export type EffectPromptManualOverrides = {
  edited: Record<string, Pick<EffectPromptItem, 'content' | 'fragmentType' | 'dimensions'>>;
  added: EffectPromptItem[];
  deleted: string[];
};

export const EFFECT_PROMPT_OPERATIONS = ['BATCH_GENERATE', 'ITEM_REGENERATE'] as const;
export type EffectPromptOperation = (typeof EFFECT_PROMPT_OPERATIONS)[number];

export const EFFECT_PROMPT_RUN_STATUSES = ['QUEUED', 'RUNNING', 'COMPLETED', 'FAILED'] as const;
export type EffectPromptRunStatus = (typeof EFFECT_PROMPT_RUN_STATUSES)[number];

export const EFFECT_PROMPT_STAGE_STATUSES = [
  'PENDING',
  'RUNNING',
  'SUCCEEDED',
  'PARTIAL',
  'SKIPPED',
  'FAILED',
] as const;
export type EffectPromptStageStatus = (typeof EFFECT_PROMPT_STAGE_STATUSES)[number];

export const EFFECT_PROMPT_GRAPH_NODES = [
  { id: 'LOAD_AND_SNAPSHOT', label: '输入快照', group: 'SNAPSHOT' },
  { id: 'STRATEGY_PLANNING', label: '六维策略规划', group: 'PLANNING' },
  { id: 'DIMENSION_COMBINATION', label: '正交组合', group: 'PLANNING' },
  { id: 'CANDIDATE_GENERATION', label: '候选生成', group: 'GENERATION' },
  { id: 'NORMALIZATION', label: '结构标准化', group: 'NORMALIZATION' },
  { id: 'SEMANTIC_DEDUP', label: '语义去重', group: 'PARALLEL' },
  { id: 'VISUAL_DEDUP', label: '视觉重合校验', group: 'PARALLEL' },
  { id: 'QUALITY_GATE', label: '质量门禁', group: 'QUALITY' },
  { id: 'REPLENISH', label: '自动补齐', group: 'REPLENISH' },
  { id: 'RESULT_SAVE', label: '结果保存', group: 'RESULT' },
] as const;
export type EffectPromptNodeId = (typeof EFFECT_PROMPT_GRAPH_NODES)[number]['id'];

export const EFFECT_PROMPT_GRAPH_EDGES = [
  { from: 'LOAD_AND_SNAPSHOT', to: 'STRATEGY_PLANNING' },
  { from: 'STRATEGY_PLANNING', to: 'DIMENSION_COMBINATION' },
  { from: 'DIMENSION_COMBINATION', to: 'CANDIDATE_GENERATION' },
  { from: 'CANDIDATE_GENERATION', to: 'NORMALIZATION' },
  { from: 'NORMALIZATION', to: 'SEMANTIC_DEDUP' },
  { from: 'NORMALIZATION', to: 'VISUAL_DEDUP' },
  { from: 'SEMANTIC_DEDUP', to: 'QUALITY_GATE' },
  { from: 'VISUAL_DEDUP', to: 'QUALITY_GATE' },
  { from: 'QUALITY_GATE', to: 'REPLENISH' },
  { from: 'QUALITY_GATE', to: 'RESULT_SAVE' },
  { from: 'REPLENISH', to: 'CANDIDATE_GENERATION' },
] as const satisfies ReadonlyArray<{ from: EffectPromptNodeId; to: EffectPromptNodeId }>;

export type EffectPromptNodeExecution = {
  nodeId: EffectPromptNodeId;
  status: EffectPromptStageStatus;
  summary: string;
  warnings: string[];
  errorMessage: string | null;
};

export type EffectPromptRun = {
  id: string;
  projectId: string;
  workflowRunId: string;
  productId: string;
  operation: EffectPromptOperation;
  targetItemId: string | null;
  status: EffectPromptRunStatus;
  progress: number;
  currentNode: EffectPromptNodeId | 'COMPLETED' | null;
  warnings: string[];
  errorMessage: string | null;
  promptResultId: string | null;
  nodes: EffectPromptNodeExecution[];
  createdAt: string;
  updatedAt: string;
};

export type EffectPromptProductState = {
  projectId: string;
  workflowRunId: string;
  productId: string;
  status: 'NOT_GENERATED' | 'QUEUED' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'STALE';
  runId: string | null;
  resultId: string | null;
  resultRevision: number | null;
  settings: EffectPromptBatchSettings;
  settingsRevision: number | null;
  metrics: EffectPromptMetrics | null;
  qualityStatus: EffectPromptQualityStatus | null;
  commitStatus: WorkingArtifactCommitStatus;
  workingArtifactRevision: number | null;
  progress: number;
  currentNode: string | null;
  errorMessage: string | null;
  updatedAt: string;
};

export type GetEffectPromptWorkspaceData = {
  projectId: string;
  workflowRunId: string;
  products: EffectPromptProductState[];
};

export type GetEffectPromptResultData = {
  projectId: string;
  productId: string;
  resultId: string;
  revision: number;
  result: Omit<EffectPromptBatchResult, 'items'>;
  items: EffectPromptItem[];
  total: number;
  page: number;
  pageSize: number;
};

export type StartEffectPromptRunRequest = {
  workflowRunId: string;
  operation: EffectPromptOperation;
  targetItemId?: string | undefined;
  expectedSettingsRevision: number;
  expectedResultRevision?: number | undefined;
  idempotencyKey: string;
};

export type StartEffectPromptRunData = { run: EffectPromptRun };
export type SaveEffectPromptSettingsRequest = {
  workflowRunId: string;
  settings: EffectPromptBatchSettings;
  expectedRevision: number | null;
};
export type SaveEffectPromptSettingsData = {
  productId: string;
  settings: EffectPromptBatchSettings;
  settingsRevision: number;
  savedAt: string;
  unchanged: boolean;
};
export type GetEffectPromptRunData = { run: EffectPromptRun };
export type GetEffectPromptNodeDetailData = {
  detail: {
    nodeId: EffectPromptNodeId;
    status: EffectPromptStageStatus;
    summary: string;
    fields: Array<{ label: string; value: string | number }>;
    warnings: string[];
    errorMessage: string | null;
    updatedAt: string | null;
  };
};

export type UpsertEffectPromptItemRequest = Pick<
  EffectPromptItem,
  'content' | 'fragmentType' | 'dimensions'
> & { expectedRevision: number };

export type UpdateEffectPromptResultData = {
  resultId: string;
  productId: string;
  revision: number;
  result: EffectPromptBatchResult;
  savedAt: string;
  unchanged: boolean;
};

export type ValidateEffectPromptResultRequest = { expectedRevision: number };
export type ValidateEffectPromptResultData = {
  valid: boolean;
  issues: Array<{ code: string; message: string }>;
  productId: string;
  artifacts: WorkingArtifactCommitSummary[];
  allProductsValidated: boolean;
  validatedAt: string;
};

export const effectPromptSettingsNodeId = (productId: string): string =>
  `PROMPT_GENERATION:${productId}`;

export const normalizeEffectPromptSettings = (
  input: EffectPromptBatchSettings,
): EffectPromptBatchSettings => ({
  count: Math.min(
    EFFECT_PROMPT_LIMITS.maxCount,
    Math.max(EFFECT_PROMPT_LIMITS.minCount, Math.round(input.count)),
  ),
  durationSeconds: Math.min(
    EFFECT_PROMPT_LIMITS.maxDurationSeconds,
    Math.max(EFFECT_PROMPT_LIMITS.minDurationSeconds, Math.round(input.durationSeconds)),
  ),
  semanticLimit: Math.min(
    EFFECT_PROMPT_LIMITS.maxSemanticDuplicateRate,
    Math.max(EFFECT_PROMPT_LIMITS.minSemanticDuplicateRate, Math.round(input.semanticLimit)),
  ),
  visualLimit: Math.min(
    EFFECT_PROMPT_LIMITS.maxVisualOverlapRate,
    Math.max(EFFECT_PROMPT_LIMITS.minVisualOverlapRate, Math.round(input.visualLimit)),
  ),
});
