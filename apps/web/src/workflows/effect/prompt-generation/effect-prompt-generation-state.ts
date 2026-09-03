import type {
  EffectPromptBatchResult,
  EffectPromptBatchSettings,
  EffectPromptProductState,
} from '@ai-marketing/contracts';
import { EFFECT_PROMPT_LIMITS, normalizeEffectPromptSettings } from '@ai-marketing/contracts';

export { EFFECT_PROMPT_LIMITS };
export type EffectPromptPageStatus = 'loading' | 'ready' | 'error';

const hydratePromptSettings = (settings: EffectPromptBatchSettings): EffectPromptBatchSettings => ({
  targetCount: settings.targetCount,
  defaultDurationSeconds: settings.defaultDurationSeconds,
});

export const normalizePromptSettings = (
  settings: EffectPromptBatchSettings,
): EffectPromptBatchSettings => {
  const hydrated = hydratePromptSettings(settings);
  return hydratePromptSettings({ ...hydrated, ...normalizeEffectPromptSettings(hydrated) });
};

export const clonePromptSettings = (
  settings: EffectPromptBatchSettings,
): EffectPromptBatchSettings => hydratePromptSettings(settings);

export const promptPageCount = (itemCount: number): number =>
  Math.max(1, Math.ceil(itemCount / EFFECT_PROMPT_LIMITS.pageSize));

export const clampPromptPage = (page: number, itemCount: number): number => {
  const normalizedPage = Number.isFinite(page) ? Math.max(1, Math.trunc(page)) : 1;
  return Math.min(normalizedPage, promptPageCount(itemCount));
};

export const isPromptRunActive = (state: EffectPromptProductState | null): boolean =>
  state?.status === 'QUEUED' || state?.status === 'PROCESSING';

export const isPromptResultQualityReady = (
  result: Pick<EffectPromptBatchResult, 'metrics' | 'qualityStatus' | 'settings'> | null,
): boolean =>
  Boolean(
    result &&
    result.qualityStatus === 'PASS' &&
    result.metrics.acceptedCount === result.settings.targetCount,
  );

export const isPromptProductCommitted = (state: EffectPromptProductState): boolean =>
  state.status === 'COMPLETED' &&
  state.qualityStatus === 'PASS' &&
  state.commitStatus === 'COMMITTED';
