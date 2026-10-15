import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { ApiHttpException } from '../../../common/api-http-exception';
import {
  artifactTemplateId,
  pruneDeletedTemplates,
  templateDeletionRuns,
} from '../../../platform/workflow/effect-template-deletion';
import { workflowStateHash } from '../../../platform/workflow/workflow-state-hash';
import { PROJECT_STORAGE_COLUMNS } from '../../../platform/file/storage-reference-columns';
import {
  EFFECT_TEMPLATE_CURRENT_PATH_NODE_ID,
  type DeleteEffectTemplateMixData,
} from '@ai-marketing/contracts';

const refs = Prisma.join(
  PROJECT_STORAGE_COLUMNS.map(
    ([table, column]) =>
      Prisma.sql`SELECT ${Prisma.raw(`"${column}"`)} AS key FROM ${Prisma.raw(`"${table}"`)}`,
  ),
  ' UNION ALL ',
);
const scope = (projectId: string, templateId: string) => ({ projectId, templateId });

@Injectable()
export class EffectTemplateDeletionRepository {
  constructor(@Inject(PrismaService) private readonly db: PrismaService) {}

  async enqueue(
    projectId: string,
    workflowRunId: string,
    templateId: string,
    expectedRevision: number | null,
  ): Promise<DeleteEffectTemplateMixData> {
    return this.db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`template-delete:${projectId}`}))::text`;
        const existing = await tx.effectTemplateDeletion.findUnique({
          where: { projectId_templateId: scope(projectId, templateId) },
        });
        if (existing)
          return {
            templateId,
            workflowRunId: existing.fallbackRunId,
            status: existing.status as DeleteEffectTemplateMixData['status'],
            removedWorkflowRunIds: existing.workflowRunIds,
          };
        const previousDeletions = await tx.effectTemplateDeletion.findMany({
          where: { projectId },
          select: { templateId: true, workflowRunIds: true },
        });
        const deletedTemplateIds = new Set([
          ...previousDeletions.map((d) => d.templateId),
          templateId,
        ]);
        const alreadyRemoved = new Set(previousDeletions.flatMap((d) => d.workflowRunIds));
        const runs = await tx.workflowRun.findMany({
          where: { projectId, workflow: 'EFFECT', workflowSpace: 'EFFECT' },
        });
        const run = runs.find((r) => r.id === workflowRunId);
        if (!run || alreadyRemoved.has(run.id))
          throw new ApiHttpException('工作流不存在或已被删除', 404, 'VALIDATION_ERROR');
        // Tombstoned Runs can remain as immutable provenance containers for siblings.
        // Their copied artifacts must not infer live ownership for a second deletion.
        // Keep the full ancestry only for resolving a safe navigation fallback below.
        const liveRuns = runs.filter((r) => !alreadyRemoved.has(r.id));
        const state = await tx.workflowNodeState.findUnique({
          where: {
            projectId_workflowRunId_nodeId: { projectId, workflowRunId, nodeId: 'TEMPLATE_MIX' },
          },
        });
        if ((state?.revision ?? null) !== expectedRevision)
          throw new ApiHttpException('模板已修改，请刷新后确认删除', 409, 'VALIDATION_ERROR');
        const templates =
          (state?.state as { templates?: { id: string }[] } | undefined)?.templates ?? [];
        if (!templates.some((entry) => entry.id === templateId))
          throw new ApiHttpException('混剪模板不存在', 404, 'VALIDATION_ERROR');
        // Legacy single-template forks predate forkTemplateId. Do not infer ownership from
        // inherited configuration copies; use exact task/template ownership instead.
        const taskRows = await Promise.all([
          tx.effectTemplateMixAiRun.findMany({
            where: { projectId },
            select: { workflowRunId: true, templateId: true },
          }),
          tx.effectPackagingRun.findMany({
            where: { projectId },
            select: { workflowRunId: true, templateId: true },
          }),
          tx.effectFinalOutputRun.findMany({
            where: { projectId },
            select: { workflowRunId: true, templateId: true },
          }),
        ]);
        const legacy = new Set(
          liveRuns
            .filter(
              (r) =>
                !r.forkTemplateId &&
                taskRows
                  .flat()
                  .some((t) => t.workflowRunId === r.id && t.templateId === templateId) &&
                !taskRows
                  .flat()
                  .some((t) => t.workflowRunId === r.id && t.templateId !== templateId),
            )
            .map((r) => r.id),
        );
        const sharedOrForeignRuns = new Set(
          taskRows
            .flat()
            .filter((task) => task.templateId !== templateId)
            .map((task) => task.workflowRunId),
        );
        // Copied config hashes can change solely because upstream IDs were remapped.
        // Without an explicit marker or task proof, retain the unknown container.
        const removed = templateDeletionRuns(liveRuns, templateId, legacy, sharedOrForeignRuns);
        let fallback = run;
        const visited = new Set<string>();
        while (
          (removed.has(fallback.id) || alreadyRemoved.has(fallback.id)) &&
          fallback.parentWorkflowRunId &&
          !visited.has(fallback.id)
        ) {
          visited.add(fallback.id);
          fallback = runs.find((r) => r.id === fallback.parentWorkflowRunId) ?? fallback;
        }
        if (removed.has(fallback.id) || alreadyRemoved.has(fallback.id))
          throw new ApiHttpException('无法定位可保留的上游分支', 409, 'VALIDATION_ERROR');
        const runWhere = { projectId, id: { in: [...removed] } };
        // Invalidate leases before publishing the tombstone. Late callback writes are guarded
        // at the database boundary as well; unrelated templates are never cancelled.
        await tx.effectTemplateMixAiRun.updateMany({
          where: scope(projectId, templateId),
          data: { status: 'CANCELLED', attemptToken: null, leaseExpiresAt: null },
        });
        await tx.effectPackagingRun.updateMany({
          where: scope(projectId, templateId),
          data: { status: 'CANCELLED', attemptToken: null, leaseExpiresAt: null },
        });
        await tx.effectFinalOutputRun.updateMany({
          where: scope(projectId, templateId),
          data: { status: 'CANCELLED', attemptToken: null, leaseExpiresAt: null },
        });
        const activeRemoved = runs.some((r) => removed.has(r.id) && r.activeKey === 'ACTIVE');
        await tx.workflowRun.updateMany({
          where: runWhere,
          data: { activeKey: null, status: 'PAUSED' },
        });
        if (activeRemoved)
          await tx.workflowRun.update({
            where: { id: fallback.id },
            data: { activeKey: 'ACTIVE', status: 'ACTIVE', currentNodeId: 'TEMPLATE_MIX' },
          });
        // Only the selected draft is touched on the request path. All historical copies and
        // navigation records are projected through the tombstone until background cleanup.
        let draftRevision = state?.revision ?? null;
        for (const row of state ? [state] : []) {
          const cleaned = pruneDeletedTemplates(row.state, deletedTemplateIds);
          const hash = workflowStateHash(cleaned);
          if (hash !== workflowStateHash(row.state)) {
            const saved = await tx.workflowNodeState.updateMany({
              where: { id: row.id, revision: row.revision },
              data: {
                state: cleaned as Prisma.InputJsonValue,
                contentHash: hash,
                executionInputHash: hash,
                revision: { increment: 1 },
              },
            });
            if (!saved.count)
              throw new ApiHttpException('模板已修改，请刷新后确认删除', 409, 'CONFLICT');
            draftRevision = row.revision + 1;
          }
        }
        await tx.effectTemplateDeletion.create({
          data: {
            projectId,
            templateId,
            workflowRunIds: [...removed],
            fallbackRunId: fallback.id,
            storageKeys: [],
          },
        });
        return {
          templateId,
          workflowRunId: fallback.id,
          status: 'QUEUED',
          draftRevision,
          removedWorkflowRunIds: [...removed],
        };
      },
      { timeout: 15_000 },
    );
  }

  pending() {
    return this.db.effectTemplateDeletion.findMany({
      where: { status: { in: ['QUEUED', 'RUNNING'] }, nextAttemptAt: { lte: new Date() } },
      take: 10,
      orderBy: { nextAttemptAt: 'asc' },
    });
  }
  async claim(id: string, token: string) {
    const result = await this.db.effectTemplateDeletion.updateMany({
      where: { id, status: { in: ['QUEUED', 'RUNNING'] }, nextAttemptAt: { lte: new Date() } },
      data: {
        status: 'RUNNING',
        leaseToken: token,
        attempts: { increment: 1 },
        nextAttemptAt: new Date(Date.now() + 300_000),
      },
    });
    return result.count
      ? this.db.effectTemplateDeletion.findFirst({ where: { id, leaseToken: token } })
      : null;
  }

  async removeData(id: string, token: string): Promise<void> {
    await this.db.$transaction(
      async (tx) => {
        const job = await tx.effectTemplateDeletion.findFirst({
          where: { id, leaseToken: token, phase: 'DATABASE' },
        });
        if (!job) return;
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext('project-deletion-storage-ownership'))::text`;
        const { projectId, templateId, workflowRunIds: runIds } = job;
        // Defense for receipts accepted by older code. Never clean a foreign template's
        // container just because an old receipt recursively included its untagged Run.
        const foreignScope = {
          projectId,
          workflowRunId: { in: runIds },
          templateId: { not: templateId },
        };
        const foreignOwners = await Promise.all([
          tx.effectTemplateMixAiRun.count({ where: foreignScope }),
          tx.effectPackagingRun.count({ where: foreignScope }),
          tx.effectFinalOutputRun.count({ where: foreignScope }),
          tx.workflowRun.count({
            where: { projectId, id: { in: runIds }, forkTemplateId: { not: templateId } },
          }),
        ]);
        if (foreignOwners.some(Boolean))
          throw new Error('TEMPLATE_DELETE_FOREIGN_RUN_REQUIRES_REVIEW');
        const deletions = await tx.effectTemplateDeletion.findMany({ where: { projectId } });
        // A second accepted deletion can remove this job's original navigation fallback.
        // Follow durable receipts rather than rehoming shared files into a deleted Run.
        let fallbackRunId = job.fallbackRunId;
        const visitedFallbacks = new Set<string>();
        while (deletions.some((d) => d.workflowRunIds.includes(fallbackRunId))) {
          if (visitedFallbacks.has(fallbackRunId))
            throw new Error('TEMPLATE_DELETE_FALLBACK_CYCLE');
          visitedFallbacks.add(fallbackRunId);
          fallbackRunId = deletions.find((d) =>
            d.workflowRunIds.includes(fallbackRunId),
          )!.fallbackRunId;
        }
        const branches = { projectId, workflowRunId: { in: runIds } };
        const deletedTemplateIds = new Set(deletions.map((d) => d.templateId));
        const states = await tx.workflowNodeState.findMany({
          where: {
            projectId,
            workflowRunId: { notIn: runIds },
            nodeId: { in: ['TEMPLATE_MIX', 'FINAL_OUTPUT', EFFECT_TEMPLATE_CURRENT_PATH_NODE_ID] },
          },
        });
        for (const row of states) {
          const cleaned = pruneDeletedTemplates(row.state, deletedTemplateIds);
          const hash = workflowStateHash(cleaned);
          if (hash === workflowStateHash(row.state)) continue;
          const saved = await tx.workflowNodeState.updateMany({
            where: { id: row.id, revision: row.revision },
            data: {
              state: cleaned as Prisma.InputJsonValue,
              contentHash: hash,
              executionInputHash: hash,
              revision: { increment: 1 },
            },
          });
          if (!saved.count) throw new Error('TEMPLATE_DELETE_DRAFT_CHANGED');
        }
        const artifacts = await tx.workingArtifact.findMany({
          where: { projectId },
          select: {
            id: true,
            artifactKey: true,
            storageKey: true,
            workflowRunId: true,
            contentHash: true,
            nodeId: true,
          },
        });
        const target = artifacts.filter((a) => artifactTemplateId(a.artifactKey) === templateId);
        const deleted = artifacts.filter(
          (a) => runIds.includes(a.workflowRunId) || target.includes(a),
        );
        const artifactIds = deleted.map((a) => a.id);
        const targetKey = {
          OR: [
            { artifactKey: `mix-template:${templateId}` },
            ...['timeline-project', 'timeline-package', 'final-video', 'final-delivery'].map(
              (prefix) => ({ artifactKey: { startsWith: `${prefix}:${templateId}:` } }),
            ),
            { artifactKey: `final-delivery:${templateId}` },
          ],
        };
        const targetHistory = await tx.workingArtifactRevisionSnapshot.findMany({
          where: { projectId, ...targetKey },
          select: { id: true, workingArtifactId: true, artifactKey: true },
        });
        const tasks = await Promise.all([
          tx.effectTemplateMixAiRun.findMany({
            where: scope(projectId, templateId),
            select: { id: true },
          }),
          tx.effectPackagingRun.findMany({
            where: scope(projectId, templateId),
            select: { id: true },
          }),
          tx.effectFinalOutputRun.findMany({
            where: scope(projectId, templateId),
            select: { id: true },
          }),
        ]);
        const output = await tx.effectFinalOutputItem.findMany({
          where: { projectId, runId: { in: tasks[2].map((r) => r.id) } },
        });
        const packagingFiles = await tx.effectPackagingFile.findMany({
          where: { projectId, item: { runId: { in: tasks[1].map((r) => r.id) } } },
        });
        const bindings = await tx.workingArtifactFile.findMany({
          where: { projectId, workingArtifactId: { in: target.map((a) => a.id) } },
        });
        const historyBindings = await tx.workingArtifactRevisionFile.findMany({
          where: { projectId, snapshotId: { in: targetHistory.map((s) => s.id) } },
        });
        const fileIds = [
          ...new Set(
            [...packagingFiles, ...bindings, ...historyBindings, ...output].flatMap((r) =>
              r.fileObjectId ? [r.fileObjectId] : [],
            ),
          ),
        ];
        const files = await tx.fileObject.findMany({ where: { projectId, id: { in: fileIds } } });
        const assets = await tx.asset.findMany({
          where: {
            projectId,
            storageWorkflow: 'EFFECT',
            OR: [
              {
                sourceArtifactId: {
                  in: [
                    ...target.map((a) => a.id),
                    ...target.map((a) => a.artifactKey),
                    ...targetHistory.flatMap((s) => [s.workingArtifactId, s.artifactKey]),
                  ],
                },
              },
              { id: { in: output.flatMap((r) => (r.assetId ? [r.assetId] : [])) } },
            ],
          },
        });
        const assetVersions = await tx.assetVersion.findMany({
          where: { projectId, assetId: { in: assets.map((a) => a.id) } },
        });
        const keys = [
          ...new Set(
            [...files, ...assets, ...assetVersions, ...target].flatMap((r) =>
              r.storageKey ? [r.storageKey] : [],
            ),
          ),
        ];
        await tx.jobOutbox.deleteMany({
          where: { projectId, aggregateId: { in: tasks.flat().map((r) => r.id) } },
        });
        await tx.effectTemplateMixAiRun.deleteMany({ where: scope(projectId, templateId) });
        await tx.effectPackagingRun.deleteMany({ where: scope(projectId, templateId) });
        await tx.effectFinalOutputRun.deleteMany({ where: scope(projectId, templateId) });
        await tx.assetOperationReceipt.deleteMany({
          where: { projectId, assetId: { in: assets.map((a) => a.id) } },
        });
        await tx.assetVersion.deleteMany({
          where: { projectId, assetId: { in: assets.map((a) => a.id) } },
        });
        await tx.asset.deleteMany({ where: { projectId, id: { in: assets.map((a) => a.id) } } });
        // Restrict source edges may point at copied upstream snapshots. Keep those exact
        // historical sources if another template consumes them; never substitute today's head.
        // Upstream products are not template-owned, even when a saved source edit
        // lives inside a mix/output Run. Deleting the last consumer must not drop
        // the pool index (or its clips) and roll the render node back to an old pool.
        const retainedSources = new Set(
          deleted
            .filter((a) =>
              [
                'SOURCE_IMPORT',
                'INFORMATION_EXTRACTION',
                'PROMPT_GENERATION',
                'SEGMENT_RENDER',
              ].includes(a.nodeId),
            )
            .map((a) => a.id),
        );
        const sourceEdges = await tx.workingArtifactDependency.findMany({
          where: { projectId, sourceArtifactId: { in: artifactIds } },
          select: { sourceArtifactId: true, dependentArtifactId: true },
        });
        let changed = true;
        while (changed) {
          changed = false;
          for (const edge of sourceEdges)
            if (
              edge.sourceArtifactId &&
              !retainedSources.has(edge.sourceArtifactId) &&
              (!artifactIds.includes(edge.dependentArtifactId) ||
                retainedSources.has(edge.dependentArtifactId)) &&
              deleted.some(
                (a) =>
                  a.id === edge.sourceArtifactId &&
                  artifactTemplateId(a.artifactKey) !== templateId,
              )
            ) {
              retainedSources.add(edge.sourceArtifactId);
              changed = true;
            }
        }
        const exclusiveIds = artifactIds.filter((artifactId) => !retainedSources.has(artifactId));
        // A shared upstream historical source is not template data. Its minimal provenance
        // container must survive if another template depends on it; it stays hidden/immutable.
        const retainedRuns = new Set(
          deleted.filter((a) => retainedSources.has(a.id)).map((a) => a.workflowRunId),
        );
        const rows = await tx.workflowRun.findMany({
          where: { projectId, id: { in: runIds } },
          select: { id: true, parentWorkflowRunId: true },
        });
        for (const runId of retainedRuns) {
          let parent = rows.find((r) => r.id === runId)?.parentWorkflowRunId;
          while (parent && runIds.includes(parent) && !retainedRuns.has(parent)) {
            retainedRuns.add(parent);
            parent = rows.find((r) => r.id === parent)?.parentWorkflowRunId;
          }
        }
        await tx.workingArtifactDependency.deleteMany({
          where: {
            projectId,
            OR: [
              { sourceArtifactId: { in: exclusiveIds } },
              { dependentArtifactId: { in: exclusiveIds } },
            ],
          },
        });
        await tx.workingArtifactRevisionSnapshot.deleteMany({
          where: {
            projectId,
            OR: [
              { workingArtifactId: { in: exclusiveIds } },
              { id: { in: targetHistory.map((s) => s.id) } },
            ],
          },
        });
        await tx.workingArtifact.deleteMany({ where: { projectId, id: { in: exclusiveIds } } });
        // FileObjects can be referenced across Runs. Keep their identity and rehome them
        // before Run cascades, rather than cascading away files used by a sibling template.
        await tx.effectVoicePreview.deleteMany({ where: branches });
        await tx.effectImportUploadItem.deleteMany({ where: branches });
        await tx.fileObject.updateMany({ where: branches, data: { workflowRunId: fallbackRunId } });
        await tx.effectSegmentImportDraft.deleteMany({
          where: { projectId, batch: { workflowRunId: { in: runIds } } },
        });
        // Detach other-template children; never cascade another template or an upstream edit.
        const children = await tx.workflowRun.findMany({
          where: { projectId, parentWorkflowRunId: { in: runIds }, id: { notIn: runIds } },
          select: { id: true, parentWorkflowRunId: true },
        });
        for (const child of children) {
          let parent = child.parentWorkflowRunId;
          const seen = new Set<string>();
          while (parent && runIds.includes(parent) && !seen.has(parent)) {
            seen.add(parent);
            parent = rows.find((r) => r.id === parent)?.parentWorkflowRunId ?? null;
          }
          await tx.workflowRun.update({
            where: { id: child.id },
            data: { parentWorkflowRunId: parent ?? fallbackRunId },
          });
        }
        await tx.workflowNodeState.deleteMany({ where: branches });
        // Updating a tombstoned Run is intentionally forbidden. Delete leaves first.
        const remaining = new Set(runIds.filter((runId) => !retainedRuns.has(runId)));
        while (remaining.size) {
          const leaves = [...remaining].filter(
            (runId) => !rows.some((r) => remaining.has(r.id) && r.parentWorkflowRunId === runId),
          );
          if (!leaves.length) throw new Error('TEMPLATE_DELETE_BRANCH_CYCLE');
          await tx.workflowRun.deleteMany({ where: { projectId, id: { in: leaves } } });
          for (const runId of leaves) remaining.delete(runId);
        }
        await tx.fileObject.deleteMany({
          where: {
            projectId,
            id: { in: fileIds },
            artifactLinks: { none: {} },
            revisionLinks: { none: {} },
            packagingFiles: { none: {} },
            finalOutputItems: { none: {} },
            materials: { none: {} },
            uploadItems: { none: {} },
            voicePreviews: { none: {} },
          },
        });
        await tx.storageCleanupTask.deleteMany({ where: { projectId, storageKey: { in: keys } } });
        await tx.effectTemplateDeletion.updateMany({
          where: { id, leaseToken: token },
          data: { storageKeys: keys, phase: 'FILES' },
        });
      },
      { timeout: 30_000 },
    );
  }

  async unreferenced(key: string): Promise<boolean> {
    if (!key || key.startsWith('shared/')) return false;
    const rows = await this.db.$queryRaw<{ referenced: boolean }[]>(Prisma.sql`
      WITH refs AS (${refs}) SELECT EXISTS(SELECT 1 FROM refs WHERE key = ${key})
      OR EXISTS(SELECT 1 FROM effect_voice_catalog_samples WHERE "storageKey" = ${key}) AS referenced`);
    return rows[0]?.referenced === false;
  }
  async finish(id: string, token: string, remaining: string[], cacheCleared: boolean) {
    await this.db.effectTemplateDeletion.updateMany({
      where: { id, leaseToken: token },
      data: {
        storageKeys: remaining,
        status: !remaining.length && cacheCleared ? 'COMPLETED' : 'QUEUED',
        leaseToken: null,
        lastError: cacheCleared ? null : '缓存清理等待重试',
        nextAttemptAt: new Date(Date.now() + 30_000),
      },
    });
  }
  async releaseFiles(id: string, token: string) {
    await this.db.effectTemplateDeletion.updateMany({
      where: { id, leaseToken: token, phase: 'FILES' },
      data: { status: 'QUEUED', leaseToken: null, nextAttemptAt: new Date() },
    });
  }
  async retry(id: string, token: string) {
    await this.db.effectTemplateDeletion.updateMany({
      where: { id, leaseToken: token },
      data: {
        status: 'QUEUED',
        leaseToken: null,
        lastError: '后台清理未完成，将自动重试',
        nextAttemptAt: new Date(Date.now() + 30_000),
      },
    });
  }
}
