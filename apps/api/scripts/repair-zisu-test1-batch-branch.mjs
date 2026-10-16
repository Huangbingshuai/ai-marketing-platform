// One-time recovery for 紫苏梅子酱 / 测试1. Dry-run (rollback) by default.
// This splits the September Prompt v4 batch from the v3 mix branch without
// generating media or changing the 100 confirmed mix/package/output contents.
import { loadEnvFile } from 'node:process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

try {
  loadEnvFile(resolve(import.meta.dirname, '../../../.env'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const require = createRequire(import.meta.url);
const { ConfigService } = require('@nestjs/config');
const { PrismaService } = require('../dist/database/prisma.service.js');
const {
  WorkflowWorkingRepository,
  workingArtifactContentHash,
} = require('../dist/platform/workflow/workflow-working.repository.js');
const {
  EffectPromptRepository,
} = require('../dist/workflows/effect/prompt-generation/effect-prompt.repository.js');
const {
  EffectSegmentRenderService,
} = require('../dist/workflows/effect/segment-render/effect-segment-render.service.js');
const { workflowStateHash } = require('../dist/platform/workflow/workflow-state-hash.js');

const projectId = '40d1273a-e1cd-4cae-8f83-02fdaf324dc1';
const parentId = '65f5b90c-046c-4f28-92e1-0e867e9f4e5f';
const oldProductId = '2e31a4b1-0494-4a25-ab40-93846c9c98be';
const templateId = '0254fafe-4c3f-49a4-ad98-592289d9418e';
const oldPromptResultId = '73af3764-b6fe-4841-bf61-c09803980836';
const newPromptResultId = '8817f6bd-d604-49fd-9db1-a0751c0ab12a';
const oldBatchId = 'd689b4bc-6942-4716-aacd-049463c1da44';
const newBatchId = '0c76f233-208b-4664-b7b4-b0ea230070eb';
const oldPromptHash = '9c4cd64a48e8e00e7a615baced5ccf28ddb764b64d3bc8abeac355b1afb24194';
const newPromptHash = '17154d5fd3ec8242359b4d8dd97dbea397a8b78f74094b0d38fd7487a2ae23e9';
const expectedExistingChildren = [
  '8dc5243d-66bc-4bc3-8c85-14c09a09d93f',
  '7877fca9-1540-4823-b357-e733c34685aa',
  'f75f8f7c-8c46-45d5-add7-bb4ea375b809',
  '765a8257-9d4e-49da-a97e-60dc088320cf',
  '871fc54e-0fdb-4aec-ada4-434e040309f5',
];
const staleSecond = '2026-09-28T05:25:23';
const apply = process.argv.includes('--apply');
const rollback = new Error('DRY_RUN_ROLLBACK');
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const json = (value) => structuredClone(value);
const replaceId = (value, before, after) =>
  JSON.parse(JSON.stringify(value).replaceAll(before, after));
const db = new PrismaService(new ConfigService({ DATABASE_URL: process.env.DATABASE_URL }));
const promptRepository = new EffectPromptRepository(db, new WorkflowWorkingRepository(db));

const dependencyInput = (dependency) => ({
  sourceType: dependency.sourceType,
  sourceNodeId: dependency.sourceNodeId,
  sourceArtifactId: dependency.sourceArtifactId,
  sourceKey: dependency.sourceKey,
  sourceRevision: dependency.sourceRevision,
  sourceHash: dependency.sourceHash,
});
const fileInput = (file) => ({
  fileObjectId: file.fileObjectId,
  role: file.role,
  sortOrder: file.sortOrder,
  originalFileName: file.fileObject.originalFileName,
  mimeType: file.fileObject.mimeType,
  sha256: file.fileObject.sha256,
});
const artifactInput = (artifact, dependencies, files) => ({
  kind: artifact.kind,
  name: artifact.name,
  directory: artifact.directory,
  type: artifact.type,
  tags: artifact.tags,
  payload: artifact.payload,
  metadata: artifact.metadata,
  originalFileName: artifact.originalFileName,
  mimeType: artifact.mimeType,
  sizeBytes: artifact.sizeBytes,
  storageKey: artifact.storageKey,
  fileChecksum: artifact.kind === 'FILE' ? artifact.payload?.contentHash : undefined,
  sourceRunId: artifact.sourceRunId,
  sourceArtifactId: artifact.sourceArtifactId,
  dependencies,
  files,
});
try {
  await db.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "projects" WHERE "id"=${projectId}::uuid FOR UPDATE`;
      const parent = await tx.workflowRun.findUniqueOrThrow({ where: { id: parentId } });
      assert(
        parent.projectId === projectId &&
          parent.parentWorkflowRunId === null &&
          parent.activeKey === null,
        'Target root Run changed',
      );
      const existingChildren = await tx.workflowRun.findMany({
        where: { projectId, parentWorkflowRunId: parentId },
        select: { id: true, forkNodeId: true, branchPublishedAt: true },
      });
      assert(
        existingChildren.length === expectedExistingChildren.length &&
          existingChildren.every(
            (child) =>
              expectedExistingChildren.includes(child.id) &&
              child.forkNodeId === 'INFORMATION_EXTRACTION' &&
              !child.branchPublishedAt,
          ) &&
          (await tx.workflowRun.count({ where: { projectId } })) === 6,
        'Existing branch set changed; re-audit before recovery',
      );
      const variantCount = await tx.effectTemplateMixAiRun.count({
        where: { projectId, workflowRunId: parentId, templateId },
      });
      assert(variantCount > 0, 'Target template has no intelligent-fill history');
      const mixState = await tx.workflowNodeState.findUniqueOrThrow({
        where: {
          projectId_workflowRunId_nodeId: {
            projectId,
            workflowRunId: parentId,
            nodeId: 'TEMPLATE_MIX',
          },
        },
      });
      const templates = mixState.state?.templates ?? [];
      const targetTemplate = templates.find((template) => template.id === templateId);
      assert(
        targetTemplate?.workspace?.variants?.length === 100,
        'Expected exactly 100 existing films',
      );
      const activeJobs = await Promise.all([
        tx.effectPromptRun.count({
          where: { projectId, workflowRunId: parentId, status: { in: ['QUEUED', 'RUNNING'] } },
        }),
        tx.effectSegmentRenderTask.count({
          where: { projectId, workflowRunId: parentId, status: { in: ['QUEUED', 'RUNNING'] } },
        }),
        tx.effectPackagingRun.count({
          where: { projectId, workflowRunId: parentId, status: { in: ['QUEUED', 'RUNNING'] } },
        }),
        tx.effectFinalOutputRun.count({
          where: { projectId, workflowRunId: parentId, status: { in: ['QUEUED', 'RUNNING'] } },
        }),
      ]);
      assert(
        activeJobs.every((count) => count === 0),
        'A task is still running',
      );

      const currentPrompt = await tx.workingArtifact.findUniqueOrThrow({
        where: {
          projectId_workflowRunId_nodeId_artifactKey: {
            projectId,
            workflowRunId: parentId,
            nodeId: 'PROMPT_GENERATION',
            artifactKey: `prompt-batch:${oldProductId}`,
          },
        },
        include: { dependencies: true, files: { include: { fileObject: true } } },
      });
      assert(
        currentPrompt.revision === 4 &&
          currentPrompt.contentHash === newPromptHash &&
          currentPrompt.files.length === 0,
        'Current Prompt artifact changed',
      );
      assert(
        workingArtifactContentHash(
          artifactInput(currentPrompt, currentPrompt.dependencies.map(dependencyInput), []),
        ) === newPromptHash,
        'Current Prompt artifact does not reproduce its stored hash',
      );
      const [oldResult, newResult, oldBatch, newBatch, currentBatchArtifact] = await Promise.all([
        tx.effectPromptResult.findUniqueOrThrow({
          where: { id: oldPromptResultId },
          include: { run: true },
        }),
        tx.effectPromptResult.findUniqueOrThrow({
          where: { id: newPromptResultId },
          include: { run: true },
        }),
        tx.effectSegmentRenderBatch.findUniqueOrThrow({
          where: { id: oldBatchId },
          include: { product: true, tasks: { orderBy: [{ renderCode: 'asc' }, { id: 'asc' }] } },
        }),
        tx.effectSegmentRenderBatch.findUniqueOrThrow({
          where: { id: newBatchId },
          include: { product: true, tasks: { orderBy: [{ renderCode: 'asc' }, { id: 'asc' }] } },
        }),
        tx.workingArtifact.findUniqueOrThrow({
          where: {
            projectId_workflowRunId_nodeId_artifactKey: {
              projectId,
              workflowRunId: parentId,
              nodeId: 'SEGMENT_RENDER',
              artifactKey: `render-batch:${oldProductId}`,
            },
          },
          include: { dependencies: true, files: { include: { fileObject: true } } },
        }),
      ]);
      assert(
        oldResult.workflowRunId === parentId &&
          newResult.workflowRunId === parentId &&
          oldResult.productId === oldProductId &&
          newResult.productId === oldProductId,
        'Prompt results changed',
      );
      assert(
        oldBatch.workflowRunId === parentId &&
          oldBatch.sourcePromptRevision === 3 &&
          oldBatch.sourcePromptHash === oldPromptHash &&
          oldBatch.status === 'COMPLETED' &&
          oldBatch.tasks.length === 100 &&
          oldBatch.tasks.every((task) => task.status === 'COMPLETED' && task.outputFileObjectId),
        'Old 100-clip batch changed',
      );
      assert(
        newBatch.workflowRunId === parentId &&
          newBatch.sourcePromptRevision === 4 &&
          newBatch.sourcePromptHash === newPromptHash &&
          newBatch.status === 'COMPLETED' &&
          newBatch.tasks.length === 50 &&
          newBatch.tasks.every((task) => task.status === 'COMPLETED' && task.outputFileObjectId),
        'New 50-clip batch changed',
      );
      assert(
        currentBatchArtifact.sourceRunId === newBatchId && currentBatchArtifact.files.length === 50,
        'Current render-batch artifact changed',
      );
      assert(
        workingArtifactContentHash(
          artifactInput(
            currentBatchArtifact,
            currentBatchArtifact.dependencies.map(dependencyInput),
            currentBatchArtifact.files.map(fileInput),
          ),
        ) === currentBatchArtifact.contentHash,
        'Current render-batch hash does not reproduce',
      );

      const oldSnapshot = oldResult.run.inputSnapshot;
      const oldPromptInput = {
        ...artifactInput(currentPrompt, [], []),
        payload: json(oldResult.draftResult),
        metadata: { productId: oldProductId, qualityStatus: oldResult.draftResult.qualityStatus },
        sourceRunId: oldResult.runId,
        sourceArtifactId: oldResult.id,
        dependencies: [
          {
            sourceType: 'WORKING_ARTIFACT',
            sourceNodeId: 'INFORMATION_EXTRACTION',
            sourceArtifactId: oldSnapshot.insightArtifact.id,
            sourceKey: `marketing-insight:${oldProductId}`,
            sourceRevision: oldSnapshot.insightArtifact.revision,
            sourceHash: oldSnapshot.insightArtifact.contentHash,
          },
          {
            sourceType: 'EXECUTION_INPUT',
            sourceNodeId: `PROMPT_GENERATION:${oldProductId}`,
            sourceArtifactId: null,
            sourceKey: `PROMPT_GENERATION:${oldProductId}`,
            sourceRevision: null,
            sourceHash: oldResult.settingsHash,
          },
        ],
      };
      assert(
        workingArtifactContentHash(oldPromptInput) === oldPromptHash,
        'Old Prompt result cannot reproduce frozen render source hash',
      );
      assert(
        workflowStateHash(oldSnapshot.settings) === oldResult.settingsHash,
        'Old Prompt settings cannot reproduce their frozen hash',
      );

      const newTaskIds = newBatch.tasks.map((task) => task.id);
      const newClips = await tx.workingArtifact.findMany({
        where: {
          projectId,
          workflowRunId: parentId,
          nodeId: 'SEGMENT_RENDER',
          artifactKey: { in: newTaskIds.map((id) => `render-clip:${id}`) },
        },
        include: { dependencies: true, files: { include: { fileObject: true } } },
      });
      assert(
        newClips.length === 50 &&
          newClips.every(
            (clip) =>
              clip.freshness === 'CURRENT' &&
              clip.files.length === 0 &&
              workingArtifactContentHash(
                artifactInput(clip, clip.dependencies.map(dependencyInput), []),
              ) === clip.contentHash,
          ),
        'New clips are missing or cannot reproduce their hashes',
      );
      const boundIds = new Set(
        targetTemplate.workspace.variants.flatMap((variant) =>
          Object.values(variant.bindings).filter(Boolean),
        ),
      );
      const boundNewClips = newClips.filter((clip) => boundIds.has(clip.id));
      assert(boundNewClips.length === 6, 'The six unconfirmed newer clip bindings changed');
      const oldClips = await tx.workingArtifact.findMany({
        where: {
          projectId,
          workflowRunId: parentId,
          nodeId: 'SEGMENT_RENDER',
          artifactKey: { in: oldBatch.tasks.map((task) => `render-clip:${task.id}`) },
        },
        include: { dependencies: true },
      });
      assert(
        oldClips.length === 100 &&
          oldClips.every(
            (clip) =>
              clip.freshness === 'STALE' &&
              clip.availability === 'AVAILABLE' &&
              clip.dependencies.some(
                (dependency) =>
                  dependency.sourceRevision === 3 && dependency.sourceHash === oldPromptHash,
              ),
          ),
        'Old 100 clips have mixed stale causes',
      );
      const targetArtifacts = await tx.workingArtifact.findMany({
        where: {
          projectId,
          workflowRunId: parentId,
          nodeId: { in: ['TEMPLATE_MIX', 'FINAL_OUTPUT'] },
        },
        select: {
          id: true,
          artifactKey: true,
          freshness: true,
          availability: true,
          updatedAt: true,
        },
      });
      assert(
        targetArtifacts.length === 302 &&
          targetArtifacts.every(
            (artifact) =>
              artifact.freshness === 'STALE' &&
              artifact.availability === 'AVAILABLE' &&
              artifact.updatedAt.toISOString().startsWith(staleSecond),
          ),
        'Mix/output stale set no longer matches the batch update',
      );
      assert(
        oldClips.every((clip) => clip.updatedAt.toISOString().startsWith(staleSecond)),
        'An old clip was invalidated at a different time',
      );
      const newClipDependents = await tx.workingArtifactDependency.count({
        where: { projectId, sourceArtifactId: { in: newClips.map((clip) => clip.id) } },
      });
      assert(newClipDependents === 0, 'New clips already have confirmed descendants');

      const fork = await promptRepository.forkValidatedPromptInTransaction(
        tx,
        projectId,
        parentId,
        oldProductId,
      );
      const childId = fork.childRunId;
      const childProductId = fork.childProductId;
      const childInsight = await tx.workingArtifact.findUniqueOrThrow({
        where: { id: fork.childInsightId },
      });
      const childSource = await tx.workingArtifact.findUniqueOrThrow({
        where: {
          projectId_workflowRunId_nodeId_artifactKey: {
            projectId,
            workflowRunId: childId,
            nodeId: 'SOURCE_IMPORT',
            artifactKey: `source-package:${childProductId}`,
          },
        },
      });
      const childPromptDependencies = currentPrompt.dependencies.map((dependency) => ({
        ...dependencyInput(dependency),
        sourceNodeId: dependency.sourceNodeId?.replaceAll(oldProductId, childProductId) ?? null,
        sourceArtifactId: dependency.sourceType === 'WORKING_ARTIFACT' ? childInsight.id : null,
        sourceKey: dependency.sourceKey.replaceAll(oldProductId, childProductId),
        sourceHash:
          dependency.sourceType === 'WORKING_ARTIFACT'
            ? childInsight.contentHash
            : dependency.sourceHash,
      }));
      const childPromptInput = {
        ...artifactInput(currentPrompt, childPromptDependencies, []),
        metadata: replaceId(currentPrompt.metadata, oldProductId, childProductId),
      };
      const childPromptHash = workingArtifactContentHash(childPromptInput);
      const childPrompt = await tx.workingArtifact.create({
        data: {
          projectId,
          workflowRunId: childId,
          nodeId: 'PROMPT_GENERATION',
          artifactKey: `prompt-batch:${childProductId}`,
          kind: currentPrompt.kind,
          name: currentPrompt.name,
          directory: currentPrompt.directory,
          type: currentPrompt.type,
          tags: currentPrompt.tags,
          payload: json(currentPrompt.payload),
          metadata: json(childPromptInput.metadata),
          sourceRunId: currentPrompt.sourceRunId,
          sourceArtifactId: currentPrompt.sourceArtifactId,
          revision: currentPrompt.revision,
          contentHash: childPromptHash,
          freshness: 'CURRENT',
          availability: 'AVAILABLE',
          createdAt: currentPrompt.createdAt,
        },
      });
      await tx.workingArtifactDependency.createMany({
        data: childPromptDependencies.map((dependency) => ({
          projectId,
          workflowRunId: childId,
          dependentArtifactId: childPrompt.id,
          ...dependency,
        })),
      });
      await tx.workingArtifact.update({
        where: { id: currentPrompt.id },
        data: {
          revision: 3,
          contentHash: oldPromptHash,
          payload: json(oldPromptInput.payload),
          metadata: json(oldPromptInput.metadata),
          sourceRunId: oldResult.runId,
          sourceArtifactId: oldResult.id,
        },
      });
      await tx.workingArtifactDependency.deleteMany({
        where: { projectId, dependentArtifactId: currentPrompt.id },
      });
      await tx.workingArtifactDependency.createMany({
        data: oldPromptInput.dependencies.map((dependency) => ({
          projectId,
          workflowRunId: parentId,
          dependentArtifactId: currentPrompt.id,
          ...dependency,
        })),
      });
      const parentSettings = await tx.workflowNodeState.findUniqueOrThrow({
        where: {
          projectId_workflowRunId_nodeId: {
            projectId,
            workflowRunId: parentId,
            nodeId: `PROMPT_GENERATION:${oldProductId}`,
          },
        },
      });
      await tx.workflowNodeState.update({
        where: { id: parentSettings.id },
        data: {
          state: json(oldSnapshot.settings),
          contentHash: oldResult.settingsHash,
          executionInputHash: oldResult.settingsHash,
          revision: { increment: 1 },
        },
      });
      const childRunSnapshot = fork.remap(newResult.run.inputSnapshot);
      childRunSnapshot.workflowRunId = childId;
      childRunSnapshot.productId = childProductId;
      childRunSnapshot.insightArtifact = {
        ...childRunSnapshot.insightArtifact,
        id: childInsight.id,
        revision: childInsight.revision,
        contentHash: childInsight.contentHash,
      };
      await tx.effectPromptRun.update({
        where: { id: newResult.runId },
        data: {
          workflowRunId: childId,
          productId: childProductId,
          inputSnapshot: json(childRunSnapshot),
        },
      });
      await tx.effectPromptResult.update({
        where: { id: newResult.id },
        data: {
          workflowRunId: childId,
          productId: childProductId,
        },
      });

      const newTaskSnapshot = (value) => {
        const next = replaceId(value, oldProductId, childProductId);
        if (next.sourcePrompt)
          next.sourcePrompt = {
            ...next.sourcePrompt,
            artifactId: childPrompt.id,
            contentHash: childPromptHash,
          };
        if (next.sourcePackage)
          next.sourcePackage = {
            ...next.sourcePackage,
            artifactId: childSource.id,
            contentHash: childSource.contentHash,
          };
        next.workflowRunId = childId;
        return next;
      };
      await tx.effectSegmentRenderBatch.update({
        where: { id: newBatchId },
        data: {
          workflowRunId: childId,
          productId: childProductId,
          sourcePromptArtifactId: childPrompt.id,
          sourcePromptHash: childPromptHash,
        },
      });
      for (const task of newBatch.tasks) {
        const requestSnapshot = newTaskSnapshot(task.requestSnapshot);
        await tx.effectSegmentRenderTask.update({
          where: { id: task.id },
          data: {
            workflowRunId: childId,
            productId: childProductId,
            requestSnapshot: json(requestSnapshot),
            generationRequestSnapshot: json(newTaskSnapshot(task.generationRequestSnapshot)),
            sourceFingerprint: workflowStateHash(requestSnapshot),
          },
        });
      }
      const newFileIds = [
        ...new Set(
          newBatch.tasks
            .flatMap((task) => [task.outputFileObjectId, task.outputPoster?.fileObjectId])
            .filter(Boolean),
        ),
      ];
      assert(newFileIds.length === 100, 'Expected 50 videos and 50 posters');
      const movedFiles = await tx.fileObject.updateMany({
        where: { projectId, workflowRunId: parentId, id: { in: newFileIds }, status: 'AVAILABLE' },
        data: { workflowRunId: childId },
      });
      assert(movedFiles.count === 100, 'New render file ownership changed');

      const moveRenderArtifact = async (artifact) => {
        const dependencies = artifact.dependencies.map((dependency) => ({
          ...dependencyInput(dependency),
          sourceArtifactId:
            dependency.sourceNodeId === 'PROMPT_GENERATION'
              ? childPrompt.id
              : dependency.sourceNodeId === 'SOURCE_IMPORT'
                ? childSource.id
                : dependency.sourceArtifactId,
          sourceKey: dependency.sourceKey.replaceAll(oldProductId, childProductId),
          sourceHash:
            dependency.sourceNodeId === 'PROMPT_GENERATION'
              ? childPromptHash
              : dependency.sourceNodeId === 'SOURCE_IMPORT'
                ? childSource.contentHash
                : dependency.sourceHash,
        }));
        const files = artifact.files.map(fileInput);
        const payload = replaceId(artifact.payload, oldProductId, childProductId);
        if (payload?.sourcePrompt)
          payload.sourcePrompt = {
            ...payload.sourcePrompt,
            artifactId: childPrompt.id,
            contentHash: childPromptHash,
          };
        const metadata = replaceId(artifact.metadata, oldProductId, childProductId);
        const input = { ...artifactInput(artifact, dependencies, files), payload, metadata };
        const contentHash = workingArtifactContentHash(input);
        await tx.workingArtifactDependency.deleteMany({
          where: { projectId, dependentArtifactId: artifact.id },
        });
        await tx.workingArtifactFile.deleteMany({
          where: { projectId, workingArtifactId: artifact.id },
        });
        await tx.workingArtifact.update({
          where: { id: artifact.id },
          data: {
            workflowRunId: childId,
            artifactKey: artifact.artifactKey.replaceAll(oldProductId, childProductId),
            payload: json(payload),
            metadata: json(metadata),
            contentHash,
          },
        });
        if (dependencies.length)
          await tx.workingArtifactDependency.createMany({
            data: dependencies.map((dependency) => ({
              projectId,
              workflowRunId: childId,
              dependentArtifactId: artifact.id,
              ...dependency,
            })),
          });
        if (files.length)
          await tx.workingArtifactFile.createMany({
            data: files.map((file) => ({
              projectId,
              workflowRunId: childId,
              workingArtifactId: artifact.id,
              fileObjectId: file.fileObjectId,
              role: file.role,
              sortOrder: file.sortOrder,
            })),
          });
        return contentHash;
      };
      for (const clip of newClips) await moveRenderArtifact(clip);
      await moveRenderArtifact(currentBatchArtifact);
      // Six unconfirmed draft slots point at v4 clips. Keep their original artifact
      // IDs in the v3 branch as STALE so the editor can show what was chosen, while
      // preserving an independent CURRENT copy for the v4 render branch.
      for (const original of boundNewClips) {
        const childClip = await tx.workingArtifact.findUniqueOrThrow({
          where: { id: original.id },
          include: { dependencies: true },
        });
        const childDependencies = childClip.dependencies.map(dependencyInput);
        await tx.workingArtifactDependency.deleteMany({
          where: { projectId, dependentArtifactId: original.id },
        });
        await tx.workingArtifact.update({
          where: { id: original.id },
          data: {
            workflowRunId: parentId,
            payload: json(original.payload),
            metadata: json(original.metadata),
            contentHash: original.contentHash,
            freshness: 'STALE',
          },
        });
        await tx.workingArtifactDependency.createMany({
          data: original.dependencies.map((dependency) => ({
            projectId,
            workflowRunId: parentId,
            dependentArtifactId: original.id,
            ...dependencyInput(dependency),
          })),
        });
        const copy = await tx.workingArtifact.create({
          data: {
            projectId,
            workflowRunId: childId,
            nodeId: childClip.nodeId,
            artifactKey: childClip.artifactKey,
            kind: childClip.kind,
            name: childClip.name,
            directory: childClip.directory,
            type: childClip.type,
            tags: childClip.tags,
            payload: json(childClip.payload),
            metadata: json(childClip.metadata),
            originalFileName: childClip.originalFileName,
            mimeType: childClip.mimeType,
            sizeBytes: childClip.sizeBytes,
            storageKey: childClip.storageKey,
            sourceRunId: childClip.sourceRunId,
            sourceArtifactId: childClip.sourceArtifactId,
            revision: childClip.revision,
            contentHash: childClip.contentHash,
            freshness: 'CURRENT',
            availability: 'AVAILABLE',
            createdAt: childClip.createdAt,
          },
        });
        await tx.workingArtifactDependency.createMany({
          data: childDependencies.map((dependency) => ({
            projectId,
            workflowRunId: childId,
            dependentArtifactId: copy.id,
            ...dependency,
          })),
        });
      }

      const oldBatchInput = EffectSegmentRenderService.prototype.artifactInputs
        .call({}, oldBatch, [])
        .find(({ artifactKey }) => artifactKey === `render-batch:${oldProductId}`)?.input;
      assert(
        oldBatchInput?.files?.length === 100 &&
          oldBatchInput.dependencies[0].sourceHash === oldPromptHash,
        'Cannot reconstruct the old render-batch artifact',
      );
      const restoredBatch = await tx.workingArtifact.create({
        data: {
          projectId,
          workflowRunId: parentId,
          nodeId: 'SEGMENT_RENDER',
          artifactKey: `render-batch:${oldProductId}`,
          kind: oldBatchInput.kind,
          name: oldBatchInput.name,
          directory: oldBatchInput.directory,
          type: oldBatchInput.type,
          tags: oldBatchInput.tags,
          payload: json(oldBatchInput.payload),
          metadata: json(oldBatchInput.metadata),
          sourceRunId: oldBatchInput.sourceRunId,
          sourceArtifactId: oldBatchInput.sourceArtifactId,
          revision: 2,
          contentHash: workingArtifactContentHash(oldBatchInput),
          freshness: 'CURRENT',
          availability: 'AVAILABLE',
        },
      });
      await tx.workingArtifactDependency.createMany({
        data: oldBatchInput.dependencies.map((dependency) => ({
          projectId,
          workflowRunId: parentId,
          dependentArtifactId: restoredBatch.id,
          ...dependency,
        })),
      });
      await tx.workingArtifactFile.createMany({
        data: oldBatchInput.files.map((file) => ({
          projectId,
          workflowRunId: parentId,
          workingArtifactId: restoredBatch.id,
          fileObjectId: file.fileObjectId,
          role: file.role,
          sortOrder: file.sortOrder,
        })),
      });

      const oldClipRestored = await tx.workingArtifact.updateMany({
        where: {
          projectId,
          workflowRunId: parentId,
          freshness: 'STALE',
          id: { in: oldClips.map((clip) => clip.id) },
        },
        data: { freshness: 'CURRENT' },
      });
      assert(oldClipRestored.count === 100, 'Old clip restore count changed');
      const descendantsRestored = await tx.workingArtifact.updateMany({
        where: {
          projectId,
          workflowRunId: parentId,
          freshness: 'STALE',
          id: { in: targetArtifacts.map((artifact) => artifact.id) },
        },
        data: { freshness: 'CURRENT' },
      });
      assert(descendantsRestored.count === 302, 'Mix/output restore count changed');
      const restored = await tx.workingArtifact.findMany({
        where: {
          projectId,
          workflowRunId: parentId,
          id: {
            in: [
              ...oldClips.map((clip) => clip.id),
              ...targetArtifacts.map((artifact) => artifact.id),
            ],
          },
        },
        include: { dependencies: true },
      });
      const sourceIds = [
        ...new Set(
          restored.flatMap((artifact) =>
            artifact.dependencies
              .filter((dependency) => dependency.sourceType === 'WORKING_ARTIFACT')
              .map((dependency) => dependency.sourceArtifactId)
              .filter(Boolean),
          ),
        ),
      ];
      const sources = await tx.workingArtifact.findMany({
        where: { projectId, id: { in: sourceIds } },
        select: {
          id: true,
          workflowRunId: true,
          revision: true,
          contentHash: true,
          freshness: true,
          availability: true,
        },
      });
      const sourceById = new Map(sources.map((source) => [source.id, source]));
      const invalidSources = restored.flatMap((artifact) =>
        artifact.dependencies
          .filter((dependency) => dependency.sourceType === 'WORKING_ARTIFACT')
          .filter((dependency) => {
            const source = sourceById.get(dependency.sourceArtifactId);
            return (
              !source ||
              source.workflowRunId !== parentId ||
              source.revision !== dependency.sourceRevision ||
              source.contentHash !== dependency.sourceHash ||
              source.freshness !== 'CURRENT' ||
              source.availability !== 'AVAILABLE'
            );
          })
          .map((dependency) => `${artifact.artifactKey} -> ${dependency.sourceKey}`),
      );
      assert(
        invalidSources.length === 0,
        `Restored descendants still have invalid sources: ${invalidSources.slice(0, 5).join(', ')}`,
      );
      await tx.workflowRun.update({
        where: { id: childId },
        data: {
          branchPublishedAt: new Date(),
          currentNodeId: 'SEGMENT_RENDER',
          branchLabel: 'Prompt 第 4 版 · 50 条新素材',
        },
      });
      const summary = {
        mode: apply ? 'apply' : 'dry-run',
        parentRunId: parentId,
        childRunId: childId,
        parentPromptRevision: 3,
        childPromptRevision: 4,
        oldPromptHash,
        childPromptHash,
        restoredOldClips: oldClipRestored.count,
        restoredMixAndOutputArtifacts: descendantsRestored.count,
        movedNewClips: newClips.length,
        movedNewFiles: movedFiles.count,
        preservedFilms: targetTemplate.workspace.variants.length,
        preservedUnconfirmedBindings: boundNewClips.length,
        validatedRestoredDependencies: sourceIds.length,
      };
      console.log(JSON.stringify(summary, null, 2));
      if (!apply) throw rollback;
    },
    { timeout: 180_000, maxWait: 10_000 },
  );
} catch (error) {
  if (error !== rollback) {
    console.error(error);
    process.exitCode = 1;
  }
} finally {
  await db.$disconnect();
}
