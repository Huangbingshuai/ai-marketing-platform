import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { expect, it, vi } from 'vitest';
import {
  CUSTOMIZED_EXTRACTION_NODES,
  emptyCustomizedBrief,
  type CustomizedBriefCandidate,
  emptyCustomizedImportDraft,
} from '@ai-marketing/contracts';
import { PrismaService } from '../../../database/prisma.service';
import { WorkflowWorkingRepository } from '../../../platform/workflow/workflow-working.repository';
import { workflowStateHash } from '../../../platform/workflow/workflow-state-hash';
import { EffectCacheRevisionService } from '../../../platform/cache/effect-cache-revision.service';
import { CustomizedExtractionRepository } from './customized-extraction.repository';
import type { Prisma } from '../../../generated/prisma/client';

// Disposable database records only. No Outbox dispatcher, Worker or model is started.
it.skipIf(process.env.CUSTOMIZED_EXTRACTION_DATABASE_TEST !== '1')(
  'preserves task leases, checkpoints, overrides, source revisions and isolated versions',
  async () => {
    const db = new PrismaService(
      new ConfigService({
        DATABASE_URL:
          process.env.DATABASE_URL ??
          'postgresql://postgres:postgres@localhost:5432/ai_marketing?schema=public',
      }),
    );
    const working = new WorkflowWorkingRepository(db);
    const repo = new CustomizedExtractionRepository(db, working);
    // Another API process may dispatch this development database. Suppress test delivery
    // inside the transaction while retaining real Outbox creation and idempotency.
    const target = repo as unknown as {
      enqueue(
        tx: Prisma.TransactionClient,
        task: { id: string; projectId: string },
      ): Promise<{ id: string }>;
    };
    const enqueue = target.enqueue.bind(repo);
    const outbox = vi.spyOn(target, 'enqueue').mockImplementation(async (tx, task) => {
      const record = await enqueue(tx, task);
      return tx.jobOutbox.update({
        where: { id: record.id },
        data: { status: 'PUBLISHED', publishedAt: new Date() },
      });
    });
    const versions = new EffectCacheRevisionService(db);
    const projectId = randomUUID(),
      otherProjectId = randomUUID(),
      documentId = randomUUID();
    let runId = '';
    try {
      await db.project.createMany({
        data: [
          { id: projectId, name: 'Disposable customized extraction fixture' },
          { id: otherProjectId, name: 'Disposable isolation fixture' },
        ],
      });
      const run = await working.initializeCustomizedRun(projectId);
      runId = run.id;
      const asset = await db.asset.create({
        data: {
          id: documentId,
          projectId,
          name: '简报',
          directory: 'SOURCE_MATERIALS',
          type: 'SOURCE_MATERIAL',
          storageWorkflow: 'CUSTOMIZED',
          workflowSpace: 'CUSTOMIZED_PROJECT',
          originalFileName: '简报.docx',
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          storageKey: `test/${projectId}/brief.docx`,
          sizeBytes: 20,
        },
      });
      await db.assetVersion.create({
        data: {
          projectId,
          assetId: asset.id,
          version: 1,
          changeNote: 'test',
          status: 'AVAILABLE',
          qualityStatus: 'AVAILABLE',
          originalFileName: asset.originalFileName,
          mimeType: asset.mimeType,
          storageKey: asset.storageKey,
          sizeBytes: 20,
        },
      });
      const sourcePayload = {
        ...emptyCustomizedImportDraft(),
        materials: [{ assetId: documentId, assetVersion: 1, category: 'BRIEF' as const }],
      };
      const source = await db.workingArtifact.create({
        data: {
          projectId,
          workflowRunId: runId,
          nodeId: 'SOURCE_IMPORT',
          artifactKey: 'customized-source-package',
          name: '简报',
          kind: 'STRUCTURED',
          directory: 'SOURCE_MATERIALS',
          type: 'SOURCE_MATERIAL',
          payload: sourcePayload,
          contentHash: workflowStateHash(sourcePayload),
        },
      });
      const create = (idempotencyKey = randomUUID()) =>
        repo.start(projectId, {
          workflowRunId: runId,
          sourceArtifactId: source.id,
          sourceRevision: 1,
          idempotencyKey,
        });
      const key = randomUUID();
      const [first, duplicate] = await Promise.all([create(key), create(key)]);
      expect(first.id).toBe(duplicate.id);
      expect(await db.jobOutbox.count({ where: { projectId } })).toBe(1);
      expect(await db.jobOutbox.count({ where: { projectId, status: 'PENDING' } })).toBe(0);
      await expect(repo.task(otherProjectId, first.id)).rejects.toThrow();
      expect(
        (
          await versions.read(
            { projectId, workflow: 'CUSTOMIZED', workflowRunId: runId },
            'customized-extraction',
          )
        )?.active,
      ).toBe(true);
      const claim = await repo.claim(projectId, first.id);
      const token = claim.attemptToken!;
      expect((await repo.claim(projectId, first.id)).busy).toBe(true);
      await expect(
        repo.progress(projectId, first.id, randomUUID(), 20, 'DOCUMENT_PARSE'),
      ).rejects.toThrow();
      await repo.step(
        projectId,
        first.id,
        token,
        'DOCUMENT_PARSE',
        documentId,
        'SUCCEEDED',
        { parsed: true },
        null,
      );
      await repo.fail(projectId, first.id, token, true, 'fixture partial failure');
      await expect(
        repo.fail(projectId, first.id, token, true, 'fixture partial failure'),
      ).resolves.toBeDefined();
      await expect(
        repo.complete(projectId, first.id, token, {
          fields: emptyCustomizedBrief(),
          fieldSources: {},
          issues: [],
        }),
      ).rejects.toThrow();
      await repo.retry(projectId, first.id);
      const secondClaim = await repo.claim(projectId, first.id);
      expect(secondClaim.checkpoints).toHaveLength(1);
      expect(secondClaim.attemptToken).not.toBe(token);
      await expect(
        repo.step(projectId, first.id, token, 'FUSION', '', 'SUCCEEDED', {}, null),
      ).rejects.toThrow();
      const candidate: CustomizedBriefCandidate = {
        fields: {
          ...emptyCustomizedBrief(),
          brandName: '梅间',
          productName: '青梅酱',
          sellingPoints: ['清爽青梅香', '保留果肉质感'],
        },
        fieldSources: {
          productName: [{ assetId: documentId, assetVersion: 1, location: '产品名称' }],
          sellingPoints: [0, 1].map((itemIndex) => ({
            assetId: documentId,
            assetVersion: 1,
            location: '核心卖点',
            itemIndex,
          })),
        },
        issues: [],
      };
      const finish = async (taskId: string, attempt: string, content = candidate) => {
        for (const node of CUSTOMIZED_EXTRACTION_NODES)
          await repo.step(projectId, taskId, attempt, node.id, '', 'SUCCEEDED', {}, null);
        await repo.step(
          projectId,
          taskId,
          attempt,
          'DOCUMENT_EXTRACT',
          documentId,
          'SUCCEEDED',
          content,
          null,
        );
        return repo.complete(projectId, taskId, attempt, content);
      };
      const completed = await finish(first.id, secondClaim.attemptToken!);
      await expect(
        repo.complete(projectId, first.id, secondClaim.attemptToken!, candidate),
      ).resolves.toEqual(completed);
      await expect(
        repo.complete(projectId, first.id, secondClaim.attemptToken!, {
          ...candidate,
          fields: { ...candidate.fields, productName: 'another' },
        }),
      ).rejects.toThrow();
      const draft = (await repo.workspace(projectId, runId)).result!;
      expect(draft.revision).toBe(1);
      const manual = { ...draft.fields, productName: '人工名称', sellingPoints: ['人工确认卖点'] };
      const saved = await repo.update(projectId, draft.id, {
        expectedRevision: draft.revision,
        fields: manual,
        resolvedIssueIds: [],
      });
      await expect(
        repo.update(projectId, draft.id, {
          expectedRevision: draft.revision,
          fields: draft.fields,
          resolvedIssueIds: [],
        }),
      ).rejects.toThrow();
      const again = await repo.update(projectId, draft.id, {
        expectedRevision: saved.revision,
        fields: manual,
        resolvedIssueIds: [],
      });
      expect(again.revision).toBe(saved.revision);
      const rerun = await create();
      const rerunClaim = await repo.claim(projectId, rerun.id);
      await finish(rerun.id, rerunClaim.attemptToken!);
      const afterRerun = (await repo.workspace(projectId, runId)).result!;
      expect(afterRerun.fields).toEqual(manual);
      expect(afterRerun.fieldSources.productName).toBeUndefined();
      expect(afterRerun.fieldSources.sellingPoints).toBeUndefined();
      await repo.confirm(projectId, afterRerun.id, afterRerun.revision);
      const committed = await db.workingArtifact.findFirstOrThrow({
        where: { projectId, workflowRunId: runId, artifactKey: 'customized-brief' },
        include: { dependencies: true },
      });
      expect(committed.revision).toBe(1);
      expect(committed.dependencies[0]?.sourceArtifactId).toBe(source.id);
      await db.assetVersion.updateMany({
        where: { projectId, assetId: documentId },
        data: { status: 'UNAVAILABLE' },
      });
      const unavailable = await repo.workspace(projectId, runId);
      expect(unavailable.result?.fields).toEqual(manual);
      expect(unavailable.stale).toBe(true);
      expect(unavailable.sourceWarnings).toHaveLength(1);
      await expect(create()).rejects.toThrow();
      await db.assetVersion.updateMany({
        where: { projectId, assetId: documentId },
        data: { status: 'AVAILABLE' },
      });
      expect(
        (
          await versions.read(
            { projectId, workflow: 'CUSTOMIZED', workflowRunId: runId },
            'customized-extraction',
          )
        )?.active,
      ).toBe(false);
      // Unchanged edit returns to parent, publishes no empty branch and retains revision.
      const hidden = await repo.beginEdit(projectId, runId);
      const hiddenResult = (await repo.workspace(projectId, hidden.id)).result!;
      const unchanged = await repo.confirm(projectId, hiddenResult.id, hiddenResult.revision);
      expect(unchanged).toEqual({ workflowRunId: runId, unchanged: true });
      expect(await db.workflowRun.count({ where: { projectId } })).toBe(1);
      // Changed save publishes only this child, leaving its parent unchanged.
      const edit = await repo.beginEdit(projectId, runId);
      const editResult = (await repo.workspace(projectId, edit.id)).result!;
      const changed = await repo.update(projectId, editResult.id, {
        expectedRevision: editResult.revision,
        fields: { ...editResult.fields, brandTone: '自然克制' },
        resolvedIssueIds: [],
      });
      const publication = await repo.confirm(projectId, editResult.id, changed.revision);
      expect(publication.unchanged).toBe(false);
      expect((await repo.workspace(projectId, runId)).result!.fields.brandTone).toBe('');
      runId = edit.id;
      const published = await db.workingArtifact.findFirstOrThrow({
        where: { projectId, workflowRunId: runId, artifactKey: 'customized-brief' },
      });
      expect(published.revision).toBe(2);
      // Two changed source revisions invalidate old results and clear every manual override.
      for (const revision of [2, 3]) {
        const currentSource = await db.workingArtifact.findFirstOrThrow({
          where: { projectId, workflowRunId: runId, artifactKey: 'customized-source-package' },
        });
        await db.workingArtifact.update({
          where: { id: currentSource.id },
          data: { revision, contentHash: workflowStateHash({ sourcePayload, revision }) },
        });
        await db.workingArtifact.updateMany({
          where: { projectId, workflowRunId: runId, artifactKey: 'customized-brief' },
          data: { freshness: 'STALE' },
        });
        expect((await repo.workspace(projectId, runId)).stale).toBe(true);
        await expect(
          repo.confirm(
            projectId,
            (await repo.workspace(projectId, runId)).result!.id,
            (await repo.workspace(projectId, runId)).result!.revision,
          ),
        ).rejects.toThrow();
        const child = await repo.beginEdit(projectId, runId);
        runId = child.id;
        const input = (await repo.workspace(projectId, runId)).source!;
        const task = await repo.start(projectId, {
          workflowRunId: runId,
          sourceArtifactId: input.artifactId,
          sourceRevision: input.revision,
          idempotencyKey: randomUUID(),
        });
        const lease = await repo.claim(projectId, task.id);
        await finish(task.id, lease.attemptToken!);
        const freshWorkspace = await repo.workspace(projectId, runId);
        expect(freshWorkspace.stale).toBe(false);
        expect(
          await db.workingArtifact.findFirst({
            where: { projectId, workflowRunId: runId, artifactKey: 'customized-brief' },
          }),
        ).toMatchObject({ freshness: 'STALE' });
        const fresh = freshWorkspace.result!;
        expect(fresh.fields.productName).toBe('青梅酱');
        expect(fresh.fields.sellingPoints).toEqual(candidate.fields.sellingPoints);
        await repo.confirm(projectId, fresh.id, fresh.revision);
      }
      // Cancelling an in-flight hidden edit removes its task and schedules parsed-file cleanup.
      const cancelled = await repo.beginEdit(projectId, runId);
      const input = (await repo.workspace(projectId, cancelled.id)).source!;
      const task = await repo.start(projectId, {
        workflowRunId: cancelled.id,
        sourceArtifactId: input.artifactId,
        sourceRevision: input.revision,
        idempotencyKey: randomUUID(),
      });
      const lease = await repo.claim(projectId, task.id);
      await repo.artifact(
        projectId,
        task.id,
        lease.attemptToken!,
        documentId,
        `test/${projectId}/parsed.txt`,
        5,
      );
      await repo.cancelEdit(projectId, cancelled.id);
      await expect(
        repo.progress(projectId, task.id, lease.attemptToken!, 50, 'FUSION'),
      ).rejects.toThrow();
      expect(await db.storageCleanupTask.count({ where: { projectId } })).toBe(1);
    } finally {
      outbox.mockRestore();
      await db.workingArtifactDependency.deleteMany({ where: { projectId } });
      await db.assetVersion.deleteMany({ where: { projectId } });
      await db.asset.deleteMany({ where: { projectId } });
      await db.project.deleteMany({ where: { id: { in: [projectId, otherProjectId] } } });
      await db.$disconnect();
    }
  },
  90000,
);
