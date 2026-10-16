import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { expect, it } from 'vitest';
import type { EffectTemplateMixVariant } from '@ai-marketing/contracts';
import { PrismaService } from '../../../database/prisma.service';
import { WorkflowWorkingRepository } from '../../../platform/workflow/workflow-working.repository';
import type { WorkflowWorkingService } from '../../../platform/workflow/workflow-working.service';
import type { EffectTemplateMixService } from '../template-mix/effect-template-mix.service';
import type { StoragePort } from '../../../platform/file/storage.port';
import { visualHash } from '../template-mix/effect-packaging.domain';
import { EffectFinalOutputService } from './effect-final-output.service';

// All fixture writes and outbox rows stay invisible in an outer transaction, then roll back.
// This cannot dispatch paid work or leave test projects in the user's workspace.
it.skipIf(process.env.EFFECT_OUTPUT_DATABASE_TEST !== '1')(
  '100-item real PostgreSQL transaction, full gate, revisions, leases and idempotence',
  async () => {
    const db = new PrismaService(
      new ConfigService({
        DATABASE_URL:
          process.env.DATABASE_URL ??
          'postgresql://postgres:postgres@localhost:5432/ai_marketing?schema=public',
      }),
    );
    const projectId = randomUUID(),
      workflowRunId = randomUUID(),
      templateId = randomUUID();
    const rollback = new Error('TEST_ROLLBACK');
    const directory = await mkdtemp(join(tmpdir(), 'output-transaction-'));
    const videoPath = join(directory, 'local.mp4');
    const rerenderPath = join(directory, 'rerender.mp4');
    // Only exercise the upload/asset transaction here; real decoding is covered by FFmpeg tests.
    const header = Buffer.alloc(64);
    header.write('ftyp', 4);
    await writeFile(videoPath, header);
    // A re-render at new settings produces different bytes; identical bytes are a legal no-op.
    const rerenderHeader = Buffer.alloc(128);
    rerenderHeader.write('ftyp', 4);
    await writeFile(rerenderPath, rerenderHeader);
    try {
      await expect(
        db.$transaction(
          async (tx) => {
            await tx.project.create({ data: { id: projectId, name: '隔离回滚测试' } });
            await tx.workflowRun.create({
              data: { id: workflowRunId, projectId, workflow: 'EFFECT', workflowSpace: 'EFFECT' },
            });
            // Exporting forks the output node, and a fork clones the workspace of the run it starts from.
            await tx.effectImportWorkspace.create({ data: { projectId, workflowRunId } });
            const source = await tx.workingArtifact.create({
              data: {
                projectId,
                workflowRunId,
                nodeId: 'SOURCE_IMPORT',
                artifactKey: 'test-source',
                kind: 'STRUCTURED',
                name: '测试来源',
                directory: 'EDITING_PROJECTS',
                type: 'TIMELINE_PROJECT',
                contentHash: 'a'.repeat(64),
              },
            });
            const files = await Promise.all(
              ['video', 'voice', 'music'].map((name) =>
                tx.fileObject.create({
                  data: {
                    projectId,
                    workflowRunId,
                    nodeId: 'TEMPLATE_MIX',
                    originalFileName: name,
                    mimeType: 'audio/wav',
                    sizeBytes: 100,
                    storageKey: `test/${projectId}/${name}`,
                    sha256: 'b'.repeat(64),
                  },
                }),
              ),
            );
            const promptId = randomUUID();
            const prompt = await tx.workingArtifact.create({
              data: {
                projectId,
                workflowRunId,
                nodeId: 'PROMPT_GENERATION',
                artifactKey: `prompt-batch:${promptId}`,
                kind: 'STRUCTURED',
                name: '测试素材 Prompt',
                directory: 'EDITING_PROJECTS',
                type: 'TIMELINE_PROJECT',
                contentHash: 'e'.repeat(64),
                payload: { items: [{ id: promptId, content: '隔离测试商品画面' }] },
              },
            });
            const material = await tx.workingArtifact.create({
              data: {
                projectId,
                workflowRunId,
                nodeId: 'SEGMENT_RENDER',
                artifactKey: `render-clip:${randomUUID()}`,
                kind: 'FILE',
                name: '测试素材',
                directory: 'EDITING_PROJECTS',
                type: 'TIMELINE_PROJECT',
                contentHash: 'f'.repeat(64),
                payload: { promptId, fileObjectId: files[0]!.id, durationSeconds: 20 },
                dependencies: {
                  create: [
                    {
                      sourceType: 'WORKING_ARTIFACT',
                      sourceArtifactId: prompt.id,
                      sourceKey: prompt.artifactKey,
                      sourceRevision: 1,
                    },
                  ],
                },
              },
            });
            const variants: EffectTemplateMixVariant[] = Array.from({ length: 100 }, (_, i) => ({
              id: randomUUID(),
              name: `测试成片${i + 1}`,
              slots: [
                {
                  id: 's',
                  role: 'PRODUCT',
                  purpose: 'PRODUCT_DISPLAY',
                  label: '产品',
                  duration: 10,
                  transition: '硬切',
                },
              ],
              bindings: { s: material.id },
              bindingRevisions: { s: 1 },
              offsets: { s: 0 },
              appliedTemplateVersion: 1,
              manualSlotIds: [],
              conflictSlotIds: [],
              status: 'CURRENT',
              captions: [],
              subtitleStyle: 'standard',
              voice: null,
              bgm: null,
              originalVolume: 0.15,
            }));
            await tx.workflowNodeState.create({
              data: {
                projectId,
                workflowRunId,
                nodeId: 'TEMPLATE_MIX',
                revision: 1,
                contentHash: 'c'.repeat(64),
                state: {
                  templates: [
                    { id: templateId, workspace: { template: { name: '隔离测试' }, variants } },
                  ],
                },
              },
            });
            const packaging = await tx.effectPackagingRun.create({
              data: {
                projectId,
                workflowRunId,
                templateId,
                idempotencyKey: 'packaging',
                requestHash: 'd'.repeat(64),
                status: 'COMPLETED',
                items: {
                  create: variants.map((v, i) => ({
                    variantId: v.id,
                    name: v.name,
                    shardIndex: Math.floor(i / 4),
                    sourceTimelineHash: visualHash(v),
                    status: i === 99 ? 'FAILED' : 'COMPLETED',
                    stage: 'READY',
                    snapshot: {
                      variant: v,
                      sourceTimelineHash: visualHash(v),
                      duration: 10,
                      clips: [{ slotId: 's', start: 0, duration: 10, fileObjectId: files[0]!.id }],
                      facts: [{ id: 'f', text: '测试商品' }],
                      dependencies: [
                        {
                          artifactId: source.id,
                          artifactKey: source.artifactKey,
                          revision: 1,
                          contentHash: source.contentHash,
                          nodeId: source.nodeId,
                        },
                      ],
                    },
                    checkpoint: {
                      narrationLayoutVersion: 'SLOT_V1',
                      vision: [{ start: 0, end: 10, description: '测试画面' }],
                      script: [
                        {
                          id: 'line',
                          slotId: 's',
                          text: '商品',
                          start: 0,
                          end: 10,
                          factIds: ['f'],
                        },
                      ],
                      voices: {
                        line: { fileObjectId: files[1]!.id, start: 0, duration: 2, volume: 1 },
                      },
                      music: { fileObjectId: files[2]!.id, start: 0, duration: 10, volume: 0.12 },
                      captions: [{ id: 'line', text: '商品', start: 0, end: 2 }],
                    },
                  })),
                },
              },
            });
            const scopedDb = new Proxy(tx, {
              get(target, property) {
                return property === '$transaction'
                  ? (fn: (value: typeof tx) => unknown) => fn(tx)
                  : Reflect.get(target, property);
              },
            }) as unknown as PrismaService;
            const inputs = variants.map((v) => ({
              artifactKey: `timeline-project:${templateId}:${v.id}`,
              input: {
                kind: 'STRUCTURED',
                name: v.name,
                directory: 'EDITING_PROJECTS',
                type: 'TIMELINE_PROJECT',
                payload: { variant: v },
              },
            }));
            const outputSourceWorkspace = async (_projectId: string, runId: string) => {
              const [state, artifacts] = await Promise.all([
                tx.workflowNodeState.findFirstOrThrow({
                  where: { projectId, workflowRunId: runId, nodeId: 'TEMPLATE_MIX' },
                }),
                tx.workingArtifact.findMany({
                  where: { projectId, workflowRunId: runId },
                  include: { dependencies: true },
                }),
              ]);
              const clip = artifacts.find((artifact) =>
                artifact.artifactKey.startsWith('render-clip:'),
              )!;
              return {
                draft: state.state,
                artifacts,
                materials: [
                  {
                    id: clip.id,
                    artifactId: clip.id,
                    artifactRevision: clip.revision,
                    fileObjectId: files[0]!.id,
                    duration: 20,
                    available: true,
                    contentHash: clip.contentHash,
                    ratio: '3:4',
                  },
                ],
              };
            };
            const mix = {
              prepareValidation: async () => ({ variants, inputs }),
              workspace: outputSourceWorkspace,
              outputSourceWorkspace,
            } as unknown as EffectTemplateMixService;
            let uploaded = 0;
            const deleted: string[] = [];
            const storage: StoragePort = {
              put: async (input) => {
                let sizeBytes = 0;
                for await (const chunk of input.stream) sizeBytes += Buffer.byteLength(chunk);
                expect(sizeBytes).toBe(input.sizeBytes);
                uploaded += 1;
                // A fresh key per upload: a constant key would make the second artifact commit look
                // unchanged and silently no-op, hiding the re-render path.
                return {
                  key: `test/${projectId}/final-${uploaded}.mp4`,
                  sizeBytes: input.sizeBytes,
                };
              },
              putShared: async () => {
                throw new Error('This transaction test never uploads shared media');
              },
              delete: async (key) => {
                deleted.push(key);
              },
              open: async () => {
                throw new Error('This transaction test never downloads source media');
              },
            };
            const service = new EffectFinalOutputService(
              scopedDb,
              mix,
              new WorkflowWorkingRepository(scopedDb),
              storage,
              {
                getEffectBranchTree: async () => ({
                  projectId,
                  activeWorkflowRunId: workflowRunId,
                  branches: [
                    {
                      workflowRunId,
                      parentWorkflowRunId: null,
                      forkNodeId: null,
                      forkTemplateId: null,
                      createdAt: new Date().toISOString(),
                      templates: [{ templateId }],
                    },
                  ],
                }),
              } as unknown as WorkflowWorkingService,
            );
            // A package that is still running must not queue anything or commit a version.
            await tx.effectPackagingRun.update({
              where: { id: packaging.id },
              data: { status: 'RUNNING' },
            });
            await expect(
              service.upsertFromPackaging(projectId, workflowRunId, templateId),
            ).rejects.toThrow('包装仍在执行');
            expect(await tx.effectFinalOutputRun.count({ where: { projectId } })).toBe(0);
            expect(
              await tx.workingArtifact.count({ where: { projectId, nodeId: 'TEMPLATE_MIX' } }),
            ).toBe(0);
            await tx.effectPackagingRun.update({
              where: { id: packaging.id },
              data: { status: 'COMPLETED' },
            });
            await tx.effectPackagingItem.updateMany({
              where: { projectId, runId: packaging.id },
              data: { status: 'COMPLETED' },
            });
            // The finished package alone fills the output queue; there is no validation step left.
            await service.upsertFromPackaging(projectId, workflowRunId, templateId);
            const queued = await service.get(
              projectId,
              (await tx.effectFinalOutputRun.findFirstOrThrow({ where: { projectId } })).id,
            );
            expect(queued.items).toHaveLength(100);
            expect(queued.status).toBe('PENDING_RENDER');
            expect(await tx.jobOutbox.count({ where: { projectId } })).toBe(0);
            // Exporting is a version of its own, so even the first export opens a branch and renders
            // into it; the queue it came from stays untouched for the version tree to read.
            const run = await service.start(projectId, queued.id, {
              resolution: '720p',
              frameRate: 30,
            });
            expect(run.id).not.toBe(queued.id);
            expect(run.workflowRunId).not.toBe(workflowRunId);
            expect(run.status).toBe('QUEUED');
            expect(run.items).toHaveLength(100);
            expect(
              (await tx.workflowRun.findUniqueOrThrow({ where: { id: workflowRunId } })).activeKey,
            ).toBe('ACTIVE');
            expect(
              (await tx.workflowRun.findUniqueOrThrow({ where: { id: run.workflowRunId } }))
                .activeKey,
            ).toBeNull();
            expect(
              (await tx.effectFinalOutputRun.findUniqueOrThrow({ where: { id: queued.id } }))
                .status,
            ).toBe('PENDING_RENDER');
            // The same package arriving twice names the same version, so it reuses the queued batch.
            await service.upsertFromPackaging(projectId, workflowRunId, templateId);
            expect(await tx.jobOutbox.count({ where: { projectId } })).toBe(1);
            expect(
              await tx.workingArtifact.count({
                where: { projectId, workflowRunId, nodeId: 'TEMPLATE_MIX', revision: 1 },
              }),
            ).toBe(200);
            expect(
              await tx.workingArtifact.count({
                where: { projectId, workflowRunId: run.workflowRunId, nodeId: 'TEMPLATE_MIX' },
              }),
            ).toBe(200);
            const claim = await service.claim(projectId, run.id);
            expect(claim.items).toHaveLength(100);
            await expect(service.heartbeat(projectId, run.id, randomUUID())).rejects.toThrow(
              '租约',
            );
            const itemId = claim.items![0]!.id;
            const saved = await service.upload(projectId, run.id, claim.attemptToken!, itemId, {
              path: videoPath,
              size: header.length,
            });
            expect(
              (await service.upload(projectId, run.id, claim.attemptToken!, itemId)).fileObjectId,
            ).toBe(saved.fileObjectId);
            expect(uploaded).toBe(1);
            expect(await tx.asset.count({ where: { projectId, sourceNode: 'FINAL_OUTPUT' } })).toBe(
              1,
            );
            expect(await tx.assetVersion.count({ where: { projectId } })).toBe(1);
            expect(
              await tx.workingArtifact.count({
                where: { projectId, nodeId: 'FINAL_OUTPUT', revision: 1 },
              }),
            ).toBe(1);
            await service.cancel(projectId, run.id);
            await expect(service.heartbeat(projectId, run.id, claim.attemptToken!)).rejects.toThrow(
              '租约',
            );
            expect(
              await tx.effectFinalOutputItem.count({ where: { projectId, status: 'CANCELLED' } }),
            ).toBe(99);
            await service.retry(projectId, run.id);
            const resumed = await service.claim(projectId, run.id);
            expect(resumed.items!.filter((item) => item.status === 'COMPLETED')).toHaveLength(1);
            expect(resumed.items!.filter((item) => item.status === 'QUEUED')).toHaveLength(99);
            expect(await tx.jobOutbox.count({ where: { projectId } })).toBe(1);
            // An upstream revision bump must not break a render already in flight: the batch renders
            // the file IDs frozen into its snapshot and only reports the drift as `stale` in the UI.
            await tx.workingArtifact.update({ where: { id: source.id }, data: { revision: 2 } });
            await service.progress(
              projectId,
              run.id,
              resumed.attemptToken!,
              resumed.items!.find((item) => item.status === 'QUEUED')!.id,
              10,
            );
            await tx.workingArtifact.update({ where: { id: source.id }, data: { revision: 1 } });

            // --- single-item re-render: overwrite in place, never a second asset row or leaked blob ---
            await tx.effectFinalOutputItem.updateMany({
              where: { projectId, runId: run.id },
              data: { status: 'COMPLETED', progress: 100 },
            });
            await tx.effectFinalOutputRun.update({
              where: { id: run.id },
              data: { status: 'COMPLETED' },
            });
            const beforeRerender = await tx.effectFinalOutputItem.findUniqueOrThrow({
              where: { id: itemId },
            });
            await service.renderItem(projectId, run.id, itemId);
            expect(
              (await tx.effectFinalOutputItem.findUniqueOrThrow({ where: { id: itemId } })).status,
            ).toBe('QUEUED');
            const rerenderClaim = await service.claim(projectId, run.id);
            expect(rerenderClaim.items!.filter((item) => item.status === 'COMPLETED')).toHaveLength(
              99,
            );
            expect(rerenderClaim.items!.filter((item) => item.status === 'QUEUED')).toHaveLength(1);
            const rerendered = await service.upload(
              projectId,
              run.id,
              rerenderClaim.attemptToken!,
              itemId,
              { path: rerenderPath, size: rerenderHeader.length },
            );
            expect(rerendered.fileObjectId).not.toBe(beforeRerender.fileObjectId);
            // The replaced blob stays alive: the artifact commit keeps a revision snapshot of the
            // previous version, and that snapshot still points at this file. Only the blob behind it
            // is queued for cleanup, so nothing leaks and nothing the history needs is dropped.
            expect(
              (
                await tx.fileObject.findUniqueOrThrow({
                  where: { id: beforeRerender.fileObjectId! },
                })
              ).status,
            ).toBe('AVAILABLE');
            expect(
              await tx.workingArtifactRevisionFile.count({
                where: { projectId, fileObjectId: beforeRerender.fileObjectId! },
              }),
            ).toBeGreaterThan(0);
            expect(
              (await tx.fileObject.findUniqueOrThrow({ where: { id: rerendered.fileObjectId! } }))
                .status,
            ).toBe('AVAILABLE');
            expect(await tx.asset.count({ where: { projectId, sourceNode: 'FINAL_OUTPUT' } })).toBe(
              1,
            );
            expect(await tx.assetVersion.count({ where: { projectId } })).toBe(1);
            expect(
              (
                await tx.workingArtifact.findFirstOrThrow({
                  where: { projectId, nodeId: 'FINAL_OUTPUT' },
                })
              ).revision,
            ).toBe(2);
            expect(await tx.storageCleanupTask.count({ where: { projectId } })).toBe(1);
            expect(deleted).toEqual([]);
            await service.finish(projectId, run.id, rerenderClaim.attemptToken!);
            expect(
              (await tx.effectFinalOutputRun.findUniqueOrThrow({ where: { id: run.id } })).status,
            ).toBe('COMPLETED');

            // A failed re-render must leave the previous output downloadable and the batch PARTIAL.
            await service.renderItem(projectId, run.id, itemId);
            const failedClaim = await service.claim(projectId, run.id);
            await service.progress(
              projectId,
              run.id,
              failedClaim.attemptToken!,
              itemId,
              40,
              '重新渲染失败',
            );
            await service.finish(projectId, run.id, failedClaim.attemptToken!);
            expect(
              (await tx.effectFinalOutputRun.findUniqueOrThrow({ where: { id: run.id } })).status,
            ).toBe('PARTIAL');
            expect(
              (await tx.effectFinalOutputItem.findUniqueOrThrow({ where: { id: itemId } }))
                .fileObjectId,
            ).toBe(rerendered.fileObjectId);

            throw rollback;
          },
          { timeout: 120_000 },
        ),
      ).rejects.toBe(rollback);
      expect(await db.project.count({ where: { id: projectId } })).toBe(0);
    } finally {
      await db.$disconnect();
      await unlink(videoPath);
      await unlink(rerenderPath);
      await rmdir(directory);
    }
  },
  130_000,
);
