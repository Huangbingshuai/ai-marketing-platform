import { ConfigService } from '@nestjs/config';
import { expect, it } from 'vitest';
import type { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { WorkflowWorkingRepository } from '../../../platform/workflow/workflow-working.repository';
import { EffectPromptRepository } from './effect-prompt.repository';
import type { WorkingArtifactUpsertInput } from '../../../platform/workflow/workflow-working.repository';

it.skipIf(process.env.EFFECT_EDIT_DATABASE_TEST !== '1')(
  'saves one manually edited Prompt into the parent branch without publishing the edit child',
  async () => {
    const db = new PrismaService(new ConfigService({
      DATABASE_URL: process.env.DATABASE_URL ??
        'postgresql://postgres:postgres@localhost:5432/ai_marketing?schema=public',
    }));
    const rollback = new Error('PROMPT_MANUAL_SAVE_ROLLBACK');
    try {
      await expect(db.$transaction(async (tx) => {
        const source = await tx.workingArtifact.findFirstOrThrow({ where: {
          nodeId: 'PROMPT_GENERATION', availability: 'AVAILABLE',
          workflowRun: { workflow: 'EFFECT', workflowSpace: 'EFFECT',
            OR: [{ parentWorkflowRunId: null }, { branchPublishedAt: { not: null } }],
            workingArtifacts: { some: { nodeId: 'SEGMENT_RENDER',
              artifactKey: { startsWith: 'render-clip:' } } } },
        } });
        await tx.workflowRun.updateMany({ where: { projectId: source.projectId,
          workflow: 'EFFECT', workflowSpace: 'EFFECT', activeKey: 'ACTIVE' },
        data: { activeKey: null } });
        await tx.workflowRun.update({ where: { id: source.workflowRunId },
          data: { activeKey: 'ACTIVE' } });
        const clipsBefore = await tx.workingArtifact.findMany({ where: {
          projectId: source.projectId, workflowRunId: source.workflowRunId,
          artifactKey: { startsWith: 'render-clip:' },
        }, select: { id: true, revision: true, freshness: true } });
        expect(clipsBefore.length).toBeGreaterThan(0);
        const working = new WorkflowWorkingRepository(db);
        const begun = await working.beginEffectNodeEditInTransaction(
          tx, source.projectId, source.workflowRunId, 'PROMPT_GENERATION');
        expect(begun?.runId).not.toBe(source.workflowRunId);
        const childId = begun!.runId;
        const childArtifact = await tx.workingArtifact.findFirstOrThrow({ where: {
          projectId: source.projectId, workflowRunId: childId,
          nodeId: 'PROMPT_GENERATION',
        }, include: { dependencies: true, files: { include: { fileObject: true } } } });
        const childResult = await tx.effectPromptResult.findFirstOrThrow({ where: {
          projectId: source.projectId, workflowRunId: childId,
          productId: childArtifact.artifactKey.slice('prompt-batch:'.length),
        }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
        const draft = structuredClone(childResult.draftResult) as Record<string, unknown>;
        const items = draft.items as Array<Record<string, unknown>>;
        expect(items.length).toBeGreaterThan(0);
        items[0] = { ...items[0], creativeCore: `${items[0]?.creativeCore ?? ''} 仅说明修改` };
        await tx.effectPromptResult.update({ where: { id: childResult.id }, data: {
          draftResult: draft as Prisma.InputJsonValue,
        } });
        const input: WorkingArtifactUpsertInput = {
          kind: childArtifact.kind, name: childArtifact.name,
          directory: childArtifact.directory, type: childArtifact.type,
          tags: childArtifact.tags, payload: draft, metadata: childArtifact.metadata,
          sourceRunId: childResult.runId, sourceArtifactId: childResult.id,
          files: childArtifact.files.map((file) => ({
            fileObjectId: file.fileObjectId, role: file.role,
            sortOrder: file.sortOrder, originalFileName: file.fileObject.originalFileName,
            mimeType: file.fileObject.mimeType, sha256: file.fileObject.sha256,
          })),
          dependencies: childArtifact.dependencies.map((dependency) => ({
            sourceType: dependency.sourceType, sourceNodeId: dependency.sourceNodeId,
            sourceArtifactId: dependency.sourceArtifactId, sourceKey: dependency.sourceKey,
            sourceRevision: dependency.sourceRevision, sourceHash: dependency.sourceHash,
          })),
        };
        const scopedDb = { $transaction: async <T>(callback:
          (transaction: Prisma.TransactionClient) => Promise<T>) => callback(tx),
        } as unknown as PrismaService;
        const prompt = new EffectPromptRepository(scopedDb, working);
        const saved = await (prompt as unknown as {
          commitValidatedResultInTransaction: (
            transaction: Prisma.TransactionClient, projectId: string, resultId: string,
            revision: number, artifactInput: WorkingArtifactUpsertInput,
          ) => Promise<{ kind: string; workflowRunId: string }>;
        }).commitValidatedResultInTransaction(tx, source.projectId,
          childResult.id, childResult.revision, input);
        expect(saved.kind).toBe('COMMITTED');
        expect(saved.workflowRunId).toBe(source.workflowRunId);
        expect((await tx.workflowRun.findUniqueOrThrow({ where: { id: childId } })).branchPublishedAt)
          .toBeNull();
        expect((await tx.workingArtifact.findUniqueOrThrow({ where: { id: source.id } })).revision)
          .toBe(source.revision + 1);
        expect(await tx.workingArtifact.findMany({ where: {
          projectId: source.projectId, workflowRunId: source.workflowRunId,
          artifactKey: { startsWith: 'render-clip:' },
        }, select: { id: true, revision: true, freshness: true } })).toEqual(clipsBefore);
        throw rollback;
      }, { timeout: 120_000 })).rejects.toBe(rollback);
    } finally {
      await db.$disconnect();
    }
  },
);

it.skipIf(process.env.EFFECT_EDIT_DATABASE_TEST !== '1')(
  'starts a paid Prompt batch in a hidden child and publishes that same child after confirmation',
  async () => {
    const db = new PrismaService(new ConfigService({
      DATABASE_URL: process.env.DATABASE_URL ??
        'postgresql://postgres:postgres@localhost:5432/ai_marketing?schema=public',
    }));
    const rollback = new Error('PROMPT_HIDDEN_EDIT_ROLLBACK');
    try {
      await expect(db.$transaction(async (tx) => {
        const source = await tx.workingArtifact.findFirstOrThrow({ where: {
          nodeId: 'PROMPT_GENERATION', availability: 'AVAILABLE', freshness: 'CURRENT',
          workflowRun: { workflow: 'EFFECT', workflowSpace: 'EFFECT', activeKey: 'ACTIVE' },
        }, include: { dependencies: true, files: { include: { fileObject: true } } } });
        const parentResult = await tx.effectPromptResult.findFirstOrThrow({ where: {
          projectId: source.projectId, workflowRunId: source.workflowRunId,
          productId: source.artifactKey.slice('prompt-batch:'.length),
        }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
        const settings = await tx.workflowNodeState.findUniqueOrThrow({ where: {
          projectId_workflowRunId_nodeId: {
            projectId: source.projectId, workflowRunId: source.workflowRunId,
            nodeId: `PROMPT_GENERATION:${parentResult.productId}`,
          },
        } });
        const working = new WorkflowWorkingRepository(db);
        const scopedDb = { $transaction: async <T>(callback: (transaction: Prisma.TransactionClient) => Promise<T>) =>
          callback(tx) } as unknown as PrismaService;
        const prompt = new EffectPromptRepository(scopedDb, working);
        const started = await prompt.startRun(
          source.projectId, source.workflowRunId, parentResult.productId, {
            operation: 'BATCH_GENERATE', targetItemId: null,
            expectedSettingsRevision: settings.revision,
            expectedResultRevision: parentResult.revision,
            idempotencyKey: `hidden-prompt-test:${crypto.randomUUID()}`,
          },
        );
        expect(started.kind).toBe('CREATED');
        if (started.kind !== 'CREATED') throw new Error(`PROMPT_START_${started.kind}`);
        const childId = started.run.workflowRunId;
        expect(childId).not.toBe(source.workflowRunId);
        const child = await tx.workflowRun.findUniqueOrThrow({ where: { id: childId } });
        expect(child.branchPublishedAt).toBeNull();
        expect(child.editSessionNodeId).toBe('PROMPT_GENERATION');
        const childArtifact = await tx.workingArtifact.findFirstOrThrow({ where: {
          projectId: source.projectId, workflowRunId: childId,
          nodeId: 'PROMPT_GENERATION',
        }, include: { dependencies: true, files: { include: { fileObject: true } } } });
        const draft = structuredClone(parentResult.draftResult) as Record<string, unknown>;
        const items = draft.items as Array<Record<string, unknown>>;
        items[0] = { ...items[0], content: `${items[0]?.content ?? ''} 编辑分支回归测试` };
        await tx.effectPromptRun.update({ where: { id: started.run.id }, data: {
          status: 'COMPLETED', progress: 100, completedAt: new Date(),
        } });
        const result = await tx.effectPromptResult.create({ data: {
          projectId: source.projectId, workflowRunId: childId,
          productId: started.run.productId, runId: started.run.id,
          generatedResult: draft as Prisma.InputJsonValue,
          draftResult: draft as Prisma.InputJsonValue,
          manualOverrides: {}, qualityStatus: parentResult.qualityStatus,
          sourceFingerprint: started.run.sourceFingerprint,
          settingsHash: started.run.settingsHash,
        } });
        const input: WorkingArtifactUpsertInput = {
          kind: childArtifact.kind, name: childArtifact.name,
          directory: childArtifact.directory, type: childArtifact.type,
          tags: childArtifact.tags, payload: draft, metadata: childArtifact.metadata,
          sourceRunId: started.run.id, sourceArtifactId: result.id,
          files: childArtifact.files.map((file) => ({
            fileObjectId: file.fileObjectId, role: file.role,
            sortOrder: file.sortOrder, originalFileName: file.fileObject.originalFileName,
            mimeType: file.fileObject.mimeType, sha256: file.fileObject.sha256,
          })),
          dependencies: childArtifact.dependencies.map((dependency) => ({
            sourceType: dependency.sourceType, sourceNodeId: dependency.sourceNodeId,
            sourceArtifactId: dependency.sourceArtifactId, sourceKey: dependency.sourceKey,
            sourceRevision: dependency.sourceRevision, sourceHash: dependency.sourceHash,
          })),
        };
        const committed = await (prompt as unknown as {
          commitValidatedResultInTransaction: (
            transaction: Prisma.TransactionClient, projectId: string, resultId: string,
            revision: number, artifactInput: WorkingArtifactUpsertInput,
          ) => Promise<{ kind: string; workflowRunId: string }>;
        }).commitValidatedResultInTransaction(tx, source.projectId, result.id, result.revision, input);
        expect(committed.kind).toBe('COMMITTED');
        expect(committed.workflowRunId).toBe(childId);
        expect((await tx.workflowRun.findUniqueOrThrow({ where: { id: childId } })).branchPublishedAt)
          .not.toBeNull();
        expect(await tx.workflowRun.count({ where: {
          projectId: source.projectId, parentWorkflowRunId: childId,
        } })).toBe(0);
        expect((await tx.workingArtifact.findUniqueOrThrow({ where: { id: source.id } })).revision)
          .toBe(source.revision);
        throw rollback;
      }, { timeout: 120_000 })).rejects.toBe(rollback);
    } finally {
      await db.$disconnect();
    }
  },
);

// Exercises the complete imported test project inside a rollback-only transaction.
// Set both variables explicitly; the default test suite never touches local project data.
it.skipIf(
  process.env.EFFECT_PROMPT_BRANCH_DATABASE_TEST !== '1' ||
  !process.env.EFFECT_PROMPT_BRANCH_TEST_PROJECT_ID,
)('clones the prompt branch workspace without changing its parent', async () => {
  const db = new PrismaService(new ConfigService({
    DATABASE_URL: process.env.DATABASE_URL ??
      'postgresql://postgres:postgres@localhost:5432/ai_marketing?schema=public',
  }));
  const projectId = process.env.EFFECT_PROMPT_BRANCH_TEST_PROJECT_ID!;
  const repository = new EffectPromptRepository(db, new WorkflowWorkingRepository(db));
  const rollback = new Error('PROMPT_BRANCH_TEST_ROLLBACK');
  try {
    await expect(db.$transaction(async (transaction) => {
      const parent = await transaction.workflowRun.findFirstOrThrow({
        where: { projectId, workflow: 'EFFECT', workflowSpace: 'EFFECT', activeKey: 'ACTIVE' },
      });
      const product = await transaction.effectImportProduct.findFirstOrThrow({
        where: { projectId, workflowRunId: parent.id, status: 'ACTIVE' },
      });
      const oldArtifact = await transaction.workingArtifact.findFirstOrThrow({
        where: { projectId, workflowRunId: parent.id, nodeId: 'PROMPT_GENERATION' },
      });
      const fork = await (repository as unknown as {
        forkValidatedPromptInTransaction: (
          tx: Prisma.TransactionClient, projectId: string, runId: string, productId: string,
        ) => Promise<{ childRunId: string; childProductId: string; childInsightId: string }>;
      }).forkValidatedPromptInTransaction(transaction, projectId, parent.id, product.id);
      expect(fork.childRunId).not.toBe(parent.id);
      expect(fork.childProductId).not.toBe(product.id);
      expect(await transaction.effectImportWorkspace.count({
        where: { projectId, workflowRunId: fork.childRunId },
      })).toBe(1);
      expect(await transaction.effectImportMaterial.count({
        where: { projectId, workflowRunId: fork.childRunId, productId: fork.childProductId },
      })).toBeGreaterThan(0);
      expect(await transaction.workingArtifact.count({
        where: { projectId, workflowRunId: fork.childRunId,
          nodeId: 'INFORMATION_EXTRACTION', id: fork.childInsightId },
      })).toBe(1);
      expect(await transaction.workingArtifact.findUniqueOrThrow({
        where: { id: oldArtifact.id }, select: { revision: true, contentHash: true },
      })).toEqual({ revision: oldArtifact.revision, contentHash: oldArtifact.contentHash });
      throw rollback;
    }, { timeout: 30_000 })).rejects.toBe(rollback);
  } finally {
    await db.$disconnect();
  }
});

it.skipIf(
  process.env.EFFECT_PROMPT_BRANCH_DATABASE_TEST !== '1' ||
  !process.env.EFFECT_PROMPT_BRANCH_TEST_PROJECT_ID,
)('publishes a changed prompt as a child while preserving the parent revision', async () => {
  const db = new PrismaService(new ConfigService({
    DATABASE_URL: process.env.DATABASE_URL ??
      'postgresql://postgres:postgres@localhost:5432/ai_marketing?schema=public',
  }));
  const projectId = process.env.EFFECT_PROMPT_BRANCH_TEST_PROJECT_ID!;
  const repository = new EffectPromptRepository(db, new WorkflowWorkingRepository(db));
  const rollback = new Error('PROMPT_BRANCH_TEST_ROLLBACK');
  try {
    await expect(db.$transaction(async (transaction) => {
      const parent = await transaction.workflowRun.findFirstOrThrow({
        where: { projectId, workflow: 'EFFECT', workflowSpace: 'EFFECT', activeKey: 'ACTIVE' },
      });
      const product = await transaction.effectImportProduct.findFirstOrThrow({
        where: { projectId, workflowRunId: parent.id, status: 'ACTIVE' },
      });
      const previous = await transaction.workingArtifact.findFirstOrThrow({
        where: { projectId, workflowRunId: parent.id,
          nodeId: 'PROMPT_GENERATION', artifactKey: `prompt-batch:${product.id}` },
        include: { dependencies: true },
      });
      const current = await transaction.effectPromptResult.findFirstOrThrow({
        where: { projectId, workflowRunId: parent.id, productId: product.id },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], include: { run: true },
      });
      const newRun = await transaction.effectPromptRun.create({
        data: {
          projectId, workflowRunId: parent.id, productId: product.id,
          operation: 'BATCH_GENERATE', targetItemId: null,
          idempotencyKey: `branch-test:${crypto.randomUUID()}`,
          requestHash: current.run.requestHash,
          sourceFingerprint: current.run.sourceFingerprint,
          settingsHash: current.run.settingsHash,
          inputSnapshot: current.run.inputSnapshot as Prisma.InputJsonValue,
          status: 'COMPLETED', progress: 100, warnings: [], completedAt: new Date(),
        },
      });
      const draft = structuredClone(current.draftResult) as Record<string, unknown>;
      const items = draft.items as Array<Record<string, unknown>>;
      items[0] = { ...items[0], content: `${items[0]?.content ?? ''} 分支事务测试` };
      const newResult = await transaction.effectPromptResult.create({
        data: {
          projectId, workflowRunId: parent.id, productId: product.id,
          runId: newRun.id, generatedResult: draft as Prisma.InputJsonValue,
          draftResult: draft as Prisma.InputJsonValue, manualOverrides: {},
          qualityStatus: current.qualityStatus,
          sourceFingerprint: current.sourceFingerprint,
          settingsHash: current.settingsHash,
        },
      });
      const input: WorkingArtifactUpsertInput = {
        kind: previous.kind, name: previous.name,
        directory: previous.directory, type: previous.type, tags: previous.tags,
        payload: draft, metadata: previous.metadata,
        sourceRunId: newRun.id, sourceArtifactId: newResult.id,
        dependencies: previous.dependencies.map((dependency) => ({
          sourceType: dependency.sourceType, sourceNodeId: dependency.sourceNodeId,
          sourceArtifactId: dependency.sourceArtifactId,
          sourceKey: dependency.sourceKey,
          sourceRevision: dependency.sourceRevision,
          sourceHash: dependency.sourceHash,
        })),
      };
      const committed = await (repository as unknown as {
        commitValidatedResultInTransaction: (
          tx: Prisma.TransactionClient, projectId: string, resultId: string,
          revision: number, input: WorkingArtifactUpsertInput,
        ) => Promise<{ kind: string; workflowRunId: string; artifact: { revision: number } }>;
      }).commitValidatedResultInTransaction(
        transaction, projectId, newResult.id, newResult.revision, input,
      );
      expect(committed.kind).toBe('COMMITTED');
      expect(committed.workflowRunId).not.toBe(parent.id);
      expect(committed.artifact.revision).toBe(previous.revision + 1);
      const parentAfter = await transaction.workingArtifact.findUniqueOrThrow({
        where: { id: previous.id }, select: { revision: true, contentHash: true },
      });
      expect(parentAfter).toEqual({ revision: previous.revision, contentHash: previous.contentHash });
      const child = await transaction.workflowRun.findUniqueOrThrow({
        where: { id: committed.workflowRunId },
      });
      expect(child.parentWorkflowRunId).toBe(parent.id);
      expect(child.branchPublishedAt).not.toBeNull();
      expect(child.activeKey).toBe('ACTIVE');
      throw rollback;
    }, { timeout: 30_000 })).rejects.toBe(rollback);
  } finally {
    await db.$disconnect();
  }
});

it.skipIf(
  process.env.EFFECT_PROMPT_BRANCH_DATABASE_TEST !== '1' ||
  !process.env.EFFECT_PROMPT_BRANCH_TEST_PROJECT_ID,
)('preserves the old result when an edited item belongs to the same prompt run', async () => {
  const db = new PrismaService(new ConfigService({
    DATABASE_URL: process.env.DATABASE_URL ??
      'postgresql://postgres:postgres@localhost:5432/ai_marketing?schema=public',
  }));
  const projectId = process.env.EFFECT_PROMPT_BRANCH_TEST_PROJECT_ID!;
  const repository = new EffectPromptRepository(db, new WorkflowWorkingRepository(db));
  const rollback = new Error('PROMPT_BRANCH_TEST_ROLLBACK');
  try {
    await expect(db.$transaction(async (transaction) => {
      const parent = await transaction.workflowRun.findFirstOrThrow({
        where: { projectId, workflow: 'EFFECT', workflowSpace: 'EFFECT', activeKey: 'ACTIVE' },
      });
      const previous = await transaction.workingArtifact.findFirstOrThrow({
        where: { projectId, workflowRunId: parent.id, nodeId: 'PROMPT_GENERATION' },
        include: { dependencies: true },
      });
      const result = await transaction.effectPromptResult.findUniqueOrThrow({
        where: { id: previous.sourceArtifactId! }, include: { run: true },
      });
      const changed = structuredClone(result.draftResult) as Record<string, unknown>;
      const items = changed.items as Array<Record<string, unknown>>;
      items[0] = { ...items[0], content: `${items[0]?.content ?? ''} 单条编辑分支测试` };
      const edited = await transaction.effectPromptResult.update({
        where: { id: result.id },
        data: { draftResult: changed as Prisma.InputJsonValue, revision: { increment: 1 } },
      });
      const input: WorkingArtifactUpsertInput = {
        kind: previous.kind, name: previous.name,
        directory: previous.directory, type: previous.type, tags: previous.tags,
        payload: changed, metadata: previous.metadata,
        sourceRunId: result.runId, sourceArtifactId: result.id,
        dependencies: previous.dependencies.map((dependency) => ({
          sourceType: dependency.sourceType, sourceNodeId: dependency.sourceNodeId,
          sourceArtifactId: dependency.sourceArtifactId,
          sourceKey: dependency.sourceKey,
          sourceRevision: dependency.sourceRevision,
          sourceHash: dependency.sourceHash,
        })),
      };
      const committed = await (repository as unknown as {
        commitValidatedResultInTransaction: (
          tx: Prisma.TransactionClient, projectId: string, resultId: string,
          revision: number, input: WorkingArtifactUpsertInput,
        ) => Promise<{ kind: string; workflowRunId: string }>;
      }).commitValidatedResultInTransaction(
        transaction, projectId, edited.id, edited.revision, input,
      );
      expect(committed.kind).toBe('COMMITTED');
      expect(committed.workflowRunId).not.toBe(parent.id);
      const preserved = await transaction.effectPromptResult.findFirstOrThrow({
        where: { projectId, workflowRunId: parent.id, productId: result.productId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      expect(preserved.id).not.toBe(result.id);
      expect(preserved.draftResult).toEqual(previous.payload);
      expect((await transaction.workingArtifact.findUniqueOrThrow({
        where: { id: previous.id },
      })).revision).toBe(previous.revision);
      throw rollback;
    }, { timeout: 30_000 })).rejects.toBe(rollback);
  } finally {
    await db.$disconnect();
  }
});
