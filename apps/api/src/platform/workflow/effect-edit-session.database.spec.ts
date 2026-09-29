import { ConfigService } from '@nestjs/config';
import { expect, it } from 'vitest';
import { PrismaService } from '../../database/prisma.service';
import { WorkflowWorkingRepository } from './workflow-working.repository';

const stages = ['SOURCE_IMPORT', 'INFORMATION_EXTRACTION', 'PROMPT_GENERATION', 'SEGMENT_RENDER'] as const;

it.skipIf(process.env.EFFECT_EDIT_DATABASE_TEST !== '1').each(stages)(
  'isolates %s in an unpublished child and returns unchanged edits to the parent',
  async (nodeId) => {
    const db = new PrismaService(new ConfigService({
      DATABASE_URL: process.env.DATABASE_URL ??
        'postgresql://postgres:postgres@localhost:5432/ai_marketing?schema=public',
    }));
    const repository = new WorkflowWorkingRepository(db);
    const rollback = new Error('EFFECT_EDIT_TEST_ROLLBACK');
    try {
      await expect(db.$transaction(async (tx) => {
        const preferred = nodeId === 'SEGMENT_RENDER'
          ? await tx.workingArtifact.findFirst({ where: {
              nodeId, availability: 'AVAILABLE', workflowRun: {
                workflow: 'EFFECT', workflowSpace: 'EFFECT', activeKey: 'ACTIVE',
                effectSegmentRenderBatches: { some: {
                  archivedAt: null, committedAt: { not: null },
                } },
              },
            }, orderBy: { updatedAt: 'desc' } })
          : null;
        if (nodeId === 'SEGMENT_RENDER') expect(preferred).not.toBeNull();
        const source = preferred ?? await tx.workingArtifact.findFirst({ where: {
          nodeId, availability: 'AVAILABLE', workflowRun: {
            workflow: 'EFFECT', workflowSpace: 'EFFECT', activeKey: 'ACTIVE',
          },
        }, orderBy: { updatedAt: 'desc' } });
        if (!source) return;
        const parent = await tx.workflowRun.findUniqueOrThrow({ where: { id: source.workflowRunId } });
        const before = await tx.workingArtifact.findUniqueOrThrow({ where: { id: source.id } });
        const begun = await repository.beginEffectNodeEditInTransaction(
          tx, source.projectId, parent.id, nodeId);
        expect(begun).not.toBeNull();
        expect(begun!.runId).not.toBe(parent.id);
        expect(begun!.parentWorkflowRunId).toBe(parent.id);
        const child = await tx.workflowRun.findUniqueOrThrow({ where: { id: begun!.runId } });
        expect(child.branchPublishedAt).toBeNull();
        expect(child.activeKey).toBe('ACTIVE');
        expect(await tx.effectImportWorkspace.count({ where: {
          projectId: source.projectId, workflowRunId: child.id,
        } })).toBe(1);
        if (nodeId === 'PROMPT_GENERATION' || nodeId === 'SEGMENT_RENDER') {
          const copied = await tx.workingArtifact.findFirstOrThrow({ where: {
            projectId: source.projectId, workflowRunId: child.id,
            nodeId: 'PROMPT_GENERATION',
          }, include: { dependencies: true, files: { include: { fileObject: true } } } });
          expect(copied.id).not.toBe(source.id);
          expect(copied.artifactKey).toContain(Object.values(begun!.productIdMap)[0]);
          expect(await tx.effectPromptRun.count({ where: {
            projectId: source.projectId, workflowRunId: child.id,
            status: 'COMPLETED', result: { isNot: null },
          } })).toBeGreaterThan(0);
          expect(copied.dependencies.some((dependency) =>
            dependency.sourceType === 'WORKING_ARTIFACT' &&
            dependency.sourceArtifactId !== null &&
            dependency.sourceArtifactId !== source.id)).toBe(true);
          const executionDependenciesMatch = (await Promise.all(copied.dependencies
            .filter((dependency) => dependency.sourceType === 'EXECUTION_INPUT')
            .map(async (dependency) => {
              const state = await tx.workflowNodeState.findUnique({ where: {
                projectId_workflowRunId_nodeId: {
                  projectId: source.projectId, workflowRunId: child.id,
                  nodeId: dependency.sourceNodeId ?? dependency.sourceKey,
                },
              } });
              return state?.executionInputHash === dependency.sourceHash;
            }))).every(Boolean);
          if (executionDependenciesMatch) {
          const unchanged = await repository.commitValidatedArtifactsInTransaction(
            tx, source.projectId, child.id, 'PROMPT_GENERATION', [{
              artifactKey: copied.artifactKey,
              input: {
                kind: copied.kind, name: copied.name, directory: copied.directory,
                type: copied.type, tags: copied.tags, payload: copied.payload,
                metadata: copied.metadata, originalFileName: copied.originalFileName,
                mimeType: copied.mimeType, sizeBytes: copied.sizeBytes,
                storageKey: copied.storageKey,
                files: copied.files.map((file) => ({
                  fileObjectId: file.fileObjectId, role: file.role,
                  sortOrder: file.sortOrder,
                  originalFileName: file.fileObject.originalFileName,
                  mimeType: file.fileObject.mimeType,
                  sha256: file.fileObject.sha256,
                })),
                dependencies: copied.dependencies.map((dependency) => ({
                  sourceType: dependency.sourceType,
                  sourceNodeId: dependency.sourceNodeId,
                  sourceArtifactId: dependency.sourceArtifactId,
                  sourceKey: dependency.sourceKey,
                  sourceRevision: dependency.sourceRevision,
                  sourceHash: dependency.sourceHash,
                })),
              },
            }]);
          expect(unchanged[0]?.unchanged).toBe(true);
          }
        }
        if (nodeId === 'SEGMENT_RENDER') {
          const parentBatches = await tx.effectSegmentRenderBatch.findMany({ where: {
            projectId: source.projectId, workflowRunId: parent.id,
            archivedAt: null, committedAt: { not: null },
          } });
          expect(parentBatches.some((batch) => batch.activeKey === null)).toBe(true);
          expect(await tx.effectSegmentRenderBatch.count({ where: {
            projectId: source.projectId, workflowRunId: child.id,
          } })).toBe(new Set(parentBatches.map((batch) => batch.productId)).size);
          if (parentBatches.length) expect(await tx.effectSegmentRenderTask.count({ where: {
            projectId: source.projectId, workflowRunId: child.id,
          } })).toBeGreaterThan(0);
          if (parentBatches.length) {
            const batch = await tx.effectSegmentRenderBatch.findFirstOrThrow({ where: {
              projectId: source.projectId, workflowRunId: child.id,
            }, include: { tasks: true } });
            const prompt = await tx.workingArtifact.findFirstOrThrow({ where: {
              projectId: source.projectId, workflowRunId: child.id,
              nodeId: 'PROMPT_GENERATION',
              artifactKey: `prompt-batch:${batch.productId}`,
            } });
            expect(batch.sourcePromptArtifactId).toBe(prompt.id);
            expect(batch.sourcePromptHash).toBe(prompt.contentHash);
            const sourcePackage = await tx.workingArtifact.findFirstOrThrow({ where: {
              projectId: source.projectId, workflowRunId: child.id,
              nodeId: 'SOURCE_IMPORT', artifactKey: `source-package:${batch.productId}`,
            } });
            const snapshot = batch.tasks[0]?.requestSnapshot as {
              sourcePackage?: { artifactId?: string; contentHash?: string };
            } | undefined;
            expect(snapshot?.sourcePackage).toEqual(expect.objectContaining({
              artifactId: sourcePackage.id, contentHash: sourcePackage.contentHash,
            }));
          }
        }
        expect(await tx.workingArtifact.findUniqueOrThrow({ where: { id: source.id } })).toEqual(before);
        const exit = await repository.publishEffectNodeEditInTransaction(
          tx, source.projectId, child.id, nodeId);
        expect(exit).toEqual(expect.objectContaining({
          runId: parent.id, activeWorkflowRunId: parent.id, createdBranch: false,
        }));
        throw rollback;
      }, { timeout: 120_000 })).rejects.toBe(rollback);
    } finally {
      await db.$disconnect();
    }
  },
);

it.skipIf(process.env.EFFECT_EDIT_DATABASE_TEST !== '1')(
  'publishes a changed edit without modifying the parent or stealing a switched active branch',
  async () => {
    const db = new PrismaService(new ConfigService({
      DATABASE_URL: process.env.DATABASE_URL ??
        'postgresql://postgres:postgres@localhost:5432/ai_marketing?schema=public',
    }));
    const repository = new WorkflowWorkingRepository(db);
    const rollback = new Error('EFFECT_EDIT_TEST_ROLLBACK');
    try {
      await expect(db.$transaction(async (tx) => {
        const source = await tx.workingArtifact.findFirstOrThrow({ where: {
          nodeId: 'PROMPT_GENERATION', availability: 'AVAILABLE', workflowRun: {
            workflow: 'EFFECT', workflowSpace: 'EFFECT', activeKey: 'ACTIVE',
          },
        }, include: { dependencies: true, files: { include: { fileObject: true } } } });
        const begin = await repository.beginEffectNodeEditInTransaction(
          tx, source.projectId, source.workflowRunId, 'PROMPT_GENERATION');
        expect(begin?.created).toBe(true);
        const childArtifact = await tx.workingArtifact.findFirstOrThrow({ where: {
          projectId: source.projectId, workflowRunId: begin!.runId,
          nodeId: 'PROMPT_GENERATION',
        }, include: { dependencies: true, files: { include: { fileObject: true } } } });
        const committed = await repository.commitValidatedArtifactsInTransaction(
          tx, source.projectId, begin!.runId, 'PROMPT_GENERATION', [{
            artifactKey: childArtifact.artifactKey,
            input: {
              kind: childArtifact.kind, name: `${childArtifact.name} 编辑测试`,
              directory: childArtifact.directory, type: childArtifact.type,
              tags: childArtifact.tags, payload: childArtifact.payload,
              metadata: childArtifact.metadata,
              originalFileName: childArtifact.originalFileName,
              mimeType: childArtifact.mimeType, sizeBytes: childArtifact.sizeBytes,
              storageKey: childArtifact.storageKey,
              files: childArtifact.files.map((file) => ({
                fileObjectId: file.fileObjectId, role: file.role, sortOrder: file.sortOrder,
                originalFileName: file.fileObject.originalFileName,
                mimeType: file.fileObject.mimeType, sha256: file.fileObject.sha256,
              })),
              dependencies: childArtifact.dependencies.map((dependency) => ({
                sourceType: dependency.sourceType, sourceNodeId: dependency.sourceNodeId,
                sourceArtifactId: dependency.sourceArtifactId,
                sourceKey: dependency.sourceKey,
                sourceRevision: dependency.sourceRevision,
                sourceHash: dependency.sourceHash,
              })),
            },
          }]);
        expect(committed[0]?.unchanged).toBe(false);
        await tx.workflowRun.update({ where: { id: begin!.runId }, data: { activeKey: null } });
        await tx.workflowRun.update({ where: { id: source.workflowRunId },
          data: { activeKey: 'ACTIVE' } });
        const published = await repository.publishEffectNodeEditInTransaction(
          tx, source.projectId, begin!.runId, 'PROMPT_GENERATION');
        expect(published).toEqual(expect.objectContaining({
          runId: begin!.runId, activeWorkflowRunId: source.workflowRunId,
          createdBranch: true,
        }));
        expect((await tx.workflowRun.findUniqueOrThrow({ where: { id: begin!.runId } }))
          .branchPublishedAt).not.toBeNull();
        expect((await tx.workingArtifact.findUniqueOrThrow({ where: { id: source.id } }))
          .contentHash).toBe(source.contentHash);
        throw rollback;
      }, { timeout: 120_000 })).rejects.toBe(rollback);
    } finally {
      await db.$disconnect();
    }
  },
);

it.skipIf(process.env.EFFECT_EDIT_DATABASE_TEST !== '1')(
  'clones the mix stage upstream but leaves its own confirmed artifacts behind',
  async () => {
    const db = new PrismaService(new ConfigService({
      DATABASE_URL: process.env.DATABASE_URL ??
        'postgresql://postgres:postgres@localhost:5432/ai_marketing?schema=public',
    }));
    const repository = new WorkflowWorkingRepository(db);
    const rollback = new Error('EFFECT_EDIT_TEST_ROLLBACK');
    try {
      await expect(db.$transaction(async (tx) => {
        const source = await tx.workingArtifact.findFirstOrThrow({ where: {
          nodeId: 'TEMPLATE_MIX', availability: 'AVAILABLE',
          artifactKey: { startsWith: 'mix-template:' },
          workflowRun: { workflow: 'EFFECT', workflowSpace: 'EFFECT', activeKey: 'ACTIVE' },
        }, orderBy: { updatedAt: 'desc' } });
        const begun = await repository.beginEffectNodeEditInTransaction(
          tx, source.projectId, source.workflowRunId, 'TEMPLATE_MIX', 'BATCH');
        expect(begun).not.toBeNull();
        expect(begun!.created).toBe(true);
        const childArtifacts = await tx.workingArtifact.findMany({ where: {
          projectId: source.projectId, workflowRunId: begun!.runId,
          availability: 'AVAILABLE',
        }, select: { nodeId: true, artifactKey: true } });
        // The branch has to render from the same clips, but nothing of the mix result itself may
        // come along — the node has to look unconfirmed until the user regenerates it.
        expect(childArtifacts.some((item) => item.artifactKey.startsWith('render-clip:'))).toBe(true);
        expect(childArtifacts.some((item) => item.artifactKey.startsWith('mix-template:'))).toBe(false);
        expect(childArtifacts.some((item) => item.artifactKey.startsWith('timeline-project:'))).toBe(false);
        expect(childArtifacts.some((item) => item.artifactKey.startsWith('timeline-package:'))).toBe(false);
        expect(childArtifacts.some((item) => item.artifactKey.startsWith('final-video:'))).toBe(false);
        expect(childArtifacts.some((item) => item.artifactKey.startsWith('final-delivery:'))).toBe(false);
        // The template and slot configuration lives in the node draft, so it must survive the fork.
        expect(await tx.workflowNodeState.count({ where: {
          projectId: source.projectId, workflowRunId: begun!.runId, nodeId: 'TEMPLATE_MIX',
        } })).toBe(1);
        expect(await tx.workingArtifact.findUniqueOrThrow({ where: { id: source.id } }))
          .toMatchObject({ workflowRunId: source.workflowRunId });
        throw rollback;
      }, { timeout: 120_000 })).rejects.toBe(rollback);
    } finally {
      await db.$disconnect();
    }
  },
);

it.skipIf(process.env.EFFECT_EDIT_DATABASE_TEST !== '1')(
  'keeps the packaging of an output branch but starts every film unrendered',
  async () => {
    const db = new PrismaService(new ConfigService({
      DATABASE_URL: process.env.DATABASE_URL ??
        'postgresql://postgres:postgres@localhost:5432/ai_marketing?schema=public',
    }));
    const repository = new WorkflowWorkingRepository(db);
    const rollback = new Error('EFFECT_EDIT_TEST_ROLLBACK');
    try {
      await expect(db.$transaction(async (tx) => {
        const source = await tx.workingArtifact.findFirstOrThrow({ where: {
          nodeId: 'FINAL_OUTPUT', availability: 'AVAILABLE',
          artifactKey: { startsWith: 'final-video:' },
          workflowRun: { workflow: 'EFFECT', workflowSpace: 'EFFECT', activeKey: 'ACTIVE' },
        }, orderBy: { updatedAt: 'desc' } });
        const outputRuns = await tx.effectFinalOutputRun.findMany({ where: {
          projectId: source.projectId, workflowRunId: source.workflowRunId,
        }, include: { items: true } });
        expect(outputRuns.length).toBeGreaterThan(0);
        const begun = await repository.beginEffectNodeEditInTransaction(
          tx, source.projectId, source.workflowRunId, 'FINAL_OUTPUT', 'BATCH');
        expect(begun).not.toBeNull();
        expect(begun!.created).toBe(true);
        const childArtifacts = await tx.workingArtifact.findMany({ where: {
          projectId: source.projectId, workflowRunId: begun!.runId,
          availability: 'AVAILABLE',
        }, select: { artifactKey: true } });
        expect(childArtifacts.some((item) => item.artifactKey.startsWith('final-video:'))).toBe(false);
        expect(childArtifacts.some((item) => item.artifactKey.startsWith('final-delivery:'))).toBe(false);
        // The films are downstream of the mix stage, so the branch keeps its packaging...
        expect(await tx.effectPackagingRun.count({ where: {
          projectId: source.projectId, workflowRunId: begun!.runId, status: 'COMPLETED',
        } })).toBeGreaterThan(0);
        // ...but every film has to be rendered again before the node counts as confirmed.
        const childRuns = await tx.effectFinalOutputRun.findMany({ where: {
          projectId: source.projectId, workflowRunId: begun!.runId,
        }, include: { items: true } });
        expect(childRuns.length).toBe(new Set(outputRuns.map((run) => run.templateId)).size);
        for (const run of childRuns) {
          expect(run.status).toBe('PENDING_RENDER');
          for (const item of run.items) {
            expect(item.status).toBe('QUEUED');
            expect(item.fileObjectId).toBeNull();
            expect(item.assetId).toBeNull();
          }
        }
        throw rollback;
      }, { timeout: 120_000 })).rejects.toBe(rollback);
    } finally {
      await db.$disconnect();
    }
  },
  // Cloning the packaging of every template takes well over the 5s default on a cold database.
  60_000,
);

it.skipIf(process.env.EFFECT_EDIT_DATABASE_TEST !== '1')(
  'forks the first version of a regenerated stage when the caller asks for a branch every time',
  async () => {
    const db = new PrismaService(new ConfigService({
      DATABASE_URL: process.env.DATABASE_URL ??
        'postgresql://postgres:postgres@localhost:5432/ai_marketing?schema=public',
    }));
    const repository = new WorkflowWorkingRepository(db);
    const rollback = new Error('EFFECT_EDIT_TEST_ROLLBACK');
    try {
      await expect(db.$transaction(async (tx) => {
        const source = await tx.workingArtifact.findFirstOrThrow({ where: {
          nodeId: 'TEMPLATE_MIX', availability: 'AVAILABLE',
          artifactKey: { startsWith: 'mix-template:' },
          workflowRun: { workflow: 'EFFECT', workflowSpace: 'EFFECT', activeKey: 'ACTIVE' },
        }, orderBy: { updatedAt: 'desc' } });
        const workspace = await tx.effectImportWorkspace.findFirstOrThrow({ where: {
          projectId: source.projectId, workflowRunId: source.workflowRunId,
        }, include: { drafts: { include: { products: true } } } });
        // A published branch forked at the mix stage: stages 0-3 resolve back to the ancestor run,
        // while the mix stage has no confirmed version of its own in the branch yet.
        const branch = await tx.workflowRun.create({ data: {
          projectId: source.projectId, workflow: 'EFFECT', workflowSpace: 'EFFECT',
          parentWorkflowRunId: source.workflowRunId, forkNodeId: 'TEMPLATE_MIX',
          branchPublishedAt: new Date(), activeKey: null,
        } });
        const branchWorkspace = await tx.effectImportWorkspace.create({ data: {
          projectId: source.projectId, workflowRunId: branch.id,
          currentMode: workspace.currentMode, revision: workspace.revision,
        } });
        for (const draft of workspace.drafts) {
          const copyDraft = await tx.effectImportDraft.create({ data: {
            projectId: source.projectId, workspaceId: branchWorkspace.id,
            mode: draft.mode, status: draft.status,
            globalConfig: draft.globalConfig as never,
            revision: draft.revision, validatedRevision: draft.validatedRevision,
            validationIssues: draft.validationIssues as never,
            validatedAt: draft.validatedAt, completedAt: draft.completedAt,
          } });
          for (const product of draft.products) {
            const copyProduct = await tx.effectImportProduct.create({ data: {
              projectId: source.projectId, workflowRunId: branch.id,
              draftId: copyDraft.id, status: product.status,
              name: product.name, category: product.category, sku: product.sku,
              normalizedSku: product.normalizedSku, commerceUrl: product.commerceUrl,
              configOverride: product.configOverride as never, sortOrder: product.sortOrder,
            } });
            const materials = await tx.effectImportMaterial.findMany({ where: {
              projectId: source.projectId, workflowRunId: source.workflowRunId,
              productId: product.id,
            } });
            if (materials.length) await tx.effectImportMaterial.createMany({ data:
              materials.map((item) => ({
                projectId: source.projectId, workflowRunId: branch.id,
                productId: copyProduct.id, type: item.type, status: item.status,
                expectedFileName: item.expectedFileName,
                originalFileName: item.originalFileName, mimeType: item.mimeType,
                sizeBytes: item.sizeBytes, storageKey: item.storageKey,
                fileObjectId: item.fileObjectId,
                failureDisposition: item.failureDisposition,
                errorCode: item.errorCode, errorMessage: item.errorMessage,
                retryCount: item.retryCount, createdAt: item.createdAt,
              })),
            });
          }
        }
        await tx.workflowRun.update({ where: { id: source.workflowRunId },
          data: { activeKey: null } });
        await tx.workflowRun.update({ where: { id: branch.id },
          data: { activeKey: 'ACTIVE' } });
        // Without the option this is the initial version: the branch itself is rewritten in place.
        const plain = await repository.beginEffectNodeEditInTransaction(
          tx, source.projectId, branch.id, 'TEMPLATE_MIX', 'BATCH');
        expect(plain).toEqual(expect.objectContaining({ runId: branch.id, created: false }));
        // With it, every successful regeneration is a version, so even the first one forks.
        const begun = await repository.beginEffectNodeEditInTransaction(
          tx, source.projectId, branch.id, 'TEMPLATE_MIX', 'BATCH', { always: true });
        expect(begun).not.toBeNull();
        expect(begun!.created).toBe(true);
        expect(begun!.runId).not.toBe(branch.id);
        expect(begun!.parentWorkflowRunId).toBe(branch.id);
        const childArtifacts = await tx.workingArtifact.findMany({ where: {
          projectId: source.projectId, workflowRunId: begun!.runId,
          availability: 'AVAILABLE',
        }, select: { artifactKey: true } });
        expect(childArtifacts.some((item) => item.artifactKey.startsWith('render-clip:'))).toBe(true);
        expect(childArtifacts.some((item) => item.artifactKey.startsWith('mix-template:'))).toBe(false);
        expect(childArtifacts.some((item) => item.artifactKey.startsWith('timeline-project:'))).toBe(false);
        expect(childArtifacts.some((item) => item.artifactKey.startsWith('timeline-package:'))).toBe(false);
        expect(childArtifacts.some((item) => item.artifactKey.startsWith('final-video:'))).toBe(false);
        expect(childArtifacts.some((item) => item.artifactKey.startsWith('final-delivery:'))).toBe(false);
        throw rollback;
      }, { timeout: 120_000 })).rejects.toBe(rollback);
    } finally {
      await db.$disconnect();
    }
  },
  60_000,
);

it.skipIf(process.env.EFFECT_EDIT_DATABASE_TEST !== '1')(
  'starts an import edit from an artifact inherited across a downstream fork',
  async () => {
    const db = new PrismaService(new ConfigService({
      DATABASE_URL: process.env.DATABASE_URL ??
        'postgresql://postgres:postgres@localhost:5432/ai_marketing?schema=public',
    }));
    const repository = new WorkflowWorkingRepository(db);
    const rollback = new Error('EFFECT_EDIT_TEST_ROLLBACK');
    try {
      await expect(db.$transaction(async (tx) => {
        const source = await tx.workingArtifact.findFirstOrThrow({ where: {
          nodeId: 'SOURCE_IMPORT', availability: 'AVAILABLE', workflowRun: {
            workflow: 'EFFECT', workflowSpace: 'EFFECT', activeKey: 'ACTIVE',
          },
        } });
        const workspace = await tx.effectImportWorkspace.findFirstOrThrow({ where: {
          projectId: source.projectId, workflowRunId: source.workflowRunId,
        }, include: { drafts: { include: { products: true } } } });
        const branch = await tx.workflowRun.create({ data: {
          projectId: source.projectId, workflow: 'EFFECT', workflowSpace: 'EFFECT',
          parentWorkflowRunId: source.workflowRunId, forkNodeId: 'PROMPT_GENERATION',
          branchPublishedAt: new Date(), activeKey: null,
        } });
        const branchWorkspace = await tx.effectImportWorkspace.create({ data: {
          projectId: source.projectId, workflowRunId: branch.id,
          currentMode: workspace.currentMode, revision: workspace.revision,
        } });
        for (const draft of workspace.drafts) {
          const copyDraft = await tx.effectImportDraft.create({ data: {
            projectId: source.projectId, workspaceId: branchWorkspace.id,
            mode: draft.mode, status: draft.status,
            globalConfig: draft.globalConfig as never,
            revision: draft.revision, validatedRevision: draft.validatedRevision,
            validationIssues: draft.validationIssues as never,
            validatedAt: draft.validatedAt, completedAt: draft.completedAt,
          } });
          for (const product of draft.products) {
            const copyProduct = await tx.effectImportProduct.create({ data: {
              projectId: source.projectId, workflowRunId: branch.id,
              draftId: copyDraft.id, status: product.status,
              name: product.name, category: product.category, sku: product.sku,
              normalizedSku: product.normalizedSku, commerceUrl: product.commerceUrl,
              configOverride: product.configOverride as never, sortOrder: product.sortOrder,
            } });
            const materials = await tx.effectImportMaterial.findMany({ where: {
              projectId: source.projectId, workflowRunId: source.workflowRunId,
              productId: product.id,
            } });
            if (materials.length) await tx.effectImportMaterial.createMany({ data:
              materials.map((item) => ({
                projectId: source.projectId, workflowRunId: branch.id,
                productId: copyProduct.id, type: item.type, status: item.status,
                expectedFileName: item.expectedFileName,
                originalFileName: item.originalFileName, mimeType: item.mimeType,
                sizeBytes: item.sizeBytes, storageKey: item.storageKey,
                fileObjectId: item.fileObjectId,
                failureDisposition: item.failureDisposition,
                errorCode: item.errorCode, errorMessage: item.errorMessage,
                retryCount: item.retryCount, createdAt: item.createdAt,
              })),
            });
          }
        }
        await tx.workflowRun.update({ where: { id: source.workflowRunId },
          data: { activeKey: null } });
        await tx.workflowRun.update({ where: { id: branch.id },
          data: { activeKey: 'ACTIVE' } });
        const begun = await repository.beginEffectNodeEditInTransaction(
          tx, source.projectId, branch.id, 'SOURCE_IMPORT');
        expect(begun?.created).toBe(true);
        expect(begun?.parentWorkflowRunId).toBe(branch.id);
        const inherited = await tx.workingArtifact.findFirstOrThrow({ where: {
          projectId: source.projectId, workflowRunId: begun!.runId,
          nodeId: 'SOURCE_IMPORT',
        } });
        expect(inherited.artifactKey).toContain(Object.values(begun!.productIdMap)[0]);
        throw rollback;
      }, { timeout: 120_000 })).rejects.toBe(rollback);
    } finally {
      await db.$disconnect();
    }
  },
);
