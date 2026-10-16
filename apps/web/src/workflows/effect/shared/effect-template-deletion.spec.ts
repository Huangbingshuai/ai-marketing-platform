import { describe, expect, it } from 'vitest';
import type {
  DeleteEffectTemplateMixData,
  EffectTemplateMixWorkspaceData,
  EffectTemplateMixTemplateEntry,
} from '@ai-marketing/contracts';
import type { MixTemplateCatalog } from '../template-mix/effect-template-mix-template-catalog';
import {
  readTemplateDeleted,
  templateDeletionDestination,
  withoutDeletedMixCatalog,
  withoutDeletedMixTemplates,
} from './effect-template-deletion';

const workspace = (activeTemplateId = 'a') =>
  ({
    draftRevision: 4,
    draft: { schemaVersion: 1, activeTemplateId, templates: [{ id: 'a' }, { id: 'b' }] },
    aiRuns: [{ templateId: 'a' }, { templateId: 'b' }],
  }) as unknown as EffectTemplateMixWorkspaceData;
const directory = (): MixTemplateCatalog => ({
  entries: workspace().draft.templates as EffectTemplateMixTemplateEntry[],
  workflowRunIds: { a: 'run-a', b: 'run-b' },
  pendingAddedMaterialIds: { a: ['ma'], b: ['mb'] },
  workspaces: { 'run-a': workspace(), 'run-b': workspace('b') },
});
const receipt: DeleteEffectTemplateMixData = {
  templateId: 'a',
  workflowRunId: 'render',
  status: 'QUEUED',
  draftRevision: 5,
  removedWorkflowRunIds: ['run-a', 'output-a'],
};

describe('accepted template deletion projection', () => {
  it('removes copied entries/tasks by ID without dropping another Run workspace or mutating inputs', () => {
    const source = directory();
    const result = withoutDeletedMixCatalog(source, new Set(['a']));
    expect(result.entries.map((e) => e.id)).toEqual(['b']);
    expect(result.workflowRunIds).toEqual({ b: 'run-b' });
    expect(result.pendingAddedMaterialIds).toEqual({ b: ['mb'] });
    expect(Object.keys(result.workspaces)).toEqual(['run-a', 'run-b']);
    expect(result.workspaces['run-b']?.draft.templates.map((e) => e.id)).toEqual(['b']);
    expect(result.workspaces['run-a']?.aiRuns?.map((e) => e.templateId)).toEqual(['b']);
    expect(source.entries).toHaveLength(2);
    expect(source.workspaces['run-b']?.draft.templates).toHaveLength(2);
    expect(result.workspaces['run-b']?.draftRevision).toBe(4);
  });
  it('keeps non-deleted selection, including an unrelated historical branch', () => {
    const result = withoutDeletedMixCatalog(directory(), new Set(['a']));
    expect(templateDeletionDestination(result, 'b', 'history-b', receipt)).toEqual({
      templateId: 'b',
      workflowRunId: 'history-b',
      selectionRemoved: false,
    });
  });
  it('routes a deleted selection to the surviving template own current Run, not an inherited copy', () => {
    const result = withoutDeletedMixCatalog(directory(), new Set(['a']));
    expect(templateDeletionDestination(result, 'a', 'output-a', receipt)).toEqual({
      templateId: 'b',
      workflowRunId: 'run-b',
      selectionRemoved: true,
    });
  });
  it('routes away from a retired Run even when selection already changed', () => {
    const result = withoutDeletedMixCatalog(directory(), new Set(['a']));
    expect(templateDeletionDestination(result, 'b', 'output-a', receipt).workflowRunId).toBe(
      'run-b',
    );
  });
  it('supports deleting the last template and falls back to its retained upstream', () => {
    const result = withoutDeletedMixCatalog(directory(), new Set(['a', 'b']));
    expect(templateDeletionDestination(result, 'a', 'run-a', receipt)).toEqual({
      templateId: '',
      workflowRunId: 'render',
      selectionRemoved: true,
    });
    expect(result.workspaces['run-a']?.draft.activeTemplateId).toBe('');
  });
  it('prunes a late stale directory with all accepted receipts, without restoring deleted siblings', () => {
    const deleted = new Set(['a']);
    withoutDeletedMixCatalog(directory(), deleted);
    deleted.add('b');
    const late = withoutDeletedMixCatalog(directory(), deleted);
    expect(late.entries).toEqual([]);
    expect(late.workspaces['run-b']?.draft.templates).toEqual([]);
  });
  it('preserves the current editor selection when a different template is removed', () => {
    expect(withoutDeletedMixTemplates(workspace('b').draft, new Set(['a'])).activeTemplateId).toBe(
      'b',
    );
  });
  it('supports legacy receipts without adopting an invented draft revision or Run removal', () => {
    const legacy = { templateId: 'a', workflowRunId: 'render', status: 'QUEUED' } as const;
    const event = {
      ...legacy,
      kind: 'TEMPLATE_DELETED',
      projectId: 'p',
      sourceWorkflowRunId: 'run-a',
    };
    expect(readTemplateDeleted(event)).toEqual(event);
    expect(readTemplateDeleted(event)?.draftRevision).toBeUndefined();
    expect(
      templateDeletionDestination(
        withoutDeletedMixCatalog(directory(), new Set(['a'])),
        'a',
        'run-a',
        legacy,
      ).workflowRunId,
    ).toBe('run-b');
  });
  it('does not treat ordinary saves or malformed events as deletion', () => {
    expect(readTemplateDeleted({ projectId: 'p', workflowRunId: 'r' })).toBeNull();
    expect(readTemplateDeleted(null)).toBeNull();
    expect(
      readTemplateDeleted({
        kind: 'TEMPLATE_DELETED',
        projectId: 'p',
        templateId: 'a',
        workflowRunId: 'r',
        sourceWorkflowRunId: 'old',
        status: 'FAILED',
      }),
    ).toBeNull();
    expect(
      readTemplateDeleted({
        kind: 'TEMPLATE_DELETED',
        projectId: 'p',
        templateId: 'a',
        workflowRunId: 'r',
        sourceWorkflowRunId: 'old',
        status: 'QUEUED',
        removedWorkflowRunIds: [1],
      }),
    ).toBeNull();
  });
});
