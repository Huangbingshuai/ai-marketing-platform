import { describe, expect, it } from 'vitest';
import { effectTemplateBranchTips, type EffectWorkflowBranch } from './workflow-working';

const branch = (
  id: string,
  parent: string | null,
  node: string | null,
  template: string | null,
  time = id,
): EffectWorkflowBranch =>
  ({
    workflowRunId: id,
    parentWorkflowRunId: parent,
    forkNodeId: node,
    forkTemplateId: template,
    createdAt: time,
    templates: [{ templateId: 'a' }, { templateId: 'b' }],
  }) as EffectWorkflowBranch;

describe('template current branch tips', () => {
  it('keeps each template user-selected path across context changes and newer confirmations', () => {
    const root = branch('root', null, null, null);
    const a1 = branch('a1', 'root', 'TEMPLATE_MIX', 'a', '1');
    const a2 = branch('a2', 'a1', 'TEMPLATE_MIX', 'a', '2');
    const b1 = branch('b1', 'root', 'TEMPLATE_MIX', 'b', '3');
    const b2 = branch('b2', 'b1', 'TEMPLATE_MIX', 'b', '4');
    a1.templates[0]!.currentSelectedAt = '2026-10-07T01:00:00.000Z';
    a2.templates[0]!.currentConfirmedAt = '2026-10-08T01:00:00.000Z';
    b1.templates[1]!.currentSelectedAt = '2026-10-06T01:00:00.000Z';
    b2.templates[1]!.currentSelectedAt = '2026-10-07T01:00:00.000Z';
    for (const context of ['root', 'a1', 'a2', 'b1', 'b2']) {
      const tips = effectTemplateBranchTips([root, a1, a2, b1, b2], context, { current: true });
      expect(tips.get('a')?.workflowRunId).toBe('a1');
      expect(tips.get('b')?.workflowRunId).toBe('b2');
    }
    const foreign = {
      ...branch('foreign', 'root', 'SEGMENT_RENDER', 'a', '5'),
      templates: [{ ...a2.templates[0]!, currentSelectedAt: '2026-10-09T01:00:00.000Z' }],
    };
    expect(
      effectTemplateBranchTips([root, a1, a2, foreign], 'root', { current: true }).get('a')
        ?.workflowRunId,
    ).toBe('a1');
    expect(
      effectTemplateBranchTips([root, a1, a2, foreign], 'foreign', { current: true }).get('a')
        ?.workflowRunId,
    ).toBe('foreign');
  });
  it('uses an in-place confirmation instead of reviving a later-created obsolete fork', () => {
    const root = branch('root', null, null, null, '2026-10-01');
    const updated = branch('updated', 'root', 'TEMPLATE_MIX', 'a', '2026-10-02');
    updated.templates[0]!.currentConfirmedAt = '2026-10-07';
    const obsolete = branch('obsolete', 'updated', 'TEMPLATE_MIX', 'a', '2026-10-03');
    obsolete.templates[0]!.currentConfirmedAt = '2026-10-04';
    const rows = [root, updated, obsolete];
    for (const context of ['root', 'updated', 'obsolete'])
      expect(
        effectTemplateBranchTips(rows, context, { current: true }).get('a')?.workflowRunId,
      ).toBe('updated');
    expect(
      effectTemplateBranchTips(rows, 'obsolete', { current: true, selectedTemplateId: 'a' }).get(
        'a',
      )?.workflowRunId,
    ).toBe('obsolete');
    expect(effectTemplateBranchTips(rows, 'obsolete').get('a')?.workflowRunId).toBe('obsolete');
    expect(updated.createdAt).toBe('2026-10-02');
  });
  it('does not adopt a later copied template while choosing another template current path', () => {
    const root = branch('root', null, null, null, '2026-10-01');
    const a = branch('a', 'root', 'TEMPLATE_MIX', 'a', '2026-10-02');
    a.templates[0]!.currentConfirmedAt = '2026-10-07';
    const b = branch('b', 'a', 'TEMPLATE_MIX', 'b', '2026-10-08');
    b.templates[1]!.currentConfirmedAt = '2026-10-08';
    const tips = effectTemplateBranchTips([root, a, b], 'b', { current: true });
    expect(tips.get('a')?.workflowRunId).toBe('a');
    expect(tips.get('b')?.workflowRunId).toBe('b');
  });
  it('uses each template path instead of assigning every template to the global pointer', () => {
    const root = branch('root', null, null, null);
    const a = branch('a1', 'root', 'TEMPLATE_MIX', 'a', '1');
    const b = branch('b1', 'a1', 'TEMPLATE_MIX', 'b', '2');
    const tips = effectTemplateBranchTips([root, a, b], 'b1');
    expect(tips.get('a')?.workflowRunId).toBe('a1');
    expect(tips.get('b')?.workflowRunId).toBe('b1');
  });
  it('follows a successful output child for only its template', () => {
    const root = branch('root', null, null, null);
    const a = branch('a1', 'root', 'TEMPLATE_MIX', 'a', '1');
    const output = branch('out', 'a1', 'FINAL_OUTPUT', 'a', '2');
    expect(effectTemplateBranchTips([root, a, output], 'root').get('a')?.workflowRunId).toBe('out');
  });
  it('honors an explicitly selected historical template path', () => {
    const root = branch('root', null, null, null);
    const a = branch('a1', 'root', 'TEMPLATE_MIX', 'a', '1');
    const output = branch('out', 'a1', 'FINAL_OUTPUT', 'a', '2');
    expect(effectTemplateBranchTips([root, a, output], 'a1').get('a')?.workflowRunId).toBe('a1');
  });
  it.each(['MANUAL_COPY', 'SEGMENT_RENDER', 'PROMPT_GENERATION'])(
    'does not borrow template tips across a %s fork',
    (node) => {
      const root = branch('root', null, null, null);
      const old = branch('old', 'root', 'TEMPLATE_MIX', 'a', '1');
      const isolated = branch('copy', 'root', node, null, '2');
      expect(effectTemplateBranchTips([root, old, isolated], 'copy').get('a')?.workflowRunId).toBe(
        'copy',
      );
    },
  );
  it('returns no scope for an unknown run', () => {
    expect(effectTemplateBranchTips([branch('root', null, null, null)], 'other').size).toBe(0);
  });
});
