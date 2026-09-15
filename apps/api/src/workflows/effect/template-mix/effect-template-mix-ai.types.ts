import type {
  EffectTemplateMixAiClassification,
  EffectTemplateMixAiSelection,
  EffectTemplateMixAiTrim,
  EffectTemplateMixRole,
} from '@ai-marketing/contracts';

export type EffectTemplateMixAiSnapshot = {
  schemaVersion: 1;
  template: {
    id: string;
    name: string;
    editVersion: number;
    slots: Array<{ id: string; role: EffectTemplateMixRole; label: string; duration: number }>;
  };
  draftRevision: number;
  targetVariantId: string | null;
  maxOutputVariants: number;
  lockedBindings: Array<{
    slotId: string;
    materialId: string;
    artifactRevision: number;
    offset: number;
  }>;
  reuseCounts: Record<string, number>;
  promptArtifacts: Array<{
    id: string;
    artifactKey: string;
    revision: number;
    contentHash: string;
  }>;
  materials: Array<{
    id: string;
    code: string;
    name: string;
    duration: number;
    promptId: string;
    prompt: string;
    artifactId: string;
    artifactKey: string;
    artifactRevision: number;
    contentHash: string;
    fileObjectId: string;
  }>;
};

export type EffectTemplateMixClassificationInput = {
  projectId: string;
  classifications: EffectTemplateMixAiClassification[];
};
export type EffectTemplateMixCompleteInput = {
  projectId: string;
  trims: EffectTemplateMixAiTrim[];
};
export type EffectTemplateMixSelectionData = { selections: EffectTemplateMixAiSelection[] };
