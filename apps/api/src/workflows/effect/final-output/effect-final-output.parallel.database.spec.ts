import { randomUUID } from 'node:crypto';
import { mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { expect, it } from 'vitest';
import type { EffectTemplateMixVariant, FinalOutputSnapshot, WorkingArtifact } from '@ai-marketing/contracts';
import { PrismaService } from '../../../database/prisma.service';
import { WorkflowWorkingRepository, workingArtifactInclude } from '../../../platform/workflow/workflow-working.repository';
import type { WorkflowWorkingService } from '../../../platform/workflow/workflow-working.service';
import type { EffectTemplateMixService } from '../template-mix/effect-template-mix.service';
import type { StoragePort } from '../../../platform/file/storage.port';
import { artifactVisitor, packagingClips, visualHash } from '../template-mix/effect-packaging.domain';
import { EffectFinalOutputService } from './effect-final-output.service';

// Interleave two live leases inside a real PostgreSQL transaction. Outbox and all fixtures roll
// back, so no paid job is dispatched. The tiny MP4 headers test persistence, not video decoding.
it.skipIf(process.env.EFFECT_OUTPUT_DATABASE_TEST !== '1')(
  'independent full export and parent local update keep snapshots, leases, files and publications isolated',
  async () => {
    const db = new PrismaService(new ConfigService({ DATABASE_URL: process.env.DATABASE_URL }));
    const projectId = randomUUID(), parentId = randomUUID(), templateId = randomUUID();
    const directory = await mkdtemp(join(tmpdir(), 'output-parallel-'));
    const path = join(directory, 'result.mp4');
    const bytes = Buffer.alloc(128); bytes.write('ftyp', 4); await writeFile(path, bytes);
    const rollback = new Error('OUTPUT_PARALLEL_ROLLBACK');
    try {
      await expect(db.$transaction(async (tx) => {
        await tx.project.create({ data: { id: projectId, name: '成片并行隔离验收' } });
        await tx.workflowRun.create({ data: { id: parentId, projectId, workflow: 'EFFECT', workflowSpace: 'EFFECT' } });
        await tx.effectImportWorkspace.create({ data: { projectId, workflowRunId: parentId } });
        const sourceFile = await tx.fileObject.create({ data: { projectId, workflowRunId: parentId,
          nodeId: 'SEGMENT_RENDER', originalFileName: 'source.mp4', mimeType: 'video/mp4',
          sizeBytes: 64, storageKey: `test/${projectId}/source.mp4`, sha256: 'a'.repeat(64) } });
        const promptId = randomUUID();
        const prompt = await tx.workingArtifact.create({ data: { projectId, workflowRunId: parentId,
          nodeId: 'PROMPT_GENERATION', artifactKey: `prompt-batch:${promptId}`, kind: 'STRUCTURED',
          name: '测试 Prompt', directory: 'EDITING_PROJECTS', type: 'TIMELINE_PROJECT',
          contentHash: 'b'.repeat(64), payload: { items: [{ id: promptId, content: '隔离测试素材画面' }] } } });
        const clip = await tx.workingArtifact.create({ data: { projectId, workflowRunId: parentId,
          nodeId: 'SEGMENT_RENDER', artifactKey: `render-clip:${randomUUID()}`, kind: 'FILE', name: '测试素材',
          directory: 'EDITING_PROJECTS', type: 'TIMELINE_PROJECT', contentHash: 'c'.repeat(64),
          payload: { promptId, fileObjectId: sourceFile.id, durationSeconds: 20 },
          dependencies: { create: [{ sourceType: 'WORKING_ARTIFACT', sourceKey: prompt.artifactKey,
            sourceArtifactId: prompt.id, sourceRevision: 1 }] } } });
        const variants: EffectTemplateMixVariant[] = [1, 2].map((n) => ({ id: randomUUID(), name: `成片 ${n}`,
          slots: [{ id: 's', role: 'PRODUCT', purpose: 'PRODUCT_DISPLAY', label: '产品', duration: 6, transition: '硬切' }],
          bindings: { s: clip.id }, bindingRevisions: { s: 1 }, offsets: { s: 0 }, appliedTemplateVersion: 1,
          manualSlotIds: [], conflictSlotIds: [], status: 'CURRENT', captions: [], subtitleStyle: 'standard',
          voice: null, bgm: null, originalVolume: 0.15 }));
        const state = await tx.workflowNodeState.create({ data: { projectId, workflowRunId: parentId,
          nodeId: 'TEMPLATE_MIX', contentHash: 'd'.repeat(64), revision: 1,
          state: { templates: [{ id: templateId, workspace: { template: { name: '并行模板' }, variants } }] } } });
        const timelines = await Promise.all(variants.map((variant) => tx.workingArtifact.create({ data: {
          projectId, workflowRunId: parentId, nodeId: 'TEMPLATE_MIX',
          artifactKey: `timeline-project:${templateId}:${variant.id}`, kind: 'STRUCTURED', name: variant.name,
          directory: 'EDITING_PROJECTS', type: 'TIMELINE_PROJECT', contentHash: 'e'.repeat(64), payload: { variant },
        } })));
        await tx.workingArtifact.create({ data: { projectId, workflowRunId: parentId, nodeId: 'FINAL_OUTPUT',
          artifactKey: `final-delivery:${templateId}`, kind: 'STRUCTURED', name: '已有交付',
          directory: 'REPORTS_DELIVERABLES', type: 'DELIVERY_MANIFEST', contentHash: 'f'.repeat(64) } });
        const sourceWorkspace = async (_p: string, id: string) => {
          const node = await tx.workflowNodeState.findFirstOrThrow({ where: { projectId, workflowRunId: id, nodeId: 'TEMPLATE_MIX' } });
          const artifacts = await tx.workingArtifact.findMany({ where: { projectId, workflowRunId: id }, include: workingArtifactInclude });
          const material = artifacts.find((a) => a.artifactKey.startsWith('render-clip:'))!;
          return { draft: node.state as unknown as { templates: { id: string; workspace: { template: { name: string }; variants: EffectTemplateMixVariant[] } }[] },
            artifacts: artifacts as unknown as WorkingArtifact[], materials: [{ id: material.id, artifactId: material.id,
              artifactRevision: material.revision, available: true, fileObjectId: sourceFile.id, duration: 20,
              contentHash: material.contentHash, code: 'R-001', name: '测试素材', ratio: '9:16' }] };
        };
        const baseline = await sourceWorkspace(projectId, parentId);
        const snapshots = variants.map((variant, index): FinalOutputSnapshot => ({ timeline: {
          variant, clips: packagingClips(variant, baseline.materials as never, artifactVisitor(baseline.artifacts)),
          sourceTimelineHash: visualHash(variant), duration: 6, facts: [], dependencies: [],
        }, packaging: { voices: {}, captions: [] }, unpackaged: true,
          dependencies: [{ artifactId: timelines[index]!.id, artifactKey: timelines[index]!.artifactKey,
            nodeId: 'TEMPLATE_MIX', revision: 1, contentHash: timelines[index]!.contentHash }],
          aspectRatio: '9:16', originalVolume: 0.15, resolution: '720p', frameRate: 30 }));
        const oldFiles = await Promise.all(variants.map((_v, i) => tx.fileObject.create({ data: {
          projectId, workflowRunId: parentId, nodeId: 'FINAL_OUTPUT', originalFileName: `old-${i}.mp4`,
          mimeType: 'video/mp4', sizeBytes: 64, storageKey: `test/${projectId}/old-${i}.mp4`, sha256: '1'.repeat(64),
        } })));
        const oldAssets = await Promise.all(oldFiles.map((file, i) => tx.asset.create({ data: {
          projectId, name: `成片 ${i}`, directory: 'FINAL_VIDEOS', type: 'FINAL_VIDEO',
          originalFileName: file.originalFileName, mimeType: file.mimeType, sizeBytes: file.sizeBytes,
          storageKey: file.storageKey, sourceNode: 'FINAL_OUTPUT', sourceRunId: parentId,
        } })));
        for (const [index, file] of oldFiles.entries()) {
          const artifact = await tx.workingArtifact.create({ data: { projectId, workflowRunId: parentId,
            nodeId: 'FINAL_OUTPUT', artifactKey: `final-video:${templateId}:${variants[index]!.id}`,
            kind: 'FILE', name: variants[index]!.name, directory: 'FINAL_VIDEOS', type: 'FINAL_VIDEO',
            originalFileName: file.originalFileName, mimeType: file.mimeType, sizeBytes: file.sizeBytes,
            storageKey: file.storageKey, contentHash: '4'.repeat(64),
          } });
          await tx.workingArtifactFile.create({ data: { projectId, workflowRunId: parentId,
            workingArtifactId: artifact.id, fileObjectId: file.id, role: 'VIDEO' } });
          await tx.asset.update({ where: { id: oldAssets[index]!.id }, data: { sourceArtifactId: artifact.id } });
        }
        const parent = await tx.effectFinalOutputRun.create({ data: { projectId, workflowRunId: parentId,
          templateId, status: 'COMPLETED', idempotencyKey: 'old', requestHash: '2'.repeat(64), inputHash: '3'.repeat(64),
          items: { create: variants.map((variant, i) => ({ variantId: variant.id, name: variant.name,
            status: 'COMPLETED', progress: 100, snapshot: snapshots[i] as never,
            fileObjectId: oldFiles[i]!.id, assetId: oldAssets[i]!.id })) } }, include: { items: true } });
        const scoped = new Proxy(tx, { get(target, key) {
          return key === '$transaction' ? (fn: (client: typeof tx) => unknown) => fn(tx) : Reflect.get(target, key);
        } }) as unknown as PrismaService;
        let uploads = 0;
        const service = new EffectFinalOutputService(scoped,
          { workspace: sourceWorkspace, outputSourceWorkspace: sourceWorkspace } as unknown as EffectTemplateMixService,
          new WorkflowWorkingRepository(scoped), { put: async (input: Parameters<StoragePort['put']>[0]) => {
            for await (const _chunk of input.stream) { /* consume actual upload */ }
            return { key: `test/${projectId}/new-${++uploads}.mp4`, sizeBytes: input.sizeBytes };
          }, delete: async () => {} } as unknown as StoragePort,
          { getEffectBranchTree: async () => ({ projectId, activeWorkflowRunId: parentId, branches: [{
            workflowRunId: parentId, parentWorkflowRunId: null, forkNodeId: null, forkTemplateId: null,
            createdAt: '2026-10-04', templates: [{ templateId }],
          }] }) } as unknown as WorkflowWorkingService);
        const save = async () => tx.workflowNodeState.update({ where: { id: state.id }, data: {
          state: { templates: [{ id: templateId, workspace: { template: { name: '并行模板' }, variants } }] },
        } });
        variants[0]!.offsets.s = 1; variants[0]!.slots[0]!.duration = 7; await save();
        const child = await service.start(projectId, parent.id, { resolution: '1080p', frameRate: 50 });
        expect(child.items.map((i) => i.duration)).toEqual([7, 6]);
        await expect(service.start(projectId, parent.id, { resolution: '720p', frameRate: 30 })).rejects.toThrow('已开始渲染');
        expect(await tx.workflowRun.count({ where: { projectId } })).toBe(2);
        const read = await service.list(projectId, parentId);
        expect(read.map((r) => [r.id, r.backgroundExportSourceRunId])).toEqual([[parent.id, undefined], [child.id, parentId]]);
        const childClaim = await service.claim(projectId, child.id);
        variants[0]!.offsets.s = 2; variants[0]!.slots[0]!.duration = 8; await save();
        const parentItem = parent.items.find((item) => item.variantId === variants[0]!.id)!;
        await service.localUpdate(projectId, parent.id, { itemIds: [parentItem.id] });
        const parentClaim = await service.claim(projectId, parent.id);
        expect(parentClaim.attemptToken).not.toBe(childClaim.attemptToken);
        await expect(service.heartbeat(projectId, parent.id, childClaim.attemptToken!)).rejects.toThrow('租约');
        expect((parentClaim.items!.find((i) => i.id === parentItem.id)!.snapshot as unknown as FinalOutputSnapshot).timeline.duration).toBe(8);
        expect((childClaim.items!.find((i) => i.name === '成片 1')!.snapshot as unknown as FinalOutputSnapshot).timeline.duration).toBe(7);
        const parentUpload = await service.upload(projectId, parent.id, parentClaim.attemptToken!, parentItem.id,
          { path, size: bytes.length });
        const childUploads = [];
        for (const item of childClaim.items!) childUploads.push(await service.upload(projectId, child.id,
          childClaim.attemptToken!, item.id, { path, size: bytes.length }));
        await service.finish(projectId, child.id, childClaim.attemptToken!);
        expect((await tx.workflowRun.findUniqueOrThrow({ where: { id: child.workflowRunId } })).branchPublishedAt).not.toBeNull();
        expect((await tx.workflowRun.findUniqueOrThrow({ where: { id: parentId } })).activeKey).toBe('ACTIVE');
        await service.finish(projectId, parent.id, parentClaim.attemptToken!);
        const updated = await tx.effectFinalOutputItem.findMany({ where: { projectId, runId: parent.id }, orderBy: { name: 'asc' } });
        expect(updated[0]!.fileObjectId).toBe(parentUpload.fileObjectId);
        expect(updated[0]!.assetId).toBe(oldAssets[0]!.id);
        expect(updated[1]!.fileObjectId).toBe(oldFiles[1]!.id);
        expect(childUploads.every((item) => item.fileObjectId !== parentUpload.fileObjectId)).toBe(true);
        expect(await tx.asset.count({ where: { projectId } })).toBe(4);
        expect(await tx.jobOutbox.count({ where: { projectId } })).toBe(2);
        expect(await tx.workingArtifact.count({ where: { projectId, artifactKey: `final-delivery:${templateId}` } })).toBe(2);
        expect((await tx.workingArtifact.findFirstOrThrow({ where: { projectId, workflowRunId: parentId,
          artifactKey: `final-delivery:${templateId}` } })).revision).toBe(2);
        expect((await tx.effectFinalOutputRun.findUniqueOrThrow({ where: { id: parent.id } })).status).toBe('COMPLETED');
        throw rollback;
      }, { timeout: 120_000 })).rejects.toBe(rollback);
      expect(await db.project.count({ where: { id: projectId } })).toBe(0);
    } finally { await db.$disconnect(); await unlink(path); await rmdir(directory); }
  }, 130_000,
);
