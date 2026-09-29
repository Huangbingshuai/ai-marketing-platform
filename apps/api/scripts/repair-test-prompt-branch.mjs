// One-time recovery for the paid backpack test project. Dry-run by default.
// Requires the API dist built from the Prompt branch implementation.
import { loadEnvFile } from 'node:process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

try { loadEnvFile(resolve(import.meta.dirname, '../../../.env')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const require = createRequire(import.meta.url);
const { ConfigService } = require('@nestjs/config');
const { PrismaService } = require('../dist/database/prisma.service.js');
const { WorkflowWorkingRepository, workingArtifactContentHash } =
  require('../dist/platform/workflow/workflow-working.repository.js');
const { EffectPromptRepository } =
  require('../dist/workflows/effect/prompt-generation/effect-prompt.repository.js');
const { workflowStateHash } = require('../dist/platform/workflow/workflow-state-hash.js');

const projectId = '417c5d53-4d6c-471e-a834-bbf9cd01c57b';
const expectedParentId = 'f4ee082f-7c4a-4251-99c2-9ebf232e2082';
const expectedNewBatchId = 'f7a5c0e6-2fd6-464f-aec0-4903eb6f4810';
const apply = process.argv.includes('--apply');
const db = new PrismaService(new ConfigService({ DATABASE_URL: process.env.DATABASE_URL }));
const repository = new EffectPromptRepository(db, new WorkflowWorkingRepository(db));
const dryRunRollback = new Error('DRY_RUN_ROLLBACK');
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const remapJson = (value, before, after) =>
  JSON.parse(JSON.stringify(value).replaceAll(before, after));

try {
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "projects" WHERE "id" = ${projectId}::uuid FOR UPDATE`;
    const parent = await tx.workflowRun.findUniqueOrThrow({ where: { id: expectedParentId } });
    assert(parent.projectId === projectId && parent.activeKey === 'ACTIVE' &&
      parent.parentWorkflowRunId === null, 'Expected active root changed');
    assert(await tx.workflowRun.count({ where: { projectId } }) === 1,
      'Project already has a branch; do not repeat recovery');
    const product = await tx.effectImportProduct.findFirstOrThrow({
      where: { projectId, workflowRunId: parent.id, status: 'ACTIVE' },
    });
    const artifactKey = `prompt-batch:${product.id}`;
    const current = await tx.workingArtifact.findUniqueOrThrow({
      where: { projectId_workflowRunId_nodeId_artifactKey: {
        projectId, workflowRunId: parent.id,
        nodeId: 'PROMPT_GENERATION', artifactKey,
      } }, include: { dependencies: true, files: true },
    });
    assert(current.revision === 2, 'Expected current Prompt revision 2');
    const oldSnapshot = await tx.workingArtifactRevisionSnapshot.findFirstOrThrow({
      where: { projectId, workflowRunId: parent.id, nodeId: 'PROMPT_GENERATION',
        artifactKey, revision: 1 },
    });
    const newSnapshot = await tx.workingArtifactRevisionSnapshot.findFirstOrThrow({
      where: { projectId, workflowRunId: parent.id, nodeId: 'PROMPT_GENERATION',
        artifactKey, revision: 2 },
    });
    assert(oldSnapshot.snapshot?.payload?.settings,
      'Old Prompt settings are missing');
    assert(oldSnapshot.snapshot.files?.length === 0 &&
      newSnapshot.snapshot.files?.length === 0 && current.files.length === 0,
      'Prompt artifact has files; recovery would need file-link migration');
    const newResult = await tx.effectPromptResult.findUniqueOrThrow({
      where: { id: current.sourceArtifactId }, include: { run: true },
    });
    assert(newResult.workflowRunId === parent.id &&
      newResult.runId === current.sourceRunId, 'New Prompt result identity changed');
    const oldResult = await tx.effectPromptResult.findUniqueOrThrow({
      where: { id: oldSnapshot.snapshot.sourceArtifactId },
    });
    assert(oldResult.workflowRunId === parent.id,
      'Old Prompt result is not in the parent');
    const newBatch = await tx.effectSegmentRenderBatch.findUniqueOrThrow({
      where: { id: expectedNewBatchId }, include: { tasks: true },
    });
    assert(newBatch.workflowRunId === parent.id &&
      newBatch.sourcePromptRevision === 2 && !newBatch.committedAt &&
      newBatch.tasks.length === 20 &&
      newBatch.tasks.every((task) => task.status === 'COMPLETED'),
      'New render batch changed or is still running');
    const otherBatches = await tx.effectSegmentRenderBatch.findMany({
      where: { projectId, workflowRunId: parent.id, id: { not: newBatch.id } },
    });
    assert(otherBatches.every((batch) => batch.sourcePromptRevision === 1),
      'Another downstream batch requires separate migration');

    const fork = await repository.forkValidatedPromptInTransaction(
      tx, projectId, parent.id, product.id,
    );
    const childInsight = await tx.workingArtifact.findUniqueOrThrow({
      where: { id: fork.childInsightId },
    });
    const childSource = await tx.workingArtifact.findFirstOrThrow({
      where: { projectId, workflowRunId: fork.childRunId,
        nodeId: 'SOURCE_IMPORT', artifactKey: `source-package:${fork.childProductId}` },
    });
    const remapDependency = (dependency) => ({
      projectId, workflowRunId: fork.childRunId,
      sourceType: dependency.sourceType,
      sourceNodeId: dependency.sourceNodeId?.replaceAll(product.id, fork.childProductId) ?? null,
      sourceArtifactId: dependency.sourceType === 'WORKING_ARTIFACT'
        ? childInsight.id : dependency.sourceArtifactId,
      sourceKey: dependency.sourceKey.replaceAll(product.id, fork.childProductId),
      sourceRevision: dependency.sourceRevision,
      sourceHash: dependency.sourceType === 'WORKING_ARTIFACT'
        ? childInsight.contentHash : dependency.sourceHash,
    });
    const childPayload = current.payload;
    const childMetadata = fork.remap(current.metadata);
    const childDependencies = current.dependencies.map(remapDependency);
    const childInput = {
      kind: current.kind, name: current.name, directory: current.directory,
      type: current.type, tags: current.tags, payload: childPayload,
      metadata: childMetadata,
      dependencies: childDependencies.map(({ projectId: _project, workflowRunId: _run,
        ...dependency }) => dependency),
    };
    const childPrompt = await tx.workingArtifact.create({
      data: {
        projectId, workflowRunId: fork.childRunId,
        nodeId: 'PROMPT_GENERATION', artifactKey: `prompt-batch:${fork.childProductId}`,
        kind: current.kind, name: current.name, directory: current.directory,
        type: current.type, tags: current.tags, payload: childPayload,
        metadata: childMetadata, revision: 2,
        sourceRunId: current.sourceRunId,
        sourceArtifactId: current.sourceArtifactId,
        contentHash: workingArtifactContentHash(childInput),
        freshness: 'CURRENT', availability: 'AVAILABLE',
      },
    });
    await tx.workingArtifactDependency.createMany({
      data: childDependencies.map((dependency) => ({
        ...dependency, dependentArtifactId: childPrompt.id,
      })),
    });
    await tx.workingArtifactRevisionSnapshot.update({
      where: { id: newSnapshot.id },
      data: {
        workflowRunId: fork.childRunId, workingArtifactId: childPrompt.id,
        artifactKey: `prompt-batch:${fork.childProductId}`,
        contentHash: childPrompt.contentHash,
        snapshot: {
          ...newSnapshot.snapshot,
          metadata: childMetadata,
          dependencies: childDependencies.map(({ projectId: _project,
            workflowRunId: _run, ...dependency }) => dependency),
        },
      },
    });
    const childRunSnapshot = fork.remap(newResult.run.inputSnapshot);
    childRunSnapshot.workflowRunId = fork.childRunId;
    childRunSnapshot.productId = fork.childProductId;
    childRunSnapshot.insightArtifact = {
      ...childRunSnapshot.insightArtifact,
      id: childInsight.id, revision: childInsight.revision,
      contentHash: childInsight.contentHash,
    };
    await tx.effectPromptRun.update({
      where: { id: newResult.runId },
      data: { workflowRunId: fork.childRunId, productId: fork.childProductId,
        inputSnapshot: childRunSnapshot },
    });
    await tx.effectPromptResult.update({
      where: { id: newResult.id },
      data: { workflowRunId: fork.childRunId, productId: fork.childProductId },
    });
    const old = oldSnapshot.snapshot;
    await tx.workingArtifact.update({
      where: { id: current.id },
      data: {
        revision: 1, contentHash: oldSnapshot.contentHash,
        kind: old.kind, name: old.name, directory: old.directory,
        type: old.type, tags: old.tags,
        payload: old.payload, metadata: old.metadata,
        sourceRunId: old.sourceRunId,
        sourceArtifactId: old.sourceArtifactId,
        freshness: 'CURRENT', availability: 'AVAILABLE',
      },
    });
    await tx.workingArtifactDependency.deleteMany({
      where: { projectId, dependentArtifactId: current.id },
    });
    await tx.workingArtifactDependency.createMany({
      data: old.dependencies.map((dependency) => ({
        projectId, workflowRunId: parent.id,
        dependentArtifactId: current.id, ...dependency,
      })),
    });
    const oldSettings = old.payload.settings;
    const oldSettingsHash = workflowStateHash(oldSettings);
    const settingsDependency = old.dependencies.find(
      (dependency) => dependency.sourceType === 'EXECUTION_INPUT',
    );
    assert(settingsDependency?.sourceHash === oldSettingsHash,
      'Old settings hash does not match the preserved artifact');
    await tx.workflowNodeState.update({
      where: { projectId_workflowRunId_nodeId: {
        projectId, workflowRunId: parent.id,
        nodeId: `PROMPT_GENERATION:${product.id}`,
      } },
      data: { state: oldSettings, contentHash: oldSettingsHash,
        executionInputHash: oldSettingsHash, revision: { increment: 1 } },
    });
    const taskSnapshot = (value) => {
      const next = remapJson(value, product.id, fork.childProductId);
      if (next.sourcePrompt) next.sourcePrompt = {
        ...next.sourcePrompt, artifactId: childPrompt.id,
        contentHash: childPrompt.contentHash,
      };
      if (next.sourcePackage) next.sourcePackage = {
        ...next.sourcePackage, artifactId: childSource.id,
        contentHash: childSource.contentHash,
      };
      return next;
    };
    await tx.effectSegmentRenderBatch.update({
      where: { id: newBatch.id },
      data: { workflowRunId: fork.childRunId, productId: fork.childProductId,
        sourcePromptArtifactId: childPrompt.id,
        sourcePromptHash: childPrompt.contentHash },
    });
    for (const task of newBatch.tasks) {
      const requestSnapshot = taskSnapshot(task.requestSnapshot);
      await tx.effectSegmentRenderTask.update({
        where: { id: task.id },
        data: { workflowRunId: fork.childRunId, productId: fork.childProductId,
          requestSnapshot,
          generationRequestSnapshot: taskSnapshot(task.generationRequestSnapshot),
          sourceFingerprint: workflowStateHash(requestSnapshot) },
      });
    }
    // Every stale mark in this exact project was made by the revision-2 confirmation.
    const stale = await tx.workingArtifact.findMany({
      where: { projectId, workflowRunId: parent.id, freshness: 'STALE' },
      select: { id: true, updatedAt: true },
    });
    assert(stale.length === 16 && stale.every(({ updatedAt }) =>
      updatedAt.toISOString().startsWith('2026-09-28T16:17:12.')),
      'Stale descendants no longer match the investigated incident');
    await tx.workingArtifact.updateMany({
      where: { projectId, id: { in: stale.map(({ id }) => id) } },
      data: { freshness: 'CURRENT' },
    });
    await tx.workflowRun.update({ where: { id: parent.id }, data: { activeKey: null } });
    await tx.workflowRun.update({
      where: { id: fork.childRunId },
      data: { activeKey: 'ACTIVE', branchPublishedAt: new Date() },
    });
    const result = {
      parent: parent.id, child: fork.childRunId,
      parentPromptRevision: 1, childPromptRevision: 2,
      movedRenderTasks: newBatch.tasks.length,
      restoredParentArtifacts: stale.length,
    };
    console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', ...result }, null, 2));
    if (!apply) throw dryRunRollback;
  }, { timeout: 60_000 });
} catch (error) {
  if (error !== dryRunRollback) throw error;
} finally {
  await db.$disconnect();
}
