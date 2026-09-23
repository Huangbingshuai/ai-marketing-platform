import { describe, expect, it, vi } from 'vitest';
import { validate } from 'class-validator';
import { EffectVoiceCatalogService, readVoiceCatalog } from './effect-voice.catalog';
import { EffectVoiceRepository } from './effect-voice.repository';
import { EffectVoiceService, VOICE_PREVIEW_TEXT } from './effect-voice.service';
import { CreateVoicePreviewDto } from './effect-voice.controller';
import type { PrismaService } from '../../../database/prisma.service';
import type { EffectTemplateMixService } from './effect-template-mix.service';
import type { StoragePort } from '../../../platform/file/storage.port';

const profile = new EffectVoiceCatalogService().selection();
const snapshot = { profile, sampleText: VOICE_PREVIEW_TEXT };
const row = {
  id: 'preview',
  projectId: 'p',
  workflowRunId: 'w',
  templateId: 't',
  status: 'QUEUED',
  snapshot,
  fileObjectId: null,
  errorMessage: null,
};
function database() {
  const db = {
    effectVoicePreview: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue(row),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    effectVoicePreviewRequest: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn() },
    effectVoiceCatalogSample: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
      findUniqueOrThrow: vi.fn(),
      create: vi.fn(),
    },
    effectVoiceCatalogSampleAttempt: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ status: 'RUNNING' }),
      update: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    jobOutbox: { upsert: vi.fn() },
    $executeRaw: vi.fn(),
    $transaction: vi.fn(),
  };
  db.$transaction.mockImplementation((action) => action(db));
  return db;
}
const input = {
  projectId: 'p',
  workflowRunId: 'w',
  templateId: 't',
  cacheKey: 'hash',
  idempotencyKey: 'click',
  requestHash: 'request',
  snapshot,
};

describe('curated voice catalog', () => {
  it('loads all 99 account-listed TTS 2.0 voices and preserves the existing Vivi profile ID', () => {
    const catalog = new EffectVoiceCatalogService();
    const visible = catalog.publicCatalog();
    expect(visible.profiles).toHaveLength(99);
    expect(new Set(visible.profiles.map((voice) => voice.id)).size).toBe(99);
    expect(visible.profiles.every((voice) => !/\s*2\.0$/i.test(voice.name))).toBe(true);
    expect(visible.defaultId).toBe('vivi');
    expect(catalog.selection('zh_male_guanggaojieshuo_uranus_bigtts')).toMatchObject({
      speaker: 'zh_male_guanggaojieshuo_uranus_bigtts',
      resourceId: 'seed-tts-2.0',
    });
  });
  it('only exposes enabled voices and no provider configuration', () => {
    const catalog = new EffectVoiceCatalogService();
    expect(catalog.publicCatalog().profiles[0]).not.toHaveProperty('speaker');
    const disabled = catalog.publicCatalog(new Set([`${profile.id}:${profile.version}`]));
    expect(disabled.profiles).toHaveLength(98);
    expect(disabled.profiles.some((voice) => voice.id === profile.id)).toBe(false);
    expect(() => readVoiceCatalog(JSON.stringify([{ ...profile, enabled: true }]))).toThrow(
      '验证记录',
    );
    expect(() => catalog.selection('not-authorized')).toThrow('未验证');
    expect(readVoiceCatalog('[]')).toEqual([]);
  });
  it('rejects arbitrary prompt/provider input at the DTO boundary', async () => {
    const dto = Object.assign(new CreateVoicePreviewDto(), {
      workflowRunId: '00000000-0000-4000-8000-000000000000',
      voiceProfileId: 'vivi',
      idempotencyKey: 'click',
      sampleText: 'injected',
      speaker: 'custom',
    });
    const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
    expect(errors.map((e) => e.property)).toEqual(
      expect.arrayContaining(['sampleText', 'speaker']),
    );
  });
});

describe('preview persistence', () => {
  it('registers cached request aliases without enqueuing new paid work', async () => {
    const db = database();
    db.effectVoicePreview.findFirst.mockResolvedValue({
      ...row,
      status: 'COMPLETED',
      fileObjectId: 'file',
    });
    const repo = new EffectVoiceRepository(db as unknown as PrismaService);
    await repo.create(input);
    expect(db.jobOutbox.upsert).not.toHaveBeenCalled();
    expect(db.effectVoicePreviewRequest.create).toHaveBeenCalledWith({
      data: {
        projectId: 'p',
        idempotencyKey: 'click',
        requestHash: 'request',
        previewId: 'preview',
      },
    });
    expect(db.effectVoicePreview.findFirst.mock.calls[0]![0].where).toMatchObject({
      projectId: 'p',
      workflowRunId: 'w',
      templateId: 't',
    });
  });
  it('creates one outbox message and rejects changed idempotent requests', async () => {
    const db = database(),
      repo = new EffectVoiceRepository(db as unknown as PrismaService);
    await repo.create(input);
    expect(db.jobOutbox.upsert.mock.calls[0]![0].create.payload).toMatchObject({
      schemaVersion: 2,
      taskType: 'VOICE_PREVIEW',
      runId: row.id,
    });
    db.effectVoicePreviewRequest.findUnique.mockResolvedValue({
      requestHash: 'different',
      preview: row,
    });
    await expect(repo.create(input)).rejects.toThrow('幂等键');
    expect(db.effectVoicePreview.create).toHaveBeenCalledTimes(1);
  });
  it('fences repeat paid submission and old/cancelled attempts', async () => {
    const db = database(),
      repo = new EffectVoiceRepository(db as unknown as PrismaService);
    await repo.submit('p', 'preview', 'new-token');
    expect(db.effectVoicePreview.updateMany.mock.calls[0]![0].where).toMatchObject({
      projectId: 'p',
      attemptToken: 'new-token',
      status: 'RUNNING',
      submittedAt: null,
    });
    db.effectVoicePreview.updateMany.mockResolvedValue({ count: 0 });
    await expect(repo.submit('p', 'preview', 'old-token')).rejects.toThrow('重复付费');
    await expect(repo.heartbeat('p', 'preview', 'old-token')).rejects.toThrow('租约失效');
    await expect(repo.fail('p', 'preview', 'old-token', 'INVALID_AUDIO')).rejects.toThrow(
      '租约失效',
    );
  });
  it('recovers pre-submit crashes but never resubmits ambiguous paid work', async () => {
    const db = database(),
      repo = new EffectVoiceRepository(db as unknown as PrismaService);
    db.effectVoicePreview.findMany.mockResolvedValue([
      { ...row, id: 'not-submitted', submittedAt: null },
      { ...row, id: 'submitted', submittedAt: new Date() },
    ]);
    await repo.recoverExpired();
    expect(db.effectVoicePreview.updateMany.mock.calls.map((call) => call[0].data.status)).toEqual([
      'QUEUED',
      'FAILED',
    ]);
    expect(db.jobOutbox.upsert).toHaveBeenCalledTimes(1);
    expect(db.effectVoicePreview.updateMany.mock.calls[1]![0].data.errorCode).toBe(
      'SUBMISSION_UNKNOWN',
    );
  });
});

describe('preview service', () => {
  it('returns only enabled generation targets and resumes from shared sample state', async () => {
    const db = database(),
      repo = new EffectVoiceRepository(db as unknown as PrismaService);
    db.effectVoiceCatalogSample.findMany.mockResolvedValue([
      { profileId: 'vivi', version: 'seed-tts-2.0:1' },
    ]);
    db.effectVoiceCatalogSampleAttempt.findMany.mockResolvedValue([
      {
        profileId: 'saturn_zh_female_cancan_tob',
        version: 'seed-tts-2.0:1',
        status: 'SUBMISSION_UNKNOWN',
      },
    ]);
    const service = new EffectVoiceService(
      repo,
      new EffectVoiceCatalogService(),
      {} as EffectTemplateMixService,
      {} as StoragePort,
    );
    const targets = await service.catalogSampleTargets();
    expect(targets).toHaveLength(99);
    expect(targets.find((target) => target.id === 'vivi')).toMatchObject({
      sampleAvailable: true,
      attemptStatus: null,
    });
    expect(targets.find((target) => target.id === 'saturn_zh_female_cancan_tob')).toMatchObject({
      sampleAvailable: false,
      attemptStatus: 'SUBMISSION_UNKNOWN',
    });
    expect(targets[0]).toHaveProperty('speaker');
  });
  it('validates project scope and version before opening a shared sample', async () => {
    const db = database(),
      repo = new EffectVoiceRepository(db as unknown as PrismaService);
    db.effectVoiceCatalogSample.findUnique.mockResolvedValue({
      storageKey: 'shared/effect-voices/vivi/seed-tts-2.0-1/file.wav',
      mimeType: 'audio/wav',
      sha256: 'a'.repeat(64),
    });
    const mix = { workspace: vi.fn().mockResolvedValue({ draft: { templates: [{ id: 't' }] } }) };
    const storage = { open: vi.fn().mockResolvedValue({ stream: 'audio', contentLength: 8 }) };
    const service = new EffectVoiceService(
      repo,
      new EffectVoiceCatalogService(),
      mix as unknown as EffectTemplateMixService,
      storage as unknown as StoragePort,
    );
    await expect(
      service.catalogSampleContent('p', 'w', 't', 'vivi', 'seed-tts-2.0:1'),
    ).resolves.toMatchObject({
      stream: 'audio',
      contentLength: 8,
      mimeType: 'audio/wav',
    });
    await expect(
      service.catalogSampleContent('p', 'w', 'wrong', 'vivi', 'seed-tts-2.0:1'),
    ).rejects.toThrow('模板不存在');
    await expect(
      service.catalogSampleContent('p', 'w', 't', 'vivi', 'old-version'),
    ).rejects.toThrow('样本不存在');
    expect(storage.open).toHaveBeenCalledOnce();
  });
  it('claims each paid catalog sample version once', async () => {
    const db = database(),
      service = new EffectVoiceService(
        new EffectVoiceRepository(db as unknown as PrismaService),
        new EffectVoiceCatalogService(),
        {} as EffectTemplateMixService,
        {} as StoragePort,
      );
    await expect(service.claimCatalogSample('vivi', 'seed-tts-2.0:1')).resolves.toEqual({
      claimed: true,
      sampleAvailable: false,
    });
    db.effectVoiceCatalogSampleAttempt.create.mockRejectedValueOnce(new Error('unique conflict'));
    db.effectVoiceCatalogSampleAttempt.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ status: 'RUNNING' });
    await expect(service.claimCatalogSample('vivi', 'seed-tts-2.0:1')).resolves.toMatchObject({
      claimed: false,
      attemptStatus: 'RUNNING',
    });
  });
  it('allows a paid retry only after an explicitly recorded sample-upload failure', async () => {
    const db = database(),
      service = new EffectVoiceService(
        new EffectVoiceRepository(db as unknown as PrismaService),
        new EffectVoiceCatalogService(),
        {} as EffectTemplateMixService,
        {} as StoragePort,
      );
    db.effectVoiceCatalogSampleAttempt.findUnique.mockResolvedValue({
      status: 'FAILED',
      errorCode: 'UPLOAD_FAILED',
    });
    await expect(service.claimCatalogSample('vivi', 'seed-tts-2.0:1')).resolves.toEqual({
      claimed: true,
      sampleAvailable: false,
    });
    expect(db.effectVoiceCatalogSampleAttempt.updateMany).toHaveBeenCalledWith({
      where: {
        profileId: 'vivi',
        version: 'seed-tts-2.0:1',
        status: 'FAILED',
        errorCode: 'UPLOAD_FAILED',
      },
      data: { status: 'RUNNING', errorCode: null },
    });
  });
  it('freezes fixed sample and provider selection; rejects wrong template before querying records', async () => {
    const db = database(),
      repo = new EffectVoiceRepository(db as unknown as PrismaService);
    const mix = { workspace: vi.fn().mockResolvedValue({ draft: { templates: [{ id: 't' }] } }) };
    const service = new EffectVoiceService(
      repo,
      new EffectVoiceCatalogService(),
      mix as unknown as EffectTemplateMixService,
      {} as StoragePort,
    );
    await service.create('p', 't', {
      workflowRunId: 'w',
      voiceProfileId: profile.id,
      idempotencyKey: 'click',
    });
    expect(db.effectVoicePreview.create.mock.calls[0]![0].data.snapshot).toEqual(snapshot);
    expect(mix.workspace).toHaveBeenCalledWith('p', 'w');
    await expect(service.list('p', 'different-template', 'w')).rejects.toThrow('模板不存在');
    expect(service.present(row as never)).not.toHaveProperty('snapshot');
  });
  it('replays an already accepted request even if catalog permissions changed', async () => {
    const db = database(),
      repo = new EffectVoiceRepository(db as unknown as PrismaService);
    const replay = vi.spyOn(repo, 'replay').mockResolvedValue(row as never);
    const mix = { workspace: vi.fn().mockResolvedValue({ draft: { templates: [{ id: 't' }] } }) };
    const service = new EffectVoiceService(
      repo,
      new EffectVoiceCatalogService(),
      mix as unknown as EffectTemplateMixService,
      {} as StoragePort,
    );
    expect(
      await service.create('p', 't', {
        workflowRunId: 'w',
        voiceProfileId: profile.id,
        idempotencyKey: 'click',
      }),
    ).toMatchObject({ id: 'preview' });
    expect(replay).toHaveBeenCalledOnce();
    expect(db.effectVoicePreview.create).not.toHaveBeenCalled();
  });
});
