import type { AssetWorkflow, AssetWorkflowSpace } from './asset';

export const PROJECT_STATUSES = ['DRAFT', 'ACTIVE', 'COMPLETED'] as const;

export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export type Project = {
  id: string;
  name: string;
  description: string | null;
  status: ProjectStatus;
  createdAt: string;
  updatedAt: string;
  client?: string | null;
  productName?: string | null;
  iconKey?: string | null;
  workflowSpaces?: ProjectWorkflowSpaces;
  assetCounts?: Partial<Record<AssetWorkflowSpace, number>>;
  deletion?: {
    status: Exclude<ProjectDeletionStatus, 'COMPLETED'>;
    phase: 'DATABASE' | 'FILES';
    message?: string;
  };
};

export type ProjectWorkflowSpaces = {
  effect: boolean;
  customized: boolean;
  fission: { clone: boolean; avatar: boolean; localReplace: boolean };
};

export type CreateProjectRequest = {
  name: string;
  description?: string | undefined;
  client?: string | undefined;
  productName?: string | undefined;
  iconKey?: string | undefined;
  workflow?: AssetWorkflow | undefined;
  space?: AssetWorkflowSpace | undefined;
};

export type ProjectListQuery = {
  keyword?: string | undefined;
  workflow?: AssetWorkflow | undefined;
  space?: AssetWorkflowSpace | undefined;
};

export const PROJECT_DELETION_STATUSES = ['QUEUED', 'RUNNING', 'FAILED', 'COMPLETED'] as const;
export type ProjectDeletionStatus = (typeof PROJECT_DELETION_STATUSES)[number];

export type DeleteProjectRequest = {
  currentProjectId?: string;
};

export type DeleteProjectResult = {
  projectId: string;
  deleted: boolean;
  status: ProjectDeletionStatus;
  storageCleanup: 'COMPLETED' | 'PENDING';
};
