import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type {
  EffectVoicePreviewSnapshot,
  EffectVoicePreviewFailure,
  EffectVoicePreviewMessage,
} from '@ai-marketing/contracts';
import type { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import {
  EFFECT_TEMPLATE_MIX_JOB_TYPE,
  EFFECT_TEMPLATE_MIX_QUEUE,
} from '../../../platform/job/job.constants';

const lease = () => new Date(Date.now() + 120_000);
const json = (v: unknown) => JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;
@Injectable()
export class EffectVoiceRepository {
  constructor(@Inject(PrismaService) readonly db: PrismaService) {}
  private enqueue(tx: Prisma.TransactionClient, projectId: string, runId: string) {
    const payload = {
      schemaVersion: 2,
      taskType: 'VOICE_PREVIEW',
      projectId,
      runId,
      requestId: randomUUID(),
    } satisfies EffectVoicePreviewMessage;
    return tx.jobOutbox.upsert({
      where: {
        projectId_jobType_aggregateId: {
          projectId,
          jobType: EFFECT_TEMPLATE_MIX_JOB_TYPE,
          aggregateId: runId,
        },
      },
      create: {
        projectId,
        jobType: EFFECT_TEMPLATE_MIX_JOB_TYPE,
        aggregateId: runId,
        routingKey: EFFECT_TEMPLATE_MIX_QUEUE,
        payload,
      },
      update: {
        payload,
        status: 'PENDING',
        dispatchToken: null,
        attempts: 0,
        nextAttemptAt: new Date(),
        publishedAt: null,
        lastError: null,
      },
    });
  }
  list(projectId: string, workflowRunId: string, templateId: string) {
    return this.db.effectVoicePreview.findMany({
      where: { projectId, workflowRunId, templateId },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }
  async get(projectId: string, id: string) {
    const row = await this.db.effectVoicePreview.findFirst({ where: { projectId, id } });
    if (!row) throw new NotFoundException('试听任务不存在');
    return row;
  }
  async replay(projectId: string, key: string, requestHash: string) {
    const prior = await this.db.effectVoicePreviewRequest.findUnique({
      where: { projectId_idempotencyKey: { projectId, idempotencyKey: key } },
      include: { preview: true },
    });
    if (prior && prior.requestHash !== requestHash)
      throw new ConflictException('试听幂等键对应的请求已改变');
    return prior?.preview;
  }
  create(input: {
    projectId: string;
    workflowRunId: string;
    templateId: string;
    cacheKey: string;
    idempotencyKey: string;
    requestHash: string;
    snapshot: EffectVoicePreviewSnapshot;
  }) {
    return this.db.$transaction(async (tx) => {
      // Serialize both alias registration and cache lookup without holding any provider call.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.projectId + ':voice-preview'}))`;
      const key = { projectId: input.projectId, idempotencyKey: input.idempotencyKey };
      const replay = await tx.effectVoicePreviewRequest.findUnique({
        where: { projectId_idempotencyKey: key },
        include: { preview: true },
      });
      if (replay) {
        if (replay.requestHash !== input.requestHash)
          throw new ConflictException('试听幂等键对应的请求已改变');
        return replay.preview;
      }
      let row = await tx.effectVoicePreview.findFirst({
        where: {
          projectId: input.projectId,
          workflowRunId: input.workflowRunId,
          templateId: input.templateId,
          cacheKey: input.cacheKey,
          OR: [
            { status: { in: ['QUEUED', 'RUNNING'] } },
            { status: 'COMPLETED', fileObject: { status: 'AVAILABLE' } },
          ],
        },
        orderBy: { createdAt: 'desc' },
      });
      if (!row) {
        row = await tx.effectVoicePreview.create({
          data: {
            projectId: input.projectId,
            workflowRunId: input.workflowRunId,
            templateId: input.templateId,
            cacheKey: input.cacheKey,
            snapshot: json(input.snapshot),
          },
        });
        await this.enqueue(tx, input.projectId, row.id);
      }
      await tx.effectVoicePreviewRequest.create({
        data: { ...key, requestHash: input.requestHash, previewId: row.id },
      });
      return row;
    });
  }
  async claim(projectId: string, id: string) {
    const token = randomUUID();
    const changed = await this.db.effectVoicePreview.updateMany({
      where: { projectId, id, status: 'QUEUED' },
      data: { status: 'RUNNING', attemptToken: token, leaseExpiresAt: lease() },
    });
    if (!changed.count) return { terminal: true as const };
    const row = await this.get(projectId, id);
    return {
      terminal: false as const,
      attemptToken: token,
      snapshot: row.snapshot as unknown as EffectVoicePreviewSnapshot,
    };
  }
  held(projectId: string, id: string, token: string) {
    return {
      projectId,
      id,
      status: 'RUNNING',
      attemptToken: token || '00000000-0000-0000-0000-000000000000',
      leaseExpiresAt: { gt: new Date() },
    };
  }
  async heartbeat(projectId: string, id: string, token: string) {
    const changed = await this.db.effectVoicePreview.updateMany({
      where: this.held(projectId, id, token),
      data: { leaseExpiresAt: lease() },
    });
    if (!changed.count) throw new ConflictException('试听已取消或租约失效');
    return { accepted: true };
  }
  async submit(projectId: string, id: string, token: string) {
    const changed = await this.db.effectVoicePreview.updateMany({
      where: { ...this.held(projectId, id, token), submittedAt: null },
      data: { submittedAt: new Date(), leaseExpiresAt: lease() },
    });
    if (!changed.count) throw new ConflictException('试听提交已开始，禁止重复付费请求');
    return { accepted: true };
  }
  async fail(projectId: string, id: string, token: string, code: EffectVoicePreviewFailure) {
    const labels = {
      UNAUTHORIZED: '当前音色未获授权，请检查火山音色权限',
      PROVIDER_REJECTED: '火山配音请求失败，可检查配置后重试',
      SUBMISSION_UNKNOWN: '试听提交结果不明，已停止自动重试；请核查后再主动重试',
      INVALID_AUDIO: '试听音频校验失败，请重试',
    };
    const changed = await this.db.effectVoicePreview.updateMany({
      where: this.held(projectId, id, token),
      data: {
        status: 'FAILED',
        errorCode: code,
        errorMessage: labels[code],
        attemptToken: null,
        leaseExpiresAt: null,
      },
    });
    if (!changed.count) throw new ConflictException('试听已取消或租约失效');
    return { accepted: true };
  }
  async cancel(projectId: string, id: string) {
    await this.get(projectId, id);
    await this.db.effectVoicePreview.updateMany({
      where: { projectId, id, status: { in: ['QUEUED', 'RUNNING'] } },
      data: { status: 'CANCELLED', attemptToken: null, leaseExpiresAt: null },
    });
    return this.get(projectId, id);
  }
  async recoverExpired() {
    const rows = await this.db.effectVoicePreview.findMany({
      where: { status: 'RUNNING', leaseExpiresAt: { lt: new Date() } },
      take: 100,
    });
    for (const row of rows)
      await this.db.$transaction(async (tx) => {
        const unknown = !!row.submittedAt;
        const changed = await tx.effectVoicePreview.updateMany({
          where: { id: row.id, status: 'RUNNING', leaseExpiresAt: { lt: new Date() } },
          data: {
            status: unknown ? 'FAILED' : 'QUEUED',
            attemptToken: null,
            leaseExpiresAt: null,
            errorCode: unknown ? 'SUBMISSION_UNKNOWN' : null,
            errorMessage: unknown ? '试听提交结果不明，已停止自动重试；请核查后再主动重试' : null,
          },
        });
        if (changed.count && !unknown) await this.enqueue(tx, row.projectId, row.id);
      });
  }
}
