import type {
  EffectPromptFragmentType,
  EffectPromptRenderCapabilityKey,
  SeedanceRatio,
  SeedanceResolution,
} from './effect-prompt-generation';
import type { WorkingArtifactCommitStatus, WorkingArtifactCommitSummary } from './workflow-working';

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

export const effectSegmentRenderSettingsNodeId = (productId: string): string =>
  `SEGMENT_RENDER_SETTINGS:${productId}`;

export const EFFECT_SEGMENT_RENDER_LIMITS = {
  maxTasksPerBatch: 100,
  maxTaskIdsPerOperation: 100,
  maxReferenceImages: 30,
  maxReferenceImagesSeedance20: 9,
  maxReferenceImageBytes: 30 * 1024 * 1024 - 1,
  maxBase64ProviderRequestBytes: 64 * 1024 * 1024,
  maxAutoRetries: 2,
  maxAttempts: 3,
  maxUploadBytes: 512 * 1024 * 1024,
  maxReferenceVideoBytes: 50 * 1024 * 1024,
  maxRepairInstructionLength: 1000,
  minRepairDurationMs: 100,
} as const;

export const EFFECT_SEGMENT_RENDER_STATUSES = [
  'AUTO_RETRY',
  'COMPLETED',
  'FAILED',
  'QUEUED',
  'RENDERING',
] as const;
export type EffectSegmentRenderStatus = (typeof EFFECT_SEGMENT_RENDER_STATUSES)[number];

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

export type EffectSegmentRenderProviderRequest = {
  model: string;
  content: [{ type: 'text'; text: string }];
  duration: number;
  ratio: SeedanceRatio;
  resolution: SeedanceResolution;
};

export type EffectSegmentRenderInputVideo = {
  fileObjectId: string;
  originalFileName: string;
  mimeType: string;
  sizeBytes: number;
  contentHash: string;
  durationSeconds: number;
};

export type EffectSegmentRenderRepairRegion = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type EffectSegmentRenderRepairInput = {
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

export type EffectSegmentRenderRequestSnapshot = {
  operation?: 'GENERATE' | 'REPAIR';
  promptId: string;
  promptCode: string;
  promptText: string;
  primaryPurpose: EffectPromptFragmentType;
  compatiblePurposes: EffectPromptFragmentType[];
  promptContentHash: string;
  sharedPromptHash: string;
  renderSettingsHash: string;
  sourcePackage: EffectSegmentRenderSourcePackage;
  inputImages: EffectSegmentRenderInputImage[];
  inputVideo?: EffectSegmentRenderInputVideo | null;
  repair?: EffectSegmentRenderRepairInput | null;
  request: EffectSegmentRenderProviderRequest;
};

export type EffectSegmentRenderOutput = {
  fileObjectId: string;
  originalFileName: string;
  mimeType: string;
  sizeBytes: number;
  contentHash: string;
  version: number;
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

export type EffectSegmentRenderTask = {
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
  modelMatch: 'AUTO_MATCHED';
  source: 'PROMPT';
  sourceName: string;
  status: EffectSegmentRenderStatus;
  progress: number;
  retryCount: number;
  maxAutoRetries: number;
  abnormal: boolean;
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
};

export type RegenerateEffectSegmentRenderTasksRequest = {
  taskIds: string[];
  expectedBatchRevision: number;
  idempotencyKey: string;
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
