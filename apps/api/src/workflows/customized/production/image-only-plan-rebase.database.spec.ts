import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { expect, it, vi } from 'vitest';
import {
  mergeVideoTaskShots,
  type ProductionVideoDocument,
  type ProductionInput,
  isVideoDocument,
} from '@ai-marketing/contracts';
import { PrismaService } from '../../../database/prisma.service';
import { WorkflowWorkingRepository } from '../../../platform/workflow/workflow-working.repository';
import { workflowStateHash } from '../../../platform/workflow/workflow-state-hash';
import { ProductionRepository } from './production.repository';
import { imageOnlyPlanRebase, applyImageOnlyPlanRebase } from './image-only-plan-rebase';
import type { Prisma } from '../../../generated/prisma/client';

it.skipIf(process.env.CUSTOMIZED_PRODUCTION_DATABASE_TEST !== '1')(
  'C11 keeps six clips across late images, repairs legacy blockage, fences definitions and preserves sibling scope',
  async () => {
    const url = process.env.DATABASE_URL;
    if (!url || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname))
      throw new Error('Local database required');
    const db = new PrismaService(new ConfigService({ DATABASE_URL: url }));
    const p = randomUUID(),
      other = randomUUID(),
      scriptId = randomUUID();
    const working = new WorkflowWorkingRepository(db),
      repo = new ProductionRepository(db, working);
    const api = repo as unknown as {
      enqueue(...args: unknown[]): Promise<unknown>;
      commitAssets(
        tx: Prisma.TransactionClient,
        p: string,
        r: string,
        v: ProductionVideoDocument,
      ): Promise<void>;
    };
    const outbox = vi.spyOn(api, 'enqueue').mockResolvedValue({});
    try {
      await db.project.createMany({
        data: [
          { id: p, name: 'C11 local isolated' },
          { id: other, name: 'C11 other isolated' },
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
        name: '受控故事',
        synopsis: f.scriptText,
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
          beats: [{ id: 'p1', content: f.scriptText, durationSeconds: 15 }],
        },
      };
      for (const [key, payload, node] of [
        [`customized-script:${scriptId}`, script, 'STORYBOARD'],
        [
          'customized-brief',
          { productName: '陶瓷杯', sellingPoints: ['陶瓷'] },
          'INFORMATION_EXTRACTION',
        ],
      ] as [string, object, string][])
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
      await repo.save(p, r, 0, { assets: f.document.assets, shots: [] }, 'ASSETS', true);
      let w = await repo.workspace(p, r);
      let d = structuredClone(f.document);
      d.assets = w.document.assets;
      d.videoPlan = mergeVideoTaskShots(d.videoPlan, 'clip-a');
      for (let i = 0; i < 4; i++) {
        const shot = { ...structuredClone(d.videoPlan.shots[1]!), id: `extra-s-${i}` };
        d.videoPlan.shots.push(shot);
        d.videoPlan.clips.push({
          ...structuredClone(d.videoPlan.clips[1]!),
          id: `extra-c-${i}`,
          shotIds: [shot.id],
        });
      }
      d.videoPlan.sources = (
        await db.workingArtifact.findMany({ where: { projectId: p, workflowRunId: r } })
      )
        .filter(
          (a) =>
            a.artifactKey === 'customized-asset-catalog' ||
            a.artifactKey === 'customized-brief' ||
            a.artifactKey.startsWith('customized-script:'),
        )
        .map((a) => ({ id: a.id, revision: a.revision, hash: a.contentHash }));
      await repo.save(p, r, w.draftRevision, d, 'SHOTS', true);
      w = await repo.workspace(p, r);
      const body = (v: ProductionVideoDocument) => {
        const { sources: _sources, ...rest } = v.videoPlan;
        return rest;
      };
      const original = body(w.document as ProductionVideoDocument);
      const sibling = await db.workflowRun.create({
        data: {
          projectId: p,
          workflow: 'CUSTOMIZED',
          workflowSpace: 'CUSTOMIZED_PROJECT',
          status: 'PAUSED',
          activeKey: null,
          forkScriptId: scriptId,
          parentWorkflowRunId: r,
        },
      });
      const siblingArtifact = await db.workingArtifact.create({
        data: {
          projectId: p,
          workflowRunId: sibling.id,
          nodeId: 'SHOT_RENDER',
          artifactKey: 'customized-video-plan',
          name: '兄弟原稿',
          kind: 'STRUCTURED',
          directory: 'SCRIPTS',
          type: 'STORYBOARD_SCRIPT',
          payload: { sentinel: true },
          contentHash: workflowStateHash({ sentinel: true }),
        },
      });
      const imageId = randomUUID();
      const image = async (version: number) => {
        const file = {
          originalFileName: 'controlled.png',
          mimeType: 'image/png',
          sizeBytes: 123,
          storageKey: `controlled/${p}/${version}`,
        };
        if (version === 1)
          await db.asset.create({
            data: {
              id: imageId,
              projectId: p,
              name: '受控杯图',
              directory: 'VISUAL_ASSETS',
              type: 'PRODUCT_ASSET',
              storageWorkflow: 'CUSTOMIZED',
              workflowSpace: 'CUSTOMIZED_PROJECT',
              ...file,
            },
          });
        await db.assetVersion.create({
          data: {
            projectId: p,
            assetId: imageId,
            version,
            status: 'AVAILABLE',
            qualityStatus: 'AVAILABLE',
            changeNote: 'controlled',
            ...file,
          },
        });
        await db.fileObject.create({
          data: {
            projectId: p,
            workflowRunId: r,
            nodeId: 'SHOT_PROMPT',
            sha256: String(version).repeat(64),
            ...file,
          },
        });
        return { assetId: imageId, version };
      };
      // Reproduce the already-online old save path without running a model or enqueuing anything.
      d = structuredClone(w.document) as ProductionVideoDocument;
      d.assets[0]!.image = await image(1);
      const draft = await repo.save(p, r, w.draftRevision, d, 'ASSETS', false);
      await db.$transaction((tx) => api.commitAssets(tx, p, r, d));
      expect((await repo.workspace(p, r)).draftRevision).toBe(draft.revision);
      expect(
        (await db.workingArtifact.findFirst({
          where: { projectId: p, workflowRunId: r, artifactKey: 'customized-video-clip:clip-a' },
        }))!.freshness,
      ).toBe('STALE');
      const beforeCount = await db.customizedProductionTask.count({ where: { projectId: p } });
      const task = await repo.start(
        p,
        r,
        draft.revision,
        'PROMPT',
        randomUUID(),
        null,
        { creative: 'controlled', detail: 'controlled' },
        null,
        undefined,
        { target: { kind: 'CLIP', id: 'clip-a' } },
      );
      expect(task.operation).toBe('PROMPT');
      const claim = await repo.claim(p, task.id, 'VIDEO');
      const frozen = claim.input as unknown as ProductionInput;
      expect(frozen.draftRevision).toBeGreaterThan(draft.revision);
      expect(body(frozen.document as ProductionVideoDocument)).toEqual(original);
      expect(
        await db.customizedProductionTask.count({ where: { projectId: p, operation: 'SHOTS' } }),
      ).toBe(0);
      expect(await db.customizedProductionTask.count({ where: { projectId: p } })).toBe(
        beforeCount + 1,
      );
      await repo.action(p, task.id, true);
      w = await repo.workspace(p, r);
      const invalidVersion = structuredClone(w.document);
      invalidVersion.assets[0]!.image = { assetId: imageId, version: 999 };
      await expect(
        repo.save(p, r, w.draftRevision, invalidVersion, 'ASSETS', true),
      ).rejects.toThrow('图片版本不存在');
      expect(isVideoDocument(w.document) && w.document.videoPlan.clips.length).toBe(6);
      expect(body(w.document as ProductionVideoDocument)).toEqual(original);
      // Existing prompt survives a second image-only update; no regenerated prompt or video.
      await repo.savePrompt(p, r, 0, {
        target: { kind: 'CLIP', id: 'clip-a' },
        content: '@陶瓷杯特写。',
        assetIds: ['cup'],
      });
      const promptRow = await db.workingArtifact.findFirstOrThrow({
        where: { projectId: p, workflowRunId: r, artifactKey: 'customized-clip-prompt:clip-a' },
      });
      const oldVideo = await db.workingArtifact.create({
        data: {
          projectId: p,
          workflowRunId: r,
          nodeId: 'SHOT_RENDER',
          artifactKey: 'customized-clip-video:clip-a',
          name: '受控历史视频依赖占位',
          kind: 'STRUCTURED',
          directory: 'SCRIPTS',
          type: 'STORYBOARD_SCRIPT',
          payload: { sentinel: 'unchanged' },
          contentHash: workflowStateHash({ sentinel: 'unchanged' }),
        },
      });
      await db.workingArtifactDependency.create({
        data: {
          projectId: p,
          workflowRunId: r,
          dependentArtifactId: oldVideo.id,
          sourceType: 'WORKING_ARTIFACT',
          sourceArtifactId: promptRow.id,
          sourceNodeId: promptRow.nodeId,
          sourceKey: promptRow.artifactKey,
          sourceRevision: promptRow.revision,
          sourceHash: promptRow.contentHash,
        },
      });
      d = structuredClone(w.document) as ProductionVideoDocument;
      d.assets[0]!.image = await image(2);
      await repo.save(p, r, w.draftRevision, d, 'ASSETS', true);
      w = await repo.workspace(p, r);
      expect(body(w.document as ProductionVideoDocument)).toEqual(original);
      expect(w.prompts[0]!.stale).toBe(false);
      const keptVideo = await db.workingArtifact.findUniqueOrThrow({ where: { id: oldVideo.id } });
      expect(keptVideo.freshness).toBe('STALE');
      expect(keptVideo.revision).toBe(oldVideo.revision);
      expect(keptVideo.payload).toEqual(oldVideo.payload);
      const revisions = await db.workingArtifact.findMany({
        where: { projectId: p, workflowRunId: r },
        orderBy: { artifactKey: 'asc' },
        select: { id: true, revision: true, contentHash: true },
      });
      const unchanged = await repo.save(p, r, w.draftRevision, w.document, 'ASSETS', true);
      expect(unchanged.revision).toBe(w.draftRevision);
      expect(
        await db.workingArtifact.findMany({
          where: { projectId: p, workflowRunId: r },
          orderBy: { artifactKey: 'asc' },
          select: { id: true, revision: true, contentHash: true },
        }),
      ).toEqual(revisions);
      expect(await db.workingArtifact.findUnique({ where: { id: siblingArtifact.id } })).toEqual(
        siblingArtifact,
      );
      const rows = await db.workingArtifact.findMany({ where: { projectId: p, workflowRunId: r } }),
        deps = await db.workingArtifactDependency.findMany({
          where: { projectId: p, workflowRunId: r },
        });
      expect(imageOnlyPlanRebase(other, r, w.document, rows, deps)).toBeNull();
      expect(imageOnlyPlanRebase(p, sibling.id, w.document, rows, deps)).toBeNull();
      // Build a valid pending image-only transition to test the proof's rejection boundaries.
      d = structuredClone(w.document) as ProductionVideoDocument;
      d.assets[0]!.image = await image(3);
      const third = await repo.save(p, r, w.draftRevision, d, 'ASSETS', false);
      await db.$transaction((tx) => api.commitAssets(tx, p, r, d));
      const pendingRows = await db.workingArtifact.findMany({
        where: { projectId: p, workflowRunId: r },
      });
      const pendingDeps = await db.workingArtifactDependency.findMany({
        where: { projectId: p, workflowRunId: r },
      });
      expect(imageOnlyPlanRebase(p, r, d, pendingRows, pendingDeps)).not.toBeNull();
      const edited = structuredClone(d);
      edited.videoPlan.shots[0]!.visual += ' 未保存的分镜修改';
      expect(imageOnlyPlanRebase(p, r, edited, pendingRows, pendingDeps)).toBeNull();
      const oldSource = structuredClone(pendingRows);
      oldSource.find((a) => a.artifactKey === 'customized-brief')!.contentHash = 'f'.repeat(64);
      expect(imageOnlyPlanRebase(p, r, d, oldSource, pendingDeps)).toBeNull();
      const badDeps = structuredClone(pendingDeps);
      badDeps.find((a) => a.sourceKey === 'customized-object:cup')!.sourceHash = 'f'.repeat(64);
      expect(imageOnlyPlanRebase(p, r, d, pendingRows, badDeps)).toBeNull();
      const stalePrompt = structuredClone(pendingDeps);
      stalePrompt.find((a) => a.dependentArtifactId === promptRow.id)!.sourceHash = 'f'.repeat(64);
      expect(
        imageOnlyPlanRebase(p, r, d, pendingRows, stalePrompt)!.steps.some(
          (s) => s.artifact.id === promptRow.id,
        ),
      ).toBe(false);
      const commit = vi.fn();
      const invalidImageTx = {
        workingArtifact: { findMany: vi.fn().mockResolvedValue(pendingRows) },
        workingArtifactDependency: { findMany: vi.fn().mockResolvedValue(pendingDeps) },
        assetVersion: { findFirst: vi.fn().mockResolvedValue(null) },
      } as unknown as Prisma.TransactionClient;
      expect(
        await applyImageOnlyPlanRebase(
          invalidImageTx,
          { commitValidatedArtifactsInTransaction: commit } as unknown as WorkflowWorkingRepository,
          p,
          r,
          d,
        ),
      ).toBeNull();
      expect(commit).not.toHaveBeenCalled();
      const thirdTask = await repo.start(
        p,
        r,
        third.revision,
        'PROMPT',
        randomUUID(),
        null,
        { creative: 'controlled', detail: 'controlled' },
        null,
        undefined,
        { target: { kind: 'CLIP', id: 'clip-a' } },
      );
      await repo.action(p, thirdTask.id, true);
      w = await repo.workspace(p, r);
      await expect(
        repo.start(
          p,
          r,
          third.revision,
          'PROMPT',
          randomUUID(),
          null,
          { creative: 'controlled', detail: 'controlled' },
          null,
          undefined,
          { target: { kind: 'CLIP', id: 'clip-a' } },
        ),
      ).rejects.toThrow('创作依据已变化');
      // C16: explicit duration saves must not invalidate another clip's Prompt/video.
      await repo.savePrompt(p, r, 0, {
        target: { kind: 'CLIP', id: 'clip-b' },
        content: '@陶瓷杯定版。',
        assetIds: ['cup'],
      });
      const neighborPrompt = await db.workingArtifact.findFirstOrThrow({
        where: { projectId: p, workflowRunId: r, artifactKey: 'customized-clip-prompt:clip-b' },
      });
      const neighborClip = await db.workingArtifact.findFirstOrThrow({
        where: { projectId: p, workflowRunId: r, artifactKey: 'customized-video-clip:clip-b' },
      });
      const neighborVideo = await db.workingArtifact.create({
        data: {
          projectId: p,
          workflowRunId: r,
          nodeId: 'SHOT_RENDER',
          artifactKey: 'customized-clip-video:clip-b',
          name: 'C16受控视频依赖占位',
          kind: 'STRUCTURED',
          directory: 'SCRIPTS',
          type: 'STORYBOARD_SCRIPT',
          payload: { sentinel: 'C16-current' },
          contentHash: workflowStateHash({ sentinel: 'C16-current' }),
        },
      });
      for (const source of [neighborPrompt, neighborClip])
        await db.workingArtifactDependency.create({
          data: {
            projectId: p,
            workflowRunId: r,
            dependentArtifactId: neighborVideo.id,
            sourceType: 'WORKING_ARTIFACT',
            sourceArtifactId: source.id,
            sourceNodeId: source.nodeId,
            sourceKey: source.artifactKey,
            sourceRevision: source.revision,
            sourceHash: source.contentHash,
          },
        });
      const neighborsBefore = [neighborPrompt, neighborClip, neighborVideo];
      w = await repo.workspace(p, r);
      for (const duration of [10.5, 11]) {
        d = structuredClone(w.document) as ProductionVideoDocument;
        d.videoPlan.shots[0]!.durationSeconds = duration;
        await repo.save(p, r, w.draftRevision, d, 'SHOTS', true);
        w = await repo.workspace(p, r);
        expect((w.document as ProductionVideoDocument).videoPlan.shots[0]!.durationSeconds).toBe(
          duration,
        );
        expect(
          w.prompts.find((v) => 'target' in v.value && v.value.target.id === 'clip-a')!.stale,
        ).toBe(true);
        for (const before of neighborsBefore) {
          const after = await db.workingArtifact.findUniqueOrThrow({ where: { id: before.id } });
          expect(after.freshness).toBe('CURRENT');
          expect(after.revision).toBe(before.revision);
          expect(after.contentHash).toBe(before.contentHash);
          expect(after.payload).toEqual(before.payload);
        }
      }
      const timingRows = await db.workingArtifact.findMany({
        where: { projectId: p, workflowRunId: r },
        orderBy: { artifactKey: 'asc' },
      });
      const sameDuration = await repo.save(p, r, w.draftRevision, w.document, 'SHOTS', true);
      expect(sameDuration.revision).toBe(w.draftRevision);
      expect(
        await db.workingArtifact.findMany({
          where: { projectId: p, workflowRunId: r },
          orderBy: { artifactKey: 'asc' },
        }),
      ).toEqual(timingRows);
      expect(await db.workingArtifact.findUnique({ where: { id: siblingArtifact.id } })).toEqual(
        siblingArtifact,
      );
      // C17: real locked explicit retry archives once, keeps the Task/sources,
      // and rejects old-attempt callbacks before they can replace the output.
      const recoveryTask = await repo.start(
        p,
        r,
        w.draftRevision,
        'PROMPT',
        randomUUID(),
        null,
        { creative: 'controlled', detail: 'controlled' },
        null,
        undefined,
        { target: { kind: 'CLIP', id: 'clip-b' } },
      );
      const firstClaim = await repo.claim(p, recoveryTask.id, 'VIDEO');
      const frozenRecovery = await db.customizedProductionTask.findUniqueOrThrow({
        where: { id: recoveryTask.id },
      });
      const auditCandidate = {
        summary: '受控审校',
        checks: [],
        resolutions: [],
        promptEvidence: [],
        findings: [
          {
            id: 'A1',
            severity: 'ERROR',
            category: 'COVERAGE',
            repairKind: 'FIELDS',
            title: '受控问题',
            impact: '受控影响',
            suggestedFix: '核对引用',
            evidence: [{ entity: 'PROMPT', id: 'clip-b', field: 'content' }],
            affectedShotIds: [],
            affectedClipIds: ['clip-b'],
          },
        ],
      };
      const failedAudit = {
        value: {
          target: { kind: 'CLIP', id: 'clip-b' },
          content: '受控原提示词',
          assetIds: ['cup'],
        },
        audit: auditCandidate,
        auditCorrected: {
          ...auditCandidate,
          promptEvidence: [{ issueId: 'A1', excerpt: '受控不匹配原句' }],
        },
        mechanicalErrors: { audit: 'invalid field', auditCorrected: 'invalid quote' },
        corrections: { audit: 1 },
        failureReason: 'INVALID_CANDIDATE',
      };
      const failedStep = {
        id: 'REVIEW',
        status: 'FAILED' as const,
        title: '受控审校',
        content: '受控机械失败',
      };
      await repo.checkpoint(
        p,
        recoveryTask.id,
        firstClaim.attemptToken!,
        failedStep,
        failedAudit,
        'VIDEO',
      );
      await repo.fail(p, recoveryTask.id, firstClaim.attemptToken!, false, 'VIDEO');
      const taskCount = await db.customizedProductionTask.count({ where: { projectId: p } });
      const recoveryArtifacts = await db.workingArtifact.findMany({
        where: { projectId: p },
        orderBy: { id: 'asc' },
      });
      await Promise.all([
        repo.action(p, recoveryTask.id, false),
        repo.action(p, recoveryTask.id, false),
      ]);
      let recovered = await db.customizedProductionTask.findUniqueOrThrow({
        where: { id: recoveryTask.id },
      });
      expect(recovered.inputSnapshot).toEqual(frozenRecovery.inputSnapshot);
      expect(recovered.output).toMatchObject({
        value: failedAudit.value,
        mechanicalRecovery: { epoch: 1, phase: 'audit' },
      });
      const firstOutput = recovered.output as Record<string, unknown>;
      expect((firstOutput.mechanicalRecovery as { history: unknown[] }).history).toHaveLength(1);
      await expect(
        repo.checkpoint(
          p,
          recoveryTask.id,
          firstClaim.attemptToken!,
          failedStep,
          failedAudit,
          'VIDEO',
        ),
      ).rejects.toThrow('租约失效');
      const nextClaim = await repo.claim(p, recoveryTask.id, 'VIDEO');
      await expect(
        repo.checkpoint(
          p,
          recoveryTask.id,
          firstClaim.attemptToken!,
          failedStep,
          failedAudit,
          'VIDEO',
        ),
      ).rejects.toThrow('租约失效');
      await expect(
        repo.checkpoint(
          p,
          recoveryTask.id,
          nextClaim.attemptToken!,
          failedStep,
          failedAudit,
          'VIDEO',
        ),
      ).rejects.toThrow('恢复轮次不匹配');
      await repo.checkpoint(
        p,
        recoveryTask.id,
        nextClaim.attemptToken!,
        failedStep,
        {
          ...firstOutput,
          auditCorrected: failedAudit.auditCorrected,
          corrections: { audit: 1 },
          mechanicalErrors: { auditCorrected: 'still invalid quote' },
          failureReason: 'INVALID_CANDIDATE',
        },
        'VIDEO',
      );
      await repo.fail(p, recoveryTask.id, nextClaim.attemptToken!, false, 'VIDEO');
      await repo.action(p, recoveryTask.id, false);
      recovered = await db.customizedProductionTask.findUniqueOrThrow({
        where: { id: recoveryTask.id },
      });
      expect(recovered.output).toMatchObject({ mechanicalRecovery: { epoch: 2 } });
      expect(
        ((recovered.output as Record<string, unknown>).mechanicalRecovery as { history: unknown[] })
          .history,
      ).toHaveLength(2);
      expect(await db.customizedProductionTask.count({ where: { projectId: p } })).toBe(taskCount);
      expect(
        await db.workingArtifact.findMany({ where: { projectId: p }, orderBy: { id: 'asc' } }),
      ).toEqual(recoveryArtifacts);
      await repo.action(p, recoveryTask.id, true);
      // A real text definition change must keep downstream content stale and reject PROMPT.
      d = structuredClone(w.document) as ProductionVideoDocument;
      d.assets[0]!.description += ' 实际文字定义变化';
      const changed = await repo.save(p, r, w.draftRevision, d, 'ASSETS', true);
      const count = await db.customizedProductionTask.count({ where: { projectId: p } });
      await expect(
        repo.start(
          p,
          r,
          changed.revision,
          'PROMPT',
          randomUUID(),
          null,
          { creative: 'controlled', detail: 'controlled' },
          null,
          undefined,
          { target: { kind: 'CLIP', id: 'clip-a' } },
        ),
      ).rejects.toThrow('请先保存当前片段和分镜');
      expect(await db.customizedProductionTask.count({ where: { projectId: p } })).toBe(count);
      expect((await repo.workspace(p, r)).prompts[0]!.stale).toBe(true);
      expect(outbox).toHaveBeenCalledTimes(5);
      expect(await db.workflowRun.count({ where: { projectId: p } })).toBe(2);
      expect(await db.jobOutbox.count({ where: { projectId: p } })).toBe(0);
    } finally {
      outbox.mockRestore();
      await db.workingArtifactDependency.deleteMany({ where: { projectId: p } });
      await db.workingArtifactRevisionSnapshot.deleteMany({ where: { projectId: p } });
      await db.assetVersion.deleteMany({ where: { projectId: p } });
      await db.asset.deleteMany({ where: { projectId: p } });
      await db.project.deleteMany({ where: { id: { in: [p, other] } } });
      const scope = { projectId: { in: [p, other] } };
      expect(
        await Promise.all([
          db.project.count({ where: { id: { in: [p, other] } } }),
          db.workingArtifact.count({ where: scope }),
          db.workflowRun.count({ where: scope }),
          db.customizedProductionTask.count({ where: scope }),
          db.asset.count({ where: scope }),
          db.assetVersion.count({ where: scope }),
          db.fileObject.count({ where: scope }),
          db.jobOutbox.count({ where: scope }),
        ]),
      ).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
      await db.$disconnect();
    }
  },
  30000,
);
