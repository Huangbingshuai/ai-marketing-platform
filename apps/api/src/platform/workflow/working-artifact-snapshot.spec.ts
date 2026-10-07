import { validate } from 'class-validator';
import { describe, expect, it, vi } from 'vitest';
import { ListWorkingArtifactsQueryDto } from './dto/list-working-artifacts-query.dto';
import { WorkflowWorkingRepository } from './workflow-working.repository';
import { WorkflowWorkingService } from './workflow-working.service';

describe('read-only asset version snapshots', () => {
  it('reads only exact project/Run/workflow/space records including completed history without source rebasing', async () => {
    const rows = [{ id: 'saved', workflowRunId: 'history' }];
    const findMany = vi.fn().mockResolvedValue(rows);
    const branches = vi.fn();
    const repository = new WorkflowWorkingRepository({
      workingArtifact: { findMany },
      workflowRun: { findMany: branches },
    } as never);
    expect(
      await repository.listArtifacts('project', {
        workflowRunId: 'history',
        nodeId: 'FINAL_OUTPUT',
        workflow: 'EFFECT',
        space: 'EFFECT',
        view: 'SNAPSHOT',
      }),
    ).toEqual(rows);
    expect(findMany.mock.calls[0]?.[0].where).toEqual({
      projectId: 'project',
      workflowRunId: 'history',
      nodeId: 'FINAL_OUTPUT',
      workflowRun: { workflow: 'EFFECT', workflowSpace: 'EFFECT' },
    });
    expect(branches).not.toHaveBeenCalled();
    await repository.listArtifacts('project', {});
    expect(findMany.mock.calls[1]?.[0].where.workflowRun.status.in).toEqual(['ACTIVE', 'PAUSED']);
  });
  it('requires an exact Run and checks project access before reading', async () => {
    const listArtifacts = vi.fn().mockResolvedValue([]);
    const get = vi.fn().mockResolvedValue({ id: 'p' });
    const service = new WorkflowWorkingService(
      { listArtifacts } as never,
      { get } as never,
      {} as never,
    );
    await expect(service.listArtifacts('p', { view: 'SNAPSHOT' })).rejects.toThrow('必须指定');
    expect(listArtifacts).not.toHaveBeenCalled();
    await service.listArtifacts('p', { view: 'SNAPSHOT', workflowRunId: 'r' });
    expect(listArtifacts).toHaveBeenCalledWith('p', { view: 'SNAPSHOT', workflowRunId: 'r' });
    get.mockRejectedValue(new Error('forbidden'));
    listArtifacts.mockClear();
    await expect(
      service.listArtifacts('foreign', { view: 'SNAPSHOT', workflowRunId: 'r' }),
    ).rejects.toThrow('forbidden');
    expect(listArtifacts).not.toHaveBeenCalled();
  });
  it('accepts the optional shared view enum and rejects unknown values and invalid Run IDs', async () => {
    for (const value of [
      {},
      { view: 'SNAPSHOT', workflowRunId: '08ae1473-d426-4351-ad2e-db5ea3e9b86e' },
    ])
      expect(await validate(Object.assign(new ListWorkingArtifactsQueryDto(), value))).toEqual([]);
    for (const value of [{ view: 'LATEST' }, { view: 'SNAPSHOT', workflowRunId: 'wrong' }])
      expect(
        (await validate(Object.assign(new ListWorkingArtifactsQueryDto(), value))).length,
      ).toBeGreaterThan(0);
  });
});
