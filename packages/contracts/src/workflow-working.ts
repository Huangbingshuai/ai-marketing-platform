import type {
  AssetDirectory,
  AssetPreviewKind,
  AssetType,
  AssetWorkflow,
  AssetWorkflowSpace,
} from './asset';

export const WORKFLOW_RUN_STATUSES = ['ACTIVE', 'PAUSED', 'COMPLETED'] as const;
export type WorkflowRunStatus = (typeof WORKFLOW_RUN_STATUSES)[number];

export const WORKING_ARTIFACT_KINDS = ['FILE', 'STRUCTURED'] as const;
export type WorkingArtifactKind = (typeof WORKING_ARTIFACT_KINDS)[number];

export const WORKING_ARTIFACT_FRESHNESSES = ['CURRENT', 'STALE'] as const;
export type WorkingArtifactFreshness = (typeof WORKING_ARTIFACT_FRESHNESSES)[number];

export const WORKING_ARTIFACT_DEPENDENCY_SOURCE_TYPES = ['NODE_STATE', 'WORKING_ARTIFACT'] as const;
export type WorkingArtifactDependencySourceType =
  (typeof WORKING_ARTIFACT_DEPENDENCY_SOURCE_TYPES)[number];

export type WorkingArtifactDependency = {
  sourceType: WorkingArtifactDependencySourceType;
  sourceNodeId: string | null;
  sourceArtifactId: string | null;
  sourceKey: string;
  sourceRevision: number;
};

export type WorkingArtifactFile = {
  id: string;
  fileObjectId: string;
  role: string;
  sortOrder: number;
  originalFileName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  previewKind: AssetPreviewKind;
  previewUrl: string;
  contentUrl: string;
  downloadUrl: string;
};

export type WorkflowRun = {
  id: string;
  projectId: string;
  workflow: AssetWorkflow;
  workflowSpace: AssetWorkflowSpace;
  status: WorkflowRunStatus;
  currentNodeId: string | null;
  lastActiveAt: string;
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

export type WorkflowRunOverviewData = {
  run: WorkflowRun | null;
  nodeStates: WorkflowNodeState[];
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
  revision: number;
  freshness: WorkingArtifactFreshness;
  dependencies: WorkingArtifactDependency[];
  files: WorkingArtifactFile[];
  fileCount: number;
  mainPreviewUrl: string | null;
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
