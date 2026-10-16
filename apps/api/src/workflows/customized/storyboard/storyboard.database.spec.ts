import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { expect, it, vi } from 'vitest';
import {
  emptyCustomizedBrief,
  type CustomizedStoryboardScript,
  type StoryboardInput,
  type StoryboardStage,
} from '@ai-marketing/contracts';
import { PrismaService } from '../../../database/prisma.service';
import { WorkflowWorkingRepository } from '../../../platform/workflow/workflow-working.repository';
import { workflowStateHash } from '../../../platform/workflow/workflow-state-hash';
import type { Prisma, CustomizedStoryboardTask } from '../../../generated/prisma/client';
import { StoryboardRepository } from './storyboard.repository';

const jsonFixture = (value: unknown) => value as Prisma.InputJsonValue;

const script = (id: string): CustomizedStoryboardScript => ({
  id,
  name: '归家的一杯',
  synopsis: '在真实日常中呈现产品',
  structure: '归家、倒水、落座',
  productFocus: '握持舒适',
  assets: [{ id: 'cup', kind: 'products', name: '陶瓷杯', description: '未知颜色，允许设计' }],
  shots: [
    {
      id: 'shot1',
      title: '倒水',
      shotType: '特写',
      cameraMovement: '固定',
      durationSeconds: 30,
      visual: '手握陶瓷杯倒入温水。',
      dialogues: [],
      audio: '倒水声',
      continuity: '杯子外观一致',
      assetRequirements: {
        characters: { state: 'NONE', items: [] },
        scenes: { state: 'NONE', items: [] },
        products: { state: 'DEFINED', items: [{ assetId: 'cup', description: '杯身朝向镜头' }] },
      },
    },
  ],
});

it.skipIf(process.env.CUSTOMIZED_STORYBOARD_DATABASE_TEST !== '1')(
  'publishes siblings independently and preserves revisions, leases, edits and recovery',
  async () => {
    const db = new PrismaService(
      new ConfigService({
        DATABASE_URL:
          process.env.DATABASE_URL ??
          'postgresql://postgres:postgres@localhost:5432/ai_marketing?schema=public',
      }),
    );
    const working = new WorkflowWorkingRepository(db),
      repo = new StoryboardRepository(db, working),
      projectId = randomUUID(),
      otherId = randomUUID();
    const target = repo as unknown as {
      enqueue(tx: Prisma.TransactionClient, t: CustomizedStoryboardTask): Promise<{ id: string }>;
    };
    const enqueue = target.enqueue.bind(repo);
    const delivery = vi.spyOn(target, 'enqueue').mockImplementation(async (tx, t) => {
      const entry = await enqueue(tx, t);
      return tx.jobOutbox.update({
        where: { id: entry.id },
        data: { status: 'PUBLISHED', publishedAt: new Date() },
      });
    });
    const originalCreate = repo.create.bind(repo);
    const legacyCreate = vi.spyOn(repo, 'create').mockImplementation(async (...args) => {
      const task = await originalCreate(...args);
      const row = await db.customizedStoryboardTask.findUniqueOrThrow({ where: { id: task.id } });
      const input = { ...(row.inputSnapshot as Record<string, unknown>) };
      delete input.outputMode;
      delete input.storyFormat;
      await db.customizedStoryboardTask.update({
        where: { id: row.id },
        data: { inputSnapshot: input as Prisma.InputJsonValue },
      });
      return task;
    });
    try {
      await db.project.createMany({
        data: [
          { id: projectId, name: '分镜独立分支隔离测试' },
          { id: otherId, name: '分镜跨项目测试' },
        ],
      });
      const root = await working.initializeCustomizedRun(projectId),
        brief = { ...emptyCustomizedBrief(), productName: '陶瓷杯', sellingPoints: ['握持舒适'] };
      const source = await db.workingArtifact.create({
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
      const models = { creative: 'controlled-pro', detail: 'controlled-turbo' },
        key = randomUUID();
      const [a, b] = await Promise.all([
        repo.create(projectId, root.id, 0, key, models),
        repo.create(projectId, root.id, 0, key, models),
      ]);
      expect(a.id).toBe(b.id);
      expect(await db.jobOutbox.count({ where: { projectId, status: 'PENDING' } })).toBe(0);
      await expect(repo.task(otherId, a.id)).rejects.toThrow();
      // Explicit historical fixture: verifies old unmarked checkpoints still resume after V3 deployment.
      const historical = await db.customizedStoryboardTask.findUniqueOrThrow({
        where: { id: a.id },
      });
      const legacyInput = { ...(historical.inputSnapshot as unknown as StoryboardInput) };
      // New commands create one; explicitly construct a historical three-script batch.
      expect(legacyInput.scriptIds).toHaveLength(1);
      const prototype = await db.customizedStoryboardScript.findUniqueOrThrow({ where: { id: legacyInput.scriptIds[0]! } });
      const siblings = [randomUUID(), randomUUID()];
      await db.customizedStoryboardScript.createMany({ data: siblings.map((id) => ({ id, projectId, sourceRunId: prototype.sourceRunId, taskId: prototype.taskId, origin: prototype.origin, status: prototype.status, sourceSnapshot: jsonFixture(prototype.sourceSnapshot), draft: jsonFixture(prototype.draft) })) });
      legacyInput.scriptIds.push(...siblings);
      legacyInput.settings = { ...legacyInput.settings, variantCount: 3 };
      delete legacyInput.graphVersion;
      delete legacyInput.routeId;
      delete legacyInput.strategyVersions;
      delete legacyInput.storyFormat;
      delete legacyInput.outputMode;
      await db.customizedStoryboardTask.update({
        where: { id: a.id },
        data: {
          inputSnapshot: JSON.parse(JSON.stringify(legacyInput)),
          inputHash: workflowStateHash(legacyInput),
        },
      });
      await db.customizedStoryboardStep.deleteMany({ where: { taskId: a.id } });
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
            (scriptId) => ({ projectId, taskId: a.id, nodeId, scriptId, status: 'PENDING' }),
          ),
        ),
      });
      const claim = await repo.claim(projectId, a.id),
        token = claim.attemptToken!,
        input = claim.input as unknown as StoryboardInput;
      expect(await repo.claim(projectId, a.id)).toEqual({ busy: true });
      const step = (
        nodeId: StoryboardStage,
        scriptId: string,
        output: unknown,
        status: 'SUCCEEDED' | 'SKIPPED' = 'SUCCEEDED',
        attempt = token,
      ) =>
        repo.step(projectId, a.id, attempt, {
          nodeId,
          scriptId,
          output,
          status,
          errorMessage: null,
        });
      await expect(repo.heartbeat(projectId, a.id, '')).rejects.toThrow();
      await step('SNAPSHOT', '', { source: input.source });
      await step('CONCEPT', '', {
        concepts: input.scriptIds.map((id) => ({
          scriptId: id,
          name: '方案',
          synopsis: '故事',
          productFocus: '握持',
          structure: '日常',
          difference: '不同观看事件',
        })),
      });
      const prepare = async (id: string, attempt = token) => {
        await step(
          'STORY',
          id,
          {
            title: '故事',
            content: '归家倒水',
            opening: '归家',
            development: '倒水',
            ending: '落座',
            dialoguePlan: '无对白',
            beats: [{ id: 'beat1', content: '归家倒水', durationSeconds: 30 }],
          },
          'SUCCEEDED',
          attempt,
        );
        await step('ASSETS', id, { assets: script(id).assets }, 'SUCCEEDED', attempt);
        await step('SHOTS', id, script(id), 'SUCCEEDED', attempt);
        await step(
          'REVIEW',
          id,
          { summary: '事实、连贯性与引用检查通过', findings: [] },
          'SUCCEEDED',
          attempt,
        );
        await step('REPAIR', id, { reason: '无需修订' }, 'SKIPPED', attempt);
      };
      await prepare(input.scriptIds[0]!);
      const first = await repo.completeScript(projectId, a.id, token, script(input.scriptIds[0]!));
      expect((await repo.workspace(projectId, root.id)).scripts).toHaveLength(1);
      expect((await repo.task(projectId, a.id)).status).toBe('RUNNING');
      expect(
        await repo.completeScript(projectId, a.id, token, script(input.scriptIds[0]!)),
      ).toEqual({ ...first, unchanged: true });
      await repo.finish(projectId, a.id, token);
      expect((await repo.task(projectId, a.id)).status).toBe('PARTIAL');
      await repo.retry(projectId, a.id);
      const resumed = await repo.claim(projectId, a.id);
      expect(resumed.completedScriptIds).toEqual([input.scriptIds[0]]);
      await expect(repo.heartbeat(projectId, a.id, token)).rejects.toThrow();
      for (const id of input.scriptIds.slice(1)) {
        await prepare(id, resumed.attemptToken!);
        await repo.completeScript(projectId, a.id, resumed.attemptToken!, script(id));
      }
      await repo.finish(projectId, a.id, resumed.attemptToken!);
      const workspace = await repo.workspace(projectId, root.id);
      expect(workspace.task?.progress).toBe(100);
      expect(workspace.scripts).toHaveLength(3);
      const branches = await db.workflowRun.findMany({
        where: { projectId, forkNodeId: 'STORYBOARD' },
      });
      expect(branches.every((r) => r.parentWorkflowRunId === root.id)).toBe(true);
      expect(new Set(branches.map((r) => r.forkScriptId)).size).toBe(3);
      const record = workspace.scripts[0]!,
        originalRevision = record.confirmedRevision;
      const begin = (await repo.edit(projectId, record.id, 'begin', record.revision)) as {
        revision: number;
      };
      const changed = { ...record.script, name: '人工修改' };
      const savedDraft = (await repo.edit(
        projectId,
        record.id,
        'draft',
        begin.revision,
        changed,
      )) as { revision: number };
      expect(
        (
          await db.workingArtifact.findFirstOrThrow({
            where: { projectId, artifactKey: `customized-script:${record.id}` },
          })
        ).revision,
      ).toBe(originalRevision);
      await expect(
        repo.edit(projectId, record.id, 'save', begin.revision, changed),
      ).rejects.toThrow();
      await repo.edit(projectId, record.id, 'cancel', savedDraft.revision);
      const restored = (await repo.workspace(projectId, root.id)).scripts[0]!;
      expect(restored.script.name).toBe(record.script.name);
      const unchangedBegin = (await repo.edit(
        projectId,
        record.id,
        'begin',
        restored.revision,
      )) as { revision: number };
      await repo.edit(projectId, record.id, 'save', unchangedBegin.revision, record.script);
      expect((await repo.workspace(projectId, root.id)).scripts[0]!.confirmedRevision).toBe(
        originalRevision,
      );
      const current = (await repo.workspace(projectId, root.id)).scripts[0]!;
      const actualBegin = (await repo.edit(projectId, record.id, 'begin', current.revision)) as {
        revision: number;
      };
      await repo.edit(projectId, record.id, 'save', actualBegin.revision, changed);
      expect((await repo.workspace(projectId, root.id)).scripts[0]!.confirmedRevision).toBe(
        originalRevision! + 1,
      );
      expect(
        await db.workingArtifactRevisionSnapshot.count({
          where: { projectId, nodeId: 'STORYBOARD', artifactKey: `customized-script:${record.id}` },
        }),
      ).toBe(2);
      expect(await db.workflowRun.count({ where: { projectId, forkNodeId: 'STORYBOARD' } })).toBe(
        3,
      );
      const again = await repo.create(projectId, root.id, 0, randomUUID(), models);
      const secondClaim = await repo.claim(projectId, again.id);
      const resumedScriptId = (secondClaim.input as unknown as StoryboardInput).scriptIds[0]!;
      const partialChunks = { chunks: [{ shots: script(resumedScriptId).shots }] };
      await repo.step(projectId, again.id, secondClaim.attemptToken!, {
        nodeId: 'BRAND_AD_STORY',
        scriptId: resumedScriptId,
        status: 'RUNNING',
        output: partialChunks,
        errorMessage: null,
      });
      await db.customizedStoryboardTask.update({
        where: { id: again.id },
        data: { leaseExpiresAt: new Date(0) },
      });
      await repo.recoverExpired();
      expect((await repo.task(projectId, again.id)).status).toBe('QUEUED');
      const recoveredStep = (await repo.task(projectId, again.id)).steps.find(
        (s) => s.nodeId === 'BRAND_AD_STORY' && s.scriptId === resumedScriptId,
      );
      expect(recoveredStep?.status).toBe('PENDING');
      expect(recoveredStep?.output).toEqual(partialChunks);
      const nextAttempt = await repo.claim(projectId, again.id);
      expect(nextAttempt.attemptToken).not.toBe(secondClaim.attemptToken);
      await expect(
        repo.heartbeat(projectId, again.id, secondClaim.attemptToken!),
      ).rejects.toThrow();
      await repo.step(projectId, again.id, nextAttempt.attemptToken!, {
        nodeId: 'BRAND_AD_STORY',
        scriptId: resumedScriptId,
        status: 'FAILED',
        output: null,
        errorMessage: '服务暂时不可用',
      });
      await repo.finish(projectId, again.id, nextAttempt.attemptToken!, {
        retryable: true,
        retryScriptIds: [resumedScriptId],
      });
      expect((await repo.task(projectId, again.id)).status).toBe('QUEUED');
      const scheduled = await db.jobOutbox.findFirstOrThrow({
        where: { projectId, aggregateId: again.id },
      });
      expect(scheduled.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 25000);
      await repo.finish(projectId, again.id, nextAttempt.attemptToken!, { retryable: true });
      expect(
        (await db.jobOutbox.findUniqueOrThrow({ where: { id: scheduled.id } })).nextAttemptAt,
      ).toEqual(scheduled.nextAttemptAt);
      const lastAttempt = await repo.claim(projectId, again.id);
      expect(lastAttempt.retryScriptIds).toEqual([resumedScriptId]);
      expect(
        lastAttempt.checkpoints?.find((s) => s.nodeId === 'BRAND_AD_STORY' && s.scriptId === resumedScriptId)
          ?.output,
      ).toEqual(partialChunks);
      await repo.finish(projectId, again.id, lastAttempt.attemptToken!, {
        retryable: true,
        retryScriptIds: [resumedScriptId],
      });
      expect((await repo.task(projectId, again.id)).status).toBe('FAILED');
      await repo.retry(projectId, again.id, true);
      await expect(
        repo.heartbeat(projectId, again.id, secondClaim.attemptToken!),
      ).rejects.toThrow();
      expect((await repo.workspace(projectId, root.id)).scripts).toHaveLength(3);
      for (const productName of ['第二轮信息', '第三轮信息']) {
        const queued = await repo.create(projectId, root.id, 0, randomUUID(), models);
        await working.commitValidatedArtifacts(projectId, root.id, 'INFORMATION_EXTRACTION', [
          {
            artifactKey: 'customized-brief',
            input: {
              kind: 'STRUCTURED',
              name: '信息卡',
              directory: 'INSIGHTS',
              type: 'INSIGHT_RESULT',
              payload: { ...brief, productName },
            },
          },
        ]);
        expect(await repo.claim(projectId, queued.id)).toEqual({ terminal: true });
        expect((await repo.task(projectId, queued.id)).status).toBe('FAILED');
        expect((await repo.workspace(projectId, root.id)).scripts.every((s) => s.stale)).toBe(true);
        await expect(repo.retry(projectId, again.id)).rejects.toThrow();
      }
      expect(
        (await db.workingArtifact.findUniqueOrThrow({ where: { id: source.id } })).revision,
      ).toBe(3);
      const blank = { ...script(randomUUID()), name: '', synopsis: '', shots: [], assets: [] };
      const manual = await repo.manual(projectId, root.id, blank, 'MANUAL');
      expect(manual.workflowRunId).toBeNull();
      await expect(
        repo.edit(projectId, manual.id, 'save', manual.revision, blank),
      ).rejects.toThrow();
      await repo.edit(projectId, manual.id, 'discard', manual.revision);
      expect(await db.customizedStoryboardScript.count({ where: { id: manual.id } })).toBe(0);
      const imported = script(randomUUID());
      const importRecord = await repo.manual(projectId, root.id, imported, 'IMPORT');
      const publishedImport = (await repo.edit(
        projectId,
        imported.id,
        'save',
        importRecord.revision,
        imported,
      )) as { workflowRunId: string };
      expect(publishedImport.workflowRunId).toBeTruthy();
      expect(
        (await repo.workspace(projectId, publishedImport.workflowRunId)).selectedScriptId,
      ).toBe(imported.id);
      // Viewing preferences belong to the collection, not to its active branch.
      const beforeBrowsing = await db.workflowRun.findMany({ where: { projectId } });
      const beforeArtifacts = await db.workingArtifact.findMany({ where: { projectId } });
      const collection = await repo.workspace(projectId, root.id);
      const preferenceRevision = await repo.settings(
        projectId,
        root.id,
        collection.settingsRevision,
        collection.settings,
        workspace.scripts[1]!.id,
      );
      expect(
        (await repo.workspace(projectId, publishedImport.workflowRunId)).selectedScriptId,
      ).toBe(workspace.scripts[1]!.id);
      expect((await repo.workspace(projectId, root.id)).selectedScriptId).toBe(
        workspace.scripts[1]!.id,
      );
      expect(
        await repo.settings(
          projectId,
          root.id,
          preferenceRevision,
          collection.settings,
          workspace.scripts[1]!.id,
        ),
      ).toBe(preferenceRevision);
      expect(await db.workflowRun.findMany({ where: { projectId } })).toEqual(beforeBrowsing);
      expect(await db.workingArtifact.findMany({ where: { projectId } })).toEqual(beforeArtifacts);
      expect(await db.workflowRun.count({ where: { projectId, forkNodeId: 'STORYBOARD' } })).toBe(
        4,
      );
    } finally {
      delivery.mockRestore();
      legacyCreate.mockRestore();
      await db.workingArtifactDependency.deleteMany({ where: { projectId } });
      await db.project.deleteMany({ where: { id: { in: [projectId, otherId] } } });
      await db.$disconnect();
    }
  },
  90000,
);
