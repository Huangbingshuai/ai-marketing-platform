import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { it, expect, vi } from 'vitest';
import {
  emptyCustomizedBrief,
  type CustomizedStoryboardScript,
  type ProductionDocument,
} from '@ai-marketing/contracts';
import { PrismaService } from '../../../database/prisma.service';
import { WorkflowWorkingRepository } from '../../../platform/workflow/workflow-working.repository';
import { workflowStateHash } from '../../../platform/workflow/workflow-state-hash';
import { StoryboardRepository } from '../storyboard/storyboard.repository';
import { ProductionRepository } from './production.repository';
import type { Prisma, CustomizedProductionTask } from '../../../generated/prisma/client';

it.skipIf(process.env.CUSTOMIZED_PRODUCTION_DATABASE_TEST !== '1')(
  'isolates scripts and tasks; fences edits, cancellation, stale sources and per-shot prompt updates',
  async () => {
    const db = new PrismaService(
      new ConfigService({
        DATABASE_URL:
          process.env.DATABASE_URL ??
          'postgresql://postgres:postgres@localhost:5432/ai_marketing?schema=public',
      }),
    );
    const p = randomUUID(),
      other = randomUUID(),
      working = new WorkflowWorkingRepository(db),
      stories = new StoryboardRepository(db, working),
      repo = new ProductionRepository(db, working);
    const target = repo as unknown as {
      enqueue(
        tx: Prisma.TransactionClient,
        t: CustomizedProductionTask,
        delay?: number,
      ): Promise<{ id: string }>;
    };
    const original = target.enqueue.bind(repo);
    const delivery = vi.spyOn(target, 'enqueue').mockImplementation(async (tx, t, delay) => {
      const e = await original(tx, t, delay);
      return tx.jobOutbox.update({
        where: { id: e.id },
        data: { status: 'PUBLISHED', publishedAt: new Date() },
      });
    });
    try {
      await db.project.createMany({
        data: [
          { id: p, name: '制作节点隔离测试' },
          { id: other, name: '制作跨项目测试' },
        ],
      });
      const root = await working.initializeCustomizedRun(p),
        brief = { ...emptyCustomizedBrief(), productName: '陶瓷杯', sellingPoints: ['陶瓷材质'] };
      await db.workingArtifact.create({
        data: {
          projectId: p,
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
      const script: CustomizedStoryboardScript = {
        id: randomUUID(),
        name: '清晨',
        synopsis: '开窗倒水后阅读',
        structure: '开窗、倒水、阅读',
        productFocus: '陶瓷杯',
        shots: [],
        assets: [],
        story: {
          content: '开窗后倒水，坐下阅读。',
          opening: '开窗',
          development: '倒水',
          ending: '阅读',
          dialoguePlan: '无对白',
          beats: [{ id: 'b1', content: '完整故事', durationSeconds: 30 }],
        },
      };
      const storyQueue = stories as unknown as {
        enqueue(tx: Prisma.TransactionClient, t: CustomizedProductionTask): Promise<{ id: string }>;
      };
      vi.spyOn(storyQueue, 'enqueue').mockImplementation(async () => ({ id: randomUUID() }));
      await stories.settings(p, root.id, 0, {
        targetDurationSeconds: 30,
        variantCount: 1,
        structureMode: 'AI',
        structure: '历史自定义结构，不应进入 AI 输入',
        instructions: '',
      });
      const storyTask = await stories.create(p, root.id, 1, randomUUID(), {
        creative: 'controlled',
        detail: 'controlled',
      });
      const storyClaim = await stories.claim(p, storyTask.id);
      const storyInput = storyClaim.input as unknown as {
        outputMode: string;
        scriptIds: string[];
        source: unknown;
        settings: { structure: string };
      };
      expect(storyInput.outputMode).toBe('STORY_ONLY');
      expect(storyInput.settings.structure).toBe('');
      const generated = {
        ...script,
        id: storyInput.scriptIds[0]!,
        story: { ...script.story!, title: '清晨' },
      };
      for (const [nodeId, scriptId, output, status] of [
        ['SNAPSHOT', '', { source: storyInput.source }, 'SUCCEEDED'],
        [
          'CONCEPT',
          '',
          {
            concepts: storyInput.scriptIds.map((id) => ({
              scriptId: id,
              name: '清晨',
              synopsis: '倒水阅读',
              productFocus: '陶瓷',
              structure: '日常',
              difference: '日常体验',
            })),
          },
          'SUCCEEDED',
        ],
        ['STORY', generated.id, generated.story, 'SUCCEEDED'],
        ['REVIEW', generated.id, { summary: '事实及完整性通过', findings: [] }, 'SUCCEEDED'],
        ['REPAIR', generated.id, { reason: '无需修订' }, 'SKIPPED'],
      ] as const)
        await stories.step(p, storyTask.id, storyClaim.attemptToken!, {
          nodeId,
          scriptId,
          output,
          status,
          errorMessage: null,
        });
      await stories.completeScript(p, storyTask.id, storyClaim.attemptToken!, generated);
      await stories.finish(p, storyTask.id, storyClaim.attemptToken!);
      expect((await stories.workspace(p, root.id)).scripts[0]!.script.shots).toHaveLength(0);
      expect(
        (await stories.task(p, storyTask.id)).steps.some(
          (s) => s.nodeId === 'SHOTS' || s.nodeId === 'ASSETS',
        ),
      ).toBe(false);
      const manual = await stories.manual(p, root.id, script, 'MANUAL');
      const published = (await stories.edit(p, script.id, 'save', manual.revision, script)) as {
        workflowRunId: string;
      };
      const r = published.workflowRunId,
        initial = await repo.workspace(p, r);
      expect(initial.sourceReady).toBe(true);
      expect(initial.document.shots).toHaveLength(0);
      await expect(repo.workspace(other, r)).rejects.toThrow();
      const doc: ProductionDocument = {
        assets: [
          {
            id: 'cup',
            kind: 'PRODUCT',
            name: '陶瓷杯',
            description: '陶瓷杯',
            knownFacts: '陶瓷',
            designNotes: '颜色待设计',
            sourceText: '简报',
          },
          {
            id: 'room',
            kind: 'SCENE',
            name: '阅读室',
            description: '窗边阅读区',
            knownFacts: '',
            designNotes: '木桌与书架',
            sourceText: '故事',
          },
        ],
        shots: [],
      };
      let revision = (await repo.save(p, r, 0, doc, 'ASSETS', true)).revision;
      const catalog = await db.workingArtifact.findFirstOrThrow({
        where: { projectId: p, artifactKey: 'customized-asset-catalog' },
      });
      await repo.save(p, r, revision, doc, 'ASSETS', true);
      expect(
        (await db.workingArtifact.findUniqueOrThrow({ where: { id: catalog.id } })).revision,
      ).toBe(catalog.revision);
      doc.shots = [
        {
          id: 's1',
          title: '倒水',
          durationSeconds: 15,
          shotType: '特写',
          cameraMovement: '固定',
          visual: '水倒入陶瓷杯',
          dialogue: '',
          audio: '水声',
          atmosphere: '清晨',
          bindings: [{ assetId: 'cup', description: '杯口' }],
        },
        {
          id: 's2',
          title: '阅读区',
          durationSeconds: 15,
          shotType: '全景',
          cameraMovement: '固定',
          visual: '窗边阅读区',
          dialogue: '',
          audio: '风声',
          atmosphere: '清晨',
          bindings: [{ assetId: 'room', description: '窗边' }],
        },
      ];
      revision = (await repo.save(p, r, revision, doc, 'SHOTS', true)).revision;
      const models = { creative: 'controlled', detail: 'controlled' },
        key = randomUUID();
      const t = await repo.start(p, r, revision, 'PROMPT', key, 's1', models);
      expect((await repo.start(p, r, revision, 'PROMPT', key, 's1', models)).id).toBe(t.id);
      await expect(repo.save(p, r, revision, doc, 'SHOTS', true)).rejects.toThrow();
      const claim = await repo.claim(p, t.id);
      expect(await repo.claim(p, t.id)).toEqual({ busy: true });
      await expect(repo.heartbeat(other, t.id, claim.attemptToken!)).rejects.toThrow();
      const output = {
        shotId: 's1',
        content: '固定特写，清晨光线中，水缓缓倒入陶瓷杯。',
        assetIds: ['cup'],
      };
      for (const id of ['SNAPSHOT', 'PLAN', 'GENERATE', 'REVIEW', 'REPAIR'])
        await repo.checkpoint(
          p,
          t.id,
          claim.attemptToken!,
          { id, status: 'SUCCEEDED', title: '实际内容', content: '读取与审校完成' },
          output,
        );
      await repo.complete(p, t.id, claim.attemptToken!, output);
      await repo.complete(p, t.id, claim.attemptToken!, output);
      expect((await repo.getTask(p, t.id)).progress).toBe(100);
      await repo.savePrompt(p, r, 0, {
        shotId: 's2',
        content: '全景，窗边阅读区。',
        assetIds: ['room'],
      });
      const before = await repo.workspace(p, r);
      expect(before.prompts.every((p) => !p.stale)).toBe(true);
      // A change to the cup invalidates its shot's prompt only, not the room shot.
      doc.assets[0]!.description = '陶瓷杯，外观待确认';
      revision = (await repo.save(p, r, revision, doc, 'ASSETS', true)).revision;
      const after = await repo.workspace(p, r);
      expect(after.prompts.find((v) => v.value.shotId === 's1')?.stale).toBe(true);
      expect(after.prompts.find((v) => v.value.shotId === 's2')?.stale).toBe(false);
      await expect(repo.savePrompt(p, r, 99, { ...output, content: '人工文字' })).rejects.toThrow();
      const canceled = await repo.start(p, r, revision, 'SHOTS', randomUUID(), null, models),
        lease = await repo.claim(p, canceled.id);
      await repo.action(p, canceled.id, true);
      await expect(repo.heartbeat(p, canceled.id, lease.attemptToken!)).rejects.toThrow();
      // Transient failures preserve checkpoints, issue a new lease, and never reuse the old token.
      const recovery = await repo.start(p, r, revision, 'ASSETS', randomUUID(), null, models);
      const firstLease = await repo.claim(p, recovery.id);
      await repo.checkpoint(p, recovery.id, firstLease.attemptToken!, {
        id: 'SNAPSHOT',
        status: 'SUCCEEDED',
        title: '创作依据',
        content: '清晨故事',
      });
      await repo.checkpoint(
        p,
        recovery.id,
        firstLease.attemptToken!,
        { id: 'PLAN', status: 'SUCCEEDED', title: '实体规划', content: '陶瓷杯与阅读室' },
        { plan: { summary: '已保存规划' } },
      );
      await repo.fail(p, recovery.id, firstLease.attemptToken!, true);
      expect((await repo.getTask(p, recovery.id)).status).toBe('QUEUED');
      const secondLease = await repo.claim(p, recovery.id);
      expect(secondLease.attemptToken).not.toBe(firstLease.attemptToken);
      expect(secondLease.output).toEqual({ plan: { summary: '已保存规划' } });
      await expect(repo.heartbeat(p, recovery.id, firstLease.attemptToken!)).rejects.toThrow();
      const catalogResult = { assets: doc.assets, shots: [] };
      for (const id of ['GENERATE', 'REVIEW', 'REPAIR'])
        await repo.checkpoint(
          p,
          recovery.id,
          secondLease.attemptToken!,
          { id, status: 'SUCCEEDED', title: '实际结果', content: '目录与依据已核对' },
          { final: catalogResult },
        );
      await repo.complete(p, recovery.id, secondLease.attemptToken!, catalogResult);
      expect((await repo.workspace(p, r)).document.shots).toHaveLength(2);
      // A second object change must now affect only its dependent prompt.
      doc.assets[1]!.description = '阅读室，窗边有木桌';
      revision = (await repo.save(p, r, revision, doc, 'ASSETS', true)).revision;
      const secondChange = await repo.workspace(p, r);
      expect(secondChange.prompts.find((v) => v.value.shotId === 's2')?.stale).toBe(true);
      expect(await db.jobOutbox.count({ where: { projectId: p, status: 'PENDING' } })).toBe(0);
    } finally {
      delivery.mockRestore();
      await db.workingArtifactDependency.deleteMany({ where: { projectId: p } });
      await db.workingArtifactRevisionSnapshot.deleteMany({ where: { projectId: p } });
      await db.project.deleteMany({ where: { id: { in: [p, other] } } });
      await db.$disconnect();
    }
  },
  60000,
);
