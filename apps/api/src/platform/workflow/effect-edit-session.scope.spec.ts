import { describe, expect, it, vi } from 'vitest';
import { beginEffectEditInTransaction } from './effect-edit-session';

describe('output template scoped branch guard', () => {
  it.each([true, false])('allows nested manual Prompt edits only for the frozen render protocol (%s)', async (frozen) => {
    const parent = { id: 'render-draft', parentWorkflowRunId: 'published', branchPublishedAt: null,
      editSessionNodeId: 'SEGMENT_RENDER', editSessionPurpose: 'MANUAL', editIdMap: { frozenPromptRefresh: frozen } };
    const tx = { $queryRaw: vi.fn(), workflowRun: { findFirst: vi.fn().mockResolvedValue(parent) },
      workingArtifact: { count: vi.fn().mockRejectedValue(new Error('NESTED_EDIT_ALLOWED')) } };
    const promise = beginEffectEditInTransaction(tx as never, 'p', parent.id, 'PROMPT_GENERATION', 'MANUAL');
    if (frozen) await expect(promise).rejects.toThrow('NESTED_EDIT_ALLOWED');
    else await expect(promise).resolves.toBeNull();
  });
  const setup = () => {
    const active = { id: 'global' };
    const parent = { id: 'template', parentWorkflowRunId: 'root', branchPublishedAt: new Date() };
    return {
      $queryRaw: vi.fn(),
      workflowRun: {
        findFirst: vi.fn().mockResolvedValueOnce(parent).mockResolvedValueOnce(active),
      },
      workingArtifact: { count: vi.fn().mockRejectedValue(new Error('PASSED_SCOPE_GUARD')) },
    };
  };
  it('permits only the internally resolved output template scope', async () => {
    await expect(
      beginEffectEditInTransaction(setup() as never, 'p', 'template', 'FINAL_OUTPUT', 'BATCH', {
        always: true,
        templateId: 't',
        templateScopeActiveRunId: 'global',
      }),
    ).rejects.toThrow('PASSED_SCOPE_GUARD');
  });
  it('reuses only an unfinished background export under the project lock', async () => {
    const tx = setup();
    tx.workflowRun.findFirst.mockResolvedValueOnce({ id: 'pending-child' });
    const result = await beginEffectEditInTransaction(tx as never, 'p', 'template', 'FINAL_OUTPUT', 'BATCH', {
      always: true, keepParentActive: true, templateId: 't', templateScopeActiveRunId: 'global',
    });
    expect(result).toMatchObject({ runId: 'pending-child', created: false });
    expect(tx.workflowRun.findFirst).toHaveBeenLastCalledWith(expect.objectContaining({ where: {
      projectId: 'p', workflow: 'EFFECT', workflowSpace: 'EFFECT', parentWorkflowRunId: 'template',
      forkNodeId: 'FINAL_OUTPUT', forkTemplateId: 't', branchPublishedAt: null, editSessionNodeId: null,
      effectFinalOutputRuns: { some: { projectId: 'p', templateId: 't',
        status: { in: ['PENDING_RENDER', 'QUEUED', 'RUNNING'] } } },
    } }));
    expect(tx.workingArtifact.count).not.toHaveBeenCalled();
  });
  it('never treats two missing active IDs as template-scope authorization', async () => {
    const tx = setup();
    tx.workflowRun.findFirst
      .mockReset()
      .mockResolvedValueOnce({
        id: 'template',
        parentWorkflowRunId: 'root',
        branchPublishedAt: new Date(),
      })
      .mockResolvedValueOnce(null);
    expect(
      await beginEffectEditInTransaction(tx as never, 'p', 'template', 'FINAL_OUTPUT', 'BATCH', {
        always: true,
        templateId: 't',
      }),
    ).toBeNull();
    expect(tx.workingArtifact.count).not.toHaveBeenCalled();
  });
  it.each([
    ['FINAL_OUTPUT', { always: true, templateId: 't', templateScopeActiveRunId: 'changed' }],
    ['FINAL_OUTPUT', { always: true, templateScopeActiveRunId: 'global' }],
    ['FINAL_OUTPUT', { templateId: 't', templateScopeActiveRunId: 'global' }],
    ['TEMPLATE_MIX', { always: true, templateId: 't', templateScopeActiveRunId: 'global' }],
  ] as const)(
    'does not broaden non-output or unfrozen branch creation: %s',
    async (node, options) => {
      const tx = setup();
      expect(
        await beginEffectEditInTransaction(tx as never, 'p', 'template', node, 'BATCH', options),
      ).toBeNull();
      expect(tx.workingArtifact.count).not.toHaveBeenCalled();
    },
  );
});
