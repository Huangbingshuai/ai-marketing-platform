import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { ConfigService } from '@nestjs/config';
import { Client } from 'pg';
import { expect, it, vi } from 'vitest';
import { PrismaClient } from '../../../generated/prisma/client';
import type { PrismaService } from '../../../database/prisma.service';
import type { StoragePort } from '../../../platform/file/storage.port';
import { WorkflowWorkingRepository } from '../../../platform/workflow/workflow-working.repository';
import { confirmedEffectRenderSourceRun } from '../../../platform/workflow/effect-render-source-context';
import { EffectTemplateDeletionRepository } from './effect-template-deletion.repository';
import { EffectTemplateDeletionService } from './effect-template-deletion.service';
import type { EffectTemplateDeletionCache } from './effect-template-deletion-cache.service';
import { EffectTemplateDeletionCache as RealDeletionCache } from './effect-template-deletion-cache.service';
import { RedisConnectionService } from '../../../platform/cache/redis-connection.service';

// Build the current schema in a random private namespace. Never migrate public or expose
// test outbox rows to running workers. Drop only this exact generated namespace on exit.
it.skipIf(process.env.EFFECT_TEMPLATE_DELETE_DATABASE_TEST !== '1')(
  'permanently cleans template data, keeps sibling/shared sources and rejects resurrection in PostgreSQL',
  async () => {
    const schema = `template_delete_test_${randomUUID().replaceAll('-', '')}`;
    const url =
      process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/ai_marketing';
    const admin = new Client({ connectionString: url });
    let db: PrismaClient | undefined;
    try {
      await admin.connect();
      await admin.query(`CREATE SCHEMA "${schema}"`);
      await admin.query(`SET search_path TO "${schema}"`);
      const ddl = execFileSync(
        process.execPath,
        [
          resolve('node_modules/prisma/build/index.js'),
          'migrate',
          'diff',
          '--from-empty',
          '--to-schema',
          'prisma/schema.prisma',
          '--script',
        ],
        { encoding: 'utf8', maxBuffer: 10_000_000 },
      );
      await admin.query(ddl.replaceAll('"public"', `"${schema}"`));
      // Exercise the actual migration, not a handwritten approximation of its guards/table.
      await admin.query('DROP TABLE effect_template_deletions');
      await admin.query(
        readFileSync(
          'prisma/migrations/20261009030000_effect_template_deletion/migration.sql',
          'utf8',
        ),
      );
      db = new PrismaClient({
        adapter: new PrismaPg(
          { connectionString: url, options: `-c search_path=${schema}` },
          { schema },
        ),
      });
      const repository = new EffectTemplateDeletionRepository(db as unknown as PrismaService);
      const working = new WorkflowWorkingRepository(db as unknown as PrismaService);
      const projectId = randomUUID(),
        otherProject = randomUUID(),
        root = randomUUID(),
        fill = randomUUID(),
        output = randomUUID(),
        sibling = randomUUID();
      const templateId = randomUUID(),
        siblingId = randomUUID(),
        variantId = randomUUID();
      const legacySibling = randomUUID(),
        legacySiblingChild = randomUUID();
      await db.project.createMany({
        data: [
          { id: projectId, name: 'isolated deletion fixture' },
          { id: otherProject, name: 'isolated unaffected fixture' },
        ],
      });
      await db.workflowRun.create({
        data: { id: root, projectId, workflow: 'EFFECT', workflowSpace: 'EFFECT' },
      });
      for (const [id, parent, tpl, node] of [
        [fill, root, templateId, 'TEMPLATE_MIX'],
        [output, fill, templateId, 'FINAL_OUTPUT'],
        [sibling, fill, siblingId, 'TEMPLATE_MIX'],
        [legacySibling, fill, null, 'TEMPLATE_MIX'],
        [legacySiblingChild, legacySibling, null, 'TEMPLATE_MIX'],
      ] as const)
        await db.workflowRun.create({
          data: {
            id,
            projectId,
            parentWorkflowRunId: parent,
            forkTemplateId: tpl,
            forkNodeId: node,
            activeKey: null,
            workflow: 'EFFECT',
            workflowSpace: 'EFFECT',
            branchPublishedAt: new Date(),
          },
        });
      await db.workflowRun.update({ where: { id: root }, data: { activeKey: null } });
      await db.workflowRun.update({ where: { id: output }, data: { activeKey: 'ACTIVE' } });
      const hash = 'a'.repeat(64);
      for (const workflowRunId of [root, fill, output, sibling, legacySibling, legacySiblingChild])
        await db.workflowNodeState.create({
          data: {
            projectId,
            workflowRunId,
            nodeId: 'TEMPLATE_MIX',
            contentHash: hash,
            state: {
              schemaVersion: 1,
              activeTemplateId: templateId,
              templates: [{ id: templateId }, { id: siblingId }],
            },
          },
        });
      for (const workflowRunId of [legacySibling, legacySiblingChild]) {
        await db.effectTemplateMixAiRun.create({
          data: {
            projectId,
            workflowRunId,
            templateId: siblingId,
            idempotencyKey: `legacy-sibling-${workflowRunId}`,
            requestHash: hash,
            inputHash: hash,
            inputSnapshot: {},
            expectedDraftRevision: 1,
            templateEditVersion: 1,
            status: 'COMPLETED',
          },
        });
      }
      await db.workflowNodeState.create({
        data: {
          projectId,
          workflowRunId: root,
          nodeId: 'TEMPLATE_MIX:current-paths',
          contentHash: hash,
          state: {
            schemaVersion: 1,
            workflowRunId: root,
            selectedTemplates: { [templateId]: 'now', [siblingId]: 'before' },
          },
        },
      });
      const file = await db.fileObject.create({
        data: {
          projectId,
          workflowRunId: output,
          nodeId: 'FINAL_OUTPUT',
          storageKey: 'isolated/owned',
          originalFileName: 'a.mp4',
          mimeType: 'video/mp4',
          sha256: hash,
          sizeBytes: 10,
        },
      });
      const shared = await db.fileObject.create({
        data: {
          projectId,
          workflowRunId: fill,
          nodeId: 'TEMPLATE_MIX',
          storageKey: 'isolated/shared',
          originalFileName: 'shared.wav',
          mimeType: 'audio/wav',
          sha256: hash,
          sizeBytes: 10,
        },
      });
      const artifact = async (workflowRunId: string, key: string, fileObjectId?: string) =>
        db!.workingArtifact.create({
          data: {
            projectId,
            workflowRunId,
            nodeId: key.startsWith('render-')
              ? 'SEGMENT_RENDER'
              : key.startsWith('final-')
                ? 'FINAL_OUTPUT'
                : 'TEMPLATE_MIX',
            artifactKey: key,
            kind: 'STRUCTURED',
            directory: 'FINAL_VIDEOS',
            type: 'FINAL_VIDEO',
            name: 'fixture',
            contentHash: hash,
            ...(fileObjectId
              ? { files: { create: { fileObjectId, role: 'media', sortOrder: 0 } } }
              : {}),
          },
        });
      const source = await artifact(fill, 'render-clip:shared-source', shared.id);
      for (const workflowRunId of [legacySibling, legacySiblingChild]) {
        // A copied target configuration must not override actual sibling task ownership.
        await artifact(workflowRunId, `mix-template:${templateId}`);
        await artifact(workflowRunId, `timeline-project:${siblingId}:${randomUUID()}`);
      }
      // No mix dependency points at this membership index or unused clip. They
      // still belong to the render node, not the template being permanently removed.
      const poolIndex = await artifact(fill, 'render-batch:shared-product');
      const unusedClip = await artifact(fill, 'render-clip:unused-source');
      await artifact(root, 'render-batch:shared-product');
      await db.workingArtifact.update({
        where: { id: poolIndex.id },
        data: {
          revision: 2,
          payload: { clips: Array.from({ length: 22 }, (_, i) => ({ taskId: `material-${i}` })) },
        },
      });
      const sourceUser = await artifact(
        sibling,
        `timeline-project:${siblingId}:${randomUUID()}`,
        shared.id,
      );
      await db.workingArtifactDependency.create({
        data: {
          projectId,
          workflowRunId: sibling,
          dependentArtifactId: sourceUser.id,
          sourceType: 'WORKING_ARTIFACT',
          sourceArtifactId: source.id,
          sourceKey: source.artifactKey,
          sourceRevision: 1,
          sourceHash: hash,
        },
      });
      const finalArtifact = await artifact(
        output,
        `final-video:${templateId}:${variantId}`,
        file.id,
      );
      await artifact(fill, `mix-template:${templateId}`);
      await artifact(root, `mix-template:${siblingId}`);
      const unknownLegacy = randomUUID();
      await db.workflowRun.create({
        data: {
          id: unknownLegacy,
          projectId,
          parentWorkflowRunId: fill,
          forkNodeId: 'TEMPLATE_MIX',
          forkTemplateId: null,
          activeKey: null,
          workflow: 'EFFECT',
          workflowSpace: 'EFFECT',
        },
      });
      const copiedConfig = await artifact(unknownLegacy, `mix-template:${templateId}`);
      await db.workingArtifact.update({
        where: { id: copiedConfig.id },
        data: { contentHash: 'b'.repeat(64) },
      });
      // Legacy provenance survives A's cleanup because B still consumes it. It must
      // never be rediscovered as a live B branch by a later deletion request.
      const retiredLegacy = randomUUID();
      await db.workflowRun.create({
        data: {
          id: retiredLegacy,
          projectId,
          parentWorkflowRunId: fill,
          forkNodeId: 'TEMPLATE_MIX',
          forkTemplateId: null,
          activeKey: null,
          workflow: 'EFFECT',
          workflowSpace: 'EFFECT',
        },
      });
      const historicalSiblingSource = await artifact(retiredLegacy, `mix-template:${siblingId}`);
      // A real task proves this is A's retired branch, not an unknown child or
      // B's live branch containing inherited configuration from A.
      await db.effectTemplateMixAiRun.create({
        data: {
          projectId,
          workflowRunId: retiredLegacy,
          templateId,
          idempotencyKey: 'retired-a-owner',
          requestHash: hash,
          inputHash: hash,
          inputSnapshot: {},
          expectedDraftRevision: 1,
          templateEditVersion: 1,
          status: 'COMPLETED',
        },
      });
      await db.workingArtifactDependency.create({
        data: {
          projectId,
          workflowRunId: sibling,
          dependentArtifactId: sourceUser.id,
          sourceType: 'WORKING_ARTIFACT',
          sourceArtifactId: historicalSiblingSource.id,
          sourceKey: historicalSiblingSource.artifactKey,
          sourceRevision: 1,
          sourceHash: hash,
        },
      });
      const asset = await db.asset.create({
        data: {
          projectId,
          name: 'owned output',
          directory: 'FINAL_VIDEOS',
          type: 'FINAL_VIDEO',
          originalFileName: 'a.mp4',
          mimeType: 'video/mp4',
          sizeBytes: 10,
          storageKey: file.storageKey,
          sourceArtifactId: finalArtifact.id,
          versions: {
            create: {
              projectId,
              version: 1,
              changeNote: 'isolated fixture',
              status: 'AVAILABLE',
              qualityStatus: 'AVAILABLE',
              originalFileName: 'a.mp4',
              mimeType: 'video/mp4',
              sizeBytes: 10,
              storageKey: file.storageKey,
            },
          },
        },
      });
      const outputRun = await db.effectFinalOutputRun.create({
        data: {
          projectId,
          workflowRunId: output,
          templateId,
          idempotencyKey: 'fixture',
          requestHash: hash,
          inputHash: hash,
          status: 'RUNNING',
          attemptToken: randomUUID(),
          leaseExpiresAt: new Date(Date.now() + 60_000),
          items: {
            create: {
              variantId,
              name: 'film',
              snapshot: {},
              fileObjectId: file.id,
              assetId: asset.id,
            },
          },
        },
      });
      const fillRun = await db.effectTemplateMixAiRun.create({
        data: {
          projectId,
          workflowRunId: fill,
          templateId,
          idempotencyKey: 'fill-fixture',
          requestHash: hash,
          inputHash: hash,
          inputSnapshot: {},
          expectedDraftRevision: 1,
          templateEditVersion: 1,
          status: 'RUNNING',
          attemptToken: randomUUID(),
          leaseExpiresAt: new Date(Date.now() + 60_000),
        },
      });
      const packageRun = await db.effectPackagingRun.create({
        data: {
          projectId,
          workflowRunId: fill,
          templateId,
          idempotencyKey: 'pack-fixture',
          requestHash: hash,
          status: 'RUNNING',
          attemptToken: randomUUID(),
          leaseExpiresAt: new Date(Date.now() + 60_000),
          items: {
            create: {
              variantId,
              name: 'film',
              shardIndex: 0,
              sourceTimelineHash: hash,
              snapshot: {},
              files: { create: { fileObjectId: shared.id, role: 'bgm' } },
            },
          },
        },
      });
      const packageItem = await db.effectPackagingItem.findFirstOrThrow({
        where: { projectId, runId: packageRun.id },
      });
      await db.workingArtifactRevisionSnapshot.create({
        data: {
          projectId,
          workflowRunId: output,
          workingArtifactId: finalArtifact.id,
          artifactKey: finalArtifact.artifactKey,
          nodeId: 'FINAL_OUTPUT',
          revision: 1,
          contentHash: hash,
          snapshot: {},
          files: {
            create: {
              projectId,
              workflowRunId: output,
              fileObjectId: file.id,
              role: 'media',
              sortOrder: 0,
            },
          },
        },
      });
      await db.jobOutbox.create({
        data: {
          projectId,
          jobType: 'TEST_ONLY',
          routingKey: 'never-dispatched',
          aggregateId: outputRun.id,
          payload: {},
        },
      });

      await expect(repository.enqueue(otherProject, output, templateId, 1)).rejects.toThrow(
        '工作流不存在',
      );
      await expect(repository.enqueue(projectId, output, templateId, 9)).rejects.toThrow(
        '模板已修改',
      );
      const accepted = await repository.enqueue(projectId, output, templateId, 1);
      expect(accepted).toEqual({
        templateId,
        workflowRunId: root,
        status: 'QUEUED',
        draftRevision: 2,
        removedWorkflowRunIds: expect.arrayContaining([fill, output]),
      });
      expect(accepted.removedWorkflowRunIds).not.toContain(sibling);
      expect(accepted.removedWorkflowRunIds).not.toContain(legacySibling);
      expect(accepted.removedWorkflowRunIds).not.toContain(legacySiblingChild);
      expect(accepted.removedWorkflowRunIds).not.toContain(unknownLegacy);
      expect(await repository.enqueue(projectId, output, templateId, 1)).toMatchObject({
        templateId,
        workflowRunId: root,
        status: 'QUEUED',
        removedWorkflowRunIds: accepted.removedWorkflowRunIds,
      });
      expect(await db.workflowRun.findUnique({ where: { id: root } })).toMatchObject({
        activeKey: 'ACTIVE',
      });
      // An unrelated template whose historical parent is being removed stays editable
      // while the asynchronous cleanup has not detached that parent yet.
      await expect(
        db.workflowRun.update({ where: { id: sibling }, data: { currentNodeId: 'TEMPLATE_MIX' } }),
      ).resolves.toMatchObject({ id: sibling });
      expect(await working.findRun(projectId, output)).toBeNull();
      const visible = await working.listEffectRunBranches(projectId);
      expect(visible.map((r) => r.id)).not.toContain(fill);
      expect(visible.find((r) => r.id === sibling)?.parentWorkflowRunId).toBe(root);
      expect(
        visible.flatMap((r) => r.workingArtifacts).some((a) => a.artifactKey.includes(templateId)),
      ).toBe(false);
      const state = (await working.findNodeState(projectId, root, 'TEMPLATE_MIX'))!;
      expect((state.state as { templates: unknown[] }).templates).toEqual([{ id: siblingId }]);
      const navigation = (await working.findNodeState(
        projectId,
        root,
        'TEMPLATE_MIX:current-paths',
      ))!;
      expect(navigation.state).toMatchObject({ selectedTemplates: { [siblingId]: 'before' } });
      expect(
        (navigation.state as { selectedTemplates: object }).selectedTemplates,
      ).not.toHaveProperty(templateId);
      await expect(artifact(root, `mix-template:${templateId}`)).rejects.toThrow(
        'EFFECT_TEMPLATE_DELETED',
      );
      await expect(
        db.asset.create({
          data: {
            projectId,
            name: 'late archive',
            directory: 'FINAL_VIDEOS',
            type: 'FINAL_VIDEO',
            originalFileName: 'late.mp4',
            mimeType: 'video/mp4',
            sizeBytes: 10,
            storageKey: file.storageKey,
            sourceRunId: root,
            sourceArtifactId: finalArtifact.id,
          },
        }),
      ).rejects.toThrow('EFFECT_TEMPLATE_DELETED');
      await expect(
        db.effectFinalOutputRun.update({
          where: { id: outputRun.id },
          data: { status: 'COMPLETED' },
        }),
      ).rejects.toThrow('EFFECT_TEMPLATE_DELETED');
      await expect(
        db.effectTemplateMixAiRun.update({
          where: { id: fillRun.id },
          data: { status: 'COMPLETED' },
        }),
      ).rejects.toThrow('EFFECT_TEMPLATE_DELETED');
      await expect(
        db.effectPackagingItem.update({
          where: { id: packageItem.id },
          data: { status: 'COMPLETED' },
        }),
      ).rejects.toThrow('EFFECT_TEMPLATE_DELETED');
      await expect(
        db.workflowNodeState.update({
          where: { id: state.id },
          data: { state: { templates: [{ id: templateId }] } },
        }),
      ).rejects.toThrow('EFFECT_TEMPLATE_DELETED');
      const job = await db.effectTemplateDeletion.findUniqueOrThrow({
        where: { projectId_templateId: { projectId, templateId } },
      });
      // A durable receipt accepted by old recursive code is fenced before any deletion.
      const oldToken = randomUUID();
      await db.effectTemplateDeletion.update({
        where: { id: job.id },
        data: {
          workflowRunIds: [...job.workflowRunIds, legacySibling],
          leaseToken: oldToken,
        },
      });
      await expect(repository.removeData(job.id, oldToken)).rejects.toThrow(
        'TEMPLATE_DELETE_FOREIGN_RUN_REQUIRES_REVIEW',
      );
      expect(
        await db.workflowNodeState.count({ where: { projectId, workflowRunId: legacySibling } }),
      ).toBe(1);
      await db.effectTemplateDeletion.update({
        where: { id: job.id },
        data: {
          workflowRunIds: job.workflowRunIds,
          leaseToken: null,
        },
      });
      const storage = { delete: vi.fn() },
        cache = {
          clear: vi
            .fn()
            .mockRejectedValueOnce(new Error('redis down'))
            .mockResolvedValue(undefined),
        };
      const service = new EffectTemplateDeletionService(
        repository,
        storage as unknown as StoragePort,
        cache as unknown as EffectTemplateDeletionCache,
      );
      await service.cleanup(job.id);
      const pendingFiles = await db.effectTemplateDeletion.findUniqueOrThrow({
        where: { id: job.id },
      });
      expect(pendingFiles.phase).toBe('FILES');
      expect(pendingFiles.storageKeys).toEqual(
        expect.arrayContaining([file.storageKey, shared.storageKey]),
      );
      expect(
        await db.workingArtifact.count({
          where: { projectId, artifactKey: { contains: templateId } },
        }),
      ).toBe(0);
      expect(await db.effectFinalOutputRun.count({ where: { projectId, templateId } })).toBe(0);
      expect(await db.effectTemplateMixAiRun.count({ where: { projectId, templateId } })).toBe(0);
      expect(await db.effectPackagingRun.count({ where: { projectId, templateId } })).toBe(0);
      expect(await db.asset.count({ where: { projectId } })).toBe(0);
      expect(await db.jobOutbox.count({ where: { projectId } })).toBe(0);
      expect(await db.workflowRun.findUnique({ where: { id: output } })).toBeNull();
      expect(await db.workflowRun.findUnique({ where: { id: sibling } })).toMatchObject({
        parentWorkflowRunId: root,
      });
      expect(await db.workflowRun.findUnique({ where: { id: legacySibling } })).toMatchObject({
        parentWorkflowRunId: root,
      });
      expect(await db.workflowRun.findUnique({ where: { id: legacySiblingChild } })).toMatchObject({
        parentWorkflowRunId: legacySibling,
      });
      expect(await db.workflowRun.findUnique({ where: { id: unknownLegacy } })).toMatchObject({
        parentWorkflowRunId: root,
      });
      const survivingSiblingState = await working.findNodeState(
        projectId,
        legacySibling,
        'TEMPLATE_MIX',
      );
      expect(survivingSiblingState?.state).toMatchObject({ templates: [{ id: siblingId }] });
      await expect(
        db.workflowNodeState.update({
          where: { id: survivingSiblingState!.id },
          data: { state: { templates: [{ id: siblingId }], activeTemplateId: siblingId } },
        }),
      ).resolves.toBeTruthy();
      expect(await db.workingArtifact.findUnique({ where: { id: source.id } })).not.toBeNull();
      expect(await db.workingArtifact.findUnique({ where: { id: poolIndex.id } })).not.toBeNull();
      expect(await db.workingArtifact.findUnique({ where: { id: unusedClip.id } })).not.toBeNull();
      // Removing the consumer must not roll the shared head back to the root's
      // older pool. The deleted mix Run remains hidden, but its source is readable.
      expect(await confirmedEffectRenderSourceRun(db, projectId, root)).toBe(fill);
      const renderPool = (
        await working.listArtifacts(projectId, {
          workflowRunId: root,
          nodeId: 'SEGMENT_RENDER',
        })
      ).find((row) => row.id === poolIndex.id);
      expect((renderPool?.payload as { clips?: unknown[] })?.clips).toHaveLength(22);
      expect(
        (
          await working.listArtifacts(projectId, {
            workflowRunId: fill,
            nodeId: 'SEGMENT_RENDER',
          })
        ).some((row) => row.workflowRunId === fill),
      ).toBe(false);
      expect(
        (
          await working.listArtifacts(projectId, {
            workflowRunId: fill,
            nodeId: 'SEGMENT_RENDER',
            view: 'SNAPSHOT',
          })
        ).some((row) => row.workflowRunId === fill),
      ).toBe(false);
      expect(
        await db.workingArtifactDependency.findFirst({
          where: { dependentArtifactId: sourceUser.id },
        }),
      ).toMatchObject({ sourceArtifactId: source.id, sourceRevision: 1 });
      expect(await db.fileObject.findUnique({ where: { id: shared.id } })).toMatchObject({
        workflowRunId: root,
      });
      await service.cleanup(job.id);
      expect(storage.delete).toHaveBeenCalledWith(file.storageKey);
      expect(await db.effectTemplateDeletion.findUnique({ where: { id: job.id } })).toMatchObject({
        status: 'QUEUED',
      });
      await db.effectTemplateDeletion.update({
        where: { id: job.id },
        data: { nextAttemptAt: new Date(0) },
      });
      await service.cleanup(job.id);
      expect(await db.effectTemplateDeletion.findUnique({ where: { id: job.id } })).toMatchObject({
        status: 'COMPLETED',
        storageKeys: [],
      });
      expect(await db.project.findUnique({ where: { id: otherProject } })).not.toBeNull();
      await expect(artifact(root, `mix-template:${templateId}`)).rejects.toThrow(
        'EFFECT_TEMPLATE_DELETED',
      );
      // Shared/other-project references are protected, including global voice catalog keys.
      expect(await repository.unreferenced('isolated/shared')).toBe(false);
      expect(await repository.unreferenced('shared/global.wav')).toBe(false);
      // Empty templates need the same durable deletion without manufacturing a branch,
      // task or file; simultaneous duplicate requests reuse one receipt.
      const emptyTemplateId = randomUUID();
      const emptyState = await db.workflowNodeState.update({
        where: {
          projectId_workflowRunId_nodeId: {
            projectId,
            workflowRunId: root,
            nodeId: 'TEMPLATE_MIX',
          },
        },
        data: {
          state: {
            schemaVersion: 1,
            activeTemplateId: emptyTemplateId,
            templates: [{ id: siblingId }, { id: emptyTemplateId }],
          },
          revision: { increment: 1 },
        },
      });
      const duplicates = await Promise.all(
        [0, 1].map(() => repository.enqueue(projectId, root, emptyTemplateId, emptyState.revision)),
      );
      expect(duplicates[1]).toMatchObject({
        templateId: duplicates[0]!.templateId,
        workflowRunId: duplicates[0]!.workflowRunId,
        status: duplicates[0]!.status,
        removedWorkflowRunIds: duplicates[0]!.removedWorkflowRunIds,
      });
      const emptyJob = await db.effectTemplateDeletion.findUniqueOrThrow({
        where: { projectId_templateId: { projectId, templateId: emptyTemplateId } },
      });
      expect(emptyJob.workflowRunIds).toEqual([]);
      await service.cleanup(emptyJob.id);
      await service.cleanup(emptyJob.id);
      expect(
        await db.effectTemplateDeletion.findUnique({ where: { id: emptyJob.id } }),
      ).toMatchObject({ status: 'COMPLETED' });
      expect(storage.delete).toHaveBeenCalledTimes(1);
      expect(await db.workflowRun.findUnique({ where: { id: retiredLegacy } })).not.toBeNull();
      const siblingDraft = await db.workflowNodeState.findUniqueOrThrow({
        where: {
          projectId_workflowRunId_nodeId: {
            projectId,
            workflowRunId: sibling,
            nodeId: 'TEMPLATE_MIX',
          },
        },
      });
      const siblingDeletion = await repository.enqueue(
        projectId,
        sibling,
        siblingId,
        siblingDraft.revision,
      );
      expect(siblingDeletion.status).toBe('QUEUED');
      expect(siblingDeletion.removedWorkflowRunIds).toContain(sibling);
      expect(siblingDeletion.removedWorkflowRunIds).not.toContain(retiredLegacy);
      expect(siblingDeletion.removedWorkflowRunIds).not.toContain(fill);
      await expect(
        db.workflowRun.update({
          where: { id: retiredLegacy },
          data: { currentNodeId: 'TEMPLATE_MIX' },
        }),
      ).rejects.toThrow('EFFECT_TEMPLATE_DELETED');
      // Project deletion can still detach provenance parent links after this template cleanup.
      // This optional project-cleanup compatibility field is unrelated to template deletion.
      // Add it only inside the isolated schema if that feature has not been migrated yet.
      await db.$executeRaw`ALTER TABLE projects ADD COLUMN IF NOT EXISTS "deletionState" varchar(20)`;
      await db.$executeRaw`UPDATE projects SET "deletionState" = 'QUEUED' WHERE id = ${projectId}::uuid`;
      await expect(
        db.workflowRun.updateMany({ where: { projectId }, data: { parentWorkflowRunId: null } }),
      ).resolves.toBeDefined();
      service.onModuleDestroy();
    } finally {
      await db?.$disconnect();
      if (!/^template_delete_test_[a-f0-9]{32}$/.test(schema))
        throw new Error('INVALID_TEST_SCHEMA');
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  },
  120_000,
);

it.skipIf(process.env.EFFECT_TEMPLATE_DELETE_DATABASE_TEST !== '1')(
  'unlinks real Redis projections without touching siblings or other workflows',
  async () => {
    const namespace = `test:template-delete:${randomUUID()}`;
    const projectId = randomUUID(),
      siblingId = randomUUID();
    const config = new ConfigService({
      REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379',
      EFFECT_READ_CACHE_NAMESPACE: namespace,
      EFFECT_READ_CACHE_TIMEOUT_MS: 1000,
    });
    const redis = new RedisConnectionService(config);
    const keys = [
      `${namespace}:${projectId}:EFFECT:run:mix:key`,
      `${namespace}:${projectId}:EFFECT:run:tree:key`,
      `${namespace}:${projectId}:CUSTOMIZED:run:overview:key`,
      `${namespace}:${siblingId}:EFFECT:run:mix:key`,
    ];
    try {
      for (const key of keys)
        await redis.execute((client) => client.set(key, 'fixture', { EX: 60 }));
      await new RealDeletionCache(redis, config).clear(projectId);
      const values = await Promise.all(
        keys.map((key) => redis.execute((client) => client.get(key))),
      );
      expect(values).toEqual([null, null, 'fixture', 'fixture']);
    } finally {
      for (const key of keys)
        await redis.execute((client) => client.del(key)).catch(() => undefined);
      await redis.onModuleDestroy();
    }
  },
);
