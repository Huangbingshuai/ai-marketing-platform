import type { PackagingItem } from '@ai-marketing/contracts';
import { describe, expect, it } from 'vitest';

import {
  audioRowCount,
  audioRowOf,
  compactAudioLanes,
  resolvedAudioLanes,
  timelineAudioClipRefs,
  type AudioClipKind,
  type AudioClipRef,
} from './effect-template-mix-audio-lanes';

const ref = (id: string, kind: AudioClipKind, start: number, duration: number): AudioClipRef => ({
  id,
  kind,
  source: 'PACKAGED',
  start,
  duration,
});

/**
 * The clips and stored rows of the packaging the editor was reported on (成片 71027be6): six script
 * narrations on row 0, a caption narration on row 0 as well, and the music bed on row 1. The caption
 * narration spans 8.766–11.776 and one script narration spans 4–10.979, so the two overlapped while
 * both were stored on row 0 — the reported "新生成的口播压在下面的口播上".
 */
const VOICE_SLOTS: Array<[string, number, number]> = [
  ['slot-aa4006ff44c0c59b3174b476', 0, 2.209],
  ['slot-e16580d5c1082e1d4c8fcf6b', 4, 6.979],
  ['slot-8ae16e8359be0c7f711686d3', 14, 6.767],
  ['slot-3a1c77d718642941724bb215', 24, 7.559],
  ['slot-262f54e1960aa4d34c847513', 34, 6.767],
  ['slot-c544a158ae60cf5aaba0ce56', 42, 2.39],
];
const CAPTION_ID = 'caption-2183e9e90838e91503c6b262';
const CAPTION_CLIP = `capvoice:${CAPTION_ID}`;
const reportedRefs = (): AudioClipRef[] => [
  ...VOICE_SLOTS.map(([id, start, duration]) => ref(`voice:${id}`, 'VOICE', start, duration)),
  ref(CAPTION_CLIP, 'VOICE', 8.766, 3.01),
  ref('music', 'MUSIC', 0, 46),
];
const reportedLanes = (): Record<string, number> => ({
  music: 1,
  ...Object.fromEntries(VOICE_SLOTS.map(([id]) => [`voice:${id}`, 0])),
  [CAPTION_CLIP]: 0,
});

/** Every pair of clips that share a row must not overlap, which is the whole point of resolving. */
const overlappingRowMates = (refs: AudioClipRef[], lanes: Record<string, number>): string[] => {
  const resolved = resolvedAudioLanes(refs, lanes);
  const clashes: string[] = [];
  for (const left of refs) {
    for (const right of refs) {
      if (left.id >= right.id) continue;
      if (resolved.get(left.id) !== resolved.get(right.id)) continue;
      if (left.start < right.start + right.duration && right.start < left.start + left.duration) {
        clashes.push(`${left.id} / ${right.id}`);
      }
    }
  }
  return clashes;
};

describe('audio clip rows', () => {
  it('pushes a caption narration off the script narration it overlaps', () => {
    const refs = reportedRefs();
    const lanes = reportedLanes();

    const resolved = resolvedAudioLanes(refs, lanes);

    // The caption narration asked for row 0, but the script narration it overlaps owns 8.766–10.979
    // there — so it lands on row 1, which pushes the music bed (0–46) down to row 2 in turn.
    expect(resolved.get(CAPTION_CLIP)).toBe(1);
    expect(resolved.get('music')).toBe(2);
    expect(resolved.get('voice:slot-e16580d5c1082e1d4c8fcf6b')).toBe(0);
    expect(overlappingRowMates(refs, lanes)).toEqual([]);
  });

  it('lets the music bed keep its row when nothing collides with it', () => {
    // Without the caption narration, the reported arrangement is already legal and must not move.
    const refs = reportedRefs().filter(({ id }) => id !== CAPTION_CLIP);
    const lanes = reportedLanes();
    delete lanes[CAPTION_CLIP];

    const resolved = resolvedAudioLanes(refs, lanes);

    expect(resolved.get('music')).toBe(1);
    expect([...new Set(resolved.values())]).toEqual([0, 1]);
    expect(audioRowCount(refs, lanes)).toBe(2);
  });

  it('keeps narration clips that follow one another on the same row', () => {
    const refs = [ref('voice:a', 'VOICE', 0, 4), ref('voice:b', 'VOICE', 4, 4)];

    expect(resolvedAudioLanes(refs, {}).get('voice:b')).toBe(0);
    expect(audioRowCount(refs, {})).toBe(1);
  });

  it('honours a stored row the user dragged a clip to while it is free', () => {
    const refs = [ref('voice:a', 'VOICE', 0, 4), ref('voice:b', 'VOICE', 10, 4)];

    expect(resolvedAudioLanes(refs, { 'voice:b': 3 }).get('voice:b')).toBe(3);
  });

  it('still moves a clip dragged onto a row another clip already occupies at that time', () => {
    // Two clips cannot be drawn on top of each other, so the row is a preference and not a promise.
    const refs = [ref('voice:a', 'VOICE', 0, 4), ref('detached:x', 'DETACHED', 1, 4)];

    const resolved = resolvedAudioLanes(refs, { 'voice:a': 0, 'detached:x': 0 });

    expect(resolved.get('detached:x')).toBe(1);
  });

  it('gives a clip with no recorded span its default row instead of a phantom collision', () => {
    // Historical checkpoints have no start/duration; a zero-length span collides with nothing.
    const refs = [ref('voice:a', 'VOICE', 0, 0), ref('voice:b', 'VOICE', 0, 0)];

    expect(resolvedAudioLanes(refs, {}).get('voice:b')).toBe(0);
    expect(audioRowCount(refs, {})).toBe(1);
  });

  it('reports the compacted row index, so the timeline draws the rows it counts', () => {
    const refs = reportedRefs();
    const lanes = reportedLanes();

    expect(audioRowOf(refs, lanes, 'voice:slot-aa4006ff44c0c59b3174b476')).toBe(0);
    expect(audioRowOf(refs, lanes, CAPTION_CLIP)).toBe(1);
    expect(audioRowOf(refs, lanes, 'music')).toBe(2);
    expect(audioRowOf(refs, lanes, 'detached:missing')).toBe(0);
  });

  it('writes the resolved rows back compacted, so the fix survives the next save', () => {
    const refs = reportedRefs();
    const lanes = reportedLanes();

    compactAudioLanes(lanes, refs);

    expect(lanes[CAPTION_CLIP]).toBe(1);
    expect(lanes.music).toBe(2);
    expect(lanes['voice:slot-aa4006ff44c0c59b3174b476']).toBe(0);
    expect(new Set(Object.values(lanes))).toEqual(new Set([0, 1, 2]));
    // A second pass must be a no-op: the rows it just wrote are already conflict-free.
    const again = { ...lanes };
    compactAudioLanes(again, refs);
    expect(again).toEqual(lanes);
  });
});

describe('audio clip spans', () => {
  it('carries each clip own start and duration into its ref', () => {
    const packaging = {
      checkpoint: {
        narrationLayoutVersion: 'SLOT_V1',
        voices: { 'slot-a': { start: 4, duration: 6.979 } },
        captionVoices: { [CAPTION_ID]: { start: 8.766, duration: 3.01 } },
        music: { start: 0, duration: 46 },
      },
    } as unknown as PackagingItem;
    const variant = {
      detachedAudios: [{ id: 'd1', fileObjectId: 'f1', start: 2, duration: 5 }],
    } as unknown as Parameters<typeof timelineAudioClipRefs>[0];

    const refs = timelineAudioClipRefs(variant, packaging, [], 'project-1');

    expect(refs).toEqual([
      { id: 'voice:slot-a', kind: 'VOICE', source: 'PACKAGED', start: 4, duration: 6.979 },
      { id: CAPTION_CLIP, kind: 'VOICE', source: 'PACKAGED', start: 8.766, duration: 3.01 },
      { id: 'music', kind: 'MUSIC', source: 'PACKAGED', start: 0, duration: 46 },
      { id: 'detached:d1', kind: 'DETACHED', source: 'DETACHED', start: 2, duration: 5 },
    ]);
  });
});
