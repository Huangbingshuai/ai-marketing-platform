import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../database/prisma.service';
import { WorkflowWorkingRepository } from './workflow-working.repository';
import { WorkflowWorkingService } from './workflow-working.service';

describe('customized draft initialization', () => {
  it('uses the database unique project/workflow/space/active key without changing existing state', async () => {
    const upsert = vi.fn().mockResolvedValue({ id: 'same-run' });
    const repository = new WorkflowWorkingRepository({
      workflowRun: { upsert },
    } as unknown as PrismaService);
    expect(await repository.initializeCustomizedRun('p')).toEqual({ id: 'same-run' });
    expect(await repository.initializeCustomizedRun('p')).toEqual({ id: 'same-run' });
    expect(upsert).toHaveBeenCalledWith({
      where: {
        projectId_workflow_workflowSpace_activeKey: {
          projectId: 'p',
          workflow: 'CUSTOMIZED',
          workflowSpace: 'CUSTOMIZED_PROJECT',
          activeKey: 'ACTIVE',
        },
      },
      create: {
        projectId: 'p',
        workflow: 'CUSTOMIZED',
        workflowSpace: 'CUSTOMIZED_PROJECT',
        activeKey: 'ACTIVE',
        currentNodeId: 'SOURCE_IMPORT',
      },
      update: {},
    });
  });
  it('recovers a concurrent unique-key collision by reading the same project and space', async () => {
    const findFirst = vi.fn().mockResolvedValue({ id: 'winner' });
    const repository = new WorkflowWorkingRepository({
      workflowRun: {
        upsert: vi.fn().mockRejectedValue({ code: 'P2002' }),
        findFirst,
      },
    } as unknown as PrismaService);
    expect(await repository.initializeCustomizedRun('p')).toEqual({ id: 'winner' });
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          projectId: 'p',
          workflow: 'CUSTOMIZED',
          workflowSpace: 'CUSTOMIZED_PROJECT',
          activeKey: 'ACTIVE',
        }),
      }),
    );
  });
  it('verifies the project before creating any run', async () => {
    const initializeCustomizedRun = vi.fn();
    const get = vi.fn().mockRejectedValue(new Error('PROJECT_NOT_FOUND'));
    const service = new WorkflowWorkingService(
      { initializeCustomizedRun } as never,
      { get } as never,
      {} as never,
    );
    await expect(service.initializeCustomizedRun('missing')).rejects.toThrow('PROJECT_NOT_FOUND');
    expect(initializeCustomizedRun).not.toHaveBeenCalled();
  });
});
