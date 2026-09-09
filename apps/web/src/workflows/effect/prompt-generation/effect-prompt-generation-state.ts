import type { EffectPromptBatchSettings, EffectPromptProductState } from '@ai-marketing/contracts';
import { EFFECT_PROMPT_LIMITS, normalizeEffectPromptSettings } from '@ai-marketing/contracts';

export { EFFECT_PROMPT_LIMITS };
export type EffectPromptPageStatus = 'loading' | 'ready' | 'error';

export const EFFECT_PROMPT_PAGE_SIZE_OPTIONS = [5, 10, 20, 50, 100] as const;

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
  return hydratePromptSettings({ ...hydrated, ...normalizeEffectPromptSettings(hydrated) });
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
