import { expect, it } from 'vitest';
import { storyboardDescendants } from './storyboard-deletion';

it('removes hidden edits and every descendant, preserving siblings and ancestors', () => {
  const runs = [
    { id: 'root', parentWorkflowRunId: null },
    { id: 'script', parentWorkflowRunId: 'root' },
    { id: 'sibling', parentWorkflowRunId: 'root' },
    { id: 'edit', parentWorkflowRunId: 'script' },
    { id: 'video', parentWorkflowRunId: 'edit' },
  ];
  expect(storyboardDescendants(runs.reverse(), 'script').sort()).toEqual([
    'edit',
    'script',
    'video',
  ]);
  expect(storyboardDescendants(runs, null)).toEqual([]);
});

it('terminates on a malformed cycle without leaving partial descendants', () => {
  expect(
    storyboardDescendants(
      [
        { id: 'a', parentWorkflowRunId: 'b' },
        { id: 'b', parentWorkflowRunId: 'a' },
      ],
      'a',
    ),
  ).toEqual(['a', 'b']);
});
