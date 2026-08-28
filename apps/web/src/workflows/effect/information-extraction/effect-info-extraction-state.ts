import {
  EFFECT_EXTRACTION_MAX_EDITABLE_LIST_ITEMS,
  normalizeEffectImportResolution,
  type EffectExtractionProductState as EffectExtractionProductDto,
  type EffectExtractionProductStatus,
  type EffectExtractionResult,
} from '@ai-marketing/contracts';

/*
 * WorkflowNodeState can outlive a result-schema upgrade. Keep this adapter at
 * the local draft boundary so a historical scalar audience cannot replace the
 * already-adapted workspace result with an incomplete runtime object.
 */
const normalizedTargetAudiences = (value: EffectExtractionResult): string[] => {
  const candidates = Array.isArray(value.targetAudiences)
    ? value.targetAudiences
    : typeof value.targetAudience === 'string'
      ? value.targetAudience.split(/[\n,，、;；]+/u)
      : [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of candidates) {
    if (typeof item !== 'string') continue;
    const normalized = item.replace(/\s+/g, ' ').trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
    if (result.length >= EFFECT_EXTRACTION_MAX_EDITABLE_LIST_ITEMS) break;
  }
  return result;
};

export type { EffectExtractionResult } from '@ai-marketing/contracts';

export type EffectExtractionSaveState = 'CLEAN' | 'DIRTY' | 'SAVING' | 'SAVED' | 'SAVE_FAILED';

export type EffectExtractionProductState = EffectExtractionProductDto & {
  saveState: EffectExtractionSaveState;
  saveErrorMessage: string | null;
};

export const EFFECT_EXTRACTION_STATUS_META: Record<
  EffectExtractionProductStatus,
  { label: string; tone: 'danger' | 'neutral' | 'running' | 'success' | 'warning' }
> = {
  NOT_GENERATED: { label: '未生成', tone: 'neutral' },
  QUEUED: { label: '排队中', tone: 'running' },
  PROCESSING: { label: '生成中', tone: 'running' },
  COMPLETED: { label: '已完成', tone: 'success' },
  FAILED: { label: '失败', tone: 'danger' },
  STALE: { label: '待更新', tone: 'warning' },
};

export const cloneExtractionResult = (value: EffectExtractionResult): EffectExtractionResult => {
  const targetAudiences = normalizedTargetAudiences(value);
  return {
    ...value,
    resolution: normalizeEffectImportResolution(value.resolution) ?? '720p',
    coreSellingPoints: [...value.coreSellingPoints],
    secondarySellingPoints: [...value.secondarySellingPoints],
    trustBackings: [...value.trustBackings],
    targetAudience: targetAudiences.join('；'),
    targetAudiences,
    corePainPoints: [...value.corePainPoints],
    decisionDrivers: [...value.decisionDrivers],
    usageScenarios: [...value.usageScenarios],
    purchaseScenarios: [...value.purchaseScenarios],
    emotionalScenarios: [...value.emotionalScenarios],
    disabledElements: [...value.disabledElements],
  };
};

export const cloneExtractionProductState = (
  value: EffectExtractionProductState,
): EffectExtractionProductState => ({
  ...value,
  warnings: value.warnings.map((warning) => ({ ...warning })),
  result: value.result ? cloneExtractionResult(value.result) : null,
});

export const toExtractionProductState = (
  value: EffectExtractionProductDto,
): EffectExtractionProductState => ({
  ...value,
  warnings: value.warnings.map((warning) => ({ ...warning })),
  result: value.result ? cloneExtractionResult(value.result) : null,
  saveState: value.result ? 'SAVED' : 'CLEAN',
  saveErrorMessage: null,
});

export const isExtractionRunning = (state: EffectExtractionProductState | null): boolean =>
  state?.status === 'QUEUED' || state?.status === 'PROCESSING';

export const isExtractionReadyForNext = (state: EffectExtractionProductState | null): boolean =>
  state?.status === 'COMPLETED';
