import type {
  EffectExtractionBranch,
  EffectExtractionBranchStatus,
  EffectExtractionResult,
  EffectExtractionWarning,
  EffectImportMode,
  EffectVideoConfig,
} from '@ai-marketing/contracts';

export type EffectExtractionSourceMaterial = {
  id: string;
  type: string;
  originalFileName: string;
  mimeType: string;
  sizeBytes: number;
  storageKey: string;
  updatedAt: string;
};

export type EffectExtractionInputSnapshot = {
  schemaVersion: 1;
  projectId: string;
  draftId: string;
  mode: EffectImportMode;
  sourceRevision: number;
  product: {
    id: string;
    name: string;
    category: string;
    sku: string;
    commerceUrl: string | null;
    effectiveConfig: EffectVideoConfig;
  };
  materials: EffectExtractionSourceMaterial[];
  dependencies?: Array<{
    sourceType: 'NODE_STATE' | 'WORKING_ARTIFACT';
    sourceNodeId?: string;
    sourceArtifactId?: string;
    sourceKey: string;
    sourceRevision: number;
  }>;
};

export type BranchOutputInput = {
  branch: EffectExtractionBranch;
  status: EffectExtractionBranchStatus;
  structuredOutput?: unknown;
  textStorageKey?: string | null;
  warnings: EffectExtractionWarning[];
  errorCode?: string | null;
  errorMessage?: string | null;
};

export type CompleteRunInput = {
  result: EffectExtractionResult;
  provenance: unknown;
  conflictReport: unknown;
  warnings: EffectExtractionWarning[];
};
