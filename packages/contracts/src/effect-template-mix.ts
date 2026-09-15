import type { WorkingArtifactCommitSummary } from './workflow-working';

export type EffectTemplateMixPurpose = 'EFFECT' | 'END_CONVERSION' | 'HOOK' | 'PRODUCT_DISPLAY';
export type EffectTemplateMixRole =
  'END' | 'HOOK' | 'PAIN_POINT' | 'PRODUCT' | 'SELLING_POINT' | 'TRANSFORMATION';
export type EffectTemplateMixTransition = '叠化' | '推镜' | '闪白' | '硬切' | '缩放';
export type EffectTemplateMixSlot = {
  id: string;
  label: string;
  role: EffectTemplateMixRole;
  purpose: EffectTemplateMixPurpose;
  /** Seconds; timeline boundaries are derived from duration. */
  duration: number;
  transition: EffectTemplateMixTransition;
};
export type EffectTemplateMixMaterial = {
  id: string;
  code: string;
  name: string;
  duration: number;
  purpose: EffectTemplateMixPurpose;
  compatiblePurposes: EffectTemplateMixPurpose[];
  artifactId: string;
  artifactKey: string;
  artifactRevision: number;
  fileObjectId: string;
  contentHash: string;
  contentUrl: string;
  ratio: string;
  resolution: string;
  available: boolean;
};
export type EffectTemplateMixCaption = { id: string; text: string; start: number; end: number };
export type EffectTemplateMixAudio = {
  fileObjectId: string;
  name: string;
  duration: number;
  start: number;
  offset: number;
  volume: number;
};
export type EffectTemplateMixBindingMetadata = {
  source: 'AI' | 'MANUAL';
  matchScore?: number;
  matchLevel?: 'NORMAL' | 'LOW_MATCH';
  classificationReason?: string;
  trimReason?: string;
};
export type EffectTemplateMixVariant = {
  id: string;
  name: string;
  /** Local template edit sequence, NOT WorkingArtifact revision. */
  appliedTemplateVersion: number;
  slots: EffectTemplateMixSlot[];
  bindings: Record<string, string>;
  bindingRevisions: Record<string, number>;
  offsets: Record<string, number>;
  /** Optional for schema-v1 compatibility; missing values are historical/manual bindings. */
  bindingMetadata?: Record<string, EffectTemplateMixBindingMetadata>;
  manualSlotIds: string[];
  conflictSlotIds: string[];
  status: 'CURRENT' | 'PENDING' | 'SYNCED';
  captions: EffectTemplateMixCaption[];
  subtitleStyle: 'standard' | 'bold' | 'yellow';
  bgm: EffectTemplateMixAudio | null;
  voice: EffectTemplateMixAudio | null;
  originalVolume: number;
};
export type EffectTemplateMixAiRunStatus =
  'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
export type EffectTemplateMixAiRunStage =
  'CLASSIFYING' | 'MATCHING' | 'SAMPLING' | 'TRIMMING' | 'COMPLETED';
export type EffectTemplateMixAiRun = {
  id: string;
  templateId: string;
  targetVariantId: string | null;
  outputVariantId: string | null;
  status: EffectTemplateMixAiRunStatus;
  stage: EffectTemplateMixAiRunStage;
  progress: number;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
};
export type EffectTemplateMixMaterialClassification = {
  materialId: string;
  role: EffectTemplateMixRole;
  matchScore: number;
};
export type EffectTemplateMixClassificationPool = {
  templateId: string;
  runId: string;
  templateEditVersion: number;
  items: EffectTemplateMixMaterialClassification[];
};
export type EffectTemplateMixTemplate = {
  name: string;
  editVersion: number;
  slots: EffectTemplateMixSlot[];
};
export type EffectTemplateMixWorkspace = {
  editVersion: number;
  template: EffectTemplateMixTemplate;
  variants: EffectTemplateMixVariant[];
  /** Read-only upstream view, never serialized in the node draft. */
  materials: EffectTemplateMixMaterial[];
};
export type EffectTemplateMixTemplateEntry = { id: string; workspace: EffectTemplateMixWorkspace };
export type EffectTemplateMixDraft = {
  schemaVersion: 1;
  templates: { id: string; workspace: Omit<EffectTemplateMixWorkspace, 'materials'> }[];
  activeTemplateId: string;
};
export type EffectTemplateMixWorkspaceData = {
  draft: EffectTemplateMixDraft;
  draftRevision: number | null;
  materials: EffectTemplateMixMaterial[];
  commits: {
    templateId: string;
    revision: number;
    contentHash: string;
    stale: boolean;
    editVersion: number;
  }[];
  aiRuns: EffectTemplateMixAiRun[];
  /** Latest classification pool whose template and upstream revisions are still current. */
  classificationPools: EffectTemplateMixClassificationPool[];
};
export type SaveEffectTemplateMixRequest = {
  workflowRunId: string;
  expectedRevision: number | null;
  draft: EffectTemplateMixDraft;
};
export type EffectTemplateMixRevisionRequest = {
  workflowRunId: string;
  expectedRevision: number;
};
export type ApplyEffectTemplateMixVariantRequest = EffectTemplateMixRevisionRequest & {
  sourceVariantId: string;
  syncOtherVariants: boolean;
};
export type ValidateEffectTemplateMixRequest = EffectTemplateMixRevisionRequest & {
  templateId: string;
};
export type ValidateEffectTemplateMixData = { artifacts: WorkingArtifactCommitSummary[] };
export type CreateEffectTemplateMixAiRunRequest = EffectTemplateMixRevisionRequest & {
  targetVariantId?: string;
  idempotencyKey: string;
};
export type EffectTemplateMixAiClassification = {
  materialId: string;
  scores: Record<EffectTemplateMixRole, number>;
  reasons: Partial<Record<EffectTemplateMixRole, string>>;
};
export type EffectTemplateMixAiSelection = {
  /** Zero-based output group; absent means the historical single-output group. */
  variantIndex?: number;
  slotId: string;
  role: EffectTemplateMixRole;
  materialId: string;
  matchScore: number;
  matchLevel: 'NORMAL' | 'LOW_MATCH';
  classificationReason: string;
  duration: number;
};
export type EffectTemplateMixAiTrim = {
  /** Zero-based output group; absent means the historical single-output group. */
  variantIndex?: number;
  slotId: string;
  materialId: string;
  trimStartSeconds: number;
  trimReason: string;
};
