import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { expect, it, vi } from 'vitest';
import { emptyCustomizedBrief, type StoryboardInput } from '@ai-marketing/contracts';
import { PrismaService } from '../../../database/prisma.service';
import { WorkflowWorkingRepository } from '../../../platform/workflow/workflow-working.repository';
import { customizedScope } from '../../../platform/workflow/customized-branches';
import { workflowStateHash } from '../../../platform/workflow/workflow-state-hash';
import { StoryboardRepository } from './storyboard.repository';
import type { Prisma, CustomizedStoryboardTask } from '../../../generated/prisma/client';

it.skipIf(process.env.CUSTOMIZED_STORYBOARD_DATABASE_TEST !== '1')(
  'hard-deletes a script tree, preserves siblings/shared files, rejects late writes and retires empty batches',
  async () => {
    const db = new PrismaService(
      new ConfigService({
        DATABASE_URL:
          process.env.DATABASE_URL ??
          'postgresql://postgres:postgres@localhost:5432/ai_marketing?schema=public',
      }),
    );
    const working = new WorkflowWorkingRepository(db),
      repo = new StoryboardRepository(db, working);
    const projectId = randomUUID(),
      otherId = randomUUID();
    const target = repo as unknown as {
      enqueue(tx: Prisma.TransactionClient, t: CustomizedStoryboardTask): Promise<{ id: string }>;
    };
    const original = target.enqueue.bind(repo);
    const delivery = vi.spyOn(target, 'enqueue').mockImplementation(async (tx, t) => {
      const entry = await original(tx, t);
      return tx.jobOutbox.update({
        where: { id: entry.id },
        data: { status: 'PUBLISHED', publishedAt: new Date() },
      });
    });
    try {
      await db.project.createMany({
        data: [
          { id: projectId, name: '脚本永久删除隔离测试' },
          { id: otherId, name: '删除权限隔离测试' },
        ],
      });
      const root = await working.initializeCustomizedRun(projectId);
      const otherRoot = await working.initializeCustomizedRun(otherId);
      const brief = {
        ...emptyCustomizedBrief(),
        productName: '测试杯',
        sellingPoints: ['握持舒适'],
      };
      await db.workingArtifact.create({
        data: {
          projectId,
          workflowRunId: root.id,
          nodeId: 'INFORMATION_EXTRACTION',
          artifactKey: 'customized-brief',
          name: '信息卡',
          kind: 'STRUCTURED',
          directory: 'INSIGHTS',
          type: 'INSIGHT_RESULT',
          payload: brief,
          contentHash: workflowStateHash(brief),
        },
      });
      await repo.settings(
        projectId,
        root.id,
        0,
        {
          targetDurationSeconds: 30,
          variantCount: 2,
          structureMode: 'AI',
          structure: '',
          instructions: '',
        },
        null,
      );
      const task = await repo.create(projectId, root.id, 1, randomUUID(), {
        creative: 'controlled',
        detail: 'controlled',
      });
      // Explicit historical fixture: verifies old unmarked checkpoints still resume after V3 deployment.
      const historical = await db.customizedStoryboardTask.findUniqueOrThrow({
        where: { id: task.id },
      });
      const legacyInput = { ...(historical.inputSnapshot as unknown as StoryboardInput) };
      // Multi-script deletion remains supported for historical batches only.
      const prototype = await db.customizedStoryboardScript.findUniqueOrThrow({
        where: { id: legacyInput.scriptIds[0]! },
      });
      const historicalSiblingId = randomUUID();
      await db.customizedStoryboardScript.create({
        data: {
          id: historicalSiblingId,
          projectId,
          sourceRunId: prototype.sourceRunId,
          taskId: prototype.taskId,
          origin: prototype.origin,
          status: prototype.status,
          sourceSnapshot: prototype.sourceSnapshot as Prisma.InputJsonValue,
          draft: prototype.draft as Prisma.InputJsonValue,
        },
      });
      legacyInput.scriptIds.push(historicalSiblingId);
      legacyInput.settings = { ...legacyInput.settings, variantCount: 2 };
      delete legacyInput.graphVersion;
      delete legacyInput.routeId;
      delete legacyInput.strategyVersions;
      delete legacyInput.storyFormat;
      delete legacyInput.outputMode;
      await db.customizedStoryboardTask.update({
        where: { id: task.id },
        data: {
          inputSnapshot: JSON.parse(JSON.stringify(legacyInput)),
          inputHash: workflowStateHash(legacyInput),
        },
      });
      await db.customizedStoryboardStep.deleteMany({ where: { taskId: task.id } });
      await db.customizedStoryboardStep.createMany({
        data: [
          'SNAPSHOT',
          'CONCEPT',
          'STORY',
          'ASSETS',
          'SHOTS',
          'REVIEW',
          'REPAIR',
          'SAVE',
        ].flatMap((nodeId) =>
          (['SNAPSHOT', 'CONCEPT'].includes(nodeId) ? [''] : legacyInput.scriptIds).map(
            (scriptId) => ({ projectId, taskId: task.id, nodeId, scriptId, status: 'PENDING' }),
          ),
        ),
      });
      const claim = await repo.claim(projectId, task.id),
        token = claim.attemptToken!;
      const input = claim.input as unknown as StoryboardInput;
      const [firstId, siblingId] = input.scriptIds as [string, string];
      const run = (parent: string, label: string, forkScriptId: string | null = null) =>
        db.workflowRun.create({
          data: {
            ...customizedScope(projectId),
            parentWorkflowRunId: parent,
            activeKey: null,
            status: 'PAUSED',
            forkNodeId: forkScriptId ? 'STORYBOARD' : 'SHOT_PROMPT',
            forkScriptId,
            branchLabel: label,
            branchPublishedAt: new Date(),
          },
        });
      const first = await run(root.id, '待删除脚本', firstId),
        sibling = await run(root.id, '保留脚本', siblingId);
      const child = await run(first.id, '资产子分支'),
        grandchild = await run(child.id, '视频孙分支');
      for (const [id, r] of [
        [firstId, first],
        [siblingId, sibling],
      ] as const)
        await db.customizedStoryboardScript.update({
          where: { id },
          data: {
            workflowRunId: r.id,
            status: 'COMPLETED',
            draft: {
              id,
              name: r.branchLabel,
              synopsis: '测试',
              structure: '',
              productFocus: '',
              shots: [],
            },
          },
        });
      const makeArtifact = (r: string, key: string, storageKey?: string) =>
        db.workingArtifact.create({
          data: {
            projectId,
            workflowRunId: r,
            nodeId: 'SHOT_PROMPT',
            artifactKey: key,
            name: key,
            kind: storageKey ? 'FILE' : 'STRUCTURED',
            directory: 'INSIGHTS',
            type: 'INSIGHT_RESULT',
            payload: { content: key },
            storageKey: storageKey ?? null,
            contentHash: workflowStateHash(key),
          },
        });
      const deletedArtifact = await makeArtifact(first.id, `customized-script:${firstId}`);
      const childArtifact = await makeArtifact(child.id, 'customized-object:cup');
      const retainedArtifact = await makeArtifact(sibling.id, `customized-script:${siblingId}`);
      const historyKey = `test/${projectId}/history.png`;
      await db.workingArtifactRevisionSnapshot.create({
        data: {
          projectId,
          workflowRunId: grandchild.id,
          workingArtifactId: childArtifact.id,
          nodeId: 'SHOT_RENDER',
          artifactKey: 'history',
          revision: 1,
          contentHash: workflowStateHash('history'),
          snapshot: { storageKey: historyKey },
        },
      });
      const makeFile = (key: string) =>
        db.fileObject.create({
          data: {
            projectId,
            workflowRunId: child.id,
            nodeId: 'SHOT_PROMPT',
            originalFileName: 'test.png',
            mimeType: 'image/png',
            sizeBytes: 1,
            sha256: 'a'.repeat(64),
            storageKey: key,
          },
        });
      const exclusiveKey = `test/${projectId}/exclusive.png`,
        sharedKey = `test/${projectId}/shared.png`;
      const exclusive = await makeFile(exclusiveKey),
        shared = await makeFile(sharedKey);
      await db.workingArtifactFile.createMany({
        data: [
          {
            projectId,
            workflowRunId: child.id,
            workingArtifactId: childArtifact.id,
            fileObjectId: exclusive.id,
            role: 'PRIMARY',
          },
          {
            projectId,
            workflowRunId: sibling.id,
            workingArtifactId: retainedArtifact.id,
            fileObjectId: shared.id,
            role: 'PRIMARY',
          },
        ],
      });
      await db.workflowNodeState.create({
        data: {
          projectId,
          workflowRunId: grandchild.id,
          nodeId: 'SHOT_RENDER',
          state: { draft: '待删除内容' },
          contentHash: workflowStateHash('draft'),
        },
      });
      const production = await db.customizedProductionTask.create({
        data: {
          projectId,
          workflowRunId: grandchild.id,
          operation: 'SHOTS',
          idempotencyKey: randomUUID(),
          status: 'RUNNING',
          inputSnapshot: {},
          steps: [],
          attemptToken: randomUUID(),
          leaseExpiresAt: new Date(Date.now() + 60000),
        },
      });
      await db.jobOutbox.create({
        data: {
          projectId,
          jobType: 'CUSTOMIZED_PRODUCTION',
          aggregateId: production.id,
          routingKey: 'customized.production.requested',
          payload: {},
          status: 'PUBLISHED',
          publishedAt: new Date(),
        },
      });
      const archiveKey = `test/${projectId}/archived.png`;
      const asset = await db.asset.create({
        data: {
          projectId,
          name: '归档资产',
          directory: 'INSIGHTS',
          type: 'INSIGHT_RESULT',
          storageWorkflow: 'CUSTOMIZED',
          workflowSpace: 'CUSTOMIZED_PROJECT',
          sourceRunId: child.id,
          sourceArtifactId: childArtifact.id,
          originalFileName: 'test.png',
          mimeType: 'image/png',
          sizeBytes: 1,
          storageKey: archiveKey,
        },
      });
      await db.assetVersion.create({
        data: {
          projectId,
          assetId: asset.id,
          version: 1,
          changeNote: '测试',
          status: 'AVAILABLE',
          qualityStatus: 'AVAILABLE',
          originalFileName: 'test.png',
          mimeType: 'image/png',
          sizeBytes: 1,
          storageKey: archiveKey,
        },
      });
      await db.workflowRun.update({
        where: { id: root.id },
        data: { activeKey: null, status: 'PAUSED' },
      });
      await db.workflowRun.update({
        where: { id: grandchild.id },
        data: { activeKey: 'ACTIVE', status: 'ACTIVE' },
      });
      const concepts = {
        concepts: input.scriptIds.map((scriptId) => ({
          scriptId,
          name: '测试方案',
          synopsis: '测试内容',
          productFocus: '握持',
          structure: '日常',
          difference: '不同事件',
          coreIdea: '隔离删除测试中的方案',
          openingHook: '拿起杯子',
          productRole: '完成日常喝水动作',
          memoryPoint: '圆润把手',
        })),
      };
      await repo.step(projectId, task.id, token, {
        nodeId: 'CONCEPT',
        scriptId: '',
        status: 'SUCCEEDED',
        output: concepts,
        errorMessage: null,
      });
      const old = await db.customizedStoryboardScript.findUniqueOrThrow({ where: { id: firstId } });
      await expect(repo.remove(otherId, firstId, otherRoot.id, old.revision)).rejects.toThrow(
        '脚本已删除或不存在',
      );
      await expect(repo.remove(projectId, firstId, root.id, old.revision + 1)).rejects.toThrow(
        '其他窗口',
      );
      expect(await db.workflowRun.count({ where: { projectId } })).toBe(5);
      const result = await repo.remove(projectId, firstId, root.id, old.revision);
      expect(result.removedRunIds.sort()).toEqual([first.id, child.id, grandchild.id].sort());
      expect(result.activeRunChanged).toBe(true);
      expect(result.fallbackRunId).toBe(root.id);
      expect(await db.workflowRun.count({ where: { projectId } })).toBe(2);
      expect((await db.workflowRun.findUniqueOrThrow({ where: { id: root.id } })).activeKey).toBe(
        'ACTIVE',
      );
      const removedScope = { projectId, workflowRunId: { in: result.removedRunIds } };
      expect(await db.workingArtifact.count({ where: removedScope })).toBe(0);
      expect(await db.workingArtifactRevisionSnapshot.count({ where: removedScope })).toBe(0);
      expect(await db.workflowNodeState.count({ where: removedScope })).toBe(0);
      expect(await db.customizedProductionTask.count({ where: removedScope })).toBe(0);
      expect(await db.jobOutbox.count({ where: { projectId, aggregateId: production.id } })).toBe(
        0,
      );
      expect(await db.asset.count({ where: { projectId, id: asset.id } })).toBe(0);
      expect(await db.assetVersion.count({ where: { projectId, assetId: asset.id } })).toBe(0);
      expect(await db.fileObject.findUnique({ where: { id: exclusive.id } })).toBeNull();
      expect(
        (await db.fileObject.findUniqueOrThrow({ where: { id: shared.id } })).workflowRunId,
      ).toBe(root.id);
      expect(await db.workingArtifact.findUnique({ where: { id: deletedArtifact.id } })).toBeNull();
      expect(
        await db.workingArtifact.findUnique({ where: { id: retainedArtifact.id } }),
      ).not.toBeNull();
      expect(
        (await db.storageCleanupTask.findMany({ where: { projectId } }))
          .map((v) => v.storageKey)
          .sort(),
      ).toEqual([exclusiveKey, archiveKey, historyKey].sort());
      expect((await repo.task(projectId, task.id)).inputSnapshot).toMatchObject({
        scriptIds: [siblingId],
        settings: { variantCount: 1 },
      });
      expect(
        await db.customizedStoryboardStep.count({ where: { projectId, scriptId: firstId } }),
      ).toBe(0);
      await repo.step(projectId, task.id, token, {
        nodeId: 'CONCEPT',
        scriptId: '',
        status: 'SUCCEEDED',
        output: concepts,
        errorMessage: null,
      });
      expect(
        await repo.step(projectId, task.id, token, {
          nodeId: 'STORY',
          scriptId: firstId,
          status: 'RUNNING',
          output: null,
          errorMessage: null,
        }),
      ).toMatchObject({ removed: true });
      expect(
        await repo.completeScript(projectId, task.id, token, old.draft as never),
      ).toMatchObject({ removed: true });
      expect(await db.customizedStoryboardScript.findUnique({ where: { id: firstId } })).toBeNull();
      await repo.finish(projectId, task.id, token);
      expect((await repo.task(projectId, task.id)).status).toBe('COMPLETED');
      await expect(repo.remove(projectId, firstId, root.id, old.revision)).rejects.toThrow(
        '已删除',
      );
      const remaining = await db.customizedStoryboardScript.findUniqueOrThrow({
        where: { id: siblingId },
      });
      await repo.remove(projectId, siblingId, root.id, remaining.revision);
      expect(await db.customizedStoryboardTask.count({ where: { projectId } })).toBe(0);
      expect(await db.customizedStoryboardStep.count({ where: { projectId } })).toBe(0);
      expect(await db.customizedStoryboardScript.count({ where: { projectId } })).toBe(0);
      expect(await db.workflowRun.count({ where: { projectId } })).toBe(1);
      expect(await db.fileObject.findUnique({ where: { id: shared.id } })).toBeNull();
      expect(
        await db.storageCleanupTask.count({ where: { projectId, storageKey: sharedKey } }),
      ).toBe(1);
      expect(await db.jobOutbox.count({ where: { projectId } })).toBe(0);
      await expect(repo.heartbeat(projectId, task.id, token)).rejects.toThrow();
    } finally {
      delivery.mockRestore();
      await db.assetVersion.deleteMany({ where: { projectId } });
      await db.asset.deleteMany({ where: { projectId } });
      await db.workingArtifactDependency.deleteMany({ where: { projectId } });
      await db.project.deleteMany({ where: { id: { in: [projectId, otherId] } } });
      await db.$disconnect();
    }
  },
  90000,
);
