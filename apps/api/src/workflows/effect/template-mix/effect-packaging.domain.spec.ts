import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  PACKAGING_AUDIO_GAIN_CEILING,
  packagingOverlayTimeline,
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
  artifactVisitor,
  canonicalizeCheckpoint,
  packagingClips,
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
    code: 'R-06',
    name: '腊肠煎制',
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
const adoptedSources = () => {
  const rows = sources();
  rows[0]!.nodeId = 'SEGMENT_RENDER';
  rows[0]!.payload = {
    origin: 'AI_GENERATED',
    promptId: 'p',
    promptText: ' 生成画面时采用的原始 Prompt ',
    adoptedPrompt: {
      promptContentHash: createHash('sha256').update('生成画面时采用的原始 Prompt').digest('hex'),
    },
  };
  rows[1]!.nodeId = 'PROMPT_GENERATION';
  return rows;
};
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
  it('orders sparse append clips by saved time, keeps identities and full music capacity', () => {
    const v = variant();
    const base = v.slots[0]!;
    v.slots = [
      { ...base, id: 'last', duration: 4, role: 'END' },
      { ...base, id: 'hole', duration: 6, role: 'PAIN_POINT' },
      { ...base, id: 'first', duration: 4, role: 'HOOK' },
    ];
    v.bindings = { first: 'clip', last: 'clip2' };
    v.bindingRevisions = { first: 1, last: 1 };
    v.offsets = { first: 0, last: 0 };
    v.timelineStarts = { first: 4, hole: 8, last: 14 };
    v.intentionallyEmptySlotIds = ['hole'];
    v.preservedTimelineEnd = 22;
    const rows = [
      ...materials,
      { ...materials[0]!, id: 'clip2', artifactId: 'clip2', fileObjectId: 'video2' },
    ];
    const frozen = packagingSnapshot(v, rows, [
      ...sources(),
      artifact('clip2', 'render-clip:c2', { promptId: 'p' }, 'prompt'),
    ]);
    expect(frozen.clips.map((clip) => [clip.slotId, clip.start, clip.duration])).toEqual([
      ['first', 4, 4],
      ['last', 14, 4],
    ]);
    expect(frozen.duration).toBe(22);
    expect(frozen.variant.intentionallyEmptySlotIds).toEqual(['hole']);
  });
  it('uses the clip-owned Prompt across repeated batch edits and retains only confirmed fact dependencies', () => {
    const rows = adoptedSources();
    const untouched = structuredClone(rows);
    for (const revision of [2, 3]) {
      rows[1]!.revision = revision;
      rows[1]!.payload = { items: [{ id: 'p', content: `后来编辑的正文 ${revision}` }] };
      const before = structuredClone(rows);
      const frozen = packagingSnapshot(variant(), materials, rows);
      expect(frozen.clips[0]!.prompt).toBe('生成画面时采用的原始 Prompt');
      expect(frozen.facts.map((f) => f.artifactId)).toEqual(['facts', 'facts']);
      expect(frozen.dependencies.map((d) => [d.artifactId, d.revision])).toEqual([
        ['clip', 1],
        ['facts', 1],
      ]);
      expect(rows).toEqual(before);
    }
    expect(rows[0]).toEqual(untouched[0]);
  });

  it('accepts the published consumer projection without changing the render node freshness', () => {
    const rows = adoptedSources();
    rows[0]!.freshness = 'STALE';
    rows[0]!.metadata = { promptSourcePending: true };
    rows[1]!.revision = 11;
    expect(packagingSnapshot(variant(), materials, rows).clips[0]!.prompt).toBe(
      '生成画面时采用的原始 Prompt',
    );
    expect(rows[0]!.freshness).toBe('STALE');
  });

  it('packages an adopted render Prompt through a stale historical batch without adopting that batch', () => {
    const rows = adoptedSources();
    rows[1]!.freshness = 'STALE';
    rows[1]!.revision = 13;
    const before = structuredClone(rows);
    const frozen = packagingSnapshot(variant(), materials, rows);
    expect(frozen.clips[0]!.prompt).toBe('生成画面时采用的原始 Prompt');
    expect(frozen.dependencies.map(({ artifactId }) => artifactId)).toEqual(['clip', 'facts']);
    expect(frozen.facts.every(({ artifactId }) => artifactId === 'facts')).toBe(true);
    expect(rows).toEqual(before);
  });

  it.each(['MISSING_PROMPT', 'UNAVAILABLE_PROMPT', 'NO_ADOPTION', 'BAD_HASH'] as const)(
    'does not relax provenance without an available explicit source and a verified adoption (%s)',
    (condition) => {
      const rows = adoptedSources();
      rows[1]!.freshness = 'STALE';
      if (condition === 'MISSING_PROMPT') rows.splice(1, 1);
      if (condition === 'UNAVAILABLE_PROMPT') rows[1]!.availability = 'SOURCE_REMOVED';
      if (condition === 'NO_ADOPTION') rows[0]!.payload = { promptId: 'p' };
      if (condition === 'BAD_HASH')
        rows[0]!.payload = {
          promptId: 'p',
          promptText: '未确认正文',
          adoptedPrompt: { promptContentHash: 'invalid' },
        };
      expect(() => packagingSnapshot(variant(), materials, rows)).toThrow(/包装来源/);
    },
  );

  it.each(['STALE', 'MISSING', 'REVISION', 'SOURCE_REMOVED'] as const)(
    'does not bypass confirmed product fact validation when a clip owns its Prompt (%s)',
    (condition) => {
      const rows = adoptedSources();
      rows[1]!.revision = 2;
      rows[1]!.freshness = 'STALE';
      if (condition === 'STALE') rows[2]!.freshness = 'STALE';
      if (condition === 'MISSING') rows.pop();
      if (condition === 'REVISION') rows[2]!.revision = 2;
      if (condition === 'SOURCE_REMOVED') rows[2]!.availability = 'SOURCE_REMOVED';
      expect(() => packagingSnapshot(variant(), materials, rows)).toThrow(/包装来源/);
    },
  );

  it.each(['STALE', 'MISSING', 'REVISION', 'SOURCE_REMOVED'] as const)(
    'still validates the source-package dependency behind adopted product facts (%s)',
    (condition) => {
      const rows = adoptedSources();
      rows[1]!.freshness = 'STALE';
      rows[2]!.dependencies = [
        {
          sourceType: 'WORKING_ARTIFACT',
          sourceArtifactId: 'import',
          sourceNodeId: 'SOURCE_IMPORT',
          sourceKey: 'source-package:p',
          sourceRevision: 1,
          sourceHash: null,
        },
      ];
      if (condition !== 'MISSING') {
        const source = artifact('import', 'source-package:p', {});
        if (condition === 'STALE') source.freshness = 'STALE';
        if (condition === 'REVISION') source.revision = 2;
        if (condition === 'SOURCE_REMOVED') source.availability = 'SOURCE_REMOVED';
        rows.push(source);
      }
      expect(() => packagingSnapshot(variant(), materials, rows)).toThrow(/包装来源/);
    },
  );

  it('does not use unrelated confirmed facts when the explicit Prompt source has none', () => {
    const rows = adoptedSources();
    rows[1]!.dependencies = [];
    expect(() => packagingSnapshot(variant(), materials, rows)).toThrow(
      '缺少素材所消费的已确认商品信息',
    );
  });

  it('keeps sibling source graphs separate even when they share a Prompt item id', () => {
    const rows = adoptedSources();
    const sibling = artifact(
      'sibling',
      'prompt-batch:sibling',
      { items: [{ id: 'p', content: '兄弟分支正文' }] },
      'other-facts',
    );
    const otherFacts = artifact('other-facts', 'marketing-insight:other', {
      productName: '其他商品',
    });
    const frozen = packagingSnapshot(variant(), materials, [sibling, otherFacts, ...rows]);
    expect(frozen.clips[0]!.prompt).toBe('生成画面时采用的原始 Prompt');
    expect(frozen.dependencies.map((d) => d.artifactId)).toEqual(['clip', 'facts']);
    expect(frozen.facts.some((f) => f.artifactId === 'other-facts')).toBe(false);
  });

  it.each([{}, { promptContentHash: 'wrong-hash' }])(
    'rejects unverified clip-owned AI text without a confirmed legacy Prompt (%o)',
    (adoptedPrompt) => {
      const rows = adoptedSources();
      rows[0]!.payload = { origin: 'AI_GENERATED', promptText: '未确认的文字', adoptedPrompt };
      rows[0]!.dependencies = [
        {
          sourceType: 'WORKING_ARTIFACT',
          sourceArtifactId: 'facts',
          sourceNodeId: 'INFORMATION_EXTRACTION',
          sourceKey: 'marketing-insight:f',
          sourceRevision: 1,
          sourceHash: null,
        },
      ];
      expect(() => packagingSnapshot(variant(), materials, [rows[0]!, rows[2]!])).toThrow(
        '缺少素材对应的已确认原始 Prompt',
      );
    },
  );

  it('preserves packaging source hashes while freezing transforms for final rendering', () => {
    const v = variant(),
      original = visualHash(v);
    v.canvasRatio = '4:3';
    v.videoTransforms = {
      s: { x: 0.2, y: -0.1, scaleX: 0.5, scaleY: 0.7, rotation: 90, uniform: false },
    };
    expect(visualHash(v)).toBe(original);
    const clip = packagingClips(v, materials, artifactVisitor(sources()))[0]!;
    expect(clip.transform).toEqual(v.videoTransforms.s);
  });
  it('freezes the confirmed reverse-description owned by an imported render clip', () => {
    const imported = artifact(
      'clip',
      'render-clip:c',
      {
        origin: 'EXTERNAL_IMPORT',
        promptId: 'not-a-generated-prompt',
        promptText: ' 导入视频已确认描述 ',
        importedMaterial: { schemaVersion: 1 },
      },
      'facts',
    );
    imported.nodeId = 'SEGMENT_RENDER';
    const frozen = packagingSnapshot(variant(), materials, [imported, sources()[2]!]);
    expect(frozen.clips[0]!.prompt).toBe('导入视频已确认描述');
    expect(frozen.dependencies.map((d) => d.artifactId)).toContain('clip');
  });

  it.each([
    {
      origin: 'AI_GENERATED',
      promptText: '不可作草稿兜底',
      importedMaterial: { schemaVersion: 1 },
    },
    { origin: 'EXTERNAL_IMPORT', promptText: '未验证结构', importedMaterial: { schemaVersion: 2 } },
    { origin: 'EXTERNAL_IMPORT', promptText: ' ', importedMaterial: { schemaVersion: 1 } },
  ])('still rejects unconfirmed imported description provenance (%o)', (payload) => {
    const imported = artifact('clip', 'render-clip:c', payload, 'facts');
    imported.nodeId = 'SEGMENT_RENDER';
    expect(() => packagingSnapshot(variant(), materials, [imported, sources()[2]!])).toThrow(
      '缺少素材对应的已确认原始 Prompt',
    );
  });

  it('freezes imported music assets as independent audio-track sources', () => {
    const v = variant();
    v.detachedAudios = [
      {
        id: 'music-1',
        sourceAssetId: 'asset-1',
        fileObjectId: 'file-1',
        name: '背景音乐',
        sourceDuration: 32,
        start: 2,
        offset: 4,
        duration: 6,
        volume: 0.7,
      },
    ];
    const frozen = packagingSnapshot(
      v,
      materials,
      sources(),
      new Map([['asset-1', { fileObjectId: 'file-1', sourceDuration: 32 }]]),
    );

    expect(frozen.detachedAudios).toEqual(v.detachedAudios);
    expect(() => packagingSnapshot(v, materials, sources())).toThrow('分离音频');
  });

  it('accepts a six-slot confirmed package with segmented captions and detached source audio', () => {
    const v = variant();
    v.slots = Array.from({ length: 6 }, (_, index) => ({
      ...v.slots[0]!,
      id: `s${index}`,
      duration: 4,
      transition: index === 0 ? ('硬切' as const) : ('叠化' as const),
      transitionDuration: index === 0 ? 0 : 1,
    }));
    v.bindings = Object.fromEntries(v.slots.map((slot, index) => [slot.id, `m${index}`]));
    v.bindingRevisions = Object.fromEntries(v.slots.map((slot) => [slot.id, 1]));
    v.offsets = Object.fromEntries(v.slots.map((slot) => [slot.id, 0.25]));
    v.detachedAudios = [
      {
        id: 'detached',
        sourceSlotId: 's2',
        fileObjectId: 'video2',
        name: '动作声',
        start: 8,
        offset: 0.25,
        duration: 4,
        volume: 0.4,
      },
    ];
    const clips = Array.from({ length: 6 }, (_, index) => ({
      ...materials[0]!,
      id: `m${index}`,
      artifactId: `clip${index}`,
      fileObjectId: `video${index}`,
    }));
    const artifacts = [
      ...Array.from({ length: 6 }, (_, index) =>
        artifact(`clip${index}`, `render-clip:${index}`, { promptId: 'p' }, 'prompt'),
      ),
      ...sources().slice(1),
    ];
    const frozen = packagingSnapshot(v, clips, artifacts);
    const cp: PackagingCheckpoint = {
      narrationLayoutVersion: 'SLOT_V1',
      captionLayoutVersion: 'SEGMENT_V3',
      vision: v.slots.map((_, index) => ({
        start: index * 4,
        end: index * 4 + 4,
        description: '产品动作',
      })),
      script: v.slots.map((slot, index) => ({
        id: `line${index}`,
        slotId: slot.id,
        text: '商品，真好',
        start: index * 4,
        end: index * 4 + 4,
        factIds: ['facts:0'],
      })),
      voices: Object.fromEntries(
        v.slots.map((_, index) => [
          `line${index}`,
          {
            fileObjectId: `voice${index}`,
            start: index * 4,
            duration: 1,
            segmentFrames: [12000, 12000],
            volume: 1,
          },
        ]),
      ),
      captions: v.slots.flatMap((_, index) => [
        {
          id: `c${index}a`,
          voiceLineId: `line${index}`,
          segmentIndex: 0,
          segmentCount: 2,
          text: '商品',
          start: index * 4,
          end: index * 4 + 0.5,
        },
        {
          id: `c${index}b`,
          voiceLineId: `line${index}`,
          segmentIndex: 1,
          segmentCount: 2,
          text: '真好',
          start: index * 4 + 0.5,
          end: index * 4 + 1,
        },
      ]),
      music: { fileObjectId: 'music', start: 0, duration: 24, volume: 0.12 },
    };
    expect(frozen.duration).toBe(24);
    expect(frozen.clips).toHaveLength(6);
    expect(() => requireSlotPackaging(frozen, cp)).not.toThrow();
  });
  it.each([0, 1, 2])('accepts durable retry count %s', (automaticRetries) => {
    expect(() => validatePackagingCheckpoint(snapshot(), { automaticRetries })).not.toThrow();
  });
  it.each([-1, 3, 0.5, NaN])('rejects invalid retry count %s', (automaticRetries) => {
    expect(() => validatePackagingCheckpoint(snapshot(), { automaticRetries })).toThrow();
  });
  it('accepts the worker recovery checkpoints before its first paid request and during waits', () => {
    const frozen = { ...snapshot(), operation: 'BATCH_PACKAGE' as const };
    const startedAt = '2026-10-11T06:00:00+00:00';
    expect(() =>
      validatePackagingCheckpoint(frozen, {
        recovery: { startedAt, attempts: {} },
      }),
    ).not.toThrow();
    expect(() =>
      validatePackagingCheckpoint(frozen, {
        automaticRetries: 5,
        recovery: {
          startedAt,
          attempts: { VOICE: 5, MUSIC: 2 },
          stage: 'VOICE',
          waitingUntil: '2026-10-11T06:00:30+00:00',
        },
        voiceRecovery: {
          ['a'.repeat(64)]: {
            startedAt,
            attempts: 8,
            pending: false,
            waitingUntil: '2026-10-11T06:00:30Z',
          },
        },
      }),
    ).not.toThrow();
  });
  it.each([
    { recovery: { startedAt: 'invalid', attempts: {} } },
    { recovery: { startedAt: '2026-10-11T06:00:00Z', attempts: { UNKNOWN: 1 } } },
    { recovery: { startedAt: '2026-10-11T06:00:00Z', attempts: { VOICE: 6 } } },
    { recovery: { startedAt: '2026-10-11T06:00:00Z', attempts: {}, injected: true } },
    { voiceRecovery: { invalid: { startedAt: '2026-10-11T06:00:00Z', attempts: 1 } } },
    { voiceRecovery: { ['a'.repeat(64)]: { startedAt: '2026-10-11T06:00:00Z', attempts: 21 } } },
    {
      voiceRecovery: {
        ['a'.repeat(64)]: { startedAt: '2026-10-11T06:00:00Z', attempts: 1, pending: 'yes' },
      },
    },
  ])('rejects malformed durable recovery state %j', (cp) => {
    expect(() => validatePackagingCheckpoint(snapshot(), cp as PackagingCheckpoint)).toThrow();
  });
  it('accepts one automatic voice recovery only for a frozen slot', () => {
    const { frozen, cp } = current();
    cp.voiceSlotRetries = { s: 1 };
    expect(() => validatePackagingCheckpoint(frozen, cp)).not.toThrow();
    cp.voiceSlotRetries = { missing: 1 };
    expect(() => validatePackagingCheckpoint(frozen, cp)).toThrow();
    cp.voiceSlotRetries = { s: 2 as 1 };
    expect(() => validatePackagingCheckpoint(frozen, cp)).toThrow();
  });
  const current = () => {
    const frozen = packagingSnapshot(variant(), materials, sources());
    const cp = checkpoint();
    cp.narrationLayoutVersion = 'SLOT_V1';
    cp.script![0]!.slotId = 's';
    cp.script![0]!.end = 10;
    return { frozen, cp };
  };
  const segmented = () => {
    const { frozen, cp } = current();
    cp.captionLayoutVersion = 'SEGMENT_V1';
    cp.script![0]!.text = '第一句，第二句。';
    cp.captions = [
      {
        id: 'caption-a',
        voiceLineId: 'line-1',
        segmentIndex: 0,
        segmentCount: 2,
        text: '第一句',
        start: 0,
        end: 1.2,
      },
      {
        id: 'caption-b',
        voiceLineId: 'line-1',
        segmentIndex: 1,
        segmentCount: 2,
        text: '第二句',
        start: 1.2,
        end: 2.4,
      },
    ];
    return { frozen, cp };
  };
  it('lets the editor drag one subtitle card away from its neighbours', () => {
    const { frozen, cp } = segmentedV2();
    expect(() => requireSlotPackaging(frozen, cp)).not.toThrow();
    // Pulling the second card to the right opens a gap, which is a normal edit — the pipeline's
    // "segments of one line stay glued" rule belongs to the worker write path, not to the editor.
    cp.captions![1]!.start = 3.4;
    cp.captions![1]!.end = 4.6;
    expect(() => requireSlotPackaging(frozen, cp)).not.toThrow();
    // The worker path still refuses it.
    expect(() => validatePackagingCheckpoint(frozen, cp, true)).toThrow();
  });
  it('lets the editor carry a slot-bound line and its subtitle past the slot, but never the worker', () => {
    const { frozen, cp } = segmented();
    cp.voices!['line-1']!.start = 12;
    cp.captions!.forEach((caption, index) => {
      caption.start = 12 + index * 1.2;
      caption.end = 12 + (index + 1) * 1.2;
    });
    // The frozen snapshot is still video-only: only the render length follows the content.
    expect(frozen.duration).toBe(10);
    expect(() => requireSlotPackaging(frozen, cp)).not.toThrow();
    expect(() => validatePackagingCheckpoint(frozen, cp, true)).toThrow();
    // A subtitle is a placed clip too, so it is free of the voice it was voiced from.
    cp.captions![1]!.start = 15;
    cp.captions![1]!.end = 16.2;
    expect(() => requireSlotPackaging(frozen, cp)).not.toThrow();
    // Capacity is the only bound left.
    cp.voices!['line-1']!.start = 3600;
    expect(() => requireSlotPackaging(frozen, cp)).toThrow();
  });
  const segmentedV2 = () => {
    const { frozen, cp } = segmented();
    cp.captionLayoutVersion = 'SEGMENT_V2';
    cp.script![0]!.text = '腊肠、米饭，趁热吃！';
    cp.captions![0]!.text = '腊肠、米饭';
    cp.captions![1]!.text = '趁热吃';
    return { frozen, cp };
  };
  it('accepts several punctuation-free subtitles for one saved voice', () => {
    const { frozen, cp } = segmented();
    expect(() => requireSlotPackaging(frozen, cp)).not.toThrow();
    expect(canonicalizeCheckpoint(frozen, cp).captions).toEqual(cp.captions);
  });
  it('rejects punctuation, missing text, wrong parent and overlap', () => {
    for (const [index, change] of [
      (cp: PackagingCheckpoint) => {
        cp.captions![0]!.text = '第一句，';
      },
      (cp: PackagingCheckpoint) => {
        cp.captions!.pop();
      },
      (cp: PackagingCheckpoint) => {
        cp.captions![1]!.voiceLineId = 'unknown';
      },
      (cp: PackagingCheckpoint) => {
        cp.captions![1]!.start = 1;
      },
    ].entries()) {
      const { frozen, cp } = segmented();
      change(cp);
      expect(() => requireSlotPackaging(frozen, cp), `invalid segment case ${index}`).toThrow();
    }
  });
  it('allows a partial segmented checkpoint until missing slot subtitles are generated', () => {
    const { frozen, cp } = segmented();
    cp.captions = [];
    expect(() => validatePackagingCheckpoint(frozen, cp)).not.toThrow();
    expect(() => requireSlotPackaging(frozen, cp)).toThrow();
  });
  it('keeps segmented subtitles when their narration is deleted', () => {
    const { frozen, cp } = segmentedV2();
    // The editor deleted this line's narration. Its cards stay where they are — they are the
    // subtitles the viewer still reads — and the frame check has nothing left to check.
    delete cp.voices!['line-1'];
    expect(() => requireSlotPackaging(frozen, cp)).not.toThrow();
    expect(() => validatePackagingCheckpoint(frozen, cp, true)).not.toThrow();
    expect(cp.captions).toHaveLength(2);
    // A narration that is still there must still be frame-split; only a deleted one is exempt.
    cp.captionLayoutVersion = 'SEGMENT_V3';
    cp.voices!['line-1'] = { fileObjectId: 'voice', start: 0, duration: 2.4, volume: 1 };
    expect(() => requireSlotPackaging(frozen, cp)).toThrow();
  });
  it('keeps enumeration commas in V2 and holds the card adjacency on the worker path', () => {
    const { frozen, cp } = segmentedV2();
    expect(() => requireSlotPackaging(frozen, cp)).not.toThrow();
    for (const text of ['腊肠，米饭', '腊肠!米饭', '腊肠？米饭', '腊肠。米饭']) {
      cp.captions![0]!.text = text;
      expect(() => requireSlotPackaging(frozen, cp)).toThrow();
    }
    cp.captions![0]!.text = '腊肠、米饭';
    cp.captions![1]!.start = 1.3;
    // The pipeline writes a line's cards edge to edge; the editor may pull one away from the next.
    expect(() => requireSlotPackaging(frozen, cp)).not.toThrow();
    expect(() => validatePackagingCheckpoint(frozen, cp, true)).toThrow();
  });
  it('validates V3 subtitles against actual PCM segment frames', () => {
    const { frozen, cp } = segmentedV2();
    cp.captionLayoutVersion = 'SEGMENT_V3';
    cp.voices!['line-1']!.segmentFrames = [24_000, 33_600];
    cp.captions![0]!.end = 1;
    cp.captions![1]!.start = 1;
    expect(() => validatePackagingCheckpoint(frozen, cp, true)).not.toThrow();
    cp.captions![0]!.end = 1.2;
    cp.captions![1]!.start = 1.2;
    expect(() => validatePackagingCheckpoint(frozen, cp, true)).toThrow();
    cp.captions![0]!.end = 1;
    cp.captions![1]!.start = 1;
    cp.voices!['line-1']!.segmentFrames = [24_000, 24_000];
    expect(() => validatePackagingCheckpoint(frozen, cp, true)).toThrow();
    cp.voices!['line-1']!.segmentFrames = [57_600];
    expect(() => validatePackagingCheckpoint(frozen, cp, true)).toThrow();
  });
  it('validates spoken ranges including first-clause silence and gaps', () => {
    const { frozen, cp } = segmentedV2();
    cp.captionLayoutVersion = 'SPEECH_V1';
    cp.voices!['line-1']!.speechRanges = [
      { startFrame: 4800, endFrame: 24000 },
      { startFrame: 33600, endFrame: 55200 },
    ];
    cp.captions![0]!.start = 0.2;
    cp.captions![0]!.end = 1;
    cp.captions![1]!.start = 1.4;
    cp.captions![1]!.end = 2.3;
    expect(() => validatePackagingCheckpoint(frozen, cp, true)).not.toThrow();
    cp.captions![0]!.start = 0;
    expect(() => validatePackagingCheckpoint(frozen, cp, true)).toThrow();
    expect(() => validatePackagingCheckpoint(frozen, cp, true, true)).not.toThrow();
    cp.voices!['line-1']!.speechRanges![1]!.endFrame = 100000;
    expect(() => validatePackagingCheckpoint(frozen, cp, true, true)).toThrow();
  });
  it('cannot downgrade a new packaging job to historical duration-based captions', () => {
    const { frozen, cp } = segmentedV2();
    frozen.captionTimingPolicy = 'SYNTHESIS_WORDS_V1';
    expect(() => validatePackagingCheckpoint(frozen, cp, true)).toThrow();
    cp.voices!['line-1']!.speechRanges = [
      { startFrame: 0, endFrame: 28800 },
      { startFrame: 28800, endFrame: 57600 },
    ];
    expect(() => validatePackagingCheckpoint(frozen, cp, true)).toThrow();
    cp.captionLayoutVersion = 'SPEECH_V1';
    expect(() => validatePackagingCheckpoint(frozen, cp, true)).not.toThrow();
  });
  it('keeps source speech ranges intact when the editor trims the narration tail', () => {
    const { frozen, cp } = segmentedV2();
    cp.captionLayoutVersion = 'SPEECH_V1';
    cp.voices!['line-1']!.segmentFrames = [24_000, 33_600];
    cp.voices!['line-1']!.speechRanges = [
      { startFrame: 4800, endFrame: 24000 },
      { startFrame: 33600, endFrame: 55200 },
    ];
    cp.voices!['line-1']!.duration = 2;
    expect(() => validatePackagingCheckpoint(frozen, cp, true, true)).not.toThrow();
    expect(() => validatePackagingCheckpoint(frozen, cp, true, false)).toThrow();
    const canonical = canonicalizeCheckpoint(frozen, cp);
    expect(canonical.voices!['line-1']!.duration).toBe(2.4);
    expect(canonical.captions!.map((c) => [c.start, c.end])).toEqual([
      [0.2, 1],
      [1.4, 2.3],
    ]);
    expect(() => validatePackagingCheckpoint(frozen, canonical, true)).not.toThrow();
    cp.voices!['line-1']!.offset = 0.5;
    expect(() => validatePackagingCheckpoint(frozen, cp, true, true)).toThrow();
  });
  it.each([4, 15])('accepts %s-second slots', (duration) => {
    const v = variant();
    v.slots[0]!.duration = duration;
    expect(packagingSnapshot(v, materials, sources()).clips[0]!.duration).toBe(duration);
  });
  it('freezes safe source names in the packaging snapshot without replacing the private prompt field', () => {
    const clip = packagingSnapshot(variant(), materials, sources()).clips[0]!;
    expect(clip).toMatchObject({ materialCode: 'R-06', materialName: '腊肠煎制' });
    expect(clip.prompt).toBe('镜头原始Prompt');
  });
  it.each([3.99, 15.01, NaN])('rejects %s-second slots before paid work', (duration) => {
    const v = variant();
    v.slots[0]!.duration = duration;
    expect(() => packagingSnapshot(v, materials, sources())).toThrow('4–15');
  });
  it('rejects overlap across different visual lanes', () => {
    const v = variant();
    v.slots.push({ ...v.slots[0]!, id: 's2' });
    v.bindings.s2 = 'clip';
    v.bindingRevisions.s2 = 1;
    v.timelineStarts = { s: 0, s2: 9 };
    v.videoLanes = { s2: 1 };
    expect(() => packagingSnapshot(v, materials, sources())).toThrow('槽位口播边界冲突');
  });
  it('packages actual video only, ignoring empty signs and their apparent overlap', () => {
    const v = variant();
    v.slots.unshift({ ...v.slots[0]!, id: 'sign', duration: 2 });
    v.timelineStarts = { sign: 0, s: 0 };
    const frozen = packagingSnapshot(v, materials, sources());
    expect(frozen.clips.map(({ slotId }) => slotId)).toEqual(['s']);
    expect(frozen.duration).toBe(10);
  });
  const overlaid = () => {
    const v = variant();
    v.slots.push({ ...v.slots[0]!, id: 's2', overlay: true });
    v.bindings.s2 = 'clip';
    v.bindingRevisions.s2 = 1;
    v.offsets.s2 = 0;
    // The overlay sits on top of the narrated slot, on its own lane, and covering it is its job.
    v.timelineStarts = { s2: 3 };
    v.videoLanes = { s2: 1 };
    return v;
  };
  it('freezes an overlay that covers a narrated slot, and marks it picture only', () => {
    const frozen = packagingSnapshot(overlaid(), materials, sources());
    expect(frozen.clips.map((clip) => clip.overlay)).toEqual([false, true]);
  });
  it('keeps an overlay out of the visual hash, so stacking one cannot lock the package', () => {
    const plain = variant();
    const stacked = overlaid();
    // Adding, moving or removing a picture layer is not a change to what was confirmed, so the hash
    // the captions and audio were arranged against has to survive it.
    expect(visualHash(stacked)).toBe(visualHash(plain));
    // Moving it around, or taking it away again, is equally invisible to the hash.
    expect(visualHash({ ...stacked, timelineStarts: { s2: 7 }, videoLanes: { s2: 2 } })).toBe(
      visualHash(plain),
    );
    expect(visualHash({ ...stacked, slots: plain.slots })).toBe(visualHash(plain));
  });
  it('keeps packaging current when clips are moved or reordered on the visual timeline', () => {
    const two = variant();
    two.slots.push({ ...two.slots[0]!, id: 's2', role: 'END' });
    two.bindings.s2 = 'clip';
    two.bindingRevisions.s2 = 1;
    two.offsets.s2 = 0;
    two.timelineStarts = { s: 0, s2: 10 };
    const apart = { ...two, videoLanes: { s: 0, s2: 1 } };
    // Track placement and order are live editor state; packaging audio remains independent.
    expect(visualHash({ ...apart, videoLanes: { s: 1, s2: 2 } })).toBe(visualHash(apart));
    expect(visualHash({ ...apart, videoLanes: { s: 1, s2: 0 } })).toBe(visualHash(apart));
    expect(visualHash({ ...apart, timelineStarts: { s: 2, s2: 12 } })).toBe(visualHash(apart));
    expect(
      visualHash({ ...apart, slots: apart.slots.map((slot) => ({ ...slot, transition: '叠化' })) }),
    ).toBe(visualHash(apart));
    expect(
      visualHash({
        ...apart,
        slots: apart.slots.map((slot) => ({ ...slot, duration: slot.duration + 1 })),
      }),
    ).not.toBe(visualHash(apart));
  });
  it('reports the overlays separately, so the render can still tell two of them apart', () => {
    const stacked = overlaid();
    expect(packagingOverlayTimeline(stacked)).toEqual([
      {
        id: 's2',
        binding: 'clip',
        bindingRevision: 1,
        offset: 0,
        start: 3,
        lane: 1,
        duration: 10,
        transition: '硬切',
        transitionDuration: 0,
      },
    ]);
    // The hash ignores the overlay on purpose, so this is the only thing that changes when one is
    // added or moved — the export's dedupe key would otherwise hand back the earlier run.
    expect(packagingOverlayTimeline({ ...stacked, timelineStarts: { s: 0, s2: 4 } })).not.toEqual(
      packagingOverlayTimeline(stacked),
    );
    expect(packagingOverlayTimeline(variant())).toEqual([]);
  });
  it('builds clips for just the overlays, which is how the export folds them back in', () => {
    const stacked = overlaid();
    const overlays = stacked.slots.filter((slot) => slot.overlay === true);
    const clips = packagingClips(
      { ...stacked, slots: overlays },
      materials,
      artifactVisitor(sources()),
    );
    expect(clips.map((clip) => [clip.slotId, clip.overlay, clip.lane, clip.start])).toEqual([
      ['s2', true, 1, 3],
    ]);
  });
  it('counts the script against the narrated clips, so an overlay needs no line', () => {
    const frozen = packagingSnapshot(overlaid(), materials, sources());
    const cp = checkpoint();
    cp.narrationLayoutVersion = 'SLOT_V1';
    cp.script![0]!.slotId = 's';
    cp.script![0]!.end = 10;
    expect(() => requireSlotPackaging(frozen, cp)).not.toThrow();
  });
  it('requires exactly one valid line per slot at completion', () => {
    const { frozen, cp } = current();
    expect(() => requireSlotPackaging(frozen, cp)).not.toThrow();
    for (const lines of [
      [],
      [{ ...cp.script![0]!, slotId: 'unknown' }],
      [cp.script![0]!, { ...cp.script![0]!, id: 'duplicate' }],
    ])
      expect(() => requireSlotPackaging(frozen, { ...cp, script: lines })).toThrow();
  });
  it('allows the empty intermediate checkpoint when redoing the only slot, but never ready', () => {
    const { frozen, cp } = current();
    cp.script = [];
    cp.voices = {};
    cp.captions = [];
    expect(() => validatePackagingCheckpoint(frozen, cp)).not.toThrow();
    expect(() => requireSlotPackaging(frozen, cp)).toThrow();
  });
  it('does not let the worker path borrow a following gap, while the editor may', () => {
    const { frozen, cp } = current();
    frozen.duration = 20;
    cp.voices!['line-1']!.start = 9;
    // The editor is free to carry a line into the gap; the canonical worker write is not.
    expect(() => validatePackagingCheckpoint(frozen, cp, true, true)).not.toThrow();
    expect(() => validatePackagingCheckpoint(frozen, cp, true)).toThrow();
    cp.voices!['line-1']!.start = 0;
    cp.captions![0]!.end = 11;
    expect(() => validatePackagingCheckpoint(frozen, cp, true, true)).not.toThrow();
    expect(() => validatePackagingCheckpoint(frozen, cp, true)).toThrow();
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
    // Audio rows are pure arrangement: dragging a clip to another row must not restate the payload.
    b.audioLanes = { music: 1, 'voice:line-1': 2 };
    expect(visualHash(a)).toBe(visualHash(b));
    expect(packagingVisualVariant(a)).toEqual(packagingVisualVariant(b));
    b.offsets.s = 1;
    expect(visualHash(a)).not.toBe(visualHash(b));
  });
  it('keeps narration packaging current when independent music or detached audio changes', () => {
    const original = variant();
    const edited = variant();
    edited.detachedAudios = [
      {
        id: 'library-music',
        sourceAssetId: 'music-asset',
        fileObjectId: 'music-file',
        name: '轻快配乐.mp3',
        sourceDuration: 30,
        start: 0,
        offset: 0,
        duration: 10,
        volume: 0.5,
      },
    ];

    expect(visualHash(original)).toBe(visualHash(edited));
    expect(matchesVisualHash(edited, visualHash(original), original)).toBe(true);
  });
  it('treats explicit default lanes as unchanged and reads legacy frozen hashes safely', () => {
    const implicit = variant();
    const explicit = { ...variant(), videoLanes: { s: 0 } };
    expect(visualHash(implicit)).toBe(visualHash(explicit));
    const legacy = workflowStateHash({
      ...packagingVisualTimeline(explicit),
      videoLanes: { s: 0 },
    });
    expect(matchesVisualHash(implicit, legacy, explicit)).toBe(true);
    expect(matchesVisualHash(explicit, legacy, explicit)).toBe(true);
    expect(matchesVisualHash(implicit, 'forged', explicit)).toBe(false);
    // A row is only an order, and a lone clip has no order to change: renumbering it is the same
    // picture, so the legacy fallback is allowed to read it as unchanged.
    expect(matchesVisualHash({ ...explicit, videoLanes: { s: 1 } }, legacy, explicit)).toBe(true);
    // Legacy hashes are accepted after repositioning; a source trim still invalidates the package.
    const stacked = {
      ...explicit,
      slots: [...explicit.slots, { ...explicit.slots[0]!, id: 's2', role: 'END' as const }],
      bindings: { s: 'clip', s2: 'clip' },
      bindingRevisions: { s: 1, s2: 1 },
      offsets: { s: 0, s2: 0 },
      videoLanes: { s: 0, s2: 1 },
    };
    const stackedLegacy = workflowStateHash({
      ...packagingVisualTimeline(stacked),
      videoLanes: stacked.videoLanes,
    });
    expect(
      matchesVisualHash({ ...stacked, videoLanes: { s: 1, s2: 0 } }, stackedLegacy, stacked),
    ).toBe(true);
    expect(matchesVisualHash({ ...explicit, offsets: { s: 1 } }, legacy, explicit)).toBe(false);
  });
  it('ignores starts the sequential layout would have produced anyway', () => {
    const implicit = variant();
    // The editor materializes a start for every slot on the first trim. A start that equals the
    // sequential cursor is the same picture, so it must not restate an already-confirmed hash.
    const materialized = { ...variant(), timelineStarts: { s: 0 } };
    expect(visualHash(implicit)).toBe(visualHash(materialized));
    expect(matchesVisualHash(materialized, visualHash(implicit), implicit)).toBe(true);
    // A moved clip is live placement and does not expire otherwise-compatible packaging.
    expect(visualHash({ ...variant(), timelineStarts: { s: 5 } })).toBe(visualHash(implicit));
  });
  it('keeps overlay placement out of package validity while preserving slot source identity', () => {
    const withOverlay = (timelineStarts: Record<string, number>) => {
      const base = variant();
      return {
        ...base,
        slots: [
          base.slots[0]!,
          // An overlay still occupies time, so the slot after it starts later than a walk that
          // skipped the overlay would think.
          { ...base.slots[0]!, id: 'o', overlay: true, duration: 3 },
          { ...base.slots[0]!, id: 's2', role: 'END' as const, duration: 4 },
        ],
        bindings: { s: 'clip', s2: 'clip' },
        bindingRevisions: { s: 1, s2: 1 },
        offsets: { s: 0, s2: 0 },
        timelineStarts,
      };
    };
    // Adding, moving, or removing a picture-only overlay changes the live render, not the package.
    const sequential = withOverlay({ s: 0, o: 10, s2: 13 });
    expect(visualHash(sequential)).toBe(visualHash(withOverlay({})));
    expect(visualHash(withOverlay({ s: 0, o: 10, s2: 10 }))).toBe(visualHash(sequential));
  });
  it('reads a package confirmed before starts were normalized as the same picture', () => {
    // The editor materialized the sequential start, and the package was hashed with it in place.
    const materialized = { ...variant(), timelineStarts: { s: 0 } };
    const confirmed = workflowStateHash({
      ...packagingVisualTimeline(materialized),
      timelineStarts: { s: 0 },
    });
    expect(matchesVisualHash(materialized, confirmed, materialized)).toBe(true);
    // Even old checkpoints stay editable after the clip is moved.
    expect(
      matchesVisualHash({ ...variant(), timelineStarts: { s: 5 } }, confirmed, materialized),
    ).toBe(true);
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
  it('accepts an integer count of repaired script slots and rejects forged timing metrics', () => {
    const cp = checkpoint();
    cp.timings = {
      _item: {
        scriptSeconds: 18.5,
        scriptRepairSlots: 1,
        musicDownloadSeconds: 1.2,
        musicTranscodeSeconds: 2.4,
        musicUploadSeconds: 3.6,
        apiHeartbeatSeconds: 0.3,
        checkpointSeconds: 0.4,
        captionSeconds: 0.01,
      },
    };
    expect(() => validatePackagingCheckpoint(snapshot(), cp)).not.toThrow();
    cp.timings._item!.musicUploadSeconds = -1;
    expect(() => validatePackagingCheckpoint(snapshot(), cp)).toThrow();
    cp.timings._item!.musicUploadSeconds = 3.6;
    cp.timings._item!.scriptRepairSlots = 1.5;
    expect(() => validatePackagingCheckpoint(snapshot(), cp)).toThrow();
  });
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
  it('lets the editor carry placed audio past the frozen timeline, up to the capacity cap', () => {
    // The film is as long as its content, so a track moved past the last video clip is a black
    // tail rather than an error — carrying one out there is exactly how the editor extends it.
    const overVoice = checkpoint();
    overVoice.voices!['line-1'] = { fileObjectId: 'voice', start: 8.5, duration: 2.4, volume: 1 };
    expect(() => validatePackagingCheckpoint(snapshot(), overVoice, true, true)).not.toThrow();
    const overMusic = checkpoint();
    overMusic.music = { fileObjectId: 'music', start: 5, duration: 6, volume: 0.2 };
    expect(() => validatePackagingCheckpoint(snapshot(), overMusic, true, true)).not.toThrow();
    // The worker path stays canonical, so the same checkpoint is refused there.
    expect(() => validatePackagingCheckpoint(snapshot(), overVoice, true)).toThrow();
    // Capacity is the only bound left.
    const tooLong = checkpoint();
    tooLong.music = { fileObjectId: 'music', start: 3599, duration: 6, volume: 0.2 };
    expect(() => validatePackagingCheckpoint(snapshot(), tooLong, true, true)).toThrow();
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
  it('accepts an empty manual subtitle draft only on the editor write path', () => {
    const edited = checkpoint();
    // Manual titles are an independent lane and may cover an AI narration subtitle interval.
    edited.captions!.push({
      id: 'manual-caption',
      manual: true,
      trackId: 'subtitle-track-0000000000001-test',
      text: '',
      start: 1,
      end: 1.5,
    });
    expect(() => validatePackagingCheckpoint(snapshot(), edited, true, true)).not.toThrow();
    expect(() => validatePackagingCheckpoint(snapshot(), edited, true, false)).toThrow();
    const invalidTrack = {
      ...edited,
      captions: edited.captions!.map((caption) =>
        caption.id === 'manual-caption' ? { ...caption, trackId: 'not valid!' } : caption,
      ),
    };
    expect(() => validatePackagingCheckpoint(snapshot(), invalidTrack, true, true)).toThrow();
    const notManual = {
      ...edited,
      captions: edited.captions!.map((caption) =>
        caption.id === 'manual-caption' ? { ...caption, manual: false } : caption,
      ),
    };
    expect(() => validatePackagingCheckpoint(snapshot(), notManual, true, true)).toThrow();
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
    faded.music = {
      fileObjectId: 'music',
      start: 0,
      duration: 10,
      volume: 0.12,
      fadeIn: 0.5,
      fadeOut: 0.5,
    };
    expect(() => validatePackagingCheckpoint(snapshot(), faded, true)).not.toThrow();
    expect(canonicalizeCheckpoint(snapshot(), faded).voices!['line-1']).toMatchObject({
      fadeIn: 0.4,
      fadeOut: 0.6,
    });
    expect(canonicalizeCheckpoint(snapshot(), faded).music).toMatchObject({
      fadeIn: 0.5,
      fadeOut: 0.5,
    });
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
      voice.voices!['line-1'] = {
        fileObjectId: 'voice',
        start: 0,
        duration: 2.4,
        volume: 1,
        ...fade,
      };
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
  it('automatically stacks overlapping generated captions after independent movement', () => {
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
    expect(() => validatePackagingCheckpoint(snapshot(), overlapping, true, true)).not.toThrow();
    const fixedTrackOverlap: PackagingCheckpoint = {
      ...overlapping,
      captions: overlapping.captions!.map((caption) => ({ ...caption, trackId: 'fixed-row' })),
    };
    expect(() => validatePackagingCheckpoint(snapshot(), fixedTrackOverlap, true, true)).toThrow();
  });
  it('lets subtitles on different tracks overlap, while one track still refuses it', () => {
    const track = 'subtitle-track-0000000000001-a';
    const acrossTracks: PackagingCheckpoint = {
      ...checkpoint(),
      captions: [
        { id: 'line-1', text: '商品', start: 0, end: 2.4 },
        // A card on a track of its own is drawn on its own row, so covering the narration is the
        // editor's business rather than a conflict.
        { id: 'manual-caption', manual: true, trackId: track, text: '', start: 1, end: 2 },
      ],
    };
    expect(() => validatePackagingCheckpoint(snapshot(), acrossTracks, true, true)).not.toThrow();
    const oneTrack: PackagingCheckpoint = {
      ...acrossTracks,
      captions: [
        { id: 'line-1', text: '商品', start: 0, end: 2.4, trackId: track },
        { id: 'manual-caption', manual: true, trackId: track, text: '', start: 1, end: 2 },
      ],
    };
    // Two cards that really share one track are the pair the renderer would show at once.
    expect(() => validatePackagingCheckpoint(snapshot(), oneTrack, true, true)).toThrow();
  });
  it('gives any card a track of its own and only checks the shape of the id', () => {
    const track = 'subtitle-track-0000000000001-a';
    const narration: PackagingCheckpoint = {
      ...checkpoint(),
      captions: [{ id: 'line-1', text: '商品', start: 0, end: 2.4, trackId: track }],
    };
    // A narration card the editor pulled onto its own row carries one just as a manual title does.
    expect(() => validatePackagingCheckpoint(snapshot(), narration, true, true)).not.toThrow();
    const malformed: PackagingCheckpoint = {
      ...checkpoint(),
      captions: [{ id: 'line-1', text: '商品', start: 0, end: 2.4, trackId: 'not valid!' }],
    };
    expect(() => validatePackagingCheckpoint(snapshot(), malformed, true, true)).toThrow();
    // A cleared row has to reach the validator as an absent field rather than as a `null`: the shape
    // check above refuses anything that is not a string, and the cast is the only way to hand it the
    // `null` the contract allows. That is why the service resolves `null` to "no track" first, and
    // why the ordering is pinned here — a clear answered with a 400 is exactly what it would look
    // like if the resolution ever moved after this call.
    const literalNull: PackagingCheckpoint = {
      ...checkpoint(),
      captions: [
        { id: 'line-1', text: '商品', start: 0, end: 2.4, trackId: null as unknown as string },
      ],
    };
    expect(() => validatePackagingCheckpoint(snapshot(), literalNull, true, true)).toThrow();
  });
  it('treats a deleted music bed as a normal, renderable checkpoint', () => {
    const silent = checkpoint();
    delete silent.music;
    // The editor may delete the bed, so `ready` must not require one.
    expect(() => validatePackagingCheckpoint(snapshot(), silent, true, true)).not.toThrow();
  });
  it('treats a deleted narration as a normal, renderable checkpoint', () => {
    const muted = checkpoint();
    delete muted.voices!['line-1'];
    // A narration is an optional overlay on its line: the line and its subtitle are what the film
    // is built from, so deleting the audio leaves a package that still renders — just silently.
    expect(() => validatePackagingCheckpoint(snapshot(), muted, true, true)).not.toThrow();
    // The worker write path is stricter about geometry, but it must not be stricter about this:
    // a redo that reuses an edited checkpoint sees the same missing narration.
    expect(() => validatePackagingCheckpoint(snapshot(), muted, true, false)).not.toThrow();
    // The line and the subtitle are exactly what a delete must not take with it.
    expect(muted.script).toHaveLength(1);
    expect(muted.captions).toHaveLength(1);
  });
  it('still refuses a caption whose line is gone', () => {
    const orphan: PackagingCheckpoint = {
      ...checkpoint(),
      captions: [{ id: 'ghost', text: '商品', start: 0, end: 2.4 }],
    };
    // Deleting the audio is allowed; deleting the line the subtitle hangs off is not.
    expect(() => validatePackagingCheckpoint(snapshot(), orphan, true, true)).toThrow();
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
  it('accepts a shared caption font size in the supported pixel range', () => {
    for (const size of [8, 16, 48]) {
      const valid = checkpoint();
      valid.captionFontSize = size;
      expect(() => validatePackagingCheckpoint(snapshot(), valid, true, true)).not.toThrow();
    }
    for (const size of [7, 49, 16.5]) {
      const invalid = checkpoint();
      invalid.captionFontSize = size;
      expect(() => validatePackagingCheckpoint(snapshot(), invalid, true, true)).toThrow();
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
  it('accepts an editor-generated caption narration without giving it a script line', () => {
    const voiced = checkpoint();
    voiced.captionVoices = {
      'caption-1': { fileObjectId: 'file-9', duration: 3, start: 0.5, volume: 1 },
    };
    // The editor may carry it anywhere, and the strict worker path accepts it too — a component redo
    // validates with the strict rules after the editor has already moved things.
    expect(() => validatePackagingCheckpoint(snapshot(), voiced, true, true)).not.toThrow();
    expect(() => validatePackagingCheckpoint(snapshot(), voiced, true)).not.toThrow();
    // It has no script line and no matching caption, and neither is required.
    expect(voiced.script?.some((line) => line.id === 'caption-1')).not.toBe(true);
    expect(voiced.captions?.some((c) => c.id === 'caption-1')).not.toBe(true);
  });
  it('keeps a generated caption narration through a component redo and rejects forged entries', () => {
    const redo: PackagingCheckpoint = checkpoint();
    delete redo.captions;
    redo.captionVoices = {
      'caption-1': { fileObjectId: 'file-9', duration: 3, start: 0.5, volume: 1 },
    };
    // The redo regenerates the caption list, so the narration outlives the caption it came from:
    // deleting a subtitle must not silently delete the audio the user paid for.
    expect(() => validatePackagingCheckpoint(snapshot(), redo)).not.toThrow();
    expect(canonicalizeCheckpoint(snapshot(), redo).captionVoices).toEqual(redo.captionVoices);
    for (const id of ['', 'a b', 'x'.repeat(51)]) {
      const forged = checkpoint();
      forged.captionVoices = {
        [id]: { fileObjectId: 'file-9', duration: 3, start: 0, volume: 1 },
      };
      expect(() => validatePackagingCheckpoint(snapshot(), forged)).toThrow();
    }
    for (const audio of [
      { fileObjectId: 'file-9', duration: 0, start: 0, volume: 1 },
      { fileObjectId: 'file-9', duration: 3, start: -1, volume: 1 },
      { fileObjectId: 'file-9', duration: 3, start: 0, volume: -0.1 },
      { fileObjectId: 'file-9', duration: 3, start: 0, volume: 11 },
      { fileObjectId: 'file-9', duration: 3, start: 0, volume: 1, offset: -1 },
      { fileObjectId: 'file-9', duration: 3, start: 0, volume: 1, fadeIn: 4 },
      { fileObjectId: 'file-9', duration: 3, start: 0, volume: 1, segmentFrames: [24_000] },
    ]) {
      const bad = checkpoint();
      bad.captionVoices = { 'caption-1': audio as never };
      expect(() => validatePackagingCheckpoint(snapshot(), bad)).toThrow();
    }
  });
});
