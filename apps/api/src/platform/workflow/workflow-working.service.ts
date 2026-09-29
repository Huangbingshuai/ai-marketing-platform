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
import type { EffectEditBeginOptions } from './effect-edit-session';

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
): Array<{ id: string; name: string; createdAt: string | null; variantIds: string[] }> => {
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
      : [];
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
    let active = runs.find((run) => run.activeKey === 'ACTIVE') ?? null;
    if (!active) {
      // A hidden edit child owns the active pointer, but must not appear in the tree.
      let cursor = await this.repository.findActiveRun(projectId, 'EFFECT', 'EFFECT');
      const seen = new Set<string>();
      while (cursor?.parentWorkflowRunId && !seen.has(cursor.id)) {
        seen.add(cursor.id);
        active = runs.find((run) => run.id === cursor!.parentWorkflowRunId) ?? null;
        if (active) break;
        cursor = await this.repository.findRun(projectId, cursor.parentWorkflowRunId);
      }
    }
    if (!active) return { projectId, activeWorkflowRunId: null, branches: [] };
    const byId = new Map(runs.map((run) => [run.id, run]));
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
    const branches: EffectWorkflowBranch[] = runs
      .filter((run) => inTree.has(run.id))
      .map((run) => {
        const visibleArtifacts = effectiveArtifacts(run.id);
        const forkNodeId =
          EFFECT_WORKFLOW_BRANCH_NODES.find((node) => node === run.forkNodeId) ?? null;
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
        // Keep the draft in the workspace, but project it into the tree only once this Run
        // has an actual confirmed render output to connect it to.
        const renderHasConfirmedOutput = visibleArtifacts.some(
          (artifact) =>
            artifact.nodeId === 'SEGMENT_RENDER' &&
            artifact.artifactKey.startsWith('render-batch:'),
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
            const variantIds = new Set(draftTemplate.variantIds);
            const completedFills = (run.effectTemplateMixAiRuns ?? []).filter(
              (aiRun) =>
                aiRun.templateId === draftTemplate.id &&
                aiRun.outputVariantId !== null &&
                variantIds.has(aiRun.outputVariantId),
            );
            template.draftFillReady = completedFills.length > 0;
            templatesById.set(draftTemplate.id, template);
          }
        }
        for (const template of templatesById.values()) {
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
          template.fillRevision = sharedRevision(fills);
          template.packagingRevision = sharedRevision(packages);
          template.fillCreatedAt = artifactCreatedAt(fills);
          template.packagingCreatedAt = artifactCreatedAt(packages);
          template.deliveryCreatedAt = artifactCreatedAt(deliveries);
        }
        return {
          workflowRunId: run.id,
          parentWorkflowRunId:
            run.parentWorkflowRunId && inTree.has(run.parentWorkflowRunId)
              ? run.parentWorkflowRunId
              : null,
          creationKind: !run.parentWorkflowRunId ? 'INITIAL' as const
            : run.forkNodeId === 'MANUAL_COPY' ? 'MANUAL_COPY' as const
              : 'NODE_CHANGE' as const,
          forkNodeId,
          forkTemplateId: run.forkTemplateId,
          forkMixStage:
            forkNodeId !== 'TEMPLATE_MIX'
              ? null
              : run.workingArtifacts.some((artifact) =>
                    artifact.artifactKey.startsWith('mix-template:'),
                  )
                ? 'TEMPLATE'
                : run.workingArtifacts.some((artifact) =>
                      artifact.artifactKey.startsWith('timeline-project:'),
                    )
                  ? 'FILL'
                  : run.workingArtifacts.some((artifact) =>
                        artifact.artifactKey.startsWith('timeline-package:'),
                      )
                    ? 'PACKAGING'
                    : 'TEMPLATE',
          label: run.branchLabel ?? (run.id === root.id ? '主干' : '未命名分支'),
          currentNodeId: run.currentNodeId,
          createdAt: run.createdAt.toISOString(),
          isActive: run.id === active.id,
          templates: [...templatesById.values()],
          nodes: EFFECT_WORKFLOW_BRANCH_NODES.map((nodeId) => {
            const local = visibleArtifacts.filter((artifact) => artifact.nodeId === nodeId);
            const revisionArtifacts = local.filter((artifact) =>
              artifact.artifactKey.startsWith(revisionKeyPrefix[nodeId]),
            );
            const count = {
              current: local.filter((artifact) => artifact.freshness === 'CURRENT').length,
              stale: local.filter((artifact) => artifact.freshness === 'STALE').length,
            };
            return {
              nodeId,
              status: count.current
                ? ('CONFIRMED' as const)
                : count.stale
                  ? ('STALE' as const)
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
  ): Promise<ActivateEffectWorkflowBranchData> {
    await this.projectService.get(projectId);
    const run = await this.repository.activateEffectRunBranch(projectId, workflowRunId);
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
    const items = await this.repository.listArtifacts(projectId, {
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
  ): Promise<Array<{ artifact: WorkingArtifact; unchanged: boolean }>> {
    const results = await this.repository.commitValidatedArtifacts(
      projectId,
      workflowRunId,
      nodeId,
      artifacts,
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
