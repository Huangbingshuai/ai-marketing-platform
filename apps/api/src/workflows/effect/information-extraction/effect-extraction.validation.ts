import { createHash, timingSafeEqual } from 'node:crypto';

import type {
  EffectExtractionResult,
  EffectExtractionWarning,
  EffectVideoConfig,
} from '@ai-marketing/contracts';
import {
  EFFECT_EXTRACTION_BRANCHES,
  EFFECT_EXTRACTION_MAX_AUDIENCE_ITEMS,
  EFFECT_EXTRACTION_MAX_CORE_SELLING_POINTS,
  EFFECT_EXTRACTION_MAX_SCENARIO_ITEMS,
  EFFECT_EXTRACTION_MAX_SECONDARY_SELLING_POINTS,
  EFFECT_EXTRACTION_MAX_TRUST_BACKINGS,
} from '@ai-marketing/contracts';

const RESULT_KEYS = [
  'productCategory',
  'productName',
  'coreSpecification',
  'priceRange',
  'visualFeatures',
  'coreSellingPoints',
  'secondarySellingPoints',
  'trustBackings',
  'targetAudience',
  'corePainPoints',
  'decisionDrivers',
  'marketingGoal',
  'usageScenarios',
  'purchaseScenarios',
  'emotionalScenarios',
  'durationSeconds',
  'aspectRatio',
  'resolution',
  'deliveryChannels',
  'disabledElements',
  'visualStyleBaseline',
] as const;

export type EffectExtractionManualOverrides = Partial<EffectExtractionResult>;

export type EffectExtractionResultDefaults = Pick<
  EffectExtractionResult,
  | 'durationSeconds'
  | 'aspectRatio'
  | 'resolution'
  | 'deliveryChannels'
  | 'disabledElements'
  | 'visualStyleBaseline'
>;

export const effectExtractionDefaultsFromConfig = (
  config: EffectVideoConfig,
): EffectExtractionResultDefaults => ({
  durationSeconds: config.durationSeconds,
  aspectRatio: config.aspectRatio,
  resolution: config.resolution,
  deliveryChannels: config.deliveryChannel,
  disabledElements: [...config.disabledElements],
  visualStyleBaseline: config.styleTone,
});

const canonicalValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalValue(item)]),
    );
  }
  return value;
};

export const canonicalHash = (value: unknown): string =>
  createHash('sha256')
    .update(JSON.stringify(canonicalValue(value)))
    .digest('hex');

export const extractionSourceFingerprint = (
  snapshot: { sourceRevision: number; dependencySnapshot?: unknown } & Record<string, unknown>,
): string =>
  canonicalHash(
    snapshot.dependencySnapshot ??
      Object.fromEntries(Object.entries(snapshot).filter(([key]) => key !== 'sourceRevision')),
  );

export const isSupportedExtractionMaterial = (
  mimeType: string | null,
  originalFileName: string | null,
): boolean => {
  const mime = mimeType?.toLowerCase() ?? '';
  const name = originalFileName?.toLowerCase() ?? '';
  return (
    mime.startsWith('image/') ||
    mime === 'application/pdf' ||
    mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    name.endsWith('.pdf') ||
    name.endsWith('.docx')
  );
};

const validString = (value: unknown, max = 5000): value is string =>
  typeof value === 'string' && value.length <= max;

const validStringArray = (value: unknown, maxItems: number): value is string[] =>
  Array.isArray(value) &&
  value.length <= maxItems &&
  value.every((item) => validString(item, 1000));

const compactStrings = (value: unknown, maxItems: number): string[] => {
  const input = Array.isArray(value)
    ? value
    : typeof value === 'string' && value.trim()
      ? [value]
      : [];
  const seen = new Set<string>();
  return input
    .flatMap((item) => {
      if (typeof item !== 'string') return [];
      const normalized = item.trim();
      const key = normalized.toLocaleLowerCase();
      if (!normalized || seen.has(key)) return [];
      seen.add(key);
      return [normalized];
    })
    .slice(0, maxItems);
};

const text = (record: Record<string, unknown>, key: string): string =>
  typeof record[key] === 'string' ? record[key] : '';

export const toEffectExtractionResultV2 = (
  value: unknown,
  defaults: EffectExtractionResultDefaults,
): EffectExtractionResult => {
  const record =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const allSellingPoints = compactStrings(record.coreSellingPoints, 9);
  const explicitSecondary = compactStrings(
    record.secondarySellingPoints,
    EFFECT_EXTRACTION_MAX_SECONDARY_SELLING_POINTS,
  );
  return {
    productCategory: text(record, 'productCategory'),
    productName: text(record, 'productName'),
    coreSpecification: text(record, 'coreSpecification'),
    priceRange: text(record, 'priceRange'),
    visualFeatures: text(record, 'visualFeatures'),
    coreSellingPoints: allSellingPoints.slice(0, EFFECT_EXTRACTION_MAX_CORE_SELLING_POINTS),
    secondarySellingPoints: compactStrings(
      [...allSellingPoints.slice(EFFECT_EXTRACTION_MAX_CORE_SELLING_POINTS), ...explicitSecondary],
      EFFECT_EXTRACTION_MAX_SECONDARY_SELLING_POINTS,
    ),
    trustBackings: compactStrings(record.trustBackings, EFFECT_EXTRACTION_MAX_TRUST_BACKINGS),
    targetAudience: text(record, 'targetAudience'),
    corePainPoints: compactStrings(record.corePainPoints, EFFECT_EXTRACTION_MAX_AUDIENCE_ITEMS),
    decisionDrivers: compactStrings(record.decisionDrivers, EFFECT_EXTRACTION_MAX_AUDIENCE_ITEMS),
    marketingGoal: text(record, 'marketingGoal'),
    usageScenarios: compactStrings(record.usageScenarios, EFFECT_EXTRACTION_MAX_SCENARIO_ITEMS),
    purchaseScenarios: compactStrings(
      record.purchaseScenarios,
      EFFECT_EXTRACTION_MAX_SCENARIO_ITEMS,
    ),
    emotionalScenarios: compactStrings(
      record.emotionalScenarios,
      EFFECT_EXTRACTION_MAX_SCENARIO_ITEMS,
    ),
    durationSeconds:
      Number.isInteger(record.durationSeconds) && Number(record.durationSeconds) > 0
        ? Number(record.durationSeconds)
        : defaults.durationSeconds,
    aspectRatio: text(record, 'aspectRatio') || defaults.aspectRatio,
    resolution: text(record, 'resolution') || defaults.resolution,
    deliveryChannels: text(record, 'deliveryChannels') || defaults.deliveryChannels,
    disabledElements: compactStrings(
      Array.isArray(record.disabledElements) ? record.disabledElements : defaults.disabledElements,
      100,
    ),
    visualStyleBaseline:
      text(record, 'visualStyleBaseline') ||
      text(record, 'brandTone') ||
      defaults.visualStyleBaseline,
  };
};

export const manualOverridesForResult = (
  generated: EffectExtractionResult,
  draft: EffectExtractionResult,
): EffectExtractionManualOverrides =>
  Object.fromEntries(
    RESULT_KEYS.flatMap((key) =>
      canonicalHash(generated[key]) === canonicalHash(draft[key]) ? [] : [[key, draft[key]]],
    ),
  ) as EffectExtractionManualOverrides;

export const applyEffectExtractionManualOverrides = (
  generated: EffectExtractionResult,
  overrides: unknown,
): EffectExtractionResult => {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) return generated;
  const record = overrides as Record<string, unknown>;
  return Object.fromEntries(
    RESULT_KEYS.map((key) => [key, key in record ? record[key] : generated[key]]),
  ) as EffectExtractionResult;
};

export const manualOverrideFieldNames = (value: unknown): string[] => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const keys = new Set<string>(RESULT_KEYS);
  return Object.keys(value as Record<string, unknown>)
    .filter((key) => keys.has(key))
    .sort();
};

export const isEffectExtractionResult = (value: unknown): value is EffectExtractionResult => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== RESULT_KEYS.length ||
    RESULT_KEYS.some((key) => !(key in record))
  )
    return false;
  return (
    validString(record.productCategory) &&
    validString(record.productName) &&
    validString(record.coreSpecification) &&
    validString(record.priceRange) &&
    validString(record.visualFeatures) &&
    validStringArray(record.coreSellingPoints, EFFECT_EXTRACTION_MAX_CORE_SELLING_POINTS) &&
    record.coreSellingPoints.length >= 1 &&
    validStringArray(
      record.secondarySellingPoints,
      EFFECT_EXTRACTION_MAX_SECONDARY_SELLING_POINTS,
    ) &&
    validStringArray(record.trustBackings, EFFECT_EXTRACTION_MAX_TRUST_BACKINGS) &&
    validString(record.targetAudience) &&
    validStringArray(record.corePainPoints, EFFECT_EXTRACTION_MAX_AUDIENCE_ITEMS) &&
    validStringArray(record.decisionDrivers, EFFECT_EXTRACTION_MAX_AUDIENCE_ITEMS) &&
    validString(record.marketingGoal) &&
    validStringArray(record.usageScenarios, EFFECT_EXTRACTION_MAX_SCENARIO_ITEMS) &&
    validStringArray(record.purchaseScenarios, EFFECT_EXTRACTION_MAX_SCENARIO_ITEMS) &&
    validStringArray(record.emotionalScenarios, EFFECT_EXTRACTION_MAX_SCENARIO_ITEMS) &&
    Number.isInteger(record.durationSeconds) &&
    Number(record.durationSeconds) >= 1 &&
    Number(record.durationSeconds) <= 3600 &&
    validString(record.aspectRatio, 50) &&
    record.aspectRatio.length > 0 &&
    validString(record.resolution, 50) &&
    record.resolution.length > 0 &&
    validString(record.deliveryChannels) &&
    validStringArray(record.disabledElements, 100) &&
    validString(record.visualStyleBaseline) &&
    true
  );
};

const safeWarningText = (value: unknown, maxLength: number): string | null => {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized ? normalized.slice(0, maxLength) : null;
};

export const parseWarnings = (value: unknown): EffectExtractionWarning[] => {
  if (!Array.isArray(value)) return [];
  const branches = new Set<string>(EFFECT_EXTRACTION_BRANCHES);
  return value.flatMap((item): EffectExtractionWarning[] => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    const code = safeWarningText(record.code, 120);
    const message = safeWarningText(record.message, 1000);
    if (!code || !message) return [];
    const branch =
      typeof record.branch === 'string' && branches.has(record.branch)
        ? (record.branch as EffectExtractionWarning['branch'])
        : null;
    return [
      {
        code,
        message,
        branch,
        sourceId: safeWarningText(record.sourceId, 255),
      },
    ];
  });
};

export const safeTokenEquals = (actual: string | undefined, expected: string): boolean => {
  if (!actual) return false;
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer)
  );
};
