import type {
  PackagingAudio,
  PackagingCheckpoint,
  PackagingSnapshot,
} from './effect-template-mix-packaging';
import type { EffectTemplateMixMaterial, EffectTemplateMixVariant, EffectTemplateMixFrozenSourceContext } from './effect-template-mix';
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
  /** Explicitly reconcile added/deleted projects in this template's current output branch. */
  syncProjects?: boolean;
  /** Saved mix draft used by the confirmation dialog. */
  expectedDraftRevision?: number;
};
/** Refresh changed source media in the selected, confirmed mix branch, even if its output queue is missing. */
export type SourceUpdateFinalOutputRequest = {
  operationId?: string;
  workflowRunId: string;
  templateId: string;
  expectedDraftRevision: number;
  variantIds: string[];
  appendNewMaterials?: boolean;
  expectedSourceSignature?: string;
  expectedPackageNewVariants?: boolean;
};
export type SourceUpdateFinalOutputData = FinalOutputRun | { noChanges: true };
export type FinalOutputSourceTrim = { slotId: string; offset: number };
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
  /** Fence a locally appended/manual output against later draft edits or deletion. */
  sourceDraft?: { workflowRunId: string; templateId: string; variantId: string; contentHash: string };
  /** Durable continuation for the same authorized local update, even after refresh commits. */
  sourceOperation?: EffectTemplateMixFrozenSourceContext;
  /** Source repair of unexported projects reuses the refresh worker without encoding a final video. */
  projectRefreshOnly?: boolean;
  /** Explicit export of newly appended films keeps completed films and the current branch. */
  appendOnly?: boolean;
  /** Await the append operation's authorized packaging before exporting the new film. */
  appendPackagingRequired?: boolean;
  /** Durable preparation for an explicit same-branch source refresh; committed with the video. */
  sourceRefresh?: {
    /** Only this protocol allows newer saved render sources while this operation is running. */
    protocol?: 'FROZEN_RENDER_V1';
    workflowRunId: string;
    templateId: string;
    templateHash?: string;
    baselineVariant: EffectTemplateMixVariant;
    baselinePackaging: PackagingCheckpoint;
    packagingItemId?: string;
    /** Freeze the confirmed batch membership as well as the individual clip revisions. */
    sourceBatches?: FinalOutputDependency[];
    slots: { slotId: string; material: EffectTemplateMixMaterial }[];
    /** Removed occurrences need no model trim/narration; committed with the same frozen refresh. */
    removedSlotIds?: string[];
    /** Mix-only refresh retains the delivered file's original snapshot until explicit export. */
    previousOutputSnapshot?: Omit<FinalOutputSnapshot, 'sourceRefresh'>;
    trimsReady?: boolean;
    ready?: boolean;
    stage?: string;
    uploadedAudios?: Record<string, { fileObjectId: string; sha256: string; duration: number; segmentFrames?: number[];
      speechRanges?: PackagingAudio['speechRanges'] }>;
  };
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
  /** The frozen export/pending snapshot has picture only; not the live engineering state. */
  unpackaged?: boolean;
  /** A completed slot package exists for this film in its current source branch. */
  currentPackagingReady?: boolean;
  /** The exported film differs from the current mix project in this output branch. */
  stale: boolean;
};
export type FinalOutputRun = {
  id: string;
  sourceOperationId?: string;
  sourceOperationHasAdditions?: boolean;
  /** Frozen repair scope, including already completed films; absent for legacy tasks. */
  sourceOperationVariantIds?: string[];
  sourceOperationAppendStarted?: boolean;
  workflowRunId: string;
  /** Independent full export; keep the source branch's films and local-update controls visible. */
  backgroundExportSourceRunId?: string;
  /** Complete rendering is not publication: delivery validation must also have succeeded. */
  backgroundExportPublished?: boolean;
  templateId: string;
  templateName: string;
  /** The current template's rendered films were explicitly confirmed for delivery. */
  validated?: boolean;
  resolution: FinalOutputResolution;
  frameRate: 24 | 25 | 30 | 50 | 60;
  status: FinalOutputStatus;
  createdAt: string;
  items: FinalOutputItem[];
  /** Live project membership differences; absent when the source workspace was not loaded. */
  projectChanges?: {
    added: { variantId: string; name: string; duration?: number;
      cover?: FinalOutputItem['cover']; blockedReason?: string }[];
    removedItemIds: string[];
    draftRevision?: number;
  };
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
/** Compact, project-scoped status for one background export; no timeline snapshots. */
export type FinalOutputExportProgress = Pick<FinalOutputRun,
  'id' | 'workflowRunId' | 'backgroundExportSourceRunId' | 'backgroundExportPublished' |
  'templateId' | 'createdAt' | 'status'> & {
  counts: Pick<FinalOutputRun['counts'], 'total' | 'queued' | 'running' | 'completed' | 'failed'>;
  items: Pick<FinalOutputItem,
    'id' | 'variantId' | 'status' | 'progress' | 'fileObjectId' | 'assetId' | 'errorMessage'>[];
};
export type FinalOutputQueueMessage = {
  schemaVersion: 2;
  taskType: 'FINAL_OUTPUT';
  projectId: string;
  runId: string;
  requestId: string;
};
