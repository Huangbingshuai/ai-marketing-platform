import { ConflictException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type {
  EffectTemplateMixVariant,
  EffectVoiceSelection,
  PackagingCheckpoint,
  PackagingRun,
  PackagingSnapshot,
} from '@ai-marketing/contracts';
import type { StoragePort } from '../../../platform/file/storage.port';
import type { WorkflowWorkingService } from '../../../platform/workflow/workflow-working.service';
import type { EffectTemplateMixService } from './effect-template-mix.service';
import type { EffectPackagingRepository } from './effect-packaging.repository';
import { EffectPackagingService, parseVoiceSegmentFrames } from './effect-packaging.service';
import { visualHash } from './effect-packaging.domain';
import * as packagingDomain from './effect-packaging.domain';

/** One second of 24 kHz 16-bit mono PCM, the only shape the packaging writer accepts. */
function pcmWav(seconds: number): Buffer {
  const data = Buffer.alloc(48_000 * seconds);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24_000, 24);
  header.writeUInt32LE(48_000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const v = {
  id: 'v',
  slots: [],
  bindings: {},
  bindingRevisions: {},
  offsets: {},
} as unknown as EffectTemplateMixVariant;
describe('voice segment upload boundaries', () => {
  it('accepts only sample counts that exactly cover the uploaded WAV', () => {
    expect(parseVoiceSegmentFrames('[24000,48000]', 3)).toEqual([24000, 48000]);
    expect(parseVoiceSegmentFrames(undefined, 3)).toBeUndefined();
    for (const value of [
      '[24000,24000]',
      '[0,72000]',
      '[1.5,71998.5]',
      '["24000",48000]',
      '{}',
      'broken',
    ]) {
      expect(() => parseVoiceSegmentFrames(value, 3)).toThrow('边界与音频不一致');
    }
  });
});
/** `templateVoiceProfileId` is what the template currently has picked; omitted means none. */
function harness(templateVoiceProfileId?: string) {
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
    payload: {
      narrationLayoutVersion: 'SLOT_V1',
      sourceTimelineHash: visualHash(v),
      visualArtifactId: 'visual',
      visualRevision: 2,
    },
  };
  const mix = {
    workspace: vi.fn().mockResolvedValue({
      draftRevision: 1,
      draft: {
        templates: [
          {
            id: 't',
            workspace: {
              template: {
                name: '模板',
                editVersion: 1,
                slots: [],
                ...(templateVoiceProfileId ? { voiceProfileId: templateVoiceProfileId } : {}),
              },
              variants: [v],
            },
          },
        ],
      },
    }),
  };
  const working = {
    listArtifacts: vi.fn().mockResolvedValue({ items: [visual, packaging] }),
    fileObjectContent: vi.fn().mockResolvedValue('voice-content'),
  };
  // The caption-narration write-back is a transaction of its own; the mocks below let a test drive
  // it without a database, and `tx` is exposed so the assertions can read what it wrote.
  const tx = {
    fileObject: { create: vi.fn().mockResolvedValue({ id: 'caption-file' }) },
    effectPackagingFile: { upsert: vi.fn().mockResolvedValue({}) },
    effectPackagingItem: {
      findUniqueOrThrow: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
    },
  };
  const repo = {
    get: vi.fn(),
    retry: vi.fn().mockResolvedValue({ status: 'QUEUED' }),
    updateCheckpoint: vi.fn(),
    list: vi.fn().mockResolvedValue([]),
    create: vi.fn().mockResolvedValue('new-run'),
    enqueueCaptionVoice: vi.fn().mockResolvedValue({ id: 'outbox' }),
    db: {
      effectPackagingRun: { findUnique: vi.fn().mockResolvedValue(null) },
      effectPackagingFile: {
        count: vi.fn().mockResolvedValue(0),
        findUnique: vi.fn().mockResolvedValue(null),
      },
      effectVoicePreview: { findFirst: vi.fn().mockResolvedValue(null) },
      project: { findUniqueOrThrow: vi.fn().mockResolvedValue({ id: 'p', name: '项目' }) },
      $transaction: vi.fn((run: (client: typeof tx) => unknown) => run(tx)),
    },
  };
  const storage = {
    put: vi.fn().mockResolvedValue({ key: 'stored-key' }),
    delete: vi.fn().mockResolvedValue(undefined),
  };
  const service = new EffectPackagingService(
    repo as unknown as EffectPackagingRepository,
    mix as unknown as EffectTemplateMixService,
    working as unknown as WorkflowWorkingService,
    storage as unknown as StoragePort,
  );
  return { service, mix, working, repo, storage, tx, visual, packaging };
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
  it('refuses packaging until a template change has been refilled', async () => {
    const { service, repo, mix } = harness();
    mix.workspace.mockResolvedValue({
      draftRevision: 1,
      draft: {
        templates: [
          {
            id: 't',
            needsAiFill: true,
            workspace: {
              template: { name: '模板', editVersion: 2, slots: [] },
              variants: [v],
            },
          },
        ],
      },
    } as never);
    await expect(
      service.create('p', 't', {
        workflowRunId: 'w',
        expectedRevision: 1,
        idempotencyKey: 'must-refill',
      }),
    ).rejects.toThrow('未按当前模板重新智能填充');
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('projects frozen clip and confirmed-fact examples without exposing file identifiers or raw prompts', async () => {
    const { service, repo, mix } = harness();
    const timelineVariant = {
      ...v,
      slots: [
        {
          id: 'slot-product',
          label: '产品展示',
          role: 'PRODUCT',
          purpose: 'PRODUCT',
          duration: 8,
          transition: '叠化',
          transitionDuration: 0.5,
        },
      ],
      bindings: { 'slot-product': 'material-1' },
      bindingRevisions: { 'slot-product': 3 },
      offsets: { 'slot-product': 1.25 },
      timelineStarts: { 'slot-product': 2 },
    } as unknown as EffectTemplateMixVariant;
    const sourceTimelineHash = visualHash(timelineVariant);
    const clip = {
      slotId: 'slot-product',
      materialId: 'material-1',
      fileObjectId: 'secret-file-id',
      contentHash: 'hash',
      start: 2,
      duration: 8,
      offset: 1.25,
      lane: 0,
      prompt: '不应透出的完整 Prompt 正文',
      transition: '叠化',
      transitionDuration: 0.5,
      originalAudioDetached: true,
    };
    mix.workspace.mockResolvedValue({
      draftRevision: 1,
      draft: { templates: [{ id: 't', workspace: { variants: [timelineVariant] } }] },
      materials: [{ id: 'material-1', code: 'R-06', name: '腊肠煎制' }],
    });
    repo.get.mockResolvedValue({
      id: 'run',
      workflowRunId: 'w',
      templateId: 't',
      status: 'COMPLETED',
      createdAt: new Date('2026-09-23T04:00:00.000Z'),
      startedAt: null,
      completedAt: null,
      items: [
        {
          id: 'item',
          variantId: 'v',
          name: '成片 01',
          shardIndex: 0,
          sourceTimelineHash,
          snapshot: {
            sourceTimelineHash,
            duration: 10,
            variant: timelineVariant,
            clips: [clip],
            facts: [
              {
                id: 'fact-1',
                text: '广式腊肠采用传统风干工艺',
                artifactId: 'artifact',
                revision: 2,
              },
            ],
            dependencies: [],
          },
          checkpoint: {
            narrationLayoutVersion: 'SLOT_V1',
            script: [
              {
                id: 'line-1',
                slotId: 'slot-product',
                text: '依据商品事实组织的文案',
                start: 2,
                end: 10,
                factIds: ['fact-1'],
              },
            ],
          },
          status: 'COMPLETED',
          stage: 'READY',
          errorMessage: null,
          startedAt: null,
          completedAt: null,
          updatedAt: new Date('2026-09-23T04:00:00.000Z'),
        },
      ],
    } as never);

    const result = await service.get('project', 'run');
    expect(result.items[0]?.sourceClips).toEqual([
      {
        slotLabel: '产品展示',
        materialName: 'R-06 · 腊肠煎制',
        sourceOffset: 1.25,
        timelineStart: 2,
        duration: 8,
        transition: '叠化',
        transitionDuration: 0.5,
        originalAudioDetached: true,
      },
    ]);
    expect(result.items[0]?.sourceFacts).toEqual([
      { id: 'fact-1', text: '广式腊肠采用传统风干工艺' },
    ]);
    expect(JSON.stringify(result.items[0]?.sourceClips)).not.toContain('secret-file-id');
    expect(JSON.stringify(result.items[0])).not.toContain('完整 Prompt 正文');
  });

  it('allows only the current item’s archived voice for subtitle-only redo', async () => {
    const { service, repo, working } = harness();
    const run = completedRun(),
      item = run.items[0]!;
    vi.spyOn(service, 'workerItem').mockResolvedValue({
      run,
      item,
      snapshot: item.snapshot,
    } as never);
    repo.db.effectPackagingFile.count.mockResolvedValue(1);
    expect(await service.content('p', 'run', 'attempt', 'item', 'voice')).toBe('voice-content');
    expect(repo.db.effectPackagingFile.count).toHaveBeenCalledWith({
      where: expect.objectContaining({
        projectId: 'p',
        fileObjectId: 'voice',
        // A caption narration the editor generated is fetched by the same route, so both roles are
        // accepted here; the file still has to belong to this exact item.
        OR: [
          { role: { startsWith: 'voice-' } },
          { role: { startsWith: 'caption-voice-' } },
        ],
      }),
    });
    repo.db.effectPackagingFile.count.mockResolvedValue(0);
    await expect(service.content('p', 'run', 'attempt', 'item', 'voice')).rejects.toThrow(
      '不属于当前成片',
    );
    await expect(service.content('p', 'run', 'attempt', 'item', 'other')).rejects.toThrow(
      '不属于当前成片',
    );
    expect(working.fileObjectContent).toHaveBeenCalledTimes(1);
  });
  it('creates one caption-only run for every current variant without discarding voices or music', async () => {
    const { service, repo, mix } = harness();
    const variants = ['v1', 'v2'].map((id) => ({
      ...v,
      id,
      slots: [{ id: 'a', duration: 4 }],
      bindings: { a: 'clip' },
    })) as unknown as EffectTemplateMixVariant[];
    mix.workspace.mockResolvedValue({
      draftRevision: 1,
      draft: {
        templates: [
          {
            id: 't',
            workspace: { template: { name: '模板', editVersion: 1, slots: [] }, variants },
          },
        ],
      },
    });
    const originals = variants.map((variant) => ({
      ...completedItem(),
      variantId: variant.id,
      sourceTimelineHash: visualHash(variant),
      snapshot: {
        ...completedItem().snapshot,
        variant,
        sourceTimelineHash: visualHash(variant),
        narrationLayoutVersion: 'SLOT_V1',
      },
      checkpoint: { ...completedItem().checkpoint, narrationLayoutVersion: 'SLOT_V1' },
    }));
    repo.list.mockResolvedValue([{ items: originals }]);
    vi.spyOn(service, 'get').mockResolvedValue({} as PackagingRun);
    const snap = vi.spyOn(packagingDomain, 'packagingSnapshot').mockImplementation(
      (variant) =>
        ({
          ...originals[0]!.snapshot,
          variant,
          sourceTimelineHash: visualHash(variant),
        }) as never,
    );
    try {
      await service.create('p', 't', {
        workflowRunId: 'w',
        expectedRevision: 1,
        idempotencyKey: 'bulk-captions',
        component: 'CAPTIONS',
      });
      const created = repo.create.mock.calls[0]![0];
      expect(created.snapshots).toHaveLength(2);
      expect(
        created.snapshots.every((entry: { redoCaptionsOnly?: boolean }) => entry.redoCaptionsOnly),
      ).toBe(true);
      expect(created.checkpoints.map((entry: PackagingCheckpoint) => entry.voices)).toEqual(
        originals.map((entry) => entry.checkpoint.voices),
      );
      expect(created.checkpoints.every((entry: PackagingCheckpoint) => !entry.captions)).toBe(true);
      expect(created.checkpoints.map((entry: PackagingCheckpoint) => entry.music)).toEqual(
        originals.map((entry) => entry.checkpoint.music),
      );
    } finally {
      snap.mockRestore();
    }
  });
  it('redo of one slot preserves other text, edited audio, captions and music exactly', async () => {
    const { service, repo, mix } = harness();
    const variant = {
      ...v,
      slots: [
        { id: 'a', duration: 3 },
        { id: 'b', duration: 3 },
      ],
      bindings: { a: '1', b: '2' },
    } as unknown as EffectTemplateMixVariant;
    const hash = visualHash(variant);
    const frozen = {
      ...completedItem().snapshot,
      variant,
      sourceTimelineHash: hash,
      narrationLayoutVersion: 'SLOT_V1' as const,
    };
    const cp: PackagingCheckpoint = {
      narrationLayoutVersion: 'SLOT_V1',
      script: [
        { id: 'a', slotId: 'a', text: '第一句', start: 0, end: 3, factIds: ['f'] },
        { id: 'b', slotId: 'b', text: '第二句', start: 3, end: 6, factIds: ['f'] },
      ],
      voices: {
        a: { fileObjectId: 'a', start: 0, duration: 2, volume: 1 },
        b: { fileObjectId: 'b', start: 3.2, duration: 1, offset: 0.2, volume: 0.5, fadeOut: 0.2 },
      },
      captions: [
        { id: 'a', text: '第一句', start: 0, end: 2 },
        { id: 'b', text: '编辑字幕', start: 3.2, end: 4.2 },
      ],
      music: { fileObjectId: 'bgm', start: 1, duration: 5, volume: 0.1, offset: 2 },
      voiceSlotRetries: { a: 1, b: 1 },
    };
    mix.workspace.mockResolvedValue({
      draftRevision: 1,
      draft: {
        templates: [
          {
            id: 't',
            workspace: {
              template: { name: '模板', editVersion: 1, slots: [] },
              variants: [variant],
            },
          },
        ],
      },
    });
    repo.list.mockResolvedValue([
      { items: [{ variantId: 'v', sourceTimelineHash: hash, snapshot: frozen, checkpoint: cp }] },
    ]);
    vi.spyOn(service, 'get').mockResolvedValue({} as PackagingRun);
    const snap = vi.spyOn(packagingDomain, 'packagingSnapshot').mockReturnValue(frozen);
    try {
      await service.create('p', 't', {
        workflowRunId: 'w',
        expectedRevision: 1,
        idempotencyKey: 'k',
        variantId: 'v',
        component: 'VOICE',
        slotId: 'a',
      });
      const next = repo.create.mock.calls[0]![0];
      expect(next.snapshots[0].redoSlotId).toBe('a');
      expect(next.snapshots[0].voiceProfile).toMatchObject({
        id: 'vivi',
        speaker: 'zh_female_vv_uranus_bigtts',
      });
      expect(next.checkpoints[0].script).toEqual([cp.script![1]]);
      expect(next.checkpoints[0].voices).toEqual({ b: cp.voices!.b });
      expect(next.checkpoints[0].captions).toEqual([cp.captions![1]]);
      expect(next.checkpoints[0].music).toEqual(cp.music);
      expect(next.checkpoints[0].voiceSlotRetries).toEqual({ b: 1 });
    } finally {
      snap.mockRestore();
    }
  });
  it.each(['MUSIC', 'CAPTIONS'] as const)(
    'redo %s preserves the original voice despite the new template choice',
    async (component) => {
      const { service, repo, mix } = harness();
      const variant = {
        ...v,
        slots: [{ id: 'a', duration: 3 }],
        bindings: { a: '1' },
      } as unknown as EffectTemplateMixVariant;
      const sourceTimelineHash = visualHash(variant);
      const oldVoice = {
        id: 'old',
        name: '旧音色',
        gender: 'MALE' as const,
        description: '',
        version: 'old',
        speaker: 'old',
        resourceId: 'seed-tts-2.0',
      };
      const frozen = {
        ...completedItem().snapshot,
        variant,
        sourceTimelineHash,
        narrationLayoutVersion: 'SLOT_V1' as const,
        voiceProfile: oldVoice,
      };
      mix.workspace.mockResolvedValue({
        draftRevision: 1,
        draft: {
          templates: [
            {
              id: 't',
              workspace: {
                template: {
                  name: '模板',
                  editVersion: 1,
                  slots: [],
                  voiceProfileId: 'unavailable-new-choice',
                },
                variants: [variant],
              },
            },
          ],
        },
      });
      const previousCheckpoint: PackagingCheckpoint = {
        narrationLayoutVersion: 'SLOT_V1',
        voices: {
          a: { fileObjectId: 'voice-a', start: 0.4, offset: 0.2, duration: 1.5, volume: 0.6 },
        },
        music: { fileObjectId: 'music-a', start: 1, offset: 2, duration: 5, volume: 0.1 },
        captions: [{ id: 'a', text: '旧字幕', start: 0.4, end: 1.9 }],
      };
      repo.list.mockResolvedValue([
        {
          items: [
            {
              variantId: 'v',
              sourceTimelineHash,
              snapshot: frozen,
              checkpoint: previousCheckpoint,
            },
          ],
        },
      ]);
      vi.spyOn(service, 'get').mockResolvedValue({} as PackagingRun);
      const snap = vi
        .spyOn(packagingDomain, 'packagingSnapshot')
        .mockReturnValue({ ...frozen, voiceProfile: undefined } as never);
      try {
        await service.create('p', 't', {
          workflowRunId: 'w',
          expectedRevision: 1,
          idempotencyKey: 'k',
          variantId: 'v',
          component,
        });
        expect(repo.create.mock.calls[0]![0].snapshots[0].voiceProfile).toEqual(oldVoice);
        if (component === 'CAPTIONS') {
          const created = repo.create.mock.calls[0]![0];
          expect(created.snapshots[0].redoCaptionsOnly).toBe(true);
          expect(created.checkpoints[0].voices).toEqual(previousCheckpoint.voices);
          expect(created.checkpoints[0].music).toEqual(previousCheckpoint.music);
          expect(created.checkpoints[0].captions).toBeUndefined();
        }
      } finally {
        snap.mockRestore();
      }
    },
  );
  it('recovers missing entries without retrying an unrelated completed stale entry', async () => {
    const { service, repo } = harness();
    const get = vi.spyOn(service, 'get').mockResolvedValue({
      items: [
        { status: 'COMPLETED', stale: true },
        { status: 'FAILED', stale: false, checkpoint: { narrationLayoutVersion: 'SLOT_V1' } },
      ],
    } as PackagingRun);
    await service.retry('p', 'r');
    expect(repo.retry).toHaveBeenCalledWith('p', 'r');
    get.mockResolvedValue({
      items: [{ status: 'FAILED', stale: true, checkpoint: { narrationLayoutVersion: 'SLOT_V1' } }],
    } as PackagingRun);
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
    // The frozen hash is taken over the narrated clips, so a draft that has gained one is an edit the
    // user has not saved into a package yet. (The `v` fixture has no clips, so nothing less than a
    // whole slot can tell the two apart.)
    mix.workspace.mockResolvedValue({
      draft: {
        templates: [
          {
            id: 't',
            workspace: {
              variants: [
                {
                  ...v,
                  slots: [{ id: 's', label: '产品', role: 'PRODUCT', duration: 10, transition: '硬切' }],
                  bindings: { s: 'clip' },
                  bindingRevisions: { s: 1 },
                  offsets: { s: 0 },
                },
              ],
            },
          },
        ],
      },
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
    item.checkpoint.music = {
      fileObjectId: 'music',
      start: 0,
      duration: 10,
      volume: 0.12,
      fadeIn: 0.3,
    };
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
  it('persists a blank editor-created subtitle as narration-independent', async () => {
    const { service, repo } = harness();
    const item = completedItem();
    repo.get.mockResolvedValue({ ...completedRun(), items: [item] });
    repo.updateCheckpoint.mockResolvedValue(item);
    await service.updateAudio('p', 'run', 'item', {
      expectedUpdatedAt: '2026-01-01T00:00:00.000Z',
      captions: [
        { id: 'line-1', text: '商品', start: 0, end: 2.4 },
        {
          id: 'manual-caption',
          manual: true,
          trackId: 'subtitle-track-0000000000001-test',
          text: '',
          start: 0,
          end: 3,
        },
      ],
    });
    const [, , written] = repo.updateCheckpoint.mock.calls[0]!;
    expect(written.captions).toEqual([
      { id: 'line-1', text: '商品', start: 0, end: 2.4 },
      {
        id: 'manual-caption',
        manual: true,
        trackId: 'subtitle-track-0000000000001-test',
        text: '',
        start: 0,
        end: 3,
      },
    ]);
  });
  it('deletes a narration by key and keeps the script line and its subtitle', async () => {
    const { service, repo } = harness();
    const item = completedItem();
    item.checkpoint.script = [
      { id: 'line-1', text: '商品', start: 0, end: 4, factIds: ['f'] },
      { id: 'line-2', text: '原料', start: 4, end: 8, factIds: ['f'] },
    ];
    item.checkpoint.voices = {
      'line-1': { fileObjectId: 'voice-1', start: 0, duration: 2.4, volume: 1 },
      'line-2': { fileObjectId: 'voice-2', start: 4, duration: 2.4, volume: 1 },
    };
    item.checkpoint.captions = [
      { id: 'line-1', text: '商品', start: 0, end: 2.4 },
      { id: 'line-2', text: '原料', start: 4, end: 6.4 },
    ];
    repo.get.mockResolvedValue({ ...completedRun(), items: [item] });
    repo.updateCheckpoint.mockResolvedValue(completedItem());
    await service.updateAudio('p', 'run', 'item', {
      expectedUpdatedAt: '2026-01-01T00:00:00.000Z',
      removedVoices: ['line-1'],
    });
    const [, , written] = repo.updateCheckpoint.mock.calls[0]!;
    // A narration is an optional overlay on its line, so only the audio goes: the line that carries
    // the subtitle's text stays, the subtitle stays, and the film keeps its length.
    expect(Object.keys(written.voices!)).toEqual(['line-2']);
    expect(written.script).toEqual(item.checkpoint.script);
    expect(written.captions).toEqual(item.checkpoint.captions);
  });
  it('ignores a narration id it does not know instead of refusing the delete', async () => {
    const { service, repo } = harness();
    repo.get.mockResolvedValue(completedRun());
    repo.updateCheckpoint.mockResolvedValue(completedItem());
    // A delete racing a redo is normal: the clip the editor is deleting may already be gone.
    await service.updateAudio('p', 'run', 'item', {
      expectedUpdatedAt: '2026-01-01T00:00:00.000Z',
      removedVoices: ['ghost'],
    });
    const [, , written] = repo.updateCheckpoint.mock.calls[0]!;
    expect(written.voices).toEqual(completedItem().checkpoint.voices);
  });
  it('lets an edit win when one request both deletes and moves the same narration', async () => {
    const { service, repo } = harness();
    repo.get.mockResolvedValue(completedRun());
    repo.updateCheckpoint.mockResolvedValue(completedItem());
    await service.updateAudio('p', 'run', 'item', {
      expectedUpdatedAt: '2026-01-01T00:00:00.000Z',
      removedVoices: ['line-1'],
      voices: { 'line-1': { start: 1, offset: 0, duration: 2.4, volume: 0.5 } },
    });
    const [, , written] = repo.updateCheckpoint.mock.calls[0]!;
    // An edit and a delete are the same field, so the edit wins rather than the id vanishing.
    expect(written.voices!['line-1']).toEqual({
      fileObjectId: 'voice',
      start: 1,
      duration: 2.4,
      volume: 0.5,
      offset: 0,
    });
  });
  it('deletes a caption narration by key and leaves the other one alone', async () => {
    const { service, repo } = harness();
    const item = completedItem();
    item.checkpoint.captionVoices = {
      'caption-1': { fileObjectId: 'caption-file-1', start: 0, duration: 2, volume: 1 },
      'caption-2': { fileObjectId: 'caption-file-2', start: 3, duration: 2, volume: 1 },
    };
    repo.get.mockResolvedValue({ ...completedRun(), items: [item] });
    repo.updateCheckpoint.mockResolvedValue(completedItem());
    await service.updateAudio('p', 'run', 'item', {
      expectedUpdatedAt: '2026-01-01T00:00:00.000Z',
      removedCaptionVoices: ['caption-1'],
    });
    const [, , written] = repo.updateCheckpoint.mock.calls[0]!;
    // The caption narration hangs off nothing but its own key, so deleting it is just the key going.
    expect(Object.keys(written.captionVoices!)).toEqual(['caption-2']);
    expect(written.captionVoices!['caption-2']).toEqual({
      fileObjectId: 'caption-file-2',
      start: 3,
      duration: 2,
      volume: 1,
    });
  });
  it('deletes the music bed on request and keeps it when the edit says nothing', async () => {
    const { service, repo } = harness();
    repo.get.mockResolvedValue(completedRun());
    repo.updateCheckpoint.mockResolvedValue(completedItem());
    await service.updateAudio('p', 'run', 'item', {
      expectedUpdatedAt: '2026-01-01T00:00:00.000Z',
      removeMusic: true,
    });
    const [, , removed] = repo.updateCheckpoint.mock.calls[0]!;
    // `next` starts as a copy of the stored checkpoint, so a delete has to take the bed off it.
    expect(removed).not.toHaveProperty('music');
    // A checkpoint with no bed is still renderable: the renderer mixes a voice-only track.
    await service.updateAudio('p', 'run', 'item', {
      expectedUpdatedAt: '2026-01-01T00:00:00.000Z',
      voices: { 'line-1': { start: 1, offset: 0, duration: 2.4, volume: 0.5 } },
    });
    const [, , kept] = repo.updateCheckpoint.mock.calls[1]!;
    expect(kept.music.fileObjectId).toBe('music');
  });
  it('gives a narration card the row the client sends and never drops one it already has', async () => {
    const { service, repo } = harness();
    repo.get.mockResolvedValue(completedRun());
    repo.updateCheckpoint.mockResolvedValue(completedItem());
    await service.updateAudio('p', 'run', 'item', {
      expectedUpdatedAt: '2026-01-01T00:00:00.000Z',
      captions: [{ id: 'line-1', text: '商品', start: 0, end: 2.4, trackId: 'subtitle-track-2' }],
    });
    const [, , minted] = repo.updateCheckpoint.mock.calls[0]!;
    // A row of its own is editor geometry, so a narration card may carry one just as a title may.
    expect(minted.captions![0]!.trackId).toBe('subtitle-track-2');
    expect(minted.captions![0]!.manual).toBeUndefined();

    const stored = completedItem();
    stored.checkpoint.captions = [
      { id: 'line-1', text: '商品', start: 0, end: 2.4, trackId: 'subtitle-track-1' },
    ];
    repo.get.mockResolvedValue({ ...completedRun(), items: [stored] });
    await service.updateAudio('p', 'run', 'item', {
      expectedUpdatedAt: '2026-01-01T00:00:00.000Z',
      captions: [{ id: 'line-1', text: '商品改', start: 0, end: 2.4 }],
    });
    const [, , retained] = repo.updateCheckpoint.mock.calls[1]!;
    // A card can never silently lose the row it was pulled onto.
    expect(retained.captions![0]).toEqual({
      id: 'line-1',
      trackId: 'subtitle-track-1',
      text: '商品改',
      start: 0,
      end: 2.4,
    });
  });
  it('preserves server-owned segmented-caption lineage when only caption timing is edited', async () => {
    const { service, repo } = harness();
    const validate = vi
      .spyOn(packagingDomain, 'validatePackagingCheckpoint')
      .mockImplementation(() => undefined);
    const item = completedItem();
    item.checkpoint.captionLayoutVersion = 'SEGMENT_V1';
    item.checkpoint.captions = [
      {
        id: 'caption-1',
        voiceLineId: 'line-1',
        segmentIndex: 0,
        segmentCount: 2,
        text: '商',
        start: 0,
        end: 1.2,
      },
      {
        id: 'caption-2',
        voiceLineId: 'line-1',
        segmentIndex: 1,
        segmentCount: 2,
        text: '品',
        start: 1.2,
        end: 2.4,
      },
    ];
    repo.get.mockResolvedValue({ ...completedRun(), items: [item] });
    repo.updateCheckpoint.mockResolvedValue(completedItem());

    await service.updateAudio('p', 'run', 'item', {
      expectedUpdatedAt: '2026-01-01T00:00:00.000Z',
      captions: [
        { id: 'caption-1', text: '商', start: 0, end: 1.5 },
        { id: 'caption-2', text: '品', start: 1.5, end: 2.4 },
      ],
    });

    const [, , written] = repo.updateCheckpoint.mock.calls[0]!;
    expect(written.captions).toEqual([
      {
        id: 'caption-1',
        voiceLineId: 'line-1',
        segmentIndex: 0,
        segmentCount: 2,
        text: '商',
        start: 0,
        end: 1.5,
      },
      {
        id: 'caption-2',
        voiceLineId: 'line-1',
        segmentIndex: 1,
        segmentCount: 2,
        text: '品',
        start: 1.5,
        end: 2.4,
      },
    ]);
    validate.mockRestore();
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
describe('editor-generated caption narration', () => {
  const frozenVoice: EffectVoiceSelection = {
    id: 'voice-1',
    name: '沉稳男声',
    gender: 'MALE',
    description: '',
    version: 'v1',
    speaker: 'speaker-1',
    resourceId: 'res-1',
  };
  /** A completed item whose snapshot froze the voice its other narration was rendered with. */
  function voicedItem() {
    const item = completedItem();
    (item.snapshot as PackagingSnapshot).voiceProfile = frozenVoice;
    return item;
  }
  const wavPath = join(tmpdir(), `effect-caption-voice-${process.pid}.wav`);
  const wavSize = 44 + 48_000;
  beforeAll(async () => {
    await writeFile(wavPath, pcmWav(1));
  });
  afterAll(async () => {
    await rm(wavPath, { force: true });
  });
  it('speaks the stored caption with the item’s frozen voice, never the client’s text', async () => {
    // A template with no voice picked yet has nothing to override the frozen profile with.
    const { service, repo } = harness();
    repo.get.mockResolvedValue({ ...completedRun(), items: [voicedItem()] });
    const result = await service.requestCaptionVoice('p', 'run', 'item', {
      captionId: 'line-1',
      text: '商品',
    });
    expect(result.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(repo.enqueueCaptionVoice).toHaveBeenCalledWith({
      schemaVersion: 2,
      taskType: 'CAPTION_VOICE',
      projectId: 'p',
      runId: 'run',
      itemId: 'item',
      captionId: 'line-1',
      text: '商品',
      profile: frozenVoice,
      requestId: result.requestId,
    });
  });
  it('prefers the template’s current voice over the one frozen on the item', async () => {
    // Switching voices after packaging is exactly what the new line is for, so the template wins;
    // the already-rendered narration keeps its frozen profile because nothing re-renders it.
    const { service, repo } = harness('voice-2');
    const chosen = { ...frozenVoice, id: 'voice-2', name: '清新女声', speaker: 'speaker-2' };
    vi.spyOn(service.voiceCatalog, 'selection').mockReturnValue(chosen);
    repo.get.mockResolvedValue({ ...completedRun(), items: [voicedItem()] });

    await service.requestCaptionVoice('p', 'run', 'item', { captionId: 'line-1', text: '商品' });

    expect(service.voiceCatalog.selection).toHaveBeenCalledWith('voice-2');
    expect(repo.enqueueCaptionVoice).toHaveBeenCalledWith(
      expect.objectContaining({ profile: chosen }),
    );
  });
  it('refuses text the stored caption does not have, an unknown caption and a blank one', async () => {
    const { service, repo } = harness();
    repo.get.mockResolvedValue({ ...completedRun(), items: [voicedItem()] });
    // A caption still inside the editor's save debounce must fail loudly instead of being voiced
    // from the previous revision — and arbitrary words must never reach a paid synthesis call.
    await expect(
      service.requestCaptionVoice('p', 'run', 'item', { captionId: 'line-1', text: '限时五折' }),
    ).rejects.toThrow('字幕文本尚未保存');
    await expect(
      service.requestCaptionVoice('p', 'run', 'item', { captionId: 'ghost', text: '商品' }),
    ).rejects.toThrow('字幕不存在');
    const blank = voicedItem();
    blank.checkpoint.captions = [{ id: 'line-1', text: '   ', start: 0, end: 2.4 }];
    repo.get.mockResolvedValue({ ...completedRun(), items: [blank] });
    await expect(
      service.requestCaptionVoice('p', 'run', 'item', { captionId: 'line-1', text: '   ' }),
    ).rejects.toThrow('字幕文本为空');
    expect(repo.enqueueCaptionVoice).not.toHaveBeenCalled();
  });
  it('moves a generated narration without dragging the subtitle it sits under', async () => {
    const { service, repo } = harness();
    const item = completedItem();
    item.checkpoint.captionVoices = {
      'line-1': { fileObjectId: 'caption-voice', start: 0, duration: 2, volume: 1 },
    };
    repo.get.mockResolvedValue({ ...completedRun(), items: [item] });
    repo.updateCheckpoint.mockResolvedValue(completedItem());
    await service.updateAudio('p', 'run', 'item', {
      expectedUpdatedAt: '2026-01-01T00:00:00.000Z',
      captionVoices: {
        'line-1': { start: 6, offset: 0.2, duration: 1.5, volume: 0.5, fadeIn: 0.2 },
      },
    });
    const [, , written] = repo.updateCheckpoint.mock.calls[0]!;
    expect(written.captionVoices['line-1']).toEqual({
      fileObjectId: 'caption-voice',
      start: 6,
      duration: 1.5,
      volume: 0.5,
      offset: 0.2,
      fadeIn: 0.2,
    });
    // The caption owns the narration here, not the other way round: no rescale, no re-time, and the
    // original script line is not what this clip was made from.
    expect(written.captions).toEqual([{ id: 'line-1', text: '商品', start: 0, end: 2.4 }]);
    expect(written.voices['line-1'].start).toBe(0);
  });
  it('rejects an unknown caption narration and a trim past the stored audio', async () => {
    const { service, repo } = harness();
    const item = completedItem();
    item.checkpoint.captionVoices = {
      'line-1': { fileObjectId: 'caption-voice', start: 0, duration: 2, volume: 1 },
    };
    repo.get.mockResolvedValue({ ...completedRun(), items: [item] });
    await expect(
      service.updateAudio('p', 'run', 'item', {
        expectedUpdatedAt: '2026-01-01T00:00:00.000Z',
        captionVoices: { ghost: { start: 1, volume: 1 } },
      }),
    ).rejects.toThrow('字幕口播不存在');
    await expect(
      service.updateAudio('p', 'run', 'item', {
        expectedUpdatedAt: '2026-01-01T00:00:00.000Z',
        captionVoices: { 'line-1': { start: 0, offset: 0.5, duration: 2, volume: 1 } },
      }),
    ).rejects.toThrow('字幕口播裁剪超出真实音频长度');
    expect(repo.updateCheckpoint).not.toHaveBeenCalled();
  });
  it('writes the worker’s audio back aligned on its caption and stays idempotent', async () => {
    const { service, repo, storage, tx } = harness();
    const item = voicedItem();
    // The editor moved the subtitle; the narration generated for it must land on the new start.
    item.checkpoint.captions = [{ id: 'line-1', text: '商品', start: 3, end: 5.4 }];
    repo.get.mockResolvedValue({ ...completedRun(), items: [item] });
    tx.effectPackagingItem.findUniqueOrThrow.mockResolvedValue({
      id: 'item',
      checkpoint: item.checkpoint,
    });
    const file = { path: wavPath, size: wavSize };
    expect(await service.uploadCaptionVoice('p', 'run', 'item', 'line-1', file)).toEqual({
      fileObjectId: 'caption-file',
    });
    const [{ data }] = tx.effectPackagingItem.update.mock.calls[0]!;
    expect(data.checkpoint.captionVoices['line-1']).toEqual({
      voiceProfile: frozenVoice,
      fileObjectId: 'caption-file',
      duration: 1,
      // Aligned on the caption by construction, with no offset asked for by the worker.
      start: 3,
      volume: 1,
    });
    // A redelivered message carries the same bytes, so the clip it already wrote must survive.
    repo.db.effectPackagingFile.findUnique.mockResolvedValue({
      fileObjectId: 'caption-file',
      fileObject: { sha256: createHash('sha256').update(pcmWav(1)).digest('hex') },
    });
    expect(await service.uploadCaptionVoice('p', 'run', 'item', 'line-1', file)).toEqual({
      fileObjectId: 'caption-file',
    });
    expect(storage.put).toHaveBeenCalledTimes(1);
    expect(tx.effectPackagingItem.update).toHaveBeenCalledTimes(1);
  });
  it('refuses a narration write for unfinished packaging or a caption that is gone', async () => {
    const { service, repo } = harness();
    const running = completedItem();
    running.status = 'RUNNING';
    repo.get.mockResolvedValue({ ...completedRun(), items: [running] });
    await expect(
      service.uploadCaptionVoice('p', 'run', 'item', 'line-1', { path: 'unused', size: 1 }),
    ).rejects.toThrow('包装尚未完成');
    await expect(
      service.uploadCaptionVoice('p', 'run', 'item', 'line-1', undefined),
    ).rejects.toThrow('字幕口播音频无效');
    repo.get.mockResolvedValue({ ...completedRun(), items: [completedItem()] });
    await expect(
      service.uploadCaptionVoice('p', 'run', 'item', 'ghost', { path: 'unused', size: 1 }),
    ).rejects.toThrow('字幕不存在');
  });
});
