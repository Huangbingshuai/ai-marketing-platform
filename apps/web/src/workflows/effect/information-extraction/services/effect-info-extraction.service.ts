import type {
  EffectExtractionRun,
  EffectExtractionResult,
  GetEffectExtractionWorkspaceData,
  UpdateEffectExtractionResultData,
} from '@ai-marketing/contracts';

import {
  getEffectExtractionRun,
  getEffectExtractionWorkspace,
  startEffectExtractionRun,
  updateEffectExtractionResult,
} from '../api/effect-info-extraction.api';

export type EffectExtractionContext = {
  projectId: string;
  draftId: string;
};

export type PollEffectExtractionRunOptions = {
  intervalMs?: number;
  onUpdate?: (run: EffectExtractionRun) => void;
  signal?: AbortSignal;
};

const abortError = (): DOMException => new DOMException('AI 信息提炼轮询已取消', 'AbortError');

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

export const createExtractionIdempotencyKey = (): string => {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  return `effect-extraction-${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

export const isTerminalExtractionRun = (run: EffectExtractionRun): boolean =>
  run.status === 'COMPLETED' || run.status === 'FAILED';

export const loadEffectExtractionWorkspace = async (
  context: EffectExtractionContext,
  signal?: AbortSignal,
): Promise<GetEffectExtractionWorkspaceData> =>
  (await getEffectExtractionWorkspace(context.projectId, context.draftId, signal)).data;

export const beginEffectExtraction = async (
  context: EffectExtractionContext,
  productId: string,
  expectedRevision: number,
  signal?: AbortSignal,
): Promise<EffectExtractionRun> =>
  (
    await startEffectExtractionRun(
      context.projectId,
      productId,
      {
        draftId: context.draftId,
        expectedRevision,
        idempotencyKey: createExtractionIdempotencyKey(),
      },
      signal,
    )
  ).data.run;

export const loadEffectExtractionRun = async (
  projectId: string,
  runId: string,
  signal?: AbortSignal,
): Promise<EffectExtractionRun> =>
  (await getEffectExtractionRun(projectId, runId, signal)).data.run;

export const pollEffectExtractionRun = async (
  projectId: string,
  runId: string,
  { intervalMs = 1_200, onUpdate, signal }: PollEffectExtractionRunOptions = {},
): Promise<EffectExtractionRun> => {
  while (true) {
    if (signal?.aborted) throw abortError();
    const run = (await getEffectExtractionRun(projectId, runId, signal)).data.run;
    onUpdate?.(run);
    if (isTerminalExtractionRun(run)) return run;
    await waitForNextPoll(intervalMs, signal);
  }
};

export const saveEffectExtractionResult = async (
  projectId: string,
  resultId: string,
  expectedRevision: number,
  result: EffectExtractionResult,
  signal?: AbortSignal,
): Promise<UpdateEffectExtractionResultData> =>
  (await updateEffectExtractionResult(projectId, resultId, { expectedRevision, result }, signal))
    .data;
