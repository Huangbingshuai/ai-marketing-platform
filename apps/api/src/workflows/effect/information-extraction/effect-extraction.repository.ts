import { randomUUID } from 'node:crypto';

import {
  EFFECT_EXTRACTION_BRANCHES,
  EFFECT_EXTRACTION_SCHEMA_VERSION,
  mergeEffectVideoConfig,
  type EffectExtractionResult,
  type EffectExtractionWarning,
  type EffectVideoConfig,
  type EffectVideoConfigOverride,
} from '@ai-marketing/contracts';
import { Inject, Injectable } from '@nestjs/common';
import type { EffectExtractionRun, Prisma } from '../../../generated/prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import {
  EFFECT_EXTRACTION_JOB_TYPE,
  EFFECT_EXTRACTION_QUEUE,
} from '../../../platform/job/job.constants';
import type {
  BranchOutputInput,
  CompleteRunInput,
  EffectExtractionInputSnapshot,
} from './effect-extraction.types';
import {
  canonicalHash,
  extractionSourceFingerprint,
  isSupportedExtractionMaterial,
} from './effect-extraction.validation';

const json = (value: unknown): Prisma.InputJsonValue => value as Prisma.InputJsonValue;
const leaseDate = (now: Date): Date => new Date(now.getTime() + 2 * 60 * 1000);

export type StartRunResult =
  | { kind: 'CREATED' | 'REPLAYED'; run: EffectExtractionRun }
  | { kind: 'NOT_FOUND' }
  | { kind: 'REVISION_CONFLICT' }
  | { kind: 'NOT_READY' }
  | { kind: 'ACTIVE_CONFLICT' }
  | { kind: 'KEY_CONFLICT' };

export type ClaimRunResult =
  | {
      kind: 'CLAIMED';
      run: EffectExtractionRun;
      attemptToken: string;
      inputSnapshot: EffectExtractionInputSnapshot;
    }
  | { kind: 'NOT_FOUND' }
  | { kind: 'BUSY' }
  | { kind: 'TERMINAL' }
  | { kind: 'ATTEMPTS_EXHAUSTED' };

@Injectable()
export class EffectExtractionRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  workspace(projectId: string, draftId: string) {
    return this.prisma.effectImportDraft.findFirst({
      where: { projectId, id: draftId },
      include: {
        products: {
          orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
          include: {
            materials: true,
            extractionRuns: {
              orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
              take: 1,
              include: { result: true },
            },
          },
        },
      },
    });
  }

  async startRun(
    projectId: string,
    draftId: string,
    productId: string,
    expectedRevision: number,
    idempotencyKey: string,
  ): Promise<StartRunResult> {
    const requestHash = canonicalHash({ projectId, draftId, productId, expectedRevision });
    return this.prisma.$transaction(async (transaction) => {
      const existing = await transaction.effectExtractionRun.findUnique({
        where: { projectId_idempotencyKey: { projectId, idempotencyKey } },
      });
      if (existing)
        return existing.requestHash === requestHash
          ? { kind: 'REPLAYED' as const, run: existing }
          : { kind: 'KEY_CONFLICT' as const };

      const locked = await transaction.$queryRaw<Array<{ id: string }>>`
        SELECT "id"
        FROM "effect_import_products"
        WHERE "projectId" = ${projectId}::uuid
          AND "draftId" = ${draftId}::uuid
          AND "id" = ${productId}::uuid
        FOR UPDATE
      `;
      if (locked.length !== 1) return { kind: 'NOT_FOUND' as const };

      const draft = await transaction.effectImportDraft.findFirst({
        where: { projectId, id: draftId },
        include: {
          products: { where: { id: productId }, include: { materials: true } },
        },
      });
      const product = draft?.products[0];
      if (!draft || !product) return { kind: 'NOT_FOUND' as const };
      if (draft.revision !== expectedRevision) return { kind: 'REVISION_CONFLICT' as const };
      if (
        draft.status !== 'COMPLETED' ||
        draft.validatedRevision !== draft.revision ||
        product.materials.some(
          (material) =>
            material.status === 'READY' &&
            isSupportedExtractionMaterial(material.mimeType, material.originalFileName) &&
            (!material.storageKey ||
              !material.originalFileName ||
              !material.mimeType ||
              !material.sizeBytes),
        )
      )
        return { kind: 'NOT_READY' as const };

      const active = await transaction.effectExtractionRun.findFirst({
        where: { projectId, draftId, productId, status: { in: ['QUEUED', 'RUNNING'] } },
      });
      if (active) return { kind: 'ACTIVE_CONFLICT' as const };

      const materials = product.materials
        .filter(
          (material) =>
            material.status === 'READY' &&
            isSupportedExtractionMaterial(material.mimeType, material.originalFileName) &&
            material.storageKey &&
            material.originalFileName &&
            material.mimeType &&
            material.sizeBytes,
        )
        .map((material) => ({
          id: material.id,
          type: material.type,
          originalFileName: material.originalFileName!,
          mimeType: material.mimeType!,
          sizeBytes: material.sizeBytes!,
          storageKey: material.storageKey!,
          updatedAt: material.updatedAt.toISOString(),
        }));
      const snapshot: EffectExtractionInputSnapshot = {
        schemaVersion: EFFECT_EXTRACTION_SCHEMA_VERSION,
        projectId,
        draftId,
        mode: draft.mode,
        sourceRevision: draft.revision,
        product: {
          id: product.id,
          name: product.name,
          category: product.category,
          sku: product.sku,
          commerceUrl: product.commerceUrl,
          effectiveConfig: mergeEffectVideoConfig(
            draft.globalConfig as EffectVideoConfig,
            product.configOverride as EffectVideoConfigOverride,
          ),
        },
        materials,
      };
      const sourceFingerprint = extractionSourceFingerprint(snapshot);
      const run = await transaction.effectExtractionRun.create({
        data: {
          projectId,
          draftId,
          productId,
          requestRevision: expectedRevision,
          idempotencyKey,
          requestHash,
          sourceFingerprint,
          inputSnapshot: json(snapshot),
          warnings: json([]),
        },
      });
      await transaction.effectExtractionBranchOutput.createMany({
        data: EFFECT_EXTRACTION_BRANCHES.map((branch) => ({
          projectId,
          runId: run.id,
          branch,
          warnings: json([]),
        })),
      });
      if (materials.length > 0)
        await transaction.effectExtractionFileHold.createMany({
          data: materials.map((material) => ({
            projectId,
            runId: run.id,
            storageKey: material.storageKey,
          })),
          skipDuplicates: true,
        });
      await transaction.jobOutbox.create({
        data: {
          projectId,
          jobType: EFFECT_EXTRACTION_JOB_TYPE,
          aggregateId: run.id,
          routingKey: EFFECT_EXTRACTION_QUEUE,
          payload: json({
            schemaVersion: EFFECT_EXTRACTION_SCHEMA_VERSION,
            projectId,
            runId: run.id,
            requestId: randomUUID(),
          }),
        },
      });
      return { kind: 'CREATED' as const, run };
    });
  }

  run(projectId: string, runId: string) {
    return this.prisma.effectExtractionRun.findFirst({
      where: { projectId, id: runId },
      include: { result: true },
    });
  }

  async cancelProjectRuns(
    projectId: string,
    now = new Date(),
  ): Promise<{ runIds: string[]; storageKeys: string[] }> {
    return this.prisma.$transaction(async (transaction) => {
      const runs = await transaction.effectExtractionRun.findMany({
        where: { projectId, status: { in: ['QUEUED', 'RUNNING'] } },
        select: { id: true },
      });
      const runIds = runs.map((run) => run.id);
      if (runIds.length === 0) return { runIds: [], storageKeys: [] };
      const [artifacts, branches] = await Promise.all([
        transaction.effectExtractionArtifact.findMany({
          where: { projectId, runId: { in: runIds } },
          select: { storageKey: true },
        }),
        transaction.effectExtractionBranchOutput.findMany({
          where: { projectId, runId: { in: runIds }, textStorageKey: { not: null } },
          select: { textStorageKey: true },
        }),
      ]);
      await transaction.effectExtractionRun.updateMany({
        where: { projectId, id: { in: runIds }, status: { in: ['QUEUED', 'RUNNING'] } },
        data: {
          status: 'CANCELLED',
          currentNode: 'CANCELLED',
          errorCode: 'PROJECT_EXIT_CANCELLED',
          errorMessage: '项目退出前已取消任务',
          attemptToken: null,
          leaseExpiresAt: null,
          heartbeatAt: now,
          completedAt: now,
        },
      });
      await transaction.effectExtractionFileHold.deleteMany({
        where: { projectId, runId: { in: runIds } },
      });
      await transaction.effectExtractionArtifact.deleteMany({
        where: { projectId, runId: { in: runIds } },
      });
      await transaction.effectExtractionBranchOutput.updateMany({
        where: { projectId, runId: { in: runIds } },
        data: { textStorageKey: null },
      });
      await transaction.jobOutbox.updateMany({
        where: { projectId, jobType: EFFECT_EXTRACTION_JOB_TYPE, aggregateId: { in: runIds } },
        data: { status: 'PUBLISHED', dispatchToken: null, publishedAt: now },
      });
      return {
        runIds,
        storageKeys: [
          ...artifacts.map((artifact) => artifact.storageKey),
          ...branches.flatMap((branch) => (branch.textStorageKey ? [branch.textStorageKey] : [])),
        ],
      };
    });
  }

  result(projectId: string, resultId: string) {
    return this.prisma.effectExtractionResult.findFirst({ where: { projectId, id: resultId } });
  }

  product(projectId: string, productId: string) {
    return this.prisma.effectImportProduct.findFirst({
      where: { projectId, id: productId },
      select: { id: true, name: true, category: true, sku: true },
    });
  }

  async updateResult(
    projectId: string,
    resultId: string,
    expectedRevision: number,
    result: EffectExtractionResult,
  ) {
    const savedAt = new Date();
    const updated = await this.prisma.effectExtractionResult.updateMany({
      where: { projectId, id: resultId, revision: expectedRevision },
      data: { draftResult: json(result), revision: { increment: 1 }, savedAt },
    });
    if (updated.count !== 1) return null;
    return this.result(projectId, resultId);
  }

  async claim(projectId: string, runId: string, now = new Date()): Promise<ClaimRunResult> {
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "effect_extraction_runs"
        WHERE "projectId" = ${projectId}::uuid AND "id" = ${runId}::uuid
        FOR UPDATE
      `;
      const run = await transaction.effectExtractionRun.findFirst({
        where: { projectId, id: runId },
      });
      if (!run) return { kind: 'NOT_FOUND' as const };
      if (run.status === 'COMPLETED' || run.status === 'FAILED' || run.status === 'CANCELLED')
        return { kind: 'TERMINAL' as const };
      if (run.status === 'RUNNING' && run.leaseExpiresAt && run.leaseExpiresAt > now)
        return { kind: 'BUSY' as const };
      if (run.attemptCount >= 3) {
        await transaction.effectExtractionRun.updateMany({
          where: { projectId, id: runId },
          data: {
            status: 'FAILED',
            errorCode: 'ATTEMPTS_EXHAUSTED',
            errorMessage: '提炼任务已达到最大重试次数',
            completedAt: now,
            attemptToken: null,
            leaseExpiresAt: null,
          },
        });
        await transaction.effectExtractionFileHold.deleteMany({ where: { projectId, runId } });
        return { kind: 'ATTEMPTS_EXHAUSTED' as const };
      }
      const attemptToken = randomUUID();
      const claimed = await transaction.effectExtractionRun.update({
        where: { projectId_id: { projectId, id: runId } },
        data: {
          status: 'RUNNING',
          progress: Math.max(run.progress, 1),
          currentNode: 'LOAD_AND_SNAPSHOT',
          attemptCount: { increment: 1 },
          attemptToken,
          leaseExpiresAt: leaseDate(now),
          heartbeatAt: now,
          startedAt: run.startedAt ?? now,
          errorCode: null,
          errorMessage: null,
        },
      });
      return {
        kind: 'CLAIMED' as const,
        run: claimed,
        attemptToken,
        inputSnapshot: claimed.inputSnapshot as EffectExtractionInputSnapshot,
      };
    });
  }

  async progress(
    projectId: string,
    runId: string,
    attemptToken: string,
    progress: number,
    currentNode: string,
    now = new Date(),
  ) {
    const updated = await this.prisma.effectExtractionRun.updateMany({
      where: {
        projectId,
        id: runId,
        status: 'RUNNING',
        attemptToken,
        leaseExpiresAt: { gt: now },
      },
      data: {
        progress,
        currentNode,
        heartbeatAt: now,
        leaseExpiresAt: leaseDate(now),
      },
    });
    return updated.count === 1;
  }

  async saveBranch(
    projectId: string,
    runId: string,
    attemptToken: string,
    input: BranchOutputInput,
    now = new Date(),
  ): Promise<boolean> {
    return this.prisma.$transaction(async (transaction) => {
      const run = await transaction.effectExtractionRun.count({
        where: {
          projectId,
          id: runId,
          status: 'RUNNING',
          attemptToken,
          leaseExpiresAt: { gt: now },
        },
      });
      if (run !== 1) return false;
      const structuredOutput =
        input.structuredOutput === undefined
          ? {}
          : { structuredOutput: json(input.structuredOutput) };
      await transaction.effectExtractionBranchOutput.upsert({
        where: { projectId_runId_branch: { projectId, runId, branch: input.branch } },
        create: {
          projectId,
          runId,
          branch: input.branch,
          status: input.status,
          ...structuredOutput,
          textStorageKey: input.textStorageKey ?? null,
          warnings: json(input.warnings),
          errorCode: input.errorCode ?? null,
          errorMessage: input.errorMessage ?? null,
          startedAt: now,
          completedAt: input.status === 'RUNNING' || input.status === 'PENDING' ? null : now,
        },
        update: {
          status: input.status,
          ...structuredOutput,
          textStorageKey: input.textStorageKey ?? null,
          warnings: json(input.warnings),
          errorCode: input.errorCode ?? null,
          errorMessage: input.errorMessage ?? null,
          startedAt: { set: now },
          completedAt: input.status === 'RUNNING' || input.status === 'PENDING' ? null : now,
        },
      });
      return true;
    });
  }

  async complete(
    projectId: string,
    runId: string,
    attemptToken: string,
    input: CompleteRunInput,
    now = new Date(),
  ) {
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "effect_extraction_runs"
        WHERE "projectId" = ${projectId}::uuid AND "id" = ${runId}::uuid
        FOR UPDATE
      `;
      const run = await transaction.effectExtractionRun.findFirst({
        where: { projectId, id: runId },
        include: { result: true },
      });
      if (!run) return { kind: 'NOT_FOUND' as const };
      if (run.status === 'COMPLETED' && run.result)
        return { kind: 'COMPLETED' as const, result: run.result };
      if (
        run.status !== 'RUNNING' ||
        run.attemptToken !== attemptToken ||
        !run.leaseExpiresAt ||
        run.leaseExpiresAt <= now
      )
        return { kind: 'LEASE_CONFLICT' as const };
      const result = await transaction.effectExtractionResult.create({
        data: {
          projectId,
          draftId: run.draftId,
          productId: run.productId,
          runId,
          schemaVersion: EFFECT_EXTRACTION_SCHEMA_VERSION,
          generatedResult: json(input.result),
          draftResult: json(input.result),
          provenance: json(input.provenance),
          conflictReport: json(input.conflictReport),
          sourceFingerprint: run.sourceFingerprint,
        },
      });
      await transaction.effectExtractionRun.update({
        where: { projectId_id: { projectId, id: runId } },
        data: {
          status: 'COMPLETED',
          progress: 100,
          currentNode: 'COMPLETED',
          warnings: json(input.warnings),
          errorCode: null,
          errorMessage: null,
          attemptToken: null,
          leaseExpiresAt: null,
          heartbeatAt: now,
          completedAt: now,
        },
      });
      await transaction.effectExtractionFileHold.deleteMany({ where: { projectId, runId } });
      return { kind: 'COMPLETED' as const, result };
    });
  }

  async fail(
    projectId: string,
    runId: string,
    attemptToken: string,
    input: {
      errorCode: string;
      errorMessage: string;
      retryable: boolean;
      warnings: EffectExtractionWarning[];
    },
    now = new Date(),
  ) {
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "effect_extraction_runs"
        WHERE "projectId" = ${projectId}::uuid AND "id" = ${runId}::uuid
        FOR UPDATE
      `;
      const run = await transaction.effectExtractionRun.findFirst({
        where: { projectId, id: runId },
      });
      if (!run) return 'NOT_FOUND' as const;
      if (run.status === 'COMPLETED' || run.status === 'FAILED' || run.status === 'CANCELLED')
        return 'TERMINAL' as const;
      if (run.status !== 'RUNNING' || run.attemptToken !== attemptToken)
        return 'LEASE_CONFLICT' as const;
      const retry = input.retryable && run.attemptCount < 3;
      await transaction.effectExtractionRun.update({
        where: { projectId_id: { projectId, id: runId } },
        data: {
          status: retry ? 'QUEUED' : 'FAILED',
          warnings: json(input.warnings),
          errorCode: input.errorCode,
          errorMessage: input.errorMessage,
          attemptToken: null,
          leaseExpiresAt: null,
          heartbeatAt: now,
          completedAt: retry ? null : now,
        },
      });
      if (retry) {
        await transaction.jobOutbox.updateMany({
          where: { projectId, jobType: EFFECT_EXTRACTION_JOB_TYPE, aggregateId: runId },
          data: {
            status: 'PENDING',
            dispatchToken: null,
            nextAttemptAt: now,
            publishedAt: null,
            lastError: null,
          },
        });
      } else {
        await transaction.effectExtractionFileHold.deleteMany({ where: { projectId, runId } });
      }
      return retry ? ('REQUEUED' as const) : ('FAILED' as const);
    });
  }

  async source(
    projectId: string,
    runId: string,
    materialId: string,
    attemptToken: string,
    now = new Date(),
  ) {
    const run = await this.prisma.effectExtractionRun.findFirst({
      where: {
        projectId,
        id: runId,
        status: 'RUNNING',
        attemptToken,
        leaseExpiresAt: { gt: now },
      },
    });
    if (!run) return null;
    const snapshot = run.inputSnapshot as EffectExtractionInputSnapshot;
    return snapshot.materials.find((material) => material.id === materialId) ?? null;
  }

  async authorizedRun(projectId: string, runId: string, attemptToken: string, now = new Date()) {
    return this.prisma.effectExtractionRun.findFirst({
      where: {
        projectId,
        id: runId,
        status: 'RUNNING',
        attemptToken,
        leaseExpiresAt: { gt: now },
      },
    });
  }

  async branches(projectId: string, runId: string, attemptToken: string) {
    if (!(await this.authorizedRun(projectId, runId, attemptToken))) return null;
    return this.prisma.effectExtractionBranchOutput.findMany({
      where: { projectId, runId },
      orderBy: { createdAt: 'asc' },
    });
  }

  artifactByKey(projectId: string, runId: string, idempotencyKey: string) {
    return this.prisma.effectExtractionArtifact.findUnique({
      where: { projectId_runId_idempotencyKey: { projectId, runId, idempotencyKey } },
    });
  }

  createArtifact(
    projectId: string,
    runId: string,
    attemptToken: string,
    input: {
      artifactKind: string;
      sourceId: string | null;
      idempotencyKey: string;
      originalFileName: string;
      mimeType: string;
      sizeBytes: number;
      storageKey: string;
    },
  ) {
    return this.prisma.$transaction(async (transaction) => {
      const authorized = await transaction.effectExtractionRun.count({
        where: {
          projectId,
          id: runId,
          status: 'RUNNING',
          attemptToken,
          leaseExpiresAt: { gt: new Date() },
        },
      });
      if (authorized !== 1) return null;
      return transaction.effectExtractionArtifact.create({
        data: { projectId, runId, ...input },
      });
    });
  }

  async recoverExpiredLeases(now = new Date()): Promise<{ requeued: number; failed: number }> {
    const candidates = await this.prisma.effectExtractionRun.findMany({
      where: { status: 'RUNNING', leaseExpiresAt: { lte: now } },
      select: { id: true, projectId: true },
      orderBy: { leaseExpiresAt: 'asc' },
      take: 50,
    });
    let requeued = 0;
    let failed = 0;
    for (const candidate of candidates) {
      const outcome = await this.prisma.$transaction(async (transaction) => {
        await transaction.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "effect_extraction_runs"
          WHERE "projectId" = ${candidate.projectId}::uuid
            AND "id" = ${candidate.id}::uuid
          FOR UPDATE
        `;
        const run = await transaction.effectExtractionRun.findFirst({
          where: {
            projectId: candidate.projectId,
            id: candidate.id,
            status: 'RUNNING',
            leaseExpiresAt: { lte: now },
          },
        });
        if (!run) return 'UNCHANGED' as const;
        if (run.attemptCount >= 3) {
          await transaction.effectExtractionRun.update({
            where: { projectId_id: { projectId: run.projectId, id: run.id } },
            data: {
              status: 'FAILED',
              errorCode: 'WORKER_LEASE_EXPIRED',
              errorMessage: 'Worker 多次失联，提炼任务已终止',
              attemptToken: null,
              leaseExpiresAt: null,
              completedAt: now,
            },
          });
          await transaction.effectExtractionFileHold.deleteMany({
            where: { projectId: run.projectId, runId: run.id },
          });
          return 'FAILED' as const;
        }
        await transaction.effectExtractionRun.update({
          where: { projectId_id: { projectId: run.projectId, id: run.id } },
          data: {
            status: 'QUEUED',
            errorCode: 'WORKER_LEASE_EXPIRED',
            errorMessage: 'Worker 租约过期，任务已重新排队',
            attemptToken: null,
            leaseExpiresAt: null,
          },
        });
        await transaction.jobOutbox.updateMany({
          where: {
            projectId: run.projectId,
            jobType: EFFECT_EXTRACTION_JOB_TYPE,
            aggregateId: run.id,
          },
          data: {
            status: 'PENDING',
            dispatchToken: null,
            nextAttemptAt: now,
            publishedAt: null,
            lastError: null,
          },
        });
        return 'REQUEUED' as const;
      });
      if (outcome === 'REQUEUED') requeued += 1;
      if (outcome === 'FAILED') failed += 1;
    }
    return { requeued, failed };
  }
}
