import type { EffectVoiceSelection, SlotNarrationMetrics } from './effect-voice';
import type {
  EffectTemplateMixCaption,
  EffectTemplateMixDetachedAudio,
  EffectTemplateMixVariant,
  EffectTemplateMixMaterial,
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
  /** Frozen user-facing source label; optional on historical snapshots. */
  materialCode?: string;
  materialName?: string;
  fileObjectId: string;
  contentHash: string;
  start: number;
  duration: number;
  offset: number;
  lane: number;
  prompt: string;
  /** Picture-only clip: it renders, but the Worker gives it no narration, subtitle or description. */
  overlay?: boolean;
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
  /** Exact 24 kHz PCM frame count for each punctuation-delimited TTS clip, in caption order. */
  segmentFrames?: number[];
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
  audio: { duration: number; fadeIn?: number | undefined; fadeOut?: number | undefined },
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
/** Only user-editable caption fields are accepted; segment lineage stays server-owned. */
export type PackagingCaptionEdit = Pick<
  EffectTemplateMixCaption,
  'id' | 'text' | 'start' | 'end'
> & {
  manual?: boolean;
  /**
   * The row the caption sits on. A track of its own; `null` sends it back to the implicit row the
   * pipeline lays out edge to edge, and an absent field leaves the row exactly as it is.
   */
  trackId?: string | null;
};
/**
 * Where one caption sits in the frame. Values are normalised so a box survives a change
 * of output size; absent means "pipeline default" (bottom-centred, 3% bottom margin).
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
  captions?: PackagingCaptionEdit[];
  /** Keyed by caption id; merged into the stored boxes, so only edited ones are sent. */
  boxes?: Record<string, PackagingCaptionBox>;
  /** Keyed by caption id; only the ones the editor moved or trimmed are sent. */
  captionVoices?: Record<string, PackagingAudioEdit>;
  /**
   * Script line ids whose narration the editor deleted. A voice is an optional overlay on its line,
   * not a part of it: the line stays, so the subtitle stays too, and the film simply has no speech
   * there. Re-packaging synthesizes every line again, so a deletion lasts until the next run.
   */
  removedVoices?: string[];
  /**
   * Caption ids whose generated narration the editor deleted. A caption narration hangs off its
   * caption and nothing else, so dropping the entry is all a delete is.
   */
  removedCaptionVoices?: string[];
  /** Drop the packaged music bed. The film keeps its length; it simply has no BGM. */
  removeMusic?: boolean;
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
  /** Absent for historical one-caption-per-voice packages, which remain playable. */
  /** V3 uses the actual PCM frame boundaries of separately synthesized clauses. */
  captionLayoutVersion?: 'SEGMENT_V1' | 'SEGMENT_V2' | 'SEGMENT_V3';
  narrationMetrics?: Record<string, SlotNarrationMetrics>;
  /** Bounded item recovery budget, retained across worker restarts. */
  automaticRetries?: number;
  narrationLayoutVersion?: 'SLOT_V1';
  voiceFitAttempts?: Record<string, 1>;
  /** One automatic fresh-script recovery per frozen slot after measured TTS still overruns. */
  voiceSlotRetries?: Record<string, 1>;
  slotVision?: Record<string, { key: string; description: string }>;
  timings?: Record<
    string,
    {
      preprocessingSeconds?: number;
      visionSeconds?: number;
      scriptSeconds?: number;
      scriptRepairSlots?: number;
      voiceSeconds?: number;
      voiceRepairSeconds?: number;
      musicWaitSeconds?: number;
      localQueueSeconds?: number;
      apiHeartbeatSeconds?: number;
      checkpointSeconds?: number;
      voiceUploadSeconds?: number;
      musicDownloadSeconds?: number;
      musicPreprocessQueueSeconds?: number;
      musicTranscodeSeconds?: number;
      musicUploadSeconds?: number;
      captionSeconds?: number;
      cacheHit?: boolean;
    }
  >;
  /**
   * Persist before polling. Unknown submission outcomes must never be auto-resubmitted.
   * `null` means the supplier reported the task as terminally failed, so a retry submits a new song
   * instead of polling the dead one.
   */
  musicTaskId?: string | null;
  musicSubmissionPending?: boolean;
  vision?: { slotId?: string; start: number; end: number; description: string }[];
  script?: PackagingLine[];
  musicBrief?: string;
  voices?: Record<string, PackagingAudio>;
  music?: PackagingAudio;
  captions?: EffectTemplateMixCaption[];
  /** Editor-authored caption geometry, keyed by caption id. Untouched by component redos. */
  captionBoxes?: Record<string, PackagingCaptionBox>;
  /**
   * Narration the editor generated for one caption, keyed by caption id. It is deliberately not
   * `voices`: a `voices` key must line up with a `script` line, and a component redo deletes both,
   * so an entry there would either fail validation or be wiped by a redo. The renderer mixes these
   * exactly like a narration line — they are the same shape on purpose.
   */
  captionVoices?: Record<string, PackagingAudio>;
};
export type PackagingSnapshot = {
  /** Server-authorized current-branch append; never supplied by the browser. */
  incrementalFillRunId?: string;
  /** Optional only for pre-library tasks. New jobs freeze the server-selected profile. */
  voiceProfile?: EffectVoiceSelection;
  narrationLayoutVersion?: 'SLOT_V1';
  redoSlotId?: string;
  /** Local output refresh regenerates only these slots and keeps the music bed as edited. */
  redoSlotIds?: string[];
  preserveMusic?: boolean;
  /** Full packaging on a new branch selects fresh cuts for confirmed source replacements. */
  sourceTrimMaterials?: { slotId: string; material: EffectTemplateMixMaterial }[];
  sourceTrimsReady?: boolean;
  /** Subtitle-only redo reuses saved editor audio geometry without synthesizing again. */
  redoCaptionsOnly?: boolean;
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
  /** Safe, user-facing projection of frozen source clips; never includes file or material IDs. */
  sourceClips?: Array<{
    slotLabel: string;
    materialName: string;
    sourceOffset: number;
    timelineStart: number;
    duration: number;
    transition: string;
    transitionDuration: number;
    originalAudioDetached: boolean;
  }>;
  /** Confirmed product facts used by this package, for explanatory node examples. */
  sourceFacts?: Array<{ id: string; text: string }>;
  status: PackagingStatus;
  stage: PackagingStage;
  checkpoint: PackagingCheckpoint;
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
  counts: { total: number; completed: number; failed: number; shards: number };
  execution?: PackagingExecution;
};
export type PackagingExecution = {
  performance?: {
    cacheHits: number;
    cacheLookups: number;
    cacheHitRate: number | null;
    stages: Record<
      string,
      { samples: number; p50Seconds: number; p95Seconds: number; totalSeconds: number }
    >;
  };
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
/**
 * The editor asks for one caption's text to be spoken again with the template's own voice.
 *
 * `text` is an assertion, not the text to speak: synthesis always reads the caption the server has
 * stored, so a client cannot spend the project's paid voice budget on arbitrary words. Sending the
 * text the editor is showing makes a caption that is still inside its save debounce fail loudly
 * instead of quietly being voiced from the previous revision.
 */
export type CreatePackagingCaptionVoiceRequest = {
  captionId: string;
  text: string;
};
/** One caption narration request; the worker synthesizes and posts the audio back. */
export type PackagingCaptionVoiceQueueMessage = {
  schemaVersion: 2;
  taskType: 'CAPTION_VOICE';
  projectId: string;
  runId: string;
  itemId: string;
  captionId: string;
  text: string;
  /** The profile frozen on the snapshot, so the new line matches the item's other narration. */
  profile: EffectVoiceSelection;
  requestId: string;
};

export const PACKAGING_NARRATION_LAYOUT = 'SLOT_V1' as const;
/** Pure mechanical preflight shared by server and editor. */
export function packagingSlotBoundaryError(variant: EffectTemplateMixVariant): string | null {
  const rows = packagingTimelineClips(variant).sort((a, b) => a.start - b.start);
  if (
    rows.some(
      ({ slot }) => !Number.isFinite(slot.duration) || slot.duration < 4 || slot.duration > 15,
    )
  )
    return '槽位时长必须为 4–15 秒';
  if (new Set(rows.map((r) => r.slot.id)).size !== rows.length) return '槽位编号重复';
  // Narration is spoken one line at a time, so the slots that own one still may not overlap. An
  // overlay owns no line: it is a picture layer the user stacked on top, and covering what is under
  // it is exactly what it is for.
  const narrated = rows.filter(({ slot }) => slot.overlay !== true);
  if (
    narrated.some(
      (r, i) =>
        !Number.isFinite(r.start) ||
        r.start < 0 ||
        (i > 0 && r.start < narrated[i - 1]!.end - 0.001),
    )
  )
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

/**
 * Stable visual content; editor selection and audio edits are not visual changes.
 *
 * An overlay is left out on purpose. It is a picture layer the user stacked on top, and the render
 * reads it straight from the live variant, so it is not part of what a packaging freezes: adding,
 * moving or removing one must not restate an already-confirmed package — nor, through that, lock the
 * captions and audio that were already arranged beside it.
 *
 * What is left is the narrated clips, and those never overlap each other, so only their relative
 * row order can change what the film looks like. Rows are therefore compared by rank rather than by
 * number, which keeps an overlay's new row from renumbering every narrated clip and restating the
 * hash behind the user's back.
 */
export function packagingVisualTimeline(variant: EffectTemplateMixVariant) {
  const slots = variant.slots.filter((slot) => slot.overlay !== true);
  const narrated = new Set(slots.map((slot) => slot.id));
  const keep = <T>(values: Record<string, T> | undefined): Record<string, T> =>
    Object.fromEntries(Object.entries(values ?? {}).filter(([id]) => narrated.has(id)));
  const laneOf = (slotId: string): number =>
    Math.max(0, Math.round(variant.videoLanes?.[slotId] ?? 0));
  const ranks = new Map(
    [...new Set(slots.map((slot) => laneOf(slot.id)))]
      .sort((left, right) => left - right)
      .map((lane, index) => [lane, index] as const),
  );
  // A start the sequential layout would have produced anyway is not a visual change. The editor
  // materializes one for every slot on the first trim, and that must not restate the hash of an
  // already-confirmed package — the same principle as the lane ranks below. So an explicit start is
  // kept only when it really moves its clip off the cursor. The walk covers every slot, overlays
  // included, because an overlay still occupies time; only the output is narrowed to narrated slots.
  const timelineStarts = (() => {
    let cursor = 0;
    const starts: Record<string, number> = {};
    for (const slot of variant.slots) {
      const explicit = variant.timelineStarts?.[slot.id];
      const start = explicit ?? cursor;
      if (explicit !== undefined && explicit !== cursor && narrated.has(slot.id)) {
        starts[slot.id] = explicit;
      }
      cursor = start + slot.duration;
    }
    return starts;
  })();
  return {
    id: variant.id,
    slots,
    bindings: keep(variant.bindings),
    bindingRevisions: keep(variant.bindingRevisions),
    offsets: keep(variant.offsets),
    timelineStarts,
    // Missing lane and explicit lane 0 render identically. Editor normalization
    // must not invalidate already-paid packaging or confirmed visual sources.
    videoLanes: Object.fromEntries(
      slots
        .map((slot) => [slot.id, ranks.get(laneOf(slot.id)) ?? 0] as const)
        .filter(([, lane]) => lane !== 0),
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
/**
 * The narrated slots' explicit starts exactly as the variant stores them, before
 * {@link packagingVisualTimeline} drops the ones the sequential layout would have produced anyway.
 *
 * A package confirmed before that normalization was hashed with them still in place, so reading its
 * hash back needs this shape — otherwise the normalization itself would read as a visual change and
 * expire a film whose frames never moved.
 */
export function packagingStoredTimelineStarts(
  variant: EffectTemplateMixVariant,
): Record<string, number> {
  const narrated = new Set(
    variant.slots.filter((slot) => slot.overlay !== true).map((slot) => slot.id),
  );
  return Object.fromEntries(
    Object.entries(variant.timelineStarts ?? {}).filter(([id]) => narrated.has(id)),
  );
}
/**
 * The overlay layers {@link packagingVisualTimeline} deliberately leaves out, so the places that do
 * have to notice a picture-only change can still tell two arrangements apart — the render's own
 * dedupe key, above all, which would otherwise hand back the run it built before the overlay existed.
 */
export function packagingOverlayTimeline(variant: EffectTemplateMixVariant) {
  return variant.slots
    .filter((slot) => slot.overlay === true)
    .map((slot) => ({
      id: slot.id,
      binding: variant.bindings[slot.id] ?? null,
      bindingRevision: variant.bindingRevisions[slot.id] ?? null,
      offset: variant.offsets[slot.id] ?? 0,
      start: variant.timelineStarts?.[slot.id] ?? null,
      lane: variant.videoLanes?.[slot.id] ?? 0,
      duration: slot.duration,
      transition: slot.transition,
      transitionDuration: slot.transitionDuration ?? 0,
    }));
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
    // Which audio row a clip sits on is editor arrangement, so it must stay out of the visual copy
    // — otherwise dragging a clip up or down would rewrite an already-confirmed source payload.
    audioLanes: _audioLanes,
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
/**
 * The length of the visual timeline: how far the video clips reach. It is the packaging capacity
 * baseline and the `timeline-project` artifact's own duration, so it deliberately ignores audio and
 * captions — use {@link effectTemplateMixContentDuration} for the finished film's length.
 */
export function packagingTimelineDuration(variant: EffectTemplateMixVariant): number {
  return Math.max(
    0,
    ...packagingTimelineClips(variant)
      .filter((row) => variant.bindings[row.slot.id])
      .map((row) => row.end),
  );
}
/**
 * How long the finished film is: the furthest end over everything the editor has placed, not just the
 * video clips. Dragging an audio or caption clip past the last video clip is how a black tail with
 * sound is made, so the render length, the editor's playhead range and the server's bounds all have
 * to follow it. `checkpoint` is optional because the packaging run that produces one does not have it
 * yet; the captions follow the same precedence the editor uses (checkpoint first, draft second).
 */
export function effectTemplateMixContentDuration(
  variant: EffectTemplateMixVariant,
  checkpoint?: PackagingCheckpoint | null,
): number {
  const ends = [packagingTimelineDuration(variant)];
  for (const audio of variant.detachedAudios ?? []) ends.push(audio.start + audio.duration);
  // A generated caption narration is a narration line in every way that matters to the renderer,
  // including its length, so it counts here too — otherwise a line longer than the picture would
  // be rejected by the renderer's own bounds check instead of extending the film.
  for (const voice of [
    ...Object.values(checkpoint?.voices ?? {}),
    ...Object.values(checkpoint?.captionVoices ?? {}),
  ]) {
    ends.push(voice.start + voice.duration);
  }
  if (checkpoint?.music) ends.push(checkpoint.music.start + checkpoint.music.duration);
  for (const caption of checkpoint?.captions ?? variant.captions ?? []) ends.push(caption.end);
  return Math.max(0, ...ends);
}
/**
 * The ceiling on a film's length, in seconds. Because the length follows the content, a clip placed
 * past the end is legal, so this is the only bound left — it keeps a stray drag from asking the
 * renderer for an unbounded job.
 */
export const EFFECT_TEMPLATE_MIX_MAX_CONTENT_SECONDS = 3600;

/** Scheduling groups, not combined model prompts: each item keeps its own token budget. */
export function packagingShardIndexes(snapshots: PackagingSnapshot[]): number[] {
  return snapshots.map((_, index) => Math.floor(index / 4));
}
