import type { EffectVoiceSelection, SlotNarrationMetrics } from './effect-voice';
import type {
  EffectTemplateMixCaption,
  EffectTemplateMixDetachedAudio,
  EffectTemplateMixVariant,
} from './effect-template-mix';

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
  /** The source audio is represented by a separate timeline clip. */
  originalAudioDetached?: boolean;
};
export type PackagingAudio = {
  /** Absent on historical audio; do not infer its speaker from current settings. */
  voiceProfile?: EffectVoiceSelection;
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

/**
 * The music bed's own easing, in seconds, when the editor has not set one. The worker
 * (`final_output.py`) halves it for a very short bed, so this is a ceiling rather than a fixed value.
 */
export const EFFECT_TEMPLATE_MIX_MUSIC_FADE_DEFAULT = 0.5;
/**
 * The fade that will actually be rendered, in seconds. Absent means "pipeline default" — 0 for a
 * narration line, `min(0.5, duration / 2)` for the music bed — so the editor and the timeline read
 * the same number the worker will use instead of guessing at a missing field.
 */
export function packagingAudioFade(
  audio: { duration: number; fadeIn?: number; fadeOut?: number },
  kind: 'MUSIC' | 'VOICE',
  edge: 'fadeIn' | 'fadeOut',
): number {
  return (
    audio[edge] ??
    (kind === 'MUSIC' ? Math.min(EFFECT_TEMPLATE_MIX_MUSIC_FADE_DEFAULT, audio.duration / 2) : 0)
  );
}
/**
 * The volume scale the editor's dB row, the timeline's level line and the server's validation all
 * share. A gain is stored (0–1 and above), dB is what an editor reasons in, and the floor is the
 * same value the worker renders as silence — which is why it is shown as `-∞` rather than as -60.
 */
export const PACKAGING_AUDIO_DB_FLOOR = -60;
export const PACKAGING_AUDIO_DB_CEILING = 20;
/** The gain the top of the scale stands for (10× = +20 dB), and the loudest the server accepts. */
export const PACKAGING_AUDIO_GAIN_CEILING = 10 ** (PACKAGING_AUDIO_DB_CEILING / 20);
/** Gain → dB, folding anything at or under the floor onto the floor so silence reads as `-∞`. */
export function packagingAudioToDb(gain: number): number {
  return gain > 0
    ? Math.max(PACKAGING_AUDIO_DB_FLOOR, 20 * Math.log10(gain))
    : PACKAGING_AUDIO_DB_FLOOR;
}
export function packagingAudioFromDb(db: number): number {
  return db <= PACKAGING_AUDIO_DB_FLOOR ? 0 : 10 ** (db / 20);
}
/** Where a gain sits on the scale, 0–1, so a level line drawn in dB matches the dB row. */
export function packagingAudioLevel(volume: number): number {
  return Math.min(
    1,
    Math.max(
      0,
      (packagingAudioToDb(volume) - PACKAGING_AUDIO_DB_FLOOR) /
        (PACKAGING_AUDIO_DB_CEILING - PACKAGING_AUDIO_DB_FLOOR),
    ),
  );
}

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
  /** Absent only in legacy whole-film narration, which remains playable. */
  slotId?: string;
  text: string;
  start: number;
  end: number;
  factIds: string[];
};
export type PackagingCheckpoint = {
  narrationMetrics?: Record<string, SlotNarrationMetrics>;
  /** Bounded item recovery budget, retained across worker restarts. */
  automaticRetries?: number;
  narrationLayoutVersion?: 'SLOT_V1';
  voiceFitAttempts?: Record<string, 1>;
  slotVision?: Record<string, { key: string; description: string }>;
  timings?: Record<string, { preprocessingSeconds?: number; visionSeconds?: number;
    scriptSeconds?: number; voiceSeconds?: number; musicWaitSeconds?: number;
    localQueueSeconds?: number;
    cacheHit?: boolean }>;
  /** Persist before polling. Unknown submission outcomes must never be auto-resubmitted. */
  musicTaskId?: string;
  musicSubmissionPending?: boolean;
  vision?: { slotId?: string; start: number; end: number; description: string }[];
  script?: PackagingLine[];
  musicBrief?: string;
  voices?: Record<string, PackagingAudio>;
  music?: PackagingAudio;
  captions?: EffectTemplateMixCaption[];
  /** Editor-authored caption geometry, keyed by caption id. Untouched by component redos. */
  captionBoxes?: Record<string, PackagingCaptionBox>;
};
export type PackagingSnapshot = {
  /** Optional only for pre-library tasks. New jobs freeze the server-selected profile. */
  voiceProfile?: EffectVoiceSelection;
  narrationLayoutVersion?: 'SLOT_V1';
  redoSlotId?: string;
  sourceTimelineHash: string;
  duration: number;
  variant: EffectTemplateMixVariant;
  clips: PackagingClip[];
  /** Optional for historical snapshots created before source-audio separation. */
  detachedAudios?: EffectTemplateMixDetachedAudio[];
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
  performance?: { cacheHits: number; cacheLookups: number; cacheHitRate: number | null;
    stages: Record<string, { samples: number; p50Seconds: number; p95Seconds: number; totalSeconds: number }> };
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
  slotId?: string;
};

export const PACKAGING_NARRATION_LAYOUT = 'SLOT_V1' as const;
/** Pure mechanical preflight shared by server and editor. */
export function packagingSlotBoundaryError(variant: EffectTemplateMixVariant): string | null {
  const rows = packagingTimelineClips(variant).sort((a, b) => a.start - b.start);
  if (rows.some(({ slot }) => !Number.isFinite(slot.duration) || slot.duration < 3 || slot.duration > 15))
    return '槽位时长必须为 3–15 秒';
  if (new Set(rows.map((r) => r.slot.id)).size !== rows.length) return '槽位编号重复';
  if (rows.some((r, i) => !Number.isFinite(r.start) || r.start < 0 || (i > 0 && r.start < rows[i - 1]!.end - 0.001)))
    return '槽位口播边界冲突，请调整时间轴';
  return null;
}
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
    videoLanes: Object.fromEntries(
      Object.entries(variant.videoLanes ?? {}).filter(([, lane]) => lane !== 0),
    ),
    ...((variant.detachedAudios?.length ?? 0) > 0
      ? {
          detachedAudios: [...variant.detachedAudios!].sort(
            (left, right) => left.start - right.start || left.id.localeCompare(right.id),
          ),
        }
      : {}),
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
