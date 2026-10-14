import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { expect, it, vi } from 'vitest';
import {
  emptyCustomizedBrief,
  isSharedScriptStage,
  SCRIPT_QUALITY_CRITERIA,
  type StoryboardInput,
  type StoryboardStage,
} from '@ai-marketing/contracts';
import { PrismaService } from '../../../database/prisma.service';
import { WorkflowWorkingRepository } from '../../../platform/workflow/workflow-working.repository';
import { workflowStateHash } from '../../../platform/workflow/workflow-state-hash';
import type { Prisma, CustomizedStoryboardTask } from '../../../generated/prisma/client';
import { StoryboardRepository } from './storyboard.repository';
import brandFixture from '../../../../../../packages/contracts/fixtures/customized-brand-creation.json';

it.skipIf(process.env.CUSTOMIZED_STORYBOARD_DATABASE_TEST !== '1').each([false, true])(
  'freezes screenplay format and publishes only reviewed bodies, repaired=%s',
  async (repair) => {
    const db = new PrismaService(
      new ConfigService({
        DATABASE_URL:
          process.env.DATABASE_URL ??
          'postgresql://postgres:postgres@localhost:5432/ai_marketing?schema=public',
      }),
    );
    const repo = new StoryboardRepository(db, new WorkflowWorkingRepository(db));
    const projectId = randomUUID();
    const target = repo as unknown as {
      enqueue(
        tx: Prisma.TransactionClient,
        task: CustomizedStoryboardTask,
      ): Promise<{ id: string }>;
    };
    const original = target.enqueue.bind(repo);
    const delivery = vi.spyOn(target, 'enqueue').mockImplementation(async (tx, task) => {
      const outbox = await original(tx, task);
      return tx.jobOutbox.update({
        where: { id: outbox.id },
        data: { status: 'PUBLISHED', publishedAt: new Date() },
      });
    });
    try {
      await db.project.create({ data: { id: projectId, name: '正式剧本隔离测试' } });
      const root = await new WorkflowWorkingRepository(db).initializeCustomizedRun(projectId);
      const brief = {
        ...emptyCustomizedBrief(),
        productName: '充电器',
        sellingPoints: ['折叠插脚'],
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
      const task = await repo.create(projectId, root.id, 0, randomUUID(), {
        creative: 'controlled',
        detail: 'controlled',
      });
      const claim = await repo.claim(projectId, task.id);
      const input = claim.input as unknown as StoryboardInput;
      expect(input.storyFormat).toBe('VIDEO_SCRIPT_V3');
      expect(input.graphVersion).toBe('TYPED_CREATION_V1');
      expect(input.outputMode).toBe('STORY_ONLY');
      const id = input.scriptIds[0]!;
      const step = (
        nodeId: StoryboardStage,
        output: unknown,
        status: 'SUCCEEDED' | 'SKIPPED' = 'SUCCEEDED',
      ) =>
        repo.step(projectId, task.id, claim.attemptToken!, {
          nodeId,
          scriptId: isSharedScriptStage(nodeId) ? '' : id,
          status,
          output,
          errorMessage: null,
        });
      await step('SNAPSHOT', { source: input.source });
      await step('PREPARE', { source: input.source, requirements: [] });
      await step('ROUTE', { graphVersion: input.graphVersion, routeId: input.routeId });
      await expect(step('DRAMA_CONCEPT', {})).rejects.toThrow();
      await expect(step('BRAND_AD_CONCEPT', {})).rejects.toThrow();
      await step('BRAND_AD_PROPOSITION', brandFixture.development);
      await step('BRAND_AD_IDEAS', brandFixture.development);
      await step('BRAND_AD_CONCEPT', {
        status: 'READY', reason: '独立评估候选', missing: [],
        evaluations: brandFixture.selection.evaluations,
        commitments: input.scriptIds.map((scriptId,i) => ({...brandFixture.selection.commitments[i]!,scriptId})),
        readiness: { status: 'READY', reason: '产品资料充分', missing: [] },
        concepts: input.scriptIds.map((scriptId) => ({
          scriptId,
          name: '出发',
          synopsis: '收纳后出发',
          productFocus: '折叠',
          structure: '收纳、出发',
          difference: '行动',
          coreIdea: '收纳后的出发',
          openingHook: '折叠的轮廓',
          productRole: '随行产品',
          memoryPoint: '收平插脚',
          plan: {
            videoType: 'BRAND_AD',
            brandImpression: '轻巧',
            visualConcept: '收平',
            visualProgression: '收纳出发',
            productConnection: '折叠插脚',
            ending: '出发',
          },
        })),
      });
      const content = 'P01｜出发\n\n林岚合上充电器插脚，将它放进包内。\n\n林岚：（回头）走吧。';
      let story = {
        title: '出发',
        structureMapping: [],
        content,
        opening: '收纳',
        development: '准备',
        ending: '出发',
        dialoguePlan: '走吧',
        beats: [{ id: 'P01', content, durationSeconds: 42 }],
      };
      await expect(step('BRAND_AD_STORY', { ...story, content: '概述' })).rejects.toThrow();
      await step('BRAND_AD_STORY', story);
      const finding = {
        severity: 'ERROR',
        category: 'STORY',
        shotIds: [],
        beatIds: ['P01'],
        message: '需要明确动作',
        evidence: content,
        suggestion: '明确收平后放入',
      };
      const quality = (evidence: string) => ({
        routeId: 'BRAND_AD',
        qualityChecks: SCRIPT_QUALITY_CRITERIA.BRAND_AD.map((criterion) => ({
          criterion,
          verdict: 'PASS',
          beatIds: ['P01'],
          evidence,
          reason: '受控模型检查通过',
          suggestion: '',
        })),
      });
      await expect(
        step('BRAND_AD_REVIEW', {
          ...quality(content),
          summary: '检查引用',
          findings: [{ ...finding, beatIds: ['P99'] }],
        }),
      ).rejects.toThrow();
      await expect(
        step('BRAND_AD_REVIEW', {
          ...quality('不存在于当前正文中的引文'),
          summary: '检查依据',
          findings: [],
        }),
      ).rejects.toThrow();
      await step('BRAND_AD_REVIEW', {
        ...quality(content),
        summary: '事实与行动核对',
        findings: repair ? [finding] : [],
      });
      const script = {
        id,
        name: '出发',
        synopsis: '收纳后出发',
        structure: '收纳、出发',
        productFocus: '折叠',
        story,
        shots: [],
        assets: [],
        creation: {
          videoType: input.settings.videoType!,
          referenceDurationSeconds: input.settings.targetDurationSeconds,
          structureSections: input.settings.structureSections!,
        },
      };
      if (repair) {
        await expect(step('REPAIR', { reason: '无需修改' }, 'SKIPPED')).rejects.toThrow();
        const revisedContent = content.replace('合上充电器插脚', '将充电器双插脚完全收平');
        story = {
          ...story,
          content: revisedContent,
          beats: [{ ...story.beats[0]!, content: revisedContent }],
        };
        script.story = story;
        await step('REPAIR', {
          script,
          reason: '明确收平状态',
          changes: [{ before: content, after: revisedContent, reason: '动作明确' }],
        });
        await expect(
          repo.completeScript(projectId, task.id, claim.attemptToken!, script),
        ).rejects.toThrow();
        await step('RECHECK', {
          ...quality(revisedContent),
          summary: '已独立核对修订全文',
          findings: [],
        });
      } else {
        await step('REPAIR', { reason: '无需修改' }, 'SKIPPED');
        await step('RECHECK', { reason: '无需复核' }, 'SKIPPED');
      }
      await expect(
        repo.completeScript(projectId, task.id, claim.attemptToken!, {
          ...script,
          story: { ...story, content: '概述' },
        }),
      ).rejects.toThrow();
      await expect(
        repo.completeScript(projectId, task.id, claim.attemptToken!, {
          ...script,
          creation: { ...script.creation, referenceDurationSeconds: 31 },
        }),
      ).rejects.toThrow();
      const saved = await repo.completeScript(projectId, task.id, claim.attemptToken!, script);
      const repeated = await repo.completeScript(projectId, task.id, claim.attemptToken!, script);
      expect(repeated).toEqual({ ...saved, unchanged: true });
      const workspace = await repo.workspace(projectId, root.id);
      expect(workspace.scripts[0]!.script.story!.content).toBe(story.content);
      expect(workspace.scripts[0]!.confirmedRevision).toBe(1);
      await repo.retry(projectId, task.id, true);
    } finally {
      delivery.mockRestore();
      await db.workingArtifactDependency.deleteMany({ where: { projectId } });
      await db.project.deleteMany({ where: { id: projectId } });
      await db.$disconnect();
    }
  },
  30000,
);
