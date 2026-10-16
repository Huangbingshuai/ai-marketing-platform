import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { expect, it } from 'vitest';
import type { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { WorkflowWorkingRepository } from '../../../platform/workflow/workflow-working.repository';
import { EffectSegmentRenderRepository } from './effect-segment-render.repository';
import { EffectSegmentRenderService } from './effect-segment-render.service';
import type { EffectSegmentRenderRequestSnapshot } from '@ai-marketing/contracts';

// Diagnostic only: use the real queue/completion/save repositories inside a rollback.
// No Outbox row escapes, and no provider/storage request is made.
it.skipIf(process.env.EFFECT_EDIT_DATABASE_TEST !== '1')(
  'regenerates one clip and saves the latest file into the original branch without duplicating clips',
  async () => {
    const db = new PrismaService(
      new ConfigService({
        DATABASE_URL:
          process.env.DATABASE_URL ??
          'postgresql://postgres:postgres@localhost:5432/ai_marketing?schema=public',
      }),
    );
    const rollback = new Error('REGENERATION_AUDIT_ROLLBACK');
    try {
      await db.$transaction(
        async (tx) => {
          const original = await tx.effectSegmentRenderBatch.findFirstOrThrow({
            where: {
              archivedAt: null,
              committedAt: { not: null },
              status: 'COMPLETED',
              workflowRun: {
                workflow: 'EFFECT',
                workflowSpace: 'EFFECT',
                OR: [{ parentWorkflowRunId: null }, { branchPublishedAt: { not: null } }],
              },
            },
            orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
          });
          const projectId = original.projectId;
          await tx.workflowRun.updateMany({
            where: { projectId, workflow: 'EFFECT', workflowSpace: 'EFFECT', activeKey: 'ACTIVE' },
            data: { activeKey: null },
          });
          await tx.workflowRun.update({
            where: { id: original.workflowRunId },
            data: { activeKey: 'ACTIVE' },
          });
          const working = new WorkflowWorkingRepository(db);
          const edit = await working.beginEffectNodeEditInTransaction(
            tx,
            projectId,
            original.workflowRunId,
            'SEGMENT_RENDER',
          );
          expect(edit?.created).toBe(true);
          const child = await tx.effectSegmentRenderBatch.findFirstOrThrow({
            where: {
              projectId,
              workflowRunId: edit!.runId,
              productId: edit!.productIdMap[original.productId]!,
            },
          });
          const task = await tx.effectSegmentRenderTask.findFirstOrThrow({
            where: {
              projectId,
              batchId: child.id,
              status: 'COMPLETED',
              outputFileObjectId: { not: null },
            },
          });
          const before = await tx.workingArtifact.findMany({
            where: {
              projectId,
              workflowRunId: original.workflowRunId,
              artifactKey: { startsWith: 'render-clip:' },
            },
          });
          const originalClip = before.find(
            (clip) => (clip.payload as { promptId?: string } | null)?.promptId === task.promptId,
          )!;
          expect(originalClip).toBeDefined();
          const scopedDb = new Proxy(db, {
            get(_target, key) {
              if (key === '$transaction')
                return async <T>(callback: (value: Prisma.TransactionClient) => Promise<T>) =>
                  callback(tx);
              return Reflect.get(tx, key);
            },
          }) as PrismaService;
          const scopedWorking = new WorkflowWorkingRepository(scopedDb);
          const render = new EffectSegmentRenderRepository(scopedDb, scopedWorking);
          const snapshot = task.requestSnapshot as unknown as EffectSegmentRenderRequestSnapshot;
          if (!snapshot.sourcePrompt) throw new Error('AUDIT_PROMPT_SNAPSHOT_MISSING');
          expect(
            (
              await render.regenerateTasks(
                projectId,
                child.id,
                [task.id],
                child.revision,
                randomUUID(),
                { sourcePrompt: snapshot.sourcePrompt, taskSnapshots: { [task.id]: snapshot } },
              )
            ).kind,
          ).toBe('UPDATED');
          const queued = await tx.effectSegmentRenderTask.findUniqueOrThrow({
            where: { id: task.id },
          });
          expect(queued.promptId).toBe(task.promptId);
          expect(queued.renderVersion).toBe(task.renderVersion + 1);
          expect(queued.outputFileObjectId).toBe(task.outputFileObjectId);
          const attemptToken = randomUUID();
          await tx.effectSegmentRenderTask.update({
            where: { id: task.id },
            data: {
              status: 'RUNNING',
              attemptToken,
              leaseExpiresAt: new Date(Date.now() + 60_000),
            },
          });
          const fileId = randomUUID();
          expect(
            (
              await render.complete(
                projectId,
                task.id,
                attemptToken,
                queued.renderVersion,
                'audit-provider',
                {
                  id: fileId,
                  originalFileName: 'audit-regenerated.mp4',
                  mimeType: 'video/mp4',
                  sizeBytes: 1024,
                  storageKey: `audit/${fileId}.mp4`,
                  sha256: 'a'.repeat(64),
                },
              )
            ).kind,
          ).toBe('COMPLETED');
          // Completion only changes the draft; the original confirmed clip is untouched until save.
          expect(
            (await tx.workingArtifact.findUniqueOrThrow({ where: { id: originalClip.id } }))
              .revision,
          ).toBe(originalClip.revision);
          const completed = await render.batch(projectId, child.id);
          const service = new EffectSegmentRenderService(
            render,
            { get: async () => ({ id: projectId }) } as never,
            { get: () => undefined } as never,
            {} as never,
            scopedWorking,
            {} as never,
          );
          const saved = await service.validate(projectId, child.id, completed!.revision);
          expect(saved.valid, JSON.stringify(saved.issues)).toBe(true);
          const after = await tx.workingArtifact.findMany({
            where: {
              projectId,
              workflowRunId: original.workflowRunId,
              artifactKey: { startsWith: 'render-clip:' },
            },
          });
          expect(after).toHaveLength(before.length);
          const updated = after.find((clip) => clip.id === originalClip.id)!;
          expect(updated.revision).toBe(originalClip.revision + 1);
          expect(updated.payload).toMatchObject({ promptId: task.promptId, fileObjectId: fileId });
          expect(updated.freshness).toBe('CURRENT');
          expect(
            (await tx.fileObject.findUniqueOrThrow({ where: { id: task.outputFileObjectId! } }))
              .status,
          ).toBe('AVAILABLE');
          expect(
            (await tx.workflowRun.findUniqueOrThrow({ where: { id: edit!.runId } }))
              .branchPublishedAt,
          ).toBeNull();
          throw rollback;
        },
        { timeout: 120_000 },
      );
      throw new Error('EXPECTED_ROLLBACK');
    } catch (error) {
      if (error !== rollback) throw error;
    } finally {
      await db.$disconnect();
    }
  },
  130_000,
);
