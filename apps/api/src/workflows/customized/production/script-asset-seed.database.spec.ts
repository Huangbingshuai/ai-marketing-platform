import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { expect, it, vi } from 'vitest';
import {
  emptyCustomizedBrief,
  type CustomizedStoryboardScript,
  type ProductionInput,
} from '@ai-marketing/contracts';
import { PrismaService } from '../../../database/prisma.service';
import { WorkflowWorkingRepository } from '../../../platform/workflow/workflow-working.repository';
import { workflowStateHash } from '../../../platform/workflow/workflow-state-hash';
import { StoryboardRepository } from '../storyboard/storyboard.repository';
import { ProductionRepository } from './production.repository';

it.skipIf(process.env.CUSTOMIZED_PRODUCTION_DATABASE_TEST !== '1')(
  'marks fresh script asset projections as editable in workspace and frozen task input',
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
        assets: [
          { id: 'script-cup', kind: 'products', name: '陶瓷杯', description: '脚本中的杯子' },
        ],
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
      const workspace = await repo.workspace(p, r);
      expect(workspace.document.assets).toMatchObject([
        {
          id: 'script-cup',
          description: '脚本中的杯子',
          manualFields: [],
          sourceText: '脚本资产定义，使用前请核对',
        },
      ]);
      const task = await repo.start(p, r, workspace.draftRevision, 'ASSETS', randomUUID(), null, {
        creative: 'controlled',
        detail: 'controlled',
      });
      const claim = await repo.claim(p, task.id, 'ASSETS');
      expect((claim.input as unknown as ProductionInput).document.assets[0]!.manualFields).toEqual(
        [],
      );
      expect(
        await db.workingArtifact.count({
          where: { projectId: p, artifactKey: 'customized-asset-catalog' },
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
