import { describe, expect, it } from 'vitest';
import type { ProductionTask } from '@ai-marketing/contracts';
import { productionWorkflowTask } from './production-workflow-selection';

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
