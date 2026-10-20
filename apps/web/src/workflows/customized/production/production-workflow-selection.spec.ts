import { describe, expect, it } from 'vitest';
import type { ProductionTask } from '@ai-marketing/contracts';
import {
  productionNodeTasks,
  productionPageProgressTask,
  productionWorkflowTask,
} from './production-workflow-selection';

it('reserves page-wide progress for bulk authoring and keeps clip jobs local', () => {
  const tasks = [
    { id: 'render', operation: 'RENDER', status: 'RUNNING' },
    { id: 'prompt', operation: 'PROMPT', status: 'RUNNING' },
    { id: 'image', operation: 'IMAGE', status: 'RUNNING' },
    { id: 'shots', operation: 'SHOTS', status: 'COMPLETED' },
  ] as ProductionTask[];
  expect(productionPageProgressTask(tasks, 'SHOTS')).toBeUndefined();
  expect(productionPageProgressTask(tasks, 'ASSETS')).toBeUndefined();
  tasks.push({ id: 'assets', operation: 'ASSETS', status: 'RUNNING' } as ProductionTask);
  expect(productionPageProgressTask(tasks, 'ASSETS')?.id).toBe('assets');
  tasks.push({ id: 'new-shots', operation: 'SHOTS', status: 'QUEUED' } as ProductionTask);
  expect(productionPageProgressTask(tasks, 'SHOTS')?.id).toBe('new-shots');
});

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
  it('never substitutes another shot or a generation task for the current prompt', () => {
    const records = [
      { id: 'shots', operation: 'SHOTS' },
      { id: 'p-b', operation: 'PROMPT', target: { kind: 'CLIP', id: 'b' } },
      { id: 'p-a', operation: 'PROMPT', target: { kind: 'CLIP', id: 'a' } },
    ] as ProductionTask[];
    expect(productionWorkflowTask(records, 'PROMPT', 'p-b', 'a')?.id).toBe('p-a');
    expect(productionWorkflowTask(records, 'PROMPT', undefined, 'missing')).toBeUndefined();
    expect(productionWorkflowTask(records, 'SHOTS')?.id).toBe('shots');
  });
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
