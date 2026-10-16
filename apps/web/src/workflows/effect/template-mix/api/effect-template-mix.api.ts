import type {
  ApiResponse,
  DeleteEffectTemplateMixData,
  EffectTemplateMixDraft,
  EffectTemplateMixAiRun,
  EffectTemplateMixWorkspaceData,
  EffectTemplateMixSourcesData,
  FinalOutputRun,
  SourceUpdateFinalOutputRequest,
  SourceUpdateFinalOutputData,
  SaveEffectTemplateMixData,
  SaveEffectTemplateMixRequest,
  PackagingItem,
  SyncFinalOutputData,
  SyncFinalOutputRequest,
  UpdatePackagingAudioRequest,
  ValidateEffectTemplateMixData,
} from '@ai-marketing/contracts';

import { requestJson } from '../../../../api/http-client';

const basePath = (projectId: string): string =>
  '/projects/' + encodeURIComponent(projectId) + '/workflows/effect/template-mix';

const outputPath = (projectId: string): string =>
  '/projects/' + encodeURIComponent(projectId) + '/workflows/effect/final-output';

export const deleteEffectTemplateMix = (
  projectId: string,
  workflowRunId: string,
  templateId: string,
  expectedRevision: number,
): Promise<ApiResponse<DeleteEffectTemplateMixData>> =>
  requestJson(basePath(projectId) + '/templates/' + encodeURIComponent(templateId) + '/delete', {
    method: 'POST',
    operation: '删除混剪模板及其全部分支',
    body: { workflowRunId, expectedRevision },
  });
export const loadMixFinalOutputRuns = (
  projectId: string,
  workflowRunId: string,
  signal?: AbortSignal,
): Promise<ApiResponse<FinalOutputRun[]>> =>
  requestJson(outputPath(projectId) + '?workflowRunId=' + encodeURIComponent(workflowRunId), {
    operation: '读取成片工程更新任务',
    signal,
  });
export const updateMixSourceProjects = (
  projectId: string,
  body: SourceUpdateFinalOutputRequest,
): Promise<ApiResponse<SourceUpdateFinalOutputData>> =>
  requestJson(outputPath(projectId) + '/source-update', {
    method: 'POST',
    operation: '局部更新成片工程',
    body,
  });
export const getMixSourceUpdateRun = (
  projectId: string,
  runId: string,
  signal?: AbortSignal,
): Promise<ApiResponse<FinalOutputRun>> =>
  requestJson(outputPath(projectId) + '/' + encodeURIComponent(runId), {
    operation: '读取局部更新进度',
    signal,
  });

export const loadEffectTemplateMixWorkspace = (
  projectId: string,
  workflowRunId: string,
  signal?: AbortSignal,
): Promise<ApiResponse<EffectTemplateMixWorkspaceData>> =>
  requestJson(basePath(projectId) + '?workflowRunId=' + encodeURIComponent(workflowRunId), {
    operation: '读取混剪工作区',
    signal,
  });

export const loadEffectTemplateMixSources = (
  projectId: string,
  workflowRunId: string,
  signal?: AbortSignal,
): Promise<ApiResponse<EffectTemplateMixSourcesData>> =>
  requestJson(basePath(projectId) + '/sources?workflowRunId=' + encodeURIComponent(workflowRunId), {
    operation: '刷新混剪素材来源',
    signal,
  });

export const serializeEffectTemplateMixDraft = (
  entries: EffectTemplateMixDraft['templates'],
  activeTemplateId: string,
): EffectTemplateMixDraft => ({
  schemaVersion: 1,
  activeTemplateId,
  templates: entries.map(
    ({
      id,
      materialRoleOverrides,
      materialRoleEditVersion,
      createdAt,
      aiFillLocked,
      filledTemplateHash,
      packagingLocked,
      needsAiFill,
      workspace,
    }) => ({
      id,
      ...(materialRoleOverrides ? { materialRoleOverrides } : {}),
      ...(materialRoleEditVersion !== undefined ? { materialRoleEditVersion } : {}),
      ...(createdAt ? { createdAt } : {}),
      ...(aiFillLocked ? { aiFillLocked: true } : {}),
      ...(filledTemplateHash ? { filledTemplateHash } : {}),
      ...(packagingLocked ? { packagingLocked: true } : {}),
      ...(needsAiFill ? { needsAiFill: true } : {}),
      workspace: {
        editVersion: workspace.editVersion,
        template: workspace.template,
        variants: workspace.variants,
      },
    }),
  ),
});

export function saveEffectTemplateMixDraft(
  projectId: string,
  workflowRunId: string,
  expectedRevision: number | null,
  draft: EffectTemplateMixDraft,
  keepalive?: boolean,
): Promise<ApiResponse<EffectTemplateMixWorkspaceData>>;
export function saveEffectTemplateMixDraft(
  projectId: string,
  workflowRunId: string,
  expectedRevision: number | null,
  draft: EffectTemplateMixDraft,
  keepalive: boolean,
  compactResponse: true,
): Promise<ApiResponse<SaveEffectTemplateMixData>>;
export function saveEffectTemplateMixDraft(
  projectId: string,
  workflowRunId: string,
  expectedRevision: number | null,
  draft: EffectTemplateMixDraft,
  keepalive = false,
  compactResponse = false,
): Promise<ApiResponse<EffectTemplateMixWorkspaceData | SaveEffectTemplateMixData>> {
  const body: SaveEffectTemplateMixRequest = {
    workflowRunId,
    expectedRevision,
    draft,
    ...(compactResponse ? { compactResponse: true } : {}),
  };
  return requestJson(basePath(projectId) + '/draft', {
    method: 'PUT',
    operation: '保存混剪草稿',
    body,
    keepalive,
  });
}

export const createEmptyEffectTemplateMixVariant = (
  projectId: string,
  workflowRunId: string,
  expectedRevision: number,
  templateId: string,
): Promise<ApiResponse<EffectTemplateMixWorkspaceData>> =>
  requestJson(
    basePath(projectId) + '/templates/' + encodeURIComponent(templateId) + '/empty-variants',
    {
      method: 'POST',
      operation: '新建空成片工程',
      body: { workflowRunId, expectedRevision },
    },
  );

export const deleteEffectTemplateMixVariant = (
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
      '/delete',
    {
      method: 'POST',
      operation: '删除成片工程',
      body: { workflowRunId, expectedRevision },
    },
  );

export const createEffectTemplateMixAiRun = (
  projectId: string,
  workflowRunId: string,
  expectedRevision: number,
  templateId: string,
  targetVariantId?: string,
  refreshAffectedSlots = false,
  appendNewMaterials = false,
  sourceOperationId?: string,
): Promise<ApiResponse<EffectTemplateMixAiRun>> =>
  requestJson(
    basePath(projectId) + '/templates/' + encodeURIComponent(templateId) + '/ai-fill-runs',
    {
      method: 'POST',
      operation: appendNewMaterials
        ? '新增素材局部更新'
        : targetVariantId
          ? '重新智能填充'
          : 'AI 智能填充',
      body: {
        workflowRunId,
        expectedRevision,
        idempotencyKey: crypto.randomUUID(),
        ...(targetVariantId ? { targetVariantId } : {}),
        ...(refreshAffectedSlots ? { refreshAffectedSlots: true } : {}),
        ...(appendNewMaterials ? { appendNewMaterials: true } : {}),
        ...(sourceOperationId ? { sourceOperationId } : {}),
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

export const resumeEffectTemplateMixAppend = (
  projectId: string,
  runId: string,
): Promise<ApiResponse<EffectTemplateMixAiRun>> =>
  requestJson(
    basePath(projectId) + '/ai-fill-runs/' + encodeURIComponent(runId) + '/resume-append',
    {
      method: 'POST',
      operation: '继续新增成片更新',
    },
  );

export const cancelEffectTemplateMixAppend = (
  projectId: string,
  runId: string,
): Promise<ApiResponse<EffectTemplateMixAiRun>> =>
  requestJson(basePath(projectId) + '/ai-fill-runs/' + encodeURIComponent(runId) + '/cancel', {
    method: 'POST',
    operation: '取消局部更新',
  });

export const getBackgroundEffectTemplateMixAiRun = (
  projectId: string,
  workflowRunId: string,
  templateId: string,
): Promise<ApiResponse<EffectTemplateMixAiRun | null>> =>
  requestJson(
    basePath(projectId) +
      '/templates/' +
      encodeURIComponent(templateId) +
      '/background-ai-run?workflowRunId=' +
      encodeURIComponent(workflowRunId),
    { operation: '读取新分支智能填充进度' },
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

/** A saved mix draft refreshes only the unexported output queue of its own branch. */
export const syncEffectFinalOutput = (
  projectId: string,
  workflowRunId: string,
  options: Pick<SyncFinalOutputRequest, 'templateId' | 'expectedDraftRevision'> = {},
): Promise<ApiResponse<SyncFinalOutputData>> =>
  requestJson(
    '/projects/' + encodeURIComponent(projectId) + '/workflows/effect/final-output/sync',
    {
      method: 'POST',
      operation: '同步成片待渲染区',
      body: { workflowRunId, ...options },
    },
  );

/**
 * Speak one subtitle's text again with the item's own frozen voice. `text` is an assertion the
 * server checks against the caption it has stored, so a caption still inside its save debounce is
 * refused instead of being voiced from the previous revision.
 */
export const createEffectCaptionVoice = (
  projectId: string,
  runId: string,
  itemId: string,
  body: { captionId: string; text: string },
): Promise<ApiResponse<{ requestId: string }>> =>
  requestJson(
    basePath(projectId) +
      '/packaging-runs/' +
      encodeURIComponent(runId) +
      '/items/' +
      encodeURIComponent(itemId) +
      '/caption-voice',
    { method: 'POST', operation: '生成字幕口播', body },
  );

/** Editor audio geometry is persisted on the packaging item, not the workflow draft. */
export const updateEffectPackagingAudio = (
  projectId: string,
  runId: string,
  itemId: string,
  body: UpdatePackagingAudioRequest,
): Promise<ApiResponse<PackagingItem>> =>
  requestJson(
    basePath(projectId) +
      '/packaging-runs/' +
      encodeURIComponent(runId) +
      '/items/' +
      encodeURIComponent(itemId) +
      '/audio',
    { method: 'PUT', operation: '保存音频轨道编辑', body },
  );
