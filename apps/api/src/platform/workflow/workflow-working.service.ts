import type {
  ActivateEffectWorkflowBranchData,
  CreateEffectWorkflowBranchData,
  ActivateWorkflowNodeData,
  AssetPreviewKind,
  EffectWorkflowBranch,
  EffectWorkflowBranchNodeId,
  EffectWorkflowBranchTreeData,
  EffectWorkflowEditExitData,
  EffectWorkflowEditPublishData,
  EffectWorkflowEditSessionData,
  EffectWorkflowEditableNodeId,
  PutWorkflowNodeStateData,
  PutWorkflowNodeStateRequest,
  WorkingArtifact,
  WorkingArtifactListData,
  WorkingArtifactListQuery,
  WorkflowNodeState,
  WorkflowRunOverviewData,
} from '@ai-marketing/contracts';
import { EFFECT_WORKFLOW_BRANCH_NODES, EFFECT_WORKFLOW_EDITABLE_NODES } from '@ai-marketing/contracts';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ApiHttpException } from '../../common/api-http-exception';
import type { StoragePort, StorageRange, StoredStream } from '../file/storage.port';
import { STORAGE_PORT } from '../file/storage.port';
import { normalizeMultipartFileName, safeOriginalFileName } from '../file/file-name';
import { ProjectService } from '../project/project.service';
import {
  inheritedEffectArtifactVisible,
  WorkflowWorkingRepository,
  type WorkingArtifactRecord,
  type WorkingArtifactUpsertInput,
} from './workflow-working.repository';
import { workflowStateHash } from './workflow-state-hash';
import { isInheritedFillKey } from './effect-branch-clone';
import { effectArtifactSourceOwner, effectRenderClipHeads, projectEffectBranchFreshness } from './effect-branch-freshness';
import type { EffectEditBeginOptions } from './effect-edit-session';
import { selectedEffectTemplatePaths } from './effect-template-current-path';

export { workflowStateHash } from './workflow-state-hash';

export type WorkingArtifactContent = StoredStream & {
  mimeType: string;
  originalFileName: string;
  previewKind: AssetPreviewKind;
  partial: boolean;
};

const previewKind = (mimeType: string | null): AssetPreviewKind => {
  const normalized = mimeType?.toLowerCase() ?? '';
  if (normalized.startsWith('image/')) return 'IMAGE';
  if (normalized.startsWith('audio/')) return 'AUDIO';
  if (normalized.startsWith('video/')) return 'VIDEO';
  return 'DOWNLOAD';
};

const mixDraftTemplates = (
  value: unknown,
): Array<{ id: string; name: string; createdAt: string | null; variantIds: string[] | null }> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const draft = value as Record<string, unknown>;
  if (draft.schemaVersion !== 1 || !Array.isArray(draft.templates)) return [];
  return draft.templates.flatMap((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    const entry = value as Record<string, unknown>;
    const workspace = entry.workspace;
    if (!workspace || typeof workspace !== 'object' || Array.isArray(workspace)) return [];
    const template = (workspace as Record<string, unknown>).template;
    if (!template || typeof template !== 'object' || Array.isArray(template)) return [];
    const id = entry.id;
    const name = (template as Record<string, unknown>).name;
    const createdAt = entry.createdAt;
    const variants = (workspace as Record<string, unknown>).variants;
    const variantIds = Array.isArray(variants)
      ? variants.flatMap((variant) => {
          if (!variant || typeof variant !== 'object' || Array.isArray(variant)) return [];
          const variantId = (variant as Record<string, unknown>).id;
          return typeof variantId === 'string' ? [variantId] : [];
        })
      : null;
    return typeof id === 'string' && id.length > 0 && typeof name === 'string'
      ? [
          {
            id,
            name: name.trim() || `模板 ${id.slice(0, 8)}`,
            createdAt: typeof createdAt === 'string' ? createdAt : null,
            variantIds,
          },
        ]
      : [];
  });
};

const toNodeState = (record: {
  id: string;
  projectId: string;
  workflowRunId: string;
  nodeId: string;
  schemaVersion: number;
  revision: number;
  contentHash: string;
  executionInputHash: string;
  executionInputSchemaVersion: number;
  state: unknown;
  savedAt: Date;
  updatedAt: Date;
}): WorkflowNodeState => ({
  ...record,
  savedAt: record.savedAt.toISOString(),
  updatedAt: record.updatedAt.toISOString(),
});

const toRun = (record: {
  id: string;
  projectId: string;
  parentWorkflowRunId: string | null;
  forkNodeId: string | null;
  forkTemplateId: string | null;
  branchLabel: string | null;
  branchPublishedAt: Date | null;
  editSessionNodeId: string | null;
  workflow: WorkingArtifactListQuery['workflow'];
  workflowSpace: WorkingArtifactListQuery['space'];
  status: 'ACTIVE' | 'PAUSED' | 'COMPLETED';
  currentNodeId: string | null;
  lastActiveAt: Date;
  createdAt: Date;
  updatedAt: Date;
}) => ({
  id: record.id,
  projectId: record.projectId,
  parentWorkflowRunId: record.parentWorkflowRunId,
  forkNodeId: record.forkNodeId,
  forkTemplateId: record.forkTemplateId,
  branchLabel: record.branchLabel,
  isTemporaryBranch: Boolean(record.parentWorkflowRunId && !record.branchPublishedAt && record.editSessionNodeId),
  editNodeId: EFFECT_WORKFLOW_EDITABLE_NODES.find((node) => node === record.editSessionNodeId) ?? null,
  workflow: record.workflow!,
  workflowSpace: record.workflowSpace!,
  status: record.status,
  currentNodeId: record.currentNodeId,
  lastActiveAt: record.lastActiveAt.toISOString(),
  createdAt: record.createdAt.toISOString(),
  updatedAt: record.updatedAt.toISOString(),
});

const toArtifact = (record: WorkingArtifactRecord): WorkingArtifact => {
  const contentPath = `/api/projects/${record.projectId}/working-artifacts/${record.id}/content`;
  const originalFileName = record.originalFileName
    ? safeOriginalFileName(record.originalFileName)
    : null;
  const files = record.files.map(({ fileObject, role, sortOrder }) => {
    const filePath = `/api/projects/${record.projectId}/file-objects/${fileObject.id}/content`;
    return {
      id: fileObject.id,
      fileObjectId: fileObject.id,
      role,
      sortOrder,
      originalFileName: safeOriginalFileName(fileObject.originalFileName),
      mimeType: fileObject.mimeType,
      sizeBytes: fileObject.sizeBytes,
      sha256: fileObject.sha256,
      previewKind: previewKind(fileObject.mimeType),
      previewUrl: filePath,
      contentUrl: filePath,
      downloadUrl: `${filePath}?download=true`,
    };
  });
  return {
    id: record.id,
    projectId: record.projectId,
    workflowRunId: record.workflowRunId,
    nodeId: record.nodeId,
    artifactKey: record.artifactKey,
    kind: record.kind,
    name: record.kind === 'FILE' ? normalizeMultipartFileName(record.name) : record.name,
    directory: record.directory,
    type: record.type,
    tags: record.tags,
    payload: record.payload,
    metadata: record.metadata,
    originalFileName,
    mimeType: record.mimeType,
    sizeBytes: record.sizeBytes,
    previewKind: previewKind(record.mimeType),
    contentUrl: record.storageKey ? contentPath : null,
    downloadUrl: record.storageKey ? `${contentPath}?download=true` : null,
    sourceRunId: record.sourceRunId,
    sourceArtifactId: record.sourceArtifactId,
    revision: record.revision,
    contentHash: record.contentHash,
    freshness: record.freshness,
    availability: record.availability,
    dependencies: record.dependencies.map((dependency) => ({
      sourceType: dependency.sourceType,
      sourceNodeId: dependency.sourceNodeId,
      sourceArtifactId: dependency.sourceArtifactId,
      sourceKey: dependency.sourceKey,
      sourceRevision: dependency.sourceRevision,
      sourceHash: dependency.sourceHash,
    })),
    files,
    fileCount: files.length,
    mainPreviewUrl: files.find((file) => file.previewKind === 'IMAGE')?.contentUrl ?? null,
    status: 'WORKING',
    archiveStatus: 'UNARCHIVED',
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
};

const parseRange = (header: string, sizeBytes: number): StorageRange => {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) throw new ApiHttpException('请求的文件范围无效', 416, 'VALIDATION_ERROR');
  const startText = match[1] ?? '';
  const endText = match[2] ?? '';
  if (!startText) {
    const suffix = Number(endText);
    if (!Number.isSafeInteger(suffix) || suffix <= 0)
      throw new ApiHttpException('请求的文件范围无效', 416, 'VALIDATION_ERROR');
    return { start: Math.max(0, sizeBytes - suffix), end: sizeBytes - 1 };
  }
  const start = Number(startText);
  const end = endText ? Number(endText) : sizeBytes - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start >= sizeBytes ||
    end < start
  )
    throw new ApiHttpException('请求的文件范围无效', 416, 'VALIDATION_ERROR');
  return { start, end: Math.min(end, sizeBytes - 1) };
};

@Injectable()
export class WorkflowWorkingService {
  constructor(
    @Inject(WorkflowWorkingRepository)
    private readonly repository: WorkflowWorkingRepository,
    @Inject(ProjectService) private readonly projectService: ProjectService,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
  ) {}

  private effectEditNode(nodeId: string): EffectWorkflowEditableNodeId {
    const accepted = EFFECT_WORKFLOW_EDITABLE_NODES.find((node) => node === nodeId);
    if (!accepted)
      throw new ApiHttpException('该节点不支持编辑分支', HttpStatus.BAD_REQUEST, 'VALIDATION_ERROR');
    return accepted;
  }

  async beginEffectNodeEdit(
    projectId: string, workflowRunId: string, nodeId: string,
    purpose: 'MANUAL' | 'BATCH' = 'MANUAL',
    options: EffectEditBeginOptions = {},
  ): Promise<EffectWorkflowEditSessionData> {
    await this.projectService.get(projectId);
    const result = await this.repository.beginEffectNodeEdit(
      projectId, workflowRunId, this.effectEditNode(nodeId), purpose, options);
    if (!result) throw new ApiHttpException('当前分支无法进入编辑态', HttpStatus.CONFLICT, 'CONFLICT');
    const run = await this.repository.findRun(projectId, result.runId);
    if (!run) throw new ApiHttpException('编辑分支不存在', HttpStatus.NOT_FOUND, 'ASSET_NOT_FOUND');
    return { run: toRun(run), parentWorkflowRunId: result.parentWorkflowRunId,
      productIdMap: result.productIdMap, taskIdMap: result.taskIdMap,
      created: result.created };
  }

  async cancelEffectNodeEdit(
    projectId: string, workflowRunId: string, nodeId: string,
  ): Promise<EffectWorkflowEditExitData> {
    await this.projectService.get(projectId);
    const result = await this.repository.cancelEffectNodeEdit(
      projectId, workflowRunId, this.effectEditNode(nodeId));
    if (!result) throw new ApiHttpException('编辑分支不存在或状态已变化', HttpStatus.CONFLICT, 'CONFLICT');
    const run = await this.repository.findRun(projectId, result.runId);
    if (!run) throw new ApiHttpException('工作流运行不存在', HttpStatus.NOT_FOUND, 'ASSET_NOT_FOUND');
    return { run: toRun(run), activeWorkflowRunId: result.activeWorkflowRunId };
  }

  async publishEffectNodeEdit(
    projectId: string, workflowRunId: string, nodeId: string,
  ): Promise<EffectWorkflowEditPublishData> {
    await this.projectService.get(projectId);
    const result = await this.repository.publishEffectNodeEdit(
      projectId, workflowRunId, this.effectEditNode(nodeId));
    if (!result) throw new ApiHttpException('编辑分支不存在或状态已变化', HttpStatus.CONFLICT, 'CONFLICT');
    const run = await this.repository.findRun(projectId, result.runId);
    if (!run) throw new ApiHttpException('工作流运行不存在', HttpStatus.NOT_FOUND, 'ASSET_NOT_FOUND');
    return { run: toRun(run), activeWorkflowRunId: result.activeWorkflowRunId,
      createdBranch: result.createdBranch };
  }

  async assertEffectNodeWritable(projectId: string, workflowRunId: string, nodeId: string): Promise<void> {
    await this.projectService.get(projectId);
    const node = this.effectEditNode(nodeId);
    const run = await this.repository.findRun(projectId, workflowRunId);
    if (!run || run.workflow !== 'EFFECT' || run.workflowSpace !== 'EFFECT')
      throw new ApiHttpException('工作流运行不存在', HttpStatus.NOT_FOUND, 'ASSET_NOT_FOUND');
    if (run.parentWorkflowRunId && !run.branchPublishedAt) {
      if (run.editSessionNodeId === node) return;
      throw new ApiHttpException('编辑分支不属于当前节点', HttpStatus.CONFLICT, 'CONFLICT');
    }
    if (await this.repository.hasEffectConfirmedStageArtifact(projectId, workflowRunId, node))
      throw new ApiHttpException('已确认版本不可直接修改，请先进入编辑状态', HttpStatus.CONFLICT, 'CONFLICT');
  }

  async getActiveRunOverview(
    projectId: string,
    workflow: NonNullable<WorkingArtifactListQuery['workflow']>,
    space: NonNullable<WorkingArtifactListQuery['space']>,
  ): Promise<WorkflowRunOverviewData> {
    await this.projectService.get(projectId);
    const run = await this.repository.findActiveRunWithNodeStates(projectId, workflow, space);
    if (!run) return { run: null, nodeStates: [] };
    return {
      run: toRun(run),
      nodeStates: run.nodeStates.map(toNodeState),
    };
  }

  async getEffectBranchTree(projectId: string): Promise<EffectWorkflowBranchTreeData> {
    await this.projectService.get(projectId);
    const runs = await this.repository.listEffectRunBranches(projectId);
    const byId = new Map(runs.map((run) => [run.id, run]));
    // A packaging fork is only a version once its batch is whole. A batch that ended with films it
    // could not package keeps its child out of the tree: those films are recovered in the packaging
    // panel, which retries the very same run, and the branch shows up as a version once it is whole.
    // Runs published before this rule existed are covered by the same test. A fork that owns no
    // package at all is a fill, not a packaging, and one whose earlier batch did complete already
    // carries a version of its own — neither may be hidden here.
    const packagingUnfinished = (run: (typeof runs)[number]): boolean => {
      if (run.forkNodeId !== 'TEMPLATE_MIX') return false;
      if (
        !run.workingArtifacts.some((artifact) =>
          artifact.artifactKey.startsWith('timeline-package:'),
        )
      )
        return false;
      const batches = run.effectPackagingRuns ?? [];
      return batches.length > 0 && batches.every((batch) => batch.status !== 'COMPLETED');
    };
    // A Run stays out of the tree until it publishes. The root never needs publishing, and a child
    // publishes when a regeneration finishes successfully.
    const drawn = (run: (typeof runs)[number]): boolean =>
      !run.parentWorkflowRunId ||
      (Boolean(run.branchPublishedAt) && !packagingUnfinished(run));
    // The nearest ancestor the tree actually draws. A hidden child owns the active pointer while a
    // failed regeneration is waiting to be recovered, and a later branch forked from it has to hang
    // off this ancestor instead of being drawn as a trunk of its own.
    const nearestDrawn = (
      run: (typeof runs)[number] | undefined,
    ): (typeof runs)[number] | null => {
      const seen = new Set<string>();
      for (let cursor = run; cursor && !seen.has(cursor.id);) {
        if (drawn(cursor)) return cursor;
        seen.add(cursor.id);
        cursor = cursor.parentWorkflowRunId ? byId.get(cursor.parentWorkflowRunId) : undefined;
      }
      return null;
    };
    let active = nearestDrawn(runs.find((run) => run.activeKey === 'ACTIVE'));
    if (!active) {
      // A hidden edit child owns the active pointer, but must not appear in the tree.
      let cursor = await this.repository.findActiveRun(projectId, 'EFFECT', 'EFFECT');
      const seen = new Set<string>();
      while (cursor?.parentWorkflowRunId && !seen.has(cursor.id)) {
        seen.add(cursor.id);
        active = nearestDrawn(byId.get(cursor.parentWorkflowRunId));
        if (active) break;
        cursor = await this.repository.findRun(projectId, cursor.parentWorkflowRunId);
      }
    }
    if (!active) return { projectId, activeWorkflowRunId: null, branches: [] };
    // A saved catalog belongs to its branch, not the project's active pointer. Older sibling
    // catalogs cannot hide templates created in another branch. For legacy children without
    // a saved catalog, inherit the nearest parent's catalog instead of resurrecting removed
    // templates from immutable artifacts alone.
    const draftTemplatesFor = (run: (typeof runs)[number]) => {
      const visited = new Set<string>();
      for (let cursor: (typeof runs)[number] | undefined = run;
        cursor && !visited.has(cursor.id);
        cursor = cursor.parentWorkflowRunId ? byId.get(cursor.parentWorkflowRunId) : undefined) {
        visited.add(cursor.id);
        // Navigation and business draft rows are loaded together. Database row order is not a
        // contract: reading current-paths as the draft falls back to the parent's old five films
        // and hides this Run's newly appended artifacts from the tree.
        const state = (cursor.nodeStates?.find(row => row.nodeId === 'TEMPLATE_MIX') ??
          cursor.nodeStates?.find(row => !row.nodeId))?.state;
        const draft = state && typeof state === 'object' && !Array.isArray(state)
          ? state as Record<string, unknown> : null;
        if (draft?.schemaVersion === 1 && Array.isArray(draft.templates))
          return new Map(mixDraftTemplates(state).map((template) => [template.id, template]));
      }
      return null;
    };
    let root = active;
    const seen = new Set<string>();
    while (root.parentWorkflowRunId && !seen.has(root.id)) {
      seen.add(root.id);
      const parent = byId.get(root.parentWorkflowRunId);
      if (!parent) break;
      root = parent;
    }
    const inTree = new Set([root.id]);
    for (let changed = true; changed;) {
      changed = false;
      for (const run of runs) {
        if (run.parentWorkflowRunId && inTree.has(run.parentWorkflowRunId) && !inTree.has(run.id)) {
          inTree.add(run.id);
          changed = true;
        }
      }
    }
    type BranchArtifact = (typeof runs)[number]['workingArtifacts'][number];
    const revisionsOf = (artifacts: BranchArtifact[]): number[] =>
      [
        ...new Set(
          artifacts
            .map((artifact) => artifact.revision)
            .filter((revision): revision is number => typeof revision === 'number'),
        ),
      ].sort((a, b) => a - b);
    const sharedRevision = (artifacts: BranchArtifact[]): number | null => {
      const revisions = revisionsOf(artifacts);
      return revisions.length === 1 ? revisions[0]! : null;
    };
    const artifactCreatedAt = (artifacts: BranchArtifact[]): string | null =>
      artifacts.length
        ? new Date(
            Math.min(...artifacts.map((artifact) => artifact.createdAt.getTime())),
          ).toISOString()
        : null;
    const revisionKeyPrefix: Record<EffectWorkflowBranchNodeId, string> = {
      SOURCE_IMPORT: 'source-package:',
      INFORMATION_EXTRACTION: 'marketing-insight:',
      PROMPT_GENERATION: 'prompt-batch:',
      SEGMENT_RENDER: 'render-batch:',
      TEMPLATE_MIX: 'mix-template:',
      FINAL_OUTPUT: 'final-delivery:',
    };
    const effectiveArtifacts = (runId: string, visited = new Set<string>()): BranchArtifact[] => {
      if (visited.has(runId)) return [];
      visited.add(runId);
      const run = byId.get(runId);
      if (!run) return [];
      const local = [...run.workingArtifacts];
      if (!run.parentWorkflowRunId || !inTree.has(run.parentWorkflowRunId)) return local;
      const keys = new Set(local.map((artifact) => `${artifact.nodeId}:${artifact.artifactKey}`));
      const inherited = effectiveArtifacts(run.parentWorkflowRunId, visited).filter((artifact) => {
        const key = `${artifact.nodeId}:${artifact.artifactKey}`;
        if (keys.has(key) || !inheritedEffectArtifactVisible(artifact, [run])) return false;
        keys.add(key);
        return true;
      });
      return [...local, ...inherited];
    };
    // Only the template configuration says whether a fork changed the template. The payload also
    // carries the workspace edit version, which moves on every draft save, so comparing the payload
    // whole read a plain re-fill as a template change and drew the parent's MIX_TEMPLATE a second
    // time under the new branch. A payload without a template falls back to the whole payload, which
    // is what legacy rows and a brand new template key still need.
    const committedTemplate = (payload: unknown): string => {
      const value = payload as { template?: unknown } | null | undefined;
      return JSON.stringify(value?.template ?? value ?? null);
    };
    // Which mix layer a TEMPLATE_MIX fork actually branched from. The packaging and fill workers
    // re-commit the template and timelines they inherited (their frozen snapshots are validated
    // run-scoped, so an inherited artifact is not enough), which leaves a copy in the child Run.
    // Reading those copies as "this branch changed the template" made the tree draw the parent's
    // MIX_TEMPLATE/MIX_FILL a second time, so the template only counts as changed when the
    // configuration it carries really differs from the parent's. A packaging fork is recognised
    // first: it can only run after every variant was re-filled against the current template, so its
    // parent already shows that template and the copy carries no news.
    const mixForkStage = (
      run: (typeof runs)[number],
      forkNodeId: EffectWorkflowBranchNodeId | null,
    ): 'TEMPLATE' | 'FILL' | 'PACKAGING' | null => {
      if (forkNodeId !== 'TEMPLATE_MIX') return null;
      const local = run.workingArtifacts;
      if (local.some((artifact) => artifact.artifactKey.startsWith('timeline-package:')))
        return 'PACKAGING';
      const inheritedTemplates = new Map(
        (run.parentWorkflowRunId ? effectiveArtifacts(run.parentWorkflowRunId) : [])
          .filter((artifact) => artifact.artifactKey.startsWith('mix-template:'))
          .map((artifact) => [artifact.artifactKey, committedTemplate(artifact.payload)]),
      );
      if (
        local.some(
          (artifact) =>
            artifact.artifactKey.startsWith('mix-template:') &&
            inheritedTemplates.get(artifact.artifactKey) !== committedTemplate(artifact.payload),
        )
      )
        return 'TEMPLATE';
      if (local.some((artifact) => artifact.artifactKey.startsWith('timeline-project:')))
        return 'FILL';
      return 'TEMPLATE';
    };
    const branchNodeIdOf = (run: (typeof runs)[number]): EffectWorkflowBranchNodeId | null =>
      EFFECT_WORKFLOW_BRANCH_NODES.find((node) => node === run.forkNodeId) ?? null;
    const mixForkTemplateId = (
      run: (typeof runs)[number],
      forkNodeId: EffectWorkflowBranchNodeId | null,
      stage: 'TEMPLATE' | 'FILL' | 'PACKAGING' | null,
    ): string | null => {
      if (run.forkTemplateId || forkNodeId !== 'TEMPLATE_MIX')
        return run.forkTemplateId ?? null;
      const prefix = stage === 'PACKAGING' ? 'timeline-package:'
        : stage === 'FILL' ? 'timeline-project:' : 'mix-template:';
      const parentTemplates = stage === 'TEMPLATE'
        ? new Map(
            (run.parentWorkflowRunId ? effectiveArtifacts(run.parentWorkflowRunId) : [])
              .filter((artifact) => artifact.artifactKey.startsWith(prefix))
              .map((artifact) => [artifact.artifactKey, committedTemplate(artifact.payload)]),
          )
        : null;
      const candidates = new Set(
        run.workingArtifacts
          .filter((artifact) => artifact.artifactKey.startsWith(prefix))
          .filter((artifact) => !parentTemplates ||
            parentTemplates.get(artifact.artifactKey) !== committedTemplate(artifact.payload))
          .map((artifact) => artifact.artifactKey.split(':')[1])
          .filter((id): id is string => Boolean(id)),
      );
      return candidates.size === 1 ? [...candidates][0]! : null;
    };
    // Display versions count siblings under the same upstream head, not all generations of a
    // template. Inherited worker records are copies, not new fill/package heads.
    type VersionStage = 'FILL' | 'PACKAGING' | 'DELIVERY';
    const fullFillHead = (aiRun: { idempotencyKey: string; inputSnapshot?: unknown }): boolean => {
      if (isInheritedFillKey(aiRun.idempotencyKey)) return false;
      const snapshot = aiRun.inputSnapshot && typeof aiRun.inputSnapshot === 'object' &&
        !Array.isArray(aiRun.inputSnapshot) ? aiRun.inputSnapshot as Record<string, unknown> : null;
      // APPEND and source trim repairs mutate the existing head. Counting their task rows as
      // new fill heads changes the packaging version scope and points the same visible ordinal
      // at another Run after a successful local update. Legacy full fills have no operation flags.
      return !snapshot?.incremental && !snapshot?.trimOnly;
    };
    const ownFill = (run: (typeof runs)[number], templateId: string): boolean =>
      (run.effectTemplateMixAiRuns ?? []).some((aiRun) =>
        aiRun.templateId === templateId && fullFillHead(aiRun)) &&
      run.workingArtifacts.some((artifact) =>
        artifact.artifactKey.startsWith(`timeline-project:${templateId}:`));
    const ownPackage = (run: (typeof runs)[number], templateId: string): boolean =>
      (run.effectPackagingRuns ?? []).some((packaging) =>
        packaging.templateId === templateId && packaging.status === 'COMPLETED' &&
        !packaging.idempotencyKey.includes(':package:')) &&
      run.workingArtifacts.some((artifact) =>
        artifact.artifactKey.startsWith(`timeline-package:${templateId}:`));
    const scopeCache = new Map<string, string>();
    const resolveVersionScope = (
      stage: VersionStage, run: (typeof runs)[number], templateId: string,
    ): string => {
      const visited = new Set<string>();
      // An output branch can be packaged in place after its files were delivered. Its original
      // output still consumed the parent head; adding packaging later must not renumber exports.
      const headRun = stage === 'DELIVERY' && run.forkNodeId === 'FINAL_OUTPUT' &&
        run.parentWorkflowRunId && run.workingArtifacts.some((artifact) =>
          artifact.artifactKey === `final-delivery:${templateId}`)
        ? byId.get(run.parentWorkflowRunId) ?? run : run;
      for (
        let cursor: (typeof runs)[number] | undefined = headRun;
        cursor && !visited.has(cursor.id);
        cursor = cursor.parentWorkflowRunId ? byId.get(cursor.parentWorkflowRunId) : undefined
      ) {
        visited.add(cursor.id);
        if (stage === 'DELIVERY' && ownPackage(cursor, templateId)) return cursor.id;
        if (stage !== 'FILL' && ownFill(cursor, templateId)) {
          // A new fill head discards the old package, including for picture-only exports.
          return cursor.id;
        }
        const forkNodeId = branchNodeIdOf(cursor);
        const mixStage = mixForkStage(cursor, forkNodeId);
        if (!cursor.parentWorkflowRunId ||
          (forkNodeId && forkNodeId !== 'TEMPLATE_MIX' && forkNodeId !== 'FINAL_OUTPUT') ||
          (mixStage === 'TEMPLATE' &&
            mixForkTemplateId(cursor, forkNodeId, mixStage) === templateId))
          return cursor.id;
      }
      return root.id;
    };
    const versionScope = (
      stage: VersionStage, run: (typeof runs)[number], templateId: string,
    ): string => {
      const key = `${stage}:${run.id}:${templateId}`;
      const cached = scopeCache.get(key);
      if (cached !== undefined) return cached;
      const scope = resolveVersionScope(stage, run, templateId);
      scopeCache.set(key, scope);
      return scope;
    };
    const owners: Record<VersionStage, Map<string, number>> = {
      FILL: new Map(), PACKAGING: new Map(), DELIVERY: new Map(),
    };
    const totals: Record<VersionStage, Map<string, number>> = {
      FILL: new Map(), PACKAGING: new Map(), DELIVERY: new Map(),
    };
    const recordVersion = (
      stage: VersionStage, runId: string, templateId: string,
    ): void => {
      const run = byId.get(runId);
      if (!run) return;
      const scope = `${versionScope(stage, run, templateId)}:${templateId}`;
      // A published branch occupies one ordinal. In-place confirmations advance content
      // revisions only; neither their revision values nor the number of films reserve versions.
      const next = (totals[stage].get(scope) ?? 0) + 1;
      totals[stage].set(scope, next);
      owners[stage].set(`${runId}:${templateId}`, next);
    };
    const publishedRuns = runs
      .filter((run) => inTree.has(run.id) && drawn(run))
      .sort((left, right) =>
        (left.branchPublishedAt ?? left.createdAt).getTime() -
          (right.branchPublishedAt ?? right.createdAt).getTime() ||
        left.createdAt.getTime() - right.createdAt.getTime() ||
        left.id.localeCompare(right.id));
    for (const run of publishedRuns) {
      const templateIds = new Set(run.workingArtifacts
        .map((artifact) => /^(?:timeline-project|timeline-package|final-delivery):([^:]+)/
          .exec(artifact.artifactKey)?.[1])
        .filter((id): id is string => Boolean(id)));
      for (const templateId of templateIds) {
        if (ownFill(run, templateId))
          recordVersion('FILL', run.id, templateId);
        const delivery = run.workingArtifacts.find(
          (artifact) => artifact.artifactKey === `final-delivery:${templateId}`);
        if (delivery && (!run.parentWorkflowRunId || run.forkNodeId === 'FINAL_OUTPUT'))
          recordVersion('DELIVERY', run.id, templateId);
      }
    }
    // A picture-only delivery can receive its first package later in the same Run. Number
    // packaging by task completion, not by the older delivery branch publication time.
    const packagingEvents = publishedRuns.flatMap((run) => {
      const templateIds = new Set((run.effectPackagingRuns ?? [])
        .filter((packaging) => packaging.status === 'COMPLETED' &&
          !packaging.idempotencyKey.includes(':package:'))
        .map((packaging) => packaging.templateId));
      return [...templateIds].map((templateId) => {
        const revisions = run.workingArtifacts
          .filter((artifact) => artifact.artifactKey.startsWith(`timeline-package:${templateId}:`))
          .map((artifact) => artifact.revision);
        // First completion establishes this head. Later APPEND packaging belongs to the same
        // head and must not move it after sibling packages or renumber all existing versions.
        const completedAt = Math.min(...(run.effectPackagingRuns ?? [])
          .filter((packaging) => packaging.templateId === templateId &&
            packaging.status === 'COMPLETED' && !packaging.idempotencyKey.includes(':package:'))
          .map((packaging) => packaging.completedAt?.getTime() ??
            (run.branchPublishedAt ?? run.createdAt).getTime()));
        // A package head is one branch version. Editing/updating films in place advances their
        // artifact revisions, not the branch ordinal (otherwise version 01 disappears after an update).
        return { runId: run.id, templateId, units: revisions.length ? 1 : 0,
          completedAt: completedAt || (run.branchPublishedAt ?? run.createdAt).getTime() };
      });
    }).sort((left, right) => left.completedAt - right.completedAt ||
      left.runId.localeCompare(right.runId));
    for (const event of packagingEvents)
      if (event.units) recordVersion('PACKAGING', event.runId, event.templateId);
    const versionOf = (
      stage: VersionStage, run: (typeof runs)[number], templateId: string,
    ): number | null => {
      const visited = new Set<string>();
      const scope = versionScope(stage, run, templateId);
      for (
        let cursor: (typeof runs)[number] | undefined = run;
        cursor && !visited.has(cursor.id);
        cursor = cursor.parentWorkflowRunId ? byId.get(cursor.parentWorkflowRunId) : undefined
      ) {
        visited.add(cursor.id);
        const version = owners[stage].get(`${cursor.id}:${templateId}`);
        if (version !== undefined && versionScope(stage, cursor, templateId) === scope)
          return version;
      }
      return null;
    };
    const projected = projectEffectBranchFreshness(runs, runs.flatMap((run) => run.workingArtifacts));
    const freshnessById = new Map(projected.filter((artifact) => artifact.id)
      .map((artifact) => [artifact.id, artifact.freshness]));
    const artifactStatus = (artifacts: BranchArtifact[]) => artifacts.some((artifact) =>
      (freshnessById.get(artifact.id) ?? artifact.freshness) === 'STALE')
      ? 'STALE' as const : artifacts.length ? 'CONFIRMED' as const : 'PENDING' as const;
    const branches: EffectWorkflowBranch[] = runs
      .filter((run) => inTree.has(run.id) && drawn(run))
      .map((run) => {
        const currentDraftTemplates = draftTemplatesFor(run);
        // Removed projects retain their artifacts for existing deliveries and historical branches.
        // They are no longer editable mix projects in this Run and must not keep its fill/package
        // counts or freshness stale. Missing legacy variant lists are unknown, not empty lists.
        const visibleArtifacts = effectiveArtifacts(run.id).filter((artifact) => {
          const match = /^(?:timeline-project|timeline-package):([^:]+):(.+)$/.exec(artifact.artifactKey);
          if (!match || !currentDraftTemplates) return true;
          const template = currentDraftTemplates.get(match[1]!);
          return Boolean(template && (template.variantIds === null || template.variantIds.includes(match[2]!)));
        });
        const forkNodeId = branchNodeIdOf(run);
        const forkMixStage = mixForkStage(run, forkNodeId);
        const forkTemplateId = mixForkTemplateId(run, forkNodeId, forkMixStage);
        const currentTemplateIds = currentDraftTemplates ? new Set(currentDraftTemplates.keys()) : null;
        const templatesById = new Map<string, EffectWorkflowBranch['templates'][number]>();
        for (const artifact of visibleArtifacts) {
          const match =
            /^(mix-template|timeline-project|timeline-package|final-delivery):([^:]+)(?::.+)?$/.exec(
              artifact.artifactKey,
            );
          if (!match || !match[2]) continue;
          const template = templatesById.get(match[2]) ?? {
            templateId: match[2],
            name: `模板 ${match[2].slice(0, 8)}`,
            templateCreatedAt: null,
            templateRevision: null,
            templateRevisions: [],
            fillRevision: null,
            fillRevisions: [],
            fillCreatedAt: null,
            packagingRevision: null,
            packagingRevisions: [],
            packagingCreatedAt: null,
            timelineVariantCount: 0,
            packagingVariantCount: 0,
            deliveryRevision: null,
            deliveryRevisions: [],
            deliveryCount: 0,
            deliveryCreatedAt: null,
          };
          if (match[1] === 'mix-template') {
            template.name = artifact.name;
            template.templateCreatedAt = artifact.createdAt.toISOString();
            template.templateRevision = artifact.revision;
            template.templateRevisions = [artifact.revision];
          } else if (match[1] === 'timeline-project') template.timelineVariantCount += 1;
          else if (match[1] === 'timeline-package') {
            template.packagingVariantCount += 1;
          } else {
            template.deliveryRevision = artifact.revision;
            template.deliveryRevisions = [artifact.revision];
            template.deliveryCount = 1;
          }
          templatesById.set(match[2], template);
        }
        // A mix draft must not make the version path jump over an unfinished render node.
        // A confirmed clip is render output too: imported/replaced clips can make template
        // creation available without a render-batch artifact in this branch.
        const renderHasConfirmedOutput = visibleArtifacts.some(
          (artifact) =>
            artifact.nodeId === 'SEGMENT_RENDER' &&
            (artifact.artifactKey.startsWith('render-batch:') ||
              artifact.artifactKey.startsWith('render-clip:')),
        );
        for (const state of renderHasConfirmedOutput ? (run.nodeStates ?? []) : []) {
          for (const draftTemplate of mixDraftTemplates(state.state)) {
            const template: EffectWorkflowBranch['templates'][number] = templatesById.get(
              draftTemplate.id,
            ) ?? {
              templateId: draftTemplate.id,
              name: draftTemplate.name,
              templateCreatedAt: null,
              templateRevision: null,
              templateRevisions: [],
              fillRevision: null,
              fillRevisions: [],
              fillCreatedAt: null,
              packagingRevision: null,
              packagingRevisions: [],
              packagingCreatedAt: null,
              timelineVariantCount: 0,
              packagingVariantCount: 0,
              deliveryRevision: null,
              deliveryRevisions: [],
              deliveryCount: 0,
              deliveryCreatedAt: null,
            };
            template.name = draftTemplate.name;
            template.templateCreatedAt =
              draftTemplate.createdAt ?? template.templateCreatedAt ?? null;
            const variantIds = new Set(draftTemplate.variantIds ?? []);
            const completedFills = (run.effectTemplateMixAiRuns ?? []).filter(
              (aiRun) =>
                aiRun.templateId === draftTemplate.id &&
                fullFillHead(aiRun) &&
                aiRun.outputVariantId !== null &&
                variantIds.has(aiRun.outputVariantId),
            );
            template.draftFillReady = completedFills.length > 0;
            templatesById.set(draftTemplate.id, template);
          }
        }
        for (const template of templatesById.values()) {
          template.currentSelectedAt = selectedEffectTemplatePaths(run.id, run.nodeStates ?? [])[template.templateId] ?? null;
          const ownedIds = new Map(visibleArtifacts.filter((artifact) =>
            artifact.workflowRunId === run.id &&
            /^(?:mix-template|timeline-project|timeline-package|final-delivery|final-video):/.test(artifact.artifactKey) &&
            artifact.artifactKey.split(':')[1] === template.templateId &&
            !(artifact.metadata && typeof artifact.metadata === 'object' &&
              !Array.isArray(artifact.metadata) && 'branchSource' in artifact.metadata),
          ).map((artifact) => [artifact.id, artifact.revision]));
          // Freshness invalidation changes updatedAt too. Only an immutable confirmation of
          // the current local revision may select a template's current workflow.
          const confirmations = (run.workingArtifactRevisions ?? []).filter((snapshot) =>
            ownedIds.get(snapshot.workingArtifactId) === snapshot.revision);
          template.currentConfirmedAt = confirmations.length
            ? new Date(Math.max(...confirmations.map((snapshot) => snapshot.confirmedAt.getTime()))).toISOString()
            : null;
          const fills = visibleArtifacts.filter((artifact) =>
            artifact.artifactKey.startsWith(`timeline-project:${template.templateId}:`),
          );
          const packages = visibleArtifacts.filter((artifact) =>
            artifact.artifactKey.startsWith(`timeline-package:${template.templateId}:`),
          );
          const deliveries = visibleArtifacts.filter(
            (artifact) => artifact.artifactKey === `final-delivery:${template.templateId}`,
          );
          template.fillRevisions = revisionsOf(fills);
          template.packagingRevisions = revisionsOf(packages);
          template.fillRevision = versionOf('FILL', run, template.templateId);
          template.packagingRevision = packages.length
            ? versionOf('PACKAGING', run, template.templateId) : null;
          template.deliveryRevision = deliveries.length
            ? versionOf('DELIVERY', run, template.templateId) : null;
          template.deliveryRevisions = template.deliveryRevision === null
            ? [] : [template.deliveryRevision];
          template.fillCreatedAt = artifactCreatedAt(fills);
          template.packagingCreatedAt = artifactCreatedAt(packages);
          template.deliveryCreatedAt = artifactCreatedAt(deliveries);
          template.templateStatus = artifactStatus(visibleArtifacts.filter((artifact) =>
            artifact.artifactKey === `mix-template:${template.templateId}`));
          template.fillStatus = artifactStatus(fills);
          template.packagingStatus = artifactStatus(packages);
          // Delivery manifests freeze files and deliberately have no source dependencies. Include
          // their per-film artifacts so a changed source still warns on the output tree node.
          template.deliveryStatus = artifactStatus([...deliveries, ...visibleArtifacts.filter((artifact) =>
            artifact.artifactKey.startsWith(`final-video:${template.templateId}:`))]);
        }
        return {
          workflowRunId: run.id,
          parentWorkflowRunId:
            nearestDrawn(run.parentWorkflowRunId ? byId.get(run.parentWorkflowRunId) : undefined)
              ?.id ?? null,
          creationKind: !run.parentWorkflowRunId ? 'INITIAL' as const
            : run.forkNodeId === 'MANUAL_COPY' ? 'MANUAL_COPY' as const
              : 'NODE_CHANGE' as const,
          forkNodeId,
          forkTemplateId,
          forkMixStage,
          packagingInOutputBranch: forkNodeId === 'FINAL_OUTPUT' && Boolean(
            forkTemplateId && run.workingArtifacts.some((artifact) =>
              artifact.artifactKey.startsWith(`timeline-package:${forkTemplateId}:`)) &&
            (run.effectPackagingRuns ?? []).some((packaging) =>
              packaging.templateId === forkTemplateId && packaging.status === 'COMPLETED' &&
              !packaging.idempotencyKey.includes(':package:')),
          ),
          label: run.branchLabel ?? (run.id === root.id ? '主干' : '未命名分支'),
          currentNodeId: run.currentNodeId,
          createdAt: run.createdAt.toISOString(),
          isActive: run.id === active.id,
          templates: [...templatesById.values()].filter((template) =>
            !currentTemplateIds || currentTemplateIds.has(template.templateId),
          ),
          nodes: EFFECT_WORKFLOW_BRANCH_NODES.map((nodeId) => {
            const local = visibleArtifacts.filter((artifact) => artifact.nodeId === nodeId);
            // A copied upstream snapshot can be stale for this mix branch without making the
            // actual render/Prompt head stale. Display the head's status, not its consumers'.
            const owner = effectArtifactSourceOwner(runs, run.id, nodeId,
              runs.flatMap((branch) => branch.workingArtifacts));
            let statusArtifacts = EFFECT_WORKFLOW_BRANCH_NODES.indexOf(nodeId) < 4
              ? (byId.get(owner)?.workingArtifacts.filter((artifact) => artifact.nodeId === nodeId) ?? local)
              : local;
            if (nodeId === 'SEGMENT_RENDER') {
              const clips = effectRenderClipHeads(runs, run.id, runs.flatMap((branch) => branch.workingArtifacts));
              if (clips.size) statusArtifacts = [...statusArtifacts.filter((artifact) =>
                !artifact.artifactKey.startsWith('render-clip:')), ...clips.values()];
            }
            const revisionArtifacts = local.filter((artifact) =>
              artifact.artifactKey.startsWith(revisionKeyPrefix[nodeId]),
            );
            const count = {
              current: statusArtifacts.filter((artifact) => (freshnessById.get(artifact.id) ?? artifact.freshness) === 'CURRENT').length,
              stale: statusArtifacts.filter((artifact) => (freshnessById.get(artifact.id) ?? artifact.freshness) === 'STALE').length,
            };
            return {
              nodeId,
              status: count.stale
                ? ('STALE' as const)
                : count.current
                  ? ('CONFIRMED' as const)
                  : ('PENDING' as const),
              artifactCount: count.current + count.stale,
              revisions: revisionsOf(revisionArtifacts),
              revision: sharedRevision(revisionArtifacts),
              artifactCreatedAt: artifactCreatedAt(revisionArtifacts),
            };
          }),
        };
      });
    return { projectId, activeWorkflowRunId: active.id, branches };
  }

  async activateEffectBranch(
    projectId: string,
    workflowRunId: string,
    templateId?: string | null,
  ): Promise<ActivateEffectWorkflowBranchData> {
    await this.projectService.get(projectId);
    const run = await this.repository.activateEffectRunBranch(projectId, workflowRunId, templateId);
    if (!run)
      throw new ApiHttpException(
        '该分支尚未完成工作区迁移，无法安全切换',
        HttpStatus.CONFLICT,
        'CONFLICT',
      );
    return { run: toRun(run) };
  }

  async createEffectManualBranch(projectId: string, parentRunId: string,
    idempotencyKey: string): Promise<CreateEffectWorkflowBranchData> {
    await this.projectService.get(projectId);
    const key = `manual:${parentRunId}:${idempotencyKey.trim()}`;
    if (key.length > 160) throw new ApiHttpException('幂等键过长', HttpStatus.BAD_REQUEST, 'VALIDATION_ERROR');
    const childId = await this.repository.createEffectManualBranch(projectId, parentRunId, key);
    if (!childId) throw new ApiHttpException('当前分支无法复制，请先保存或取消编辑',
      HttpStatus.CONFLICT, 'CONFLICT');
    const [run, active] = await Promise.all([
      this.repository.findRun(projectId, childId),
      this.repository.findActiveRun(projectId, 'EFFECT', 'EFFECT'),
    ]);
    if (!run || !active) throw new Error('EFFECT_MANUAL_BRANCH_MISSING');
    return { run: toRun(run), parentWorkflowRunId: parentRunId,
      activeWorkflowRunId: active.id };
  }

  async getNodeState(projectId: string, workflowRunId: string, nodeId: string) {
    await this.projectService.get(projectId);
    const run = await this.repository.findRun(projectId, workflowRunId);
    if (!run)
      throw new ApiHttpException('工作流运行不存在', HttpStatus.NOT_FOUND, 'ASSET_NOT_FOUND');
    const state = await this.repository.findNodeState(projectId, workflowRunId, nodeId);
    if (!state)
      throw new ApiHttpException('节点草稿不存在', HttpStatus.NOT_FOUND, 'ASSET_NOT_FOUND');
    return toNodeState(state);
  }

  async putNodeState(
    projectId: string,
    workflowRunId: string,
    nodeId: string,
    input: PutWorkflowNodeStateRequest,
  ): Promise<PutWorkflowNodeStateData> {
    await this.projectService.get(projectId);
    if (!nodeId.trim() || nodeId.length > 160)
      throw new ApiHttpException('节点标识无效', HttpStatus.BAD_REQUEST, 'VALIDATION_ERROR');
    const executionInputSchemaVersion = 1;
    const executionInputHash = this.executionInputHash();
    const result = await this.repository.saveNodeState(
      projectId,
      workflowRunId,
      nodeId,
      workflowStateHash(input.state),
      input.state,
      input.expectedRevision,
      input.schemaVersion ?? 1,
      executionInputHash,
      executionInputSchemaVersion,
    );
    if (result.conflict)
      throw new ApiHttpException(
        '节点内容已在其他页面更新，请刷新后重试',
        HttpStatus.CONFLICT,
        'CONFLICT',
      );
    return { nodeState: toNodeState(result.record), unchanged: result.unchanged };
  }

  async activateNode(
    projectId: string,
    workflowRunId: string,
    nodeId: string,
  ): Promise<ActivateWorkflowNodeData> {
    await this.projectService.get(projectId);
    if (!nodeId.trim() || nodeId.length > 160)
      throw new ApiHttpException('节点标识无效', HttpStatus.BAD_REQUEST, 'VALIDATION_ERROR');
    const run = await this.repository.activateNode(projectId, workflowRunId, nodeId);
    if (!run)
      throw new ApiHttpException('工作流运行不存在', HttpStatus.NOT_FOUND, 'ASSET_NOT_FOUND');
    return { run: toRun(run) };
  }

  async replaceNodeStateBaseline(
    projectId: string,
    workflowRunId: string,
    nodeId: string,
    state: unknown,
  ): Promise<WorkflowNodeState> {
    return toNodeState(
      await this.repository.replaceNodeState(
        projectId,
        workflowRunId,
        nodeId,
        workflowStateHash(state),
        state,
        1,
        this.executionInputHash(),
      ),
    );
  }

  async getNodeStateOrNull(projectId: string, workflowRunId: string, nodeId: string) {
    const state = await this.repository.findNodeState(projectId, workflowRunId, nodeId);
    return state ? toNodeState(state) : null;
  }

  async listArtifacts(
    projectId: string,
    filters: WorkingArtifactListQuery,
  ): Promise<WorkingArtifactListData> {
    await this.projectService.get(projectId);
    if (filters.view === 'SNAPSHOT' && !filters.workflowRunId)
      throw new ApiHttpException('查看版本快照必须指定工作流运行', HttpStatus.BAD_REQUEST, 'VALIDATION_ERROR');
    const items = await this.repository.listArtifacts(projectId, {
      ...(filters.view ? { view: filters.view } : {}),
      ...(filters.workflowRunId ? { workflowRunId: filters.workflowRunId } : {}),
      ...(filters.nodeId ? { nodeId: filters.nodeId } : {}),
      ...(filters.workflow ? { workflow: filters.workflow } : {}),
      ...(filters.space ? { space: filters.space } : {}),
    });
    return { items: items.map(toArtifact), total: items.length };
  }

  async content(
    projectId: string,
    artifactId: string,
    rangeHeader?: string,
  ): Promise<WorkingArtifactContent> {
    const record = await this.repository.findArtifact(projectId, artifactId);
    if (!record || !record.storageKey || !record.mimeType || !record.originalFileName)
      throw new ApiHttpException('工作副本文件不存在', HttpStatus.NOT_FOUND, 'ASSET_NOT_FOUND');
    const kind = previewKind(record.mimeType);
    const partialAllowed = kind === 'AUDIO' || kind === 'VIDEO';
    const opened =
      rangeHeader && partialAllowed
        ? await this.storage.open(record.storageKey, parseRange(rangeHeader, record.sizeBytes ?? 0))
        : await this.storage.open(record.storageKey);
    return {
      ...opened,
      mimeType: record.mimeType,
      originalFileName: safeOriginalFileName(record.originalFileName),
      previewKind: kind,
      partial: Boolean(rangeHeader && partialAllowed),
    };
  }

  async pauseRun(projectId: string, workflowRunId: string): Promise<{ paused: true }> {
    await this.projectService.get(projectId);
    const result = await this.repository.pauseRun(projectId, workflowRunId);
    if (result.count === 0)
      throw new ApiHttpException('工作流运行不存在', HttpStatus.NOT_FOUND, 'ASSET_NOT_FOUND');
    return { paused: true };
  }

  async fileObjectContent(
    projectId: string,
    fileObjectId: string,
    rangeHeader?: string,
  ): Promise<WorkingArtifactContent> {
    const record = await this.repository.findFileObject(projectId, fileObjectId);
    if (!record || record.status === 'ORPHANED')
      throw new ApiHttpException('工作文件不存在', HttpStatus.NOT_FOUND, 'ASSET_NOT_FOUND');
    const kind = previewKind(record.mimeType);
    const partialAllowed = kind === 'AUDIO' || kind === 'VIDEO';
    const opened =
      rangeHeader && partialAllowed
        ? await this.storage.open(record.storageKey, parseRange(rangeHeader, record.sizeBytes))
        : await this.storage.open(record.storageKey);
    return {
      ...opened,
      mimeType: record.mimeType,
      originalFileName: safeOriginalFileName(record.originalFileName),
      previewKind: kind,
      partial: Boolean(rangeHeader && partialAllowed),
    };
  }

  async commitValidatedArtifacts(
    projectId: string,
    workflowRunId: string,
    nodeId: string,
    artifacts: Array<{ artifactKey: string; input: WorkingArtifactUpsertInput }>,
    frozenRenderSources?: readonly import('@ai-marketing/contracts').EffectTemplateMixMaterial[],
  ): Promise<Array<{ artifact: WorkingArtifact; unchanged: boolean }>> {
    const results = await this.repository.commitValidatedArtifacts(
      projectId,
      workflowRunId,
      nodeId,
      artifacts,
      frozenRenderSources,
    );
    for (const result of results) {
      const input = artifacts.find(
        (artifact) => artifact.artifactKey === result.artifactKey,
      )?.input;
      if (result.previousStorageKey && result.previousStorageKey !== input?.storageKey)
        await this.deleteOrQueue(projectId, result.previousStorageKey, 'WORKING_ARTIFACT_REPLACED');
    }
    return results.map((result) => ({
      artifact: toArtifact(result.record),
      unchanged: result.unchanged,
    }));
  }

  async removeArtifact(
    projectId: string,
    workflowRunId: string,
    nodeId: string,
    artifactKey: string,
  ): Promise<boolean> {
    const removed = await this.repository.deleteArtifact(
      projectId,
      workflowRunId,
      nodeId,
      artifactKey,
    );
    if (removed?.storageKey)
      await this.deleteOrQueue(projectId, removed.storageKey, 'WORKING_ARTIFACT_DELETED');
    return Boolean(removed);
  }

  private async deleteOrQueue(projectId: string, storageKey: string, reason: string) {
    await this.repository.enqueueCleanup(projectId, storageKey, reason);
  }

  private executionInputHash(): string {
    // The extraction node currently has no independent AI execution controls.
    // Page recovery/UI fields must never enter the execution dependency. When a
    // real control is introduced it must be added here through an explicit whitelist.
    return workflowStateHash({ schemaVersion: 1 });
  }
}
