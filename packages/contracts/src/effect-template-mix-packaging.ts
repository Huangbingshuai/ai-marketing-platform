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
    videoLanes: variant.videoLanes ?? {},
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
