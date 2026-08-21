export const EFFECT_EXTRACTION_STATUSES = [
  'NOT_GENERATED',
  'PROCESSING',
  'COMPLETED',
  'FAILED',
  'STALE',
] as const;

export type EffectExtractionStatus = (typeof EFFECT_EXTRACTION_STATUSES)[number];

export type EffectExtractionSaveState = 'CLEAN' | 'DIRTY' | 'SAVING' | 'SAVED' | 'SAVE_FAILED';

export type EffectExtractionResult = {
  productCategory: string;
  productName: string;
  coreSpecification: string;
  priceRange: string;
  visualFeatures: string;
  targetAudience: string;
  marketingGoal: string;
  coreSellingPoints: string[];
  usageScenarios: string;
  deliveryChannels: string;
  brandTone: string;
  disabledElements: string[];
};

export type EffectExtractionProductState = {
  productId: string;
  status: EffectExtractionStatus;
  saveState: EffectExtractionSaveState;
  result: EffectExtractionResult | null;
  errorMessage: string | null;
  sourceFingerprint: string;
  attempt: number;
  savedAt: string | null;
  updatedAt: string;
};

export const EFFECT_EXTRACTION_STATUS_META: Record<
  EffectExtractionStatus,
  { label: string; tone: 'danger' | 'neutral' | 'running' | 'success' | 'warning' }
> = {
  NOT_GENERATED: { label: '未生成', tone: 'neutral' },
  PROCESSING: { label: '生成中', tone: 'running' },
  COMPLETED: { label: '已完成', tone: 'success' },
  FAILED: { label: '失败', tone: 'danger' },
  STALE: { label: '待更新', tone: 'warning' },
};

export const cloneExtractionResult = (value: EffectExtractionResult): EffectExtractionResult => ({
  ...value,
  coreSellingPoints: [...value.coreSellingPoints],
  disabledElements: [...value.disabledElements],
});

export const cloneExtractionProductState = (
  value: EffectExtractionProductState,
): EffectExtractionProductState => ({
  ...value,
  result: value.result ? cloneExtractionResult(value.result) : null,
});

export const isExtractionReadyForNext = (state: EffectExtractionProductState | null): boolean =>
  state?.status === 'COMPLETED';
