import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { expect, it } from 'vitest';
import type { EffectSegmentRenderRequestSnapshot } from '@ai-marketing/contracts';
import type { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { WorkflowWorkingRepository } from '../../../platform/workflow/workflow-working.repository';
import { EffectSegmentRenderRepository } from './effect-segment-render.repository';
import { EffectSegmentImportRepository } from './effect-segment-import.repository';

// Isolated fixtures and a mandatory outer rollback: no storage or paid model calls,
// and even the description Outbox cannot escape to the running dispatcher.
it.skipIf(process.env.EFFECT_INCREMENTAL_DATABASE_TEST !== '1')(
  'confirms independent imports atomically, preserves Prompt duration and deduplicates AI callbacks',
  async () => {
    const db = new PrismaService(
      new ConfigService({
        DATABASE_URL:
          process.env.DATABASE_URL ??
          'postgresql://postgres:postgres@localhost:5432/ai_marketing?schema=public',
      }),
    );
    const projectId = randomUUID();
    const rollback = new Error('IMPORT_TEST_ROLLBACK');
    try {
      await expect(
        db.$transaction(
          async (tx) => {
            await tx.project.create({ data: { id: projectId, name: '回滚专用视频导入测试' } });
            const run = await tx.workflowRun.create({
              data: { projectId, workflow: 'EFFECT', workflowSpace: 'EFFECT' },
            });
            const workspace = await tx.effectImportWorkspace.create({
              data: { projectId, workflowRunId: run.id },
            });
            const importDraft = await tx.effectImportDraft.create({
              data: {
                projectId,
                workspaceId: workspace.id,
                mode: 'SINGLE',
                globalConfig: {},
                validationIssues: [],
              },
            });
            const product = await tx.effectImportProduct.create({
              data: {
                projectId,
                workflowRunId: run.id,
                draftId: importDraft.id,
                configOverride: {},
              },
            });
            const common = {
              projectId,
              workflowRunId: run.id,
              kind: 'STRUCTURED' as const,
              name: '测试来源',
              directory: 'VIDEO_MATERIALS' as const,
              type: 'VIDEO_MATERIAL' as const,
              contentHash: 'a'.repeat(64),
            };
            const prompt = await tx.workingArtifact.create({
              data: {
                ...common,
                nodeId: 'PROMPT_GENERATION',
                artifactKey: `prompt-batch:${product.id}`,
                revision: 2,
              },
            });
            const source = await tx.workingArtifact.create({
              data: {
                ...common,
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
            const snapshot = {
              schemaVersion: 1,
              promptId: randomUUID(),
              promptCode: 'P001',
              promptText: '原素材',
              sourcePackage: {
                artifactId: source.id,
                revision: source.revision,
                contentHash: source.contentHash,
              },
              sourcePrompt: {
                artifactId: prompt.id,
                revision: prompt.revision,
                contentHash: prompt.contentHash,
              },
              request: { duration: 10, content: [] },
            } as unknown as EffectSegmentRenderRequestSnapshot;
            const old = await tx.effectSegmentRenderTask.create({
              data: {
                projectId,
                workflowRunId: run.id,
                productId: product.id,
                batchId: batch.id,
                promptId: snapshot.promptId,
                promptCode: 'P001',
                renderCode: 'R-001',
                sourceFingerprint: 'a'.repeat(64),
                requestSnapshot: snapshot as unknown as Prisma.InputJsonValue,
                generationRequestSnapshot: snapshot as unknown as Prisma.InputJsonValue,
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
            const drafts = new EffectSegmentImportRepository(scopedDb);
            const renders = new EffectSegmentRenderRepository(
              scopedDb,
              new WorkflowWorkingRepository(scopedDb),
            );
            const staged = await drafts.stage({
              projectId,
              workflowRunId: run.id,
              batchId: batch.id,
              uploadKey: 'upload',
              fileName: '视频.mp4',
              mimeType: 'video/mp4',
              sizeBytes: 100,
              storageKey: 'fixture/import.mp4',
              sha256: 'b'.repeat(64),
              durationSeconds: 30,
              width: 1280,
              height: 720,
              expiresAt: new Date(Date.now() + 60_000),
            });
            expect(await tx.fileObject.count({ where: { projectId } })).toBe(0);
            expect(await tx.effectSegmentRenderTask.count({ where: { projectId } })).toBe(1);
            await drafts.describe(projectId, staged.draft.id, 'describe');
            await drafts.describe(projectId, staged.draft.id, 'describe');
            expect(await tx.jobOutbox.count({ where: { projectId } })).toBe(1);
            const claimed = await drafts.claim(projectId, staged.draft.id, 'describe');
            expect(claimed?.attemptToken).toBeTruthy();
            expect(await drafts.claim(projectId, staged.draft.id, 'describe')).toBeNull();
            const items = [{ draftId: staged.draft.id, promptText: '用户确认的素材描述' }];
            expect(
              await renders.appendImportedMaterials(projectId, batch.id, items, 1, 'confirm'),
            ).toBe('DRAFT_CONFLICT');
            expect(
              (await drafts.finish(projectId, staged.draft.id, randomUUID(), '错误回调')).count,
            ).toBe(0);
            expect(
              (await drafts.finish(projectId, staged.draft.id, claimed!.attemptToken!, 'AI 描述'))
                .count,
            ).toBe(1);
            expect(
              (await drafts.finish(projectId, staged.draft.id, claimed!.attemptToken!, 'AI 描述'))
                .count,
            ).toBe(1);
            expect(
              (await drafts.finish(projectId, staged.draft.id, claimed!.attemptToken!, '不同内容'))
                .count,
            ).toBe(0);
            expect(
              await renders.appendImportedMaterials(projectId, batch.id, items, 1, 'confirm'),
            ).toBe('UPDATED');
            expect(
              await renders.appendImportedMaterials(projectId, batch.id, items, 1, 'confirm'),
            ).toBe('REPLAYED');
            expect(
              await renders.appendImportedMaterials(
                projectId,
                batch.id,
                [{ ...items[0]!, promptText: '不同确认内容' }],
                1,
                'confirm',
              ),
            ).toBe('KEY_CONFLICT');
            expect(await tx.effectSegmentRenderTask.findUnique({ where: { id: old.id } })).toEqual(
              old,
            );
            expect(await tx.workingArtifact.findUnique({ where: { id: prompt.id } })).toEqual(
              prompt,
            );
            const added = await tx.effectSegmentRenderTask.findFirstOrThrow({
              where: { projectId, id: { not: old.id } },
            });
            const imported =
              added.generationRequestSnapshot as unknown as EffectSegmentRenderRequestSnapshot;
            expect(imported.request.duration).toBe(30);
            expect(imported.importedMaterial?.promptDurationMaxSeconds).toBe(10);
            expect(imported.promptText).toBe(items[0]!.promptText);
            expect(added.promptId).toBe(staged.draft.id);
            expect(await tx.fileObject.count({ where: { projectId } })).toBe(1);
            expect(
              (await tx.effectSegmentRenderBatch.findUniqueOrThrow({ where: { id: batch.id } }))
                .revision,
            ).toBe(2);
            await drafts.cancel(projectId, staged.draft.id);
            expect((await drafts.find(projectId, staged.draft.id))?.status).toBe('IMPORTED');
            expect(
              (await renders.deleteMaterials(projectId, batch.id, [added.id], 2, 'delete-import'))
                .kind,
            ).toBe('UPDATED');
            expect(await tx.effectSegmentRenderTask.count({ where: { projectId } })).toBe(1);
            expect(await tx.effectSegmentRenderTask.findUnique({ where: { id: old.id } })).toEqual(
              old,
            );
            expect(
              (await tx.effectSegmentRenderBatch.findUniqueOrThrow({ where: { id: batch.id } }))
                .status,
            ).toBe('COMPLETED');
            expect(await tx.fileObject.count({ where: { projectId } })).toBe(1);
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
