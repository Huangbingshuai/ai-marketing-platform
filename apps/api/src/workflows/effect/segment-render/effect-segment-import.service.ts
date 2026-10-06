import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleInit,
  type OnModuleDestroy,
} from '@nestjs/common';
import {
  EFFECT_SEGMENT_RENDER_LIMITS,
  type EffectSegmentImportDraft,
  type EffectSegmentImportConfirmItem,
  type EffectSegmentImportDescriptionClaim,
} from '@ai-marketing/contracts';
import { STORAGE_PORT, type StoragePort } from '../../../platform/file/storage.port';
import { EffectSegmentRenderService } from './effect-segment-render.service';
import { EffectSegmentRenderRepository } from './effect-segment-render.repository';
import { EffectSegmentImportRepository } from './effect-segment-import.repository';
import { inspectImportVideo } from './effect-segment-import-media';
import type { UploadedSegmentRenderFile } from './effect-segment-render.types';

type Record = NonNullable<Awaited<ReturnType<EffectSegmentImportRepository['find']>>>;
const present = (draft: Record): EffectSegmentImportDraft => ({
  id: draft.id,
  fileName: draft.fileName,
  sizeBytes: draft.sizeBytes,
  durationSeconds: draft.durationSeconds,
  status: draft.status as EffectSegmentImportDraft['status'],
  descriptionStatus: draft.descriptionStatus as EffectSegmentImportDraft['descriptionStatus'],
  promptText: draft.promptText,
  errorMessage: draft.errorMessage,
});

@Injectable()
export class EffectSegmentImportService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EffectSegmentImportService.name);
  private timer?: ReturnType<typeof setInterval>;
  private cleaning = false;
  constructor(
    @Inject(EffectSegmentImportRepository) private readonly drafts: EffectSegmentImportRepository,
    @Inject(EffectSegmentRenderRepository) private readonly renders: EffectSegmentRenderRepository,
    @Inject(EffectSegmentRenderService) private readonly renderService: EffectSegmentRenderService,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
  ) {}
  onModuleInit() {
    this.timer = setInterval(() => {
      void this.cleanup().catch(() => this.logger.warn('导入草稿清理未完成，将在下一轮重试'));
    }, 60_000);
    this.timer.unref();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
  private async cleanup() {
    if (this.cleaning) return;
    this.cleaning = true;
    try {
      for (const draft of await this.drafts.expire()) {
        await this.storage.delete(draft.storageKey);
        await this.drafts.cleaned(draft.id);
      }
    } finally {
      this.cleaning = false;
    }
  }
  private async ready(projectId: string, batchId: string, id: string) {
    await this.renderService.importContext(projectId, batchId);
    const draft = await this.drafts.find(projectId, id);
    if (!draft || draft.batchId !== batchId) throw new NotFoundException('导入草稿不存在');
    return draft;
  }
  async stage(projectId: string, batchId: string, key: string, upload?: UploadedSegmentRenderFile) {
    const { project, batch } = await this.renderService.importContext(projectId, batchId);
    if (!upload || upload.size < 1 || upload.size > EFFECT_SEGMENT_RENDER_LIMITS.maxUploadBytes)
      throw new BadRequestException('请选择不超过 512 MB 的视频文件');
    let metadata;
    try {
      metadata = await inspectImportVideo(upload.path, upload.originalname);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : '视频校验失败');
    }
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(upload.path)) hash.update(chunk as Buffer);
    const sha256 = hash.digest('hex');
    // eslint-disable-next-line no-control-regex
    const fileName = upload.originalname.replace(/[\\/\u0000-\u001f]/gu, '_').slice(0, 255);
    const stored = await this.storage.put({
      projectId,
      stream: createReadStream(upload.path),
      sizeBytes: upload.size,
      contentType: metadata.mimeType,
      keyContext: {
        projectName: project.name,
        workflow: 'EFFECT',
        lifecycle: 'staging',
        productId: batch.productId,
        productName: batch.product.name,
        category: '外部视频导入草稿',
        originalFileName: fileName,
      },
    });
    let retained = false;
    try {
      const result = await this.drafts.stage({
        projectId,
        workflowRunId: batch.workflowRunId,
        batchId,
        uploadKey: key,
        fileName,
        sizeBytes: upload.size,
        storageKey: stored.key,
        sha256,
        ...metadata,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      });
      if (result.replayed && (result.draft.sha256 !== sha256 || result.draft.batchId !== batchId))
        throw new ConflictException('导入幂等键已用于其他文件');
      retained = !result.replayed;
      return { draft: present(result.draft), replayed: result.replayed };
    } finally {
      if (!retained) await this.storage.delete(stored.key).catch(() => undefined);
    }
  }
  async get(projectId: string, batchId: string, id: string) {
    return { draft: present(await this.ready(projectId, batchId, id)) };
  }
  async describe(projectId: string, batchId: string, id: string, key: string) {
    await this.ready(projectId, batchId, id);
    const draft = await this.drafts.describe(projectId, id, key);
    if (!draft) throw new ConflictException('导入草稿已取消、已确认或已过期');
    return { draft: present(draft) };
  }
  async cancel(projectId: string, batchId: string, id: string) {
    const draft = await this.drafts.find(projectId, id);
    // Cancellation stays possible after leaving the editing session, but cannot target another batch.
    await this.renderService.batch(projectId, batchId);
    if (!draft || draft.batchId !== batchId) throw new NotFoundException('导入草稿不存在');
    await this.drafts.cancel(projectId, id);
    return { cancelled: true };
  }
  async confirm(
    projectId: string,
    batchId: string,
    items: EffectSegmentImportConfirmItem[],
    revision: number,
    key: string,
  ) {
    await this.renderService.importContext(projectId, batchId);
    if (
      !items.length ||
      items.length > 100 ||
      new Set(items.map((item) => item.draftId)).size !== items.length
    )
      throw new BadRequestException('导入素材列表无效');
    const normalized = items.map((item) => ({
      draftId: item.draftId,
      promptText: item.promptText.trim(),
    }));
    if (
      normalized.some(
        (item) =>
          !item.promptText ||
          item.promptText.length > EFFECT_SEGMENT_RENDER_LIMITS.maxImportPromptLength,
      )
    )
      throw new BadRequestException('请为每个视频填写 1～4000 字的素材描述');
    const result = await this.renders.appendImportedMaterials(
      projectId,
      batchId,
      normalized,
      revision,
      key,
    );
    if (!['UPDATED', 'REPLAYED'].includes(result))
      throw new ConflictException(
        result === 'DRAFT_CONFLICT'
          ? '导入草稿不可用或 AI 正在生成，请稍后再确认'
          : '导入上下文已变化，请刷新后重试',
      );
    return {
      ...(await this.renderService.batch(projectId, batchId)),
      importedCount: items.length,
      replayed: result === 'REPLAYED',
    };
  }
  async claim(
    projectId: string,
    id: string,
    key: string,
  ): Promise<EffectSegmentImportDescriptionClaim> {
    const draft = await this.drafts.claim(projectId, id, key);
    return draft
      ? {
          claimed: true,
          attemptToken: draft.attemptToken!,
          durationSeconds: draft.durationSeconds,
          mimeType: draft.mimeType,
          sizeBytes: draft.sizeBytes,
          contentHash: draft.sha256,
        }
      : { claimed: false };
  }
  private async leased(projectId: string, id: string, token: string) {
    const draft = await this.drafts.find(projectId, id);
    if (
      !draft ||
      draft.status !== 'READY' ||
      draft.descriptionStatus !== 'RUNNING' ||
      draft.attemptToken !== token ||
      !draft.leaseExpiresAt ||
      draft.leaseExpiresAt <= new Date() ||
      draft.expiresAt <= new Date()
    )
      throw new ConflictException('导入描述任务租约已失效');
    return draft;
  }
  async content(projectId: string, id: string, token: string) {
    const draft = await this.leased(projectId, id, token);
    return { mimeType: draft.mimeType, ...(await this.storage.open(draft.storageKey)) };
  }
  async heartbeat(projectId: string, id: string, token: string) {
    if (typeof token !== 'string' || !token.trim()) throw new ConflictException('任务租约失效');
    if ((await this.drafts.heartbeat(projectId, id, token)).count !== 1)
      throw new ConflictException('任务租约失效');
    return { accepted: true };
  }
  async finish(projectId: string, id: string, token: string, text: string | null) {
    if (typeof token !== 'string' || !token.trim()) throw new ConflictException('任务租约失效');
    if (
      text !== null &&
      (!text.trim() || text.length > EFFECT_SEGMENT_RENDER_LIMITS.maxImportPromptLength)
    )
      throw new BadRequestException('视频描述结果无效');
    if ((await this.drafts.finish(projectId, id, token, text?.trim() ?? null)).count !== 1)
      throw new ConflictException('任务租约失效');
    return { accepted: true };
  }
}
