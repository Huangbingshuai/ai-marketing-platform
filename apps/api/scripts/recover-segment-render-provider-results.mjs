// Recover completed provider results, never create a new provider task.
// Run from the repository root after building the API. Default: transaction rollback.
// node apps/api/scripts/recover-segment-render-provider-results.mjs <projectId> <batchId> [--execute]
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../dist/database/prisma.service.js';
import {
  EffectSegmentRenderRepository,
  effectSegmentRenderBatchInclude,
} from '../dist/workflows/effect/segment-render/effect-segment-render.repository.js';

const [projectId, batchId, mode] = process.argv.slice(2);
const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/iu;
assert.ok(
  uuid.test(projectId ?? '') && uuid.test(batchId ?? ''),
  'Project/batch UUIDs are required',
);
assert.ok(mode === undefined || mode === '--execute', 'Only --execute is supported');
process.loadEnvFile('.env');
const config = {
  get: () => undefined,
  getOrThrow: (key) => {
    assert.ok(process.env[key], `Missing configuration: ${key}`);
    return process.env[key];
  },
};
const prisma = new PrismaService(config);
const rollback = new Error('RECOVERY_DRY_RUN_ROLLBACK');
let summary;
try {
  await prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`
      SELECT "id" FROM "effect_segment_render_batches"
      WHERE "projectId" = ${projectId}::uuid AND "id" = ${batchId}::uuid FOR UPDATE
    `;
      const batch = await tx.effectSegmentRenderBatch.findFirst({
        where: { projectId, id: batchId, archivedAt: null },
        include: effectSegmentRenderBatchInclude,
      });
      assert.ok(batch, 'Recoverable batch not found');
      const project = await tx.project.findFirst({ where: { id: projectId, status: 'ACTIVE' } });
      const run = await tx.workflowRun.findFirst({
        where: {
          projectId,
          id: batch.workflowRunId,
          workflow: 'EFFECT',
          status: { in: ['ACTIVE', 'PAUSED'] },
        },
      });
      assert.ok(project && run, 'Project/run is not editable');
      assert.ok(
        !batch.tasks.some((task) => ['QUEUED', 'RUNNING'].includes(task.status)),
        'Batch is active',
      );
      const tasks = batch.tasks.filter(
        (task) =>
          task.status === 'FAILED' &&
          task.operationKind === 'GENERATE' &&
          task.repairStatus === null &&
          task.errorCode === 'INTERNAL_API_ERROR' &&
          task.progress >= 92 &&
          !task.outputFileObjectId &&
          task.providerTaskId?.trim(),
      );
      assert.ok(tasks.length, 'No completed provider results to recover');
      const expectedProviderIds = new Map(tasks.map((task) => [task.id, task.providerTaskId]));
      let checkedWrites = 0;
      // Guard the actual repository writes in the same transaction, not just preflight data.
      // Any attempt to clear/change the provider ID rolls back the whole batch and Outbox.
      const guardedTasks = new Proxy(tx.effectSegmentRenderTask, {
        get(target, key) {
          if (key !== 'update') return Reflect.get(target, key);
          return async (args) => {
            const id = args.where.projectId_id?.id;
            assert.ok(expectedProviderIds.has(id), 'Unexpected task mutation');
            assert.equal(
              args.data.providerTaskId,
              expectedProviderIds.get(id),
              'Refusing a billable recreate',
            );
            checkedWrites++;
            return target.update(args);
          };
        },
      });
      const guardedTx = new Proxy(tx, {
        get(target, key) {
          return key === 'effectSegmentRenderTask' ? guardedTasks : Reflect.get(target, key);
        },
      });
      const repository = new EffectSegmentRenderRepository({
        $transaction: (callback) => callback(guardedTx),
      });
      const result = await repository.regenerateTasks(
        projectId,
        batchId,
        tasks.map(({ id }) => id),
        batch.revision,
        'recover-provider-result:' + randomUUID(),
        {
          sourcePrompt: {
            artifactId: batch.sourcePromptArtifactId,
            revision: batch.sourcePromptRevision,
            contentHash: batch.sourcePromptHash,
          },
          taskSnapshots: Object.fromEntries(tasks.map((task) => [task.id, task.requestSnapshot])),
          sourcePackage: tasks[0].requestSnapshot.sourcePackage,
        },
      );
      assert.equal(result.kind, 'UPDATED', `Recovery blocked: ${result.kind}`);
      assert.equal(checkedWrites, tasks.length);
      summary = {
        mode: mode === '--execute' ? 'execute' : 'rollback',
        recoveredTasks: checkedWrites,
      };
      if (mode !== '--execute') throw rollback;
    },
    { maxWait: 10_000, timeout: 60_000 },
  );
  console.log(JSON.stringify(summary));
} catch (error) {
  if (error === rollback) console.log(JSON.stringify(summary));
  else {
    // Do not expose DB configuration, prompts or signed media URLs in maintenance output.
    console.error(error?.name === 'AssertionError' ? error.message : 'Recovery transaction failed');
    process.exitCode = 1;
  }
} finally {
  await prisma.$disconnect();
}
