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

/** Synchronize saved mix drafts without starting a paid final render. */
export type SyncFinalOutputRequest = {
  workflowRunId: string;
  /** Restrict the scan to the edited template; older callers may omit it. */
  templateId?: string;
  /** Reject a late request for an older saved draft. */
  expectedDraftRevision?: number;
};
export type SyncFinalOutputData = {
  /** Unexported films whose frozen timeline was rewritten from the current draft. */
  refreshed: { templateId: string; itemCount: number }[];
  /** A newer draft or a different active branch superseded this sync request. */
  superseded?: boolean;
};
/** Explicitly re-render user-selected films; the system does not infer which outputs need updating. */
export type LocalUpdateFinalOutputRequest = {
  itemIds: string[];
};
export type StartFinalOutputRequest = {
  resolution: FinalOutputResolution;
  frameRate: 24 | 25 | 30 | 50 | 60;
};
export type FinalOutputDependency = {
  artifactId: string;
  artifactKey?: string;
  nodeId?: string;
  revision: number;
  contentHash: string;
};
export type FinalOutputSnapshot = {
  timeline: PackagingSnapshot;
  packaging: PackagingCheckpoint;
  /**
   * No package has been applied yet (or packaging failed), so this picture-only film has no
   * narration, captions or bed. A later successful package upgrades the pending item in place.
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
  /** No package is attached, so this film currently has picture only. */
  unpackaged?: boolean;
  /** The exported film differs from the current mix project in this output branch. */
  stale: boolean;
};
export type FinalOutputRun = {
  id: string;
  workflowRunId: string;
  templateId: string;
  templateName: string;
  /** The current template's rendered films were explicitly confirmed for delivery. */
  validated?: boolean;
  resolution: FinalOutputResolution;
  frameRate: 24 | 25 | 30 | 50 | 60;
  status: FinalOutputStatus;
  createdAt: string;
  items: FinalOutputItem[];
  counts: {
    total: number;
    queued: number;
    running: number;
    completed: number;
    failed: number;
    /** Exported films that require an explicit local update. */
    stale: number;
  };
};
export type FinalOutputQueueMessage = {
  schemaVersion: 2;
  taskType: 'FINAL_OUTPUT';
  projectId: string;
  runId: string;
  requestId: string;
};
