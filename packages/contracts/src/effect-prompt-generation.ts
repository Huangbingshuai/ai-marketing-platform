import type { WorkingArtifactCommitStatus, WorkingArtifactCommitSummary } from './workflow-working';

export const EFFECT_PROMPT_SCHEMA_VERSION = 5 as const;
export const EFFECT_PROMPT_API_BASE =
  '/api/projects/:projectId/workflows/effect/prompt-generation' as const;

export const EFFECT_PROMPT_LIMITS = {
  minCount: 10,
  maxCount: 200,
  defaultCount: 50,
  minFragmentCount: 1,
  minDurationSeconds: 4,
  maxDurationSeconds: 15,
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

export const EFFECT_PROMPT_RENDER_CAPABILITY_KEYS = [
  'SEEDANCE_2_0',
  'SEEDANCE_2_0_FAST',
  'SEEDANCE_1_5_PRO',
  'SEEDANCE_1_0',
] as const;
export type EffectPromptRenderCapabilityKey = (typeof EFFECT_PROMPT_RENDER_CAPABILITY_KEYS)[number];

export const SEEDANCE_RATIOS = ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9', 'adaptive'] as const;
export type SeedanceRatio = (typeof SEEDANCE_RATIOS)[number];
export const SEEDANCE_RESOLUTIONS = ['480p', '720p', '1080p'] as const;
export type SeedanceResolution = (typeof SEEDANCE_RESOLUTIONS)[number];

export type EffectPromptRenderCapability = {
  key: EffectPromptRenderCapabilityKey;
  minDurationSeconds: number;
  maxDurationSeconds: number;
  ratios: readonly SeedanceRatio[];
  resolutions: readonly SeedanceResolution[];
};

export const EFFECT_PROMPT_RENDER_CAPABILITIES: Record<
  EffectPromptRenderCapabilityKey,
  EffectPromptRenderCapability
> = {
  SEEDANCE_2_0: {
    key: 'SEEDANCE_2_0',
    minDurationSeconds: 4,
    maxDurationSeconds: 15,
    ratios: SEEDANCE_RATIOS,
    resolutions: SEEDANCE_RESOLUTIONS,
  },
  SEEDANCE_2_0_FAST: {
    key: 'SEEDANCE_2_0_FAST',
    minDurationSeconds: 4,
    maxDurationSeconds: 15,
    ratios: SEEDANCE_RATIOS,
    resolutions: ['480p', '720p'],
  },
  SEEDANCE_1_5_PRO: {
    key: 'SEEDANCE_1_5_PRO',
    minDurationSeconds: 4,
    maxDurationSeconds: 12,
    ratios: SEEDANCE_RATIOS,
    resolutions: SEEDANCE_RESOLUTIONS,
  },
  SEEDANCE_1_0: {
    key: 'SEEDANCE_1_0',
    minDurationSeconds: 2,
    maxDurationSeconds: 12,
    ratios: SEEDANCE_RATIOS,
    resolutions: SEEDANCE_RESOLUTIONS,
  },
};

export type EffectPromptRenderProfile = {
  ratio: SeedanceRatio;
  resolution: SeedanceResolution;
  capabilityKey: EffectPromptRenderCapabilityKey;
  sharedConstraints: {
    disabledElements: string[];
    /** @deprecated Historical V5 compatibility only. New batches use batch-level sharedPrompt. */
    prompt?: string;
    contentHash: string;
  };
};

export const EFFECT_PROMPT_SHARED_PROMPT_SOURCES = ['SYSTEM', 'USER'] as const;
export type EffectPromptSharedPromptSource = (typeof EFFECT_PROMPT_SHARED_PROMPT_SOURCES)[number];

export type EffectPromptSharedPromptSection = {
  key: string;
  title: string;
  source: EffectPromptSharedPromptSource;
  content: string;
  editable: boolean;
  sourceHash: string;
};

export type EffectPromptSharedPrompt = {
  schemaVersion: 1;
  sections: EffectPromptSharedPromptSection[];
  compiledContent: string;
  contentHash: string;
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

export const EFFECT_PROMPT_INSIGHT_FIELDS = [
  'PRODUCT_NAME',
  'PRODUCT_CATEGORY',
  'CORE_SPECIFICATION',
  'PRICE_RANGE',
  'VISUAL_FEATURES',
  'CORE_SELLING_POINT',
  'SECONDARY_SELLING_POINT',
  'TRUST_BACKING',
  'TARGET_AUDIENCE',
  'CORE_PAIN_POINT',
  'DECISION_DRIVER',
  'MARKETING_GOAL',
  'USAGE_SCENARIO',
  'PURCHASE_SCENARIO',
  'EMOTIONAL_SCENARIO',
  'SOURCE_DURATION',
  'ASPECT_RATIO',
  'DELIVERY_CHANNELS',
  'DISABLED_ELEMENT',
  'VISUAL_STYLE_BASELINE',
] as const;
export type EffectPromptInsightField = (typeof EFFECT_PROMPT_INSIGHT_FIELDS)[number];

export const EFFECT_PROMPT_INSIGHT_FIELD_FRAGMENT_TYPES: Partial<
  Record<EffectPromptInsightField, readonly EffectPromptFragmentType[]>
> = {
  PRODUCT_NAME: ['PRODUCT_DISPLAY', 'SELLING_POINT_EXPLANATION', 'CTA', 'OUTRO'],
  PRODUCT_CATEGORY: ['HOOK', 'PRODUCT_DISPLAY', 'OUTRO'],
  CORE_SPECIFICATION: ['PRODUCT_DISPLAY', 'SELLING_POINT_EXPLANATION'],
  PRICE_RANGE: ['CTA'],
  VISUAL_FEATURES: ['PRODUCT_DISPLAY', 'OUTRO'],
  CORE_SELLING_POINT: ['PRODUCT_DISPLAY', 'SELLING_POINT_EXPLANATION', 'CTA'],
  SECONDARY_SELLING_POINT: ['SELLING_POINT_EXPLANATION'],
  TRUST_BACKING: ['SELLING_POINT_EXPLANATION'],
  TARGET_AUDIENCE: ['HOOK', 'PAIN', 'CTA'],
  CORE_PAIN_POINT: ['HOOK', 'PAIN'],
  DECISION_DRIVER: ['HOOK', 'SELLING_POINT_EXPLANATION', 'CTA'],
  MARKETING_GOAL: ['CTA'],
  USAGE_SCENARIO: ['HOOK', 'PAIN', 'PRODUCT_DISPLAY'],
  PURCHASE_SCENARIO: ['HOOK', 'PAIN', 'CTA'],
  EMOTIONAL_SCENARIO: ['HOOK', 'OUTRO'],
};

export const EFFECT_PROMPT_INSIGHT_ROLES = ['PRIMARY', 'CONTEXT', 'EVIDENCE'] as const;
export type EffectPromptInsightRole = (typeof EFFECT_PROMPT_INSIGHT_ROLES)[number];

export type EffectPromptInsightReference = {
  factId: string;
  field: EffectPromptInsightField;
  value: string;
  valueHash: string;
};

export type EffectPromptInsightBinding = EffectPromptInsightReference & {
  role: EffectPromptInsightRole;
};

export type EffectPromptExcludedInsight = EffectPromptInsightReference & {
  reason: 'UNCERTAIN' | 'EMPTY' | 'UNSUPPORTED';
};

export type EffectPromptInsightCoverage = {
  required: EffectPromptInsightReference[];
  covered: EffectPromptInsightReference[];
  missing: EffectPromptInsightReference[];
  adaptive: EffectPromptInsightReference[];
  deferred: EffectPromptInsightReference[];
  excluded: EffectPromptExcludedInsight[];
  appliedConstraints: EffectPromptInsightReference[];
};

export type EffectPromptItem = {
  id: string;
  code: string;
  origin: EffectPromptItemOrigin;
  fragmentType: EffectPromptFragmentType;
  materialTags: string[];
  targetDurationSeconds: number;
  dimensions: EffectPromptDimensions;
  content: string;
  insightBindings: EffectPromptInsightBinding[];
  manualEdited: boolean;
  createdAt: string;
  updatedAt: string;
};

export type EffectPromptMetrics = {
  targetCount: number;
  acceptedCount: number;
  generatedCandidateCount: number;
  fallbackCount: number;
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
  insightCoverage: EffectPromptInsightCoverage;
  removedExecutionInvalid: number;
  executionInvalidReasons: Array<{ code: string; count: number }>;
};

export const EFFECT_PROMPT_QUALITY_STATUSES = ['PASS', 'NEEDS_REVIEW'] as const;
export type EffectPromptQualityStatus = (typeof EFFECT_PROMPT_QUALITY_STATUSES)[number];

export type EffectPromptBatchResult = {
  schemaVersion: typeof EFFECT_PROMPT_SCHEMA_VERSION;
  settings: EffectPromptBatchSettings;
  renderProfile: EffectPromptRenderProfile;
  /** Optional only so historical V5 batches remain readable. New batches always provide it. */
  sharedPrompt?: EffectPromptSharedPrompt;
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
export const EFFECT_PROMPT_MAX_RUN_ATTEMPTS = 3;
export const EFFECT_PROMPT_ERROR_CODES = [
  'AI_TIMEOUT',
  'AI_NETWORK',
  'AI_RATE_LIMIT',
  'AI_SERVICE',
  'AI_OUTPUT_TRUNCATED',
  'AI_RESPONSE_INCOMPLETE',
  'AI_RESPONSE_INVALID',
  'AI_REQUEST_REJECTED',
  'AI_UNKNOWN',
] as const;
export type EffectPromptErrorCode = (typeof EFFECT_PROMPT_ERROR_CODES)[number];

export const EFFECT_PROMPT_STAGE_STATUSES = [
  'PENDING',
  'RUNNING',
  'SUCCEEDED',
  'PARTIAL',
  'SKIPPED',
  'FAILED',
] as const;
export type EffectPromptStageStatus = (typeof EFFECT_PROMPT_STAGE_STATUSES)[number];

export const EFFECT_PROMPT_SHARD_PHASES = ['BLUEPRINT', 'PROMPT'] as const;
export type EffectPromptShardPhase = (typeof EFFECT_PROMPT_SHARD_PHASES)[number];

export const EFFECT_PROMPT_GRAPH_VERSIONS = [
  'V8_SINGLE_STRATEGY',
  'V9_SIX_BRANCH_STRATEGY',
  'V10_RELATION_COORDINATE_BLUEPRINT',
] as const;
export type EffectPromptGraphVersion = (typeof EFFECT_PROMPT_GRAPH_VERSIONS)[number];
export const CURRENT_EFFECT_PROMPT_GRAPH_VERSION: EffectPromptGraphVersion =
  'V10_RELATION_COORDINATE_BLUEPRINT';

export const EFFECT_PROMPT_GRAPH_NODES = [
  { id: 'LOAD_AND_SNAPSHOT', label: '输入快照', group: 'SNAPSHOT' },
  { id: 'INSIGHT_MAPPING', label: '提炼信息应用映射', group: 'PLANNING' },
  { id: 'SHARED_PROMPT_COMPILATION', label: '共用提示词编译', group: 'PLANNING' },
  { id: 'STRATEGY_PLANNING', label: '营销关系规划', group: 'PLANNING' },
  { id: 'GLOBAL_FACT_ALLOCATION', label: '全局事实分配', group: 'PLANNING' },
  { id: 'STRATEGY_FRAGMENT_ROUTER', label: '营销规划条件路由', group: 'ROUTER' },
  { id: 'PLAN_HOOK_STRATEGY', label: '钩子营销规划', group: 'STRATEGY' },
  { id: 'PLAN_PAIN_STRATEGY', label: '痛点营销规划', group: 'STRATEGY' },
  { id: 'PLAN_PRODUCT_DISPLAY_STRATEGY', label: '产品展示营销规划', group: 'STRATEGY' },
  {
    id: 'PLAN_SELLING_POINT_EXPLANATION_STRATEGY',
    label: '卖点讲解营销规划',
    group: 'STRATEGY',
  },
  { id: 'PLAN_CTA_STRATEGY', label: '结尾转化营销规划', group: 'STRATEGY' },
  { id: 'PLAN_OUTRO_STRATEGY', label: '片尾品牌营销规划', group: 'STRATEGY' },
  { id: 'STRATEGY_MERGE_VALIDATION', label: '营销规划合并校验', group: 'PLANNING' },
  { id: 'RELATIONSHIP_FRAGMENT_ROUTER', label: '营销组合条件路由', group: 'ROUTER' },
  { id: 'PLAN_HOOK_RELATIONSHIPS', label: '钩子营销组合', group: 'STRATEGY' },
  { id: 'PLAN_PAIN_RELATIONSHIPS', label: '痛点营销组合', group: 'STRATEGY' },
  {
    id: 'PLAN_PRODUCT_DISPLAY_RELATIONSHIPS',
    label: '产品展示营销组合',
    group: 'STRATEGY',
  },
  {
    id: 'PLAN_SELLING_POINT_EXPLANATION_RELATIONSHIPS',
    label: '卖点讲解营销组合',
    group: 'STRATEGY',
  },
  { id: 'PLAN_CTA_RELATIONSHIPS', label: '结尾转化营销组合', group: 'STRATEGY' },
  { id: 'PLAN_OUTRO_RELATIONSHIPS', label: '片尾品牌营销组合', group: 'STRATEGY' },
  { id: 'RELATIONSHIP_MERGE_VALIDATION', label: '营销组合合并校验', group: 'PLANNING' },
  { id: 'DIMENSION_COORDINATE_ROUTER', label: '六维坐标条件路由', group: 'ROUTER' },
  { id: 'PLAN_HOOK_COORDINATES', label: '钩子六维坐标规划', group: 'COORDINATE' },
  { id: 'PLAN_PAIN_COORDINATES', label: '痛点六维坐标规划', group: 'COORDINATE' },
  {
    id: 'PLAN_PRODUCT_DISPLAY_COORDINATES',
    label: '产品展示六维坐标规划',
    group: 'COORDINATE',
  },
  {
    id: 'PLAN_SELLING_POINT_EXPLANATION_COORDINATES',
    label: '卖点讲解六维坐标规划',
    group: 'COORDINATE',
  },
  { id: 'PLAN_CTA_COORDINATES', label: '结尾转化六维坐标规划', group: 'COORDINATE' },
  { id: 'PLAN_OUTRO_COORDINATES', label: '片尾品牌六维坐标规划', group: 'COORDINATE' },
  { id: 'COORDINATE_MERGE_VALIDATION', label: '六维坐标合并校验', group: 'PLANNING' },
  { id: 'BLUEPRINT_QUOTA_ALLOCATION', label: '蓝图配额分配', group: 'PLANNING' },
  { id: 'BLUEPRINT_FRAGMENT_ROUTER', label: '蓝图类型条件路由', group: 'ROUTER' },
  { id: 'GENERATE_HOOK_BLUEPRINTS', label: '钩子蓝图生成', group: 'BLUEPRINT' },
  { id: 'GENERATE_PAIN_BLUEPRINTS', label: '痛点蓝图生成', group: 'BLUEPRINT' },
  {
    id: 'GENERATE_PRODUCT_DISPLAY_BLUEPRINTS',
    label: '产品展示蓝图生成',
    group: 'BLUEPRINT',
  },
  {
    id: 'GENERATE_SELLING_POINT_EXPLANATION_BLUEPRINTS',
    label: '卖点讲解蓝图生成',
    group: 'BLUEPRINT',
  },
  { id: 'GENERATE_CTA_BLUEPRINTS', label: '结尾转化蓝图生成', group: 'BLUEPRINT' },
  { id: 'GENERATE_OUTRO_BLUEPRINTS', label: '片尾品牌蓝图生成', group: 'BLUEPRINT' },
  { id: 'BLUEPRINT_ORTHOGONAL_GATE', label: '全批次蓝图正交校验', group: 'QUALITY' },
  { id: 'DIMENSION_COMBINATION', label: '片段蓝图编排', group: 'PLANNING' },
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
  { id: 'INSIGHT_COVERAGE', label: '提炼信息覆盖校验', group: 'QUALITY' },
  { id: 'QUALITY_GATE', label: '质量门禁', group: 'QUALITY' },
  { id: 'REPLENISH', label: '定向补齐', group: 'REPLENISH' },
  { id: 'RESULT_SAVE', label: '结果保存', group: 'RESULT' },
] as const;
export type EffectPromptNodeId = (typeof EFFECT_PROMPT_GRAPH_NODES)[number]['id'];

export const EFFECT_PROMPT_V8_GRAPH_NODE_IDS = [
  'LOAD_AND_SNAPSHOT',
  'INSIGHT_MAPPING',
  'SHARED_PROMPT_COMPILATION',
  'STRATEGY_PLANNING',
  'DIMENSION_COMBINATION',
  'FRAGMENT_TYPE_ROUTER',
  'GENERATE_HOOK',
  'GENERATE_PAIN',
  'GENERATE_PRODUCT_DISPLAY',
  'GENERATE_SELLING_POINT_EXPLANATION',
  'GENERATE_CTA',
  'GENERATE_OUTRO',
  'NORMALIZATION',
  'SEMANTIC_DEDUP',
  'VISUAL_DEDUP',
  'INSIGHT_COVERAGE',
  'QUALITY_GATE',
  'REPLENISH',
  'RESULT_SAVE',
] as const satisfies readonly EffectPromptNodeId[];

export const EFFECT_PROMPT_V9_GRAPH_NODE_IDS = [
  'LOAD_AND_SNAPSHOT',
  'INSIGHT_MAPPING',
  'SHARED_PROMPT_COMPILATION',
  'GLOBAL_FACT_ALLOCATION',
  'STRATEGY_FRAGMENT_ROUTER',
  'PLAN_HOOK_STRATEGY',
  'PLAN_PAIN_STRATEGY',
  'PLAN_PRODUCT_DISPLAY_STRATEGY',
  'PLAN_SELLING_POINT_EXPLANATION_STRATEGY',
  'PLAN_CTA_STRATEGY',
  'PLAN_OUTRO_STRATEGY',
  'STRATEGY_MERGE_VALIDATION',
  'DIMENSION_COMBINATION',
  'FRAGMENT_TYPE_ROUTER',
  'GENERATE_HOOK',
  'GENERATE_PAIN',
  'GENERATE_PRODUCT_DISPLAY',
  'GENERATE_SELLING_POINT_EXPLANATION',
  'GENERATE_CTA',
  'GENERATE_OUTRO',
  'NORMALIZATION',
  'SEMANTIC_DEDUP',
  'VISUAL_DEDUP',
  'INSIGHT_COVERAGE',
  'QUALITY_GATE',
  'REPLENISH',
  'RESULT_SAVE',
] as const satisfies readonly EffectPromptNodeId[];

export const EFFECT_PROMPT_V10_GRAPH_NODE_IDS = [
  'LOAD_AND_SNAPSHOT',
  'INSIGHT_MAPPING',
  'SHARED_PROMPT_COMPILATION',
  'GLOBAL_FACT_ALLOCATION',
  'RELATIONSHIP_FRAGMENT_ROUTER',
  'PLAN_HOOK_RELATIONSHIPS',
  'PLAN_PAIN_RELATIONSHIPS',
  'PLAN_PRODUCT_DISPLAY_RELATIONSHIPS',
  'PLAN_SELLING_POINT_EXPLANATION_RELATIONSHIPS',
  'PLAN_CTA_RELATIONSHIPS',
  'PLAN_OUTRO_RELATIONSHIPS',
  'RELATIONSHIP_MERGE_VALIDATION',
  'DIMENSION_COORDINATE_ROUTER',
  'PLAN_HOOK_COORDINATES',
  'PLAN_PAIN_COORDINATES',
  'PLAN_PRODUCT_DISPLAY_COORDINATES',
  'PLAN_SELLING_POINT_EXPLANATION_COORDINATES',
  'PLAN_CTA_COORDINATES',
  'PLAN_OUTRO_COORDINATES',
  'COORDINATE_MERGE_VALIDATION',
  'BLUEPRINT_QUOTA_ALLOCATION',
  'BLUEPRINT_FRAGMENT_ROUTER',
  'GENERATE_HOOK_BLUEPRINTS',
  'GENERATE_PAIN_BLUEPRINTS',
  'GENERATE_PRODUCT_DISPLAY_BLUEPRINTS',
  'GENERATE_SELLING_POINT_EXPLANATION_BLUEPRINTS',
  'GENERATE_CTA_BLUEPRINTS',
  'GENERATE_OUTRO_BLUEPRINTS',
  'BLUEPRINT_ORTHOGONAL_GATE',
  'FRAGMENT_TYPE_ROUTER',
  'GENERATE_HOOK',
  'GENERATE_PAIN',
  'GENERATE_PRODUCT_DISPLAY',
  'GENERATE_SELLING_POINT_EXPLANATION',
  'GENERATE_CTA',
  'GENERATE_OUTRO',
  'NORMALIZATION',
  'SEMANTIC_DEDUP',
  'VISUAL_DEDUP',
  'INSIGHT_COVERAGE',
  'QUALITY_GATE',
  'REPLENISH',
  'RESULT_SAVE',
] as const satisfies readonly EffectPromptNodeId[];

export const EFFECT_PROMPT_V8_GRAPH_EDGES = [
  { from: 'LOAD_AND_SNAPSHOT', to: 'INSIGHT_MAPPING' },
  { from: 'INSIGHT_MAPPING', to: 'SHARED_PROMPT_COMPILATION' },
  { from: 'SHARED_PROMPT_COMPILATION', to: 'STRATEGY_PLANNING' },
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
  { from: 'SEMANTIC_DEDUP', to: 'INSIGHT_COVERAGE' },
  { from: 'VISUAL_DEDUP', to: 'INSIGHT_COVERAGE' },
  { from: 'INSIGHT_COVERAGE', to: 'QUALITY_GATE' },
  { from: 'QUALITY_GATE', to: 'REPLENISH' },
  { from: 'QUALITY_GATE', to: 'RESULT_SAVE' },
  { from: 'REPLENISH', to: 'FRAGMENT_TYPE_ROUTER' },
] as const satisfies ReadonlyArray<{ from: EffectPromptNodeId; to: EffectPromptNodeId }>;

export const EFFECT_PROMPT_V9_GRAPH_EDGES = [
  { from: 'LOAD_AND_SNAPSHOT', to: 'INSIGHT_MAPPING' },
  { from: 'INSIGHT_MAPPING', to: 'SHARED_PROMPT_COMPILATION' },
  { from: 'SHARED_PROMPT_COMPILATION', to: 'GLOBAL_FACT_ALLOCATION' },
  { from: 'GLOBAL_FACT_ALLOCATION', to: 'STRATEGY_FRAGMENT_ROUTER' },
  { from: 'STRATEGY_FRAGMENT_ROUTER', to: 'PLAN_HOOK_STRATEGY' },
  { from: 'STRATEGY_FRAGMENT_ROUTER', to: 'PLAN_PAIN_STRATEGY' },
  { from: 'STRATEGY_FRAGMENT_ROUTER', to: 'PLAN_PRODUCT_DISPLAY_STRATEGY' },
  { from: 'STRATEGY_FRAGMENT_ROUTER', to: 'PLAN_SELLING_POINT_EXPLANATION_STRATEGY' },
  { from: 'STRATEGY_FRAGMENT_ROUTER', to: 'PLAN_CTA_STRATEGY' },
  { from: 'STRATEGY_FRAGMENT_ROUTER', to: 'PLAN_OUTRO_STRATEGY' },
  { from: 'PLAN_HOOK_STRATEGY', to: 'STRATEGY_MERGE_VALIDATION' },
  { from: 'PLAN_PAIN_STRATEGY', to: 'STRATEGY_MERGE_VALIDATION' },
  { from: 'PLAN_PRODUCT_DISPLAY_STRATEGY', to: 'STRATEGY_MERGE_VALIDATION' },
  { from: 'PLAN_SELLING_POINT_EXPLANATION_STRATEGY', to: 'STRATEGY_MERGE_VALIDATION' },
  { from: 'PLAN_CTA_STRATEGY', to: 'STRATEGY_MERGE_VALIDATION' },
  { from: 'PLAN_OUTRO_STRATEGY', to: 'STRATEGY_MERGE_VALIDATION' },
  { from: 'STRATEGY_MERGE_VALIDATION', to: 'DIMENSION_COMBINATION' },
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
  { from: 'SEMANTIC_DEDUP', to: 'INSIGHT_COVERAGE' },
  { from: 'VISUAL_DEDUP', to: 'INSIGHT_COVERAGE' },
  { from: 'INSIGHT_COVERAGE', to: 'QUALITY_GATE' },
  { from: 'QUALITY_GATE', to: 'REPLENISH' },
  { from: 'QUALITY_GATE', to: 'RESULT_SAVE' },
  { from: 'REPLENISH', to: 'FRAGMENT_TYPE_ROUTER' },
] as const satisfies ReadonlyArray<{ from: EffectPromptNodeId; to: EffectPromptNodeId }>;

export const EFFECT_PROMPT_V10_GRAPH_EDGES = [
  { from: 'LOAD_AND_SNAPSHOT', to: 'INSIGHT_MAPPING' },
  { from: 'INSIGHT_MAPPING', to: 'SHARED_PROMPT_COMPILATION' },
  { from: 'SHARED_PROMPT_COMPILATION', to: 'GLOBAL_FACT_ALLOCATION' },
  { from: 'GLOBAL_FACT_ALLOCATION', to: 'RELATIONSHIP_FRAGMENT_ROUTER' },
  { from: 'RELATIONSHIP_FRAGMENT_ROUTER', to: 'PLAN_HOOK_RELATIONSHIPS' },
  { from: 'RELATIONSHIP_FRAGMENT_ROUTER', to: 'PLAN_PAIN_RELATIONSHIPS' },
  { from: 'RELATIONSHIP_FRAGMENT_ROUTER', to: 'PLAN_PRODUCT_DISPLAY_RELATIONSHIPS' },
  {
    from: 'RELATIONSHIP_FRAGMENT_ROUTER',
    to: 'PLAN_SELLING_POINT_EXPLANATION_RELATIONSHIPS',
  },
  { from: 'RELATIONSHIP_FRAGMENT_ROUTER', to: 'PLAN_CTA_RELATIONSHIPS' },
  { from: 'RELATIONSHIP_FRAGMENT_ROUTER', to: 'PLAN_OUTRO_RELATIONSHIPS' },
  { from: 'PLAN_HOOK_RELATIONSHIPS', to: 'RELATIONSHIP_MERGE_VALIDATION' },
  { from: 'PLAN_PAIN_RELATIONSHIPS', to: 'RELATIONSHIP_MERGE_VALIDATION' },
  { from: 'PLAN_PRODUCT_DISPLAY_RELATIONSHIPS', to: 'RELATIONSHIP_MERGE_VALIDATION' },
  {
    from: 'PLAN_SELLING_POINT_EXPLANATION_RELATIONSHIPS',
    to: 'RELATIONSHIP_MERGE_VALIDATION',
  },
  { from: 'PLAN_CTA_RELATIONSHIPS', to: 'RELATIONSHIP_MERGE_VALIDATION' },
  { from: 'PLAN_OUTRO_RELATIONSHIPS', to: 'RELATIONSHIP_MERGE_VALIDATION' },
  { from: 'RELATIONSHIP_MERGE_VALIDATION', to: 'DIMENSION_COORDINATE_ROUTER' },
  { from: 'DIMENSION_COORDINATE_ROUTER', to: 'PLAN_HOOK_COORDINATES' },
  { from: 'DIMENSION_COORDINATE_ROUTER', to: 'PLAN_PAIN_COORDINATES' },
  { from: 'DIMENSION_COORDINATE_ROUTER', to: 'PLAN_PRODUCT_DISPLAY_COORDINATES' },
  {
    from: 'DIMENSION_COORDINATE_ROUTER',
    to: 'PLAN_SELLING_POINT_EXPLANATION_COORDINATES',
  },
  { from: 'DIMENSION_COORDINATE_ROUTER', to: 'PLAN_CTA_COORDINATES' },
  { from: 'DIMENSION_COORDINATE_ROUTER', to: 'PLAN_OUTRO_COORDINATES' },
  { from: 'PLAN_HOOK_COORDINATES', to: 'COORDINATE_MERGE_VALIDATION' },
  { from: 'PLAN_PAIN_COORDINATES', to: 'COORDINATE_MERGE_VALIDATION' },
  { from: 'PLAN_PRODUCT_DISPLAY_COORDINATES', to: 'COORDINATE_MERGE_VALIDATION' },
  {
    from: 'PLAN_SELLING_POINT_EXPLANATION_COORDINATES',
    to: 'COORDINATE_MERGE_VALIDATION',
  },
  { from: 'PLAN_CTA_COORDINATES', to: 'COORDINATE_MERGE_VALIDATION' },
  { from: 'PLAN_OUTRO_COORDINATES', to: 'COORDINATE_MERGE_VALIDATION' },
  { from: 'COORDINATE_MERGE_VALIDATION', to: 'BLUEPRINT_QUOTA_ALLOCATION' },
  { from: 'BLUEPRINT_QUOTA_ALLOCATION', to: 'BLUEPRINT_FRAGMENT_ROUTER' },
  { from: 'BLUEPRINT_FRAGMENT_ROUTER', to: 'GENERATE_HOOK_BLUEPRINTS' },
  { from: 'BLUEPRINT_FRAGMENT_ROUTER', to: 'GENERATE_PAIN_BLUEPRINTS' },
  { from: 'BLUEPRINT_FRAGMENT_ROUTER', to: 'GENERATE_PRODUCT_DISPLAY_BLUEPRINTS' },
  {
    from: 'BLUEPRINT_FRAGMENT_ROUTER',
    to: 'GENERATE_SELLING_POINT_EXPLANATION_BLUEPRINTS',
  },
  { from: 'BLUEPRINT_FRAGMENT_ROUTER', to: 'GENERATE_CTA_BLUEPRINTS' },
  { from: 'BLUEPRINT_FRAGMENT_ROUTER', to: 'GENERATE_OUTRO_BLUEPRINTS' },
  { from: 'GENERATE_HOOK_BLUEPRINTS', to: 'BLUEPRINT_ORTHOGONAL_GATE' },
  { from: 'GENERATE_PAIN_BLUEPRINTS', to: 'BLUEPRINT_ORTHOGONAL_GATE' },
  { from: 'GENERATE_PRODUCT_DISPLAY_BLUEPRINTS', to: 'BLUEPRINT_ORTHOGONAL_GATE' },
  {
    from: 'GENERATE_SELLING_POINT_EXPLANATION_BLUEPRINTS',
    to: 'BLUEPRINT_ORTHOGONAL_GATE',
  },
  { from: 'GENERATE_CTA_BLUEPRINTS', to: 'BLUEPRINT_ORTHOGONAL_GATE' },
  { from: 'GENERATE_OUTRO_BLUEPRINTS', to: 'BLUEPRINT_ORTHOGONAL_GATE' },
  { from: 'BLUEPRINT_ORTHOGONAL_GATE', to: 'FRAGMENT_TYPE_ROUTER' },
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
  { from: 'SEMANTIC_DEDUP', to: 'INSIGHT_COVERAGE' },
  { from: 'VISUAL_DEDUP', to: 'INSIGHT_COVERAGE' },
  { from: 'INSIGHT_COVERAGE', to: 'QUALITY_GATE' },
  { from: 'QUALITY_GATE', to: 'REPLENISH' },
  { from: 'QUALITY_GATE', to: 'RESULT_SAVE' },
  { from: 'REPLENISH', to: 'BLUEPRINT_FRAGMENT_ROUTER' },
] as const satisfies ReadonlyArray<{ from: EffectPromptNodeId; to: EffectPromptNodeId }>;

/** Current topology alias retained for existing consumers. */
export const EFFECT_PROMPT_GRAPH_EDGES = EFFECT_PROMPT_V10_GRAPH_EDGES;

export const effectPromptGraphNodeIds = (
  version: EffectPromptGraphVersion,
): readonly EffectPromptNodeId[] =>
  version === 'V8_SINGLE_STRATEGY'
    ? EFFECT_PROMPT_V8_GRAPH_NODE_IDS
    : version === 'V9_SIX_BRANCH_STRATEGY'
      ? EFFECT_PROMPT_V9_GRAPH_NODE_IDS
      : EFFECT_PROMPT_V10_GRAPH_NODE_IDS;

export const effectPromptGraphEdges = (
  version: EffectPromptGraphVersion,
): ReadonlyArray<{ from: EffectPromptNodeId; to: EffectPromptNodeId }> =>
  version === 'V8_SINGLE_STRATEGY'
    ? EFFECT_PROMPT_V8_GRAPH_EDGES
    : version === 'V9_SIX_BRANCH_STRATEGY'
      ? EFFECT_PROMPT_V9_GRAPH_EDGES
      : EFFECT_PROMPT_V10_GRAPH_EDGES;

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
  graphVersion: EffectPromptGraphVersion;
  progress: number;
  attemptCount: number;
  maxAttempts: number;
  currentNode: EffectPromptNodeId | 'COMPLETED' | null;
  warnings: string[];
  errorCode: EffectPromptErrorCode | string | null;
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
  graphVersion: EffectPromptGraphVersion;
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
  errorCode: EffectPromptErrorCode | string | null;
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
  resultId: string | null;
  revision: number | null;
  /** Read-only candidates recovered from a failed run; never a committed short batch. */
  isPartialPreview: boolean;
  previewRunId: string | null;
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
  regenerationInstruction?: string | undefined;
  replacementDimensions?: EffectPromptDimensions | undefined;
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
export const EFFECT_PROMPT_NODE_DETAIL_LIMITS = {
  maxSamples: 3,
  maxTagValues: 8,
  maxIssues: 8,
} as const;

export type EffectPromptNodeDetailField = {
  label: string;
  value: string | number;
  description?: string | undefined;
};

export type EffectPromptNodeDetailPrompt = Pick<
  EffectPromptItem,
  'code' | 'fragmentType' | 'materialTags' | 'targetDurationSeconds' | 'dimensions' | 'content'
>;

export type EffectPromptNodeDetailBlueprint = {
  title: string;
  fragmentType: EffectPromptFragmentType;
  relationshipTitle: string;
  targetDurationSeconds: number;
  dimensions: EffectPromptDimensions;
  openingState: string;
  actionArc: string;
  endingState: string;
};

export type EffectPromptNodeDetailBlock =
  | {
      kind: 'RELATIONSHIP_LIST';
      title: string;
      items: Array<{
        title: string;
        fragmentType: EffectPromptFragmentType;
        primaryFact: string;
        auxiliaryFacts: string[];
        creativeIntent: string;
        blueprintQuota: number;
      }>;
    }
  | {
      kind: 'COORDINATE_LIST';
      title: string;
      groups: Array<{
        dimension: EffectPromptDimensionKey;
        label: string;
        items: Array<{
          value: string;
          compatibleBundleCount: number;
          sourceFacts: string[];
        }>;
      }>;
    }
  | {
      kind: 'BLUEPRINT_LIST';
      title: string;
      items: EffectPromptNodeDetailBlueprint[];
    }
  | {
      kind: 'ORTHOGONAL_PAIR_LIST';
      title: string;
      items: Array<{
        distance: number;
        sameDimensions: EffectPromptDimensionKey[];
        left: EffectPromptNodeDetailBlueprint;
        right: EffectPromptNodeDetailBlueprint;
      }>;
    }
  | {
      kind: 'TAG_LIST';
      title: string;
      groups: Array<{ label: string; values: string[]; remainingCount: number }>;
    }
  | {
      kind: 'COMBINATION_LIST';
      title: string;
      items: Array<{
        title: string;
        fragmentType: EffectPromptFragmentType;
        targetDurationSeconds: number;
        dimensions: EffectPromptDimensions;
        visibleAction: string;
        evidenceMode: string;
      }>;
    }
  | {
      kind: 'ROUTE_LIST';
      title: string;
      items: Array<{
        fragmentType: EffectPromptFragmentType;
        targetCount: number;
        candidateCount: number;
        totalShards: number;
        completedShards: number;
        failedShards: number;
        status: EffectPromptStageStatus;
      }>;
    }
  | {
      kind: 'PROMPT_LIST';
      title: string;
      items: EffectPromptNodeDetailPrompt[];
    }
  | {
      kind: 'PAIR_LIST';
      title: string;
      metric: 'SEMANTIC' | 'VISUAL';
      items: Array<{
        score: number;
        reasons: string[];
        left: EffectPromptNodeDetailPrompt;
        right: EffectPromptNodeDetailPrompt;
      }>;
    }
  | {
      kind: 'ISSUE_LIST';
      title: string;
      items: Array<{ code: string; label: string; count: number; examples: string[] }>;
    };

export type GetEffectPromptNodeDetailData = {
  detail: {
    nodeId: EffectPromptNodeId;
    status: EffectPromptStageStatus;
    summary: string;
    fields: EffectPromptNodeDetailField[];
    blocks: EffectPromptNodeDetailBlock[];
    warnings: string[];
    errorMessage: string | null;
    updatedAt: string | null;
  };
};

export type UpsertEffectPromptItemRequest = Pick<
  EffectPromptItem,
  'content' | 'fragmentType' | 'materialTags' | 'dimensions'
> & { expectedRevision: number };

export type UpdateEffectPromptSharedPromptRequest = {
  content: string;
  expectedRevision: number;
};

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
