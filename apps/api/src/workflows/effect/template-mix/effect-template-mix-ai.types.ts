import type {
  EffectTemplateMixAiClassification,
  EffectTemplateMixAiSelection,
  EffectTemplateMixAiTrim,
} from '@ai-marketing/contracts';
export type { EffectTemplateMixAiSnapshot } from '@ai-marketing/contracts';

export type EffectTemplateMixClassificationInput = {
  projectId: string;
  classifications: EffectTemplateMixAiClassification[];
};
export type EffectTemplateMixCompleteInput = {
  projectId: string;
  trims: EffectTemplateMixAiTrim[];
};
export type EffectTemplateMixSelectionData = { selections: EffectTemplateMixAiSelection[] };
