import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { expect, it } from 'vitest';
import type { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { WorkflowWorkingRepository } from '../../../platform/workflow/workflow-working.repository';
import { EffectSegmentRenderRepository } from './effect-segment-render.repository';

// All fixture writes roll back. No existing project, files, paid tasks or Outbox is touched.
it.skipIf(process.env.EFFECT_SOURCE_POOL_DATABASE_TEST !== '1').each([22, 19, 0])(
  'reads and edits the confirmed %s-material pool rather than an old 20-material mix snapshot',
  async (count) => {
    const db = new PrismaService(new ConfigService({ DATABASE_URL: process.env.DATABASE_URL ??
      'postgresql://postgres:postgres@localhost:5432/ai_marketing?schema=public' }));
    const rollback = new Error('SOURCE_POOL_ROLLBACK');
    try {
      await expect(db.$transaction(async (tx) => {
        const projectId = randomUUID();
        await tx.project.create({ data: { id: projectId, name: '素材池来源回滚测试' } });
        const root = await tx.workflowRun.create({ data: { projectId, workflow: 'EFFECT', workflowSpace: 'EFFECT', activeKey: null } });
        const owner = await tx.workflowRun.create({ data: { projectId, workflow: 'EFFECT', workflowSpace: 'EFFECT',
          parentWorkflowRunId: root.id, forkNodeId: 'TEMPLATE_MIX', branchPublishedAt: new Date(), activeKey: null } });
        const old = await tx.workflowRun.create({ data: { projectId, workflow: 'EFFECT', workflowSpace: 'EFFECT',
          parentWorkflowRunId: owner.id, forkNodeId: 'TEMPLATE_MIX', branchPublishedAt: new Date(), activeKey: 'ACTIVE' } });
        const fixtures = [];
        for (const [run, size, revision] of [[root, 20, 1], [owner, count, 2], [old, 20, 1]] as const) {
          const workspace = await tx.effectImportWorkspace.create({ data: { projectId, workflowRunId: run.id } });
          const draft = await tx.effectImportDraft.create({ data: { projectId, workspaceId: workspace.id,
            mode: 'SINGLE', globalConfig: {}, validationIssues: [] } });
          const product = await tx.effectImportProduct.create({ data: { projectId, workflowRunId: run.id,
            draftId: draft.id, configOverride: {} } });
          const base = { projectId, workflowRunId: run.id, kind: 'STRUCTURED' as const, name: '来源',
            directory: 'VIDEO_MATERIALS' as const, type: 'VIDEO_MATERIAL' as const, contentHash: 'a'.repeat(64) };
          const prompt = await tx.workingArtifact.create({ data: { ...base, nodeId: 'PROMPT_GENERATION',
            artifactKey: `prompt-batch:${product.id}`, payload: { items: [] } } });
          await tx.workingArtifact.create({ data: { ...base, nodeId: 'SOURCE_IMPORT',
            artifactKey: `source-package:${product.id}`, payload: {} } });
          const batch = await tx.effectSegmentRenderBatch.create({ data: { projectId, workflowRunId: run.id,
            productId: product.id, sourcePromptArtifactId: prompt.id, sourcePromptRevision: 1,
            sourcePromptHash: prompt.contentHash, sourceFingerprint: 'a'.repeat(64), requestHash: 'a'.repeat(64),
            idempotencyKey: run.id, status: 'COMPLETED', activeKey: null, committedAt: new Date(), revision } });
          const taskIds = Array.from({ length: size }, () => randomUUID());
          if (taskIds.length) await tx.effectSegmentRenderTask.createMany({ data: taskIds.map((id, i) => ({
            id, projectId, workflowRunId: run.id, productId: product.id, batchId: batch.id,
            promptId: randomUUID(), promptCode: `P${i}`, renderCode: `R-${i}`, sourceFingerprint: 'a'.repeat(64),
            requestSnapshot: i >= 20 ? { importedMaterial: { fileObjectId: randomUUID() } } : {},
            generationRequestSnapshot: i >= 20 ? { importedMaterial: { fileObjectId: randomUUID() } } : {},
            status: 'COMPLETED' as const, progress: 100,
          })) });
          await tx.workingArtifact.create({ data: { ...base, nodeId: 'SEGMENT_RENDER',
            artifactKey: `render-batch:${product.id}`, revision,
            metadata: run.id === old.id ? { branchSource: { artifactId: 'copy' } } : {},
            payload: { clips: taskIds.map((taskId) => ({ taskId })) } } });
          fixtures.push({ run, product, batch, taskIds });
        }
        const scoped = new Proxy(tx, { get(target, key) { return key === '$transaction'
          ? (fn: (client: Prisma.TransactionClient) => unknown) => fn(tx) : Reflect.get(target, key); } }) as unknown as PrismaService;
        const render = new EffectSegmentRenderRepository(scoped);
        const current = fixtures.find((item) => item.run.id === old.id)!;
        const source = fixtures.find((item) => item.run.id === owner.id)!;
        const viewed = await render.workspaceBatch(projectId, old.id, current.product.id);
        expect(viewed?.id).toBe(source.batch.id);
        expect(viewed?.tasks).toHaveLength(count);
        const working = new WorkflowWorkingRepository(scoped);
        const edit = await working.beginEffectNodeEditInTransaction(tx, projectId, old.id, 'SEGMENT_RENDER');
        expect(edit).not.toBeNull();
        const copied = await render.workspaceBatch(projectId, edit!.runId, edit!.productIdMap[current.product.id]!);
        expect(copied?.workflowRunId).toBe(edit!.runId);
        expect(copied?.tasks).toHaveLength(count);
        expect(copied?.tasks.filter((task) => (task.requestSnapshot as { importedMaterial?: unknown }).importedMaterial))
          .toHaveLength(Math.max(0, count - 20));
        expect(source.taskIds.every((id) => Boolean(edit!.taskIdMap[id]))).toBe(true);
        expect(edit!.productIdMap[source.product.id]).toBe(edit!.productIdMap[current.product.id]);
        const exit = await working.publishEffectNodeEditInTransaction(tx, projectId, edit!.runId, 'SEGMENT_RENDER');
        expect(exit?.activeWorkflowRunId).toBe(old.id);
        expect((await render.latestBatch(projectId, old.id, current.product.id))?.tasks).toHaveLength(20);
        expect((await render.workspaceBatch(projectId, old.id, current.product.id))?.tasks).toHaveLength(count);
        // Saving a deletion has two inverse aliases: the navigation parent's product and the
        // confirmed owner's product. JSON order must not choose an old pool or a missing batch.
        const editing = await working.beginEffectNodeEditInTransaction(tx, projectId, old.id, 'SEGMENT_RENDER');
        const childProductId = editing!.productIdMap[current.product.id]!;
        await tx.workflowRun.update({ where: { id: editing!.runId }, data: { editIdMap: {
          productIdMap: { [source.product.id]: childProductId, [current.product.id]: childProductId },
          taskIdMap: editing!.taskIdMap,
        } } });
        const child = await render.latestBatch(projectId, editing!.runId, childProductId);
        expect(child).not.toBeNull();
        const deleted = child!.tasks[0];
        if (deleted) await tx.effectSegmentRenderTask.update({ where: { id: deleted.id },
          data: { status: 'FAILED', errorCode: 'MATERIAL_DELETED' } });
        const childPrompt = await tx.workingArtifact.findFirstOrThrow({ where: { projectId,
          workflowRunId: editing!.runId, artifactKey: `prompt-batch:${childProductId}` } });
        const childSource = await tx.workingArtifact.findFirstOrThrow({ where: { projectId,
          workflowRunId: editing!.runId, artifactKey: `source-package:${childProductId}` } });
        const saving = new EffectSegmentRenderRepository(scoped, working);
        const result = await saving.commitValidatedBatch(projectId, child!.id, child!.revision,
          { artifactId: childPrompt.id, revision: childPrompt.revision, contentHash: childPrompt.contentHash },
          { artifactId: childSource.id, revision: childSource.revision, contentHash: childSource.contentHash },
          [{ artifactKey: `render-batch:${childProductId}`, input: {
            kind: 'STRUCTURED', name: '保存后的素材池', directory: 'VIDEO_MATERIALS', type: 'VIDEO_MATERIAL',
            payload: { clips: child!.tasks.filter((task) => task.id !== deleted?.id).map((task) => ({ taskId: task.id })),
              removedSources: deleted ? [{ taskId: deleted.id, promptId: deleted.promptId }] : [] },
          } }]);
        expect(result.kind).toBe('COMMITTED');
        if (result.kind === 'COMMITTED') expect(result.publication).toEqual({
          activeWorkflowRunId: old.id, createdBranch: false });
        const after = await saving.workspaceBatch(projectId, old.id, current.product.id);
        expect(after?.id).toBe(source.batch.id);
        expect(after?.tasks.filter((task) => task.status === 'COMPLETED')).toHaveLength(Math.max(0, count - 1));
        expect(after?.tasks.filter((task) => (task.requestSnapshot as { importedMaterial?: unknown }).importedMaterial))
          .toHaveLength(Math.max(0, count - 20));
        expect((await saving.latestBatch(projectId, old.id, current.product.id))?.tasks).toHaveLength(20);
        const savedPool = await tx.workingArtifact.findFirstOrThrow({ where: { projectId,
          workflowRunId: source.run.id, artifactKey: `render-batch:${source.product.id}` } });
        expect((savedPool.payload as { clips: unknown[] }).clips).toHaveLength(Math.max(0, count - 1));
        if (deleted) expect((savedPool.payload as { removedSources: { taskId: string }[] }).removedSources[0]?.taskId)
          .toBe(source.taskIds.find((id) => editing!.taskIdMap[id] === deleted.id));
        expect((await tx.workflowRun.findUniqueOrThrow({ where: { id: editing!.runId } })).branchPublishedAt).toBeNull();
        expect(await tx.jobOutbox.count({ where: { projectId } })).toBe(0);
        throw rollback;
      }, { timeout: 120_000 })).rejects.toThrow(rollback);
    } finally { await db.$disconnect(); }
  }, 120_000,
);
