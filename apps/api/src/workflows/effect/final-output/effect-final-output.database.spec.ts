import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { expect, it } from 'vitest';
import type { EffectTemplateMixVariant } from '@ai-marketing/contracts';
import { PrismaService } from '../../../database/prisma.service';
import { WorkflowWorkingRepository } from '../../../platform/workflow/workflow-working.repository';
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
    // Only exercise the upload/asset transaction here; real decoding is covered by FFmpeg tests.
    const header = Buffer.alloc(64);
    header.write('ftyp', 4);
    await writeFile(videoPath, header);
    try {
      await expect(
        db.$transaction(
          async (tx) => {
            await tx.project.create({ data: { id: projectId, name: '隔离回滚测试' } });
            await tx.workflowRun.create({
              data: { id: workflowRunId, projectId, workflow: 'EFFECT', workflowSpace: 'EFFECT' },
            });
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
            const variants: EffectTemplateMixVariant[] = Array.from({ length: 100 }, (_, i) => ({
              id: randomUUID(),
              name: `测试成片${i + 1}`,
              slots: [],
              bindings: {},
              bindingRevisions: {},
              offsets: {},
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
                state: { templates: [{ id: templateId, workspace: { variants } }] },
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
                      clips: [{ fileObjectId: files[0]!.id }],
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
                      vision: [{ start: 0, end: 10, description: '测试画面' }],
                      script: [{ id: 'line', text: '商品', start: 0, end: 4, factIds: ['f'] }],
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
            const mix = {
              prepareValidation: async () => ({ variants, inputs }),
              workspace: async () => ({
                materials: [{ fileObjectId: files[0]!.id, ratio: '3:4' }],
              }),
            } as unknown as EffectTemplateMixService;
            let uploaded = 0;
            const storage: StoragePort = {
              put: async (input) => {
                let sizeBytes = 0;
                for await (const chunk of input.stream) sizeBytes += Buffer.byteLength(chunk);
                expect(sizeBytes).toBe(input.sizeBytes);
                uploaded += 1;
                return { key: `test/${projectId}/final.mp4`, sizeBytes: input.sizeBytes };
              },
              putShared: async () => {
                throw new Error('This transaction test never uploads shared media');
              },
              delete: async () => undefined,
              open: async () => {
                throw new Error('This transaction test never downloads source media');
              },
            };
            const service = new EffectFinalOutputService(
              scopedDb,
              mix,
              new WorkflowWorkingRepository(scopedDb),
              storage,
            );
            const body = { workflowRunId, expectedRevision: 1, idempotencyKey: 'finish' };
            await expect(service.complete(projectId, templateId, body)).rejects.toThrow('全部成功');
            expect(await tx.effectFinalOutputRun.count({ where: { projectId } })).toBe(0);
            expect(
              await tx.workingArtifact.count({ where: { projectId, nodeId: 'TEMPLATE_MIX' } }),
            ).toBe(0);
            await tx.effectPackagingItem.updateMany({
              where: { projectId, runId: packaging.id },
              data: { status: 'COMPLETED' },
            });
            const run = await service.complete(projectId, templateId, body);
            expect(run.items).toHaveLength(100);
            expect(run.status).toBe('PENDING_RENDER');
            expect(await tx.jobOutbox.count({ where: { projectId } })).toBe(0);
            await service.start(projectId, run.id, { resolution: '720p', frameRate: 30 });
            const replay = await service.complete(projectId, templateId, body);
            expect(replay.id).toBe(run.id);
            expect(await tx.jobOutbox.count({ where: { projectId } })).toBe(1);
            expect(
              await tx.workingArtifact.count({
                where: { projectId, nodeId: 'TEMPLATE_MIX', revision: 1 },
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
            await tx.workingArtifact.update({ where: { id: source.id }, data: { revision: 2 } });
            await expect(
              service.progress(
                projectId,
                run.id,
                resumed.attemptToken!,
                resumed.items!.find((item) => item.status === 'QUEUED')!.id,
                10,
              ),
            ).rejects.toThrow('过期');
            throw rollback;
          },
          { timeout: 120_000 },
        ),
      ).rejects.toBe(rollback);
      expect(await db.project.count({ where: { id: projectId } })).toBe(0);
    } finally {
      await db.$disconnect();
      await unlink(videoPath);
      await rmdir(directory);
    }
  },
  130_000,
);
