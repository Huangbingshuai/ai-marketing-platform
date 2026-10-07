import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { expect, it } from 'vitest';
import type { EffectTemplateMixDraft, EffectTemplateMixVariant, FinalOutputSnapshot } from '@ai-marketing/contracts';
import { PrismaService } from '../../database/prisma.service';
import { WorkflowWorkingRepository } from './workflow-working.repository';
import { WorkflowWorkingService } from './workflow-working.service';
import { EffectTemplateMixService } from '../../workflows/effect/template-mix/effect-template-mix.service';
import { EffectFinalOutputService } from '../../workflows/effect/final-output/effect-final-output.service';
import type { StoragePort } from '../file/storage.port';

// All fixtures, output tasks and Outbox entries roll back; no paid jobs are dispatched.
it.skipIf(process.env.EFFECT_OUTPUT_DATABASE_TEST !== '1').each(['render-head', 'packaging-run', 'newest-fill-run', 'sibling-source-dependencies'])(
  '%s repair keeps historical branches independent after the selected local refresh',
  async (sourceScope) => {
    const db = new PrismaService(new ConfigService({ DATABASE_URL: process.env.DATABASE_URL ??
      'postgresql://postgres:postgres@localhost:5432/ai_marketing?schema=public' }));
    const rollback = new Error('BRANCH_FRESHNESS_ROLLBACK');
    try {
      await expect(db.$transaction(async (tx) => {
        const projectId = randomUUID(), rootId = randomUUID(), aId = randomUUID(), bId = randomUUID(), cId = randomUUID();
        const childIds = sourceScope !== 'render-head' ? [aId, bId, cId] : [aId, bId];
        const templateId = randomUUID(), promptId = randomUUID(), rootTask = randomUUID();
        await tx.project.create({ data: { id: projectId, name: '历史分支待更新回滚验收' } });
        await tx.workflowRun.create({ data: { id: rootId, projectId,
          workflow: 'EFFECT', workflowSpace: 'EFFECT', activeKey: null } });
        for (const id of childIds) await tx.workflowRun.create({ data: { id, projectId,
          workflow: 'EFFECT', workflowSpace: 'EFFECT', parentWorkflowRunId:
            sourceScope !== 'render-head' && id !== aId ? aId : rootId,
          forkNodeId: 'TEMPLATE_MIX', forkTemplateId: templateId, branchPublishedAt: new Date(),
          activeKey: id === aId ? 'ACTIVE' : null } });
        const oldFile = await tx.fileObject.create({ data: { projectId, workflowRunId: rootId,
          nodeId: 'SEGMENT_RENDER', originalFileName: 'old.mp4', mimeType: 'video/mp4',
          sizeBytes: 64, storageKey: `test/${projectId}/old.mp4`, sha256: 'a'.repeat(64) } });
        const newFile = await tx.fileObject.create({ data: { projectId,
          workflowRunId: ['newest-fill-run', 'sibling-source-dependencies'].includes(sourceScope) ? cId : rootId,
          nodeId: 'SEGMENT_RENDER', originalFileName: 'new.mp4', mimeType: 'video/mp4',
          sizeBytes: 64, storageKey: `test/${projectId}/new.mp4`, sha256: 'b'.repeat(64) } });
        const prompt = await tx.workingArtifact.create({ data: { projectId, workflowRunId: rootId,
          nodeId: 'PROMPT_GENERATION', artifactKey: `prompt-batch:${randomUUID()}`, kind: 'STRUCTURED',
          name: '已确认素材 Prompt', directory: 'EDITING_PROJECTS', type: 'TIMELINE_PROJECT',
          contentHash: '9'.repeat(64), payload: { items: [{ id: promptId, content: '商品画面' }] } } });
        const clipData = (workflowRunId: string, taskId: string, file = oldFile) => ({
          projectId, workflowRunId, nodeId: 'SEGMENT_RENDER', artifactKey: `render-clip:${taskId}`,
          kind: 'FILE' as const, name: 'R-001', directory: 'EDITING_PROJECTS' as const,
          type: 'TIMELINE_PROJECT' as const, contentHash: file.sha256,
          storageKey: file.storageKey, mimeType: file.mimeType, sizeBytes: file.sizeBytes,
          payload: { fileObjectId: file.id, promptId, durationSeconds: 8, contentHash: file.sha256,
            primaryPurpose: 'PRODUCT_DISPLAY' },
          dependencies: { create: [{ sourceType: 'WORKING_ARTIFACT' as const, sourceArtifactId: prompt.id,
            sourceKey: prompt.artifactKey, sourceRevision: 1 }] },
        });
        const rootClip = await tx.workingArtifact.create({ data: clipData(rootId, rootTask,
          sourceScope !== 'render-head' ? oldFile : newFile) });
        if (sourceScope === 'render-head')
          await tx.workingArtifact.update({ where: { id: rootClip.id }, data: { revision: 2 } });
        await tx.workingArtifact.create({ data: { projectId, workflowRunId: rootId,
          nodeId: 'SEGMENT_RENDER', artifactKey: `render-batch:${randomUUID()}`, name: '素材池',
          kind: 'STRUCTURED', directory: 'EDITING_PROJECTS', type: 'TIMELINE_PROJECT', contentHash: 'c'.repeat(64),
          payload: { clips: [{ taskId: rootTask, promptId }] } } });
        const scopedDb = new Proxy(tx, { get(target, key) { return key === '$transaction'
          ? (fn: (client: typeof tx) => unknown) => fn(tx) : Reflect.get(target, key); } }) as unknown as PrismaService;
        const working = new WorkflowWorkingRepository(scopedDb);
        const branches = new WorkflowWorkingService(working, { get: async () => ({ id: projectId }) } as never, {} as never);
        const mix = new EffectTemplateMixService(branches);
        const output = new EffectFinalOutputService(scopedDb, mix, working, {} as StoragePort, branches);
        const fixtures = [];
        let repairedId = rootClip.id;
        for (const runId of childIds) {
          const copiedTask = randomUUID();
          const copied = await tx.workingArtifact.create({ data: {
            ...clipData(runId, copiedTask), metadata: { branchSource: { artifactId: rootClip.id, revision: 1 } },
          } });
          if ((sourceScope === 'packaging-run' && runId === aId) ||
              (['newest-fill-run', 'sibling-source-dependencies'].includes(sourceScope) && runId === cId)) {
            // A real confirmed repair in an existing packaging Run, not a new render fork.
            await tx.workingArtifact.update({ where: { id: copied.id }, data: {
              revision: 2, payload: clipData(runId, copiedTask, newFile).payload,
              contentHash: newFile.sha256, metadata: { promptId }, storageKey: newFile.storageKey,
            } });
            await tx.workingArtifact.create({ data: { projectId, workflowRunId: runId,
              nodeId: 'SEGMENT_RENDER', artifactKey: `render-batch:${randomUUID()}`, name: '返修后素材池',
              kind: 'STRUCTURED', directory: 'EDITING_PROJECTS', type: 'TIMELINE_PROJECT',
              contentHash: '2'.repeat(64), revision: 2, payload: { clips: [{ taskId: copiedTask, promptId }] } } });
            repairedId = copied.id;
            if (sourceScope === 'sibling-source-dependencies') {
              // Real Run copies remint Prompt/fact artifact ids. These dependencies are absent
              // from the selected older sibling's ancestor path, but are valid frozen sources.
              const facts = await tx.workingArtifact.create({ data: { projectId, workflowRunId: runId,
                nodeId: 'INFORMATION_EXTRACTION', artifactKey: `marketing-insight:${randomUUID()}`,
                kind: 'STRUCTURED', directory: 'INSIGHTS', type: 'INSIGHT_RESULT', name: '来源事实',
                contentHash: '7'.repeat(64), payload: { productName: '确认商品' } } });
              const copiedPrompt = await tx.workingArtifact.create({ data: { projectId, workflowRunId: runId,
                nodeId: 'PROMPT_GENERATION', artifactKey: `prompt-batch:${randomUUID()}`,
                kind: 'STRUCTURED', directory: 'EDITING_PROJECTS', type: 'TIMELINE_PROJECT', name: '来源Prompt',
                contentHash: prompt.contentHash, payload: prompt.payload!,
                metadata: { branchSource: { artifactId: prompt.id, revision: prompt.revision } },
                dependencies: { create: [{ sourceType: 'WORKING_ARTIFACT', sourceArtifactId: facts.id,
                  sourceKey: facts.artifactKey, sourceRevision: 1, sourceHash: facts.contentHash }] } } });
              await tx.workingArtifactDependency.deleteMany({ where: { projectId, dependentArtifactId: copied.id } });
              await tx.workingArtifactDependency.create({ data: { projectId, workflowRunId: runId, dependentArtifactId: copied.id,
                sourceType: 'WORKING_ARTIFACT', sourceArtifactId: copiedPrompt.id,
                sourceKey: copiedPrompt.artifactKey, sourceRevision: 1, sourceHash: copiedPrompt.contentHash } });
            }
            await tx.workingArtifactFile.create({ data: { projectId, workflowRunId: runId,
              workingArtifactId: copied.id, fileObjectId: newFile.id, role: 'PRIMARY', sortOrder: 0 } });
          }
          const variant: EffectTemplateMixVariant = { id: randomUUID(), name: '成片 01',
            slots: [{ id: 's', label: '产品', role: 'PRODUCT', purpose: 'PRODUCT_DISPLAY', duration: 4, transition: '硬切' }],
            bindings: { s: copied.id }, bindingRevisions: { s: 1 }, offsets: { s: 0 },
            appliedTemplateVersion: 1, manualSlotIds: [], conflictSlotIds: [], status: 'CURRENT',
            captions: [], subtitleStyle: 'standard', voice: null, bgm: null, originalVolume: 1 };
          const draft: EffectTemplateMixDraft = { schemaVersion: 1, activeTemplateId: templateId,
            templates: [{ id: templateId, workspace: { editVersion: 1,
              template: { name: '测试模板', editVersion: 1, slots: variant.slots }, variants: [variant] } }] };
          await tx.workflowNodeState.create({ data: { projectId, workflowRunId: runId,
            nodeId: 'TEMPLATE_MIX', contentHash: 'd'.repeat(64), state: JSON.parse(JSON.stringify(draft)) } });
          const timeline = await tx.workingArtifact.create({ data: { projectId, workflowRunId: runId,
            nodeId: 'TEMPLATE_MIX', artifactKey: `timeline-project:${templateId}:${variant.id}`,
            kind: 'STRUCTURED', directory: 'EDITING_PROJECTS', type: 'TIMELINE_PROJECT',
            name: variant.name, contentHash: 'e'.repeat(64), payload: { variant },
            dependencies: { create: [{ sourceType: 'WORKING_ARTIFACT',
              sourceArtifactId: copied.id, sourceKey: copied.artifactKey, sourceRevision: 1 }] } } });
          const snapshot: FinalOutputSnapshot = { timeline: { variant, clips: [], sourceTimelineHash: '',
            duration: 4, facts: [], dependencies: [] }, packaging: { voices: {}, captions: [] }, unpackaged: true,
            dependencies: [{ artifactId: timeline.id, artifactKey: timeline.artifactKey,
              nodeId: timeline.nodeId, revision: 1, contentHash: timeline.contentHash }],
            aspectRatio: '9:16', originalVolume: 1, resolution: '720p', frameRate: 30 };
          const batch = await tx.effectFinalOutputRun.create({ data: { projectId, workflowRunId: runId, templateId,
            idempotencyKey: randomUUID(), requestHash: 'f'.repeat(64), inputHash: randomUUID(), status: 'PENDING_RENDER',
            items: { create: [{ variantId: variant.id, name: variant.name,
              status: 'PENDING_RENDER', snapshot: JSON.parse(JSON.stringify(snapshot)) }] } }, include: { items: true } });
          fixtures.push({ runId, batch, variant });
        }
        const tree = await branches.getEffectBranchTree(projectId);
        for (const runId of childIds) {
          expect(tree.branches.find((branch) => branch.workflowRunId === runId)?.templates[0]?.fillStatus).toBe('STALE');
          expect(tree.branches.find((branch) => branch.workflowRunId === runId)?.nodes
            .find((node) => node.nodeId === 'SEGMENT_RENDER')?.status, `render:${runId}`).toBe('CONFIRMED');
          expect((await mix.materialSources(projectId, runId)).pendingProjectCount).toBe(1);
          expect((await mix.workspace(projectId, runId)).draft.templates[0]?.needsAiFill).toBe(false);
          expect((await mix.materialSources(projectId, runId)).materials
            .filter((material) => material.available && material.activeSource !== false)
            .map((material) => material.fileObjectId)).toEqual([newFile.id]);
        }
        const selected = fixtures[0]!, sibling = fixtures[1]!;
        if (sourceScope === 'newest-fill-run') {
          // Only the shared, confirmed render pool is authorized across sibling Run storage.
          const validate = working as unknown as { validateArtifactInputsInTransaction:
            (client: typeof tx, project: string, run: string, input: unknown) => Promise<void> };
          const source = await tx.workingArtifact.findUniqueOrThrow({ where: { id: repairedId } });
          const dependency = { sourceType: 'WORKING_ARTIFACT', sourceArtifactId: source.id,
            sourceKey: source.artifactKey, sourceRevision: 2, sourceHash: newFile.sha256 };
          await expect(validate.validateArtifactInputsInTransaction(tx, projectId, aId,
            { files: [{ fileObjectId: newFile.id }], dependencies: [dependency] })).resolves.toBeUndefined();
          await expect(validate.validateArtifactInputsInTransaction(tx, projectId, aId,
            { dependencies: [{ ...dependency, sourceHash: '0'.repeat(64) }] }))
            .rejects.toThrow('WORKING_ARTIFACT_DEPENDENCY_CONFLICT');
          const foreignRun = await tx.workflowRun.create({ data: { projectId,
            workflow: 'EFFECT', workflowSpace: 'EFFECT', parentWorkflowRunId: rootId,
            forkNodeId: 'MANUAL_COPY', branchPublishedAt: new Date(), activeKey: null } });
          const foreignFile = await tx.fileObject.create({ data: { projectId, workflowRunId: foreignRun.id,
            nodeId: 'SEGMENT_RENDER', originalFileName: 'independent.mp4', mimeType: 'video/mp4',
            sizeBytes: 64, storageKey: `test/${projectId}/independent.mp4`, sha256: '8'.repeat(64) } });
          await expect(validate.validateArtifactInputsInTransaction(tx, projectId, aId,
            { files: [{ fileObjectId: foreignFile.id }] })).rejects.toThrow('WORKING_FILE_OBJECT_NOT_FOUND');
        }
        const siblingBefore = await tx.workflowNodeState.findFirstOrThrow({ where: {
          projectId, workflowRunId: bId, nodeId: 'TEMPLATE_MIX' } });
        await output.localUpdate(projectId, selected.batch.id, { itemIds: [selected.batch.items[0]!.id] });
        const queued = await tx.effectFinalOutputItem.findUniqueOrThrow({ where: { id: selected.batch.items[0]!.id } });
        const refreshed = queued.snapshot as unknown as FinalOutputSnapshot;
        expect(refreshed.sourceRefresh?.workflowRunId).toBe(aId);
        expect(refreshed.timeline.variant.bindings.s).toBe(repairedId);
        expect(refreshed.timeline.variant.bindingRevisions.s).toBe(2);
        expect(await tx.effectFinalOutputRun.findUniqueOrThrow({ where: { id: sibling.batch.id }, include: { items: true } }))
          .toEqual(sibling.batch);
        expect(await tx.workflowNodeState.findUniqueOrThrow({ where: { id: siblingBefore.id } })).toEqual(siblingBefore);
        // Exercise the existing commit boundary without sending any model or render work.
        refreshed.sourceRefresh!.ready = true;
        await (output as unknown as { commitSourceRefresh: (client: typeof tx, project: string,
          snapshot: FinalOutputSnapshot) => Promise<void> }).commitSourceRefresh(tx, projectId, refreshed);
        expect((await mix.materialSources(projectId, aId)).pendingProjectCount).toBe(0);
        expect((await mix.materialSources(projectId, bId)).pendingProjectCount).toBe(1);
        const updatedTree = await branches.getEffectBranchTree(projectId);
        expect(updatedTree.branches.find((branch) => branch.workflowRunId === aId)?.templates[0]?.fillStatus, 'updated fill').toBe('CONFIRMED');
        expect(updatedTree.branches.find((branch) => branch.workflowRunId === bId)?.templates[0]?.fillStatus).toBe('STALE');
        if (sourceScope !== 'render-head') {
          expect((await mix.materialSources(projectId, cId)).pendingProjectCount).toBe(1);
          expect(updatedTree.branches.find((branch) => branch.workflowRunId === cId)?.templates[0]?.fillStatus).toBe('STALE');
        }
        throw rollback;
      }, { timeout: 120_000 })).rejects.toBe(rollback);
    } finally { await db.$disconnect(); }
  }, 130_000,
);
