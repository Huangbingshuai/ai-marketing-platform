import type { WorkingArtifactCommitStatus, WorkingArtifactCommitSummary } from './workflow-working';

export const EFFECT_PROMPT_SCHEMA_VERSION = 3 as const;
export const EFFECT_PROMPT_API_BASE =
  '/api/projects/:projectId/workflows/effect/prompt-generation' as const;

export const EFFECT_PROMPT_LIMITS = {
  minCount: 10,
  maxCount: 200,
  defaultCount: 50,
  minFragmentCount: 1,
  minDurationSeconds: 3,
  maxDurationSeconds: 10,
  defaultDurationSeconds: 5,
  minSemanticDuplicateRate: 5,
  maxSemanticDuplicateRate: 15,
  defaultSemanticDuplicateRate: 15,
  minVisualOverlapRate: 10,
  maxVisualOverlapRate: 20,
  defaultVisualOverlapRate: 20,
  pageSize: 10,
  maxReplenishmentRounds: 3,
  shardSize: 8,
  maxMaterialTags: 12,
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

export const EFFECT_PROMPT_FRAGMENT_TYPES = [
  'HOOK',
  'PAIN',
  'PRODUCT_DISPLAY',
  'SELLING_POINT_EXPLANATION',
  'CTA',
  'OUTRO',
] as const;
export type EffectPromptFragmentType = (typeof EFFECT_PROMPT_FRAGMENT_TYPES)[number];

export const EFFECT_PROMPT_FRAGMENT_TYPE_LABELS: Record<EffectPromptFragmentType, string> = {
  HOOK: '钩子片段',
  PAIN: '痛点片段',
  PRODUCT_DISPLAY: '产品展示片段',
  SELLING_POINT_EXPLANATION: '卖点讲解片段',
  CTA: '结尾转化片段',
  OUTRO: '片尾品牌片段',
};

export type EffectPromptFragmentConfig = {
  count: number;
  durationSeconds: number;
};

export type EffectPromptFragmentConfigs = Record<
  EffectPromptFragmentType,
  EffectPromptFragmentConfig
>;

export const DEFAULT_EFFECT_PROMPT_FRAGMENT_CONFIGS: EffectPromptFragmentConfigs = {
  HOOK: { count: 10, durationSeconds: 5 },
  PAIN: { count: 8, durationSeconds: 5 },
  PRODUCT_DISPLAY: { count: 12, durationSeconds: 5 },
  SELLING_POINT_EXPLANATION: { count: 10, durationSeconds: 5 },
  CTA: { count: 6, durationSeconds: 5 },
  OUTRO: { count: 4, durationSeconds: 5 },
};

export type EffectPromptBatchSettings = {
  fragmentConfigs: EffectPromptFragmentConfigs;
  semanticLimit: number;
  visualLimit: number;
};

export const DEFAULT_EFFECT_PROMPT_SETTINGS: EffectPromptBatchSettings = {
  fragmentConfigs: Object.fromEntries(
    EFFECT_PROMPT_FRAGMENT_TYPES.map((fragmentType) => [
      fragmentType,
      { ...DEFAULT_EFFECT_PROMPT_FRAGMENT_CONFIGS[fragmentType] },
    ]),
  ) as EffectPromptFragmentConfigs,
  semanticLimit: EFFECT_PROMPT_LIMITS.defaultSemanticDuplicateRate,
  visualLimit: EFFECT_PROMPT_LIMITS.defaultVisualOverlapRate,
};

export const EFFECT_PROMPT_ITEM_ORIGINS = ['AI', 'MANUAL'] as const;
export type EffectPromptItemOrigin = (typeof EFFECT_PROMPT_ITEM_ORIGINS)[number];

export type EffectPromptItem = {
  id: string;
  code: string;
  origin: EffectPromptItemOrigin;
  fragmentType: EffectPromptFragmentType;
  materialTags: string[];
  targetDurationSeconds: number;
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
  fragmentTypeDistribution: Array<{
    fragmentType: EffectPromptFragmentType;
    targetCount: number;
    actualCount: number;
  }>;
  sellingPointCoverage: {
    required: string[];
    covered: string[];
    missing: string[];
  };
  removedExecutionInvalid: number;
  executionInvalidReasons: Array<{ code: string; count: number }>;
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
  edited: Record<
    string,
    Pick<
      EffectPromptItem,
      'content' | 'fragmentType' | 'materialTags' | 'targetDurationSeconds' | 'dimensions'
    >
  >;
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
  { id: 'FRAGMENT_TYPE_ROUTER', label: '片段类型条件路由', group: 'ROUTER' },
  { id: 'GENERATE_HOOK', label: '钩子 Prompt 生成', group: 'GENERATION' },
  { id: 'GENERATE_PAIN', label: '痛点 Prompt 生成', group: 'GENERATION' },
  { id: 'GENERATE_PRODUCT_DISPLAY', label: '产品展示 Prompt 生成', group: 'GENERATION' },
  {
    id: 'GENERATE_SELLING_POINT_EXPLANATION',
    label: '卖点讲解 Prompt 生成',
    group: 'GENERATION',
  },
  { id: 'GENERATE_CTA', label: '结尾转化 Prompt 生成', group: 'GENERATION' },
  { id: 'GENERATE_OUTRO', label: '片尾品牌 Prompt 生成', group: 'GENERATION' },
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
  { from: 'DIMENSION_COMBINATION', to: 'FRAGMENT_TYPE_ROUTER' },
  { from: 'FRAGMENT_TYPE_ROUTER', to: 'GENERATE_HOOK' },
  { from: 'FRAGMENT_TYPE_ROUTER', to: 'GENERATE_PAIN' },
  { from: 'FRAGMENT_TYPE_ROUTER', to: 'GENERATE_PRODUCT_DISPLAY' },
  { from: 'FRAGMENT_TYPE_ROUTER', to: 'GENERATE_SELLING_POINT_EXPLANATION' },
  { from: 'FRAGMENT_TYPE_ROUTER', to: 'GENERATE_CTA' },
  { from: 'FRAGMENT_TYPE_ROUTER', to: 'GENERATE_OUTRO' },
  { from: 'GENERATE_HOOK', to: 'NORMALIZATION' },
  { from: 'GENERATE_PAIN', to: 'NORMALIZATION' },
  { from: 'GENERATE_PRODUCT_DISPLAY', to: 'NORMALIZATION' },
  { from: 'GENERATE_SELLING_POINT_EXPLANATION', to: 'NORMALIZATION' },
  { from: 'GENERATE_CTA', to: 'NORMALIZATION' },
  { from: 'GENERATE_OUTRO', to: 'NORMALIZATION' },
  { from: 'NORMALIZATION', to: 'SEMANTIC_DEDUP' },
  { from: 'NORMALIZATION', to: 'VISUAL_DEDUP' },
  { from: 'SEMANTIC_DEDUP', to: 'QUALITY_GATE' },
  { from: 'VISUAL_DEDUP', to: 'QUALITY_GATE' },
  { from: 'QUALITY_GATE', to: 'REPLENISH' },
  { from: 'QUALITY_GATE', to: 'RESULT_SAVE' },
  { from: 'REPLENISH', to: 'FRAGMENT_TYPE_ROUTER' },
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

export type GetEffectPromptResultQuery = {
  workflowRunId: string;
  page?: number | undefined;
  pageSize?: number | undefined;
  query?: string | undefined;
  fragmentType?: EffectPromptFragmentType | undefined;
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
export type EffectPromptNodeDetailField = {
  label: string;
  value: string | number;
  description?: string | undefined;
};
export type GetEffectPromptNodeDetailData = {
  detail: {
    nodeId: EffectPromptNodeId;
    status: EffectPromptStageStatus;
    summary: string;
    fields: EffectPromptNodeDetailField[];
    warnings: string[];
    errorMessage: string | null;
    updatedAt: string | null;
  };
};

export type UpsertEffectPromptItemRequest = Pick<
  EffectPromptItem,
  'content' | 'fragmentType' | 'materialTags' | 'dimensions'
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

export const effectPromptFragmentTypeTargetCounts = (
  settings: Pick<EffectPromptBatchSettings, 'fragmentConfigs'>,
): Record<EffectPromptFragmentType, number> => {
  return Object.fromEntries(
    EFFECT_PROMPT_FRAGMENT_TYPES.map((fragmentType) => [
      fragmentType,
      settings.fragmentConfigs[fragmentType].count,
    ]),
  ) as Record<EffectPromptFragmentType, number>;
};

export const effectPromptTargetCount = (
  settings: Pick<EffectPromptBatchSettings, 'fragmentConfigs'>,
): number =>
  EFFECT_PROMPT_FRAGMENT_TYPES.reduce(
    (total, fragmentType) => total + settings.fragmentConfigs[fragmentType].count,
    0,
  );

export const normalizeEffectPromptSettings = (
  input: EffectPromptBatchSettings,
): EffectPromptBatchSettings => {
  const fragmentConfigs = Object.fromEntries(
    EFFECT_PROMPT_FRAGMENT_TYPES.map((fragmentType) => {
      const source = input.fragmentConfigs[fragmentType];
      return [
        fragmentType,
        {
          count: Math.min(
            EFFECT_PROMPT_LIMITS.maxCount,
            Math.max(EFFECT_PROMPT_LIMITS.minFragmentCount, Math.round(source.count)),
          ),
          durationSeconds: Math.min(
            EFFECT_PROMPT_LIMITS.maxDurationSeconds,
            Math.max(EFFECT_PROMPT_LIMITS.minDurationSeconds, Math.round(source.durationSeconds)),
          ),
        },
      ];
    }),
  ) as EffectPromptFragmentConfigs;
  return {
    fragmentConfigs,
    semanticLimit: Math.min(
      EFFECT_PROMPT_LIMITS.maxSemanticDuplicateRate,
      Math.max(EFFECT_PROMPT_LIMITS.minSemanticDuplicateRate, Math.round(input.semanticLimit)),
    ),
    visualLimit: Math.min(
      EFFECT_PROMPT_LIMITS.maxVisualOverlapRate,
      Math.max(EFFECT_PROMPT_LIMITS.minVisualOverlapRate, Math.round(input.visualLimit)),
    ),
  };
};

const legacyFragmentCounts = (totalCount: number): Record<EffectPromptFragmentType, number> => {
  const result = Object.fromEntries(
    EFFECT_PROMPT_FRAGMENT_TYPES.map((fragmentType) => [
      fragmentType,
      EFFECT_PROMPT_LIMITS.minFragmentCount,
    ]),
  ) as Record<EffectPromptFragmentType, number>;
  const remaining = totalCount - EFFECT_PROMPT_FRAGMENT_TYPES.length;
  const weighted = EFFECT_PROMPT_FRAGMENT_TYPES.map((fragmentType, order) => {
    const exact =
      (remaining * DEFAULT_EFFECT_PROMPT_FRAGMENT_CONFIGS[fragmentType].count) /
      EFFECT_PROMPT_LIMITS.defaultCount;
    const base = Math.floor(exact);
    result[fragmentType] += base;
    return { fragmentType, order, remainder: exact - base };
  });
  let unallocated = totalCount - Object.values(result).reduce((sum, value) => sum + value, 0);
  weighted
    .sort((left, right) => right.remainder - left.remainder || left.order - right.order)
    .forEach(({ fragmentType }) => {
      if (unallocated <= 0) return;
      result[fragmentType] += 1;
      unallocated -= 1;
    });
  return result;
};

export const migrateEffectPromptSettings = (
  value: unknown,
  sourceSchemaVersion = 1,
): EffectPromptBatchSettings => {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const source = value as Record<string, unknown>;
    const configs = source.fragmentConfigs;
    if (configs && typeof configs === 'object' && !Array.isArray(configs)) {
      const candidate = {
        fragmentConfigs: configs,
        semanticLimit: source.semanticLimit,
        visualLimit: source.visualLimit,
      } as EffectPromptBatchSettings;
      try {
        const normalized = normalizeEffectPromptSettings(candidate);
        const total = effectPromptTargetCount(normalized);
        if (total >= EFFECT_PROMPT_LIMITS.minCount && total <= EFFECT_PROMPT_LIMITS.maxCount)
          return normalized;
      } catch {
        // Fall through to the deterministic legacy migration.
      }
    }
    const rawCount = Number(source.count);
    const totalCount = Number.isInteger(rawCount)
      ? Math.min(EFFECT_PROMPT_LIMITS.maxCount, Math.max(EFFECT_PROMPT_LIMITS.minCount, rawCount))
      : EFFECT_PROMPT_LIMITS.defaultCount;
    const rawDuration = Number(source.durationSeconds);
    const durationSeconds =
      sourceSchemaVersion === 2 &&
      Number.isInteger(rawDuration) &&
      rawDuration >= EFFECT_PROMPT_LIMITS.minDurationSeconds &&
      rawDuration <= EFFECT_PROMPT_LIMITS.maxDurationSeconds
        ? rawDuration
        : EFFECT_PROMPT_LIMITS.defaultDurationSeconds;
    const counts = legacyFragmentCounts(totalCount);
    return {
      fragmentConfigs: Object.fromEntries(
        EFFECT_PROMPT_FRAGMENT_TYPES.map((fragmentType) => [
          fragmentType,
          { count: counts[fragmentType], durationSeconds },
        ]),
      ) as EffectPromptFragmentConfigs,
      semanticLimit:
        Number.isInteger(source.semanticLimit) &&
        Number(source.semanticLimit) >= EFFECT_PROMPT_LIMITS.minSemanticDuplicateRate &&
        Number(source.semanticLimit) <= EFFECT_PROMPT_LIMITS.maxSemanticDuplicateRate
          ? Number(source.semanticLimit)
          : EFFECT_PROMPT_LIMITS.defaultSemanticDuplicateRate,
      visualLimit:
        Number.isInteger(source.visualLimit) &&
        Number(source.visualLimit) >= EFFECT_PROMPT_LIMITS.minVisualOverlapRate &&
        Number(source.visualLimit) <= EFFECT_PROMPT_LIMITS.maxVisualOverlapRate
          ? Number(source.visualLimit)
          : EFFECT_PROMPT_LIMITS.defaultVisualOverlapRate,
    };
  }
  return normalizeEffectPromptSettings(DEFAULT_EFFECT_PROMPT_SETTINGS);
};
