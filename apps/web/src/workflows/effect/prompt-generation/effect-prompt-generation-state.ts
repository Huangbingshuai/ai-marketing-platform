import type {
  EffectPromptBatchResult,
  EffectPromptBatchSettings,
  EffectPromptItem,
  EffectPromptProductState,
} from '@ai-marketing/contracts';
import {
  EFFECT_PROMPT_DIMENSIONS,
  EFFECT_PROMPT_FRAGMENT_TYPE_LABELS,
  EFFECT_PROMPT_LIMITS,
  effectPromptTargetCount,
  normalizeEffectPromptSettings,
} from '@ai-marketing/contracts';

export { EFFECT_PROMPT_DIMENSIONS, EFFECT_PROMPT_LIMITS };
export type EffectPromptPageStatus = 'loading' | 'ready' | 'error';

const hydratePromptSettings = (settings: EffectPromptBatchSettings): EffectPromptBatchSettings => ({
  fragmentConfigs: Object.fromEntries(
    Object.entries(settings.fragmentConfigs).map(([fragmentType, config]) => [
      fragmentType,
      { ...config },
    ]),
  ) as EffectPromptBatchSettings['fragmentConfigs'],
  semanticLimit: settings.semanticLimit,
  visualLimit: settings.visualLimit,
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

export const promptMatchesKeyword = (item: EffectPromptItem, keyword: string): boolean => {
  const normalized = keyword.trim().toLocaleLowerCase('zh-CN');
  if (!normalized) return true;
  return [
    item.code,
    item.fragmentType,
    EFFECT_PROMPT_FRAGMENT_TYPE_LABELS[item.fragmentType],
    ...(Array.isArray(item.materialTags) ? item.materialTags : []),
    ...(Number.isFinite(item.targetDurationSeconds) ? [`${item.targetDurationSeconds}秒`] : []),
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
    result.metrics.acceptedCount === effectPromptTargetCount(result.settings) &&
    (!Array.isArray(result.metrics.fragmentTypeDistribution) ||
      result.metrics.fragmentTypeDistribution.every(
        ({ actualCount, targetCount }) => actualCount === targetCount,
      )) &&
    (!result.metrics.sellingPointCoverage ||
      result.metrics.sellingPointCoverage.missing.length === 0) &&
    result.metrics.semanticDuplicateRate <= result.settings.semanticLimit &&
    result.metrics.visualOverlapRate <= result.settings.visualLimit,
  );

export const isPromptProductCommitted = (state: EffectPromptProductState): boolean =>
  state.status === 'COMPLETED' &&
  state.qualityStatus === 'PASS' &&
  state.commitStatus === 'COMMITTED';
