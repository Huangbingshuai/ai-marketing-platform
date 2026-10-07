import { describe, expect, it } from 'vitest';
import { rememberWorkbench, takeWorkbench } from './effect-template-mix-workbench-handoff';

describe('mix workbench handoff across the forked Run', () => {
  it('preserves the configuration view when selecting an existing template branch', () => {
    rememberWorkbench({ workflowRunId: 'template2', templateId: 't2', variantId: 'v1', view: 'CONFIG' });
    expect(takeWorkbench('template2')?.view).toBe('CONFIG');
  });
  it('reopens the workbench on the Run the fork announced', () => {
    rememberWorkbench({ workflowRunId: 'child', templateId: 'template-a', variantId: 'variant-1' });
    expect(takeWorkbench('child')).toEqual({
      workflowRunId: 'child',
      templateId: 'template-a',
      variantId: 'variant-1',
    });
  });

  it('hands over only once so a stale note cannot reopen the workbench later', () => {
    rememberWorkbench({ workflowRunId: 'child', templateId: 'template-a', variantId: 'variant-1' });
    expect(takeWorkbench('child')).not.toBeNull();
    expect(takeWorkbench('child')).toBeNull();
  });

  it('discards a note written for another Run instead of applying it to the current one', () => {
    rememberWorkbench({ workflowRunId: 'child', templateId: 'template-a', variantId: 'variant-1' });
    expect(takeWorkbench('other')).toBeNull();
    expect(takeWorkbench('child')).toBeNull();
  });
});
