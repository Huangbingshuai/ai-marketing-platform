import type { WorkingArtifactCommitSummary } from './workflow-working';

export type EffectTemplateMixPurpose = 'EFFECT' | 'END_CONVERSION' | 'HOOK' | 'PRODUCT_DISPLAY';
export type EffectTemplateMixRole =
  'END' | 'HOOK' | 'PAIN_POINT' | 'PRODUCT' | 'SELLING_POINT' | 'TRANSFORMATION';
export type EffectTemplateMixTransition =
  | '叠化'
  | '推镜'
  | '闪白'
  | '硬切'
  | '缩放'
  | '左滑'
  | '上推'
  | '擦除'
  | '翻转'
  | '圆形展开'
  | '模糊溶解'
  | '右滑'
  | '下推'
  | '旋转'
  | '百叶窗'
  | '菱形展开'
  | '像素化'
  | '故障'
  | '色差'
  | '波纹'
  | '闪黑'
  | '缩小'
  | '圆形扩散'
  | '线性擦除'
  | '四角汇聚'
  | '分割'
  | '镜像'
  | '翻页'
  | '立方体'
  | '放大模糊'
  | '彩色闪光'
  | '噪点溶解'
  | '液体扭曲'
  | '斜向擦除';
export const EFFECT_TEMPLATE_MIX_TRANSITION_DEFAULT_DURATION = 1;
export type EffectTemplateMixSlot = {
  id: string;
  label: string;
  role: EffectTemplateMixRole;
  purpose: EffectTemplateMixPurpose;
  /** Seconds; timeline boundaries are derived from duration. */
  duration: number;
  transition: EffectTemplateMixTransition;
  /** Seconds of overlap represented by the transition junction; optional for schema-v1 history. */
  transitionDuration?: number;
  /**
   * A clip the user dropped onto a track border. It is picture only: it takes part in the visual
   * timeline (and so covers whatever sits under it) but owns no narration, subtitle or slot
   * description. Only a variant's own extra slots ever set it — a template never has overlays.
   */
  overlay?: boolean;
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
  /** Original Prompt metadata is revealed only from the explicit material action. */
  promptCode?: string;
  promptText?: string;
  promptCreativeCore?: string;
};
export type EffectTemplateMixCaption = {
  id: string;
  /** User-authored subtitle-only clip; it is independent of generated narration. */
  manual?: boolean;
  /** User-created captions can own an independent timeline lane; absent is the legacy lane. */
  trackId?: string;
  /** New segmented captions share one saved narration clip; absent in historical packages. */
  voiceLineId?: string;
  /** Stable order and expected count make a missing subtitle detectable after editor rewording. */
  segmentIndex?: number;
  segmentCount?: number;
  text: string;
  start: number;
  end: number;
};
export type EffectTemplateMixAudio = {
  fileObjectId: string;
  name: string;
  duration: number;
  start: number;
  offset: number;
  volume: number;
};
/** Audio placed on the timeline, either detached from video or imported from the project music library. */
export type EffectTemplateMixDetachedAudio = {
  id: string;
  sourceSlotId?: string | undefined;
  sourceAssetId?: string | undefined;
  fileObjectId: string;
  name: string;
  /** Full media length before this timeline clip is trimmed. */
  sourceDuration?: number | undefined;
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
  /** Exact template configuration used by the latest successful smart-fill for this variant. */
  appliedTemplateHash?: string;
  /**
   * Template slots followed by the clips the user dropped onto a track border. Those extra slots
   * belong to this variant alone — the template never sees them — so they must survive a template
   * resync instead of being dropped on the floor.
   */
  slots: EffectTemplateMixSlot[];
  bindings: Record<string, string>;
  bindingRevisions: Record<string, number>;
  offsets: Record<string, number>;
  /** Optional editor layout; absent values use the template's sequential layout. */
  timelineStarts?: Record<string, number>;
  videoLanes?: Record<string, number>;
  /**
   * Optional per-clip audio row, keyed by timeline clip id (`voice:<lineId>`, `music`,
   * `detached:<uuid>`). Audio rows carry no meaning — every one of them is just 音频 and clips
   * differ only by colour — so this is pure editor arrangement: absent values fall back to the
   * kind's default row, and moving a clip between rows never changes what the worker renders.
   */
  audioLanes?: Record<string, number>;
  /** Optional for schema-v1 compatibility; missing values are historical/manual bindings. */
  bindingMetadata?: Record<string, EffectTemplateMixBindingMetadata>;
  manualSlotIds: string[];
  conflictSlotIds: string[];
  status: 'CURRENT' | 'PENDING' | 'SYNCED';
  captions: EffectTemplateMixCaption[];
  subtitleStyle: 'standard' | 'bold' | 'yellow';
  bgm: EffectTemplateMixAudio | null;
  voice: EffectTemplateMixAudio | null;
  /** Optional for historical schema-v1 drafts. */
  detachedAudios?: EffectTemplateMixDetachedAudio[];
  originalVolume: number;
};
/**
 * Re-syncs a variant's slots with the template while keeping the variant's own extra slots, in the
 * template's order followed by the extras. A template edit means "these six slots changed", not
 * "delete every clip I placed on its own track", so a wholesale replace would silently lose them.
 * Bindings, lanes and starts are keyed by slot id and therefore survive untouched.
 */
export const syncEffectTemplateMixVariantSlots = (
  templateSlots: readonly EffectTemplateMixSlot[],
  variantSlots: readonly EffectTemplateMixSlot[],
): EffectTemplateMixSlot[] => {
  const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
  const templateIds = new Set(templateSlots.map(({ id }) => id));
  return [
    ...clone(templateSlots),
    ...variantSlots.filter(({ id }) => !templateIds.has(id)).map(clone),
  ];
};
export type EffectTemplateMixAiRunStatus =
  'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
export type EffectTemplateMixAiRunStage =
  'CLASSIFYING' | 'MATCHING' | 'SAMPLING' | 'TRIMMING' | 'COMPLETED';
export type EffectTemplateMixAiStageDetail = {
  /** Exact persisted work units; never inferred from the run's overall percentage. */
  completed: number;
  total: number;
  inputSamples: string[];
  outputSamples: string[];
};
export type EffectTemplateMixSampledMaterial = {
  materialId: string;
  /** Actual source-video positions successfully decoded as preview keyframes, in seconds. */
  frameTimestampsSeconds: number[];
};
export type EffectTemplateMixSamplingCheckpoint = {
  samples?: EffectTemplateMixSampledMaterial[];
  /** Legacy worker payload retained for rolling deployment compatibility. */
  materialIds?: string[];
};
export type EffectTemplateMixAiRun = {
  id: string;
  templateId: string;
  operation?: 'FILL' | 'REFRESH_TRIMS';
  targetVariantId: string | null;
  outputVariantId: string | null;
  status: EffectTemplateMixAiRunStatus;
  stage: EffectTemplateMixAiRunStage;
  progress: number;
  stageDetails?: Partial<Record<EffectTemplateMixAiRunStage, EffectTemplateMixAiStageDetail>>;
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
  /** Applies only to future packaging/voice redos, not existing audio. */
  voiceProfileId?: string;
};
export type EffectTemplateMixWorkspace = {
  editVersion: number;
  template: EffectTemplateMixTemplate;
  variants: EffectTemplateMixVariant[];
  /** Read-only upstream view, never serialized in the node draft. */
  materials: EffectTemplateMixMaterial[];
};
export type EffectTemplateMixTemplateEntry = {
  id: string;
  /** First persisted creation time; absent for legacy drafts. */
  createdAt?: string;
  /** Transient while smart-fill is queued/running. */
  aiFillLocked?: boolean;
  /** Hash of template configuration used by the latest successful smart-fill. */
  filledTemplateHash?: string;
  /** True after packaging starts; this is a one-way lifecycle lock. */
  packagingLocked?: boolean;
  /** True when current template configuration differs from the latest successful fill. */
  needsAiFill?: boolean;
  workspace: EffectTemplateMixWorkspace;
};
export type EffectTemplateMixDraft = {
  schemaVersion: 1;
  templates: {
    id: string;
    createdAt?: string;
    aiFillLocked?: boolean;
    filledTemplateHash?: string;
    packagingLocked?: boolean;
    needsAiFill?: boolean;
    workspace: Omit<EffectTemplateMixWorkspace, 'materials'>;
  }[];
  activeTemplateId: string;
};
export type EffectTemplateMixWorkspaceData = {
  draft: EffectTemplateMixDraft;
  draftRevision: number | null;
  /** A successful render batch (or an already confirmed render pool) exists in this Run. */
  templateCreationReady?: boolean;
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
  /** Recalculate trim points only for bound clips whose confirmed render revision advanced. */
  refreshAffectedSlots?: boolean;
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
