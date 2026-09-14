import type {
  ApiResponse,
  EffectTemplateMixDraft,
  EffectTemplateMixMaterial,
  EffectTemplateMixTemplateEntry,
  EffectTemplateMixWorkspaceData,
  PutWorkflowNodeStateData,
  ValidateEffectTemplateMixData,
  WorkingArtifact,
} from '@ai-marketing/contracts';

import { ApiClientError, requestJson } from '../../../../api/http-client';
import {
  getWorkflowNodeState,
  listWorkingArtifacts,
  putWorkflowNodeState,
} from '../../../../platform/workflow/api/workflow-working.api';

const emptyDraft = (): EffectTemplateMixDraft => ({
  schemaVersion: 1,
  templates: [],
  activeTemplateId: '',
});

const object = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const purpose = (value: unknown): EffectTemplateMixMaterial['purpose'] => {
  if (
    value === 'HOOK' ||
    value === 'EFFECT' ||
    value === 'PRODUCT_DISPLAY' ||
    value === 'END_CONVERSION'
  )
    return value;
  return 'EFFECT';
};

const materialFrom = (artifact: WorkingArtifact): EffectTemplateMixMaterial | null => {
  if (!artifact.artifactKey.startsWith('render-clip:') || artifact.kind !== 'FILE') return null;
  const data = object(artifact.payload);
  if (!data || !artifact.contentUrl) return null;
  const primaryPurpose = purpose(data.primaryPurpose);
  const compatible = Array.isArray(data.compatiblePurposes)
    ? [...new Set(data.compatiblePurposes.map(purpose))]
    : [];
  const duration = Number(data.durationSeconds);
  if (!Number.isFinite(duration) || duration <= 0) return null;
  return {
    id: artifact.id,
    artifactId: artifact.id,
    artifactKey: artifact.artifactKey,
    artifactRevision: artifact.revision,
    fileObjectId: typeof data.fileObjectId === 'string' ? data.fileObjectId : '',
    contentHash: typeof data.contentHash === 'string' ? data.contentHash : '',
    contentUrl: artifact.contentUrl,
    code: typeof data.renderCode === 'string' ? data.renderCode : artifact.name,
    name: artifact.name.replace(/\s+视频片段$/u, ''),
    duration,
    purpose: primaryPurpose,
    compatiblePurposes: compatible,
    ratio: typeof data.ratio === 'string' ? data.ratio : '',
    resolution: typeof data.resolution === 'string' ? data.resolution : '',
    available: artifact.availability === 'AVAILABLE' && artifact.freshness === 'CURRENT',
  };
};

const checkedDraft = (state: unknown): EffectTemplateMixDraft => {
  const value = object(state);
  if (value?.schemaVersion !== 1 || !Array.isArray(value.templates)) {
    throw new Error('混剪草稿版本不受支持，请联系管理员迁移后再编辑');
  }
  return state as EffectTemplateMixDraft;
};

export const loadEffectTemplateMixWorkspace = async (
  projectId: string,
  workflowRunId: string,
  signal?: AbortSignal,
): Promise<EffectTemplateMixWorkspaceData> => {
  const artifactsPromise = listWorkingArtifacts(
    projectId,
    { workflowRunId, workflow: 'EFFECT', space: 'EFFECT' },
    signal,
  );
  let draft = emptyDraft();
  let draftRevision: number | null = null;
  try {
    const response = await getWorkflowNodeState(projectId, workflowRunId, 'TEMPLATE_MIX', signal);
    draft = checkedDraft(response.data.state);
    draftRevision = response.data.revision;
  } catch (error) {
    if (!(error instanceof ApiClientError) || error.status !== 404) throw error;
  }
  const artifacts = (await artifactsPromise).data.items;
  const materials = artifacts
    .map(materialFrom)
    .filter((item): item is EffectTemplateMixMaterial => Boolean(item));
  const commits = artifacts
    .filter(
      ({ nodeId, artifactKey }) =>
        nodeId === 'TEMPLATE_MIX' && artifactKey.startsWith('mix-template:'),
    )
    .map((artifact) => {
      const data = object(artifact.payload);
      const template = object(data?.template);
      return {
        templateId: String(data?.templateId ?? artifact.artifactKey.slice('mix-template:'.length)),
        revision: artifact.revision,
        contentHash: '',
        stale: artifact.freshness === 'STALE',
        editVersion: Number(data?.workspaceVersion ?? template?.editVersion ?? 0),
      };
    });
  return { draft, draftRevision, materials, commits };
};

export const serializeEffectTemplateMixDraft = (
  entries: EffectTemplateMixTemplateEntry[],
  activeTemplateId: string,
): EffectTemplateMixDraft => ({
  schemaVersion: 1,
  activeTemplateId,
  templates: entries.map(({ id, workspace }) => ({
    id,
    workspace: {
      editVersion: workspace.editVersion,
      template: workspace.template,
      variants: workspace.variants,
    },
  })),
});

export const saveEffectTemplateMixDraft = (
  projectId: string,
  workflowRunId: string,
  expectedRevision: number | null,
  draft: EffectTemplateMixDraft,
  keepalive = false,
): Promise<ApiResponse<PutWorkflowNodeStateData>> =>
  putWorkflowNodeState(
    projectId,
    workflowRunId,
    'TEMPLATE_MIX',
    { expectedRevision, schemaVersion: 1, state: draft },
    { keepalive },
  );

export const validateEffectTemplateMix = (
  projectId: string,
  workflowRunId: string,
  expectedRevision: number,
  templateId: string,
): Promise<ApiResponse<ValidateEffectTemplateMixData>> =>
  requestJson(
    '/projects/' + encodeURIComponent(projectId) + '/workflows/effect/template-mix/validate',
    {
      method: 'POST',
      operation: '提交混剪工程',
      body: { workflowRunId, expectedRevision, templateId },
    },
  );
