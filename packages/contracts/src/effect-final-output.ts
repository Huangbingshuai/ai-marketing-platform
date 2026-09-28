import type {
  PackagingCheckpoint,
  PackagingSnapshot,
} from './effect-template-mix-packaging';
export const FINAL_OUTPUT_RESOLUTIONS = ['480p', '720p', '1080p', '2K', '4K'] as const;
export type FinalOutputResolution = (typeof FINAL_OUTPUT_RESOLUTIONS)[number];

export type FinalOutputStatus =
  | 'PENDING_RENDER'
  | 'QUEUED'
  | 'RUNNING'
  | 'COMPLETED'
  | 'PARTIAL'
  | 'FAILED'
  | 'CANCELLED';

export type CompleteEffectPackagingRequest = {
  workflowRunId: string;
  expectedRevision: number;
  idempotencyKey: string;
};
export type StartFinalOutputRequest = {
  resolution: FinalOutputResolution;
  frameRate: 24 | 25 | 30 | 50 | 60;
};
export type FinalOutputDependency = {
  artifactId: string;
  revision: number;
  contentHash: string;
};
export type FinalOutputSnapshot = {
  timeline: PackagingSnapshot;
  packaging: PackagingCheckpoint;
  /**
   * The film's packaging failed, so it was confirmed as a picture-only film: no narration, captions
   * or bed. Recorded so the output list can say why it plays silent instead of looking broken.
   */
  unpackaged?: boolean;
  dependencies: FinalOutputDependency[];
  aspectRatio: string;
  originalVolume: number;
  resolution: FinalOutputResolution;
  frameRate: 24 | 25 | 30 | 50 | 60;
};
export type FinalOutputItem = {
  id: string;
  variantId: string;
  name: string;
  /** First frame source from the frozen timeline; used only as a preview cover. */
  cover?: { fileObjectId: string; time: number; contentHash: string } | null;
  status: FinalOutputStatus;
  duration: number;
  fileObjectId: string | null;
  assetId: string | null;
  errorMessage: string | null;
  progress: number;
  /** Confirmed without a package, so this film is expected to play with picture only. */
  unpackaged?: boolean;
  /** A consumed upstream material/revision has changed; the frozen film remains usable. */
  stale?: boolean;
};
export type FinalOutputRun = {
  id: string;
  workflowRunId: string;
  templateId: string;
  templateName: string;
  resolution: FinalOutputResolution;
  frameRate: 24 | 25 | 30 | 50 | 60;
  status: FinalOutputStatus;
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
