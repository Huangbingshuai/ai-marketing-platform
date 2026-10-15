import type {
  EffectPromptBatchSettings,
  EffectPromptFragmentType,
  EffectPromptProductState,
} from '@ai-marketing/contracts';
import { EFFECT_PROMPT_LIMITS, normalizeEffectPromptSettings } from '@ai-marketing/contracts';

export { EFFECT_PROMPT_LIMITS };
export type EffectPromptPageStatus = 'loading' | 'ready' | 'error';

export const isPromptWorkspaceScopeReady = (
  status: EffectPromptPageStatus,
  loaded: { projectId: string; workflowRunId: string } | null,
  current: { projectId: string; workflowRunId: string },
): boolean => status === 'ready' && loaded?.projectId === current.projectId &&
  loaded.workflowRunId === current.workflowRunId;

export const EFFECT_PROMPT_PAGE_SIZE_OPTIONS = [5, 10, 20, 50, 100] as const;

/** A known edit handoff may retain its read-only view, never an unrelated branch. */
export const resolvePromptTransitionValue = <T>(
  current: T | null,
  transition: { projectId: string; workflowRunId: string; value: T | null } | null,
  scope: { projectId: string; workflowRunId: string },
): T | null => current ?? (
  transition?.projectId === scope.projectId && transition.workflowRunId === scope.workflowRunId
    ? transition.value : null
);

export const changePromptPrimaryPurpose = (
  previous: EffectPromptFragmentType,
  next: EffectPromptFragmentType,
  compatible: EffectPromptFragmentType[],
): EffectPromptFragmentType[] => (previous === next ? [...new Set([next, ...compatible])] : [next]);

export const normalizeManualPromptDuration = (value: number): number =>
  Math.min(
    EFFECT_PROMPT_LIMITS.maxManualDurationSeconds,
    Math.max(
      EFFECT_PROMPT_LIMITS.minDurationSeconds,
      Number.isFinite(value) ? Math.round(value) : EFFECT_PROMPT_LIMITS.minDurationSeconds,
    ),
  );

const hydratePromptSettings = (settings: EffectPromptBatchSettings): EffectPromptBatchSettings => ({
  targetCount: settings.targetCount,
  defaultDurationSeconds: settings.defaultDurationSeconds,
  styleMode: settings.styleMode ?? 'AI_AUTO',
  styleTone: settings.styleTone ?? null,
  deliveryChannel: settings.deliveryChannel ?? '抖音',
  disabledElements: [...(settings.disabledElements ?? [])],
});

export const normalizePromptSettings = (
  settings: EffectPromptBatchSettings,
): EffectPromptBatchSettings => {
  const hydrated = hydratePromptSettings(settings);
  const normalized = normalizeEffectPromptSettings(hydrated);
  return hydratePromptSettings({
    ...hydrated,
    ...normalized,
    targetCount: Math.max(EFFECT_PROMPT_LIMITS.minNewBatchCount, normalized.targetCount),
  });
};

export const clonePromptSettings = (
  settings: EffectPromptBatchSettings,
): EffectPromptBatchSettings => hydratePromptSettings(settings);

export const promptPageCount = (
  itemCount: number,
  pageSize: number = EFFECT_PROMPT_LIMITS.pageSize,
): number => Math.max(1, Math.ceil(itemCount / Math.max(1, Math.trunc(pageSize))));

export const clampPromptPage = (
  page: number,
  itemCount: number,
  pageSize: number = EFFECT_PROMPT_LIMITS.pageSize,
): number => {
  const normalizedPage = Number.isFinite(page) ? Math.max(1, Math.trunc(page)) : 1;
  return Math.min(normalizedPage, promptPageCount(itemCount, pageSize));
};

export const isPromptRunActive = (state: EffectPromptProductState | null): boolean =>
  state?.status === 'QUEUED' || state?.status === 'PROCESSING';

export const isPromptProductCommitted = (state: EffectPromptProductState): boolean =>
  state.status === 'COMPLETED' && state.commitStatus === 'COMMITTED';
