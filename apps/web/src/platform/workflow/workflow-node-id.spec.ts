import type { WorkflowNodeState } from '@ai-marketing/contracts';
import { describe, expect, it } from 'vitest';

import { latestWorkflowNodeStateMap, workflowNodeBaseId } from './workflow-node-id';

const state = (nodeId: string, savedAt: string, revision: number): WorkflowNodeState => ({
  id: `${nodeId}-${revision}`,
  projectId: 'project-a',
  workflowRunId: 'workflow-a',
  nodeId,
  schemaVersion: 4,
  revision,
  contentHash: 'a'.repeat(64),
  executionInputHash: 'b'.repeat(64),
  executionInputSchemaVersion: 4,
  state: {},
  savedAt,
  updatedAt: savedAt,
});

describe('workflow node id projection', () => {
  it('projects product-scoped node ids onto the visible workflow node', () => {
    expect(workflowNodeBaseId('PROMPT_GENERATION:product-a')).toBe('PROMPT_GENERATION');
    expect(workflowNodeBaseId('PROMPT_GENERATION')).toBe('PROMPT_GENERATION');
  });

  it('uses the latest product-scoped state for the visible workflow node', () => {
    const states = latestWorkflowNodeStateMap([
      state('PROMPT_GENERATION:product-a', '2026-08-26T01:00:00.000Z', 2),
      state('PROMPT_GENERATION:product-b', '2026-08-26T02:00:00.000Z', 5),
      state('INFORMATION_EXTRACTION', '2026-08-25T23:00:00.000Z', 3),
    ]);

    expect(states.get('PROMPT_GENERATION')?.revision).toBe(5);
    expect(states.get('INFORMATION_EXTRACTION')?.revision).toBe(3);
  });
});
