import type { WorkingArtifactCommitStatus, WorkingArtifactCommitSummary } from './workflow-working';

export const EFFECT_EXTRACTION_API_BASE =
  '/api/projects/:projectId/workflows/effect/information-extraction' as const;

export const EFFECT_EXTRACTION_SCHEMA_VERSION = 2 as const;

export const EFFECT_EXTRACTION_PRODUCT_STATUSES = [
  'NOT_GENERATED',
  'QUEUED',
  'PROCESSING',
  'COMPLETED',
  'FAILED',
  'STALE',
] as const;
export type EffectExtractionProductStatus = (typeof EFFECT_EXTRACTION_PRODUCT_STATUSES)[number];

export const EFFECT_EXTRACTION_RUN_STATUSES = ['QUEUED', 'RUNNING', 'COMPLETED', 'FAILED'] as const;
export type EffectExtractionRunStatus = (typeof EFFECT_EXTRACTION_RUN_STATUSES)[number];

export const EFFECT_EXTRACTION_BRANCHES = [
  'DOCUMENT',
  'IMAGE',
  'COMMERCE',
  'FORM',
  'FUSION',
  'NORMALIZATION',
] as const;
export type EffectExtractionBranch = (typeof EFFECT_EXTRACTION_BRANCHES)[number];

export const EFFECT_EXTRACTION_BRANCH_STATUSES = [
  'PENDING',
  'RUNNING',
  'SUCCEEDED',
  'PARTIAL',
  'SKIPPED',
  'FAILED',
] as const;
export type EffectExtractionBranchStatus = (typeof EFFECT_EXTRACTION_BRANCH_STATUSES)[number];

export const EFFECT_EXTRACTION_GRAPH_NODES = [
  { id: 'LOAD_AND_SNAPSHOT', label: '资料快照', group: 'SNAPSHOT' },
  { id: 'DOCUMENT', label: '文档解析', group: 'PARALLEL' },
  { id: 'IMAGE', label: '图片识别', group: 'PARALLEL' },
  { id: 'COMMERCE', label: '电商链接', group: 'PARALLEL' },
  { id: 'FORM', label: '表单配置', group: 'PARALLEL' },
  { id: 'FUSION', label: '多源融合', group: 'FUSION' },
  { id: 'NORMALIZATION', label: '标准化与结果保存', group: 'NORMALIZATION' },
] as const;
export type EffectExtractionNodeId = (typeof EFFECT_EXTRACTION_GRAPH_NODES)[number]['id'];
export type EffectExtractionNodeGroup = (typeof EFFECT_EXTRACTION_GRAPH_NODES)[number]['group'];
export type EffectExtractionNodeStatus = EffectExtractionBranchStatus;

export const EFFECT_EXTRACTION_GRAPH_EDGES = [
  { from: 'LOAD_AND_SNAPSHOT', to: 'DOCUMENT' },
  { from: 'LOAD_AND_SNAPSHOT', to: 'IMAGE' },
  { from: 'LOAD_AND_SNAPSHOT', to: 'COMMERCE' },
  { from: 'LOAD_AND_SNAPSHOT', to: 'FORM' },
  { from: 'DOCUMENT', to: 'FUSION' },
  { from: 'IMAGE', to: 'FUSION' },
  { from: 'COMMERCE', to: 'FUSION' },
  { from: 'FORM', to: 'FUSION' },
  { from: 'FUSION', to: 'NORMALIZATION' },
] as const satisfies ReadonlyArray<{ from: EffectExtractionNodeId; to: EffectExtractionNodeId }>;

export type EffectExtractionNodeExecution = {
  nodeId: EffectExtractionNodeId;
  status: EffectExtractionNodeStatus;
  warnings: EffectExtractionWarning[];
  errorMessage: string | null;
};

export type EffectExtractionNodeDetailValue = string | number | boolean | string[] | null;

export type EffectExtractionNodeDetailField = {
  key: string;
  label: string;
  value: EffectExtractionNodeDetailValue;
  source: string | null;
};

export type EffectExtractionNodeDetailSource = {
  name: string;
  status: EffectExtractionNodeStatus;
  media?: {
    kind: 'IMAGE' | 'DOCUMENT' | 'VIDEO' | 'FILE' | 'LINK';
    typeLabel: string;
    previewUrl: string | null;
    sizeBytes: number | null;
  };
  fields: EffectExtractionNodeDetailField[];
  warnings: string[];
};

export type EffectExtractionNodeDetailWarning = Omit<EffectExtractionWarning, 'sourceId'>;

/** Safe, display-only node data. Raw model input/output and storage locations are excluded. */
export type EffectExtractionNodeDetail = {
  nodeId: EffectExtractionNodeId;
  status: EffectExtractionNodeStatus;
  summary: string;
  fields: EffectExtractionNodeDetailField[];
  sources: EffectExtractionNodeDetailSource[];
  warnings: EffectExtractionNodeDetailWarning[];
  errorMessage: string | null;
  updatedAt: string | null;
};

export const EFFECT_EXTRACTION_MAX_CORE_SELLING_POINTS = 3;
export const EFFECT_EXTRACTION_MAX_SECONDARY_SELLING_POINTS = 6;
export const EFFECT_EXTRACTION_MAX_TRUST_BACKINGS = 6;
export const EFFECT_EXTRACTION_MAX_AUDIENCE_ITEMS = 5;
export const EFFECT_EXTRACTION_MAX_SCENARIO_ITEMS = 5;

export type EffectExtractionResult = {
  productCategory: string;
  productName: string;
  coreSpecification: string;
  priceRange: string;
  visualFeatures: string;
  coreSellingPoints: string[];
  secondarySellingPoints: string[];
  trustBackings: string[];
  targetAudience: string;
  corePainPoints: string[];
  decisionDrivers: string[];
  marketingGoal: string;
  usageScenarios: string[];
  purchaseScenarios: string[];
  emotionalScenarios: string[];
  durationSeconds: number;
  aspectRatio: string;
  resolution: string;
  deliveryChannels: string;
  disabledElements: string[];
  visualStyleBaseline: string;
};

export type EffectExtractionWarning = {
  code: string;
  message: string;
  branch: EffectExtractionBranch | null;
  sourceId: string | null;
};

export type EffectExtractionProductState = {
  projectId: string;
  draftId: string;
  productId: string;
  status: EffectExtractionProductStatus;
  runId: string | null;
  resultId: string | null;
  resultSchemaVersion: number | null;
  resultRevision: number | null;
  result: EffectExtractionResult | null;
  manualOverrideFields: string[];
  progress: number;
  currentNode: string | null;
  warnings: EffectExtractionWarning[];
  errorMessage: string | null;
  sourceFingerprint: string;
  commitStatus: WorkingArtifactCommitStatus;
  workingArtifactRevision: number | null;
  updatedAt: string;
};

export type GetEffectExtractionWorkspaceData = {
  projectId: string;
  draftId: string;
  mode: 'SINGLE' | 'BATCH';
  sourceRevision: number;
  products: EffectExtractionProductState[];
};

export type StartEffectExtractionRunRequest = {
  draftId: string;
  expectedRevision: number;
  idempotencyKey: string;
};

export type EffectExtractionRun = {
  id: string;
  projectId: string;
  draftId: string;
  productId: string;
  status: EffectExtractionRunStatus;
  progress: number;
  currentNode: string | null;
  warnings: EffectExtractionWarning[];
  errorMessage: string | null;
  extractResultId: string | null;
  nodes: EffectExtractionNodeExecution[];
  createdAt: string;
  updatedAt: string;
};

export type StartEffectExtractionRunData = { run: EffectExtractionRun };
export type GetEffectExtractionRunData = { run: EffectExtractionRun };
export type GetEffectExtractionNodeDetailData = { detail: EffectExtractionNodeDetail };

export type UpdateEffectExtractionResultRequest = {
  expectedRevision: number;
  result: EffectExtractionResult;
};

export type UpdateEffectExtractionResultData = {
  projectId: string;
  productId: string;
  resultId: string;
  revision: number;
  result: EffectExtractionResult;
  savedAt: string;
};

export type ValidateEffectExtractionResultRequest = {
  expectedRevision: number;
};

export type ValidateEffectExtractionResultData = {
  valid: boolean;
  issues: Array<{ code: string; message: string }>;
  subjectKey: string;
  productId: string;
  artifacts: WorkingArtifactCommitSummary[];
  allProductsValidated: boolean;
  validatedAt: string;
};
