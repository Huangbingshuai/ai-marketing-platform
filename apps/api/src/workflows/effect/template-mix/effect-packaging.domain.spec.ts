import { describe, expect, it } from 'vitest';
import {
  PACKAGING_AUDIO_GAIN_CEILING,
  packagingShardIndexes,
  packagingVisualVariant,
  packagingVisualTimeline,
} from '@ai-marketing/contracts';
import { workflowStateHash } from '../../../platform/workflow/workflow-state-hash';
import type {
  EffectTemplateMixMaterial,
  EffectTemplateMixVariant,
  PackagingCheckpoint,
  WorkingArtifact,
} from '@ai-marketing/contracts';
import {
  canonicalizeCheckpoint,
  packagingSnapshot,
  validatePackagingCheckpoint,
  visualHash,
  matchesVisualHash,
  requireSlotPackaging,
  slotVisionKey,
} from './effect-packaging.domain';

const variant = (): EffectTemplateMixVariant => ({
  id: 'v',
  name: '成片',
  appliedTemplateVersion: 1,
  slots: [
    {
      id: 's',
      label: '产品',
      role: 'PRODUCT',
      purpose: 'PRODUCT_DISPLAY',
      duration: 10,
      transition: '硬切',
    },
  ],
  bindings: { s: 'clip' },
  bindingRevisions: { s: 1 },
  offsets: { s: 0 },
  manualSlotIds: [],
  conflictSlotIds: [],
  status: 'CURRENT',
  captions: [],
  subtitleStyle: 'standard',
  bgm: null,
  voice: null,
  originalVolume: 1,
});
const materials = [
  {
    id: 'clip',
    artifactId: 'clip',
    fileObjectId: 'video',
    duration: 15,
    available: true,
    artifactRevision: 1,
    contentHash: 'hash',
  },
] as EffectTemplateMixMaterial[];
const artifact = (id: string, key: string, payload: unknown, source?: string) =>
  ({
    id,
    artifactKey: key,
    payload,
    revision: 1,
    nodeId: 'SOURCE',
    freshness: 'CURRENT',
    availability: 'AVAILABLE',
    dependencies: source
      ? [{ sourceType: 'WORKING_ARTIFACT', sourceArtifactId: source, sourceRevision: 1 }]
      : [],
  }) as WorkingArtifact;
const sources = () => [
  artifact('clip', 'render-clip:c', { promptId: 'p' }, 'prompt'),
  artifact(
    'prompt',
    'prompt-batch:p',
    { items: [{ id: 'p', content: '镜头原始Prompt' }] },
    'facts',
  ),
  artifact('facts', 'marketing-insight:f', { productName: '商品', sellingPoints: ['已确认卖点'] }),
];
const snapshot = () => {
  const frozen = packagingSnapshot(variant(), materials, sources());
  delete frozen.narrationLayoutVersion; // Legacy playback/editor regression fixtures.
  return frozen;
};
const checkpoint = (): PackagingCheckpoint => ({
  vision: [{ start: 0, end: 10, description: '画面动作' }],
  script: [{ id: 'line-1', text: '商品', start: 0, end: 4, factIds: ['facts:0'] }],
  voices: { 'line-1': { fileObjectId: 'voice', start: 0, duration: 2.4, volume: 1 } },
  music: { fileObjectId: 'music', start: 0, duration: 10, volume: 0.12 },
  captions: [{ id: 'line-1', text: '商品', start: 0, end: 2.4 }],
});

describe('slot-bound narration layout', () => {
  it.each([0, 1, 2])('accepts durable retry count %s', (automaticRetries) => {
    expect(() => validatePackagingCheckpoint(snapshot(), { automaticRetries })).not.toThrow();
  });
  it.each([-1, 3, 0.5, NaN])('rejects invalid retry count %s', (automaticRetries) => {
    expect(() => validatePackagingCheckpoint(snapshot(), { automaticRetries })).toThrow();
  });
  const current = () => {
    const frozen = packagingSnapshot(variant(), materials, sources());
    const cp = checkpoint();
    cp.narrationLayoutVersion = 'SLOT_V1';
    cp.script![0]!.slotId = 's';
    cp.script![0]!.end = 10;
    return { frozen, cp };
  };
  it.each([3, 15])('accepts %s-second slots', (duration) => {
    const v = variant(); v.slots[0]!.duration = duration;
    expect(packagingSnapshot(v, materials, sources()).clips[0]!.duration).toBe(duration);
  });
  it.each([2.99, 15.01, NaN])('rejects %s-second slots before paid work', (duration) => {
    const v = variant(); v.slots[0]!.duration = duration;
    expect(() => packagingSnapshot(v, materials, sources())).toThrow('3–15');
  });
  it('rejects overlap across different visual lanes', () => {
    const v = variant();
    v.slots.push({ ...v.slots[0]!, id: 's2' });
    v.timelineStarts = { s: 0, s2: 9 }; v.videoLanes = { s2: 1 };
    expect(() => packagingSnapshot(v, materials, sources())).toThrow('槽位口播边界冲突');
  });
  it('requires exactly one valid line per slot at completion', () => {
    const { frozen, cp } = current();
    expect(() => requireSlotPackaging(frozen, cp)).not.toThrow();
    for (const lines of [[], [{ ...cp.script![0]!, slotId: 'unknown' }],
      [cp.script![0]!, { ...cp.script![0]!, id: 'duplicate' }]])
      expect(() => requireSlotPackaging(frozen, { ...cp, script: lines })).toThrow();
  });
  it('allows the empty intermediate checkpoint when redoing the only slot, but never ready', () => {
    const { frozen, cp } = current();
    cp.script = []; cp.voices = {}; cp.captions = [];
    expect(() => validatePackagingCheckpoint(frozen, cp)).not.toThrow();
    expect(() => requireSlotPackaging(frozen, cp)).toThrow();
  });
  it('does not let edited voice or subtitle borrow a following gap', () => {
    const { frozen, cp } = current();
    frozen.duration = 20;
    cp.voices!['line-1']!.start = 9;
    expect(() => validatePackagingCheckpoint(frozen, cp, true, true)).toThrow();
    cp.voices!['line-1']!.start = 0;
    cp.captions![0]!.end = 11;
    expect(() => validatePackagingCheckpoint(frozen, cp, true, true)).toThrow();
  });
  it('keeps legacy playback validation but refuses legacy output', () => {
    expect(() => validatePackagingCheckpoint(snapshot(), checkpoint(), true)).not.toThrow();
    expect(() => requireSlotPackaging(snapshot(), checkpoint())).toThrow('旧版');
  });
  it('cache identity ignores timeline placement but changes with trim and content', () => {
    const clip = current().frozen.clips[0]!;
    expect(slotVisionKey(clip)).toBe(slotVisionKey({ ...clip, start: 20, slotId: 'other' }));
    expect(slotVisionKey(clip)).not.toBe(slotVisionKey({ ...clip, offset: 1 }));
    expect(slotVisionKey(clip)).not.toBe(slotVisionKey({ ...clip, contentHash: 'changed' }));
  });
});

describe('packaging snapshots and validation', () => {
  it('freezes exact revisions and confirmed facts; does not use unrelated products', () => {
    const input = packagingSnapshot(variant(), materials, [
      ...sources(),
      artifact('other', 'marketing-insight:other', { productName: '其他SKU' }),
    ]);
    expect(input.facts.map((f) => f.text)).toEqual(['商品', '已确认卖点']);
    expect(input.clips[0]?.prompt).toBe('镜头原始Prompt');
    expect(input.dependencies).toHaveLength(3);
  });
  it('rejects outdated facts, missing originals and changed source revisions', () => {
    const rows = sources();
    rows[2]!.revision = 2;
    expect(() => packagingSnapshot(variant(), materials, rows)).toThrow('revision');
    expect(() => packagingSnapshot(variant(), materials, sources().slice(0, 2))).toThrow();
    expect(() =>
      packagingSnapshot(variant(), [{ ...materials[0]!, artifactRevision: 2 }], sources()),
    ).toThrow();
  });
  it('uses actual timeline starts, not the template sum', () => {
    const v = variant();
    v.timelineStarts = { s: 5 };
    const frozen = packagingSnapshot(v, materials, sources());
    expect(frozen.duration).toBe(15);
    expect(frozen.clips[0]?.start).toBe(5);
  });
  it('uses one second for a non-cut transition without an explicit duration', () => {
    const v = variant();
    v.slots[0]!.transition = '叠化';
    delete v.slots[0]!.transitionDuration;
    const frozen = packagingSnapshot(v, materials, sources());
    expect(frozen.clips[0]?.transitionDuration).toBe(1);
  });
  it('does not change the visual hash or confirmed payload for audio/subtitle edits', () => {
    const a = variant(),
      b = variant();
    b.captions = [{ id: 'c', text: '字幕', start: 0, end: 2 }];
    b.originalVolume = 0.1;
    expect(visualHash(a)).toBe(visualHash(b));
    expect(packagingVisualVariant(a)).toEqual(packagingVisualVariant(b));
    b.offsets.s = 1;
    expect(visualHash(a)).not.toBe(visualHash(b));
  });
  it('treats explicit default lanes as unchanged and reads legacy frozen hashes safely', () => {
    const implicit = variant();
    const explicit = { ...variant(), videoLanes: { s: 0 } };
    expect(visualHash(implicit)).toBe(visualHash(explicit));
    const legacy = workflowStateHash({ ...packagingVisualTimeline(explicit), videoLanes: { s: 0 } });
    expect(matchesVisualHash(implicit, legacy, explicit)).toBe(true);
    expect(matchesVisualHash(explicit, legacy, explicit)).toBe(true);
    expect(matchesVisualHash(implicit, 'forged', explicit)).toBe(false);
    expect(matchesVisualHash({ ...explicit, videoLanes: { s: 1 } }, legacy, explicit)).toBe(false);
    expect(matchesVisualHash({ ...explicit, offsets: { s: 1 } }, legacy, explicit)).toBe(false);
  });
  it.each([1, 10, 100])(
    'groups %i variants with stable identities and bounded capacity',
    (count) => {
      const inputs = Array.from({ length: count }, (_, index) => ({
        ...snapshot(),
        variant: { ...variant(), id: `${index}` },
      }));
      const shards = packagingShardIndexes(inputs);
      expect(shards).toHaveLength(count);
      expect(shards).toEqual(packagingShardIndexes(inputs));
      for (const shard of new Set(shards))
        expect(shards.filter((i) => i === shard).length).toBeLessThanOrEqual(4);
    },
  );
  it('keeps scheduling groups stable while model requests remain per-item', () => {
    const long = { ...snapshot(), duration: 200 };
    expect(packagingShardIndexes([long, long])).toEqual([0, 0]);
    const large = {
      ...snapshot(),
      facts: [{ ...snapshot().facts[0]!, text: '事实'.repeat(20_000) }],
    };
    expect(packagingShardIndexes([large, large])).toEqual([0, 0]);
  });
  it('accepts captions based on actual audio length', () =>
    expect(() => validatePackagingCheckpoint(snapshot(), checkpoint(), true)).not.toThrow());
  it('rejects missing components, fabricated facts, duplicate captions and clipped speech', () => {
    expect(() => validatePackagingCheckpoint(snapshot(), {}, true)).toThrow();
    const cp = checkpoint();
    cp.script![0]!.factIds = ['unconfirmed'];
    expect(() => validatePackagingCheckpoint(snapshot(), cp)).toThrow();
    const duplicate = checkpoint();
    duplicate.captions!.push(duplicate.captions![0]!);
    expect(() => validatePackagingCheckpoint(snapshot(), duplicate)).toThrow();
    const short = checkpoint();
    short.captions![0]!.end = 2;
    expect(() => validatePackagingCheckpoint(snapshot(), short)).toThrow();
  });
  it('accepts a boosted level up to the shared ceiling and nothing past it', () => {
    // One ceiling covers the narration and the music bed alike, matching the editor row's +20 dB.
    const loud = checkpoint();
    loud.music!.volume = PACKAGING_AUDIO_GAIN_CEILING;
    loud.voices!['line-1']!.volume = PACKAGING_AUDIO_GAIN_CEILING;
    expect(() => validatePackagingCheckpoint(snapshot(), loud, true, true)).not.toThrow();
    const over = checkpoint();
    over.music!.volume = PACKAGING_AUDIO_GAIN_CEILING + 0.01;
    expect(() => validatePackagingCheckpoint(snapshot(), over, true, true)).toThrow();
    const negative = checkpoint();
    negative.voices!['line-1']!.volume = -0.01;
    expect(() => validatePackagingCheckpoint(snapshot(), negative, true, true)).toThrow();
  });
  it('accepts editor-trimmed and moved audio while the worker path stays strict', () => {
    const edited: PackagingCheckpoint = {
      ...checkpoint(),
      script: [
        { id: 'line-1', text: '商品', start: 0, end: 4, factIds: ['facts:0'] },
        { id: 'line-2', text: '卖点', start: 5, end: 9, factIds: ['facts:5'] },
      ],
      voices: {
        'line-1': { fileObjectId: 'voice', start: 5.5, duration: 2.4, volume: 0.6, offset: 0.3 },
        'line-2': { fileObjectId: 'voice', start: 8, duration: 1, volume: 1, offset: 0 },
      },
      music: { fileObjectId: 'music', start: 2, duration: 6, volume: 0.2, offset: 1 },
      // Captions decouple from their voice: they only need to stay sorted and disjoint.
      captions: [
        { id: 'line-1', text: '商品', start: 5.5, end: 7.9 },
        { id: 'line-2', text: '卖点', start: 8, end: 9 },
      ],
    };
    expect(() => validatePackagingCheckpoint(snapshot(), edited, true, true)).not.toThrow();
    expect(() => validatePackagingCheckpoint(snapshot(), edited, true)).toThrow();
  });
  it('rejects edited audio or captions that leave the frozen timeline', () => {
    const overVoice = checkpoint();
    overVoice.voices!['line-1'] = { fileObjectId: 'voice', start: 8.5, duration: 2.4, volume: 1 };
    expect(() => validatePackagingCheckpoint(snapshot(), overVoice, true, true)).toThrow();
    const overMusic = checkpoint();
    overMusic.music = { fileObjectId: 'music', start: 5, duration: 6, volume: 0.2 };
    expect(() => validatePackagingCheckpoint(snapshot(), overMusic, true, true)).toThrow();
    const negative = checkpoint();
    negative.voices!['line-1'] = {
      fileObjectId: 'voice',
      start: 1,
      duration: 2.4,
      volume: 1,
      offset: -0.5,
    };
    expect(() => validatePackagingCheckpoint(snapshot(), negative, true, true)).toThrow();
  });
  it('accepts editor fades that fit inside the clip and keeps them through a redo', () => {
    const faded = checkpoint();
    faded.voices!['line-1'] = {
      fileObjectId: 'voice',
      start: 0,
      duration: 2.4,
      volume: 1,
      fadeIn: 0.4,
      fadeOut: 0.6,
    };
    faded.music = { fileObjectId: 'music', start: 0, duration: 10, volume: 0.12, fadeIn: 0.5, fadeOut: 0.5 };
    expect(() => validatePackagingCheckpoint(snapshot(), faded, true)).not.toThrow();
    expect(canonicalizeCheckpoint(snapshot(), faded).voices!['line-1']).toMatchObject({
      fadeIn: 0.4,
      fadeOut: 0.6,
    });
    expect(canonicalizeCheckpoint(snapshot(), faded).music).toMatchObject({ fadeIn: 0.5, fadeOut: 0.5 });
  });
  it('rejects fades that are negative, non-finite or longer than the clip', () => {
    // `fadeIn + fadeOut` is checked against the clip, so the 2.4s narration rejects a pair the
    // 10s music bed accepts. Every one of these is unbounded on both, though.
    for (const fade of [
      { fadeIn: -0.1 },
      { fadeOut: -0.1 },
      { fadeIn: Number.NaN },
      { fadeOut: Number.POSITIVE_INFINITY },
    ]) {
      const voice = checkpoint();
      voice.voices!['line-1'] = { fileObjectId: 'voice', start: 0, duration: 2.4, volume: 1, ...fade };
      expect(() => validatePackagingCheckpoint(snapshot(), voice)).toThrow();
      const music = checkpoint();
      music.music = { fileObjectId: 'music', start: 0, duration: 10, volume: 0.12, ...fade };
      expect(() => validatePackagingCheckpoint(snapshot(), music)).toThrow();
    }
    const overlong = checkpoint();
    overlong.voices!['line-1'] = {
      fileObjectId: 'voice',
      start: 0,
      duration: 2.4,
      volume: 1,
      fadeIn: 1.5,
      fadeOut: 1.5,
    };
    expect(() => validatePackagingCheckpoint(snapshot(), overlong)).toThrow();
  });
  it('rejects captions that overlap after independent movement', () => {
    const overlapping: PackagingCheckpoint = {
      ...checkpoint(),
      script: [
        { id: 'line-1', text: '商品', start: 0, end: 4, factIds: ['facts:0'] },
        { id: 'line-2', text: '卖点', start: 5, end: 9, factIds: ['facts:5'] },
      ],
      voices: {
        'line-1': { fileObjectId: 'voice', start: 5, duration: 3, volume: 1 },
        'line-2': { fileObjectId: 'voice', start: 8, duration: 1, volume: 1 },
      },
      captions: [
        { id: 'line-1', text: '商品', start: 5, end: 8 },
        { id: 'line-2', text: '卖点', start: 7.5, end: 9 },
      ],
    };
    expect(() => validatePackagingCheckpoint(snapshot(), overlapping, true, true)).toThrow();
  });
  it('restores pipeline-canonical geometry before a partial redo', () => {
    const edited = checkpoint();
    edited.voices!['line-1'] = {
      fileObjectId: 'voice',
      start: 5.5,
      duration: 2.4,
      volume: 0.6,
      offset: 0.3,
    };
    edited.music = { fileObjectId: 'music', start: 2, duration: 6, volume: 0.2, offset: 1 };
    edited.captions = [{ id: 'line-1', text: '商品', start: 5.5, end: 7.9 }];
    const canonical = canonicalizeCheckpoint(snapshot(), edited);
    expect(canonical.voices!['line-1']).toEqual({
      fileObjectId: 'voice',
      start: 0,
      duration: 2.4,
      volume: 0.6,
      offset: 0,
    });
    expect(canonical.music).toEqual({
      fileObjectId: 'music',
      start: 0,
      duration: 10,
      volume: 0.2,
      offset: 0,
    });
    expect(canonical.captions).toEqual([{ id: 'line-1', text: '商品', start: 0, end: 2.4 }]);
    expect(() => validatePackagingCheckpoint(snapshot(), canonical, true)).not.toThrow();
  });
  it('rejects malformed / unbounded checkpoint fields', () => {
    expect(() =>
      validatePackagingCheckpoint(snapshot(), {
        vision: [{ start: -1, end: 40, description: 'invalid' }],
      }),
    ).toThrow();
    expect(() =>
      validatePackagingCheckpoint(snapshot(), { musicTaskId: 'https://evil.test' }),
    ).toThrow();
    expect(() =>
      validatePackagingCheckpoint(snapshot(), { secret: 'leak' } as PackagingCheckpoint),
    ).toThrow();
  });
  it('lets the editor reword a subtitle without rewriting the narration it is voiced from', () => {
    const reworded = checkpoint();
    reworded.captions![0]!.text = '限时五折';
    expect(() => validatePackagingCheckpoint(snapshot(), reworded, true, true)).not.toThrow();
    // The worker still writes captions straight from the script line it voiced.
    expect(() => validatePackagingCheckpoint(snapshot(), reworded, true)).toThrow();
  });
  it('rejects blank or unbounded subtitle text on every path', () => {
    const blank = checkpoint();
    blank.captions![0]!.text = '   ';
    expect(() => validatePackagingCheckpoint(snapshot(), blank, true, true)).toThrow();
    const endless = checkpoint();
    endless.captions![0]!.text = '字'.repeat(501);
    expect(() => validatePackagingCheckpoint(snapshot(), endless, true, true)).toThrow();
  });
  it('accepts editor caption geometry on both paths and bounds it', () => {
    const placed = checkpoint();
    placed.captionBoxes = { 'line-1': { x: 0.25, y: 0.4, width: 0.6, scale: 1.5 } };
    expect(() => validatePackagingCheckpoint(snapshot(), placed, true, true)).not.toThrow();
    expect(() => validatePackagingCheckpoint(snapshot(), placed, true)).not.toThrow();
    for (const box of [
      { x: 1.5, y: 0.4, width: 0.6, scale: 1 },
      { x: 0.5, y: -0.1, width: 0.6, scale: 1 },
      { x: 0.5, y: 0.4, width: 0.05, scale: 1 },
      { x: 0.5, y: 0.4, width: 0.6, scale: 5 },
      { x: Number.NaN, y: 0.4, width: 0.6, scale: 1 },
    ]) {
      const bad = checkpoint();
      bad.captionBoxes = { 'line-1': box };
      expect(() => validatePackagingCheckpoint(snapshot(), bad, true, true)).toThrow();
    }
  });
  it('keeps caption geometry through a component redo and rejects forged keys', () => {
    // A redo drops `captions` while the worker regenerates them; the geometry must survive.
    const redo: PackagingCheckpoint = checkpoint();
    delete redo.captions;
    redo.captionBoxes = { 'line-1': { x: 0.25, y: 0.4, width: 0.6, scale: 1.5 } };
    expect(() => validatePackagingCheckpoint(snapshot(), redo)).not.toThrow();
    expect(canonicalizeCheckpoint(snapshot(), redo).captionBoxes).toEqual(redo.captionBoxes);
    // Ids follow the same shape rule as script line ids.
    for (const id of ['', 'a b', 'x'.repeat(51)]) {
      const forged = checkpoint();
      forged.captionBoxes = { [id]: { x: 0.5, y: 0.5, width: 0.5, scale: 1 } };
      expect(() => validatePackagingCheckpoint(snapshot(), forged)).toThrow();
    }
    const unknownKey = checkpoint();
    unknownKey.captionBoxes = {
      'line-1': { x: 0.5, y: 0.5, width: 0.5, scale: 1, extra: 1 } as never,
    };
    expect(() => validatePackagingCheckpoint(snapshot(), unknownKey)).toThrow();
  });
});
