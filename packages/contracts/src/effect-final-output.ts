import type {
  PackagingCheckpoint,
  PackagingSnapshot,
  PackagingStatus,
} from './effect-template-mix-packaging';

export type CompleteEffectPackagingRequest = {
  workflowRunId: string;
  expectedRevision: number;
  idempotencyKey: string;
};
export type FinalOutputDependency = {
  artifactId: string;
  revision: number;
  contentHash: string;
};
export type FinalOutputSnapshot = {
  timeline: PackagingSnapshot;
  packaging: PackagingCheckpoint;
  dependencies: FinalOutputDependency[];
  aspectRatio: string;
  originalVolume: number;
};
export type FinalOutputItem = {
  id: string;
  variantId: string;
  name: string;
  status: PackagingStatus;
  duration: number;
  fileObjectId: string | null;
  assetId: string | null;
  errorMessage: string | null;
  progress: number;
};
export type FinalOutputRun = {
  id: string;
  workflowRunId: string;
  templateId: string;
  status: PackagingStatus;
  createdAt: string;
  items: FinalOutputItem[];
  counts: { total: number; queued: number; running: number; completed: number; failed: number };
};
export type FinalOutputQueueMessage = {
  schemaVersion: 2;
  taskType: 'FINAL_OUTPUT';
  projectId: string;
  runId: string;
  requestId: string;
};
