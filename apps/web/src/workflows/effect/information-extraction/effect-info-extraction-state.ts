import type {
  EffectExtractionProductState as EffectExtractionProductDto,
  EffectExtractionProductStatus,
  EffectExtractionResult,
} from '@ai-marketing/contracts';

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

export const cloneExtractionResult = (value: EffectExtractionResult): EffectExtractionResult => ({
  ...value,
  coreSellingPoints: [...value.coreSellingPoints],
  secondarySellingPoints: [...value.secondarySellingPoints],
  trustBackings: [...value.trustBackings],
  corePainPoints: [...value.corePainPoints],
  decisionDrivers: [...value.decisionDrivers],
  usageScenarios: [...value.usageScenarios],
  purchaseScenarios: [...value.purchaseScenarios],
  emotionalScenarios: [...value.emotionalScenarios],
  disabledElements: [...value.disabledElements],
});

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
