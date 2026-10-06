import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { expect, it } from 'vitest';
import type {
  EffectSegmentRenderRequestSnapshot,
  EffectSegmentImportConfirmItem,
} from '@ai-marketing/contracts';
import type { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { WorkflowWorkingRepository } from '../../../platform/workflow/workflow-working.repository';
import { EffectSegmentRenderRepository } from './effect-segment-render.repository';
import { EffectSegmentImportRepository } from './effect-segment-import.repository';
import { EFFECT_SEGMENT_IMPORT_FAILURE_MESSAGES } from '@ai-marketing/contracts';

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
            const uploadInput = (sha256: string, uploadKey: string, target = batch) => ({
              projectId,
              workflowRunId: target.workflowRunId,
              batchId: target.id,
              uploadKey,
              fileName: '改名视频.mp4',
              mimeType: 'video/mp4',
              sizeBytes: 100,
              storageKey: `fixture/${uploadKey}.mp4`,
              sha256,
              durationSeconds: 6,
              width: 720,
              height: 1280,
              expiresAt: new Date(Date.now() + 60_000),
            });
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
              frameRate: 30000 / 1001,
              expiresAt: new Date(Date.now() + 60_000),
            });
            await expect(
              drafts.stage(uploadInput('b'.repeat(64), 'renamed-pending')),
            ).rejects.toThrow('待确认');
            expect((await drafts.stage(uploadInput('b'.repeat(64), 'upload'))).replayed).toBe(true);
            const sameNameDifferentContent = await drafts.stage(
              uploadInput('c'.repeat(64), 'different-content'),
            );
            await drafts.cancel(projectId, sameNameDifferentContent.draft.id);
            const afterCancel = await drafts.stage(uploadInput('c'.repeat(64), 'after-cancel'));
            await tx.effectSegmentImportDraft.update({
              where: { id: afterCancel.draft.id },
              data: { expiresAt: new Date(0) },
            });
            const afterExpiry = await drafts.stage(uploadInput('c'.repeat(64), 'after-expiry'));
            await drafts.cancel(projectId, afterExpiry.draft.id);
            expect(await tx.fileObject.count({ where: { projectId } })).toBe(0);
            expect(await tx.effectSegmentRenderTask.count({ where: { projectId } })).toBe(1);
            expect((await drafts.find(projectId, staged.draft.id))?.frameRate).toBeCloseTo(
              29.97003,
              5,
            );
            await drafts.describe(projectId, staged.draft.id, 'describe');
            await drafts.describe(projectId, staged.draft.id, 'describe');
            expect(await tx.jobOutbox.count({ where: { projectId } })).toBe(1);
            const claimed = await drafts.claim(projectId, staged.draft.id, 'describe');
            expect(claimed?.attemptToken).toBeTruthy();
            expect(await drafts.claim(projectId, staged.draft.id, 'describe')).toBeNull();
            const items: EffectSegmentImportConfirmItem[] = [
              {
                draftId: staged.draft.id,
                promptText: '用户确认的素材描述',
                creativeCore: '用户修改后的创意',
                dimensions: { narrative: '展示', scene: '餐桌' },
                primaryPurpose: 'EFFECT',
                compatiblePurposes: ['EFFECT', 'PRODUCT_DISPLAY'],
              },
            ];
            expect(
              await renders.appendImportedMaterials(projectId, batch.id, items, 1, 'confirm'),
            ).toBe('DRAFT_CONFLICT');
            expect(
              (await drafts.finish(projectId, staged.draft.id, randomUUID(), '错误回调')).count,
            ).toBe(0);
            expect(
              (
                await drafts.finish(
                  projectId,
                  staged.draft.id,
                  claimed!.attemptToken!,
                  'AI 描述',
                  'HOOK',
                  ['HOOK'],
                  { creativeCore: 'AI 创意', dimensions: { scene: '餐桌', narrative: '展示' } },
                )
              ).count,
            ).toBe(1);
            expect(
              (
                await drafts.finish(
                  projectId,
                  staged.draft.id,
                  claimed!.attemptToken!,
                  'AI 描述',
                  'HOOK',
                  ['HOOK'],
                  { creativeCore: 'AI 创意', dimensions: { narrative: '展示', scene: '餐桌' } },
                )
              ).count,
            ).toBe(1);
            expect(
              (await drafts.finish(projectId, staged.draft.id, claimed!.attemptToken!, '不同内容'))
                .count,
            ).toBe(0);
            expect(
              (
                await drafts.finish(
                  projectId,
                  staged.draft.id,
                  claimed!.attemptToken!,
                  'AI 描述',
                  'CTA',
                  ['CTA'],
                )
              ).count,
            ).toBe(0);
            expect(await drafts.find(projectId, staged.draft.id)).toMatchObject({
              promptText: 'AI 描述',
              primaryPurpose: 'HOOK',
              compatiblePurposes: ['HOOK'],
              creativeCore: 'AI 创意',
              dimensions: { narrative: '展示', scene: '餐桌' },
            });
            await drafts.describe(projectId, staged.draft.id, 'failed-describe');
            const failedClaim = await drafts.claim(projectId, staged.draft.id, 'failed-describe');
            expect(
              (
                await drafts.finish(
                  projectId,
                  staged.draft.id,
                  failedClaim!.attemptToken!,
                  null,
                  undefined,
                  undefined,
                  {},
                  EFFECT_SEGMENT_IMPORT_FAILURE_MESSAGES.AI_TIMEOUT,
                )
              ).count,
            ).toBe(1);
            expect(await drafts.find(projectId, staged.draft.id)).toMatchObject({
              descriptionStatus: 'FAILED',
              errorMessage: EFFECT_SEGMENT_IMPORT_FAILURE_MESSAGES.AI_TIMEOUT,
              promptText: 'AI 描述',
              primaryPurpose: 'HOOK',
              compatiblePurposes: ['HOOK'],
              creativeCore: 'AI 创意',
              dimensions: { narrative: '展示', scene: '餐桌' },
            });
            await drafts.describe(projectId, staged.draft.id, 'describe');
            expect(
              (
                await drafts.finish(
                  projectId,
                  staged.draft.id,
                  failedClaim!.attemptToken!,
                  null,
                  undefined,
                  undefined,
                  {},
                  EFFECT_SEGMENT_IMPORT_FAILURE_MESSAGES.AI_TIMEOUT,
                )
              ).count,
            ).toBe(1);
            expect(await tx.jobOutbox.count({ where: { projectId } })).toBe(2);
            expect((await drafts.find(projectId, staged.draft.id))?.descriptionStatus).toBe(
              'FAILED',
            );
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
            expect(imported.creativeCore).toBe('用户修改后的创意');
            expect(imported.dimensions).toEqual({ narrative: '展示', scene: '餐桌' });
            expect(imported.primaryPurpose).toBe('EFFECT');
            expect(imported.compatiblePurposes).toEqual(['EFFECT', 'PRODUCT_DISPLAY']);
            expect(await drafts.find(projectId, staged.draft.id)).toMatchObject({
              primaryPurpose: 'EFFECT',
              compatiblePurposes: ['EFFECT', 'PRODUCT_DISPLAY'],
            });
            expect(added.promptId).toBe(staged.draft.id);
            expect(await tx.fileObject.count({ where: { projectId } })).toBe(1);
            expect(
              (await tx.effectSegmentRenderBatch.findUniqueOrThrow({ where: { id: batch.id } }))
                .revision,
            ).toBe(2);
            // Confirmed imports remain protected across new upload keys and renamed files.
            await expect(
              drafts.checkUpload(projectId, batch.id, 'renamed-confirmed', 'b'.repeat(64)),
            ).rejects.toThrow('R-002');
            // The original identity remains after repair, even though the active file hash changed.
            await tx.effectSegmentRenderTask.update({
              where: { id: added.id },
              data: { outputContentHash: 'd'.repeat(64) },
            });
            await expect(
              drafts.stage(uploadInput('b'.repeat(64), 'original-after-repair')),
            ).rejects.toThrow('人工素材');
            await expect(
              drafts.stage(uploadInput('d'.repeat(64), 'repaired-file')),
            ).rejects.toThrow('人工素材');
            // A new editing branch inherits the same promptId without copying import drafts.
            const childRun = await tx.workflowRun.create({
              data: {
                projectId,
                workflow: 'EFFECT',
                workflowSpace: 'EFFECT',
                parentWorkflowRunId: run.id,
                activeKey: null,
              },
            });
            const childProduct = await tx.effectImportProduct.create({
              data: {
                projectId,
                workflowRunId: childRun.id,
                draftId: importDraft.id,
                configOverride: {},
              },
            });
            const copiedBatch = await tx.effectSegmentRenderBatch.create({
              data: {
                ...batch,
                id: randomUUID(),
                workflowRunId: childRun.id,
                productId: childProduct.id,
                idempotencyKey: 'copy',
              },
            });
            await tx.effectSegmentRenderTask.create({
              data: {
                id: randomUUID(),
                projectId,
                workflowRunId: childRun.id,
                batchId: copiedBatch.id,
                productId: childProduct.id,
                promptId: added.promptId,
                promptCode: added.promptCode,
                renderCode: added.renderCode,
                sourceFingerprint: added.sourceFingerprint,
                requestSnapshot: added.requestSnapshot as Prisma.InputJsonValue,
                generationRequestSnapshot: added.generationRequestSnapshot as Prisma.InputJsonValue,
                status: 'COMPLETED',
                outputContentHash: 'd'.repeat(64),
              },
            });
            await expect(
              drafts.stage(uploadInput('b'.repeat(64), 'copied-original', copiedBatch)),
            ).rejects.toThrow('人工素材');
            // An independent empty batch may use that file; history is not a global ban.
            const independentBatch = await tx.effectSegmentRenderBatch.create({
              data: {
                ...batch,
                id: randomUUID(),
                workflowRunId: childRun.id,
                productId: childProduct.id,
                idempotencyKey: 'independent',
              },
            });
            const independent = await drafts.stage(
              uploadInput('b'.repeat(64), 'independent-upload', independentBatch),
            );
            await drafts.cancel(projectId, independent.draft.id);
            // Old/pre-feature duplicate drafts cannot bypass confirmation, and write nothing.
            const legacyDuplicate = await tx.effectSegmentImportDraft.create({
              data: uploadInput('b'.repeat(64), 'legacy-duplicate'),
            });
            expect(
              await renders.appendImportedMaterials(
                projectId,
                batch.id,
                [{ ...items[0]!, draftId: legacyDuplicate.id }],
                2,
                'duplicate-confirm',
              ),
            ).toBe('DUPLICATE_CONTENT');
            expect(await tx.fileObject.count({ where: { projectId } })).toBe(1);
            expect(
              await tx.effectSegmentRenderTask.count({ where: { projectId, batchId: batch.id } }),
            ).toBe(2);
            expect(
              (await tx.effectSegmentRenderBatch.findUniqueOrThrow({ where: { id: batch.id } }))
                .revision,
            ).toBe(2);
            expect(
              await tx.effectSegmentRenderOperationReceipt.count({
                where: { projectId, idempotencyKey: 'duplicate-confirm' },
              }),
            ).toBe(0);
            await drafts.cancel(projectId, legacyDuplicate.id);
            const duplicates = await Promise.all(
              ['legacy-a', 'legacy-b'].map((key) =>
                tx.effectSegmentImportDraft.create({ data: uploadInput('e'.repeat(64), key) }),
              ),
            );
            expect(
              await renders.appendImportedMaterials(
                projectId,
                batch.id,
                duplicates.map((draft) => ({ ...items[0]!, draftId: draft.id })),
                2,
                'duplicate-pair',
              ),
            ).toBe('DUPLICATE_CONTENT');
            for (const draft of duplicates) await drafts.cancel(projectId, draft.id);
            await drafts.cancel(projectId, staged.draft.id);
            expect((await drafts.find(projectId, staged.draft.id))?.status).toBe('IMPORTED');
            expect(
              (await renders.deleteMaterials(projectId, batch.id, [added.id], 2, 'delete-import'))
                .kind,
            ).toBe('UPDATED');
            expect(
              await tx.effectSegmentRenderTask.count({ where: { projectId, batchId: batch.id } }),
            ).toBe(1);
            const reimportAfterDeletion = await drafts.stage(
              uploadInput('b'.repeat(64), 'after-delete'),
            );
            await drafts.cancel(projectId, reimportAfterDeletion.draft.id);
            expect(await tx.effectSegmentRenderTask.findUnique({ where: { id: old.id } })).toEqual(
              old,
            );
            expect(
              (await tx.effectSegmentRenderBatch.findUniqueOrThrow({ where: { id: batch.id } }))
                .status,
            ).toBe('COMPLETED');
            expect(await tx.fileObject.count({ where: { projectId } })).toBe(1);
            // Five independent UI columns confirm against each new batch revision.
            const columns = await Promise.all(
              Array.from({ length: 5 }, (_, index) =>
                drafts.stage({
                  projectId,
                  workflowRunId: run.id,
                  batchId: batch.id,
                  uploadKey: `batch-column-${index}`,
                  fileName: `column-${index}.mp4`,
                  mimeType: 'video/mp4',
                  sizeBytes: 100,
                  storageKey: `fixture/column-${index}.mp4`,
                  sha256: String(index + 1).repeat(64),
                  durationSeconds: 6,
                  width: 720,
                  height: 1280,
                  frameRate: 30,
                  expiresAt: new Date(Date.now() + 60_000),
                }),
              ),
            );
            for (const [index, column] of columns.entries()) {
              const revision = (
                await tx.effectSegmentRenderBatch.findUniqueOrThrow({ where: { id: batch.id } })
              ).revision;
              const columnItems: EffectSegmentImportConfirmItem[] = [
                {
                  draftId: column.draft.id,
                  promptText: `独立描述 ${index}`,
                  primaryPurpose: 'HOOK',
                  compatiblePurposes: ['HOOK'],
                },
              ];
              expect(
                await renders.appendImportedMaterials(
                  projectId,
                  batch.id,
                  columnItems,
                  revision,
                  `column-confirm-${index}`,
                ),
              ).toBe('UPDATED');
              expect((await drafts.find(projectId, column.draft.id))?.status).toBe('IMPORTED');
              for (const pending of columns.slice(index + 1))
                expect((await drafts.find(projectId, pending.draft.id))?.status).toBe('READY');
              expect(
                (await tx.effectSegmentRenderBatch.findUniqueOrThrow({ where: { id: batch.id } }))
                  .revision,
              ).toBe(revision + 1);
            }
            expect(
              await tx.effectSegmentRenderTask.count({ where: { projectId, batchId: batch.id } }),
            ).toBe(6);
            expect(await tx.effectSegmentRenderTask.findUnique({ where: { id: old.id } })).toEqual(
              old,
            );
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
