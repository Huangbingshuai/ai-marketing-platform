import type {
  ApiResponse,
  EffectTemplateMixDraft,
  EffectTemplateMixAiRun,
  EffectTemplateMixTemplateEntry,
  EffectTemplateMixWorkspaceData,
  PackagingItem,
  SyncFinalOutputData,
  UpdatePackagingAudioRequest,
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
  templates: entries.map(
    ({
      id,
      createdAt,
      aiFillLocked,
      filledTemplateHash,
      packagingLocked,
      needsAiFill,
      workspace,
    }) => ({
      id,
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

export const createEffectTemplateMixAiRun = (
  projectId: string,
  workflowRunId: string,
  expectedRevision: number,
  templateId: string,
  targetVariantId?: string,
  refreshAffectedSlots = false,
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
        ...(refreshAffectedSlots ? { refreshAffectedSlots: true } : {}),
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
  expectedDraftRevision?: number,
  templateId?: string,
): Promise<ApiResponse<SyncFinalOutputData>> =>
  requestJson('/projects/' + encodeURIComponent(projectId) + '/workflows/effect/final-output/sync', {
    method: 'POST',
    operation: '同步成片待渲染区',
    body: { workflowRunId, expectedDraftRevision, templateId },
  });

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
