import { describe, expect, it } from 'vitest';
import {
  emptyCustomizedImportDraft,
  type WorkflowRun,
  type WorkflowNodeState,
  type WorkingArtifact,
} from '@ai-marketing/contracts';
import { restoreCustomizedImportWorkspace } from './customized-import-state';

describe('customized source branch snapshot', () => {
  const run = {
    id: 'script',
    projectId: 'p',
    workflow: 'CUSTOMIZED',
    workflowSpace: 'CUSTOMIZED_PROJECT',
    editNodeId: null,
  } as WorkflowRun;
  const confirmed = {
    ...emptyCustomizedImportDraft(),
    materials: [
      { assetId: 'doc', assetVersion: 2, category: 'BRIEF' as const },
      {
        assetId: 'logo',
        assetVersion: 1,
        category: 'VISUAL_REFERENCE' as const,
        usage: 'LOGO' as const,
      },
    ],
  };
  const artifact = {
    id: 'source',
    projectId: 'p',
    workflowRunId: 'script',
    nodeId: 'SOURCE_IMPORT',
    artifactKey: 'customized-source-package',
    availability: 'AVAILABLE',
    payload: confirmed,
  } as WorkingArtifact;
  const state = {
    projectId: 'p',
    workflowRunId: 'script',
    nodeId: 'SOURCE_IMPORT',
    state: emptyCustomizedImportDraft(),
  } as WorkflowNodeState;
  it('restores fixed document and brand image versions without a node draft, including after refresh', () => {
    expect(restoreCustomizedImportWorkspace('p', run, [], [artifact])).toEqual(confirmed);
    expect(restoreCustomizedImportWorkspace('p', run, [], [structuredClone(artifact)])).toEqual(
      confirmed,
    );
  });
  it('prefers confirmed content in read-only mode and preserves the actual local edit', () => {
    expect(restoreCustomizedImportWorkspace('p', run, [state], [artifact])).toEqual(confirmed);
    expect(
      restoreCustomizedImportWorkspace(
        'p',
        { ...run, editNodeId: 'SOURCE_IMPORT' },
        [state],
        [artifact],
      ),
    ).toEqual(state.state);
    expect(restoreCustomizedImportWorkspace('p', run, [state], [])).toEqual(state.state);
  });
  it('does not borrow from another project, workflow or sibling branch', () => {
    for (const foreign of [
      { ...artifact, projectId: 'other' },
      { ...artifact, workflowRunId: 'sibling' },
      { ...artifact, availability: 'SOURCE_REMOVED' as const },
    ])
      expect(restoreCustomizedImportWorkspace('p', run, [], [foreign]).materials).toEqual([]);
    expect(
      restoreCustomizedImportWorkspace('p', { ...run, workflow: 'EFFECT' }, [], [artifact])
        .materials,
    ).toEqual([]);
  });
});
