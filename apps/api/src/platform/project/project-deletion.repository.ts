import type { DeleteProjectResult } from '@ai-marketing/contracts';
import { presentProject } from './project-presenter';
import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { ApiHttpException } from '../../common/api-http-exception';

// Typed storage-key columns, including archived assets, revisions, failed outputs and staging.
// JSON snapshots refer to these objects; never interpret arbitrary JSON text as a deletable key.
import { PROJECT_STORAGE_COLUMNS } from '../file/storage-reference-columns';
export { PROJECT_STORAGE_COLUMNS } from '../file/storage-reference-columns';

const storageReferences = Prisma.join(
  PROJECT_STORAGE_COLUMNS.map(
    ([table, column]) =>
      Prisma.sql`SELECT "projectId", ${Prisma.raw(`"${column}"`)} AS key FROM ${Prisma.raw(`"${table}"`)}`,
  ),
  ' UNION ALL ',
);

const activityTables = [
  'customized_extraction_tasks',
  'effect_extraction_runs',
  'effect_prompt_runs',
  'effect_segment_render_batches',
  'effect_segment_render_tasks',
  'effect_template_mix_ai_runs',
  'effect_voice_previews',
  'effect_packaging_runs',
  'effect_packaging_items',
  'effect_final_output_runs',
  'effect_final_output_items',
  'effect_import_upload_sessions',
  'effect_segment_import_drafts',
  'effect_import_materials',
] as const;

async function assertProjectInactive(
  tx: Prisma.TransactionClient,
  projectId: string,
): Promise<void> {
  const active = { projectId, status: { in: ['QUEUED', 'RUNNING'] } };
  const enumActive = {
    projectId,
    status: { in: ['QUEUED', 'RUNNING'] as ('QUEUED' | 'RUNNING')[] },
  };
  const now = new Date();
  const counts = await Promise.all([
    tx.customizedExtractionTask.count({ where: active }),
    tx.effectExtractionRun.count({ where: enumActive }),
    tx.effectPromptRun.count({ where: enumActive }),
    tx.effectSegmentRenderBatch.count({ where: enumActive }),
    tx.effectSegmentRenderTask.count({
      where: {
        projectId,
        OR: [
          { status: { in: ['QUEUED', 'RUNNING'] } },
          { repairStatus: { in: ['QUEUED', 'RUNNING'] } },
        ],
      },
    }),
    tx.effectTemplateMixAiRun.count({ where: enumActive }),
    tx.effectVoicePreview.count({ where: active }),
    tx.effectPackagingRun.count({ where: active }),
    tx.effectPackagingItem.count({ where: active }),
    tx.effectFinalOutputRun.count({ where: active }),
    tx.effectFinalOutputItem.count({ where: active }),
    tx.effectImportUploadSession.count({
      where: { projectId, status: 'UPLOADING', expiresAt: { gt: now } },
    }),
    tx.effectSegmentImportDraft.count({
      where: { projectId, descriptionStatus: { in: ['QUEUED', 'RUNNING'] } },
    }),
    // Legacy placeholders have no upload session; abandoned placeholders must not block forever.
    tx.effectImportMaterial.count({
      where: {
        projectId,
        status: 'UPLOADING',
        updatedAt: { gt: new Date(now.getTime() - 10 * 60_000) },
      },
    }),
  ]);
  if (counts.some((count) => count > 0)) {
    throw new ApiHttpException(
      '项目仍有生成或上传任务，请等待任务结束后再删除。',
      409,
      'PROJECT_BUSY',
    );
  }
}

@Injectable()
export class ProjectDeletionRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async enqueue(projectId: string): Promise<DeleteProjectResult> {
    await this.prisma.$transaction(
      async (tx) => {
        const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM projects WHERE id = ${projectId}::uuid FOR UPDATE`;
        if (!locked.length) return;
        const queued = await tx.projectDeletionCleanup.findUnique({ where: { projectId } });
        if (queued && queued.status !== 'FAILED') return;
        await assertProjectInactive(tx, projectId);
        const project = await tx.project.findUniqueOrThrow({
          where: { id: projectId },
          include: {
            assets: {
              where: { archivedAt: null },
              select: { storageWorkflow: true, workflowSpace: true },
              distinct: ['workflowSpace'],
            },
          },
        });
        const snapshotProject = presentProject(project);
        delete snapshotProject.assetCounts;
        delete snapshotProject.deletion;
        const snapshot = {
          project: snapshotProject,
          spaces: [
            ...new Set(
              [project.defaultSpace, ...project.assets.map((asset) => asset.workflowSpace)].filter(
                Boolean,
              ),
            ),
          ],
        };
        const data = {
          storageKeys: [],
          phase: 'DATABASE',
          status: 'QUEUED',
          lastError: null,
          projectSnapshot: snapshot as unknown as Prisma.InputJsonValue,
          attempts: 0,
          leaseToken: null,
          nextAttemptAt: new Date(),
        };
        await tx.projectDeletionCleanup.upsert({
          where: { projectId },
          create: { projectId, ...data },
          update: data,
        });
        await tx.project.update({
          where: { id: projectId },
          data: { deletionState: 'QUEUED', deletionError: null },
        });
      },
      { timeout: 10_000 },
    );
    return this.status(projectId);
  }

  async status(projectId: string): Promise<DeleteProjectResult> {
    const job = await this.prisma.projectDeletionCleanup.findUnique({ where: { projectId } });
    if (!job) {
      if (await this.prisma.project.count({ where: { id: projectId } }))
        throw new ApiHttpException('项目尚未提交删除任务', 404, 'PROJECT_NOT_FOUND');
      return { projectId, deleted: true, status: 'COMPLETED', storageCleanup: 'COMPLETED' };
    }
    return {
      projectId,
      deleted: job.phase === 'FILES',
      status: job.status as DeleteProjectResult['status'],
      storageCleanup: 'PENDING',
    };
  }

  async fail(
    projectId: string,
    leaseToken: string,
    message: string,
    immediateFailure: boolean,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const job = await tx.projectDeletionCleanup.findFirst({ where: { projectId, leaseToken } });
      if (!job) return;
      const status =
        job.phase === 'DATABASE' && (immediateFailure || job.attempts >= 3) ? 'FAILED' : 'QUEUED';
      const changed = await tx.projectDeletionCleanup.updateMany({
        where: { projectId, leaseToken },
        data: {
          status,
          lastError: message,
          leaseToken: null,
          nextAttemptAt: new Date(Date.now() + 30_000),
        },
      });
      if (changed.count && job.phase === 'DATABASE')
        await tx.project.updateMany({
          where: { id: projectId },
          data: {
            deletionState: status,
            deletionError: status === 'FAILED' ? message : null,
          },
        });
    });
  }

  async remove(projectId: string, leaseToken: string): Promise<boolean> {
    return this.prisma.$transaction(
      async (tx) => {
        // Serialize ownership snapshots across deletions: the last of two projects sharing
        // a file must enqueue its cleanup, rather than both observing and preserving each other.
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext('project-deletion-storage-ownership'))::text`;
        // Also serializes duplicate deletion and new inserts taking a Project FK key-share lock.
        const project = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM projects WHERE id = ${projectId}::uuid FOR UPDATE`;
        if (!project.length) return false;
        const held = await tx.projectDeletionCleanup.updateMany({
          where: { projectId, leaseToken, phase: 'DATABASE', status: 'RUNNING' },
          data: { updatedAt: new Date() },
        });
        if (!held.count) return false;
        // Existing task updates (e.g. repair/retry/claim) do not acquire a new Project FK lock.
        // Lock these rows too, so they cannot start between the active check and cascading delete.
        for (const table of activityTables) {
          await tx.$queryRaw(
            Prisma.sql`SELECT id FROM ${Prisma.raw(`"${table}"`)} WHERE "projectId" = ${projectId}::uuid FOR UPDATE`,
          );
        }
        const scope = { projectId };
        await assertProjectInactive(tx, projectId);

        const owned = await tx.$queryRaw<{ key: string }[]>(Prisma.sql`
        WITH refs AS (${storageReferences})
        SELECT DISTINCT key FROM refs owned
        WHERE owned."projectId" = ${projectId}::uuid AND key IS NOT NULL AND key <> ''
          AND key NOT LIKE 'shared/%'
          AND NOT EXISTS (SELECT 1 FROM refs other WHERE other.key = owned.key AND other."projectId" <> ${projectId}::uuid)
          AND NOT EXISTS (SELECT 1 FROM effect_voice_catalog_samples sample WHERE sample."storageKey" = owned.key)`);
        await tx.projectDeletionCleanup.updateMany({
          where: { projectId, leaseToken },
          data: {
            storageKeys: owned.map(({ key }) => key),
            phase: 'FILES',
            status: 'QUEUED',
            attempts: 0,
            leaseToken: null,
            nextAttemptAt: new Date(),
            lastError: null,
          },
        });

        // Remove Restrict edges before Project cascades. Every operation stays in the same scope.
        await tx.workingArtifactDependency.deleteMany({ where: scope });
        await tx.workingArtifactRevisionFile.deleteMany({ where: scope });
        await tx.workingArtifactFile.deleteMany({ where: scope });
        await tx.effectPackagingFile.deleteMany({ where: scope });
        await tx.effectVoicePreview.deleteMany({ where: scope });
        await tx.effectFinalOutputItem.deleteMany({ where: scope });
        await tx.effectSegmentImportDraft.deleteMany({ where: scope });
        await tx.effectImportUploadItem.deleteMany({ where: scope });
        await tx.effectImportMaterial.deleteMany({ where: scope });
        await tx.effectImportProduct.deleteMany({ where: scope });
        await tx.assetOperationReceipt.deleteMany({ where: scope });
        await tx.assetVersion.deleteMany({ where: scope });
        await tx.asset.deleteMany({ where: scope });
        await tx.workflowRun.updateMany({ where: scope, data: { parentWorkflowRunId: null } });
        await tx.project.delete({ where: { id: projectId } });
        return true;
      },
      { timeout: 30_000 },
    );
  }

  async pending(): Promise<string[]> {
    const rows = await this.prisma.projectDeletionCleanup.findMany({
      where: { nextAttemptAt: { lte: new Date() }, status: { in: ['QUEUED', 'RUNNING'] } },
      take: 20,
      orderBy: { nextAttemptAt: 'asc' },
      select: { projectId: true },
    });
    return rows.map((row) => row.projectId);
  }

  async claim(
    projectId: string,
    leaseToken: string,
  ): Promise<{ phase: string; keys: string[]; attempts: number } | null> {
    const claimed = await this.prisma.projectDeletionCleanup.updateMany({
      where: {
        projectId,
        nextAttemptAt: { lte: new Date() },
        status: { in: ['QUEUED', 'RUNNING'] },
      },
      data: {
        leaseToken,
        status: 'RUNNING',
        attempts: { increment: 1 },
        nextAttemptAt: new Date(Date.now() + 300_000),
      },
    });
    if (!claimed.count) return null;
    const row = await this.prisma.projectDeletionCleanup.findFirst({
      where: { projectId, leaseToken },
    });
    if (row?.phase === 'DATABASE')
      await this.prisma.project.updateMany({
        where: { id: projectId, deletionState: { in: ['QUEUED', 'RUNNING'] } },
        data: { deletionState: 'RUNNING' },
      });
    return row
      ? { phase: row.phase, keys: row.storageKeys as string[], attempts: row.attempts }
      : null;
  }

  async finish(
    projectId: string,
    leaseToken: string,
    remaining: string[],
    cacheCleared: boolean,
    retryLater = true,
  ): Promise<void> {
    if (!remaining.length && cacheCleared) {
      await this.prisma.projectDeletionCleanup.deleteMany({ where: { projectId, leaseToken } });
    } else {
      await this.prisma.projectDeletionCleanup.updateMany({
        where: { projectId, leaseToken },
        data: {
          storageKeys: remaining,
          status: 'QUEUED',
          leaseToken: null,
          nextAttemptAt: new Date(Date.now() + (retryLater ? 60_000 : 0)),
        },
      });
    }
  }

  async hasPending(projectId: string): Promise<boolean> {
    return (await this.prisma.projectDeletionCleanup.count({ where: { projectId } })) > 0;
  }
}
