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

export const WORKING_ARTIFACT_AVAILABILITIES = [
  'AVAILABLE',
  'SOURCE_REMOVED',
  'PENDING_DELETE',
] as const;
export type WorkingArtifactAvailability = (typeof WORKING_ARTIFACT_AVAILABILITIES)[number];

export const WORKING_ARTIFACT_COMMIT_STATUSES = [
  'UNVALIDATED',
  'COMMITTED',
  'DRAFT_CHANGED',
  'STALE',
] as const;
export type WorkingArtifactCommitStatus = (typeof WORKING_ARTIFACT_COMMIT_STATUSES)[number];

export type WorkingArtifactCommitSummary = {
  artifactId: string;
  artifactKey: string;
  revision: number;
  unchanged: boolean;
};

export const WORKING_ARTIFACT_DEPENDENCY_SOURCE_TYPES = [
  'NODE_STATE',
  'WORKING_ARTIFACT',
  'EXECUTION_INPUT',
] as const;
export type WorkingArtifactDependencySourceType =
  (typeof WORKING_ARTIFACT_DEPENDENCY_SOURCE_TYPES)[number];

export type WorkingArtifactDependency = {
  sourceType: WorkingArtifactDependencySourceType;
  sourceNodeId: string | null;
  sourceArtifactId: string | null;
  sourceKey: string;
  sourceRevision: number | null;
  sourceHash: string | null;
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
  parentWorkflowRunId: string | null;
  forkNodeId: string | null;
  forkTemplateId: string | null;
  branchLabel: string | null;
  /** Hidden editing child, not yet published in the version tree. */
  isTemporaryBranch?: boolean;
  editNodeId?: EffectWorkflowEditableNodeId | null;
  workflow: AssetWorkflow;
  workflowSpace: AssetWorkflowSpace;
  status: WorkflowRunStatus;
  currentNodeId: string | null;
  lastActiveAt: string;
  createdAt: string;
  updatedAt: string;
};

export const EFFECT_WORKFLOW_BRANCH_NODES = [
  'SOURCE_IMPORT',
  'INFORMATION_EXTRACTION',
  'PROMPT_GENERATION',
  'SEGMENT_RENDER',
  'TEMPLATE_MIX',
  'FINAL_OUTPUT',
] as const;
export type EffectWorkflowBranchNodeId = (typeof EFFECT_WORKFLOW_BRANCH_NODES)[number];
export const EFFECT_WORKFLOW_EDITABLE_NODES = [
  'SOURCE_IMPORT',
  'INFORMATION_EXTRACTION',
  'PROMPT_GENERATION',
  'SEGMENT_RENDER',
] as const;
export type EffectWorkflowEditableNodeId = (typeof EFFECT_WORKFLOW_EDITABLE_NODES)[number];
export type EffectWorkflowEditSessionData = {
  run: WorkflowRun;
  parentWorkflowRunId: string | null;
  productIdMap: Record<string, string>;
  taskIdMap: Record<string, string>;
  created: boolean;
};
export type EffectWorkflowEditExitData = {
  run: WorkflowRun;
  activeWorkflowRunId: string;
};
export type EffectWorkflowEditPublishData = EffectWorkflowEditExitData & {
  createdBranch: boolean;
};
export type EffectWorkflowBranchNodeStatus = 'CONFIRMED' | 'PENDING' | 'STALE';
export type EffectWorkflowBranchNode = {
  nodeId: EffectWorkflowBranchNodeId;
  status: EffectWorkflowBranchNodeStatus;
  artifactCount: number;
  revision?: number | null;
  revisions?: number[];
  artifactCreatedAt?: string | null;
};
export type EffectWorkflowBranchTemplate = {
  templateId: string;
  name: string;
  templateCreatedAt?: string | null;
  templateRevision?: number | null;
  templateRevisions?: number[];
  fillRevision: number | null;
  fillRevisions?: number[];
  fillCreatedAt?: string | null;
  /** Successful smart-fill in the local draft, awaiting explicit validation. */
  draftFillReady?: boolean;
  packagingRevision: number | null;
  packagingRevisions?: number[];
  packagingCreatedAt?: string | null;
  timelineVariantCount: number;
  packagingVariantCount: number;
  deliveryRevision?: number | null;
  deliveryRevisions?: number[];
  deliveryCount?: number;
  deliveryCreatedAt?: string | null;
};
export type EffectWorkflowBranch = {
  workflowRunId: string;
  parentWorkflowRunId: string | null;
  forkNodeId: EffectWorkflowBranchNodeId | null;
  forkTemplateId: string | null;
  forkMixStage?: 'TEMPLATE' | 'FILL' | 'PACKAGING' | null;
  label: string;
  currentNodeId: string | null;
  createdAt: string;
  isActive: boolean;
  nodes: EffectWorkflowBranchNode[];
  templates: EffectWorkflowBranchTemplate[];
};
export type EffectWorkflowBranchTreeData = {
  projectId: string;
  activeWorkflowRunId: string | null;
  branches: EffectWorkflowBranch[];
};
export type ActivateEffectWorkflowBranchData = { run: WorkflowRun };

export type WorkflowNodeState = {
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
  savedAt: string;
  updatedAt: string;
};

export type WorkflowRunOverviewData = {
  run: WorkflowRun | null;
  nodeStates: WorkflowNodeState[];
};

export type ActivateWorkflowNodeData = {
  run: WorkflowRun;
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
  /** Semantic hash of the confirmed working artifact payload and file identity. */
  contentHash?: string;
  freshness: WorkingArtifactFreshness;
  availability: WorkingArtifactAvailability;
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
