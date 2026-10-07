import { describe, expect, it } from 'vitest';
import uiExports from '../../../../packages/ui/src/index.ts?raw';

const pages = import.meta.glob<string>('./**/*.vue', {
  eager: true,
  query: '?raw',
  import: 'default',
});

describe('workflow pages without the redundant draft status panel', () => {
  it.each(Object.entries(pages))('%s does not mount or import the removed panel', (_path, source) => {
    expect(source).not.toContain('WorkflowNodeDraftBar');
    expect(source).not.toContain('workflow-node-draft-bar');
  });

  it('keeps shared navigation and task progress exports', () => {
    const source = uiExports;
    expect(source).not.toContain('WorkflowNodeDraftBar');
    expect(source).toContain('WorkflowNodeFooter');
    expect(source).toContain('WorkflowRunProgress');
  });
});
