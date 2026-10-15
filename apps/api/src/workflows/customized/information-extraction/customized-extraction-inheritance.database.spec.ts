import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { expect, it } from 'vitest';
import {
  emptyCustomizedBrief,
  emptyCustomizedImportDraft,
  type CustomizedBriefCandidate,
} from '@ai-marketing/contracts';
import { PrismaService } from '../../../database/prisma.service';
import { Prisma } from '../../../generated/prisma/client';
import { WorkflowWorkingRepository } from '../../../platform/workflow/workflow-working.repository';
import { workflowStateHash } from '../../../platform/workflow/workflow-state-hash';
import { CustomizedExtractionRepository } from './customized-extraction.repository';

// Isolated test project, no Outbox or Worker/model calls. Historical branch shape is intentional.
it.skipIf(process.env.CUSTOMIZED_EXTRACTION_DATABASE_TEST !== '1')(
  'restores source and extraction in historical script branches without mutating confirmed lineage',
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
    const projectId = randomUUID();
    try {
      await db.project.create({
        data: { id: projectId, name: 'Disposable upstream inheritance regression' },
      });
      const root = await working.initializeCustomizedRun(projectId);
      const asset = await db.asset.create({
        data: {
          projectId,
          name: '简报',
          directory: 'SOURCE_MATERIALS',
          type: 'SOURCE_MATERIAL',
          storageWorkflow: 'CUSTOMIZED',
          workflowSpace: 'CUSTOMIZED_PROJECT',
          originalFileName: '简报.txt',
          mimeType: 'text/plain',
          storageKey: `test/${projectId}/brief.txt`,
          sizeBytes: 20,
        },
      });
      await db.assetVersion.create({
        data: {
          projectId,
          assetId: asset.id,
          version: 1,
          changeNote: 'fixture',
          status: 'AVAILABLE',
          qualityStatus: 'AVAILABLE',
          originalFileName: asset.originalFileName,
          mimeType: asset.mimeType,
          storageKey: asset.storageKey,
          sizeBytes: 20,
        },
      });
      const payload = {
        ...emptyCustomizedImportDraft(),
        materials: [{ assetId: asset.id, assetVersion: 1, category: 'BRIEF' as const }],
      };
      const source = await db.workingArtifact.create({
        data: {
          projectId,
          workflowRunId: root.id,
          nodeId: 'SOURCE_IMPORT',
          artifactKey: 'customized-source-package',
          name: '资料包',
          kind: 'STRUCTURED',
          directory: 'SOURCE_MATERIALS',
          type: 'SOURCE_MATERIAL',
          payload,
          contentHash: workflowStateHash(payload),
        },
      });
      const fingerprint = workflowStateHash({ artifactId: source.id, revision: 1, payload });
      const candidate: CustomizedBriefCandidate = {
        fields: {
          ...emptyCustomizedBrief(),
          productName: '固定版充电器',
          sellingPoints: ['折叠插脚'],
        },
        fieldSources: { productName: [{ assetId: asset.id, assetVersion: 1, location: '正文' }] },
        issues: [],
      };
      const task = await db.customizedExtractionTask.create({
        data: {
          projectId,
          workflowRunId: root.id,
          idempotencyKey: randomUUID(),
          inputHash: fingerprint,
          inputSnapshot: {},
          status: 'COMPLETED',
          progress: 100,
        },
      });
      const originalResult = await db.customizedExtractionResult.create({
        data: {
          projectId,
          workflowRunId: root.id,
          taskId: task.id,
          sourceFingerprint: fingerprint,
          generatedResult: candidate as unknown as Prisma.InputJsonValue,
          draftResult: candidate as unknown as Prisma.InputJsonValue,
        },
      });
      await repo.confirm(projectId, originalResult.id, 1);

      async function scriptBranch(parentId: string) {
        const run = await db.workflowRun.create({
          data: {
            projectId,
            workflow: 'CUSTOMIZED',
            workflowSpace: 'CUSTOMIZED_PROJECT',
            parentWorkflowRunId: parentId,
            forkNodeId: 'STORYBOARD',
            currentNodeId: 'STORYBOARD',
            activeKey: null,
            status: 'PAUSED',
            branchPublishedAt: new Date(),
          },
        });
        const originals = await db.workingArtifact.findMany({
          where: { projectId, workflowRunId: parentId },
          include: { dependencies: true },
        });
        const copies = new Map<string, string>();
        for (const a of originals) {
          const {
            id,
            createdAt: _created,
            updatedAt: _updated,
            dependencies: _dependencies,
            ...data
          } = a;
          const copy = await db.workingArtifact.create({
            data: {
              ...data,
              workflowRunId: run.id,
              sourceArtifactId: a.sourceArtifactId ?? id,
              sourceRunId: a.sourceRunId ?? parentId,
              payload: a.payload as Prisma.InputJsonValue,
              metadata:
                a.metadata === null ? Prisma.JsonNull : (a.metadata as Prisma.InputJsonValue),
            },
          });
          copies.set(id, copy.id);
        }
        for (const a of originals) {
          for (const d of a.dependencies) {
            if (d.sourceType === 'WORKING_ARTIFACT' && d.sourceKey === a.artifactKey) continue;
            const { id: _id, createdAt: _created, ...data } = d;
            await db.workingArtifactDependency.create({
              data: {
                ...data,
                workflowRunId: run.id,
                dependentArtifactId: copies.get(a.id)!,
                sourceArtifactId: d.sourceArtifactId
                  ? (copies.get(d.sourceArtifactId) ?? d.sourceArtifactId)
                  : null,
              },
            });
          }
          await db.workingArtifactDependency.create({
            data: {
              projectId,
              workflowRunId: run.id,
              dependentArtifactId: copies.get(a.id)!,
              sourceType: 'WORKING_ARTIFACT',
              sourceArtifactId: a.id,
              sourceNodeId: a.nodeId,
              sourceKey: a.artifactKey,
              sourceRevision: a.revision,
              sourceHash: a.contentHash,
            },
          });
        }
        return run;
      }
      const branch = await scriptBranch(root.id);
      const nested = await scriptBranch(branch.id);
      const sibling = await scriptBranch(root.id);
      await db.workflowRun.update({
        where: { id: root.id },
        data: { activeKey: null, status: 'PAUSED' },
      });
      await db.workflowRun.update({
        where: { id: nested.id },
        data: { activeKey: 'ACTIVE', status: 'ACTIVE' },
      });
      const before = await db.workingArtifact.findMany({
        where: { projectId },
        orderBy: { id: 'asc' },
      });
      for (const id of [branch.id, nested.id, sibling.id, nested.id]) {
        const workspace = await repo.workspace(projectId, id);
        expect(workspace.result?.fields).toEqual(candidate.fields);
        expect(workspace.task?.id).toBe(task.id);
        expect(workspace).toMatchObject({ committed: true, editing: false, stale: false });
      }
      expect(await db.workflowNodeState.count({ where: { projectId } })).toBe(0);
      expect(await db.customizedExtractionResult.count({ where: { projectId } })).toBe(1);
      expect(
        await db.workingArtifact.findMany({ where: { projectId }, orderBy: { id: 'asc' } }),
      ).toEqual(before);
      // Explicit edit restores local mutable records; refresh reads that record, unchanged confirm returns.
      const edit = await repo.beginEdit(projectId, nested.id);
      const restored = (await repo.workspace(projectId, edit.id)).result!;
      expect(restored.id).not.toBe(originalResult.id);
      expect(restored.fields).toEqual(candidate.fields);
      expect((await repo.workspace(projectId, edit.id)).result?.id).toBe(restored.id);
      expect(await repo.confirm(projectId, restored.id, restored.revision)).toEqual({
        workflowRunId: nested.id,
        unchanged: true,
      });
      await expect(
        repo.update(projectId, restored.id, {
          expectedRevision: restored.revision,
          fields: candidate.fields,
          resolvedIssueIds: [],
        }),
      ).rejects.toThrow();

      // Source draft is absent in the script branch, yet unchanged save/cancel must work.
      for (const cancel of [false, true]) {
        const sourceEdit = await working.beginCustomizedNodeEdit(projectId, nested.id);
        const state = await db.workflowNodeState.findFirstOrThrow({
          where: { projectId, workflowRunId: sourceEdit.id, nodeId: 'SOURCE_IMPORT' },
        });
        expect(state.state).toEqual(payload);
        if (cancel) await working.cancelCustomizedNodeEdit(projectId, sourceEdit.id);
        else
          expect(
            (await working.saveCustomizedSourceVersion(projectId, sourceEdit.id, state.revision))
              .unchanged,
          ).toBe(true);
      }

      // Advancing an ancestor twice cannot rewrite frozen fields or attach new-source evidence.
      for (const revision of [2, 3]) {
        await db.customizedExtractionResult.update({
          where: { id: originalResult.id },
          data: {
            revision,
            sourceFingerprint: workflowStateHash({ revision }),
            draftResult: {
              ...candidate,
              fields: { ...candidate.fields, productName: `祖先第${revision}版` },
            } as unknown as Prisma.InputJsonValue,
          },
        });
        const frozen = await repo.workspace(projectId, nested.id);
        expect(frozen.result?.fields).toEqual(candidate.fields);
        expect(frozen.result?.fieldSources).toEqual({});
        expect(frozen.task).toBeNull();
        const child = await repo.beginEdit(projectId, nested.id);
        const own = (await repo.workspace(projectId, child.id)).result!;
        expect(own.fields).toEqual(candidate.fields);
        await repo.cancelEdit(projectId, child.id);
      }
      expect(await db.jobOutbox.count({ where: { projectId } })).toBe(0);
      expect(
        await db.workingArtifact.findMany({ where: { projectId }, orderBy: { id: 'asc' } }),
      ).toEqual(before);
      // Changed confirmation publishes only the restored edit, keeping both script siblings frozen.
      const changedEdit = await repo.beginEdit(projectId, nested.id);
      const editable = (await repo.workspace(projectId, changedEdit.id)).result!;
      const saved = await repo.update(projectId, editable.id, {
        expectedRevision: editable.revision,
        fields: { ...editable.fields, brandTone: '新的品牌调性' },
        resolvedIssueIds: [],
      });
      expect(await repo.confirm(projectId, editable.id, saved.revision)).toEqual({
        workflowRunId: changedEdit.id,
        unchanged: false,
      });
      expect((await repo.workspace(projectId, nested.id)).result?.fields).toEqual(candidate.fields);
      expect((await repo.workspace(projectId, sibling.id)).result?.fields).toEqual(
        candidate.fields,
      );
      expect(
        (
          await db.workingArtifact.findFirstOrThrow({
            where: {
              projectId,
              workflowRunId: changedEdit.id,
              artifactKey: 'customized-brief',
            },
          })
        ).revision,
      ).toBe(2);
    } finally {
      await db.workingArtifactDependency.deleteMany({ where: { projectId } });
      await db.assetVersion.deleteMany({ where: { projectId } });
      await db.asset.deleteMany({ where: { projectId } });
      await db.project.deleteMany({ where: { id: projectId } });
      await db.$disconnect();
    }
  },
  90000,
);
