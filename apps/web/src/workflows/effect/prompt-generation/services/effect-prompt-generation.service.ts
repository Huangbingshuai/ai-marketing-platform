import type {
  EffectPromptBatchResult,
  EffectPromptBatchSettings,
  EffectPromptDimensions,
  EffectPromptFragmentType,
  EffectPromptImportItem,
  EffectPromptImportMode,
  EffectPromptItem,
  EffectPromptNodeId,
  EffectPromptRun,
  GetEffectPromptNodeDetailData,
  GetEffectPromptResultData,
  GetEffectPromptWorkspaceData,
  ImportEffectPromptResultData,
  StartEffectPromptRunRequest,
  UpdateEffectPromptResultData,
  ValidateEffectPromptResultData,
} from '@ai-marketing/contracts';
import { EFFECT_PROMPT_DIMENSIONS, EFFECT_PROMPT_LIMITS } from '@ai-marketing/contracts';

import {
  addEffectPromptItem,
  deleteEffectPromptItem,
  exportEffectPromptResult,
  getEffectPromptNodeDetail,
  getEffectPromptResult,
  getEffectPromptRun,
  getEffectPromptWorkspace,
  importEffectPromptItems,
  saveEffectPromptSettings,
  startEffectPromptRun,
  updateEffectPromptItem,
  updateEffectPromptSharedPrompt,
  validateEffectPromptResult,
} from '../api/effect-prompt-generation.api';

export type EffectPromptContext = {
  projectId: string;
  workflowRunId: string;
};

export type EffectPromptViewResultData = Omit<GetEffectPromptResultData, 'items' | 'result'> & {
  result: Omit<EffectPromptBatchResult, 'items'>;
  items: EffectPromptItem[];
};

export type PollEffectPromptRunOptions = {
  intervalMs?: number;
  onUpdate?: (run: EffectPromptRun) => void;
  signal?: AbortSignal;
};

const abortError = (): DOMException => new DOMException('Prompt 生成轮询已取消', 'AbortError');

const waitForNextPoll = (duration: number, signal?: AbortSignal): Promise<void> => {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const timer = globalThis.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, duration);
    const onAbort = (): void => {
      globalThis.clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
};

export const createPromptIdempotencyKey = (): string => {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  return `effect-prompt-${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

export const isTerminalPromptRun = (run: EffectPromptRun): boolean =>
  run.status === 'COMPLETED' || run.status === 'FAILED';

export const loadEffectPromptWorkspace = async (
  context: EffectPromptContext,
  signal?: AbortSignal,
): Promise<GetEffectPromptWorkspaceData> => {
  return (await getEffectPromptWorkspace(context.projectId, context.workflowRunId, signal)).data;
};

export const savePromptSettings = async (
  context: EffectPromptContext,
  productId: string,
  settings: EffectPromptBatchSettings,
  expectedRevision: number | null,
  signal?: AbortSignal,
) =>
  (
    await saveEffectPromptSettings(
      context.projectId,
      productId,
      { workflowRunId: context.workflowRunId, settings, expectedRevision },
      signal,
    )
  ).data;

export const loadEffectPromptResult = async (
  projectId: string,
  workflowRunId: string,
  productId: string,
  page: number,
  query: string,
  purpose?: EffectPromptFragmentType,
  signal?: AbortSignal,
): Promise<EffectPromptViewResultData> => {
  return (
    await getEffectPromptResult(projectId, workflowRunId, productId, page, query, purpose, signal)
  ).data as EffectPromptViewResultData;
};

export const beginEffectPromptRun = async (
  projectId: string,
  productId: string,
  input: Omit<StartEffectPromptRunRequest, 'idempotencyKey'>,
  signal?: AbortSignal,
): Promise<EffectPromptRun> =>
  (
    await startEffectPromptRun(
      projectId,
      productId,
      { ...input, idempotencyKey: createPromptIdempotencyKey() },
      signal,
    )
  ).data.run;

export const loadEffectPromptRun = async (
  projectId: string,
  runId: string,
  signal?: AbortSignal,
): Promise<EffectPromptRun> => (await getEffectPromptRun(projectId, runId, signal)).data.run;

export const pollEffectPromptRun = async (
  projectId: string,
  runId: string,
  { intervalMs = 1_200, onUpdate, signal }: PollEffectPromptRunOptions = {},
): Promise<EffectPromptRun> => {
  let consecutiveErrors = 0;
  while (true) {
    if (signal?.aborted) throw abortError();
    let run: EffectPromptRun;
    try {
      run = await loadEffectPromptRun(projectId, runId, signal);
      consecutiveErrors = 0;
    } catch (error) {
      if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError'))
        throw abortError();
      consecutiveErrors += 1;
      if (consecutiveErrors >= 5) throw error;
      await waitForNextPoll(intervalMs, signal);
      continue;
    }
    onUpdate?.(run);
    if (isTerminalPromptRun(run)) return run;
    await waitForNextPoll(intervalMs, signal);
  }
};

export const loadEffectPromptNodeDetail = async (
  projectId: string,
  runId: string,
  nodeId: EffectPromptNodeId,
  signal?: AbortSignal,
): Promise<GetEffectPromptNodeDetailData['detail']> =>
  (await getEffectPromptNodeDetail(projectId, runId, nodeId, signal)).data.detail;

export type PromptItemDraft = {
  content: string;
  materialTags: string[];
  dimensions: EffectPromptDimensions;
};

export type ParsedEffectPromptImport = {
  items: EffectPromptImportItem[];
  duplicateCount: number;
};

export const parseEffectPromptImportJson = (source: string): ParsedEffectPromptImport => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch {
    throw new Error('导入文件不是有效的 JSON');
  }
  const rows = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { items?: unknown }).items)
      ? (parsed as { items: unknown[] }).items
      : null;
  if (!rows?.length) throw new Error('导入文件中没有 Prompt 条目');
  if (rows.length > EFFECT_PROMPT_LIMITS.maxCount)
    throw new Error(`一次最多导入 ${EFFECT_PROMPT_LIMITS.maxCount} 条 Prompt`);

  const items = rows.map((row, index): EffectPromptImportItem => {
    if (!row || typeof row !== 'object' || Array.isArray(row))
      throw new Error(`第 ${index + 1} 条 Prompt 结构无效`);
    const value = row as Record<string, unknown>;
    const content = typeof value.content === 'string' ? value.content.normalize('NFC').trim() : '';
    if (!content || content.length > 12_000)
      throw new Error(`第 ${index + 1} 条 Prompt 正文为空或超过长度限制`);
    const dimensionsValue = value.dimensions;
    if (!dimensionsValue || typeof dimensionsValue !== 'object' || Array.isArray(dimensionsValue))
      throw new Error(`第 ${index + 1} 条 Prompt 缺少六维创意信息`);
    const dimensions = Object.fromEntries(
      EFFECT_PROMPT_DIMENSIONS.map(({ key, label }) => {
        const item = (dimensionsValue as Record<string, unknown>)[key];
        if (typeof item !== 'string' || !item.trim())
          throw new Error(`第 ${index + 1} 条 Prompt 缺少${label}`);
        return [key, item.normalize('NFC').trim()];
      }),
    ) as EffectPromptDimensions;
    const materialTags =
      value.materialTags === undefined
        ? []
        : Array.isArray(value.materialTags) &&
            value.materialTags.length <= EFFECT_PROMPT_LIMITS.maxMaterialTags &&
            value.materialTags.every((tag) => typeof tag === 'string' && tag.trim().length <= 120)
          ? [
              ...new Map(
                value.materialTags
                  .map((tag) => (tag as string).normalize('NFC').trim())
                  .filter(Boolean)
                  .map((tag) => [tag.toLocaleLowerCase('zh-CN'), tag]),
              ).values(),
            ]
          : null;
    if (materialTags === null) throw new Error(`第 ${index + 1} 条 Prompt 的次级标签无效`);
    return { content, dimensions, materialTags };
  });
  const keys = items.map(({ content }) =>
    content.normalize('NFC').trim().replaceAll(/\s+/gu, ' ').toLocaleLowerCase('zh-CN'),
  );
  return { items, duplicateCount: keys.length - new Set(keys).size };
};

export const saveEffectPromptItem = async (
  projectId: string,
  resultId: string,
  expectedRevision: number,
  draft: PromptItemDraft,
  itemId?: string,
  signal?: AbortSignal,
): Promise<UpdateEffectPromptResultData> => {
  const input = { ...draft, expectedRevision };
  return itemId
    ? (await updateEffectPromptItem(projectId, resultId, itemId, input, signal)).data
    : (await addEffectPromptItem(projectId, resultId, input, signal)).data;
};

export const removeEffectPromptItem = async (
  projectId: string,
  resultId: string,
  item: Pick<EffectPromptItem, 'id'>,
  expectedRevision: number,
  signal?: AbortSignal,
): Promise<UpdateEffectPromptResultData> =>
  (await deleteEffectPromptItem(projectId, resultId, item.id, expectedRevision, signal)).data;

export const importEffectPromptBatchDraft = async (
  projectId: string,
  resultId: string,
  expectedRevision: number,
  mode: EffectPromptImportMode,
  items: EffectPromptImportItem[],
  signal?: AbortSignal,
): Promise<ImportEffectPromptResultData> =>
  (await importEffectPromptItems(projectId, resultId, { mode, items, expectedRevision }, signal))
    .data;

export const saveEffectPromptSharedPrompt = async (
  projectId: string,
  resultId: string,
  expectedRevision: number,
  content: string,
  signal?: AbortSignal,
): Promise<UpdateEffectPromptResultData> =>
  (await updateEffectPromptSharedPrompt(projectId, resultId, { content, expectedRevision }, signal))
    .data;

export const commitEffectPromptResult = async (
  projectId: string,
  resultId: string,
  expectedRevision: number,
  signal?: AbortSignal,
): Promise<ValidateEffectPromptResultData> =>
  (await validateEffectPromptResult(projectId, resultId, { expectedRevision }, signal)).data;

export const downloadEffectPromptBatch = async (
  projectId: string,
  resultId: string,
  productName: string,
  signal?: AbortSignal,
): Promise<{ blob: Blob; fileName: string }> => {
  const exported = (await exportEffectPromptResult(projectId, resultId, signal)).data;
  const renderProfile = exported.result.renderProfile;
  const fileContent = {
    format: 'effect-prompt-batch',
    formatVersion: 1,
    productId: exported.productId,
    resultId: exported.resultId,
    revision: exported.revision,
    exportedAt: exported.exportedAt,
    renderProfile: {
      capabilityKey: renderProfile.capabilityKey,
      ratio: renderProfile.ratio,
      resolution: renderProfile.resolution,
    },
    sharedPrompt: exported.result.sharedPrompt ?? null,
    items: exported.result.items.map((item) => ({
      id: item.id,
      code: item.code,
      primaryPurpose: item.primaryPurpose,
      compatiblePurposes: item.compatiblePurposes,
      classificationStatus: item.classificationStatus,
      fragmentType: item.fragmentType,
      content: item.content,
      targetDurationSeconds: item.targetDurationSeconds,
      ratio: renderProfile.ratio,
      resolution: renderProfile.resolution,
      materialTags: item.materialTags,
      creativeCore: item.creativeCore,
      dimensions: item.dimensions,
      productRelevance: item.productRelevance,
      insightBindings: item.insightBindings,
    })),
  };
  return {
    blob: new Blob([JSON.stringify(fileContent, null, 2)], {
      type: 'application/json;charset=utf-8',
    }),
    fileName: `${productName.trim() || '当前商品'}-差异化Prompt-${exported.result.items.length}条.json`,
  };
};
