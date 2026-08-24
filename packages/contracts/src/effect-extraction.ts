export const EFFECT_EXTRACTION_API_BASE =
  '/api/projects/:projectId/workflows/effect/information-extraction' as const;

export const EFFECT_EXTRACTION_SCHEMA_VERSION = 1 as const;

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

export type EffectExtractionResult = {
  productCategory: string;
  productName: string;
  coreSpecification: string;
  priceRange: string;
  visualFeatures: string;
  targetAudience: string;
  marketingGoal: string;
  coreSellingPoints: string[];
  usageScenarios: string;
  deliveryChannels: string;
  brandTone: string;
  disabledElements: string[];
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
  resultRevision: number | null;
  result: EffectExtractionResult | null;
  progress: number;
  currentNode: string | null;
  warnings: EffectExtractionWarning[];
  errorMessage: string | null;
  sourceFingerprint: string;
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
  createdAt: string;
  updatedAt: string;
};

export type StartEffectExtractionRunData = { run: EffectExtractionRun };
export type GetEffectExtractionRunData = { run: EffectExtractionRun };

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
