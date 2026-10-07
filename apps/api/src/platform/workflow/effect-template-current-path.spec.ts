import { EFFECT_TEMPLATE_CURRENT_PATH_NODE_ID } from '@ai-marketing/contracts';
import { describe, expect, it, vi } from 'vitest';
import { selectedEffectTemplatePaths } from './effect-template-current-path';
import { WorkflowWorkingRepository } from './workflow-working.repository';

describe('per-template user workflow selection', () => {
  const state = { schemaVersion: 1, workflowRunId: 'target', selectedTemplates: { a: '2026-10-07T01:00:00.000Z' } };
  it('does not inherit copied selection state or malformed dates', () => {
    expect(selectedEffectTemplatePaths('copy', [{ nodeId: EFFECT_TEMPLATE_CURRENT_PATH_NODE_ID, state }])).toEqual({});
    expect(selectedEffectTemplatePaths('target', [{ nodeId: 'TEMPLATE_MIX', state }])).toEqual({});
    expect(selectedEffectTemplatePaths('target', [{ nodeId: EFFECT_TEMPLATE_CURRENT_PATH_NODE_ID,
      state: { ...state, selectedTemplates: { a: state.selectedTemplates.a, bad: 'invalid' } } }])).toEqual(state.selectedTemplates);
  });
  function fixture(activeId = 'root', exists = true) {
    const rows = [{ id: 'root', parentWorkflowRunId: null, activeKey: activeId === 'root' ? 'ACTIVE' : null },
      { id: 'target', parentWorkflowRunId: 'root', activeKey: activeId === 'target' ? 'ACTIVE' : null,
        forkTemplateId: 'a', branchPublishedAt: new Date() }];
    const tx = { $queryRaw: vi.fn(), workflowRun: {
      findMany: vi.fn().mockResolvedValue(rows), update: vi.fn().mockImplementation(async ({ where }) => rows.find(r => r.id === where.id)),
    }, effectImportWorkspace: { findFirst: vi.fn().mockResolvedValue({ id: 'workspace' }) },
      workingArtifact: { findFirst: vi.fn().mockResolvedValue(null) },
      workflowNodeState: {
        findUnique: vi.fn().mockImplementation(async ({ where }) => where.projectId_workflowRunId_nodeId.nodeId === 'TEMPLATE_MIX'
          ? { state: { templates: exists ? [{ id: 'a' }] : [] } } : { nodeId: EFFECT_TEMPLATE_CURRENT_PATH_NODE_ID, state }),
        upsert: vi.fn().mockResolvedValue({}),
      } };
    const repository = new WorkflowWorkingRepository({ $transaction: async (fn: (db: typeof tx) => unknown) => fn(tx) } as never);
    return { repository, tx };
  }
  it.each(['root', 'target'])('records selection even if global active Run is %s', async (activeId) => {
    const { repository, tx } = fixture(activeId);
    expect(await repository.activateEffectRunBranch('p', 'target', 'a')).not.toBeNull();
    expect(tx.workflowNodeState.upsert).toHaveBeenCalledOnce();
    expect(tx.workflowNodeState.upsert.mock.calls[0]![0]).toMatchObject({ create: {
      projectId: 'p', workflowRunId: 'target', nodeId: EFFECT_TEMPLATE_CURRENT_PATH_NODE_ID,
      state: { workflowRunId: 'target', selectedTemplates: { a: expect.any(String) } },
    } });
    if (activeId === 'target') expect(tx.workflowRun.update).not.toHaveBeenCalled();
  });
  it('configuration-only navigation does not change template choices', async () => {
    const { repository, tx } = fixture();
    await repository.activateEffectRunBranch('p', 'target', null);
    expect(tx.workflowNodeState.upsert).not.toHaveBeenCalled();
  });
  it('rejects a nonexistent template before changing the global Run or saving selection', async () => {
    const { repository, tx } = fixture('root', false);
    expect(await repository.activateEffectRunBranch('p', 'target', 'foreign-template')).toBeNull();
    expect(tx.workflowNodeState.upsert).not.toHaveBeenCalled();
    expect(tx.workflowRun.update).not.toHaveBeenCalled();
  });
});
