import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { expect, it } from 'vitest';
import type { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { WorkflowWorkingRepository } from '../../../platform/workflow/workflow-working.repository';
import { EffectSegmentRenderRepository } from './effect-segment-render.repository';

// Random project, rollback-only transaction; no files, Outbox or provider requests.
it
  .skipIf(process.env.EFFECT_EDIT_DATABASE_TEST !== '1')
  .each(['latest', 'history', 'conflict'] as const)(
  'adopts frozen Prompt from the viewing branch into its shared pool: %s',
  async (mode) => {
    const db = new PrismaService(
      new ConfigService({
        DATABASE_URL:
          process.env.DATABASE_URL ??
          'postgresql://postgres:postgres@localhost:5432/ai_marketing?schema=public',
      }),
    );
    const rollback = new Error('CROSS_BRANCH_COMMIT_ROLLBACK');
    try {
      await expect(
        db.$transaction(
          async (tx) => {
            const projectId = randomUUID();
            await tx.project.create({ data: { id: projectId, name: '跨分支冻结来源回滚测试' } });
            const root = await tx.workflowRun.create({
              data: { projectId, workflow: 'EFFECT', workflowSpace: 'EFFECT', activeKey: null },
            });
            const view = await tx.workflowRun.create({
              data: {
                projectId,
                workflow: 'EFFECT',
                workflowSpace: 'EFFECT',
                parentWorkflowRunId: root.id,
                forkNodeId: 'TEMPLATE_MIX',
                branchPublishedAt: new Date(),
                activeKey: 'ACTIVE',
              },
            });
            const scoped = new Proxy(tx, {
              get(target, key) {
                return key === '$transaction'
                  ? (fn: (client: Prisma.TransactionClient) => unknown) => fn(tx)
                  : Reflect.get(target, key);
              },
            }) as unknown as PrismaService;
            const working = new WorkflowWorkingRepository(scoped);
            const render = new EffectSegmentRenderRepository(scoped, working);
            const fixtures = [];
            const input = {
              kind: 'STRUCTURED' as const,
              name: '来源',
              directory: 'VIDEO_MATERIALS' as const,
              type: 'VIDEO_MATERIAL' as const,
              payload: { items: [], version: 'original' },
            };
            for (const run of [root, view]) {
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
              for (const nodeId of ['PROMPT_GENERATION', 'SOURCE_IMPORT']) {
                await working.commitValidatedArtifactsInTransaction(tx, projectId, run.id, nodeId, [
                  {
                    artifactKey: `${nodeId === 'PROMPT_GENERATION' ? 'prompt-batch' : 'source-package'}:${product.id}`,
                    input,
                  },
                ]);
              }
              const prompt = await tx.workingArtifact.findFirstOrThrow({
                where: { workflowRunId: run.id, nodeId: 'PROMPT_GENERATION' },
              });
              const batch = await tx.effectSegmentRenderBatch.create({
                data: {
                  projectId,
                  workflowRunId: run.id,
                  productId: product.id,
                  sourcePromptArtifactId: prompt.id,
                  sourcePromptRevision: prompt.revision,
                  sourcePromptHash: prompt.contentHash,
                  sourceFingerprint: 'f',
                  requestHash: 'h',
                  idempotencyKey: run.id,
                  status: 'COMPLETED',
                  activeKey: null,
                  committedAt: new Date(),
                },
              });
              const task = await tx.effectSegmentRenderTask.create({
                data: {
                  projectId,
                  workflowRunId: run.id,
                  productId: product.id,
                  batchId: batch.id,
                  promptId: randomUUID(),
                  promptCode: 'P001',
                  renderCode: 'R-001',
                  sourceFingerprint: 'f',
                  requestSnapshot: {},
                  generationRequestSnapshot: {},
                  status: 'COMPLETED',
                },
              });
              await working.commitValidatedArtifactsInTransaction(
                tx,
                projectId,
                run.id,
                'SEGMENT_RENDER',
                [
                  {
                    artifactKey: `render-batch:${product.id}`,
                    input: {
                      ...input,
                      payload: { clips: [{ taskId: task.id }] },
                      ...(run.id === view.id
                        ? { metadata: { branchSource: { artifactId: 'inherited' } } }
                        : {}),
                    },
                  },
                ],
              );
              fixtures.push({ run, product, prompt, batch, task });
            }
            const owner = fixtures[0]!;
            const viewed = fixtures[1]!;
            await working.commitValidatedArtifactsInTransaction(
              tx,
              projectId,
              view.id,
              'PROMPT_GENERATION',
              [
                {
                  artifactKey: viewed.prompt.artifactKey,
                  input: { ...input, payload: { items: [], version: 'saved edit' } },
                },
              ],
            );
            const savedPrompt = await tx.workingArtifact.findUniqueOrThrow({
              where: { id: viewed.prompt.id },
            });
            const edit = (await working.beginEffectNodeEditInTransaction(
              tx,
              projectId,
              view.id,
              'SEGMENT_RENDER',
            ))!;
            const childBatch = (await render.latestBatch(
              projectId,
              edit.runId,
              edit.productIdMap[viewed.product.id]!,
            ))!;
            const childPrompt = await tx.workingArtifact.findFirstOrThrow({
              where: { workflowRunId: edit.runId, nodeId: 'PROMPT_GENERATION' },
            });
            const childSource = await tx.workingArtifact.findFirstOrThrow({
              where: { workflowRunId: edit.runId, nodeId: 'SOURCE_IMPORT' },
            });
            const sourcePrompt = {
              artifactId: childPrompt.id,
              revision: childPrompt.revision,
              contentHash: childPrompt.contentHash,
            };
            const frozen = {
              sourcePrompt,
              promptId: childBatch.tasks[0]!.promptId,
              refreshContext: { schemaVersion: 1, confirmationSignature: 'signed', sourcePrompt },
            };
            await tx.effectSegmentRenderTask.update({
              where: { id: childBatch.tasks[0]!.id },
              data: { requestSnapshot: frozen, generationRequestSnapshot: frozen },
            });
            await tx.effectSegmentRenderBatch.update({
              where: { id: childBatch.id },
              data: {
                committedAt: null,
                sourcePromptArtifactId: childPrompt.id,
                sourcePromptRevision: childPrompt.revision,
                sourcePromptHash: childPrompt.contentHash,
              },
            });
            if (mode === 'history')
              await working.commitValidatedArtifactsInTransaction(
                tx,
                projectId,
                view.id,
                'PROMPT_GENERATION',
                [
                  {
                    artifactKey: savedPrompt.artifactKey,
                    input: { ...input, payload: { items: [], version: 'changed during update' } },
                    invalidateDependents: false,
                  },
                ],
              );
            if (mode === 'conflict')
              await tx.effectSegmentRenderBatch.update({
                where: { id: owner.batch.id },
                data: { revision: { increment: 1 } },
              });
            const artifacts = [
              {
                artifactKey: `render-batch:${childBatch.productId}`,
                input: {
                  ...input,
                  payload: { clips: [{ taskId: childBatch.tasks[0]!.id }], sourcePrompt },
                  dependencies: [
                    {
                      sourceType: 'WORKING_ARTIFACT' as const,
                      sourceNodeId: 'PROMPT_GENERATION',
                      sourceArtifactId: childPrompt.id,
                      sourceKey: childPrompt.artifactKey,
                      sourceRevision: childPrompt.revision,
                      sourceHash: childPrompt.contentHash,
                    },
                  ],
                },
              },
            ];
            const result = await render.commitValidatedBatch(
              projectId,
              childBatch.id,
              childBatch.revision,
              sourcePrompt,
              {
                artifactId: childSource.id,
                revision: childSource.revision,
                contentHash: childSource.contentHash,
              },
              artifacts,
            );
            if (mode === 'conflict') expect(result.kind).toBe('BRANCH_CONFLICT');
            else {
              expect(result).toMatchObject({
                kind: 'COMMITTED',
                publication: { activeWorkflowRunId: view.id, createdBranch: false },
              });
              const adopted = await tx.effectSegmentRenderBatch.findUniqueOrThrow({
                where: { id: owner.batch.id },
              });
              expect(adopted).toMatchObject({
                sourcePromptArtifactId: savedPrompt.id,
                sourcePromptRevision: savedPrompt.revision,
                sourcePromptHash: savedPrompt.contentHash,
              });
              const pool = await tx.workingArtifact.findFirstOrThrow({
                where: { workflowRunId: root.id, nodeId: 'SEGMENT_RENDER' },
                include: { dependencies: true },
              });
              expect(pool.dependencies[0]).toMatchObject({
                sourceArtifactId: savedPrompt.id,
                sourceKey: savedPrompt.artifactKey,
                sourceRevision: savedPrompt.revision,
                sourceHash: savedPrompt.contentHash,
              });
              expect(
                (await tx.workingArtifact.findUniqueOrThrow({ where: { id: owner.prompt.id } }))
                  .revision,
              ).toBe(1);
              expect(
                (await tx.workingArtifact.findUniqueOrThrow({ where: { id: savedPrompt.id } }))
                  .revision,
              ).toBe(mode === 'history' ? 3 : 2);
              const repeated = await render.commitValidatedBatch(
                projectId,
                childBatch.id,
                childBatch.revision,
                sourcePrompt,
                {
                  artifactId: childSource.id,
                  revision: childSource.revision,
                  contentHash: childSource.contentHash,
                },
                artifacts,
              );
              expect(repeated).toMatchObject({ kind: 'COMMITTED', publication: null });
              expect(
                (
                  await tx.effectSegmentRenderBatch.findUniqueOrThrow({
                    where: { id: owner.batch.id },
                  })
                ).revision,
              ).toBe(adopted.revision);
            }
            expect(await tx.jobOutbox.count({ where: { projectId } })).toBe(0);
            if (mode === 'latest') {
              for (const isolation of [
                'independent-head',
                'unpublished',
                'other-project',
              ] as const) {
                const otherProjectId = isolation === 'other-project' ? randomUUID() : projectId;
                if (otherProjectId !== projectId) {
                  await tx.project.create({
                    data: { id: otherProjectId, name: '来源隔离回滚测试' },
                  });
                }
                const isolated = await tx.workflowRun.create({
                  data: {
                    projectId: otherProjectId,
                    workflow: 'EFFECT',
                    workflowSpace: 'EFFECT',
                    parentWorkflowRunId: otherProjectId === projectId ? root.id : null,
                    forkNodeId:
                      isolation === 'independent-head' ? 'SEGMENT_RENDER' : 'TEMPLATE_MIX',
                    branchPublishedAt: isolation === 'unpublished' ? null : new Date(),
                    activeKey: null,
                  },
                });
                const isolatedPrompt = await tx.workingArtifact.create({
                  data: {
                    ...input,
                    projectId: otherProjectId,
                    workflowRunId: isolated.id,
                    nodeId: 'PROMPT_GENERATION',
                    artifactKey: `prompt-batch:${randomUUID()}`,
                    contentHash: savedPrompt.contentHash,
                  },
                });
                const source = {
                  artifactId: isolatedPrompt.id,
                  artifactKey: isolatedPrompt.artifactKey,
                  revision: isolatedPrompt.revision,
                  contentHash: isolatedPrompt.contentHash,
                };
                await expect(
                  working.commitValidatedArtifactsInTransaction(
                    tx,
                    projectId,
                    root.id,
                    'SEGMENT_RENDER',
                    [
                      {
                        artifactKey: `render-clip:${randomUUID()}`,
                        input: {
                          ...input,
                          dependencies: [
                            {
                              sourceType: 'WORKING_ARTIFACT',
                              sourceNodeId: 'PROMPT_GENERATION',
                              sourceArtifactId: source.artifactId,
                              sourceKey: source.artifactKey,
                              sourceRevision: source.revision,
                              sourceHash: source.contentHash,
                            },
                          ],
                        },
                      },
                    ],
                    undefined,
                    [source],
                  ),
                ).rejects.toThrow('WORKING_ARTIFACT_DEPENDENCY_CONFLICT');
              }
            }
            throw rollback;
          },
          { timeout: 120_000 },
        ),
      ).rejects.toBe(rollback);
    } finally {
      await db.$disconnect();
    }
  },
  120_000,
);
