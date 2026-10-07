import type {
  ActivateEffectWorkflowBranchData,
  ActivateWorkflowNodeData,
  CreateEffectWorkflowBranchData,
  ApiResponse,
  EffectWorkflowBranchTreeData,
  EffectWorkflowBranchNodeId,
  EffectWorkflowEditableNodeId,
  EffectWorkflowEditSessionData,
  EffectWorkflowEditExitData,
  EffectWorkflowEditPublishData,
  PutWorkflowNodeStateData,
  PutWorkflowNodeStateRequest,
  WorkingArtifactListData,
  WorkingArtifactListQuery,
  WorkingArtifact,
  WorkflowNodeState,
  WorkflowRunOverviewData,
} from '@ai-marketing/contracts';
import { ApiClientError, isNetworkError, requestJson } from '../../../api/http-client';

const projectPath = (projectId: string): string => `/projects/${encodeURIComponent(projectId)}`;

const waitForBranchRetry = (delayMs: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener('abort', onAbort, { once: true });
  });

const branchRevisionPrefixes: Record<EffectWorkflowBranchNodeId, string> = {
  SOURCE_IMPORT: 'source-package:',
  INFORMATION_EXTRACTION: 'marketing-insight:',
  PROMPT_GENERATION: 'prompt-batch:',
  SEGMENT_RENDER: 'render-batch:',
  TEMPLATE_MIX: 'mix-template:',
  FINAL_OUTPUT: 'final-delivery:',
};
const revisionsOf = (artifacts: WorkingArtifact[]): number[] =>
  [...new Set(artifacts.map((artifact) => artifact.revision))].sort((a, b) => a - b);
const singleRevision = (revisions: number[]): number | null =>
  revisions.length === 1 ? revisions[0]! : null;
const artifactCreatedAt = (artifacts: WorkingArtifact[]): string | null =>
  artifacts.length
    ? new Date(
        Math.min(...artifacts.map((artifact) => Date.parse(artifact.createdAt))),
      ).toISOString()
    : null;

// Compatibility for a running older API process whose branch DTO predates revision fields.
// Read confirmed revisions from its authoritative project-scoped WorkingArtifact endpoint.
const restoreRootBranchRevisions = async (
  projectId: string,
  tree: EffectWorkflowBranchTreeData,
  signal?: AbortSignal,
): Promise<EffectWorkflowBranchTreeData> => {
  const branches = await Promise.all(
    tree.branches.map(async (branch) => {
      if (
        branch.parentWorkflowRunId ||
        !branch.nodes.some(
          (node) =>
            node.artifactCount > 0 &&
            ((node.revision === undefined && !node.revisions?.length) ||
              node.artifactCreatedAt === undefined),
        )
      )
        return branch;
      const result = await listWorkingArtifacts(
        projectId,
        {
          workflowRunId: branch.workflowRunId,
          workflow: 'EFFECT',
          space: 'EFFECT',
        },
        signal,
      );
      const artifacts = result.data.items;
      const matching = (prefix: string) =>
        artifacts.filter((artifact) => artifact.artifactKey.startsWith(prefix));
      const revisionsFor = (prefix: string) => revisionsOf(matching(prefix));
      return {
        ...branch,
        nodes: branch.nodes.map((node) => {
          const revisions = revisionsFor(branchRevisionPrefixes[node.nodeId]);
          return {
            ...node,
            revisions,
            revision: singleRevision(revisions),
            artifactCreatedAt: artifactCreatedAt(matching(branchRevisionPrefixes[node.nodeId])),
          };
        }),
        templates: branch.templates.map((template) => {
          const templateRevisions = revisionsFor(`mix-template:${template.templateId}`);
          const fillRevisions = revisionsFor(`timeline-project:${template.templateId}:`);
          const packagingRevisions = revisionsFor(`timeline-package:${template.templateId}:`);
          const deliveries = artifacts.filter(
            (artifact) => artifact.artifactKey === `final-delivery:${template.templateId}`,
          );
          const deliveryRevisions = revisionsOf(deliveries);
          return {
            ...template,
            templateRevision: singleRevision(templateRevisions),
            templateRevisions,
            fillRevision: singleRevision(fillRevisions),
            fillRevisions,
            fillCreatedAt: artifactCreatedAt(matching(`timeline-project:${template.templateId}:`)),
            packagingRevision: singleRevision(packagingRevisions),
            packagingRevisions,
            packagingCreatedAt: artifactCreatedAt(
              matching(`timeline-package:${template.templateId}:`),
            ),
            deliveryRevision: singleRevision(deliveryRevisions),
            deliveryRevisions,
            deliveryCount: deliveries.length,
            deliveryCreatedAt: artifactCreatedAt(deliveries),
          };
        }),
      };
    }),
  );
  return { ...tree, branches };
};

export const getEffectWorkflowBranchTree = async (
  projectId: string,
  signal?: AbortSignal,
): Promise<ApiResponse<EffectWorkflowBranchTreeData>> => {
  // Creating a template saves its draft immediately before this GET. A brief gateway restart or
  // overloaded read must not strand the open tree on its prefetched snapshot; this request is
  // read-only, so a bounded retry is safe. Never retry the draft write or branch activation here.
  const retryDelays = [200, 500];
  for (let attempt = 0; ; attempt++) {
    try {
      const result = await requestJson<ApiResponse<EffectWorkflowBranchTreeData>>(
        `${projectPath(projectId)}/workflow-runs/effect/branches`,
        { operation: '加载效果类版本分支树', signal },
      );
      return { ...result, data: await restoreRootBranchRevisions(projectId, result.data, signal) };
    } catch (error) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const retryable =
        (error instanceof ApiClientError && [502, 503, 504].includes(error.status)) ||
        isNetworkError(error);
      if (!retryable || attempt >= retryDelays.length) throw error;
      await waitForBranchRetry(retryDelays[attempt]!, signal);
    }
  }
};

export const activateEffectWorkflowBranch = (
  projectId: string,
  workflowRunId: string,
  signal?: AbortSignal,
  selection?: import('@ai-marketing/contracts').ActivateEffectWorkflowBranchRequest,
): Promise<ApiResponse<ActivateEffectWorkflowBranchData>> =>
  requestJson(
    `${projectPath(projectId)}/workflow-runs/effect/branches/${encodeURIComponent(workflowRunId)}/activate`,
    { method: 'POST', operation: '切换效果类版本分支', signal, ...(selection ? { body: selection } : {}) },
  );

export const createEffectWorkflowBranch = (
  projectId: string,
  workflowRunId: string,
  idempotencyKey: string,
): Promise<ApiResponse<CreateEffectWorkflowBranchData>> =>
  requestJson(
    `${projectPath(projectId)}/workflow-runs/effect/branches/${encodeURIComponent(workflowRunId)}/fork`,
    { method: 'POST', body: { idempotencyKey }, operation: '复制效果类工作流分支' },
  );

const effectEditPath = (
  projectId: string,
  workflowRunId: string,
  nodeId: EffectWorkflowEditableNodeId,
): string =>
  `${projectPath(projectId)}/workflow-runs/effect/branches/${encodeURIComponent(workflowRunId)}/nodes/${encodeURIComponent(nodeId)}/edit`;

export const beginEffectWorkflowNodeEdit = (
  projectId: string,
  workflowRunId: string,
  nodeId: EffectWorkflowEditableNodeId,
  signal?: AbortSignal,
): Promise<ApiResponse<EffectWorkflowEditSessionData>> =>
  requestJson(effectEditPath(projectId, workflowRunId, nodeId), {
    method: 'POST', operation: '进入效果类节点编辑', signal,
  });

export const cancelEffectWorkflowNodeEdit = (
  projectId: string,
  workflowRunId: string,
  nodeId: EffectWorkflowEditableNodeId,
  signal?: AbortSignal,
): Promise<ApiResponse<EffectWorkflowEditExitData>> =>
  requestJson(`${effectEditPath(projectId, workflowRunId, nodeId)}/cancel`, {
    method: 'POST', operation: '取消效果类节点编辑', signal,
  });

export const publishEffectWorkflowNodeEdit = (
  projectId: string,
  workflowRunId: string,
  nodeId: EffectWorkflowEditableNodeId,
  signal?: AbortSignal,
): Promise<ApiResponse<EffectWorkflowEditPublishData>> =>
  requestJson(`${effectEditPath(projectId, workflowRunId, nodeId)}/publish`, {
    method: 'POST', operation: '保存效果类节点版本', signal,
  });

export const beginEffectNodeEdit = beginEffectWorkflowNodeEdit;
export const cancelEffectNodeEdit = cancelEffectWorkflowNodeEdit;
export const publishEffectNodeEdit = publishEffectWorkflowNodeEdit;

export const activateWorkflowNode = (
  projectId: string,
  workflowRunId: string,
  nodeId: string,
  signal?: AbortSignal,
): Promise<ApiResponse<ActivateWorkflowNodeData>> =>
  requestJson(
    `${projectPath(projectId)}/workflow-runs/${encodeURIComponent(workflowRunId)}/nodes/${encodeURIComponent(nodeId)}/activate`,
    { method: 'POST', operation: '更新当前工作流节点', signal },
  );

export const getActiveWorkflowRunOverview = (
  projectId: string,
  workflow: WorkingArtifactListQuery['workflow'],
  space: WorkingArtifactListQuery['space'],
  signal?: AbortSignal,
): Promise<ApiResponse<WorkflowRunOverviewData>> => {
  const search = new URLSearchParams({ workflow: workflow!, space: space! });
  return requestJson(`${projectPath(projectId)}/workflow-runs/active/overview?${search}`, {
    operation: '加载项目工作流草稿',
    signal,
  });
};

export const getWorkflowNodeState = (
  projectId: string,
  workflowRunId: string,
  nodeId: string,
  signal?: AbortSignal,
): Promise<ApiResponse<WorkflowNodeState>> =>
  requestJson(
    `${projectPath(projectId)}/workflow-runs/${encodeURIComponent(workflowRunId)}/nodes/${encodeURIComponent(nodeId)}/state`,
    { operation: '加载节点草稿', signal },
  );

export const putWorkflowNodeState = (
  projectId: string,
  workflowRunId: string,
  nodeId: string,
  input: PutWorkflowNodeStateRequest,
  options: { keepalive?: boolean; signal?: AbortSignal } = {},
): Promise<ApiResponse<PutWorkflowNodeStateData>> =>
  requestJson(
    `${projectPath(projectId)}/workflow-runs/${encodeURIComponent(workflowRunId)}/nodes/${encodeURIComponent(nodeId)}/state`,
    {
      method: 'PUT',
      body: input,
      operation: '自动保存节点草稿',
      ...options,
    },
  );

export const pauseWorkflowRun = (
  projectId: string,
  workflowRunId: string,
): Promise<ApiResponse<{ paused: true }>> =>
  requestJson(
    `${projectPath(projectId)}/workflow-runs/${encodeURIComponent(workflowRunId)}/pause`,
    { method: 'POST', operation: '暂停工作流' },
  );

export const listWorkingArtifacts = (
  projectId: string,
  query: WorkingArtifactListQuery = {},
  signal?: AbortSignal,
): Promise<ApiResponse<WorkingArtifactListData>> => {
  const search = new URLSearchParams();
  if (query.workflowRunId) search.set('workflowRunId', query.workflowRunId);
  if (query.nodeId) search.set('nodeId', query.nodeId);
  if (query.view) search.set('view', query.view);
  if (query.workflow) search.set('workflow', query.workflow);
  if (query.space) search.set('space', query.space);
  const suffix = search.size ? `?${search.toString()}` : '';
  return requestJson(`${projectPath(projectId)}/working-artifacts${suffix}`, {
    operation: '加载当前项目工作副本',
    signal,
  });
};
