import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { expect, it } from 'vitest';
import type { EffectTemplateMixVariant, EffectTemplateMixDraft } from '@ai-marketing/contracts';
import { PrismaService } from '../../../database/prisma.service';
import {
  WorkflowWorkingRepository,
  workingArtifactInclude,
} from '../../../platform/workflow/workflow-working.repository';
import type { WorkflowWorkingService } from '../../../platform/workflow/workflow-working.service';
import type { EffectTemplateMixService } from '../template-mix/effect-template-mix.service';
import type { StoragePort } from '../../../platform/file/storage.port';
import { EffectFinalOutputService } from './effect-final-output.service';
import { workflowStateHash } from '../../../platform/workflow/workflow-state-hash';

// All records and Outbox writes are rolled back. No consumer or paid provider is invoked.
it.skipIf(process.env.EFFECT_OUTPUT_DATABASE_TEST !== '1')(
  'adds caption-only output and removes a failed addition atomically in the same branch',
  async () => {
    const db = new PrismaService(
      new ConfigService({
        DATABASE_URL:
          process.env.DATABASE_URL ??
          'postgresql://postgres:postgres@localhost:5432/ai_marketing?schema=public',
      }),
    );
    const projectId = randomUUID(),
      workflowRunId = randomUUID(),
      templateId = randomUUID();
    const rollback = new Error('OUTPUT_MEMBERSHIP_ROLLBACK');
    try {
      await expect(
        db.$transaction(
          async (tx) => {
            await tx.project.create({ data: { id: projectId, name: '工程增删回滚验收' } });
            await tx.workflowRun.create({
              data: {
                id: workflowRunId,
                projectId,
                workflow: 'EFFECT',
                workflowSpace: 'EFFECT',
                status: 'ACTIVE',
                activeKey: 'ACTIVE',
              },
            });
            const scoped = new Proxy(tx, {
              get(target, key) {
                return key === '$transaction'
                  ? (fn: (client: typeof tx) => unknown) => fn(tx)
                  : Reflect.get(target, key);
              },
            }) as unknown as PrismaService;
            const repository = new WorkflowWorkingRepository(scoped);
            const variant = {
              id: randomUUID(),
              name: '仅字幕成片',
              slots: [],
              bindings: {},
              bindingRevisions: {},
              offsets: {},
              manualSlotIds: [],
              conflictSlotIds: [],
              status: 'CURRENT',
              appliedTemplateVersion: 1,
              captions: [{ id: 'title', text: '测试标题', start: 0, end: 3 }],
              subtitleStyle: 'standard',
              voice: null,
              bgm: null,
              originalVolume: 1,
            } as EffectTemplateMixVariant;
            const draft = {
              schemaVersion: 1,
              activeTemplateId: templateId,
              templates: [
                {
                  id: templateId,
                  workspace: {
                    template: { name: '测试模板', slots: [], editVersion: 1 },
                    editVersion: 1,
                    variants: [variant],
                  },
                },
              ],
            } as EffectTemplateMixDraft;
            await tx.workflowNodeState.create({
              data: {
                projectId,
                workflowRunId,
                nodeId: 'TEMPLATE_MIX',
                revision: 1,
                contentHash: workflowStateHash(draft),
                state: JSON.parse(JSON.stringify(draft)),
              },
            });
            const run = await tx.effectFinalOutputRun.create({
              data: {
                projectId,
                workflowRunId,
                templateId,
                idempotencyKey: randomUUID(),
                requestHash: workflowStateHash(draft),
                inputHash: workflowStateHash(draft),
                status: 'COMPLETED',
              },
            });
            await repository.commitValidatedArtifactsInTransaction(
              tx,
              projectId,
              workflowRunId,
              'FINAL_OUTPUT',
              [
                {
                  artifactKey: `final-delivery:${templateId}`,
                  input: {
                    kind: 'STRUCTURED',
                    name: '交付清单',
                    directory: 'REPORTS_DELIVERABLES',
                    type: 'DELIVERY_MANIFEST',
                    payload: {
                      runId: run.id,
                      items: [],
                      resolution: '1080p',
                      frameRate: 25,
                    },
                  },
                },
              ],
            );
            const artifacts = () =>
              tx.workingArtifact.findMany({
                where: { projectId, workflowRunId },
                include: workingArtifactInclude,
              });
            const workspace = async () => ({
              draft,
              draftRevision: 1,
              materials: [],
              artifacts: await artifacts(),
            });
            const mix = {
              workspace,
              outputSourceWorkspace: workspace,
              prepareValidation: async () => ({
                variants: [variant],
                inputs: [
                  {
                    artifactKey: `timeline-project:${templateId}:${variant.id}`,
                    input: {
                      kind: 'STRUCTURED',
                      name: variant.name,
                      directory: 'EDITING_PROJECTS',
                      type: 'TIMELINE_PROJECT',
                      payload: { templateId, variant },
                    },
                  },
                ],
              }),
            } as unknown as EffectTemplateMixService;
            const service = new EffectFinalOutputService(
              scoped,
              mix,
              {
                listArtifacts: artifacts,
                commitValidatedArtifactsInTransaction:
                  repository.commitValidatedArtifactsInTransaction.bind(repository),
              } as unknown as WorkflowWorkingRepository,
              {} as StoragePort,
              {
                getEffectBranchTree: async () => ({
                  projectId,
                  activeWorkflowRunId: workflowRunId,
                  branches: [
                    {
                      workflowRunId,
                      parentWorkflowRunId: null,
                      forkNodeId: null,
                      forkTemplateId: null,
                      templates: [{ templateId }],
                    },
                  ],
                }),
              } as unknown as WorkflowWorkingService,
            );
            await service.localUpdate(projectId, run.id, {
              itemIds: [],
              syncProjects: true,
              expectedDraftRevision: 1,
            });
            const item = await tx.effectFinalOutputItem.findFirstOrThrow({
              where: { runId: run.id },
            });
            expect(item.snapshot).toMatchObject({
              timeline: { clips: [], duration: 3 },
              resolution: '1080p',
              frameRate: 25,
            });
            expect(await tx.jobOutbox.count({ where: { projectId } })).toBe(1);
            await tx.effectFinalOutputRun.update({
              where: { id: run.id },
              data: { status: 'FAILED' },
            });
            await tx.effectFinalOutputItem.update({
              where: { id: item.id },
              data: { status: 'FAILED' },
            });
            draft.templates[0]!.workspace.variants = [];
            await tx.workflowNodeState.updateMany({
              where: { projectId, workflowRunId },
              data: { state: JSON.parse(JSON.stringify(draft)) },
            });
            await service.localUpdate(projectId, run.id, {
              itemIds: [item.id],
              syncProjects: true,
            });
            expect(await tx.effectFinalOutputItem.count({ where: { runId: run.id } })).toBe(0);
            expect(await tx.jobOutbox.count({ where: { projectId } })).toBe(1);
            const delivery = await tx.workingArtifact.findFirstOrThrow({
              where: { projectId, artifactKey: `final-delivery:${templateId}` },
            });
            expect(delivery.payload).toMatchObject({
              items: [],
              resolution: '1080p',
              frameRate: 25,
            });
            throw rollback;
          },
          { timeout: 30_000 },
        ),
      ).rejects.toBe(rollback);
      expect(await db.project.count({ where: { id: projectId } })).toBe(0);
    } finally {
      await db.$disconnect();
    }
  },
);
