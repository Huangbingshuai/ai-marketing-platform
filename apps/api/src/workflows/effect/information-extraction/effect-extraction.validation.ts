import { createHash, timingSafeEqual } from 'node:crypto';

import type { EffectExtractionResult, EffectExtractionWarning } from '@ai-marketing/contracts';
import { EFFECT_EXTRACTION_BRANCHES } from '@ai-marketing/contracts';

const RESULT_KEYS = [
  'productCategory',
  'productName',
  'coreSpecification',
  'priceRange',
  'visualFeatures',
  'targetAudience',
  'marketingGoal',
  'coreSellingPoints',
  'usageScenarios',
  'deliveryChannels',
  'brandTone',
  'disabledElements',
] as const;

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
  snapshot: { sourceRevision: number } & Record<string, unknown>,
): string =>
  canonicalHash(
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
    validString(record.targetAudience) &&
    validString(record.marketingGoal) &&
    validStringArray(record.coreSellingPoints, 20) &&
    validString(record.usageScenarios) &&
    validString(record.deliveryChannels) &&
    validString(record.brandTone) &&
    validStringArray(record.disabledElements, 100)
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
