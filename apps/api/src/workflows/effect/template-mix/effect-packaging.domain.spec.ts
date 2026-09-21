import { describe, expect, it } from 'vitest';
import { packagingShardIndexes, packagingVisualVariant } from '@ai-marketing/contracts';
import type {
  EffectTemplateMixMaterial,
  EffectTemplateMixVariant,
  PackagingCheckpoint,
  WorkingArtifact,
} from '@ai-marketing/contracts';
import {
  packagingSnapshot,
  validatePackagingCheckpoint,
  visualHash,
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
const snapshot = () => packagingSnapshot(variant(), materials, sources());
const checkpoint = (): PackagingCheckpoint => ({
  vision: [{ start: 0, end: 10, description: '画面动作' }],
  script: [{ id: 'line-1', text: '商品', start: 0, end: 4, factIds: ['facts:0'] }],
  voices: { 'line-1': { fileObjectId: 'voice', start: 0, duration: 2.4, volume: 1 } },
  music: { fileObjectId: 'music', start: 0, duration: 10, volume: 0.12 },
  captions: [{ id: 'line-1', text: '商品', start: 0, end: 2.4 }],
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
  it('splits by duration and token capacity, not just count', () => {
    const long = { ...snapshot(), duration: 200 };
    expect(packagingShardIndexes([long, long])).toEqual([0, 1]);
    const large = {
      ...snapshot(),
      facts: [{ ...snapshot().facts[0]!, text: '事实'.repeat(20_000) }],
    };
    expect(packagingShardIndexes([large, large])).toEqual([0, 1]);
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
    const loud = checkpoint();
    loud.music!.volume = 1;
    expect(() => validatePackagingCheckpoint(snapshot(), loud)).toThrow();
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
});
