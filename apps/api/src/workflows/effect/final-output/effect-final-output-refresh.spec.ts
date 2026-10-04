import { describe, expect, it } from 'vitest';
import type { FinalOutputSnapshot, PackagingCheckpoint } from '@ai-marketing/contracts';
import {
  assertRefreshPreservesContent,
  validateRefreshCheckpoint,
  withoutChangedSlots,
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
  it('removes affected generated content and retains manual title/audio/geometry and bed', () => {
    const original = baseline();
    const result = withoutChangedSlots(original, ['a']);
    expect(result.script!.map((line) => line.id)).toEqual(['b']);
    expect(result.voices).toEqual({});
    expect(result.captions!.map((caption) => caption.id)).toEqual(['manual']);
    expect(result.captionBoxes).toEqual({ manual: original.captionBoxes!.manual });
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
        '音频不属于本任务或真实时长不一致',
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
});
