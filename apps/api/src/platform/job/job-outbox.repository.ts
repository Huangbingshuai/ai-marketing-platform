import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import type { JobOutbox } from '../../generated/prisma/client';

import { PrismaService } from '../../database/prisma.service';
import { JOB_OUTBOX_BATCH_SIZE, JOB_OUTBOX_CLAIM_SECONDS } from './job.constants';

@Injectable()
export class JobOutboxRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async claimPending(now = new Date()): Promise<JobOutbox[]> {
    const claimedUntil = new Date(now.getTime() + JOB_OUTBOX_CLAIM_SECONDS * 1000);
    const dispatchToken = randomUUID();
    return this.prisma.$transaction(async (transaction) => {
      const rows = await transaction.$queryRaw<JobOutbox[]>`
        SELECT *
        FROM "job_outbox"
        WHERE "status" = 'PENDING'::"JobOutboxStatus"
          AND "nextAttemptAt" <= ${now}
        ORDER BY "createdAt" ASC
        LIMIT ${JOB_OUTBOX_BATCH_SIZE}
        FOR UPDATE SKIP LOCKED
      `;
      if (rows.length === 0) return [];
      await transaction.jobOutbox.updateMany({
        where: { id: { in: rows.map((row) => row.id) }, status: 'PENDING' },
        data: { attempts: { increment: 1 }, dispatchToken, nextAttemptAt: claimedUntil },
      });
      return rows.map((row) => ({
        ...row,
        attempts: row.attempts + 1,
        dispatchToken,
        nextAttemptAt: claimedUntil,
      }));
    });
  }

  markPublished(
    projectId: string,
    id: string,
    dispatchToken: string,
    publishedAt = new Date(),
  ): Promise<{ count: number }> {
    return this.prisma.jobOutbox.updateMany({
      where: { projectId, id, status: 'PENDING', dispatchToken },
      data: { status: 'PUBLISHED', publishedAt, lastError: null, dispatchToken: null },
    });
  }

  markFailed(
    projectId: string,
    id: string,
    dispatchToken: string,
    error: string,
    nextAttemptAt: Date,
  ) {
    return this.prisma.jobOutbox.updateMany({
      where: { projectId, id, status: 'PENDING', dispatchToken },
      data: { dispatchToken: null, lastError: error.slice(0, 1000), nextAttemptAt },
    });
  }
}
