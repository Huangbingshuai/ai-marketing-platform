import type {
  EffectPromptBatchSettings,
  EffectPromptDimensions,
  EffectPromptFragmentType,
  EffectPromptItem,
  EffectPromptNodeId,
  EffectPromptRun,
  GetEffectPromptNodeDetailData,
  GetEffectPromptResultData,
  GetEffectPromptWorkspaceData,
  StartEffectPromptRunRequest,
  UpdateEffectPromptResultData,
  ValidateEffectPromptResultData,
} from '@ai-marketing/contracts';

import {
  addEffectPromptItem,
  deleteEffectPromptItem,
  exportEffectPromptResult,
  getEffectPromptNodeDetail,
  getEffectPromptResult,
  getEffectPromptRun,
  getEffectPromptWorkspace,
  saveEffectPromptSettings,
  startEffectPromptRun,
  updateEffectPromptItem,
  validateEffectPromptResult,
} from '../api/effect-prompt-generation.api';

export type EffectPromptContext = {
  projectId: string;
  workflowRunId: string;
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
): Promise<GetEffectPromptWorkspaceData> =>
  (await getEffectPromptWorkspace(context.projectId, context.workflowRunId, signal)).data;

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
  fragmentType?: EffectPromptFragmentType,
  signal?: AbortSignal,
): Promise<GetEffectPromptResultData> =>
  (
    await getEffectPromptResult(
      projectId,
      workflowRunId,
      productId,
      page,
      query,
      fragmentType,
      signal,
    )
  ).data;

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
  while (true) {
    if (signal?.aborted) throw abortError();
    const run = await loadEffectPromptRun(projectId, runId, signal);
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
  fragmentType: EffectPromptFragmentType;
  materialTags: string[];
  dimensions: EffectPromptDimensions;
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
  return {
    blob: new Blob([JSON.stringify(exported, null, 2)], {
      type: 'application/json;charset=utf-8',
    }),
    fileName: `${productName.trim() || '当前商品'}-差异化Prompt-${exported.result.items.length}条.json`,
  };
};
