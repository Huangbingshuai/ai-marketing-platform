import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { expect, it } from 'vitest';
import { PrismaService } from '../../database/prisma.service';
import type { Prisma } from '../../generated/prisma/client';
import { WorkflowWorkingRepository } from './workflow-working.repository';
import { WorkflowWorkingService } from './workflow-working.service';
import { EffectTemplateMixService } from '../../workflows/effect/template-mix/effect-template-mix.service';
import { effectTemplateMixSourceChanges } from '@ai-marketing/contracts';

it.skipIf(process.env.EFFECT_OUTPUT_DATABASE_TEST !== '1')(
  'new imports preserve six sibling-bound slots and a confirmed repair while exposing only additions to append',
  async () => {
    const db = new PrismaService(
      new ConfigService({
        DATABASE_URL:
          process.env.DATABASE_URL ??
          'postgresql://postgres:postgres@localhost:5432/ai_marketing?schema=public',
      }),
    );
    const rollback = new Error('ADDED_MATERIALS_ROLLBACK');
    try {
      await expect(
        db.$transaction(async (tx) => {
          const projectId = randomUUID(),
            root = randomUUID(),
            edited = randomUUID(),
            sibling = randomUUID(), repairRun = randomUUID();
          const templateId = randomUUID(),
            emptyId = randomUUID();
          await tx.project.create({ data: { id: projectId, name: '新增素材来源回滚验收' } });
          await tx.workflowRun.create({
            data: {
              id: root,
              projectId,
              workflow: 'EFFECT',
              workflowSpace: 'EFFECT',
              activeKey: 'ACTIVE',
            },
          });
          for (const id of [edited, sibling, repairRun])
            await tx.workflowRun.create({
              data: {
                id,
                projectId,
                workflow: 'EFFECT',
                workflowSpace: 'EFFECT',
                parentWorkflowRunId: root,
                forkNodeId: 'TEMPLATE_MIX',
                branchPublishedAt: new Date(),
                activeKey: null,
              },
            });
          const batch = (run: string, revision: number, clips: Prisma.InputJsonValue[]) => ({
            projectId,
            workflowRunId: run,
            nodeId: 'SEGMENT_RENDER',
            artifactKey: `render-batch:${randomUUID()}`,
            kind: 'STRUCTURED' as const,
            name: '素材池',
            directory: 'EDITING_PROJECTS' as const,
            type: 'TIMELINE_PROJECT' as const,
            revision,
            payload: { clips },
            contentHash: 'a'.repeat(64),
          });
          const oldBindings: Record<string, string> = {};
          const rootClips: Prisma.InputJsonValue[] = [];
          const editedClips: Prisma.InputJsonValue[] = [];
          const oldPrompts: string[] = [];
          const roles = ['HOOK', 'PAIN_POINT', 'PRODUCT', 'SELLING_POINT', 'TRANSFORMATION', 'END'];
          let repairedId = '';
          let obsoleteEndId = '';
          for (const role of roles) {
            const promptId = randomUUID(), originalTask = randomUUID(), copiedTask = randomUUID();
            oldPrompts.push(promptId);
            const file = await tx.fileObject.create({ data: { projectId, workflowRunId: root,
              nodeId: 'SEGMENT_RENDER', originalFileName: `${role}.mp4`, mimeType: 'video/mp4',
              sizeBytes: 64, storageKey: `test/${projectId}/${role}.mp4`, sha256: 'd'.repeat(64) } });
            const data = { projectId, nodeId: 'SEGMENT_RENDER', kind: 'FILE' as const,
              name: role, directory: 'EDITING_PROJECTS' as const, type: 'TIMELINE_PROJECT' as const,
              contentHash: file.sha256, storageKey: file.storageKey, mimeType: file.mimeType, sizeBytes: file.sizeBytes,
              payload: { promptId, fileObjectId: file.id, durationSeconds: 10, version: 1, primaryPurpose: 'PRODUCT_DISPLAY',
                origin: 'EXTERNAL_IMPORT', promptText: '已有商品画面', importedMaterial: { schemaVersion: 1 } } };
            const original = await tx.workingArtifact.create({ data: { ...data, workflowRunId: root,
              artifactKey: `render-clip:${originalTask}`, updatedAt: new Date('2026-10-01') } });
            rootClips.push({ promptId, taskId: originalTask });
            const local = await tx.workingArtifact.create({ data: { ...data, workflowRunId: edited,
              artifactKey: `render-clip:${copiedTask}`, metadata: { branchSource: { artifactId: original.id } } } });
            editedClips.push({ promptId, taskId: copiedTask });
            const repairedFile = role === 'END' ? await tx.fileObject.create({ data: {
              projectId, workflowRunId: repairRun, nodeId: 'SEGMENT_RENDER', originalFileName: 'repaired.mp4',
              mimeType: 'video/mp4', sizeBytes: 64, storageKey: `test/${projectId}/repaired.mp4`, sha256: 'f'.repeat(64),
            } }) : file;
            const bound = await tx.workingArtifact.create({ data: { ...data, workflowRunId: repairRun,
              artifactKey: `render-clip:${randomUUID()}`,
              revision: role === 'END' ? 2 : 1,
              payload: { ...data.payload, version: role === 'END' ? 2 : 1,
                fileObjectId: repairedFile.id },
              metadata: role === 'END' ? {} : { branchSource: { artifactId: original.id } },
              updatedAt: new Date('2026-10-06') } });
            oldBindings[role] = bound.id;
            if (role === 'END') repairedId = bound.id;
            if (role === 'END') obsoleteEndId = local.id;
            expect(local.id).not.toBe(bound.id);
          }
          await tx.workingArtifact.create({ data: { ...batch(root, 1, rootClips), updatedAt: new Date('2026-10-01') } });
          const taskId = randomUUID(),
            promptId = randomUUID();
          const file = await tx.fileObject.create({
            data: {
              projectId,
              workflowRunId: edited,
              nodeId: 'SEGMENT_RENDER',
              originalFileName: 'imported.mp4',
              mimeType: 'video/mp4',
              sizeBytes: 64,
              storageKey: `test/${projectId}/imported.mp4`,
              sha256: 'b'.repeat(64),
            },
          });
          const clip = await tx.workingArtifact.create({
            data: {
              projectId,
              workflowRunId: edited,
              nodeId: 'SEGMENT_RENDER',
              artifactKey: `render-clip:${taskId}`,
              kind: 'FILE',
              name: '新增素材',
              directory: 'EDITING_PROJECTS',
              type: 'TIMELINE_PROJECT',
              revision: 1,
              contentHash: file.sha256,
              storageKey: file.storageKey,
              mimeType: file.mimeType,
              sizeBytes: file.sizeBytes,
              payload: {
                promptId,
                fileObjectId: file.id,
                durationSeconds: 6,
                primaryPurpose: 'PRODUCT_DISPLAY',
                origin: 'EXTERNAL_IMPORT',
                promptText: '商品画面',
                importedMaterial: { schemaVersion: 1 },
              },
            },
          });
          await tx.workingArtifact.create({ data: { ...batch(edited, 3, [...editedClips, { taskId, promptId }]), updatedAt: new Date('2026-10-07') } });
          const slots = roles.map((role) => ({
            id: role,
            role,
            label: role,
            duration: 4,
            purpose: 'PRODUCT_DISPLAY',
            transition: '硬切',
          }));
          const entry = (id: string, variants: Prisma.InputJsonValue[]) => ({
            id,
            createdAt: new Date().toISOString(),
            workspace: { editVersion: 1, template: { name: id, slots, editVersion: 1 }, variants },
          });
          const variantId = randomUUID();
          await tx.workingArtifact.create({ data: { projectId, workflowRunId: sibling, nodeId: 'TEMPLATE_MIX',
            artifactKey: `timeline-project:${templateId}:${variantId}`, kind: 'STRUCTURED',
            name: '已有六槽位工程', directory: 'EDITING_PROJECTS', type: 'TIMELINE_PROJECT', contentHash: 'e'.repeat(64),
            payload: {}, dependencies: { create: Object.values(oldBindings).map((sourceArtifactId) => ({
              sourceType: 'WORKING_ARTIFACT' as const, sourceArtifactId, sourceKey: sourceArtifactId,
              sourceRevision: sourceArtifactId === repairedId ? 2 : 1 })) } } });
          await tx.workflowNodeState.create({
            data: {
              projectId,
              workflowRunId: sibling,
              nodeId: 'TEMPLATE_MIX',
              contentHash: 'c'.repeat(64),
              state: {
                schemaVersion: 1,
                activeTemplateId: templateId,
                templates: [
                  entry(templateId, [
                    {
                      id: variantId,
                      name: '成片',
                      slots,
                      bindings: oldBindings,
                      bindingRevisions: Object.fromEntries(roles.map((role) => [role, role === 'END' ? 2 : 1])),
                      offsets: {},
                      appliedTemplateVersion: 1,
                      manualSlotIds: [],
                      conflictSlotIds: [],
                      status: 'CURRENT',
                      captions: [],
                      subtitleStyle: 'standard',
                      voice: null,
                      bgm: null,
                      originalVolume: 1,
                    },
                  ]),
                  entry(emptyId, []),
                ],
              },
            },
          });
          const scoped = new Proxy(tx, {
            get(target, key) {
              return key === '$transaction'
                ? (fn: (client: typeof tx) => unknown) => fn(tx)
                : Reflect.get(target, key);
            },
          }) as unknown as PrismaService;
          const working = new WorkflowWorkingService(
            new WorkflowWorkingRepository(scoped),
            { get: async () => ({ id: projectId }) } as never,
            {} as never,
          );
          const mix = new EffectTemplateMixService(working, {
            listRecent: async () => [
              { templateId, status: 'COMPLETED', inputSnapshot: { materials: oldPrompts.map((promptId) => ({ promptId })) } },
            ],
            inheritedMixAiRuns: async () => [],
          } as never);
          const source = await mix.materialSources(projectId, sibling);
          expect(source.materials.find(({ id }) => id === clip.id)?.activeSource).toBe(true);
          expect(source.pendingAddedMaterialIds?.[templateId]).toEqual([clip.id]);
          expect(source.pendingAddedMaterialIds?.[emptyId]).toEqual([]);
          expect(source.materials.find(({ id }) => id === repairedId)?.activeSource).toBe(true);
          const workspace = await mix.outputSourceWorkspace(projectId, sibling);
          const preserved = workspace.draft.templates.find(({ id }) => id === templateId)!.workspace.variants[0]!;
          expect(preserved.bindings).toEqual(oldBindings);
          expect(preserved.slots).toHaveLength(6);
          for (const materialId of Object.values(oldBindings))
            expect(workspace.materials.some(({ id }) => id === materialId)).toBe(true);
          expect(effectTemplateMixSourceChanges(preserved, workspace.materials)).toEqual([]);
          const reverted = structuredClone(workspace.draft);
          const changed = reverted.templates.find(({ id }) => id === templateId)!.workspace.variants[0]!;
          changed.bindings.END = obsoleteEndId;
          changed.bindingRevisions.END = 1;
          const stateBefore = await working.getNodeState(projectId, sibling, 'TEMPLATE_MIX');
          await expect(mix.saveDraft(projectId, sibling, stateBefore.revision, reverted, true))
            .rejects.toThrow('不能使用其他分支的旧素材覆盖');
          expect(await working.getNodeState(projectId, sibling, 'TEMPLATE_MIX')).toEqual(stateBefore);
          // A late callback cannot bypass the service and commit the same old copied file.
          const obsolete = await tx.workingArtifact.findFirstOrThrow({ where: {
            projectId, workflowRunId: root, nodeId: 'SEGMENT_RENDER', name: 'END',
          } });
          await expect(new WorkflowWorkingRepository(scoped).upsertArtifactInTransaction(
            tx, projectId, sibling, 'TEMPLATE_MIX', `timeline-project:${templateId}:${variantId}`, {
              kind: 'STRUCTURED', name: '禁止旧素材回退', directory: 'EDITING_PROJECTS', type: 'TIMELINE_PROJECT',
              payload: { variant: changed },
              dependencies: [{ sourceType: 'WORKING_ARTIFACT', sourceNodeId: 'SEGMENT_RENDER',
                sourceArtifactId: obsolete.id, sourceKey: obsolete.artifactKey,
                sourceRevision: obsolete.revision, sourceHash: obsolete.contentHash }],
            },
          )).rejects.toThrow('WORKING_ARTIFACT_DEPENDENCY_CONFLICT');
          const tree = await working.getEffectBranchTree(projectId);
          for (const branch of tree.branches)
            expect(branch.nodes.find(({ nodeId }) => nodeId === 'SEGMENT_RENDER')?.status).toBe('CONFIRMED');
          throw rollback;
        }),
      ).rejects.toBe(rollback);
    } finally {
      await db.$disconnect();
    }
  },
  30000,
);
