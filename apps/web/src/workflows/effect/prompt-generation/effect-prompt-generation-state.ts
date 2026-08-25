export const EFFECT_PROMPT_LIMITS = {
  minCount: 10,
  maxCount: 200,
  defaultCount: 50,
  minDurationSeconds: 10,
  maxDurationSeconds: 120,
  minSemanticSimilarity: 5,
  maxSemanticSimilarity: 15,
  minVisualSimilarity: 10,
  maxVisualSimilarity: 20,
  pageSize: 10,
} as const;

export type EffectPromptDimensionKey =
  'narrative' | 'scene' | 'persona' | 'sellingPoint' | 'camera' | 'emotion';

export type EffectPromptDimension = {
  key: EffectPromptDimensionKey;
  label: string;
  value: string;
};

export type EffectPromptItem = {
  id: string;
  code: string;
  fragmentType: string;
  dimensions: EffectPromptDimension[];
  content: string;
  semanticSimilarity: number;
  visualSimilarity: number;
  createdAt: string;
  updatedAt: string;
};

export type EffectPromptBatchSettings = {
  count: number;
  durationSeconds: number;
  semanticLimit: number;
  visualLimit: number;
};

export type EffectPromptMetrics = {
  generatedCount: number;
  removedDuplicates: number;
  semanticSimilarity: number;
  visualSimilarity: number;
};

export type EffectPromptWorkspace = {
  version: 1;
  hasGenerated: boolean;
  settings: EffectPromptBatchSettings;
  items: EffectPromptItem[];
  metrics: EffectPromptMetrics;
  updatedAt: string;
};

export type EffectPromptPageStatus = 'loading' | 'ready' | 'generating' | 'error';

export const clampPromptSetting = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, Math.round(Number.isFinite(value) ? value : minimum)));

export const normalizePromptSettings = (
  settings: EffectPromptBatchSettings,
): EffectPromptBatchSettings => ({
  count: clampPromptSetting(
    settings.count,
    EFFECT_PROMPT_LIMITS.minCount,
    EFFECT_PROMPT_LIMITS.maxCount,
  ),
  durationSeconds: clampPromptSetting(
    settings.durationSeconds,
    EFFECT_PROMPT_LIMITS.minDurationSeconds,
    EFFECT_PROMPT_LIMITS.maxDurationSeconds,
  ),
  semanticLimit: clampPromptSetting(
    settings.semanticLimit,
    EFFECT_PROMPT_LIMITS.minSemanticSimilarity,
    EFFECT_PROMPT_LIMITS.maxSemanticSimilarity,
  ),
  visualLimit: clampPromptSetting(
    settings.visualLimit,
    EFFECT_PROMPT_LIMITS.minVisualSimilarity,
    EFFECT_PROMPT_LIMITS.maxVisualSimilarity,
  ),
});

export const clonePromptItem = (item: EffectPromptItem): EffectPromptItem => ({
  ...item,
  dimensions: item.dimensions.map((dimension) => ({ ...dimension })),
});

export const clonePromptWorkspace = (workspace: EffectPromptWorkspace): EffectPromptWorkspace => ({
  ...workspace,
  settings: { ...workspace.settings },
  metrics: { ...workspace.metrics },
  items: workspace.items.map(clonePromptItem),
});

export const promptMatchesKeyword = (item: EffectPromptItem, keyword: string): boolean => {
  const normalized = keyword.trim().toLocaleLowerCase('zh-CN');
  if (!normalized) return true;
  return [
    item.code,
    item.fragmentType,
    item.content,
    ...item.dimensions.flatMap((dimension) => [dimension.label, dimension.value]),
  ]
    .join('\n')
    .toLocaleLowerCase('zh-CN')
    .includes(normalized);
};

export const promptPageCount = (itemCount: number): number =>
  Math.max(1, Math.ceil(itemCount / EFFECT_PROMPT_LIMITS.pageSize));

export const promptPageItems = (items: EffectPromptItem[], page: number): EffectPromptItem[] => {
  const safePage = Math.min(promptPageCount(items.length), Math.max(1, Math.round(page)));
  const start = (safePage - 1) * EFFECT_PROMPT_LIMITS.pageSize;
  return items.slice(start, start + EFFECT_PROMPT_LIMITS.pageSize);
};

export const isPromptWorkspaceComplete = (workspace: EffectPromptWorkspace): boolean =>
  workspace.items.length === workspace.settings.count &&
  workspace.items.every((item) => item.dimensions.length >= 3) &&
  workspace.metrics.semanticSimilarity <= workspace.settings.semanticLimit &&
  workspace.metrics.visualSimilarity <= workspace.settings.visualLimit;
