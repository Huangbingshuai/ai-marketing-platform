import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type {
  CreateEffectVoicePreview,
  EffectVoicePreview,
  EffectVoicePreviewSnapshot,
} from '@ai-marketing/contracts';
import { STORAGE_PORT, type StoragePort } from '../../../platform/file/storage.port';
import { workflowStateHash } from '../../../platform/workflow/workflow-state-hash';
import { EffectTemplateMixService } from './effect-template-mix.service';
import { EffectVoiceCatalogService } from './effect-voice.catalog';
import { EffectVoiceRepository } from './effect-voice.repository';
import { wavDuration } from './effect-packaging.service';

export const VOICE_PREVIEW_TEXT =
  '你好，这是当前音色的试听。让每一段产品画面都自然、有节奏地表达。';
type Row = Awaited<ReturnType<EffectVoiceRepository['get']>>;
@Injectable()
export class EffectVoiceService {
  constructor(
    @Inject(EffectVoiceRepository) readonly repo: EffectVoiceRepository,
    @Inject(EffectVoiceCatalogService) readonly catalog: EffectVoiceCatalogService,
    @Inject(EffectTemplateMixService) readonly mix: EffectTemplateMixService,
    @Inject(STORAGE_PORT) readonly storage: StoragePort,
  ) {}
  present(row: Row): EffectVoicePreview {
    const snapshot = row.snapshot as unknown as EffectVoicePreviewSnapshot;
    return {
      id: row.id,
      voiceProfileId: snapshot.profile.id,
      version: snapshot.profile.version,
      status: row.status as EffectVoicePreview['status'],
      fileObjectId: row.fileObjectId,
      errorMessage: row.errorMessage,
    };
  }
  async scope(projectId: string, workflowRunId: string, templateId: string) {
    const workspace = await this.mix.workspace(projectId, workflowRunId);
    if (!workspace.draft.templates.some((entry) => entry.id === templateId))
      throw new NotFoundException('模板不存在');
  }
  async profiles(projectId: string, workflowRunId: string, templateId: string) {
    await this.scope(projectId, workflowRunId, templateId);
    // Same configured account is used by every project. Persisted permission failures hide that version.
    const failed = await this.repo.db.effectVoicePreview.findMany({
      where: { errorCode: 'UNAUTHORIZED' },
      select: { snapshot: true },
    });
    return this.catalog.publicCatalog(
      new Set(
        failed.map((r) => {
          const p = (r.snapshot as unknown as EffectVoicePreviewSnapshot).profile;
          return `${p.id}:${p.version}`;
        }),
      ),
    );
  }
  async catalogSampleTargets() {
    const selections = this.catalog.workerSelections();
    const saved = await this.repo.db.effectVoiceCatalogSample.findMany({
      select: { profileId: true, version: true },
    });
    const savedKeys = new Set(saved.map((row) => `${row.profileId}:${row.version}`));
    const attempted = await this.repo.db.effectVoiceCatalogSampleAttempt.findMany({
      select: { profileId: true, version: true, status: true, errorCode: true },
    });
    const attemptByKey = new Map(
      attempted.map((row) => [`${row.profileId}:${row.version}`, row]),
    );
    return selections.map(({ id, name, version, speaker, resourceId }) => ({
      id,
      name,
      version,
      speaker,
      resourceId,
      sampleAvailable: savedKeys.has(`${id}:${version}`),
      attemptStatus: attemptByKey.get(`${id}:${version}`)?.status ?? null,
      attemptErrorCode: attemptByKey.get(`${id}:${version}`)?.errorCode ?? null,
    }));
  }
  async claimCatalogSample(profileId: string, version: string) {
    const profile = this.catalog.selection(profileId);
    if (profile.version !== version) throw new ConflictException('音色版本已变化，请重新读取目录');
    const sample = await this.repo.db.effectVoiceCatalogSample.findUnique({
      where: { profileId_version: { profileId, version } },
      select: { id: true },
    });
    if (sample) return { claimed: false, sampleAvailable: true };
    const previousAttempt = await this.repo.db.effectVoiceCatalogSampleAttempt.findUnique({
      where: { profileId_version: { profileId, version } },
      select: { status: true, errorCode: true },
    });
    if (previousAttempt?.status === 'FAILED' && previousAttempt.errorCode === 'UPLOAD_FAILED') {
      const reclaimed = await this.repo.db.effectVoiceCatalogSampleAttempt.updateMany({
        where: { profileId, version, status: 'FAILED', errorCode: 'UPLOAD_FAILED' },
        data: { status: 'RUNNING', errorCode: null },
      });
      return { claimed: reclaimed.count === 1, sampleAvailable: false };
    }
    try {
      await this.repo.db.effectVoiceCatalogSampleAttempt.create({
        data: { profileId, version, status: 'RUNNING' },
      });
      return { claimed: true, sampleAvailable: false };
    } catch {
      const existing = await this.repo.db.effectVoiceCatalogSampleAttempt.findUnique({
        where: { profileId_version: { profileId, version } },
        select: { status: true },
      });
      if (existing) return { claimed: false, sampleAvailable: false, attemptStatus: existing.status };
      throw new ConflictException('试听样本登记失败');
    }
  }
  async failCatalogSample(profileId: string, version: string, code: string) {
    const profile = this.catalog.selection(profileId);
    if (profile.version !== version) throw new ConflictException('音色版本已变化，请重新读取目录');
    const changed = await this.repo.db.effectVoiceCatalogSampleAttempt.updateMany({
      where: { profileId, version, status: 'RUNNING' },
      data: { status: code === 'SUBMISSION_UNKNOWN' ? code : 'FAILED', errorCode: code },
    });
    if (!changed.count) throw new ConflictException('试听样本调用已登记或完成');
    return { accepted: true };
  }
  async uploadCatalogSample(
    profileId: string,
    version: string,
    file: { path: string; size: number } | undefined,
  ) {
    if (!file || file.size > 10 * 1024 * 1024) throw new BadRequestException('试听文件无效');
    const profile = this.catalog.selection(profileId);
    if (profile.version !== version) throw new ConflictException('音色版本已变化，请重新读取目录');
    const duration = await wavDuration(file.path, file.size);
    if (duration <= 0 || duration > 60) throw new BadRequestException('试听音频时长无效');
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file.path)) hash.update(chunk);
    const sha256 = hash.digest('hex');
    const current = await this.repo.db.effectVoiceCatalogSample.findUnique({
      where: { profileId_version: { profileId, version } },
    });
    if (current) {
      if (current.sha256 !== sha256) throw new ConflictException('该版本试听已保存，不能覆盖');
      return { profileId, version, sampleAvailable: true };
    }
    const stored = await this.storage.putShared({
      collection: 'effect-voices',
      assetId: profileId,
      version: createHash('sha256').update(version).digest('hex').slice(0, 24),
      extension: 'wav',
      stream: createReadStream(file.path),
      sizeBytes: file.size,
      contentType: 'audio/wav',
    });
    try {
      const result = await this.repo.db.$transaction(async (tx) => {
        const attempt = await tx.effectVoiceCatalogSampleAttempt.findUnique({
          where: { profileId_version: { profileId, version } },
        });
        if (!attempt || attempt.status !== 'RUNNING')
          throw new ConflictException('试听样本生成未登记或已结束');
        const current = await tx.effectVoiceCatalogSample.findUnique({
          where: { profileId_version: { profileId, version } },
        });
        if (current) {
          if (current.sha256 !== sha256) throw new ConflictException('该版本试听已保存，不能覆盖');
        } else {
          await tx.effectVoiceCatalogSample.create({
            data: {
              profileId,
              version,
              storageKey: stored.key,
              sha256,
              sizeBytes: file.size,
              mimeType: 'audio/wav',
              duration,
            },
          });
        }
        await tx.effectVoiceCatalogSampleAttempt.update({
          where: { profileId_version: { profileId, version } },
          data: { status: 'COMPLETED', errorCode: null },
        });
        return { profileId, version, sampleAvailable: true };
      });
      const persisted = await this.repo.db.effectVoiceCatalogSample.findUniqueOrThrow({
        where: { profileId_version: { profileId, version } },
      });
      if (persisted.storageKey !== stored.key) await this.storage.delete(stored.key).catch(() => undefined);
      return result;
    } catch (error) {
      await this.storage.delete(stored.key).catch(() => undefined);
      throw error;
    }
  }
  async catalogSampleContent(
    projectId: string,
    workflowRunId: string,
    templateId: string,
    profileId: string,
    version: string,
  ) {
    await this.scope(projectId, workflowRunId, templateId);
    const profile = this.catalog.selection(profileId);
    if (profile.version !== version) throw new NotFoundException('试听样本不存在');
    const sample = await this.repo.db.effectVoiceCatalogSample.findUnique({
      where: { profileId_version: { profileId, version } },
    });
    if (!sample) throw new NotFoundException('该音色试听尚未准备好');
    const stored = await this.storage.open(sample.storageKey);
    return {
      stream: stored.stream,
      contentLength: stored.contentLength,
      mimeType: sample.mimeType,
      sha256: sample.sha256,
    };
  }
  async list(projectId: string, workflowRunId: string, templateId: string) {
    await this.scope(projectId, workflowRunId, templateId);
    return (await this.repo.list(projectId, workflowRunId, templateId)).map((r) => this.present(r));
  }
  async create(projectId: string, templateId: string, body: CreateEffectVoicePreview) {
    await this.scope(projectId, body.workflowRunId, templateId);
    const requestHash = workflowStateHash({
      workflowRunId: body.workflowRunId,
      templateId,
      voiceProfileId: body.voiceProfileId,
    });
    const replay = await this.repo.replay(projectId, body.idempotencyKey, requestHash);
    if (replay) return this.present(replay);
    const catalog = await this.profiles(projectId, body.workflowRunId, templateId);
    if (!catalog.profiles.some((p) => p.id === body.voiceProfileId))
      throw new BadRequestException('该音色尚未验证或已失去权限');
    const snapshot = {
      profile: this.catalog.selection(body.voiceProfileId),
      sampleText: VOICE_PREVIEW_TEXT,
    };
    return this.present(
      await this.repo.create({
        projectId,
        templateId,
        workflowRunId: body.workflowRunId,
        idempotencyKey: body.idempotencyKey,
        requestHash,
        cacheKey: workflowStateHash(snapshot),
        snapshot,
      }),
    );
  }
  async upload(
    projectId: string,
    id: string,
    token: string,
    file: { path: string; size: number } | undefined,
  ) {
    if (!file || file.size > 10 * 1024 * 1024) throw new BadRequestException('试听文件无效');
    const duration = await wavDuration(file.path, file.size);
    if (duration > 60) throw new BadRequestException('试听音频过长');
    const row = await this.repo.get(projectId, id);
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file.path)) hash.update(chunk);
    const sha256 = hash.digest('hex');
    if (row.status === 'COMPLETED' && row.attemptToken === token && row.fileObjectId) {
      const old = await this.repo.db.fileObject.findFirst({
        where: { projectId, id: row.fileObjectId, sha256, status: 'AVAILABLE' },
      });
      if (old) return { fileObjectId: old.id };
      throw new ConflictException('试听文件已保存，不能替换');
    }
    await this.repo.heartbeat(projectId, id, token);
    if (!row.submittedAt) throw new ConflictException('试听尚未提交');
    const project = await this.repo.db.project.findUniqueOrThrow({ where: { id: projectId } });
    const stored = await this.storage.put({
      projectId,
      stream: createReadStream(file.path),
      sizeBytes: file.size,
      contentType: 'audio/wav',
      keyContext: {
        projectName: project.name,
        workflow: 'effect',
        lifecycle: 'staging',
        category: 'voice-preview',
        originalFileName: `${id}.wav`,
      },
    });
    try {
      return await this.repo.db.$transaction(async (tx) => {
        const held = await tx.effectVoicePreview.updateMany({
          where: this.repo.held(projectId, id, token),
          data: { leaseExpiresAt: new Date(Date.now() + 120_000) },
        });
        if (!held.count) throw new ConflictException('试听已取消或租约失效');
        const created = await tx.fileObject.create({
          data: {
            projectId,
            workflowRunId: row.workflowRunId,
            nodeId: 'TEMPLATE_MIX',
            originalFileName: '音色试听.wav',
            mimeType: 'audio/wav',
            sizeBytes: file.size,
            storageKey: stored.key,
            sha256,
          },
        });
        // Completion and file binding are atomic; a lost HTTP response cannot generate a second voice.
        await tx.effectVoicePreview.update({
          where: { id },
          data: {
            fileObjectId: created.id,
            status: 'COMPLETED',
            leaseExpiresAt: null,
            errorMessage: null,
            errorCode: null,
          },
        });
        return { fileObjectId: created.id };
      });
    } catch (error) {
      await this.storage.delete(stored.key).catch(() => undefined);
      throw error;
    }
  }
}
