import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { expect, it, vi } from 'vitest';
import {
  emptyCustomizedBrief,
  type CustomizedStoryboardScript,
  type ProductionDocument,
  type ProductionInput,
} from '@ai-marketing/contracts';
import { PrismaService } from '../../../database/prisma.service';
import { WorkflowWorkingRepository } from '../../../platform/workflow/workflow-working.repository';
import { activateCustomizedBranch } from '../../../platform/workflow/customized-branches';
import { workflowStateHash } from '../../../platform/workflow/workflow-state-hash';
import { StoryboardRepository } from '../storyboard/storyboard.repository';
import { ProductionRepository } from './production.repository';

it.skipIf(process.env.CUSTOMIZED_PRODUCTION_DATABASE_TEST !== '1')(
  'publishes one aggregate asset branch on success, preserving siblings, retries and local edits',
  async () => {
    const db = new PrismaService(
      new ConfigService({
        DATABASE_URL:
          process.env.DATABASE_URL ??
          'postgresql://postgres:postgres@localhost:5432/ai_marketing?schema=public',
      }),
    );
    const p = randomUUID();
    const working = new WorkflowWorkingRepository(db);
    const repo = new ProductionRepository(db, working);
    const stories = new StoryboardRepository(db, working);
    // Controlled checkpoint writes only; never enqueue a model request.
    vi.spyOn(
      repo as unknown as { enqueue(): Promise<{ id: string }> },
      'enqueue',
    ).mockResolvedValue({ id: randomUUID() });
    try {
      await db.project.create({ data: { id: p, name: '资产自动分支受控测试' } });
      const root = await working.initializeCustomizedRun(p);
      const brief = {
        ...emptyCustomizedBrief(),
        productName: '陶瓷杯',
        sellingPoints: ['陶瓷材质'],
      };
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
        name: '窗边阅读',
        synopsis: '窗边倒水阅读',
        structure: '日常',
        productFocus: '陶瓷杯',
        assets: [],
        shots: [],
        story: {
          content: '窗边倒水阅读。',
          opening: '开窗',
          development: '倒水',
          ending: '阅读',
          dialoguePlan: '无对白',
          beats: [{ id: 'b1', content: '完整故事', durationSeconds: 30 }],
        },
      };
      const manual = await stories.manual(p, root.id, script, 'MANUAL');
      const published = (await stories.edit(p, script.id, 'save', manual.revision, script)) as {
        workflowRunId: string;
      };
      const r = published.workflowRunId;
      await db.$transaction((tx) => activateCustomizedBranch(tx, p, r, 'SHOT_PROMPT'));
      const models = { creative: 'controlled', detail: 'controlled' };
      const begin = async (run: string) => {
        const workspace = await repo.workspace(p, run);
        const task = await repo.start(
          p,
          run,
          workspace.draftRevision,
          'ASSETS',
          randomUUID(),
          null,
          models,
        );
        const claim = await repo.claim(p, task.id, 'ASSETS');
        return { task, claim, input: claim.input as unknown as ProductionInput };
      };
      const first = await begin(r);
      expect(
        await db.workflowRun.count({ where: { projectId: p, forkNodeId: 'SHOT_PROMPT' } }),
      ).toBe(0);
      const asset = {
        id: `asset-${first.input.identitySeed}-1`,
        kind: 'PRODUCT' as const,
        name: '陶瓷杯',
        description: '白色陶瓷杯',
        knownFacts: '陶瓷材质',
        designNotes: '白色为美术设计',
        sourceText: '陶瓷杯',
        preparation: {
          aliases: [],
          usage: '故事主体',
          treatment: 'INDEPENDENT' as const,
          parentId: null,
          sources: [
            { source: 'BRIEF' as const, path: '/productName', quote: '陶瓷杯', field: 'name' },
          ],
          details: [],
          questions: [],
          images: [],
        },
      };
      const finish = async (
        execution: Awaited<ReturnType<typeof begin>>,
        document: ProductionDocument,
      ) => {
        for (const step of execution.task.steps.filter((s) => s.id !== 'SAVE'))
          await repo.checkpoint(
            p,
            execution.task.id,
            execution.claim.attemptToken!,
            { ...step, status: 'SUCCEEDED' },
            { final: document },
            'ASSETS',
          );
        await repo.complete(
          p,
          execution.task.id,
          execution.claim.attemptToken!,
          document,
          'ASSETS',
        );
        return (await repo.getTask(p, execution.task.id)).publishedWorkflowRunId!;
      };
      const one = await finish(first, { assets: [asset], shots: [] });
      expect(one).not.toBe(r);
      const w1 = await repo.workspace(p, one);
      expect(w1.assetsConfirmed).toBe(true);
      expect(w1.tasks.find((t) => t.operation === 'ASSETS')?.id).toBe(first.task.id);
      expect((await repo.workspace(p, r)).document.assets).toHaveLength(0);
      await repo.complete(
        p,
        first.task.id,
        first.claim.attemptToken!,
        { assets: [asset], shots: [] },
        'ASSETS',
      );
      expect(
        await db.workflowRun.count({ where: { projectId: p, forkNodeId: 'SHOT_PROMPT' } }),
      ).toBe(1);
      // Same content does not publish an empty branch or grow business revision.
      const unchanged = await begin(one);
      expect(await finish(unchanged, { assets: w1.document.assets, shots: [] })).toBe(one);
      expect(
        await db.workflowRun.count({ where: { projectId: p, forkNodeId: 'SHOT_PROMPT' } }),
      ).toBe(1);
      const second = await begin(one);
      const two = await finish(second, {
        assets: [{ ...w1.document.assets[0]!, description: '白色陶瓷杯，圆润杯口' }],
        shots: [],
      });
      expect(two).not.toBe(one);
      const third = await begin(two);
      // The user selects another path while work runs: completion may publish, never hijack it.
      await db.$transaction((tx) => activateCustomizedBranch(tx, p, r, 'SHOT_PROMPT'));
      const three = await finish(third, {
        assets: [{ ...w1.document.assets[0]!, description: '白色陶瓷杯，短柄造型' }],
        shots: [],
      });
      const branches = await db.workflowRun.findMany({
        where: { projectId: p, forkNodeId: 'SHOT_PROMPT' },
      });
      expect(branches).toHaveLength(3);
      expect(
        branches.every(
          (b) =>
            b.parentWorkflowRunId === r && b.forkScriptId === script.id && !!b.branchPublishedAt,
        ),
      ).toBe(true);
      expect(
        (await db.workflowRun.findFirstOrThrow({ where: { projectId: p, activeKey: 'ACTIVE' } }))
          .id,
      ).toBe(r);
      expect((await repo.workspace(p, one)).document.assets[0]!.description).toBe('白色陶瓷杯');
      // Local manual changes do not create a sibling; repeated save is idempotent.
      const local = await repo.workspace(p, three);
      local.document.assets[0]!.designNotes = '人工确认的设计';
      const saved = await repo.save(p, three, local.draftRevision, local.document, 'ASSETS', true);
      const catalog = await db.workingArtifact.findFirstOrThrow({
        where: { projectId: p, workflowRunId: three, artifactKey: 'customized-asset-catalog' },
      });
      await repo.save(p, three, saved.revision, local.document, 'ASSETS', true);
      expect(
        (await db.workingArtifact.findUniqueOrThrow({ where: { id: catalog.id } })).revision,
      ).toBe(catalog.revision);
      expect(
        await db.workflowRun.count({ where: { projectId: p, forkNodeId: 'SHOT_PROMPT' } }),
      ).toBe(3);
      // Cancelled/failed/late callbacks cannot publish a branch.
      const cancelled = await begin(three);
      await repo.action(p, cancelled.task.id, true);
      await expect(
        repo.complete(
          p,
          cancelled.task.id,
          cancelled.claim.attemptToken!,
          { assets: [asset], shots: [] },
          'ASSETS',
        ),
      ).rejects.toThrow();
      const failed = await begin(three);
      await repo.fail(p, failed.task.id, failed.claim.attemptToken!, false, 'ASSETS');
      expect(
        await db.workflowRun.count({ where: { projectId: p, forkNodeId: 'SHOT_PROMPT' } }),
      ).toBe(3);
      expect(
        await db.workingArtifact.count({
          where: {
            projectId: p,
            artifactKey: { in: ['customized-asset-definitions', 'customized-asset-images'] },
          },
        }),
      ).toBe(0);
    } finally {
      await db.workingArtifactDependency.deleteMany({ where: { projectId: p } });
      await db.project.deleteMany({ where: { id: p } });
      await db.$disconnect();
    }
  },
  60000,
);
