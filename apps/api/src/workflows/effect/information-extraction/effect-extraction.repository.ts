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
import { Inject, Injectable, Optional } from '@nestjs/common';
import type { EffectExtractionRun, Prisma } from '../../../generated/prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import {
  WorkflowWorkingRepository,
  type WorkingArtifactUpsertInput,
} from '../../../platform/workflow/workflow-working.repository';
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
  applyEffectExtractionManualOverrides,
  canonicalHash,
  effectExtractionDefaultsFromConfig,
  extractionSourceFingerprint,
  isSupportedExtractionMaterial,
  manualOverridesForResult,
  toEffectExtractionResultV2,
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
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Optional()
    @Inject(WorkflowWorkingRepository)
    private readonly workingRepository?: WorkflowWorkingRepository,
  ) {}

  workspace(projectId: string, draftId: string) {
    return this.prisma.effectImportDraft.findFirst({
      where: { projectId, id: draftId },
      include: {
        products: {
          where: { status: 'ACTIVE' },
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

  async currentDependencySnapshot(projectId: string, productId: string) {
    const workspace = await this.prisma.effectImportWorkspace.findUnique({
      where: { projectId },
      select: { workflowRunId: true },
    });
    if (!workspace) return null;
    const artifacts = await this.prisma.workingArtifact.findMany({
      where: {
        projectId,
        workflowRunId: workspace.workflowRunId,
        nodeId: 'SOURCE_IMPORT',
        artifactKey: {
          in: [
            `source-package:${productId}`,
            `effective-video-config:${productId}`,
            `global-video-config:${productId}`,
          ],
        },
      },
    });
    const sourcePackage = artifacts.find(
      (artifact) => artifact.artifactKey === `source-package:${productId}`,
    );
    const config =
      artifacts.find(
        (artifact) => artifact.artifactKey === `effective-video-config:${productId}`,
      ) ??
      artifacts.find((artifact) => artifact.artifactKey === `global-video-config:${productId}`);
    if (!sourcePackage || !config) return null;
    const nodeState = await this.prisma.workflowNodeState.findUnique({
      where: {
        projectId_workflowRunId_nodeId: {
          projectId,
          workflowRunId: workspace.workflowRunId,
          nodeId: 'INFORMATION_EXTRACTION',
        },
      },
    });
    return {
      sourcePackageRevision: sourcePackage.revision,
      effectiveVideoConfigRevision: config.revision,
      executionInputHash:
        nodeState?.executionInputHash ??
        '0e9561cfb83d50990a103b3896fe249a11fe27fa28985448187f93ec12116d72',
    };
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
          AND "status" = 'ACTIVE'
        FOR UPDATE
      `;
      if (locked.length !== 1) return { kind: 'NOT_FOUND' as const };

      const draft = await transaction.effectImportDraft.findFirst({
        where: { projectId, id: draftId },
        include: {
          products: {
            where: { id: productId, status: 'ACTIVE' },
            include: { materials: { include: { fileObject: true } } },
          },
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
            isSupportedExtractionMaterial(
              material.fileObject?.mimeType ?? material.mimeType,
              material.fileObject?.originalFileName ?? material.originalFileName,
            ) &&
            (material.fileObject?.storageKey ?? material.storageKey) &&
            (material.fileObject?.originalFileName ?? material.originalFileName) &&
            (material.fileObject?.mimeType ?? material.mimeType) &&
            (material.fileObject?.sizeBytes ?? material.sizeBytes),
        )
        .map((material) => ({
          id: material.id,
          type: material.type,
          originalFileName: (material.fileObject?.originalFileName ?? material.originalFileName)!,
          mimeType: (material.fileObject?.mimeType ?? material.mimeType)!,
          sizeBytes: (material.fileObject?.sizeBytes ?? material.sizeBytes)!,
          storageKey: (material.fileObject?.storageKey ?? material.storageKey)!,
          updatedAt: material.updatedAt.toISOString(),
        }));
      const workspace = await transaction.effectImportWorkspace.findUnique({
        where: { projectId },
        select: { workflowRunId: true },
      });
      if (!workspace) return { kind: 'NOT_FOUND' as const };
      const upstreamArtifacts = await transaction.workingArtifact.findMany({
        where: {
          projectId,
          workflowRunId: workspace.workflowRunId,
          nodeId: 'SOURCE_IMPORT',
          artifactKey: {
            in: [
              `source-package:${productId}`,
              `effective-video-config:${productId}`,
              `global-video-config:${productId}`,
            ],
          },
        },
      });
      const sourcePackage = upstreamArtifacts.find(
        (artifact) => artifact.artifactKey === `source-package:${productId}`,
      );
      const effectiveVideoConfig =
        upstreamArtifacts.find(
          (artifact) => artifact.artifactKey === `effective-video-config:${productId}`,
        ) ??
        upstreamArtifacts.find(
          (artifact) => artifact.artifactKey === `global-video-config:${productId}`,
        );
      if (
        !sourcePackage ||
        !effectiveVideoConfig ||
        [sourcePackage, effectiveVideoConfig].some(
          (artifact) => artifact.freshness !== 'CURRENT' || artifact.availability !== 'AVAILABLE',
        )
      )
        return { kind: 'NOT_READY' as const };
      const nodeState = await transaction.workflowNodeState.findUnique({
        where: {
          projectId_workflowRunId_nodeId: {
            projectId,
            workflowRunId: workspace.workflowRunId,
            nodeId: 'INFORMATION_EXTRACTION',
          },
        },
      });
      const previousResult = await transaction.effectExtractionResult.findFirst({
        where: { projectId, draftId, productId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { manualOverrides: true, generatedResult: true, draftResult: true },
      });
      const resultDefaults = effectExtractionDefaultsFromConfig(
        mergeEffectVideoConfig(
          draft.globalConfig as EffectVideoConfig,
          product.configOverride as EffectVideoConfigOverride,
        ),
      );
      const storedOverrides =
        previousResult?.manualOverrides &&
        typeof previousResult.manualOverrides === 'object' &&
        !Array.isArray(previousResult.manualOverrides)
          ? (previousResult.manualOverrides as Partial<EffectExtractionResult>)
          : {};
      const inheritedOverrides =
        Object.keys(storedOverrides).length > 0 || !previousResult
          ? storedOverrides
          : manualOverridesForResult(
              toEffectExtractionResultV2(previousResult.generatedResult, resultDefaults),
              toEffectExtractionResultV2(previousResult.draftResult, resultDefaults),
            );
      const snapshot: EffectExtractionInputSnapshot = {
        schemaVersion: EFFECT_EXTRACTION_SCHEMA_VERSION,
        projectId,
        draftId,
        mode: draft.mode,
        sourceRevision: draft.revision,
        globalVideoConfig: draft.globalConfig as EffectVideoConfig,
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
        manualOverrides: inheritedOverrides,
        dependencySnapshot: {
          sourcePackageRevision: sourcePackage.revision,
          effectiveVideoConfigRevision: effectiveVideoConfig.revision,
          executionInputHash:
            nodeState?.executionInputHash ??
            '0e9561cfb83d50990a103b3896fe249a11fe27fa28985448187f93ec12116d72',
        },
        dependencies: [
          ...[sourcePackage, effectiveVideoConfig].map((artifact) => ({
            sourceType: 'WORKING_ARTIFACT' as const,
            sourceNodeId: artifact.nodeId,
            sourceArtifactId: artifact.id,
            sourceKey:
              artifact.id === effectiveVideoConfig.id
                ? `effective-video-config:${productId}`
                : artifact.artifactKey,
            sourceRevision: artifact.revision,
          })),
          ...(nodeState
            ? [
                {
                  sourceType: 'EXECUTION_INPUT' as const,
                  sourceNodeId: nodeState.nodeId,
                  sourceKey: nodeState.nodeId,
                  sourceRevision: null,
                  sourceHash: nodeState.executionInputHash,
                },
              ]
            : []),
        ],
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
      include: { result: true, branches: { orderBy: { createdAt: 'asc' } } },
    });
  }

  result(projectId: string, resultId: string) {
    return this.prisma.effectExtractionResult.findFirst({ where: { projectId, id: resultId } });
  }

  product(projectId: string, productId: string) {
    return this.prisma.effectImportProduct.findFirst({
      where: { projectId, id: productId, status: 'ACTIVE' },
      select: { id: true, name: true, category: true, sku: true },
    });
  }

  workflowRunForDraft(projectId: string, draftId: string) {
    return this.prisma.effectImportDraft.findFirst({
      where: { projectId, id: draftId },
      select: { workspace: { select: { workflowRunId: true } } },
    });
  }

  async insightArtifact(projectId: string, draftId: string, productId: string) {
    const workflow = await this.workflowRunForDraft(projectId, draftId);
    if (!workflow) return null;
    return this.prisma.workingArtifact.findUnique({
      where: {
        projectId_workflowRunId_nodeId_artifactKey: {
          projectId,
          workflowRunId: workflow.workspace.workflowRunId,
          nodeId: 'INFORMATION_EXTRACTION',
          artifactKey: `marketing-insight:${productId}`,
        },
      },
    });
  }

  async hasNewerWorkingResult(
    projectId: string,
    productId: string,
    runId: string,
  ): Promise<boolean> {
    const run = await this.prisma.effectExtractionRun.findFirst({
      where: { projectId, id: runId, productId },
      select: {
        createdAt: true,
        draft: { select: { workspace: { select: { workflowRunId: true } } } },
      },
    });
    if (!run) return true;
    const artifact = await this.prisma.workingArtifact.findUnique({
      where: {
        projectId_workflowRunId_nodeId_artifactKey: {
          projectId,
          workflowRunId: run.draft.workspace.workflowRunId,
          nodeId: 'INFORMATION_EXTRACTION',
          artifactKey: `marketing-insight:${productId}`,
        },
      },
      select: { sourceRunId: true },
    });
    if (!artifact?.sourceRunId || artifact.sourceRunId === runId) return false;
    const currentSourceRun = await this.prisma.effectExtractionRun.findFirst({
      where: { projectId, id: artifact.sourceRunId, productId },
      select: { createdAt: true },
    });
    return Boolean(currentSourceRun && currentSourceRun.createdAt > run.createdAt);
  }

  async updateResult(
    projectId: string,
    resultId: string,
    expectedRevision: number,
    result: EffectExtractionResult,
    manualOverrides: Partial<EffectExtractionResult>,
  ) {
    const savedAt = new Date();
    const updated = await this.prisma.effectExtractionResult.updateMany({
      where: { projectId, id: resultId, revision: expectedRevision },
      data: {
        schemaVersion: EFFECT_EXTRACTION_SCHEMA_VERSION,
        draftResult: json(result),
        manualOverrides: json(manualOverrides),
        revision: { increment: 1 },
        savedAt,
      },
    });
    if (updated.count !== 1) return null;
    return this.result(projectId, resultId);
  }

  async commitValidatedResult(
    projectId: string,
    resultId: string,
    expectedRevision: number,
    workflowRunId: string,
    artifactKey: string,
    input: WorkingArtifactUpsertInput,
  ): Promise<
    | {
        kind: 'COMMITTED';
        artifact: { artifactId: string; artifactKey: string; revision: number; unchanged: boolean };
      }
    | { kind: 'NOT_FOUND' | 'REVISION_CONFLICT' | 'NOT_READY' }
  > {
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "effect_extraction_results"
        WHERE "projectId" = ${projectId}::uuid AND "id" = ${resultId}::uuid
        FOR UPDATE
      `;
      const result = await transaction.effectExtractionResult.findFirst({
        where: { projectId, id: resultId },
      });
      if (!result) return { kind: 'NOT_FOUND' as const };
      if (result.revision !== expectedRevision) return { kind: 'REVISION_CONFLICT' as const };
      const latestRun = await transaction.effectExtractionRun.findFirst({
        where: { projectId, draftId: result.draftId, productId: result.productId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        include: { result: { select: { id: true } } },
      });
      if (
        !latestRun ||
        latestRun.status !== 'COMPLETED' ||
        latestRun.id !== result.runId ||
        latestRun.result?.id !== result.id
      )
        return { kind: 'NOT_READY' as const };
      if (!this.workingRepository) throw new Error('WORKFLOW_WORKING_REPOSITORY_NOT_AVAILABLE');
      const [committed] = await this.workingRepository.commitValidatedArtifactsInTransaction(
        transaction,
        projectId,
        workflowRunId,
        'INFORMATION_EXTRACTION',
        [{ artifactKey, input }],
      );
      if (!committed) throw new Error('WORKING_ARTIFACT_COMMIT_FAILED');
      return {
        kind: 'COMMITTED' as const,
        artifact: {
          artifactId: committed.record.id,
          artifactKey,
          revision: committed.record.revision,
          unchanged: committed.unchanged,
        },
      };
    });
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
      if (run.status === 'COMPLETED' || run.status === 'FAILED')
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
      const snapshot = run.inputSnapshot as EffectExtractionInputSnapshot;
      const config = snapshot.globalVideoConfig ?? snapshot.product.effectiveConfig;
      const defaults = effectExtractionDefaultsFromConfig(config);
      const candidate = toEffectExtractionResultV2(input.result, defaults);
      const generatedResult: EffectExtractionResult = {
        ...candidate,
        productName: snapshot.product.name.trim() || candidate.productName,
        productCategory: snapshot.product.category.trim() || candidate.productCategory,
        durationSeconds: config.durationSeconds,
        aspectRatio: config.aspectRatio,
        resolution: config.resolution,
        deliveryChannels: config.deliveryChannel,
        disabledElements: [...new Set([...config.disabledElements, ...candidate.disabledElements])],
        visualStyleBaseline:
          config.styleTone && !candidate.visualStyleBaseline.includes(config.styleTone)
            ? `${config.styleTone}；${candidate.visualStyleBaseline}`.replace(/；$/, '')
            : candidate.visualStyleBaseline || config.styleTone,
      };
      const manualOverrides = snapshot.manualOverrides ?? {};
      const draftResult = applyEffectExtractionManualOverrides(generatedResult, manualOverrides);
      const result = await transaction.effectExtractionResult.create({
        data: {
          projectId,
          draftId: run.draftId,
          productId: run.productId,
          runId,
          schemaVersion: EFFECT_EXTRACTION_SCHEMA_VERSION,
          generatedResult: json(generatedResult),
          draftResult: json(draftResult),
          manualOverrides: json(manualOverrides),
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
      if (run.status === 'COMPLETED' || run.status === 'FAILED') return 'TERMINAL' as const;
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
