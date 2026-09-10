import type {
  EffectPromptBatchResult,
  EffectPromptBatchSettings,
  EffectPromptDimensions,
  EffectPromptFragmentType,
  EffectPromptInsightField,
  EffectPromptItem,
  EffectPromptNodeId,
  EffectPromptPurposeMatchMode,
  EffectPromptRun,
  GetEffectPromptNodeDetailData,
  GetEffectPromptResultData,
  GetEffectPromptWorkspaceData,
  StartEffectPromptRunRequest,
  UpdateEffectPromptResultData,
  ValidateEffectPromptResultData,
} from '@ai-marketing/contracts';
import {
  EFFECT_PROMPT_DIMENSIONS,
  EFFECT_PROMPT_FRAGMENT_TYPE_LABELS,
} from '@ai-marketing/contracts';

import {
  addEffectPromptItem,
  applyEffectPromptRegeneration,
  deleteEffectPromptItem,
  exportEffectPromptResult,
  getEffectPromptNodeDetail,
  getEffectPromptResult,
  getEffectPromptRun,
  getEffectPromptWorkspace,
  saveEffectPromptSettings,
  startEffectPromptRun,
  updateEffectPromptItem,
  updateEffectPromptSharedPrompt,
  undoEffectPromptRegeneration,
  validateEffectPromptResult,
} from '../api/effect-prompt-generation.api';
import {
  loadEffectWorkspaceSnapshot,
  prefetchEffectWorkspace,
  type EffectWorkspaceSnapshot,
} from '../../shared/effect-workspace-prefetch';

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

const promptWorkspacePrefetchKey = (context: EffectPromptContext): string =>
  `effect-prompt:${encodeURIComponent(context.projectId)}:${encodeURIComponent(context.workflowRunId)}`;

export const prefetchEffectPromptWorkspace = (
  context: EffectPromptContext,
): Promise<GetEffectPromptWorkspaceData> =>
  prefetchEffectWorkspace(promptWorkspacePrefetchKey(context), () =>
    loadEffectPromptWorkspace(context),
  );

export const loadEffectPromptWorkspaceSnapshot = (
  context: EffectPromptContext,
  signal?: AbortSignal,
): Promise<EffectWorkspaceSnapshot<GetEffectPromptWorkspaceData>> =>
  loadEffectWorkspaceSnapshot(
    promptWorkspacePrefetchKey(context),
    (requestSignal) => loadEffectPromptWorkspace(context, requestSignal),
    signal,
  );

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
  pageSize: number,
  query: string,
  purpose?: EffectPromptFragmentType,
  purposeMatch: EffectPromptPurposeMatchMode = 'PRIMARY',
  signal?: AbortSignal,
): Promise<EffectPromptViewResultData> => {
  return (
    await getEffectPromptResult(
      projectId,
      workflowRunId,
      productId,
      page,
      pageSize,
      query,
      purpose,
      purposeMatch,
      signal,
    )
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
  primaryPurpose: EffectPromptFragmentType;
  creativeCore: string;
  dimensions: EffectPromptDimensions;
  targetDurationSeconds: number;
};

const promptItemInput = (draft: PromptItemDraft) => {
  const { creativeCore, dimensions, ...baseDraft } = draft;
  const normalizedCreativeCore = creativeCore.trim();
  const normalizedDimensions = Object.fromEntries(
    EFFECT_PROMPT_DIMENSIONS.map(({ key }) => [key, dimensions[key].trim()]),
  ) as EffectPromptDimensions;
  const hasCreativeStructure =
    normalizedCreativeCore.length > 0 ||
    EFFECT_PROMPT_DIMENSIONS.some(({ key }) => normalizedDimensions[key].length > 0);
  return {
    ...baseDraft,
    ...(hasCreativeStructure
      ? { creativeCore: normalizedCreativeCore, dimensions: normalizedDimensions }
      : {}),
  };
};

export const saveEffectPromptItem = async (
  projectId: string,
  resultId: string,
  expectedRevision: number,
  draft: PromptItemDraft,
  itemId?: string,
  signal?: AbortSignal,
): Promise<UpdateEffectPromptResultData> => {
  const input = {
    ...promptItemInput(draft),
    expectedRevision,
    evaluateAfterSave: false,
  };
  return itemId
    ? (await updateEffectPromptItem(projectId, resultId, itemId, input, signal)).data
    : (await addEffectPromptItem(projectId, resultId, input, signal)).data;
};

export const autoFillEffectPromptCreativeStructure = async (
  projectId: string,
  resultId: string,
  expectedRevision: number,
  expectedSettingsRevision: number,
  draft: PromptItemDraft,
  itemId?: string,
  signal?: AbortSignal,
): Promise<UpdateEffectPromptResultData> => {
  const input = {
    content: draft.content,
    primaryPurpose: draft.primaryPurpose,
    targetDurationSeconds: draft.targetDurationSeconds,
    expectedRevision,
    evaluateAfterSave: true,
    expectedSettingsRevision,
    idempotencyKey: createPromptIdempotencyKey(),
  };
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

export const applyPromptRegeneration = async (
  projectId: string,
  resultId: string,
  runId: string,
  candidateId: string,
  expectedRevision: number,
  signal?: AbortSignal,
): Promise<UpdateEffectPromptResultData> =>
  (
    await applyEffectPromptRegeneration(
      projectId,
      resultId,
      runId,
      { candidateId, expectedRevision, idempotencyKey: createPromptIdempotencyKey() },
      signal,
    )
  ).data;

export const undoPromptRegeneration = async (
  projectId: string,
  resultId: string,
  runId: string,
  expectedRevision: number,
  signal?: AbortSignal,
): Promise<UpdateEffectPromptResultData> =>
  (
    await undoEffectPromptRegeneration(
      projectId,
      resultId,
      runId,
      { expectedRevision, idempotencyKey: createPromptIdempotencyKey() },
      signal,
    )
  ).data;

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

const insightFieldLabels: Record<EffectPromptInsightField, string> = {
  PRODUCT_NAME: '产品名称',
  PRODUCT_CATEGORY: '产品品类',
  CORE_SPECIFICATION: '核心规格',
  PRICE_RANGE: '确认价格',
  VISUAL_FEATURES: '视觉特征',
  SELLING_POINT: '卖点',
  CORE_SELLING_POINT: '卖点（历史）',
  SECONDARY_SELLING_POINT: '次要卖点',
  TRUST_BACKING: '信任背书',
  TARGET_AUDIENCE: '目标受众',
  CORE_PAIN_POINT: '核心痛点',
  DECISION_DRIVER: '决策动机',
  MARKETING_GOAL: '营销目标',
  USAGE_SCENARIO: '使用场景',
  PURCHASE_SCENARIO: '购买场景',
  EMOTIONAL_SCENARIO: '情绪场景',
  SOURCE_DURATION: '上游时长',
  ASPECT_RATIO: '画幅',
  RESOLUTION: '分辨率',
  DELIVERY_CHANNELS: '投放渠道',
  DISABLED_ELEMENT: '禁用元素',
  VISUAL_STYLE_BASELINE: '视觉基线',
};

const csvCell = (value: string | number): string => {
  const text = String(value).normalize('NFC');
  const formulaSafe = /^[\t\r ]*[=+\-@]/u.test(text) ? `'${text}` : text;
  return `"${formulaSafe.replace(/"/gu, '""')}"`;
};

export const buildEffectPromptCsv = (
  productName: string,
  result: EffectPromptBatchResult,
): string => {
  const headers = [
    '商品',
    '编号',
    'Prompt 正文',
    '片段时长（秒）',
    '推荐用途',
    '其他兼容用途',
    ...EFFECT_PROMPT_DIMENSIONS.map(({ label }) => label),
    '提炼来源',
    '共用提示词',
    '画幅',
    '分辨率',
  ];
  const sharedPrompt = result.sharedPrompt?.compiledContent.trim() ?? '';
  const rows = result.items.map((item) => {
    const compatiblePurposes = item.compatiblePurposes.filter(
      (purpose) => purpose !== item.primaryPurpose,
    );
    const insightSources = [
      ...new Set(
        item.insightBindings.map(
          ({ field, value }) => `${insightFieldLabels[field]}：${value.trim()}`,
        ),
      ),
    ];
    return [
      productName.trim() || '当前商品',
      item.code,
      item.content,
      item.targetDurationSeconds,
      EFFECT_PROMPT_FRAGMENT_TYPE_LABELS[item.primaryPurpose],
      compatiblePurposes.map((purpose) => EFFECT_PROMPT_FRAGMENT_TYPE_LABELS[purpose]).join('；'),
      ...EFFECT_PROMPT_DIMENSIONS.map(({ key }) => item.dimensions[key]),
      insightSources.join('；'),
      sharedPrompt,
      result.renderProfile.ratio,
      result.renderProfile.resolution,
    ];
  });
  return `\uFEFF${[headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n')}`;
};

export const downloadEffectPromptBatch = async (
  projectId: string,
  resultId: string,
  productName: string,
  signal?: AbortSignal,
): Promise<{ blob: Blob; fileName: string }> => {
  const exported = (await exportEffectPromptResult(projectId, resultId, signal)).data;
  const safeProductName = (productName.trim() || '当前商品').replace(/[\\/:*?"<>|]/gu, '_');
  return {
    blob: new Blob([buildEffectPromptCsv(productName, exported.result)], {
      type: 'text/csv;charset=utf-8',
    }),
    fileName: `${safeProductName}-Prompt-${exported.result.items.length}条.csv`,
  };
};
