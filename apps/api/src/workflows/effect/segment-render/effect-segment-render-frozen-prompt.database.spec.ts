import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { expect, it } from 'vitest';
import type { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { WorkflowWorkingRepository } from '../../../platform/workflow/workflow-working.repository';
import { EffectSegmentRenderRepository } from './effect-segment-render.repository';

it.skipIf(process.env.EFFECT_EDIT_DATABASE_TEST !== '1')(
  'saves a frozen deletion after another Prompt save, preserving consumed history and the latest upstream head',
  async () => {
    const db = new PrismaService(
      new ConfigService({
        DATABASE_URL:
          process.env.DATABASE_URL ??
          'postgresql://postgres:postgres@localhost:5432/ai_marketing?schema=public',
      }),
    );
    const rollback = new Error('FROZEN_PROMPT_ROLLBACK');
    try {
      await expect(
        db.$transaction(
          async (tx) => {
            const projectId = randomUUID();
            await tx.project.create({ data: { id: projectId, name: '冻结提示词回滚测试' } });
            const root = await tx.workflowRun.create({
              data: { projectId, workflow: 'EFFECT', workflowSpace: 'EFFECT', activeKey: 'ACTIVE' },
            });
            const workspace = await tx.effectImportWorkspace.create({
              data: { projectId, workflowRunId: root.id },
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
              data: { projectId, workflowRunId: root.id, draftId: draft.id, configOverride: {} },
            });
            const input = {
              kind: 'STRUCTURED' as const,
              name: '来源',
              directory: 'VIDEO_MATERIALS' as const,
              type: 'VIDEO_MATERIAL' as const,
              payload: { items: [], version: 'old' },
            };
            const base = {
              ...input,
              projectId,
              workflowRunId: root.id,
              contentHash: 'a'.repeat(64),
            };
            const prompt = await tx.workingArtifact.create({
              data: {
                ...base,
                nodeId: 'PROMPT_GENERATION',
                artifactKey: `prompt-batch:${product.id}`,
              },
            });
            const source = await tx.workingArtifact.create({
              data: {
                ...base,
                nodeId: 'SOURCE_IMPORT',
                artifactKey: `source-package:${product.id}`,
              },
            });
            const batch = await tx.effectSegmentRenderBatch.create({
              data: {
                projectId,
                workflowRunId: root.id,
                productId: product.id,
                sourcePromptArtifactId: prompt.id,
                sourcePromptRevision: prompt.revision,
                sourcePromptHash: prompt.contentHash,
                sourceFingerprint: 'f',
                requestHash: 'h',
                idempotencyKey: randomUUID(),
                status: 'COMPLETED',
                activeKey: null,
                committedAt: new Date(),
              },
            });
            const snapshot = {
              sourcePrompt: { artifactId: prompt.id, revision: 1, contentHash: prompt.contentHash },
              sourcePackage: {
                artifactId: source.id,
                revision: 1,
                contentHash: source.contentHash,
              },
              promptId: randomUUID(),
              request: { duration: 5 },
            };
            const task = await tx.effectSegmentRenderTask.create({
              data: {
                projectId,
                workflowRunId: root.id,
                productId: product.id,
                batchId: batch.id,
                promptId: snapshot.promptId,
                promptCode: 'P001',
                renderCode: 'R-001',
                sourceFingerprint: 'f',
                requestSnapshot: snapshot,
                generationRequestSnapshot: snapshot,
                status: 'COMPLETED',
              },
            });
            await tx.workingArtifact.create({
              data: {
                ...base,
                nodeId: 'SEGMENT_RENDER',
                artifactKey: `render-batch:${product.id}`,
                payload: { clips: [{ taskId: task.id }] },
              },
            });
            const scoped = new Proxy(tx, {
              get(target, key) {
                return key === '$transaction'
                  ? (fn: (client: Prisma.TransactionClient) => unknown) => fn(tx)
                  : Reflect.get(target, key);
              },
            }) as unknown as PrismaService;
            const working = new WorkflowWorkingRepository(scoped);
            const edit = (await working.beginEffectNodeEditInTransaction(
              tx,
              projectId,
              root.id,
              'SEGMENT_RENDER',
            ))!;
            const childProduct = edit.productIdMap[product.id]!;
            const childBatch = await tx.effectSegmentRenderBatch.findFirstOrThrow({
              where: { workflowRunId: edit.runId },
            });
            const childPrompt = await tx.workingArtifact.findFirstOrThrow({
              where: { workflowRunId: edit.runId, nodeId: 'PROMPT_GENERATION' },
            });
            const childSource = await tx.workingArtifact.findFirstOrThrow({
              where: { workflowRunId: edit.runId, nodeId: 'SOURCE_IMPORT' },
            });
            const childTask = await tx.effectSegmentRenderTask.findUniqueOrThrow({
              where: { id: edit.taskIdMap[task.id]! },
            });
            const frozen = {
              ...(childTask.requestSnapshot as Prisma.JsonObject),
              removedBy: 'PROMPT',
              refreshContext: {
                schemaVersion: 1,
                confirmationSignature: 'frozen',
                sourcePrompt: {
                  artifactId: childPrompt.id,
                  revision: childPrompt.revision,
                  contentHash: childPrompt.contentHash,
                },
              },
            };
            await tx.effectSegmentRenderTask.update({
              where: { id: childTask.id },
              data: {
                status: 'FAILED',
                errorCode: 'MATERIAL_DELETED',
                requestSnapshot: frozen,
                generationRequestSnapshot: frozen,
              },
            });
            for (const [runId, artifactKey] of [
              [root.id, prompt.artifactKey],
              [edit.runId, childPrompt.artifactKey],
            ]) {
              await working.commitValidatedArtifactsInTransaction(
                tx,
                projectId,
                runId!,
                'PROMPT_GENERATION',
                [
                  {
                    artifactKey: artifactKey!,
                    input: { ...input, payload: { items: [], version: 'latest' } },
                    invalidateDependents: false,
                  },
                ],
              );
            }
            const render = new EffectSegmentRenderRepository(scoped, working);
            const result = await render.commitValidatedBatch(
              projectId,
              childBatch.id,
              childBatch.revision,
              {
                artifactId: childPrompt.id,
                revision: childPrompt.revision,
                contentHash: childPrompt.contentHash,
              },
              {
                artifactId: childSource.id,
                revision: childSource.revision,
                contentHash: childSource.contentHash,
              },
              [
                {
                  artifactKey: `render-batch:${childProduct}`,
                  input: {
                    ...input,
                    payload: {
                      clips: [],
                      removedSources: [
                        { taskId: childTask.id, promptId: task.promptId, removedBy: 'PROMPT' },
                      ],
                    },
                    dependencies: [
                      {
                        sourceType: 'WORKING_ARTIFACT',
                        sourceNodeId: 'PROMPT_GENERATION',
                        sourceArtifactId: childPrompt.id,
                        sourceKey: childPrompt.artifactKey,
                        sourceRevision: childPrompt.revision,
                        sourceHash: childPrompt.contentHash,
                      },
                    ],
                  },
                },
              ],
            );
            expect(result.kind).toBe('COMMITTED');
            expect(
              (await tx.workingArtifact.findUniqueOrThrow({ where: { id: prompt.id } })).revision,
            ).toBe(2);
            const savedBatch = await tx.effectSegmentRenderBatch.findUniqueOrThrow({
              where: { id: batch.id },
            });
            expect(savedBatch.sourcePromptRevision).toBe(1);
            expect(savedBatch.sourcePromptHash).toBe(prompt.contentHash);
            const pool = await tx.workingArtifact.findFirstOrThrow({
              where: { workflowRunId: root.id, nodeId: 'SEGMENT_RENDER' },
              include: { dependencies: true },
            });
            expect(pool.dependencies[0]?.sourceRevision).toBe(1);
            expect(
              (pool.payload as { removedSources: { taskId: string }[] }).removedSources[0]?.taskId,
            ).toBe(task.id);
            expect(
              (await tx.workflowRun.findUniqueOrThrow({ where: { id: edit.runId } }))
                .branchPublishedAt,
            ).toBeNull();
            expect(await tx.jobOutbox.count({ where: { projectId } })).toBe(0);
            // A late callback/read must not re-merge the closed edit or roll back
            // a second upstream change, even when its expected batch revision matches.
            await working.commitValidatedArtifactsInTransaction(
              tx,
              projectId,
              root.id,
              'PROMPT_GENERATION',
              [
                {
                  artifactKey: prompt.artifactKey,
                  input: { ...input, payload: { items: [], version: 'third' } },
                  invalidateDependents: false,
                },
              ],
            );
            const revisionBeforeReplay = savedBatch.revision;
            const poolBeforeReplay = await tx.workingArtifact.findUniqueOrThrow({
              where: { id: pool.id },
            });
            const duplicate = await render.commitValidatedBatch(
              projectId,
              childBatch.id,
              childBatch.revision,
              {
                artifactId: childPrompt.id,
                revision: childPrompt.revision,
                contentHash: childPrompt.contentHash,
              },
              {
                artifactId: childSource.id,
                revision: childSource.revision,
                contentHash: childSource.contentHash,
              },
              [{ artifactKey: `render-batch:${childProduct}`, input }],
            );
            expect(duplicate).toMatchObject({ kind: 'COMMITTED', publication: null });
            expect(
              (await tx.effectSegmentRenderBatch.findUniqueOrThrow({ where: { id: batch.id } }))
                .revision,
            ).toBe(revisionBeforeReplay);
            expect(await tx.workingArtifact.findUniqueOrThrow({ where: { id: pool.id } })).toEqual(
              poolBeforeReplay,
            );
            expect(
              (await tx.workingArtifact.findUniqueOrThrow({ where: { id: prompt.id } })).revision,
            ).toBe(3);
            throw rollback;
          },
          { timeout: 120000 },
        ),
      ).rejects.toBe(rollback);
    } finally {
      await db.$disconnect();
    }
  },
  120000,
);
