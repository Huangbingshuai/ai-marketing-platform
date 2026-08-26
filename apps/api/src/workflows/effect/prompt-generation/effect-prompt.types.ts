import type {
  EffectPromptBatchResult,
  EffectPromptBatchSettings,
  EffectPromptItem,
  EffectPromptManualOverrides,
  EffectPromptOperation,
  EffectPromptSharedPrompt,
} from '@ai-marketing/contracts';

export type EffectPromptInputSnapshot = {
  schemaVersion: 5;
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
  /** Carries user-authored batch-level content into regeneration without copying it to items. */
  sharedPrompt?: EffectPromptSharedPrompt | null;
  /** Present for ITEM_REGENERATE so the API can preserve stable identity and order. */
  targetItem?: EffectPromptItem | undefined;
  targetItemIndex?: number | undefined;
  /** Effective dimensions used by ITEM_REGENERATE, including the old-client fallback. */
  replacementDimensions?: EffectPromptItem['dimensions'] | undefined;
  /** Trimmed, low-priority user direction. Empty input is persisted as null. */
  regenerationInstruction?: string | null | undefined;
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
