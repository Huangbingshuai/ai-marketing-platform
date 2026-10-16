import {
  assertCustomizedImportEditable,
  beginCustomizedEdit,
  cancelCustomizedEdit,
  saveCustomizedVersion,
  activateCustomizedBranch,
  customizedScope,
  lockCustomizedProject,
  customizedConflict,
} from './customized-branches';
import { CUSTOMIZED_SOURCE_ARTIFACT_KEY } from '@ai-marketing/contracts';
import {
  EFFECT_WORKFLOW_BRANCH_NODES,
  EFFECT_WORKFLOW_EDITABLE_NODES,
  EFFECT_TEMPLATE_CURRENT_PATH_NODE_ID,
} from '@ai-marketing/contracts';
import type {
  EffectWorkflowBranchNodeId,
  EffectWorkflowEditableNodeId,
  AssetDirectory,
  AssetType,
  AssetWorkflow,
  AssetWorkflowSpace,
  WorkingArtifactKind,
  WorkingArtifactListQuery,
  EffectTemplateMixMaterial,
} from '@ai-marketing/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { Prisma, type WorkflowNodeState } from '../../generated/prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { workflowStateHash } from './workflow-state-hash';
import {
  effectArtifactSourceOwner,
  effectRenderClipHeads,
  effectRenderHead,
  projectEffectBranchFreshness,
} from './effect-branch-freshness';
import {
  activeMixSourceUpdates,
  assertMixSourceUpdateDraftEditable,
  lockMixNodeForSourceUpdate,
} from './effect-mix-source-update-lock';
import { assertPackagingDraftEditable } from './effect-packaging-lock';
import {
  beginEffectEditInTransaction,
  exitEffectEditInTransaction,
  type EffectEditBeginOptions,
} from './effect-edit-session';
import { createEffectManualBranchInTransaction } from './effect-manual-branch';
import { selectedEffectTemplatePaths } from './effect-template-current-path';
import { recoverPublishedRenderPrompt } from './effect-published-render-source';
import { artifactTemplateId, pruneDeletedTemplates } from './effect-template-deletion';

export type WorkingArtifactUpsertInput = {
  kind: WorkingArtifactKind;
  name: string;
  directory: AssetDirectory;
  type: AssetType;
  tags?: string[];
  payload?: unknown;
  metadata?: unknown;
  originalFileName?: string | null;
  mimeType?: string | null;
  sizeBytes?: number | null;
  storageKey?: string | null;
  sourceRunId?: string | null;
  sourceArtifactId?: string | null;
  fileChecksum?: string | null;
  expectedRevision?: number;
  files?: Array<{
    fileObjectId: string;
    role: string;
    sortOrder: number;
    originalFileName: string;
    mimeType: string;
    sha256: string;
  }>;
  dependencies?: Array<{
    sourceType: 'NODE_STATE' | 'WORKING_ARTIFACT' | 'EXECUTION_INPUT';
    sourceNodeId?: string | null;
    sourceArtifactId?: string | null;
    sourceKey: string;
    sourceRevision?: number | null;
    sourceHash?: string | null;
  }>;
};

export type FileObjectInput = {
  id?: string;
  nodeId: string;
  originalFileName: string;
  mimeType: string;
  sizeBytes: number;
  storageKey: string;
  sha256: string;
};

export const workingArtifactInclude = {
  files: {
    include: { fileObject: true },
    orderBy: [{ sortOrder: 'asc' as const }, { id: 'asc' as const }],
  },
  dependencies: { orderBy: [{ sourceType: 'asc' as const }, { sourceKey: 'asc' as const }] },
} satisfies Prisma.WorkingArtifactInclude;

export type WorkingArtifactRecord = Prisma.WorkingArtifactGetPayload<{
  include: typeof workingArtifactInclude;
}>;

type EffectForkScope = { forkNodeId: string | null; forkTemplateId: string | null };

// This is owned by a single batch transaction, never by the repository or a Run cache.
// Only mix/output batches can reuse it: they do not modify their render source heads.
type ArtifactValidationReadCache = {
  sharedRenderSources?: Promise<WorkingArtifactRecord[]>;
  sharedPromptRunIds?: Promise<string[]>;
  frozenRenderSources?: readonly EffectTemplateMixMaterial[];
  frozenPromptSources?: readonly FrozenRenderPromptSource[];
};

/** Private commit authority, built from persisted render task inputs, never from an HTTP DTO. */
export type FrozenRenderPromptSource = {
  artifactId: string;
  revision: number;
  contentHash: string;
  artifactKey: string;
};

/** An ancestor is readable only before the child fork (or outside its template scope). */
export const inheritedEffectArtifactVisible = (
  artifact: Pick<WorkingArtifactRecord, 'nodeId' | 'artifactKey'>,
  crossedForks: readonly EffectForkScope[],
): boolean => {
  const nodeIndex = EFFECT_WORKFLOW_BRANCH_NODES.indexOf(
    artifact.nodeId as EffectWorkflowBranchNodeId,
  );
  if (nodeIndex < 0) return false;
  return crossedForks.every(({ forkNodeId, forkTemplateId }) => {
    const forkIndex = EFFECT_WORKFLOW_BRANCH_NODES.indexOf(
      forkNodeId as EffectWorkflowBranchNodeId,
    );
    if (forkIndex < 0) return false;
    if (nodeIndex < forkIndex) return true;
    if (!forkTemplateId || forkIndex < 4) return false;
    const templateMatch =
      /^(?:mix-template|timeline-project|timeline-package|final-delivery|final-video):([^:]+)/.exec(
        artifact.artifactKey,
      );
    return Boolean(templateMatch && templateMatch[1] !== forkTemplateId);
  });
};

const jsonValue = (value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull =>
  value === undefined || value === null ? Prisma.JsonNull : (value as Prisma.InputJsonValue);

/** Only the editable stages may open or close an isolated edit session. */
const effectEditableNode = (nodeId: string): EffectWorkflowEditableNodeId | null =>
  EFFECT_WORKFLOW_EDITABLE_NODES.find((node) => node === nodeId) ?? null;

const openRunStatuses = ['ACTIVE', 'PAUSED'] as const;
const cleanupGraceMs = (): number =>
  Number(process.env.WORKING_FILE_CLEANUP_GRACE_HOURS ?? 24) * 60 * 60 * 1000;

const semanticMetadata = (value: unknown): unknown => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value ?? null;
  const metadata = { ...(value as Record<string, unknown>) };
  delete metadata.legacyArtifactIds;
  delete metadata.branchSource;
  delete metadata.branchSourceOwner;
  return metadata;
};

const semanticFileName = (value: string | null | undefined): string | null =>
  value ? value.normalize('NFC').toLocaleLowerCase('en-US') : null;

export const workingArtifactContentHash = (input: WorkingArtifactUpsertInput): string =>
  workflowStateHash({
    kind: input.kind,
    name: input.name,
    directory: input.directory,
    type: input.type,
    tags: [...(input.tags ?? [])]
      .map((item) => item.trim())
      .filter(Boolean)
      .sort(),
    payload: input.payload ?? null,
    metadata: semanticMetadata(input.metadata),
    fileChecksum: input.fileChecksum ?? null,
    legacyFile: input.files?.length
      ? null
      : {
          originalFileName: semanticFileName(input.originalFileName),
          mimeType: input.mimeType?.trim().toLowerCase() ?? null,
          sizeBytes: input.sizeBytes ?? null,
        },
    files: [...(input.files ?? [])]
      .sort(
        (left, right) => left.sortOrder - right.sortOrder || left.role.localeCompare(right.role),
      )
      .map(({ role, sortOrder, originalFileName, mimeType, sha256 }) => ({
        role,
        sortOrder,
        originalFileName: semanticFileName(originalFileName),
        mimeType: mimeType.trim().toLowerCase(),
        sha256,
      })),
    dependencies: [...(input.dependencies ?? [])]
      .sort((left, right) =>
        `${left.sourceType}:${left.sourceKey}`.localeCompare(
          `${right.sourceType}:${right.sourceKey}`,
        ),
      )
      .map(({ sourceType, sourceNodeId, sourceKey, sourceRevision, sourceHash }) => ({
        sourceType,
        sourceNodeId: sourceNodeId ?? null,
        sourceKey,
        sourceRevision: sourceRevision ?? null,
        sourceHash: sourceHash ?? null,
      })),
  });

const persistedArtifactHash = (record: WorkingArtifactRecord): string =>
  workingArtifactContentHash({
    kind: record.kind,
    name: record.name,
    directory: record.directory,
    type: record.type,
    tags: record.tags,
    payload: record.payload,
    metadata: record.metadata,
    originalFileName: record.originalFileName,
    mimeType: record.mimeType,
    sizeBytes: record.sizeBytes,
    storageKey: record.storageKey,
    sourceRunId: record.sourceRunId,
    sourceArtifactId: record.sourceArtifactId,
    files: record.files.map((file) => ({
      fileObjectId: file.fileObjectId,
      role: file.role,
      sortOrder: file.sortOrder,
      originalFileName: file.fileObject.originalFileName,
      mimeType: file.fileObject.mimeType,
      sha256: file.fileObject.sha256,
    })),
    dependencies: record.dependencies.map((dependency) => ({
      sourceType: dependency.sourceType,
      sourceNodeId: dependency.sourceNodeId,
      sourceArtifactId: dependency.sourceArtifactId,
      sourceKey: dependency.sourceKey,
      sourceRevision: dependency.sourceRevision,
      sourceHash: dependency.sourceHash,
    })),
  });

const artifactRevisionSnapshot = (record: WorkingArtifactRecord): Prisma.InputJsonValue =>
  ({
    kind: record.kind,
    name: record.name,
    directory: record.directory,
    type: record.type,
    tags: record.tags,
    payload: record.payload,
    metadata: record.metadata,
    originalFileName: record.originalFileName,
    mimeType: record.mimeType,
    sizeBytes: record.sizeBytes,
    storageKey: record.storageKey,
    sourceRunId: record.sourceRunId,
    sourceArtifactId: record.sourceArtifactId,
    freshness: record.freshness,
    availability: record.availability,
    files: record.files.map((file) => ({
      fileObjectId: file.fileObjectId,
      role: file.role,
      sortOrder: file.sortOrder,
      originalFileName: file.fileObject.originalFileName,
      mimeType: file.fileObject.mimeType,
      sha256: file.fileObject.sha256,
      storageKey: file.fileObject.storageKey,
    })),
    dependencies: record.dependencies.map((dependency) => ({
      sourceType: dependency.sourceType,
      sourceNodeId: dependency.sourceNodeId,
      sourceArtifactId: dependency.sourceArtifactId,
      sourceKey: dependency.sourceKey,
      sourceRevision: dependency.sourceRevision,
      sourceHash: dependency.sourceHash,
    })),
  }) as Prisma.InputJsonValue;

@Injectable()
export class WorkflowWorkingRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async hasEffectConfirmedStageArtifact(
    projectId: string,
    workflowRunId: string,
    nodeId: EffectWorkflowBranchNodeId,
  ): Promise<boolean> {
    const prefixes: Record<string, string> = {
      SOURCE_IMPORT: 'source-package:',
      INFORMATION_EXTRACTION: 'marketing-insight:',
      PROMPT_GENERATION: 'prompt-batch:',
      SEGMENT_RENDER: 'render-batch:',
    };
    const prefix = prefixes[nodeId];
    if (!prefix) return false;
    let runId: string | null = workflowRunId;
    const visited = new Set<string>();
    while (runId && !visited.has(runId)) {
      visited.add(runId);
      const artifact = await this.prisma.workingArtifact.findFirst({
        where: {
          projectId,
          workflowRunId: runId,
          nodeId,
          artifactKey: { startsWith: prefix },
          availability: 'AVAILABLE',
        },
        select: { id: true },
      });
      if (artifact) return true;
      const run: { parentWorkflowRunId: string | null; forkNodeId: string | null } | null =
        await this.prisma.workflowRun.findFirst({
          where: {
            projectId,
            id: runId,
            workflow: 'EFFECT',
            workflowSpace: 'EFFECT',
          },
          select: { parentWorkflowRunId: true, forkNodeId: true },
        });
      if (!run?.parentWorkflowRunId) break;
      const stageIndex = EFFECT_WORKFLOW_BRANCH_NODES.indexOf(nodeId);
      const forkIndex = EFFECT_WORKFLOW_BRANCH_NODES.indexOf(
        run.forkNodeId as EffectWorkflowBranchNodeId,
      );
      if (forkIndex < 0 || stageIndex >= forkIndex) break;
      runId = run.parentWorkflowRunId;
    }
    return false;
  }

  beginEffectNodeEditInTransaction(
    transaction: Prisma.TransactionClient,
    projectId: string,
    parentRunId: string,
    nodeId: EffectWorkflowBranchNodeId,
    purpose: 'MANUAL' | 'BATCH' = 'MANUAL',
    options: EffectEditBeginOptions = {},
  ) {
    const editable = effectEditableNode(nodeId);
    if (!editable) return Promise.resolve(null);
    return beginEffectEditInTransaction(
      transaction,
      projectId,
      parentRunId,
      editable,
      purpose,
      options,
    );
  }

  beginEffectNodeEdit(
    projectId: string,
    parentRunId: string,
    nodeId: EffectWorkflowBranchNodeId,
    purpose: 'MANUAL' | 'BATCH' = 'MANUAL',
    options: EffectEditBeginOptions = {},
  ) {
    return this.prisma.$transaction(
      (transaction) =>
        this.beginEffectNodeEditInTransaction(
          transaction,
          projectId,
          parentRunId,
          nodeId,
          purpose,
          options,
        ),
      { timeout: 120_000 },
    );
  }

  publishEffectNodeEditInTransaction(
    transaction: Prisma.TransactionClient,
    projectId: string,
    draftRunId: string,
    nodeId: EffectWorkflowBranchNodeId,
  ) {
    const editable = effectEditableNode(nodeId);
    if (!editable) return Promise.resolve(null);
    return exitEffectEditInTransaction(transaction, projectId, draftRunId, editable, true);
  }

  publishEffectNodeEdit(projectId: string, draftRunId: string, nodeId: EffectWorkflowBranchNodeId) {
    return this.prisma.$transaction(
      (transaction) =>
        this.publishEffectNodeEditInTransaction(transaction, projectId, draftRunId, nodeId),
      { timeout: 120_000 },
    );
  }

  cancelEffectNodeEdit(projectId: string, draftRunId: string, nodeId: EffectWorkflowBranchNodeId) {
    const editable = effectEditableNode(nodeId);
    if (!editable) return Promise.resolve(null);
    return this.prisma.$transaction(
      (transaction) =>
        exitEffectEditInTransaction(transaction, projectId, draftRunId, editable, false),
      { timeout: 120_000 },
    );
  }

  createEffectManualBranch(projectId: string, parentRunId: string, idempotencyKey: string) {
    return this.prisma.$transaction(
      (transaction) =>
        createEffectManualBranchInTransaction(transaction, projectId, parentRunId, idempotencyKey),
      { timeout: 120_000 },
    );
  }

  private deletedTemplates(projectId: string) {
    return (
      this.prisma.effectTemplateDeletion?.findMany?.({
        where: { projectId },
        select: { templateId: true, workflowRunIds: true },
      }) ?? Promise.resolve([])
    );
  }

  async findRun(projectId: string, workflowRunId: string) {
    const deletions = await this.deletedTemplates(projectId);
    if (deletions.some((d) => d.workflowRunIds.includes(workflowRunId))) return null;
    return this.prisma.workflowRun.findFirst({ where: { id: workflowRunId, projectId } });
  }

  assertCustomizedImportEditable(projectId: string, runId: string) {
    return this.prisma.$transaction((tx) => assertCustomizedImportEditable(tx, projectId, runId));
  }

  async assertCustomizedImportEditableForConfirmation(projectId: string, runId: string) {
    const run = await this.findActiveRun(projectId, 'CUSTOMIZED', 'CUSTOMIZED_PROJECT');
    if (
      !run ||
      run.id !== runId ||
      (run.editSessionNodeId && run.editSessionNodeId !== 'SOURCE_IMPORT')
    )
      return customizedConflict('工作流版本已切换或已完成，请重新加载');
  }

  findCustomizedSourceFiles(
    projectId: string,
    materials: Array<{ assetId: string; assetVersion: number }>,
  ) {
    if (!materials.length) return Promise.resolve([]);
    return this.prisma.assetVersion.findMany({
      where: {
        projectId,
        OR: materials.map((item) => ({ assetId: item.assetId, version: item.assetVersion })),
        asset: {
          projectId,
          storageWorkflow: 'CUSTOMIZED',
          workflowSpace: 'CUSTOMIZED_PROJECT',
          directory: 'SOURCE_MATERIALS',
          type: 'SOURCE_MATERIAL',
          archivedAt: null,
          hasFile: true,
          status: { not: 'UNAVAILABLE' },
        },
      },
    });
  }

  findActiveRun(projectId: string, workflow: AssetWorkflow, space: AssetWorkflowSpace) {
    return this.prisma.workflowRun.findFirst({
      where: {
        projectId,
        workflow,
        workflowSpace: space,
        activeKey: 'ACTIVE',
        status: { in: [...openRunStatuses] },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  findActiveRunWithNodeStates(
    projectId: string,
    workflow: AssetWorkflow,
    space: AssetWorkflowSpace,
  ) {
    return this.prisma.workflowRun.findFirst({
      where: {
        projectId,
        workflow,
        workflowSpace: space,
        activeKey: 'ACTIVE',
        status: { in: [...openRunStatuses] },
      },
      include: { nodeStates: { orderBy: [{ savedAt: 'asc' }, { id: 'asc' }] } },
      orderBy: { createdAt: 'desc' },
    });
  }

  createRun(projectId: string, workflow: AssetWorkflow, space: AssetWorkflowSpace, id?: string) {
    return this.prisma.workflowRun.create({
      data: { ...(id ? { id } : {}), projectId, workflow, workflowSpace: space },
    });
  }

  async initializeCustomizedRun(projectId: string) {
    const scope = {
      projectId,
      workflow: 'CUSTOMIZED' as const,
      workflowSpace: 'CUSTOMIZED_PROJECT' as const,
      activeKey: 'ACTIVE',
    };
    try {
      return await this.prisma.workflowRun.upsert({
        where: { projectId_workflow_workflowSpace_activeKey: scope },
        create: { ...scope, currentNodeId: 'SOURCE_IMPORT' },
        update: {},
      });
    } catch (error) {
      // Concurrent initializations must converge on the same database unique key.
      if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') {
        const run = await this.findActiveRun(projectId, 'CUSTOMIZED', 'CUSTOMIZED_PROJECT');
        if (run) return run;
      }
      throw error;
    }
  }

  listCustomizedRunBranches(projectId: string) {
    return this.prisma.workflowRun.findMany({
      where: customizedScope(projectId),
      include: { workingArtifacts: { where: { availability: 'AVAILABLE' } } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  }
  beginCustomizedNodeEdit(projectId: string, runId: string) {
    return this.prisma.$transaction((tx) => beginCustomizedEdit(tx, projectId, runId));
  }
  cancelCustomizedNodeEdit(projectId: string, runId: string) {
    return this.prisma.$transaction((tx) => cancelCustomizedEdit(tx, projectId, runId));
  }
  saveCustomizedSourceVersion(projectId: string, runId: string, revision: number) {
    return this.prisma.$transaction((tx) =>
      saveCustomizedVersion(tx, this, projectId, runId, revision),
    );
  }
  activateCustomizedRunBranch(projectId: string, runId: string, nodeId: string) {
    return this.prisma.$transaction((tx) => activateCustomizedBranch(tx, projectId, runId, nodeId));
  }

  /**
   * Every Run of the project, published or not. The tree only draws published ones, but an
   * unpublished child still has to be loaded: it is where an unfinished regeneration is sitting.
   * Modern batch packaging may publish partial success; legacy partial batches remain hidden.
   * It does not reserve a visible version number, but a later branch forked from it still has to
   * land under an ancestor the user can actually see.
   */
  async listEffectRunBranches(projectId: string) {
    const deletions = await this.deletedTemplates(projectId);
    const deletedIds = new Set(deletions.map((d) => d.templateId));
    const removedRuns = new Set(deletions.flatMap((d) => d.workflowRunIds));
    const rows = await this.prisma.workflowRun.findMany({
      where: { projectId, workflow: 'EFFECT', workflowSpace: 'EFFECT' },
      include: {
        nodeStates: {
          where: { nodeId: { in: ['TEMPLATE_MIX', EFFECT_TEMPLATE_CURRENT_PATH_NODE_ID] } },
          select: { nodeId: true, state: true },
        },
        workingArtifactRevisions: {
          where: { nodeId: { in: ['TEMPLATE_MIX', 'FINAL_OUTPUT'] } },
          select: { workingArtifactId: true, revision: true, confirmedAt: true },
        },
        effectTemplateMixAiRuns: {
          where: { status: 'COMPLETED', outputVariantId: { not: null } },
          select: {
            templateId: true,
            outputVariantId: true,
            idempotencyKey: true,
            status: true,
            inputSnapshot: true,
            selectionResult: true,
            completedAt: true,
          },
        },
        effectPackagingRuns: {
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          select: {
            id: true,
            templateId: true,
            status: true,
            idempotencyKey: true,
            completedAt: true,
            items: {
              orderBy: { id: 'desc' },
              select: { variantId: true, status: true, completedAt: true, checkpoint: true },
            },
          },
        },
        effectFinalOutputRuns: {
          select: {
            id: true,
            templateId: true,
            status: true,
            items: {
              select: {
                id: true,
                variantId: true,
                status: true,
                fileObjectId: true,
                assetId: true,
                snapshot: true,
              },
            },
          },
        },
        workingArtifacts: {
          where: { availability: 'AVAILABLE' },
          select: {
            id: true,
            workflowRunId: true,
            nodeId: true,
            freshness: true,
            availability: true,
            artifactKey: true,
            revision: true,
            name: true,
            createdAt: true,
            updatedAt: true,
            payload: true,
            contentHash: true,
            metadata: true,
            dependencies: true,
          },
        },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    // Only the new batch protocol publishes partial success. Read its operation through a JSON
    // predicate rather than loading every film's large frozen input/baseline into the tree.
    const partialBatchIds = rows
      .filter((r) => !removedRuns.has(r.id))
      .flatMap((r) =>
        r.effectPackagingRuns
          .filter((batch) => batch.status === 'PARTIAL' && !deletedIds.has(batch.templateId))
          .map((batch) => batch.id),
      );
    const publishedPartialBatches = new Set(
      partialBatchIds.length
        ? (
            await this.prisma.effectPackagingItem.findMany({
              where: {
                projectId,
                runId: { in: partialBatchIds },
                status: 'COMPLETED',
                snapshot: { path: ['operation'], equals: 'BATCH_PACKAGE' },
              },
              select: { runId: true },
              distinct: ['runId'],
            })
          ).map((item) => item.runId)
        : [],
    );
    return rows
      .filter((r) => !removedRuns.has(r.id))
      .map((r) => {
        let parent = r.parentWorkflowRunId;
        const seen = new Set<string>();
        while (parent && removedRuns.has(parent) && !seen.has(parent)) {
          seen.add(parent);
          parent = rows.find((row) => row.id === parent)?.parentWorkflowRunId ?? null;
        }
        const visibleArtifacts = r.workingArtifacts.filter(
          (a) => !deletedIds.has(artifactTemplateId(a.artifactKey) ?? ''),
        );
        const visibleIds = new Set(visibleArtifacts.map((a) => a.id));
        return {
          ...r,
          parentWorkflowRunId: parent,
          workingArtifacts: visibleArtifacts,
          workingArtifactRevisions: r.workingArtifactRevisions.filter((s) =>
            visibleIds.has(s.workingArtifactId),
          ),
          effectTemplateMixAiRuns: r.effectTemplateMixAiRuns.filter(
            (t) => !deletedIds.has(t.templateId),
          ),
          effectPackagingRuns: r.effectPackagingRuns
            .filter((t) => !deletedIds.has(t.templateId))
            .map((batch) => ({
              ...batch,
              operation: publishedPartialBatches.has(batch.id)
                ? ('BATCH_PACKAGE' as const)
                : undefined,
            })),
          nodeStates: r.nodeStates.map((s) => ({
            ...s,
            state: pruneDeletedTemplates(s.state, deletedIds) as Prisma.JsonValue,
          })),
        };
      });
  }

  async activateEffectRunBranch(
    projectId: string,
    targetRunId: string,
    requestedTemplateId?: string | null,
  ) {
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw(
        Prisma.sql`SELECT "id" FROM "projects" WHERE "id" = ${projectId}::uuid FOR UPDATE`,
      );
      const runs = await transaction.workflowRun.findMany({
        where: { projectId, workflow: 'EFFECT', workflowSpace: 'EFFECT' },
      });
      const active = runs.find((run) => run.activeKey === 'ACTIVE');
      const target = runs.find((run) => run.id === targetRunId);
      if (
        !active ||
        !target ||
        target.status === 'COMPLETED' ||
        (target.parentWorkflowRunId && !target.branchPublishedAt)
      )
        return null;
      const byId = new Map(runs.map((run) => [run.id, run]));
      const rootId = (id: string): string | null => {
        const visited = new Set<string>();
        let current = byId.get(id);
        while (current?.parentWorkflowRunId) {
          if (visited.has(current.id)) return null;
          visited.add(current.id);
          current = byId.get(current.parentWorkflowRunId);
        }
        return current?.id ?? null;
      };
      if (rootId(active.id) !== rootId(target.id)) return null;
      // The effect import workspace is still a project-level singleton in legacy data.
      // Do not expose a branch that the six existing node APIs cannot actually load.
      const workspace = await transaction.effectImportWorkspace.findFirst({
        where: { projectId, workflowRunId: target.id },
      });
      if (!workspace) return null;
      // Explicit navigation is per template. Ordinary node navigation never calls this path.
      // Legacy completion callers omit the template and use their template-scoped fork.
      const templateId =
        requestedTemplateId === undefined ? target.forkTemplateId : requestedTemplateId;
      if (templateId) {
        const draft = await transaction.workflowNodeState.findUnique({
          where: {
            projectId_workflowRunId_nodeId: {
              projectId,
              workflowRunId: target.id,
              nodeId: 'TEMPLATE_MIX',
            },
          },
        });
        const data = draft?.state as { templates?: Array<{ id?: string }> } | undefined;
        const exists =
          data?.templates?.some((entry) => entry.id === templateId) ||
          (await transaction.workingArtifact.findFirst({
            where: {
              projectId,
              workflowRunId: target.id,
              artifactKey: `mix-template:${templateId}`,
              availability: 'AVAILABLE',
            },
            select: { id: true },
          }));
        if (!exists) return null;
        const where = {
          projectId_workflowRunId_nodeId: {
            projectId,
            workflowRunId: target.id,
            nodeId: EFFECT_TEMPLATE_CURRENT_PATH_NODE_ID,
          },
        };
        const previous = await transaction.workflowNodeState.findUnique({ where });
        const selectedTemplates = selectedEffectTemplatePaths(
          target.id,
          previous ? [previous] : [],
        );
        const state = {
          schemaVersion: 1,
          workflowRunId: target.id,
          selectedTemplates: { ...selectedTemplates, [templateId]: new Date().toISOString() },
        };
        const contentHash = workflowStateHash(state);
        await transaction.workflowNodeState.upsert({
          where,
          create: {
            projectId,
            workflowRunId: target.id,
            nodeId: EFFECT_TEMPLATE_CURRENT_PATH_NODE_ID,
            state,
            contentHash,
          },
          update: { state, contentHash, revision: { increment: 1 }, savedAt: new Date() },
        });
      }
      if (active.id === target.id) return active;
      await transaction.workflowRun.update({ where: { id: active.id }, data: { activeKey: null } });
      return transaction.workflowRun.update({
        where: { id: target.id },
        data: { activeKey: 'ACTIVE', lastActiveAt: new Date() },
      });
    });
  }

  async findNodeState(projectId: string, workflowRunId: string, nodeId: string) {
    const row = await this.prisma.workflowNodeState.findUnique({
      where: { projectId_workflowRunId_nodeId: { projectId, workflowRunId, nodeId } },
    });
    if (
      !row ||
      !['TEMPLATE_MIX', 'FINAL_OUTPUT', EFFECT_TEMPLATE_CURRENT_PATH_NODE_ID].includes(nodeId)
    )
      return row;
    const deleted = new Set((await this.deletedTemplates(projectId)).map((d) => d.templateId));
    return deleted.size
      ? { ...row, state: pruneDeletedTemplates(row.state, deleted) as Prisma.JsonValue }
      : row;
  }

  async activateNode(projectId: string, workflowRunId: string, nodeId: string) {
    const updated = await this.prisma.workflowRun.updateMany({
      where: {
        id: workflowRunId,
        projectId,
        status: { in: [...openRunStatuses] },
      },
      data: { currentNodeId: nodeId, lastActiveAt: new Date() },
    });
    return updated.count > 0 ? this.findRun(projectId, workflowRunId) : null;
  }

  async saveNodeState(
    projectId: string,
    workflowRunId: string,
    nodeId: string,
    contentHash: string,
    state: unknown,
    expectedRevision: number | null,
    schemaVersion: number,
    executionInputHash = '0e9561cfb83d50990a103b3896fe249a11fe27fa28985448187f93ec12116d72',
    executionInputSchemaVersion = 1,
  ): Promise<{ record: WorkflowNodeState; unchanged: boolean; conflict: boolean }> {
    return this.prisma.$transaction(async (transaction) => {
      const run = await transaction.workflowRun.findFirst({
        where: { id: workflowRunId, projectId, status: { in: [...openRunStatuses] } },
      });
      if (!run) throw new Error('WORKFLOW_RUN_NOT_FOUND');
      if (run.workflow === 'CUSTOMIZED') {
        await lockCustomizedProject(transaction, projectId);
        const selected = await transaction.workflowRun.findFirst({
          where: {
            ...customizedScope(projectId),
            id: workflowRunId,
            activeKey: 'ACTIVE',
          },
        });
        if (!selected) return customizedConflict('工作流版本已切换，旧草稿不能覆盖当前内容');
        const confirmed =
          nodeId === 'SOURCE_IMPORT' &&
          (await transaction.workingArtifact.findFirst({
            where: {
              projectId,
              workflowRunId,
              nodeId,
              artifactKey: CUSTOMIZED_SOURCE_ARTIFACT_KEY,
            },
          }));
        if (confirmed && selected.editSessionNodeId !== nodeId)
          return customizedConflict('请先进入编辑，再修改已确认资料');
      }
      if (nodeId === 'TEMPLATE_MIX')
        await lockMixNodeForSourceUpdate(transaction, projectId, workflowRunId);
      const current = await transaction.workflowNodeState.findUnique({
        where: { projectId_workflowRunId_nodeId: { projectId, workflowRunId, nodeId } },
      });
      const contentUnchanged = Boolean(
        current &&
        (current.contentHash === contentHash || workflowStateHash(current.state) === contentHash),
      );
      if (current && contentUnchanged) {
        if (
          current.executionInputHash === executionInputHash &&
          current.executionInputSchemaVersion === executionInputSchemaVersion
        )
          return { record: current, unchanged: true, conflict: false };
        const record = await transaction.workflowNodeState.update({
          where: { id: current.id },
          data: { executionInputHash, executionInputSchemaVersion },
        });
        await this.markNodeDependentsStaleInTransaction(
          transaction,
          projectId,
          workflowRunId,
          nodeId,
        );
        return { record, unchanged: true, conflict: false };
      }
      if (current) {
        if (expectedRevision !== current.revision)
          return { record: current, unchanged: false, conflict: true };
        if (nodeId === 'TEMPLATE_MIX')
          await assertPackagingDraftEditable(
            transaction,
            projectId,
            workflowRunId,
            current.state,
            state,
          );
        if (nodeId === 'TEMPLATE_MIX')
          assertMixSourceUpdateDraftEditable(
            current.state,
            state,
            await activeMixSourceUpdates(transaction, projectId, workflowRunId),
          );
        const record = await transaction.workflowNodeState.update({
          where: { id: current.id },
          data: {
            state: jsonValue(state),
            contentHash,
            schemaVersion,
            executionInputHash,
            executionInputSchemaVersion,
            revision: { increment: 1 },
            savedAt: new Date(),
          },
        });
        await transaction.workflowRun.update({
          where: { id: workflowRunId },
          data: { currentNodeId: nodeId, lastActiveAt: new Date() },
        });
        if (current.executionInputHash !== executionInputHash)
          await this.markNodeDependentsStaleInTransaction(
            transaction,
            projectId,
            workflowRunId,
            nodeId,
          );
        return { record, unchanged: false, conflict: false };
      }
      if (expectedRevision !== null && expectedRevision !== 0)
        return {
          record: null as never,
          unchanged: false,
          conflict: true,
        };
      const record = await transaction.workflowNodeState.create({
        data: {
          projectId,
          workflowRunId,
          nodeId,
          state: jsonValue(state),
          contentHash,
          schemaVersion,
          executionInputHash,
          executionInputSchemaVersion,
        },
      });
      await transaction.workflowRun.update({
        where: { id: workflowRunId },
        data: { currentNodeId: nodeId, lastActiveAt: new Date() },
      });
      return { record, unchanged: false, conflict: false };
    });
  }

  async replaceNodeState(
    projectId: string,
    workflowRunId: string,
    nodeId: string,
    contentHash: string,
    state: unknown,
    schemaVersion = 1,
    executionInputHash = '0e9561cfb83d50990a103b3896fe249a11fe27fa28985448187f93ec12116d72',
    executionInputSchemaVersion = 1,
  ): Promise<WorkflowNodeState> {
    return this.prisma.$transaction(async (transaction) => {
      const run = await transaction.workflowRun.findFirst({
        where: { id: workflowRunId, projectId, status: { in: [...openRunStatuses] } },
      });
      if (!run) throw new Error('WORKFLOW_RUN_NOT_FOUND');
      const unique = { projectId, workflowRunId, nodeId };
      const current = await transaction.workflowNodeState.findUnique({
        where: { projectId_workflowRunId_nodeId: unique },
      });
      if (current && current.contentHash === contentHash) {
        if (
          current.executionInputHash === executionInputHash &&
          current.executionInputSchemaVersion === executionInputSchemaVersion
        )
          return current;
        const record = await transaction.workflowNodeState.update({
          where: { id: current.id },
          data: { executionInputHash, executionInputSchemaVersion },
        });
        await this.markNodeDependentsStaleInTransaction(
          transaction,
          projectId,
          workflowRunId,
          nodeId,
        );
        return record;
      }
      const record = current
        ? await transaction.workflowNodeState.update({
            where: { id: current.id },
            data: {
              state: jsonValue(state),
              contentHash,
              schemaVersion,
              executionInputHash,
              executionInputSchemaVersion,
              revision: { increment: 1 },
              savedAt: new Date(),
            },
          })
        : await transaction.workflowNodeState.create({
            data: {
              ...unique,
              state: jsonValue(state),
              contentHash,
              schemaVersion,
              executionInputHash,
              executionInputSchemaVersion,
            },
          });
      await transaction.workflowRun.update({
        where: { id: workflowRunId },
        data: { currentNodeId: nodeId, lastActiveAt: new Date() },
      });
      if (!current || current.executionInputHash !== executionInputHash)
        await this.markNodeDependentsStaleInTransaction(
          transaction,
          projectId,
          workflowRunId,
          nodeId,
        );
      return record;
    });
  }

  async listArtifacts(
    projectId: string,
    filters: WorkingArtifactListQuery,
    options: { upstreamOnly?: boolean } = {},
  ): Promise<WorkingArtifactRecord[]> {
    const deletions = await this.deletedTemplates(projectId);
    const ids = new Set(deletions.map((d) => d.templateId));
    const removedRuns = new Set(deletions.flatMap((d) => d.workflowRunIds));
    // A removed mix/output Run can remain a provenance container for the live
    // render head. loadArtifacts already limits these sources to this lineage
    // and its exact dependency closure; hiding the template must not hide its
    // shared upstream pool from another live Run. Historical/deleted-Run reads
    // remain hidden, and template-owned outputs are always excluded.
    const sharedSourceRead = Boolean(
      filters.workflowRunId &&
      !removedRuns.has(filters.workflowRunId) &&
      filters.view !== 'SNAPSHOT',
    );
    return (await this.loadArtifacts(projectId, filters, options)).filter(
      (a) =>
        !ids.has(artifactTemplateId(a.artifactKey) ?? '') &&
        (!removedRuns.has(a.workflowRunId) ||
          (sharedSourceRead &&
            [
              'SOURCE_IMPORT',
              'INFORMATION_EXTRACTION',
              'PROMPT_GENERATION',
              'SEGMENT_RENDER',
            ].includes(a.nodeId))),
    );
  }

  private async loadArtifacts(
    projectId: string,
    filters: WorkingArtifactListQuery,
    options: { upstreamOnly?: boolean } = {},
  ): Promise<WorkingArtifactRecord[]> {
    // Worker checkpoints need the same branch/legacy/dependency projection as the
    // UI, but never need to hydrate every sibling timeline and its full package.
    const nodeFilter =
      filters.nodeId ??
      (options.upstreamOnly
        ? {
            in: ['SOURCE_IMPORT', 'INFORMATION_EXTRACTION', 'PROMPT_GENERATION', 'SEGMENT_RENDER'],
          }
        : undefined);
    const where: Prisma.WorkingArtifactWhereInput = {
      projectId,
      ...(filters.workflowRunId ? { workflowRunId: filters.workflowRunId } : {}),
      ...(nodeFilter ? { nodeId: nodeFilter } : {}),
      workflowRun: {
        ...(filters.view === 'SNAPSHOT' ? {} : { status: { in: [...openRunStatuses] } }),
        ...(filters.workflow ? { workflow: filters.workflow } : {}),
        ...(filters.space ? { workflowSpace: filters.space } : {}),
      },
    };
    const localRead = this.prisma.workingArtifact.findMany({
      where,
      include: workingArtifactInclude,
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
    });
    // Asset browsing must never replace saved history with a shared current source.
    if (filters.view === 'SNAPSHOT' || !filters.workflowRunId) return localRead;
    const [local, branches] = await Promise.all([
      localRead,
      this.prisma.workflowRun.findMany({
        where: { projectId },
        select: {
          id: true,
          workflow: true,
          workflowSpace: true,
          parentWorkflowRunId: true,
          forkNodeId: true,
          forkTemplateId: true,
          branchPublishedAt: true,
          createdAt: true,
          effectTemplateMixAiRuns: {
            where: { status: 'COMPLETED', outputVariantId: { not: null } },
            select: {
              templateId: true,
              status: true,
              inputSnapshot: true,
              selectionResult: true,
              completedAt: true,
            },
          },
        },
      }),
    ]);
    const byId = new Map(branches.map((branch) => [branch.id, branch]));
    const run = byId.get(filters.workflowRunId);
    if (run?.workflow !== 'EFFECT' || run.workflowSpace !== 'EFFECT') return local;

    // Confirmed render edits may be saved while a mix branch is active. They belong to the
    // shared render lineage, not only descendants of the Run where the user saved them.
    const renderIdentities =
      !filters.nodeId || filters.nodeId === 'SEGMENT_RENDER'
        ? await this.prisma.workingArtifact.findMany({
            where: {
              projectId,
              nodeId: 'SEGMENT_RENDER',
              availability: 'AVAILABLE',
              workflowRunId: {
                in: branches
                  .filter(
                    (branch) => branch.workflow === 'EFFECT' && branch.workflowSpace === 'EFFECT',
                  )
                  .map((branch) => branch.id),
              },
            },
            select: {
              id: true,
              workflowRunId: true,
              nodeId: true,
              artifactKey: true,
              revision: true,
              metadata: true,
              payload: true,
              updatedAt: true,
            },
          })
        : [];
    const renderOwner = effectArtifactSourceOwner(
      branches,
      run.id,
      'SEGMENT_RENDER',
      renderIdentities,
    );
    const clipHeads = effectRenderClipHeads(branches, run.id, renderIdentities);
    const activeClipIds = new Set([...clipHeads.values()].map((row) => row.id));
    const renderHead = effectRenderHead(branches, run.id);
    const renderRuns = branches
      .filter(
        (branch) =>
          branch.workflow === 'EFFECT' &&
          branch.workflowSpace === 'EFFECT' &&
          effectRenderHead(branches, branch.id) === renderHead &&
          (branch.id === renderHead || branch.branchPublishedAt !== null),
      )
      .map((branch) => branch.id);
    const isRenderSource = (artifact: WorkingArtifactRecord) =>
      artifact.artifactKey.startsWith('render-clip:') && clipHeads.size
        ? activeClipIds.has(artifact.id)
        : artifact.workflowRunId === renderOwner;
    const sharedRender = renderIdentities.length
      ? await this.prisma.workingArtifact.findMany({
          where: {
            projectId,
            OR: [{ workflowRunId: renderOwner }, { id: { in: [...activeClipIds] } }],
            nodeId: 'SEGMENT_RENDER',
            availability: 'AVAILABLE',
          },
          include: workingArtifactInclude,
        })
      : [];
    const sharedRead = async (rows: WorkingArtifactRecord[]): Promise<WorkingArtifactRecord[]> => {
      const unique = [...new Map([...rows, ...sharedRender].map((row) => [row.id, row])).values()];
      // Preserve exactly consumed render identities for existing timelines. A pool switch is not
      // a timeline rewrite; old sibling-bound files still need to resolve for playback and refresh.
      const consumedIds = [
        ...new Set(
          unique
            .filter((row) => ['TEMPLATE_MIX', 'FINAL_OUTPUT'].includes(row.nodeId))
            .flatMap((row) =>
              (row.dependencies ?? []).flatMap((dependency) =>
                dependency.sourceType === 'WORKING_ARTIFACT' && dependency.sourceArtifactId
                  ? [dependency.sourceArtifactId]
                  : [],
              ),
            ),
        ),
      ].filter((id) => !unique.some((row) => row.id === id));
      if (consumedIds.length && renderRuns.length)
        unique.push(
          ...(await this.prisma.workingArtifact.findMany({
            where: {
              projectId,
              id: { in: consumedIds },
              nodeId: 'SEGMENT_RENDER',
              workflowRunId: { in: renderRuns },
            },
            include: workingArtifactInclude,
          })),
        );
      // An adopted render source can live in a sibling mix Run. Its exact Prompt/fact/file
      // dependencies are not necessarily on the selected Run's ancestor path. Load that
      // dependency closure, not arbitrary sibling artifacts or a same-key substitute: consumers
      // must still reject changed revisions, hashes, unavailable files and independent heads.
      const sourceRuns = new Set<string>();
      for (const sourceRun of new Set([
        renderOwner,
        ...unique.filter((row) => row.nodeId === 'SEGMENT_RENDER').map((row) => row.workflowRunId),
        // Render edits merge back into the shared head, but their frozen Prompt may
        // belong to a published mix descendant. Permit that exact dependency's
        // container too; renderRuns excludes unpublished and independent heads.
        ...renderRuns,
      ])) {
        let sourceBranch = byId.get(sourceRun);
        while (
          sourceBranch?.workflow === 'EFFECT' &&
          sourceBranch.workflowSpace === 'EFFECT' &&
          !sourceRuns.has(sourceBranch.id)
        ) {
          sourceRuns.add(sourceBranch.id);
          sourceBranch = sourceBranch.parentWorkflowRunId
            ? byId.get(sourceBranch.parentWorkflowRunId)
            : undefined;
        }
      }
      const loaded = new Map(unique.map((row) => [row.id, row]));
      const traversed = new Set<string>();
      let frontier = unique.filter((row) => row.nodeId === 'SEGMENT_RENDER');
      while (frontier.length) {
        for (const row of frontier) traversed.add(row.id);
        const ids = [
          ...new Set(
            frontier.flatMap((row) =>
              row.dependencies.flatMap((dependency) =>
                dependency.sourceType === 'WORKING_ARTIFACT' && dependency.sourceArtifactId
                  ? [dependency.sourceArtifactId]
                  : [],
              ),
            ),
          ),
        ];
        const missing = ids.filter((id) => !loaded.has(id));
        if (missing.length) {
          const dependencies = await this.prisma.workingArtifact.findMany({
            where: {
              projectId,
              id: { in: missing },
              workflowRunId: { in: [...sourceRuns] },
              nodeId: { in: ['SOURCE_IMPORT', 'INFORMATION_EXTRACTION', 'PROMPT_GENERATION'] },
            },
            include: workingArtifactInclude,
          });
          for (const row of dependencies)
            if (!loaded.has(row.id)) {
              loaded.set(row.id, row);
              unique.push(row);
            }
        }
        frontier = ids.flatMap((id) =>
          loaded.has(id) && !traversed.has(id) ? [loaded.get(id)!] : [],
        );
      }
      const legacyTaskIds = [
        ...new Set(
          unique
            .filter((row) => row.nodeId === 'SEGMENT_RENDER')
            .flatMap((row) => {
              const payload = row.payload as {
                clips?: unknown[];
                taskId?: unknown;
                promptContentHash?: unknown;
                adoptedPrompt?: unknown;
              } | null;
              const clips = payload?.clips ?? [payload];
              return clips.flatMap((value) => {
                const clip = value as typeof payload;
                return clip &&
                  !clip.adoptedPrompt &&
                  typeof clip.promptContentHash === 'string' &&
                  typeof clip.taskId === 'string'
                  ? [clip.taskId]
                  : [];
              });
            }),
        ),
      ];
      const snapshots =
        legacyTaskIds.length && this.prisma.effectSegmentRenderTask?.findMany
          ? await this.prisma.effectSegmentRenderTask.findMany({
              where: {
                projectId,
                workflowRunId: {
                  in: unique
                    .filter((row) => row.nodeId === 'SEGMENT_RENDER')
                    .map((row) => row.workflowRunId),
                },
                id: { in: legacyTaskIds },
              },
              select: {
                id: true,
                workflowRunId: true,
                promptId: true,
                outputFileObjectId: true,
                requestSnapshot: true,
                generationRequestSnapshot: true,
              },
            })
          : [];
      const recovered = snapshots.length
        ? unique.map((row) => recoverPublishedRenderPrompt(row, snapshots))
        : unique;
      const result = projectEffectBranchFreshness(branches, recovered, [
        ...recovered,
        ...renderIdentities,
      ]);
      for (const artifact of result)
        if (artifact.nodeId === 'SEGMENT_RENDER')
          artifact.metadata = {
            ...(artifact.metadata &&
            typeof artifact.metadata === 'object' &&
            !Array.isArray(artifact.metadata)
              ? artifact.metadata
              : {}),
            branchSourceOwner: isRenderSource(artifact),
          };
      return filters.nodeId ? result.filter((row) => row.nodeId === filters.nodeId) : result;
    };
    if (!run.parentWorkflowRunId) return sharedRead(local);

    const visited = new Set([run.id]);
    const crossedForks: EffectForkScope[] = [];
    const ancestors: Array<{ id: string; scopes: EffectForkScope[] }> = [];
    let child = run;
    while (child.parentWorkflowRunId && !visited.has(child.parentWorkflowRunId)) {
      crossedForks.push({
        forkNodeId: child.forkNodeId,
        forkTemplateId: child.forkTemplateId,
      });
      const parent = byId.get(child.parentWorkflowRunId);
      if (!parent || parent.workflow !== 'EFFECT' || parent.workflowSpace !== 'EFFECT') break;
      visited.add(parent.id);
      ancestors.push({ id: parent.id, scopes: [...crossedForks] });
      child = parent;
    }
    if (!ancestors.length) return sharedRead(local);
    // Decide visibility and nearest-key shadowing using identities only. Loading every ancestor's
    // complete payload/files in a sequential loop grows with branch depth and duplicates large
    // Prompt batches. Hydrate only the winning inherited rows after the same fork rules run.
    const identities = await this.prisma.workingArtifact.findMany({
      where: {
        projectId,
        workflowRunId: { in: ancestors.map(({ id }) => id) },
        ...(nodeFilter ? { nodeId: nodeFilter } : {}),
      },
      select: {
        id: true,
        workflowRunId: true,
        nodeId: true,
        artifactKey: true,
        revision: true,
        metadata: true,
      },
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
    });
    const seenKeys = new Set(local.map((item) => `${item.nodeId}:${item.artifactKey}`));
    const sourceIdentities = [...local, ...identities, ...renderIdentities];
    const inheritedIds: string[] = [];
    for (const ancestor of ancestors) {
      for (const artifact of identities.filter(
        ({ workflowRunId }) => workflowRunId === ancestor.id,
      )) {
        const key = `${artifact.nodeId}:${artifact.artifactKey}`;
        if (!inheritedEffectArtifactVisible(artifact, ancestor.scopes)) continue;
        // Copies consumed downstream must not shadow their actual upstream node heads.
        const sourceOwner =
          [
            'SOURCE_IMPORT',
            'INFORMATION_EXTRACTION',
            'PROMPT_GENERATION',
            'SEGMENT_RENDER',
          ].includes(artifact.nodeId) &&
          effectArtifactSourceOwner(branches, run.id, artifact.nodeId, sourceIdentities) ===
            ancestor.id;
        if (seenKeys.has(key) && !sourceOwner) continue;
        inheritedIds.push(artifact.id);
        seenKeys.add(key);
      }
    }
    const inherited = inheritedIds.length
      ? await this.prisma.workingArtifact.findMany({
          where: { projectId, id: { in: inheritedIds } },
          include: workingArtifactInclude,
          orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
        })
      : [];
    const rank = new Map(inheritedIds.map((id, index) => [id, index]));
    const result = await sharedRead([
      ...local,
      ...inherited.sort((a, b) => rank.get(a.id)! - rank.get(b.id)!),
    ]);
    for (const artifact of result)
      if (
        ['SOURCE_IMPORT', 'INFORMATION_EXTRACTION', 'PROMPT_GENERATION', 'SEGMENT_RENDER'].includes(
          artifact.nodeId,
        )
      )
        artifact.metadata = {
          ...(artifact.metadata &&
          typeof artifact.metadata === 'object' &&
          !Array.isArray(artifact.metadata)
            ? artifact.metadata
            : {}),
          branchSourceOwner:
            artifact.nodeId === 'SEGMENT_RENDER'
              ? isRenderSource(artifact)
              : artifact.workflowRunId ===
                effectArtifactSourceOwner(branches, run.id, artifact.nodeId, result),
        };
    return result.sort(
      (left, right) =>
        Date.parse(right.updatedAt.toISOString()) - Date.parse(left.updatedAt.toISOString()),
    );
  }

  findArtifact(projectId: string, artifactId: string) {
    return this.prisma.workingArtifact.findFirst({
      where: { id: artifactId, projectId },
      include: workingArtifactInclude,
    });
  }

  findArtifactByKey(projectId: string, workflowRunId: string, nodeId: string, artifactKey: string) {
    return this.prisma.workingArtifact.findUnique({
      where: {
        projectId_workflowRunId_nodeId_artifactKey: {
          projectId,
          workflowRunId,
          nodeId,
          artifactKey,
        },
      },
      include: workingArtifactInclude,
    });
  }

  pauseRun(projectId: string, workflowRunId: string) {
    return this.prisma.workflowRun.updateMany({
      where: { projectId, id: workflowRunId, status: { in: [...openRunStatuses] } },
      data: { status: 'PAUSED', lastActiveAt: new Date() },
    });
  }

  findFileObject(projectId: string, fileObjectId: string) {
    return this.prisma.fileObject.findFirst({ where: { id: fileObjectId, projectId } });
  }

  async upsertFileObjectInTransaction(
    transaction: Prisma.TransactionClient,
    projectId: string,
    workflowRunId: string,
    input: FileObjectInput,
  ) {
    const existing = await transaction.fileObject.findUnique({
      where: { projectId_storageKey: { projectId, storageKey: input.storageKey } },
    });
    if (existing && existing.workflowRunId !== workflowRunId) {
      const visited = new Set([workflowRunId]);
      let run = await transaction.workflowRun.findFirst({
        where: { projectId, id: workflowRunId, workflow: 'EFFECT', workflowSpace: 'EFFECT' },
      });
      while (run?.parentWorkflowRunId && !visited.has(run.parentWorkflowRunId)) {
        if (run.parentWorkflowRunId === existing.workflowRunId) return existing;
        visited.add(run.parentWorkflowRunId);
        run = await transaction.workflowRun.findFirst({
          where: {
            projectId,
            id: run.parentWorkflowRunId,
            workflow: 'EFFECT',
            workflowSpace: 'EFFECT',
          },
        });
      }
      throw new Error('WORKING_FILE_OBJECT_NOT_FOUND');
    }
    return transaction.fileObject.upsert({
      where: { projectId_storageKey: { projectId, storageKey: input.storageKey } },
      create: {
        ...(input.id ? { id: input.id } : {}),
        projectId,
        workflowRunId,
        nodeId: input.nodeId,
        originalFileName: input.originalFileName,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        storageKey: input.storageKey,
        sha256: input.sha256,
      },
      update: {
        nodeId: input.nodeId,
        originalFileName: input.originalFileName,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        sha256: input.sha256,
        status: 'AVAILABLE',
        orphanedAt: null,
      },
    });
  }

  async upsertArtifact(
    projectId: string,
    workflowRunId: string,
    nodeId: string,
    artifactKey: string,
    input: WorkingArtifactUpsertInput,
  ): Promise<{
    record: WorkingArtifactRecord;
    previousStorageKey: string | null;
    unchanged: boolean;
    orphanedFileObjectIds: string[];
  }> {
    return this.prisma.$transaction((transaction) =>
      this.upsertArtifactInTransaction(
        transaction,
        projectId,
        workflowRunId,
        nodeId,
        artifactKey,
        input,
      ),
    );
  }

  async upsertArtifactInTransaction(
    transaction: Prisma.TransactionClient,
    projectId: string,
    workflowRunId: string,
    nodeId: string,
    artifactKey: string,
    input: WorkingArtifactUpsertInput,
    invalidateDependents = true,
    validationReads?: ArtifactValidationReadCache,
  ): Promise<{
    record: WorkingArtifactRecord;
    previousStorageKey: string | null;
    unchanged: boolean;
    orphanedFileObjectIds: string[];
  }> {
    const run = await transaction.workflowRun.findFirst({
      where: { id: workflowRunId, projectId, status: { in: [...openRunStatuses] } },
    });
    if (!run) throw new Error('WORKFLOW_RUN_NOT_FOUND');
    const captureEffectRevision =
      (run.workflow === 'EFFECT' && run.workflowSpace === 'EFFECT') ||
      (run.workflow === 'CUSTOMIZED' &&
        run.workflowSpace === 'CUSTOMIZED_PROJECT' &&
        nodeId === 'STORYBOARD');
    const unique = { projectId, workflowRunId, nodeId, artifactKey };
    const previous = await transaction.workingArtifact.findUnique({
      where: { projectId_workflowRunId_nodeId_artifactKey: unique },
      include: workingArtifactInclude,
    });
    await this.validateArtifactInputsInTransaction(
      transaction,
      projectId,
      workflowRunId,
      input,
      nodeId,
      validationReads,
    );
    const contentHash = workingArtifactContentHash(input);
    if (previous?.contentHash === contentHash)
      return {
        record: previous,
        previousStorageKey: previous.storageKey,
        unchanged: true,
        orphanedFileObjectIds: [],
      };
    if (previous && persistedArtifactHash(previous) === contentHash) {
      // Compatibility normalization for migrated rows whose initial hash was calculated
      // before FileObject SHA-256 values were available. Do not touch updatedAt/revision.
      await transaction.$executeRaw(
        Prisma.sql`UPDATE "working_artifacts" SET "contentHash" = ${contentHash} WHERE "id" = ${previous.id}::uuid`,
      );
      return {
        record: { ...previous, contentHash },
        previousStorageKey: previous.storageKey,
        unchanged: true,
        orphanedFileObjectIds: [],
      };
    }
    const data = {
      kind: input.kind,
      name: input.name,
      directory: input.directory,
      type: input.type,
      tags: input.tags ?? [],
      payload: jsonValue(input.payload),
      metadata: jsonValue(input.metadata),
      originalFileName: input.originalFileName ?? null,
      mimeType: input.mimeType ?? null,
      sizeBytes: input.sizeBytes ?? null,
      storageKey: input.storageKey ?? null,
      sourceRunId: input.sourceRunId ?? null,
      sourceArtifactId: input.sourceArtifactId ?? null,
      contentHash,
      freshness: 'CURRENT' as const,
      availability: 'AVAILABLE' as const,
    };
    if (input.expectedRevision !== undefined && previous?.revision !== input.expectedRevision)
      throw new Error('WORKING_ARTIFACT_REVISION_CONFLICT');
    let baseRecord;
    if (previous) {
      const changed = await transaction.workingArtifact.updateMany({
        where: { id: previous.id, revision: previous.revision },
        data: { ...data, revision: { increment: 1 } },
      });
      if (changed.count === 0) throw new Error('WORKING_ARTIFACT_REVISION_CONFLICT');
      baseRecord = await transaction.workingArtifact.findUniqueOrThrow({
        where: { id: previous.id },
      });
    } else {
      if (input.expectedRevision !== undefined && input.expectedRevision !== 0)
        throw new Error('WORKING_ARTIFACT_REVISION_CONFLICT');
      baseRecord = await transaction.workingArtifact.create({
        data: { projectId, workflowRunId, nodeId, artifactKey, ...data },
      });
    }
    if (previous && captureEffectRevision)
      await this.persistArtifactRevisionSnapshotInTransaction(
        transaction,
        projectId,
        workflowRunId,
        nodeId,
        artifactKey,
        previous,
        previous.updatedAt ?? previous.createdAt ?? new Date(),
      );
    const previousFileIds = previous?.files.map((item) => item.fileObjectId) ?? [];
    await transaction.workingArtifactFile.deleteMany({
      where: { projectId, workingArtifactId: baseRecord.id },
    });
    if (input.files?.length)
      await transaction.workingArtifactFile.createMany({
        data: input.files.map((file) => ({
          projectId,
          workflowRunId,
          workingArtifactId: baseRecord.id,
          fileObjectId: file.fileObjectId,
          role: file.role,
          sortOrder: file.sortOrder,
        })),
      });
    await transaction.workingArtifactDependency.deleteMany({
      where: { projectId, dependentArtifactId: baseRecord.id },
    });
    if (input.dependencies?.length)
      await transaction.workingArtifactDependency.createMany({
        data: input.dependencies.map((dependency) => ({
          projectId,
          workflowRunId,
          dependentArtifactId: baseRecord.id,
          sourceType: dependency.sourceType,
          sourceNodeId: dependency.sourceNodeId ?? null,
          sourceArtifactId: dependency.sourceArtifactId ?? null,
          sourceKey: dependency.sourceKey,
          sourceRevision: dependency.sourceRevision ?? null,
          sourceHash: dependency.sourceHash ?? null,
        })),
      });
    if (input.files?.length)
      await transaction.fileObject.updateMany({
        where: { projectId, id: { in: input.files.map((file) => file.fileObjectId) } },
        data: { status: 'AVAILABLE', orphanedAt: null },
      });
    const currentFileIds = new Set(input.files?.map((item) => item.fileObjectId) ?? []);
    const replacedFileObjectIds = previousFileIds.filter((id) => !currentFileIds.has(id));
    const orphanedFileObjectIds: string[] = [];
    for (const fileObjectId of replacedFileObjectIds) {
      const [artifactLinks, revisionLinks, materials, uploadItems] = await Promise.all([
        transaction.workingArtifactFile.count({ where: { projectId, fileObjectId } }),
        transaction.workingArtifactRevisionFile.count({ where: { projectId, fileObjectId } }),
        transaction.effectImportMaterial.count({ where: { projectId, fileObjectId } }),
        transaction.effectImportUploadItem.count({ where: { projectId, fileObjectId } }),
      ]);
      const packagingFiles = await transaction.effectPackagingFile.count({
        where: { projectId, fileObjectId },
      });
      if (artifactLinks + revisionLinks + materials + uploadItems + packagingFiles === 0)
        orphanedFileObjectIds.push(fileObjectId);
    }
    if (orphanedFileObjectIds.length)
      await transaction.fileObject.updateMany({
        where: { projectId, id: { in: orphanedFileObjectIds }, finalOutputItems: { none: {} } },
        data: { status: 'ORPHANED', orphanedAt: new Date() },
      });
    if (previous && invalidateDependents)
      await this.markArtifactDependentsStaleInTransaction(
        transaction,
        projectId,
        workflowRunId,
        previous.id,
      );
    const record = await transaction.workingArtifact.findUniqueOrThrow({
      where: { id: baseRecord.id },
      include: workingArtifactInclude,
    });
    if (captureEffectRevision)
      await this.persistArtifactRevisionSnapshotInTransaction(
        transaction,
        projectId,
        workflowRunId,
        nodeId,
        artifactKey,
        record,
        new Date(),
      );
    return {
      record,
      previousStorageKey: previous?.storageKey ?? null,
      unchanged: false,
      orphanedFileObjectIds,
    };
  }

  private async persistArtifactRevisionSnapshotInTransaction(
    transaction: Prisma.TransactionClient,
    projectId: string,
    workflowRunId: string,
    nodeId: string,
    artifactKey: string,
    record: WorkingArtifactRecord,
    confirmedAt: Date,
  ): Promise<void> {
    const snapshot = await transaction.workingArtifactRevisionSnapshot.upsert({
      where: {
        projectId_workflowRunId_nodeId_artifactKey_revision: {
          projectId,
          workflowRunId,
          nodeId,
          artifactKey,
          revision: record.revision,
        },
      },
      create: {
        projectId,
        workflowRunId,
        workingArtifactId: record.id,
        nodeId,
        artifactKey,
        revision: record.revision,
        contentHash: record.contentHash,
        snapshot: artifactRevisionSnapshot(record),
        confirmedAt,
      },
      update: {},
      select: { id: true },
    });
    if (record.files.length)
      await transaction.workingArtifactRevisionFile.createMany({
        data: record.files.map((file) => ({
          projectId,
          workflowRunId,
          snapshotId: snapshot.id,
          fileObjectId: file.fileObjectId,
          role: file.role,
          sortOrder: file.sortOrder,
        })),
        skipDuplicates: true,
      });
  }

  async commitValidatedArtifacts(
    projectId: string,
    workflowRunId: string,
    nodeId: string,
    artifacts: Array<{
      artifactKey: string;
      input: WorkingArtifactUpsertInput;
      invalidateDependents?: boolean;
    }>,
    frozenRenderSources?: readonly EffectTemplateMixMaterial[],
  ) {
    // A batch can confirm dozens of timelines. The default five-second budget is not
    // suitable for atomic dependency checks plus revision snapshots. Retry only errors
    // whose failed transaction has rolled back, never business/version conflicts.
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.prisma.$transaction(
          (transaction) =>
            this.commitValidatedArtifactsInTransaction(
              transaction,
              projectId,
              workflowRunId,
              nodeId,
              artifacts,
              frozenRenderSources,
            ),
          { timeout: 120_000 },
        );
      } catch (error) {
        if (
          attempt > 0 ||
          !(error instanceof Prisma.PrismaClientKnownRequestError) ||
          !['P2028', 'P2034'].includes(error.code)
        )
          throw error;
      }
    }
  }

  async commitValidatedArtifactsInTransaction(
    transaction: Prisma.TransactionClient,
    projectId: string,
    workflowRunId: string,
    nodeId: string,
    artifacts: Array<{
      artifactKey: string;
      input: WorkingArtifactUpsertInput;
      invalidateDependents?: boolean;
    }>,
    frozenRenderSources?: readonly EffectTemplateMixMaterial[],
    frozenPromptSources?: readonly FrozenRenderPromptSource[],
  ) {
    const results = [];
    const validationReads: ArtifactValidationReadCache | undefined = [
      'TEMPLATE_MIX',
      'FINAL_OUTPUT',
      'SEGMENT_RENDER',
    ].includes(nodeId)
      ? {
          ...(frozenRenderSources ? { frozenRenderSources } : {}),
          ...(nodeId === 'SEGMENT_RENDER' && frozenPromptSources ? { frozenPromptSources } : {}),
        }
      : undefined;
    for (const artifact of artifacts) {
      const result = await this.upsertArtifactInTransaction(
        transaction,
        projectId,
        workflowRunId,
        nodeId,
        artifact.artifactKey,
        artifact.input,
        artifact.invalidateDependents ?? true,
        validationReads,
      );
      results.push({ artifactKey: artifact.artifactKey, ...result });
    }
    return results;
  }

  private async validateArtifactInputsInTransaction(
    transaction: Prisma.TransactionClient,
    projectId: string,
    workflowRunId: string,
    input: WorkingArtifactUpsertInput,
    nodeId?: string,
    validationReads: ArtifactValidationReadCache = {},
  ): Promise<void> {
    const lineage: Array<{ runId: string; crossedForks: EffectForkScope[] }> = [
      { runId: workflowRunId, crossedForks: [] },
    ];
    const visited = new Set([workflowRunId]);
    let current = await transaction.workflowRun.findFirst({
      where: { projectId, id: workflowRunId },
    });
    const effectRun = current?.workflow === 'EFFECT' && current.workflowSpace === 'EFFECT';
    const sharedRenderSources = (): Promise<WorkingArtifactRecord[]> =>
      (validationReads.sharedRenderSources ??= effectRun
        ? new WorkflowWorkingRepository(transaction as unknown as PrismaService)
            .listArtifacts(projectId, { workflowRunId, nodeId: 'SEGMENT_RENDER' })
            .then((rows) =>
              rows.filter(
                (row) =>
                  row.freshness === 'CURRENT' &&
                  row.availability === 'AVAILABLE' &&
                  (row.metadata as { branchSourceOwner?: boolean } | null)?.branchSourceOwner ===
                    true,
              ),
            )
        : Promise.resolve([]));
    while (
      current?.workflow === 'EFFECT' &&
      current.workflowSpace === 'EFFECT' &&
      current.parentWorkflowRunId &&
      !visited.has(current.parentWorkflowRunId)
    ) {
      const parent = await transaction.workflowRun.findFirst({
        where: {
          projectId,
          id: current.parentWorkflowRunId,
          workflow: 'EFFECT',
          workflowSpace: 'EFFECT',
        },
      });
      if (!parent) break;
      visited.add(parent.id);
      lineage.push({
        runId: parent.id,
        crossedForks: [
          ...lineage[lineage.length - 1]!.crossedForks,
          { forkNodeId: current.forkNodeId, forkTemplateId: current.forkTemplateId },
        ],
      });
      current = parent;
    }
    const allowedRunIds = lineage.map(({ runId }) => runId);
    const fileIds = [...new Set(input.files?.map((file) => file.fileObjectId) ?? [])];
    if (fileIds.length) {
      const count = await transaction.fileObject.count({
        where: { projectId, workflowRunId: { in: allowedRunIds }, id: { in: fileIds } },
      });
      if (count !== fileIds.length) {
        const sharedFiles = new Set(
          (await sharedRenderSources()).flatMap((row) =>
            row.files.map((file) => file.fileObjectId),
          ),
        );
        const ordinary = await transaction.fileObject.findMany({
          where: { projectId, workflowRunId: { in: allowedRunIds }, id: { in: fileIds } },
          select: { id: true },
        });
        if (fileIds.some((id) => !sharedFiles.has(id) && !ordinary.some((file) => file.id === id)))
          throw new Error('WORKING_FILE_OBJECT_NOT_FOUND');
      }
    }
    for (const dependency of input.dependencies ?? []) {
      if (dependency.sourceType === 'WORKING_ARTIFACT') {
        const frozenPrompt =
          nodeId === 'SEGMENT_RENDER' &&
          validationReads.frozenPromptSources?.find(
            (source) =>
              source.artifactId === dependency.sourceArtifactId &&
              source.artifactKey === dependency.sourceKey &&
              source.revision === dependency.sourceRevision &&
              source.contentHash === dependency.sourceHash,
          );
        if (frozenPrompt && frozenPrompt.artifactKey.startsWith('prompt-batch:')) {
          // A shared pool may adopt a Prompt saved in a later mix/output branch. Only frozen
          // task inputs can cross this boundary, and only inside the same confirmed render head.
          let frozenRunIds = allowedRunIds;
          let source = await transaction.workingArtifact.findFirst({
            where: {
              projectId,
              workflowRunId: { in: frozenRunIds },
              id: frozenPrompt.artifactId,
              nodeId: 'PROMPT_GENERATION',
              artifactKey: frozenPrompt.artifactKey,
              availability: 'AVAILABLE',
            },
          });
          if (!source && effectRun) {
            frozenRunIds = await (validationReads.sharedPromptRunIds ??= transaction.workflowRun
              .findMany({
                where: { projectId, workflow: 'EFFECT', workflowSpace: 'EFFECT' },
                select: {
                  id: true,
                  parentWorkflowRunId: true,
                  forkNodeId: true,
                  branchPublishedAt: true,
                },
              })
              .then((branches) => {
                const head = effectRenderHead(branches, workflowRunId);
                return [
                  ...new Set([
                    ...allowedRunIds,
                    ...branches
                      .filter(
                        (branch) =>
                          branch.branchPublishedAt &&
                          effectRenderHead(branches, branch.id) === head,
                      )
                      .map((branch) => branch.id),
                  ]),
                ];
              }));
            source = await transaction.workingArtifact.findFirst({
              where: {
                projectId,
                workflowRunId: { in: frozenRunIds },
                id: frozenPrompt.artifactId,
                nodeId: 'PROMPT_GENERATION',
                artifactKey: frozenPrompt.artifactKey,
                availability: 'AVAILABLE',
              },
            });
          }
          if (!source) throw new Error('WORKING_ARTIFACT_DEPENDENCY_CONFLICT');
          if (
            source.revision === frozenPrompt.revision &&
            source.contentHash === frozenPrompt.contentHash
          )
            continue;
          // Edit copies remap artifact IDs. Recover history only through explicit clone provenance,
          // never by matching prompt text, product name or a sibling Run.
          const provenance = source.metadata as {
            branchSource?: { artifactId?: string; ancestorArtifactIds?: string[] };
          } | null;
          const history = await transaction.workingArtifactRevisionSnapshot.findFirst({
            where: {
              projectId,
              workflowRunId: { in: frozenRunIds },
              nodeId: 'PROMPT_GENERATION',
              workingArtifactId: {
                in: [
                  source.id,
                  ...(provenance?.branchSource?.artifactId
                    ? [provenance.branchSource.artifactId]
                    : []),
                  ...(provenance?.branchSource?.ancestorArtifactIds ?? []),
                ],
              },
              revision: frozenPrompt.revision,
              contentHash: frozenPrompt.contentHash,
            },
          });
          if (!history) throw new Error('WORKING_ARTIFACT_DEPENDENCY_CONFLICT');
          continue;
        }
        const frozen =
          nodeId === 'TEMPLATE_MIX' &&
          validationReads.frozenRenderSources?.find(
            (source) =>
              source.artifactId === dependency.sourceArtifactId &&
              source.artifactKey === dependency.sourceKey &&
              source.artifactRevision === dependency.sourceRevision &&
              source.artifactContentHash === dependency.sourceHash,
          );
        if (frozen && frozen.artifactKey.startsWith('render-clip:')) {
          const source = await transaction.workingArtifact.findFirst({
            where: {
              projectId,
              id: frozen.artifactId,
              nodeId: 'SEGMENT_RENDER',
              artifactKey: frozen.artifactKey,
            },
          });
          const file = await transaction.fileObject.findFirst({
            where: {
              projectId,
              id: frozen.fileObjectId,
              sha256: frozen.contentHash,
              status: 'AVAILABLE',
            },
          });
          // This private commit context is supplied only after the task's lease, scope and
          // engineering fences pass. It cannot be enabled by a draft/metadata property.
          if (!source || !file) throw new Error('WORKING_ARTIFACT_DEPENDENCY_CONFLICT');
          continue;
        }
        const candidates = await transaction.workingArtifact.findMany({
          where: {
            projectId,
            workflowRunId: { in: allowedRunIds },
            OR: [
              ...(dependency.sourceArtifactId ? [{ id: dependency.sourceArtifactId }] : []),
              {
                artifactKey: {
                  in: [
                    dependency.sourceKey,
                    dependency.sourceKey.replace('effective-video-config:', 'global-video-config:'),
                  ],
                },
              },
            ],
          },
        });
        const keyMatches = (candidate: { artifactKey: string }): boolean =>
          candidate.artifactKey === dependency.sourceKey ||
          (dependency.sourceKey.startsWith('effective-video-config:') &&
            candidate.artifactKey ===
              dependency.sourceKey.replace('effective-video-config:', 'global-video-config:'));
        const source = lineage
          .map(({ runId, crossedForks }) =>
            candidates.find(
              (candidate) =>
                candidate.workflowRunId === runId &&
                keyMatches(candidate) &&
                (crossedForks.length === 0 ||
                  inheritedEffectArtifactVisible(candidate, crossedForks)),
            ),
          )
          .find(Boolean);
        if (
          effectRun &&
          nodeId === 'TEMPLATE_MIX' &&
          source &&
          dependency.sourceKey.startsWith('render-clip:')
        ) {
          const media = source.payload as Prisma.JsonObject | null;
          if (typeof media?.promptId === 'string' && typeof media.fileObjectId === 'string') {
            const files = new Set(
              (await sharedRenderSources()).flatMap((candidate) => {
                const currentMedia = candidate.payload as Prisma.JsonObject | null;
                return currentMedia &&
                  currentMedia.promptId === media.promptId &&
                  typeof currentMedia.fileObjectId === 'string'
                  ? [currentMedia.fileObjectId]
                  : [];
              }),
            );
            // Recheck in the commit transaction: a source can change after draft validation or
            // a Worker can complete with a copied old CURRENT row. Same-file aliases remain valid.
            if (files.size && !files.has(media.fileObjectId))
              throw new Error('WORKING_ARTIFACT_DEPENDENCY_CONFLICT');
          }
        }
        if (!source || source.revision !== dependency.sourceRevision) {
          const shared = dependency.sourceKey.startsWith('render-clip:')
            ? (await sharedRenderSources()).find(
                (row) =>
                  row.id === dependency.sourceArtifactId &&
                  keyMatches(row) &&
                  row.revision === dependency.sourceRevision &&
                  (!dependency.sourceHash || row.contentHash === dependency.sourceHash),
              )
            : undefined;
          if (!shared) throw new Error('WORKING_ARTIFACT_DEPENDENCY_CONFLICT');
        }
      } else {
        const state = await transaction.workflowNodeState.findUnique({
          where: {
            projectId_workflowRunId_nodeId: {
              projectId,
              workflowRunId,
              nodeId: dependency.sourceNodeId ?? dependency.sourceKey,
            },
          },
        });
        if (!state) throw new Error('WORKFLOW_NODE_STATE_DEPENDENCY_CONFLICT');
        if (dependency.sourceType === 'EXECUTION_INPUT') {
          // Prompt results keep the generation input hash as provenance. The
          // mutable settings draft is for a future batch; Prompt task/commit
          // validation checks that draft separately before automatic submission.
          if (
            nodeId === 'PROMPT_GENERATION' &&
            dependency.sourceKey.startsWith('PROMPT_GENERATION:') &&
            dependency.sourceHash
          )
            continue;
          if (!dependency.sourceHash || state.executionInputHash !== dependency.sourceHash)
            throw new Error('WORKFLOW_EXECUTION_INPUT_DEPENDENCY_CONFLICT');
        } else if (state.revision !== dependency.sourceRevision)
          throw new Error('WORKFLOW_NODE_STATE_DEPENDENCY_CONFLICT');
      }
    }
  }

  private async markNodeDependentsStaleInTransaction(
    transaction: Prisma.TransactionClient,
    projectId: string,
    workflowRunId: string,
    nodeId: string,
  ): Promise<void> {
    // Prompt settings describe a future generation attempt, not a new confirmed
    // batch. Keep the recorded execution hash for provenance/claim validation,
    // but invalidate delivered clips only when the confirmed artifact changes.
    if (nodeId.startsWith('PROMPT_GENERATION:')) return;
    const dependencies = await transaction.workingArtifactDependency.findMany({
      where: {
        projectId,
        workflowRunId,
        sourceType: 'EXECUTION_INPUT',
        OR: [{ sourceNodeId: nodeId }, { sourceKey: nodeId }],
      },
      select: { dependentArtifactId: true },
    });
    await this.markArtifactIdsAndDependentsStaleInTransaction(
      transaction,
      projectId,
      workflowRunId,
      dependencies.map((item) => item.dependentArtifactId),
    );
  }

  private async markArtifactDependentsStaleInTransaction(
    transaction: Prisma.TransactionClient,
    projectId: string,
    workflowRunId: string,
    sourceArtifactId: string,
  ): Promise<void> {
    const dependencies = await transaction.workingArtifactDependency.findMany({
      where: { projectId, sourceType: 'WORKING_ARTIFACT', sourceArtifactId },
      select: { dependentArtifactId: true },
    });
    await this.markArtifactIdsAndDependentsStaleInTransaction(
      transaction,
      projectId,
      workflowRunId,
      dependencies.map((item) => item.dependentArtifactId),
    );
  }

  async markArtifactIdsAndDependentsStaleInTransaction(
    transaction: Prisma.TransactionClient,
    projectId: string,
    workflowRunId: string,
    initialIds: string[],
  ): Promise<void> {
    const seen = new Set<string>();
    let pending = [...new Set(initialIds)];
    while (pending.length) {
      const current = pending.filter((id) => !seen.has(id));
      if (!current.length) break;
      current.forEach((id) => seen.add(id));
      await transaction.workingArtifact.updateMany({
        where: { projectId, id: { in: current } },
        data: { freshness: 'STALE' },
      });
      const next = await transaction.workingArtifactDependency.findMany({
        where: {
          projectId,
          sourceType: 'WORKING_ARTIFACT',
          sourceArtifactId: { in: current },
        },
        select: { dependentArtifactId: true },
      });
      pending = next.map((item) => item.dependentArtifactId);
    }
  }

  deleteArtifact(projectId: string, workflowRunId: string, nodeId: string, artifactKey: string) {
    return this.prisma.$transaction(async (transaction) => {
      const record = await transaction.workingArtifact.findUnique({
        where: {
          projectId_workflowRunId_nodeId_artifactKey: {
            projectId,
            workflowRunId,
            nodeId,
            artifactKey,
          },
        },
        include: workingArtifactInclude,
      });
      if (record) {
        const run = await transaction.workflowRun.findFirst({
          where: { projectId, id: workflowRunId },
        });
        if (run?.workflow === 'EFFECT' && run.workflowSpace === 'EFFECT')
          await this.persistArtifactRevisionSnapshotInTransaction(
            transaction,
            projectId,
            workflowRunId,
            nodeId,
            artifactKey,
            record,
            record.updatedAt,
          );
        await this.markArtifactDependentsStaleInTransaction(
          transaction,
          projectId,
          workflowRunId,
          record.id,
        );
        await transaction.workingArtifact.delete({ where: { id: record.id } });
        const fileObjectIds = record.files.map((item) => item.fileObjectId);
        if (fileObjectIds.length)
          await transaction.fileObject.updateMany({
            where: {
              projectId,
              id: { in: fileObjectIds },
              packagingFiles: { none: {} },
              revisionLinks: { none: {} },
              finalOutputItems: { none: {} },
              voicePreviews: { none: {} },
            },
            data: { status: 'ORPHANED', orphanedAt: new Date() },
          });
      }
      return record;
    });
  }

  enqueueCleanup(projectId: string, storageKey: string, reason: string) {
    const nextAttemptAt = new Date(Date.now() + cleanupGraceMs());
    return this.prisma.storageCleanupTask.upsert({
      where: { projectId_storageKey: { projectId, storageKey } },
      create: {
        projectId,
        storageKey,
        reason,
        nextAttemptAt,
      },
      update: {
        reason,
        nextAttemptAt,
      },
    });
  }
}
