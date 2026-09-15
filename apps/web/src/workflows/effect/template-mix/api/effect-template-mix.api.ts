import type {
  ApiResponse,
  EffectTemplateMixDraft,
  EffectTemplateMixAiRun,
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

export const createEffectTemplateMixAiRun = (
  projectId: string,
  workflowRunId: string,
  expectedRevision: number,
  templateId: string,
  targetVariantId?: string,
): Promise<ApiResponse<EffectTemplateMixAiRun>> =>
  requestJson(
    basePath(projectId) + '/templates/' + encodeURIComponent(templateId) + '/ai-fill-runs',
    {
      method: 'POST',
      operation: targetVariantId ? '重新智能填充' : 'AI 智能填充',
      body: {
        workflowRunId,
        expectedRevision,
        idempotencyKey: crypto.randomUUID(),
        ...(targetVariantId ? { targetVariantId } : {}),
      },
    },
  );

export const getEffectTemplateMixAiRun = (
  projectId: string,
  runId: string,
  signal?: AbortSignal,
): Promise<ApiResponse<EffectTemplateMixAiRun>> =>
  requestJson(basePath(projectId) + '/ai-fill-runs/' + encodeURIComponent(runId), {
    operation: '读取智能填充进度',
    signal,
  });

export const composeEffectTemplateMixVariants = (
  projectId: string,
  workflowRunId: string,
  expectedRevision: number,
  templateId: string,
): Promise<ApiResponse<EffectTemplateMixWorkspaceData>> =>
  requestJson(
    basePath(projectId) + '/templates/' + encodeURIComponent(templateId) + '/algorithm-variants',
    {
      method: 'POST',
      operation: '算法批量组合成片工程',
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
