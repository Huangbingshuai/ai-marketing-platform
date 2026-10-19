import { describe, expect, it } from 'vitest';
import type { ProductionTask } from '@ai-marketing/contracts';
import { productionNodeTasks, productionWorkflowTask } from './production-workflow-selection';

it('isolates asset/image tasks from storyboard/prompt tasks without changing their order', () => {
  const tasks = [
    { id: 'prompt', operation: 'PROMPT', status: 'RUNNING' },
    { id: 'image', operation: 'IMAGE', status: 'QUEUED' },
    { id: 'shots', operation: 'SHOTS', status: 'RUNNING' },
    { id: 'assets', operation: 'ASSETS', status: 'COMPLETED' },
  ] as ProductionTask[];
  expect(productionNodeTasks(tasks, 'ASSETS').map((t) => t.id)).toEqual(['image', 'assets']);
  expect(productionNodeTasks(tasks, 'SHOTS').map((t) => t.id)).toEqual(['prompt', 'shots']);
});

describe('operation-scoped production workflow details', () => {
  const tasks = [
    { id: 'new-image', operation: 'IMAGE' },
    { id: 'new-assets', operation: 'ASSETS' },
    { id: 'old-image', operation: 'IMAGE' },
  ] as ProductionTask[];
  it('keeps an image completion from replacing the asset extraction panel', () => {
    expect(productionWorkflowTask(tasks, 'ASSETS', 'new-image')?.id).toBe('new-assets');
    expect(productionWorkflowTask(tasks, 'IMAGE', 'new-assets')?.id).toBe('new-image');
    expect(productionWorkflowTask(tasks, 'IMAGE', 'old-image')?.id).toBe('old-image');
    expect(productionWorkflowTask(tasks, 'SHOTS')).toBeUndefined();
  });
});
