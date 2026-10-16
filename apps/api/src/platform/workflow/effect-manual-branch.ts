import { Prisma } from '../../generated/prisma/client';
import { workflowStateHash } from './workflow-state-hash';
import {
  workingArtifactContentHash,
  workingArtifactInclude,
  type WorkingArtifactUpsertInput,
} from './workflow-working.repository';
import { beginEffectEditInTransaction } from './effect-edit-session';
import {
  clonePackagingRunsInTransaction,
  remapClonedPackagingRunsInTransaction,
  remapIds,
} from './effect-branch-clone';

type Tx = Prisma.TransactionClient;
const json = (value: unknown): Prisma.InputJsonValue =>
  (value === undefined || value === null ? {} : value) as Prisma.InputJsonValue;

/** A manual fork is a complete confirmed workspace, unlike a node-change fork. */
export async function createEffectManualBranchInTransaction(
  tx: Tx,
  projectId: string,
  parentRunId: string,
  idempotencyKey: string,
): Promise<string | null> {
  await tx.$queryRaw(
    Prisma.sql`SELECT "id" FROM "projects" WHERE "id" = ${projectId}::uuid FOR UPDATE`,
  );
  const existing = await tx.workflowRun.findFirst({
    where: {
      projectId,
      workflow: 'EFFECT',
      workflowSpace: 'EFFECT',
      branchCreationKey: idempotencyKey,
    },
  });
  if (existing) return existing.parentWorkflowRunId === parentRunId ? existing.id : null;
  const parent = await tx.workflowRun.findFirst({
    where: {
      projectId,
      id: parentRunId,
      workflow: 'EFFECT',
      workflowSpace: 'EFFECT',
      activeKey: 'ACTIVE',
      status: { in: ['ACTIVE', 'PAUSED'] },
    },
  });
  if (!parent || (parent.parentWorkflowRunId && !parent.branchPublishedAt)) return null;
  const stageOrder = [
    'SOURCE_IMPORT',
    'INFORMATION_EXTRACTION',
    'PROMPT_GENERATION',
    'SEGMENT_RENDER',
  ] as const;
  const confirmed = await tx.workingArtifact.findMany({
    where: {
      projectId,
      workflowRunId: parentRunId,
      availability: 'AVAILABLE',
      nodeId: { in: [...stageOrder] },
    },
    select: { nodeId: true },
  });
  const highest = [...stageOrder]
    .reverse()
    .find((stage) => confirmed.some((artifact) => artifact.nodeId === stage));
  if (!highest) return null;
  const begun = await beginEffectEditInTransaction(tx, projectId, parentRunId, highest, 'MANUAL');
  if (!begun || begun.runId === parentRunId || !begun.created) return null;
  const childRunId = begun.runId;
  const ids: Record<string, string> = {
    [parentRunId]: childRunId,
    ...begun.productIdMap,
    ...begun.taskIdMap,
  };
  const parentArtifacts = await tx.workingArtifact.findMany({
    where: {
      projectId,
      workflowRunId: parentRunId,
      availability: 'AVAILABLE',
    },
    include: workingArtifactInclude,
    orderBy: [{ nodeId: 'asc' }, { artifactKey: 'asc' }],
  });
  const childArtifacts = await tx.workingArtifact.findMany({
    where: {
      projectId,
      workflowRunId: childRunId,
    },
  });
  const remapKey = (key: string) => remapIds(key, ids);
  const copiedByKey = new Map(
    childArtifacts.map((item) => [`${item.nodeId}:${item.artifactKey}`, item]),
  );
  const hashes: Record<string, string> = {};
  for (const source of parentArtifacts) {
    const copied = copiedByKey.get(`${source.nodeId}:${remapKey(source.artifactKey)}`);
    if (copied) {
      ids[source.id] = copied.id;
      hashes[source.contentHash] = copied.contentHash;
    }
  }
  const confirmedTemplateIds = new Set(
    parentArtifacts
      .filter((item) => item.artifactKey.startsWith('mix-template:'))
      .map((item) => item.artifactKey.split(':')[1]!),
  );
  const confirmedVariantIds = new Set(
    parentArtifacts
      .filter((item) => item.artifactKey.startsWith('timeline-project:'))
      .map((item) => item.artifactKey.split(':')[2]!),
  );
  const packagedVariantIds = new Set(
    parentArtifacts
      .filter((item) => item.artifactKey.startsWith('timeline-package:'))
      .map((item) => item.artifactKey.split(':')[2]!),
  );
  const finalVideoVariantIds = new Set(
    parentArtifacts
      .filter((item) => item.artifactKey.startsWith('final-video:'))
      .map((item) => item.artifactKey.split(':')[2]!),
  );
  const mixRuns = await tx.effectTemplateMixAiRun.findMany({
    where: {
      projectId,
      workflowRunId: parentRunId,
      status: 'COMPLETED',
      templateId: { in: [...confirmedTemplateIds] },
    },
  });
  for (const source of mixRuns.filter(
    (item) => item.outputVariantId && confirmedVariantIds.has(item.outputVariantId),
  )) {
    const copy = await tx.effectTemplateMixAiRun.create({
      data: {
        projectId,
        workflowRunId: childRunId,
        templateId: source.templateId,
        targetVariantId: source.targetVariantId,
        outputVariantId: source.outputVariantId,
        idempotencyKey: `manual:${childRunId}:mix:${source.id}`,
        requestHash: source.requestHash,
        inputHash: source.inputHash,
        inputSnapshot: json(remapIds(source.inputSnapshot, ids)),
        classificationResult:
          source.classificationResult === null
            ? Prisma.DbNull
            : json(remapIds(source.classificationResult, ids)),
        selectionResult:
          source.selectionResult === null
            ? Prisma.DbNull
            : json(remapIds(source.selectionResult, ids)),
        samplingResult:
          source.samplingResult === null
            ? Prisma.DbNull
            : json(remapIds(source.samplingResult, ids)),
        trimResult:
          source.trimResult === null ? Prisma.DbNull : json(remapIds(source.trimResult, ids)),
        expectedDraftRevision: source.expectedDraftRevision,
        templateEditVersion: source.templateEditVersion,
        status: 'COMPLETED',
        stage: source.stage,
        progress: 100,
        completedAt: source.completedAt,
      },
    });
    ids[source.id] = copy.id;
  }
  const packagingRuns = await clonePackagingRunsInTransaction(
    tx,
    projectId,
    parentRunId,
    childRunId,
    ids,
    { templateIds: confirmedTemplateIds, variantIds: packagedVariantIds },
  );
  const outputRuns = await tx.effectFinalOutputRun.findMany({
    where: {
      projectId,
      workflowRunId: parentRunId,
      status: 'COMPLETED',
      templateId: { in: [...confirmedTemplateIds] },
    },
    include: { items: true },
  });
  const assetIds = [
    ...new Set(
      outputRuns.flatMap((run) =>
        run.items
          .filter((item) => item.status === 'COMPLETED' && finalVideoVariantIds.has(item.variantId))
          .map((item) => item.assetId)
          .filter((id): id is string => Boolean(id)),
      ),
    ),
  ];
  const assets = await tx.asset.findMany({
    where: { projectId, id: { in: assetIds } },
    include: { versions: true },
  });
  if (assets.length !== assetIds.length) throw new Error('EFFECT_MANUAL_BRANCH_ASSET_MISSING');
  for (const source of assets) {
    const copy = await tx.asset.create({
      data: {
        projectId,
        name: source.name,
        directory: source.directory,
        type: source.type,
        storageWorkflow: source.storageWorkflow,
        workflowSpace: source.workflowSpace,
        status: source.status,
        qualityStatus: source.qualityStatus,
        currentVersion: source.currentVersion,
        tags: source.tags,
        notes: source.notes,
        originalFileName: source.originalFileName,
        mimeType: source.mimeType,
        sizeBytes: source.sizeBytes,
        storageKey: source.storageKey,
        hasFile: source.hasFile,
        assetClass: source.assetClass,
        businessType: source.businessType,
        contentKind: source.contentKind,
        content: source.content === null ? Prisma.DbNull : json(remapIds(source.content, ids)),
        businessData:
          source.businessData === null ? Prisma.DbNull : json(remapIds(source.businessData, ids)),
        views: source.views,
        sourceArtifactId: null,
        sourceRunId: null,
        sourceNode: source.sourceNode,
        sourceShot: source.sourceShot,
        idempotencyKey: `manual:${childRunId}:asset:${source.id}`,
        sourceProjectId: source.sourceProjectId,
        sourceAssetId: source.sourceAssetId,
        sourceVersion: source.sourceVersion,
        importedAt: source.importedAt,
        dependencies:
          source.dependencies === null ? Prisma.DbNull : json(remapIds(source.dependencies, ids)),
        archivedAt: source.archivedAt,
      },
    });
    ids[source.id] = copy.id;
    if (source.versions.length)
      await tx.assetVersion.createMany({
        data: source.versions.map((version) => ({
          projectId,
          assetId: copy.id,
          version: version.version,
          changeNote: version.changeNote,
          status: version.status,
          qualityStatus: version.qualityStatus,
          content: version.content === null ? Prisma.DbNull : json(remapIds(version.content, ids)),
          businessData:
            version.businessData === null
              ? Prisma.DbNull
              : json(remapIds(version.businessData, ids)),
          originalFileName: version.originalFileName,
          mimeType: version.mimeType,
          sizeBytes: version.sizeBytes,
          storageKey: version.storageKey,
          createdAt: version.createdAt,
        })),
      });
  }
  for (const source of outputRuns.filter((run) =>
    run.items.some((item) => finalVideoVariantIds.has(item.variantId)),
  )) {
    const copy = await tx.effectFinalOutputRun.create({
      data: {
        projectId,
        workflowRunId: childRunId,
        templateId: source.templateId,
        idempotencyKey: `manual:${childRunId}:output:${source.id}`,
        requestHash: source.requestHash,
        inputHash: source.inputHash,
        status: 'COMPLETED',
        completedAt: source.completedAt,
      },
    });
    ids[source.id] = copy.id;
    for (const item of source.items.filter(
      (entry) => entry.status === 'COMPLETED' && finalVideoVariantIds.has(entry.variantId),
    )) {
      const copiedItem = await tx.effectFinalOutputItem.create({
        data: {
          projectId,
          runId: copy.id,
          variantId: item.variantId,
          name: item.name,
          snapshot: json(remapIds(item.snapshot, ids)),
          status: 'COMPLETED',
          progress: 100,
          fileObjectId: item.fileObjectId,
          assetId: item.assetId ? (ids[item.assetId] ?? null) : null,
        },
      });
      ids[item.id] = copiedItem.id;
    }
  }
  const sourceStates = await tx.workflowNodeState.findMany({
    where: {
      projectId,
      workflowRunId: parentRunId,
      nodeId: { in: ['TEMPLATE_MIX', 'FINAL_OUTPUT'] },
    },
  });
  for (const source of sourceStates) {
    if (source.nodeId === 'TEMPLATE_MIX') {
      const original = source.state as {
        schemaVersion?: number;
        activeTemplateId?: string;
        templates?: Array<{
          id: string;
          workspace?: {
            editVersion?: number;
            template?: unknown;
            variants?: Array<{ id: string }>;
          };
        }>;
      };
      const templates = (original.templates ?? [])
        .filter((item) => confirmedTemplateIds.has(item.id))
        .map((item) => {
          const templateArtifact = parentArtifacts.find(
            (artifact) => artifact.artifactKey === `mix-template:${item.id}`,
          );
          const templatePayload = (templateArtifact?.payload ?? {}) as {
            workspaceVersion?: number;
            template?: unknown;
          };
          const variants = (item.workspace?.variants ?? [])
            .filter((variant) => confirmedVariantIds.has(variant.id))
            .map((variant) => {
              const visualArtifact = parentArtifacts.find(
                (artifact) => artifact.artifactKey === `timeline-project:${item.id}:${variant.id}`,
              );
              const visual = (
                (visualArtifact?.payload ?? {}) as { variant?: Record<string, unknown> }
              ).variant;
              const packageItem = packagingRuns
                .flatMap((run) => run.items)
                .find(
                  (entry) =>
                    entry.variantId === variant.id &&
                    packagedVariantIds.has(entry.variantId) &&
                    entry.status === 'COMPLETED',
                );
              const packagedVariant = (
                (packageItem?.snapshot ?? {}) as {
                  variant?: Record<string, unknown>;
                }
              ).variant;
              // Node state is a draft. Rebuild it from confirmed visual/package snapshots
              // so an unconfirmed timeline edit cannot leak into the new branch.
              const base = packagedVariant ?? {
                ...variant,
                captions: [],
                subtitleStyle: 'standard',
                bgm: null,
                voice: null,
                detachedAudios: [],
                originalVolume: 1,
              };
              return { ...base, ...visual };
            });
          return {
            ...item,
            aiFillLocked: false,
            workspace: {
              ...item.workspace,
              editVersion: templatePayload.workspaceVersion ?? item.workspace?.editVersion,
              template: templatePayload.template ?? item.workspace?.template,
              variants,
            },
          };
        });
      const state = remapIds(
        {
          ...original,
          templates,
          activeTemplateId: templates.some((item) => item.id === original.activeTemplateId)
            ? original.activeTemplateId
            : (templates[0]?.id ?? ''),
        },
        ids,
      );
      await tx.workflowNodeState.create({
        data: {
          projectId,
          workflowRunId: childRunId,
          nodeId: source.nodeId,
          schemaVersion: source.schemaVersion,
          revision: source.revision,
          contentHash: workflowStateHash(state),
          executionInputHash: source.executionInputHash,
          executionInputSchemaVersion: source.executionInputSchemaVersion,
          state: json(state),
          savedAt: source.savedAt,
        },
      });
    } else {
      const state = remapIds(source.state, ids);
      await tx.workflowNodeState.create({
        data: {
          projectId,
          workflowRunId: childRunId,
          nodeId: source.nodeId,
          schemaVersion: source.schemaVersion,
          revision: source.revision,
          contentHash: workflowStateHash(state),
          executionInputHash: source.executionInputHash,
          executionInputSchemaVersion: source.executionInputSchemaVersion,
          state: json(state),
          savedAt: source.savedAt,
        },
      });
    }
  }
  const copyOrder = (key: string): number =>
    key.startsWith('mix-template:')
      ? 0
      : key.startsWith('timeline-project:')
        ? 1
        : key.startsWith('timeline-package:')
          ? 2
          : key.startsWith('final-video:')
            ? 3
            : 4;
  for (const source of parentArtifacts
    .filter((item) => item.nodeId === 'TEMPLATE_MIX' || item.nodeId === 'FINAL_OUTPUT')
    .sort((left, right) => copyOrder(left.artifactKey) - copyOrder(right.artifactKey))) {
    const dependencies = source.dependencies.map((dependency) => ({
      sourceType: dependency.sourceType,
      sourceNodeId: remapIds(dependency.sourceNodeId, ids),
      sourceArtifactId: dependency.sourceArtifactId
        ? (ids[dependency.sourceArtifactId] ?? dependency.sourceArtifactId)
        : null,
      sourceKey: remapIds(dependency.sourceKey, ids),
      sourceRevision: dependency.sourceRevision,
      sourceHash: dependency.sourceHash
        ? (hashes[dependency.sourceHash] ?? dependency.sourceHash)
        : null,
    }));
    const files = source.files.map((file) => ({
      fileObjectId: file.fileObjectId,
      role: file.role,
      sortOrder: file.sortOrder,
      originalFileName: file.fileObject.originalFileName,
      mimeType: file.fileObject.mimeType,
      sha256: file.fileObject.sha256,
    }));
    const input: WorkingArtifactUpsertInput = {
      kind: source.kind,
      name: source.name,
      directory: source.directory,
      type: source.type,
      tags: source.tags,
      payload: remapIds(source.payload, ids),
      metadata: remapIds(source.metadata, ids),
      originalFileName: source.originalFileName,
      mimeType: source.mimeType,
      sizeBytes: source.sizeBytes,
      storageKey: source.storageKey,
      sourceRunId: source.sourceRunId ? (ids[source.sourceRunId] ?? source.sourceRunId) : null,
      sourceArtifactId: source.sourceArtifactId
        ? (ids[source.sourceArtifactId] ?? source.sourceArtifactId)
        : null,
      files,
      dependencies,
    };
    const copy = await tx.workingArtifact.create({
      data: {
        projectId,
        workflowRunId: childRunId,
        nodeId: source.nodeId,
        artifactKey: remapKey(source.artifactKey),
        kind: source.kind,
        name: source.name,
        directory: source.directory,
        type: source.type,
        tags: source.tags,
        payload: json(input.payload),
        metadata: json(input.metadata),
        originalFileName: source.originalFileName,
        mimeType: source.mimeType,
        sizeBytes: source.sizeBytes,
        storageKey: source.storageKey,
        sourceRunId: input.sourceRunId ?? null,
        sourceArtifactId: input.sourceArtifactId ?? null,
        revision: source.revision,
        contentHash: workingArtifactContentHash(input),
        freshness: source.freshness,
        availability: source.availability,
        createdAt: source.createdAt,
      },
    });
    ids[source.id] = copy.id;
    hashes[source.contentHash] = copy.contentHash;
    if (files.length)
      await tx.workingArtifactFile.createMany({
        data: files.map((file) => ({
          projectId,
          workflowRunId: childRunId,
          workingArtifactId: copy.id,
          fileObjectId: file.fileObjectId,
          role: file.role,
          sortOrder: file.sortOrder,
        })),
      });
    if (dependencies.length)
      await tx.workingArtifactDependency.createMany({
        data: dependencies.map((dependency) => ({
          projectId,
          workflowRunId: childRunId,
          dependentArtifactId: copy.id,
          ...dependency,
        })),
      });
  }
  for (const source of assets) {
    const sourceRunId = source.sourceRunId ? (ids[source.sourceRunId] ?? null) : null;
    const sourceArtifactId = source.sourceArtifactId
      ? (ids[source.sourceArtifactId] ?? null)
      : null;
    await tx.asset.update({
      where: { id: ids[source.id]! },
      data: {
        sourceRunId,
        sourceArtifactId,
      },
    });
  }
  await remapClonedPackagingRunsInTransaction(tx, projectId, packagingRuns, ids);
  for (const run of outputRuns) {
    const copyRunId = ids[run.id];
    if (!copyRunId) continue;
    for (const item of run.items) {
      const copyItemId = ids[item.id];
      if (!copyItemId) continue;
      await tx.effectFinalOutputItem.update({
        where: { id: copyItemId },
        data: {
          snapshot: json(remapIds(item.snapshot, ids)),
        },
      });
    }
  }
  await tx.workflowRun.update({
    where: { id: childRunId },
    data: {
      forkNodeId: 'MANUAL_COPY',
      forkTemplateId: null,
      branchCreationKey: idempotencyKey,
      branchPublishedAt: new Date(),
      editSessionNodeId: null,
      editSessionPurpose: null,
      editBaselineHash: null,
      editIdMap: Prisma.DbNull,
      currentNodeId: parent.currentNodeId,
    },
  });
  await tx.workflowRun.update({ where: { id: parentRunId }, data: { activeKey: null } });
  await tx.workflowRun.update({
    where: { id: childRunId },
    data: {
      activeKey: 'ACTIVE',
      lastActiveAt: new Date(),
    },
  });
  return childRunId;
}
