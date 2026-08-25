import type {
  EffectPromptBatchResult,
  EffectPromptBatchSettings,
  EffectPromptItem,
  EffectPromptManualOverrides,
  EffectPromptOperation,
} from '@ai-marketing/contracts';

export type EffectPromptInputSnapshot = {
  schemaVersion: 2;
  projectId: string;
  workflowRunId: string;
  productId: string;
  operation: EffectPromptOperation;
  targetItemId: string | null;
  settings: EffectPromptBatchSettings;
  insightArtifact: {
    id: string;
    revision: number;
    contentHash: string;
    result: unknown;
  };
  retainedManualItems: EffectPromptItem[];
  /** Present for ITEM_REGENERATE so the API can preserve stable identity and order. */
  targetItem?: EffectPromptItem | undefined;
  targetItemIndex?: number | undefined;
  baseResultRevision: number | null;
};

export type EffectPromptStageInput = {
  status: 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'PARTIAL' | 'SKIPPED' | 'FAILED';
  summary: string;
  warnings: string[];
  metadata: unknown;
};

export type EffectPromptShardInput = {
  status: EffectPromptStageInput['status'];
  combinationPlan: unknown;
  items: unknown;
  warnings: string[];
  errorCode?: string | null;
  errorMessage?: string | null;
};

export type EffectPromptCompleteInput = {
  result: EffectPromptBatchResult;
};

export const emptyManualOverrides = (): EffectPromptManualOverrides => ({
  edited: {},
  added: [],
  deleted: [],
});
