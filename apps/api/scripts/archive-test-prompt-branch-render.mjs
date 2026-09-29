// One-time repair for the backpack test project's pre-branch render batch.
// Dry-run by default. The batch and media remain in PostgreSQL/object storage.
import { loadEnvFile } from 'node:process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

try { loadEnvFile(resolve(import.meta.dirname, '../../../.env')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const require = createRequire(import.meta.url);
const { ConfigService } = require('@nestjs/config');
const { PrismaService } = require('../dist/database/prisma.service.js');

const projectId = '417c5d53-4d6c-471e-a834-bbf9cd01c57b';
const parentRunId = 'f4ee082f-7c4a-4251-99c2-9ebf232e2082';
const childRunId = '3400416d-0e8f-4819-ab47-591d1fb51c84';
const batchId = 'f7a5c0e6-2fd6-464f-aec0-4903eb6f4810';
const apply = process.argv.includes('--apply');
const rollback = new Error('DRY_RUN_ROLLBACK');
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const db = new PrismaService(new ConfigService({ DATABASE_URL: process.env.DATABASE_URL }));

try {
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "projects" WHERE "id" = ${projectId}::uuid FOR UPDATE`;
    const child = await tx.workflowRun.findFirstOrThrow({
      where: { projectId, id: childRunId, parentWorkflowRunId: parentRunId,
        forkNodeId: 'PROMPT_GENERATION', workflow: 'EFFECT', workflowSpace: 'EFFECT' },
    });
    assert(child.branchPublishedAt, 'Prompt child branch is not published');
    const batch = await tx.effectSegmentRenderBatch.findFirstOrThrow({
      where: { projectId, id: batchId, workflowRunId: childRunId },
      include: { tasks: true },
    });
    assert(batch.archivedAt === null && batch.status === 'COMPLETED' &&
      batch.sourcePromptRevision === 2 && batch.committedAt === null &&
      batch.tasks.length === 20 && batch.tasks.every((task) => task.status === 'COMPLETED'),
    'Render batch does not match the investigated 20-task pre-branch draft');
    assert(batch.createdAt < child.createdAt,
      'Only the batch created before the child branch may be archived');
    const otherBatches = await tx.effectSegmentRenderBatch.count({
      where: { projectId, workflowRunId: childRunId, id: { not: batchId }, archivedAt: null },
    });
    const downstreamArtifacts = await tx.workingArtifact.count({
      where: { projectId, workflowRunId: childRunId,
        nodeId: { in: ['SEGMENT_RENDER', 'TEMPLATE_MIX', 'FINAL_OUTPUT'] } },
    });
    assert(otherBatches === 0 && downstreamArtifacts === 0,
      'Child branch gained other downstream content; repair must be reconsidered');
    await tx.effectSegmentRenderBatch.update({
      where: { id: batchId }, data: { archivedAt: new Date(), activeKey: null },
    });
    const result = { projectId, childRunId, archivedBatchId: batchId,
      retainedCompletedTasks: batch.tasks.length, mode: apply ? 'applied' : 'dry-run' };
    if (!apply) {
      console.log(JSON.stringify(result));
      throw rollback;
    }
    console.log(JSON.stringify(result));
  }, { timeout: 30000 });
} catch (error) {
  if (error !== rollback) throw error;
} finally {
  await db.$disconnect();
}
