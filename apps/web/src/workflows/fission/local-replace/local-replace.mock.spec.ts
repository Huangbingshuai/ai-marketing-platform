import { describe, expect, it } from 'vitest';
import {
  bindAsset,
  createMockDraft,
  draftKey,
  generateMockPrompts,
  invalidateAfter,
  interruptMockTasks,
  rangeError,
  restoreMockDraft,
  regenerateMockPromptField,
  mockNodeStatus,
  mockArtifactFingerprint,
  videoResolution,
  videoRatio,
  rangeTimelineWidth,
  rangeTimelineTicks,
} from './local-replace.mock';

const configured = () => {
  const draft = createMockDraft();
  draft.start = 4;
  draft.end = 16;
  draft.analysis = 'done';
  bindAsset(draft, 'person', 'person-chef');
  generateMockPrompts(draft);
  draft.render = 'done';
  draft.step = 5;
  return draft;
};

describe('local replacement Mock boundaries', () => {
  it('retains the editable package and manual fields when a single-field retry is cancelled or interrupted', () => {
    for (const field of ['text', 'composition', 'negative'] as const) {
      const draft = configured();
      draft.composition = '人工保留的合成约束';
      draft.negative = '人工保留的负面约束';
      const before = [draft.text, draft.composition, draft.negative];
      draft.promptRegeneration = field;
      draft.prompt = 'running';
      const restored = restoreMockDraft(JSON.stringify(draft));
      expect(restored.prompt).toBe('done');
      expect(restored.promptRegeneration).toBeNull();
      expect([restored.text, restored.composition, restored.negative]).toEqual(before);
      interruptMockTasks(draft);
      expect(draft.prompt).toBe('done');
      expect([draft.text, draft.composition, draft.negative]).toEqual(before);
    }
  });
  it('keeps source resolution and ratio consistent for horizontal, square and imported videos', () => {
    const source = createMockDraft().source!;
    expect(videoResolution({ ...source, ratio: '16:9' })).toBe('1920 × 1080');
    expect(videoResolution({ ...source, ratio: '1:1' })).toBe('1080 × 1080');
    expect(videoResolution({ ...source, ratio: '4:3', resolution: '640 × 480' })).toBe('640 × 480');
    expect(videoRatio(640, 480)).toBe('4:3');
    expect(videoRatio(512, 512)).toBe('1:1');
  });
  it('uses prototype timeline scale and duration-aware ruler ticks including the exact endpoint', () => {
    expect(rangeTimelineWidth(32, 1)).toBe(960);
    expect(rangeTimelineWidth(32, 2)).toBe(1920);
    expect(rangeTimelineTicks(7)).toEqual([0, 2, 4, 6, 7]);
    expect(rangeTimelineTicks(95).at(-1)).toBe(95);
  });
  it('restores imported asset metadata and keeps local bindings in the same scoped draft', () => {
    const draft = configured();
    draft.importedAssets.push({
      id: 'local-asset-qa',
      type: 'product',
      name: '本地商品.png',
      version: '本地 v1',
      label: '本地导入',
      variant: 'local',
      fit: 100,
      tags: ['本地导入'],
      local: true,
    });
    expect(bindAsset(draft, 'product', 'local-asset-qa')).toBe(true);
    generateMockPrompts(draft);
    expect(draft.text).toContain('本地商品.png');
    const restored = restoreMockDraft(JSON.stringify(draft));
    expect(restored.bindings.product).toBe('local-asset-qa');
    expect(restored.importedAssets).toHaveLength(1);
    expect(createMockDraft().importedAssets).toEqual([]);
  });
  it('keeps completed downstream nodes completed while navigating back', () => {
    const draft = configured();
    draft.step = 1;
    expect([2, 3, 4, 5].map((step) => mockNodeStatus(draft, step))).toEqual([
      'done',
      'done',
      'done',
      'done',
    ]);
    draft.render = 'warning';
    expect(mockNodeStatus(draft, 5)).toBe('warning');
    invalidateAfter(draft, 'range');
    expect(mockNodeStatus(draft, 3)).toBe('pending');
  });
  it('scopes archive fingerprints to each node and includes all prompt fields', () => {
    const draft = configured();
    draft.step = 1;
    const sourceFingerprint = mockArtifactFingerprint(draft);
    draft.composition = 'new composition';
    draft.negative = 'new negative';
    expect(mockArtifactFingerprint(draft)).toBe(sourceFingerprint);
    draft.step = 4;
    const promptFingerprint = mockArtifactFingerprint(draft);
    draft.negative = 'another negative';
    expect(mockArtifactFingerprint(draft)).not.toBe(promptFingerprint);
    draft.archives[sourceFingerprint] = {
      names: ['原成片素材'],
      tags: '演示标签',
      note: '入库说明',
    };
    expect(restoreMockDraft(JSON.stringify(draft)).archives[sourceFingerprint]).toEqual({
      names: ['原成片素材'],
      tags: '演示标签',
      note: '入库说明',
    });
  });
  it('regenerates a single prompt field while preserving other manual edits', () => {
    const draft = configured();
    draft.composition = '人工编辑的整片约束';
    draft.negative = '人工编辑的负面约束';
    draft.text = '待重新生成';
    regenerateMockPromptField(draft, 'text');
    expect(draft.text).toContain('00:04.0–00:16.0');
    expect(draft.composition).toBe('人工编辑的整片约束');
    expect(draft.negative).toBe('人工编辑的负面约束');
    expect(draft.render).toBe('stale');
  });
  it('accepts a 0.1-second range and rejects reversed, nonfinite and out-of-source ranges', () => {
    const draft = createMockDraft();
    draft.start = 31.9;
    draft.end = 32;
    expect(rangeError(draft)).toBe('');
    draft.end = 33;
    expect(rangeError(draft)).toContain('超出');
    draft.end = 4;
    expect(rangeError(draft)).toContain('晚于');
    draft.end = NaN;
    expect(rangeError(draft)).toContain('有效');
    draft.source = null;
    expect(rangeError(draft)).toContain('选择');
  });
  it('keeps a single binding per dimension, rejects mismatched asset types, and keeps unchanged binding results', () => {
    const draft = configured();
    expect(bindAsset(draft, 'person', 'product-pack')).toBe(false);
    expect(bindAsset(draft, 'person', 'person-chef')).toBe(true);
    expect(draft.render).toBe('done');
    expect(bindAsset(draft, 'person', 'person-host')).toBe(true);
    expect(draft.bindings).toEqual({ person: 'person-host' });
    expect(draft.prompt).toBe('idle');
    expect(draft.render).toBe('idle');
  });
  it('invalidates only downstream state for two consecutive range changes and source changes', () => {
    const draft = configured();
    for (const start of [8, 12]) {
      draft.start = start;
      invalidateAfter(draft, 'range');
      expect(draft.analysis).toBe('idle');
      expect(draft.bindings).toEqual({});
      expect(draft.text).toBe('');
      expect(draft.render).toBe('idle');
      draft.analysis = 'done';
      bindAsset(draft, 'product', 'product-pack');
      generateMockPrompts(draft);
    }
    invalidateAfter(draft, 'source');
    expect([draft.start, draft.end]).toEqual([0, 0]);
    expect(draft.bindings).toEqual({});
  });
  it('marks completed output stale on prompt edits without erasing confirmed mappings', () => {
    const draft = configured();
    draft.text += ' 精确融合。';
    invalidateAfter(draft, 'prompt');
    expect(draft.render).toBe('stale');
    expect(draft.prompt).toBe('done');
    expect(draft.bindings.person).toBe('person-chef');
    expect(draft.text).toContain('精确融合');
  });
  it('restores scoped drafts and turns interrupted work into retryable failures', () => {
    const first = configured();
    const second = createMockDraft();
    const storage = new Map([
      [draftKey('p1'), JSON.stringify(first)],
      [draftKey('p2'), JSON.stringify(second)],
    ]);
    expect(restoreMockDraft(storage.get(draftKey('p1'))!).bindings.person).toBe('person-chef');
    expect(restoreMockDraft(storage.get(draftKey('p2'))!).bindings).toEqual({});
    first.render = 'running';
    expect(restoreMockDraft(JSON.stringify(first)).render).toBe('failed');
    expect(restoreMockDraft('{broken')).toEqual(createMockDraft());
    expect(restoreMockDraft(JSON.stringify({ ...first, analysis: 'unknown' }))).toEqual(
      createMockDraft(),
    );
  });
  it('generates one range prompt containing actual asset versions and original preservation constraints', () => {
    const draft = configured();
    expect(draft.text).toContain('00:04.0–00:16.0');
    expect(draft.text).toContain('中年粤菜大厨（v3）');
    expect(draft.text).toContain('范围外画面逐帧保持原片');
    expect(draft.composition).toContain('1 个主体维度');
  });
});
