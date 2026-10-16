// Follow-up for the six unconfirmed v4 clip bindings left in the historical
// v3 mix draft. Dry-run by default; --apply commits in one transaction.
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
  workingArtifactContentHash,
} = require('../dist/platform/workflow/workflow-working.repository.js');

const projectId = '40d1273a-e1cd-4cae-8f83-02fdaf324dc1';
const parentId = '65f5b90c-046c-4f28-92e1-0e867e9f4e5f';
const childId = '954d854e-b535-42ca-bcec-b677135293ed';
const productId = '2e31a4b1-0494-4a25-ab40-93846c9c98be';
const templateId = '0254fafe-4c3f-49a4-ad98-592289d9418e';
const v4Hash = '17154d5fd3ec8242359b4d8dd97dbea397a8b78f74094b0d38fd7487a2ae23e9';
const apply = process.argv.includes('--apply');
const rollback = new Error('DRY_RUN_ROLLBACK');
const assert = (value, message) => {
  if (!value) throw new Error(message);
};
const db = new PrismaService(new ConfigService({ DATABASE_URL: process.env.DATABASE_URL }));

try {
  await db.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "projects" WHERE "id"=${projectId}::uuid FOR UPDATE`;
      const [root, child, node, parentPrompt, parentSource] = await Promise.all([
        tx.workflowRun.findUniqueOrThrow({ where: { id: parentId } }),
        tx.workflowRun.findUniqueOrThrow({ where: { id: childId } }),
        tx.workflowNodeState.findUniqueOrThrow({
          where: {
            projectId_workflowRunId_nodeId: {
              projectId,
              workflowRunId: parentId,
              nodeId: 'TEMPLATE_MIX',
            },
          },
        }),
        tx.workingArtifact.findUniqueOrThrow({
          where: {
            projectId_workflowRunId_nodeId_artifactKey: {
              projectId,
              workflowRunId: parentId,
              nodeId: 'PROMPT_GENERATION',
              artifactKey: `prompt-batch:${productId}`,
            },
          },
        }),
        tx.workingArtifact.findUniqueOrThrow({
          where: {
            projectId_workflowRunId_nodeId_artifactKey: {
              projectId,
              workflowRunId: parentId,
              nodeId: 'SOURCE_IMPORT',
              artifactKey: `source-package:${productId}`,
            },
          },
        }),
      ]);
      assert(
        root.projectId === projectId &&
          child.parentWorkflowRunId === parentId &&
          child.forkNodeId === 'PROMPT_GENERATION' &&
          child.branchPublishedAt &&
          parentPrompt.revision === 3,
        'Expected migrated branch is missing',
      );
      const template = node.state.templates.find((item) => item.id === templateId);
      assert(template?.workspace?.variants?.length === 100, 'Target draft changed');
      const bindingIds = [
        ...new Set(
          template.workspace.variants.flatMap((variant) =>
            Object.values(variant.bindings).filter(Boolean),
          ),
        ),
      ];
      const foreignClips = await tx.workingArtifact.findMany({
        where: {
          projectId,
          workflowRunId: childId,
          id: { in: bindingIds },
          nodeId: 'SEGMENT_RENDER',
          artifactKey: { startsWith: 'render-clip:' },
        },
        include: { dependencies: true, files: true },
      });
      assert(
        foreignClips.length === 6 &&
          foreignClips.every(
            (clip) =>
              clip.freshness === 'CURRENT' &&
              clip.files.length === 0 &&
              clip.dependencies.some(
                (dependency) => dependency.sourceNodeId === 'PROMPT_GENERATION',
              ),
          ),
        'Expected six unconfirmed foreign clip bindings',
      );

      for (const clip of foreignClips) {
        const childDependencies = clip.dependencies.map((dependency) => ({
          sourceType: dependency.sourceType,
          sourceNodeId: dependency.sourceNodeId,
          sourceArtifactId: dependency.sourceArtifactId,
          sourceKey: dependency.sourceKey,
          sourceRevision: dependency.sourceRevision,
          sourceHash: dependency.sourceHash,
        }));
        const parentDependencies = childDependencies.map((dependency) => ({
          ...dependency,
          sourceArtifactId:
            dependency.sourceNodeId === 'PROMPT_GENERATION'
              ? parentPrompt.id
              : dependency.sourceNodeId === 'SOURCE_IMPORT'
                ? parentSource.id
                : dependency.sourceArtifactId,
          sourceKey: dependency.sourceKey.replaceAll(
            childDependencies
              .find((item) => item.sourceNodeId === 'PROMPT_GENERATION')
              .sourceKey.split(':')[1],
            productId,
          ),
          sourceHash:
            dependency.sourceNodeId === 'PROMPT_GENERATION'
              ? v4Hash
              : dependency.sourceNodeId === 'SOURCE_IMPORT'
                ? parentSource.contentHash
                : dependency.sourceHash,
        }));
        const parentMetadata = { ...clip.metadata, productId };
        const staleHash = workingArtifactContentHash({
          kind: clip.kind,
          name: clip.name,
          directory: clip.directory,
          type: clip.type,
          tags: clip.tags,
          payload: clip.payload,
          metadata: parentMetadata,
          originalFileName: clip.originalFileName,
          mimeType: clip.mimeType,
          sizeBytes: clip.sizeBytes,
          storageKey: clip.storageKey,
          fileChecksum: clip.payload.contentHash,
          dependencies: parentDependencies,
        });
        await tx.workingArtifactDependency.deleteMany({
          where: { projectId, dependentArtifactId: clip.id },
        });
        await tx.workingArtifact.update({
          where: { id: clip.id },
          data: {
            workflowRunId: parentId,
            metadata: parentMetadata,
            contentHash: staleHash,
            freshness: 'STALE',
          },
        });
        await tx.workingArtifactDependency.createMany({
          data: parentDependencies.map((dependency) => ({
            projectId,
            workflowRunId: parentId,
            dependentArtifactId: clip.id,
            ...dependency,
          })),
        });
        const copy = await tx.workingArtifact.create({
          data: {
            projectId,
            workflowRunId: childId,
            nodeId: clip.nodeId,
            artifactKey: clip.artifactKey,
            kind: clip.kind,
            name: clip.name,
            directory: clip.directory,
            type: clip.type,
            tags: clip.tags,
            payload: clip.payload,
            metadata: clip.metadata,
            originalFileName: clip.originalFileName,
            mimeType: clip.mimeType,
            sizeBytes: clip.sizeBytes,
            storageKey: clip.storageKey,
            sourceRunId: clip.sourceRunId,
            sourceArtifactId: clip.sourceArtifactId,
            revision: clip.revision,
            contentHash: clip.contentHash,
            freshness: 'CURRENT',
            availability: 'AVAILABLE',
            createdAt: clip.createdAt,
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
      const result = {
        mode: apply ? 'apply' : 'dry-run',
        historicalDraftClipsPreservedAsStale: foreignClips.length,
        currentClipsPreservedInNewBranch: foreignClips.length,
        draftRevisionUnchanged: node.revision,
      };
      console.log(JSON.stringify(result, null, 2));
      if (!apply) throw rollback;
    },
    { timeout: 60_000 },
  );
} catch (error) {
  if (error !== rollback) {
    console.error(error);
    process.exitCode = 1;
  }
} finally {
  await db.$disconnect();
}
