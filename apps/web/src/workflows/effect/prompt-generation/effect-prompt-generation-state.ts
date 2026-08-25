import type {
  EffectPromptBatchResult,
  EffectPromptBatchSettings,
  EffectPromptItem,
  EffectPromptProductState,
} from '@ai-marketing/contracts';
import {
  EFFECT_PROMPT_DIMENSIONS,
  EFFECT_PROMPT_LIMITS,
  normalizeEffectPromptSettings,
} from '@ai-marketing/contracts';

export { EFFECT_PROMPT_DIMENSIONS, EFFECT_PROMPT_LIMITS };
export type EffectPromptPageStatus = 'loading' | 'ready' | 'error';

export const normalizePromptSettings = normalizeEffectPromptSettings;

export const clonePromptSettings = (
  settings: EffectPromptBatchSettings,
): EffectPromptBatchSettings => ({ ...settings });

export const promptMatchesKeyword = (item: EffectPromptItem, keyword: string): boolean => {
  const normalized = keyword.trim().toLocaleLowerCase('zh-CN');
  if (!normalized) return true;
  return [
    item.code,
    item.fragmentType,
    item.content,
    ...EFFECT_PROMPT_DIMENSIONS.flatMap(({ key, label }) => [label, item.dimensions[key]]),
  ]
    .join('\n')
    .toLocaleLowerCase('zh-CN')
    .includes(normalized);
};

export const promptPageCount = (itemCount: number): number =>
  Math.max(1, Math.ceil(itemCount / EFFECT_PROMPT_LIMITS.pageSize));

export const isPromptRunActive = (state: EffectPromptProductState | null): boolean =>
  state?.status === 'QUEUED' || state?.status === 'PROCESSING';

export const isPromptResultQualityReady = (
  result: Pick<EffectPromptBatchResult, 'metrics' | 'qualityStatus' | 'settings'> | null,
): boolean =>
  Boolean(
    result &&
    result.qualityStatus === 'PASS' &&
    result.metrics.acceptedCount === result.settings.count &&
    result.metrics.semanticDuplicateRate <= result.settings.semanticLimit &&
    result.metrics.visualOverlapRate <= result.settings.visualLimit,
  );

export const isPromptProductCommitted = (state: EffectPromptProductState): boolean =>
  state.status === 'COMPLETED' &&
  state.qualityStatus === 'PASS' &&
  state.commitStatus === 'COMMITTED';
