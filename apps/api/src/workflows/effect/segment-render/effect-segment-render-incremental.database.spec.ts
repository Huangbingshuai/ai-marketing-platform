import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { expect, it } from 'vitest';
import type { EffectSegmentRenderRequestSnapshot } from '@ai-marketing/contracts';
import type { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { EffectSegmentRenderRepository } from './effect-segment-render.repository';

// Self-contained and rollback-only: no existing user project is selected or restored, no Outbox
// message is committed, and no storage/model call can escape this transaction.
it.skipIf(process.env.EFFECT_INCREMENTAL_DATABASE_TEST !== '1')(
  'atomically syncs metadata, removes material and appends paid tasks with idempotent Outbox, then rolls back',
  async () => {
    const db = new PrismaService(
      new ConfigService({
        DATABASE_URL:
          process.env.DATABASE_URL ??
          'postgresql://postgres:postgres@localhost:5432/ai_marketing?schema=public',
      }),
    );
    const rollback = new Error('INCREMENTAL_TEST_ROLLBACK');
    const projectId = randomUUID();
    try {
      await expect(
        db.$transaction(
          async (tx) => {
            await tx.project.create({ data: { id: projectId, name: '回滚专用增量测试' } });
            const run = await tx.workflowRun.create({
              data: { projectId, workflow: 'EFFECT', workflowSpace: 'EFFECT',
                editSessionNodeId: 'SEGMENT_RENDER', editSessionPurpose: 'MANUAL',
                editIdMap: { renderBatchRevisions: { baseline: 1 } } },
            });
            const workspace = await tx.effectImportWorkspace.create({
              data: { projectId, workflowRunId: run.id },
            });
            const draft = await tx.effectImportDraft.create({
              data: {
                projectId,
                workspaceId: workspace.id,
                mode: 'SINGLE',
                globalConfig: {},
                validationIssues: [],
              },
            });
            const product = await tx.effectImportProduct.create({
              data: { projectId, workflowRunId: run.id, draftId: draft.id, configOverride: {} },
            });
            const artifactData = {
              projectId,
              workflowRunId: run.id,
              kind: 'STRUCTURED' as const,
              name: '回滚测试来源',
              directory: 'VIDEO_MATERIALS' as const,
              type: 'VIDEO_MATERIAL' as const,
              contentHash: 'a'.repeat(64),
            };
            const prompt = await tx.workingArtifact.create({
              data: {
                ...artifactData,
                nodeId: 'PROMPT_GENERATION',
                artifactKey: `prompt-batch:${product.id}`,
                revision: 2,
              },
            });
            const source = await tx.workingArtifact.create({
              data: {
                ...artifactData,
                nodeId: 'SOURCE_IMPORT',
                artifactKey: `source-package:${product.id}`,
              },
            });
            const batch = await tx.effectSegmentRenderBatch.create({
              data: {
                projectId,
                workflowRunId: run.id,
                productId: product.id,
                sourcePromptArtifactId: prompt.id,
                sourcePromptRevision: prompt.revision,
                sourcePromptHash: prompt.contentHash,
                sourceFingerprint: 'a'.repeat(64),
                requestHash: 'a'.repeat(64),
                idempotencyKey: 'baseline',
                status: 'COMPLETED',
                activeKey: null,
              },
            });
            const old = await tx.effectSegmentRenderTask.create({
              data: {
                projectId,
                workflowRunId: run.id,
                productId: product.id,
                batchId: batch.id,
                promptId: randomUUID(),
                promptCode: 'P001',
                renderCode: 'R-001',
                sourceFingerprint: 'a'.repeat(64),
                requestSnapshot: {},
                generationRequestSnapshot: {},
                status: 'COMPLETED',
                outputStorageKey: 'fixture/old.mp4',
                progress: 100,
              },
            });
            const scopedDb = new Proxy(db, {
              get(_target, key) {
                if (key === '$transaction')
                  return async <T>(fn: (client: Prisma.TransactionClient) => Promise<T>) => fn(tx);
                return Reflect.get(tx, key);
              },
            });
            const repo = new EffectSegmentRenderRepository(scopedDb);
            const promptId = randomUUID(),
              newTaskId = randomUUID();
            const snapshot = {
              promptId,
              sourcePackage: {
                artifactId: source.id,
                revision: source.revision,
                contentHash: source.contentHash,
              },
            } as EffectSegmentRenderRequestSnapshot;
            const input = {
              sourcePrompt: {
                artifactId: prompt.id,
                revision: prompt.revision,
                contentHash: prompt.contentHash,
              },
              taskSnapshots: {},
              refreshRequestHash: 'b'.repeat(64),
              addedTasks: [
                {
                  id: newTaskId,
                  promptId,
                  promptCode: 'P002',
                  renderCode: 'R-002',
                  sourceFingerprint: 'b'.repeat(64),
                  requestSnapshot: snapshot,
                },
              ],
            };
            const metadataTask = await tx.effectSegmentRenderTask.create({ data: {
              projectId, workflowRunId: run.id, productId: product.id, batchId: batch.id,
              promptId: randomUUID(), promptCode: 'P003', renderCode: 'R-003',
              sourceFingerprint: 'c'.repeat(64), requestSnapshot: {}, generationRequestSnapshot: {},
              status: 'COMPLETED', progress: 100, outputStorageKey: 'fixture/metadata.mp4',
            } });
            const removedTask = await tx.effectSegmentRenderTask.create({ data: {
              projectId, workflowRunId: run.id, productId: product.id, batchId: batch.id,
              promptId: randomUUID(), promptCode: 'P004', renderCode: 'R-004',
              sourceFingerprint: 'd'.repeat(64), requestSnapshot: {}, generationRequestSnapshot: {},
              status: 'COMPLETED', progress: 100, outputStorageKey: 'fixture/deleted.mp4',
            } });
            const freeInput = { sourcePrompt: input.sourcePrompt, sourcePackage: snapshot.sourcePackage,
              autoCommitPromptRefresh: true,
              refreshContext: { schemaVersion: 1 as const, confirmationSignature: 'free-update', sourcePrompt: input.sourcePrompt },
              taskSnapshots: {}, metadataSnapshots: { [metadataTask.id]: {
                ...snapshot, promptId: metadataTask.promptId, creativeCore: '更新创意信息',
              } }, removedTaskIds: [removedTask.id] };
            expect(await repo.regenerateTasks(projectId, batch.id, [], 1, 'free-refresh', freeInput))
              .toEqual({ kind: 'UPDATED' });
            expect(await tx.jobOutbox.count({ where: { projectId } })).toBe(0);
            expect((await tx.workflowRun.findUniqueOrThrow({ where: { id: run.id } })).editIdMap)
              .toMatchObject({ autoCommitPromptRefresh: batch.id, frozenPromptRefresh: true,
                renderProgress: { batchId: batch.id, taskIds: [] },
                renderBatchRevisions: { baseline: 1 } });
            const metadataAfter = await tx.effectSegmentRenderTask.findUniqueOrThrow({ where: { id: metadataTask.id } });
            expect(metadataAfter.renderVersion).toBe(metadataTask.renderVersion);
            expect(metadataAfter.outputStorageKey).toBe(metadataTask.outputStorageKey);
            expect(await tx.effectSegmentRenderTask.findUniqueOrThrow({ where: { id: removedTask.id } }))
              .toMatchObject({ errorCode: 'MATERIAL_DELETED', outputStorageKey: null });
            expect(await tx.effectSegmentRenderBatch.findUniqueOrThrow({ where: { id: batch.id } }))
              .toMatchObject({ status: 'COMPLETED', revision: 2, activeKey: null });
            expect(
              (await repo.regenerateTasks(projectId, batch.id, [], 2, 'incremental', input)).kind,
            ).toBe('UPDATED');
            expect(
              (await repo.regenerateTasks(projectId, batch.id, [], 2, 'incremental', input)).kind,
            ).toBe('REPLAYED');
            expect((await tx.workflowRun.findUniqueOrThrow({ where: { id: run.id } })).editIdMap)
              .toMatchObject({ renderProgress: { batchId: batch.id, taskIds: [newTaskId] },
                renderBatchRevisions: { baseline: 1 } });
            expect(await tx.effectSegmentRenderTask.findUnique({ where: { id: old.id } })).toEqual(
              old,
            );
            expect(
              await tx.effectSegmentRenderTask.count({ where: { projectId, batchId: batch.id } }),
            ).toBe(4);
            expect(await tx.jobOutbox.count({ where: { projectId, aggregateId: newTaskId } })).toBe(
              1,
            );
            expect(await tx.workflowRun.count({ where: { projectId } })).toBe(1);
            throw rollback;
          },
          { timeout: 30_000 },
        ),
      ).rejects.toThrow(rollback.message);
      expect(await db.project.count({ where: { id: projectId } })).toBe(0);
      expect(await db.jobOutbox.count({ where: { projectId } })).toBe(0);
    } finally {
      await db.$disconnect();
    }
  },
);
