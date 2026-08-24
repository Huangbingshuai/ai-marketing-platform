import type {
  AssetPreviewKind,
  PutWorkflowNodeStateData,
  PutWorkflowNodeStateRequest,
  WorkingArtifact,
  WorkingArtifactListData,
  WorkingArtifactListQuery,
  WorkflowNodeState,
} from '@ai-marketing/contracts';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { WorkingArtifact as WorkingArtifactRecord } from '../../generated/prisma/client';
import { ApiHttpException } from '../../common/api-http-exception';
import type { StoragePort, StorageRange, StoredStream } from '../file/storage.port';
import { STORAGE_PORT } from '../file/storage.port';
import { normalizeMultipartFileName, safeOriginalFileName } from '../file/file-name';
import { ProjectService } from '../project/project.service';
import {
  WorkflowWorkingRepository,
  type WorkingArtifactUpsertInput,
} from './workflow-working.repository';
import { workflowStateHash } from './workflow-state-hash';

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

const toNodeState = (record: {
  id: string;
  projectId: string;
  workflowRunId: string;
  nodeId: string;
  schemaVersion: number;
  revision: number;
  contentHash: string;
  state: unknown;
  savedAt: Date;
  updatedAt: Date;
}): WorkflowNodeState => ({
  ...record,
  savedAt: record.savedAt.toISOString(),
  updatedAt: record.updatedAt.toISOString(),
});

const toArtifact = (record: WorkingArtifactRecord): WorkingArtifact => {
  const contentPath = `/api/projects/${record.projectId}/working-artifacts/${record.id}/content`;
  const originalFileName = record.originalFileName
    ? safeOriginalFileName(record.originalFileName)
    : null;
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
    const result = await this.repository.saveNodeState(
      projectId,
      workflowRunId,
      nodeId,
      workflowStateHash(input.state),
      input.state,
      input.expectedRevision,
      input.schemaVersion ?? 1,
    );
    if (result.conflict)
      throw new ApiHttpException(
        '节点内容已在其他页面更新，请刷新后重试',
        HttpStatus.CONFLICT,
        'CONFLICT',
      );
    return { nodeState: toNodeState(result.record), unchanged: result.unchanged };
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

  async upsertArtifact(
    projectId: string,
    workflowRunId: string,
    nodeId: string,
    artifactKey: string,
    input: WorkingArtifactUpsertInput,
  ): Promise<WorkingArtifact> {
    const result = await this.repository.upsertArtifact(
      projectId,
      workflowRunId,
      nodeId,
      artifactKey,
      input,
    );
    if (result.previousStorageKey && result.previousStorageKey !== input.storageKey)
      await this.deleteOrQueue(projectId, result.previousStorageKey, 'WORKING_ARTIFACT_REPLACED');
    return toArtifact(result.record);
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
    try {
      await this.storage.delete(storageKey);
    } catch {
      await this.repository.enqueueCleanup(projectId, storageKey, reason);
    }
  }
}
