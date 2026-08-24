import type {
  AssetDirectory,
  AssetPreviewKind,
  AssetType,
  AssetWorkflow,
  AssetWorkflowSpace,
} from './asset';

export const WORKFLOW_RUN_STATUSES = ['ACTIVE', 'COMPLETED'] as const;
export type WorkflowRunStatus = (typeof WORKFLOW_RUN_STATUSES)[number];

export const WORKING_ARTIFACT_KINDS = ['FILE', 'STRUCTURED'] as const;
export type WorkingArtifactKind = (typeof WORKING_ARTIFACT_KINDS)[number];

export type WorkflowRun = {
  id: string;
  projectId: string;
  workflow: AssetWorkflow;
  workflowSpace: AssetWorkflowSpace;
  status: WorkflowRunStatus;
  createdAt: string;
  updatedAt: string;
};

export type WorkflowNodeState = {
  id: string;
  projectId: string;
  workflowRunId: string;
  nodeId: string;
  schemaVersion: number;
  revision: number;
  contentHash: string;
  state: unknown;
  savedAt: string;
  updatedAt: string;
};

export type PutWorkflowNodeStateRequest = {
  expectedRevision: number | null;
  schemaVersion?: number | undefined;
  state: unknown;
};

export type PutWorkflowNodeStateData = {
  nodeState: WorkflowNodeState;
  unchanged: boolean;
};

export type WorkingArtifact = {
  id: string;
  projectId: string;
  workflowRunId: string;
  nodeId: string;
  artifactKey: string;
  kind: WorkingArtifactKind;
  name: string;
  directory: AssetDirectory;
  type: AssetType;
  tags: string[];
  payload: unknown;
  metadata: unknown;
  originalFileName: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  previewKind: AssetPreviewKind;
  contentUrl: string | null;
  downloadUrl: string | null;
  sourceRunId: string | null;
  sourceArtifactId: string | null;
  status: 'WORKING';
  archiveStatus: 'UNARCHIVED';
  createdAt: string;
  updatedAt: string;
};

export type WorkingArtifactListQuery = {
  workflowRunId?: string | undefined;
  nodeId?: string | undefined;
  workflow?: AssetWorkflow | undefined;
  space?: AssetWorkflowSpace | undefined;
};

export type WorkingArtifactListData = {
  items: WorkingArtifact[];
  total: number;
};
