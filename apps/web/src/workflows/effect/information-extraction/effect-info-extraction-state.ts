import type {
  EffectExtractionProductState as EffectExtractionProductDto,
  EffectExtractionProductStatus,
  EffectExtractionResult,
} from '@ai-marketing/contracts';
import { EFFECT_EXTRACTION_MAX_SELLING_POINTS } from '@ai-marketing/contracts';

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
  return {
    ...value,
    sellingPoints: value.sellingPoints.slice(0, EFFECT_EXTRACTION_MAX_SELLING_POINTS),
  };
};

export const cloneExtractionProductState = (
  value: EffectExtractionProductState,
): EffectExtractionProductState => ({
  ...value,
  imageRecognitionSummary: value.imageRecognitionSummary
    ? { ...value.imageRecognitionSummary }
    : null,
  warnings: value.warnings.map((warning) => ({ ...warning })),
  provenance: {
    fieldOrigins: { ...value.provenance.fieldOrigins },
    fieldSourceNames: Object.fromEntries(
      Object.entries(value.provenance.fieldSourceNames ?? {}).map(([field, names]) => [
        field,
        [...(names ?? [])],
      ]),
    ),
    itemOrigins: Object.fromEntries(
      Object.entries(value.provenance.itemOrigins).map(([field, items]) => [
        field,
        items?.map((item) => ({
          ...item,
          sourceNames: [...(item.sourceNames ?? [])],
          semanticNotices: item.semanticNotices?.map((notice) => ({
            ...notice,
            relatedValues: [...notice.relatedValues],
          })),
        })),
      ]),
    ),
  },
  result: value.result ? cloneExtractionResult(value.result) : null,
});

export const toExtractionProductState = (
  value: EffectExtractionProductDto,
): EffectExtractionProductState => ({
  ...value,
  imageRecognitionSummary: value.imageRecognitionSummary
    ? { ...value.imageRecognitionSummary }
    : null,
  warnings: value.warnings.map((warning) => ({ ...warning })),
  provenance: value.provenance
    ? {
        ...value.provenance,
        fieldSourceNames: value.provenance.fieldSourceNames ?? {},
        itemOrigins: Object.fromEntries(
          Object.entries(value.provenance.itemOrigins).map(([field, items]) => [
            field,
            items?.map((item) => ({
              ...item,
              sourceNames: item.sourceNames ?? [],
              semanticNotices: item.semanticNotices?.map((notice) => ({
                ...notice,
                relatedValues: [...notice.relatedValues],
              })),
            })),
          ]),
        ),
      }
    : { fieldOrigins: {}, fieldSourceNames: {}, itemOrigins: {} },
  result: value.result ? cloneExtractionResult(value.result) : null,
  saveState: value.result ? 'SAVED' : 'CLEAN',
  saveErrorMessage: null,
});

export const isExtractionRunning = (state: EffectExtractionProductState | null): boolean =>
  state?.status === 'QUEUED' || state?.status === 'PROCESSING';

export const isExtractionReadyForNext = (state: EffectExtractionProductState | null): boolean =>
  state?.status === 'COMPLETED';
