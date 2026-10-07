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
  'TEMPLATE_MIX',
  'FINAL_OUTPUT',
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
  /** Last local confirmed mix/output write, not a draft save or inherited copy timestamp. */
  currentConfirmedAt?: string | null;
  /** Explicit user choice of this template's workflow, independent of content confirmation. */
  currentSelectedAt?: string | null;
  templateRevision?: number | null;
  templateRevisions?: number[];
  templateStatus?: EffectWorkflowBranchNodeStatus;
  fillRevision: number | null;
  fillRevisions?: number[];
  fillStatus?: EffectWorkflowBranchNodeStatus;
  fillCreatedAt?: string | null;
  /** Successful smart-fill in the local draft, awaiting explicit validation. */
  draftFillReady?: boolean;
  packagingRevision: number | null;
  packagingRevisions?: number[];
  packagingStatus?: EffectWorkflowBranchNodeStatus;
  packagingCreatedAt?: string | null;
  timelineVariantCount: number;
  packagingVariantCount: number;
  deliveryRevision?: number | null;
  deliveryRevisions?: number[];
  deliveryStatus?: EffectWorkflowBranchNodeStatus;
  deliveryCount?: number;
  deliveryCreatedAt?: string | null;
};
export type EffectWorkflowBranch = {
  workflowRunId: string;
  parentWorkflowRunId: string | null;
  creationKind?: 'INITIAL' | 'NODE_CHANGE' | 'MANUAL_COPY';
  forkNodeId: EffectWorkflowBranchNodeId | null;
  forkTemplateId: string | null;
  forkMixStage?: 'TEMPLATE' | 'FILL' | 'PACKAGING' | null;
  /** A delivered picture-only branch received its first package in place. */
  packagingInOutputBranch?: boolean;
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

/** Current template tips within the selected rendering/manual-copy lineage. Shared by tree and output. */
export function effectTemplateBranchTips(
  branches: readonly EffectWorkflowBranch[],
  contextRunId: string | null,
  options: { current?: boolean; selectedTemplateId?: string | null } = {},
): Map<string, EffectWorkflowBranch> {
  const byId = new Map(branches.map((branch) => [branch.workflowRunId, branch]));
  const context = contextRunId ? byId.get(contextRunId) : undefined;
  const renderOwner = (branch: EffectWorkflowBranch): string => {
    const seen = new Set<string>();
    let cursor = branch;
    while (cursor.parentWorkflowRunId && !seen.has(cursor.workflowRunId) &&
      (cursor.forkNodeId === 'TEMPLATE_MIX' || cursor.forkNodeId === 'FINAL_OUTPUT')) {
      seen.add(cursor.workflowRunId);
      const parent = byId.get(cursor.parentWorkflowRunId);
      if (!parent) break;
      cursor = parent;
    }
    return cursor.workflowRunId;
  };
  const scoped = context ? branches.filter((branch) => renderOwner(branch) === renderOwner(context)) : [];
  const tips = new Map<string, EffectWorkflowBranch>();
  for (const templateId of new Set(scoped.flatMap((branch) => branch.templates.map((t) => t.templateId)))) {
    const confirmedAt = (branch: EffectWorkflowBranch) =>
      branch.templates.find((item) => item.templateId === templateId)?.currentConfirmedAt;
    // Older APIs cannot distinguish a local overwrite from branch creation. Retain their
    // explicit context instead of guessing a different history from missing timestamps.
    const current = options.current && scoped.some((branch) => Boolean(confirmedAt(branch)));
    const latest = scoped.filter((branch) =>
      (branch.forkTemplateId === templateId &&
        (branch.forkNodeId === 'TEMPLATE_MIX' || branch.forkNodeId === 'FINAL_OUTPUT')) ||
      (current && Boolean(confirmedAt(branch))))
      .sort((a, b) => (current ? confirmedAt(b) ?? b.createdAt : b.createdAt)
        .localeCompare(current ? confirmedAt(a) ?? a.createdAt : a.createdAt) ||
        b.createdAt.localeCompare(a.createdAt) || b.workflowRunId.localeCompare(a.workflowRunId))[0];
    const chosen = scoped.filter(branch => Boolean(branch.templates.find(t =>
      t.templateId === templateId)?.currentSelectedAt)).sort((a, b) =>
      b.templates.find(t => t.templateId === templateId)!.currentSelectedAt!.localeCompare(
        a.templates.find(t => t.templateId === templateId)!.currentSelectedAt!) ||
      b.workflowRunId.localeCompare(a.workflowRunId))[0];
    const selected = ((!options.current || (!current && !chosen)) && context?.forkTemplateId === templateId) ||
      options.selectedTemplateId === templateId ? context : undefined;
    const fallback = context?.templates.some((t) => t.templateId === templateId) ? context :
      scoped.find((branch) => branch.templates.some((t) => t.templateId === templateId));
    if (selected ?? chosen ?? latest ?? fallback) tips.set(templateId, (selected ?? chosen ?? latest ?? fallback)!);
  }
  return tips;
}
export type ActivateEffectWorkflowBranchData = { run: WorkflowRun };
export type ActivateEffectWorkflowBranchRequest = {
  /** null means configuration navigation only; omitted keeps task-completion compatibility. */
  templateId?: string | null;
};
/** UI-only selection state, never an execution input or confirmed artifact. */
export const EFFECT_TEMPLATE_CURRENT_PATH_NODE_ID = 'TEMPLATE_MIX:current-paths';
export type EffectTemplateCurrentPathState = {
  schemaVersion: 1;
  workflowRunId: string;
  selectedTemplates: Record<string, string>;
};
export type CreateEffectWorkflowBranchRequest = { idempotencyKey: string };
export type CreateEffectWorkflowBranchData = {
  run: WorkflowRun;
  parentWorkflowRunId: string;
  activeWorkflowRunId: string;
};

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

export const WORKING_ARTIFACT_LIST_VIEWS = ['SNAPSHOT'] as const;
export type WorkingArtifactListQuery = {
  workflowRunId?: string | undefined;
  nodeId?: string | undefined;
  workflow?: AssetWorkflow | undefined;
  space?: AssetWorkflowSpace | undefined;
  /** Read only this Run's saved copies; do not project current lineage sources. Requires workflowRunId. */
  view?: (typeof WORKING_ARTIFACT_LIST_VIEWS)[number] | undefined;
};

export type WorkingArtifactListData = {
  items: WorkingArtifact[];
  total: number;
};
