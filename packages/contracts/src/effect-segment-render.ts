import type {
  EffectPromptFragmentType,
  SeedanceRatio,
  SeedanceResolution,
} from './effect-prompt-generation';
import type { WorkingArtifactCommitStatus, WorkingArtifactCommitSummary } from './workflow-working';

export const EFFECT_SEGMENT_RENDER_API_BASE =
  '/api/projects/:projectId/workflows/effect/segment-render' as const;

export const EFFECT_SEGMENT_RENDER_QUEUE = 'effect.segment-render.requested' as const;
export const EFFECT_SEGMENT_RENDER_JOB_TYPE = 'EFFECT_SEGMENT_RENDER' as const;

export const EFFECT_SEGMENT_RENDER_LIMITS = {
  maxTasksPerBatch: 100,
  maxTaskIdsPerOperation: 100,
  maxAutoRetries: 2,
  maxAttempts: 3,
  maxUploadBytes: 512 * 1024 * 1024,
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

export type EffectSegmentRenderProviderRequest = {
  model: string;
  content: [{ type: 'text'; text: string }];
  duration: number;
  ratio: SeedanceRatio;
  resolution: SeedanceResolution;
};

export type EffectSegmentRenderRequestSnapshot = {
  promptId: string;
  promptCode: string;
  promptText: string;
  primaryPurpose: EffectPromptFragmentType;
  compatiblePurposes: EffectPromptFragmentType[];
  promptContentHash: string;
  sharedPromptHash: string;
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

export type EffectSegmentRenderTask = {
  id: string;
  renderCode: string;
  productId: string;
  productName: string;
  promptId: string;
  promptCode: string;
  promptText: string;
  fragmentType: EffectPromptFragmentType;
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
  promptArtifactRevision: number | null;
  batch: EffectSegmentRenderBatch | null;
};

export type StartEffectSegmentRenderBatchRequest = {
  workflowRunId: string;
  expectedPromptArtifactRevision: number;
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
  input: EffectSegmentRenderRequestSnapshot | null;
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
};
