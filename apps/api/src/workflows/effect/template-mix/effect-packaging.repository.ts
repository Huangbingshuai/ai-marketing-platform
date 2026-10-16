import { Injectable, Inject, ConflictException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../../database/prisma.service';
import { WorkflowWorkingRepository } from '../../../platform/workflow/workflow-working.repository';
import { publishedRenderSource } from '../../../platform/workflow/effect-published-render-source';
import type { Prisma } from '../../../generated/prisma/client';
import type {
  PackagingCaptionVoiceQueueMessage,
  PackagingCheckpoint,
  PackagingSnapshot,
  PackagingStage,
} from '@ai-marketing/contracts';
import { packagingShardIndexes } from '@ai-marketing/contracts';
import {
  EFFECT_TEMPLATE_MIX_QUEUE,
  EFFECT_TEMPLATE_MIX_JOB_TYPE,
} from '../../../platform/job/job.constants';
import type { EffectTemplateMixDraft } from '@ai-marketing/contracts';
import { templateConfigurationHash } from './template-mix-lifecycle';
import { workflowStateHash } from '../../../platform/workflow/workflow-state-hash';
import {
  activeMixSourceUpdates,
  lockMixNodeForSourceUpdate,
} from '../../../platform/workflow/effect-mix-source-update-lock';
import { activePackagingItems } from '../../../platform/workflow/effect-packaging-lock';

const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const lease = () => new Date(Date.now() + 120_000);
export const PACKAGING_INCLUDE = {
  items: { orderBy: [{ shardIndex: 'asc' as const }, { id: 'asc' as const }] },
};

@Injectable()
export class EffectPackagingRepository {
  // Coalesce overlapping reads only. Never retain a resolved task/source state or
  // reuse it after a later edit, cancellation, revision change or another scope.
  private readonly sourceReads = new Map<
    string,
    ReturnType<WorkflowWorkingRepository['listArtifacts']>
  >();
  constructor(@Inject(PrismaService) readonly db: PrismaService) {}

  readRunScope(projectId: string, workflowRunId: string) {
    return this.db.workflowRun.findFirst({
      where: { id: workflowRunId, projectId, workflow: 'EFFECT', workflowSpace: 'EFFECT' },
      select: { id: true },
    });
  }

  /** Display-only fallback for legacy snapshots, using exact source IDs rather than newer heads. */
  async materialLabels(projectId: string, materialIds: string[]) {
    if (!materialIds.length) return [];
    const rows = await this.db.workingArtifact.findMany({
      where: {
        projectId,
        id: { in: materialIds },
        nodeId: 'SEGMENT_RENDER',
        artifactKey: { startsWith: 'render-clip:' },
      },
      select: { id: true, name: true, payload: true },
    });
    return rows.map((row) => {
      const payload = row.payload as { renderCode?: unknown } | null;
      return {
        id: row.id,
        code: typeof payload?.renderCode === 'string' ? payload.renderCode : row.name,
        name: row.name.replace(/\s+视频片段$/u, ''),
      };
    });
  }

  get(projectId: string, id: string) {
    return this.db.effectPackagingRun.findFirst({
      where: { projectId, id },
      include: PACKAGING_INCLUDE,
    });
  }
  getItem(projectId: string, runId: string, itemId: string) {
    return this.db.effectPackagingItem.findFirst({
      where: { projectId, runId, id: itemId },
      include: { run: { select: { workflowRunId: true, templateId: true } } },
    });
  }
  async sourceArtifacts(projectId: string, workflowRunId: string, artifactIds: string[]) {
    if (!artifactIds.length) return [];
    const run = await this.db.workflowRun.findFirst({
      where: {
        projectId,
        id: workflowRunId,
        status: { in: ['ACTIVE', 'PAUSED'] },
      },
      select: { id: true },
    });
    if (!run) return [];
    // Snapshot creation and execution must resolve the same project/branch source graph, including
    // shared render heads and their original dependencies, rather than only local copied rows.
    const wanted = new Set(artifactIds);
    const key = projectId + ':' + workflowRunId;
    let reading = this.sourceReads.get(key);
    if (!reading) {
      reading = new WorkflowWorkingRepository(this.db).listArtifacts(
        projectId,
        { workflowRunId },
        { upstreamOnly: true },
      );
      this.sourceReads.set(key, reading);
    }
    let artifacts: Awaited<typeof reading>;
    try {
      artifacts = await reading;
    } finally {
      if (this.sourceReads.get(key) === reading) this.sourceReads.delete(key);
    }
    // A legacy timeline can consume an exact non-head identity recovered solely
    // through its dependency closure. Keep that authorized fallback, never replace
    // the requested ID with a newer same-key source just to make validation pass.
    if (artifactIds.some((id) => !artifacts.some((artifact) => artifact.id === id)))
      artifacts = await new WorkflowWorkingRepository(this.db).listArtifacts(projectId, {
        workflowRunId,
      });
    return artifacts
      .filter((artifact) => wanted.has(artifact.id))
      .map(publishedRenderSource)
      .map((artifact) => ({
        id: artifact.id,
        revision: artifact.revision,
        freshness: artifact.freshness,
        availability: artifact.availability,
      }));
  }
  async list(projectId: string, workflowRunId: string, templateId: string) {
    const latest = await this.db.effectPackagingItem.findMany({
      where: { projectId, run: { workflowRunId, templateId } },
      orderBy: [{ run: { createdAt: 'desc' } }, { id: 'desc' }],
      distinct: ['variantId'],
      select: { id: true, runId: true },
    });
    const confirmed = await this.db.effectPackagingItem.findMany({
      where: { projectId, status: 'COMPLETED', run: { workflowRunId, templateId } },
      orderBy: [{ run: { createdAt: 'desc' } }, { id: 'desc' }],
      distinct: ['variantId'],
      select: { id: true, runId: true },
    });
    const retained = [...latest, ...confirmed];
    const recent = await this.db.effectPackagingRun.findMany({
      where: { projectId, workflowRunId, templateId },
      orderBy: { createdAt: 'desc' },
      take: 20,
      include: PACKAGING_INCLUDE,
    });
    const recentIds = new Set(recent.map((r) => r.id));
    const extraIds = [...new Set(retained.map((i) => i.runId))].filter((id) => !recentIds.has(id));
    const older = extraIds.length
      ? await this.db.effectPackagingRun.findMany({
          where: { projectId, workflowRunId, templateId, id: { in: extraIds } },
          orderBy: { createdAt: 'desc' },
          include: {
            items: {
              where: { id: { in: retained.map((i) => i.id) } },
              orderBy: [{ shardIndex: 'asc' }, { id: 'asc' }],
            },
          },
        })
      : [];
    return [...recent, ...older];
  }
  /** A package running in this Run or in its direct child locks the source project. */
  async sourceLockedTemplateIds(projectId: string, workflowRunId: string): Promise<string[]> {
    const rows = await this.db.effectPackagingRun.findMany({
      where: {
        projectId,
        status: { in: ['QUEUED', 'RUNNING'] },
        OR: [
          { workflowRunId },
          { workflowRun: { parentWorkflowRunId: workflowRunId, forkNodeId: 'TEMPLATE_MIX' } },
        ],
      },
      select: { templateId: true, items: { select: { snapshot: true } } },
    });
    return rows
      .filter((row) =>
        row.items.some((item) => !(item.snapshot as unknown as PackagingSnapshot).operation),
      )
      .map(({ templateId }) => templateId);
  }
  latestChild(projectId: string, workflowRunId: string, templateId: string) {
    return this.db.effectPackagingRun.findFirst({
      where: {
        projectId,
        templateId,
        OR: [
          { workflowRunId },
          {
            workflowRun: {
              parentWorkflowRunId: workflowRunId,
              forkNodeId: 'TEMPLATE_MIX',
            },
          },
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: PACKAGING_INCLUDE,
    });
  }
  activeUnpublishedChild(projectId: string, workflowRunId: string, templateId: string) {
    return this.db.effectPackagingRun.findFirst({
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
  private enqueue(tx: Prisma.TransactionClient, projectId: string, runId: string) {
    const payload = {
      schemaVersion: 2,
      taskType: 'PACKAGING',
      projectId,
      runId,
      requestId: randomUUID(),
    };
    // One durable outbox row per run: retries and lease recovery re-arm that row.
    // Clearing dispatchToken also fences acknowledgements from its previous delivery.
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
        aggregateId: runId,
        jobType: EFFECT_TEMPLATE_MIX_JOB_TYPE,
        routingKey: EFFECT_TEMPLATE_MIX_QUEUE,
        payload,
      },
      update: {
        payload,
        routingKey: EFFECT_TEMPLATE_MIX_QUEUE,
        status: 'PENDING',
        attempts: 0,
        dispatchToken: null,
        nextAttemptAt: new Date(),
        publishedAt: null,
        lastError: null,
      },
    });
  }
  /**
   * One row per request, keyed by the request id rather than by the item: the outbox upsert re-arms
   * the row it matches, so keying by item would let a second caption silently overwrite a
   * still-pending first one. Nothing re-arms this row either, which is deliberate — the synthesis is
   * a one-shot paid call the user asked for by hand, not a pipeline stage that has to converge.
   */
  enqueueCaptionVoice(message: PackagingCaptionVoiceQueueMessage) {
    return this.db.jobOutbox.create({
      data: {
        projectId: message.projectId,
        aggregateId: message.requestId,
        jobType: EFFECT_TEMPLATE_MIX_JOB_TYPE,
        routingKey: EFFECT_TEMPLATE_MIX_QUEUE,
        payload: json(message),
      },
    });
  }
  create(input: {
    projectId: string;
    workflowRunId: string;
    templateId: string;
    idempotencyKey: string;
    requestHash: string;
    snapshots: PackagingSnapshot[];
    checkpoints: PackagingCheckpoint[];
    expectedDraftRevision: number;
    expectedSourceDraftRevision?: number;
    expectedTemplateHash: string;
    sourceWorkflowRunId?: string;
  }) {
    const shards = packagingShardIndexes(input.snapshots);
    return this.db.$transaction(async (tx) => {
      // Advisory locks return PostgreSQL void; execute without deserializing a result row.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.projectId + ':' + input.workflowRunId + ':' + input.templateId}))`;
      const replay = await tx.effectPackagingRun.findUnique({
        where: {
          projectId_idempotencyKey: {
            projectId: input.projectId,
            idempotencyKey: input.idempotencyKey,
          },
        },
      });
      if (replay) {
        if (replay.requestHash !== input.requestHash)
          throw new ConflictException('幂等键对应的包装请求已改变');
        return replay.id;
      }
      if (input.sourceWorkflowRunId) {
        // Serialize the source fence with both source edits and another child task creation.
        await lockMixNodeForSourceUpdate(tx, input.projectId, input.sourceWorkflowRunId);
        const held = await activePackagingItems(tx, input.projectId, input.sourceWorkflowRunId);
        if (
          held.some(
            (item) =>
              item.run.templateId === input.templateId &&
              (input.snapshots.some((snapshot) => snapshot.variant.id === item.variantId) ||
                (item.run.workflowRunId === input.workflowRunId &&
                  !(item.snapshot as unknown as PackagingSnapshot | null)?.operation)),
          )
        )
          throw new ConflictException('当前成片已有包装任务运行中');
        if (input.sourceWorkflowRunId !== input.workflowRunId) {
          const source = await tx.workflowNodeState.findUnique({
            where: {
              projectId_workflowRunId_nodeId: {
                projectId: input.projectId,
                workflowRunId: input.sourceWorkflowRunId,
                nodeId: 'TEMPLATE_MIX',
              },
            },
          });
          if (
            !source ||
            source.revision !== (input.expectedSourceDraftRevision ?? input.expectedDraftRevision)
          )
            throw new ConflictException('包装前原工程已改变，请刷新后重试');
        }
      }
      await tx.$queryRaw`SELECT "id" FROM "workflow_node_states"
        WHERE "projectId"=${input.projectId}::uuid AND "workflowRunId"=${input.workflowRunId}::uuid
          AND "nodeId"='TEMPLATE_MIX' FOR UPDATE`;
      const nodeState = await tx.workflowNodeState.findUnique({
        where: {
          projectId_workflowRunId_nodeId: {
            projectId: input.projectId,
            workflowRunId: input.workflowRunId,
            nodeId: 'TEMPLATE_MIX',
          },
        },
      });
      if (!nodeState || nodeState.revision !== input.expectedDraftRevision)
        throw new ConflictException('混剪草稿已变化，请刷新后重试');
      const currentDraft = nodeState.state as unknown as EffectTemplateMixDraft;
      const currentEntry = currentDraft.templates.find((entry) => entry.id === input.templateId);
      if (!currentEntry) throw new ConflictException('模板不存在，请刷新后重试');
      const sourceUpdates = await activeMixSourceUpdates(tx, input.projectId, input.workflowRunId);
      if (
        sourceUpdates.some(
          (update) =>
            update.templateId === input.templateId &&
            input.snapshots.some((snapshot) => snapshot.variant.id === update.baselineVariant.id),
        )
      )
        throw new ConflictException('局部更新正在进行，对应成片暂时不能开始智能成片包装');
      if (
        templateConfigurationHash(currentEntry.workspace.template) !== input.expectedTemplateHash ||
        (currentEntry.filledTemplateHash &&
          currentEntry.filledTemplateHash !== input.expectedTemplateHash)
      )
        throw new ConflictException('模板已变化，请先重新智能填充后再进行包装');
      const staleVariant = currentEntry.workspace.variants.some((variant) => {
        if (!Object.values(variant.bindings ?? {}).some(Boolean)) return false;
        return variant.appliedTemplateHash
          ? variant.appliedTemplateHash !== input.expectedTemplateHash
          : variant.appliedTemplateVersion !== currentEntry.workspace.template.editVersion;
      });
      if (staleVariant)
        throw new ConflictException('仍有成片未按当前模板重新智能填充，请逐条完成后再包装');
      if (
        await tx.effectTemplateMixAiRun.count({
          where: {
            projectId: input.projectId,
            workflowRunId: input.workflowRunId,
            templateId: input.templateId,
            status: { in: ['QUEUED', 'RUNNING'] },
          },
        })
      )
        throw new ConflictException('智能填充正在运行，暂不能开始智能成片包装');
      // The non-unique active lookup index permits disjoint modern jobs. This
      // check runs under the advisory/node locks; legacy jobs keep the wider fence.
      const overlapping = await tx.effectPackagingRun.count({
        where: {
          projectId: input.projectId,
          workflowRunId: input.workflowRunId,
          templateId: input.templateId,
          status: { in: ['QUEUED', 'RUNNING'] },
          ...(input.snapshots.every((snapshot) => snapshot.operation)
            ? {
                items: {
                  some: {
                    variantId: { in: input.snapshots.map((snapshot) => snapshot.variant.id) },
                    status: { in: ['QUEUED', 'RUNNING'] },
                  },
                },
              }
            : {}),
        },
      });
      if (overlapping) throw new ConflictException('当前模板已有包装任务运行中');
      const rebound = input.snapshots.filter(
        (snapshot) => !snapshot.operation && snapshot.sourceTrimMaterials?.length,
      );
      if (rebound.length) {
        currentEntry.workspace.variants = currentEntry.workspace.variants.map(
          (variant) =>
            rebound.find((snapshot) => snapshot.variant.id === variant.id)?.variant ?? variant,
        );
        currentEntry.workspace.editVersion += 1;
        await tx.workflowNodeState.update({
          where: { id: nodeState.id },
          data: {
            state: json(currentDraft),
            contentHash: workflowStateHash(currentDraft),
            revision: { increment: 1 },
          },
        });
      }
      const run = await tx.effectPackagingRun.create({
        data: {
          projectId: input.projectId,
          workflowRunId: input.workflowRunId,
          templateId: input.templateId,
          idempotencyKey: input.idempotencyKey,
          requestHash: input.requestHash,
          items: {
            create: input.snapshots.map((snapshot, index) => ({
              variantId: snapshot.variant.id,
              name: snapshot.variant.name,
              shardIndex: shards[index]!,
              sourceTimelineHash: snapshot.sourceTimelineHash,
              snapshot: json(snapshot),
              checkpoint: json(input.checkpoints[index] ?? {}),
            })),
          },
        },
      });
      await this.enqueue(tx, input.projectId, run.id);
      return run.id;
    });
  }
  claim(projectId: string, id: string) {
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM effect_packaging_runs WHERE id=${id}::uuid AND "projectId"=${projectId}::uuid FOR UPDATE`;
      const run = await tx.effectPackagingRun.findFirst({
        where: { projectId, id },
        include: PACKAGING_INCLUDE,
      });
      if (!run || !['QUEUED', 'RUNNING'].includes(run.status)) return { terminal: true };
      if (run.status === 'RUNNING' && run.leaseExpiresAt && run.leaseExpiresAt > new Date())
        return { terminal: true };
      const attemptToken = randomUUID();
      await tx.effectPackagingRun.update({
        where: { id },
        data: {
          status: 'RUNNING',
          attemptToken,
          attemptCount: { increment: 1 },
          leaseExpiresAt: lease(),
          startedAt: run.startedAt ?? new Date(),
        },
      });
      const modern = run.items.some(
        (item) => (item.snapshot as unknown as PackagingSnapshot).operation,
      );
      await tx.effectPackagingItem.updateMany({
        where: {
          projectId,
          runId: id,
          status: modern ? { in: ['QUEUED', 'RUNNING'] } : { not: 'COMPLETED' },
        },
        data: { status: 'QUEUED', errorMessage: null },
      });
      return {
        terminal: false,
        attemptToken,
        items: run.items.map((item) =>
          item.status === 'COMPLETED' || (modern && ['FAILED', 'CANCELLED'].includes(item.status))
            ? item
            : { ...item, status: 'QUEUED' },
        ),
      };
    });
  }
  async recoverExpired() {
    const rows = await this.db.effectPackagingRun.findMany({
      where: { status: 'RUNNING', leaseExpiresAt: { lt: new Date() } },
      take: 50,
    });
    for (const row of rows)
      await this.db.$transaction(async (tx) => {
        const changed = await tx.effectPackagingRun.updateMany({
          where: { id: row.id, status: 'RUNNING', leaseExpiresAt: { lt: new Date() } },
          data: { status: 'QUEUED', attemptToken: null, leaseExpiresAt: null },
        });
        if (changed.count) await this.enqueue(tx, row.projectId, row.id);
      });
  }
  async authorized(projectId: string, id: string, attemptToken: string) {
    if (
      !attemptToken ||
      !(await this.db.effectPackagingRun.count({
        where: {
          id,
          projectId,
          status: 'RUNNING',
          attemptToken,
          leaseExpiresAt: { gt: new Date() },
        },
      }))
    )
      throw new ConflictException('包装任务租约已失效');
  }
  async heartbeat(projectId: string, id: string, attemptToken: string) {
    if (!attemptToken) throw new ConflictException('包装任务租约已失效');
    const result = await this.db.effectPackagingRun.updateMany({
      where: {
        id,
        projectId,
        status: 'RUNNING',
        attemptToken,
        leaseExpiresAt: { gt: new Date() },
      },
      data: { leaseExpiresAt: lease() },
    });
    if (result.count !== 1) throw new ConflictException('包装任务租约已失效');
    return { accepted: true };
  }
  checkpoint(
    projectId: string,
    runId: string,
    token: string,
    itemId: string,
    stage: PackagingStage,
    checkpoint: PackagingCheckpoint,
    errorMessage?: string,
  ) {
    return this.db.$transaction(async (tx) => {
      const renewed = await tx.effectPackagingRun.updateMany({
        where: {
          projectId,
          id: runId,
          status: 'RUNNING',
          attemptToken: token || '00000000-0000-0000-0000-000000000000',
          leaseExpiresAt: { gt: new Date() },
        },
        data: { leaseExpiresAt: lease() },
      });
      if (renewed.count !== 1) throw new ConflictException('包装任务租约已失效');
      const item = await tx.effectPackagingItem.findFirst({
        where: { id: itemId, projectId, runId },
      });
      if (!item) throw new ConflictException('包装成片不存在');
      if (item.status === 'COMPLETED') return { accepted: true };
      if (
        (item.snapshot as unknown as PackagingSnapshot).operation &&
        ['FAILED', 'CANCELLED'].includes(item.status)
      )
        return { accepted: true };
      const old = item.checkpoint as PackagingCheckpoint;
      const next = { ...old, ...checkpoint, voices: { ...old.voices, ...checkpoint.voices } };
      await tx.effectPackagingItem.update({
        where: { id: itemId },
        data: {
          stage,
          checkpoint: json(next),
          status: errorMessage
            ? 'FAILED'
            : stage === 'READY' && !(item.snapshot as unknown as PackagingSnapshot).operation
              ? 'COMPLETED'
              : 'RUNNING',
          errorMessage: errorMessage ?? null,
          startedAt: item.startedAt ?? new Date(),
          completedAt:
            errorMessage ||
            (stage === 'READY' && !(item.snapshot as unknown as PackagingSnapshot).operation)
              ? new Date()
              : null,
        },
      });
      return { accepted: true };
    });
  }
  /**
   * Editor audio edits land after completion, so this bypasses the worker lease path
   * and instead uses `updatedAt` as an optimistic lock.
   */
  async updateCheckpoint(
    projectId: string,
    itemId: string,
    checkpoint: PackagingCheckpoint,
    expectedUpdatedAt: string,
  ) {
    const expected = new Date(expectedUpdatedAt);
    if (Number.isNaN(expected.getTime())) throw new ConflictException('包装结果已被修改，请刷新');
    return this.db.$transaction(async (tx) => {
      const item = await tx.effectPackagingItem.findFirst({
        where: { id: itemId, projectId },
        include: { run: { select: { workflowRunId: true, templateId: true } } },
      });
      if (!item) throw new ConflictException('包装结果已被修改，请刷新');
      await lockMixNodeForSourceUpdate(tx, projectId, item.run.workflowRunId);
      const packaging = await activePackagingItems(tx, projectId, item.run.workflowRunId);
      if (
        packaging.some(
          (active) =>
            active.run.workflowRunId === item.run.workflowRunId &&
            active.run.templateId === item.run.templateId &&
            active.variantId === item.variantId,
        )
      )
        throw new ConflictException('当前成片正在包装，完成后自动解锁');
      const updates = await activeMixSourceUpdates(tx, projectId, item.run.workflowRunId);
      if (
        updates.some(
          (update) =>
            update.templateId === item.run.templateId &&
            update.baselineVariant.id === item.variantId,
        )
      )
        throw new ConflictException(
          '局部更新正在进行，对应成片的字幕和音频暂时不能编辑；任务结束后自动解锁',
        );
      const result = await tx.effectPackagingItem.updateMany({
        where: { id: itemId, projectId, updatedAt: expected },
        data: { checkpoint: json(checkpoint) },
      });
      if (result.count !== 1) throw new ConflictException('包装结果已被修改，请刷新');
      return tx.effectPackagingItem.findFirstOrThrow({ where: { id: itemId, projectId } });
    });
  }
  finish(projectId: string, id: string, token: string) {
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM effect_packaging_runs WHERE id=${id}::uuid AND "projectId"=${projectId}::uuid FOR UPDATE`;
      const run = await tx.effectPackagingRun.findFirst({
        where: {
          id,
          projectId,
          status: 'RUNNING',
          attemptToken: token,
          leaseExpiresAt: { gt: new Date() },
        },
        include: { items: true },
      });
      if (!run) throw new ConflictException('包装任务租约已失效');
      if (run.items.some((i) => ['QUEUED', 'RUNNING'].includes(i.status)))
        throw new ConflictException('包装任务仍有未完成成片');
      const count = run.items.filter((i) => i.status === 'COMPLETED').length;
      const status = count === run.items.length ? 'COMPLETED' : count ? 'PARTIAL' : 'FAILED';
      await tx.effectPackagingRun.update({
        where: { id },
        data: { status, completedAt: new Date(), attemptToken: null, leaseExpiresAt: null },
      });
      // The caller needs to know which template just finished so it can feed the output node's queue.
      return {
        accepted: true,
        status,
        workflowRunId: run.workflowRunId,
        templateId: run.templateId,
        items: run.items.map((item) => ({ variantId: item.variantId, snapshot: item.snapshot })),
      };
    });
  }
  cancel(projectId: string, id: string) {
    return this.db.$transaction(async (tx) => {
      const changed = await tx.effectPackagingRun.updateMany({
        where: { id, projectId, status: { in: ['QUEUED', 'RUNNING'] } },
        data: {
          status: 'CANCELLED',
          completedAt: new Date(),
          attemptToken: null,
          leaseExpiresAt: null,
        },
      });
      if (changed.count)
        await tx.effectPackagingItem.updateMany({
          where: { projectId, runId: id, status: { in: ['QUEUED', 'RUNNING'] } },
          data: { status: 'CANCELLED' },
        });
      return { accepted: true };
    });
  }
  retry(projectId: string, id: string) {
    return this.db.$transaction(async (tx) => {
      const run = await tx.effectPackagingRun.findFirst({ where: { projectId, id } });
      if (!run) throw new ConflictException('包装任务不存在');
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${projectId + ':' + run.workflowRunId + ':' + run.templateId}))`;
      if (!['FAILED', 'PARTIAL', 'CANCELLED'].includes(run.status))
        throw new ConflictException('当前任务不可重试');
      if (
        await tx.effectPackagingRun.count({
          where: {
            projectId,
            workflowRunId: run.workflowRunId,
            templateId: run.templateId,
            status: { in: ['QUEUED', 'RUNNING'] },
          },
        })
      )
        throw new ConflictException('当前模板已有运行任务');
      await tx.effectPackagingItem.updateMany({
        where: { projectId, runId: id, status: { not: 'COMPLETED' } },
        data: { status: 'QUEUED', errorMessage: null, completedAt: null },
      });
      await tx.effectPackagingRun.update({
        where: { id },
        data: { status: 'QUEUED', completedAt: null, attemptToken: null, leaseExpiresAt: null },
      });
      await this.enqueue(tx, projectId, id);
      return { accepted: true };
    });
  }
}
