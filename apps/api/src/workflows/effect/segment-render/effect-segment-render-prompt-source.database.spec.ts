import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { expect, it } from 'vitest';
import type { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { WorkflowWorkingRepository } from '../../../platform/workflow/workflow-working.repository';
import { EffectSegmentRenderRepository } from './effect-segment-render.repository';

// Entire fixture rolls back; never schedules tasks or changes a user's project.
it.skipIf(process.env.EFFECT_SOURCE_POOL_DATABASE_TEST !== '1').each([
  ['MANUAL', false, 'SEGMENT_RENDER'],
  ['BATCH', false, 'SEGMENT_RENDER'],
  ['MANUAL', true, 'SEGMENT_RENDER'],
  ['BATCH', true, 'SEGMENT_RENDER'],
  ['MANUAL', false, 'PROMPT_GENERATION'],
  ['MANUAL', true, 'PROMPT_GENERATION'],
] as const)(
  'keeps coherent adopted Prompt inputs for %s edits (later real edit: %s, node: %s)',
  async (purpose, laterEdit, nodeId) => {
    const db = new PrismaService(
      new ConfigService({
        DATABASE_URL:
          process.env.DATABASE_URL ??
          'postgresql://postgres:postgres@localhost:5432/ai_marketing?schema=public',
      }),
    );
    const rollback = new Error('PROMPT_SOURCE_ROLLBACK');
    try {
      await expect(
        db.$transaction(
          async (tx) => {
            const projectId = randomUUID();
            await tx.project.create({ data: { id: projectId, name: '提示词来源回滚验证' } });
            const root = await tx.workflowRun.create({
              data: { projectId, workflow: 'EFFECT', workflowSpace: 'EFFECT', activeKey: 'ACTIVE' },
            });
            const owner = await tx.workflowRun.create({
              data: {
                projectId,
                workflow: 'EFFECT',
                workflowSpace: 'EFFECT',
                parentWorkflowRunId: root.id,
                forkNodeId: 'TEMPLATE_MIX',
                branchPublishedAt: new Date(),
                activeKey: null,
              },
            });
            const products = [];
            const prompts = [];
            for (const [run, revision, time, content] of [
              [root, laterEdit ? 12 : 11, laterEdit ? 3000 : 1000, laterEdit ? 'new edit' : 'old'],
              [owner, 13, 2000, 'adopted'],
            ] as const) {
              const workspace = await tx.effectImportWorkspace.create({
                data: { projectId, workflowRunId: run.id },
              });
              const draft = await tx.effectImportDraft.create({
                data: {
                  projectId,
                  workspaceId: workspace.id,
                  mode: 'SINGLE',
                  globalConfig: {},
                  validationIssues: [],
                },
              });
              const product = await tx.effectImportProduct.create({
                data: { projectId, workflowRunId: run.id, draftId: draft.id, configOverride: {} },
              });
              products.push(product);
              const base = {
                projectId,
                workflowRunId: run.id,
                kind: 'STRUCTURED' as const,
                name: '来源',
                directory: 'VIDEO_MATERIALS' as const,
                type: 'VIDEO_MATERIAL' as const,
                contentHash: 'a'.repeat(64),
              };
              prompts.push(
                await tx.workingArtifact.create({
                  data: {
                    ...base,
                    nodeId: 'PROMPT_GENERATION',
                    artifactKey: `prompt-batch:${product.id}`,
                    revision,
                    updatedAt: new Date(time),
                    payload: { items: [{ id: 'stable-prompt', content }] },
                  },
                }),
              );
              await tx.workingArtifact.create({
                data: {
                  ...base,
                  nodeId: 'SOURCE_IMPORT',
                  artifactKey: `source-package:${product.id}`,
                  payload: {},
                },
              });
            }
            const adopted = prompts[1]!;
            const product = products[0]!;
            await tx.effectSegmentRenderBatch.create({
              data: {
                projectId,
                workflowRunId: root.id,
                productId: product.id,
                sourcePromptArtifactId: adopted.id,
                sourcePromptRevision: adopted.revision,
                sourcePromptHash: adopted.contentHash,
                sourceFingerprint: 'a'.repeat(64),
                requestHash: 'a'.repeat(64),
                idempotencyKey: randomUUID(),
                status: 'COMPLETED',
                activeKey: null,
                committedAt: new Date(),
              },
            });
            await tx.workingArtifact.create({
              data: {
                projectId,
                workflowRunId: root.id,
                nodeId: 'SEGMENT_RENDER',
                artifactKey: `render-batch:${product.id}`,
                kind: 'STRUCTURED',
                name: '素材',
                directory: 'VIDEO_MATERIALS',
                type: 'VIDEO_MATERIAL',
                contentHash: 'b'.repeat(64),
                payload: {
                  clips: [],
                  sourcePrompt: {
                    artifactId: adopted.id,
                    revision: adopted.revision,
                    contentHash: adopted.contentHash,
                  },
                },
              },
            });
            const scoped = new Proxy(tx, {
              get(target, key) {
                return key === '$transaction'
                  ? (fn: (client: Prisma.TransactionClient) => unknown) => fn(tx)
                  : Reflect.get(target, key);
              },
            }) as unknown as PrismaService;
            const render = new EffectSegmentRenderRepository(scoped);
            const selected = await render.promptArtifact(projectId, root.id, product.id);
            expect(selected?.id).toBe(laterEdit ? prompts[0]!.id : adopted.id);
            const working = new WorkflowWorkingRepository(scoped);
            const edit = await working.beginEffectNodeEditInTransaction(
              tx,
              projectId,
              root.id,
              nodeId,
              purpose,
            );
            expect(edit?.created).toBe(true);
            const childProduct = edit!.productIdMap[product.id]!;
            const copied = await render.promptArtifact(projectId, edit!.runId, childProduct);
            expect(copied?.revision).toBe(selected?.revision);
            if (nodeId === 'PROMPT_GENERATION') {
              const session = await tx.workflowRun.findUniqueOrThrow({
                where: { id: edit!.runId },
              });
              expect(session.editIdMap).toMatchObject({
                promptEditBaseline: {
                  source: {
                    artifactId: selected!.id,
                    revision: selected!.revision,
                    contentHash: selected!.contentHash,
                  },
                  target: {
                    artifactId: prompts[0]!.id,
                    revision: prompts[0]!.revision,
                    contentHash: prompts[0]!.contentHash,
                  },
                },
              });
              const exit = await working.cancelEffectNodeEdit(projectId, edit!.runId, nodeId);
              expect(exit?.runId).toBe(root.id);
            }
            expect((copied?.payload as { items: { content: string }[] }).items[0]?.content).toBe(
              laterEdit ? 'new edit' : 'adopted',
            );
            expect(await tx.jobOutbox.count({ where: { projectId } })).toBe(0);
            expect(
              (await tx.workingArtifact.findUniqueOrThrow({ where: { id: prompts[0]!.id } }))
                .revision,
            ).toBe(laterEdit ? 12 : 11);
            throw rollback;
          },
          { timeout: 120_000 },
        ),
      ).rejects.toThrow(rollback);
    } finally {
      await db.$disconnect();
    }
  },
  120_000,
);
