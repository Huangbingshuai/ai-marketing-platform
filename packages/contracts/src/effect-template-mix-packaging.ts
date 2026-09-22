import type { EffectTemplateMixCaption, EffectTemplateMixVariant } from './effect-template-mix';

export const PACKAGING_STAGES = [
  'SNAPSHOT',
  'VISION',
  'SCRIPT',
  'VOICE',
  'MUSIC',
  'CAPTIONS',
  'READY',
] as const;
export type PackagingStage = (typeof PACKAGING_STAGES)[number];
export const PACKAGING_STAGE_LABELS: Record<PackagingStage, string> = {
  SNAPSHOT: '冻结时间轴',
  VISION: '视觉理解',
  SCRIPT: '口播策划',
  VOICE: '生成配音',
  MUSIC: '生成纯音乐',
  CAPTIONS: '字幕对齐',
  READY: '包装草稿',
};
export type PackagingStatus =
  'QUEUED' | 'RUNNING' | 'COMPLETED' | 'PARTIAL' | 'FAILED' | 'CANCELLED';
export type PackagingComponent = 'ALL' | 'VOICE' | 'MUSIC' | 'CAPTIONS';
export type PackagingFact = { id: string; text: string; artifactId: string; revision: number };
export type PackagingClip = {
  slotId: string;
  materialId: string;
  fileObjectId: string;
  contentHash: string;
  start: number;
  duration: number;
  offset: number;
  lane: number;
  prompt: string;
  transition: string;
  transitionDuration: number;
};
export type PackagingAudio = {
  fileObjectId: string;
  duration: number;
  start: number;
  volume: number;
  /** Seconds trimmed from the source head; absent means 0 (pipeline canonical). */
  offset?: number;
  /**
   * Seconds of fade at the clip head; absent means "pipeline default", which is 0 for a narration
   * line and `min(0.5, duration / 2)` for the music bed (see the worker's `final_output.py`).
   */
  fadeIn?: number;
  /** Seconds of fade at the clip tail; absent means the same pipeline default as `fadeIn`. */
  fadeOut?: number;
};

/** Editor-authored geometry for one packaged audio clip. */
export type PackagingAudioEdit = {
  start: number;
  offset?: number;
  /** Trimmed length; bounded by the server-known source tail, so it cannot be forged. */
  duration?: number;
  volume: number;
  fadeIn?: number;
  fadeOut?: number;
};
/**
 * Where one caption sits in the frame. Values are normalised so a box survives a change
 * of output size; absent means "pipeline default" (bottom-centred, 40px margins).
 *
 * Kept beside `captions` instead of on them because a component redo regenerates the
 * caption list, while the editor's geometry has to survive it.
 */
export type PackagingCaptionBox = {
  /** Centre of the text block, as a fraction of frame width (0–1). */
  x: number;
  /** Distance from the frame bottom to the block bottom, as a fraction of height (0–1). */
  y: number;
  /** Wrap width as a fraction of frame width (0.1–1). */
  width: number;
  /** Font scale; 1 is the pipeline default (frame width / 22). */
  scale: number;
};
export type UpdatePackagingAudioRequest = {
  expectedUpdatedAt: string;
  /** Keyed by script line id. */
  voices?: Record<string, PackagingAudioEdit>;
  music?: PackagingAudioEdit;
  /** Full replacement; the server sorts by start and rejects overlaps. */
  captions?: EffectTemplateMixCaption[];
  /** Keyed by caption id; merged into the stored boxes, so only edited ones are sent. */
  boxes?: Record<string, PackagingCaptionBox>;
};
export type PackagingLine = {
  id: string;
  text: string;
  start: number;
  end: number;
  factIds: string[];
};
export type PackagingCheckpoint = {
  /** Persist before polling. Unknown submission outcomes must never be auto-resubmitted. */
  musicTaskId?: string;
  musicSubmissionPending?: boolean;
  vision?: { start: number; end: number; description: string }[];
  script?: PackagingLine[];
  musicBrief?: string;
  voices?: Record<string, PackagingAudio>;
  music?: PackagingAudio;
  captions?: EffectTemplateMixCaption[];
  /** Editor-authored caption geometry, keyed by caption id. Untouched by component redos. */
  captionBoxes?: Record<string, PackagingCaptionBox>;
};
export type PackagingSnapshot = {
  sourceTimelineHash: string;
  duration: number;
  variant: EffectTemplateMixVariant;
  clips: PackagingClip[];
  facts: PackagingFact[];
  dependencies: {
    artifactId: string;
    artifactKey: string;
    revision: number;
    contentHash: string;
    nodeId: string;
  }[];
};
export type PackagingItem = {
  id: string;
  /** Owning run, so editors can address the item without re-listing runs. */
  runId: string;
  variantId: string;
  name: string;
  shardIndex: number;
  sourceTimelineHash: string;
  sourceVisualTimeline: ReturnType<typeof packagingVisualTimeline>;
  status: PackagingStatus;
  stage: PackagingStage;
  checkpoint: PackagingCheckpoint;
  stale: boolean;
  errorMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
  /** Optimistic-lock token for editor audio edits. */
  updatedAt: string;
};
export type PackagingRun = {
  id: string;
  templateId: string;
  workflowRunId: string;
  status: PackagingStatus;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  items: PackagingItem[];
  counts: { total: number; completed: number; failed: number; stale: number; shards: number };
  execution?: PackagingExecution;
};
export type PackagingExecution = {
  progressPercent: number;
  queued: number;
  running: number;
  completed: number;
  elapsedSeconds: number;
  throughputPerMinute: number | null;
  estimatedRemainingSeconds: number | null;
  estimateBasis: 'BASELINE' | 'OBSERVED' | 'TERMINAL';
  delayed: boolean;
  shards: { index: number; total: number; completed: number; running: number; failed: number }[];
};
export type CreatePackagingRequest = {
  workflowRunId: string;
  expectedRevision: number;
  idempotencyKey: string;
  variantId?: string;
  component?: PackagingComponent;
};
export type PackagingQueueMessage = {
  schemaVersion: 2;
  taskType: 'PACKAGING';
  projectId: string;
  runId: string;
  requestId: string;
};

/** Stable visual content; editor selection and audio edits are not visual changes. */
export function packagingVisualTimeline(variant: EffectTemplateMixVariant) {
  return {
    id: variant.id,
    slots: variant.slots,
    bindings: variant.bindings,
    bindingRevisions: variant.bindingRevisions,
    offsets: variant.offsets,
    timelineStarts: variant.timelineStarts ?? {},
    // Missing lane and explicit lane 0 render identically. Editor normalization
    // must not invalidate already-paid packaging or confirmed visual sources.
    videoLanes: Object.fromEntries(Object.entries(variant.videoLanes ?? {}).filter(([, lane]) => lane !== 0)),
  };
}
export function packagingVisualVariant(variant: EffectTemplateMixVariant) {
  // Intentionally omit these fields from the independently versioned visual copy.
  /* eslint-disable @typescript-eslint/no-unused-vars */
  const {
    captions: _captions,
    subtitleStyle: _style,
    bgm: _bgm,
    voice: _voice,
    originalVolume: _volume,
    ...visual
  } = variant;
  /* eslint-enable @typescript-eslint/no-unused-vars */
  return visual;
}
export function packagingTimelineClips(variant: EffectTemplateMixVariant) {
  let cursor = 0;
  return variant.slots.map((slot) => {
    const start = variant.timelineStarts?.[slot.id] ?? cursor;
    cursor = start + slot.duration;
    return { slot, start, end: cursor, lane: variant.videoLanes?.[slot.id] ?? 0 };
  });
}
export function packagingTimelineDuration(variant: EffectTemplateMixVariant): number {
  return Math.max(
    0,
    ...packagingTimelineClips(variant)
      .filter((row) => variant.bindings[row.slot.id])
      .map((row) => row.end),
  );
}

/** Scheduling groups, not combined model prompts: each item keeps its own token budget. */
export function packagingShardIndexes(snapshots: PackagingSnapshot[]): number[] {
  return snapshots.map((_, index) => Math.floor(index / 4));
}
