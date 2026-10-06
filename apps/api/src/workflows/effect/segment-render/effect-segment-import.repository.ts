import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service';
import type { EffectSegmentImportDescriptionMessage } from '@ai-marketing/contracts';
import {
  EFFECT_TEMPLATE_MIX_JOB_TYPE,
  EFFECT_TEMPLATE_MIX_QUEUE,
} from '../../../platform/job/job.constants';
import type { Prisma } from '../../../generated/prisma/client';

@Injectable()
export class EffectSegmentImportRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}
  find(projectId: string, id: string) {
    return this.prisma.effectSegmentImportDraft.findFirst({ where: { projectId, id } });
  }
  async stage(data: Prisma.EffectSegmentImportDraftUncheckedCreateInput) {
    return this.prisma.$transaction(async (tx) => {
      // Serialize concurrent replay with the same upload key through the owning batch.
      await tx.$queryRaw`SELECT "id" FROM "effect_segment_render_batches"
        WHERE "projectId" = ${data.projectId}::uuid AND "id" = ${data.batchId}::uuid FOR UPDATE`;
      const existing = await tx.effectSegmentImportDraft.findUnique({
        where: {
          projectId_uploadKey: { projectId: data.projectId, uploadKey: data.uploadKey },
        },
      });
      if (existing) return { draft: existing, replayed: true };
      return { draft: await tx.effectSegmentImportDraft.create({ data }), replayed: false };
    });
  }
  async describe(projectId: string, id: string, key: string) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "effect_segment_import_drafts"
        WHERE "projectId" = ${projectId}::uuid AND "id" = ${id}::uuid FOR UPDATE`;
      const draft = await tx.effectSegmentImportDraft.findFirst({ where: { projectId, id } });
      if (!draft || draft.status !== 'READY' || draft.expiresAt <= new Date()) return null;
      if (draft.descriptionKey === key || ['QUEUED', 'RUNNING'].includes(draft.descriptionStatus))
        return draft;
      const next = await tx.effectSegmentImportDraft.update({
        where: { id },
        data: {
          descriptionKey: key,
          descriptionStatus: 'QUEUED',
          errorMessage: null,
          attemptToken: null,
          leaseExpiresAt: null,
        },
      });
      const message: EffectSegmentImportDescriptionMessage = {
        schemaVersion: 2,
        taskType: 'VIDEO_IMPORT_DESCRIPTION',
        projectId,
        runId: id,
        requestId: key,
      };
      await tx.jobOutbox.create({
        data: {
          projectId,
          jobType: EFFECT_TEMPLATE_MIX_JOB_TYPE,
          aggregateId: id,
          routingKey: EFFECT_TEMPLATE_MIX_QUEUE,
          payload: message as unknown as Prisma.InputJsonValue,
        },
      });
      return next;
    });
  }
  async claim(projectId: string, id: string, key: string) {
    const token = randomUUID();
    const claimed = await this.prisma.effectSegmentImportDraft.updateMany({
      where: {
        projectId,
        id,
        status: 'READY',
        descriptionKey: key,
        descriptionStatus: 'QUEUED',
        expiresAt: { gt: new Date() },
      },
      data: {
        descriptionStatus: 'RUNNING',
        attemptToken: token,
        leaseExpiresAt: new Date(Date.now() + 120_000),
      },
    });
    return claimed.count === 1 ? this.find(projectId, id) : null;
  }
  heartbeat(projectId: string, id: string, token: string) {
    return this.prisma.effectSegmentImportDraft.updateMany({
      where: {
        projectId,
        id,
        status: 'READY',
        descriptionStatus: 'RUNNING',
        attemptToken: token,
        leaseExpiresAt: { gt: new Date() },
        expiresAt: { gt: new Date() },
      },
      data: { leaseExpiresAt: new Date(Date.now() + 120_000) },
    });
  }
  async finish(projectId: string, id: string, token: string, promptText: string | null) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "effect_segment_import_drafts"
        WHERE "projectId" = ${projectId}::uuid AND "id" = ${id}::uuid FOR UPDATE`;
      const draft = await tx.effectSegmentImportDraft.findFirst({ where: { projectId, id } });
      const finalStatus = promptText === null ? 'FAILED' : 'COMPLETED';
      // A lost callback response may be retried; never repeat the paid generation or overwrite
      // another attempt. The terminal token grants no content access (that requires RUNNING).
      if (
        draft?.status === 'READY' &&
        draft.attemptToken === token &&
        draft.descriptionStatus === finalStatus &&
        (promptText === null || draft.promptText === promptText)
      )
        return { count: 1 };
      return tx.effectSegmentImportDraft.updateMany({
        where: {
          projectId,
          id,
          status: 'READY',
          descriptionStatus: 'RUNNING',
          attemptToken: token,
          leaseExpiresAt: { gt: new Date() },
          expiresAt: { gt: new Date() },
        },
        data: {
          descriptionStatus: promptText === null ? 'FAILED' : 'COMPLETED',
          ...(promptText === null
            ? { errorMessage: 'AI 描述生成失败，可重新生成或手工填写' }
            : { promptText, errorMessage: null }),
          leaseExpiresAt: null,
        },
      });
    });
  }
  cancel(projectId: string, id: string) {
    return this.prisma.effectSegmentImportDraft.updateMany({
      where: { projectId, id, status: 'READY' },
      data: { status: 'CANCELLED', attemptToken: null, leaseExpiresAt: null },
    });
  }
  async expire() {
    await this.prisma.effectSegmentImportDraft.updateMany({
      where: {
        status: 'READY',
        descriptionStatus: 'QUEUED',
        updatedAt: { lt: new Date(Date.now() - 10 * 60_000) },
      },
      data: { descriptionStatus: 'FAILED', errorMessage: 'AI 服务暂未处理，请重试或手工填写' },
    });
    await this.prisma.effectSegmentImportDraft.updateMany({
      where: {
        status: 'READY',
        descriptionStatus: 'RUNNING',
        leaseExpiresAt: { lte: new Date() },
      },
      data: {
        descriptionStatus: 'FAILED',
        errorMessage: 'AI 描述超时，可重试或手工填写',
        attemptToken: null,
        leaseExpiresAt: null,
      },
    });
    await this.prisma.effectSegmentImportDraft.updateMany({
      where: { status: 'READY', expiresAt: { lte: new Date() } },
      data: { status: 'CANCELLED', attemptToken: null, leaseExpiresAt: null },
    });
    return this.prisma.effectSegmentImportDraft.findMany({
      where: { status: 'CANCELLED', cleanedAt: null },
      take: 50,
    });
  }
  cleaned(id: string) {
    return this.prisma.effectSegmentImportDraft.updateMany({
      where: { id, status: 'CANCELLED' },
      data: { cleanedAt: new Date() },
    });
  }
}
