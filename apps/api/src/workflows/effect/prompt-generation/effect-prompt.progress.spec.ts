import { describe, expect, it } from 'vitest';

import { promptShardProgress, promptStageProgress } from './effect-prompt.progress';

describe('Prompt batch progress', () => {
  it('keeps adjacent stages ordered even when creative and evaluation calls overlap', () => {
    expect(promptStageProgress('COHERENT_CREATIVE_GENERATION', 'SUCCEEDED', 'BATCH_GENERATE')).toBe(
      59,
    );
    expect(
      promptStageProgress('CREATIVE_EVALUATION_CLASSIFICATION', 'RUNNING', 'BATCH_GENERATE'),
    ).toBe(60);
    expect(promptStageProgress('EXACT_SELECTION_AND_SUPPLEMENT', 'PARTIAL', 'BATCH_GENERATE')).toBe(
      72,
    );
  });

  it('shows persisted shard completions while reserving the stage boundary for final work', () => {
    expect(promptShardProgress('CREATIVE', 0, 4, 30)).toMatchObject({
      currentNode: 'COHERENT_CREATIVE_GENERATION',
      progress: 50,
    });
    expect(promptShardProgress('CLASSIFICATION', 0, 4, 30)).toMatchObject({
      currentNode: 'CREATIVE_EVALUATION_CLASSIFICATION',
      progress: 61,
    });
    expect(promptShardProgress('CLASSIFICATION', 0, 30, 30)?.progress).toBe(70);
    expect(promptShardProgress('CREATIVE', 1, 6, 6)?.progress).toBe(77);
    expect(promptShardProgress('CLASSIFICATION', 1, 6, 6)?.progress).toBe(82);
    expect(promptShardProgress('CLASSIFICATION', 0, 0, 30)).toBeNull();
  });
});
