import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { expect, it, vi } from 'vitest';
import {
  buildVideoSourceUnits,
  DEFAULT_CUSTOMIZED_VIDEO_RENDER_SETTINGS as settings,
  type ProductionVideoDocument,
} from '@ai-marketing/contracts';
import { PrismaService } from '../../../database/prisma.service';
import { WorkflowWorkingRepository } from '../../../platform/workflow/workflow-working.repository';
import { workflowStateHash } from '../../../platform/workflow/workflow-state-hash';
import { ProductionRepository } from './production.repository';

it.skipIf(process.env.CUSTOMIZED_PRODUCTION_DATABASE_TEST !== '1')(
  'renders in place, freezes settings, fences unknown creates, and rejects late results',
  async () => {
    const db = new PrismaService(new ConfigService({ DATABASE_URL: process.env.DATABASE_URL }));
    const p = randomUUID(),
      sibling = randomUUID(),
      scriptId = randomUUID(),
      working = new WorkflowWorkingRepository(db),
      repo = new ProductionRepository(db, working);
    const outbox = vi
      .spyOn(repo as unknown as { enqueue(...args: unknown[]): Promise<unknown> }, 'enqueue')
      .mockResolvedValue({});
    try {
      await db.project.createMany({
        data: [
          { id: p, name: '受控渲染隔离测试' },
          { id: sibling, name: '其他项目' },
        ],
      });
      const run = await working.initializeCustomizedRun(p),
        r = run.id;
      await db.workflowRun.update({ where: { id: r }, data: { forkScriptId: scriptId } });
      const f = JSON.parse(
        readFileSync(
          resolve(
            __dirname,
            '../../../../../../packages/contracts/fixtures/customized-video-plan-v2.json',
          ),
          'utf8',
        ),
      ) as { scriptText: string; document: ProductionVideoDocument };
      const script = {
        id: scriptId,
        name: '一杯清晨',
        synopsis: '阅读日常',
        structure: 'AI编排',
        productFocus: '陶瓷杯',
        shots: [],
        assets: [],
        story: {
          content: f.scriptText,
          opening: '拿杯',
          development: '阅读',
          ending: '定版',
          dialoguePlan: '旁白',
          beats: [{ id: 'P1', content: f.scriptText, durationSeconds: 10 }],
        },
      };
      for (const [key, payload, node] of [
        [`customized-script:${scriptId}`, script, 'STORYBOARD'],
        [
          'customized-brief',
          { productName: '陶瓷杯', sellingPoints: ['陶瓷'] },
          'INFORMATION_EXTRACTION',
        ],
        ['customized-asset-catalog', { assets: f.document.assets }, 'SHOT_PROMPT'],
      ] as [string, object, string][]) {
        await db.workingArtifact.create({
          data: {
            projectId: p,
            workflowRunId: r,
            nodeId: node,
            artifactKey: key,
            name: key,
            kind: 'STRUCTURED',
            directory: 'SCRIPTS',
            type: 'STORYBOARD_SCRIPT',
            payload,
            contentHash: workflowStateHash(payload),
          },
        });
      }
      f.document.videoPlan.sourceUnits = buildVideoSourceUnits(f.scriptText);
      f.document.videoPlan.sources = (
        await db.workingArtifact.findMany({ where: { projectId: p } })
      ).map((a) => ({ id: a.id, revision: a.revision, hash: a.contentHash }));
      await repo.save(p, r, 0, f.document, 'SHOTS', true);
      let w = await repo.workspace(p, r);
      await repo.savePrompt(p, r, 0, {
        target: { kind: 'CLIP', id: 'clip-a' },
        content: '0–10秒：陶瓷杯的特写。',
        assetIds: [],
      });
      expect((await repo.saveVideoSettings(p, r, 'clip-a', 0, settings)).revision).toBe(1);
      expect((await repo.saveVideoSettings(p, r, 'clip-a', 1, settings)).revision).toBe(1);
      const models = { creative: 'controlled', detail: 'controlled' },
        args = {
          target: { kind: 'CLIP' as const, id: 'clip-a' },
          render: { settings, model: 'controlled-seedance' },
        };
      const task = await repo.start(
        p,
        r,
        w.draftRevision,
        'RENDER',
        'video-one',
        null,
        models,
        null,
        undefined,
        args,
      );
      expect(
        (
          await repo.start(
            p,
            r,
            w.draftRevision,
            'RENDER',
            'video-one',
            null,
            models,
            null,
            undefined,
            args,
          )
        ).id,
      ).toBe(task.id);
      await expect(
        repo.start(p, r, w.draftRevision, 'RENDER', 'video-one', null, models, null, undefined, {
          ...args,
          render: { ...args.render, settings: { ...settings, ratio: '1:1' } },
        }),
      ).rejects.toThrow();
      await expect(repo.claim(p, task.id, 'ASSETS')).rejects.toThrow();
      await expect(repo.getTask(sibling, task.id)).rejects.toThrow();
      const claim = await repo.claim(p, task.id, 'VIDEO');
      await repo.checkpoint(
        p,
        task.id,
        claim.attemptToken!,
        { id: 'GENERATE', title: '生成视频', status: 'RUNNING', content: '受控供应商任务' },
        { providerTaskId: 'provider-one', createStarted: true },
        'VIDEO',
      );
      const info = { durationSeconds: 10.04, width: 1280, height: 720 },
        files = {
          video: { storageKey: `test/${p}/video`, sizeBytes: 100, sha256: 'a'.repeat(64) },
          poster: { storageKey: `test/${p}/poster`, sizeBytes: 50, sha256: 'b'.repeat(64) },
        };
      await expect(repo.acceptVideo(p, task.id, 'wrong', info, files)).rejects.toThrow();
      const accepted = await repo.acceptVideo(p, task.id, claim.attemptToken!, info, files);
      expect(accepted.stored).toBe(true);
      expect((await repo.acceptVideo(p, task.id, claim.attemptToken!, info, files)).stored).toBe(
        false,
      );
      w = await repo.workspace(p, r);
      expect(w.videos).toHaveLength(1);
      expect(w.videos![0]!.stale).toBe(false);
      expect((await repo.videoFile(p, r, 'clip-a')).sha256).toBe(files.video.sha256);
      expect(await db.workflowRun.count({ where: { projectId: p } })).toBe(1);
      const same = await repo.start(
          p,
          r,
          w.draftRevision,
          'RENDER',
          'same-content',
          null,
          models,
          null,
          undefined,
          args,
        ),
        sc = await repo.claim(p, same.id, 'VIDEO');
      await repo.checkpoint(
        p,
        same.id,
        sc.attemptToken!,
        { id: 'GENERATE', title: '生成视频', status: 'RUNNING', content: '受控相同文件' },
        { providerTaskId: 'provider-same', createStarted: true },
        'VIDEO',
      );
      expect((await repo.acceptVideo(p, same.id, sc.attemptToken!, info, files)).stored).toBe(
        false,
      );
      expect((await repo.workspace(p, r)).videos![0]!.revision).toBe(w.videos![0]!.revision);
      const denied = await repo.start(
          p,
          r,
          w.draftRevision,
          'RENDER',
          'denied',
          null,
          models,
          null,
          undefined,
          args,
        ),
        dc = await repo.claim(p, denied.id, 'VIDEO');
      await repo.checkpoint(
        p,
        denied.id,
        dc.attemptToken!,
        { id: 'GENERATE', title: '生成视频', status: 'RUNNING', content: '正在提交' },
        { createStarted: true },
        'VIDEO',
      );
      await expect(
        repo.checkpoint(
          p,
          denied.id,
          dc.attemptToken!,
          { id: 'GENERATE', title: '生成视频', status: 'RUNNING', content: '不可任意清除' },
          { createStarted: false },
          'VIDEO',
        ),
      ).rejects.toThrow();
      await repo.checkpoint(
        p,
        denied.id,
        dc.attemptToken!,
        { id: 'GENERATE', title: '生成视频', status: 'RUNNING', content: '请求被拒绝' },
        { createStarted: false, createRejected: true },
        'VIDEO',
      );
      await repo.fail(p, denied.id, dc.attemptToken!, false, 'VIDEO');
      expect((await repo.getTask(p, denied.id)).errorMessage).toContain('未受理');
      const unknown = await repo.start(
          p,
          r,
          w.draftRevision,
          'RENDER',
          'unknown',
          null,
          models,
          null,
          undefined,
          args,
        ),
        uc = await repo.claim(p, unknown.id, 'VIDEO');
      await repo.checkpoint(
        p,
        unknown.id,
        uc.attemptToken!,
        { id: 'GENERATE', title: '生成视频', status: 'RUNNING', content: '创建请求已准备' },
        { createStarted: true },
        'VIDEO',
      );
      await repo.fail(p, unknown.id, uc.attemptToken!, true, 'VIDEO');
      expect((await repo.getTask(p, unknown.id)).status).toBe('FAILED');
      const late = await repo.start(
          p,
          r,
          w.draftRevision,
          'RENDER',
          'late',
          null,
          models,
          null,
          undefined,
          args,
        ),
        lc = await repo.claim(p, late.id, 'VIDEO');
      await repo.checkpoint(
        p,
        late.id,
        lc.attemptToken!,
        { id: 'GENERATE', title: '生成视频', status: 'RUNNING', content: '受控供应商任务' },
        { providerTaskId: 'provider-late', createStarted: true },
        'VIDEO',
      );
      await db.workingArtifact.updateMany({
        where: { projectId: p, artifactKey: 'customized-clip-prompt:clip-a' },
        data: { revision: { increment: 1 } },
      });
      await expect(repo.acceptVideo(p, late.id, lc.attemptToken!, info, files)).rejects.toThrow();
      expect((await repo.videoFile(p, r, 'clip-a')).sha256).toBe(files.video.sha256);
      await db.customizedProductionTask.update({
        where: { id: late.id },
        data: { leaseExpiresAt: new Date(0) },
      });
      expect(await repo.claim(p, late.id, 'VIDEO')).toEqual({ terminal: true });
      const second = await repo.start(
          p,
          r,
          w.draftRevision,
          'RENDER',
          'second-source-cycle',
          null,
          models,
          null,
          undefined,
          args,
        ),
        secondClaim = await repo.claim(p, second.id, 'VIDEO');
      await repo.checkpoint(
        p,
        second.id,
        secondClaim.attemptToken!,
        { id: 'GENERATE', title: '生成视频', status: 'RUNNING', content: '第二轮受控供应商任务' },
        { providerTaskId: 'provider-second', createStarted: true },
        'VIDEO',
      );
      await db.workingArtifact.updateMany({
        where: { projectId: p, artifactKey: 'customized-clip-prompt:clip-a' },
        data: { revision: { increment: 1 } },
      });
      await expect(
        repo.acceptVideo(p, second.id, secondClaim.attemptToken!, info, files),
      ).rejects.toThrow();
      expect((await repo.videoFile(p, r, 'clip-a')).sha256).toBe(files.video.sha256);
      const independent = await db.workflowRun.create({
        data: {
          projectId: p,
          workflow: 'CUSTOMIZED',
          workflowSpace: 'CUSTOMIZED_PROJECT',
          activeKey: null,
          branchPublishedAt: new Date(),
          forkScriptId: randomUUID(),
        },
      });
      expect(independent.id).not.toBe(r);
      await expect(repo.videoFile(p, independent.id, 'clip-a')).rejects.toThrow();
    } finally {
      outbox.mockRestore();
      await db.workingArtifactDependency.deleteMany({ where: { projectId: p } });
      await db.workingArtifactRevisionSnapshot.deleteMany({ where: { projectId: p } });
      await db.project.deleteMany({ where: { id: { in: [p, sibling] } } });
      await db.$disconnect();
    }
  },
  30000,
);
