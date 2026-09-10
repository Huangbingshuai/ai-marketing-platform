import { createHash, timingSafeEqual } from 'node:crypto';

import type { EffectExtractionResult, EffectExtractionWarning } from '@ai-marketing/contracts';
import {
  EFFECT_EXTRACTION_BRANCHES,
  EFFECT_EXTRACTION_MAX_SELLING_POINTS,
} from '@ai-marketing/contracts';

const RESULT_KEYS = [
  'productCategory',
  'productName',
  'coreSpecification',
  'priceRange',
  'visualFeatures',
  'sellingPoints',
] as const;

const EDITABLE_RESULT_KEYS = RESULT_KEYS;
const TARGET_AUDIENCE_SEPARATOR = /[\n,，、;；]+/u;
const LEGACY_SELLING_POINT_FIELDS = [
  'coreSellingPoints',
  'secondarySellingPoints',
  'trustBackings',
  'targetAudiences',
  'corePainPoints',
  'decisionDrivers',
  'usageScenarios',
  'purchaseScenarios',
  'emotionalScenarios',
] as const;

export type EffectExtractionManualOverrides = Partial<EffectExtractionResult>;

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
  snapshot:
    | ({ sourceRevision: number; dependencySnapshot?: unknown } & Record<string, unknown>)
    | null
    | undefined,
): string => {
  if (!snapshot) return canonicalHash({});
  const dependencies =
    snapshot.dependencySnapshot &&
    typeof snapshot.dependencySnapshot === 'object' &&
    !Array.isArray(snapshot.dependencySnapshot)
      ? (snapshot.dependencySnapshot as Record<string, unknown>)
      : null;
  if (dependencies)
    return canonicalHash({
      sourcePackageRevision: dependencies.sourcePackageRevision,
      executionInputHash: dependencies.executionInputHash,
    });
  return canonicalHash(
    Object.fromEntries(
      Object.entries(snapshot).filter(
        ([key]) => !['sourceRevision', 'globalVideoConfig'].includes(key),
      ),
    ),
  );
};

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
    mime === 'text/markdown' ||
    mime === 'text/plain' ||
    name.endsWith('.pdf') ||
    name.endsWith('.docx') ||
    name.endsWith('.md') ||
    name.endsWith('.txt')
  );
};

const validString = (value: unknown, max = 5000): value is string =>
  typeof value === 'string' && value.length <= max;

const validStringArray = (value: unknown, maxItems: number): value is string[] =>
  Array.isArray(value) &&
  value.length <= maxItems &&
  value.every((item) => validString(item, 1000) && item.length >= 1);

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
      const key = normalized;
      if (!normalized || seen.has(key)) return [];
      seen.add(key);
      return [normalized];
    })
    .slice(0, maxItems);
};

const text = (record: Record<string, unknown>, key: string): string =>
  typeof record[key] === 'string' ? record[key] : '';

const legacySellingPoints = (record: Record<string, unknown>): string[] => {
  const values = LEGACY_SELLING_POINT_FIELDS.flatMap((field) =>
    compactStrings(record[field], EFFECT_EXTRACTION_MAX_SELLING_POINTS),
  );
  if (!Array.isArray(record.targetAudiences) && typeof record.targetAudience === 'string') {
    values.push(...record.targetAudience.split(TARGET_AUDIENCE_SEPARATOR));
  }
  return compactStrings(values, EFFECT_EXTRACTION_MAX_SELLING_POINTS);
};

/**
 * The sole read boundary for current and historical information cards. It
 * folds historical marketing fields into the current unified selling-point
 * list without exposing a second public result type.
 */
export const normalizeEffectExtractionResult = (value: unknown): EffectExtractionResult => {
  const record =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return {
    productCategory: text(record, 'productCategory'),
    productName: text(record, 'productName'),
    coreSpecification: text(record, 'coreSpecification'),
    priceRange: text(record, 'priceRange'),
    visualFeatures: text(record, 'visualFeatures'),
    sellingPoints: Array.isArray(record.sellingPoints)
      ? compactStrings(record.sellingPoints, EFFECT_EXTRACTION_MAX_SELLING_POINTS)
      : legacySellingPoints(record),
  };
};

export const manualOverridesForResult = (
  generated: EffectExtractionResult,
  draft: EffectExtractionResult,
): EffectExtractionManualOverrides =>
  Object.fromEntries(
    EDITABLE_RESULT_KEYS.flatMap((key) =>
      canonicalHash(generated[key]) === canonicalHash(draft[key]) ? [] : [[key, draft[key]]],
    ),
  ) as EffectExtractionManualOverrides;

export const applyEffectExtractionManualOverrides = (
  generated: EffectExtractionResult,
  overrides: unknown,
): EffectExtractionResult => {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) return generated;
  const record = overrides as Record<string, unknown>;
  const hasLegacySellingPointOverride = LEGACY_SELLING_POINT_FIELDS.some((key) => key in record);
  const merged = Object.fromEntries(
    EDITABLE_RESULT_KEYS.map((key) => {
      if (key === 'sellingPoints' && !('sellingPoints' in record) && hasLegacySellingPointOverride)
        return [key, legacySellingPoints(record)];
      return [key, key in record ? record[key] : generated[key]];
    }),
  );
  return normalizeEffectExtractionResult(merged);
};

export const manualOverrideFieldNames = (value: unknown): string[] => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const keys = new Set<string>(EDITABLE_RESULT_KEYS);
  return Array.from(
    new Set(
      Object.keys(value as Record<string, unknown>).flatMap((key) =>
        LEGACY_SELLING_POINT_FIELDS.includes(key as (typeof LEGACY_SELLING_POINT_FIELDS)[number]) ||
        key === 'targetAudience'
          ? ['sellingPoints']
          : keys.has(key)
            ? [key]
            : [],
      ),
    ),
  ).sort();
};

const hasExactEffectExtractionResultKeys = (value: unknown): value is Record<string, unknown> =>
  Boolean(
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === RESULT_KEYS.length &&
    RESULT_KEYS.every((key) => key in value),
  );

export const isEffectExtractionResult = (value: unknown): value is EffectExtractionResult => {
  if (!hasExactEffectExtractionResultKeys(value)) return false;
  const record = value;
  return (
    validString(record.productCategory, 500) &&
    validString(record.productName, 500) &&
    validString(record.coreSpecification, 2000) &&
    validString(record.priceRange, 1000) &&
    validString(record.visualFeatures, 4000) &&
    validStringArray(record.sellingPoints, EFFECT_EXTRACTION_MAX_SELLING_POINTS) &&
    record.sellingPoints.length >= 1 &&
    new Set(record.sellingPoints).size === record.sellingPoints.length
  );
};

export const normalizeEditableEffectExtractionResult = (value: unknown): unknown => {
  if (!hasExactEffectExtractionResultKeys(value)) return normalizeEffectExtractionResult(value);
  if (!isEffectExtractionResult(value)) return value;
  return {
    ...value,
    sellingPoints: [...value.sellingPoints],
  };
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
