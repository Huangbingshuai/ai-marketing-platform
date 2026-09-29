import { ConfigService } from '@nestjs/config';
import { expect, it } from 'vitest';
import type { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { WorkflowWorkingRepository } from '../../../platform/workflow/workflow-working.repository';
import { EffectSegmentRenderRepository } from './effect-segment-render.repository';
import { EffectSegmentRenderService } from './effect-segment-render.service';

it.skipIf(process.env.EFFECT_EDIT_DATABASE_TEST !== '1')(
  'saves a render edit into the active branch and keeps both edits off the version tree',
  async () => {
    const db = new PrismaService(new ConfigService({
      DATABASE_URL: process.env.DATABASE_URL ??
        'postgresql://postgres:postgres@localhost:5432/ai_marketing?schema=public',
    }));
    const rollback = new Error('RENDER_BRANCH_TEST_ROLLBACK');
    try {
      try {
        await db.$transaction(async (tx) => {
        const parentBatch = await tx.effectSegmentRenderBatch.findFirstOrThrow({
          where: {
            archivedAt: null,
            committedAt: { not: null },
            workflowRun: {
              workflow: 'EFFECT', workflowSpace: 'EFFECT', activeKey: 'ACTIVE',
            },
          },
          orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        });
        const working = new WorkflowWorkingRepository(db);
        const begun = await working.beginEffectNodeEditInTransaction(
          tx, parentBatch.projectId, parentBatch.workflowRunId, 'SEGMENT_RENDER',
        );
        expect(begun?.created).toBe(true);
        const childRunId = begun!.runId;
        const childProductId = begun!.productIdMap[parentBatch.productId];
        expect(childProductId).toBeDefined();
        const childBatch = await tx.effectSegmentRenderBatch.findFirstOrThrow({
          where: { projectId: parentBatch.projectId, workflowRunId: childRunId,
            productId: childProductId! },
        });
        const [parentTasks, childTasks] = await Promise.all([
          tx.effectSegmentRenderTask.findMany({ where: { projectId: parentBatch.projectId,
            batchId: parentBatch.id } }),
          tx.effectSegmentRenderTask.findMany({ where: { projectId: parentBatch.projectId,
            batchId: childBatch.id } }),
        ]);
        const prompt = await tx.workingArtifact.findFirstOrThrow({ where: {
          projectId: parentBatch.projectId, workflowRunId: childRunId,
          nodeId: 'PROMPT_GENERATION',
          artifactKey: `prompt-batch:${childBatch.productId}`,
        } });
        const source = await tx.workingArtifact.findFirstOrThrow({ where: {
          projectId: parentBatch.projectId, workflowRunId: childRunId,
          nodeId: 'SOURCE_IMPORT',
          artifactKey: `source-package:${childBatch.productId}`,
        } });
        expect(childBatch.sourcePromptArtifactId).toBe(prompt.id);
        expect(childBatch.sourcePromptHash).toBe(prompt.contentHash);
        expect(childTasks).toHaveLength(parentTasks.length);
        for (const task of childTasks) {
          const snapshot = task.requestSnapshot as {
            sourcePrompt?: { artifactId: string; contentHash: string };
            sourcePackage?: { artifactId: string; contentHash: string };
          };
          expect(snapshot.sourcePrompt).toMatchObject({
            artifactId: prompt.id, contentHash: prompt.contentHash,
          });
          expect(snapshot.sourcePackage).toMatchObject({
            artifactId: source.id, contentHash: source.contentHash,
          });
        }

        // Route every read and nested commit through this rollback-only transaction.
        const scopedDb = new Proxy(db, { get(_target, key) {
          if (key === '$transaction') return async <T>(callback: (
            transaction: Prisma.TransactionClient,
          ) => Promise<T>) => callback(tx);
          return Reflect.get(tx, key);
        } }) as PrismaService;
        const scopedWorking = new WorkflowWorkingRepository(scopedDb);
        const render = new EffectSegmentRenderRepository(scopedDb, scopedWorking);
        const service = new EffectSegmentRenderService(
          render,
          { get: async () => ({ id: parentBatch.projectId }) } as never,
          { get: () => undefined } as never,
          {} as never,
          scopedWorking,
          {} as never,
        );
        const copiedBatchArtifact = await tx.workingArtifact.findFirstOrThrow({ where: {
          projectId: parentBatch.projectId, workflowRunId: childRunId,
          artifactKey: `render-batch:${childBatch.productId}`,
        } });
        const renderedBatch = await render.batch(parentBatch.projectId, childBatch.id);
        const proposed = (service as unknown as {
          artifactInputs(record: NonNullable<typeof renderedBatch>): Array<{
            artifactKey: string; input: { payload: unknown; metadata: unknown };
          }>;
        }).artifactInputs(renderedBatch!);
        const proposedBatch = proposed.find((artifact) =>
          artifact.artifactKey === copiedBatchArtifact.artifactKey);
        expect(proposedBatch?.input.payload).toEqual(copiedBatchArtifact.payload);
        expect(proposedBatch?.input.metadata).toEqual(copiedBatchArtifact.metadata);
        const validated = await service.validate(
          parentBatch.projectId, childBatch.id, childBatch.revision,
        );
        expect(validated.valid, JSON.stringify(validated.issues)).toBe(true);
        expect(validated.artifacts.every((artifact) => artifact.unchanged),
          JSON.stringify(validated.artifacts.filter((artifact) => !artifact.unchanged))).toBe(true);
        const [childAfter, activeAfter] = await Promise.all([
          tx.workflowRun.findFirstOrThrow({ where: { id: childRunId } }),
          tx.workflowRun.findFirstOrThrow({ where: {
            projectId: parentBatch.projectId, workflow: 'EFFECT', workflowSpace: 'EFFECT',
            activeKey: 'ACTIVE',
          } }),
        ]);
        expect(childAfter.editSessionNodeId).toBeNull();
        expect(childAfter.branchPublishedAt).toBeNull();
        expect(activeAfter.id).toBe(parentBatch.workflowRunId);

        const changedEdit = await working.beginEffectNodeEditInTransaction(
          tx, parentBatch.projectId, parentBatch.workflowRunId, 'SEGMENT_RENDER',
        );
        expect(changedEdit?.created).toBe(true);
        const changedRunId = changedEdit!.runId;
        const changedBatch = await tx.effectSegmentRenderBatch.findFirstOrThrow({ where: {
          projectId: parentBatch.projectId, workflowRunId: changedRunId,
          productId: changedEdit!.productIdMap[parentBatch.productId]!,
        } });
        const changedTask = await tx.effectSegmentRenderTask.findFirstOrThrow({ where: {
          projectId: parentBatch.projectId, batchId: changedBatch.id,
        } });
        // A re-render replaces the clip's output bytes, so change that content identity here.
        const changedHash = (changedTask.outputContentHash ?? '0'.repeat(64))
          .replace(/^./, (char) => (char === '0' ? '1' : '0'));
        await tx.effectSegmentRenderTask.update({
          where: { id: changedTask.id },
          data: {
            activeOutputVersion: (changedTask.activeOutputVersion ?? changedTask.renderVersion) + 1,
            outputContentHash: changedHash,
          },
        });
        const parentClipsBefore = await tx.workingArtifact.findMany({ where: {
          projectId: parentBatch.projectId, workflowRunId: parentBatch.workflowRunId,
          artifactKey: { startsWith: 'render-clip:' },
        }, select: { id: true, revision: true } });
        const changedValidated = await service.validate(
          parentBatch.projectId, changedBatch.id, changedBatch.revision,
        );
        expect(changedValidated.valid, JSON.stringify(changedValidated.issues)).toBe(true);
        expect(changedValidated.artifacts.some((artifact) => !artifact.unchanged)).toBe(true);
        const [publishedChild, activeChanged] = await Promise.all([
          tx.workflowRun.findFirstOrThrow({ where: { id: changedRunId } }),
          tx.workflowRun.findFirstOrThrow({ where: {
            projectId: parentBatch.projectId, workflow: 'EFFECT', workflowSpace: 'EFFECT',
            activeKey: 'ACTIVE',
          } }),
        ]);
        // "保存修改" applies the change to the active branch in place: the edit child is
        // discarded without publishing, and the changed clip revision lands on the parent.
        expect(publishedChild.branchPublishedAt).toBeNull();
        expect(publishedChild.editSessionNodeId).toBeNull();
        expect(activeChanged.id).toBe(parentBatch.workflowRunId);
        const parentClipsAfter = await tx.workingArtifact.findMany({ where: {
          projectId: parentBatch.projectId, workflowRunId: parentBatch.workflowRunId,
          artifactKey: { startsWith: 'render-clip:' },
        }, select: { id: true, revision: true } });
        const advanced = parentClipsAfter.filter((clip) => {
          const before = parentClipsBefore.find((entry) => entry.id === clip.id);
          return before !== undefined && clip.revision > before.revision;
        });
        expect(advanced.length).toBeGreaterThan(0);
        expect(parentClipsAfter).toHaveLength(parentClipsBefore.length);
          throw rollback;
        }, { timeout: 120_000 });
        throw new Error('EXPECTED_TEST_ROLLBACK');
      } catch (error) {
        if (error !== rollback) throw error;
      }
    } finally {
      await db.$disconnect();
    }
  },
  130_000,
);
