import { describe, expect, it, vi } from 'vitest';
import { CUSTOMIZED_WORKFLOW_NODES } from '@ai-marketing/contracts';
import { WorkflowWorkingService } from './workflow-working.service';

describe('customized five-stage navigation compatibility', () => {
  it('projects old asset navigation and output into rendering without changing stored data', async () => {
    const date = new Date('2026-10-08T00:00:00Z');
    const rows = [
      {
        id: 'run',
        activeKey: 'ACTIVE',
        parentWorkflowRunId: null,
        forkNodeId: 'VISUAL_ASSETS',
        currentNodeId: 'VISUAL_ASSETS',
        editSessionNodeId: null,
        branchLabel: null,
        branchPublishedAt: date,
        createdAt: date,
        workingArtifacts: [
          { nodeId: 'VISUAL_ASSETS', revision: 3, freshness: 'CURRENT', createdAt: date },
        ],
      },
    ];
    const before = JSON.stringify(rows);
    const service = new WorkflowWorkingService(
      { listCustomizedRunBranches: vi.fn().mockResolvedValue(rows) } as never,
      { get: vi.fn().mockResolvedValue({ id: 'p' }) } as never,
      {} as never,
    );
    const tree = await service.getCustomizedBranchTree('p');
    expect(tree.branches[0]?.nodes.map((node) => node.nodeId)).toEqual(CUSTOMIZED_WORKFLOW_NODES);
    expect(tree.branches[0]).toMatchObject({
      forkNodeId: 'SHOT_RENDER',
      currentNodeId: 'SHOT_RENDER',
    });
    expect(tree.branches[0]?.nodes[4]).toMatchObject({
      artifactCount: 1,
      revision: 3,
      status: 'CONFIRMED',
    });
    expect(JSON.stringify(rows)).toBe(before);
  });

  it('activates legacy rendering destinations and rejects unknown nodes before repository writes', async () => {
    const activateCustomizedRunBranch = vi.fn().mockResolvedValue({
      id: 'run',
      projectId: 'p',
      workflow: 'CUSTOMIZED',
      workflowSpace: 'CUSTOMIZED_PROJECT',
      status: 'ACTIVE',
      currentNodeId: 'SHOT_RENDER',
      lastActiveAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const service = new WorkflowWorkingService(
      { activateCustomizedRunBranch } as never,
      { get: vi.fn().mockResolvedValue({ id: 'p' }) } as never,
      {} as never,
    );
    await service.activateCustomizedBranch('p', 'run', 'VISUAL_ASSETS');
    await service.activateCustomizedBranch('p', 'run', 'DELIVERY');
    expect(activateCustomizedRunBranch).toHaveBeenCalledWith('p', 'run', 'SHOT_RENDER');
    await expect(service.activateCustomizedBranch('p', 'run', 'UNKNOWN')).rejects.toThrow(
      '节点标识无效',
    );
    expect(activateCustomizedRunBranch).toHaveBeenCalledTimes(2);
  });

  it('restores historical delivery navigation without counting delivery artifacts as video output', async () => {
    const date = new Date('2026-10-19T00:00:00Z');
    const rows = [
      {
        id: 'run',
        activeKey: 'ACTIVE',
        parentWorkflowRunId: null,
        forkNodeId: 'DELIVERY',
        currentNodeId: 'DELIVERY',
        editSessionNodeId: null,
        branchLabel: null,
        branchPublishedAt: date,
        createdAt: date,
        workingArtifacts: [
          { nodeId: 'DELIVERY', revision: 9, freshness: 'CURRENT', createdAt: date },
        ],
      },
    ];
    const before = JSON.stringify(rows);
    const service = new WorkflowWorkingService(
      { listCustomizedRunBranches: vi.fn().mockResolvedValue(rows) } as never,
      { get: vi.fn().mockResolvedValue({ id: 'p' }) } as never,
      {} as never,
    );
    const result = await service.getCustomizedBranchTree('p');
    expect(result.branches[0]).toMatchObject({
      currentNodeId: 'SHOT_RENDER',
      forkNodeId: 'SHOT_RENDER',
    });
    expect(result.branches[0]!.nodes).toHaveLength(5);
    expect(result.branches[0]!.nodes[4]).toMatchObject({
      artifactCount: 0,
      revision: null,
      status: 'PENDING',
    });
    expect(JSON.stringify(rows)).toBe(before);
  });
});
