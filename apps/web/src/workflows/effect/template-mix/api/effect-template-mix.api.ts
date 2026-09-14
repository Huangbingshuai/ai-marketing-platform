import type {
  ApiResponse,
  EffectTemplateMixDraft,
  EffectTemplateMixTemplateEntry,
  EffectTemplateMixWorkspaceData,
  ValidateEffectTemplateMixData,
} from '@ai-marketing/contracts';

import { requestJson } from '../../../../api/http-client';

const basePath = (projectId: string): string =>
  '/projects/' + encodeURIComponent(projectId) + '/workflows/effect/template-mix';

export const loadEffectTemplateMixWorkspace = (
  projectId: string,
  workflowRunId: string,
  signal?: AbortSignal,
): Promise<ApiResponse<EffectTemplateMixWorkspaceData>> =>
  requestJson(basePath(projectId) + '?workflowRunId=' + encodeURIComponent(workflowRunId), {
    operation: '读取混剪工作区',
    signal,
  });

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
): Promise<ApiResponse<EffectTemplateMixWorkspaceData>> =>
  requestJson(basePath(projectId) + '/draft', {
    method: 'PUT',
    operation: '保存混剪草稿',
    body: { workflowRunId, expectedRevision, draft },
    keepalive,
  });

export const createEffectTemplateMixVariant = (
  projectId: string,
  workflowRunId: string,
  expectedRevision: number,
  templateId: string,
): Promise<ApiResponse<EffectTemplateMixWorkspaceData>> =>
  requestJson(basePath(projectId) + '/templates/' + encodeURIComponent(templateId) + '/variants', {
    method: 'POST',
    operation: '创建混剪工程',
    body: { workflowRunId, expectedRevision },
  });

export const refillEffectTemplateMixVariant = (
  projectId: string,
  workflowRunId: string,
  expectedRevision: number,
  templateId: string,
  variantId: string,
): Promise<ApiResponse<EffectTemplateMixWorkspaceData>> =>
  requestJson(
    basePath(projectId) +
      '/templates/' +
      encodeURIComponent(templateId) +
      '/variants/' +
      encodeURIComponent(variantId) +
      '/refill',
    {
      method: 'POST',
      operation: '重新智能填充',
      body: { workflowRunId, expectedRevision },
    },
  );

export const applyEffectTemplateMixVariant = (
  projectId: string,
  workflowRunId: string,
  expectedRevision: number,
  templateId: string,
  sourceVariantId: string,
  syncOtherVariants: boolean,
): Promise<ApiResponse<EffectTemplateMixWorkspaceData>> =>
  requestJson(
    basePath(projectId) + '/templates/' + encodeURIComponent(templateId) + '/apply-variant',
    {
      method: 'POST',
      operation: syncOtherVariants ? '更新并同步混剪模板' : '更新混剪模板',
      body: { workflowRunId, expectedRevision, sourceVariantId, syncOtherVariants },
    },
  );

export const validateEffectTemplateMix = (
  projectId: string,
  workflowRunId: string,
  expectedRevision: number,
  templateId: string,
): Promise<ApiResponse<ValidateEffectTemplateMixData>> =>
  requestJson(basePath(projectId) + '/validate', {
    method: 'POST',
    operation: '提交混剪工程',
    body: { workflowRunId, expectedRevision, templateId },
  });
