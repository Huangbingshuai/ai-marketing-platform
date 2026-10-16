import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StoragePort } from '../../../platform/file/storage.port';
import { ProductionImageService } from './production-image.service';
import type { AssetService } from '../../../platform/asset/asset.service';
import { ConfigService } from '@nestjs/config';
import { it, expect, vi } from 'vitest';
import {
  emptyCustomizedBrief,
  PRODUCTION_STAGES,
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
      // Keep this downstream isolation fixture independent of new writing formats.
      const sourceTask = await db.customizedStoryboardTask.findUniqueOrThrow({
        where: { id: storyTask.id },
      });
      const sourceInput = { ...(sourceTask.inputSnapshot as Record<string, unknown>) };
      delete sourceInput.storyFormat;
      delete sourceInput.graphVersion;
      await db.customizedStoryboardTask.update({
        where: { id: storyTask.id },
        data: { inputSnapshot: sourceInput as Prisma.InputJsonValue },
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
      const reviewTask = await repo.start(p, r, 0, 'ASSETS', randomUUID(), null, {
        creative: 'controlled',
        detail: 'controlled',
      });
      const reviewClaim = await repo.claim(p, reviewTask.id, 'ASSETS');
      const reviewInput = reviewClaim.input as { identitySeed: string };
      const reviewAsset = {
        id: `asset-${reviewInput.identitySeed}-1`,
        kind: 'PRODUCT' as const,
        name: '陶瓷杯',
        description: '陶瓷杯',
        knownFacts: '陶瓷材质',
        designNotes: '颜色待确认',
        sourceText: '陶瓷杯',
        imageRequirements: '公共参考图',
        preparation: {
          aliases: [],
          usage: '故事主体',
          treatment: 'INDEPENDENT' as const,
          parentId: null,
          sources: [
            {
              source: 'BRIEF' as const,
              path: '/productName',
              quote: '陶瓷杯',
              field: 'description',
            },
          ],
          details: [],
          questions: [],
          images: [],
        },
      };
      await db.customizedProductionTask.update({
        where: { id: reviewTask.id },
        data: { status: 'FAILED', attemptToken: null, leaseExpiresAt: null },
      });
      await expect(repo.reviewDraft(p, reviewTask.id, 0)).rejects.toThrow('没有可供');
      await db.customizedProductionTask.update({
        where: { id: reviewTask.id },
        data: {
          steps: [
            'SNAPSHOT',
            'INVENTORY',
            'IDENTITY',
            'PRODUCT',
            'CHARACTER',
            'SCENE',
            'PROP',
            'IMAGE_PLAN',
            'REVIEW',
            'REPAIR',
            'SAVE',
          ].map((id) => ({
            id,
            title: id,
            content: '受控测试',
            status: id === 'REPAIR' ? 'FAILED' : id === 'SAVE' ? 'PENDING' : 'SUCCEEDED',
          })),
          output: { inventory: [{ id: reviewAsset.id }], revised: [reviewAsset] },
        },
      });
      expect((await repo.getTask(p, reviewTask.id)).reviewDraftState).toBe('AVAILABLE');
      await expect(repo.reviewDraft(other, reviewTask.id, 0)).rejects.toThrow();
      await expect(repo.reviewDraft(p, reviewTask.id, 99)).rejects.toThrow('草稿已改变');
      const reviewBrief = await db.workingArtifact.findFirstOrThrow({
        where: { projectId: p, workflowRunId: r, artifactKey: 'customized-brief' },
      });
      await db.workingArtifact.update({
        where: { id: reviewBrief.id },
        data: { freshness: 'STALE' },
      });
      await expect(repo.reviewDraft(p, reviewTask.id, 0)).rejects.toThrow('任务来源已变化');
      await db.workingArtifact.update({
        where: { id: reviewBrief.id },
        data: { freshness: 'CURRENT' },
      });
      const adopted = await repo.reviewDraft(p, reviewTask.id, 0);
      const reviewed = await repo.workspace(p, r);
      expect(reviewed.document.assets[0]!.manualFields).toEqual([]);
      expect(reviewed.confirmedDocument.assets).toHaveLength(0);
      expect((await repo.getTask(p, reviewTask.id)).status).toBe('FAILED');
      expect((await repo.getTask(p, reviewTask.id)).reviewDraftState).toBe('ADOPTED');
      expect(
        await db.workingArtifact.count({
          where: { projectId: p, workflowRunId: r, artifactKey: 'customized-asset-catalog' },
        }),
      ).toBe(0);
      await expect(repo.reviewDraft(p, reviewTask.id, adopted.revision)).rejects.toThrow(
        '没有可供',
      );
      await expect(
        repo.complete(
          p,
          reviewTask.id,
          reviewClaim.attemptToken!,
          { assets: [reviewAsset], shots: [] },
          'ASSETS',
        ),
      ).rejects.toThrow();
      reviewed.document.assets[0]!.designNotes = '人工核对后的颜色设定';
      await repo.save(p, r, adopted.revision, reviewed.document, 'ASSETS', false);
      expect((await repo.workspace(p, r)).document.assets[0]!.manualFields).toEqual([
        'designNotes',
      ]);
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
      let revision = (
        await repo.save(p, r, (await repo.workspace(p, r)).draftRevision, doc, 'ASSETS', true)
      ).revision;
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
      await expect(repo.claim(p, t.id, 'ASSETS')).rejects.toThrow('任务不属于');
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
      // A task queued before the v2 deployment must retain its original six checkpoints.
      const legacyTask = await db.customizedProductionTask.findUniqueOrThrow({
        where: { id: recovery.id },
      });
      const legacyInput = { ...(legacyTask.inputSnapshot as Record<string, unknown>) };
      delete legacyInput.assetWorkflowVersion;
      await db.customizedProductionTask.update({
        where: { id: recovery.id },
        data: {
          inputSnapshot: legacyInput as Prisma.InputJsonValue,
          steps: PRODUCTION_STAGES.map((s) => ({
            id: s.id,
            status: 'PENDING',
            title: s.label,
            content: '',
          })),
        },
      });
      const queued = await db.jobOutbox.findFirstOrThrow({ where: { aggregateId: recovery.id } });
      expect(queued.routingKey).toBe('customized.assets.requested');
      await db.jobOutbox.update({
        where: { id: queued.id },
        data: { routingKey: 'customized.production.requested' },
      });
      expect(await repo.rerouteLegacyAssets(p, recovery.id)).toEqual({ forwarded: true });
      expect(await repo.rerouteLegacyAssets(p, recovery.id)).toEqual({ forwarded: true });
      expect(await db.jobOutbox.count({ where: { aggregateId: recovery.id } })).toBe(1);
      expect((await db.jobOutbox.findUniqueOrThrow({ where: { id: queued.id } })).routingKey).toBe(
        'customized.assets.requested',
      );
      await expect(repo.claim(p, recovery.id, 'VIDEO')).rejects.toThrow('任务不属于');
      expect(
        (await db.customizedProductionTask.findUniqueOrThrow({ where: { id: recovery.id } }))
          .attemptCount,
      ).toBe(0);
      const firstLease = await repo.claim(p, recovery.id, 'ASSETS');
      expect(await repo.rerouteLegacyAssets(p, recovery.id)).toEqual({ forwarded: false });
      await expect(
        repo.heartbeat(p, recovery.id, firstLease.attemptToken!, 'VIDEO'),
      ).rejects.toThrow('任务不属于');
      await expect(
        repo.checkpoint(
          p,
          recovery.id,
          firstLease.attemptToken!,
          { id: 'SNAPSHOT', status: 'SUCCEEDED', title: '', content: '' },
          undefined,
          'VIDEO',
        ),
      ).rejects.toThrow('任务不属于');
      await expect(
        repo.complete(p, recovery.id, firstLease.attemptToken!, {}, 'VIDEO'),
      ).rejects.toThrow('任务不属于');
      await expect(
        repo.fail(p, recovery.id, firstLease.attemptToken!, false, 'VIDEO'),
      ).rejects.toThrow('任务不属于');
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
      expect((await db.jobOutbox.findUniqueOrThrow({ where: { id: queued.id } })).routingKey).toBe(
        'customized.assets.requested',
      );
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
      await expect(
        repo.complete(p, recovery.id, secondLease.attemptToken!, catalogResult, 'VIDEO'),
      ).rejects.toThrow('任务不属于');
      expect((await repo.workspace(p, r)).document.shots).toHaveLength(2);
      // A second object change must now affect only its dependent prompt.
      doc.assets[1]!.description = '阅读室，窗边有木桌';
      revision = (await repo.save(p, r, revision, doc, 'ASSETS', true)).revision;
      const secondChange = await repo.workspace(p, r);
      expect(secondChange.prompts.find((v) => v.value.shotId === 's2')?.stale).toBe(true);
      const modern = await repo.start(p, r, revision, 'ASSETS', randomUUID(), null, models, 'cup');
      expect(modern.assetWorkflowVersion).toBe(2);
      expect(modern.steps.some((s) => s.id === 'INVENTORY')).toBe(true);
      const modernLease = await repo.claim(p, modern.id, 'ASSETS');
      const modernInput = modernLease.input as unknown as {
        document: ProductionDocument;
        sources: { id: string }[];
      };
      expect(modernInput.sources).toHaveLength(2);
      const cup = modernInput.document.assets.find((a) => a.id === 'cup')!;
      const result = {
        assets: [
          {
            ...cup,
            preparation: {
              aliases: [],
              usage: '故事产品',
              treatment: 'INDEPENDENT' as const,
              parentId: null,
              sources: [
                { source: 'BRIEF' as const, path: '/productName', quote: '陶瓷杯', field: 'name' },
              ],
              details: [{ key: 'material', value: '陶瓷' }],
              questions: [],
              images: [],
            },
          },
        ],
        shots: [],
      };
      for (const step of modern.steps.filter((s) => s.id !== 'SAVE'))
        await repo.checkpoint(
          p,
          modern.id,
          modernLease.attemptToken!,
          { ...step, status: 'SUCCEEDED', title: '受控结果', content: '实际测试对象' },
          { final: result },
          'ASSETS',
        );
      await repo.complete(p, modern.id, modernLease.attemptToken!, result, 'ASSETS');
      await repo.complete(p, modern.id, modernLease.attemptToken!, result, 'ASSETS');
      const restored = await repo.workspace(p, r);
      expect(restored.document.assets).toHaveLength(2);
      expect(restored.document.shots).toHaveLength(2);
      expect(restored.document.assets.find((a) => a.id === 'cup')?.description).toBe(
        cup.description,
      );
      // Real DB + real file validation, with controlled storage and no model calls.
      const imageDocument = {
        ...restored.document,
        assets: [
          ...restored.document.assets,
          {
            id: 'constructor',
            kind: 'PROP' as const,
            name: '阅读灯',
            description: '木质灯座',
            knownFacts: '',
            designNotes: '',
            sourceText: '故事',
          },
        ],
      };
      revision = (await repo.save(p, r, restored.draftRevision, imageDocument, 'ASSETS', true))
        .revision;
      const settings = {
        model: 'doubao-seedream-5-0-pro-260628',
        resolution: '2K',
        ratio: '1:1',
        assetIds: ['cup', 'room', 'constructor'],
      } as const;
      const imageSettings = { ...settings, assetIds: [...settings.assetIds] };
      const imageKey = randomUUID();
      const images = await repo.start(
        p,
        r,
        revision,
        'IMAGE',
        imageKey,
        null,
        models,
        null,
        imageSettings,
      );
      expect(
        (await repo.start(p, r, revision, 'IMAGE', imageKey, null, models, null, imageSettings)).id,
      ).toBe(images.id);
      await expect(
        repo.start(p, r, revision, 'IMAGE', imageKey, null, models, null, {
          ...imageSettings,
          model: 'doubao-seedream-5-0-flash-260915',
        }),
      ).rejects.toThrow();
      await expect(repo.claim(p, images.id, 'VIDEO')).rejects.toThrow();
      let imageLease = await repo.claim(p, images.id, 'ASSETS');
      await repo.checkpoint(
        p,
        images.id,
        imageLease.attemptToken!,
        { id: 'SNAPSHOT', status: 'SUCCEEDED', title: '制作依据', content: '陶瓷杯与阅读室' },
        undefined,
        'ASSETS',
      );
      await expect(
        repo.complete(p, images.id, imageLease.attemptToken!, {}, 'ASSETS'),
      ).rejects.toThrow();
      const temporary = await mkdtemp(join(tmpdir(), 'customized-image-test-'));
      const keys = new Set<string>();
      const storage = {
        put: async (input: Parameters<StoragePort['put']>[0]) => {
          for await (const chunk of input.stream) {
            expect(chunk.length).toBeGreaterThan(0);
          }
          const key = `controlled/${randomUUID()}.png`;
          keys.add(key);
          return { key, sizeBytes: input.sizeBytes };
        },
        delete: async (key: string) => {
          keys.delete(key);
        },
      } as unknown as StoragePort;
      const service = new ProductionImageService(repo, storage, {} as AssetService);
      try {
        const png = Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6D1kAAAAASUVORK5CYII=',
          'base64',
        );
        const path = join(temporary, 'asset.png');
        await writeFile(path, png);
        const file = { path, originalname: 'asset.png', mimetype: 'image/png', size: png.length };
        await expect(
          service.upload(other, images.id, imageLease.attemptToken!, 'cup', file),
        ).rejects.toThrow();
        const first = await service.upload(p, images.id, imageLease.attemptToken!, 'cup', file);
        expect(await service.upload(p, images.id, imageLease.attemptToken!, 'cup', file)).toEqual(
          first,
        );
        expect(keys.size).toBe(1);
        await repo.fail(p, images.id, imageLease.attemptToken!, false, 'ASSETS');
        expect(
          (await repo.workspace(p, r)).document.assets.find((a) => a.id === 'cup')?.image,
        ).toEqual(first);
        const oldToken = imageLease.attemptToken!;
        await repo.action(p, images.id, false);
        imageLease = await repo.claim(p, images.id, 'ASSETS');
        expect(imageLease.output).toEqual({ cup: first });
        await expect(service.upload(p, images.id, oldToken, 'room', file)).rejects.toThrow();
        await service.upload(p, images.id, imageLease.attemptToken!, 'room', file);
        // Dictionary-like object IDs cannot impersonate saved image references.
        await expect(
          repo.complete(p, images.id, imageLease.attemptToken!, {}, 'ASSETS'),
        ).rejects.toThrow();
        await service.upload(p, images.id, imageLease.attemptToken!, 'constructor', file);
        await repo.complete(p, images.id, imageLease.attemptToken!, {}, 'ASSETS');
        await repo.complete(p, images.id, imageLease.attemptToken!, {}, 'ASSETS');
        expect(await db.asset.count({ where: { projectId: p } })).toBe(3);
        const generated = await repo.workspace(p, r);
        expect(generated.document.assets.every((a) => a.image)).toBe(true);
        expect(generated.confirmedDocument.assets.some((a) => a.image)).toBe(false);
        revision = (
          await repo.save(p, r, generated.draftRevision, generated.document, 'ASSETS', true)
        ).revision;
        const cancelled = await repo.start(
          p,
          r,
          revision,
          'IMAGE',
          randomUUID(),
          null,
          models,
          null,
          {
            ...imageSettings,
            assetIds: ['cup'],
            inputs: [{ assetId: 'cup', prompt: '暖白陶瓷杯，柔和侧光', references: [first] }],
          },
        );
        const cancelLease = await repo.claim(p, cancelled.id, 'ASSETS');
        expect(
          await repo.imageReferenceScope(
            p,
            cancelled.id,
            cancelLease.attemptToken!,
            first.assetId,
            first.version,
          ),
        ).toMatchObject({ mimeType: 'image/png', sizeBytes: png.length });
        await expect(
          repo.imageReferenceScope(
            other,
            cancelled.id,
            cancelLease.attemptToken!,
            first.assetId,
            first.version,
          ),
        ).rejects.toThrow();
        await expect(
          repo.imageReferenceScope(p, cancelled.id, cancelLease.attemptToken!, first.assetId, 999),
        ).rejects.toThrow();
        await repo.action(p, cancelled.id, true);
        await expect(
          repo.imageReferenceScope(
            p,
            cancelled.id,
            cancelLease.attemptToken!,
            first.assetId,
            first.version,
          ),
        ).rejects.toThrow();
        await expect(
          service.upload(p, cancelled.id, cancelLease.attemptToken!, 'cup', file),
        ).rejects.toThrow();
        expect(
          (await repo.workspace(p, r)).document.assets.find((a) => a.id === 'cup')?.image,
        ).toEqual(first);
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
      expect(await db.jobOutbox.count({ where: { projectId: p, status: 'PENDING' } })).toBe(0);
    } finally {
      delivery.mockRestore();
      await db.workingArtifactDependency.deleteMany({ where: { projectId: p } });
      await db.workingArtifactRevisionSnapshot.deleteMany({ where: { projectId: p } });
      await db.assetVersion.deleteMany({ where: { projectId: p } });
      await db.asset.deleteMany({ where: { projectId: p } });
      await db.project.deleteMany({ where: { id: { in: [p, other] } } });
      await db.$disconnect();
    }
  },
  60000,
);
