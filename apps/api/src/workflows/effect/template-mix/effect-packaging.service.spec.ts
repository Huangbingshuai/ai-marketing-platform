import { ConflictException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type {
  EffectTemplateMixVariant,
  PackagingCheckpoint,
  PackagingRun,
} from '@ai-marketing/contracts';
import type { StoragePort } from '../../../platform/file/storage.port';
import type { WorkflowWorkingService } from '../../../platform/workflow/workflow-working.service';
import type { EffectTemplateMixService } from './effect-template-mix.service';
import type { EffectPackagingRepository } from './effect-packaging.repository';
import { EffectPackagingService } from './effect-packaging.service';
import { visualHash } from './effect-packaging.domain';
import * as packagingDomain from './effect-packaging.domain';

const v = {
  id: 'v',
  slots: [],
  bindings: {},
  bindingRevisions: {},
  offsets: {},
} as unknown as EffectTemplateMixVariant;
function harness() {
  const visual = {
    id: 'visual',
    artifactKey: 'timeline-project:t:v',
    revision: 2,
    availability: 'AVAILABLE',
    freshness: 'CURRENT',
  };
  const packaging = {
    id: 'package',
    artifactKey: 'timeline-package:t:v',
    availability: 'AVAILABLE',
    freshness: 'CURRENT',
    payload: { narrationLayoutVersion: 'SLOT_V1', sourceTimelineHash: visualHash(v), visualArtifactId: 'visual', visualRevision: 2 },
  };
  const mix = {
    workspace: vi.fn().mockResolvedValue({
      draftRevision: 1,
      draft: { templates: [{ id: 't', workspace: { variants: [v] } }] },
    }),
  };
  const working = { listArtifacts: vi.fn().mockResolvedValue({ items: [visual, packaging] }),
    fileObjectContent: vi.fn().mockResolvedValue('voice-content') };
  const repo = {
    get: vi.fn(),
    retry: vi.fn().mockResolvedValue({ status: 'QUEUED' }),
    updateCheckpoint: vi.fn(),
    list: vi.fn().mockResolvedValue([]),
    create: vi.fn().mockResolvedValue('new-run'),
    db: { effectPackagingRun: { findUnique: vi.fn().mockResolvedValue(null) },
      effectPackagingFile: { count: vi.fn().mockResolvedValue(0) },
      effectVoicePreview: { findFirst: vi.fn().mockResolvedValue(null) } },
  };
  const service = new EffectPackagingService(
    repo as unknown as EffectPackagingRepository,
    mix as unknown as EffectTemplateMixService,
    working as unknown as WorkflowWorkingService,
    {} as StoragePort,
  );
  return { service, mix, working, repo, visual, packaging };
}
/** A finished item whose checkpoint matches the canonical worker output. */
function completedItem() {
  const checkpoint: PackagingCheckpoint = {
    vision: [{ start: 0, end: 10, description: '画面动作' }],
    script: [{ id: 'line-1', text: '商品', start: 0, end: 4, factIds: ['f'] }],
    voices: { 'line-1': { fileObjectId: 'voice', start: 0, duration: 2.4, volume: 1 } },
    music: { fileObjectId: 'music', start: 0, duration: 10, volume: 0.12 },
    captions: [{ id: 'line-1', text: '商品', start: 0, end: 2.4 }],
  };
  return {
    id: 'item',
    variantId: 'v',
    name: '成片 01',
    shardIndex: 0,
    sourceTimelineHash: visualHash(v),
    snapshot: {
      sourceTimelineHash: visualHash(v),
      duration: 10,
      variant: v,
      clips: [],
      facts: [{ id: 'f', text: '商品', artifactId: 'a', revision: 1 }],
      dependencies: [],
    },
    checkpoint,
    status: 'COMPLETED',
    stage: 'READY',
    stale: false,
    errorMessage: null,
    startedAt: null,
    completedAt: null,
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  };
}
function completedRun() {
  return { id: 'run', workflowRunId: 'w', templateId: 't', items: [completedItem()] };
}
describe('packaging service output boundary', () => {
  it('projects frozen clip and confirmed-fact examples without exposing file identifiers or raw prompts', async () => {
    const { service, repo, mix } = harness();
    const timelineVariant = {
      ...v,
      slots: [{ id: 'slot-product', label: '产品展示', role: 'PRODUCT', purpose: 'PRODUCT', duration: 8, transition: '叠化', transitionDuration: 0.5 }],
      bindings: { 'slot-product': 'material-1' },
      bindingRevisions: { 'slot-product': 3 },
      offsets: { 'slot-product': 1.25 },
      timelineStarts: { 'slot-product': 2 },
    } as unknown as EffectTemplateMixVariant;
    const sourceTimelineHash = visualHash(timelineVariant);
    const clip = {
      slotId: 'slot-product', materialId: 'material-1', fileObjectId: 'secret-file-id',
      contentHash: 'hash', start: 2, duration: 8, offset: 1.25, lane: 0,
      prompt: '不应透出的完整 Prompt 正文', transition: '叠化', transitionDuration: 0.5,
      originalAudioDetached: true,
    };
    mix.workspace.mockResolvedValue({
      draftRevision: 1,
      draft: { templates: [{ id: 't', workspace: { variants: [timelineVariant] } }] },
      materials: [{ id: 'material-1', code: 'R-06', name: '腊肠煎制' }],
    });
    repo.get.mockResolvedValue({
      id: 'run', workflowRunId: 'w', templateId: 't', status: 'COMPLETED',
      createdAt: new Date('2026-09-23T04:00:00.000Z'), startedAt: null, completedAt: null,
      items: [{
        id: 'item', variantId: 'v', name: '成片 01', shardIndex: 0,
        sourceTimelineHash, snapshot: {
          sourceTimelineHash, duration: 10, variant: timelineVariant, clips: [clip],
          facts: [{ id: 'fact-1', text: '广式腊肠采用传统风干工艺', artifactId: 'artifact', revision: 2 }],
          dependencies: [],
        }, checkpoint: {
          narrationLayoutVersion: 'SLOT_V1',
          script: [{ id: 'line-1', slotId: 'slot-product', text: '依据商品事实组织的文案', start: 2, end: 10, factIds: ['fact-1'] }],
        }, status: 'COMPLETED', stage: 'READY',
        errorMessage: null, startedAt: null, completedAt: null,
        updatedAt: new Date('2026-09-23T04:00:00.000Z'),
      }],
    } as never);

    const result = await service.get('project', 'run');
    expect(result.items[0]?.sourceClips).toEqual([{
      slotLabel: '产品展示', materialName: 'R-06 · 腊肠煎制', sourceOffset: 1.25,
      timelineStart: 2, duration: 8, transition: '叠化', transitionDuration: 0.5,
      originalAudioDetached: true,
    }]);
    expect(result.items[0]?.sourceFacts).toEqual([{ id: 'fact-1', text: '广式腊肠采用传统风干工艺' }]);
    expect(JSON.stringify(result.items[0]?.sourceClips)).not.toContain('secret-file-id');
    expect(JSON.stringify(result.items[0])).not.toContain('完整 Prompt 正文');
  });

  it('allows only the current item’s archived voice for subtitle-only redo', async () => {
    const { service, repo, working } = harness();
    const run = completedRun(), item = run.items[0]!;
    vi.spyOn(service, 'workerItem').mockResolvedValue({ run, item, snapshot: item.snapshot } as never);
    repo.db.effectPackagingFile.count.mockResolvedValue(1);
    expect(await service.content('p', 'run', 'attempt', 'item', 'voice')).toBe('voice-content');
    expect(repo.db.effectPackagingFile.count).toHaveBeenCalledWith({ where: expect.objectContaining({
      projectId: 'p', fileObjectId: 'voice', role: { startsWith: 'voice-' },
    }) });
    repo.db.effectPackagingFile.count.mockResolvedValue(0);
    await expect(service.content('p', 'run', 'attempt', 'item', 'voice')).rejects.toThrow('不属于当前成片');
    await expect(service.content('p', 'run', 'attempt', 'item', 'other')).rejects.toThrow('不属于当前成片');
    expect(working.fileObjectContent).toHaveBeenCalledTimes(1);
  });
  it('creates one caption-only run for every current variant without discarding voices or music', async () => {
    const { service, repo, mix } = harness();
    const variants = ['v1', 'v2'].map((id) => ({ ...v, id, slots: [{ id: 'a', duration: 4 }],
      bindings: { a: 'clip' } })) as unknown as EffectTemplateMixVariant[];
    mix.workspace.mockResolvedValue({ draftRevision: 1, draft: { templates: [{ id: 't',
      workspace: { template: {}, variants } }] } });
    const originals = variants.map((variant) => ({ ...completedItem(), variantId: variant.id,
      sourceTimelineHash: visualHash(variant),
      snapshot: { ...completedItem().snapshot, variant, sourceTimelineHash: visualHash(variant),
        narrationLayoutVersion: 'SLOT_V1' },
      checkpoint: { ...completedItem().checkpoint, narrationLayoutVersion: 'SLOT_V1' },
    }));
    repo.list.mockResolvedValue([{ items: originals }]);
    vi.spyOn(service, 'get').mockResolvedValue({} as PackagingRun);
    const snap = vi.spyOn(packagingDomain, 'packagingSnapshot').mockImplementation((variant) => ({
      ...originals[0]!.snapshot, variant, sourceTimelineHash: visualHash(variant),
    }) as never);
    try {
      await service.create('p', 't', { workflowRunId: 'w', expectedRevision: 1,
        idempotencyKey: 'bulk-captions', component: 'CAPTIONS' });
      const created = repo.create.mock.calls[0]![0];
      expect(created.snapshots).toHaveLength(2);
      expect(created.snapshots.every((entry: { redoCaptionsOnly?: boolean }) => entry.redoCaptionsOnly)).toBe(true);
      expect(created.checkpoints.map((entry: PackagingCheckpoint) => entry.voices)).toEqual(
        originals.map((entry) => entry.checkpoint.voices));
      expect(created.checkpoints.every((entry: PackagingCheckpoint) => !entry.captions)).toBe(true);
      expect(created.checkpoints.map((entry: PackagingCheckpoint) => entry.music)).toEqual(
        originals.map((entry) => entry.checkpoint.music));
    } finally { snap.mockRestore(); }
  });
  it('redo of one slot preserves other text, edited audio, captions and music exactly', async () => {
    const { service, repo, mix } = harness();
    const variant = { ...v, slots: [{ id: 'a', duration: 3 }, { id: 'b', duration: 3 }], bindings: { a: '1', b: '2' } } as unknown as EffectTemplateMixVariant;
    const hash = visualHash(variant);
    const frozen = { ...completedItem().snapshot, variant, sourceTimelineHash: hash, narrationLayoutVersion: 'SLOT_V1' as const };
    const cp: PackagingCheckpoint = {
      narrationLayoutVersion: 'SLOT_V1',
      script: [
        { id: 'a', slotId: 'a', text: '第一句', start: 0, end: 3, factIds: ['f'] },
        { id: 'b', slotId: 'b', text: '第二句', start: 3, end: 6, factIds: ['f'] },
      ],
      voices: { a: { fileObjectId: 'a', start: 0, duration: 2, volume: 1 },
        b: { fileObjectId: 'b', start: 3.2, duration: 1, offset: .2, volume: .5, fadeOut: .2 } },
      captions: [{ id: 'a', text: '第一句', start: 0, end: 2 }, { id: 'b', text: '编辑字幕', start: 3.2, end: 4.2 }],
      music: { fileObjectId: 'bgm', start: 1, duration: 5, volume: .1, offset: 2 },
    };
    mix.workspace.mockResolvedValue({ draftRevision: 1, draft: { templates: [{ id: 't', workspace: { template: {}, variants: [variant] } }] } });
    repo.list.mockResolvedValue([{ items: [{ variantId: 'v', sourceTimelineHash: hash, snapshot: frozen, checkpoint: cp }] }]);
    vi.spyOn(service, 'get').mockResolvedValue({} as PackagingRun);
    const snap = vi.spyOn(packagingDomain, 'packagingSnapshot').mockReturnValue(frozen);
    try {
      await service.create('p', 't', { workflowRunId: 'w', expectedRevision: 1, idempotencyKey: 'k', variantId: 'v', component: 'VOICE', slotId: 'a' });
      const next = repo.create.mock.calls[0]![0];
      expect(next.snapshots[0].redoSlotId).toBe('a');
      expect(next.snapshots[0].voiceProfile).toMatchObject({ id: 'vivi', speaker: 'zh_female_vv_uranus_bigtts' });
      expect(next.checkpoints[0].script).toEqual([cp.script![1]]);
      expect(next.checkpoints[0].voices).toEqual({ b: cp.voices!.b });
      expect(next.checkpoints[0].captions).toEqual([cp.captions![1]]);
      expect(next.checkpoints[0].music).toEqual(cp.music);
    } finally { snap.mockRestore(); }
  });
  it.each(['MUSIC', 'CAPTIONS'] as const)('redo %s preserves the original voice despite the new template choice', async (component) => {
    const { service, repo, mix } = harness();
    const variant = { ...v, slots: [{ id: 'a', duration: 3 }], bindings: { a: '1' } } as unknown as EffectTemplateMixVariant;
    const sourceTimelineHash = visualHash(variant);
    const oldVoice = { id: 'old', name: '旧音色', gender: 'MALE' as const, description: '', version: 'old', speaker: 'old', resourceId: 'seed-tts-2.0' };
    const frozen = { ...completedItem().snapshot, variant, sourceTimelineHash, narrationLayoutVersion: 'SLOT_V1' as const, voiceProfile: oldVoice };
    mix.workspace.mockResolvedValue({ draftRevision: 1, draft: { templates: [{ id: 't', workspace: { template: { voiceProfileId: 'unavailable-new-choice' }, variants: [variant] } }] } });
    const previousCheckpoint: PackagingCheckpoint = {
      narrationLayoutVersion: 'SLOT_V1',
      voices: { a: { fileObjectId: 'voice-a', start: .4, offset: .2, duration: 1.5, volume: .6 } },
      music: { fileObjectId: 'music-a', start: 1, offset: 2, duration: 5, volume: .1 },
      captions: [{ id: 'a', text: '旧字幕', start: .4, end: 1.9 }],
    };
    repo.list.mockResolvedValue([{ items: [{ variantId: 'v', sourceTimelineHash, snapshot: frozen, checkpoint: previousCheckpoint }] }]);
    vi.spyOn(service, 'get').mockResolvedValue({} as PackagingRun);
    const snap = vi.spyOn(packagingDomain, 'packagingSnapshot').mockReturnValue({ ...frozen, voiceProfile: undefined } as never);
    try {
      await service.create('p', 't', { workflowRunId: 'w', expectedRevision: 1, idempotencyKey: 'k', variantId: 'v', component });
      expect(repo.create.mock.calls[0]![0].snapshots[0].voiceProfile).toEqual(oldVoice);
      if (component === 'CAPTIONS') {
        const created = repo.create.mock.calls[0]![0];
        expect(created.snapshots[0].redoCaptionsOnly).toBe(true);
        expect(created.checkpoints[0].voices).toEqual(previousCheckpoint.voices);
        expect(created.checkpoints[0].music).toEqual(previousCheckpoint.music);
        expect(created.checkpoints[0].captions).toBeUndefined();
      }
    } finally { snap.mockRestore(); }
  });
  it('recovers missing entries without retrying an unrelated completed stale entry', async () => {
    const { service, repo } = harness();
    const get = vi.spyOn(service, 'get').mockResolvedValue({ items: [
      { status: 'COMPLETED', stale: true }, { status: 'FAILED', stale: false, checkpoint: { narrationLayoutVersion: 'SLOT_V1' } },
    ] } as PackagingRun);
    await service.retry('p', 'r');
    expect(repo.retry).toHaveBeenCalledWith('p', 'r');
    get.mockResolvedValue({ items: [{ status: 'FAILED', stale: true, checkpoint: { narrationLayoutVersion: 'SLOT_V1' } }] } as PackagingRun);
    await expect(service.retry('p', 'r')).rejects.toThrow('源时间轴');
    expect(repo.retry).toHaveBeenCalledTimes(1);
  });
  it('consumes exactly two confirmed copies', async () => {
    const { service, visual, packaging } = harness();
    expect(await service.outputInputs('p', 'w', 't', 'v')).toEqual({ visual, packaging });
  });
  it('refuses changed visual revisions and stale packaging', async () => {
    const { service, visual, packaging } = harness();
    visual.revision++;
    await expect(service.outputInputs('p', 'w', 't', 'v')).rejects.toThrow('过期');
    visual.revision--;
    packaging.freshness = 'STALE';
    await expect(service.outputInputs('p', 'w', 't', 'v')).rejects.toThrow('过期');
  });
  it('refuses unsaved visual edits before downstream encoding', async () => {
    const { service, mix } = harness();
    mix.workspace.mockResolvedValue({
      draft: { templates: [{ id: 't', workspace: { variants: [{ ...v, offsets: { s: 1 } }] } }] },
    });
    await expect(service.outputInputs('p', 'w', 't', 'v')).rejects.toThrow();
  });
  it('isolates task lookups by project and does not return another project run', async () => {
    const { service, repo } = harness();
    repo.get.mockResolvedValue(null);
    await expect(service.get('other-project', 'run')).rejects.toThrow('不存在');
    expect(repo.get).toHaveBeenCalledWith('other-project', 'run');
  });
  it('does not create a packaging task for empty films', async () => {
    const { service } = harness();
    await expect(
      service.create('p', 't', { workflowRunId: 'w', expectedRevision: 1, idempotencyKey: 'key' }),
    ).rejects.toThrow('完整成片');
  });
  it('persists editor audio geometry while keeping file identity server-owned', async () => {
    const { service, repo } = harness();
    const item = completedItem();
    repo.get.mockResolvedValue({ ...completedRun(), items: [item] });
    const saved = completedItem();
    saved.updatedAt = new Date('2026-01-01T00:00:01.000Z');
    repo.updateCheckpoint.mockResolvedValue(saved);
    const result = await service.updateAudio('p', 'run', 'item', {
      expectedUpdatedAt: '2026-01-01T00:00:00.000Z',
      voices: {
        'line-1': {
          start: 5,
          offset: 0.2,
          duration: 2.2,
          volume: 0.4,
          fileObjectId: 'forged',
        } as never,
      },
      music: { start: 1, offset: 0.5, duration: 6, volume: 0.2 },
    });
    expect(repo.updateCheckpoint).toHaveBeenCalledWith(
      'p',
      'item',
      {
        ...item.checkpoint,
        voices: {
          'line-1': { fileObjectId: 'voice', start: 5, duration: 2.2, volume: 0.4, offset: 0.2 },
        },
        music: { fileObjectId: 'music', start: 1, duration: 6, volume: 0.2, offset: 0.5 },
      },
      '2026-01-01T00:00:00.000Z',
    );
    expect(result.id).toBe('item');
    expect(result.updatedAt).toBe('2026-01-01T00:00:01.000Z');
  });
  it('stores editor fades and never invents a 0 where the client sent none', async () => {
    const { service, repo } = harness();
    const item = completedItem();
    // The music bed already carries an editor fade; the narration does not.
    item.checkpoint.music = { fileObjectId: 'music', start: 0, duration: 10, volume: 0.12, fadeIn: 0.3 };
    repo.get.mockResolvedValue({ ...completedRun(), items: [item] });
    repo.updateCheckpoint.mockResolvedValue(completedItem());
    await service.updateAudio('p', 'run', 'item', {
      expectedUpdatedAt: '2026-01-01T00:00:00.000Z',
      voices: {
        'line-1': { start: 0, offset: 0, duration: 2.4, volume: 0.8, fadeIn: 0.4, fadeOut: 0.6 },
      },
      music: { start: 0, offset: 0, duration: 10, volume: 0.12 },
    });
    const [, , written] = repo.updateCheckpoint.mock.calls[0]!;
    expect(written.voices['line-1']).toEqual({
      fileObjectId: 'voice',
      start: 0,
      duration: 2.4,
      volume: 0.8,
      offset: 0,
      fadeIn: 0.4,
      fadeOut: 0.6,
    });
    // Absent stays absent, so the worker keeps applying its own default easing.
    expect(written.music).not.toHaveProperty('fadeOut');
    // A stored fade survives an edit that does not mention it.
    expect(written.music.fadeIn).toBe(0.3);
  });
  it('rejects fades longer than the clip and writes nothing', async () => {
    const { service, repo } = harness();
    repo.get.mockResolvedValue(completedRun());
    await expect(
      service.updateAudio('p', 'run', 'item', {
        expectedUpdatedAt: '2026-01-01T00:00:00.000Z',
        voices: {
          'line-1': { start: 0, offset: 0, duration: 2.4, volume: 1, fadeIn: 1.5, fadeOut: 1.5 },
        },
      }),
    ).rejects.toThrow('淡入淡出时长超出音频长度');
    expect(repo.updateCheckpoint).not.toHaveBeenCalled();
  });
  it('rejects trims that would invent audio the source never had', async () => {
    const { service, repo } = harness();
    repo.get.mockResolvedValue(completedRun());
    await expect(
      service.updateAudio('p', 'run', 'item', {
        expectedUpdatedAt: '2026-01-01T00:00:00.000Z',
        voices: { 'line-1': { start: 0, offset: 0.5, duration: 2.4, volume: 1 } },
      }),
    ).rejects.toThrow('超出真实音频长度');
    expect(repo.updateCheckpoint).not.toHaveBeenCalled();
  });
  it('sorts a caption replacement and rejects unknown audio ids', async () => {
    const { service, repo } = harness();
    repo.get.mockResolvedValue(completedRun());
    const saved = completedItem();
    saved.checkpoint.captions = [{ id: 'line-1', text: '商品', start: 1, end: 3.4 }];
    repo.updateCheckpoint.mockResolvedValue(saved);
    await service.updateAudio('p', 'run', 'item', {
      expectedUpdatedAt: '2026-01-01T00:00:00.000Z',
      captions: [{ id: 'line-1', text: '商品', start: 1, end: 3.4 }],
    });
    expect(repo.updateCheckpoint).toHaveBeenCalledWith(
      'p',
      'item',
      expect.objectContaining({ captions: [{ id: 'line-1', text: '商品', start: 1, end: 3.4 }] }),
      '2026-01-01T00:00:00.000Z',
    );
    await expect(
      service.updateAudio('p', 'run', 'item', {
        expectedUpdatedAt: '2026-01-01T00:00:00.000Z',
        voices: { ghost: { start: 1, volume: 0.5 } },
      }),
    ).rejects.toThrow('口播音频不存在');
  });
  it('persists a reworded subtitle without touching the narration it is voiced from', async () => {
    const { service, repo } = harness();
    const item = completedItem();
    repo.get.mockResolvedValue({ ...completedRun(), items: [item] });
    const saved = completedItem();
    saved.checkpoint.captions = [{ id: 'line-1', text: '限时五折', start: 0, end: 2.4 }];
    repo.updateCheckpoint.mockResolvedValue(saved);
    await service.updateAudio('p', 'run', 'item', {
      expectedUpdatedAt: '2026-01-01T00:00:00.000Z',
      captions: [{ id: 'line-1', text: '限时五折', start: 0, end: 2.4 }],
    });
    const [, , written] = repo.updateCheckpoint.mock.calls[0]!;
    expect(written.captions).toEqual([{ id: 'line-1', text: '限时五折', start: 0, end: 2.4 }]);
    // The spoken line keeps the text it was synthesized from.
    expect(written.script[0].text).toBe('商品');
    expect(written.voices['line-1'].fileObjectId).toBe('voice');
  });
  it('merges editor caption geometry and strips anything the client should not own', async () => {
    const { service, repo } = harness();
    const item = completedItem();
    item.checkpoint.captions = [{ id: 'line-1', text: '商品', start: 0, end: 2.4 }];
    item.checkpoint.captionBoxes = { 'line-1': { x: 0.5, y: 0.08, width: 0.9, scale: 1 } };
    repo.get.mockResolvedValue({ ...completedRun(), items: [item] });
    const saved = completedItem();
    saved.checkpoint.captions = item.checkpoint.captions;
    saved.checkpoint.captionBoxes = { 'line-1': { x: 0.25, y: 0.4, width: 0.6, scale: 1.5 } };
    repo.updateCheckpoint.mockResolvedValue(saved);
    await service.updateAudio('p', 'run', 'item', {
      expectedUpdatedAt: '2026-01-01T00:00:00.000Z',
      boxes: { 'line-1': { x: 0.25, y: 0.4, width: 0.6, scale: 1.5 } },
    });
    const [, , written] = repo.updateCheckpoint.mock.calls[0]!;
    expect(written.captionBoxes).toEqual({
      'line-1': { x: 0.25, y: 0.4, width: 0.6, scale: 1.5 },
    });
    // Captions themselves are untouched by a geometry-only edit.
    expect(written.captions).toEqual([{ id: 'line-1', text: '商品', start: 0, end: 2.4 }]);
  });
  it('rejects caption geometry for a caption that does not exist', async () => {
    const { service, repo } = harness();
    repo.get.mockResolvedValue(completedRun());
    await expect(
      service.updateAudio('p', 'run', 'item', {
        expectedUpdatedAt: '2026-01-01T00:00:00.000Z',
        boxes: { ghost: { x: 0.5, y: 0.5, width: 0.5, scale: 1 } },
      }),
    ).rejects.toThrow('字幕不存在');
    expect(repo.updateCheckpoint).not.toHaveBeenCalled();
  });
  it('refuses to edit unfinished or stale packaging', async () => {
    const { service, repo } = harness();
    const running = completedItem();
    running.status = 'RUNNING';
    repo.get.mockResolvedValue({ ...completedRun(), items: [running] });
    await expect(
      service.updateAudio('p', 'run', 'item', { expectedUpdatedAt: '2026-01-01T00:00:00.000Z' }),
    ).rejects.toThrow('尚未完成');
    const changed = completedItem();
    changed.sourceTimelineHash = 'changed';
    repo.get.mockResolvedValue({ ...completedRun(), items: [changed] });
    await expect(
      service.updateAudio('p', 'run', 'item', { expectedUpdatedAt: '2026-01-01T00:00:00.000Z' }),
    ).rejects.toThrow('源时间轴');
    expect(repo.updateCheckpoint).not.toHaveBeenCalled();
  });
  it('surfaces optimistic-lock conflicts instead of retrying the write', async () => {
    const { service, repo } = harness();
    repo.get.mockResolvedValue(completedRun());
    repo.updateCheckpoint.mockRejectedValue(new ConflictException('包装结果已被修改，请刷新'));
    await expect(
      service.updateAudio('p', 'run', 'item', {
        expectedUpdatedAt: '2026-01-01T00:00:00.000Z',
        music: { start: 1, duration: 6, volume: 0.2 },
      }),
    ).rejects.toThrow('已被修改');
    expect(repo.updateCheckpoint).toHaveBeenCalledTimes(1);
  });
});
