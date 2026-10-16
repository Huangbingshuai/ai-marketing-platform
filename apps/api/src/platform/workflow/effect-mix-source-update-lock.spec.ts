import type { EffectTemplateMixDraft, FinalOutputSnapshot } from '@ai-marketing/contracts';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../database/prisma.service';
import type { Prisma } from '../../generated/prisma/client';
import {
  activeMixSourceUpdates,
  assertMixSourceUpdateDraftEditable,
} from './effect-mix-source-update-lock';
import { WorkflowWorkingRepository } from './workflow-working.repository';
import { workflowStateHash } from './workflow-state-hash';

const before = {
  templates: [
    {
      id: 't',
      workspace: {
        template: { name: '模板', editVersion: 1, slots: [] },
        editVersion: 1,
        variants: [
          { id: 'v', name: '成片1', bindings: {} },
          { id: 'sibling', name: '成片2', bindings: {} },
        ],
      },
    },
  ],
} as unknown as EffectTemplateMixDraft;
const update = {
  workflowRunId: 'w',
  templateId: 't',
  baselineVariant: before.templates[0]!.workspace.variants[0]!,
} as NonNullable<FinalOutputSnapshot['sourceRefresh']>;
const copy = () => structuredClone(before);

describe('local source-update edit locks', () => {
  it.each(['edit', 'delete-variant', 'delete-template', 'template'])(
    'rejects participating project %s',
    (operation) => {
      const next = copy(),
        entry = next.templates[0]!;
      if (operation === 'edit') entry.workspace.variants[0]!.name = '修改';
      if (operation === 'delete-variant') entry.workspace.variants.shift();
      if (operation === 'delete-template') next.templates = [];
      if (operation === 'template') entry.workspace.template.name = '修改';
      expect(() => assertMixSourceUpdateDraftEditable(before, next, [update])).toThrow(
        '局部更新正在进行',
      );
    },
  );
  it('allows unrelated film edits, UI choices and role assignments without changing frozen projects', () => {
    const next = copy(),
      entry = next.templates[0]!;
    entry.workspace.variants[1]!.name = '修改其他成片';
    entry.workspace.editVersion++;
    entry.materialRoleOverrides = { material: 'HOOK' };
    expect(() => assertMixSourceUpdateDraftEditable(before, next, [update])).not.toThrow();
    expect(() => assertMixSourceUpdateDraftEditable(before, { templates: [] }, [])).not.toThrow();
  });
  it('reads only active tasks in the exact project and workflow, ignoring full exports and other branches', async () => {
    const findMany = vi
      .fn()
      .mockResolvedValue([
        { snapshot: { sourceRefresh: update } },
        { snapshot: { sourceRefresh: { ...update, workflowRunId: 'other' } } },
        { snapshot: {} },
      ]);
    const tx = { effectFinalOutputItem: { findMany } } as unknown as Prisma.TransactionClient;
    expect(await activeMixSourceUpdates(tx, 'p', 'w')).toEqual([update]);
    expect(findMany).toHaveBeenCalledWith({
      where: {
        projectId: 'p',
        status: { in: ['QUEUED', 'RUNNING'] },
        run: { workflowRunId: 'w', status: { in: ['QUEUED', 'RUNNING'] } },
      },
      select: { snapshot: true },
    });
  });
  it('enforces the guard within the existing node-save transaction and allows sibling saves', async () => {
    const tx = {
      $queryRaw: vi.fn(),
      workflowRun: { findFirst: vi.fn().mockResolvedValue({ id: 'w' }), update: vi.fn() },
      workflowNodeState: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'node',
          revision: 1,
          contentHash: workflowStateHash(before),
          state: before,
          executionInputHash: 'same',
        }),
        update: vi.fn().mockResolvedValue({ id: 'node', revision: 2 }),
      },
      effectPackagingItem: { findMany: vi.fn().mockResolvedValue([]) },
      effectFinalOutputItem: {
        findMany: vi.fn().mockResolvedValue([{ snapshot: { sourceRefresh: update } }]),
      },
    };
    const repository = new WorkflowWorkingRepository({
      $transaction: (fn: (client: typeof tx) => unknown) => fn(tx),
    } as unknown as PrismaService);
    const next = copy();
    next.templates[0]!.workspace.variants[0]!.name = '修改';
    await expect(
      repository.saveNodeState(
        'p',
        'w',
        'TEMPLATE_MIX',
        workflowStateHash(next),
        next,
        1,
        1,
        'same',
      ),
    ).rejects.toThrow('局部更新正在进行');
    expect(tx.workflowNodeState.update).not.toHaveBeenCalled();
    const sibling = copy();
    sibling.templates[0]!.workspace.variants[1]!.name = '其他';
    await repository.saveNodeState(
      'p',
      'w',
      'TEMPLATE_MIX',
      workflowStateHash(sibling),
      sibling,
      1,
      1,
      'same',
    );
    expect(tx.workflowNodeState.update).toHaveBeenCalledOnce();
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
  });
});
