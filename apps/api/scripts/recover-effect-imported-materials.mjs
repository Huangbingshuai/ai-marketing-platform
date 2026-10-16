// Scoped recovery of confirmed external imports after a lost pool index.
// Run from the repository root. Read-only unless --apply is explicitly supplied.
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const recoveryBatchInclude = {
  tasks: { orderBy: [{ renderCode: 'asc' }, { id: 'asc' }] },
  product: true,
};

export function recoveredImportSnapshot(source, targetBase) {
  if (!source.importedMaterial) throw new Error('RECOVERY_REQUIRES_EXTERNAL_IMPORT');
  const snapshot = structuredClone(source);
  for (const field of [
    'projectId',
    'workflowRunId',
    'productId',
    'productName',
    'sourcePrompt',
    'sourcePackage',
  ])
    snapshot[field] = structuredClone(targetBase[field]);
  // This is adoption of the existing file, not replay of an in-flight generation.
  for (const field of ['adoptedInput', 'refreshContext', 'repair', 'inputVideo'])
    delete snapshot[field];
  snapshot.operation = 'GENERATE';
  snapshot.inputImages = [];
  return snapshot;
}

async function main() {
  const [projectId, targetBatchId, sourceBatchId, ...options] = process.argv.slice(2);
  const apply = options.includes('--apply');
  const codes = options.filter((item) => item !== '--apply');
  const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
  if (
    ![projectId, targetBatchId, sourceBatchId].every((id) => uuid.test(id ?? '')) ||
    !codes.length ||
    codes.some((code) => !/^R-\d{3}$/.test(code))
  )
    throw new Error('USAGE: projectId targetBatchId sourceBatchId R-021 R-022 [--apply]');
  process.loadEnvFile('.env');
  const require = createRequire(resolve('apps/api/package.json'));
  const { PrismaPg } = require('@prisma/adapter-pg');
  const { PrismaClient } = require(resolve('apps/api/dist/generated/prisma/client.js'));
  const { WorkflowWorkingRepository, workingArtifactContentHash } = require(
    resolve('apps/api/dist/platform/workflow/workflow-working.repository.js'),
  );
  const { EffectSegmentRenderRepository } = require(
    resolve('apps/api/dist/workflows/effect/segment-render/effect-segment-render.repository.js'),
  );
  const { EffectSegmentRenderService } = require(
    resolve('apps/api/dist/workflows/effect/segment-render/effect-segment-render.service.js'),
  );
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });
  try {
    // Match the normal render repository's canonical order. Random UUID order
    // changes file sortOrder / pool fingerprints and falsely reports an unsaved edit.
    const load = (client, id) =>
      client.effectSegmentRenderBatch.findFirstOrThrow({
        where: { projectId, id, archivedAt: null },
        include: recoveryBatchInclude,
      });
    const target = await load(db, targetBatchId),
      source = await load(db, sourceBatchId);
    const sourcePool = await db.workingArtifact.findFirstOrThrow({
      where: {
        projectId,
        workflowRunId: source.workflowRunId,
        artifactKey: `render-batch:${source.productId}`,
        nodeId: 'SEGMENT_RENDER',
        availability: 'AVAILABLE',
      },
    });
    if (!source.committedAt || source.status !== 'COMPLETED')
      throw new Error('SOURCE_NOT_CONFIRMED');
    const chosen = codes.map((code) => {
      const task = source.tasks.find((task) => task.renderCode === code);
      const clip = sourcePool.payload.clips?.find((clip) => clip.taskId === task?.id);
      if (
        !task ||
        !clip ||
        task.status !== 'COMPLETED' ||
        !task.requestSnapshot.importedMaterial ||
        clip.fileObjectId !== task.outputFileObjectId ||
        clip.contentHash !== task.outputContentHash ||
        clip.version !== task.activeOutputVersion ||
        task.repairStatus
      )
        throw new Error('SOURCE_IMPORT_NOT_EXACTLY_CONFIRMED');
      return task;
    });
    if (new Set(chosen.map((task) => task.promptId)).size !== codes.length)
      throw new Error('DUPLICATE_RECOVERY_SOURCE');
    // Read file bytes through the ordinary project file endpoint; never log keys/URLs/content.
    for (const task of chosen) {
      const file = await db.fileObject.findFirstOrThrow({
        where: { projectId, id: task.outputFileObjectId },
      });
      if (file.sha256 !== task.outputContentHash || file.sizeBytes !== task.outputSizeBytes)
        throw new Error('FILE_IDENTITY_MISMATCH');
      const response = await fetch(
        `http://localhost:3100/api/projects/${projectId}/file-objects/${file.id}/content`,
      );
      if (!response.ok || !response.body) throw new Error('RECOVERY_FILE_UNAVAILABLE');
      const hash = createHash('sha256');
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        hash.update(chunk);
      }
      if (size !== file.sizeBytes || hash.digest('hex') !== file.sha256)
        throw new Error('RECOVERY_FILE_CORRUPT');
    }
    const result = await db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM projects WHERE id=${projectId}::uuid FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM effect_segment_render_batches WHERE id=${targetBatchId}::uuid AND "projectId"=${projectId}::uuid FOR UPDATE`;
        const before = await load(tx, targetBatchId);
        if (
          before.revision !== target.revision ||
          !before.committedAt ||
          before.status !== 'COMPLETED'
        )
          throw new Error('TARGET_CHANGED');
        const currentSource = await load(tx, sourceBatchId);
        const currentPool = await tx.workingArtifact.findUniqueOrThrow({
          where: { id: sourcePool.id },
        });
        if (
          currentSource.revision !== source.revision ||
          !currentSource.committedAt ||
          currentPool.revision !== sourcePool.revision ||
          currentPool.contentHash !== sourcePool.contentHash ||
          chosen.some(
            (task) =>
              !currentSource.tasks.some(
                (current) =>
                  current.id === task.id &&
                  current.status === 'COMPLETED' &&
                  current.activeOutputVersion === task.activeOutputVersion &&
                  current.outputFileObjectId === task.outputFileObjectId &&
                  current.outputContentHash === task.outputContentHash,
              ),
          )
        )
          throw new Error('SOURCE_CHANGED');
        const run = await tx.workflowRun.findFirstOrThrow({
          where: { projectId, id: before.workflowRunId },
        });
        if (run.editSessionNodeId || run.parentWorkflowRunId || run.activeKey !== 'ACTIVE')
          throw new Error('RECOVERY_TARGET_MUST_BE_ACTIVE_ROOT');
        const activeTasks = await tx.effectSegmentRenderTask.count({
          where: { projectId, status: { in: ['RUNNING', 'QUEUED'] } },
        });
        if (activeTasks) throw new Error('ACTIVE_RENDER_TASKS');
        const missing = chosen.filter((task) => {
          const same = before.tasks.find(
            (current) =>
              current.promptId === task.promptId || current.renderCode === task.renderCode,
          );
          if (!same) return true;
          if (
            same.outputFileObjectId !== task.outputFileObjectId ||
            same.outputContentHash !== task.outputContentHash ||
            same.errorCode === 'MATERIAL_DELETED'
          )
            throw new Error('EXISTING_OR_DELETED_IMPORT_CONFLICT');
          return false;
        });
        if (!apply)
          return { mode: 'dry-run', before: before.tasks.length, restore: missing.length };
        const base = before.tasks[0].generationRequestSnapshot;
        // File ownership must already have been safely transferred by template cleanup.
        for (const task of missing) {
          const file = await tx.fileObject.findFirstOrThrow({
            where: { projectId, id: task.outputFileObjectId, workflowRunId: run.id },
          });
          const snapshot = recoveredImportSnapshot(task.requestSnapshot, base);
          await tx.effectSegmentRenderTask.create({
            data: {
              id: randomUUID(),
              projectId,
              workflowRunId: run.id,
              productId: before.productId,
              batchId: before.id,
              promptId: task.promptId,
              promptCode: task.promptCode,
              renderCode: task.renderCode,
              sourceFingerprint: task.sourceFingerprint,
              requestSnapshot: snapshot,
              generationRequestSnapshot: snapshot,
              status: 'COMPLETED',
              progress: 100,
              renderVersion: task.renderVersion,
              activeOutputVersion: task.activeOutputVersion,
              outputFileObjectId: file.id,
              outputStorageKey: task.outputStorageKey,
              outputFileName: task.outputFileName,
              outputMimeType: task.outputMimeType,
              outputSizeBytes: task.outputSizeBytes,
              outputContentHash: task.outputContentHash,
              ...(task.outputPoster ? { outputPoster: task.outputPoster } : {}),
              completedAt: task.completedAt,
            },
          });
        }
        if (missing.length)
          await tx.effectSegmentRenderBatch.update({
            where: { id: before.id },
            data: { revision: { increment: 1 }, committedAt: null },
          });
        const after = await load(tx, before.id);
        const existing = await tx.workingArtifact.findMany({
          where: { projectId, workflowRunId: run.id, nodeId: 'SEGMENT_RENDER' },
        });
        // Reuse the normal artifact compiler and transaction-bound publication, without
        // booting an application context, starting workers, or creating any model job.
        const inputs = EffectSegmentRenderService.prototype.artifactInputs.call(
          {},
          after,
          existing,
        );
        const poolInput = inputs.find(
          (item) => item.artifactKey === `render-batch:${before.productId}`,
        );
        const pool = existing.find((item) => item.artifactKey === poolInput.artifactKey);
        if (!missing.length && pool?.contentHash === workingArtifactContentHash(poolInput.input))
          return { mode: 'unchanged', before: before.tasks.length, restore: 0 };
        const working = new WorkflowWorkingRepository(db);
        const repository = new EffectSegmentRenderRepository(
          { $transaction: async (fn) => fn(tx) },
          working,
        );
        const committed = await repository.commitValidatedBatch(
          projectId,
          after.id,
          after.revision,
          base.sourcePrompt,
          base.sourcePackage,
          inputs,
        );
        if (committed.kind !== 'COMMITTED') throw new Error(`RECOVERY_COMMIT_${committed.kind}`);
        return {
          mode: missing.length ? 'applied' : 'reconciled',
          before: before.tasks.length,
          restored: missing.length,
          after: after.tasks.length,
        };
      },
      { timeout: 30_000 },
    );
    console.log(JSON.stringify(result));
  } finally {
    await db.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch((error) => {
    // Do not leak Prisma diagnostics, signed URLs, storage keys or request bodies.
    console.error(/^[A-Z_]+$/.test(error.message) ? error.message : 'RECOVERY_FAILED');
    process.exitCode = 1;
  });
