import { describe, expect, it } from 'vitest';
import {
  peekWorkbench,
  rememberWorkbench,
  takeWorkbench,
} from './effect-template-mix-workbench-handoff';

describe('mix workbench handoff across the forked Run', () => {
  it('routes to the requested surviving template before the copied draft default, without consuming an aborted read', () => {
    rememberWorkbench({
      workflowRunId: 'surviving-run',
      templateId: 'surviving-template',
      variantId: '',
      view: 'CONFIG',
    });
    expect(peekWorkbench('surviving-run')?.templateId).toBe('surviving-template');
    expect(peekWorkbench('old-run')).toBeNull();
    expect(peekWorkbench('surviving-run')?.templateId).toBe('surviving-template');
    expect(takeWorkbench('surviving-run')?.view).toBe('CONFIG');
    expect(peekWorkbench('surviving-run')).toBeNull();
  });
  it('preserves the configuration view when selecting an existing template branch', () => {
    rememberWorkbench({
      workflowRunId: 'template2',
      templateId: 't2',
      variantId: 'v1',
      view: 'CONFIG',
    });
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
