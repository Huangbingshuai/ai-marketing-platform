import type {
  EffectExtractionBranch,
  EffectExtractionBranchStatus,
  EffectExtractionResult,
  EffectExtractionWarning,
  EffectImportMode,
  EffectVideoConfig,
} from '@ai-marketing/contracts';

export const EFFECT_EXTRACTION_ARTIFACT_KINDS = ['DOCLING_MARKDOWN', 'COMMERCE_MARKDOWN'] as const;

export type EffectExtractionArtifactKind = (typeof EFFECT_EXTRACTION_ARTIFACT_KINDS)[number];

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
  schemaVersion: 3;
  projectId: string;
  draftId: string;
  mode: EffectImportMode;
  sourceRevision: number;
  /** Global video form captured from the import node. Optional for historical run snapshots. */
  globalVideoConfig?: EffectVideoConfig;
  product: {
    id: string;
    name: string;
    category: string;
    sku: string;
    commerceUrl: string | null;
    effectiveConfig: EffectVideoConfig;
  };
  materials: EffectExtractionSourceMaterial[];
  /** Field-level user corrections inherited by a later extraction run. */
  manualOverrides?: Partial<EffectExtractionResult>;
  dependencySnapshot: {
    sourcePackageRevision: number;
    effectiveVideoConfigRevision: number;
    executionInputHash: string;
  };
  dependencies?: Array<{
    sourceType: 'NODE_STATE' | 'WORKING_ARTIFACT' | 'EXECUTION_INPUT';
    sourceNodeId?: string;
    sourceArtifactId?: string;
    sourceKey: string;
    sourceRevision?: number | null;
    sourceHash?: string | null;
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
