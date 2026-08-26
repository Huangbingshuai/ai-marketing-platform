import { describe, expect, it, vi } from 'vitest';
import { WorkflowWorkingService, workflowStateHash } from './workflow-working.service';

describe('workflowStateHash', () => {
  it('normalizes object key order while preserving array order', () => {
    expect(workflowStateHash({ b: 2, a: { y: 2, x: 1 } })).toBe(
      workflowStateHash({ a: { x: 1, y: 2 }, b: 2 }),
    );
    expect(workflowStateHash({ values: [1, 2] })).not.toBe(workflowStateHash({ values: [2, 1] }));
  });
});

describe('WorkflowWorkingService node activation', () => {
  it('returns the activated run without writing node state', async () => {
    const timestamp = new Date('2026-08-26T03:00:00.000Z');
    const repository = {
      activateNode: vi.fn().mockResolvedValue({
        id: 'run-a',
        projectId: 'project-a',
        workflow: 'EFFECT',
        workflowSpace: 'EFFECT',
        status: 'ACTIVE',
        currentNodeId: 'INFORMATION_EXTRACTION',
        lastActiveAt: timestamp,
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
    };
    const projects = { get: vi.fn().mockResolvedValue({ id: 'project-a' }) };
    const service = new WorkflowWorkingService(repository as never, projects as never, {} as never);

    await expect(
      service.activateNode('project-a', 'run-a', 'INFORMATION_EXTRACTION'),
    ).resolves.toEqual({
      run: expect.objectContaining({
        id: 'run-a',
        currentNodeId: 'INFORMATION_EXTRACTION',
        lastActiveAt: timestamp.toISOString(),
      }),
    });
    expect(repository.activateNode).toHaveBeenCalledWith(
      'project-a',
      'run-a',
      'INFORMATION_EXTRACTION',
    );
  });
});
