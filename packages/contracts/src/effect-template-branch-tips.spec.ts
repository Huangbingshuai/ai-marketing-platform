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
