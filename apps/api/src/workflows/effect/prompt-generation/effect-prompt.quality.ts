import type {
  EffectPromptBatchResult,
  EffectPromptBatchSettings,
  EffectPromptDimensions,
  EffectPromptItem,
  EffectPromptMetrics,
} from '@ai-marketing/contracts';
import {
  EFFECT_PROMPT_DIMENSIONS,
  EFFECT_PROMPT_LIMITS,
  EFFECT_PROMPT_SCHEMA_VERSION,
  normalizeEffectPromptSettings,
} from '@ai-marketing/contracts';
import type { EffectPromptInputSnapshot } from './effect-prompt.types';

export const EFFECT_PROMPT_SEMANTIC_SIMILARITY_THRESHOLD = 0.82;
export const EFFECT_PROMPT_VISUAL_OVERLAP_THRESHOLD = 0.75;
const visualWeights: Record<'scene' | 'persona' | 'camera' | 'emotion', number> = {
  scene: 0.35,
  persona: 0.2,
  camera: 0.3,
  emotion: 0.15,
};

const itemTextLimits = {
  id: 160,
  code: 40,
  fragmentType: 120,
  content: 12_000,
} as const;
const dimensionTextLimits: Record<keyof EffectPromptDimensions, number> = {
  narrative: 120,
  scene: 120,
  persona: 160,
  sellingPoint: 240,
  camera: 160,
  emotion: 120,
};

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const normalizedValue = (value: string): string =>
  value.normalize('NFC').trim().toLocaleLowerCase('zh-CN').replace(/\s+/gu, ' ');

const semanticText = (value: string): string =>
  normalizedValue(value)
    .replace(/(?:视频)?时长\s*[:：]?\s*\d+\s*(?:秒|s)/giu, '')
    .replace(/(?:画幅|比例)\s*[:：]?\s*\d+\s*[:：x×]\s*\d+/giu, '')
    .replace(/(?:投放)?渠道\s*[:：][^。；;\n]+/giu, '')
    .replace(/(?:合规|禁用元素|注意事项)\s*[:：][^。；;\n]+/giu, '')
    .replace(/[\p{P}\p{S}\s]+/gu, '');

const trigrams = (value: string): Set<string> => {
  const characters = [...semanticText(value)];
  if (characters.length < 3) return new Set(characters.length ? [characters.join('')] : []);
  return new Set(
    characters.slice(0, -2).map((_, index) => characters.slice(index, index + 3).join('')),
  );
};

export const trigramDice = (left: string, right: string): number => {
  const a = trigrams(left);
  const b = trigrams(right);
  if (!a.size && !b.size) return 1;
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const gram of a) if (b.has(gram)) intersection += 1;
  return (2 * intersection) / (a.size + b.size);
};

const signature = (item: EffectPromptItem): string =>
  ['narrative', 'sellingPoint', 'scene']
    .map((key) => normalizedValue(item.dimensions[key as keyof EffectPromptDimensions]))
    .join('|');

export const dimensionDistance = (left: EffectPromptItem, right: EffectPromptItem): number =>
  EFFECT_PROMPT_DIMENSIONS.reduce(
    (distance, dimension) =>
      distance +
      Number(
        normalizedValue(left.dimensions[dimension.key]) !==
          normalizedValue(right.dimensions[dimension.key]),
      ),
    0,
  );

export const visualOverlap = (left: EffectPromptItem, right: EffectPromptItem): number =>
  (Object.keys(visualWeights) as Array<keyof typeof visualWeights>).reduce(
    (score, key) =>
      score +
      (normalizedValue(left.dimensions[key]) === normalizedValue(right.dimensions[key])
        ? visualWeights[key]
        : 0),
    0,
  );

export const promptPairViolationRate = (violations: number, count: number): number => {
  const totalPairs = (count * (count - 1)) / 2;
  return totalPairs === 0
    ? 0
    : Math.floor((violations * 10_000 + totalPairs / 2) / totalPairs) / 100;
};

const validDimensions = (value: unknown): value is EffectPromptDimensions => {
  const candidate = record(value);
  return Boolean(
    candidate &&
    Object.keys(candidate).length === EFFECT_PROMPT_DIMENSIONS.length &&
    EFFECT_PROMPT_DIMENSIONS.every(
      ({ key }) =>
        typeof candidate[key] === 'string' &&
        candidate[key].trim().length > 0 &&
        candidate[key].length <= dimensionTextLimits[key],
    ),
  );
};

const validDateTime = (value: unknown): value is string =>
  typeof value === 'string' && !Number.isNaN(Date.parse(value));

export const isEffectPromptItem = (value: unknown): value is EffectPromptItem => {
  const item = record(value);
  return Boolean(
    item &&
    typeof item.id === 'string' &&
    item.id.length > 0 &&
    item.id.length <= itemTextLimits.id &&
    typeof item.code === 'string' &&
    item.code.trim().length > 0 &&
    item.code.length <= itemTextLimits.code &&
    (item.origin === 'AI' || item.origin === 'MANUAL') &&
    typeof item.fragmentType === 'string' &&
    item.fragmentType.trim().length > 0 &&
    item.fragmentType.length <= itemTextLimits.fragmentType &&
    validDimensions(item.dimensions) &&
    typeof item.content === 'string' &&
    item.content.trim().length > 0 &&
    item.content.length <= itemTextLimits.content &&
    typeof item.manualEdited === 'boolean' &&
    validDateTime(item.createdAt) &&
    validDateTime(item.updatedAt) &&
    Object.keys(item).length === 9,
  );
};

export const isEffectPromptSettings = (value: unknown): value is EffectPromptBatchSettings => {
  const settings = record(value);
  if (!settings) return false;
  return (
    Object.keys(settings).length === 4 &&
    Number.isInteger(settings.count) &&
    Number(settings.count) >= EFFECT_PROMPT_LIMITS.minCount &&
    Number(settings.count) <= EFFECT_PROMPT_LIMITS.maxCount &&
    Number.isInteger(settings.durationSeconds) &&
    Number(settings.durationSeconds) >= EFFECT_PROMPT_LIMITS.minDurationSeconds &&
    Number(settings.durationSeconds) <= EFFECT_PROMPT_LIMITS.maxDurationSeconds &&
    Number.isInteger(settings.semanticLimit) &&
    Number(settings.semanticLimit) >= EFFECT_PROMPT_LIMITS.minSemanticDuplicateRate &&
    Number(settings.semanticLimit) <= EFFECT_PROMPT_LIMITS.maxSemanticDuplicateRate &&
    Number.isInteger(settings.visualLimit) &&
    Number(settings.visualLimit) >= EFFECT_PROMPT_LIMITS.minVisualOverlapRate &&
    Number(settings.visualLimit) <= EFFECT_PROMPT_LIMITS.maxVisualOverlapRate
  );
};

const validMetrics = (value: unknown): value is EffectPromptMetrics => {
  const metrics = record(value);
  if (!metrics || Object.keys(metrics).length !== 9) return false;
  const integer = (key: keyof EffectPromptMetrics, minimum: number, maximum = Infinity) =>
    Number.isInteger(metrics[key]) &&
    Number(metrics[key]) >= minimum &&
    Number(metrics[key]) <= maximum;
  const rate = (key: 'semanticDuplicateRate' | 'visualOverlapRate') =>
    typeof metrics[key] === 'number' &&
    Number.isFinite(metrics[key]) &&
    metrics[key] >= 0 &&
    metrics[key] <= 100;
  return (
    integer('targetCount', EFFECT_PROMPT_LIMITS.minCount, EFFECT_PROMPT_LIMITS.maxCount) &&
    integer('acceptedCount', 0, EFFECT_PROMPT_LIMITS.maxCount) &&
    integer('generatedCandidateCount', 0) &&
    integer('removedSemanticDuplicates', 0) &&
    integer('removedVisualDuplicates', 0) &&
    integer('removedDimensionConflicts', 0) &&
    rate('semanticDuplicateRate') &&
    rate('visualOverlapRate') &&
    integer('replenishmentRounds', 0, EFFECT_PROMPT_LIMITS.maxReplenishmentRounds)
  );
};

export const recomputePromptQuality = (
  rawItems: EffectPromptItem[],
  rawSettings: EffectPromptBatchSettings,
  previous?: Partial<EffectPromptMetrics>,
): Pick<
  EffectPromptBatchResult,
  'schemaVersion' | 'settings' | 'items' | 'metrics' | 'qualityStatus'
> => {
  const settings = normalizeEffectPromptSettings(rawSettings);
  const items = rawItems.filter(isEffectPromptItem);
  let semanticViolations = 0;
  let visualViolations = 0;
  let dimensionConflicts = 0;
  for (let left = 0; left < items.length; left += 1) {
    for (let right = left + 1; right < items.length; right += 1) {
      if (
        signature(items[left]!) === signature(items[right]!) ||
        trigramDice(items[left]!.content, items[right]!.content) >=
          EFFECT_PROMPT_SEMANTIC_SIMILARITY_THRESHOLD
      )
        semanticViolations += 1;
      if (visualOverlap(items[left]!, items[right]!) >= EFFECT_PROMPT_VISUAL_OVERLAP_THRESHOLD)
        visualViolations += 1;
      if (dimensionDistance(items[left]!, items[right]!) < 3) dimensionConflicts += 1;
    }
  }
  const semanticDuplicateRate = promptPairViolationRate(semanticViolations, items.length);
  const visualOverlapRate = promptPairViolationRate(visualViolations, items.length);
  const metrics: EffectPromptMetrics = {
    targetCount: settings.count,
    acceptedCount: items.length,
    generatedCandidateCount: Math.max(
      previous?.generatedCandidateCount ?? items.length,
      items.length,
    ),
    removedSemanticDuplicates: Math.max(previous?.removedSemanticDuplicates ?? 0, 0),
    removedVisualDuplicates: Math.max(previous?.removedVisualDuplicates ?? 0, 0),
    removedDimensionConflicts: Math.max(
      previous?.removedDimensionConflicts ?? 0,
      dimensionConflicts,
    ),
    semanticDuplicateRate,
    visualOverlapRate,
    replenishmentRounds: Math.min(
      EFFECT_PROMPT_LIMITS.maxReplenishmentRounds,
      Math.max(previous?.replenishmentRounds ?? 0, 0),
    ),
  };
  const qualityStatus =
    items.length === settings.count &&
    dimensionConflicts === 0 &&
    semanticDuplicateRate <= settings.semanticLimit &&
    visualOverlapRate <= settings.visualLimit
      ? 'PASS'
      : 'NEEDS_REVIEW';
  return { schemaVersion: EFFECT_PROMPT_SCHEMA_VERSION, settings, items, metrics, qualityStatus };
};

export const parseEffectPromptBatchResult = (value: unknown): EffectPromptBatchResult | null => {
  const candidate = record(value);
  if (
    !candidate ||
    candidate.schemaVersion !== EFFECT_PROMPT_SCHEMA_VERSION ||
    !isEffectPromptSettings(candidate.settings) ||
    !Array.isArray(candidate.items) ||
    candidate.items.length > EFFECT_PROMPT_LIMITS.maxCount ||
    !validMetrics(candidate.metrics) ||
    !['PASS', 'NEEDS_REVIEW'].includes(String(candidate.qualityStatus)) ||
    Object.keys(candidate).length !== 5
  )
    return null;
  const items = candidate.items.filter(isEffectPromptItem);
  if (
    items.length !== candidate.items.length ||
    new Set(items.map(({ id }) => id)).size !== items.length
  )
    return null;
  return recomputePromptQuality(
    items,
    candidate.settings,
    record(candidate.metrics) as Partial<EffectPromptMetrics> | undefined,
  );
};

export const mergeEffectPromptCompletionItems = (
  candidateItems: EffectPromptItem[],
  snapshot: EffectPromptInputSnapshot,
): EffectPromptItem[] => {
  if (snapshot.operation === 'BATCH_GENERATE') {
    const merged = new Map(candidateItems.map((item) => [item.id, item]));
    for (const item of snapshot.retainedManualItems) merged.set(item.id, item);
    return [...merged.values()].slice(0, snapshot.settings.count);
  }
  const target = snapshot.targetItem;
  const targetIndex = snapshot.targetItemIndex;
  if (!target || targetIndex === undefined) return [...snapshot.retainedManualItems];
  const retainedIds = new Set(snapshot.retainedManualItems.map(({ id }) => id));
  const replacement =
    candidateItems.find(({ id }) => id === target.id) ??
    candidateItems.find(({ id }) => !retainedIds.has(id));
  if (!replacement) return [...snapshot.retainedManualItems];
  const stableReplacement: EffectPromptItem = {
    ...replacement,
    id: target.id,
    code: target.code,
    origin: 'AI',
    manualEdited: false,
    createdAt: target.createdAt,
  };
  const merged = [...snapshot.retainedManualItems];
  merged.splice(Math.min(Math.max(targetIndex, 0), merged.length), 0, stableReplacement);
  return merged;
};
