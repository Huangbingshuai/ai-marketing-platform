import { randomUUID } from 'node:crypto';
import { publishedRenderSource } from '../../../platform/workflow/effect-published-render-source';

import { Inject, Injectable } from '@nestjs/common';
import type {
  EffectTemplateMixDraft,
  EffectTemplateMixSampledMaterial,
  EffectTemplateMixFrozenSourceContext,
} from '@ai-marketing/contracts';
import type { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { WorkflowWorkingRepository } from '../../../platform/workflow/workflow-working.repository';
import { workflowStateHash } from '../../../platform/workflow/workflow-state-hash';
import {
  EFFECT_TEMPLATE_MIX_JOB_TYPE,
  EFFECT_TEMPLATE_MIX_QUEUE,
} from '../../../platform/job/job.constants';
import type { EffectTemplateMixAiSnapshot } from './effect-template-mix-ai.types';

const json = (value: unknown): Prisma.InputJsonValue => value as Prisma.InputJsonValue;
const leaseUntil = (now: Date): Date => new Date(now.getTime() + 2 * 60 * 1000);

@Injectable()
export class EffectTemplateMixAiRepository {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(WorkflowWorkingRepository)
    private readonly working: WorkflowWorkingRepository = new WorkflowWorkingRepository(prisma),
  ) {}

  listRecent(projectId: string, workflowRunId: string, templateId?: string) {
    return this.prisma.effectTemplateMixAiRun.findMany({
      where: { projectId, workflowRunId, ...(templateId ? { templateId } : {}) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 20,
    });
  }

  /** Consumption baselines and validated APPEND classifications outlive recent task activity. */
  async listHistory(projectId: string, workflowRunId: string, templateId?: string) {
    const [recent, terminal] = await Promise.all([
      this.listRecent(projectId, workflowRunId, templateId),
      this.prisma.effectTemplateMixAiRun.findMany({
        where: {
          projectId,
          workflowRunId,
          ...(templateId ? { templateId } : {}),
          status: { in: ['COMPLETED', 'FAILED'] },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
    ]);
    const durable = terminal.filter(
      (run) =>
        run.status === 'COMPLETED' ||
        Boolean((run.inputSnapshot as unknown as EffectTemplateMixAiSnapshot).incremental),
    );
    return [...new Map([...recent, ...durable].map((run) => [run.id, run])).values()].sort(
      (left, right) =>
        right.createdAt.getTime() - left.createdAt.getTime() || right.id.localeCompare(left.id),
    );
  }

  findByIdempotencyKey(projectId: string, idempotencyKey: string) {
    return this.prisma.effectTemplateMixAiRun.findUnique({
      where: { projectId_idempotencyKey: { projectId, idempotencyKey } },
      include: { workflowRun: { select: { parentWorkflowRunId: true } } },
    });
  }
  async cancelAppend(projectId: string, runId: string, now = new Date()) {
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "effect_template_mix_ai_runs"
        WHERE "projectId" = ${projectId}::uuid AND "id" = ${runId}::uuid FOR UPDATE
      `;
      const run = await transaction.effectTemplateMixAiRun.findFirst({
        where: { projectId, id: runId },
      });
      if (!run) return { kind: 'NOT_FOUND' as const };
      if (!(run.inputSnapshot as unknown as EffectTemplateMixAiSnapshot).incremental)
        return { kind: 'NOT_APPEND' as const };
      if (!['QUEUED', 'RUNNING'].includes(run.status)) return { kind: 'TERMINAL' as const, run };
      // Completion/checkpoint writes lock the same task row and require RUNNING + the lease token.
      // Do not rewrite the draft or any existing timeline/packaging artifact on cancellation.
      const cancelled = await transaction.effectTemplateMixAiRun.update({
        where: { projectId_id: { projectId, id: runId } },
        data: {
          status: 'CANCELLED',
          attemptToken: null,
          leaseExpiresAt: null,
          errorCode: 'USER_CANCELLED',
          errorMessage: '已取消局部更新，已有成片保持不变',
          completedAt: now,
        },
      });
      return { kind: 'CANCELLED' as const, run: cancelled };
    });
  }
  recordAppendContinuation(projectId: string, runId: string, failed: boolean, retryable = false) {
    return this.prisma.effectTemplateMixAiRun.updateMany({
      where: { projectId, id: runId, status: 'COMPLETED' },
      // Recoverable failures keep their durable phase/budget. Never reset RETRY_1/2
      // back to PENDING on redelivery, or a restart could retry forever.
      data: {
        ...(!failed || !retryable
          ? {
              errorCode: failed ? 'APPEND_CONTINUATION_FAILED' : null,
            }
          : {}),
        errorMessage: failed ? '新增工程已保存，结果同步衔接未完成' : null,
      },
    });
  }

  /** Replay only persistence/coordination of new-protocol completed APPENDs.
   * The terminal claim does not regenerate selections, trims or finished packaging.
   */
  async recoverAppendContinuations(now = new Date()): Promise<void> {
    const phases = [
      'APPEND_CONTINUATION_PENDING',
      'APPEND_CONTINUATION_RETRY_1',
      'APPEND_CONTINUATION_RETRY_2',
    ];
    const rows = await this.prisma.effectTemplateMixAiRun.findMany({
      where: {
        status: 'COMPLETED',
        errorCode: { in: phases },
        updatedAt: { lte: new Date(now.getTime() - 120_000) },
      },
      orderBy: { updatedAt: 'asc' },
      take: 50,
    });
    for (const row of rows) {
      const snapshot = row.inputSnapshot as unknown as EffectTemplateMixAiSnapshot;
      if (!snapshot.incremental || snapshot.sourceOperation?.protocol !== 'FROZEN_RENDER_V1')
        continue;
      const attempt = phases.indexOf(row.errorCode!);
      await this.prisma.$transaction(async (tx) => {
        const changed = await tx.effectTemplateMixAiRun.updateMany({
          where: {
            projectId: row.projectId,
            id: row.id,
            status: 'COMPLETED',
            errorCode: row.errorCode,
            updatedAt: row.updatedAt,
          },
          data: { errorCode: phases[attempt + 1] ?? 'APPEND_CONTINUATION_FAILED' },
        });
        if (!changed.count || attempt >= 2) return;
        await tx.jobOutbox.updateMany({
          where: {
            projectId: row.projectId,
            aggregateId: row.id,
            jobType: EFFECT_TEMPLATE_MIX_JOB_TYPE,
          },
          data: {
            status: 'PENDING',
            dispatchToken: null,
            nextAttemptAt: now,
            publishedAt: null,
            lastError: null,
          },
        });
      });
    }
  }
  async retryAppend(projectId: string, runId: string, now = new Date()) {
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "effect_template_mix_ai_runs"
        WHERE "projectId" = ${projectId}::uuid AND "id" = ${runId}::uuid FOR UPDATE
      `;
      const run = await transaction.effectTemplateMixAiRun.findFirst({
        where: { projectId, id: runId },
      });
      if (!run) return { kind: 'NOT_FOUND' as const };
      const snapshot = run.inputSnapshot as unknown as EffectTemplateMixAiSnapshot;
      if (
        !snapshot.incremental ||
        snapshot.sourceOperation?.protocol !== 'FROZEN_RENDER_V1' ||
        !snapshot.workspaceHash
      )
        return { kind: 'UNSUPPORTED' as const };
      if (['QUEUED', 'RUNNING', 'COMPLETED'].includes(run.status))
        return { kind: 'REPLAYED' as const, run };
      if (run.status !== 'FAILED') return { kind: 'CANCELLED' as const };
      await transaction.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "workflow_node_states"
        WHERE "projectId" = ${projectId}::uuid AND "workflowRunId" = ${run.workflowRunId}::uuid
          AND "nodeId" = 'TEMPLATE_MIX' FOR UPDATE
      `;
      const state = await transaction.workflowNodeState.findUnique({
        where: {
          projectId_workflowRunId_nodeId: {
            projectId,
            workflowRunId: run.workflowRunId,
            nodeId: 'TEMPLATE_MIX',
          },
        },
      });
      const entry = (state?.state as unknown as EffectTemplateMixDraft)?.templates?.find(
        ({ id }) => id === run.templateId,
      );
      if (
        !entry ||
        workflowStateHash(entry.workspace) !== snapshot.workspaceHash ||
        (entry.materialRoleEditVersion ?? 0) !== (snapshot.materialRoleEditVersion ?? 0)
      )
        return { kind: 'DRAFT_CONFLICT' as const };
      const active = await transaction.effectTemplateMixAiRun.findFirst({
        where: {
          projectId,
          workflowRunId: run.workflowRunId,
          templateId: run.templateId,
          status: { in: ['QUEUED', 'RUNNING'] },
        },
      });
      if (active) return { kind: 'ACTIVE_CONFLICT' as const };
      if (
        await transaction.effectPackagingRun.count({
          where: {
            projectId,
            workflowRunId: run.workflowRunId,
            templateId: run.templateId,
            status: { in: ['QUEUED', 'RUNNING'] },
          },
        })
      )
        return { kind: 'PACKAGING_LOCKED' as const };
      const outbox = await transaction.jobOutbox.findFirst({
        where: {
          projectId,
          jobType: EFFECT_TEMPLATE_MIX_JOB_TYPE,
          aggregateId: runId,
        },
        select: { id: true },
      });
      if (!outbox) return { kind: 'MISSING_DELIVERY' as const };
      const retried = await transaction.effectTemplateMixAiRun.update({
        where: { projectId_id: { projectId, id: runId } },
        data: {
          status: 'QUEUED',
          attemptToken: null,
          leaseExpiresAt: null,
          errorCode: null,
          errorMessage: null,
          completedAt: null,
          queuedAt: now,
          // An explicit user recovery grants two attempts, without resetting
          // history or discarding any successful, frozen checkpoint.
          maxAttempts: Math.max(run.maxAttempts, run.attemptCount + 2),
        },
      });
      await transaction.jobOutbox.updateMany({
        where: { projectId, id: outbox.id },
        data: {
          status: 'PENDING',
          dispatchToken: null,
          nextAttemptAt: now,
          publishedAt: null,
          lastError: null,
        },
      });
      return { kind: 'RETRIED' as const, run: retried };
    });
  }
  latestUnpublishedChild(projectId: string, workflowRunId: string, templateId: string) {
    return this.prisma.effectTemplateMixAiRun.findFirst({
      where: {
        projectId,
        templateId,
        workflowRun: {
          parentWorkflowRunId: workflowRunId,
          forkNodeId: 'TEMPLATE_MIX',
          branchPublishedAt: null,
        },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  }
  activeUnpublishedChild(projectId: string, workflowRunId: string, templateId: string) {
    return this.prisma.effectTemplateMixAiRun.findFirst({
      where: {
        projectId,
        templateId,
        status: { in: ['QUEUED', 'RUNNING'] },
        workflowRun: {
          parentWorkflowRunId: workflowRunId,
          forkNodeId: 'TEMPLATE_MIX',
          branchPublishedAt: null,
        },
      },
      select: { id: true },
    });
  }

  /**
   * All successful fills frozen into this Run at each fork's creation boundary.
   *
   * A fork copies the clips it branches from, and a fill that runs in the child is the child's own
   * row. Packaging and exporting do neither — they branch without filling — and neither did any
   * branch made before the clips and their fills started travelling together. Those Runs hold the
   * rendered files but no fill row, and since the AI 归槽 pool is read back from fill rows rather
   * than from the draft, their material library came back as it looked before the fill.
   *
   * The files are what the two Runs share, so the caller re-points the ancestor's frozen snapshot at
   * this Run's own clips. Walking further up when the nearest ancestor never filled keeps the
   * library populated for a chain of packaging branches, and a snapshot that no longer describes
   * these clips is dropped by the caller instead of showing a pool that is not this Run's.
   */
  async inheritedMixAiRuns(projectId: string, workflowRunId: string, templateId?: string) {
    const collected = new Map<string, Awaited<ReturnType<typeof this.listRecent>>[number]>();
    const visited = new Set([workflowRunId]);
    let cursor = await this.prisma.workflowRun.findFirst({
      where: { id: workflowRunId, projectId },
      select: { parentWorkflowRunId: true, createdAt: true },
    });
    if (!cursor) return [];
    let inheritedAt = cursor.createdAt;
    while (cursor?.parentWorkflowRunId && !visited.has(cursor.parentWorkflowRunId)) {
      const parentId: string = cursor.parentWorkflowRunId;
      visited.add(parentId);
      const fills = await this.prisma.effectTemplateMixAiRun.findMany({
        where: {
          projectId,
          workflowRunId: parentId,
          ...(templateId ? { templateId } : {}),
          status: 'COMPLETED',
          outputVariantId: { not: null },
          // A fork inherits its creation snapshot, not later in-place updates of its parent.
          // Otherwise a parent APPEND consumes additions the child never incorporated.
          completedAt: { lte: inheritedAt },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      // Keep every consumed addition. A newer trim-only task must not erase an earlier APPEND.
      // Nearest/newest tasks still come first for classification precedence.
      for (const fill of fills) if (!collected.has(fill.id)) collected.set(fill.id, fill);
      cursor = await this.prisma.workflowRun.findFirst({
        where: { id: parentId, projectId },
        select: { parentWorkflowRunId: true, createdAt: true },
      });
      if (cursor && cursor.createdAt < inheritedAt) inheritedAt = cursor.createdAt;
    }
    return [...collected.values()];
  }

  async hasSuccessfulRenderBatch(projectId: string, workflowRunId: string): Promise<boolean> {
    const batch = await this.prisma.effectSegmentRenderBatch.findFirst({
      where: { projectId, workflowRunId, archivedAt: null },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: {
        status: true,
        sourcePromptArtifactId: true,
        sourcePromptRevision: true,
        sourcePromptHash: true,
      },
    });
    if (batch?.status !== 'COMPLETED') return false;
    const prompt = await this.prisma.workingArtifact.findFirst({
      where: {
        id: batch.sourcePromptArtifactId,
        projectId,
        workflowRunId,
        nodeId: 'PROMPT_GENERATION',
        revision: batch.sourcePromptRevision,
        contentHash: batch.sourcePromptHash,
        freshness: 'CURRENT',
        availability: 'AVAILABLE',
      },
      select: { id: true },
    });
    return Boolean(prompt);
  }

  async templateHasDownstream(
    projectId: string,
    workflowRunId: string,
    templateId: string,
  ): Promise<boolean> {
    const [fill, packaging, output, artifact, branch] = await Promise.all([
      this.prisma.effectTemplateMixAiRun.findFirst({
        where: {
          projectId,
          workflowRunId,
          templateId,
          OR: [
            { status: { in: ['QUEUED', 'RUNNING', 'COMPLETED'] } },
            { outputVariantId: { not: null } },
          ],
        },
        select: { id: true },
      }),
      this.prisma.effectPackagingRun.findFirst({
        where: { projectId, workflowRunId, templateId },
        select: { id: true },
      }),
      this.prisma.effectFinalOutputRun.findFirst({
        where: { projectId, workflowRunId, templateId },
        select: { id: true },
      }),
      this.prisma.workingArtifact.findFirst({
        where: {
          projectId,
          workflowRunId,
          OR: [
            { artifactKey: `mix-template:${templateId}` },
            { artifactKey: { startsWith: `timeline-project:${templateId}:` } },
            { artifactKey: { startsWith: `timeline-package:${templateId}:` } },
            { artifactKey: `final-delivery:${templateId}` },
          ],
        },
        select: { id: true },
      }),
      this.prisma.workflowRun.findFirst({
        where: {
          projectId,
          workflow: 'EFFECT',
          workflowSpace: 'EFFECT',
          forkTemplateId: templateId,
          branchPublishedAt: { not: null },
        },
        select: { id: true },
      }),
    ]);
    return Boolean(fill || packaging || output || artifact || branch);
  }

  async lockedTemplateIds(projectId: string, workflowRunId: string): Promise<string[]> {
    const rows = await this.prisma.effectTemplateMixAiRun.findMany({
      where: { projectId, workflowRunId, status: { in: ['QUEUED', 'RUNNING'] } },
      distinct: ['templateId'],
      select: { templateId: true, inputSnapshot: true },
    });
    return rows
      .filter((row) => !(row.inputSnapshot as { incremental?: unknown } | null)?.incremental)
      .map(({ templateId }) => templateId);
  }

  async packagedTemplateIds(projectId: string, workflowRunId: string): Promise<string[]> {
    const [packagingRuns, currentPackages] = await Promise.all([
      this.prisma.effectPackagingRun.findMany({
        where: { projectId, workflowRunId },
        distinct: ['templateId'],
        select: { templateId: true },
      }),
      this.prisma.workingArtifact.findMany({
        where: {
          projectId,
          workflowRunId,
          nodeId: 'TEMPLATE_MIX',
          artifactKey: { startsWith: 'timeline-package:' },
          freshness: 'CURRENT',
          availability: 'AVAILABLE',
        },
        select: { artifactKey: true },
      }),
    ]);
    const templateIds = new Set(packagingRuns.map(({ templateId }) => templateId));
    for (const { artifactKey } of currentPackages) {
      const [, templateId] = artifactKey.split(':', 2);
      if (templateId) templateIds.add(templateId);
    }
    return [...templateIds];
  }

  async activePackagingTemplateIds(projectId: string, workflowRunId: string): Promise<string[]> {
    const rows = await this.prisma.effectPackagingRun.findMany({
      where: { projectId, workflowRunId, status: { in: ['QUEUED', 'RUNNING'] } },
      distinct: ['templateId'],
      select: { templateId: true },
    });
    return rows.map(({ templateId }) => templateId);
  }

  async successfulPackagingTemplateIds(
    projectId: string,
    workflowRunId: string,
  ): Promise<string[]> {
    const lineage = new Set<string>();
    let cursor: string | null = workflowRunId;
    while (cursor && !lineage.has(cursor)) {
      lineage.add(cursor);
      const branch: { parentWorkflowRunId: string | null } | null =
        await this.prisma.workflowRun.findFirst({
          where: { projectId, id: cursor, workflow: 'EFFECT', workflowSpace: 'EFFECT' },
          select: { parentWorkflowRunId: true },
        });
      cursor = branch?.parentWorkflowRunId ?? null;
    }
    const [runs, packages] = await Promise.all([
      this.prisma.effectPackagingRun.findMany({
        where: { projectId, workflowRunId: { in: [...lineage] }, status: 'COMPLETED' },
        distinct: ['templateId'],
        select: { templateId: true },
      }),
      this.prisma.workingArtifact.findMany({
        where: {
          projectId,
          workflowRunId,
          nodeId: 'TEMPLATE_MIX',
          artifactKey: { startsWith: 'timeline-package:' },
          availability: 'AVAILABLE',
        },
        select: { artifactKey: true, payload: true },
      }),
    ]);
    return [
      ...new Set([
        ...runs.map((run) => run.templateId),
        ...packages.flatMap(({ artifactKey, payload }) => {
          const voices = (payload as { voices?: Record<string, unknown> } | null)?.voices;
          return voices && Object.keys(voices).length ? (artifactKey.split(':')[1] ?? []) : [];
        }),
      ]),
    ];
  }

  find(projectId: string, runId: string) {
    return this.prisma.effectTemplateMixAiRun.findFirst({ where: { projectId, id: runId } });
  }
  async sourceOperation(projectId: string, workflowRunId: string, templateId: string, id: string) {
    const item = await this.prisma.effectFinalOutputItem.findFirst({
      where: {
        projectId,
        run: { workflowRunId, templateId },
        snapshot: { path: ['sourceOperation', 'id'], equals: id },
      },
      include: { run: { include: { items: true } } },
    });
    if (
      !item ||
      item.run.items.some((row) =>
        Boolean((row.snapshot as unknown as { sourceRefresh?: unknown }).sourceRefresh),
      )
    )
      return null;
    return (item.snapshot as unknown as { sourceOperation: EffectTemplateMixFrozenSourceContext })
      .sourceOperation;
  }
  findOperationRun(projectId: string, workflowRunId: string, templateId: string, id: string) {
    return this.prisma.effectTemplateMixAiRun.findFirst({
      where: {
        projectId,
        workflowRunId,
        templateId,
        inputSnapshot: { path: ['sourceOperation', 'id'], equals: id },
      },
      orderBy: { createdAt: 'desc' },
    });
  }
  async frozenFilesAvailable(
    projectId: string,
    materials: EffectTemplateMixAiSnapshot['materials'],
  ) {
    const files = await this.prisma.fileObject.findMany({
      where: {
        projectId,
        id: { in: materials.map((material) => material.fileObjectId) },
        status: 'AVAILABLE',
      },
    });
    return materials.every(
      (material) =>
        material.adoptedSource &&
        files.some(
          (file) =>
            file.id === material.fileObjectId &&
            file.sha256 === material.adoptedSource!.contentHash,
        ),
    );
  }

  async sourceArtifacts(
    projectId: string,
    workflowRunId: string,
    transaction?: Prisma.TransactionClient,
  ) {
    // Use the same authoritative lineage as the library. A CURRENT database clone can still be
    // an obsolete snapshot; never freeze it as a source for a newly filled template.
    const working = transaction
      ? new WorkflowWorkingRepository(transaction as unknown as PrismaService)
      : this.working;
    return (await working.listArtifacts(projectId, { workflowRunId }))
      .map(publishedRenderSource)
      .filter(
        (artifact) =>
          ['PROMPT_GENERATION', 'SEGMENT_RENDER'].includes(artifact.nodeId) &&
          artifact.freshness === 'CURRENT' &&
          artifact.availability === 'AVAILABLE' &&
          (artifact.metadata as { branchSourceOwner?: boolean } | null)?.branchSourceOwner !==
            false,
      );
  }

  async historicalRenderArtifacts(projectId: string, ids: string[]) {
    return this.prisma.workingArtifact.findMany({
      where: { projectId, id: { in: ids }, nodeId: 'SEGMENT_RENDER' },
      include: { dependencies: true },
    });
  }

  async mediaFingerprints(projectId: string, ids: string[]) {
    return this.prisma.fileObject.findMany({
      where: { projectId, id: { in: ids }, status: 'AVAILABLE' },
      select: { id: true, sha256: true },
    });
  }

  async selectedFile(projectId: string, runId: string, materialId: string, attemptToken: string) {
    const run = await this.prisma.effectTemplateMixAiRun.findFirst({
      where: {
        projectId,
        id: runId,
        status: 'RUNNING',
        attemptToken,
        leaseExpiresAt: { gt: new Date() },
      },
    });
    const selections = Array.isArray(run?.selectionResult) ? run.selectionResult : [];
    if (
      !run ||
      !selections.some((item) => (item as { materialId?: unknown }).materialId === materialId)
    )
      return null;
    const frozen = (run.inputSnapshot as unknown as EffectTemplateMixAiSnapshot)?.materials?.find(
      (material) => material.artifactId === materialId,
    );
    if (!frozen) return null;
    if (
      (run.inputSnapshot as unknown as EffectTemplateMixAiSnapshot).sourceOperation?.protocol ===
      'FROZEN_RENDER_V1'
    ) {
      const file = await this.prisma.fileObject.findFirst({
        where: {
          projectId,
          id: frozen.fileObjectId,
          status: 'AVAILABLE',
          sha256: frozen.adoptedSource?.contentHash ?? '',
        },
      });
      if (!file) return null;
      return {
        run,
        artifact: { id: frozen.artifactId },
        file: {
          storageKey: file.storageKey,
          originalFileName: file.originalFileName,
          mimeType: file.mimeType,
          sizeBytes: Number(file.sizeBytes),
        },
      };
    }
    const artifact = (await this.sourceArtifacts(projectId, run.workflowRunId)).find(
      (source) => source.id === materialId && source.nodeId === 'SEGMENT_RENDER',
    );
    if (
      artifact?.revision !== frozen.artifactRevision ||
      artifact.contentHash !== frozen.contentHash ||
      !artifact?.storageKey ||
      !artifact.originalFileName ||
      !artifact.mimeType ||
      !artifact.sizeBytes
    )
      return null;
    return {
      run,
      artifact,
      file: {
        storageKey: artifact.storageKey,
        originalFileName: artifact.originalFileName,
        mimeType: artifact.mimeType,
        sizeBytes: artifact.sizeBytes,
      },
    };
  }

  async create(input: {
    projectId: string;
    workflowRunId: string;
    templateId: string;
    targetVariantId: string | null;
    expectedDraftRevision: number;
    templateEditVersion: number;
    idempotencyKey: string;
    requestHash: string;
    inputHash: string;
    snapshot: EffectTemplateMixAiSnapshot;
    initialClassifications?: unknown[];
    initialSelections?: unknown[];
    initialTrims?: unknown[];
  }) {
    return this.prisma.$transaction(async (transaction) => {
      const existing = await transaction.effectTemplateMixAiRun.findUnique({
        where: {
          projectId_idempotencyKey: {
            projectId: input.projectId,
            idempotencyKey: input.idempotencyKey,
          },
        },
      });
      if (existing)
        return existing.requestHash === input.requestHash
          ? { kind: 'REPLAYED' as const, run: existing }
          : { kind: 'KEY_CONFLICT' as const };
      await transaction.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "workflow_node_states"
        WHERE "projectId" = ${input.projectId}::uuid
          AND "workflowRunId" = ${input.workflowRunId}::uuid
          AND "nodeId" = 'TEMPLATE_MIX'
        FOR UPDATE
      `;
      const nodeState = await transaction.workflowNodeState.findUnique({
        where: {
          projectId_workflowRunId_nodeId: {
            projectId: input.projectId,
            workflowRunId: input.workflowRunId,
            nodeId: 'TEMPLATE_MIX',
          },
        },
      });
      if (!nodeState) return { kind: 'STALE_INPUT' as const };
      const currentDraft = nodeState.state as unknown as EffectTemplateMixDraft;
      const targetEntry = currentDraft.templates.find((entry) => entry.id === input.templateId);
      if (!targetEntry) return { kind: 'STALE_INPUT' as const };
      if (
        await transaction.effectPackagingRun.count({
          where: {
            projectId: input.projectId,
            workflowRunId: input.workflowRunId,
            templateId: input.templateId,
            status: { in: ['QUEUED', 'RUNNING'] },
          },
        })
      )
        return { kind: 'PACKAGING_LOCKED' as const };
      // An already-committed package is not a reason to refuse the fill any more: a fill always runs
      // on a branch of its own, so it cannot mutate the packaged result in place. Only packaging
      // that is still running is refused, because two workers must not write the same Run at once.
      const active = await transaction.effectTemplateMixAiRun.findFirst({
        where: {
          projectId: input.projectId,
          workflowRunId: input.workflowRunId,
          templateId: input.templateId,
          status: { in: ['QUEUED', 'RUNNING'] },
        },
      });
      if (active) return { kind: 'ACTIVE_CONFLICT' as const, run: active };
      if (nodeState.revision !== input.expectedDraftRevision)
        return { kind: 'STALE_INPUT' as const };
      const frozenSources = [
        ...input.snapshot.promptArtifacts.map((item) => ({
          id: item.id,
          revision: item.revision,
          contentHash: item.contentHash,
        })),
        ...input.snapshot.materials.map((item) => ({
          id: item.artifactId,
          revision: item.artifactRevision,
          contentHash: item.contentHash,
        })),
      ];
      const currentSources = await this.sourceArtifacts(
        input.projectId,
        input.workflowRunId,
        transaction,
      );
      const currentById = new Map(currentSources.map((item) => [item.id, item]));
      if (
        input.snapshot.sourceOperation?.protocol === 'FROZEN_RENDER_V1'
          ? !(await this.frozenFilesAvailable(input.projectId, input.snapshot.materials))
          : frozenSources.some((source) => {
              const current = currentById.get(source.id);
              return (
                current?.revision !== source.revision || current.contentHash !== source.contentHash
              );
            })
      )
        return { kind: 'STALE_INPUT' as const };
      const lockedDraft: EffectTemplateMixDraft = {
        ...currentDraft,
        templates: currentDraft.templates.map((entry) =>
          entry.id === input.templateId
            ? { ...entry, aiFillLocked: !input.snapshot.incremental }
            : entry,
        ),
      };
      await transaction.workflowNodeState.update({
        where: { id: nodeState.id },
        data: {
          state: json(lockedDraft),
          contentHash: workflowStateHash(lockedDraft),
          revision: { increment: 1 },
          savedAt: new Date(),
        },
      });
      const run = await transaction.effectTemplateMixAiRun.create({
        data: {
          projectId: input.projectId,
          workflowRunId: input.workflowRunId,
          templateId: input.templateId,
          targetVariantId: input.targetVariantId,
          expectedDraftRevision: input.expectedDraftRevision,
          templateEditVersion: input.templateEditVersion,
          idempotencyKey: input.idempotencyKey,
          requestHash: input.requestHash,
          inputHash: input.inputHash,
          inputSnapshot: json(input.snapshot),
          ...(input.initialClassifications
            ? { classificationResult: json(input.initialClassifications) }
            : {}),
          ...(input.initialSelections ? { selectionResult: json(input.initialSelections) } : {}),
          ...(input.initialTrims ? { trimResult: json(input.initialTrims) } : {}),
        },
      });
      await transaction.jobOutbox.create({
        data: {
          projectId: input.projectId,
          jobType: EFFECT_TEMPLATE_MIX_JOB_TYPE,
          aggregateId: run.id,
          routingKey: EFFECT_TEMPLATE_MIX_QUEUE,
          payload: json({
            schemaVersion: 1,
            projectId: input.projectId,
            runId: run.id,
            requestId: randomUUID(),
          }),
        },
      });
      return { kind: 'CREATED' as const, run };
    });
  }

  async claim(projectId: string, runId: string, now = new Date()) {
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "effect_template_mix_ai_runs"
        WHERE "projectId" = ${projectId}::uuid AND "id" = ${runId}::uuid FOR UPDATE
      `;
      const run = await transaction.effectTemplateMixAiRun.findFirst({
        where: { projectId, id: runId },
      });
      if (!run) return { kind: 'NOT_FOUND' as const };
      if (run.status === 'COMPLETED' || run.status === 'FAILED' || run.status === 'CANCELLED')
        return { kind: 'TERMINAL' as const, run };
      if (run.status === 'RUNNING' && run.leaseExpiresAt && run.leaseExpiresAt > now)
        return { kind: 'BUSY' as const };
      if (run.attemptCount >= run.maxAttempts) return { kind: 'ATTEMPTS_EXHAUSTED' as const };
      const attemptToken = randomUUID();
      const claimed = await transaction.effectTemplateMixAiRun.update({
        where: { projectId_id: { projectId, id: runId } },
        data: {
          status: 'RUNNING',
          attemptCount: { increment: 1 },
          attemptToken,
          leaseExpiresAt: leaseUntil(now),
          heartbeatAt: now,
          startedAt: run.startedAt ?? now,
          errorCode: null,
          errorMessage: null,
        },
      });
      return { kind: 'CLAIMED' as const, run: claimed, attemptToken };
    });
  }

  progress(
    projectId: string,
    runId: string,
    attemptToken: string,
    stage: 'CLASSIFYING' | 'MATCHING' | 'SAMPLING' | 'TRIMMING',
    progress: number,
    now = new Date(),
  ) {
    return this.prisma.effectTemplateMixAiRun.updateMany({
      where: {
        projectId,
        id: runId,
        status: 'RUNNING',
        attemptToken,
        leaseExpiresAt: { gt: now },
      },
      data: {
        stage,
        progress: Math.min(95, Math.max(1, Math.round(progress))),
        heartbeatAt: now,
        leaseExpiresAt: leaseUntil(now),
      },
    });
  }

  saveSelection(
    projectId: string,
    runId: string,
    attemptToken: string,
    classifications: unknown,
    selections: unknown,
    now = new Date(),
  ) {
    return this.prisma.effectTemplateMixAiRun.updateMany({
      where: { projectId, id: runId, status: 'RUNNING', attemptToken, leaseExpiresAt: { gt: now } },
      data: {
        classificationResult: json(classifications),
        selectionResult: json(selections),
        stage: 'SAMPLING',
        progress: 45,
        heartbeatAt: now,
        leaseExpiresAt: leaseUntil(now),
      },
    });
  }

  async saveClassificationCheckpoint(
    projectId: string,
    runId: string,
    attemptToken: string,
    classifications: unknown[],
    now = new Date(),
  ) {
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "effect_template_mix_ai_runs"
        WHERE "projectId" = ${projectId}::uuid AND "id" = ${runId}::uuid FOR UPDATE
      `;
      const run = await transaction.effectTemplateMixAiRun.findFirst({
        where: {
          projectId,
          id: runId,
          status: 'RUNNING',
          attemptToken,
          leaseExpiresAt: { gt: now },
        },
      });
      if (!run) return { kind: 'LEASE_CONFLICT' as const };
      const existing = Array.isArray(run.classificationResult)
        ? (run.classificationResult as unknown[])
        : [];
      const byMaterialId = new Map<string, unknown>();
      for (const item of [...existing, ...classifications]) {
        const materialId = (item as { materialId?: unknown })?.materialId;
        if (typeof materialId === 'string') byMaterialId.set(materialId, item);
      }
      const merged = [...byMaterialId.values()];
      const snapshot = run.inputSnapshot as unknown as EffectTemplateMixAiSnapshot;
      const progress = Math.min(
        30,
        10 + Math.round((merged.length / Math.max(1, snapshot.materials.length)) * 20),
      );
      await transaction.effectTemplateMixAiRun.update({
        where: { projectId_id: { projectId, id: runId } },
        data: {
          classificationResult: json(merged),
          stage: 'CLASSIFYING',
          progress,
          heartbeatAt: now,
          leaseExpiresAt: leaseUntil(now),
        },
      });
      return { kind: 'SAVED' as const, classifications: merged, progress };
    });
  }

  async saveSamplingCheckpoint(
    projectId: string,
    runId: string,
    attemptToken: string,
    samplesOrIds: EffectTemplateMixSampledMaterial[] | string[],
    now = new Date(),
  ) {
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "effect_template_mix_ai_runs"
        WHERE "projectId" = ${projectId}::uuid AND "id" = ${runId}::uuid FOR UPDATE
      `;
      const run = await transaction.effectTemplateMixAiRun.findFirst({
        where: {
          projectId,
          id: runId,
          status: 'RUNNING',
          attemptToken,
          leaseExpiresAt: { gt: now },
        },
      });
      if (!run) return { kind: 'LEASE_CONFLICT' as const };
      const selectedIds = new Set(
        Array.isArray(run.selectionResult)
          ? (run.selectionResult as Array<{ materialId?: unknown }>)
              .map(({ materialId }) => materialId)
              .filter((id): id is string => typeof id === 'string')
          : [],
      );
      const samples = samplesOrIds.every((item) => typeof item === 'string')
        ? []
        : (samplesOrIds as EffectTemplateMixSampledMaterial[]);
      const materialIds = samples.length
        ? samples.map(({ materialId }) => materialId)
        : (samplesOrIds as string[]);
      if (materialIds.some((id) => !selectedIds.has(id)))
        return { kind: 'INVALID_MATERIAL' as const };
      const existing = Array.isArray(run.samplingResult) ? (run.samplingResult as unknown[]) : [];
      const byMaterialId = new Map<string, unknown>();
      for (const item of [...existing, ...(samples.length ? samples : materialIds)]) {
        const materialId =
          typeof item === 'string'
            ? item
            : typeof (item as { materialId?: unknown })?.materialId === 'string'
              ? (item as { materialId: string }).materialId
              : null;
        if (materialId) byMaterialId.set(materialId, item);
      }
      const merged = [...byMaterialId.values()];
      const mergedSamples = merged.filter(
        (item): item is EffectTemplateMixSampledMaterial =>
          typeof item === 'object' &&
          item !== null &&
          typeof (item as { materialId?: unknown }).materialId === 'string' &&
          Array.isArray((item as { frameTimestampsSeconds?: unknown }).frameTimestampsSeconds),
      );
      const mergedIds = [...byMaterialId.keys()];
      await transaction.effectTemplateMixAiRun.update({
        where: { projectId_id: { projectId, id: runId } },
        data: {
          samplingResult: json(merged),
          heartbeatAt: now,
          leaseExpiresAt: leaseUntil(now),
        },
      });
      return { kind: 'SAVED' as const, materialIds: mergedIds, samples: mergedSamples };
    });
  }

  async saveTrimCheckpoint(
    projectId: string,
    runId: string,
    attemptToken: string,
    trims: unknown[],
    now = new Date(),
  ) {
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "effect_template_mix_ai_runs"
        WHERE "projectId" = ${projectId}::uuid AND "id" = ${runId}::uuid FOR UPDATE
      `;
      const run = await transaction.effectTemplateMixAiRun.findFirst({
        where: {
          projectId,
          id: runId,
          status: 'RUNNING',
          attemptToken,
          leaseExpiresAt: { gt: now },
        },
      });
      if (!run) return { kind: 'LEASE_CONFLICT' as const };
      const existing = Array.isArray(run.trimResult) ? (run.trimResult as unknown[]) : [];
      const byKey = new Map<string, unknown>();
      for (const item of [...existing, ...trims]) {
        const value = item as { materialId?: unknown; slotId?: string; variantIndex?: number };
        if (typeof value.materialId !== 'string') continue;
        const snapshot = run.inputSnapshot as unknown as EffectTemplateMixAiSnapshot;
        const key = snapshot.incremental
          ? `${value.variantIndex ?? 0}:${value.slotId}:${value.materialId}`
          : value.materialId;
        byKey.set(key, item);
      }
      const merged = [...byKey.values()];
      const selections = Array.isArray(run.selectionResult) ? run.selectionResult.length : 0;
      const progress = Math.min(
        90,
        55 + Math.round((merged.length / Math.max(1, selections)) * 35),
      );
      await transaction.effectTemplateMixAiRun.update({
        where: { projectId_id: { projectId, id: runId } },
        data: {
          trimResult: json(merged),
          stage: 'TRIMMING',
          progress,
          heartbeatAt: now,
          leaseExpiresAt: leaseUntil(now),
        },
      });
      return { kind: 'SAVED' as const, trims: merged, progress };
    });
  }

  async completeWithDraft(
    projectId: string,
    runId: string,
    attemptToken: string,
    outputVariantId: string,
    trims: unknown,
    draft: unknown,
    draftContentHash: string,
    expectedDraftRevision: number,
    templateId?: string,
    expectedWorkspaceHash?: string,
    now = new Date(),
  ) {
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "effect_template_mix_ai_runs"
        WHERE "projectId" = ${projectId}::uuid AND "id" = ${runId}::uuid FOR UPDATE
      `;
      const run = await transaction.effectTemplateMixAiRun.findFirst({
        where: {
          projectId,
          id: runId,
          status: 'RUNNING',
          attemptToken,
          leaseExpiresAt: { gt: now },
        },
      });
      if (!run) return 'LEASE_CONFLICT' as const;
      await transaction.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "workflow_node_states"
        WHERE "projectId" = ${projectId}::uuid
          AND "workflowRunId" = ${run.workflowRunId}::uuid
          AND "nodeId" = 'TEMPLATE_MIX'
        FOR UPDATE
      `;
      const nodeState = await transaction.workflowNodeState.findUnique({
        where: {
          projectId_workflowRunId_nodeId: {
            projectId,
            workflowRunId: run.workflowRunId,
            nodeId: 'TEMPLATE_MIX',
          },
        },
      });
      if (!nodeState) return 'DRAFT_CONFLICT' as const;
      let nextDraft = draft;
      let nextContentHash = draftContentHash;
      if (expectedWorkspaceHash && templateId) {
        const current = nodeState.state as unknown as EffectTemplateMixDraft;
        const updated = draft as EffectTemplateMixDraft;
        if (!Array.isArray(current?.templates) || !Array.isArray(updated?.templates))
          return 'DRAFT_CONFLICT' as const;
        const currentEntry = current.templates?.find((entry) => entry.id === templateId);
        const updatedEntry = updated.templates?.find((entry) => entry.id === templateId);
        if (
          !currentEntry ||
          !updatedEntry ||
          workflowStateHash(currentEntry.workspace) !== expectedWorkspaceHash
        )
          return 'DRAFT_CONFLICT' as const;
        nextDraft = {
          ...current,
          templates: current.templates.map((entry) => {
            if (entry.id !== templateId) return entry;
            const { materialRoleOverrides: _frozenRoles, ...updated } = updatedEntry;
            const frozen = run.inputSnapshot as unknown as EffectTemplateMixAiSnapshot | undefined;
            const roles = { ...entry.materialRoleOverrides };
            if (
              frozen?.materialRoleEditVersion !== undefined &&
              (entry.materialRoleEditVersion ?? 0) === frozen.materialRoleEditVersion
            ) {
              const classifiedIds = new Set(frozen.materials.map((material) => material.id));
              for (const [id, role] of Object.entries(roles)) {
                if (role === null && classifiedIds.has(id)) delete roles[id];
              }
            }
            return {
              ...updated,
              ...(entry.materialRoleOverrides ? { materialRoleOverrides: roles } : {}),
              ...(entry.materialRoleEditVersion !== undefined
                ? { materialRoleEditVersion: entry.materialRoleEditVersion }
                : {}),
              aiFillLocked: false,
            };
          }),
        };
        nextContentHash = workflowStateHash(nextDraft);
      } else if (nodeState.revision !== expectedDraftRevision) {
        return 'DRAFT_CONFLICT' as const;
      }
      if (nodeState.contentHash !== nextContentHash) {
        await transaction.workflowNodeState.update({
          where: { id: nodeState.id },
          data: {
            state: json(nextDraft),
            contentHash: nextContentHash,
            schemaVersion: 1,
            revision: { increment: 1 },
            savedAt: now,
          },
        });
        await transaction.workflowRun.update({
          where: { projectId_id: { projectId, id: run.workflowRunId } },
          data: { currentNodeId: 'TEMPLATE_MIX', lastActiveAt: now },
        });
      }
      await transaction.effectTemplateMixAiRun.update({
        where: { projectId_id: { projectId, id: runId } },
        data: {
          trimResult: json(trims),
          outputVariantId,
          status: 'COMPLETED',
          stage: 'COMPLETED',
          progress: 100,
          ...((run.inputSnapshot as unknown as EffectTemplateMixAiSnapshot | undefined)
            ?.incremental &&
          (run.inputSnapshot as unknown as EffectTemplateMixAiSnapshot).sourceOperation
            ?.protocol === 'FROZEN_RENDER_V1'
            ? { errorCode: 'APPEND_CONTINUATION_PENDING', errorMessage: null }
            : {}),
          attemptToken: null,
          leaseExpiresAt: null,
          heartbeatAt: now,
          completedAt: now,
        },
      });
      return 'COMPLETED' as const;
    });
  }

  async fail(
    projectId: string,
    runId: string,
    attemptToken: string,
    errorCode: string,
    errorMessage: string,
    retryable: boolean,
    now = new Date(),
  ) {
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "effect_template_mix_ai_runs"
        WHERE "projectId" = ${projectId}::uuid AND "id" = ${runId}::uuid FOR UPDATE
      `;
      const run = await transaction.effectTemplateMixAiRun.findFirst({
        where: { projectId, id: runId },
      });
      if (
        !run ||
        run.status !== 'RUNNING' ||
        run.attemptToken !== attemptToken ||
        !run.leaseExpiresAt ||
        run.leaseExpiresAt <= now
      )
        return 'LEASE_CONFLICT' as const;
      const requeue = retryable && run.attemptCount < run.maxAttempts;
      await transaction.effectTemplateMixAiRun.update({
        where: { projectId_id: { projectId, id: runId } },
        data: {
          status: requeue ? 'QUEUED' : 'FAILED',
          attemptToken: null,
          leaseExpiresAt: null,
          heartbeatAt: now,
          errorCode,
          errorMessage: errorMessage.slice(0, 1000),
          completedAt: requeue ? null : now,
        },
      });
      if (requeue)
        await transaction.jobOutbox.updateMany({
          where: { projectId, jobType: EFFECT_TEMPLATE_MIX_JOB_TYPE, aggregateId: runId },
          data: {
            status: 'PENDING',
            dispatchToken: null,
            nextAttemptAt: now,
            publishedAt: null,
            lastError: null,
          },
        });
      else
        await this.clearFillLock(
          transaction,
          run.projectId,
          run.workflowRunId,
          run.templateId,
          now,
        );
      return requeue ? ('REQUEUED' as const) : ('FAILED' as const);
    });
  }

  private async clearFillLock(
    transaction: Prisma.TransactionClient,
    projectId: string,
    workflowRunId: string,
    templateId: string,
    now: Date,
  ) {
    await transaction.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "workflow_node_states"
      WHERE "projectId" = ${projectId}::uuid AND "workflowRunId" = ${workflowRunId}::uuid
        AND "nodeId" = 'TEMPLATE_MIX' FOR UPDATE
    `;
    const row = await transaction.workflowNodeState.findUnique({
      where: {
        projectId_workflowRunId_nodeId: { projectId, workflowRunId, nodeId: 'TEMPLATE_MIX' },
      },
    });
    if (!row) return;
    const draft = row.state as unknown as EffectTemplateMixDraft;
    const entry = draft.templates?.find((candidate) => candidate.id === templateId);
    if (!entry?.aiFillLocked) return;
    const next = {
      ...draft,
      templates: draft.templates.map((candidate) =>
        candidate.id === templateId ? { ...candidate, aiFillLocked: false } : candidate,
      ),
    };
    await transaction.workflowNodeState.update({
      where: { id: row.id },
      data: {
        state: json(next),
        contentHash: workflowStateHash(next),
        revision: { increment: 1 },
        savedAt: now,
      },
    });
  }

  async recoverExpired(now = new Date()): Promise<void> {
    await this.recoverAppendContinuations(now);
    await this.recoverUnclaimed(now);
    const runs = await this.prisma.effectTemplateMixAiRun.findMany({
      where: { status: 'RUNNING', leaseExpiresAt: { lte: now } },
      orderBy: { leaseExpiresAt: 'asc' },
      take: 50,
    });
    for (const run of runs) {
      const retry = run.attemptCount < run.maxAttempts;
      const updated = await this.prisma.effectTemplateMixAiRun.updateMany({
        where: {
          projectId: run.projectId,
          id: run.id,
          status: 'RUNNING',
          leaseExpiresAt: { lte: now },
        },
        data: {
          status: retry ? 'QUEUED' : 'FAILED',
          attemptToken: null,
          leaseExpiresAt: null,
          errorCode: 'WORKER_LEASE_EXPIRED',
          errorMessage: retry
            ? '智能填充 Worker 连接中断，任务已重新排队'
            : '智能填充 Worker 多次失联，任务已终止',
          completedAt: retry ? null : now,
        },
      });
      if (updated.count !== 1) continue;
      if (!retry) {
        await this.prisma.$transaction((transaction) =>
          this.clearFillLock(transaction, run.projectId, run.workflowRunId, run.templateId, now),
        );
        continue;
      }
      await this.prisma.jobOutbox.updateMany({
        where: {
          projectId: run.projectId,
          jobType: EFFECT_TEMPLATE_MIX_JOB_TYPE,
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
    }
  }

  /** A published message can disappear before claim (e.g. a Worker rejects the delivery).
   * Lease recovery only sees RUNNING; keep QUEUED tasks from remaining at zero forever.
   */
  async recoverUnclaimed(now = new Date()): Promise<void> {
    const deadline = new Date(now.getTime() - 15 * 60 * 1000);
    const runs = await this.prisma.effectTemplateMixAiRun.findMany({
      where: { status: 'QUEUED', queuedAt: { lte: deadline } },
      orderBy: { queuedAt: 'asc' },
      take: 50,
    });
    for (const run of runs) {
      await this.prisma.$transaction(async (transaction) => {
        const retry = run.unclaimedRecoveryCount < 2;
        const updated = await transaction.effectTemplateMixAiRun.updateMany({
          where: {
            projectId: run.projectId,
            id: run.id,
            status: 'QUEUED',
            queuedAt: { lte: deadline },
            unclaimedRecoveryCount: run.unclaimedRecoveryCount,
          },
          data: {
            status: retry ? 'QUEUED' : 'FAILED',
            queuedAt: now,
            unclaimedRecoveryCount: { increment: 1 },
            attemptToken: null,
            leaseExpiresAt: null,
            errorCode: 'WORKER_NOT_CLAIMED',
            errorMessage: retry
              ? '任务尚未被执行服务领取，已重新投递'
              : '执行服务长时间未领取任务，请检查服务后重试',
            completedAt: retry ? null : now,
          },
        });
        if (updated.count !== 1) return;
        if (retry)
          await transaction.jobOutbox.updateMany({
            where: {
              projectId: run.projectId,
              jobType: EFFECT_TEMPLATE_MIX_JOB_TYPE,
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
        else
          await this.clearFillLock(
            transaction,
            run.projectId,
            run.workflowRunId,
            run.templateId,
            now,
          );
      });
    }
  }
}
