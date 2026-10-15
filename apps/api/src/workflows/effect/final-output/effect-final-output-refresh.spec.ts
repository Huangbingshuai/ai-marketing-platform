import { describe, expect, it } from 'vitest';
import type { FinalOutputSnapshot, PackagingCheckpoint } from '@ai-marketing/contracts';
import {
  assertRefreshPreservesContent,
  validateRefreshCheckpoint,
  withoutChangedSlots,
  withoutRemovedSlots,
  clearRemovedSourceSlots,
} from './effect-final-output-refresh';

const baseline = (): PackagingCheckpoint => ({
  narrationLayoutVersion: 'SLOT_V1',
  captionLayoutVersion: 'SEGMENT_V3',
  script: [
    { id: 'a', slotId: 'a', text: '原口播', start: 0, end: 4, factIds: ['f'] },
    { id: 'b', slotId: 'b', text: '保留口播', start: 4, end: 8, factIds: ['f'] },
  ],
  // The user already deleted the unrelated voice and its generated caption.
  voices: { a: { fileObjectId: 'old-voice', start: 0, duration: 2, volume: 1 } },
  captions: [
    {
      id: 'a-caption',
      voiceLineId: 'a',
      text: '原口播',
      start: 0,
      end: 2,
      segmentIndex: 0,
      segmentCount: 1,
    },
    { id: 'manual', manual: true, text: '手工标题', start: 0, end: 3 },
  ],
  captionFontSize: 20,
  captionBoxes: {
    'a-caption': { x: 0.5, y: 0.1, width: 0.9, scale: 1 },
    manual: { x: 0.2, y: 0.5, width: 0.4, scale: 2 },
  },
  captionVoices: { manual: { fileObjectId: 'manual-voice', start: 0, duration: 2, volume: 0.4 } },
  music: { fileObjectId: 'music', start: 0, duration: 10, volume: 0.2, fadeIn: 1 },
});
const snapshot = (cp: PackagingCheckpoint): FinalOutputSnapshot =>
  ({
    sourceRefresh: {
      baselinePackaging: cp,
      slots: [{ slotId: 'a' }],
      uploadedAudios: {
        'voice-new': {
          fileObjectId: 'new-voice',
          duration: 1,
          sha256: 'hash',
          segmentFrames: [24_000],
        },
      },
    },
    timeline: {
      narrationLayoutVersion: 'SLOT_V1',
      duration: 10,
      facts: [{ id: 'f', text: '确认事实' }],
      variant: {
        slots: [
          { id: 'a', duration: 4 },
          { id: 'b', duration: 4 },
        ],
      },
      clips: [
        { slotId: 'a', start: 0, duration: 4 },
        { slotId: 'b', start: 6, duration: 4 },
      ],
    },
  }) as unknown as FinalOutputSnapshot;
function refreshed(cp: PackagingCheckpoint): PackagingCheckpoint {
  const result = withoutChangedSlots(cp, ['a']);
  result.vision = [{ slotId: 'a', start: 0, end: 4, description: '新镜头' }];
  result.script!.unshift({
    id: 'new',
    slotId: 'a',
    text: '新口播',
    start: 0,
    end: 4,
    factIds: ['f'],
  });
  result.voices!.new = {
    fileObjectId: 'new-voice',
    start: 0,
    duration: 1,
    volume: 1,
    segmentFrames: [24_000],
  };
  result.captions!.push({
    id: 'new-caption',
    voiceLineId: 'new',
    text: '新口播',
    start: 0,
    end: 1,
    segmentIndex: 0,
    segmentCount: 1,
  });
  return result;
}
describe('same-branch source-refresh content boundaries', () => {
  it('removes edited but lineage-linked captions, not independent titles or music', () => {
    const cp = baseline();
    cp.captions![0]!.manual = true;
    cp.captions![0]!.start = 7;
    const result = withoutRemovedSlots(cp, ['a']);
    expect(result.script!.map((line) => line.id)).toEqual(['b']);
    expect(result.captions!.map((caption) => caption.id)).toEqual(['manual']);
    expect(result.captionBoxes).toEqual({ manual: cp.captionBoxes!.manual });
    expect(result.captionVoices).toEqual(cp.captionVoices);
    expect(result.music).toEqual(cp.music);
    const input = snapshot(cp);
    input.sourceRefresh!.slots = [];
    input.sourceRefresh!.removedSlotIds = ['a'];
    expect(() => assertRefreshPreservesContent(input, result)).not.toThrow();
    expect(() => assertRefreshPreservesContent(input, cp)).toThrow('不能重新写回');
  });
  it('retains holes and extent when deleting the last and every occurrence, including detached original audio', () => {
    const v = { id: 'v', slots: [{ id: 'a', duration: 4 }, { id: 'b', duration: 4 }],
      bindings: { a: 'file', b: 'file' }, bindingRevisions: { a: 1, b: 1 }, offsets: { a: 2, b: 3 },
      bindingMetadata: { a: { matchScore: .9 } }, timelineStarts: { a: 1, b: 9 }, videoLanes: { b: 2 },
      manualSlotIds: ['a'], conflictSlotIds: ['a'], captions: [],
      detachedAudios: [{ id: 'original', sourceSlotId: 'b', start: 9, duration: 4 }],
      audioLanes: { 'detached:original': 4, 'voice:a': 3, music: 2 },
    } as unknown as import('@ai-marketing/contracts').EffectTemplateMixVariant;
    const cleared = clearRemovedSourceSlots(v, baseline(), ['a', 'b']);
    expect(cleared.bindings).toEqual({});
    expect(cleared.offsets).toEqual({});
    expect(cleared.bindingMetadata).toEqual({});
    expect(cleared.intentionallyEmptySlotIds).toEqual(['a', 'b']);
    expect(cleared.preservedTimelineEnd).toBe(13);
    expect(cleared.timelineStarts).toEqual(v.timelineStarts);
    expect(cleared.slots).toEqual(v.slots);
    expect(cleared.detachedAudios).toEqual([]);
    expect(cleared.audioLanes).toEqual({ music: 2 });
    expect(v.bindings.a).toBe('file');
  });
  it('starts a new source refresh with a fresh retry budget without mutating old packaging', () => {
    const cp = { ...baseline(), automaticRetries: 2,
      recovery: { startedAt: '2026-10-11T01:00:00Z', attempts: { VOICE: 2 } },
      voiceRecovery: { previous: { startedAt: '2026-10-11T01:00:00Z', pending: true, attempts: 1 } } };
    const refreshed = withoutChangedSlots(cp, ['a']);
    expect(refreshed.automaticRetries).toBeUndefined();
    expect(refreshed.recovery).toBeUndefined();
    expect(refreshed.voiceRecovery).toBeUndefined();
    expect(refreshed.voices).toEqual({});
    expect(refreshed.music).toEqual(cp.music);
    expect(cp.voiceRecovery.previous.pending).toBe(true);
    expect(cp.recovery.attempts.VOICE).toBe(2);
    expect(cp.automaticRetries).toBe(2);
  });
  it('clears edited split-caption lineage and uniquely linked historical split voices, never independent audio', () => {
    const cp = baseline();
    cp.captions!.push({ id: 'split-caption', sourceSlotId: 'a', manual: true, text: '剪开并修改', start: 7, end: 8 });
    const v = { ...snapshot(cp).timeline.variant, bindings: { a: 'picture' }, bindingRevisions: { a: 1 },
      offsets: { a: 0 }, captions: [], manualSlotIds: [], conflictSlotIds: [],
      detachedAudios: [
        { id: 'split-voice', audioKind: 'VOICE', fileObjectId: 'old-voice', start: 8, duration: 1 },
        { id: 'independent', fileObjectId: 'old-voice', start: 9, duration: 1 },
      ], audioLanes: { 'detached:split-voice': 2, 'detached:independent': 3 },
    } as unknown as import('@ai-marketing/contracts').EffectTemplateMixVariant;
    expect(withoutRemovedSlots(cp, ['a']).captions!.map((caption) => caption.id)).toEqual(['manual']);
    const result = clearRemovedSourceSlots(v, cp, ['a']);
    expect(result.detachedAudios!.map((audio) => audio.id)).toEqual(['independent']);
    expect(result.audioLanes).toEqual({ 'detached:independent': 3 });
  });
  it('removes affected generated content and retains manual title/audio/geometry and bed', () => {
    const original = baseline();
    const result = withoutChangedSlots(original, ['a']);
    expect(result.script!.map((line) => line.id)).toEqual(['b']);
    expect(result.voices).toEqual({});
    expect(result.captions!.map((caption) => caption.id)).toEqual(['manual']);
    expect(result.captionBoxes).toEqual({ manual: original.captionBoxes!.manual });
    expect(result.captionFontSize).toBe(20);
    expect(result.captionVoices).toEqual(original.captionVoices);
    expect(result.music).toEqual(original.music);
    expect(original.voices!.a).toBeDefined();
  });
  it('validates only regenerated slots and does not recreate deleted or independently moved siblings', () => {
    const original = baseline();
    validateRefreshCheckpoint(snapshot(original), refreshed(original), true);
  });
  it('tolerates ordering without permitting unrelated content or audio changes', () => {
    const original = baseline();
    const cp = refreshed(original);
    cp.captions!.reverse();
    expect(() => assertRefreshPreservesContent(snapshot(original), cp)).not.toThrow();
    cp.music!.volume = 0.9;
    expect(() => assertRefreshPreservesContent(snapshot(original), cp)).toThrow('未受影响');
    const fontSizeChanged = refreshed(original);
    fontSizeChanged.captionFontSize = 24;
    expect(() => assertRefreshPreservesContent(snapshot(original), fontSizeChanged)).toThrow(
      '未受影响',
    );
  });
  it('rejects forged voice files, real-duration mismatch and bad caption timing', () => {
    const original = baseline();
    for (const patch of [
      { fileObjectId: 'other-project' },
      { duration: 2 },
      { segmentFrames: [12_000] },
    ]) {
      const cp = refreshed(original);
      Object.assign(cp.voices!.new!, patch);
      expect(() => validateRefreshCheckpoint(snapshot(original), cp, true)).toThrow(
        '音频不属于本任务或文件时长不一致',
      );
    }
    const cp = refreshed(original);
    cp.captions!.find((caption) => caption.id === 'new-caption')!.end = 3;
    expect(() => validateRefreshCheckpoint(snapshot(original), cp, true)).toThrow();
  });
  it('rejects missing affected voice/captions at READY while keeping partial recovery checkpoints legal', () => {
    const original = baseline();
    const partial = withoutChangedSlots(original, ['a']);
    validateRefreshCheckpoint(snapshot(original), partial, false);
    expect(() => validateRefreshCheckpoint(snapshot(original), partial, true)).toThrow();
  });
  it('keeps actual speech ranges identical to the atomically uploaded audio metadata', () => {
    const original = baseline();
    const input = snapshot(original);
    const ranges = [{ startFrame: 4800, endFrame: 21600 }];
    input.sourceRefresh!.uploadedAudios!['voice-new']!.speechRanges = ranges;
    const cp = refreshed(original);
    cp.voices!.new!.speechRanges = structuredClone(ranges);
    const caption = cp.captions!.find((row) => row.id === 'new-caption')!;
    caption.start = .2;
    caption.end = .9;
    expect(() => validateRefreshCheckpoint(input, cp, true)).not.toThrow();
    cp.voices!.new!.speechRanges![0]!.startFrame = 2400;
    expect(() => assertRefreshPreservesContent(input, cp)).toThrow(
      '音频不属于本任务或文件时长不一致',
    );
  });
});
