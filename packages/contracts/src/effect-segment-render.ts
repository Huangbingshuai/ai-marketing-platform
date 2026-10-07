import type {
  EffectPromptFragmentType,
  EffectPromptDimensions,
  EffectPromptRenderCapabilityKey,
  SeedanceRatio,
  SeedanceResolution,
} from './effect-prompt-generation';
import type { WorkingArtifactCommitStatus, WorkingArtifactCommitSummary } from './workflow-working';
import {
  EFFECT_PROMPT_FRAGMENT_TYPES,
  EFFECT_PROMPT_DIMENSIONS,
  EFFECT_PROMPT_RENDER_CAPABILITIES,
} from './effect-prompt-generation';

export const EFFECT_SEGMENT_RENDER_API_BASE =
  '/api/projects/:projectId/workflows/effect/segment-render' as const;

export const EFFECT_SEGMENT_RENDER_QUEUE = 'effect.segment-render.requested' as const;
export const EFFECT_SEGMENT_RENDER_JOB_TYPE = 'EFFECT_SEGMENT_RENDER' as const;
export const EFFECT_SEGMENT_RENDER_SETTINGS_SCHEMA_VERSION = 1 as const;

export type EffectSegmentRenderSettings = {
  ratio: SeedanceRatio;
  resolution: SeedanceResolution;
  capabilityKey: EffectPromptRenderCapabilityKey;
};

export const DEFAULT_EFFECT_SEGMENT_RENDER_SETTINGS: EffectSegmentRenderSettings = {
  ratio: '9:16',
  resolution: '720p',
  capabilityKey: 'SEEDANCE_2_0',
};

export const SEEDANCE_RESOLUTION_SHORT_SIDES: Record<SeedanceResolution, number> = {
  '480p': 480,
  '720p': 720,
  '1080p': 1080,
  '4k': 2160,
};

/** Per-import routing only: never mutates the user's global render settings. */
export function resolveEffectImportedRenderSettings(
  configured: EffectSegmentRenderSettings,
  source: { durationSeconds: number; shortSidePixels?: number },
): EffectSegmentRenderSettings {
  const resolutions: SeedanceResolution[] = ['480p', '720p', '1080p', '4k'];
  const pixels = Math.max(
    source.shortSidePixels ?? 0,
    SEEDANCE_RESOLUTION_SHORT_SIDES[configured.resolution],
  );
  const resolution =
    resolutions.find((value) => SEEDANCE_RESOLUTION_SHORT_SIDES[value] >= pixels) ?? '4k';
  if (source.durationSeconds > 15) {
    return {
      ...configured,
      capabilityKey: 'SEEDANCE_1_5_PRO',
      resolution: resolution === '4k' ? '1080p' : resolution,
    };
  }
  if (EFFECT_PROMPT_RENDER_CAPABILITIES[configured.capabilityKey].resolutions.includes(resolution))
    return { ...configured, resolution };
  return {
    ...configured,
    capabilityKey: resolution === '4k' ? 'SEEDANCE_2_0' : 'SEEDANCE_1_5_PRO',
    resolution,
  };
}

export const effectSegmentRenderSettingsNodeId = (productId: string): string =>
  `SEGMENT_RENDER_SETTINGS:${productId}`;

export const EFFECT_SEGMENT_RENDER_LIMITS = {
  maxTasksPerBatch: 100,
  maxTaskIdsPerOperation: 100,
  maxImportFilesPerOperation: 5,
  maxReferenceImages: 30,
  maxReferenceImagesSeedance20: 9,
  maxReferenceImageBytes: 30 * 1024 * 1024 - 1,
  maxBase64ProviderRequestBytes: 64 * 1024 * 1024,
  maxAutoRetries: 2,
  maxAttempts: 3,
  maxUploadBytes: 512 * 1024 * 1024,
  maxPosterBytes: 2 * 1024 * 1024,
  maxReferenceVideoBytes: 200 * 1024 * 1024,
  minReferenceVideoSeconds: 4,
  maxReferenceVideoSeconds: 30,
  maxRepairInstructionLength: 1000,
  minRepairDurationMs: 100,
  minImportDurationSeconds: 4,
  maxImportDurationSeconds: 30,
  maxImportPromptLength: 4000,
} as const;

export const EFFECT_SEGMENT_RENDER_STATUSES = [
  'AUTO_RETRY',
  'COMPLETED',
  'FAILED',
  'QUEUED',
  'RENDERING',
] as const;
export type EffectSegmentRenderStatus = (typeof EFFECT_SEGMENT_RENDER_STATUSES)[number];

export const EFFECT_SEGMENT_RENDER_ORIGINS = ['AI_GENERATED', 'EXTERNAL_IMPORT'] as const;
export type EffectSegmentRenderOrigin = (typeof EFFECT_SEGMENT_RENDER_ORIGINS)[number];

export const EFFECT_SEGMENT_RENDER_BATCH_STATUSES = [
  'QUEUED',
  'RUNNING',
  'COMPLETED',
  'PARTIAL',
  'FAILED',
] as const;
export type EffectSegmentRenderBatchStatus = (typeof EFFECT_SEGMENT_RENDER_BATCH_STATUSES)[number];

export type EffectSegmentRenderSourcePrompt = {
  artifactId: string;
  revision: number;
  contentHash: string;
};

export type EffectSegmentRenderSourcePackage = EffectSegmentRenderSourcePrompt;

export type EffectSegmentImportDescriptionStatus =
  'IDLE' | 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED';
export const EFFECT_SEGMENT_IMPORT_FAILURE_MESSAGES = {
  VIDEO_READ_FAILED: '视频读取失败：暂时无法读取上传的视频，请重试或重新上传。',
  VIDEO_INTEGRITY_FAILED: '视频校验失败：读取内容与上传文件不一致，请重新上传。',
  FRAME_EXTRACTION_FAILED: '视频抽帧失败：无法提取用于识别的画面，请检查视频是否可正常播放。',
  AI_TIMEOUT: 'AI 识别超时：识别服务未在规定时间内返回，请重新识别或手工填写。',
  AI_CONNECTION_FAILED: 'AI 连接中断：未收到完整识别结果，请重新识别或手工填写。',
  AI_RATE_LIMITED: 'AI 服务限流：当前请求较多，请稍后重新识别。',
  AI_SERVICE_FAILED: 'AI 服务请求失败：识别服务暂不可用，请稍后重新识别。',
  AI_OUTPUT_TRUNCATED: 'AI 返回不完整：识别结果被截断，请重新识别或手工填写。',
  AI_OUTPUT_INVALID:
    'AI 返回格式错误：提示词、片段类型或创意信息不符合要求，请重新识别或手工填写。',
  TEMPLATE_INVALID: 'AI 描述校验失败：时间分段或提示词模板字段不完整，请重新识别或手工填写。',
  TASK_TIMEOUT: '识别任务超时：处理时间超过上限，请重新识别或手工填写。',
  TASK_INTERRUPTED: '识别任务中断：任务连接或执行状态已失效，请重新识别。',
  UNKNOWN: 'AI 描述生成失败：未记录具体原因，可重新识别或手工填写。',
} as const;
export type EffectSegmentImportFailureCode = keyof typeof EFFECT_SEGMENT_IMPORT_FAILURE_MESSAGES;
export const EFFECT_SEGMENT_IMPORT_FAILURE_CODES = Object.keys(
  EFFECT_SEGMENT_IMPORT_FAILURE_MESSAGES,
) as EffectSegmentImportFailureCode[];
export const EFFECT_SEGMENT_IMPORT_DIMENSION_LIMITS = {
  narrative: 120,
  scene: 120,
  persona: 160,
  productRelation: 240,
  camera: 160,
  emotion: 120,
} as const;
export type EffectSegmentImportCreativeMetadata = {
  creativeCore?: string;
  dimensions?: Partial<EffectPromptDimensions>;
};
export type EffectSegmentImportDraft = EffectSegmentImportCreativeMetadata & {
  id: string;
  fileName: string;
  sizeBytes: number;
  durationSeconds: number;
  /** Actual video stream metadata; optional for older API responses/drafts. */
  width?: number;
  height?: number;
  frameRate?: number | null;
  status: 'READY' | 'IMPORTED' | 'CANCELLED';
  descriptionStatus: EffectSegmentImportDescriptionStatus;
  promptText: string;
  primaryPurpose?: EffectPromptFragmentType | null;
  compatiblePurposes?: EffectPromptFragmentType[];
  errorMessage: string | null;
};
export type EffectSegmentImportDescription = EffectSegmentImportCreativeMetadata & {
  promptText: string;
  primaryPurpose: EffectPromptFragmentType;
  compatiblePurposes: EffectPromptFragmentType[];
};
/** Internal callback; missing failureCode preserves compatibility with older Workers. */
export type EffectSegmentImportCompleteRequest = Partial<EffectSegmentImportDescription> & {
  projectId: string;
  failureCode?: EffectSegmentImportFailureCode;
};
export type EffectSegmentImportConfirmItem = EffectSegmentImportDescription & { draftId: string };
export function effectSegmentImportDescriptionValid(
  value: unknown,
): value is EffectSegmentImportDescription {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<EffectSegmentImportDescription>;
  if (
    item.creativeCore !== undefined &&
    (typeof item.creativeCore !== 'string' || item.creativeCore.length > 160)
  )
    return false;
  if (item.dimensions !== undefined) {
    if (!item.dimensions || typeof item.dimensions !== 'object' || Array.isArray(item.dimensions))
      return false;
    if (
      Object.entries(item.dimensions).some(
        ([key, text]) =>
          !EFFECT_PROMPT_DIMENSIONS.some((dimension) => dimension.key === key) ||
          typeof text !== 'string' ||
          text.length > EFFECT_SEGMENT_IMPORT_DIMENSION_LIMITS[key as keyof EffectPromptDimensions],
      )
    )
      return false;
  }
  return (
    typeof item.promptText === 'string' &&
    item.promptText.trim().length > 0 &&
    item.promptText.length <= 4000 &&
    EFFECT_PROMPT_FRAGMENT_TYPES.includes(item.primaryPurpose as EffectPromptFragmentType) &&
    Array.isArray(item.compatiblePurposes) &&
    item.compatiblePurposes.length > 0 &&
    item.compatiblePurposes.length <= 4 &&
    new Set(item.compatiblePurposes).size === item.compatiblePurposes.length &&
    item.compatiblePurposes.every((purpose) => EFFECT_PROMPT_FRAGMENT_TYPES.includes(purpose)) &&
    item.compatiblePurposes.includes(item.primaryPurpose as EffectPromptFragmentType)
  );
}
export type EffectSegmentImportDescriptionMessage = {
  schemaVersion: 2;
  taskType: 'VIDEO_IMPORT_DESCRIPTION';
  projectId: string;
  runId: string;
  requestId: string;
};
export type EffectSegmentImportDescriptionClaim = {
  claimed: boolean;
  attemptToken?: string;
  durationSeconds?: number;
  mimeType?: string;
  sizeBytes?: number;
  contentHash?: string;
};

export type EffectSegmentRenderProviderRequest = {
  model: string;
  content: [{ type: 'text'; text: string }];
  duration: number;
  ratio: SeedanceRatio;
  resolution: SeedanceResolution;
};

export type EffectSegmentRenderInputVideo = {
  fileObjectId: string;
  /** Ark task that produced the active output. Used to refresh its temporary URL for repair. */
  providerTaskId?: string | null;
  originalFileName: string;
  mimeType: string;
  sizeBytes: number;
  contentHash: string;
  durationSeconds: number;
  /** Actual source aspect ratio for adaptive video editing. */
  ratio?: string;
};

export type EffectSegmentRenderRepairRegion = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type EffectSegmentRenderRepairInput = {
  /** Absent in legacy snapshots: VIDEO_EDIT (Seedance 2.5). */
  providerMode?: 'VIDEO_EDIT' | 'VIDEO_REFERENCE';
  sourceVersion: number;
  startMs: number;
  endMs: number;
  instruction: string;
  region: EffectSegmentRenderRepairRegion | null;
};

export type EffectSegmentRenderInputImage = {
  fileObjectId: string;
  originalFileName: string;
  mimeType: string;
  sizeBytes: number;
  contentHash: string;
  sortOrder: number;
};

/** Adopted business input. Queuing a replacement must not advance this baseline. */
export type EffectSegmentRenderPromptBaseline = EffectSegmentImportCreativeMetadata & {
  /** Actual confirmed source, never the batch's latest pointer. */
  sourcePrompt?: EffectSegmentRenderSourcePrompt;
  promptContentHash: string;
  sharedPromptHash: string;
  targetDurationSeconds: number;
  primaryPurpose: EffectPromptFragmentType;
  compatiblePurposes: EffectPromptFragmentType[];
};

export type EffectSegmentRenderUpdateKind = 'RENDER' | 'METADATA' | 'REMOVE';

/** Content comparison shared by workspace and branch projections. Revision is provenance only. */
export function effectSegmentRenderPromptDifference(
  adopted: EffectSegmentRenderPromptBaseline,
  latest: EffectSegmentRenderPromptBaseline | null,
): EffectSegmentRenderUpdateKind | undefined {
  if (!latest) return 'REMOVE';
  if (adopted.promptContentHash !== latest.promptContentHash ||
      adopted.sharedPromptHash !== latest.sharedPromptHash ||
      adopted.targetDurationSeconds !== latest.targetDurationSeconds) return 'RENDER';
  if (adopted.primaryPurpose !== latest.primaryPurpose ||
      JSON.stringify([...adopted.compatiblePurposes].sort()) !==
        JSON.stringify([...latest.compatiblePurposes].sort()) ||
      (adopted.creativeCore !== undefined && adopted.creativeCore !== latest.creativeCore) ||
      (adopted.dimensions !== undefined && Object.entries(adopted.dimensions).some(
        ([key, value]) => latest.dimensions?.[key as keyof EffectPromptDimensions] !== value)))
    return 'METADATA';
  return undefined;
}

/** Server-created protocol marker. Every task retains its own immutable generation input. */
export type EffectSegmentRenderRefreshContext = {
  schemaVersion: 1;
  confirmationSignature: string;
  sourcePrompt: EffectSegmentRenderSourcePrompt;
};

export type EffectSegmentRenderRequestSnapshot = EffectSegmentImportCreativeMetadata & {
  /** Previous active video's complete input while a replacement is pending/failed. */
  adoptedInput?: Omit<EffectSegmentRenderRequestSnapshot, 'adoptedInput'>;
  adoptedPrompt?: EffectSegmentRenderPromptBaseline;
  refreshContext?: EffectSegmentRenderRefreshContext;
  /** Distinguishes a confirmed Prompt removal from a user's explicit material deletion. */
  removedBy?: 'PROMPT' | 'USER';
  /** Original unified Prompt-batch duration; manual additions never raise slot limits. */
  promptDurationMaxSeconds?: number;
  /** An independent, user-confirmed clip description, owned by the render artifact. */
  importedMaterial?: {
    schemaVersion: 1;
    width: number;
    height: number;
    promptDurationMaxSeconds?: number;
  };
  operation?: 'GENERATE' | 'REPAIR';
  /** Actual completed output duration, independent of the integer generation target. */
  outputDurationSeconds?: number;
  outputRatio?: string;
  promptId: string;
  promptCode: string;
  promptText: string;
  primaryPurpose: EffectPromptFragmentType;
  compatiblePurposes: EffectPromptFragmentType[];
  promptContentHash: string;
  sharedPromptHash: string;
  renderSettingsHash: string;
  /** Exact settings and Prompt-batch version used for this individual task. */
  renderSettings?: EffectSegmentRenderSettings;
  sourcePrompt?: EffectSegmentRenderSourcePrompt;
  sourcePackage: EffectSegmentRenderSourcePackage;
  inputImages: EffectSegmentRenderInputImage[];
  inputVideo?: EffectSegmentRenderInputVideo | null;
  repair?: EffectSegmentRenderRepairInput | null;
  request: EffectSegmentRenderProviderRequest;
};

export type EffectSegmentRenderPoster = {
  fileObjectId: string;
  originalFileName: string;
  mimeType: string;
  sizeBytes: number;
  contentHash: string;
  version: number;
};

export type EffectSegmentRenderOutput = EffectSegmentRenderPoster & {
  poster: EffectSegmentRenderPoster | null;
};

export const EFFECT_SEGMENT_RENDER_REPAIR_STATUSES = [
  'QUEUED',
  'RENDERING',
  'READY',
  'FAILED',
] as const;
export type EffectSegmentRenderRepairStatus =
  (typeof EFFECT_SEGMENT_RENDER_REPAIR_STATUSES)[number];

export type EffectSegmentRenderRepair = EffectSegmentRenderRepairInput & {
  version: number;
  status: EffectSegmentRenderRepairStatus;
  errorCode: string | null;
  errorMessage: string | null;
  candidate: EffectSegmentRenderOutput | null;
};

export type EffectSegmentRenderTask = EffectSegmentImportCreativeMetadata & {
  id: string;
  renderCode: string;
  productId: string;
  productName: string;
  promptId: string;
  promptCode: string;
  promptText: string;
  fragmentType: EffectPromptFragmentType;
  compatiblePurposes: EffectPromptFragmentType[];
  durationSeconds: number;
  source: 'PROMPT';
  origin: EffectSegmentRenderOrigin;
  independentImport?: boolean;
  /** Short-side pixels of the active media, not the originally imported file after regeneration. */
  mediaShortSidePixels?: number;
  sourceName: string;
  status: EffectSegmentRenderStatus;
  progress: number;
  retryCount: number;
  maxAutoRetries: number;
  abnormal: boolean;
  /** Current Prompt content no longer matches this task's frozen render input. */
  needsUpdate: boolean;
  updateKind?: EffectSegmentRenderUpdateKind;
  refreshSignature?: string;
  errorCode: string | null;
  errorMessage: string | null;
  providerTaskId: string | null;
  output: EffectSegmentRenderOutput | null;
  repair: EffectSegmentRenderRepair | null;
  updatedAt: string;
};

export type EffectSegmentRenderSummary = {
  total: number;
  completed: number;
  running: number;
  failed: number;
};

export type EffectSegmentRenderBatch = {
  id: string;
  projectId: string;
  workflowRunId: string;
  productId: string;
  productName: string;
  sourcePrompt: EffectSegmentRenderSourcePrompt;
  status: EffectSegmentRenderBatchStatus;
  stale: boolean;
  refreshScope: 'NONE' | 'SELECTIVE' | 'FULL';
  /** Confirmed Prompt items not yet represented by a task in this batch. */
  pendingPromptIds?: string[];
  pendingRemovedTaskIds?: string[];
  refreshSignature?: string;
  /** New frozen local updates may be saved even if newer Prompt differences remain. */
  canSaveFrozenResults?: boolean;
  /** Current confirmed upstream head, separate from the actual consumed sourcePrompt. */
  latestPromptRevision?: number | null;
  latestPromptCount?: number;
  revision: number;
  commitStatus: WorkingArtifactCommitStatus;
  workingArtifactRevision: number | null;
  summary: EffectSegmentRenderSummary;
  tasks: EffectSegmentRenderTask[];
  createdAt: string;
  updatedAt: string;
};

export type GetEffectSegmentRenderWorkspaceData = {
  projectId: string;
  workflowRunId: string;
  productId: string;
  promptReady: boolean;
  promptCount: number;
  promptArtifactRevision: number | null;
  settings: EffectSegmentRenderSettings;
  settingsRevision: number | null;
  batch: EffectSegmentRenderBatch | null;
};

export type SaveEffectSegmentRenderSettingsRequest = {
  workflowRunId: string;
  expectedRevision: number | null;
  settings: EffectSegmentRenderSettings;
};

export type SaveEffectSegmentRenderSettingsData = {
  productId: string;
  settings: EffectSegmentRenderSettings;
  settingsRevision: number;
  unchanged: boolean;
  savedAt: string;
};

export type StartEffectSegmentRenderBatchRequest = {
  workflowRunId: string;
  expectedPromptArtifactRevision: number;
  expectedSettingsRevision: number;
  idempotencyKey: string;
};

export type StartEffectSegmentRenderBatchData = {
  batch: EffectSegmentRenderBatch;
  replayed: boolean;
  noChanges?: boolean;
};

export type RefreshEffectSegmentRenderBatchRequest = {
  /** Omit for all differences; selected tasks never append unrelated Prompt items. */
  taskIds?: string[];
  expectedBatchRevision: number;
  expectedPromptArtifactRevision: number;
  expectedDifferenceSignature?: string;
  idempotencyKey: string;
};

export type RegenerateEffectSegmentRenderTasksRequest = {
  taskIds: string[];
  expectedBatchRevision: number;
  idempotencyKey: string;
};

export type EffectSegmentRenderImportMapping = {
  fileIndex: number;
  taskId: string;
};

export type ImportEffectSegmentRenderMaterialsRequest = {
  expectedBatchRevision: number;
  idempotencyKey: string;
  mappings: EffectSegmentRenderImportMapping[];
};

export type ImportEffectSegmentRenderMaterialsData = {
  batch: EffectSegmentRenderBatch;
  importedCount: number;
  replayed: boolean;
};

export type DeleteEffectSegmentRenderMaterialsRequest = {
  taskIds: string[];
  expectedBatchRevision: number;
  idempotencyKey: string;
};

export const EFFECT_SEGMENT_RENDER_EXPORT_FORMATS = [
  'VIDEO_PACKAGE',
  'MANIFEST_JSON',
  'FAILURE_CSV',
] as const;
export type EffectSegmentRenderExportFormat = (typeof EFFECT_SEGMENT_RENDER_EXPORT_FORMATS)[number];

export type ExportEffectSegmentRenderMaterialsRequest = {
  taskIds: string[];
  formats: EffectSegmentRenderExportFormat[];
  expectedBatchRevision: number;
};

export type StartEffectSegmentRenderRepairRequest = {
  expectedBatchRevision: number;
  expectedSourceVersion: number;
  startMs: number;
  endMs: number;
  instruction: string;
  region?: EffectSegmentRenderRepairRegion | null;
  idempotencyKey: string;
};

export type StartEffectSegmentRenderRepairData = {
  batch: EffectSegmentRenderBatch;
  replayed: boolean;
};

export const EFFECT_SEGMENT_RENDER_REPAIR_DECISIONS = ['ACCEPT', 'DISCARD'] as const;
export type EffectSegmentRenderRepairDecision =
  (typeof EFFECT_SEGMENT_RENDER_REPAIR_DECISIONS)[number];

export type DecideEffectSegmentRenderRepairRequest = {
  expectedBatchRevision: number;
  repairVersion: number;
  decision: EffectSegmentRenderRepairDecision;
  idempotencyKey: string;
};

export type DecideEffectSegmentRenderRepairData = {
  batch: EffectSegmentRenderBatch;
  replayed: boolean;
};

export type ValidateEffectSegmentRenderBatchRequest = {
  expectedBatchRevision: number;
};

export type ValidateEffectSegmentRenderBatchData = {
  valid: boolean;
  issues: Array<{ code: string; message: string }>;
  productId: string;
  artifacts: WorkingArtifactCommitSummary[];
  validatedAt: string;
};

export type EffectSegmentRenderWorkerClaimData = {
  terminal: boolean;
  taskId: string;
  taskVersion: number | null;
  attemptToken: string | null;
  sourceFingerprint: string | null;
  providerTaskId: string | null;
  input: EffectSegmentRenderRequestSnapshot | null;
};

export type EffectSegmentRenderWorkerReferenceVideoUrlData = {
  url: string;
  expiresAt: string;
};

export type EffectSegmentRenderWorkerHeartbeatRequest = {
  projectId: string;
  taskVersion: number;
  progress: number;
  providerTaskId?: string | undefined;
};

export type EffectSegmentRenderWorkerCompleteRequest = {
  projectId: string;
  taskVersion: number;
  providerTaskId: string;
  duration?: number | undefined;
  /** Actual decoded video-stream duration; provider duration may be rounded down. */
  actualDuration?: number | undefined;
  ratio?: string | undefined;
  resolution?: string | undefined;
};

export type EffectSegmentRenderWorkerFailRequest = {
  projectId: string;
  taskVersion: number;
  errorCode: string;
  errorMessage: string;
  retryable: boolean;
  providerTaskId?: string | undefined;
  resetProviderTask?: boolean | undefined;
};
