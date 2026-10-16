import { describe, expect, it, vi } from 'vitest';
import {
  beginEffectEditInTransaction,
  effectEditStageCopyPolicy,
  effectEditNodeStateWhere,
  effectEditArtifactStages,
} from './effect-edit-session';

describe('effect edit stage copy policy', () => {
  it('carries confirmed mix artifacts only for packaging rollback, not a new fill or export', () => {
    expect(effectEditArtifactStages('TEMPLATE_MIX', 'BATCH', true)).toEqual([
      'SOURCE_IMPORT',
      'INFORMATION_EXTRACTION',
      'PROMPT_GENERATION',
      'SEGMENT_RENDER',
      'TEMPLATE_MIX',
    ]);
    expect(effectEditArtifactStages('TEMPLATE_MIX', 'BATCH')).not.toContain('TEMPLATE_MIX');
    expect(effectEditArtifactStages('FINAL_OUTPUT', 'BATCH', true)).toContain('TEMPLATE_MIX');
    expect(effectEditArtifactStages('FINAL_OUTPUT', 'BATCH', true)).not.toContain('FINAL_OUTPUT');
    expect(effectEditArtifactStages('SEGMENT_RENDER', 'BATCH', true)).not.toContain(
      'SEGMENT_RENDER',
    );
  });
  it('copies render defaults from the current parent, not an adopted ancestor render source', () => {
    expect(effectEditNodeStateWhere('project', 'current', 'SEGMENT_RENDER', 'ancestor')).toEqual({
      projectId: 'project',
      OR: [
        {
          workflowRunId: 'ancestor',
          OR: [{ nodeId: 'SEGMENT_RENDER' }, { nodeId: { startsWith: 'SEGMENT_RENDER:' } }],
        },
        { workflowRunId: 'current', nodeId: { startsWith: 'SEGMENT_RENDER_SETTINGS:' } },
      ],
    });
    expect(
      effectEditNodeStateWhere('project', 'current', 'PROMPT_GENERATION', 'ancestor').OR,
    ).toHaveLength(1);
  });
  it('starts a full segment rerender from the current Prompt without inherited render materials', () => {
    expect(effectEditStageCopyPolicy('SEGMENT_RENDER', 'BATCH')).toEqual({
      adoptConfirmedRenderSource: false,
      copyRenderBatches: false,
      copyCurrentStageArtifacts: false,
    });
  });

  it('keeps the existing render pool for isolated manual edits', () => {
    expect(effectEditStageCopyPolicy('SEGMENT_RENDER', 'MANUAL')).toEqual({
      adoptConfirmedRenderSource: true,
      copyRenderBatches: true,
      copyCurrentStageArtifacts: true,
    });
  });
});

describe('output template scoped branch guard', () => {
  it.each([33, 34])(
    'checks the source node under its lock before reusing a packaging child (%s)',
    async (revision) => {
      const parent = { id: 'parent' };
      const tx = {
        $queryRaw: vi.fn(),
        workflowNodeState: { findUnique: vi.fn().mockResolvedValue({ revision }) },
        workflowRun: {
          findFirst: vi
            .fn()
            .mockResolvedValueOnce(parent)
            .mockResolvedValueOnce(parent)
            .mockResolvedValueOnce({
              id: 'child',
              parentWorkflowRunId: 'parent',
              forkNodeId: 'TEMPLATE_MIX',
            }),
        },
      };
      const action = beginEffectEditInTransaction(
        tx as never,
        'p',
        'parent',
        'TEMPLATE_MIX',
        'BATCH',
        {
          always: true,
          creationKey: 'same-request',
          expectedNodeStateRevision: 33,
        },
      );
      if (revision === 33)
        await expect(action).resolves.toMatchObject({ runId: 'child', created: false });
      else await expect(action).rejects.toThrow('原工程已改变');
      expect(tx.workflowNodeState.findUnique).toHaveBeenCalledWith({
        where: {
          projectId_workflowRunId_nodeId: {
            projectId: 'p',
            workflowRunId: 'parent',
            nodeId: 'TEMPLATE_MIX',
          },
        },
      });
    },
  );
  it.each([true, false])(
    'allows nested manual Prompt edits only for the frozen render protocol (%s)',
    async (frozen) => {
      const parent = {
        id: 'render-draft',
        parentWorkflowRunId: 'published',
        branchPublishedAt: null,
        editSessionNodeId: 'SEGMENT_RENDER',
        editSessionPurpose: 'MANUAL',
        editIdMap: { frozenPromptRefresh: frozen },
      };
      const tx = {
        $queryRaw: vi.fn(),
        workflowRun: { findFirst: vi.fn().mockResolvedValue(parent) },
        workingArtifact: { count: vi.fn().mockRejectedValue(new Error('NESTED_EDIT_ALLOWED')) },
      };
      const promise = beginEffectEditInTransaction(
        tx as never,
        'p',
        parent.id,
        'PROMPT_GENERATION',
        'MANUAL',
      );
      if (frozen) await expect(promise).rejects.toThrow('NESTED_EDIT_ALLOWED');
      else await expect(promise).resolves.toBeNull();
    },
  );
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
  it.each([true, false])(
    'permits a resolved packaging template scope only while its global pointer is unchanged (%s)',
    async (unchanged) => {
      const action = beginEffectEditInTransaction(
        setup() as never,
        'p',
        'template',
        'TEMPLATE_MIX',
        'BATCH',
        {
          always: true,
          keepParentActive: true,
          preservePackagingBaseline: true,
          templateId: 't',
          templateScopeActiveRunId: unchanged ? 'global' : 'changed',
        },
      );
      if (unchanged) await expect(action).rejects.toThrow('PASSED_SCOPE_GUARD');
      else await expect(action).resolves.toBeNull();
    },
  );
  it('does not reuse a packaging child after the frozen global pointer changes', async () => {
    const tx = setup();
    tx.workflowRun.findFirst.mockResolvedValueOnce({
      id: 'existing',
      parentWorkflowRunId: 'template',
      forkNodeId: 'TEMPLATE_MIX',
    });
    await expect(
      beginEffectEditInTransaction(tx as never, 'p', 'template', 'TEMPLATE_MIX', 'BATCH', {
        always: true,
        keepParentActive: true,
        preservePackagingBaseline: true,
        templateId: 't',
        templateScopeActiveRunId: 'old-global',
        creationKey: 'replay',
      }),
    ).resolves.toBeNull();
    expect(tx.workflowRun.findFirst).toHaveBeenCalledTimes(2);
  });
  it('reuses only an unfinished background export under the project lock', async () => {
    const tx = setup();
    tx.workflowRun.findFirst.mockResolvedValueOnce({ id: 'pending-child' });
    const result = await beginEffectEditInTransaction(
      tx as never,
      'p',
      'template',
      'FINAL_OUTPUT',
      'BATCH',
      {
        always: true,
        keepParentActive: true,
        templateId: 't',
        templateScopeActiveRunId: 'global',
      },
    );
    expect(result).toMatchObject({ runId: 'pending-child', created: false });
    expect(tx.workflowRun.findFirst).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: {
          projectId: 'p',
          workflow: 'EFFECT',
          workflowSpace: 'EFFECT',
          parentWorkflowRunId: 'template',
          forkNodeId: 'FINAL_OUTPUT',
          forkTemplateId: 't',
          branchPublishedAt: null,
          editSessionNodeId: null,
          effectFinalOutputRuns: {
            some: {
              projectId: 'p',
              templateId: 't',
              status: { in: ['PENDING_RENDER', 'QUEUED', 'RUNNING'] },
            },
          },
        },
      }),
    );
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
