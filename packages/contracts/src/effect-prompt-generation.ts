import type { WorkingArtifactCommitStatus, WorkingArtifactCommitSummary } from './workflow-working';

export const EFFECT_PROMPT_API_BASE =
  '/api/projects/:projectId/workflows/effect/prompt-generation' as const;

export const EFFECT_PROMPT_SEMANTIC_SIMILARITY_THRESHOLD = 0.82;
export const EFFECT_PROMPT_SEMANTIC_DUPLICATE_RATE_LIMIT = 15;

export const EFFECT_PROMPT_LIMITS = {
  minCount: 10,
  maxCount: 100,
  maxCandidateCount: 240,
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
  pageSize: 5,
  maxReplenishmentRounds: 3,
  shardSize: 8,
} as const;

export const EFFECT_PROMPT_DIMENSIONS = [
  { key: 'narrative', label: '叙事结构' },
  { key: 'scene', label: '场景变量' },
  { key: 'persona', label: '人物变量' },
  { key: 'productRelation', label: '产品关联点' },
  { key: 'camera', label: '镜头语言' },
  { key: 'emotion', label: '情绪基调' },
] as const;
export type EffectPromptDimensionKey = (typeof EFFECT_PROMPT_DIMENSIONS)[number]['key'];

export type EffectPromptDimensions = Record<EffectPromptDimensionKey, string>;

export const EFFECT_PROMPT_FRAGMENT_TYPES = ['HOOK', 'PRODUCT_DISPLAY', 'EFFECT', 'CTA'] as const;
export type EffectPromptFragmentType = (typeof EFFECT_PROMPT_FRAGMENT_TYPES)[number];

export const EFFECT_PROMPT_FRAGMENT_TYPE_LABELS: Record<EffectPromptFragmentType, string> = {
  HOOK: '钩子片段',
  PRODUCT_DISPLAY: '产品展示片段',
  EFFECT: '效果片段',
  CTA: '结尾转化片段',
};

export const EFFECT_PROMPT_LEGACY_FRAGMENT_TYPE_MAP = {
  HOOK: 'HOOK',
  PAIN: 'HOOK',
  PRODUCT_DISPLAY: 'PRODUCT_DISPLAY',
  SELLING_POINT_EXPLANATION: 'EFFECT',
  EFFECT: 'EFFECT',
  CTA: 'CTA',
  OUTRO: 'CTA',
} as const satisfies Record<string, EffectPromptFragmentType>;

export const normalizeEffectPromptFragmentType = (
  value: unknown,
): EffectPromptFragmentType | null =>
  typeof value === 'string'
    ? (EFFECT_PROMPT_LEGACY_FRAGMENT_TYPE_MAP[
        value as keyof typeof EFFECT_PROMPT_LEGACY_FRAGMENT_TYPE_MAP
      ] ?? null)
    : null;

export const normalizeEffectPromptFragmentTypes = (values: unknown): EffectPromptFragmentType[] =>
  Array.isArray(values)
    ? [
        ...new Set(
          values
            .map(normalizeEffectPromptFragmentType)
            .filter((value): value is EffectPromptFragmentType => value !== null),
        ),
      ]
    : [];

export const EFFECT_PROMPT_PURPOSE_MATCH_MODES = ['PRIMARY', 'PRIMARY_OR_COMPATIBLE'] as const;
export type EffectPromptPurposeMatchMode = (typeof EFFECT_PROMPT_PURPOSE_MATCH_MODES)[number];

export type EffectPromptBatchSettings = {
  targetCount: number;
  defaultDurationSeconds: number;
  /** Compatibility-optional for batches created before these settings moved to Prompt. */
  styleMode?: 'AI_AUTO' | 'FIXED';
  styleTone?: string | null;
  deliveryChannel?: string;
  disabledElements?: string[];
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
  sections: EffectPromptSharedPromptSection[];
  compiledContent: string;
  contentHash: string;
};

export const DEFAULT_EFFECT_PROMPT_SETTINGS: EffectPromptBatchSettings = {
  targetCount: EFFECT_PROMPT_LIMITS.defaultCount,
  defaultDurationSeconds: EFFECT_PROMPT_LIMITS.defaultDurationSeconds,
  styleMode: 'AI_AUTO',
  styleTone: null,
  deliveryChannel: '抖音',
  disabledElements: [],
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
  'RESOLUTION',
  'DELIVERY_CHANNELS',
  'DISABLED_ELEMENT',
  'VISUAL_STYLE_BASELINE',
] as const;
export type EffectPromptInsightField = (typeof EFFECT_PROMPT_INSIGHT_FIELDS)[number];

export const EFFECT_PROMPT_INSIGHT_FIELD_FRAGMENT_TYPES: Partial<
  Record<EffectPromptInsightField, readonly EffectPromptFragmentType[]>
> = {
  PRODUCT_NAME: ['PRODUCT_DISPLAY', 'EFFECT', 'CTA'],
  PRODUCT_CATEGORY: ['HOOK', 'PRODUCT_DISPLAY', 'CTA'],
  CORE_SPECIFICATION: ['PRODUCT_DISPLAY', 'EFFECT'],
  PRICE_RANGE: ['CTA'],
  VISUAL_FEATURES: ['PRODUCT_DISPLAY', 'CTA'],
  CORE_SELLING_POINT: ['PRODUCT_DISPLAY', 'EFFECT', 'CTA'],
  SECONDARY_SELLING_POINT: ['EFFECT'],
  TRUST_BACKING: ['EFFECT'],
  TARGET_AUDIENCE: ['HOOK', 'CTA'],
  CORE_PAIN_POINT: ['HOOK', 'EFFECT'],
  DECISION_DRIVER: ['HOOK', 'EFFECT', 'CTA'],
  MARKETING_GOAL: ['CTA'],
  USAGE_SCENARIO: ['HOOK', 'PRODUCT_DISPLAY', 'EFFECT'],
  PURCHASE_SCENARIO: ['HOOK', 'CTA'],
  EMOTIONAL_SCENARIO: ['HOOK', 'CTA'],
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

export const EFFECT_PROMPT_CLASSIFICATION_STATUSES = [
  'PENDING',
  'VERIFIED',
  'NEEDS_REVISION',
] as const;
export type EffectPromptClassificationStatus =
  (typeof EFFECT_PROMPT_CLASSIFICATION_STATUSES)[number];

export type EffectPromptItem = {
  id: string;
  code: string;
  origin: EffectPromptItemOrigin;
  /** Compatibility projection for downstream consumers. Always equals primaryPurpose. */
  fragmentType: EffectPromptFragmentType;
  primaryPurpose: EffectPromptFragmentType;
  /** Contains primaryPurpose and any additional compatible purposes. */
  compatiblePurposes: EffectPromptFragmentType[];
  classificationStatus: EffectPromptClassificationStatus;
  productRelevance: number;
  targetDurationSeconds: number;
  /** One-line creative throughline generated together with dimensions and content. */
  creativeCore: string;
  dimensions: EffectPromptDimensions;
  content: string;
  insightBindings: EffectPromptInsightBinding[];
  /** Safe evaluator issue codes. Present only when the item needs user revision. */
  reviewIssues?: string[];
  manualEdited: boolean;
  createdAt: string;
  updatedAt: string;
};

export type EffectPromptQualityScores = {
  productRelevance: number;
  creativeCoherence: number;
  visualExecutability: number;
  commercialUsefulness: number;
  visualClarity: number;
};

export const EFFECT_PROMPT_SEMANTIC_EVALUATION_STATUSES = ['PENDING', 'VERIFIED'] as const;
export type EffectPromptSemanticEvaluationStatus =
  (typeof EFFECT_PROMPT_SEMANTIC_EVALUATION_STATUSES)[number];

export type EffectPromptSemanticEvaluation = {
  status: EffectPromptSemanticEvaluationStatus;
  evaluatedCount: number;
  duplicateGroupCount: number | null;
  duplicateCount: number | null;
  duplicateRate: number | null;
};

export type EffectPromptMetrics = {
  targetCount: number;
  candidateTargetCount: number;
  generatedCandidateCount: number;
  acceptedCount: number;
  rejectedCount: number;
  replenishmentRounds: number;
  exactDuplicateCount: number;
  semanticEvaluation: EffectPromptSemanticEvaluation;
  purposeDistribution: Array<{
    purpose: EffectPromptFragmentType;
    primaryCount: number;
    compatibleCount: number;
  }>;
  averageScores: EffectPromptQualityScores;
  hardIssueCounts: Array<{ code: string; count: number }>;
  warningCounts: Array<{ code: string; count: number }>;
  insightCoverage: EffectPromptInsightCoverage;
};

export const EFFECT_PROMPT_QUALITY_STATUSES = ['PASS', 'NEEDS_REVIEW'] as const;
export type EffectPromptQualityStatus = (typeof EFFECT_PROMPT_QUALITY_STATUSES)[number];

export type EffectPromptBatchResult = {
  settings: EffectPromptBatchSettings;
  renderProfile: EffectPromptRenderProfile;
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
      | 'content'
      | 'fragmentType'
      | 'primaryPurpose'
      | 'compatiblePurposes'
      | 'classificationStatus'
      | 'reviewIssues'
      | 'productRelevance'
      | 'targetDurationSeconds'
      | 'creativeCore'
      | 'dimensions'
    >
  >;
  added: EffectPromptItem[];
  deleted: string[];
};

export const EFFECT_PROMPT_OPERATIONS = [
  'BATCH_GENERATE',
  'ITEM_REGENERATE',
  'ITEM_EVALUATE',
] as const;
export type EffectPromptOperation = (typeof EFFECT_PROMPT_OPERATIONS)[number];

export const EFFECT_PROMPT_REGENERATION_MODES = [
  'FULL_REGENERATE',
  'AUTO_DIVERSE',
  'PRESERVE_PRODUCT_RELATION',
  'NEW_CREATIVE',
  'CUSTOM',
] as const;
export type EffectPromptRegenerationMode = (typeof EFFECT_PROMPT_REGENERATION_MODES)[number];

export const EFFECT_PROMPT_REGENERATION_REASONS = [
  'PRODUCT_RELATION_WEAK',
  'CREATIVE_ORDINARY',
  'TOO_SIMILAR',
  'SCENE_UNSUITABLE',
  'ACTION_UNREASONABLE',
  'CAMERA_TOO_COMPLEX',
  'CUSTOM',
] as const;
export type EffectPromptRegenerationReason = (typeof EFFECT_PROMPT_REGENERATION_REASONS)[number];

export type EffectPromptRegenerationCandidate = {
  candidateId: string;
  item: EffectPromptItem;
  recommended: boolean;
  highlights: string[];
  warnings: string[];
};

export type EffectPromptRegenerationPreview = {
  targetItemId: string;
  baseResultId: string;
  baseResultRevision: number;
  candidates: EffectPromptRegenerationCandidate[];
  canApply: boolean;
  appliedCandidateId: string | null;
};

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

export const EFFECT_PROMPT_SHARD_PHASES = ['CREATIVE', 'CLASSIFICATION'] as const;
export type EffectPromptShardPhase = (typeof EFFECT_PROMPT_SHARD_PHASES)[number];

export const EFFECT_PROMPT_GRAPH_NODES = [
  { id: 'LOAD_AND_SNAPSHOT', label: '输入快照', group: 'SNAPSHOT' },
  { id: 'INSIGHT_MAPPING', label: '提炼信息应用映射', group: 'PLANNING' },
  {
    id: 'FACT_VISUAL_STRATEGY_COMPILATION',
    label: '事实视觉使用策略编译',
    group: 'PLANNING',
  },
  { id: 'SHARED_PROMPT_COMPILATION', label: '共用提示词编译', group: 'PLANNING' },
  { id: 'COHERENT_CREATIVE_GENERATION', label: '创意规划与 Prompt 生成', group: 'GENERATION' },
  {
    id: 'CREATIVE_EVALUATION_CLASSIFICATION',
    label: '创意评估与用途分类',
    group: 'QUALITY',
  },
  {
    id: 'EXACT_SELECTION_AND_SUPPLEMENT',
    label: '精确数量择优与补充',
    group: 'REPLENISH',
  },
  { id: 'ITEM_EVALUATE', label: 'AI 自动补齐创意信息', group: 'GENERATION' },
  { id: 'RESULT_SAVE', label: '结果保存', group: 'RESULT' },
] as const;
export type EffectPromptNodeId = (typeof EFFECT_PROMPT_GRAPH_NODES)[number]['id'];

export const EFFECT_PROMPT_GRAPH_NODE_IDS = [
  'LOAD_AND_SNAPSHOT',
  'INSIGHT_MAPPING',
  'FACT_VISUAL_STRATEGY_COMPILATION',
  'SHARED_PROMPT_COMPILATION',
  'COHERENT_CREATIVE_GENERATION',
  'CREATIVE_EVALUATION_CLASSIFICATION',
  'EXACT_SELECTION_AND_SUPPLEMENT',
  'RESULT_SAVE',
] as const satisfies readonly EffectPromptNodeId[];

export const EFFECT_PROMPT_ITEM_EVALUATE_GRAPH_NODE_IDS = [
  'LOAD_AND_SNAPSHOT',
  'INSIGHT_MAPPING',
  'FACT_VISUAL_STRATEGY_COMPILATION',
  'SHARED_PROMPT_COMPILATION',
  'ITEM_EVALUATE',
  'RESULT_SAVE',
] as const satisfies readonly EffectPromptNodeId[];

export const EFFECT_PROMPT_GRAPH_EDGES = [
  { from: 'LOAD_AND_SNAPSHOT', to: 'INSIGHT_MAPPING' },
  { from: 'INSIGHT_MAPPING', to: 'FACT_VISUAL_STRATEGY_COMPILATION' },
  { from: 'FACT_VISUAL_STRATEGY_COMPILATION', to: 'SHARED_PROMPT_COMPILATION' },
  { from: 'SHARED_PROMPT_COMPILATION', to: 'COHERENT_CREATIVE_GENERATION' },
  { from: 'COHERENT_CREATIVE_GENERATION', to: 'CREATIVE_EVALUATION_CLASSIFICATION' },
  { from: 'CREATIVE_EVALUATION_CLASSIFICATION', to: 'EXACT_SELECTION_AND_SUPPLEMENT' },
  { from: 'EXACT_SELECTION_AND_SUPPLEMENT', to: 'RESULT_SAVE' },
] as const satisfies ReadonlyArray<{ from: EffectPromptNodeId; to: EffectPromptNodeId }>;

export const EFFECT_PROMPT_ITEM_EVALUATE_GRAPH_EDGES = [
  { from: 'LOAD_AND_SNAPSHOT', to: 'INSIGHT_MAPPING' },
  { from: 'INSIGHT_MAPPING', to: 'FACT_VISUAL_STRATEGY_COMPILATION' },
  { from: 'FACT_VISUAL_STRATEGY_COMPILATION', to: 'SHARED_PROMPT_COMPILATION' },
  { from: 'SHARED_PROMPT_COMPILATION', to: 'ITEM_EVALUATE' },
  { from: 'ITEM_EVALUATE', to: 'RESULT_SAVE' },
] as const satisfies ReadonlyArray<{ from: EffectPromptNodeId; to: EffectPromptNodeId }>;

export const effectPromptRunGraphNodeIds = (
  operation: EffectPromptOperation,
): readonly EffectPromptNodeId[] =>
  operation === 'ITEM_EVALUATE'
    ? EFFECT_PROMPT_ITEM_EVALUATE_GRAPH_NODE_IDS
    : EFFECT_PROMPT_GRAPH_NODE_IDS;

export const effectPromptRunGraphEdges = (
  operation: EffectPromptOperation,
): ReadonlyArray<{ from: EffectPromptNodeId; to: EffectPromptNodeId }> =>
  operation === 'ITEM_EVALUATE'
    ? EFFECT_PROMPT_ITEM_EVALUATE_GRAPH_EDGES
    : EFFECT_PROMPT_GRAPH_EDGES;

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
  attemptCount: number;
  maxAttempts: number;
  currentNode: EffectPromptNodeId | 'COMPLETED' | null;
  warnings: string[];
  errorCode: EffectPromptErrorCode | string | null;
  errorMessage: string | null;
  promptResultId: string | null;
  regenerationPreview?: EffectPromptRegenerationPreview | null;
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
  purpose?: EffectPromptFragmentType | undefined;
  purposeMatch?: EffectPromptPurposeMatchMode | undefined;
};

export type StartEffectPromptRunRequest = {
  workflowRunId: string;
  operation: EffectPromptOperation;
  targetItemId?: string | undefined;
  targetDurationSeconds?: number | undefined;
  regenerationInstruction?: string | undefined;
  replacementDimensions?: EffectPromptDimensions | undefined;
  regenerationMode?: EffectPromptRegenerationMode | undefined;
  regenerationReasons?: EffectPromptRegenerationReason[] | undefined;
  preservedDimensions?: EffectPromptDimensionKey[] | undefined;
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
  'code' | 'fragmentType' | 'targetDurationSeconds' | 'dimensions' | 'content'
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

export const EFFECT_PROMPT_NODE_DETAIL_SECTION_KINDS = ['INPUT', 'OUTPUT', 'EXECUTION'] as const;
export type EffectPromptNodeDetailSectionKind =
  (typeof EFFECT_PROMPT_NODE_DETAIL_SECTION_KINDS)[number];

export const EFFECT_PROMPT_NODE_DETAIL_SECTION_STATES = [
  'EXPECTED',
  'ACTUAL',
  'PARTIAL',
  'EMPTY',
] as const;
export type EffectPromptNodeDetailSectionState =
  (typeof EFFECT_PROMPT_NODE_DETAIL_SECTION_STATES)[number];

export const EFFECT_PROMPT_NODE_DETAIL_CREATIVE_OUTCOMES = [
  'PENDING',
  'ACCEPTED',
  'REJECTED',
  'SELECTED',
  'SAVED',
] as const;
export type EffectPromptNodeDetailCreativeOutcome =
  (typeof EFFECT_PROMPT_NODE_DETAIL_CREATIVE_OUTCOMES)[number];

export type EffectPromptNodeDetailCreativeSample = {
  code: string;
  creativeCore: string;
  dimensions: EffectPromptDimensions;
  content: string;
  sourceFacts: string[];
  primaryPurpose: EffectPromptFragmentType | null;
  compatiblePurposes: EffectPromptFragmentType[];
  productRelevance: number | null;
  scores: EffectPromptQualityScores | null;
  outcome: EffectPromptNodeDetailCreativeOutcome;
  reasons: string[];
};

export type EffectPromptNodeDetailBlock =
  | {
      kind: 'TEXT_CONTENT';
      title: string;
      content: string;
      sourceLabels: string[];
    }
  | {
      kind: 'CREATIVE_SAMPLE_LIST';
      title: string;
      totalCount: number;
      remainingCount: number;
      items: EffectPromptNodeDetailCreativeSample[];
    }
  | {
      kind: 'CREATIVE_PLAN_LIST';
      title: string;
      territoryCount: number;
      directionCount: number;
      items: Array<{
        title: string;
        sceneBoundary: string;
        differentiationGoal: string;
        targetSlots: number;
        actions: string[];
        directions: Array<{
          code: string;
          creativeDirection: string;
          primaryAction: string;
          priorityDimensions: string[];
        }>;
      }>;
    }
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

export type EffectPromptNodeDetailSection = {
  kind: EffectPromptNodeDetailSectionKind;
  state: EffectPromptNodeDetailSectionState;
  title: string;
  summary: string;
  fields: EffectPromptNodeDetailField[];
  blocks: EffectPromptNodeDetailBlock[];
};

export type GetEffectPromptNodeDetailData = {
  detail: {
    nodeId: EffectPromptNodeId;
    status: EffectPromptStageStatus;
    summary: string;
    sections: EffectPromptNodeDetailSection[];
    fields: EffectPromptNodeDetailField[];
    blocks: EffectPromptNodeDetailBlock[];
    warnings: string[];
    errorMessage: string | null;
    updatedAt: string | null;
  };
};

export type UpsertEffectPromptItemRequest = Pick<
  EffectPromptItem,
  'content' | 'targetDurationSeconds'
> & {
  primaryPurpose?: EffectPromptFragmentType;
  creativeCore?: string;
  dimensions?: EffectPromptDimensions;
  expectedRevision: number;
  /** Internal compatibility flag: save the Prompt and queue asynchronous creative-structure autofill. */
  evaluateAfterSave?: boolean;
  expectedSettingsRevision?: number;
  idempotencyKey?: string;
};

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
  affectedItemId?: string;
  /** Zero-based position in the unfiltered display order after the mutation. */
  affectedItemIndex?: number;
  evaluationRun?: EffectPromptRun;
  evaluationStartError?: string;
};

export type ApplyEffectPromptRegenerationRequest = {
  candidateId: string;
  expectedRevision: number;
  idempotencyKey: string;
};

export type UndoEffectPromptRegenerationRequest = {
  expectedRevision: number;
  idempotencyKey: string;
};

export type ValidateEffectPromptResultRequest = { expectedRevision: number };
export type ValidateEffectPromptResultData = {
  valid: boolean;
  issues: Array<{ code: string; message: string }>;
  /** Non-blocking quality observations. They never prevent committing a complete batch. */
  warnings?: Array<{ code: string; message: string }>;
  productId: string;
  artifacts: WorkingArtifactCommitSummary[];
  allProductsValidated: boolean;
  validatedAt: string;
};

export const effectPromptSettingsNodeId = (productId: string): string =>
  `PROMPT_GENERATION:${productId}`;

export const effectPromptTargetCount = (settings: EffectPromptBatchSettings): number =>
  settings.targetCount;

export const normalizeEffectPromptSettings = (
  input: EffectPromptBatchSettings,
): EffectPromptBatchSettings => ({
  targetCount: Math.min(
    EFFECT_PROMPT_LIMITS.maxCount,
    Math.max(EFFECT_PROMPT_LIMITS.minCount, Math.round(input.targetCount)),
  ),
  defaultDurationSeconds: Math.min(
    EFFECT_PROMPT_LIMITS.maxDurationSeconds,
    Math.max(EFFECT_PROMPT_LIMITS.minDurationSeconds, Math.round(input.defaultDurationSeconds)),
  ),
  styleMode: input.styleMode === 'FIXED' ? 'FIXED' : 'AI_AUTO',
  styleTone:
    input.styleMode === 'FIXED' && typeof input.styleTone === 'string' && input.styleTone.trim()
      ? input.styleTone.trim().slice(0, 120)
      : null,
  deliveryChannel:
    typeof input.deliveryChannel === 'string' && input.deliveryChannel.trim()
      ? input.deliveryChannel.trim().slice(0, 120)
      : '抖音',
  disabledElements: [
    ...new Map(
      (Array.isArray(input.disabledElements) ? input.disabledElements : [])
        .map((value) =>
          String(value)
            .replace(/\s+/g, ' ')
            .trim()
            .replace(/[。；;，,]+$/u, ''),
        )
        .filter(Boolean)
        .slice(0, 50)
        .map((value) => [value.normalize('NFKC').toLocaleLowerCase(), value] as const),
    ).values(),
  ],
});

export const readEffectPromptSettings = (value: unknown): EffectPromptBatchSettings | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const targetCount = Number(source.targetCount);
  const defaultDurationSeconds = Number(source.defaultDurationSeconds);
  if (!Number.isFinite(targetCount) || !Number.isFinite(defaultDurationSeconds)) return null;
  return normalizeEffectPromptSettings({
    targetCount,
    defaultDurationSeconds,
    styleMode: source.styleMode === 'FIXED' ? 'FIXED' : 'AI_AUTO',
    styleTone: typeof source.styleTone === 'string' ? source.styleTone : null,
    deliveryChannel: typeof source.deliveryChannel === 'string' ? source.deliveryChannel : '抖音',
    disabledElements: Array.isArray(source.disabledElements)
      ? source.disabledElements.map(String)
      : [],
  });
};
