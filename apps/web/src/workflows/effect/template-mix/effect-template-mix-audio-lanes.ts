import type {
  EffectTemplateMixDetachedAudio,
  EffectTemplateMixMaterial,
  EffectTemplateMixVariant,
  PackagingItem,
} from '@ai-marketing/contracts';

import { apiUrl } from '../../../api/http-client';

/**
 * Audio rows are generic tracks: every one of them is just 音频, and the clips differ only by
 * colour. So a clip's row is editor arrangement rather than a property of what the clip is — this
 * module is the single place that decides which row a clip lands on, shared by the timeline (which
 * draws the rows) and the workbench (which persists them and mutes them).
 */
export type AudioClipKind = 'DETACHED' | 'MUSIC' | 'VOICE';
export type AudioClipSource = 'DETACHED' | 'LEGACY' | 'PACKAGED';
export type AudioClipRef = {
  id: string;
  kind: AudioClipKind;
  source: AudioClipSource;
  /** The clip's own span, which is what keeps two overlapping clips off each other's row. */
  start: number;
  duration: number;
};

/**
 * Rows a clip falls back to before the user has moved it. This is only a sort key — rows compact
 * afterwards — but keeping 口播 above 纯音乐 above 分离原声 means a project the user has never
 * rearranged looks exactly the way it did before rows became movable.
 */
export const DEFAULT_AUDIO_LANE: Record<AudioClipKind, number> = {
  VOICE: 0,
  MUSIC: 1,
  DETACHED: 2,
};

/**
 * How a row is named outside this module. The timeline labels its rows with one of these and the
 * workbench parses the label back out of a mute or drop event, so the encoding lives here rather
 * than being spelled out at both ends.
 */
export type AudioRowTrack = `AUDIO:${number}`;
export const audioRowKey = (row: number): AudioRowTrack => `AUDIO:${row}`;
export const audioRowOfKey = (track: AudioRowTrack): number => Number(track.slice('AUDIO:'.length));

/** A library track is served from the project asset, a separated one from the material itself. */
export function detachedAudioSourceUrl(
  audio: EffectTemplateMixDetachedAudio,
  materials: EffectTemplateMixMaterial[],
  projectId: string | undefined,
): string {
  if (audio.sourceAssetId) {
    return projectId
      ? apiUrl(
          `/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(audio.sourceAssetId)}/content`,
        )
      : '';
  }
  const material = materials.find(({ fileObjectId }) => fileObjectId === audio.fileObjectId);
  if (material?.contentUrl) return material.contentUrl;
  return projectId
    ? apiUrl(
        `/projects/${encodeURIComponent(projectId)}/file-objects/${encodeURIComponent(audio.fileObjectId)}/content`,
      )
    : '';
}

/**
 * The clips the audio area shows, in the same order the timeline builds them. Membership has to be
 * decided in exactly one place: the row a clip renders on, the row it is muted by and the row that
 * gets persisted must all agree, or a clip would drift between them.
 */
export function timelineAudioClipRefs(
  variant: EffectTemplateMixVariant | null | undefined,
  packaging: PackagingItem | null | undefined,
  materials: EffectTemplateMixMaterial[],
  projectId: string | undefined,
): AudioClipRef[] {
  const refs: AudioClipRef[] = [];
  // A clip that predates the span being recorded simply gets a zero-length one: it then collides
  // with nothing and keeps its default row, which is how it was drawn before.
  const span = (audio: { start?: number; duration?: number } | null | undefined): {
    start: number;
    duration: number;
  } => ({
    start: typeof audio?.start === 'number' && Number.isFinite(audio.start) ? audio.start : 0,
    duration:
      typeof audio?.duration === 'number' && Number.isFinite(audio.duration) ? audio.duration : 0,
  });
  const packaged =
    packaging &&
    (packaging.checkpoint.narrationLayoutVersion === 'SLOT_V1' ||
      Object.keys(packaging.checkpoint.voices ?? {}).length > 0 ||
      Object.keys(packaging.checkpoint.captionVoices ?? {}).length > 0 ||
      Boolean(packaging.checkpoint.music));
  if (packaged && packaging) {
    for (const id of Object.keys(packaging.checkpoint.voices ?? {})) {
      refs.push({
        id: `voice:${id}`,
        kind: 'VOICE',
        source: 'PACKAGED',
        ...span(packaging.checkpoint.voices?.[id]),
      });
    }
    // A caption narration is a voice clip too, but it is keyed by caption and has no script line,
    // so it gets its own id namespace rather than colliding with a narration line of the same name.
    for (const id of Object.keys(packaging.checkpoint.captionVoices ?? {})) {
      refs.push({
        id: `capvoice:${id}`,
        kind: 'VOICE',
        source: 'PACKAGED',
        ...span(packaging.checkpoint.captionVoices?.[id]),
      });
    }
    if (packaging.checkpoint.music) {
      refs.push({
        id: 'music',
        kind: 'MUSIC',
        source: 'PACKAGED',
        ...span(packaging.checkpoint.music),
      });
    }
  } else {
    // Legacy variant audio has no slot-keyed packaging checkpoint, so it stays read-only.
    if (variant?.voice) {
      refs.push({ id: 'voice', kind: 'VOICE', source: 'LEGACY', ...span(variant.voice) });
    }
    if (variant?.bgm) {
      refs.push({ id: 'music', kind: 'MUSIC', source: 'LEGACY', ...span(variant.bgm) });
    }
  }
  for (const audio of variant?.detachedAudios ?? []) {
    // A clip with no playable source is not drawn, so it must not claim a row either.
    if (!detachedAudioSourceUrl(audio, materials, projectId)) continue;
    refs.push({
      id: `detached:${audio.id}`,
      kind: audio.audioKind ?? (audio.sourceAssetId ? 'MUSIC' : 'DETACHED'),
      source: 'DETACHED',
      ...span(audio),
    });
  }
  return refs;
}

/** The row a clip asks for: the one the editor stored for it, or its kind's default. */
export const rawAudioLane = (
  lanes: Record<string, number> | undefined,
  ref: Pick<AudioClipRef, 'id' | 'kind'>,
): number => Math.max(0, Math.round(lanes?.[ref.id] ?? DEFAULT_AUDIO_LANE[ref.kind]));

/**
 * The row every clip actually sits on. Two clips that overlap in time can never share one: they
 * would be drawn at the same height, the later one covering the earlier, and deleting the one on
 * top would only reveal a clip that looks just like it. So a clip starts from the row it asks for
 * and is pushed down until that row is free for its own span — the same invariant the video lanes
 * keep. `lanes` is therefore a preference, not a promise; the stored row is what the user dragged a
 * clip to, and it still wins whenever nothing else is already there.
 *
 * Clips are placed by the row they ask for first, so an explicit row is honoured before anything is
 * pushed into it, and only clips that really collide move.
 */
export function resolvedAudioLanes(
  refs: AudioClipRef[],
  lanes: Record<string, number> | undefined,
): Map<string, number> {
  const ends = new Map<number, number>();
  const placed = new Map<string, number>();
  const ordered = [...refs].sort(
    (left, right) =>
      rawAudioLane(lanes, left) - rawAudioLane(lanes, right) ||
      left.start - right.start ||
      left.id.localeCompare(right.id),
  );
  for (const ref of ordered) {
    let row = rawAudioLane(lanes, ref);
    // An untouched row has no end, and `-1` is before every clip's start, so it reads as free.
    while ((ends.get(row) ?? -1) > ref.start) row += 1;
    ends.set(row, ref.start + ref.duration);
    placed.set(ref.id, row);
  }
  return placed;
}

/** Only the rows clips actually occupy; an empty row simply stops existing. */
export function occupiedAudioLaneValues(
  refs: AudioClipRef[],
  lanes: Record<string, number> | undefined,
): number[] {
  return [...new Set(resolvedAudioLanes(refs, lanes).values())].sort((left, right) => left - right);
}

/** The row index a clip renders on, once the occupied rows have been compacted. */
export function audioRowOf(
  refs: AudioClipRef[],
  lanes: Record<string, number> | undefined,
  clipId: string,
): number {
  const resolved = resolvedAudioLanes(refs, lanes);
  const row = resolved.get(clipId);
  if (row === undefined) return 0;
  const index = [...new Set(resolved.values())].sort((left, right) => left - right).indexOf(row);
  return index >= 0 ? index : 0;
}

/** At least one row stays visible, mirroring the video lane count, so there is somewhere to drop. */
export function audioRowCount(
  refs: AudioClipRef[],
  lanes: Record<string, number> | undefined,
): number {
  return Math.max(1, occupiedAudioLaneValues(refs, lanes).length);
}

/**
 * Compact the stored rows down to 0..n-1, writing back the rows the clips really resolved to so a
 * corrected row reaches the next save. Keys for clips that are not currently visible are left alone
 * on purpose: repackaging swaps every voice line id, and this runs before the packaging checkpoint
 * has loaded, so deleting unseen keys would wipe the rows of every 口播 clip.
 */
export function compactAudioLanes(
  lanes: Record<string, number>,
  refs: AudioClipRef[],
): void {
  const resolved = resolvedAudioLanes(refs, lanes);
  const used = [...new Set(resolved.values())].sort((left, right) => left - right);
  const compacted = new Map(used.map((lane, index) => [lane, index]));
  for (const [id, lane] of resolved) lanes[id] = compacted.get(lane) ?? 0;
}
