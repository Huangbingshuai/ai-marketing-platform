import type {
  EffectTemplateMixDraft,
  EffectWorkflowEditableNodeId,
  FinalOutputSnapshot,
} from '@ai-marketing/contracts';
import { randomUUID } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { workflowStateHash } from './workflow-state-hash';
import {
  cloneMixAiRunsInTransaction,
  clonePackagingRunsInTransaction,
  remapIds as remap,
} from './effect-branch-clone';
import {
  workingArtifactContentHash,
  workingArtifactInclude,
  type WorkingArtifactUpsertInput,
} from './workflow-working.repository';
import { visualHash } from '../../workflows/effect/template-mix/effect-packaging.domain';
import { confirmedEffectPromptEditSource, confirmedEffectRenderSourceRun } from './effect-render-source-context';

type Tx = Prisma.TransactionClient;
type IdMap = Record<string, string>;

const stageOrder: EffectWorkflowEditableNodeId[] = [
  'SOURCE_IMPORT',
  'INFORMATION_EXTRACTION',
  'PROMPT_GENERATION',
  'SEGMENT_RENDER',
  'TEMPLATE_MIX',
  'FINAL_OUTPUT',
];
/** One stage can own several artifact families; the mix node keeps templates, timelines and packages. */
const artifactPrefix: Record<EffectWorkflowEditableNodeId, readonly string[]> = {
  SOURCE_IMPORT: ['source-package:'],
  INFORMATION_EXTRACTION: ['marketing-insight:'],
  PROMPT_GENERATION: ['prompt-batch:'],
  SEGMENT_RENDER: ['render-batch:'],
  TEMPLATE_MIX: ['mix-template:', 'timeline-project:', 'timeline-package:'],
  FINAL_OUTPUT: ['final-video:', 'final-delivery:'],
};
const artifactKeyWhere = (nodeId: EffectWorkflowEditableNodeId) => ({
  OR: artifactPrefix[nodeId].map((prefix) => ({ artifactKey: { startsWith: prefix } })),
});
export const effectEditStageCopyPolicy = (
  nodeId: EffectWorkflowEditableNodeId,
  purpose: 'MANUAL' | 'BATCH',
) => {
  const resetsSegmentRender = nodeId === 'SEGMENT_RENDER' && purpose === 'BATCH';
  return {
    adoptConfirmedRenderSource: !resetsSegmentRender,
    copyRenderBatches: !resetsSegmentRender,
    copyCurrentStageArtifacts: !resetsSegmentRender,
  };
};

export const effectEditArtifactStages = (
  nodeId: EffectWorkflowEditableNodeId,
  purpose: 'MANUAL' | 'BATCH',
  preservePackagingBaseline = false,
): EffectWorkflowEditableNodeId[] => {
  const index = stageOrder.indexOf(nodeId);
  // A fresh fill owns new pictures. A fresh package instead retains confirmed pictures/audio
  // until each replacement commits, including films whose new package ultimately fails.
  const keepCurrent = index < 4 && effectEditStageCopyPolicy(nodeId, purpose).copyCurrentStageArtifacts ||
    nodeId === 'TEMPLATE_MIX' && preservePackagingBaseline;
  return stageOrder.slice(0, index + (keepCurrent ? 1 : 0));
};
const json = (value: unknown): Prisma.InputJsonValue =>
  (value === undefined || value === null ? {} : value) as Prisma.InputJsonValue;

/** New branch rows have no consumers before this transaction commits. Write their final
 * frozen snapshots once, after the artifact ID/hash map is complete, rather than insert,
 * read back and update every task individually. Do not regenerate provider work. */
export async function insertEffectRenderBranchTasks(
  tx: Tx,
  rows: Prisma.EffectSegmentRenderTaskCreateManyInput[],
  artifactReplacements: IdMap,
): Promise<void> {
  if (!rows.length) return;
  await tx.effectSegmentRenderTask.createMany({ data: rows.map((row) => ({
    ...row,
    requestSnapshot: json(remap(row.requestSnapshot, artifactReplacements)),
    generationRequestSnapshot: json(remap(row.generationRequestSnapshot, artifactReplacements)),
  })) });
}

export const effectEditNodeStateWhere = (
  projectId: string, parentRunId: string, stage: EffectWorkflowEditableNodeId, sourceRunId: string,
): Prisma.WorkflowNodeStateWhereInput => ({
  projectId,
  OR: [
    { workflowRunId: sourceRunId, OR: [{ nodeId: stage }, { nodeId: { startsWith: `${stage}:` } }] },
    ...(stage === 'SEGMENT_RENDER' ? [{ workflowRunId: parentRunId,
      nodeId: { startsWith: 'SEGMENT_RENDER_SETTINGS:' } }] : []),
  ],
});
const stageDigest = async (
  tx: Tx,
  projectId: string,
  runId: string,
  nodeId: EffectWorkflowEditableNodeId,
): Promise<string> => {
  const artifacts = await tx.workingArtifact.findMany({
    where: {
      projectId,
      workflowRunId: runId,
      nodeId,
      availability: 'AVAILABLE',
      ...artifactKeyWhere(nodeId),
    },
    select: { artifactKey: true, contentHash: true },
    orderBy: { artifactKey: 'asc' },
  });
  return workflowStateHash(artifacts);
};

export type EffectEditBeginRecord = {
  runId: string;
  parentWorkflowRunId: string | null;
  productIdMap: IdMap;
  taskIdMap: IdMap;
  created: boolean;
};

export type EffectEditBeginOptions = {
  /**
   * Regenerating the mix or output node always opens a branch, even when the node has no confirmed
   * version yet: every successful fill, packaging or export is a version of its own, so the run that
   * triggered it must not be rewritten in place. The upstream four nodes keep the initial-version
   * rule because their first result is the version, not a new one.
   *
   * Such a branch is never an edit session: the user has nothing to save, publish or cancel, and the
   * task publishes the branch itself the moment it succeeds. It therefore carries no session fields,
   * which is also what keeps the editor from showing an unpublished draft it cannot act on.
   */
  always?: boolean;
  /** Run an automatic child task in the background while its published parent stays active. */
  keepParentActive?: boolean;
  /** Fresh packaging retains the complete previous package as its transactional rollback baseline. */
  preservePackagingBaseline?: boolean;
  /** Reuse the same background child when a task request is retried. */
  creationKey?: string;
  /** Internal creation fence for the exact parent node draft frozen by the caller. */
  expectedNodeStateRevision?: number;
  /** Template-local mix/output branches only show the template that produced this version. */
  templateId?: string;
  /** Internal task scope: caller resolved the template tip, and freezes the global pointer. */
  templateScopeActiveRunId?: string;
};

/** Clone the mutable domain workspace before any edit or paid task is allowed to run. */
export async function beginEffectEditInTransaction(
  tx: Tx,
  projectId: string,
  parentRunId: string,
  nodeId: EffectWorkflowEditableNodeId,
  purpose: 'MANUAL' | 'BATCH' = 'MANUAL',
  options: EffectEditBeginOptions = {},
): Promise<EffectEditBeginRecord | null> {
  await tx.$queryRaw(
    Prisma.sql`SELECT "id" FROM "projects" WHERE "id" = ${projectId}::uuid FOR UPDATE`,
  );
  const parent = await tx.workflowRun.findFirst({
    where: {
      projectId,
      id: parentRunId,
      workflow: 'EFFECT',
      workflowSpace: 'EFFECT',
      status: { in: ['ACTIVE', 'PAUSED'] },
    },
  });
  if (!parent) return null;
  if (options.expectedNodeStateRevision !== undefined) {
    await tx.$queryRaw`SELECT "id" FROM "workflow_node_states"
      WHERE "projectId"=${projectId}::uuid AND "workflowRunId"=${parent.id}::uuid
        AND "nodeId"=${nodeId} FOR UPDATE`;
    const state = await tx.workflowNodeState.findUnique({ where: {
      projectId_workflowRunId_nodeId: { projectId, workflowRunId: parent.id, nodeId },
    } });
    if (!state || state.revision !== options.expectedNodeStateRevision)
      throw new ConflictException('包装前原工程已改变，请刷新后重试');
  }
  const active = await tx.workflowRun.findFirst({
    where: { projectId, workflow: 'EFFECT', workflowSpace: 'EFFECT', activeKey: 'ACTIVE' },
  });
  // A replay must respect the same frozen global pointer as a newly cloned package.
  if (nodeId === 'TEMPLATE_MIX' && options.preservePackagingBaseline &&
      options.templateScopeActiveRunId &&
      (active?.id !== options.templateScopeActiveRunId || active.editSessionNodeId)) return null;
  if (options.creationKey) {
    const existing = await tx.workflowRun.findFirst({
      where: {
        projectId,
        workflow: 'EFFECT',
        workflowSpace: 'EFFECT',
        branchCreationKey: options.creationKey,
      },
    });
    if (existing) {
      if (existing.parentWorkflowRunId !== parent.id || existing.forkNodeId !== nodeId) return null;
      return {
        runId: existing.id,
        parentWorkflowRunId: parent.id,
        productIdMap: {},
        taskIdMap: {},
        created: false,
      };
    }
  }
  // An auto branch opened no session, so it is recognised by the fork it was created for instead.
  // A caller that keeps asking for a branch of its own reuses the one it already has; every other
  // caller is turned away exactly as before.
  const isOwnAutoBranch = (run: {
    forkNodeId: string | null;
    forkTemplateId: string | null;
    editSessionNodeId: string | null;
  }) =>
    Boolean(options.always) &&
    run.editSessionNodeId === null &&
    run.forkNodeId === nodeId &&
    (!options.templateId || run.forkTemplateId === options.templateId);
  const isOwnSession = (run: {
    editSessionNodeId: string | null;
    editSessionPurpose: string | null;
  }) => run.editSessionNodeId === nodeId && run.editSessionPurpose === purpose;
  // A frozen render draft can host a nested Prompt manual edit. Saving/cancelling that
  // child returns to the still-running render draft; its tasks are never cloned or cancelled.
  const nestedPromptEdit = nodeId === 'PROMPT_GENERATION' && purpose === 'MANUAL' &&
    !options.always && parent.editSessionNodeId === 'SEGMENT_RENDER' &&
    parent.editSessionPurpose === 'MANUAL' && active?.id === parent.id &&
    (parent.editIdMap as { frozenPromptRefresh?: boolean } | null)?.frozenPromptRefresh === true;
  if (parent.parentWorkflowRunId && !parent.branchPublishedAt) {
    if (!isOwnSession(parent) && !isOwnAutoBranch(parent) && !nestedPromptEdit) return null;
    if (!nestedPromptEdit) {
    const map = (parent.editIdMap ?? {}) as { productIdMap?: IdMap; taskIdMap?: IdMap };
    return {
      runId: parent.id,
      parentWorkflowRunId: parent.parentWorkflowRunId,
      productIdMap: map.productIdMap ?? {},
      taskIdMap: map.taskIdMap ?? {},
      created: false,
    };
    }
  }
  if (
    active?.parentWorkflowRunId === parent.id &&
    !active.branchPublishedAt &&
    (isOwnSession(active) || isOwnAutoBranch(active))
  ) {
    const map = (active.editIdMap ?? {}) as { productIdMap?: IdMap; taskIdMap?: IdMap };
    return {
      runId: active.id,
      parentWorkflowRunId: parent.id,
      productIdMap: map.productIdMap ?? {},
      taskIdMap: map.taskIdMap ?? {},
      created: false,
    };
  }
  const templateScopedOutput = nodeId === 'FINAL_OUTPUT' && options.always &&
    options.templateId && Boolean(options.templateScopeActiveRunId) &&
    options.templateScopeActiveRunId === active?.id;
  const templateScopedPackaging = nodeId === 'TEMPLATE_MIX' && options.always &&
    options.keepParentActive && options.preservePackagingBaseline && options.templateId &&
    Boolean(options.templateScopeActiveRunId) && options.templateScopeActiveRunId === active?.id &&
    !active?.editSessionNodeId;
  if (active?.id !== parent.id && !templateScopedOutput && !templateScopedPackaging) return null;
  // The parent stays active during an independent full export. The project lock serializes
  // repeated clicks, so reuse only its unfinished output child, never a published version.
  if (nodeId === 'FINAL_OUTPUT' && options.always && options.keepParentActive && options.templateId) {
    const pending = await tx.workflowRun.findFirst({ where: {
      projectId, workflow: 'EFFECT', workflowSpace: 'EFFECT',
      parentWorkflowRunId: parent.id, forkNodeId: 'FINAL_OUTPUT',
      forkTemplateId: options.templateId, branchPublishedAt: null,
      editSessionNodeId: null,
      effectFinalOutputRuns: { some: { projectId, templateId: options.templateId,
        status: { in: ['PENDING_RENDER', 'QUEUED', 'RUNNING'] } } },
    }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
    if (pending) return { runId: pending.id, parentWorkflowRunId: parent.id,
      productIdMap: {}, taskIdMap: {}, created: false };
  }
  const stageIndex = stageOrder.indexOf(nodeId);
  const copyPolicy = effectEditStageCopyPolicy(nodeId, purpose);
  const stageSources = new Map<EffectWorkflowEditableNodeId, string>();
  for (const stage of stageOrder.slice(0, stageIndex + 1)) {
    let cursor = parent;
    const visited = new Set<string>();
    while (!visited.has(cursor.id)) {
      visited.add(cursor.id);
      const present = await tx.workingArtifact.count({
        where: {
          projectId,
          workflowRunId: cursor.id,
          nodeId: stage,
          availability: 'AVAILABLE',
          ...artifactKeyWhere(stage),
        },
      });
      if (present) {
        stageSources.set(stage, cursor.id);
        break;
      }
      const forkIndex = stageOrder.indexOf(cursor.forkNodeId as EffectWorkflowEditableNodeId);
      if (!cursor.parentWorkflowRunId || forkIndex < 0 || stageOrder.indexOf(stage) >= forkIndex)
        break;
      const ancestor = await tx.workflowRun.findFirst({
        where: {
          projectId,
          id: cursor.parentWorkflowRunId,
          workflow: 'EFFECT',
          workflowSpace: 'EFFECT',
        },
      });
      if (!ancestor) break;
      cursor = ancestor;
    }
  }
  const viewingPromptRunId = stageSources.get('PROMPT_GENERATION') ?? parent.id;
  let promptEditBaseline: { source: { artifactId: string; revision: number; contentHash: string };
    target: { artifactId: string; revision: number; contentHash: string } } | undefined;
  let selectedPromptResultId: string | null = null;
  if (nodeId === 'SEGMENT_RENDER' && copyPolicy.adoptConfirmedRenderSource) {
    const sourceRunId = await confirmedEffectRenderSourceRun(tx, projectId, parent.id);
    if (sourceRunId !== parent.id) {
      stageSources.set('SEGMENT_RENDER', sourceRunId);
      // Use a coherent upstream snapshot for the adopted tasks. Equivalent copied stages have
      // reminted IDs/hashes; mixing them would falsely mark every old video as needing rendering.
      // A genuinely newer upstream revision must remain selected so its real change is visible.
      for (const stage of stageOrder.slice(0, 3)) {
        const currentRunId = stageSources.get(stage) ?? parent.id;
        const rows = await tx.workingArtifact.findMany({ where: { projectId, nodeId: stage,
          workflowRunId: { in: [currentRunId, sourceRunId] }, availability: 'AVAILABLE',
          ...artifactKeyWhere(stage) }, select: { workflowRunId: true, revision: true } });
        const fromSource = rows.filter((row) => row.workflowRunId === sourceRunId);
        const current = rows.filter((row) => row.workflowRunId === currentRunId);
        if (fromSource.length && Math.max(0, ...current.map((row) => row.revision)) <=
          Math.max(...fromSource.map((row) => row.revision))) stageSources.set(stage, sourceRunId);
      }
    }
  }
  if (nodeId === 'SEGMENT_RENDER' || nodeId === 'PROMPT_GENERATION') {
    // A merge may publish the newer pool into the parent while its adopted Prompt still
    // lives in a mix descendant. Use the same explicit source as reads/confirmation,
    // not the numeric revision of a reminted snapshot or the render owner's local copy.
    const prompts = await tx.workingArtifact.findMany({ where: {
      projectId, workflowRunId: viewingPromptRunId, nodeId: 'PROMPT_GENERATION',
      artifactKey: { startsWith: 'prompt-batch:' },
    } });
    // Current UI has one product. Legacy multi-product copies retain their original rule
    // rather than guessing a product by a label, count or an unrelated source's revision.
    if (prompts.length === 1) {
      const viewing = prompts[0]!;
      const selected = await confirmedEffectPromptEditSource(tx, projectId, parent.id, viewing);
      stageSources.set('PROMPT_GENERATION', selected.workflowRunId);
      if (nodeId === 'PROMPT_GENERATION' && purpose === 'MANUAL') {
        const identity = (artifact: typeof viewing) => ({ artifactId: artifact.id,
          revision: artifact.revision, contentHash: artifact.contentHash });
        promptEditBaseline = { source: identity(selected), target: identity(viewing) };
        selectedPromptResultId = selected.sourceArtifactId;
        // Copy exact upstream dependencies too: product/insight IDs are reminted per Run.
        // Mixing the adopted Prompt with the navigation snapshot would freeze broken input IDs.
        let dependent = selected;
        for (const stage of ['INFORMATION_EXTRACTION', 'SOURCE_IMPORT'] as const) {
          const dependencies = await tx.workingArtifactDependency.findMany({ where: {
            projectId, dependentArtifactId: dependent.id, sourceType: 'WORKING_ARTIFACT',
            sourceNodeId: stage,
          } });
          if (dependencies.length > 1) throw new ConflictException('Prompt 上游来源不明确，请刷新后重试');
          if (!dependencies.length) continue;
          const dependency = dependencies[0]!;
          const upstream = await tx.workingArtifact.findFirst({ where: {
            projectId, id: dependency.sourceArtifactId ?? '', nodeId: stage,
            ...(dependency.sourceRevision !== null ? { revision: dependency.sourceRevision } : {}),
            ...(dependency.sourceHash !== null ? { contentHash: dependency.sourceHash } : {}),
            availability: 'AVAILABLE',
          } });
          if (!upstream) throw new ConflictException('Prompt 上游已改变，请刷新后重试');
          stageSources.set(stage, upstream.workflowRunId);
          dependent = upstream;
        }
      }
    }
  }
  const confirmed = stageSources.has(nodeId);
  // The initial version is committed in the existing Run. There is no parent version to protect.
  // A caller that treats every regeneration as a version of its own opts out of that rule.
  if (!confirmed && !options.always)
    return {
      runId: parent.id,
      parentWorkflowRunId: null,
      productIdMap: {},
      taskIdMap: {},
      created: false,
    };
  const workspace = await tx.effectImportWorkspace.findFirst({
    where: { projectId, workflowRunId: parent.id },
    include: { drafts: { include: { products: true } } },
  });
  if (!workspace) return null;
  const child = await tx.workflowRun.create({
    data: {
      projectId,
      workflow: 'EFFECT',
      workflowSpace: 'EFFECT',
      status: 'ACTIVE',
      activeKey: null,
      parentWorkflowRunId: parent.id,
      forkNodeId: nodeId,
      forkTemplateId: options.templateId ?? null,
      branchCreationKey: options.creationKey ?? null,
      // An auto branch is not an edit session: nothing is left unpublished for the user to act on.
      editSessionNodeId: options.always ? null : nodeId,
      editSessionPurpose: options.always ? null : purpose,
      currentNodeId: nodeId,
    },
  });
  const ids: IdMap = { [parent.id]: child.id };
  const productIdMap: IdMap = {};
  const taskIdMap: IdMap = {};
  const renderTaskRows: Prisma.EffectSegmentRenderTaskCreateManyInput[] = [];
  const renderBatchRevisions: Record<string, number> = {};
  const renderEditSnapshot = (value: Prisma.JsonValue | null) => {
    const copy = remap(value, ids) as Record<string, unknown> | null;
    if (nodeId === 'SEGMENT_RENDER' && purpose === 'MANUAL' && copy) delete copy.refreshContext;
    return json(copy);
  };
  const clonedWorkspace = await tx.effectImportWorkspace.create({
    data: {
      projectId,
      workflowRunId: child.id,
      currentMode: workspace.currentMode,
      revision: workspace.revision,
    },
  });
  ids[workspace.id] = clonedWorkspace.id;
  for (const draft of workspace.drafts) {
    const clonedDraft = await tx.effectImportDraft.create({
      data: {
        projectId,
        workspaceId: clonedWorkspace.id,
        mode: draft.mode,
        status: draft.status,
        globalConfig: json(draft.globalConfig),
        revision: draft.revision,
        validatedRevision: draft.validatedRevision,
        validationIssues: json(draft.validationIssues),
        validatedAt: draft.validatedAt,
        completedAt: draft.completedAt,
      },
    });
    ids[draft.id] = clonedDraft.id;
    for (const product of draft.products) {
      const clonedProduct = await tx.effectImportProduct.create({
        data: {
          projectId,
          workflowRunId: child.id,
          draftId: clonedDraft.id,
          status: product.status,
          removedAt: product.removedAt,
          purgeAfter: product.purgeAfter,
          name: product.name,
          category: product.category,
          sku: product.sku,
          normalizedSku: product.normalizedSku,
          commerceUrl: product.commerceUrl,
          configOverride: json(product.configOverride),
          sortOrder: product.sortOrder,
        },
      });
      ids[product.id] = clonedProduct.id;
      productIdMap[product.id] = clonedProduct.id;
    }
  }
  const materials = await tx.effectImportMaterial.findMany({
    where: { projectId, workflowRunId: parent.id },
  });
  if (materials.length)
    await tx.effectImportMaterial.createMany({
      data: materials.map((item) => ({
        projectId,
        workflowRunId: child.id,
        productId: ids[item.productId]!,
        type: item.type,
        status: item.status,
        expectedFileName: item.expectedFileName,
        originalFileName: item.originalFileName,
        mimeType: item.mimeType,
        sizeBytes: item.sizeBytes,
        storageKey: item.storageKey,
        fileObjectId: item.fileObjectId,
        failureDisposition: item.failureDisposition,
        errorCode: item.errorCode,
        errorMessage: item.errorMessage,
        retryCount: item.retryCount,
        createdAt: item.createdAt,
      })),
    });
  for (const sourceRunId of new Set(stageSources.values())) {
    if (sourceRunId === parent.id) continue;
    const sourceWorkspace = await tx.effectImportWorkspace.findFirst({
      where: { projectId, workflowRunId: sourceRunId },
      include: { drafts: { include: { products: true } } },
    });
    if (!sourceWorkspace) throw new Error('EFFECT_EDIT_ANCESTOR_WORKSPACE_MISSING');
    ids[sourceWorkspace.id] = clonedWorkspace.id;
    for (const sourceDraft of sourceWorkspace.drafts) {
      const parentDraft = workspace.drafts.find((draft) => draft.mode === sourceDraft.mode);
      if (!parentDraft) throw new Error('EFFECT_EDIT_ANCESTOR_DRAFT_MISMATCH');
      ids[sourceDraft.id] = ids[parentDraft.id]!;
      for (const sourceProduct of sourceDraft.products) {
        const parentProduct = parentDraft.products.find(
          (product) =>
            product.sortOrder === sourceProduct.sortOrder &&
            product.normalizedSku === sourceProduct.normalizedSku,
        );
        if (!parentProduct) throw new Error('EFFECT_EDIT_ANCESTOR_PRODUCT_MISMATCH');
        ids[sourceProduct.id] = ids[parentProduct.id]!;
        productIdMap[sourceProduct.id] = ids[parentProduct.id]!;
      }
    }
  }
  if (stageIndex >= 1) {
    const extractionSourceRunId = stageSources.get('INFORMATION_EXTRACTION') ?? parent.id;
    const extractionSourceProducts = await tx.effectImportProduct.findMany({
      where: {
        projectId,
        workflowRunId: extractionSourceRunId,
      },
      select: { id: true },
    });
    const extractionRuns = await tx.effectExtractionRun.findMany({
      where: {
        projectId,
        productId: { in: extractionSourceProducts.map((item) => item.id) },
        status: 'COMPLETED',
        result: { isNot: null },
      },
      include: { result: true, branches: true },
      orderBy: { createdAt: 'desc' },
    });
    const seen = new Set<string>();
    for (const source of extractionRuns) {
      if (seen.has(source.productId)) continue;
      seen.add(source.productId);
      const run = await tx.effectExtractionRun.create({
        data: {
          projectId,
          draftId: ids[source.draftId]!,
          productId: ids[source.productId]!,
          requestRevision: source.requestRevision,
          idempotencyKey: `edit:${child.id}:extraction:${source.id}`,
          requestHash: source.requestHash,
          sourceFingerprint: source.sourceFingerprint,
          inputSnapshot: json(remap(source.inputSnapshot, ids)),
          status: 'COMPLETED',
          progress: 100,
          warnings: json(source.warnings),
          completedAt: source.completedAt,
        },
      });
      ids[source.id] = run.id;
      if (source.result) {
        const result = await tx.effectExtractionResult.create({
          data: {
            projectId,
            draftId: ids[source.draftId]!,
            productId: ids[source.productId]!,
            runId: run.id,
            schemaVersion: source.result.schemaVersion,
            generatedResult: json(remap(source.result.generatedResult, ids)),
            draftResult: json(remap(source.result.draftResult, ids)),
            manualOverrides: json(remap(source.result.manualOverrides, ids)),
            provenance: json(remap(source.result.provenance, ids)),
            conflictReport: json(remap(source.result.conflictReport, ids)),
            sourceFingerprint: source.result.sourceFingerprint,
            revision: source.result.revision,
            savedAt: source.result.savedAt,
          },
        });
        ids[source.result.id] = result.id;
      }
      if (source.branches.length)
        await tx.effectExtractionBranchOutput.createMany({
          data: source.branches.map((branch) => ({
            projectId,
            runId: run.id,
            branch: branch.branch,
            status: branch.status,
            ...(branch.structuredOutput
              ? {
                  structuredOutput: json(remap(branch.structuredOutput, ids)),
                }
              : {}),
            textStorageKey: branch.textStorageKey,
            warnings: json(branch.warnings),
            errorCode: branch.errorCode,
            errorMessage: branch.errorMessage,
            startedAt: branch.startedAt,
            completedAt: branch.completedAt,
          })),
        });
    }
  }
  if (stageIndex >= 2) {
    const promptRuns = await tx.effectPromptRun.findMany({
      where: {
        projectId,
        workflowRunId: stageSources.get('PROMPT_GENERATION') ?? parent.id,
        status: 'COMPLETED',
        result: { isNot: null },
      },
      include: { result: true, stages: true, shards: true },
      orderBy: { createdAt: 'desc' },
    });
    const seen = new Set<string>();
    for (const source of promptRuns) {
      // Only the result actually committed by the selected artifact is an editing baseline.
      // A newer completed-but-unconfirmed domain draft must not slip into the copied editor.
      if (selectedPromptResultId && source.result?.id !== selectedPromptResultId) continue;
      if (seen.has(source.productId)) continue;
      seen.add(source.productId);
      const run = await tx.effectPromptRun.create({
        data: {
          projectId,
          workflowRunId: child.id,
          productId: ids[source.productId]!,
          operation: source.operation,
          targetItemId: source.targetItemId,
          idempotencyKey: `edit:${child.id}:prompt:${source.id}`,
          requestHash: source.requestHash,
          sourceFingerprint: source.sourceFingerprint,
          settingsHash: source.settingsHash,
          inputSnapshot: json(remap(source.inputSnapshot, ids)),
          status: 'COMPLETED',
          progress: 100,
          currentNode: source.currentNode,
          warnings: json(source.warnings),
          completedAt: source.completedAt,
        },
      });
      ids[source.id] = run.id;
      if (source.result) {
        const result = await tx.effectPromptResult.create({
          data: {
            projectId,
            workflowRunId: child.id,
            productId: ids[source.productId]!,
            runId: run.id,
            schemaVersion: source.result.schemaVersion,
            generatedResult: json(remap(source.result.generatedResult, ids)),
            draftResult: json(remap(source.result.draftResult, ids)),
            manualOverrides: json(remap(source.result.manualOverrides, ids)),
            qualityStatus: source.result.qualityStatus,
            sourceFingerprint: source.result.sourceFingerprint,
            settingsHash: source.result.settingsHash,
            revision: source.result.revision,
            savedAt: source.result.savedAt,
          },
        });
        ids[source.result.id] = result.id;
      }
      if (source.stages.length)
        await tx.effectPromptStageOutput.createMany({
          data: source.stages.map((stage) => ({
            projectId,
            runId: run.id,
            nodeId: stage.nodeId,
            status: stage.status,
            summary: stage.summary,
            warnings: json(stage.warnings),
            metadata: json(remap(stage.metadata, ids)),
            errorMessage: stage.errorMessage,
            startedAt: stage.startedAt,
            completedAt: stage.completedAt,
          })),
        });
      if (source.shards.length)
        await tx.effectPromptShardOutput.createMany({
          data: source.shards.map((shard) => ({
            projectId,
            runId: run.id,
            phase: shard.phase,
            round: shard.round,
            shardIndex: shard.shardIndex,
            status: shard.status,
            combinationPlan: json(remap(shard.combinationPlan, ids)),
            items: json(remap(shard.items, ids)),
            warnings: json(shard.warnings),
            errorCode: shard.errorCode,
            errorMessage: shard.errorMessage,
            startedAt: shard.startedAt,
            completedAt: shard.completedAt,
          })),
        });
    }
    if (selectedPromptResultId && !promptRuns.some((run) => run.result?.id === selectedPromptResultId))
      throw new ConflictException('已确认 Prompt 结果来源缺失，请刷新后重试');
  }
  if (stageIndex >= 3 && copyPolicy.copyRenderBatches) {
    const candidateBatches = await tx.effectSegmentRenderBatch.findMany({
      where: {
        projectId,
        workflowRunId: stageSources.get('SEGMENT_RENDER') ?? parent.id,
        archivedAt: null,
        committedAt: { not: null },
      },
      include: { tasks: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    const seenProducts = new Set<string>();
    const batches = candidateBatches.filter((batch) => {
      if (seenProducts.has(batch.productId)) return false;
      seenProducts.add(batch.productId);
      return true;
    });
    for (const source of batches) {
      renderBatchRevisions[source.id] = source.revision;
      const batch = await tx.effectSegmentRenderBatch.create({
        data: {
          projectId,
          workflowRunId: child.id,
          productId: ids[source.productId]!,
          sourcePromptArtifactId: source.sourcePromptArtifactId,
          sourcePromptRevision: source.sourcePromptRevision,
          sourcePromptHash: source.sourcePromptHash,
          sourceFingerprint: source.sourceFingerprint,
          idempotencyKey: `edit:${child.id}:batch:${source.id}`,
          requestHash: source.requestHash,
          status: source.status,
          activeKey: source.activeKey,
          revision: source.revision,
          committedAt: source.committedAt,
        },
      });
      ids[source.id] = batch.id;
      for (const sourceTask of source.tasks) {
        const taskId = randomUUID();
        renderTaskRows.push({
            id: taskId,
            projectId,
            workflowRunId: child.id,
            productId: ids[sourceTask.productId]!,
            batchId: batch.id,
            promptId: sourceTask.promptId,
            promptCode: sourceTask.promptCode,
            renderCode: sourceTask.renderCode,
            sourceFingerprint: sourceTask.sourceFingerprint,
            requestSnapshot: renderEditSnapshot(sourceTask.requestSnapshot),
            generationRequestSnapshot: renderEditSnapshot(sourceTask.generationRequestSnapshot),
            operationKind: sourceTask.operationKind,
            status: sourceTask.status,
            progress: sourceTask.progress,
            renderVersion: sourceTask.renderVersion,
            activeOutputVersion: sourceTask.activeOutputVersion,
            retryCount: sourceTask.retryCount,
            maxAutoRetries: sourceTask.maxAutoRetries,
            attemptCount: sourceTask.attemptCount,
            providerTaskId: sourceTask.providerTaskId,
            outputFileObjectId: sourceTask.outputFileObjectId,
            outputStorageKey: sourceTask.outputStorageKey,
            outputFileName: sourceTask.outputFileName,
            outputMimeType: sourceTask.outputMimeType,
            outputSizeBytes: sourceTask.outputSizeBytes,
            outputContentHash: sourceTask.outputContentHash,
            ...(sourceTask.outputPoster ? { outputPoster: json(sourceTask.outputPoster) } : {}),
            repairStatus: sourceTask.repairStatus,
            repairSourceVersion: sourceTask.repairSourceVersion,
            repairStartMs: sourceTask.repairStartMs,
            repairEndMs: sourceTask.repairEndMs,
            ...(sourceTask.repairRegion ? { repairRegion: json(sourceTask.repairRegion) } : {}),
            repairInstruction: sourceTask.repairInstruction,
            repairRequestHash: sourceTask.repairRequestHash,
            repairCandidateFileObjectId: sourceTask.repairCandidateFileObjectId,
            repairCandidateStorageKey: sourceTask.repairCandidateStorageKey,
            repairCandidateFileName: sourceTask.repairCandidateFileName,
            repairCandidateMimeType: sourceTask.repairCandidateMimeType,
            repairCandidateSizeBytes: sourceTask.repairCandidateSizeBytes,
            repairCandidateContentHash: sourceTask.repairCandidateContentHash,
            ...(sourceTask.repairCandidatePoster
              ? { repairCandidatePoster: json(sourceTask.repairCandidatePoster) }
              : {}),
            repairCandidateVersion: sourceTask.repairCandidateVersion,
            repairCandidateCreatedAt: sourceTask.repairCandidateCreatedAt,
            errorCode: sourceTask.errorCode,
            errorMessage: sourceTask.errorMessage,
            queuedAt: sourceTask.queuedAt,
            startedAt: sourceTask.startedAt,
            completedAt: sourceTask.completedAt,
        });
        ids[sourceTask.id] = taskId;
        taskIdMap[sourceTask.id] = taskId;
      }
    }
  }
  // Packaging is transactional replacement, not picture regeneration. Copy its confirmed
  // baseline through the same ID/hash remapping as the retained packaging/output rows below.
  // Publication still depends on the new task, never on the presence of these baseline copies.
  const artifactStages = effectEditArtifactStages(nodeId, purpose, options.preservePackagingBaseline);
  const artifacts = (
    await Promise.all(
      artifactStages.map((stage) =>
        tx.workingArtifact.findMany({
          where: {
            projectId,
            workflowRunId: stageSources.get(stage) ?? parent.id,
            nodeId: stage,
            availability: 'AVAILABLE',
            ...(stage === 'TEMPLATE_MIX' && options.preservePackagingBaseline && options.templateId
              ? { OR: artifactPrefix.TEMPLATE_MIX.map((prefix) => ({ artifactKey:
                  prefix === 'mix-template:' ? `${prefix}${options.templateId}` : { startsWith: `${prefix}${options.templateId}:` } })) }
              : {}),
          },
          include: workingArtifactInclude,
        }),
      ),
    )
  ).flat();
  const ordered = artifacts.sort(
    (a, b) =>
      stageOrder.indexOf(a.nodeId as EffectWorkflowEditableNodeId) -
      stageOrder.indexOf(b.nodeId as EffectWorkflowEditableNodeId) ||
      // Packages name the reminted visual artifact and its new content hash. Both must be
      // available before the package is remapped, regardless of PostgreSQL's row order.
      Number(a.artifactKey.startsWith('timeline-package:')) -
      Number(b.artifactKey.startsWith('timeline-package:')),
  );
  const artifactIds: IdMap = {};
  const hashMap: IdMap = {};
  const hashReplacements: IdMap = {};
  // Ids are handed out before anything is written so the whole stage fits in three statements and
  // a dependency can still name an artifact the loop has not reached yet. Dependencies go in
  // after every artifact exists, so their foreign keys resolve whatever the order was.
  for (const artifact of ordered) artifactIds[artifact.id] = randomUUID();
  // The mix draft binds every slot to a material artifact by id, so the node states are cloned with
  // the new artifact ids as well. A branch that kept binding to its ancestor's clips would freeze
  // that ancestor's ids into its packaging snapshot, and the worker resolving the snapshot inside
  // the branch would find none of them.
  const clonedIds: IdMap = { ...ids, ...artifactIds };
  const states = (
    await Promise.all(
      stageOrder
        .slice(0, stageIndex + 1)
        .map((stage) =>
          tx.workflowNodeState.findMany({
            where: effectEditNodeStateWhere(projectId, parent.id, stage, stageSources.get(stage) ?? parent.id),
          }),
        ),
    )
  ).flat();
  if (states.length)
    await tx.workflowNodeState.createMany({
      data: states.map((state) => {
        let value = remap(state.state, clonedIds);
        // A new fill or packaging version owns its own mix lifecycle. Clear the legacy packaging
        // lock marker; the parent Run keeps its packaging rows and the child timeline stays editable.
        if (stageIndex === 4 && state.nodeId === 'TEMPLATE_MIX') {
          const draft = value as EffectTemplateMixDraft;
          value = {
            ...draft,
            templates: draft.templates.map((entry) => ({
              ...entry,
              packagingLocked: false,
            })),
          };
        }
        return {
          projectId,
          workflowRunId: child.id,
          nodeId: remap(state.nodeId, ids),
          schemaVersion: state.schemaVersion,
          revision: state.revision,
          contentHash: workflowStateHash(value),
          executionInputHash: state.executionInputHash,
          executionInputSchemaVersion: state.executionInputSchemaVersion,
          state: json(value),
          savedAt: state.savedAt,
        };
      }),
    });
  const artifactRows: Prisma.WorkingArtifactCreateManyInput[] = [];
  const artifactFileRows: Prisma.WorkingArtifactFileCreateManyInput[] = [];
  const artifactDependencyRows: Prisma.WorkingArtifactDependencyCreateManyInput[] = [];
  for (const artifact of ordered) {
    const id = artifactIds[artifact.id]!;
    const dependencies = artifact.dependencies.map((dependency) => ({
      sourceType: dependency.sourceType,
      sourceNodeId: dependency.sourceNodeId ? remap(dependency.sourceNodeId, ids) : null,
      sourceArtifactId: dependency.sourceArtifactId
        ? (artifactIds[dependency.sourceArtifactId] ?? dependency.sourceArtifactId)
        : null,
      sourceKey: remap(dependency.sourceKey, ids),
      sourceRevision: dependency.sourceRevision,
      sourceHash: dependency.sourceArtifactId
        ? (hashMap[dependency.sourceArtifactId] ?? dependency.sourceHash)
        : dependency.sourceHash,
    }));
    const files = artifact.files.map((file) => ({
      fileObjectId: file.fileObjectId,
      role: file.role,
      sortOrder: file.sortOrder,
      originalFileName: file.fileObject.originalFileName,
      mimeType: file.fileObject.mimeType,
      sha256: file.fileObject.sha256,
    }));
    const input: WorkingArtifactUpsertInput = {
      kind: artifact.kind,
      name: artifact.name,
      directory: artifact.directory,
      type: artifact.type,
      tags: artifact.tags,
      payload: remap(artifact.payload, { ...ids, ...artifactIds, ...hashReplacements }),
      metadata: { ...((remap(artifact.metadata, { ...ids, ...artifactIds, ...hashReplacements }) ?? {}) as object),
        branchSource: { artifactId: artifact.id, revision: artifact.revision,
          ancestorArtifactIds: (() => {
            const source = (artifact.metadata as { branchSource?: { artifactId?: string;
              ancestorArtifactIds?: string[] } } | null)?.branchSource;
            return [...new Set([...(source?.artifactId ? [source.artifactId] : []),
              ...(source?.ancestorArtifactIds ?? [])])];
          })() } },
      originalFileName: artifact.originalFileName,
      mimeType: artifact.mimeType,
      sizeBytes: artifact.sizeBytes,
      storageKey: artifact.storageKey,
      files,
      dependencies,
    };
    const contentHash = workingArtifactContentHash(input);
    artifactRows.push({
      id,
      projectId,
      workflowRunId: child.id,
      nodeId: artifact.nodeId,
      artifactKey: remap(artifact.artifactKey, ids),
      kind: artifact.kind,
      name: artifact.name,
      directory: artifact.directory,
      type: artifact.type,
      tags: artifact.tags,
      payload: json(input.payload),
      metadata: json(input.metadata),
      originalFileName: artifact.originalFileName,
      mimeType: artifact.mimeType,
      sizeBytes: artifact.sizeBytes,
      storageKey: artifact.storageKey,
      sourceRunId: artifact.sourceRunId
        ? (ids[artifact.sourceRunId] ?? artifact.sourceRunId)
        : null,
      sourceArtifactId: artifact.sourceArtifactId
        ? (ids[artifact.sourceArtifactId] ?? artifact.sourceArtifactId)
        : null,
      revision: artifact.revision,
      contentHash,
      freshness: artifact.freshness,
      availability: artifact.availability,
      createdAt: artifact.createdAt,
    });
    hashMap[artifact.id] = contentHash;
    hashReplacements[artifact.contentHash] = contentHash;
    for (const file of files)
      artifactFileRows.push({
        projectId,
        workflowRunId: child.id,
        workingArtifactId: id,
        fileObjectId: file.fileObjectId,
        role: file.role,
        sortOrder: file.sortOrder,
      });
    for (const dependency of dependencies)
      artifactDependencyRows.push({
        projectId,
        workflowRunId: child.id,
        dependentArtifactId: id,
        ...dependency,
      });
  }
  if (artifactRows.length) await tx.workingArtifact.createMany({ data: artifactRows });
  if (artifactFileRows.length) {
    await tx.workingArtifactFile.createMany({ data: artifactFileRows });
  }
  if (artifactDependencyRows.length) {
    await tx.workingArtifactDependency.createMany({ data: artifactDependencyRows });
  }
  if (stageIndex >= 3) {
    // The mix workspace reads its AI 归槽 pool — the classification chips and per-material match
    // scores — from the fill runs of the Run it is looking at, so a branch that carried the clips
    // but not the fills fell back to the material library as it looked before the fill. The fills
    // are copied from the Run the clips came from, which is the only one whose frozen snapshot the
    // remapped material ids still resolve in; every later fork copies them again, so the branch
    // chain keeps its own and the pool survives packaging, exporting and re-rendering alike.
    await cloneMixAiRunsInTransaction(
      tx,
      projectId,
      stageSources.get('SEGMENT_RENDER') ?? parent.id,
      child.id,
      { ...ids, ...artifactIds, ...hashReplacements },
    );
  }
  if (stageIndex >= 5 || stageIndex === 4 && options.preservePackagingBaseline) {
    // The output stage is downstream of the mix stage: the branch keeps the packaging it exports
    // from, but every film starts unrendered so the export has to run again in this branch.
    // Every artifact is cloned by now, so the snapshots can be re-pointed in one pass here; a
    // packaging snapshot names artifacts and content hashes, never another packaging row.
    await clonePackagingRunsInTransaction(tx, projectId, parent.id, child.id, ids, {
      keyPrefix: 'edit',
      snapshotIds: { ...ids, ...artifactIds, ...hashReplacements },
    });
    const outputRuns = await tx.effectFinalOutputRun.findMany({
      where: { projectId, workflowRunId: parent.id },
      include: { items: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    const seenTemplates = new Set<string>();
    const outputRows: Prisma.EffectFinalOutputRunCreateManyInput[] = [];
    const outputItemRows: Prisma.EffectFinalOutputItemCreateManyInput[] = [];
    for (const source of outputRuns) {
      if (seenTemplates.has(source.templateId)) continue;
      seenTemplates.add(source.templateId);
      const id = randomUUID();
      ids[source.id] = id;
      outputRows.push({
        id,
        projectId,
        workflowRunId: child.id,
        templateId: source.templateId,
        idempotencyKey: `edit:${child.id}:output:${source.id}`,
        requestHash: source.requestHash,
        inputHash: source.inputHash,
        status: 'PENDING_RENDER',
      });
      for (const item of source.items) {
        const itemId = randomUUID();
        const snapshot = remap(item.snapshot, {
          ...ids,
          ...artifactIds,
          ...hashReplacements,
        }) as unknown as FinalOutputSnapshot;
        // The visual source hash is derived from the variant, whose material ids and content
        // hashes were remapped to this branch. The parent's hash cannot validate the child.
        snapshot.timeline.sourceTimelineHash = visualHash(snapshot.timeline.variant);
        outputItemRows.push({
          id: itemId,
          projectId,
          runId: id,
          variantId: item.variantId,
          name: item.name,
          snapshot: json(snapshot),
          status: 'PENDING_RENDER',
          progress: 0,
          fileObjectId: null,
          assetId: null,
        });
        ids[item.id] = itemId;
      }
    }
    if (outputRows.length) await tx.effectFinalOutputRun.createMany({ data: outputRows });
    if (outputItemRows.length) {
      await tx.effectFinalOutputItem.createMany({ data: outputItemRows });
    }
  }
  // Snapshots are frozen, but cloned domain records must point at cloned confirmed inputs.
  if (stageIndex >= 1) {
    const extractionRuns = await tx.effectExtractionRun.findMany({
      where: {
        projectId,
        draftId: { in: workspace.drafts.map((draft) => ids[draft.id]!) },
      },
    });
    for (const run of extractionRuns)
      await tx.effectExtractionRun.update({
        where: { id: run.id },
        data: {
          inputSnapshot: json(remap(run.inputSnapshot, { ...artifactIds, ...hashReplacements })),
        },
      });
  }
  if (stageIndex >= 2) {
    const promptRuns = await tx.effectPromptRun.findMany({
      where: { projectId, workflowRunId: child.id },
    });
    for (const run of promptRuns)
      await tx.effectPromptRun.update({
        where: { id: run.id },
        data: {
          inputSnapshot: json(remap(run.inputSnapshot, { ...artifactIds, ...hashReplacements })),
        },
      });
  }
  if (stageIndex >= 3) {
    const batches = await tx.effectSegmentRenderBatch.findMany({
      where: { projectId, workflowRunId: child.id },
    });
    for (const batch of batches) {
      const mappedId = artifactIds[batch.sourcePromptArtifactId];
      if (mappedId)
        await tx.effectSegmentRenderBatch.update({
          where: { id: batch.id },
          data: {
            sourcePromptArtifactId: mappedId,
            sourcePromptHash: hashMap[batch.sourcePromptArtifactId] ?? batch.sourcePromptHash,
          },
        });
    }
    await insertEffectRenderBranchTasks(tx, renderTaskRows, { ...artifactIds, ...hashReplacements });
  }
  // An auto branch has no session, so it has nothing to compare a baseline against.
  if (!options.always)
    await tx.workflowRun.update({
      where: { id: child.id },
      data: {
        editBaselineHash: await stageDigest(tx, projectId, child.id, nodeId),
        editIdMap: json({ productIdMap, taskIdMap, renderBatchRevisions,
          ...(promptEditBaseline ? { promptEditBaseline } : {}) }),
      },
    });
  if (!options.keepParentActive) {
    await tx.workflowRun.update({ where: { id: active?.id ?? parent.id }, data: { activeKey: null } });
    await tx.workflowRun.update({
      where: { id: child.id },
      data: {
        activeKey: 'ACTIVE',
        lastActiveAt: new Date(),
      },
    });
  }
  return {
    runId: child.id,
    parentWorkflowRunId: parent.id,
    productIdMap,
    taskIdMap,
    created: true,
  };
}

export async function exitEffectEditInTransaction(
  tx: Tx,
  projectId: string,
  draftRunId: string,
  nodeId: EffectWorkflowEditableNodeId,
  publish: boolean,
): Promise<{ runId: string; activeWorkflowRunId: string; createdBranch: boolean } | null> {
  await tx.$queryRaw(
    Prisma.sql`SELECT "id" FROM "projects" WHERE "id" = ${projectId}::uuid FOR UPDATE`,
  );
  const draft = await tx.workflowRun.findFirst({
    where: {
      projectId,
      id: draftRunId,
      workflow: 'EFFECT',
      workflowSpace: 'EFFECT',
    },
  });
  if (!draft) return null;
  const active = await tx.workflowRun.findFirst({
    where: {
      projectId,
      workflow: 'EFFECT',
      workflowSpace: 'EFFECT',
      activeKey: 'ACTIVE',
    },
  });
  if (!draft.parentWorkflowRunId || draft.branchPublishedAt)
    return {
      runId: draft.id,
      activeWorkflowRunId: active?.id ?? draft.id,
      createdBranch: false,
    };
  // The child belongs to this node either because it opened a session for it, or because it is the
  // auto branch a regenerating task opened without one. An auto branch has no baseline, so its
  // digest always differs from `null` and it publishes as soon as it holds an artifact of its own.
  if (draft.editSessionNodeId !== nodeId && draft.forkNodeId !== nodeId) return null;
  const parent = await tx.workflowRun.findFirst({
    where: {
      projectId,
      id: draft.parentWorkflowRunId,
      workflow: 'EFFECT',
      workflowSpace: 'EFFECT',
    },
  });
  if (!parent) return null;
  const currentArtifacts = await tx.workingArtifact.count({
    where: {
      projectId,
      workflowRunId: draft.id,
      nodeId,
      availability: 'AVAILABLE',
      freshness: 'CURRENT',
      ...artifactKeyWhere(nodeId),
    },
  });
  const changed =
    publish && draft.editBaselineHash !== (await stageDigest(tx, projectId, draft.id, nodeId));
  if (changed && currentArtifacts === 0) return null;
  if (changed) {
    const now = new Date();
    await tx.workflowRun.update({
      where: { id: draft.id },
      data: {
        branchPublishedAt: now,
        editSessionNodeId: null,
        editSessionPurpose: null,
        editBaselineHash: null,
        editIdMap: Prisma.DbNull,
      },
    });
    return { runId: draft.id, activeWorkflowRunId: active?.id ?? draft.id, createdBranch: true };
  }
  if (active?.id === draft.id) {
    await tx.workflowRun.update({ where: { id: draft.id }, data: { activeKey: null } });
    await tx.workflowRun.update({
      where: { id: parent.id },
      data: {
        activeKey: 'ACTIVE',
        lastActiveAt: new Date(),
      },
    });
  }
  // Keep the hidden Run for audit and late task callbacks; never delete shared media.
  await tx.workflowRun.update({
    where: { id: draft.id },
    data: {
      editSessionNodeId: null,
      editSessionPurpose: null,
      editBaselineHash: null,
      editIdMap: Prisma.DbNull,
    },
  });
  return {
    runId: parent.id,
    activeWorkflowRunId: active?.id === draft.id ? parent.id : (active?.id ?? parent.id),
    createdBranch: false,
  };
}
